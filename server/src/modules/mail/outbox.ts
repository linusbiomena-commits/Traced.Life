import type { Deps } from '../../context.ts';
import type { Queryable } from '../../db/pool.ts';
import { decrypt, encrypt } from '../../lib/crypto.ts';
import { log } from '../../lib/logger.ts';
import { activeCustomerToken, qrUrl, renderQrPng } from '../qr/qr.service.ts';
import { buildLink } from '../auth/links.ts';
import { MailSendError, type MailMessage } from './mailer.ts';
import { QR_CID, type Locale, type TemplateName } from './templates.ts';

// Transactional outbox: an email is a row written in the same transaction as the event that
// causes it, then delivered in the background with retries. Registration therefore succeeds
// even when the provider is down, and the unique dedupe_key stops duplicate automatic emails.
// Template data that contains one-time links is encrypted and erased once sent. QR images are
// rendered at send time from the registration's current active token (never stored in the row).

export type OutboxEntry = {
  kind: TemplateName;
  locale: Locale;
  to: string;
  userId?: string | null;
  registrationId?: string | null;
  data?: Record<string, string>;
  dedupeKey?: string | null;
};

const BACKOFF_SECONDS = [60, 5 * 60, 15 * 60, 60 * 60, 6 * 60 * 60];
const PAYLOAD_CONTEXT = 'email_outbox.payload';

export async function enqueueEmail(db: Queryable, deps: Deps, e: OutboxEntry): Promise<string | null> {
  const payload = e.data && Object.keys(e.data).length ? encrypt(deps.config.dataEncryptionKey, JSON.stringify(e.data), PAYLOAD_CONTEXT) : null;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO email_outbox (kind, locale, to_email, user_id, registration_id, payload_enc, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [e.kind, e.locale, e.to, e.userId ?? null, e.registrationId ?? null, payload, e.dedupeKey ?? null],
  );
  return rows[0]?.id ?? null; // null = duplicate automatic email suppressed
}

type Job = {
  id: string; kind: TemplateName; locale: Locale; to_email: string; registration_id: string | null;
  payload_enc: string | null; attempts: number; max_attempts: number;
};

async function buildMessage(deps: Deps, job: Job): Promise<MailMessage> {
  const data: Record<string, string> = job.payload_enc ? JSON.parse(decrypt(deps.config.dataEncryptionKey, job.payload_enc, PAYLOAD_CONTEXT)) : {};
  const msg: MailMessage = { to: job.to_email, template: job.kind, locale: job.locale, data, idempotencyKey: `traced-email/${job.id}` };
  if (job.kind === 'registration_confirmation' || job.kind === 'registration_qr_resend') {
    const { rows } = await deps.db.query<{ tracking_id: string | null; contact_full_name: string; name_en: string; name_ar: string; city_en: string; city_ar: string; address_en: string; address_ar: string }>(
      `SELECT r.tracking_id, r.contact_full_name, b.name_en, b.name_ar, b.city_en, b.city_ar, b.address_en, b.address_ar
         FROM registrations r JOIN collection_branches b ON b.id = r.branch_id WHERE r.id = $1`,
      [job.registration_id],
    );
    const r = rows[0];
    const token = r ? await activeCustomerToken(deps.db, deps, job.registration_id!) : null;
    if (!r || !r.tracking_id || !token) throw new MailSendError('registration has no tracking ID or active QR', false);
    const ar = job.locale === 'ar';
    msg.data = {
      name: r.contact_full_name, // the account holder / guardian, never the patient
      trackingId: r.tracking_id,
      branchName: ar ? r.name_ar : r.name_en,
      branchCity: ar ? r.city_ar : r.city_en,
      branchAddress: ar ? r.address_ar : r.address_en,
      link: `${buildLink(deps.config.appOrigin, 'registration', job.locale)}?id=${job.registration_id}`,
    };
    msg.attachments = [{ filename: `TRACED-${r.tracking_id.replace('/', '-')}.png`, contentType: 'image/png', content: await renderQrPng(qrUrl(deps.config.appOrigin, job.locale, token), 440), contentId: QR_CID }];
  }
  return msg;
}

/** Sends due emails. Safe to run concurrently (rows are claimed with SKIP LOCKED). */
export async function processOutbox(deps: Deps, limit = 20): Promise<{ sent: number; retried: number; failed: number }> {
  const result = { sent: 0, retried: 0, failed: 0 };
  const { rows: jobs } = await deps.db.query<Job>(
    `UPDATE email_outbox SET status = 'sending', locked_until = now() + interval '2 minutes', attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM email_outbox
         WHERE (status = 'queued' AND next_attempt_at <= now()) OR (status = 'sending' AND locked_until < now())
         ORDER BY next_attempt_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED)
      RETURNING id, kind, locale, to_email, registration_id, payload_enc, attempts, max_attempts`,
    [limit],
  );
  for (const job of jobs) {
    try {
      const sent = await deps.mailer.send(await buildMessage(deps, job));
      await deps.db.query(
        `UPDATE email_outbox SET status = 'sent', sent_at = now(), provider = $2, provider_message_id = $3,
                payload_enc = NULL, last_error = NULL, locked_until = NULL WHERE id = $1`,
        [job.id, sent.provider, sent.messageId],
      );
      result.sent++;
    } catch (err) {
      const retryable = !(err instanceof MailSendError) || err.retryable;
      const final = !retryable || job.attempts >= job.max_attempts;
      const message = (err instanceof MailSendError ? err.message : `${(err as Error).name}: ${(err as Error).message}`).slice(0, 300);
      await deps.db.query(
        `UPDATE email_outbox SET status = $2, last_error = $3, locked_until = NULL,
                next_attempt_at = now() + make_interval(secs => $4),
                payload_enc = CASE WHEN $2 = 'failed' THEN NULL ELSE payload_enc END
          WHERE id = $1`,
        [job.id, final ? 'failed' : 'queued', message, BACKOFF_SECONDS[Math.min(job.attempts - 1, BACKOFF_SECONDS.length - 1)]],
      );
      if (final) result.failed++;
      else result.retried++;
      log.warn('email delivery failed', { outboxId: job.id, kind: job.kind, attempt: job.attempts, final, error: message });
    }
  }
  return result;
}

let running: Promise<void> | null = null;
let again = false;

/** Delivers due emails now in the background (coalesces concurrent calls). Never throws. */
export function kickOutbox(deps: Deps): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      try {
        const r = await processOutbox(deps);
        if (r.sent + r.retried + r.failed === 20) again = true;
      } catch (err) {
        log.error('outbox run failed', { error: (err as Error).message });
      }
    } while (again);
  })().finally(() => {
    running = null;
  });
  return running;
}

/** Periodic worker for retries and anything enqueued by other processes. Returns a stop function. */
export function startOutboxWorker(deps: Deps, intervalMs = 15_000): () => void {
  const timer = setInterval(() => void kickOutbox(deps), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
