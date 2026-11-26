import { randomUUID } from 'node:crypto';
import type { Deps, SessionInfo } from '../../context.ts';
import { primaryRole } from '../../context.ts';
import { withTx, type Queryable } from '../../db/pool.ts';
import { AppError, Errors } from '../../lib/errors.ts';
import type { AuditMeta } from '../accounts/accounts.service.ts';
import { audit, auditSafe } from '../audit/audit.service.ts';
import { buildLink } from '../auth/links.ts';
import { enqueueEmail } from '../mail/outbox.ts';
import { issueCustomerQr } from '../qr/qr.service.ts';
import { ageParts, riyadhToday } from '../registrations/rules.ts';
import { parseSampleCode, sampleTokenHmac } from './sample-qr.ts';

// Chain of custody for physical samples (Phase 6).
//
// Sample status (physical) and registration status (customer journey) are kept separate: the
// registration mirrors its current sample (collected → sample_collected, packaged →
// sample_packaged, otherwise the same name), and keeps `cancelled` for itself. Every change is an
// append-only custody_events row written in the same transaction as the status change, the
// registration status history and the audit entry. Lock order everywhere: registration → sample.
//
// Nothing changes because a QR was scanned: every action is an explicit, server-validated request
// against the transition matrix below.

export type SampleStatus = 'collected' | 'packaged' | 'ready_for_dispatch' | 'dispatched' | 'in_transit' | 'received_by_laboratory'
  | 'analysis_in_progress' | 'analysis_completed' | 'report_available' | 'rejected';
export const SAMPLE_STATUSES: SampleStatus[] = ['collected', 'packaged', 'ready_for_dispatch', 'dispatched', 'in_transit', 'received_by_laboratory',
  'analysis_in_progress', 'analysis_completed', 'report_available', 'rejected'];
export const REJECTION_REASONS = ['damaged_packaging', 'missing_sample', 'unreadable_label', 'identification_mismatch', 'insufficient_sample', 'other'] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export const registrationStatusFor = (s: SampleStatus) => (s === 'collected' ? 'sample_collected' : s === 'packaged' ? 'sample_packaged' : s);

type Side = 'branch' | 'laboratory';
/**
 * The transition matrix. `in_transit` is reserved: Phase 6 has no transport accounts, so nobody
 * records it (no fabricated intermediate custody). Receipt by the laboratory is independent of
 * the dispatch record. Everything not listed is refused.
 */
export const ACTIONS = {
  package: { from: ['collected'], to: 'packaged', side: 'branch' },
  ready_for_dispatch: { from: ['packaged'], to: 'ready_for_dispatch', side: 'branch' },
  dispatch: { from: ['ready_for_dispatch'], to: 'dispatched', side: 'branch' },
  receive: { from: ['dispatched', 'in_transit'], to: 'received_by_laboratory', side: 'laboratory' },
  reject: { from: ['dispatched', 'in_transit', 'received_by_laboratory', 'analysis_in_progress'], to: 'rejected', side: 'laboratory' },
  start_analysis: { from: ['received_by_laboratory'], to: 'analysis_in_progress', side: 'laboratory' },
  complete_analysis: { from: ['analysis_in_progress'], to: 'analysis_completed', side: 'laboratory' },
  report_available: { from: ['analysis_completed'], to: 'report_available', side: 'laboratory' },
} as const satisfies Record<string, { from: readonly SampleStatus[]; to: SampleStatus; side: Side }>;
export type CustodyAction = keyof typeof ACTIONS;

export type ActionInput = {
  code: string; // scanned sample QR content or typed physical sample ID (identifies the physical sample)
  action: CustodyAction;
  expectedStatus: SampleStatus; // what the operator saw; a different current status is a conflict
  idempotencyKey: string;
  courier?: string;
  shipmentTrackingNumber?: string;
  condition?: 'intact' | 'damaged';
  reasonCategory?: RejectionReason;
  remarks?: string;
  reportDeliveryConfirmed?: boolean;
};

