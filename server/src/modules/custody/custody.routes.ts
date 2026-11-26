import { Hono } from 'hono';
import { z } from 'zod';
import { actorFrom, type AppContext, type AppEnv, type Deps } from '../../context.ts';
import { Errors } from '../../lib/errors.ts';
import { check, parseBody } from '../../lib/validate.ts';
import { enforceRateLimit } from '../../middleware/rate-limit.ts';
import { requirePermission } from '../../middleware/rbac.ts';
import { audit } from '../audit/audit.service.ts';
import { renderQrPng, renderQrSvg } from '../qr/qr.service.ts';
import {
  ACTIONS, assertBranchAccess, authorizeRecollection, correctCustody, labelData, labelPrints, LABEL_SIZES, labSampleView, loadSample,
  recordCustodyAction, recordLabelPrint, REJECTION_REASONS, resolveSample, SAMPLE_STATUSES, staffSampleView, type CustodyAction,
} from './custody.service.ts';
import { activeSampleToken, sampleQrUrl } from './sample-qr.ts';

const uuid = z.uuid();
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const idParam = (c: AppContext) => {
  const id = c.req.param('id');
  if (!id || !uuid.safeParse(id).success) throw Errors.notFound();
  return id;
};
const actionBody = z.strictObject({
  code: z.string().trim().min(1).max(300),
  action: z.enum(Object.keys(ACTIONS) as [CustodyAction, ...CustodyAction[]]),
  expectedStatus: z.enum(SAMPLE_STATUSES as [string, ...string[]]),
  idempotencyKey: uuid,
  courier: z.string().trim().max(120).optional(),
  shipmentTrackingNumber: z.string().trim().max(120).optional(),
  condition: z.enum(['intact', 'damaged']).optional(),
  reasonCategory: z.enum(REJECTION_REASONS).optional(),
  remarks: z.string().trim().max(1000).optional(),
  reportDeliveryConfirmed: z.boolean().optional(),
});
const scanBody = z.strictObject({ code: z.string().trim().min(1).max(300) });

/** Label QR image + label data + print recording, shared by staff (own branches) and admins. */
function labelRoutes(r: Hono<AppEnv>, deps: Deps, guard: ReturnType<typeof requirePermission>, branchScoped: boolean) {
  const sampleFor = async (c: AppContext) => {
    const s = await loadSample(deps.db, idParam(c));
    if (!s) throw Errors.notFound();
    if (branchScoped) await assertBranchAccess(deps.db, c.get('session')!, s, actorFrom(c));
    return s;
  };
  r.get('/samples/:id/label', guard, async (c) => {
    const s = await sampleFor(c);
    return c.json({ label: { ...labelData(s), prints: await labelPrints(deps.db, s.id), sizes: LABEL_SIZES } });
  });
  for (const fmt of ['png', 'svg'] as const) {
    r.get(`/samples/:id/qr.${fmt}`, guard, async (c) => {
      const s = await sampleFor(c);
      await enforceRateLimit(deps.db, { key: `sample_qr_image:user:${c.get('session')!.userId}`, limit: 300, windowSeconds: 3600 });
      const token = await activeSampleToken(deps.db, deps, s.id);
      if (!token) throw Errors.notFound();
      const url = sampleQrUrl(deps.config.appOrigin, token);
      const headers = { 'Cache-Control': 'no-store', 'Content-Disposition': `inline; filename="TRACED-${s.sample_code.replace('/', '-')}.${fmt}"` };
      return fmt === 'png'
        ? c.body(new Uint8Array(await renderQrPng(url, 600)), 200, { ...headers, 'Content-Type': 'image/png' })
        : c.body(await renderQrSvg(url), 200, { ...headers, 'Content-Type': 'image/svg+xml' });
    });
  }
  r.post('/samples/:id/label-print', guard, async (c) => {
    const s = await sampleFor(c);
    const body = await parseBody(c, z.strictObject({ size: z.enum(LABEL_SIZES), reason: z.string().trim().max(500).optional() }));
    await enforceRateLimit(deps.db, { key: `label_print:user:${c.get('session')!.userId}`, limit: 120, windowSeconds: 3600 });
    return c.json(await recordLabelPrint(deps, c.get('session')!, s.id, body, actorFrom(c)));
  });
}

