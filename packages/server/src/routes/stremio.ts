import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  TmdbClient,
  applyCatalogFilter,
  dailySeed,
  elitistShuffle,
  recItemKey,
  toStremioMetas,
  type AppConfig,
  type Candidate,
  type CatalogDef,
} from '@watchmuse/core';
import type { CatalogService } from '../catalogs/service.js';
import type { PoolService } from '../catalogs/pool.js';
import type { NlCatalogService } from '../catalogs/nl.js';
import type { ArtworkConfigStore } from '../artwork/store.js';
import type { WatchRegionStore } from '../watch/regionStore.js';
import { claimedByHigherPriority } from '../catalogs/resolve.js';
import { searchForUser } from '../catalogs/search.js';
import type { HistoryRowStore } from '../catalogs/historyRows.js';

const PAGE_SIZE = 100;

/**
 * Stremio addons are fetched cross-origin, so every response is CORS-open.
 * Default to no-store: the manifest's catalog set must never be served stale
 * (so add/remove/rename show up as soon as Stremio re-reads it), and "still
 * building" empty catalog responses must refill immediately once the pool is
 * ready. Only populated catalog pages opt into caching (see serveCatalog).
 */
function cors(reply: FastifyReply): FastifyReply {
  return reply
    .header('access-control-allow-origin', '*')
    .header('access-control-allow-headers', '*')
    .header('cache-control', 'no-store');
}

/** Manifest catalog entries for a def — one per applicable Stremio type. */
function manifestCatalogs(
  def: CatalogDef,
): Array<{ type: 'movie' | 'series'; id: string; name: string }> {
  const types: Array<'movie' | 'series'> =
    def.mediaType === 'both' ? ['movie', 'series'] : [def.mediaType];
  return types.map((type) => ({ type, id: def.id, name: def.name }));
}

function parseSkip(extra?: string): number {
  if (!extra) return 0;
  const m = /(?:^|&)skip=(\d+)/.exec(decodeURIComponent(extra));
  return m ? Number(m[1]) : 0;
}

