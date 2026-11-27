import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import middleware from '../../middleware.ts';

// The Vercel Routing Middleware (repository root): restricted-pilot gate + same-origin API rewrite.

const ENV = { TRACED_API_ORIGIN: 'https://api.tracedmena.life', TRACED_PROXY_SECRET: 'proxy-secret-value-123456', TRACED_PILOT_HOSTS: 'preview.tracedmena.life', TRACED_PILOT_PASSWORD: 'pilot-password-1234' };
let saved: Record<string, string | undefined>;
beforeEach(() => { saved = { ...process.env }; Object.assign(process.env, ENV); });
afterEach(() => { for (const k of Object.keys(ENV)) delete process.env[k]; Object.assign(process.env, saved); });

const basic = (user: string, pw: string) => `Basic ${Buffer.from(`${user}:${pw}`).toString('base64')}`;
const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });

describe('pilot gate', () => {
  it('asks for credentials on the pilot host (pages and API), with no-store and noindex', () => {
    for (const path of ['/traced/admin/accept-invite/', '/api/v1/auth/me', '/traced-account-nav.css']) {
      const r = middleware(req(`https://preview.tracedmena.life${path}`));
      expect(r.status).toBe(401);
      expect(r.headers.get('www-authenticate')).toContain('Basic realm="TRACED restricted pilot"');
      expect(r.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('refuses wrong user or password; accepts the pilot credentials', () => {
    expect(middleware(req('https://preview.tracedmena.life/traced/', { authorization: basic('traced', 'wrong-password-123') })).status).toBe(401);
    expect(middleware(req('https://preview.tracedmena.life/traced/', { authorization: basic('admin', ENV.TRACED_PILOT_PASSWORD) })).status).toBe(401);
    expect(middleware(req('https://preview.tracedmena.life/traced/', { authorization: 'Bearer x' })).status).toBe(401);
    const ok = middleware(req('https://Preview.TracedMena.life/traced/', { authorization: basic('traced', ENV.TRACED_PILOT_PASSWORD) }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-middleware-next')).toBe('1');
  });

  it('fails closed when the pilot password is missing or too short', () => {
    process.env.TRACED_PILOT_PASSWORD = 'short';
    expect(middleware(req('https://preview.tracedmena.life/traced/', { authorization: basic('traced', 'short') })).status).toBe(503);
  });

  it('does not gate other hosts (vercel.app previews keep Vercel Authentication; production has no pilot host)', () => {
    expect(middleware(req('https://tracedlife.vercel.app/traced/')).headers.get('x-middleware-next')).toBe('1');
  });
});

describe('API rewrite', () => {
  it('rewrites /api/v1 to the API with the proxy secret and drops the pilot Authorization header', () => {
    const r = middleware(req('https://preview.tracedmena.life/api/v1/auth/me?x=1', { authorization: basic('traced', ENV.TRACED_PILOT_PASSWORD), 'x-traced-proxy-auth': 'forged' }));
    expect(r.headers.get('x-middleware-rewrite')).toBe('https://api.tracedmena.life/api/v1/auth/me?x=1');
    expect(r.headers.get('x-middleware-override-headers')).toBe('x-traced-proxy-auth,authorization');
    expect(r.headers.get('x-middleware-request-x-traced-proxy-auth')).toBe(ENV.TRACED_PROXY_SECRET);
    expect(r.headers.get('x-middleware-request-authorization')).toBeNull();
  });

  it('blocks internal routes and answers 503 when the API is not configured', () => {
    const auth = { authorization: basic('traced', ENV.TRACED_PILOT_PASSWORD) };
    expect(middleware(req('https://preview.tracedmena.life/api/v1/internal/outbox/run', auth)).status).toBe(404);
    delete process.env.TRACED_PROXY_SECRET;
    expect(middleware(req('https://tracedlife.vercel.app/api/v1/health')).status).toBe(503);
  });
});
