/// <reference lib="dom" />
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { saveScreenshot } from './redact-qr.ts';

export const PASSWORD = 'correct horse battery staple';
export const MAIL_DIR = path.resolve('test-results/e2e-mail');
export const SHOTS = path.resolve('docs/phase-4/screenshots/customer');

export const uniqueEmail = (prefix: string) => `${prefix}.${randomBytes(4).toString('hex')}@example.com`;

/** Link from the newest dev-mail file of a template sent to an address. */
export async function mailLink(to: string, template: string): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const files = (await readdir(MAIL_DIR).catch(() => [] as string[])).filter((f) => f.includes(`-${template}-`) && f.endsWith('.txt')).sort().reverse();
    for (const f of files) {
      const text = await readFile(path.join(MAIL_DIR, f), 'utf8');
      if (text.includes(`To: ${to}\n`)) {
        const link = /https?:\/\/\S+#token=[A-Za-z0-9_-]+/.exec(text)?.[0];
        if (link) return link;
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`no ${template} email for ${to}`);
}

/** Path of the newest dev-mail file (.html preview or .txt) of a template sent to an address. */
export async function latestMailFile(to: string, template: string, ext: '.html' | '.txt'): Promise<string> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const files = (await readdir(MAIL_DIR).catch(() => [] as string[])).filter((f) => f.includes(`-${template}-`) && f.endsWith('.txt')).sort().reverse();
    for (const f of files) {
      if ((await readFile(path.join(MAIL_DIR, f), 'utf8')).includes(`To: ${to}\n`)) return path.join(MAIL_DIR, f.replace(/\.txt$/, ext));
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`no ${template} email for ${to}`);
}

/** YYYY-MM-DD for someone `years` years and `months` months old today (Asia/Riyadh). */
export function dobFor(years: number, months = 0): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y - years, m - 1 - months, Math.min(d, 28)));
  return date.toISOString().slice(0, 10);
}

const L = {
  en: { email: 'Email address', password: 'Password', create: 'Create account', signIn: 'Sign in', adult: 'I confirm that I am 18 years of age or older.' },
  ar: { email: 'البريد الإلكتروني', password: 'كلمة المرور', create: 'إنشاء الحساب', signIn: 'تسجيل الدخول', adult: 'أؤكد أن عمري 18 عامًا أو أكثر.' },
};

/** Creates an account through the UI, opens the emailed verification link and signs in. */
export async function signUpAndSignIn(page: Page, lang: 'en' | 'ar', email: string) {
  const pre = lang === 'ar' ? '/ar' : '';
  // Each test customer comes from its own address, so per-IP sign-up limits apply per customer.
  const b = randomBytes(3);
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': `10.${b[0]}.${b[1]}.${b[2]}` });
  const l = L[lang];
  await page.goto(`${pre}/traced/account/sign-up/`);
  await page.getByLabel(l.email).fill(email);
  await page.getByLabel(l.password, { exact: true }).fill(PASSWORD);
  await page.getByLabel(l.adult).check();
  await page.getByRole('button', { name: l.create }).click();
  await expect(page.locator('#page-title')).toBeVisible();
  await page.goto(await mailLink(email, 'verify_email'));
  await expect(page.locator('.p-alert--success')).toBeVisible();
  await page.goto(`${pre}/traced/account/sign-in/`);
  await page.getByLabel(l.email).fill(email);
  await page.getByLabel(l.password, { exact: true }).fill(PASSWORD);
  await page.locator('form').getByRole('button', { name: l.signIn }).click();
  await page.waitForURL(`**${pre}/traced/account/`);
}

export async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `horizontal overflow on ${page.url()}`).toBeLessThanOrEqual(1);
}

export async function shot(page: Page, name: string, fullPage = true) {
  if (fullPage) await page.evaluate(() => window.scrollTo(0, 0)); // keep the sticky header at the top
  await saveScreenshot(page, path.join(SHOTS, `${name}.png`), fullPage); // retries + QR redaction
}
