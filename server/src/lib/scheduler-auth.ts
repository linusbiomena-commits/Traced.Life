import { createPublicKey, verify as verifySignature, type JsonWebKey } from 'node:crypto';
import type { Config } from '../config.ts';
import { safeEqual } from './crypto.ts';

/**
 * Authorises Cloud Scheduler calls to /api/v1/internal/*. Two accepted credentials:
 *
 * 1. `Authorization: Bearer <INTERNAL_CRON_SECRET>` (shared secret; simplest, rotate manually).
 * 2. `Authorization: Bearer <Google-signed OIDC ID token>` when SCHEDULER_OIDC_AUDIENCE is set:
 *    RS256, issuer accounts.google.com, audience = SCHEDULER_OIDC_AUDIENCE, email =
 *    SCHEDULER_OIDC_SERVICE_ACCOUNT and email_verified, not expired (60 s leeway). Keys come
 *    from Google's JWKS endpoint, cached for an hour. Recommended for production because no
 *    long-lived secret exists (see docs/deploy/scheduler.md).
 *
 * Returns which credential matched, or null.
 */
export type JwksFetcher = () => Promise<{ keys: (JsonWebKey & { kid?: string })[] }>;

const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

let cache: { at: number; keys: (JsonWebKey & { kid?: string })[] } | null = null;
const defaultFetcher: JwksFetcher = async () => {
  const res = await fetch(GOOGLE_JWKS, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`JWKS ${res.status}`);
  return (await res.json()) as { keys: (JsonWebKey & { kid?: string })[] };
};

export function resetJwksCache() {
  cache = null;
}

const b64url = (s: string) => Buffer.from(s, 'base64url');

export async function verifyGoogleIdToken(token: string, opts: { audience: string; email: string; fetchJwks?: JwksFetcher; now?: number }): Promise<boolean> {
  const parts = token.split('.');
  if (parts.length !== 3 || token.length > 4096) return false;
  let header: { alg?: string; kid?: string };
  let claims: { iss?: string; aud?: string; email?: string; email_verified?: boolean; exp?: number; iat?: number };
  try {
    header = JSON.parse(b64url(parts[0]!).toString('utf8'));
    claims = JSON.parse(b64url(parts[1]!).toString('utf8'));
  } catch {
    return false;
  }
  if (header.alg !== 'RS256' || !header.kid) return false;
  const fetchJwks = opts.fetchJwks ?? defaultFetcher;
  const now = opts.now ?? Date.now();
  if (!cache || now - cache.at > 3_600_000 || !cache.keys.some((k) => k.kid === header.kid)) {
    try {
      cache = { at: now, keys: (await fetchJwks()).keys };
    } catch {
      return false;
    }
  }
  const jwk = cache.keys.find((k) => k.kid === header.kid);
  if (!jwk) return false;
  let ok = false;
  try {
    ok = verifySignature('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), b64url(parts[2]!));
  } catch {
    return false;
  }
  if (!ok) return false;
  const nowS = Math.floor(now / 1000);
  return ISSUERS.has(claims.iss ?? '') && claims.aud === opts.audience && claims.email === opts.email && claims.email_verified === true
    && typeof claims.exp === 'number' && claims.exp + 60 >= nowS && (claims.iat ?? 0) - 60 <= nowS;
}

export async function authorizeScheduler(authorization: string | undefined, config: Config, fetchJwks?: JwksFetcher): Promise<'secret' | 'oidc' | null> {
  const sent = authorization?.replace(/^Bearer\s+/i, '') ?? '';
  if (!sent) return null;
  if (config.internalCronSecret && safeEqual(sent, config.internalCronSecret)) return 'secret';
  if (config.schedulerOidcAudience && config.schedulerOidcServiceAccount && sent.split('.').length === 3) {
    const ok = await verifyGoogleIdToken(sent, { audience: config.schedulerOidcAudience, email: config.schedulerOidcServiceAccount, fetchJwks });
    if (ok) return 'oidc';
  }
  return null;
}

export function schedulerEnabled(config: Config): boolean {
  return Boolean(config.internalCronSecret || (config.schedulerOidcAudience && config.schedulerOidcServiceAccount));
}
