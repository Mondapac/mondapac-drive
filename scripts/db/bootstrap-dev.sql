-- Cluster bootstrap for development and CI only (docs/design/data/platform.md 10.7).
--
-- Creates the three database roles of 10.1 and hands the current database to the migration
-- role. Run it as the cluster superuser, over the Unix socket, while connected to the
-- application database:
--   docker compose: scripts/db/init-drive-database.sh runs it once on a fresh volume
--                   (/docker-entrypoint-initdb.d), and again with `pnpm db:bootstrap` when the
--                   role model changes
--   native PostgreSQL: psql -d drive -f scripts/db/bootstrap-dev.sql
--
-- The passwords are local-only defaults, never secrets. The file refuses to run against a
-- cluster that is not on this machine. It converges: running it again is safe.
-- Production does not use this file (10.7, Phase 7).

\set ON_ERROR_STOP on

-- Socket or loopback only, so these known passwords never land on a remote cluster.
DO $guard$
BEGIN
  IF inet_server_addr() IS NOT NULL
     AND NOT (inet_server_addr() <<= inet '127.0.0.0/8' OR inet_server_addr() = inet '::1') THEN
    RAISE EXCEPTION 'bootstrap-dev.sql runs only over the Unix socket or loopback'
      USING HINT = 'Connect with psql inside the container or on this machine, without -h.';
  END IF;
END
$guard$;

BEGIN;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'drive_app') THEN
    CREATE ROLE drive_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'drive_api') THEN
    CREATE ROLE drive_api LOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'drive_migrator') THEN
    CREATE ROLE drive_migrator LOGIN;
  END IF;
END
$roles$;

-- The group every migration grants to. Member of no role, owns nothing.
ALTER ROLE drive_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- The application's login: member of the group only.
ALTER ROLE drive_api LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
  NOBYPASSRLS PASSWORD 'drive_api';
GRANT drive_app TO drive_api;

-- Role settings of every application login (10.7, K1a): they bound what a stuck statement, a
-- lock wait or an idle transaction can hold. ALTER ROLE ... SET without IN DATABASE; never on
-- the group (its settings do not reach members) and never on the migration role (long DDL).
-- No login sets default_transaction_isolation or default_transaction_read_only. Order: pool
-- wait 2 s < lock_timeout 3 s < UnitOfWork 5 s < statement_timeout 30 s. ALTER ROLE SET
-- overwrites, so a re-run converges.
ALTER ROLE drive_api SET statement_timeout = '30s';
ALTER ROLE drive_api SET lock_timeout = '3s';
ALTER ROLE drive_api SET idle_in_transaction_session_timeout = '60s';

-- The migration role owns the database and everything in it. CREATEDB and pg_signal_backend
-- serve the throwaway databases of the tests and scripts (development and CI only).
ALTER ROLE drive_migrator LOGIN NOSUPERUSER CREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD 'drive_migrator';
GRANT pg_signal_backend TO drive_migrator;

-- The database: owned by the migration role; PUBLIC loses CONNECT and TEMPORARY (10.5 gap 5).
DO $database$
BEGIN
  EXECUTE format('ALTER DATABASE %I OWNER TO drive_migrator', current_database());
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO drive_app', current_database());
END
$database$;

-- Everything in the database belongs to the migration role (10.1). A volume created before
-- these roles existed holds objects of the old superuser: it is recreated, not converted.
DO $ownership$
DECLARE
  offending text;
BEGIN
  SELECT string_agg(name, ', ' ORDER BY name) INTO offending
    FROM (
      SELECT n.nspname AS name
        FROM pg_catalog.pg_namespace n
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'public')
         AND n.nspname NOT LIKE 'pg\_%'
         AND n.nspowner <> 'drive_migrator'::regrole
      UNION ALL
      SELECT n.nspname || '.' || c.relname
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND n.nspname NOT LIKE 'pg\_%'
         AND c.relowner <> 'drive_migrator'::regrole
         -- Extension objects (PostGIS's table, its index, composite types) belong to the superuser
         -- that installed the extension below: a relation, or the table of an index, or the
         -- type of a composite, that is a member of an extension.
         AND NOT EXISTS (SELECT FROM pg_catalog.pg_depend d
                          WHERE d.deptype = 'e'
                            AND ((d.classid = 'pg_catalog.pg_class'::regclass
                                  AND d.objid IN (c.oid, (SELECT i.indrelid FROM pg_catalog.pg_index i
                                                           WHERE i.indexrelid = c.oid)))
                                 OR (d.classid = 'pg_catalog.pg_type'::regclass
                                     AND d.objid = c.reltype)))
    ) AS objects;
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'objects owned by another role than drive_migrator: %', offending
      USING HINT = 'This database predates the role model. Recreate it: docker compose down -v, '
                   'copy .env.example to .env, docker compose up -d, pnpm db:migrate.';
  END IF;
END
$ownership$;

-- Memberships are only added above, so a leftover one would survive a re-run (10.1: the group
-- belongs to nothing, the login belongs to the group only, the migration role to neither).
DO $$
DECLARE
  stray text;
BEGIN
  SELECT string_agg(format('%s in %s', member.rolname, grp.rolname), ', ') INTO stray
    FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles member ON member.oid = m.member
    JOIN pg_catalog.pg_roles grp ON grp.oid = m.roleid
   WHERE member.rolname = 'drive_app'
      OR (member.rolname = 'drive_api' AND grp.rolname <> 'drive_app')
      OR (member.rolname = 'drive_migrator' AND grp.rolname <> 'pg_signal_backend');
  IF stray IS NOT NULL THEN
    RAISE EXCEPTION 'unexpected role memberships: %', stray
      USING HINT = 'REVOKE them as the cluster superuser, or recreate the Compose volume.';
  END IF;
END
$$;

-- PostGIS (Drive): not a trusted extension, so the cluster superuser installs it, never a
-- migration. The migration that uses it says CREATE EXTENSION IF NOT EXISTS, a no-op here.
CREATE EXTENSION IF NOT EXISTS postgis;

COMMIT;

-- The same in template1, so the throwaway databases of the tests and scripts (CREATE DATABASE as
-- the migration role) have PostGIS too. Then back to the application database.
SELECT current_database() AS app_database \gset
\connect template1
CREATE EXTENSION IF NOT EXISTS postgis;
\connect :app_database
