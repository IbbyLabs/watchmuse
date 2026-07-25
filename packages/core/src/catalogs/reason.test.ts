import { describe, expect, it } from 'vitest';
import type { Candidate } from '../recommendations/types.js';
import { describeWithReason, recommendationReason } from './reason.js';

function candidate(over: Partial<Candidate>): Candidate {
  return { tmdbId: 1, type: 'movie', score: 1, fromSeeds: [], sources: [], ...over };
}

describe('recommendationReason', () => {
  it('names the seed the user watched', () => {
    expect(recommendationReason(candidate({ seedTitles: ['Arrival'] }))).toBe(
      'Because you watched Arrival',
    );
  });

  it('says "loved" only when the seed was actually rated highly', () => {
    expect(
      recommendationReason(candidate({ seedTitles: ['Arrival'], fromLovedSeed: true })),
    ).toBe('Because you loved Arrival');
    expect(
      recommendationReason(candidate({ seedTitles: ['Arrival'], fromLovedSeed: false })),
    ).toBe('Because you watched Arrival');
  });

  it('joins two seeds the way a person would', () => {
    expect(recommendationReason(candidate({ seedTitles: ['Arrival', 'Dune'] }))).toBe(
      'Because you watched Arrival and Dune',
    );
  });

  it('falls back to the originating service when no seed is named', () => {
    expect(recommendationReason(candidate({ fromProviders: ['trakt'] }))).toBe(
      'From your Trakt recommendations',
    );
  });

  it('prefers a named seed over the service', () => {
    expect(
      recommendationReason(candidate({ seedTitles: ['Dune'], fromProviders: ['trakt'] })),
    ).toBe('Because you watched Dune');
  });

  it('says nothing rather than guessing when there is no provenance', () => {
    expect(recommendationReason(candidate({}))).toBeNull();
  });
});

describe('describeWithReason', () => {
  it('puts the reason above the synopsis', () => {
    const d = describeWithReason(candidate({ seedTitles: ['Arrival'], overview: 'A synopsis.' }));
    expect(d).toBe('Because you watched Arrival.\n\nA synopsis.');
  });

  it('stands alone when there is no synopsis', () => {
    expect(describeWithReason(candidate({ seedTitles: ['Arrival'] }))).toBe(
      'Because you watched Arrival.',
    );
  });

  it('leaves the synopsis untouched when there is no reason', () => {
    expect(describeWithReason(candidate({ overview: 'A synopsis.' }))).toBe('A synopsis.');
  });

  it('returns nothing when there is neither', () => {
    expect(describeWithReason(candidate({}))).toBeUndefined();
  });
});
