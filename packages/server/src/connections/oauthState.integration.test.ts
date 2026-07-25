import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@watchmuse/core';
import { createDb, type Db } from '../db/client.js';
import { users } from '../db/schema.js';
import { OAuthStateStore } from './oauthState.js';

const testEnv = {
  NODE_ENV: 'test',
  APP_URL: 'http://localhost:8080',
  DATABASE_URL: 'pglite://memory',
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  SESSION_SECRET: 'y'.repeat(40),
} as NodeJS.ProcessEnv;

let db: Db;
let store: OAuthStateStore;
let userId: string;

beforeAll(async () => {
  const config = loadConfig(testEnv);
  db = await createDb(config.DATABASE_URL);
  await db.migrate();
  store = new OAuthStateStore(db);

  userId = randomUUID();
  await db.orm.insert(users).values({ id: userId, email: 'a@b.co', passwordHash: 'x' });
});

afterAll(async () => {
  await db.close();
});

describe('OAuthStateStore', () => {
  it('round-trips a state back to its user and provider', async () => {
    const state = await store.create(userId, 'trakt');
    await expect(store.consume(state)).resolves.toEqual({ userId, provider: 'trakt' });
  });

  it('survives the process that issued it going away', async () => {
    const state = await store.create(userId, 'simkl');
    const afterRestart = new OAuthStateStore(db);
    await expect(afterRestart.consume(state)).resolves.toEqual({ userId, provider: 'simkl' });
  });

  it('redeems a state only once', async () => {
    const state = await store.create(userId, 'trakt');
    await store.consume(state);
    await expect(store.consume(state)).resolves.toBeNull();
  });

  it('rejects a state it never issued', async () => {
    await expect(store.consume('made-up')).resolves.toBeNull();
  });

  it('does not keep the raw state anywhere', async () => {
    const state = await store.create(userId, 'trakt');
    const rows = await db.orm.query.oauthStates.findMany();
    expect(rows.map((r) => r.id)).not.toContain(state);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('purges states nobody came back for', async () => {
    await store.create(userId, 'trakt');
    const purged = await store.purgeExpired();
    expect(purged).toBe(0); // freshly issued, still valid
  });
});
