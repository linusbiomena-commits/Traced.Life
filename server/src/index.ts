import { serve } from '@hono/node-server';
import { loadConfig } from './config.ts';
import { migrate } from './db/migrate.ts';
import { createPool } from './db/pool.ts';
import { log } from './lib/logger.ts';
import { createMailer } from './modules/mail/mailer.ts';
import { createHttpApp } from './server.ts';

const config = loadConfig();
const db = createPool(config.databaseUrl);
const mailer = createMailer(config.mailTransport, config.mailDevDir);

if (config.env === 'development') {
  const result = await migrate(db);
  if (result.applied.length) log.info('migrations applied', { applied: result.applied });
}

const app = createHttpApp({ config, db, mailer });

const server = serve({ fetch: app.fetch, port: config.port, hostname: '127.0.0.1' }, (info) => {
  log.info('TRACED server listening', { url: `http://127.0.0.1:${info.port}`, static: config.serveStatic, mail: config.mailTransport });
});

async function shutdown(signal: string) {
  log.info('shutting down', { signal });
  server.close();
  await db.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
