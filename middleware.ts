// Vercel Routing Middleware for TRACED (active on feature/traced-portal; restricted pilot).
// Dependency-free on purpose: the Vercel project skips `npm install` (vercel.json), so this uses the
// Routing Middleware response headers directly (the same headers `rewrite()`/`next()` from
// @vercel/functions emit).
//
// 1. Restricted-pilot gate. On the pilot host(s) only (TRACED_PILOT_HOSTS, e.g. preview.tracedmena.life),
//    every request (pages, assets, API) needs HTTP Basic credentials: user "traced" + TRACED_PILOT_PASSWORD.
//    Testers get the password separately from their invitation (never in an email link). No Vercel
//    account is needed: custom domains are outside Vercel Authentication ("all except custom domains").
//    TRACED's own sign-in, roles and MFA apply after the gate. Other hosts are not gated here
//    (*.vercel.app previews stay behind Vercel Authentication; production has no pilot hosts).
// 2. Same-origin API. /api/v1/* is rewritten to TRACED_API_ORIGIN (Caddy on the Oracle VM) with
//    x-traced-proxy-auth = TRACED_PROXY_SECRET, so the API trusts only X-Forwarded-For values that came
//    through Vercel (server/src/lib/client-ip.ts). The pilot Authorization header is not forwarded.
//
// Vercel environment variables (Preview, branch feature/traced-portal only; Sensitive; never in Git):
//   TRACED_API_ORIGIN, TRACED_PROXY_SECRET, TRACED_PILOT_HOSTS, TRACED_PILOT_PASSWORD (12+ characters)

// The edge runtime provides process.env; declared here because the build installs no @types/node.
declare const process: { env: Record<string, string | undefined> };

export const config = { matcher: ['/:path*'] };

const PILOT_USER = 'traced';
const REALM = 'TRACED restricted pilot';

function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function basicCredentialsMatch(header: string | null, password: string): boolean {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header ?? '');
  if (!m) return false;
  let decoded: string;
  try { decoded = new TextDecoder().decode(Uint8Array.from(atob(m[1]!), (ch) => ch.charCodeAt(0))); } catch { return false; }
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  return constantTimeEqual(decoded.slice(0, i), PILOT_USER) && constantTimeEqual(decoded.slice(i + 1), password);
}

export default function middleware(request: Request): Response {
  const url = new URL(request.url);
  const pilotHosts = (process.env.TRACED_PILOT_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  const isPilot = pilotHosts.includes(url.hostname.toLowerCase());

  if (isPilot) {
    const password = process.env.TRACED_PILOT_PASSWORD ?? '';
    if (password.length < 12) return new Response('Pilot access is not configured.', { status: 503, headers: { 'cache-control': 'no-store' } });
    if (!basicCredentialsMatch(request.headers.get('authorization'), password)) {
      return new Response('TRACED restricted pilot: sign in with the pilot credentials you were given.', {
        status: 401,
        headers: { 'www-authenticate': `Basic realm="${REALM}", charset="UTF-8"`, 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' },
      });
    }
  }

  if (url.pathname.startsWith('/api/v1/')) {
    const origin = process.env.TRACED_API_ORIGIN;
    const secret = process.env.TRACED_PROXY_SECRET;
    if (!origin || !secret) return new Response('API not configured', { status: 503 });
    if (url.pathname.startsWith('/api/v1/internal/')) return new Response('Not found', { status: 404 });
    const target = new URL(url.pathname + url.search, origin);
    return new Response(null, {
      headers: {
        'x-middleware-rewrite': target.toString(),
        // Set x-traced-proxy-auth (overwriting anything the client sent) and drop the pilot
        // Authorization header: listed in override-headers without a value = removed.
        'x-middleware-override-headers': 'x-traced-proxy-auth,authorization',
        'x-middleware-request-x-traced-proxy-auth': secret,
      },
    });
  }

  return new Response(null, { headers: { 'x-middleware-next': '1' } });
}
