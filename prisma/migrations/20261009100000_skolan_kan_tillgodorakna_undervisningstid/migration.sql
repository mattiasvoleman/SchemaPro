-- Skolan kan tillgodoräkna undervisningstid.
--
-- A friluftsdag is a day with no lessons on it. Does it count toward the
-- timplan? Skolinspektionen's finding is that most schools have never decided
-- — and the decision is the school's to make, in writing, per activity: "the
-- friluftsdag 25 September counts as 300 minutes idrott och hälsa for åk 7–9".
-- The timplan's third layer (P3, "genomfört mot schemalagt") counts the time a
-- pupil was actually given from the calendar, and without a place to write
-- that decision it could only say "a lov", never "300 minutes of idrott".
--
-- One table, TimplanCredits: one row per decision about one date. A row IS the
-- school's written decision; the absence of a row is the decision that the
-- day does not count (or no decision yet, which reads the same: nothing is
-- credited on a guess).
--
-- ## Columns and the CHECKs mirroring the DTO
--
--   * academicYearId NOT NULL, date NOT NULL. A credit is about one day of
--     one läsår. It is NOT checked against the year's bounds here: the bounds
--     can move later (a year's dates are editable), so a trigger could not hold
--     the rule anyway. The service refuses a date outside the year with 400
--     TIMPLAN_CREDIT_OUTSIDE_YEAR, and the coverage reports a stored one with
--     the notice of the same name rather than counting it.
--   * minutes 1..600. A real day is never refused (a full lägerskola day is 6–7
--     hours of undervisning; 600 is ten), and 3000-for-300 is caught. A split
--     day (180 idrott + 120 biologi) is two rows, so there is no uniqueness on
--     purpose; a lägerskola is one row per day.
--   * subjectId NULL — "undervisningstid without a subject", NOT "not
--     undervisning". "Does not count" is already said by having no row, so a
--     row meaning it would say nothing new; a cross-subject temadag can count
--     toward the pupil's total without being forced into one subject. The
--     coverage shows it as a line of its own ("Utan ämne") and never spreads it
--     across subjects. A subject that does not count toward the timplan
--     (countsTowardTimplan false) is legal and counts nowhere; the coverage
--     says so.
--   * The scope is a group, a grade span, or (all three null) the whole school:
--     studentGroupId, or minGradeLevel + maxGradeLevel with SchoolBreaks' two
--     CHECKs (both or neither; 0..12, ordered), never both
--     (TimplanCredits_scope_is_one). A span is judged by the pupil's HOME
--     class's årskurs, the convention publish and the lov already use.
--   * name non-blank and at most 80 characters, note NULL or non-blank and at
--     most 500. "Non-blank" is 20261006120000's argued regex — the class of
--     exactly the characters JavaScript's \s matches — and not SchoolBreaks'
--     older btrim(), which lets a name of one tab or one NBSP through. Lengths
--     are char_length, code points, as the DTO counts them.
--
-- ## Keys
--
-- Every tenant reference is a composite (id, schoolId) key, for the house's
-- reason: referential checks run as the referenced table's owner with row
-- security off, so a plain id would accept another school's row under a row
-- honestly stamped with this school.
--
--   * (academicYearId, schoolId) -> AcademicYears, ON DELETE CASCADE: a
--     decision about a day of a year goes with the year.
--   * (subjectId, schoolId) -> Subjects, ON DELETE CASCADE, MATCH SIMPLE so a
--     null subject is no reference. Not SET NULL: that would silently turn
--     "300 min idrott" into "300 min utan ämne", a decision nobody made. Not
--     RESTRICT: a subject's timplansposter and lessons already cascade with
--     it, and a credit should not be the one row that blocks the delete.
--   * (studentGroupId, schoolId) -> StudentGroups, ON DELETE CASCADE: a credit
--     for 7A means nothing once 7A is gone.
--
-- No key to SchoolBreaks. A credit is about a date; the breaks page shows it
-- under the lov it falls in, which is display only — the lov can be moved or
-- deleted and the decision about that date still stands.
--
-- ## No trigger, and why none is needed
--
-- Every wrong row a PostgREST writer could author is refused by a key or a
-- CHECK, or is harmless:
--
--   * another school's year, subject or group: the composite keys (23503);
--   * minutes, span, scope, name or note out of bounds: the CHECKs (23514);
--   * a group of another läsår of the same school: legal and inert — the
--     coverage of a year only reads that year's groups, so the credit reaches
--     nobody (the service refuses it with TIMPLAN_CREDIT_GROUP_OF_ANOTHER_YEAR,
--     and the coverage reports it as reaching nobody);
--   * a date outside the year's bounds: see above.
--
-- ## Row-level security: two arms
--
--   * timplan_credits_admin_all — the school's SCHOOL_ADMIN, FOR ALL. The only
--     writer: a credit is the school's decision.
--   * timplan_credits_staff_select — TEACHER (and admin) of the school read
--     every row. Not a courtesy: a teacher's GET /timplan-coverage runs under
--     the teacher's own RLS, and without this arm a teacher's group figures
--     would leave out every credit and disagree with the admin's for the same
--     group.
--
-- No family arm yet. LocalTimplans has one for decided plans, and a credit
-- is as public as the decision it records — but a group-scoped credit can
-- single out a small anpassad group, and the narrowing that shows a family
-- only the credits reaching their own pupil's groups is P4's, together with
-- the family reader that needs it. No service-principal arm: no SS12000
-- resource reads credits.
--
-- The role check sits in USING as well as WITH CHECK, for section 7's reason:
-- WITH CHECK alone stops a writer authoring a row and leaves them able to
-- DELETE one.
--
-- ## Indexes
--
-- ("schoolId", "academicYearId", "date") serves the year's read, which is the
-- only read; ("studentGroupId", "schoolId") and ("subjectId", "schoolId") serve
-- the cascades from a deleted group or subject.

CREATE TABLE "TimplanCredits" (
    "id"             UUID           NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"       UUID           NOT NULL,
    "academicYearId" UUID           NOT NULL,
    "date"           DATE           NOT NULL,
    "minutes"        INTEGER        NOT NULL,
    "subjectId"      UUID,
    "studentGroupId" UUID,
    "minGradeLevel"  INTEGER,
    "maxGradeLevel"  INTEGER,
    "name"           TEXT           NOT NULL,
    "note"           TEXT,
    "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"      TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "TimplanCredits_pkey" PRIMARY KEY ("id"),

    CONSTRAINT "TimplanCredits_minutes_is_sane" CHECK (
        "minutes" BETWEEN 1 AND 600
    ),
    CONSTRAINT "TimplanCredits_grade_span_is_whole" CHECK (
        ("minGradeLevel" IS NULL) = ("maxGradeLevel" IS NULL)
    ),
    CONSTRAINT "TimplanCredits_grade_span_is_ordered" CHECK (
        "minGradeLevel" IS NULL OR (
            "minGradeLevel" BETWEEN 0 AND 12
            AND "maxGradeLevel" BETWEEN 0 AND 12
            AND "maxGradeLevel" >= "minGradeLevel"
        )
    ),
    CONSTRAINT "TimplanCredits_scope_is_one" CHECK (
        "studentGroupId" IS NULL OR "minGradeLevel" IS NULL
    ),
    CONSTRAINT "TimplanCredits_name_is_sane" CHECK (
        "name" ~ '[^\t\n\v\f\r    -     　﻿]' AND char_length("name") <= 80
    ),
    CONSTRAINT "TimplanCredits_note_is_sane" CHECK (
        "note" IS NULL
        OR ("note" ~ '[^\t\n\v\f\r    -     　﻿]' AND char_length("note") <= 500)
    )
);

CREATE INDEX "TimplanCredits_schoolId_academicYearId_date_idx"
    ON "TimplanCredits"("schoolId", "academicYearId", "date");
CREATE INDEX "TimplanCredits_studentGroupId_schoolId_idx"
    ON "TimplanCredits"("studentGroupId", "schoolId");
CREATE INDEX "TimplanCredits_subjectId_schoolId_idx"
    ON "TimplanCredits"("subjectId", "schoolId");

ALTER TABLE "TimplanCredits"
    ADD CONSTRAINT "TimplanCredits_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TimplanCredits"
    ADD CONSTRAINT "TimplanCredits_academicYearId_schoolId_fkey"
    FOREIGN KEY ("academicYearId", "schoolId") REFERENCES "AcademicYears"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TimplanCredits"
    ADD CONSTRAINT "TimplanCredits_subjectId_schoolId_fkey"
    FOREIGN KEY ("subjectId", "schoolId") REFERENCES "Subjects"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TimplanCredits"
    ADD CONSTRAINT "TimplanCredits_studentGroupId_schoolId_fkey"
    FOREIGN KEY ("studentGroupId", "schoolId") REFERENCES "StudentGroups"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "TimplanCredits" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "timplan_credits_admin_all" ON "TimplanCredits"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

CREATE POLICY "timplan_credits_staff_select" ON "TimplanCredits"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) IN ('TEACHER', 'SCHOOL_ADMIN')
    );

-- Guarded, as 20260930120000 explains: `app_authenticated` exists only in the
-- local compose database, and a bare GRANT would abort the deploy everywhere
-- else. Where the role is missing, "authenticated" is already covered by
-- 20260806000000's ALTER DEFAULT PRIVILEGES.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "TimplanCredits" TO "app_authenticated";
  END IF;
END
$$;
