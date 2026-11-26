import type { SessionInfo } from '../../context.ts';
import type { Deps } from '../../context.ts';
import { AppError } from '../../lib/errors.ts';
import type { AuditMeta } from '../accounts/accounts.service.ts';
import { audit, auditSafe } from '../audit/audit.service.ts';
import { ageParts, riyadhToday } from '../registrations/rules.ts';
import { customerTokenHmac, extractCustomerToken } from './qr.service.ts';

// Server-side validation of a customer QR, for the Phase 4 collection-staff scanner.
// PRIVACY: the response is built from an explicit allowlist. Staff receive the patient's age
// and gender plus operational data, never name, email, phone, date of birth, address,
// nationality, account-holder details or anything else.

/** Collection steps shown to staff. PROVISIONAL until the laboratory approves the SOP. */
export const STAFF_COLLECTION_INSTRUCTIONS = {
  version: '0.1-provisional',
  steps: [
    'Confirm the QR is valid and the identity verification step is complete.',
    'Collect the hair sample according to the approved TRACED collection procedure.',
    'Attach the physical sample label (Phase 6) before the sample leaves the counter.',
  ],
} as const;

export type StaffQrView =
  | { qrValid: false; reason: 'UNRECOGNISED' | 'NOT_FOUND' | 'REVOKED' | 'REGISTRATION_INACTIVE' }
  | {
      qrValid: true;
      trackingId: string;
      patientAge: { years: number; months: number };
      patientGender: 'male' | 'female';
      sampleType: 'hair';
      sampleStatus: string;
      collectionInstructions: typeof STAFF_COLLECTION_INSTRUCTIONS;
      identityVerification: { status: 'not_available' };
    };

type Row = {
  qr_status: 'active' | 'revoked';
  qr_id: string;
  registration_id: string;
  tracking_id: string;
  status: string;
  sample_type: 'hair';
  branch_id: string;
  date_of_birth: string;
  gender: 'male' | 'female';
};

/** The only function that turns a registration into something staff may see. */
export function toStaffView(r: Row): StaffQrView {
  const age = ageParts(r.date_of_birth, riyadhToday())!;
  return {
    qrValid: true,
    trackingId: r.tracking_id,
    patientAge: { years: age.years, months: age.months },
    patientGender: r.gender,
    sampleType: r.sample_type,
    sampleStatus: r.status,
    collectionInstructions: STAFF_COLLECTION_INSTRUCTIONS,
    identityVerification: { status: 'not_available' }, // OTP / Nafath arrive in later phases
  };
}

export async function validateCustomerQr(deps: Deps, staff: SessionInfo, scanned: string, meta: AuditMeta): Promise<StaffQrView> {
  const token = extractCustomerToken(scanned);
  if (!token) {
    await auditSafe(deps.db, { ...meta, action: 'qr.validated', outcome: 'failure', metadata: { reason: 'unrecognised' } });
    return { qrValid: false, reason: 'UNRECOGNISED' };
  }
  const { rows } = await deps.db.query<Row>(
    `SELECT q.status AS qr_status, q.id AS qr_id, r.id AS registration_id, r.tracking_id, r.status, r.sample_type, r.branch_id,
            to_char(p.date_of_birth, 'YYYY-MM-DD') AS date_of_birth, p.gender
       FROM customer_qr_tokens q
       JOIN registrations r ON r.id = q.registration_id
       JOIN patients p ON p.id = r.patient_id
      WHERE q.token_hmac = $1`,
    [customerTokenHmac(deps, token)],
  );
  const row = rows[0];
  if (!row) {
    await auditSafe(deps.db, { ...meta, action: 'qr.validated', outcome: 'failure', metadata: { reason: 'not_found' } });
    return { qrValid: false, reason: 'NOT_FOUND' };
  }

  // Branch authorisation: staff may only act on registrations for branches they're assigned to.
  const assigned = await deps.db.query(
    'SELECT 1 FROM staff_branch_assignments WHERE user_id = $1 AND branch_id = $2 AND revoked_at IS NULL',
    [staff.userId, row.branch_id],
  );
  if (!assigned.rowCount) {
    await auditSafe(deps.db, { ...meta, action: 'qr.validated', outcome: 'denied', targetType: 'registration', targetId: row.registration_id, metadata: { reason: 'branch_not_assigned' } });
    throw new AppError(403, 'BRANCH_NOT_AUTHORIZED', 'This registration belongs to a branch you are not assigned to.');
  }
  if (row.qr_status === 'revoked') {
    await auditSafe(deps.db, { ...meta, action: 'qr.validated', outcome: 'failure', targetType: 'registration', targetId: row.registration_id, metadata: { reason: 'revoked' } });
    return { qrValid: false, reason: 'REVOKED' };
  }
  if (row.status === 'cancelled' || row.status === 'rejected') {
    await auditSafe(deps.db, { ...meta, action: 'qr.validated', outcome: 'failure', targetType: 'registration', targetId: row.registration_id, metadata: { reason: row.status } });
    return { qrValid: false, reason: 'REGISTRATION_INACTIVE' };
  }

  await deps.db.query('UPDATE customer_qr_tokens SET last_validated_at = now() WHERE id = $1', [row.qr_id]);
  await audit(deps.db, {
    ...meta, action: 'qr.validated', outcome: 'success', targetType: 'registration', targetId: row.registration_id,
    fieldsAccessed: ['patient.age', 'patient.gender', 'registration.tracking_id', 'registration.status'],
  });
  return toStaffView(row);
}
