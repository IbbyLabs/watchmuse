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
let userId: string;

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
    voteAverage: 8.2,
    genreIds: [878],
    imdbId: 'tt0133093',
  },
  {
    tmdbId: 1399,
    type: 'series',
    score: 25,
    fromSeeds: [2],
    sources: ['tmdb-rec'],
    title: 'Game of Thrones',
    year: 2011,
    posterPath: '/got.jpg',
    voteAverage: 8.4,
    genreIds: [10765],
    imdbId: 'tt0944947',
  },
];

beforeAll(async () => {
  config = loadConfig(testEnv);
  db = await createDb(config.DATABASE_URL);
  await db.migrate();
  app = buildApp({ config, db, mailer });
  await app.ready();

  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'e@f.com', username: 'erin', password: 'correcthorse' } });
  const token = new URL(captured.verifyUrl!).searchParams.get('token')!;
  await app.inject({ method: 'GET', url: `/api/auth/verify?token=${token}` });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { identifier: 'erin', password: 'correcthorse' } });
  cookie = login.cookies.find((c) => c.name === 'wm_session')!.value;

  const [u] = await db.orm.select().from(users).where(eq(users.username, 'erin')).limit(1);
  userId = u!.id;

  // Seed the candidate pool directly (skips the expensive live build).
  await seedPool();
});

/** Seed (or re-seed) the user's candidate pool — a manual refresh with no
 *  connections rebuilds it to empty, so tests that follow one re-seed here. */
async function seedPool(): Promise<void> {
  const now = new Date();
  const values = {
    userId,
    payload: JSON.stringify(pool),
    historyHash: 'test',
    builtAt: now,
    expiresAt: new Date(now.getTime() + 3_600_000),
  };
  await db.orm.insert(candidatePools).values(values).onConflictDoUpdate({ target: candidatePools.userId, set: values });
}

afterAll(async () => {
  await app.close();
  await db.close();
});

const authed = (opts: Parameters<FastifyInstance['inject']>[0]) =>
  app.inject({ ...(opts as object), cookies: { wm_session: cookie } } as never);

/** Remove every catalog so a describe block starts from a known-empty board. */
async function clearCatalogs(): Promise<void> {
  const list = (await authed({ method: 'GET', url: '/api/catalogs' })).json() as Array<{ id: string }>;
  for (const c of list) await authed({ method: 'DELETE', url: `/api/catalogs/${c.id}` });
}