type SampleRow = {
  id: string; registration_id: string; sample_code: string; sample_seq: number; status: SampleStatus; status_changed_at: Date;
  collected_at: Date; branch_id: string; collected_by: string; tracking_id: string; reg_status: string; dob: string; gender: string;
  b_code: string; b_name_en: string; b_name_ar: string; b_city_en: string; b_city_ar: string;
};
const SAMPLE_SELECT = `
  SELECT s.id, s.registration_id, s.sample_code, s.sample_seq, s.status, s.status_changed_at, s.collected_at, s.branch_id, s.collected_by,
         r.tracking_id, r.status AS reg_status, to_char(p.date_of_birth, 'YYYY-MM-DD') AS dob, p.gender,
         b.code AS b_code, b.name_en AS b_name_en, b.name_ar AS b_name_ar, b.city_en AS b_city_en, b.city_ar AS b_city_ar
    FROM samples s JOIN registrations r ON r.id = s.registration_id JOIN patients p ON p.id = r.patient_id
    JOIN collection_branches b ON b.id = s.branch_id`;

/** Resolves scanned/typed text to a sample. Unknown, malformed and revoked codes look the same. */
export async function resolveSample(db: Queryable, deps: Deps, code: string): Promise<{ sample: SampleRow; identifiedBy: 'sample_qr' | 'sample_id_entry' }> {
  const parsed = parseSampleCode(code);
  if (!parsed) throw new AppError(404, 'SAMPLE_NOT_RECOGNISED', 'This is not a recognised TRACED sample label.');
  const { rows } = parsed.kind === 'token'
    ? await db.query<SampleRow>(`${SAMPLE_SELECT} JOIN sample_qr_tokens q ON q.sample_id = s.id AND q.status = 'active' WHERE q.token_hmac = $1`, [sampleTokenHmac(deps, parsed.value)])
    : await db.query<SampleRow>(`${SAMPLE_SELECT} WHERE s.sample_code = $1`, [parsed.value]);
  if (!rows[0]) throw new AppError(404, 'SAMPLE_NOT_RECOGNISED', 'This is not a recognised TRACED sample label.');
  return { sample: rows[0], identifiedBy: parsed.kind === 'token' ? 'sample_qr' : 'sample_id_entry' };
}

export async function loadSample(db: Queryable, id: string): Promise<SampleRow | null> {
  return (await db.query<SampleRow>(`${SAMPLE_SELECT} WHERE s.id = $1`, [id])).rows[0] ?? null;
}

async function assignedTo(db: Queryable, userId: string, branchId: string): Promise<boolean> {
  const r = await db.query(
    `SELECT 1 FROM staff_branch_assignments a JOIN collection_branches b ON b.id = a.branch_id
      WHERE a.user_id = $1 AND a.branch_id = $2 AND a.revoked_at IS NULL`, [userId, branchId]);
  return Boolean(r.rowCount);
}

/** Collection staff may only see and act on samples of their assigned branches. */
export async function assertBranchAccess(db: Queryable, staff: SessionInfo, sample: SampleRow, meta: AuditMeta): Promise<void> {
  if (await assignedTo(db, staff.userId, sample.branch_id)) return;
  await auditSafe(db, { ...meta, action: 'custody.branch_denied', outcome: 'denied', targetType: 'sample', targetId: sample.id });
  throw new AppError(403, 'BRANCH_NOT_AUTHORIZED', 'This sample belongs to a branch you are not assigned to.');
}

