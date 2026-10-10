import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '@watchmuse/core';
import type { Db } from '../db/client.js';
import type { DrainState } from '../shutdown.js';

export function healthRoutes(
  app: FastifyInstance,
  db: Db,
  config: AppConfig,
  drain: DrainState,
): void {
  app.get('/api/health', async (_req, reply) => {
    let dbOk = true;
    try {
      await db.orm.execute(sql`select 1`);
    } catch {
      dbOk = false;
    }
    const status = dbOk ? 'ok' : 'degraded';
    return reply.code(dbOk ? 200 : 503).send({
      status,
      version: config.APP_VERSION,
      db: dbOk,
    });
  });

  // Readiness only; /api/health stays 200 while draining for the container healthcheck.
  app.get('/api/ready', async (_req, reply) => {
    if (drain.draining) return reply.code(503).send({ status: 'draining' });
    return reply.send({ status: 'ready' });
  });
}
