import { eq } from 'drizzle-orm';
import {
  TmdbClient,
  createLogger,
  selectNewSeason,
  selectRewatch,
  type Candidate,
  type SeasonInfo,
  type WatchedItem,
} from '@watchmuse/core';
import type { Db } from '../db/client.js';
import { historyRows } from '../db/schema.js';

const log = createLogger('history-rows');

/** Matches the candidate pool, so both go stale together. */
const TTL_MS = 12 * 60 * 60 * 1000;

/**
 * How many titles each row keeps. Only the first handful are ever seen on the
 * Stremio board, and every entry beyond this costs a TMDB read to dress up.
 */
const ROW_LIMIT = 60;

/** How many watched series to ask TMDB about when looking for a new season. */
const SEASON_LOOKUP_LIMIT = 80;

export interface HistoryRowPayload {
  rewatch: Candidate[];
  newSeason: Candidate[];
}

const EMPTY: HistoryRowPayload = { rewatch: [], newSeason: [] };

/**
 * Turn a watched item into a catalog entry.
 *
 * Watch history carries a title and a year but no poster or genres, so those
 * come from TMDB. A lookup that fails still yields an entry: a row item with no
 * poster is worse than one with, but far better than a title silently missing.
 */
async function dress(
  tmdb: TmdbClient | null,
  item: WatchedItem,
  reason: string | undefined,
): Promise<Candidate> {
  const base: Candidate = {
    tmdbId: item.tmdbId,
    type: item.type,
    title: item.title,
    year: item.year,
    score: item.rating ?? 0,
    fromSeeds: [],
    sources: [],
    ...(reason ? { seedTitles: [reason] } : {}),
  };
  if (!tmdb) return base;
  try {
    const meta = await tmdb.details(item.type, item.tmdbId);
    return {
      ...base,
      title: base.title ?? meta.title,
      year: base.year ?? meta.year,
      overview: meta.overview,
      posterPath: meta.posterPath,
      genreIds: meta.genreIds,
      voteAverage: meta.voteAverage,
      voteCount: meta.voteCount,
    };
  } catch (err) {
    log.warn({ tmdbId: item.tmdbId, err }, 'Could not read metadata for a history row item');
    return base;
  }
}

/**
 * Build both history-backed rows for one user.
 *
 * Only what is asked for is built: each row costs a TMDB read per title, and a
 * user with neither catalog should pay nothing. `wanted` says which are in use.
 */
export async function buildHistoryRows(
  watched: readonly WatchedItem[],
  tmdb: TmdbClient | null,
  wanted: { rewatch: boolean; newSeason: boolean },
): Promise<HistoryRowPayload> {
  const out: HistoryRowPayload = { rewatch: [], newSeason: [] };

  if (wanted.rewatch) {
    const picks = selectRewatch(watched).slice(0, ROW_LIMIT);
    out.rewatch = await Promise.all(picks.map((w) => dress(tmdb, w, undefined)));
  }

  if (wanted.newSeason && tmdb) {
    const series = watched.filter((w) => w.type === 'series').slice(0, SEASON_LOOKUP_LIMIT);
    const info = new Map<number, SeasonInfo>();
    await Promise.all(
      series.map(async (s) => {
        try {
          info.set(s.tmdbId, await tmdb.seasonInfo(s.tmdbId));
        } catch (err) {
          // A show TMDB will not answer for is simply not considered.
          log.warn({ tmdbId: s.tmdbId, err }, 'Could not read seasons for a watched series');
        }
      }),
    );
    const hits = selectNewSeason(watched, info).slice(0, ROW_LIMIT);
    out.newSeason = await Promise.all(
      hits.map((h) =>
        dress(tmdb, h.item, h.seasonNumber ? `Season ${h.seasonNumber} is out` : undefined),
      ),
    );
  }

  return out;
}

export class HistoryRowStore {
  constructor(private readonly db: Db) {}

  async get(userId: string): Promise<HistoryRowPayload> {
    const [row] = await this.db.orm
      .select()
      .from(historyRows)
      .where(eq(historyRows.userId, userId))
      .limit(1);
    if (!row) return EMPTY;
    try {
      return JSON.parse(row.payload) as HistoryRowPayload;
    } catch {
      return EMPTY;
    }
  }

  async set(userId: string, payload: HistoryRowPayload): Promise<void> {
    const now = new Date();
    const values = {
      userId,
      payload: JSON.stringify(payload),
      builtAt: now,
      expiresAt: new Date(now.getTime() + TTL_MS),
    };
    await this.db.orm
      .insert(historyRows)
      .values(values)
      .onConflictDoUpdate({ target: historyRows.userId, set: values });
  }
}
