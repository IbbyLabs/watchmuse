import { TmdbClient } from '../providers/tmdb.js';
import { renderPosterUrl } from './artwork.js';
import { describeWithReason } from './reason.js';
import type { Candidate, MediaType } from '../recommendations/types.js';

/** Stremio meta preview object returned in a catalog response. */
export interface StremioMeta {
  id: string;
  type: 'movie' | 'series';
  name: string;
  poster?: string;
  posterShape?: 'poster';
  description?: string;
  releaseInfo?: string;
  genres?: string[];
}

/** Stremio's content type is 'movie' | 'series' — a 1:1 map from our MediaType. */
function stremioType(type: MediaType): 'movie' | 'series' {
  return type;
}

/**
 * A catalog item's Stremio id. Prefer the IMDB id so Cinemeta and stream addons
 * resolve it out of the box; fall back to a `tmdb:` id (handled by the TMDB
 * addon) when we couldn't resolve one.
 */
function metaId(c: Candidate): string {
  return c.imdbId ? c.imdbId : `tmdb:${c.tmdbId}`;
}

/**
 * Map scored candidates into Stremio catalog metas (posters resolved to URLs).
 * When `artworkTemplate` is set, posters come from the user's own source; a
 * title the template can't key (e.g. `{imdb}` with no imdb id) falls back to its
 * TMDB poster.
 */
export function toStremioMetas(
  candidates: Candidate[],
  genreName?: (id: number) => string | undefined,
  artworkTemplate?: string,
): StremioMeta[] {
  return candidates.map((c) => {
    const genres = genreName ? (c.genreIds ?? []).map(genreName).filter((g): g is string => Boolean(g)) : undefined;
    const meta: StremioMeta = {
      id: metaId(c),
      type: stremioType(c.type),
      name: c.title ?? `TMDB ${c.tmdbId}`,
      posterShape: 'poster',
    };
    const custom = artworkTemplate ? renderPosterUrl(artworkTemplate, c) : null;
    const poster = custom ?? TmdbClient.posterUrl(c.posterPath);
    if (poster) meta.poster = poster;
    const description = describeWithReason(c);
    if (description) meta.description = description;
    if (c.year) meta.releaseInfo = String(c.year);
    if (genres?.length) meta.genres = genres;
    return meta;
  });
}
