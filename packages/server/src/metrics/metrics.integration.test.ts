import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@watchmuse/core';
import type { FastifyInstance } from 'fastify';
import { createDb, type Db } from '../db/client.js';
import type { Mailer } from '../mail/mailer.js';
import { buildApp } from '../app.js';

const mailer: Mailer = {
  async sendVerificationEmail() {},
  async verify() {
    return true;
  },
};

const baseEnv = {
  NODE_ENV: 'test',
  APP_URL: 'http://localhost:8080',
  DATABASE_URL: 'pglite://memory',
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  SESSION_SECRET: 'y'.repeat(40),
  APP_NAME: 'Watchmuse',
  APP_VERSION: '0.1.0',
} as NodeJS.ProcessEnv;

async function appWith(extra: NodeJS.ProcessEnv): Promise<{ app: FastifyInstance; db: Db }> {
  const config = loadConfig({ ...baseEnv, ...extra });
  const db = await createDb(config.DATABASE_URL);
  await db.migrate();
  const app = buildApp({ config, db, mailer });
  await app.ready();
  return { app, db };
}

describe('metrics endpoint', () => {
  let open: { app: FastifyInstance; db: Db };
  let guarded: { app: FastifyInstance; db: Db };
  let off: { app: FastifyInstance; db: Db };

  beforeAll(async () => {
    open = await appWith({ METRICS_ENABLED: 'true' });
    guarded = await appWith({ METRICS_ENABLED: 'true', METRICS_TOKEN: 'sekret' });
    off = await appWith({});
  });

  afterAll(async () => {
    for (const it of [open, guarded, off]) {
      await it.app.close();
      await it.db.close();
    }
  });

  it('publishes nothing unless explicitly enabled', async () => {
    // The path falls through to the SPA, so the check is that no series are
    // served, not that the request 404s.
    const res = await off.app.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).not.toContain('watchmuse_');
    expect(res.headers['content-type']).not.toContain('text/plain');
  });

  it('serves Prometheus text when enabled', async () => {
    const res = await open.app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('watchmuse_http_requests_total');
  });

  it('counts requests by route pattern, not by raw path', async () => {
    await open.app.inject({ method: 'GET', url: '/api/health' });
    const body = (await open.app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(body).toContain('route="/api/health"');
  });

  it('buckets unmatched paths together so probes cannot grow the label set', async () => {
    await open.app.inject({ method: 'GET', url: '/api/nope-aaa' });
    await open.app.inject({ method: 'GET', url: '/api/nope-bbb' });
    const body = (await open.app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(body).toContain('/api/unmatched');
    expect(body).not.toContain('nope-aaa');
  });

  it('refuses a request with no token when one is configured', async () => {
    const res = await guarded.app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(401);
  });

  it('accepts the configured bearer token', async () => {
    const res = await guarded.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer sekret' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('refuses a wrong token', async () => {
    const res = await guarded.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer wrong' },
    });
    expect(res.statusCode).toBe(401);
  });
});
