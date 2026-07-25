import { describe, expect, it } from 'vitest';
import type { WatchEvent } from '../providers/types.js';
import { normalizeHistory, selectSeeds, type ProviderHistory } from './history.js';
import type { WatchedItem } from './types.js';

const movie = (tmdb: number | undefined, watchedAt: string | null, title?: string): WatchEvent => ({
  ref: { kind: 'movie', ids: tmdb ? { tmdb } : {}, title },
  watchedAt,
});

const episode = (showTmdb: number, watchedAt: string | null): WatchEvent => ({
  ref: { kind: 'episode', ids: { tmdb: showTmdb }, season: 1, number: 3 },
  watchedAt,
});

describe('normalizeHistory', () => {
  it('drops items without a tmdb id', () => {
    const out = normalizeHistory([{ source: 'trakt', events: [movie(undefined, '2024-01-01')] }]);
    expect(out).toHaveLength(0);
  });

  it('rolls episodes up to their parent series', () => {
    const out = normalizeHistory([{ source: 'trakt', events: [episode(100, '2024-01-01'), episode(100, '2024-02-01')] }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ tmdbId: 100, type: 'series' });
  });

  it('merges the same title across providers and keeps the latest watch date', () => {
    const histories: ProviderHistory[] = [
      { source: 'trakt', events: [movie(1, '2024-01-01', 'A')] },
      { source: 'simkl', events: [movie(1, '2024-06-01', 'A')] },
    ];
    const out = normalizeHistory(histories);
    expect(out).toHaveLength(1);
    expect(out[0]!.sources.sort()).toEqual(['simkl', 'trakt']);
    expect(out[0]!.watchedAt).toBe('2024-06-01');
  });

  it('treats a movie and a series with the same tmdbId as distinct', () => {
    const out = normalizeHistory([
      { source: 'trakt', events: [movie(7, '2024-01-01'), episode(7, '2024-01-02')] },
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('selectSeeds', () => {
  const item = (tmdbId: number, over: Partial<WatchedItem> = {}): WatchedItem => ({
    tmdbId,
    type: 'movie',
    sources: ['trakt'],
    ...over,
  });

  it('orders by rating desc, then watch date desc', () => {
    const seeds = selectSeeds([
      item(1, { rating: 5, watchedAt: '2020-01-01' }),
      item(2, { rating: 9, watchedAt: '2019-01-01' }),
      item(3, { watchedAt: '2024-01-01' }),
      item(4, { watchedAt: '2023-01-01' }),
    ]);
    expect(seeds.map((s) => s.tmdbId)).toEqual([2, 1, 3, 4]);
  });

  it('caps to the limit', () => {
    const many = Array.from({ length: 100 }, (_, i) => item(i + 1, { watchedAt: `2024-01-${(i % 28) + 1}` }));
    expect(selectSeeds(many, 10)).toHaveLength(10);
  });

  it('keeps series seeds when a dated-movie history would otherwise crowd them out', () => {
    const movies = Array.from({ length: 40 }, (_, i) => item(i + 1, { watchedAt: `2024-02-${(i % 28) + 1}` }));
    // Series with no watch date — the worst case for the old date-only sort.
    const series = [item(500, { type: 'series', watchedAt: null }), item(501, { type: 'series', watchedAt: null })];
    const seeds = selectSeeds([...movies, ...series], 10);
    expect(seeds.filter((s) => s.type === 'series').map((s) => s.tmdbId).sort()).toEqual([500, 501]);
  });

  it('does not seed only the lowest tmdbIds when nothing is rated or dated', () => {
    // A Simkl-style library: no ratings, no dates. Low tmdbIds skew to the oldest,
    // most-canonical titles, so an ascending-id tiebreak would recommend only old
    // content. The pick must be a spread across the library, not its oldest slice.
    const undated = Array.from({ length: 50 }, (_, i) => item(i + 1));
    const picked = selectSeeds(undated, 10).map((s) => s.tmdbId);
    expect(picked).toHaveLength(10);
    expect(picked).not.toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(Math.max(...picked)).toBeGreaterThan(10);
    // Deterministic: same library, same seeds, for clean caching.
    expect(selectSeeds(undated, 10).map((s) => s.tmdbId)).toEqual(picked);
  });

  it('spends the whole budget on one type when only that type is present', () => {
    const movies = Array.from({ length: 20 }, (_, i) => item(i + 1, { watchedAt: `2024-03-${(i % 28) + 1}` }));
    expect(selectSeeds(movies, 8)).toHaveLength(8);
  });
});
