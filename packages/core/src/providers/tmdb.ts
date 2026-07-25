import { HttpClient } from './http.js';
import type { MediaType } from '../recommendations/types.js';
import type { SeasonInfo } from '../catalogs/history-rows.js';

const TMDB_BASE = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p';

/** TMDB uses 'movie' and 'tv'; Watchmuse uses 'movie' and 'series'. */
function tmdbType(type: MediaType): 'movie' | 'tv' {
  return type === 'movie' ? 'movie' : 'tv';
}

/** A normalized TMDB title, media-type-agnostic. */
export interface TmdbTitle {
  tmdbId: number;
  type: MediaType;
  title?: string;
  year?: number;
  overview?: string;
  posterPath?: string | null;
  popularity?: number;
  voteAverage?: number;
  /** How many votes back `voteAverage` — a thin count makes the average noise. */
  voteCount?: number;
  genreIds?: number[];
}

interface TmdbRaw {
  id: number;
  title?: string; // movie
  name?: string; // tv
  release_date?: string; // movie
  first_air_date?: string; // tv
  overview?: string;
  poster_path?: string | null;
  popularity?: number;
  vote_average?: number;
  vote_count?: number;
  genre_ids?: number[];
  genres?: Array<{ id: number }>;
}

interface TmdbProviderRaw {
  provider_id: number;
  provider_name: string;
  logo_path?: string | null;
  display_priority?: number;
}

interface TmdbRegionProviders {
  /** JustWatch deep link. Their terms do not allow passing it on, so unused. */
  link?: string;
  flatrate?: TmdbProviderRaw[];
  free?: TmdbProviderRaw[];
  ads?: TmdbProviderRaw[];
  rent?: TmdbProviderRaw[];
  buy?: TmdbProviderRaw[];
}

interface TmdbRegionRaw {
  iso_3166_1: string;
  english_name: string;
}

/** A country TMDB can answer streaming availability for. */
export interface WatchRegionOption {
  code: string;
  name: string;
}

/** A streaming service, as offered in a picker. */
export interface WatchProvider {
  id: number;
  name: string;
  logoPath: string | null;
  priority: number;
}

interface TmdbList {
  page: number;
  total_pages: number;
  results: TmdbRaw[];
}

function yearOf(raw: TmdbRaw): number | undefined {
  const d = raw.release_date || raw.first_air_date;
  if (!d) return undefined;
  const y = Number(d.slice(0, 4));
  return Number.isFinite(y) && y > 0 ? y : undefined;
}

function normalize(raw: TmdbRaw, type: MediaType): TmdbTitle {
  return {
    tmdbId: raw.id,
    type,
    title: raw.title ?? raw.name,
    year: yearOf(raw),
    overview: raw.overview,
    posterPath: raw.poster_path ?? null,
    popularity: raw.popularity,
    voteAverage: raw.vote_average,
    voteCount: raw.vote_count,
    genreIds: raw.genre_ids ?? raw.genres?.map((g) => g.id),
  };
}

export interface TmdbConfig {
  apiKey: string;
}

/**
 * Read-only TMDB client for candidate generation and metadata. Auth is the v3
 * `api_key` query param, sent on every request via the HTTP client's defaults.
 */
export class TmdbClient {
  readonly id = 'tmdb' as const;
  private readonly http: HttpClient;

  /**
   * The concurrency bound lives on the client, so building one per operation
   * multiplies it: two rebuilds at once would open twice as many sockets to
   * TMDB as either thinks it is allowed. Callers share one per key so the limit
   * means what it says process-wide.
   */
  private static readonly instances = new Map<string, TmdbClient>();

  static shared(cfg: TmdbConfig): TmdbClient {
    let client = TmdbClient.instances.get(cfg.apiKey);
    if (!client) {
      client = new TmdbClient(cfg);
      TmdbClient.instances.set(cfg.apiKey, client);
    }
    return client;
  }

  constructor(cfg: TmdbConfig) {
    this.http = new HttpClient({
      provider: 'tmdb',
      baseUrl: TMDB_BASE,
      minIntervalMs: 60, // TMDB is generous (~50 req/s); stay well under
      // A rebuild is hundreds of small reads whose cost is round-trip latency,
      // not TMDB's rate limit. Overlapping them keeps the pacing above intact.
      maxConcurrent: 6,
      defaultQuery: { api_key: cfg.apiKey },
      headers: { 'user-agent': 'Watchmuse' },
    });
  }

  /** Titles similar to a given one (TMDB's `/similar`). */
  async similar(type: MediaType, tmdbId: number, page = 1): Promise<TmdbTitle[]> {
    const r = await this.http.get<TmdbList>(`/${tmdbType(type)}/${tmdbId}/similar?page=${page}`);
    return r.results.map((x) => normalize(x, type));
  }

  /** TMDB's collaborative `/recommendations` for a title. */
  async recommendations(type: MediaType, tmdbId: number, page = 1): Promise<TmdbTitle[]> {
    const r = await this.http.get<TmdbList>(
      `/${tmdbType(type)}/${tmdbId}/recommendations?page=${page}`,
    );
    return r.results.map((x) => normalize(x, type));
  }

  /**
   * Title search (TMDB's `/search/{movie,tv}`).
   *
   * `include_adult` is pinned off rather than left to the account default, which
   * is settable per API key and would otherwise decide what a catalog serves.
   */
  async search(type: MediaType, query: string, page = 1): Promise<TmdbTitle[]> {
    const q = encodeURIComponent(query.trim());
    if (!q) return [];
    const r = await this.http.get<TmdbList>(
      `/search/${tmdbType(type)}?query=${q}&page=${page}&include_adult=false`,
    );
    return r.results.map((x) => normalize(x, type));
  }

