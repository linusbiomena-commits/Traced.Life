import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { serve } from '@hono/node-server';
import EmbeddedPostgres from 'embedded-postgres';
import type { Config } from '../../src/config.ts';
import { stopEmbeddedPostgres, UTF8_INITDB_FLAGS } from '../../src/db/embedded.ts';
import { migrate } from '../../src/db/migrate.ts';
import { createPool } from '../../src/db/pool.ts';
import { seedDevData } from '../../src/modules/dev/seed.ts';
import { DevFileMailer } from '../../src/modules/mail/mailer.ts';
import { startOutboxWorker } from '../../src/modules/mail/outbox.ts';
import { createHttpApp } from '../../src/server.ts';

// Throwaway full stack for browser tests: fresh UTF-8 PostgreSQL, migrations, [DEV] seed data,
// API + static site on one origin. Emails are written to E2E_MAIL_DIR. Everything is deleted on exit.

const PORT = Number(process.env.E2E_PORT ?? 8790);
const MAIL_DIR = path.resolve(process.env.E2E_MAIL_DIR ?? 'test-results/e2e-mail');

// Each run gets its own gitignored data directory under test-results/e2e-pg. On Windows,
// Playwright force-kills this process, so the exit cleanup may not run and an embedded-postgres
// worker can survive as an orphan that keeps files in its data directory open. A fixed directory
// then couldn't be wiped and the next run failed to start. Earlier runs' directories are removed
// best-effort (one still held open is skipped and removed by a later run), so leftovers can't
// accumulate and can't block a new run.
const root = path.resolve('test-results/e2e-pg');
await mkdir(root, { recursive: true });
for (const name of await readdir(root).catch(() => [] as string[])) {
  await rm(path.join(root, name), { recursive: true, force: true }).catch(() => {});
}
const dir = path.join(root, `run-${Date.now()}-${randomBytes(3).toString('hex')}`);
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
  // Test-harness only (hard-coded, never read from the environment): the browser tests send a
  // per-customer X-Forwarded-For as if one trusted proxy (Cloud Run) had appended it.
  trustedProxyHops: 1,
  mailTransport: 'dev',
  mailDevDir: MAIL_DIR,
  serveStatic: true,
  devIdentityVerification: true,
  // Phase 7: throw-away checkpoint signing key and sink folder (deleted with this run's directory).
  auditCheckpointKey: randomBytes(32).toString('base64'),
  auditCheckpointDir: path.join(dir, 'checkpoints'),
};
const deps = { config, db, mailer: new DevFileMailer(MAIL_DIR) };
// Lets the browser tests create invited staff accounts in this throwaway database.
// Test-only, gitignored, deleted with the rest of test-results/.
await writeFile(path.resolve('test-results/e2e-env.json'), JSON.stringify({
  databaseUrl: url, tokenHmacKey: config.tokenHmacKey.toString('base64'), dataEncryptionKey: config.dataEncryptionKey.toString('base64'), appOrigin: config.appOrigin,
}));
const app = createHttpApp(deps);
const stopOutbox = startOutboxWorker(deps, 2000);
const server = serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, () => console.log(`e2e server ready on http://localhost:${PORT}`));

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  stopOutbox();
  server.close();
  await db.end().catch(() => {});
  await stopEmbeddedPostgres(pg, dataDir).catch(() => {});
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  process.exit(0);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
process.stdin.on('end', () => void stop());
