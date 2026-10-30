-- Generatorn håller nere elevernas håltimmar när skolan slår på det.
--
-- Elevernas håltimmar: the generator minimises the pupils' idle time between
-- their first and last lesson of a day, counted per set of pupils booked alike
-- (their class, teaching groups, halves and replacing groups), the way the
-- håltimmesrapport counts it. It is OFF until the school turns it on, as the
-- roadmap decides ("avslaget tills skolan slår på det"): a term that moves
-- every lesson of every class is the school's to ask for, and one switched on
-- by a migration would change the next Generera of every school.
--
--   * LunchSettings."generatorKeepsPupilGapsDown": boolean, NOT NULL, default
--     false. The school's Skolregler row, beside "generatorKeepsTravelTime"
--     (20261209090000) and "Max lektioner per dag", for the reason they are
--     there: it sits in the same form. PLANERING writes it, as it writes the
--     rest of the row; every member of staff reads it, as they read the row.
--
-- Off sends the engine nothing new: the gateway adds the pupils' cohorts to
-- the payload only when the switch is on
-- (src/optimization/optimization-proxy.service.ts), so a school that has not
-- turned it on gets the payload, the model and the response it got before.
--
-- No new table, so no arm, no GRANT and nothing in TABLE_WRITE_GATES or the
-- role matrix (RLS section 116) moves: the row's arms (PLANERING for every
-- write, staff for SELECT) are row-level and read every column, and its
-- privileges are table-level (GRANT … ON "LunchSettings" TO app_authenticated,
-- 20260821160000), so the column is readable and writable by exactly whom
-- the row is. MAINTAIN is not touched. RLS section 283 holds it.
--
-- ## Beside the live API
--
-- Additive: one column with a constant default, which Postgres 11+ adds to
-- the catalogue without rewriting the table; no row changes. The API before
-- this reads the row with Prisma's own column list, which does not name the
-- column, and upserts the row with a statement that does not name it either,
-- so between this migration and the deploy every school keeps generating as
-- before, and a save of the Skolregler leaves the switch off.
--
-- Production migrates beside the API that is serving it. ADD COLUMN takes
-- "LunchSettings" ACCESS EXCLUSIVE for a moment, and a waiting ACCESS
-- EXCLUSIVE queues every reader behind it — the generator reads the row at
-- the start of every run, the Skolregler card and the håltimmesrapport on
-- every load. So the lock is taken first and NOWAIT: a refusal tries again
-- 50 ms later, it never waits while a request holds the row, and no request
-- queues behind it. One table, so there is no order to get wrong; the loop
-- is the queue's answer, not a deadlock's. After 30 s of refusals it stops
-- with nothing done and can be rerun (prisma migrate resolve --rolled-back,
-- then deploy). lock_timeout bounds any wait nobody foresaw.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "LunchSettings" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'LunchSettings was not free in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

ALTER TABLE "LunchSettings"
    ADD COLUMN "generatorKeepsPupilGapsDown" BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN "LunchSettings"."generatorKeepsPupilGapsDown" IS
  'Elevernas håltimmar: the generator keeps the pupils'' idle time between lessons down, counted as the håltimmesrapport counts it. Off by default; off sends the engine no cohort. Written by PLANERING.';
