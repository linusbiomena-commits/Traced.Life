// Vercel Routing Middleware for TRACED: restricted-pilot gate + same-origin API.
// Dependency-free on purpose (the Vercel project skips `npm install`): it uses the Routing Middleware
// response headers directly (the same headers `rewrite()`/`next()` from @vercel/functions emit).
//
// 1. Restricted-pilot gate, by PATH on EVERY host (www.tracedmena.life, tracedmena.life,
//    tracedlife.vercel.app, deployment URLs). Gated: the operational portal pages
//    (/traced|/ar/traced + account, staff, admin, lab, c, s), the portal assets (/portal/) and the API
//    (/api/v1/). Without a valid pilot cookie, pages redirect (303) to the branded TRACED pilot access
//    page (/traced/pilot-access/ or /ar/traced/pilot-access/) with ?next=<original path>; the browser
//    keeps the original #fragment, so invitation/verification/reset tokens survive. API calls answer 401.
//    The access page posts the pilot password to POST /api/pilot/access (handled here): every attempt is
//    first counted by the API's rate limiter (10 per client per 15 minutes); on success a signed
//    HttpOnly cookie (__Host-traced_pilot, Secure, SameSite=Lax, 12 h, bound to the host) is set.
//    The password is only in the Vercel environment; it never reaches the browser or the API.
//    TRACED's own sign-in, roles and MFA apply after the gate. Public marketing pages are never gated.
// 2. Same-origin API: /api/v1/* is rewritten to TRACED_API_ORIGIN with all original request headers,
//    x-traced-proxy-auth = TRACED_PROXY_SECRET (server/src/lib/client-ip.ts); the pilot cookie and any
//    Authorization header are not forwarded.
// 3. Launch switch: the gate is ON unless BOTH TRACED_PILOT_GATE=off and TRACED_LAUNCH_APPROVED=yes are set
//    (two deliberate switches, after final release approval). With the gate off, the portals and API are
//    reached directly and the access page forwards to the requested page.
//
// Vercel environment (Sensitive; never in Git): TRACED_API_ORIGIN, TRACED_PROXY_SECRET,
// TRACED_PILOT_PASSWORD (12+ characters, gate on), TRACED_PILOT_GATE, TRACED_LAUNCH_APPROVED.

// The edge runtime provides process.env; declared here because the build installs no @types/node.
declare const process: { env: Record<string, string | undefined> };

export const config = { matcher: ['/:path*'] };

export const PILOT_COOKIE = '__Host-traced_pilot';
const COOKIE_TTL_SECONDS = 12 * 3600;
const GATED = [/^\/(ar\/)?traced\/(account|staff|admin|lab|c|s)(\/|$)/, /^\/portal(\/|$)/, /^\/api\/v1(\/|$)/];
const ACCESS_PAGE = { en: '/traced/pilot-access/', ar: '/ar/traced/pilot-access/' };
const enc = new TextEncoder();

/** Normalised like the file server would (percent-decoding, repeated slashes, case) so encodings cannot bypass the gate. */
export function isGatedPath(pathname: string): boolean {
  let p = pathname;
  for (let i = 0; i < 3; i++) { try { const d = decodeURIComponent(p); if (d === p) break; p = d; } catch { return true; } }
  p = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase();
  return GATED.some((re) => re.test(p));
}

export function gateEnabled(): boolean {
  return !(process.env.TRACED_PILOT_GATE === 'off' && process.env.TRACED_LAUNCH_APPROVED === 'yes');
}

function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

