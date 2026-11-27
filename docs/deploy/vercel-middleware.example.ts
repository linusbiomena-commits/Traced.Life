// TEMPLATE (27 Nov 2026). Not deployed. Activation: copy to the repository root as `middleware.ts` on
// feature/traced-portal after the owner's approval (D-F/D-H), and test on the PREVIEW deployment first.
// Dependency-free on purpose: the Vercel project skips `npm install` (vercel.json), so this uses the
// Routing Middleware response headers directly (the same headers `rewrite()` from @vercel/functions emits).
//
// Purpose: same-origin API for the portal. Browser -> https://<site>/api/v1/* (Vercel) -> https://<api-host>/api/v1/*
// (Caddy on the Oracle VM) -> traced-api. vercel.json cannot add REQUEST headers, so this middleware
// rewrites /api/v1/* to the API and sets x-traced-proxy-auth (TRUSTED_PROXY_SECRET) so the API trusts only
// X-Forwarded-For values that came through Vercel (server/src/lib/client-ip.ts, TRUSTED_PROXY_HOPS=2).
//
// Vercel project environment variables (scope: Preview only until the production launch is approved;
// "Sensitive" type; never in Git):
//   TRACED_API_ORIGIN    https://<api-host>   (no trailing slash)
//   TRACED_PROXY_SECRET  same value as OCI Vault secret traced-proxy-secret
// Without both, /api/v1/* answers 503 and nothing is forwarded (safe default, e.g. in Production today).
//
// Verify on the preview: sign-in cookies (Secure, SameSite) survive, the CSRF header passes, a forged
// X-Forwarded-For from the browser does not change the client IP the API logs (docs/architecture.md §2a),
// and a direct request to https://<api-host>/api/v1/... without the header is not treated as proxied.

export const config = { matcher: ['/api/v1/:path*'] };

export default function middleware(request: Request): Response {
  const origin = process.env.TRACED_API_ORIGIN;
  const secret = process.env.TRACED_PROXY_SECRET;
  if (!origin || !secret) return new Response('API not configured', { status: 503 });
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/v1/internal/')) return new Response('Not found', { status: 404 });
  const target = new URL(url.pathname + url.search, origin);
  return new Response(null, {
    headers: {
      'x-middleware-rewrite': target.toString(),
      // Overwrite (never append to) whatever the client sent in x-traced-proxy-auth.
      'x-middleware-override-headers': 'x-traced-proxy-auth',
      'x-middleware-request-x-traced-proxy-auth': secret,
    },
  });
}
