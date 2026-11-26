import { Hono } from 'hono';
import { z } from 'zod';
import { actorFrom, type AppEnv, type Deps } from '../../context.ts';
import { AppError } from '../../lib/errors.ts';
import { check, parseBody } from '../../lib/validate.ts';
import { enforceRateLimit } from '../../middleware/rate-limit.ts';
import { requirePermission } from '../../middleware/rbac.ts';
import {
  assignedBranches, collectionHistory, confirmCollection, recordDevVerification, scanCustomerQr, sessionView, staffDashboard,
} from '../collection/collection.service.ts';

const uuid = z.uuid();
const STATUSES = ['sample_collected', 'sample_packaged', 'ready_for_dispatch', 'dispatched', 'in_transit', 'received_by_laboratory',
  'analysis_in_progress', 'analysis_completed', 'report_available', 'rejected', 'cancelled'] as const;

/**
 * Collection-staff API. Every route needs a signed-in account with the collection permissions;
 * branch assignment and object ownership are checked in the service. Responses are built only by
 * the allowlist functions in collection.service.ts. There is deliberately no public QR lookup.
 */
export function staffRoutes(deps: Deps) {
  const { db } = deps;
  const r = new Hono<AppEnv>();
  const scan = requirePermission(deps, 'collection.scan');
  const collect = requirePermission(deps, 'collection.scan', 'collection.collect');

  r.get('/me', scan, async (c) => {
    const s = c.get('session')!;
    const { rows } = await db.query<{ full_name: string | null }>('SELECT full_name FROM users WHERE id = $1', [s.userId]);
    return c.json({
      staff: { name: rows[0]?.full_name ?? null, email: s.email, locale: s.locale },
      branches: await assignedBranches(db, s.userId),
      devVerificationAvailable: Boolean(deps.config.devIdentityVerification),
    });
  });

  r.get('/dashboard', scan, async (c) => {
    const { branchId } = check(z.strictObject({ branchId: uuid }), c.req.query());
    return c.json(await staffDashboard(deps, c.get('session')!, branchId, actorFrom(c)));
  });

  r.post('/qr/validate', scan, async (c) => {
    const s = c.get('session')!;
    const { code, branchId } = await parseBody(c, z.strictObject({ code: z.string().min(1).max(300), branchId: uuid.optional() }));
    await enforceRateLimit(db, { key: `qr_validate:user:${s.userId}`, limit: 60, windowSeconds: 60 });
    const result = await scanCustomerQr(deps, s, code, branchId ?? null, actorFrom(c));
    if (!result.qrValid) {
      // Invalid scans are limited separately (10 per 5 minutes) to slow down token guessing.
      await enforceRateLimit(db, { key: `qr_invalid:user:${s.userId}`, limit: 10, windowSeconds: 300 });
    }
    return c.json(result);
  });

  r.get('/collection-sessions/:id', scan, async (c) => {
    const id = c.req.param('id');
    if (!uuid.safeParse(id).success) throw new AppError(404, 'NOT_FOUND', 'Not found.');
    return c.json(await sessionView(deps, c.get('session')!, id, actorFrom(c)));
  });

  // DEVELOPMENT ONLY (404 unless DEV_IDENTITY_VERIFICATION, which production refuses).
  r.post('/collection-sessions/:id/identity/dev', collect, async (c) => {
    const id = c.req.param('id');
    if (!deps.config.devIdentityVerification || !uuid.safeParse(id).success) throw new AppError(404, 'NOT_FOUND', 'Not found.');
    const { outcome } = await parseBody(c, z.strictObject({ outcome: z.enum(['pending', 'verified', 'failed']) }));
    return c.json(await recordDevVerification(deps, c.get('session')!, id, outcome, actorFrom(c)));
  });

  r.post('/collection-sessions/:id/collect', collect, async (c) => {
    const s = c.get('session')!;
    const id = c.req.param('id');
    if (!uuid.safeParse(id).success) throw new AppError(404, 'NOT_FOUND', 'Not found.');
    const body = await parseBody(c, z.strictObject({ instructionsId: uuid, checklist: z.array(z.string().regex(/^[a-z_]{1,40}$/)).max(20) }));
    await enforceRateLimit(db, { key: `collect:user:${s.userId}`, limit: 60, windowSeconds: 3600 });
    return c.json({ collection: await confirmCollection(deps, s, id, body, actorFrom(c)) });
  });

  r.get('/history', scan, async (c) => {
    const q = check(z.strictObject({
      from: z.iso.date().optional(),
      to: z.iso.date().optional(),
      branchId: uuid.optional(),
      status: z.enum(STATUSES).optional(),
      trackingId: z.string().regex(/^TRC-SA-(0[1-9]|1[0-2])\/[0-9]{2}-[0-9]{5}$/).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(25),
      before: z.iso.datetime().optional(),
    }), c.req.query());
    return c.json(await collectionHistory(deps, c.get('session')!, q, actorFrom(c)));
  });

  return r;
}
