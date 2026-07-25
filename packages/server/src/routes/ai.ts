import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { LlmClient, UnsafeUrlError, assertSafeUrl, type AppConfig } from '@watchmuse/core';
import { requireAuth } from '../plugins/auth.js';
import type { LlmConfigStore } from '../ai/store.js';

const configBody = z.object({
  baseUrl: z.string().url().max(300),
  model: z.string().trim().min(1).max(120),
  apiKey: z.string().trim().min(1).max(400),
});

/** BYO-key LLM config management (status / set / test / clear). */
export function aiRoutes(app: FastifyInstance, store: LlmConfigStore, config: AppConfig): void {
  const auth = { preHandler: requireAuth };
  const allowPrivateHost = config.AI_ALLOW_PRIVATE_BASE_URL;

  app.get('/api/ai', auth, async (request, reply) => {
    const cfg = await store.get(request.user!.id);
    // Never echo the API key back.
    return reply.send({
      configured: Boolean(cfg),
      baseUrl: cfg?.baseUrl ?? null,
      model: cfg?.model ?? null,
    });
  });

  app.put('/api/ai', auth, async (request, reply) => {
    const parsed = configBody.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'invalid_input', issues: parsed.error.flatten() });
    // Rejected here as well as at call time, so the user gets told immediately
    // rather than saving something that will only ever fail.
    try {
      await assertSafeUrl(parsed.data.baseUrl, { allowPrivate: allowPrivateHost });
    } catch (err) {
      if (!(err instanceof UnsafeUrlError)) throw err;
      return reply.code(400).send({ error: 'unsafe_base_url', message: err.message });
    }
    await store.set(request.user!.id, parsed.data);
    return reply.send({ configured: true, baseUrl: parsed.data.baseUrl, model: parsed.data.model });
  });

  app.post('/api/ai/test', auth, async (request, reply) => {
    const cfg = await store.get(request.user!.id);
    if (!cfg) return reply.code(400).send({ ok: false, error: 'not_configured' });
    try {
      const out = await new LlmClient({ ...cfg, allowPrivateHost }).complete(
        'You are a test.',
        'Reply with the single word OK.',
      );
      return reply.send({ ok: true, sample: out.slice(0, 80) });
    } catch (err) {
      if (err instanceof UnsafeUrlError) {
        return reply.code(400).send({ ok: false, error: 'unsafe_base_url', message: err.message });
      }
      // Deliberately vague: the detail of why someone else's host did not answer
      // is exactly what makes this endpoint useful as a network scanner.
      return reply.code(502).send({ ok: false, error: 'The endpoint did not answer as expected' });
    }
  });

  app.delete('/api/ai', auth, async (request, reply) => {
    await store.clear(request.user!.id);
    return reply.send({ configured: false });
  });
}
