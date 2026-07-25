import { describe, expect, it } from 'vitest';
import { toStremioMetas } from './stremio.js';
import type { Candidate } from '../recommendations/types.js';

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  tmdbId: 603,
  type: 'movie',
  title: 'The Matrix',
  score: 10,
  fromSeeds: [1],
  sources: ['tmdb-rec'],
  ...over,
});

describe('toStremioMetas', () => {
  it('exposes the synopsis as the meta description so the catalog is self-describing', () => {
    const [meta] = toStremioMetas([candidate({ overview: 'A hacker learns the truth.', imdbId: 'tt0133093' })]);
    expect(meta).toMatchObject({ id: 'tt0133093', name: 'The Matrix', description: 'A hacker learns the truth.' });
  });

  it('omits the description when there is no synopsis', () => {
    const [meta] = toStremioMetas([candidate({ overview: undefined })]);
    expect(meta.description).toBeUndefined();
  });

  it('falls back to a tmdb id when no imdb id resolved', () => {
    const [meta] = toStremioMetas([candidate({ imdbId: null })]);
    expect(meta.id).toBe('tmdb:603');
  });
});
