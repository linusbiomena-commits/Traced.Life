import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import middleware, { PILOT_COOKIE, gateEnabled, isGatedPath, makePilotCookieValue } from '../../middleware.ts';

// The Vercel Routing Middleware (repository root): branded restricted-pilot gate (signed HttpOnly cookie,
// rate-limited password check) on every host + same-origin API rewrite + launch switch.

const PW = 'pilot-password-1234';
const ENV = { TRACED_API_ORIGIN: 'https://api.tracedmena.life', TRACED_PROXY_SECRET: 'proxy-secret-value-123456', TRACED_PILOT_PASSWORD: PW };
const KEYS = [...Object.keys(ENV), 'TRACED_PILOT_GATE', 'TRACED_LAUNCH_APPROVED'];
let saved: Record<string, string | undefined>;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  saved = { ...process.env };
  Object.assign(process.env, ENV);
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { for (const k of KEYS) delete process.env[k]; Object.assign(process.env, saved); vi.unstubAllGlobals(); });

const WWW = 'https://www.tracedmena.life';
const HOSTS = [WWW, 'https://tracedmena.life', 'https://tracedlife.vercel.app', 'https://tracedlife-abc123-linus-bio-mena.vercel.app'];
const PAGES = ['/traced/admin/accept-invite/', '/traced/account/sign-in/', '/traced/staff/scan/', '/traced/lab/', '/traced/c/', '/traced/s/', '/traced/account'];
const get = (url: string, headers: Record<string, string> = {}) => middleware(new Request(url, { headers }));
const cookieFor = async (pw = PW) => `${PILOT_COOKIE}=${await makePilotCookieValue(pw)}`;
const access = (body: unknown, headers: Record<string, string> = { origin: WWW }) =>
  middleware(new Request(`${WWW}/api/pilot/access`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.7', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }));

describe('gate without a pilot cookie', () => {
  it('redirects portal pages on every host to the branded access page, keeping the original path (fragment kept by the browser)', async () => {
    for (const h of HOSTS) for (const p of PAGES) {
      const r = await get(`${h}${p}?x=1`);
      expect(r.status, h + p).toBe(303);
      expect(r.headers.get('location')).toBe(`/traced/pilot-access/?next=${encodeURIComponent(`${p}?x=1`)}`);
      expect(r.headers.get('location')).not.toContain('#');
      expect(r.headers.get('cache-control')).toBe('no-store');
    }
    expect((await get(`${WWW}/ar/traced/admin/accept-invite/`)).headers.get('location')).toBe(`/ar/traced/pilot-access/?next=${encodeURIComponent('/ar/traced/admin/accept-invite/')}`);
  });

  it('answers 401 JSON for the API and portal assets (no redirect); no browser pop-up header', async () => {
    for (const p of ['/api/v1/auth/me', '/portal/js/core/api.js']) {
      const r = await get(`${WWW}${p}`);
      expect(r.status).toBe(401);
      expect(r.headers.get('www-authenticate')).toBeNull();
      if (p.startsWith('/api')) expect((await r.json()).error.code).toBe('PILOT_ACCESS_REQUIRED');
    }
  });

  it('cannot be bypassed with encodings, slashes, backslashes or case', () => {
    for (const p of ['/traced/%61ccount/sign-in/', '/traced/%2561ccount/', '//traced/admin/', '/traced//staff/', '/TRACED/ADMIN/', '/ar/traced/LAB/', '/%70ortal/js/x.js', '/traced\\admin\\', '/api/v1%2Fauth/me', '/traced/%E0%A4%A/']) {
      expect(isGatedPath(p), p).toBe(true);
    }
  });

  it('leaves the public site and the access page open', async () => {
    for (const p of ['/', '/traced/', '/ar/traced/', '/traced/pages/faqs/', '/traced/pilot-access/', '/ar/traced/pilot-access/', '/traced-pilot.css', '/traced-pilot.js', '/media/x.woff2']) {
      expect(isGatedPath(p), p).toBe(false);
      expect((await get(`${WWW}${p}`)).headers.get('x-middleware-next'), p).toBe('1');
    }
  });

  it('rejects forged, expired, tampered or wrong-password cookies', async () => {
    const u = `${WWW}/traced/admin/`;
    expect((await get(u, { cookie: `${PILOT_COOKIE}=v1.9999999999.forged` })).status).toBe(303);
    expect((await get(u, { cookie: `${PILOT_COOKIE}=${await makePilotCookieValue(PW, 1000)}` })).status).toBe(303); // expired
    const good = await makePilotCookieValue(PW);
    const [v, exp, sig] = good.split('.');
    expect((await get(u, { cookie: `${PILOT_COOKIE}=${v}.${Number(exp) + 100}.${sig}` })).status).toBe(303); // tampered expiry
    expect((await get(u, { cookie: await cookieFor('another-password-99') })).status).toBe(303); // old password
  });

  it('fails closed (503) when the pilot password is missing or short; the public site stays up', async () => {
    delete process.env.TRACED_PILOT_PASSWORD;
    expect((await get(`${WWW}/traced/admin/`)).status).toBe(503);
    process.env.TRACED_PILOT_PASSWORD = 'short';
    expect((await get(`${WWW}/api/v1/health`)).status).toBe(503);
    expect((await get(`${WWW}/traced/`)).headers.get('x-middleware-next')).toBe('1');
  });
});

describe('POST /api/pilot/access', () => {
  it('counts the attempt with the API first, then sets a signed Secure HttpOnly host cookie', async () => {
    const r = await access({ password: PW });
    expect(r.status).toBe(204);
    const c = r.headers.get('set-cookie')!;
    expect(c).toMatch(new RegExp(`^${PILOT_COOKIE}=v1\\.\\d+\\.[A-Za-z0-9_-]+; Path=/; Max-Age=43200; Secure; HttpOnly; SameSite=Lax$`));
    expect(c).not.toContain(PW);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://api.tracedmena.life/api/v1/pilot/attempt');
    expect(init.headers['x-traced-proxy-auth']).toBe(ENV.TRACED_PROXY_SECRET);
    expect(init.headers['x-forwarded-for']).toBe('198.51.100.7');
    expect(JSON.stringify(init)).not.toContain(PW); // the API never sees the password
    // The cookie then opens the gate.
    const ok = await get(`${WWW}/traced/admin/accept-invite/`, { cookie: c.split(';')[0]! });
    expect(ok.headers.get('x-middleware-next')).toBe('1');
  });

  it('wrong password: 401, no cookie; rate limited: 429; API down: 503 (fail closed)', async () => {
    const wrong = await access({ password: 'not-the-password' });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('set-cookie')).toBeNull();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'retry-after': '600' } }));
    const limited = await access({ password: PW }); // even the right password is refused while limited
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('600');
    expect(limited.headers.get('set-cookie')).toBeNull();
    fetchMock.mockRejectedValueOnce(new Error('down'));
    expect((await access({ password: PW })).status).toBe(503);
  });

  it('refuses cross-site posts, GET, bad JSON and oversized bodies', async () => {
    expect((await access({ password: PW }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await access({ password: PW }, {})).status).toBe(403);
    expect((await middleware(new Request(`${WWW}/api/pilot/access`))).status).toBe(405);
    expect((await access('{not json')).status).toBe(400);
    expect((await access({ password: 'x'.repeat(2000) })).status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('API rewrite (with pilot cookie)', () => {
  it('rewrites /api/v1 with the proxy secret, strips the pilot cookie, keeps the TRACED session cookie', async () => {
    const pilot = await cookieFor();
    const r = await get(`${WWW}/api/v1/auth/me?x=1`, { cookie: `${pilot}; traced_session=abc`, 'x-traced-proxy-auth': 'forged' });
    expect(r.headers.get('x-middleware-rewrite')).toBe('https://api.tracedmena.life/api/v1/auth/me?x=1');
    expect(r.headers.get('x-middleware-override-headers')).toBe('x-traced-proxy-auth,cookie,authorization');
    expect(r.headers.get('x-middleware-request-x-traced-proxy-auth')).toBe(ENV.TRACED_PROXY_SECRET);
    expect(r.headers.get('x-middleware-request-cookie')).toBe('traced_session=abc');
  });

  it('blocks internal routes', async () => {
    expect((await get(`${WWW}/api/v1/internal/outbox/run`, { cookie: await cookieFor() })).status).toBe(404);
  });
});

describe('launch switch', () => {
  it('stays ON unless BOTH TRACED_PILOT_GATE=off and TRACED_LAUNCH_APPROVED=yes', async () => {
    process.env.TRACED_PILOT_GATE = 'off';
    expect(gateEnabled()).toBe(true);
    expect((await get(`${WWW}/traced/admin/`)).status).toBe(303);
    process.env.TRACED_LAUNCH_APPROVED = 'yes';
    expect(gateEnabled()).toBe(false);
    expect((await get(`${WWW}/traced/admin/accept-invite/`)).headers.get('x-middleware-next')).toBe('1');
    expect((await get(`${WWW}/api/v1/auth/me`)).headers.get('x-middleware-rewrite')).toBe('https://api.tracedmena.life/api/v1/auth/me');
    expect((await access({ password: PW })).status).toBe(404); // access page then just forwards
  });
});
