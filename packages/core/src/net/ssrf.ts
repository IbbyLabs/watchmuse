import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

/**
 * Guard for URLs the user supplies and the server then fetches.
 *
 * The AI config is bring-your-own-endpoint, so an account holder gets to name a
 * host the server will POST to and gets the outcome back. Without a check that
 * is a scanner: point it at an internal address and read reachability off the
 * response. Self-hosters genuinely need loopback and LAN addresses for Ollama
 * and LM Studio, so those stay reachable by default and an operator running an
 * instance with open signups turns them off.
 *
 * Link-local is never allowed either way. Nothing legitimate is served from it,
 * and it is where cloud providers put their credential endpoints.
 */

export class UnsafeUrlError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'UnsafeUrlError';
  }
}

export interface UrlGuardOptions {
  /** Allow loopback and LAN addresses, as a self-hosted Ollama needs. */
  allowPrivate?: boolean;
}

/** Ranges with no legitimate use here, whatever the operator has allowed. */
const NEVER = new Set([
  'linkLocal', // 169.254/16 and fe80::/10 — cloud metadata lives here
  'multicast',
  'broadcast',
  'reserved',
  'unspecified',
  'carrierGradeNat',
]);

/** Ranges a self-hoster needs but a shared instance should not expose. */
const PRIVATE = new Set(['loopback', 'private', 'uniqueLocal']);

function classify(address: string): string {
  let parsed = ipaddr.parse(address);
  // ::ffff:169.254.169.254 is the same address wearing a hat.
  if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }
  return parsed.range();
}

/** Throws `UnsafeUrlError` unless the URL is safe for the server to fetch. */
export async function assertSafeUrl(raw: string, opts: UrlGuardOptions = {}): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError('That is not a valid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeUrlError('Only http and https addresses are allowed');
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError('Credentials in the URL are not allowed');
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (ipaddr.isValid(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host, { all: true })).map((a) => a.address);
    } catch {
      throw new UnsafeUrlError('That address could not be resolved');
    }
    if (addresses.length === 0) throw new UnsafeUrlError('That address could not be resolved');
  }

  // Every address the name resolves to has to pass, not just the first.
  for (const address of addresses) {
    const range = classify(address);
    if (NEVER.has(range)) {
      throw new UnsafeUrlError('That address is not reachable from this server');
    }
    if (PRIVATE.has(range) && !opts.allowPrivate) {
      throw new UnsafeUrlError('This server does not allow private or loopback addresses here');
    }
  }
}
