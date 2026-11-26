import type { Queryable } from '../../db/pool.ts';
import { AppError } from '../../lib/errors.ts';

// Public tracking ID: TRC-SA-MM/YY-XXXXX (month/year in Asia/Riyadh, 5-digit monthly sequence).
// It identifies a registration for people; it is never an authentication credential, and
// internal references always use the registration UUID.

export const TRACKING_ID_RE = /^TRC-SA-(0[1-9]|1[0-2])\/([0-9]{2})-([0-9]{5})$/;
export const MAX_MONTHLY_SEQUENCE = 99_999;

export function formatTrackingId(period: string, seq: number): string {
  if (!/^[0-9]{2}(0[1-9]|1[0-2])$/.test(period)) throw new Error(`invalid period ${period}`);
  if (!Number.isInteger(seq) || seq < 1 || seq > MAX_MONTHLY_SEQUENCE) throw new Error(`invalid sequence ${seq}`);
  return `TRC-SA-${period.slice(2, 4)}/${period.slice(0, 2)}-${String(seq).padStart(5, '0')}`;
}

export function parseTrackingId(id: string): { month: number; year: number; seq: number; period: string } | null {
  const m = TRACKING_ID_RE.exec(id);
  if (!m) return null;
  return { month: Number(m[1]), year: 2000 + Number(m[2]), seq: Number(m[3]), period: `${m[2]}${m[1]}` };
}

/** Slash-free form for file names (the displayed ID keeps its slash). */
export function trackingIdForFilename(id: string): string {
  return id.replace('/', '-');
}

/** Tracking IDs go into URLs only percent-encoded (the slash becomes %2F). */
export function trackingIdForUrl(id: string): string {
  return encodeURIComponent(id);
}

/**
 * Allocates the next tracking ID inside the caller's transaction (see allocate_tracking_id in
 * migration 0005). `at` is for tests and backfills; normal registrations use the DB clock.
 */
export async function allocateTrackingId(tx: Queryable, at?: Date): Promise<{ period: string; seq: number; trackingId: string }> {
  try {
    const { rows } = await tx.query<{ period: string; seq: number; tracking_id: string }>(
      'SELECT period, seq, tracking_id FROM allocate_tracking_id(COALESCE($1::timestamptz, now()))',
      [at ?? null],
    );
    const r = rows[0]!;
    return { period: r.period, seq: r.seq, trackingId: r.tracking_id };
  } catch (err) {
    if ((err as { code?: string }).code === 'TRX01') {
      throw new AppError(503, 'TRACKING_CAPACITY_REACHED', 'Registrations are temporarily unavailable. Please try again later.');
    }
    throw err;
  }
}
