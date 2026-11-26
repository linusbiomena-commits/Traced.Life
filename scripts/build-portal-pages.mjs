// Generates the static HTML shells for the customer portal (English + Arabic) into dist/.
// The page content itself is rendered by /portal/js (same files for both languages).
//
//   node scripts/build-portal-pages.mjs          write the files
//   node scripts/build-portal-pages.mjs --check  exit 1 if any generated file is out of date

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const VERSION = '20261126-p2b'; // bump to bust browser caches of portal CSS/JS

export const PAGES = [
  { id: 'dashboard', dir: 'account', title: { en: 'My account', ar: 'حسابي' } },
  { id: 'sign-in', dir: 'account/sign-in', title: { en: 'Sign in', ar: 'تسجيل الدخول' } },
  { id: 'sign-up', dir: 'account/sign-up', title: { en: 'Create account', ar: 'إنشاء حساب' } },
  { id: 'verify-email', dir: 'account/verify-email', title: { en: 'Verify your email', ar: 'تأكيد البريد الإلكتروني' } },
  { id: 'forgot-password', dir: 'account/forgot-password', title: { en: 'Reset your password', ar: 'إعادة تعيين كلمة المرور' } },
  { id: 'reset-password', dir: 'account/reset-password', title: { en: 'Choose a new password', ar: 'اختر كلمة مرور جديدة' } },
  { id: 'settings', dir: 'account/settings', title: { en: 'Account settings', ar: 'إعدادات الحساب' } },
  { id: 'register', dir: 'account/register', title: { en: 'New TRACED registration', ar: 'تسجيل جديد في TRACED' } },
  { id: 'registrations', dir: 'account/registrations', title: { en: 'My registrations', ar: 'تسجيلاتي' } },
  { id: 'registration', dir: 'account/registration', title: { en: 'Registration details', ar: 'تفاصيل التسجيل' } },
];

const TEXT = {
  en: { skip: 'Skip to content', home: 'TRACED home', loading: 'Loading…', noscript: 'Please enable JavaScript to use your TRACED account.', nav: 'Account navigation', help: 'Need help?', privacy: 'Privacy policy', faqs: 'FAQs', switchTo: 'العربية', switchLabel: 'التبديل إلى العربية' },
  ar: { skip: 'انتقل إلى المحتوى', home: 'الصفحة الرئيسية لـ TRACED', loading: 'جارٍ التحميل…', noscript: 'يرجى تفعيل JavaScript لاستخدام حسابك في TRACED.', nav: 'التنقل في الحساب', help: 'هل تحتاج إلى مساعدة؟', privacy: 'سياسة الخصوصية', faqs: 'الأسئلة الشائعة', switchTo: 'English', switchLabel: 'Switch to English' },
};

// No third-party scripts, no inline script/style: everything is served from this origin.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'";

function page(p, lang, logo) {
  const x = TEXT[lang];
  const pre = lang === 'ar' ? '/ar' : '';

  const other = lang === 'ar' ? `/traced/${p.dir}/` : `/ar/traced/${p.dir}/`;
  return `<!doctype html>
<html lang="${lang === 'ar' ? 'ar-SA' : 'en'}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}" data-page="${p.id}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>${p.title[lang]} | TRACED</title>
<link rel="icon" type="image/svg+xml" href="/media/6c06a77e8214c2f23ff8.svg">
<link rel="alternate" hreflang="${lang === 'ar' ? 'en' : 'ar-SA'}" href="${other}">
<link rel="stylesheet" href="/portal/css/portal.css?v=${VERSION}">
<script type="module" src="/portal/js/main.js?v=${VERSION}"></script>
</head>
<body>
<a class="skip-link" href="#main">${x.skip}</a>
<header class="p-header">
  <div class="p-header__bar">
    <a class="p-logo" href="${pre}/traced/" aria-label="${x.home}">${logo}</a>
    <nav class="p-nav" id="account-nav" aria-label="${x.nav}">
      <a class="p-nav__home" href="${pre}/traced/">${x.home}</a>
      <a href="${other}" lang="${lang === 'ar' ? 'en' : 'ar-SA'}" hreflang="${lang === 'ar' ? 'en' : 'ar-SA'}" aria-label="${x.switchLabel}">${x.switchTo}</a>
    </nav>
  </div>
</header>
<main id="main" tabindex="-1">
  <div class="p-container">
    <div id="app"><p class="p-loading" role="status">${x.loading}</p></div>
    <noscript><p class="p-alert p-alert--error">${x.noscript}</p></noscript>
  </div>
</main>
<footer class="p-footer">
  <div class="p-footer__inner">
    <img src="/media/linusbio-mena-footer-logo-traced.png" alt="LinusBio MENA" width="114" height="30" loading="lazy">
    <div class="p-footer__links">
      <span>${x.help} <a href="mailto:LinusBio@karama.tech" dir="ltr">LinusBio@karama.tech</a></span>
      <a href="${pre}/traced/pages/faqs/">${x.faqs}</a>
      <a href="${pre}/traced/policies/privacy-policy/">${x.privacy}</a>
    </div>
  </div>
</footer>
</body>
</html>
`.replace(/^\n/, '');

}

const check = process.argv.includes('--check');
const logo = (await readFile(path.join(ROOT, 'scripts/portal/traced-logo.svg'), 'utf8')).trim();
let stale = 0;
for (const p of PAGES) {
  for (const lang of ['en', 'ar']) {
    const file = path.join(DIST, lang === 'ar' ? 'ar' : '', 'traced', p.dir, 'index.html');
    const html = page(p, lang, logo);
    let current = null;
    try {
      current = await readFile(file, 'utf8');
    } catch {
      /* missing */
    }
    if (current === html) continue;
    stale++;
    if (check) console.error(`out of date: ${path.relative(ROOT, file)}`);
    else {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, html, 'utf8');
    }
  }
}
if (check && stale) process.exit(1);
console.log(check ? 'Portal pages are up to date.' : `Wrote ${stale} portal page(s) (${PAGES.length * 2} total).`);
