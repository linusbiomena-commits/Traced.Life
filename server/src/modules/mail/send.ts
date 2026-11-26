import type { Deps } from '../../context.ts';
import { log } from '../../lib/logger.ts';
import type { MailMessage } from './mailer.ts';

/**
 * Sends without blocking the response, so success and "no such account" paths take similar time
 * and a mail outage never fails the request. Phase 3 replaces this with a durable outbox + retries.
 */
export function sendMailInBackground(deps: Deps, message: MailMessage): void {
  deps.mailer.send(message).catch((err: Error) => {
    log.error('mail send failed', { template: message.template, error: err.message });
  });
}
