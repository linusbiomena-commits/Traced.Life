import { parseArgs } from 'node:util';
import { loadConfig, type Config } from '../config.ts';
import { createPool, withTx, type Pool } from '../db/pool.ts';
import { createStaffAccount } from '../modules/accounts/accounts.service.ts';
import { audit } from '../modules/audit/audit.service.ts';
import { buildLink } from '../modules/auth/links.ts';
import { issueToken } from '../modules/auth/tokens.ts';
import { createMailer } from '../modules/mail/mailer.ts';
import { enqueueEmail, processOutbox } from '../modules/mail/outbox.ts';
import type { RoleKey } from '../modules/rbac/catalogue.ts';

// LOCAL DEVELOPMENT ONLY: synthetic accounts for manual testing of every portal.
//   npm run dev:test-accounts             create missing accounts; re-issue links for pending ones
//   npm run dev:test-accounts -- --reset  also issue password-reset links for accounts already set up
//
// No password is ever generated, stored or printed. Each account gets the same one-time link the
// application normally emails (set-up link for staff-side accounts, password-reset link for the
// customer). Links are printed here and saved to the dev mail folder; you choose the password
// yourself, and privileged accounts must still enrol two-step verification on first sign-in.
// Refuses to run in production, against a non-local database, or with a real mail provider.

export type TestAccount = { key: string; email: string; roles: RoleKey[]; name: string; branches?: string[] };

export const TEST_ACCOUNTS: TestAccount[] = [
  { key: 'customer', email: 'customer.local@example.com', roles: ['customer'], name: 'Local Test Customer' },
  { key: 'collection_staff', email: 'staff.local@example.com', roles: ['collection_staff'], name: 'Local Collection Staff', branches: ['DEV-RUH-01'] },
  { key: 'admin', email: 'admin.local@example.com', roles: ['admin'], name: 'Local Admin' },
  { key: 'super_admin', email: 'superadmin.local@example.com', roles: ['super_admin'], name: 'Local Super Admin' },
  { key: 'auditor', email: 'auditor.local@example.com', roles: ['auditor'], name: 'Local Auditor' },
  { key: 'lab_operator', email: 'lab.local@example.com', roles: ['lab_operator'], name: 'Local Laboratory Operator' },
];

/** Throws unless this is clearly a local development setup. */
export function assertLocalDevelopment(config: Pick<Config, 'env' | 'databaseUrl' | 'mailTransport'>): void {
  if (config.env === 'production') throw new Error('dev:test-accounts is for local development only (NODE_ENV=production).');
  const host = new URL(config.databaseUrl).hostname;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) throw new Error(`dev:test-accounts only runs against a local database (got host "${host}").`);
  if (config.mailTransport === 'resend') throw new Error('dev:test-accounts refuses to run with a real mail provider (MAIL_TRANSPORT=resend).');
}

const META = { actorUserId: null, actorRole: 'system_cli', ip: null, userAgent: 'dev-test-accounts', requestId: null };

type Row = { id: string; ready: boolean; status: string; roles: RoleKey[] };

