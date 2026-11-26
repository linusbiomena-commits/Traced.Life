import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LAB_SAMPLE_KEYS, LABEL_KEYS, STAFF_SAMPLE_KEYS } from '../src/modules/custody/custody.service.ts';
import { extractCustomerToken } from '../src/modules/qr/qr.service.ts';
import { assignBranch, customerWithRegistration, decodeQrPng, getBinary, yearsAgo } from './helpers/registration.ts';
import { setupTestApp, type TestClient, type TestEnv } from './helpers/test-app.ts';

let t: TestEnv;
let branch: Record<string, string>;
let lab: Awaited<ReturnType<TestEnv['mfaStaff']>>;
let admin: Awaited<ReturnType<TestEnv['mfaStaff']>>;
let staffRuh: Awaited<ReturnType<TestEnv['staff']>>;

beforeAll(async () => {
  t = await setupTestApp();
  const { rows } = await t.db.query<{ code: string; id: string }>('SELECT code, id FROM collection_branches');
  branch = Object.fromEntries(rows.map((r) => [r.code, r.id]));
  lab = await t.mfaStaff(['lab_operator']);
  admin = await t.mfaStaff(['admin']);
  staffRuh = await staffAt(['DEV-RUH-01']);
});
afterAll(async () => t.close());

const letters = () => [...randomBytes(4)].map((b) => String.fromCharCode(97 + (b % 26))).join('');
async function staffAt(codes: string[]) {
  const s = await t.staff(['collection_staff']);
  for (const code of codes) await assignBranch(t, s.userId, branch[code]!);
  return s;
}
async function registrationWithQr(overrides: Record<string, unknown> = {}) {
  const cust = await customerWithRegistration(t, { branchId: branch['DEV-RUH-01'], ...overrides });
  const png = await getBinary(t, cust.c, `/me/registrations/${cust.registration.id}/qr.png`);
  return { ...cust, text: decodeQrPng(png.body)! };
}
/** Full Phase 4 collection (scan → dev identity → checklist → confirm). Returns the confirm response. */
async function collect(staff: TestClient, qrText: string) {
  const v = (await staff.post('/staff/qr/validate', { code: qrText, branchId: branch['DEV-RUH-01'] })).body;
  const ready = (await staff.post(`/staff/collection-sessions/${v.collectionSessionId}/identity/dev`, { outcome: 'verified' })).body;
  return staff.post(`/staff/collection-sessions/${v.collectionSessionId}/collect`, {
    instructionsId: ready.collectionInstructions.id, checklist: ready.collectionInstructions.checklist.map((i: { id: string }) => i.id),
  });
}
/** The physical sample QR content, decoded from the label PNG (not from the database). */
async function sampleQrText(c: TestClient, sampleRowId: string, base = '/staff') {
  const png = await getBinary(t, c, `${base}/samples/${sampleRowId}/qr.png`);
  expect(png.status).toBe(200);
  return decodeQrPng(png.body)!;
}
async function collected(overrides: Record<string, unknown> = {}) {
  const reg = await registrationWithQr(overrides);
  const res = await collect(staffRuh.c, reg.text);
  expect(res.status).toBe(200);
  const sample = res.body.collection.sample as { id: string; sampleId: string };
  return { ...reg, sample, code: await sampleQrText(staffRuh.c, sample.id) };
}
const act = (c: TestClient, side: 'staff' | 'lab', code: string, action: string, expectedStatus: string, extra: Record<string, unknown> = {}) =>
  c.post(`/${side}/samples/action`, { code, action, expectedStatus, idempotencyKey: randomUUID(), ...extra });
async function toDispatched(code: string) {
  expect((await act(staffRuh.c, 'staff', code, 'package', 'collected')).status).toBe(200);
  expect((await act(staffRuh.c, 'staff', code, 'ready_for_dispatch', 'packaged')).status).toBe(200);
  expect((await act(staffRuh.c, 'staff', code, 'dispatch', 'ready_for_dispatch', { courier: 'SMSA Express', shipmentTrackingNumber: 'TEST-123456' })).status).toBe(200);
}
const events = async (sampleRowId: string) => (await t.db.query('SELECT * FROM custody_events WHERE sample_id = $1 ORDER BY id', [sampleRowId])).rows;

