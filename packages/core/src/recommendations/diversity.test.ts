import { describe, expect, it } from 'vitest';
import { diversify } from './diversity.js';
import type { Candidate } from './types.js';

const cand = (tmdbId: number, over: Partial<Candidate> = {}): Candidate => ({
  tmdbId,
  type: 'movie',
  score: 10,
  fromSeeds: [],
  sources: ['tmdb-similar'],
  ...over,
});

/**
 * What clustering actually looks like: one seed returns a run of lookalikes that
 * all carry the same evidence, so their scores sit within a point or two of each
 * other, and a title from a different seed trails just behind them.
 */
const oneSeedFlood: Candidate[] = [
  ...Array.from({ length: 10 }, (_, i) => cand(i + 1, { score: 24 - i * 0.2, fromSeeds: [100] })),
  cand(99, { score: 21.5, fromSeeds: [200] }),
];

describe('diversify', () => {
  it('keeps every candidate', () => {
    const out = diversify(oneSeedFlood);
    expect(out).toHaveLength(oneSeedFlood.length);
    expect(out.map((c) => c.tmdbId).sort((a, b) => a - b)).toEqual(
      oneSeedFlood.map((c) => c.tmdbId).sort((a, b) => a - b),
    );
  });

  it('breaks up a run from a single seed', () => {
    const out = diversify(oneSeedFlood);
    const other = out.findIndex((c) => c.tmdbId === 99);
    expect(other).toBeLessThan(4); // last of eleven on score alone
  });

  it('leaves a candidate a whole tier of evidence behind where it was', () => {
    const input = [
      ...Array.from({ length: 5 }, (_, i) =>
        cand(i + 1, { score: 30 - i * 0.2, fromSeeds: [100] }),
      ),
      cand(99, { score: 14, fromSeeds: [200] }), // a tier below, not a near miss
    ];
    expect(diversify(input).at(-1)!.tmdbId).toBe(99);
  });

  it('still leads with the strongest candidate', () => {
    const out = diversify(oneSeedFlood);
    expect(out[0]!.tmdbId).toBe(1);
  });

  it('mixes up a row that is all one genre', () => {
    const input = [
      ...Array.from({ length: 8 }, (_, i) =>
        cand(i + 1, { score: 24 - i * 0.2, fromSeeds: [i], genreIds: [27] }),
      ),
      cand(50, { score: 22, fromSeeds: [90], genreIds: [35] }),
    ];
    const out = diversify(input);
    expect(out.findIndex((c) => c.tmdbId === 50)).toBeLessThan(8); // last on score alone
  });

  it('leaves a row with nothing in common in score order', () => {
    const input = [
      cand(1, { score: 30, fromSeeds: [1], genreIds: [18] }),
      cand(2, { score: 20, fromSeeds: [2], genreIds: [35] }),
      cand(3, { score: 10, fromSeeds: [3], genreIds: [27] }),
    ];
    expect(diversify(input).map((c) => c.tmdbId)).toEqual([1, 2, 3]);
  });

  it('is deterministic', () => {
    const a = diversify(oneSeedFlood).map((c) => c.tmdbId);
    const b = diversify(oneSeedFlood).map((c) => c.tmdbId);
    expect(a).toEqual(b);
  });

  it('leaves a very short row alone', () => {
    const input = [cand(1, { score: 5 }), cand(2, { score: 4 })];
    expect(diversify(input).map((c) => c.tmdbId)).toEqual([1, 2]);
  });

  it('handles a large pool without falling over', () => {
    const big = Array.from({ length: 2000 }, (_, i) =>
      cand(i + 1, { score: 2000 - i, fromSeeds: [i % 7], genreIds: [i % 5] }),
    );
    const out = diversify(big);
    expect(out).toHaveLength(2000);
    expect(new Set(out.map((c) => c.tmdbId)).size).toBe(2000);
  });
});
