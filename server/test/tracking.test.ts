import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backfillPhase3 } from '../src/modules/tracking/backfill.ts';
import { formatTrackingId, parseTrackingId, trackingIdForFilename, trackingIdForUrl, TRACKING_ID_RE } from '../src/modules/tracking/tracking.ts';
import { register, registrationBody, yearsAgo } from './helpers/registration.ts';
import { setupTestApp, type TestEnv } from './helpers/test-app.ts';

let t: TestEnv;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(async () => {
  await t.close();
});

const allocate = async (at: string) =>
  (await t.db.query<{ period: string; seq: number; tracking_id: string }>('SELECT * FROM allocate_tracking_id($1::timestamptz)', [at])).rows[0]!;

describe('tracking ID format', () => {
  it('formats TRC-SA-MM/YY-XXXXX with zero padding and parses it back', () => {
    expect(formatTrackingId('2611', 1)).toBe('TRC-SA-11/26-00001');
    expect(formatTrackingId('2701', 99999)).toBe('TRC-SA-01/27-99999');
    expect(formatTrackingId('2612', 42)).toBe('TRC-SA-12/26-00042');
    expect(parseTrackingId('TRC-SA-11/26-00001')).toEqual({ month: 11, year: 2026, seq: 1, period: '2611' });
    for (const bad of ['TRC-SA-13/26-00001', 'TRC-SA-00/26-00001', 'TRC-SA-11/26-0001', 'TRC-AE-11/26-00001', 'trc-sa-11/26-00001']) {
      expect(parseTrackingId(bad), bad).toBeNull();
    }
    expect(() => formatTrackingId('2611', 0)).toThrow();
    expect(() => formatTrackingId('2611', 100000)).toThrow();
  });

  it('keeps the slash for display but makes it safe for file names and URLs', () => {
    expect(trackingIdForFilename('TRC-SA-11/26-00001')).toBe('TRC-SA-11-26-00001');
    expect(trackingIdForUrl('TRC-SA-11/26-00001')).toBe('TRC-SA-11%2F26-00001');
    expect(decodeURIComponent(trackingIdForUrl('TRC-SA-11/26-00001'))).toBe('TRC-SA-11/26-00001');
  });
});

