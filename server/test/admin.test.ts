import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { csvCell, maskEmail, scrubEmails } from '../src/modules/admin/common.ts';
import { assertNotLastSuperAdmin } from '../src/modules/admin/staff.routes.ts';
import type { RoleKey } from '../src/modules/rbac/catalogue.ts';
import { extractCustomerToken } from '../src/modules/qr/qr.service.ts';
import { assignBranch, customerWithRegistration, decodeQrPng, getBinary, yearsAgo } from './helpers/registration.ts';
import { GOOD_PASSWORD, ORIGIN, setupTestApp, type TestClient, type TestEnv } from './helpers/test-app.ts';

let t: TestEnv;
let branch: Record<string, string>;
let admin: Awaited<ReturnType<TestEnv['mfaStaff']>>;
let superAdmin: Awaited<ReturnType<TestEnv['mfaStaff']>>;
let auditor: Awaited<ReturnType<TestEnv['mfaStaff']>>;

beforeAll(async () => {
  t = await setupTestApp();
  const { rows } = await t.db.query<{ code: string; id: string }>('SELECT code, id FROM collection_branches');
  branch = Object.fromEntries(rows.map((r) => [r.code, r.id]));
  admin = await t.mfaStaff(['admin']);
  superAdmin = await t.mfaStaff(['super_admin']);
  auditor = await t.mfaStaff(['auditor']);
});
afterAll(async () => t.close());

async function staffAt(codes: string[]) {
  const s = await t.staff(['collection_staff']);
  for (const code of codes) await assignBranch(t, s.userId, branch[code]!);
  return s;
}
async function registrationWithQr(overrides: Record<string, unknown> = {}) {
  // Pin the branch: branches created by these tests may sort before the seeded ones.
  const cust = await customerWithRegistration(t, { branchId: branch['DEV-RUH-01'], ...overrides });
  const png = await getBinary(t, cust.c, `/me/registrations/${cust.registration.id}/qr.png`);
  const text = decodeQrPng(png.body)!;
  return { ...cust, text, token: extractCustomerToken(text)! };
}
const scan = (c: TestClient, code: string, branchId = branch['DEV-RUH-01']) => c.post('/staff/qr/validate', { code, branchId });
async function collectSample(staff: TestClient, text: string, branchId = branch['DEV-RUH-01']) {
  const v = (await scan(staff, text, branchId)).body;
  const ready = (await staff.post(`/staff/collection-sessions/${v.collectionSessionId}/identity/dev`, { outcome: 'verified' })).body;
  return staff.post(`/staff/collection-sessions/${v.collectionSessionId}/collect`, {
    instructionsId: ready.collectionInstructions.id, checklist: ready.collectionInstructions.checklist.map((i: { id: string }) => i.id),
  });
}
/** Letters-only random tag (names may not contain digits). */
const letters = () => [...randomBytes(4)].map((b) => String.fromCharCode(97 + (b % 26))).join('');
const lastAudit = async (action: string) => (await t.db.query('SELECT * FROM audit_logs WHERE action = $1 ORDER BY chain_seq DESC LIMIT 1', [action])).rows[0];

// Every admin endpoint, for the access-control matrix (ids don't need to exist: authorisation
// runs before lookup).
const X = '00000000-0000-4000-8000-000000000000';
const ENDPOINTS: [string, string, unknown?][] = [
  ['GET', '/admin/stats'],
  ['GET', '/admin/registrations'],
  ['GET', `/admin/registrations/${X}`],
  ['POST', `/admin/registrations/${X}/transfer`, { branchId: X, reason: 'testing access' }],
  ['POST', `/admin/registrations/${X}/cancel`, { reason: 'testing access' }],
  ['PATCH', `/admin/registrations/${X}/patient`, { patient: { firstName: 'A', lastName: 'B', dateOfBirth: '2015-01-01', gender: 'male' }, reason: 'testing access' }],
  ['POST', `/admin/registrations/${X}/qr/revoke`, { reason: 'testing access' }],
  ['POST', `/admin/registrations/${X}/qr/resend-email`, { reason: 'testing access' }],
  ['GET', `/admin/customers/${X}`],
  ['POST', `/admin/customers/${X}/lock`, { reason: 'testing access' }],
  ['POST', `/admin/customers/${X}/unlock`, { reason: 'testing access' }],
  ['POST', `/admin/customers/${X}/resend-verification`, {}],
  ['GET', '/admin/staff'],
  ['GET', `/admin/staff/${X}`],
  ['POST', '/admin/staff', { email: 'x@example.com', fullName: 'X', roles: ['collection_staff'] }],
  ['POST', `/admin/staff/${X}/resend-invite`, {}],
  ['PUT', `/admin/staff/${X}/roles`, { roles: ['collection_staff'], reason: 'testing access' }],
  ['PUT', `/admin/staff/${X}/branches`, { branchIds: [], reason: 'testing access' }],
  ['POST', `/admin/staff/${X}/status`, { status: 'suspended', reason: 'testing access' }],
  ['GET', '/admin/branches'],
  ['POST', '/admin/branches', { code: 'ZZ-01', nameEn: 'a', nameAr: 'b', cityEn: 'c', cityAr: 'd' }],
  ['PATCH', `/admin/branches/${X}`, { nameEn: 'x' }],
  ['POST', `/admin/branches/${X}/status`, { active: false, reason: 'testing access' }],
  ['GET', '/admin/instructions'],
  ['POST', '/admin/instructions/drafts', {}],
  ['POST', `/admin/instructions/drafts/${X}/publish`, { confirm: true }],
  ['GET', '/admin/emails'],
  ['POST', `/admin/emails/${X}/retry`, {}],
  ['GET', '/admin/audit-logs'],
  ['GET', '/admin/reports/operational.csv'],
];
const call = (c: TestClient, [method, path, body]: [string, string, unknown?]) => c.request(method, path, method === 'GET' ? undefined : body ?? {});

