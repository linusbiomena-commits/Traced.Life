// Phase 8E: publishing APPROVED consent documents from a release manifest (server-side command, no UI).
//
// The texts and the approval reference come from the owner's legal/clinical approval outside this system;
// this module never writes or changes wording. It validates a release, shows a dry-run plan with SHA-256
// checksums, and publishes every document of the release in ONE transaction as a new immutable version with
// status `approved`, the approval reference, the authorised publisher, the publication time and the
// effective date, plus one audit entry per document. Existing versions are never overwritten (a version that
// already exists is refused), earlier versions and customers' consent records stay untouched, and the
// database itself refuses any later change (migration 0012 trigger).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import { type Queryable, withTx } from '../../db/pool.ts';
import { audit } from '../audit/audit.service.ts';
import type { ConsentType } from '../registrations/rules.ts';
import { contentHash } from './consents.service.ts';

export const CONSENT_TYPES: readonly ConsentType[] = ['privacy_policy', 'sample_collection_consent', 'accuracy_declaration', 'guardian_authorization'];
export const LOCALES = ['en', 'ar'] as const;
export type Target = 'production' | 'preview' | 'development';

export type ManifestDocument = { type: string; locale: string; title: string; bodyFile?: string; body?: string; version?: string; approvalReference?: string };
export type Manifest = { version?: string; effectiveFrom?: string; approvalReference?: string; documents?: ManifestDocument[] };

export type ReleaseDocument = {
  type: ConsentType; locale: 'en' | 'ar'; version: string; title: string; body: string; approvalReference: string; sha256: string;
};
export type Release = { effectiveFrom: Date; documents: ReleaseDocument[] };

