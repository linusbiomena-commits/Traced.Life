import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
const PORTAL_JS = path.join(ROOT, 'dist/portal/js');

function files(dir: string, ext: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(path.join(dir, e.name), ext) : e.name.endsWith(ext) ? [path.join(dir, e.name)] : []);
}

describe('portal translations', () => {
  it('English and Arabic have exactly the same keys and no empty strings', async () => {
    const en = (await import(path.join(PORTAL_JS, 'i18n/en.js'))).default as Record<string, string>;
    const ar = (await import(path.join(PORTAL_JS, 'i18n/ar.js'))).default as Record<string, string>;
    expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
    for (const [k, v] of Object.entries({ ...en, ...ar })) expect(v.trim(), k).not.toBe('');
  });

  it('Arabic strings are actually Arabic (apart from brand names and the English switch)', async () => {
    const ar = (await import(path.join(PORTAL_JS, 'i18n/ar.js'))).default as Record<string, string>;
    const allowedLatin = new Set(['app.name', 'nav.language', 'nav.languageLabel', 'reg.productValue']);
    for (const [k, v] of Object.entries(ar)) {
      if (!allowedLatin.has(k)) expect(v, k).toMatch(/[؀-ۿ]/);
    }
  });

  it('every translation key used in the portal code exists', async () => {
    const en = (await import(path.join(PORTAL_JS, 'i18n/en.js'))).default as Record<string, string>;
    const used = new Set<string>();
    for (const f of files(PORTAL_JS, '.js')) {
      for (const m of readFileSync(f, 'utf8').matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)) used.add(m[1]!);
    }
    const missing = [...used].filter((k) => !(k in en));
    expect(missing).toEqual([]);
  });
});

describe('portal pages', () => {
  it('generated pages and the TRACED navigation patch are up to date', () => {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-portal-pages.mjs'), '--check'], { cwd: ROOT });
    execFileSync(process.execPath, [path.join(ROOT, 'scripts/patch-traced-account-links.mjs'), '--check'], { cwd: ROOT });
  });

  it('portal pages: strict CSP, noindex, no third-party or inline scripts, correct language', () => {
    const dirs = ['account', 'c', 'staff', 'admin'].flatMap((d) => [`dist/traced/${d}`, `dist/ar/traced/${d}`]);
    const pages = dirs.flatMap((d) => files(path.join(ROOT, d), '.html'));
    expect(pages).toHaveLength(62); // 18 customer/staff/QR + 13 admin (Phase 5) pages × EN/AR
    for (const p of pages) {
      const html = readFileSync(p, 'utf8');
      const arabic = p.includes(`${path.sep}ar${path.sep}`);
      expect(html).toContain(`<html lang="${arabic ? 'ar-SA' : 'en'}" dir="${arabic ? 'rtl' : 'ltr'}"`);
      expect(html).toMatch(/http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'/);
      expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
      expect(html).not.toMatch(/<script(?![^>]*\bsrc="\/portal\/)/); // only our own module, nothing inline
      expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/); // no external URLs at all
      expect(html).not.toMatch(/style="/);
    }
  });

  it('portal JavaScript never builds HTML from strings, logs, evals or stores personal data', () => {
    for (const f of files(PORTAL_JS, '.js')) {
      const src = readFileSync(f, 'utf8');
      const name = path.relative(ROOT, f);
      expect(src, name).not.toMatch(/\.innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
      expect(src, name).not.toMatch(/\beval\(|new Function\(/);
      expect(src, name).not.toMatch(/console\.(log|info|debug|warn|error)/);
      expect(src, name).not.toMatch(/sessionStorage|indexedDB/);
      // Only the language preference and the staff member's selected branch id (no personal data).
      for (const m of src.matchAll(/localStorage\.(?:setItem|getItem)\(([^,)]+)/g)) expect(['LANG_KEY', 'BRANCH_KEY'], name).toContain(m[1]);
    }
  });
});
