import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GOOD_PASSWORD, ORIGIN, setupTestApp, type TestEnv } from './helpers/test-app.ts';

let t: TestEnv;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(async () => {
  await t.close();
});

const auditCount = async (action: string, outcome?: string) =>
  Number(
    (await t.db.query<{ n: string }>('SELECT count(*) AS n FROM audit_logs WHERE action = $1 AND ($2::text IS NULL OR outcome = $2)', [action, outcome ?? null])).rows[0]!.n,
  );

describe('sign-up and email verification', () => {
  it('creates a customer, emails a verification link, and verifies it once', async () => {
    const c = t.client();
    const res = await c.post('/auth/sign-up', { confirmAdult: true, email: '  New.User@Example.com ', password: GOOD_PASSWORD, locale: 'ar' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'verification_sent' });

    const { rows } = await t.db.query('SELECT u.email, u.locale, u.email_verified_at, array_agg(ur.role_key) AS roles FROM users u JOIN user_roles ur ON ur.user_id = u.id WHERE u.email = $1 GROUP BY u.id', ['new.user@example.com']);
    expect(rows[0]).toMatchObject({ email: 'new.user@example.com', locale: 'ar', email_verified_at: null, roles: ['customer'] });

    const token = await t.tokenFromMail('new.user@example.com', 'verify_email');
    expect(t.mailer.lastTo('new.user@example.com')!.data.link).toContain('/ar/traced/account/verify-email/#token=');

    expect((await c.post('/auth/verify-email', { token })).status).toBe(200);
    expect((await c.post('/auth/verify-email', { token })).body.error.code).toBe('INVALID_OR_EXPIRED_TOKEN');
    expect(await auditCount('auth.email_verified', 'success')).toBe(1);
  });

  it('gives the same answer for an existing email (no account enumeration) and warns the owner', async () => {
    const { email } = await t.customer();
    const res = await t.client().post('/auth/sign-up', { confirmAdult: true, email, password: 'a different long password' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'verification_sent' });
    expect(await t.waitForMail(email, 'account_exists')).toBeDefined();
  });

  it('rejects weak passwords, unknown fields and malformed input', async () => {
    const c = t.client();
    expect((await c.post('/auth/sign-up', { confirmAdult: true, email: 'weak@example.com', password: 'short' })).body.error.code).toBe('WEAK_PASSWORD');
    expect((await c.post('/auth/sign-up', { confirmAdult: true, email: 'weak@example.com', password: 'weakpassword-weak@example' })).body.error).toMatchObject({ code: 'WEAK_PASSWORD' });
    expect((await c.post('/auth/sign-up', { confirmAdult: true, email: 'x@example.com', password: GOOD_PASSWORD, role: 'admin' })).body.error.code).toBe('VALIDATION_FAILED');
    expect((await c.post('/auth/sign-up', { confirmAdult: true, email: 'not-an-email', password: GOOD_PASSWORD })).status).toBe(422);
    expect((await c.post('/auth/sign-up', undefined, { raw: '{bad json' })).body.error.code).toBe('INVALID_JSON');
  });

  it('rejects expired verification tokens', async () => {
    const c = t.client();
    await c.post('/auth/sign-up', { confirmAdult: true, email: 'expired@example.com', password: GOOD_PASSWORD });
    const token = await t.tokenFromMail('expired@example.com', 'verify_email');
    await t.db.query(`UPDATE auth_tokens SET expires_at = now() - interval '1 second' WHERE purpose = 'verify_email'`);
    expect((await c.post('/auth/verify-email', { token })).status).toBe(400);
  });

  it('resending a verification email invalidates the previous link', async () => {
    const c = t.client();
    const email = 'resend@example.com';
    await c.post('/auth/sign-up', { confirmAdult: true, email, password: GOOD_PASSWORD });
    const first = await t.tokenFromMail(email, 'verify_email');
    await c.post('/auth/sign-in', { email, password: GOOD_PASSWORD });
    expect((await c.get('/auth/me')).body.user.emailVerified).toBe(false);
    expect((await c.post('/auth/verify-email/resend')).status).toBe(202);
    const second = await t.tokenFromMail(email, 'verify_email');
    expect(second).not.toBe(first);
    expect((await c.post('/auth/verify-email', { token: first })).status).toBe(400);
    expect((await c.post('/auth/verify-email', { token: second })).status).toBe(200);
  });
});

