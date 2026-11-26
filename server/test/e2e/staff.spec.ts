/// <reference lib="dom" />
import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import pg from 'pg';
import type { Config } from '../../src/config.ts';
import { createStaffAccount } from '../../src/modules/accounts/accounts.service.ts';
import { MemoryMailer } from '../../src/modules/mail/mailer.ts';
import { decodeQrPng } from '../helpers/registration.ts';
import { writeBlankCamera, writeQrCamera } from './fake-camera.ts';
import { noHorizontalScroll, PASSWORD, signUpAndSignIn, uniqueEmail } from './helpers.ts';
import path from 'node:path';

const SHOTS = path.resolve('docs/phase-4/screenshots');
const shot = async (page: Page, name: string, fullPage = true) => {
  if (fullPage) await page.evaluate(() => window.scrollTo(0, 0)); // sticky header would otherwise be captured mid-page
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage });
};

/** Creates an invited staff account in the E2E database (as the CLI / Phase 5 admin portal would). */
async function inviteStaff(name: string, branchCodes: string[], locale: 'en' | 'ar' = 'en') {
  const env = JSON.parse(readFileSync('test-results/e2e-env.json', 'utf8'));
  const db = new pg.Pool({ connectionString: env.databaseUrl, max: 2 });
  try {
    const config = { env: 'development', appOrigin: env.appOrigin, tokenHmacKey: Buffer.from(env.tokenHmacKey, 'base64'), dataEncryptionKey: Buffer.from(env.dataEncryptionKey, 'base64') } as Config;
    const email = uniqueEmail('staff');
    const { userId, setupLink } = await createStaffAccount({ config, db, mailer: new MemoryMailer() }, {
      email, roles: ['collection_staff'], locale, meta: { actorUserId: null, actorRole: 'system_cli', ip: null, userAgent: 'e2e', requestId: null },
    });
    await db.query('UPDATE users SET full_name = $2 WHERE id = $1', [userId, name]);
    for (const code of branchCodes) {
      await db.query('INSERT INTO staff_branch_assignments (user_id, branch_id) SELECT $1, id FROM collection_branches WHERE code = $2', [userId, code]);
    }
    return { email, setupLink };
  } finally {
    await db.end();
  }
}

/** A customer (own browser context) with a child registration at the Riyadh dev branch; returns the QR text. */
async function customerWithQr(browser: Browser, firstName = 'Layla') {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signUpAndSignIn(page, 'en', uniqueEmail('cust'));
  const reg = await page.evaluate(async (fn) => {
    const me = await (await fetch('/api/v1/auth/me')).json();
    const form = await (await fetch('/api/v1/me/registration-form?locale=en')).json();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());
    const dob = `${Number(today.slice(0, 4)) - 8}-01-10`;
    const res = await fetch('/api/v1/me/registrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrfToken, 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ relationship: 'child', patient: { firstName: fn, lastName: 'Alfahad', dateOfBirth: dob, gender: 'female' },
        contact: { fullName: 'Guardianname Alfahad', phone: '0551239876' }, branchId: form.branches[0].id, consentDocumentIds: form.consents.map((c: { id: string }) => c.id) }),
    });
    return (await res.json()).registration as { id: string; trackingId: string };
  }, firstName);
  const png = await page.request.get(`/api/v1/me/registrations/${reg.id}/qr.png`);
  const text = decodeQrPng(Buffer.from(await png.body()))!;
  return { page, ctx, reg, text };
}

async function staffSignIn(page: Page, email: string, lang: 'en' | 'ar' = 'en') {
  await page.goto(`${lang === 'ar' ? '/ar' : ''}/traced/staff/sign-in/`);
  await page.getByLabel(lang === 'ar' ? 'البريد الإلكتروني' : 'Email address', { exact: true }).fill(email);
  await page.getByLabel(lang === 'ar' ? 'كلمة المرور' : 'Password', { exact: true }).fill(PASSWORD);
  await page.locator('form').getByRole('button', { name: lang === 'ar' ? 'تسجيل الدخول' : 'Sign in' }).click();
  await page.waitForURL(`**${lang === 'ar' ? '/ar' : ''}/traced/staff/`);
}

test.afterEach(() => writeBlankCamera());

test('staff invitation → account setup → sign in → dashboard', async ({ page }) => {
  const { email, setupLink } = await inviteStaff('Sara Alqahtani', ['DEV-RUH-01', 'DEV-JED-01']);
  await page.goto(setupLink);
  expect(page.url()).not.toContain('token=');
  await expect(page.getByRole('heading', { name: 'Set up your account' })).toBeVisible();
  await page.getByLabel('New password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Activate account' }).click();
  await expect(page.getByText('Your account is ready. You can now sign in.')).toBeVisible();

  await page.getByRole('link', { name: 'Go to sign in' }).click();
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await shot(page, '01-staff-sign-in-en');
  await page.locator('form').getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/traced/staff/');
  await expect(page.getByRole('heading', { name: 'Hello, Sara' })).toBeVisible();
  await expect(page.getByLabel('Collection branch')).toBeVisible(); // two branches → selector
  await expect(page.getByText('Collected at this branch today')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Staff navigation' })).toBeVisible();
  await shot(page, '02-staff-dashboard-en');
});

