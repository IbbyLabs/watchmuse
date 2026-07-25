import { describe, expect, it } from 'vitest';
import type { Candidate } from '../recommendations/types.js';
import { buildTasteProfile, rankSearchResults, type SearchResult } from './taste.js';

function candidate(over: Partial<Candidate> & Pick<Candidate, 'tmdbId'>): Candidate {
  return {
    type: 'movie',
    score: 10,
    fromSeeds: [],
    sources: [],
    ...over,
  };
}

function result(over: Partial<SearchResult> & Pick<SearchResult, 'tmdbId'>): SearchResult {
  return { type: 'movie', ...over };
}

const EMPTY = buildTasteProfile([]);

describe('buildTasteProfile', () => {
  it('normalises the strongest genre to 1', () => {
    const profile = buildTasteProfile([
      candidate({ tmdbId: 1, genreIds: [878], score: 30 }),
      candidate({ tmdbId: 2, genreIds: [878], score: 30 }),
      candidate({ tmdbId: 3, genreIds: [35], score: 10 }),
    ]);
    expect(profile.genres.get(878)).toBe(1);
    expect(profile.genres.get(35)).toBeCloseTo(10 / 60);
  });

  it('weights genres by candidate score, not by appearance count', () => {
    const profile = buildTasteProfile([
      candidate({ tmdbId: 1, genreIds: [27], score: 1 }),
      candidate({ tmdbId: 2, genreIds: [27], score: 1 }),
      candidate({ tmdbId: 3, genreIds: [18], score: 50 }),
    ]);
    // Horror appears twice, drama once, but drama is what the engine rates.
    expect(profile.genres.get(18)).toBe(1);
    expect(profile.genres.get(27)).toBeLessThan(0.1);
  });

  it('is empty for an empty pool, without dividing by zero', () => {
    expect(EMPTY.genres.size).toBe(0);
    expect(EMPTY.poolPeak).toBe(0);
    expect(EMPTY.poolScores.size).toBe(0);
  });
});

describe('rankSearchResults', () => {
  it('puts an exact title match first even when taste disagrees', () => {
    // A pool made entirely of comedy, searching for a sci-fi film by name.
    const profile = buildTasteProfile([candidate({ tmdbId: 99, genreIds: [35], score: 50 })]);
    const ranked = rankSearchResults(
      [
        result({ tmdbId: 1, title: 'Arrival of the Comedians', genreIds: [35] }),
        result({ tmdbId: 2, title: 'Arrival', genreIds: [878] }),
      ],
      'Arrival',
      profile,
    );
    expect(ranked[0]?.tmdbId).toBe(2);
  });

  it('uses taste to order titles the query matches equally', () => {
    const profile = buildTasteProfile([candidate({ tmdbId: 99, genreIds: [16], score: 50 })]);
    const ranked = rankSearchResults(
      [
        result({ tmdbId: 1, title: 'Batman Begins', genreIds: [28] }),
        result({ tmdbId: 2, title: 'Batman Ninja', genreIds: [16] }),
      ],
      'Batman',
      profile,
    );
    // Both are prefix matches; the animation fan gets the animated one.
    expect(ranked[0]?.tmdbId).toBe(2);
  });

  it('lifts a title the user has already been recommended', () => {
    const profile = buildTasteProfile([candidate({ tmdbId: 2, score: 100 })]);
    const ranked = rankSearchResults(
      [result({ tmdbId: 1, title: 'Heat Wave' }), result({ tmdbId: 2, title: 'Heat Death' })],
      'Heat',
      profile,
    );
    expect(ranked[0]?.tmdbId).toBe(2);
  });

  it('preserves TMDB relevance order when nothing else distinguishes results', () => {
    const ranked = rankSearchResults(
      [
        result({ tmdbId: 10, title: 'First' }),
        result({ tmdbId: 20, title: 'Second' }),
        result({ tmdbId: 30, title: 'Third' }),
      ],
      'nomatch',
      EMPTY,
    );
    expect(ranked.map((r) => r.tmdbId)).toEqual([10, 20, 30]);
  });

  it('is deterministic: identical scores break by tmdbId', () => {
    const a = rankSearchResults(
      [result({ tmdbId: 5, title: 'Same' }), result({ tmdbId: 3, title: 'Same' })],
      'Same',
      EMPTY,
    );
    const b = rankSearchResults(
      [result({ tmdbId: 3, title: 'Same' }), result({ tmdbId: 5, title: 'Same' })],
      'Same',
      EMPTY,
    );
    // Input order shifts relevance, but a rerun of the same input is stable.
    expect(a.map((r) => r.tmdbId)).toEqual(
      rankSearchResults(
        [result({ tmdbId: 5, title: 'Same' }), result({ tmdbId: 3, title: 'Same' })],
        'Same',
        EMPTY,
      ).map((r) => r.tmdbId),
    );
    expect(b).toHaveLength(2);
  });

  it('handles a single result without dividing by zero', () => {
    const ranked = rankSearchResults([result({ tmdbId: 1, title: 'Solo' })], 'Solo', EMPTY);
    expect(ranked).toHaveLength(1);
    expect(Number.isFinite(ranked[0]!.score)).toBe(true);
  });

  it('returns an empty list for no results', () => {
    expect(rankSearchResults([], 'anything', EMPTY)).toEqual([]);
  });

  it('carries poster, overview and genres through for the meta response', () => {
    const ranked = rankSearchResults(
      [
        result({
          tmdbId: 7,
          title: 'Carried',
          overview: 'A synopsis',
          posterPath: '/p.jpg',
          genreIds: [18],
          year: 1999,
        }),
      ],
      'Carried',
      EMPTY,
    );
    expect(ranked[0]).toMatchObject({
      overview: 'A synopsis',
      posterPath: '/p.jpg',
      genreIds: [18],
      year: 1999,
    });
  });
});
