import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { randomBytes } from 'node:crypto';
import { assignBranch, customerWithRegistration, decodeQrPng, getBinary, register, yearsAgo } from './helpers/registration.ts';
import { GOOD_PASSWORD, setupTestApp, TestClient, type TestEnv } from './helpers/test-app.ts';
import { extractCustomerToken, newCustomerToken } from '../src/modules/qr/qr.service.ts';

let t: TestEnv;
let branch: Record<string, string>;
beforeAll(async () => {
  t = await setupTestApp();
  const { rows } = await t.db.query<{ code: string; id: string }>('SELECT code, id FROM collection_branches');
  branch = Object.fromEntries(rows.map((r) => [r.code, r.id]));
});
afterAll(async () => {
  await t.close();
});

const SCAN_KEYS = ['branch', 'canCollect', 'collectionInstructions', 'collectionSessionId', 'devVerificationAvailable', 'identityVerification', 'patientAge', 'patientGender', 'qrValid', 'sampleStatus', 'sampleType', 'trackingId'];
const HISTORY_KEYS = ['branch', 'collectedAt', 'collectedByMe', 'patientAge', 'patientGender', 'sampleStatus', 'sampleType', 'trackingId'];

async function staffAt(codes: string[], name = 'Sara Collector') {
  const s = await t.staff(['collection_staff']);
  await t.db.query('UPDATE users SET full_name = $2 WHERE id = $1', [s.userId, name]);
  for (const code of codes) await assignBranch(t, s.userId, branch[code]!);
  return s;
}

/** A registration at the first dev branch (DEV-RUH-01) and the text of its QR code. */
async function registrationWithQr(overrides: Record<string, unknown> = {}) {
  const cust = await customerWithRegistration(t, overrides);
  const png = await getBinary(t, cust.c, `/me/registrations/${cust.registration.id}/qr.png`);
  const text = decodeQrPng(png.body)!;
  return { ...cust, text, token: extractCustomerToken(text)! };
}

const scan = (c: TestClient, code: string, branchId = branch['DEV-RUH-01']) => c.post('/staff/qr/validate', { code, branchId });
const verify = (c: TestClient, sessionId: string, outcome: 'pending' | 'verified' | 'failed') => c.post(`/staff/collection-sessions/${sessionId}/identity/dev`, { outcome });
const collect = (c: TestClient, sessionId: string, view: { collectionInstructions: { id: string; checklist: { id: string }[] } }) =>
  c.post(`/staff/collection-sessions/${sessionId}/collect`, { instructionsId: view.collectionInstructions.id, checklist: view.collectionInstructions.checklist.map((i) => i.id) });

/** Scans, verifies (dev) and returns the ready-to-collect view. */
async function readyToCollect(staff: TestClient, text: string) {
  const v = (await scan(staff, text)).body;
  expect(v.qrValid).toBe(true);
  return (await verify(staff, v.collectionSessionId, 'verified')).body;
}

