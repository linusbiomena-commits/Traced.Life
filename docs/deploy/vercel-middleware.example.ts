// TEMPLATE ONLY (27 Nov 2026). Not deployed. Copy to the repository root as `middleware.ts` only after
// approval, test on a PREVIEW deployment first, and add `@vercel/functions` to dependencies.
//
// Purpose: same-origin API for the portal. Browser -> https://<site>/api/v1/* (Vercel) -> https://<api-host>/api/v1/*
// (Caddy on the Oracle VM) -> traced-api. vercel.json cannot add REQUEST headers, so this Routing Middleware
// rewrites /api/v1/* to the API and adds x-traced-proxy-auth (TRUSTED_PROXY_SECRET) so the API trusts only
// X-Forwarded-For values that came through Vercel (server/src/lib/client-ip.ts, TRUSTED_PROXY_HOPS=2).
//
// Vercel project environment variables (Production + Preview, encrypted; never in Git):
//   TRACED_API_ORIGIN    e.g. https://api.example.sa   (no trailing slash)
//   TRACED_PROXY_SECRET  same value as Vault secret traced-proxy-secret
//
// Verify on the preview: cookies (Secure, SameSite) survive, CSRF header passes, a forged
// X-Forwarded-For from the browser does not change the client IP the API logs (docs/architecture.md §2a),
// and a direct request to https://<api-host>/api/v1/... without the header is not treated as proxied.
import { rewrite } from '@vercel/functions';

export const config = { matcher: ['/api/v1/:path*'] };

export default function middleware(request: Request): Response {
  const origin = process.env.TRACED_API_ORIGIN;
  const secret = process.env.TRACED_PROXY_SECRET;
  if (!origin || !secret) return new Response('API not configured', { status: 503 });
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/v1/internal/')) return new Response('Not found', { status: 404 });
  const headers = new Headers(request.headers);
  headers.set('x-traced-proxy-auth', secret); // overwrite anything the client sent
  return rewrite(new URL(url.pathname + url.search, origin), { request: { headers } });
}
