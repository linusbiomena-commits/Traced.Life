import { Secret, TOTP } from 'otpauth';
import type { Deps } from '../../context.ts';
import type { Queryable } from '../../db/pool.ts';
import { decrypt, encrypt, hmac, randomCode } from '../../lib/crypto.ts';

const PERIOD = 30;
const ISSUER = 'TRACED';
export const RECOVERY_CODE_COUNT = 10;

export function newTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

function totpFor(secretBase32: string, label: string): TOTP {
  return new TOTP({ issuer: ISSUER, label, algorithm: 'SHA1', digits: 6, period: PERIOD, secret: Secret.fromBase32(secretBase32) });
}

export function otpauthUrl(secretBase32: string, label: string): string {
  return totpFor(secretBase32, label).toString();
}

/** Returns the matched time step (for replay protection), or null. Accepts ±1 step of clock drift. */
export function matchTotp(secretBase32: string, code: string, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const delta = totpFor(secretBase32, 'x').validate({ token: code, window: 1, timestamp: now });
  if (delta === null) return null;
  return Math.floor(now / 1000 / PERIOD) + delta;
}

export function encryptSecret(deps: Deps, userId: string, secretBase32: string, kind: 'active' | 'pending'): string {
  return encrypt(deps.config.dataEncryptionKey, secretBase32, `users.mfa_${kind}:${userId}`);
}

export function decryptSecret(deps: Deps, userId: string, payload: string, kind: 'active' | 'pending'): string {
  return decrypt(deps.config.dataEncryptionKey, payload, `users.mfa_${kind}:${userId}`);
}

function normaliseRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

function recoveryHash(deps: Deps, userId: string, code: string): Buffer {
  return hmac(deps.config.tokenHmacKey, `recovery:${userId}:${normaliseRecoveryCode(code)}`);
}

/** Replaces all recovery codes; returns the plain codes to show the user once. */
export async function regenerateRecoveryCodes(db: Queryable, deps: Deps, userId: string): Promise<string[]> {
  await db.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId]);
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const raw = randomCode(10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  for (const code of codes) {
    await db.query('INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)', [userId, recoveryHash(deps, userId, code)]);
  }
  return codes;
}

export async function consumeRecoveryCode(db: Queryable, deps: Deps, userId: string, code: string): Promise<boolean> {
  const r = await db.query(
    'UPDATE mfa_recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL',
    [userId, recoveryHash(deps, userId, code)],
  );
  return (r.rowCount ?? 0) === 1;
}

/** Records the step atomically; false if this or a later step was already used (replayed code). */
export async function claimTotpStep(db: Queryable, userId: string, step: number): Promise<boolean> {
  const r = await db.query(
    `UPDATE users SET mfa_last_used_step = $2
      WHERE id = $1 AND (mfa_last_used_step IS NULL OR mfa_last_used_step < $2)`,
    [userId, step],
  );
  return (r.rowCount ?? 0) === 1;
}

/**
 * Step-up check for sensitive actions (Phase 7): a current authenticator code (not a recovery
 * code), each 30-second step usable once. Returns false for no enrolment, a wrong code or a reused
 * step.
 */
export async function verifyFreshTotp(db: Queryable, deps: Deps, userId: string, code: string): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;
  const { rows } = await db.query<{ enc: string | null }>('SELECT mfa_totp_secret_enc AS enc FROM users WHERE id = $1 AND mfa_enabled_at IS NOT NULL', [userId]);
  if (!rows[0]?.enc) return false;
  const step = matchTotp(decryptSecret(deps, userId, rows[0].enc, 'active'), code);
  return step !== null && (await claimTotpStep(db, userId, step));
}
