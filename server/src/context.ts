import type { Context } from 'hono';
import type { Config } from './config.ts';
import type { Pool } from './db/pool.ts';
import type { Mailer } from './modules/mail/mailer.ts';
import type { Permission, RoleKey } from './modules/rbac/catalogue.ts';

export type Deps = {
  config: Config;
  db: Pool;
  mailer: Mailer;
};

/** The signed-in user as loaded for one request. */
export type SessionInfo = {
  sessionId: string;
  userId: string;
  email: string;
  emailVerified: boolean;
  locale: 'en' | 'ar';
  roles: RoleKey[];
  permissions: ReadonlySet<Permission>;
  requiresMfa: boolean;
  mfaEnrolled: boolean;
  mfaVerified: boolean;
};

export type AppEnv = {
  Variables: {
    requestId: string;
    ip: string | null;
    userAgent: string | null;
    session: SessionInfo | null;
    sessionToken: string | null;
  };
};

export type AppContext = Context<AppEnv>;

/** Actor fields for audit entries, taken from the request. */
export function actorFrom(c: AppContext) {
  const s = c.get('session');
  return {
    actorUserId: s?.userId ?? null,
    actorRole: s ? primaryRole(s.roles) : null,
    ip: c.get('ip'),
    userAgent: c.get('userAgent'),
    requestId: c.get('requestId'),
  };
}

const ROLE_ORDER: RoleKey[] = ['super_admin', 'admin', 'auditor', 'lab_operator', 'collection_staff', 'customer'];

export function primaryRole(roles: readonly RoleKey[]): RoleKey | null {
  return ROLE_ORDER.find((r) => roles.includes(r)) ?? null;
}
