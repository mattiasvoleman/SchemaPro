-- Ett ämne fördelar sina lektioner över veckan.
--
-- Every schemaläggare has a sentence like "idrott högst en gång per dag, inte
-- dagar i följd", and the generator could not hear it. The spread objective
-- prices two lessons of one requirement on the same weekday and sells that
-- price for any placement worth more, which is a taste and not a rule — and it
-- has nothing at all to say about Monday and Tuesday. These columns let a
-- school write the rule down, and the engine then holds it as hard as a
-- teacher's clash.
--
-- TWO NUMBERS, BOTH ABOUT DAYS.
--   maxLessonsPerDay  at most this many lessons of a requirement on one weekday
--                     (1 is "inte två gånger samma dag").
--   minDaysBetween    two weekdays that both hold a lesson lie at least this
--                     many days apart (2 is "inte dagar i följd": Monday and
--                     Wednesday, never Monday and Tuesday).
-- They are independent on purpose. Two lessons on one Monday are one lesson
-- day, so the second number says nothing about them; folding "not the same
-- day" into it would leave a school no way to say "a double lesson is fine,
-- but not Monday and Tuesday". Counted in weekdays, never across a weekend:
-- the timetable is one week.
--
-- ON THE SUBJECT, WITH AN OVERRIDE ON THE TIMPLANSPOST. The rule is the
-- subject's in a school's own words — it is idrott that should not come twice a
-- day, whichever class has it — so the subject carries the default, and a
-- school writes it once rather than on forty rows. But one row can need
-- another answer: svenska in year 1 has eight lessons on five days, and "one a
-- day" cannot hold there however the week is laid. So a TeachingRequirement
-- may carry its own rule.
--
-- THE OVERRIDE IS A SWITCH PLUS THE SAME TWO COLUMNS, not two nullable
-- columns that inherit one by one. Inheriting per column reads null as "as the
-- subject says", and then nothing can say "no limit on THIS row although the
-- subject has one" without a sentinel — a 0 that means "unlimited" in one
-- table and is refused in the other, which every reader would have to know
-- about. With the switch, `ownDistribution` false means the subject's rule
-- applies and both columns are empty (a CHECK says so); true means this row's
-- two columns ARE its rule, and null in them means what it means on the
-- subject: none. One reading of null in both tables.
--
-- NULLABLE, NO DEFAULT RULE. School rules are school settings and are off
-- until a school sets them: every existing subject and row reads null, which
-- is "no rule", and every existing week generates exactly as it did. No
-- backfill — nobody has been able to say otherwise until now.
--
-- THE BOUNDS ARE THE ENGINE'S AND THE DTO'S, as CHECKs rather than trust,
-- because PostgREST writes reach both tables without meeting the DTO, and the
-- engine refuses a payload outside them with a 422 for the whole week:
--   maxLessonsPerDay  1..20 — 20 is ScheduleRules' own cap for lessons a day.
--   minDaysBetween    2..6  — 1 says "different days", which every two
--                     lesson days already are, and a week of seven days has
--                     no two days more than six apart.
--
-- BACKWARD COMPATIBLE FOR ONE RELEASE. Three nullable or defaulted columns; an
-- API that predates them neither reads nor writes them, and a row it creates
-- is a row with no rule of its own. The engine accepts payloads without the
-- new keys, and the gateway sends them only for a requirement with a rule.
--
-- No RLS work. Both are existing tables whose policies are row predicates on
-- schoolId and role; none names a column, so the new columns are read and
-- written under exactly the policies the rows already had, through PostgREST
-- as through the gateway. Section 60 of scripts/test/rls-policies.sql holds
-- the CHECKs to that: a school admin's PostgREST write outside the bounds is
-- refused by the table, not by a DTO it never met.

ALTER TABLE "Subjects"
    ADD COLUMN "maxLessonsPerDay" INTEGER,
    ADD COLUMN "minDaysBetween" INTEGER;

ALTER TABLE "Subjects"
    ADD CONSTRAINT "Subjects_max_lessons_per_day_is_sane"
    CHECK ("maxLessonsPerDay" IS NULL OR "maxLessonsPerDay" BETWEEN 1 AND 20);

ALTER TABLE "Subjects"
    ADD CONSTRAINT "Subjects_min_days_between_is_sane"
    CHECK ("minDaysBetween" IS NULL OR "minDaysBetween" BETWEEN 2 AND 6);

ALTER TABLE "TeachingRequirements"
    ADD COLUMN "ownDistribution" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "maxLessonsPerDay" INTEGER,
    ADD COLUMN "minDaysBetween" INTEGER;

ALTER TABLE "TeachingRequirements"
    ADD CONSTRAINT "TeachingRequirements_max_lessons_per_day_is_sane"
    CHECK ("maxLessonsPerDay" IS NULL OR "maxLessonsPerDay" BETWEEN 1 AND 20);

ALTER TABLE "TeachingRequirements"
    ADD CONSTRAINT "TeachingRequirements_min_days_between_is_sane"
    CHECK ("minDaysBetween" IS NULL OR "minDaysBetween" BETWEEN 2 AND 6);

-- A row that follows its subject carries no numbers of its own: a value left
-- behind there would be read by nothing and shown by no screen, and the next
-- switch to "own" would resurrect a rule nobody remembers writing.
ALTER TABLE "TeachingRequirements"
    ADD CONSTRAINT "TeachingRequirements_distribution_is_own_or_absent"
    CHECK ("ownDistribution" OR ("maxLessonsPerDay" IS NULL AND "minDaysBetween" IS NULL));
