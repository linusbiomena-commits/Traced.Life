import { createHash } from 'node:crypto';
import type { Config } from '../../config.ts';
import type { Queryable } from '../../db/pool.ts';
import type { ConsentType } from '../registrations/rules.ts';

export type ConsentDocument = {
  id: string;
  type: ConsentType;
  version: string;
  locale: 'en' | 'ar';
  title: string;
  body: string;
  status: 'provisional' | 'approved';
};

/** Production may only use approved texts; development and tests may also use provisional ones. */
export function allowedConsentStatuses(config: Pick<Config, 'env'>): string[] {
  return config.env === 'production' ? ['approved'] : ['approved', 'provisional'];
}

/** The current (latest effective, non-retired) document of every type, for both locales. */
export async function currentConsentDocuments(db: Queryable, config: Pick<Config, 'env'>): Promise<ConsentDocument[]> {
  const { rows } = await db.query<ConsentDocument>(
    `SELECT DISTINCT ON (doc_type, locale)
            id, doc_type AS type, version, locale, title, body, status
       FROM consent_documents
      WHERE status = ANY($1) AND effective_from <= now()
      ORDER BY doc_type, locale, effective_from DESC, created_at DESC`,
    [allowedConsentStatuses(config)],
  );
  return rows;
}

export function contentHash(title: string, body: string): Buffer {
  return createHash('sha256').update(`${title}\n\n${body}`, 'utf8').digest();
}

export async function publishConsentDocument(
  db: Queryable,
  doc: { type: ConsentType; version: string; locale: 'en' | 'ar'; title: string; body: string; status: 'provisional' | 'approved'; approvedBy?: string | null },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO consent_documents (doc_type, version, locale, title, body, content_sha256, status, approved_by, approved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $7 = 'approved' THEN now() END)
     ON CONFLICT (doc_type, version, locale) DO NOTHING
     RETURNING id`,
    [doc.type, doc.version, doc.locale, doc.title, doc.body, contentHash(doc.title, doc.body), doc.status, doc.approvedBy ?? null],
  );
  if (rows[0]) return rows[0].id;
  const existing = await db.query<{ id: string }>('SELECT id FROM consent_documents WHERE doc_type = $1 AND version = $2 AND locale = $3', [doc.type, doc.version, doc.locale]);
  return existing.rows[0]!.id;
}
