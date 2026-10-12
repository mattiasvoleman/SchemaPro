-- Ett jobb körs en gång per skola och natt, och varje körning räknas.
--
-- The gateway's background work moves onto one in-process runner
-- (src/jobs/job-runner.ts): the SS12000 sync, the subscription notices, the
-- push receipts and, new, the nightly gallring. Before it, three services
-- each kept their own copy of one setInterval pattern, and nothing outside
-- the process could tell whether any of them had run. This migration gives
-- the runner two things only the database can give: a count of what ran,
-- shared by every API instance, and a claim that lets exactly one instance
-- do a school's nightly job.
--
-- In-process, not pg_cron: the compose database has no pg_cron, and two of
-- the jobs call out over HTTP (Expo, a subscriber's webhook).
--
-- ## JobRuns: one row per job and day, counts only
--
-- After every tick the runner adds one to "runs" (and to "failures" when the
-- pass threw) of the row for the job and the UTC day, and adds the pass's
-- counts to "counts", key by key. A count is a number of rows or calls, never
-- an id, a name or a school: JobRuns_counts_are_counts holds the object to
-- non-negative integers under short names, and "lastError" is an error class
-- name (JobRuns_error_is_a_name), as the logs have it. A minute's tick makes
-- 1 440 updates of one row a day, not 1 440 rows. Rows older than 90 days go
-- at the next settle. /health/ready reads them as counts: how many jobs this
-- process schedules, how many failed their last pass and how many have not
-- finished one within three intervals, on any instance.
--
-- ## JobClaims: a school's nightly job, once
--
-- Railway can run two API instances for a while during a deploy, and a purge
-- must not run twice in one night, nor a half-finished one be forgotten.
-- app.job_claim_nightly(job, hour, schools, limit, at) inserts a claim for
-- each of `schools` whose local hour (Schools.timezone) is at or past `hour`
-- and that has no claim for that local day, and returns the ones it inserted.
-- The primary key (job, schoolId, day) decides between two instances: the
-- second INSERT waits for the first and finds the row. ">=" because 02:00 does
-- not exist on the spring-forward Sunday, and an API that was down at the hour
-- catches up later that day. A claim not marked finished two hours after it
-- was taken is taken again (its instance died); app.job_claim_finished marks
-- it. Claims older than 35 days go at the next claim.
--
-- ## Who reaches them
--
-- Both tables have row security enabled with no arm and no grant to any API
-- role: only the SECURITY DEFINER functions below touch them. EXECUTE on the
-- functions is app_authenticated's alone (PUBLIC, anon, authenticated and
-- service_role revoked), so PostgREST cannot reach them. The gateway calls
-- them in a transaction with no principal (PrismaService.withDeliveryService).

CREATE TABLE "JobRuns" (
    "job"            TEXT NOT NULL,
    "day"            DATE NOT NULL,
    "runs"           INTEGER NOT NULL DEFAULT 0,
    "failures"       INTEGER NOT NULL DEFAULT 0,
    "counts"         JSONB NOT NULL DEFAULT '{}',
    "lastStartedAt"  TIMESTAMPTZ(6) NOT NULL,
    "lastFinishedAt" TIMESTAMPTZ(6) NOT NULL,
    "lastFailedAt"   TIMESTAMPTZ(6),
    "lastError"      TEXT,

    CONSTRAINT "JobRuns_pkey" PRIMARY KEY ("job", "day"),
    CONSTRAINT "JobRuns_job_is_a_name" CHECK ("job" ~ '^[a-z][a-z0-9-]{0,39}$'),
    CONSTRAINT "JobRuns_runs_are_counted" CHECK ("runs" >= 0 AND "failures" >= 0 AND "failures" <= "runs"),
    CONSTRAINT "JobRuns_counts_are_counts" CHECK (
        jsonb_typeof("counts") = 'object'
        AND NOT jsonb_path_exists("counts", '$.keyvalue() ? (!(@.key like_regex "^[a-zA-Z][a-zA-Z0-9]{0,39}$"))')
        AND NOT jsonb_path_exists("counts", '$.* ? (@.type() != "number" || @ < 0 || @ != @.floor())')
    ),
    CONSTRAINT "JobRuns_error_is_a_name" CHECK ("lastError" IS NULL OR "lastError" ~ '^[A-Za-z][A-Za-z0-9_]{0,79}$')
);

CREATE TABLE "JobClaims" (
    "job"        TEXT NOT NULL,
    "schoolId"   UUID NOT NULL,
    "day"        DATE NOT NULL,
    "claimedAt"  TIMESTAMPTZ(6) NOT NULL,
    "finishedAt" TIMESTAMPTZ(6),

    CONSTRAINT "JobClaims_pkey" PRIMARY KEY ("job", "schoolId", "day"),
    CONSTRAINT "JobClaims_job_is_a_name" CHECK ("job" ~ '^[a-z][a-z0-9-]{0,39}$')
);

CREATE INDEX "JobClaims_schoolId_idx" ON "JobClaims"("schoolId");

