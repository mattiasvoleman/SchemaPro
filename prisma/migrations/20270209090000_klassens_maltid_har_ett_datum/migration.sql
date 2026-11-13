-- A class's meal can hold other weeks of the läsår: a date on the sitting.
--
-- A class has eaten at one time on a weekday all year: LunchSittings has one
-- row per läsår, class and weekday (LunchSittings_group_day_key), and its
-- snapshot PublishedLunchSittings one per publication, class and weekday. With
-- terminer (#300 to #302) that became the one rule the engine could not hold
-- per period: locked or förlagda lessons of the autumn and of the spring that
-- fill the class's lunch window on the same weekday refuse Generera with
-- LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK, though every single week has a gap. The
-- way out is a meal per part of the year, and the table could not hold two.
-- The design is maltid-per-termin-design.md in the session notes.
--
-- ## The change
--
--   * "startDate" and "endDate" on LunchSittings and PublishedLunchSittings:
--     the first and the last day the meal holds, both inclusive, NULL for the
--     läsår's own bound. The names and the meaning are MasterLessons' and the
--     engine's windows' (year-periods.ts), not the elevplaceringar's half-open
--     validFrom/validTo: a meal's weeks sit beside the post's weeks.
--   * Whole ISO weeks, as a CHECK: a Monday and a Sunday. The engine plans in
--     whole weeks (a week is touched by a window that has a day in it), so a
--     window that cut a week would be two sentences about one week, the
--     engine's and the calendar's. NULL is how a window reaches the läsår's
--     edge, which often begins on a Saturday (2026-08-15 in production).
--   * An EXCLUDE constraint in place of each unique key: a class has at most
--     one meal on a date. daterange(NULL, NULL, '[]') is unbounded, so a row
--     with no dates meets every other row of its class and weekday, which is
--     what the unique key said; two rows of other weeks do not meet.
--
-- NO ROW CHANGES. Both columns are nullable with no default and no backfill:
-- every row there is, and every row the API before this one writes, is
-- NULL/NULL and means what it meant, the whole läsår. Nothing writes a date
-- yet; the readers (the calendar, the publication snapshot, the swap board,
-- the exchange file) read the weeks, and a later release lets Generera and the
-- school write them. Policies and grants are untouched: the policies are row
-- predicates on schoolId, role and group, and none names a column.
--
-- ## The CHECK names
--
-- LunchSittings_window_is_ordered and PublishedLunchSittings_times_are_ordered
-- are the CLOCK's (endTime after startTime) and stay. The weeks' own are
-- *_weeks_are_ordered, *_weeks_start_on_a_monday and *_weeks_end_on_a_sunday,
-- one fact each, so a refusal names its rule.
--
-- ## Locks
--
-- ADD COLUMN, ADD CONSTRAINT and DROP CONSTRAINT take ACCESS EXCLUSIVE, and the
-- two tables are met in both orders by requests (Generera writes LunchSittings;
-- a publication reads LunchSittings and writes PublishedLunchSittings; the grid
-- reads LunchSittings). Both are therefore taken first, NOWAIT and together, in
-- a loop with a 30 s deadline: a refusal rolls back whatever the attempt got
-- and it tries again 50 ms later, so the migration never waits while it holds a
-- lock and no request queues behind it. After 30 s it stops with nothing
-- changed (prisma migrate resolve --rolled-back, then deploy). The file has a
-- $$ body, so Prisma 7 applies it as one transaction: a failed constraint
-- leaves neither table touched either. The tables hold a row per class and
-- weekday (25 in production), so the two indexes the constraints build take
-- milliseconds inside the lock.
--
-- ## One release of the API before this one
--
-- It reads and writes named columns and never the new ones, so every read and
-- every createMany/update/deleteMany of Generera is as it was. One path is not:
-- POST /api/v1/lunch-sittings (a meal placed by hand) is a Prisma upsert, which
-- Prisma 7 writes as INSERT ... ON CONFLICT ("academicYearId",
-- "studentGroupId", "dayOfWeek") DO UPDATE. An exclusion constraint cannot be
-- the arbiter of an ON CONFLICT list, so with the unique key gone that
-- statement fails (SQLSTATE 42P10) until the API that places by reading first
-- is serving. A school that places a meal by hand in those minutes gets an
-- error and places it again.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "LunchSittings" IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "PublishedLunchSittings" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'LunchSittings and PublishedLunchSittings were not free at once in 30 s: nothing is changed. Run prisma migrate resolve --rolled-back 20270209090000_klassens_maltid_har_ett_datum, then deploy again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;

  -- The arbiter of the constraints below: installed since 20260822131500, and
  -- not this file's to install.
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist') THEN
    RAISE EXCEPTION 'MALTID_PER_TERMIN: the extension btree_gist is not installed; nothing is changed';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- The live table.
-- ---------------------------------------------------------------------------

ALTER TABLE "LunchSittings" ADD COLUMN "startDate" DATE;
ALTER TABLE "LunchSittings" ADD COLUMN "endDate" DATE;

ALTER TABLE "LunchSittings"
    ADD CONSTRAINT "LunchSittings_weeks_are_ordered"
    CHECK ("startDate" IS NULL OR "endDate" IS NULL OR "startDate" <= "endDate");
ALTER TABLE "LunchSittings"
    ADD CONSTRAINT "LunchSittings_weeks_start_on_a_monday"
    CHECK ("startDate" IS NULL OR EXTRACT(ISODOW FROM "startDate") = 1);
ALTER TABLE "LunchSittings"
    ADD CONSTRAINT "LunchSittings_weeks_end_on_a_sunday"
    CHECK ("endDate" IS NULL OR EXTRACT(ISODOW FROM "endDate") = 7);

ALTER TABLE "LunchSittings" DROP CONSTRAINT "LunchSittings_group_day_key";
ALTER TABLE "LunchSittings"
    ADD CONSTRAINT "LunchSittings_one_meal_at_a_time" EXCLUDE USING gist (
        "academicYearId" WITH =,
        "studentGroupId" WITH =,
        "dayOfWeek" WITH =,
        daterange("startDate", "endDate", '[]') WITH &&
    );

-- ---------------------------------------------------------------------------
-- The publication's snapshot of it.
-- ---------------------------------------------------------------------------

ALTER TABLE "PublishedLunchSittings" ADD COLUMN "startDate" DATE;
ALTER TABLE "PublishedLunchSittings" ADD COLUMN "endDate" DATE;

ALTER TABLE "PublishedLunchSittings"
    ADD CONSTRAINT "PublishedLunchSittings_weeks_are_ordered"
    CHECK ("startDate" IS NULL OR "endDate" IS NULL OR "startDate" <= "endDate");
ALTER TABLE "PublishedLunchSittings"
    ADD CONSTRAINT "PublishedLunchSittings_weeks_start_on_a_monday"
    CHECK ("startDate" IS NULL OR EXTRACT(ISODOW FROM "startDate") = 1);
ALTER TABLE "PublishedLunchSittings"
    ADD CONSTRAINT "PublishedLunchSittings_weeks_end_on_a_sunday"
    CHECK ("endDate" IS NULL OR EXTRACT(ISODOW FROM "endDate") = 7);

DROP INDEX "PublishedLunchSittings_publicationId_studentGroupId_dayOfWeek_key";
ALTER TABLE "PublishedLunchSittings"
    ADD CONSTRAINT "PublishedLunchSittings_one_meal_at_a_time" EXCLUDE USING gist (
        "publicationId" WITH =,
        "studentGroupId" WITH =,
        "dayOfWeek" WITH =,
        daterange("startDate", "endDate", '[]') WITH &&
    );
