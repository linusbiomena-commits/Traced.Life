import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assignBranch, customerWithRegistration, decodeQrPng, getBinary } from './helpers/registration.ts';
import { setupTestApp, type TestClient, type TestEnv } from './helpers/test-app.ts';

// Phase 7 milestone 4: server/sql/production-roles.sql applied to a throw-away test database. The
// application runs entirely as the least-privilege `traced_app` login: the main journeys must
// work, and everything outside its grants must be refused by PostgreSQL itself (42501), not only
// by the append-only triggers.

let t: TestEnv;
let branchId: string;
beforeAll(async () => {
  t = await setupTestApp({ appRole: true });
  t.config.auditCheckpointKey = randomBytes(32).toString('base64');
  branchId = (await t.db.query<{ id: string }>(`SELECT id FROM collection_branches WHERE code = 'DEV-RUH-01'`)).rows[0]!.id;
});
afterAll(async () => t.close());

const denied = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ code: '42501' });
const act = (c: TestClient, side: 'staff' | 'lab', code: string, action: string, expectedStatus: string, extra: Record<string, unknown> = {}) =>
  c.post(`/${side}/samples/action`, { code, action, expectedStatus, idempotencyKey: randomUUID(), ...extra });

describe('application running as traced_app', () => {
  it('connects as traced_app, not as the owner', async () => {
    const { rows } = await t.appDb.query<{ u: string; su: boolean }>(`SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su`);
    expect(rows[0]).toEqual({ u: 'traced_app', su: false });
  });

  it('full journey works: sign-up, registration, QR, collection, custody, laboratory, admin, MFA, audit integrity', async () => {
    const staff = await t.staff(['collection_staff']);
    await assignBranch(t, staff.userId, branchId);
    const lab = await t.mfaStaff(['lab_operator']);
    const sa = await t.mfaStaff(['super_admin']);
    const cust = await customerWithRegistration(t, { branchId });
    const text = decodeQrPng((await getBinary(t, cust.c, `/me/registrations/${cust.registration.id}/qr.png`)).body)!;
    const v = (await staff.c.post('/staff/qr/validate', { code: text, branchId })).body;
    const ready = (await staff.c.post(`/staff/collection-sessions/${v.collectionSessionId}/identity/dev`, { outcome: 'verified' })).body;
    const collected = await staff.c.post(`/staff/collection-sessions/${v.collectionSessionId}/collect`, {
      instructionsId: ready.collectionInstructions.id, checklist: ready.collectionInstructions.checklist.map((i: { id: string }) => i.id),
    });
    expect(collected.status).toBe(200);
    const sampleRowId = collected.body.collection.sample.id;
    expect((await staff.c.post(`/staff/samples/${sampleRowId}/label-print`, { reason: 'first print' })).status).toBeLessThan(500);
    const code = decodeQrPng((await getBinary(t, staff.c, `/staff/samples/${sampleRowId}/qr.png`)).body)!;
    expect((await act(staff.c, 'staff', code, 'package', 'collected')).status).toBe(200);
    expect((await act(staff.c, 'staff', code, 'ready_for_dispatch', 'packaged')).status).toBe(200);
    expect((await act(staff.c, 'staff', code, 'dispatch', 'ready_for_dispatch', { courier: 'SMSA Express', shipmentTrackingNumber: 'TEST-1' })).status).toBe(200);
    expect((await act(lab.c, 'lab', code, 'receive', 'dispatched', { condition: 'intact' })).status).toBe(200);
    expect((await act(lab.c, 'lab', code, 'start_analysis', 'received_by_laboratory')).status).toBe(200);
    expect((await cust.c.get(`/me/registrations/${cust.registration.id}`)).status).toBe(200);
    expect((await sa.c.get('/admin/registrations')).status).toBe(200);
    expect((await sa.c.get('/admin/audit-logs')).status).toBe(200);
    expect((await sa.c.get('/admin/reports/operational.csv')).status).toBe(200);
    // Role removal (DELETE on user_roles) and MFA reset (DELETE on recovery codes).
    expect((await sa.c.post(`/admin/staff/${lab.userId}/mfa-reset`, { reason: 'Lost phone, identity confirmed' })).status).toBe(200);
    expect((await sa.c.post('/admin/audit-integrity/checkpoint', {})).status).toBe(200);
    const verify = await sa.c.post('/admin/audit-integrity/verify', {});
    expect(verify.body).toMatchObject({ outcome: 'ok', findings: [] });
    await t.settleMail();
  });
});

describe('PostgreSQL refuses everything outside the grants', () => {
  it('no UPDATE, DELETE or TRUNCATE on evidence tables', async () => {
    for (const table of ['audit_logs', 'custody_events', 'consent_records', 'registration_status_history', 'identity_verifications', 'sample_label_prints', 'audit_checkpoints', 'audit_verifications', 'recollection_authorizations', 'registration_branch_transfers', 'patient_revisions']) {
      const col = (await t.db.query<{ c: string }>(`SELECT column_name AS c FROM information_schema.columns WHERE table_name = $1 AND is_identity = 'NO' AND is_generated = 'NEVER' ORDER BY ordinal_position LIMIT 1`, [table])).rows[0]!.c;
      await denied(t.appDb.query(`UPDATE ${table} SET ${col} = ${col} WHERE false`));
      await denied(t.appDb.query(`DELETE FROM ${table} WHERE false`));
      await denied(t.appDb.query(`TRUNCATE ${table}`));
    }
  });

  it('no DDL, no schema changes, no migration bookkeeping, no reference-data edits', async () => {
    await denied(t.appDb.query('CREATE TABLE evil (id int)'));
    await denied(t.appDb.query('DROP TABLE rate_limits'));
    await denied(t.appDb.query('ALTER TABLE audit_logs DISABLE TRIGGER USER'));
    await denied(t.appDb.query(`INSERT INTO schema_migrations (version, checksum) VALUES ('9999_x.sql', 'x')`));
    await denied(t.appDb.query(`UPDATE role_permissions SET permission_key = permission_key WHERE false`));
    await denied(t.appDb.query(`INSERT INTO role_permissions (role_key, permission_key) VALUES ('auditor', 'admin.manage')`));
    await denied(t.appDb.query('DELETE FROM users WHERE false'));
    await denied(t.appDb.query('DELETE FROM registrations WHERE false'));
  });

  it('cannot create roles or read other databases’ settings that need superuser', async () => {
    await expect(t.appDb.query('CREATE ROLE evil')).rejects.toMatchObject({ code: '42501' });
    const { rows } = await t.appDb.query<{ t: string }>('SHOW statement_timeout AS t').catch(() => t.appDb.query<{ t: string }>(`SELECT current_setting('statement_timeout') AS t`));
    expect(Object.values(rows[0]!)[0]).toBe('15s');
  });
});
