import { randomUUID, randomBytes } from 'node:crypto';
import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  recItemKey,
  type CatalogDef,
  type CatalogMediaType,
  type CatalogType,
  type FilterConfig,
  type MediaType,
  type ProviderId,
} from '@watchmuse/core';
import type { Db } from '../db/client.js';
import { catalogExclusions, catalogs, installs, type Catalog } from '../db/schema.js';

export interface CatalogInput {
  name: string;
  type?: CatalogType;
  mediaType?: CatalogMediaType;
  filter?: FilterConfig;
  prompt?: string;
  sources?: ProviderId[];
  enabled?: boolean;
  sortOrder?: number;
}

const CATALOG_TYPES: CatalogType[] = ['filter', 'nl', 'rewatch', 'newseason'];

function toDef(row: Catalog): CatalogDef {
  const config = safeJson<Record<string, unknown>>(row.config, {});
  const sources = safeJson<ProviderId[]>(row.sources, []);
  return {
    id: row.id,
    name: row.name,
    type: CATALOG_TYPES.includes(row.type as CatalogType) ? (row.type as CatalogType) : 'filter',
    mediaType: row.mediaType as CatalogMediaType,
    filter: row.type === 'filter' ? (config as FilterConfig) : undefined,
    prompt: row.type === 'nl' ? (config.prompt as string | undefined) : undefined,
    sources,
    enabled: row.enabled,
    sortOrder: row.sortOrder,
  };
}

function safeJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Catalog definitions + Stremio install ids for a user. */
export class CatalogService {
  constructor(private readonly db: Db) {}

  async list(userId: string): Promise<CatalogDef[]> {
    const rows = await this.db.orm
      .select()
      .from(catalogs)
      .where(eq(catalogs.userId, userId))
      .orderBy(asc(catalogs.sortOrder), asc(catalogs.createdAt));
    return rows.map(toDef);
  }

  async get(userId: string, id: string): Promise<CatalogDef | null> {
    const [row] = await this.db.orm
      .select()
      .from(catalogs)
      .where(and(eq(catalogs.userId, userId), eq(catalogs.id, id)))
      .limit(1);
    return row ? toDef(row) : null;
  }

  async create(userId: string, input: CatalogInput): Promise<CatalogDef> {
    const id = randomUUID();
    const now = new Date();
    const config = input.type === 'nl' ? { prompt: input.prompt ?? '' } : (input.filter ?? {});
    await this.db.orm.insert(catalogs).values({
      id,
      userId,
      name: input.name,
      type: input.type ?? 'filter',
      mediaType: input.mediaType ?? 'both',
      config: JSON.stringify(config),
      sources: JSON.stringify(input.sources ?? []),
      enabled: input.enabled ?? true,
      sortOrder: input.sortOrder ?? 0,
      createdAt: now,
      updatedAt: now,
    });
    return (await this.get(userId, id))!;
  }

  async update(userId: string, id: string, patch: Partial<CatalogInput>): Promise<CatalogDef | null> {
    const existing = await this.get(userId, id);
    if (!existing) return null;
    const type = patch.type ?? existing.type;
    const config =
      type === 'nl'
        ? { prompt: patch.prompt ?? existing.prompt ?? '' }
        : (patch.filter ?? existing.filter ?? {});
    await this.db.orm
      .update(catalogs)
      .set({
        name: patch.name ?? existing.name,
        type,
        mediaType: patch.mediaType ?? existing.mediaType,
        config: JSON.stringify(config),
        sources: JSON.stringify(patch.sources ?? existing.sources),
        enabled: patch.enabled ?? existing.enabled,
        sortOrder: patch.sortOrder ?? existing.sortOrder,
        updatedAt: new Date(),
      })
      .where(and(eq(catalogs.userId, userId), eq(catalogs.id, id)));
    return this.get(userId, id);
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const existing = await this.get(userId, id);
    if (!existing) return false;
    await this.db.orm.delete(catalogs).where(and(eq(catalogs.userId, userId), eq(catalogs.id, id)));
    return true;
  }