describe('staff authentication and authorisation', () => {
  it('invited staff set a password, sign in and see their name and assigned branches only', async () => {
    const s = await staffAt(['DEV-RUH-01', 'DEV-JED-01'], 'Noura Staff');
    const me = await s.c.get('/staff/me');
    expect(me.status).toBe(200);
    expect(me.body.staff).toEqual({ name: 'Noura Staff', email: s.email, locale: 'en' });
    expect(me.body.branches.map((b: { id: string }) => b.id).sort()).toEqual([branch['DEV-RUH-01'], branch['DEV-JED-01']].sort());
    expect(me.body.devVerificationAvailable).toBe(true);
  });

  it('customers, signed-out users, lab operators and auditors cannot use staff endpoints', async () => {
    const cust = await t.customer();
    const lab = await t.mfaStaff(['lab_operator']);
    const auditor = await t.mfaStaff(['auditor']);
    for (const path of ['/staff/me', `/staff/dashboard?branchId=${branch['DEV-RUH-01']}`, '/staff/history']) {
      expect((await cust.c.get(path)).status, `customer ${path}`).toBe(403);
      expect((await t.client().get(path)).status, `anon ${path}`).toBe(401);
      expect((await lab.c.get(path)).status, `lab ${path}`).toBe(403);
      expect((await auditor.c.get(path)).status, `auditor ${path}`).toBe(403);
    }
    expect((await cust.c.post('/staff/qr/validate', { code: newCustomerToken() })).status).toBe(403);
  });

  it('collection staff cannot reach administrative endpoints', async () => {
    const s = await staffAt(['DEV-RUH-01']);
    const { registration } = await registrationWithQr();
    expect((await s.c.get('/admin/audit-logs')).status).toBe(403);
    expect((await s.c.post(`/admin/registrations/${registration.id}/qr/revoke`, { reason: 'trying to revoke' })).status).toBe(403);
  });

  it('a suspended staff account loses access immediately', async () => {
    const s = await staffAt(['DEV-RUH-01']);
    expect((await s.c.get('/staff/me')).status).toBe(200);
    await t.db.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [s.userId]);
    expect((await s.c.get('/staff/me')).status).toBe(401);
    expect((await t.client().post('/auth/sign-in', { email: s.email, password: GOOD_PASSWORD })).status).toBe(401);
  });

  it('branch assignment is enforced on every staff read', async () => {
    const s = await staffAt(['DEV-JED-01']);
    expect((await s.c.get(`/staff/dashboard?branchId=${branch['DEV-RUH-01']}`)).body.error.code).toBe('BRANCH_NOT_AUTHORIZED');
    expect((await s.c.get(`/staff/history?branchId=${branch['DEV-RUH-01']}`)).body.error.code).toBe('BRANCH_NOT_AUTHORIZED');
    expect((await s.c.get(`/staff/dashboard?branchId=${branch['DEV-JED-01']}`)).status).toBe(200);
  });
});

