import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Deps } from '../../context.ts';
import { AppError } from '../../lib/errors.ts';
import { check } from '../../lib/validate.ts';
import { requirePermission } from '../../middleware/rbac.ts';
import { riyadhToday } from '../registrations/rules.ts';
import { dateParam, has } from './common.ts';

const n = (v: unknown) => Number(v ?? 0);

/**
 * Dashboard statistics (`stats.read`: admin, super admin, auditor). Aggregates only: no names,
 * emails or other personal data, so auditors can use it. Days and months are Asia/Riyadh.
 * The activity feed needs `audit.read` as well and shows event types and roles only.
 */
export function adminStatsRoutes(deps: Deps) {
  const { db } = deps;
  const r = new Hono<AppEnv>();

  r.get('/stats', requirePermission(deps, 'stats.read'), async (c) => {
    const q = check(z.strictObject({ from: dateParam.optional(), to: dateParam.optional() }), c.req.query());
    const today = riyadhToday();
    const to = q.to ?? today;
    const from = q.from ?? `${today.slice(0, 7)}-01`;
    if (from > to) throw new AppError(422, 'VALIDATION_FAILED', 'The start date must be before the end date.', { fields: [{ path: 'from', code: 'range' }] });

    const totals = (await db.query(
      `SELECT
         (SELECT count(*) FROM users u WHERE EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role_key = 'customer')) AS customers,
         (SELECT count(*) FROM registrations) AS registrations,
         (SELECT count(*) FROM registrations WHERE status IN ('registration_completed', 'awaiting_sample_collection')) AS awaiting,
         (SELECT count(*) FROM samples WHERE status <> 'rejected') AS collected,
         (SELECT count(DISTINCT u.id) FROM users u JOIN user_roles ur ON ur.user_id = u.id AND ur.role_key = 'collection_staff'
           WHERE u.status = 'active' AND u.password_hash IS NOT NULL) AS active_staff,
         (SELECT count(*) FROM collection_branches WHERE active) AS active_branches,
         (SELECT count(*) FROM email_outbox WHERE status = 'failed') AS email_failures,
         (SELECT count(*) FROM registrations WHERE (created_at AT TIME ZONE 'Asia/Riyadh')::date = $1::date) AS reg_today,
         (SELECT count(*) FROM samples WHERE (collected_at AT TIME ZONE 'Asia/Riyadh')::date = $1::date) AS col_today,
         (SELECT count(*) FROM registrations WHERE date_trunc('month', created_at AT TIME ZONE 'Asia/Riyadh') = date_trunc('month', $1::date)) AS reg_month,
         (SELECT count(*) FROM samples WHERE date_trunc('month', collected_at AT TIME ZONE 'Asia/Riyadh') = date_trunc('month', $1::date)) AS col_month,
         (SELECT count(*) FROM registrations WHERE (created_at AT TIME ZONE 'Asia/Riyadh')::date BETWEEN $2::date AND $3::date) AS reg_range,
         (SELECT count(*) FROM samples WHERE (collected_at AT TIME ZONE 'Asia/Riyadh')::date BETWEEN $2::date AND $3::date) AS col_range`,
      [today, from, to],
    )).rows[0]!;

    const statuses = await db.query<{ status: string; count: string }>(
      'SELECT status, count(*) FROM registrations GROUP BY status ORDER BY count(*) DESC, status');

    const branches = await db.query(
      `SELECT b.id, b.code, b.name_en, b.name_ar, b.city_en, b.city_ar, b.active,
              (SELECT count(*) FROM registrations r WHERE r.branch_id = b.id) AS registrations,
              (SELECT count(*) FROM registrations r WHERE r.branch_id = b.id AND r.status IN ('registration_completed', 'awaiting_sample_collection')) AS awaiting,
              (SELECT count(*) FROM samples s WHERE s.branch_id = b.id AND s.status <> 'rejected') AS collected,
              (SELECT count(*) FROM samples s WHERE s.branch_id = b.id AND (s.collected_at AT TIME ZONE 'Asia/Riyadh')::date BETWEEN $1::date AND $2::date) AS collected_in_range
         FROM collection_branches b ORDER BY b.active DESC, b.sort_order, b.name_en`,
      [from, to],
    );

    const s = c.get('session')!;
    const activity = has(s, 'audit.read')
      ? (await db.query<{ action: string; outcome: string; actor_role: string | null; target_type: string | null; occurred_at: Date }>(
          `SELECT action, outcome, actor_role, target_type, occurred_at FROM audit_logs
            WHERE actor_role IS NOT NULL AND actor_role <> 'customer'
            ORDER BY chain_seq DESC LIMIT 10`)).rows.map((a) => ({ action: a.action, outcome: a.outcome, actorRole: a.actor_role, targetType: a.target_type, occurredAt: a.occurred_at.toISOString() }))
      : null;

    return c.json({
      generatedAt: new Date().toISOString(),
      today, range: { from, to },
      totals: {
        customers: n(totals.customers), registrations: n(totals.registrations), awaitingCollection: n(totals.awaiting),
        samplesCollected: n(totals.collected), activeStaff: n(totals.active_staff), activeBranches: n(totals.active_branches), emailFailures: n(totals.email_failures),
      },
      todayCounts: { registrations: n(totals.reg_today), collections: n(totals.col_today) },
      monthCounts: { registrations: n(totals.reg_month), collections: n(totals.col_month) },
      rangeCounts: { registrations: n(totals.reg_range), collections: n(totals.col_range) },
      statusDistribution: statuses.rows.map((x) => ({ status: x.status, count: n(x.count) })),
      byBranch: branches.rows.map((b) => ({
        id: b.id, code: b.code, nameEn: b.name_en, nameAr: b.name_ar, cityEn: b.city_en, cityAr: b.city_ar, active: b.active,
        registrations: n(b.registrations), awaiting: n(b.awaiting), collected: n(b.collected), collectedInRange: n(b.collected_in_range),
      })),
      recentActivity: activity,
    });
  });

  return r;
}
