import { Hono } from 'hono';
import { z } from 'zod';
import { actorFrom, type AppEnv, type Deps } from '../../context.ts';
import { parseBody } from '../../lib/validate.ts';
import { enforceRateLimit } from '../../middleware/rate-limit.ts';
import { requirePermission } from '../../middleware/rbac.ts';
import { validateCustomerQr } from './validation.service.ts';

/**
 * Collection-staff API (Phase 3 provides QR validation only; the staff portal is Phase 4).
 * There is deliberately no public QR lookup: scanning the QR with a phone camera opens a static
 * page that sends nothing to the server.
 */
export function staffRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();

  r.post('/qr/validate', requirePermission(deps, 'collection.scan'), async (c) => {
    const s = c.get('session')!;
    const { code } = await parseBody(c, z.strictObject({ code: z.string().min(1).max(300) }));
    await enforceRateLimit(deps.db, { key: `qr_validate:user:${s.userId}`, limit: 60, windowSeconds: 60 });
    return c.json(await validateCustomerQr(deps, s, code, actorFrom(c)));
  });

  return r;
}
