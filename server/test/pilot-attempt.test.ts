import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestApp, type TestEnv } from './helpers/test-app.ts';

// POST /api/v1/pilot/attempt: rate limit for the restricted-pilot password (checked in middleware.ts).

let t: TestEnv;
const SECRET = 'proxy-secret-for-tests-1234567890';
beforeAll(async () => {
  t = await setupTestApp();
  t.config.trustedProxySecret = SECRET;
  t.config.trustedProxyHops = 2;
});
afterAll(async () => t.close());

const attempt = (ip: string, secret: string | null = SECRET) =>
  t.app.request('/api/v1/pilot/attempt', { method: 'POST', headers: { ...(secret ? { 'x-traced-proxy-auth': secret } : {}), 'x-forwarded-for': `${ip}, 203.0.113.250` } });

describe('pilot attempt counter', () => {
  it('only answers the Vercel middleware (proxy secret)', async () => {
    expect((await attempt('198.51.100.1', null)).status).toBe(403);
    expect((await attempt('198.51.100.1', 'wrong-secret-value-000000000000')).status).toBe(403);
    expect((await attempt('198.51.100.1')).status).toBe(204);
  });

  it('allows 10 attempts per client per 15 minutes, then 429; other clients are unaffected', async () => {
    for (let i = 0; i < 10; i++) expect((await attempt('198.51.100.20')).status).toBe(204);
    const blocked = await attempt('198.51.100.20');
    expect(blocked.status).toBe(429);
    expect((await attempt('198.51.100.21')).status).toBe(204);
  });

  it('is disabled when no proxy secret is configured', async () => {
    t.config.trustedProxySecret = undefined;
    expect((await attempt('198.51.100.30')).status).toBe(404);
    t.config.trustedProxySecret = SECRET;
  });
});
