import type { Queryable } from '../../db/pool.ts';
import { publishConsentDocument } from '../consents/consents.service.ts';
import { PROVISIONAL_CONSENTS, PROVISIONAL_VERSION } from '../consents/provisional-content.ts';
import type { ConsentType } from '../registrations/rules.ts';
import { PROVISIONAL_INSTRUCTIONS, PROVISIONAL_INSTRUCTIONS_VERSION, publishInstructions } from '../collection/instructions.ts';

// Development/test data only. Branch names are marked [DEV] so they can never be mistaken for real
// locations. Real branches are created by admins (Phase 5). Never run against production.

export const DEV_BRANCHES = [
  { code: 'DEV-RUH-01', name_en: '[DEV] Riyadh sample branch', name_ar: '[تجريبي] فرع الرياض', city_en: 'Riyadh', city_ar: 'الرياض', address_en: 'Development data – not a real location', address_ar: 'بيانات تجريبية – ليس موقعًا حقيقيًا', sort_order: 1 },
  { code: 'DEV-JED-01', name_en: '[DEV] Jeddah sample branch', name_ar: '[تجريبي] فرع جدة', city_en: 'Jeddah', city_ar: 'جدة', address_en: 'Development data – not a real location', address_ar: 'بيانات تجريبية – ليس موقعًا حقيقيًا', sort_order: 2 },
  { code: 'DEV-DMM-01', name_en: '[DEV] Dammam sample branch', name_ar: '[تجريبي] فرع الدمام', city_en: 'Dammam', city_ar: 'الدمام', address_en: 'Development data – not a real location', address_ar: 'بيانات تجريبية – ليس موقعًا حقيقيًا', sort_order: 3 },
] as const;

export async function seedDevData(db: Queryable, env: string): Promise<{ branches: number; consents: number }> {
  if (env === 'production') throw new Error('Refusing to seed development data in production.');
  let branches = 0;
  for (const b of DEV_BRANCHES) {
    const r = await db.query(
      `INSERT INTO collection_branches (code, name_en, name_ar, city_en, city_ar, address_en, address_ar, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (code) DO NOTHING`,
      [b.code, b.name_en, b.name_ar, b.city_en, b.city_ar, b.address_en, b.address_ar, b.sort_order],
    );
    branches += r.rowCount ?? 0;
  }
  let consents = 0;
  for (const [type, byLocale] of Object.entries(PROVISIONAL_CONSENTS) as [ConsentType, (typeof PROVISIONAL_CONSENTS)[ConsentType]][]) {
    for (const locale of ['en', 'ar'] as const) {
      await publishConsentDocument(db, { type, version: PROVISIONAL_VERSION, locale, ...byLocale[locale], status: 'provisional' });
      consents++;
    }
  }
  for (const locale of ['en', 'ar'] as const) {
    await publishInstructions(db, { version: PROVISIONAL_INSTRUCTIONS_VERSION, locale, ...PROVISIONAL_INSTRUCTIONS[locale], status: 'provisional' });
  }
  return { branches, consents };
}
