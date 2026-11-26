import QRCode from 'qrcode';
import type { Deps } from '../../context.ts';
import type { Queryable } from '../../db/pool.ts';
import { decrypt, encrypt, hmac, randomToken } from '../../lib/crypto.ts';
import { AppError } from '../../lib/errors.ts';

// Customer QR codes. The QR holds only a URL with a random 256-bit token in the #fragment:
//   https://<site>/traced/c/#c1_<43 base64url chars>
// No personal or medical data, and no tracking ID. The fragment is never sent to servers or
// in Referer headers. The token type prefix keeps customer tokens ("c1_") distinct from the
// future physical-sample tokens ("s1_", Phase 6), which will have their own table and keys.

export const CUSTOMER_TOKEN_PREFIX = 'c1_';
const CUSTOMER_TOKEN_RE = /^c1_[A-Za-z0-9_-]{43}$/;

export function newCustomerToken(): string {
  return `${CUSTOMER_TOKEN_PREFIX}${randomToken(32)}`; // 32 random bytes = 256 bits
}

export function customerTokenHmac(deps: Deps, token: string): Buffer {
  return hmac(deps.config.tokenHmacKey, `qr:customer:${token}`);
}

const encContext = (registrationId: string) => `customer_qr:${registrationId}`;

export function qrUrl(appOrigin: string, locale: 'en' | 'ar', token: string): string {
  return `${appOrigin}${locale === 'ar' ? '/ar' : ''}/traced/c/#${token}`;
}

/** Accepts what a scanner returns (full URL, or the bare token from a keyboard-wedge scanner). */
export function extractCustomerToken(scanned: string): string | null {
  const value = scanned.trim();
  if (value.length > 300) return null;
  const candidate = value.includes('#') ? value.slice(value.lastIndexOf('#') + 1) : value;
  return CUSTOMER_TOKEN_RE.test(candidate) ? candidate : null;
}

/** Creates the registration's active QR token. Returns the raw token (never logged or audited). */
export async function issueCustomerQr(tx: Queryable, deps: Deps, registrationId: string, actorUserId: string | null): Promise<string> {
  const token = newCustomerToken();
  await tx.query(
    `INSERT INTO customer_qr_tokens (registration_id, token_hmac, token_enc, created_by) VALUES ($1, $2, $3, $4)`,
    [registrationId, customerTokenHmac(deps, token), encrypt(deps.config.dataEncryptionKey, token, encContext(registrationId)), actorUserId],
  );
  return token;
}

/** The active token for redisplay/download, decrypted on demand; null if none. */
export async function activeCustomerToken(db: Queryable, deps: Deps, registrationId: string): Promise<string | null> {
  const { rows } = await db.query<{ token_enc: string }>(
    `SELECT token_enc FROM customer_qr_tokens WHERE registration_id = $1 AND status = 'active'`,
    [registrationId],
  );
  return rows[0] ? decrypt(deps.config.dataEncryptionKey, rows[0].token_enc, encContext(registrationId)) : null;
}

const QR_OPTIONS = { errorCorrectionLevel: 'M' as const, margin: 2, color: { dark: '#201f1aff', light: '#ffffffff' } };

export function renderQrPng(text: string, width = 512): Promise<Buffer> {
  return QRCode.toBuffer(text, { ...QR_OPTIONS, type: 'png', width });
}

export async function renderQrSvg(text: string): Promise<string> {
  const svg = await QRCode.toString(text, { ...QR_OPTIONS, type: 'svg' });
  if (!svg.startsWith('<svg') || /<script|on[a-z]+=/i.test(svg)) throw new AppError(500, 'QR_RENDER_FAILED', 'Could not render the QR code.');
  return svg;
}
