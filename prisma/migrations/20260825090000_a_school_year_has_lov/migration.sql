-- Lov och studiedagar, as a range that belongs to the school.
--
-- A dated UNAVAILABLE constraint could already say "this group cannot be taught
-- on this date", and publish honoured it. What it could not say is "the school
-- is closed all of week 9": a constraint names ONE resource on ONE date, so a
-- sportlov meant a row per day per group, and a läsår's lov and studiedagar
-- together ran past a thousand rows entered by hand. `ConstraintResource` has
-- no value meaning "everybody" either.
--
-- Constraints are untouched. They stay good at what they are good at — one
-- teacher away on a Tuesday, a room closed for two hours — and publish keeps
-- reading both.
--
-- WHY THE GRADE SPAN IS HERE AND NOT A JOIN TABLE. A lov is school-wide almost
-- every time, and the exceptions are stated by year: prao for åk 9, a studiedag
-- for the lower ones. A year is a property of a group's members, so there is no
-- row to point at — the same reason AvailabilityConstraints carries the pair
-- rather than a resource id, and the checks below are that migration's, copied
-- deliberately so the two shapes cannot drift.
--
-- NOT enforced: that two breaks may not overlap. They legitimately do — a
-- school-wide lov and a grade-narrowed prao in the same week are two different
-- statements, and a constraint against overlap would refuse the ordinary case.

CREATE TYPE "BreakKind" AS ENUM ('HOLIDAY', 'STAFF_DAY');

CREATE TABLE "SchoolBreaks" (
    "id"             UUID         NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"       UUID         NOT NULL,
    "academicYearId" UUID         NOT NULL,
    "name"           TEXT         NOT NULL,
    "kind"           "BreakKind"  NOT NULL DEFAULT 'HOLIDAY',
    "startDate"      DATE         NOT NULL,
    "endDate"        DATE         NOT NULL,
    "minGradeLevel"  INTEGER,
    "maxGradeLevel"  INTEGER,
    "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"      TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "SchoolBreaks_pkey" PRIMARY KEY ("id"),

    -- Inclusive at both ends, so a single day is startDate = endDate.
    CONSTRAINT "SchoolBreaks_range_is_ordered" CHECK ("endDate" >= "startDate"),

    -- A name is what an administrator recognises the row by in a list of
    -- twenty; an empty one makes the row unidentifiable in its own UI.
    CONSTRAINT "SchoolBreaks_name_is_not_blank" CHECK (btrim("name") <> ''),

    -- Both bounds or neither, ordered, and inside the years a school has.
    CONSTRAINT "SchoolBreaks_grade_span_is_whole" CHECK (
        ("minGradeLevel" IS NULL) = ("maxGradeLevel" IS NULL)
    ),
    CONSTRAINT "SchoolBreaks_grade_span_is_ordered" CHECK (
        "minGradeLevel" IS NULL OR (
            "minGradeLevel" BETWEEN 0 AND 12
            AND "maxGradeLevel" BETWEEN 0 AND 12
            AND "maxGradeLevel" >= "minGradeLevel"
        )
    )
);

ALTER TABLE "SchoolBreaks"
    ADD CONSTRAINT "SchoolBreaks_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Composite, for the reason every reference in this schema is: a foreign-key
-- check runs as the referenced table's owner with row security OFF, so an id
-- the caller cannot even SELECT would still validate. The key is what makes a
-- break's school the school of its year — RLS could not have done it.
ALTER TABLE "SchoolBreaks"
    ADD CONSTRAINT "SchoolBreaks_academicYearId_schoolId_fkey"
    FOREIGN KEY ("academicYearId", "schoolId") REFERENCES "AcademicYears"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "SchoolBreaks_schoolId_academicYearId_idx"
    ON "SchoolBreaks"("schoolId", "academicYearId");
-- Publish and the hours column both ask "what falls in this window", which is
-- the only shape either of them asks in.
CREATE INDEX "SchoolBreaks_schoolId_startDate_endDate_idx"
    ON "SchoolBreaks"("schoolId", "startDate", "endDate");

ALTER TABLE "SchoolBreaks" ENABLE ROW LEVEL SECURITY;

-- Everyone in the school reads them. A lov is not confidential and it is the
-- reason a pupil's calendar is empty that week; a guardian who cannot see it
-- reads the gap as a bug. Writing is the administrator's alone, like every
-- other statement about how the year is laid out.
CREATE POLICY "school_breaks_member_select" ON "SchoolBreaks"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()));

CREATE POLICY "school_breaks_admin_all" ON "SchoolBreaks"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

-- The API connects as a non-owner role, which inherits nothing automatically.
-- Guarded because `app_authenticated` is created only by the local container's
-- init script, so a bare GRANT aborts the deploy on a fresh Supabase project.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "SchoolBreaks" TO "app_authenticated";
  END IF;
END
$$;
