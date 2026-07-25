import { describe, expect, it } from 'vitest';
import type { ProviderHistory } from './history.js';
import { normalizeHistory } from './history.js';

const watch = (tmdb: number, over = {}) => ({
  ref: { kind: 'movie' as const, ids: { tmdb }, title: `Movie ${tmdb}` },
  watchedAt: '2024-01-01T00:00:00Z',
  ...over,
});

const rated = (tmdb: number, rating: number, kind: 'movie' | 'show' = 'movie') => ({
  ref: { kind, ids: { tmdb } },
  rating,
  ratedAt: '2024-02-01T00:00:00Z',
});

describe('folding provider ratings into watch history', () => {
  it('attaches a score to the watch it belongs to', () => {
    const histories: ProviderHistory[] = [
      { source: 'trakt', events: [watch(603)], ratings: [rated(603, 9)] },
    ];
    expect(normalizeHistory(histories)[0]!.rating).toBe(9);
  });

  it('ignores a score for something with no watch record', () => {
    const histories: ProviderHistory[] = [
      { source: 'trakt', events: [watch(603)], ratings: [rated(999, 10)] },
    ];
    const out = normalizeHistory(histories);
    expect(out).toHaveLength(1);
    expect(out[0]!.tmdbId).toBe(603);
  });

  it('keeps the higher score when two services disagree', () => {
    const histories: ProviderHistory[] = [
      { source: 'trakt', events: [watch(603)], ratings: [rated(603, 6)] },
      { source: 'simkl', events: [watch(603)], ratings: [rated(603, 9)] },
    ];
    expect(normalizeHistory(histories)[0]!.rating).toBe(9);
  });

  it('does not lower a score already carried on the watch itself', () => {
    // Letterboxd puts the score on the watch; Trakt supplies it separately.
    const histories: ProviderHistory[] = [
      { source: 'letterboxd', events: [watch(603, { rating: 10 })] },
      { source: 'trakt', events: [watch(603)], ratings: [rated(603, 4)] },
    ];
    expect(normalizeHistory(histories)[0]!.rating).toBe(10);
  });

  it('matches a show rating to a series watch', () => {
    const histories: ProviderHistory[] = [
      {
        source: 'trakt',
        events: [
          {
            ref: { kind: 'episode', ids: { tmdb: 1399 }, season: 1, number: 1 },
            watchedAt: '2024-01-01T00:00:00Z',
          },
        ],
        ratings: [rated(1399, 8, 'show')],
      },
    ];
    const out = normalizeHistory(histories);
    expect(out[0]!.type).toBe('series');
    expect(out[0]!.rating).toBe(8);
  });

  it('leaves history untouched when a provider reports no ratings', () => {
    const histories: ProviderHistory[] = [{ source: 'mdblist', events: [watch(603)] }];
    expect(normalizeHistory(histories)[0]!.rating).toBeUndefined();
  });

  it('drops a rating with no tmdb id rather than guessing', () => {
    const histories: ProviderHistory[] = [
      {
        source: 'trakt',
        events: [watch(603)],
        ratings: [{ ref: { kind: 'movie', ids: { imdb: 'tt0133093' } }, rating: 10 }],
      },
    ];
    expect(normalizeHistory(histories)[0]!.rating).toBeUndefined();
  });
});

describe('per-season watched state', () => {
  const ep = (season: number, number: number) => ({
    ref: { kind: 'episode' as const, ids: { tmdb: 1399 }, season, number },
    watchedAt: '2024-01-01T00:00:00Z',
  });

  it('records which seasons have a watched episode', () => {
    const out = normalizeHistory([{ source: 'trakt', events: [ep(1, 1), ep(1, 2), ep(3, 5)] }]);
    expect(out[0]!.seasonsWatched).toEqual([1, 3]);
  });

  it('sorts seasons regardless of the order events arrived', () => {
    const out = normalizeHistory([{ source: 'trakt', events: [ep(4, 1), ep(2, 1), ep(1, 1)] }]);
    expect(out[0]!.seasonsWatched).toEqual([1, 2, 4]);
  });

  it('merges seasons across providers', () => {
    const out = normalizeHistory([
      { source: 'trakt', events: [ep(1, 1)] },
      { source: 'stremio', events: [ep(2, 1)] },
    ]);
    expect(out[0]!.seasonsWatched).toEqual([1, 2]);
  });

  it('lists no seasons for a show reported without episodes', () => {
    const out = normalizeHistory([
      {
        source: 'simkl',
        events: [{ ref: { kind: 'show', ids: { tmdb: 1399 } }, watchedAt: null }],
      },
    ]);
    // Absent is not the same as none watched, so this stays undefined.
    expect(out[0]!.seasonsWatched).toBeUndefined();
  });

  it('leaves movies without seasons', () => {
    const out = normalizeHistory([
      { source: 'trakt', events: [{ ref: { kind: 'movie', ids: { tmdb: 603 } }, watchedAt: null }] },
    ]);
    expect(out[0]!.seasonsWatched).toBeUndefined();
  });
});
