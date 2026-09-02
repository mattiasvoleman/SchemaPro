-- A rast reaches the pupil.
--
-- The declaration in Rasts is what the SCHOOL wrote. This is what a pupil,
-- guardian and teacher read: one row per class per day per rast, dated, and
-- filtered through the same lov rules the lessons and the meal are.
--
-- WHY DATE IT AT ALL, when a rast is the same every Monday. Because a published
-- week has to be a record of that week, and two things make a Monday differ
-- from the rule: a lov, and a school that changed its rasts mid-term. Computing
-- them in the client from the declaration would draw a rast on a studiedag —
-- SchoolBreaks are readable by pupils but no pupil surface reads them — and
-- would silently rewrite last month's published weeks when an admin edits a
-- row. The same two arguments the meal's own table makes.
--
-- PER CLASS, not per stage. A rast is declared for years 4-6, but a pupil is in
-- a class and the RLS arms this table needs are the ones CalendarLunches got in
-- 20260904090000: studentGroupId = current_user_group_id() for a pupil, the
-- guardian's children through Users."studentGroupId", the whole school for
-- staff. Keying on a grade span instead would mean a fourth shape of policy for
-- one table.
--
-- NO academicYearId COLUMN, for the reason the meal's cleanup found: a
-- CalendarRast belongs to a StudentGroup and a StudentGroup belongs to a year,
-- so a relation filter reaches every row a regeneration must drop without a
-- column to backfill and without a join key that is ambiguous in a school's
-- second läsår.

CREATE TABLE "CalendarRasts" (
    "id"             UUID           NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"       UUID           NOT NULL,
    "studentGroupId" UUID           NOT NULL,
    -- Copied from the declaration rather than referenced. The row is a record
    -- of what was published, and a rast that is renamed or deleted in March
    -- must not rewrite February — the same reason a CalendarLesson carries its
    -- own times instead of reading its template's.
    "name"           TEXT           NOT NULL,
    "date"           DATE           NOT NULL,
    "startsAt"       TIMESTAMPTZ(6) NOT NULL,
    "endsAt"         TIMESTAMPTZ(6) NOT NULL,
    "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"      TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "CalendarRasts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CalendarRasts_window_is_ordered" CHECK ("endsAt" > "startsAt"),
    -- One rast per class per start. Several a day is the point, so the start is
    -- part of the key; without it a school with a morning and an afternoon rast
    -- could publish only one of them.
    CONSTRAINT "CalendarRasts_group_date_start_key"
        UNIQUE ("studentGroupId", "date", "startsAt")
);

ALTER TABLE "CalendarRasts"
    ADD CONSTRAINT "CalendarRasts_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The composite key, as every child table here uses: a row may only name a
-- group of its own school, and the database says so for every writer.
ALTER TABLE "CalendarRasts"
    ADD CONSTRAINT "CalendarRasts_studentGroupId_schoolId_fkey"
    FOREIGN KEY ("studentGroupId", "schoolId") REFERENCES "StudentGroups"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "CalendarRasts_schoolId_date_idx" ON "CalendarRasts"("schoolId", "date");
CREATE INDEX "CalendarRasts_studentGroupId_date_idx"
    ON "CalendarRasts"("studentGroupId", "date");

ALTER TABLE "CalendarRasts" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "calendar_rasts_student_select" ON "CalendarRasts"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND "studentGroupId" = (select app.current_user_group_id())
    );

CREATE POLICY "calendar_rasts_guardian_select" ON "CalendarRasts"
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

CREATE POLICY "calendar_rasts_staff_select" ON "CalendarRasts"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) IN ('TEACHER', 'SCHOOL_ADMIN')
    );

CREATE POLICY "calendar_rasts_admin_all" ON "CalendarRasts"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "CalendarRasts" TO "app_authenticated";
  END IF;
END
$$;
