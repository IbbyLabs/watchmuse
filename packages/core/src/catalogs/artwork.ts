import type { MediaType } from '../recommendations/types.js';

/**
 * Custom artwork templates let a user point catalog posters at their own source
 * (XRDB, RatingPosterDB, any id-keyed poster service) instead of TMDB. The
 * template is a URL with placeholders that we fill per title:
 *
 *   {id}    the Stremio id — imdb id ("tt0133093") when known, else "tmdb:603"
 *   {imdb}  the raw imdb id ("tt0133093"); a title without one falls back to TMDB
 *   {tmdb}  the numeric TMDB id ("603")
 *   {type}  "movie" or "series"
 *
 * e.g.  https://your-xrdb/poster/{id}.jpg
 *       https://api.ratingposterdb.com/YOUR-KEY/imdb/poster-default/{imdb}.jpg
 */

export interface ArtworkConfig {
  /** URL template with one or more placeholders. */
  template: string;
}

/** The fields a template can be rendered against. */
export interface PosterKey {
  imdbId?: string | null;
  tmdbId: number;
  type: MediaType;
}

const KNOWN_PLACEHOLDERS = ['id', 'imdb', 'tmdb', 'type'] as const;
const KNOWN = new Set<string>(KNOWN_PLACEHOLDERS);
const KNOWN_TOKEN = /\{(id|imdb|tmdb|type)\}/g;
const ANY_TOKEN = /\{([^}]*)\}/g;

const MAX_TEMPLATE_LENGTH = 500;

/**
 * Render a poster URL from a template. Returns null when the template needs an
 * id we don't have for this title (e.g. `{imdb}` but the title has no imdb id),
 * so the caller can fall back to the default TMDB poster. Substituted values are
 * our own resolved ids, not user input, so they are inserted verbatim (a raw
 * colon in `tmdb:603` is a legal path character and services expect it).
 */
export function renderPosterUrl(template: string, item: PosterKey): string | null {
  let missing = false;
  const out = template.replace(KNOWN_TOKEN, (_match, key: string) => {
    switch (key) {
      case 'id':
        return item.imdbId ?? `tmdb:${item.tmdbId}`;
      case 'imdb':
        if (!item.imdbId) {
          missing = true;
          return '';
        }
        return item.imdbId;
      case 'tmdb':
        return String(item.tmdbId);
      case 'type':
        return item.type;
      default:
        return '';
    }
  });
  return missing ? null : out;
}

export type ArtworkTemplateErrorCode =
  | 'empty'
  | 'too_long'
  | 'not_https'
  | 'no_placeholder'
  | 'unknown_placeholder'
  | 'invalid_url';

export interface ArtworkTemplateError {
  code: ArtworkTemplateErrorCode;
  /** The offending placeholder for `unknown_placeholder`. */
  detail?: string;
}

/**
 * Validate a template before storing it. HTTPS-only (posters are loaded by the
 * user's Stremio client; plain HTTP would be mixed content and is unsafe for a
 * public service). Must contain at least one known placeholder and no unknown
 * ones (catches typos like `{imbd}`), and must parse as a URL once filled.
 */
export function validateArtworkTemplate(template: string): ArtworkTemplateError | null {
  const t = template.trim();
  if (!t) return { code: 'empty' };
  if (t.length > MAX_TEMPLATE_LENGTH) return { code: 'too_long' };
  if (!/^https:\/\//i.test(t)) return { code: 'not_https' };

  const tokens = [...t.matchAll(ANY_TOKEN)].map((m) => m[1] ?? '');
  if (tokens.length === 0) return { code: 'no_placeholder' };
  const unknown = tokens.find((tok) => !KNOWN.has(tok));
  if (unknown !== undefined) return { code: 'unknown_placeholder', detail: unknown };

  const sample = renderPosterUrl(t, { imdbId: 'tt0133093', tmdbId: 603, type: 'movie' });
  if (!sample) return { code: 'invalid_url' };
  try {
    const url = new URL(sample);
    if (url.protocol !== 'https:') return { code: 'not_https' };
  } catch {
    return { code: 'invalid_url' };
  }
  return null;
}