  /**
   * TMDB id for an IMDb id, or null when TMDB does not know it.
   *
   * `/find` answers every media type at once, so the caller's expected type
   * picks the right bucket: an id can legitimately match a film and a series
   * with the same name, and guessing would silently attach a watch to the wrong
   * title.
   */
  async findByImdbId(imdbId: string, type: MediaType): Promise<number | null> {
    const r = await this.http.get<{
      movie_results?: Array<{ id: number }>;
      tv_results?: Array<{ id: number }>;
    }>(`/find/${encodeURIComponent(imdbId)}?external_source=imdb_id`);
    const hit = type === 'movie' ? r.movie_results?.[0] : r.tv_results?.[0];
    return hit?.id ?? null;
  }

  /**
   * A series' seasons and production status, for spotting a season the user has
   * not watched. Only the fields the check needs are kept; the full TV payload
   * is large and most of it is irrelevant here.
   */
  async seasonInfo(tmdbId: number): Promise<SeasonInfo> {
    const r = await this.http.get<{
      status?: string;
      seasons?: Array<{ season_number: number; air_date?: string | null }>;
    }>(`/tv/${tmdbId}`);
    return {
      status: r.status,
      seasons: (r.seasons ?? []).map((s) => ({
        seasonNumber: s.season_number,
        airDate: s.air_date ?? null,
      })),
    };
  }

  /** Full metadata for one title (posters, overview, genres) — used by catalogs. */
  async details(type: MediaType, tmdbId: number): Promise<TmdbTitle> {
    const r = await this.http.get<TmdbRaw>(`/${tmdbType(type)}/${tmdbId}`);
    return normalize(r, type);
  }

  /**
   * Streaming provider ids per region for one title, keyed by ISO 3166-1 code.
   *
   * Only subscription-style access counts: `flatrate`, plus free and
   * ad-supported. Rent and buy are a purchase, not somewhere you can already
   * watch it. The `link` TMDB returns alongside is a JustWatch deep link, which
   * their terms do not let us pass on, so it is dropped here.
   */
  async watchProviders(type: MediaType, tmdbId: number): Promise<Record<string, number[]>> {
    const r = await this.http.get<{ results?: Record<string, TmdbRegionProviders> }>(
      `/${tmdbType(type)}/${tmdbId}/watch/providers`,
    );
    const out: Record<string, number[]> = {};
    for (const [region, entry] of Object.entries(r.results ?? {})) {
      const ids = new Set<number>();
      for (const list of [entry.flatrate, entry.free, entry.ads]) {
        for (const p of list ?? []) ids.add(p.provider_id);
      }
      if (ids.size > 0) out[region] = [...ids].sort((a, b) => a - b);
    }
    return out;
  }

  /** Countries TMDB has streaming availability for, for building a picker. */
  async watchRegions(): Promise<WatchRegionOption[]> {
    const r = await this.http.get<{ results?: TmdbRegionRaw[] }>('/watch/providers/regions');
    return (r.results ?? [])
      .map((x) => ({ code: x.iso_3166_1, name: x.english_name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Streaming services available in a region, for building a picker. */
  async availableProviders(type: MediaType, region: string): Promise<WatchProvider[]> {
    const r = await this.http.get<{ results?: TmdbProviderRaw[] }>(
      `/watch/providers/${tmdbType(type)}?watch_region=${encodeURIComponent(region)}`,
    );
    return (r.results ?? [])
      .map((p) => ({
        id: p.provider_id,
        name: p.provider_name,
        logoPath: p.logo_path ?? null,
        priority: p.display_priority ?? 0,
      }))
      .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  }

  /** Resolve a title's IMDB id (for Stremio/Cinemeta handoff), or null. */
  async imdbId(type: MediaType, tmdbId: number): Promise<string | null> {
    const r = await this.http.get<{ imdb_id?: string | null }>(
      `/${tmdbType(type)}/${tmdbId}/external_ids`,
    );
    return r.imdb_id || null;
  }

  /** Absolute poster URL for a TMDB poster path, or null. */
  static posterUrl(posterPath?: string | null, size = 'w500'): string | null {
    return posterPath ? `${IMAGE_BASE}/${size}${posterPath}` : null;
  }

  /** Human-readable name for a TMDB genre id (movie + tv), or undefined. */
  static genreName(id: number): string | undefined {
    return TMDB_GENRES[id];
  }
}

/** Static TMDB genre id → name map (movie and tv), so we don't call /genre. */
const TMDB_GENRES: Record<number, string> = {
  28: 'Action',
  12: 'Adventure',
  16: 'Animation',
  35: 'Comedy',
  80: 'Crime',
  99: 'Documentary',
  18: 'Drama',
  10751: 'Family',
  14: 'Fantasy',
  36: 'History',
  27: 'Horror',
  10402: 'Music',
  9648: 'Mystery',
  10749: 'Romance',
  878: 'Science Fiction',
  10770: 'TV Movie',
  53: 'Thriller',
  10752: 'War',
  37: 'Western',
  10759: 'Action & Adventure',
  10762: 'Kids',
  10763: 'News',
  10764: 'Reality',
  10765: 'Sci-Fi & Fantasy',
  10766: 'Soap',
  10767: 'Talk',
  10768: 'War & Politics',
};
