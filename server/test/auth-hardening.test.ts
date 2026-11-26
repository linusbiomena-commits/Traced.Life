import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { GOOD_PASSWORD, setupTestApp, totpCode, type TestEnv } from './helpers/test-app.ts';

// Phase 7 milestone 2: lost-authenticator recovery (super-admin reset), self-service recovery-code
// regeneration and the stricter production configuration checks.

let t: TestEnv;
let superAdmin: Awaited<ReturnType<TestEnv['mfaStaff']>>;
let admin: Awaited<ReturnType<TestEnv['mfaStaff']>>;
beforeAll(async () => {
  t = await setupTestApp();
  superAdmin = await t.mfaStaff(['super_admin']);
  admin = await t.mfaStaff(['admin']);
});
afterAll(async () => t.close());

const reason = 'Authenticator phone lost; identity confirmed by phone call';

describe('super-admin two-step verification reset', () => {
  it('clears the authenticator and recovery codes, ends sessions, audits, and forces re-enrolment', async () => {
    const lab = await t.mfaStaff(['lab_operator']);
    expect((await lab.c.get('/lab/dashboard')).status).not.toBe(401);
    const res = await superAdmin.c.post(`/admin/staff/${lab.userId}/mfa-reset`, { reason });
    expect(res.status).toBe(200);
    expect(res.body.staff.security).toMatchObject({ mfaEnabled: false, activeSessions: 0 });
    const { rows } = await t.db.query('SELECT mfa_totp_secret_enc, mfa_pending_secret_enc, mfa_enabled_at FROM users WHERE id = $1', [lab.userId]);
    expect(rows[0]).toEqual({ mfa_totp_secret_enc: null, mfa_pending_secret_enc: null, mfa_enabled_at: null });
    expect((await t.db.query('SELECT 1 FROM mfa_recovery_codes WHERE user_id = $1', [lab.userId])).rowCount).toBe(0);
    // Old session is gone; old recovery codes no longer work.
    expect((await lab.c.get('/auth/me')).status).toBe(401);
    const audit = await t.db.query(`SELECT metadata FROM audit_logs WHERE action = 'staff.mfa_reset' AND target_id = $1`, [lab.userId]);
    expect(audit.rows[0].metadata.reason).toBe(reason);
    // Next sign-in must enrol again before reaching the lab API.
    const c = t.client();
    const signIn = await c.post('/auth/sign-in', { email: lab.email, password: GOOD_PASSWORD });
    expect(signIn.status).toBe(200);
    expect((await c.get('/lab/dashboard')).status).toBe(403);
    const setup = await c.post('/auth/mfa/setup');
    expect(setup.status).toBe(200);
    expect((await c.post('/auth/mfa/enable', { code: totpCode(setup.body.secret) })).status).toBe(200);
    expect((await c.get('/lab/dashboard')).status).not.toBe(403);
    // The old recovery codes were deleted.
    const c2 = t.client();
    await c2.post('/auth/sign-in', { email: lab.email, password: GOOD_PASSWORD });
    expect((await c2.post('/auth/mfa/verify', { recoveryCode: lab.recoveryCodes[0] })).status).not.toBe(200);
  });

  it('is super-admin only, needs a reason, refuses self, customers and unenrolled accounts', async () => {
    const lab = await t.mfaStaff(['lab_operator']);
    expect((await admin.c.post(`/admin/staff/${lab.userId}/mfa-reset`, { reason })).status).toBe(403);
    expect((await superAdmin.c.post(`/admin/staff/${lab.userId}/mfa-reset`, {})).status).toBe(422);
    expect((await superAdmin.c.post(`/admin/staff/${lab.userId}/mfa-reset`, { reason: 'x' })).status).toBe(422);
    expect((await superAdmin.c.post(`/admin/staff/${superAdmin.userId}/mfa-reset`, { reason })).status).toBe(403);
    const cust = await t.customer();
    expect((await superAdmin.c.post(`/admin/staff/${cust.userId}/mfa-reset`, { reason })).status).toBe(404);
    const plain = await t.staff(['collection_staff']);
    const r = await superAdmin.c.post(`/admin/staff/${plain.userId}/mfa-reset`, { reason });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('MFA_NOT_ENROLLED');
    // Nothing changed for the lab account after the refused attempts.
    expect((await lab.c.get('/auth/me')).status).toBe(200);
  });
});

