-- Ett schemaförslag är privat tills det tillämpas.
--
-- Schemaförslag: an administrator asks for two to four candidates of the
-- year's grundschema, compares them (unplaced lessons, the teachers' and the
-- pupils' håltimmar, lessons moved against the draft) and applies one, which
-- replaces the draft the way Generera does. A candidate is never published
-- and never seen by anyone but the school's administrators.
--
-- ## Two tables, ids and numbers only
--
-- "ScheduleCandidateRuns" is one request: the year, how many candidates were
-- asked for, the weights, its progress and outcome, and the basis — a sha256
-- of what the candidates were solved from, by content (the engine's payload
-- with every anonymous id mapped back, the lessons a regeneration replaces),
-- with one hash per part so a refusal can say what changed.
-- "ScheduleCandidates" is one candidate of a run: its ordinal, its variant
-- (an emphasis: KEEP is Generera's own request, the others move weight to
-- the teachers' gaps, an even week or a freer placement), the weights it was
-- solved with, the solver's status, and its lessons as ids and times,
-- {requirementId, roomId, dayOfWeek, startTime, endTime}, with the engine's
-- lunches and the metrics the gateway computed when it stored them.
-- Subject, group, teachers and dates are the requirement's, resolved when
-- the candidate is read or applied, as Generera's persist does.
--
-- Nothing here is in MasterLessons or LunchSittings: every publication path,
-- and in DIRECT mode every teacher's, pupil's and SS12000 reader, reads
-- those. No foreign key to MasterLessons, TeachingRequirements, Rooms or
-- Users: a candidate names generated lessons that the next run recreates,
-- and every key would add a live table to this migration's locks. The
-- gateway checks the candidate's ids by the basis before it applies one: a
-- requirement, room or lock that changed since is a different basis, and
-- the apply is refused (409 SCHEDULE_CANDIDATE_STALE).
--
-- ## Who sees and writes them
--
-- Every administrator of the school reads them; one whose profile writes
-- schemaläggning (app.current_user_may('SCHEMALAGGNING', true), Roller i
-- skolan 20261110090000) starts, updates and removes a run and stores its
-- candidates. A candidate is written once and never changed: it has no
-- update arm and no UPDATE grant. Its row in src/auth/admin-areas.ts is
-- { insert, delete: SCHEMALAGGNING }; the run's is SCHEMALAGGNING for all
-- three. The arms are TO app_authenticated only: no teacher, pupil,
-- guardian, integration key or PostgREST role has one, and anon and
-- authenticated hold no grant.
--
-- ## How long they live
--
-- Working material, not a register: a candidate is stale the moment the
-- draft changes, so it is not a gallring category (one would start as "ej
-- beslutat", kept for ever). When a run succeeds the gateway deletes the
-- year's other finished runs, so one batch is kept; a run that fails leaves
-- the batch before it. Applying a candidate marks it on its run
-- (appliedCandidateId, appliedAt) and keeps the batch.
-- app.schedule_candidates_sweep() is the rest: an active run whose
-- heartbeat is older than its lease, or which began more than half an hour
-- ago, has lost the instance that ran it and is marked FAILED
-- (CANDIDATE_RUN_ABANDONED), which frees the year for the next run; a run
-- older than seven days is deleted with its candidates. It skips rows
-- another transaction holds, so it never waits on a school. The gateway
-- calls it in a short transaction of its own before every run and every
-- fifteen minutes; it is the owner's, and app_authenticated's EXECUTE is the
-- only one.
--
-- One run at a time per year: a partial unique index on the active ones
-- (PENDING, RUNNING and CANCELLING: a cancelled run holds the year until its
-- task has stopped). The gateway answers its 23505 with 409
-- CANDIDATES_RUNNING, and asks app.schedule_candidate_runs_active() — how
-- many runs are active across schools, a number and nothing else — before
-- it starts one, so the solver is never asked for more than a few at once.
--
-- ## Locks
--
-- The two new tables' keys reference Schools and AcademicYears, and adding a
-- foreign key takes SHARE ROW EXCLUSIVE on the referenced table. Both are
-- taken first, NOWAIT, all or nothing, retried for 30 s
-- (policy-migration-lock-order): a request holding one of them and waiting
-- for the other never meets this migration holding the second. Nothing else
-- live is touched, and the old API, which reads neither table, works
-- unchanged between this migration and the deploy.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Schools", "AcademicYears" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Schools and AcademicYears were not free at once in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- The runs
-- ---------------------------------------------------------------------------

CREATE TYPE "ScheduleCandidateRunStatus" AS ENUM ('PENDING', 'RUNNING', 'CANCELLING', 'SUCCEEDED', 'FAILED');

CREATE TABLE "ScheduleCandidateRuns" (
    "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"       UUID NOT NULL,
    "academicYearId" UUID NOT NULL,
    "createdById"    UUID,
    "status"         "ScheduleCandidateRunStatus" NOT NULL DEFAULT 'PENDING',
    "requested"      INTEGER NOT NULL,
    "progress"       INTEGER NOT NULL DEFAULT 0,
    "basis"          TEXT,
    "basisParts"     JSONB,
    "weights"        JSONB,
    "unplaced"       JSONB,
    "refreshOfId"    UUID,
    "appliedCandidateId" UUID,
    "appliedAt"      TIMESTAMPTZ(6),
    "error"          TEXT,
    "errorCode"      TEXT,
    "errorParams"    JSONB,
    "heartbeatAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "leaseSeconds"   INTEGER NOT NULL DEFAULT 600,
    "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "startedAt"      TIMESTAMPTZ(6),
    "finishedAt"     TIMESTAMPTZ(6),

    CONSTRAINT "ScheduleCandidateRuns_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ScheduleCandidateRuns_id_schoolId_key" UNIQUE ("id", "schoolId"),
    -- One for a refresh of a batch that had one applicable candidate.
    CONSTRAINT "ScheduleCandidateRuns_requested_is_one_to_four" CHECK ("requested" BETWEEN 1 AND 4),
    CONSTRAINT "ScheduleCandidateRuns_lease_is_bounded" CHECK ("leaseSeconds" BETWEEN 60 AND 3600),
    CONSTRAINT "ScheduleCandidateRuns_applied_together" CHECK (("appliedCandidateId" IS NULL) = ("appliedAt" IS NULL)),
    CONSTRAINT "ScheduleCandidateRuns_progress_is_of_the_requested" CHECK ("progress" BETWEEN 0 AND "requested"),
    CONSTRAINT "ScheduleCandidateRuns_basis_is_a_sha256" CHECK ("basis" IS NULL OR "basis" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "ScheduleCandidateRuns_error_is_short" CHECK ("error" IS NULL OR char_length("error") <= 2000),
    CONSTRAINT "ScheduleCandidateRuns_errorCode_is_a_name" CHECK ("errorCode" IS NULL OR "errorCode" ~ '^[A-Z][A-Z0-9_]{0,63}$')
);

CREATE UNIQUE INDEX "ScheduleCandidateRuns_one_active_per_year"
    ON "ScheduleCandidateRuns"("schoolId", "academicYearId")
    WHERE "status" IN ('PENDING', 'RUNNING', 'CANCELLING');
CREATE INDEX "ScheduleCandidateRuns_schoolId_academicYearId_createdAt_idx"
    ON "ScheduleCandidateRuns"("schoolId", "academicYearId", "createdAt");
-- The sweep's two questions, across schools.
CREATE INDEX "ScheduleCandidateRuns_createdAt_idx"
    ON "ScheduleCandidateRuns"("createdAt");

ALTER TABLE "ScheduleCandidateRuns"
    ADD CONSTRAINT "ScheduleCandidateRuns_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScheduleCandidateRuns"
    ADD CONSTRAINT "ScheduleCandidateRuns_academicYearId_schoolId_fkey"
    FOREIGN KEY ("academicYearId", "schoolId") REFERENCES "AcademicYears"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- The candidates
-- ---------------------------------------------------------------------------

CREATE TABLE "ScheduleCandidates" (
    "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
    "runId"        UUID NOT NULL,
    "schoolId"     UUID NOT NULL,
    "ordinal"      INTEGER NOT NULL,
    "variant"      TEXT NOT NULL,
    "weights"      JSONB,
    "seed"         INTEGER,
    "solverStatus" TEXT NOT NULL,
    "lessons"      JSONB NOT NULL DEFAULT '[]',
    "lunches"      JSONB,
    "metrics"      JSONB,
    "conflicts"    JSONB,
    "errorCode"    TEXT,
    "createdAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "ScheduleCandidates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ScheduleCandidates_runId_ordinal_key" UNIQUE ("runId", "ordinal"),
    CONSTRAINT "ScheduleCandidates_ordinal_is_one_to_four" CHECK ("ordinal" BETWEEN 1 AND 4),
    -- An open code (KEEP, TEACHER_GAPS, ...), so a new emphasis needs no migration.
    CONSTRAINT "ScheduleCandidates_variant_is_a_name" CHECK ("variant" ~ '^[A-Z][A-Z0-9_]{0,31}$'),
    CONSTRAINT "ScheduleCandidates_seed_is_not_negative" CHECK ("seed" IS NULL OR "seed" >= 0),
    CONSTRAINT "ScheduleCandidates_solverStatus_is_known"
        CHECK ("solverStatus" IN ('OPTIMAL', 'FEASIBLE', 'INFEASIBLE', 'TIMEOUT', 'REJECTED', 'FAILED')),
    CONSTRAINT "ScheduleCandidates_lessons_is_a_list" CHECK (jsonb_typeof("lessons") = 'array'),
    CONSTRAINT "ScheduleCandidates_errorCode_is_a_name" CHECK ("errorCode" IS NULL OR "errorCode" ~ '^[A-Z][A-Z0-9_]{0,63}$')
);

ALTER TABLE "ScheduleCandidates"
    ADD CONSTRAINT "ScheduleCandidates_runId_schoolId_fkey"
    FOREIGN KEY ("runId", "schoolId") REFERENCES "ScheduleCandidateRuns"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ScheduleCandidateRuns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScheduleCandidates" ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- The administrator's arms
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    CREATE POLICY "schedule_candidate_runs_admin_select" ON "ScheduleCandidateRuns"
        FOR SELECT TO "app_authenticated"
        USING (
            "schoolId" = (select app.current_school_id())
            AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
        );
    CREATE POLICY "schedule_candidate_runs_admin_insert" ON "ScheduleCandidateRuns"
        FOR INSERT TO "app_authenticated"
        WITH CHECK (
            "schoolId" = (select app.current_school_id())
            AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
            AND (select app.current_user_may('SCHEMALAGGNING', true))
        );
    -- USING does not ask the area (section 106 c): a row lock for a read
    -- keeps working for every administrator.
    CREATE POLICY "schedule_candidate_runs_admin_update" ON "ScheduleCandidateRuns"
        FOR UPDATE TO "app_authenticated"
        USING (
            "schoolId" = (select app.current_school_id())
            AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
        )
        WITH CHECK (
            "schoolId" = (select app.current_school_id())
            AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
            AND (select app.current_user_may('SCHEMALAGGNING', true))
        );
    CREATE POLICY "schedule_candidate_runs_admin_delete" ON "ScheduleCandidateRuns"
        FOR DELETE TO "app_authenticated"
        USING (
            "schoolId" = (select app.current_school_id())
            AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
            AND (select app.current_user_may('SCHEMALAGGNING', true))
        );

    CREATE POLICY "schedule_candidates_admin_select" ON "ScheduleCandidates"
        FOR SELECT TO "app_authenticated"
        USING (
            "schoolId" = (select app.current_school_id())
            AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
        );
    CREATE POLICY "schedule_candidates_admin_insert" ON "ScheduleCandidates"
        FOR INSERT TO "app_authenticated"
        WITH CHECK (
            "schoolId" = (select app.current_school_id())
            AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
            AND (select app.current_user_may('SCHEMALAGGNING', true))
        );
    CREATE POLICY "schedule_candidates_admin_delete" ON "ScheduleCandidates"
        FOR DELETE TO "app_authenticated"
        USING (
            "schoolId" = (select app.current_school_id())
            AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
            AND (select app.current_user_may('SCHEMALAGGNING', true))
        );
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- The sweep
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.schedule_candidates_sweep() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  abandoned integer;
  removed integer;
BEGIN
  -- A run's task bumps heartbeatAt before every candidate; its lease is twice
  -- the longest call it makes. Past that, or half an hour after it began, the
  -- instance that ran it is gone, and the run holds the year's one active
  -- place until it is marked.
  WITH stale AS (
    SELECT "id" FROM "ScheduleCandidateRuns"
     WHERE "status" IN ('PENDING', 'RUNNING', 'CANCELLING')
       AND ("heartbeatAt" + make_interval(secs => "leaseSeconds") < now()
            OR "createdAt" < now() - interval '30 minutes')
     FOR UPDATE SKIP LOCKED
  )
  UPDATE "ScheduleCandidateRuns" r
     SET "status" = 'FAILED',
         "error" = 'The run stopped before it finished.',
         "errorCode" = 'CANDIDATE_RUN_ABANDONED',
         "errorParams" = NULL,
         "finishedAt" = now()
    FROM stale
   WHERE r."id" = stale."id";
  GET DIAGNOSTICS abandoned = ROW_COUNT;

  WITH old AS (
    SELECT "id" FROM "ScheduleCandidateRuns"
     WHERE "createdAt" < now() - interval '7 days'
     FOR UPDATE SKIP LOCKED
  )
  DELETE FROM "ScheduleCandidateRuns" r
   USING old
   WHERE r."id" = old."id";
  GET DIAGNOSTICS removed = ROW_COUNT;

  RETURN abandoned + removed;
END
$$;

COMMENT ON FUNCTION app.schedule_candidates_sweep() IS
  'Schemaförslag (20261125090000): marks an active run past its lease or 30 minutes old FAILED (CANDIDATE_RUN_ABANDONED) and deletes runs older than 7 days with their candidates, skipping rows another transaction holds; returns how many rows it changed. Takes no argument and reads nothing back.';

CREATE FUNCTION app.schedule_candidate_runs_active() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT count(*)::integer FROM "ScheduleCandidateRuns"
   WHERE "status" IN ('PENDING', 'RUNNING', 'CANCELLING')
     AND "heartbeatAt" + make_interval(secs => "leaseSeconds") >= now()
     AND "createdAt" >= now() - interval '30 minutes'
$$;

COMMENT ON FUNCTION app.schedule_candidate_runs_active() IS
  'Schemaförslag (20261125090000): how many candidate runs are active across schools, the ones the sweep would not yet abandon. A number and nothing else; the gateway caps concurrent runs with it.';

-- ---------------------------------------------------------------------------
-- Grants, guarded
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  r text;
BEGIN
  -- ALL, so that on Postgres 17 MAINTAIN goes too.
  FOREACH r IN ARRAY ARRAY['app_authenticated', 'authenticated', 'anon', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "ScheduleCandidateRuns" FROM %I', r);
      EXECUTE format('REVOKE ALL ON "ScheduleCandidates" FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION app.schedule_candidates_sweep() FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION app.schedule_candidate_runs_active() FROM %I', r);
    END IF;
  END LOOP;
  REVOKE ALL ON FUNCTION app.schedule_candidates_sweep() FROM PUBLIC;
  REVOKE ALL ON FUNCTION app.schedule_candidate_runs_active() FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "ScheduleCandidateRuns" TO "app_authenticated";
    GRANT SELECT, INSERT, DELETE ON "ScheduleCandidates" TO "app_authenticated";
    GRANT EXECUTE ON FUNCTION app.schedule_candidates_sweep() TO "app_authenticated";
    GRANT EXECUTE ON FUNCTION app.schedule_candidate_runs_active() TO "app_authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT ON "ScheduleCandidateRuns" TO "service_role";
    GRANT SELECT ON "ScheduleCandidates" TO "service_role";
  END IF;
END
$$;
