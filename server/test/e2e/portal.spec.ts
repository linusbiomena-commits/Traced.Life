/// <reference lib="dom" />
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { decodeQrPng } from '../helpers/registration.ts';
import { dobFor, latestMailFile, mailLink, noHorizontalScroll, PASSWORD, shot, signUpAndSignIn, uniqueEmail } from './helpers.ts';

test.describe('existing TRACED site', () => {
  test('header and footer link to the customer account in English and Arabic; nothing else changes', async ({ page }) => {
    await page.goto('/traced/');
    const nav = page.locator('header nav').first();
    await expect(nav.locator('a[data-traced-account-link][href$="/traced/account/"]')).toHaveText('My Account');
    await expect(nav.locator('a[data-traced-account-link][href$="/traced/account/"]')).toHaveAttribute('href', '/traced/account/');
    // Existing items keep their order; the language switch is still added at the end.
    await expect(nav.locator(':scope > ul > li')).toHaveText(['Shop', 'Learn', 'My Account', 'العربية'], { useInnerText: true });
    await expect(page.locator('footer a[href="/traced/account/"]')).toHaveCount(1);
    await expect(page.locator('a[href*="account.traced.life"]')).toHaveCount(0);
    await shot(page, '01-traced-home-header-en', false);

    await page.goto('/ar/traced/');
    const arNav = page.locator('header nav').first();
    await expect(arNav.locator('a[data-traced-account-link][href$="/traced/account/"]')).toHaveText('حسابي');
    await expect(arNav.locator('a[data-traced-account-link][href$="/traced/account/"]')).toHaveAttribute('href', '/ar/traced/account/');
    await shot(page, '02-traced-home-header-ar', false);

    await arNav.locator('a[data-traced-account-link][href$="/traced/account/"]').click();
    await page.waitForURL('**/ar/traced/account/sign-in/**');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  });
});

