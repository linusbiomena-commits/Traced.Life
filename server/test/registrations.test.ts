import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ageParts, dateOfBirthProblem, normaliseSaudiMobile, riyadhToday } from '../src/modules/registrations/rules.ts';
import { GOOD_PASSWORD, setupTestApp, type TestClient, type TestEnv } from './helpers/test-app.ts';

// The browser's copy of the rules (plain ES module served from dist/).
const BROWSER_RULES = '../../dist/portal/js/core/rules.js';
let browserRules: any;

let t: TestEnv;
beforeAll(async () => {
  t = await setupTestApp();
  browserRules = await import(BROWSER_RULES);
});
afterAll(async () => {
  await t.close();
});

function yearsAgo(years: number, extraDays = 0): string {
  const [y, m, d] = riyadhToday().split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y - years, m - 1, d - extraDays));
  return date.toISOString().slice(0, 10);
}

async function form(c: TestClient, locale = 'en') {
  const res = await c.get(`/me/registration-form?locale=${locale}`);
  expect(res.status).toBe(200);
  return res.body as {
    branches: { id: string; code: string }[];
    consents: { id: string; type: string; provisional: boolean; title: string }[];
    profile: { email: string; fullName: string | null; phone: string | null };
  };
}

async function validBody(c: TestClient, overrides: Record<string, unknown> = {}) {
  const f = await form(c);
  const relationship = (overrides.relationship as string) ?? 'child';
  const types = relationship === 'self' ? ['privacy_policy', 'sample_collection_consent', 'accuracy_declaration'] : ['privacy_policy', 'sample_collection_consent', 'accuracy_declaration', 'guardian_authorization'];
  return {
    relationship,
    patient: { firstName: 'Layla', lastName: 'Al-Harbi', dateOfBirth: yearsAgo(7, 40), gender: 'female' },
    contact: { fullName: 'Fatimah Al-Harbi', phone: '055 123 4567' },
    branchId: f.branches[0]!.id,
    consentDocumentIds: f.consents.filter((d) => types.includes(d.type)).map((d) => d.id),
    ...overrides,
  };
}

const submit = (c: TestClient, body: unknown, key: string = randomUUID()) => c.post('/me/registrations', body, { headers: { 'idempotency-key': key } });

describe('rules: age, dates, phone numbers', () => {
  it('calculates completed years and months', () => {
    expect(ageParts('2019-08-15', '2026-11-26')).toEqual({ years: 7, months: 3, totalMonths: 87 });
    expect(ageParts('2026-05-27', '2026-11-26')).toEqual({ years: 0, months: 5, totalMonths: 5 });
    expect(ageParts('2026-11-26', '2026-11-26')).toEqual({ years: 0, months: 0, totalMonths: 0 });
    expect(ageParts('2008-02-29', '2026-02-28')).toEqual({ years: 17, months: 11, totalMonths: 215 });
    expect(ageParts('2026-11-27', '2026-11-26')).toBeNull();
  });

  it('validates dates of birth against the relationship', () => {
    const today = '2026-11-26';
    expect(dateOfBirthProblem('2026-11-27', 'child', today)).toBe('FUTURE_DATE');
    expect(dateOfBirthProblem('2026-02-30', 'child', today)).toBe('INVALID_DATE');
    expect(dateOfBirthProblem('1899-12-31', 'authorized_dependent', today)).toBe('INVALID_DATE');
    expect(dateOfBirthProblem('2008-11-26', 'child', today)).toBe('CHILD_MUST_BE_UNDER_18');
    expect(dateOfBirthProblem('2008-11-27', 'child', today)).toBeNull();
    expect(dateOfBirthProblem('2010-01-01', 'self', today)).toBe('SELF_MUST_BE_ADULT');
    expect(dateOfBirthProblem('2010-01-01', 'authorized_dependent', today)).toBeNull();
  });

  it('normalises Saudi mobile numbers, including Arabic-Indic digits', () => {
    for (const input of ['0551234567', '551234567', '+966551234567', '00966551234567', '966 55 123 4567', '(055) 123-4567', '٠٥٥١٢٣٤٥٦٧']) {
      expect(normaliseSaudiMobile(input)).toBe('+966551234567');
    }
    for (const input of ['0112345678', '05512345', '+971551234567', '0551234567890', 'abc']) expect(normaliseSaudiMobile(input)).toBeNull();
  });

  it('the browser copy of the rules agrees with the server', () => {
    const cases: [string, string][] = [['2019-08-15', '2026-11-26'], ['2026-05-27', '2026-11-26'], ['2008-02-29', '2026-02-28'], ['2026-11-27', '2026-11-26']];
    for (const [dob, today] of cases) expect(browserRules.ageParts(dob, today)).toEqual(ageParts(dob, today));
    for (const p of ['0551234567', '٠٥٥١٢٣٤٥٦٧', '0112345678', '+966551234567']) expect(browserRules.normaliseSaudiMobile(p)).toBe(normaliseSaudiMobile(p));
    for (const [dob, rel] of [['2026-11-27', 'child'], ['2008-11-26', 'child'], ['2010-01-01', 'self'], ['2010-01-01', 'authorized_dependent']] as const) {
      expect(browserRules.dateOfBirthProblem(dob, rel, '2026-11-26')).toBe(dateOfBirthProblem(dob, rel, '2026-11-26'));
    }
  });
});

