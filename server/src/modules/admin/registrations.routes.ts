import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { actorFrom, type AppContext, type AppEnv, type Deps } from '../../context.ts';
import { withTx, type Queryable } from '../../db/pool.ts';
import { decrypt } from '../../lib/crypto.ts';
import { AppError, Errors } from '../../lib/errors.ts';
import { check, parseBody } from '../../lib/validate.ts';
import { enforceRateLimit } from '../../middleware/rate-limit.ts';
import { requirePermission } from '../../middleware/rbac.ts';
import { audit } from '../audit/audit.service.ts';
import { buildLink } from '../auth/links.ts';
import { revokeAllSessions } from '../auth/sessions.ts';
import { issueToken } from '../auth/tokens.ts';
import { enqueueEmail, kickOutbox } from '../mail/outbox.ts';
import { registrationBody } from '../registrations/me.routes.ts';
import { listActiveBranches } from '../registrations/registrations.repo.ts';
import { applyPatientCorrection } from '../registrations/registrations.service.ts';
import { ageParts, normaliseSaudiMobile, riyadhToday, toAsciiDigits } from '../registrations/rules.ts';
import { dateParam, has, idParam, isOpen, reasonField, searchTermHash, uuid } from './common.ts';

const STATUSES = ['registration_completed', 'awaiting_sample_collection', 'sample_collected', 'sample_packaged', 'ready_for_dispatch',
  'dispatched', 'in_transit', 'received_by_laboratory', 'analysis_in_progress', 'analysis_completed', 'report_available', 'rejected', 'cancelled'] as const;
const TRACKING_RE = /^TRC-SA-(0[1-9]|1[0-2])\/\d{2}-\d{5}$/i;

