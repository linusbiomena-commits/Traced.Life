import { serve } from '@hono/node-server';
import { loadConfig } from './config.ts';
import { migrate } from './db/migrate.ts';
import { createPool } from './db/pool.ts';
import { log } from './lib/logger.ts';
import { createMailer } from './modules/mail/mailer.ts';
import { startOutboxWorker } from './modules/mail/outbox.ts';
import { createHttpApp } from './server.ts';

const config = loadConfig();
const db = createPool(config.databaseUrl);
const mailer = createMailer({ transport: config.mailTransport, devDir: config.mailDevDir, resendApiKey: config.resendApiKey, mailFrom: config.mailFrom, replyTo: config.mailReplyTo });

if (config.env === 'development') {
  const result = await migrate(db);
  if (result.applied.length) log.info('migrations applied', { applied: result.applied });
}

const deps = { config, db, mailer };
const app = createHttpApp(deps);
const stopOutbox = startOutboxWorker(deps, config.outboxIntervalMs);

const server = serve({ fetch: app.fetch, port: config.port, hostname: '127.0.0.1' }, (info) => {
  log.info('TRACED server listening', { url: `http://127.0.0.1:${info.port}`, static: config.serveStatic, mail: config.mailTransport });
});

async function shutdown(signal: string) {
  log.info('shutting down', { signal });
  stopOutbox();
  server.close();
  await db.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
