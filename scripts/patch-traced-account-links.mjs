// Adds the customer-account entry to the existing TRACED pages, touching nothing else:
//  1. Header navigation: an "Account" / "الحساب" item after "Learn", using the "Shop" link's
//     CSS classes so it inherits the site's styling. On phones it shows a person icon instead
//     of text (traced-account-nav.css) so the header bar keeps its original width.
//     The link sits one level deeper than the other items, so the site's language-switch.js
//     keeps cloning "Shop" exactly as before.
//  2. Footer: the existing "Account" link pointed at the original company's US store accounts
//     (account.traced.life); it now points to /traced/account/ (or /ar/traced/account/).
//  3. A <link> to /traced-account-nav.css right after the existing language-switch.css link.
// Idempotent: running it again changes nothing.
//
//   node scripts/patch-traced-account-links.mjs          apply
//   node scripts/patch-traced-account-links.mjs --check  exit 1 if any page is not patched

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const OLD_ACCOUNT_URL = 'https://account.traced.life/profile?locale=en&amp;region_country=US';
const MARKER = 'data-traced-account-link';
const CSS_LINK = '<link rel="stylesheet" href="/traced-account-nav.css?v=20261126">';
// Reuse only the Shop link's classes (on the product page it also carries aria-current and
// Alpine click handlers, which must not be copied).
const FIRST_NAV_LINK_CLASS = /<a\s[^>]*?class="([^"]*)"/;
const LANGUAGE_CSS_LINK = /<link rel="stylesheet" href="\/language-switch\.css[^"]*">/;
const PERSON_ICON = '<svg class="traced-account-nav__icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>';

async function* htmlFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'account') continue; // the portal's own pages
      yield* htmlFiles(full);
    } else if (entry.name === 'index.html') yield full;
  }
}

export function patch(html, arabic) {
  const pre = arabic ? '/ar' : '';
  let out = html.split(OLD_ACCOUNT_URL).join(`${pre}/traced/account/`);
  if (!out.includes(MARKER)) {
    const navStart = out.indexOf('<nav aria-label=', out.indexOf('<header'));
    const navEnd = out.indexOf('</nav>', navStart);
    const cls = FIRST_NAV_LINK_CLASS.exec(out.slice(navStart, navEnd));
    if (navStart < 0 || navEnd < 0 || !cls) throw new Error('header navigation not found');
    const label = arabic ? 'الحساب' : 'Account';
    const item = `<li class="shrink h-full"><div class="traced-account-nav__wrap"><a ${MARKER} href="${pre}/traced/account/" class="${cls[1]}">${PERSON_ICON}<span class="body2 traced-account-nav__label">${label}</span></a></div></li>\n`;
    const ulEnd = out.lastIndexOf('</ul>', navEnd);
    out = `${out.slice(0, ulEnd)}${item} ${out.slice(ulEnd)}`;
  }
  if (!out.includes(CSS_LINK)) {
    const m = LANGUAGE_CSS_LINK.exec(out);
    if (!m) throw new Error('language-switch.css link not found');
    out = `${out.slice(0, m.index + m[0].length)}\n${CSS_LINK}${out.slice(m.index + m[0].length)}`;
  }
  return out;
}

const check = process.argv.includes('--check');
let changed = 0;
let total = 0;
for (const base of [path.join(DIST, 'traced'), path.join(DIST, 'ar', 'traced')]) {
  for await (const file of htmlFiles(base)) {
    total++;
    const html = await readFile(file, 'utf8');
    const arabic = path.relative(DIST, file).startsWith(`ar${path.sep}`);
    let next;
    try {
      next = patch(html, arabic);
    } catch (err) {
      throw new Error(`${path.relative(ROOT, file)}: ${err.message}`);
    }
    if (next === html) continue;
    changed++;
    if (check) console.error(`not patched: ${path.relative(ROOT, file)}`);
    else await writeFile(file, next, 'utf8');
  }
}
if (check && changed) process.exit(1);
console.log(check ? `All ${total} TRACED pages are patched.` : `Patched ${changed} of ${total} TRACED pages.`);
