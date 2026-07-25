import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  decodeShare,
  diagnoseCatalog,
  encodeShare,
  InvalidShareCode,
  recItemKey,
  TmdbClient,
  validateArtworkTemplate,
  type AppConfig,
  type Candidate,
} from '@watchmuse/core';
import { requireAuth } from '../plugins/auth.js';
import type { RateLimiter } from '../plugins/rateLimit.js';
import type { CatalogService } from '../catalogs/service.js';
import type { PoolService } from '../catalogs/pool.js';
import type { NlCatalogService } from '../catalogs/nl.js';
import { claimedByHigherPriority, resolveMatches } from '../catalogs/resolve.js';
import type { ArtworkConfigStore } from '../artwork/store.js';
import type { WatchRegionStore } from '../watch/regionStore.js';
import type { TraktHideMirror } from '../catalogs/traktHides.js';

const providerId = z.enum(['trakt', 'simkl', 'pmdb', 'mdblist', 'letterboxd', 'stremio']);
const filterConfig = z
  .object({
    genres: z.array(z.number().int()).optional(),
    yearMin: z.number().int().optional(),
    yearMax: z.number().int().optional(),
    minRating: z.number().min(0).max(10).optional(),
    /** TMDB streaming-service ids; empty means availability is ignored. */
    providers: z.array(z.number().int().positive()).max(50).optional(),
    sort: z.enum(['score', 'popularity', 'rating', 'year']).optional(),
  })
  .optional();

