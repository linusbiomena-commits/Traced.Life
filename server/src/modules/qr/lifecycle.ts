import { randomUUID } from 'node:crypto';
import type { Deps } from '../../context.ts';
import { withTx } from '../../db/pool.ts';
import { AppError } from '../../lib/errors.ts';
import type { AuditMeta } from '../accounts/accounts.service.ts';
import { audit } from '../audit/audit.service.ts';
import { enqueueEmail } from '../mail/outbox.ts';
import { issueCustomerQr } from './qr.service.ts';

/**
 * Revokes a registration's customer QR and (normally) issues a replacement. Used by customers for
 * their own registration and by admins/super admins with `qr.revoke` (Phase 5 UI). Collection
 * staff, lab operators and auditors don't have that permission.
 *
 * Locks the registration row first (the same lock order as collection confirmation), so a
 * replacement and a collection can never interleave: whichever commits first wins, and the other
 * sees the result (collection then fails with QR_REPLACED, or replacement with QR_LOCKED).
 * The tracking ID never changes; the old token is unusable the moment this commits.
 */
export async function replaceCustomerQr(
  deps: Deps,
  input: { registrationId: string; reason: string; regenerate: boolean; notify: boolean; meta: AuditMeta },
): Promise<{ trackingId: string; regenerated: boolean }> {
  return withTx(deps.db, async (tx) => {
    const { rows } = await tx.query<{ tracking_id: string; status: string; account_user_id: string; email: string; locale: 'en' | 'ar' }>(
      `SELECT r.tracking_id, r.status, r.account_user_id, u.email, u.locale
         FROM registrations r JOIN users u ON u.id = r.account_user_id
        WHERE r.id = $1 FOR UPDATE OF r`,
      [input.registrationId],
    );
    const reg = rows[0];
    if (!reg) throw new AppError(404, 'NOT_FOUND', 'Not found.');
    if (reg.status !== 'registration_completed' && reg.status !== 'awaiting_sample_collection') {
      throw new AppError(409, 'QR_LOCKED', 'The QR code can’t be replaced at this stage.');
    }
    const revoked = await tx.query(
      `UPDATE customer_qr_tokens SET status = 'revoked', revoked_at = now(), revoked_by = $2, revoke_reason = $3
        WHERE registration_id = $1 AND status = 'active'`,
      [input.registrationId, input.meta.actorUserId, input.reason.slice(0, 200)],
    );
    if (!revoked.rowCount && !input.regenerate) throw new AppError(409, 'QR_NOT_AVAILABLE', 'There is no active QR code to revoke.');
    if (input.regenerate) await issueCustomerQr(tx, deps, input.registrationId, input.meta.actorUserId);
    if (input.regenerate && input.notify) {
      await enqueueEmail(tx, deps, {
        kind: 'registration_qr_resend', locale: reg.locale, to: reg.email, userId: reg.account_user_id, registrationId: input.registrationId,
        dedupeKey: `registration_qr_replaced:${input.registrationId}:${randomUUID()}`,
      });
    }
    await audit(tx, {
      ...input.meta,
      action: input.regenerate ? 'qr.regenerated' : 'qr.revoked',
      outcome: 'success',
      targetType: 'registration',
      targetId: input.registrationId,
      metadata: { reason: input.reason.slice(0, 200), revokedPrevious: Boolean(revoked.rowCount), regenerated: input.regenerate, notified: input.regenerate && input.notify },
    });
    return { trackingId: reg.tracking_id, regenerated: input.regenerate };
  });
}
