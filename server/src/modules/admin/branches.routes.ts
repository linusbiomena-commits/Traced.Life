import { Hono } from 'hono';
import { z } from 'zod';
import { actorFrom, type AppEnv, type Deps } from '../../context.ts';
import { isUniqueViolation, withTx } from '../../db/pool.ts';
import { AppError, Errors } from '../../lib/errors.ts';
import { parseBody } from '../../lib/validate.ts';
import { enforceRateLimit } from '../../middleware/rate-limit.ts';
import { requirePermission } from '../../middleware/rbac.ts';
import { audit } from '../audit/audit.service.ts';
import { idParam, reasonField } from './common.ts';

const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const branchFields = {
  nameEn: text(1, 200), nameAr: text(1, 200), cityEn: text(1, 100), cityAr: text(1, 100),
  addressEn: text(0, 500).default(''), addressAr: text(0, 500).default(''), sortOrder: z.number().int().min(0).max(10_000).default(0),
};
const COLS: Record<string, string> = { nameEn: 'name_en', nameAr: 'name_ar', cityEn: 'city_en', cityAr: 'city_ar', addressEn: 'address_en', addressAr: 'address_ar', sortOrder: 'sort_order' };
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/**
 * Collection branches (`branch.manage`). Branches are never deleted (registrations, samples and
 * staff history reference them); deactivation hides them from new registrations and blocks
 * collection there. Pending registrations must be transferred, so deactivating a branch that
 * still has them requires an explicit acknowledgement.
 */
