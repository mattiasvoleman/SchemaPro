-- Lesson participants: a lesson can span multiple classes and/or individual
-- students from different classes (joint activities, electives, support).

CREATE TABLE "MasterLessonGroups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "masterLessonId" UUID NOT NULL,
    "studentGroupId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MasterLessonGroups_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "MasterLessonStudents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "masterLessonId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MasterLessonStudents_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "CalendarLessonGroups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "calendarLessonId" UUID NOT NULL,
    "studentGroupId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CalendarLessonGroups_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "CalendarLessonStudents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "calendarLessonId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CalendarLessonStudents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MasterLessonGroups_masterLessonId_studentGroupId_key" ON "MasterLessonGroups"("masterLessonId", "studentGroupId");
CREATE INDEX "MasterLessonGroups_schoolId_idx" ON "MasterLessonGroups"("schoolId");
CREATE INDEX "MasterLessonGroups_studentGroupId_idx" ON "MasterLessonGroups"("studentGroupId");
CREATE UNIQUE INDEX "MasterLessonStudents_masterLessonId_studentId_key" ON "MasterLessonStudents"("masterLessonId", "studentId");
CREATE INDEX "MasterLessonStudents_schoolId_idx" ON "MasterLessonStudents"("schoolId");
CREATE INDEX "MasterLessonStudents_studentId_idx" ON "MasterLessonStudents"("studentId");
CREATE UNIQUE INDEX "CalendarLessonGroups_calendarLessonId_studentGroupId_key" ON "CalendarLessonGroups"("calendarLessonId", "studentGroupId");
CREATE INDEX "CalendarLessonGroups_schoolId_idx" ON "CalendarLessonGroups"("schoolId");
CREATE INDEX "CalendarLessonGroups_studentGroupId_idx" ON "CalendarLessonGroups"("studentGroupId");
CREATE UNIQUE INDEX "CalendarLessonStudents_calendarLessonId_studentId_key" ON "CalendarLessonStudents"("calendarLessonId", "studentId");
CREATE INDEX "CalendarLessonStudents_schoolId_idx" ON "CalendarLessonStudents"("schoolId");
CREATE INDEX "CalendarLessonStudents_studentId_idx" ON "CalendarLessonStudents"("studentId");

ALTER TABLE "MasterLessonGroups" ADD CONSTRAINT "MasterLessonGroups_masterLessonId_fkey" FOREIGN KEY ("masterLessonId") REFERENCES "MasterLessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MasterLessonGroups" ADD CONSTRAINT "MasterLessonGroups_studentGroupId_fkey" FOREIGN KEY ("studentGroupId") REFERENCES "StudentGroups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MasterLessonStudents" ADD CONSTRAINT "MasterLessonStudents_masterLessonId_fkey" FOREIGN KEY ("masterLessonId") REFERENCES "MasterLessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MasterLessonStudents" ADD CONSTRAINT "MasterLessonStudents_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CalendarLessonGroups" ADD CONSTRAINT "CalendarLessonGroups_calendarLessonId_fkey" FOREIGN KEY ("calendarLessonId") REFERENCES "CalendarLessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CalendarLessonGroups" ADD CONSTRAINT "CalendarLessonGroups_studentGroupId_fkey" FOREIGN KEY ("studentGroupId") REFERENCES "StudentGroups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CalendarLessonStudents" ADD CONSTRAINT "CalendarLessonStudents_calendarLessonId_fkey" FOREIGN KEY ("calendarLessonId") REFERENCES "CalendarLessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CalendarLessonStudents" ADD CONSTRAINT "CalendarLessonStudents_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS (mirrors the project-wide pattern)
ALTER TABLE "MasterLessonGroups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MasterLessonStudents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CalendarLessonGroups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CalendarLessonStudents" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    tbl text;
BEGIN
    FOREACH tbl IN ARRAY ARRAY['MasterLessonGroups','MasterLessonStudents','CalendarLessonGroups','CalendarLessonStudents']
    LOOP
        EXECUTE format($f$
            CREATE POLICY %I ON %I FOR SELECT TO "authenticated"
            USING (
                "schoolId" = (select app.current_school_id())
                AND (select app.current_user_role()) IN ('TEACHER','SCHOOL_ADMIN')
            )$f$, lower(tbl) || '_staff_select', tbl);
        EXECUTE format($f$
            CREATE POLICY %I ON %I FOR ALL TO "authenticated"
            USING (
                "schoolId" = (select app.current_school_id())
                AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
            )
            WITH CHECK (
                "schoolId" = (select app.current_school_id())
                AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
            )$f$, lower(tbl) || '_admin_all', tbl);
    END LOOP;
END
$$;

-- Students can see their own participant rows / their class's extra lessons.
CREATE POLICY "master_lesson_students_self_select" ON "MasterLessonStudents"
    FOR SELECT TO "authenticated"
    USING ("studentId" = (select app.current_user_id()));
CREATE POLICY "calendar_lesson_students_self_select" ON "CalendarLessonStudents"
    FOR SELECT TO "authenticated"
    USING ("studentId" = (select app.current_user_id()));
CREATE POLICY "master_lesson_groups_member_select" ON "MasterLessonGroups"
    FOR SELECT TO "authenticated"
    USING ("studentGroupId" = (select app.current_user_group_id()));
CREATE POLICY "calendar_lesson_groups_member_select" ON "CalendarLessonGroups"
    FOR SELECT TO "authenticated"
    USING ("studentGroupId" = (select app.current_user_group_id()));

-- Students must also SEE lessons they attend as participants (individually or
-- because their class is an extra class), on top of the primary-group policy.
CREATE POLICY "master_lessons_participant_select" ON "MasterLessons"
    FOR SELECT TO "authenticated"
    USING (
        EXISTS (
            SELECT 1 FROM "MasterLessonStudents" mls
            WHERE mls."masterLessonId" = "MasterLessons"."id"
              AND mls."studentId" = (select app.current_user_id())
        )
        OR EXISTS (
            SELECT 1 FROM "MasterLessonGroups" mlg
            WHERE mlg."masterLessonId" = "MasterLessons"."id"
              AND mlg."studentGroupId" = (select app.current_user_group_id())
        )
    );

CREATE POLICY "calendar_lessons_participant_select" ON "CalendarLessons"
    FOR SELECT TO "authenticated"
    USING (
        EXISTS (
            SELECT 1 FROM "CalendarLessonStudents" cls
            WHERE cls."calendarLessonId" = "CalendarLessons"."id"
              AND cls."studentId" = (select app.current_user_id())
        )
        OR EXISTS (
            SELECT 1 FROM "CalendarLessonGroups" clg
            WHERE clg."calendarLessonId" = "CalendarLessons"."id"
              AND clg."studentGroupId" = (select app.current_user_group_id())
        )
    );