test('signed-out visitors are sent to sign-in and returned afterwards', async ({ page }) => {
  await page.goto('/traced/account/registrations/');
  await page.waitForURL('**/traced/account/sign-in/?next=%2Ftraced%2Faccount%2Fregistrations%2F');
  // An off-site "next" is ignored (no open redirect).
  await page.goto('/traced/account/sign-in/?next=https%3A%2F%2Fevil.example%2F');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('English: sign up, verify, sign in, empty dashboard, register a child, confirmation, list and details', async ({ page }) => {
  const email = uniqueEmail('en.flow');

  // Sign-up validation
  await page.goto('/traced/account/sign-up/');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.locator('.p-error-summary')).toBeFocused();
  await expect(page.locator('.p-error-summary li')).toHaveCount(3); // email, password, 18+ confirmation
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill('short');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Your password must be at least 12 characters.').first()).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await shot(page, '03-sign-up-validation-en');

  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('I confirm that I am 18 years of age or older.').check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await shot(page, '04-sign-up-check-email-en');

  // Signing in before verifying lands on the verification page with a resend option.
  await page.goto('/traced/account/sign-in/');
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.locator('form').getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/traced/account/verify-email/');
  await expect(page.getByRole('button', { name: 'Send a new link' })).toBeVisible();

  // Verify through the emailed link; the token is removed from the address bar.
  await page.goto(await mailLink(email, 'verify_email'));
  await expect(page.getByText('Email verified')).toBeVisible();
  expect(page.url()).not.toContain('token=');
  await page.getByRole('link', { name: 'Go to my account' }).click();

  // Dashboard empty state
  await page.waitForURL('**/traced/account/');
  await expect(page.getByRole('heading', { name: 'No registrations yet' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'My QR codes' })).toBeVisible();
  await expect(page.getByText('Your QR codes will appear here after you register.')).toBeVisible();
  await shot(page, '05-dashboard-empty-en');

  // Registration — step 1
  await page.getByRole('link', { name: 'New TRACED registration' }).first().click();
  await expect(page.getByRole('heading', { name: 'Who is this for?' })).toBeFocused();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('.p-error-summary')).toContainText('Choose an option.');
  await page.getByLabel(/My child/).check();
  await shot(page, '06-register-step1-en');
  await page.getByRole('button', { name: 'Continue' }).click();

  // Step 2 — patient, with live age and date checks
  await expect(page.getByRole('heading', { name: 'Child’s information' })).toBeVisible();
  await page.getByLabel('First name').fill('Layla');
  await page.getByLabel('Last name').fill('Al-Harbi');
  await page.getByLabel('Date of birth').fill('2999-01-01');
  await page.getByLabel('Female').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('.p-error-summary')).toContainText('The date of birth cannot be in the future.');
  await page.getByLabel('Date of birth').fill(dobFor(25));
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('.p-error-summary')).toContainText('A child must be under 18.');
  await page.getByLabel('Date of birth').fill(dobFor(7, 3));
  await expect(page.locator('.p-age')).toHaveText('Age: 7 years, 3 months');
  await shot(page, '07-register-step2-patient-en');
  await page.getByRole('button', { name: 'Continue' }).click();

  // Step 3 — contact: verified email is prefilled and read-only; Saudi mobile validated
  await expect(page.getByText('You are registering as the parent or authorised guardian.', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Email address', { exact: true })).toHaveValue(email);
  await expect(page.getByLabel('Email address', { exact: true })).toHaveAttribute('readonly', '');
  await page.getByLabel('Parent or guardian full name').fill('Fatimah Al-Harbi');
  await page.getByLabel('Mobile number', { exact: true }).fill('0112345678');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('.p-error-summary')).toContainText('Enter a Saudi mobile number');
  await page.getByLabel('Mobile number', { exact: true }).fill('055 123 4567');
  await shot(page, '08-register-step3-contact-en');
  await page.getByRole('button', { name: 'Continue' }).click();

  // Step 4 — collection: fixed product/sample/country, branches from the database
  await expect(page.getByText('Saudi Arabia')).toBeVisible();
  await expect(page.getByText('Hair', { exact: true })).toBeVisible();
  await page.getByLabel(/\[DEV\] Riyadh sample branch/).check();
  await shot(page, '09-register-step4-collection-en');
  await page.getByRole('button', { name: 'Continue' }).click();

  // Step 5 — consents (provisional texts are labelled), all required incl. guardian authorisation
  await expect(page.locator('.p-consent')).toHaveCount(4);
  await expect(page.getByText('Provisional draft – not legally approved').first()).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('.p-error-summary li')).toHaveCount(4);
  for (const box of await page.locator('.p-consent input[type=checkbox]').all()) await box.check();
  await shot(page, '10-register-step5-consent-en');
  await page.getByRole('button', { name: 'Continue' }).click();

  // Review, then submit
  await expect(page.getByRole('heading', { name: 'Review and submit' })).toBeVisible();
  await expect(page.locator('main')).toContainText('Layla Al-Harbi');
  await expect(page.locator('main')).toContainText('7 years, 3 months');
  await expect(page.locator('main')).toContainText('055 123 4567');
  await shot(page, '11-register-review-en');
  await page.getByRole('button', { name: 'Submit registration' }).click();

  // Confirmation: tracking ID, QR code, downloads, resend, instructions
  await page.waitForURL(/\/traced\/account\/registration\/\?id=[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'Registration successful' })).toBeVisible();
  const trackingId = (await page.locator('.p-tracking-id').textContent())!.trim();
  expect(trackingId).toMatch(/^TRC-SA-(0[1-9]|1[0-2])\/\d{2}-\d{5}$/);
  const qrImg = page.getByRole('img', { name: `QR code for tracking ID ${trackingId}` });
  await expect(qrImg).toBeVisible();
  expect(await qrImg.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect(page.locator('main')).toContainText('Awaiting sample collection');
  await expect(page.locator('main')).toContainText('[DEV] Riyadh sample branch');
  await expect(page.getByRole('heading', { name: 'Collection instructions' })).toBeVisible();
  await expect(page.locator('main')).not.toContainText('Not issued yet');
  await shot(page, '12-registration-confirmation-en');

  // QR download (PNG) decodes to a QR URL with a customer token — and nothing personal.
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download QR (PNG)' }).click()]);
  expect(download.suggestedFilename()).toBe(`TRACED-${trackingId.replace('/', '-')}.png`);
  const qrText = decodeQrPng(await readFile((await download.path())!))!;
  expect(qrText).toMatch(/^http:\/\/localhost:8791\/traced\/c\/#c1_[A-Za-z0-9_-]{43}$/);

  // The confirmation email was delivered (test mailer) with the tracking ID and the same QR.
  const mailHtml = await readFile(await latestMailFile(email, 'registration_confirmation', '.html'), 'utf8');
  expect(mailHtml).toContain(trackingId);
  expect(mailHtml).not.toContain('Layla');
  await page.goto(`file:///${(await latestMailFile(email, 'registration_confirmation', '.html')).replace(/\\/g, '/')}`);
  await shot(page, '15-email-registration-confirmation-en');
  await page.goBack();

  // Resend the QR email.
  await page.getByRole('button', { name: 'Email me the QR code again' }).click();
  await expect(page.getByText(`We’re emailing the QR code to ${email}.`)).toBeVisible();
  await latestMailFile(email, 'registration_qr_resend', '.html');

  // My registrations
  await page.getByRole('link', { name: 'Back to my registrations' }).click();
  await expect(page.locator('.p-item')).toHaveCount(1);
  await expect(page.locator('.p-item')).toContainText('Layla Al-Harbi');
  await expect(page.locator('.p-item')).toContainText('Female');
  await expect(page.locator('.p-item')).toContainText(trackingId);
  await shot(page, '13-my-registrations-en');

  // Dashboard now lists it
  await page.goto('/traced/account/');
  await expect(page.getByRole('heading', { name: 'Welcome, Fatimah' })).toBeVisible();
  await expect(page.locator('.p-qr-row')).toContainText(trackingId);
  await expect(page.locator('.p-qr-row img')).toBeVisible();
  await shot(page, '14-dashboard-with-registration-en');
});

