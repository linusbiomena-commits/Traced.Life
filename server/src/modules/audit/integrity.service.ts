import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Deps } from '../../context.ts';
import { withTx, type Queryable } from '../../db/pool.ts';
import { AppError } from '../../lib/errors.ts';
import { audit } from './audit.service.ts';

/**
 * Phase 7 audit integrity (see docs/security/audit-integrity.md).
 *
 * A checkpoint records the audit-chain head (last chain_seq + hash) and a digest of every custody
 * event, signs that with AUDIT_CHECKPOINT_KEY (kept outside the database), stores it in
 * audit_checkpoints and writes a copy to an external sink. Verification recomputes the chain and
 * the custody digests, checks each signature, and cross-checks the sink copies, so a rewrite by
 * someone with database-owner access is detected as long as the key and the sink are out of
 * their reach.
 */

export type Checkpoint = {
  id: number;
  createdAt: Date;
  auditLastSeq: number;
  auditLastHash: Buffer | null;
  custodyLastId: number;
  custodyCount: number;
  custodyDigest: Buffer;
  keyId: string;
  signature: Buffer;
  sink: 'none' | 'file' | 'gcs';
  sinkRef: string | null;
};

export type Finding = { code: string; checkpointId?: number; seq?: number; detail?: string };

const hex = (b: Buffer | null) => (b ? b.toString('hex') : '');

export function keyFingerprint(key: string): string {
  return createHash('sha256').update(`traced-audit-checkpoint|${key}`).digest('hex').slice(0, 16);
}

/** Canonical, versioned text that is signed. Order and format must never change for v1. */
export function canonicalCheckpoint(cp: Pick<Checkpoint, 'createdAt' | 'auditLastSeq' | 'auditLastHash' | 'custodyLastId' | 'custodyCount' | 'custodyDigest' | 'keyId'>): string {
  return ['traced-checkpoint-v1', cp.createdAt.toISOString(), cp.auditLastSeq, hex(cp.auditLastHash), cp.custodyLastId, cp.custodyCount, hex(cp.custodyDigest), cp.keyId].join('|');
}

export function signCheckpoint(key: string, cp: Parameters<typeof canonicalCheckpoint>[0]): Buffer {
  return createHmac('sha256', key).update(canonicalCheckpoint(cp), 'utf8').digest();
}

function sinkDir(deps: Deps): string | null {
  return deps.config.auditCheckpointDir ? path.resolve(deps.config.auditCheckpointDir) : null;
}

/** JSON copy written to the sink. Contains hashes and counts only, never personal data. */
function sinkDocument(cp: Checkpoint) {
  return {
    format: 'traced-checkpoint-v1', id: cp.id, createdAt: cp.createdAt.toISOString(), auditLastSeq: cp.auditLastSeq,
    auditLastHash: hex(cp.auditLastHash), custodyLastId: cp.custodyLastId, custodyCount: cp.custodyCount,
    custodyDigest: hex(cp.custodyDigest), keyId: cp.keyId, signature: hex(cp.signature),
  };
}

const rowToCheckpoint = (r: Record<string, any>): Checkpoint => ({
  id: Number(r.id), createdAt: r.created_at, auditLastSeq: Number(r.audit_last_seq), auditLastHash: r.audit_last_hash,
  custodyLastId: Number(r.custody_last_id), custodyCount: Number(r.custody_count), custodyDigest: r.custody_digest,
  keyId: r.key_id, signature: r.signature, sink: r.sink, sinkRef: r.sink_ref,
});

