import { createLogger } from '@watchmuse/core';
import type { ConnectionService } from '../connections/service.js';
import type { MaintenanceStore } from './store.js';

const log = createLogger('token-renew');

/**
 * Renews Trakt access tokens that have reached their renewal point, so an
 * account nobody has touched in weeks doesn't quietly expire. The client itself
 * decides whether a token is due and persists the result through its existing
 * refresh callback; this just walks the connections and gives it the chance.
 */
export class TokenRenewer {
  constructor(
    private readonly store: MaintenanceStore,
    private readonly connections: ConnectionService,
  ) {}

  /** Renew every Trakt token that is due. Returns how many were renewed. */
  async renewDue(): Promise<number> {
    const rows = await this.store.traktConnections();
    let renewed = 0;
    for (const row of rows) {
      try {
        const client = await this.connections.traktFor(row.userId);
        if (!client || !client.needsRefresh()) continue;
        await client.refreshTokens();
        renewed++;
        log.info({ userId: row.userId }, 'Renewed a Trakt access token');
      } catch (err) {
        // A refresh token Trakt no longer accepts needs the user, not a retry.
        await this.store.markReauth(row.id).catch(() => undefined);
        log.warn({ userId: row.userId, err }, 'Could not renew a Trakt token; reconnect required');
      }
    }
    return renewed;
  }
}
