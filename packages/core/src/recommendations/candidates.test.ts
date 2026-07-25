import { describe, expect, it } from 'vitest';
import { scoreCandidates } from './candidates.js';
import type { RawCandidate, WatchedItem } from './types.js';

const watched = (tmdbId: number, type: WatchedItem['type'] = 'movie'): WatchedItem => ({
  tmdbId,
  type,
  sources: ['trakt'],
});

const raw = (tmdbId: number, over: Partial<RawCandidate> = {}): RawCandidate => ({
  tmdbId,
  type: 'movie',
  source: 'tmdb-similar',
  ...over,
});

describe('scoreCandidates', () => {
  it('excludes titles the user has already watched', () => {
    const out = scoreCandidates([raw(1, { fromSeed: 10 }), raw(2, { fromSeed: 10 })], [watched(1)]);
    expect(out.map((c) => c.tmdbId)).toEqual([2]);
  });

  it('ranks a title recommended by more seeds higher', () => {
    const out = scoreCandidates(
      [
        raw(1, { fromSeed: 10 }),
        raw(1, { fromSeed: 11 }), // two distinct seeds
        raw(2, { fromSeed: 10 }), // one seed
      ],
      [],
    );
    expect(out[0]!.tmdbId).toBe(1);
    expect(out[0]!.fromSeeds).toEqual([10, 11]);
    expect(out[0]!.score).toBeGreaterThan(out[1]!.score);
  });

  it('rewards agreement between independent services', () => {
    const out = scoreCandidates(
      [
        raw(1, { fromSeed: 10, source: 'tmdb-similar' }),
        raw(1, { fromSeed: 10, source: 'trakt-rec' }),
        raw(2, { fromSeed: 10, source: 'tmdb-similar' }),
      ],
      [],
    );
    const one = out.find((c) => c.tmdbId === 1)!;
    const two = out.find((c) => c.tmdbId === 2)!;
    expect(one.sources).toEqual(['tmdb-similar', 'trakt-rec']);
    expect(one.score).toBeGreaterThan(two.score);
  });

  it('does not count two TMDB endpoints as two opinions', () => {
    const out = scoreCandidates(
      [
        raw(1, { fromSeed: 10, source: 'tmdb-similar' }),
        raw(1, { fromSeed: 10, source: 'tmdb-rec' }),
        raw(2, { fromSeed: 10, source: 'tmdb-similar' }),
      ],
      [],
    );
    const one = out.find((c) => c.tmdbId === 1)!;
    const two = out.find((c) => c.tmdbId === 2)!;
    expect(one.sources).toEqual(['tmdb-rec', 'tmdb-similar']); // provenance kept
    expect(one.score).toBe(two.score); // but scored as one source
  });

  it('does not let a thinly-voted title outrank a well-known one', () => {
    const out = scoreCandidates(
      [
        raw(1, { fromSeed: 10, voteAverage: 9.4, voteCount: 8 }),
        raw(2, { fromSeed: 10, voteAverage: 7.9, voteCount: 12_000 }),
      ],
      [],
    );
    expect(out[0]!.tmdbId).toBe(2);
  });

  it('weighs a recently-watched seed above a long-past one', () => {
    const history: WatchedItem[] = [
      { tmdbId: 10, type: 'movie', sources: ['trakt'], watchedAt: '2026-07-01T00:00:00Z' },
      { tmdbId: 11, type: 'movie', sources: ['trakt'], watchedAt: '2018-07-01T00:00:00Z' },
    ];
    const out = scoreCandidates([raw(1, { fromSeed: 10 }), raw(2, { fromSeed: 11 })], history);
    expect(out[0]!.tmdbId).toBe(1);
    expect(out[0]!.score).toBeGreaterThan(out[1]!.score);
  });

  it('does not penalise seeds whose watch date is unknown', () => {
    const history: WatchedItem[] = [
      { tmdbId: 10, type: 'movie', sources: ['simkl'], watchedAt: '2026-07-01T00:00:00Z' },
      { tmdbId: 11, type: 'movie', sources: ['simkl'], watchedAt: null },
    ];
    const out = scoreCandidates([raw(1, { fromSeed: 10 }), raw(2, { fromSeed: 11 })], history);
    expect(out[0]!.score).toBe(out[1]!.score);
  });

  it('separates movie and series with the same tmdbId', () => {
    const out = scoreCandidates(
      [raw(5, { type: 'movie', fromSeed: 1 }), raw(5, { type: 'series', fromSeed: 1 })],
      [watched(5, 'movie')],
    );
    // the watched movie:5 is excluded, series:5 survives
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ tmdbId: 5, type: 'series' });
  });

  it('carries the TMDB overview through to the scored candidate', () => {
    const out = scoreCandidates(
      [raw(1, { fromSeed: 10 }), raw(1, { fromSeed: 11, overview: 'A synopsis.' })],
      [],
    );
    expect(out[0]!.overview).toBe('A synopsis.');
  });

  it('is deterministic (stable order for equal scores)', () => {
    const input = [raw(3, { fromSeed: 1 }), raw(2, { fromSeed: 1 }), raw(9, { fromSeed: 1 })];
    const a = scoreCandidates(input, []).map((c) => c.tmdbId);
    const b = scoreCandidates([...input].reverse(), []).map((c) => c.tmdbId);
    expect(a).toEqual(b);
    expect(a).toEqual([2, 3, 9]); // equal score -> ascending tmdbId
  });
});

