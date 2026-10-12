-- Den inloggade tömmer ingen tabell, sätter ingen trigger på den och pekar
-- ingen främmande nyckel mot den.
--
-- "authenticated" is the role PostgREST uses for a signed-in web or mobile
-- user. app_authenticated, which the gateway connects as, is a member of it
-- with INHERIT (docs/DEPLOYMENT.md §3), so whatever authenticated holds, the
-- API holds too.
--
-- On Supabase authenticated holds TRUNCATE, REFERENCES and TRIGGER on 46
-- tables in "public". No migration granted them. Supabase's default ACL for
-- the migration role in "public" gives anon, authenticated and service_role
-- ALL on every table that role creates. 20260806000000 granted SELECT,
-- INSERT, UPDATE and DELETE, which is what web, mobile and the gateway use,
-- and revoked nothing. From 20261010090000 on, every migration that creates a
-- table revokes the three from authenticated on it. The 46 are the tables
-- created before that, the same 46 that gave anon ALL until 20261016090000.
-- The national timplan's tables (20261006090000) are reference data and were
-- narrowed to SELECT when they were created.
--
-- ## Why it matters although row security is on
--
--   * TRUNCATE does not consult row security, and no row trigger fires. A
--     role that holds it empties a table for every school at once.
--   * TRIGGER lets the role attach any trigger function it may execute to
--     the table. The function then runs on every write by anyone, the API's
--     and the migration role's included.
--   * REFERENCES lets the role point a foreign key at the table from a table
--     of its own. The key then holds the rows it names in place.
--
-- Measured on a throwaway database with Supabase's default ACL, migrated to
-- 20261016100000, seeded and with the RLS fixtures applied. authenticated,
-- and app_authenticated through it, held all three on exactly those 46 tables
-- and on no other. As app_authenticated with no user claims, row security
-- showed 0 rows of GuardianStudents. TRUNCATE "GuardianStudents" still
-- emptied it for both schools, and so did the same statement as
-- authenticated. As app_authenticated, CREATE TRIGGER on GuardianStudents
-- succeeded. On CI's compose database authenticated holds none of the three,
-- since that database has no Supabase default ACL.
--
-- Nothing uses them, as either role. PostgREST cannot issue TRUNCATE or any
-- DDL, and web and mobile reach tables only through supabase-js .from(). The
-- gateway's SQL is DML through PrismaService. Outside the RLS suite, which
-- tries them as the API's roles only to see them refused, every TRUNCATE,
-- CREATE TRIGGER and DISABLE TRIGGER in the repository runs as the owner: in
-- the adapter and SS12000 probes and in scripts/bench. The migrations and the
-- seed run as the owner too.
--
-- ## The change
--
--   * REVOKE TRUNCATE, REFERENCES, TRIGGER on the 46 tables from
--     authenticated, and from app_authenticated in case it was given any of
--     them directly. SELECT, INSERT, UPDATE and DELETE stay as they are.
--     Guarded on pg_roles like the migrations before it, so a bare Postgres
--     without the roles skips it.
--   * ALTER DEFAULT PRIVILEGES IN SCHEMA "public" REVOKE TRUNCATE,
--     REFERENCES, TRIGGER ON TABLES FROM authenticated, for the role that
--     runs the migrations. A table a later migration creates no longer
--     starts out with them, so a forgotten REVOKE cannot bring this back.
--     The default's SELECT, INSERT, UPDATE and DELETE stay.
--
-- Not touched:
--
--   * service_role. It bypasses row security anyway, and its key is
--     Supabase's server-side secret.
--   * anon, which holds nothing since 20261016090000.
--   * The default ACL of supabase_admin, which this role cannot alter.
--
-- RLS section 38 asserts that neither role holds any of the three on any
-- table in "public" and that no default ACL entry gives them.

DO $$
DECLARE
  tbl text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    RETURN;
  END IF;

  FOREACH tbl IN ARRAY ARRAY[
    'AbsenceReports', 'AcademicYearTimplans', 'AcademicYears',
    'AttendanceRecords', 'AvailabilityConstraints', 'CalendarLessonGroups',
    'CalendarLessonStudents', 'CalendarLessonTeachers', 'CalendarLessons',
    'CalendarLunches', 'CalendarRasts', 'FrameTimes', 'GuardianStudents',
    'IntegrationApiKeys', 'LeaveRequests', 'LocalTimplanEntries',
    'LocalTimplans', 'LunchServings', 'LunchSettings', 'LunchSittings',
    'MasterLessonGroups', 'MasterLessonStudents', 'MasterLessons',
    'Notifications', 'OptimizationJobs', 'Rasts', 'RoomBookings',
    'RoomPreferenceRooms', 'RoomPreferences', 'RoomTypes', 'Rooms',
    'ScheduleChangeLogs', 'ScheduleVersions', 'SchoolBreaks', 'Schools',
    'StaffingPolicies', 'StudentGroupMembers', 'StudentGroups', 'Subjects',
    'TeacherDuties', 'TeacherEmployments', 'TeacherSubjectQualifications',
    'TeacherWorkRules', 'TeachingRequirements', 'TimplanCredits', 'Users'
  ] LOOP
    EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON %I FROM "authenticated"', tbl);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
      EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON %I FROM "app_authenticated"', tbl);
    END IF;
  END LOOP;

  ALTER DEFAULT PRIVILEGES IN SCHEMA "public" REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM "authenticated";
END
$$;
