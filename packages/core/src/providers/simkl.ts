import { HttpClient, HttpError } from './http.js';
import { createLogger } from '../logger.js';
import {
  emptyPushResult,
  type ExternalIds,
  type MediaRef,
  type ProgressEvent,
  type ProviderCapabilities,
  type RatingEvent,
  type PushResult,
  type WatchEvent,
} from './types.js';

const SIMKL_BASE = 'https://api.simkl.com';

const log = createLogger('simkl');

interface SimklIdBlock {
  simkl?: number;
  imdb?: string;
  tmdb?: number | string;
  tvdb?: number | string;
  mal?: number | string;
  anilist?: number | string;
  anidb?: number | string;
}

interface SimklMovieItem {
  last_watched_at?: string;
  movie: { title?: string; year?: number; ids: SimklIdBlock };
}
interface SimklShowItem {
  last_watched_at?: string;
  status?: string; // watching | completed | hold | dropped | plantowatch
  show: { title?: string; year?: number; ids: SimklIdBlock };
  seasons?: Array<{ number: number; episodes?: Array<{ number: number; watched_at?: string }> }>;
}

/**
 * Normalize a Simkl watch timestamp. Simkl fills in a 1970 epoch placeholder
 * ("1970-01-01T00:00:01Z") to mean "watched, but the user doesn't remember
 * when" — a sentinel, not a real date. Map it (and empties) to null so it isn't
 * treated as an ancient watch.
 */
function watchDate(raw?: string | null): string | null {
  if (!raw || raw.startsWith('1970-')) return null;
  return raw;
}

export interface SimklPin {
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}

export interface SimklConfig {
  clientId: string;
  clientSecret?: string;
  accessToken?: string;
  appName?: string;
  appVersion?: string;
}

const num = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const toIds = (b: SimklIdBlock): ExternalIds => ({
  ...(b.imdb ? { imdb: String(b.imdb) } : {}),
  ...(num(b.tmdb) !== undefined ? { tmdb: num(b.tmdb) } : {}),
  ...(num(b.tvdb) !== undefined ? { tvdb: num(b.tvdb) } : {}),
  ...(num(b.simkl) !== undefined ? { simkl: num(b.simkl) } : {}),
  ...(num(b.mal) !== undefined ? { mal: num(b.mal) } : {}),
  ...(num(b.anilist) !== undefined ? { anilist: num(b.anilist) } : {}),
  ...(num(b.anidb) !== undefined ? { anidb: num(b.anidb) } : {}),
});

interface SimklRatedMovie {
  user_rating?: number | null;
  user_rated_at?: string | null;
  movie: { title?: string; year?: number; ids: SimklIdBlock };
}
interface SimklRatedShow {
  user_rating?: number | null;
  user_rated_at?: string | null;
  show: { title?: string; year?: number; ids: SimklIdBlock };
}
interface SimklRatingsResponse {
  movies?: SimklRatedMovie[];
  shows?: SimklRatedShow[];
  anime?: SimklRatedShow[];
}

export class SimklClient {
  readonly id = 'simkl' as const;
  private readonly http: HttpClient;

  /** Latest `/sync/activities` "all" timestamp seen during a pull (delta cursor). */
  lastActivityAll?: string;

  constructor(private readonly cfg: SimklConfig) {
    this.http = new HttpClient({
      provider: 'simkl',
      baseUrl: SIMKL_BASE,
      minIntervalMs: 300,
      // Simkl suspends a key that calls too hard, and one key serves every
      // connected account, so the interval has to hold across all of them
      // rather than per client.
      rateLimitKey: `simkl:${cfg.clientId}`,
      headers: {
        'simkl-api-key': cfg.clientId,
        'user-agent': `${cfg.appName ?? 'Watchmuse'}/${cfg.appVersion ?? '0.1.0'}`,
        ...(cfg.accessToken ? { authorization: `Bearer ${cfg.accessToken}` } : {}),
      },
      // Simkl requires app-name/app-version on every request or it suspends the key.
      defaultQuery: {
        'app-name': cfg.appName ?? 'Watchmuse',
        'app-version': cfg.appVersion ?? '0.1.0',
      },
    });
  }

  capabilities(): ProviderCapabilities {
    // Simkl has no reliable per-episode watched date, and no resume position API.
    return { history: true, progress: false, ratings: true, watchlist: true, datedHistory: false };
  }

  // ── Authorization-code (redirect) flow ───────────────────────────

