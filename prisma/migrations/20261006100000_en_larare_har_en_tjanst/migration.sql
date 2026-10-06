-- En lärare har en tjänst.
--
-- Every scheduler this product is measured against allocates teaching to
-- teachers BEFORE it timetables: Skola24 has Tjänst %, Nedsättning % and
-- *Planerad tjänst on its Lärare table, Untis has Plan/week and a Teach. qual.
-- tab with a grade level, Lectio has Aftalt timetal and Faggrupper. SchemaPro
-- has a timplan matrix and a solver, and between them nothing: a teacher is a
-- `Users` row with role TEACHER, a teacher is linked to a subject only by being
-- named on a TeachingRequirement, and TeacherWorkRules (20260930120000) says
-- what a teacher is OWED in a day but not what they are EMPLOYED to do in a
-- year. So the requirements dialog cannot say "Anna saknar behörighet i Ma åk
-- 7-9", nothing can say "Anna är redan på 118 % av sitt riktmärke", and the
-- substitute picker's idea of "qualified" is "has a requirement in the subject".
--
-- Three tables, which are the three sentences: what the school's policy is,
-- what each teacher's post is this year, and what each teacher may teach.
--
-- ## StaffingPolicies: one row per school, and the riktmärke has no default
--
-- The central agreement (Bilaga M) fixes 1 767 hours a year, 1 360 of them
-- reglerad arbetstid on 194 A-dagar — and deliberately NO weekly teaching
-- measure. Vimmerby uses 1 080 min/week for a full post, the national median
-- is 1 090, P10-P90 runs 850-1 280, and every kommun negotiates its own. So
-- `fullTimeTeachingMinutesPerWeek` is NULLABLE WITH NO DEFAULT, for exactly the
-- reason TeacherWorkRules' header gives for its columns: a default is a number
-- nobody at the school chose, and a load report that says OVER against a
-- number nobody chose is a report nobody trusts. NULL means "no load
-- comparison" — every teacher reads NO_TARGET and the over-allocation check is
-- inert. The UI SUGGESTS 1 080 with its source; the database supplies nothing.
--
-- The three agreement figures DO have defaults (1360 / 1767 / 194), because
-- they are not the school's choice: they are the agreement's, the same for
-- every ferietjänst in the country, and a school that differs edits them.
--
-- Both check modes default to WARN. A deploy that turned on REFUSE would break
-- every requirements import and every PATCH naming a teacher without
-- qualification rows, for every school at once, silently. WARN is
-- behaviour-neutral: the write goes through, the response carries a warning,
-- and REFUSE is an explicit administrator decision made on the settings card
-- with the consequence spelled out.
--
-- ## TeacherEmployments: per läsår, and its own table
--
-- Per year, unlike TeacherWorkRules, because a tjänstgöringsgrad is
-- renegotiated every year and the load it bounds is the YEAR's requirements. A
-- person's lunch is theirs; their percentage is the year's.
--
-- Its own table and not columns on `Users`, for the two reasons 20260930120000
-- gives and a third: `Users` is the PII fence; its policies are written for
-- identity and read by every role; and this is HR data — a deltid and a
-- nedsättning are personnel facts about a colleague — so it needs a NARROWER
-- read arm than any scheduling table has, which only a table of its own can
-- carry. See the RLS section below.
--
-- NUMERIC(6,3) for the two percentages, not INTEGER: SCB's Pedagogisk personal
-- return and IST report a Lektor's or Förstelärare's share of a post "upp till
-- tre decimaler", and an integer column would round what the school is asked
-- to report exactly. 6 digits with 3 after the point is 0.000..999.999, and
-- the CHECK narrows it to (0, 100].
--
-- ## TeacherSubjectQualifications: school-owned, not per year
--
-- A legitimation belongs to the person, not to the curriculum. Keyed per year
-- it would be missing every August, at exactly the moment the new year's
-- requirements are being staffed. One row per (teacher, subject): "Ma 1-6" and
-- "Ma 7-9" are written as one span 1-9, which is the same inclusive-stage
-- convention Rooms, FrameTimes and Rasts use for a grade span. Skola24 has no
-- behörighet field at all and its SCB export explicitly omits legitimation;
-- this table is where SchemaPro leads rather than matches.
--
-- Cascade from the subject: a subject that is deleted takes its behörigheter
-- with it, because a qualification in a subject that no longer exists at the
-- school is a row nothing can read.
--
-- ## The CHECKs
--
-- They mirror the DTO bounds, and they are not redundant with it — the
-- argument is 20260930120000's: an admin's own Supabase key can PATCH these
-- tables through PostgREST without meeting a DTO, and a stored row is replayed
-- on every load report and every staffing check from then on.
--
--   * employmentPercent in (0, 100]: 0 % is not a post and 100 % is the whole
--     of one. reductionPercent in [0, employmentPercent]: a nedsättning larger
--     than the post is arithmetic that yields a negative tjänst.
--   * teachingTargetMinutesPerWeek 0..2400: 2400 is 40 hours of teaching with
--     nothing else in the week, the ceiling of the absurd; 0 is a teacher whose
--     post is all uppdrag, which exists.
--   * fullTimeTeachingMinutesPerWeek 1..2400 when set: the same ceiling, and a
--     riktmärke of 0 for a full post would put every teacher OVER on their first
--     lesson, which is a typo and not a policy.
--   * fullTimeAnnualHours 1..2500 (52 weeks of 48 hours is 2 496);
--     fullTimeRegulatedHoursPerYear 1..fullTimeAnnualHours, because the
--     reglerad part is a part; workDaysPerYear 1..260 (52 weeks of 5 days).
--   * semesterHoursPerWeek in (0, 60]; overAllocationTolerancePercent 0..50 —
--     a tolerance above 50 % is a check switched off, and OFF is a mode, not
--     a number.
--   * the grade span 0..12 with max >= min, as every grade span here.
--   * validTo >= validFrom when both are set; either alone is legal (a
--     legitimation with a known end and an unknown start, or the reverse).
--   * signature 1..8 characters; note at most 500. Named length CHECKs rather
--     than VARCHAR(n): a too-long VARCHAR raises string_data_right_truncation
--     with no constraint name, and a refusal with no name is one the RLS suite
--     and the probe cannot assert and a log cannot point at. Neither shape is
--     translated to a 400 by rethrowPrismaError today (6e736e1 found that a
--     CHECK violation surfaces as a 500), so the DTO carries the same bounds
--     and is what answers the ordinary caller; these answer the PostgREST one.
--
-- ## Signature: unique per school AND YEAR, not per school
--
-- The design said "unique (schoolId, signature) where not null". That is wrong
-- for a per-year table, and the migration is the place to say so rather than
-- to copy it: the same teacher's row for next year carries the SAME signature,
-- so a per-school key would refuse Fas 5's roll-forward of every employment
-- that has one. What the key must protect is that one YEAR's timetable export
-- has no two teachers writing the same three letters — so the key is
-- (schoolId, academicYearId, signature), partial on signature IS NOT NULL.
-- Prisma cannot state a partial index; schema.prisma says so beside the model
-- the way AcademicYears does for its one-active-per-school index.
--
-- ## Composite keys, as every child table here
--
-- (userId, schoolId) -> Users(id, schoolId), (academicYearId, schoolId) ->
-- AcademicYears(id, schoolId), (subjectId, schoolId) -> Subjects(id, schoolId).
-- Referential checks run as the referenced table's OWNER with row security
-- off, so a plain id key would validate a teacher this school cannot SELECT,
-- and a row stamped honestly with this school's id would then be about another
-- school's person. The key is what refuses it, for every writer.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

