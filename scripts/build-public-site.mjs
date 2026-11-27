// Builds the PUBLIC website only (no customer/staff/admin/lab portal) into .vercel-public/.
// This is the Vercel build command (see vercel.json; headers and settings live there).
//
//   node scripts/build-public-site.mjs
//
// - copies dist/ except the portal page shells (EN + AR) and the /portal assets
// - hides the header "Account" entry (it points at the portal, which is not live yet)
// The repository's dist/ is not modified. Uses only Node built-ins (Vercel skips npm install).

import { cpSync, rmSync, existsSync, appendFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(ROOT, '.vercel-public');

// Top-level portal sections under /traced/ and /ar/traced/ (every PAGES[].dir in
// scripts/build-portal-pages.mjs starts with one of these; not imported because that
// script regenerates files when loaded).
const portalTop = ['account', 'staff', 'admin', 'lab', 'c', 's'];
const excluded = new Set([path.join(DIST, 'portal')]);
for (const prefix of ['traced', path.join('ar', 'traced')]) {
  for (const top of portalTop) excluded.add(path.join(DIST, prefix, top));
}

if (!existsSync(path.join(DIST, 'traced', 'index.html'))) {
  console.error('dist/traced/index.html missing: nothing to build');
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
cpSync(DIST, OUT, {
  recursive: true,
  filter: (src) => {
    for (const ex of excluded) if (src === ex || src.startsWith(ex + path.sep)) return false;
    return !/(^|[\\/])(\.DS_Store|Thumbs\.db)$/.test(src);
  },
});

appendFileSync(
  path.join(OUT, 'traced-account-nav.css'),
  '\n/* Public-only deployment: the portal is not live yet, hide its header entry. */\n.traced-account-nav__wrap { display: none !important; }\n',
);

let files = 0;
let bytes = 0;
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = path.join(d, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p);
    else { files++; bytes += s.size; }
  }
})(OUT);
console.log(`public site → ${path.relative(ROOT, OUT)}: ${files} files, ${(bytes / 1048576).toFixed(1)} MB; excluded ${excluded.size} portal paths`);