test('Arabic: right-to-left interface, Arabic messages, register myself with an Arabic name', async ({ page }) => {
  const email = uniqueEmail('ar.flow');
  await page.goto('/ar/traced/account/sign-up/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar-SA');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.getByRole('button', { name: 'إنشاء الحساب' }).click();
  await expect(page.locator('.p-error-summary')).toContainText('يرجى تصحيح ما يلي');
  await expect(page.locator('.p-error-summary')).toContainText('يجب أن يكون عمرك 18 عامًا أو أكثر لإنشاء حساب.');
  await shot(page, '16a-sign-up-validation-ar');

  await signUpAndSignIn(page, 'ar', email);
  await expect(page.getByRole('heading', { name: 'لا توجد تسجيلات بعد' })).toBeVisible();
  await shot(page, '16-dashboard-empty-ar');

  await page.getByRole('link', { name: 'تسجيل جديد في TRACED' }).first().click();
  await page.getByLabel(/نفسي/).check();
  await page.getByRole('button', { name: 'متابعة' }).click();
  await page.getByLabel('الاسم الأول').fill('عمر');
  await page.getByLabel('اسم العائلة').fill('الصالح');
  await page.getByLabel('تاريخ الميلاد').fill(dobFor(16));
  await page.getByLabel('ذكر').check();
  await page.getByRole('button', { name: 'متابعة' }).click();
  await expect(page.locator('.p-error-summary')).toContainText('يجب أن يكون عمرك 18 عامًا أو أكثر');
  await page.getByLabel('تاريخ الميلاد').fill(dobFor(34));
  await expect(page.locator('.p-age')).toContainText('العمر');
  await shot(page, '17-register-step2-ar');
  await page.getByRole('button', { name: 'متابعة' }).click();
  await page.getByLabel('اسمك الكامل').fill('عمر الصالح');
  await page.getByLabel('رقم الجوال', { exact: true }).fill('٠٥٠١٢٣٤٥٦٧'); // Arabic-Indic digits are accepted
  await page.getByRole('button', { name: 'متابعة' }).click();
  await page.getByLabel(/فرع جدة/).check();
  await page.getByRole('button', { name: 'متابعة' }).click();
  await expect(page.locator('.p-consent')).toHaveCount(3); // no guardian authorisation for "myself"
  for (const box of await page.locator('.p-consent input[type=checkbox]').all()) await box.check();
  await shot(page, '18-register-consent-ar');
  await page.getByRole('button', { name: 'متابعة' }).click();
  await expect(page.locator('main')).toContainText('050 123 4567');
  await page.getByRole('button', { name: 'إرسال التسجيل' }).click();
  await page.waitForURL(/\/ar\/traced\/account\/registration\/\?id=/);
  await expect(page.getByRole('heading', { name: 'تم التسجيل بنجاح' })).toBeVisible();
  await expect(page.locator('.p-tracking-id')).toHaveText(/^TRC-SA-/);
  await expect(page.locator('img.p-qr')).toBeVisible();
  await expect(page.locator('main')).toContainText('عمر الصالح');
  await expect(page.locator('main')).toContainText('اكتمل التسجيل');
  await shot(page, '19-registration-confirmation-ar');
  const arMail = await latestMailFile(email, 'registration_confirmation', '.html');
  expect(await readFile(arMail, 'utf8')).toContain('dir="rtl"');
  await page.goto(`file:///${arMail.replace(/\\/g, '/')}`);
  await shot(page, '25-email-registration-confirmation-ar');
  await page.goBack();

  // Language switch keeps the same page.
  await page.getByRole('link', { name: 'Switch to English' }).click();
  await page.waitForURL(/\/traced\/account\/registration\/\?id=/);
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.getByRole('heading', { name: 'Registration details' })).toBeVisible();
});

