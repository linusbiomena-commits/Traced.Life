import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { actorFrom, type AppEnv, type Deps } from '../../context.ts';
import { withTx, type Queryable } from '../../db/pool.ts';
import { AppError, Errors } from '../../lib/errors.ts';
import { parseBody } from '../../lib/validate.ts';
import { enforceRateLimit } from '../../middleware/rate-limit.ts';
import { requirePermission } from '../../middleware/rbac.ts';
import { audit } from '../audit/audit.service.ts';
import { currentInstructions } from '../collection/instructions.ts';
import { has, idParam, reasonField } from './common.ts';

const step = z.string().trim().min(1).max(500);
const draftBody = z.strictObject({
  version: z.string().trim().regex(/^[0-9A-Za-z.\-]{1,32}$/),
  titleEn: z.string().trim().min(1).max(200),
  titleAr: z.string().trim().min(1).max(200),
  stepsEn: z.array(step).min(1).max(30),
  stepsAr: z.array(step).min(1).max(30),
  checklist: z.array(z.strictObject({ id: z.string().regex(/^[a-z0-9_]{2,40}$/), labelEn: z.string().trim().min(1).max(200), labelAr: z.string().trim().min(1).max(200) })).min(1).max(20),
  notes: z.string().trim().max(1000).nullable().optional(),
}).refine((b) => new Set(b.checklist.map((x) => x.id)).size === b.checklist.length, { message: 'DUPLICATE_CHECKLIST_ID', path: ['checklist'] });

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

async function versionTaken(tx: Queryable, version: string, exceptDraft?: string) {
  const pub = await tx.query('SELECT 1 FROM collection_instructions WHERE version = $1 LIMIT 1', [version]);
  const dr = await tx.query(`SELECT 1 FROM collection_instruction_drafts WHERE version = $1 AND status <> 'withdrawn' AND ($2::uuid IS NULL OR id <> $2::uuid) LIMIT 1`, [version, exceptDraft ?? null]);
  if (pub.rowCount || dr.rowCount) throw new AppError(409, 'VERSION_IN_USE', 'This version number is already used. Choose a new one.');
}

/**
 * Collection-instruction versions. Admins (`instructions.draft`) prepare bilingual drafts and
 * submit them; only the super admin (`form.approve`) publishes. Publishing copies the draft into
 * the immutable collection_instructions table; earlier versions stay unchanged and every sample
 * keeps the version it was collected under.
 *
 * Publishing is NOT clinical approval. A version is marked 'approved' only when the publisher
 * records the reference of the laboratory/management approval obtained outside this system;
 * otherwise it is published as 'provisional' (usable in development only; production refuses it).
 */