test('full collection with the simulated camera: scan → age/gender only → verify → checklist → confirm → history → customer view', async ({ page, browser }) => {
  const cust = await customerWithQr(browser, 'Layla');
  const { email, setupLink } = await inviteStaff('Omar Staff', ['DEV-RUH-01']);
  await page.goto(setupLink);
  await page.getByLabel('New password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Activate account' }).click();
  await staffSignIn(page, email);

  await page.getByRole('link', { name: 'Scan QR code' }).click();
  await page.waitForURL('**/traced/staff/scan/');
  await shot(page, '03-scanner-idle-en');
  await writeQrCamera(cust.text); // the "customer" holds their QR up to the camera
  await page.getByRole('button', { name: 'Start camera' }).click();

  // Result: tracking ID, age, gender, sample type, status, branch — and nothing personal.
  await expect(page.getByRole('heading', { name: 'Valid QR code' })).toBeVisible({ timeout: 20_000 });
  const camLive = await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement | null)?.srcObject ?? null);
  expect(camLive).toBeNull(); // camera released after a successful read
  await expect(page.locator('main')).toContainText(cust.reg.trackingId);
  await expect(page.locator('main')).toContainText('8 years');
  await expect(page.locator('main')).toContainText('Female');
  await expect(page.locator('main')).toContainText('Awaiting sample collection');
  const text = await page.locator('main').innerText();
  for (const pii of ['Layla', 'Alfahad', 'Guardianname', '551239876', '-01-10', cust.text]) expect(text).not.toContain(pii);
  await expect(page.getByText('Not verified', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm sample collected' })).toBeDisabled();
  await shot(page, '04-scan-result-en');

  // Identity (development-only simulation) and checklist.
  await page.getByRole('button', { name: 'Verified', exact: true }).click();
  await expect(page.getByText('Verified', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm sample collected' })).toBeDisabled(); // checklist still empty
  for (const box of await page.locator('fieldset input[type=checkbox]').all()) await box.check();
  await expect(page.getByRole('button', { name: 'Confirm sample collected' })).toBeEnabled();
  await shot(page, '05-ready-to-collect-en');
  await page.getByRole('button', { name: 'Confirm sample collected' }).click();
  await expect(page.getByRole('heading', { name: 'Sample collected' })).toBeVisible();
  await expect(page.locator('main')).toContainText(cust.reg.trackingId);
  await shot(page, '06-collection-confirmed-en');

  // Scanning the same QR again is refused.
  await page.getByRole('button', { name: 'Scan another QR code' }).click();
  await writeQrCamera(cust.text);
  await page.getByRole('button', { name: 'Start camera' }).click();
  await expect(page.getByText('A sample has already been collected for this registration.')).toBeVisible({ timeout: 20_000 });
  await shot(page, '07-already-collected-en');

  // History.
  await page.getByRole('link', { name: 'History' }).click();
  await expect(page.locator('.p-item').first()).toContainText(cust.reg.trackingId);
  await expect(page.locator('.p-item').first()).toContainText('Sample collected');
  expect(await page.locator('main').innerText()).not.toMatch(/Layla|Alfahad|Guardianname/);
  await shot(page, '08-collection-history-en');

  // The customer's own page now shows the collection (the page refreshes itself; reload here).
  await cust.page.goto(`/traced/account/registration/?id=${cust.reg.id}`);
  await expect(cust.page.getByText('Sample collected', { exact: true }).first()).toBeVisible();
  await expect(cust.page.getByText('This QR code was used when the sample was collected and is no longer valid.')).toBeVisible();
  await expect(cust.page.locator('img.p-qr')).toHaveCount(0);
  await shot(cust.page, '09-customer-after-collection-en');
  await cust.ctx.close();
});

test('invalid input: unknown QR, tracking ID only, and a non-TRACED code', async ({ page }) => {
  const { email, setupLink } = await inviteStaff('Invalid Tester', ['DEV-RUH-01']);
  await page.goto(setupLink);
  await page.getByLabel('New password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Activate account' }).click();
  await staffSignIn(page, email);
  await page.goto('/traced/staff/scan/');

  const manual = page.getByLabel('QR code content');
  await manual.fill(`http://localhost:8791/traced/c/#c1_${'A'.repeat(43)}`);
  await manual.press('Enter'); // keyboard / USB scanner path
  await expect(page.getByText('This QR code is not recognised.')).toBeVisible();
  await shot(page, '10-invalid-qr-en');
  await page.getByRole('button', { name: 'Scan another QR code' }).click();

  await page.getByLabel('QR code content').fill('TRC-SA-11/26-00001');
  await page.getByRole('button', { name: 'Check code' }).click();
  await expect(page.getByText('A tracking ID can’t be used to collect a sample.')).toBeVisible();

  await writeQrCamera('https://example.com/some/other/link'); // arbitrary URL in a QR: never opened
  await page.getByRole('button', { name: 'Start camera' }).click();
  await expect(page.getByText('This is not a TRACED customer QR code.')).toBeVisible({ timeout: 20_000 });
  expect(page.url()).toContain('/traced/staff/scan/');
});

test('camera errors: permission denied and no camera', async ({ page }) => {
  const { email, setupLink } = await inviteStaff('Camera Tester', ['DEV-RUH-01']);
  await page.goto(setupLink);
  await page.getByLabel('New password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Activate account' }).click();
  await staffSignIn(page, email);

  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', (window as unknown as { __camErr?: string }).__camErr ?? 'NotAllowedError'));
  });
  await page.goto('/traced/staff/scan/');
  await page.getByRole('button', { name: 'Start camera' }).click();
  await expect(page.getByText('Camera access was denied.', { exact: false })).toBeVisible();
  await shot(page, '11-camera-permission-denied-en');

  await page.addInitScript(() => { (window as unknown as { __camErr?: string }).__camErr = 'NotFoundError'; });
  await page.goto('/traced/staff/scan/');
  await page.getByRole('button', { name: 'Start camera' }).click();
  await expect(page.getByText('No camera was found on this device.', { exact: false })).toBeVisible();
});

