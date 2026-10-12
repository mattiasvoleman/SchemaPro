-- Local and CI stand-ins for the two things of Supabase Auth's that the
-- access-token hook (migration 20261020090000, sign_in.custom_access_token_hook)
-- touches: its role, supabase_auth_admin, and its table auth.identities.
--
-- On Supabase both exist before any migration runs. Here they did not, so
-- the migration's grants to supabase_auth_admin were skipped and nothing could
-- call the hook: a change that broke it would have passed CI and refused
-- every sign-in in production. With the stand-ins the grants run, and RLS
-- section 76 calls the hook as that role, the way Auth does.
--
--   * supabase_auth_admin  NOLOGIN, nothing granted here; the migration grants
--     it USAGE on schema sign_in and EXECUTE on the hook and its two callees.
--   * auth.identities  the columns the hook reads, owned by that role as on
--     Supabase. Empty; section 76 plants rows inside a rolled-back transaction.
--   * app_authenticated may SET ROLE to it (PostgreSQL 16's INHERIT FALSE, so
--     it inherits none of its rights), because the RLS suite runs as
--     app_authenticated. Only this local and CI database has that membership.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
        CREATE ROLE "supabase_auth_admin" NOLOGIN;
    END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS "auth";
GRANT USAGE ON SCHEMA "auth" TO "supabase_auth_admin";

CREATE TABLE IF NOT EXISTS "auth"."identities" (
    "id"            uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    "provider_id"   text NOT NULL,
    "user_id"       uuid NOT NULL,
    "identity_data" jsonb NOT NULL,
    "provider"      text NOT NULL,
    "created_at"    timestamptz DEFAULT now(),
    "updated_at"    timestamptz DEFAULT now()
);
ALTER TABLE "auth"."identities" OWNER TO "supabase_auth_admin";
REVOKE ALL ON "auth"."identities" FROM PUBLIC;

GRANT "supabase_auth_admin" TO "app_authenticated" WITH INHERIT FALSE, SET TRUE;