describe('Stremio serving', () => {
  let installId: string;
  let movieCatalogId: string;

  it('creates a catalog and issues an install id', async () => {
    const created = await authed({
      method: 'POST',
      url: '/api/catalogs',
      payload: { name: 'Sci-Fi Movies', mediaType: 'movie', filter: { genres: [878] } },
    });
    expect(created.statusCode).toBe(201);
    movieCatalogId = created.json().id;

    const install = await authed({ method: 'GET', url: '/api/catalogs/install' });
    expect(install.statusCode).toBe(200);
    installId = install.json().installId;
    expect(install.json().manifestUrl).toContain(`/stremio/${installId}/manifest.json`);
  });

  it('serves a manifest listing the catalog', async () => {
    const res = await app.inject({ method: 'GET', url: `/stremio/${installId}/manifest.json` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    const manifest = res.json();
    expect(manifest.resources).toContain('catalog');
    const ours = manifest.catalogs.find((c: { id: string; type: string }) => c.id === movieCatalogId && c.type === 'movie');
    expect(ours).toBeTruthy();
  });

  it('serves catalog metas from the cached pool, IMDB-keyed', async () => {
    const res = await app.inject({ method: 'GET', url: `/stremio/${installId}/catalog/movie/${movieCatalogId}.json` });
    expect(res.statusCode).toBe(200);
    const { metas } = res.json();
    // Sci-Fi movie filter -> The Matrix only (GoT is a series and excluded by type)
    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({
      id: 'tt0133093',
      type: 'movie',
      name: 'The Matrix',
      poster: 'https://image.tmdb.org/t/p/w500/matrix.jpg',
    });
  });

  it('returns 404 for an unknown install', async () => {
    const res = await app.inject({ method: 'GET', url: '/stremio/nope/manifest.json' });
    expect(res.statusCode).toBe(404);
  });
});

describe('Catalog viewer', () => {
  let catalogId: string;
  let installId: string;

  beforeAll(clearCatalogs);

  it('previews a catalog from the cached pool', async () => {
    const created = await authed({ method: 'POST', url: '/api/catalogs', payload: { name: 'Everything', mediaType: 'both' } });
    catalogId = created.json().id;
    installId = (await authed({ method: 'GET', url: '/api/catalogs/install' })).json().installId;

    const res = await authed({ method: 'GET', url: `/api/catalogs/${catalogId}/preview` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ready');
    expect(body.items.map((i: { tmdbId: number }) => i.tmdbId).sort((a: number, b: number) => a - b)).toEqual([603, 1399]);
    expect(body.items.find((i: { tmdbId: number }) => i.tmdbId === 603)).toMatchObject({
      title: 'The Matrix',
      poster: 'https://image.tmdb.org/t/p/w500/matrix.jpg',
    });
  });

  it('hides a title so it drops from the preview and the Stremio feed', async () => {
    const hide = await authed({ method: 'POST', url: `/api/catalogs/${catalogId}/hide`, payload: { tmdbId: 603, type: 'movie' } });
    expect(hide.statusCode).toBe(200);

    const preview = await authed({ method: 'GET', url: `/api/catalogs/${catalogId}/preview` });
    expect(preview.json().items.map((i: { tmdbId: number }) => i.tmdbId)).toEqual([1399]);
    // The hidden title is surfaced separately so the UI can offer a restore.
    expect(preview.json().hidden.map((i: { tmdbId: number }) => i.tmdbId)).toEqual([603]);

    const feed = await app.inject({ method: 'GET', url: `/stremio/${installId}/catalog/movie/${catalogId}.json` });
    expect(feed.json().metas).toHaveLength(0);
  });

  it('un-hides a title so it returns', async () => {
    const show = await authed({ method: 'POST', url: `/api/catalogs/${catalogId}/unhide`, payload: { tmdbId: 603, type: 'movie' } });
    expect(show.statusCode).toBe(200);
    const preview = await authed({ method: 'GET', url: `/api/catalogs/${catalogId}/preview` });
    expect(preview.json().items.map((i: { tmdbId: number }) => i.tmdbId).sort((a: number, b: number) => a - b)).toEqual([603, 1399]);
    expect(preview.json().hidden).toEqual([]);
  });

  it("won't hide for a catalog the user doesn't own", async () => {
    const res = await authed({ method: 'POST', url: `/api/catalogs/does-not-exist/hide`, payload: { tmdbId: 1, type: 'movie' } });
    expect(res.statusCode).toBe(404);
  });

  it('rate-limits refresh after the per-hour cap', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      codes.push((await authed({ method: 'POST', url: '/api/catalogs/refresh' })).statusCode);
    }
    expect(codes.filter((c) => c === 200)).toHaveLength(5);
    expect(codes[5]).toBe(429);
  });
});

describe('Cross-catalog dedupe', () => {
  let installId: string;
  let topId: string;
  let bottomId: string;

  const movieMetas = (id: string) =>
    app.inject({ method: 'GET', url: `/stremio/${installId}/catalog/movie/${id}.json` }).then((r) => r.json().metas.map((m: { name: string }) => m.name));

  beforeAll(async () => {
    await clearCatalogs();
    await seedPool(); // an earlier refresh test rebuilds the pool to empty; restore it
    installId = (await authed({ method: 'GET', url: '/api/catalogs/install' })).json().installId;
    // Two overlapping movie catalogs; both would match The Matrix on their own.
    topId = (await authed({ method: 'POST', url: '/api/catalogs', payload: { name: 'Top', mediaType: 'movie', sortOrder: 0 } })).json().id;
    bottomId = (await authed({ method: 'POST', url: '/api/catalogs', payload: { name: 'Bottom', mediaType: 'movie', sortOrder: 1 } })).json().id;
  });

  it('serves a shared title in the higher-priority catalog only', async () => {
    expect(await movieMetas(topId)).toEqual(['The Matrix']);
    // The lower-ranked catalog drops it rather than repeating the row.
    expect(await movieMetas(bottomId)).toEqual([]);
  });

  it('reflects the same dedupe in the in-app preview', async () => {
    const preview = (await authed({ method: 'GET', url: `/api/catalogs/${bottomId}/preview` })).json();
    expect(preview.items).toEqual([]);
    expect(preview.hidden).toEqual([]); // not user-hidden, just claimed elsewhere
  });

  it('backfills into the lower catalog once the higher one is disabled', async () => {
    await authed({ method: 'PATCH', url: `/api/catalogs/${topId}`, payload: { enabled: false } });
    expect(await movieMetas(bottomId)).toEqual(['The Matrix']);
    await authed({ method: 'PATCH', url: `/api/catalogs/${topId}`, payload: { enabled: true } });
  });
});
