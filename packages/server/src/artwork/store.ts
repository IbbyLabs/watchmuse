import { eq } from 'drizzle-orm';
import type { ArtworkConfig, SecretBox } from '@watchmuse/core';
import type { Db } from '../db/client.js';
import { artworkConfigs } from '../db/schema.js';

/** Encrypted per-user custom-artwork config (same SecretBox as provider tokens). */
export class ArtworkConfigStore {
  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
  ) {}

  async get(userId: string): Promise<ArtworkConfig | null> {
    const [row] = await this.db.orm.select().from(artworkConfigs).where(eq(artworkConfigs.userId, userId)).limit(1);
    if (!row) return null;
    try {
      return JSON.parse(this.box.decrypt(row.config)) as ArtworkConfig;
    } catch {
      return null;
    }
  }

  async set(userId: string, config: ArtworkConfig): Promise<void> {
    const encrypted = this.box.encrypt(JSON.stringify(config));
    const now = new Date();
    await this.db.orm
      .insert(artworkConfigs)
      .values({ userId, config: encrypted, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: artworkConfigs.userId, set: { config: encrypted, updatedAt: now } });
  }

  async clear(userId: string): Promise<void> {
    await this.db.orm.delete(artworkConfigs).where(eq(artworkConfigs.userId, userId));
  }
}
