import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadConfig, type AppConfig, type Candidate } from '@watchmuse/core';
import { createDb, type Db } from '../db/client.js';
import { candidatePools, users } from '../db/schema.js';
import type { RecommendationService } from '../reco/service.js';
import type { LlmConfigStore } from '../ai/store.js';
import type { WatchRegionStore } from '../watch/regionStore.js';
import { PoolService } from './pool.js';

const testEnv = {
  NODE_ENV: 'test',
  APP_URL: 'http://localhost:8080',
  DATABASE_URL: 'pglite://memory',
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  SESSION_SECRET: 'y'.repeat(40),
} as NodeJS.ProcessEnv;

function candidate(tmdbId: number): Candidate {
  return { tmdbId, type: 'movie', score: 1, seeds: [], sources: [] } as unknown as Candidate;
}

let db: Db;
let config: AppConfig;
let userId: string;

/** A pool service whose only outside input is what the reco layer returns. */
function poolWith(candidates: () => Promise<Candidate[]>): PoolService {
  const reco = {
    candidatesFor: candidates,
    buildFor: async () => ({ watched: [], candidates: await candidates() }),
  } as unknown as RecommendationService;
  const llm = { get: async () => null } as unknown as LlmConfigStore;
  const regions = { effective: async () => null } as unknown as WatchRegionStore;
  // No TMDB key, so the id and availability lookups are skipped.
  return new PoolService(db, reco, { ...config, TMDB_API_KEY: '' }, llm, regions);
}

async function storedIds(): Promise<number[]> {
  const [row] = await db.orm.select().from(candidatePools);
  if (!row) return [];
  return (JSON.parse(row.payload) as Candidate[]).map((c) => c.tmdbId);
}

beforeAll(async () => {
  config = loadConfig(testEnv);
  db = await createDb(config.DATABASE_URL);
  await db.migrate();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.orm.delete(candidatePools);
  userId = randomUUID();
  await db.orm.insert(users).values({ id: userId, email: `${userId}@b.co`, passwordHash: 'x' });
});

describe('PoolService.refresh', () => {
  it('stores what the rebuild produced', async () => {
    await poolWith(async () => [candidate(550), candidate(603)]).refresh(userId);
    expect(await storedIds()).toEqual([550, 603]);
  });

  it('stores an empty pool for a user who has no history yet', async () => {
    await poolWith(async () => []).refresh(userId);
    expect(await storedIds()).toEqual([]);
  });

  /**
   * The failure this guards against: every connected provider is skipped for a
   * run (an outage, an expired token, a changed payload), the rebuild returns
   * nothing, and the empty result replaces a working pool for the length of the
   * TTL. Every catalog the user has goes blank until it expires.
   */
  it('keeps a working pool when a rebuild comes back empty', async () => {
    await poolWith(async () => [candidate(550), candidate(603)]).refresh(userId);
    await poolWith(async () => []).refresh(userId);
    expect(await storedIds()).toEqual([550, 603]);
  });

  it('leaves the failed rebuild expired so the next read tries again', async () => {
    await poolWith(async () => [candidate(550)]).refresh(userId);
    await db.orm.update(candidatePools).set({ expiresAt: new Date(Date.now() - 1000) });
    await poolWith(async () => []).refresh(userId);

    const [row] = await db.orm.select().from(candidatePools);
    expect(row!.expiresAt.getTime()).toBeLessThan(Date.now());
  });

  it('replaces the pool again once the rebuild recovers', async () => {
    await poolWith(async () => [candidate(550)]).refresh(userId);
    await poolWith(async () => []).refresh(userId);
    await poolWith(async () => [candidate(680)]).refresh(userId);
    expect(await storedIds()).toEqual([680]);
  });

  it('does not let a rebuild that threw wipe the pool either', async () => {
    await poolWith(async () => [candidate(550)]).refresh(userId);
    await poolWith(async () => {
      throw new Error('provider down');
    }).refresh(userId);
    expect(await storedIds()).toEqual([550]);
  });
});
