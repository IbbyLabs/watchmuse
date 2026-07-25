import { describe, expect, it } from 'vitest';
import { credibleRating } from './rating.js';

describe('credibleRating', () => {
  it('returns 0 when there is no rating', () => {
    expect(credibleRating(undefined, 1000)).toBe(0);
  });

  it('pulls a thinly-voted high rating down toward the mean', () => {
    expect(credibleRating(9.4, 8)).toBeLessThan(7);
  });

  it('leaves a heavily-voted rating essentially intact', () => {
    expect(credibleRating(7.9, 20_000)).toBeCloseTo(7.9, 1);
  });

  it('ranks a well-known good title above an obscure "perfect" one', () => {
    expect(credibleRating(7.9, 12_000)).toBeGreaterThan(credibleRating(10, 6));
  });

  it('passes the average through when the vote count is unknown', () => {
    expect(credibleRating(9.4, undefined)).toBe(9.4);
  });
});
