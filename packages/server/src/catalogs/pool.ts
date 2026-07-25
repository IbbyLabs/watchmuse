import { createHash } from 'node:crypto';
import { poolRebuildDuration, poolRebuilds, poolSize } from '../metrics/registry.js';
import { eq } from 'drizzle-orm';
import {
  LlmClient,
  TmdbClient,
  createLogger,
  rerank,
  type AppConfig,
  type Candidate,
  type WatchedItem,
} from '@watchmuse/core';
import type { Db } from '../db/client.js';
import { candidatePools, catalogs } from '../db/schema.js';
import { buildHistoryRows, type HistoryRowStore } from './historyRows.js';
import type { RecommendationService } from '../reco/service.js';
import type { LlmConfigStore } from '../ai/store.js';
import type { WatchRegionStore } from '../watch/regionStore.js';

const log = createLogger('pool');

const POOL_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const IMDB_RESOLVE_TOP = 150; // resolve IMDB ids for the slice actually served
const PROVIDER_RESOLVE_TOP = 150; // streaming availability for that same slice

function hashCandidates(candidates: Candidate[]): string {
  const keys = candidates.map((c) => `${c.type}:${c.tmdbId}`).sort();
  return createHash('sha1').update(keys.join(',')).digest('hex').slice(0, 16);
}

/**
 * Owns the per-user candidate pool: the expensive history-pull + candidate
 * generation, cached with a TTL. Serving reads are cache-only and never block —
 * a missing pool returns null (and kicks off a build), a stale pool is served
 * as-is while it refreshes in the background.
 */
