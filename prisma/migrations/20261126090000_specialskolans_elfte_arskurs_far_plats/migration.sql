-- Specialskolans elfte årskurs får plats, och dess 8 604 timmar finns.
--
-- SFS 2025:729 (lag om ändring i skollagen, utfärdad 2025-06-19, tillämpas
-- på utbildning efter 2028-06-30) gives specialskolan eleven årskurser from
-- HT 2028: "Specialskolan ska ha elva årskurser", lågstadiet 1–5,
-- mellanstadiet 6–8 and högstadiet 9–11 (12 kap. 3 §), and at least 8 604
-- hours for the cohorts that begin the new åk 1 (12 kap. 5 §; övergångs-
-- bestämmelse 12 keeps 8 070 h for everyone who begins åk 2 or higher in HT
-- 2028). Source: svenskforfattningssamling.se, SFS2025-729.pdf, read
-- 2026-10-17. SFS 2026:1243 restates the same total in 12 kap. 5 § from
-- 2028-07-02.
--
-- 20261010130000 seeded the other three 2028 totals (anpassade grundskolan
-- 7 424 and 7 199, sameskolan 5 007) and left this one out, because årskurs
-- 11 did not fit the 0..10 CHECKs of LocalTimplanEntries and
-- AcademicYearTimplans. This migration widens them, and every other 0..10
-- bound on an årskurs the tioårig numbering can reach, to 0..11:
--
--   * LocalTimplanEntries.gradeLevel and AcademicYearTimplans.gradeLevel:
--     a specialskola plan on the 2028 lydelse plans åk 11, and a läsår from
--     HT 2028 attaches it to åk 11.
--   * TimplanStatements' gradesFrom/gradesTo and its three grade lists: the
--     published stage of a reformed specialskola pupil is högstadiet 9–11.
--   * CancellationBatches' GRADES scope: a cancellation for åk 11.
--
-- Not SchoolUnits' span. It is school-wide, so it is stated in the nine-year
-- numbering for good, like frames and behörigheter (20261126091000): there a
-- specialskola unit is F–10, 0..10, as today. A unit's span in the tioårig
-- numbering is a pair of its own, proposed by SFS 2025:729 övergångs-
-- bestämmelse 5 and confirmed by an admin (a follow-up, before HT 2028).
--
-- 11 is the highest årskurs any form has after the reform; nothing above it
-- is a compulsory-school årskurs, and the bounds that already run to 12
-- (classes, frames, qualifications …) are untouched. Every existing row
-- satisfies the wider CHECK, so validating it (under the lock below) reads
-- the table and refuses nothing. The tables are small — per school a few
-- hundred plan cells, a dozen year rows, a handful of batches, a statement
-- per pupil stage published.
--
-- THE NEW ROW. 'SFS2025:729/SPE' after '/AGA', '/AGB' and '/SAM':
-- SPECIALSKOLA, 8 604 h, no cells, skolans val and cap NULL (the law states
-- neither), appliesFromCohortTerm HT2028, COHORTS_STARTING. Bilaga 3 (SFS
-- 2023:945/B3) points at it through supersededByCode, as B1, B2A, B2B and B4
-- point at theirs. A version without cells is "fördelning ej publicerad"
-- everywhere it is read (P1's coverage, P4's stage, the family card), never
-- 0 h per cell; the stage module cuts it 1–5 / 6–8 / 9–11.
--
-- THE OLD API between this migration and the deploy: its DTOs still refuse
-- 11, its stage cut still reads specialskolan 1–4 / 5–7 / 8–10, and it lists
-- the new row as one more version without cells. Nothing it does is refused
-- by the wider CHECKs.
--
-- LOCKS. Replacing a CHECK takes ACCESS EXCLUSIVE on its table. The four are
-- taken NOWAIT together in a loop that gives up after 30 s with nothing
-- changed: a live request holding one of them is waited out, never queued
-- behind (a queued ACCESS EXCLUSIVE would stop every reader behind it).

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  LOOP
    BEGIN
      LOCK TABLE "LocalTimplanEntries", "AcademicYearTimplans", "TimplanStatements",
                 "CancellationBatches" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'The tables whose årskurs reaches 11 were not free at once in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

