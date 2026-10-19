-- ============================================================================
-- Saman ERP — first-boot PostgreSQL bootstrap (runs only on an EMPTY pgdata)
-- Mounted at /docker-entrypoint-initdb.d/01-init.sql and executed by the
-- official postgres:16 entrypoint as the POSTGRES_USER superuser.
--
-- Contract (docs/06-deployment/DEPLOYMENT.md §9.2):
--   saman_migrator : schema owner, DDL only (MIGRATION_DATABASE_URL)
--   saman_app      : DML only, no DDL (DATABASE_URL for api/worker)
--   saman_worker   : DML only, longer statement_timeout for batch jobs (reserved)
--   saman_readonly : SELECT only (reporting/BI)
--   saman_backup   : pg_read_all_data (logical dumps / DBA)
--
-- Passwords: psql \getenv reads container env; the initial value of every role
-- password is POSTGRES_PASSWORD. Rotate to distinct secrets after first boot
-- (INSTALL-FA §8.2) and update DATABASE_URL / MIGRATION_DATABASE_URL.
-- On a non-empty pgdata this file is NOT executed; see INSTALL-FA §8.2.
-- ============================================================================

\set ON_ERROR_STOP on
\getenv pg_password POSTGRES_PASSWORD
\getenv db_name POSTGRES_DB

-- ---------------------------------------------------------------------------
-- Extensions (trusted extensions; enabled by the superuser at init time)
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- ---------------------------------------------------------------------------
-- Roles. Role names are a hard contract with the application env (.env.example).
-- ---------------------------------------------------------------------------
CREATE ROLE saman_migrator LOGIN PASSWORD :'pg_password';
CREATE ROLE saman_app      LOGIN PASSWORD :'pg_password';
CREATE ROLE saman_worker   LOGIN PASSWORD :'pg_password';
CREATE ROLE saman_readonly LOGIN PASSWORD :'pg_password';
CREATE ROLE saman_backup   LOGIN PASSWORD :'pg_password';

-- Read-only helper roles
GRANT pg_read_all_data  TO saman_backup;
GRANT pg_read_all_stats TO saman_readonly;

-- ---------------------------------------------------------------------------
-- Database / schema ownership
-- ---------------------------------------------------------------------------
GRANT CONNECT, CREATE, TEMPORARY ON DATABASE :"db_name" TO saman_migrator;
GRANT CONNECT ON DATABASE :"db_name" TO saman_app, saman_worker, saman_readonly;

CREATE SCHEMA IF NOT EXISTS erp AUTHORIZATION saman_migrator;
REVOKE ALL ON SCHEMA erp FROM PUBLIC;
GRANT USAGE ON SCHEMA erp TO saman_app, saman_worker, saman_readonly, saman_backup;

-- Extensions live in public; app roles need USAGE to use their functions/types.
GRANT USAGE ON SCHEMA public TO saman_app, saman_worker, saman_readonly;

-- ---------------------------------------------------------------------------
-- Least-privilege grants for CURRENT objects (migrations create future objects
-- through saman_migrator; default privileges below cover them automatically).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA erp
  TO saman_app, saman_worker;
GRANT SELECT ON ALL TABLES IN SCHEMA erp TO saman_readonly;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA erp TO saman_app, saman_worker;

-- ---------------------------------------------------------------------------
-- Default privileges for FUTURE objects created by saman_migrator
-- ---------------------------------------------------------------------------
ALTER DEFAULT PRIVILEGES FOR ROLE saman_migrator IN SCHEMA erp
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO saman_app;
ALTER DEFAULT PRIVILEGES FOR ROLE saman_migrator IN SCHEMA erp
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO saman_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE saman_migrator IN SCHEMA erp
  GRANT SELECT ON TABLES TO saman_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE saman_migrator IN SCHEMA erp
  GRANT USAGE, SELECT ON SEQUENCES TO saman_app, saman_worker;

-- ---------------------------------------------------------------------------
-- Per-role safety net (the API tightens this to DB_STATEMENT_TIMEOUT_MS=5000)
-- ---------------------------------------------------------------------------
ALTER ROLE saman_app      SET statement_timeout = '30s';
ALTER ROLE saman_app      SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE saman_worker   SET statement_timeout = '30m';
ALTER ROLE saman_migrator SET statement_timeout = 0;
ALTER ROLE saman_readonly SET statement_timeout = '60s';
ALTER ROLE saman_backup   SET statement_timeout = 0;

-- Do not let PUBLIC create objects in the business schema.
ALTER DEFAULT PRIVILEGES FOR ROLE saman_migrator IN SCHEMA erp
  REVOKE ALL ON TABLES FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Smoke line for the first-boot logs
-- ---------------------------------------------------------------------------
SELECT 'Saman ERP bootstrap complete: schema erp, roles saman_{migrator,app,worker,readonly,backup}' AS result;
