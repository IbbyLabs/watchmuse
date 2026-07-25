import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '@watchmuse/core';
import type { FastifyInstance } from 'fastify';
import { createDb, type Db } from '../db/client.js';
import type { Mailer } from '../mail/mailer.js';
import { buildApp } from '../app.js';

const captured: Record<string, string> = {};
const mailer: Mailer = {
  async sendVerificationEmail(to, url) {
    captured[to] = url;
  },
  async verify() {
    return true;
  },
};

const testEnv = {
  NODE_ENV: 'test',
  APP_URL: 'http://localhost:8080',
  DATABASE_URL: 'pglite://memory',
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  SESSION_SECRET: 'y'.repeat(40),
  TMDB_API_KEY: 'tmdbkey',
  APP_NAME: 'Watchmuse',
  APP_VERSION: '0.1.0',
} as NodeJS.ProcessEnv;

let app: FastifyInstance;
let db: Db;
let config: AppConfig;

/** Register, verify and sign in a fresh user; returns their session cookie. */
async function signUp(username: string): Promise<string> {
  const email = `${username}@f.com`;
  await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, username, password: 'correcthorse' },
  });
  const token = new URL(captured[email]!).searchParams.get('token')!;
  await app.inject({ method: 'GET', url: `/api/auth/verify?token=${token}` });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: username, password: 'correcthorse' },
  });
  return login.cookies.find((c) => c.name === 'wm_session')!.value;
}

const as = (cookie: string, opts: Parameters<FastifyInstance['inject']>[0]) =>
  app.inject({ ...(opts as object), cookies: { wm_session: cookie } } as never);

beforeAll(async () => {
  config = loadConfig(testEnv);
  db = await createDb(config.DATABASE_URL);
  await db.migrate();
  app = buildApp({ config, db, mailer });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('sharing a setup', () => {
  let alice: string;
  let code: string;

  it('exports the exporter catalogs as a code', async () => {
    alice = await signUp('alice');
    await as(alice, {
      method: 'POST',
      url: '/api/catalogs',
      payload: {
        name: 'Great documentaries',
        mediaType: 'movie',
        filter: { genres: [99], minRating: 7 },
      },
    });
    const res = await as(alice, { method: 'GET', url: '/api/catalogs/share' });
    expect(res.statusCode).toBe(200);
    code = res.json().code;
    expect(code.startsWith('wm1.')).toBe(true);
  });

  it('carries no credential of any kind, even for a connected account', async () => {
    await as(alice, {
      method: 'POST',
      url: '/api/connections/mdblist',
      payload: { apiKey: 'super-secret-key-value' },
    }).catch(() => undefined);
    const fresh = (await as(alice, { method: 'GET', url: '/api/catalogs/share' })).json().code;
    const decoded = Buffer.from(fresh.slice(4), 'base64url');
    // The payload is gzipped; check the raw bytes as well as the inflated JSON
    // so a secret cannot hide in either representation.
    expect(decoded.toString('binary')).not.toContain('super-secret-key-value');
    const imported = await as(await signUp('probe'), {
      method: 'POST',
      url: '/api/catalogs/share',
      payload: { code: fresh },
    });
    expect(JSON.stringify(imported.json())).not.toContain('super-secret-key-value');
  });

  it('recreates the catalogs for a different user', async () => {
    const bob = await signUp('bob');
    const res = await as(bob, {
      method: 'POST',
      url: '/api/catalogs/share',
      payload: { code },
    });
    expect(res.statusCode).toBe(201);

    const mine = (await as(bob, { method: 'GET', url: '/api/catalogs' })).json() as Array<{
      name: string;
      filter?: { genres?: number[]; minRating?: number };
    }>;
    const imported = mine.find((c) => c.name === 'Great documentaries');
    expect(imported).toBeTruthy();
    expect(imported!.filter).toMatchObject({ genres: [99], minRating: 7 });
  });

  it('gives the importer their own catalog ids', async () => {
    const carol = await signUp('carol');
    await as(carol, { method: 'POST', url: '/api/catalogs/share', payload: { code } });
    const theirs = (await as(carol, { method: 'GET', url: '/api/catalogs' })).json() as Array<{
      id: string;
    }>;
    const alices = (await as(alice, { method: 'GET', url: '/api/catalogs' })).json() as Array<{
      id: string;
    }>;
    const shared = theirs.map((c) => c.id).filter((id) => alices.some((a) => a.id === id));
    expect(shared).toEqual([]);
  });

  it('adds to what the importer already has rather than replacing it', async () => {
    const dave = await signUp('dave');
    await as(dave, {
      method: 'POST',
      url: '/api/catalogs',
      payload: { name: 'My own row', mediaType: 'both' },
    });
    await as(dave, { method: 'POST', url: '/api/catalogs/share', payload: { code } });
    const names = ((await as(dave, { method: 'GET', url: '/api/catalogs' })).json() as Array<{
      name: string;
    }>).map((c) => c.name);
    expect(names).toContain('My own row');
    expect(names).toContain('Great documentaries');
  });

  it('refuses a code it cannot read, with a message a person can act on', async () => {
    const erin = await signUp('erin');
    const res = await as(erin, {
      method: 'POST',
      url: '/api/catalogs/share',
      payload: { code: 'wm1.garbage' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/could not be read/i);
  });

  it('requires a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/catalogs/share' });
    expect(res.statusCode).toBe(401);
  });
});
