-- Ett ämne kan väga mer än sina minuter.
--
-- 20261006100000 gave StaffingPolicies a loadModel, MINUTES or FACTOR, and
-- said the column FACTOR reads would come in Fas 3. This is that column.
-- Skola24's Faktor-modell and Untis' subject factor count a teacher's
-- tjänstgöring as tid × faktor: a school that has agreed that an hour of
-- svenska with its rättning weighs 1.2 and an hour of slöjd in a half class
-- 0.8 states that once per subject, and every teacher's load follows.
--
-- ## Subjects."loadFactor" NUMERIC(4,3) NOT NULL DEFAULT 1.000
--
--   * NOT NULL with a default, so every reader has a weight and no null branch;
--     1.000 is "the minutes as they are". ADD COLUMN with a constant default
--     rewrites no table (PostgreSQL 11+ stores it in the catalog), and every
--     existing subject reads 1.000.
--   * Three decimals: the factors schools publish are 0.6, 0.75, 1.15, 1.333;
--     three places carry all of them, and NUMERIC(4,3) holds 0.000..9.999.
--   * CHECK 0.5..3.0 (Subjects_loadFactor_is_sane), mirroring the DTO. The
--     range holds every published model we found (Vimmerby's 0.6–0.8 for
--     praktisk-estetiska ämnen, Skola24 examples above 1 for heavy-rättning
--     subjects) with room; below a half a lesson is barely counted, which is
--     what teacherLoadPercent per row is for, and above three is a typo. The
--     DTO says the same with a sentence; this answers the PostgREST writer.
--
-- ## Behaviour-neutral, by construction
--
--   * Under MINUTES — every school's default, and every school's choice until
--     an admin changes it — the factor is never read: the load arithmetic's
--     one weight function (teacher-load.ts loadWeightOf) answers 1 and the
--     charge sites skip a multiplication by 1, so every figure is the same
--     double it was. A property test runs the whole fixture under MINUTES with
--     random factors and compares the JSON byte for byte.
--   * A school that saved FACTOR before Fas 3 has every factor at 1.000 here,
--     so its figures do not move until it sets one.
--   * Lektionsminuter — what the pupils sit through, the timplan, SCB's
--     ämnesomfattning (undervisningstid) — are never weighted. The factor
--     reaches only what is charged to a TEACHER.
--
-- The factor is school-wide and not per year: a school that changes one
-- changes every year's FACTOR figures, last year's included, and the change is
-- not in TeacherEmploymentLogs (it is no write to a post). The report says so
-- in a footnote. A group factor (Skola24's "Faktor grupp") is not added: a
-- row's teacherLoadPercent already weighs one (group, subject), and a third
-- multiplier on the same product makes a samverkan figure hard to explain.
--
-- No RLS work: Subjects' policies are row predicates on schoolId and a role,
-- and none names a column.

ALTER TABLE "Subjects" ADD COLUMN "loadFactor" DECIMAL(4,3) NOT NULL DEFAULT 1.000;

ALTER TABLE "Subjects"
    ADD CONSTRAINT "Subjects_loadFactor_is_sane"
    CHECK ("loadFactor" >= 0.5 AND "loadFactor" <= 3.0);
