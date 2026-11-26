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
    const { rows } = await db.query(
      `WITH d AS (SELECT generate_series($1::date, $2::date, interval '1 day')::date AS day)
       SELECT to_char(d.day, 'YYYY-MM-DD') AS day, b.code, b.name_en, b.name_ar,
              (SELECT count(*) FROM registrations r WHERE r.branch_id = b.id AND (r.created_at AT TIME ZONE 'Asia/Riyadh')::date = d.day) AS registrations,
              (SELECT count(*) FROM samples s WHERE s.branch_id = b.id AND (s.collected_at AT TIME ZONE 'Asia/Riyadh')::date = d.day) AS collections,
              (SELECT count(*) FROM registrations r WHERE r.branch_id = b.id AND r.status = 'cancelled' AND (r.cancelled_at AT TIME ZONE 'Asia/Riyadh')::date = d.day) AS cancellations
         FROM d CROSS JOIN collection_branches b
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