describe('QR scanning outcomes', () => {
  it('valid QR at the right branch: allowlisted view, new session, identity NOT verified by the scan', async () => {
    const { text, registration } = await registrationWithQr();
    const s = await staffAt(['DEV-RUH-01']);
    const res = await scan(s.c, text);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(SCAN_KEYS);
    expect(res.body).toMatchObject({
      qrValid: true, trackingId: registration.trackingId, patientGender: 'female', sampleType: 'hair',
      sampleStatus: 'awaiting_sample_collection', identityVerification: { status: 'not_verified', method: null }, canCollect: false,
      branch: { id: branch['DEV-RUH-01'] },
    });
    expect(res.body.collectionInstructions).toMatchObject({ version: '0.1-provisional', provisional: true });
    expect(res.body.collectionInstructions.checklist.length).toBeGreaterThan(0);
    // Scanning the same QR again resumes the same session (no duplicate sessions).
    expect((await scan(s.c, text)).body.collectionSessionId).toBe(res.body.collectionSessionId);
  });

  it('invalid, malformed, unknown and tracking-ID-only input never authorises anything', async () => {
    const { registration } = await registrationWithQr();
    const s = await staffAt(['DEV-RUH-01']);
    expect((await scan(s.c, newCustomerToken())).body).toEqual({ qrValid: false, reason: 'NOT_FOUND' });
    expect((await scan(s.c, registration.trackingId)).body).toEqual({ qrValid: false, reason: 'UNRECOGNISED' });
    expect((await scan(s.c, 'https://evil.example/#c1_short')).body).toEqual({ qrValid: false, reason: 'UNRECOGNISED' });
    expect((await scan(s.c, '')).status).toBe(422);
  });

  it('wrong branch selected, or unassigned branch: refused without revealing the patient', async () => {
    const { text } = await registrationWithQr();
    const jeddahOnly = await staffAt(['DEV-JED-01']);
    const res = await scan(jeddahOnly.c, text, branch['DEV-JED-01']);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('BRANCH_NOT_AUTHORIZED');
    expect(JSON.stringify(res.body)).not.toMatch(/Layla|TRC-SA|female/);
    const both = await staffAt(['DEV-RUH-01', 'DEV-JED-01']);
    expect((await scan(both.c, text, branch['DEV-JED-01'])).status).toBe(403); // registered for Riyadh, Jeddah selected
    expect((await scan(both.c, text, branch['DEV-RUH-01'])).body.qrValid).toBe(true);
  });

  it('revoked, replaced, cancelled and already-collected registrations are reported precisely', async () => {
    const s = await staffAt(['DEV-RUH-01']);
    const admin = await t.mfaStaff(['admin']);

    const a = await registrationWithQr();
    await admin.c.post(`/admin/registrations/${a.registration.id}/qr/revoke`, { reason: 'Reported lost by customer', regenerate: false });
    expect((await scan(s.c, a.text)).body).toEqual({ qrValid: false, reason: 'REVOKED' });

    const b = await registrationWithQr();
    await b.c.post(`/me/registrations/${b.registration.id}/qr/regenerate`, {});
    expect((await scan(s.c, b.text)).body).toEqual({ qrValid: false, reason: 'REPLACED' });

    const c = await registrationWithQr();
    await t.db.query(`UPDATE registrations SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [c.registration.id]);
    expect((await scan(s.c, c.text)).body).toEqual({ qrValid: false, reason: 'REGISTRATION_INACTIVE' });

    const d = await registrationWithQr();
    const ready = await readyToCollect(s.c, d.text);
    expect((await collect(s.c, ready.collectionSessionId, ready)).status).toBe(200);
    expect((await scan(s.c, d.text)).body).toEqual({ qrValid: false, reason: 'ALREADY_COLLECTED', trackingId: d.registration.trackingId, sampleStatus: 'sample_collected' });
  });

  it('repeated invalid scans are rate limited (10 per 5 minutes)', async () => {
    const s = await staffAt(['DEV-RUH-01']);
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await scan(s.c, newCustomerToken())).status);
    expect(statuses.slice(0, 10).every((x) => x === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe('QR revocation permissions', () => {
  it('admins can revoke with a mandatory reason; the old token dies, the tracking ID stays, the customer is emailed, and it is audited', async () => {
    const { registration, text, email, c } = await registrationWithQr();
    const admin = await t.mfaStaff(['admin']);
    expect((await admin.c.post(`/admin/registrations/${registration.id}/qr/revoke`, {})).status).toBe(422);
    expect((await admin.c.post(`/admin/registrations/${registration.id}/qr/revoke`, { reason: 'x' })).status).toBe(422);
    const res = await admin.c.post(`/admin/registrations/${registration.id}/qr/revoke`, { reason: 'QR photo posted publicly' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'replaced', trackingId: registration.trackingId, regenerated: true });

    const s = await staffAt(['DEV-RUH-01']);
    expect((await scan(s.c, text)).body.reason).toBe('REPLACED');
    const fresh = decodeQrPng((await getBinary(t, c, `/me/registrations/${registration.id}/qr.png`)).body)!;
    expect(fresh).not.toBe(text);
    expect((await scan(s.c, fresh)).body.qrValid).toBe(true);
    await t.waitForMail(email, 'registration_qr_resend');

    const a = await t.db.query(`SELECT actor_user_id, actor_role, metadata FROM audit_logs WHERE action = 'qr.regenerated' AND target_id = $1`, [registration.id]);
    expect(a.rows[0]).toMatchObject({ actor_user_id: admin.userId, actor_role: 'admin', metadata: { reason: 'admin: QR photo posted publicly', regenerated: true } });
    const tok = await t.db.query(`SELECT revoked_by, revoked_at IS NOT NULL AS has_time FROM customer_qr_tokens WHERE registration_id = $1 AND status = 'revoked'`, [registration.id]);
    expect(tok.rows[0]).toEqual({ revoked_by: admin.userId, has_time: true });
  });

  it('super admins may revoke; staff, lab operators and auditors may not; customers only their own', async () => {
    const { registration } = await registrationWithQr();
    const sup = await t.mfaStaff(['super_admin']);
    expect((await sup.c.post(`/admin/registrations/${registration.id}/qr/revoke`, { reason: 'Security review' })).status).toBe(200);
    for (const roles of [['lab_operator'], ['auditor']] as const) {
      const u = await t.mfaStaff([...roles]);
      expect((await u.c.post(`/admin/registrations/${registration.id}/qr/revoke`, { reason: 'Not allowed here' })).status).toBe(403);
    }
    const staff = await staffAt(['DEV-RUH-01']);
    expect((await staff.c.post(`/admin/registrations/${registration.id}/qr/revoke`, { reason: 'Not allowed here' })).status).toBe(403);
    expect((await staff.c.post(`/me/registrations/${registration.id}/qr/regenerate`, {})).status).toBe(403);
    const other = await t.customer();
    expect((await other.c.post(`/me/registrations/${registration.id}/qr/regenerate`, {})).status).toBe(404);
  });

  it('after an admin revokes without replacement, the customer can still get a new QR', async () => {
    const { registration, c } = await registrationWithQr();
    const admin = await t.mfaStaff(['admin']);
    await admin.c.post(`/admin/registrations/${registration.id}/qr/revoke`, { reason: 'Suspicious activity', regenerate: false });
    expect((await c.get(`/me/registrations/${registration.id}`)).body.registration.qrCode.available).toBe(false);
    expect((await c.post(`/me/registrations/${registration.id}/qr/regenerate`, {})).status).toBe(200);
    expect((await c.get(`/me/registrations/${registration.id}`)).body.registration.qrCode.available).toBe(true);
  });
});

describe('identity verification framework', () => {
  it('moves through not verified → pending → failed → verified, recorded append-only with method and staff account', async () => {
    const { text, registration } = await registrationWithQr();
    const s = await staffAt(['DEV-RUH-01']);
    const v = (await scan(s.c, text)).body;
    expect(v.identityVerification.status).toBe('not_verified');
    expect((await verify(s.c, v.collectionSessionId, 'pending')).body.identityVerification).toEqual({ status: 'pending', method: 'dev_simulated' });
    expect((await collect(s.c, v.collectionSessionId, v)).body.error.code).toBe('IDENTITY_NOT_VERIFIED');
    expect((await verify(s.c, v.collectionSessionId, 'failed')).body.canCollect).toBe(false);
    expect((await collect(s.c, v.collectionSessionId, v)).body.error.code).toBe('IDENTITY_NOT_VERIFIED');
    const ok = (await verify(s.c, v.collectionSessionId, 'verified')).body;
    expect(ok).toMatchObject({ identityVerification: { status: 'verified', method: 'dev_simulated' }, canCollect: true });
    const rows = await t.db.query('SELECT status, method, performed_by FROM identity_verifications WHERE registration_id = $1 ORDER BY id', [registration.id]);
    expect(rows.rows.map((r) => r.status)).toEqual(['pending', 'failed', 'verified']);
    expect(rows.rows.every((r) => r.performed_by === s.userId && r.method === 'dev_simulated')).toBe(true);
    await expect(t.db.query(`UPDATE identity_verifications SET status = 'verified'`)).rejects.toThrow(/append-only/);
  });

  it('a correction to the patient’s details invalidates an earlier verification', async () => {
    const { text, registration, c } = await registrationWithQr();
    const s = await staffAt(['DEV-RUH-01']);
    const ready = await readyToCollect(s.c, text);
    expect(ready.canCollect).toBe(true);
    await c.request('PATCH', `/me/registrations/${registration.id}/patient`, { patient: { firstName: 'Leila', lastName: 'Al-Harbi', dateOfBirth: registration.patient.dateOfBirth, gender: 'female' } });
    const after = (await s.c.get(`/staff/collection-sessions/${ready.collectionSessionId}`)).body;
    expect(after.identityVerification.status).toBe('not_verified');
    expect((await collect(s.c, ready.collectionSessionId, ready)).body.error.code).toBe('IDENTITY_NOT_VERIFIED');
  });

  it('the development mechanism is unavailable when disabled, and the configuration refuses it in production', async () => {
    const app = createApp({ ...t.deps, config: { ...t.config, devIdentityVerification: false } });
    const { text } = await registrationWithQr();
    const s = await staffAt(['DEV-RUH-01']);
    const v = (await scan(s.c, text)).body;
    const res = await app.request(`/api/v1/staff/collection-sessions/${v.collectionSessionId}/identity/dev`, {
      method: 'POST', headers: { cookie: s.c.cookie!, 'x-csrf-token': s.c.csrf!, 'content-type': 'application/json', origin: 'http://localhost:8787' }, body: JSON.stringify({ outcome: 'verified' }),
    });
    expect(res.status).toBe(404);
    const base = { APP_ORIGIN: 'https://t.example.sa', DATABASE_URL: 'postgres://x', TOKEN_HMAC_KEY: randomBytes(32).toString('base64'), DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'), MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_abc', MAIL_FROM: 'a@b.sa', TRUSTED_PROXY_HOPS: '2' };
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', DEV_IDENTITY_VERIFICATION: 'true' })).toThrow(/never be enabled in production/);
    expect(loadConfig({ ...base, NODE_ENV: 'production', DEV_IDENTITY_VERIFICATION: 'false' }).devIdentityVerification).toBe(false);
  });
});

describe('sample collection confirmation', () => {
  it('records everything in one transaction and updates the customer’s view', async () => {
    const { text, registration, c } = await registrationWithQr();
    const s = await staffAt(['DEV-RUH-01']);
    const ready = await readyToCollect(s.c, text);
    const res = await collect(s.c, ready.collectionSessionId, ready);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.collection).sort()).toEqual(['branch', 'collectedAt', 'sample', 'status', 'trackingId']);
    expect(Object.keys(res.body.collection.sample).sort()).toEqual(['id', 'sampleId']); // Phase 6: physical sample for the label
    expect(res.body.collection).toMatchObject({ trackingId: registration.trackingId, status: 'sample_collected' });

    const sample = (await t.db.query(
      `SELECT s.registration_id, s.branch_id, s.collected_by, s.checklist, i.version, v.status AS verification, v.method
         FROM samples s JOIN collection_instructions i ON i.id = s.instructions_id JOIN identity_verifications v ON v.id = s.identity_verification_id
        WHERE s.registration_id = $1`, [registration.id])).rows;
    expect(sample).toHaveLength(1);
    expect(sample[0]).toMatchObject({ branch_id: branch['DEV-RUH-01'], collected_by: s.userId, version: '0.1-provisional', verification: 'verified', method: 'dev_simulated' });
    expect(sample[0]!.checklist).toEqual(ready.collectionInstructions.checklist.map((i: { id: string }) => i.id).sort());
    const hist = (await t.db.query(`SELECT from_status, to_status, changed_by, actor_role FROM registration_status_history WHERE registration_id = $1 ORDER BY id DESC LIMIT 1`, [registration.id])).rows[0];
    expect(hist).toEqual({ from_status: 'awaiting_sample_collection', to_status: 'sample_collected', changed_by: s.userId, actor_role: 'collection_staff' });
    expect((await t.db.query(`SELECT status FROM customer_qr_tokens WHERE registration_id = $1`, [registration.id])).rows[0]!.status).toBe('used');
    expect((await t.db.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'sample.collected' AND target_id = $1`, [registration.id])).rows[0]!.n).toBe(1);

    const mine = (await c.get(`/me/registrations/${registration.id}`)).body.registration;
    expect(mine).toMatchObject({ status: 'sample_collected', trackingId: registration.trackingId, qrCode: { available: false }, canRegenerateQr: false });
    expect(mine.collection.branch.nameEn).toBe('[DEV] Riyadh sample branch');
    expect(mine.statusHistory.at(-1).status).toBe('sample_collected');
    expect((await getBinary(t, c, `/me/registrations/${registration.id}/qr.png`)).status).toBe(404);
    expect((await c.post(`/me/registrations/${registration.id}/qr/regenerate`, {})).body.error.code).toBe('QR_LOCKED');
  });

  it('requires the complete checklist of the current instructions', async () => {
    const { text } = await registrationWithQr();
    const s = await staffAt(['DEV-RUH-01']);
    const ready = await readyToCollect(s.c, text);
    const ids = ready.collectionInstructions.checklist.map((i: { id: string }) => i.id);
    const partial = await s.c.post(`/staff/collection-sessions/${ready.collectionSessionId}/collect`, { instructionsId: ready.collectionInstructions.id, checklist: ids.slice(1) });
    expect(partial.body.error.code).toBe('CHECKLIST_INCOMPLETE');
    const unknown = await s.c.post(`/staff/collection-sessions/${ready.collectionSessionId}/collect`, { instructionsId: crypto.randomUUID(), checklist: ids });
    expect(unknown.body.error.code).toBe('INSTRUCTIONS_OUTDATED');
  });

  it('only the staff member who scanned can use the session; customers can’t confirm', async () => {
    const { text, c } = await registrationWithQr();
    const s1 = await staffAt(['DEV-RUH-01']);
    const s2 = await staffAt(['DEV-RUH-01']);
    const ready = await readyToCollect(s1.c, text);
    expect((await collect(s2.c, ready.collectionSessionId, ready)).status).toBe(404);
    expect((await s2.c.get(`/staff/collection-sessions/${ready.collectionSessionId}`)).status).toBe(404);
    expect((await collect(c, ready.collectionSessionId, ready)).status).toBe(403);
  });

  it('duplicates are impossible: 8 simultaneous confirmations from two staff members yield exactly one sample', async () => {
    const { text, registration } = await registrationWithQr();
    const s1 = await staffAt(['DEV-RUH-01']);
    const s2 = await staffAt(['DEV-RUH-01']);
    const r1 = await readyToCollect(s1.c, text);
    const r2 = await readyToCollect(s2.c, text);
    const results = await Promise.all([
      ...Array.from({ length: 4 }, () => collect(s1.c, r1.collectionSessionId, r1)),
      ...Array.from({ length: 4 }, () => collect(s2.c, r2.collectionSessionId, r2)),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.error.code === 'ALREADY_COLLECTED')).toBe(true);
    expect((await t.db.query('SELECT count(*)::int AS n FROM samples WHERE registration_id = $1', [registration.id])).rows[0]!.n).toBe(1);
    expect((await collect(s1.c, r1.collectionSessionId, r1)).body.error.code).toBe('ALREADY_COLLECTED');
  });

  it('a QR replaced before or during confirmation can’t be used, and the end state is always consistent', async () => {
    const s = await staffAt(['DEV-RUH-01']);
    const a = await registrationWithQr();
    const ready = await readyToCollect(s.c, a.text);
    await a.c.post(`/me/registrations/${a.registration.id}/qr/regenerate`, {});
    expect((await collect(s.c, ready.collectionSessionId, ready)).body.error.code).toBe('QR_REPLACED');

    for (let i = 0; i < 3; i++) {
      const b = await registrationWithQr();
      const rb = await readyToCollect(s.c, b.text);
      const [confirm, replace] = await Promise.all([collect(s.c, rb.collectionSessionId, rb), b.c.post(`/me/registrations/${b.registration.id}/qr/regenerate`, {})]);
      const tokens = (await t.db.query(`SELECT status FROM customer_qr_tokens WHERE registration_id = $1 ORDER BY created_at`, [b.registration.id])).rows.map((r) => r.status);
      const samples = (await t.db.query('SELECT count(*)::int AS n FROM samples WHERE registration_id = $1', [b.registration.id])).rows[0]!.n;
      if (confirm.status === 200) {
        expect(replace.body.error.code).toBe('QR_LOCKED');
        expect(tokens).toEqual(['used']);
        expect(samples).toBe(1);
      } else {
        expect(confirm.body.error.code).toBe('QR_REPLACED');
        expect(replace.status).toBe(200);
        expect(tokens).toEqual(['revoked', 'active']);
        expect(samples).toBe(0);
      }
    }
  });

  it('losing the branch assignment or being suspended mid-collection blocks confirmation', async () => {
    const { text } = await registrationWithQr();
    const s = await staffAt(['DEV-RUH-01']);
    const ready = await readyToCollect(s.c, text);
    await t.db.query('UPDATE staff_branch_assignments SET revoked_at = now() WHERE user_id = $1', [s.userId]);
    expect((await collect(s.c, ready.collectionSessionId, ready)).body.error.code).toBe('BRANCH_NOT_AUTHORIZED');

    const other = await registrationWithQr();
    const s2 = await staffAt(['DEV-RUH-01']);
    const r2 = await readyToCollect(s2.c, other.text);
    await t.db.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [s2.userId]);
    expect((await collect(s2.c, r2.collectionSessionId, r2)).status).toBe(401);
  });
});

