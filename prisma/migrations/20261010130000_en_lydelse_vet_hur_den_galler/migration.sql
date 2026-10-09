-- En lydelse vet hur den gäller, och 2028 års totaler finns för fler skolformer.
--
-- Timplan P4 compares a pupil's hours over a stadium with the national
-- figures of the lydelse that applies to that pupil. The reference data
-- (20261006090000) records WHEN a lydelse starts to apply
-- (appliesFromCohortTerm) but not HOW, and the statute uses two different
-- rules:
--
--   * SFS 2023:945 (skolförordningen bilaga 1, 3 och 4; utfärdad 2023-12-21,
--     i kraft 2024-07-01) applies BY STAGE. Its övergångsbestämmelse 3: "För
--     stadier som en elev har avslutat före ikraftträdandet gäller bilaga 1, 3
--     och 4 i den äldre lydelsen." A pupil who finished mellanstadiet in June
--     2024 had the older bilaga for it; the same pupil's högstadium, not
--     finished, has the new one. Source: svenskforfattningssamling.se,
--     SFS2023-945.pdf, read 2026-10-10.
--   * SFS 2025:729 (lag om ändring i skollagen, the tioårig grundskola;
--     utfärdad 2025-06-19, i kraft 2026-07-01, "tillämpas första gången på
--     utbildning och annan verksamhet som bedrivs efter den 30 juni 2028",
--     övergångsbestämmelse 2) applies BY COHORT. Its övergångsbestämmelse 12:
--     for pupils who in HT 2028 begin årskurs 2 or higher, 10 kap. 5 § första
--     stycket (and the same paragraphs for the other forms) apply in the older
--     lydelse — the 6 890 h total. Only the first stycke, the total: the law
--     says nothing about the older cohorts' distribution per subject after
--     2028. Source: svenskforfattningssamling.se, SFS2025-729.pdf, read
--     2026-10-10.
--
-- So a new column, "appliesBy" (TimplanApplicability: STAGES_NOT_COMPLETED |
-- COHORTS_STARTING), filled per code from the provisions quoted above, NOT
-- NULL once filled; a DO block refuses the deploy if a row is left unset. The
-- 2022:1619 rows (bilaga 2, anpassade grundskolan) get STAGES_NOT_COMPLETED.
-- Their transitional text was not verified for this migration; the choice is
-- argued as moot rather than as law: no earlier bilaga 2 is seeded, so either
-- reading yields bilaga 2 or nothing for a pupil.
--
-- ## The 2028 totals for three more school forms
--
-- SFS 2025:729 states the new totals of every form beside grundskolan, and
-- they are statute, published and checked against the text (same PDF, same
-- date):
--
--   * 11 kap. 7 §: anpassade grundskolan, ämnen 7 424 h; ämnesområden 7 199 h.
--   * 13 kap. 5 §: sameskolan 5 007 h (13 kap. 3 §: seven grades, lågstadiet
--     1–4 and mellanstadiet 5–7).
--   * 12 kap. 5 §: specialskolan 8 604 h — NOT seeded. 12 kap. 3 § gives it
--     eleven grades (lågstadiet 1–5, mellanstadiet 6–8, högstadiet 9–11), and
--     årskurs 11 does not fit the 0..10 CHECKs of LocalTimplanEntries and
--     AcademicYearTimplans. That slot waits for the migration that widens them.
--
-- SFS 2026:1243 (lag om ändring i skollagen, utfärdad 2026-06-18, i kraft
-- 2028-07-02, tillämpas första gången på utbildning som påbörjas HT 2028 i
-- åk 1–8; read from svenskforfattningssamling.se, SFS2026-1243.pdf, on
-- 2026-10-10) restates the same four totals in 10 kap. 5 §, 11 kap. 7 §,
-- 12 kap. 5 § and 13 kap. 5 §, and is the law behind prop. 2025/26:194 (bet.
-- 2025/26:UbU23, rskr. 2025/26:327).
--
-- The three rows carry their total only: no cells, skolans val and cap NULL,
-- appliesFromCohortTerm HT2028, COHORTS_STARTING. P1's coverage already reads
-- a version without cells as "fördelning ej publicerad" and never as 0 h per
-- cell. The current bilaga 2 rows and bilaga 4 point at them through
-- supersededByCode, as bilaga 1 points at SFS2025:729. The codes follow
-- 'SFS2025:729' for grundskolan: '/AGA', '/AGB', '/SAM'.
--
-- ## Where the 2028 distribution will come from — the slot, not cells here
--
-- SFS 2026:1243 rewrites skollagen 1 kap. 11 §: the läroplaner for
-- grundskolan, anpassade grundskolan, specialskolan and sameskolan "ska också
-- innehålla kursplaner och fördelningar av undervisningstiden (timplaner)",
-- and the government may issue föreskrifter on those parts. The distribution
-- per subject will therefore arrive in a läroplan förordning, not as cells of
-- SFS 2025:729. Skolverket's proposals for "nya och reviderade läroplaner"
-- were due 31 March 2027 (regeringsuppdrag U2025/02427, decided 2025-12-18 and
-- published on regeringen.se 2025-12-22, which also asks how the 534 added
-- hours in lågstadiet are distributed) and were postponed to 14 May 2027 by
-- U2026/01483 (regeringsbeslut 2026-08-20). As of 2026-10-10 nothing is
-- published, and no figure here is invented: the 534 h is the difference of
-- two totals, not a distribution.
--
-- When the förordning is issued, ONE migration adds a NationalTimplanVersion
-- coded after it (appliesBy COHORTS_STARTING, appliesFromCohortTerm HT2028),
-- its cells, and P1's self-checking DO block. stageGradesFor and the stage
-- module read it generically; no code changes.
--
-- Grants: the column inherits the table's (20261006090000: SELECT for every
-- API role but anon, no writes). RLS section 26e asserts that.