const b64url = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Cookie signature: HMAC-SHA256 keyed by the pilot password, so changing the password ends all pilot sessions. */
async function sign(password: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(`traced-pilot-cookie-v1|${password}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(payload)));
}

export async function makePilotCookieValue(password: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const payload = `v1.${nowSeconds + COOKIE_TTL_SECONDS}`;
  return `${payload}.${await sign(password, payload)}`;
}

async function validPilotCookie(cookieHeader: string | null, password: string): Promise<boolean> {
  const m = new RegExp(`(?:^|;\\s*)${PILOT_COOKIE}=([A-Za-z0-9._-]{1,200})`).exec(cookieHeader ?? '');
  if (!m) return false;
  const parts = m[1]!.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  const exp = Number(parts[1]);
  if (!Number.isInteger(exp) || exp <= Math.floor(Date.now() / 1000) || exp > Math.floor(Date.now() / 1000) + COOKIE_TTL_SECONDS + 60) return false;
  return constantTimeEqual(parts[2]!, await sign(password, `v1.${exp}`));
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow', ...headers } });
const err = (status: number, code: string, message: string, headers: Record<string, string> = {}) => json(status, { error: { code, message } }, headers);

/** POST /api/pilot/access {password}: rate-limited by the API, then compared here; sets the pilot cookie. */
async function pilotAccess(request: Request, url: URL): Promise<Response> {
  if (!gateEnabled()) return err(404, 'NOT_FOUND', 'Not found.');
  if (request.method !== 'POST') return err(405, 'METHOD_NOT_ALLOWED', 'Use POST.', { allow: 'POST' });
  const origin = request.headers.get('origin');
  if (origin !== url.origin) return err(403, 'CSRF', 'Request blocked.');
  const password = process.env.TRACED_PILOT_PASSWORD ?? '';
  const apiOrigin = process.env.TRACED_API_ORIGIN;
  const proxySecret = process.env.TRACED_PROXY_SECRET;
  if (password.length < 12 || !apiOrigin || !proxySecret) return err(503, 'PILOT_NOT_CONFIGURED', 'Pilot access is not configured.');
  let supplied = '';
  try {
    const raw = await request.text();
    if (raw.length > 1024) return err(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
    const body = JSON.parse(raw) as { password?: unknown };
    supplied = typeof body.password === 'string' ? body.password : '';
  } catch { return err(400, 'INVALID_JSON', 'Request body must be valid JSON.'); }
  // Count the attempt first (per real client IP, through the trusted proxy chain). Fail closed.
  let limited: Response;
  try {
    limited = await fetch(new URL('/api/v1/pilot/attempt', apiOrigin), {
      method: 'POST',
      headers: { 'x-traced-proxy-auth': proxySecret, 'x-forwarded-for': request.headers.get('x-forwarded-for') ?? '' },
    });
  } catch { return err(503, 'PILOT_UNAVAILABLE', 'Pilot access is temporarily unavailable.'); }
  if (limited.status === 429) return err(429, 'TOO_MANY_ATTEMPTS', 'Too many attempts. Try again later.', { 'retry-after': limited.headers.get('retry-after') ?? '900' });
  if (limited.status !== 204) return err(503, 'PILOT_UNAVAILABLE', 'Pilot access is temporarily unavailable.');
  if (!supplied || !constantTimeEqual(supplied, password)) return err(401, 'INVALID_PILOT_PASSWORD', 'The pilot access password is not correct.');
  const value = await makePilotCookieValue(password);
  return new Response(null, {
    status: 204,
    headers: { 'set-cookie': `${PILOT_COOKIE}=${value}; Path=/; Max-Age=${COOKIE_TTL_SECONDS}; Secure; HttpOnly; SameSite=Lax`, 'cache-control': 'no-store' },
  });
}

/**
 * Rewrites /api/v1 to the API. Vercel's x-middleware-override-headers is the COMPLETE list of request headers
 * to forward (any header not listed is dropped), so every original header is re-listed with its value,
 * then: x-traced-proxy-auth is set (overwriting anything the client sent), the pilot cookie is removed from
 * Cookie, and Authorization is dropped. (Fix 28 Nov 2026: listing only the changed headers dropped Origin,
 * X-CSRF-Token and Content-Type, so every signed-in write failed the CSRF check.)
 */
const NOT_FORWARDED = new Set(['host', 'connection', 'content-length', 'authorization', 'cookie', 'x-traced-proxy-auth']);
export function apiRewrite(request: Request, url: URL): Response {
  const origin = process.env.TRACED_API_ORIGIN;
  const secret = process.env.TRACED_PROXY_SECRET;
  if (!origin || !secret) return err(503, 'API_NOT_CONFIGURED', 'API not configured.');
  if (url.pathname.startsWith('/api/v1/internal/')) return new Response('Not found', { status: 404 });
  const headers: Record<string, string> = { 'x-middleware-rewrite': new URL(url.pathname + url.search, origin).toString() };
  const names: string[] = [];
  request.headers.forEach((value, name) => {
    const n = name.toLowerCase();
    if (NOT_FORWARDED.has(n) || n.startsWith('x-middleware-')) return;
    names.push(n);
    headers[`x-middleware-request-${n}`] = value;
  });
  names.push('x-traced-proxy-auth');
  headers['x-middleware-request-x-traced-proxy-auth'] = secret;
  const cookie = (request.headers.get('cookie') ?? '').split(/;\s*/).filter((c) => c && !c.startsWith(`${PILOT_COOKIE}=`)).join('; ');
  if (cookie) { names.push('cookie'); headers['x-middleware-request-cookie'] = cookie; }
  headers['x-middleware-override-headers'] = names.join(',');
  return new Response(null, { headers });
}

export default async function middleware(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/api/pilot/access') return pilotAccess(request, url);

  if (gateEnabled() && isGatedPath(url.pathname)) {
    const password = process.env.TRACED_PILOT_PASSWORD ?? '';
    if (password.length < 12) return err(503, 'PILOT_NOT_CONFIGURED', 'Pilot access is not configured.');
    if (!(await validPilotCookie(request.headers.get('cookie'), password))) {
      const isApi = /^\/api\//i.test(url.pathname);
      const isPage = !isApi && (request.method === 'GET' || request.method === 'HEAD') && !/^\/portal(\/|$)/i.test(url.pathname);
      if (!isPage) return err(401, 'PILOT_ACCESS_REQUIRED', 'Restricted pilot: pilot access is required.');
      const page = /^\/ar\//i.test(url.pathname) ? ACCESS_PAGE.ar : ACCESS_PAGE.en;
      // Relative Location without a fragment: the browser carries the original #token over.
      return new Response(null, { status: 303, headers: { location: `${page}?next=${encodeURIComponent(url.pathname + url.search)}`, 'cache-control': 'no-store' } });
    }
  }

  if (url.pathname.startsWith('/api/v1/')) return apiRewrite(request, url);
  return new Response(null, { headers: { 'x-middleware-next': '1' } });
}
