-- ===========================================================================
-- Platform SQL: everything drizzle-kit cannot express.
--   * tenant context functions + row-level security (RLS) on tenant tables
--   * partitioned audit log and integration event tables
--   * ticket / visit / article number sequences
--   * trigram indexes for fuzzy search
-- Applied after the generated schema migrations; written to be idempotent.
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Tenant context. The application sets these per transaction:
--   SELECT set_config('app.user_id', '<uuid>', true);
--   SELECT set_config('app.all_customers', 'true'|'false', true);
--   SELECT set_config('app.customer_ids', '<uuid>,<uuid>', true);
-- When nothing is set the functions evaluate to "no access" (fail closed).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_all_customers() RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT coalesce(nullif(current_setting('app.all_customers', true), ''), 'false')::boolean;
$$;

CREATE OR REPLACE FUNCTION app_customer_ids() RETURNS uuid[]
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT coalesce(
    string_to_array(nullif(current_setting('app.customer_ids', true), ''), ',')::uuid[],
    ARRAY[]::uuid[]
  );
$$;

CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid;
$$;

-- True for MSP staff (users.user_type = 'msp'); false for customer users, API keys and when nothing is set.
CREATE OR REPLACE FUNCTION app_is_msp() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM users u WHERE u.id = app_user_id() AND u.user_type = 'msp');
$$;

-- Apply RLS to every table that carries a customer_id column. Rows with a
-- NULL customer_id are global (shared) rows and remain visible.
CREATE OR REPLACE FUNCTION app_apply_tenant_rls() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
    WHERE c.table_schema = 'public' AND c.column_name = 'customer_id'
      AND t.table_type = 'BASE TABLE'
      AND c.table_name NOT IN ('users', 'user_roles', 'api_keys')
      AND c.table_name NOT LIKE 'audit_log_%'
      AND c.table_name NOT LIKE 'integration_events_%'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', r.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (customer_id IS NULL OR app_all_customers() OR customer_id = ANY (app_customer_ids())) WITH CHECK (customer_id IS NULL OR app_all_customers() OR customer_id = ANY (app_customer_ids()))',
      r.table_name
    );
  END LOOP;
END;
$$;

-- customers itself is keyed by id, not customer_id
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON customers;
CREATE POLICY tenant_isolation ON customers
  USING (app_all_customers() OR id = ANY (app_customer_ids()))
  WITH CHECK (app_all_customers() OR id = ANY (app_customer_ids()));

-- announcements are shared rows: readable by audience (staff see 'all' and 'staff'; a customer
-- scope sees 'all' and 'customers' aimed at everyone or at one of its organisations); written by staff only.
ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE announcements FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON announcements;
CREATE POLICY tenant_isolation ON announcements
  USING (
    app_all_customers()
    OR (audience <> 'customers' AND app_is_msp())
    OR (audience <> 'staff' AND (cardinality(customer_ids) = 0 OR customer_ids && app_customer_ids()))
  )
  WITH CHECK (app_all_customers() OR app_is_msp());

-- shift handovers and team shifts are shared operations rows: staff only, never a customer scope.
ALTER TABLE team_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_shifts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON team_shifts;
CREATE POLICY tenant_isolation ON team_shifts
  USING (app_all_customers() OR app_is_msp())
  WITH CHECK (app_all_customers() OR app_is_msp());
ALTER TABLE shift_handovers ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_handovers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON shift_handovers;
CREATE POLICY tenant_isolation ON shift_handovers
  USING (app_all_customers() OR app_is_msp())
  WITH CHECK (app_all_customers() OR app_is_msp());

-- briefings belong to one person: readable and writable by them (and the system).
ALTER TABLE briefings ENABLE ROW LEVEL SECURITY;
ALTER TABLE briefings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON briefings;
CREATE POLICY tenant_isolation ON briefings
  USING (app_all_customers() OR user_id = app_user_id())
  WITH CHECK (app_all_customers() OR user_id = app_user_id());

-- change management definitions and CAB meetings are shared staff rows: never a customer scope.
ALTER TABLE change_risk_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE change_risk_questions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON change_risk_questions;
CREATE POLICY tenant_isolation ON change_risk_questions
  USING (app_all_customers() OR app_is_msp())
  WITH CHECK (app_all_customers() OR app_is_msp());
ALTER TABLE change_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE change_templates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON change_templates;
CREATE POLICY tenant_isolation ON change_templates
  USING (app_all_customers() OR app_is_msp())
  WITH CHECK (app_all_customers() OR app_is_msp());
ALTER TABLE cab_meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE cab_meetings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON cab_meetings;
CREATE POLICY tenant_isolation ON cab_meetings
  USING (app_all_customers() OR app_is_msp())
  WITH CHECK (app_all_customers() OR app_is_msp());

-- board notes are one person's sticky notes: readable and writable by them (and the system).
ALTER TABLE board_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE board_notes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON board_notes;
CREATE POLICY tenant_isolation ON board_notes
  USING (app_all_customers() OR user_id = app_user_id())
  WITH CHECK (app_all_customers() OR user_id = app_user_id());