  authorizeUrl(redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.cfg.clientId,
      redirect_uri: redirectUri,
      state,
    });
    return `https://simkl.com/oauth/authorize?${params.toString()}`;
  }

  /** Exchange the redirect code for an access token. */
  async exchangeCode(code: string, redirectUri: string): Promise<string> {
    const r = await this.http.post<{ access_token?: string }>('/oauth/token', {
      code,
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    if (!r.access_token) throw new Error('Simkl code exchange failed');
    return r.access_token;
  }

  // ── PIN auth flow ────────────────────────────────────────────────

  async requestPin(): Promise<SimklPin & { userCode: string }> {
    const r = await this.http.get<{
      result: string;
      user_code: string;
      verification_url: string;
      expires_in: number;
      interval: number;
    }>(`/oauth/pin?client_id=${this.cfg.clientId}`);
    if (r.result !== 'OK') throw new Error('Simkl PIN request failed');
    return {
      userCode: r.user_code,
      verificationUrl: r.verification_url,
      expiresIn: r.expires_in,
      interval: r.interval,
    };
  }

  /** Poll once. Returns an access token when authorized, or 'pending'. */
  async pollPin(userCode: string): Promise<string | 'pending'> {
    const r = await this.http.get<{ result: string; access_token?: string; message?: string }>(
      `/oauth/pin/${userCode}?client_id=${this.cfg.clientId}`,
    );
    if (r.result === 'OK' && r.access_token) return r.access_token;
    return 'pending';
  }

  async validate(): Promise<boolean> {
    try {
      await this.getActivities();
      return true;
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) return false;
      throw err;
    }
  }

  // ── Reads ────────────────────────────────────────────────────────

  getActivities(): Promise<Record<string, unknown>> {
    return this.http.get('/sync/activities');
  }

  /** The `/sync/activities` "all" timestamp — used as the delta cursor. */
  async currentActivity(): Promise<string | undefined> {
    try {
      const a = await this.getActivities();
      return typeof a.all === 'string' ? a.all : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Pull watched history. Follows Simkl's required protocol to avoid a suspended
   * key: check `/sync/activities` first; if nothing changed since the saved
   * cursor, skip the pull entirely; otherwise fetch only the `date_from` delta
   * (types fetched sequentially, never in parallel).
   */
  /**
   * The user's own scores, 1-10.
   *
   * Movies and shows only; Simkl cannot rate seasons or episodes. Anime come
   * back under their own key but are shows as far as everything else here is
   * concerned.
   */
  async pullRatings(): Promise<RatingEvent[]> {
    const res = await this.http.post<SimklRatingsResponse>('/sync/ratings', {});
    const out: RatingEvent[] = [];
    for (const m of res?.movies ?? []) {
      if (m.user_rating == null) continue;
      out.push({
        ref: { kind: 'movie', ids: toIds(m.movie.ids), title: m.movie.title, year: m.movie.year },
        rating: m.user_rating,
        ratedAt: m.user_rated_at ?? null,
      });
    }
    for (const s of [...(res?.shows ?? []), ...(res?.anime ?? [])]) {
      if (s.user_rating == null) continue;
      out.push({
        ref: { kind: 'show', ids: toIds(s.show.ids), title: s.show.title, year: s.show.year },
        rating: s.user_rating,
        ratedAt: s.user_rated_at ?? null,
      });
    }
    return out;
  }

  async pullHistory(since?: string | null): Promise<WatchEvent[]> {
    const ts = await this.currentActivity();
    if (ts) this.lastActivityAll = ts;
    if (since && ts && since === ts) return []; // unchanged — don't hit the library

    const delta = since ? `&date_from=${encodeURIComponent(since)}` : '';
    const out: WatchEvent[] = [];

    // A failed fetch is not an empty library. Swallowing it here would report a
    // partial history as if it were the whole thing, which silently reshapes
    // every recommendation built from it. Let it throw: the caller skips this
    // provider for the run and keeps what it already had.
    const movies = await this.http
      .get<{ movies?: SimklMovieItem[] }>(`/sync/all-items/movies/completed?extended=full${delta}`)
      .catch((err: unknown) => {
        log.warn({ err }, 'Failed to read watched movies from Simkl');
        throw err;
      });
    for (const m of movies.movies ?? []) {
      out.push({
        ref: { kind: 'movie', ids: toIds(m.movie.ids), title: m.movie.title, year: m.movie.year },
        watchedAt: watchDate(m.last_watched_at),
      });
    }

    // Read every status, and force Simkl to enumerate watched episodes: with a
    // plain `extended=full` the `completed` and `dropped` buckets return no
    // `seasons[].episodes[]` at all, so a fully-watched series would contribute
    // nothing and the whole media type could come back empty. `include_all_episodes`
    // loads episodes on those buckets too; `episode_watched_at` attaches the real
    // per-episode date. Simkl only returns actually-watched episodes, so this never
    // marks an unwatched one. Plan-to-watch shows enumerate nothing and aren't
    // `completed`, so they're correctly left out of the taste seeds.
    for (const type of ['shows', 'anime'] as const) {
      const res = await this.http
        .get<Record<string, SimklShowItem[]>>(
          `/sync/all-items/${type}?extended=full&include_all_episodes=yes&episode_watched_at=yes${delta}`,
        )
        .catch((err: unknown) => {
          log.warn({ type, err }, 'Failed to read watched shows from Simkl');
          throw err;
        });
      const items = res[type] ?? res.shows ?? [];
      for (const s of items) {
        const ids = toIds(s.show.ids);
        const enumerated = (s.seasons ?? []).some((se) => (se.episodes ?? []).length > 0);
        if (enumerated) {
          for (const season of s.seasons ?? []) {
            for (const ep of season.episodes ?? []) {
              out.push({
                // Prefer the per-episode watched_at; fall back to the show-level
                // last_watched_at. Either way the rolled-up series carries a real
                // recency signal instead of a null that sorts it below every dated
                // movie. Stable across runs.
                ref: {
                  kind: 'episode',
                  ids,
                  season: season.number,
                  number: ep.number,
                  title: s.show.title,
                },
                watchedAt: watchDate(ep.watched_at ?? s.last_watched_at),
              });
            }
          }
        } else if (s.status === 'completed') {
          // Fully watched but Simkl declined to enumerate — seed the whole series.
          out.push({
            ref: { kind: 'show', ids, title: s.show.title },
            watchedAt: watchDate(s.last_watched_at),
          });
        }
      }
    }
    return out;
  }

  // Simkl has no resume-position API.
  async pullProgress(): Promise<ProgressEvent[]> {
    return [];
  }

  async pushProgress(events: ProgressEvent[]): Promise<PushResult> {
    const r = emptyPushResult();
    r.notFound = events.length;
    return r;
  }

  // ── Writes ───────────────────────────────────────────────────────

  async pushHistory(events: WatchEvent[]): Promise<PushResult> {
    const result = emptyPushResult();
    const movies: Array<Record<string, unknown>> = [];
    // Episode number to its watch time. Simkl defaults a missing watched_at to
    // the request time, so aggregating into a Set drops the date and lands every
    // episode on the day of the push.
    const showsByKey = new Map<
      string,
      { ids: ExternalIds; seasons: Map<number, Map<number, string | undefined>> }
    >();

    for (const e of events) {
      if (e.ref.kind === 'movie') {
        if (!hasId(e.ref.ids)) {
          result.notFound++;
          continue;
        }
        movies.push({ watched_at: e.watchedAt ?? undefined, ids: e.ref.ids });
      } else {
        if (e.ref.season === undefined || e.ref.number === undefined || !hasId(e.ref.ids)) {
          result.notFound++;
          continue;
        }
        const key = idKey(e.ref.ids);
        const show = showsByKey.get(key) ?? { ids: e.ref.ids, seasons: new Map() };
        const eps = show.seasons.get(e.ref.season) ?? new Map<number, string | undefined>();
        // Two events for one episode: keep the earlier, which is the watch this
        // history records rather than a re-watch.
        const seen = eps.get(e.ref.number);
        const at = e.watchedAt ?? undefined;
        eps.set(e.ref.number, seen && at ? (seen < at ? seen : at) : (seen ?? at));
        show.seasons.set(e.ref.season, eps);
        showsByKey.set(key, show);
      }
    }

    const shows = [...showsByKey.values()].map((s) => ({
      ids: s.ids,
      seasons: [...s.seasons.entries()].map(([number, eps]) => ({
        number,
        episodes: [...eps.entries()].map(([n, at]) => ({ number: n, watched_at: at })),
      })),
    }));

    if (movies.length === 0 && shows.length === 0) return result;

    try {
      const res = await this.http.post<{ not_found?: Record<string, unknown[]> }>('/sync/history', {
        movies,
        shows,
      });
      const sent =
        movies.length +
        shows.reduce((a, s) => a + s.seasons.reduce((b, x) => b + x.episodes.length, 0), 0);
      // Simkl answers 200 and reports what it could not match, so a status check
      // alone counts unmatched titles as delivered.
      const missing = Object.values(res?.not_found ?? {}).reduce(
        (n, list) => n + (Array.isArray(list) ? list.length : 0),
        0,
      );
      result.notFound += missing;
      result.added = sent - missing;
    } catch (err) {
      result.failed = events.length;
      log.warn({ err, movies: movies.length, shows: shows.length }, 'Could not write history to Simkl');
    }
    return result;
  }
}

const hasId = (ids: ExternalIds): boolean =>
  Boolean(ids.imdb || ids.tmdb || ids.tvdb || ids.simkl || ids.mal || ids.anilist);

const idKey = (ids: ExternalIds): string =>
  ids.simkl
    ? `s${ids.simkl}`
    : ids.imdb
      ? `i${ids.imdb}`
      : ids.tmdb
        ? `m${ids.tmdb}`
        : ids.tvdb
          ? `v${ids.tvdb}`
          : `a${ids.anilist ?? ids.mal}`;
