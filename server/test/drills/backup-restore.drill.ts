import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { createPool } from '../../src/db/pool.ts';
import { decryptSecret } from '../../src/modules/auth/mfa.ts';
import { MemoryMailer } from '../../src/modules/mail/mailer.ts';
import { enqueueEmail } from '../../src/modules/mail/outbox.ts';
import { assignBranch, customerWithRegistration, decodeQrPng, getBinary } from '../helpers/registration.ts';
import { GOOD_PASSWORD, setupTestApp, TestClient, totpCode } from '../helpers/test-app.ts';

// Phase 7 milestone 8: backup-and-restore drill on a throw-away synthetic cluster.
//
// The bundled PostgreSQL has no pg_dump, so the drill takes a cold physical copy of the stopped
// cluster (the same idea as a Cloud SQL backup: a consistent image of the whole instance), keeps
// writing to the original after the backup, restores the copy as a separate server on another
// port, and checks: row counts and content fingerprints of every table, the audit hash chain,
// signed checkpoints against the external copies, decryption of application-encrypted data with
// the keys kept outside the database, wrong-key behaviour, and that the application works on the
// restored database (sign-in, MFA, registration detail). Writes docs/backup/drill-results.md.

// pg_ctl starts the server as a child that would inherit piped stdout/stderr handles; with
// execFile the call then never returns on Windows. No pipes: wait for pg_ctl's own exit code.
function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
    p.once('error', reject);
    p.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`pg_ctl ${args[0]} exited with ${code}`))));
  });
}
async function pgCtl(): Promise<string> {
  const os = process.platform === 'win32' ? 'windows' : process.platform;
  return ((await import(`@embedded-postgres/${os}-${process.arch}`)) as { pg_ctl: string }).pg_ctl;
}
const freePort = () => new Promise<number>((resolve, reject) => {
  const srv = createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address() as { port: number };
    srv.close(() => resolve(port));
  });
});
const dirSize = (d: string): number => readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? dirSize(path.join(d, e.name)) : statSync(path.join(d, e.name)).size), 0);

const scratch = mkdtempSync(path.join(tmpdir(), 'traced-drill-'));
const restoredDir = path.join(scratch, 'restored-data');
const sinkDir = path.join(scratch, 'checkpoints');
const started: string[] = [];
async function start(dataDir: string, port: number) {
  await run(await pgCtl(), ['start', '-D', dataDir, '-w', '-t', '60', '-l', path.join(scratch, `pg-${port}.log`), '-o', `-p ${port} -c max_connections=25`]);
  started.push(dataDir);
}
async function stop(dataDir: string) {
  await run(await pgCtl(), ['stop', '-D', dataDir, '-m', 'fast', '-w', '-t', '60']);
  const i = started.indexOf(dataDir);
  if (i >= 0) started.splice(i, 1);
}
afterAll(async () => {
  for (const d of [...started]) await stop(d).catch(() => {});
  rmSync(scratch, { recursive: true, force: true });
});

