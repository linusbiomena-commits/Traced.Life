/// <reference lib="dom" />
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';
import pg from 'pg';
import type { Config } from '../../src/config.ts';
import { createStaffAccount } from '../../src/modules/accounts/accounts.service.ts';
import { MemoryMailer } from '../../src/modules/mail/mailer.ts';
import type { RoleKey } from '../../src/modules/rbac/catalogue.ts';
import { mailLink, noHorizontalScroll, PASSWORD, signUpAndSignIn, uniqueEmail } from './helpers.ts';
import { redactQrCodes } from './redact-qr.ts';

const SHOTS = path.resolve('docs/phase-5/screenshots');
mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, name: string, fullPage = true) => {
  if (fullPage) await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage });
  await redactQrCodes(path.join(SHOTS, `${name}.png`)); // never commit a decodable QR token
};
const totp = (secret: string) => new TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: Secret.fromBase32(secret.replace(/\s/g, '')) }).generate();
const ip = () => { const b = randomBytes(3); return `10.${b[0]}.${b[1]}.${b[2]}`; };

function e2eDb() {
  const env = JSON.parse(readFileSync('test-results/e2e-env.json', 'utf8'));
  const db = new pg.Pool({ connectionString: env.databaseUrl, max: 2 });
  const config = { env: 'development', appOrigin: env.appOrigin, tokenHmacKey: Buffer.from(env.tokenHmacKey, 'base64'), dataEncryptionKey: Buffer.from(env.dataEncryptionKey, 'base64') } as Config;
  return { db, config };
}

/** Invites a privileged account directly in the E2E database (bootstrap, as the CLI would). */
async function invite(roles: RoleKey[], name: string, locale: 'en' | 'ar' = 'en') {
  const { db, config } = e2eDb();
  try {
    const email = uniqueEmail(roles[0]!.replace('_', ''));
    const { userId, setupLink } = await createStaffAccount({ config, db, mailer: new MemoryMailer() }, {
      email, roles, locale, meta: { actorUserId: null, actorRole: 'system_cli', ip: null, userAgent: 'e2e', requestId: null },
    });
    await db.query('UPDATE users SET full_name = $2 WHERE id = $1', [userId, name]);
    return { email, setupLink, userId };
  } finally {
    await db.end();
  }
}

/** A privileged account that has set its password, signed in and enrolled MFA (through the API, quickly). */
async function adminPage(browser: Browser, roles: RoleKey[], name: string, lang: 'en' | 'ar' = 'en') {
  const { email, setupLink } = await invite(roles, name, lang);
  const ctx = await browser.newContext();
  await ctx.setExtraHTTPHeaders({ 'x-forwarded-for': ip() });
  const page = await ctx.newPage();
  const token = /#token=([A-Za-z0-9_-]+)/.exec(setupLink)![1];
  await page.goto('/traced/admin/sign-in/');
  const secret = await page.evaluate(async ({ token, email, password }) => {
    const j = (r: Response) => r.json();
    const post = (url: string, body: unknown, csrf?: string) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, body: JSON.stringify(body) });
    await post('/api/v1/auth/account-setup', { token, password });
    const signIn = await j(await post('/api/v1/auth/sign-in', { email, password }));
    const setup = await j(await post('/api/v1/auth/mfa/setup', {}, signIn.csrfToken));
    return { secret: setup.secret as string, csrf: signIn.csrfToken as string };
  }, { token, email, password: PASSWORD });
  await page.evaluate(async ({ code, csrf }) => {
    await fetch('/api/v1/auth/mfa/enable', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ code }) });
  }, { code: totp(secret.secret), csrf: secret.csrf });
  return { page, ctx, email };
}

/** A customer with a child registration at DEV-RUH-01. */
async function customerRegistration(browser: Browser, firstName: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const email = uniqueEmail('cust');
  await signUpAndSignIn(page, 'en', email);
  const reg = await page.evaluate(async (fn) => {
    const me = await (await fetch('/api/v1/auth/me')).json();
    const form = await (await fetch('/api/v1/me/registration-form?locale=en')).json();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());
    const res = await fetch('/api/v1/me/registrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrfToken, 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ relationship: 'child', patient: { firstName: fn, lastName: 'Alotaibi', dateOfBirth: `${Number(today.slice(0, 4)) - 6}-03-15`, gender: 'female' },
        contact: { fullName: 'Noura Alotaibi', phone: '0551112299' }, branchId: form.branches.find((b: { code: string }) => b.code === 'DEV-RUH-01').id,
        consentDocumentIds: form.consents.map((c: { id: string }) => c.id) }),
    });
    return (await res.json()).registration as { id: string; trackingId: string };
  }, firstName);
  return { page, ctx, reg, email };
}

