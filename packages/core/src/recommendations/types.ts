import type { ProviderId } from '../providers/types.js';

/** Watchmuse works in TMDB space: everything is a movie or a series (show). */
export type MediaType = 'movie' | 'series';

/** Stable key for deduping / watched-lookups across sources. */
export function itemKey(type: MediaType, tmdbId: number): string {
  return `${type}:${tmdbId}`;
}

/**
 * A title the user has watched, normalized to a TMDB id. Episodes roll up to
 * their parent series, so one series watched many times is a single item.
 */
export interface WatchedItem {
  tmdbId: number;
  type: MediaType;
  title?: string;
  year?: number;
  /** User rating on the source's scale (typically 1–10), if known. */
  rating?: number;
  /** Most recent known watch date (ISO 8601), or null if the source has none. */
  watchedAt?: string | null;
  /** Which connected services reported this item. */
  sources: ProviderId[];
  /**
   * Season numbers with at least one watched episode, ascending. Series only,
   * and only from providers that report episodes: a show whose history arrived
   * as a bare "watched" has no seasons listed, which is not the same as none
   * being watched.
   */
  seasonsWatched?: number[];
}

/** Where a candidate came from — used for scoring and "why recommended". */
export type CandidateSource = 'tmdb-similar' | 'tmdb-rec' | 'trakt-rec' | 'simkl-rec';

/** A raw suggestion before merge/scoring. One per (source, seed) hit. */
export interface RawCandidate {
  tmdbId: number;
  type: MediaType;
  title?: string;
  year?: number;
  /** TMDB synopsis, when known — carried through so catalog metas can show it. */
  overview?: string;
  source: CandidateSource;
  /** The watched item's tmdbId that surfaced this, when the source is per-seed. */
  fromSeed?: number;
  /** TMDB popularity, when known (used as a tiebreaker). */
  popularity?: number;
  /** TMDB vote average 0–10, when known. */
  voteAverage?: number;
  /** TMDB vote count, when known — how much weight `voteAverage` has earned. */
  voteCount?: number;
  /** TMDB poster path (e.g. "/abc.jpg"), for catalog display. */
  posterPath?: string | null;
  /** TMDB genre ids, for catalog filtering. */
  genreIds?: number[];
}

/** A merged, scored recommendation candidate. */
export interface Candidate {
  tmdbId: number;
  type: MediaType;
  title?: string;
  year?: number;
  /** TMDB synopsis, when known — shown as the Stremio meta description. */
  overview?: string;
  score: number;
  /** Distinct watched tmdbIds that recommended this (provenance). */
  fromSeeds: number[];
  /**
   * Titles of the watched items behind `fromSeeds`, strongest seed first, for
   * the "why recommended" line. Carried on the candidate because the watch
   * history is not in hand when a catalog is served.
   */
  seedTitles?: string[];
  /** Whether the user rated the first of `seedTitles` highly, when known. */
  fromLovedSeed?: boolean;
  /** Distinct sources that surfaced this. */
  sources: CandidateSource[];
  /**
   * Connected services whose history led here, via the seeds that surfaced it or
   * directly for account-level recommendations. Lets a catalog be bound to a
   * subset of the user's connections.
   */
  fromProviders?: ProviderId[];
  popularity?: number;
  voteAverage?: number;
  voteCount?: number;
  posterPath?: string | null;
  genreIds?: number[];
  /**
   * TMDB ids of the services streaming this in the user's region, when it has
   * been looked up. Absent means unknown, which is not the same as nowhere.
   */
  streamingProviders?: number[];
  /** IMDB id (e.g. "tt1234567"), resolved for Stremio/Cinemeta handoff. */
  imdbId?: string | null;
}
