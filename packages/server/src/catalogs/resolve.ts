import { applyCatalogFilter, recItemKey, type Candidate, type CatalogDef } from '@watchmuse/core';
import type { CatalogService } from './service.js';
import type { PoolService } from './pool.js';
import type { NlCatalogService } from './nl.js';

/**
 * Every candidate a catalog matches — the filtered pool, or an NL selection —
 * ignoring the catalog's own hidden set. Reads caches only (no outbound calls).
 * Null while the underlying pool/NL result is still building.
 */
export async function resolveMatches(
  def: CatalogDef,
  userId: string,
  pools: PoolService,
  nl: NlCatalogService,
): Promise<Candidate[] | null> {
  if (def.type === 'nl') {
    const nlItems = await nl.get(userId, def);
    if (!nlItems) return null;
    return nlItems.filter((c) => def.mediaType === 'both' || c.type === def.mediaType);
  }
  const pool = await pools.get(userId);
  if (!pool) return null;
  return applyCatalogFilter(pool, def);
}

/**
 * Item keys claimed by every enabled catalog ranked above `targetId` on the
 * board (each catalog's matches minus its own hidden items). A title belongs to
 * the highest-priority catalog that matches it, so lower rows drop it and
 * backfill with their next-best — nothing repeats across the board. Board order
 * is the same as `CatalogService.list` (sortOrder, then createdAt).
 */
export async function claimedByHigherPriority(
  catalogs: CatalogService,
  pools: PoolService,
  nl: NlCatalogService,
  userId: string,
  targetId: string,
): Promise<Set<string>> {
  const defs = await catalogs.list(userId);
  const hidden = await catalogs.exclusionsByCatalog(userId);
  const claimed = new Set<string>();
  for (const def of defs) {
    if (def.id === targetId) break; // only catalogs ranked above the target claim
    if (!def.enabled) continue;
    const matches = await resolveMatches(def, userId, pools, nl);
    if (!matches) continue; // still building — claims nothing this pass
    const own = hidden.get(def.id);
    for (const c of matches) {
      const key = recItemKey(c.type, c.tmdbId);
      if (!own?.has(key)) claimed.add(key);
    }
  }
  return claimed;
}
