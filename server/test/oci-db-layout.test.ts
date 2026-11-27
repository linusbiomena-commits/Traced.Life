import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stopEmbeddedPostgres, UTF8_INITDB_FLAGS } from '../src/db/embedded.ts';
import { migrate } from '../src/db/migrate.ts';
import { createPool, type Pool } from '../src/db/pool.ts';

// Oracle Cloud database layout (deploy/oci/vm_01_db.sh, vm_02_migrate.sh, vm_03_verify.sh) on a
// dedicated throw-away PostgreSQL 18 cluster (role names are cluster-wide, so it must not share
// the suite's cluster):
//   superuser creates traced_migrator (NOSUPERUSER, NOCREATEROLE) and the database it owns;
//   traced_migrator applies the migrations and owns every table;
//   the superuser applies server/sql/production-roles.sql and sets the runtime passwords;
//   traced_app / traced_readonly log in with passwords over TCP and are refused everything else.

const freePort = () =>
  new Promise<number>((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });

let dir: string;
let pg: EmbeddedPostgres;
let base: string;
let su: Pool; // superuser on database "traced"
let mig: Pool;
let app: Pool;
let ro: Pool;
const pw = () => randomBytes(24).toString('base64url');
const migPw = pw();
const appPw = pw();
const roPw = pw();
const url = (user: string, password: string, db = 'traced') => base.replace(/\/\/[^@]+@/, `//${user}:${password}@`) + `/${db}`;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'traced-oci-layout-'));
  const port = await freePort();
  const superPw = pw();
  pg = new EmbeddedPostgres({
    databaseDir: path.join(dir, 'data'), user: 'postgres', password: superPw, port,
    persistent: false, initdbFlags: [...UTF8_INITDB_FLAGS], onLog: () => {},
  });
  await pg.initialise();
  await pg.start();
  base = `postgres://postgres:${superPw}@127.0.0.1:${port}`;

  // vm_01_db.sh, translated from psql (\gexec / \getenv) to plain statements.
  const admin = createPool(`${base}/postgres`, 1);
  await admin.query(`CREATE ROLE traced_migrator LOGIN`);
  await admin.query(`ALTER ROLE traced_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${migPw}'`);
  await admin.query(`CREATE DATABASE traced OWNER traced_migrator ENCODING 'UTF8' TEMPLATE template0`);
  await admin.query(`REVOKE ALL ON DATABASE traced FROM PUBLIC`);
  await admin.query(`GRANT CONNECT, TEMPORARY ON DATABASE traced TO traced_migrator`);
  await admin.end();
  su = createPool(`${base}/traced`, 2);
  await su.query(`ALTER SCHEMA public OWNER TO traced_migrator`);
  await su.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
  mig = createPool(url('traced_migrator', migPw), 1);
}, 180_000);

afterAll(async () => {
  await Promise.allSettled([su?.end(), mig?.end(), app?.end(), ro?.end()]);
  if (pg) await stopEmbeddedPostgres(pg, path.join(dir, 'data'));
  if (dir) await rm(dir, { recursive: true, force: true });
});

const denied = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ code: '42501' });

