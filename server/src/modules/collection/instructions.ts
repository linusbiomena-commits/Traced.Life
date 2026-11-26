import { createHash } from 'node:crypto';
import type { Config } from '../../config.ts';
import type { Queryable } from '../../db/pool.ts';

export type ChecklistItem = { id: string; label: string };
export type CollectionInstructions = {
  id: string;
  version: string;
  locale: 'en' | 'ar';
  title: string;
  steps: string[];
  checklist: ChecklistItem[];
  provisional: boolean;
};

/** Production may only use approved instructions; development/tests may also use provisional ones. */
function allowedStatuses(config: Pick<Config, 'env'>): string[] {
  return config.env === 'production' ? ['approved'] : ['approved', 'provisional'];
}

/** Current instructions for each locale (latest effective, non-retired, allowed status). */
export async function currentInstructions(db: Queryable, config: Pick<Config, 'env'>): Promise<CollectionInstructions[]> {
  const { rows } = await db.query<{ id: string; version: string; locale: 'en' | 'ar'; title: string; steps: string[]; checklist: ChecklistItem[]; status: string }>(
    `SELECT DISTINCT ON (locale) id, version, locale, title, steps, checklist, status
       FROM collection_instructions
      WHERE status = ANY($1) AND effective_from <= now()
      ORDER BY locale, effective_from DESC, created_at DESC`,
    [allowedStatuses(config)],
  );
  return rows.map((r) => ({ id: r.id, version: r.version, locale: r.locale, title: r.title, steps: r.steps, checklist: r.checklist, provisional: r.status !== 'approved' }));
}

export async function publishInstructions(
  db: Queryable,
  doc: { version: string; locale: 'en' | 'ar'; title: string; steps: string[]; checklist: ChecklistItem[]; status: 'provisional' | 'approved' },
): Promise<string> {
  const hash = createHash('sha256').update(JSON.stringify([doc.title, doc.steps, doc.checklist])).digest();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO collection_instructions (version, locale, title, steps, checklist, content_sha256, status, approved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $7 = 'approved' THEN now() END)
     ON CONFLICT (version, locale) DO NOTHING RETURNING id`,
    [doc.version, doc.locale, doc.title, JSON.stringify(doc.steps), JSON.stringify(doc.checklist), hash, doc.status],
  );
  if (rows[0]) return rows[0].id;
  return (await db.query<{ id: string }>('SELECT id FROM collection_instructions WHERE version = $1 AND locale = $2', [doc.version, doc.locale])).rows[0]!.id;
}

// PROVISIONAL placeholder content for local development. It deliberately contains NO clinical
// procedure: the laboratory-approved hair collection procedure must be supplied and approved
// (status 'approved') before production, which refuses provisional instructions.
export const PROVISIONAL_INSTRUCTIONS_VERSION = '0.1-provisional';
export const PROVISIONAL_INSTRUCTIONS: Record<'en' | 'ar', { title: string; steps: string[]; checklist: ChecklistItem[] }> = {
  en: {
    title: '[PROVISIONAL – NOT APPROVED] TRACED hair sample collection',
    steps: [
      'Check that the QR code is valid for this branch on this screen.',
      'Complete the approved identity verification step before collecting.',
      'Follow the laboratory-approved TRACED hair collection procedure. (The procedure itself is not part of this provisional version.)',
      'Seal, label and store the sample exactly as the laboratory instructs.',
    ],
    checklist: [
      { id: 'qr_checked', label: 'QR code checked for this branch' },
      { id: 'identity_verified', label: 'Identity verification completed' },
      { id: 'procedure_followed', label: 'Laboratory collection procedure followed' },
      { id: 'sample_secured', label: 'Sample sealed and stored as instructed' },
    ],
  },
  ar: {
    title: '[مؤقت – غير معتمد] جمع عينة الشعر لاختبار TRACED',
    steps: [
      'تحقق على هذه الشاشة من أن رمز QR صالح لهذا الفرع.',
      'أكمل خطوة التحقق من الهوية المعتمدة قبل جمع العينة.',
      'اتبع إجراء جمع عينة الشعر المعتمد من المختبر لاختبار TRACED. (الإجراء نفسه غير مضمّن في هذه النسخة المؤقتة.)',
      'أغلق العينة وضع عليها الملصق واحفظها كما يوجّه المختبر تمامًا.',
    ],
    checklist: [
      { id: 'qr_checked', label: 'تم التحقق من رمز QR لهذا الفرع' },
      { id: 'identity_verified', label: 'اكتمل التحقق من الهوية' },
      { id: 'procedure_followed', label: 'تم اتباع إجراء الجمع المعتمد من المختبر' },
      { id: 'sample_secured', label: 'تم إغلاق العينة وحفظها حسب التعليمات' },
    ],
  },
};
