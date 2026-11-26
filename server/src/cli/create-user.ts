import { parseArgs } from 'node:util';
import { loadConfig } from '../config.ts';
import { createPool } from '../db/pool.ts';
import { createStaffAccount } from '../modules/accounts/accounts.service.ts';
import { createMailer } from '../modules/mail/mailer.ts';
import { isRoleKey, STAFF_SIDE_ROLES, type RoleKey } from '../modules/rbac/catalogue.ts';

// Bootstrap a staff-side account (e.g. the first super admin) from the command line:
//   npm run create-user -- --email ops@example.com --role super_admin [--role auditor] [--locale ar]
// The person receives a one-time setup link (in development it is printed and saved to .dev-mail/).

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    role: { type: 'string', multiple: true },
    locale: { type: 'string', default: 'en' },
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
const mailer = createMailer(config.mailTransport, config.mailDevDir);
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
  await mailer.send({ to: values.email.trim().toLowerCase(), template: 'account_setup', locale: values.locale, data: { link: setupLink } });
  console.log(`Created account ${userId} with role(s): ${roles.join(', ')}. A setup link was sent.`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
