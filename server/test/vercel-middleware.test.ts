import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import middleware, { isGatedPath } from '../../middleware.ts';

// The Vercel Routing Middleware (repository root): path-based restricted-pilot gate on every host +
// same-origin API rewrite.

const ENV = { TRACED_API_ORIGIN: 'https://api.tracedmena.life', TRACED_PROXY_SECRET: 'proxy-secret-value-123456', TRACED_PILOT_PASSWORD: 'pilot-password-1234' };
let saved: Record<string, string | undefined>;
beforeEach(() => { saved = { ...process.env }; Object.assign(process.env, ENV); });
afterEach(() => { for (const k of Object.keys(ENV)) delete process.env[k]; Object.assign(process.env, saved); });

const basic = (user: string, pw: string) => `Basic ${Buffer.from(`${user}:${pw}`).toString('base64')}`;
const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });
const HOSTS = ['https://www.tracedmena.life', 'https://tracedmena.life', 'https://tracedlife.vercel.app', 'https://tracedlife-abc123-linus-bio-mena.vercel.app'];
const PORTAL = ['/traced/admin/accept-invite/', '/traced/account/sign-in/', '/traced/staff/scan/', '/traced/lab/', '/traced/c/', '/traced/s/', '/ar/traced/admin/', '/portal/js/core/api.js', '/api/v1/auth/me', '/traced/account'];

describe('pilot gate (every host, by path)', () => {
  it('asks for credentials on every portal path on every host, with no-store', () => {
    for (const h of HOSTS) for (const p of PORTAL) {
      const r = middleware(req(h + p));
      expect(r.status, h + p).toBe(401);
      expect(r.headers.get('www-authenticate')).toContain('Basic realm="TRACED restricted pilot"');
      expect(r.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('cannot be bypassed with encodings, repeated slashes, backslashes or case', () => {
    for (const p of ['/traced/%61ccount/sign-in/', '/traced/%2561ccount/', '//traced/admin/', '/traced//staff/', '/TRACED/ADMIN/', '/ar/traced/LAB/', '/%70ortal/js/x.js', '/traced\\admin\\', '/api/v1%2Fauth/me', '/traced/%E0%A4%A/']) {
      expect(isGatedPath(p), p).toBe(true);
    }
  });

  it('leaves the public marketing site open', () => {
    for (const p of ['/', '/traced/', '/ar/traced/', '/traced/pages/faqs/', '/traced/blogs/press/', '/traced/products/test/', '/traced-account-nav.css', '/media/x.jpg', '/traced/policies/privacy-policy/']) {
      expect(isGatedPath(p), p).toBe(false);
      expect(middleware(req(`https://www.tracedmena.life${p}`)).headers.get('x-middleware-next'), p).toBe('1');
    }
  });

  it('refuses wrong user or password; accepts the pilot credentials', () => {
    const u = 'https://www.tracedmena.life/traced/admin/';
    expect(middleware(req(u, { authorization: basic('traced', 'wrong-password-123') })).status).toBe(401);
    expect(middleware(req(u, { authorization: basic('admin', ENV.TRACED_PILOT_PASSWORD) })).status).toBe(401);
    expect(middleware(req(u, { authorization: 'Bearer x' })).status).toBe(401);
    const ok = middleware(req(u, { authorization: basic('traced', ENV.TRACED_PILOT_PASSWORD) }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-middleware-next')).toBe('1');
  });

  it('fails closed when the pilot password is missing or too short', () => {
    delete process.env.TRACED_PILOT_PASSWORD;
    expect(middleware(req('https://www.tracedmena.life/traced/admin/')).status).toBe(503);
    process.env.TRACED_PILOT_PASSWORD = 'short';
    expect(middleware(req('https://www.tracedmena.life/api/v1/health', { authorization: basic('traced', 'short') })).status).toBe(503);
    expect(middleware(req('https://www.tracedmena.life/traced/')).headers.get('x-middleware-next')).toBe('1'); // public stays up
  });
});

describe('API rewrite', () => {
  const auth = { authorization: basic('traced', ENV.TRACED_PILOT_PASSWORD) };
  it('rewrites /api/v1 to the API with the proxy secret and drops the pilot Authorization header', () => {
    const r = middleware(req('https://www.tracedmena.life/api/v1/auth/me?x=1', { ...auth, 'x-traced-proxy-auth': 'forged' }));
    expect(r.headers.get('x-middleware-rewrite')).toBe('https://api.tracedmena.life/api/v1/auth/me?x=1');
    expect(r.headers.get('x-middleware-override-headers')).toBe('x-traced-proxy-auth,authorization');
    expect(r.headers.get('x-middleware-request-x-traced-proxy-auth')).toBe(ENV.TRACED_PROXY_SECRET);
    expect(r.headers.get('x-middleware-request-authorization')).toBeNull();
  });

  it('blocks internal routes and answers 503 when the API is not configured', () => {
    expect(middleware(req('https://www.tracedmena.life/api/v1/internal/outbox/run', auth)).status).toBe(404);
    delete process.env.TRACED_PROXY_SECRET;
    expect(middleware(req('https://www.tracedmena.life/api/v1/health', auth)).status).toBe(503);
  });
});
