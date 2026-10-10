-- Skolan kan visa eleven undervisningstiden.
--
-- Timplan P4 gives a pupil (on /student) and each guardian (on /guardian, per
-- child) a read-only "Undervisningstid" card: per subject, the hours of the
-- stadium the pupil is in so far, what is planned for it, and the national
-- figure. The figures are the stage module's (src/common/timplan-stage.ts),
-- and they are made of rows a family cannot read.
--
-- ## Why a statement the school publishes, not a live read
--
-- The pupil and guardian arms of the tables the figures come from
-- (CalendarLessons, CalendarLessonTeachers, StudentGroups,
-- TeachingRequirements, MasterLessons, TimplanCredits) key on the CURRENT
-- class (app.current_user_group_id()), and a guardian has no home-class arm on
-- the calendar at all. Computing the card live under the family's own RLS
-- would mean widening about ten hot policies with class history — a large
-- privacy surface in the tables P3 just tuned — or an elevated read in the
-- API, which does not exist and must not. A statement the school publishes is
-- the narrowest surface that answers the question: one table holding the
-- pupil's own hours per national cell, readable by that pupil and their
-- guardians and nobody else. It is also the more responsible product: the
-- figures carry unrecorded years and backfilled classes, and the school looks
-- at them before families do, as it decides a timplan before families see it
-- (LocalTimplans' family arm shows DECIDED only). Families read "Uppdaterad
-- {date}". TimplanCredits keeps no family arm: credits are folded in.
--
-- ## Two tables
--
-- TimplanStatementPublications: at most ONE per school (unique schoolId) — the
-- statement currently shown. academicYearId is the active year it was
-- computed for; the card renders only while that year is the active one,
-- which families can read through the AcademicYears member arm, so last
-- year's figures never show all autumn after an activation (and the
-- activation writes no statement). publishedByUserId is nullable with ON
-- DELETE SET NULL ("publishedByUserId"), the column list: a publication is a
-- replaceable snapshot, not a decision of record (LocalTimplans.decidedBy is
-- RESTRICT because a decision's author is part of it); RESTRICT here would
-- turn the publishing admin's GDPR removal into a 500. A school's admin
-- republishes; the POST replaces the publication and its rows in one
-- transaction under the publication's row lock, and two concurrent POSTs meet
-- the unique key — 409 TIMPLAN_STAGE_PUBLISH_IN_PROGRESS for the second.
--
-- TimplanStatements: one row per (pupil, stadium, national cell) of the
-- stadium the pupil is IN — data minimisation: the card shows "this stage so
-- far", and completed stages would widen the surface and roughly triple the
-- rows. No teacher id, no group id, no other pupil's figure. versionCode
-- references NationalTimplanVersions(code) and subjectCode NationalSubjects
-- (code), both RESTRICT (reference data is never deleted). recordedFrom is the
-- first recorded day of the stage, so a card says "263 timmar sedan 1 oktober
-- 2026" whenever the stage is partly unrecorded, and never "hittills" for the
-- whole stage. plannedGrades are the stage's grades ahead that a plan
-- carries, unrecordedGrades those with no class history (or no plan ahead).
--
-- CHECKs mirror what the module produces: hours 0..20000 to the tenth
-- (numeric(6,1)), grades 0..10 and ordered, the five statuses by name.
--
-- ## Row-level security
--
--   * *_admin_all: the school's SCHOOL_ADMIN, USING and WITH CHECK: the admin
--     publishes, and a PostgREST write is the same author; the CHECKs bound
--     every figure.
--   * timplan_statements_student_select: a STUDENT, their own rows.
--   * timplan_statements_guardian_select: a GUARDIAN, their children's rows
--     (20261010120000's subquery, with the role check).
--   * timplan_statement_publications_family_select: a STUDENT or GUARDIAN of
--     the school reads the publication row — its date and year, nothing about
--     any pupil.
--
-- No teacher arm: no teacher reader exists, and P2/P3 strip every pupil figure
-- for a teacher. No service arm. GRANT to app_authenticated guarded; anon
-- holds nothing; service_role (BYPASSRLS) and authenticated hold no TRUNCATE,
-- REFERENCES or TRIGGER, and service_role no write: a statement the service
-- key could rewrite would be shown to families as the school's.

CREATE TABLE "TimplanStatementPublications" (
    "id"                UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"          UUID NOT NULL,
    "academicYearId"    UUID NOT NULL,
    "publishedAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "publishedByUserId" UUID,
    "asOfDate"          DATE NOT NULL,
    "pupils"            INTEGER NOT NULL,
    "createdAt"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "TimplanStatementPublications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TimplanStatementPublications_pupils_is_sane" CHECK ("pupils" BETWEEN 0 AND 100000)
);

CREATE UNIQUE INDEX "TimplanStatementPublications_schoolId_key" ON "TimplanStatementPublications"("schoolId");
CREATE UNIQUE INDEX "TimplanStatementPublications_id_schoolId_key" ON "TimplanStatementPublications"("id", "schoolId");
CREATE INDEX "TimplanStatementPublications_academicYearId_schoolId_idx" ON "TimplanStatementPublications"("academicYearId", "schoolId");
CREATE INDEX "TimplanStatementPublications_publishedByUserId_schoolId_idx" ON "TimplanStatementPublications"("publishedByUserId", "schoolId");

ALTER TABLE "TimplanStatementPublications"
    ADD CONSTRAINT "TimplanStatementPublications_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TimplanStatementPublications"
    ADD CONSTRAINT "TimplanStatementPublications_academicYearId_schoolId_fkey"
    FOREIGN KEY ("academicYearId", "schoolId") REFERENCES "AcademicYears"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TimplanStatementPublications"
    ADD CONSTRAINT "TimplanStatementPublications_publishedByUserId_schoolId_fkey"
    FOREIGN KEY ("publishedByUserId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE SET NULL ("publishedByUserId") ON UPDATE NO ACTION;

CREATE TABLE "TimplanStatements" (
    "id"                    UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"              UUID NOT NULL,
    "publicationId"         UUID NOT NULL,
    "studentId"             UUID NOT NULL,
    "stage"                 "TimplanStage" NOT NULL,
    "subjectCode"           TEXT NOT NULL,
    "versionCode"           TEXT,
    "distributionPublished" BOOLEAN NOT NULL,
    "gradesFrom"            INTEGER NOT NULL,
    "gradesTo"              INTEGER NOT NULL,
    "nationalHours"         NUMERIC(6,1),
    "plannedHours"          NUMERIC(6,1) NOT NULL,
    "outcomeHours"          NUMERIC(6,1) NOT NULL,
    "projectedHours"        NUMERIC(6,1) NOT NULL,
    "status"                TEXT NOT NULL,
    "projectedStatus"       TEXT NOT NULL,
    "complete"              BOOLEAN NOT NULL,
    "recordedFrom"          DATE,
    "plannedGrades"         INTEGER[] NOT NULL DEFAULT '{}',
    "unrecordedGrades"      INTEGER[] NOT NULL DEFAULT '{}',
    "backfilled"            BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "TimplanStatements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TimplanStatements_grades_are_sane" CHECK (
        "gradesFrom" BETWEEN 0 AND 10 AND "gradesTo" BETWEEN 0 AND 10 AND "gradesFrom" <= "gradesTo"
    ),
    CONSTRAINT "TimplanStatements_hours_are_sane" CHECK (
        ("nationalHours" IS NULL OR "nationalHours" BETWEEN 0 AND 20000)
        AND "plannedHours" BETWEEN 0 AND 20000
        AND "outcomeHours" BETWEEN 0 AND 20000
        AND "projectedHours" BETWEEN 0 AND 20000
    ),
    CONSTRAINT "TimplanStatements_status_is_known" CHECK (
        "status" IN ('MET', 'BELOW', 'BELOW_WITHIN_CAP', 'UNRECORDED', 'NO_NATIONAL')
        AND "projectedStatus" IN ('MET', 'BELOW', 'BELOW_WITHIN_CAP', 'UNRECORDED', 'NO_NATIONAL')
    ),
    CONSTRAINT "TimplanStatements_grade_lists_are_sane" CHECK (
        "plannedGrades" <@ ARRAY[0,1,2,3,4,5,6,7,8,9,10] AND "unrecordedGrades" <@ ARRAY[0,1,2,3,4,5,6,7,8,9,10]
    )
);

CREATE UNIQUE INDEX "TimplanStatements_publicationId_studentId_stage_subjectCode_key"
    ON "TimplanStatements"("publicationId", "studentId", "stage", "subjectCode");
CREATE INDEX "TimplanStatements_studentId_idx" ON "TimplanStatements"("studentId");
CREATE INDEX "TimplanStatements_schoolId_idx" ON "TimplanStatements"("schoolId");

ALTER TABLE "TimplanStatements"
    ADD CONSTRAINT "TimplanStatements_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TimplanStatements"
    ADD CONSTRAINT "TimplanStatements_publicationId_schoolId_fkey"
    FOREIGN KEY ("publicationId", "schoolId") REFERENCES "TimplanStatementPublications"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TimplanStatements"
    ADD CONSTRAINT "TimplanStatements_studentId_schoolId_fkey"
    FOREIGN KEY ("studentId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TimplanStatements"
    ADD CONSTRAINT "TimplanStatements_subjectCode_fkey"
    FOREIGN KEY ("subjectCode") REFERENCES "NationalSubjects"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TimplanStatements"
    ADD CONSTRAINT "TimplanStatements_versionCode_fkey"
    FOREIGN KEY ("versionCode") REFERENCES "NationalTimplanVersions"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "TimplanStatementPublications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TimplanStatements" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "timplan_statement_publications_admin_all" ON "TimplanStatementPublications"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

CREATE POLICY "timplan_statement_publications_family_select" ON "TimplanStatementPublications"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) IN ('STUDENT', 'GUARDIAN')
    );

CREATE POLICY "timplan_statements_admin_all" ON "TimplanStatements"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

CREATE POLICY "timplan_statements_student_select" ON "TimplanStatements"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) = 'STUDENT'
        AND "studentId" = (select app.current_user_id())
    );

CREATE POLICY "timplan_statements_guardian_select" ON "TimplanStatements"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) = 'GUARDIAN'
        AND "studentId" IN (
            SELECT gs."studentId" FROM "GuardianStudents" gs
            WHERE gs."guardianId" = (select app.current_user_id())
              AND gs."schoolId" = (select app.current_school_id())
        )
    );

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['TimplanStatementPublications', 'TimplanStatements'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO "app_authenticated"', tbl);
      EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON %I FROM "app_authenticated"', tbl);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON %I FROM "authenticated"', tbl);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON %I FROM "anon"', tbl);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM "service_role"', tbl);
    END IF;
  END LOOP;
END
$$;
