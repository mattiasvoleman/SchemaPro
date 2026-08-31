-- Ramtider: the hours of the day a stage of the school may be taught in.
--
-- "Åk 4 does not go on until 17:00 on a Monday" was already expressible, but
-- only inside out: an AvailabilityConstraint says when somebody is NOT
-- available, so a school day of 08:00-15:00 had to be entered as the two holes
-- around it, and a day that also starts late needed a third row. Four stages
-- across five weekdays came to forty rows of inverted logic, each of which had
-- to be right, and none of which read back as the sentence the school meant.
--
-- A frame states the sentence: this span of years, this weekday, these hours.
-- Everything outside it is closed. That is not sugar over the constraint table,
-- because the solver can use a positive window as the DOMAIN of the lesson's
-- start variable instead of as a set of forbidden intervals — it shrinks the
-- search rather than adding to it, which is the opposite of what the inverted
-- form does.
--
-- THE SPAN, AND WHY IT IS NOT A JOIN TABLE. Same reason as SchoolBreaks and
-- AvailabilityConstraints: a year is a property of a group's members, not a row
-- to point at. A teaching group like 4sl1 has no year of its own and gets one
-- from the home classes of the pupils in it. The three checks below are copied
-- from those two migrations on purpose so the three shapes cannot drift, with
-- one difference: here the span is NOT NULL. A frame with no years would be a
-- school-wide day length, which is what the engine's own day window already is.
--
-- MATCHING IS OVERLAP, AND EVERY MATCH APPLIES. A group whose years overlap the
-- span must sit inside the frame. A group spanning 6-7 in a school with 4-6 and
-- 7-9 frames matches both and must satisfy both, which is the intersection —
-- the tighter window. That is the reading that keeps the year-6 pupils in that
-- group out of the late afternoon their own stage has closed. It is also why a
-- weekday frame and an every-day frame compose without a precedence rule: both
-- match, so both apply, and "08:00-15:00 always, 08:00-13:00 on Friday" needs
-- no further sentence to mean what it looks like.
--
-- dayOfWeek NULL means every teaching day, exactly as it does on a constraint.
--
-- SCHOOL-SCOPED, NOT YEAR-SCOPED, matching AvailabilityConstraints rather than
-- SchoolBreaks. A frame describes the shape of the school's day, which is the
-- same thing the availability rules describe, and the conflict and gap code
-- reads both together from one school context. The cost is that a school
-- changing its day cannot stage the change for next läsår only; the reason that
-- is acceptable is that a published timetable is already rows in MasterLessons
-- and no frame moves them — a frame decides what may be generated and what is
-- flagged from here on.
--
-- NOT enforced: that frames may not overlap. Overlapping spans are the ordinary
-- case above, and refusing them would refuse the composition the whole design
-- rests on.

CREATE TABLE "FrameTimes" (
    "id"            UUID           NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"      UUID           NOT NULL,
    "minGradeLevel" INTEGER        NOT NULL,
    "maxGradeLevel" INTEGER        NOT NULL,
    -- 1-7 (ISO), or NULL for every teaching day.
    "dayOfWeek"     INTEGER,
    "startTime"     TIME(0)        NOT NULL,
    "endTime"       TIME(0)        NOT NULL,
    "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"     TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "FrameTimes_pkey" PRIMARY KEY ("id"),

    -- A frame is a window, so it has to hold something. Equal ends would close
    -- the day entirely for that stage, which is a thing to say with a lov.
    CONSTRAINT "FrameTimes_window_is_ordered" CHECK ("endTime" > "startTime"),

    CONSTRAINT "FrameTimes_day_is_iso" CHECK (
        "dayOfWeek" IS NULL OR "dayOfWeek" BETWEEN 1 AND 7
    ),

    -- Inside the years a school has, and ordered. Both are NOT NULL here: see
    -- the note above on why a frame without years is not a frame.
    CONSTRAINT "FrameTimes_grade_span_is_ordered" CHECK (
        "minGradeLevel" BETWEEN 0 AND 12
        AND "maxGradeLevel" BETWEEN 0 AND 12
        AND "maxGradeLevel" >= "minGradeLevel"
    )
);

ALTER TABLE "FrameTimes"
    ADD CONSTRAINT "FrameTimes_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One frame per stage per day. Without it a school that saves the same row
-- twice quietly gets two identical windows, and the intersection rule makes
-- that invisible — the duplicate changes nothing until somebody edits one of
-- the two and cannot work out why the day did not move. NULLS NOT DISTINCT so
-- the every-day row is unique too; Postgres would otherwise treat every NULL
-- weekday as its own value and allow any number of them.
CREATE UNIQUE INDEX "FrameTimes_schoolId_span_dayOfWeek_key"
    ON "FrameTimes"("schoolId", "minGradeLevel", "maxGradeLevel", "dayOfWeek")
    NULLS NOT DISTINCT;

-- Every read is "the frames of this school", ordered for display.
CREATE INDEX "FrameTimes_schoolId_dayOfWeek_idx" ON "FrameTimes"("schoolId", "dayOfWeek");

ALTER TABLE "FrameTimes" ENABLE ROW LEVEL SECURITY;

-- Everyone in the school reads them, like a lov: a frame is the reason a
-- teacher's grid stops at 15:00, and one that cannot be seen reads as a bug.
CREATE POLICY "frame_times_member_select" ON "FrameTimes"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()));

CREATE POLICY "frame_times_admin_all" ON "FrameTimes"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

-- The API connects as a non-owner role, which inherits nothing automatically.
-- Guarded because `app_authenticated` is created only by the local container's
-- init script, so a bare GRANT aborts the deploy on a fresh Supabase project.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "FrameTimes" TO "app_authenticated";
  END IF;
END
$$;
