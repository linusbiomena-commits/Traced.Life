import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppContext, Deps, SessionInfo } from '../../context.ts';
import type { Queryable } from '../../db/pool.ts';
import { hmac, randomToken } from '../../lib/crypto.ts';
import type { Permission, RoleKey } from '../rbac/catalogue.ts';

/** Customers stay signed in longer; staff and admins get short, idle-sensitive sessions. */
export const SESSION_POLICY = {
  customer: { absoluteSeconds: 7 * 24 * 3600, idleSeconds: 24 * 3600 },
  privileged: { absoluteSeconds: 12 * 3600, idleSeconds: 30 * 60 },
} as const;

export function cookieName(secure: boolean): string {
  // __Host- forces Secure, Path=/ and no Domain, so subdomains cannot plant or read it.
  return secure ? '__Host-traced_sid' : 'traced_sid';
}

export function readSessionCookie(c: AppContext, deps: Deps): string | null {
  return getCookie(c, cookieName(deps.config.cookieSecure)) ?? null;
}

export function writeSessionCookie(c: AppContext, deps: Deps, token: string, maxAgeSeconds: number): void {
  setCookie(c, cookieName(deps.config.cookieSecure), token, {
    httpOnly: true,
    secure: deps.config.cookieSecure,
    sameSite: 'Strict',
    path: '/',
    maxAge: maxAgeSeconds,
  });
}

export function clearSessionCookie(c: AppContext, deps: Deps): void {
  deleteCookie(c, cookieName(deps.config.cookieSecure), { path: '/', secure: deps.config.cookieSecure });
}

export function tokenHash(deps: Deps, token: string): Buffer {
  return hmac(deps.config.tokenHmacKey, `session:${token}`);
}

/** CSRF token derived from the session token: stable for the session, useless without the HttpOnly cookie. */
export function csrfTokenFor(deps: Deps, sessionToken: string): string {
  return hmac(deps.config.tokenHmacKey, `csrf:${sessionToken}`).toString('base64url');
}

export function policyFor(roles: readonly RoleKey[]) {
  return roles.some((r) => r !== 'customer') ? SESSION_POLICY.privileged : SESSION_POLICY.customer;
}

export async function createSession(
  db: Queryable,
  deps: Deps,
  input: { userId: string; roles: readonly RoleKey[]; mfaVerified: boolean; ip: string | null; userAgent: string | null },
): Promise<{ token: string; sessionId: string; maxAgeSeconds: number }> {
  const token = randomToken(32);
  const policy = policyFor(input.roles);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO sessions (token_hash, user_id, expires_at, idle_timeout_seconds, mfa_verified_at, ip, user_agent)
     VALUES ($1, $2, now() + make_interval(secs => $3), $4, CASE WHEN $5 THEN now() END, $6, $7)
     RETURNING id`,
    [tokenHash(deps, token), input.userId, policy.absoluteSeconds, policy.idleSeconds, input.mfaVerified, input.ip, input.userAgent?.slice(0, 512) ?? null],
  );
  return { token, sessionId: rows[0]!.id, maxAgeSeconds: policy.absoluteSeconds };
}

type SessionRow = {
  session_id: string;
  user_id: string;
  email: string;
  email_verified_at: Date | null;
  locale: 'en' | 'ar';
  mfa_enabled_at: Date | null;
  mfa_verified_at: Date | null;
  last_seen_at: Date;
  roles: RoleKey[];
  permissions: Permission[];
  requires_mfa: boolean;
};

/** Loads a live session (not revoked, not expired, not idle, user active) with roles and permissions. */
export async function loadSession(db: Queryable, deps: Deps, token: string): Promise<SessionInfo | null> {
  const { rows } = await db.query<SessionRow>(
    `SELECT s.id AS session_id, u.id AS user_id, u.email, u.email_verified_at, u.locale, u.mfa_enabled_at,
            s.mfa_verified_at, s.last_seen_at,
            COALESCE(array_agg(DISTINCT ur.role_key) FILTER (WHERE ur.role_key IS NOT NULL), '{}') AS roles,
            COALESCE(array_agg(DISTINCT rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL), '{}') AS permissions,
            COALESCE(bool_or(r.requires_mfa), false) AS requires_mfa
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.key = ur.role_key
       LEFT JOIN role_permissions rp ON rp.role_key = ur.role_key
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND s.last_seen_at + make_interval(secs => s.idle_timeout_seconds) > now()
        AND u.status = 'active'
      GROUP BY s.id, u.id`,
    [tokenHash(deps, token)],
  );
  const row = rows[0];
  if (!row) return null;

  // Sliding idle window; throttled to one write per minute per session.
  if (Date.now() - row.last_seen_at.getTime() > 60_000) {
    await db.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.session_id]);
  }

  return {
    sessionId: row.session_id,
    userId: row.user_id,
    email: row.email,
    emailVerified: row.email_verified_at !== null,
    locale: row.locale,
    roles: row.roles,
    permissions: new Set(row.permissions),
    // Restricted pilot only: PILOT_MFA_OPTIONAL (refused in production) lets privileged roles skip two-step verification.
    requiresMfa: row.requires_mfa && !deps.config.pilotMfaOptional,
    mfaEnrolled: row.mfa_enabled_at !== null,
    mfaVerified: row.mfa_verified_at !== null,
  };
}

export async function revokeSession(db: Queryable, sessionId: string, reason: string): Promise<void> {
  await db.query('UPDATE sessions SET revoked_at = now(), revoke_reason = $2 WHERE id = $1 AND revoked_at IS NULL', [sessionId, reason]);
}

export async function revokeAllSessions(db: Queryable, userId: string, reason: string, exceptSessionId?: string): Promise<number> {
  const r = await db.query(
    `UPDATE sessions SET revoked_at = now(), revoke_reason = $2
      WHERE user_id = $1 AND revoked_at IS NULL AND ($3::uuid IS NULL OR id <> $3::uuid)`,
    [userId, reason, exceptSessionId ?? null],
  );
  return r.rowCount ?? 0;
}

/**
 * Replaces the current session with a new token (after sign-in step-up such as MFA), so a token
 * captured before the privilege change is useless. Returns the new token's CSRF value.
 */
export async function rotateSession(
  c: AppContext,
  db: Queryable,
  deps: Deps,
  session: SessionInfo,
  opts: { mfaVerified: boolean },
): Promise<string> {
  await revokeSession(db, session.sessionId, 'rotated');
  const created = await createSession(db, deps, {
    userId: session.userId,
    roles: session.roles,
    mfaVerified: opts.mfaVerified,
    ip: c.get('ip'),
    userAgent: c.get('userAgent'),
  });
  writeSessionCookie(c, deps, created.token, created.maxAgeSeconds);
  c.set('sessionToken', created.token);
  return csrfTokenFor(deps, created.token);
}
