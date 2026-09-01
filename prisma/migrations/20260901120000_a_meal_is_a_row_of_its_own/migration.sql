-- The lunch the solver chose, stored — weekly, and then dated by publish.
--
-- Two tables, mirroring MasterLessons -> CalendarLessons, because a meal moves
-- through the product on exactly the same path a lesson does: the solver writes
-- a weekly row, publish materialises it onto dates, and the portals read the
-- dated one.
--
-- WHY NOT A MasterLesson WITH A "Lunch" SUBJECT. That was the first design and
-- it is wrong for reasons that only show up two tables away. Publish copies
-- `subjectId` off the template without inspecting it, so a lunch row WOULD
-- publish cleanly — the barrier is not the schema. It is that everything
-- downstream reads CalendarLessons and assumes every row is teaching:
-- ss12000.service.ts stamps `activityType: 'Undervisning'` on all of them and
-- would report lunch to the kommun as a lesson, and attendance.service.ts
-- builds "markerades frånvarande från <ämne>" and would tell a guardian their
-- child was absent from Lunch. Both tables are read straight from the browser
-- through PostgREST with no server DTO to filter at. A separate table makes
-- the leak impossible rather than guarded, which is the same reasoning that put
-- ramtider in their own table instead of inverted constraints.
--
-- NO isLocked AND NO isGenerated on the weekly table, deliberately. A preserved
-- lunch row would be forwarded back to the engine as a fixedLesson while the
-- solver still builds its own lunch_start for that group — two mandatory
-- reservations in one window, and an INFEASIBLE whose cause is invisible. The
-- sittings are wholly engine-owned: every run replaces them, and a run that
-- fails leaves the previous ones alone.
--
-- YEAR-SCOPED, unlike LunchServings. The RULE belongs to the school; this is
-- what the solver decided against one läsår's lessons, and it is meaningless
-- against another's.

CREATE TABLE "LunchSittings" (
    "id"             UUID           NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"       UUID           NOT NULL,
    "academicYearId" UUID           NOT NULL,
    "studentGroupId" UUID           NOT NULL,
    -- ISO weekday 1-7. Never null: this is a placement, not a rule.
    "dayOfWeek"      INTEGER        NOT NULL,
    "startTime"      TIME(0)        NOT NULL,
    "endTime"        TIME(0)        NOT NULL,
    -- How many children this sitting seats, as the engine was told. Kept so the
    -- kitchen's own list can be printed without re-deriving a roster that may
    -- have changed since the run.
    "headcount"      INTEGER        NOT NULL DEFAULT 0,
    "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"      TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "LunchSittings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LunchSittings_window_is_ordered" CHECK ("endTime" > "startTime"),
    CONSTRAINT "LunchSittings_day_is_iso" CHECK ("dayOfWeek" BETWEEN 1 AND 7),
    CONSTRAINT "LunchSittings_headcount_is_not_negative" CHECK ("headcount" >= 0),

    -- One sitting per group per weekday. The solver produces exactly that, and
    -- a second row would be read as two meals rather than as a correction.
    CONSTRAINT "LunchSittings_group_day_key" UNIQUE ("academicYearId", "studentGroupId", "dayOfWeek")
);

ALTER TABLE "LunchSittings"
    ADD CONSTRAINT "LunchSittings_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Composite, for the reason every reference in this schema is: a foreign-key
-- check runs as the referenced table's owner with row security OFF, so an id
-- the caller cannot even SELECT would still validate.
ALTER TABLE "LunchSittings"
    ADD CONSTRAINT "LunchSittings_academicYearId_schoolId_fkey"
    FOREIGN KEY ("academicYearId", "schoolId") REFERENCES "AcademicYears"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LunchSittings"
    ADD CONSTRAINT "LunchSittings_studentGroupId_schoolId_fkey"
    FOREIGN KEY ("studentGroupId", "schoolId") REFERENCES "StudentGroups"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "LunchSittings_schoolId_academicYearId_idx"
    ON "LunchSittings"("schoolId", "academicYearId");

-- The dated half. Publish writes it from the weekly rows using the very same
-- date iteration the lessons take, so lov, studiedagar and dated closures are
-- honoured without a second implementation of "which days does this school
-- teach".
CREATE TABLE "CalendarLunches" (
    "id"             UUID           NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"       UUID           NOT NULL,
    "studentGroupId" UUID           NOT NULL,
    "date"           DATE           NOT NULL,
    "startsAt"       TIMESTAMPTZ(6) NOT NULL,
    "endsAt"         TIMESTAMPTZ(6) NOT NULL,
    "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"      TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "CalendarLunches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CalendarLunches_window_is_ordered" CHECK ("endsAt" > "startsAt"),
    CONSTRAINT "CalendarLunches_group_date_key" UNIQUE ("studentGroupId", "date")
);

ALTER TABLE "CalendarLunches"
    ADD CONSTRAINT "CalendarLunches_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CalendarLunches"
    ADD CONSTRAINT "CalendarLunches_studentGroupId_schoolId_fkey"
    FOREIGN KEY ("studentGroupId", "schoolId") REFERENCES "StudentGroups"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "CalendarLunches_schoolId_date_idx" ON "CalendarLunches"("schoolId", "date");
CREATE INDEX "CalendarLunches_studentGroupId_date_idx"
    ON "CalendarLunches"("studentGroupId", "date");

ALTER TABLE "LunchSittings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CalendarLunches" ENABLE ROW LEVEL SECURITY;

-- Read by everyone in the school. A pupil looking up when they eat is asking an
-- ordinary question, and a guardian reading a day with an unexplained hole in
-- the middle of it is the reason this feature exists at all.
CREATE POLICY "lunch_sittings_member_select" ON "LunchSittings"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()));

CREATE POLICY "calendar_lunches_member_select" ON "CalendarLunches"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()));

-- Written by the administrator alone — and in practice only by the solver and
-- publish, which run as the administrator. There is no hand-editing route.
CREATE POLICY "lunch_sittings_admin_all" ON "LunchSittings"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

CREATE POLICY "calendar_lunches_admin_all" ON "CalendarLunches"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "LunchSittings" TO "app_authenticated";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "CalendarLunches" TO "app_authenticated";
  END IF;
END
$$;
