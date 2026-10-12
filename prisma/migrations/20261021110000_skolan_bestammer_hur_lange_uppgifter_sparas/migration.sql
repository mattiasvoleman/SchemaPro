-- Skolan bestämmer hur länge uppgifter sparas, och ingenting gallras förrän
-- den har bestämt det.
--
-- A school must not keep personal data longer than its purpose needs, and
-- how long each kind is kept is the huvudman's decision, written down in its
-- dokumenthanteringsplan. SchemaPro kept everything for ever. This migration
-- lets a school's administrator record, per kind of data, how long it is kept
-- (/admin/dataskydd), and lets the nightly job gallra what is older. Until a
-- school records a period for a kind, nothing of that kind is touched: every
-- school starts at "ej beslutat" and nothing is purged on deploy. That is
-- PRODUCT.md principle 6, a school rule is the school's.
--
-- ## The kinds ("RetentionDataType")
--
--   ATTENDANCE       AttendanceRecords of lessons dated before the cutoff.
--   ABSENCE_REPORTS  AbsenceReports dated before it (a granted leave's days
--                    are AbsenceReports too, and follow this kind).
--   LEAVE_REQUESTS   LeaveRequests whose last day is before it: the whole
--                    row, decision, decider and note included, so any
--                    decision column a later phase adds goes with it. A
--                    table that a later phase hangs off LeaveRequests must
--                    cascade; RLS section 81 refuses a foreign key into
--                    LeaveRequests that does not.
--   NOTIFICATIONS    Notifications created before it.
--   CHANGE_LOGS      ScheduleChangeLogs created before it,
--                    GuardianStudentHistory unlinked before it, and the
--                    TeacherEmploymentLogs of every läsår that ended before
--                    it. The tjänst history goes a whole läsår at a time: its
--                    version numbers count on from the highest left, so
--                    removing the oldest rows of a year still in use would
--                    hand out a "Version 1" that an earlier printout already
--                    cites. An undo of a staffing proposal applied before the
--                    cutoff no longer finds the apply (staffing-proposal
--                    appliedBefore reads ScheduleChangeLogs).
--   ABSENCE_REASONS  TeacherAbsences that ended before it keep their row and
--                    lose "reasonId" (NULL). The cover rows stay, so the
--                    vikarie hours and payroll still add up.
--   DEPARTED_PEOPLE  Users deactivated (20261021100000) before it are
--                    pseudonymised in place, see below.
--
-- The cutoff is the school's local date at the run less the period in months
-- (1 to 120). "Gallrat före 2025-10-12" means everything of that kind dated
-- before that day is gone.
--
-- ## Decisions ("RetentionDecisions"), append-only
--
-- One row per decision: PURGE_AFTER with "months", KEEP (bevaras, decided,
-- nothing goes) or UNDECIDED (back to ej beslutat), and an optional reference
-- to the plan (dnr, at most 200 characters). The trigger stamps "decidedAt"
-- (clock_timestamp) and "decidedById" (app.current_user_id()) whatever the
-- statement says, and refuses UPDATE, DELETE and TRUNCATE except by a
-- cascade, so the table is the history of who decided what and when, which
-- the dataskyddsombud asks for. The latest row of a kind is the school's
-- current decision; no row is ej beslutat.
--
-- A decision that gallrar MORE waits a day; one that gallrar less applies at
-- once. app.retention_months_in_force(school, kind, at) is NULL (nothing
-- goes) unless the decision in force 24 hours before `at` was PURGE_AFTER and
-- every decision since was too, and then the LONGEST of those periods. So a
-- wrong choice can be taken back for 24 hours with nothing lost, while
-- lengthening a period, KEEP or UNDECIDED stop the next run at once.
--
-- ## Runs ("GallringRuns"), counts only
--
-- Each night's run of a school is one row: when it started and finished, the
-- periods and cutoffs it applied, and per kind how many rows or people went
-- ("counts"), whether nothing older than the cutoff was left ("complete") and
-- how many it held back ("waiting": people kept for SCB, identities the
-- provider would not delete). No id, no name. A run that never finished is
-- marked INTERRUPTED when the next one begins. app.retention_purged_before()
-- answers, per kind, the latest cutoff a run completed: "gallrat före
-- <datum>", which the reports show instead of an empty table. Runs are kept:
-- they are the evidence.
--
-- ## The functions
--
-- All SECURITY DEFINER with search_path pinned and EXECUTE for
-- app_authenticated only. The nightly job (src/gallring/gallring.job.ts) calls
-- the run functions with no principal, naming the school its claim gave it
-- (app.job_claim_nightly, 20261021090000):
--
--   * app.gallring_schools(): schools whose current decision for some kind is
--     PURGE_AFTER.
--   * app.gallring_begin(school, at): marks a RUNNING run of the school
--     INTERRUPTED, and opens a run with the periods in force and cutoffs.
--     `at` must be within ten minutes of now (GL400), so no caller can
--     step past the 24-hour wait by naming a later time.
--   * app.gallring_purge(run, kind, limit): at most `limit` rows (5 000 at
--     most) of one kind, the count added to the run in the same transaction.
--     It asks for the period in force again and applies the EARLIER of the
--     two cutoffs, so a decision taken during the run only ever spares rows.
--   * app.gallring_departed_due(run, limit) and app.gallring_pseudonymise(run,
--     users): the people due, and then those of them still due. Between the
--     two the gateway deletes each invited person's login at the auth
--     provider (SupabaseAdminService.deleteUser), and a person whose login
--     could not be deleted waits for the next night.
--   * app.gallring_finish(run, waiting): DONE.
--
-- The administrator's page calls, in their own transaction:
--
--   * app.gallring_preview(kind, months): the cutoff a period of `months`
--     would give today, how many rows or people it would take, and how many
--     people it would hold for SCB. GL403 for anyone but the school's
--     SCHOOL_ADMIN.
--   * app.retention_purged_before(): per kind, the date before which it is
--     gallrat, for any active user of the school.
--
-- One predicate decides what is due, app.gallring_due(school, kind, before,
-- today), and both the preview's count and the purge read it, so the page
-- cannot promise one thing and the night do another.
--
-- ## Departed people are pseudonymised, not deleted
--
-- Deleting a Users row cascades a pupil's attendance and is refused for
-- whoever recorded a timplan decision (UsersService.remove). Pseudonymising
-- keeps the row and every reference to it: attendance, timplan decisions,
-- the class history and SCB's rows stay whole, under a name that identifies
-- nobody. For a person deactivated before the cutoff, the run:
--
--   * sets firstName 'Pseudonym', lastName the first six characters of the
--     row's id, e-mail 'pseudonym-<id>@pseudonym.invalid' (unique per school,
--     and .invalid is never delivered), phone and the SS12000 id to NULL,
--     authId to a new random uuid that matches no login, invitedAt to NULL
--     and "pseudonymisedAt" to now;
--   * clears the lärarsignatur and the note of their tjänster, without a
--     version in the tjänst history (a gallring is no change of the tjänst);
--   * removes their guardian links, either side (the unlink is recorded in
--     GuardianStudentHistory as any unlink is), their push devices and
--     tickets, their notification opt-outs and their own notifications.
--
-- What is not touched: rows of other kinds, which follow their own periods,
-- and earlier versions in the tjänst history, which may carry the signature
-- until CHANGE_LOGS takes their läsår.
--
-- SCB's Pedagogisk personal counts who was employed on 15 October and is due
-- on 2 November; the underlag names every teacher with a tjänst that läsår.
-- A person with a TeacherEmployment in a läsår whose first 15 October is
-- less than seven weeks past (until 1 December) is held back and counted in
-- "waiting", so a teacher who leaves in the autumn is not a pseudonym on the
-- school's own SCB file.
--
-- ## The guards that let a purge through
--
-- Three tables are append-only by trigger, and Users' SS12000 id is an
-- admin's to write. A purge sets app.gallring to its school for the length of
-- its statements, and app.gallring_in_progress(school) is true only then:
-- the setting names the school AND no person, service or sync principal is
-- set. The amended guards let exactly this through:
--
--   * app.teacher_employment_logs_append_only and
--     app.guardian_student_history_written_by_trigger: a DELETE of the
--     school's rows.
--   * app.ss12000_ids_are_written_by_an_admin: Users' id set to NULL.
--   * app.teacher_staffing_log_write: writes no version.
--
-- Anyone can set a setting, so the setting alone is no authority, and it is
-- not meant to be: no API role holds DELETE on TeacherEmploymentLogs or
-- GuardianStudentHistory, and with no principal set row security shows no
-- Users or TeacherEmployments row to update. Only the owner's functions can
-- act under it. RLS section 82 runs the forged setting as both API roles.
--
-- ## Undo
--
-- There is none in SchemaPro: a purged row is gone, which is the point. A
-- mistake within the provider's point-in-time recovery window can be
-- restored from it (docs/DEPLOYMENT.md §10). Hence the 24-hour wait, the
-- preview, one kind per decision, and the batch caps in the job.
--
-- Arkivering is not here: what the dokumenthanteringsplan says to bevara
-- must be taken out to the huvudman's e-arkiv before its period ends, and
-- SchemaPro has no such export yet.

