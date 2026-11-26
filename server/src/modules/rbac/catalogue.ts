// Role/permission catalogue. The database (migration 0003) is the source of truth at runtime;
// this file gives the code type-safe keys, and a test asserts both stay identical.

export const ROLES = {
  customer: { requiresMfa: false },
  collection_staff: { requiresMfa: false },
  lab_operator: { requiresMfa: true },
  admin: { requiresMfa: true },
  super_admin: { requiresMfa: true },
  auditor: { requiresMfa: true },
} as const;

export type RoleKey = keyof typeof ROLES;

export const PERMISSIONS = [
  'registration.create_own',
  'registration.read_own',
  'collection.scan',
  'collection.collect',
  'custody.record_branch',
  'custody.record_lab',
  'custody.correct',
  'registration.read_full',
  'registration.manage',
  'qr.revoke',
  'email.manage',
  'staff.manage',
  'branch.manage',
  'audit.read',
  'stats.read',
  'report.export',
  'report.export_pii',
  'admin.manage',
  'form.approve',
  'consent.manage',
  'instructions.draft',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ADMIN_COMMON: Permission[] = [
  'custody.record_branch', 'custody.record_lab', 'custody.correct',
  'registration.read_full', 'registration.manage', 'qr.revoke', 'email.manage',
  'staff.manage', 'branch.manage', 'audit.read', 'stats.read', 'report.export', 'instructions.draft',
];

export const ROLE_PERMISSIONS: Record<RoleKey, Permission[]> = {
  customer: ['registration.create_own', 'registration.read_own'],
  collection_staff: ['collection.scan', 'collection.collect', 'custody.record_branch'],
  lab_operator: ['custody.record_lab'],
  admin: ADMIN_COMMON,
  super_admin: [...ADMIN_COMMON, 'report.export_pii', 'admin.manage', 'form.approve', 'consent.manage'],
  auditor: ['audit.read', 'stats.read', 'report.export'],
};

/** Roles that may only be granted to staff-side accounts (never mixed with `customer`). */
export const STAFF_SIDE_ROLES: RoleKey[] = ['collection_staff', 'lab_operator', 'admin', 'super_admin', 'auditor'];

export function isRoleKey(value: string): value is RoleKey {
  return Object.hasOwn(ROLES, value);
}
