import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
  TRAKT_CLIENT_ID: 'tcid',
  TRAKT_CLIENT_SECRET: 'tsec',
  APP_NAME: 'Watchmuse',
  APP_VERSION: '0.1.0',
} as NodeJS.ProcessEnv;

let app: FastifyInstance;
let db: Db;
let config: AppConfig;
let cookie: string;
let catalogId: string;

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

  catalogId = (
    await authed({
      method: 'POST',
      url: '/api/catalogs',
      payload: { name: 'Picks', mediaType: 'movie' },
    })
  ).json().id;
});

afterEach(() => vi.unstubAllGlobals());

afterAll(async () => {
  await app.close();
  await db.close();
});

const hide = () =>
  authed({
    method: 'POST',
    url: `/api/catalogs/${catalogId}/hide`,
    payload: { tmdbId: 603, type: 'movie' },
  });

/** Give the fire-and-forget mirror a moment to run (or not). */
const settle = () => new Promise((r) => setTimeout(r, 60));

describe('mirroring a dismissal to Trakt', () => {
  it('is off until the user turns it on', async () => {
    const res = await authed({ method: 'GET', url: '/api/catalogs/trakt-hides' });
    expect(res.json()).toEqual({ enabled: false });
  });

  it('sends nothing to Trakt while it is off', async () => {
    const fetchMock = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await hide()).statusCode).toBe(200);
    await settle();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/users/hidden'))).toBe(false);
  });

  it('can be turned on and reports back as on', async () => {
    const res = await authed({
      method: 'PUT',
      url: '/api/catalogs/trakt-hides',
      payload: { enabled: true },
    });
    expect(res.json()).toEqual({ enabled: true });
    expect((await authed({ method: 'GET', url: '/api/catalogs/trakt-hides' })).json()).toEqual({
      enabled: true,
    });
  });

  it('still hides locally when the user has no Trakt connected', async () => {
    await authed({
      method: 'POST',
      url: `/api/catalogs/${catalogId}/unhide`,
      payload: { tmdbId: 603, type: 'movie' },
    });
    expect((await hide()).statusCode).toBe(200);
  });

  it('does not fail the dismissal when Trakt is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('trakt down');
      }),
    );
    await authed({
      method: 'POST',
      url: `/api/catalogs/${catalogId}/unhide`,
      payload: { tmdbId: 603, type: 'movie' },
    });
    const res = await hide();
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('hidden');
  });

  it('rejects a non-boolean setting', async () => {
    const res = await authed({
      method: 'PUT',
      url: '/api/catalogs/trakt-hides',
      payload: { enabled: 'yes please' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('requires a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/catalogs/trakt-hides' })).statusCode).toBe(
      401,
    );
  });
});
