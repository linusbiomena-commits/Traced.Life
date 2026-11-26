import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpApp } from '../src/server.ts';
import { ORIGIN, setupTestApp, type TestEnv } from './helpers/test-app.ts';

// Phase 7 milestone 11: automated vulnerability probes (OWASP Top 10 oriented) against the real
// app and database. Complements the authorization sweep (authz-matrix.test.ts) and the existing
// per-feature tests. Findings and residual risks: docs/security/security-assessment.md.

let t: TestEnv;
let admin: Awaited<ReturnType<TestEnv['mfaStaff']>>;
let cust: Awaited<ReturnType<TestEnv['customer']>>;
beforeAll(async () => {
  t = await setupTestApp();
  admin = await t.mfaStaff(['admin']);
  cust = await t.customer();
});
afterAll(async () => t.close());

const raw = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  t.app.request(`/api/v1${path}`, { ...init, headers: { origin: ORIGIN, 'x-forwarded-for': '198.51.100.200', ...(init.headers ?? {}) } });

describe('A05 security misconfiguration: headers', () => {
  it('API responses carry strict security headers and are never cached', async () => {
    const res = await raw('/health');
    const h = Object.fromEntries(res.headers);
    expect(h['content-security-policy']).toMatch(/default-src 'none'/);
    expect(h['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['referrer-policy']).toBe('no-referrer');
    expect(h['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(h['cache-control']).toBe('no-store');
    expect(h['x-powered-by']).toBeUndefined();
  });

  it('static portal pages are served with a script-src self CSP and framing denied', async () => {
    const http = createHttpApp({ ...t.deps, config: { ...t.config, serveStatic: true } });
    const res = await http.request('/traced/account/sign-in/');
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy') ?? (await res.text()).match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] ?? '';
    expect(csp).toMatch(/script-src 'self'/);
    expect(csp).not.toMatch(/unsafe-inline[^;]*script|script-src[^;]*unsafe-eval/);
  });
});

describe('A01 broken access control / CSRF', () => {
  it('state-changing requests need the CSRF token and our Origin', async () => {
    const noToken = await raw('/me/profile', { method: 'PATCH', headers: { cookie: cust.c.cookie!, 'content-type': 'application/json' }, body: JSON.stringify({ fullName: 'X' }) });
    expect(noToken.status).toBe(403);
    const otherOrigin = await raw('/me/profile', { method: 'PATCH', headers: { cookie: cust.c.cookie!, 'x-csrf-token': cust.c.csrf!, origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ fullName: 'X' }) });
    expect(otherOrigin.status).toBe(403);
    const ok = await raw('/me/profile', { method: 'PATCH', headers: { cookie: cust.c.cookie!, 'x-csrf-token': cust.c.csrf!, 'content-type': 'application/json' }, body: JSON.stringify({ fullName: 'Probe Name' }) });
    expect(ok.status).toBe(200);
  });

  it('path traversal and encoded paths never reach files outside the site', async () => {
    const http = createHttpApp({ ...t.deps, config: { ...t.config, serveStatic: true } });
    for (const p of ['/../package.json', '/%2e%2e/package.json', '/traced/..%2f..%2fpackage.json', '/..%5c..%5cpackage.json', '/.env', '/server/src/config.ts', '/.git/config']) {
      const res = await http.request(p);
      const body = await res.text();
      expect(body, p).not.toMatch(/"dependencies"|DATABASE_URL|\[core\]|loadConfig/);
    }
  });
});

describe('A03 injection', () => {
  it('SQL metacharacters in search and filters are data, not SQL', async () => {
    for (const q of [`' OR 1=1 --`, `"; DROP TABLE users; --`, `%' UNION SELECT password_hash FROM users --`, `\\'; SELECT pg_sleep(5); --`]) {
      const s = performance.now();
      const res = await admin.c.get(`/admin/registrations?q=${encodeURIComponent(q)}`);
      expect(res.status, q).toBe(200);
      expect(res.body.items, q).toEqual([]);
      expect(performance.now() - s, q).toBeLessThan(4000);
    }
    expect((await admin.c.get(`/admin/audit-logs?action=${encodeURIComponent("x' OR '1'='1")}`)).status).toBe(422);
    expect((await admin.c.get(`/admin/registrations?status=${encodeURIComponent("cancelled' OR '1'='1")}`)).status).toBe(422);
    expect((await t.db.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBeGreaterThan(0);
  });

  it('markup in free text is refused or returned as inert JSON (the portal renders text only)', async () => {
    const res = await cust.c.patch('/me/profile', { fullName: '<img src=x onerror=alert(1)>' });
    if (res.status === 200) {
      const me = await raw('/me/profile', { headers: { cookie: cust.c.cookie! } });
      expect(me.headers.get('content-type')).toMatch(/^application\/json/);
    } else {
      expect(res.status).toBe(422);
    }
  });
});

describe('A04 insecure design / resource limits', () => {
  it('oversized bodies are refused before parsing; malformed JSON is a 4xx, never a 500 or a stack trace', async () => {
    const big = await raw('/auth/sign-in', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@b.sa', password: 'x'.repeat(40_000) }) });
    expect(big.status).toBe(413);
    for (const body of ['{', '{"email":', 'null', '[]', '"x"', '{"__proto__":{"admin":true}}']) {
      const res = await raw('/auth/sign-in', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      expect(res.status, body).toBeGreaterThanOrEqual(400);
      expect(res.status, body).toBeLessThan(500);
      const text = await res.text();
      expect(text).not.toMatch(/at \w+ \(|node_modules|\.ts:\d+/);
    }
    expect(({} as Record<string, unknown>).admin).toBeUndefined(); // no prototype pollution
  });

  it('unknown routes and methods return JSON 404 without internals', async () => {
    const res = await raw('/admin/does-not-exist');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
    expect((await raw('/health', { method: 'DELETE' })).status).toBe(404);
  });
});

describe('A07 identification and authentication', () => {
  it('session cookie is HttpOnly and SameSite; Secure when COOKIE_SECURE is on', async () => {
    const c = t.client();
    const res = await t.app.request('/api/v1/auth/sign-in', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.201' }, body: JSON.stringify({ email: cust.email, password: 'correct horse battery staple' }) });
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=(Strict|Lax)/i);
    expect(c).toBeDefined();
    t.config.cookieSecure = true;
    try {
      const sec = await t.app.request('/api/v1/auth/sign-in', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.202' }, body: JSON.stringify({ email: cust.email, password: 'correct horse battery staple' }) });
      expect(sec.headers.get('set-cookie') ?? '').toMatch(/Secure/);
    } finally {
      t.config.cookieSecure = false;
    }
  });

  it('sign-in does not reveal whether an account exists and is rate limited', async () => {
    const c = t.client('198.51.100.203');
    const unknown = await c.post('/auth/sign-in', { email: 'nobody.here@example.com', password: 'wrong password here' });
    const wrong = await c.post('/auth/sign-in', { email: cust.email, password: 'wrong password here' });
    expect(unknown.status).toBe(wrong.status);
    expect(unknown.body.error.code).toBe(wrong.body.error.code);
    let limited = false;
    for (let i = 0; i < 30 && !limited; i++) limited = (await c.post('/auth/sign-in', { email: cust.email, password: `wrong ${i} password` })).status === 429;
    expect(limited).toBe(true);
  });
});
