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
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  SESSION_SECRET: 'z'.repeat(40),
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

const pool = [
  {
    tmdbId: 603,
    type: 'movie',
    score: 30,
    fromSeeds: [1],
    sources: ['tmdb-similar'],
    title: 'The Matrix',
    year: 1999,
    posterPath: '/matrix.jpg',
    genreIds: [878],
    imdbId: 'tt0133093',
  },
  {
    // No imdb id -> {imdb} templates can't key it, so it must fall back to TMDB.
    tmdbId: 1234,
    type: 'movie',
    score: 20,
    fromSeeds: [1],
    sources: ['tmdb-rec'],
    title: 'Untitled',
    year: 2020,
    posterPath: '/untitled.jpg',
    genreIds: [878],
    imdbId: null,
  },
];

const authed = (opts: Parameters<FastifyInstance['inject']>[0]) =>
  app.inject({ ...(opts as object), cookies: { wm_session: cookie } } as never);

beforeAll(async () => {
  config = loadConfig(testEnv);
  db = await createDb(config.DATABASE_URL);
  await db.migrate();
  app = buildApp({ config, db, mailer });
  await app.ready();

  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'a@b.com', username: 'art', password: 'correcthorse' } });
  const token = new URL(captured.verifyUrl!).searchParams.get('token')!;
  await app.inject({ method: 'GET', url: `/api/auth/verify?token=${token}` });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { identifier: 'art', password: 'correcthorse' } });
  cookie = login.cookies.find((c) => c.name === 'wm_session')!.value;

  const [u] = await db.orm.select().from(users).where(eq(users.username, 'art')).limit(1);
  const now = new Date();
  await db.orm.insert(candidatePools).values({
    userId: u!.id,
    payload: JSON.stringify(pool),
    historyHash: 'test',
    builtAt: now,
    expiresAt: new Date(now.getTime() + 3_600_000),
  });

  const created = await authed({ method: 'POST', url: '/api/catalogs', payload: { name: 'Sci-Fi', mediaType: 'movie', filter: { genres: [878] } } });
  catalogId = created.json().id;
  installId = (await authed({ method: 'GET', url: '/api/catalogs/install' })).json().installId;
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('Custom artwork', () => {
  it('reports no custom source by default', async () => {
    const res = await authed({ method: 'GET', url: '/api/artwork' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ configured: false, template: null });
  });

  it('rejects an invalid template', async () => {
    const res = await authed({ method: 'PUT', url: '/api/artwork', payload: { template: 'http://x/poster.jpg' } });
    expect(res.statusCode).toBe(400);
    // http (not https) and no placeholder — the first failure wins.
    expect(res.json().error).toBe('invalid_template');
  });

  it('saves a valid template and echoes it back to its owner', async () => {
    const set = await authed({ method: 'PUT', url: '/api/artwork', payload: { template: 'https://art.test/poster/{id}.jpg' } });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual({ configured: true, template: 'https://art.test/poster/{id}.jpg' });

    const got = await authed({ method: 'GET', url: '/api/artwork' });
    expect(got.json()).toEqual({ configured: true, template: 'https://art.test/poster/{id}.jpg' });
  });

  it('builds a sample preview URL without fetching it', async () => {
    const res = await authed({ method: 'POST', url: '/api/artwork/test' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, sample: 'https://art.test/poster/tt0133093.jpg' });
  });

  it('serves catalog posters from the custom source', async () => {
    const res = await app.inject({ method: 'GET', url: `/stremio/${installId}/catalog/movie/${catalogId}.json` });
    const { metas } = res.json();
    const matrix = metas.find((m: { id: string }) => m.id === 'tt0133093');
    expect(matrix.poster).toBe('https://art.test/poster/tt0133093.jpg');
  });

  it('falls back to TMDB when the template needs an id the title lacks', async () => {
    await authed({ method: 'PUT', url: '/api/artwork', payload: { template: 'https://art.test/imdb/{imdb}.jpg' } });
    const res = await app.inject({ method: 'GET', url: `/stremio/${installId}/catalog/movie/${catalogId}.json` });
    const { metas } = res.json();
    const matrix = metas.find((m: { id: string }) => m.id === 'tt0133093');
    const untitled = metas.find((m: { id: string }) => m.id === 'tmdb:1234');
    expect(matrix.poster).toBe('https://art.test/imdb/tt0133093.jpg');
    expect(untitled.poster).toBe('https://image.tmdb.org/t/p/w500/untitled.jpg');
  });

  it('clears the custom source, restoring TMDB posters', async () => {
    const del = await authed({ method: 'DELETE', url: '/api/artwork' });
    expect(del.json()).toEqual({ configured: false });
    const res = await app.inject({ method: 'GET', url: `/stremio/${installId}/catalog/movie/${catalogId}.json` });
    const { metas } = res.json();
    const matrix = metas.find((m: { id: string }) => m.id === 'tt0133093');
    expect(matrix.poster).toBe('https://image.tmdb.org/t/p/w500/matrix.jpg');
  });
});