const listQuery = z.strictObject({
  q: z.string().trim().max(200).optional(),
  type: z.enum(['auto', 'name', 'email', 'phone', 'tracking']).default('auto'),
  status: z.enum(STATUSES).optional(),
  branchId: uuid.optional(),
  qrStatus: z.enum(['active', 'revoked', 'used', 'none']).optional(),
  from: dateParam.optional(),
  to: dateParam.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

type SearchType = 'name' | 'email' | 'phone' | 'tracking';
function detectType(q: string): SearchType {
  if (TRACKING_RE.test(q)) return 'tracking';
  if (q.includes('@')) return 'email';
  if (/^[+\d\s\-().٠-٩۰-۹]{4,}$/.test(q)) return 'phone';
  return 'name';
}
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

function encodeCursor(createdAt: Date, id: string) {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}
function decodeCursor(cursor: string): [string, string] {
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!at || !id || Number.isNaN(Date.parse(at)) || !uuid.safeParse(id).success) throw new AppError(422, 'VALIDATION_FAILED', 'Invalid cursor.', { fields: [{ path: 'cursor', code: 'invalid' }] });
  return [at, id];
}

const age = (dob: string) => {
  const a = ageParts(dob, riyadhToday());
  return a ? { years: a.years, months: a.months } : null;
};
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const branchOut = (b: Record<string, any>, prefix = '') => ({
  id: b[`${prefix}id`], code: b[`${prefix}code`], nameEn: b[`${prefix}name_en`], nameAr: b[`${prefix}name_ar`], cityEn: b[`${prefix}city_en`], cityAr: b[`${prefix}city_ar`],
});

/** Locks an open registration (registration row first: the project-wide lock order). */
async function lockRegistration(tx: Queryable, id: string) {
  const { rows } = await tx.query<{ id: string; status: string; branch_id: string; tracking_id: string; patient_id: string; account_user_id: string; email: string; locale: 'en' | 'ar' }>(
    `SELECT r.id, r.status, r.branch_id, r.tracking_id, r.patient_id, r.account_user_id, u.email, u.locale
       FROM registrations r JOIN users u ON u.id = r.account_user_id WHERE r.id = $1 FOR UPDATE OF r`, [id]);
  if (!rows[0]) throw Errors.notFound();
  return rows[0];
}
const notOpen = () => new AppError(409, 'REGISTRATION_NOT_OPEN', 'This registration is no longer awaiting collection, so it can’t be changed here.');

/** Stops every open collection session: staff must scan again (and re-verify identity). */
async function closeOpenSessions(tx: Queryable, registrationId: string): Promise<number> {
  const r = await tx.query(`UPDATE collection_sessions SET expires_at = now() WHERE registration_id = $1 AND completed_at IS NULL AND expires_at > now()`, [registrationId]);
  return r.rowCount ?? 0;
}

/** Full registration record for authorised administrators. Explicit field list. */
export async function adminRegistrationDetail(deps: Deps, id: string) {
  const { db } = deps;
  const { rows } = await db.query(
    `SELECT r.id, r.tracking_id, r.status, r.created_at, r.updated_at, r.cancelled_at, r.product, r.sample_type, r.collection_country,
            r.patient_age_months_at_registration, r.contact_full_name, r.contact_email, r.contact_phone,
            p.id AS patient_id, p.first_name, p.last_name, to_char(p.date_of_birth, 'YYYY-MM-DD') AS dob, p.gender, p.relationship,
            u.id AS user_id, u.full_name AS user_name, u.email AS user_email, u.phone AS user_phone, u.email_verified_at, u.status AS user_status,
            u.status_reason, u.locked_until, u.last_login_at, u.created_at AS user_created_at, u.adult_confirmed_at,
            b.id, b.code, b.name_en, b.name_ar, b.city_en, b.city_ar, b.address_en, b.address_ar, b.active AS branch_active,
            r.id AS reg_id
       FROM registrations r JOIN patients p ON p.id = r.patient_id JOIN users u ON u.id = r.account_user_id
       JOIN collection_branches b ON b.id = r.branch_id
      WHERE r.id = $1`, [id]);
  const r = rows[0];
  if (!r) return null;

  const [consents, history, transfers, tokens, sample, idv, revisions, emails] = await Promise.all([
    db.query(`SELECT d.doc_type, d.version, d.title, d.locale, d.status, c.accepted_at FROM consent_records c JOIN consent_documents d ON d.id = c.consent_document_id
               WHERE c.registration_id = $1 ORDER BY c.accepted_at, d.doc_type`, [id]),
    db.query(`SELECT from_status, to_status, actor_role, reason, created_at FROM registration_status_history WHERE registration_id = $1 ORDER BY id`, [id]),
    db.query(`SELECT t.reason, t.created_at, t.actor_role, u.email AS actor_email, fb.code AS from_code, fb.name_en AS from_en, fb.name_ar AS from_ar,
                     tb.code AS to_code, tb.name_en AS to_en, tb.name_ar AS to_ar
                FROM registration_branch_transfers t JOIN users u ON u.id = t.transferred_by
                JOIN collection_branches fb ON fb.id = t.from_branch_id JOIN collection_branches tb ON tb.id = t.to_branch_id
               WHERE t.registration_id = $1 ORDER BY t.id`, [id]),
    db.query(`SELECT q.status, q.created_at, q.revoked_at, q.revoke_reason, q.used_at, q.last_validated_at, cu.email AS created_by_email, ru.email AS revoked_by_email
                FROM customer_qr_tokens q LEFT JOIN users cu ON cu.id = q.created_by LEFT JOIN users ru ON ru.id = q.revoked_by
               WHERE q.registration_id = $1 ORDER BY q.created_at`, [id]),
    db.query(`SELECT s.status, s.collected_at, s.sample_code, b.code, b.name_en, b.name_ar, u.email AS staff_email, u.full_name AS staff_name,
                     ci.version AS instructions_version, ci.status AS instructions_status, v.method, v.status AS idv_status
                FROM samples s JOIN collection_branches b ON b.id = s.branch_id JOIN users u ON u.id = s.collected_by
                JOIN collection_instructions ci ON ci.id = s.instructions_id JOIN identity_verifications v ON v.id = s.identity_verification_id
               WHERE s.registration_id = $1 ORDER BY s.collected_at`, [id]),
    db.query(`SELECT v.status, v.method, v.created_at, u.email AS staff_email FROM identity_verifications v LEFT JOIN users u ON u.id = v.performed_by
               WHERE v.registration_id = $1 ORDER BY v.id`, [id]),
    db.query(`SELECT pr.changed_fields, pr.previous_enc, pr.actor_role, pr.reason, pr.created_at, pr.registration_id, u.email AS actor_email
                FROM patient_revisions pr LEFT JOIN users u ON u.id = pr.changed_by WHERE pr.patient_id = $1 ORDER BY pr.id`, [r.patient_id]),
    db.query(`SELECT id, kind, status, attempts, sent_at, created_at FROM email_outbox WHERE registration_id = $1 ORDER BY created_at DESC LIMIT 20`, [id]),
  ]);
  const activeQr = tokens.rows.find((q) => q.status === 'active');
  const lastQr = tokens.rows.at(-1);
  const open = isOpen(r.status);
  return {
    id: r.reg_id,
    trackingId: r.tracking_id,
    status: r.status,
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), cancelledAt: iso(r.cancelled_at),
    product: r.product, sampleType: r.sample_type, collectionCountry: r.collection_country,
    patientAgeMonthsAtRegistration: r.patient_age_months_at_registration,
    branch: { ...branchOut(r), addressEn: r.address_en, addressAr: r.address_ar, active: r.branch_active },
    patient: { id: r.patient_id, firstName: r.first_name, lastName: r.last_name, dateOfBirth: r.dob, age: age(r.dob), gender: r.gender, relationship: r.relationship },
    guardian: r.relationship === 'self' ? null : { relationship: r.relationship, name: r.contact_full_name, accountUserId: r.user_id },
    contact: { fullName: r.contact_full_name, email: r.contact_email, phone: r.contact_phone },
    accountHolder: {
      id: r.user_id, fullName: r.user_name, email: r.user_email, phone: r.user_phone, emailVerified: r.email_verified_at !== null,
      status: r.user_status, statusReason: r.status_reason, lockedUntil: iso(r.locked_until), lastLoginAt: iso(r.last_login_at),
      createdAt: iso(r.user_created_at), adultConfirmedAt: iso(r.adult_confirmed_at),
    },
    consents: consents.rows.map((x) => ({ type: x.doc_type, version: x.version, title: x.title, locale: x.locale, provisional: x.status !== 'approved', acceptedAt: iso(x.accepted_at) })),
    statusHistory: history.rows.map((x) => ({ from: x.from_status, to: x.to_status, actorRole: x.actor_role, reason: x.reason, at: iso(x.created_at) })),
    branchTransfers: transfers.rows.map((x) => ({
      from: { code: x.from_code, nameEn: x.from_en, nameAr: x.from_ar }, to: { code: x.to_code, nameEn: x.to_en, nameAr: x.to_ar },
      reason: x.reason, actorRole: x.actor_role, actorEmail: x.actor_email, at: iso(x.created_at),
    })),
    qr: {
      status: activeQr ? 'active' : lastQr ? lastQr.status : 'none',
      history: tokens.rows.map((q) => ({
        status: q.status, issuedAt: iso(q.created_at), issuedBy: q.created_by_email ?? null, revokedAt: iso(q.revoked_at), revokedBy: q.revoked_by_email ?? null,
        revokeReason: q.revoke_reason, usedAt: iso(q.used_at), lastValidatedAt: iso(q.last_validated_at),
      })),
    },
    collection: sample.rows.map((s) => ({
      status: s.status, collectedAt: iso(s.collected_at), sampleCode: s.sample_code, branch: { code: s.code, nameEn: s.name_en, nameAr: s.name_ar },
      collectedBy: { email: s.staff_email, name: s.staff_name }, instructionsVersion: s.instructions_version, instructionsProvisional: s.instructions_status !== 'approved',
      identityVerification: { method: s.method, status: s.idv_status },
    })),
    identityVerifications: idv.rows.map((v) => ({ status: v.status, method: v.method, at: iso(v.created_at), performedBy: v.staff_email })),
    patientCorrections: revisions.rows.map((x) => {
      let previous: Record<string, string> | null = null;
      try {
        previous = JSON.parse(decrypt(deps.config.dataEncryptionKey, x.previous_enc, `patient_revisions:${r.patient_id}`));
      } catch {
        previous = null; // unreadable (e.g. key rotation): show that a change happened, not values
      }
      return { changedFields: x.changed_fields, previous, reason: x.reason, actorRole: x.actor_role, actorEmail: x.actor_email, registrationId: x.registration_id, at: iso(x.created_at) };
    }),
    emails: emails.rows.map((e) => ({ id: e.id, kind: e.kind, status: e.status, attempts: e.attempts, sentAt: iso(e.sent_at), createdAt: iso(e.created_at) })),
    allowed: { transfer: open, cancel: open, correctPatient: open, qr: open },
  };
}

