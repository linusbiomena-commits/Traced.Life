import { createHash } from 'node:crypto';
import type { Deps } from '../../context.ts';
import { withTx, type Queryable } from '../../db/pool.ts';
import { encrypt } from '../../lib/crypto.ts';
import { AppError } from '../../lib/errors.ts';
import type { AuditMeta } from '../accounts/accounts.service.ts';
import { audit } from '../audit/audit.service.ts';
import { currentConsentDocuments } from '../consents/consents.service.ts';
import { enqueueEmail } from '../mail/outbox.ts';
import { issueCustomerQr } from '../qr/qr.service.ts';
import { allocateTrackingId } from '../tracking/tracking.ts';
import { ageParts, dateOfBirthProblem, requiredConsentTypes, riyadhToday, type Gender, type Relationship } from './rules.ts';

export type NewRegistration = {
  relationship: Relationship;
  patient: { firstName: string; lastName: string; dateOfBirth: string; gender: Gender };
  contact: { fullName: string; phone: string };
  branchId: string;
  consentDocumentIds: string[];
  saveToProfile: boolean;
};

export type PatientDetails = NewRegistration['patient'];

/** Statuses in which patient details may still be corrected (nothing has been collected yet). */
export const PRE_COLLECTION_STATUSES = ['registration_completed', 'awaiting_sample_collection', 'cancelled'] as const;

const invalid = (code: string, message: string, details?: Record<string, unknown>) => new AppError(422, code, message, details);

function fingerprint(input: NewRegistration): Buffer {
  const canonical = JSON.stringify({ ...input, consentDocumentIds: [...input.consentDocumentIds].sort() });
  return createHash('sha256').update(canonical).digest();
}

/**
 * Creates a registration for the signed-in customer in ONE transaction: patient, registration
 * with its tracking ID (TRC-SA-MM/YY-XXXXX), status history, consent records, the customer QR
 * token, the confirmation email (outbox) and audit entries. If anything fails, nothing is kept
 * and no tracking number is consumed. The same Idempotency-Key always returns the same
 * registration, so retries can never allocate a second tracking ID.
 */
export async function createRegistration(
  deps: Deps,
  owner: { userId: string; email: string; locale: 'en' | 'ar' },
  idempotencyKey: string,
  input: NewRegistration,
  meta: AuditMeta,
): Promise<{ id: string; replayed: boolean }> {
  const today = riyadhToday();
  const dobProblem = dateOfBirthProblem(input.patient.dateOfBirth, input.relationship, today);
  if (dobProblem) throw invalid('INVALID_DATE_OF_BIRTH', 'Check the date of birth.', { reason: dobProblem });
  const age = ageParts(input.patient.dateOfBirth, today)!;
  const print = fingerprint(input);

  return withTx(deps.db, async (tx) => {
    // Serialise requests carrying the same key, then answer repeats with the original result.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`registration:${owner.userId}:${idempotencyKey}`]);
    const prior = await tx.query<{ id: string; request_fingerprint: Buffer }>(
      'SELECT id, request_fingerprint FROM registrations WHERE account_user_id = $1 AND idempotency_key = $2',
      [owner.userId, idempotencyKey],
    );
    if (prior.rows[0]) {
      if (!prior.rows[0].request_fingerprint.equals(print)) {
        throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'This submission key was already used for different details. Reload the form and try again.');
      }
      return { id: prior.rows[0].id, replayed: true };
    }

    const branch = await tx.query<{ id: string; code: string }>('SELECT id, code FROM collection_branches WHERE id = $1 AND active', [input.branchId]);
    if (!branch.rows[0]) throw invalid('INVALID_BRANCH', 'Choose an available collection branch.');

    await checkConsents(tx, deps, input);

    // Lock order matters: take this month's counter row BEFORE any audit write (audit inserts
    // take the audit-chain lock), so concurrent registrations always lock in the same order and
    // cannot deadlock. If anything below fails, the increment rolls back with the transaction.
    const tracking = await allocateTrackingId(tx);
    const patientId = await resolvePatient(tx, deps, owner.userId, input, meta);

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO registrations (account_user_id, patient_id, branch_id, contact_full_name, contact_email, contact_phone,
                                  patient_age_months_at_registration, idempotency_key, request_fingerprint,
                                  tracking_id, tracking_period, tracking_seq, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'awaiting_sample_collection') RETURNING id`,
      [owner.userId, patientId, input.branchId, input.contact.fullName, owner.email, input.contact.phone, age.totalMonths,
        idempotencyKey, print, tracking.trackingId, tracking.period, tracking.seq],
    );
    const id = rows[0]!.id;

    await tx.query(
      `INSERT INTO registration_status_history (registration_id, from_status, to_status, changed_by, actor_role, reason) VALUES
         ($1, NULL, 'registration_completed', $2, 'customer', NULL),
         ($1, 'registration_completed', 'awaiting_sample_collection', NULL, 'system', 'tracking ID and QR code issued')`,
      [id, owner.userId],
    );
    for (const docId of input.consentDocumentIds) {
      await tx.query(
        `INSERT INTO consent_records (registration_id, user_id, patient_id, consent_document_id, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, owner.userId, patientId, docId, meta.ip, meta.userAgent?.slice(0, 512) ?? null],
      );
    }
    if (input.saveToProfile) {
      await tx.query('UPDATE users SET full_name = $2, phone = $3 WHERE id = $1', [owner.userId, input.contact.fullName, input.contact.phone]);
    }

    await issueCustomerQr(tx, deps, id, owner.userId);
    await enqueueEmail(tx, deps, {
      kind: 'registration_confirmation', locale: owner.locale, to: owner.email, userId: owner.userId,
      registrationId: id, dedupeKey: `registration_confirmation:${id}`,
    });

    await audit(tx, {
      ...meta,
      action: 'registration.created',
      outcome: 'success',
      targetType: 'registration',
      targetId: id,
      metadata: { relationship: input.relationship, branch: branch.rows[0].code, consents: input.consentDocumentIds.length, trackingId: tracking.trackingId },
    });
    await audit(tx, { ...meta, action: 'qr.issued', outcome: 'success', targetType: 'registration', targetId: id, metadata: { tokenType: 'customer' } });
    return { id, replayed: false };
  });
}