-- Shared by both checks on the policy: the same three answers to "what happens
-- when a staffing write breaks the rule".
CREATE TYPE "StaffingCheckMode" AS ENUM ('OFF', 'WARN', 'REFUSE');

-- MINUTES is the base model: load is lesson minutes. FACTOR is Skola24's
-- "Faktor ämne" / Untis' subject factor and is enabled here as a value only;
-- the Subject.loadFactor column it reads arrives in Fas 3. A school that
-- selects FACTOR before then gets the MINUTES arithmetic, which the report
-- header says.
CREATE TYPE "StaffingLoadModel" AS ENUM ('MINUTES', 'FACTOR');

-- Ferietjänst (Bilaga M: 1 767 h on 194 A-dagar) or semestertjänst (an
-- ordinary 40-hour week with semester). The annual arithmetic differs.
CREATE TYPE "TeacherContractKind" AS ENUM ('FERIE', 'SEMESTER');

-- Legitimerad och behörig; behörig utan legitimation; får undervisa enligt
-- rektors beslut (skollagen 2 kap. 18 §). Ordered from strongest to weakest,
-- which is the order the substitute picker ranks them in.
CREATE TYPE "TeacherQualificationKind" AS ENUM ('LEGITIMATION', 'BEHORIG', 'TILLATEN');

