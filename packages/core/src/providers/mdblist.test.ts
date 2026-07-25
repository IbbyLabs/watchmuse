import { afterEach, describe, expect, it, vi } from 'vitest';
import { MdblistClient } from './mdblist.js';

interface Recorded {
  url: string;
  method: string;
  body: unknown;
}

function routeFetch(handler: (rec: Recorded) => { status?: number; body?: unknown }) {
  const calls: Recorded[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const rec: Recorded = {
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(rec);
    const { status = 200, body } = handler(rec);
    return new Response(body === undefined ? '' : JSON.stringify(body), { status });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

afterEach(() => vi.restoreAllMocks());

describe('MdblistClient.validate', () => {
  it('is true on 200, false on 401/403, and passes the apikey query param', async () => {
    const calls = routeFetch(() => ({ status: 200 }));
    expect(await new MdblistClient('secret-key').validate()).toBe(true);
    expect(calls[0]!.url).toContain('apikey=secret-key');
    expect(calls[0]!.url).toContain('/user');

    routeFetch(() => ({ status: 401 }));
    expect(await new MdblistClient('k').validate()).toBe(false);

    routeFetch(() => ({ status: 403 }));
    expect(await new MdblistClient('k').validate()).toBe(false);
  });
});

describe('MdblistClient.pullHistory', () => {
  it('maps movies and episodes to tmdb-keyed refs and pages until has_more is false', async () => {
    const pages: Record<string, unknown> = {
      'offset=0': {
        movies: [{ movie: { ids: { tmdb: 550 } } }],
        episodes: [{ episode: { season: 2, number: 5, show: { ids: { tmdb: 1399 } } } }],
        pagination: { has_more: true },
      },
      'offset=1000': {
        movies: [{ movie: { ids: { tmdb: 603 } } }],
        pagination: { has_more: false },
      },
    };
    const calls = routeFetch((rec) => ({
      body: pages[rec.url.includes('offset=1000') ? 'offset=1000' : 'offset=0'],
    }));

    const events = await new MdblistClient('k').pullHistory();

    expect(calls.filter((c) => c.url.includes('/sync/watched'))).toHaveLength(2);
    expect(events).toContainEqual({ ref: { kind: 'movie', ids: { tmdb: 550 } }, watchedAt: null });
    expect(events).toContainEqual({
      ref: { kind: 'episode', ids: { tmdb: 1399 }, season: 2, number: 5 },
      watchedAt: null,
    });
    expect(events).toContainEqual({ ref: { kind: 'movie', ids: { tmdb: 603 } }, watchedAt: null });
  });

  it('skips rows with no tmdb id', async () => {
    routeFetch(() => ({
      body: { movies: [{ movie: { ids: {} } }], pagination: { has_more: false } },
    }));
    expect(await new MdblistClient('k').pullHistory()).toEqual([]);
  });
});
