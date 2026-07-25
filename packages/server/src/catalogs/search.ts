import {
  createLogger,
  buildTasteProfile,
  rankSearchResults,
  type Candidate,
  type MediaType,
  type TmdbClient,
} from '@watchmuse/core';

const log = createLogger('search');

/** TMDB returns 20 results a page; two gives the ranker enough to work with. */
const SEARCH_PAGES = 2;

/**
 * Search results change far more slowly than they are requested — the same
 * query from the same person a minute apart is the same answer — so a short
 * shared cache keeps a burst of typing from turning into a burst of TMDB calls.
 * Keyed by type and query only: ranking is applied per user after the cache.
 */
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 500;

interface CacheEntry {
  at: number;
  results: Awaited<ReturnType<TmdbClient['search']>>;
}

const cache = new Map<string, CacheEntry>();

function cacheGet(key: string): CacheEntry['results'] | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  // Refresh insertion order so the eviction below is least-recently-used.
  cache.delete(key);
  cache.set(key, hit);
  return hit.results;
}

function cacheSet(key: string, results: CacheEntry['results']): void {
  cache.set(key, { at: Date.now(), results });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** Drop every cached search. Exported for tests. */
export function clearSearchCache(): void {
  cache.clear();
}

/**
 * Search TMDB and rank the hits against one user's taste.
 *
 * `pool` is the user's candidate pool, used only to build the taste profile. An
 * empty or missing pool is not an error: a brand-new user with no history still
 * gets working search, just ordered by relevance alone.
 *
 * Watched and dismissed titles are deliberately not filtered out. Those filters
 * exist to stop a recommendation row serving something unwanted; a search is the
 * user asking for a specific title by name, and hiding it would read as the
 * search being broken.
 */
export async function searchForUser(
  tmdb: TmdbClient,
  type: MediaType,
  query: string,
  pool: readonly Candidate[] | null,
): Promise<Candidate[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const key = `${type}:${trimmed.toLowerCase()}`;
  let results = cacheGet(key);
  if (!results) {
    const pages = await Promise.all(
      Array.from({ length: SEARCH_PAGES }, (_, i) =>
        tmdb.search(type, trimmed, i + 1).catch((err: unknown) => {
          // One bad page must not lose the whole search; a partial result set
          // still answers the query, and the error is worth seeing.
          log.warn({ type, page: i + 1, err }, 'TMDB search page failed');
          return [];
        }),
      ),
    );
    // Pages are meant to be disjoint, but a duplicate here would reach Stremio
    // as the same title twice in one row, so dedupe rather than trust that.
    const byId = new Map<number, (typeof pages)[number][number]>();
    for (const t of pages.flat()) if (!byId.has(t.tmdbId)) byId.set(t.tmdbId, t);
    results = [...byId.values()];
    if (results.length > 0) cacheSet(key, results);
  }

  return rankSearchResults(results, trimmed, buildTasteProfile(pool ?? []));
}
