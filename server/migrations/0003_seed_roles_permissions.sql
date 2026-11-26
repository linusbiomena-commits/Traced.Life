-- Phase 1: role and permission catalogue. Must match server/src/modules/rbac/catalogue.ts
-- (a test enforces this). Later phases add endpoints that check these keys.

INSERT INTO roles (key, name, description, requires_mfa) VALUES
  ('customer',         'Customer',         'Registers patients and views only their own registrations.', false),
  ('collection_staff', 'Collection staff', 'Scans QR codes and records collection at assigned branches. Sees patient age and gender only.', false),
  ('lab_operator',     'Lab operator',     'Records laboratory-side custody statuses. Optional role; admins cover it until approved.', true),
  ('admin',            'Admin',            'Operations administrator with access to personal data (audited).', true),
  ('super_admin',      'Super admin',      'Manages admins, form versions and consent documents.', true),
  ('auditor',          'Auditor',          'Read-only access to audit logs and non-personal reports. Optional role.', true);

INSERT INTO permissions (key, description) VALUES
  ('registration.create_own', 'Create registrations for own account'),
  ('registration.read_own',   'Read own registrations, QR codes and status'),
  ('collection.scan',         'Validate a customer QR code at an assigned branch'),
  ('collection.collect',      'Confirm sample collection and print labels at an assigned branch'),
  ('custody.record_branch',   'Record branch-side custody events (package, ready, dispatch)'),
  ('custody.record_lab',      'Record laboratory-side custody events'),
  ('custody.correct',         'Append correction events to custody history'),
  ('registration.read_full',  'Read complete registration and patient personal data'),
  ('registration.manage',     'Edit or cancel any registration'),
  ('qr.revoke',               'Revoke and regenerate customer QR codes'),
  ('email.manage',            'View and retry email deliveries'),
  ('staff.manage',            'Invite, activate, suspend and deactivate staff; assign branches'),
  ('branch.manage',           'Create and edit collection branches'),
  ('audit.read',              'Read audit logs'),
  ('stats.read',              'Read aggregate registration and collection statistics'),
  ('report.export',           'Export operational reports without personal data'),
  ('report.export_pii',       'Export reports that include personal data'),
  ('admin.manage',            'Create admins and change their roles'),
  ('form.approve',            'Approve registration form versions'),
  ('consent.manage',          'Publish consent and privacy document versions');

INSERT INTO role_permissions (role_key, permission_key) VALUES
  ('customer', 'registration.create_own'),
  ('customer', 'registration.read_own'),

  ('collection_staff', 'collection.scan'),
  ('collection_staff', 'collection.collect'),
  ('collection_staff', 'custody.record_branch'),

  ('lab_operator', 'custody.record_lab'),

  ('admin', 'custody.record_branch'),
  ('admin', 'custody.record_lab'),
  ('admin', 'custody.correct'),
  ('admin', 'registration.read_full'),
  ('admin', 'registration.manage'),
  ('admin', 'qr.revoke'),
  ('admin', 'email.manage'),
  ('admin', 'staff.manage'),
  ('admin', 'branch.manage'),
  ('admin', 'audit.read'),
  ('admin', 'stats.read'),
  ('admin', 'report.export'),

  ('super_admin', 'custody.record_branch'),
  ('super_admin', 'custody.record_lab'),
  ('super_admin', 'custody.correct'),
  ('super_admin', 'registration.read_full'),
  ('super_admin', 'registration.manage'),
  ('super_admin', 'qr.revoke'),
  ('super_admin', 'email.manage'),
  ('super_admin', 'staff.manage'),
  ('super_admin', 'branch.manage'),
  ('super_admin', 'audit.read'),
  ('super_admin', 'stats.read'),
  ('super_admin', 'report.export'),
  ('super_admin', 'report.export_pii'),
  ('super_admin', 'admin.manage'),
  ('super_admin', 'form.approve'),
  ('super_admin', 'consent.manage'),

  ('auditor', 'audit.read'),
  ('auditor', 'stats.read'),
  ('auditor', 'report.export');
