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
import { decodeQrPng } from '../helpers/registration.ts';
import { writeBlankCamera, writeQrCamera } from './fake-camera.ts';
import { noHorizontalScroll, PASSWORD, signUpAndSignIn, uniqueEmail } from './helpers.ts';
import { saveScreenshot } from './redact-qr.ts';

// File name sorts after staff.spec.ts on purpose: Edge shares one fake camera device per browser
// process, and a page that opened it earlier can leave later camera tests reading a stale video.
// Phase 6 end to end: registration → collection → physical sample ID + label → packaging →
// dispatch → laboratory receipt (simulated camera on the real sample QR) → analysis → report
// available → customer timeline; plus rejection and admin-authorised recollection.
const SHOTS = path.resolve('docs/phase-6/screenshots');
mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, name: string) => {
  await page.evaluate(() => window.scrollTo(0, 0));
  await saveScreenshot(page, path.join(SHOTS, `${name}.png`)); // retries + QR redaction
};
const ip = () => { const b = randomBytes(3); return `10.${b[0]}.${b[1]}.${b[2]}`; };
const totp = (secret: string) => new TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: Secret.fromBase32(secret) }).generate();

async function invite(roles: RoleKey[], name: string, branchCodes: string[] = []) {
  const env = JSON.parse(readFileSync('test-results/e2e-env.json', 'utf8'));
  const db = new pg.Pool({ connectionString: env.databaseUrl, max: 2 });
  try {
    const config = { env: 'development', appOrigin: env.appOrigin, tokenHmacKey: Buffer.from(env.tokenHmacKey, 'base64'), dataEncryptionKey: Buffer.from(env.dataEncryptionKey, 'base64') } as Config;
    const email = uniqueEmail(roles[0]!.replace('_', ''));
    const { userId, setupLink } = await createStaffAccount({ config, db, mailer: new MemoryMailer() }, { email, roles, locale: 'en', meta: { actorUserId: null, actorRole: 'system_cli', ip: null, userAgent: 'e2e', requestId: null } });
    await db.query('UPDATE users SET full_name = $2 WHERE id = $1', [userId, name]);
    for (const code of branchCodes) await db.query('INSERT INTO staff_branch_assignments (user_id, branch_id) SELECT $1, id FROM collection_branches WHERE code = $2', [userId, code]);
    return { email, token: /#token=([A-Za-z0-9_-]+)/.exec(setupLink)![1]! };
  } finally {
    await db.end();
  }
}

/** Signed-in browser context for a staff-side role (MFA enrolled through the API for privileged roles). */
async function signedIn(browser: Browser, roles: RoleKey[], name: string, branches: string[] = [], viewport?: { width: number; height: number }) {
  const { email, token } = await invite(roles, name, branches);
  const ctx = await browser.newContext(viewport ? { viewport, isMobile: true } : {});
  await ctx.setExtraHTTPHeaders({ 'x-forwarded-for': ip() });
  const page = await ctx.newPage();
  await page.addInitScript(() => { (window as unknown as { __printed: number }).__printed = 0; window.print = () => { (window as unknown as { __printed: number }).__printed++; }; });
  await page.goto('/traced/staff/sign-in/');
  const secret = await page.evaluate(async ({ token, email, password, mfa }) => {
    const post = (url: string, body: unknown, csrf?: string) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, body: JSON.stringify(body) });
    await post('/api/v1/auth/account-setup', { token, password });
    const s = await (await post('/api/v1/auth/sign-in', { email, password })).json();
    if (!mfa) return null;
    const setup = await (await post('/api/v1/auth/mfa/setup', {}, s.csrfToken)).json();
    return { secret: setup.secret as string, csrf: s.csrfToken as string };
  }, { token, email, password: PASSWORD, mfa: !roles.includes('collection_staff') });
  if (secret) await page.evaluate(async ({ code, csrf }) => { await fetch('/api/v1/auth/mfa/enable', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ code }) }); }, { code: totp(secret.secret), csrf: secret.csrf });
  return { ctx, page };
}

