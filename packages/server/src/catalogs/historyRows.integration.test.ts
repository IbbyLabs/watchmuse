import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { loadConfig, type AppConfig } from '@watchmuse/core';
import type { FastifyInstance } from 'fastify';
import { createDb, type Db } from '../db/client.js';
import { historyRows, users } from '../db/schema.js';
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
let cookie: string;
let userId: string;
let installId: string;

const authed = (opts: Parameters<FastifyInstance['inject']>[0]) =>
  app.inject({ ...(opts as object), cookies: { wm_session: cookie } } as never);

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
  const token = new URL(captured['e@f.com']!).searchParams.get('token')!;
  await app.inject({ method: 'GET', url: `/api/auth/verify?token=${token}` });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: 'erin', password: 'correcthorse' },
  });
  cookie = login.cookies.find((c) => c.name === 'wm_session')!.value;
  const [u] = await db.orm.select().from(users).where(eq(users.username, 'erin')).limit(1);
  userId = u!.id;

  const now = new Date();
  await db.orm.insert(historyRows).values({
    userId,
    payload: JSON.stringify({
      rewatch: [
        {
          tmdbId: 603,
          type: 'movie',
          title: 'The Matrix',
          score: 9,
          fromSeeds: [],
          sources: [],
          imdbId: 'tt0133093',
        },
      ],
      newSeason: [
        {
          tmdbId: 1399,
          type: 'series',
          title: 'Game of Thrones',
          score: 8,
          fromSeeds: [],
          sources: [],
          seedTitles: ['Season 4 is out'],
          imdbId: 'tt0944947',
        },
      ],
    }),
    builtAt: now,
    expiresAt: new Date(now.getTime() + 3_600_000),
  });

  installId = (await authed({ method: 'GET', url: '/api/catalogs/install' })).json().installId;
});

afterAll(async () => {
  await app.close();
  await db.close();
});

async function makeCatalog(name: string, type: string, mediaType: string): Promise<string> {
  const res = await authed({
    method: 'POST',
    url: '/api/catalogs',
    payload: { name, type, mediaType },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

const serve = async (id: string, type: string) =>
  app.inject({ method: 'GET', url: `/stremio/${installId}/catalog/${type}/${id}.json` });

describe('history-backed catalogs', () => {
  it('accepts a rewatch catalog', async () => {
    const id = await makeCatalog('Watch it again', 'rewatch', 'movie');
    const res = await serve(id, 'movie');
    expect(res.statusCode).toBe(200);
    expect(res.json().metas.map((m: { name: string }) => m.name)).toEqual(['The Matrix']);
  });

  it('serves a new-season catalog and names the season in the description', async () => {
    const id = await makeCatalog('New seasons', 'newseason', 'series');
    const metas = (await serve(id, 'series')).json().metas;
    expect(metas.map((m: { name: string }) => m.name)).toEqual(['Game of Thrones']);
    expect(metas[0].description).toContain('Season 4 is out');
  });

  it('keeps a rewatch row out of the series type', async () => {
    const id = await makeCatalog('Watch it again series', 'rewatch', 'series');
    expect((await serve(id, 'series')).json().metas).toEqual([]);
  });

  it('respects a title hidden from the catalog', async () => {
    const id = await makeCatalog('Hideable', 'rewatch', 'movie');
    await authed({
      method: 'POST',
      url: `/api/catalogs/${id}/hide`,
      payload: { tmdbId: 603, type: 'movie' },
    });
    expect((await serve(id, 'movie')).json().metas).toEqual([]);
  });

  it('round-trips the new types through a share code', async () => {
    const code = (await authed({ method: 'GET', url: '/api/catalogs/share' })).json().code;
    const decoded = Buffer.from(code.slice(4), 'base64url');
    expect(decoded.length).toBeGreaterThan(0);
    const res = await authed({ method: 'POST', url: '/api/catalogs/share', payload: { code } });
    expect(res.statusCode).toBe(201);
    const types = (res.json().catalogs as Array<{ type: string }>).map((c) => c.type);
    expect(types).toContain('rewatch');
    expect(types).toContain('newseason');
  });
});