-- custom report definitions are MSP artefacts: staff read and write them; portal users
-- read only the ones published to the portal for their organisation (or for every customer).
ALTER TABLE report_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_definitions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON report_definitions;
CREATE POLICY tenant_isolation ON report_definitions
  USING (
    app_all_customers() OR app_is_msp()
    OR (portal_visible AND is_active AND (scope_customer_id IS NULL OR scope_customer_id = ANY (app_customer_ids())))
  )
  WITH CHECK (app_all_customers() OR app_is_msp());

-- notification categories are shared defaults: readable by every signed-in person, written by staff only.
ALTER TABLE notification_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_categories FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON notification_categories;
CREATE POLICY tenant_isolation ON notification_categories
  USING (true)
  WITH CHECK (app_all_customers() OR app_is_msp());
-- phone verification codes belong to one person.
ALTER TABLE phone_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE phone_verifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON phone_verifications;
CREATE POLICY tenant_isolation ON phone_verifications
  USING (app_all_customers() OR user_id = app_user_id())
  WITH CHECK (app_all_customers() OR user_id = app_user_id());

-- ---------------------------------------------------------------------------
-- Partitioned high-volume tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid,
  user_name text,
  customer_id uuid,
  entity_type text NOT NULL,
  entity_id uuid,
  entity_label text,
  action text NOT NULL,
  changes jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL DEFAULT 'ui',
  ip text,
  user_agent text,
  request_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON audit_log (entity_type, entity_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_user_idx ON audit_log (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_customer_idx ON audit_log (customer_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS integration_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  received_at timestamptz NOT NULL DEFAULT now(),
  integration_id uuid NOT NULL,
  integration_type text NOT NULL,
  customer_id uuid,
  external_id text,
  event_type text,
  severity text,
  status text,
  host text,
  ip_address text,
  sensor text,
  message text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  matched_ci_id uuid,
  ticket_id uuid,
  processing_status text NOT NULL DEFAULT 'received',
  processing_note text,
  processed_at timestamptz,
  PRIMARY KEY (id, received_at)
) PARTITION BY RANGE (received_at);
CREATE INDEX IF NOT EXISTS integration_events_integration_idx ON integration_events (integration_id, received_at DESC);
CREATE INDEX IF NOT EXISTS integration_events_customer_idx ON integration_events (customer_id, received_at DESC);
CREATE INDEX IF NOT EXISTS integration_events_external_idx ON integration_events (integration_id, external_id);
CREATE INDEX IF NOT EXISTS integration_events_ticket_idx ON integration_events (ticket_id);

-- Creates monthly partitions from (now - 1 month) to (now + months_ahead).
CREATE OR REPLACE FUNCTION app_ensure_month_partitions(p_table text, p_months_ahead int DEFAULT 3) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  start_month date := date_trunc('month', now() - interval '1 month')::date;
  i int;
  part_start date;
  part_end date;
  part_name text;
  created int := 0;
BEGIN
  FOR i IN 0..(p_months_ahead + 1) LOOP
    part_start := (start_month + (i || ' months')::interval)::date;
    part_end := (part_start + interval '1 month')::date;
    part_name := format('%s_%s', p_table, to_char(part_start, 'YYYY_MM'));
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part_name) THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)', part_name, p_table, part_start, part_end);
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END;
$$;

-- Catch-all partitions so writes never fail if the scheduler misses a month.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'audit_log_default') THEN
    CREATE TABLE audit_log_default PARTITION OF audit_log DEFAULT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'integration_events_default') THEN
    CREATE TABLE integration_events_default PARTITION OF integration_events DEFAULT;
  END IF;
END $$;

SELECT app_ensure_month_partitions('audit_log', 3);
SELECT app_ensure_month_partitions('integration_events', 3);

-- ---------------------------------------------------------------------------
-- Number sequences
-- ---------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS ticket_incident_seq START 1000;
CREATE SEQUENCE IF NOT EXISTS ticket_request_seq START 1000;
CREATE SEQUENCE IF NOT EXISTS ticket_problem_seq START 100;
CREATE SEQUENCE IF NOT EXISTS ticket_change_seq START 100;
CREATE SEQUENCE IF NOT EXISTS field_visit_seq START 1000;
CREATE SEQUENCE IF NOT EXISTS kb_article_seq START 100;

-- ---------------------------------------------------------------------------
-- Fuzzy search support (hostnames, IPs, serials, ticket numbers)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS cis_hostname_trgm_idx ON cis USING gin (hostname gin_trgm_ops);
CREATE INDEX IF NOT EXISTS cis_ip_trgm_idx ON cis USING gin (ip_address gin_trgm_ops);
CREATE INDEX IF NOT EXISTS cis_name_trgm_idx ON cis USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS assets_serial_trgm_idx ON assets USING gin (serial_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS assets_name_trgm_idx ON assets USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS tickets_title_trgm_idx ON tickets USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS customers_name_trgm_idx ON customers USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS kb_title_trgm_idx ON kb_articles USING gin (title gin_trgm_ops);

-- Apply RLS now that all tables exist (re-run safe).
SELECT app_apply_tenant_rls();
