-- En synk visar sina ändringar innan de görs.
--
-- A run reads the roster from the school's SS12000 source (20261014090000)
-- and compares it with SchemaPro's people, classes, guardian links and duty
-- links. It does not write them. It writes a DIFF — one row per change it
-- would make (create, link, update, move, deactivate, add, end) or cannot
-- make (a conflict, named) — and an admin reads it and applies the selected
-- changes in one transaction. A nightly run does the same, and applies only
-- the safe kinds of change, and only when the admin turned that on. This
-- migration is the run log and the diff.
--
-- ## Ss12000SyncRuns: every run, kept
--
-- trigger MANUAL ("Synka nu") or SCHEDULED; mode FULL or INCREMENTAL; status
--
--   RUNNING -> FETCH_FAILED | NO_CHANGES | DIFF_READY | SKIPPED
--   DIFF_READY -> APPLIED | APPLY_FAILED | DISCARDED | SUPERSEDED
--
-- with statusCode naming why (SS12000_SOURCE_EMPTY, STALE, EXPIRED,
-- REVIEW_PENDING, a fetch's code). One RUNNING run per source (a partial
-- unique index: "Synka nu" during a run answers 409); a newer DIFF_READY
-- supersedes the older, so only the newest diff can be applied. Once a run
-- is terminal its status never moves again (SS409), which is also what
-- makes applying one run twice a 409. counts (per entity and op, plus
-- requests, pages and retries) and errors ([{code, entity, externalId}],
-- at most 200) hold ids and numbers only. basisHash is the sha256 of every
-- local row the diff compared; the apply recomputes it and refuses a diff
-- the school changed underneath (409 SS12000_DIFF_STALE). The run row is
-- the log, read newest first in "Synkhistorik".
--
-- ## Ss12000SyncChanges: the diff, and the one exception to "Users only"
--
-- schema.prisma has said since the first commit that Users is the ONLY table
-- that stores PII. A diff an admin can review needs the names and email it
-- would write ("Ella Ek -> Ella Berg") beside the row they would go to, so
-- before / after hold the columns SchemaPro writes: first and last name,
-- email, role, class and group names, ids. That is the exception, and it is
-- bounded:
--
--   * Only a DIFF_READY run's changes hold it. The moment a run reaches any
--     other status — APPLIED, APPLY_FAILED, DISCARDED, SUPERSEDED,
--     FETCH_FAILED, SKIPPED, NO_CHANGES — the AFTER UPDATE OF status trigger
--     app.ss12000_sync_changes_minimise nulls before and after (and the
--     protected-identity flag) of every change of that run. What stays is
--     op, entity, codes, ids and whether it was applied.
--   * A DIFF_READY run older than 30 days is DISCARDED with code EXPIRED by
--     the scheduler's housekeeping (app.ss12000_housekeeping), which
--     minimises it by the same trigger.
--   * A change's before / after may never be set again on a terminal run
--     (the guard app.ss12000_sync_changes_stay_minimised, SS409).
--   * civicNo, addresses, phone numbers, photo, birth date and sex are
--     dropped when a record is parsed and never reach a change, a log or
--     the database. A person's protected identity (securityMarking other
--     than "Ingen") is not stored either: it is re-read every run, makes
--     every change for that person deselected and never auto-applied, and
--     the flag saying so goes with the minimisation.
--   * Admin-only: TEACHER, STUDENT and GUARDIAN have no arm.
--
-- The alternative was an AES-encrypted payload decrypted for the review
-- screen; it protects nothing the RLS arms do not (the reader is the same
-- admin) and keeps the data no shorter.
--
-- selected is the default the diff proposes (CONFLICT and INFO rows are
-- never selected); autoApplicable says whether a scheduled run with auto-
-- apply may make it (names, a class move, a teaching-group add, a guardian
-- link between already-linked unprotected people, a duty link, and the
-- deactivation of a pupil or guardian; never a create, link, email change,
-- reactivation or staff deactivation); applied records that it was made.
--
-- ## Who reads and writes
--
--   * The school's SCHOOL_ADMIN: SELECT, INSERT (a MANUAL RUNNING run, the
--     "Synka nu" that the background then fills) and UPDATE of runs;
--     SELECT and UPDATE of changes (selection, applied).
--   * The sync principal of the school: SELECT, INSERT and UPDATE of both.
--   * Nobody DELETEs: no arm, no grant. Rows go with their school.
--
-- ## The scheduler's functions
--
-- SECURITY DEFINER, search_path pinned, EXECUTE for app_authenticated
-- only, called in PrismaService.withDeliveryService (no principal).
--
--   * app.ss12000_due_sources(limit, now) claims sources that are enabled,
--     scheduled, have an organisation, whose school-local hour is AT OR
--     AFTER scheduleHourLocal and that have not run this local day: FOR
--     UPDATE SKIP LOCKED, writing schedulerClaimedAt and the local date, so
--     two API instances never run one source. ">=" and not "=": the default
--     02 does not exist in Europe/Stockholm on the spring-forward Sunday
--     (02:00 CET jumps to 03:00 CEST), so "=" would skip that night, and
--     ">=" also catches up after downtime; the date keeps the autumn's
--     repeated hour from running twice. It answers whether the run is due
--     FULL (never applied, every fullEveryDays, or the provider refused
--     incremental filters). `now` is a parameter so the RLS suite can ask
--     about a DST night; the gateway passes nothing.
--   * app.ss12000_housekeeping(now): RUNNING runs older than 15 minutes are
--     FETCH_FAILED (STALE: a process died), DIFF_READY runs older than 30
--     days DISCARDED (EXPIRED).
--
-- Grants guarded as in 20261013110000. The migration ends with
-- SS12000_RUN_REACH.