async function customerRegistration(browser: Browser, firstName: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signUpAndSignIn(page, 'en', uniqueEmail('cust'));
  const reg = await page.evaluate(async (fn) => {
    const me = await (await fetch('/api/v1/auth/me')).json();
    const form = await (await fetch('/api/v1/me/registration-form?locale=en')).json();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());
    const res = await fetch('/api/v1/me/registrations', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrfToken, 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ relationship: 'child', patient: { firstName: fn, lastName: 'Alqahtani', dateOfBirth: `${Number(today.slice(0, 4)) - 7}-02-14`, gender: 'female' },
        contact: { fullName: 'Maha Alqahtani', phone: '0551234500' }, branchId: form.branches.find((b: { code: string }) => b.code === 'DEV-RUH-01').id, consentDocumentIds: form.consents.map((c: { id: string }) => c.id) }) });
    return (await res.json()).registration as { id: string; trackingId: string };
  }, firstName);
  const png = await page.request.get(`/api/v1/me/registrations/${reg.id}/qr.png`);
  return { ctx, page, reg, qrText: decodeQrPng(Buffer.from(await png.body()))! };
}

/** Staff: collect through the existing flow using manual entry of the customer QR content. */
async function collectInBrowser(page: Page, qrText: string) {
  await page.goto('/traced/staff/scan/');
  await page.getByLabel('QR code content').fill(qrText);
  await page.getByRole('button', { name: 'Check code' }).click();
  await page.getByRole('button', { name: 'Verified' }).click();
  for (const box of await page.getByRole('checkbox').all()) await box.check();
  await page.getByRole('button', { name: 'Confirm sample collected' }).click();
  await expect(page.getByRole('link', { name: 'Print sample label' })).toBeVisible();
  return (await page.locator('strong.p-ltr').last().textContent())!;
}

async function staffAction(page: Page, sampleId: string, label: string, extra?: (form: ReturnType<Page['locator']>) => Promise<void>) {
  await page.getByLabel('Sample label content or sample ID').fill(sampleId);
  const scanned = page.waitForResponse((r) => r.url().endsWith('/api/v1/staff/samples/scan'));
  await page.getByRole('button', { name: 'Find sample' }).click();
  await scanned; // the sample card re-renders when the scan returns; fill the fresh form only
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: label }) });
  if (extra) await extra(form);
  await form.getByRole('checkbox').check();
  await form.getByRole('button', { name: label }).click();
  await expect(page.getByText(/^Recorded:/)).toBeVisible();
}

test.afterEach(() => writeBlankCamera());

