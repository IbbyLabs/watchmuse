import { HttpClient, HttpError } from './http.js';
import { createLogger } from '../logger.js';
import { type ProviderCapabilities, type WatchEvent } from './types.js';

const log = createLogger('mdblist');

const MDBLIST_BASE = 'https://api.mdblist.com';
/** MDBList caps `/sync/watched` at 1000 rows per page. */
const PAGE_LIMIT = 1000;
/** Bound on history pages so a runaway response never loops forever. */
const MAX_PAGES = 50;

interface WatchedTitle {
  ids?: { tmdb?: number | null };
}
interface WatchedResponse {
  movies?: Array<{ movie: WatchedTitle }>;
  episodes?: Array<{ episode: { season: number; number: number; show: WatchedTitle } }>;
  pagination?: { has_more?: boolean };
}

/** Keys `/sync/watched` is known to answer with. */
const KNOWN_KEYS = ['movies', 'episodes', 'shows', 'pagination'];

/**
 * Reject a body that is not the documented shape. Without this, an endpoint
 * that renames its envelope reads as an account that has watched nothing: the
 * pull "succeeds" with zero rows and the recommendations quietly rebuild around
 * an empty history. A body with no keys at all is a genuinely empty library and
 * passes; one carrying only unrecognized keys is drift and throws.
 */
function assertWatchedShape(body: unknown): asserts body is WatchedResponse {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('MDBList returned an unexpected response for the watched list');
  }
  const keys = Object.keys(body);
  if (keys.length > 0 && !keys.some((k) => KNOWN_KEYS.includes(k))) {
    throw new Error(
      `MDBList returned an unrecognized watched list (fields: ${keys.slice(0, 5).join(', ')})`,
    );
  }
}

/**
 * MDBList (api.mdblist.com) as a read-only history source for recommendations.
 * Its `/sync/watched` endpoint returns the account's watched movies and episodes
 * keyed by TMDB id, which is exactly what the reco pipeline needs. The API key
 * authenticates as the `apikey` query parameter.
 */
export class MdblistClient {
  readonly id = 'mdblist' as const;
  private readonly http: HttpClient;

  constructor(apiKey: string) {
    this.http = new HttpClient({
      provider: 'mdblist',
      baseUrl: MDBLIST_BASE,
      defaultQuery: { apikey: apiKey },
      minIntervalMs: 40,
      headers: { 'user-agent': 'Watchmuse' },
    });
  }

  capabilities(): ProviderCapabilities {
    return { history: true, progress: false, ratings: false, watchlist: true, datedHistory: false };
  }

  /** Validate the API key. Returns true if accepted, false on 401/403. */
  async validate(): Promise<boolean> {
    try {
      await this.http.get('/user');
      return true;
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) return false;
      throw err;
    }
  }

  /** The account's watched movies and episodes, keyed by TMDB id. */
  async pullHistory(_since?: string | null): Promise<WatchEvent[]> {
    const out: WatchEvent[] = [];
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.http.get<unknown>(
        `/sync/watched?limit=${PAGE_LIMIT}&offset=${offset}`,
      );
      assertWatchedShape(res);
      for (const m of res.movies ?? []) {
        const tmdb = m.movie.ids?.tmdb;
        if (tmdb) out.push({ ref: { kind: 'movie', ids: { tmdb } }, watchedAt: null });
      }
      for (const e of res.episodes ?? []) {
        const tmdb = e.episode.show.ids?.tmdb;
        if (tmdb) {
          out.push({
            ref: {
              kind: 'episode',
              ids: { tmdb },
              season: e.episode.season,
              number: e.episode.number,
            },
            watchedAt: null,
          });
        }
      }
      if (!res.pagination?.has_more) break;
      offset += PAGE_LIMIT;
      if (page === MAX_PAGES - 1) {
        log.warn(
          { pages: MAX_PAGES, events: out.length },
          'Stopped reading the MDBList history at the page limit; the rest is not included',
        );
      }
    }
    return out;
  }
}
