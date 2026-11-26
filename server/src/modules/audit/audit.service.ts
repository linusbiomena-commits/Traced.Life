import type { Queryable } from '../../db/pool.ts';
import { log } from '../../lib/logger.ts';

export type AuditEntry = {
  action: string; // dotted, e.g. "auth.sign_in"
  outcome: 'success' | 'failure' | 'denied';
  actorUserId?: string | null;
  actorRole?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  fieldsAccessed?: string[] | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  /** Never put personal data here (no emails, names, tokens). */
  metadata?: Record<string, unknown>;
};

/**
 * Appends an audit row. Pass a transaction client when the audited change must commit or roll
 * back together with the entry. The database computes the hash chain and rejects edits.
 */
export async function audit(db: Queryable, e: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (actor_user_id, actor_role, action, outcome, target_type, target_id,
       fields_accessed, ip, user_agent, request_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      e.actorUserId ?? null,
      e.actorRole ?? null,
      e.action,
      e.outcome,
      e.targetType ?? null,
      e.targetId ?? null,
      e.fieldsAccessed ?? null,
      e.ip ?? null,
      e.userAgent?.slice(0, 512) ?? null,
      e.requestId ?? null,
      e.metadata ?? {},
    ],
  );
}

/** For events outside a transaction (e.g. failed sign-ins): never let an audit failure hide the original response. */
export async function auditSafe(db: Queryable, e: AuditEntry): Promise<void> {
  try {
    await audit(db, e);
  } catch (err) {
    log.error('audit write failed', { action: e.action, error: (err as Error).message });
  }
}
