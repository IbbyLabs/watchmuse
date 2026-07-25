import { describe, expect, it } from 'vitest';
import type { Candidate } from '../recommendations/types.js';
import { applyOrder, parseIdList } from './rank.js';

const cand = (tmdbId: number): Candidate => ({
  tmdbId,
  type: 'movie',
  score: 1,
  fromSeeds: [],
  sources: ['tmdb-similar'],
});

describe('parseIdList', () => {
  it('parses a bare JSON array', () => {
    expect(parseIdList('[3, 1, 2]')).toEqual([3, 1, 2]);
  });

  it('extracts an array from code fences and prose', () => {
    expect(parseIdList('Here you go:\n```json\n[10, 20]\n```\nEnjoy!')).toEqual([10, 20]);
  });

  it('drops non-numeric entries and returns [] on garbage', () => {
    expect(parseIdList('["a", 5, null, 7]')).toEqual([5, 7]);
    expect(parseIdList('no array here')).toEqual([]);
  });
});

describe('applyOrder', () => {
  const pool = [cand(1), cand(2), cand(3)];

  it('reorders by id and appends unlisted when keepUnlisted', () => {
    const out = applyOrder(pool, [3, 1], true).map((c) => c.tmdbId);
    expect(out).toEqual([3, 1, 2]);
  });

  it('drops unlisted when keepUnlisted is false (selection)', () => {
    const out = applyOrder(pool, [2], false).map((c) => c.tmdbId);
    expect(out).toEqual([2]);
  });

  it('ignores unknown ids and de-dupes repeats', () => {
    const out = applyOrder(pool, [99, 2, 2, 1], false).map((c) => c.tmdbId);
    expect(out).toEqual([2, 1]);
  });
});
