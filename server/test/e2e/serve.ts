import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { serve } from '@hono/node-server';
import EmbeddedPostgres from 'embedded-postgres';
import type { Config } from '../../src/config.ts';
import { stopEmbeddedPostgres, UTF8_INITDB_FLAGS } from '../../src/db/embedded.ts';
import { migrate } from '../../src/db/migrate.ts';
import { createPool } from '../../src/db/pool.ts';
import { seedDevData } from '../../src/modules/dev/seed.ts';
import { DevFileMailer } from '../../src/modules/mail/mailer.ts';
import { createHttpApp } from '../../src/server.ts';

// Throwaway full stack for browser tests: fresh UTF-8 PostgreSQL, migrations, [DEV] seed data,
// API + static site on one origin. Emails are written to E2E_MAIL_DIR. Everything is deleted on exit.

const PORT = Number(process.env.E2E_PORT ?? 8790);
const MAIL_DIR = path.resolve(process.env.E2E_MAIL_DIR ?? 'test-results/e2e-mail');

// Fixed, gitignored location wiped on every start: Playwright force-kills this process on
// Windows (so the exit cleanup may not run), and this keeps leftovers from accumulating.
const dir = path.resolve('test-results/e2e-pg');
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });
const dataDir = path.join(dir, 'data');
const password = randomBytes(16).toString('hex');
const pgPort = 20000 + Math.floor(Math.random() * 20000);
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'traced_e2e', password, port: pgPort, persistent: false, initdbFlags: [...UTF8_INITDB_FLAGS], onLog: () => {} });
await pg.initialise();
await pg.start();
await pg.createDatabase('traced');
const url = `postgres://traced_e2e:${password}@127.0.0.1:${pgPort}/traced`;
const db = createPool(url, 10);
await migrate(db);
await seedDevData(db, 'test');
await rm(MAIL_DIR, { recursive: true, force: true });

const config: Config = {
  env: 'development',
  port: PORT,
  appOrigin: `http://localhost:${PORT}`,
  databaseUrl: url,
  tokenHmacKey: randomBytes(32),
  dataEncryptionKey: randomBytes(32),
  cookieSecure: false,
  trustProxy: false,
  mailTransport: 'dev',
  mailDevDir: MAIL_DIR,
  serveStatic: true,
};
const app = createHttpApp({ config, db, mailer: new DevFileMailer(MAIL_DIR) });
const server = serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, () => console.log(`e2e server ready on http://localhost:${PORT}`));

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  await db.end().catch(() => {});
  await stopEmbeddedPostgres(pg, dataDir).catch(() => {});
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  process.exit(0);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
process.stdin.on('end', () => void stop());
