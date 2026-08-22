-- The identity helpers resolve ACTIVE principals only.
--
-- ## Why
--
-- Deactivating someone writes `Users."isActive" = false` and nothing else. The
-- four SECURITY DEFINER helpers that every policy in this schema is built on
-- resolved the caller by `authId` alone, so below the API the column had no
-- effect at all: web and mobile read Supabase directly, and a deactivated
-- session therefore kept the role and the tenant it held the moment before.
-- A deactivated SCHOOL_ADMIN could still read the whole school, still write to
-- it, and — through `users_admin_all` — set their own `isActive` back to true.
-- The only gate was src/auth/jwt.strategy.ts, which guards the Nest gateway
-- and nothing else.
--
-- ## What changes
--
-- Each helper gains `AND "isActive"`. An inactive principal now resolves to
-- NULL on all four. Every policy compares a column against a helper with `=`
-- or `IN`, so a NULL makes the predicate NULL — never true — and every table
-- denies every row. No policy needs to change, and nothing raises: an inactive
-- session reads zero rows instead of failing, and its writes are refused by
-- the policy, which is exactly how a session with no principal at all already
-- behaves.
--
-- ## What deliberately does NOT change
--
-- The helpers resolve the CALLER, never the row under test. No policy asks
-- whether the *target* user is active, so an active admin keeps seeing
-- deactivated colleagues through `users_staff_select` and keeps being able to
-- reactivate them through `users_admin_all`. That is the only way back for a
-- deactivated account, so scripts/test/rls-policies.sql asserts it alongside
-- the lockout itself.
--
-- CREATE OR REPLACE resets every attribute that is not restated to its
-- default, so LANGUAGE / STABLE / SECURITY DEFINER / search_path are repeated
-- verbatim below. Losing SECURITY DEFINER here would make every policy in the
-- database recurse back through "Users".
--
-- This migration contains nothing but these four functions. They sit
-- underneath every policy there is, so the change has to be revertable on its
-- own.

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
    SELECT "id" FROM "Users" WHERE "authId" = (select auth.uid()) AND "isActive"
$$;

CREATE OR REPLACE FUNCTION app.current_school_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
    SELECT "schoolId" FROM "Users" WHERE "authId" = (select auth.uid()) AND "isActive"
$$;

CREATE OR REPLACE FUNCTION app.current_user_role() RETURNS "UserRole"
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
    SELECT "role" FROM "Users" WHERE "authId" = (select auth.uid()) AND "isActive"
$$;

CREATE OR REPLACE FUNCTION app.current_user_group_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
    SELECT "studentGroupId" FROM "Users" WHERE "authId" = (select auth.uid()) AND "isActive"
$$;

COMMENT ON FUNCTION app.current_user_id() IS
  'Users.id of the signed-in principal, or NULL when no ACTIVE user matches auth.uid(). Deactivation revokes database access through this NULL.';
COMMENT ON FUNCTION app.current_school_id() IS
  'Tenant of the signed-in principal, or NULL when no ACTIVE user matches auth.uid().';
COMMENT ON FUNCTION app.current_user_role() IS
  'Role of the signed-in principal, or NULL when no ACTIVE user matches auth.uid().';
COMMENT ON FUNCTION app.current_user_group_id() IS
  'Home class of the signed-in principal, NULL for staff and for anyone inactive.';
