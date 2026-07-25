import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { renderPosterUrl, validateArtworkTemplate } from '@watchmuse/core';
import { requireAuth } from '../plugins/auth.js';
import type { ArtworkConfigStore } from '../artwork/store.js';

const configBody = z.object({
  template: z.string().trim().min(1).max(500),
});

/** The Matrix — a title with both an imdb and tmdb id, for template previews. */
const SAMPLE = { imdbId: 'tt0133093', tmdbId: 603, type: 'movie' as const };

/** Custom artwork source management (status / set / preview / clear). */
export function artworkRoutes(app: FastifyInstance, store: ArtworkConfigStore): void {
  const auth = { preHandler: requireAuth };

  app.get('/api/artwork', auth, async (request, reply) => {
    const cfg = await store.get(request.user!.id);
    // The template is editable, so echo it back to its owner (encrypted at rest).
    return reply.send({ configured: Boolean(cfg), template: cfg?.template ?? null });
  });

  app.put('/api/artwork', auth, async (request, reply) => {
    const parsed = configBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input', issues: parsed.error.flatten() });
    const template = parsed.data.template.trim();
    const invalid = validateArtworkTemplate(template);
    if (invalid) return reply.code(400).send({ error: 'invalid_template', reason: invalid.code, detail: invalid.detail });
    await store.set(request.user!.id, { template });
    return reply.send({ configured: true, template });
  });

  app.post('/api/artwork/test', auth, async (request, reply) => {
    const cfg = await store.get(request.user!.id);
    if (!cfg) return reply.code(400).send({ ok: false, error: 'not_configured' });
    // Render a sample URL for the client to preview. We never fetch it here — the
    // template is a user-supplied URL, so fetching server-side would be an SSRF.
    const sample = renderPosterUrl(cfg.template, SAMPLE);
    return reply.send({ ok: true, sample });
  });

  app.delete('/api/artwork', auth, async (request, reply) => {
    await store.clear(request.user!.id);
    return reply.send({ configured: false });
  });
}
