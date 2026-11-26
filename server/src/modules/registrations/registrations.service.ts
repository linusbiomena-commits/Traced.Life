import { createHash } from 'node:crypto';
import type { Deps } from '../../context.ts';
import { withTx, type Queryable } from '../../db/pool.ts';
import { AppError } from '../../lib/errors.ts';
import type { AuditMeta } from '../accounts/accounts.service.ts';
import { audit } from '../audit/audit.service.ts';
import { currentConsentDocuments } from '../consents/consents.service.ts';
import { ageParts, dateOfBirthProblem, requiredConsentTypes, riyadhToday, type Gender, type Relationship } from './rules.ts';

export type NewRegistration = {
  relationship: Relationship;
  patient: { firstName: string; lastName: string; dateOfBirth: string; gender: Gender };
  contact: { fullName: string; phone: string };
  branchId: string;
  consentDocumentIds: string[];
  saveToProfile: boolean;
};

const invalid = (code: string, message: string, details?: Record<string, unknown>) => new AppError(422, code, message, details);

function fingerprint(input: NewRegistration): Buffer {
  const canonical = JSON.stringify({ ...input, consentDocumentIds: [...input.consentDocumentIds].sort() });
  return createHash('sha256').update(canonical).digest();
}

/**
 * Creates a registration for the signed-in customer in one transaction: patient (reused when
 * identical), registration, first status-history row, consent records and the audit entry.
 * The same Idempotency-Key always yields the same registration, so double clicks and network
 * retries cannot create duplicates. Tracking ID and QR are issued in Phase 3.
 */
export async function createRegistration(
  deps: Deps,
  owner: { userId: string; email: string },
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

    const patientId = await upsertPatient(tx, owner.userId, input, meta);

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO registrations (account_user_id, patient_id, branch_id, contact_full_name, contact_email, contact_phone,
                                  patient_age_months_at_registration, idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [owner.userId, patientId, input.branchId, input.contact.fullName, owner.email, input.contact.phone, age.totalMonths, idempotencyKey, print],
    );
    const id = rows[0]!.id;

    await tx.query(
      `INSERT INTO registration_status_history (registration_id, from_status, to_status, changed_by, actor_role)
       VALUES ($1, NULL, 'registration_completed', $2, 'customer')`,
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
    await audit(tx, {
      ...meta,
      action: 'registration.created',
      outcome: 'success',
      targetType: 'registration',
      targetId: id,
      metadata: { relationship: input.relationship, branch: branch.rows[0].code, consents: input.consentDocumentIds.length },
    });
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

/** Reuses an identical existing patient of this account; the "myself" patient is kept up to date. */
async function upsertPatient(tx: Queryable, userId: string, input: NewRegistration, meta: AuditMeta): Promise<string> {
  const p = input.patient;
  if (input.relationship === 'self') {
    const self = await tx.query<{ id: string; first_name: string; last_name: string; date_of_birth: string; gender: string }>(
      `SELECT id, first_name, last_name, to_char(date_of_birth, 'YYYY-MM-DD') AS date_of_birth, gender
         FROM patients WHERE account_user_id = $1 AND relationship = 'self' FOR UPDATE`,
      [userId],
    );
    const existing = self.rows[0];
    if (existing) {
      const changed = (['first_name', 'last_name', 'date_of_birth', 'gender'] as const).filter(
        (f) => existing[f] !== { first_name: p.firstName, last_name: p.lastName, date_of_birth: p.dateOfBirth, gender: p.gender }[f],
      );
      if (changed.length) {
        await tx.query('UPDATE patients SET first_name = $2, last_name = $3, date_of_birth = $4, gender = $5 WHERE id = $1', [existing.id, p.firstName, p.lastName, p.dateOfBirth, p.gender]);
        await audit(tx, { ...meta, action: 'patient.updated', outcome: 'success', targetType: 'patient', targetId: existing.id, fieldsAccessed: changed });
      }
      return existing.id;
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
