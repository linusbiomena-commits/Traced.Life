import type { Queryable } from '../db/pool.ts';
import { Errors } from '../lib/errors.ts';

export type Limit = { key: string; limit: number; windowSeconds: number };

/**
 * Fixed-window counter in Postgres (no extra service). Throws 429 with Retry-After once a key
 * exceeds its limit. Keys must not contain raw personal data (HMAC emails first).
 */
export async function enforceRateLimit(db: Queryable, { key, limit, windowSeconds }: Limit): Promise<void> {
  const { rows } = await db.query<{ count: number; retry_after: number }>(
    `WITH w AS (
       SELECT date_bin(make_interval(secs => $2), now(), TIMESTAMPTZ '2000-01-01') AS start
     )
     INSERT INTO rate_limits (key, window_start, count)
     SELECT $1, w.start, 1 FROM w
     ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count,
       GREATEST(1, CEIL(EXTRACT(EPOCH FROM (window_start + make_interval(secs => $2) - now()))))::int AS retry_after`,
    [key, windowSeconds],
  );
  const row = rows[0]!;
  if (row.count > limit) throw Errors.rateLimited(row.retry_after);
}

export async function enforceRateLimits(db: Queryable, limits: Limit[]): Promise<void> {
  for (const l of limits) await enforceRateLimit(db, l);
}

/** Housekeeping: drop windows older than a day. Called opportunistically and by cron later. */
export async function pruneRateLimits(db: Queryable): Promise<number> {
  const r = await db.query(`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`);
  return r.rowCount ?? 0;
}
