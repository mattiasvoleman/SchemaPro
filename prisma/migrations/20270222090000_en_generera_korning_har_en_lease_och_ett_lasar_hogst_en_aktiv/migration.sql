-- En Generera-körning har en lease, och ett läsår har högst en aktiv.
--
-- Generera runs as a row in "OptimizationJobs" that the API process which took
-- the request works on in the background. The row is durable, the work is
-- not: a restart in the middle of a solve (every merge deploys the API, and a
-- run takes up to about four minutes) leaves the row at RUNNING for ever, the
-- page polling it for ever, and nothing stopped two administrators starting
-- two runs of one year. Schemaförslag (20261125090000) solved the same for its
-- own runs with a heartbeat, a lease, a sweep and a partial unique index; this
-- gives Generera the same.
--
-- ## What a run now carries
--
--   "claimedBy"   who runs it: the API process's own name, for the log and
--                 for whoever has to find out which instance went away. Null
--                 on every run before this and on a run an older API started.
--   "heartbeatAt" the database's clock at the run's last sign of life.
--   "leaseUntil"  until when the run holds the year. The API renews it every
--                 half minute while it works and sets it, at each renewal, to
--                 the longest the engine can still be solving for it (the
--                 API's own wait for the engine, which DEPLOYMENT.md requires
--                 to exceed the engine's ceiling, plus thirty seconds): a run
--                 whose lease has run out has no engine call left to wait
--                 for, so the year can safely be given to the next run.
--
-- The defaults are what an API from before this writes: a row inserted
-- without the columns is a run with fifteen minutes to live, the same
-- fifteen minutes the old gateway and the old page already called a job lost
-- (GENERATE_JOB_WINDOW_MS, GENERATE_RUNNING_MS). now() is stable, so ADD COLUMN
-- with these defaults rewrites nothing.
--
-- ## One active run per year, in the database
--
--   OptimizationJobs_one_active_per_year   UNIQUE ("schoolId", "academicYearId")
--                                          WHERE "status" IN ('PENDING', 'RUNNING')
--
-- The second of two starts of one year is refused 23505, and the gateway
-- answers 409 GENERATE_ALREADY_RUNNING. The start lock
-- (lockYearForSolveStart) already made two starts take turns; the index is
-- what holds when a start did not take it. It does not reach across tables:
-- a Generera run and a schemaförslag run of one year are kept apart by the
-- start lock and each start's check of the other's table, as before. SCHEDULE_BUSY
-- is a different thing: the year's regeneration lock, held by an apply, a
-- restore or the write at the end of a run, waited for at most 5 s.
--
-- ## Runs that are hanging now
--
-- Production can hold rows that stopped at RUNNING for ever, and a unique
-- index cannot be built over two of one year. So, in this transaction:
--
--   * an active run older than fifteen minutes is lost (no run of the old API
--     lasts that long): FAILED, ENGINE_RUN_ABANDONED, finished when its
--     fifteen minutes ran out;
--   * an active run younger than that is left alone, exactly as it is, with
--     the lease the old gateway gave it (fifteen minutes from its start): the
--     API that started it may be solving still, and when it finishes it writes
--     its own outcome as before. If it is lost, the sweep takes it;
--   * if two runs of one year are both younger than that, the migration stops
--     with nothing changed and says so: wait until one has ended and run it
--     again. Neither run is touched.
--
-- ## The sweep
--
-- app.optimization_jobs_sweep() fails an active run whose lease has run out
-- (or that began more than half an hour ago, whatever its lease says:
-- schemaförslag's second limit) with the code ENGINE_RUN_ABANDONED and finished
-- at the moment its lease ran out. The API calls it before every start, so a
-- dead run never holds the year, and every five minutes as a job of the
-- gateway's runner. It is a job door: SECURITY DEFINER, no argument, and it
-- refuses (GQ403) any call that carries a login, as the doors of
-- 20270220090000 do.
--
-- ## Row security
--
-- No arm changes. The columns are the table's, and the four administrator's
-- arms of 20261123090100 (TO app_authenticated, the API's role alone) govern
-- them as they govern the rest: PostgREST's role reads, starts and changes no
-- run, and neither does an administrator of another school. No table grant
-- changes.
--
-- ## Beside the live API
--
-- The API before this names its columns and writes none of these, so it is
-- unaffected, except that in the minutes between this migration and the API's
-- deploy a start of a year that already has a run going now fails (23505)
-- where it used to start a second solve beside the first. That is the
-- intention, said once here.
--
-- ADD COLUMN, ADD CONSTRAINT and CREATE INDEX take the table ACCESS
-- EXCLUSIVE; a run being written holds it, and a migration waiting for it
-- would queue every Generera poll behind it. So the lock is taken NOWAIT,
-- again 50 ms later while a request holds it, and after 30 s it stops with
-- nothing done and can be rerun. lock_timeout bounds any wait nobody
-- foresaw. The file has a $$ body, so Prisma runs it as one transaction: a
-- refusal below leaves nothing changed.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
  collided integer;
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

  ALTER TABLE "OptimizationJobs"
    ADD COLUMN "claimedBy"   TEXT,
    ADD COLUMN "heartbeatAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    ADD COLUMN "leaseUntil"  TIMESTAMPTZ(6) NOT NULL DEFAULT (now() + interval '15 minutes');

  -- A run that has ended was last seen when it ended.
  UPDATE "OptimizationJobs"
     SET "heartbeatAt" = coalesce("finishedAt", "createdAt"),
         "leaseUntil"  = coalesce("finishedAt", "createdAt")
   WHERE "status" IN ('SUCCEEDED', 'FAILED');

  -- A run still active after fifteen minutes was lost with its process.
  UPDATE "OptimizationJobs"
     SET "status" = 'FAILED',
         "error" = 'The run stopped before it finished: the service that ran it was restarted or lost.',
         "errorCode" = 'ENGINE_RUN_ABANDONED',
         "errorParams" = NULL,
         "heartbeatAt" = "createdAt",
         "leaseUntil" = "createdAt" + interval '15 minutes',
         "finishedAt" = "createdAt" + interval '15 minutes'
   WHERE "status" IN ('PENDING', 'RUNNING')
     AND "createdAt" < now() - interval '15 minutes';

  -- One younger than that is alive as far as anyone knows: left as it is,
  -- with the fifteen minutes the old gateway gave it.
  UPDATE "OptimizationJobs"
     SET "heartbeatAt" = "createdAt",
         "leaseUntil"  = "createdAt" + interval '15 minutes'
   WHERE "status" IN ('PENDING', 'RUNNING');

  SELECT count(*) INTO collided
    FROM (SELECT 1 FROM "OptimizationJobs"
           WHERE "status" IN ('PENDING', 'RUNNING')
           GROUP BY "schoolId", "academicYearId"
          HAVING count(*) > 1) AS years;
  IF collided > 0 THEN
    RAISE EXCEPTION '% year(s) have more than one Generera run going, each younger than 15 minutes: nothing is changed, run the migration again when one of them has ended', collided;
  END IF;

  ALTER TABLE "OptimizationJobs"
    ADD CONSTRAINT "OptimizationJobs_lease_follows_the_heartbeat"
        CHECK ("leaseUntil" BETWEEN "heartbeatAt" AND "heartbeatAt" + interval '1 hour'),
    ADD CONSTRAINT "OptimizationJobs_claimedBy_is_short"
        CHECK ("claimedBy" IS NULL OR char_length("claimedBy") BETWEEN 1 AND 100);

  CREATE UNIQUE INDEX "OptimizationJobs_one_active_per_year"
      ON "OptimizationJobs" ("schoolId", "academicYearId")
      WHERE "status" IN ('PENDING', 'RUNNING');
END
$$;

COMMENT ON COLUMN "OptimizationJobs"."claimedBy" IS
  'Generera lease (20270222090000): the API process that runs it; null before the column and for a run an older API started.';
COMMENT ON COLUMN "OptimizationJobs"."heartbeatAt" IS
  'Generera lease (20270222090000): the database''s clock at the run''s last sign of life; renewed by the process that runs it.';
COMMENT ON COLUMN "OptimizationJobs"."leaseUntil" IS
  'Generera lease (20270222090000): until when the run holds its year; past it an active run is abandoned (app.optimization_jobs_sweep). At most an hour past the heartbeat (CHECK).';

-- ---------------------------------------------------------------------------
-- The sweep
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.optimization_jobs_sweep() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  abandoned integer;
BEGIN
  -- A job door: the gateway's runner and a start call it with no login at
  -- all. A login of any kind (a person, a reader, the key lookup) is refused
  -- (the guard of 20270220090000).
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'The sweep of Generera runs takes no login' USING ERRCODE = 'GQ403';
  END IF;

  -- A run's process renews its lease every half minute and each renewal is
  -- the longest its engine call can still be solving. Past the lease, or half
  -- an hour after it began, the process is gone and the run holds the year's
  -- one place until it is marked. A row a heartbeat holds this instant is
  -- skipped: it is alive. The row the sweep locks is read again as it now is,
  -- so a heartbeat that committed in between takes it out.
  WITH stale AS (
    SELECT "id", "leaseUntil" FROM "OptimizationJobs"
     WHERE "status" IN ('PENDING', 'RUNNING')
       AND ("leaseUntil" < now() OR "createdAt" < now() - interval '30 minutes')
     FOR UPDATE SKIP LOCKED
  )
  UPDATE "OptimizationJobs" j
     SET "status" = 'FAILED',
         "error" = 'The run stopped before it finished: the service that ran it was restarted or lost.',
         "errorCode" = 'ENGINE_RUN_ABANDONED',
         "errorParams" = NULL,
         "finishedAt" = least(stale."leaseUntil", now())
    FROM stale
   WHERE j."id" = stale."id";
  GET DIAGNOSTICS abandoned = ROW_COUNT;

  RETURN abandoned;
END
$$;

COMMENT ON FUNCTION app.optimization_jobs_sweep() IS
  'Generera lease (20270222090000): marks an active Generera run whose lease has run out, or that began more than 30 minutes ago, FAILED (ENGINE_RUN_ABANDONED), finished when its lease ran out, skipping rows another transaction holds; returns how many it marked. Takes no argument, reads nothing back, and refuses (GQ403) a call that carries a login.';

-- ---------------------------------------------------------------------------
-- Grants, guarded
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['app_authenticated', 'authenticated', 'anon', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION app.optimization_jobs_sweep() FROM %I', r);
    END IF;
  END LOOP;
  REVOKE ALL ON FUNCTION app.optimization_jobs_sweep() FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT EXECUTE ON FUNCTION app.optimization_jobs_sweep() TO "app_authenticated";
  END IF;
END
$$;
