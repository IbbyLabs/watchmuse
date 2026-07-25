import { describe, expect, it } from 'vitest';
import { buildEraProfile, eraAffinity } from './era.js';
import type { WatchedItem } from './types.js';

const watched = (year?: number): WatchedItem => ({
  tmdbId: Math.random() * 1e9,
  type: 'movie',
  sources: ['trakt'],
  year,
});

const modern = [2019, 2020, 2021, 2022, 2023, 2024].map(watched);

describe('buildEraProfile', () => {
  it('scores the era someone actually watches highest', () => {
    const p = buildEraProfile(modern);
    expect(eraAffinity(p, 2021)).toBe(1);
  });

  it('scores a distant era far lower than the one they watch', () => {
    const p = buildEraProfile(modern);
    expect(eraAffinity(p, 1955)).toBeLessThan(eraAffinity(p, 2021));
  });

  it('does not cliff at a bucket boundary', () => {
    const p = buildEraProfile(modern);
    expect(eraAffinity(p, 2016)).toBeGreaterThan(0);
  });

  it('follows the user rather than favouring new releases', () => {
    const classics = [1958, 1961, 1962, 1965, 1967].map(watched);
    const p = buildEraProfile(classics);
    expect(eraAffinity(p, 1962)).toBeGreaterThan(eraAffinity(p, 2024));
  });

  it('has no opinion when the history carries no years', () => {
    const p = buildEraProfile([watched(), watched()]);
    expect(eraAffinity(p, 1930)).toBe(1);
    expect(eraAffinity(p, 2024)).toBe(1);
  });

  it('stays neutral on a candidate with no year', () => {
    const p = buildEraProfile(modern);
    const neutral = eraAffinity(p, undefined);
    expect(neutral).toBeGreaterThan(eraAffinity(p, 1930));
    expect(neutral).toBeLessThan(eraAffinity(p, 2021));
  });
});
