import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaffAccount } from '../src/modules/accounts/accounts.service.ts';
import { GOOD_PASSWORD, setupTestApp, totpCode, type TestEnv } from './helpers/test-app.ts';

let t: TestEnv;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(async () => {
  await t.close();
});

const cli = { actorUserId: null, actorRole: 'system_cli', ip: null, userAgent: null, requestId: null };

describe('staff-side accounts', () => {
  it('cannot be created through public sign-up: sign-up always yields a customer', async () => {
    const res = await t.client().post('/auth/sign-up', { email: 'wannabe@example.com', password: GOOD_PASSWORD, roles: ['admin'] });
    expect(res.status).toBe(422);
  });

  it('are created by invitation only, with staff roles only, and a unique email', async () => {
    await expect(createStaffAccount(t.deps, { email: 'c@example.com', roles: ['customer'], locale: 'en', meta: cli })).rejects.toMatchObject({ code: 'INVALID_ROLE' });
    await expect(createStaffAccount(t.deps, { email: 'c@example.com', roles: [], locale: 'en', meta: cli })).rejects.toMatchObject({ code: 'ROLE_REQUIRED' });
    const { email } = await t.customer();
    await expect(createStaffAccount(t.deps, { email, roles: ['collection_staff'], locale: 'en', meta: cli })).rejects.toMatchObject({ code: 'EMAIL_IN_USE' });
  });

  it('cannot sign in before the setup link is used, and the link works once', async () => {
    const { setupLink } = await createStaffAccount(t.deps, { email: 'new.staff@example.com', roles: ['collection_staff'], locale: 'ar', meta: cli });
    expect(setupLink).toContain('/ar/traced/staff/accept-invite/#token=');
    expect((await t.client().post('/auth/sign-in', { email: 'new.staff@example.com', password: GOOD_PASSWORD })).status).toBe(401);
    const token = setupLink.split('#token=')[1]!;
    expect((await t.client().post('/auth/account-setup', { token, password: GOOD_PASSWORD })).status).toBe(200);
    expect((await t.client().post('/auth/account-setup', { token, password: GOOD_PASSWORD })).status).toBe(400);
    const signIn = await t.client().post('/auth/sign-in', { email: 'new.staff@example.com', password: GOOD_PASSWORD });
    expect(signIn.status).toBe(200);
    expect(signIn.body.user).toMatchObject({ roles: ['collection_staff'], emailVerified: true, mfa: { required: false } });
  });

  it('privileged sessions are short-lived (12h absolute, 30 min idle)', async () => {
    const s = await t.staff(['collection_staff']);
    const { rows } = await t.db.query<{ secs: number; idle: number }>(
      `SELECT EXTRACT(EPOCH FROM (expires_at - created_at))::int AS secs, idle_timeout_seconds AS idle FROM sessions WHERE user_id = $1 AND revoked_at IS NULL`,
      [s.userId],
    );
    expect(rows[0]).toEqual({ secs: 12 * 3600, idle: 1800 });
  });
});

