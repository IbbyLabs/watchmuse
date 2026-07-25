import { describe, expect, it } from 'vitest';
import { loadConfig } from '@watchmuse/core';

const base = {
  NODE_ENV: 'test',
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  SESSION_SECRET: 'y'.repeat(40),
} as NodeJS.ProcessEnv;

describe('REQUIRE_EMAIL_VERIFICATION', () => {
  it('is on unless turned off', () => {
    expect(loadConfig(base).REQUIRE_EMAIL_VERIFICATION).toBe(true);
  });

  it('can be turned off for a single-user self-host', () => {
    expect(
      loadConfig({ ...base, REQUIRE_EMAIL_VERIFICATION: 'false' }).REQUIRE_EMAIL_VERIFICATION,
    ).toBe(false);
  });

  it('does not treat a nonsense value as off', () => {
    expect(
      loadConfig({ ...base, REQUIRE_EMAIL_VERIFICATION: 'maybe' }).REQUIRE_EMAIL_VERIFICATION,
    ).toBe(false);
  });
});