describe('physical sample identification', () => {
  it('collection allocates TRC-SA-MM/YY-XXXXX-S01, a separate sample QR, an initial custody event; the customer QR is spent', async () => {
    const { registration, sample, code, text } = await collected();
    expect(sample.sampleId).toBe(`${registration.trackingId}-S01`);
    expect(sample.sampleId).toMatch(/^TRC-SA-(0[1-9]|1[0-2])\/\d{2}-\d{5}-S01$/);
    expect(code).toMatch(/^http:\/\/localhost:8787\/traced\/s\/#s1_[A-Za-z0-9_-]{43}$/);
    expect(code).not.toContain(registration.trackingId);
    expect(extractCustomerToken(code)).toBeNull(); // sample QR is not a customer QR
    const ev = await events(sample.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ from_status: null, to_status: 'collected', location_type: 'branch', identified_by: 'collection_session', actor_role: 'collection_staff' });
    const qr = await t.db.query(`SELECT status FROM customer_qr_tokens WHERE registration_id = $1`, [registration.id]);
    expect(qr.rows.map((r) => r.status)).toEqual(['used']);
    expect((await staffRuh.c.post('/staff/qr/validate', { code: text, branchId: branch['DEV-RUH-01'] })).body.qrValid).toBe(false);
    // Tokens are stored only as a keyed hash + encrypted value; the raw token isn't anywhere.
    const token = code.split('#')[1]!;
    const raw = await t.db.query(`SELECT token_enc, encode(token_hmac, 'hex') AS h FROM sample_qr_tokens WHERE sample_id = $1`, [sample.id]);
    expect(raw.rows[0].token_enc).not.toContain(token);
    const logs = await t.db.query(`SELECT metadata::text AS m FROM audit_logs`);
    expect(logs.rows.some((r) => r.m.includes(token))).toBe(false);
  });

  it('identifiers are unique under concurrent collections, and the sequence can never be reused', async () => {
    const regs = await Promise.all(Array.from({ length: 5 }, () => registrationWithQr()));
    const results = await Promise.all(regs.map((r) => collect(staffRuh.c, r.text)));
    const ids = results.map((r) => r.body.collection.sample.sampleId);
    expect(new Set(ids).size).toBe(5);
    expect(ids.every((id: string) => id.endsWith('-S01'))).toBe(true);
    await expect(t.db.query(`UPDATE samples SET sample_code = 'TRC-SA-01/26-00001-S09' WHERE sample_code = $1`, [ids[0]])).rejects.toThrow(/immutable/);
    await expect(t.db.query(`INSERT INTO samples (registration_id, branch_id, collected_by, collection_session_id, identity_verification_id, instructions_id, checklist, sample_seq, sample_code)
      SELECT registration_id, branch_id, collected_by, gen_random_uuid(), identity_verification_id, instructions_id, checklist, sample_seq, sample_code || 'X' FROM samples WHERE sample_code = $1`, [ids[1]])).rejects.toThrow();
  });

  it('a customer QR is refused by the sample scanner and a sample QR by the customer-QR scanner; unknown codes reveal nothing', async () => {
    const { code } = await collected();
    const reg2 = await registrationWithQr();
    expect((await staffRuh.c.post('/staff/samples/scan', { code: reg2.text })).body.error.code).toBe('SAMPLE_NOT_RECOGNISED');
    expect((await staffRuh.c.post('/staff/qr/validate', { code, branchId: branch['DEV-RUH-01'] })).body.qrValid).toBe(false);
    for (const bad of ['http://evil.example/traced/s/#s1_' + 'A'.repeat(43), 'hello', 'TRC-SA-11/26-99999-S01']) {
      const r = await lab.c.post('/lab/samples/scan', { code: bad });
      expect(r.status).toBe(404);
      expect(JSON.stringify(r.body)).not.toMatch(/patient|Layla/);
    }
  });
});

