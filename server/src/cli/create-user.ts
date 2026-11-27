import { parseArgs } from 'node:util';
import { loadConfig } from '../config.ts';
import { createPool } from '../db/pool.ts';
import { createStaffAccount } from '../modules/accounts/accounts.service.ts';
import { createMailer } from '../modules/mail/mailer.ts';
import { enqueueEmail, processOutbox } from '../modules/mail/outbox.ts';
import { isRoleKey, STAFF_SIDE_ROLES, type RoleKey } from '../modules/rbac/catalogue.ts';

// Bootstrap a staff-side account (e.g. the first super admin) from the command line:
//   npm run create-user -- --email ops@example.com --role super_admin [--role auditor] [--locale ar]
//   npm run create-user -- --email staff@example.com --role collection_staff --name "Sara Ali" --branch DEV-RUH-01
// The person receives a one-time setup link (in development it is printed and saved to .dev-mail/).

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    role: { type: 'string', multiple: true },
    locale: { type: 'string', default: 'en' },
    name: { type: 'string' },
    branch: { type: 'string', multiple: true }, // collection branch code(s), e.g. DEV-RUH-01
  },
});

const roles = values.role ?? [];
if (!values.email || roles.length === 0) {
  console.error(`Usage: npm run create-user -- --email <email> --role <${STAFF_SIDE_ROLES.join('|')}> [--locale en|ar]`);
  process.exit(1);
}
const invalid = roles.filter((r) => !isRoleKey(r));
if (invalid.length) {
  console.error(`Unknown role(s): ${invalid.join(', ')}`);
  process.exit(1);
}
if (values.locale !== 'en' && values.locale !== 'ar') {
  console.error('--locale must be en or ar');
  process.exit(1);
}

const config = loadConfig();
const db = createPool(config.databaseUrl, 1);
const mailer = createMailer({ transport: config.mailTransport, devDir: config.mailDevDir, resendApiKey: config.resendApiKey, mailFrom: config.mailFrom, replyTo: config.mailReplyTo, captureDomains: config.mailCaptureDomains });
try {
  const { userId, setupLink } = await createStaffAccount(
    { config, db, mailer },
    {
      email: values.email,
      roles: roles as RoleKey[],
      locale: values.locale,
      meta: { actorUserId: null, actorRole: 'system_cli', ip: null, userAgent: 'create-user-cli', requestId: null },
    },
  );
  if (values.name) await db.query('UPDATE users SET full_name = $2 WHERE id = $1', [userId, values.name.trim().slice(0, 200)]);
  for (const code of values.branch ?? []) {
    const b = await db.query<{ id: string }>('SELECT id FROM collection_branches WHERE code = $1 AND active', [code]);
    if (!b.rows[0]) throw new Error(`Unknown or inactive branch code: ${code}`);
    await db.query('INSERT INTO staff_branch_assignments (user_id, branch_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, b.rows[0].id]);
  }
  const deps = { config, db, mailer };
  await enqueueEmail(db, deps, { kind: 'account_setup', locale: values.locale, to: values.email.trim().toLowerCase(), userId, data: { link: setupLink } });
  await processOutbox(deps);
  console.log(`Created account ${userId} with role(s): ${roles.join(', ')}${values.branch?.length ? `, branch(es): ${values.branch.join(', ')}` : ''}. A setup link was sent.`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
