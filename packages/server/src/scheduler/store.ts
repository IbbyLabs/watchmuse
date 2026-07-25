import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { candidatePools, connections, installs } from '../db/schema.js';

/** The queries the maintenance sweep needs, kept out of the scheduler itself. */
export class MaintenanceStore {
  constructor(private readonly db: Db) {}

  /**
   * Users whose catalog pool has gone stale and who have an install that could
   * actually read it. Oldest first, so a backlog drains in a fair order rather
   * than starving whoever sorts last.
   */
  async usersWithStalePools(limit: number): Promise<string[]> {
    const rows = await this.db.orm
      .selectDistinct({ userId: candidatePools.userId, expiresAt: candidatePools.expiresAt })
      .from(candidatePools)
      .innerJoin(installs, eq(installs.userId, candidatePools.userId))
      .where(and(lt(candidatePools.expiresAt, new Date()), isNull(installs.revokedAt)))
      .orderBy(candidatePools.expiresAt)
      .limit(limit);
    return rows.map((r) => r.userId);
  }

  /** Every active Trakt connection, so their tokens can be renewed on time. */
  async traktConnections(): Promise<Array<{ id: string; userId: string }>> {
    return this.db.orm
      .select({ id: connections.id, userId: connections.userId })
      .from(connections)
      .where(and(eq(connections.provider, 'trakt'), eq(connections.status, 'active')));
  }

  /** Flag a connection the user has to reconnect by hand. */
  async markReauth(connectionId: string): Promise<void> {
    await this.db.orm
      .update(connections)
      .set({ status: 'reauth', updatedAt: sql`now()` })
      .where(eq(connections.id, connectionId));
  }
}
