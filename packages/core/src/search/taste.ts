import { buildEraProfile, eraAffinity, type EraProfile } from '../recommendations/era.js';
import { credibleRating } from '../recommendations/rating.js';
import { itemKey, type Candidate, type MediaType } from '../recommendations/types.js';

/**
 * Ranking for search results, which are ordinary TMDB titles rather than scored
 * candidates.
 *
 * The point of searching a recommendation addon is that it knows you: given
 * fifty Batman titles it should lead with the one you would actually pick. But
 * taste must not outrank the query — searching a title by name and not getting
 * it first reads as broken, however well-judged the substitute. So relevance
 * anchors the order and taste resolves what relevance leaves tied.
 */

/** Exact title match. Dominant: it is what the user typed. */
const W_MATCH = 6;
/** TMDB's own result order, which already encodes query relevance. */
const W_RELEVANCE = 4;
/** Genre and era affinity, from the user's own pool. */
const W_TASTE = 3;
/** Already recommended to this user: real collaborative evidence, not a guess. */
const W_POOL = 2;
/** Credibility-weighted TMDB rating, as a gentle tiebreaker. */
const W_RATING = 1;

/**
 * Ceilings for a non-exact match, scaled by how much of the title the query
 * actually covers. "Arrival" is a prefix of both "Arrival" and "Arrival of the
 * Comedians", and without the coverage term those would count almost the same.
 */
const MATCH_PREFIX = 0.9;
const MATCH_CONTAINS = 0.6;

/**
 * Result position where TMDB's relevance is worth half of first place. Decay is
 * by absolute rank rather than position within the returned set: normalising by
 * length would make the top result's lead depend on how many results came back,
 * so a two-hit search could never be reordered by taste at all.
 */
const RELEVANCE_HALF_RANK = 5;

/** Genre affinity for a title with no genres known — neither helped nor hurt. */
const UNKNOWN_GENRE_AFFINITY = 0.5;

export interface TasteProfile {
  readonly era: EraProfile;
  /** Genre id to affinity 0-1, normalised so the strongest genre is 1. */
  readonly genres: ReadonlyMap<number, number>;
  /** Item key to pool score, so a title already recommended ranks on evidence. */
  readonly poolScores: ReadonlyMap<string, number>;
  /** Highest pool score, used to normalise `poolScores` into 0-1. */
  readonly poolPeak: number;
}

/**
 * Build a taste profile from the user's candidate pool.
 *
 * The pool rather than the raw watch history because a `WatchedItem` carries no
 * genres, so a genre profile from history would cost one TMDB lookup per watched
 * title. The pool is built from those same seeds and already carries genres,
 * years and scores, so it is a free and faithful stand-in. Candidates are
 * weighted by score: what the engine rates highly for this user counts more than
 * what merely appeared.
 */
export function buildTasteProfile(pool: readonly Candidate[]): TasteProfile {
  const genreWeights = new Map<number, number>();
  let poolPeak = 0;
  const poolScores = new Map<string, number>();

  for (const c of pool) {
    poolScores.set(itemKey(c.type, c.tmdbId), c.score);
    if (c.score > poolPeak) poolPeak = c.score;
    for (const g of c.genreIds ?? []) {
      genreWeights.set(g, (genreWeights.get(g) ?? 0) + Math.max(c.score, 0));
    }
  }

  let genrePeak = 0;
  for (const v of genreWeights.values()) genrePeak = Math.max(genrePeak, v);
  const genres = new Map<number, number>();
  if (genrePeak > 0) {
    for (const [id, v] of genreWeights) genres.set(id, v / genrePeak);
  }

  // buildEraProfile wants watched items; a candidate's year is the only field it
  // reads, and the pool's year distribution mirrors the history it came from.
  const era = buildEraProfile(
    pool.map((c) => ({ tmdbId: c.tmdbId, type: c.type, year: c.year, sources: [] })),
  );

  return { era, genres, poolScores, poolPeak };
}

/** Strongest genre affinity among a title's genres, or neutral if none known. */
function genreAffinity(profile: TasteProfile, genreIds?: number[]): number {
  if (profile.genres.size === 0 || !genreIds?.length) return UNKNOWN_GENRE_AFFINITY;
  let best = 0;
  for (const g of genreIds) best = Math.max(best, profile.genres.get(g) ?? 0);
  return best;
}

const normalize = (s: string): string => s.trim().toLowerCase();

/**
 * How well a title answers the literal query, 0-1. Partial matches are scaled by
 * the share of the title the query accounts for, so a short query buried in a
 * long title scores near nothing while an exact hit scores full marks.
 */
function titleMatch(query: string, title?: string): number {
  if (!title) return 0;
  const q = normalize(query);
  const t = normalize(title);
  if (!q || !t) return 0;
  if (t === q) return 1;
  const coverage = q.length / t.length;
  if (t.startsWith(q)) return MATCH_PREFIX * coverage;
  if (t.includes(q)) return MATCH_CONTAINS * coverage;
  return 0;
}

/** A TMDB title as returned by search, before ranking. */
export interface SearchResult {
  tmdbId: number;
  type: MediaType;
  title?: string;
  year?: number;
  overview?: string;
  popularity?: number;
  voteAverage?: number;
  voteCount?: number;
  posterPath?: string | null;
  genreIds?: number[];
}

/**
 * Rank search results for one user. `results` must arrive in TMDB's own order,
 * which carries the query relevance this leans on. Pure and deterministic: ties
 * break by tmdbId so the same search always returns the same order.
 */
export function rankSearchResults(
  results: readonly SearchResult[],
  query: string,
  profile: TasteProfile,
): Candidate[] {
  return results
    .map((r, index) => {
      const relevance = 1 / (1 + index / RELEVANCE_HALF_RANK);
      const pooled = profile.poolScores.get(itemKey(r.type, r.tmdbId));
      const poolAffinity = pooled !== undefined && profile.poolPeak > 0 ? pooled / profile.poolPeak : 0;
      const taste = (genreAffinity(profile, r.genreIds) + eraAffinity(profile.era, r.year)) / 2;

      const score =
        titleMatch(query, r.title) * W_MATCH +
        relevance * W_RELEVANCE +
        taste * W_TASTE +
        poolAffinity * W_POOL +
        (credibleRating(r.voteAverage, r.voteCount) / 10) * W_RATING;

      return {
        tmdbId: r.tmdbId,
        type: r.type,
        title: r.title,
        year: r.year,
        overview: r.overview,
        score: Math.round(score * 1000) / 1000,
        fromSeeds: [],
        sources: [],
        popularity: r.popularity,
        voteAverage: r.voteAverage,
        voteCount: r.voteCount,
        posterPath: r.posterPath,
        genreIds: r.genreIds,
      } satisfies Candidate;
    })
    .sort((a, b) => b.score - a.score || a.tmdbId - b.tmdbId);
}
