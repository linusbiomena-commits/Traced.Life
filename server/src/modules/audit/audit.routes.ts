import { Hono } from 'hono';
import { z } from 'zod';
import { actorFrom, type AppEnv, type Deps } from '../../context.ts';
import { Errors } from '../../lib/errors.ts';
import { check } from '../../lib/validate.ts';
import { requirePermission } from '../../middleware/rbac.ts';
import { audit } from './audit.service.ts';

const query = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  beforeSeq: z.coerce.number().int().positive().optional(),
  action: z.string().regex(/^[a-z_.]+$/).max(100).optional(),
  outcome: z.enum(['success', 'failure', 'denied']).optional(),
  actorUserId: z.uuid().optional(),
  actorEmail: z.string().trim().toLowerCase().max(254).pipe(z.email()).optional(),
  targetType: z.string().regex(/^[a-z_]+$/).max(50).optional(),
  targetId: z.string().max(200).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), // Asia/Riyadh calendar dates, inclusive
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  actionPrefix: z.string().regex(/^[a-z_]+\.?$/).max(50).optional(),
});

// Free-text fields an administrator typed (reasons, notes) may mention people. Viewers without
// `registration.read_full` (e.g. auditors) see that a value exists, not the value.
const FREE_TEXT_KEYS = new Set(['reason', 'notes', 'clinicalApprovalReference']);
function redactMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactMetadata);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, FREE_TEXT_KEYS.has(k) && v !== null && v !== undefined ? '[redacted]' : redactMetadata(v)]));
  }
  return value;
}

/**
 * Read the audit log (`audit.read`: admin, super admin, auditor). Newest first, keyset pagination,
 * read-only: there is no route that edits or deletes entries (the database rejects that anyway).
 * Reading is itself audited. Viewers without `registration.read_full` don't see IP addresses,
 * user agents, actor emails or free-text reasons.
 */
export function auditRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();

  r.get('/audit-logs', requirePermission(deps, 'audit.read'), async (c) => {
    const q = check(query, c.req.query());
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.beforeSeq !== undefined) add('chain_seq < ?', q.beforeSeq);
    if (q.action) add('action = ?', q.action);
    if (q.outcome) add('outcome = ?', q.outcome);
    if (q.actorUserId) add('actor_user_id = ?', q.actorUserId);
    // Filtering by email reveals who has which address, so it needs personal-data permission.
    if (q.actorEmail) {
      if (!c.get('session')!.permissions.has('registration.read_full')) throw Errors.forbidden();
      add('actor_user_id = (SELECT id FROM users WHERE email = ?)', q.actorEmail);
    }
    if (q.targetType) add('target_type = ?', q.targetType);
    if (q.targetId) add('target_id = ?', q.targetId);
    if (q.from) add(`(occurred_at AT TIME ZONE 'Asia/Riyadh')::date >= ?::date`, q.from);
    if (q.to) add(`(occurred_at AT TIME ZONE 'Asia/Riyadh')::date <= ?::date`, q.to);
    if (q.actionPrefix) add(`action LIKE ?`, `${q.actionPrefix.replace(/\.$/, '')}.%`);
    params.push(q.limit);
    const full = c.get('session')!.permissions.has('registration.read_full');

    const { rows } = await deps.db.query(
      `SELECT chain_seq AS "seq", occurred_at AS "occurredAt", actor_user_id AS "actorUserId", actor_role AS "actorRole",
              action, outcome, target_type AS "targetType", target_id AS "targetId", fields_accessed AS "fieldsAccessed",
              host(ip) AS ip, request_id AS "requestId", metadata,
              (SELECT email FROM users u WHERE u.id = audit_logs.actor_user_id) AS "actorEmail"
         FROM audit_logs
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY chain_seq DESC
        LIMIT $${params.length}`,
      params,
    );

    await audit(deps.db, {
      ...actorFrom(c),
      action: 'audit.read',
      outcome: 'success',
      targetType: 'audit_logs',
      metadata: { filters: { ...q, limit: undefined, actorEmail: q.actorEmail ? '[provided]' : undefined }, returned: rows.length },
    });

    const items = rows.map((row) => ({
      ...row,
      seq: Number(row.seq),
      ip: full ? row.ip : null,
      actorEmail: full ? row.actorEmail : null,
      metadata: full ? row.metadata : redactMetadata(row.metadata),
    }));
    return c.json({ items, nextBeforeSeq: items.length === q.limit ? items.at(-1)!.seq : null });
  });

  return r;
}