export function adminBranchRoutes(deps: Deps) {
  const { db } = deps;
  const r = new Hono<AppEnv>();
  const manage = requirePermission(deps, 'branch.manage');

  const view = async (id?: string) => {
    const { rows } = await db.query(
      `SELECT b.*, (SELECT count(*) FROM registrations r WHERE r.branch_id = b.id) AS registrations,
              (SELECT count(*) FROM registrations r WHERE r.branch_id = b.id AND r.status IN ('registration_completed', 'awaiting_sample_collection')) AS pending,
              (SELECT count(*) FROM samples s WHERE s.branch_id = b.id AND s.status <> 'rejected') AS collected,
              (SELECT count(*) FROM samples s WHERE s.branch_id = b.id AND date_trunc('month', s.collected_at AT TIME ZONE 'Asia/Riyadh') = date_trunc('month', now() AT TIME ZONE 'Asia/Riyadh')) AS collected_month,
              COALESCE((SELECT json_agg(json_build_object('id', u.id, 'email', u.email, 'fullName', u.full_name, 'status', u.status) ORDER BY u.full_name)
                          FROM staff_branch_assignments a JOIN users u ON u.id = a.user_id WHERE a.branch_id = b.id AND a.revoked_at IS NULL), '[]') AS staff
         FROM collection_branches b ${id ? 'WHERE b.id = $1' : ''} ORDER BY b.active DESC, b.sort_order, b.name_en`, id ? [id] : []);
    return rows.map((b) => ({
      id: b.id, code: b.code, nameEn: b.name_en, nameAr: b.name_ar, cityEn: b.city_en, cityAr: b.city_ar, addressEn: b.address_en, addressAr: b.address_ar,
      active: b.active, sortOrder: b.sort_order, createdAt: iso(b.created_at), updatedAt: iso(b.updated_at),
      stats: { registrations: Number(b.registrations), pending: Number(b.pending), collected: Number(b.collected), collectedThisMonth: Number(b.collected_month) },
      staff: b.staff,
    }));
  };

  r.get('/branches', manage, async (c) => c.json({ items: await view() }));

  r.post('/branches', manage, async (c) => {
    const body = await parseBody(c, z.strictObject({ code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,32}$/), ...branchFields }));
    await enforceRateLimit(db, { key: `admin_branch:user:${c.get('session')!.userId}`, limit: 60, windowSeconds: 3600 });
    try {
      const id = await withTx(db, async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO collection_branches (code, name_en, name_ar, city_en, city_ar, address_en, address_ar, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [body.code, body.nameEn, body.nameAr, body.cityEn, body.cityAr, body.addressEn, body.addressAr, body.sortOrder]);
        await audit(tx, { ...actorFrom(c), action: 'branch.created', outcome: 'success', targetType: 'branch', targetId: rows[0]!.id, metadata: { code: body.code } });
        return rows[0]!.id;
      });
      return c.json({ branch: (await view(id))[0] }, 201);
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(409, 'BRANCH_CODE_IN_USE', 'A branch with this code already exists.');
      throw err;
    }
  });

  // The code is a permanent reference (CLI, reports), so it can't be edited.
  r.patch('/branches/:id', manage, async (c) => {
    const id = idParam(c);
    const body = await parseBody(c, z.strictObject({
      nameEn: branchFields.nameEn.optional(), nameAr: branchFields.nameAr.optional(), cityEn: branchFields.cityEn.optional(), cityAr: branchFields.cityAr.optional(),
      addressEn: text(0, 500).optional(), addressAr: text(0, 500).optional(), sortOrder: z.number().int().min(0).max(10_000).optional(),
    }).refine((b) => Object.keys(b).length > 0, { message: 'NO_CHANGES' }));
    await enforceRateLimit(db, { key: `admin_branch:user:${c.get('session')!.userId}`, limit: 60, windowSeconds: 3600 });
    await withTx(db, async (tx) => {
      const before = (await tx.query('SELECT * FROM collection_branches WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!before) throw Errors.notFound();
      const sets: string[] = [];
      const params: unknown[] = [id];
      const changed: string[] = [];
      for (const [k, v] of Object.entries(body)) {
        if (v === undefined || before[COLS[k]!] === v) continue;
        params.push(v);
        sets.push(`${COLS[k]} = $${params.length}`);
        changed.push(k);
      }
      if (!changed.length) throw new AppError(422, 'NO_CHANGES', 'Nothing was changed.');
      await tx.query(`UPDATE collection_branches SET ${sets.join(', ')} WHERE id = $1`, params);
      await audit(tx, { ...actorFrom(c), action: 'branch.updated', outcome: 'success', targetType: 'branch', targetId: id, metadata: { changed } });
    });
    return c.json({ branch: (await view(id))[0] });
  });

  r.post('/branches/:id/status', manage, async (c) => {
    const id = idParam(c);
    const body = await parseBody(c, z.strictObject({ active: z.boolean(), reason: reasonField, acknowledgePending: z.boolean().default(false) }));
    await enforceRateLimit(db, { key: `admin_branch:user:${c.get('session')!.userId}`, limit: 60, windowSeconds: 3600 });
    const result = await withTx(db, async (tx) => {
      const b = (await tx.query<{ active: boolean; code: string }>('SELECT active, code FROM collection_branches WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!b) throw Errors.notFound();
      if (b.active === body.active) throw new AppError(409, 'STATUS_UNCHANGED', 'The branch already has this status.');
      const pending = Number((await tx.query<{ n: string }>(
        `SELECT count(*) AS n FROM registrations WHERE branch_id = $1 AND status IN ('registration_completed', 'awaiting_sample_collection')`, [id])).rows[0]!.n);
      if (!body.active && pending > 0 && !body.acknowledgePending) {
        throw new AppError(409, 'BRANCH_HAS_PENDING', 'This branch still has registrations awaiting collection. Transfer them, or confirm that you understand they can’t be collected here.', { pending });
      }
      if (!body.active) {
        // Close open collection sessions at this branch; collection re-checks the branch is active.
        await tx.query('UPDATE collection_sessions SET expires_at = now() WHERE branch_id = $1 AND completed_at IS NULL AND expires_at > now()', [id]);
      }
      await tx.query('UPDATE collection_branches SET active = $2 WHERE id = $1', [id, body.active]);
      await audit(tx, { ...actorFrom(c), action: body.active ? 'branch.activated' : 'branch.deactivated', outcome: 'success', targetType: 'branch', targetId: id, metadata: { code: b.code, reason: body.reason, pendingRegistrations: pending } });
      return { pending };
    });
    return c.json({ branch: (await view(id))[0], pendingRegistrations: result.pending });
  });

  return r;
}