CREATE TYPE "TimplanApplicability" AS ENUM ('STAGES_NOT_COMPLETED', 'COHORTS_STARTING');

ALTER TABLE "NationalTimplanVersions" ADD COLUMN "appliesBy" "TimplanApplicability";

UPDATE "NationalTimplanVersions" SET "appliesBy" = 'STAGES_NOT_COMPLETED'
 WHERE "code" IN ('SFS2023:945/B1', 'SFS2023:945/B3', 'SFS2023:945/B4', 'SFS2022:1619/B2A', 'SFS2022:1619/B2B');
UPDATE "NationalTimplanVersions" SET "appliesBy" = 'COHORTS_STARTING' WHERE "code" = 'SFS2025:729';

INSERT INTO "NationalTimplanVersions"
    ("code", "sfs", "title", "schoolForm", "totalHours", "skolansValHours",
     "reductionCapPercent", "appliesFromCohortTerm", "supersededByCode", "appliesBy")
VALUES
    ('SFS2025:729/AGA', '2025:729',
     'Skollagen 11 kap. 7 § i lydelse enligt lag (2025:729) – anpassade grundskolan, elever som läser ämnen; fördelningen är inte publicerad',
     'ANPASSAD_GRUNDSKOLA_AMNEN', 7424, NULL, NULL, 'HT2028', NULL, 'COHORTS_STARTING'),
    ('SFS2025:729/AGB', '2025:729',
     'Skollagen 11 kap. 7 § i lydelse enligt lag (2025:729) – anpassade grundskolan, elever som läser ämnesområden; fördelningen är inte publicerad',
     'ANPASSAD_GRUNDSKOLA_AMNESOMRADEN', 7199, NULL, NULL, 'HT2028', NULL, 'COHORTS_STARTING'),
    ('SFS2025:729/SAM', '2025:729',
     'Skollagen 13 kap. 5 § i lydelse enligt lag (2025:729) – sameskolan; fördelningen är inte publicerad',
     'SAMESKOLA', 5007, NULL, NULL, 'HT2028', NULL, 'COHORTS_STARTING');

UPDATE "NationalTimplanVersions" SET "supersededByCode" = 'SFS2025:729/AGA' WHERE "code" = 'SFS2022:1619/B2A';
UPDATE "NationalTimplanVersions" SET "supersededByCode" = 'SFS2025:729/AGB' WHERE "code" = 'SFS2022:1619/B2B';
UPDATE "NationalTimplanVersions" SET "supersededByCode" = 'SFS2025:729/SAM' WHERE "code" = 'SFS2023:945/B4';

DO $$
DECLARE unset text;
BEGIN
  SELECT string_agg("code", ', ' ORDER BY "code") INTO unset FROM "NationalTimplanVersions" WHERE "appliesBy" IS NULL;
  IF unset IS NOT NULL THEN
    RAISE EXCEPTION 'NationalTimplanVersions: no applicability decided for %', unset;
  END IF;
  -- The three new rows are totals only, and say so: no cell, no pool, no cap.
  IF EXISTS (SELECT 1 FROM "NationalTimplanEntries" e JOIN "NationalTimplanVersions" v ON v."id" = e."versionId"
              WHERE v."code" IN ('SFS2025:729', 'SFS2025:729/AGA', 'SFS2025:729/AGB', 'SFS2025:729/SAM')) THEN
    RAISE EXCEPTION 'NationalTimplanVersions: a 2028 lydelse carries cells nobody has published';
  END IF;
END
$$;

ALTER TABLE "NationalTimplanVersions" ALTER COLUMN "appliesBy" SET NOT NULL;