describe('registration form data', () => {
  it('requires a verified email', async () => {
    const c = t.client();
    await c.post('/auth/sign-up', { confirmAdult: true, email: 'unverified.reg@example.com', password: GOOD_PASSWORD });
    await c.post('/auth/sign-in', { email: 'unverified.reg@example.com', password: GOOD_PASSWORD });
    expect((await c.get('/me/registration-form')).body.error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('returns branches from the database, provisional consents per locale and the verified email', async () => {
    const { c, email } = await t.customer();
    const en = await form(c, 'en');
    expect(en.branches.map((b) => b.code)).toEqual(['DEV-RUH-01', 'DEV-JED-01', 'DEV-DMM-01']);
    expect(en.consents.map((d) => d.type).sort()).toEqual(['accuracy_declaration', 'guardian_authorization', 'privacy_policy', 'sample_collection_consent']);
    expect(en.consents.every((d) => d.provisional)).toBe(true);
    expect(en.profile.email).toBe(email);
    const ar = await form(c, 'ar');
    expect(ar.consents[0]!.title).toMatch(/[؀-ۿ]/);

    await t.db.query(`UPDATE collection_branches SET active = false WHERE code = 'DEV-DMM-01'`);
    expect((await form(c)).branches).toHaveLength(2);
    await t.db.query(`UPDATE collection_branches SET active = true WHERE code = 'DEV-DMM-01'`);
  });
});

describe('creating registrations', () => {
  it('registers a child: separate patient, guardian consent, tracking ID + QR issued, status history, audit', async () => {
    const { c, userId, email } = await t.customer();
    const body = await validBody(c);
    const res = await submit(c, body);
    expect(res.status).toBe(201);
    const reg = res.body.registration;
    expect(reg).toMatchObject({
      status: 'awaiting_sample_collection',
      trackingId: expect.stringMatching(/^TRC-SA-(0[1-9]|1[0-2])\/\d{2}-\d{5}$/),
      product: 'traced',
      sampleType: 'hair',
      collectionCountry: 'SA',
      patient: { firstName: 'Layla', lastName: 'Al-Harbi', relationship: 'child', gender: 'female', age: { years: 7, months: 1 } },
      contact: { fullName: 'Fatimah Al-Harbi', email, phone: '+966551234567' },
      qrCode: { available: true },
    });
    expect(reg.consents.map((x: { type: string }) => x.type).sort()).toEqual(['accuracy_declaration', 'guardian_authorization', 'privacy_policy', 'sample_collection_consent']);
    expect(reg.statusHistory.map((h: { status: string }) => h.status)).toEqual(['registration_completed', 'awaiting_sample_collection']);

    const db = await t.db.query(`SELECT r.account_user_id, p.account_user_id AS patient_owner, p.relationship,
        (SELECT count(*)::int FROM consent_records WHERE registration_id = r.id) AS consents
      FROM registrations r JOIN patients p ON p.id = r.patient_id WHERE r.id = $1`, [reg.id]);
    expect(db.rows[0]).toEqual({ account_user_id: userId, patient_owner: userId, relationship: 'child', consents: 4 });

    const auditRow = await t.db.query(`SELECT metadata::text AS m FROM audit_logs WHERE action = 'registration.created' AND target_id = $1`, [reg.id]);
    expect(auditRow.rows).toHaveLength(1);
    expect(auditRow.rows[0]!.m).not.toMatch(/Layla|Harbi|551234567/); // no personal data in the audit trail

    const profile = await c.get('/me/profile');
    expect(profile.body.profile).toMatchObject({ fullName: 'Fatimah Al-Harbi', phone: '+966551234567' });
  });

  it('registers myself without guardian consent, and refuses a minor as "myself"', async () => {
    const { c } = await t.customer();
    const ok = await submit(c, await validBody(c, { relationship: 'self', patient: { firstName: 'Omar', lastName: 'Saleh', dateOfBirth: yearsAgo(30), gender: 'male' } }));
    expect(ok.status).toBe(201);
    expect(ok.body.registration.patient.age.years).toBe(30);
    const minor = await submit(c, await validBody(c, { relationship: 'self', patient: { firstName: 'Omar', lastName: 'Saleh', dateOfBirth: yearsAgo(16), gender: 'male' } }));
    expect(minor.body.error).toMatchObject({ code: 'INVALID_DATE_OF_BIRTH', details: { reason: 'SELF_MUST_BE_ADULT' } });
  });

  it('supports authorised dependents of any age, with guardian authorisation', async () => {
    const { c } = await t.customer();
    const res = await submit(c, await validBody(c, { relationship: 'authorized_dependent', patient: { firstName: 'Saad', lastName: 'Qahtani', dateOfBirth: yearsAgo(80), gender: 'male' } }));
    expect(res.status).toBe(201);
    expect(res.body.registration.patient.relationship).toBe('authorized_dependent');
  });

  it('validates every field', async () => {
    const { c } = await t.customer();
    const base = await validBody(c);
    const cases: [Record<string, unknown>, string][] = [
      [{ patient: { ...base.patient, dateOfBirth: '2999-01-01' } }, 'INVALID_DATE_OF_BIRTH'],
      [{ patient: { ...base.patient, dateOfBirth: yearsAgo(19) } }, 'INVALID_DATE_OF_BIRTH'],
      [{ patient: { ...base.patient, firstName: '<script>' } }, 'VALIDATION_FAILED'],
      [{ patient: { ...base.patient, firstName: '' } }, 'VALIDATION_FAILED'],
      [{ patient: { ...base.patient, gender: 'other' } }, 'VALIDATION_FAILED'],
      [{ patient: { ...base.patient, nationalId: '1234567890' } }, 'VALIDATION_FAILED'],
      [{ contact: { ...base.contact, phone: '0112345678' } }, 'VALIDATION_FAILED'],
      [{ contact: { ...base.contact, email: 'other@example.com' } }, 'VALIDATION_FAILED'],
      [{ relationship: 'friend' }, 'VALIDATION_FAILED'],
      [{ branchId: randomUUID() }, 'INVALID_BRANCH'],
      [{ consentDocumentIds: base.consentDocumentIds.slice(0, 3) }, 'CONSENT_REQUIRED'],
      [{ consentDocumentIds: [randomUUID(), ...base.consentDocumentIds.slice(1)] }, 'CONSENT_OUTDATED'],
      [{ trackingId: 'TRC-SA-11/26-00001' }, 'VALIDATION_FAILED'],
      [{ status: 'report_available' }, 'VALIDATION_FAILED'],
    ];
    for (const [override, code] of cases) {
      const res = await submit(c, { ...base, ...override });
      expect(res.body.error?.code, JSON.stringify(override)).toBe(code);
    }
    const arabicName = await submit(c, { ...base, patient: { ...base.patient, firstName: 'ليلى', lastName: 'الحربي' } });
    expect(arabicName.status).toBe(201);
    expect((await c.post('/me/registrations', base)).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await t.db.query('SELECT count(*)::int AS n FROM registrations')).rows[0]!.n).toBeGreaterThan(0);
  });

  it('accepts only the current consent version', async () => {
    const { c } = await t.customer();
    const body = await validBody(c);
    const privacy = (await form(c)).consents.find((d) => d.type === 'privacy_policy')!;
    await t.db.query(
      `INSERT INTO consent_documents (doc_type, version, locale, title, body, content_sha256, status)
       VALUES ('privacy_policy', '0.2-provisional', 'en', 'Privacy notice v0.2', 'Updated text', '\\x00', 'provisional')`,
    );
    const res = await submit(c, body);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONSENT_OUTDATED');
    const fresh = (await form(c)).consents.find((d) => d.type === 'privacy_policy')!;
    expect(fresh.id).not.toBe(privacy.id);
    expect(fresh.title).toBe('Privacy notice v0.2');
    await t.db.query(`UPDATE consent_documents SET status = 'retired' WHERE version = '0.2-provisional'`);
  });

  it('consent texts and consent records cannot be altered', async () => {
    await expect(t.db.query(`UPDATE consent_documents SET body = 'changed'`)).rejects.toThrow(/immutable/);
    await expect(t.db.query('DELETE FROM consent_documents')).rejects.toThrow(/append-only/);
    await expect(t.db.query('UPDATE consent_records SET accepted_at = now()')).rejects.toThrow(/append-only/);
    await expect(t.db.query(`UPDATE registration_status_history SET to_status = 'report_available'`)).rejects.toThrow(/append-only/);
  });

  it('refuses tracking IDs that are not in the final TRC-SA-MM/YY-XXXXX format (database check)', async () => {
    const { c } = await t.customer();
    const id = (await submit(c, await validBody(c))).body.registration.id;
    await expect(t.db.query(`UPDATE registrations SET tracking_id = 'TMP-123', tracking_period = '2611', tracking_seq = 1 WHERE id = $1`, [id])).rejects.toThrow(/check constraint/);
    await expect(t.db.query(`UPDATE registrations SET tracking_id = 'TRC-SA-13/26-00001', tracking_period = '2611', tracking_seq = 1 WHERE id = $1`, [id])).rejects.toThrow(/check constraint/);
    await expect(t.db.query(`UPDATE registrations SET tracking_id = 'TRC-SA-01/25-00001' WHERE id = $1`, [id])).rejects.toThrow(/check constraint/); // must match period/seq
    const client = await t.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE registrations SET tracking_id = 'TRC-SA-01/25-00001', tracking_period = '2501', tracking_seq = 1 WHERE id = $1`, [id]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe('duplicate submissions', () => {
  it('a retried request with the same key returns the same registration', async () => {
    const { c } = await t.customer();
    const body = await validBody(c);
    const key = randomUUID();
    const first = await submit(c, body, key);
    const retry = await submit(c, body, key);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBe(true);
    expect(retry.body.registration.id).toBe(first.body.registration.id);
  });

  it('ten simultaneous double-clicks create exactly one registration', async () => {
    const { c, userId } = await t.customer();
    const body = await validBody(c);
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 10 }, () => submit(c, body, key)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(9);
    expect(new Set(results.map((r) => r.body.registration.id)).size).toBe(1);
    const n = await t.db.query('SELECT count(*)::int AS n FROM registrations WHERE account_user_id = $1', [userId]);
    expect(n.rows[0]!.n).toBe(1);
  });

  it('reusing a key for different details is refused', async () => {
    const { c } = await t.customer();
    const body = await validBody(c);
    const key = randomUUID();
    await submit(c, body, key);
    const res = await submit(c, { ...body, patient: { ...body.patient, firstName: 'Noura' } }, key);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('registering the same child again reuses the patient record but creates a new registration', async () => {
    const { c, userId } = await t.customer();
    const body = await validBody(c);
    await submit(c, body);
    await submit(c, { ...body, patient: { ...body.patient, firstName: 'layla' } });
    const r = await t.db.query('SELECT count(*)::int AS regs, count(DISTINCT patient_id)::int AS patients FROM registrations WHERE account_user_id = $1', [userId]);
    expect(r.rows[0]).toEqual({ regs: 2, patients: 1 });
  });
});

describe('ownership and privacy', () => {
  it('customers see only their own registrations; other ids look like missing ones', async () => {
    const a = await t.customer();
    const b = await t.customer();
    const aReg = (await submit(a.c, await validBody(a.c))).body.registration;
    await submit(b.c, await validBody(b.c, { patient: { firstName: 'Huda', lastName: 'Otaibi', dateOfBirth: yearsAgo(5), gender: 'female' } }));

    const bList = await b.c.get('/me/registrations');
    expect(bList.body.items).toHaveLength(1);
    expect(JSON.stringify(bList.body)).not.toContain('Layla');

    const peek = await b.c.get(`/me/registrations/${aReg.id}`);
    const missing = await b.c.get(`/me/registrations/${randomUUID()}`);
    expect(peek.status).toBe(404);
    expect(peek.body.error.code).toBe(missing.body.error.code);
    expect((await b.c.get('/me/registrations/not-a-uuid')).status).toBe(404);
    expect((await a.c.get(`/me/registrations/${aReg.id}`)).status).toBe(200);
  });

  it('the list shows name, age, gender, date, status and branch, without contact details', async () => {
    const { c } = await t.customer();
    await submit(c, await validBody(c));
    const item = (await c.get('/me/registrations')).body.items[0];
    expect(Object.keys(item).sort()).toEqual(['branch', 'createdAt', 'id', 'patient', 'qrCode', 'status', 'trackingId']);
    expect(Object.keys(item.patient).sort()).toEqual(['age', 'firstName', 'gender', 'lastName', 'relationship']);
  });

  it('collection staff and admins without customer permissions cannot use customer endpoints', async () => {
    const staff = await t.staff(['collection_staff']);
    for (const path of ['/me/registrations', '/me/registration-form', `/me/registrations/${randomUUID()}`]) {
      expect((await staff.c.get(path)).status).toBe(403);
    }
    expect((await submit(staff.c, {})).status).toBe(403);
    const admin = await t.mfaStaff(['admin']);
    expect((await admin.c.get('/me/registrations')).status).toBe(403); // admin access to registrations comes with the Phase 5 admin API
  });

  it('signed-out requests are refused', async () => {
    expect((await t.client().get('/me/registrations')).status).toBe(401);
    expect((await t.client().get('/me/profile')).status).toBe(401);
  });
});

describe('profile', () => {
  it('updates name, phone and language with validation and an audit entry', async () => {
    const { c, userId } = await t.customer();
    expect((await c.request('PATCH', '/me/profile', { fullName: 'Reem Al-Qahtani', phone: '٠٥٠٠٠٠٠٠٠٠', locale: 'ar' })).status).toBe(200);
    expect((await c.get('/me/profile')).body.profile).toMatchObject({ fullName: 'Reem Al-Qahtani', phone: '+966500000000', locale: 'ar' });
    expect((await c.request('PATCH', '/me/profile', { phone: '12345' })).status).toBe(422);
    expect((await c.request('PATCH', '/me/profile', { email: 'x@example.com' })).status).toBe(422);
    expect((await c.request('PATCH', '/me/profile', {})).status).toBe(422);
    const a = await t.db.query(`SELECT fields_accessed FROM audit_logs WHERE action = 'account.profile_updated' AND target_id = $1`, [userId]);
    expect(a.rows[0]!.fields_accessed).toEqual(['full_name', 'phone', 'locale']);
  });
});
