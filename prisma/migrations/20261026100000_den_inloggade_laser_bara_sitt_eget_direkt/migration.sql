-- Den inloggade läser bara sitt eget direkt; allt annat om andra går genom
-- API:t och läsloggen.
--
-- The read log (20261026091000) is complete only if no other way in reads
-- the same rows. Until now PostgREST's authenticated, the role every signed-
-- in web and app user holds with their own JWT, could SELECT other people's
-- rows in six tables under the same policies the gateway uses: an
-- administrator every person with e-mail and phone, every mark and every
-- reported absence and leave reason; a teacher every person and every mark
-- of the school; a guardian their children's rows. Those reads never passed
-- the gateway, so nothing recorded them. The web and the app now read all of
-- it through the gateway (Läslogg's web and app commits), so the policies
-- that granted it stop applying to authenticated.
--
-- ## The change
--
-- ALTER POLICY ... TO "app_authenticated" on every arm of the six tables that
-- shows a row other than the reader's own (FOR SELECT, and FOR ALL, whose
-- SELECT part is such an arm):
--
--   Users                users_admin_all, users_staff_select,
--                        users_guardian_children_select
--   AttendanceRecords    attendance_admin_all, attendance_staff_select
--   AbsenceReports       absence_reports_admin_all,
--                        absence_reports_guardian_select
--   LeaveRequests        leave_requests_admin_all,
--                        leave_requests_guardian_select
--   GuardianStudents     guardian_students_admin_all,
--                        guardian_students_staff_select
--   StudentGroupMembers  student_group_members_admin_all,
--                        student_group_members_staff_select,
--                        student_group_members_guardian_select
--
-- ALTER POLICY with TO alone keeps the command, USING and WITH CHECK. The
-- gateway connects as app_authenticated, a member of authenticated, so it
-- keeps every arm it had: the ones that stay TO authenticated and these. No
-- table grant changes, so the grant chain 20260806000000 restored (the API's
-- role holds its table privileges through authenticated) is untouched: a
-- revoked GRANT here would have refused the API itself, and every policy on
-- another table that reads one of the six, with 42501, as that migration
-- recounts.
--
-- A missing arm fails the migration instead of being skipped, so a database
-- the migrations did not shape is noticed. Guarded on pg_roles like
-- 20261016100000: a bare Postgres without app_authenticated has no API role
-- to give the arms to, and there they stay.
--
-- ## What authenticated still reads directly: own rows
--
--   Users                users_self_select (id = the reader): the web's
--                        session (lib/auth.ts) and the app's profile
--   AttendanceRecords    attendance_student_select: a pupil's own marks
--                        (the web's /student/attendance)
--   AbsenceReports       absence_reports_student_select: a pupil's own
--   LeaveRequests        leave_requests_student_select: a pupil's own
--   GuardianStudents     guardian_students_own_select (guardianId = the
--                        reader): a guardian's own links
--   StudentGroupMembers  student_group_members_own_select: a pupil's own
--
-- None of these is a read of someone else's data. The INSERT, UPDATE and
-- DELETE arms TO authenticated are not changed here; a direct write through
-- PostgREST that reads its row back now sees only the reader's own, and no
-- client makes one (all of them write through the gateway).
--
-- ## What else reads the six tables as authenticated
--
-- Policies on other tables whose predicates read them (evaluated as the
-- reader, under the six tables' own row security):
--
--   absence_reports_guardian_insert, leave_requests_guardian_insert,
--   student_enrollments_guardian_select, timplan_statements_guardian_select,
--   and the guardian arms above read GuardianStudents WHERE guardianId = the
--   reader: guardian_students_own_select still answers exactly those rows.
--   calendar_lessons_teaching_group_select reads StudentGroupMembers WHERE
--   studentId = the reader: student_group_members_own_select answers them,
--   so a pupil's direct read of their teaching groups' lessons is unchanged.
--   lunch_sittings_guardian_select reads Users ⨝ GuardianStudents for the
--   guardian's children: as authenticated it now finds no child (the
--   children arm is the gateway's), so a guardian's DIRECT read of
--   LunchSittings answers nothing. No client makes one; the family schedule
--   reads the sittings through the gateway (app_authenticated), unchanged.
--
-- Functions that read the six tables run as their owner (SECURITY DEFINER)
-- and see past row security: app.current_* (the claims' user, school and
-- role), app.current_guardian_* (a guardian's children, classes, groups),
-- app.family_lesson_staff, app.public_*, app.push_targets,
-- app.reported_absences, app.ss12000_*, app.gallring_*, app.delivery_opt_outs
-- and the triggers. The one SECURITY INVOKER reader, app.gallring_due, is
-- executable by its owner alone. RLS section 126 asserts all of this from the
-- catalogue, and 127 the behaviour as both roles.
--
-- ## Order
--
-- After the release whose web and app read through the gateway is live,
-- never with it: an open browser tab of the web before it still reads the
-- six tables directly and would show empty lists until reloaded. The app has
-- no store build, so no installed app reads them. Nothing in the code
-- depends on this migration; it only takes away.

DO $$
DECLARE
  arm record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    RETURN;
  END IF;

  FOR arm IN SELECT * FROM (VALUES
    ('Users', 'users_admin_all'),
    ('Users', 'users_staff_select'),
    ('Users', 'users_guardian_children_select'),
    ('AttendanceRecords', 'attendance_admin_all'),
    ('AttendanceRecords', 'attendance_staff_select'),
    ('AbsenceReports', 'absence_reports_admin_all'),
    ('AbsenceReports', 'absence_reports_guardian_select'),
    ('LeaveRequests', 'leave_requests_admin_all'),
    ('LeaveRequests', 'leave_requests_guardian_select'),
    ('GuardianStudents', 'guardian_students_admin_all'),
    ('GuardianStudents', 'guardian_students_staff_select'),
    ('StudentGroupMembers', 'student_group_members_admin_all'),
    ('StudentGroupMembers', 'student_group_members_staff_select'),
    ('StudentGroupMembers', 'student_group_members_guardian_select')
  ) AS t(tbl, name)
  LOOP
    EXECUTE format('ALTER POLICY %I ON %I TO "app_authenticated"', arm.name, arm.tbl);
  END LOOP;
END
$$;
