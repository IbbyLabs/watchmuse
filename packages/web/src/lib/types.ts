export type ProviderId = 'trakt' | 'simkl' | 'pmdb' | 'mdblist' | 'letterboxd' | 'stremio';

export interface User {
  id: string;
  email: string;
  username: string | null;
  emailVerified: boolean;
  isAdmin: boolean;
}

export interface Connection {
  id: string;
  provider: ProviderId;
  label: string | null;
  status: string;
  createdAt: string;
  lastValidatedAt: string | null;
}

export interface ProviderStatus {
  provider: ProviderId;
  configured: boolean;
  /** Whether the one-click browser redirect flow is available. */
  redirect: boolean;
}

export type CatalogMediaType = 'movie' | 'series' | 'both';
export type CatalogSort = 'score' | 'popularity' | 'rating' | 'year';

export interface FilterConfig {
  genres?: number[];
  yearMin?: number;
  yearMax?: number;
  minRating?: number;
  /** TMDB streaming-service ids; empty means availability is ignored. */
  providers?: number[];
  sort?: CatalogSort;
}

/** How a catalog's items are chosen. */
export type CatalogType = 'filter' | 'nl' | 'rewatch' | 'newseason';

export interface Catalog {
  id: string;
  name: string;
  type: CatalogType;
  mediaType: CatalogMediaType;
  filter?: FilterConfig;
  prompt?: string;
  sources: ProviderId[];
  enabled: boolean;
  sortOrder: number;
}

export interface InstallInfo {
  installId: string;
  manifestUrl: string;
  stremioUrl: string;
}

export interface PreviewItem {
  tmdbId: number;
  type: 'movie' | 'series';
  title: string;
  year?: number;
  poster: string | null;
}

/** Which of a catalog's filters is narrowing it, and by how much. */
export interface ConstraintReport {
  key: 'mediaType' | 'genres' | 'years' | 'minRating' | 'providers' | 'sources';
  withoutThis: number;
}

export interface CatalogDiagnosis {
  matched: number;
  pool: number;
  /** Worst offender first; empty when the catalog filters nothing. */
  constraints: ConstraintReport[];
}

export interface CatalogPreview {
  status: 'ready' | 'building';
  items: PreviewItem[];
  hidden: PreviewItem[];
  /** Present for filter catalogs once the pool exists. */
  diagnosis?: CatalogDiagnosis;
}

export interface GenreOption {
  id: number;
  label: string;
}

/**
 * TMDB genres, split by taxonomy: movies and TV shows use different id sets for
 * the same idea (a film is "Science Fiction" 878, a show is "Sci-Fi & Fantasy"
 * 10765). The builder shows the set matching the catalog's media type so a
 * series catalog offers genres that series actually carry.
 */
export const MOVIE_GENRES: GenreOption[] = [
  { id: 28, label: 'Action' },
  { id: 12, label: 'Adventure' },
  { id: 16, label: 'Animation' },
  { id: 35, label: 'Comedy' },
  { id: 80, label: 'Crime' },
  { id: 99, label: 'Documentary' },
  { id: 18, label: 'Drama' },
  { id: 10751, label: 'Family' },
  { id: 14, label: 'Fantasy' },
  { id: 36, label: 'History' },
  { id: 27, label: 'Horror' },
  { id: 10402, label: 'Music' },
  { id: 9648, label: 'Mystery' },
  { id: 10749, label: 'Romance' },
  { id: 878, label: 'Sci-Fi' },
  { id: 53, label: 'Thriller' },
  { id: 10752, label: 'War' },
  { id: 37, label: 'Western' },
];

export const SERIES_GENRES: GenreOption[] = [
  { id: 10759, label: 'Action & Adventure' },
  { id: 16, label: 'Animation' },
  { id: 35, label: 'Comedy' },
  { id: 80, label: 'Crime' },
  { id: 99, label: 'Documentary' },
  { id: 18, label: 'Drama' },
  { id: 10751, label: 'Family' },
  { id: 10762, label: 'Kids' },
  { id: 9648, label: 'Mystery' },
  { id: 10764, label: 'Reality' },
  { id: 10765, label: 'Sci-Fi & Fantasy' },
  { id: 10768, label: 'War & Politics' },
  { id: 37, label: 'Western' },
];

/** Genre chips to show for a catalog's media type ('both' uses the movie set). */
export function genresForMediaType(mediaType: CatalogMediaType): GenreOption[] {
  return mediaType === 'series' ? SERIES_GENRES : MOVIE_GENRES;
}

// Cross-taxonomy pairs, so a selection survives flipping the media type.
const MOVIE_TO_TV: Record<number, number> = {
  28: 10759,
  12: 10759,
  14: 10765,
  878: 10765,
  10752: 10768,
};
const TV_TO_MOVIE: Record<number, number> = { 10759: 28, 10765: 878, 10768: 10752 };

const GENRE_LABEL: Record<number, string> = Object.fromEntries(
  [...MOVIE_GENRES, ...SERIES_GENRES].map((g) => [g.id, g.label]),
);

/** Human-readable names for a set of stored genre ids (movie or TV taxonomy). */
export function genreNames(ids: number[]): string[] {
  return ids.map((id) => GENRE_LABEL[id]).filter((label): label is string => Boolean(label));
}

/** Re-map selected genre ids onto the set valid for a media type, dropping ones with no equivalent. */
export function remapGenresForMediaType(ids: number[], mediaType: CatalogMediaType): number[] {
  const valid = new Set(genresForMediaType(mediaType).map((g) => g.id));
  const out: number[] = [];
  for (const id of ids) {
    const alt = mediaType === 'series' ? MOVIE_TO_TV[id] : TV_TO_MOVIE[id];
    const mapped = valid.has(id) ? id : alt !== undefined && valid.has(alt) ? alt : undefined;
    if (mapped !== undefined && !out.includes(mapped)) out.push(mapped);
  }
  return out;
}

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  trakt: 'Trakt',
  simkl: 'Simkl',
  pmdb: 'PublicMetaDB',
  mdblist: 'MDBList',
  letterboxd: 'Letterboxd',
  stremio: 'Stremio',
};

/** A streaming service offered in the catalog editor's picker. */
export interface WatchService {
  id: number;
  name: string;
  logoPath: string | null;
  priority: number;
}