export const FULL_FIELDS = ['patient.name', 'patient.date_of_birth', 'patient.gender', 'contact.email', 'contact.phone', 'account.email', 'account.phone', 'patient_revisions.previous'];

export function adminRegistrationRoutes(deps: Deps) {
  const { db, config } = deps;
  const r = new Hono<AppEnv>();
  const read = requirePermission(deps, 'registration.read_full');
  const manage = requirePermission(deps, 'registration.read_full', 'registration.manage');
  const actor = (c: AppContext) => c.get('session')!;

  // ---- Search / list ---------------------------------------------------------------------
  r.get('/registrations', read, async (c) => {
    const q = check(listQuery, c.req.query());
    const s = actor(c);
    await enforceRateLimit(db, { key: `admin_search:user:${s.userId}`, limit: 300, windowSeconds: 3600 });
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, ...values: unknown[]) => {
      let out = sql;
      for (const v of values) {
        params.push(v);
        out = out.replace('?', `$${params.length}`);
      }
      where.push(out);
    };
    let searchType: SearchType | null = null;
    if (q.q) {
      searchType = q.type === 'auto' ? detectType(q.q) : q.type;
      if (searchType === 'tracking') add('upper(r.tracking_id) = upper(?)', q.q);
      else if (searchType === 'email') {
        if (q.q.length < 3) throw new AppError(422, 'SEARCH_TOO_SHORT', 'Enter at least 3 characters.');
        const like = `%${likeEscape(q.q.toLowerCase())}%`;
        add('(r.contact_email LIKE ? OR u.email LIKE ?)', like, like);
      } else if (searchType === 'phone') {
        const full = normaliseSaudiMobile(q.q);
        const digits = toAsciiDigits(q.q).replace(/\D/g, '');
        if (full) add('(r.contact_phone = ? OR u.phone = ?)', full, full);
        else if (digits.length >= 4) add('(r.contact_phone LIKE ? OR u.phone LIKE ?)', `%${digits}%`, `%${digits}%`);
        else throw new AppError(422, 'SEARCH_TOO_SHORT', 'Enter at least 4 digits.');
      } else {
        if (q.q.length < 2) throw new AppError(422, 'SEARCH_TOO_SHORT', 'Enter at least 2 characters.');
        const like = `%${likeEscape(q.q.normalize('NFC'))}%`;
        add(`(p.first_name ILIKE ? OR p.last_name ILIKE ? OR (p.first_name || ' ' || p.last_name) ILIKE ? OR r.contact_full_name ILIKE ? OR u.full_name ILIKE ?)`, like, like, like, like, like);
      }
    }
    if (q.status) add('r.status = ?', q.status);
    if (q.branchId) add('r.branch_id = ?', q.branchId);
    if (q.from) add(`(r.created_at AT TIME ZONE 'Asia/Riyadh')::date >= ?::date`, q.from);
    if (q.to) add(`(r.created_at AT TIME ZONE 'Asia/Riyadh')::date <= ?::date`, q.to);
    if (q.qrStatus === 'none') where.push(`NOT EXISTS (SELECT 1 FROM customer_qr_tokens q WHERE q.registration_id = r.id)`);
    else if (q.qrStatus === 'active') where.push(`EXISTS (SELECT 1 FROM customer_qr_tokens q WHERE q.registration_id = r.id AND q.status = 'active')`);
    else if (q.qrStatus) add(`NOT EXISTS (SELECT 1 FROM customer_qr_tokens q WHERE q.registration_id = r.id AND q.status = 'active')
                              AND (SELECT q.status FROM customer_qr_tokens q WHERE q.registration_id = r.id ORDER BY q.created_at DESC LIMIT 1) = ?`, q.qrStatus);
    if (q.cursor) {
      const [at, id] = decodeCursor(q.cursor);
      add('(r.created_at, r.id) < (?::timestamptz, ?::uuid)', at, id);
    }
    params.push(q.limit + 1);
    const { rows } = await db.query(
      `SELECT r.id, r.tracking_id, r.status, r.created_at, r.contact_full_name, p.first_name, p.last_name, p.gender, p.relationship,
              to_char(p.date_of_birth, 'YYYY-MM-DD') AS dob, b.id AS b_id, b.code AS b_code, b.name_en AS b_name_en, b.name_ar AS b_name_ar,
              b.city_en AS b_city_en, b.city_ar AS b_city_ar,
              (SELECT q.status FROM customer_qr_tokens q WHERE q.registration_id = r.id ORDER BY (q.status = 'active') DESC, q.created_at DESC LIMIT 1) AS qr_status
         FROM registrations r JOIN patients p ON p.id = r.patient_id JOIN users u ON u.id = r.account_user_id JOIN collection_branches b ON b.id = r.branch_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY r.created_at DESC, r.id DESC LIMIT $${params.length}`,
      params,
    );
    const page = rows.slice(0, q.limit);
    await audit(db, {
      ...actorFrom(c), action: 'registration.searched', outcome: 'success', targetType: 'registrations',
      fieldsAccessed: ['patient.name', 'contact.name'],
      metadata: {
        searchType, termHash: q.q ? searchTermHash(deps, q.q) : null, returned: page.length,
        filters: { status: q.status ?? null, branchId: q.branchId ?? null, qrStatus: q.qrStatus ?? null, from: q.from ?? null, to: q.to ?? null, paged: Boolean(q.cursor) },
      },
    });
    return c.json({
      items: page.map((x) => ({
        id: x.id, trackingId: x.tracking_id, status: x.status, createdAt: iso(x.created_at), qrStatus: x.qr_status ?? 'none',
        patient: { firstName: x.first_name, lastName: x.last_name, gender: x.gender, relationship: x.relationship, age: age(x.dob) },
        contactName: x.contact_full_name, branch: branchOut(x, 'b_'),
      })),
      nextCursor: rows.length > q.limit ? encodeCursor(page.at(-1)!.created_at, page.at(-1)!.id) : null,
    });
  });

  // ---- Full detail (audited) ---------------------------------------------------------------
  r.get('/registrations/:id', read, async (c) => {
    const id = idParam(c);
    await enforceRateLimit(db, { key: `admin_view:user:${actor(c).userId}`, limit: 600, windowSeconds: 3600 });
    const detail = await adminRegistrationDetail(deps, id);
    if (!detail) throw Errors.notFound();
    await audit(db, { ...actorFrom(c), action: 'registration.viewed_full', outcome: 'success', targetType: 'registration', targetId: id, fieldsAccessed: FULL_FIELDS });
    const s = actor(c);
    const manage = has(s, 'registration.manage');
    return c.json({
      registration: detail,
      permissions: { manage, qr: has(s, 'qr.revoke') },
      activeBranches: manage ? await listActiveBranches(db) : [],
    });
  });

  // ---- Branch transfer (before collection) -------------------------------------------------
  r.post('/registrations/:id/transfer', manage, async (c) => {
    const id = idParam(c);
    const body = await parseBody(c, z.strictObject({ branchId: uuid, reason: reasonField, notifyCustomer: z.boolean().default(true) }));
    const s = actor(c);
    await enforceRateLimit(db, { key: `admin_transfer:user:${s.userId}`, limit: 60, windowSeconds: 3600 });
    const meta = actorFrom(c);
    const result = await withTx(db, async (tx) => {
      const reg = await lockRegistration(tx, id);
      if (!isOpen(reg.status)) throw notOpen();
      if (reg.branch_id === body.branchId) throw new AppError(409, 'SAME_BRANCH', 'The registration is already at this branch.');
      const target = (await tx.query<{ id: string; name_en: string; name_ar: string; city_en: string; city_ar: string; address_en: string; address_ar: string }>(
        'SELECT id, name_en, name_ar, city_en, city_ar, address_en, address_ar FROM collection_branches WHERE id = $1 AND active FOR SHARE', [body.branchId])).rows[0];
      if (!target) throw new AppError(422, 'BRANCH_INACTIVE', 'Choose an active collection branch.');
      await tx.query('UPDATE registrations SET branch_id = $2 WHERE id = $1', [id, body.branchId]);
      await tx.query(
        `INSERT INTO registration_branch_transfers (registration_id, from_branch_id, to_branch_id, reason, transferred_by, actor_role) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, reg.branch_id, body.branchId, body.reason, s.userId, meta.actorRole]);
      const sessionsClosed = await closeOpenSessions(tx, id);
      if (body.notifyCustomer) {
        const ar = reg.locale === 'ar';
        await enqueueEmail(tx, deps, {
          kind: 'registration_branch_changed', locale: reg.locale, to: reg.email, userId: reg.account_user_id, registrationId: id,
          dedupeKey: `registration_branch_changed:${id}:${randomUUID()}`,
          data: {
            trackingId: reg.tracking_id, branchName: ar ? target.name_ar : target.name_en, branchCity: ar ? target.city_ar : target.city_en,
            branchAddress: ar ? target.address_ar : target.address_en, link: `${buildLink(config.appOrigin, 'registration', reg.locale)}?id=${id}`,
          },
        });
      }
      await audit(tx, {
        ...meta, action: 'registration.branch_transferred', outcome: 'success', targetType: 'registration', targetId: id,
        metadata: { fromBranchId: reg.branch_id, toBranchId: body.branchId, reason: body.reason, sessionsClosed, notified: body.notifyCustomer },
      });
      return { trackingId: reg.tracking_id, sessionsClosed };
    });
    void kickOutbox(deps);
    return c.json({ status: 'transferred', ...result, registration: await adminRegistrationDetail(deps, id) });
  });

  // ---- Cancellation (before collection; tracking ID is never reused) -----------------------
  r.post('/registrations/:id/cancel', manage, async (c) => {
    const id = idParam(c);
    const body = await parseBody(c, z.strictObject({ reason: reasonField }));
    const s = actor(c);
    await enforceRateLimit(db, { key: `admin_cancel:user:${s.userId}`, limit: 30, windowSeconds: 3600 });
    const meta = actorFrom(c);
    await withTx(db, async (tx) => {
      const reg = await lockRegistration(tx, id);
      if (!isOpen(reg.status)) throw notOpen();
      await tx.query(`UPDATE registrations SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [id]);
      await tx.query(
        `INSERT INTO registration_status_history (registration_id, from_status, to_status, changed_by, actor_role, reason) VALUES ($1, $2, 'cancelled', $3, $4, $5)`,
        [id, reg.status, s.userId, meta.actorRole, body.reason]);
      const qr = await tx.query(
        `UPDATE customer_qr_tokens SET status = 'revoked', revoked_at = now(), revoked_by = $2, revoke_reason = 'registration cancelled'
          WHERE registration_id = $1 AND status = 'active'`, [id, s.userId]);
      const sessionsClosed = await closeOpenSessions(tx, id);
      await audit(tx, {
        ...meta, action: 'registration.cancelled', outcome: 'success', targetType: 'registration', targetId: id,
        metadata: { reason: body.reason, fromStatus: reg.status, qrRevoked: Boolean(qr.rowCount), sessionsClosed },
      });
    });
    return c.json({ status: 'cancelled', registration: await adminRegistrationDetail(deps, id) });
  });

  // ---- Patient correction (before collection; previous values kept encrypted) --------------
  r.patch('/registrations/:id/patient', manage, async (c) => {
    const id = idParam(c);
    const body = await parseBody(c, z.strictObject({ patient: registrationBody.shape.patient, reason: reasonField }));
    const s = actor(c);
    await enforceRateLimit(db, { key: `admin_correct:user:${s.userId}`, limit: 60, windowSeconds: 3600 });
    const meta = actorFrom(c);
    const changed = await withTx(db, async (tx) => {
      const reg = await lockRegistration(tx, id);
      if (!isOpen(reg.status)) throw new AppError(409, 'PATIENT_LOCKED', 'Patient details can’t be changed after collection or cancellation.');
      const { rows } = await tx.query(
        `SELECT id, relationship, first_name, last_name, to_char(date_of_birth, 'YYYY-MM-DD') AS date_of_birth, gender FROM patients WHERE id = $1 FOR UPDATE`, [reg.patient_id]);
      const fields = await applyPatientCorrection(tx, deps, rows[0], body.patient, { meta, registrationId: id, reason: `admin: ${body.reason}` });
      if (!fields.length) throw new AppError(422, 'NO_CHANGES', 'Nothing was changed.');
      // Identity verification is bound to the patient version, so it is already stale; also close
      // open sessions so staff start again from a fresh scan.
      const sessionsClosed = await closeOpenSessions(tx, id);
      await audit(tx, { ...meta, action: 'registration.patient_corrected_by_admin', outcome: 'success', targetType: 'registration', targetId: id, fieldsAccessed: fields, metadata: { reason: body.reason, sessionsClosed } });
      return fields;
    });
    return c.json({ changed, registration: await adminRegistrationDetail(deps, id) });
  });

  // ---- QR email resend (authorised replacement emails go through the existing revoke API) ---
  r.post('/registrations/:id/qr/resend-email', requirePermission(deps, 'qr.revoke'), async (c) => {
    const id = idParam(c);
    const body = await parseBody(c, z.strictObject({ reason: reasonField }));
    await enforceRateLimit(db, { key: `admin_qr_resend:registration:${id}`, limit: 3, windowSeconds: 3600 });
    const meta = actorFrom(c);
    await withTx(db, async (tx) => {
      const reg = await lockRegistration(tx, id);
      const active = await tx.query(`SELECT 1 FROM customer_qr_tokens WHERE registration_id = $1 AND status = 'active'`, [id]);
      if (!isOpen(reg.status) || !active.rowCount) throw new AppError(409, 'QR_NOT_AVAILABLE', 'There is no active QR code for this registration.');
      await enqueueEmail(tx, deps, {
        kind: 'registration_qr_resend', locale: reg.locale, to: reg.email, userId: reg.account_user_id, registrationId: id,
        dedupeKey: `registration_qr_resend:${id}:${randomUUID()}`,
      });
      await audit(tx, { ...meta, action: 'registration.email_resent', outcome: 'success', targetType: 'registration', targetId: id, metadata: { reason: body.reason, by: 'admin' } });
    });
    void kickOutbox(deps);
    return c.json({ status: 'email_queued' }, 202);
  });

  // ---- Customer accounts -------------------------------------------------------------------
  const customerOnly = async (tx: Queryable, userId: string, lock = false) => {
    const { rows } = await tx.query<{ id: string; email: string; locale: 'en' | 'ar'; status: string; email_verified_at: Date | null; roles: string[] }>(
      `SELECT u.id, u.email, u.locale, u.status, u.email_verified_at,
              COALESCE(array_agg(ur.role_key) FILTER (WHERE ur.role_key IS NOT NULL), '{}') AS roles
         FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id WHERE u.id = $1 GROUP BY u.id`, [userId]);
    const u = rows[0];
    if (!u || u.roles.length !== 1 || u.roles[0] !== 'customer') throw Errors.notFound();
    if (lock) await tx.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
    return u;
  };

  const customerView = async (userId: string) => {
    const { rows } = await db.query(
      `SELECT id, email, full_name, phone, locale, status, status_reason, status_changed_at, email_verified_at, locked_until, failed_login_count,
              last_login_at, created_at, adult_confirmed_at,
              (SELECT count(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS active_sessions
         FROM users u WHERE id = $1`, [userId]);
    const u = rows[0]!;
    const regs = await db.query(
      `SELECT r.id, r.tracking_id, r.status, r.created_at, p.first_name, p.last_name, p.relationship, b.code, b.name_en, b.name_ar
         FROM registrations r JOIN patients p ON p.id = r.patient_id JOIN collection_branches b ON b.id = r.branch_id
        WHERE r.account_user_id = $1 ORDER BY r.created_at DESC LIMIT 200`, [userId]);
    return {
      id: u.id, email: u.email, fullName: u.full_name, phone: u.phone, locale: u.locale, status: u.status, statusReason: u.status_reason,
      statusChangedAt: iso(u.status_changed_at), emailVerified: u.email_verified_at !== null, lockedUntil: iso(u.locked_until),
      temporarilyLocked: u.locked_until !== null && u.locked_until > new Date(), failedSignIns: u.failed_login_count,
      lastLoginAt: iso(u.last_login_at), createdAt: iso(u.created_at), adultConfirmedAt: iso(u.adult_confirmed_at), activeSessions: Number(u.active_sessions),
      registrations: regs.rows.map((x) => ({
        id: x.id, trackingId: x.tracking_id, status: x.status, createdAt: iso(x.created_at),
        patient: { firstName: x.first_name, lastName: x.last_name, relationship: x.relationship }, branch: { code: x.code, nameEn: x.name_en, nameAr: x.name_ar },
      })),
    };
  };

  r.get('/customers/:id', read, async (c) => {
    const id = idParam(c);
    await customerOnly(db, id);
    await enforceRateLimit(db, { key: `admin_view:user:${actor(c).userId}`, limit: 600, windowSeconds: 3600 });
    const view = await customerView(id);
    await audit(db, { ...actorFrom(c), action: 'customer.viewed_full', outcome: 'success', targetType: 'user', targetId: id, fieldsAccessed: ['account.email', 'account.phone', 'account.name', 'patient.name'] });
    return c.json({ customer: view, permissions: { manage: has(actor(c), 'registration.manage') } });
  });

  r.post('/customers/:id/lock', manage, async (c) => {
    const id = idParam(c);
    const body = await parseBody(c, z.strictObject({ reason: reasonField }));
    const s = actor(c);
    await enforceRateLimit(db, { key: `admin_customer_status:user:${s.userId}`, limit: 60, windowSeconds: 3600 });
    const meta = actorFrom(c);
    await withTx(db, async (tx) => {
      const u = await customerOnly(tx, id, true);
      if (u.status !== 'active') throw new AppError(409, 'ACCOUNT_NOT_ACTIVE', 'This account is not active.');
      await tx.query(`UPDATE users SET status = 'suspended', status_reason = $2, status_changed_at = now(), status_changed_by = $3 WHERE id = $1`, [id, body.reason.slice(0, 200), s.userId]);
      const sessionsRevoked = await revokeAllSessions(tx, id, 'locked_by_admin');
      await audit(tx, { ...meta, action: 'customer.locked', outcome: 'success', targetType: 'user', targetId: id, metadata: { reason: body.reason, sessionsRevoked } });
    });
    return c.json({ status: 'locked', customer: await customerView(id) });
  });

  r.post('/customers/:id/unlock', manage, async (c) => {
    const id = idParam(c);
    const body = await parseBody(c, z.strictObject({ reason: reasonField }));
    const s = actor(c);
    await enforceRateLimit(db, { key: `admin_customer_status:user:${s.userId}`, limit: 60, windowSeconds: 3600 });
    const meta = actorFrom(c);
    await withTx(db, async (tx) => {
      const u = await customerOnly(tx, id, true);
      if (u.status === 'deactivated') throw new AppError(409, 'ACCOUNT_DEACTIVATED', 'Deactivated accounts can’t be unlocked.');
      const { rows } = await tx.query<{ temp: boolean }>('SELECT COALESCE(locked_until > now(), false) AS temp FROM users WHERE id = $1', [id]);
      if (u.status === 'active' && !rows[0]!.temp) throw new AppError(409, 'ACCOUNT_NOT_LOCKED', 'This account is not locked.');
      await tx.query(
        `UPDATE users SET status = 'active', status_reason = $2, status_changed_at = now(), status_changed_by = $3, locked_until = NULL, failed_login_count = 0 WHERE id = $1`,
        [id, body.reason.slice(0, 200), s.userId]);
      await audit(tx, { ...meta, action: 'customer.unlocked', outcome: 'success', targetType: 'user', targetId: id, metadata: { reason: body.reason, previousStatus: u.status, clearedTemporaryLock: rows[0]!.temp } });
    });
    return c.json({ status: 'unlocked', customer: await customerView(id) });
  });

  r.post('/customers/:id/resend-verification', manage, async (c) => {
    const id = idParam(c);
    await parseBody(c, z.strictObject({}));
    await enforceRateLimit(db, { key: `admin_resend_verify:customer:${id}`, limit: 3, windowSeconds: 3600 });
    const meta = actorFrom(c);
    await withTx(db, async (tx) => {
      const u = await customerOnly(tx, id, true);
      if (u.email_verified_at) throw new AppError(409, 'EMAIL_ALREADY_VERIFIED', 'This email address is already verified.');
      if (u.status !== 'active') throw new AppError(409, 'ACCOUNT_NOT_ACTIVE', 'This account is not active.');
      const token = await issueToken(tx, deps, id, 'verify_email', meta.actorUserId);
      await enqueueEmail(tx, deps, { kind: 'verify_email', locale: u.locale, to: u.email, userId: id, data: { link: buildLink(config.appOrigin, 'verify_email', u.locale, token) } });
      await audit(tx, { ...meta, action: 'customer.verification_resent', outcome: 'success', targetType: 'user', targetId: id });
    });
    void kickOutbox(deps);
    return c.json({ status: 'verification_sent' }, 202);
  });

  return r;
}

