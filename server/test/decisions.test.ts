import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decrypt } from '../src/lib/crypto.ts';
import { customerWithRegistration, register, yearsAgo } from './helpers/registration.ts';
import { GOOD_PASSWORD, setupTestApp, type TestEnv } from './helpers/test-app.ts';

// Approved Phase 2 business decisions, applied in Phase 3.

let t: TestEnv;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(async () => {
  await t.close();
});

describe('account holders must be adults', () => {
  it('sign-up requires the 18+ confirmation and records when it was given', async () => {
    const email = `adult.${randomUUID().slice(0, 8)}@example.com`;
    const missing = await t.client().post('/auth/sign-up', { email, password: GOOD_PASSWORD });
    expect(missing.body.error.code).toBe('VALIDATION_FAILED');
    const unticked = await t.client().post('/auth/sign-up', { email, password: GOOD_PASSWORD, confirmAdult: false });
    expect(unticked.body.error.code).toBe('VALIDATION_FAILED');
    expect((await t.client().post('/auth/sign-up', { email, password: GOOD_PASSWORD, confirmAdult: true })).status).toBe(202);
    const row = await t.db.query('SELECT adult_confirmed_at IS NOT NULL AS ok FROM users WHERE email = $1', [email]);
    expect(row.rows[0]!.ok).toBe(true);
  });
});

describe('patient eligibility', () => {
  it('no arbitrary minimum patient age: a newborn child can be registered', async () => {
    const cu = await t.customer();
    const res = await register(cu.c, { patient: { firstName: 'Baby', lastName: 'Saleh', dateOfBirth: yearsAgo(0, 10), gender: 'male' } });
    expect(res.status).toBe(201);
    expect(res.body.registration.patient.age).toEqual({ years: 0, months: 0 });
  });

  it('gender options are Male and Female', async () => {
    const cu = await t.customer();
    const res = await register(cu.c, { patient: { firstName: 'A', lastName: 'B', dateOfBirth: yearsAgo(5), gender: 'other' } });
    expect(res.status).toBe(422);
  });
});

describe('patient corrections', () => {
  it('before collection: allowed, previous values preserved (encrypted, append-only), audit records field names only', async () => {
    const { c, registration, userId } = await customerWithRegistration(t);
    const res = await c.request('PATCH', `/me/registrations/${registration.id}/patient`, {
      patient: { firstName: 'Leila', lastName: 'Al-Harbi', dateOfBirth: registration.patient.dateOfBirth, gender: 'female' },
      reason: 'Spelling of first name',
    });
    expect(res.status).toBe(200);
    expect(res.body.changed).toEqual(['first_name']);
    expect(res.body.registration.patient.firstName).toBe('Leila');

    const rev = await t.db.query<{ patient_id: string; changed_fields: string[]; previous_enc: string; changed_by: string; reason: string }>(
      'SELECT patient_id, changed_fields, previous_enc, changed_by, reason FROM patient_revisions ORDER BY id DESC LIMIT 1');
    const r = rev.rows[0]!;
    expect(r.changed_fields).toEqual(['first_name']);
    expect(r.changed_by).toBe(userId);
    expect(r.reason).toBe('Spelling of first name');
    expect(r.previous_enc).not.toContain('Layla');
    expect(JSON.parse(decrypt(t.config.dataEncryptionKey, r.previous_enc, `patient_revisions:${r.patient_id}`))).toEqual({ firstName: 'Layla' });
    await expect(t.db.query('UPDATE patient_revisions SET reason = $1', ['x'])).rejects.toThrow(/append-only/);
    await expect(t.db.query('DELETE FROM patient_revisions')).rejects.toThrow(/append-only/);

    const audit = await t.db.query(`SELECT fields_accessed, metadata::text AS m FROM audit_logs WHERE action = 'patient.corrected' AND target_id = $1`, [r.patient_id]);
    expect(audit.rows[0]!.fields_accessed).toEqual(['first_name']);
    expect(audit.rows[0]!.m).not.toMatch(/Layla|Leila/);
  });

  it('after sample collection: refused (never silently modified), including via a new "myself" registration', async () => {
    const { c, registration } = await customerWithRegistration(t);
    await t.db.query(`UPDATE registrations SET status = 'sample_collected' WHERE id = $1`, [registration.id]);
    const res = await c.request('PATCH', `/me/registrations/${registration.id}/patient`, {
      patient: { firstName: 'Changed', lastName: 'Name', dateOfBirth: registration.patient.dateOfBirth, gender: 'female' },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PATIENT_LOCKED');
    expect((await c.get(`/me/registrations/${registration.id}`)).body.registration.canCorrectPatient).toBe(false);
    expect((await t.db.query('SELECT first_name FROM patients WHERE id = (SELECT patient_id FROM registrations WHERE id = $1)', [registration.id])).rows[0]!.first_name).toBe('Layla');

    const me = await t.customer();
    const first = await register(me.c, { relationship: 'self', patient: { firstName: 'Omar', lastName: 'Saleh', dateOfBirth: yearsAgo(30), gender: 'male' } });
    await t.db.query(`UPDATE registrations SET status = 'sample_collected' WHERE id = $1`, [first.body.registration.id]);
    const second = await register(me.c, { relationship: 'self', patient: { firstName: 'Omer', lastName: 'Saleh', dateOfBirth: yearsAgo(30), gender: 'male' } });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('PATIENT_LOCKED');
  });

  it('corrections are validated (a child cannot become 18+) and only the owner can correct', async () => {
    const { c, registration } = await customerWithRegistration(t);
    const adult = await c.request('PATCH', `/me/registrations/${registration.id}/patient`, {
      patient: { firstName: 'Layla', lastName: 'Al-Harbi', dateOfBirth: yearsAgo(20), gender: 'female' },
    });
    expect(adult.body.error).toMatchObject({ code: 'INVALID_DATE_OF_BIRTH', details: { reason: 'CHILD_MUST_BE_UNDER_18' } });
    const other = await t.customer();
    const res = await other.c.request('PATCH', `/me/registrations/${registration.id}/patient`, {
      patient: { firstName: 'X', lastName: 'Y', dateOfBirth: yearsAgo(5), gender: 'female' },
    });
    expect(res.status).toBe(404);
  });
});
