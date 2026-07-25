import { afterEach, describe, expect, it, vi } from 'vitest';
import { StremioClient, StremioLinkPending, StremioSessionInvalid } from './stremio.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A library entry as api.strem.io actually returns one. */
function item(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: 'tt0133093',
    name: 'The Matrix',
    type: 'movie',
    removed: false,
    temp: false,
    state: { timesWatched: 1, lastWatched: '2026-01-02T03:04:05.000Z' },
    ...over,
  };
}

const library = (items: Array<Record<string, unknown>>) => json({ result: items });

afterEach(() => vi.unstubAllGlobals());

describe('StremioClient pairing', () => {
  it('asks Stremio for a link code and reports where to approve it', async () => {
    const fetchMock = vi.fn(async () =>
      json({ result: { code: 'O6MN', link: 'https://link.stremio.com/O6MN', qrcode: 'x' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const code = await StremioClient.startLink();
    expect(String(fetchMock.mock.calls[0]![0])).toContain('link.stremio.com/api/v2/create');
    expect(code.userCode).toBe('O6MN');
    expect(code.verificationUrl).toBe('https://link.stremio.com/O6MN');
  });

  it('returns the session key once the code is approved', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ result: { authKey: 'sess-123' } })));
    expect(await StremioClient.completeLink('O6MN')).toBe('sess-123');
  });

  it('reports an unapproved code as pending rather than failing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: { code: 101, message: 'Invalid or expired token' } })),
    );
    await expect(StremioClient.completeLink('O6MN')).rejects.toBeInstanceOf(StremioLinkPending);
  });

  it('never sends a password anywhere', async () => {
    const fetchMock = vi.fn(async () => json({ result: { authKey: 'sess-123' } }));
    vi.stubGlobal('fetch', fetchMock);
    await StremioClient.startLink().catch(() => undefined);
    await StremioClient.completeLink('O6MN');
    const sent = JSON.stringify(fetchMock.mock.calls);
    expect(sent).not.toContain('password');
    expect(sent).not.toContain('email');
  });
});

describe('StremioClient.pullHistory', () => {
  it('keeps only items Stremio counts as watched', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        library([
          item({ _id: 'tt1', state: { timesWatched: 2 } }),
          // Saved for later, never played: in the library but not watched.
          item({ _id: 'tt2', state: { timesWatched: 0 } }),
        ]),
      ),
    );
    const events = await new StremioClient('k').pullHistory();
    expect(events.map((e) => e.ref.ids.imdb)).toEqual(['tt1']);
  });

  it('drops items the user removed from their library', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => library([item({ removed: true })])));
    expect(await new StremioClient('k').pullHistory()).toEqual([]);
  });

  it('drops the non-video entries Stremio keeps for other addons', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => library([item({ type: 'other' })])));
    expect(await new StremioClient('k').pullHistory()).toEqual([]);
  });

  it('ignores ids from addons with their own id space', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => library([item({ _id: 'kitsu:12345' }), item({ _id: 'tt7' })])),
    );
    const events = await new StremioClient('k').pullHistory();
    expect(events.map((e) => e.ref.ids.imdb)).toEqual(['tt7']);
  });

  it('maps a series to a show reference, not a movie', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => library([item({ type: 'series' })])));
    const [ev] = await new StremioClient('k').pullHistory();
    expect(ev!.ref.kind).toBe('show');
  });

  it('resolves the IMDb id to a TMDB id when a resolver is given', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => library([item()])));
    const resolve = vi.fn(async () => 603);
    const [ev] = await new StremioClient('k', resolve).pullHistory();
    expect(resolve).toHaveBeenCalledWith('tt0133093', 'movie');
    expect(ev!.ref.ids.tmdb).toBe(603);
  });

  it('still returns the item when TMDB cannot resolve it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => library([item()])));
    const [ev] = await new StremioClient('k', async () => null).pullHistory();
    expect(ev!.ref.ids.tmdb).toBeUndefined();
    expect(ev!.ref.ids.imdb).toBe('tt0133093');
  });

  it('carries the last watched date', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => library([item()])));
    const [ev] = await new StremioClient('k').pullHistory();
    expect(ev!.watchedAt).toBe('2026-01-02T03:04:05.000Z');
  });

  it('treats a rejected session as invalid rather than an empty library', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: { code: 1, message: 'Session does not exist' } })),
    );
    await expect(new StremioClient('k').pullHistory()).rejects.toBeInstanceOf(
      StremioSessionInvalid,
    );
  });

  it('sends the library request Stremio expects', async () => {
    const fetchMock = vi.fn(async () => library([]));
    vi.stubGlobal('fetch', fetchMock);
    await new StremioClient('sess-123').pullHistory();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://api.strem.io/api/datastoreGet');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      authKey: 'sess-123',
      collection: 'libraryItem',
      all: true,
      ids: [],
    });
  });
});

describe('StremioClient.validate', () => {
  it('accepts a working session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => library([])));
    expect(await new StremioClient('k').validate()).toBe(true);
  });

  it('rejects a dead session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 1, message: 'gone' } })));
    expect(await new StremioClient('k').validate()).toBe(false);
  });
});