describe('scoreCandidates provenance', () => {
  it('records which connections led to a candidate, through its seeds', () => {
    const history: WatchedItem[] = [
      { tmdbId: 10, type: 'movie', sources: ['trakt'] },
      { tmdbId: 11, type: 'movie', sources: ['simkl', 'pmdb'] },
    ];
    const out = scoreCandidates([raw(1, { fromSeed: 10 }), raw(2, { fromSeed: 11 })], history);
    expect(out.find((c) => c.tmdbId === 1)!.fromProviders).toEqual(['trakt']);
    expect(out.find((c) => c.tmdbId === 2)!.fromProviders).toEqual(['pmdb', 'simkl']);
  });

  it('merges the connections behind every seed that surfaced a candidate', () => {
    const history: WatchedItem[] = [
      { tmdbId: 10, type: 'movie', sources: ['trakt'] },
      { tmdbId: 11, type: 'movie', sources: ['simkl'] },
    ];
    const out = scoreCandidates([raw(1, { fromSeed: 10 }), raw(1, { fromSeed: 11 })], history);
    expect(out[0]!.fromProviders).toEqual(['simkl', 'trakt']);
  });

  it('attributes account-level recommendations to their own service', () => {
    const out = scoreCandidates([raw(1, { source: 'trakt-rec' })], []);
    expect(out[0]!.fromProviders).toEqual(['trakt']);
  });

  it('carries the seed titles that explain the recommendation', () => {
    const history: WatchedItem[] = [{ tmdbId: 10, type: 'movie', title: 'Arrival', sources: ['trakt'] }];
    const out = scoreCandidates([raw(1, { fromSeed: 10 })], history);
    expect(out[0]!.seedTitles).toEqual(['Arrival']);
    expect(out[0]!.fromLovedSeed).toBe(false);
  });

  it('marks a seed as loved when the user rated it highly', () => {
    const history: WatchedItem[] = [
      { tmdbId: 10, type: 'movie', title: 'Arrival', rating: 9, sources: ['trakt'] },
    ];
    const out = scoreCandidates([raw(1, { fromSeed: 10 })], history);
    expect(out[0]!.fromLovedSeed).toBe(true);
  });

  it('names the most recently watched seed first', () => {
    const history: WatchedItem[] = [
      { tmdbId: 10, type: 'movie', title: 'Older', watchedAt: '2018-01-01', sources: ['trakt'] },
      { tmdbId: 11, type: 'movie', title: 'Newer', watchedAt: '2025-01-01', sources: ['trakt'] },
    ];
    const out = scoreCandidates([raw(1, { fromSeed: 10 }), raw(1, { fromSeed: 11 })], history);
    expect(out[0]!.seedTitles).toEqual(['Newer', 'Older']);
  });

  it('leaves the seed titles off when the history has no title for them', () => {
    const history: WatchedItem[] = [{ tmdbId: 10, type: 'movie', sources: ['trakt'] }];
    const out = scoreCandidates([raw(1, { fromSeed: 10 })], history);
    expect(out[0]!.seedTitles).toBeUndefined();
  });
});
