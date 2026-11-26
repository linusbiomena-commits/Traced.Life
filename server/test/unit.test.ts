import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { decrypt, encrypt, hmac, randomCode, randomToken, safeEqual } from '../src/lib/crypto.ts';
import { hashPassword, passwordProblem, verifyPassword } from '../src/lib/password.ts';
import { buildLink } from '../src/modules/auth/links.ts';
import { matchTotp, newTotpSecret } from '../src/modules/auth/mfa.ts';
import { renderTemplate } from '../src/modules/mail/templates.ts';
import { PERMISSIONS, ROLE_PERMISSIONS } from '../src/modules/rbac/catalogue.ts';
import { totpCode } from './helpers/test-app.ts';

describe('crypto', () => {
  const key = randomBytes(32);

  it('round-trips AES-GCM and binds the context', () => {
    const ct = encrypt(key, 'JBSWY3DPEHPK3PXP', 'users.mfa_active:abc');
    expect(ct.startsWith('v1.')).toBe(true);
    expect(decrypt(key, ct, 'users.mfa_active:abc')).toBe('JBSWY3DPEHPK3PXP');
    expect(() => decrypt(key, ct, 'users.mfa_active:other-user')).toThrow();
    expect(() => decrypt(randomBytes(32), ct, 'users.mfa_active:abc')).toThrow();
  });

  it('rejects tampered ciphertext', () => {
    const ct = encrypt(key, 'secret', 'ctx');
    const raw = Buffer.from(ct.slice(3), 'base64url');
    raw[raw.length - 1]! ^= 1;
    expect(() => decrypt(key, `v1.${raw.toString('base64url')}`, 'ctx')).toThrow();
  });

  it('generates high-entropy tokens and readable codes', () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => randomToken()));
    expect(tokens.size).toBe(1000);
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomCode(10)).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
  });

  it('hmac is keyed and comparisons are constant-time safe', () => {
    expect(hmac(key, 'a').equals(hmac(key, 'a'))).toBe(true);
    expect(hmac(key, 'a').equals(hmac(randomBytes(32), 'a'))).toBe(false);
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('passwords', () => {
  it('hashes with argon2id and verifies', async () => {
    const h = await hashPassword('correct horse battery staple');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(h, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(h, 'wrong')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });

  it('enforces the policy', () => {
    expect(passwordProblem('short')).toBe('TOO_SHORT');
    expect(passwordProblem('a'.repeat(129))).toBe('TOO_LONG');
    expect(passwordProblem('aaaaaaaaaaaaaa')).toBe('TOO_SIMPLE');
    expect(passwordProblem('fatima.alharbi-2026', 'fatima.alharbi@example.com')).toBe('CONTAINS_EMAIL');
    expect(passwordProblem('correct horse battery staple', 'fatima@example.com')).toBeNull();
    expect(passwordProblem('كلمة مرور طويلة جدا')).toBeNull(); // Arabic passwords are fine
  });
});

describe('totp', () => {
  it('accepts current and adjacent steps, rejects others', () => {
    const secret = newTotpSecret();
    expect(matchTotp(secret, totpCode(secret))).not.toBeNull();
    expect(matchTotp(secret, totpCode(secret, -1))).not.toBeNull();
    expect(matchTotp(secret, totpCode(secret, 3))).toBeNull();
    expect(matchTotp(secret, 'abcdef')).toBeNull();
  });
});

describe('catalogue', () => {
  it('only grants known permissions, and never personal-data access to staff or customers', () => {
    for (const perms of Object.values(ROLE_PERMISSIONS)) for (const p of perms) expect(PERMISSIONS).toContain(p);
    for (const role of ['customer', 'collection_staff', 'lab_operator', 'auditor'] as const) {
      expect(ROLE_PERMISSIONS[role]).not.toContain('registration.read_full');
      expect(ROLE_PERMISSIONS[role]).not.toContain('report.export_pii');
    }
  });
});

describe('links and templates', () => {
  it('puts tokens in the URL fragment and localises the path', () => {
    expect(buildLink('https://x.test', 'verify_email', 'en', 'tok')).toBe('https://x.test/traced/account/verify-email/#token=tok');
    expect(buildLink('https://x.test', 'reset_password', 'ar', 'tok')).toBe('https://x.test/ar/traced/account/reset-password/#token=tok');
  });

  it('renders Arabic emails right-to-left and escapes HTML', () => {
    const ar = renderTemplate('verify_email', 'ar', { link: 'https://x.test/?a=1&b=<2>' });
    expect(ar.html).toContain('dir="rtl"');
    expect(ar.html).toContain('&amp;b=&lt;2&gt;');
    expect(ar.html).not.toContain('<2>');
  });
});

describe('config', () => {
  const base = {
    APP_ORIGIN: 'https://traced.example.sa',
    DATABASE_URL: 'postgres://x',
    TOKEN_HMAC_KEY: randomBytes(32).toString('base64'),
    DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  };

  it('requires 32-byte keys', () => {
    expect(() => loadConfig({ ...base, TOKEN_HMAC_KEY: 'c2hvcnQ=' })).toThrow(/32 bytes/);
  });

  it('refuses unsafe production settings', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', APP_ORIGIN: 'http://insecure.example' })).toThrow(/https/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/MAIL_TRANSPORT must be resend/);
  });
});
