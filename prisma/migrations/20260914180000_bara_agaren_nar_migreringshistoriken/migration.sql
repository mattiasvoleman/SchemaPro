-- Prisma's migration history is reached by the role that runs the migrations,
-- and by no API role.
--
-- ## Why
--
-- `prisma migrate deploy` creates `_prisma_migrations` itself, in "public",
-- before it runs the first migration. So both table-wide grants reached it:
-- init's `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA
-- "public"` to "authenticated" and "service_role", and the same grant again in
-- 20260806000000. That migration's ALTER DEFAULT PRIVILEGES did not, as the
-- table already existed. No migration since has revoked anything on it or
-- switched row security on, and it is the one table in "public" without row
-- security: section 12 of scripts/test/rls-policies.sql exempts it by name.
--
-- app_authenticated, the role the API connects as, inherits from
-- "authenticated". Measured on a throwaway database migrated to
-- 20260914150000, as app_authenticated: with no principal, with
-- app.service_school_id set as withServicePrincipal sets it, and after SET
-- ROLE "authenticated", a SELECT read all 53 rows and a DELETE removed all 53
-- (rolled back). No other table in "public" gave the service principal a row
-- to delete.
--
-- The table holds no tenant data, so no school reads another's rows through
-- it. What it holds is the schema's history, and whoever can write it decides
-- what the next deploy does: a deleted row makes `migrate deploy` run that
-- migration again on a schema that already has it, and a row left unfinished
-- stops every deploy after it. That was open to any code running as the API
-- role, and on Supabase to anything reaching "public" through PostgREST.
--
-- ## Wider on Supabase than the migrations say
--
-- Supabase sets default privileges in "public" that give anon, authenticated
-- and service_role ALL on every table the migration role creates. Reproduced
-- on a second throwaway database by setting that default ACL for the
-- migration role before `migrate deploy`: all three roles then held
-- arwdDxt on `_prisma_migrations`, TRUNCATE, REFERENCES and TRIGGER included.
-- "anon" is the role PostgREST uses for a request with no token at all.
-- Production was not queried from here. Hence REVOKE ALL rather than the four
-- privileges the migrations granted, and anon in the list although no
-- migration grants it anything.
--
-- ## The change
--
-- REVOKE ALL from every API role, and row security on with no policy.
--
-- The REVOKE is the boundary: the API roles are refused with "permission
-- denied" instead of shown an empty table. app_authenticated holds no grant
-- of its own locally, only what it inherits, but it is created outside the
-- migrations, so it is named too. service_role bypasses row security, so the
-- REVOKE is the only thing that closes the table to the Supabase secret key,
-- and nothing in this repository reads the history through it. PUBLIC has no
-- grant here; revoking from it costs nothing and covers one made by hand.
--
-- Row security is the second layer, for the day another `GRANT ... ON ALL
-- TABLES IN SCHEMA "public"` runs: a role granted that way again reads the
-- table as empty and deletes nothing, instead of everything.
--
-- ## Why `prisma migrate deploy` keeps working
--
-- Prisma reads and writes this table as the role in DIRECT_URL, and that role
-- created it, so it owns it. An owner's privileges are its own, not borrowed
-- from any role revoked here. PostgreSQL does not apply row security to a
-- table's owner unless FORCE ROW LEVEL SECURITY is set, and NO FORCE below
-- states that rather than assuming it; this holds with or without BYPASSRLS.
-- A runner that is not the owner cannot get past ENABLE ROW LEVEL SECURITY,
-- which requires ownership: the script fails there, rolls back as a whole,
-- and leaves the grants as they were.
--
-- Verified on two throwaway databases, each migrated to 20260914150000 first:
--
--   1. As CI runs it, with the superuser "postgres". The deploy applied and
--      the ACL is the owner's alone. As app_authenticated a read and a DELETE
--      are refused with no principal, with withServicePrincipal's setting and
--      after SET ROLE "authenticated". Swept over every table in "public"
--      under no principal, the service principal and the key lookup, nothing
--      else is refused and nothing is deleted.
--   2. With Supabase's default ACL, and a migration role that owns "public"
--      but is neither superuser nor BYPASSRLS. Deployed first as
--      app_authenticated, which held arwdDxt through "authenticated": it
--      failed with "must be owner of table _prisma_migrations", row security
--      stayed off and the ACL unchanged. After `migrate resolve
--      --rolled-back`, the owner deployed it, read all 55 rows back with
--      row_security_active() false, applied one more migration on top, and
--      `migrate status` reported the schema up to date. anon's SELECT and
--      TRUNCATE, service_role's DELETE and authenticated's UPDATE were
--      refused.

DO $$
DECLARE
  api_role text;
BEGIN
  -- Guarded like 20260806000000: a bare Postgres may lack a role, and REVOKE
  -- naming a missing role would fail the deploy.
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE "_prisma_migrations" FROM %I', api_role);
    END IF;
  END LOOP;
END
$$;

REVOKE ALL ON TABLE "_prisma_migrations" FROM PUBLIC;

ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "_prisma_migrations" NO FORCE ROW LEVEL SECURITY;
