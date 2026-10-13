-- Skolan ser vem som har läst om en person.
--
-- A school must be able to answer "who has read about this pupil?" (a
-- guardian asks, the dataskyddsombud follows up, an incident is looked
-- into), and it cannot answer it from what SchemaPro kept: nothing recorded
-- a read. This migration adds the read log, the one function that writes it,
-- and its retention as a Gallring kind. The gateway records every read of
-- another person's personal data through it (src/access-log), and
-- /admin/dataskydd answers the question and exports the answer.
--
-- ## The log ("PersonalDataAccess"), append-only
--
-- One row per request that returned other people's personal data, per kind
-- of data:
--
--   * "at"          clock_timestamp() of the write, in the read's transaction;
--   * "actorId"     the reader's Users row, and "actorRole" their role then.
--                   NULL for an integration key. A deleted reader's row
--                   leaves "actorId" NULL and the role standing; a
--                   pseudonymised reader is the pseudonym, as everywhere;
--   * "apiKeyId"    the integration key (IntegrationApiKeys) of an SS12000
--                   read; NULL once the key is deleted;
--   * "channel"     WEB, APP or OTHER as the gateway was told by the client
--                   (a description, not a permission), INTEGRATION for a key;
--   * "kind"        what was read, below;
--   * "subjectIds"  the people whose data the response carried: pupils,
--                   teachers, guardians. Never the reader themself.
--
-- The kinds ("PersonalDataAccessKind"):
--
--   PEOPLE                   names and contact details (the people list, an
--                            SS12000 person);
--   ROSTER                   who is in a group or on a lesson (the register);
--   ATTENDANCE               attendance marks;
--   ABSENCE_REPORTS          reported absence, with its type and note;
--   LEAVE_REQUESTS           leave requests, with their reason and decision;
--   LEAVE_REASON_AS_MENTOR   a mentor read a leave request's reason under
--                            the school's delegation (Skoldagen); added now
--                            so that phase records it without a migration;
--   GUARDIANS                who is whose guardian;
--   EMPLOYMENT               tjänst and anställning (HR);
--   STAFF_ABSENCES           when a member of staff is away, and why;
--   ACCESS_LOG               this log, read about a person.
--
-- Nothing here holds the data that was read, only that it was read: no name,
-- no note, no reason.
--
-- ## Grain and dedupe
--
-- Per request, carrying the ids it returned. A teacher opens the register
-- of the same lesson many times in a few minutes, and the app re-reads it, so
-- a person already in a row of the same reader (or key) and kind written in
-- the last 15 minutes is left out of the next one, and a read that adds
-- nobody writes no row. "Who read about the pupil" is therefore answered to
-- the quarter-hour, which is the question; how often within it is not.
--
-- ## The writer, app.personal_data_read(kind, channel, subjects)
--
-- SECURITY DEFINER, EXECUTE for app_authenticated only: PostgREST's
-- authenticated cannot call it, so no client can write a row, forge a reader
-- or fill the log. No API role holds INSERT on the table. The function takes
-- the reader from the transaction, never from an argument:
--
--   * a person (withRls): app.current_user_id(), current_user_role() and
--     current_school_id() from the verified claims; the channel is the
--     caller's WEB or APP, anything else OTHER;
--   * the service principal (withServicePrincipal, an SS12000 key):
--     app.current_service_school_id() and app.current_service_key_id(),
--     channel INTEGRATION;
--   * nobody, or the sync principal (the sync reads its own source and
--     delivers nothing to anyone): PD403, and the read fails with it.
--
-- Of the ids given it keeps those that are Users of the reader's school, other
-- than the reader, not already logged under the dedupe, and writes them in
-- one row; it answers how many it wrote. It runs in the read's own
-- transaction: a read whose log cannot be written fails, so the log has no
-- holes the gateway knows of.
--
-- ## Who reads the log
--
-- The school's SCHOOL_ADMIN, through the gateway only (the arm is TO
-- app_authenticated): GET /api/v1/access-log, which records its own read as
-- ACCESS_LOG about the person asked about.
--
-- Append-only by trigger, as RetentionDecisions: UPDATE, DELETE and TRUNCATE
-- are refused, except a school's or a reader's or key's referential action
-- (cascade, SET NULL) and the school's own gallring (below).
--
-- ## Retention: ACCESS_LOG (20261026090000)
--
-- The log is personal data about the reader and the person read about, so it
-- has its own period on /admin/dataskydd. It starts at "ej beslutat" in every
-- school and nothing of it goes until the school decides. app.gallring_due
-- and app.gallring_purge gain one branch each: rows of the school whose "at"
-- is before the cutoff (the school's local midnight). Every other branch is
-- the body of 20261021110000 unchanged.

CREATE TYPE "PersonalDataAccessKind" AS ENUM (
    'PEOPLE', 'ROSTER', 'ATTENDANCE', 'ABSENCE_REPORTS', 'LEAVE_REQUESTS',
    'LEAVE_REASON_AS_MENTOR', 'GUARDIANS', 'EMPLOYMENT', 'STAFF_ABSENCES',
    'ACCESS_LOG'
);
CREATE TYPE "PersonalDataAccessChannel" AS ENUM ('WEB', 'APP', 'INTEGRATION', 'OTHER');

CREATE TABLE "PersonalDataAccess" (
    "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"   UUID NOT NULL,
    "at"         TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "actorId"    UUID,
    "actorRole"  "UserRole",
    "apiKeyId"   UUID,
    "channel"    "PersonalDataAccessChannel" NOT NULL,
    "kind"       "PersonalDataAccessKind" NOT NULL,
    "subjectIds" UUID[] NOT NULL,

    CONSTRAINT "PersonalDataAccess_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PersonalDataAccess_names_somebody" CHECK (
        cardinality("subjectIds") >= 1 AND array_position("subjectIds", NULL) IS NULL
    ),
    -- A person reads with a role; a key has none and reads as an integration.
    CONSTRAINT "PersonalDataAccess_a_person_or_a_key" CHECK (
        ("channel" = 'INTEGRATION') = ("actorRole" IS NULL)
        AND ("channel" = 'INTEGRATION' OR "apiKeyId" IS NULL)
    )
);

-- The question: who read about this person (GIN over the ids), and the
-- gallring's and the date range's scan of a school.
CREATE INDEX "PersonalDataAccess_subjectIds_idx" ON "PersonalDataAccess" USING GIN ("subjectIds");
CREATE INDEX "PersonalDataAccess_schoolId_at_idx" ON "PersonalDataAccess"("schoolId", "at");
-- The dedupe's look back over one reader's (or key's) last quarter-hour.
CREATE INDEX "PersonalDataAccess_actorId_kind_at_idx" ON "PersonalDataAccess"("actorId", "kind", "at")
    WHERE "actorId" IS NOT NULL;
CREATE INDEX "PersonalDataAccess_schoolId_apiKeyId_kind_at_idx" ON "PersonalDataAccess"("schoolId", "apiKeyId", "kind", "at")
    WHERE "channel" = 'INTEGRATION';

ALTER TABLE "PersonalDataAccess"
    ADD CONSTRAINT "PersonalDataAccess_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PersonalDataAccess"
    ADD CONSTRAINT "PersonalDataAccess_actorId_schoolId_fkey"
    FOREIGN KEY ("actorId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE SET NULL ("actorId") ON UPDATE CASCADE;
ALTER TABLE "PersonalDataAccess"
    ADD CONSTRAINT "PersonalDataAccess_apiKeyId_schoolId_fkey"
    FOREIGN KEY ("apiKeyId", "schoolId") REFERENCES "IntegrationApiKeys"("id", "schoolId")
    ON DELETE SET NULL ("apiKeyId") ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Append-only.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.personal_data_access_is_append_only() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  -- A school's, reader's or key's referential action (cascade, SET NULL).
  IF TG_OP <> 'TRUNCATE' AND pg_trigger_depth() > 1 THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  -- gallring: the school's own purge of reads past its period.
  IF TG_OP = 'DELETE' AND app.gallring_in_progress(OLD."schoolId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'PERSONAL_DATA_ACCESS_IS_APPEND_ONLY: läsloggen skrivs bara av databasen och ändras aldrig'
    USING ERRCODE = 'PD409',
          DETAIL  = format('operation=%s', TG_OP);
END
$$;

REVOKE ALL ON FUNCTION app.personal_data_access_is_append_only() FROM PUBLIC;

CREATE TRIGGER "PersonalDataAccess_append_only"
    BEFORE UPDATE OR DELETE ON "PersonalDataAccess"
    FOR EACH ROW EXECUTE FUNCTION app.personal_data_access_is_append_only();
CREATE TRIGGER "PersonalDataAccess_no_truncate"
    BEFORE TRUNCATE ON "PersonalDataAccess"
    FOR EACH STATEMENT EXECUTE FUNCTION app.personal_data_access_is_append_only();

-- ---------------------------------------------------------------------------
-- The writer.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.personal_data_read(
    p_kind "PersonalDataAccessKind",
    p_channel "PersonalDataAccessChannel",
    p_subjects uuid[]
) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  v_school  uuid := app.current_service_school_id();
  v_actor   uuid;
  v_role    "UserRole";
  v_key     uuid;
  v_channel "PersonalDataAccessChannel";
  v_since   timestamptz := clock_timestamp() - interval '15 minutes';
  v_recent  uuid[];
  v_new     uuid[];
BEGIN
  IF p_kind IS NULL THEN
    RAISE EXCEPTION 'PERSONAL_DATA_READ_HAS_A_KIND' USING ERRCODE = 'PD400';
  END IF;
  IF app.current_sync_school_id() IS NOT NULL THEN
    RAISE EXCEPTION 'PERSONAL_DATA_READ_HAS_NO_READER: synken läser åt ingen'
      USING ERRCODE = 'PD403';
  END IF;
  IF v_school IS NOT NULL THEN
    v_key := app.current_service_key_id();
    v_channel := 'INTEGRATION';
    -- A key of another school is no key of this read.
    IF v_key IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM "IntegrationApiKeys" k WHERE k."id" = v_key AND k."schoolId" = v_school) THEN
      RAISE EXCEPTION 'PERSONAL_DATA_READ_HAS_NO_READER: nyckeln hör inte till skolan'
        USING ERRCODE = 'PD403';
    END IF;
  ELSE
    v_actor := app.current_user_id();
    v_school := app.current_school_id();
    v_role := app.current_user_role();
    IF v_actor IS NULL OR v_school IS NULL OR v_role IS NULL THEN
      RAISE EXCEPTION 'PERSONAL_DATA_READ_HAS_NO_READER: ingen inloggad läser'
        USING ERRCODE = 'PD403';
    END IF;
    v_channel := CASE WHEN p_channel IN ('WEB', 'APP') THEN p_channel ELSE 'OTHER' END;
  END IF;

  -- Who this reader (or key) already has in a row of the kind from the last
  -- quarter-hour. One branch per reader, each on its own index.
  IF v_actor IS NOT NULL THEN
    SELECT coalesce(array_agg(DISTINCT s.id), '{}'::uuid[]) INTO v_recent
      FROM "PersonalDataAccess" a, unnest(a."subjectIds") AS s(id)
     WHERE a."actorId" = v_actor AND a."kind" = p_kind AND a."at" > v_since;
  ELSIF v_key IS NOT NULL THEN
    SELECT coalesce(array_agg(DISTINCT s.id), '{}'::uuid[]) INTO v_recent
      FROM "PersonalDataAccess" a, unnest(a."subjectIds") AS s(id)
     WHERE a."schoolId" = v_school AND a."channel" = 'INTEGRATION' AND a."apiKeyId" = v_key
       AND a."kind" = p_kind AND a."at" > v_since;
  ELSE
    SELECT coalesce(array_agg(DISTINCT s.id), '{}'::uuid[]) INTO v_recent
      FROM "PersonalDataAccess" a, unnest(a."subjectIds") AS s(id)
     WHERE a."schoolId" = v_school AND a."channel" = 'INTEGRATION' AND a."apiKeyId" IS NULL
       AND a."kind" = p_kind AND a."at" > v_since;
  END IF;

  SELECT coalesce(array_agg(u."id" ORDER BY u."id"), '{}'::uuid[]) INTO v_new
    FROM "Users" u
   WHERE u."schoolId" = v_school
     AND u."id" = ANY (p_subjects)
     AND u."id" IS DISTINCT FROM v_actor
     AND NOT (u."id" = ANY (v_recent));

  IF cardinality(v_new) = 0 THEN
    RETURN 0;
  END IF;
  INSERT INTO "PersonalDataAccess" ("schoolId", "actorId", "actorRole", "apiKeyId", "channel", "kind", "subjectIds")
  VALUES (v_school, v_actor, v_role, v_key, v_channel, p_kind, v_new);
  RETURN cardinality(v_new);
END
$$;

COMMENT ON FUNCTION app.personal_data_read("PersonalDataAccessKind", "PersonalDataAccessChannel", uuid[]) IS
  'Records that the transaction''s reader (a person by their claims, or an SS12000 key) read p_kind about p_subjects; leaves out the reader, people of other schools and anyone the same reader read of that kind in the last 15 minutes. Answers how many people it recorded.';

-- ---------------------------------------------------------------------------
-- Gallring: ACCESS_LOG. Both bodies are 20261021110000's plus the one branch
-- marked "läslogg".
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.gallring_due(p_school uuid, p_type "RetentionDataType", p_before date, p_today date)
RETURNS TABLE (tbl text, id uuid)
LANGUAGE sql STABLE AS $$
  WITH school AS (
    SELECT s."id", (p_before::timestamp AT TIME ZONE s."timezone") AS before_at
      FROM "public"."Schools" s WHERE s."id" = p_school AND p_before IS NOT NULL
  )
  SELECT 'AttendanceRecords', a."id"
    FROM school, "public"."AttendanceRecords" a
    JOIN "public"."CalendarLessons" l ON l."id" = a."calendarLessonId"
   WHERE p_type = 'ATTENDANCE' AND a."schoolId" = school."id" AND l."date" < p_before
  UNION ALL
  SELECT 'AbsenceReports', r."id"
    FROM school, "public"."AbsenceReports" r
   WHERE p_type = 'ABSENCE_REPORTS' AND r."schoolId" = school."id" AND r."date" < p_before
  UNION ALL
  SELECT 'LeaveRequests', r."id"
    FROM school, "public"."LeaveRequests" r
   WHERE p_type = 'LEAVE_REQUESTS' AND r."schoolId" = school."id" AND r."endDate" < p_before
  UNION ALL
  SELECT 'Notifications', n."id"
    FROM school, "public"."Notifications" n
   WHERE p_type = 'NOTIFICATIONS' AND n."schoolId" = school."id" AND n."createdAt" < school.before_at
  UNION ALL
  SELECT 'ScheduleChangeLogs', c."id"
    FROM school, "public"."ScheduleChangeLogs" c
   WHERE p_type = 'CHANGE_LOGS' AND c."schoolId" = school."id" AND c."createdAt" < school.before_at
  UNION ALL
  SELECT 'TeacherEmploymentLogs', g."id"
    FROM school, "public"."TeacherEmploymentLogs" g
    JOIN "public"."AcademicYears" y ON y."id" = g."academicYearId" AND y."schoolId" = g."schoolId"
   WHERE p_type = 'CHANGE_LOGS' AND g."schoolId" = school."id" AND y."endDate" < p_before
  UNION ALL
  SELECT 'GuardianStudentHistory', h."id"
    FROM school, "public"."GuardianStudentHistory" h
   WHERE p_type = 'CHANGE_LOGS' AND h."schoolId" = school."id" AND h."unlinkedAt" < school.before_at
  UNION ALL
  SELECT 'TeacherAbsences', t."id"
    FROM school, "public"."TeacherAbsences" t
   WHERE p_type = 'ABSENCE_REASONS' AND t."schoolId" = school."id" AND t."reasonId" IS NOT NULL
     AND t."endsAt" < school.before_at
  UNION ALL
  -- läslogg
  SELECT 'PersonalDataAccess', p."id"
    FROM school, "public"."PersonalDataAccess" p
   WHERE p_type = 'ACCESS_LOG' AND p."schoolId" = school."id" AND p."at" < school.before_at
  UNION ALL
  SELECT 'Users', u."id"
    FROM school, "public"."Users" u
   WHERE p_type = 'DEPARTED_PEOPLE' AND u."schoolId" = school."id"
     AND NOT u."isActive" AND u."pseudonymisedAt" IS NULL
     AND u."deactivatedAt" < school.before_at
     AND NOT app.gallring_held_for_scb(u."id", u."schoolId", p_today);
$$;

CREATE OR REPLACE FUNCTION app.gallring_purge(p_run uuid, p_type "RetentionDataType", p_limit integer) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  r "GallringRuns";
  cutoff date;
  today date;
  budget integer := greatest(least(p_limit, 5000), 1);
  n integer := 0;
  step integer;
BEGIN
  IF p_type = 'DEPARTED_PEOPLE' THEN
    RAISE EXCEPTION 'GALLRING_PEOPLE_ARE_PSEUDONYMISED' USING ERRCODE = 'GL400';
  END IF;
  -- FOR UPDATE: one call of a run at a time.
  SELECT * INTO r FROM "GallringRuns" WHERE "id" = p_run AND "status" = 'RUNNING' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GALLRING_RUN_NOT_RUNNING' USING ERRCODE = 'GL404';
  END IF;
  -- Both NULL when nothing of the kind may go: least() of a NULL is the other.
  IF r."cutoffs" ->> p_type::text IS NULL
     OR app.retention_months_in_force(r."schoolId", p_type, clock_timestamp()) IS NULL THEN
    RETURN 0;
  END IF;
  cutoff := app.gallring_run_cutoff(r."schoolId", r."startedAt", r."cutoffs", p_type);
  today := app.gallring_today(r."schoolId", r."startedAt");

  PERFORM set_config('app.gallring', r."schoolId"::text, true);
  CASE p_type
    WHEN 'ATTENDANCE' THEN
      DELETE FROM "AttendanceRecords" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'AttendanceRecords' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
    WHEN 'ABSENCE_REPORTS' THEN
      DELETE FROM "AbsenceReports" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'AbsenceReports' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
    WHEN 'LEAVE_REQUESTS' THEN
      DELETE FROM "LeaveRequests" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'LeaveRequests' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
    WHEN 'NOTIFICATIONS' THEN
      DELETE FROM "Notifications" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'Notifications' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
    WHEN 'CHANGE_LOGS' THEN
      DELETE FROM "ScheduleChangeLogs" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'ScheduleChangeLogs' LIMIT budget);
      GET DIAGNOSTICS step = ROW_COUNT;
      n := step;
      IF n < budget THEN
        DELETE FROM "TeacherEmploymentLogs" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'TeacherEmploymentLogs' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
      IF n < budget THEN
        DELETE FROM "GuardianStudentHistory" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'GuardianStudentHistory' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
    WHEN 'ABSENCE_REASONS' THEN
      UPDATE "TeacherAbsences" SET "reasonId" = NULL WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'TeacherAbsences' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
    -- läslogg
    WHEN 'ACCESS_LOG' THEN
      DELETE FROM "PersonalDataAccess" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'PersonalDataAccess' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
  END CASE;
  PERFORM set_config('app.gallring', '', true);

  UPDATE "GallringRuns" SET
    "counts"   = "counts" || jsonb_build_object(p_type::text, COALESCE(("counts" ->> p_type::text)::bigint, 0) + n),
    "complete" = "complete" || jsonb_build_object(p_type::text, n < budget),
    "cutoffs"  = "cutoffs" || jsonb_build_object(p_type::text, cutoff::text)
   WHERE "id" = p_run;
  RETURN n;
END
$$;

-- ---------------------------------------------------------------------------
-- Row-level security and grants: the school's administrator reads the log
-- through the gateway; nobody writes it but app.personal_data_read.
-- ---------------------------------------------------------------------------

ALTER TABLE "PersonalDataAccess" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    EXECUTE $p$
      CREATE POLICY "personal_data_access_admin_select" ON "PersonalDataAccess"
          FOR SELECT TO "app_authenticated"
          USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    $p$;
    REVOKE ALL ON "PersonalDataAccess" FROM "app_authenticated";
    GRANT SELECT ON "PersonalDataAccess" TO "app_authenticated";
  END IF;
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "PersonalDataAccess" FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "PersonalDataAccess" FROM "service_role";
  END IF;

  REVOKE ALL ON FUNCTION app.personal_data_read("PersonalDataAccessKind", "PersonalDataAccessChannel", uuid[]) FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION app.personal_data_read("PersonalDataAccessKind", "PersonalDataAccessChannel", uuid[]) FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT EXECUTE ON FUNCTION app.personal_data_read("PersonalDataAccessKind", "PersonalDataAccessChannel", uuid[]) TO "app_authenticated";
  END IF;
END
$$;