-- ---------------------------------------------------------------------------
-- StaffingPolicies
-- ---------------------------------------------------------------------------

CREATE TABLE "StaffingPolicies" (
    "id"                              UUID                NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"                        UUID                NOT NULL,
    -- Riktmärke undervisning för en heltid. NULL, and no default: see above.
    "fullTimeTeachingMinutesPerWeek"  INTEGER,
    "fullTimeRegulatedHoursPerYear"   INTEGER             NOT NULL DEFAULT 1360,
    "fullTimeAnnualHours"             INTEGER             NOT NULL DEFAULT 1767,
    "workDaysPerYear"                 INTEGER             NOT NULL DEFAULT 194,
    "semesterHoursPerWeek"            NUMERIC(4,1)        NOT NULL DEFAULT 40.0,
    "qualificationMode"               "StaffingCheckMode" NOT NULL DEFAULT 'WARN',
    "overAllocationMode"              "StaffingCheckMode" NOT NULL DEFAULT 'WARN',
    "overAllocationTolerancePercent"  INTEGER             NOT NULL DEFAULT 10,
    "loadModel"                       "StaffingLoadModel" NOT NULL DEFAULT 'MINUTES',
    "createdAt"                       TIMESTAMPTZ(6)      NOT NULL DEFAULT now(),
    "updatedAt"                       TIMESTAMPTZ(6)      NOT NULL,

    CONSTRAINT "StaffingPolicies_pkey" PRIMARY KEY ("id"),

    CONSTRAINT "StaffingPolicies_teachingMinutes_is_sane" CHECK (
        "fullTimeTeachingMinutesPerWeek" IS NULL
        OR "fullTimeTeachingMinutesPerWeek" BETWEEN 1 AND 2400
    ),
    CONSTRAINT "StaffingPolicies_annualHours_is_sane" CHECK (
        "fullTimeAnnualHours" BETWEEN 1 AND 2500
    ),
    -- The reglerad part is a part of the year, so it is bounded by the year
    -- rather than by a second literal that could drift from the first.
    CONSTRAINT "StaffingPolicies_regulatedHours_within_annual" CHECK (
        "fullTimeRegulatedHoursPerYear" BETWEEN 1 AND "fullTimeAnnualHours"
    ),
    CONSTRAINT "StaffingPolicies_workDays_is_sane" CHECK (
        "workDaysPerYear" BETWEEN 1 AND 260
    ),
    CONSTRAINT "StaffingPolicies_semesterHours_is_sane" CHECK (
        "semesterHoursPerWeek" > 0 AND "semesterHoursPerWeek" <= 60
    ),
    CONSTRAINT "StaffingPolicies_tolerance_is_sane" CHECK (
        "overAllocationTolerancePercent" BETWEEN 0 AND 50
    )
);

-- One row per school, and the index every lookup needs in one — the shape
-- LunchSettings uses.
CREATE UNIQUE INDEX "StaffingPolicies_schoolId_key" ON "StaffingPolicies"("schoolId");

ALTER TABLE "StaffingPolicies"
    ADD CONSTRAINT "StaffingPolicies_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- TeacherEmployments
-- ---------------------------------------------------------------------------

CREATE TABLE "TeacherEmployments" (
    "id"                            UUID                  NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"                      UUID                  NOT NULL,
    "userId"                        UUID                  NOT NULL,
    "academicYearId"                UUID                  NOT NULL,
    "employmentPercent"             NUMERIC(6,3)          NOT NULL,
    "reductionPercent"              NUMERIC(6,3)          NOT NULL DEFAULT 0,
    "contractKind"                  "TeacherContractKind" NOT NULL DEFAULT 'FERIE',
    -- Per-teacher override of policy riktmärke x (employment - reduction)/100.
    -- NULL means derive it.
    "teachingTargetMinutesPerWeek"  INTEGER,
    -- Lärarsignatur, the three-or-so letters a printed timetable and an export
    -- name a teacher by.
    "signature"                     TEXT,
    "note"                          TEXT,
    "createdAt"                     TIMESTAMPTZ(6)        NOT NULL DEFAULT now(),
    "updatedAt"                     TIMESTAMPTZ(6)        NOT NULL,

    CONSTRAINT "TeacherEmployments_pkey" PRIMARY KEY ("id"),

    CONSTRAINT "TeacherEmployments_employmentPercent_is_sane" CHECK (
        "employmentPercent" > 0 AND "employmentPercent" <= 100
    ),
    -- Bounded by the post rather than by 100: a 60 % post with a 70 %
    -- nedsättning is a negative tjänst, and a literal 100 would store it.
    CONSTRAINT "TeacherEmployments_reduction_within_employment" CHECK (
        "reductionPercent" >= 0 AND "reductionPercent" <= "employmentPercent"
    ),
    CONSTRAINT "TeacherEmployments_teachingTarget_is_sane" CHECK (
        "teachingTargetMinutesPerWeek" IS NULL
        OR "teachingTargetMinutesPerWeek" BETWEEN 0 AND 2400
    ),
    CONSTRAINT "TeacherEmployments_signature_is_sane" CHECK (
        "signature" IS NULL OR char_length("signature") BETWEEN 1 AND 8
    ),
    CONSTRAINT "TeacherEmployments_note_is_sane" CHECK (
        "note" IS NULL OR char_length("note") <= 500
    )
);

