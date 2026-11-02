-- En lärares följd av lektioner har en gräns som generatorn försöker hålla.
--
-- Sammanhängande undervisning: "högst X minuters undervisning i följd, sedan Y
-- minuter ledigt", set per teacher by the administrator. Four things keep it,
-- and only the first is soft:
--
--   * THE GENERATOR TRIES. It pays for every lesson of the teacher whose
--     stretch is not ended by a break in time, in the full model's objective,
--     and refuses no week over it: the way it treats the wished free day. A
--     hard rule was built first and measured on the högstadium school (450
--     pupils, 26 teachers, 423 lessons, the eight busiest teachers flagged):
--     the first solution took 27–85 s where the school's own takes 8, and the
--     full solve found no timetable at all in 90 s in three pairs of three.
--     Soft, the same school solves 423 of 423 in every pair and leaves 0–3 of
--     the 8 teachers over the limit (one or two in the usual run) where
--     today's model leaves 7–8 (docs/verification-baseline.md). "Tries" is
--     the promise, and the Generera line names the teachers it did not
--     manage.
--   * A HAND EDIT OF THE GRUNDSCHEMA IS WARNED when it leaves a teacher's
--     stretch longer than the limit (TEACHER_CONSECUTIVE_TOO_LONG), never
--     refused.
--   * THE VIKARIETAVLA NEVER PROPOSES a cover that would put a teacher over it
--     (hard, in every cover path), and warns on a manual pick.
--
-- Columns:
--
--   * TeacherWorkRules."maxConsecutiveTeachingMinutes": the most minutes of
--     teaching in a row, 30..480 on the engine's five-minute grid.
--   * TeacherWorkRules."consecutiveBreakMinutes": the free time that ends a
--     stretch, 5..120, also a multiple of 5. A gap shorter than this does not
--     end it. Both columns or neither: a limit with no break, or a break with
--     no limit, is a rule nothing can read, and the CHECK says so by name.
--   * LunchSettings."generatorKeepsConsecutiveTeaching": boolean, NOT NULL,
--     default false. The school's Skolregler row, beside
--     "generatorKeepsTravelTime" (20261209090000) and
--     "generatorKeepsPupilGapsDown" (20261216090000), for the reason they are
--     there. OFF until the school turns it on, as the roadmap decides: a term
--     that moves the lessons of every teacher who has the rule is the school's
--     to ask for, and one switched on by a migration would change the next
--     Generera of every school. Off sends the engine neither field
--     (src/optimization/optimization-proxy.service.ts), so a school that has
--     not turned it on gets the payload, the model and the response it got
--     before. The hand-edit warning and the Vikarietavla do not look at the
--     switch: the limit is the teacher's, and only the generator's EFFORT is
--     the school's to turn on.
--
-- Null is off for the work-rule columns, as for every rule on TeacherWorkRules.
--
-- ## Who reads and writes what
--
-- The two columns sit on the work rule beside the cap and the wish, and are the
-- administrator's for the same reason: every member of staff reads the row, it
-- is not HR (an arbetsanpassning after sick leave is the case it is for, but
-- the figure is a fact about the timetable), and a teacher writes the rest of
-- their own row (lunch, rest). The trigger that keeps the cap and the wish for
-- an administrator who writes planering
-- (app.teacher_work_rules_day_is_planned, 20261123090000) is replaced here by
-- one that keeps these two as well: a write by anybody else that would change
-- them, or remove a row holding them, is refused with AR403, which the gateway
-- answers as a 403. CREATE OR REPLACE keeps the function's owner, its
-- SECURITY DEFINER and the REVOKEs of the first migration; the trigger itself
-- is untouched. The owner, the service principal and the sync act with no
-- person and pass.
--
-- The message changes with the rule: it names the three fields now, and the
-- gateway's copy (WORK_RULE_DAY_IS_PLANNED_MESSAGE) is held equal to it by
-- teacher-work-rules.service.spec.ts, as before.
--
-- No new table, so no arm, no GRANT and nothing in TABLE_WRITE_GATES or the
-- role matrix (RLS section 116) moves: the rows' arms are row-level and read
-- every column, and the privileges are table-level. MAINTAIN is not touched.
-- RLS sections 287–289 hold it.
--
-- ## Beside the live API
--
-- Additive: two nullable columns with named CHECKs on one table, one boolean
-- with a constant default on another (Postgres 11+ adds it to the catalogue
-- without rewriting the table), and a trigger function that is the old one
-- with two more columns in its comparison. No row changes. The API before this
-- names only the old columns: its PUT of a work rule updates the ones it
-- knows and leaves these, so the trigger sees them unchanged and stays quiet;
-- its upsert of the Skolregler does not name the new switch, so a save leaves
-- it off. The API after it reads them, so this runs first.
--
-- Production migrates beside the API that is serving it. ADD COLUMN takes each
-- table ACCESS EXCLUSIVE for a moment, and a waiting ACCESS EXCLUSIVE queues
-- every reader behind it: the generator reads both tables at the start of every
-- run, the Skolregler card and the Arbetstid dialog on every load. Requests
-- take them in both orders, so a migration that waited for one while it held
-- the other could close a cycle. Both locks are taken first, NOWAIT and
-- together: a refusal rolls the subtransaction back and with it whatever it
-- got, and it tries again 50 ms later. It never waits while it holds a lock.
-- After 30 s of refusals it stops with nothing done and can be rerun
-- (prisma migrate resolve --rolled-back, then deploy). lock_timeout bounds any
-- wait nobody foresaw.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "TeacherWorkRules" IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "LunchSettings" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'TeacherWorkRules and LunchSettings were not free at once in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