describe('collection history and dashboard', () => {
  it('show only allowlisted fields for assigned branches, with working filters', async () => {
    const s = await staffAt(['DEV-JED-01'], 'History Staff');
    const regs = [];
    for (let i = 0; i < 3; i++) {
      const r = await registrationWithQr({ branchId: branch['DEV-JED-01'], patient: { firstName: ['Canaryone', 'Canarytwo', 'Canarythree'][i]!, lastName: 'Secretname', dateOfBirth: yearsAgo(30 + i), gender: i % 2 ? 'male' : 'female' }, relationship: 'authorized_dependent' });
      const v = (await scan(s.c, r.text, branch['DEV-JED-01'])).body;
      const ready = (await verify(s.c, v.collectionSessionId, 'verified')).body;
      expect((await collect(s.c, v.collectionSessionId, ready)).status).toBe(200);
      regs.push(r);
    }
    const hist = await s.c.get('/staff/history');
    expect(hist.status).toBe(200);
    expect(hist.body.items.length).toBe(3);
    for (const item of hist.body.items) expect(Object.keys(item).sort()).toEqual(HISTORY_KEYS);
    expect(hist.body.items[0]).toMatchObject({ sampleType: 'hair', sampleStatus: 'sample_collected', collectedByMe: true, patientAge: { years: 32 } });

    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());
    expect((await s.c.get(`/staff/history?from=${today}&to=${today}`)).body.items).toHaveLength(3);
    expect((await s.c.get('/staff/history?from=2001-01-01&to=2001-01-02')).body.items).toHaveLength(0);
    const one = await s.c.get(`/staff/history?trackingId=${encodeURIComponent(regs[1]!.registration.trackingId)}`);
    expect(one.body.items.map((i: { trackingId: string }) => i.trackingId)).toEqual([regs[1]!.registration.trackingId]);
    expect((await s.c.get('/staff/history?status=cancelled')).body.items).toHaveLength(0);
    expect((await s.c.get('/staff/history?trackingId=Canary0')).status).toBe(422); // search is by exact tracking ID only

    // Another branch's staff can't find these, even by tracking ID.
    const riyadh = await staffAt(['DEV-RUH-01']);
    expect((await riyadh.c.get(`/staff/history?trackingId=${encodeURIComponent(regs[0]!.registration.trackingId)}`)).body.items).toHaveLength(0);

    const dash = await s.c.get(`/staff/dashboard?branchId=${branch['DEV-JED-01']}`);
    expect(dash.body.today).toMatchObject({ collectedAtBranch: 3, collectedByMe: 3 });
    expect(dash.body.recent).toHaveLength(3);

    const everything = JSON.stringify([hist.body, dash.body, (await s.c.get('/staff/me')).body]);
    for (const pii of ['Canary', 'Secretname', 'Fatimah', regs[0]!.email, '551234567', regs[0]!.registration.patient.dateOfBirth, regs[0]!.registration.id]) {
      expect(everything, pii).not.toContain(pii);
    }
  });
});

