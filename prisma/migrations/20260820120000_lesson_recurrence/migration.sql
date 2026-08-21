-- Lessons that do not run every week.
--
-- Two needs, one mechanism: a subject taught on alternating weeks (slöjd udda,
-- hemkunskap jämna), and a subject read for only part of the year. Both are
-- properties of the weekly template, and both are applied when the template is
-- materialised into dated lessons.
--
-- Parity is anchored to ISO week numbers, not counted from the start date:
-- "udda veckor" is what a school tells its students, and it means the same
-- thing whenever anyone checks. A count from the start date leaves nobody able
-- to tell from a week number whether a given week is an "on" week.

CREATE TYPE "LessonRecurrence" AS ENUM ('ALL_WEEKS', 'ODD_WEEKS', 'EVEN_WEEKS');

ALTER TABLE "MasterLessons"
    ADD COLUMN "recurrence" "LessonRecurrence" NOT NULL DEFAULT 'ALL_WEEKS',
    ADD COLUMN "startDate" DATE,
    ADD COLUMN "endDate"   DATE;

-- No backfill: every existing lesson runs every week for the whole year, which
-- is exactly what the defaults say. NULL dates mean "the academic year's own
-- start and end", so a school that never touches these sees no change at all.