test('full chain of custody: collection → label → package → dispatch → lab receipt (camera) → analysis → report → customer timeline → admin record', async ({ browser }) => {
  test.setTimeout(240_000); // four roles and the whole journey in one test
  const cust = await customerRegistration(browser, 'Danah');
  const staff = await signedIn(browser, ['collection_staff'], 'Ruba Collector', ['DEV-RUH-01']);
  const sampleId = await collectInBrowser(staff.page, cust.qrText);
  expect(sampleId).toBe(`${cust.reg.trackingId}-S01`);
  await shot(staff.page, 'b01-collection-confirmed-sample-id');

  // Label: preview, print (recorded), reprint needs a reason.
  await staff.page.getByRole('link', { name: 'Print sample label' }).click();
  await expect(staff.page.getByRole('heading', { name: 'Sample label' })).toBeVisible();
  await expect(staff.page.locator('.p-slabel__id')).toHaveText(sampleId);
  await expect(staff.page.locator('.p-slabel')).not.toContainText('Danah');
  await staff.page.getByRole('button', { name: 'Print label' }).click();
  await expect(staff.page.getByText('Printed 1 time(s).')).toBeVisible();
  expect(await staff.page.evaluate(() => (window as unknown as { __printed: number }).__printed)).toBe(1);
  await staff.page.getByRole('button', { name: 'Reprint label' }).click();
  await expect(staff.page.getByText('Enter a reason for reprinting this label (at least 5 characters).')).toBeVisible();
  await staff.page.getByLabel('Reason for reprinting').fill('First label was smudged');
  await staff.page.getByRole('button', { name: 'Reprint label' }).click();
  await expect(staff.page.getByText('Printed 2 time(s).')).toBeVisible();
  await shot(staff.page, 'b02-sample-label-50x30');
  // The real sample QR content, decoded from the label image (independent of screenshot redaction).
  const sampleRowId = new URL(staff.page.url()).searchParams.get('id')!;
  const qrPng = await staff.page.request.get(`/api/v1/staff/samples/${sampleRowId}/qr.png`);
  const sampleQr = decodeQrPng(Buffer.from(await qrPng.body()))!;
  expect(sampleQr).toMatch(/\/traced\/s\/#s1_[A-Za-z0-9_-]{43}$/);

  // Branch custody on the Samples page.
  await staff.page.goto('/traced/staff/samples/');
  await staffAction(staff.page, sampleId, 'Confirm packaging');
  await staffAction(staff.page, sampleId, 'Mark ready for dispatch');
  await staffAction(staff.page, sampleId, 'Record dispatch', async (form) => {
    await form.getByLabel('Courier company').fill('SMSA Express');
    await form.getByLabel('Shipment tracking number').fill('SMSA-0001-TEST');
  });
  await expect(staff.page.locator('.p-badge').filter({ hasText: 'Dispatched' }).first()).toBeVisible();
  await expect(staff.page.getByText('Female')).toBeVisible(); // age/gender only
  await expect(staff.page.getByText('Danah')).toHaveCount(0);
  await shot(staff.page, 'b03-staff-samples-dispatched');

  // Laboratory: dashboard shows the expected sample; receipt via the simulated camera.
  const lab = await signedIn(browser, ['lab_operator'], 'Laila Lab');
  await lab.page.goto('/traced/lab/');
  await expect(lab.page.getByRole('link', { name: sampleId })).toBeVisible();
  await expect(lab.page.getByText('SMSA-0001-TEST')).toBeVisible();
  await shot(lab.page, 'b04-lab-dashboard-incoming');
  await lab.page.goto('/traced/lab/scan/');
  await writeQrCamera(sampleQr); // the operator holds the sample label up to the camera
  await lab.page.getByRole('button', { name: 'Scan with camera' }).click();
  await expect(lab.page.getByRole('heading', { name: sampleId })).toBeVisible({ timeout: 20_000 }); // camera decode (as in the staff tests)
  await expect(lab.page.locator('video')).toBeHidden(); // camera released after the read
  await expect(lab.page.getByText('Danah')).toHaveCount(0);
  await expect(lab.page.getByText('Female')).toHaveCount(0); // no patient data for the lab
  const receipt = lab.page.locator('form').filter({ has: lab.page.getByRole('heading', { name: 'Receipt' }) });
  await receipt.getByLabel('Intact', { exact: true }).check();
  await receipt.getByRole('checkbox').check();
  await shot(lab.page, 'b05-lab-receipt');
  await receipt.getByRole('button', { name: 'Confirm' }).click();
  await expect(lab.page.getByText('Recorded: Received by laboratory.')).toBeVisible();
  for (const label of ['Start analysis', 'Complete analysis', 'Mark report available']) {
    const f = lab.page.locator('form').filter({ has: lab.page.getByRole('button', { name: label }) });
    await f.getByRole('checkbox').check();
    await f.getByRole('button', { name: label }).click();
    await expect(lab.page.getByText(/^Recorded:/)).toBeVisible();
  }
  await expect(lab.page.locator('.p-badge').filter({ hasText: 'Report available' })).toBeVisible();
  await shot(lab.page, 'b06-lab-report-available');

  // Customer timeline (dates only, no internals).
  await cust.page.goto(`/traced/account/registration/?id=${cust.reg.id}`);
  for (const step of ['Registration completed', 'Sample collected', 'Sample sent to the laboratory', 'Received by the laboratory', 'Analysis in progress', 'Analysis completed', 'Report available']) {
    await expect(cust.page.locator('.p-timeline li').filter({ hasText: step }).first()).toBeVisible();
  }
  await expect(cust.page.getByText('SMSA')).toHaveCount(0);
  await expect(cust.page.getByText('Laila')).toHaveCount(0);
  await shot(cust.page, 'b07-customer-timeline-report-available');

  // Admin: sample list and the full custody record.
  const admin = await signedIn(browser, ['admin'], 'Custody Admin');
  await admin.page.goto(`/traced/admin/samples/?q=${encodeURIComponent(sampleId)}`);
  await admin.page.getByRole('button', { name: 'Search' }).click();
  await admin.page.getByRole('link', { name: sampleId }).click();
  await expect(admin.page.getByRole('heading', { name: 'Custody timeline' })).toBeVisible();
  await expect(admin.page.getByText('SMSA-0001-TEST').first()).toBeVisible();
  await expect(admin.page.getByText('First label was smudged')).toBeVisible();
  await shot(admin.page, 'b08-admin-sample-record');
  for (const c of [cust, staff, lab, admin]) await c.ctx.close();
});

test('rejection and admin-authorised recollection: rejected sample kept, new QR, new -S02 after fresh collection', async ({ browser }) => {
  test.setTimeout(180_000);
  const cust = await customerRegistration(browser, 'Jana');
  const staff = await signedIn(browser, ['collection_staff'], 'Ruba Collector', ['DEV-RUH-01']);
  const sampleId = await collectInBrowser(staff.page, cust.qrText);
  await staff.page.goto('/traced/staff/samples/');
  await staffAction(staff.page, sampleId, 'Confirm packaging');
  await staffAction(staff.page, sampleId, 'Mark ready for dispatch');
  await staffAction(staff.page, sampleId, 'Record dispatch', async (form) => {
    await form.getByLabel('Courier company').fill('Aramex');
    await form.getByLabel('Shipment tracking number').fill('ARX-9999-TEST');
  });
  const lab = await signedIn(browser, ['lab_operator'], 'Laila Lab');
  await lab.page.goto(`/traced/lab/scan/?sample=${encodeURIComponent(sampleId)}`);
  const receipt = lab.page.locator('form').filter({ has: lab.page.getByRole('heading', { name: 'Receipt' }) });
  await receipt.getByLabel('Damaged', { exact: true }).check();
  await receipt.getByLabel('Reject sample').check();
  await receipt.getByLabel('Rejection reason').selectOption('damaged_packaging');
  await receipt.getByLabel('Remarks').fill('Internal: outer bag torn');
  await receipt.getByRole('checkbox').check();
  await receipt.getByRole('button', { name: 'Confirm' }).click();
  await expect(lab.page.getByText('Recorded: Rejected.')).toBeVisible();
  await shot(lab.page, 'b09-lab-rejected');

  await cust.page.goto(`/traced/account/registration/?id=${cust.reg.id}`);
  await expect(cust.page.locator('.p-timeline li').filter({ hasText: 'Issue with the sample' })).toBeVisible();
  await expect(cust.page.getByText('outer bag torn')).toHaveCount(0);

  const admin = await signedIn(browser, ['admin'], 'Custody Admin');
  await admin.page.goto(`/traced/admin/samples/?q=${encodeURIComponent(sampleId)}`);
  await admin.page.getByRole('button', { name: 'Search' }).click();
  await admin.page.getByRole('link', { name: sampleId }).click();
  await admin.page.getByText('Authorise recollection', { exact: true }).first().click();
  const form = admin.page.locator('details[open]');
  await form.getByLabel('Reason').fill('Packaging damaged in transit');
  await form.getByRole('checkbox').check();
  await form.getByRole('button', { name: 'Authorise recollection' }).click();
  await expect(admin.page.getByText('Recollection authorised; the customer has been sent a new QR code.')).toBeVisible();
  await shot(admin.page, 'b10-admin-recollection-authorised');

  await cust.page.reload();
  await expect(cust.page.locator('.p-timeline li').filter({ hasText: 'New sample required' })).toBeVisible();
  await shot(cust.page, 'b11-customer-recollection-required');
  const png = await cust.page.request.get(`/api/v1/me/registrations/${cust.reg.id}/qr.png`);
  const newQr = decodeQrPng(Buffer.from(await png.body()))!;
  expect(newQr).not.toBe(cust.qrText);
  const second = await collectInBrowser(staff.page, newQr);
  expect(second).toBe(`${cust.reg.trackingId}-S02`);
  for (const c of [cust, staff, lab, admin]) await c.ctx.close();
});

test('Arabic laboratory portal (RTL) and mobile staff/lab sample pages fit the screen', async ({ browser }) => {
  const lab = await signedIn(browser, ['lab_operator'], 'مشغل مختبر');
  await lab.page.goto('/ar/traced/lab/');
  await expect(lab.page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(lab.page.getByRole('heading', { name: 'العينات الواردة المتوقعة' })).toBeVisible();
  await shot(lab.page, 'b12-lab-dashboard-ar');
  await lab.ctx.close();
  for (const [roles, pages, name] of [
    [['collection_staff'], ['/traced/staff/samples/', '/ar/traced/staff/samples/'], 'b13-mobile-staff-samples'],
    [['lab_operator'], ['/traced/lab/', '/traced/lab/scan/', '/traced/lab/history/', '/ar/traced/lab/scan/'], 'b14-mobile-lab-scan'],
  ] as [RoleKey[], string[], string][]) {
    const m = await signedIn(browser, roles, 'Mobile User', ['DEV-RUH-01'], { width: 375, height: 812 });
    for (const p of pages) {
      await m.page.goto(p);
      await expect(m.page.locator('#page-title')).toBeVisible();
      await m.page.waitForLoadState('networkidle');
      await noHorizontalScroll(m.page);
    }
    await shot(m.page, name);
    await m.ctx.close();
  }
});