// ---- Collection staff: branch custody (package, ready, dispatch) and labels ------------------
export function staffCustodyRoutes(deps: Deps) {
  const { db } = deps;
  const r = new Hono<AppEnv>();
  const branch = requirePermission(deps, 'collection.scan', 'custody.record_branch');

  /** Samples at the staff member's assigned branches that still need branch-side steps. */
  r.get('/samples', branch, async (c) => {
    const q = check(z.strictObject({ branchId: uuid.optional(), status: z.enum(['collected', 'packaged', 'ready_for_dispatch', 'dispatched']).optional() }), c.req.query());
    const s = c.get('session')!;
    const { rows } = await db.query(
      `SELECT sm.id, sm.sample_code, sm.status, sm.status_changed_at, sm.collected_at, r.tracking_id, b.code, b.name_en, b.name_ar, b.city_en, b.city_ar
         FROM samples sm JOIN registrations r ON r.id = sm.registration_id JOIN collection_branches b ON b.id = sm.branch_id
        WHERE sm.branch_id IN (SELECT branch_id FROM staff_branch_assignments WHERE user_id = $1 AND revoked_at IS NULL)
          AND ($2::uuid IS NULL OR sm.branch_id = $2) AND sm.status = ANY($3::text[])
        ORDER BY sm.status_changed_at DESC LIMIT 200`,
      [s.userId, q.branchId ?? null, q.status ? [q.status] : ['collected', 'packaged', 'ready_for_dispatch', 'dispatched']]);
    return c.json({
      items: rows.map((x) => ({
        id: x.id, sampleId: x.sample_code, trackingId: x.tracking_id, status: x.status, statusChangedAt: iso(x.status_changed_at), collectedAt: iso(x.collected_at),
        branch: { code: x.code, nameEn: x.name_en, nameAr: x.name_ar, cityEn: x.city_en, cityAr: x.city_ar },
      })),
    });
  });

  /** Identifies a sample from its label (QR or typed ID). Never changes its status. */
  r.post('/samples/scan', branch, async (c) => {
    const { code } = await parseBody(c, scanBody);
    const s = c.get('session')!;
    await enforceRateLimit(db, { key: `sample_scan:user:${s.userId}`, limit: 120, windowSeconds: 60 });
    const { sample, identifiedBy } = await resolveSample(db, deps, code);
    await assertBranchAccess(db, s, sample, actorFrom(c));
    await audit(db, { ...actorFrom(c), action: 'sample.scanned', outcome: 'success', targetType: 'sample', targetId: sample.id, fieldsAccessed: ['patient.age', 'patient.gender'], metadata: { identifiedBy, side: 'branch' } });
    return c.json({ sample: await staffSampleView(db, sample) });
  });

  r.post('/samples/action', branch, async (c) => {
    const body = await parseBody(c, actionBody);
    await enforceRateLimit(db, { key: `custody_action:user:${c.get('session')!.userId}`, limit: 120, windowSeconds: 3600 });
    const result = await recordCustodyAction(deps, c.get('session')!, 'branch', body as never, actorFrom(c));
    const { sample } = await resolveSample(db, deps, body.code);
    return c.json({ ...result, sample: await staffSampleView(db, sample) });
  });

  labelRoutes(r, deps, branch, true);
  return r;
}