export async function ensureTestAccount(db: Pool, config: Config, a: TestAccount, reset: boolean): Promise<{ status: string; link: string | null }> {
  const deps = { config, db, mailer: createMailer({ transport: 'memory', devDir: '' }) };
  const { rows } = await db.query<Row>(
    `SELECT u.id, (u.password_hash IS NOT NULL) AS ready, u.status,
            COALESCE(array_agg(ur.role_key) FILTER (WHERE ur.role_key IS NOT NULL), '{}') AS roles
       FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id WHERE u.email = $1 GROUP BY u.id`, [a.email]);
  const existing = rows[0];
  const staffSide = !a.roles.includes('customer');
  const adminSide = a.roles.some((r) => r === 'admin' || r === 'super_admin' || r === 'auditor');

  if (existing && [...existing.roles].sort().join() !== [...a.roles].sort().join()) {
    return { status: `exists with different roles (${existing.roles.join(', ')}); left unchanged`, link: null };
  }
  if (existing && existing.status !== 'active') return { status: `exists but is ${existing.status}; left unchanged`, link: null };

  let userId: string;
  let link: string | null = null;
  let status: string;
  if (!existing) {
    if (staffSide) {
      const created = await createStaffAccount(deps, {
        email: a.email, roles: a.roles, locale: 'en', meta: META,
        afterCreate: async (tx, id) => {
          await tx.query('UPDATE users SET full_name = $2 WHERE id = $1', [id, a.name]);
        },
      });
      userId = created.userId;
      link = created.setupLink;
    } else {
      userId = await withTx(db, async (tx) => {
        // Synthetic local customer: the adult confirmation is recorded as it would be at sign-up.
        const { rows: u } = await tx.query<{ id: string }>(
          `INSERT INTO users (email, locale, full_name, email_verified_at, adult_confirmed_at) VALUES ($1, 'en', $2, now(), now()) RETURNING id`, [a.email, a.name]);
        await tx.query(`INSERT INTO user_roles (user_id, role_key) VALUES ($1, 'customer')`, [u[0]!.id]);
        await audit(tx, { ...META, action: 'account.dev_test_customer_created', outcome: 'success', targetType: 'user', targetId: u[0]!.id });
        return u[0]!.id;
      });
      link = buildLink(config.appOrigin, 'reset_password', 'en', await issueToken(db, deps, userId, 'reset_password'));
    }
    status = 'created';
  } else {
    userId = existing.id;
    if (!existing.ready && staffSide) {
      link = buildLink(config.appOrigin, adminSide ? 'admin_setup' : 'staff_setup', 'en', await issueToken(db, deps, userId, 'account_setup'));
      status = 'pending set-up; new set-up link issued (older links stop working)';
    } else if (!existing.ready || reset) {
      link = buildLink(config.appOrigin, 'reset_password', 'en', await issueToken(db, deps, userId, 'reset_password'));
      status = existing.ready ? 'already set up; password-reset link issued (--reset)' : 'no password yet; password-reset link issued';
    } else {
      status = 'already set up (use your password, or run with --reset for a reset link)';
    }
  }
  for (const code of a.branches ?? []) {
    await db.query(
      `INSERT INTO staff_branch_assignments (user_id, branch_id)
       SELECT $1, id FROM collection_branches WHERE code = $2 AND active
       ON CONFLICT DO NOTHING`, [userId, code]);
  }
  if (link) {
    const kind = link.includes('/reset-password/') ? 'reset_password' : 'account_setup';
    await enqueueEmail(db, deps, { kind, locale: 'en', to: a.email, userId, data: { link } });
  }
  return { status, link };
}

async function main() {
  const { values } = parseArgs({ options: { reset: { type: 'boolean', default: false } } });
  const config = loadConfig();
  assertLocalDevelopment(config);
  const db = createPool(config.databaseUrl, 2);
  const mailer = createMailer({ transport: config.mailTransport, devDir: config.mailDevDir, resendApiKey: config.resendApiKey, mailFrom: config.mailFrom, replyTo: config.mailReplyTo });
  try {
    console.log('TRACED local test accounts (synthetic, local development only)\n');
    for (const a of TEST_ACCOUNTS) {
      const r = await ensureTestAccount(db, config, a, values.reset);
      console.log(`${a.key.padEnd(17)} ${a.email.padEnd(32)} ${r.status}${a.branches ? ` · branch ${a.branches.join(', ')}` : ''}`);
      if (r.link) console.log(`${' '.repeat(18)}one-time link: ${r.link}`);
    }
    await processOutbox({ config, db, mailer }, 50); // also saved to the dev mail folder
    console.log(`\nLinks expire (set-up 72 h, password reset 30 min) and work once. Re-run this command for fresh ones.`);
    console.log('Admin, super admin, auditor and laboratory accounts must set up two-step verification at first sign-in.');
  } finally {
    await db.end();
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('cli/dev-test-accounts.ts')) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  });
}