-- One post per teacher per year. schoolId leads the key so that one school
-- cannot fill another's slot (the squatting half section 10 of the RLS suite
-- asserts for TeachingRequirements), and so the key doubles as the index the
-- per-year listing reads.
CREATE UNIQUE INDEX "TeacherEmployments_schoolId_userId_academicYearId_key"
    ON "TeacherEmployments"("schoolId", "userId", "academicYearId");
CREATE INDEX "TeacherEmployments_schoolId_academicYearId_idx"
    ON "TeacherEmployments"("schoolId", "academicYearId");
-- Per school and YEAR, partial: see the header. Prisma cannot state this one.
CREATE UNIQUE INDEX "TeacherEmployments_one_signature_per_year"
    ON "TeacherEmployments"("schoolId", "academicYearId", "signature")
    WHERE "signature" IS NOT NULL;

ALTER TABLE "TeacherEmployments"
    ADD CONSTRAINT "TeacherEmployments_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TeacherEmployments"
    ADD CONSTRAINT "TeacherEmployments_userId_schoolId_fkey"
    FOREIGN KEY ("userId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TeacherEmployments"
    ADD CONSTRAINT "TeacherEmployments_academicYearId_schoolId_fkey"
    FOREIGN KEY ("academicYearId", "schoolId") REFERENCES "AcademicYears"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- TeacherSubjectQualifications
-- ---------------------------------------------------------------------------

CREATE TABLE "TeacherSubjectQualifications" (
    "id"             UUID                       NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"       UUID                       NOT NULL,
    "userId"         UUID                       NOT NULL,
    "subjectId"      UUID                       NOT NULL,
    "minGradeLevel"  INTEGER                    NOT NULL,
    "maxGradeLevel"  INTEGER                    NOT NULL,
    -- No default. Which of the three a teacher holds is a fact the
    -- administrator states, not one the database may presume.
    "kind"           "TeacherQualificationKind" NOT NULL,
    "validFrom"      DATE,
    "validTo"        DATE,
    "note"           TEXT,
    "createdAt"      TIMESTAMPTZ(6)             NOT NULL DEFAULT now(),
    "updatedAt"      TIMESTAMPTZ(6)             NOT NULL,

    CONSTRAINT "TeacherSubjectQualifications_pkey" PRIMARY KEY ("id"),

    CONSTRAINT "TeacherSubjectQualifications_grade_span_is_sane" CHECK (
        "minGradeLevel" BETWEEN 0 AND 12
        AND "maxGradeLevel" BETWEEN 0 AND 12
        AND "maxGradeLevel" >= "minGradeLevel"
    ),
    CONSTRAINT "TeacherSubjectQualifications_validity_is_ordered" CHECK (
        "validFrom" IS NULL OR "validTo" IS NULL OR "validTo" >= "validFrom"
    ),
    CONSTRAINT "TeacherSubjectQualifications_note_is_sane" CHECK (
        "note" IS NULL OR char_length("note") <= 500
    )
);

-- One span per (teacher, subject), and the per-teacher listing's index.
CREATE UNIQUE INDEX "TeacherSubjectQualifications_schoolId_userId_subjectId_key"
    ON "TeacherSubjectQualifications"("schoolId", "userId", "subjectId");
-- The substitute picker asks the other way round: who may teach THIS subject.
CREATE INDEX "TeacherSubjectQualifications_schoolId_subjectId_idx"
    ON "TeacherSubjectQualifications"("schoolId", "subjectId");

ALTER TABLE "TeacherSubjectQualifications"
    ADD CONSTRAINT "TeacherSubjectQualifications_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TeacherSubjectQualifications"
    ADD CONSTRAINT "TeacherSubjectQualifications_userId_schoolId_fkey"
    FOREIGN KEY ("userId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TeacherSubjectQualifications"
    ADD CONSTRAINT "TeacherSubjectQualifications_subjectId_schoolId_fkey"
    FOREIGN KEY ("subjectId", "schoolId") REFERENCES "Subjects"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security
--
-- Three tables, three different second arms, and the difference is the point.
--
-- The POLICY is read by all staff (admin_all + staff_select, the shape every
-- school-owned scheduling table has): a teacher's own load bar is drawn against
-- the school's riktmärke, and a refusal that names a mode is unreadable to
-- somebody who cannot open the setting.
--
-- An EMPLOYMENT is HR data. A teacher reads ONLY their own row, and reads it
-- only — teacher_own_select is FOR SELECT, because a tjänstgöringsgrad is
-- something the employer sets and the employee is told; there is no write arm
-- for a teacher at all. Colleagues' rows are not readable: this is NOT a copy of
-- TeacherWorkRules' staff_select, where a colleague's lunch is deliberately
-- visible because the grid shows their day. A colleague's deltid and
-- nedsättning are personnel facts the grid has no business showing. The role
-- test and the id test sit in USING; there is no WITH CHECK because the policy
-- grants no write.
--
-- A QUALIFICATION is not secret: the substitute picker lists colleagues by
-- behörighet, and a refusal "Anna saknar behörighet i Ma åk 7-9" is read by the
-- admin, who holds admin_all anyway. So qualifications get staff_select — and
-- no teacher write arm: a legitimation is a fact the administrator records
-- against a document, not a claim its holder types in.
--
-- The SERVICE PRINCIPAL reads employments only, by its school: the SS12000
-- /duties feed (Fas 3) is one duty per employment, and the arm is the same
-- one-liner every table it reads carries (20260914150000). It gets no arm on
-- qualifications or the policy, neither of which SS12000 has a field for.
--
-- Every role check sits in USING as well as WITH CHECK, for the reason section
-- 7 of scripts/test/rls-policies.sql found: WITH CHECK alone stops a writer
-- authoring a row and leaves them able to DELETE one.
--
-- Pupils and guardians have no arm on any of the three. The staff reads carry
-- their role check, as every _staff_select since 20260821160000 must.
-- ---------------------------------------------------------------------------

ALTER TABLE "StaffingPolicies" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "staffing_policies_admin_all" ON "StaffingPolicies"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

CREATE POLICY "staffing_policies_staff_select" ON "StaffingPolicies"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) IN ('TEACHER', 'SCHOOL_ADMIN')
    );

