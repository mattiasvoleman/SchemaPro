-- Generatorns körningar läses bara genom API:t, och en körning nämner de
-- önskemål den inte kunde hålla.
--
-- A run's refusal is stored on its row (OptimizationJobs.conflicts, the
-- summary and the engine's English beside them) and read back by the
-- Generera page. Until Lärarens dag nothing in it was anybody's personal
-- data: a lesson, a room, a group, a teacher's lunch rule. A post's
-- deltid in days (TeacherEmployments."maxTeachingDaysPerWeek",
-- 20261123090000) is HR data, and a week the days make impossible is refused
-- with the days and the teacher in it. The rektor who reads HR must see that
-- sentence as it is; a schemaläggare without HR-läs must not, and the
-- gateway rewrites it for that reader when it answers
-- (src/optimization/optimization-jobs.service.ts). Row security cannot
-- rewrite a column, so the row must not be readable any other way.
--
-- It was: the administrator's arms on OptimizationJobs are TO authenticated,
-- PostgREST's role, so any administrator with a session could read every
-- run's stored refusal directly, past the gateway's rewrite. No client reads
-- the table that way — the web reads runs through /api/v1/optimization/jobs,
-- the app does not read them at all — so the arms move to the API's role,
-- as 20261026100000 moved the six tables' and 20261028090000 the posts':
-- ALTER POLICY with TO alone keeps the command, USING and WITH CHECK. The
-- gateway connects as app_authenticated, a member of authenticated, and
-- keeps every arm it had. No table grant changes.
--
-- Every arm on the table admits an administrator only, so every arm moves;
-- they are read from the catalogue, as Roller i skolan (20261110100000) left
-- them split per command, and a table with none fails the migration instead
-- of passing it by. Guarded on pg_roles like 20261026100000: a bare Postgres
-- without the API role keeps its arms.
--
-- ## OptimizationJobs."notes"
--
-- The free-day wish (TeacherWorkRules."preferredFreeDayOfWeek") is soft: the
-- generator pays for a lesson on the wished day and does not refuse a week
-- over it. A wish it could not keep is named all the same, beside the
-- finished run, as the refusals are beside a failed one: the gateway finds
-- them in the timetable it has just written and stores them here, in the
-- shape of a conflict (code, params, the teacher's work rule as the
-- resource). Null on every run before this one and on a run with no wish
-- broken; the API before this neither writes nor reads it.
--
-- ## Beside the live API
--
-- The API before this reads and writes runs as app_authenticated already,
-- so it is unaffected, and so is the web before it; it names its columns, so
-- it does not see the new one. ADD COLUMN (nullable, no default: nothing is
-- rewritten) and ALTER POLICY take the table ACCESS EXCLUSIVE; a run being written holds it, and a migration
-- waiting for it would queue every Generera poll behind it. So the lock is
-- taken NOWAIT, again 50 ms later while a request holds it, and after 30 s
-- it stops with nothing done and can be rerun. lock_timeout bounds any wait
-- nobody foresaw.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
  arm record;
  moved integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "OptimizationJobs" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'OptimizationJobs was not free in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;

  ALTER TABLE "OptimizationJobs" ADD COLUMN "notes" JSONB;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    RETURN;
  END IF;
  FOR arm IN
    SELECT p.polname
      FROM pg_policy p
     WHERE p.polrelid = '"OptimizationJobs"'::regclass
     ORDER BY p.polname
  LOOP
    EXECUTE format('ALTER POLICY %I ON "OptimizationJobs" TO "app_authenticated"', arm.polname);
    moved := moved + 1;
  END LOOP;
  IF moved = 0 THEN
    RAISE EXCEPTION 'OptimizationJobs has no policy to move: this database was not shaped by the migrations before this one';
  END IF;
END
$$;
