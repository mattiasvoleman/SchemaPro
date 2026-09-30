-- En lärare har en arbetstid.
--
-- The solver protects children carefully and adults not at all. A class has a
-- lunch window (LunchServings, LunchSettings) and a stage has raster
-- (20260905090000); a teacher has neither, and the ONE per-teacher row in the
-- whole schema is an AvailabilityConstraint with resourceType TEACHER — which is
-- a teacher CLOSING hours, "jag är ledig på fredagar", a subtraction from the
-- week. Nothing anywhere says a teacher is OWED anything. So a generated week
-- can hand an idrottslärare six lessons back to back from 08:00 to 14:00 with no
-- meal in them, and can end their Tuesday at 19:30 and open their Wednesday at
-- 07:40, and every check in this system reports success.
--
-- This table is the two sentences that were missing: the lunch a teacher must
-- get, and the rest they must have between one day and the next.
--
-- ## Hard, and refused by name
--
-- Not weights. A lunch the solver may trade against a tidier Tuesday is not a
-- lunch, it is a preference — and the school reading "schemat är klart" has no
-- way to find out which teacher paid for it. A week that cannot honour a row
-- here is refused, and the refusal names the row (the engine's
-- TEACHER_LUNCH_* / TEACHER_REST_* messages, under an assumption literal per
-- teacher per rule, so the refusal can say WHICH rule did not fit).
--
-- That is also why the id is anonymised REVERSIBLY on the way to the engine:
-- the teacher map is discarded on purpose, because no person's name may enter
-- the stored conflicts, but a refusal naming a rule row nobody can open is a
-- refusal nobody can act on.
--
-- ## Every column nullable, and NULL means "this rule does not apply"
--
-- There is deliberately NO DEFAULT anywhere. A default is a rule the school
-- never wrote, and it would start refusing weeks that used to solve — on the
-- deploy, silently, for every school at once. An empty table changes no week, so
-- this migration is safe to apply to a live database and then leave alone until
-- somebody fills a row in. The suggested values (30 minutes inside 10:30-13:30,
-- and 11 hours = 660 minutes) live in the UI as SUGGESTIONS for exactly this
-- reason; they are not written here.
--
-- ## Why a table, and not the two alternatives
--
-- COLUMNS ON "Users" is the tempting one, because there is exactly one row per
-- teacher either way. It is wrong twice over. `Users` is the PII table — the
-- fenced firstName/lastName/email/phone block, masked at the gateway, never sent
-- to the AI engine — and a scheduling rule the solver reads would sit behind that
-- fence, where every reader must be trusted with the name beside it; the gateway
-- would be selecting from the one table it exists to keep away from the engine.
-- And `Users` is read by every role through policies written for identity, so
-- widening them to let a teacher PATCH their own scheduling rule means widening
-- the table that holds everybody's contact details. A separate table gets its own
-- three policies and risks nothing else.
--
-- A SCHOOL-WIDE SINGLETON like LunchSettings is the other, and it cannot say the
-- thing. LunchSettings works because a dining hall is one building with one set
-- of chairs; a teacher's lunch is not school-wide in any sense — the
-- fritidspedagog eats with the children at 11:00 and the ämneslärare at 12:30,
-- and one 60% teacher needs eleven hours between days while their full-time
-- colleague has asked for nothing. A single row would force the school to pick
-- one answer and apply it to staff it is wrong for, which is how a hard rule
-- turns into a week that cannot be generated at all.
--
-- Nor per läsår, unlike TeachingRequirements: a person's meal and a person's
-- night belong to the person, not to the curriculum, and a rule keyed per year
-- would be missing every August — at exactly the moment a new timetable is being
-- generated.
--
-- ## The CHECKs
--
-- They mirror the DTO exactly, and they are not redundant with it. A school
-- admin's own Supabase key can PATCH this table straight through PostgREST
-- without meeting a DTO at all, and this row is replayed on every future run: an
-- unsatisfiable rule is not a bad request once, it is a week that is refused
-- forever until somebody edits the row. The database refuses to store one.
--
--   * the lunch trio is ALL-OR-NOTHING. Half a rule cannot be read: 30 minutes
--     with no window is a lunch the solver may place at 07:00, and a window with
--     no length is a window nothing has to happen in.
--   * the window is ORDERED and AT LEAST `lunchMinutes` WIDE. A 30-minute lunch
--     inside a 20-minute window is arithmetic, and it is better refused at the
--     keyboard than reported as INFEASIBLE in March.
--   * `lunchMinutes` 5..240 and A MULTIPLE OF 5, because the solver's grid is
--     five minutes wide. A 7-minute lunch cannot be placed on it, so it would be
--     stored, look reasonable, and fail on every run.
--   * `minDailyRestMinutes` 60..1320. The ceiling is what keeps a typo from
--     being a proof: 1440 is a teacher who can never teach two days running, and
--     the engine's only way to say so is to refuse the week.

