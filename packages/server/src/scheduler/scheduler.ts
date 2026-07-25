import { createLogger, type AppConfig } from '@watchmuse/core';
import type { OAuthStateStore } from '../connections/oauthState.js';
import type { PoolService } from '../catalogs/pool.js';
import type { MaintenanceStore } from './store.js';
import type { TokenRenewer } from './tokens.js';

const log = createLogger('scheduler');

export interface SchedulerDeps {
  config: AppConfig;
  store: MaintenanceStore;
  pool: PoolService;
  tokens: TokenRenewer;
  oauthStates: OAuthStateStore;
}

/**
 * Periodic upkeep the request path can't do for itself.
 *
 * Catalog rows only refresh when Stremio asks for them, so a user who hasn't
 * opened the app in a while gets stale rows the moment they do, and a Trakt
 * token that reaches its renewal point while nobody is looking simply expires.
 * This sweep covers both.
 *
 * Work is capped per pass and rebuilds run a couple at a time, so a server with
 * many users spreads the load over several sweeps rather than doing everything
 * at once. Users with no active install are skipped entirely: nothing is reading
 * their catalogs, so rebuilding them is pure waste.
 */
export class Scheduler {
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(private readonly deps: SchedulerDeps) {}

  start(): void {
    const { config } = this.deps;
    if (!config.SCHEDULER_ENABLED) {
      log.info('Background scheduler is disabled');
      return;
    }
    const intervalMs = config.SCHEDULER_INTERVAL_MINUTES * 60_000;
    log.info(
      {
        intervalMinutes: config.SCHEDULER_INTERVAL_MINUTES,
        maxConcurrentRebuilds: config.SCHEDULER_MAX_CONCURRENT_REBUILDS,
        maxRebuildsPerSweep: config.SCHEDULER_MAX_REBUILDS_PER_SWEEP,
      },
      'Background scheduler started',
    );
    // Spread the first sweep out so restarting several instances together
    // doesn't have them all sweep in the same second.
    const firstDelay = Math.floor(Math.random() * Math.min(intervalMs, 60_000));
    this.timer = setTimeout(() => {
      void this.tick();
      this.timer = setInterval(() => void this.tick(), intervalMs);
      this.timer.unref?.();
    }, firstDelay);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One maintenance pass. Exposed so tests can drive it without waiting. */
  async tick(): Promise<void> {
    if (this.running || this.stopped) return; // a slow sweep must not stack up
    this.running = true;
    const startedAt = Date.now();
    try {
      const states = await this.deps.oauthStates.purgeExpired();
      const tokens = await this.deps.tokens.renewDue();
      const pools = await this.rebuildStalePools();
      log.info(
        { pools, tokens, states, ms: Date.now() - startedAt },
        'Maintenance sweep completed',
      );
    } catch (err) {
      log.error({ err }, 'Maintenance sweep failed');
    } finally {
      this.running = false;
    }
  }

  private async rebuildStalePools(): Promise<number> {
    const { config, store, pool } = this.deps;
    const userIds = await store.usersWithStalePools(config.SCHEDULER_MAX_REBUILDS_PER_SWEEP);
    if (userIds.length === 0) return 0;
    if (userIds.length === config.SCHEDULER_MAX_REBUILDS_PER_SWEEP) {
      log.info(
        { cap: config.SCHEDULER_MAX_REBUILDS_PER_SWEEP },
        'Sweep hit its rebuild cap; the rest carry over to the next sweep',
      );
    }

    let done = 0;
    const queue = [...userIds];
    const worker = async (): Promise<void> => {
      for (;;) {
        const userId = queue.shift();
        if (userId === undefined || this.stopped) return;
        await pool.refresh(userId);
        done++;
      }
    };
    const workers = Math.min(config.SCHEDULER_MAX_CONCURRENT_REBUILDS, queue.length);
    await Promise.all(Array.from({ length: workers }, worker));
    return done;
  }
}