describe('self-service recovery-code regeneration', () => {
  it('needs a current authenticator code, replaces the old codes and audits', async () => {
    const a = await t.mfaStaff(['auditor']);
    expect((await a.c.post('/auth/mfa/recovery-codes', { code: '000000' })).status).toBe(401);
    // A wrong code is audited as a failure.
    expect((await t.db.query(`SELECT 1 FROM audit_logs WHERE action = 'auth.recovery_codes_regenerated' AND outcome = 'failure' AND target_id = $1`, [a.userId])).rowCount).toBe(1);
    const res = await a.c.post('/auth/mfa/recovery-codes', { code: totpCode(a.secret, 1) });
    expect(res.status).toBe(200);
    expect(res.body.recoveryCodes).toHaveLength(a.recoveryCodes.length);
    expect(res.body.recoveryCodes).not.toContain(a.recoveryCodes[0]);
    // Re-using the same step is refused (replay protection).
    expect((await a.c.post('/auth/mfa/recovery-codes', { code: totpCode(a.secret, 1) })).status).toBe(401);
    // Old codes fail, new ones work.
    const c = t.client();
    await c.post('/auth/sign-in', { email: a.email, password: GOOD_PASSWORD });
    expect((await c.post('/auth/mfa/verify', { recoveryCode: a.recoveryCodes[1] })).status).not.toBe(200);
    expect((await c.post('/auth/mfa/verify', { recoveryCode: res.body.recoveryCodes[0] })).status).toBe(200);
  });

  it('is refused for accounts without verified two-step verification', async () => {
    const cust = await t.customer();
    expect((await cust.c.post('/auth/mfa/recovery-codes', { code: '123456' })).status).toBe(409);
  });
});

describe('production configuration guards', () => {
  const prod = {
    NODE_ENV: 'production', APP_ORIGIN: 'https://traced.example.sa', DATABASE_URL: 'postgres://x', COOKIE_SECURE: 'true',
    TOKEN_HMAC_KEY: randomBytes(32).toString('base64'), DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_abc', MAIL_FROM: 'a@b.sa', TRUSTED_PROXY_HOPS: '1',
  };
  it('needs a scheduler credential', () => {
    expect(() => loadConfig(prod)).toThrow(/INTERNAL_CRON_SECRET or SCHEDULER_OIDC_AUDIENCE/);
    expect(loadConfig({ ...prod, INTERNAL_CRON_SECRET: randomBytes(32).toString('hex') }).env).toBe('production');
    expect(() => loadConfig({ ...prod, SCHEDULER_OIDC_AUDIENCE: 'https://traced-api.example.run.app' })).toThrow(/SCHEDULER_OIDC_SERVICE_ACCOUNT/);
    expect(loadConfig({ ...prod, SCHEDULER_OIDC_AUDIENCE: 'https://traced-api.example.run.app', SCHEDULER_OIDC_SERVICE_ACCOUNT: 'scheduler@p.iam.gserviceaccount.com' }).schedulerOidcAudience).toBeDefined();
  });
  it('refuses a local or plain-http origin', () => {
    const ok = { ...prod, INTERNAL_CRON_SECRET: randomBytes(32).toString('hex') };
    expect(() => loadConfig({ ...ok, APP_ORIGIN: 'https://localhost:8787' })).toThrow(/APP_ORIGIN/);
    expect(() => loadConfig({ ...ok, APP_ORIGIN: 'http://traced.example.sa' })).toThrow();
  });
  it('bounds the personal-data export limits', () => {
    const ok = { ...prod, INTERNAL_CRON_SECRET: randomBytes(32).toString('hex') };
    expect(loadConfig(ok).exportPiiMaxDays).toBe(31);
    expect(() => loadConfig({ ...ok, EXPORT_PII_MAX_ROWS: '999999' })).toThrow();
  });
});