function parseSearch(extra?: string): string | null {
  if (!extra) return null;
  const m = /(?:^|&)search=([^&]*)/.exec(decodeURIComponent(extra));
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

/**
 * Stremio has no search resource: a catalog answers search by declaring a
 * `search` extra. Marking it required keeps this one off the Discover board,
 * which is what we want — it exists only to answer queries, and a row of
 * "search results" with nothing searched would be meaningless.
 */
const SEARCH_CATALOG_ID = 'watchmuse-search';

function searchCatalogs(name: string): Array<Record<string, unknown>> {
  return (['movie', 'series'] as const).map((type) => ({
    type,
    id: SEARCH_CATALOG_ID,
    name,
    extra: [{ name: 'search', isRequired: true }],
  }));
}

export function stremioRoutes(
  app: FastifyInstance,
  catalogsSvc: CatalogService,
  pools: PoolService,
  nl: NlCatalogService,
  artwork: ArtworkConfigStore,
  regions: WatchRegionStore,
  config: AppConfig,
  historyRows: HistoryRowStore,
): void {
  // Preflight for browser-based Stremio.
  app.options('/stremio/*', async (_req, reply) => cors(reply).code(204).send());

  app.get('/stremio/:installId/manifest.json', async (request, reply) => {
    const { installId } = request.params as { installId: string };
    const userId = await catalogsSvc.resolveInstall(installId);
    if (!userId) return cors(reply).code(404).send({ error: 'unknown_install' });

    await catalogsSvc.ensureDefaults(userId, []);
    const defs = (await catalogsSvc.list(userId)).filter((d) => d.enabled);

    return cors(reply).send({
      id: `dev.ibbylabs.watchmuse.${installId}`,
      version: config.APP_VERSION,
      name: config.APP_NAME,
      description: 'Personalized recommendation catalogs from your watch history.',
      resources: ['catalog'],
      types: ['movie', 'series'],
      idPrefixes: ['tt', 'tmdb:'],
      catalogs: [...defs.flatMap(manifestCatalogs), ...searchCatalogs(config.APP_NAME)],
      logo: `${config.APP_URL}/icon-256.png`,
      // Adds a Configure button beside Install, pointing at /configure next to
      // the manifest. Without it there is no route back from Stremio to manage
      // catalogs, which is where everything about this addon is set up.
      behaviorHints: { configurable: true, configurationRequired: false },
    });
  });

  // Stremio's Configure button lands here. The catalogs page is the whole point
  // of the addon, and an unauthenticated visitor is sent to sign in first.
  app.get('/stremio/:installId/configure', async (request, reply) => {
    const { installId } = request.params as { installId: string };
    const userId = await catalogsSvc.resolveInstall(installId);
    return cors(reply).redirect(
      `${config.APP_URL}/${userId ? 'catalogs' : 'login?next=/catalogs'}`,
      302,
    );
  });

  const serveCatalog = async (request: FastifyRequest, reply: FastifyReply) => {
    const { installId, type, id, extra } = request.params as {
      installId: string;
      type: string;
      id: string;
      extra?: string;
    };
    if (type !== 'movie' && type !== 'series') return cors(reply).code(404).send({ metas: [] });

    const userId = await catalogsSvc.resolveInstall(installId);
    if (!userId) return cors(reply).code(404).send({ metas: [] });

    // A Stremio request comes from the device someone actually watches on, so
    // it is the best evidence of which country's availability to answer for.
    if (request.clientCountry) {
      void regions.observe(userId, request.clientCountry).catch(() => undefined);
    }

    if (id === SEARCH_CATALOG_ID) {
      const query = parseSearch(extra);
      if (!query) return cors(reply).send({ metas: [] });
      if (!config.TMDB_API_KEY) return cors(reply).send({ metas: [] });
      const pool = await pools.get(userId);
      const hits = await searchForUser(
        TmdbClient.shared({ apiKey: config.TMDB_API_KEY }),
        type,
        query,
        pool,
      );
      const artworkTemplate = (await artwork.get(userId))?.template;
      return cors(reply)
        .header('cache-control', 'public, max-age=600')
        .send({
          metas: toStremioMetas(hits.slice(0, PAGE_SIZE), TmdbClient.genreName, artworkTemplate),
        });
    }

    const def = await catalogsSvc.get(userId, id);
    if (!def || !def.enabled) return cors(reply).send({ metas: [] });

    // NL catalogs serve from their own cache (LLM never runs on this path);
    // filter catalogs filter the live candidate pool. Either way we drop the
    // catalog's hidden items (a title hidden in the app stays gone here) and
    // anything a higher-priority catalog already claims, so a title shows in at
    // most one row and lower rows backfill with their next-best match.
    const own = await catalogsSvc.exclusionKeys(userId, id);
    const claimed = await claimedByHigherPriority(catalogsSvc, pools, nl, userId, id);
    const exclude = own.size ? new Set([...claimed, ...own]) : claimed;
    let items: Candidate[];
    if (def.type === 'rewatch' || def.type === 'newseason') {
      // Built from the user's own history alongside the pool, so there is
      // nothing to filter here beyond the type and the usual exclusions.
      const rows = await historyRows.get(userId);
      const list = def.type === 'rewatch' ? rows.rewatch : rows.newSeason;
      items = list.filter((c) => c.type === type && !exclude.has(recItemKey(c.type, c.tmdbId)));
    } else if (def.type === 'nl') {
      const nlItems = await nl.get(userId, def);
      if (!nlItems) return cors(reply).send({ metas: [] }); // building; fills on next poll
      items = nlItems.filter((c) => c.type === type && !exclude.has(recItemKey(c.type, c.tmdbId)));
    } else {
      const pool = await pools.get(userId);
      if (!pool) return cors(reply).send({ metas: [] }); // building; fills on next poll
      // A filter catalog's order is pure score, so it never moves between
      // rebuilds and the row reads as stale. Reshuffle below the strongest few,
      // once a day. NL catalogs are left alone: their order is the model's
      // editorial choice, not an arithmetic ranking, so shuffling would undo it.
      items = elitistShuffle(
        applyCatalogFilter(pool, def, exclude).filter((c) => c.type === type),
        dailySeed(def.id),
      );
    }

    const skip = parseSkip(extra);
    const page = items.slice(skip, skip + PAGE_SIZE);
    const artworkTemplate = (await artwork.get(userId))?.template;
    // Populated pages are safe to cache briefly; empty/building states are not.
    return cors(reply)
      .header('cache-control', 'public, max-age=600')
      .send({ metas: toStremioMetas(page, TmdbClient.genreName, artworkTemplate) });
  };

  app.get('/stremio/:installId/catalog/:type/:id.json', serveCatalog);
  // Stremio appends extra args (skip=, genre=) as a path segment.
  app.get('/stremio/:installId/catalog/:type/:id/:extra.json', serveCatalog);
}