export function allowedActions(side: Side, status: SampleStatus): CustodyAction[] {
  return (Object.keys(ACTIONS) as CustodyAction[]).filter((a) => ACTIONS[a].side === side && (ACTIONS[a].from as readonly string[]).includes(status));
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const branchOut = (s: SampleRow) => ({ code: s.b_code, nameEn: s.b_name_en, nameAr: s.b_name_ar, cityEn: s.b_city_en, cityAr: s.b_city_ar });
const age = (dob: string) => {
  const a = ageParts(dob, riyadhToday());
  return a ? { years: a.years, months: a.months } : null;
};

/** Operational core shared by every audience: no personal data at all. */
function core(s: SampleRow) {
  return { id: s.id, sampleId: s.sample_code, trackingId: s.tracking_id, sampleType: 'hair' as const, status: s.status, statusChangedAt: iso(s.status_changed_at), collectedAt: iso(s.collected_at), branch: branchOut(s) };
}

async function custodyFacts(db: Queryable, sampleId: string) {
  const { rows } = await db.query<{ to_status: string; occurred_at: Date; handover: Record<string, string>; condition: string | null; reason_category: string | null }>(
    `SELECT to_status, occurred_at, handover, condition, reason_category FROM custody_events WHERE sample_id = $1 ORDER BY id`, [sampleId]);
  const last = (st: string) => [...rows].reverse().find((r) => r.to_status === st);
  const d = last('dispatched');
  const rcv = last('received_by_laboratory');
  const rej = last('rejected');
  return {
    dispatch: d ? { at: iso(d.occurred_at), courier: d.handover.courier ?? null, shipmentTrackingNumber: d.handover.shipmentTrackingNumber ?? null } : null,
    receipt: rcv ? { at: iso(rcv.occurred_at), condition: rcv.condition } : rej && rej.condition ? { at: iso(rej.occurred_at), condition: rej.condition } : null,
    rejection: rej ? { at: iso(rej.occurred_at), reasonCategory: rej.reason_category } : null,
    steps: rows.map((r) => ({ status: r.to_status, at: iso(r.occurred_at) })),
  };
}

/** Collection staff view: operational data plus the patient's age and gender only (unchanged rule). */
export async function staffSampleView(db: Queryable, s: SampleRow) {
  const f = await custodyFacts(db, s.id);
  return { ...core(s), patientAge: age(s.dob), patientGender: s.gender, dispatch: f.dispatch, steps: f.steps, allowedActions: allowedActions('branch', s.status) };
}

/** Laboratory view: operational data only, no patient identity, age or gender. */
export async function labSampleView(db: Queryable, s: SampleRow) {
  const f = await custodyFacts(db, s.id);
  return { ...core(s), dispatch: f.dispatch, receipt: f.receipt, rejection: f.rejection, steps: f.steps, allowedActions: allowedActions('laboratory', s.status) };
}

export const STAFF_SAMPLE_KEYS = ['allowedActions', 'branch', 'collectedAt', 'dispatch', 'id', 'patientAge', 'patientGender', 'sampleId', 'sampleType', 'status', 'statusChangedAt', 'steps', 'trackingId'];
export const LAB_SAMPLE_KEYS = ['allowedActions', 'branch', 'collectedAt', 'dispatch', 'id', 'receipt', 'rejection', 'sampleId', 'sampleType', 'status', 'statusChangedAt', 'steps', 'trackingId'];

function invalid(code: string, message: string) {
  return new AppError(422, code, message);
}

/**
 * Records one custody step. Validates the actor's side and permission, branch assignment (branch
 * side), the matrix, the operator's expected status (conflicting double actions fail), required
 * handover data, and is idempotent per request key (a retried request returns the same result).
 */
export async function recordCustodyAction(deps: Deps, actor: SessionInfo, side: Side, input: ActionInput, meta: AuditMeta) {
  const rule = ACTIONS[input.action];
  if (!rule || rule.side !== side) throw invalid('ACTION_NOT_ALLOWED', 'This action is not available here.');
  const needed = side === 'branch' ? 'custody.record_branch' : 'custody.record_lab';
  if (!actor.permissions.has(needed)) throw Errors.forbidden();

  if (input.action === 'dispatch' && (!input.courier?.trim() || !input.shipmentTrackingNumber?.trim())) {
    throw invalid('DISPATCH_DETAILS_REQUIRED', 'Enter the courier company and the shipment tracking number.');
  }
  if (input.action === 'receive' && !input.condition) throw invalid('CONDITION_REQUIRED', 'Record the condition of the sample on receipt.');
  if (input.action === 'reject') {
    if (!input.reasonCategory) throw invalid('REJECTION_REASON_REQUIRED', 'Choose a rejection reason.');
    if (input.reasonCategory === 'other' && !input.remarks?.trim()) throw invalid('REMARKS_REQUIRED', 'Describe the reason when choosing "Other".');
  }
  if (input.action === 'report_available' && input.reportDeliveryConfirmed !== true) {
    throw invalid('REPORT_CONFIRMATION_REQUIRED', 'Confirm that the report is available through the approved delivery process.');
  }

  const { sample: found, identifiedBy } = await resolveSample(deps.db, deps, input.code);
  if (side === 'branch') await assertBranchAccess(deps.db, actor, found, meta);

  try {
    return await withTx(deps.db, async (tx) => {
      await tx.query('SELECT 1 FROM registrations WHERE id = $1 FOR UPDATE', [found.registration_id]);
      const cur = (await tx.query<{ status: SampleStatus; branch_id: string }>('SELECT status, branch_id FROM samples WHERE id = $1 FOR UPDATE', [found.id])).rows[0]!;
      // Idempotent replay, checked AFTER taking the locks (a fresh statement sees a request with the
      // same key that committed while we waited): the same key returns the recorded result.
      const replay = await tx.query<{ to_status: SampleStatus }>('SELECT to_status FROM custody_events WHERE sample_id = $1 AND idempotency_key = $2', [found.id, input.idempotencyKey]);
      if (replay.rows[0]) return { replayed: true, status: replay.rows[0].to_status };
      if (cur.status !== input.expectedStatus) {
        throw new AppError(409, 'STATUS_CHANGED', 'This sample’s status has changed since you scanned it. Scan it again.', { currentStatus: cur.status });
      }
      if (!(rule.from as readonly string[]).includes(cur.status)) {
        throw new AppError(409, 'TRANSITION_NOT_ALLOWED', 'This action isn’t possible at the sample’s current stage.', { currentStatus: cur.status });
      }
      if (side === 'branch' && !(await assignedTo(tx, actor.userId, cur.branch_id))) throw new AppError(403, 'BRANCH_NOT_AUTHORIZED', 'You are no longer assigned to this branch.');

      const handover: Record<string, string> = {};
      if (input.action === 'dispatch') {
        handover.courier = input.courier!.trim().slice(0, 120);
        handover.shipmentTrackingNumber = input.shipmentTrackingNumber!.trim().slice(0, 120);
        handover.handedOverBy = 'collection_branch';
        handover.verification = 'dispatch_record_only'; // documented dispatch; transport custody is not independently verified
      }
      if (input.action === 'receive' || (input.action === 'reject' && (cur.status === 'dispatched' || cur.status === 'in_transit'))) {
        handover.receivedFrom = 'courier_or_branch_shipment';
        handover.verification = identifiedBy === 'sample_qr' ? 'label_scanned_on_receipt' : 'sample_id_entered_on_receipt';
      }
      const role = primaryRole(actor.roles) ?? 'unknown';
      const ev = await tx.query<{ id: string }>(
        `INSERT INTO custody_events (sample_id, registration_id, event_type, from_status, to_status, recorded_by, actor_role, location_type, branch_id,
                                     identified_by, handover, condition, reason_category, remarks, idempotency_key, request_id)
         VALUES ($1, $2, 'transition', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
        [found.id, found.registration_id, cur.status, rule.to, actor.userId, role, side === 'branch' ? 'branch' : 'laboratory',
          side === 'branch' ? cur.branch_id : null, identifiedBy, JSON.stringify(handover), input.condition ?? null,
          input.action === 'reject' ? input.reasonCategory : null, input.remarks?.trim().slice(0, 1000) || null, input.idempotencyKey, meta.requestId]);
      await applyStatus(tx, deps, found.id, found.registration_id, cur.status, rule.to, actor.userId, role, `custody: ${input.action}`);
      await audit(tx, {
        ...meta, action: `custody.${input.action}`, outcome: 'success', targetType: 'sample', targetId: found.id,
        metadata: { sampleId: found.sample_code, from: cur.status, to: rule.to, custodyEventId: Number(ev.rows[0]!.id), identifiedBy, reasonCategory: input.reasonCategory ?? null },
      });
      return { replayed: false, status: rule.to as SampleStatus };
    });
  } catch (err) {
    // Two simultaneous requests with the same key: the loser hits the idempotency index.
    if ((err as { code?: string }).code === '23505') {
      const again = await deps.db.query<{ to_status: SampleStatus }>('SELECT to_status FROM custody_events WHERE sample_id = $1 AND idempotency_key = $2', [found.id, input.idempotencyKey]);
      if (again.rows[0]) return { replayed: true, status: again.rows[0].to_status };
    }
    if (err instanceof AppError && err.status === 409) {
      await auditSafe(deps.db, { ...meta, action: 'custody.action_refused', outcome: 'failure', targetType: 'sample', targetId: found.id, metadata: { action: input.action, reason: err.code } });
    }
    throw err;
  }
}

/** Sample status + mirrored registration status + registration history + customer email. */
async function applyStatus(tx: Queryable, deps: Deps, sampleId: string, registrationId: string, from: SampleStatus | null, to: SampleStatus, actorId: string, role: string, reason: string) {
  await tx.query('UPDATE samples SET status = $2, status_changed_at = now() WHERE id = $1', [sampleId, to]);
  const reg = (await tx.query<{ status: string; tracking_id: string; email: string; locale: 'en' | 'ar'; account_user_id: string }>(
    `SELECT r.status, r.tracking_id, u.email, u.locale, r.account_user_id FROM registrations r JOIN users u ON u.id = r.account_user_id WHERE r.id = $1`, [registrationId])).rows[0]!;
  const next = registrationStatusFor(to);
  if (reg.status !== next) {
    await tx.query('UPDATE registrations SET status = $2 WHERE id = $1', [registrationId, next]);
    await tx.query(
      `INSERT INTO registration_status_history (registration_id, from_status, to_status, changed_by, actor_role, reason) VALUES ($1, $2, $3, $4, $5, $6)`,
      [registrationId, reg.status, next, actorId, role, reason.slice(0, 500)]);
  }
  const kind = to === 'received_by_laboratory' ? 'sample_received' : to === 'report_available' ? 'report_available' : null;
  if (kind && deps.config.customerStatusEmails && from !== to) {
    await enqueueEmail(tx, deps, {
      kind, locale: reg.locale, to: reg.email, userId: reg.account_user_id, registrationId, dedupeKey: `${kind}:${sampleId}`,
      data: { trackingId: reg.tracking_id, link: `${buildLink(deps.config.appOrigin, 'registration', reg.locale)}?id=${registrationId}` },
    });
  }
}

/** Initial custody: allocates TRC-SA-MM/YY-XXXXX-SXX inside the (registration-locked) collection transaction. */
export async function allocateSampleCode(tx: Queryable, registrationId: string, trackingId: string): Promise<{ seq: number; code: string }> {
  const { rows } = await tx.query<{ next: number }>('SELECT COALESCE(MAX(sample_seq), 0) + 1 AS next FROM samples WHERE registration_id = $1', [registrationId]);
  const seq = Number(rows[0]!.next);
  if (seq > 99) throw new AppError(409, 'SAMPLE_SEQUENCE_EXHAUSTED', 'No further physical samples can be recorded for this registration.');
  return { seq, code: `${trackingId}-S${String(seq).padStart(2, '0')}` };
}

export async function recordInitialCustody(tx: Queryable, sample: { id: string; registrationId: string; branchId: string }, staffId: string) {
  await tx.query(
    `INSERT INTO custody_events (sample_id, registration_id, event_type, from_status, to_status, recorded_by, actor_role, location_type, branch_id, identified_by)
     VALUES ($1, $2, 'transition', NULL, 'collected', $3, 'collection_staff', 'branch', $4, 'collection_session')`,
    [sample.id, sample.registrationId, staffId, sample.branchId]);
}

// ---- Labels ------------------------------------------------------------------------------
export const LABEL_SIZES = ['50x30', '50x25', '62x29'] as const;

/** Label content: brand, tracking ID, physical sample ID, sample type, collection date. Nothing personal. */
export function labelData(s: SampleRow) {
  const collectedOn = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(s.collected_at);
  return { id: s.id, sampleId: s.sample_code, trackingId: s.tracking_id, sampleType: 'hair' as const, collectedOn, status: s.status };
}
export const LABEL_KEYS = ['collectedOn', 'id', 'prints', 'sampleId', 'sampleType', 'sizes', 'status', 'trackingId'];

export async function labelPrints(db: Queryable, sampleId: string): Promise<number> {
  return Number((await db.query<{ n: string }>('SELECT count(*) AS n FROM sample_label_prints WHERE sample_id = $1', [sampleId])).rows[0]!.n);
}

/** Records a print. The first print needs no reason; every reprint does, and both are audited. */
export async function recordLabelPrint(deps: Deps, actor: SessionInfo, sampleId: string, input: { size: string; reason?: string }, meta: AuditMeta) {
  return withTx(deps.db, async (tx) => {
    await tx.query('SELECT 1 FROM samples WHERE id = $1 FOR UPDATE', [sampleId]);
    const prior = await labelPrints(tx, sampleId);
    const reprint = prior > 0;
    const reason = input.reason?.trim();
    if (reprint && (!reason || reason.length < 5)) throw new AppError(422, 'REPRINT_REASON_REQUIRED', 'Enter a reason for reprinting this label (at least 5 characters).');
    const role = primaryRole(actor.roles) ?? 'unknown';
    await tx.query('INSERT INTO sample_label_prints (sample_id, printed_by, actor_role, label_size, reprint, reason) VALUES ($1, $2, $3, $4, $5, $6)',
      [sampleId, actor.userId, role, input.size, reprint, reprint ? reason!.slice(0, 500) : null]);
    await audit(tx, { ...meta, action: reprint ? 'sample.label_reprinted' : 'sample.label_printed', outcome: 'success', targetType: 'sample', targetId: sampleId, metadata: { size: input.size, printNumber: prior + 1, reason: reprint ? reason : null } });
    return { printNumber: prior + 1, reprint };
  });
}

// ---- Administration: corrections and recollection -----------------------------------------
/** Appends a correcting event (never edits history). Sets the sample to the corrected status. */
export async function correctCustody(deps: Deps, actor: SessionInfo, sampleId: string, input: { eventId: number; toStatus: SampleStatus; reason: string }, meta: AuditMeta) {
  return withTx(deps.db, async (tx) => {
    const sample = await loadSample(tx, sampleId);
    if (!sample) throw Errors.notFound();
    await tx.query('SELECT 1 FROM registrations WHERE id = $1 FOR UPDATE', [sample.registration_id]);
    const cur = (await tx.query<{ status: SampleStatus }>('SELECT status FROM samples WHERE id = $1 FOR UPDATE', [sampleId])).rows[0]!;
    const target = (await tx.query<{ id: string }>('SELECT id FROM custody_events WHERE id = $1 AND sample_id = $2', [input.eventId, sampleId])).rows[0];
    if (!target) throw new AppError(422, 'EVENT_NOT_FOUND', 'Choose an event of this sample to correct.');
    const recollected = await tx.query('SELECT 1 FROM recollection_authorizations WHERE rejected_sample_id = $1', [sampleId]);
    if (recollected.rowCount && input.toStatus !== 'rejected') throw new AppError(409, 'RECOLLECTION_EXISTS', 'A recollection was already authorised for this rejected sample; its status can’t be reopened.');
    const role = primaryRole(actor.roles) ?? 'unknown';
    await tx.query(
      `INSERT INTO custody_events (sample_id, registration_id, event_type, from_status, to_status, recorded_by, actor_role, location_type, identified_by, remarks, corrects_event_id, reason_category, request_id)
       VALUES ($1, $2, 'correction', $3, $4, $5, $6, 'administration', 'admin_record', $7, $8, $9, $10)`,
      [sampleId, sample.registration_id, cur.status, input.toStatus, actor.userId, role, input.reason.slice(0, 1000), input.eventId, input.toStatus === 'rejected' ? 'other' : null, meta.requestId]);
    await applyStatus(tx, deps, sampleId, sample.registration_id, cur.status, input.toStatus, actor.userId, role, `custody correction: ${input.reason}`);
    await audit(tx, { ...meta, action: 'custody.corrected', outcome: 'success', targetType: 'sample', targetId: sampleId, metadata: { correctsEventId: input.eventId, from: cur.status, to: input.toStatus, reason: input.reason } });
  });
}

/**
 * Admin-authorised recollection after a rejected sample. Keeps the tracking ID and the rejected
 * sample; returns the registration to "awaiting sample collection" and issues a NEW customer QR
 * (a spent QR is never reactivated). The next collection goes through the full Phase 4 flow
 * (fresh scan, fresh identity verification, current instructions) and creates the next -SXX.
 */
export async function authorizeRecollection(deps: Deps, actor: SessionInfo, registrationId: string, reason: string, meta: AuditMeta) {
  return withTx(deps.db, async (tx) => {
    const reg = (await tx.query<{ status: string; tracking_id: string; email: string; locale: 'en' | 'ar'; account_user_id: string }>(
      `SELECT r.status, r.tracking_id, u.email, u.locale, r.account_user_id FROM registrations r JOIN users u ON u.id = r.account_user_id WHERE r.id = $1 FOR UPDATE OF r`, [registrationId])).rows[0];
    if (!reg) throw Errors.notFound();
    const latest = (await tx.query<{ id: string; status: string; sample_code: string }>(
      'SELECT id, status, sample_code FROM samples WHERE registration_id = $1 ORDER BY sample_seq DESC LIMIT 1 FOR UPDATE', [registrationId])).rows[0];
    if (!latest || latest.status !== 'rejected' || reg.status !== 'rejected') throw new AppError(409, 'RECOLLECTION_NOT_ALLOWED', 'A recollection can only be authorised after the current sample was rejected.');
    const already = await tx.query('SELECT 1 FROM recollection_authorizations WHERE rejected_sample_id = $1', [latest.id]);
    if (already.rowCount) throw new AppError(409, 'RECOLLECTION_EXISTS', 'A recollection was already authorised for this sample.');
    const role = primaryRole(actor.roles) ?? 'unknown';
    await tx.query('INSERT INTO recollection_authorizations (registration_id, rejected_sample_id, reason, authorized_by, actor_role) VALUES ($1, $2, $3, $4, $5)',
      [registrationId, latest.id, reason, actor.userId, role]);
    await tx.query(`UPDATE registrations SET status = 'awaiting_sample_collection' WHERE id = $1`, [registrationId]);
    await tx.query(
      `INSERT INTO registration_status_history (registration_id, from_status, to_status, changed_by, actor_role, reason) VALUES ($1, 'rejected', 'awaiting_sample_collection', $2, $3, $4)`,
      [registrationId, actor.userId, role, `recollection authorised: ${reason}`.slice(0, 500)]);
    await tx.query(`UPDATE customer_qr_tokens SET status = 'revoked', revoked_at = now(), revoked_by = $2, revoke_reason = 'superseded by recollection QR' WHERE registration_id = $1 AND status = 'active'`, [registrationId, actor.userId]);
    await issueCustomerQr(tx, deps, registrationId, actor.userId);
    await enqueueEmail(tx, deps, { kind: 'registration_qr_resend', locale: reg.locale, to: reg.email, userId: reg.account_user_id, registrationId, dedupeKey: `recollection_qr:${latest.id}` });
    if (deps.config.customerStatusEmails) {
      await enqueueEmail(tx, deps, {
        kind: 'recollection_required', locale: reg.locale, to: reg.email, userId: reg.account_user_id, registrationId, dedupeKey: `recollection_required:${latest.id}`,
        data: { trackingId: reg.tracking_id, link: `${buildLink(deps.config.appOrigin, 'registration', reg.locale)}?id=${registrationId}` },
      });
    }
    await audit(tx, { ...meta, action: 'custody.recollection_authorized', outcome: 'success', targetType: 'registration', targetId: registrationId, metadata: { rejectedSampleId: latest.sample_code, reason } });
    return { trackingId: reg.tracking_id, rejectedSampleId: latest.sample_code };
  });
}

/** Customer timeline (own registration only, enforced by the caller). Dates only, no internals. */
export async function customerTimeline(db: Queryable, registrationId: string, createdAt: Date) {
  const { rows } = await db.query<{ to_status: string; occurred_at: Date; sample_code: string }>(
    `SELECT e.to_status, e.occurred_at, s.sample_code FROM custody_events e JOIN samples s ON s.id = e.sample_id
      WHERE e.registration_id = $1 ORDER BY e.id`, [registrationId]);
  const recollections = await db.query<{ created_at: Date }>('SELECT created_at FROM recollection_authorizations WHERE registration_id = $1 ORDER BY id', [registrationId]);
  const map: Record<string, string> = {
    collected: 'sample_collected', dispatched: 'sample_dispatched', received_by_laboratory: 'received_by_laboratory',
    analysis_in_progress: 'analysis_in_progress', analysis_completed: 'analysis_completed', report_available: 'report_available', rejected: 'sample_issue',
  };
  const steps: { step: string; at: string }[] = [{ step: 'registration_completed', at: createdAt.toISOString() }];
  for (const r of rows) {
    const step = map[r.to_status];
    if (step) steps.push({ step, at: r.occurred_at.toISOString() });
  }
  for (const r of recollections.rows) steps.push({ step: 'recollection_required', at: r.created_at.toISOString() });
  steps.sort((a, b) => a.at.localeCompare(b.at));
  return steps;
}

export const newIdempotencyKey = () => randomUUID();
