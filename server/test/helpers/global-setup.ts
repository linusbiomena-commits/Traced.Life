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

declare module 'vitest' {
  export interface ProvidedContext {
    pgBaseUrl: string;
  }
}

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

/** One real PostgreSQL server for the whole run, with a migrated template database. */
export default async function setup(project: TestProject) {
  const dir = await mkdtemp(path.join(tmpdir(), 'traced-test-pg-'));
  const port = await freePort();
  const password = randomBytes(16).toString('hex');
  const pg = new EmbeddedPostgres({
    databaseDir: path.join(dir, 'data'),
    user: 'traced_test',
    password,
    port,
    persistent: false,
    initdbFlags: [...UTF8_INITDB_FLAGS],
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

  return async () => {
    await stopEmbeddedPostgres(pg, path.join(dir, 'data'));
    await rm(dir, { recursive: true, force: true });
  };
}
