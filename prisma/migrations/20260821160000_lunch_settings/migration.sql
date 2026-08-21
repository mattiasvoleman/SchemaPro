-- Lunch, and how many pupils fit in the dining hall at once.
--
-- "Innan publicering måste preferenser för lunch bl.a. antal platser i matsal
-- definieras." Today they cannot be: the lunch window lives in one browser's
-- localStorage under "schemapro.scheduleRules", so a second administrator
-- generates the timetable under different rules without knowing it, and the
-- school's answer to "when is lunch" is whatever the last person to press
-- Generate happened to have on their laptop. There is nothing to warn about
-- before publishing because there is nothing to look at.
--
-- ## One row per school, not per academic year
--
-- Every other scheduling table here hangs off `academicYearId`. This one does
-- not, and that is the deliberate part: the dining hall belongs to the
-- building and the kitchen, not to the curriculum. Its seats do not reset in
-- August. Keyed per year the setting would be missing every new school year,
-- at exactly the moment the publish check is supposed to say "lunch is not
-- defined" — the warning would fire annually and mean nothing.
--
-- `maxLessonsPerDayPerGroup` is not a lunch rule and is here anyway, because
-- it is the other half of the same form. Persisting one half on the server and
-- leaving the other in one administrator's browser keeps the original bug
-- alive for whichever half stayed behind.
--
-- ## The CHECKs
--
-- The seat bound mirrors the wire contract (1-5000); the minute and daily-cap
-- bounds mirror ScheduleRulesDto, which the solver already enforces. The
-- window checks are the ones that matter: this row is replayed on every future
-- run, so a lunch window shorter than the break it is supposed to contain is
-- not a bad request once, it is a run that fails forever until somebody edits
-- the row. The database refuses to store it.

CREATE TABLE "LunchSettings" (
    "id"                       UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"                 UUID NOT NULL,
    "lunchEnabled"             BOOLEAN NOT NULL DEFAULT false,
    "lunchStartTime"           TIME(0) NOT NULL,
    "lunchEndTime"             TIME(0) NOT NULL,
    "lunchMinutes"             INTEGER NOT NULL,
    "diningSeats"              INTEGER,
    "maxLessonsPerDayPerGroup" INTEGER,
    "createdAt"                TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"                TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "LunchSettings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LunchSettings_window_ordered" CHECK ("lunchStartTime" < "lunchEndTime"),
    CONSTRAINT "LunchSettings_window_fits_break" CHECK (
        EXTRACT(EPOCH FROM ("lunchEndTime" - "lunchStartTime")) >= "lunchMinutes" * 60
    ),
    CONSTRAINT "LunchSettings_lunchMinutes_sane" CHECK ("lunchMinutes" BETWEEN 15 AND 120),
    CONSTRAINT "LunchSettings_diningSeats_sane" CHECK (
        "diningSeats" IS NULL OR "diningSeats" BETWEEN 1 AND 5000
    ),
    CONSTRAINT "LunchSettings_maxLessonsPerDayPerGroup_sane" CHECK (
        "maxLessonsPerDayPerGroup" IS NULL OR "maxLessonsPerDayPerGroup" BETWEEN 1 AND 20
    )
);

-- The singleton, and the schoolId index in one: a second unique index would be
-- a duplicate of this one.
CREATE UNIQUE INDEX "LunchSettings_schoolId_key" ON "LunchSettings"("schoolId");

ALTER TABLE "LunchSettings"
    ADD CONSTRAINT "LunchSettings_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security, same shape as every other school-owned table: admins
-- manage their school's settings, staff may read them. Staff read matters here
-- — a teacher's timetable view needs to know where the lunch window sits.
ALTER TABLE "LunchSettings" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lunch_settings_admin_all" ON "LunchSettings"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

-- Named _staff_select, and therefore actually restricted to staff. The two
-- table migrations before this one copied the predicate without the role check,
-- which makes their _staff_select policies readable by students and guardians;
-- 16 of the 19 policies in the schema do check, so that is the deviation, not
-- this. A pupil has no view that needs the lunch window today, and widening it
-- later is a one-line policy change — narrowing it after the fact is not.
CREATE POLICY "lunch_settings_staff_select" ON "LunchSettings"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) IN ('TEACHER', 'SCHOOL_ADMIN')
    );

-- The API connects as a non-owner role, which inherits nothing automatically.
--
-- Guarded, unlike the two table migrations before this one. `app_authenticated`
-- is created only by scripts/db-init/01-roles.sql, a docker-entrypoint-initdb.d
-- script that runs when the local container is first created and never runs
-- anywhere else — so a bare GRANT aborts the whole deploy with `role
-- "app_authenticated" does not exist` on a fresh Supabase project, a plain
-- Postgres, or a colleague's hand-built database. Same DO-block shape as
-- 20260806000000_grant_privileges_on_all_tables. Where the role does not
-- exist there is nothing to grant to, and "authenticated" is already covered
-- by that migration's ALTER DEFAULT PRIVILEGES.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "LunchSettings" TO "app_authenticated";
  END IF;
END
$$;
