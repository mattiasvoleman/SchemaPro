-- Bara ägaren underhåller en tabell: ingen API-roll kör VACUUM, ANALYZE,
-- REINDEX eller CLUSTER på den, och ingen låser den genom underhållsrätten.
--
-- Postgres 17 adds a table privilege, MAINTAIN. It lets a role that does not
-- own a table run VACUUM, ANALYZE, REINDEX, CLUSTER, REFRESH MATERIALIZED
-- VIEW and LOCK TABLE in any mode on it, and from 17 on ALL on a table
-- includes it. Production runs Supabase on Postgres 17. Supabase's default
-- ACL for the migration role in "public" gives anon, authenticated and
-- service_role ALL on every table that role creates. On a fresh
-- supabase/postgres 17.6.1.166 image that entry reads arwdDxtm, and the m is
-- MAINTAIN. app_authenticated, which the gateway connects as, is a member of
-- authenticated with INHERIT (docs/DEPLOYMENT.md §3), so it holds whatever
-- authenticated holds.
--
-- 20261016090000 (anon) and 20261016110000 (TRUNCATE, REFERENCES, TRIGGER)
-- were measured on Postgres 16, which has no MAINTAIN. anon lost it anyway,
-- because that migration revokes ALL, and on 17 ALL includes MAINTAIN. From
-- 20261010090000 on, every migration that creates a table revokes the
-- privileges it does not want by name. Those lists were written for 16, so
-- MAINTAIN stays on every table they cover.
--
-- Measured on that image, with app_authenticated created as scripts/db-init
-- creates it, migrated as postgres to 20261016110000. authenticated,
-- app_authenticated and service_role held MAINTAIN on 77 of the 84 tables in
-- "public": the 46 of 20261016110000 and the 31 created since 20261010090000.
-- The seven without it are the ones whose migrations revoke ALL:
-- _prisma_migrations, NationalSubjects, NationalTimplanEntries,
-- NationalTimplanVersions, PushTickets, IntegrationKeyWebhookSecrets and
-- Ss12000SourceSecrets. anon held it on none. As app_authenticated, and
-- again as authenticated:
--
--   * LOCK TABLE ... IN ACCESS EXCLUSIVE MODE, REINDEX TABLE and CLUSTER
--     succeeded on GuardianStudents, Users and TeacherEmploymentLogs.
--   * VACUUM FULL rewrote GuardianStudents, which got a new relfilenode
--     each time.
--
-- Each of these holds ACCESS EXCLUSIVE, which stops every read and every
-- write of the table, for every school, until it ends.
--
-- ## What revoking it closes, and what it does not
--
-- Postgres lets a role with UPDATE, DELETE or TRUNCATE on a table LOCK it in
-- any mode, on 16 as on 17. On 69 of the 77 the API roles keep UPDATE or
-- DELETE, so LOCK TABLE ... IN ACCESS EXCLUSIVE MODE stays open to them
-- there. No grant changes that short of taking the write away. Revoking
-- MAINTAIN closes:
--
--   * VACUUM FULL and CLUSTER, which rewrite the whole table, and REINDEX,
--     on every table.
--   * Every lock above ROW EXCLUSIVE on the eight tables where neither role
--     may update or delete: TeacherEmploymentLogs, GuardianStudentHistory,
--     Ss12000EntityVersions, Ss12000Tombstones,
--     Ss12000SubscriptionDeliveries, StudentEnrollments,
--     TimetablePublications and PublishedLunchSittings. Three are written by
--     triggers on other tables, so a lock on one also stalls those tables'
--     writes. TeacherEmploymentLogs is written on every change to
--     TeacherEmployments and TeacherDuties, StudentEnrollments on a pupil's
--     insert or class change in Users, and GuardianStudentHistory on a
--     delete from GuardianStudents.
--
-- Nothing uses it. PostgREST cannot issue any of these statements, and
-- pg_graphql issues only DML. The gateway's SQL is DML through
-- PrismaService, and its locks are row locks (FOR UPDATE) and advisory
-- locks. Nothing in src runs LOCK TABLE, VACUUM, ANALYZE, REINDEX or
-- CLUSTER. Autovacuum and autoanalyze need no grant.
--
-- ## service_role
--
-- The migrations from 20261010090000 on leave service_role SELECT and nothing
-- else on the 31 tables they create. They revoke INSERT, UPDATE, DELETE,
-- TRUNCATE, REFERENCES and TRIGGER from it by name. On 17, MAINTAIN is the
-- one privilege beyond SELECT that service_role still holds there. It lets a
-- session as service_role lock or rewrite a table it was meant only to read,
-- so it goes, from every table and from the default ACL, with the same
-- statement.
--
-- service_role keeps TRUNCATE, REFERENCES and TRIGGER. It holds them on
-- exactly the 46 tables where it also holds INSERT, UPDATE and DELETE, past
-- row security, and there they add nothing. DELETE already removes every
-- row, and UPDATE already allows any lock. REFERENCES, and TRIGGER with a
-- function of its own, need CREATE on some schema, which service_role has on
-- none. None of the three can be issued through PostgREST or pg_graphql, the
-- only way the service key reaches the database. The gateway uses the key
-- for GoTrue's admin API alone (SupabaseAdminService). For those 46 the
-- question that matters is whether service_role should write them at all,
-- as the newer tables already decide. When that is settled the three go
-- with the write, and taking them alone now would change nothing.
--
-- ## The change
--
--   * On Postgres 17 and later: REVOKE MAINTAIN from authenticated,
--     app_authenticated and service_role on every table, view and foreign
--     table in "public" and "app" that the migration role owns. The loop
--     reads the catalogue, so a table another branch adds before this one
--     merges is covered without being named. A relation that belongs to
--     another role is skipped. Revoking there would only remove grants made
--     by the migration role, and if that role holds nothing on it, REVOKE
--     raises an error and would fail the deploy. SELECT, INSERT, UPDATE and
--     DELETE stay as they are.
--   * ALTER DEFAULT PRIVILEGES IN SCHEMA "public" REVOKE MAINTAIN ON TABLES
--     from authenticated and service_role, for the role that runs the
--     migrations. A new table no longer starts out with it, so a REVOKE list
--     that leaves it out cannot bring it back. The default's other privileges
--     stay.
--   * Guarded on server_version_num. Postgres 16 has no MAINTAIN and rejects
--     the name ("unrecognized privilege type"), and CI's compose database is
--     16, so there the block returns at once. Each role is also guarded on
--     pg_roles, like the migrations before it.
--
-- Not touched:
--
--   * anon, which holds MAINTAIN nowhere, since 20261016090000's REVOKE ALL
--     took it with the rest. The migration role's default ACL no longer
--     names anon.
--   * The default ACL of supabase_admin, which this role cannot alter. It
--     covers tables supabase_admin creates, and SchemaPro creates none.
--
-- RLS section 38 asserts, on 17, that none of the three roles holds MAINTAIN
-- on any table in "public" or "app" and that no default ACL gives it to them.
-- On 16 it skips that part. Section 36 counts MAINTAIN in anon's reach on 17.

DO $$
DECLARE
  api_role text;
  rel      regclass;
BEGIN
  IF current_setting('server_version_num')::int < 170000 THEN
    RETURN;
  END IF;

  FOREACH api_role IN ARRAY ARRAY['authenticated', 'app_authenticated', 'service_role'] LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role);
    FOR rel IN
      SELECT c.oid::regclass
        FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
       WHERE ns.nspname IN ('public', 'app') AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND pg_has_role(c.relowner, 'USAGE')
    LOOP
      EXECUTE format('REVOKE MAINTAIN ON %s FROM %I', rel, api_role);
    END LOOP;
  END LOOP;

  FOREACH api_role IN ARRAY ARRAY['authenticated', 'service_role'] LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA "public" REVOKE MAINTAIN ON TABLES FROM %I', api_role);
  END LOOP;
END
$$;
