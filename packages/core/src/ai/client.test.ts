import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlmClient } from './client.js';
import { UnsafeUrlError } from '../net/ssrf.js';

afterEach(() => vi.restoreAllMocks());

const ok = () =>
  vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 }),
    );

describe('LlmClient', () => {
  it('refuses a blocked endpoint without sending anything', async () => {
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    const client = new LlmClient({
      baseUrl: 'http://169.254.169.254',
      model: 'm',
      apiKey: 'k',
      allowPrivateHost: true,
    });

    await expect(client.complete('s', 'u')).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses loopback unless the server allows private hosts', async () => {
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    const client = new LlmClient({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'm', apiKey: 'k' });

    await expect(client.complete('s', 'u')).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reaches a self-hosted endpoint when private hosts are allowed', async () => {
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    const client = new LlmClient({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'm',
      apiKey: 'k',
      allowPrivateHost: true,
    });

    await expect(client.complete('s', 'u')).resolves.toBe('OK');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not follow a redirect away from the checked host', async () => {
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    const client = new LlmClient({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'm',
      apiKey: 'k',
    });

    await client.complete('s', 'u');
    expect(fetchMock.mock.calls[0]![1].redirect).toBe('manual');
  });
});
