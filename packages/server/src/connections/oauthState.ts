import { createHash, randomBytes } from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import { createLogger } from '@watchmuse/core';
import type { Db } from '../db/client.js';
import { oauthStates } from '../db/schema.js';

const log = createLogger('oauth-state');

const TTL_MS = 600_000;

export type RedirectProvider = 'trakt' | 'simkl';

function hash(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}

/**
 * Short-lived, single-use OAuth `state` values bound to a user. Backed by the
 * database so a deploy, a crash, or a request landing on a different replica
 * partway through the round-trip doesn't strand the user on a failed callback.
 */
export class OAuthStateStore {
  constructor(private readonly db: Db) {}

  async create(userId: string, provider: RedirectProvider): Promise<string> {
    const state = randomBytes(24).toString('base64url');
    await this.db.orm.insert(oauthStates).values({
      id: hash(state),
      userId,
      provider,
      expiresAt: new Date(Date.now() + TTL_MS),
    });
    return state;
  }

  /** Redeem a state exactly once. Deleting on read is what makes it single-use. */
  async consume(state: string): Promise<{ userId: string; provider: RedirectProvider } | null> {
    const [row] = await this.db.orm
      .delete(oauthStates)
      .where(eq(oauthStates.id, hash(state)))
      .returning();
    if (!row) return null;
    if (row.expiresAt.getTime() < Date.now()) return null;
    return { userId: row.userId, provider: row.provider as RedirectProvider };
  }

  /** Drop states nobody came back for. Safe to call on a timer. */
  async purgeExpired(): Promise<number> {
    const rows = await this.db.orm
      .delete(oauthStates)
      .where(lt(oauthStates.expiresAt, new Date()))
      .returning();
    if (rows.length > 0) log.debug({ count: rows.length }, 'Purged expired OAuth states');
    return rows.length;
  }
}