export async function createCheckpoint(deps: Deps, opts: { trigger: 'scheduled' | 'manual'; actorUserId: string | null; meta?: Record<string, unknown> }): Promise<Checkpoint> {
  const key = deps.config.auditCheckpointKey;
  if (!key) throw new AppError(503, 'CHECKPOINT_KEY_MISSING', 'Audit checkpoints are not configured on this server.');
  const dir = sinkDir(deps);
  const keyId = keyFingerprint(key);
  return withTx(deps.db, async (tx) => {
    // One checkpoint at a time, and the chain head must not move while we read it: take the same
    // advisory lock the audit insert trigger takes.
    // The runtime role has a 15 s statement_timeout; the custody digest grows with the data.
    await tx.query(`SET LOCAL statement_timeout = '300s'`);
    await tx.query('SELECT pg_advisory_xact_lock(7270001)');
    const head = await tx.query<{ seq: string | null; hash: Buffer | null }>('SELECT chain_seq AS seq, hash FROM audit_logs ORDER BY chain_seq DESC LIMIT 1');
    const lastCustody = await tx.query<{ id: string | null }>('SELECT max(id) AS id FROM custody_events');
    const custodyLastId = Number(lastCustody.rows[0]?.id ?? 0);
    const digest = await tx.query<{ event_count: string; digest: Buffer }>('SELECT event_count, digest FROM custody_events_digest($1)', [custodyLastId]);
    const now = await tx.query<{ now: Date }>(`SELECT date_trunc('milliseconds', clock_timestamp()) AS now`);
    const draft = {
      createdAt: now.rows[0]!.now, auditLastSeq: Number(head.rows[0]?.seq ?? 0), auditLastHash: head.rows[0]?.hash ?? null,
      custodyLastId, custodyCount: Number(digest.rows[0]!.event_count), custodyDigest: digest.rows[0]!.digest, keyId,
    };
    const signature = signCheckpoint(key, draft);
    const sinkRef = dir ? `checkpoint-${draft.createdAt.toISOString().replace(/[:.]/g, '-')}-${draft.auditLastSeq}.json` : null;
    const { rows } = await tx.query(
      `INSERT INTO audit_checkpoints (created_at, created_by, trigger, audit_last_seq, audit_last_hash, custody_last_id, custody_count, custody_digest, key_id, signature, sink, sink_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [draft.createdAt, opts.actorUserId, opts.trigger, draft.auditLastSeq, draft.auditLastHash, custodyLastId, draft.custodyCount, draft.custodyDigest, keyId, signature, dir ? 'file' : 'none', sinkRef]);
    const cp = rowToCheckpoint(rows[0]!);
    // Write the external copy before committing: if the sink fails, no checkpoint row exists that
    // claims a copy. 'wx' refuses to overwrite an existing file.
    if (dir && sinkRef) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, sinkRef), `${JSON.stringify(sinkDocument(cp), null, 2)}\n`, { flag: 'wx' });
    }
    await audit(tx, {
      ...(opts.meta ?? {}), actorUserId: opts.actorUserId, actorRole: (opts.meta?.actorRole as string | undefined) ?? (opts.actorUserId ? null : 'scheduler'),
      action: 'audit.checkpoint_created', outcome: 'success', targetType: 'audit_checkpoint', targetId: String(cp.id),
      metadata: { trigger: opts.trigger, auditLastSeq: cp.auditLastSeq, custodyCount: cp.custodyCount, keyId, sink: cp.sink },
    });
    return cp;
  });
}

/** How many of the newest checkpoints a verification run re-checks in full. */
export const VERIFY_CHECKPOINT_LIMIT = 100;

export type VerificationReport = {
  outcome: 'ok' | 'failed';
  chainRows: number;
  firstBrokenSeq: number | null;
  checkpointsChecked: number;
  findings: Finding[];
  durationMs: number;
  verificationId: number;
};

export async function verifyIntegrity(deps: Deps, opts: { trigger: 'scheduled' | 'manual'; actorUserId: string | null; meta?: Record<string, unknown> }): Promise<VerificationReport> {
  const started = Date.now();
  const findings: Finding[] = [];
  const key = deps.config.auditCheckpointKey;
  const currentKeyId = key ? keyFingerprint(key) : null;

  // All reads run in one REPEATABLE READ snapshot (chain, checkpoints and custody seen at the same
  // moment) with a longer statement timeout than the runtime role's 15 s default. The records
  // of the run are written afterwards, outside the snapshot: an audit insert inside it could
  // read a stale chain head.
  const { chainRows, firstBrokenSeq, checkpoints } = await withTx(deps.db, async (db) => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    await db.query(`SET LOCAL statement_timeout = '600s'`);
    // 1. Full chain.
    const chain = await db.query<{ broken: string | null; rows: string; max: string | null }>(
      'SELECT audit_verify_chain() AS broken, (SELECT count(*) FROM audit_logs) AS rows, (SELECT max(chain_seq) FROM audit_logs) AS max');
    const firstBrokenSeq = chain.rows[0]!.broken === null ? null : Number(chain.rows[0]!.broken);
    const chainRows = Number(chain.rows[0]!.rows);
    const maxSeq = Number(chain.rows[0]!.max ?? 0);
    if (firstBrokenSeq !== null) findings.push({ code: 'chain_broken', seq: firstBrokenSeq });
    if (chainRows !== maxSeq) findings.push({ code: 'chain_gap', detail: `${chainRows} rows, highest sequence ${maxSeq}` });

    // 2. Checkpoints (newest first).
    const { rows } = await db.query('SELECT * FROM audit_checkpoints ORDER BY id DESC LIMIT $1', [VERIFY_CHECKPOINT_LIMIT]);
    const checkpoints = rows.map(rowToCheckpoint);
    if (!key && checkpoints.length) findings.push({ code: 'checkpoint_key_missing', detail: 'signatures cannot be checked without AUDIT_CHECKPOINT_KEY' });
    for (const cp of checkpoints) {
      if (key) {
        if (cp.keyId !== currentKeyId) findings.push({ code: 'checkpoint_unknown_key', checkpointId: cp.id, detail: cp.keyId });
        else {
          const expected = signCheckpoint(key, cp);
          if (expected.length !== cp.signature.length || !timingSafeEqual(expected, cp.signature)) findings.push({ code: 'checkpoint_signature_invalid', checkpointId: cp.id });
        }
      }
      if (cp.auditLastSeq > 0) {
        const at = await db.query<{ hash: Buffer }>('SELECT hash FROM audit_logs WHERE chain_seq = $1', [cp.auditLastSeq]);
        if (!at.rowCount) findings.push({ code: 'audit_rows_missing', checkpointId: cp.id, seq: cp.auditLastSeq });
        else if (!at.rows[0]!.hash.equals(cp.auditLastHash!)) findings.push({ code: 'audit_head_mismatch', checkpointId: cp.id, seq: cp.auditLastSeq });
      }
      const d = await db.query<{ event_count: string; digest: Buffer }>('SELECT event_count, digest FROM custody_events_digest($1)', [cp.custodyLastId]);
      if (Number(d.rows[0]!.event_count) !== cp.custodyCount || !d.rows[0]!.digest.equals(cp.custodyDigest)) {
        findings.push({ code: 'custody_digest_mismatch', checkpointId: cp.id, detail: `expected ${cp.custodyCount} events, found ${d.rows[0]!.event_count}` });
      }
    }

    // 3. External sink: every copy must still match a database row, and every row that claims a
    // copy must still have one. A deleted or altered checkpoint row is caught here.
    const dir = sinkDir(deps);
    if (dir) {
      let files: string[] = [];
      try { files = (await readdir(dir)).filter((f) => /^checkpoint-.*\.json$/.test(f)); } catch { /* no folder yet */ }
      const byRef = new Map(checkpoints.filter((c) => c.sinkRef).map((c) => [c.sinkRef!, c]));
      const oldestChecked = checkpoints.at(-1)?.id ?? 0;
      for (const f of files) {
        let doc: Record<string, unknown>;
        try { doc = JSON.parse(await readFile(path.join(dir, f), 'utf8')); } catch { findings.push({ code: 'sink_file_unreadable', detail: f }); continue; }
        const cp = byRef.get(f);
        if (!cp) {
          if (typeof doc.id === 'number' && doc.id < oldestChecked) continue; // older than the checked window
          findings.push({ code: 'checkpoint_missing_in_database', detail: f });
          continue;
        }
        if (JSON.stringify(doc) !== JSON.stringify(sinkDocument(cp))) findings.push({ code: 'sink_copy_mismatch', checkpointId: cp.id, detail: f });
      }
      const present = new Set(files);
      for (const cp of checkpoints) if (cp.sink === 'file' && cp.sinkRef && !present.has(cp.sinkRef)) findings.push({ code: 'sink_file_missing', checkpointId: cp.id, detail: cp.sinkRef });
    }
    return { chainRows, firstBrokenSeq, checkpoints };
  });

  const outcome = findings.filter((f) => f.code !== 'checkpoint_key_missing').length ? 'failed' : 'ok';
  const durationMs = Date.now() - started;
  const db: Queryable = deps.db;
  const ins = await db.query<{ id: string }>(
    `INSERT INTO audit_verifications (run_by, trigger, outcome, chain_rows, first_broken_seq, checkpoints_checked, findings, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [opts.actorUserId, opts.trigger, outcome, chainRows, firstBrokenSeq, checkpoints.length, JSON.stringify(findings), durationMs]);
  await audit(db, {
    ...(opts.meta ?? {}), actorUserId: opts.actorUserId, actorRole: (opts.meta?.actorRole as string | undefined) ?? (opts.actorUserId ? null : 'scheduler'),
    action: 'audit.integrity_verified', outcome: outcome === 'ok' ? 'success' : 'failure', targetType: 'audit_verification', targetId: ins.rows[0]!.id,
    metadata: { trigger: opts.trigger, chainRows, firstBrokenSeq, checkpointsChecked: checkpoints.length, findings: findings.map((f) => f.code) },
  });
  return { outcome, chainRows, firstBrokenSeq, checkpointsChecked: checkpoints.length, findings, durationMs, verificationId: Number(ins.rows[0]!.id) };
}

export async function integritySummary(deps: Deps) {
  const db = deps.db;
  const head = await db.query<{ rows: string; max: string | null; oldest: Date | null }>(
    'SELECT count(*) AS rows, max(chain_seq) AS max, min(occurred_at) AS oldest FROM audit_logs');
  const cps = await db.query('SELECT * FROM audit_checkpoints ORDER BY id DESC LIMIT 20');
  const vs = await db.query(
    `SELECT id, run_at, run_by IS NOT NULL AS manual, trigger, outcome, chain_rows, first_broken_seq, checkpoints_checked, findings, duration_ms
       FROM audit_verifications ORDER BY id DESC LIMIT 20`);
  const custody = await db.query<{ n: string }>('SELECT count(*) AS n FROM custody_events');
  return {
    configuration: {
      checkpointKeyConfigured: Boolean(deps.config.auditCheckpointKey),
      checkpointKeyId: deps.config.auditCheckpointKey ? keyFingerprint(deps.config.auditCheckpointKey) : null,
      sink: deps.config.auditCheckpointDir ? 'file' : 'none',
    },
    chain: { rows: Number(head.rows[0]!.rows), lastSeq: Number(head.rows[0]!.max ?? 0), oldestEntryAt: head.rows[0]!.oldest },
    custodyEvents: Number(custody.rows[0]!.n),
    checkpoints: cps.rows.map(rowToCheckpoint).map((c) => ({
      id: c.id, createdAt: c.createdAt, auditLastSeq: c.auditLastSeq, custodyCount: c.custodyCount, keyId: c.keyId, sink: c.sink,
      auditLastHash: hex(c.auditLastHash).slice(0, 16), custodyDigest: hex(c.custodyDigest).slice(0, 16),
    })),
    verifications: vs.rows.map((v) => ({
      id: Number(v.id), runAt: v.run_at, trigger: v.trigger, outcome: v.outcome, chainRows: Number(v.chain_rows),
      firstBrokenSeq: v.first_broken_seq === null ? null : Number(v.first_broken_seq), checkpointsChecked: v.checkpoints_checked,
      findings: v.findings, durationMs: v.duration_ms,
    })),
  };
}