const catalogBody = z.object({
  name: z.string().trim().min(1).max(80),
  type: z.enum(['filter', 'nl', 'rewatch', 'newseason']).optional(),
  mediaType: z.enum(['movie', 'series', 'both']).optional(),
  filter: filterConfig,
  prompt: z.string().max(500).optional(),
  sources: z.array(providerId).optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

const patchBody = catalogBody.partial();
const hideBody = z.object({ tmdbId: z.number().int(), type: z.enum(['movie', 'series']) });
const shareBody = z.object({ code: z.string().min(1).max(20_000) });

const PREVIEW_MAX = 100;

interface PreviewItem {
  tmdbId: number;
  type: 'movie' | 'series';
  title: string;
  year?: number;
  poster: string | null;
}

function toPreview(c: Candidate): PreviewItem {
  return {
    tmdbId: c.tmdbId,
    type: c.type,
    title: c.title ?? `#${c.tmdbId}`,
    year: c.year,
    poster: TmdbClient.posterUrl(c.posterPath),
  };
}

export function catalogRoutes(
  app: FastifyInstance,
  service: CatalogService,
  pools: PoolService,
  nl: NlCatalogService,
  limiter: RateLimiter,
  config: AppConfig,
  artworkStore: ArtworkConfigStore,
  regions: WatchRegionStore,
  traktHides: TraktHideMirror,
): void {
  const auth = { preHandler: requireAuth };

  app.get('/api/catalogs', auth, async (request, reply) => {
    return reply.send(await service.list(request.user!.id));
  });

  app.get('/api/catalogs/share', auth, async (request, reply) => {
    const userId = request.user!.id;
    const [catalogs, artwork, region] = await Promise.all([
      service.list(userId),
      artworkStore.get(userId),
      regions.get(userId),
    ]);
    return reply.send({
      code: encodeShare({
        catalogs,
        artworkTemplate: artwork?.template,
        // Only a deliberately pinned country travels. The detected one is a
        // fact about where the exporter happened to be, not a preference.
        watchRegion: region.chosen,
      }),
    });
  });

  app.post('/api/catalogs/share', auth, async (request, reply) => {
    const parsed = shareBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });

    let shared;
    try {
      shared = decodeShare(parsed.data.code);
    } catch (err) {
      const message =
        err instanceof InvalidShareCode ? err.message : 'That setup code could not be read';
      return reply.code(400).send({ error: 'invalid_share_code', message });
    }

    const userId = request.user!.id;
    // Importing adds to what is there rather than replacing it: a code is
    // usually pasted to try someone's catalogs, and silently deleting the
    // importer's own would be an expensive surprise to undo.
    const created = [];
    for (const c of shared.catalogs) {
      created.push(await service.create(userId, c));
    }
    if (shared.artworkTemplate && !(await artworkStore.get(userId))) {
      // Only fill a setting the importer has not already chosen for themselves.
      if (!validateArtworkTemplate(shared.artworkTemplate)) {
        await artworkStore.set(userId, { template: shared.artworkTemplate });
      }
    }
    if (shared.watchRegion && !(await regions.get(userId)).chosen) {
      await regions.choose(userId, shared.watchRegion);
    }
    return reply.code(201).send({ imported: created.length, catalogs: created });
  });

  app.post('/api/catalogs', auth, async (request, reply) => {
    const parsed = catalogBody.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'invalid_input', issues: parsed.error.flatten() });
    return reply.code(201).send(await service.create(request.user!.id, parsed.data));
  });

  app.patch('/api/catalogs/:id', auth, async (request, reply) => {
    const parsed = patchBody.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'invalid_input', issues: parsed.error.flatten() });
    const { id } = request.params as { id: string };
    const updated = await service.update(request.user!.id, id, parsed.data);
    if (!updated) return reply.code(404).send({ error: 'not_found' });
    return reply.send(updated);
  });

  app.delete('/api/catalogs/:id', auth, async (request, reply) => {
    const { id } = request.params as { id: string };
    const ok = await service.remove(request.user!.id, id);
    return reply.code(ok ? 200 : 404).send({ status: ok ? 'deleted' : 'not_found' });
  });

  // Resolved contents of one catalog, for the in-app viewer. Reads the cached
  // pool (or NL cache) — no outbound calls. Drops the catalog's hidden items and
  // anything a higher-priority catalog already claims, so what's shown matches
  // what Stremio serves.
  app.get('/api/catalogs/:id/preview', auth, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user!.id;
    const def = await service.get(userId, id);
    if (!def) return reply.code(404).send({ error: 'not_found' });

    const limit = Math.min(
      PREVIEW_MAX,
      Math.max(1, Number((request.query as { limit?: string }).limit) || 60),
    );
    const hiddenKeys = await service.exclusionKeys(userId, id);
    const claimed = await claimedByHigherPriority(service, pools, nl, userId, id);
    const matches = await resolveMatches(def, userId, pools, nl);
    if (matches === null) return reply.send({ status: 'building', items: [], hidden: [] });

    const visible: Candidate[] = [];
    const hidden: Candidate[] = [];
    for (const c of matches) {
      const key = recItemKey(c.type, c.tmdbId);
      if (hiddenKeys.has(key)) hidden.push(c);
      else if (!claimed.has(key)) visible.push(c); // claimed-elsewhere titles are served by that catalog
    }
    // A filter catalog draws on the user's own history, so a narrow filter can
    // leave the row nearly empty however big the pool is. Report which filter
    // is responsible so the page can say so instead of just showing a gap.
    const pool = def.type === 'filter' ? await pools.get(userId) : null;
    const diagnosis = pool ? diagnoseCatalog(pool, def, hiddenKeys) : undefined;

    return reply.send({
      status: 'ready',
      items: visible.slice(0, limit).map(toPreview),
      hidden: hidden.map(toPreview),
      diagnosis,
    });
  });

  app.post('/api/catalogs/:id/hide', auth, async (request, reply) => {
    const parsed = hideBody.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'invalid_input', issues: parsed.error.flatten() });
    const { id } = request.params as { id: string };
    const ok = await service.addExclusion(
      request.user!.id,
      id,
      parsed.data.tmdbId,
      parsed.data.type,
    );
    if (ok) {
      // Fire and forget: the local hide is what the user asked for, and Trakt
      // being unreachable must not make dismissing a title fail.
      void traktHides.mirror(request.user!.id, parsed.data, true);
    }
    return reply.code(ok ? 200 : 404).send({ status: ok ? 'hidden' : 'not_found' });
  });

  app.post('/api/catalogs/:id/unhide', auth, async (request, reply) => {
    const parsed = hideBody.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'invalid_input', issues: parsed.error.flatten() });
    const { id } = request.params as { id: string };
    const ok = await service.removeExclusion(
      request.user!.id,
      id,
      parsed.data.tmdbId,
      parsed.data.type,
    );
    if (ok) void traktHides.mirror(request.user!.id, parsed.data, false);
    return reply.code(ok ? 200 : 404).send({ status: ok ? 'shown' : 'not_found' });
  });

  app.get('/api/catalogs/trakt-hides', auth, async (request, reply) => {
    return reply.send({ enabled: await traktHides.isEnabled(request.user!.id) });
  });

  app.put('/api/catalogs/trakt-hides', auth, async (request, reply) => {
    const parsed = z.object({ enabled: z.boolean() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    await traktHides.setEnabled(request.user!.id, parsed.data.enabled);
    return reply.send({ enabled: parsed.data.enabled });
  });

  // The Stremio install URL (manifest) for this user, plus a manual pool refresh.
  app.get('/api/catalogs/install', auth, async (request, reply) => {
    const installId = await service.getOrCreateInstall(request.user!.id);
    const manifestUrl = `${config.APP_URL}/stremio/${installId}/manifest.json`;
    return reply.send({
      installId,
      manifestUrl,
      stremioUrl: `stremio://${manifestUrl.replace(/^https?:\/\//, '')}`,
    });
  });

  // Rebuilding pulls history and hits TMDB, so cap it per user.
  const refreshLimit = limiter.middleware({
    name: 'catalog-refresh',
    max: 5,
    windowMs: 60 * 60 * 1000,
    keyBy: (req) => req.user?.id ?? req.clientIp,
  });
  app.post(
    '/api/catalogs/refresh',
    { preHandler: [requireAuth, refreshLimit] },
    async (request, reply) => {
      void pools.refresh(request.user!.id);
      return reply.send({ status: 'refreshing' });
    },
  );
}
