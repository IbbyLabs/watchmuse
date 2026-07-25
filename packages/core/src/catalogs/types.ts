import type { ProviderId } from '../providers/types.js';

/** How a catalog's items are chosen. */
export type CatalogType = 'filter' | 'nl' | 'rewatch' | 'newseason';

/** Types built from watch history rather than from recommendation candidates. */
export const HISTORY_CATALOG_TYPES = ['rewatch', 'newseason'] as const;

/** A catalog can target movies, series, or both. */
export type CatalogMediaType = 'movie' | 'series' | 'both';

/** How a catalog orders its results. */
export type CatalogSort = 'score' | 'popularity' | 'rating' | 'year';

/** Structured filter for a `filter`-type catalog. All fields are optional (AND). */
export interface FilterConfig {
  /** TMDB genre ids; a title matches if it has ANY of these. */
  genres?: number[];
  yearMin?: number;
  yearMax?: number;
  /** Minimum TMDB vote average (0–10). */
  minRating?: number;
  /**
   * TMDB streaming-service ids. When set, only titles streaming on at least one
   * of them are shown. Empty or absent means the catalog ignores availability.
   */
  providers?: number[];
  sort?: CatalogSort;
}

/** A catalog definition as understood by the engine (persisted per user). */
export interface CatalogDef {
  id: string;
  name: string;
  /**
   * How the row is built. 'filter' and 'nl' draw on recommendation candidates;
   * 'rewatch' and 'newseason' draw on the user's own watch history instead.
   */
  type: CatalogType;
  mediaType: CatalogMediaType;
  /** Present for `filter` catalogs. */
  filter?: FilterConfig;
  /** Present for `nl` catalogs (M3). */
  prompt?: string;
  /** Which connected services' history feeds this catalog. */
  sources: ProviderId[];
  enabled: boolean;
  sortOrder: number;
}
