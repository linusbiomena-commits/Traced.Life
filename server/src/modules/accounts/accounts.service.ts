import type { Deps } from '../../context.ts';
import { isUniqueViolation, withTx, type Queryable } from '../../db/pool.ts';
import { AppError } from '../../lib/errors.ts';
import { audit } from '../audit/audit.service.ts';
import { buildLink } from '../auth/links.ts';
import { revokeAllSessions } from '../auth/sessions.ts';
import { issueToken } from '../auth/tokens.ts';
import { enqueueEmail } from '../mail/outbox.ts';
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
  input: {
    email: string; roles: RoleKey[]; locale: Locale; meta: AuditMeta;
    /** Runs inside the same transaction (admin invitations: name, branches, setup email). */
    afterCreate?: (tx: Queryable, userId: string, setupLink: string) => Promise<void>;
  },
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
      const setupLink = buildLink(deps.config.appOrigin, adminSide ? 'admin_setup' : 'staff_setup', input.locale, token);
      if (input.afterCreate) await input.afterCreate(tx, userId, setupLink);
      return { userId, setupLink };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'users_email_key')) throw new AppError(409, 'EMAIL_IN_USE', 'An account with this email already exists.');
    throw err;
  }
}

/**
 * Changes an account's login email (owner-approved administrative correction, e.g. the restricted preview).
 * The account id, roles, MFA enrolment and all history (audit log, registrations, emails) are kept: they
 * refer to the id, not the address. In one transaction:
 *   - the new address must be unused; it starts UNVERIFIED (the old address's verification does not carry over);
 *   - every session is revoked and every unused emailed link (verification, reset, setup) is expired;
 *   - an audit entry is written (no addresses in metadata);
 *   - optionally, for a staff-side account that has not set a password yet, a fresh setup invitation is
 *     queued to the new address (`sendSetup`).
 * Refused when NODE_ENV=production: production changes need their own reviewed procedure.
 */
export async function changeUserEmail(
  deps: Deps,
  input: { from: string; to: string; reason: string; sendSetup?: boolean; meta: AuditMeta },
): Promise<{ userId: string; roles: RoleKey[]; sessionsRevoked: number; linksExpired: number; setupQueued: boolean }> {
  if (deps.config.env === 'production') throw new AppError(403, 'NOT_IN_PRODUCTION', 'Email changes are not available in production through this procedure.');
  const from = input.from.trim().toLowerCase();
  const to = input.to.trim().toLowerCase();
  const reason = input.reason.trim();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(to)) throw new AppError(422, 'INVALID_EMAIL', 'The new address is not a valid email address.');
  if (from === to) throw new AppError(422, 'SAME_EMAIL', 'The new address is the same as the current one.');
  if (reason.length < 10 || reason.includes('@')) throw new AppError(422, 'REASON_REQUIRED', 'Give a reason of at least 10 characters, without email addresses.');
  try {
    return await withTx(deps.db, async (tx) => {
      const { rows } = await tx.query<{ id: string; locale: Locale; status: string; password_set: boolean; roles: RoleKey[] | null }>(
        `SELECT u.id, u.locale, u.status, u.password_hash IS NOT NULL AS password_set,
                (SELECT array_agg(role_key ORDER BY role_key) FROM user_roles WHERE user_id = u.id) AS roles
           FROM users u WHERE u.email = $1 FOR UPDATE`, [from]);
      const user = rows[0];
      if (!user) throw new AppError(404, 'NOT_FOUND', 'No account uses the current address.');
      const roles = user.roles ?? [];
      await tx.query('UPDATE users SET email = $2, email_verified_at = NULL WHERE id = $1', [user.id, to]);
      const sessionsRevoked = await revokeAllSessions(tx, user.id, 'email_changed');
      const expired = await tx.query('UPDATE auth_tokens SET expires_at = LEAST(expires_at, now()) WHERE user_id = $1 AND used_at IS NULL AND expires_at > now()', [user.id]);
      await audit(tx, { ...input.meta, action: 'account.email_changed', outcome: 'success', targetType: 'user', targetId: user.id,
        metadata: { reason: reason.slice(0, 300), roles, sessionsRevoked, linksExpired: expired.rowCount ?? 0 } });
      let setupQueued = false;
      if (input.sendSetup) {
        if (!roles.some((r) => STAFF_SIDE_ROLES.includes(r))) throw new AppError(409, 'NOT_STAFF', 'Setup invitations are only for staff-side accounts.');
        if (user.password_set || user.status !== 'active') throw new AppError(409, 'INVITE_NOT_PENDING', 'This account has already been set up or is not active.');
        const token = await issueToken(tx, deps, user.id, 'account_setup', input.meta.actorUserId);
        const adminSide = roles.some((r) => r === 'admin' || r === 'super_admin' || r === 'auditor');
        await enqueueEmail(tx, deps, { kind: 'account_setup', locale: user.locale, to, userId: user.id,
          data: { link: buildLink(deps.config.appOrigin, adminSide ? 'admin_setup' : 'staff_setup', user.locale, token) } });
        await audit(tx, { ...input.meta, action: 'staff.invite_resent', outcome: 'success', targetType: 'user', targetId: user.id });
        setupQueued = true;
      }
      return { userId: user.id, roles, sessionsRevoked, linksExpired: expired.rowCount ?? 0, setupQueued };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'users_email_key')) throw new AppError(409, 'EMAIL_IN_USE', 'Another account already uses the new address.');
    throw err;
  }
}