export function adminInstructionRoutes(deps: Deps) {
  const { db } = deps;
  const r = new Hono<AppEnv>();
  const draft = requirePermission(deps, 'instructions.draft');
  const approve = requirePermission(deps, 'form.approve');

  const draftView = (d: Record<string, any>) => ({
    id: d.id, version: d.version, status: d.status, titleEn: d.title_en, titleAr: d.title_ar, stepsEn: d.steps_en, stepsAr: d.steps_ar,
    checklist: d.checklist, notes: d.notes, createdBy: d.created_email, updatedBy: d.updated_email, submittedBy: d.submitted_email ?? null,
    submittedAt: iso(d.submitted_at), publishedBy: d.published_email ?? null, publishedAt: iso(d.published_at), createdAt: iso(d.created_at), updatedAt: iso(d.updated_at),
  });
  const DRAFT_SELECT = `SELECT d.*, cu.email AS created_email, uu.email AS updated_email, su.email AS submitted_email, pu.email AS published_email
      FROM collection_instruction_drafts d JOIN users cu ON cu.id = d.created_by JOIN users uu ON uu.id = d.updated_by
      LEFT JOIN users su ON su.id = d.submitted_by LEFT JOIN users pu ON pu.id = d.published_by`;
  const loadDraft = async (q: Queryable, id: string, lock = false) => {
    const { rows } = await q.query(`${DRAFT_SELECT} WHERE d.id = $1 ${lock ? 'FOR UPDATE OF d' : ''}`, [id]);
    if (!rows[0]) throw Errors.notFound();
    return rows[0];
  };

  r.get('/instructions', draft, async (c) => {
    const current = await currentInstructions(db, deps.config);
    const published = await db.query(
      `SELECT ci.version, ci.locale, ci.title, ci.status, ci.effective_from, ci.approved_at, ci.approval_reference, ci.created_at, ci.steps, ci.checklist,
              pu.email AS published_email, au.email AS approved_email,
              (SELECT count(*) FROM samples s WHERE s.instructions_id = ci.id) AS samples
         FROM collection_instructions ci LEFT JOIN users pu ON pu.id = ci.published_by LEFT JOIN users au ON au.id = ci.approved_by
        ORDER BY ci.effective_from DESC, ci.created_at DESC, ci.locale`);
    const drafts = await db.query(`${DRAFT_SELECT} ORDER BY (d.status IN ('draft', 'submitted')) DESC, d.updated_at DESC LIMIT 100`);
    const s = c.get('session')!;
    return c.json({
      current: current.map((x) => ({ id: x.id, version: x.version, locale: x.locale, title: x.title, provisional: x.provisional })),
      published: published.rows.map((p) => ({
        version: p.version, locale: p.locale, title: p.title, status: p.status, effectiveFrom: iso(p.effective_from), approvedAt: iso(p.approved_at),
        approvalReference: p.approval_reference, publishedBy: p.published_email ?? null, approvedBy: p.approved_email ?? null, createdAt: iso(p.created_at),
        steps: p.steps, checklist: p.checklist, samplesCollected: Number(p.samples),
      })),
      drafts: drafts.rows.map(draftView),
      productionUsesApprovedOnly: true,
      canPublish: has(s, 'form.approve'),
    });
  });

  r.post('/instructions/drafts', draft, async (c) => {
    const body = await parseBody(c, draftBody);
    const s = c.get('session')!;
    await enforceRateLimit(db, { key: `admin_instructions:user:${s.userId}`, limit: 60, windowSeconds: 3600 });
    const id = await withTx(db, async (tx) => {
      await versionTaken(tx, body.version);
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO collection_instruction_drafts (version, title_en, title_ar, steps_en, steps_ar, checklist, notes, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING id`,
        [body.version, body.titleEn, body.titleAr, JSON.stringify(body.stepsEn), JSON.stringify(body.stepsAr), JSON.stringify(body.checklist), body.notes ?? null, s.userId]);
      await audit(tx, { ...actorFrom(c), action: 'instructions.draft_created', outcome: 'success', targetType: 'instruction_draft', targetId: rows[0]!.id, metadata: { version: body.version } });
      return rows[0]!.id;
    });
    return c.json({ draft: draftView(await loadDraft(db, id)) }, 201);
  });

  r.put('/instructions/drafts/:id', draft, async (c) => {
    const id = idParam(c);
    const body = await parseBody(c, draftBody);
    const s = c.get('session')!;
    await enforceRateLimit(db, { key: `admin_instructions:user:${s.userId}`, limit: 60, windowSeconds: 3600 });
    await withTx(db, async (tx) => {
      const d = await loadDraft(tx, id, true);
      if (d.status !== 'draft') throw new AppError(409, 'DRAFT_NOT_EDITABLE', 'Only drafts can be edited. A submitted draft must be returned first.');
      await versionTaken(tx, body.version, id);
      await tx.query(
        `UPDATE collection_instruction_drafts SET version = $2, title_en = $3, title_ar = $4, steps_en = $5, steps_ar = $6, checklist = $7, notes = $8, updated_by = $9 WHERE id = $1`,
        [id, body.version, body.titleEn, body.titleAr, JSON.stringify(body.stepsEn), JSON.stringify(body.stepsAr), JSON.stringify(body.checklist), body.notes ?? null, s.userId]);
      await audit(tx, { ...actorFrom(c), action: 'instructions.draft_updated', outcome: 'success', targetType: 'instruction_draft', targetId: id, metadata: { version: body.version } });
    });
    return c.json({ draft: draftView(await loadDraft(db, id)) });
  });

  const transition = (from: string[], to: string, action: string, needsReason: boolean) => async (c: any) => {
    const id = idParam(c);
    const body = await parseBody(c, needsReason ? z.strictObject({ reason: reasonField }) : z.strictObject({}));
    const s = c.get('session')!;
    await withTx(db, async (tx) => {
      const d = await loadDraft(tx, id, true);
      if (!from.includes(d.status)) throw new AppError(409, 'DRAFT_STATE', 'This draft can’t be changed in its current state.');
      await tx.query(
        `UPDATE collection_instruction_drafts SET status = $2, updated_by = $3,
                submitted_by = CASE WHEN $2 = 'submitted' THEN $3 ELSE submitted_by END,
                submitted_at = CASE WHEN $2 = 'submitted' THEN now() ELSE submitted_at END
          WHERE id = $1`, [id, to, s.userId]);
      await audit(tx, { ...actorFrom(c), action, outcome: 'success', targetType: 'instruction_draft', targetId: id, metadata: { version: d.version, ...('reason' in body ? { reason: body.reason } : {}) } });
    });
    return c.json({ draft: draftView(await loadDraft(db, id)) });
  };
  r.post('/instructions/drafts/:id/submit', draft, transition(['draft'], 'submitted', 'instructions.draft_submitted', false));
  r.post('/instructions/drafts/:id/withdraw', draft, transition(['draft', 'submitted'], 'withdrawn', 'instructions.draft_withdrawn', true));
  r.post('/instructions/drafts/:id/return', approve, transition(['submitted'], 'draft', 'instructions.draft_returned', true));

  r.post('/instructions/drafts/:id/publish', approve, async (c) => {
    const id = idParam(c);
    const body = await parseBody(c, z.strictObject({
      effectiveFrom: z.iso.datetime({ offset: true }).optional(),
      // Reference of the laboratory + management approval obtained OUTSIDE this system (e.g. a
      // signed document number). Without it the version is published as provisional.
      clinicalApprovalReference: z.string().trim().min(3).max(200).nullable().default(null),
      confirm: z.literal(true),
    }));
    const s = c.get('session')!;
    await enforceRateLimit(db, { key: `admin_instructions:user:${s.userId}`, limit: 30, windowSeconds: 3600 });
    const effective = body.effectiveFrom ? new Date(body.effectiveFrom) : new Date();
    if (effective.getTime() < Date.now() - 60_000) throw new AppError(422, 'EFFECTIVE_IN_PAST', 'The effective date can’t be in the past.');
    const status = body.clinicalApprovalReference ? 'approved' : 'provisional';
    await withTx(db, async (tx) => {
      const d = await loadDraft(tx, id, true);
      if (d.status !== 'submitted') throw new AppError(409, 'DRAFT_NOT_SUBMITTED', 'Only a submitted draft can be published.');
      await versionTaken(tx, d.version, id);
      for (const locale of ['en', 'ar'] as const) {
        const title = locale === 'en' ? d.title_en : d.title_ar;
        const steps: string[] = locale === 'en' ? d.steps_en : d.steps_ar;
        const checklist = (d.checklist as { id: string; labelEn: string; labelAr: string }[]).map((x) => ({ id: x.id, label: locale === 'en' ? x.labelEn : x.labelAr }));
        const hash = createHash('sha256').update(JSON.stringify([title, steps, checklist])).digest();
        await tx.query(
          `INSERT INTO collection_instructions (version, locale, title, steps, checklist, content_sha256, status, effective_from, approved_by, approved_at, draft_id, published_by, approval_reference)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $7 = 'approved' THEN $9::uuid END, CASE WHEN $7 = 'approved' THEN now() END, $10, $9, $11)`,
          [d.version, locale, title, JSON.stringify(steps), JSON.stringify(checklist), hash, status, effective, s.userId, id, body.clinicalApprovalReference]);
      }
      await tx.query(`UPDATE collection_instruction_drafts SET status = 'published', published_by = $2, published_at = now(), updated_by = $2 WHERE id = $1`, [id, s.userId]);
      await audit(tx, {
        ...actorFrom(c), action: 'instructions.published', outcome: 'success', targetType: 'instruction_draft', targetId: id,
        metadata: { version: d.version, status, effectiveFrom: effective.toISOString(), clinicalApprovalReference: body.clinicalApprovalReference },
      });
    });
    return c.json({ draft: draftView(await loadDraft(db, id)), status, usableInProduction: status === 'approved' });
  });

  return r;
}
