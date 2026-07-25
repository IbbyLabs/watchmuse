import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../plugins/auth.js';
import { RecommendationService, TmdbNotConfigured } from '../reco/service.js';

const limitQuery = z.coerce.number().int().min(1).max(100).default(40);

/**
 * Debug/inspection routes for the recommendation engine (M1). These prove the
 * pipeline end to end before catalogs are built on top of it.
 */
export function recoRoutes(app: FastifyInstance, service: RecommendationService): void {
  const auth = { preHandler: requireAuth };

  app.get('/api/reco/watched', auth, async (request, reply) => {
    const watched = await service.watchedFor(request.user!.id);
    return reply.send({ count: watched.length, watched });
  });

  app.get('/api/reco/candidates', auth, async (request, reply) => {
    if (!service.tmdbConfigured) {
      return reply.code(503).send({ error: 'tmdb_not_configured', message: 'Set TMDB_API_KEY to generate recommendations.' });
    }
    const limit = limitQuery.parse((request.query as { limit?: string }).limit);
    try {
      const candidates = await service.candidatesFor(request.user!.id);
      return reply.send({ count: candidates.length, candidates: candidates.slice(0, limit) });
    } catch (err) {
      if (err instanceof TmdbNotConfigured) {
        return reply.code(503).send({ error: 'tmdb_not_configured' });
      }
      throw err;
    }
  });
}
