import { Hono } from 'hono';
import { actorFrom, type AppEnv, type Deps } from '../../context.ts';
import { enforceRateLimit } from '../../middleware/rate-limit.ts';
import { requirePermission } from '../../middleware/rbac.ts';
import { audit } from './audit.service.ts';
import { createCheckpoint, integritySummary, verifyIntegrity } from './integrity.service.ts';

/**
 * Audit-integrity page (Phase 7). Viewing and running a verification need `audit.read` (admin,
 * super admin, auditor); creating a checkpoint by hand needs `admin.manage` (super admin). No
 * personal data is returned: hashes, counts, sequence numbers and finding codes only.
 */
export function auditIntegrityRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();

  r.get('/audit-integrity', requirePermission(deps, 'audit.read'), async (c) => {
    const summary = await integritySummary(deps);
    await audit(deps.db, { ...actorFrom(c), action: 'audit.integrity_viewed', outcome: 'success', targetType: 'audit_logs' });
    return c.json(summary);
  });

  r.post('/audit-integrity/verify', requirePermission(deps, 'audit.read'), async (c) => {
    const s = c.get('session')!;
    await enforceRateLimit(deps.db, { key: `audit_verify:user:${s.userId}`, limit: 10, windowSeconds: 3600 });
    const meta = actorFrom(c);
    const report = await verifyIntegrity(deps, { trigger: 'manual', actorUserId: s.userId, meta });
    return c.json(report);
  });

  r.post('/audit-integrity/checkpoint', requirePermission(deps, 'admin.manage'), async (c) => {
    const s = c.get('session')!;
    await enforceRateLimit(deps.db, { key: `audit_checkpoint:user:${s.userId}`, limit: 10, windowSeconds: 3600 });
    const cp = await createCheckpoint(deps, { trigger: 'manual', actorUserId: s.userId, meta: actorFrom(c) });
    return c.json({ checkpoint: { id: cp.id, createdAt: cp.createdAt, auditLastSeq: cp.auditLastSeq, custodyCount: cp.custodyCount, keyId: cp.keyId, sink: cp.sink } });
  });

  return r;
}
