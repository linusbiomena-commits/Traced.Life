import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changeUserEmail, createStaffAccount } from '../src/modules/accounts/accounts.service.ts';
import { setupTestApp, type TestEnv } from './helpers/test-app.ts';

// Audited login-email change (used to move the preview super admin to info@tracedmena.life). Runs as the
// least-privilege traced_app role, so the procedure needs no extra database rights.

let t: TestEnv;
beforeAll(async () => { t = await setupTestApp({ appRole: true }); });
afterAll(async () => t.close());

const meta = { actorUserId: null, actorRole: 'system_cli', ip: null, userAgent: 'test', requestId: null };
const rand = () => randomBytes(4).toString('hex');
const PW = 'Correct-Horse-Battery-9';

describe('changeUserEmail', () => {
  it('moves a customer to another address: same id, unverified, sessions revoked, old links dead, audited', async () => {
    const cust = await t.customer();
    const newEmail = `moved_${rand()}@example.com`;
    // An outstanding reset link for the old address.
    expect((await t.client().post('/auth/password/forgot', { email: cust.email })).status).toBe(202);
    const oldReset = await t.tokenFromMail(cust.email, 'reset_password');

    const r = await changeUserEmail(t.deps, { from: cust.email, to: newEmail, reason: 'Preview: free the address for the super admin', meta });
    expect(r.userId).toBe(cust.userId);
    expect(r.sessionsRevoked).toBeGreaterThanOrEqual(1);
    const u = (await t.db.query('SELECT email, email_verified_at FROM users WHERE id = $1', [cust.userId])).rows[0];
    expect(u).toEqual({ email: newEmail, email_verified_at: null });
    expect((await cust.c.get('/auth/me')).status).toBe(401); // session revoked
    expect((await t.client().post('/auth/password/reset', { token: oldReset, password: PW })).status).not.toBe(200);
    const a = (await t.db.query(`SELECT metadata FROM audit_logs WHERE action = 'account.email_changed' AND target_id = $1`, [cust.userId])).rows[0];
    expect(a.metadata.reason).toContain('Preview');
    expect(JSON.stringify(a.metadata)).not.toContain('@');
    expect((await t.db.query('SELECT * FROM audit_verify_chain()')).rows[0].audit_verify_chain).toBeNull();
  });

  it('moves a pending super admin and sends a fresh setup link; the old link stops working; MFA stays mandatory', async () => {
    const oldEmail = `sa_old_${rand()}@example.com`;
    const newEmail = `sa_new_${rand()}@example.com`;
    const created = await createStaffAccount(t.deps, { email: oldEmail, roles: ['super_admin'], locale: 'en', meta });
    const oldToken = created.setupLink.match(/#token=([A-Za-z0-9_-]+)/)![1]!;

    const r = await changeUserEmail(t.deps, { from: oldEmail, to: newEmail, reason: 'Owner request: final login without plus-address', sendSetup: true, meta });
    expect(r).toMatchObject({ userId: created.userId, roles: ['super_admin'], setupQueued: true });
    expect((await t.client().post('/auth/account-setup', { token: oldToken, password: PW })).status).not.toBe(200);
    const fresh = await t.tokenFromMail(newEmail, 'account_setup');
    const c = t.client();
    expect((await c.post('/auth/account-setup', { token: fresh, password: PW })).status).toBe(200);
    const signIn = await c.post('/auth/sign-in', { email: newEmail, password: PW });
    expect(signIn.status).toBe(200);
    expect((await t.client().post('/auth/sign-in', { email: oldEmail, password: PW })).status).not.toBe(200);
    // Super admin requires MFA: admin data stays closed until two-step verification is enrolled.
    expect((await c.get('/admin/registrations')).status).toBe(403);
    const roles = (await t.db.query('SELECT role_key FROM user_roles WHERE user_id = $1', [created.userId])).rows.map((x) => x.role_key);
    expect(roles).toEqual(['super_admin']);
  });

  it('refuses taken addresses, bad reasons, accounts already set up (for invitations) and production', async () => {
    const a = await t.customer();
    const b = await t.customer();
    await expect(changeUserEmail(t.deps, { from: a.email, to: b.email, reason: 'Collision test reason', meta })).rejects.toMatchObject({ code: 'EMAIL_IN_USE' });
    await expect(changeUserEmail(t.deps, { from: a.email, to: `x_${rand()}@example.com`, reason: 'short', meta })).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    await expect(changeUserEmail(t.deps, { from: a.email, to: `x_${rand()}@example.com`, reason: 'mail to someone@example.com', meta })).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    await expect(changeUserEmail(t.deps, { from: a.email, to: `x_${rand()}@example.com`, reason: 'Customers get no invitation', sendSetup: true, meta })).rejects.toMatchObject({ code: 'NOT_STAFF' });
    const staff = await t.staff(['collection_staff']); // password already set
    await expect(changeUserEmail(t.deps, { from: staff.email, to: `y_${rand()}@example.com`, reason: 'Already set up account', sendSetup: true, meta })).rejects.toMatchObject({ code: 'INVITE_NOT_PENDING' });
    // A failed invitation request rolls back the whole change.
    expect((await t.db.query('SELECT 1 FROM users WHERE email = $1', [staff.email])).rowCount).toBe(1);
    const prodDeps = { ...t.deps, config: { ...t.deps.config, env: 'production' as const } };
    await expect(changeUserEmail(prodDeps, { from: a.email, to: `z_${rand()}@example.com`, reason: 'Production must refuse', meta })).rejects.toMatchObject({ code: 'NOT_IN_PRODUCTION' });
  });
});
