-- A rast is a row of its own.
--
-- The word "rast" appeared in this repository exactly five times before this
-- migration, every one of them a prose comment. No model, no column, no enum,
-- no DTO, no route, no control, no translation key, no seed row. A Swedish
-- school day is built out of them and the product could not hold one.
--
-- WHY NOT A LESSON. The same reason a meal is not one, argued in full in
-- 20260901120000_a_meal_is_a_row_of_its_own and true again here:
-- src/integration/ss12000.service.ts stamps activityType 'Undervisning' on
-- every row it sends the kommun, and src/attendance/attendance.service.ts
-- interpolates the subject's name into the guardian's unexplained-absence mail.
-- A rast entered as a lesson is reported to the municipality as teaching and
-- tells a parent their child was marked absent from "Rast". A class with four
-- rasts a day is also 240 hand-made rows a year.
--
-- WHY NOT A RAMTID. A FrameTime is ONE contiguous window and several of them
-- INTERSECT, so no combination can produce a day with a hole in the middle.
-- "No teaching 09:40-10:00" is not merely awkward there; it is unrepresentable.
--
-- WHY NOT AN AVAILABILITY CONSTRAINT. It is the one route that corrupts no
-- outward contract, and the school gets no rast — only its absence. An
-- UNAVAILABLE row is drawn on no timetable, reaches no pupil, no guardian and
-- no teacher, and its reason text is stripped before the solver sees it. The
-- engine also ignores GRADE_LEVEL rows when it places the meal, on purpose and
-- in writing, so the lunch can be served in exactly the half hour that was
-- reserved.
--
-- THE UNION IS THE OPPOSITE OF A SITTING'S, AND THAT IS WHY THIS IS NOT THAT
-- TABLE. A LunchServing that matches a stage GRANTS PERMISSION — eat here, or
-- there. A Rast that matches a stage IMPOSES AN OBLIGATION — be free here, and
-- here. Identical resolution, opposite consequence. Sharing a table would
-- invite sharing a rule, and the rule that shadows a serving is wrong for a
-- rast: see the weekday note below.
--
-- NO UNIQUE KEY. A förmiddagsrast and an eftermiddagsrast are two rows and both
-- apply. A key on (school, span, weekday) would make the ordinary Swedish day
-- impossible to write down.
--
-- WEEKDAY SHADOWING IS NARROWER THAN A SERVING'S, AND THE DIFFERENCE MATTERS.
-- servings.py replaces EVERY every-day row for a day that has a day-specific
-- one, which is safe where one row per stage is the norm. Here it is not: a
-- school with three every-day rasts for åk 4-6 that adds "fredag 09:20-09:40"
-- would silently lose the other two on Fridays, and the engine would teach
-- straight through them. A day-specific rast therefore shadows only the
-- every-day rows whose clock window it OVERLAPS. The rule is enforced in
-- web/lib/rasts.ts and optimization-engine/app/solver/rasts.py, and both are
-- mutation-tested against exactly that case.

CREATE TABLE "Rasts" (
    "id"            UUID           NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"      UUID           NOT NULL,
    -- What the school calls it. Printed on the pupil's band and in the
    -- teacher's week, because "rast" alone does not distinguish the ten minutes
    -- between two lessons from the half hour on the yard.
    "name"          TEXT           NOT NULL,
    "minGradeLevel" INTEGER        NOT NULL,
    "maxGradeLevel" INTEGER        NOT NULL,
    -- 1-7 (ISO), or NULL for every teaching day.
    "dayOfWeek"     INTEGER,
    "startTime"     TIME(0)        NOT NULL,
    "endTime"       TIME(0)        NOT NULL,
    "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"     TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Rasts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Rasts_window_is_ordered" CHECK ("endTime" > "startTime"),
    CONSTRAINT "Rasts_day_is_iso" CHECK (
        "dayOfWeek" IS NULL OR ("dayOfWeek" BETWEEN 1 AND 7)
    ),
    CONSTRAINT "Rasts_grade_span_is_ordered" CHECK (
        "minGradeLevel" BETWEEN 0 AND 12
        AND "maxGradeLevel" BETWEEN 0 AND 12
        AND "minGradeLevel" <= "maxGradeLevel"
    ),
    -- No minimum length. A three-minute rast rounds OUTWARD to one whole slot
    -- in the engine rather than to nothing, so the shortest window a school can
    -- write is still honoured; a CHECK here would refuse it instead.
    CONSTRAINT "Rasts_name_is_not_blank" CHECK (btrim("name") <> '')
);

ALTER TABLE "Rasts"
    ADD CONSTRAINT "Rasts_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Rasts_schoolId_dayOfWeek_idx" ON "Rasts"("schoolId", "dayOfWeek");

ALTER TABLE "Rasts" ENABLE ROW LEVEL SECURITY;

-- Everyone in the school reads them. When åk 4-6 has rast is not confidential,
-- and a pupil, a guardian and a teacher all need the same answer — unlike the
-- meal, which is served to one class at one table and is scoped to it.
CREATE POLICY "rasts_member_select" ON "Rasts"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()));

CREATE POLICY "rasts_admin_all" ON "Rasts"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

-- The API connects as a non-owner role, which inherits nothing automatically.
-- Guarded because `app_authenticated` is created only by the local container's
-- init script, so a bare GRANT aborts the deploy on a fresh Supabase project.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "Rasts" TO "app_authenticated";
  END IF;
END
$$;