test('password visibility toggle and keyboard-only form use', async ({ page }) => {
  await page.goto('/traced/account/sign-in/');
  const password = page.getByLabel('Password', { exact: true });
  const toggle = page.getByRole('button', { name: 'Show password' });
  await password.fill('secret value');
  await expect(password).toHaveAttribute('type', 'password');
  await toggle.click();
  await expect(password).toHaveAttribute('type', 'text');
  await expect(page.getByRole('button', { name: 'Hide password' })).toHaveAttribute('aria-pressed', 'true');

  // Keyboard: skip link, then fields in order, submit with Enter.
  await page.goto('/traced/account/sign-in/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.getByLabel('Email address', { exact: true }).focus();
  await page.keyboard.type('nobody@example.com');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
  await page.keyboard.type('wrong password here');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toContainText('Incorrect email or password.');
});

test('forgot and reset password through the emailed link', async ({ page }) => {
  const email = uniqueEmail('reset.flow');
  await signUpAndSignIn(page, 'en', email);
  await page.getByRole('button', { name: 'Sign out' }).first().click();
  await page.waitForURL('**/sign-in/?signedOut=1');
  await expect(page.getByText('You have signed out.')).toBeVisible();

  await page.getByRole('link', { name: 'Forgot your password?' }).click();
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await page.goto(await mailLink(email, 'reset_password'));
  expect(page.url()).not.toContain('token=');
  await page.getByLabel('New password').fill('a brand new long password');
  await page.getByRole('button', { name: 'Save new password' }).click();
  await expect(page.getByRole('heading', { name: 'Password updated' })).toBeVisible();
  await shot(page, '20-password-reset-done-en');

  await page.getByRole('link', { name: 'Go to sign in' }).click();
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill('a brand new long password');
  await page.locator('form').getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/traced/account/');
});

test('settings: save profile, change password, sign out', async ({ page }) => {
  const email = uniqueEmail('settings.flow');
  await signUpAndSignIn(page, 'en', email);
  await page.getByRole('link', { name: 'Manage settings' }).click();
  await page.getByLabel('Full name').fill('Reem Al-Qahtani');
  await page.getByLabel('Mobile number', { exact: true }).fill('12345');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('.p-error-summary')).toContainText('Saudi mobile number');
  await page.getByLabel('Mobile number', { exact: true }).fill('0500000000');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Your profile has been saved.')).toBeVisible();

  await page.getByLabel('Current password').fill('wrong current password');
  await page.getByLabel('New password').fill('another long new password');
  await page.getByRole('button', { name: 'Update password' }).click();
  await expect(page.getByRole('alert')).toContainText('Incorrect email or password.');
  await page.getByLabel('Current password').fill(PASSWORD);
  await page.getByLabel('New password').fill('another long new password');
  await page.getByRole('button', { name: 'Update password' }).click();
  await expect(page.getByText('Your password has been changed.')).toBeVisible();
  await shot(page, '21-settings-en');

  await page.goto('/traced/account/');
  await expect(page.getByRole('heading', { name: 'Welcome, Reem' })).toBeVisible();
  await expect(page.locator('main')).toContainText('050 000 0000');
});

test('sign out: a refused request never pretends; a real sign-out ends the session (Back cannot restore it)', async ({ page }) => {
  const email = uniqueEmail('signout.flow');
  await signUpAndSignIn(page, 'en', email);
  await expect(page).toHaveURL(/\/traced\/account\/$/);
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();
  // Regression (28 Nov 2026): when the server refused sign-out, the portal still went to the sign-in page,
  // which sent the still-signed-in user straight back. Now it stays and says so.
  await page.route('**/api/v1/auth/sign-out', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'CSRF_REJECTED', message: 'x' } }) }));
  await page.locator('main').getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('alert')).toContainText('You are still signed in');
  await expect(page).toHaveURL(/\/traced\/account\/$/);
  await page.unroute('**/api/v1/auth/sign-out');
  // Real sign-out.
  await page.locator('main').getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/traced\/account\/sign-in\/\?signedOut=1/);
  await page.goto('/traced/account/');
  await expect(page).toHaveURL(/\/traced\/account\/sign-in\//);
  await page.goBack();
  await expect(page.getByRole('heading', { name: /Welcome/ })).toHaveCount(0);
  // Sign in again works.
  await page.goto('/traced/account/sign-in/');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/traced\/account\/$/);
});