  /** Hidden items for a catalog, keyed `type:tmdbId` (the applyCatalogFilter exclude format). */
  async exclusionKeys(userId: string, catalogId: string): Promise<Set<string>> {
    const rows = await this.db.orm
      .select({ tmdbId: catalogExclusions.tmdbId, mediaType: catalogExclusions.mediaType })
      .from(catalogExclusions)
      .where(and(eq(catalogExclusions.userId, userId), eq(catalogExclusions.catalogId, catalogId)));
    return new Set(rows.map((r) => recItemKey(r.mediaType as MediaType, r.tmdbId)));
  }

  /** All of a user's hidden items grouped by catalog id, in one query (for board-wide dedupe). */
  async exclusionsByCatalog(userId: string): Promise<Map<string, Set<string>>> {
    const rows = await this.db.orm
      .select({ catalogId: catalogExclusions.catalogId, tmdbId: catalogExclusions.tmdbId, mediaType: catalogExclusions.mediaType })
      .from(catalogExclusions)
      .where(eq(catalogExclusions.userId, userId));
    const byCatalog = new Map<string, Set<string>>();
    for (const r of rows) {
      const key = recItemKey(r.mediaType as MediaType, r.tmdbId);
      const set = byCatalog.get(r.catalogId) ?? new Set<string>();
      set.add(key);
      byCatalog.set(r.catalogId, set);
    }
    return byCatalog;
  }

  /** Hide a title from a catalog. Idempotent; returns false if the catalog isn't the user's. */
  async addExclusion(userId: string, catalogId: string, tmdbId: number, mediaType: MediaType): Promise<boolean> {
    const owns = await this.get(userId, catalogId);
    if (!owns) return false;
    await this.db.orm
      .insert(catalogExclusions)
      .values({ id: randomUUID(), userId, catalogId, tmdbId, mediaType, createdAt: new Date() })
      .onConflictDoNothing({ target: [catalogExclusions.catalogId, catalogExclusions.mediaType, catalogExclusions.tmdbId] });
    return true;
  }

  /** Un-hide a previously hidden title. */
  async removeExclusion(userId: string, catalogId: string, tmdbId: number, mediaType: MediaType): Promise<boolean> {
    const owns = await this.get(userId, catalogId);
    if (!owns) return false;
    await this.db.orm
      .delete(catalogExclusions)
      .where(
        and(
          eq(catalogExclusions.userId, userId),
          eq(catalogExclusions.catalogId, catalogId),
          eq(catalogExclusions.mediaType, mediaType),
          eq(catalogExclusions.tmdbId, tmdbId),
        ),
      );
    return true;
  }

  /** Seed two sensible default catalogs the first time a user has none. */
  async ensureDefaults(userId: string, sources: ProviderId[]): Promise<void> {
    const existing = await this.db.orm
      .select({ id: catalogs.id })
      .from(catalogs)
      .where(eq(catalogs.userId, userId))
      .limit(1);
    if (existing.length > 0) return;
    await this.create(userId, { name: 'Recommended Movies', mediaType: 'movie', sources, sortOrder: 0 });
    await this.create(userId, { name: 'Recommended Series', mediaType: 'series', sources, sortOrder: 1 });
  }

  /** The opaque, stable install id for a user's Stremio manifest URL. */
  async getOrCreateInstall(userId: string): Promise<string> {
    const [row] = await this.db.orm
      .select()
      .from(installs)
      .where(and(eq(installs.userId, userId), isNull(installs.revokedAt)))
      .limit(1);
    if (row) return row.id;
    const id = randomBytes(18).toString('base64url');
    await this.db.orm.insert(installs).values({ id, userId, createdAt: new Date() });
    return id;
  }

  /** Resolve a manifest install id back to its (non-revoked) user. */
  async resolveInstall(installId: string): Promise<string | null> {
    const [row] = await this.db.orm
      .select()
      .from(installs)
      .where(and(eq(installs.id, installId), isNull(installs.revokedAt)))
      .limit(1);
    return row?.userId ?? null;
  }
}
