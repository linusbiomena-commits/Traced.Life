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
// TRACED_BUILD_PORTAL=1 keeps the operational portal pages (restricted pilot). The portal is only ever
// served behind the pilot gate in middleware.ts, so a Vercel PRODUCTION build refuses to include it unless
// the gate is configured (TRACED_PILOT_PASSWORD, 12+ characters) and the middleware file exists; the failed
// build leaves the current live deployment in place.
const includePortal = process.env.TRACED_BUILD_PORTAL === '1';
if (includePortal && process.env.VERCEL_ENV === 'production') {
  const gateReady = (process.env.TRACED_PILOT_PASSWORD ?? '').length >= 12 && existsSync(path.join(ROOT, 'middleware.ts'));
  if (!gateReady) {
    console.error('Refusing to build the portal for production: the pilot gate (TRACED_PILOT_PASSWORD + middleware.ts) is not configured.');
    process.exit(1);
  }
}
const excluded = new Set(includePortal ? [] : [path.join(DIST, 'portal')]);
if (!includePortal) {
  for (const prefix of ['traced', path.join('ar', 'traced')]) {
    for (const top of portalTop) excluded.add(path.join(DIST, prefix, top));
  }
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

if (!includePortal) {
  appendFileSync(
    path.join(OUT, 'traced-account-nav.css'),
    '\n/* Public-only deployment: the portal is not live yet, hide its header entry. */\n.traced-account-nav__wrap { display: none !important; }\n',
  );
}

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
console.log(`${includePortal ? 'RESTRICTED PREVIEW (portal included)' : 'public site'} → ${path.relative(ROOT, OUT)}: ${files} files, ${(bytes / 1048576).toFixed(1)} MB; excluded ${excluded.size} portal paths`);