test('double-clicking submit creates exactly one registration; another customer cannot open it', async ({ page, browser }) => {
  const email = uniqueEmail('dbl.flow');
  await signUpAndSignIn(page, 'en', email);
  await page.goto('/traced/account/register/');
  await page.getByLabel(/Myself/).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('First name').fill('Noura');
  await page.getByLabel('Last name').fill('Otaibi');
  await page.getByLabel('Date of birth').fill(dobFor(29));
  await page.getByLabel('Female').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Your full name').fill('Noura Otaibi');
  await page.getByLabel('Mobile number', { exact: true }).fill('0551112233');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel(/Dammam/).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  for (const box of await page.locator('.p-consent input[type=checkbox]').all()) await box.check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Submit registration' }).dblclick();
  await page.waitForURL(/registration\/\?id=/);
  const url = page.url();
  await page.goto('/traced/account/registrations/');
  await expect(page.locator('.p-item')).toHaveCount(1);

  const other = await browser.newPage();
  await signUpAndSignIn(other, 'en', uniqueEmail('other.flow'));
  await other.goto(url);
  await expect(other.getByText('We couldn’t find this registration.')).toBeVisible();
  await expect(other.locator('main')).not.toContainText('Noura');
  await other.close();
});

test.describe('mobile (375 × 812)', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test('no horizontal scrolling on any portal page (EN and AR) or on the TRACED home header', async ({ page }) => {
    for (const p of ['/traced/', '/ar/traced/', '/traced/account/sign-in/', '/traced/account/sign-up/', '/traced/account/forgot-password/', '/ar/traced/account/sign-in/']) {
      await page.goto(p);
      await page.waitForLoadState('load'); await page.locator('header').first().waitFor({ state: 'attached' });
      await noHorizontalScroll(page);
    }
    // The header bar must fit at common phone widths and on tablets, as the original does.
    const header = page.locator('header nav').first();
    for (const width of [360, 375, 390, 768]) {
      await page.setViewportSize({ width, height: 812 });
      for (const p of ['/traced/', '/ar/traced/']) {
        await page.goto(p);
        await expect(header.locator('a[data-traced-account-link][href$="/traced/account/"]')).toBeVisible();
        const fits = await page.locator('.header-bar').first().evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
        expect(fits, `header bar overflows at ${width}px on ${p}`).toBe(true);
        await noHorizontalScroll(page);
      }
    }
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/traced/');
    await shot(page, '22-mobile-traced-home-header', false);

    await signUpAndSignIn(page, 'en', uniqueEmail('mobile.flow'));
    await shot(page, '23-mobile-dashboard-en');
    const regId = await page.evaluate(async () => {
      const me = await (await fetch('/api/v1/auth/me')).json();
      const form = await (await fetch('/api/v1/me/registration-form?locale=en')).json();
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());
      const dob = `${Number(today.slice(0, 4)) - 6}-03-15`;
      const res = await fetch('/api/v1/me/registrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrfToken, 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ relationship: 'child', patient: { firstName: 'Sara', lastName: 'Qahtani', dateOfBirth: dob, gender: 'female' },
          contact: { fullName: 'Mona Qahtani', phone: '0559990000' }, branchId: form.branches[0].id, consentDocumentIds: form.consents.map((c: { id: string }) => c.id) }),
      });
      return (await res.json()).registration.id as string;
    });
    for (const p of [`/traced/account/registration/?id=${regId}`, `/ar/traced/account/registration/?id=${regId}`]) {
      await page.goto(p);
      await page.locator('img.p-qr').waitFor();
      await noHorizontalScroll(page);
    }
    await shot(page, '26-mobile-registration-qr-ar');
    for (const p of ['/traced/account/', '/traced/account/settings/', '/traced/account/registrations/', '/traced/account/register/', '/ar/traced/account/', '/ar/traced/account/register/', '/traced/account/verify-email/']) {
      await page.goto(p);
      await page.waitForLoadState('load'); await page.locator('header').first().waitFor({ state: 'attached' });
      await noHorizontalScroll(page);
    }
    await page.goto('/ar/traced/account/register/');
    await page.getByLabel(/طفلي/).check();
    await page.getByRole('button', { name: 'متابعة' }).click();
    await noHorizontalScroll(page);
    await shot(page, '24-mobile-register-step2-ar');
  });
});
