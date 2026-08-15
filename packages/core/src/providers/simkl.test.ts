import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimklClient } from './simkl.js';

function routeFetch(
  handler: (url: string, method: string, body: unknown) => { status?: number; body?: unknown },
) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const rec = {
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      };
      calls.push(rec);
      const { status = 200, body } = handler(rec.url, rec.method, rec.body);
      return new Response(body === undefined ? '' : JSON.stringify(body), { status });
    }),
  );
  return calls;
}

const cfg = {
  clientId: 'scid',
  clientSecret: 'ssec',
  accessToken: 'tok',
  appName: 'Watchmuse',
  appVersion: '9.9.9',
};

afterEach(() => vi.restoreAllMocks());

describe('SimklClient requests', () => {
  it('appends app-name and app-version to every request', async () => {
    const calls = routeFetch((url) =>
      url.includes('/sync/activities') ? { body: { all: 'T1' } } : { body: {} },
    );
    await new SimklClient(cfg).currentActivity();
    expect(calls[0]!.url).toContain('app-name=Watchmuse');
    expect(calls[0]!.url).toContain('app-version=9.9.9');
  });
});

describe('SimklClient.pullHistory delta', () => {
  const activities = { all: 'T2' };
  const withData = (url: string) => {
    if (url.includes('/sync/activities')) return { body: activities };
    if (url.includes('/sync/all-items/movies'))
      return {
        body: {
          movies: [{ last_watched_at: '2021-01-01T00:00:00Z', movie: { ids: { tmdb: 550 } } }],
        },
      };
    return { body: {} };
  };

  it('does a full pull and records the activity cursor when no since is given', async () => {
    const calls = routeFetch(withData);
    const client = new SimklClient(cfg);
    const events = await client.pullHistory();
    expect(events).toHaveLength(1);
    expect(client.lastActivityAll).toBe('T2');
    expect(calls.some((c) => c.url.includes('date_from'))).toBe(false);
  });

  it('skips the library entirely when the cursor is unchanged', async () => {
    const calls = routeFetch(withData);
    const events = await new SimklClient(cfg).pullHistory('T2');
    expect(events).toHaveLength(0);
    expect(calls.filter((c) => c.url.includes('/sync/all-items'))).toHaveLength(0);
  });

  it('fetches only the date_from delta when the cursor is older', async () => {
    const calls = routeFetch(withData);
    await new SimklClient(cfg).pullHistory('T1');
    expect(
      calls.some((c) => c.url.includes('/sync/all-items/movies') && c.url.includes('date_from=T1')),
    ).toBe(true);
  });

  it('prefers per-episode watched_at and falls back to the show-level date', async () => {
    routeFetch((url) => {
      if (url.includes('/sync/activities')) return { body: activities };
      if (url.includes('/sync/all-items/shows'))
        return {
          body: {
            shows: [
              {
                last_watched_at: '2023-05-06T00:00:00Z',
                show: { title: 'Show', ids: { tmdb: 1396 } },
                seasons: [
                  {
                    number: 1,
                    episodes: [{ number: 1, watched_at: '2023-05-01T00:00:00Z' }, { number: 2 }],
                  },
                ],
              },
            ],
          },
        };
      return { body: {} };
    });
    const eps = (await new SimklClient(cfg).pullHistory()).filter((e) => e.ref.kind === 'episode');
    expect(eps.map((e) => e.watchedAt)).toEqual(['2023-05-01T00:00:00Z', '2023-05-06T00:00:00Z']);
  });

  it('seeds a whole watched series Simkl declines to enumerate, and skips plan-to-watch', async () => {
    const calls = routeFetch((url) => {
      if (url.includes('/sync/activities')) return { body: activities };
      if (url.includes('/sync/all-items/shows'))
        return {
          body: {
            shows: [
              // Completed but no per-episode breakdown — must still seed the series.
              {
                last_watched_at: '2023-01-01T00:00:00Z',
                status: 'completed',
                show: { title: 'Done', ids: { tmdb: 1396 } },
              },
              // On the watchlist, never watched — must contribute nothing.
              { status: 'plantowatch', show: { title: 'Later', ids: { tmdb: 999 } } },
            ],
          },
        };
      return { body: {} };
    });
    const events = await new SimklClient(cfg).pullHistory();
    // Forces Simkl to enumerate watched episodes across every status bucket.
    expect(
      calls.some(
        (c) =>
          c.url.includes('/sync/all-items/shows') &&
          c.url.includes('include_all_episodes=yes') &&
          c.url.includes('episode_watched_at=yes'),
      ),
    ).toBe(true);
    expect(events).toEqual([
      {
        ref: { kind: 'show', ids: { tmdb: 1396 }, title: 'Done' },
        watchedAt: '2023-01-01T00:00:00Z',
      },
    ]);
  });

  it('treats the 1970 epoch placeholder as an unknown (null) date', async () => {
    routeFetch((url) => {
      if (url.includes('/sync/activities')) return { body: activities };
      if (url.includes('/sync/all-items/movies'))
        return {
          body: {
            movies: [{ last_watched_at: '1970-01-01T00:00:01Z', movie: { ids: { tmdb: 550 } } }],
          },
        };
      if (url.includes('/sync/all-items/shows'))
        return {
          body: {
            shows: [
              {
                last_watched_at: '1970-01-01T00:00:01Z',
                show: { title: 'Show', ids: { tmdb: 1396 } },
                seasons: [
                  { number: 1, episodes: [{ number: 1, watched_at: '1970-01-01T00:00:01Z' }] },
                ],
              },
            ],
          },
        };
      return { body: {} };
    });
    const events = await new SimklClient(cfg).pullHistory();
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.watchedAt === null)).toBe(true);
  });
});

