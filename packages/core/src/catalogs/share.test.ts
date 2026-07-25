import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { CatalogDef } from './types.js';
import { InvalidShareCode, decodeShare, encodeShare } from './share.js';

function def(over: Partial<CatalogDef> = {}): CatalogDef {
  return {
    id: 'id-1',
    name: 'Great documentaries',
    type: 'filter',
    mediaType: 'movie',
    filter: { genres: [99], minRating: 7, sort: 'score' },
    sources: ['trakt'],
    enabled: true,
    sortOrder: 0,
    ...over,
  };
}

describe('encodeShare', () => {
  it('round-trips catalogs', () => {
    const out = decodeShare(encodeShare({ catalogs: [def()] }));
    expect(out.catalogs).toHaveLength(1);
    expect(out.catalogs[0]).toMatchObject({
      name: 'Great documentaries',
      mediaType: 'movie',
      filter: { genres: [99], minRating: 7, sort: 'score' },
      sources: ['trakt'],
    });
  });

  it('drops the catalog id so the importer mints its own', () => {
    expect(JSON.stringify(decodeShare(encodeShare({ catalogs: [def()] })))).not.toContain('id-1');
  });

  it('carries the artwork template and region when set', () => {
    const out = decodeShare(
      encodeShare({
        catalogs: [],
        artworkTemplate: 'https://extendedratings.com/poster/{id}.jpg',
        watchRegion: 'GB',
      }),
    );
    expect(out.artworkTemplate).toBe('https://extendedratings.com/poster/{id}.jpg');
    expect(out.watchRegion).toBe('GB');
  });

  it('round-trips a natural-language catalog with its prompt', () => {
    const out = decodeShare(
      encodeShare({ catalogs: [def({ type: 'nl', prompt: 'slow burn thrillers', filter: undefined })] }),
    );
    expect(out.catalogs[0]).toMatchObject({ type: 'nl', prompt: 'slow burn thrillers' });
  });

  it('produces a prefixed, url-safe string', () => {
    const code = encodeShare({ catalogs: [def()] });
    expect(code.startsWith('wm1.')).toBe(true);
    expect(code).toMatch(/^wm1\.[A-Za-z0-9_-]+$/);
  });
});

describe('decodeShare rejects what it cannot trust', () => {
  it('refuses a string with the wrong prefix', () => {
    expect(() => decodeShare('nope.abc')).toThrow(InvalidShareCode);
  });

  it('refuses gibberish', () => {
    expect(() => decodeShare('wm1.not-actually-gzip')).toThrow(InvalidShareCode);
  });

  it('refuses an empty string', () => {
    expect(() => decodeShare('')).toThrow(InvalidShareCode);
  });

  it('refuses a payload from a different version', () => {
    const code = `wm1.${gzipSync(Buffer.from(JSON.stringify({ version: 99, catalogs: [] }))).toString('base64url')}`;
    expect(() => decodeShare(code)).toThrow(/different version/);
  });

  it('refuses an absurdly long paste without inflating it', () => {
    expect(() => decodeShare(`wm1.${'A'.repeat(30_000)}`)).toThrow(/too long/);
  });
});

describe('decodeShare sanitises hostile input', () => {
  function craft(payload: unknown): string {
    return `wm1.${gzipSync(Buffer.from(JSON.stringify(payload))).toString('base64url')}`;
  }

  it('drops a source naming a service that does not exist', () => {
    const out = decodeShare(
      craft({ version: 1, catalogs: [{ name: 'X', type: 'filter', sources: ['trakt', 'evilcorp'] }] }),
    );
    expect(out.catalogs[0]!.sources).toEqual(['trakt']);
  });

  it('drops a catalog with no usable name rather than failing the import', () => {
    const out = decodeShare(
      craft({ version: 1, catalogs: [{ name: '  ' }, { name: 'Keeper', type: 'filter' }] }),
    );
    expect(out.catalogs.map((c) => c.name)).toEqual(['Keeper']);
  });

  it('clamps a rating outside the real scale', () => {
    const out = decodeShare(
      craft({ version: 1, catalogs: [{ name: 'X', type: 'filter', filter: { minRating: 9999 } }] }),
    );
    expect(out.catalogs[0]!.filter?.minRating).toBe(10);
  });

  it('drops non-numeric genre ids', () => {
    const out = decodeShare(
      craft({
        version: 1,
        catalogs: [{ name: 'X', type: 'filter', filter: { genres: [99, 'DROP TABLE', null] } }],
      }),
    );
    expect(out.catalogs[0]!.filter?.genres).toEqual([99]);
  });

  it('falls back to a known media type when given a bogus one', () => {
    const out = decodeShare(
      craft({ version: 1, catalogs: [{ name: 'X', type: 'filter', mediaType: 'hologram' }] }),
    );
    expect(out.catalogs[0]!.mediaType).toBe('both');
  });

  it('ignores a region that is not a country code', () => {
    const out = decodeShare(craft({ version: 1, catalogs: [], watchRegion: '../etc/passwd' }));
    expect(out.watchRegion).toBeUndefined();
  });

  it('caps how many catalogs one code can create', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ name: `C${i}`, type: 'filter' }));
    expect(decodeShare(craft({ version: 1, catalogs: many })).catalogs.length).toBe(100);
  });

  it('keeps no credential-shaped field even when one is planted', () => {
    const out = decodeShare(
      craft({
        version: 1,
        catalogs: [{ name: 'X', type: 'filter', accessToken: 'secret', apiKey: 'secret' }],
        authKey: 'secret',
      }),
    );
    expect(JSON.stringify(out)).not.toContain('secret');
  });
});

describe('encodeShare never carries credentials', () => {
  it('emits nothing token-shaped for a fully populated catalog', () => {
    const code = encodeShare({
      catalogs: [def({ sources: ['trakt', 'simkl', 'stremio'] })],
      artworkTemplate: 'https://x/{id}.jpg',
      watchRegion: 'GB',
    });
    const decoded = JSON.stringify(decodeShare(code));
    for (const word of ['token', 'authKey', 'apiKey', 'password', 'secret']) {
      expect(decoded.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });
});
