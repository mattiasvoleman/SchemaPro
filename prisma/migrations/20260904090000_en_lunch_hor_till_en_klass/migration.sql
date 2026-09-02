-- En lunch hör till en klass, inte till skolan.
--
-- CalendarLunches and LunchSittings shipped with one read policy each, and both
-- said the same thing: `"schoolId" = current_school_id()`. The comment above
-- them argued, correctly, that a pupil looking up when they eat is asking an
-- ordinary question. It then answered a different one — every class's meal, for
-- every pupil in the school.
--
-- The pupil page compounded it. Two comments there claim RLS scopes the read
-- "the same way the lessons are scoped", so no group filter was written. The
-- lessons are scoped: calendar_lessons_student_select matches
-- `"studentGroupId" = current_user_group_id()`. The meal never was.
--
-- The three arms below are the ones CalendarLessons has carried since the init
-- migration, in the same order and the same shape, so there is one pattern in
-- this database rather than two.
--
-- THE GUARDIAN ARM GOES THROUGH Users."studentGroupId", NOT StudentGroupMembers.
--
-- That is the correction. calendar_lessons_guardian_teaching_group_select has
-- been carried through two migrations keying on StudentGroupMembers, which by
-- the schema's own definition holds the TEACHING groups a pupil attends in
-- addition to their home class; nothing writes a row there for a home class,
-- and the CSV importer puts the class on Users."studentGroupId" and only ever
-- creates TEACHING_GROUP groups. A guardian reading through that table sees
-- nothing, which is why no surface has ever noticed it is there. A meal is
-- served to the home class, so the home class is the join.
--
-- WHAT THIS TAKES AWAY. A pupil whose Users."studentGroupId" is null sees every
-- meal in the school today and no meal after this migration. That is the
-- correct answer to "when does your class eat" for a pupil who is in no class,
-- and it is a change in what they can read. Count those rows before deploying.

DROP POLICY IF EXISTS "lunch_sittings_member_select" ON "LunchSittings";
DROP POLICY IF EXISTS "calendar_lunches_member_select" ON "CalendarLunches";

-- A pupil sees their own class's meal.
CREATE POLICY "lunch_sittings_student_select" ON "LunchSittings"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND "studentGroupId" = (select app.current_user_group_id())
    );

CREATE POLICY "calendar_lunches_student_select" ON "CalendarLunches"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND "studentGroupId" = (select app.current_user_group_id())
    );

-- A guardian sees their own children's. The tenant guard on GuardianStudents is
-- not decoration: it is what 20260822090000_guardian_links_are_tenant_scoped
-- added to every one of these subqueries, because a forged link would otherwise
-- reach across schools.
CREATE POLICY "lunch_sittings_guardian_select" ON "LunchSittings"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND "studentGroupId" IN (
            SELECT u."studentGroupId"
            FROM "Users" u
            JOIN "GuardianStudents" gs ON gs."studentId" = u."id"
            WHERE gs."guardianId" = (select app.current_user_id())
              AND gs."schoolId" = (select app.current_school_id())
              AND u."studentGroupId" IS NOT NULL
        )
    );

CREATE POLICY "calendar_lunches_guardian_select" ON "CalendarLunches"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND "studentGroupId" IN (
            SELECT u."studentGroupId"
            FROM "Users" u
            JOIN "GuardianStudents" gs ON gs."studentId" = u."id"
            WHERE gs."guardianId" = (select app.current_user_id())
              AND gs."schoolId" = (select app.current_school_id())
              AND u."studentGroupId" IS NOT NULL
        )
    );

-- Teachers and admins see every meal in their school, exactly as they see every
-- lesson. The kitchen flow on /admin/lunch-servings and the bands on
-- /admin/timetable both read the whole school's sittings and would go blank
-- without this arm.
CREATE POLICY "lunch_sittings_staff_select" ON "LunchSittings"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) IN ('TEACHER', 'SCHOOL_ADMIN')
    );

CREATE POLICY "calendar_lunches_staff_select" ON "CalendarLunches"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) IN ('TEACHER', 'SCHOOL_ADMIN')
    );
