-- Lunchsittningar: the window each stage of the school may eat in.
--
-- The school day already had ramtider; this is the same idea for the meal. It
-- exists because a dining hall smaller than the school needs an ORDER through
-- the middle of the day, and nothing in the model could express one.
--
-- WHY THE SCHOOL WRITES THIS RATHER THAN THE SOLVER DERIVING IT. Three
-- reasons, and none of them is taste. The seat rule is a CUMULATIVE, which is a
-- bound and not a sequence: it says no instant exceeds N chairs and is content
-- to send every class in at 11:30 when the hall is big enough. It is also built
-- only when a seat count is set, so "let the solver find a flow from seats"
-- produces nothing at all for a school that left that field blank. And the
-- facts that decide the order — rastvakt, how many serving lines the kitchen
-- runs, how far year 1 has to walk — are not in this database and cannot be
-- optimised over. A solver asked to derive would answer differently on every
-- run, because no objective term mentions lunch at all.
--
-- WHAT THE SOLVER STILL DOES DECIDE: which class eats when INSIDE the window.
-- A stage too big for the hall is split into waves by the seat cumulative, one
-- class at a time; the school states the window, the model fills it. That is
-- the division of labour the school asked for.
--
-- MATCHING IS OVERLAP, AND THE WINDOWS UNION — the opposite of FrameTimes,
-- deliberately. A frame BOUNDS a day, so several frames intersect into the
-- tightest. A serving PERMITS a meal, so several servings widen into the union:
-- a group spanning years 6-7 in a school with 4-6 and 7-9 sittings may eat at
-- either, and intersecting two disjoint windows would leave it nowhere.
--
-- EXCEPT ACROSS WEEKDAYS, WHERE A DAY-SPECIFIC ROW REPLACES THE EVERY-DAY ONE.
-- "Åk 7-9 alla dagar 12:20-13:00" plus "åk 7-9 fredag 11:40-12:20" is a school
-- saying Friday is DIFFERENT, not that Friday is wider. Unioning them would
-- give Friday 11:40-13:00, which is the one reading nobody meant.
--
-- NO UNIQUE KEY on (school, span, weekday), unlike FrameTimes. Two rows for one
-- stage on one day are a school declaring two waves by hand, which is exactly
-- what a hall smaller than its 7-9 needs — and the union rule above already
-- gives that the right meaning.
--
-- `seats` is per serving and optional. LunchSettings.diningSeats is the hall's
-- own size and stays the school-wide cap; this narrows it for one sitting (a
-- second serving line closed, a room borrowed for something else) without
-- restating the hall.

CREATE TABLE "LunchServings" (
    "id"            UUID           NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"      UUID           NOT NULL,
    "minGradeLevel" INTEGER        NOT NULL,
    "maxGradeLevel" INTEGER        NOT NULL,
    -- 1-7 (ISO), or NULL for every teaching day.
    "dayOfWeek"     INTEGER,
    "startTime"     TIME(0)        NOT NULL,
    "endTime"       TIME(0)        NOT NULL,
    -- Chairs available for THIS sitting; null means the hall's own limit.
    "seats"         INTEGER,
    "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"     TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "LunchServings_pkey" PRIMARY KEY ("id"),

    -- A sitting is a window, so it has to hold something. The break's length
    -- is not checked here: it lives on LunchSettings, one table over, and a
    -- CHECK cannot reach it. The engine refuses that pairing by name instead.
    CONSTRAINT "LunchServings_window_is_ordered" CHECK ("endTime" > "startTime"),

    CONSTRAINT "LunchServings_day_is_iso" CHECK (
        "dayOfWeek" IS NULL OR "dayOfWeek" BETWEEN 1 AND 7
    ),

    CONSTRAINT "LunchServings_grade_span_is_ordered" CHECK (
        "minGradeLevel" BETWEEN 0 AND 12
        AND "maxGradeLevel" BETWEEN 0 AND 12
        AND "maxGradeLevel" >= "minGradeLevel"
    ),

    -- A sitting nobody can attend is a typo, not a policy.
    CONSTRAINT "LunchServings_seats_are_positive" CHECK ("seats" IS NULL OR "seats" > 0)
);

ALTER TABLE "LunchServings"
    ADD CONSTRAINT "LunchServings_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "LunchServings_schoolId_dayOfWeek_idx" ON "LunchServings"("schoolId", "dayOfWeek");

ALTER TABLE "LunchServings" ENABLE ROW LEVEL SECURITY;

-- Everyone in the school reads them: a pupil who wants to know when their
-- class eats is asking an ordinary question, and the answer is not confidential.
CREATE POLICY "lunch_servings_member_select" ON "LunchServings"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()));

CREATE POLICY "lunch_servings_admin_all" ON "LunchServings"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

-- The API connects as a non-owner role, which inherits nothing automatically.
-- Guarded because `app_authenticated` is created only by the local container's
-- init script, so a bare GRANT aborts the deploy on a fresh Supabase project.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "LunchServings" TO "app_authenticated";
  END IF;
END
$$;
