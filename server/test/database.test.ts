import { mkdtemp, writeFile, copyFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, MIGRATIONS_DIR } from '../src/db/migrate.ts';
import { audit } from '../src/modules/audit/audit.service.ts';
import { PERMISSIONS, ROLE_PERMISSIONS, ROLES } from '../src/modules/rbac/catalogue.ts';
import { setupTestApp, type TestEnv } from './helpers/test-app.ts';

let t: TestEnv;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(async () => {
  await t.close();
});

describe('migrations', () => {
  it('are idempotent', async () => {
    const result = await migrate(t.db);
    expect(result.applied).toEqual([]);
    expect(result.skipped.length).toBeGreaterThanOrEqual(3);
  });

  it('refuse an edited, already-applied migration', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'traced-mig-'));
    for (const f of await readdir(MIGRATIONS_DIR)) await copyFile(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
    await writeFile(path.join(dir, '0001_identity_access.sql'), '-- edited\n', { flag: 'a' });
    await expect(migrate(t.db, dir)).rejects.toThrow(/modified after being applied/);
  });

  it('seed matches the code catalogue exactly', async () => {
    const roles = await t.db.query<{ key: string; requires_mfa: boolean }>('SELECT key, requires_mfa FROM roles ORDER BY key');
    expect(Object.fromEntries(roles.rows.map((r) => [r.key, r.requires_mfa]))).toEqual(
      Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [k, v.requiresMfa])),
    );
    const perms = await t.db.query<{ key: string }>('SELECT key FROM permissions ORDER BY key');
    expect(perms.rows.map((r) => r.key)).toEqual([...PERMISSIONS].sort());
    const rp = await t.db.query<{ role_key: string; permission_key: string }>('SELECT role_key, permission_key FROM role_permissions');
    const fromDb: Record<string, string[]> = {};
    for (const r of rp.rows) (fromDb[r.role_key] ??= []).push(r.permission_key);
    for (const [role, list] of Object.entries(ROLE_PERMISSIONS)) expect((fromDb[role] ?? []).sort()).toEqual([...list].sort());
  });

  it('enforce lower-case unique emails at the database level', async () => {
    await expect(t.db.query(`INSERT INTO users (email) VALUES ('Mixed@Example.com')`)).rejects.toThrow(/check constraint/);
    await t.db.query(`INSERT INTO users (email) VALUES ('dupe@example.com')`);
    await expect(t.db.query(`INSERT INTO users (email) VALUES ('dupe@example.com')`)).rejects.toThrow(/users_email_key/);
  });
});

describe('audit log', () => {
  it('is append-only: UPDATE, DELETE and TRUNCATE are rejected', async () => {
    await audit(t.db, { action: 'test.append_only', outcome: 'success' });
    await expect(t.db.query(`UPDATE audit_logs SET action = 'test.changed'`)).rejects.toThrow(/append-only/);
    await expect(t.db.query('DELETE FROM audit_logs')).rejects.toThrow(/append-only/);
    await expect(t.db.query('TRUNCATE audit_logs')).rejects.toThrow(/append-only/);
  });

  it('keeps a valid hash chain under concurrent writers', async () => {
    await Promise.all(Array.from({ length: 40 }, (_, i) => audit(t.db, { action: 'test.concurrent', outcome: 'success', metadata: { i } })));
    const { rows } = await t.db.query<{ broken: string | null; n: string; distinct_seq: string }>(
      `SELECT audit_verify_chain() AS broken, count(*) AS n, count(DISTINCT chain_seq) AS distinct_seq FROM audit_logs`,
    );
    expect(rows[0]!.broken).toBeNull();
    expect(rows[0]!.n).toBe(rows[0]!.distinct_seq);
  });

  it('detects tampering even by a database superuser who bypasses the triggers', async () => {
    await audit(t.db, { action: 'test.tamper_target', outcome: 'success', metadata: { amount: 1 } });
    const client = await t.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_update');
      await client.query(`UPDATE audit_logs SET metadata = '{"amount": 999}' WHERE action = 'test.tamper_target'`);
      const { rows } = await client.query<{ broken: string | null }>('SELECT audit_verify_chain() AS broken');
      expect(rows[0]!.broken).not.toBeNull();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    const after = await t.db.query<{ broken: string | null }>('SELECT audit_verify_chain() AS broken');
    expect(after.rows[0]!.broken).toBeNull();
  });
});
