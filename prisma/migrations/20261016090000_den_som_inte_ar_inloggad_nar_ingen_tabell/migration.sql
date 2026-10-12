-- Den som inte är inloggad når ingen tabell.
--
-- "anon" is the role PostgREST and pg_graphql use for a request that carries
-- the project's publishable key and no user token. Nothing in SchemaPro is
-- meant to reach the database that way:
--
--   * Web and mobile read and write tables directly only once Supabase Auth
--     has a user (web's getSession and mobile's fetchProfile both start from
--     one). The login, forgot-password and update-password pages talk to
--     Supabase Auth, which is not PostgREST.
--   * The public timetable (/v/<token>, 20261011120000) is fetched by the web
--     server from the gateway's /public/v1/timetables, which reads it as
--     app_authenticated through app.public_timetable(). EXECUTE on that
--     function is app_authenticated's alone.
--   * The SS12000 API and every other route without a user are the
--     gateway's, also as app_authenticated.
--
-- Yet on Supabase anon holds ALL (arwdDxt) on 46 tables in "public". No
-- migration granted it. Supabase's default ACL for the migration role in
-- "public" gives anon, authenticated and service_role ALL on every table,
-- sequence and function that role creates. From 20261006090000 on, most
-- migrations revoke anon on their own tables. The 38 tables created before
-- that kept the grant (_prisma_migrations aside, 20260914180000), and so did
-- eight created after it by migrations that did not revoke:
-- StaffingPolicies, TeacherEmployments and
-- TeacherSubjectQualifications (20261006100000), LocalTimplans and
-- LocalTimplanEntries (20261006120000), TeacherDuties (20261007090000),
-- AcademicYearTimplans (20261007130000) and TimplanCredits (20261009100000).
-- The production check of 2026-10-12 showed anon with SELECT, INSERT, UPDATE
-- and DELETE on LeaveRequests and AbsenceReports.
--
-- ## Why it matters although row security is on
--
-- 56 policies on 30 of these tables are TO public, so they apply to anon:
-- the service principal's and the sync's arms (*_service_*, *_sync_*,
-- integration_keys_service_*). Each admits a row on a GUC alone:
-- app.service_school_id, app.sync_school_id or app.service_key_lookup.
-- anon's missing USAGE on schema "app" does not stand in between. A policy
-- holds its functions by oid, and anon executes
-- app.current_service_school_id() through PUBLIC.
--
-- Measured on a throwaway database with Supabase's default ACL, migrated to
-- 20261015140000, seeded and with the RLS fixtures applied. As anon, with no
-- other grant, LeaveRequests and AbsenceReports read as empty and an INSERT
-- was refused by row security. So nothing leaks today. With
-- app.service_school_id set, though, anon read all 91 Users rows of the
-- school, email included, and updated all 91. It also read its guardian
-- links and classes. With app.service_key_lookup = 'on' it read an
-- integration key's hash.
--
-- Today a PostgREST caller has no way to set those GUCs. Add one function in
-- an exposed schema that sets a config value, or one db-pre-request hook,
-- and the table grant would be all that is left. The grant should be the
-- layer that refuses, as it does for every other caller with no business in
-- a table.
--
-- ## The change
--
--   * REVOKE ALL on the 46 tables from anon. Guarded on pg_roles like the
--     migrations before it, so a bare Postgres without anon skips it.
--   * ALTER DEFAULT PRIVILEGES IN SCHEMA "public" REVOKE ALL ON TABLES,
--     SEQUENCES and FUNCTIONS FROM anon, for the role that runs the
--     migrations. A table created by a later migration no longer starts out
--     open to anon, so a forgotten REVOKE cannot reopen this.
--
-- Not touched:
--
--   * anon's USAGE on schema "public". The grant is Supabase's own, and
--     with no table, sequence or function of ours open to anon it reaches
--     nothing of ours.
--   * Supabase's own schemas, and the default ACL of supabase_admin, which
--     this role cannot alter.
--   * EXECUTE that PUBLIC holds on functions by Postgres's default.
--   * What authenticated and service_role hold.
--
-- There is nothing else of ours to revoke. The schema has no sequence (every
-- id is a uuid) and no function of its own in "public". pgcrypto and
-- btree_gist are extensions, and on Supabase pgcrypto lives in "extensions".
-- RLS section 36 names what anon still holds.

DO $$
DECLARE
  tbl text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
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
    EXECUTE format('REVOKE ALL ON %I FROM "anon"', tbl);
  END LOOP;

  ALTER DEFAULT PRIVILEGES IN SCHEMA "public" REVOKE ALL ON TABLES FROM "anon";
  ALTER DEFAULT PRIVILEGES IN SCHEMA "public" REVOKE ALL ON SEQUENCES FROM "anon";
  ALTER DEFAULT PRIVILEGES IN SCHEMA "public" REVOKE ALL ON FUNCTIONS FROM "anon";
END
$$;
