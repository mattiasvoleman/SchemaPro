-- Generatorn håller restiden när skolan slår på den.
--
-- Restid i generatorn: the walk between a school's skolområden (Sites and
-- SiteTravelTimes, 20261124090000) becomes a rule the generator keeps — for
-- a teacher and for the pupils who have two lessons on one day at two sites,
-- the figure the school wrote for the pair, rounded up to the timetable's
-- start step. It is OFF until the school turns it on, as the roadmap decides
-- (rad 1187): a rule that changes which timetables exist is the school's to
-- ask for, and one switched on by a migration would change the next
-- Generera of every school with two sites and figures between them.
--
--   * LunchSettings."generatorKeepsTravelTime": boolean, NOT NULL, default
--     false. The school's Skolregler row, where "Max lektioner per dag"
--     already lives for the same reason (it sits in the same form). PLANERING
--     writes it, as it writes the rest of the row and the sites and walks
--     themselves; every member of staff reads it, as they read the row.
--
-- Off sends the engine nothing new: the gateway adds the rooms' sites and the
-- walks to the payload only when the switch is on and the school has a figure
-- (src/optimization/optimization-proxy.service.ts), so a school that has not
-- turned it on gets the payload, and the model, it got before.
--
-- No new table, so no arm, no GRANT and nothing in TABLE_WRITE_GATES or the
-- role matrix (RLS section 116) moves: the row's arms (PLANERING for every
-- write, staff for SELECT) are row-level and read every column, and its
-- privileges are table-level (GRANT … ON "LunchSettings" TO app_authenticated,
-- 20260821160000), so the column is readable and writable by exactly whom
-- the row is. MAINTAIN is not touched. RLS section 221 holds it.
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
-- the start of every run, the Skolregler card on every load. So the lock is
-- taken first and NOWAIT: a refusal tries again 50 ms later, it never waits
-- while a request holds the row, and no request queues behind it. One table,
-- so there is no order to get wrong; the loop is the queue's answer, not a
-- deadlock's. After 30 s of refusals it stops with nothing done and can be
-- rerun (prisma migrate resolve --rolled-back, then deploy). lock_timeout
-- bounds any wait nobody foresaw.

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
    ADD COLUMN "generatorKeepsTravelTime" BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN "LunchSettings"."generatorKeepsTravelTime" IS
  'Restid i generatorn: the generator keeps the walk between the school''s sites for teachers and pupils. Off by default; off sends the engine no site and no walk. Written by PLANERING.';
