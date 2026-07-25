import { describe, expect, it, vi } from 'vitest';
import { loadConfig, type AppConfig } from '@watchmuse/core';
import { Scheduler, type SchedulerDeps } from './scheduler.js';

const baseEnv = {
  NODE_ENV: 'test',
  APP_URL: 'http://localhost:8080',
  DATABASE_URL: 'pglite://memory',
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  SESSION_SECRET: 'y'.repeat(40),
} as NodeJS.ProcessEnv;

function deps(over: Partial<SchedulerDeps> = {}, env: NodeJS.ProcessEnv = baseEnv) {
  const refresh = vi.fn(async () => undefined);
  const d: SchedulerDeps = {
    config: loadConfig(env) as AppConfig,
    store: { usersWithStalePools: vi.fn(async () => []) } as unknown as SchedulerDeps['store'],
    pool: { refresh } as unknown as SchedulerDeps['pool'],
    tokens: { renewDue: vi.fn(async () => 0) } as unknown as SchedulerDeps['tokens'],
    oauthStates: {
      purgeExpired: vi.fn(async () => 0),
    } as unknown as SchedulerDeps['oauthStates'],
    ...over,
  };
  return { d, refresh };
}

const stale = (ids: string[]) =>
  ({
    usersWithStalePools: vi.fn(async (limit: number) => ids.slice(0, limit)),
  }) as unknown as SchedulerDeps['store'];

describe('Scheduler', () => {
  it('rebuilds every stale pool it is given', async () => {
    const { d, refresh } = deps({ store: stale(['a', 'b', 'c']) });
    await new Scheduler(d).tick();
    expect(refresh.mock.calls.map((c) => c[0]).sort()).toEqual(['a', 'b', 'c']);
  });

  it('renews tokens and purges states in the same pass', async () => {
    const { d } = deps();
    await new Scheduler(d).tick();
    expect(d.tokens.renewDue).toHaveBeenCalledOnce();
    expect(d.oauthStates.purgeExpired).toHaveBeenCalledOnce();
  });

  it('never runs more rebuilds at once than configured', async () => {
    let open = 0;
    let peak = 0;
    const refresh = vi.fn(async () => {
      open++;
      peak = Math.max(peak, open);
      await new Promise((r) => setTimeout(r, 5));
      open--;
    });
    const { d } = deps({
      store: stale(['a', 'b', 'c', 'd', 'e', 'f']),
      pool: { refresh } as unknown as SchedulerDeps['pool'],
    });

    await new Scheduler(d).tick();

    expect(refresh).toHaveBeenCalledTimes(6);
    expect(peak).toBe(2); // SCHEDULER_MAX_CONCURRENT_REBUILDS default
  });

  it('caps how much work one sweep takes on', async () => {
    const { d, refresh } = deps(
      { store: stale(Array.from({ length: 50 }, (_, i) => `u${i}`)) },
      { ...baseEnv, SCHEDULER_MAX_REBUILDS_PER_SWEEP: '5' },
    );
    await new Scheduler(d).tick();
    expect(refresh).toHaveBeenCalledTimes(5);
  });

  it('does not start a sweep while one is still running', async () => {
    const { d, refresh } = deps({ store: stale(['a']) });
    const scheduler = new Scheduler(d);
    await Promise.all([scheduler.tick(), scheduler.tick(), scheduler.tick()]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('survives a failing sweep rather than taking the process down', async () => {
    const { d } = deps({
      store: {
        usersWithStalePools: vi.fn(async () => {
          throw new Error('database is away');
        }),
      } as unknown as SchedulerDeps['store'],
    });
    await expect(new Scheduler(d).tick()).resolves.toBeUndefined();
  });

  it('stays idle when disabled', () => {
    const { d } = deps({}, { ...baseEnv, SCHEDULER_ENABLED: 'false' });
    const scheduler = new Scheduler(d);
    scheduler.start();
    scheduler.stop();
    expect(d.store.usersWithStalePools).not.toHaveBeenCalled();
  });
});