/** Every required consent must be accepted, each must be a current document, and nothing extra. */
async function checkConsents(tx: Queryable, deps: Deps, input: NewRegistration): Promise<void> {
  const ids = input.consentDocumentIds;
  if (new Set(ids).size !== ids.length) throw invalid('INVALID_CONSENTS', 'Duplicate consent.');
  const current = await currentConsentDocuments(tx, deps.config);
  const byId = new Map(current.map((d) => [d.id, d]));
  const acceptedTypes = new Set<string>();
  for (const id of ids) {
    const doc = byId.get(id);
    if (!doc) throw new AppError(409, 'CONSENT_OUTDATED', 'The consent text has changed. Please review and accept the current version.');
    if (acceptedTypes.has(doc.type)) throw invalid('INVALID_CONSENTS', 'Duplicate consent type.');
    acceptedTypes.add(doc.type);
  }
  const required = requiredConsentTypes(input.relationship);
  const missing = required.filter((t) => !acceptedTypes.has(t));
  const extra = [...acceptedTypes].filter((t) => !(required as string[]).includes(t));
  if (missing.length || extra.length) throw invalid('CONSENT_REQUIRED', 'Please accept all required statements.', { missing, extra });
}

type PatientRow = { id: string; relationship: Relationship; first_name: string; last_name: string; date_of_birth: string; gender: Gender };
const FIELD_MAP = { first_name: 'firstName', last_name: 'lastName', date_of_birth: 'dateOfBirth', gender: 'gender' } as const;

