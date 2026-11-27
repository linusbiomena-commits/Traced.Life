import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv, Deps } from '../context.ts';
import { PROXY_AUTH_HEADER, resolveClientIp } from '../lib/client-ip.ts';
import { safeEqual } from '../lib/crypto.ts';
import { AppError, Errors } from '../lib/errors.ts';
import { log } from '../lib/logger.ts';
import { csrfTokenFor, loadSession, readSessionCookie } from '../modules/auth/sessions.ts';


/** Request id, client IP and user agent for audit and logging. */
export function requestContext(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set('requestId', randomUUID());
    const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
    const { trustedProxyHops, trustedProxyCidrs, trustedProxySecret } = deps.config;
    c.set(
      'ip',
      resolveClientIp(
        { forwardedFor: c.req.header('x-forwarded-for'), peer: incoming?.socket?.remoteAddress ?? null, proxyAuth: c.req.header(PROXY_AUTH_HEADER) },
        { hops: trustedProxyHops, trustedPeers: trustedProxyCidrs, proxySecret: trustedProxySecret },
      ),
    );
    c.set('userAgent', c.req.header('user-agent')?.slice(0, 512) ?? null);
    c.set('session', null);
    c.set('sessionToken', null);
    await next();
    c.header('X-Request-Id', c.get('requestId'));
  };
}

/** Loads the session from the cookie, if any. Never fails the request by itself. */
export function sessionLoader(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = readSessionCookie(c, deps);
    if (token && token.length <= 128) {
      const session = await loadSession(deps.db, deps, token);
      if (session) {
        c.set('session', session);
        c.set('sessionToken', token);
      }
    }
    await next();
  };
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF defence for state-changing requests:
 *  1. Origin (when sent) must be our own origin; cross-site browser requests carry a foreign Origin.
 *  2. Bodies must be JSON, which cross-site HTML forms cannot send without a CORS preflight.
 *  3. If a session cookie is present, X-CSRF-Token must match the session's CSRF token.
 * The session cookie is also SameSite=Strict.
 */
export function csrfProtection(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!UNSAFE.has(c.req.method)) return next();

    const origin = c.req.header('origin');
    // Security log for rejected requests: reason and shapes only (cookie NAMES, header presence/length),
    // never cookie values, tokens or personal data.
    const reject = (reason: string) => {
      const cookieHeader = c.req.header('cookie') ?? '';
      log.warn('csrf rejected', {
        requestId: c.get('requestId'), path: c.req.path, reason,
        originMatches: origin === deps.config.appOrigin, originPresent: origin !== undefined,
        csrfHeaderLength: (c.req.header('x-csrf-token') ?? '').length,
        cookieNames: cookieHeader.split(/;\s*/).filter(Boolean).map((p) => p.split('=')[0]).slice(0, 10),
        sessionCookies: (cookieHeader.match(/(?:^|;\s*)(?:__Host-)?traced_sid=/g) ?? []).length,
      });
      return Errors.csrf();
    };
    if (origin !== undefined && origin !== deps.config.appOrigin) throw reject('origin');
    if (origin === undefined && c.req.header('sec-fetch-site') === 'cross-site') throw reject('cross_site');

    // Cross-site forms and no-cors fetches always carry a non-JSON Content-Type.
    const contentType = c.req.header('content-type');
    if (contentType !== undefined && !contentType.toLowerCase().startsWith('application/json')) {
      throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Request body must be JSON.');
    }

    // Only a live session gives a cookie any power, so only then is the token required. (A stale
    // cookie must not block signing in again.) Runs after sessionLoader.
    const liveToken = c.get('sessionToken');
    if (liveToken) {
      const sent = c.req.header('x-csrf-token') ?? '';
      if (!safeEqual(sent, csrfTokenFor(deps, liveToken))) throw reject('token');
    }
    await next();
  };
}