ALTER TABLE "JobClaims"
    ADD CONSTRAINT "JobClaims_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "JobRuns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "JobClaims" ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- The runner's functions.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.job_run_settled(
    p_job text, p_started timestamptz, p_finished timestamptz,
    p_ok boolean, p_error text, p_counts jsonb
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  d date := (p_finished AT TIME ZONE 'UTC')::date;
BEGIN
  DELETE FROM "JobRuns" WHERE "day" < d - 90;
  INSERT INTO "JobRuns" AS r ("job", "day", "runs", "failures", "counts",
                              "lastStartedAt", "lastFinishedAt", "lastFailedAt", "lastError")
  VALUES (p_job, d, 1, CASE WHEN p_ok THEN 0 ELSE 1 END, COALESCE(p_counts, '{}'::jsonb),
          p_started, p_finished, CASE WHEN p_ok THEN NULL ELSE p_finished END,
          CASE WHEN p_ok THEN NULL ELSE p_error END)
  ON CONFLICT ("job", "day") DO UPDATE SET
    "runs"           = r."runs" + 1,
    "failures"       = r."failures" + CASE WHEN p_ok THEN 0 ELSE 1 END,
    -- Key by key: a key either side lacks counts as 0.
    "counts"         = (SELECT COALESCE(jsonb_object_agg(k, COALESCE((r."counts" ->> k)::bigint, 0)
                                                           + COALESCE((EXCLUDED."counts" ->> k)::bigint, 0)), '{}'::jsonb)
                          FROM (SELECT jsonb_object_keys(r."counts") UNION SELECT jsonb_object_keys(EXCLUDED."counts")) AS keys(k)),
    "lastStartedAt"  = greatest(r."lastStartedAt", EXCLUDED."lastStartedAt"),
    "lastFinishedAt" = greatest(r."lastFinishedAt", EXCLUDED."lastFinishedAt"),
    "lastFailedAt"   = COALESCE(EXCLUDED."lastFailedAt", r."lastFailedAt"),
    "lastError"      = CASE WHEN p_ok THEN r."lastError" ELSE EXCLUDED."lastError" END;
END
$$;

-- The newest row of each job: what /health/ready counts.
CREATE FUNCTION app.job_runs_latest()
RETURNS TABLE (job text, last_finished timestamptz, last_failed timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT DISTINCT ON (r."job") r."job", r."lastFinishedAt", r."lastFailedAt"
    FROM "JobRuns" r
   ORDER BY r."job", r."day" DESC;
$$;

CREATE FUNCTION app.job_claim_nightly(p_job text, p_hour integer, p_schools uuid[], p_limit integer, p_at timestamptz)
RETURNS TABLE (school_id uuid, local_day date)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  DELETE FROM "JobClaims" WHERE "claimedAt" < p_at - interval '35 days';
  RETURN QUERY
  WITH due AS (
    SELECT s."id", (p_at AT TIME ZONE s."timezone")::date AS d
      FROM "Schools" s
     WHERE s."id" = ANY (p_schools)
       AND extract(hour FROM p_at AT TIME ZONE s."timezone") >= p_hour
       AND NOT EXISTS (
             SELECT 1 FROM "JobClaims" c
              WHERE c."job" = p_job AND c."schoolId" = s."id"
                AND c."day" = (p_at AT TIME ZONE s."timezone")::date
                AND (c."finishedAt" IS NOT NULL OR c."claimedAt" > p_at - interval '2 hours'))
     ORDER BY s."id"
     LIMIT greatest(least(p_limit, 50), 0)
  )
  INSERT INTO "JobClaims" AS c ("job", "schoolId", "day", "claimedAt")
  SELECT p_job, due."id", due.d, p_at FROM due
  ON CONFLICT ("job", "schoolId", "day") DO UPDATE SET "claimedAt" = EXCLUDED."claimedAt"
     WHERE c."finishedAt" IS NULL AND c."claimedAt" <= p_at - interval '2 hours'
  RETURNING c."schoolId", c."day";
END
$$;

CREATE FUNCTION app.job_claim_finished(p_job text, p_school uuid, p_day date, p_at timestamptz)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  UPDATE "JobClaims" SET "finishedAt" = p_at
   WHERE "job" = p_job AND "schoolId" = p_school AND "day" = p_day AND "finishedAt" IS NULL;
$$;

COMMENT ON FUNCTION app.job_run_settled(text, timestamptz, timestamptz, boolean, text, jsonb) IS
  'Counts one tick of a job in its row for the UTC day: runs, failures and the pass''s counts, summed key by key.';
COMMENT ON FUNCTION app.job_runs_latest() IS
  'The newest JobRuns row of each job: when it last finished and last failed.';
COMMENT ON FUNCTION app.job_claim_nightly(text, integer, uuid[], integer, timestamptz) IS
  'Claims the nightly job for those of p_schools at or past p_hour local time with no claim that local day; returns the claims this call made.';
COMMENT ON FUNCTION app.job_claim_finished(text, uuid, date, timestamptz) IS
  'Marks a school''s nightly claim finished, so it is not taken again that day.';

-- ---------------------------------------------------------------------------
-- Grants, guarded.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  tbl text;
  fn text;
  r text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['JobRuns', 'JobClaims'] LOOP
    FOREACH r IN ARRAY ARRAY['app_authenticated', 'authenticated', 'anon', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', tbl, r);
      END IF;
    END LOOP;
  END LOOP;

  FOREACH fn IN ARRAY ARRAY[
    'app.job_run_settled(text, timestamptz, timestamptz, boolean, text, jsonb)',
    'app.job_runs_latest()',
    'app.job_claim_nightly(text, integer, uuid[], integer, timestamptz)',
    'app.job_claim_finished(text, uuid, date, timestamptz)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', fn, r);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO "app_authenticated"', fn);
    END IF;
  END LOOP;
END
$$;
