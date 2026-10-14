-- En tjänst kan ändras från ett datum.
--
-- A teacher's post is one row per läsår (TeacherEmployments, 20261006100000):
-- tjänstgöringsgrad, nedsättning, avtalsform and an own riktmärke for the
-- whole year. Posts change during a year all the time — a teacher goes down to
-- 80 % from 1 november, a nedsättning for a union assignment starts in
-- January, a förstelärare's target is lowered for the spring — and today the
-- school either rewrites the year's row, so the autumn is reported at the
-- spring's figures, or leaves it, so the spring is.
--
-- ## The model: a base row and periods that override it
--
-- TeacherEmploymentPeriods holds, per post, any number of non-overlapping
-- periods with Från (required) and Till (null: the läsår's last day), each
-- stating the three figures that change: tjänstgöringsgrad, nedsättning and
-- the own riktmärke (null: derived from the school's riktmärke, as on the
-- base row). A day no period covers is the base row's. Avtalsform, signature
-- and note stay on the base row: they describe the employment, not a stretch
-- of it.
--
-- Base plus overrides rather than a list of periods replacing the row: it is
-- additive. Every reader of TeacherEmployments keeps working, reading the
-- year-start post, until it is moved to the periods; the readers moved in this
-- release are named in src/staffing/employment-readers.inventory.spec.ts, and
-- the others say there why they are not yet.
--
--   * A period states all three figures, not the ones it changes. "80 % from
--     1 november" with the base's nedsättning would otherwise depend on the
--     base row's value at the time it is read, and a base edited later would
--     silently rewrite the period.
--   * The same CHECKs as the base row: (0, 100], nedsättning inside the post,
--     riktmärke 0..2400. Från <= Till.
--   * TeacherEmploymentPeriods_do_not_overlap: EXCLUDE USING gist over
--     (employmentId =, daterange(validFrom, validTo, '[]') &&); a null Till
--     is an unbounded range. Two periods of one post never cover one day, so
--     "the post on a date" has one answer. btree_gist since 20260822131500.
--   * That the dates lie INSIDE the läsår is a fact about another table, and
--     it is enforced where the duties' and the requirements' dates are: the
--     service reads the year's bounds FOR SHARE in the write's transaction,
--     and AcademicYearsService.update counts the periods a new bound would
--     strand (academic-year-bounds.ts).
--
-- ## Keys
--
-- The period names its post, and carries the post's schoolId, userId and
-- academicYearId: the row-level arms below and the history trigger read them
-- as they read the post's own. One composite foreign key keeps all four the
-- post's — (employmentId, schoolId, userId, academicYearId) to a UNIQUE of
-- the same four on TeacherEmployments — ON DELETE CASCADE (a post deleted, by
-- the service, the person's or the year's cascade or PostgREST, takes its
-- periods) and ON UPDATE CASCADE (a post PostgREST moves to another teacher or
-- year takes its periods along, and their history follows as for an uppdrag
-- moved: each owner gets their own half). Plus schoolId to Schools, as every
-- child table has.
--
-- ## Row-level security: the post's arms, read only through the API
--
-- A period says what a post is from a date, which is the post's HR data, so
-- it is read by the same people as the post (20261006100000,
-- 20261016100000) — and, like the six tables 20261026100000 closed to
-- PostgREST, another person's period only through the gateway, which writes
-- the read in the läslogg:
--
--   * teacher_employment_periods_admin_all: the school's admin, FOR ALL,
--     under the API's own role (app_authenticated). PostgREST's authenticated
--     has no arm that shows it a colleague's period, and none that writes one.
--   * teacher_employment_periods_teacher_own_select: a TEACHER reads the
--     periods of their own post and no colleague's, also directly: it is the
--     one arm TO authenticated (RLS section 94).
--   * teacher_employment_periods_service_select: the service principal reads
--     by school, under the API's own role, as teacher_employments_service_select
--     does since 20261016100000. Whether an integration may see a post at all
--     is the school's shareEmploymentWithIntegrations, which the SS12000
--     exports read before they hand a post out; the export of periods is the
--     next release's, and reads the same switch.
--
-- New tables start closed since 20261016090000-130000: anon nothing,
-- service_role SELECT, authenticated without TRUNCATE, REFERENCES, TRIGGER or
-- MAINTAIN. The API role gets the four DML rights the post has.
--
-- ## The history
--
-- A period's versions are the tjänst's versions: AFTER INSERT, UPDATE and
-- DELETE log through app.teacher_staffing_log, as the post and its uppdrag
-- do, as entity PERIOD (20261022110000). The function reads `note` through
-- the row's JSON now, since a period has none; for the post and the uppdrag
-- that is the same value it read before.

-- ---------------------------------------------------------------------------
-- The post's four-column key, the period's target.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX "TeacherEmployments_id_schoolId_userId_academicYearId_key"
    ON "TeacherEmployments"("id", "schoolId", "userId", "academicYearId");

-- ---------------------------------------------------------------------------
-- TeacherEmploymentPeriods
-- ---------------------------------------------------------------------------

CREATE TABLE "TeacherEmploymentPeriods" (
    "id"                           UUID           NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"                     UUID           NOT NULL,
    "employmentId"                 UUID           NOT NULL,
    "userId"                       UUID           NOT NULL,
    "academicYearId"               UUID           NOT NULL,
    "validFrom"                    DATE           NOT NULL,
    "validTo"                      DATE,
    "employmentPercent"            DECIMAL(6, 3)  NOT NULL,
    "reductionPercent"             DECIMAL(6, 3)  NOT NULL DEFAULT 0,
    "teachingTargetMinutesPerWeek" INTEGER,
    "createdAt"                    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"                    TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "TeacherEmploymentPeriods_pkey" PRIMARY KEY ("id"),

    CONSTRAINT "TeacherEmploymentPeriods_employmentPercent_is_sane" CHECK (
        "employmentPercent" > 0 AND "employmentPercent" <= 100
    ),
    CONSTRAINT "TeacherEmploymentPeriods_reduction_within_employment" CHECK (
        "reductionPercent" >= 0 AND "reductionPercent" <= "employmentPercent"
    ),
    CONSTRAINT "TeacherEmploymentPeriods_teachingTarget_is_sane" CHECK (
        "teachingTargetMinutesPerWeek" IS NULL
        OR "teachingTargetMinutesPerWeek" BETWEEN 0 AND 2400
    ),
    CONSTRAINT "TeacherEmploymentPeriods_dates_are_ordered" CHECK (
        "validTo" IS NULL OR "validFrom" <= "validTo"
    ),
    CONSTRAINT "TeacherEmploymentPeriods_do_not_overlap" EXCLUDE USING gist (
        "employmentId" WITH =,
        daterange("validFrom", "validTo", '[]') WITH &&
    )
);

-- The year's read (the load report, the matrix) and the year's cascade.
CREATE INDEX "TeacherEmploymentPeriods_schoolId_academicYearId_idx"
    ON "TeacherEmploymentPeriods"("schoolId", "academicYearId");
-- The post's cascade and its list, ahead of the gist index for equality.
CREATE INDEX "TeacherEmploymentPeriods_employmentId_idx"
    ON "TeacherEmploymentPeriods"("employmentId");

ALTER TABLE "TeacherEmploymentPeriods"
    ADD CONSTRAINT "TeacherEmploymentPeriods_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "TeacherEmploymentPeriods"
    ADD CONSTRAINT "TeacherEmploymentPeriods_employment_fkey"
    FOREIGN KEY ("employmentId", "schoolId", "userId", "academicYearId")
    REFERENCES "TeacherEmployments"("id", "schoolId", "userId", "academicYearId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- The history. app.teacher_staffing_log as 20261017090000 left it, with two
-- changes: the table's entity, and `note` read through the row's JSON.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.teacher_staffing_log() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  entity "TeacherLogEntity" :=
    CASE TG_TABLE_NAME WHEN 'TeacherEmployments' THEN 'EMPLOYMENT'::"TeacherLogEntity"
                       WHEN 'TeacherEmploymentPeriods' THEN 'PERIOD'::"TeacherLogEntity"
                       ELSE 'DUTY'::"TeacherLogEntity" END;
  -- blockedConstraintId (20261017090000): an uppdrag's times are versions of
  -- their own, counted from TeacherDutySlots.
  stripped text[] := ARRAY['schoolId', 'createdAt', 'updatedAt', 'blockedConstraintId'];
  -- The note's text never enters the log; "noteChanged" says it was written.
  -- Read through the JSON: a period has no note (20261022120000).
  note_written constant jsonb := '{"noteChanged": true}'::jsonb;
  old_row jsonb;
  new_row jsonb;
  actor uuid := app.current_user_id();
BEGIN
  IF TG_OP = 'INSERT' THEN
    new_row := to_jsonb(NEW) - stripped - 'note';
    IF COALESCE(to_jsonb(NEW) ->> 'note', '') <> '' THEN
      new_row := new_row || note_written;
    END IF;
    PERFORM app.teacher_staffing_log_write(NEW."schoolId", NEW."userId", NEW."academicYearId",
                                           entity, NEW."id", 'CREATE', NULL, new_row, actor);
    RETURN NULL;
  END IF;

  IF TG_OP = 'DELETE' THEN
    old_row := to_jsonb(OLD) - stripped - 'note';
    PERFORM app.teacher_staffing_log_write(OLD."schoolId", OLD."userId", OLD."academicYearId",
                                           entity, OLD."id", 'DELETE', old_row, NULL, actor);
    RETURN NULL;
  END IF;

  IF (to_jsonb(OLD) - stripped) = (to_jsonb(NEW) - stripped) AND OLD."schoolId" = NEW."schoolId" THEN
    -- A save that changed nothing, the note included, is no version.
    RETURN NULL;
  END IF;
  old_row := to_jsonb(OLD) - stripped - 'note';
  new_row := to_jsonb(NEW) - stripped - 'note';

  IF OLD."userId" IS DISTINCT FROM NEW."userId"
     OR OLD."academicYearId" IS DISTINCT FROM NEW."academicYearId"
     OR OLD."schoolId" IS DISTINCT FROM NEW."schoolId"
     OR OLD."id" IS DISTINCT FROM NEW."id" THEN
    -- Moved to another owner: each owner gets their own half, so no teacher's
    -- arm ever shows them a colleague's `before`.
    PERFORM app.teacher_staffing_log_write(OLD."schoolId", OLD."userId", OLD."academicYearId",
                                           entity, OLD."id", 'DELETE', old_row, NULL, actor);
    IF COALESCE(to_jsonb(NEW) ->> 'note', '') <> '' THEN
      new_row := new_row || note_written;
    END IF;
    PERFORM app.teacher_staffing_log_write(NEW."schoolId", NEW."userId", NEW."academicYearId",
                                           entity, NEW."id", 'CREATE', NULL, new_row, actor);
    RETURN NULL;
  END IF;

  IF (to_jsonb(OLD) ->> 'note') IS DISTINCT FROM (to_jsonb(NEW) ->> 'note') THEN
    new_row := new_row || note_written;
  END IF;
  PERFORM app.teacher_staffing_log_write(NEW."schoolId", NEW."userId", NEW."academicYearId",
                                         entity, NEW."id", 'UPDATE', old_row, new_row, actor);
  -- An AFTER trigger's return value is ignored.
  RETURN NULL;
END
$$;

CREATE TRIGGER "TeacherEmploymentPeriods_log"
    AFTER INSERT OR UPDATE OR DELETE ON "TeacherEmploymentPeriods"
    FOR EACH ROW EXECUTE FUNCTION app.teacher_staffing_log();

-- ---------------------------------------------------------------------------
-- Row-level security. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "TeacherEmploymentPeriods" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "teacher_employment_periods_teacher_own_select" ON "TeacherEmploymentPeriods"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) = 'TEACHER'
        AND "userId" = (select app.current_user_id())
    );

-- The admin's arm, the service arm and the API role's grants, guarded like
-- every grant to that role (20260930120000): it exists in production and in
-- the compose database, not in every database a migration meets. Without it
-- there is no API to read through, and no arm: never one TO PUBLIC (RLS
-- section 37), and never the admin's TO authenticated (section 94).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    EXECUTE 'CREATE POLICY "teacher_employment_periods_admin_all" ON "TeacherEmploymentPeriods"
                 FOR ALL TO "app_authenticated"
                 USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = ''SCHOOL_ADMIN'')
                 WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = ''SCHOOL_ADMIN'')';
    EXECUTE 'CREATE POLICY "teacher_employment_periods_service_select" ON "TeacherEmploymentPeriods"
                 FOR SELECT TO "app_authenticated"
                 USING ("schoolId" = app.current_service_school_id())';
    GRANT SELECT, INSERT, UPDATE, DELETE ON "TeacherEmploymentPeriods" TO "app_authenticated";
  END IF;
END
$$;
