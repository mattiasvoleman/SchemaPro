-- A pupil's reads stop at their own school's boundary.
--
-- Nine SELECT policies answered "is this row about my group?" and never "is
-- this row my school's?". Each one keys on app.current_user_group_id() or on
-- the caller's own membership rows, with no schoolId predicate at all.
--
-- That is only theoretical while nothing can plant a foreign row — and
-- something can. TeachingRequirementsService.create and
-- MasterLessonsService.create take subjectId, studentGroupId, teacherId and
-- roomId straight from the request without checking whose they are, and
-- PostgreSQL runs foreign-key checks as the referenced table's owner with row
-- security OFF, so an FK to a row the caller cannot even SELECT still
-- validates. An admin of school A who knows a group id from school B can
-- therefore write a row carrying A's schoolId and B's studentGroupId. B's
-- pupils then see a lesson belonging to another school in their timetable,
-- while B's own admin — whose policies ARE school-scoped — can neither see it
-- nor delete it.
--
-- This migration closes the reading half, which is the half that reaches
-- another tenant's children. The writing half needs composite (schoolId, id)
-- foreign keys on the child tables and is a larger, separate change.
--
-- Narrowing only. A pupil's group is in the pupil's school and always was, so
-- no legitimate row stops being visible; what stops being visible is a row
-- that was never theirs to see. Each policy keeps its own predicate verbatim
-- beside the new one — this is a conjunction added, not a rule rewritten.

DROP POLICY IF EXISTS "calendar_lesson_groups_member_select" ON "CalendarLessonGroups";
CREATE POLICY "calendar_lesson_groups_member_select" ON "CalendarLessonGroups"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (("studentGroupId" = ( SELECT app.current_user_group_id() AS current_user_group_id)))
    );

DROP POLICY IF EXISTS "calendar_lesson_teachers_student_select" ON "CalendarLessonTeachers";
CREATE POLICY "calendar_lesson_teachers_student_select" ON "CalendarLessonTeachers"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND ((EXISTS ( SELECT 1
   FROM "CalendarLessons" cl
  WHERE ((cl.id = "CalendarLessonTeachers"."calendarLessonId") AND (cl."studentGroupId" = ( SELECT app.current_user_group_id() AS current_user_group_id))))))
    );

DROP POLICY IF EXISTS "calendar_lessons_participant_select" ON "CalendarLessons";
CREATE POLICY "calendar_lessons_participant_select" ON "CalendarLessons"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (((EXISTS ( SELECT 1
   FROM "CalendarLessonStudents" cls
  WHERE ((cls."calendarLessonId" = "CalendarLessons".id) AND (cls."studentId" = ( SELECT app.current_user_id() AS current_user_id))))) OR (EXISTS ( SELECT 1
   FROM "CalendarLessonGroups" clg
  WHERE ((clg."calendarLessonId" = "CalendarLessons".id) AND (clg."studentGroupId" = ( SELECT app.current_user_group_id() AS current_user_group_id)))))))
    );

DROP POLICY IF EXISTS "calendar_lessons_student_select" ON "CalendarLessons";
CREATE POLICY "calendar_lessons_student_select" ON "CalendarLessons"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (("studentGroupId" = ( SELECT app.current_user_group_id() AS current_user_group_id)))
    );

DROP POLICY IF EXISTS "calendar_lessons_teaching_group_select" ON "CalendarLessons";
CREATE POLICY "calendar_lessons_teaching_group_select" ON "CalendarLessons"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (("studentGroupId" IN ( SELECT sgm."studentGroupId"
   FROM "StudentGroupMembers" sgm
  WHERE (sgm."studentId" = ( SELECT app.current_user_id() AS current_user_id)))))
    );

DROP POLICY IF EXISTS "master_lesson_groups_member_select" ON "MasterLessonGroups";
CREATE POLICY "master_lesson_groups_member_select" ON "MasterLessonGroups"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (("studentGroupId" = ( SELECT app.current_user_group_id() AS current_user_group_id)))
    );

DROP POLICY IF EXISTS "master_lessons_participant_select" ON "MasterLessons";
CREATE POLICY "master_lessons_participant_select" ON "MasterLessons"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (((EXISTS ( SELECT 1
   FROM "MasterLessonStudents" mls
  WHERE ((mls."masterLessonId" = "MasterLessons".id) AND (mls."studentId" = ( SELECT app.current_user_id() AS current_user_id))))) OR (EXISTS ( SELECT 1
   FROM "MasterLessonGroups" mlg
  WHERE ((mlg."masterLessonId" = "MasterLessons".id) AND (mlg."studentGroupId" = ( SELECT app.current_user_group_id() AS current_user_group_id)))))))
    );

DROP POLICY IF EXISTS "master_lessons_student_select" ON "MasterLessons";
CREATE POLICY "master_lessons_student_select" ON "MasterLessons"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (("studentGroupId" = ( SELECT app.current_user_group_id() AS current_user_group_id)))
    );

DROP POLICY IF EXISTS "student_groups_student_select" ON "StudentGroups";
CREATE POLICY "student_groups_student_select" ON "StudentGroups"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND ((id = ( SELECT app.current_user_group_id() AS current_user_group_id)))
    );

