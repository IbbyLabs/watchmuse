import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { TmdbClient, createLogger, type AppConfig } from '@watchmuse/core';
import { requireAuth } from '../plugins/auth.js';
import type { WatchRegionStore } from '../watch/regionStore.js';

const log = createLogger('watch');

const regionBody = z.object({
  /** ISO 3166-1 alpha-2, or null to go back to following detection. */
  region: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, 'Region must be a two-letter country code')
    .transform((v) => v.toUpperCase())
    .nullable(),
});

const providerQuery = z.object({
  type: z.enum(['movie', 'series']).default('movie'),
});

/** Streaming region and the services available in it. */
export function watchRoutes(
  app: FastifyInstance,
  regions: WatchRegionStore,
  config: AppConfig,
): void {
  const auth = { preHandler: requireAuth };

  app.get('/api/watch/region', auth, async (request, reply) => {
    if (request.clientCountry) await regions.observe(request.user!.id, request.clientCountry);
    return reply.send(await regions.get(request.user!.id));
  });

  app.put('/api/watch/region', auth, async (request, reply) => {
    const parsed = regionBody.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'invalid_input', message: 'Region must be a two-letter country code' });
    }
    return reply.send(await regions.choose(request.user!.id, parsed.data.region));
  });

  app.get('/api/watch/regions', auth, async (_request, reply) => {
    if (!config.TMDB_API_KEY) return reply.send({ regions: [] });
    try {
      const tmdb = TmdbClient.shared({ apiKey: config.TMDB_API_KEY });
      return reply.send({ regions: await tmdb.watchRegions() });
    } catch (err) {
      log.warn({ err }, 'Could not list streaming regions');
      return reply
        .code(502)
        .send({ error: 'tmdb_unavailable', message: 'TMDB did not answer. Try again in a moment' });
    }
  });

  app.get('/api/watch/providers', auth, async (request, reply) => {
    if (!config.TMDB_API_KEY) {
      return reply.code(503).send({
        error: 'tmdb_not_configured',
        message: 'This server has no TMDB key, so streaming availability is unavailable',
      });
    }
    const parsed = providerQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'invalid_input', message: 'Type must be movie or series' });
    }
    const region = await regions.effective(request.user!.id);
    if (!region) {
      return reply.code(409).send({
        error: 'region_unknown',
        message: 'Choose a country before picking streaming services',
      });
    }

    try {
      const providers = await TmdbClient.shared({ apiKey: config.TMDB_API_KEY }).availableProviders(
        parsed.data.type,
        region,
      );
      return reply.send({ region, providers });
    } catch (err) {
      log.warn({ region, err }, 'Could not list streaming providers');
      return reply.code(502).send({
        error: 'tmdb_unavailable',
        message: 'TMDB did not answer. Try again in a moment',
      });
    }
  });
}
