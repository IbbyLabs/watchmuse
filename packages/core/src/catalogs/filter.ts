import type { ProviderId } from '../providers/types.js';
import { diversify } from '../recommendations/diversity.js';
import { credibleRating } from '../recommendations/rating.js';
import { itemKey, type Candidate } from '../recommendations/types.js';
import type { CatalogDef, CatalogMediaType, CatalogSort, FilterConfig } from './types.js';

function matchesMediaType(c: Candidate, mediaType: CatalogMediaType): boolean {
  if (mediaType === 'both') return true;
  return c.type === mediaType;
}

/**
 * TMDB splits some genres between its movie and TV taxonomies, so the same
 * concept has a different id on a film than on a show. The catalog builder only
 * offers the movie ids, but series carry the TV ids — without bridging them a
 * series catalog filtered on e.g. "Sci-Fi" (878) matches nothing, since shows
 * are tagged "Sci-Fi & Fantasy" (10765). Each id maps to its cross-taxonomy
 * equivalents so a selected genre matches both film and show candidates.
 */
const GENRE_EQUIVALENTS: Record<number, number[]> = {
  28: [10759], // Action -> Action & Adventure
  12: [10759], // Adventure -> Action & Adventure
  10759: [28, 12], // Action & Adventure -> Action, Adventure
  878: [10765], // Science Fiction -> Sci-Fi & Fantasy
  14: [10765], // Fantasy -> Sci-Fi & Fantasy
  10765: [878, 14], // Sci-Fi & Fantasy -> Science Fiction, Fantasy
  10752: [10768], // War -> War & Politics
  10768: [10752], // War & Politics -> War
};

/** A selected genre plus its cross-taxonomy (movie/TV) equivalents. */
function expandGenres(genres: number[]): Set<number> {
  const out = new Set<number>();
  for (const g of genres) {
    out.add(g);
    for (const eq of GENRE_EQUIVALENTS[g] ?? []) out.add(eq);
  }
  return out;
}

/**
 * A catalog can be bound to a subset of the user's connections, so a row can be
 * "what my Trakt history suggests" while another draws on everything. An empty
 * list means no restriction, which is what every catalog starts as.
 */
function matchesSources(c: Candidate, sources: ProviderId[]): boolean {
  if (sources.length === 0) return true;
  const from = c.fromProviders;
  // Pools built before provenance was recorded carry none; show them rather
  // than blanking the row until the next rebuild.
  if (!from) return true;
  return from.some((p) => sources.includes(p));
}

/**
 * Availability filter. A title whose providers were never looked up is kept:
 * "we don't know" is not "nowhere", and dropping unknowns would empty the row
 * for any pool built before the lookup existed or whose lookup failed. Only a
 * title we checked and found streaming nowhere relevant is removed.
 */
function matchesProviders(c: Candidate, wanted?: number[]): boolean {
  if (!wanted?.length) return true;
  if (c.streamingProviders === undefined) return true;
  return c.streamingProviders.some((id) => wanted.includes(id));
}

function matchesFilter(c: Candidate, f: FilterConfig): boolean {
  if (f.genres?.length) {
    const ids = c.genreIds ?? [];
    const wanted = expandGenres(f.genres);
    if (!ids.some((id) => wanted.has(id))) return false;
  }
  if (f.yearMin !== undefined && (c.year ?? 0) < f.yearMin) return false;
  if (f.yearMax !== undefined && (c.year ?? Number.MAX_SAFE_INTEGER) > f.yearMax) return false;
  if (f.minRating !== undefined && credibleRating(c.voteAverage, c.voteCount) < f.minRating)
    return false;
  if (!matchesProviders(c, f.providers)) return false;
  return true;
}

function sortKey(c: Candidate, sort: CatalogSort): number {
  switch (sort) {
    case 'popularity':
      return c.popularity ?? 0;
    case 'rating':
      return credibleRating(c.voteAverage, c.voteCount);
    case 'year':
      return c.year ?? 0;
    default:
      return c.score;
  }
}

/**
 * Apply a catalog definition to a scored candidate pool: keep matching titles,
 * order by the chosen key. Pure and deterministic (ties break by tmdbId) so a
 * catalog's contents cache cleanly for a given pool. `exclude` holds hidden
 * items keyed by `type:tmdbId`; dropping one lets the next-best matching
 * candidate take its place, so a hidden title backfills for free.
 */
export function applyCatalogFilter(
  candidates: Candidate[],
  def: CatalogDef,
  exclude?: ReadonlySet<string>,
): Candidate[] {
  const filter = def.filter ?? {};
  const sort = filter.sort ?? 'score';
  const matched = candidates
    .filter(
      (c) =>
        matchesMediaType(c, def.mediaType) &&
        matchesSources(c, def.sources) &&
        matchesFilter(c, filter) &&
        !exclude?.has(itemKey(c.type, c.tmdbId)),
    )
    .sort((a, b) => sortKey(b, sort) - sortKey(a, sort) || a.tmdbId - b.tmdbId);

  // An explicit sort is the user asking for that exact order; only the default
  // relevance ordering is ours to spread out.
  return sort === 'score' ? diversify(matched) : matched;
}
