-- A student's schedule must include their TEACHING-GROUP lessons, not only
-- the home class. calendar_lessons_student_select matches on
-- app.current_user_group_id() (the home class); this companion policy adds
-- lessons whose group the student belongs to via StudentGroupMembers.
-- Policies are OR-combined, so the existing home-class and participant
-- policies keep working unchanged.

CREATE POLICY "calendar_lessons_teaching_group_select" ON "CalendarLessons"
    FOR SELECT TO "authenticated"
    USING (
        "studentGroupId" IN (
            SELECT sgm."studentGroupId" FROM "StudentGroupMembers" sgm
            WHERE sgm."studentId" = (select app.current_user_id())
        )
    );

-- Guardians follow their children's lessons the same way (the existing
-- guardian policies on CalendarLessons, if any, cover the home class via the
-- child's group; this arm covers teaching groups).
CREATE POLICY "calendar_lessons_guardian_teaching_group_select" ON "CalendarLessons"
    FOR SELECT TO "authenticated"
    USING (
        "studentGroupId" IN (
            SELECT sgm."studentGroupId"
            FROM "StudentGroupMembers" sgm
            JOIN "GuardianStudents" gs ON gs."studentId" = sgm."studentId"
            WHERE gs."guardianId" = (select app.current_user_id())
        )
    );
