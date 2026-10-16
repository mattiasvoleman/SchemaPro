-- En tjänst har anställningsform och karriärtjänst.
--
-- SCB:s Pedagogisk personal asks, for every teacher on every row, the
-- anställningsform (AnstForm: T tillsvidare, V visstid, L tjänstledig, U
-- upphörd) and, for a förstelärare or lektor, how large a share of the post
-- the karriärtjänst takes (ForsteLarare, Lektor: per cent of the post, 0–100
-- whole). SchemaPro held neither: the SCB underlag left AnstForm for the
-- school to type and named every förstelärare uppdrag for it to look up. The
-- server-built file (src/staffing/scb) fills them from the post.
--
--   * employmentForm: TILLSVIDARE or VISSTID, null while the school has not
--     said. Tjänstledig is no form of employment but the post on SCB's
--     mätdatum, read from the nedsättning (a post wholly reduced for 30 days
--     or more is L); upphörd belongs to SCB's prefilled rows, not to a post.
--   * firstTeacherPercent, lecturerPercent: the share of the post the
--     karriärtjänst takes, 1–100 whole per cent as SCB counts it, null for a
--     teacher who holds none; both together at most the whole post (SCB:
--     "möjligt att vara både lektor och förstelärare").
--
-- HR data like the tjänstgöringsgrad beside them: the same row, so the same
-- arms (the administrator's, through the gateway; a teacher their own row),
-- the same history (TeacherEmploymentLogs records the row as JSON, so the new
-- columns are logged with no change here), and not emitted by SS12000. The
-- läsårsrullning carries them with the post (rollover-registry.ts).
--
-- Additive: one new type and three nullable columns; no row changes. The
-- API selects the post's columns by name, so this runs before the API that
-- reads them.
--
-- No arm. Roller i skolan (20261110100000) split every administrator's arm
-- per area and sorts before this file; the post's arms are its, unchanged:
-- the new columns are read and written under them like the rest of the row
-- (written by one who decides; the gateway masks them, as it masks the tjänst
-- %, from an administrator without HR-läs, src/staffing/hr-visibility.ts).
-- So TABLE_WRITE_GATES and the role matrix (RLS section 116) do not move.
--
-- ## Locks
--
-- Production migrates beside the API that is serving it, and every staffing
-- read and timplan write reads TeacherEmployments. The ALTER takes it in
-- ACCESS EXCLUSIVE: nullable columns without a default rewrite nothing, and
-- the CHECKs scan the table's few rows. It is the one table this file
-- locks, so it closes no cycle with a request; but a migration WAITING for
-- that lock queues every reader behind it. So it takes the lock as
-- 20261104090000 takes its own: NOWAIT, again 50 ms later while a request
-- holds the table, and after 30 s it stops with nothing done and can be run
-- again. lock_timeout bounds any wait nobody foresaw.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "TeacherEmployments" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'TeacherEmployments was not free in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END $$;

CREATE TYPE "TeacherEmploymentForm" AS ENUM ('TILLSVIDARE', 'VISSTID');

ALTER TABLE "TeacherEmployments"
    ADD COLUMN "employmentForm"      "TeacherEmploymentForm",
    ADD COLUMN "firstTeacherPercent" INTEGER,
    ADD COLUMN "lecturerPercent"     INTEGER,
    ADD CONSTRAINT "TeacherEmployments_firstTeacherPercent_check" CHECK ("firstTeacherPercent" BETWEEN 1 AND 100),
    ADD CONSTRAINT "TeacherEmployments_lecturerPercent_check" CHECK ("lecturerPercent" BETWEEN 1 AND 100),
    ADD CONSTRAINT "TeacherEmployments_career_share_check"
        CHECK (coalesce("firstTeacherPercent", 0) + coalesce("lecturerPercent", 0) <= 100);
