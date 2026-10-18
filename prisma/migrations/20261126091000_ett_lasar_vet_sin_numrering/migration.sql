-- Ett läsår vet sin numrering.
--
-- SFS 2025:729 (tillämpas på utbildning efter 2028-06-30) numbers every
-- årskurs of grundskolan, anpassade grundskolan, specialskolan and sameskolan
-- anew: förskoleklassen ends, and övergångsbestämmelse 4 moves every pupil
-- already in school one årskurs further than a normal year ("ska i stället
-- börja i en årskurs som överstiger den årskursen med ett år"; last year's
-- förskoleklass "börja direkt i årskurs 2"). Source: svenskforfattningssamling.se,
-- SFS2025-729.pdf, read 2026-10-17. An årskurs stored in a läsår is in that
-- läsår's numbering: 8A in 2027/28 and 10A in 2028/29 are the same årskull.
--
-- THE NUMBERING IS STORED, NOT DERIVED FROM THE DATE. Every reader that
-- compares an årskurs of one läsår with anything numbered otherwise — a lokal
-- timplan's rows (in its lydelse's numbering), a school-wide span (frames,
-- behörigheter, skolenheter …, stated in the nine-year numbering), another
-- läsår — needs to know it, and a date cannot say it for a school that is
-- not in the four forms and keeps its own numbers. A column can, and it does
-- not move when an admin moves a start date across 1 July.
--
--   * "gradeNumbering" GradeNumbering: NIOARIG (today's numbers, förskole-
--     klass 0) or TIOARIG (the tioårig numbers, no förskoleklass). NOT NULL.
--   * CHECK: TIOARIG only for a läsår starting 2028-07-01 or later. A
--     NIOARIG läsår after that date is a school's own numbering — one that is
--     not grundskola, which the reform leaves untouched.
--   * Written once, at INSERT, like predecessorId: the BEFORE trigger below
--     refuses any later change (SQLSTATE GN409, GRADE_NUMBERING_IS_FIXED).
--     A läsår with the wrong numbering is deleted and made again.
--   * Filled when the INSERT leaves it out (the old API, PostgREST, a create
--     that does not say): a läsår starting before 2028-07-01 is NIOARIG; a
--     later one takes the numbering of the school's latest läsår starting
--     from 2028-07-01 before it, and TIOARIG when there is none — p. 2–4 make
--     the new numbering the rule, and a school leaves it only by saying so.
--     The rollover that crosses the reform writes it explicitly.
--
-- Every existing läsår is NIOARIG, including any already dated from HT 2028:
-- its classes were made when SchemaPro numbered every årskurs the old way,
-- and nothing here guesses otherwise. Such a läsår is deleted and made again
-- when the school wants it in the new numbering.
--
-- The column inherits AcademicYears' arms and grants (no column grants
-- exist on the table): every reader of a läsår reads its numbering, and an
-- admin who may insert a läsår may say it.
--
-- THE OLD API between this migration and the deploy never names the column:
-- its inserts are filled by the trigger, its reads ignore it.
--
-- LOCKS. Adding the column, its CHECK and its trigger take ACCESS EXCLUSIVE
-- on AcademicYears, which every request reads. The lock is taken NOWAIT in a
-- loop that gives up after 30 s with nothing changed; the table is small
-- (a handful of rows per school), so it is held for the backfill and the
-- NOT NULL scan only.

CREATE TYPE "GradeNumbering" AS ENUM ('NIOARIG', 'TIOARIG');

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  LOOP
    BEGIN
      LOCK TABLE "AcademicYears" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'AcademicYears was not free in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

ALTER TABLE "AcademicYears" ADD COLUMN "gradeNumbering" "GradeNumbering";

-- Not ordinary writes: the guard below does not exist yet, and nothing else
-- fires on this column.
UPDATE "AcademicYears" SET "gradeNumbering" = 'NIOARIG';

ALTER TABLE "AcademicYears"
    ALTER COLUMN "gradeNumbering" SET NOT NULL,
    ADD CONSTRAINT "AcademicYears_tioarig_from_2028" CHECK (
        "gradeNumbering" = 'NIOARIG' OR "startDate" >= DATE '2028-07-01'
    );

-- SECURITY INVOKER: the fill reads the school's own läsår under the caller's
-- arms, never another school's; the guard reads nothing.
CREATE FUNCTION app.academic_years_numbering() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."gradeNumbering" IS DISTINCT FROM NEW."gradeNumbering" THEN
      RAISE EXCEPTION 'GRADE_NUMBERING_IS_FIXED: ett läsårs numrering bestäms när läsåret skapas och ändras inte i efterhand'
        USING ERRCODE = 'GN409',
              DETAIL  = format('academicYearId=%s', NEW."id");
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."gradeNumbering" IS NULL THEN
    IF NEW."startDate" < DATE '2028-07-01' THEN
      NEW."gradeNumbering" := 'NIOARIG';
    ELSE
      NEW."gradeNumbering" := coalesce(
        (SELECT y."gradeNumbering" FROM "AcademicYears" y
          WHERE y."schoolId" = NEW."schoolId" AND y."id" <> NEW."id"
            AND y."startDate" >= DATE '2028-07-01' AND y."startDate" < NEW."startDate"
          ORDER BY y."startDate" DESC, y."id" DESC
          LIMIT 1),
        'TIOARIG');
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "AcademicYears_numbering"
    BEFORE INSERT OR UPDATE OF "gradeNumbering" ON "AcademicYears"
    FOR EACH ROW
    EXECUTE FUNCTION app.academic_years_numbering();

REVOKE ALL ON FUNCTION app.academic_years_numbering() FROM PUBLIC;
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['app_authenticated', 'authenticated', 'anon', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION app.academic_years_numbering() FROM %I', r);
    END IF;
  END LOOP;
END
$$;
