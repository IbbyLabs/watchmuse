import { afterEach, describe, expect, it, vi } from 'vitest';
import { MdblistClient } from './mdblist.js';
import { SimklClient } from './simkl.js';

/**
 * Contract tests for the two providers whose payloads we consume most loosely.
 *
 * Both are read with optional chaining all the way down, which is forgiving of
 * a field that moves and silent about a field that disappears. The failure that
 * matters is not a crash: it is a pull that returns zero rows and looks like an
 * account with nothing in it. Recommendations then rebuild around an empty
 * history and the catalogs go quiet with nothing in the logs to explain it.
 *
 * Each fixture below is a response body in the shape the client is written
 * against, followed by the drifts worth defending against. Fixtures are held
 * here rather than pulled live so the suite stays offline and deterministic.
 */

interface Route {
  status?: number;
  body?: unknown;
}

function serve(handler: (url: string) => Route) {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url);
      const { status = 200, body } = handler(url);
      return new Response(body === undefined ? '' : JSON.stringify(body), { status });
    }),
  );
  return urls;
}

afterEach(() => vi.restoreAllMocks());

// ── MDBList ────────────────────────────────────────────────────────

const MDBLIST_WATCHED = {
  movies: [{ movie: { ids: { tmdb: 550 } } }],
  episodes: [{ episode: { season: 1, number: 2, show: { ids: { tmdb: 1399 } } } }],
  pagination: { has_more: false },
};

describe('MDBList /sync/watched contract', () => {
  it('reads the recorded shape into history events', async () => {
    serve(() => ({ body: MDBLIST_WATCHED }));
    const events = await new MdblistClient('k').pullHistory();
    expect(events).toEqual([
      { ref: { kind: 'movie', ids: { tmdb: 550 } }, watchedAt: null },
      { ref: { kind: 'episode', ids: { tmdb: 1399 }, season: 1, number: 2 }, watchedAt: null },
    ]);
  });

  it('accepts an account that has genuinely watched nothing', async () => {
    serve(() => ({ body: { movies: [], episodes: [], pagination: { has_more: false } } }));
    await expect(new MdblistClient('k').pullHistory()).resolves.toEqual([]);
  });

  it('accepts a bare empty body, which carries no evidence of drift', async () => {
    serve(() => ({ body: {} }));
    await expect(new MdblistClient('k').pullHistory()).resolves.toEqual([]);
  });

  it('refuses a renamed envelope instead of reporting an empty history', async () => {
    serve(() => ({ body: { watched_movies: [{ movie: { ids: { tmdb: 550 } } }] } }));
    await expect(new MdblistClient('k').pullHistory()).rejects.toThrow(/unrecognized/i);
  });

  it('refuses a body that is not an object at all', async () => {
    serve(() => ({ body: [{ movie: { ids: { tmdb: 550 } } }] }));
    await expect(new MdblistClient('k').pullHistory()).rejects.toThrow(/unexpected/i);
  });

  it('surfaces a rejected key rather than treating it as no history', async () => {
    serve(() => ({ status: 403, body: { error: 'nope' } }));
    await expect(new MdblistClient('k').pullHistory()).rejects.toThrow();
  });

  it('still reads rows when an unknown field is added alongside the known ones', async () => {
    serve(() => ({ body: { ...MDBLIST_WATCHED, next_cursor: 'abc' } }));
    await expect(new MdblistClient('k').pullHistory()).resolves.toHaveLength(2);
  });
});

// ── Simkl ──────────────────────────────────────────────────────────

const SIMKL_ACTIVITIES = { all: '2026-07-01T00:00:00Z' };
const SIMKL_MOVIES = {
  movies: [
    {
      last_watched_at: '2026-06-02T21:00:00Z',
      movie: { title: 'Fight Club', year: 1999, ids: { simkl: 1, tmdb: 550 } },
    },
  ],
};
const SIMKL_SHOWS = {
  shows: [
    {
      last_watched_at: '2026-06-10T20:00:00Z',
      status: 'watching',
      show: { title: 'Game of Thrones', year: 2011, ids: { simkl: 2, tmdb: 1399 } },
      seasons: [{ number: 1, episodes: [{ number: 1, watched_at: '2026-06-10T20:00:00Z' }] }],
    },
  ],
};

function simklRoutes(over: Record<string, Route> = {}) {
  return serve((url) => {
    for (const [fragment, route] of Object.entries(over)) {
      if (url.includes(fragment)) return route;
    }
    if (url.includes('/sync/activities')) return { body: SIMKL_ACTIVITIES };
    if (url.includes('/sync/all-items/movies')) return { body: SIMKL_MOVIES };
    if (url.includes('/sync/all-items/shows')) return { body: SIMKL_SHOWS };
    if (url.includes('/sync/all-items/anime')) return { body: { anime: [] } };
    return { body: {} };
  });
}

function simkl() {
  return new SimklClient({ clientId: 'id', accessToken: 'token' });
}

describe('Simkl /sync/all-items contract', () => {
  it('reads the recorded shapes into history events', async () => {
    simklRoutes();
    const events = await simkl().pullHistory();
    expect(events).toContainEqual(
      expect.objectContaining({ ref: expect.objectContaining({ kind: 'movie' }) }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        ref: expect.objectContaining({ kind: 'episode', season: 1, number: 1 }),
      }),
    );
  });

  it('fails the pull when the movie library cannot be read', async () => {
    simklRoutes({ '/sync/all-items/movies': { status: 401, body: { error: 'expired' } } });
    await expect(simkl().pullHistory()).rejects.toThrow();
  });

  it('fails the pull when a show library cannot be read', async () => {
    simklRoutes({ '/sync/all-items/shows': { status: 401, body: { error: 'expired' } } });
    await expect(simkl().pullHistory()).rejects.toThrow();
  });

  it('reports an empty library as empty, not as a failure', async () => {
    simklRoutes({
      '/sync/all-items/movies': { body: { movies: [] } },
      '/sync/all-items/shows': { body: { shows: [] } },
    });
    await expect(simkl().pullHistory()).resolves.toEqual([]);
  });

  it('reads anime returned under the shows key', async () => {
    // Simkl answers each request under its own type key, but has been seen
    // returning anime beneath `shows`. That fallback is load-bearing: without
    // it the anime library reads as empty and no error is raised.
    simklRoutes({
      '/sync/all-items/shows': { body: { shows: [] } },
      '/sync/all-items/anime': { body: { shows: SIMKL_SHOWS.shows } },
    });
    const events = await simkl().pullHistory();
    expect(events.some((e) => e.ref.kind === 'episode')).toBe(true);
  });
});
