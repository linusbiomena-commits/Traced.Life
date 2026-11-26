import { existsSync } from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { stopEmbeddedPostgres, UTF8_INITDB_FLAGS } from '../db/embedded.ts';

// Local development database: a real PostgreSQL server run from node_modules (no install, no
// admin rights). Data persists in .dev-db/. Connection details come from DATABASE_URL in .env.

const raw = process.env.DATABASE_URL;
if (!raw) {
  console.error('DATABASE_URL is not set (copy .env.example to .env).');
  process.exit(1);
}
const url = new URL(raw);
if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
  console.error('dev-db only runs a local server; DATABASE_URL must point at 127.0.0.1 or localhost.');
  process.exit(1);
}

const databaseDir = path.resolve('.dev-db/data');
const pg = new EmbeddedPostgres({
  databaseDir,
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  port: Number(url.port || 5432),
  persistent: true,
  initdbFlags: [...UTF8_INITDB_FLAGS],
  onLog: () => {},
});

if (!existsSync(databaseDir)) {
  console.log('Initialising local database in .dev-db/ ...');
  await pg.initialise();
}
await pg.start();
const dbName = url.pathname.replace(/^\//, '') || 'traced';
try {
  await pg.createDatabase(dbName);
} catch (err) {
  if (!/already exists/i.test((err as Error).message)) throw err;
}
console.log(`Local PostgreSQL running on 127.0.0.1:${url.port}, database "${dbName}". Press Ctrl+C to stop.`);

const stop = async () => {
  await stopEmbeddedPostgres(pg, databaseDir);
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