describe('privacy sweep across all staff responses', () => {
  it('no name, guardian, email, phone or date of birth in scan, session, dev, collect, error or history responses', async () => {
    const r = await registrationWithQr({ patient: { firstName: 'Zaynab', lastName: 'Privatefamily', dateOfBirth: yearsAgo(9, 30), gender: 'female' }, contact: { fullName: 'Guardianname Person', phone: '0557778888' } });
    const s = await staffAt(['DEV-RUH-01']);
    const bodies: unknown[] = [];
    const v = await scan(s.c, r.text); bodies.push(v.body);
    bodies.push((await s.c.get(`/staff/collection-sessions/${v.body.collectionSessionId}`)).body);
    bodies.push((await collect(s.c, v.body.collectionSessionId, v.body)).body); // error: not verified
    const ready = await verify(s.c, v.body.collectionSessionId, 'verified'); bodies.push(ready.body);
    bodies.push((await collect(s.c, v.body.collectionSessionId, ready.body)).body);
    bodies.push((await scan(s.c, r.text)).body); // already collected
    bodies.push((await scan(s.c, r.text, branch['DEV-JED-01'])).body); // error: branch
    bodies.push((await s.c.get('/staff/history')).body);
    const all = JSON.stringify(bodies);
    for (const pii of ['Zaynab', 'Privatefamily', 'Guardianname', r.email, '557778888', r.registration.patient.dateOfBirth, r.userId, r.registration.id, r.token]) {
      expect(all, pii).not.toContain(pii);
    }
    const audit = await t.db.query(`SELECT string_agg(metadata::text, ' ') AS m FROM audit_logs WHERE target_id = $1`, [r.registration.id]);
    expect(audit.rows[0]!.m).not.toMatch(/Zaynab|Privatefamily|c1_/);
  });
});

describe('scheduled outbox endpoint (Cloud Run scale-to-zero)', () => {
  it('requires the shared secret and delivers due email', async () => {
    expect((await t.client().post('/internal/outbox/run')).status).toBe(401);
    expect((await t.client().post('/internal/outbox/run', {}, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    const ok = await t.client().request('POST', '/internal/outbox/run', undefined, { headers: { authorization: `Bearer ${t.config.internalCronSecret}` } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ sent: expect.any(Number), failed: expect.any(Number) });
    const off = createApp({ ...t.deps, config: { ...t.config, internalCronSecret: undefined } });
    expect((await off.request('/api/v1/internal/outbox/run', { method: 'POST' })).status).toBe(404);
    void register;
  });
});
