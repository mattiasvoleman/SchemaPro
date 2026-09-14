-- The SS12000 service principal reads what a lesson is made of, not only the
-- lesson.
--
-- ## Why
--
-- 20260806010000_service_principal_policies gave `app.service_school_id`
-- SELECT on seven tables. `/activities` and `/calendarEvents` select through
-- seven more: Subjects, Rooms, MasterLessonGroups, MasterLessonStudents,
-- CalendarLessonTeachers, CalendarLessonGroups and CalendarLessonStudents.
-- Every policy on those is TO "authenticated" and keyed on the caller's JWT
-- claims — app.current_school_id(), app.current_user_role(),
-- app.current_user_id() — which are all NULL for a request that has no user.
-- So under the principal those seven tables are empty.
--
-- Measured on a throwaway database, as app_authenticated, with a lesson in
-- each of two schools and a row in every one of these tables for each lesson:
--
--   - With app.service_school_id set to the first school, MasterLessons and
--     CalendarLessons show their one row each and the seven tables show 0.
--     The owner counts 8 subjects, 7 rooms and one row in each link table.
--   - The real Ss12000Service through PrismaService: `organisation` and
--     `groups` answer; `activities` and `calendarEvents` both throw
--     PrismaClientUnknownRequestError, "Inconsistent query result: Field
--     subject is required to return data, got `null` instead."
--     HttpExceptionFilter answers that class with a 500.
--
-- So neither feed answers for a school with a single lesson, and
-- `git grep current_service_school_id` finds no other migration that could
-- have covered it. scripts/test/rls-policies.sql could not see it: the seed
-- creates no lessons, and section 3 counted only Users and StudentGroups. The
-- e2e suite mocks PrismaService.
--
-- ## Why all seven, and not only the one that throws
--
-- The 500 comes from the required relation; the list relations fail quietly.
-- With service-principal policies on Subjects and Rooms alone, both feeds
-- answered 200. The activity had `studentIds: []` and only its home class in
-- `groupIds`, and the calendar event had `teachers: []` as well: a lesson
-- taught to its home class alone, by nobody, to no named pupil. That is the
-- empty payload that reads as real data, which 20260806010000 was written
-- against.
--
-- ## What is granted
--
-- SELECT, on rows whose own "schoolId" is the principal's school: the same
-- predicate as the seven policies before these, and like them no TO clause,
-- since what gates them is a setting only PrismaService.withServicePrincipal
-- sets. The feeds only read these tables and importPersons writes none of
-- them, so there is no INSERT, UPDATE or DELETE.
--
-- The predicate asks the row's own school, not its lesson's. Every link table
-- references its lesson by id alone — MasterLessonGroups and
-- MasterLessonStudents pin their school to the class's and the pupil's, the
-- CalendarLesson ones not even that — so a link row can carry a school other
-- than its lesson's. The principal of the lesson's school then does not see
-- it, and the principal of the school it carries sees no more than that
-- school's own admin already does. Hidden, not leaked.
--
-- The feeds read teachers and pupils as id columns (teacherId, coTeacherId,
-- studentId), not through relations, so Users needs nothing more.

-- A lesson's subject (required, and the one that throws) and its room.
DROP POLICY IF EXISTS subjects_service_select ON "Subjects";
CREATE POLICY subjects_service_select
  ON "Subjects"
  FOR SELECT
  USING ("schoolId" = app.current_service_school_id());

DROP POLICY IF EXISTS rooms_service_select ON "Rooms";
CREATE POLICY rooms_service_select
  ON "Rooms"
  FOR SELECT
  USING ("schoolId" = app.current_service_school_id());

-- /activities: a weekly lesson's extra classes and named pupils.
DROP POLICY IF EXISTS master_lesson_groups_service_select ON "MasterLessonGroups";
CREATE POLICY master_lesson_groups_service_select
  ON "MasterLessonGroups"
  FOR SELECT
  USING ("schoolId" = app.current_service_school_id());

DROP POLICY IF EXISTS master_lesson_students_service_select ON "MasterLessonStudents";
CREATE POLICY master_lesson_students_service_select
  ON "MasterLessonStudents"
  FOR SELECT
  USING ("schoolId" = app.current_service_school_id());

-- /calendarEvents: a dated lesson's teachers, extra classes and named pupils.
DROP POLICY IF EXISTS calendar_lesson_teachers_service_select ON "CalendarLessonTeachers";
CREATE POLICY calendar_lesson_teachers_service_select
  ON "CalendarLessonTeachers"
  FOR SELECT
  USING ("schoolId" = app.current_service_school_id());

DROP POLICY IF EXISTS calendar_lesson_groups_service_select ON "CalendarLessonGroups";
CREATE POLICY calendar_lesson_groups_service_select
  ON "CalendarLessonGroups"
  FOR SELECT
  USING ("schoolId" = app.current_service_school_id());

DROP POLICY IF EXISTS calendar_lesson_students_service_select ON "CalendarLessonStudents";
CREATE POLICY calendar_lesson_students_service_select
  ON "CalendarLessonStudents"
  FOR SELECT
  USING ("schoolId" = app.current_service_school_id());
