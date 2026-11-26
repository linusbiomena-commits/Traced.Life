/// <reference lib="dom" />
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import pg from 'pg';
import type { Config } from '../../src/config.ts';
import { createStaffAccount } from '../../src/modules/accounts/accounts.service.ts';
import { MemoryMailer } from '../../src/modules/mail/mailer.ts';
import type { RoleKey } from '../../src/modules/rbac/catalogue.ts';
import { noHorizontalScroll, PASSWORD, signUpAndSignIn, uniqueEmail } from './helpers.ts';
import { saveScreenshot } from './redact-qr.ts';

// Stage A (before Phase 6): staff/admin login links on the customer sign-in page and role-based
// redirection from every sign-in page.
const SHOTS = path.resolve('docs/phase-6/screenshots');
mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, name: string) => {
  await page.evaluate(() => window.scrollTo(0, 0));
  await saveScreenshot(page, path.join(SHOTS, `${name}.png`)); // retries + QR redaction
};
const ip = () => { const b = randomBytes(3); return `10.${b[0]}.${b[1]}.${b[2]}`; };

/** A staff-side account with its password set (bootstrap in the E2E database, as the CLI would). */
async function account(roles: RoleKey[], branchCodes: string[] = []) {
  const env = JSON.parse(readFileSync('test-results/e2e-env.json', 'utf8'));
  const db = new pg.Pool({ connectionString: env.databaseUrl, max: 2 });
  try {
    const config = { env: 'development', appOrigin: env.appOrigin, tokenHmacKey: Buffer.from(env.tokenHmacKey, 'base64'), dataEncryptionKey: Buffer.from(env.dataEncryptionKey, 'base64') } as Config;
    const email = uniqueEmail(roles[0]!.replace('_', ''));
    const { userId, setupLink } = await createStaffAccount({ config, db, mailer: new MemoryMailer() }, {
      email, roles, locale: 'en', meta: { actorUserId: null, actorRole: 'system_cli', ip: null, userAgent: 'e2e', requestId: null },
    });
    for (const code of branchCodes) await db.query('INSERT INTO staff_branch_assignments (user_id, branch_id) SELECT $1, id FROM collection_branches WHERE code = $2', [userId, code]);
    const token = /#token=([A-Za-z0-9_-]+)/.exec(setupLink)![1]!;
    return { email, token };
  } finally {
    await db.end();
  }
}

async function freshPage(browser: Browser) {
  const ctx = await browser.newContext();
  await ctx.setExtraHTTPHeaders({ 'x-forwarded-for': ip() });
  return { ctx, page: await ctx.newPage() };
}

async function activate(page: Page, token: string) {
  await page.goto('/traced/account/sign-in/');
  const r = await page.evaluate(async ({ token, password }) => (await fetch('/api/v1/auth/account-setup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, password }),
  })).status, { token, password: PASSWORD });
  expect(r).toBe(200);
}

async function signInAt(page: Page, url: string, email: string) {
  await page.goto(url);
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.locator('form').getByRole('button', { name: 'Sign in' }).click();
}

test('customer sign-in page shows discreet Staff Login | Admin Login links (EN, AR, mobile) that open the real sign-in pages', async ({ page, browser }) => {
  await page.goto('/traced/account/sign-in/');
  const links = page.getByRole('navigation', { name: 'Staff and administrator sign-in' });
  await expect(links.getByRole('link', { name: 'Staff Login' })).toHaveAttribute('href', '/traced/staff/sign-in/');
  await expect(links.getByRole('link', { name: 'Admin Login' })).toHaveAttribute('href', '/traced/admin/sign-in/');
  await expect(page.getByRole('link', { name: 'Create an account' })).toBeVisible(); // existing link kept
  await shot(page, 'a01-customer-sign-in-links-en');
  await links.getByRole('link', { name: 'Staff Login' }).click();
  await expect(page.getByRole('heading', { name: 'Staff sign in' })).toBeVisible();
  await page.goBack();
  await page.getByRole('link', { name: 'Admin Login' }).click();
  await expect(page.getByRole('heading', { name: 'Admin sign in' })).toBeVisible();
  // No registration for staff or admins.
  await expect(page.getByRole('link', { name: /Create/ })).toHaveCount(0);

  await page.goto('/ar/traced/account/sign-in/');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('link', { name: 'دخول الموظفين' })).toHaveAttribute('href', '/ar/traced/staff/sign-in/');
  await expect(page.getByRole('link', { name: 'دخول الإدارة' })).toHaveAttribute('href', '/ar/traced/admin/sign-in/');
  await shot(page, 'a02-customer-sign-in-links-ar');

  const mobile = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true });
  const mp = await mobile.newPage();
  for (const p of ['/traced/account/sign-in/', '/ar/traced/account/sign-in/']) {
    await mp.goto(p);
    await expect(mp.getByRole('link', { name: /Staff Login|دخول الموظفين/ })).toBeVisible();
    await noHorizontalScroll(mp);
  }
  await shot(mp, 'a03-customer-sign-in-links-mobile-ar');
  await mobile.close();
});

