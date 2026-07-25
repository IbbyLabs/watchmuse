import { describe, expect, it } from 'vitest';
import { traktRenewAt, type TraktTokens } from './trakt.js';

const DAY = 86_400_000;

const tokens = (over: Partial<TraktTokens> = {}): TraktTokens => ({
  accessToken: 'a',
  refreshToken: 'r',
  expiresAt: 0,
  ...over,
});

describe('traktRenewAt', () => {
  it('renews three quarters of the way through the token life', () => {
    const issuedAt = Date.parse('2026-01-01T00:00:00Z');
    const at = traktRenewAt(tokens({ issuedAt, expiresAt: issuedAt + 90 * DAY }));
    expect((at - issuedAt) / DAY).toBeCloseTo(67.5, 3);
  });

  it('leaves weeks of slack before the token actually expires', () => {
    const issuedAt = Date.parse('2026-01-01T00:00:00Z');
    const expiresAt = issuedAt + 90 * DAY;
    expect((expiresAt - traktRenewAt(tokens({ issuedAt, expiresAt }))) / DAY).toBeGreaterThan(20);
  });

  it('assumes the standard 90-day life for tokens stored before issuedAt existed', () => {
    const expiresAt = Date.parse('2026-04-01T00:00:00Z');
    const at = traktRenewAt(tokens({ expiresAt }));
    expect((expiresAt - at) / DAY).toBeCloseTo(22.5, 3);
  });

  it('does not push renewal past expiry for an already-expired token', () => {
    const expiresAt = Date.parse('2020-01-01T00:00:00Z');
    expect(traktRenewAt(tokens({ expiresAt, issuedAt: expiresAt }))).toBeLessThanOrEqual(expiresAt);
  });
});
