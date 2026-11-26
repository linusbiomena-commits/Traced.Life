#!/usr/bin/env node
// Usage (from the repository root): node scripts/scan-history-qr.mjs
// Decodes every PNG blob ever committed (all branches) and reports the ones whose QR code
// carries a TRACED customer/sample token. Prints commit-independent blob paths and counts only,
// never the token values. Run from the repository root.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const repo = process.cwd();
const require = createRequire(path.join(repo, 'package.json'));
const { PNG } = require('pngjs');
const jsqrMod = require('jsqr');
const jsQR = jsqrMod.default ?? jsqrMod;

const objs = execFileSync('git', ['rev-list', '--all', '--objects'], { encoding: 'utf8', maxBuffer: 1 << 28 })
  .split('\n').filter((l) => /\.png$/i.test(l)).map((l) => { const i = l.indexOf(' '); return { sha: l.slice(0, i), file: l.slice(i + 1) }; });
const seen = new Set();
let decoded = 0;
const hits = [];
for (const { sha, file } of objs) {
  if (seen.has(sha)) continue;
  seen.add(sha);
  let png;
  try {
    png = PNG.sync.read(execFileSync('git', ['cat-file', 'blob', sha], { maxBuffer: 1 << 28 }));
  } catch { continue; }
  const r = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  if (!r) continue;
  decoded++;
  const kind = /\/traced\/c\/|#c1_/.test(r.data) ? 'customer QR token' : /\/traced\/s\/|#s1_/.test(r.data) ? 'sample QR token' : /otpauth:/.test(r.data) ? 'MFA enrolment secret' : null;
  if (kind) hits.push({ file, sha: sha.slice(0, 10), kind: kind + ' @' + (kind.startsWith('MFA') ? (/issuer=([^&]+)/.exec(r.data)?.[1] ?? '?') : new URL(r.data).host) });
}
console.log(`PNG blobs in history: ${seen.size}; with a decodable QR: ${decoded}; with a sensitive QR: ${hits.length}`);
const inHead = new Set(execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' }).split('\n'));
for (const h of hits) console.log(`  ${h.kind.padEnd(22)} ${h.sha}  ${h.file}${inHead.has(h.file) ? '  (path still exists; current version checked by the evidence test)' : ''}`);