test('role-based redirection from every sign-in page; `next` links into another role’s area are ignored', async ({ browser }) => {
  // Customer signing in on the admin page lands in the customer dashboard, even with a next=admin link.
  const c = await freshPage(browser);
  const custEmail = uniqueEmail('cust');
  await signUpAndSignIn(c.page, 'en', custEmail);
  await c.page.evaluate(async () => {
    const me = await (await fetch('/api/v1/auth/me')).json();
    await fetch('/api/v1/auth/sign-out', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrfToken }, body: '{}' });
  });
  await signInAt(c.page, '/traced/admin/sign-in/?next=%2Ftraced%2Fadmin%2Fregistrations%2F', custEmail);
  await c.page.waitForURL('**/traced/account/');
  await c.page.goto('/traced/admin/');
  await expect(c.page.getByRole('heading', { name: 'No access' })).toBeVisible();
  await c.page.goto('/traced/staff/');
  await expect(c.page.getByRole('heading', { name: 'No access' })).toBeVisible();
  await c.ctx.close();

  // Collection staff signing in on the admin page land in the staff portal.
  const staff = await account(['collection_staff'], ['DEV-RUH-01']);
  const s = await freshPage(browser);
  await activate(s.page, staff.token);
  await signInAt(s.page, '/traced/admin/sign-in/', staff.email);
  await s.page.waitForURL('**/traced/staff/');
  await s.page.goto('/traced/account/');
  await s.page.waitForURL('**/traced/staff/'); // customer-only pages send staff to their portal
  await s.page.goto('/traced/admin/registrations/');
  await expect(s.page.getByRole('heading', { name: 'No access' })).toBeVisible();
  await s.ctx.close();

  // Admin and super admin signing in on the customer or staff page go to two-step verification.
  for (const [roles, url] of [[['admin'], '/traced/account/sign-in/'], [['super_admin'], '/traced/staff/sign-in/']] as [RoleKey[], string][]) {
    const a = await account(roles);
    const p = await freshPage(browser);
    await activate(p.page, a.token);
    await signInAt(p.page, `${url}?next=%2Ftraced%2Faccount%2Fregistrations%2F`, a.email);
    await p.page.waitForURL('**/traced/admin/two-step/**');
    expect(p.page.url()).not.toContain('account'); // the customer-area next link was not kept
    await p.page.goto('/traced/admin/');
    await p.page.waitForURL('**/traced/admin/two-step/**'); // MFA still enforced
    await p.ctx.close();
  }

  // An auditor is sent to two-step verification too (then only permitted admin views).
  const aud = await account(['auditor']);
  const ap = await freshPage(browser);
  await activate(ap.page, aud.token);
  await signInAt(ap.page, '/traced/account/sign-in/', aud.email);
  await ap.page.waitForURL('**/traced/admin/two-step/**');
  await ap.ctx.close();

  // Lab operators (Phase 6) sign in on any page and go to two-step verification, then the lab portal.
  const lab = await account(['lab_operator']);
  const lp = await freshPage(browser);
  await activate(lp.page, lab.token);
  await signInAt(lp.page, '/traced/account/sign-in/', lab.email);
  await lp.page.waitForURL('**/traced/admin/two-step/**');
  expect(decodeURIComponent(lp.page.url())).not.toContain('/traced/account/');
  await lp.page.goto('/traced/lab/');
  await lp.page.waitForURL('**/traced/admin/two-step/**'); // MFA enforced for the lab portal too
  await lp.ctx.close();
});