test('access control in the browser: customers can’t use the staff portal; staff are routed to it', async ({ page, browser }) => {
  const cust = await customerWithQr(browser, 'Huda');
  await cust.page.goto('/traced/staff/scan/');
  await expect(cust.page.getByRole('heading', { name: 'No access' })).toBeVisible();
  await expect(cust.page.locator('video')).toHaveCount(0);
  await cust.ctx.close();

  const { email, setupLink } = await inviteStaff('Routing Tester', ['DEV-RUH-01']);
  await page.goto(setupLink);
  await page.getByLabel('New password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Activate account' }).click();
  await page.goto('/traced/account/sign-in/');
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.locator('form').getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/traced/staff/'); // staff signing in on the customer page land in their portal
  await page.goto('/traced/staff/sign-in/');
  await page.waitForURL('**/traced/staff/');
});

test('Arabic staff portal is right-to-left and fully Arabic', async ({ page, browser }) => {
  const cust = await customerWithQr(browser, 'Noura');
  const { email, setupLink } = await inviteStaff('ريم العتيبي', ['DEV-RUH-01'], 'ar');
  await page.goto(setupLink);
  await page.getByLabel('كلمة المرور الجديدة').fill(PASSWORD);
  await page.getByRole('button', { name: 'تفعيل الحساب' }).click();
  await staffSignIn(page, email, 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { name: 'مرحبًا، ريم' })).toBeVisible();
  await shot(page, '12-staff-dashboard-ar');
  await page.getByRole('link', { name: 'مسح رمز QR' }).click();
  await writeQrCamera(cust.text);
  await page.getByRole('button', { name: 'تشغيل الكاميرا' }).click();
  await expect(page.getByRole('heading', { name: 'رمز QR صالح' })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('main')).toContainText('أنثى');
  await expect(page.locator('main')).toContainText('لم يتم التحقق');
  expect(await page.locator('main').innerText()).not.toMatch(/Noura|Alfahad|Guardianname/);
  await shot(page, '13-scan-result-ar');
  await cust.ctx.close();
});

test.describe('mobile staff portal (375 × 812)', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test('dashboard, live scanner, result and history fit the screen', async ({ page: first, browser }) => {
    let page = first;
    const cust = await customerWithQr(browser, 'Sara');
    const { email, setupLink } = await inviteStaff('Mobile Staff', ['DEV-RUH-01']);
    await page.goto(setupLink);
    await page.getByLabel('New password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Activate account' }).click();
    await staffSignIn(page, email);
    await noHorizontalScroll(page);
    await shot(page, '14-mobile-staff-dashboard');

    await page.goto('/traced/staff/scan/');
    await writeBlankCamera(); // live preview without a code first
    await page.getByRole('button', { name: 'Start camera' }).click();
    await expect(page.locator('video')).toBeVisible();
    await page.waitForTimeout(800);
    await noHorizontalScroll(page);
    await shot(page, '15-mobile-scanner-live', false);
    await page.getByRole('button', { name: 'Stop camera' }).click();
    expect(await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement | null)?.srcObject ?? null)).toBeNull();

    // Edge keeps reading the fake-camera file it opened, so load a fresh page for the QR video.
    await writeQrCamera(cust.text);
    const scanPage = await page.context().newPage();
    await scanPage.goto('/traced/staff/scan/');
    await page.close();
    page = scanPage;
    await page.getByRole('button', { name: 'Start camera' }).click();
    await expect(page.getByRole('heading', { name: 'Valid QR code' })).toBeVisible({ timeout: 20_000 });
    await noHorizontalScroll(page);
    await shot(page, '16-mobile-scan-result');
    await page.goto('/traced/staff/history/');
    await noHorizontalScroll(page);
    await cust.ctx.close();
  });
});
