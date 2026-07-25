import { describe, expect, it } from 'vitest';
import { assertSafeUrl, UnsafeUrlError } from './ssrf.js';

const allowed = (url: string, allowPrivate = false) =>
  assertSafeUrl(url, { allowPrivate }).then(
    () => true,
    (e: unknown) => {
      if (e instanceof UnsafeUrlError) return false;
      throw e;
    },
  );

describe('assertSafeUrl', () => {
  it('allows an ordinary public endpoint', async () => {
    await expect(allowed('https://openrouter.ai/api/v1')).resolves.toBe(true);
  });

  it('rejects anything that is not http or https', async () => {
    for (const url of ['file:///etc/passwd', 'gopher://x/', 'ftp://example.com/']) {
      await expect(allowed(url)).resolves.toBe(false);
    }
  });

  it('rejects a malformed URL', async () => {
    await expect(allowed('not a url')).resolves.toBe(false);
  });

  it('rejects credentials embedded in the URL', async () => {
    await expect(allowed('https://user:pass@example.com/v1')).resolves.toBe(false);
  });

  describe('cloud metadata', () => {
    const metadata = [
      'http://169.254.169.254/latest/meta-data/',
      'http://169.254.170.2/v2/credentials',
      'http://[fe80::1]/',
    ];

    it('is refused even when private addresses are allowed', async () => {
      for (const url of metadata) {
        await expect(allowed(url, true)).resolves.toBe(false);
      }
    });

    it('is refused through an IPv4-mapped IPv6 address', async () => {
      await expect(allowed('http://[::ffff:169.254.169.254]/', true)).resolves.toBe(false);
    });
  });

  describe('with private addresses allowed, as a self-hosted Ollama needs', () => {
    it('allows loopback', async () => {
      await expect(allowed('http://127.0.0.1:11434/v1', true)).resolves.toBe(true);
      await expect(allowed('http://[::1]:11434/v1', true)).resolves.toBe(true);
    });

    it('allows a LAN address', async () => {
      await expect(allowed('http://192.168.1.50:11434/v1', true)).resolves.toBe(true);
      await expect(allowed('http://10.0.0.5:8080/v1', true)).resolves.toBe(true);
    });
  });

  describe('with private addresses disallowed', () => {
    it('refuses loopback', async () => {
      await expect(allowed('http://127.0.0.1:11434/v1')).resolves.toBe(false);
      await expect(allowed('http://[::1]:11434/v1')).resolves.toBe(false);
    });

    it('refuses LAN ranges', async () => {
      for (const url of [
        'http://10.0.0.5/v1',
        'http://192.168.0.1/v1',
        'http://172.16.0.1/v1',
        'http://[fd00::1]/v1',
      ]) {
        await expect(allowed(url)).resolves.toBe(false);
      }
    });

    it('refuses a hostname that resolves to loopback', async () => {
      await expect(allowed('http://localhost:11434/v1')).resolves.toBe(false);
    });
  });

  it('refuses a name that cannot be resolved rather than letting it through', async () => {
    await expect(allowed('https://this-host-does-not-exist.invalid/v1')).resolves.toBe(false);
  });

  it('says why it refused, in words a user can act on', async () => {
    await expect(assertSafeUrl('http://127.0.0.1/v1', { allowPrivate: false })).rejects.toThrow(
      /private or loopback/i,
    );
  });
});
