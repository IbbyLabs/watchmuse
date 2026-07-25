import { describe, expect, it } from 'vitest';
import { renderPosterUrl, validateArtworkTemplate } from './artwork.js';

const matrix = { imdbId: 'tt0133093', tmdbId: 603, type: 'movie' as const };
const noImdb = { imdbId: null, tmdbId: 603, type: 'series' as const };

describe('renderPosterUrl', () => {
  it('fills {id} with the imdb id when present', () => {
    expect(renderPosterUrl('https://x/poster/{id}.jpg', matrix)).toBe('https://x/poster/tt0133093.jpg');
  });

  it('fills {id} with tmdb: fallback when there is no imdb id', () => {
    expect(renderPosterUrl('https://x/poster/{id}.jpg', noImdb)).toBe('https://x/poster/tmdb:603.jpg');
  });

  it('fills {imdb}, {tmdb} and {type}', () => {
    expect(renderPosterUrl('https://x/{type}/{tmdb}/{imdb}.jpg', matrix)).toBe('https://x/movie/603/tt0133093.jpg');
  });

  it('returns null when {imdb} is required but missing, so the caller can fall back', () => {
    expect(renderPosterUrl('https://x/imdb/{imdb}.jpg', noImdb)).toBeNull();
  });

  it('replaces every occurrence of a placeholder', () => {
    expect(renderPosterUrl('https://x/{tmdb}/{tmdb}.jpg', matrix)).toBe('https://x/603/603.jpg');
  });
});

describe('validateArtworkTemplate', () => {
  it('accepts a valid https template', () => {
    expect(validateArtworkTemplate('https://x/poster/{id}.jpg')).toBeNull();
  });

  it('accepts a RatingPosterDB-style template with a literal key segment', () => {
    expect(validateArtworkTemplate('https://api.ratingposterdb.com/YOUR-KEY/imdb/poster-default/{imdb}.jpg')).toBeNull();
  });

  it('rejects an empty template', () => {
    expect(validateArtworkTemplate('   ')).toEqual({ code: 'empty' });
  });

  it('rejects plain http', () => {
    expect(validateArtworkTemplate('http://x/poster/{id}.jpg')).toEqual({ code: 'not_https' });
  });

  it('rejects a template with no placeholder', () => {
    expect(validateArtworkTemplate('https://x/poster.jpg')).toEqual({ code: 'no_placeholder' });
  });

  it('rejects an unknown placeholder and reports it', () => {
    expect(validateArtworkTemplate('https://x/{imbd}.jpg')).toEqual({ code: 'unknown_placeholder', detail: 'imbd' });
  });

  it('rejects an over-long template', () => {
    expect(validateArtworkTemplate(`https://x/${'a'.repeat(600)}/{id}.jpg`)).toEqual({ code: 'too_long' });
  });
});
