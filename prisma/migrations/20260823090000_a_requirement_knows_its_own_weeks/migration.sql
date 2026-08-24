-- The timplan can say which weeks a subject is read, and the optimizer's own
-- output stops being mistaken for handmade work.
--
-- Until now "kemi läses bara på vårterminen" could only be said one lesson at a
-- time, in the master timetable, after the lessons already existed. The
-- requirement is where it belongs: said once, inherited by everything generated
-- from it.
--
-- THE SECOND COLUMN IS WHAT MAKES THE FIRST ONE SAFE.
--
-- Regeneration decides what it may delete. It used to decide by inference: a
-- lesson with default recurrence and no dates looked untouched, so it was
-- treated as the machine's. That reasoning held exactly as long as nothing but
-- a human ever set a recurrence.
--
-- Inheriting the requirement's window breaks it. A generated lesson would carry
-- a window, read as handmade, and be preserved — while the requirement it came
-- from still counted as unmet, so the next run would place another one beside
-- it. Every regeneration another copy, none of them announced anywhere.
--
-- So ownership is stated instead of guessed. The backfill reproduces the old
-- rule exactly rather than improving on it: the rows today's regeneration would
-- delete are the plain ones, and those are the rows that become the machine's.
-- A lesson a human set to odd weeks stays preserved, as it is today. A locked
-- one stays preserved through isLocked, whatever this column says.
--
-- Deliberately not enforced here: that the window falls inside its academic
-- year. That needs a lookup through academicYearId, which a CHECK cannot do,
-- and a trigger for it would fire on a path the service already guards.

ALTER TABLE "TeachingRequirements"
    ADD COLUMN "recurrence" "LessonRecurrence" NOT NULL DEFAULT 'ALL_WEEKS',
    ADD COLUMN "startDate"  DATE,
    ADD COLUMN "endDate"    DATE;

ALTER TABLE "TeachingRequirements"
    ADD CONSTRAINT "TeachingRequirements_period_is_ordered"
    CHECK ("startDate" IS NULL OR "endDate" IS NULL OR "endDate" >= "startDate");

ALTER TABLE "MasterLessons"
    ADD COLUMN "isGenerated" BOOLEAN NOT NULL DEFAULT false;

UPDATE "MasterLessons"
   SET "isGenerated" = true
 WHERE "recurrence" = 'ALL_WEEKS'
   AND "startDate" IS NULL
   AND "endDate" IS NULL;
