// Generates the branded TRACED restricted-pilot access pages (EN + AR) and their public CSS/JS into dist/.
// These pages are PUBLIC (never gated) and contain no secret: they post the password the tester types to
// POST /api/pilot/access, which middleware.ts checks against the Vercel environment.
//   node scripts/build-pilot-pages.mjs          write the files
//   node scripts/build-pilot-pages.mjs --check  exit 1 if any generated file is out of date
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const VERSION = '20261128-pilot1';
const check = process.argv.includes('--check');

const T = {
  en: {
    dir: 'ltr', lang: 'en', title: 'Restricted pilot access | TRACED', other: 'ar', otherLabel: 'العربية', otherLang: 'ar',
    eyebrow: 'Restricted pilot', heading: 'Pilot access', intro: 'TRACED is in a restricted pilot. Enter the pilot access password you were given to continue.',
    label: 'Pilot access password', show: 'Show', hide: 'Hide', submit: 'Continue', busy: 'Checking…',
    help: 'This is not your TRACED account password. You will sign in to your TRACED account on the next page.',
    contact: 'Need access? Contact', errEmpty: 'Enter the pilot access password.', errWrong: 'That password is not correct. Check it and try again.',
    errLimit: 'Too many attempts. Please wait 15 minutes and try again.', errOther: 'Pilot access is not available right now. Please try again shortly.',
    home: 'TRACED home', homeHref: '/traced/',
  },
  ar: {
    dir: 'rtl', lang: 'ar', title: 'الوصول إلى النسخة التجريبية المقيدة | TRACED', other: 'en', otherLabel: 'English', otherLang: 'en',
    eyebrow: 'نسخة تجريبية مقيدة', heading: 'الوصول إلى النسخة التجريبية', intro: 'يعمل TRACED حاليًا في نسخة تجريبية مقيدة. أدخل كلمة مرور الوصول التجريبي التي حصلت عليها للمتابعة.',
    label: 'كلمة مرور الوصول التجريبي', show: 'إظهار', hide: 'إخفاء', submit: 'متابعة', busy: 'جارٍ التحقق…',
    help: 'هذه ليست كلمة مرور حسابك في TRACED. ستسجّل الدخول إلى حسابك في الصفحة التالية.',
    contact: 'تحتاج إلى الوصول؟ تواصل مع', errEmpty: 'أدخل كلمة مرور الوصول التجريبي.', errWrong: 'كلمة المرور غير صحيحة. تحقّق منها وحاول مرة أخرى.',
    errLimit: 'محاولات كثيرة جدًا. يرجى الانتظار 15 دقيقة ثم المحاولة مرة أخرى.', errOther: 'الوصول التجريبي غير متاح حاليًا. يرجى المحاولة بعد قليل.',
    home: 'الصفحة الرئيسية لـ TRACED', homeHref: '/ar/traced/',
  },
};

const page = (l, logo) => {
  const t = T[l];
  const other = T[t.other];
  return `<!doctype html>
<html lang="${t.lang}" dir="${t.dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${t.title}</title>
<link rel="icon" type="image/svg+xml" href="/media/6c06a77e8214c2f23ff8.svg">
<link rel="stylesheet" href="/traced-pilot.css?v=${VERSION}">
<script src="/traced-pilot.js?v=${VERSION}" defer></script>
</head>
<body>
<header class="pilot-header">
  <a class="pilot-logo" href="${t.homeHref}" aria-label="${t.home}">${logo}</a>
  <a class="pilot-lang" id="pilot-lang" href="${other.homeHref.replace(/traced\/$/, 'traced/pilot-access/')}" lang="${t.otherLang}" hreflang="${t.otherLang}">${t.otherLabel}</a>
</header>
<main class="pilot-main">
  <section class="pilot-card" aria-labelledby="pilot-heading">
    <p class="pilot-eyebrow">${t.eyebrow}</p>
    <h1 id="pilot-heading">${t.heading}</h1>
    <p class="pilot-intro">${t.intro}</p>
    <form id="pilot-form" novalidate
      data-err-empty="${t.errEmpty}" data-err-wrong="${t.errWrong}" data-err-limit="${t.errLimit}" data-err-other="${t.errOther}"
      data-busy="${t.busy}" data-show="${t.show}" data-hide="${t.hide}">
      <label for="pilot-password">${t.label}</label>
      <div class="pilot-field">
        <input id="pilot-password" name="password" type="password" autocomplete="current-password" required maxlength="200" aria-describedby="pilot-help pilot-error" dir="ltr">
        <button type="button" class="pilot-toggle" id="pilot-toggle" aria-controls="pilot-password" aria-pressed="false">${t.show}</button>
      </div>
      <p class="pilot-help" id="pilot-help">${t.help}</p>
      <p class="pilot-error" id="pilot-error" role="alert" hidden></p>
      <button type="submit" class="pilot-submit" id="pilot-submit">${t.submit}</button>
    </form>
    <p class="pilot-contact">${t.contact} <a href="mailto:info@tracedmena.life">info@tracedmena.life</a></p>
  </section>
</main>
</body>
</html>
`;
};

