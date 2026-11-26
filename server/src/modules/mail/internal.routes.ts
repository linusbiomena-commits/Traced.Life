import { Hono, type Context } from 'hono';
import type { AppEnv, Deps } from '../../context.ts';
import { AppError } from '../../lib/errors.ts';
import { log } from '../../lib/logger.ts';
import { authorizeScheduler, schedulerEnabled } from '../../lib/scheduler-auth.ts';
import { createCheckpoint, verifyIntegrity } from '../audit/integrity.service.ts';
import { processOutbox } from './outbox.ts';

/**
 * Scheduled jobs for serverless hosting. Cloud Run scales to zero, so in-process timers stop;
 * Cloud Scheduler calls these (shared secret or Google-signed OIDC token, see
 * lib/scheduler-auth.ts). Disabled (404) unless a scheduler credential is configured.
 */
export function internalRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();
  const authorize = async (c: Context<AppEnv>) => {
    if (!schedulerEnabled(deps.config)) throw new AppError(404, 'NOT_FOUND', 'Not found.');
    const via = await authorizeScheduler(c.req.header('authorization'), deps.config, deps.schedulerJwks);
    if (!via) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    return via;
  };

  r.post('/outbox/run', async (c) => {
    await authorize(c);
    let total = { sent: 0, retried: 0, failed: 0 };
    for (let i = 0; i < 10; i++) {
      const r = await processOutbox(deps, 25);
      total = { sent: total.sent + r.sent, retried: total.retried + r.retried, failed: total.failed + r.failed };
      if (r.sent + r.retried + r.failed < 25) break;
    }
    return c.json(total);
  });

  // Daily: sign a checkpoint, then verify chain + checkpoints + custody digests. A failed
  // verification is logged at error level so a log-based alert can page someone.
  r.post('/audit/checkpoint', async (c) => {
    const via = await authorize(c);
    const meta = { actorRole: 'scheduler', requestId: c.get('requestId') ?? null };
    const cp = await createCheckpoint(deps, { trigger: 'scheduled', actorUserId: null, meta });
    const report = await verifyIntegrity(deps, { trigger: 'scheduled', actorUserId: null, meta });
    if (report.outcome !== 'ok') log.error('audit integrity verification failed', { verificationId: report.verificationId, findings: report.findings.map((f) => f.code) });
    return c.json({ via, checkpointId: cp.id, verification: { id: report.verificationId, outcome: report.outcome, findings: report.findings } });
  });
  return r;
}
