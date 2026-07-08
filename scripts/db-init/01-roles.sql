-- Local-development bootstrap for the SchemaPro database container.
--
-- Creates the least-privilege LOGIN role the API connects as. It is a member
-- of "authenticated" (the NOLOGIN role the migrations grant table access to),
-- and is NOT the table owner — so PostgreSQL enforces every RLS policy on
-- every query the API runs.
--
-- The password below is for the local docker-compose stack only. In any real
-- environment, roles and credentials come from your secrets manager.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE "authenticated" NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
        CREATE ROLE "app_authenticated" LOGIN PASSWORD 'app_authenticated_local'
            IN ROLE "authenticated" INHERIT;
    END IF;
END
$$;
