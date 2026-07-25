import { describe, expect, it } from 'vitest';
import type { WatchedItem } from '../recommendations/types.js';
import { selectNewSeason, selectRewatch, type SeasonInfo } from './history-rows.js';

const NOW = new Date('2026-07-25T00:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function item(over: Partial<WatchedItem> & Pick<WatchedItem, 'tmdbId'>): WatchedItem {
  return { type: 'movie', sources: ['trakt'], ...over };
}

describe('selectRewatch', () => {
  it('offers back a title watched long enough ago', () => {
    const out = selectRewatch([item({ tmdbId: 1, watchedAt: daysAgo(900) })], NOW);
    expect(out.map((w) => w.tmdbId)).toEqual([1]);
  });

  it('leaves a recent watch alone', () => {
    const out = selectRewatch([item({ tmdbId: 1, watchedAt: daysAgo(30) })], NOW);
    expect(out).toEqual([]);
  });

  it('treats the threshold as inclusive', () => {
    expect(selectRewatch([item({ tmdbId: 1, watchedAt: daysAgo(730) })], NOW)).toHaveLength(1);
    expect(selectRewatch([item({ tmdbId: 1, watchedAt: daysAgo(729) })], NOW)).toHaveLength(0);
  });

  it('leads with what the user liked most', () => {
    const out = selectRewatch(
      [
        item({ tmdbId: 1, watchedAt: daysAgo(900), rating: 6 }),
        item({ tmdbId: 2, watchedAt: daysAgo(900), rating: 10 }),
        item({ tmdbId: 3, watchedAt: daysAgo(900) }),
      ],
      NOW,
    );
    expect(out.map((w) => w.tmdbId)).toEqual([2, 1, 3]);
  });

  it('keeps unrated watches rather than dropping them', () => {
    const out = selectRewatch([item({ tmdbId: 3, watchedAt: daysAgo(1200) })], NOW);
    expect(out.map((w) => w.tmdbId)).toEqual([3]);
  });

  it('breaks a tie by whichever has gone longest unwatched', () => {
    const out = selectRewatch(
      [
        item({ tmdbId: 1, watchedAt: daysAgo(800), rating: 9 }),
        item({ tmdbId: 2, watchedAt: daysAgo(2000), rating: 9 }),
      ],
      NOW,
    );
    expect(out.map((w) => w.tmdbId)).toEqual([2, 1]);
  });

  it('cannot use a watch with no date', () => {
    const out = selectRewatch([item({ tmdbId: 1, watchedAt: null, rating: 10 })], NOW);
    expect(out).toEqual([]);
  });

  it('ignores an unparseable date rather than treating it as ancient', () => {
    const out = selectRewatch([item({ tmdbId: 1, watchedAt: 'sometime' })], NOW);
    expect(out).toEqual([]);
  });

  it('includes series as well as movies', () => {
    const out = selectRewatch([item({ tmdbId: 9, type: 'series', watchedAt: daysAgo(900) })], NOW);
    expect(out).toHaveLength(1);
  });
});

describe('selectNewSeason', () => {
  const info = (over: Partial<SeasonInfo> = {}): SeasonInfo => ({
    status: 'Returning Series',
    seasons: [
      { seasonNumber: 0, airDate: '2019-01-01' },
      { seasonNumber: 1, airDate: '2020-01-01' },
      { seasonNumber: 2, airDate: '2022-01-01' },
    ],
    ...over,
  });

  const show = (over: Partial<WatchedItem> = {}) =>
    item({ tmdbId: 1399, type: 'series', watchedAt: daysAgo(400), ...over });

  it('names the newest season the user has not watched', () => {
    const out = selectNewSeason([show({ seasonsWatched: [1] })], new Map([[1399, info()]]), NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ seasonNumber: 2, certain: true });
  });

  it('says nothing when the user is caught up', () => {
    const out = selectNewSeason([show({ seasonsWatched: [1, 2] })], new Map([[1399, info()]]), NOW);
    expect(out).toEqual([]);
  });

  it('ignores specials, which are not a season anyone waits for', () => {
    // Season 0 has aired and is unwatched, but only seasons 1 and 2 count.
    const out = selectNewSeason([show({ seasonsWatched: [1, 2] })], new Map([[1399, info()]]), NOW);
    expect(out).toEqual([]);
  });

  it('ignores a season that has not aired yet', () => {
    const future = info({
      seasons: [
        { seasonNumber: 1, airDate: '2020-01-01' },
        { seasonNumber: 2, airDate: '2030-01-01' },
      ],
    });
    const out = selectNewSeason([show({ seasonsWatched: [1] })], new Map([[1399, future]]), NOW);
    expect(out).toEqual([]);
  });

  it('ignores a season with no air date at all', () => {
    const undated = info({
      seasons: [
        { seasonNumber: 1, airDate: '2020-01-01' },
        { seasonNumber: 2, airDate: null },
      ],
    });
    const out = selectNewSeason([show({ seasonsWatched: [1] })], new Map([[1399, undated]]), NOW);
    expect(out).toEqual([]);
  });

  it('falls back to a returning series when the provider reports no episodes', () => {
    const out = selectNewSeason([show()], new Map([[1399, info()]]), NOW);
    expect(out[0]).toMatchObject({ certain: false });
    expect(out[0]!.seasonNumber).toBeUndefined();
  });

  it('does not guess for a series that has ended', () => {
    const out = selectNewSeason([show()], new Map([[1399, info({ status: 'Ended' })]]), NOW);
    expect(out).toEqual([]);
  });

  it('puts the sure things before the guesses', () => {
    const out = selectNewSeason(
      [
        item({ tmdbId: 1, type: 'series' }),
        item({ tmdbId: 2, type: 'series', seasonsWatched: [1] }),
      ],
      new Map([
        [1, info()],
        [2, info()],
      ]),
      NOW,
    );
    expect(out.map((h) => [h.item.tmdbId, h.certain])).toEqual([
      [2, true],
      [1, false],
    ]);
  });

  it('skips movies', () => {
    const out = selectNewSeason([item({ tmdbId: 603 })], new Map([[603, info()]]), NOW);
    expect(out).toEqual([]);
  });

  it('skips a series TMDB told us nothing about', () => {
    expect(selectNewSeason([show()], new Map(), NOW)).toEqual([]);
  });
});
