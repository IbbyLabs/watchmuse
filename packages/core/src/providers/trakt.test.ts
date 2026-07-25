import { afterEach, describe, expect, it, vi } from 'vitest';
import { TraktClient } from './trakt.js';
import type { WatchEvent } from './types.js';

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

const cfg = { clientId: 'cid', clientSecret: 'sec' };
const future = () => Date.now() + 3_600_000;

afterEach(() => vi.restoreAllMocks());

describe('Trakt device flow', () => {
  it('requests a device code', async () => {
    routeFetch(() => ({
      body: {
        device_code: 'dc',
        user_code: 'ABCD',
        verification_url: 'https://trakt.tv/activate',
        expires_in: 600,
        interval: 5,
      },
    }));
    const code = await new TraktClient(cfg).requestDeviceCode();
    expect(code).toMatchObject({
      deviceCode: 'dc',
      userCode: 'ABCD',
      verificationUrl: 'https://trakt.tv/activate',
    });
  });

  it('maps a 400 poll to pending and a 200 to tokens', async () => {
    const pending = new TraktClient(cfg);
    routeFetch(() => ({ status: 400 }));
    await expect(pending.pollDeviceToken('dc')).resolves.toBe('pending');

    const ok = new TraktClient(cfg);
    routeFetch(() => ({
      body: { access_token: 'at', refresh_token: 'rt', expires_in: 7776000, created_at: 0 },
    }));
    const tokens = await ok.pollDeviceToken('dc');
    expect(tokens).toMatchObject({ accessToken: 'at', refreshToken: 'rt' });
  });
});

describe('Trakt pullHistory', () => {
  it('normalizes movies and episodes (episodes keyed by show ids)', async () => {
    routeFetch((rec) => {
      if (rec.url.includes('/sync/history/movies')) {
        return {
          body: [
            {
              watched_at: '2021-01-01T00:00:00Z',
              movie: {
                title: 'Fight Club',
                year: 1999,
                ids: { trakt: 1, imdb: 'tt0137523', tmdb: 550 },
              },
            },
          ],
        };
      }
      if (rec.url.includes('/sync/history/episodes')) {
        return {
          body: [
            {
              watched_at: '2021-02-02T00:00:00Z',
              episode: { season: 1, number: 2, ids: { trakt: 10 } },
              show: { title: 'GoT', ids: { trakt: 5, tvdb: 121361, tmdb: 1399 } },
            },
          ],
        };
      }
      return { body: [] };
    });
    const events = await new TraktClient({
      ...cfg,
      tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: future() },
    }).pullHistory();
    expect(events).toContainEqual({
      ref: {
        kind: 'movie',
        ids: { imdb: 'tt0137523', tmdb: 550, trakt: 1 },
        title: 'Fight Club',
        year: 1999,
      },
      watchedAt: '2021-01-01T00:00:00Z',
    });
    expect(events).toContainEqual({
      ref: {
        kind: 'episode',
        ids: { tmdb: 1399, tvdb: 121361, trakt: 5 },
        season: 1,
        number: 2,
        title: 'GoT',
      },
      watchedAt: '2021-02-02T00:00:00Z',
    });
  });
});

describe('Trakt pushHistory', () => {
  it('groups episodes into shows/seasons and posts movies', async () => {
    const calls = routeFetch((rec) =>
      rec.url.endsWith('/sync/history')
        ? { body: { added: { movies: 1, episodes: 2 } } }
        : { body: [] },
    );
    const events: WatchEvent[] = [
      { ref: { kind: 'movie', ids: { tmdb: 550 } }, watchedAt: '2021-01-01T00:00:00Z' },
      {
        ref: { kind: 'episode', ids: { tmdb: 1399 }, season: 1, number: 1 },
        watchedAt: '2021-01-02T00:00:00Z',
      },
      {
        ref: { kind: 'episode', ids: { tmdb: 1399 }, season: 1, number: 2 },
        watchedAt: '2021-01-03T00:00:00Z',
      },
    ];
    const res = await new TraktClient({
      ...cfg,
      tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: future() },
    }).pushHistory(events);

    expect(res.added).toBe(3);
    const post = calls.find((c) => c.url.endsWith('/sync/history'))!.body as {
      movies: unknown[];
      shows: Array<{ ids: unknown; seasons: Array<{ number: number; episodes: unknown[] }> }>;
    };
    expect(post.movies).toHaveLength(1);
    expect(post.shows).toHaveLength(1);
    expect(post.shows[0]!.seasons[0]).toMatchObject({ number: 1 });
    expect(post.shows[0]!.seasons[0]!.episodes).toHaveLength(2);
  });
});

