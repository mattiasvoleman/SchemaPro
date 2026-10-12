-- Tjänstenyckeln läser men skriver ingen tabell, och en ny tabell börjar
-- likadant.
--
-- service_role is Supabase's server-side role. PostgREST and pg_graphql run a
-- request as service_role when it carries the service key
-- (SUPABASE_SERVICE_ROLE_KEY), and the role has BYPASSRLS, so no policy and no
-- WITH CHECK applies to it.
--
-- service_role holds SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and
-- TRIGGER on the 46 tables of 20261016110000. The init migration and
-- 20260806000000 granted it SELECT, INSERT, UPDATE and DELETE on every table,
-- and 20260806000000 also put them in the migration role's default ACL in
-- "public". Supabase's own default ACL for that role adds the rest: ALL. From
-- 20261010090000 on, every migration that creates a table revokes INSERT,
-- UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER from service_role by name.
-- Of the 34 tables created since, 31 leave it SELECT, with nothing else since
-- 20261016120000 took MAINTAIN, and three leave it nothing. The national
-- timplan's three tables (20261006090000) leave it SELECT too. The 46 are the
-- other tables, created before that convention: 38 before 20261006090000 and
-- eight by the migrations from 20261006100000 to 20261009100000, which did
-- not revoke. Which group a table falls in depends on its creation date and
-- nothing else.
--
-- Measured on a throwaway supabase/postgres 17.6.1.166 with Supabase's default
-- ACL, migrated as a non-superuser migration role to 20261016120000, seeded
-- and with the RLS fixtures applied. service_role held a write on 46 of the 80
-- tables it reaches and SELECT alone on the other 34. As service_role, in
-- transactions that were rolled back, single statements changed and removed
-- rows of both schools in those tables, Users and GuardianStudents included.
--
-- ## Nothing writes as service_role
--
-- The gateway holds the key, and nothing else does. SupabaseAdminService uses
-- it for GoTrue's admin API: inviteUserByEmail, deleteUser and listUsers. It
-- never calls .from() or .rpc(). GoTrue writes auth.users as its own role,
-- supabase_auth_admin, and no table in "public" has a foreign key into
-- "auth". docs/DEPLOYMENT.md says the key is "used exclusively by the API's
-- user-invite flow". Web and mobile carry the publishable key, which means
-- anon, or authenticated once a user is signed in. The gateway reaches
-- tenant data through PrismaService as app_authenticated. No script, test,
-- ops doc or runbook uses the key against a table. The runbook's one
-- hand-written insert, the first school and admin (docs/DEPLOYMENT.md §7),
-- runs in the SQL editor as the owner. The repository has no Edge Function,
-- database webhook or cron job. The migrations and the seed run as the
-- migration role, which owns the tables.
--
-- ## Why take it although nothing uses it
--
--   * Besides the owner's password, the key is the one credential that
--     writes every school's rows past row security, and it lives outside
--     the database. With it, one PostgREST request could change or remove
--     the rows of every school in a table, as measured above. A leaked key is
--     still serious after this. SELECT stays, and GoTrue's admin API, which
--     can delete or take over any account, is no table grant. What the key
--     loses is the power to change a row.
--   * The newer tables already settle it: service_role reads them and writes
--     none. The 46 should not differ from them only because they are older.
--   * The default ACL hands every new table INSERT, UPDATE and DELETE, and
--     on Supabase ALL, so each migration has to remember to revoke them. The
--     eight above show that remembering fails: 20261006090000 narrowed its
--     own tables, and the five migrations after it that created the eight
--     did not.
--
-- ## The change
--
--   * REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER on the
--     46 tables from service_role. SELECT stays. Guarded on pg_roles like the
--     migrations before it. The init migration creates service_role when it
--     is missing, so this also acts on CI's compose database.
--   * ALTER DEFAULT PRIVILEGES IN SCHEMA "public" REVOKE the same six ON
--     TABLES FROM service_role, for the role that runs the migrations.
--     20260806000000's grant and Supabase's ALL share one entry, so this one
--     statement removes both. A table a later migration creates starts with
--     SELECT for service_role, so a forgotten REVOKE cannot bring the write
--     back. A table that needs the key to write gets a GRANT by name, with
--     its reason.
--
-- With 20261016120000 on 17, service_role then holds SELECT and nothing else
-- on every table in "public" it reaches. Undoing either part is a GRANT.
--
-- Not touched:
--
--   * SELECT. Nothing reads as service_role either. The newer tables draw
--     the line at SELECT, and taking it away would be a decision of its own.
--   * Sequences. "public" has none, since no column is serial or identity.
--     The default ACL for new sequences still gives service_role USAGE,
--     SELECT and UPDATE.
--   * Functions. SchemaPro creates no function of its own in "public".
--     btree_gist (20260822131500) was installed with no SCHEMA, so on a
--     database that did not already have it its distance and support
--     functions sit in "public". They are IMMUTABLE and read no table.
--     The SECURITY DEFINER functions service_role may execute are seven
--     STABLE readers in "app", which PostgREST does not serve.
--   * The default ACL of supabase_admin, which this role cannot alter.
--
-- RLS section 38 asserts that service_role holds none of the six on any
-- table, view or foreign table in "public" or "app", INSERT, UPDATE and
-- REFERENCES on a single column included, and that no default ACL gives
-- new tables any of them.

DO $$
DECLARE
  tbl text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
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
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM "service_role"', tbl);
  END LOOP;

  ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM "service_role";
END
$$;
