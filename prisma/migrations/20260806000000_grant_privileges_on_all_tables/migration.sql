-- Restore table privileges for the application roles, and stop them from
-- silently lapsing again.
--
-- ## The bug
--
-- The initial migration granted table access with:
--
--     GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "public"
--       TO "authenticated";
--
-- `ON ALL TABLES` is not a standing rule — it expands to the tables that exist
-- at the moment it runs. Every table created by a later migration therefore
-- received no grant at all. By the time this migration was written, thirteen
-- tables were unreachable by the API role:
--
--     AbsenceReports, CalendarLessonGroups, CalendarLessonStudents,
--     GuardianStudents, IntegrationApiKeys, LeaveRequests, MasterLessonGroups,
--     MasterLessonStudents, Notifications, OptimizationJobs, RoomBookings,
--     ScheduleChangeLogs, ScheduleVersions
--
-- ## Why it broke everything, not just those tables
--
-- The API connects as `app_authenticated`, a member of `authenticated`. On a
-- fresh deployment every authenticated request failed with HTTP 500 during
-- `JwtStrategy.validate`, before reaching any controller:
--
--     Invalid `prisma.user.findUnique()` invocation:
--     PostgresError { code: "42501",
--                     message: "permission denied for table GuardianStudents" }
--
-- Reading `Users` evaluates an RLS policy that references `GuardianStudents`
-- (guardians may see their own students), and evaluating that policy requires
-- privileges on the referenced table. One missing grant took down authentication
-- for the whole API.
--
-- This stayed hidden because the e2e suite substitutes a mock for PrismaService
-- and never touches a real database, and because the solver container could not
-- start at all, so nobody had run the full compose stack end to end.
--
-- ## The fix
--
-- Two parts, and the second is the one that matters: re-grant on everything that
-- exists now, then use ALTER DEFAULT PRIVILEGES so tables created by future
-- migrations are covered automatically. Without the second part this exact
-- regression returns with the next `CREATE TABLE`.
--
-- ALTER DEFAULT PRIVILEGES applies to objects created by the role that runs it.
-- Migrations run as the schema owner, which is also who runs this statement, so
-- future migration-created tables are covered.
--
-- RLS is unaffected: these are table-level privileges, and every row-level
-- policy still applies on top. A grant does not widen row visibility.

DO $$
BEGIN
  -- Not every environment bootstraps both roles (a bare Postgres may have
  -- neither; Supabase has both). Skip cleanly rather than failing the deploy.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT USAGE ON SCHEMA "public" TO "authenticated";
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON ALL TABLES IN SCHEMA "public" TO "authenticated";
    GRANT USAGE, SELECT
      ON ALL SEQUENCES IN SCHEMA "public" TO "authenticated";

    ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "authenticated";
    ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
      GRANT USAGE, SELECT ON SEQUENCES TO "authenticated";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT USAGE ON SCHEMA "public" TO "service_role";
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON ALL TABLES IN SCHEMA "public" TO "service_role";
    GRANT USAGE, SELECT
      ON ALL SEQUENCES IN SCHEMA "public" TO "service_role";

    ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "service_role";
    ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
      GRANT USAGE, SELECT ON SEQUENCES TO "service_role";
  END IF;
END
$$;
