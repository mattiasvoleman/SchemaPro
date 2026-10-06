-- Den nationella timplanen är referensdata.
--
-- Nothing in this schema knows what the law expects a pupil to be taught.
-- TeachingRequirements says "7A has matematik 3 × 60 a week", and that is a
-- RATE a school typed in; nowhere is the 1 230 hours of matematik the statute
-- guarantees over nine years, nor the 410 of them that belong to mellanstadiet,
-- nor the rule that skolans val may take at most 20 % of a cell and none of
-- svenska, engelska, matematik or språkval. So no page can say "åk 4–6 is
-- 20 hours short", and a school subject named "Matte" has no way to say which
-- national cell it feeds.
--
-- This migration is the statute as rows: skolförordningen (2011:185) bilaga 1–4
-- — grundskolan, anpassade grundskolan (two timplaner), specialskolan,
-- sameskolan — one version row per bilaga, one subject row per ämne the
-- bilagor name, one entry per printed cell. Plus a totals-only row for the
-- 2028 reform. And two columns on "Subjects" so a school's own subject can say
-- which national cell it is, and whether it counts as undervisningstid at all.
--
-- ## Transcribed from the primary source, and checked in this file
--
-- Every figure below was read off the consolidated förordning text (lagen.nu,
-- fetched 2026-10-03; authentic source beta.rkrattsbaser.gov.se) and
-- cross-checked against Skolverket's four timplan pages, which print the same
-- tables. The lydelse is SFS 2023:945 for bilaga 1, 3 and 4 (i kraft
-- 2024-07-01, "tillämpas första gången på utbildning som påbörjas höstterminen
-- 2024"; stadier a pupil completed before that keep the older bilaga) and SFS
-- 2022:1619 for bilaga 2 (i kraft 2023-07-02; the figures themselves date from
-- SFS 2018:750, the 2022 förordning renamed grundsärskolan and restated the
-- bilaga). The 7 424 h row is lag (2025:729) om ändring i skollagen, 10 kap.
-- 5 §, utfärdad 2025-06-19: i kraft 2026-07-01, "tillämpas första gången på
-- utbildning ... som bedrivs efter den 30 juni 2028". Its fördelning does not
-- exist yet — the law tells the government to write one — so the row has NO
-- entries and a reader must say "fördelning ej publicerad", not "0 timmar".
-- The same law sets 7 424 h for anpassade grundskolan (ämnen), 7 199 h
-- (ämnesområden), 8 604 h for specialskolan and 5 007 h for sameskolan, and
-- re-cuts the stadier (lågstadiet åk 1–4, mellanstadiet 5–7, högstadiet 8–10).
-- Those four rows are deliberately NOT seeded here: the one grundskola row is
-- what the coverage page needs to show the reform exists, and the rest belong
-- with the bilagor when Skolverket publishes them.
--
-- A transcription is where this feature can be wrong for every school at once
-- while looking right, so the DO block at the end re-adds the table the way the
-- statute prints it and refuses the deploy on any mismatch: the column total of
-- every stadium, the "Totalt garanterat antal timmar" of every bilaga, the
-- "Resterande N timmar får fördelas fritt" remainder of every NO/SO cell, and
-- the sentence naming the subjects skolans val may not touch. Each of those is
-- a second, independent reading of the same page, so a slipped digit in a cell
-- fails against the printed total and a slipped total fails against the cells.
-- A migration that raises is rolled back whole; nothing half-seeded ships.
--
-- ## Why rows and not a constant
--
-- default-room-types.ts is the precedent for "a Swedish list the product
-- knows", and it would be wrong here three times. A constant cannot be
-- foreign-keyed from a school's own subject, so "Matte" → MA would be a free
-- text the database cannot vouch for. The web reads through PostgREST under
-- RLS and cannot import a gateway constant; a table is readable from both
-- sides with one source. And the statute is VERSIONED BY COHORT, not by date:
-- in 2024/25 åk 7–9 are still owed the pre-2024 bilaga 1, and the 2028 law is
-- already enacted with no distribution. A row per version with
-- appliesFromCohortTerm and supersededByCode says that; a constant would have
-- to be an array of arrays with a comment.
--
-- ## No schoolId, and that is the point
--
-- Every other table here carries `schoolId` because every other row belongs to
-- a school. These rows belong to nobody: they are the law, identical for every
-- tenant, written only by a migration. So there is no tenant predicate and no
-- write policy at all — the posture `_prisma_migrations` has (20260914180000),
-- turned the other way: every active signed-in user may SELECT, nobody
-- connected as an API role may INSERT, UPDATE or DELETE. Not the service
-- principal either: SS12000 has no business rewriting the statute. The policy
-- is FOR SELECT with no tenant predicate, and the write grants that
-- 20260806000000's ALTER DEFAULT PRIVILEGES would otherwise hand every new
-- table are REVOKEd below, so a write is refused twice — once by the missing
-- grant (42501, loud) and once by the absence of any policy that would admit
-- the row.
--
-- ## The shape of a cell
--
-- One entry per (version, ämne, stadium). The bilagor print four kinds of
-- figure and the entry carries each as data, not as a rule in code:
--
--   * `stage` is LAG, MELLAN, HOG — or LAG_MELLAN, because hem- och
--     konsumentkunskap is printed in a merged "Låg- och mellanstadiet" column
--     (40 h in grundskolan, 230 in anpassade grundskolan, 50 in specialskolan
--     and sameskolan). It is one cell in the statute and so one row here; a
--     subject with a LAG_MELLAN row has no LAG or MELLAN row in that version.
--   * `hours` on a TOP-LEVEL subject is the guaranteed figure. On a CHILD of an
--     ämnesgrupp (biologi under NO, geografi under SO) it is the minimum the
--     statute prints on that child's own line — "Biologi 60 80" — and the
--     group's hours minus its children's is the "Resterande N timmar får
--     fördelas fritt". Children are therefore NEVER added to a total; the
--     group already holds them.
--   * `minimumHoursPerChild` on a GROUP row is the uniform minimum the prose
--     states ("en minsta undervisningstid om 60 timmar i respektive ämne").
--     It is NULL where the prose only says "en minsta undervisningstid i
--     respektive ämne" and the figures differ per child (every SO cell), and
--     NULL on every leaf. Redundant with the child rows where it is set, and
--     the self-check holds the two readings to each other.
--   * `protectedFromReduction` is the sentence "Antalet timmar för ... får dock
--     inte minskas", per version: svenska eller svenska som andraspråk,
--     engelska, matematik and språkval in grundskolan and specialskolan, those
--     plus samiska in sameskolan. Anpassade grundskolan has no such sentence
--     and no percentage either — 10 kap. 8 § says only "inte ... i
--     oproportionerligt stor omfattning" — so its versions carry NULL for the
--     cap and no protected row. NULL is the honest encoding of "the statute
--     states none"; 0 would be a rule nobody wrote.
--
-- "Svenska eller svenska som andraspråk" is ONE national subject (SV_SVA),
-- because it is one cell: a school with two subjects, Svenska and SvA, maps
-- both to it and the coverage sum rolls them together. Splitting it would make
-- the law say something it does not. "Fördelningsbar undervisningstid" in the
-- ämnesområden timplan is seeded as a subject row for the same reason: it is a
-- printed cell whose hours are part of the 6 665, and 10 kap. 10 § gives it
-- content (ämnesområden after the pupil's needs, prao, modersmål, SvA).
--
-- ## The two columns on Subjects
--
-- `nationalCode` is NULL for every existing row and means "this school subject
-- is outside the national timplan" — mentorstid, elevens val before 2024, a
-- local profile. The coverage page lists those as its first warning and never
-- refuses them; the foreign key only refuses a code that is not a known one.
-- `countsTowardTimplan` defaults TRUE and exists for the subjects a school
-- schedules but which are not undervisning in the statute's sense (Resurs,
-- Studiehandledning): a row with it FALSE is excluded from every sum. Neither
-- changes what any existing school sees until somebody sets one.

CREATE TYPE "SchoolForm" AS ENUM (
    'GRUNDSKOLA',
    'ANPASSAD_GRUNDSKOLA_AMNEN',
    'ANPASSAD_GRUNDSKOLA_AMNESOMRADEN',
    'SPECIALSKOLA',
    'SAMESKOLA'
);

CREATE TYPE "TimplanStage" AS ENUM ('LAG', 'MELLAN', 'HOG', 'LAG_MELLAN');

-- ---------------------------------------------------------------------------
-- One row per bilaga per lydelse, plus the enacted-but-undistributed law.
-- ---------------------------------------------------------------------------

CREATE TABLE "NationalTimplanVersions" (
    "id"                    UUID           NOT NULL DEFAULT gen_random_uuid(),
    -- 'SFS2023:945/B1': the författning the figures are the lydelse of, and
    -- the bilaga. Three bilagor share SFS 2023:945, so the SFS alone is not a
    -- key. The 2028 row has no bilaga yet and so no suffix.
    "code"                  TEXT           NOT NULL,
    "sfs"                   TEXT           NOT NULL,
    "title"                 TEXT           NOT NULL,
    "schoolForm"            "SchoolForm"   NOT NULL,
    "totalHours"            INTEGER        NOT NULL,
    -- "Därav skolans val". NULL where the bilaga prints no such row
    -- (ämnesområden) or the fördelning is not yet written.
    "skolansValHours"       INTEGER,
    -- "minskas med högst 20 procent" (15 in sameskolan). NULL where the
    -- statute states no percentage (anpassade grundskolan, the 2028 law).
    "reductionCapPercent"   INTEGER,
    -- 'HT2024': the term from which utbildning som påbörjas falls under this
    -- lydelse. Cohort-scoped, not calendar-scoped — see the preamble.
    "appliesFromCohortTerm" TEXT           NOT NULL,
    "supersededByCode"      TEXT,
    "createdAt"             TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "NationalTimplanVersions_pkey" PRIMARY KEY ("id"),

    CONSTRAINT "NationalTimplanVersions_code_is_not_blank" CHECK (btrim("code") <> ''),
    CONSTRAINT "NationalTimplanVersions_totalHours_is_positive" CHECK ("totalHours" > 0),
    CONSTRAINT "NationalTimplanVersions_skolansVal_fits" CHECK (
        "skolansValHours" IS NULL
        OR ("skolansValHours" >= 0 AND "skolansValHours" <= "totalHours")
    ),
    -- The two percentages the bilagor print, and no other: a cap typed as 2
    -- or 200 is a transcription error, not a new rule.
    CONSTRAINT "NationalTimplanVersions_reductionCap_is_statutory" CHECK (
        "reductionCapPercent" IS NULL OR "reductionCapPercent" IN (15, 20)
    ),
    CONSTRAINT "NationalTimplanVersions_cohortTerm_is_a_term" CHECK (
        "appliesFromCohortTerm" ~ '^(HT|VT)[0-9]{4}$'
    ),
    CONSTRAINT "NationalTimplanVersions_does_not_supersede_itself" CHECK (
        "supersededByCode" IS NULL OR "supersededByCode" <> "code"
    )
);

CREATE UNIQUE INDEX "NationalTimplanVersions_code_key" ON "NationalTimplanVersions"("code");

ALTER TABLE "NationalTimplanVersions"
    ADD CONSTRAINT "NationalTimplanVersions_supersededByCode_fkey"
    FOREIGN KEY ("supersededByCode") REFERENCES "NationalTimplanVersions"("code")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- The ämnen the bilagor name, with the two ämnesgrupper as parents.
-- ---------------------------------------------------------------------------

CREATE TABLE "NationalSubjects" (
    "code"       TEXT    NOT NULL,
    "name"       TEXT    NOT NULL,
    "parentCode" TEXT,
    "isGroup"    BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "NationalSubjects_pkey" PRIMARY KEY ("code"),

    -- Codes are what Subject.nationalCode and the import CSV carry, so they
    -- are kept to a shape a CSV cannot mangle: upper-case ASCII, digits and
    -- underscore. 'SV_SVA' and 'M2' fit; 'Bi' and 'Rörelse' do not.
    CONSTRAINT "NationalSubjects_code_is_a_code" CHECK ("code" ~ '^[A-Z][A-Z0-9_]*$'),
    CONSTRAINT "NationalSubjects_name_is_not_blank" CHECK (btrim("name") <> ''),
    -- One level: a group is not inside another group. That a parent IS a group
    -- is a cross-row fact and is asserted in the self-check instead.
    CONSTRAINT "NationalSubjects_group_has_no_parent" CHECK (
        NOT ("isGroup" AND "parentCode" IS NOT NULL)
    ),
    CONSTRAINT "NationalSubjects_is_not_its_own_parent" CHECK (
        "parentCode" IS NULL OR "parentCode" <> "code"
    )
);

ALTER TABLE "NationalSubjects"
    ADD CONSTRAINT "NationalSubjects_parentCode_fkey"
    FOREIGN KEY ("parentCode") REFERENCES "NationalSubjects"("code")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- One row per printed cell.
-- ---------------------------------------------------------------------------

CREATE TABLE "NationalTimplanEntries" (
    "id"                     UUID           NOT NULL DEFAULT gen_random_uuid(),
    "versionId"              UUID           NOT NULL,
    "subjectCode"            TEXT           NOT NULL,
    "stage"                  "TimplanStage" NOT NULL,
    "hours"                  INTEGER        NOT NULL,
    "minimumHoursPerChild"   INTEGER,
    "protectedFromReduction" BOOLEAN        NOT NULL DEFAULT false,

    CONSTRAINT "NationalTimplanEntries_pkey" PRIMARY KEY ("id"),

    CONSTRAINT "NationalTimplanEntries_hours_is_not_negative" CHECK ("hours" >= 0),
    CONSTRAINT "NationalTimplanEntries_minimum_fits_the_cell" CHECK (
        "minimumHoursPerChild" IS NULL
        OR ("minimumHoursPerChild" > 0 AND "minimumHoursPerChild" <= "hours")
    )
);

CREATE UNIQUE INDEX "NationalTimplanEntries_versionId_subjectCode_stage_key"
    ON "NationalTimplanEntries"("versionId", "subjectCode", "stage");

ALTER TABLE "NationalTimplanEntries"
    ADD CONSTRAINT "NationalTimplanEntries_versionId_fkey"
    FOREIGN KEY ("versionId") REFERENCES "NationalTimplanVersions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NationalTimplanEntries"
    ADD CONSTRAINT "NationalTimplanEntries_subjectCode_fkey"
    FOREIGN KEY ("subjectCode") REFERENCES "NationalSubjects"("code")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Subjects: which national cell, and whether it is undervisning at all.
-- Existing rows become (NULL, true) and nothing they feed changes.
-- ---------------------------------------------------------------------------

ALTER TABLE "Subjects"
    ADD COLUMN "nationalCode"        TEXT,
    ADD COLUMN "countsTowardTimplan" BOOLEAN NOT NULL DEFAULT true;

-- RESTRICT, not SET NULL: a national code is never deleted, and if one ever
-- were, silently unmapping every school's subject is the wrong answer.
ALTER TABLE "Subjects"
    ADD CONSTRAINT "Subjects_nationalCode_fkey"
    FOREIGN KEY ("nationalCode") REFERENCES "NationalSubjects"("code")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security: read by every signed-in role, written by none.
--
-- No tenant predicate, because there is no tenant. The one thing USING asks is
-- that the caller resolves to an ACTIVE user at all. Not for secrecy — the
-- statute is public — but because this schema's reading of "deactivated" is
-- "sees nothing", asserted table by table in section 9 of
-- scripts/test/rls-policies.sql, and a table that let a revoked token keep
-- reading would be the first exception to a rule that has none. The same
-- predicate makes a transaction with no principal read nothing here, as it
-- does everywhere else (section 1); the gateway reads under withRls as the
-- signed-in user and the web through PostgREST as the same, so nothing that
-- needs the statute runs without one.
--
-- FOR SELECT only: with no INSERT/UPDATE/DELETE policy, row security admits no
-- row to a write even where a grant would allow the statement — and the grants
-- are taken away below as well, so the refusal is a loud 42501 rather than a
-- silent zero rows.
-- ---------------------------------------------------------------------------

ALTER TABLE "NationalTimplanVersions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NationalSubjects"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NationalTimplanEntries"  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "national_timplan_versions_select" ON "NationalTimplanVersions"
    FOR SELECT TO "authenticated" USING ((select app.current_user_id()) IS NOT NULL);

CREATE POLICY "national_subjects_select" ON "NationalSubjects"
    FOR SELECT TO "authenticated" USING ((select app.current_user_id()) IS NOT NULL);

CREATE POLICY "national_timplan_entries_select" ON "NationalTimplanEntries"
    FOR SELECT TO "authenticated" USING ((select app.current_user_id()) IS NOT NULL);

-- 20260806000000's ALTER DEFAULT PRIVILEGES hands every table this migration
-- creates SELECT, INSERT, UPDATE, DELETE for "authenticated" and
-- "service_role" the moment CREATE TABLE runs. That default is right for a
-- school's tables and wrong for the statute, so the write half is taken back
-- here and SELECT re-granted explicitly. Guarded per role like 20260914180000:
-- a bare Postgres lacks anon and service_role, the local compose DB alone has
-- app_authenticated, and a REVOKE naming a missing role fails the deploy.
-- service_role bypasses row security, which is exactly why its write grant
-- must go — the missing grant is the only thing between it and the table.
-- anon keeps nothing: PostgREST's token-less request has no reason to read
-- the timplan.
DO $$
DECLARE
  tbl      text;
  api_role text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['NationalTimplanVersions', 'NationalSubjects', 'NationalTimplanEntries']
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', tbl);
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated']
    LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
        EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', tbl, api_role);
        IF api_role <> 'anon' THEN
          EXECUTE format('GRANT SELECT ON TABLE %I TO %I', tbl, api_role);
        END IF;
      END IF;
    END LOOP;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- The ämnen. Codes follow Skolverket's abbreviations where one is in common
-- use (MA, SV, EN, IDH, HKK, SL, TK, BL, MU, NO/BI/FY/KE, SO/GE/HI/RE/SH, M2);
-- the rest are this schema's own and stated here once.
-- ---------------------------------------------------------------------------

INSERT INTO "NationalSubjects" ("code", "name", "parentCode", "isGroup") VALUES
    ('BL',     'Bild',                                  NULL, false),
    ('EN',     'Engelska',                              NULL, false),
    ('HKK',    'Hem- och konsumentkunskap',             NULL, false),
    ('IDH',    'Idrott och hälsa',                      NULL, false),
    ('MA',     'Matematik',                             NULL, false),
    ('MU',     'Musik',                                 NULL, false),
    ('NO',     'Naturorienterande ämnen',               NULL, true),
    ('BI',     'Biologi',                               'NO', false),
    ('FY',     'Fysik',                                 'NO', false),
    ('KE',     'Kemi',                                  'NO', false),
    ('SO',     'Samhällsorienterande ämnen',            NULL, true),
    ('GE',     'Geografi',                              'SO', false),
    ('HI',     'Historia',                              'SO', false),
    ('RE',     'Religionskunskap',                      'SO', false),
    ('SH',     'Samhällskunskap',                       'SO', false),
    ('SL',     'Slöjd',                                 NULL, false),
    ('SV_SVA', 'Svenska eller svenska som andraspråk',  NULL, false),
    ('TK',     'Teknik',                                NULL, false),
    ('M2',     'Språkval',                              NULL, false),
    -- Specialskolan only.
    ('TSP',    'Teckenspråk',                           NULL, false),
    ('ROD',    'Rörelse och drama',                     NULL, false),
    -- Sameskolan only.
    ('SAM',    'Samiska',                               NULL, false),
    -- Anpassade grundskolan, elever som läser ämnesområden.
    ('EST',    'Estetisk verksamhet',                   NULL, false),
    ('KOM',    'Kommunikation',                         NULL, false),
    ('MOT',    'Motorik',                               NULL, false),
    ('VAR',    'Vardagsaktiviteter',                    NULL, false),
    ('VER',    'Verklighetsuppfattning',                NULL, false),
    ('FORDELNINGSBAR', 'Fördelningsbar undervisningstid', NULL, false);

-- ---------------------------------------------------------------------------
-- The versions. The 2028 law first, so the current bilaga 1 can point at it.
-- ---------------------------------------------------------------------------

INSERT INTO "NationalTimplanVersions"
    ("code", "sfs", "title", "schoolForm", "totalHours", "skolansValHours",
     "reductionCapPercent", "appliesFromCohortTerm", "supersededByCode")
VALUES
    ('SFS2025:729', '2025:729',
     'Skollagen 10 kap. 5 § i lydelse enligt lag (2025:729) – tioårig grundskola; fördelningen (bilaga 1) är inte publicerad',
     'GRUNDSKOLA', 7424, NULL, NULL, 'HT2028', NULL),

    ('SFS2023:945/B1', '2023:945',
     'Skolförordningen (2011:185) bilaga 1, timplan för grundskolan, i lydelse enligt SFS 2023:945',
     'GRUNDSKOLA', 6890, 600, 20, 'HT2024', 'SFS2025:729'),

    ('SFS2022:1619/B2A', '2022:1619',
     'Skolförordningen (2011:185) bilaga 2, timplan för anpassade grundskolan – elever som läser ämnen, i lydelse enligt SFS 2022:1619',
     'ANPASSAD_GRUNDSKOLA_AMNEN', 6890, 1800, NULL, 'HT2023', NULL),

    ('SFS2022:1619/B2B', '2022:1619',
     'Skolförordningen (2011:185) bilaga 2, timplan för anpassade grundskolan – elever som läser ämnesområden, i lydelse enligt SFS 2022:1619',
     'ANPASSAD_GRUNDSKOLA_AMNESOMRADEN', 6665, NULL, NULL, 'HT2023', NULL),

    ('SFS2023:945/B3', '2023:945',
     'Skolförordningen (2011:185) bilaga 3, timplan för specialskolan, i lydelse enligt SFS 2023:945',
     'SPECIALSKOLA', 8070, 600, 20, 'HT2024', NULL),

    ('SFS2023:945/B4', '2023:945',
     'Skolförordningen (2011:185) bilaga 4, timplan för sameskolan, i lydelse enligt SFS 2023:945',
     'SAMESKOLA', 4473, 210, 15, 'HT2024', NULL);

-- ---------------------------------------------------------------------------
-- The cells, bilaga by bilaga, in the order the statute prints the rows.
-- Columns: code, stage, hours, minimumHoursPerChild, protectedFromReduction.
-- ---------------------------------------------------------------------------

-- Bilaga 1 — grundskolan. Totalt 1 882 / 2 334 / 40 / 2 634 = 6 890.
INSERT INTO "NationalTimplanEntries"
    ("versionId", "subjectCode", "stage", "hours", "minimumHoursPerChild", "protectedFromReduction")
SELECT v.id, e.code, e.stage::"TimplanStage", e.hours, e.minimum, e.protected
FROM "NationalTimplanVersions" v
CROSS JOIN (VALUES
    ('BL',     'LAG',        60, NULL, false),
    ('BL',     'MELLAN',     80, NULL, false),
    ('BL',     'HOG',       100, NULL, false),
    ('EN',     'LAG',        60, NULL, true),
    ('EN',     'MELLAN',    220, NULL, true),
    ('EN',     'HOG',       200, NULL, true),
    ('HKK',    'LAG_MELLAN', 40, NULL, false),
    ('HKK',    'HOG',        90, NULL, false),
    ('IDH',    'LAG',       140, NULL, false),
    ('IDH',    'MELLAN',    180, NULL, false),
    ('IDH',    'HOG',       280, NULL, false),
    ('MA',     'LAG',       420, NULL, true),
    ('MA',     'MELLAN',    410, NULL, true),
    ('MA',     'HOG',       400, NULL, true),
    ('MU',     'LAG',        80, NULL, false),
    ('MU',     'MELLAN',     80, NULL, false),
    ('MU',     'HOG',        80, NULL, false),
    ('NO',     'LAG',       145, NULL, false),
    ('NO',     'MELLAN',    216,   60, false),
    ('NO',     'HOG',       289,   80, false),
    ('BI',     'MELLAN',     60, NULL, false),
    ('BI',     'HOG',        80, NULL, false),
    ('FY',     'MELLAN',     60, NULL, false),
    ('FY',     'HOG',        80, NULL, false),
    ('KE',     'MELLAN',     60, NULL, false),
    ('KE',     'HOG',        80, NULL, false),
    ('SO',     'LAG',       200, NULL, false),
    ('SO',     'MELLAN',    375, NULL, false),
    ('SO',     'HOG',       405, NULL, false),
    ('GE',     'MELLAN',     75, NULL, false),
    ('GE',     'HOG',        80, NULL, false),
    ('HI',     'MELLAN',     90, NULL, false),
    ('HI',     'HOG',       100, NULL, false),
    ('RE',     'MELLAN',     75, NULL, false),
    ('RE',     'HOG',        80, NULL, false),
    ('SH',     'MELLAN',     75, NULL, false),
    ('SH',     'HOG',        90, NULL, false),
    ('SL',     'LAG',        50, NULL, false),
    ('SL',     'MELLAN',    140, NULL, false),
    ('SL',     'HOG',       140, NULL, false),
    ('SV_SVA', 'LAG',       680, NULL, true),
    ('SV_SVA', 'MELLAN',    520, NULL, true),
    ('SV_SVA', 'HOG',       290, NULL, true),
    ('TK',     'LAG',        47, NULL, false),
    ('TK',     'MELLAN',     65, NULL, false),
    ('TK',     'HOG',        88, NULL, false),
    ('M2',     'MELLAN',     48, NULL, true),
    ('M2',     'HOG',       272, NULL, true)
) AS e(code, stage, hours, minimum, protected)
WHERE v.code = 'SFS2023:945/B1';

-- Bilaga 2, ämnen — anpassade grundskolan. Totalt 1 860 / 2 141 / 230 / 2 659
-- = 6 890. No per-child minima, no percentage, no protected subject.
INSERT INTO "NationalTimplanEntries"
    ("versionId", "subjectCode", "stage", "hours", "minimumHoursPerChild", "protectedFromReduction")
SELECT v.id, e.code, e.stage::"TimplanStage", e.hours, NULL, false
FROM "NationalTimplanVersions" v
CROSS JOIN (VALUES
    ('BL',     'LAG',        60),
    ('BL',     'MELLAN',     75),
    ('BL',     'HOG',        90),
    ('HKK',    'LAG_MELLAN', 230),
    ('HKK',    'HOG',       295),
    ('IDH',    'LAG',       245),
    ('IDH',    'MELLAN',    245),
    ('IDH',    'HOG',       260),
    ('MU',     'LAG',       120),
    ('MU',     'MELLAN',    125),
    ('MU',     'HOG',       150),
    ('SL',     'LAG',       175),
    ('SL',     'MELLAN',    260),
    ('SL',     'HOG',       235),
    ('SV_SVA', 'LAG',       450),
    ('SV_SVA', 'MELLAN',    450),
    ('SV_SVA', 'HOG',       400),
    ('EN',     'LAG',        35),
    ('EN',     'MELLAN',     55),
    ('EN',     'HOG',        90),
    ('MA',     'LAG',       400),
    ('MA',     'MELLAN',    400),
    ('MA',     'HOG',       415),
    ('NO',     'LAG',       145),
    ('NO',     'MELLAN',    216),
    ('NO',     'HOG',       289),
    ('SO',     'LAG',       185),
    ('SO',     'MELLAN',    255),
    ('SO',     'HOG',       350),
    ('TK',     'LAG',        45),
    ('TK',     'MELLAN',     60),
    ('TK',     'HOG',        85)
) AS e(code, stage, hours)
WHERE v.code = 'SFS2022:1619/B2A';

-- Bilaga 2, ämnesområden — anpassade grundskolan. Totalt 1 875 / 2 340 /
-- 2 450 = 6 665. No skolans val row; the free time is a printed cell.
INSERT INTO "NationalTimplanEntries"
    ("versionId", "subjectCode", "stage", "hours", "minimumHoursPerChild", "protectedFromReduction")
SELECT v.id, e.code, e.stage::"TimplanStage", e.hours, NULL, false
FROM "NationalTimplanVersions" v
CROSS JOIN (VALUES
    ('EST', 'LAG',    315), ('EST', 'MELLAN', 340), ('EST', 'HOG', 360),
    ('KOM', 'LAG',    315), ('KOM', 'MELLAN', 340), ('KOM', 'HOG', 360),
    ('MOT', 'LAG',    315), ('MOT', 'MELLAN', 340), ('MOT', 'HOG', 360),
    ('VAR', 'LAG',    315), ('VAR', 'MELLAN', 340), ('VAR', 'HOG', 360),
    ('VER', 'LAG',    315), ('VER', 'MELLAN', 340), ('VER', 'HOG', 360),
    ('FORDELNINGSBAR', 'LAG', 300), ('FORDELNINGSBAR', 'MELLAN', 640), ('FORDELNINGSBAR', 'HOG', 650)
) AS e(code, stage, hours)
WHERE v.code = 'SFS2022:1619/B2B';

-- Bilaga 3 — specialskolan. Totalt 2 788 / 2 496 / 50 / 2 736 = 8 070.
INSERT INTO "NationalTimplanEntries"
    ("versionId", "subjectCode", "stage", "hours", "minimumHoursPerChild", "protectedFromReduction")
SELECT v.id, e.code, e.stage::"TimplanStage", e.hours, e.minimum, e.protected
FROM "NationalTimplanVersions" v
CROSS JOIN (VALUES
    ('BL',     'LAG',        70, NULL, false),
    ('BL',     'MELLAN',     90, NULL, false),
    ('BL',     'HOG',        90, NULL, false),
    ('HKK',    'LAG_MELLAN', 50, NULL, false),
    ('HKK',    'HOG',        80, NULL, false),
    ('IDH',    'LAG',       190, NULL, false),
    ('IDH',    'MELLAN',    180, NULL, false),
    ('IDH',    'HOG',       270, NULL, false),
    ('ROD',    'LAG',        90, NULL, false),
    ('ROD',    'MELLAN',     80, NULL, false),
    ('ROD',    'HOG',        75, NULL, false),
    ('SL',     'LAG',        85, NULL, false),
    ('SL',     'MELLAN',    140, NULL, false),
    ('SL',     'HOG',       125, NULL, false),
    ('TSP',    'LAG',       320, NULL, false),
    ('TSP',    'MELLAN',    205, NULL, false),
    ('TSP',    'HOG',       200, NULL, false),
    ('SV_SVA', 'LAG',       780, NULL, true),
    ('SV_SVA', 'MELLAN',    500, NULL, true),
    ('SV_SVA', 'HOG',       280, NULL, true),
    ('EN',     'LAG',        95, NULL, true),
    ('EN',     'MELLAN',    220, NULL, true),
    ('EN',     'HOG',       200, NULL, true),
    ('MA',     'LAG',       560, NULL, true),
    ('MA',     'MELLAN',    410, NULL, true),
    ('MA',     'HOG',       400, NULL, true),
    ('SO',     'LAG',       319, NULL, false),
    ('SO',     'MELLAN',    342, NULL, false),
    ('SO',     'HOG',       400, NULL, false),
    ('GE',     'MELLAN',     65, NULL, false),
    ('GE',     'HOG',        80, NULL, false),
    ('HI',     'MELLAN',     75, NULL, false),
    ('HI',     'HOG',       100, NULL, false),
    ('RE',     'MELLAN',     65, NULL, false),
    ('RE',     'HOG',        80, NULL, false),
    ('SH',     'MELLAN',     65, NULL, false),
    ('SH',     'HOG',        90, NULL, false),
    ('NO',     'LAG',       227, NULL, false),
    ('NO',     'MELLAN',    216,   60, false),
    ('NO',     'HOG',       261,   70, false),
    ('BI',     'MELLAN',     60, NULL, false),
    ('BI',     'HOG',        70, NULL, false),
    ('FY',     'MELLAN',     60, NULL, false),
    ('FY',     'HOG',        70, NULL, false),
    ('KE',     'MELLAN',     60, NULL, false),
    ('KE',     'HOG',        70, NULL, false),
    ('TK',     'LAG',        52, NULL, false),
    ('TK',     'MELLAN',     65, NULL, false),
    ('TK',     'HOG',        83, NULL, false),
    ('M2',     'MELLAN',     48, NULL, true),
    ('M2',     'HOG',       272, NULL, true)
) AS e(code, stage, hours, minimum, protected)
WHERE v.code = 'SFS2023:945/B3';

-- Bilaga 4 — sameskolan, åk 1–6 so no högstadium. Totalt 1 890 / 2 533 / 50
-- = 4 473. Samiska is protected alongside the usual four; the cap is 15 %.
INSERT INTO "NationalTimplanEntries"
    ("versionId", "subjectCode", "stage", "hours", "minimumHoursPerChild", "protectedFromReduction")
SELECT v.id, e.code, e.stage::"TimplanStage", e.hours, e.minimum, e.protected
FROM "NationalTimplanVersions" v
CROSS JOIN (VALUES
    ('BL',     'LAG',        60, NULL, false),
    ('BL',     'MELLAN',     80, NULL, false),
    ('HKK',    'LAG_MELLAN', 50, NULL, false),
    ('IDH',    'LAG',       150, NULL, false),
    ('IDH',    'MELLAN',    160, NULL, false),
    ('MU',     'LAG',        60, NULL, false),
    ('MU',     'MELLAN',     60, NULL, false),
    ('SL',     'LAG',        60, NULL, false),
    ('SL',     'MELLAN',    130, NULL, false),
    ('SV_SVA', 'LAG',       400, NULL, true),
    ('SV_SVA', 'MELLAN',    510, NULL, true),
    ('EN',     'LAG',        60, NULL, true),
    ('EN',     'MELLAN',    220, NULL, true),
    ('MA',     'LAG',       420, NULL, true),
    ('MA',     'MELLAN',    410, NULL, true),
    ('SO',     'LAG',       130, NULL, false),
    ('SO',     'MELLAN',    270, NULL, false),
    ('GE',     'MELLAN',     60, NULL, false),
    ('HI',     'MELLAN',     70, NULL, false),
    ('RE',     'MELLAN',     60, NULL, false),
    ('SH',     'MELLAN',     60, NULL, false),
    ('NO',     'LAG',       110, NULL, false),
    ('NO',     'MELLAN',    200,   55, false),
    ('BI',     'MELLAN',     55, NULL, false),
    ('FY',     'MELLAN',     55, NULL, false),
    ('KE',     'MELLAN',     55, NULL, false),
    ('SAM',    'LAG',       400, NULL, true),
    ('SAM',    'MELLAN',    400, NULL, true),
    ('M2',     'MELLAN',     48, NULL, true),
    ('TK',     'LAG',        40, NULL, false),
    ('TK',     'MELLAN',     45, NULL, false)
) AS e(code, stage, hours, minimum, protected)
WHERE v.code = 'SFS2023:945/B4';

-- ---------------------------------------------------------------------------
-- Self-check: the statute, read a second time, against the rows above.
--
-- Each block below is a figure the bilagor PRINT — a column total, a "Totalt
-- garanterat antal timmar", a "Resterande N timmar", a sentence of protected
-- names — re-typed here independently of the cells. A cell mistyped above
-- fails against its printed total; a total mistyped above fails against its
-- cells. RAISE aborts the transaction `prisma migrate deploy` runs this file
-- in, so a transcription error is a failed deploy, never a shipped one.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  r     record;
  got   integer;
  n     integer;
  found text[];
BEGIN
  -- 0. The hierarchy is one level deep and every parent is a group.
  SELECT count(*) INTO n
    FROM "NationalSubjects" c JOIN "NationalSubjects" p ON p.code = c."parentCode"
   WHERE NOT p."isGroup";
  IF n <> 0 THEN
    RAISE EXCEPTION 'timplan: % national subject(s) have a parent that is not an ämnesgrupp', n;
  END IF;

  -- 1. Exactly five versions carry cells, and the sixth (the 2028 law) none.
  SELECT count(DISTINCT "versionId") INTO n FROM "NationalTimplanEntries";
  IF n <> 5 THEN
    RAISE EXCEPTION 'timplan: % version(s) have cells, expected the five bilagor', n;
  END IF;
  SELECT count(*) INTO n FROM "NationalTimplanEntries" e
    JOIN "NationalTimplanVersions" v ON v.id = e."versionId"
   WHERE v.code = 'SFS2025:729';
  IF n <> 0 THEN
    RAISE EXCEPTION 'timplan: the 2028 law has % cell(s) but its fördelning is not published', n;
  END IF;

  -- 2. Totalt garanterat antal timmar: top-level cells only, children not
  --    added again, equals the version's own totalHours.
  FOR r IN
    SELECT v.code, v."totalHours", sum(e.hours)::integer AS seeded
      FROM "NationalTimplanVersions" v
      JOIN "NationalTimplanEntries" e ON e."versionId" = v.id
      JOIN "NationalSubjects" s ON s.code = e."subjectCode"
     WHERE s."parentCode" IS NULL
     GROUP BY v.code, v."totalHours"
  LOOP
    IF r.seeded <> r."totalHours" THEN
      RAISE EXCEPTION 'timplan %: cells sum to % h, the statute says % h',
        r.code, r.seeded, r."totalHours";
    END IF;
  END LOOP;

  -- 3. The printed column total of every stadium.
  FOR r IN
    SELECT * FROM (VALUES
      ('SFS2023:945/B1',   'LAG',        1882), ('SFS2023:945/B1',   'MELLAN', 2334),
      ('SFS2023:945/B1',   'LAG_MELLAN',   40), ('SFS2023:945/B1',   'HOG',    2634),
      ('SFS2022:1619/B2A', 'LAG',        1860), ('SFS2022:1619/B2A', 'MELLAN', 2141),
      ('SFS2022:1619/B2A', 'LAG_MELLAN',  230), ('SFS2022:1619/B2A', 'HOG',    2659),
      ('SFS2022:1619/B2B', 'LAG',        1875), ('SFS2022:1619/B2B', 'MELLAN', 2340),
      ('SFS2022:1619/B2B', 'LAG_MELLAN',    0), ('SFS2022:1619/B2B', 'HOG',    2450),
      ('SFS2023:945/B3',   'LAG',        2788), ('SFS2023:945/B3',   'MELLAN', 2496),
      ('SFS2023:945/B3',   'LAG_MELLAN',   50), ('SFS2023:945/B3',   'HOG',    2736),
      ('SFS2023:945/B4',   'LAG',        1890), ('SFS2023:945/B4',   'MELLAN', 2533),
      ('SFS2023:945/B4',   'LAG_MELLAN',   50), ('SFS2023:945/B4',   'HOG',       0)
    ) AS t(code, stage, total)
  LOOP
    SELECT coalesce(sum(e.hours), 0)::integer INTO got
      FROM "NationalTimplanEntries" e
      JOIN "NationalTimplanVersions" v ON v.id = e."versionId"
      JOIN "NationalSubjects" s ON s.code = e."subjectCode"
     WHERE v.code = r.code AND e.stage = r.stage::"TimplanStage" AND s."parentCode" IS NULL;
    IF got <> r.total THEN
      RAISE EXCEPTION 'timplan % %: column sums to % h, the statute prints % h',
        r.code, r.stage, got, r.total;
    END IF;
  END LOOP;

  -- 4. Every ämnesgrupp cell that has children: the children are all there,
  --    each minimum fits, and what is left is the printed "Resterande N
  --    timmar får fördelas fritt". Where the prose states one uniform minimum,
  --    minimumHoursPerChild carries it and every child's line agrees.
  FOR r IN
    SELECT * FROM (VALUES
      ('SFS2023:945/B1', 'NO', 'MELLAN', 36), ('SFS2023:945/B1', 'NO', 'HOG', 49),
      ('SFS2023:945/B1', 'SO', 'MELLAN', 60), ('SFS2023:945/B1', 'SO', 'HOG', 55),
      ('SFS2023:945/B3', 'NO', 'MELLAN', 36), ('SFS2023:945/B3', 'NO', 'HOG', 51),
      ('SFS2023:945/B3', 'SO', 'MELLAN', 72), ('SFS2023:945/B3', 'SO', 'HOG', 50),
      ('SFS2023:945/B4', 'NO', 'MELLAN', 35), ('SFS2023:945/B4', 'SO', 'MELLAN', 20)
    ) AS t(code, grp, stage, remainder)
  LOOP
    got := NULL; n := 0;
    SELECT (g.hours - coalesce(sum(c.hours), 0))::integer, count(c.id)::integer
      INTO got, n
      FROM "NationalTimplanVersions" v
      JOIN "NationalTimplanEntries" g ON g."versionId" = v.id
       AND g."subjectCode" = r.grp AND g.stage = r.stage::"TimplanStage"
      LEFT JOIN "NationalSubjects" cs ON cs."parentCode" = r.grp
      LEFT JOIN "NationalTimplanEntries" c ON c."versionId" = v.id
       AND c."subjectCode" = cs.code AND c.stage = g.stage
     WHERE v.code = r.code
     GROUP BY g.hours;
    IF got IS NULL THEN
      RAISE EXCEPTION 'timplan % % %: the ämnesgrupp cell is missing', r.code, r.grp, r.stage;
    END IF;
    IF n <> (SELECT count(*) FROM "NationalSubjects" WHERE "parentCode" = r.grp) THEN
      RAISE EXCEPTION 'timplan % % %: % child line(s), the group has % ämnen',
        r.code, r.grp, r.stage, n, (SELECT count(*) FROM "NationalSubjects" WHERE "parentCode" = r.grp);
    END IF;
    IF got <> r.remainder THEN
      RAISE EXCEPTION 'timplan % % %: % h left after the minima, the statute says "resterande % timmar"',
        r.code, r.grp, r.stage, got, r.remainder;
    END IF;
  END LOOP;

  -- 4a. And no ämnesgrupp cell has children the list above does not name: a
  --     child line the statute does not print would otherwise pass unseen.
  --     Five NO cells × 3 ämnen + five SO cells × 4 ämnen = 35 child lines.
  SELECT count(*) INTO n
    FROM "NationalTimplanEntries" c
    JOIN "NationalSubjects" s ON s.code = c."subjectCode" AND s."parentCode" IS NOT NULL;
  IF n <> 35 THEN
    RAISE EXCEPTION 'timplan: % child line(s) seeded, the ten NO/SO cells print 35', n;
  END IF;

  -- 4b. minimumHoursPerChild agrees with every child line where it is set,
  --     and is never set on a cell without children.
  SELECT count(*) INTO n
    FROM "NationalTimplanEntries" g
    JOIN "NationalSubjects" cs ON cs."parentCode" = g."subjectCode"
    JOIN "NationalTimplanEntries" c ON c."versionId" = g."versionId"
     AND c."subjectCode" = cs.code AND c.stage = g.stage
   WHERE g."minimumHoursPerChild" IS NOT NULL AND c.hours <> g."minimumHoursPerChild";
  IF n <> 0 THEN
    RAISE EXCEPTION 'timplan: % child line(s) disagree with their group''s minimumHoursPerChild', n;
  END IF;
  SELECT count(*) INTO n
    FROM "NationalTimplanEntries" g
    JOIN "NationalSubjects" s ON s.code = g."subjectCode"
   WHERE g."minimumHoursPerChild" IS NOT NULL AND NOT s."isGroup";
  IF n <> 0 THEN
    RAISE EXCEPTION 'timplan: % leaf cell(s) carry a per-child minimum', n;
  END IF;

  -- 4c. No child line without its group's cell in the same version and stage.
  SELECT count(*) INTO n
    FROM "NationalTimplanEntries" c
    JOIN "NationalSubjects" s ON s.code = c."subjectCode" AND s."parentCode" IS NOT NULL
   WHERE NOT EXISTS (
     SELECT 1 FROM "NationalTimplanEntries" g
      WHERE g."versionId" = c."versionId" AND g."subjectCode" = s."parentCode" AND g.stage = c.stage);
  IF n <> 0 THEN
    RAISE EXCEPTION 'timplan: % child line(s) have no ämnesgrupp cell above them', n;
  END IF;

  -- 5. A merged "Låg- och mellanstadiet" cell excludes separate ones.
  SELECT count(*) INTO n
    FROM "NationalTimplanEntries" a
    JOIN "NationalTimplanEntries" b ON b."versionId" = a."versionId"
     AND b."subjectCode" = a."subjectCode" AND b.stage IN ('LAG', 'MELLAN')
   WHERE a.stage = 'LAG_MELLAN';
  IF n <> 0 THEN
    RAISE EXCEPTION 'timplan: % cell(s) sit beside a merged låg- och mellanstadiet cell for the same ämne', n;
  END IF;

  -- 6. "Antalet timmar för ... får dock inte minskas": the protected set per
  --    version is exactly the sentence, on every stage row of those ämnen.
  FOR r IN
    SELECT * FROM (VALUES
      ('SFS2023:945/B1',   ARRAY['EN', 'M2', 'MA', 'SV_SVA']),
      ('SFS2022:1619/B2A', ARRAY[]::text[]),
      ('SFS2022:1619/B2B', ARRAY[]::text[]),
      ('SFS2023:945/B3',   ARRAY['EN', 'M2', 'MA', 'SV_SVA']),
      ('SFS2023:945/B4',   ARRAY['EN', 'M2', 'MA', 'SAM', 'SV_SVA']),
      ('SFS2025:729',      ARRAY[]::text[])
    ) AS t(code, protected)
  LOOP
    SELECT coalesce(array_agg(DISTINCT e."subjectCode" ORDER BY e."subjectCode"), '{}') INTO found
      FROM "NationalTimplanEntries" e JOIN "NationalTimplanVersions" v ON v.id = e."versionId"
     WHERE v.code = r.code AND e."protectedFromReduction";
    IF found <> r.protected THEN
      RAISE EXCEPTION 'timplan %: protected ämnen are %, the statute names %', r.code, found, r.protected;
    END IF;
    -- All or none of a protected ämne's rows, never some.
    SELECT count(*) INTO n
      FROM "NationalTimplanEntries" e JOIN "NationalTimplanVersions" v ON v.id = e."versionId"
     WHERE v.code = r.code AND e."subjectCode" = ANY (r.protected) AND NOT e."protectedFromReduction";
    IF n <> 0 THEN
      RAISE EXCEPTION 'timplan %: % row(s) of a protected ämne are not flagged', r.code, n;
    END IF;
  END LOOP;

  -- 7. The cap and the pool are present exactly where the bilaga prints them.
  SELECT count(*) INTO n FROM "NationalTimplanVersions"
   WHERE ("reductionCapPercent" IS NOT NULL) <> (code IN ('SFS2023:945/B1', 'SFS2023:945/B3', 'SFS2023:945/B4'))
      OR ("skolansValHours" IS NOT NULL) <> (code IN ('SFS2023:945/B1', 'SFS2022:1619/B2A', 'SFS2023:945/B3', 'SFS2023:945/B4'));
  IF n <> 0 THEN
    RAISE EXCEPTION 'timplan: % version(s) carry a cap or a skolans val the bilaga does not print, or lack one it does', n;
  END IF;
END
$$;