export class ReleaseError extends Error {
  constructor(readonly problems: string[]) {
    super(`Consent release refused:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
}

const VERSION_RE = /^[0-9A-Za-z.\-]{1,32}$/;
// Markers of placeholder or provisional wording: such text must never be published as approved.
const PLACEHOLDER_RE = /provisional|not legally approved|for development and testing only|lorem ipsum|\bTODO\b|\bTBD\b|\[placeholder|\bdraft\b|مسودة/i;
const SYNTHETIC_RE = /synthetic/i;
const ARABIC_RE = /[؀-ۿ]/;
const LATIN_RE = /[A-Za-z]/;

function cleanText(s: string): string {
  return s.replace(/^﻿/, '').replace(/\r\n?/g, '\n').normalize('NFC').trim();
}

/**
 * Validates a manifest (no database access). bodyFile paths are read relative to `baseDir`.
 * `partial` allows a release that contains only some document types (the database check in `planRelease`
 * then requires that every missing type already has an approved version in both languages).
 */
export function validateRelease(manifest: Manifest, opts: { baseDir: string; target: Target; now?: Date; partial?: boolean }): Release {
  const problems: string[] = [];
  const now = opts.now ?? new Date();
  if (!manifest || typeof manifest !== 'object') throw new ReleaseError(['the manifest is not a JSON object']);

  let effectiveFrom = new Date(NaN);
  if (!manifest.effectiveFrom || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(manifest.effectiveFrom)) {
    problems.push('effectiveFrom is required as an ISO date-time with a time zone, e.g. 2026-12-01T00:00:00+03:00');
  } else {
    effectiveFrom = new Date(manifest.effectiveFrom);
    if (Number.isNaN(effectiveFrom.getTime())) problems.push('effectiveFrom is not a valid date');
    else if (effectiveFrom.getTime() < now.getTime() - 5 * 60_000) problems.push('effectiveFrom is in the past (back-dating is not allowed)');
    else if (effectiveFrom.getTime() > now.getTime() + 366 * 86_400_000) problems.push('effectiveFrom is more than a year ahead');
  }

  const docs = Array.isArray(manifest.documents) ? manifest.documents : [];
  if (!docs.length) problems.push('documents is empty');
  const out: ReleaseDocument[] = [];
  const seen = new Set<string>();
  docs.forEach((d, i) => {
    const where = `documents[${i}]${d?.type ? ` (${d.type}/${d.locale})` : ''}`;
    if (!CONSENT_TYPES.includes(d?.type as ConsentType)) { problems.push(`${where}: type must be one of ${CONSENT_TYPES.join(', ')}`); return; }
    if (!LOCALES.includes(d.locale as 'en')) { problems.push(`${where}: locale must be en or ar`); return; }
    const key = `${d.type}/${d.locale}`;
    if (seen.has(key)) { problems.push(`${where}: duplicate ${key}`); return; }
    seen.add(key);

    const version = (d.version ?? manifest.version ?? '').trim();
    if (!VERSION_RE.test(version)) problems.push(`${where}: version is required (1-32 characters: letters, digits, dot, hyphen)`);
    else if (/provisional|draft|test/i.test(version)) problems.push(`${where}: version "${version}" looks provisional; approved versions must not contain provisional/draft/test`);

    const ref = (d.approvalReference ?? manifest.approvalReference ?? '').trim();
    if (ref.length < 3 || ref.length > 200 || /[\r\n]/.test(ref)) problems.push(`${where}: approvalReference is required (3-200 characters, one line)`);

    const title = cleanText(d.title ?? '');
    if (!title) problems.push(`${where}: title is required`);
    else if (title.length > 200) problems.push(`${where}: title is longer than 200 characters`);

    let body = '';
    if (d.bodyFile && d.body) problems.push(`${where}: give either body or bodyFile, not both`);
    else if (d.bodyFile) {
      const file = path.resolve(opts.baseDir, d.bodyFile);
      if (!file.startsWith(path.resolve(opts.baseDir) + path.sep)) problems.push(`${where}: bodyFile must be inside the release folder`);
      else {
        try { body = cleanText(readFileSync(file, 'utf8')); } catch { problems.push(`${where}: bodyFile ${d.bodyFile} cannot be read`); }
      }
    } else body = cleanText(d.body ?? '');
    if (!body) problems.push(`${where}: body text is required`);
    else if (body.length > 20000) problems.push(`${where}: body is longer than 20,000 characters`);
    if (body.includes('\u0000')) problems.push(`${where}: body contains a NUL character`);

    const text = `${title}\n${body}`;
    if (PLACEHOLDER_RE.test(text)) problems.push(`${where}: text contains provisional/placeholder wording; only final approved text can be published`);
    if (d.locale === 'ar' && (!ARABIC_RE.test(title) || !ARABIC_RE.test(body))) problems.push(`${where}: the Arabic document contains no Arabic text (title and body must both be in Arabic)`);
    if (d.locale === 'en' && (!LATIN_RE.test(title) || !LATIN_RE.test(body))) problems.push(`${where}: the English document contains no English text`);
    if (opts.target === 'production' && (SYNTHETIC_RE.test(text) || SYNTHETIC_RE.test(ref))) problems.push(`${where}: synthetic test content can never be published to production`);

    out.push({ type: d.type as ConsentType, locale: d.locale as 'en' | 'ar', version, title, body, approvalReference: ref, sha256: contentHash(title, body).toString('hex') });
  });

  // Completeness: every type in the release in BOTH languages; the whole set unless --partial.
  const types = new Set(out.map((d) => d.type));
  for (const t of types) for (const l of LOCALES) if (!seen.has(`${t}/${l}`)) problems.push(`${t}: the ${l === 'en' ? 'English' : 'Arabic'} version is missing (each document needs both languages)`);
  if (!opts.partial) for (const t of CONSENT_TYPES) if (!types.has(t)) problems.push(`${t}: missing from the release (use --partial only to add to an existing approved set)`);
  for (const t of types) {
    const versions = new Set(out.filter((d) => d.type === t).map((d) => d.version));
    if (versions.size > 1) problems.push(`${t}: English and Arabic must have the same version`);
  }

  if (problems.length) throw new ReleaseError(problems);
  return { effectiveFrom, documents: out };
}

export type Publisher = { id: string; mfa: boolean };
export type Plan = Release & { publisher: Publisher; target: Target; database: string };

/** Read-only checks against the database: target/database match, publisher authority, no overwrite, completeness. */
export async function planRelease(db: Queryable, release: Release, opts: { publisherEmail: string; target: Target; partial?: boolean }): Promise<Plan> {
  const problems: string[] = [];
  const { rows: [dbRow] } = await db.query<{ db: string }>('SELECT current_database() AS db');
  const database = dbRow!.db;
  if (opts.target === 'production' && database !== 'traced') problems.push(`target production requires the production database "traced" (connected to "${database}")`);
  if (opts.target !== 'production' && database === 'traced') problems.push('connected to the production database "traced": use --target production');

  const { rows: users } = await db.query<{ id: string; status: string; mfa: boolean; can: boolean }>(
    `SELECT u.id, u.status, u.mfa_enabled_at IS NOT NULL AS mfa,
            EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_key = ur.role_key
                     WHERE ur.user_id = u.id AND rp.permission_key = 'consent.manage') AS can
       FROM users u WHERE lower(u.email) = lower($1)`,
    [opts.publisherEmail.trim()],
  );
  const u = users[0];
  if (!u) problems.push('the publisher account does not exist');
  else {
    if (u.status !== 'active') problems.push('the publisher account is not active');
    if (!u.can) problems.push('the publisher is not authorised to publish consent documents (needs consent.manage: super administrator)');
    if (opts.target === 'production' && !u.mfa) problems.push('in production the publisher must have two-step verification enrolled');
  }

  for (const d of release.documents) {
    const { rows } = await db.query<{ status: string; same: boolean }>(
      'SELECT status, content_sha256 = $4 AS same FROM consent_documents WHERE doc_type = $1 AND version = $2 AND locale = $3',
      [d.type, d.version, d.locale, Buffer.from(d.sha256, 'hex')],
    );
    if (rows[0]) problems.push(`${d.type}/${d.locale} version ${d.version} already exists (${rows[0].status}${rows[0].same ? ', identical text' : ', DIFFERENT text'}); existing versions are never overwritten: use a new version number`);
  }

  if (opts.partial) {
    const inRelease = new Set(release.documents.map((d) => d.type));
    for (const t of CONSENT_TYPES) {
      if (inRelease.has(t)) continue;
      const { rows } = await db.query<{ n: number }>(
        `SELECT count(DISTINCT locale)::int AS n FROM consent_documents WHERE doc_type = $1 AND status = 'approved' AND effective_from <= $2`,
        [t, release.effectiveFrom],
      );
      if ((rows[0]?.n ?? 0) < 2) problems.push(`${t}: not in this partial release and no approved English + Arabic version exists; the approved set would be incomplete`);
    }
  }

  if (problems.length) throw new ReleaseError(problems);
  return { ...release, publisher: { id: u!.id, mfa: u!.mfa }, target: opts.target, database };
}

/** Publishes the whole plan in one transaction (all documents or none) with one audit entry per document. */
export async function publishRelease(pool: pg.Pool, plan: Plan): Promise<{ ids: string[] }> {
  return withTx(pool, async (client) => {
    const ids: string[] = [];
    for (const d of plan.documents) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO consent_documents (doc_type, version, locale, title, body, content_sha256, status, effective_from,
                                        approved_by, approved_at, approval_reference, published_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'approved', $7, $8, now(), $9, $8)
         RETURNING id`,
        [d.type, d.version, d.locale, d.title, d.body, Buffer.from(d.sha256, 'hex'), plan.effectiveFrom, plan.publisher.id, d.approvalReference],
      );
      ids.push(rows[0]!.id);
      await audit(client, {
        action: 'consent.published', outcome: 'success', actorUserId: plan.publisher.id, actorRole: 'super_admin',
        targetType: 'consent_document', targetId: rows[0]!.id, userAgent: 'publish-consent-cli',
        metadata: { docType: d.type, locale: d.locale, version: d.version, sha256: d.sha256, approvalReference: d.approvalReference, effectiveFrom: plan.effectiveFrom.toISOString(), target: plan.target },
      });
    }
    return { ids };
  });
}

/** One line per document for the dry run and the publish report (no personal data; titles are public texts). */
export function describePlan(plan: Plan): string[] {
  return [
    `Target: ${plan.target} (database ${plan.database}); effective from ${plan.effectiveFrom.toISOString()}; publisher account ${plan.publisher.id}${plan.publisher.mfa ? ' (MFA enrolled)' : ''}`,
    ...plan.documents.map((d) => `  ${d.type.padEnd(26)} ${d.locale}  v${d.version.padEnd(10)} sha256 ${d.sha256}  ${d.body.length} chars  ref "${d.approvalReference}"  "${d.title}"`),
  ];
}
