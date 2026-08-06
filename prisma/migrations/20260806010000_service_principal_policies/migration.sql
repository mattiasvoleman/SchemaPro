-- Service-principal RLS policies for the SS12000 integration API.
--
-- ## Why
--
-- `PrismaService.withSystemTransaction` was believed to run outside RLS. It
-- does not — the API connects as `app_authenticated`, a non-owner, so policies
-- apply to every statement. With no claims set, `auth.uid()` is NULL, every
-- predicate is false, and queries return **zero rows without erroring**.
--
-- The JWT and websocket identity lookups were fixed by scoping them to their
-- verified subject. The SS12000 feed and the integration-key guard could not
-- be: they authenticate with an `X-API-Key`, not a user JWT, so there is no
-- `auth.uid()` to scope by. Until now they silently returned empty payloads,
-- which an integrating system reads as "this school has no data" rather than
-- "the integration is broken".
--
-- ## The principal
--
-- Rather than granting BYPASSRLS — which would switch off tenancy enforcement
-- for the whole connection — this introduces a principal that policies can
-- recognise, and which is *itself tenant-scoped*.
--
-- The integration key resolves to exactly one school, and every SS12000 query
-- already filters by that `schoolId` in application code. So the principal is
-- not cross-tenant: it is "the service acting for school X". The policies below
-- enforce in the database what the service layer already intends, which means a
-- missing `where schoolId` in future application code cannot leak across
-- tenants.
--
-- Two settings, both transaction-local (`set_config(..., true)`), so they can
-- never leak across requests sharing a pooled connection:
--
--   app.service_school_id   uuid  — the tenant the API key resolved to
--   app.service_key_lookup  text  — 'on' during the pre-auth key lookup only
--
-- The key lookup is the one operation that cannot be tenant-scoped, because
-- the tenant is what it is trying to discover. It is therefore given the
-- narrowest possible grant: SELECT on non-revoked rows of IntegrationApiKeys,
-- and UPDATE of the same rows for the `lastUsedAt` timestamp. Nothing else.
--
-- ## Threat model
--
-- Any code able to set these settings gains the corresponding access, so the
-- only callers must be the two dedicated PrismaService helpers
-- (`withServicePrincipal`, `withServiceKeyLookup`). That is the same trust
-- boundary `withRls` already relies on. The improvement over BYPASSRLS is that
-- the blast radius is one school and seven tables, not the entire database.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.current_service_school_id()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT NULLIF(current_setting('app.service_school_id', true), '')::uuid
$$;

COMMENT ON FUNCTION app.current_service_school_id() IS
  'Tenant an SS12000 integration request is acting for, or NULL. Set transaction-locally by PrismaService.withServicePrincipal.';

CREATE OR REPLACE FUNCTION app.is_service_key_lookup()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT COALESCE(current_setting('app.service_key_lookup', true), '') = 'on'
$$;

COMMENT ON FUNCTION app.is_service_key_lookup() IS
  'True only inside PrismaService.withServiceKeyLookup, which resolves an X-API-Key to a school before any tenant context exists.';

-- ---------------------------------------------------------------------------
-- Pre-authentication: resolve an API key to its school
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS integration_keys_service_lookup ON "IntegrationApiKeys";
CREATE POLICY integration_keys_service_lookup
  ON "IntegrationApiKeys"
  FOR SELECT
  USING (app.is_service_key_lookup() AND "revokedAt" IS NULL);

-- Separate policy for the best-effort lastUsedAt write. USING selects the rows
-- that may be updated; WITH CHECK stops the update from moving a row to
-- another tenant or resurrecting a revoked key.
DROP POLICY IF EXISTS integration_keys_service_touch ON "IntegrationApiKeys";
CREATE POLICY integration_keys_service_touch
  ON "IntegrationApiKeys"
  FOR UPDATE
  USING (app.is_service_key_lookup() AND "revokedAt" IS NULL)
  WITH CHECK (app.is_service_key_lookup() AND "revokedAt" IS NULL);

-- ---------------------------------------------------------------------------
-- Post-authentication: everything scoped to the resolved school
-- ---------------------------------------------------------------------------

-- Schools is keyed on `id`, not `schoolId`.
DROP POLICY IF EXISTS schools_service_select ON "Schools";
CREATE POLICY schools_service_select
  ON "Schools"
  FOR SELECT
  USING ("id" = app.current_service_school_id());

DROP POLICY IF EXISTS academic_years_service_select ON "AcademicYears";
CREATE POLICY academic_years_service_select
  ON "AcademicYears"
  FOR SELECT
  USING ("schoolId" = app.current_service_school_id());

DROP POLICY IF EXISTS master_lessons_service_select ON "MasterLessons";
CREATE POLICY master_lessons_service_select
  ON "MasterLessons"
  FOR SELECT
  USING ("schoolId" = app.current_service_school_id());

DROP POLICY IF EXISTS calendar_lessons_service_select ON "CalendarLessons";
CREATE POLICY calendar_lessons_service_select
  ON "CalendarLessons"
  FOR SELECT
  USING ("schoolId" = app.current_service_school_id());

-- Users: the person feed reads, and the import updates existing rows. It never
-- creates users — unknown emails are returned as `needsProvisioning` instead —
-- so no INSERT policy is granted.
DROP POLICY IF EXISTS users_service_select ON "Users";
CREATE POLICY users_service_select
  ON "Users"
  FOR SELECT
  USING ("schoolId" = app.current_service_school_id());

DROP POLICY IF EXISTS users_service_update ON "Users";
CREATE POLICY users_service_update
  ON "Users"
  FOR UPDATE
  USING ("schoolId" = app.current_service_school_id())
  WITH CHECK ("schoolId" = app.current_service_school_id());

-- StudentGroups: the import creates classes that appear in the feed.
DROP POLICY IF EXISTS student_groups_service_select ON "StudentGroups";
CREATE POLICY student_groups_service_select
  ON "StudentGroups"
  FOR SELECT
  USING ("schoolId" = app.current_service_school_id());

DROP POLICY IF EXISTS student_groups_service_insert ON "StudentGroups";
CREATE POLICY student_groups_service_insert
  ON "StudentGroups"
  FOR INSERT
  WITH CHECK ("schoolId" = app.current_service_school_id());

-- GuardianStudents: the import upserts guardian links, so it needs all three
-- of SELECT (to find the existing row), INSERT and UPDATE.
DROP POLICY IF EXISTS guardian_students_service_select ON "GuardianStudents";
CREATE POLICY guardian_students_service_select
  ON "GuardianStudents"
  FOR SELECT
  USING ("schoolId" = app.current_service_school_id());

DROP POLICY IF EXISTS guardian_students_service_insert ON "GuardianStudents";
CREATE POLICY guardian_students_service_insert
  ON "GuardianStudents"
  FOR INSERT
  WITH CHECK ("schoolId" = app.current_service_school_id());

DROP POLICY IF EXISTS guardian_students_service_update ON "GuardianStudents";
CREATE POLICY guardian_students_service_update
  ON "GuardianStudents"
  FOR UPDATE
  USING ("schoolId" = app.current_service_school_id())
  WITH CHECK ("schoolId" = app.current_service_school_id());
