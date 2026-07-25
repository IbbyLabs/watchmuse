import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidLetterboxdUsername, LetterboxdClient } from './letterboxd.js';

/**
 * A slice of a real public diary feed, recorded rather than hand-written: it
 * keeps the field names, namespaces and the published-list entries that a
 * hand-made fixture would quietly leave out.
 */
const FEED = readFileSync(
  fileURLToPath(new URL('./__fixtures__/letterboxd-diary.xml', import.meta.url)),
  'utf8',
);

function respond(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/rss+xml' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('LetterboxdClient username handling', () => {
  it('refuses a username that could reach another path', () => {
    expect(() => new LetterboxdClient('../admin')).toThrow(InvalidLetterboxdUsername);
    expect(() => new LetterboxdClient('a/b')).toThrow(InvalidLetterboxdUsername);
    expect(() => new LetterboxdClient('')).toThrow(InvalidLetterboxdUsername);
  });

  it('accepts the characters Letterboxd actually allows', () => {
    expect(() => new LetterboxdClient('dave_99')).not.toThrow();
  });

  it('requests the diary feed for that user', async () => {
    const fetchMock = vi.fn(async () => respond(FEED));
    vi.stubGlobal('fetch', fetchMock);
    await new LetterboxdClient('dave').pullHistory();
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://letterboxd.com/dave/rss/');
  });
});

describe('LetterboxdClient.pullHistory', () => {
  it('reads diary entries and ignores published lists', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(FEED)));
    const events = await new LetterboxdClient('dave').pullHistory();
    // The fixture holds four items, one of which is a list the member published.
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.ref.kind === 'movie')).toBe(true);
    expect(events.every((e) => typeof e.ref.ids.tmdb === 'number')).toBe(true);
  });

  it('converts the five-star scale to the 1-10 one used everywhere else', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(FEED)));
    const events = await new LetterboxdClient('dave').pullHistory();
    const rated = events.filter((e) => e.rating !== undefined);
    expect(rated.length).toBeGreaterThan(0);
    for (const e of rated) {
      expect(e.rating).toBeGreaterThan(0);
      expect(e.rating).toBeLessThanOrEqual(10);
    }
  });

  it('leaves the rating off an unrated watch rather than inventing a zero', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(FEED)));
    const events = await new LetterboxdClient('dave').pullHistory();
    expect(events.some((e) => e.rating === undefined)).toBe(true);
  });

  it('carries the watched date, title and year', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(FEED)));
    const [first] = await new LetterboxdClient('dave').pullHistory();
    expect(first!.watchedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof first!.ref.title).toBe('string');
    expect(first!.ref.year).toBeGreaterThan(1800);
  });

  it('returns nothing for a feed with no items', async () => {
    const empty = FEED.slice(0, FEED.indexOf('<item>')) + '</channel></rss>';
    vi.stubGlobal('fetch', vi.fn(async () => respond(empty)));
    expect(await new LetterboxdClient('dave').pullHistory()).toEqual([]);
  });

  it('throws rather than reporting an empty diary when the feed is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond('not found', 404)));
    await expect(new LetterboxdClient('dave').pullHistory()).rejects.toThrow();
  });
});

describe('LetterboxdClient.validate', () => {
  it('accepts a readable public diary', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(FEED)));
    expect(await new LetterboxdClient('dave').validate()).toBe(true);
  });

  it('reports a private or missing profile as unusable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond('nope', 404)));
    expect(await new LetterboxdClient('dave').validate()).toBe(false);
  });
});
