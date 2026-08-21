-- What the rules actually were when this run produced its timetable.
--
-- The job row already snapshots `weights`, and deliberately did not snapshot
-- `rules` — there was no reason to, because rules arrived in the request body
-- and a rerun of the same request reproduced the same run. That stops being
-- true now that the lunch window and the dining hall's seat count are a stored
-- row an administrator edits in place: change the seats in November and every
-- run in the history silently claims to have used the November number.
--
-- Nullable with no backfill, because there is nothing honest to backfill with.
-- A job from before this migration ran under rules nobody recorded, and NULL
-- says exactly that; inventing today's settings for it would be worse than
-- admitting the gap.

ALTER TABLE "OptimizationJobs" ADD COLUMN "rules" JSONB;
