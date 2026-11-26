import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import type { TestProject } from 'vitest/node';
import { stopEmbeddedPostgres, UTF8_INITDB_FLAGS } from '../../src/db/embedded.ts';
import { migrate } from '../../src/db/migrate.ts';
import { createPool } from '../../src/db/pool.ts';

// Performance run only: a throw-away PostgreSQL cluster (temp folder, random port) started with
// pg_stat_statements and settings close to Cloud SQL db-f1-micro (shared_buffers 128MB is the
// local default; max_connections 25 matches the db-f1-micro limit). Never the development DB.

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

declare module 'vitest' {
  export interface ProvidedContext {
    pgDataDir: string;
    pgPort: number;
  }
}

export default async function setup(project: TestProject) {
  const dir = await mkdtemp(path.join(tmpdir(), 'traced-perf-pg-'));
  const port = await freePort();
  const password = randomBytes(16).toString('hex');
  const pg = new EmbeddedPostgres({
    databaseDir: path.join(dir, 'data'), user: 'traced_test', password, port, persistent: false,
    initdbFlags: [...UTF8_INITDB_FLAGS],
    postgresFlags: ['-c', 'shared_preload_libraries=pg_stat_statements', '-c', 'max_connections=25', '-c', 'shared_buffers=128MB', '-c', 'work_mem=4MB'],
    onLog: () => {},
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('traced_template');
  const base = `postgres://traced_test:${password}@127.0.0.1:${port}`;
  const pool = createPool(`${base}/traced_template`, 1);
  await migrate(pool);
  await pool.end();
  project.provide('pgBaseUrl', base);
  project.provide('pgDataDir', path.join(dir, 'data'));
  project.provide('pgPort', port);
  return async () => {
    await stopEmbeddedPostgres(pg, path.join(dir, 'data'));
    await rm(dir, { recursive: true, force: true });
  };
}
