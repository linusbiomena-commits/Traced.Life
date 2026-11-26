import type { Queryable } from '../../db/pool.ts';
import { ageParts, riyadhToday } from './rules.ts';

// Customer-facing reads. Every query is scoped by account_user_id: a customer can only ever load
// their own rows, and someone else's registration id behaves exactly like a non-existent one.

type Row = {
  id: string;
  created_at: Date;
  status: string;
  tracking_id: string | null;
  product: string;
  sample_type: string;
  collection_country: string;
  relationship: string;
  first_name: string;
  last_name: string;
  date_of_birth: string;
  gender: string;
  contact_full_name: string;
  contact_email: string;
  contact_phone: string;
  branch_id: string;
  branch_code: string;
  name_en: string;
  name_ar: string;
  city_en: string;
  city_ar: string;
  address_en: string;
  address_ar: string;
};

const SELECT = `
  SELECT r.id, r.created_at, r.status, r.tracking_id, r.product, r.sample_type, r.collection_country,
         p.relationship, p.first_name, p.last_name, to_char(p.date_of_birth, 'YYYY-MM-DD') AS date_of_birth, p.gender,
         r.contact_full_name, r.contact_email, r.contact_phone,
         b.id AS branch_id, b.code AS branch_code, b.name_en, b.name_ar, b.city_en, b.city_ar, b.address_en, b.address_ar
    FROM registrations r
    JOIN patients p ON p.id = r.patient_id
    JOIN collection_branches b ON b.id = r.branch_id`;

function age(dob: string) {
  const a = ageParts(dob, riyadhToday());
  return a ? { years: a.years, months: a.months } : null;
}

/** Explicit allowlist of what a customer sees about their own registration (summary). */
function summary(r: Row) {
  return {
    id: r.id,
    createdAt: r.created_at.toISOString(),
    status: r.status,
    trackingId: r.tracking_id,
    patient: { firstName: r.first_name, lastName: r.last_name, relationship: r.relationship, gender: r.gender, age: age(r.date_of_birth) },
    branch: { id: r.branch_id, nameEn: r.name_en, nameAr: r.name_ar, cityEn: r.city_en, cityAr: r.city_ar },
  };
}

export async function listOwnRegistrations(db: Queryable, userId: string) {
  const { rows } = await db.query<Row>(`${SELECT} WHERE r.account_user_id = $1 ORDER BY r.created_at DESC LIMIT 200`, [userId]);
  return rows.map(summary);
}

export async function getOwnRegistration(db: Queryable, userId: string, id: string) {
  const { rows } = await db.query<Row>(`${SELECT} WHERE r.id = $1 AND r.account_user_id = $2`, [id, userId]);
  const r = rows[0];
  if (!r) return null;
  const consents = await db.query<{ type: string; version: string; title: string; status: string; locale: string; accepted_at: Date }>(
    `SELECT d.doc_type AS type, d.version, d.title, d.status, d.locale, c.accepted_at
       FROM consent_records c JOIN consent_documents d ON d.id = c.consent_document_id
      WHERE c.registration_id = $1 ORDER BY d.doc_type`,
    [id],
  );
  const history = await db.query<{ to_status: string; created_at: Date }>(
    'SELECT to_status, created_at FROM registration_status_history WHERE registration_id = $1 ORDER BY id',
    [id],
  );
  const base = summary(r);
  return {
    ...base,
    product: r.product,
    sampleType: r.sample_type,
    collectionCountry: r.collection_country,
    patient: { ...base.patient, dateOfBirth: r.date_of_birth },
    contact: { fullName: r.contact_full_name, email: r.contact_email, phone: r.contact_phone },
    branch: { ...base.branch, code: r.branch_code, addressEn: r.address_en, addressAr: r.address_ar },
    consents: consents.rows.map((c) => ({ type: c.type, version: c.version, title: c.title, locale: c.locale, provisional: c.status !== 'approved', acceptedAt: c.accepted_at.toISOString() })),
    statusHistory: history.rows.map((h) => ({ status: h.to_status, at: h.created_at.toISOString() })),
    // Issued in Phase 3. Reported honestly as unavailable until then.
    qrCode: { available: false },
  };
}

export async function listActiveBranches(db: Queryable) {
  const { rows } = await db.query<{ id: string; code: string; name_en: string; name_ar: string; city_en: string; city_ar: string; address_en: string; address_ar: string }>(
    `SELECT id, code, name_en, name_ar, city_en, city_ar, address_en, address_ar
       FROM collection_branches WHERE active ORDER BY sort_order, name_en`,
  );
  return rows.map((b) => ({ id: b.id, code: b.code, nameEn: b.name_en, nameAr: b.name_ar, cityEn: b.city_en, cityAr: b.city_ar, addressEn: b.address_en, addressAr: b.address_ar }));
}