describe('SimklClient redirect flow', () => {
  it('builds an authorize URL', () => {
    const url = new SimklClient(cfg).authorizeUrl('https://app/cb', 'st8');
    expect(url).toContain('https://simkl.com/oauth/authorize');
    expect(url).toContain('client_id=scid');
    expect(url).toContain('redirect_uri=https%3A%2F%2Fapp%2Fcb');
    expect(url).toContain('state=st8');
  });

  it('exchanges a code for an access token', async () => {
    routeFetch((url) =>
      url.includes('/oauth/token') ? { body: { access_token: 'newtok' } } : { body: {} },
    );
    await expect(new SimklClient(cfg).exchangeCode('code', 'https://app/cb')).resolves.toBe(
      'newtok',
    );
  });
});

describe('Simkl pullRatings', () => {
  it('reads movie, show and anime scores', async () => {
    routeFetch(() => ({
      body: {
        movies: [
          {
            user_rating: 9,
            user_rated_at: '2024-02-01T00:00:00Z',
            movie: { title: 'The Matrix', year: 1999, ids: { simkl: 1, tmdb: '603' } },
          },
        ],
        shows: [
          { user_rating: 7, show: { title: 'Game of Thrones', ids: { simkl: 2, tmdb: '1399' } } },
        ],
        anime: [{ user_rating: 10, show: { title: 'Cowboy Bebop', ids: { simkl: 3, tmdb: '30991' } } }],
      },
    }));

    const out = await new SimklClient(cfg).pullRatings();
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ rating: 9, ratedAt: '2024-02-01T00:00:00Z' });
    expect(out[0]!.ref).toMatchObject({ kind: 'movie', ids: { tmdb: 603 } });
    // Anime come back under their own key but are shows everywhere else here.
    expect(out.filter((r) => r.ref.kind === 'show')).toHaveLength(2);
  });

  it('skips an entry Simkl returned with no score', async () => {
    routeFetch(() => ({
      body: { movies: [{ user_rating: null, movie: { title: 'X', ids: { tmdb: '1' } } }] },
    }));
    expect(await new SimklClient(cfg).pullRatings()).toEqual([]);
  });

  it('reports a missing rated date as null rather than inventing one', async () => {
    routeFetch(() => ({
      body: { movies: [{ user_rating: 5, movie: { title: 'X', ids: { tmdb: '1' } } }] },
    }));
    expect((await new SimklClient(cfg).pullRatings())[0]!.ratedAt).toBeNull();
  });

  it('copes with an empty response body', async () => {
    routeFetch(() => ({ body: {} }));
    expect(await new SimklClient(cfg).pullRatings()).toEqual([]);
  });
});

