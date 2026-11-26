import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { actorFrom, type AppContext, type AppEnv, type Deps } from '../../context.ts';
import { withTx, type Queryable } from '../../db/pool.ts';
import { AppError, Errors } from '../../lib/errors.ts';
import { check, emailField, parseBody } from '../../lib/validate.ts';
import { enforceRateLimit } from '../../middleware/rate-limit.ts';
import { assertMfa, requirePermission } from '../../middleware/rbac.ts';
import { createStaffAccount } from '../accounts/accounts.service.ts';
import { audit, auditSafe } from '../audit/audit.service.ts';
import { buildLink } from '../auth/links.ts';
import { revokeAllSessions } from '../auth/sessions.ts';
import { issueToken } from '../auth/tokens.ts';
import { enqueueEmail, kickOutbox } from '../mail/outbox.ts';
import { STAFF_SIDE_ROLES, type Permission, type RoleKey } from '../rbac/catalogue.ts';
import { normaliseName } from '../registrations/rules.ts';
import { assertCanManageRoles, type Authority, has, idParam, manageableRoles, reasonField, uuid } from './common.ts';

const staffRole = z.enum(['collection_staff', 'lab_operator', 'admin', 'auditor', 'super_admin']);
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** `staff.manage` (admin) or `admin.manage` (super admin). Which roles each may touch: common.ts. */
const canManageStaff = (deps: Deps): MiddlewareHandler<AppEnv> => async (c, next) => {
  const s = c.get('session');
  if (!s) throw Errors.unauthenticated();
  assertMfa(s);
  if (!has(s, 'staff.manage') && !has(s, 'admin.manage')) {
    await auditSafe(deps.db, { ...actorFrom(c), action: 'authz.denied', outcome: 'denied', targetType: 'route', targetId: `${c.req.method} ${c.req.routePath}`, metadata: { missing: ['staff.manage'] } });
    throw Errors.forbidden();
  }
  await next();
};

type Target = { id: string; email: string; locale: 'en' | 'ar'; status: string; password_hash_set: boolean; roles: RoleKey[] };

/**
 * Serialises every staff mutation and re-reads the state it decides on.
 *
 * 1. Lock every super admin's user row (id order), then the target and the actor (id order).
 *    Every mutation path takes these locks first, so concurrent changes queue up.
 * 2. Only then read roles/statuses with FRESH statements. Under READ COMMITTED each statement
 *    sees everything committed before it started, including a change committed by the
 *    transaction we just waited for. (Reading in the locking statement itself is not enough:
 *    PostgreSQL re-checks only the locked users rows, not the joined user_roles rows.)
 * 3. The actor's authority is re-derived from the database: a session loaded before the wait may
 *    belong to someone who has just been demoted or suspended.
 */
