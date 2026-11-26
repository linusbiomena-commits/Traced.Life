import type { Deps } from '../../context.ts';
import { withTx } from '../../db/pool.ts';
import { audit } from '../audit/audit.service.ts';
import { enqueueEmail } from '../mail/outbox.ts';
import { issueCustomerQr } from '../qr/qr.service.ts';
import { allocateTrackingId } from './tracking.ts';

/**
 * Migration strategy for Phase 2 registrations created before tracking IDs existed:
 *  - processed oldest first, one transaction each (safe to stop and re-run; idempotent);
 *  - the tracking ID uses the Riyadh month of the ORIGINAL registration date, continuing that
 *    month's sequence, so IDs reflect when the person registered;
 *  - a customer QR token is issued if missing, and an open registration moves to
 *    "awaiting sample collection" with a status-history row explaining why;
 *  - emails are only sent with sendEmails=true (deduplicated per registration).
 * Run once after deploying migrations 0005/0006 and BEFORE opening Phase 3 registrations, so
 * backfilled numbers come first in their month.
 */
export async function backfillPhase3(deps: Deps, opts: { sendEmails?: boolean; limit?: number } = {}) {
  const { rows } = await deps.db.query<{ id: string }>(
    `SELECT id FROM registrations WHERE tracking_id IS NULL ORDER BY created_at, id LIMIT $1`,
    [opts.limit ?? 100_000],
  );
  let assigned = 0;
  for (const { id } of rows) {
    await withTx(deps.db, async (tx) => {
      const { rows: [r] } = await tx.query<{ created_at: Date; status: string; tracking_id: string | null; account_user_id: string; contact_email: string; locale: 'en' | 'ar' }>(
        `SELECT r.created_at, r.status, r.tracking_id, r.account_user_id, r.contact_email, u.locale
           FROM registrations r JOIN users u ON u.id = r.account_user_id WHERE r.id = $1 FOR UPDATE OF r`,
        [id],
      );
      if (!r || r.tracking_id) return; // done by a concurrent run
      const t = await allocateTrackingId(tx, r.created_at);
      await tx.query('UPDATE registrations SET tracking_id = $2, tracking_period = $3, tracking_seq = $4 WHERE id = $1', [id, t.trackingId, t.period, t.seq]);
      const hasQr = await tx.query(`SELECT 1 FROM customer_qr_tokens WHERE registration_id = $1 AND status = 'active'`, [id]);
      if (!hasQr.rowCount) await issueCustomerQr(tx, deps, id, null);
      if (r.status === 'registration_completed') {
        await tx.query(`UPDATE registrations SET status = 'awaiting_sample_collection' WHERE id = $1`, [id]);
        await tx.query(
          `INSERT INTO registration_status_history (registration_id, from_status, to_status, actor_role, reason)
           VALUES ($1, 'registration_completed', 'awaiting_sample_collection', 'system', 'Phase 3 backfill: tracking ID and QR code issued')`,
          [id],
        );
      }
      if (opts.sendEmails) {
        await enqueueEmail(tx, deps, { kind: 'registration_confirmation', locale: r.locale, to: r.contact_email, userId: r.account_user_id, registrationId: id, dedupeKey: `registration_confirmation:${id}` });
      }
      await audit(tx, { actorRole: 'system', action: 'registration.tracking_backfilled', outcome: 'success', targetType: 'registration', targetId: id, metadata: { trackingId: t.trackingId } });
      assigned++;
    });
  }
  return { assigned, remaining: rows.length - assigned };
}