/** Row count and an order-independent content fingerprint for every application table. */
async function fingerprint(db: pg.Pool | pg.Client) {
  const tables = (await db.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows.map((r) => r.t);
  const out: Record<string, { rows: number; md5: string }> = {};
  for (const tb of tables) {
    const r = await db.query<{ n: string; h: string | null }>(`SELECT count(*) AS n, md5(string_agg(x::text, E'\\n' ORDER BY x::text)) AS h FROM ${tb} x`);
    out[tb] = { rows: Number(r.rows[0]!.n), md5: r.rows[0]!.h ?? '' };
  }
  return out;
}

describe('backup and restore drill (synthetic data)', () => {
  it('restores a consistent, verifiable, usable copy; later writes are absent and detected', async () => {
    const report: string[] = [];
    const t = await setupTestApp();
    t.config.auditCheckpointKey = randomBytes(32).toString('base64');
    t.config.auditCheckpointDir = sinkDir;
    const dbName = t.config.databaseUrl.split('/').pop()!;
    const dataDir = inject('pgDataDir');
    const portA = inject('pgPort');

    // 1. Synthetic activity that exercises every kind of stored data.
    const branchId = (await t.db.query<{ id: string }>(`SELECT id FROM collection_branches WHERE code = 'DEV-RUH-01'`)).rows[0]!.id;
    const staff = await t.staff(['collection_staff']);
    await assignBranch(t, staff.userId, branchId);
    const lab = await t.mfaStaff(['lab_operator']);
    const sa = await t.mfaStaff(['super_admin']);
    const custs = [];
    for (let i = 0; i < 6; i++) custs.push(await customerWithRegistration(t, { branchId }));
    for (const cu of custs.slice(0, 3)) {
      const text = decodeQrPng((await getBinary(t, cu.c, `/me/registrations/${cu.registration.id}/qr.png`)).body)!;
      const v = (await staff.c.post('/staff/qr/validate', { code: text, branchId })).body;
      const ready = (await staff.c.post(`/staff/collection-sessions/${v.collectionSessionId}/identity/dev`, { outcome: 'verified' })).body;
      expect((await staff.c.post(`/staff/collection-sessions/${v.collectionSessionId}/collect`, {
        instructionsId: ready.collectionInstructions.id, checklist: ready.collectionInstructions.checklist.map((x: { id: string }) => x.id),
      })).status).toBe(200);
    }
    // Patient correction (encrypted previous values) and a queued email with an encrypted payload.
    expect((await sa.c.patch(`/admin/registrations/${custs[3]!.registration.id}/patient`, { patient: { firstName: 'Corrected', lastName: 'Name', dateOfBirth: '2016-03-04', gender: 'female' }, reason: 'Drill: correct a typo' })).status).toBe(200);
    expect((await sa.c.post('/admin/audit-integrity/checkpoint', {})).status).toBe(200);
    await t.settleMail();
    // Queued after the flush so it is still undelivered (payload encrypted) at backup time.
    const queuedId = await enqueueEmail(t.db, t.deps, { kind: 'password_changed', locale: 'en', to: 'drill.queued@example.com', data: { marker: 'drill-payload' } });

    const before = await fingerprint(t.db);
    const totalRows = Object.values(before).reduce((n, x) => n + x.rows, 0);
    report.push(`Synthetic data before the backup: ${totalRows} rows across ${Object.keys(before).length} tables (${before.registrations!.rows} registrations, ${before.samples!.rows} samples, ${before.custody_events!.rows} custody events, ${before.audit_logs!.rows} audit entries).`);

    // 2. Backup: stop cleanly, copy the whole cluster, measure.
    await t.db.end();
    let s = performance.now();
    await stop(dataDir);
    const stopMs = Math.round(performance.now() - s);
    s = performance.now();
    cpSync(dataDir, restoredDir, { recursive: true, filter: (src) => !/postmaster\.(pid|opts)$/.test(src) });
    const copyMs = Math.round(performance.now() - s);
    const sizeMb = (dirSize(restoredDir) / 2 ** 20).toFixed(1);
    report.push(`Cold backup: clean stop ${stopMs} ms, copy of ${sizeMb} MB in ${copyMs} ms.`);

    // 3. Writes after the backup on the original (these must NOT be in the restore).
    await start(dataDir, portA);
    const baseA = t.config.databaseUrl.replace(/\/[^/]+$/, '');
    const dbA = createPool(`${baseA}/${dbName}`, 5);
    const appA = createApp({ ...t.deps, db: dbA });
    const late = new TestClient(appA, '198.51.100.77');
    const lateSignIn = await late.post('/auth/sign-in', { email: custs[5]!.email, password: GOOD_PASSWORD });
    expect(lateSignIn.status, JSON.stringify(lateSignIn.body)).toBe(200);
    expect((await late.get(`/me/registrations/${custs[5]!.registration.id}`)).status).toBe(200); // audited view = new audit rows
    const saLate = new TestClient(appA, '198.51.100.78');
    await saLate.post('/auth/sign-in', { email: sa.email, password: GOOD_PASSWORD });
    await saLate.post('/auth/mfa/verify', { code: totpCode(sa.secret, 1) });
    expect((await saLate.post('/admin/audit-integrity/checkpoint', {})).status).toBe(200); // checkpoint #2, after the backup
    const afterA = await fingerprint(dbA);
    await dbA.end();
    await stop(dataDir);

    // 4. Restore: start the copy as its own server on another port.
    const portB = await freePort();
    s = performance.now();
    await start(restoredDir, portB);
    const startMs = Math.round(performance.now() - s);
    const baseB = baseA.replace(`:${portA}`, `:${portB}`);
    const dbB = createPool(`${baseB}/${dbName}`, 5);
    report.push(`Restore: copy started as a separate server in ${startMs} ms (crash-recovery not needed: the backup was taken from a cleanly stopped server).`);

    // 5. Verification.
    const restored = await fingerprint(dbB);
    const mismatched = Object.keys(before).filter((tb) => before[tb]!.md5 !== restored[tb]!.md5 || before[tb]!.rows !== restored[tb]!.rows);
    expect(mismatched).toEqual([]);
    report.push(`Every table matches the pre-backup fingerprint (row count and content hash): ${Object.keys(before).length} / ${Object.keys(before).length}.`);
    const lateTables = Object.keys(afterA).filter((tb) => afterA[tb]!.md5 !== restored[tb]!.md5);
    expect(lateTables).toEqual(expect.arrayContaining(['audit_logs', 'audit_checkpoints']));
    report.push(`Writes made after the backup are absent from the restore, as expected (tables that differ from the live original: ${lateTables.join(', ')}). This is the recovery point: anything after the last backup or log position is lost.`);
    expect((await dbB.query('SELECT audit_verify_chain() AS r')).rows[0].r).toBeNull();

    // Application on the restored database, same keys.
    const depsB = { ...t.deps, db: dbB };
    const appB = createApp(depsB);
    const c = new TestClient(appB, '198.51.100.90');
    expect((await c.post('/auth/sign-in', { email: custs[0]!.email, password: GOOD_PASSWORD })).status).toBe(200);
    expect((await c.get(`/me/registrations/${custs[0]!.registration.id}`)).status).toBe(200);
    const labC = new TestClient(appB, '198.51.100.91');
    await labC.post('/auth/sign-in', { email: lab.email, password: GOOD_PASSWORD });
    expect((await labC.post('/auth/mfa/verify', { code: totpCode(lab.secret, 1) })).status).toBe(200); // encrypted TOTP secret decrypts
    expect((await labC.get('/lab/dashboard')).status).toBe(200);
    const enc = (await dbB.query<{ e: string }>('SELECT mfa_totp_secret_enc AS e FROM users WHERE id = $1', [lab.userId])).rows[0]!.e;
    expect(decryptSecret(depsB, lab.userId, enc, 'active')).toBe(lab.secret);
    expect((await dbB.query('SELECT payload_enc IS NOT NULL AS has FROM email_outbox WHERE id = $1', [queuedId])).rows[0].has).toBe(true);
    // Wrong key (e.g. the data key was not backed up): encrypted data is unreadable.
    const wrong = { ...depsB, config: { ...depsB.config, dataEncryptionKey: randomBytes(32) } };
    expect(() => decryptSecret(wrong, lab.userId, enc, 'active')).toThrow();
    report.push('Application on the restored database with the same keys: customer sign-in and registration detail work; the laboratory operator completes two-step verification (the encrypted authenticator secret decrypts); a queued email still has its encrypted payload. With a different DATA_ENCRYPTION_KEY the encrypted values cannot be read: the keys must be backed up separately from the database (Secret Manager versions are kept; never destroy a key version while backups made with it are retained).');

    // Integrity verification on the restore against the external checkpoint copies.
    const saB = new TestClient(appB, '198.51.100.92');
    await saB.post('/auth/sign-in', { email: sa.email, password: GOOD_PASSWORD });
    // The restore never saw the step used on the original after the backup, so +1 is valid here.
    expect((await saB.post('/auth/mfa/verify', { code: totpCode(sa.secret, 1) })).status).toBe(200);
    const v = await saB.post('/admin/audit-integrity/verify', {});
    expect(v.status).toBe(200);
    const codes: string[] = v.body.findings.map((f: { code: string }) => f.code);
    expect(v.body.firstBrokenSeq).toBeNull();
    expect(codes).toContain('checkpoint_missing_in_database'); // checkpoint #2 exists only in the external copy
    report.push(`Audit verification on the restore: hash chain intact; the external copy of the checkpoint signed after the backup has no database row, reported as \`checkpoint_missing_in_database\` (findings: ${[...new Set(codes)].join(', ')}). This is expected after any restore to an earlier point and must be recorded in the incident log, not "fixed".`);

    await dbB.end();
    await stop(restoredDir);

    mkdirSync(path.resolve('docs/backup'), { recursive: true });
    writeFileSync(path.resolve('docs/backup/drill-results.md'), [
      '# TRACED: Backup and restore drill results',
      '',
      `Run by \`npm run drill:backup\` on ${new Date().toISOString().slice(0, 10)} on a throw-away local cluster with synthetic data only (temporary folder, random ports; never the development database). Procedure and what this does not prove: \`docs/backup/README.md\`.`,
      '',
      ...report.map((r, i) => `${i + 1}. ${r}`),
      '',
      '## Table fingerprints (restored copy)',
      '',
      '| table | rows | content hash (first 12) | matches pre-backup |', '|---|---|---|---|',
      ...Object.entries(restored).map(([tb, x]) => `| ${tb} | ${x.rows} | \`${x.md5.slice(0, 12)}\` | ${before[tb]!.md5 === x.md5 ? 'yes' : 'NO'} |`),
      '',
    ].join('\n'));
  });
});
