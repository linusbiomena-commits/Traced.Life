import type { Deps } from '../../context.ts';
import type { Queryable } from '../../db/pool.ts';
import { hmac, randomToken } from '../../lib/crypto.ts';

export type TokenPurpose = 'verify_email' | 'reset_password' | 'account_setup';

export const TOKEN_TTL_SECONDS: Record<TokenPurpose, number> = {
  verify_email: 24 * 3600,
  reset_password: 30 * 60,
  account_setup: 72 * 3600,
};

function hashOf(deps: Deps, purpose: TokenPurpose, token: string): Buffer {
  return hmac(deps.config.tokenHmacKey, `${purpose}:${token}`);
}

/** Issues a single-use emailed token. Any older unused token for the same purpose stops working. */
export async function issueToken(db: Queryable, deps: Deps, userId: string, purpose: TokenPurpose, createdBy: string | null = null): Promise<string> {
  await db.query(
    `UPDATE auth_tokens SET expires_at = LEAST(expires_at, now())
      WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`,
    [userId, purpose],
  );
  const token = randomToken(32);
  await db.query(
    `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at, created_by)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4), $5)`,
    [userId, purpose, hashOf(deps, purpose, token), TOKEN_TTL_SECONDS[purpose], createdBy],
  );
  return token;
}

/** Atomically marks a valid token as used. Returns its user id, or null if invalid, used or expired. */
export async function consumeToken(db: Queryable, deps: Deps, token: string, purpose: TokenPurpose): Promise<string | null> {
  const { rows } = await db.query<{ user_id: string }>(
    `UPDATE auth_tokens SET used_at = now()
      WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id`,
    [hashOf(deps, purpose, token), purpose],
  );
  return rows[0]?.user_id ?? null;
}
