-- Ett läsår följer en timplan per årskurs.
--
-- 20261006120000 made the lokal timplan a decision of its own, per school and
-- not per läsår, and left one question open on purpose: which plan does THIS
-- year's årskurs 7 follow? The statute's versioning is cohort-scoped, not
-- calendar-scoped. SFS 2023:945 applies to utbildning som påbörjas HT 2024,
-- so in 2024/25 årskurs 1-6 follow the new bilaga while 7-9 finish under the
-- older one; in 2028/29 the 7 424-hour plan arrives the same way, grade by
-- grade. A school running both side by side needs to say so per year and per
-- grade, and nothing could.
--
-- One small table answers it: AcademicYearTimplans, one row per (läsår,
-- årskurs) naming the LocalTimplan that grade follows that year. It is what
-- P2's coverage reads to find a class's target (the plan attached to the
-- class's year and gradeLevel, then that plan's entry for the subject), what
-- "Skapa timplansposter" generates from, and what the year dialog edits.
-- Nothing here is sent to the solver.
--
-- ## Behaviour-neutral: no backfill
--
-- The migration creates the table and writes no row. An existing year has no
-- attachment until an admin gives it one in the year dialog ("Timplan per
-- årskurs"), and the coverage page says so per grade (TIMPLAN_YEAR_GRADE_
-- UNATTACHED) instead of guessing. A backfill would have to pick a plan for
-- years that were planned without one — the newest decided plan is a guess
-- that is wrong in exactly the cohort-split years this table exists for, and a
-- wrong attachment reads as a fact. Years created AFTER this release get the
-- default in the gateway (every grade the school's newest DECIDED plan's
-- version maps to a stadium, plus grade 0 if that plan has grade-0 entries;
-- no decided plan, nothing), which is a service rule and not a column default:
-- it depends on another table's rows and on the version's grade -> stage map.
--
-- ## A plain per-year table, for the rollover that will carry it
--
-- A parallel branch builds läsårsrullning. It will copy this table into the
-- next year as it copies the year's other per-year rows: INSERT ... SELECT
-- with the new academicYearId, the same gradeLevel and localTimplanId. So the
-- table is deliberately plain — no trigger, no derived column, no id of its
-- own that a copy would have to mint. The pair (academicYearId, gradeLevel)
-- IS the row's identity (PRIMARY KEY): one plan per grade per year, and a
-- grade carried into the next year is the same grade, not a promoted cohort.
-- Whether the rollover moves a cohort's plan up a grade (åk 6 on the old plan
-- becomes åk 7 on the old plan) is the rollover's decision to make in its own
-- migration or service; this table records the result either way.
--
-- No schoolId in the key: the year id is confined to its school by the
-- composite foreign key below, so another school cannot squat a (year, grade)
-- slot, and the key is the per-year read's index — every reader asks "this
-- year's grades".
--
-- ## Columns and the CHECK mirroring the DTO
--
--   * gradeLevel 0..10, the bound LocalTimplanEntries.gradeLevel has, by the
--     same CHECK: 0 = förskoleklass, 10 = specialskolan today and the tioårig
--     grundskola in 2028. A grade no plan can hold an entry for cannot follow
--     a plan. StudentGroups.gradeLevel runs to 12; a class above 10 simply
--     has no attachment, and the coverage reports it as unattached.
--   * localTimplanId NOT NULL. "No plan for this grade" is the ABSENCE of a
--     row, not a NULL: the year dialog's empty choice deletes the row (the PUT
--     is wholesale), so there is one way to say "none" and a reader never
--     meets a row that attaches nothing.
--   * createdAt / updatedAt, as on every row an admin edits; updatedAt is
--     Prisma's @updatedAt with no default, like LocalTimplans'.
--
-- ## A DRAFT plan may be attached
--
-- Next year is planned in spring, before the huvudman has decided its
-- timplan, and the admin generating next year's timplansposter needs the
-- draft attached to do it. So the database admits any plan of the school,
-- whatever its status. What it must not do is let a draft pass for a
-- decision: every reading surface marks an attached draft "utkast — inte
-- beslutad", the coverage carries TIMPLAN_ATTACHED_DRAFT, and the family arm
-- below shows a pupil or guardian only attachments to DECIDED plans.
--
-- ## Keys
--
-- Every tenant reference is a composite (id, schoolId) key, for the reason
-- every child table here has one: referential checks run as the referenced
-- table's OWNER with row security off, so a plain id would accept another
-- school's year or plan under a row honestly stamped with this school's id.
--
--   * (academicYearId, schoolId) -> AcademicYears, ON DELETE CASCADE. The
--     attachment is a fact about the year; the year deleted, so is the fact.
--     DELETE /academic-years/:id stays a plain delete.
--   * (localTimplanId, schoolId) -> LocalTimplans, ON DELETE RESTRICT.
--     Deleting a plan a year follows would silently turn that year's grades
--     unattached and every coverage figure for them into "no target", so it is
--     refused. The gateway checks first and answers 409 TIMPLAN_IN_USE naming
--     the years (RoomTypes' pattern: the service names what still points at
--     the row); the key is the second line, for an admin's own PostgREST
--     DELETE and for the race the service's check cannot close on its own — a
--     year attached in another transaction between the check and the delete.
--     The key closes it: the attaching INSERT's referential check takes FOR
--     KEY SHARE on the plan row and the DELETE takes the row's FOR UPDATE, so
--     one waits for the other, and whichever commits second fails (the delete
--     with 23503 on this constraint, the attach with 23503 because the plan is
--     gone). rethrowPrismaError recognises this constraint's 23503 raised BY
--     A DELETE ON LocalTimplans and answers the same 409 TIMPLAN_IN_USE, never
--     a 500 and never the generic "references a record that does not exist".
--     ON UPDATE CASCADE, as RoomTypes' keys have it: ids do not change, and
--     a plan's schoolId cannot be moved under RLS anyway.
--     RESTRICT rather than NO ACTION states the intent; for a non-deferrable
--     key the two refuse alike.
--
-- A school torn down (prisma/seed.ts --reset, a tenant leaving) deletes its
-- years and its plans in one statement. The RESTRICT check a cascaded plan
-- delete provokes is queued to the end of that outer statement, by which time
-- the year cascade has removed the attachments too, so the teardown is not
-- refused — the same queueing 20261006120000 relies on for decidedByUserId,
-- and proven on a database for this key (see the commit message), not assumed.
--
-- Indexes: the primary key serves the per-year read and the year cascade;
-- ("localTimplanId", "schoolId") serves the RESTRICT check, the service's
-- "which years use this plan" query, and nothing else needs one. The school
-- cascade from Schools scans the table, which holds at most eleven rows per
-- year per school.
--
-- ## No trigger, and why none is needed
--
-- The house adds a DB guard on HOW a row is written wherever an admin's own
-- Supabase key could write it wrongly through PostgREST. Here every wrong row
-- such a writer could author is either refused or legal:
--
--   * another school's year or plan: the composite keys (23503);
--   * a grade outside 0..10: the CHECK;
--   * a draft plan: legal, and marked by every reader (above);
--   * a plan with no entries for the grade it is attached to, or of another
--     school form than the year's other grades: legal — a school running
--     grundskola and anpassad grundskola side by side attaches two forms in
--     one year, and an empty grade is reported by the coverage, not refused;
--   * a stamped createdAt: nothing here is a record whose date is cited (the
--     decision's date lives on the plan, where 20261006120000 stamps it).
--
-- A CHECK sees one row and a key sees one reference; there is no cross-table
-- rule left that only a trigger could hold.
--
-- ## Row-level security: three arms, LocalTimplans' shape
--
--   * academic_year_timplans_admin_all — the school's SCHOOL_ADMIN, FOR ALL.
--     The only writer.
--   * academic_year_timplans_staff_select — TEACHER (and admin) of the school
--     read every row, drafts included: a teacher is who next year's draft is
--     discussed with, and LocalTimplans' staff arm already shows them the
--     plan itself.
--   * academic_year_timplans_family_select — STUDENT and GUARDIAN of the
--     school read the rows whose plan is DECIDED, and never an attachment to
--     a draft. Which decided timplan a pupil's årskurs follows is the public
--     information LocalTimplans' family arm already exposes; that a draft is
--     being prepared for next year is the school's working paper. The status
--     is asked of LocalTimplans by (id, schoolId), which answers under the
--     caller's own RLS — the plan's family arm admits decided plans only, so
--     the two arms cannot disagree — and the status test is written out too,
--     so this arm does not depend on that one staying as narrow as it is.
--
-- The role check sits in USING as well as WITH CHECK, for section 7's reason:
-- WITH CHECK alone stops a writer authoring a row and leaves them able to
-- DELETE one. No service-principal arm: SS12000 exposure of timplans is P4,
-- and an arm nobody reads is an arm nobody tests.

-- ---------------------------------------------------------------------------
-- AcademicYearTimplans
-- ---------------------------------------------------------------------------

CREATE TABLE "AcademicYearTimplans" (
    "schoolId"       UUID           NOT NULL,
    "academicYearId" UUID           NOT NULL,
    "gradeLevel"     INTEGER        NOT NULL,
    "localTimplanId" UUID           NOT NULL,
    "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"      TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AcademicYearTimplans_pkey" PRIMARY KEY ("academicYearId", "gradeLevel"),

    CONSTRAINT "AcademicYearTimplans_gradeLevel_is_sane" CHECK (
        "gradeLevel" BETWEEN 0 AND 10
    )
);

-- The RESTRICT check's index, and the service's "which years use this plan".
CREATE INDEX "AcademicYearTimplans_localTimplanId_schoolId_idx"
    ON "AcademicYearTimplans"("localTimplanId", "schoolId");

ALTER TABLE "AcademicYearTimplans"
    ADD CONSTRAINT "AcademicYearTimplans_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AcademicYearTimplans"
    ADD CONSTRAINT "AcademicYearTimplans_academicYearId_schoolId_fkey"
    FOREIGN KEY ("academicYearId", "schoolId") REFERENCES "AcademicYears"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AcademicYearTimplans"
    ADD CONSTRAINT "AcademicYearTimplans_localTimplanId_schoolId_fkey"
    FOREIGN KEY ("localTimplanId", "schoolId") REFERENCES "LocalTimplans"("id", "schoolId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "AcademicYearTimplans" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "academic_year_timplans_admin_all" ON "AcademicYearTimplans"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

CREATE POLICY "academic_year_timplans_staff_select" ON "AcademicYearTimplans"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) IN ('TEACHER', 'SCHOOL_ADMIN')
    );

CREATE POLICY "academic_year_timplans_family_select" ON "AcademicYearTimplans"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) IN ('STUDENT', 'GUARDIAN')
        AND EXISTS (
            SELECT 1 FROM "LocalTimplans" p
             WHERE p."id" = "AcademicYearTimplans"."localTimplanId"
               AND p."schoolId" = "AcademicYearTimplans"."schoolId"
               AND p."status" = 'DECIDED'
        )
    );

-- Guarded, as 20260930120000 explains: `app_authenticated` exists only in the
-- local compose database, and a bare GRANT would abort the deploy everywhere
-- else. Where the role is missing, "authenticated" is already covered by
-- 20260806000000's ALTER DEFAULT PRIVILEGES.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "AcademicYearTimplans" TO "app_authenticated";
  END IF;
END
$$;
