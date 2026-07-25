import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { loadConfig, type AppConfig } from '@watchmuse/core';
import type { FastifyInstance } from 'fastify';
import { createDb, type Db } from '../db/client.js';
import { candidatePools, users } from '../db/schema.js';
import type { Mailer } from '../mail/mailer.js';
import { buildApp } from '../app.js';

const captured: { verifyUrl?: string } = {};
const mailer: Mailer = {
  async sendVerificationEmail(_to, url) {
    captured.verifyUrl = url;
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
let cookie: string;
let installId: string;
let catalogId: string;

/** Twenty sci-fi movies with strictly descending scores. */
const pool = Array.from({ length: 20 }, (_, i) => ({
  tmdbId: 1000 + i,
  type: 'movie' as const,
  score: 100 - i,
  fromSeeds: [],
  sources: ['tmdb-similar'],
  title: `Title ${i}`,
  year: 2000 + i,
  genreIds: [878],
  imdbId: `tt${String(1000 + i).padStart(7, '0')}`,
}));

beforeAll(async () => {
  config = loadConfig(testEnv);
  db = await createDb(config.DATABASE_URL);
  await db.migrate();
  app = buildApp({ config, db, mailer });
  await app.ready();

  await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: 'e@f.com', username: 'erin', password: 'correcthorse' },
  });
  const token = new URL(captured.verifyUrl!).searchParams.get('token')!;
  await app.inject({ method: 'GET', url: `/api/auth/verify?token=${token}` });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: 'erin', password: 'correcthorse' },
  });
  cookie = login.cookies.find((c) => c.name === 'wm_session')!.value;

  const [u] = await db.orm.select().from(users).where(eq(users.username, 'erin')).limit(1);
  const now = new Date();
  await db.orm.insert(candidatePools).values({
    userId: u!.id,
    payload: JSON.stringify(pool),
    historyHash: 'test',
    builtAt: now,
    expiresAt: new Date(now.getTime() + 3_600_000),
  });

  const created = await app.inject({
    method: 'POST',
    url: '/api/catalogs',
    cookies: { wm_session: cookie },
    payload: { name: 'Sci-Fi', mediaType: 'movie', filter: { genres: [878] } },
  });
  catalogId = created.json().id;
  installId = (
    await app.inject({
      method: 'GET',
      url: '/api/catalogs/install',
      cookies: { wm_session: cookie },
    })
  ).json().installId;
});

afterAll(async () => {
  await app.close();
  await db.close();
});

const serve = async (): Promise<string[]> => {
  const res = await app.inject({
    method: 'GET',
    url: `/stremio/${installId}/catalog/movie/${catalogId}.json`,
  });
  expect(res.statusCode).toBe(200);
  return res.json().metas.map((m: { name: string }) => m.name);
};

describe('daily row freshness', () => {
  it('keeps the strongest picks at the top', async () => {
    expect((await serve()).slice(0, 3)).toEqual(['Title 0', 'Title 1', 'Title 2']);
  });

  it('does not serve the tail in plain score order', async () => {
    const names = await serve();
    const byScore = pool.map((p) => p.title);
    expect(names.slice(3)).not.toEqual(byScore.slice(3));
  });

  it('serves the same order twice in a row', async () => {
    expect(await serve()).toEqual(await serve());
  });

  it('still serves every matching title exactly once', async () => {
    const names = await serve();
    expect([...names].sort()).toEqual([...pool.map((p) => p.title)].sort());
  });
});
