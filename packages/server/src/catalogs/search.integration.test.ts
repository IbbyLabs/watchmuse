import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { loadConfig, type AppConfig } from '@watchmuse/core';
import type { FastifyInstance } from 'fastify';
import { createDb, type Db } from '../db/client.js';
import { candidatePools, users } from '../db/schema.js';
import type { Mailer } from '../mail/mailer.js';
import { buildApp } from '../app.js';
import { clearSearchCache } from './search.js';

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
let userId: string;
let installId: string;

/** An animation-heavy pool, so taste has something to say about the results. */
const pool = [
  {
    tmdbId: 129,
    type: 'movie',
    score: 40,
    fromSeeds: [1],
    sources: ['tmdb-similar'],
    title: 'Spirited Away',
    year: 2001,
    genreIds: [16],
  },
];

/** TMDB search payload for a `/search/movie` call. */
function tmdbPage(results: Array<Record<string, unknown>>): Response {
  return new Response(JSON.stringify({ page: 1, results, total_pages: 1, total_results: results.length }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

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
  userId = u!.id;

  const now = new Date();
  await db.orm.insert(candidatePools).values({
    userId,
    payload: JSON.stringify(pool),
    historyHash: 'test',
    builtAt: now,
    expiresAt: new Date(now.getTime() + 3_600_000),
  });

  const install = await app.inject({
    method: 'GET',
    url: '/api/catalogs/install',
    cookies: { wm_session: cookie },
  });
  installId = install.json().installId;
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearSearchCache();
});

afterAll(async () => {
  await app.close();
  await db.close();
});

const searchUrl = (type: string, query: string) =>
  `/stremio/${installId}/catalog/${type}/watchmuse-search/search=${encodeURIComponent(query)}.json`;

describe('Stremio search', () => {
  it('advertises a search catalog for both types, kept off the Discover board', async () => {
    const manifest = (
      await app.inject({ method: 'GET', url: `/stremio/${installId}/manifest.json` })
    ).json();
    const search = manifest.catalogs.filter((c: { id: string }) => c.id === 'watchmuse-search');
    expect(search.map((c: { type: string }) => c.type).sort()).toEqual(['movie', 'series']);
    // isRequired keeps it out of Discover; without it the board grows a dead row.
    for (const c of search) {
      expect(c.extra).toEqual([{ name: 'search', isRequired: true }]);
    }
  });

  it('returns TMDB hits for a query', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        tmdbPage([
          { id: 329865, title: 'Arrival', release_date: '2016-11-10', genre_ids: [878] },
        ]),
      ),
    );
    const res = await app.inject({ method: 'GET', url: searchUrl('movie', 'Arrival') });
    expect(res.statusCode).toBe(200);
    expect(res.json().metas).toHaveLength(1);
    expect(res.json().metas[0].name).toBe('Arrival');
  });

  it('sends the query to TMDB with adult results off', async () => {
    const fetchMock = vi.fn(async () => tmdbPage([]));
    vi.stubGlobal('fetch', fetchMock);
    await app.inject({ method: 'GET', url: searchUrl('movie', 'Arrival') });

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toContain('/search/movie');
    expect(urls[0]).toContain('query=Arrival');
    expect(urls[0]).toContain('include_adult=false');
  });

  it('maps the series type to TMDB tv', async () => {
    const fetchMock = vi.fn(async () => tmdbPage([]));
    vi.stubGlobal('fetch', fetchMock);
    await app.inject({ method: 'GET', url: searchUrl('series', 'Severance') });
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/search/tv');
  });

  it('ranks a result matching the user taste above one that does not', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        tmdbPage([
          { id: 1, title: 'Ghost Squad', genre_ids: [28] },
          { id: 2, title: 'Ghost Cat', genre_ids: [16] },
        ]),
      ),
    );
    const metas = (await app.inject({ method: 'GET', url: searchUrl('movie', 'Ghost') })).json().metas;
    // The pool is animation; the animated hit leads despite TMDB ordering it second.
    expect(metas[0].name).toBe('Ghost Cat');
  });

  it('serves nothing rather than erroring when the query is blank', async () => {
    const fetchMock = vi.fn(async () => tmdbPage([]));
    vi.stubGlobal('fetch', fetchMock);
    const res = await app.inject({
      method: 'GET',
      url: `/stremio/${installId}/catalog/movie/watchmuse-search/search=.json`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().metas).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('survives a TMDB failure with a partial answer instead of a 500', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        if (call === 1) return tmdbPage([{ id: 7, title: 'Found' }]);
        throw new Error('network down');
      }),
    );
    const res = await app.inject({ method: 'GET', url: searchUrl('movie', 'Found') });
    expect(res.statusCode).toBe(200);
    expect(res.json().metas[0].name).toBe('Found');
  });

  it('reuses a cached search rather than calling TMDB again', async () => {
    const fetchMock = vi.fn(async () => tmdbPage([{ id: 9, title: 'Cached' }]));
    vi.stubGlobal('fetch', fetchMock);
    await app.inject({ method: 'GET', url: searchUrl('movie', 'Cached') });
    const firstCount = fetchMock.mock.calls.length;
    await app.inject({ method: 'GET', url: searchUrl('movie', 'Cached') });
    expect(fetchMock.mock.calls.length).toBe(firstCount);
  });
});