describe('allocation in Asia/Riyadh time', () => {
  it('uses the Riyadh calendar month at the boundary (UTC+3)', async () => {
    expect((await allocate('2031-03-31T20:59:59.999Z')).tracking_id).toMatch(/^TRC-SA-03\/31-/); // 23:59:59 in Riyadh, still March
    expect((await allocate('2031-03-31T21:00:00Z')).tracking_id).toBe('TRC-SA-04/31-00001'); // 00:00 1 April in Riyadh
  });

  it('resets the sequence every calendar month', async () => {
    for (let i = 0; i < 3; i++) await allocate('2031-05-15T09:00:00Z');
    expect((await allocate('2031-05-31T20:00:00Z')).seq).toBe(4);
    expect((await allocate('2031-06-01T09:00:00Z')).tracking_id).toBe('TRC-SA-06/31-00001');
    expect((await allocate('2031-06-02T09:00:00Z')).tracking_id).toBe('TRC-SA-06/31-00002');
  });

  it('rolls over the year correctly', async () => {
    expect((await allocate('2031-12-31T20:59:59Z')).tracking_id).toBe('TRC-SA-12/31-00001');
    expect((await allocate('2031-12-31T21:00:00Z')).tracking_id).toBe('TRC-SA-01/32-00001');
  });

  it('gives 200 concurrent allocations 200 distinct, gap-free numbers', async () => {
    const results = await Promise.all(Array.from({ length: 200 }, () => allocate('2032-07-10T12:00:00Z')));
    expect(results.map((r) => r.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    expect(new Set(results.map((r) => r.tracking_id)).size).toBe(200);
  });

  it('a rolled-back allocation is not issued, and the next caller gets that number', async () => {
    const client = await t.db.connect();
    try {
      await client.query('BEGIN');
      const inTx = (await client.query<{ seq: number }>(`SELECT * FROM allocate_tracking_id('2033-01-10T10:00:00Z')`)).rows[0]!;
      await client.query('ROLLBACK');
      expect(inTx.seq).toBe(1);
    } finally {
      client.release();
    }
    expect((await allocate('2033-01-10T10:00:00Z')).seq).toBe(1);
  });

  it('stops safely at 99,999 per month: no duplicate, no wraparound, no change', async () => {
    await t.db.query(`INSERT INTO tracking_sequences (period, last_value) VALUES ('3402', 99998)`);
    expect((await allocate('2034-02-10T10:00:00Z')).tracking_id).toBe('TRC-SA-02/34-99999');
    await expect(allocate('2034-02-11T10:00:00Z')).rejects.toMatchObject({ code: 'TRX01' });
    const { rows } = await t.db.query(`SELECT last_value FROM tracking_sequences WHERE period = '3402'`);
    expect(rows[0]!.last_value).toBe(99999);
    expect((await allocate('2034-03-01T10:00:00Z')).tracking_id).toBe('TRC-SA-03/34-00001'); // next month is unaffected
  });
});

describe('tracking IDs on real registrations', () => {
  it('every registration gets one, in the current Riyadh month, unique across concurrent submissions', async () => {
    const customers = await Promise.all([t.customer(), t.customer(), t.customer()]);
    const bodies = await Promise.all(customers.map((cu) => registrationBody(cu.c)));
    const results = await Promise.all(customers.flatMap((cu, i) => Array.from({ length: 8 }, () =>
      cu.c.post('/me/registrations', bodies[i], { headers: { 'idempotency-key': randomUUID() } }))));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const ids = results.map((r) => r.body.registration.trackingId as string);
    expect(new Set(ids).size).toBe(24);
    const now = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Riyadh', month: '2-digit', year: '2-digit' }).format(new Date()); // "MM/YY"
    for (const id of ids) {
      expect(id).toMatch(TRACKING_ID_RE);
      expect(id.slice(7, 12)).toBe(now);
    }
    const db = await t.db.query('SELECT count(*)::int AS n, count(DISTINCT tracking_id)::int AS d FROM registrations');
    expect(db.rows[0]!.n).toBe(db.rows[0]!.d);
  });

  it('network retries and double submissions never allocate a second tracking ID', async () => {
    const cu = await t.customer();
    const body = await registrationBody(cu.c);
    const key = randomUUID();
    const before = (await t.db.query(`SELECT COALESCE(sum(last_value), 0)::int AS s FROM tracking_sequences`)).rows[0]!.s;
    const results = await Promise.all(Array.from({ length: 6 }, () => cu.c.post('/me/registrations', body, { headers: { 'idempotency-key': key } })));
    const after = (await t.db.query(`SELECT COALESCE(sum(last_value), 0)::int AS s FROM tracking_sequences`)).rows[0]!.s;
    expect(new Set(results.map((r) => r.body.registration.trackingId)).size).toBe(1);
    expect(after - before).toBe(1);
  });

  it('cancelled registrations keep their ID and it is never reused; registrations cannot be deleted', async () => {
    const cu = await t.customer();
    const a = (await register(cu.c)).body.registration;
    await t.db.query(`UPDATE registrations SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [a.id]);
    const b = (await register(cu.c)).body.registration;
    expect(parseTrackingId(b.trackingId)!.seq).toBeGreaterThan(parseTrackingId(a.trackingId)!.seq);
    expect((await t.db.query('SELECT tracking_id FROM registrations WHERE id = $1', [a.id])).rows[0]!.tracking_id).toBe(a.trackingId);
    await expect(t.db.query('DELETE FROM registrations WHERE id = $1', [a.id])).rejects.toThrow(/append-only/);
  });

  it('when the month is exhausted, registration fails cleanly: 503, nothing saved, counter unchanged', async () => {
    const cu = await t.customer();
    const body = await registrationBody(cu.c);
    const period = (await t.db.query<{ p: string }>(`SELECT to_char(now() AT TIME ZONE 'Asia/Riyadh', 'YYMM') AS p`)).rows[0]!.p;
    const saved = (await t.db.query<{ last_value: number }>('SELECT last_value FROM tracking_sequences WHERE period = $1', [period])).rows[0]!.last_value;
    const count = async () => (await t.db.query('SELECT count(*)::int AS n FROM registrations WHERE account_user_id = $1', [cu.userId])).rows[0]!.n;
    try {
      await t.db.query('UPDATE tracking_sequences SET last_value = 99999 WHERE period = $1', [period]);
      const res = await cu.c.post('/me/registrations', body, { headers: { 'idempotency-key': randomUUID() } });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('TRACKING_CAPACITY_REACHED');
      expect(await count()).toBe(0);
      expect((await t.db.query('SELECT last_value FROM tracking_sequences WHERE period = $1', [period])).rows[0]!.last_value).toBe(99999);
      expect((await t.db.query(`SELECT count(*)::int AS n FROM patients WHERE account_user_id = $1`, [cu.userId])).rows[0]!.n).toBe(0);
    } finally {
      await t.db.query('UPDATE tracking_sequences SET last_value = $2 WHERE period = $1', [period, saved]);
    }
    expect((await cu.c.post('/me/registrations', body, { headers: { 'idempotency-key': randomUUID() } })).status).toBe(201);
  });
});

describe('migration strategy for Phase 2 registrations without a tracking ID', () => {
  it('backfill assigns IDs in the original registration month, issues a QR, updates status, and is idempotent', async () => {
    const cu = await t.customer();
    const body = await registrationBody(cu.c);
    // A row exactly as Phase 2 created it (no tracking ID, no QR, status registration_completed).
    const p = await t.db.query<{ id: string }>(
      `INSERT INTO patients (account_user_id, relationship, first_name, last_name, date_of_birth, gender) VALUES ($1, 'child', 'Old', 'Record', $2, 'male') RETURNING id`,
      [cu.userId, yearsAgo(5)],
    );
    const legacy = await t.db.query<{ id: string }>(
      `INSERT INTO registrations (account_user_id, patient_id, branch_id, contact_full_name, contact_email, contact_phone,
         patient_age_months_at_registration, idempotency_key, request_fingerprint, created_at)
       VALUES ($1, $2, $3, 'Old Guardian', $4, '+966551234567', 60, $5, '\\x00', '2035-08-20T10:00:00+03')
       RETURNING id`,
      [cu.userId, p.rows[0]!.id, body.branchId, cu.email, randomUUID()],
    );
    const id = legacy.rows[0]!.id;
    await t.db.query(`INSERT INTO registration_status_history (registration_id, to_status, actor_role) VALUES ($1, 'registration_completed', 'customer')`, [id]);

    const first = await backfillPhase3(t.deps);
    expect(first.assigned).toBeGreaterThanOrEqual(1);
    const r = (await t.db.query('SELECT tracking_id, status FROM registrations WHERE id = $1', [id])).rows[0]!;
    expect(r).toEqual({ tracking_id: 'TRC-SA-08/35-00001', status: 'awaiting_sample_collection' });
    expect((await t.db.query(`SELECT count(*)::int AS n FROM customer_qr_tokens WHERE registration_id = $1 AND status = 'active'`, [id])).rows[0]!.n).toBe(1);
    expect((await t.db.query(`SELECT reason FROM registration_status_history WHERE registration_id = $1 ORDER BY id DESC LIMIT 1`, [id])).rows[0]!.reason).toMatch(/backfill/);
    expect((await t.db.query(`SELECT count(*)::int AS n FROM email_outbox WHERE registration_id = $1`, [id])).rows[0]!.n).toBe(0); // no emails unless asked

    expect((await backfillPhase3(t.deps)).assigned).toBe(0);
    expect((await cu.c.get(`/me/registrations/${id}`)).body.registration.qrCode.available).toBe(true);
  });
});
