import type { Deps } from '../../context.ts';
import type { Queryable } from '../../db/pool.ts';
import { decrypt, encrypt, hmac, randomToken } from '../../lib/crypto.ts';

// Physical-sample QR codes (Phase 6). Same design as customer QR codes, separate keys and table:
//   https://<site>/traced/s/#s1_<43 base64url chars>
// The QR carries no personal, medical or tracking data. The prefix keeps sample tokens ("s1_")
// and customer tokens ("c1_") apart, so neither scanner accepts the other's code. Scanning a
// sample QR never changes custody by itself: an authorised operator must confirm an action.

export const SAMPLE_TOKEN_PREFIX = 's1_';
const SAMPLE_TOKEN_RE = /^s1_[A-Za-z0-9_-]{43}$/;
/** Physical sample ID typed by hand (fallback when a label can't be scanned). */
export const SAMPLE_CODE_RE = /^TRC-SA-(0[1-9]|1[0-2])\/\d{2}-\d{5}-S\d{2}$/;

export function newSampleToken(): string {
  return `${SAMPLE_TOKEN_PREFIX}${randomToken(32)}`; // 256 bits
}

export function sampleTokenHmac(deps: Deps, token: string): Buffer {
  return hmac(deps.config.tokenHmacKey, `qr:sample:${token}`);
}

const encContext = (sampleId: string) => `sample_qr:${sampleId}`;

export function sampleQrUrl(appOrigin: string, token: string): string {
  return `${appOrigin}/traced/s/#${token}`;
}

/** What a scanner returned: a sample token (from the QR) or a typed physical sample ID. */
export function parseSampleCode(scanned: string): { kind: 'token'; value: string } | { kind: 'sample_id'; value: string } | null {
  const value = scanned.trim();
  if (!value || value.length > 300) return null;
  const candidate = value.includes('#') ? value.slice(value.lastIndexOf('#') + 1) : value;
  if (SAMPLE_TOKEN_RE.test(candidate)) return { kind: 'token', value: candidate };
  const upper = value.toUpperCase();
  if (SAMPLE_CODE_RE.test(upper)) return { kind: 'sample_id', value: upper };
  return null;
}

export async function issueSampleQr(tx: Queryable, deps: Deps, sampleId: string, actorUserId: string): Promise<void> {
  const token = newSampleToken();
  await tx.query(
    'INSERT INTO sample_qr_tokens (sample_id, token_hmac, token_enc, created_by) VALUES ($1, $2, $3, $4)',
    [sampleId, sampleTokenHmac(deps, token), encrypt(deps.config.dataEncryptionKey, token, encContext(sampleId)), actorUserId],
  );
}

/** The active token, decrypted only to render the label QR. Never logged or returned as text. */
export async function activeSampleToken(db: Queryable, deps: Deps, sampleId: string): Promise<string | null> {
  const { rows } = await db.query<{ token_enc: string }>(`SELECT token_enc FROM sample_qr_tokens WHERE sample_id = $1 AND status = 'active'`, [sampleId]);
  return rows[0] ? decrypt(deps.config.dataEncryptionKey, rows[0].token_enc, encContext(sampleId)) : null;
}
