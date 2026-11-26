import { Hono } from 'hono';
import { z } from 'zod';
import { actorFrom, type AppEnv, type Deps } from '../../context.ts';
import { withTx } from '../../db/pool.ts';
import { AppError, Errors } from '../../lib/errors.ts';
import { check, parseBody } from '../../lib/validate.ts';
import { enforceRateLimit } from '../../middleware/rate-limit.ts';
import { requirePermission } from '../../middleware/rbac.ts';
import { audit } from '../audit/audit.service.ts';
import { kickOutbox } from '../mail/outbox.ts';
import { dateParam, idParam, maskEmail, scrubEmails, uuid } from './common.ts';

const KINDS = ['verify_email', 'account_exists', 'reset_password', 'password_changed', 'account_setup',
  'registration_confirmation', 'registration_qr_resend', 'registration_branch_changed'] as const;

/**
 * Kinds whose content is rebuilt from the database at send time. Other kinds carry a one-time
 * link that is erased when delivery finally fails, so they can't be retried; the admin uses the
 * account action instead (resend invitation / verification) which issues a fresh link.
 */
export const RETRYABLE_KINDS = ['registration_confirmation', 'registration_qr_resend', 'password_changed'];

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/**
 * Email delivery monitor (`email.manage`). Recipients are masked; bodies, payloads (which hold
 * one-time links) and tokens are never selected. Provider error text is scrubbed of addresses.
 */
export function adminEmailRoutes(deps: Deps) {
  const { db } = deps;
  const r = new Hono<AppEnv>();
  const manage = requirePermission(deps, 'email.manage');

  r.get('/emails', manage, async (c) => {
    const q = check(z.strictObject({
      status: z.enum(['queued', 'sending', 'sent', 'failed']).optional(), kind: z.enum(KINDS).optional(),
      from: dateParam.optional(), to: dateParam.optional(), registrationId: uuid.optional(),
      before: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
    }), c.req.query());
    const where: string[] = [];
    const params: unknown[] = [];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (q.status) where.push(`e.status = ${p(q.status)}`);
    if (q.kind) where.push(`e.kind = ${p(q.kind)}`);
    if (q.registrationId) where.push(`e.registration_id = ${p(q.registrationId)}`);
    if (q.from) where.push(`(e.created_at AT TIME ZONE 'Asia/Riyadh')::date >= ${p(q.from)}::date`);
    if (q.to) where.push(`(e.created_at AT TIME ZONE 'Asia/Riyadh')::date <= ${p(q.to)}::date`);
    if (q.before) {
      const [at, id] = Buffer.from(q.before, 'base64url').toString('utf8').split('|');
      if (!at || !id || Number.isNaN(Date.parse(at)) || !uuid.safeParse(id).success) throw new AppError(422, 'VALIDATION_FAILED', 'Invalid cursor.');
      where.push(`(e.created_at, e.id) < (${p(at)}::timestamptz, ${p(id)}::uuid)`);
    }
    const { rows } = await db.query(
      `SELECT e.id, e.kind, e.locale, e.to_email, e.status, e.attempts, e.max_attempts, e.next_attempt_at, e.last_error, e.provider,
              e.provider_message_id, e.sent_at, e.created_at, e.updated_at, e.registration_id, r.tracking_id
         FROM email_outbox e LEFT JOIN registrations r ON r.id = e.registration_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY e.created_at DESC, e.id DESC LIMIT ${p(q.limit + 1)}`, params);
    const page = rows.slice(0, q.limit);
    const summary = await db.query<{ status: string; n: string }>('SELECT status, count(*) AS n FROM email_outbox GROUP BY status');
    return c.json({
      summary: Object.fromEntries(['queued', 'sending', 'sent', 'failed'].map((st) => [st, Number(summary.rows.find((x) => x.status === st)?.n ?? 0)])),
      items: page.map((e) => ({
        id: e.id, kind: e.kind, locale: e.locale, recipient: maskEmail(e.to_email), status: e.status, attempts: e.attempts, maxAttempts: e.max_attempts,
        nextAttemptAt: e.status === 'queued' ? iso(e.next_attempt_at) : null, lastAttemptAt: e.attempts > 0 ? iso(e.updated_at) : null,
        lastError: scrubEmails(e.last_error), provider: e.provider, providerMessageId: e.provider_message_id, sentAt: iso(e.sent_at), createdAt: iso(e.created_at),
        registration: e.registration_id ? { id: e.registration_id, trackingId: e.tracking_id } : null,
        retryable: e.status === 'failed' && RETRYABLE_KINDS.includes(e.kind),
      })),
      nextBefore: rows.length > q.limit ? Buffer.from(`${page.at(-1)!.created_at.toISOString()}|${page.at(-1)!.id}`).toString('base64url') : null,
    });
  });

  r.post('/emails/:id/retry', manage, async (c) => {
    const id = idParam(c);
    await parseBody(c, z.strictObject({}));
    await enforceRateLimit(db, { key: `admin_email_retry:user:${c.get('session')!.userId}`, limit: 60, windowSeconds: 3600 });
    await withTx(db, async (tx) => {
      const e = (await tx.query<{ status: string; kind: string; attempts: number }>('SELECT status, kind, attempts FROM email_outbox WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!e) throw Errors.notFound();
      if (e.status !== 'failed') throw new AppError(409, 'EMAIL_NOT_FAILED', 'Only failed emails can be retried.');
      if (!RETRYABLE_KINDS.includes(e.kind)) throw new AppError(409, 'EMAIL_NOT_RETRYABLE', 'This email contained a one-time link that has expired. Use the account action to send a new one.');
      await tx.query(`UPDATE email_outbox SET status = 'queued', next_attempt_at = now(), max_attempts = attempts + 3, locked_until = NULL WHERE id = $1`, [id]);
      await audit(tx, { ...actorFrom(c), action: 'email.retry_requested', outcome: 'success', targetType: 'email', targetId: id, metadata: { kind: e.kind, previousAttempts: e.attempts } });
    });
    void kickOutbox(deps);
    return c.json({ status: 'queued' }, 202);
  });

  return r;
}