describe('admin access control', () => {
  it('collection staff, lab operators and customers are refused on every admin endpoint; signed-out users get 401', async () => {
    const staff = await staffAt(['DEV-RUH-01']);
    const lab = await t.mfaStaff(['lab_operator']);
    const cust = await t.customer();
    const anon = t.client();
    for (const ep of ENDPOINTS) {
      expect((await call(staff.c, ep)).status, `staff ${ep[0]} ${ep[1]}`).toBe(403);
      expect((await call(lab.c, ep)).status, `lab ${ep[0]} ${ep[1]}`).toBe(403);
      expect((await call(cust.c, ep)).status, `customer ${ep[0]} ${ep[1]}`).toBe(403);
      expect((await call(anon, ep)).status, `anon ${ep[0]} ${ep[1]}`).toBe(401);
    }
    const denied = await t.db.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'authz.denied' AND actor_user_id = $1`, [staff.userId]);
    expect(denied.rows[0].n).toBe(ENDPOINTS.length);
  });

  it('privileged accounts must set up and pass MFA before any admin endpoint works', async () => {
    const noMfa = await t.staff(['admin']);
    const res = await noMfa.c.get('/admin/stats');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MFA_SETUP_REQUIRED');
    const fresh = t.client();
    await fresh.post('/auth/sign-in', { email: admin.email, password: GOOD_PASSWORD });
    expect((await fresh.get('/admin/stats')).body.error.code).toBe('MFA_REQUIRED');
  });

  it('auditors get statistics, the audit log and non-personal exports only', async () => {
    const ok = ['/admin/stats', '/admin/audit-logs', '/admin/reports/operational.csv'];
    for (const ep of ENDPOINTS) {
      const res = await call(auditor.c, ep);
      if (ep[0] === 'GET' && ok.includes(ep[1])) expect(res.status, ep[1]).toBe(200);
      else expect(res.status, `${ep[0]} ${ep[1]}`).toBe(403);
    }
  });

  it('/auth/me exposes the permissions the portal uses for navigation', async () => {
    const me = (await admin.c.get('/auth/me')).body.user;
    expect(me.permissions).toEqual(expect.arrayContaining(['stats.read', 'registration.read_full', 'staff.manage', 'instructions.draft']));
    expect(me.permissions).not.toContain('form.approve');
    expect((await superAdmin.c.get('/auth/me')).body.user.permissions).toEqual(expect.arrayContaining(['form.approve', 'admin.manage']));
  });
});

describe('dashboard statistics', () => {
  it('counts come from the database and change with real events', async () => {
    const before = (await admin.c.get('/admin/stats')).body;
    const { text } = await registrationWithQr();
    await registrationWithQr();
    const staff = await staffAt(['DEV-RUH-01']);
    expect((await collectSample(staff.c, text)).status).toBe(200);
    const after = (await admin.c.get('/admin/stats')).body;
    expect(after.totals.registrations - before.totals.registrations).toBe(2);
    expect(after.totals.samplesCollected - before.totals.samplesCollected).toBe(1);
    expect(after.totals.awaitingCollection - before.totals.awaitingCollection).toBe(1);
    expect(after.todayCounts.registrations - before.todayCounts.registrations).toBe(2);
    expect(after.todayCounts.collections - before.todayCounts.collections).toBe(1);
    expect(after.totals.customers - before.totals.customers).toBe(2);
    const ruh = after.byBranch.find((b: { code: string }) => b.code === 'DEV-RUH-01');
    expect(ruh.collected).toBeGreaterThanOrEqual(1);
    expect(after.recentActivity.length).toBeGreaterThan(0);
    // No personal data anywhere in the statistics.
    expect(JSON.stringify(after)).not.toMatch(/@example\.com|Layla|Al-Harbi/);
  });

  it('date filters are validated and auditors get no activity feed without audit.read data leaks', async () => {
    expect((await admin.c.get('/admin/stats?from=2026-12-01&to=2026-11-01')).status).toBe(422);
    const a = (await auditor.c.get('/admin/stats')).body;
    for (const item of a.recentActivity) expect(Object.keys(item).sort()).toEqual(['action', 'actorRole', 'occurredAt', 'outcome', 'targetType']);
  });
});

describe('registration search and detail', () => {
  it('finds registrations by tracking ID, patient name, customer name, email and mobile; audits a hash, never the term', async () => {
    const tag = letters();
    const { registration, email } = await registrationWithQr({ patient: { firstName: `Zaynab${tag}`, lastName: 'Search', dateOfBirth: yearsAgo(6), gender: 'female' }, contact: { fullName: `Huda ${tag}`, phone: '0559876543' } });
    const ids = async (q: string) => (await admin.c.get(`/admin/registrations?q=${encodeURIComponent(q)}`)).body.items.map((i: { id: string }) => i.id);
    expect(await ids(registration.trackingId)).toEqual([registration.id]);
    expect(await ids(`zaynab${tag}`)).toEqual([registration.id]);
    expect(await ids(`Huda ${tag}`)).toEqual([registration.id]);
    expect(await ids(email)).toEqual([registration.id]);
    expect(await ids('0559876543')).toContain(registration.id);
    expect(await ids('+966559876543')).toContain(registration.id);
    const logs = await t.db.query(`SELECT metadata::text AS m FROM audit_logs WHERE action = 'registration.searched' AND actor_user_id = $1`, [admin.userId]);
    expect(logs.rows.length).toBeGreaterThanOrEqual(6);
    for (const row of logs.rows) {
      expect(row.m).not.toContain(tag);
      expect(row.m).not.toContain(email);
      expect(row.m).not.toContain('559876543');
    }
    expect(JSON.parse(logs.rows.at(-1).m).termHash).toMatch(/^[0-9a-f]{24}$/);
  });

  it('filters and paginates with a stable cursor', async () => {
    for (let i = 0; i < 3; i++) await registrationWithQr();
    const p1 = (await admin.c.get('/admin/registrations?limit=2')).body;
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = (await admin.c.get(`/admin/registrations?limit=2&cursor=${p1.nextCursor}`)).body;
    expect(p2.items).toHaveLength(2);
    const overlap = p2.items.filter((x: { id: string }) => p1.items.some((y: { id: string }) => y.id === x.id));
    expect(overlap).toHaveLength(0);
    expect((await admin.c.get('/admin/registrations?q=a')).status).toBe(422);
    expect((await admin.c.get('/admin/registrations?cursor=bogus')).status).toBe(422);
  });

  it('the detail view has the full record, is audited, and never contains a QR token', async () => {
    const { registration, token, email } = await registrationWithQr();
    const res = await admin.c.get(`/admin/registrations/${registration.id}`);
    expect(res.status).toBe(200);
    const d = res.body.registration;
    expect(d.patient).toMatchObject({ firstName: 'Layla', lastName: 'Al-Harbi', gender: 'female', relationship: 'child' });
    expect(d.patient.dateOfBirth).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(d.guardian).toMatchObject({ relationship: 'child', name: 'Fatimah Al-Harbi' });
    expect(d.accountHolder.email).toBe(email);
    expect(d.contact.phone).toBe('+966551234567');
    expect(d.consents.length).toBe(4);
    expect(d.qr.status).toBe('active');
    expect(JSON.stringify(res.body)).not.toContain(token);
    const a = await lastAudit('registration.viewed_full');
    expect(a.target_id).toBe(registration.id);
    expect(a.fields_accessed).toContain('patient.date_of_birth');
  });
});

describe('branch transfer', () => {
  it('requires a reason and an active, different branch', async () => {
    const { registration } = await registrationWithQr();
    const url = `/admin/registrations/${registration.id}/transfer`;
    expect((await admin.c.post(url, { branchId: branch['DEV-JED-01'] })).status).toBe(422);
    expect((await admin.c.post(url, { branchId: branch['DEV-JED-01'], reason: 'x' })).status).toBe(422);
    expect((await admin.c.post(url, { branchId: branch['DEV-RUH-01'], reason: 'same branch test' })).body.error.code).toBe('SAME_BRANCH');
    await t.db.query(`INSERT INTO collection_branches (code, name_en, name_ar, city_en, city_ar, active) VALUES ('DEV-OFF-01', 'Off', 'مغلق', 'X', 'س', false)`);
    const off = (await t.db.query(`SELECT id FROM collection_branches WHERE code = 'DEV-OFF-01'`)).rows[0].id;
    expect((await admin.c.post(url, { branchId: off, reason: 'inactive branch test' })).body.error.code).toBe('BRANCH_INACTIVE');
  });

  it('moves the registration, keeps the tracking ID, records who/when/why, closes staff sessions and notifies the customer', async () => {
    const { registration, text, email, c: custC } = await registrationWithQr();
    const staff = await staffAt(['DEV-RUH-01', 'DEV-JED-01']);
    const open = (await scan(staff.c, text)).body;
    await staff.c.post(`/staff/collection-sessions/${open.collectionSessionId}/identity/dev`, { outcome: 'verified' });
    const res = await admin.c.post(`/admin/registrations/${registration.id}/transfer`, { branchId: branch['DEV-JED-01'], reason: 'Customer moved to Jeddah' });
    expect(res.status).toBe(200);
    expect(res.body.trackingId).toBe(registration.trackingId);
    expect(res.body.sessionsClosed).toBe(1);
    expect(res.body.registration.branch.code).toBe('DEV-JED-01');
    expect(res.body.registration.branchTransfers[0]).toMatchObject({ from: { code: 'DEV-RUH-01' }, to: { code: 'DEV-JED-01' }, reason: 'Customer moved to Jeddah', actorEmail: admin.email });
    const a = await lastAudit('registration.branch_transferred');
    expect(a.actor_user_id).toBe(admin.userId);
    expect(a.metadata).toMatchObject({ fromBranchId: branch['DEV-RUH-01'], toBranchId: branch['DEV-JED-01'] });
    // The old session can't be used to collect at the old branch.
    const ready = (await staff.c.get(`/staff/collection-sessions/${open.collectionSessionId}`));
    expect(ready.status).toBeGreaterThanOrEqual(400);
    const mail = await t.waitForMail(email, 'registration_branch_changed');
    expect(mail.data.trackingId).toBe(registration.trackingId);
    expect(JSON.stringify(mail.data)).not.toContain('Layla');
    expect((await custC.get(`/me/registrations/${registration.id}`)).body.registration.branch.id).toBe(branch['DEV-JED-01']);
    // Collection now works only at the new branch.
    expect((await scan(staff.c, text, branch['DEV-RUH-01'])).status).toBe(403);
    expect((await collectSample(staff.c, text, branch['DEV-JED-01'])).status).toBe(200);
    expect((await admin.c.post(`/admin/registrations/${registration.id}/transfer`, { branchId: branch['DEV-RUH-01'], reason: 'after collection' })).body.error.code).toBe('REGISTRATION_NOT_OPEN');
  });
});

describe('cancellation and patient correction', () => {
  it('cancels before collection with a reason, revokes the QR and keeps the tracking ID unused', async () => {
    const { registration, text } = await registrationWithQr();
    expect((await admin.c.post(`/admin/registrations/${registration.id}/cancel`, {})).status).toBe(422);
    const res = await admin.c.post(`/admin/registrations/${registration.id}/cancel`, { reason: 'Customer asked to cancel' });
    expect(res.status).toBe(200);
    expect(res.body.registration.status).toBe('cancelled');
    expect(res.body.registration.qr.status).toBe('revoked');
    expect(res.body.registration.statusHistory.at(-1)).toMatchObject({ to: 'cancelled', reason: 'Customer asked to cancel' });
    const staff = await staffAt(['DEV-RUH-01']);
    expect((await scan(staff.c, text)).body.qrValid).toBe(false);
    expect((await admin.c.post(`/admin/registrations/${registration.id}/cancel`, { reason: 'again please' })).body.error.code).toBe('REGISTRATION_NOT_OPEN');
  });

  it('corrects patient details with a reason, keeps previous values encrypted, and invalidates identity verification', async () => {
    const { registration, text } = await registrationWithQr();
    const staff = await staffAt(['DEV-RUH-01']);
    const v = (await scan(staff.c, text)).body;
    const ready = (await staff.c.post(`/staff/collection-sessions/${v.collectionSessionId}/identity/dev`, { outcome: 'verified' })).body;
    const url = `/admin/registrations/${registration.id}/patient`;
    const patient = { firstName: 'Leila', lastName: 'Al-Harbi', dateOfBirth: yearsAgo(7, 40), gender: 'female' };
    expect((await admin.c.patch(url, { patient })).status).toBe(422);
    const res = await admin.c.patch(url, { patient, reason: 'Spelling corrected from ID card' });
    expect(res.status).toBe(200);
    expect(res.body.changed).toEqual(['first_name']);
    const corr = res.body.registration.patientCorrections.at(-1);
    expect(corr).toMatchObject({ changedFields: ['first_name'], previous: { firstName: 'Layla' }, actorEmail: admin.email });
    const raw = await t.db.query('SELECT previous_enc FROM patient_revisions WHERE patient_id = $1', [res.body.registration.patient.id]);
    expect(raw.rows.at(-1).previous_enc).not.toContain('Layla');
    // The staff member's earlier verification no longer counts.
    const coll = await staff.c.post(`/staff/collection-sessions/${v.collectionSessionId}/collect`, { instructionsId: ready.collectionInstructions.id, checklist: ready.collectionInstructions.checklist.map((i: { id: string }) => i.id) });
    expect(coll.status).toBeGreaterThanOrEqual(400);
    expect((await admin.c.patch(url, { patient, reason: 'No change at all' })).body.error.code).toBe('NO_CHANGES');
    // After collection: locked.
    expect((await collectSample(staff.c, text)).status).toBe(200);
    expect((await admin.c.patch(url, { patient: { ...patient, firstName: 'Lina' }, reason: 'too late to change' })).body.error.code).toBe('PATIENT_LOCKED');
  });
});

describe('customer accounts', () => {
  it('locks (ending sessions) and unlocks a customer, with reasons and audit', async () => {
    const cust = await t.customer();
    expect((await admin.c.post(`/admin/customers/${cust.userId}/lock`, {})).status).toBe(422);
    const lock = await admin.c.post(`/admin/customers/${cust.userId}/lock`, { reason: 'Suspected account sharing' });
    expect(lock.status).toBe(200);
    expect(lock.body.customer.status).toBe('suspended');
    expect((await cust.c.get('/me/registrations')).status).toBe(401);
    expect((await t.client().post('/auth/sign-in', { email: cust.email, password: GOOD_PASSWORD })).status).toBe(401);
    const unlock = await admin.c.post(`/admin/customers/${cust.userId}/unlock`, { reason: 'Verified by phone call' });
    expect(unlock.body.customer.status).toBe('active');
    expect((await t.client().post('/auth/sign-in', { email: cust.email, password: GOOD_PASSWORD })).status).toBe(200);
    expect((await lastAudit('customer.locked')).metadata.reason).toBe('Suspected account sharing');
    expect((await admin.c.post(`/admin/customers/${cust.userId}/unlock`, { reason: 'Not locked now' })).body.error.code).toBe('ACCOUNT_NOT_LOCKED');
  });

  it('clears a temporary sign-in lockout, refuses staff accounts, and resends verification only to unverified customers', async () => {
    const cust = await t.customer();
    await t.db.query(`UPDATE users SET locked_until = now() + interval '10 minutes' WHERE id = $1`, [cust.userId]);
    expect((await admin.c.post(`/admin/customers/${cust.userId}/unlock`, { reason: 'Customer forgot password' })).status).toBe(200);
    const staff = await staffAt(['DEV-RUH-01']);
    expect((await admin.c.post(`/admin/customers/${staff.userId}/lock`, { reason: 'not a customer' })).status).toBe(404);
    expect((await admin.c.get(`/admin/customers/${staff.userId}`)).status).toBe(404);
    expect((await admin.c.post(`/admin/customers/${cust.userId}/resend-verification`, {})).body.error.code).toBe('EMAIL_ALREADY_VERIFIED');
    const email = `unverified_${randomBytes(3).toString('hex')}@example.com`;
    await t.client().post('/auth/sign-up', { email, password: GOOD_PASSWORD, confirmAdult: true });
    await t.settleMail();
    const uid = (await t.db.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id;
    expect((await admin.c.post(`/admin/customers/${uid}/resend-verification`, {})).status).toBe(202);
    const token = await t.tokenFromMail(email, 'verify_email');
    expect((await t.client().post('/auth/verify-email', { token })).status).toBe(200);
  });

  it('the customer view lists their registrations and is audited', async () => {
    const { userId, registration } = await registrationWithQr();
    const res = await admin.c.get(`/admin/customers/${userId}`);
    expect(res.body.customer.registrations.map((r: { id: string }) => r.id)).toEqual([registration.id]);
    expect((await lastAudit('customer.viewed_full')).target_id).toBe(userId);
  });
});

describe('administrative QR management', () => {
  it('revokes with a reason, replaces immediately, keeps the tracking ID, and the old token dies', async () => {
    const { registration, text, email } = await registrationWithQr();
    const res = await admin.c.post(`/admin/registrations/${registration.id}/qr/revoke`, { reason: 'Customer reported phone stolen' });
    expect(res.body).toMatchObject({ status: 'replaced', trackingId: registration.trackingId });
    const staff = await staffAt(['DEV-RUH-01']);
    expect((await scan(staff.c, text)).body.qrValid).toBe(false);
    const d = (await admin.c.get(`/admin/registrations/${registration.id}`)).body.registration;
    expect(d.qr.history.map((q: { status: string }) => q.status)).toEqual(['revoked', 'active']);
    expect(d.qr.history[0].revokeReason).toContain('Customer reported phone stolen');
    await t.waitForMail(email, 'registration_qr_resend');
    expect((await admin.c.post(`/admin/registrations/${registration.id}/qr/resend-email`, { reason: 'Customer asked again' })).status).toBe(202);
  });

  it('a used QR can’t be replaced or resent', async () => {
    const { registration, text } = await registrationWithQr();
    const staff = await staffAt(['DEV-RUH-01']);
    expect((await collectSample(staff.c, text)).status).toBe(200);
    expect((await admin.c.post(`/admin/registrations/${registration.id}/qr/revoke`, { reason: 'try after use' })).body.error.code).toBe('QR_LOCKED');
    expect((await admin.c.post(`/admin/registrations/${registration.id}/qr/resend-email`, { reason: 'try after use' })).body.error.code).toBe('QR_NOT_AVAILABLE');
  });
});

describe('staff management', () => {
  it('admins invite collection staff with branches; the invitation email sets up a working account', async () => {
    const email = `invitee_${randomBytes(3).toString('hex')}@example.com`;
    const res = await admin.c.post('/admin/staff', { email, fullName: 'Reem Collector', roles: ['collection_staff'], branchIds: [branch['DEV-RUH-01'], branch['DEV-JED-01']] });
    expect(res.status).toBe(201);
    expect(res.body.staff).toMatchObject({ email, fullName: 'Reem Collector', roles: ['collection_staff'], invitationPending: true });
    expect(res.body.staff.branches).toHaveLength(2);
    const token = await t.tokenFromMail(email, 'account_setup');
    const c = t.client();
    expect((await c.post('/auth/account-setup', { token, password: GOOD_PASSWORD })).status).toBe(200);
    await c.post('/auth/sign-in', { email, password: GOOD_PASSWORD });
    expect((await c.get('/staff/me')).body.branches).toHaveLength(2);
    expect((await admin.c.post('/admin/staff', { email, fullName: 'Dup', roles: ['collection_staff'] })).body.error.code).toBe('EMAIL_IN_USE');
  });

  it('prevents privilege escalation: admins can’t grant admin roles or manage admins; nobody changes their own account', async () => {
    const email = `esc_${randomBytes(3).toString('hex')}@example.com`;
    for (const role of ['admin', 'super_admin', 'auditor']) {
      expect((await admin.c.post('/admin/staff', { email, fullName: 'X', roles: [role] })).body.error.code, role).toBe('ROLE_NOT_GRANTABLE');
    }
    const staff = await staffAt(['DEV-RUH-01']);
    expect((await admin.c.put(`/admin/staff/${staff.userId}/roles`, { roles: ['admin'], reason: 'promote please' })).body.error.code).toBe('ROLE_NOT_GRANTABLE');
    const otherAdmin = await t.mfaStaff(['admin']);
    expect((await admin.c.post(`/admin/staff/${otherAdmin.userId}/status`, { status: 'suspended', reason: 'admin on admin' })).body.error.code).toBe('ROLE_NOT_GRANTABLE');
    expect((await admin.c.put(`/admin/staff/${admin.userId}/roles`, { roles: ['collection_staff'], reason: 'self change' })).body.error.code).toBe('SELF_CHANGE_FORBIDDEN');
    expect((await superAdmin.c.post(`/admin/staff/${superAdmin.userId}/status`, { status: 'suspended', reason: 'self change' })).body.error.code).toBe('SELF_CHANGE_FORBIDDEN');
    // Customers can't be turned into staff.
    const cust = await t.customer();
    expect((await admin.c.put(`/admin/staff/${cust.userId}/roles`, { roles: ['collection_staff'], reason: 'make staff' })).status).toBe(404);
    // Super admins can grant admin roles.
    const ok = await superAdmin.c.post('/admin/staff', { email, fullName: 'New Admin', roles: ['admin'] });
    expect(ok.status).toBe(201);
    expect((await t.waitForMail(email, 'account_setup')).data.link).toContain('/traced/admin/accept-invite/');
  });

  it('role changes, branch changes, suspension and deactivation are audited and end sessions where needed', async () => {
    const staff = await staffAt(['DEV-RUH-01']);
    const branches = await admin.c.put(`/admin/staff/${staff.userId}/branches`, { branchIds: [branch['DEV-JED-01']], reason: 'Moved to Jeddah' });
    expect(branches.body.staff.branches.map((b: { code: string }) => b.code)).toEqual(['DEV-JED-01']);
    expect((await lastAudit('staff.branches_changed')).metadata).toMatchObject({ added: [branch['DEV-JED-01']], removed: [branch['DEV-RUH-01']] });
    const sus = await admin.c.post(`/admin/staff/${staff.userId}/status`, { status: 'suspended', reason: 'Investigation pending' });
    expect(sus.body.staff.status).toBe('suspended');
    expect((await staff.c.get('/staff/me')).status).toBe(401);
    expect((await admin.c.post(`/admin/staff/${staff.userId}/status`, { status: 'active', reason: 'Investigation closed' })).body.staff.status).toBe('active');
    const signIn = t.client();
    expect((await signIn.post('/auth/sign-in', { email: staff.email, password: GOOD_PASSWORD })).status).toBe(200);
    const roles = await admin.c.put(`/admin/staff/${staff.userId}/roles`, { roles: ['lab_operator'], reason: 'Now works in the lab' });
    expect(roles.body.staff.roles).toEqual(['lab_operator']);
    expect(roles.body.staff.branches).toEqual([]);
    expect((await signIn.get('/auth/me')).status).toBe(401);
    expect((await lastAudit('staff.roles_changed')).metadata).toMatchObject({ before: ['collection_staff'], after: ['lab_operator'] });
    expect((await admin.c.post(`/admin/staff/${staff.userId}/status`, { status: 'deactivated', reason: 'Left the company' })).body.staff.status).toBe('deactivated');
    expect((await admin.c.post(`/admin/staff/${staff.userId}/status`, { status: 'active', reason: 'Came back' })).body.error.code).toBe('ACCOUNT_DEACTIVATED');
  });

  it('resends a pending invitation (old link stops working) and shows security status and activity', async () => {
    const email = `pending_${randomBytes(3).toString('hex')}@example.com`;
    const { body } = await admin.c.post('/admin/staff', { email, fullName: 'Pending Person', roles: ['collection_staff'] });
    const first = await t.tokenFromMail(email, 'account_setup');
    expect((await admin.c.post(`/admin/staff/${body.staff.id}/resend-invite`, {})).status).toBe(202);
    const second = await t.tokenFromMail(email, 'account_setup');
    expect(second).not.toBe(first);
    expect((await t.client().post('/auth/account-setup', { token: first, password: GOOD_PASSWORD })).status).toBe(400);
    expect((await t.client().post('/auth/account-setup', { token: second, password: GOOD_PASSWORD })).status).toBe(200);
    expect((await admin.c.post(`/admin/staff/${body.staff.id}/resend-invite`, {})).body.error.code).toBe('INVITE_NOT_PENDING');
    const detail = (await admin.c.get(`/admin/staff/${admin.userId}`)).body;
    expect(detail.staff.security.mfaEnabled).toBe(true);
    expect(detail.activity.length).toBeGreaterThan(0);
    expect(detail.canManage).toBe(false);
  });

  it('the last active super administrator can’t be removed, even by two super admins at once', async () => {
    const sa2 = await t.mfaStaff(['super_admin']);
    const [a, b] = await Promise.all([
      superAdmin.c.put(`/admin/staff/${sa2.userId}/roles`, { roles: ['admin'], reason: 'race test one' }),
      sa2.c.put(`/admin/staff/${superAdmin.userId}/roles`, { roles: ['admin'], reason: 'race test two' }),
    ]);
    const codes = [a, b].map((r) => (r.status === 200 ? 'ok' : r.body.error.code)).sort();
    // Whichever commits first wins; the other is refused (its actor has just lost the authority,
    // or would remove the last super admin): never zero super admins.
    expect(codes[1]).toBe('ok');
    expect(['LAST_SUPER_ADMIN', 'ROLE_NOT_GRANTABLE']).toContain(codes[0]);
    const left = await t.db.query(`SELECT count(*)::int AS n FROM user_roles ur JOIN users u ON u.id = ur.user_id WHERE ur.role_key = 'super_admin' AND u.status = 'active'`);
    expect(left.rows[0].n).toBe(1);
    // Restore for later tests: whoever lost the role gets it back from the remaining super admin.
    const winner = a.status === 200 ? superAdmin : sa2;
    const loser = a.status === 200 ? sa2 : superAdmin;
    if (winner !== superAdmin) {
      const back = await winner.c.put(`/admin/staff/${superAdmin.userId}/roles`, { roles: ['super_admin'], reason: 'restore after test' });
      expect(back.status).toBe(200);
      const c = t.client();
      await c.post('/auth/sign-in', { email: superAdmin.email, password: GOOD_PASSWORD });
      superAdmin.c = c;
      const { totpCode } = await import('./helpers/test-app.ts');
      expect((await c.post('/auth/mfa/verify', { code: totpCode(superAdmin.secret, 1) })).status).toBe(200);
    }
    void loser;
  });
});

describe('last super administrator rule', () => {
  it('refuses removing or suspending the only active, set-up super admin', () => {
    const target = { id: 'a', roles: ['super_admin'] as RoleKey[] };
    expect(() => assertNotLastSuperAdmin(target, ['a'], true)).toThrow(/last active super administrator/);
    expect(() => assertNotLastSuperAdmin(target, ['a', 'b'], true)).not.toThrow();
    expect(() => assertNotLastSuperAdmin(target, ['a'], false)).not.toThrow();
    expect(() => assertNotLastSuperAdmin({ id: 'c', roles: ['admin'] }, [], true)).not.toThrow();
  });
});

describe('branch management', () => {
  it('creates and edits branches (code is permanent), refuses duplicates', async () => {
    const res = await admin.c.post('/admin/branches', { code: 'dev-tst-01', nameEn: 'Dammam test branch', nameAr: 'فرع الدمام التجريبي', cityEn: 'Dammam', cityAr: 'الدمام' });
    expect(res.status).toBe(201);
    expect(res.body.branch).toMatchObject({ code: 'DEV-TST-01', active: true });
    expect((await admin.c.post('/admin/branches', { code: 'DEV-TST-01', nameEn: 'x', nameAr: 'x', cityEn: 'x', cityAr: 'x' })).body.error.code).toBe('BRANCH_CODE_IN_USE');
    const edit = await admin.c.patch(`/admin/branches/${res.body.branch.id}`, { nameEn: 'Dammam branch' });
    expect(edit.body.branch.nameEn).toBe('Dammam branch');
    expect((await admin.c.patch(`/admin/branches/${res.body.branch.id}`, { code: 'NEW' })).status).toBe(422);
    expect((await lastAudit('branch.updated')).metadata.changed).toEqual(['nameEn']);
  });

  it('deactivation protects pending registrations, hides the branch from new registrations and blocks collection', async () => {
    const created = (await admin.c.post('/admin/branches', { code: 'DEV-TMP-01', nameEn: 'Temp', nameAr: 'مؤقت', cityEn: 'Riyadh', cityAr: 'الرياض' })).body.branch;
    const { registration, text } = await registrationWithQr({ branchId: created.id });
    const staff = await staffAt(['DEV-RUH-01']);
    await assignBranch(t, staff.userId, created.id);
    const url = `/admin/branches/${created.id}/status`;
    const refused = await admin.c.post(url, { active: false, reason: 'Branch closing' });
    expect(refused.body.error.code).toBe('BRANCH_HAS_PENDING');
    expect(refused.body.error.details.pending).toBe(1);
    expect((await admin.c.post(url, { active: false, reason: 'Branch closing', acknowledgePending: true })).status).toBe(200);
    const form = (await (await t.customer()).c.get('/me/registration-form?locale=en')).body;
    expect(form.branches.map((b: { id: string }) => b.id)).not.toContain(created.id);
    expect((await scan(staff.c, text, created.id)).status).toBe(403);
    // Transfer the pending registration away, then collect at the new branch.
    expect((await admin.c.post(`/admin/registrations/${registration.id}/transfer`, { branchId: branch['DEV-RUH-01'], reason: 'Branch closed' })).status).toBe(200);
    expect((await collectSample(staff.c, text)).status).toBe(200);
    expect((await admin.c.post(url, { active: true, reason: 'Reopened' })).body.branch.active).toBe(true);
    // Branches are never deleted.
    expect((await admin.c.request('DELETE', `/admin/branches/${created.id}`)).status).toBe(404);
  });
});

describe('collection instruction versions', () => {
  const body = (version: string) => ({
    version, titleEn: '[PROVISIONAL] Test instructions', titleAr: '[مؤقت] تعليمات تجريبية',
    stepsEn: ['Check the QR code.', 'Verify identity.'], stepsAr: ['تحقق من رمز QR.', 'تحقق من الهوية.'],
    checklist: [{ id: 'qr_checked', labelEn: 'QR checked', labelAr: 'تم التحقق من الرمز' }, { id: 'id_checked', labelEn: 'ID checked', labelAr: 'تم التحقق من الهوية' }],
  });

  it('admins draft and submit; only the super admin publishes; publishing is provisional unless an approval reference is recorded', async () => {
    const d = (await admin.c.post('/admin/instructions/drafts', body('0.2-test'))).body.draft;
    expect(d.status).toBe('draft');
    expect((await admin.c.post('/admin/instructions/drafts', body('0.2-test'))).body.error.code).toBe('VERSION_IN_USE');
    expect((await admin.c.post('/admin/instructions/drafts', body('0.1-provisional'))).body.error.code).toBe('VERSION_IN_USE');
    const edited = await admin.c.put(`/admin/instructions/drafts/${d.id}`, { ...body('0.2-test'), stepsEn: ['Check the QR code.', 'Verify identity.', 'Seal the sample.'] });
    expect(edited.body.draft.stepsEn).toHaveLength(3);
    expect((await admin.c.post(`/admin/instructions/drafts/${d.id}/submit`, {})).body.draft.status).toBe('submitted');
    expect((await admin.c.put(`/admin/instructions/drafts/${d.id}`, body('0.2-test'))).body.error.code).toBe('DRAFT_NOT_EDITABLE');
    expect((await admin.c.post(`/admin/instructions/drafts/${d.id}/publish`, { confirm: true })).status).toBe(403);
    expect((await admin.c.post(`/admin/instructions/drafts/${d.id}/return`, { reason: 'try return' })).status).toBe(403);
    expect((await superAdmin.c.post(`/admin/instructions/drafts/${d.id}/return`, { reason: 'Add Arabic review note' })).body.draft.status).toBe('draft');
    await admin.c.post(`/admin/instructions/drafts/${d.id}/submit`, {});
    expect((await superAdmin.c.post(`/admin/instructions/drafts/${d.id}/publish`, {})).status).toBe(422); // confirm required
    const pub = await superAdmin.c.post(`/admin/instructions/drafts/${d.id}/publish`, { confirm: true });
    expect(pub.body).toMatchObject({ status: 'provisional', usableInProduction: false });
    expect((await lastAudit('instructions.published')).metadata).toMatchObject({ version: '0.2-test', status: 'provisional' });
    // Staff now see the new version; it can't be edited, and the draft is frozen.
    const staff = await staffAt(['DEV-RUH-01']);
    const { text } = await registrationWithQr();
    const v = (await scan(staff.c, text)).body;
    expect(v.collectionInstructions.version).toBe('0.2-test');
    expect(v.collectionInstructions.checklist.map((x: { id: string }) => x.id)).toEqual(['qr_checked', 'id_checked']);
    await expect(t.db.query(`UPDATE collection_instructions SET title = 'changed' WHERE version = '0.2-test'`)).rejects.toThrow(/immutable/);
    await expect(t.db.query(`UPDATE collection_instruction_drafts SET notes = 'x' WHERE id = $1`, [d.id])).rejects.toThrow(/cannot be changed/);
    const list = (await admin.c.get('/admin/instructions')).body;
    expect(list.current.map((x: { version: string }) => x.version)).toEqual(['0.2-test', '0.2-test']);
    expect(list.canPublish).toBe(false);
  });

  it('records an external clinical approval reference as an approved version; samples keep the version they used', async () => {
    const staff = await staffAt(['DEV-RUH-01']);
    const first = await registrationWithQr();
    expect((await collectSample(staff.c, first.text)).status).toBe(200);
    const before = (await t.db.query('SELECT instructions_id FROM samples s JOIN registrations r ON r.id = s.registration_id WHERE r.id = $1', [first.registration.id])).rows[0].instructions_id;
    const d = (await admin.c.post('/admin/instructions/drafts', body('1.0-test'))).body.draft;
    await admin.c.post(`/admin/instructions/drafts/${d.id}/submit`, {});
    const pub = await superAdmin.c.post(`/admin/instructions/drafts/${d.id}/publish`, { confirm: true, clinicalApprovalReference: 'LAB-APPROVAL-2026-001' });
    expect(pub.body).toMatchObject({ status: 'approved', usableInProduction: true });
    const row = (await t.db.query(`SELECT status, approved_by, approval_reference FROM collection_instructions WHERE version = '1.0-test' AND locale = 'en'`)).rows[0];
    expect(row).toMatchObject({ status: 'approved', approved_by: superAdmin.userId, approval_reference: 'LAB-APPROVAL-2026-001' });
    const after = (await t.db.query('SELECT instructions_id FROM samples s JOIN registrations r ON r.id = s.registration_id WHERE r.id = $1', [first.registration.id])).rows[0].instructions_id;
    expect(after).toBe(before);
    const w = (await admin.c.post('/admin/instructions/drafts', body('1.1-test'))).body.draft;
    expect((await admin.c.post(`/admin/instructions/drafts/${w.id}/withdraw`, { reason: 'Not needed after all' })).body.draft.status).toBe('withdrawn');
  });
});

describe('email delivery monitor', () => {
  it('lists emails with masked recipients and no payloads; retries only failed, rebuildable emails', async () => {
    const { registration, email } = await registrationWithQr();
    await t.settleMail();
    const list = (await admin.c.get(`/admin/emails?registrationId=${registration.id}`)).body;
    expect(list.items.length).toBeGreaterThan(0);
    const item = list.items[0];
    expect(item.recipient).toBe(maskEmail(email));
    expect(JSON.stringify(list)).not.toContain(email);
    expect(Object.keys(item)).not.toContain('payload_enc');
    expect(item.providerMessageId).toBeTruthy();
    // Simulate a final delivery failure, then retry.
    await t.db.query(`UPDATE email_outbox SET status = 'failed', last_error = 'provider rejected ${email}', attempts = 6 WHERE id = $1`, [item.id]);
    const failed = (await admin.c.get('/admin/emails?status=failed')).body.items.find((x: { id: string }) => x.id === item.id);
    expect(failed.lastError).toBe('provider rejected [email]');
    expect(failed.retryable).toBe(true);
    expect((await admin.c.post(`/admin/emails/${item.id}/retry`, {})).status).toBe(202);
    await t.settleMail();
    expect((await t.db.query('SELECT status FROM email_outbox WHERE id = $1', [item.id])).rows[0].status).toBe('sent');
    expect((await admin.c.post(`/admin/emails/${item.id}/retry`, {})).body.error.code).toBe('EMAIL_NOT_FAILED');
    // One-time-link emails can't be retried (their link was erased).
    const verify = (await t.db.query(`SELECT id FROM email_outbox WHERE kind = 'verify_email' LIMIT 1`)).rows[0].id;
    await t.db.query(`UPDATE email_outbox SET status = 'failed' WHERE id = $1`, [verify]);
    expect((await admin.c.post(`/admin/emails/${verify}/retry`, {})).body.error.code).toBe('EMAIL_NOT_RETRYABLE');
    expect((await lastAudit('email.retry_requested')).target_id).toBe(item.id);
  });
});

describe('audit log viewer', () => {
  it('filters by date, event type, account and resource; auditors see no IPs, emails or free-text reasons', async () => {
    const cust = await t.customer();
    await admin.c.post(`/admin/customers/${cust.userId}/lock`, { reason: 'Reason mentioning a person' });
    const asAdmin = (await admin.c.get(`/admin/audit-logs?action=customer.locked&targetId=${cust.userId}`)).body.items;
    expect(asAdmin).toHaveLength(1);
    expect(asAdmin[0].metadata.reason).toBe('Reason mentioning a person');
    expect(asAdmin[0].actorEmail).toBe(admin.email);
    expect(asAdmin[0].ip).toBeTruthy();
    const asAuditor = (await auditor.c.get(`/admin/audit-logs?action=customer.locked&targetId=${cust.userId}`)).body.items;
    expect(asAuditor[0].metadata.reason).toBe('[redacted]');
    expect(asAuditor[0].ip).toBeNull();
    expect(asAuditor[0].actorEmail).toBeNull();
    expect((await auditor.c.get(`/admin/audit-logs?actorEmail=${encodeURIComponent(admin.email)}`)).status).toBe(403);
    const byEmail = (await admin.c.get(`/admin/audit-logs?actorEmail=${encodeURIComponent(admin.email)}&actionPrefix=customer`)).body.items;
    expect(byEmail.every((x: { actorUserId: string; action: string }) => x.actorUserId === admin.userId && x.action.startsWith('customer.'))).toBe(true);
    const today = new Date().toISOString().slice(0, 10);
    expect((await admin.c.get('/admin/audit-logs?from=2000-01-01&to=2000-01-02')).body.items).toHaveLength(0);
    expect((await admin.c.get(`/admin/audit-logs?to=${today}&limit=5`)).body.items.length).toBeGreaterThan(0);
    // Read-only: no edit or delete routes, and the database refuses changes anyway.
    expect((await admin.c.request('DELETE', '/admin/audit-logs')).status).toBe(404);
    await expect(t.db.query(`UPDATE audit_logs SET action = 'x' WHERE chain_seq = 1`)).rejects.toThrow();
  });
});

describe('operational export', () => {
  it('produces a non-identifying CSV, protected against formula injection, and audits it', async () => {
    await t.db.query(`INSERT INTO collection_branches (code, name_en, name_ar, city_en, city_ar) VALUES ('DEV-CSV-01', '=HYPERLINK("http://evil")', 'اختبار', 'X', 'س')`);
    const res = await t.app.request('/api/v1/admin/reports/operational.csv', { headers: { cookie: auditor.c.cookie!, origin: ORIGIN } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM for Arabic in Excel
    const text = bytes.toString('utf8');
    expect(text).toContain('date_riyadh,branch_code');
    expect(text).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(text).not.toMatch(/@example\.com|TRC-SA-|Layla/);
    expect((await lastAudit('report.exported')).metadata.personalData).toBe(false);
  });

  it('csv helpers neutralise every formula prefix; masking and scrubbing hide addresses', () => {
    for (const p of ['=', '+', '-', '@', '\t', '\r']) expect(csvCell(`${p}1`).replace(/^"|"$/g, '').startsWith(`'${p}`)).toBe(true);
    expect(csvCell('plain')).toBe('plain');
    expect(maskEmail('fatimah@example.sa')).toBe('f***@e***.sa');
    expect(scrubEmails('550 user a.b@x.com unknown')).toBe('550 user [email] unknown');
  });
});