async function lockTarget(tx: Queryable, id: string, actorId: string | null, lock = true): Promise<{ target: Target; activeSuperAdmins: string[]; authority: Authority }> {
  if (lock) {
    await tx.query(`SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id AND ur.role_key = 'super_admin' ORDER BY u.id FOR UPDATE OF u`);
    await tx.query('SELECT id FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[id, actorId].filter(Boolean)]);
  }
  const supers = await tx.query<{ id: string; status: string; ready: boolean }>(
    `SELECT u.id, u.status, (u.password_hash IS NOT NULL) AS ready FROM users u
       JOIN user_roles ur ON ur.user_id = u.id AND ur.role_key = 'super_admin'`);
  const { rows } = await tx.query<Target>(
    `SELECT u.id, u.email, u.locale, u.status, (u.password_hash IS NOT NULL) AS password_hash_set,
            COALESCE(array_agg(ur.role_key) FILTER (WHERE ur.role_key IS NOT NULL), '{}') AS roles
       FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id WHERE u.id = $1 GROUP BY u.id`, [id]);
  const target = rows[0];
  if (!target || target.roles.length === 0 || target.roles.some((r) => !STAFF_SIDE_ROLES.includes(r))) throw Errors.notFound();
  const authority = actorId ? await currentAuthority(tx, actorId) : { permissions: new Set<Permission>() };
  return { target, activeSuperAdmins: supers.rows.filter((x) => x.status === 'active' && x.ready).map((x) => x.id), authority };
}

async function currentAuthority(tx: Queryable, userId: string): Promise<Authority> {
  const { rows } = await tx.query<{ perms: Permission[] }>(
    `SELECT COALESCE(array_agg(DISTINCT rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL), '{}') AS perms
       FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id LEFT JOIN role_permissions rp ON rp.role_key = ur.role_key
      WHERE u.id = $1 AND u.status = 'active' GROUP BY u.id`, [userId]);
  return { permissions: new Set(rows[0]?.perms ?? []) };
}

export function assertNotLastSuperAdmin(target: Pick<Target, 'id' | 'roles'>, activeSuperAdmins: string[], losesSuperAdmin: boolean) {
  if (!losesSuperAdmin || !target.roles.includes('super_admin')) return;
  if (activeSuperAdmins.filter((id) => id !== target.id).length === 0) {
    throw new AppError(409, 'LAST_SUPER_ADMIN', 'This is the last active super administrator. Add another super administrator first.');
  }
}

async function activeBranchIds(tx: Queryable, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const { rows } = await tx.query<{ id: string }>('SELECT id FROM collection_branches WHERE id = ANY($1::uuid[]) AND active FOR SHARE', [ids]);
  if (rows.length !== new Set(ids).size) throw new AppError(422, 'BRANCH_INACTIVE', 'Choose active collection branches only.');
}

export function adminStaffRoutes(deps: Deps) {
  const { db, config } = deps;
  const r = new Hono<AppEnv>();
  const guard = canManageStaff(deps);
  const actor = (c: AppContext) => c.get('session')!;
  const notSelf = (c: AppContext, id: string) => {
    if (id === actor(c).userId) throw new AppError(403, 'SELF_CHANGE_FORBIDDEN', 'You can’t change your own roles or status. Ask another administrator.');
  };

  const staffView = async (id: string) => {
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.full_name, u.locale, u.status, u.status_reason, u.status_changed_at, u.created_at, u.last_login_at,
              u.mfa_enabled_at, u.locked_until, u.failed_login_count, u.password_changed_at, (u.password_hash IS NOT NULL) AS ready,
              COALESCE(array_agg(DISTINCT ur.role_key) FILTER (WHERE ur.role_key IS NOT NULL), '{}') AS roles,
              (SELECT count(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS active_sessions
         FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id WHERE u.id = $1 GROUP BY u.id`, [id]);
    const u = rows[0];
    const branches = await db.query(
      `SELECT b.id, b.code, b.name_en, b.name_ar, b.city_en, b.city_ar, b.active, a.assigned_at FROM staff_branch_assignments a
         JOIN collection_branches b ON b.id = a.branch_id WHERE a.user_id = $1 AND a.revoked_at IS NULL ORDER BY b.sort_order, b.name_en`, [id]);
    return {
      id: u.id, email: u.email, fullName: u.full_name, locale: u.locale, roles: [...u.roles].sort(), status: u.status,
      statusReason: u.status_reason, statusChangedAt: iso(u.status_changed_at), invitationPending: !u.ready,
      createdAt: iso(u.created_at), lastLoginAt: iso(u.last_login_at),
      security: {
        mfaEnabled: u.mfa_enabled_at !== null, temporarilyLocked: u.locked_until !== null && u.locked_until > new Date(), lockedUntil: iso(u.locked_until),
        failedSignIns: u.failed_login_count, passwordChangedAt: iso(u.password_changed_at), activeSessions: Number(u.active_sessions),
      },
      branches: branches.rows.map((b) => ({ id: b.id, code: b.code, nameEn: b.name_en, nameAr: b.name_ar, cityEn: b.city_en, cityAr: b.city_ar, active: b.active, assignedAt: iso(b.assigned_at) })),
    };
  };

  // ---- List ------------------------------------------------------------------------------
  r.get('/staff', guard, async (c) => {
    const q = check(z.strictObject({
      role: staffRole.optional(), status: z.enum(['active', 'suspended', 'deactivated', 'pending']).optional(), branchId: uuid.optional(),
      q: z.string().trim().max(200).optional(),
    }), c.req.query());
    const where = [`EXISTS (SELECT 1 FROM user_roles x WHERE x.user_id = u.id AND x.role_key <> 'customer')`];
    const params: unknown[] = [];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (q.role) where.push(`EXISTS (SELECT 1 FROM user_roles x WHERE x.user_id = u.id AND x.role_key = ${p(q.role)})`);
    if (q.status === 'pending') where.push(`u.password_hash IS NULL AND u.status = 'active'`);
    else if (q.status) where.push(`u.status = ${p(q.status)}`);
    if (q.branchId) where.push(`EXISTS (SELECT 1 FROM staff_branch_assignments a WHERE a.user_id = u.id AND a.revoked_at IS NULL AND a.branch_id = ${p(q.branchId)})`);
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      where.push(`(u.email ILIKE ${p(like)} OR u.full_name ILIKE ${p(like)})`);
    }
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.full_name, u.status, u.last_login_at, u.mfa_enabled_at, (u.password_hash IS NOT NULL) AS ready,
              COALESCE(array_agg(DISTINCT ur.role_key) FILTER (WHERE ur.role_key IS NOT NULL), '{}') AS roles,
              COALESCE((SELECT json_agg(json_build_object('id', b.id, 'code', b.code, 'nameEn', b.name_en, 'nameAr', b.name_ar) ORDER BY b.sort_order)
                          FROM staff_branch_assignments a JOIN collection_branches b ON b.id = a.branch_id
                         WHERE a.user_id = u.id AND a.revoked_at IS NULL), '[]') AS branches
         FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id
        WHERE ${where.join(' AND ')}
        GROUP BY u.id ORDER BY u.status, u.full_name NULLS LAST, u.email LIMIT 500`, params);
    return c.json({
      items: rows.map((u) => ({
        id: u.id, email: u.email, fullName: u.full_name, roles: [...u.roles].sort(), status: u.status, invitationPending: !u.ready,
        mfaEnabled: u.mfa_enabled_at !== null, lastLoginAt: iso(u.last_login_at), branches: u.branches,
      })),
      grantableRoles: manageableRoles(actor(c)),
    });
  });

  // ---- Detail with activity ----------------------------------------------------------------
  r.get('/staff/:id', guard, async (c) => {
    const id = idParam(c);
    await lockTarget(db, id, null, false); // existence + staff-side account check
    const view = await staffView(id);
    const activity = await db.query<{ action: string; outcome: string; target_type: string | null; occurred_at: Date }>(
      `SELECT action, outcome, target_type, occurred_at FROM audit_logs WHERE actor_user_id = $1 ORDER BY chain_seq DESC LIMIT 25`, [id]);
    const s = actor(c);
    return c.json({
      staff: view,
      activity: activity.rows.map((a) => ({ action: a.action, outcome: a.outcome, targetType: a.target_type, occurredAt: iso(a.occurred_at) })),
      canManage: id !== s.userId && view.roles.every((role) => manageableRoles(s).includes(role as RoleKey)),
      grantableRoles: manageableRoles(s),
    });
  });

  // ---- Invite ------------------------------------------------------------------------------
  r.post('/staff', guard, async (c) => {
    const body = await parseBody(c, z.strictObject({
      email: emailField, fullName: z.string().trim().min(1).max(200), roles: z.array(staffRole).min(1).max(5),
      branchIds: z.array(uuid).max(50).default([]), locale: z.enum(['en', 'ar']).default('en'),
    }));
    const s = actor(c);
    assertCanManageRoles(s, body.roles);
    if (body.branchIds.length && !body.roles.includes('collection_staff')) throw new AppError(422, 'BRANCHES_NEED_COLLECTION_ROLE', 'Branches can only be assigned to collection staff.');
    await enforceRateLimit(db, { key: `admin_invite:user:${s.userId}`, limit: 30, windowSeconds: 3600 });
    const meta = actorFrom(c);
    const { userId } = await createStaffAccount(deps, {
      email: body.email, roles: body.roles, locale: body.locale, meta,
      afterCreate: async (tx, newId, setupLink) => {
        await tx.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [s.userId]);
        assertCanManageRoles(await currentAuthority(tx, s.userId), body.roles); // authority as of now, not as of sign-in
        await tx.query('UPDATE users SET full_name = $2 WHERE id = $1', [newId, normaliseName(body.fullName)]);
        await activeBranchIds(tx, body.branchIds);
        for (const b of new Set(body.branchIds)) await tx.query('INSERT INTO staff_branch_assignments (user_id, branch_id, assigned_by) VALUES ($1, $2, $3)', [newId, b, s.userId]);
        await enqueueEmail(tx, deps, { kind: 'account_setup', locale: body.locale, to: body.email, userId: newId, data: { link: setupLink } });
        await audit(tx, { ...meta, action: 'staff.invited', outcome: 'success', targetType: 'user', targetId: newId, metadata: { roles: body.roles, branchIds: body.branchIds } });
      },
    });
    void kickOutbox(deps);
    return c.json({ staff: await staffView(userId) }, 201);
  });

  r.post('/staff/:id/resend-invite', guard, async (c) => {
    const id = idParam(c);
    await parseBody(c, z.strictObject({}));
    await enforceRateLimit(db, { key: `admin_reinvite:target:${id}`, limit: 5, windowSeconds: 3600 });
    const s = actor(c);
    const meta = actorFrom(c);
    await withTx(db, async (tx) => {
      const { target, authority } = await lockTarget(tx, id, s.userId);
      assertCanManageRoles(authority, target.roles);
      if (target.password_hash_set || target.status !== 'active') throw new AppError(409, 'INVITE_NOT_PENDING', 'This account has already been set up or is not active.');
      const token = await issueToken(tx, deps, id, 'account_setup', s.userId);
      const adminSide = target.roles.some((x) => x === 'admin' || x === 'super_admin' || x === 'auditor');
      await enqueueEmail(tx, deps, { kind: 'account_setup', locale: target.locale, to: target.email, userId: id, data: { link: buildLink(config.appOrigin, adminSide ? 'admin_setup' : 'staff_setup', target.locale, token) } });
      await audit(tx, { ...meta, action: 'staff.invite_resent', outcome: 'success', targetType: 'user', targetId: id });
    });
    void kickOutbox(deps);
    return c.json({ status: 'invitation_sent' }, 202);
  });

  // ---- Roles -------------------------------------------------------------------------------
  r.put('/staff/:id/roles', guard, async (c) => {
    const id = idParam(c);
    const body = await parseBody(c, z.strictObject({ roles: z.array(staffRole).min(1).max(5), reason: reasonField }));
    const s = actor(c);
    notSelf(c, id);
    assertCanManageRoles(s, body.roles);
    await enforceRateLimit(db, { key: `admin_staff_change:user:${s.userId}`, limit: 120, windowSeconds: 3600 });
    const meta = actorFrom(c);
    await withTx(db, async (tx) => {
      const { target, activeSuperAdmins, authority } = await lockTarget(tx, id, s.userId);
      assertCanManageRoles(authority, target.roles);
      assertCanManageRoles(authority, body.roles);
      const next = [...new Set(body.roles)];
      const removed = target.roles.filter((x) => !(next as string[]).includes(x));
      const added = next.filter((x) => !(target.roles as string[]).includes(x));
      if (!removed.length && !added.length) throw new AppError(422, 'NO_CHANGES', 'Nothing was changed.');
      assertNotLastSuperAdmin(target, activeSuperAdmins, removed.includes('super_admin'));
      for (const role of removed) await tx.query('DELETE FROM user_roles WHERE user_id = $1 AND role_key = $2', [id, role]);
      for (const role of added) await tx.query('INSERT INTO user_roles (user_id, role_key, granted_by) VALUES ($1, $2, $3)', [id, role, s.userId]);
      if (removed.includes('collection_staff')) await tx.query('UPDATE staff_branch_assignments SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
      // Any change in privilege ends existing sessions: the person signs in (and passes MFA) again.
      const sessionsRevoked = await revokeAllSessions(tx, id, 'roles_changed');
      await audit(tx, { ...meta, action: 'staff.roles_changed', outcome: 'success', targetType: 'user', targetId: id, metadata: { before: [...target.roles].sort(), after: next.sort(), reason: body.reason, sessionsRevoked } });
    });
    return c.json({ staff: await staffView(id) });
  });

  // ---- Branch assignments --------------------------------------------------------------------
  r.put('/staff/:id/branches', guard, async (c) => {
    const id = idParam(c);
    const body = await parseBody(c, z.strictObject({ branchIds: z.array(uuid).max(50), reason: reasonField }));
    const s = actor(c);
    notSelf(c, id);
    await enforceRateLimit(db, { key: `admin_staff_change:user:${s.userId}`, limit: 120, windowSeconds: 3600 });
    const meta = actorFrom(c);
    await withTx(db, async (tx) => {
      const { target, authority } = await lockTarget(tx, id, s.userId);
      assertCanManageRoles(authority, target.roles);
      if (!target.roles.includes('collection_staff')) throw new AppError(422, 'BRANCHES_NEED_COLLECTION_ROLE', 'Branches can only be assigned to collection staff.');
      const wanted = [...new Set(body.branchIds)];
      const current = (await tx.query<{ branch_id: string }>('SELECT branch_id FROM staff_branch_assignments WHERE user_id = $1 AND revoked_at IS NULL', [id])).rows.map((x) => x.branch_id);
      const add = wanted.filter((b) => !current.includes(b));
      const remove = current.filter((b) => !wanted.includes(b));
      if (!add.length && !remove.length) throw new AppError(422, 'NO_CHANGES', 'Nothing was changed.');
      await activeBranchIds(tx, add);
      if (remove.length) await tx.query('UPDATE staff_branch_assignments SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND branch_id = ANY($2::uuid[])', [id, remove]);
      for (const b of add) await tx.query('INSERT INTO staff_branch_assignments (user_id, branch_id, assigned_by) VALUES ($1, $2, $3)', [id, b, s.userId]);
      await audit(tx, { ...meta, action: 'staff.branches_changed', outcome: 'success', targetType: 'user', targetId: id, metadata: { added: add, removed: remove, reason: body.reason } });
    });
    return c.json({ staff: await staffView(id) });
  });

  // ---- Status: activate / suspend / deactivate -------------------------------------------------
  r.post('/staff/:id/status', guard, async (c) => {
    const id = idParam(c);
    const body = await parseBody(c, z.strictObject({ status: z.enum(['active', 'suspended', 'deactivated']), reason: reasonField }));
    const s = actor(c);
    notSelf(c, id);
    await enforceRateLimit(db, { key: `admin_staff_change:user:${s.userId}`, limit: 120, windowSeconds: 3600 });
    const meta = actorFrom(c);
    await withTx(db, async (tx) => {
      const { target, activeSuperAdmins, authority } = await lockTarget(tx, id, s.userId);
      assertCanManageRoles(authority, target.roles);
      if (target.status === body.status) throw new AppError(409, 'STATUS_UNCHANGED', 'The account already has this status.');
      if (target.status === 'deactivated') throw new AppError(409, 'ACCOUNT_DEACTIVATED', 'Deactivated accounts can’t be reactivated. Send a new invitation instead.');
      assertNotLastSuperAdmin(target, activeSuperAdmins, body.status !== 'active');
      await tx.query(`UPDATE users SET status = $2, status_reason = $3, status_changed_at = now(), status_changed_by = $4 WHERE id = $1`, [id, body.status, body.reason.slice(0, 200), s.userId]);
      let sessionsRevoked = 0;
      if (body.status !== 'active') sessionsRevoked = await revokeAllSessions(tx, id, `status_${body.status}`);
      if (body.status === 'deactivated') {
        await tx.query('UPDATE staff_branch_assignments SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
        await tx.query(`UPDATE auth_tokens SET expires_at = LEAST(expires_at, now()) WHERE user_id = $1 AND used_at IS NULL`, [id]);
      }
      await audit(tx, { ...meta, action: `staff.${body.status === 'active' ? 'activated' : body.status}`, outcome: 'success', targetType: 'user', targetId: id, metadata: { from: target.status, reason: body.reason, sessionsRevoked } });
    });
    return c.json({ staff: await staffView(id) });
  });

  // ---- Two-step verification reset (lost authenticator) ----------------------------------------
  // Super admins only (admin.manage). Clears the authenticator secret and recovery codes and ends
  // the person's sessions; they must enrol again at the next sign-in. Never for one's own account.
  r.post('/staff/:id/mfa-reset', requirePermission(deps, 'admin.manage'), async (c) => {
    const id = idParam(c);
    const body = await parseBody(c, z.strictObject({ reason: reasonField }));
    const s = actor(c);
    notSelf(c, id);
    await enforceRateLimit(db, { key: `admin_mfa_reset:user:${s.userId}`, limit: 20, windowSeconds: 3600 });
    const meta = actorFrom(c);
    await withTx(db, async (tx) => {
      const { target, authority } = await lockTarget(tx, id, s.userId);
      if (!authority.permissions.has('admin.manage')) throw Errors.forbidden();
      const had = await tx.query<{ enrolled: boolean }>('SELECT (mfa_enabled_at IS NOT NULL) AS enrolled FROM users WHERE id = $1', [id]);
      if (!had.rows[0]!.enrolled) throw new AppError(409, 'MFA_NOT_ENROLLED', 'This account has not set up two-step verification.');
      await tx.query('UPDATE users SET mfa_totp_secret_enc = NULL, mfa_pending_secret_enc = NULL, mfa_enabled_at = NULL, mfa_last_used_step = NULL WHERE id = $1', [id]);
      await tx.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [id]);
      const sessionsRevoked = await revokeAllSessions(tx, id, 'mfa_reset');
      await audit(tx, { ...meta, action: 'staff.mfa_reset', outcome: 'success', targetType: 'user', targetId: id, metadata: { roles: target.roles, reason: body.reason, sessionsRevoked } });
    });
    return c.json({ staff: await staffView(id) });
  });

  return r;
}