test('admin invitation → set password → sign in → two-step setup with recovery codes → dashboard', async ({ page }) => {
  const { email, setupLink } = await invite(['admin'], 'Hessa Alharbi');
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': ip() });
  await page.goto(setupLink);
  expect(page.url()).not.toContain('token=');
  await page.getByLabel('New password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Activate account' }).click();
  await page.getByRole('link', { name: 'Go to sign in' }).click();
  await page.waitForURL('**/traced/admin/sign-in/');
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await shot(page, '01-admin-sign-in-en');
  await page.locator('form').getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/traced/admin/two-step/**');
  await page.getByRole('button', { name: 'Start setup' }).click();
  await expect(page.locator('.p-mfa-qr')).toBeVisible();
  const secret = (await page.locator('.p-code').textContent())!;
  // Never keep an MFA secret in committed evidence, even for a throwaway account: mask the key
  // and blur the QR before the screenshot (the test still uses the real secret below).
  await page.evaluate(() => {
    document.querySelector('.p-code')!.textContent = 'XXXX XXXX XXXX XXXX XXXX XXXX XXXX XXXX';
    (document.querySelector('.p-mfa-qr') as HTMLElement).style.filter = 'blur(14px)';
  });
  await shot(page, '02-admin-mfa-setup-en');
  await page.getByLabel('6-digit code').fill(totp(secret));
  await page.getByRole('button', { name: 'Turn on two-step verification' }).click();
  await expect(page.locator('.p-recovery li')).toHaveCount(10);
  await page.locator('.p-recovery').evaluate((el) => el.querySelectorAll('li').forEach((li) => { li.textContent = 'XXXXX-XXXXX'; })); // don't keep real codes in screenshots
  await shot(page, '03-admin-recovery-codes-en');
  await page.getByRole('button', { name: 'I have saved my codes' }).click();
  await page.waitForURL('**/traced/admin/');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Admin navigation' });
  for (const item of ['Dashboard', 'Registrations', 'Staff', 'Branches', 'Instructions', 'Emails', 'Audit log', 'Settings']) await expect(nav.getByRole('link', { name: item })).toBeVisible();
  await expect(page.getByText('Customer accounts')).toBeVisible();
  await shot(page, '04-admin-dashboard-en');
});

