import { Hono } from 'hono';
import { z } from 'zod';
import { actorFrom, type AppEnv, type Deps } from '../../context.ts';
import { AppError } from '../../lib/errors.ts';
import { parseBody } from '../../lib/validate.ts';
import { enforceRateLimit } from '../../middleware/rate-limit.ts';
import { requirePermission } from '../../middleware/rbac.ts';
import { kickOutbox } from '../mail/outbox.ts';
import { replaceCustomerQr } from './lifecycle.ts';

/**
 * Administrative QR revocation (permission `qr.revoke`: admin and super admin only, MFA required).
 * A reason is mandatory and is recorded in the audit log. The admin user interface for this
 * arrives in Phase 5; the API and its permissions are in place and tested now.
 */
export function adminQrRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();

  r.post('/registrations/:id/qr/revoke', requirePermission(deps, 'qr.revoke'), async (c) => {
    const id = c.req.param('id');
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'NOT_FOUND', 'Not found.');
    const body = await parseBody(c, z.strictObject({
      reason: z.string().trim().min(5, 'REASON_REQUIRED').max(200),
      regenerate: z.boolean().default(true),
      notifyCustomer: z.boolean().default(true),
    }));
    await enforceRateLimit(deps.db, { key: `admin_qr_revoke:user:${c.get('session')!.userId}`, limit: 60, windowSeconds: 3600 });
    const result = await replaceCustomerQr(deps, {
      registrationId: id, reason: `admin: ${body.reason}`, regenerate: body.regenerate, notify: body.notifyCustomer, meta: actorFrom(c),
    });
    void kickOutbox(deps);
    return c.json({ status: body.regenerate ? 'replaced' : 'revoked', ...result });
  });

  return r;
}
