-- Phase 7: indexes found missing by the synthetic-data performance run (docs/performance/).
-- Additive only. All small at the expected volume; CREATE INDEX (not CONCURRENTLY) because
-- migrations run inside a transaction and the tables are small at launch.

-- QR status lookups by registration without the status = 'active' filter (admin list, collection
-- "newer token" check) could not use the partial unique index and scanned the whole table.
CREATE INDEX customer_qr_tokens_registration_idx ON customer_qr_tokens (registration_id, created_at DESC);

-- Dashboard activity feed: newest staff-side audit entries (customer actions excluded).
CREATE INDEX audit_logs_staff_activity_idx ON audit_logs (chain_seq DESC)
  WHERE actor_role IS NOT NULL AND actor_role <> 'customer';

-- Operational report and dashboard: collections and lab events by date.
CREATE INDEX samples_collected_idx ON samples (collected_at);
CREATE INDEX custody_events_occurred_idx ON custody_events (occurred_at, to_status);
CREATE INDEX registrations_cancelled_idx ON registrations (cancelled_at) WHERE status = 'cancelled';