describe('labels', () => {
  it('label content has no personal data; first print free, reprints need a reason; all audited; other branches refused', async () => {
    const { sample } = await collected({ patient: { firstName: 'Canarylabel', lastName: 'Personal', dateOfBirth: yearsAgo(8), gender: 'female' } });
    const label = (await staffRuh.c.get(`/staff/samples/${sample.id}/label`)).body.label;
    expect(Object.keys(label).sort()).toEqual(LABEL_KEYS);
    expect(label).toMatchObject({ sampleId: sample.sampleId, sampleType: 'hair', prints: 0, sizes: ['50x30', '50x25', '62x29'] });
    expect(JSON.stringify(label)).not.toMatch(/Canarylabel|Personal|female|@|\+966/);
    expect((await staffRuh.c.post(`/staff/samples/${sample.id}/label-print`, { size: '50x30' })).body).toEqual({ printNumber: 1, reprint: false });
    expect((await staffRuh.c.post(`/staff/samples/${sample.id}/label-print`, { size: '50x30' })).body.error.code).toBe('REPRINT_REASON_REQUIRED');
    expect((await staffRuh.c.post(`/staff/samples/${sample.id}/label-print`, { size: '50x25', reason: 'Label smudged during packing' })).body).toEqual({ printNumber: 2, reprint: true });
    const a = await t.db.query(`SELECT metadata FROM audit_logs WHERE action = 'sample.label_reprinted' AND target_id = $1`, [sample.id]);
    expect(a.rows[0].metadata).toMatchObject({ reason: 'Label smudged during packing', printNumber: 2 });
    const other = await staffAt(['DEV-JED-01']);
    for (const p of [`/staff/samples/${sample.id}/label`, `/staff/samples/${sample.id}/qr.png`]) expect((await other.c.get(p)).status).toBe(403);
    expect((await (await t.customer()).c.get(`/staff/samples/${sample.id}/qr.svg`)).status).toBe(403);
    const svg = await getBinary(t, staffRuh.c, `/staff/samples/${sample.id}/qr.svg`);
    expect(svg.headers.get('content-type')).toContain('image/svg+xml');
    expect(svg.body.toString()).not.toMatch(/<script|s1_/); // the token is drawn, not written as text
  });
});

describe('branch custody: package, ready, dispatch', () => {
  it('a scan never changes status; staff see age/gender only; the matrix and required handover data are enforced', async () => {
    const { sample, code } = await collected({ patient: { firstName: 'Canaryscan', lastName: 'Hidden', dateOfBirth: yearsAgo(9), gender: 'male' }, contact: { fullName: 'Canary Parent', phone: '0551112299' } });
    const scan = await staffRuh.c.post('/staff/samples/scan', { code });
    expect(Object.keys(scan.body.sample).sort()).toEqual(STAFF_SAMPLE_KEYS);
    expect(scan.body.sample).toMatchObject({ status: 'collected', patientGender: 'male', allowedActions: ['package'] });
    expect(JSON.stringify(scan.body)).not.toMatch(/Canary|Hidden|@|551112299|dateOfBirth/);
    expect((await events(sample.id))).toHaveLength(1);
    expect((await act(staffRuh.c, 'staff', code, 'dispatch', 'collected', { courier: 'X', shipmentTrackingNumber: 'Y' })).body.error.code).toBe('TRANSITION_NOT_ALLOWED');
    expect((await act(staffRuh.c, 'staff', code, 'package', 'packaged')).body.error.code).toBe('STATUS_CHANGED');
    expect((await act(staffRuh.c, 'staff', code, 'receive', 'collected', { condition: 'intact' })).body.error.code).toBe('ACTION_NOT_ALLOWED');
    expect((await act(staffRuh.c, 'staff', code, 'package', 'collected')).body.status).toBe('packaged');
    expect((await act(staffRuh.c, 'staff', code, 'ready_for_dispatch', 'packaged')).body.status).toBe('ready_for_dispatch');
    expect((await act(staffRuh.c, 'staff', code, 'dispatch', 'ready_for_dispatch')).body.error.code).toBe('DISPATCH_DETAILS_REQUIRED');
    const d = await act(staffRuh.c, 'staff', code, 'dispatch', 'ready_for_dispatch', { courier: 'Aramex', shipmentTrackingNumber: 'AWB-778899' });
    expect(d.body.sample.dispatch).toMatchObject({ courier: 'Aramex', shipmentTrackingNumber: 'AWB-778899' });
    const ev = await events(sample.id);
    expect(ev.map((e) => e.to_status)).toEqual(['collected', 'packaged', 'ready_for_dispatch', 'dispatched']);
    expect(ev[3]).toMatchObject({ from_status: 'ready_for_dispatch', identified_by: 'sample_qr', location_type: 'branch' });
    expect(ev[3].handover).toMatchObject({ verification: 'dispatch_record_only' });
    const reg = (await t.db.query('SELECT r.status FROM registrations r JOIN samples s ON s.registration_id = r.id WHERE s.id = $1', [sample.id])).rows[0];
    expect(reg.status).toBe('dispatched');
    // Nobody can record "in transit" without transport accounts.
    expect((await act(staffRuh.c, 'staff', code, 'receive', 'dispatched', { condition: 'intact' })).status).toBe(422);
  });

  it('staff of another branch can neither scan nor act; requests are idempotent', async () => {
    const { sample, code } = await collected();
    const other = await staffAt(['DEV-JED-01']);
    expect((await other.c.post('/staff/samples/scan', { code })).body.error.code).toBe('BRANCH_NOT_AUTHORIZED');
    expect((await act(other.c, 'staff', code, 'package', 'collected')).body.error.code).toBe('BRANCH_NOT_AUTHORIZED');
    const key = randomUUID();
    const body = { code, action: 'package', expectedStatus: 'collected', idempotencyKey: key };
    const [a, b] = await Promise.all([staffRuh.c.post('/staff/samples/action', body), staffRuh.c.post('/staff/samples/action', body)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.replayed, b.body.replayed].sort()).toEqual([false, true]);
    expect((await events(sample.id)).filter((e) => e.to_status === 'packaged')).toHaveLength(1);
    // Typed sample ID works as a fallback identification and is recorded as such.
    expect((await act(staffRuh.c, 'staff', sample.sampleId, 'ready_for_dispatch', 'packaged')).status).toBe(200);
    expect((await events(sample.id)).at(-1).identified_by).toBe('sample_id_entry');
  });
});

