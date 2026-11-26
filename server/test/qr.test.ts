import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customerTokenHmac, extractCustomerToken, newCustomerToken } from '../src/modules/qr/qr.service.ts';
import { assignBranch, customerWithRegistration, decodeQrPng, getBinary } from './helpers/registration.ts';
import { setupTestApp, type TestEnv } from './helpers/test-app.ts';

let t: TestEnv;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(async () => {
  await t.close();
});

const STAFF_KEYS = ['branch', 'canCollect', 'collectionInstructions', 'collectionSessionId', 'devVerificationAvailable', 'identityVerification', 'patientAge', 'patientGender', 'qrValid', 'sampleStatus', 'sampleType', 'trackingId'];

/** Reads the QR from the customer's own PNG download and returns the token inside it. */
async function tokenFromQr(c: Parameters<typeof getBinary>[1], registrationId: string) {
  const png = await getBinary(t, c, `/me/registrations/${registrationId}/qr.png`);
  expect(png.status).toBe(200);
  const text = decodeQrPng(png.body)!;
  return { text, token: extractCustomerToken(text)! };
}

describe('QR tokens', () => {
  it('are random 256-bit tokens with a customer type prefix, all unique', () => {
    const tokens = Array.from({ length: 2000 }, newCustomerToken);
    expect(new Set(tokens).size).toBe(2000);
    for (const tok of tokens.slice(0, 50)) {
      expect(tok).toMatch(/^c1_[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(tok.slice(3), 'base64url')).toHaveLength(32);
    }
  });

  it('scanner input: full URL or bare token accepted; tracking IDs and junk rejected', () => {
    const tok = newCustomerToken();
    expect(extractCustomerToken(`https://x.test/traced/c/#${tok}`)).toBe(tok);
    expect(extractCustomerToken(`  ${tok}\n`)).toBe(tok);
    for (const bad of ['TRC-SA-11/26-00001', 's1_' + tok.slice(3), 'c1_short', '', 'x'.repeat(400)]) expect(extractCustomerToken(bad)).toBeNull();
  });
});

describe('customer QR generation and download', () => {
  it('each registration gets a scannable QR holding only a URL + token; the DB stores a hash and an encrypted copy', async () => {
    const { c, registration, email } = await customerWithRegistration(t);
    const { text, token } = await tokenFromQr(c, registration.id);
    expect(text).toMatch(/^http:\/\/localhost:8787\/traced\/c\/#c1_[A-Za-z0-9_-]{43}$/);
    for (const pii of ['Layla', 'Harbi', email, '551234567', registration.patient.dateOfBirth, registration.trackingId]) expect(text).not.toContain(pii);

    const { rows } = await t.db.query<{ token_hmac: Buffer; token_enc: string; status: string }>(
      'SELECT token_hmac, token_enc, status FROM customer_qr_tokens WHERE registration_id = $1', [registration.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('active');
    expect(rows[0]!.token_hmac.equals(customerTokenHmac(t.deps, token))).toBe(true);
    expect(rows[0]!.token_enc.startsWith('v1.')).toBe(true);
    expect(rows[0]!.token_enc).not.toContain(token.slice(3));
  });

  it('PNG and SVG downloads: correct types, slash-safe file names, no caching, redisplay shows the same QR', async () => {
    const { c, registration } = await customerWithRegistration(t);
    const fileId = registration.trackingId.replace('/', '-');
    const png = await getBinary(t, c, `/me/registrations/${registration.id}/qr.png?download=1`);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(png.body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    expect(png.headers.get('content-disposition')).toBe(`attachment; filename="TRACED-${fileId}.png"`);
    expect(png.headers.get('cache-control')).toContain('no-store');

    const svg = await getBinary(t, c, `/me/registrations/${registration.id}/qr.svg`);
    expect(svg.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8');
    expect(svg.headers.get('content-disposition')).toBe(`inline; filename="TRACED-${fileId}.svg"`);
    const svgText = svg.body.toString('utf8');
    expect(svgText.startsWith('<svg')).toBe(true);
    expect(svgText).not.toMatch(/<script|onload=|href=/i);

    const again = await tokenFromQr(c, registration.id);
    const first = await tokenFromQr(c, registration.id);
    expect(again.token).toBe(first.token); // the same QR can be shown and downloaded again
  });

  it('customers cannot see other customers’ QR codes; staff and signed-out users get nothing', async () => {
    const a = await customerWithRegistration(t);
    const b = await t.customer();
    const other = await getBinary(t, b.c, `/me/registrations/${a.registration.id}/qr.png`);
    expect(other.status).toBe(404);
    expect(other.body.toString('utf8')).not.toContain('c1_');
    expect((await getBinary(t, t.client(), `/me/registrations/${a.registration.id}/qr.png`)).status).toBe(401);
    const staff = await t.staff(['collection_staff']);
    expect((await getBinary(t, staff.c, `/me/registrations/${a.registration.id}/qr.svg`)).status).toBe(403);
  });
});

describe('staff QR validation service (for the Phase 4 scanner)', () => {
  it('requires staff permission and assignment to the registration’s branch', async () => {
    const { c, registration } = await customerWithRegistration(t);
    const { text } = await tokenFromQr(c, registration.id);
    expect((await t.client().post('/staff/qr/validate', { code: text })).status).toBe(401);
    expect((await c.post('/staff/qr/validate', { code: text })).status).toBe(403); // customers can't validate
    const staff = await t.staff(['collection_staff']);
    const denied = await staff.c.post('/staff/qr/validate', { code: text });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('BRANCH_NOT_AUTHORIZED');
    expect(JSON.stringify(denied.body)).not.toMatch(/Layla|TRC-SA/);
  });

  it('returns ONLY the allowlisted fields: age, gender, tracking ID, validity, sample type/status, instructions, ID status', async () => {
    const { c, registration, email } = await customerWithRegistration(t);
    const { text, token } = await tokenFromQr(c, registration.id);
    const staff = await t.staff(['collection_staff']);
    await assignBranch(t, staff.userId, registration.branch.id);

    const res = await staff.c.post('/staff/qr/validate', { code: text });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(STAFF_KEYS);
    expect(res.body).toMatchObject({
      qrValid: true, trackingId: registration.trackingId, patientAge: registration.patient.age, patientGender: 'female',
      sampleType: 'hair', sampleStatus: 'awaiting_sample_collection', identityVerification: { status: 'not_verified', method: null }, canCollect: false,
    });
    const json = JSON.stringify(res.body);
    for (const pii of ['Layla', 'Al-Harbi', 'Fatimah', email, '551234567', registration.patient.dateOfBirth, registration.id, token]) expect(json).not.toContain(pii);

    // A keyboard-wedge scanner may type just the token.
    expect((await staff.c.post('/staff/qr/validate', { code: token })).body.qrValid).toBe(true);
    const audit = await t.db.query(`SELECT fields_accessed, metadata::text AS m FROM audit_logs WHERE action = 'qr.validated' AND outcome = 'success' AND target_id = $1`, [registration.id]);
    expect(audit.rows[0]!.fields_accessed).toEqual(['patient.age', 'patient.gender', 'registration.tracking_id', 'registration.status']);
  });

  it('unknown, malformed and tracking-ID inputs are not valid (the tracking ID is not a credential)', async () => {
    const { registration } = await customerWithRegistration(t);
    const staff = await t.staff(['collection_staff']);
    await assignBranch(t, staff.userId, registration.branch.id);
    expect((await staff.c.post('/staff/qr/validate', { code: newCustomerToken() })).body).toEqual({ qrValid: false, reason: 'NOT_FOUND' });
    expect((await staff.c.post('/staff/qr/validate', { code: registration.trackingId })).body).toEqual({ qrValid: false, reason: 'UNRECOGNISED' });
    expect((await staff.c.post('/staff/qr/validate', { code: 'hello' })).body).toEqual({ qrValid: false, reason: 'UNRECOGNISED' });
  });
});

describe('revocation and regeneration', () => {
  it('replacing a QR revokes the old one permanently and issues a new one', async () => {
    const { c, registration } = await customerWithRegistration(t);
    const staff = await t.staff(['collection_staff']);
    await assignBranch(t, staff.userId, registration.branch.id);
    const old = await tokenFromQr(c, registration.id);

    const res = await c.post(`/me/registrations/${registration.id}/qr/regenerate`, {});
    expect(res.status).toBe(200);
    const fresh = await tokenFromQr(c, registration.id);
    expect(fresh.token).not.toBe(old.token);
    expect(res.body.registration.trackingId).toBe(registration.trackingId); // tracking ID never changes

    expect((await staff.c.post('/staff/qr/validate', { code: old.text })).body).toEqual({ qrValid: false, reason: 'REPLACED' });
    expect((await staff.c.post('/staff/qr/validate', { code: fresh.text })).body.qrValid).toBe(true);

    const rows = (await t.db.query(`SELECT status FROM customer_qr_tokens WHERE registration_id = $1 ORDER BY created_at`, [registration.id])).rows.map((r) => r.status);
    expect(rows).toEqual(['revoked', 'active']);
    await expect(t.db.query(`UPDATE customer_qr_tokens SET status = 'active', revoked_at = NULL WHERE registration_id = $1 AND status = 'revoked'`, [registration.id])).rejects.toThrow(/revoked QR token cannot change state/);
    await expect(t.db.query(`DELETE FROM customer_qr_tokens WHERE registration_id = $1`, [registration.id])).rejects.toThrow(/append-only/);
  });

  it('cannot be done after collection, and another customer cannot do it', async () => {
    const { c, registration } = await customerWithRegistration(t);
    const other = await t.customer();
    expect((await other.c.post(`/me/registrations/${registration.id}/qr/regenerate`, {})).status).toBe(404);
    await t.db.query(`UPDATE registrations SET status = 'sample_collected' WHERE id = $1`, [registration.id]);
    const res = await c.post(`/me/registrations/${registration.id}/qr/regenerate`, {});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('QR_LOCKED');
  });

  it('a cancelled registration’s QR can no longer be shown or validated', async () => {
    const { c, registration } = await customerWithRegistration(t);
    const { text } = await tokenFromQr(c, registration.id);
    const staff = await t.staff(['collection_staff']);
    await assignBranch(t, staff.userId, registration.branch.id);
    await t.db.query(`UPDATE registrations SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [registration.id]);
    expect((await getBinary(t, c, `/me/registrations/${registration.id}/qr.png`)).status).toBe(404);
    expect((await staff.c.post('/staff/qr/validate', { code: text })).body).toEqual({ qrValid: false, reason: 'REGISTRATION_INACTIVE' });
  });
});

describe('secret hygiene', () => {
  it('no QR token appears in audit logs, outbox rows or API JSON', async () => {
    const { c, registration } = await customerWithRegistration(t);
    const { token } = await tokenFromQr(c, registration.id);
    await c.post(`/me/registrations/${registration.id}/resend-email`, {});
    await t.settleMail();
    const audit = await t.db.query(`SELECT string_agg(metadata::text || coalesce(target_id, ''), ' ') AS s FROM audit_logs`);
    expect(audit.rows[0]!.s).not.toContain(token.slice(3));
    const outbox = await t.db.query(`SELECT string_agg(coalesce(payload_enc, '') || coalesce(last_error, ''), ' ') AS s FROM email_outbox`);
    expect(outbox.rows[0]!.s ?? '').not.toContain(token.slice(3));
    expect(JSON.stringify((await c.get(`/me/registrations/${registration.id}`)).body)).not.toContain(token.slice(3));
    expect(JSON.stringify((await c.get('/me/registrations')).body)).not.toContain(token.slice(3));
  });
});
