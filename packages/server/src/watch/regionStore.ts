import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { watchRegions } from '../db/schema.js';

export interface WatchRegion {
  /** What the user picked, if they picked one. */
  chosen: string | null;
  /** Where their requests appear to come from. */
  detected: string | null;
  /** What availability should actually be answered for, or null if unknown. */
  effective: string | null;
}

/**
 * The country used to answer "can I stream this". Detected from where requests
 * arrive so it works without setup, and overridable because detection is a
 * guess: a VPN, a relay, or a phone abroad all lie about where someone watches.
 * A choice, once made, is never overwritten by detection.
 */
export class WatchRegionStore {
  constructor(private readonly db: Db) {}

  async get(userId: string): Promise<WatchRegion> {
    const [row] = await this.db.orm
      .select()
      .from(watchRegions)
      .where(eq(watchRegions.userId, userId))
      .limit(1);
    const chosen = row?.region ?? null;
    const detected = row?.detectedRegion ?? null;
    return { chosen, detected, effective: chosen ?? detected };
  }

  /** The region to answer availability for, or null when we have no idea. */
  async effective(userId: string): Promise<string | null> {
    return (await this.get(userId)).effective;
  }

  /** Record an explicit choice. Pass null to go back to following detection. */
  async choose(userId: string, region: string | null): Promise<WatchRegion> {
    await this.db.orm
      .insert(watchRegions)
      .values({ userId, region, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: watchRegions.userId,
        set: { region, updatedAt: new Date() },
      });
    return this.get(userId);
  }

  /**
   * Note where a request came from. Cheap enough to call per request: it only
   * writes when the country has actually changed.
   */
  async observe(userId: string, region: string): Promise<void> {
    await this.db.orm
      .insert(watchRegions)
      .values({ userId, detectedRegion: region, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: watchRegions.userId,
        set: { detectedRegion: region, updatedAt: new Date() },
        setWhere: sql`${watchRegions.detectedRegion} is distinct from ${region}`,
      });
  }
}
