import { describe, expect, it } from 'vitest';
import type { Candidate } from '../recommendations/types.js';
import { applyCatalogFilter } from './filter.js';
import type { CatalogDef } from './types.js';

const cand = (over: Partial<Candidate>): Candidate => ({
  tmdbId: 1,
  type: 'movie',
  score: 1,
  fromSeeds: [],
  sources: ['tmdb-similar'],
  ...over,
});

const def = (over: Partial<CatalogDef>): CatalogDef => ({
  id: 'c1',
  name: 'Test',
  type: 'filter',
  mediaType: 'both',
  sources: ['trakt'],
  enabled: true,
  sortOrder: 0,
  ...over,
});

describe('applyCatalogFilter', () => {
  const pool: Candidate[] = [
    cand({
      tmdbId: 1,
      type: 'movie',
      score: 5,
      year: 2020,
      voteAverage: 8,
      genreIds: [878],
      popularity: 50,
    }),
    cand({
      tmdbId: 2,
      type: 'series',
      score: 9,
      year: 2010,
      voteAverage: 6,
      genreIds: [35],
      popularity: 10,
    }),
    cand({
      tmdbId: 3,
      type: 'movie',
      score: 3,
      year: 1999,
      voteAverage: 9,
      genreIds: [878, 28],
      popularity: 90,
    }),
  ];

  it('filters by media type', () => {
    const out = applyCatalogFilter(pool, def({ mediaType: 'movie' }));
    expect(out.map((c) => c.tmdbId)).toEqual([1, 3]);
  });

  it('filters by genre (any match)', () => {
    const out = applyCatalogFilter(pool, def({ filter: { genres: [878] } }));
    expect(out.map((c) => c.tmdbId).sort()).toEqual([1, 3]);
  });

  it('bridges movie/TV genre taxonomies (a movie genre id matches its series equivalent)', () => {
    const shows: Candidate[] = [
      cand({ tmdbId: 10, type: 'series', genreIds: [10765] }), // Sci-Fi & Fantasy
      cand({ tmdbId: 11, type: 'series', genreIds: [10759] }), // Action & Adventure
      cand({ tmdbId: 12, type: 'series', genreIds: [18] }), // Drama, no match
    ];
    // "Sci-Fi" (878, a movie id) must still match the series' 10765.
    expect(
      applyCatalogFilter(shows, def({ mediaType: 'series', filter: { genres: [878] } })).map(
        (c) => c.tmdbId,
      ),
    ).toEqual([10]);
    // "Fantasy" (14) also maps onto Sci-Fi & Fantasy shows.
    expect(
      applyCatalogFilter(shows, def({ mediaType: 'series', filter: { genres: [14] } })).map(
        (c) => c.tmdbId,
      ),
    ).toEqual([10]);
    // "Action"/"Adventure" (28/12) map onto Action & Adventure shows.
    expect(
      applyCatalogFilter(shows, def({ mediaType: 'series', filter: { genres: [28, 12] } })).map(
        (c) => c.tmdbId,
      ),
    ).toEqual([11]);
  });

  it('drops excluded items so the next-best candidate backfills', () => {
    const exclude = new Set(['movie:1']); // hide tmdbId 1
    const out = applyCatalogFilter(pool, def({ mediaType: 'movie' }), exclude);
    expect(out.map((c) => c.tmdbId)).toEqual([3]); // 1 gone, 3 remains
    // A series exclusion doesn't touch a movie of the same tmdbId.
    const out2 = applyCatalogFilter(pool, def({ mediaType: 'movie' }), new Set(['series:1']));
    expect(out2.map((c) => c.tmdbId)).toEqual([1, 3]);
  });

  it('filters by year range and rating', () => {
    const out = applyCatalogFilter(pool, def({ filter: { yearMin: 2005, minRating: 7 } }));
    expect(out.map((c) => c.tmdbId)).toEqual([1]); // 2020, vote 8
  });

  it('sorts by score by default, by chosen key otherwise', () => {
    expect(applyCatalogFilter(pool, def({})).map((c) => c.tmdbId)).toEqual([2, 1, 3]); // score desc
    expect(
      applyCatalogFilter(pool, def({ filter: { sort: 'rating' } })).map((c) => c.tmdbId),
    ).toEqual([3, 1, 2]);
    expect(
      applyCatalogFilter(pool, def({ filter: { sort: 'year' } })).map((c) => c.tmdbId),
    ).toEqual([1, 2, 3]);
    expect(
      applyCatalogFilter(pool, def({ filter: { sort: 'popularity' } })).map((c) => c.tmdbId),
    ).toEqual([3, 1, 2]);
  });
});

describe('applyCatalogFilter source binding', () => {
  const pool: Candidate[] = [
    cand({ tmdbId: 1, fromProviders: ['trakt'] }),
    cand({ tmdbId: 2, fromProviders: ['simkl'] }),
    cand({ tmdbId: 3, fromProviders: ['trakt', 'simkl'] }),
    cand({ tmdbId: 4, fromProviders: [] }),
  ];
  const ids = (d: CatalogDef) => applyCatalogFilter(pool, d).map((c) => c.tmdbId);

  it('keeps only what the bound connections contributed to', () => {
    expect(ids(def({ sources: ['trakt'] }))).toEqual([1, 3]);
  });

  it('keeps anything any bound connection contributed to', () => {
    expect(ids(def({ sources: ['trakt', 'simkl'] }))).toEqual([1, 2, 3]);
  });

  it('treats an empty binding as no restriction', () => {
    expect(ids(def({ sources: [] }))).toEqual([1, 2, 3, 4]);
  });

  it('shows candidates from a pool built before provenance was recorded', () => {
    const legacy = [cand({ tmdbId: 9 })]; // no fromProviders at all
    expect(applyCatalogFilter(legacy, def({ sources: ['trakt'] })).map((c) => c.tmdbId)).toEqual([
      9,
    ]);
  });
});

describe('applyCatalogFilter streaming availability', () => {
  const NETFLIX = 8;
  const DISNEY = 337;
  const pool: Candidate[] = [
    cand({ tmdbId: 1, streamingProviders: [NETFLIX] }),
    cand({ tmdbId: 2, streamingProviders: [DISNEY] }),
    cand({ tmdbId: 3, streamingProviders: [] }), // checked, streams nowhere
    cand({ tmdbId: 4 }), // never checked
  ];
  const ids = (providers?: number[]) =>
    applyCatalogFilter(pool, def({ sources: [], filter: { providers } })).map((c) => c.tmdbId);

  it('keeps only titles on a chosen service', () => {
    expect(ids([NETFLIX])).toEqual([1, 4]);
  });

  it('accepts a title on any of the chosen services', () => {
    expect(ids([NETFLIX, DISNEY])).toEqual([1, 2, 4]);
  });

  it('drops a title checked and found streaming nowhere', () => {
    expect(ids([NETFLIX])).not.toContain(3);
  });

  it('keeps a title whose availability was never looked up', () => {
    expect(ids([NETFLIX])).toContain(4);
  });

  it('ignores availability entirely when no service is chosen', () => {
    expect(ids([])).toEqual([1, 2, 3, 4]);
    expect(ids(undefined)).toEqual([1, 2, 3, 4]);
  });
});
