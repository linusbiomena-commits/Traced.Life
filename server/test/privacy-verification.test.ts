import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaffAccount } from '../src/modules/accounts/accounts.service.ts';
import { riyadhToday } from '../src/modules/registrations/rules.ts';
import { GOOD_PASSWORD, setupTestApp, type TestEnv } from './helpers/test-app.ts';

let t: TestEnv;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(async () => {
  await t.close();
});

describe('collection staff never receive customer personal data (every API route)', () => {
  it('sweeps all registered routes as collection staff with a real customer registration in the database', async () => {
    // A customer with distinctive personal data ("canaries") and a registration.
    const cust = await t.customer('canary.customer@example.com');
    const form = (await cust.c.get('/me/registration-form')).body;
    const [y, m, d] = riyadhToday().split('-');
    const dob = `${Number(y) - 9}-${m}-${String(Math.min(Number(d), 28)).padStart(2, '0')}`;
    const reg = await cust.c.post(
      '/me/registrations',
      {
        relationship: 'child',
        patient: { firstName: 'Canaryfirst', lastName: 'Canarylast', dateOfBirth: dob, gender: 'female' },
        contact: { fullName: 'Canaryguardian Person', phone: '0559998877' },
        branchId: form.branches[0].id,
        consentDocumentIds: form.consents.map((c: { id: string }) => c.id),
      },
      { headers: { 'idempotency-key': randomUUID() } },
    );
    expect(reg.status).toBe(201);
    const regId = reg.body.registration.id as string;
    const canaries = ['Canaryfirst', 'Canarylast', 'Canaryguardian', 'canary.customer@example.com', '559998877', dob, cust.userId];

    const staff = await t.staff(['collection_staff']);
    const routes = t.app.routes
      .filter((r) => r.method !== 'ALL' && r.path.startsWith('/api/v1/'))
      .map((r) => ({ method: r.method, path: r.path.replace('/api/v1', '').replace(':id', regId) }));
    expect(routes.length).toBeGreaterThanOrEqual(20);

    // Endpoints that act only on the caller's own account are allowed to succeed.
    const selfService = new Set(['GET /auth/me', 'GET /me/profile', 'GET /health', 'POST /auth/mfa/setup', 'POST /auth/verify-email/resend', 'GET /staff/me', 'GET /staff/history', 'GET /staff/samples']); // own-branch lists; still canary-checked
    for (const { method, path } of routes) {
      if (path === '/auth/sign-out') continue; // would end the staff session mid-sweep
      const res = await staff.c.request(method, path, method === 'GET' ? undefined : {});
      const body = JSON.stringify(res.body ?? '');
      for (const canary of canaries) expect(body, `${method} ${path} leaked ${canary}`).not.toContain(canary);
      if (!selfService.has(`${method} ${path}`)) {
        expect([400, 401, 403, 404, 409, 422, 429], `${method} ${path} -> ${res.status}`).toContain(res.status);
      }
    }
  });
});

describe('invitation (account setup) tokens', () => {
  const cli = { actorUserId: null, actorRole: 'system_cli', ip: null, userAgent: null, requestId: null };

  it('are stored only as a keyed hash', async () => {
    const { userId, setupLink } = await createStaffAccount(t.deps, { email: 'hash.check@example.com', roles: ['collection_staff'], locale: 'en', meta: cli });
    const token = setupLink.split('#token=')[1]!;
    const { rows } = await t.db.query<{ token_hash: Buffer; expires_in: number }>(
      `SELECT token_hash, EXTRACT(EPOCH FROM (expires_at - created_at))::int AS expires_in FROM auth_tokens WHERE user_id = $1 AND purpose = 'account_setup'`,
      [userId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toHaveLength(32);
    expect(rows[0]!.token_hash.toString('hex')).not.toContain(Buffer.from(token).toString('hex'));
    expect(rows[0]!.token_hash.toString('base64url')).not.toBe(token);
    expect(rows[0]!.expires_in).toBe(72 * 3600);
  });

  it('expire after 72 hours', async () => {
    const { userId, setupLink } = await createStaffAccount(t.deps, { email: 'expiry.check@example.com', roles: ['admin'], locale: 'en', meta: cli });
    await t.db.query(`UPDATE auth_tokens SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [userId]);
    const res = await t.client().post('/auth/account-setup', { token: setupLink.split('#token=')[1], password: GOOD_PASSWORD });
    expect(res.body.error.code).toBe('INVALID_OR_EXPIRED_TOKEN');
  });

  it('are single-use, even under concurrent use', async () => {
    const { setupLink } = await createStaffAccount(t.deps, { email: 'race.check@example.com', roles: ['collection_staff'], locale: 'en', meta: cli });
    const token = setupLink.split('#token=')[1];
    const results = await Promise.all(Array.from({ length: 5 }, () => t.client().post('/auth/account-setup', { token, password: GOOD_PASSWORD })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it('cannot be used as a password-reset or verification token', async () => {
    const { setupLink } = await createStaffAccount(t.deps, { email: 'purpose.check@example.com', roles: ['collection_staff'], locale: 'en', meta: cli });
    const token = setupLink.split('#token=')[1];
    expect((await t.client().post('/auth/password/reset', { token, password: GOOD_PASSWORD })).status).toBe(400);
    expect((await t.client().post('/auth/verify-email', { token })).status).toBe(400);
  });
});