describe('permission enforcement on the audit-log endpoint', () => {
  it('401 when signed out', async () => {
    expect((await t.client().get('/admin/audit-logs')).status).toBe(401);
  });

  it('403 for customers and collection staff, and the denial is audited', async () => {
    const cust = await t.customer();
    const res = await cust.c.get('/admin/audit-logs');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    const staff = await t.staff(['collection_staff']);
    expect((await staff.c.get('/admin/audit-logs')).status).toBe(403);
    const { rows } = await t.db.query(`SELECT actor_user_id, metadata FROM audit_logs WHERE action = 'authz.denied' AND actor_user_id = $1`, [cust.userId]);
    expect(rows[0]!.metadata).toEqual({ missing: ['audit.read'] });
  });

  it('admins must enrol in MFA, then verify it in every new session', async () => {
    const admin = await t.staff(['admin']);
    const me = await admin.c.get('/auth/me');
    expect(me.body.user.mfa).toEqual({ required: true, enrolled: false, verified: false });
    expect((await admin.c.get('/admin/audit-logs')).body.error.code).toBe('MFA_SETUP_REQUIRED');

    const setup = await admin.c.post('/auth/mfa/setup');
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\/TRACED:/);
    expect((await admin.c.post('/auth/mfa/enable', { code: '000000' })).body.error.code).toBe('INVALID_MFA_CODE');

    const cookieBefore = admin.c.cookie;
    const enable = await admin.c.post('/auth/mfa/enable', { code: totpCode(setup.body.secret) });
    expect(enable.status).toBe(200);
    expect(enable.body.recoveryCodes).toHaveLength(10);
    expect(admin.c.cookie).not.toBe(cookieBefore); // session rotated on privilege change

    const ok = await admin.c.get('/admin/audit-logs?limit=5');
    expect(ok.status).toBe(200);
    expect(ok.body.items.length).toBeLessThanOrEqual(5);

    // A fresh sign-in is not MFA-verified until a code is entered.
    const second = t.client();
    await second.post('/auth/sign-in', { email: admin.email, password: GOOD_PASSWORD });
    expect((await second.get('/admin/audit-logs')).body.error.code).toBe('MFA_REQUIRED');
    const code = totpCode(setup.body.secret, 1);
    expect((await second.post('/auth/mfa/verify', { code })).status).toBe(200);
    expect((await second.get('/admin/audit-logs')).status).toBe(200);

    // The same code cannot be replayed in another session.
    const third = t.client();
    await third.post('/auth/sign-in', { email: admin.email, password: GOOD_PASSWORD });
    expect((await third.post('/auth/mfa/verify', { code })).body.error.code).toBe('INVALID_MFA_CODE');

    // Recovery codes work once each.
    const rc = enable.body.recoveryCodes[0];
    expect((await third.post('/auth/mfa/verify', { recoveryCode: rc.toLowerCase() })).status).toBe(200);
    const fourth = t.client();
    await fourth.post('/auth/sign-in', { email: admin.email, password: GOOD_PASSWORD });
    expect((await fourth.post('/auth/mfa/verify', { recoveryCode: rc })).status).toBe(401);
  });

  it('stores the MFA secret encrypted, never in plain text', async () => {
    const a = await t.mfaStaff(['admin']);
    const { rows } = await t.db.query<{ enc: string; pending: string | null }>('SELECT mfa_totp_secret_enc AS enc, mfa_pending_secret_enc AS pending FROM users WHERE id = $1', [a.userId]);
    expect(rows[0]!.enc.startsWith('v1.')).toBe(true);
    expect(rows[0]!.enc).not.toContain(a.secret);
    expect(rows[0]!.pending).toBeNull();
  });

  it('limits MFA guesses', async () => {
    const a = await t.mfaStaff(['auditor']);
    const fresh = t.client();
    await fresh.post('/auth/sign-in', { email: a.email, password: GOOD_PASSWORD });
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await fresh.post('/auth/mfa/verify', { code: '123456' })).status);
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  it('auditors can read the log; reads are themselves audited; filters and paging work', async () => {
    const a = await t.mfaStaff(['auditor']);
    const page = await a.c.get('/admin/audit-logs?action=auth.sign_in&limit=2');
    expect(page.status).toBe(200);
    expect(page.body.items.every((i: { action: string }) => i.action === 'auth.sign_in')).toBe(true);
    expect(page.body.nextBeforeSeq).not.toBeNull();
    const next = await a.c.get(`/admin/audit-logs?action=auth.sign_in&limit=2&beforeSeq=${page.body.nextBeforeSeq}`);
    expect(next.body.items[0].seq).toBeLessThan(page.body.items[1].seq);
    expect((await a.c.get('/admin/audit-logs?limit=9999')).status).toBe(422);
    expect((await a.c.get("/admin/audit-logs?action=x' OR 1=1")).status).toBe(422);
    const reads = await t.db.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'audit.read' AND actor_user_id = $1`, [a.userId]);
    expect(reads.rows[0]!.n).toBe(2);
  });

  it('a suspended admin loses access immediately', async () => {
    const a = await t.mfaStaff(['admin']);
    expect((await a.c.get('/admin/audit-logs')).status).toBe(200);
    await t.db.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [a.userId]);
    expect((await a.c.get('/admin/audit-logs')).status).toBe(401);
  });

  it('the whole audit chain still verifies after all of the above', async () => {
    const { rows } = await t.db.query<{ broken: string | null }>('SELECT audit_verify_chain() AS broken');
    expect(rows[0]!.broken).toBeNull();
  });
});
