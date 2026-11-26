import type { Deps, SessionInfo } from '../../context.ts';
import { withTx, type Queryable } from '../../db/pool.ts';
import { AppError } from '../../lib/errors.ts';
import type { AuditMeta } from '../accounts/accounts.service.ts';
import { audit, auditSafe } from '../audit/audit.service.ts';
import { customerTokenHmac, extractCustomerToken } from '../qr/qr.service.ts';
import { ageParts, riyadhToday } from '../registrations/rules.ts';
import { currentInstructions, type CollectionInstructions } from './instructions.ts';
import { allocateSampleCode, recordInitialCustody } from '../custody/custody.service.ts';
import { issueSampleQr } from '../custody/sample-qr.ts';

// Sample collection by staff. PRIVACY: everything returned to staff is produced by the
// allowlist functions in this file (age, gender and operational data only).
//
// Lock order used by every writer that touches a registration, to prevent deadlocks:
//   registrations row → patients row → customer_qr_tokens / sessions → audit chain.

const SESSION_MINUTES = 30;

export type VerificationStatus = 'not_verified' | 'pending' | 'verified' | 'failed';
export type InvalidReason = 'UNRECOGNISED' | 'NOT_FOUND' | 'REVOKED' | 'REPLACED' | 'ALREADY_COLLECTED' | 'REGISTRATION_INACTIVE';

type BranchView = { id: string; nameEn: string; nameAr: string; cityEn: string; cityAr: string };

export type StaffScanView =
  | { qrValid: false; reason: InvalidReason; trackingId?: string; sampleStatus?: string }
  | {
      qrValid: true;
      collectionSessionId: string;
      trackingId: string;
      patientAge: { years: number; months: number };
      patientGender: 'male' | 'female';
      sampleType: 'hair';
      sampleStatus: string;
      branch: BranchView;
      collectionInstructions: CollectionInstructions;
      identityVerification: { status: VerificationStatus; method: string | null };
      devVerificationAvailable: boolean;
      canCollect: boolean;
    };

type ScanRow = {
  qr_id: string; qr_status: 'active' | 'revoked' | 'used'; registration_id: string; patient_id: string;
  tracking_id: string; status: string; sample_type: 'hair'; branch_id: string;
  date_of_birth: string; gender: 'male' | 'female'; has_newer_token: boolean;
};

const branchView = (b: { id: string; name_en: string; name_ar: string; city_en: string; city_ar: string }): BranchView =>
  ({ id: b.id, nameEn: b.name_en, nameAr: b.name_ar, cityEn: b.city_en, cityAr: b.city_ar });

/** Active branches the staff member is currently assigned to. */
export async function assignedBranches(db: Queryable, userId: string): Promise<BranchView[]> {
  const { rows } = await db.query<{ id: string; name_en: string; name_ar: string; city_en: string; city_ar: string }>(
    `SELECT b.id, b.name_en, b.name_ar, b.city_en, b.city_ar
       FROM staff_branch_assignments a JOIN collection_branches b ON b.id = a.branch_id
      WHERE a.user_id = $1 AND a.revoked_at IS NULL AND b.active
      ORDER BY b.sort_order, b.name_en`,
    [userId],
  );
  return rows.map(branchView);
}

export async function requireAssignedBranch(db: Queryable, userId: string, branchId: string, meta: AuditMeta): Promise<BranchView> {
  const branch = (await assignedBranches(db, userId)).find((b) => b.id === branchId);
  if (!branch) {
    await auditSafe(db, { ...meta, action: 'staff.branch_denied', outcome: 'denied', targetType: 'branch', targetId: branchId });
    throw new AppError(403, 'BRANCH_NOT_AUTHORIZED', 'You are not assigned to this branch.');
  }
  return branch;
}

async function latestVerification(db: Queryable, sessionId: string, patientId: string): Promise<{ id: number | null; status: VerificationStatus; method: string | null }> {
  const { rows } = await db.query<{ id: string; status: 'pending' | 'verified' | 'failed'; method: string; current: boolean }>(
    `SELECT v.id, v.status, v.method, (v.patient_version_at = p.updated_at) AS current
       FROM identity_verifications v JOIN patients p ON p.id = v.patient_id
      WHERE v.collection_session_id = $1 AND v.patient_id = $2
      ORDER BY v.id DESC LIMIT 1`,
    [sessionId, patientId],
  );
  const v = rows[0];
  if (!v) return { id: null, status: 'not_verified', method: null };
  // A correction to the patient's details after verification means it must be done again.
  if (!v.current) return { id: null, status: 'not_verified', method: null };
  return { id: Number(v.id), status: v.status, method: v.method };
}