/** Reuses an identical existing patient; the single "myself" patient is corrected (protected). */
async function resolvePatient(tx: Queryable, deps: Deps, userId: string, input: NewRegistration, meta: AuditMeta): Promise<string> {
  const p = input.patient;
  if (input.relationship === 'self') {
    const self = await tx.query<PatientRow>(
      `SELECT id, relationship, first_name, last_name, to_char(date_of_birth, 'YYYY-MM-DD') AS date_of_birth, gender
         FROM patients WHERE account_user_id = $1 AND relationship = 'self' FOR UPDATE`,
      [userId],
    );
    if (self.rows[0]) {
      await applyPatientCorrection(tx, deps, self.rows[0], p, { meta, registrationId: null, reason: 'updated during a new registration' });
      return self.rows[0].id;
    }
  } else {
    const same = await tx.query<{ id: string }>(
      `SELECT id FROM patients
        WHERE account_user_id = $1 AND relationship = $2 AND lower(first_name) = lower($3) AND lower(last_name) = lower($4)
          AND date_of_birth = $5 AND gender = $6
        LIMIT 1`,
      [userId, input.relationship, p.firstName, p.lastName, p.dateOfBirth, p.gender],
    );
    if (same.rows[0]) return same.rows[0].id;
  }
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO patients (account_user_id, relationship, first_name, last_name, date_of_birth, gender)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [userId, input.relationship, p.firstName, p.lastName, p.dateOfBirth, p.gender],
  );
  await audit(tx, { ...meta, action: 'patient.created', outcome: 'success', targetType: 'patient', targetId: rows[0]!.id, metadata: { relationship: input.relationship } });
  return rows[0]!.id;
}

/**
 * The only way patient details change. Allowed only while none of the patient's registrations has
 * progressed past "awaiting sample collection". The previous values are kept (encrypted) in the
 * append-only patient_revisions table; the audit log records which fields changed, never values.
 */
export async function applyPatientCorrection(
  tx: Queryable, deps: Deps, current: PatientRow, next: PatientDetails,
  ctx: { meta: AuditMeta; registrationId: string | null; reason: string | null },
): Promise<string[]> {
  const changed = (Object.keys(FIELD_MAP) as (keyof typeof FIELD_MAP)[]).filter((col) => current[col] !== next[FIELD_MAP[col]]);
  if (!changed.length) return [];

  const locked = await tx.query(
    `SELECT 1 FROM registrations WHERE patient_id = $1 AND status <> ALL($2::text[]) LIMIT 1`,
    [current.id, PRE_COLLECTION_STATUSES],
  );
  if (locked.rowCount) {
    throw new AppError(409, 'PATIENT_LOCKED', 'Patient details can’t be changed after a sample has been collected. Please contact support.');
  }
  const problem = dateOfBirthProblem(next.dateOfBirth, current.relationship, riyadhToday());
  if (problem) throw invalid('INVALID_DATE_OF_BIRTH', 'Check the date of birth.', { reason: problem });

  const previous = Object.fromEntries(changed.map((c) => [FIELD_MAP[c], current[c]]));
  await tx.query(
    `INSERT INTO patient_revisions (patient_id, registration_id, changed_fields, previous_enc, changed_by, actor_role, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [current.id, ctx.registrationId, changed, encrypt(deps.config.dataEncryptionKey, JSON.stringify(previous), `patient_revisions:${current.id}`),
      ctx.meta.actorUserId, ctx.meta.actorRole, ctx.reason?.slice(0, 500) ?? null],
  );
  await tx.query('UPDATE patients SET first_name = $2, last_name = $3, date_of_birth = $4, gender = $5 WHERE id = $1',
    [current.id, next.firstName, next.lastName, next.dateOfBirth, next.gender]);
  await audit(tx, { ...ctx.meta, action: 'patient.corrected', outcome: 'success', targetType: 'patient', targetId: current.id, fieldsAccessed: changed, metadata: ctx.registrationId ? { registrationId: ctx.registrationId } : {} });
  return changed;
}

/** Customer correction of the patient on one of their own registrations. */
export async function correctPatientForRegistration(
  deps: Deps, userId: string, registrationId: string, next: PatientDetails, reason: string | null, meta: AuditMeta,
): Promise<string[] | null> {
  return withTx(deps.db, async (tx) => {
    const { rows } = await tx.query<PatientRow>(
      `SELECT p.id, p.relationship, p.first_name, p.last_name, to_char(p.date_of_birth, 'YYYY-MM-DD') AS date_of_birth, p.gender
         FROM registrations r JOIN patients p ON p.id = r.patient_id
        WHERE r.id = $1 AND r.account_user_id = $2
        FOR UPDATE OF p`,
      [registrationId, userId],
    );
    if (!rows[0]) return null;
    return applyPatientCorrection(tx, deps, rows[0], next, { meta, registrationId, reason });
  });
}