// ---- Laboratory operators -----------------------------------------------------------------
export function labRoutes(deps: Deps) {
  const { db } = deps;
  const r = new Hono<AppEnv>();
  const lab = requirePermission(deps, 'custody.record_lab');

  r.get('/me', lab, async (c) => {
    const s = c.get('session')!;
    const { rows } = await db.query<{ full_name: string | null }>('SELECT full_name FROM users WHERE id = $1', [s.userId]);
    return c.json({ operator: { name: rows[0]?.full_name ?? null, email: s.email, locale: s.locale } });
  });

  /** Expected incoming samples, samples in the laboratory, and today's figures. Operational data only. */
  r.get('/dashboard', lab, async (c) => {
    const list = async (statuses: string[]) => (await db.query(
      `SELECT sm.id, sm.sample_code, sm.status, sm.status_changed_at, r.tracking_id, b.code, b.name_en, b.name_ar, b.city_en, b.city_ar,
              (SELECT e.handover FROM custody_events e WHERE e.sample_id = sm.id AND e.to_status = 'dispatched' ORDER BY e.id DESC LIMIT 1) AS dispatch
         FROM samples sm JOIN registrations r ON r.id = sm.registration_id JOIN collection_branches b ON b.id = sm.branch_id
        WHERE sm.status = ANY($1::text[]) ORDER BY sm.status_changed_at LIMIT 200`, [statuses])).rows.map((x) => ({
      id: x.id, sampleId: x.sample_code, trackingId: x.tracking_id, status: x.status, statusChangedAt: iso(x.status_changed_at),
      branch: { code: x.code, nameEn: x.name_en, nameAr: x.name_ar, cityEn: x.city_en, cityAr: x.city_ar },
      dispatch: x.dispatch ? { courier: x.dispatch.courier ?? null, shipmentTrackingNumber: x.dispatch.shipmentTrackingNumber ?? null } : null,
    }));
    const today = (await db.query<{ received: string; reports: string }>(
      `SELECT count(*) FILTER (WHERE to_status = 'received_by_laboratory') AS received, count(*) FILTER (WHERE to_status = 'report_available') AS reports
         FROM custody_events WHERE (occurred_at AT TIME ZONE 'Asia/Riyadh')::date = (now() AT TIME ZONE 'Asia/Riyadh')::date`)).rows[0]!;
    return c.json({
      incoming: await list(['dispatched', 'in_transit']),
      inLaboratory: await list(['received_by_laboratory', 'analysis_in_progress', 'analysis_completed']),
      today: { received: Number(today.received), reportsAvailable: Number(today.reports) },
    });
  });

  r.post('/samples/scan', lab, async (c) => {
    const { code } = await parseBody(c, scanBody);
    await enforceRateLimit(db, { key: `sample_scan:user:${c.get('session')!.userId}`, limit: 120, windowSeconds: 60 });
    const { sample, identifiedBy } = await resolveSample(db, deps, code);
    await audit(db, { ...actorFrom(c), action: 'sample.scanned', outcome: 'success', targetType: 'sample', targetId: sample.id, metadata: { identifiedBy, side: 'laboratory' } });
    return c.json({ sample: await labSampleView(db, sample) });
  });

  r.post('/samples/action', lab, async (c) => {
    const body = await parseBody(c, actionBody);
    await enforceRateLimit(db, { key: `custody_action:user:${c.get('session')!.userId}`, limit: 300, windowSeconds: 3600 });
    const result = await recordCustodyAction(deps, c.get('session')!, 'laboratory', body as never, actorFrom(c));
    const { sample } = await resolveSample(db, deps, body.code);
    return c.json({ ...result, sample: await labSampleView(db, sample) });
  });

  /** Samples this laboratory has handled (operational data only). */
  r.get('/history', lab, async (c) => {
    const q = check(z.strictObject({ status: z.enum(SAMPLE_STATUSES as [string, ...string[]]).optional(), sampleId: z.string().trim().max(40).optional() }), c.req.query());
    const { rows } = await db.query(
      `SELECT sm.id, sm.sample_code, sm.status, sm.status_changed_at, r.tracking_id, b.code,
              (SELECT max(e.occurred_at) FROM custody_events e WHERE e.sample_id = sm.id AND e.location_type = 'laboratory') AS last_lab_event
         FROM samples sm JOIN registrations r ON r.id = sm.registration_id JOIN collection_branches b ON b.id = sm.branch_id
        WHERE EXISTS (SELECT 1 FROM custody_events e WHERE e.sample_id = sm.id AND e.location_type = 'laboratory')
          AND ($1::text IS NULL OR sm.status = $1) AND ($2::text IS NULL OR sm.sample_code = upper($2))
        ORDER BY last_lab_event DESC LIMIT 200`, [q.status ?? null, q.sampleId ?? null]);
    return c.json({ items: rows.map((x) => ({ id: x.id, sampleId: x.sample_code, trackingId: x.tracking_id, status: x.status, statusChangedAt: iso(x.status_changed_at), branchCode: x.code, lastLaboratoryEventAt: iso(x.last_lab_event) })) });
  });
  return r;
}