describe('Oracle Cloud database layout', () => {
  it('traced_migrator (not a superuser) applies all migrations, and a second run verifies checksums and applies nothing', async () => {
    const first = await migrate(mig);
    expect(first.applied.length).toBeGreaterThanOrEqual(11);
    expect(first.applied[0]).toMatch(/^0001_/);
    const second = await migrate(mig);
    expect(second.applied).toEqual([]);
    expect(second.skipped.length).toBe(first.applied.length);
    const owners = await su.query<{ o: string }>(`SELECT DISTINCT tableowner AS o FROM pg_tables WHERE schemaname = 'public'`);
    expect(owners.rows.map((r) => r.o)).toEqual(['traced_migrator']);
  });

  it('the superuser applies production-roles.sql and the runtime passwords (vm_02_migrate.sh)', async () => {
    await su.query(readFileSync(path.resolve('server/sql/production-roles.sql'), 'utf8'));
    await su.query(`ALTER ROLE traced_app PASSWORD '${appPw}'`);
    await su.query(`ALTER ROLE traced_readonly PASSWORD '${roPw}'`);
    await su.query(`GRANT CONNECT ON DATABASE traced TO traced_app, traced_readonly`);
    app = createPool(url('traced_app', appPw), 2);
    ro = createPool(url('traced_readonly', roPw), 1);
    const r = await app.query<{ u: string }>(`SELECT current_user AS u`);
    expect(r.rows[0]!.u).toBe('traced_app');
  });

  it('no traced_* role has superuser, role-creation, replication or RLS-bypass rights', async () => {
    const { rows } = await su.query(`SELECT rolname FROM pg_roles WHERE rolname LIKE 'traced%' AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)`);
    expect(rows).toEqual([]);
    await denied(mig.query(`CREATE ROLE zz_probe`));
  });

  it('the schema is intact: audit chain verifies, custody digest and tracking allocation work as traced_app', async () => {
    const chain = await app.query(`SELECT * FROM audit_verify_chain()`);
    expect(chain.rows.length).toBe(1);
    expect((await app.query(`SELECT custody_events_digest(0) IS NOT NULL AS ok`)).rows[0]).toEqual({ ok: true });
    const t = await app.query(`SELECT * FROM allocate_tracking_id(now())`);
    expect(t.rows.length).toBe(1);
  });

  it('traced_app cannot change or remove evidence, change the schema or escalate', async () => {
    for (const table of ['audit_logs', 'custody_events', 'consent_records', 'registration_status_history', 'audit_checkpoints', 'audit_verifications', 'identity_verifications', 'sample_label_prints']) {
      const col = (await su.query<{ c: string }>(`SELECT column_name AS c FROM information_schema.columns WHERE table_name = $1 AND is_identity = 'NO' AND is_generated = 'NEVER' ORDER BY ordinal_position LIMIT 1`, [table])).rows[0]!.c;
      await denied(app.query(`UPDATE ${table} SET ${col} = ${col} WHERE false`));
      await denied(app.query(`DELETE FROM ${table} WHERE false`));
      await denied(app.query(`TRUNCATE ${table}`));
    }
    await denied(app.query(`CREATE TABLE zz_probe (i int)`));
    await denied(app.query(`DROP TABLE audit_logs`));
    await denied(app.query(`ALTER TABLE audit_logs DISABLE TRIGGER ALL`));
    await denied(app.query(`SET ROLE traced_migrator`));
    await denied(app.query(`SET ROLE postgres`));
    await denied(app.query(`COPY (SELECT 1) TO PROGRAM 'whoami'`));
    await denied(app.query(`INSERT INTO schema_migrations (version, checksum) VALUES ('9999_x.sql', 'x')`));
  });

  it('traced_app cannot run the migration runner (why the preview sets AUTO_MIGRATE=false)', async () => {
    await expect(migrate(app)).rejects.toMatchObject({ code: '42501' });
  });

  it('traced_readonly cannot write and cannot read personal-data tables', async () => {
    // Refused twice over: the role's sessions are read-only (25006) and it has no INSERT grant.
    await expect(ro.query(`INSERT INTO collection_branches DEFAULT VALUES`)).rejects.toMatchObject({ code: '25006' });
    await denied(ro.query(`BEGIN READ WRITE; INSERT INTO collection_branches DEFAULT VALUES`));
    await ro.query('ROLLBACK').catch(() => {});
    await denied(ro.query(`SELECT count(*) FROM users`));
    await denied(ro.query(`SELECT count(*) FROM patients`));
    expect((await ro.query(`SELECT count(*)::int AS n FROM audit_checkpoints`)).rows[0]).toEqual({ n: 0 });
  });

  it('the restore-check row-count query (deploy/oci/vm/vm_04_backup_install.sh) runs and covers every table', async () => {
    const counts = `select string_agg(relname||'='||n_live_tup_exact, ',' order by relname) from (select c.relname, (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.'||quote_ident(c.relname), false, true, '')))[1]::text::bigint as n_live_tup_exact from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r') s`;
    const r = (await su.query<{ string_agg: string }>(counts)).rows[0]!.string_agg;
    const tables = (await su.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`)).rows[0]!.n;
    expect(r.split(',').length).toBe(tables);
    expect(r).toMatch(/(^|,)schema_migrations=\d+(,|$)/);
  });

  it('roles outside the database grants cannot connect to it', async () => {
    await su.query(`CREATE ROLE zz_outsider LOGIN PASSWORD 'outsider-pw-1234567890'`);
    const outsider = createPool(url('zz_outsider', 'outsider-pw-1234567890'), 1);
    await expect(outsider.query('SELECT 1')).rejects.toMatchObject({ code: '42501' });
    await outsider.end();
  });
});
