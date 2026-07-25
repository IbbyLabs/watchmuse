import { eq } from 'drizzle-orm';
import { TraktClient, createLogger, type MediaType } from '@watchmuse/core';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import type { ConnectionService } from '../connections/service.js';

const log = createLogger('trakt-hides');

/**
 * Mirrors a dismissal to the user's Trakt account.
 *
 * Hiding a title in Watchmuse only affects Watchmuse; Trakt goes on suggesting
 * it in every other client. Writing the dismissal through makes it portable.
 * That also means editing data the user owns somewhere else, so it is strictly
 * opt-in and off until they say otherwise.
 */
export class TraktHideMirror {
  constructor(
    private readonly db: Db,
    private readonly connections: ConnectionService,
  ) {}

  async isEnabled(userId: string): Promise<boolean> {
    const [row] = await this.db.orm
      .select({ on: users.traktHideWriteThrough })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row?.on ?? false;
  }

  async setEnabled(userId: string, enabled: boolean): Promise<void> {
    await this.db.orm
      .update(users)
      .set({ traktHideWriteThrough: enabled, updatedAt: new Date() })
      .where(eq(users.id, userId));
  }

  /**
   * Mirror one dismissal, if the user asked for it.
   *
   * Never throws and never blocks: the local hide has already happened and is
   * what the user asked for. A Trakt outage must not make dismissing a title
   * fail in the app.
   */
  async mirror(userId: string, item: { tmdbId: number; type: MediaType }, hidden: boolean): Promise<void> {
    try {
      if (!(await this.isEnabled(userId))) return;
      const client = await this.connections.clientFor(userId, 'trakt');
      if (!(client instanceof TraktClient)) return;
      await client.setHiddenFromRecommendations([item], hidden);
      log.info({ userId, ...item, hidden }, 'Mirrored a dismissal to Trakt');
    } catch (err) {
      log.warn({ userId, ...item, hidden, err }, 'Could not mirror the dismissal to Trakt');
    }
  }
}
