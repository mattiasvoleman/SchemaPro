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

CREATE TYPE "TeacherEmploymentForm" AS ENUM ('TILLSVIDARE', 'VISSTID');

ALTER TABLE "TeacherEmployments"
    ADD COLUMN "employmentForm"      "TeacherEmploymentForm",
    ADD COLUMN "firstTeacherPercent" INTEGER,
    ADD COLUMN "lecturerPercent"     INTEGER,
    ADD CONSTRAINT "TeacherEmployments_firstTeacherPercent_check" CHECK ("firstTeacherPercent" BETWEEN 1 AND 100),
    ADD CONSTRAINT "TeacherEmployments_lecturerPercent_check" CHECK ("lecturerPercent" BETWEEN 1 AND 100),
    ADD CONSTRAINT "TeacherEmployments_career_share_check"
        CHECK (coalesce("firstTeacherPercent", 0) + coalesce("lecturerPercent", 0) <= 100);