ALTER TABLE "TeacherEmployments" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "teacher_employments_admin_all" ON "TeacherEmployments"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

-- Their own row, read only. `app.current_user_id()` is NULL for anybody without
-- an active Users row (20260822100000), and `"userId" = NULL` is NULL rather
-- than true, so a deactivated teacher's session matches nothing here.
CREATE POLICY "teacher_employments_teacher_own_select" ON "TeacherEmployments"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) = 'TEACHER'
        AND "userId" = (select app.current_user_id())
    );

CREATE POLICY "teacher_employments_service_select" ON "TeacherEmployments"
    FOR SELECT
    USING ("schoolId" = app.current_service_school_id());

ALTER TABLE "TeacherSubjectQualifications" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "teacher_subject_qualifications_admin_all" ON "TeacherSubjectQualifications"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

CREATE POLICY "teacher_subject_qualifications_staff_select" ON "TeacherSubjectQualifications"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) IN ('TEACHER', 'SCHOOL_ADMIN')
    );

-- The API connects as a non-owner role, which inherits nothing automatically.
-- Guarded, as 20260930120000 explains: `app_authenticated` exists only in the
-- local compose database, and a bare GRANT would abort the deploy everywhere
-- else. Where the role is missing, "authenticated" is already covered by
-- 20260806000000's ALTER DEFAULT PRIVILEGES.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "StaffingPolicies"             TO "app_authenticated";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "TeacherEmployments"           TO "app_authenticated";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "TeacherSubjectQualifications" TO "app_authenticated";
  END IF;
END
$$;
