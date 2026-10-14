-- Den inloggade läser bara sin egen tjänst, frånvaro, klasshistorik och
-- undervisningstid direkt; det om andra går genom API:t och läsloggen.
--
-- 20261026100000 took PostgREST's authenticated off other people's rows in
-- six tables. The gateway now records more reads than those six: staff
-- absences and the cover board, posts, uppdrag and their history, a pupil's
-- timplan coverage and statement, and the SS12000 sync's change review
-- (20261026110000 and its release). The tables those reads come from still
-- answered authenticated directly, under the same policies the gateway
-- uses: an administrator every staff absence with its reason and every
-- lesson an absent teacher missed, every post with its percentages and
-- note, every uppdrag and the posts' history, every pupil's class history
-- and statement, and every pending SS12000 change with the before and after
-- of the people in it; a teacher every pupil's class history; a guardian
-- their children's history and statements. None of that passed the gateway,
-- so the log could be read around. No client reads any of these tables
-- directly, in this release or in the one before it: web/ and mobile/ were
-- searched for .from(...), embeds in a select, REST paths and realtime
-- subscriptions.
--
-- ## The change
--
-- ALTER POLICY ... TO "app_authenticated" on every arm of these tables that
-- shows a row other than the reader's own (FOR SELECT, and FOR ALL, whose
-- SELECT part is such an arm):
--
--   TeacherAbsences        teacher_absences_admin_all
--   TeacherAbsenceCovers   teacher_absence_covers_admin_all
--   TeacherEmployments     teacher_employments_admin_all
--   TeacherEmploymentLogs  teacher_employment_logs_admin_select
--   TeacherDuties          teacher_duties_admin_all
--   StudentEnrollments     student_enrollments_admin_select,
--                          student_enrollments_staff_select,
--                          student_enrollments_guardian_select
--   TimplanStatements      timplan_statements_admin_all,
--                          timplan_statements_guardian_select
--   Ss12000SyncChanges     ss12000_sync_changes_admin_select
--
-- TeacherAbsenceCovers is the cover board's table: each row names the
-- absent teacher and the lesson they missed, so it is a staff absence as
-- much as TeacherAbsences is, and the board that reads it records
-- STAFF_ABSENCES.
--
-- A FOR ALL arm moves whole, so its INSERT, UPDATE and DELETE become the
-- API's alone too. Every write to these tables already goes through the
-- gateway (staffing, cover, the statements' publication, the sync), which
-- keeps the arms; no client writes them. As in 20261026100000: TO alone
-- keeps the command, USING and WITH CHECK; app_authenticated is a member of
-- authenticated and keeps every arm it had; no table grant changes; a
-- missing arm fails the migration instead of being skipped; and a bare
-- Postgres without app_authenticated keeps its arms where they are.
--
-- ## What authenticated still reads directly: own rows
--
--   TeacherAbsences        teacher_absences_own_select (userId = the
--                          reader), and the self-report's own_insert and
--                          own_update, unchanged
--   TeacherAbsenceCovers   teacher_absence_covers_own_select
--                          (absentTeacherId = the reader)
--   TeacherEmployments     teacher_employments_teacher_own_select
--   TeacherEmploymentLogs  teacher_employment_logs_teacher_own_select
--   TeacherDuties          teacher_duties_teacher_own_select
--   StudentEnrollments     student_enrollments_student_select
--                          (studentId = the reader)
--   TimplanStatements      timplan_statements_student_select
--   Ss12000SyncChanges     nothing
--
-- No client reads even these directly; they stay because each is the
-- reader's own, which the log leaves out anyway. The write arm
-- ss12000_sync_changes_admin_update stays TO authenticated, like every
-- write arm 20261026100000 left: an UPDATE that names its rows reads them
-- under the SELECT arms, so a direct one now finds none.
--
-- ## Left as they are
--
--   TimplanCredits    a credited day names nobody (a date, minutes, a
--                     subject, a class or a grade range). The log has
--                     nothing to record of it, and staff read it like the
--                     rest of the school's planning.
--   TeacherDutySlots  a slot is two ids, an uppdrag's and its time's. The
--                     times are AvailabilityConstraints, part of the
--                     timetable layer that the web reads directly and the
--                     log does not record (src/access-log/access-log.ts
--                     says why).
--
-- ## What else reads these tables as authenticated
--
-- One policy on another table reads one of them as the reader:
-- teacher_duty_slots_teacher_own_select (TeacherDutySlots) reads
-- TeacherDuties WHERE userId = the reader, which
-- teacher_duties_teacher_own_select still answers, so a teacher's direct
-- read of their own uppdrag's times is unchanged.
--
-- Functions that read the tables run as their owner (SECURITY DEFINER) and
-- see past row security: the staffing log and duty-slot triggers, the cover
-- guards, app.family_lesson_staff, app.public_timetable, app.ss12000_*,
-- app.student_enrollments_follow_*, app.gallring_*. The one SECURITY
-- INVOKER reader, app.gallring_due, is executable by its owner alone. RLS
-- section 128 asserts all of this from the catalogue, and 129 the
-- behaviour as both roles.
--
-- ## Order
--
-- Any time after 20261026100000. Unlike that one, it waits for no release:
-- no client, the one in production included, reads these tables directly.
-- Nothing in the code depends on it; it only takes away.

DO $$
DECLARE
  arm record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    RETURN;
  END IF;

  FOR arm IN SELECT * FROM (VALUES
    ('TeacherAbsences', 'teacher_absences_admin_all'),
    ('TeacherAbsenceCovers', 'teacher_absence_covers_admin_all'),
    ('TeacherEmployments', 'teacher_employments_admin_all'),
    ('TeacherEmploymentLogs', 'teacher_employment_logs_admin_select'),
    ('TeacherDuties', 'teacher_duties_admin_all'),
    ('StudentEnrollments', 'student_enrollments_admin_select'),
    ('StudentEnrollments', 'student_enrollments_staff_select'),
    ('StudentEnrollments', 'student_enrollments_guardian_select'),
    ('TimplanStatements', 'timplan_statements_admin_all'),
    ('TimplanStatements', 'timplan_statements_guardian_select'),
    ('Ss12000SyncChanges', 'ss12000_sync_changes_admin_select')
  ) AS t(tbl, name)
  LOOP
    EXECUTE format('ALTER POLICY %I ON %I TO "app_authenticated"', arm.name, arm.tbl);
  END LOOP;
END
$$;