const CSS = `/* TRACED restricted-pilot access page. Same tokens and fonts as the portal (dist/portal/css/portal.css). */
@font-face { font-family: Saans; font-style: normal; font-weight: 400; font-display: swap; src: url("/media/fa9cb66b6253dfb67f77.woff2") format("woff2"); }
@font-face { font-family: Saans; font-style: normal; font-weight: 500; font-display: swap; src: url("/media/434b35f31b6bb5902ca5.woff2") format("woff2"); }
@font-face { font-family: Serrif; font-style: normal; font-weight: 400; font-display: swap; src: url("/media/578361df06c2da8d6485.woff2") format("woff2"); }
:root {
  --color-primary: #c7d2ac; --color-primary-50: #e3e9d5; --color-dark-primary: #413f32; --color-dark-secondary: #201f1a;
  --color-muted: #615e50; --color-border: #b0aea7; --color-light: #f5f5f5; --color-white: #fff;
  --color-error: #a23a0b; --color-error-bg: #fdf1e7; --color-error-line: #ebab66;
  --radius-s: .5rem; --radius-m: 1rem; --radius-lg: 1.5rem; --radius-full: 999px;
  --font-sans: Saans, "Helvetica Neue", Arial, sans-serif; --font-serif: Serrif, Georgia, serif;
  --focus: 0 0 0 3px var(--color-white), 0 0 0 5px var(--color-dark-primary);
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; background: var(--color-light); color: var(--color-dark-secondary); font: 400 1rem/1.5 var(--font-sans); }
html[lang^="ar"] body, html[lang^="ar"] input, html[lang^="ar"] button { font-family: Tahoma, Arial, sans-serif; }
a { color: var(--color-dark-primary); text-underline-offset: 3px; }
:focus-visible { outline: none; box-shadow: var(--focus); border-radius: var(--radius-s); }
[hidden] { display: none !important; }
.pilot-header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin: 1rem; padding: .875rem 1.25rem; background: var(--color-white); border-radius: var(--radius-full); }
.pilot-logo { display: inline-flex; color: var(--color-dark-secondary); }
.pilot-logo svg { width: 7.5rem; height: auto; display: block; }
.pilot-lang { font-size: .9375rem; text-decoration: none; padding: .375rem .75rem; border-radius: var(--radius-full); }
.pilot-lang:hover { background: var(--color-primary-50); }
.pilot-main { flex: 1; display: flex; align-items: center; justify-content: center; padding: 1.5rem 1rem 3rem; }
.pilot-card { width: 100%; max-width: 28rem; background: var(--color-white); border-radius: var(--radius-lg); padding: 2rem 1.75rem; }
.pilot-eyebrow { display: inline-block; margin: 0 0 1rem; padding: .25rem .75rem; border-radius: var(--radius-full); background: var(--color-primary); color: var(--color-dark-primary); font-size: .8125rem; font-weight: 500; letter-spacing: .02em; }
h1 { margin: 0 0 .75rem; font: 400 2rem/1.15 var(--font-serif); color: var(--color-dark-secondary); }
html[lang^="ar"] h1 { font-family: Tahoma, Arial, sans-serif; font-weight: 700; font-size: 1.75rem; }
.pilot-intro { margin: 0 0 1.5rem; color: var(--color-muted); }
label { display: block; font-weight: 500; margin-bottom: .5rem; }
.pilot-field { display: flex; align-items: stretch; border: 1px solid var(--color-border); border-radius: var(--radius-s); background: var(--color-white); }
.pilot-field:focus-within { box-shadow: var(--focus); }
.pilot-field input { flex: 1; min-width: 0; border: 0; background: transparent; padding: .875rem 1rem; font-size: 1rem; color: inherit; border-radius: var(--radius-s); }
.pilot-field input:focus { outline: none; }
.pilot-field input::-ms-reveal, .pilot-field input::-ms-clear { display: none; }
.pilot-toggle { border: 0; background: transparent; padding: 0 1rem; font: inherit; font-size: .875rem; color: var(--color-dark-primary); cursor: pointer; border-radius: var(--radius-s); }
.pilot-help { margin: .5rem 0 0; font-size: .875rem; color: var(--color-muted); }
.pilot-error { margin: 1rem 0 0; padding: .75rem 1rem; border: 1px solid var(--color-error-line); background: var(--color-error-bg); color: var(--color-error); border-radius: var(--radius-s); font-size: .9375rem; }
.pilot-submit { width: 100%; margin-top: 1.5rem; padding: .875rem 1.5rem; border: 0; border-radius: var(--radius-full); background: var(--color-dark-secondary); color: var(--color-white); font: 500 1rem/1.2 var(--font-sans); cursor: pointer; }
html[lang^="ar"] .pilot-submit { font-family: Tahoma, Arial, sans-serif; }
.pilot-submit:hover { background: var(--color-dark-primary); }
.pilot-submit[disabled] { opacity: .6; cursor: progress; }
.pilot-contact { margin: 1.5rem 0 0; font-size: .875rem; color: var(--color-muted); }
@media (max-width: 480px) { .pilot-card { padding: 1.5rem 1.25rem; } h1 { font-size: 1.75rem; } }
`;