describe('SimklClient.pushHistory', () => {
  // Simkl defaults a missing watched_at to the request time, so an import that
  // drops the date lands every episode on the day it was imported.
  it('carries each episode watch time', async () => {
    const calls = routeFetch(() => ({ body: {} }));
    await new SimklClient({ clientId: 'c', accessToken: 't' }).pushHistory([
      { ref: { kind: 'episode', ids: { tmdb: 1399 }, season: 1, number: 1 }, watchedAt: '2024-03-01T20:00:00Z' },
      { ref: { kind: 'episode', ids: { tmdb: 1399 }, season: 1, number: 2 }, watchedAt: '2024-03-02T20:00:00Z' },
    ]);
    const post = calls.find((c) => c.url.includes('/sync/history') && c.method === 'POST');
    const body = post!.body as {
      shows: Array<{ seasons: Array<{ episodes: Array<{ number: number; watched_at?: string }> }> }>;
    };
    expect(body.shows[0]!.seasons[0]!.episodes).toEqual([
      { number: 1, watched_at: '2024-03-01T20:00:00Z' },
      { number: 2, watched_at: '2024-03-02T20:00:00Z' },
    ]);
  });

  it('leaves an undated episode without a watch time', async () => {
    const calls = routeFetch(() => ({ body: {} }));
    await new SimklClient({ clientId: 'c', accessToken: 't' }).pushHistory([
      { ref: { kind: 'episode', ids: { tmdb: 1399 }, season: 1, number: 1 }, watchedAt: null },
    ]);
    const post = calls.find((c) => c.url.includes('/sync/history') && c.method === 'POST');
    const body = post!.body as {
      shows: Array<{ seasons: Array<{ episodes: Array<{ number: number; watched_at?: string }> }> }>;
    };
    expect(body.shows[0]!.seasons[0]!.episodes[0]!.watched_at).toBeUndefined();
  });
});

describe('a Simkl history write that goes wrong', () => {
  // A bare catch made a failed write indistinguishable from a successful one in
  // the logs. A wrong date is visible to whoever looks; a swallowed error is not.
  // 400 rather than 500: anything at or above 500 is retried with backoff, so a
  // server error makes this a slow test of the retry path instead of a fast test
  // of the failure path.
  it('counts every event as failed when the write is rejected', async () => {
    routeFetch(() => ({ status: 400 }));
    const res = await new SimklClient({ clientId: 'c', accessToken: 't' }).pushHistory([
      { ref: { kind: 'movie', ids: { tmdb: 550 } }, watchedAt: null },
      { ref: { kind: 'movie', ids: { tmdb: 680 } }, watchedAt: null },
    ]);
    expect(res).toMatchObject({ added: 0, failed: 2 });
  });

  // Simkl answers 200 and lists what it could not match, so a status check alone
  // reports unmatched titles as delivered.
  it('does not count titles Simkl says it could not find', async () => {
    routeFetch(() => ({ body: { not_found: { movies: [{ ids: { tmdb: 999 } }] } } }));
    const res = await new SimklClient({ clientId: 'c', accessToken: 't' }).pushHistory([
      { ref: { kind: 'movie', ids: { tmdb: 550 } }, watchedAt: null },
      { ref: { kind: 'movie', ids: { tmdb: 999 } }, watchedAt: null },
    ]);
    expect(res).toMatchObject({ added: 1, notFound: 1 });
  });
});
