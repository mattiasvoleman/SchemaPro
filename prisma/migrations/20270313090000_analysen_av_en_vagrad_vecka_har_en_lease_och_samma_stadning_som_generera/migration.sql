-- Analysen av en vägrad vecka har en lease, och Genereras sopa städar den (G6b, g385-L-4).
--
-- The analysis "Åtgärdsförslag vid vägran" (G6, 20270305090000) lives in "OptimizationJobs"."suggestions":
-- RUNNING while the engine counts, then DONE or FAILED. Its process is an API instance's, and the row is
-- durable where the process is not: every merge deploys the API, so an analysis that was going stays RUNNING
-- for ever. Until now only the start decided: a read gave it up after six minutes, a Generera start after
-- four, a second press was told "same analysis" for six.
--
-- ## What an analysis now carries
--
-- "suggestions"->>'leaseUntil': until when a RUNNING analysis holds its place, as the ISO-8601 time in UTC
-- the service writes ('2027-03-13T09:00:00.000Z'). The process renews it every half minute to the
-- database's now plus 180 s (the engine's ceiling for the route, 150 s, and thirty more: past it no engine
-- call of the analysis is left). It is a key inside the column and not a column: the column's CHECK (an
-- object of at most 8 KiB) has room for it, so nothing in the table changes: no ALTER TABLE, no lock, no
-- grant, no policy, no index.
--
-- ## What this migration changes: one function
--
-- app.optimization_jobs_sweep() is Generera's sweep (20270222090000): the gateway calls it before every
-- start and every five minutes. It is CREATE OR REPLACEd with its text as it was, to the last byte, up to
-- and including "GET DIAGNOSTICS abandoned = ROW_COUNT;", and one statement more before "RETURN abandoned;":
-- the analysis whose lease has run out (or, with no lease, that began six minutes ago) is written as FAILED
-- ABANDONED, or as the finished analysis it was asked over (the finished one is what the school can use:
-- g385-L-5). The return value is still the number of Generera runs it failed, and the signature, the owner,
-- SECURITY DEFINER, the search_path, the guard that refuses (GQ403) a call carrying a login, and the grants
-- are the same. Nothing but the added statement is new; the migration's last block states the grants again,
-- as the first one did, so that the file leaves them as it found them.
--
-- ## Why a sweep at all
--
-- The gateway's readers and the claim judge the lease themselves (a RUNNING analysis whose lease has run out
-- reads as abandoned, a press takes its place), so nothing waits on this row as a Generera run's unique
-- index waits on its. The sweep writes down what every reader already works out: the column is honest for
-- whoever reads it as SQL, a row nobody asks for again is not left RUNNING for ever, and the finished
-- analysis an abandoned press was asked over is back in the column.
--
-- ## Row security
--
-- No arm changes, no table grant changes. The function is the owner's (SECURITY DEFINER) and reads and
-- writes the table as the existing sweep does; PostgREST's role cannot call it, nor can an administrator.
--
-- ## Beside the live API
--
-- The API before this writes no 'leaseUntil': its RUNNING analyses are swept six minutes after they began,
-- the rule its own reads already applied. The API after this renews a lease the old function knows nothing
-- of, and a sweep from the old function would not touch an analysis at all: the order of deploy does not
-- matter.
--
-- CREATE OR REPLACE FUNCTION takes no lock on "OptimizationJobs"; a call already running finishes with the
-- old body.

CREATE OR REPLACE FUNCTION app.optimization_jobs_sweep() RETURNS integer
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

  -- The analysis of a refused run (G6, "suggestions"): the same place the sweep keeps clean, by the same
  -- rule the gateway reads it by (src/optimization/suggestions.ts holdsUntil). A RUNNING analysis holds its
  -- place until its lease runs out (leaseUntil, the process renews it every half minute), or, written by an
  -- API from before the lease, six minutes from its start. Past that its process is gone and nothing will
  -- finish it: it is written as what it is, FAILED ABANDONED, or as the finished analysis it was asked over
  -- when it had one (g385-L-5: a press never replaces a list with a failure).
  --
  -- The times are compared as the text they are stored as (an ISO-8601 time in UTC sorts as time does) and
  -- never cast: a value nobody wrote through the service must not be able to stop this function, which is
  -- also the sweep of Generera's runs. A lease that is not in the shape the service writes is no lease.
  -- It ended when its lease ran out; one with no lease ended now (the sweep is the first to say so).
  -- The row is locked as the first part locks its rows: one a heartbeat or the analysis's own write holds
  -- this instant is skipped, being alive, and is read again as it now is. The count returned is the first
  -- part's alone, as it always was.
  WITH lapsed AS (
    SELECT "id", "suggestions" AS held
      FROM "OptimizationJobs"
     WHERE "suggestions"->>'state' = 'RUNNING'
       AND CASE
             WHEN "suggestions"->>'leaseUntil' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
               THEN ("suggestions"->>'leaseUntil') COLLATE "C"
                      < to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
             ELSE ("suggestions"->>'startedAt') COLLATE "C"
                      < to_char((now() - interval '6 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
           END
       FOR UPDATE SKIP LOCKED
  )
  UPDATE "OptimizationJobs" j
     SET "suggestions" = CASE
           WHEN jsonb_typeof(lapsed.held->'previous') = 'object' AND lapsed.held->'previous'->>'state' = 'DONE'
             THEN lapsed.held->'previous'
           ELSE jsonb_build_object(
                  'version', 1,
                  'state', 'FAILED',
                  'startedAt', lapsed.held->'startedAt',
                  'finishedAt', CASE
                                  WHEN lapsed.held->>'leaseUntil' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
                                    THEN lapsed.held->'leaseUntil'
                                  ELSE to_jsonb(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
                                END,
                  'verdict', NULL,
                  'verified', false,
                  'total', 0,
                  'searchSeconds', NULL,
                  'verifySeconds', NULL,
                  'changes', '[]'::jsonb,
                  'failure', 'ABANDONED',
                  'leaseUntil', NULL,
                  'previous', NULL
                )
         END
    FROM lapsed
   WHERE j."id" = lapsed."id";

  RETURN abandoned;
END
$$;

COMMENT ON FUNCTION app.optimization_jobs_sweep() IS
  'Generera lease (20270222090000, extended 20270313090000): marks an active Generera run whose lease has run out, or that began more than 30 minutes ago, FAILED (ENGINE_RUN_ABANDONED), finished when its lease ran out, skipping rows another transaction holds; returns how many it marked. Also writes a RUNNING analysis of a refused run ("suggestions") whose lease has run out (six minutes from its start when it has none) as FAILED ABANDONED, or as the finished analysis it was asked over, and counts none of them. Takes no argument, reads nothing back, and refuses (GQ403) a call that carries a login.';

-- ---------------------------------------------------------------------------
-- Grants, as they were
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
