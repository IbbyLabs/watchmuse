import type { FastifyInstance } from 'fastify';
import { setProviderObserver, type AppConfig } from '@watchmuse/core';
import {
  httpDuration,
  httpRequests,
  providerInFlight,
  providerRequests,
  registry,
} from '../metrics/registry.js';

/** Fastify stores the matched route pattern here; falls back for unmatched paths. */
function routeLabel(url: string | undefined, raw: string): string {
  if (url) return url;
  // An unmatched request has no pattern, and using its raw path would turn every
  // 404 probe into a new label. Bucket them all together instead.
  return raw.startsWith('/api/') ? '/api/unmatched' : '/unmatched';
}

export function metricsRoutes(app: FastifyInstance, config: AppConfig): void {
  if (!config.METRICS_ENABLED) return;

  setProviderObserver({
    onStart: (provider) => providerInFlight.inc({ provider }),
    onEnd: (provider, outcome) => {
      providerInFlight.dec({ provider });
      providerRequests.inc({ provider, outcome });
    },
  });
  app.addHook('onClose', async () => setProviderObserver(null));

  app.addHook('onResponse', async (request, reply) => {
    const labels = {
      method: request.method,
      route: routeLabel(request.routeOptions?.url, request.url),
    };
    httpRequests.inc({ ...labels, status: String(reply.statusCode) });
    // Fastify measures this itself, in milliseconds; Prometheus wants seconds.
    httpDuration.observe(labels, reply.elapsedTime / 1000);
  });

  app.get('/metrics', async (request, reply) => {
    if (config.METRICS_TOKEN) {
      const header = request.headers.authorization ?? '';
      const offered = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (offered !== config.METRICS_TOKEN) {
        return reply.code(401).send({ error: 'unauthorized', message: 'Invalid metrics token' });
      }
    }
    return reply.header('content-type', registry.contentType).send(await registry.metrics());
  });
}
