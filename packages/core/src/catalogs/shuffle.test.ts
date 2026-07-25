import { describe, expect, it } from 'vitest';
import { dailySeed, elitistShuffle } from './shuffle.js';

const items = Array.from({ length: 20 }, (_, i) => i);

describe('dailySeed', () => {
  it('is stable within a calendar day', () => {
    const morning = new Date(2026, 6, 25, 8, 0, 0);
    const evening = new Date(2026, 6, 25, 23, 59, 0);
    expect(dailySeed('cat', morning)).toBe(dailySeed('cat', evening));
  });

  it('changes when the day does', () => {
    expect(dailySeed('cat', new Date(2026, 6, 25))).not.toBe(
      dailySeed('cat', new Date(2026, 6, 26)),
    );
  });

  it('differs per catalog so two rows do not permute in lockstep', () => {
    const day = new Date(2026, 6, 25);
    expect(dailySeed('a', day)).not.toBe(dailySeed('b', day));
  });
});

describe('elitistShuffle', () => {
  it('leaves the pinned head in score order', () => {
    const out = elitistShuffle(items, 1234, 3);
    expect(out.slice(0, 3)).toEqual([0, 1, 2]);
  });

  it('reorders the tail', () => {
    const out = elitistShuffle(items, 1234, 3);
    expect(out.slice(3)).not.toEqual(items.slice(3));
  });

  it('keeps every item exactly once', () => {
    const out = elitistShuffle(items, 99, 3);
    expect([...out].sort((a, b) => a - b)).toEqual(items);
  });

  it('is deterministic for a given seed', () => {
    expect(elitistShuffle(items, 42, 3)).toEqual(elitistShuffle(items, 42, 3));
  });

  it('gives a different order for a different seed', () => {
    expect(elitistShuffle(items, 42, 3)).not.toEqual(elitistShuffle(items, 43, 3));
  });

  it('handles a list shorter than the pinned count', () => {
    expect(elitistShuffle([1, 2], 42, 3)).toEqual([1, 2]);
  });

  it('handles an empty list', () => {
    expect(elitistShuffle([], 42, 3)).toEqual([]);
  });

  it('does not mutate its input', () => {
    const original = [...items];
    elitistShuffle(items, 42, 3);
    expect(items).toEqual(original);
  });
});
