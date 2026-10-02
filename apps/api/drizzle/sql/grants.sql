-- Grants for the runtime application role (idempotent). Run as schema owner.
-- The role name is substituted by the migrator from APP_DB_USER.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '__APP_ROLE__') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO "__APP_ROLE__"';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "__APP_ROLE__"';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "__APP_ROLE__"';
    EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO "__APP_ROLE__"';
    EXECUTE 'REVOKE ALL ON drizzle.__drizzle_migrations FROM "__APP_ROLE__"';
  END IF;
EXCEPTION WHEN undefined_table THEN
  NULL;
END $$;
