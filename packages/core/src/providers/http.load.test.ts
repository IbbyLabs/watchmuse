import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpClient } from './http.js';

/**
 * Seerr hit ETIMEDOUT once more than about ten requests to one host were in
 * flight inside Docker. Watchmuse now issues its rebuild lookups concurrently,
 * so this measures what actually reaches a socket rather than trusting the
 * option, and pins the ceiling against future changes.
 */

let server: Server;
let baseUrl: string;
let open = 0;
let peak = 0;

beforeAll(async () => {
  server = createServer((_req, res) => {
    open++;
    peak = Math.max(peak, open);
    // Long enough that requests genuinely overlap rather than queueing by luck.
    setTimeout(() => {
      open--;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    }, 25);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

function reset() {
  open = 0;
  peak = 0;
}

describe('HttpClient under load', () => {
  it('never exceeds its concurrency bound across a large batch', async () => {
    reset();
    const client = new HttpClient({ baseUrl, maxConcurrent: 6 });
    await Promise.all(Array.from({ length: 150 }, (_, i) => client.get(`/x${i}`)));
    expect(peak).toBeLessThanOrEqual(6);
  });

  it('completes every request in the batch', async () => {
    reset();
    const client = new HttpClient({ baseUrl, maxConcurrent: 6 });
    const results = await Promise.all(Array.from({ length: 150 }, (_, i) => client.get(`/y${i}`)));
    expect(results).toHaveLength(150);
  });

  it('stays under the ~10 that broke Seerr when one client serves the whole rebuild', async () => {
    reset();
    const client = new HttpClient({ baseUrl, maxConcurrent: 6 });
    // A rebuild's three phases run one after another, all through one client.
    for (const phase of ['seeds', 'imdb', 'providers']) {
      await Promise.all(Array.from({ length: 80 }, (_, i) => client.get(`/${phase}${i}`)));
    }
    expect(peak).toBeLessThan(10);
  });

  it('multiplies past that ceiling when each caller builds its own client', async () => {
    reset();
    // Two users rebuilding at once, each constructing its own client: the bound
    // is per client, so the host sees the sum. This is why the TMDB client is
    // shared per process rather than constructed per operation.
    const clients = [
      new HttpClient({ baseUrl, maxConcurrent: 6 }),
      new HttpClient({ baseUrl, maxConcurrent: 6 }),
    ];
    await Promise.all(
      clients.flatMap((c, n) => Array.from({ length: 60 }, (_, i) => c.get(`/u${n}-${i}`))),
    );
    expect(peak).toBeGreaterThan(6);
  });
});

describe('TmdbClient.shared', () => {
  it('hands every caller the same client, so the bound is process-wide', async () => {
    const { TmdbClient } = await import('./tmdb.js');
    const a = TmdbClient.shared({ apiKey: 'load-test-key' });
    const b = TmdbClient.shared({ apiKey: 'load-test-key' });
    expect(a).toBe(b);
  });

  it('keeps separate keys apart', async () => {
    const { TmdbClient } = await import('./tmdb.js');
    expect(TmdbClient.shared({ apiKey: 'key-one' })).not.toBe(
      TmdbClient.shared({ apiKey: 'key-two' }),
    );
  });
});
