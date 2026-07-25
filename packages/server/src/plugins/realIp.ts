import type { FastifyInstance } from 'fastify';
import { resolveClientIp, type AppConfig } from '@watchmuse/core';

/**
 * Cloudflare sends 'XX' when it cannot place a request and 'T1' for Tor, and
 * neither is a country we could look up streaming availability for.
 */
const UNPLACEABLE = new Set(['XX', 'T1']);

function countryFrom(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const code = header.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code) || UNPLACEABLE.has(code)) return null;
  return code;
}

/**
 * Populate `request.clientIp` from the socket peer and trusted proxy headers.
 * Registered on the root instance (no encapsulation) so every route sees it.
 */
export function registerRealIp(app: FastifyInstance, config: AppConfig): void {
  app.decorateRequest('clientIp', '');
  app.decorateRequest('clientCountry', null);
  app.addHook('onRequest', async (request) => {
    const result = resolveClientIp(
      {
        socketAddress: request.socket.remoteAddress,
        forwardedFor: request.headers['x-forwarded-for'],
        cfConnectingIp: request.headers['cf-connecting-ip'],
      },
      {
        trustedProxies: config.trustedProxyCidrs,
        trustCloudflareHeader: config.TRUST_CLOUDFLARE_HEADER,
      },
    );
    request.clientIp = result.ip;
    // Only meaningful when the request actually came through trusted Cloudflare;
    // anyone can set the header otherwise.
    request.clientCountry =
      result.source === 'cf' ? countryFrom(request.headers['cf-ipcountry']) : null;
  });
}
