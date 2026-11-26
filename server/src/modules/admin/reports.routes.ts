import { Hono } from 'hono';
import { z } from 'zod';
import { actorFrom, type AppEnv, type Deps } from '../../context.ts';
import { AppError } from '../../lib/errors.ts';
import { check } from '../../lib/validate.ts';
import { enforceRateLimit } from '../../middleware/rate-limit.ts';
import { requirePermission } from '../../middleware/rbac.ts';
import { audit } from '../audit/audit.service.ts';
import { riyadhToday } from '../registrations/rules.ts';
import { csv, dateParam } from './common.ts';

/**
 * Non-identifying operational export (`report.export`: admin, super admin, auditor): daily counts
 * per branch. No names, contact details, dates of birth or tracking IDs. Exports with personal
 * data (`report.export_pii`) are deferred to Phase 7 (step-up MFA, reason, limits).
 */
export function adminReportRoutes(deps: Deps) {
  const { db } = deps;
  const r = new Hono<AppEnv>();

  r.get('/reports/operational.csv', requirePermission(deps, 'report.export'), async (c) => {
    const q = check(z.strictObject({ from: dateParam.optional(), to: dateParam.optional() }), c.req.query());
    const to = q.to ?? riyadhToday();
    const from = q.from ?? `${to.slice(0, 7)}-01`;
    const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    if (!(days >= 0) || days > 366) throw new AppError(422, 'VALIDATION_FAILED', 'Choose a date range of up to one year.', { fields: [{ path: 'from', code: 'range' }] });
    await enforceRateLimit(db, { key: `admin_export:user:${c.get('session')!.userId}`, limit: 30, windowSeconds: 3600 });
    // Phase 7: aggregate each table once over the Riyadh date range (index range scans), instead
    // of one correlated count per day and branch (which scanned the tables day × branch times).
    const { rows } = await db.query(
      `WITH bounds AS (SELECT ($1::date)::timestamp AT TIME ZONE 'Asia/Riyadh' AS lo, ($2::date + 1)::timestamp AT TIME ZONE 'Asia/Riyadh' AS hi),
            d AS (SELECT generate_series($1::date, $2::date, interval '1 day')::date AS day),
            reg AS (SELECT r.branch_id, (r.created_at AT TIME ZONE 'Asia/Riyadh')::date AS day, count(*) AS n
                      FROM registrations r, bounds WHERE r.created_at >= bounds.lo AND r.created_at < bounds.hi GROUP BY 1, 2),
            col AS (SELECT s.branch_id, (s.collected_at AT TIME ZONE 'Asia/Riyadh')::date AS day, count(*) AS n
                      FROM samples s, bounds WHERE s.collected_at >= bounds.lo AND s.collected_at < bounds.hi GROUP BY 1, 2),
            can AS (SELECT r.branch_id, (r.cancelled_at AT TIME ZONE 'Asia/Riyadh')::date AS day, count(*) AS n
                      FROM registrations r, bounds WHERE r.status = 'cancelled' AND r.cancelled_at >= bounds.lo AND r.cancelled_at < bounds.hi GROUP BY 1, 2)
       SELECT to_char(d.day, 'YYYY-MM-DD') AS day, b.code, b.name_en, b.name_ar,
              COALESCE(reg.n, 0) AS registrations, COALESCE(col.n, 0) AS collections, COALESCE(can.n, 0) AS cancellations
         FROM d CROSS JOIN collection_branches b
         LEFT JOIN reg ON reg.branch_id = b.id AND reg.day = d.day
         LEFT JOIN col ON col.branch_id = b.id AND col.day = d.day
         LEFT JOIN can ON can.branch_id = b.id AND can.day = d.day
        ORDER BY d.day, b.sort_order, b.code`, [from, to]);
    await audit(db, { ...actorFrom(c), action: 'report.exported', outcome: 'success', targetType: 'report', targetId: 'operational', metadata: { from, to, rows: rows.length, personalData: false } });
    const body = csv([
      ['date_riyadh', 'branch_code', 'branch_name_en', 'branch_name_ar', 'registrations', 'collections', 'cancellations'],
      ...rows.map((x) => [x.day, x.code, x.name_en, x.name_ar, x.registrations, x.collections, x.cancellations]),
    ]);
    return c.body(body, 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="traced-operational-${from}-to-${to}.csv"`,
    });
  });

  return r;
}
