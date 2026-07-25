import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus instrumentation.
 *
 * Chosen to answer the questions that have actually cost time here: is a
 * provider failing, is a rebuild slow or looping, and how much work is in
 * flight. The socket-concurrency bug showed up as parallel rebuilds opening
 * more connections than any one client thought it was allowed, which
 * `watchmuse_provider_requests_in_flight` would have made obvious.
 */

export const registry = new Registry();

registry.setDefaultLabels({ app: 'watchmuse' });
collectDefaultMetrics({ register: registry });

/**
 * Route label is the Fastify route pattern, never the raw URL: a path carrying
 * an install id or a search query would otherwise become a label value, which
 * both leaks it into the metrics endpoint and explodes cardinality.
 */
export const httpRequests = new Counter({
  name: 'watchmuse_http_requests_total',
  help: 'HTTP requests handled, by method, route pattern and status code',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const httpDuration = new Histogram({
  name: 'watchmuse_http_request_duration_seconds',
  help: 'Time to serve an HTTP request',
  labelNames: ['method', 'route'] as const,
  buckets: [0.005, 0.025, 0.1, 0.5, 1, 2.5, 10],
  registers: [registry],
});

export const poolRebuilds = new Counter({
  name: 'watchmuse_pool_rebuilds_total',
  help: 'Candidate pool rebuilds, by outcome',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

export const poolRebuildDuration = new Histogram({
  name: 'watchmuse_pool_rebuild_duration_seconds',
  help: 'Time to rebuild one user candidate pool',
  // A rebuild fans out over the whole watch history, so the useful range runs
  // to minutes rather than the sub-second buckets an HTTP histogram wants.
  buckets: [1, 5, 15, 30, 60, 120, 300, 600],
  registers: [registry],
});

export const poolSize = new Histogram({
  name: 'watchmuse_pool_size_candidates',
  help: 'Candidates in a pool after a rebuild',
  buckets: [0, 50, 200, 500, 1000, 2000, 5000],
  registers: [registry],
});

export const providerRequests = new Counter({
  name: 'watchmuse_provider_requests_total',
  help: 'Outbound provider requests, by provider and outcome',
  labelNames: ['provider', 'outcome'] as const,
  registers: [registry],
});

export const providerInFlight = new Gauge({
  name: 'watchmuse_provider_requests_in_flight',
  help: 'Outbound provider requests currently open, by provider',
  labelNames: ['provider'] as const,
  registers: [registry],
});

/** Reset every metric. Tests only — a live process must never lose its counters. */
export function resetMetrics(): void {
  registry.resetMetrics();
}