function instructionsFor(all: CollectionInstructions[], locale: 'en' | 'ar'): CollectionInstructions {
  const doc = all.find((i) => i.locale === locale) ?? all[0];
  if (!doc) throw new AppError(503, 'INSTRUCTIONS_NOT_CONFIGURED', 'Collection instructions are not available yet.');
  return doc;
}

/** The only function that builds what staff see after a valid scan (explicit allowlist). */
function toScanView(
  deps: Deps, r: Pick<ScanRow, 'tracking_id' | 'status' | 'sample_type' | 'date_of_birth' | 'gender'>, sessionId: string,
  branch: BranchView, instructions: CollectionInstructions, verification: { status: VerificationStatus; method: string | null },
): StaffScanView {
  const age = ageParts(r.date_of_birth, riyadhToday())!;
  return {
    qrValid: true,
    collectionSessionId: sessionId,
    trackingId: r.tracking_id,
    patientAge: { years: age.years, months: age.months },
    patientGender: r.gender,
    sampleType: r.sample_type,
    sampleStatus: r.status,
    branch,
    collectionInstructions: instructions,
    identityVerification: { status: verification.status, method: verification.method },
    devVerificationAvailable: Boolean(deps.config.devIdentityVerification),
    canCollect: r.status === 'awaiting_sample_collection' && verification.status === 'verified',
  };
}

/**
 * Validates a scanned customer QR for the staff member's selected branch and opens (or resumes)
 * a collection session. Never marks identity as verified: a QR proves possession, not identity.
 */
