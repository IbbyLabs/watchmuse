import { eq } from 'drizzle-orm';
import {
  LlmClient,
  applyCatalogFilter,
  createLogger,
  selectForPrompt,
  type AppConfig,
  type Candidate,
  type CatalogDef,
} from '@watchmuse/core';
import type { Db } from '../db/client.js';
import { nlCatalogCache } from '../db/schema.js';
import type { PoolService } from './pool.js';
import type { LlmConfigStore } from '../ai/store.js';

const log = createLogger('nl-catalog');
const NL_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Serves natural-language catalogs from a cache so the LLM is never called on
 * the Stremio request path. A missing/stale entry returns what's cached (or
 * null) and triggers an async rebuild. Without an LLM key it degrades to the top
 * algorithmic candidates, so an NL catalog is never dead.
 */
export class NlCatalogService {
  private readonly building = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly pools: PoolService,
    private readonly llm: LlmConfigStore,
    private readonly config: AppConfig,
  ) {}

  /** Cached NL result for a catalog; null if none yet (a build is triggered). */
  async get(userId: string, def: CatalogDef): Promise<Candidate[] | null> {
    const [row] = await this.db.orm
      .select()
      .from(nlCatalogCache)
      .where(eq(nlCatalogCache.catalogId, def.id))
      .limit(1);

    const currentHash = await this.pools.hashFor(userId);
    if (!row) {
      void this.build(userId, def);
      return null;
    }
    const stale =
      row.expiresAt.getTime() < Date.now() || (currentHash && row.poolHash !== currentHash);
    if (stale) void this.build(userId, def);
    try {
      return JSON.parse(row.payload) as Candidate[];
    } catch {
      void this.build(userId, def);
      return null;
    }
  }

  async build(userId: string, def: CatalogDef): Promise<void> {
    if (this.building.has(def.id)) return;
    this.building.add(def.id);
    try {
      const pool = await this.pools.get(userId);
      if (!pool) return; // pool building; NL build will be retried on next serve
      const poolHash = (await this.pools.hashFor(userId)) ?? 'none';
      // Constrain to the catalog's media type first, then let the model curate.
      const filtered = applyCatalogFilter(pool, { ...def, filter: {} });
      const result = await this.select(userId, def, filtered);

      const now = new Date();
      const values = {
        catalogId: def.id,
        payload: JSON.stringify(result),
        poolHash,
        builtAt: now,
        expiresAt: new Date(now.getTime() + NL_TTL_MS),
      };
      await this.db.orm
        .insert(nlCatalogCache)
        .values(values)
        .onConflictDoUpdate({ target: nlCatalogCache.catalogId, set: values });
      log.info({ catalogId: def.id, count: result.length }, 'NL catalog built');
    } catch (err) {
      log.error({ catalogId: def.id, err }, 'NL catalog build failed');
    } finally {
      this.building.delete(def.id);
    }
  }

  private async select(
    userId: string,
    def: CatalogDef,
    candidates: Candidate[],
  ): Promise<Candidate[]> {
    const cfg = await this.llm.get(userId);
    const prompt = def.prompt?.trim();
    if (!cfg || !prompt) return candidates.slice(0, 100); // degrade to top algorithmic
    return selectForPrompt(
      new LlmClient({ ...cfg, allowPrivateHost: this.config.AI_ALLOW_PRIVATE_BASE_URL }),
      prompt,
      candidates,
    );
  }
}