describe('patient privacy regression', () => {
  it('no admin endpoint returns anything to collection staff, and their scan view is still age/gender only after admin changes', async () => {
    const canary = `Canary${letters()}`;
    const { registration, text } = await registrationWithQr({ patient: { firstName: canary, lastName: canary, dateOfBirth: yearsAgo(9), gender: 'male' }, contact: { fullName: `${canary} Parent`, phone: '0551112223' } });
    await admin.c.post(`/admin/registrations/${registration.id}/transfer`, { branchId: branch['DEV-JED-01'], reason: `moved ${canary}` });
    const staff = await staffAt(['DEV-JED-01']);
    for (const [method, path, body] of ENDPOINTS) {
      const res = await call(staff.c, [method, path.replace(X, registration.id), body]);
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain(canary);
    }
    const v = await scan(staff.c, text, branch['DEV-JED-01']);
    expect(v.status).toBe(200);
    expect(Object.keys(v.body).sort()).toEqual(['branch', 'canCollect', 'collectionInstructions', 'collectionSessionId', 'devVerificationAvailable', 'identityVerification', 'patientAge', 'patientGender', 'qrValid', 'sampleStatus', 'sampleType', 'trackingId']);
    expect(JSON.stringify(v.body)).not.toContain(canary);
    expect(JSON.stringify(v.body)).not.toContain('551112223');
  });
});
