import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import { SecretBox, type AppConfig } from '@watchmuse/core';
import type { Db } from './db/client.js';
import type { Mailer } from './mail/mailer.js';
import { AuthService } from './auth/service.js';
import { ConnectionStore } from './connections/store.js';
import { ConnectionService } from './connections/service.js';
import { OAuthStateStore } from './connections/oauthState.js';
import { WatchRegionStore } from './watch/regionStore.js';
import { Scheduler } from './scheduler/scheduler.js';
import { MaintenanceStore } from './scheduler/store.js';
import { TokenRenewer } from './scheduler/tokens.js';
import { connectionRoutes } from './routes/connections.js';
import { RecommendationService } from './reco/service.js';
import { recoRoutes } from './routes/reco.js';
import { CatalogService } from './catalogs/service.js';
import { PoolService } from './catalogs/pool.js';
import { NlCatalogService } from './catalogs/nl.js';
import { LlmConfigStore } from './ai/store.js';
import { ArtworkConfigStore } from './artwork/store.js';
import { catalogRoutes } from './routes/catalogs.js';
import { stremioRoutes } from './routes/stremio.js';
import { aiRoutes } from './routes/ai.js';
import { artworkRoutes } from './routes/artwork.js';
import { watchRoutes } from './routes/watch.js';
import { RateLimiter } from './plugins/rateLimit.js';
import { registerRealIp } from './plugins/realIp.js';
import { registerAuth } from './plugins/auth.js';
import { healthRoutes } from './routes/health.js';
import { metricsRoutes } from './routes/metrics.js';
import { HistoryRowStore } from './catalogs/historyRows.js';
import { TraktHideMirror } from './catalogs/traktHides.js';
import { authRoutes } from './routes/auth.js';
import './types.js';

export interface AppDeps {
  config: AppConfig;
  db: Db;
  mailer: Mailer;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const { config, db, mailer } = deps;
  const app = Fastify({
    logger: false,
    // We resolve the client IP ourselves (see registerRealIp) rather than using
    // Fastify's trustProxy, so this stays false.
    trustProxy: false,
    bodyLimit: 256 * 1024,
  });

  app.register(helmet, { contentSecurityPolicy: false });
  app.register(cookie, { secret: config.SESSION_SECRET });

  registerRealIp(app, config);

  const auth = new AuthService(db, mailer, config);
  registerAuth(app, auth);

  // CSRF baseline: reject cross-origin state-changing requests. Browsers always
  // send Origin on such requests; native clients (no Origin) are allowed.
  const appOrigin = new URL(config.APP_URL).origin;
  app.addHook('onRequest', async (request, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    const origin = request.headers.origin;
    if (origin && origin !== appOrigin) {
      return reply.code(403).send({ error: 'bad_origin', message: 'Cross-origin request blocked' });
    }
  });

  const box = SecretBox.fromEnv(config.APP_ENCRYPTION_KEY);
  const connectionStore = new ConnectionStore(db, box);
  const oauthStates = new OAuthStateStore(db);
  const connectionService = new ConnectionService(connectionStore, config, oauthStates);

  const recommendations = new RecommendationService(connectionService, connectionStore, config);
  const llmStore = new LlmConfigStore(db, box);
  const artworkStore = new ArtworkConfigStore(db, box);
  const watchRegions = new WatchRegionStore(db);
  const historyRowStore = new HistoryRowStore(db);
  const pools = new PoolService(db, recommendations, config, llmStore, watchRegions, historyRowStore);
  const catalogService = new CatalogService(db);
  const nlCatalogs = new NlCatalogService(db, pools, llmStore, config);

  const limiter = new RateLimiter();
  metricsRoutes(app, config);
  healthRoutes(app, db, config);
  authRoutes(app, auth, limiter, config);
  connectionRoutes(app, connectionService, connectionStore, config);
  recoRoutes(app, recommendations);
  const traktHides = new TraktHideMirror(db, connectionService);
  catalogRoutes(app, catalogService, pools, nlCatalogs, limiter, config, artworkStore, watchRegions, traktHides);
  stremioRoutes(app, catalogService, pools, nlCatalogs, artworkStore, watchRegions, config, historyRowStore);
  aiRoutes(app, llmStore, config);
  artworkRoutes(app, artworkStore);
  watchRoutes(app, watchRegions, config);

  const maintenance = new MaintenanceStore(db);
  const scheduler = new Scheduler({
    config,
    store: maintenance,
    pool: pools,
    tokens: new TokenRenewer(maintenance, connectionService),
    oauthStates,
  });
  app.decorate('scheduler', scheduler);
  app.addHook('onClose', async () => scheduler.stop());

  registerSpa(app);
  return app;
}

/** Serve the built SPA (if present) with history-API fallback for client routes. */
function registerSpa(app: FastifyInstance): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.WEB_DIST,
    resolve(here, '../../web/dist'), // monorepo: packages/server/dist -> packages/web/dist
    resolve(here, '../web'), // deployed: <app>/dist -> <app>/web
  ].filter((c): c is string => Boolean(c));

  const webDist = candidates.find((c) => existsSync(join(c, 'index.html')));
  if (!webDist) return;

  app.register(fastifyStatic, { root: webDist, wildcard: false });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return reply.sendFile('index.html');
  });
}
