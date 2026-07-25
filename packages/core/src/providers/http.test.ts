import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient, HttpError } from './http.js';

afterEach(() => vi.restoreAllMocks());

describe('HttpClient', () => {
  it('retries on 429 honouring Retry-After, then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpClient({ baseUrl: 'https://x', maxRetries: 2 });
    await expect(client.get('/y')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries on 5xx then gives up as HttpError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 503 })));
    const client = new HttpClient({ baseUrl: 'https://x', maxRetries: 1, maxBackoffMs: 1 });
    await expect(client.get('/y')).rejects.toBeInstanceOf(HttpError);
  });

  it('throws HttpError immediately on 4xx (no retry)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpClient({ baseUrl: 'https://x' });
    await expect(client.get('/y')).rejects.toMatchObject({ status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /** A fetch that never settles until told to, so overlap is observable. */
  function gatedFetch() {
    const release: Array<() => void> = [];
    let peak = 0;
    let open = 0;
    const mock = vi.fn(() => {
      open++;
      peak = Math.max(peak, open);
      return new Promise<Response>((resolve) =>
        release.push(() => {
          open--;
          resolve(new Response('{}', { status: 200 }));
        }),
      );
    });
    return { mock, release, peak: () => peak };
  }

  it('sends one request at a time by default', async () => {
    const gate = gatedFetch();
    vi.stubGlobal('fetch', gate.mock);
    const client = new HttpClient({ baseUrl: 'https://x' });

    const all = Promise.all([client.get('/a'), client.get('/b'), client.get('/c')]);
    for (let n = 1; n <= 3; n++) {
      await vi.waitFor(() => expect(gate.mock).toHaveBeenCalledTimes(n), { timeout: 10_000 });
      gate.release.shift()!();
    }
    await all;

    expect(gate.peak()).toBe(1);
  });

  it('overlaps up to maxConcurrent requests', async () => {
    const gate = gatedFetch();
    vi.stubGlobal('fetch', gate.mock);
    const client = new HttpClient({ baseUrl: 'https://x', maxConcurrent: 3 });

    const all = Promise.all([1, 2, 3, 4, 5].map((n) => client.get(`/${n}`)));
    await vi.waitFor(() => expect(gate.mock).toHaveBeenCalledTimes(3), { timeout: 10_000 });
    expect(gate.peak()).toBe(3);
    while (gate.release.length) gate.release.shift()!();
    await vi.waitFor(() => expect(gate.mock).toHaveBeenCalledTimes(5), { timeout: 10_000 });
    while (gate.release.length) gate.release.shift()!();
    await all;

    expect(gate.peak()).toBe(3);
  });

  it('frees its slot when a request fails, so the queue keeps draining', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('nope', { status: 404 }))
      .mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpClient({ baseUrl: 'https://x', maxConcurrent: 1 });

    const [first, second] = await Promise.allSettled([client.get('/a'), client.get('/b')]);
    expect(first!.status).toBe('rejected');
    expect(second!.status).toBe('fulfilled');
  });

  it('spaces requests by minIntervalMs even when they overlap', async () => {
    const at: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        at.push(Date.now());
        return Promise.resolve(new Response('{}', { status: 200 }));
      }),
    );
    const client = new HttpClient({ baseUrl: 'https://x', maxConcurrent: 4, minIntervalMs: 25 });

    await Promise.all([1, 2, 3, 4].map((n) => client.get(`/${n}`)));

    expect(at).toHaveLength(4);
    expect(at[3]! - at[0]!).toBeGreaterThanOrEqual(70); // 3 gaps of 25ms, minus timer slack
  });
});

describe('HttpClient shared pacing', () => {
  /** Timestamps of every request the mocked fetch saw, in order. */
  function stampingFetch() {
    const at: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        at.push(Date.now());
        return Promise.resolve(new Response('{}', { status: 200 }));
      }),
    );
    return at;
  }

  it('spaces requests across separate clients that share a key', async () => {
    const at = stampingFetch();
    const key = `shared-${Math.random()}`;
    // Two users rebuilding at once, each with its own client but one credential.
    const clients = [
      new HttpClient({ baseUrl: 'https://x', minIntervalMs: 25, rateLimitKey: key }),
      new HttpClient({ baseUrl: 'https://x', minIntervalMs: 25, rateLimitKey: key }),
    ];
    await Promise.all(clients.flatMap((c) => [c.get('/a'), c.get('/b')]));

    expect(at).toHaveLength(4);
    expect(at[3]! - at[0]!).toBeGreaterThanOrEqual(70); // 3 gaps, minus timer slack
  });

  it('keeps different keys on their own budget', async () => {
    const at = stampingFetch();
    const suffix = Math.random();
    const clients = [
      new HttpClient({ baseUrl: 'https://x', minIntervalMs: 25, rateLimitKey: `a-${suffix}` }),
      new HttpClient({ baseUrl: 'https://x', minIntervalMs: 25, rateLimitKey: `b-${suffix}` }),
    ];
    await Promise.all(clients.map((c) => c.get('/a')));

    expect(at).toHaveLength(2);
    expect(at[1]! - at[0]!).toBeLessThan(25);
  });

  it('paces per instance when no key is set', async () => {
    const at = stampingFetch();
    const clients = [
      new HttpClient({ baseUrl: 'https://x', minIntervalMs: 25 }),
      new HttpClient({ baseUrl: 'https://x', minIntervalMs: 25 }),
    ];
    await Promise.all(clients.map((c) => c.get('/a')));

    expect(at).toHaveLength(2);
    expect(at[1]! - at[0]!).toBeLessThan(25);
  });
});

describe('HttpClient redirects', () => {
  const redirect = () =>
    vi
      .fn()
      .mockResolvedValue(
        new Response('', { status: 302, headers: { location: 'http://169.254.169.254/' } }),
      );

  it('follows redirects by default', async () => {
    const fetchMock = redirect();
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpClient({ baseUrl: 'https://x' });
    await client.get('/y').catch(() => undefined);
    expect(fetchMock.mock.calls[0]![1].redirect).toBe('follow');
  });

  it('refuses to follow one when told not to', async () => {
    const fetchMock = redirect();
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpClient({ baseUrl: 'https://x', followRedirects: false, maxRetries: 0 });

    await expect(client.get('/y')).rejects.toMatchObject({ status: 302 });
    expect(fetchMock.mock.calls[0]![1].redirect).toBe('manual');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