describe('sign-in, sessions and sign-out', () => {
  it('sets an HttpOnly, SameSite=Strict session cookie and returns the user and CSRF token', async () => {
    const { email } = await t.customer();
    const c = t.client();
    const res = await c.post('/auth/sign-in', { email, password: GOOD_PASSWORD });
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//);
    expect(res.body.user).toMatchObject({ email, emailVerified: true, roles: ['customer'], mfa: { required: false } });
    expect(res.body.user.permissions).toEqual(['registration.create_own', 'registration.read_own']);
    expect(Object.keys(res.body.user).sort()).toEqual(['email', 'emailVerified', 'id', 'locale', 'mfa', 'permissions', 'roles']);
    expect(typeof res.body.csrfToken).toBe('string');

    const stored = await t.db.query<{ token_hash: Buffer }>('SELECT token_hash FROM sessions ORDER BY created_at DESC LIMIT 1');
    expect(stored.rows[0]!.token_hash.toString('utf8')).not.toContain(c.cookie!.split('=')[1]!);
  });

  it('answers wrong password and unknown email identically', async () => {
    const { email } = await t.customer();
    const wrong = await t.client().post('/auth/sign-in', { email, password: 'wrong password here' });
    const unknown = await t.client().post('/auth/sign-in', { email: 'nobody@example.com', password: 'wrong password here' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.code).toBe(unknown.body.error.code);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it('locks the account for 15 minutes after 10 wrong passwords, even for the right password', async () => {
    const { email } = await t.customer();
    for (let i = 0; i < 10; i++) await t.client().post('/auth/sign-in', { email, password: `wrong password ${i}` });
    const locked = await t.client().post('/auth/sign-in', { email, password: GOOD_PASSWORD });
    expect(locked.status).toBe(401);
    expect(await auditCount('auth.account_locked')).toBeGreaterThanOrEqual(1);
    await t.db.query(`UPDATE users SET locked_until = now() - interval '1 second' WHERE email = $1`, [email]);
    expect((await t.client().post('/auth/sign-in', { email, password: GOOD_PASSWORD })).status).toBe(200);
  });

  it('sign-out revokes the session server-side', async () => {
    const { c } = await t.customer();
    const stolenCookie = c.cookie;
    expect((await c.post('/auth/sign-out')).status).toBe(204);
    expect(c.cookie).toBeNull();
    c.cookie = stolenCookie; // replaying the old cookie must not work
    expect((await c.get('/auth/me')).status).toBe(401);
  });

  it('expires idle and over-age sessions, and drops sessions of suspended users', async () => {
    const a = await t.customer();
    await t.db.query(`UPDATE sessions SET last_seen_at = now() - interval '25 hours' WHERE user_id = $1`, [a.userId]);
    expect((await a.c.get('/auth/me')).status).toBe(401);

    const b = await t.customer();
    await t.db.query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [b.userId]);
    expect((await b.c.get('/auth/me')).status).toBe(401);

    const d = await t.customer();
    expect((await d.c.get('/auth/me')).status).toBe(200);
    await t.db.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [d.userId]);
    expect((await d.c.get('/auth/me')).status).toBe(401);
    expect((await t.client().post('/auth/sign-in', { email: d.email, password: GOOD_PASSWORD })).status).toBe(401);
  });

  it('a stale cookie does not block signing in again', async () => {
    const { c, email, userId } = await t.customer();
    await t.db.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1`, [userId]);
    const res = await c.post('/auth/sign-in', { email, password: GOOD_PASSWORD }, { csrf: false });
    expect(res.status).toBe(200);
  });
});

describe('CSRF and request hardening', () => {
  it('requires the CSRF token on state-changing requests from a signed-in browser', async () => {
    const { c } = await t.customer();
    expect((await c.post('/auth/sign-out', {}, { csrf: false })).body.error.code).toBe('CSRF_REJECTED');
    expect((await c.post('/auth/sign-out', {}, { headers: { 'x-csrf-token': 'forged' } })).body.error.code).toBe('CSRF_REJECTED');
    expect((await c.post('/auth/sign-out')).status).toBe(204);
  });

  it('rejects foreign origins and non-JSON bodies', async () => {
    const c = t.client();
    const foreign = await c.post('/auth/sign-in', { email: 'a@example.com', password: GOOD_PASSWORD }, { headers: { origin: 'https://evil.example' } });
    expect(foreign.body.error.code).toBe('CSRF_REJECTED');
    const crossSite = await c.post('/auth/sign-in', { email: 'a@example.com', password: GOOD_PASSWORD }, { headers: { origin: '', 'sec-fetch-site': 'cross-site' } });
    expect(crossSite.body.error.code).toBe('CSRF_REJECTED');
    const form = await c.post('/auth/sign-in', undefined, { raw: 'email=a&password=b', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(form.status).toBe(415);
  });

  it('sends security headers and never caches API responses', async () => {
    const res = await t.client().get('/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects oversized bodies', async () => {
    const res = await t.client().post('/auth/sign-in', { email: 'a@example.com', password: 'x'.repeat(40_000) });
    expect(res.status).toBe(413);
  });

  it('returns JSON 404s for unknown API routes', async () => {
    const res = await t.client().get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('rate limiting', () => {
  it('limits sign-in attempts per IP with Retry-After', async () => {
    const c = t.client('192.0.2.77');
    let last;
    for (let i = 0; i < 21; i++) last = await c.post('/auth/sign-in', { email: `rl${i}@example.com`, password: 'wrong password here' });
    expect(last!.status).toBe(429);
    expect(Number(last!.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await t.client('192.0.2.78').post('/auth/sign-in', { email: 'rl0@example.com', password: 'wrong password here' })).status).toBe(401);
  });

  it('limits password reset emails per address regardless of IP', async () => {
    const { email } = await t.customer();
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await t.client().post('/auth/password/forgot', { email })).status);
    expect(statuses).toEqual([202, 202, 202, 429]);
  });
});

describe('password reset and change', () => {
  it('reset is enumeration-safe, single-use, signs out everywhere and replaces the password', async () => {
    const { c, email } = await t.customer();
    const unknown = await t.client().post('/auth/password/forgot', { email: 'ghost@example.com' });
    const known = await t.client().post('/auth/password/forgot', { email });
    expect(unknown.status).toBe(202);
    expect(known.body).toEqual(unknown.body);

    const token = await t.tokenFromMail(email, 'reset_password');
    const weak = await t.client().post('/auth/password/reset', { token, password: 'short' });
    expect(weak.body.error.code).toBe('WEAK_PASSWORD'); // and the token is still usable:
    expect((await t.client().post('/auth/password/reset', { token, password: 'a brand new long password' })).status).toBe(200);
    expect((await t.client().post('/auth/password/reset', { token, password: 'another new long password' })).status).toBe(400);

    expect((await c.get('/auth/me')).status).toBe(401);
    expect((await t.client().post('/auth/sign-in', { email, password: GOOD_PASSWORD })).status).toBe(401);
    expect((await t.client().post('/auth/sign-in', { email, password: 'a brand new long password' })).status).toBe(200);
    expect(await t.waitForMail(email, 'password_changed')).toBeDefined();
  });

  it('a newer reset link invalidates older ones', async () => {
    const { email } = await t.customer();
    await t.client().post('/auth/password/forgot', { email });
    const first = await t.tokenFromMail(email, 'reset_password');
    await t.client().post('/auth/password/forgot', { email });
    const second = await t.tokenFromMail(email, 'reset_password');
    expect((await t.client().post('/auth/password/reset', { token: first, password: 'a brand new long password' })).status).toBe(400);
    expect((await t.client().post('/auth/password/reset', { token: second, password: 'a brand new long password' })).status).toBe(200);
  });

  it('change requires the current password and signs out other devices only', async () => {
    const { c, email } = await t.customer();
    const other = t.client();
    await other.post('/auth/sign-in', { email, password: GOOD_PASSWORD });
    expect((await c.post('/auth/password/change', { currentPassword: 'wrong one entirely', newPassword: 'a brand new long password' })).status).toBe(401);
    expect((await c.post('/auth/password/change', { currentPassword: GOOD_PASSWORD, newPassword: 'a brand new long password' })).status).toBe(200);
    expect((await c.get('/auth/me')).status).toBe(200);
    expect((await other.get('/auth/me')).status).toBe(401);
  });
});

describe('audit trail of authentication events', () => {
  it('records failures without storing the attempted email', async () => {
    await t.client().post('/auth/sign-in', { email: 'secret.person@example.com', password: 'wrong password here' });
    const { rows } = await t.db.query(`SELECT metadata::text AS m, target_id FROM audit_logs WHERE action = 'auth.sign_in' AND outcome = 'failure'`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(`${r.m} ${r.target_id}`).not.toContain('secret.person');
    expect(ORIGIN).toBe('http://localhost:8787');
  });
});