describe('Trakt redirect flow', () => {
  it('builds an authorize URL', () => {
    const url = new TraktClient(cfg).authorizeUrl('https://app/cb', 'st8');
    expect(url).toContain('https://trakt.tv/oauth/authorize');
    expect(url).toContain('client_id=cid');
    expect(url).toContain('redirect_uri=https%3A%2F%2Fapp%2Fcb');
    expect(url).toContain('state=st8');
  });

  it('exchanges a code for tokens', async () => {
    routeFetch(() => ({
      body: { access_token: 'at', refresh_token: 'rt', expires_in: 7776000, created_at: 0 },
    }));
    const tokens = await new TraktClient(cfg).exchangeCode('code', 'https://app/cb');
    expect(tokens).toMatchObject({ accessToken: 'at', refreshToken: 'rt' });
  });
});

describe('Trakt token refresh', () => {
  it('refreshes an expired access token and reports it via onRefresh', async () => {
    const refreshed: unknown[] = [];
    const calls = routeFetch((rec) => {
      if (rec.url.endsWith('/oauth/token'))
        return { body: { access_token: 'new', refresh_token: 'newr', expires_in: 7776000 } };
      if (rec.url.includes('/sync/last_activities')) return { body: { movies: {} } };
      return { body: {} };
    });
    const client = new TraktClient({
      ...cfg,
      tokens: { accessToken: 'old', refreshToken: 'r', expiresAt: Date.now() - 1000 },
      onRefresh: async (t) => void refreshed.push(t),
    });
    await client.getLastActivities();
    expect(calls.some((c) => c.url.endsWith('/oauth/token'))).toBe(true);
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]).toMatchObject({ accessToken: 'new', refreshToken: 'newr' });
  });
});

describe('Trakt pullRatings', () => {
  it('reads movie and show scores with their ids', async () => {
    routeFetch((rec) => {
      if (rec.url.includes('/sync/ratings/movies')) {
        return {
          body: [
            {
              rated_at: '2024-02-01T00:00:00.000Z',
              rating: 9,
              movie: { title: 'The Matrix', year: 1999, ids: { trakt: 1, tmdb: 603, imdb: 'tt0133093' } },
            },
          ],
        };
      }
      if (rec.url.includes('/sync/ratings/shows')) {
        return {
          body: [
            {
              rated_at: '2024-03-01T00:00:00.000Z',
              rating: 7,
              show: { title: 'Game of Thrones', year: 2011, ids: { trakt: 2, tmdb: 1399 } },
            },
          ],
        };
      }
      return { body: [] };
    });

    const out = await new TraktClient({ ...cfg, tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: future() } }).pullRatings();
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ rating: 9, ratedAt: '2024-02-01T00:00:00.000Z' });
    expect(out[0]!.ref).toMatchObject({ kind: 'movie', ids: { tmdb: 603, imdb: 'tt0133093' } });
    expect(out[1]!.ref).toMatchObject({ kind: 'show', ids: { tmdb: 1399 } });
  });

  it('asks for movies and shows only, not episodes', async () => {
    const calls = routeFetch(() => ({ body: [] }));
    await new TraktClient({ ...cfg, tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: future() } }).pullRatings();
    const paths = calls.map((c) => c.url);
    expect(paths.some((p) => p.includes('/sync/ratings/movies'))).toBe(true);
    expect(paths.some((p) => p.includes('/sync/ratings/shows'))).toBe(true);
    expect(paths.some((p) => p.includes('/sync/ratings/episodes'))).toBe(false);
  });

  it('returns nothing when the user has rated nothing', async () => {
    routeFetch(() => ({ body: [] }));
    const out = await new TraktClient({ ...cfg, tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: future() } }).pullRatings();
    expect(out).toEqual([]);
  });
});

describe('Trakt hidden recommendations', () => {
  const client = () =>
    new TraktClient({ ...cfg, tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: future() } });

  it('posts movies and shows to the recommendations section', async () => {
    const calls = routeFetch(() => ({ body: { added: { movies: 1, shows: 1, season: 0 } } }));
    await client().setHiddenFromRecommendations(
      [
        { type: 'movie', tmdbId: 603 },
        { type: 'series', tmdbId: 1399 },
      ],
      true,
    );
    // A token refresh may go out first, so find the request that matters.
    const hidden = calls.find((c) => c.url.includes('/users/hidden'))!;
    expect(hidden.url).toContain('/users/hidden/recommendations');
    expect(hidden.url).not.toContain('/remove');
    expect(hidden.method).toBe('POST');
    expect(hidden.body).toEqual({
      movies: [{ ids: { tmdb: 603 } }],
      shows: [{ ids: { tmdb: 1399 } }],
    });
  });

  it('posts to the remove path when unhiding', async () => {
    const calls = routeFetch(() => ({ body: { deleted: { movies: 1, shows: 0, season: 0 } } }));
    await client().setHiddenFromRecommendations([{ type: 'movie', tmdbId: 603 }], false);
    expect(calls.find((c) => c.url.includes('/users/hidden'))!.url).toContain(
      '/users/hidden/recommendations/remove',
    );
  });

  it('sends nothing at all for an empty list', async () => {
    const calls = routeFetch(() => ({ body: {} }));
    await client().setHiddenFromRecommendations([], true);
    expect(calls.filter((c) => c.url.includes('/users/hidden'))).toHaveLength(0);
  });
});
