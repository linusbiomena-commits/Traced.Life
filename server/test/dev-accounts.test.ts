import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertLocalDevelopment, ensureTestAccount, TEST_ACCOUNTS } from '../src/cli/dev-test-accounts.ts';
import { GOOD_PASSWORD, setupTestApp, type TestEnv } from './helpers/test-app.ts';

let t: TestEnv;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(async () => t.close());

const token = (link: string) => /#token=([A-Za-z0-9_-]+)/.exec(link)![1]!;

describe('local test-account CLI (dev:test-accounts)', () => {
  it('refuses production, non-local databases and real mail providers', () => {
    const ok = { env: 'development' as const, databaseUrl: 'postgres://u:p@127.0.0.1:54329/traced', mailTransport: 'dev' as const };
    expect(() => assertLocalDevelopment(ok)).not.toThrow();
    expect(() => assertLocalDevelopment({ ...ok, env: 'production' })).toThrow(/local development only/);
    expect(() => assertLocalDevelopment({ ...ok, databaseUrl: 'postgres://u:p@10.1.2.3:5432/traced' })).toThrow(/local database/);
    expect(() => assertLocalDevelopment({ ...ok, databaseUrl: 'postgres://u:p@db.example.com/traced' })).toThrow(/local database/);
    expect(() => assertLocalDevelopment({ ...ok, mailTransport: 'resend' })).toThrow(/real mail provider/);
  });

  it('creates synthetic accounts with one-time links only (no stored password), and is idempotent', async () => {
    for (const a of TEST_ACCOUNTS) {
      const r = await ensureTestAccount(t.db, t.config, a, false);
      expect(r.status, a.key).toBe('created');
      expect(r.link, a.key).toMatch(/#token=/);
    }
    const { rows } = await t.db.query(`SELECT email, password_hash FROM users WHERE email LIKE '%.local@example.com'`);
    expect(rows).toHaveLength(TEST_ACCOUNTS.length);
    expect(rows.every((r) => r.password_hash === null)).toBe(true);
    const staff = await t.db.query(`SELECT b.code FROM staff_branch_assignments a JOIN collection_branches b ON b.id = a.branch_id JOIN users u ON u.id = a.user_id WHERE u.email = 'staff.local@example.com' AND a.revoked_at IS NULL`);
    expect(staff.rows.map((r) => r.code)).toEqual(['DEV-RUH-01']);
    // Second run: nothing duplicated; pending accounts get a fresh link and the old one dies.
    const admin = TEST_ACCOUNTS.find((a) => a.key === 'admin')!;
    const first = (await t.db.query(`SELECT count(*)::int AS n FROM users WHERE email LIKE '%.local@example.com'`)).rows[0].n;
    const again = await ensureTestAccount(t.db, t.config, admin, false);
    expect(again.status).toMatch(/pending set-up/);
    expect((await t.db.query(`SELECT count(*)::int AS n FROM users WHERE email LIKE '%.local@example.com'`)).rows[0].n).toBe(first);
  });

  it('links work through the normal flows, and set-up accounts get a reset link only with --reset', async () => {
    const customer = TEST_ACCOUNTS.find((a) => a.key === 'customer')!;
    const r = await ensureTestAccount(t.db, t.config, customer, false);
    expect(r.link).toContain('/traced/account/reset-password/');
    expect((await t.client().post('/auth/password/reset', { token: token(r.link!), password: GOOD_PASSWORD })).status).toBe(200);
    const signIn = await t.client().post('/auth/sign-in', { email: customer.email, password: GOOD_PASSWORD });
    expect(signIn.status).toBe(200);
    expect(signIn.body.user.roles).toEqual(['customer']);
    expect(signIn.body.user.emailVerified).toBe(true);
    expect((await ensureTestAccount(t.db, t.config, customer, false)).link).toBeNull();
    expect((await ensureTestAccount(t.db, t.config, customer, true)).link).toContain('/reset-password/');

    const auditor = TEST_ACCOUNTS.find((a) => a.key === 'auditor')!;
    const a = await ensureTestAccount(t.db, t.config, auditor, false);
    expect(a.link).toContain('/traced/admin/accept-invite/');
    expect((await t.client().post('/auth/account-setup', { token: token(a.link!), password: GOOD_PASSWORD })).status).toBe(200);
    // Privileged accounts still have to enrol MFA: no admin endpoint works yet.
    const c = t.client();
    await c.post('/auth/sign-in', { email: auditor.email, password: GOOD_PASSWORD });
    expect((await c.get('/admin/stats')).body.error.code).toBe('MFA_SETUP_REQUIRED');
  });

  it('never changes an existing account that has other roles', async () => {
    const s = await t.staff(['collection_staff'], 'superadmin.other@example.com');
    const r = await ensureTestAccount(t.db, t.config, { key: 'x', email: 'superadmin.other@example.com', roles: ['super_admin'], name: 'X' }, true);
    expect(r.status).toMatch(/different roles/);
    expect(r.link).toBeNull();
    const roles = await t.db.query('SELECT role_key FROM user_roles WHERE user_id = $1', [s.userId]);
    expect(roles.rows.map((x) => x.role_key)).toEqual(['collection_staff']);
  });
});