CREATE TYPE "Ss12000RunTrigger" AS ENUM ('MANUAL', 'SCHEDULED');
CREATE TYPE "Ss12000RunMode" AS ENUM ('FULL', 'INCREMENTAL');
CREATE TYPE "Ss12000RunStatus" AS ENUM (
    'RUNNING', 'FETCH_FAILED', 'NO_CHANGES', 'DIFF_READY', 'APPLIED', 'APPLY_FAILED', 'DISCARDED', 'SUPERSEDED', 'SKIPPED');
CREATE TYPE "Ss12000ChangeEntity" AS ENUM (
    'PERSON', 'GROUP', 'CLASS_MEMBERSHIP', 'GROUP_MEMBERSHIP', 'RESPONSIBLE', 'DUTY_LINK', 'ORGANISATION');
CREATE TYPE "Ss12000ChangeOp" AS ENUM (
    'CREATE', 'LINK', 'RELINK', 'UPDATE', 'MOVE', 'DEACTIVATE', 'REACTIVATE', 'ADD', 'END', 'CONFLICT', 'INFO');

CREATE TABLE "Ss12000SyncRuns" (
    "id"                     UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"               UUID NOT NULL,
    "sourceId"               UUID NOT NULL,
    "trigger"                "Ss12000RunTrigger" NOT NULL,
    "mode"                   "Ss12000RunMode" NOT NULL,
    "status"                 "Ss12000RunStatus" NOT NULL DEFAULT 'RUNNING',
    "statusCode"             TEXT,
    "requestedById"          UUID,
    "startedAt"              TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "fetchedAt"              TIMESTAMPTZ(6),
    "finishedAt"             TIMESTAMPTZ(6),
    "appliedAt"              TIMESTAMPTZ(6),
    "appliedById"            UUID,
    "autoApplied"            BOOLEAN NOT NULL DEFAULT false,
    "providerClock"          TIMESTAMPTZ(6),
    "cursorFromModified"     TIMESTAMPTZ(6),
    "cursorFromDeleted"      TIMESTAMPTZ(6),
    "cursorTo"               TIMESTAMPTZ(6),
    "counts"                 JSONB NOT NULL DEFAULT '{}',
    "errors"                 JSONB NOT NULL DEFAULT '[]',
    "basisHash"              TEXT,
    "autoApplyBlockedReason" TEXT,

    CONSTRAINT "Ss12000SyncRuns_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Ss12000SyncRuns_statusCode_is_a_code" CHECK ("statusCode" IS NULL OR "statusCode" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
    CONSTRAINT "Ss12000SyncRuns_blocked_reason_is_a_code" CHECK ("autoApplyBlockedReason" IS NULL OR "autoApplyBlockedReason" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
    CONSTRAINT "Ss12000SyncRuns_basisHash_is_sha256" CHECK ("basisHash" IS NULL OR "basisHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "Ss12000SyncRuns_counts_is_an_object" CHECK (jsonb_typeof("counts") = 'object'),
    CONSTRAINT "Ss12000SyncRuns_errors_are_few" CHECK (jsonb_typeof("errors") = 'array' AND jsonb_array_length("errors") <= 200),
    CONSTRAINT "Ss12000SyncRuns_applied_has_a_time" CHECK ("status" <> 'APPLIED' OR "appliedAt" IS NOT NULL),
    CONSTRAINT "Ss12000SyncRuns_diff_has_a_basis" CHECK ("status" <> 'DIFF_READY' OR "basisHash" IS NOT NULL)
);

CREATE UNIQUE INDEX "Ss12000SyncRuns_id_schoolId_key" ON "Ss12000SyncRuns"("id", "schoolId");
CREATE UNIQUE INDEX "Ss12000SyncRuns_one_running_per_source" ON "Ss12000SyncRuns"("sourceId") WHERE "status" = 'RUNNING';
CREATE INDEX "Ss12000SyncRuns_schoolId_startedAt_idx" ON "Ss12000SyncRuns"("schoolId", "startedAt" DESC);
CREATE INDEX "Ss12000SyncRuns_open_idx" ON "Ss12000SyncRuns"("status", "startedAt") WHERE "status" IN ('RUNNING', 'DIFF_READY');

ALTER TABLE "Ss12000SyncRuns"
    ADD CONSTRAINT "Ss12000SyncRuns_sourceId_schoolId_fkey"
    FOREIGN KEY ("sourceId", "schoolId") REFERENCES "Ss12000Sources"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Ss12000SyncChanges" (
    "id"                UUID NOT NULL DEFAULT gen_random_uuid(),
    "runId"             UUID NOT NULL,
    "schoolId"          UUID NOT NULL,
    "seq"               INTEGER NOT NULL,
    "entity"            "Ss12000ChangeEntity" NOT NULL,
    "op"                "Ss12000ChangeOp" NOT NULL,
    "externalId"        UUID,
    "localId"           UUID,
    "before"            JSONB,
    "after"             JSONB,
    "conflictCode"      TEXT,
    "selected"          BOOLEAN NOT NULL,
    "autoApplicable"    BOOLEAN NOT NULL DEFAULT false,
    "protectedIdentity" BOOLEAN NOT NULL DEFAULT false,
    "applied"           BOOLEAN NOT NULL DEFAULT false,
    "createdAt"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "Ss12000SyncChanges_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Ss12000SyncChanges_seq_is_sane" CHECK ("seq" >= 0),
    CONSTRAINT "Ss12000SyncChanges_conflictCode_is_a_code" CHECK ("conflictCode" IS NULL OR "conflictCode" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
    CONSTRAINT "Ss12000SyncChanges_notes_are_never_selected" CHECK ("op" NOT IN ('CONFLICT', 'INFO') OR (NOT "selected" AND NOT "applied" AND NOT "autoApplicable")),
    CONSTRAINT "Ss12000SyncChanges_protected_is_never_automatic" CHECK (NOT ("protectedIdentity" AND "autoApplicable")),
    CONSTRAINT "Ss12000SyncChanges_payload_is_bounded" CHECK (
        coalesce(pg_column_size("before"), 0) + coalesce(pg_column_size("after"), 0) <= 8192)
);

CREATE UNIQUE INDEX "Ss12000SyncChanges_runId_seq_key" ON "Ss12000SyncChanges"("runId", "seq");
CREATE INDEX "Ss12000SyncChanges_runId_schoolId_idx" ON "Ss12000SyncChanges"("runId", "schoolId");
CREATE INDEX "Ss12000SyncChanges_applied_deactivations_idx" ON "Ss12000SyncChanges"("schoolId", "localId")
    WHERE "op" = 'DEACTIVATE' AND "applied";

ALTER TABLE "Ss12000SyncChanges"
    ADD CONSTRAINT "Ss12000SyncChanges_runId_schoolId_fkey"
    FOREIGN KEY ("runId", "schoolId") REFERENCES "Ss12000SyncRuns"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- A terminal run stays terminal, and its changes stay minimised.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.ss12000_sync_runs_stay_terminal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF OLD."status" NOT IN ('RUNNING', 'DIFF_READY') AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'SS12000_RUN_IS_FINISHED: en avslutad synk ändrar inte status'
      USING ERRCODE = 'SS409',
            DETAIL  = format('from=%s to=%s', OLD."status", NEW."status");
  END IF;
  IF NEW."schoolId" IS DISTINCT FROM OLD."schoolId" OR NEW."sourceId" IS DISTINCT FROM OLD."sourceId" THEN
    RAISE EXCEPTION 'SS12000_RUN_IS_FIXED: en synk byter inte källsystem' USING ERRCODE = 'SS409';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Ss12000SyncRuns_stay_terminal"
    BEFORE UPDATE ON "Ss12000SyncRuns"
    FOR EACH ROW EXECUTE FUNCTION app.ss12000_sync_runs_stay_terminal();

CREATE FUNCTION app.ss12000_sync_changes_minimise() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  UPDATE "Ss12000SyncChanges"
     SET "before" = NULL, "after" = NULL, "protectedIdentity" = false
   WHERE "runId" = NEW."id" AND "schoolId" = NEW."schoolId"
     AND ("before" IS NOT NULL OR "after" IS NOT NULL OR "protectedIdentity");
  RETURN NULL;
END
$$;

CREATE TRIGGER "Ss12000SyncRuns_minimise_on_finish"
    AFTER UPDATE OF "status" ON "Ss12000SyncRuns"
    FOR EACH ROW
    WHEN (OLD."status" IS DISTINCT FROM NEW."status" AND NEW."status" NOT IN ('RUNNING', 'DIFF_READY'))
    EXECUTE FUNCTION app.ss12000_sync_changes_minimise();

CREATE FUNCTION app.ss12000_sync_changes_stay_minimised() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF (NEW."before" IS NOT NULL OR NEW."after" IS NOT NULL OR NEW."protectedIdentity")
     AND EXISTS (SELECT 1 FROM "Ss12000SyncRuns" r
                  WHERE r."id" = NEW."runId" AND r."schoolId" = NEW."schoolId"
                    AND r."status" NOT IN ('RUNNING', 'DIFF_READY')) THEN
    RAISE EXCEPTION 'SS12000_CHANGES_ARE_MINIMISED: en avslutad synks ändringar bär inga personuppgifter'
      USING ERRCODE = 'SS409';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."runId" IS DISTINCT FROM OLD."runId" OR NEW."seq" IS DISTINCT FROM OLD."seq"
                           OR NEW."op" IS DISTINCT FROM OLD."op" OR NEW."entity" IS DISTINCT FROM OLD."entity"
                           OR NEW."externalId" IS DISTINCT FROM OLD."externalId" OR NEW."localId" IS DISTINCT FROM OLD."localId"
                           OR NEW."conflictCode" IS DISTINCT FROM OLD."conflictCode"
                           OR NEW."autoApplicable" IS DISTINCT FROM OLD."autoApplicable"
                           OR (NEW."protectedIdentity" AND NOT OLD."protectedIdentity")) THEN
    RAISE EXCEPTION 'SS12000_CHANGE_IS_FIXED: en ändring i en synk skrivs om bara i sitt urval' USING ERRCODE = 'SS409';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Ss12000SyncChanges_stay_minimised"
    BEFORE INSERT OR UPDATE ON "Ss12000SyncChanges"
    FOR EACH ROW EXECUTE FUNCTION app.ss12000_sync_changes_stay_minimised();

REVOKE ALL ON FUNCTION app.ss12000_sync_runs_stay_terminal() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.ss12000_sync_changes_minimise() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.ss12000_sync_changes_stay_minimised() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- The scheduler's functions. See the preamble.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.ss12000_due_sources(p_limit integer, p_now timestamptz DEFAULT now())
RETURNS TABLE (source_id uuid, school_id uuid, full_due boolean, local_date date)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT s."id", (p_now AT TIME ZONE coalesce(sc."timezone", 'Europe/Stockholm'))::date AS today
      FROM "Ss12000Sources" s
      JOIN "Schools" sc ON sc."id" = s."schoolId"
     WHERE s."enabled" AND s."scheduleEnabled"
       AND cardinality(s."organisationIds") > 0
       AND extract(hour FROM (p_now AT TIME ZONE coalesce(sc."timezone", 'Europe/Stockholm'))) >= s."scheduleHourLocal"
       AND (s."lastScheduledLocalDate" IS NULL
            OR s."lastScheduledLocalDate" < (p_now AT TIME ZONE coalesce(sc."timezone", 'Europe/Stockholm'))::date)
     ORDER BY s."lastScheduledLocalDate" NULLS FIRST, s."id"
     LIMIT greatest(least(p_limit, 50), 0)
       FOR UPDATE OF s SKIP LOCKED
  )
  UPDATE "Ss12000Sources" s
     SET "schedulerClaimedAt" = p_now, "lastScheduledLocalDate" = due.today
    FROM due
   WHERE s."id" = due."id"
  RETURNING s."id", s."schoolId",
            (s."lastFullAt" IS NULL OR s."modifiedCursor" IS NULL OR s."incrementalUnsupported"
             OR s."lastFullAt" < p_now - make_interval(days => s."fullEveryDays")),
            due.today;
END
$$;

CREATE FUNCTION app.ss12000_housekeeping(p_now timestamptz DEFAULT now())
RETURNS TABLE (stale integer, expired integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  n_stale integer;
  n_expired integer;
BEGIN
  UPDATE "Ss12000SyncRuns"
     SET "status" = 'FETCH_FAILED', "statusCode" = 'STALE', "finishedAt" = p_now
   WHERE "status" = 'RUNNING' AND "startedAt" < p_now - interval '15 minutes';
  GET DIAGNOSTICS n_stale = ROW_COUNT;
  UPDATE "Ss12000SyncRuns"
     SET "status" = 'DISCARDED', "statusCode" = 'EXPIRED', "finishedAt" = p_now
   WHERE "status" = 'DIFF_READY' AND coalesce("fetchedAt", "startedAt") < p_now - interval '30 days';
  GET DIAGNOSTICS n_expired = ROW_COUNT;
  RETURN QUERY SELECT n_stale, n_expired;
END
$$;

COMMENT ON FUNCTION app.ss12000_due_sources(integer, timestamptz) IS
  'Claims scheduled sources whose school-local hour is at or past scheduleHourLocal and that have not run this local day (SKIP LOCKED).';
COMMENT ON FUNCTION app.ss12000_housekeeping(timestamptz) IS
  'Marks RUNNING runs older than 15 minutes FETCH_FAILED (STALE) and DIFF_READY runs older than 30 days DISCARDED (EXPIRED).';

-- ---------------------------------------------------------------------------
-- Row-level security. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "Ss12000SyncRuns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Ss12000SyncChanges" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ss12000_sync_runs_admin_select" ON "Ss12000SyncRuns"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
CREATE POLICY "ss12000_sync_runs_admin_insert" ON "Ss12000SyncRuns"
    FOR INSERT TO "authenticated"
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                AND "trigger" = 'MANUAL' AND "status" = 'RUNNING');
CREATE POLICY "ss12000_sync_runs_admin_update" ON "Ss12000SyncRuns"
    FOR UPDATE TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

CREATE POLICY "ss12000_sync_changes_admin_select" ON "Ss12000SyncChanges"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
CREATE POLICY "ss12000_sync_changes_admin_update" ON "Ss12000SyncChanges"
    FOR UPDATE TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

CREATE POLICY "ss12000_sync_runs_sync_select" ON "Ss12000SyncRuns"
    FOR SELECT
    USING ("schoolId" = app.current_sync_school_id());
CREATE POLICY "ss12000_sync_runs_sync_insert" ON "Ss12000SyncRuns"
    FOR INSERT
    WITH CHECK ("schoolId" = app.current_sync_school_id());
CREATE POLICY "ss12000_sync_runs_sync_update" ON "Ss12000SyncRuns"
    FOR UPDATE
    USING ("schoolId" = app.current_sync_school_id())
    WITH CHECK ("schoolId" = app.current_sync_school_id());

CREATE POLICY "ss12000_sync_changes_sync_select" ON "Ss12000SyncChanges"
    FOR SELECT
    USING ("schoolId" = app.current_sync_school_id());
CREATE POLICY "ss12000_sync_changes_sync_insert" ON "Ss12000SyncChanges"
    FOR INSERT
    WITH CHECK ("schoolId" = app.current_sync_school_id());
CREATE POLICY "ss12000_sync_changes_sync_update" ON "Ss12000SyncChanges"
    FOR UPDATE
    USING ("schoolId" = app.current_sync_school_id())
    WITH CHECK ("schoolId" = app.current_sync_school_id());

-- ---------------------------------------------------------------------------
-- Grants, guarded.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  fn text;
  r text;
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['Ss12000SyncRuns', 'Ss12000SyncChanges'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO "app_authenticated"', tbl);
      EXECUTE format('REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM "app_authenticated"', tbl);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM "authenticated"', tbl);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON %I FROM "anon"', tbl);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM "service_role"', tbl);
    END IF;
  END LOOP;

  FOREACH fn IN ARRAY ARRAY[
    'app.ss12000_due_sources(integer, timestamptz)',
    'app.ss12000_housekeeping(timestamptz)'
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

-- ---------------------------------------------------------------------------
-- SS12000_RUN_REACH: the runs and changes are reached by the school's admin
-- (claims' school AND SCHOOL_ADMIN) and the sync principal, never DELETE or
-- ALL, never with an OR.
-- ---------------------------------------------------------------------------

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(p.tablename || '.' || p.policyname, ', ' ORDER BY p.tablename, p.policyname) INTO bad
    FROM pg_policies p
   WHERE p.schemaname = 'public'
     AND p.tablename IN ('Ss12000SyncRuns', 'Ss12000SyncChanges')
     AND (
           p.permissive <> 'PERMISSIVE'
        OR p.cmd NOT IN ('SELECT', 'INSERT', 'UPDATE')
        OR coalesce(p.qual, '') || coalesce(p.with_check, '') ~* '\mOR\M'
        OR NOT (
             (p.roles = '{authenticated}'::name[]
              AND coalesce(p.qual, p.with_check) LIKE '%current_school_id()%'
              AND coalesce(p.qual, p.with_check) LIKE '%SCHOOL_ADMIN%')
          OR coalesce(p.qual, p.with_check) LIKE '%current_sync_school_id()%')
     );
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'SS12000_RUN_REACH: these arms reach the sync log beyond the admin and the sync: %', bad;
  END IF;
END
$$;
