import { gunzipSync, gzipSync } from 'node:zlib';
import type {
  CatalogDef,
  CatalogMediaType,
  CatalogSort,
  CatalogType,
  FilterConfig,
} from './types.js';
import type { ProviderId } from '../providers/types.js';

/**
 * A shareable setup string.
 *
 * Carries catalogs and display preferences so someone can hand their setup to a
 * friend, or move it between instances, without rebuilding a dozen filters by
 * hand.
 *
 * It carries no credentials of any kind. A share string ends up pasted into
 * chat threads and forum posts, so anything in it should be assumed public, and
 * a string that could hand over someone's Trakt account is a footgun no amount
 * of encryption makes safe. `sources` names which services feed a catalog, not
 * how to reach them: an import binds those to whatever the importing user has
 * connected, and names a service they lack as simply unmatched.
 *
 * The AI endpoint is left out too. It is useless without a key, and a
 * self-hosted base URL is often a private LAN address the owner would not
 * choose to publish.
 */

/** Bumped when the payload shape changes in a way older readers cannot handle. */
const VERSION = 1;

const PREFIX = 'wm1';
/** Guards against a paste of something enormous being inflated in memory. */
const MAX_ENCODED_LENGTH = 20_000;
const MAX_DECODED_BYTES = 512 * 1024;
const MAX_CATALOGS = 100;

/** A catalog as it travels — no id, since the importer mints its own. */
export interface SharedCatalog {
  name: string;
  type: CatalogType;
  mediaType: CatalogMediaType;
  filter?: FilterConfig;
  prompt?: string;
  sources: ProviderId[];
  enabled: boolean;
  sortOrder: number;
}

export interface SharedConfig {
  version: number;
  catalogs: SharedCatalog[];
  /** Poster template, when the exporter had one set. */
  artworkTemplate?: string;
  /** Pinned streaming country, when the exporter had one set. */
  watchRegion?: string;
}

export class InvalidShareCode extends Error {
  constructor(message = 'That setup code could not be read') {
    super(message);
    this.name = 'InvalidShareCode';
  }
}

function toShared(def: CatalogDef): SharedCatalog {
  return {
    name: def.name,
    type: def.type,
    mediaType: def.mediaType,
    ...(def.filter && { filter: def.filter }),
    ...(def.prompt && { prompt: def.prompt }),
    sources: def.sources,
    enabled: def.enabled,
    sortOrder: def.sortOrder,
  };
}

/** Pack a user's catalogs and preferences into a share string. */
export function encodeShare(input: {
  catalogs: readonly CatalogDef[];
  artworkTemplate?: string | null;
  watchRegion?: string | null;
}): string {
  const payload: SharedConfig = {
    version: VERSION,
    catalogs: input.catalogs.map(toShared),
    ...(input.artworkTemplate ? { artworkTemplate: input.artworkTemplate } : {}),
    ...(input.watchRegion ? { watchRegion: input.watchRegion } : {}),
  };
  const gz = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${PREFIX}.${gz.toString('base64url')}`;
}

const SORTS: CatalogSort[] = ['score', 'popularity', 'rating', 'year'];
const MEDIA: CatalogMediaType[] = ['movie', 'series', 'both'];
const TYPES: CatalogType[] = ['filter', 'nl', 'rewatch', 'newseason'];
const PROVIDERS: ProviderId[] = ['trakt', 'simkl', 'pmdb', 'mdblist', 'letterboxd', 'stremio'];

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function cleanFilter(raw: unknown): FilterConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const out: FilterConfig = {};
  if (Array.isArray(r.genres)) out.genres = r.genres.filter((g): g is number => num(g) !== undefined);
  if (Array.isArray(r.providers))
    out.providers = r.providers.filter((p): p is number => num(p) !== undefined).slice(0, 50);
  const yearMin = num(r.yearMin);
  const yearMax = num(r.yearMax);
  const minRating = num(r.minRating);
  if (yearMin !== undefined) out.yearMin = yearMin;
  if (yearMax !== undefined) out.yearMax = yearMax;
  if (minRating !== undefined) out.minRating = Math.min(10, Math.max(0, minRating));
  if (SORTS.includes(r.sort as CatalogSort)) out.sort = r.sort as CatalogSort;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Read a share string back.
 *
 * Every field is re-derived rather than trusted: the string arrives from
 * wherever the user copied it, so this treats it as hostile input and keeps
 * only values it recognises. Anything unrecognised is dropped instead of
 * failing the whole import, so one odd catalog cannot cost someone the rest.
 */
export function decodeShare(code: string): SharedConfig {
  const trimmed = code.trim();
  if (trimmed.length > MAX_ENCODED_LENGTH) throw new InvalidShareCode('That setup code is too long');
  const [prefix, body] = trimmed.split('.', 2);
  if (prefix !== PREFIX || !body) throw new InvalidShareCode();

  let json: string;
  try {
    const gz = Buffer.from(body, 'base64url');
    const raw = gunzipSync(gz, { maxOutputLength: MAX_DECODED_BYTES });
    json = raw.toString('utf8');
  } catch {
    throw new InvalidShareCode();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new InvalidShareCode();
  }
  if (typeof parsed !== 'object' || parsed === null) throw new InvalidShareCode();

  const p = parsed as Record<string, unknown>;
  if (num(p.version) !== VERSION) {
    throw new InvalidShareCode('That setup code came from a different version of Watchmuse');
  }
  if (!Array.isArray(p.catalogs)) throw new InvalidShareCode();

  const catalogs: SharedCatalog[] = [];
  for (const raw of p.catalogs.slice(0, MAX_CATALOGS)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const c = raw as Record<string, unknown>;
    const name = typeof c.name === 'string' ? c.name.trim().slice(0, 80) : '';
    if (!name) continue;
    const type: CatalogType = TYPES.includes(c.type as CatalogType)
      ? (c.type as CatalogType)
      : 'filter';
    catalogs.push({
      name,
      type,
      mediaType: MEDIA.includes(c.mediaType as CatalogMediaType)
        ? (c.mediaType as CatalogMediaType)
        : 'both',
      ...(type === 'filter' ? { filter: cleanFilter(c.filter) } : {}),
      ...(type === 'nl' && typeof c.prompt === 'string'
        ? { prompt: c.prompt.slice(0, 500) }
        : {}),
      sources: Array.isArray(c.sources)
        ? c.sources.filter((s): s is ProviderId => PROVIDERS.includes(s as ProviderId))
        : [],
      enabled: c.enabled !== false,
      sortOrder: num(c.sortOrder) ?? catalogs.length,
    });
  }

  const artworkTemplate = typeof p.artworkTemplate === 'string' ? p.artworkTemplate : undefined;
  const watchRegion =
    typeof p.watchRegion === 'string' && /^[A-Z]{2}$/.test(p.watchRegion) ? p.watchRegion : undefined;

  return {
    version: VERSION,
    catalogs,
    ...(artworkTemplate ? { artworkTemplate } : {}),
    ...(watchRegion ? { watchRegion } : {}),
  };
}