CREATE TABLE "TeacherWorkRules" (
    "id"                  UUID           NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"            UUID           NOT NULL,
    "userId"              UUID           NOT NULL,
    "lunchMinutes"        INTEGER,
    "lunchStartTime"      TIME(0),
    "lunchEndTime"        TIME(0),
    "minDailyRestMinutes" INTEGER,
    "createdAt"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"           TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "TeacherWorkRules_pkey" PRIMARY KEY ("id"),

    -- All three, or none of them. Spelled as a count rather than as a chain of
    -- ORs so that adding a fourth lunch column cannot leave one pair unchecked.
    CONSTRAINT "TeacherWorkRules_lunch_is_whole" CHECK (
        ("lunchMinutes" IS NOT NULL)::int
        + ("lunchStartTime" IS NOT NULL)::int
        + ("lunchEndTime" IS NOT NULL)::int
        IN (0, 3)
    ),
    -- Implied by the width check below, given that the trio is whole and
    -- `lunchMinutes` is at least 5: a window that holds five minutes is
    -- ordered. Stated anyway, because it is the invariant — the width check is
    -- arithmetic about a particular break length and could be relaxed or
    -- re-derived, and "the window runs forwards" would then be gone with it. It
    -- is the one of the two whose name a refusal should read as an answer.
    CONSTRAINT "TeacherWorkRules_lunch_window_is_ordered" CHECK (
        "lunchStartTime" IS NULL
        OR "lunchEndTime" IS NULL
        OR "lunchEndTime" > "lunchStartTime"
    ),
    -- The window has to hold the break. EXTRACT(EPOCH …) over a TIME difference
    -- gives seconds, the same shape LunchSettings_window_fits_break uses.
    CONSTRAINT "TeacherWorkRules_lunch_window_fits_break" CHECK (
        "lunchMinutes" IS NULL
        OR "lunchStartTime" IS NULL
        OR "lunchEndTime" IS NULL
        OR EXTRACT(EPOCH FROM ("lunchEndTime" - "lunchStartTime")) >= "lunchMinutes" * 60
    ),
    -- Five is the solver's grid. A lunch off the grid is a rule the engine
    -- cannot place, so it is refused here rather than on every future run.
    CONSTRAINT "TeacherWorkRules_lunchMinutes_is_sane" CHECK (
        "lunchMinutes" IS NULL
        OR ("lunchMinutes" BETWEEN 5 AND 240 AND "lunchMinutes" % 5 = 0)
    ),
    CONSTRAINT "TeacherWorkRules_rest_is_sane" CHECK (
        "minDailyRestMinutes" IS NULL
        OR "minDailyRestMinutes" BETWEEN 60 AND 1320
    )
);

-- One row per teacher, and the index the userId lookups need in one: a second
-- index on "userId" would be a duplicate of this one to maintain.
CREATE UNIQUE INDEX "TeacherWorkRules_userId_key" ON "TeacherWorkRules"("userId");
CREATE INDEX "TeacherWorkRules_schoolId_idx" ON "TeacherWorkRules"("schoolId");

ALTER TABLE "TeacherWorkRules"
    ADD CONSTRAINT "TeacherWorkRules_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The composite key, as every child table here uses it: a rule may only name a
-- teacher of its own school, and the database says so for every writer — not
-- only for the ones that come through the gateway. PostgreSQL runs referential
-- integrity as the referenced table's OWNER with row security off, so a plain
-- ("userId") -> Users("id") key would happily validate a teacher this school
-- cannot even SELECT.
ALTER TABLE "TeacherWorkRules"
    ADD CONSTRAINT "TeacherWorkRules_userId_schoolId_fkey"
    FOREIGN KEY ("userId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security
--
-- Three arms, and the third is the one this table needs that LunchSettings did
-- not. Admin-all and staff-select are the shape every school-owned scheduling
-- table has (20260821160000). On top of them a teacher may read and write their
-- OWN row and nobody else's — the pattern availability_teacher_modify uses, as
-- tightened in 20260821150000, and tightened here in the same way: the predicate
-- names the caller's own id in USING as well as in WITH CHECK.
--
-- USING matters as much as WITH CHECK, and for the reason section 7 of
-- scripts/test/rls-policies.sql found: WITH CHECK alone stops a teacher writing
-- somebody else's row and leaves them able to DELETE it. A colleague's lunch
-- quietly disappearing is the same escalation as writing over it.
--
-- The staff read is deliberately restricted to staff, unlike the two table
-- migrations before 20260821160000 whose _staff_select policies forgot the role
-- check and let every pupil and guardian read them through PostgREST. A pupil
-- has no surface that needs a teacher's lunch rule, and a teacher's timetable
-- view does: the grid shows a colleague's day, and a refusal naming a rule is
-- unreadable to somebody who cannot open it.
-- ---------------------------------------------------------------------------

ALTER TABLE "TeacherWorkRules" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "teacher_work_rules_admin_all" ON "TeacherWorkRules"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

CREATE POLICY "teacher_work_rules_staff_select" ON "TeacherWorkRules"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) IN ('TEACHER', 'SCHOOL_ADMIN')
    );

-- A teacher's own row, and only their own. `app.current_user_id()` is NULL for
-- anybody without an active Users row (20260822100000), and `"userId" = NULL` is
-- NULL rather than true, so a deactivated teacher's session matches nothing
-- here — the same property the availability policy relies on.
CREATE POLICY "teacher_work_rules_teacher_own" ON "TeacherWorkRules"
    FOR ALL TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) = 'TEACHER'
        AND "userId" = (select app.current_user_id())
    )
    WITH CHECK (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) = 'TEACHER'
        AND "userId" = (select app.current_user_id())
    );

-- The API connects as a non-owner role, which inherits nothing automatically.
--
-- Guarded: `app_authenticated` is created only by scripts/db-init/01-roles.sql,
-- a docker-entrypoint-initdb.d script that runs when the local container is
-- first created and never runs anywhere else — so a bare GRANT aborts the whole
-- deploy with `role "app_authenticated" does not exist` on a fresh Supabase
-- project, a plain Postgres, or a colleague's hand-built database. Same DO-block
-- shape as 20260806000000_grant_privileges_on_all_tables. Where the role does
-- not exist there is nothing to grant to, and "authenticated" is already covered
-- by that migration's ALTER DEFAULT PRIVILEGES.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "TeacherWorkRules" TO "app_authenticated";
  END IF;
END
$$;
