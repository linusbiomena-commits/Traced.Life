import { parseArgs } from 'node:util';
import { loadConfig } from '../config.ts';
import { createPool } from '../db/pool.ts';
import { createMailer } from '../modules/mail/mailer.ts';
import { processOutbox } from '../modules/mail/outbox.ts';
import { backfillPhase3 } from '../modules/tracking/backfill.ts';

// Assigns tracking IDs and QR codes to registrations created before Phase 3.
//   npm run backfill:phase3                 assign IDs + QR codes (no emails)
//   npm run backfill:phase3 -- --send-emails also queue the confirmation email for each
const { values } = parseArgs({ options: { 'send-emails': { type: 'boolean', default: false } } });

const config = loadConfig();
const db = createPool(config.databaseUrl, 2);
const deps = { config, db, mailer: createMailer({ transport: config.mailTransport, devDir: config.mailDevDir, resendApiKey: config.resendApiKey, mailFrom: config.mailFrom, replyTo: config.mailReplyTo }) };
try {
  const r = await backfillPhase3(deps, { sendEmails: values['send-emails'] });
  if (values['send-emails']) await processOutbox(deps);
  console.log(`Assigned tracking IDs to ${r.assigned} registration(s).`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
