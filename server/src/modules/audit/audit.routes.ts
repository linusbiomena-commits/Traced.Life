import { Hono } from 'hono';
import { z } from 'zod';
import { actorFrom, type AppEnv, type Deps } from '../../context.ts';
import { check } from '../../lib/validate.ts';
import { requirePermission } from '../../middleware/rbac.ts';
import { audit } from './audit.service.ts';

const query = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  beforeSeq: z.coerce.number().int().positive().optional(),
  action: z.string().regex(/^[a-z_.]+$/).max(100).optional(),
  outcome: z.enum(['success', 'failure', 'denied']).optional(),
  actorUserId: z.uuid().optional(),
  targetType: z.string().regex(/^[a-z_]+$/).max(50).optional(),
  targetId: z.string().max(200).optional(),
});

/** Admin: read the audit log (newest first, keyset pagination). Reading it is itself audited. */
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
    if (q.targetType) add('target_type = ?', q.targetType);
    if (q.targetId) add('target_id = ?', q.targetId);
    params.push(q.limit);

    const { rows } = await deps.db.query(
      `SELECT chain_seq AS "seq", occurred_at AS "occurredAt", actor_user_id AS "actorUserId", actor_role AS "actorRole",
              action, outcome, target_type AS "targetType", target_id AS "targetId", fields_accessed AS "fieldsAccessed",
              host(ip) AS ip, request_id AS "requestId", metadata
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
      metadata: { filters: { ...q, limit: undefined }, returned: rows.length },
    });

    const items = rows.map((row) => ({ ...row, seq: Number(row.seq) }));
    return c.json({ items, nextBeforeSeq: items.length === q.limit ? items.at(-1)!.seq : null });
  });

  return r;
}