describe('laboratory', () => {
  it('only lab operators (with MFA) use the lab API; the lab view has no patient data at all', async () => {
    const { code } = await collected({ patient: { firstName: 'Canarylab', lastName: 'Nobody', dateOfBirth: yearsAgo(7), gender: 'female' } });
    await toDispatched(code);
    const noMfa = await t.staff(['lab_operator']);
    expect((await noMfa.c.post('/lab/samples/scan', { code })).body.error.code).toBe('MFA_SETUP_REQUIRED');
    for (const c of [staffRuh.c, (await t.customer()).c]) {
      for (const p of ['/lab/me', '/lab/dashboard', '/lab/history']) expect((await c.get(p)).status).toBe(403);
      expect((await c.post('/lab/samples/scan', { code })).status).toBe(403);
    }
    expect((await t.client().get('/lab/dashboard')).status).toBe(401);
    const scan = await lab.c.post('/lab/samples/scan', { code });
    expect(Object.keys(scan.body.sample).sort()).toEqual(LAB_SAMPLE_KEYS);
    expect(scan.body.sample.allowedActions).toEqual(['receive', 'reject']);
    expect(JSON.stringify(scan.body)).not.toMatch(/Canarylab|Nobody|female|patientAge|patientGender|@/);
    const dash = (await lab.c.get('/lab/dashboard')).body;
    expect(dash.incoming.some((x: { sampleId: string }) => x.sampleId === scan.body.sample.sampleId)).toBe(true);
    expect(JSON.stringify(dash)).not.toMatch(/Canarylab|@/);
  });

  it('receipt needs a recorded condition and explicit confirmation; concurrent receipts record exactly one; analysis to report', async () => {
    const { sample, code, email, registration } = await collected();
    await toDispatched(code);
    expect((await act(lab.c, 'lab', code, 'receive', 'dispatched')).body.error.code).toBe('CONDITION_REQUIRED');
    const results = await Promise.all(Array.from({ length: 6 }, () => act(lab.c, 'lab', code, 'receive', 'dispatched', { condition: 'intact' })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect((await events(sample.id)).filter((e) => e.to_status === 'received_by_laboratory')).toHaveLength(1);
    await t.waitForMail(email, 'sample_received');
    expect((await act(lab.c, 'lab', code, 'start_analysis', 'received_by_laboratory')).status).toBe(200);
    expect((await act(lab.c, 'lab', code, 'complete_analysis', 'analysis_in_progress')).status).toBe(200);
    expect((await act(lab.c, 'lab', code, 'report_available', 'analysis_completed')).body.error.code).toBe('REPORT_CONFIRMATION_REQUIRED');
    expect((await act(lab.c, 'lab', code, 'report_available', 'analysis_completed', { reportDeliveryConfirmed: true })).body.status).toBe('report_available');
    expect((await act(lab.c, 'lab', code, 'reject', 'report_available', { reasonCategory: 'other', remarks: 'late' })).body.error.code).toBe('TRANSITION_NOT_ALLOWED');
    const mail = await t.waitForMail(email, 'report_available');
    expect(JSON.stringify(mail.data)).not.toMatch(/Layla|S01/);
    const timeline = (await (await t.client()).get(`/me/registrations/${registration.id}`)).status; // signed-out
    expect(timeline).toBe(401);
  });
});

describe('rejection and recollection', () => {
  it('rejection needs a reason; the rejected sample and its history are kept; recollection issues a new QR and a new -S02 after fresh verification', async () => {
    const reg = await collected();
    const { sample, code, registration, email, c: custC } = reg;
    await toDispatched(code);
    expect((await act(lab.c, 'lab', code, 'reject', 'dispatched')).body.error.code).toBe('REJECTION_REASON_REQUIRED');
    expect((await act(lab.c, 'lab', code, 'reject', 'dispatched', { reasonCategory: 'other' })).body.error.code).toBe('REMARKS_REQUIRED');
    expect((await act(staffRuh.c, 'staff', code, 'reject', 'dispatched', { reasonCategory: 'damaged_packaging' })).body.error.code).toBe('ACTION_NOT_ALLOWED');
    const rej = await act(lab.c, 'lab', code, 'reject', 'dispatched', { reasonCategory: 'damaged_packaging', condition: 'damaged', remarks: 'Internal: tube cracked in transit' });
    expect(rej.body.status).toBe('rejected');
    expect((await act(lab.c, 'lab', code, 'start_analysis', 'rejected')).body.error.code).toBe('TRANSITION_NOT_ALLOWED');

    // Customer timeline: an issue, no internal remarks, no staff identities.
    let mine = (await custC.get(`/me/registrations/${registration.id}`)).body.registration;
    expect(mine.timeline.map((s: { step: string }) => s.step)).toEqual(['registration_completed', 'sample_collected', 'sample_dispatched', 'sample_issue']);
    expect(JSON.stringify(mine.timeline)).not.toMatch(/cracked|damaged_packaging|Aramex|SMSA|@/);
    expect((await (await t.customer()).c.get(`/me/registrations/${registration.id}`)).status).toBe(404); // other customers

    // Only admins with registration.manage may authorise recollection.
    expect((await lab.c.post(`/admin/registrations/${registration.id}/recollection`, { reason: 'Lab rejected, recollect' })).status).toBe(403);
    expect((await admin.c.post(`/admin/registrations/${registration.id}/recollection`, {})).status).toBe(422);
    const auth = await admin.c.post(`/admin/registrations/${registration.id}/recollection`, { reason: 'Packaging damaged in transit; recollect' });
    expect(auth.body).toMatchObject({ status: 'recollection_authorized', trackingId: registration.trackingId, rejectedSampleId: sample.sampleId });
    expect((await admin.c.post(`/admin/registrations/${registration.id}/recollection`, { reason: 'twice please' })).body.error.code).toBe('RECOLLECTION_NOT_ALLOWED');
    await t.waitForMail(email, 'recollection_required');
    const newQr = (await t.waitForMail(email, 'registration_qr_resend'));
    expect(newQr).toBeTruthy();

    // The old (spent) QR stays spent; the new QR goes through the full collection flow again.
    expect((await staffRuh.c.post('/staff/qr/validate', { code: reg.text, branchId: branch['DEV-RUH-01'] })).body.qrValid).toBe(false);
    const png = await getBinary(t, custC, `/me/registrations/${registration.id}/qr.png`);
    const newText = decodeQrPng(png.body)!;
    expect(newText).not.toBe(reg.text);
    const v = (await staffRuh.c.post('/staff/qr/validate', { code: newText, branchId: branch['DEV-RUH-01'] })).body;
    expect(v.identityVerification.status).toBe('not_verified'); // fresh verification required
    const second = await collect(staffRuh.c, newText);
    expect(second.body.collection.sample.sampleId).toBe(`${registration.trackingId}-S02`);
    const all = await t.db.query('SELECT sample_code, status FROM samples WHERE registration_id = $1 ORDER BY sample_seq', [registration.id]);
    expect(all.rows).toEqual([{ sample_code: `${registration.trackingId}-S01`, status: 'rejected' }, { sample_code: `${registration.trackingId}-S02`, status: 'collected' }]);
    expect((await events(sample.id)).map((e) => e.to_status)).toEqual(['collected', 'packaged', 'ready_for_dispatch', 'dispatched', 'rejected']);
    mine = (await custC.get(`/me/registrations/${registration.id}`)).body.registration;
    expect(mine.timeline.map((s: { step: string }) => s.step)).toEqual(['registration_completed', 'sample_collected', 'sample_dispatched', 'sample_issue', 'recollection_required', 'sample_collected']);
  });
});

describe('admin custody management and append-only history', () => {
  it('lists and searches samples, shows the full timeline, corrects by appending; history can’t be edited', async () => {
    const { sample, code, registration } = await collected();
    await toDispatched(code);
    const list = (await admin.c.get(`/admin/samples?q=${encodeURIComponent(sample.sampleId)}`)).body;
    expect(list.items.map((x: { id: string }) => x.id)).toEqual([sample.id]);
    expect((await admin.c.get(`/admin/samples?q=${encodeURIComponent(registration.trackingId)}`)).body.items.length).toBeGreaterThanOrEqual(1);
    expect((await admin.c.get('/admin/samples?status=dispatched')).body.items.every((x: { status: string }) => x.status === 'dispatched')).toBe(true);
    const detail = (await admin.c.get(`/admin/samples/${sample.id}`)).body;
    expect(detail.sample.events.map((e: { to: string }) => e.to)).toEqual(['collected', 'packaged', 'ready_for_dispatch', 'dispatched']);
    expect(detail.sample.events[3].handover).toMatchObject({ courier: 'SMSA Express', shipmentTrackingNumber: 'TEST-123456' });
    // A wrong dispatch record is corrected by a new event, never by editing.
    const wrong = detail.sample.events[3].id;
    expect((await admin.c.post(`/admin/samples/${sample.id}/correct`, { eventId: wrong, toStatus: 'ready_for_dispatch' })).status).toBe(422);
    expect((await admin.c.post(`/admin/samples/${sample.id}/correct`, { eventId: wrong, toStatus: 'ready_for_dispatch', reason: 'Dispatch recorded before courier pickup' })).body.status).toBe('corrected');
    const after = (await admin.c.get(`/admin/samples/${sample.id}`)).body.sample;
    expect(after.status).toBe('ready_for_dispatch');
    expect(after.events.at(-1)).toMatchObject({ type: 'correction', correctsEventId: wrong, to: 'ready_for_dispatch', remarks: 'Dispatch recorded before courier pickup' });
    expect(after.events.find((e: { id: number }) => e.id === wrong)).toMatchObject({ to: 'dispatched' }); // original kept
    await expect(t.db.query('UPDATE custody_events SET to_status = $2 WHERE id = $1', [wrong, 'packaged'])).rejects.toThrow();
    await expect(t.db.query('DELETE FROM custody_events WHERE id = $1', [wrong])).rejects.toThrow();
    await expect(t.db.query('DELETE FROM samples WHERE id = $1', [sample.id])).rejects.toThrow();
  });

  it('custody admin endpoints are refused to collection staff, lab operators, auditors and customers', async () => {
    const { sample } = await collected();
    const auditor = await t.mfaStaff(['auditor']);
    for (const c of [staffRuh.c, lab.c, auditor.c, (await t.customer()).c]) {
      expect((await c.get('/admin/samples')).status).toBe(403);
      expect((await c.get(`/admin/samples/${sample.id}`)).status).toBe(403);
      expect((await c.post(`/admin/samples/${sample.id}/correct`, { eventId: 1, toStatus: 'collected', reason: 'trying it out' })).status).toBe(403);
    }
  });
});

describe('privacy regression across every Phase 6 endpoint', () => {
  it('no staff, lab or label response contains patient names, contacts, DOB or guardian data', async () => {
    const canary = `Canary${letters()}`;
    const { sample, code } = await collected({ patient: { firstName: canary, lastName: canary, dateOfBirth: yearsAgo(10), gender: 'female' }, contact: { fullName: `${canary} Guardian`, phone: '0559990011' } });
    const responses = [
      await staffRuh.c.get('/staff/samples'), await staffRuh.c.post('/staff/samples/scan', { code }), await staffRuh.c.get(`/staff/samples/${sample.id}/label`),
      await act(staffRuh.c, 'staff', code, 'package', 'collected'),
      await lab.c.get('/lab/dashboard'), await lab.c.post('/lab/samples/scan', { code }), await lab.c.get('/lab/history'), // (/lab/me returns the operator's own email by design)
      await staffRuh.c.get('/staff/history'),
    ];
    for (const r of responses) {
      const body = JSON.stringify(r.body);
      for (const leak of [canary, '559990011', '@example.com', 'dateOfBirth', 'guardian']) expect(body).not.toContain(leak);
    }
  });
});
