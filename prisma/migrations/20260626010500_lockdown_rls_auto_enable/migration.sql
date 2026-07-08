-- =============================================================================
-- Lock down public.rls_auto_enable()
-- -----------------------------------------------------------------------------
-- `public.rls_auto_enable()` is a SECURITY DEFINER function that is NOT part of
-- this project's schema (it was created directly in the database). Living in the
-- API-exposed `public` schema with EXECUTE granted to `anon`, it was callable
-- without authentication via POST /rest/v1/rpc/rls_auto_enable and ran with the
-- owner's privileges (Supabase lint 0028 / definer privilege escalation).
--
-- This migration revokes EXECUTE from every API/PUBLIC role so the function can
-- no longer be invoked over PostgREST. It is guarded and loops over any overload,
-- so it is an idempotent no-op where the function does not exist (e.g. the plain
-- Postgres shadow database used by `prisma migrate dev`).
--
-- If you would rather remove the function entirely, replace the REVOKE below with:
--     DROP FUNCTION IF EXISTS public.rls_auto_enable();
-- =============================================================================
DO $$
DECLARE
    fn record;
BEGIN
    FOR fn IN
        SELECT n.nspname AS schema_name,
               p.proname AS function_name,
               pg_get_function_identity_arguments(p.oid) AS args
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'rls_auto_enable'
    LOOP
        EXECUTE format(
            'REVOKE EXECUTE ON FUNCTION %I.%I(%s) FROM anon, authenticated, public',
            fn.schema_name, fn.function_name, fn.args
        );
    END LOOP;
END
$$;