CREATE TYPE "RetentionDataType" AS ENUM (
    'ATTENDANCE', 'ABSENCE_REPORTS', 'LEAVE_REQUESTS', 'NOTIFICATIONS',
    'CHANGE_LOGS', 'ABSENCE_REASONS', 'DEPARTED_PEOPLE'
);
CREATE TYPE "RetentionDecisionKind" AS ENUM ('PURGE_AFTER', 'KEEP', 'UNDECIDED');
CREATE TYPE "GallringRunStatus" AS ENUM ('RUNNING', 'DONE', 'INTERRUPTED');

CREATE TABLE "RetentionDecisions" (
    "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"    UUID NOT NULL,
    "dataType"    "RetentionDataType" NOT NULL,
    "decision"    "RetentionDecisionKind" NOT NULL,
    "months"      INTEGER,
    "reference"   TEXT,
    "decidedById" UUID,
    "decidedAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "RetentionDecisions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RetentionDecisions_a_period_has_months" CHECK (("months" IS NOT NULL) = ("decision" = 'PURGE_AFTER')),
    CONSTRAINT "RetentionDecisions_months_are_sane" CHECK ("months" IS NULL OR "months" BETWEEN 1 AND 120),
    CONSTRAINT "RetentionDecisions_reference_is_short" CHECK ("reference" IS NULL OR char_length("reference") BETWEEN 1 AND 200)
);