const JS = `// TRACED restricted-pilot access page. Holds no secret: posts what the tester types to /api/pilot/access.
(function () {
  var form = document.getElementById('pilot-form');
  if (!form) return;
  var input = document.getElementById('pilot-password');
  var toggle = document.getElementById('pilot-toggle');
  var submit = document.getElementById('pilot-submit');
  var error = document.getElementById('pilot-error');
  var lang = document.documentElement.lang.indexOf('ar') === 0 ? 'ar' : 'en';
  var fallback = lang === 'ar' ? '/ar/traced/account/sign-in/' : '/traced/account/sign-in/';
  // Only same-site portal paths are accepted as the destination (no open redirect).
  function safeNext(n) {
    if (!n || n.charAt(0) !== '/' || n.charAt(1) === '/' || n.indexOf('\\\\') !== -1) return fallback;
    try {
      var u = new URL(n, location.origin);
      if (u.origin !== location.origin || !/^\\/(ar\\/)?traced\\//.test(u.pathname)) return fallback;
      return u.pathname + u.search;
    } catch (e) { return fallback; }
  }
  var next = safeNext(new URLSearchParams(location.search).get('next'));
  // The original #fragment (e.g. #token=… from an invitation, verification or reset email) is kept and
  // handed back to the destination page.
  var hash = location.hash || '';
  var other = document.getElementById('pilot-lang');
  if (other) other.href = other.getAttribute('href').split('?')[0] + location.search + hash;
  function show(msg) { error.textContent = msg; error.hidden = false; }
  toggle.addEventListener('click', function () {
    var visible = input.type === 'text';
    input.type = visible ? 'password' : 'text';
    toggle.textContent = visible ? form.dataset.show : form.dataset.hide;
    toggle.setAttribute('aria-pressed', String(!visible));
  });
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    error.hidden = true;
    if (!input.value) { show(form.dataset.errEmpty); input.focus(); return; }
    var label = submit.textContent;
    submit.disabled = true; submit.textContent = form.dataset.busy;
    fetch('/api/pilot/access', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: input.value }) })
      .then(function (res) {
        if (res.status === 204 || res.status === 404) { location.replace(next + hash); return; }
        input.value = '';
        show(res.status === 401 ? form.dataset.errWrong : res.status === 429 ? form.dataset.errLimit : form.dataset.errOther);
        input.focus();
      })
      .catch(function () { show(form.dataset.errOther); })
      .then(function () { submit.disabled = false; submit.textContent = label; });
  });
})();
`;

const logo = (await readFile(path.join(ROOT, 'scripts/portal/traced-logo.svg'), 'utf8')).trim();
const files = [
  [path.join(DIST, 'traced', 'pilot-access', 'index.html'), page('en', logo)],
  [path.join(DIST, 'ar', 'traced', 'pilot-access', 'index.html'), page('ar', logo)],
  [path.join(DIST, 'traced-pilot.css'), CSS],
  [path.join(DIST, 'traced-pilot.js'), JS],
];
let stale = 0;
for (const [file, content] of files) {
  let current = null;
  try { current = await readFile(file, 'utf8'); } catch { /* missing */ }
  if (current === content) continue;
  stale++;
  if (check) console.error(`out of date: ${path.relative(ROOT, file)}`);
  else { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content, 'utf8'); }
}
if (check && stale) process.exit(1);
console.log(check ? 'Pilot pages are up to date.' : `Wrote ${stale} pilot file(s).`);
