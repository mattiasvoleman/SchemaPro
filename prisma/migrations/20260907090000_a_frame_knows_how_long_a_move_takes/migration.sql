-- A frame knows how long a move takes.
--
-- Raster solve the gaps a school has NAMED. They do not reach the two lessons
-- back to back inside one block, and that was the other half of the rektor's
-- first complaint: CP-SAT intervals are half-open, so a lesson ending 09:00 and
-- one starting 09:00 do not overlap, and the teacher walks between two rooms in
-- zero minutes.
--
-- THE NUMBER LIVES ON THE FRAME because a ramtid is the school's sentence about
-- the shape of a stage's teaching day, and the margin between two lessons is
-- part of that shape. It composes as MAX over the matching frames — the
-- opposite of the window, which is the intersection — because a changeover is
-- a floor and the widest floor wins. A 4-6 group under a 0-12 frame saying 5
-- and a 4-6 frame saying 10 gets 10.
--
-- DEFAULT 0, so nothing changes for any school until somebody writes a number.
-- The engine skips the whole mechanism when every matching frame reads 0.
--
-- A school with NO frames cannot write the number at all. That is a real gap
-- and it is closed with an affordance rather than a fourth table: the frame
-- times page offers a 0-12 every-day frame built from the deployment grid when
-- a school has none, so writing a changeover is one click away from where the
-- admin already is.

ALTER TABLE "FrameTimes"
    ADD COLUMN "changeoverMinutes" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "FrameTimes"
    ADD CONSTRAINT "FrameTimes_changeover_is_sane"
    CHECK ("changeoverMinutes" BETWEEN 0 AND 60);