CREATE INDEX "RetentionDecisions_schoolId_dataType_decidedAt_idx"
    ON "RetentionDecisions"("schoolId", "dataType", "decidedAt" DESC);

ALTER TABLE "RetentionDecisions"
    ADD CONSTRAINT "RetentionDecisions_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
-- The decider is kept while they are a Users row (pseudonymised or not), and
-- NULL once the row is deleted: the decision stands without them.
ALTER TABLE "RetentionDecisions"
    ADD CONSTRAINT "RetentionDecisions_decidedById_schoolId_fkey"
    FOREIGN KEY ("decidedById", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE SET NULL ("decidedById") ON UPDATE CASCADE;

CREATE TABLE "GallringRuns" (
    "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"   UUID NOT NULL,
    "localDay"   DATE NOT NULL,
    "status"     "GallringRunStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt"  TIMESTAMPTZ(6) NOT NULL,
    "finishedAt" TIMESTAMPTZ(6),
    "periods"    JSONB NOT NULL DEFAULT '{}',
    "cutoffs"    JSONB NOT NULL DEFAULT '{}',
    "counts"     JSONB NOT NULL DEFAULT '{}',
    "complete"   JSONB NOT NULL DEFAULT '{}',
    "waiting"    JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "GallringRuns_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GallringRuns_finished_when_not_running" CHECK (("status" = 'RUNNING') = ("finishedAt" IS NULL)),
    -- Counts only: every value a non-negative integer (months, rows, people),
    -- a date, or a boolean, under the name of a kind.
    CONSTRAINT "GallringRuns_holds_counts_only" CHECK (
        jsonb_typeof("periods") = 'object' AND jsonb_typeof("cutoffs") = 'object'
        AND jsonb_typeof("counts") = 'object' AND jsonb_typeof("complete") = 'object'
        AND jsonb_typeof("waiting") = 'object'
        AND NOT jsonb_path_exists("periods" || "cutoffs" || "counts" || "complete" || "waiting",
              '$.keyvalue() ? (!(@.key like_regex "^[A-Z_]{1,40}$"))')
        AND NOT jsonb_path_exists("periods", '$.* ? (@.type() != "number" || @ < 1 || @ > 120 || @ != @.floor())')
        AND NOT jsonb_path_exists("counts" || "waiting", '$.* ? (@.type() != "number" || @ < 0 || @ != @.floor())')
        AND NOT jsonb_path_exists("cutoffs", '$.* ? (@.type() != "string" || !(@ like_regex "^[0-9]{4}-[0-9]{2}-[0-9]{2}$"))')
        AND NOT jsonb_path_exists("complete", '$.* ? (@.type() != "boolean")')
    )
);

CREATE INDEX "GallringRuns_schoolId_startedAt_idx" ON "GallringRuns"("schoolId", "startedAt" DESC);

ALTER TABLE "GallringRuns"
    ADD CONSTRAINT "GallringRuns_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Gallring's own date predicates (AbsenceReports has (schoolId, date) already).
CREATE INDEX "LeaveRequests_schoolId_endDate_idx" ON "LeaveRequests"("schoolId", "endDate");
CREATE INDEX "Notifications_schoolId_createdAt_idx" ON "Notifications"("schoolId", "createdAt");
CREATE INDEX "ScheduleChangeLogs_schoolId_createdAt_idx" ON "ScheduleChangeLogs"("schoolId", "createdAt");
CREATE INDEX "GuardianStudentHistory_schoolId_unlinkedAt_idx" ON "GuardianStudentHistory"("schoolId", "unlinkedAt");
CREATE INDEX "TeacherAbsences_schoolId_endsAt_idx" ON "TeacherAbsences"("schoolId", "endsAt") WHERE "reasonId" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- RetentionDecisions: stamped and append-only.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.retention_decisions_are_stamped() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  NEW."decidedAt" := clock_timestamp();
  NEW."decidedById" := app.current_user_id();
  RETURN NEW;
END
$$;

CREATE FUNCTION app.retention_decisions_are_append_only() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  -- A school's or a decider's referential action (cascade, SET NULL).
  IF TG_OP <> 'TRUNCATE' AND pg_trigger_depth() > 1 THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'RETENTION_DECISIONS_ARE_APPEND_ONLY: ett beslut om gallring ändras inte, ett nytt beslut ersätter det'
    USING ERRCODE = 'GL409',
          DETAIL  = format('operation=%s', TG_OP);
END
$$;

REVOKE ALL ON FUNCTION app.retention_decisions_are_stamped() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.retention_decisions_are_append_only() FROM PUBLIC;

CREATE TRIGGER "RetentionDecisions_stamped"
    BEFORE INSERT ON "RetentionDecisions"
    FOR EACH ROW EXECUTE FUNCTION app.retention_decisions_are_stamped();
CREATE TRIGGER "RetentionDecisions_append_only"
    BEFORE UPDATE OR DELETE ON "RetentionDecisions"
    FOR EACH ROW EXECUTE FUNCTION app.retention_decisions_are_append_only();
CREATE TRIGGER "RetentionDecisions_no_truncate"
    BEFORE TRUNCATE ON "RetentionDecisions"
    FOR EACH STATEMENT EXECUTE FUNCTION app.retention_decisions_are_append_only();

-- ---------------------------------------------------------------------------
-- Row-level security: the school's administrator reads both tables and
-- records a decision; nobody else reaches them, and no API role writes a run.
-- ---------------------------------------------------------------------------

ALTER TABLE "RetentionDecisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GallringRuns" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "retention_decisions_admin_select" ON "RetentionDecisions"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

CREATE POLICY "retention_decisions_admin_insert" ON "RetentionDecisions"
    FOR INSERT TO "authenticated"
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

CREATE POLICY "gallring_runs_admin_select" ON "GallringRuns"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

-- ---------------------------------------------------------------------------
-- The guards, amended. Each function is its earlier body plus the one branch
-- marked "gallring".
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.gallring_in_progress(p_school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT p_school IS NOT NULL
     AND current_setting('app.gallring', true) = p_school::text
     AND app.current_user_id() IS NULL
     AND app.current_service_school_id() IS NULL
     AND app.current_sync_school_id() IS NULL;
$$;

REVOKE ALL ON FUNCTION app.gallring_in_progress(uuid) FROM PUBLIC;

-- 20261010090000.
CREATE OR REPLACE FUNCTION app.teacher_employment_logs_append_only() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  -- TRUNCATE (a statement trigger): never, at any depth.
  IF TG_OP <> 'TRUNCATE' AND pg_trigger_depth() > 1 THEN
    -- INSERT: the logging trigger's own write. UPDATE/DELETE: a parent's
    -- referential action (an id renamed, a person, year or school deleted).
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  -- gallring: the school's own purge of a läsår past its period.
  IF TG_OP = 'DELETE' AND app.gallring_in_progress(OLD."schoolId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'TEACHER_EMPLOYMENT_LOG_IS_APPEND_ONLY: en tjänsts historik skrivs bara av databasen och ändras aldrig'
    USING ERRCODE = 'TL403',
          DETAIL  = format('operation=%s', TG_OP);
END
$$;

-- 20261010090000.
CREATE OR REPLACE FUNCTION app.teacher_staffing_log_write(
    p_school uuid, p_user uuid, p_year uuid,
    p_entity "TeacherLogEntity", p_entity_id uuid, p_action "TeacherLogAction",
    p_before jsonb, p_after jsonb, p_actor uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  next_version integer;
BEGIN
  -- Inside a cascade the outer statement's delete is visible: a person, year
  -- or school being deleted is already gone, and its history goes with it.
  -- Asked of every row: a cascade's AFTER triggers report depth 1 too.
  IF NOT (
       EXISTS (SELECT 1 FROM "Schools" s WHERE s."id" = p_school)
       AND EXISTS (SELECT 1 FROM "Users" u WHERE u."id" = p_user AND u."schoolId" = p_school)
       AND EXISTS (SELECT 1 FROM "AcademicYears" y WHERE y."id" = p_year AND y."schoolId" = p_school)
     ) THEN
    RETURN;
  END IF;
  -- gallring: pseudonymising a departed person clears their signature and
  -- note, which is no version of the tjänst.
  IF app.gallring_in_progress(p_school) THEN
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_user::text || ':' || p_year::text, 0));
  SELECT COALESCE(max(l."version"), 0) + 1
    INTO next_version
    FROM "TeacherEmploymentLogs" l
   WHERE l."schoolId" = p_school AND l."userId" = p_user AND l."academicYearId" = p_year;

  INSERT INTO "TeacherEmploymentLogs"
      ("schoolId", "userId", "academicYearId", "version", "entity", "entityId",
       "action", "before", "after", "actorId", "createdAt")
  VALUES (p_school, p_user, p_year, next_version, p_entity, p_entity_id,
          p_action, p_before, p_after, p_actor, clock_timestamp());
END
$$;

-- 20261014100000.
CREATE OR REPLACE FUNCTION app.ss12000_ids_are_written_by_an_admin() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF app.current_service_school_id() IS NULL
     AND app.current_sync_school_id() IS NULL
     AND app.current_user_role() = 'SCHOOL_ADMIN'
     AND app.current_school_id() = NEW."schoolId" THEN
    RETURN NEW;
  END IF;
  -- gallring: a pseudonymised person keeps no source id.
  IF TG_TABLE_NAME = 'Users' AND TG_OP = 'UPDATE' AND NEW."ss12000Id" IS NULL
     AND app.gallring_in_progress(NEW."schoolId") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'SS12000_ID_IS_WRITTEN_BY_AN_ADMIN: bara skolans administratör kopplar en rad till källsystemet'
    USING ERRCODE = 'SS403',
          DETAIL  = format('table=%s operation=%s', TG_TABLE_NAME, TG_OP);
END
$$;

-- 20261014100000.
CREATE OR REPLACE FUNCTION app.guardian_student_history_written_by_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF TG_OP <> 'TRUNCATE' AND pg_trigger_depth() > 1 THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  -- gallring: the school's own purge of unlinks past its period.
  IF TG_OP = 'DELETE' AND app.gallring_in_progress(OLD."schoolId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'GUARDIAN_HISTORY_IS_RECORDED: historiken över vårdnadshavarkopplingar skrivs bara av databasen'
    USING ERRCODE = 'SS403',
          DETAIL  = format('operation=%s', TG_OP);
END
$$;

-- ---------------------------------------------------------------------------
-- Periods and cutoffs.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.retention_months_in_force(p_school uuid, p_type "RetentionDataType", p_at timestamptz)
RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  v_then "RetentionDecisionKind";
  v_months integer;
  v_since record;
BEGIN
  SELECT d."decision", d."months" INTO v_then, v_months
    FROM "RetentionDecisions" d
   WHERE d."schoolId" = p_school AND d."dataType" = p_type
     AND d."decidedAt" <= p_at - interval '24 hours'
   ORDER BY d."decidedAt" DESC, d."id" DESC
   LIMIT 1;
  IF NOT FOUND OR v_then <> 'PURGE_AFTER' THEN
    RETURN NULL;
  END IF;
  FOR v_since IN
    SELECT d."decision", d."months"
      FROM "RetentionDecisions" d
     WHERE d."schoolId" = p_school AND d."dataType" = p_type
       AND d."decidedAt" > p_at - interval '24 hours' AND d."decidedAt" <= p_at
  LOOP
    IF v_since."decision" <> 'PURGE_AFTER' THEN
      RETURN NULL;
    END IF;
    v_months := greatest(v_months, v_since."months");
  END LOOP;
  RETURN v_months;
END
$$;

-- The school's local date at p_at.
CREATE FUNCTION app.gallring_today(p_school uuid, p_at timestamptz) RETURNS date
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT (p_at AT TIME ZONE s."timezone")::date FROM "Schools" s WHERE s."id" = p_school;
$$;

CREATE FUNCTION app.retention_cutoff(p_school uuid, p_months integer, p_at timestamptz) RETURNS date
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT (app.gallring_today(p_school, p_at) - make_interval(months => p_months))::date
   WHERE p_months IS NOT NULL;
$$;

-- Whether SCB's underlag may still name the person: a tjänst in a läsår whose
-- first 15 October (on or after its start) is less than seven weeks past.
CREATE FUNCTION app.gallring_held_for_scb(p_user uuid, p_school uuid, p_today date) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT EXISTS (
    SELECT 1
      FROM "TeacherEmployments" e
      JOIN "AcademicYears" y ON y."id" = e."academicYearId" AND y."schoolId" = e."schoolId"
     WHERE e."userId" = p_user AND e."schoolId" = p_school
       AND p_today < make_date(
             extract(year FROM y."startDate")::int
               + CASE WHEN y."startDate" > make_date(extract(year FROM y."startDate")::int, 10, 15) THEN 1 ELSE 0 END,
             12, 1)
  );
$$;

-- What is due of one kind before p_before: the one predicate the preview's
-- count and the purge both read. Rows of the school only. Not SECURITY
-- DEFINER and with no SET, so the planner inlines it into its callers (the
-- owner's functions below) and a purge's LIMIT stops the scan early; every
-- name is schema-qualified for the same reason. EXECUTE is the owner's.
CREATE FUNCTION app.gallring_due(p_school uuid, p_type "RetentionDataType", p_before date, p_today date)
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
  SELECT 'Users', u."id"
    FROM school, "public"."Users" u
   WHERE p_type = 'DEPARTED_PEOPLE' AND u."schoolId" = school."id"
     AND NOT u."isActive" AND u."pseudonymisedAt" IS NULL
     AND u."deactivatedAt" < school.before_at
     AND NOT app.gallring_held_for_scb(u."id", u."schoolId", p_today);
$$;

-- People past the period that SCB's rule holds back.
CREATE FUNCTION app.gallring_held(p_school uuid, p_before date, p_today date) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT count(*)
    FROM "Users" u, "Schools" s
   WHERE s."id" = p_school AND u."schoolId" = s."id" AND p_before IS NOT NULL
     AND NOT u."isActive" AND u."pseudonymisedAt" IS NULL
     AND u."deactivatedAt" < (p_before::timestamp AT TIME ZONE s."timezone")
     AND app.gallring_held_for_scb(u."id", u."schoolId", p_today);
$$;

REVOKE ALL ON FUNCTION app.retention_months_in_force(uuid, "RetentionDataType", timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.gallring_today(uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.retention_cutoff(uuid, integer, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.gallring_held_for_scb(uuid, uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.gallring_due(uuid, "RetentionDataType", date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.gallring_held(uuid, date, date) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- The night's run.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.gallring_schools() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT DISTINCT latest."schoolId"
    FROM (SELECT DISTINCT ON (d."schoolId", d."dataType") d."schoolId", d."decision"
            FROM "RetentionDecisions" d
           ORDER BY d."schoolId", d."dataType", d."decidedAt" DESC, d."id" DESC) latest
   WHERE latest."decision" = 'PURGE_AFTER';
$$;

CREATE FUNCTION app.gallring_begin(p_school uuid, p_at timestamptz) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  v_kind "RetentionDataType";
  v_months integer;
  v_periods jsonb := '{}';
  v_cutoffs jsonb := '{}';
  v_run uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Schools" s WHERE s."id" = p_school) THEN
    RAISE EXCEPTION 'GALLRING_NO_SCHOOL' USING ERRCODE = 'GL404';
  END IF;
  -- A run is tonight's: a time far from now would read another day's
  -- decisions, and a later one would step past the 24-hour wait.
  IF p_at NOT BETWEEN clock_timestamp() - interval '10 minutes' AND clock_timestamp() + interval '10 minutes' THEN
    RAISE EXCEPTION 'GALLRING_RUN_IS_NOW' USING ERRCODE = 'GL400';
  END IF;
  UPDATE "GallringRuns" SET "status" = 'INTERRUPTED', "finishedAt" = p_at
   WHERE "schoolId" = p_school AND "status" = 'RUNNING';
  FOREACH v_kind IN ARRAY enum_range(NULL::"RetentionDataType") LOOP
    v_months := app.retention_months_in_force(p_school, v_kind, p_at);
    IF v_months IS NOT NULL THEN
      v_periods := v_periods || jsonb_build_object(v_kind::text, v_months);
      v_cutoffs := v_cutoffs || jsonb_build_object(v_kind::text, app.retention_cutoff(p_school, v_months, p_at)::text);
    END IF;
  END LOOP;
  INSERT INTO "GallringRuns" ("schoolId", "localDay", "startedAt", "periods", "cutoffs")
  VALUES (p_school, app.gallring_today(p_school, p_at), p_at, v_periods, v_cutoffs)
  RETURNING "id" INTO v_run;
  RETURN v_run;
END
$$;

-- The cutoff a call of the run applies to a kind: the run's, or an earlier one
-- if the period in force now is longer; NULL when nothing of the kind may go.
CREATE FUNCTION app.gallring_run_cutoff(p_school uuid, p_started timestamptz, p_cutoffs jsonb, p_type "RetentionDataType")
RETURNS date
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT least((p_cutoffs ->> p_type::text)::date,
               app.retention_cutoff(p_school, app.retention_months_in_force(p_school, p_type, clock_timestamp()), p_started));
$$;

REVOKE ALL ON FUNCTION app.gallring_run_cutoff(uuid, timestamptz, jsonb, "RetentionDataType") FROM PUBLIC;

CREATE FUNCTION app.gallring_purge(p_run uuid, p_type "RetentionDataType", p_limit integer) RETURNS integer
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

CREATE FUNCTION app.gallring_departed_due(p_run uuid, p_limit integer)
RETURNS TABLE (user_id uuid, auth_id uuid, invited boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  r "GallringRuns";
  cutoff date;
  today date;
BEGIN
  SELECT * INTO r FROM "GallringRuns" WHERE "id" = p_run AND "status" = 'RUNNING' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GALLRING_RUN_NOT_RUNNING' USING ERRCODE = 'GL404';
  END IF;
  IF r."cutoffs" ->> 'DEPARTED_PEOPLE' IS NULL
     OR app.retention_months_in_force(r."schoolId", 'DEPARTED_PEOPLE', clock_timestamp()) IS NULL THEN
    RETURN;
  END IF;
  cutoff := app.gallring_run_cutoff(r."schoolId", r."startedAt", r."cutoffs", 'DEPARTED_PEOPLE');
  today := app.gallring_today(r."schoolId", r."startedAt");
  UPDATE "GallringRuns" SET
    "waiting" = "waiting" || jsonb_build_object('DEPARTED_PEOPLE_SCB', app.gallring_held(r."schoolId", cutoff, today))
   WHERE "id" = p_run;
  RETURN QUERY
  SELECT u."id", u."authId", u."invitedAt" IS NOT NULL
    FROM app.gallring_due(r."schoolId", 'DEPARTED_PEOPLE', cutoff, today) d
    JOIN "Users" u ON u."id" = d."id"
   ORDER BY u."deactivatedAt", u."id"
   LIMIT greatest(least(p_limit, 500), 0);
END
$$;

CREATE FUNCTION app.gallring_pseudonymise(p_run uuid, p_users uuid[]) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  r "GallringRuns";
  cutoff date;
  today date;
  due uuid[];
  n integer;
BEGIN
  SELECT * INTO r FROM "GallringRuns" WHERE "id" = p_run AND "status" = 'RUNNING' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GALLRING_RUN_NOT_RUNNING' USING ERRCODE = 'GL404';
  END IF;
  IF r."cutoffs" ->> 'DEPARTED_PEOPLE' IS NULL
     OR app.retention_months_in_force(r."schoolId", 'DEPARTED_PEOPLE', clock_timestamp()) IS NULL THEN
    RETURN 0;
  END IF;
  cutoff := app.gallring_run_cutoff(r."schoolId", r."startedAt", r."cutoffs", 'DEPARTED_PEOPLE');
  today := app.gallring_today(r."schoolId", r."startedAt");
  -- Asked again: somebody reactivated since the list was read is not due.
  due := ARRAY(
    SELECT d."id" FROM app.gallring_due(r."schoolId", 'DEPARTED_PEOPLE', cutoff, today) d
     WHERE d."id" = ANY (p_users)
     ORDER BY d."id"
     LIMIT 500);

  PERFORM set_config('app.gallring', r."schoolId"::text, true);
  UPDATE "Users" u SET
      "firstName"       = 'Pseudonym',
      "lastName"        = upper(left(replace(u."id"::text, '-', ''), 6)),
      "email"           = 'pseudonym-' || u."id"::text || '@pseudonym.invalid',
      "phone"           = NULL,
      "ss12000Id"       = NULL,
      "authId"          = gen_random_uuid(),
      "invitedAt"       = NULL,
      "pseudonymisedAt" = now(),
      "updatedAt"       = now()
   WHERE u."schoolId" = r."schoolId" AND u."id" = ANY (due);
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE "TeacherEmployments" SET "signature" = NULL, "note" = NULL
   WHERE "schoolId" = r."schoolId" AND "userId" = ANY (due)
     AND ("signature" IS NOT NULL OR "note" IS NOT NULL);
  DELETE FROM "GuardianStudents"
   WHERE "schoolId" = r."schoolId" AND ("guardianId" = ANY (due) OR "studentId" = ANY (due));
  DELETE FROM "PushTickets" p USING "DevicePushTokens" t
   WHERE p."tokenId" = t."id" AND p."schoolId" = t."schoolId"
     AND t."schoolId" = r."schoolId" AND t."userId" = ANY (due);
  DELETE FROM "DevicePushTokens" WHERE "schoolId" = r."schoolId" AND "userId" = ANY (due);
  DELETE FROM "NotificationOptOuts" WHERE "schoolId" = r."schoolId" AND "userId" = ANY (due);
  DELETE FROM "Notifications" WHERE "schoolId" = r."schoolId" AND "userId" = ANY (due);
  PERFORM set_config('app.gallring', '', true);

  UPDATE "GallringRuns" SET
    "counts" = "counts" || jsonb_build_object('DEPARTED_PEOPLE', COALESCE(("counts" ->> 'DEPARTED_PEOPLE')::bigint, 0) + n),
    "cutoffs" = "cutoffs" || jsonb_build_object('DEPARTED_PEOPLE', cutoff::text)
   WHERE "id" = p_run;
  RETURN n;
END
$$;

CREATE FUNCTION app.gallring_finish(p_run uuid, p_waiting jsonb, p_at timestamptz) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  r "GallringRuns";
  left_people bigint;
BEGIN
  SELECT * INTO r FROM "GallringRuns" WHERE "id" = p_run AND "status" = 'RUNNING' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GALLRING_RUN_NOT_RUNNING' USING ERRCODE = 'GL404';
  END IF;
  -- People: complete when nobody past the cutoff is left but those held.
  IF r."cutoffs" ? 'DEPARTED_PEOPLE' THEN
    SELECT count(*) INTO left_people
      FROM app.gallring_due(r."schoolId", 'DEPARTED_PEOPLE', (r."cutoffs" ->> 'DEPARTED_PEOPLE')::date,
                            app.gallring_today(r."schoolId", r."startedAt"));
    r."complete" := r."complete" || jsonb_build_object('DEPARTED_PEOPLE', left_people = 0);
  END IF;
  UPDATE "GallringRuns" SET
    "status" = 'DONE', "finishedAt" = p_at,
    "complete" = r."complete",
    "waiting" = "waiting" || COALESCE(p_waiting, '{}'::jsonb)
   WHERE "id" = p_run;
END
$$;

-- ---------------------------------------------------------------------------
-- The administrator's page.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.gallring_preview(p_type "RetentionDataType", p_months integer)
RETURNS TABLE (cutoff date, due bigint, held bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  school uuid := app.current_school_id();
  today date;
  c date;
BEGIN
  IF school IS NULL OR app.current_user_role() IS DISTINCT FROM 'SCHOOL_ADMIN'
     OR app.current_service_school_id() IS NOT NULL OR app.current_sync_school_id() IS NOT NULL THEN
    RAISE EXCEPTION 'GALLRING_PREVIEW_IS_THE_ADMINS: bara skolans administratör ser vad som skulle gallras'
      USING ERRCODE = 'GL403';
  END IF;
  IF p_months IS NULL OR p_months NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'GALLRING_MONTHS_OUT_OF_RANGE' USING ERRCODE = 'GL400';
  END IF;
  today := app.gallring_today(school, now());
  c := app.retention_cutoff(school, p_months, now());
  RETURN QUERY
  SELECT c,
         (SELECT count(*) FROM app.gallring_due(school, p_type, c, today)),
         CASE WHEN p_type = 'DEPARTED_PEOPLE' THEN app.gallring_held(school, c, today) ELSE 0 END;
END
$$;

CREATE FUNCTION app.retention_purged_before()
RETURNS TABLE (data_type "RetentionDataType", purged_before date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT k.kind, max((r."cutoffs" ->> k.kind::text)::date)
    FROM "GallringRuns" r
   CROSS JOIN unnest(enum_range(NULL::"RetentionDataType")) AS k(kind)
   WHERE r."schoolId" = app.current_school_id()
     AND k.kind <> 'DEPARTED_PEOPLE'
     AND (r."complete" ->> k.kind::text)::boolean
   GROUP BY k.kind;
$$;

COMMENT ON FUNCTION app.retention_months_in_force(uuid, "RetentionDataType", timestamptz) IS
  'The period in months a run at p_at applies to a kind: NULL unless the decision in force 24 h earlier and every one since is PURGE_AFTER, then the longest of them.';
COMMENT ON FUNCTION app.gallring_due(uuid, "RetentionDataType", date, date) IS
  'The rows (or people) of one kind of p_school due before p_before: the predicate both the preview and the purge read.';
COMMENT ON FUNCTION app.gallring_begin(uuid, timestamptz) IS
  'Opens the night''s gallring run of a school with the periods in force and their cutoffs; an unfinished earlier run is INTERRUPTED.';
COMMENT ON FUNCTION app.gallring_purge(uuid, "RetentionDataType", integer) IS
  'Purges at most p_limit rows of one kind for a run and counts them on it; never more than the period in force now allows.';
COMMENT ON FUNCTION app.gallring_departed_due(uuid, integer) IS
  'The departed people a run may pseudonymise, with the login to delete first; counts those held for SCB.';
COMMENT ON FUNCTION app.gallring_pseudonymise(uuid, uuid[]) IS
  'Pseudonymises those of p_users still due: name, e-mail, phone, source id and login replaced, guardian links, devices and own notices removed.';
COMMENT ON FUNCTION app.gallring_preview("RetentionDataType", integer) IS
  'For the school''s SCHOOL_ADMIN: the cutoff a period of p_months gives today and how many rows or people it would take.';
COMMENT ON FUNCTION app.retention_purged_before() IS
  'Per kind, the latest cutoff a gallring run of the caller''s school completed: "gallrat före".';

-- ---------------------------------------------------------------------------
-- Grants, guarded.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  fn text;
  r text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    REVOKE ALL ON "RetentionDecisions" FROM "app_authenticated";
    REVOKE ALL ON "GallringRuns" FROM "app_authenticated";
    GRANT SELECT ON "RetentionDecisions" TO "app_authenticated";
    GRANT INSERT ("schoolId", "dataType", "decision", "months", "reference") ON "RetentionDecisions" TO "app_authenticated";
    GRANT SELECT ON "GallringRuns" TO "app_authenticated";
  END IF;
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "RetentionDecisions" FROM %I', r);
      EXECUTE format('REVOKE ALL ON "GallringRuns" FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "RetentionDecisions" FROM "service_role";
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "GallringRuns" FROM "service_role";
  END IF;

  FOREACH fn IN ARRAY ARRAY[
    'app.gallring_schools()',
    'app.gallring_begin(uuid, timestamptz)',
    'app.gallring_purge(uuid, "RetentionDataType", integer)',
    'app.gallring_departed_due(uuid, integer)',
    'app.gallring_pseudonymise(uuid, uuid[])',
    'app.gallring_finish(uuid, jsonb, timestamptz)',
    'app.gallring_preview("RetentionDataType", integer)',
    'app.retention_purged_before()'
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