ALTER TABLE "LocalTimplanEntries"
    DROP CONSTRAINT "LocalTimplanEntries_gradeLevel_is_sane",
    ADD CONSTRAINT "LocalTimplanEntries_gradeLevel_is_sane" CHECK ("gradeLevel" BETWEEN 0 AND 11);

ALTER TABLE "AcademicYearTimplans"
    DROP CONSTRAINT "AcademicYearTimplans_gradeLevel_is_sane",
    ADD CONSTRAINT "AcademicYearTimplans_gradeLevel_is_sane" CHECK ("gradeLevel" BETWEEN 0 AND 11);

ALTER TABLE "TimplanStatements"
    DROP CONSTRAINT "TimplanStatements_grades_are_sane",
    ADD CONSTRAINT "TimplanStatements_grades_are_sane" CHECK (
        "gradesFrom" BETWEEN 0 AND 11 AND "gradesTo" BETWEEN 0 AND 11 AND "gradesFrom" <= "gradesTo"
    ),
    DROP CONSTRAINT "TimplanStatements_grade_lists_are_sane",
    ADD CONSTRAINT "TimplanStatements_grade_lists_are_sane" CHECK (
        "plannedGrades" <@ ARRAY[0,1,2,3,4,5,6,7,8,9,10,11] AND "unrecordedGrades" <@ ARRAY[0,1,2,3,4,5,6,7,8,9,10,11]
        AND "unplannedGrades" <@ ARRAY[0,1,2,3,4,5,6,7,8,9,10,11]
    );

ALTER TABLE "CancellationBatches"
    DROP CONSTRAINT "CancellationBatches_scope_is_known",
    ADD CONSTRAINT "CancellationBatches_scope_is_known" CHECK (
        ("scope" = 'SCHOOL' AND "minGradeLevel" IS NULL AND "maxGradeLevel" IS NULL AND cardinality("groupIds") = 0)
        OR ("scope" = 'GRADES' AND "minGradeLevel" IS NOT NULL AND "maxGradeLevel" IS NOT NULL
            AND "minGradeLevel" BETWEEN 0 AND 11 AND "maxGradeLevel" BETWEEN 0 AND 11
            AND "minGradeLevel" <= "maxGradeLevel" AND cardinality("groupIds") = 0)
        OR ("scope" = 'GROUPS' AND "minGradeLevel" IS NULL AND "maxGradeLevel" IS NULL
            AND cardinality("groupIds") BETWEEN 1 AND 200)
    );

INSERT INTO "NationalTimplanVersions"
    ("code", "sfs", "title", "schoolForm", "totalHours", "skolansValHours",
     "reductionCapPercent", "appliesFromCohortTerm", "supersededByCode", "appliesBy")
VALUES
    ('SFS2025:729/SPE', '2025:729',
     'Skollagen 12 kap. 5 § i lydelse enligt lag (2025:729) – specialskolan, elva årskurser; fördelningen är inte publicerad',
     'SPECIALSKOLA', 8604, NULL, NULL, 'HT2028', NULL, 'COHORTS_STARTING');

UPDATE "NationalTimplanVersions" SET "supersededByCode" = 'SFS2025:729/SPE' WHERE "code" = 'SFS2023:945/B3';

DO $$
DECLARE n integer;
BEGIN
  -- Every form has its 2028 total, each the old one plus 534 h, and none carries a cell.
  SELECT count(*) INTO n FROM "NationalTimplanVersions" old
    JOIN "NationalTimplanVersions" new ON new."code" = old."supersededByCode"
   WHERE old."code" IN ('SFS2023:945/B1', 'SFS2022:1619/B2A', 'SFS2022:1619/B2B', 'SFS2023:945/B3', 'SFS2023:945/B4')
     AND new."appliesFromCohortTerm" = 'HT2028' AND new."appliesBy" = 'COHORTS_STARTING'
     AND new."totalHours" = old."totalHours" + 534;
  IF n <> 5 THEN
    RAISE EXCEPTION 'NationalTimplanVersions: % of the five bilagor point at a 2028 total 534 h above their own', n;
  END IF;
  IF EXISTS (SELECT 1 FROM "NationalTimplanEntries" e JOIN "NationalTimplanVersions" v ON v."id" = e."versionId"
              WHERE v."code" LIKE 'SFS2025:729%') THEN
    RAISE EXCEPTION 'NationalTimplanVersions: a 2028 lydelse carries cells nobody has published';
  END IF;
END
$$;