// ---- Administration: custody list, detail, correction, recollection -------------------------
export function adminCustodyRoutes(deps: Deps) {
  const { db } = deps;
  const r = new Hono<AppEnv>();
  const read = requirePermission(deps, 'registration.read_full');

  r.get('/samples', read, async (c) => {
    const q = check(z.strictObject({
      q: z.string().trim().max(60).optional(), status: z.enum(SAMPLE_STATUSES as [string, ...string[]]).optional(), branchId: uuid.optional(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }), c.req.query());
    const params: unknown[] = [];
    const where: string[] = [];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (q.q) where.push(`(upper(sm.sample_code) = upper(${p(q.q)}) OR upper(r.tracking_id) = upper(${p(q.q)}))`);
    if (q.status) where.push(`sm.status = ${p(q.status)}`);
    if (q.branchId) where.push(`sm.branch_id = ${p(q.branchId)}`);
    if (q.from) where.push(`(sm.collected_at AT TIME ZONE 'Asia/Riyadh')::date >= ${p(q.from)}::date`);
    if (q.to) where.push(`(sm.collected_at AT TIME ZONE 'Asia/Riyadh')::date <= ${p(q.to)}::date`);
    const { rows } = await db.query(
      `SELECT sm.id, sm.sample_code, sm.status, sm.status_changed_at, sm.collected_at, r.id AS registration_id, r.tracking_id, b.code, b.name_en, b.name_ar
         FROM samples sm JOIN registrations r ON r.id = sm.registration_id JOIN collection_branches b ON b.id = sm.branch_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY sm.collected_at DESC LIMIT 300`, params);
    const counts = await db.query<{ status: string; n: string }>('SELECT status, count(*) AS n FROM samples GROUP BY status');
    return c.json({
      counts: Object.fromEntries(counts.rows.map((x) => [x.status, Number(x.n)])),
      items: rows.map((x) => ({ id: x.id, sampleId: x.sample_code, trackingId: x.tracking_id, registrationId: x.registration_id, status: x.status, statusChangedAt: iso(x.status_changed_at), collectedAt: iso(x.collected_at), branch: { code: x.code, nameEn: x.name_en, nameAr: x.name_ar } })),
    });
  });

  r.get('/samples/:id', read, async (c) => {
    const id = idParam(c);
    const s = await loadSample(db, id);
    if (!s) throw Errors.notFound();
    const events = await db.query(
      `SELECT e.id, e.event_type, e.from_status, e.to_status, e.occurred_at, e.actor_role, e.location_type, e.identified_by, e.handover, e.condition,
              e.reason_category, e.remarks, e.corrects_event_id, u.email AS recorded_by_email, b.code AS branch_code
         FROM custody_events e JOIN users u ON u.id = e.recorded_by LEFT JOIN collection_branches b ON b.id = e.branch_id
        WHERE e.sample_id = $1 ORDER BY e.id`, [id]);
    const prints = await db.query(`SELECT p.created_at, p.label_size, p.reprint, p.reason, p.actor_role, u.email FROM sample_label_prints p JOIN users u ON u.id = p.printed_by WHERE p.sample_id = $1 ORDER BY p.id`, [id]);
    const qr = await db.query(`SELECT status, created_at, revoked_at FROM sample_qr_tokens WHERE sample_id = $1 ORDER BY created_at`, [id]);
    const others = await db.query(`SELECT id, sample_code, status FROM samples WHERE registration_id = $1 ORDER BY sample_seq`, [s.registration_id]);
    const recollection = await db.query(`SELECT a.reason, a.created_at, u.email FROM recollection_authorizations a JOIN users u ON u.id = a.authorized_by WHERE a.rejected_sample_id = $1`, [id]);
    const latest = others.rows.at(-1);
    await audit(db, { ...actorFrom(c), action: 'sample.viewed', outcome: 'success', targetType: 'sample', targetId: id });
    const sess = c.get('session')!;
    return c.json({
      sample: {
        id: s.id, sampleId: s.sample_code, trackingId: s.tracking_id, registrationId: s.registration_id, sampleType: 'hair', status: s.status,
        statusChangedAt: iso(s.status_changed_at), collectedAt: iso(s.collected_at),
        branch: { code: s.b_code, nameEn: s.b_name_en, nameAr: s.b_name_ar, cityEn: s.b_city_en, cityAr: s.b_city_ar },
        events: events.rows.map((e) => ({
          id: Number(e.id), type: e.event_type, from: e.from_status, to: e.to_status, at: iso(e.occurred_at), recordedBy: e.recorded_by_email, actorRole: e.actor_role,
          locationType: e.location_type, branchCode: e.branch_code, identifiedBy: e.identified_by, handover: e.handover, condition: e.condition,
          reasonCategory: e.reason_category, remarks: e.remarks, correctsEventId: e.corrects_event_id ? Number(e.corrects_event_id) : null,
        })),
        labelPrints: prints.rows.map((x) => ({ at: iso(x.created_at), size: x.label_size, reprint: x.reprint, reason: x.reason, by: x.email, actorRole: x.actor_role })),
        qr: qr.rows.map((x) => ({ status: x.status, issuedAt: iso(x.created_at), revokedAt: iso(x.revoked_at) })),
        registrationSamples: others.rows.map((x) => ({ id: x.id, sampleId: x.sample_code, status: x.status })),
        recollection: recollection.rows[0] ? { reason: recollection.rows[0].reason, at: iso(recollection.rows[0].created_at), by: recollection.rows[0].email } : null,
      },
      permissions: {
        correct: sess.permissions.has('custody.correct'),
        authorizeRecollection: sess.permissions.has('registration.manage') && s.status === 'rejected' && s.reg_status === 'rejected' && latest?.id === s.id && !recollection.rows[0],
      },
    });
  });

  r.post('/samples/:id/correct', requirePermission(deps, 'registration.read_full', 'custody.correct'), async (c) => {
    const id = idParam(c);
    const body = await parseBody(c, z.strictObject({ eventId: z.number().int().positive(), toStatus: z.enum(SAMPLE_STATUSES as [string, ...string[]]), reason: z.string().trim().min(5).max(500) }));
    await enforceRateLimit(db, { key: `custody_correct:user:${c.get('session')!.userId}`, limit: 60, windowSeconds: 3600 });
    await correctCustody(deps, c.get('session')!, id, body as never, actorFrom(c));
    return c.json({ status: 'corrected' });
  });

  r.post('/registrations/:id/recollection', requirePermission(deps, 'registration.read_full', 'registration.manage'), async (c) => {
    const id = idParam(c);
    const body = await parseBody(c, z.strictObject({ reason: z.string().trim().min(5).max(500) }));
    await enforceRateLimit(db, { key: `recollection:user:${c.get('session')!.userId}`, limit: 30, windowSeconds: 3600 });
    return c.json({ status: 'recollection_authorized', ...(await authorizeRecollection(deps, c.get('session')!, id, body.reason, actorFrom(c))) });
  });

  labelRoutes(r, deps, requirePermission(deps, 'registration.read_full', 'custody.correct'), false);
  return r;
}

