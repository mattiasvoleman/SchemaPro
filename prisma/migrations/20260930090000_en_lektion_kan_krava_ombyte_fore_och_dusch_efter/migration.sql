-- En lektion kan kräva ombyte före och dusch efter.
--
-- Idrotten has never fitted the schema. A 60-minute lesson is 60 minutes of
-- teaching and the timetable says so, but the class left its previous lesson ten
-- minutes early to change and arrives at the next one twenty minutes late
-- because it showered. Today the school has two ways to say that, and both are
-- lies: stretch `minutesPerLesson` to 90, and the timplan credits idrotten with
-- thirty minutes of teaching it never gave; or say nothing, and the gateway
-- happily books the class into mathematics while it is still wet.
--
-- These two columns say it instead, and they say it OUTSIDE the lesson. The
-- teaching stays 60. `minutesPerLesson` is untouched, every hour count that
-- reads it keeps the number it had, and what the columns add is the statement
-- that the CHILDREN are occupied from 10 minutes before until 20 minutes after.
-- A school that writes them changes no totals anywhere; it changes who may be
-- booked next to the lesson.
--
-- PER TEACHING REQUIREMENT, which is per (class, subject). The tempting places
-- are both wrong. On the subject, and one number has to fit every class in the
-- school: 4.1 walks from the far corridor and 4.2 from the hall beside the
-- gymnastiksal, and the same idrott genuinely needs different margins for them.
-- Per stage, and it is the årskurs that owns the walk rather than the class that
-- takes it — 7a in the annex and 7b upstairs would share a figure that suits
-- neither. `TeachingRequirements` already holds exactly one row per (läsår,
-- class, subject), which is the grain at which somebody can answer the question,
-- and it is the row the admin is already editing when they set the length.
--
-- ONLY THE PUPILS ARE BLOCKED, and this is the decision the whole change rests
-- on. Not the teacher: the idrottslärare does not shower with the class, and is
-- free to take another group in the slot before and the slot after — blocking
-- them would cost an idrottslärare a third of their teachable week for nothing.
-- Not the room either: the gymnastiksal stands empty while the class is in the
-- omklädningsrummet, and holding it would make the hall unbookable for half an
-- hour around every lesson in a subject that is short of halls to begin with.
--
-- WHY THIS IS NOT THE CHANGEOVER CORRIDOR. FrameTimes.changeoverMinutes
-- (20260907090000) looks like the same idea and is not. That one is a FLOOR ON
-- THE GAP between any two lessons of a stage, and the solver argues itself down
-- to one end of it for two good reasons (scheduler_solver.py, padded_of):
-- padding both sides turns a ten-minute rule into a silent twenty, and padding
-- the front makes 08:00 an illegal start for the first lesson of the day. It
-- also refuses to pad the room at all, because a room needs no time to become
-- itself again and a school that wants the hall to breathe declares a rast.
--
-- Neither argument reaches these columns. A corridor is one rule about a gap, so
-- charging it at both ends charges it twice; ombyte and dusch are two different
-- things the children actually do, named separately because they are not the
-- same length — nobody showers in the ten minutes it takes to put on shorts. So
-- 10 before and 20 after is thirty minutes of real occupancy and not a doubled
-- ten, and both ends are required or the asymmetry the school just described is
-- thrown away. Nor is the front pad an artefact here: 08:00 idrott means the
-- class is changing at 07:50, which is the school's own answer rather than an
-- encoding accident, and this is a clash check on placements the school has
-- already made rather than a window the solver must start inside. The one thing
-- the corridor's reasoning does carry over is the room arm, and it carries over
-- unchanged and for the same reason: nobody is in it.
--
-- 0..60 on each, as CHECK constraints rather than trust. The bound is the DTO's
-- (`@Min(0) @Max(60)`), mirrored here on the pattern of
-- FrameTimes_changeover_is_sane, because PostgREST writes reach the table
-- without meeting the DTO at all — a school admin's own key can PATCH
-- "TeachingRequirements" directly, and an hour of shower time entered as 1200 is
-- a class that clashes with its whole day. Sixty is the ceiling for the same
-- reason it is the corridor's: a buffer longer than a lesson is a lesson.
--
-- DEFAULT 0, so every existing row keeps a week that is exactly what it was.
-- No backfill: zero is the truth for every requirement in every school today,
-- since nobody has been able to say otherwise, and the gateway skips the whole
-- mechanism when both numbers read 0.
--
-- No RLS work. `TeachingRequirements` is an existing table with its policies
-- already in place, and every one of them is a row predicate on schoolId and a
-- role — none names a column, so a new column is readable and writable under
-- exactly the policies the row already had, through PostgREST as through the
-- gateway. Section 12 of scripts/test/rls-policies.sql sweeps every table for
-- enabled row security and is unaffected by column count.

ALTER TABLE "TeachingRequirements"
    ADD COLUMN "minutesBefore" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "TeachingRequirements"
    ADD COLUMN "minutesAfter" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "TeachingRequirements"
    ADD CONSTRAINT "TeachingRequirements_minutes_before_is_sane"
    CHECK ("minutesBefore" BETWEEN 0 AND 60);

ALTER TABLE "TeachingRequirements"
    ADD CONSTRAINT "TeachingRequirements_minutes_after_is_sane"
    CHECK ("minutesAfter" BETWEEN 0 AND 60);
