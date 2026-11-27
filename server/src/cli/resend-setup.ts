import { parseArgs } from 'node:util';
import { loadConfig } from '../config.ts';
import { createPool } from '../db/pool.ts';
import { resendStaffSetup } from '../modules/accounts/accounts.service.ts';
import { createMailer } from '../modules/mail/mailer.ts';
import { processOutbox } from '../modules/mail/outbox.ts';

// Re-send a staff-side setup invitation (older unused setup links stop working):
//   node --import tsx server/src/cli/resend-setup.ts --email person@example.com
// Prints no link or secret.
const { values } = parseArgs({ options: { email: { type: 'string' } } });
if (!values.email) { console.error('Usage: resend-setup --email <address>'); process.exit(1); }
const config = loadConfig();
const db = createPool(config.databaseUrl, 1);
const mailer = createMailer({ transport: config.mailTransport, devDir: config.mailDevDir, resendApiKey: config.resendApiKey, mailFrom: config.mailFrom, replyTo: config.mailReplyTo, captureDomains: config.mailCaptureDomains });
const deps = { config, db, mailer };
try {
  const r = await resendStaffSetup(deps, { email: values.email, meta: { actorUserId: null, actorRole: 'system_cli', ip: null, userAgent: 'resend-setup-cli', requestId: null } });
  const out = await processOutbox(deps);
  console.log(`Fresh setup invitation for account ${r.userId} (roles: ${r.roles.join(', ')}); links now use ${new URL(config.appOrigin).host}. Outbox: sent ${out.sent}, retrying ${out.retried}, failed ${out.failed}.`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