test('access control in the browser: customers and collection staff get “No access”; signed-out users go to admin sign-in', async ({ browser, page }) => {
  await page.goto('/traced/admin/registrations/');
  await page.waitForURL('**/traced/admin/sign-in/**');
  const cust = await customerRegistration(browser, 'Reem');
  await cust.page.goto('/traced/admin/');
  await expect(cust.page.getByRole('heading', { name: 'No access' })).toBeVisible();
  await cust.ctx.close();
  // Collection staff: the admin portal is closed to them in the browser and at the API.
  const staff = await invite(['collection_staff'], 'Staff Only');
  const sctx = await browser.newContext();
  await sctx.setExtraHTTPHeaders({ 'x-forwarded-for': ip() });
  const sp = await sctx.newPage();
  await sp.goto(staff.setupLink);
  await sp.getByLabel('New password').fill(PASSWORD);
  await sp.getByRole('button', { name: 'Activate account' }).click();
  await sp.goto('/traced/staff/sign-in/');
  await sp.getByLabel('Email address', { exact: true }).fill(staff.email);
  await sp.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await sp.locator('form').getByRole('button', { name: 'Sign in' }).click();
  await sp.waitForURL('**/traced/staff/');
  for (const path of ['/traced/admin/', '/traced/admin/registrations/', '/traced/admin/audit/']) {
    await sp.goto(path);
    await expect(sp.getByRole('heading', { name: 'No access' })).toBeVisible();
  }
  expect((await sp.request.get('/api/v1/admin/registrations')).status()).toBe(403);
  await sctx.close();
  // An admin who hasn't passed two-step verification in this session is sent to it.
  const { email, setupLink } = await invite(['admin'], 'Mfa Pending');
  await page.goto(setupLink);
  await page.getByLabel('New password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Activate account' }).click();
  await page.goto('/traced/admin/sign-in/');
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.locator('form').getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/traced/admin/two-step/**');
  await page.goto('/traced/admin/staff/');
  await page.waitForURL('**/traced/admin/two-step/**');
});

test('registrations: search, full record, branch transfer, patient correction and QR revocation; customer sees the change', async ({ browser }) => {
  const cust = await customerRegistration(browser, 'Joud');
  const { page } = await adminPage(browser, ['admin'], 'Lama Admin');
  await page.goto('/traced/admin/registrations/');
  await page.getByLabel('Search', { exact: true }).fill(cust.reg.trackingId);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('link', { name: cust.reg.trackingId })).toBeVisible();
  await shot(page, '05-registrations-search-en');
  await page.getByRole('link', { name: cust.reg.trackingId }).click();
  await expect(page.getByRole('heading', { name: 'Registration record' })).toBeVisible();
  await expect(page.getByText('Joud Alotaibi')).toBeVisible();
  await expect(page.getByText(cust.email).first()).toBeVisible();
  await shot(page, '06-registration-record-en');

  // Transfer to Jeddah with a reason.
  await page.getByText('Transfer to another branch').click();
  const transfer = page.locator('details[open]');
  await transfer.getByLabel('New branch').selectOption({ label: '[DEV] Jeddah sample branch (DEV-JED-01)' });
  await transfer.getByLabel('Reason').fill('Customer relocated to Jeddah');
  await transfer.getByRole('button', { name: 'Transfer registration' }).click();
  await expect(page.getByText('The registration was transferred.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Branch transfers' })).toBeVisible();

  // Correct the first name.
  await page.getByText('Correct patient details').click();
  const correct = page.locator('details[open]');
  await correct.getByLabel('First name').fill('Jude');
  await correct.getByLabel('Reason').fill('Spelling corrected from birth certificate');
  await correct.getByRole('button', { name: 'Save correction' }).click();
  await expect(page.getByText('Patient details were corrected.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Patient detail corrections' })).toBeVisible();

  // Revoke and replace the QR code.
  await page.getByText('Revoke QR code', { exact: true }).first().click();
  const revoke = page.locator('details[open]');
  await revoke.getByLabel('Reason').fill('Customer reported the phone was stolen');
  await revoke.getByRole('button', { name: 'Revoke QR code' }).click();
  await expect(page.getByText('The QR code was revoked.')).toBeVisible();
  await shot(page, '07-registration-after-actions-en');

  // The customer's page shows the new branch and the notice.
  await cust.page.goto(`/traced/account/registration/?id=${cust.reg.id}`);
  await expect(cust.page.getByText(/Your collection branch was changed/)).toBeVisible();
  await shot(cust.page, '08-customer-branch-changed-en');
  await cust.ctx.close();
});

test('staff management: invite collection staff with branches, change branches, suspend', async ({ browser }) => {
  const { page } = await adminPage(browser, ['admin'], 'Staff Manager');
  await page.goto('/traced/admin/staff/');
  await expect(page.getByRole('heading', { name: 'Invite a staff member' })).toBeVisible();
  const email = uniqueEmail('newstaff');
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Send invitation' }) });
  await form.getByLabel('Email address').fill(email);
  await form.getByLabel('Full name').fill('Abeer Alshehri');
  await form.getByText(/Riyadh/).first().click();
  await expect(form.getByLabel('Administrator')).toHaveCount(0); // admins can't grant admin roles
  await form.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByText(`Invitation sent to ${email}.`).first()).toBeVisible();
  expect(await mailLink(email, 'account_setup')).toContain('/traced/staff/accept-invite/');
  await shot(page, '09-staff-list-invite-en');
  await page.getByRole('link', { name: 'Abeer Alshehri' }).click();
  await expect(page.getByRole('heading', { name: 'Abeer Alshehri' })).toBeVisible();
  await page.getByText('Change branches').click();
  const branches = page.locator('details[open]');
  await branches.getByText(/Jeddah/).click();
  await branches.getByLabel('Reason').fill('Covering Jeddah this month');
  await branches.getByRole('button', { name: 'Save branches' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await page.getByText('Change account status').click();
  const status = page.locator('details[open]');
  await status.getByLabel('New status').selectOption('suspended');
  await status.getByLabel('Reason').fill('On leave pending review');
  await status.getByRole('button', { name: 'Change status' }).click();
  await expect(page.getByText('Suspended / locked').first()).toBeVisible();
  await shot(page, '10-staff-member-en');
});

test('branches, instructions (draft → submit → super admin publishes provisional), email monitor and audit log', async ({ browser }) => {
  const admin = await adminPage(browser, ['admin'], 'Ops Admin');
  const page = admin.page;
  await page.goto('/traced/admin/branches/');
  await page.getByText('Add a branch').click();
  const code = `DEV-E2E-${randomBytes(1).toString('hex').toUpperCase()}`;
  const create = page.locator('details[open]');
  await create.getByLabel('Branch code').fill(code);
  await create.getByLabel('Name (English)').fill('[DEV] Khobar test branch');
  await create.getByLabel('Name (Arabic)').fill('[تجريبي] فرع الخبر');
  await create.getByLabel('City (English)').fill('Khobar');
  await create.getByLabel('City (Arabic)').fill('الخبر');
  await create.getByLabel('Display order').fill('100'); // keep the seeded branches first for other tests
  await create.getByRole('button', { name: 'Create branch' }).click();
  await expect(page.getByText('Branch created.')).toBeVisible();
  const card = page.locator('section').filter({ hasText: code });
  await card.getByText('Deactivate branch', { exact: true }).first().click();
  await card.locator('details[open]').getByLabel('Reason').fill('Test branch not needed');
  await card.locator('details[open]').getByRole('button', { name: 'Deactivate branch' }).click();
  await expect(page.getByText('The branch was deactivated.')).toBeVisible();
  await shot(page, '11-branches-en');

  await page.goto('/traced/admin/instructions/');
  await expect(page.getByText('Publishing is not clinical approval')).toBeVisible();
  await page.getByText('New draft').click();
  await page.getByRole('button', { name: 'Copy the latest published version' }).click();
  await page.getByLabel('Version', { exact: true }).fill(`0.5-e2e-${randomBytes(2).toString('hex')}`);
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByText('Draft created.')).toBeVisible();
  await page.getByText('Submit for approval').first().click();
  await page.locator('details[open]').getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByText('Draft submitted.')).toBeVisible();

  const sa = await adminPage(browser, ['super_admin'], 'Super Admin');
  await sa.page.goto('/traced/admin/instructions/');
  await sa.page.getByText('Publish version').first().click();
  const pub = sa.page.locator('details[open]');
  await pub.getByLabel(/I have reviewed both languages/).check();
  await pub.getByRole('button', { name: 'Publish version' }).click();
  await expect(sa.page.getByText('Published as a provisional version (not used in production).')).toBeVisible();
  await shot(sa.page, '12-instructions-en');

  await page.goto('/traced/admin/emails/');
  await expect(page.getByRole('heading', { name: 'Email delivery' })).toBeVisible();
  await expect(page.locator('table').getByText(/\*\*\*@/).first()).toBeVisible();
  await shot(page, '13-email-monitor-en');

  await page.goto('/traced/admin/audit/');
  await expect(page.getByText('Branch deactivated').first()).toBeVisible();
  await shot(page, '14-audit-log-en');

  // Auditor: dashboard and audit log only, redacted.
  const auditor = await adminPage(browser, ['auditor'], 'Audit Person');
  await auditor.page.goto('/traced/admin/');
  const nav = auditor.page.getByRole('navigation', { name: 'Admin navigation' });
  await expect(nav.getByRole('link', { name: 'Registrations' })).toHaveCount(0);
  await auditor.page.goto('/traced/admin/audit/');
  await expect(auditor.page.getByText(/hidden for your role/)).toBeVisible();
  await expect(auditor.page.getByText('[redacted]').first()).toBeVisible();
  await shot(auditor.page, '15-audit-log-auditor-en');
  await auditor.page.goto('/traced/admin/registrations/');
  await expect(auditor.page.getByRole('heading', { name: 'No access' })).toBeVisible();
  await expect(auditor.page.getByText('Your role doesn’t include access to this part of the admin portal.')).toBeVisible();
});

test('Arabic admin portal is right-to-left and Arabic; mobile admin pages fit the screen', async ({ browser }) => {
  const cust = await customerRegistration(browser, 'Sara');
  await cust.ctx.close();
  const { page, ctx } = await adminPage(browser, ['admin'], 'مسؤول تجريبي', 'ar');
  await page.goto('/ar/traced/admin/');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { name: 'لوحة المعلومات' })).toBeVisible();
  await shot(page, '16-admin-dashboard-ar');
  await page.goto('/ar/traced/admin/registrations/');
  await page.getByRole('button', { name: 'بحث', exact: true }).click();
  await page.locator('table a').first().click();
  await expect(page.getByRole('heading', { name: 'سجل التسجيل' })).toBeVisible();
  await shot(page, '17-registration-record-ar');
  await page.goto('/ar/traced/admin/staff/');
  await expect(page.getByRole('heading', { name: 'دعوة موظف' })).toBeVisible();
  await shot(page, '18-staff-ar');
  await ctx.close();

  const mobile = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true });
  await mobile.setExtraHTTPHeaders({ 'x-forwarded-for': ip() });
  const m = await adminPage(browser, ['admin'], 'Mobile Admin');
  const cookies = await m.ctx.cookies();
  await mobile.addCookies(cookies);
  const mp = await mobile.newPage();
  for (const p of ['/traced/admin/', '/traced/admin/registrations/', '/traced/admin/staff/', '/traced/admin/branches/', '/traced/admin/instructions/', '/traced/admin/emails/', '/traced/admin/audit/', '/ar/traced/admin/']) {
    await mp.goto(p);
    await expect(mp.locator('#page-title')).toBeVisible();
    await mp.waitForLoadState('networkidle');
    await noHorizontalScroll(mp);
  }
  await mp.goto('/traced/admin/');
  await expect(mp.locator('.p-stat').first()).toBeVisible();
  await shot(mp, '19-mobile-dashboard');
  await mp.goto('/traced/admin/registrations/');
  await expect(mp.locator('table')).toBeVisible();
  await shot(mp, '20-mobile-registrations');
  await mobile.close();
});