ALTER TABLE "TeacherWorkRules"
    ADD COLUMN "maxConsecutiveTeachingMinutes" INTEGER,
    ADD COLUMN "consecutiveBreakMinutes"       INTEGER,
    ADD CONSTRAINT "TeacherWorkRules_maxConsecutiveTeachingMinutes_check"
        CHECK ("maxConsecutiveTeachingMinutes" BETWEEN 30 AND 480 AND "maxConsecutiveTeachingMinutes" % 5 = 0),
    ADD CONSTRAINT "TeacherWorkRules_consecutiveBreakMinutes_check"
        CHECK ("consecutiveBreakMinutes" BETWEEN 5 AND 120 AND "consecutiveBreakMinutes" % 5 = 0),
    ADD CONSTRAINT "TeacherWorkRules_consecutive_is_a_pair_check"
        CHECK (("maxConsecutiveTeachingMinutes" IS NULL) = ("consecutiveBreakMinutes" IS NULL));

ALTER TABLE "LunchSettings"
    ADD COLUMN "generatorKeepsConsecutiveTeaching" BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN "TeacherWorkRules"."maxConsecutiveTeachingMinutes" IS
  'Most minutes of teaching in a row (a stretch ends at a break of consecutiveBreakMinutes); null = no limit. Soft in the generator, warned on a hand edit, hard in the Vikarietavla. Both columns or neither. Set by an administrator who writes planering.';
COMMENT ON COLUMN "TeacherWorkRules"."consecutiveBreakMinutes" IS
  'The free time between two of the teacher''s lessons that ends a stretch of teaching; null = no limit. Both columns or neither. Set by an administrator who writes planering.';
COMMENT ON COLUMN "LunchSettings"."generatorKeepsConsecutiveTeaching" IS
  'Sammanhängande undervisning: the generator tries to keep each teacher''s stretches of teaching within their work rule''s limit. A wish, not a guarantee. Off by default; off sends the engine no limit. Written by PLANERING.';

-- The trigger of 20261123090000 with the two new columns in its comparison.
-- Everything else is that function, word for word.
CREATE OR REPLACE FUNCTION app.teacher_work_rules_day_is_planned() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  cap_before integer;
  wish_before integer;
  stretch_before integer;
  break_before integer;
  cap_after integer;
  wish_after integer;
  stretch_after integer;
  break_after integer;
  teacher uuid;
BEGIN
  IF app.current_user_id() IS NULL
     OR app.current_service_school_id() IS NOT NULL
     OR app.current_sync_school_id() IS NOT NULL THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    cap_before := OLD."maxTeachingMinutesPerDay";
    wish_before := OLD."preferredFreeDayOfWeek";
    stretch_before := OLD."maxConsecutiveTeachingMinutes";
    break_before := OLD."consecutiveBreakMinutes";
    teacher := OLD."userId";
  END IF;
  IF TG_OP <> 'DELETE' THEN
    cap_after := NEW."maxTeachingMinutesPerDay";
    wish_after := NEW."preferredFreeDayOfWeek";
    stretch_after := NEW."maxConsecutiveTeachingMinutes";
    break_after := NEW."consecutiveBreakMinutes";
    teacher := NEW."userId";
  END IF;
  -- An upsert's INSERT arm meets an existing row only to become an update,
  -- and is judged there, by its own BEFORE UPDATE.
  IF TG_OP = 'INSERT' AND EXISTS (
    SELECT 1 FROM "TeacherWorkRules" r WHERE r."userId" = NEW."userId" FOR KEY SHARE
  ) THEN
    RETURN NEW;
  END IF;
  IF (cap_after IS DISTINCT FROM cap_before
      OR wish_after IS DISTINCT FROM wish_before
      OR stretch_after IS DISTINCT FROM stretch_before
      OR break_after IS DISTINCT FROM break_before)
     AND teacher = app.current_user_id()
     AND NOT app.current_user_may('PLANERING', true) THEN
    RAISE EXCEPTION 'WORK_RULE_DAY_IS_PLANNED: dagstaket, den önskade lediga dagen och gränsen för sammanhängande undervisning sätts av en administratör som planerar'
      USING ERRCODE = 'AR403',
            DETAIL  = 'area=PLANERING';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;
