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
import { noHorizontalScroll, PASSWORD, uniqueEmail } from './helpers.ts';
import { saveScreenshot } from './redact-qr.ts';

// Phase 7 browser checks: audit-integrity page, personal-data export, recovery-code regeneration,
// super-admin two-step reset. Synthetic accounts in the throw-away E2E database only.

const SHOTS = path.resolve('docs/phase-7/screenshots');
mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, name: string) => {
  await page.evaluate(() => window.scrollTo(0, 0));
  await saveScreenshot(page, path.join(SHOTS, `${name}.png`), true);
};
/** TOTP code `offset` 30-second steps ahead (each step is accepted once per account). */
const totp = (secret: string, offset = 0) => new TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: Secret.fromBase32(secret) }).generate({ timestamp: Date.now() + offset * 30_000 });
const opened: import('@playwright/test').BrowserContext[] = [];
test.afterEach(async () => { await Promise.all(opened.splice(0).map((c) => c.close().catch(() => {}))); });
const ip = () => { const b = randomBytes(3); return `10.${b[0]}.${b[1]}.${b[2]}`; };

async function invite(roles: RoleKey[], name: string) {
  const env = JSON.parse(readFileSync('test-results/e2e-env.json', 'utf8'));
  const db = new pg.Pool({ connectionString: env.databaseUrl, max: 2 });
  const config = { env: 'development', appOrigin: env.appOrigin, tokenHmacKey: Buffer.from(env.tokenHmacKey, 'base64'), dataEncryptionKey: Buffer.from(env.dataEncryptionKey, 'base64') } as Config;
  try {
    const email = uniqueEmail(roles[0]!.replace('_', ''));
    const { userId, setupLink } = await createStaffAccount({ config, db, mailer: new MemoryMailer() }, {
      email, roles, locale: 'en', meta: { actorUserId: null, actorRole: 'system_cli', ip: null, userAgent: 'e2e', requestId: null },
    });
    await db.query('UPDATE users SET full_name = $2 WHERE id = $1', [userId, name]);
    return { email, setupLink, userId };
  } finally {
    await db.end();
  }
}

/** Privileged account with password set, signed in and MFA enrolled; returns the secret too. */
async function privileged(browser: Browser, roles: RoleKey[], name: string, lang: 'en' | 'ar' = 'en') {
  const { email, setupLink, userId } = await invite(roles, name);
  const ctx = await browser.newContext();
  opened.push(ctx);
  await ctx.setExtraHTTPHeaders({ 'x-forwarded-for': ip() });
  const page = await ctx.newPage();
  const token = /#token=([A-Za-z0-9_-]+)/.exec(setupLink)![1];
  await page.goto(lang === 'ar' ? '/ar/traced/admin/sign-in/' : '/traced/admin/sign-in/');
  const s = await page.evaluate(async ({ token, email, password }) => {
    const post = (url: string, body: unknown, csrf?: string) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, body: JSON.stringify(body) }).then((r) => r.json());
    await post('/api/v1/auth/account-setup', { token, password });
    const signIn = await post('/api/v1/auth/sign-in', { email, password });
    const setup = await post('/api/v1/auth/mfa/setup', {}, signIn.csrfToken);
    return { secret: setup.secret as string, csrf: signIn.csrfToken as string };
  }, { token, email, password: PASSWORD });
  await page.evaluate(async ({ code, csrf }) => {
    await fetch('/api/v1/auth/mfa/enable', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ code }) });
  }, { code: totp(s.secret), csrf: s.csrf });
  return { page, email, userId, secret: s.secret };
}

test('audit integrity: super admin signs a checkpoint and verification passes; auditor sees it read-only', async ({ browser }) => {
  const sa = await privileged(browser, ['super_admin'], 'Integrity Super Admin');
  await sa.page.goto('/traced/admin/audit-integrity/');
  await expect(sa.page.getByRole('heading', { level: 1, name: 'Audit integrity' })).toBeVisible();
  await expect(sa.page.getByText('Signing key configured')).toBeVisible();
  await sa.page.getByRole('button', { name: 'Sign a checkpoint now' }).click();
  await expect(sa.page.getByText('Checkpoint signed and recorded.')).toBeVisible();
  await sa.page.getByRole('button', { name: 'Run verification now' }).click();
  await expect(sa.page.getByText(/Verification passed\. Audit entries checked: \d+\. Checkpoints checked: 1\./)).toBeVisible();
  await noHorizontalScroll(sa.page);
  await shot(sa.page, 'audit-integrity-en');

  const auditor = await privileged(browser, ['auditor'], 'Integrity Auditor', 'ar');
  await auditor.page.goto('/ar/traced/admin/audit-integrity/');
  await expect(auditor.page.getByRole('heading', { level: 1, name: 'سلامة سجل التدقيق' })).toBeVisible();
  await expect(auditor.page.getByRole('button', { name: 'تشغيل التحقق الآن' })).toBeVisible();
  await expect(auditor.page.getByRole('button', { name: 'توقيع نقطة تحقق الآن' })).toHaveCount(0);
  await expect(auditor.page.getByRole('link', { name: 'تصدير البيانات الشخصية' })).toHaveCount(0);
  await shot(auditor.page, 'audit-integrity-ar-auditor');
});

