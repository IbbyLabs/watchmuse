import { createLogger, loadConfig, ConfigStartupError } from '@watchmuse/core';
import { createDb } from './db/client.js';
import { createMailer } from './mail/mailer.js';
import { buildApp } from './app.js';

const log = createLogger('server');

async function main(): Promise<void> {
  const config = loadConfig();

  // Either setting alone is fine. Together they let a stranger sign up and use
  // the AI endpoint check to probe the network this server sits on.
  if (config.AI_ALLOW_PRIVATE_BASE_URL && config.REGISTRATION_ENABLED) {
    log.warn(
      { AI_ALLOW_PRIVATE_BASE_URL: true, REGISTRATION_ENABLED: true },
      'Anyone who signs up can point the AI endpoint at private addresses. Set AI_ALLOW_PRIVATE_BASE_URL=false unless every account is trusted',
    );
  }

  const db = await createDb(config.DATABASE_URL);
  await db.migrate();
  log.info('Database migrated');

  const mailer = createMailer(config);
  await mailer.verify();

  const app = buildApp({ config, db, mailer });

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Shutting down');
    await app.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: '0.0.0.0', port: config.PORT });
  log.info({ port: config.PORT, url: config.APP_URL }, 'Watchmuse listening');

  app.scheduler.start();
}

main().catch((err) => {
  if (err instanceof ConfigStartupError) {
    // Config problems: print the message plainly, no stack trace.
    process.stderr.write(`\n${err.message}\n\n`);
    process.exit(1);
  }
  log.error({ err }, 'Fatal startup error');
  process.exit(1);
});
