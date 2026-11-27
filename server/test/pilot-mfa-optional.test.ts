import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { setupTestApp, type TestEnv } from './helpers/test-app.ts';
import { randomBytes } from 'node:crypto';

// PILOT_MFA_OPTIONAL (restricted pilot only, owner request 28 Nov 2026): privileged roles may sign in without
// two-step verification. Production refuses the setting.

let t: TestEnv;
beforeAll(async () => { t = await setupTestApp(); });
afterAll(async () => t.close());

describe('PILOT_MFA_OPTIONAL', () => {
  it('is refused in production and ignored there even if forced', () => {
    const base = { APP_ORIGIN: 'https://traced.example.sa', DATABASE_URL: 'postgres://x', TOKEN_HMAC_KEY: randomBytes(32).toString('base64'), DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64') };
    const prod = { ...base, NODE_ENV: 'production', COOKIE_SECURE: 'true', MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_test_123', MAIL_FROM: 'TRACED <a@b.sa>', TRUSTED_PROXY_HOPS: '1', INTERNAL_CRON_SECRET: 'x'.repeat(32) };
    expect(() => loadConfig({ ...prod, PILOT_MFA_OPTIONAL: 'true' })).toThrow(/PILOT_MFA_OPTIONAL/);
    expect(loadConfig({ ...base, PILOT_MFA_OPTIONAL: 'true' }).pilotMfaOptional).toBe(true);
    expect(loadConfig(base).pilotMfaOptional).toBe(false);
  });

  it('off (default): a super admin without MFA is sent to two-step setup', async () => {
    t.config.pilotMfaOptional = false;
    const sa = await t.staff(['super_admin']);
    expect((await sa.c.get('/admin/registrations')).status).toBe(403);
    expect((await sa.c.get('/auth/me')).body.user.mfa.required).toBe(true);
  });

  it('on (pilot): plain sign-in reaches the admin area; roles and permissions still apply', async () => {
    t.config.pilotMfaOptional = true;
    const sa = await t.staff(['super_admin']);
    expect((await sa.c.get('/auth/me')).body.user.mfa.required).toBe(false);
    expect((await sa.c.get('/admin/registrations')).status).toBe(200);
    const staff = await t.staff(['collection_staff']);
    expect((await staff.c.get('/admin/registrations')).status).toBe(403); // RBAC unchanged
    t.config.pilotMfaOptional = false;
  });
});
