import { parseArgs } from 'node:util';
import { loadConfig } from '../config.ts';
import { createPool } from '../db/pool.ts';
import { changeUserEmail } from '../modules/accounts/accounts.service.ts';
import { createMailer } from '../modules/mail/mailer.ts';
import { processOutbox } from '../modules/mail/outbox.ts';

// Audited login-email change (restricted preview / non-production only; refused when NODE_ENV=production):
//   node --import tsx server/src/cli/change-user-email.ts --from old@example.com --to new@example.com \
//        --reason "Owner request: ..." [--send-setup]
// Keeps the account id, roles and history; revokes sessions; expires unused links; writes an audit entry.
// --send-setup queues a fresh one-time setup invitation to the new address (staff-side accounts that have
// not set a password yet). Prints no addresses, links or secrets.

const { values } = parseArgs({ options: { from: { type: 'string' }, to: { type: 'string' }, reason: { type: 'string' }, 'send-setup': { type: 'boolean', default: false } } });
if (!values.from || !values.to || !values.reason) {
  console.error('Usage: change-user-email --from <current> --to <new> --reason "<at least 10 characters>" [--send-setup]');
  process.exit(1);
}
const config = loadConfig();
const db = createPool(config.databaseUrl, 1);
const mailer = createMailer({ transport: config.mailTransport, devDir: config.mailDevDir, resendApiKey: config.resendApiKey, mailFrom: config.mailFrom, replyTo: config.mailReplyTo, captureDomains: config.mailCaptureDomains });
const deps = { config, db, mailer };
try {
  const r = await changeUserEmail(deps, {
    from: values.from, to: values.to, reason: values.reason, sendSetup: values['send-setup'],
    meta: { actorUserId: null, actorRole: 'system_cli', ip: null, userAgent: 'change-user-email-cli', requestId: null },
  });
  console.log(`Changed login email of account ${r.userId} (roles: ${r.roles.join(', ') || 'none'}); sessions revoked: ${r.sessionsRevoked}; unused links expired: ${r.linksExpired}; new setup invitation: ${r.setupQueued ? 'queued' : 'no'}.`);
  if (r.setupQueued) {
    const out = await processOutbox(deps);
    console.log(`Outbox: sent ${out.sent}, retrying ${out.retried}, failed ${out.failed}.`);
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
