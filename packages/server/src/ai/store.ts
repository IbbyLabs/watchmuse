import { eq } from 'drizzle-orm';
import type { LlmConfig, SecretBox } from '@watchmuse/core';
import type { Db } from '../db/client.js';
import { llmConfigs } from '../db/schema.js';

/** Encrypted per-user LLM config storage (same SecretBox as provider tokens). */
export class LlmConfigStore {
  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
  ) {}

  async get(userId: string): Promise<LlmConfig | null> {
    const [row] = await this.db.orm.select().from(llmConfigs).where(eq(llmConfigs.userId, userId)).limit(1);
    if (!row) return null;
    try {
      return JSON.parse(this.box.decrypt(row.config)) as LlmConfig;
    } catch {
      return null;
    }
  }

  async has(userId: string): Promise<boolean> {
    const [row] = await this.db.orm
      .select({ userId: llmConfigs.userId })
      .from(llmConfigs)
      .where(eq(llmConfigs.userId, userId))
      .limit(1);
    return Boolean(row);
  }

  async set(userId: string, config: LlmConfig): Promise<void> {
    const encrypted = this.box.encrypt(JSON.stringify(config));
    const now = new Date();
    await this.db.orm
      .insert(llmConfigs)
      .values({ userId, config: encrypted, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: llmConfigs.userId, set: { config: encrypted, updatedAt: now } });
  }

  async clear(userId: string): Promise<void> {
    await this.db.orm.delete(llmConfigs).where(eq(llmConfigs.userId, userId));
  }
}
