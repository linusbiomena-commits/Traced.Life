-- Phase 1: accounts, roles/permissions, sessions, one-time tokens, MFA recovery codes.
-- gen_random_uuid() is built into PostgreSQL 13+; no extensions required.

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Account holders: customers (who may register a child as the patient), staff and admins.
-- Patient details live in a separate table (Phase 2), never here.
CREATE TABLE users (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                  text NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  password_hash          text,                       -- NULL until an invited account sets a password
  email_verified_at      timestamptz,
  status                 text NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'suspended', 'deactivated')),
  locale                 text NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'ar')),
  mfa_totp_secret_enc    text,                       -- AES-256-GCM, application-encrypted
  mfa_pending_secret_enc text,                       -- secret shown during enrolment, not yet confirmed
  mfa_enabled_at         timestamptz,
  mfa_last_used_step     bigint,                     -- TOTP replay protection
  failed_login_count     integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until           timestamptz,
  last_login_at          timestamptz,
  password_changed_at    timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (email);
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE roles (
  key          text PRIMARY KEY CHECK (key ~ '^[a-z_]+$'),
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  requires_mfa boolean NOT NULL DEFAULT false
);

CREATE TABLE permissions (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z_]+\.[a-z_]+$'),
  description text NOT NULL DEFAULT ''
);

CREATE TABLE role_permissions (
  role_key       text NOT NULL REFERENCES roles (key) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions (key) ON DELETE CASCADE,
  PRIMARY KEY (role_key, permission_key)
);

CREATE TABLE user_roles (
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role_key   text NOT NULL REFERENCES roles (key),
  granted_by uuid REFERENCES users (id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_key)
);
CREATE INDEX user_roles_role_key_idx ON user_roles (role_key);

-- Opaque session tokens; only an HMAC of the token is stored.
CREATE TABLE sessions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash           bytea NOT NULL UNIQUE,
  user_id              uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL,                  -- absolute lifetime
  idle_timeout_seconds integer NOT NULL CHECK (idle_timeout_seconds > 0),
  mfa_verified_at      timestamptz,
  ip                   inet,
  user_agent           text CHECK (length(user_agent) <= 512),
  revoked_at           timestamptz,
  revoke_reason        text
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id) WHERE revoked_at IS NULL;

-- Single-use tokens sent by email (verification, password reset, invited-account setup).
CREATE TABLE auth_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose    text NOT NULL CHECK (purpose IN ('verify_email', 'reset_password', 'account_setup')),
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_user_purpose_idx ON auth_tokens (user_id, purpose) WHERE used_at IS NULL;

CREATE TABLE mfa_recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash  bytea NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, code_hash)
);
