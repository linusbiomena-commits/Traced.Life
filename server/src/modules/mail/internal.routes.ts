import { Hono } from 'hono';
import type { AppEnv, Deps } from '../../context.ts';
import { safeEqual } from '../../lib/crypto.ts';
import { AppError } from '../../lib/errors.ts';
import { processOutbox } from './outbox.ts';

/**
 * Scheduled outbox run for serverless hosting. Cloud Run scales to zero, so in-process timers
 * stop; Cloud Scheduler calls this every few minutes (Authorization: Bearer INTERNAL_CRON_SECRET)
 * to deliver due emails and retries. Disabled (404) unless the secret is configured.
 */
export function internalRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();
  r.post('/outbox/run', async (c) => {
    const secret = deps.config.internalCronSecret;
    const sent = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    if (!secret) throw new AppError(404, 'NOT_FOUND', 'Not found.');
    if (!safeEqual(sent, secret)) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    let total = { sent: 0, retried: 0, failed: 0 };
    for (let i = 0; i < 10; i++) {
      const r = await processOutbox(deps, 25);
      total = { sent: total.sent + r.sent, retried: total.retried + r.retried, failed: total.failed + r.failed };
      if (r.sent + r.retried + r.failed < 25) break;
    }
    return c.json(total);
  });
  return r;
}
