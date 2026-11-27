// Builds the PUBLIC website only (no customer/staff/admin/lab portal) into .vercel-public/
// for a static Vercel deployment while the portal backend does not exist yet.
//
//   node scripts/build-public-site.mjs
//
// - copies dist/ except the portal page shells (EN + AR) and the /portal assets
// - hides the header "Account" entry (it points at the portal)
// - writes a vercel.json with basic security headers
// The repository's dist/ is not modified.

import { cpSync, rmSync, existsSync, appendFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
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

// Keep a previous Vercel link (.vercel/project.json) across rebuilds.
const linkDir = path.join(OUT, '.vercel');
const keepLink = existsSync(linkDir);
if (existsSync(OUT)) {
  for (const entry of readdirSync(OUT)) if (entry !== '.vercel') rmSync(path.join(OUT, entry), { recursive: true, force: true });
}

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

// Never upload local Vercel/CLI files (e.g. the .env.local OIDC token written by `vercel link`).
writeFileSync(path.join(OUT, '.vercelignore'), '.env*\n.gitignore\n.vercel\n');

writeFileSync(
  path.join(OUT, 'vercel.json'),
  JSON.stringify(
    {
      $schema: 'https://openapi.vercel.sh/vercel.json',
      trailingSlash: true,
      headers: [
        {
          source: '/(.*)',
          headers: [
            { key: 'X-Content-Type-Options', value: 'nosniff' },
            { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
            { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
            { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
            { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
          ],
        },
      ],
    },
    null,
    2,
  ) + '\n',
);

let files = 0;
let bytes = 0;
(function walk(d) {
  for (const e of readdirSync(d)) {
    if (e === '.vercel') continue;
    const p = path.join(d, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p);
    else { files++; bytes += s.size; }
  }
})(OUT);
console.log(`public site → ${path.relative(ROOT, OUT)}: ${files} files, ${(bytes / 1048576).toFixed(1)} MB; excluded ${excluded.size} portal paths${keepLink ? '; Vercel link kept' : ''}`);
