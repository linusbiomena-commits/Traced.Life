import type { MiddlewareHandler } from 'hono';
import { actorFrom, type AppEnv, type Deps, type SessionInfo } from '../context.ts';
import { Errors } from '../lib/errors.ts';
import { auditSafe } from '../modules/audit/audit.service.ts';
import type { Permission } from '../modules/rbac/catalogue.ts';

/** 401 unless signed in. */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('session')) throw Errors.unauthenticated();
  await next();
};

/** 403 unless the account's email is verified. */
export const requireVerifiedEmail: MiddlewareHandler<AppEnv> = async (c, next) => {
  const s = c.get('session');
  if (!s) throw Errors.unauthenticated();
  if (!s.emailVerified) throw Errors.emailNotVerified();
  await next();
};

/** MFA gate for privileged roles: enrolled and verified in this session. */
export function assertMfa(s: SessionInfo): void {
  if (!s.requiresMfa) return;
  if (!s.mfaEnrolled) throw Errors.mfaSetupRequired();
  if (!s.mfaVerified) throw Errors.mfaRequired();
}

/**
 * Requires every listed permission. Enforced server-side on every protected route; the UI may
 * hide controls but is never the control. Denials are audited.
 */
export function requirePermission(deps: Deps, ...required: Permission[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const s = c.get('session');
    if (!s) throw Errors.unauthenticated();
    assertMfa(s);
    const missing = required.filter((p) => !s.permissions.has(p));
    if (missing.length > 0) {
      await auditSafe(deps.db, {
        ...actorFrom(c),
        action: 'authz.denied',
        outcome: 'denied',
        targetType: 'route',
        targetId: `${c.req.method} ${c.req.routePath}`,
        metadata: { missing },
      });
      throw Errors.forbidden();
    }
    await next();
  };
}
