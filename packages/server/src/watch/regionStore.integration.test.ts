import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@watchmuse/core';
import { createDb, type Db } from '../db/client.js';
import { users } from '../db/schema.js';
import { WatchRegionStore } from './regionStore.js';

const testEnv = {
  NODE_ENV: 'test',
  APP_URL: 'http://localhost:8080',
  DATABASE_URL: 'pglite://memory',
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  SESSION_SECRET: 'y'.repeat(40),
} as NodeJS.ProcessEnv;

let db: Db;
let store: WatchRegionStore;

async function newUser(): Promise<string> {
  const id = randomUUID();
  await db.orm.insert(users).values({ id, email: `${id}@b.co`, passwordHash: 'x' });
  return id;
}

beforeAll(async () => {
  const config = loadConfig(testEnv);
  db = await createDb(config.DATABASE_URL);
  await db.migrate();
  store = new WatchRegionStore(db);
});

afterAll(async () => {
  await db.close();
});

describe('WatchRegionStore', () => {
  it('knows nothing about a user it has never seen', async () => {
    await expect(store.get(await newUser())).resolves.toEqual({
      chosen: null,
      detected: null,
      effective: null,
    });
  });

  it('uses where the requests come from when nothing was chosen', async () => {
    const id = await newUser();
    await store.observe(id, 'GB');
    await expect(store.effective(id)).resolves.toBe('GB');
  });

  it('lets an explicit choice win over detection', async () => {
    const id = await newUser();
    await store.observe(id, 'GB');
    await store.choose(id, 'JP');
    await expect(store.effective(id)).resolves.toBe('JP');
  });

  it('does not let travelling overwrite a deliberate choice', async () => {
    const id = await newUser();
    await store.choose(id, 'JP');
    await store.observe(id, 'FR');

    const region = await store.get(id);
    expect(region.chosen).toBe('JP');
    expect(region.detected).toBe('FR');
    expect(region.effective).toBe('JP');
  });

  it('follows detection again once the choice is cleared', async () => {
    const id = await newUser();
    await store.observe(id, 'DE');
    await store.choose(id, 'JP');
    await store.choose(id, null);
    await expect(store.effective(id)).resolves.toBe('DE');
  });

  it('keeps up as the detected country changes', async () => {
    const id = await newUser();
    await store.observe(id, 'GB');
    await store.observe(id, 'GB'); // repeat is a no-op
    await store.observe(id, 'ES');
    await expect(store.effective(id)).resolves.toBe('ES');
  });
});