export async function scanCustomerQr(deps: Deps, staff: SessionInfo, scanned: string, branchId: string | null, meta: AuditMeta): Promise<StaffScanView> {
  const { db } = deps;
  const invalid = async (reason: InvalidReason, registrationId?: string, extra: Partial<StaffScanView> = {}) => {
    await auditSafe(db, { ...meta, action: 'qr.validated', outcome: 'failure', targetType: registrationId ? 'registration' : null, targetId: registrationId ?? null, metadata: { reason: reason.toLowerCase() } });
    return { qrValid: false as const, reason, ...extra } as StaffScanView;
  };

  const token = extractCustomerToken(scanned);
  if (!token) return invalid('UNRECOGNISED');
  const { rows } = await db.query<ScanRow>(
    `SELECT q.id AS qr_id, q.status AS qr_status, r.id AS registration_id, r.patient_id, r.tracking_id, r.status, r.sample_type, r.branch_id,
            to_char(p.date_of_birth, 'YYYY-MM-DD') AS date_of_birth, p.gender,
            EXISTS (SELECT 1 FROM customer_qr_tokens n WHERE n.registration_id = r.id AND n.created_at > q.created_at) AS has_newer_token
       FROM customer_qr_tokens q JOIN registrations r ON r.id = q.registration_id JOIN patients p ON p.id = r.patient_id
      WHERE q.token_hmac = $1`,
    [customerTokenHmac(deps, token)],
  );
  const row = rows[0];
  if (!row) return invalid('NOT_FOUND');

  // Branch authorisation before revealing anything else about the registration.
  const branches = await assignedBranches(db, staff.userId);
  const regBranch = branches.find((b) => b.id === row.branch_id);
  if (!regBranch || (branchId !== null && branchId !== row.branch_id)) {
    await auditSafe(db, { ...meta, action: 'qr.validated', outcome: 'denied', targetType: 'registration', targetId: row.registration_id, metadata: { reason: 'branch_not_authorized' } });
    throw new AppError(403, 'BRANCH_NOT_AUTHORIZED', 'This registration is for a branch you are not assigned to or have not selected.');
  }
  if (row.qr_status === 'used' || row.status === 'sample_collected' || (await hasLiveSample(db, row.registration_id))) {
    return invalid('ALREADY_COLLECTED', row.registration_id, { trackingId: row.tracking_id, sampleStatus: row.status });
  }
  if (row.qr_status === 'revoked') return invalid(row.has_newer_token ? 'REPLACED' : 'REVOKED', row.registration_id);
  if (row.status !== 'awaiting_sample_collection') return invalid('REGISTRATION_INACTIVE', row.registration_id);

  const instructions = instructionsFor(await currentInstructions(db, deps.config), staff.locale);

  // Resume this staff member's open session for the same token, or start a new one.
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM collection_sessions
      WHERE registration_id = $1 AND qr_token_id = $2 AND staff_user_id = $3 AND branch_id = $4
        AND completed_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`,
    [row.registration_id, row.qr_id, staff.userId, row.branch_id],
  );
  const sessionId = existing.rows[0]?.id ?? (await db.query<{ id: string }>(
    `INSERT INTO collection_sessions (registration_id, qr_token_id, staff_user_id, branch_id, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5)) RETURNING id`,
    [row.registration_id, row.qr_id, staff.userId, row.branch_id, SESSION_MINUTES],
  )).rows[0]!.id;

  await db.query('UPDATE customer_qr_tokens SET last_validated_at = now() WHERE id = $1', [row.qr_id]);
  await audit(db, {
    ...meta, action: 'qr.validated', outcome: 'success', targetType: 'registration', targetId: row.registration_id,
    fieldsAccessed: ['patient.age', 'patient.gender', 'registration.tracking_id', 'registration.status'], metadata: { collectionSessionId: sessionId },
  });
  const verification = await latestVerification(db, sessionId, row.patient_id);
  return toScanView(deps, row, sessionId, regBranch, instructions, verification);
}

async function hasLiveSample(db: Queryable, registrationId: string): Promise<boolean> {
  return Boolean((await db.query(`SELECT 1 FROM samples WHERE registration_id = $1 AND status <> 'rejected'`, [registrationId])).rowCount);
}

type SessionRow = {
  id: string; registration_id: string; qr_token_id: string; staff_user_id: string; branch_id: string;
  expires_at: Date; completed_at: Date | null; expired: boolean;
};

/** Loads a session owned by this staff member (someone else's session id behaves like a missing one). */
async function ownSession(db: Queryable, staffUserId: string, sessionId: string, lock = false): Promise<SessionRow> {
  const { rows } = await db.query<SessionRow>(
    `SELECT id, registration_id, qr_token_id, staff_user_id, branch_id, expires_at, completed_at, (expires_at <= now()) AS expired
       FROM collection_sessions WHERE id = $1 AND staff_user_id = $2 ${lock ? 'FOR UPDATE' : ''}`,
    [sessionId, staffUserId],
  );
  if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'Not found.');
  return rows[0];
}

/** Current state of a collection session (same allowlist as a scan). */
export async function sessionView(deps: Deps, staff: SessionInfo, sessionId: string, meta: AuditMeta): Promise<StaffScanView> {
  const s = await ownSession(deps.db, staff.userId, sessionId);
  const branch = await requireAssignedBranch(deps.db, staff.userId, s.branch_id, meta);
  if (s.completed_at) throw new AppError(409, 'SESSION_COMPLETED', 'This collection has already been confirmed.');
  if (s.expired) throw new AppError(409, 'SESSION_EXPIRED', 'This scan has expired. Please scan the QR code again.');
  const { rows } = await deps.db.query<Pick<ScanRow, 'tracking_id' | 'status' | 'sample_type' | 'date_of_birth' | 'gender' | 'patient_id'>>(
    `SELECT r.tracking_id, r.status, r.sample_type, r.patient_id, to_char(p.date_of_birth, 'YYYY-MM-DD') AS date_of_birth, p.gender
       FROM registrations r JOIN patients p ON p.id = r.patient_id WHERE r.id = $1`,
    [s.registration_id],
  );
  const r = rows[0]!;
  const instructions = instructionsFor(await currentInstructions(deps.db, deps.config), staff.locale);
  return toScanView(deps, r, s.id, branch, instructions, await latestVerification(deps.db, s.id, r.patient_id));
}

/**
 * DEVELOPMENT ONLY: records a simulated identity-verification outcome. Unavailable unless
 * DEV_IDENTITY_VERIFICATION is on, which the configuration refuses in production.
 */
export async function recordDevVerification(deps: Deps, staff: SessionInfo, sessionId: string, outcome: 'pending' | 'verified' | 'failed', meta: AuditMeta) {
  if (!deps.config.devIdentityVerification || deps.config.env === 'production') {
    throw new AppError(404, 'NOT_FOUND', 'Not found.');
  }
  await withTx(deps.db, async (tx) => {
    const s = await ownSession(tx, staff.userId, sessionId, true);
    if (s.completed_at || s.expired) throw new AppError(409, 'SESSION_CLOSED', 'This scan is no longer open. Please scan again.');
    // patient_version_at is copied inside SQL: a JavaScript Date would drop PostgreSQL's
    // microseconds and the "still current?" comparison would then always fail.
    await tx.query(
      `INSERT INTO identity_verifications (collection_session_id, registration_id, patient_id, method, status, patient_version_at, performed_by)
       SELECT $1, r.id, p.id, 'dev_simulated', $3, p.updated_at, $4
         FROM registrations r JOIN patients p ON p.id = r.patient_id WHERE r.id = $2`,
      [s.id, s.registration_id, outcome, staff.userId],
    );
    await audit(tx, { ...meta, action: 'identity.verification_recorded', outcome: 'success', targetType: 'registration', targetId: s.registration_id, metadata: { method: 'dev_simulated', status: outcome, collectionSessionId: s.id } });
  });
  return sessionView(deps, staff, sessionId, meta);
}

/**
 * Confirms collection in ONE transaction that re-checks everything: session ownership and
 * expiry, staff still active with collect permission, branch assignment, QR token still the
 * active one, registration still awaiting collection, no live sample, identity verified for this
 * session and unchanged patient, and the complete checklist of the current instructions.
 */
export async function confirmCollection(
  deps: Deps, staff: SessionInfo, sessionId: string, input: { instructionsId: string; checklist: string[] }, meta: AuditMeta,
): Promise<{ trackingId: string; status: 'sample_collected'; collectedAt: string; branch: BranchView; sample: { id: string; sampleId: string } }> {
  try {
    return await withTx(deps.db, async (tx) => {
      const s0 = await ownSession(tx, staff.userId, sessionId);
      // 1) registration row first (same lock order as QR replacement and corrections)
      const reg = (await tx.query<{ id: string; tracking_id: string; status: string; patient_id: string; branch_id: string }>(
        'SELECT id, tracking_id, status, patient_id, branch_id FROM registrations WHERE id = $1 FOR UPDATE', [s0.registration_id])).rows[0]!;
      // 2) patient row, so a concurrent correction can't slip in after the verification check
      await tx.query('SELECT 1 FROM patients WHERE id = $1 FOR UPDATE', [reg.patient_id]);
      const s = await ownSession(tx, staff.userId, sessionId, true);

      if (s.completed_at) throw new AppError(409, 'ALREADY_COLLECTED', 'This sample has already been collected.');
      if (s.expired) throw new AppError(409, 'SESSION_EXPIRED', 'This scan has expired. Please scan the QR code again.');

      const allowed = await tx.query(
        `SELECT 1 FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN role_permissions rp ON rp.role_key = ur.role_key
          WHERE u.id = $1 AND u.status = 'active' AND rp.permission_key = 'collection.collect' LIMIT 1`, [staff.userId]);
      if (!allowed.rowCount) throw new AppError(403, 'FORBIDDEN', 'You do not have permission to do this.');

      const assignment = await tx.query(
        `SELECT 1 FROM staff_branch_assignments a JOIN collection_branches b ON b.id = a.branch_id
          WHERE a.user_id = $1 AND a.branch_id = $2 AND a.revoked_at IS NULL AND b.active FOR SHARE OF a`, [staff.userId, s.branch_id]);
      if (!assignment.rowCount || reg.branch_id !== s.branch_id) throw new AppError(403, 'BRANCH_NOT_AUTHORIZED', 'You are no longer assigned to this branch.');

      if (reg.status === 'sample_collected' || (await hasLiveSample(tx, reg.id))) throw new AppError(409, 'ALREADY_COLLECTED', 'This sample has already been collected.');
      if (reg.status !== 'awaiting_sample_collection') throw new AppError(409, 'REGISTRATION_INACTIVE', 'This registration can no longer be collected.');

      const token = (await tx.query<{ status: string }>('SELECT status FROM customer_qr_tokens WHERE id = $1 FOR UPDATE', [s.qr_token_id])).rows[0]!;
      if (token.status !== 'active') throw new AppError(409, 'QR_REPLACED', 'The QR code was replaced or revoked. Please scan the customer’s current QR code.');

      const verification = await latestVerification(tx, s.id, reg.patient_id);
      if (verification.status !== 'verified' || verification.id === null) {
        throw new AppError(409, 'IDENTITY_NOT_VERIFIED', 'Identity verification must be completed before collection.');
      }
      if (deps.config.env === 'production' && verification.method === 'dev_simulated') {
        throw new AppError(409, 'IDENTITY_NOT_VERIFIED', 'An approved identity verification method is required.');
      }

      const instructions = (await currentInstructions(tx, deps.config)).find((i) => i.id === input.instructionsId);
      if (!instructions) throw new AppError(409, 'INSTRUCTIONS_OUTDATED', 'The collection instructions have changed. Please review the current version.');
      const required = instructions.checklist.map((c) => c.id).sort();
      const given = [...new Set(input.checklist)].sort();
      if (required.length !== given.length || required.some((id, i) => id !== given[i])) {
        throw new AppError(422, 'CHECKLIST_INCOMPLETE', 'Complete every item on the collection checklist.', { required });
      }

      // Phase 6: the physical sample gets its ID (tracking ID + -SXX, allocated under the
      // registration lock), its own QR token and its initial custody event, in this transaction.
      const code = await allocateSampleCode(tx, reg.id, reg.tracking_id);
      const sample = await tx.query<{ id: string; collected_at: Date }>(
        `INSERT INTO samples (registration_id, branch_id, collected_by, collection_session_id, identity_verification_id, instructions_id, checklist, sample_seq, sample_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, collected_at`,
        [reg.id, s.branch_id, staff.userId, s.id, verification.id, instructions.id, JSON.stringify(given), code.seq, code.code],
      );
      const sampleRowId = sample.rows[0]!.id;
      await issueSampleQr(tx, deps, sampleRowId, staff.userId);
      await recordInitialCustody(tx, { id: sampleRowId, registrationId: reg.id, branchId: s.branch_id }, staff.userId);
      await tx.query(`UPDATE registrations SET status = 'sample_collected' WHERE id = $1`, [reg.id]);
      await tx.query(
        `INSERT INTO registration_status_history (registration_id, from_status, to_status, changed_by, actor_role, reason)
         VALUES ($1, 'awaiting_sample_collection', 'sample_collected', $2, 'collection_staff', 'sample collected at branch')`,
        [reg.id, staff.userId],
      );
      // The customer QR has done its job: it can never authorise another collection.
      await tx.query(`UPDATE customer_qr_tokens SET status = 'used', used_at = now() WHERE id = $1`, [s.qr_token_id]);
      await tx.query('UPDATE collection_sessions SET completed_at = now() WHERE id = $1', [s.id]);
      await audit(tx, {
        ...meta, action: 'sample.collected', outcome: 'success', targetType: 'registration', targetId: reg.id,
        metadata: { trackingId: reg.tracking_id, sampleId: code.code, branchId: s.branch_id, collectionSessionId: s.id, instructionsVersion: instructions.version, identityMethod: verification.method },
      });
      const branch = (await tx.query<{ id: string; name_en: string; name_ar: string; city_en: string; city_ar: string }>(
        'SELECT id, name_en, name_ar, city_en, city_ar FROM collection_branches WHERE id = $1', [s.branch_id])).rows[0]!;
      return {
        trackingId: reg.tracking_id, status: 'sample_collected' as const, collectedAt: sample.rows[0]!.collected_at.toISOString(), branch: branchView(branch),
        sample: { id: sampleRowId, sampleId: code.code },
      };
    });
  } catch (err) {
    // A simultaneous confirmation that lost the race hits the one-live-sample unique index.
    if ((err as { code?: string; constraint?: string }).code === '23505') {
      throw new AppError(409, 'ALREADY_COLLECTED', 'This sample has already been collected.');
    }
    if (err instanceof AppError && err.status !== 422) {
      await auditSafe(deps.db, { ...meta, action: 'sample.collect_refused', outcome: 'failure', metadata: { reason: err.code, collectionSessionId: sessionId } });
    }
    throw err;
  }
}

/** Collection history for the staff member's assigned branches (explicit allowlist per row). */
export async function collectionHistory(
  deps: Deps, staff: SessionInfo,
  q: { from?: string; to?: string; branchId?: string; status?: string; trackingId?: string; limit: number; before?: string },
  meta: AuditMeta,
) {
  const branches = await assignedBranches(deps.db, staff.userId);
  let branchIds = branches.map((b) => b.id);
  if (q.branchId) {
    await requireAssignedBranch(deps.db, staff.userId, q.branchId, meta);
    branchIds = [q.branchId];
  }
  if (!branchIds.length) return { items: [], branches };
  const where = ['s.branch_id = ANY($1::uuid[])'];
  const params: unknown[] = [branchIds];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (q.from) add(`s.collected_at >= (?::date)::timestamp AT TIME ZONE 'Asia/Riyadh'`, q.from);
  if (q.to) add(`s.collected_at < ((?::date) + 1)::timestamp AT TIME ZONE 'Asia/Riyadh'`, q.to);
  if (q.status) add('r.status = ?', q.status);
  if (q.trackingId) add('r.tracking_id = ?', q.trackingId);
  if (q.before) add('s.collected_at < ?::timestamptz', q.before);
  params.push(q.limit);
  const { rows } = await deps.db.query<{ tracking_id: string; status: string; sample_type: 'hair'; collected_at: Date; date_of_birth: string; gender: 'male' | 'female'; branch_id: string; collected_by: string; collected_day: string }>(
    `SELECT r.tracking_id, r.status, s.sample_type, s.collected_at, s.branch_id, s.collected_by,
            to_char(p.date_of_birth, 'YYYY-MM-DD') AS date_of_birth, p.gender,
            to_char(s.collected_at AT TIME ZONE 'Asia/Riyadh', 'YYYY-MM-DD') AS collected_day
       FROM samples s JOIN registrations r ON r.id = s.registration_id JOIN patients p ON p.id = r.patient_id
      WHERE ${where.join(' AND ')}
      ORDER BY s.collected_at DESC LIMIT $${params.length}`,
    params,
  );
  const byId = new Map(branches.map((b) => [b.id, b]));
  const items = rows.map((r) => {
    const age = ageParts(r.date_of_birth, r.collected_day)!; // age on the day of collection
    return {
      trackingId: r.tracking_id,
      patientAge: { years: age.years, months: age.months },
      patientGender: r.gender,
      sampleType: r.sample_type,
      sampleStatus: r.status,
      collectedAt: r.collected_at.toISOString(),
      branch: byId.get(r.branch_id)!,
      collectedByMe: r.collected_by === staff.userId,
    };
  });
  return { items, branches, nextBefore: items.length === q.limit ? items.at(-1)!.collectedAt : null };
}

/** Today's figures (Asia/Riyadh day) for one assigned branch, plus recent activity. */
export async function staffDashboard(deps: Deps, staff: SessionInfo, branchId: string, meta: AuditMeta) {
  const branch = await requireAssignedBranch(deps.db, staff.userId, branchId, meta);
  const { rows } = await deps.db.query<{ at_branch: number; by_me: number; awaiting: number }>(
    `SELECT
       (SELECT count(*)::int FROM samples WHERE branch_id = $1 AND collected_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh') AS at_branch,
       (SELECT count(*)::int FROM samples WHERE branch_id = $1 AND collected_by = $2 AND collected_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh') AS by_me,
       (SELECT count(*)::int FROM registrations WHERE branch_id = $1 AND status = 'awaiting_sample_collection') AS awaiting`,
    [branchId, staff.userId],
  );
  const recent = await collectionHistory(deps, staff, { branchId, limit: 5 }, meta);
  return {
    branch,
    today: { date: riyadhToday(), collectedAtBranch: rows[0]!.at_branch, collectedByMe: rows[0]!.by_me, awaitingAtBranch: rows[0]!.awaiting },
    recent: recent.items,
  };
}
