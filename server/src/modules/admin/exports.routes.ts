import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { actorFrom, type AppEnv, type Deps } from '../../context.ts';
import { AppError, Errors } from '../../lib/errors.ts';
import { parseBody } from '../../lib/validate.ts';
import { enforceRateLimit } from '../../middleware/rate-limit.ts';
import { requirePermission } from '../../middleware/rbac.ts';
import { audit, auditSafe } from '../audit/audit.service.ts';
import { verifyFreshTotp } from '../auth/mfa.ts';
import { csv, dateParam, reasonField, uuid } from './common.ts';

/**
 * Personal-data export (Phase 7). Super admin only (`report.export_pii`), and every export needs:
 * a current authenticator code in the request (step-up, even inside an MFA-verified session), a
 * written reason, a Riyadh date range of at most EXPORT_PII_MAX_DAYS, and the chosen columns
 * (minimisation: nothing personal is included unless asked for). Results larger than
 * EXPORT_PII_MAX_ROWS are refused, not truncated. The file is generated in memory and sent once
 * with no-store headers; it is never written to disk or kept by the server. The audit entry
 * records who, why, which columns, how many rows and the SHA-256 of the file, never its content.
 * National ID / Iqama / nationality are not collected anywhere, so cannot be exported.
 */
export const PII_FIELDS = {
  patient_name: { header: ['patient_first_name', 'patient_last_name'], sql: ['p.first_name', 'p.last_name'] },
  date_of_birth: { header: ['patient_date_of_birth'], sql: [`to_char(p.date_of_birth, 'YYYY-MM-DD')`] },
  gender: { header: ['patient_gender'], sql: ['p.gender'] },
  age_at_registration: { header: ['patient_age_years_at_registration'], sql: ['(r.patient_age_months_at_registration / 12)'] },
  contact_name: { header: ['contact_full_name'], sql: ['r.contact_full_name'] },
  contact_email: { header: ['contact_email'], sql: ['r.contact_email'] },
  contact_phone: { header: ['contact_phone'], sql: ['r.contact_phone'] },
} as const;
type PiiField = keyof typeof PII_FIELDS;
const FIELD_KEYS = Object.keys(PII_FIELDS) as [PiiField, ...PiiField[]];

const body = z.strictObject({
  from: dateParam,
  to: dateParam,
  reason: reasonField,
  code: z.string().trim().max(32), // recovery codes are accepted by the schema but refused by the check
  fields: z.array(z.enum(FIELD_KEYS)).min(1).max(FIELD_KEYS.length),
  branchId: uuid.optional(),
});

export function adminExportRoutes(deps: Deps) {
  const { db, config } = deps;
  const r = new Hono<AppEnv>();

  r.post('/exports/personal-data', requirePermission(deps, 'report.export_pii'), async (c) => {
    const s = c.get('session')!;
    const q = await parseBody(c, body);
    const maxDays = config.exportPiiMaxDays ?? 31;
    const maxRows = config.exportPiiMaxRows ?? 2000;
    const days = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 + 1;
    if (!(days >= 1) || days > maxDays) {
      throw new AppError(422, 'VALIDATION_FAILED', `Choose a date range of up to ${maxDays} days.`, { fields: [{ path: 'from', code: 'range' }] });
    }
    await enforceRateLimit(db, { key: `admin_pii_export:user:${s.userId}`, limit: 5, windowSeconds: 3600 });
    const meta = actorFrom(c);
    const fields = [...new Set(q.fields)].sort((a, b) => FIELD_KEYS.indexOf(a) - FIELD_KEYS.indexOf(b));
    if (!(await verifyFreshTotp(db, deps, s.userId, q.code))) {
      await auditSafe(db, { ...meta, action: 'report.exported_pii', outcome: 'failure', targetType: 'report', targetId: 'personal_data', metadata: { reason: q.reason, error: 'step_up_failed' } });
      throw Errors.invalidMfaCode();
    }

    const params: unknown[] = [q.from, q.to];
    let where = `(r.created_at AT TIME ZONE 'Asia/Riyadh')::date BETWEEN $1::date AND $2::date`;
    if (q.branchId) {
      params.push(q.branchId);
      where += ` AND r.branch_id = $${params.length}`;
    }
    const count = await db.query<{ n: string }>(`SELECT count(*) AS n FROM registrations r WHERE ${where}`, params);
    const total = Number(count.rows[0]!.n);
    if (total > maxRows) {
      await auditSafe(db, { ...meta, action: 'report.exported_pii', outcome: 'failure', targetType: 'report', targetId: 'personal_data', metadata: { reason: q.reason, from: q.from, to: q.to, fields, error: 'too_many_rows', rows: total, maxRows } });
      throw new AppError(422, 'EXPORT_TOO_LARGE', `This export would contain ${total} registrations; the limit is ${maxRows}. Choose a shorter period or one branch.`);
    }
    // Column expressions come only from the fixed PII_FIELDS table above, never from input.
    const piiSql = fields.flatMap((f) => PII_FIELDS[f].sql);
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT r.tracking_id, to_char(r.created_at AT TIME ZONE 'Asia/Riyadh', 'YYYY-MM-DD') AS registered, r.status, b.code AS branch,
              (SELECT s.sample_code FROM samples s WHERE s.registration_id = r.id ORDER BY s.sample_seq DESC NULLS LAST LIMIT 1) AS sample_id
              ${piiSql.map((x, i) => `, ${x} AS f${i}`).join('')}
         FROM registrations r JOIN patients p ON p.id = r.patient_id JOIN collection_branches b ON b.id = r.branch_id
        WHERE ${where}
        ORDER BY r.created_at, r.id`, params);
    const header = ['tracking_id', 'registered_date_riyadh', 'status', 'branch_code', 'current_sample_id', ...fields.flatMap((f) => PII_FIELDS[f].header)];
    const file = csv([header, ...rows.map((x) => [x.tracking_id, x.registered, x.status, x.branch, x.sample_id, ...piiSql.map((_, i) => x[`f${i}`])])]);
    const sha256 = createHash('sha256').update(file, 'utf8').digest('hex');
    await audit(db, {
      ...meta, action: 'report.exported_pii', outcome: 'success', targetType: 'report', targetId: 'personal_data',
      fieldsAccessed: fields, metadata: { reason: q.reason, from: q.from, to: q.to, branchId: q.branchId ?? null, rows: rows.length, sha256, personalData: true },
    });
    return c.body(file, 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="traced-personal-data-${q.from}-to-${q.to}.csv"`,
      'Cache-Control': 'no-store, private, max-age=0',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Export-Rows': String(rows.length),
      'X-Export-Sha256': sha256,
    });
  });

  return r;
}
