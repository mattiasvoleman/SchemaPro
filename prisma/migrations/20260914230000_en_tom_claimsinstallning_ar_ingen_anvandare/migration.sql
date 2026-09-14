-- The fallback auth.uid() and auth.role() read an empty claims setting as no
-- user instead of raising.
--
-- ## Why
--
-- 20260623120000_init section 5.2 creates auth.uid() and auth.role() only
-- where none exist, which is every plain PostgreSQL database: the
-- docker-compose stack, CI's Database job, a `prisma migrate dev` shadow
-- database. Both bodies cast request.jwt.claims to jsonb before anything else:
--
--   SELECT NULLIF(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
--   SELECT current_setting('request.jwt.claims', true)::jsonb ->> 'role'
--
-- current_setting(name, true) returns NULL only until a transaction on the
-- connection has set that setting. set_config(..., true) undoes the value at
-- COMMIT or ROLLBACK, but the setting stays defined, and from then on it reads
-- '' on that connection. ''::jsonb raises "invalid input syntax for type json"
-- (22P02), and so does every policy that calls app.current_school_id(),
-- app.current_user_id(), app.current_user_role() or app.current_user_group_id(),
-- since each of them calls auth.uid().
--
-- PrismaService.withRls sets request.jwt.claims on every user request, and
-- Prisma pools connections. Measured on a throwaway Postgres 16 through the
-- real PrismaService, as app_authenticated with connection_limit=1, so every
-- call below ran on the same backend:
--
--   withServicePrincipal before any user request    Schools: 1
--   withRls as the seeded admin                     Schools: 1
--   the connection's request.jwt.claims             NULL before, '' after
--   withServicePrincipal                            22P02 (PrismaClientUnknownRequestError)
--   withServiceKeyLookup                            22P02 (PrismaClientUnknownRequestError)
--   withRls again                                   Schools: 1
--
-- Schools and IntegrationApiKeys each carry a member policy keyed on
-- app.current_school_id() beside the service policy, and its error aborts the
-- statement although the service policy is the one that would admit the row.
-- HttpExceptionFilter answers an unknown Prisma error with 500, so the SS12000
-- feed and the key guard failed on any pooled connection a user request had
-- used before. In psql, a transaction with no principal at all raised the same
-- way on Users, where it should see zero rows.
--
-- ## Why production is not affected, and must not be touched
--
-- Supabase ships its own auth.uid() and auth.role(), so init never created the
-- fallback there. supabase/auth's 20220224000811_update_auth_functions.up.sql,
-- the last migration there to define them (checked through 4eee58f), wraps both
-- settings in nullif(..., '') before any cast:
--
--   coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
--            (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
--
-- ## Which function is replaced
--
-- Only one whose body is, whitespace aside, the one init wrote. Not every
-- existing one, since Supabase's own exists too. Not by owner either: the
-- fallback is owned by whichever role ran the migrations, and on a self-hosted
-- Supabase that is the same postgres role that can end up owning Supabase's
-- auth.uid() after a restore. Ownership records who created a function, not
-- which implementation it is. Neither init body occurs in any supabase/auth
-- migration or in supabase/postgres's auth-schema init script.
--
-- If a body matches but this role may not replace the function, CREATE OR
-- REPLACE fails and the deploy with it. That is intended: the function is
-- ours, and skipping it would leave the 500s in place.
--
-- The new bodies change nothing else. NULL and '{}' still read as no user, and
-- a claims object with a sub still yields that sub. They do not begin reading
-- request.jwt.claim.sub the way Supabase's do: PrismaService sets both styles,
-- and scripts/test/rls-policies.sql sets only the JSON one.

DO $$
DECLARE
    init_uid  constant text :=
        'SELECT NULLIF(current_setting(''request.jwt.claims'', true)::jsonb ->> ''sub'', '''')::uuid';
    init_role constant text :=
        'SELECT current_setting(''request.jwt.claims'', true)::jsonb ->> ''role''';
    body text;
BEGIN
    SELECT btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g')) INTO body
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'auth' AND p.proname = 'uid' AND p.pronargs = 0;

    IF body = init_uid THEN
        CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
        LANGUAGE sql STABLE AS $fn$
            SELECT NULLIF(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
        $fn$;
    ELSE
        RAISE NOTICE 'auth.uid() is not the fallback 20260623120000_init created; left as it is';
    END IF;

    SELECT btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g')) INTO body
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'auth' AND p.proname = 'role' AND p.pronargs = 0;

    IF body = init_role THEN
        CREATE OR REPLACE FUNCTION auth.role() RETURNS text
        LANGUAGE sql STABLE AS $fn$
            SELECT NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
        $fn$;
    ELSE
        RAISE NOTICE 'auth.role() is not the fallback 20260623120000_init created; left as it is';
    END IF;
END
$$;
