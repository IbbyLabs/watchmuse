import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@watchmuse/core';
import { createDb, type Db } from '../db/client.js';
import { candidatePools, installs, users } from '../db/schema.js';
import { MaintenanceStore } from './store.js';

const testEnv = {
  NODE_ENV: 'test',
  APP_URL: 'http://localhost:8080',
  DATABASE_URL: 'pglite://memory',
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  SESSION_SECRET: 'y'.repeat(40),
} as NodeJS.ProcessEnv;

let db: Db;
let store: MaintenanceStore;

const HOUR = 3_600_000;

interface Fixture {
  pool?: 'stale' | 'fresh';
  install?: 'active' | 'revoked';
  staleBy?: number;
}

async function user(name: string, f: Fixture): Promise<string> {
  const id = randomUUID();
  await db.orm.insert(users).values({ id, email: `${name}@b.co`, passwordHash: 'x' });
  if (f.install) {
    await db.orm.insert(installs).values({
      id: randomUUID(),
      userId: id,
      revokedAt: f.install === 'revoked' ? new Date() : null,
    });
  }
  if (f.pool) {
    const offset = f.pool === 'stale' ? -(f.staleBy ?? 1) * HOUR : HOUR;
    await db.orm.insert(candidatePools).values({
      userId: id,
      payload: '[]',
      historyHash: 'h',
      expiresAt: new Date(Date.now() + offset),
    });
  }
  return id;
}

beforeAll(async () => {
  const config = loadConfig(testEnv);
  db = await createDb(config.DATABASE_URL);
  await db.migrate();
  store = new MaintenanceStore(db);
});

afterAll(async () => {
  await db.close();
});

describe('MaintenanceStore.usersWithStalePools', () => {
  it('picks up a stale pool belonging to an installed user', async () => {
    const id = await user('due', { pool: 'stale', install: 'active' });
    await expect(store.usersWithStalePools(10)).resolves.toContain(id);
  });

  it('skips a user whose pool is still fresh', async () => {
    const id = await user('fresh', { pool: 'fresh', install: 'active' });
    await expect(store.usersWithStalePools(10)).resolves.not.toContain(id);
  });

  it('skips a user with no install, since nothing would read the result', async () => {
    const id = await user('noinstall', { pool: 'stale' });
    await expect(store.usersWithStalePools(10)).resolves.not.toContain(id);
  });

  it('skips a user whose only install was revoked', async () => {
    const id = await user('revoked', { pool: 'stale', install: 'revoked' });
    await expect(store.usersWithStalePools(10)).resolves.not.toContain(id);
  });

  it('returns the longest-stale user first', async () => {
    const old = await user('oldest', { pool: 'stale', install: 'active', staleBy: 500 });
    const ids = await store.usersWithStalePools(10);
    expect(ids[0]).toBe(old);
  });

  it('returns no more than the limit', async () => {
    await user('cap1', { pool: 'stale', install: 'active' });
    await user('cap2', { pool: 'stale', install: 'active' });
    await expect(store.usersWithStalePools(1)).resolves.toHaveLength(1);
  });

  it('lists a user once even with several installs', async () => {
    const id = randomUUID();
    await db.orm.insert(users).values({ id, email: 'multi@b.co', passwordHash: 'x' });
    await db.orm.insert(installs).values([
      { id: randomUUID(), userId: id },
      { id: randomUUID(), userId: id },
    ]);
    await db.orm.insert(candidatePools).values({
      userId: id,
      payload: '[]',
      historyHash: 'h',
      expiresAt: new Date(Date.now() - HOUR),
    });

    const ids = await store.usersWithStalePools(50);
    expect(ids.filter((x) => x === id)).toHaveLength(1);
  });
});
