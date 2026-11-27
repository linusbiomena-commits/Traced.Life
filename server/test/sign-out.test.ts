import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GOOD_PASSWORD, setupTestApp, type TestEnv } from './helpers/test-app.ts';

// Sign Out regression (28 Nov 2026). The owner's Sign Out appeared to do nothing: the request was refused
// (CSRF headers dropped by the Vercel middleware, fixed in middleware.ts and covered by
// vercel-middleware.test.ts) and the portal then redirected as if it had worked. Here: for every role,
// sign-out needs the CSRF token, revokes the server-side session, clears the cookie, the old cookie cannot be
// replayed, protected data stays closed, and signing in again works.

let t: TestEnv;
beforeAll(async () => {
  t = await setupTestApp();
  t.config.pilotMfaOptional = true; // restricted-pilot mode: privileged roles use plain sign-in
});
afterAll(async () => t.close());

const ROLES = [
  { role: 'customer', protectedPath: '/me/registrations' },
  { role: 'collection_staff', protectedPath: '/staff/samples' },
  { role: 'lab_operator', protectedPath: '/lab/dashboard' },
  { role: 'admin', protectedPath: '/admin/registrations' },
  { role: 'super_admin', protectedPath: '/admin/registrations' },
  { role: 'auditor', protectedPath: '/admin/audit-logs' },
] as const;

describe('sign out, every role', () => {
  for (const { role, protectedPath } of ROLES) {
    it(`${role}: CSRF required; session revoked; cookie cleared; old cookie useless; sign in again works`, async () => {
      const acct = role === 'customer' ? await t.customer() : await t.staff([role]);
      const c = acct.c;
      expect((await c.get(protectedPath)).status, 'signed in').toBe(200);
      const oldCookie = c.cookie!;

      // Without the CSRF token (what the broken proxy produced) the server refuses and the session survives.
      const refused = await c.post('/auth/sign-out', {}, { csrf: false });
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('CSRF_REJECTED');
      expect((await c.get(protectedPath)).status, 'still signed in after a refused sign-out').toBe(200);

      // Proper sign-out.
      const res = await t.app.request('/api/v1/auth/sign-out', {
        method: 'POST', body: '{}',
        headers: { cookie: oldCookie, 'x-csrf-token': c.csrf!, origin: t.config.appOrigin, 'content-type': 'application/json' },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('set-cookie') ?? '').toMatch(/Max-Age=0/i);
      const revoked = await t.db.query(`SELECT revoked_at IS NOT NULL AS revoked, revoke_reason FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [acct.userId]);
      expect(revoked.rows[0]).toEqual({ revoked: true, revoke_reason: 'sign_out' });

      // Replaying the old cookie (e.g. Back button, copied cookie) gives nothing.
      const replay = await t.app.request(`/api/v1${protectedPath}`, { headers: { cookie: oldCookie } });
      expect(replay.status).toBe(401);
      const me = await t.app.request('/api/v1/auth/me', { headers: { cookie: oldCookie } });
      expect(me.status).toBe(401);

      // Signing in again works.
      const again = t.client();
      expect((await again.post('/auth/sign-in', { email: acct.email, password: GOOD_PASSWORD })).status).toBe(200);
      expect((await again.get(protectedPath)).status).toBe(200);
    });
  }
});