export class PoolService {
  private readonly building = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly reco: RecommendationService,
    private readonly config: AppConfig,
    private readonly llm: LlmConfigStore,
    private readonly regions: WatchRegionStore,
    private readonly historyRows?: HistoryRowStore,
  ) {}

  /** Current pool hash for a user (used by NL caches to detect staleness). */
  async hashFor(userId: string): Promise<string | null> {
    const [row] = await this.db.orm
      .select({ historyHash: candidatePools.historyHash })
      .from(candidatePools)
      .where(eq(candidatePools.userId, userId))
      .limit(1);
    return row?.historyHash ?? null;
  }

  /** Whether the stored pool currently holds anything worth protecting. */
  private async hasStoredCandidates(userId: string): Promise<boolean> {
    const [row] = await this.db.orm
      .select({ payload: candidatePools.payload })
      .from(candidatePools)
      .where(eq(candidatePools.userId, userId))
      .limit(1);
    if (!row) return false;
    try {
      return (JSON.parse(row.payload) as Candidate[]).length > 0;
    } catch {
      return false; // unreadable is not worth keeping
    }
  }

  /** Cached pool for a user; null if none yet (a build is triggered). */
  async get(userId: string): Promise<Candidate[] | null> {
    const [row] = await this.db.orm
      .select()
      .from(candidatePools)
      .where(eq(candidatePools.userId, userId))
      .limit(1);

    if (!row) {
      void this.refresh(userId);
      return null;
    }
    if (row.expiresAt.getTime() < Date.now()) void this.refresh(userId);
    try {
      return JSON.parse(row.payload) as Candidate[];
    } catch {
      void this.refresh(userId);
      return null;
    }
  }

  /** Rebuild and persist a user's pool. Guarded so concurrent calls coalesce. */
  async refresh(userId: string): Promise<void> {
    if (this.building.has(userId)) return;
    this.building.add(userId);
    const stopTimer = poolRebuildDuration.startTimer();
    try {
      const built = await this.reco.buildFor(userId);
      let candidates = built.candidates;
      if (candidates.length === 0 && (await this.hasStoredCandidates(userId))) {
        // A provider that errors is skipped rather than failing the pull, so a
        // bad day upstream arrives here as an empty list. Writing it would swap
        // a working pool for one that serves nothing, and the TTL would hold
        // that for hours. Leave the stored pool alone: it stays expired, so the
        // next read tries again.
        log.error({ userId }, 'Rebuild produced no candidates; keeping the previous pool');
        poolRebuilds.inc({ outcome: 'kept_previous' });
        return;
      }
      candidates = await this.maybeRerank(userId, candidates);
      await this.resolveImdbIds(candidates.slice(0, IMDB_RESOLVE_TOP));
      await this.resolveAvailability(userId, candidates.slice(0, PROVIDER_RESOLVE_TOP));
      const now = new Date();
      const expiresAt = new Date(now.getTime() + POOL_TTL_MS);
      const values = {
        userId,
        payload: JSON.stringify(candidates),
        historyHash: hashCandidates(candidates),
        builtAt: now,
        expiresAt,
      };
      await this.db.orm
        .insert(candidatePools)
        .values(values)
        .onConflictDoUpdate({ target: candidatePools.userId, set: values });
      await this.rebuildHistoryRows(userId, built.watched);
      log.info({ userId, count: candidates.length }, 'Pool rebuilt');
      poolRebuilds.inc({ outcome: 'ok' });
      poolSize.observe(candidates.length);
    } catch (err) {
      log.error({ userId, err }, 'Pool rebuild failed');
      poolRebuilds.inc({ outcome: 'error' });
    } finally {
      stopTimer();
      this.building.delete(userId);
    }
  }

  /**
   * Rebuild the history-backed rows, but only the ones a catalog actually asks
   * for: each costs a TMDB read per title, and most users have neither.
   */
  private async rebuildHistoryRows(userId: string, watched: Candidate[] | never[] | readonly WatchedItem[]): Promise<void> {
    if (!this.historyRows) return;
    const types = await this.db.orm
      .select({ type: catalogs.type })
      .from(catalogs)
      .where(eq(catalogs.userId, userId));
    const wanted = {
      rewatch: types.some((t) => t.type === 'rewatch'),
      newSeason: types.some((t) => t.type === 'newseason'),
    };
    if (!wanted.rewatch && !wanted.newSeason) return;

    const key = this.config.TMDB_API_KEY;
    try {
      const rows = await buildHistoryRows(
        watched as readonly WatchedItem[],
        key ? TmdbClient.shared({ apiKey: key }) : null,
        wanted,
      );
      await this.historyRows.set(userId, rows);
      log.info(
        { userId, rewatch: rows.rewatch.length, newSeason: rows.newSeason.length },
        'History rows rebuilt',
      );
    } catch (err) {
      // These are extra rows, not the pool. Losing them must not fail a rebuild.
      log.warn({ userId, err }, 'Could not rebuild the history rows');
    }
  }

  /** Taste re-rank the pool when the user has an LLM configured (else unchanged). */
  private async maybeRerank(userId: string, candidates: Candidate[]): Promise<Candidate[]> {
    const cfg = await this.llm.get(userId);
    if (!cfg) return candidates;
    try {
      return await rerank(
        new LlmClient({ ...cfg, allowPrivateHost: this.config.AI_ALLOW_PRIVATE_BASE_URL }),
        candidates,
      );
    } catch (err) {
      log.warn({ userId, err }, 'Pool rerank failed; keeping algorithmic order');
      return candidates;
    }
  }

  /**
   * Streaming availability, but only when someone is going to read it: it costs
   * a TMDB call per title, and most catalogs never filter on it. Skipped
   * entirely when the user has no catalog using the filter, or when we do not
   * know which country to answer for.
   */
  private async resolveAvailability(userId: string, candidates: Candidate[]): Promise<void> {
    if (!this.config.TMDB_API_KEY || candidates.length === 0) return;
    const region = await this.regions.effective(userId);
    if (!region) return;
    if (!(await this.anyCatalogFiltersByProvider(userId))) return;

    const tmdb = TmdbClient.shared({ apiKey: this.config.TMDB_API_KEY });
    await Promise.all(
      candidates.map(async (c) => {
        try {
          const byRegion = await tmdb.watchProviders(c.type, c.tmdbId);
          c.streamingProviders = byRegion[region] ?? [];
        } catch {
          // Leave it unset: unknown reads as "don't filter this out".
          delete c.streamingProviders;
        }
      }),
    );
    log.info({ userId, region, count: candidates.length }, 'Streaming availability resolved');
  }

  private async anyCatalogFiltersByProvider(userId: string): Promise<boolean> {
    const rows = await this.db.orm
      .select({ config: catalogs.config })
      .from(catalogs)
      .where(eq(catalogs.userId, userId));
    return rows.some((r) => {
      try {
        const parsed = JSON.parse(r.config) as { providers?: number[] };
        return Array.isArray(parsed.providers) && parsed.providers.length > 0;
      } catch {
        return false;
      }
    });
  }

  /**
   * One lookup per candidate, issued together rather than in a queue. The TMDB
   * client bounds how many actually go out at once, so this is latency the
   * rebuild no longer pays serially, not extra load on TMDB.
   */
  private async resolveImdbIds(candidates: Candidate[]): Promise<void> {
    if (!this.config.TMDB_API_KEY) return;
    const tmdb = TmdbClient.shared({ apiKey: this.config.TMDB_API_KEY });
    await Promise.all(
      candidates.map(async (c) => {
        if (c.imdbId !== undefined) return;
        try {
          c.imdbId = await tmdb.imdbId(c.type, c.tmdbId);
        } catch {
          c.imdbId = null;
        }
      }),
    );
  }
}
