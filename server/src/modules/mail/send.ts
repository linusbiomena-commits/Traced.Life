import type { Deps } from '../../context.ts';
import { log } from '../../lib/logger.ts';
import type { MailMessage } from './mailer.ts';
import { enqueueEmail, kickOutbox } from './outbox.ts';

const pending = new Set<Promise<void>>();

/**
 * Account emails (verification, reset, setup...). Same signature as Phase 1, but now goes
 * through the transactional outbox for retries and delivery status. Does not block the
 * response, so success and "no such account" paths take similar time.
 */
export function sendMailInBackground(deps: Deps, message: MailMessage): void {
  const p: Promise<void> = enqueueEmail(deps.db, deps, { kind: message.template, locale: message.locale, to: message.to, data: message.data })
    .then(() => kickOutbox(deps))
    .catch((err: Error) => log.error('email enqueue failed', { template: message.template, error: err.message }))
    .finally(() => pending.delete(p));
  pending.add(p);
}

/** Resolves once every background enqueue started so far has finished (graceful shutdown, tests). */
export async function flushBackgroundMail(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}