test('personal-data export: needs columns, reason and a current code; downloads a CSV and records it', async ({ browser }) => {
  const sa = await privileged(browser, ['super_admin'], 'Export Super Admin');
  await sa.page.goto('/traced/admin/exports/');
  await expect(sa.page.getByRole('heading', { level: 1, name: 'Personal-data export' })).toBeVisible();
  await sa.page.getByRole('button', { name: 'Download CSV' }).click();
  await expect(sa.page.getByText('Choose at least one item of personal data.')).toBeVisible();
  await sa.page.getByLabel('Patient gender').check();
  await sa.page.getByLabel('Reason').fill('E2E synthetic export check');
  await shot(sa.page, 'pii-export-form-en'); // before the code is typed
  await sa.page.getByLabel('Authenticator code').fill(totp(sa.secret, 1));
  const [download] = await Promise.all([sa.page.waitForEvent('download'), sa.page.getByRole('button', { name: 'Download CSV' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^traced-personal-data-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = readFileSync((await download.path())!, 'utf8');
  expect(text.split('\r\n')[0]).toBe('﻿tracking_id,registered_date_riyadh,status,branch_code,current_sample_id,patient_gender');
  await expect(sa.page.getByText(/Downloaded \d+ registrations\./)).toBeVisible();
  // The same code cannot be used twice.
  await sa.page.getByLabel('Reason').fill('E2E synthetic export check again');
  await sa.page.getByLabel('Authenticator code').fill(totp(sa.secret, 1));
  await sa.page.getByRole('button', { name: 'Download CSV' }).click();
  await expect(sa.page.locator('.p-alert--error')).toBeVisible();

  const admin = await privileged(browser, ['admin'], 'Export Plain Admin');
  await admin.page.goto('/traced/admin/audit/');
  await expect(admin.page.getByRole('link', { name: 'Personal-data export' })).toHaveCount(0);
});

test('recovery codes can be replaced from settings; super admin resets another person’s two-step verification', async ({ browser }) => {
  const sa = await privileged(browser, ['super_admin'], 'Reset Super Admin');
  await sa.page.goto('/traced/admin/settings/');
  await sa.page.getByRole('heading', { name: 'Recovery codes' }).scrollIntoViewIfNeeded();
  await sa.page.locator('section[aria-labelledby="rcodes"] input').fill(totp(sa.secret, 1));
  await sa.page.getByRole('button', { name: 'Create new recovery codes' }).click();
  await expect(sa.page.locator('section[aria-labelledby="rcodes"] .p-recovery li')).toHaveCount(10);

  const lab = await privileged(browser, ['lab_operator'], 'Reset Lab Operator');
  await sa.page.goto(`/traced/admin/staff-member/?id=${lab.userId}`);
  await sa.page.getByText('Reset two-step verification', { exact: true }).first().click();
  await sa.page.locator('details[open] textarea').fill('Lost phone; identity confirmed by call');
  await sa.page.locator('details[open]').getByRole('button', { name: 'Reset two-step verification' }).click();
  await expect(sa.page.getByText('Two-step verification was reset. The person must set it up again at the next sign-in.')).toBeVisible();
  await expect(sa.page.getByText('Reset two-step verification', { exact: true })).toHaveCount(0); // no longer enrolled
  await shot(sa.page, 'staff-mfa-reset-en');
  // The lab operator's old session is gone.
  expect(await lab.page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(401);
  // Own account: no reset action offered.
  const self = await sa.page.evaluate(async () => (await (await fetch('/api/v1/auth/me')).json()).user.id);
  await sa.page.goto(`/traced/admin/staff-member/?id=${self}`);
  await expect(sa.page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(sa.page.getByText('Reset two-step verification', { exact: true })).toHaveCount(0);
});
