import type { Deps } from '../../context.ts';
import { isUniqueViolation, withTx } from '../../db/pool.ts';
import { AppError } from '../../lib/errors.ts';
import { audit } from '../audit/audit.service.ts';
import { buildLink } from '../auth/links.ts';
import { issueToken } from '../auth/tokens.ts';
import type { Locale } from '../mail/templates.ts';
import { STAFF_SIDE_ROLES, type RoleKey } from '../rbac/catalogue.ts';

export type AuditMeta = { actorUserId: string | null; actorRole: string | null; ip: string | null; userAgent: string | null; requestId: string | null };

/**
 * Creates a staff-side account (no public registration for these roles). The account has no
 * password until the person opens the emailed setup link. Staff accounts are kept separate from
 * customer accounts: an email already used by any account is refused.
 */
export async function createStaffAccount(
  deps: Deps,
  input: { email: string; roles: RoleKey[]; locale: Locale; meta: AuditMeta },
): Promise<{ userId: string; setupLink: string }> {
  const roles = [...new Set(input.roles)];
  if (roles.length === 0) throw new AppError(422, 'ROLE_REQUIRED', 'Choose at least one role.');
  if (roles.some((r) => !STAFF_SIDE_ROLES.includes(r))) {
    throw new AppError(422, 'INVALID_ROLE', 'Only staff-side roles can be assigned to invited accounts.');
  }
  const email = input.email.trim().toLowerCase();
  try {
    return await withTx(deps.db, async (tx) => {
      const { rows } = await tx.query<{ id: string }>('INSERT INTO users (email, locale) VALUES ($1, $2) RETURNING id', [email, input.locale]);
      const userId = rows[0]!.id;
      for (const role of roles) {
        await tx.query('INSERT INTO user_roles (user_id, role_key, granted_by) VALUES ($1, $2, $3)', [userId, role, input.meta.actorUserId]);
      }
      const token = await issueToken(tx, deps, userId, 'account_setup', input.meta.actorUserId);
      await audit(tx, { ...input.meta, action: 'account.staff_created', outcome: 'success', targetType: 'user', targetId: userId, metadata: { roles } });
      const adminSide = roles.some((r) => r === 'admin' || r === 'super_admin' || r === 'auditor');
      return { userId, setupLink: buildLink(deps.config.appOrigin, adminSide ? 'admin_setup' : 'staff_setup', input.locale, token) };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'users_email_key')) throw new AppError(409, 'EMAIL_IN_USE', 'An account with this email already exists.');
    throw err;
  }
}
