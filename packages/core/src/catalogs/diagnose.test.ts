import { describe, expect, it } from 'vitest';
import { diagnoseCatalog } from './diagnose.js';
import type { Candidate } from '../recommendations/types.js';
import type { CatalogDef } from './types.js';

function candidate(over: Partial<Candidate>): Candidate {
  return {
    tmdbId: 1,
    type: 'movie',
    score: 1,
    fromSeeds: [],
    sources: [],
    voteAverage: 7,
    voteCount: 500,
    year: 2020,
    genreIds: [28],
    ...over,
  } as Candidate;
}

function def(over: Partial<CatalogDef>): CatalogDef {
  return {
    id: 'c',
    name: 'c',
    type: 'filter',
    mediaType: 'both',
    sources: [],
    enabled: true,
    sortOrder: 0,
    ...over,
  } as CatalogDef;
}

/** Ten action films rated 7, ten documentaries rated 5. */
const POOL: Candidate[] = [
  ...Array.from({ length: 10 }, (_, i) => candidate({ tmdbId: i + 1, genreIds: [28] })),
  ...Array.from({ length: 10 }, (_, i) =>
    candidate({ tmdbId: i + 100, genreIds: [99], voteAverage: 5 }),
  ),
];

describe('diagnoseCatalog', () => {
  it('reports the whole pool when nothing is filtered', () => {
    const d = diagnoseCatalog(POOL, def({}));
    expect(d).toMatchObject({ matched: 20, pool: 20, constraints: [] });
  });

  it('names the filter responsible when a row comes back empty', () => {
    // Documentaries exist, but none of them clear a rating floor of 7.
    const d = diagnoseCatalog(POOL, def({ filter: { genres: [99], minRating: 7 } }));
    expect(d.matched).toBe(0);
    expect(d.constraints[0]!.key).toBe('minRating');
    expect(d.constraints[0]!.withoutThis).toBe(10);
  });

  it('orders constraints by how much lifting each one would help', () => {
    const d = diagnoseCatalog(POOL, def({ filter: { genres: [99], minRating: 7 } }));
    const gains = d.constraints.map((c) => c.withoutThis);
    expect(gains).toEqual([...gains].sort((a, b) => b - a));
  });

  it('counts a media type restriction as a constraint', () => {
    const d = diagnoseCatalog(POOL, def({ mediaType: 'series' }));
    expect(d.matched).toBe(0);
    expect(d.constraints.map((c) => c.key)).toContain('mediaType');
  });

  it('ignores filters that are set but not narrowing anything', () => {
    const d = diagnoseCatalog(POOL, def({ filter: { minRating: 1 } }));
    expect(d.matched).toBe(20);
    expect(d.constraints).toEqual([{ key: 'minRating', withoutThis: 20 }]);
  });

  it('agrees with what the catalog actually serves', () => {
    const target = def({ mediaType: 'movie', filter: { genres: [28] } });
    const d = diagnoseCatalog(POOL, target);
    expect(d.matched).toBe(10);
  });

  it('respects hidden titles so the count matches the row', () => {
    const hidden = new Set(['movie:1', 'movie:2']);
    const d = diagnoseCatalog(POOL, def({ filter: { genres: [28] } }), hidden);
    expect(d.matched).toBe(8);
  });

  it('reports an empty pool without inventing constraints', () => {
    const d = diagnoseCatalog([], def({ filter: { minRating: 7 } }));
    expect(d).toMatchObject({ matched: 0, pool: 0 });
    expect(d.constraints[0]!.withoutThis).toBe(0);
  });
});
