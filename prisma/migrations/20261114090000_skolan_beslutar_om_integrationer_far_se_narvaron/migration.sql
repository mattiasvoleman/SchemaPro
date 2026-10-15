-- Skolan beslutar om integrationer får se närvaron.
--
-- SS12000-närvaro: the provider (/ss12000/v2.0) serves S1's Attendance and
-- Absence (SIS SS12000 OpenAPI 2.1.0, sha256 aee9a95a…cd28) for a school
-- that has decided to, and to a key that holds the scope. Off by default.
-- What leaves is minutes and giltig or ogiltig per lesson, and an absence's
-- time and kind: never a reason, never a note, never a leave request's
-- reason. docs/integration-api.md "Attendances and Absences" is the field
-- list; this migration is what the database adds for it.
--
-- ## The school's decision ("AttendanceSharingDecisions"), append-only
--
-- Rektor's decision, as LeaveDelegationDecisions (20261023091000): one row
-- per decision, the latest in force, no row = not shared. "shares" and an
-- optional "reference" (the school's konsekvensbedömning or decision, at
-- most 200 characters); decidedAt and decidedById are stamped by a trigger,
-- never sent. Append-only (DELETE, UPDATE and TRUNCATE are refused with
-- SQLSTATE NV409 except a school's or a decider's referential action), so
-- the record of who opened and who closed the school's attendance to
-- integrations stays. The decider's key does not follow a user moved to
-- another school (ON UPDATE NO ACTION): a decision never changes school. The
-- school's SCHOOL_ADMINs read and insert; nobody else has an arm.
--
-- app.attendance_shared(school) is the decision in force (the owner's,
-- nobody's EXECUTE). app.service_reads_attendance(scope), under the service
-- principal: true only when the key the request authenticated with is the
-- school's, not revoked, holds the scope, and the school shares.
--
-- ## The provider reads columns, not rows
--
-- No arm is added to AttendanceRecords or AbsenceReports: under the service
-- principal they still read as empty. The provider reads them through two
-- SECURITY DEFINER functions that answer only the columns it emits, as
-- teachers read the absence register through app.reported_absences
-- (20261015120000) and the provider its identity through
-- app.ss12000_provider_identity():
--
--   app.ss12000_attendances(...)  id, lesson, pupil, status, createdAt, the
--       lesson's times and group, and the version; never note or
--       recordedById or recordedAt;
--   app.ss12000_absences(...)     id, pupil, date and times (as text),
--       grantedLeave, createdAt; never note, type or reportedById.
--
-- Each answers only under app.service_reads_attendance with its own scope
-- (attendances.read, absences.read), only the service principal's school,
-- only active pupils, and attendance only of the emitted years (calendar
-- events' rule, app.ss12000_year_is_emitted). Both are the API's alone.
--
-- ## An absence that is a granted leave says so: AbsenceReports.grantedLeave
--
-- S1's Absence.type is "Beviljad ledighet" or "Anmäld frånvaro". A granted
-- leave writes one full-day AbsenceReports row per skoldag (LeaveService,
-- 20261015090000), and until now only its note said so ('Approved leave',
-- type OTHER), which a guardian could write too. A note is free text the
-- provider never reads. So a column, false by default, that the leave
-- decision sets (LeaveService) and a guard keeps the decision's:
--
--   * app.absence_reports_granted_leave_is_decided (BEFORE INSERT OR
--     UPDATE): grantedLeave may become true only for a SCHOOL_ADMIN or a
--     TEACHER (the two who decide leave; a teacher reaches AbsenceReports
--     only through absence_reports_mentor_leave_insert), or with no person
--     at all (the owner, the seed, gallring). A guardian or a pupil who
--     sends it gets SQLSTATE NV403. A decider's insert that has the decision's
--     shape (type OTHER, note 'Approved leave', no times) is marked by the
--     guard itself, so the API deployed before this migration's code, which
--     does not send the column, writes it right in the minutes between the two.
--   * The rows already written by a decision are backfilled by that shape,
--     filed by a SCHOOL_ADMIN or a TEACHER. A guardian's or a pupil's report
--     with that note stays an anmäld frånvaro.
--   * AbsenceReports_ends_after_it_starts: a reported span ends after it
--     starts (NOT VALID: every write from now on; a row already written is
--     left, and emitted as the whole day).
--
-- ## meta.modified and /deletedEntities, while the school shares
--
-- Ss12000EntityVersions and Ss12000Tombstones take two more resources,
-- 'Attendance' (entityId and emitted id: AttendanceRecords.id) and
-- 'Absence' (AbsenceReports.id). Written by statement-level triggers with
-- transition tables (20261014130000's preamble), here by NEW trigger
-- functions on NEW triggers, so no existing trigger function changes —
-- and ONLY WHILE THE SCHOOL SHARES. A school that has not decided writes no
-- version and no tombstone of a pupil's attendance (nothing of it is read,
-- and gallring's nightly purge would otherwise write one per row); when it
-- starts, an integration reads it whole, and a row then dated by its own
-- creation; when it stops, the integration must delete what it holds, and is
-- told so by 403 NOT_SHARED (docs/integration-api.md). What moves what:
--
--   AttendanceRecords  insert or a change of status, lesson or pupil moves
--                      the Attendance (not recordedAt: the register stamps it
--                      anew at every save, and it is not emitted); a delete
--                      buries it — gallring's too (app.gallring_purge), so
--                      /deletedEntities follows the purge.
--   AbsenceReports     insert or a change of date, times, grantedLeave or
--                      pupil moves the Absence; a delete buries it.
--   Users              a pupil deactivated (or no longer a pupil) buries the
--                      pupil's attendances and absences; reactivated unburies
--                      and moves them; a changed ss12000Id moves them.
--   CalendarLessons    new times (the minutes) or a new group move the
--                      lesson's attendances.
--   Schools            a new timezone moves the school's absences (a
--                      full-day absence is the school's local day).
--   AcademicYears      a year activated: its lessons' attendances, emitted
--                      from now on, are versioned.
--
-- The emitted years are found once per statement, never per row.
--
-- ## Notices
--
-- app.ss12000_due_notifications is replaced with the same signature and
-- grants: a subscription's 'Attendance' and 'Absence' count only while the
-- school shares and its key holds the scope (app.ss12000_notifies, asked
-- once per subscription), so a receiver is never told that attendance
-- changed at a school that has stopped sharing, nor by a key that lost the
-- scope. Everything else is the body of 20261014130000.
--
-- The service principal's arms on the versions and tombstones answer an
-- Attendance or Absence row only to a request that may read that resource
-- (app.service_reads_attendance), so a key without the scope does not learn
-- even their ids and times.
--
-- ## Locks
--
-- The script runs as one transaction. The triggers on the busy tables
-- (Users, CalendarLessons, AttendanceRecords, AbsenceReports, Schools,
-- AcademicYears) are created before anything locks the versions and
-- tombstones, which come last: a lesson edit that waits for this migration
-- holds nothing it needs. lock_timeout makes a busy database fail the
-- migration in seconds rather than stall the school.
--
-- ## Grants
--
-- AttendanceSharingDecisions: REVOKE ALL from every API role; SELECT and
-- INSERT (schoolId, shares, reference) to app_authenticated; SELECT to
-- service_role. Functions: the trigger functions, the helpers,
-- app.attendance_shared and app.ss12000_notifies are nobody's;
-- app.service_reads_attendance and the two read functions are
-- app_authenticated's alone.

SET lock_timeout = '10s';

-- ---------------------------------------------------------------------------
-- The school's decision
-- ---------------------------------------------------------------------------

CREATE TABLE "AttendanceSharingDecisions" (
    "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"    UUID NOT NULL,
    "shares"      BOOLEAN NOT NULL,
    "reference"   TEXT,
    "decidedById" UUID,
    "decidedAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "AttendanceSharingDecisions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AttendanceSharingDecisions_reference_is_short" CHECK ("reference" IS NULL OR char_length("reference") BETWEEN 1 AND 200)
);

CREATE INDEX "AttendanceSharingDecisions_schoolId_decidedAt_idx"
    ON "AttendanceSharingDecisions"("schoolId", "decidedAt" DESC);

ALTER TABLE "AttendanceSharingDecisions"
    ADD CONSTRAINT "AttendanceSharingDecisions_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttendanceSharingDecisions"
    ADD CONSTRAINT "AttendanceSharingDecisions_decidedById_schoolId_fkey"
    FOREIGN KEY ("decidedById", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE SET NULL ("decidedById") ON UPDATE NO ACTION;

CREATE FUNCTION app.attendance_sharing_decisions_are_stamped() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  NEW."decidedAt" := clock_timestamp();
  NEW."decidedById" := app.current_user_id();
  RETURN NEW;
END
$$;

CREATE FUNCTION app.attendance_sharing_decisions_are_append_only() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  -- A school's or a decider's referential action (cascade, SET NULL).
  IF TG_OP <> 'TRUNCATE' AND pg_trigger_depth() > 1 THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ATTENDANCE_SHARING_IS_APPEND_ONLY: skolans beslut om närvaron till integrationer ändras inte, ett nytt beslut ersätter det'
    USING ERRCODE = 'NV409',
          DETAIL  = format('operation=%s', TG_OP);
END
$$;

CREATE TRIGGER "AttendanceSharingDecisions_stamped"
    BEFORE INSERT ON "AttendanceSharingDecisions"
    FOR EACH ROW EXECUTE FUNCTION app.attendance_sharing_decisions_are_stamped();
CREATE TRIGGER "AttendanceSharingDecisions_append_only"
    BEFORE UPDATE OR DELETE ON "AttendanceSharingDecisions"
    FOR EACH ROW EXECUTE FUNCTION app.attendance_sharing_decisions_are_append_only();
CREATE TRIGGER "AttendanceSharingDecisions_no_truncate"
    BEFORE TRUNCATE ON "AttendanceSharingDecisions"
    FOR EACH STATEMENT EXECUTE FUNCTION app.attendance_sharing_decisions_are_append_only();

ALTER TABLE "AttendanceSharingDecisions" ENABLE ROW LEVEL SECURITY;

-- The decision in force: the school's latest; none is not shared.
CREATE FUNCTION app.attendance_shared(p_school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT coalesce((
    SELECT d."shares"
      FROM "AttendanceSharingDecisions" d
     WHERE d."schoolId" = p_school
     ORDER BY d."decidedAt" DESC, d."id" DESC
     LIMIT 1), false)
$$;

COMMENT ON FUNCTION app.attendance_shared(uuid) IS
  'Whether the school''s decision in force shares attendance and absence with integrations (SS12000). No decision is not shared.';

-- Under the service principal: the request's key is the school's, live, holds
-- the scope, and the school shares. Anything else, false.
CREATE FUNCTION app.service_reads_attendance(p_scope text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT p_scope IN ('attendances.read', 'absences.read')
     AND app.current_service_school_id() IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM "IntegrationApiKeys" k
        WHERE k."id" = app.current_service_key_id()
          AND k."schoolId" = app.current_service_school_id()
          AND k."revokedAt" IS NULL
          AND p_scope = ANY (k."scopes"))
     AND app.attendance_shared(app.current_service_school_id())
$$;

COMMENT ON FUNCTION app.service_reads_attendance(text) IS
  'True under the service principal when the request''s integration key is the school''s, not revoked, holds the scope (attendances.read or absences.read), and the school shares attendance (app.attendance_shared).';

-- ---------------------------------------------------------------------------
-- A granted leave's absence, and a span that ends after it starts
-- ---------------------------------------------------------------------------

ALTER TABLE "AbsenceReports" ADD COLUMN "grantedLeave" BOOLEAN NOT NULL DEFAULT false;

UPDATE "AbsenceReports" a
   SET "grantedLeave" = true
  FROM "Users" u
 WHERE u."id" = a."reportedById"
   AND u."schoolId" = a."schoolId"
   AND u."role" IN ('SCHOOL_ADMIN', 'TEACHER')
   AND a."type" = 'OTHER'
   AND a."note" = 'Approved leave'
   AND a."startTime" IS NULL
   AND a."endTime" IS NULL;

CREATE FUNCTION app.absence_reports_granted_leave_is_decided() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  decider boolean := app.current_user_id() IS NULL
                     OR app.current_user_role() IN ('SCHOOL_ADMIN', 'TEACHER');
BEGIN
  IF NEW."grantedLeave" AND (TG_OP = 'INSERT' OR NOT OLD."grantedLeave") AND NOT decider THEN
    RAISE EXCEPTION 'GRANTED_LEAVE_IS_DECIDED: bara ett beslut om ledighet skriver en beviljad ledighet'
      USING ERRCODE = 'NV403',
            DETAIL  = format('operation=%s', TG_OP);
  END IF;
  -- A decider's insert in the decision's shape is the decision's, also from
  -- an API that does not send the column yet (the minutes of a deploy).
  IF TG_OP = 'INSERT' AND NOT NEW."grantedLeave" AND decider AND app.current_user_id() IS NOT NULL
     AND NEW."type" = 'OTHER' AND NEW."note" = 'Approved leave'
     AND NEW."startTime" IS NULL AND NEW."endTime" IS NULL THEN
    NEW."grantedLeave" := true;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "AbsenceReports_granted_leave_is_decided"
    BEFORE INSERT OR UPDATE ON "AbsenceReports"
    FOR EACH ROW EXECUTE FUNCTION app.absence_reports_granted_leave_is_decided();

ALTER TABLE "AbsenceReports"
    ADD CONSTRAINT "AbsenceReports_ends_after_it_starts"
    CHECK ("startTime" IS NULL OR "endTime" IS NULL OR "endTime" > "startTime") NOT VALID;

-- /attendances pages by id within one school (S1 gives it no window), so
-- the keyset reads an index of the school's own rows in id order instead
-- of walking every school's ids.
CREATE INDEX "AttendanceRecords_schoolId_id_idx" ON "AttendanceRecords"("schoolId", "id");

-- ---------------------------------------------------------------------------
-- What is emitted
-- ---------------------------------------------------------------------------

-- The school's emitted years (active and past), found once.
CREATE FUNCTION app.ss12000_emitted_years(p_school uuid) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT coalesce(array_agg(y."id"), ARRAY[]::uuid[])
    FROM "AcademicYears" y
   WHERE y."schoolId" = p_school AND app.ss12000_year_is_emitted(y."id")
$$;

-- An attendance is emitted when its pupil is an active pupil and its
-- lesson's group is of an emitted year; an absence when its pupil is.
-- (The years as a value, so they are found once and not per row.)
CREATE FUNCTION app.ss12000_attendance_emitted(p_school uuid, p_ids uuid[]) RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  years uuid[] := app.ss12000_emitted_years(p_school);
BEGIN
  RETURN ARRAY(
    SELECT a."id"
      FROM "AttendanceRecords" a
      JOIN "Users" u ON u."id" = a."studentId" AND u."isActive" AND u."role" = 'STUDENT'
      JOIN "CalendarLessons" l ON l."id" = a."calendarLessonId"
      JOIN "StudentGroups" g ON g."id" = l."studentGroupId"
     WHERE a."schoolId" = p_school
       AND a."id" = ANY (p_ids)
       AND g."academicYearId" = ANY (years));
END
$$;

CREATE FUNCTION app.ss12000_absence_emitted(p_school uuid, p_ids uuid[]) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT coalesce(array_agg(a."id"), ARRAY[]::uuid[])
    FROM "AbsenceReports" a
    JOIN "Users" u ON u."id" = a."studentId" AND u."isActive" AND u."role" = 'STUDENT'
   WHERE a."schoolId" = p_school
     AND a."id" = ANY (p_ids)
$$;

-- ---------------------------------------------------------------------------
-- The provider's reads: the emitted columns, and only what the key may read
-- ---------------------------------------------------------------------------

-- A filter not asked is NULL. meta.modified is the version's: every
-- attendance changed while the school shares has one; a row without one is
-- dated by its creation (nothing of it was handed out before), and is not
-- what an incremental read is after. The *_after/*_before bounds compare at
-- the millisecond an ISO string carries (S1: before inclusive, after
-- exclusive): truncated(m) > X is m >= X + 1 ms, written so the versions'
-- (schoolId, resource, modifiedAt) index answers an incremental read. The
-- statement is planned with its values at every call (EXECUTE ... USING), so
-- a filter not asked folds away and the keyset walks
-- AttendanceRecords_schoolId_id_idx from the page's last id, as a page of a
-- school with a million rows must. LIMIT NULL is no limit.
CREATE FUNCTION app.ss12000_attendances(
    p_ids uuid[], p_lessons uuid[], p_students uuid[], p_groups uuid[],
    p_created_before timestamptz, p_created_after timestamptz,
    p_modified_before timestamptz, p_modified_after timestamptz,
    p_after uuid, p_limit integer)
RETURNS TABLE ("id" uuid, "calendarLessonId" uuid, "studentId" uuid, "status" text, "createdAt" timestamptz,
               "startsAt" timestamptz, "endsAt" timestamptz, "studentGroupId" uuid,
               "versionCreatedAt" timestamptz, "versionModifiedAt" timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  school uuid := app.current_service_school_id();
BEGIN
  IF school IS NULL OR NOT app.service_reads_attendance('attendances.read') THEN
    RETURN;
  END IF;
  RETURN QUERY EXECUTE $q$
    SELECT a."id", a."calendarLessonId", a."studentId", a."status"::text, a."createdAt",
           l."startsAt", l."endsAt", l."studentGroupId", v."createdAt", v."modifiedAt"
      FROM "AttendanceRecords" a
      JOIN "CalendarLessons" l ON l."id" = a."calendarLessonId"
      JOIN "StudentGroups" g ON g."id" = l."studentGroupId"
      JOIN "Users" u ON u."id" = a."studentId" AND u."isActive" AND u."role" = 'STUDENT'
      LEFT JOIN "Ss12000EntityVersions" v
        ON v."schoolId" = a."schoolId" AND v."resource" = 'Attendance' AND v."entityId" = a."id"
     WHERE a."schoolId" = $1
       AND g."academicYearId" = ANY ($2)
       AND ($3 IS NULL OR a."id" = ANY ($3))
       AND ($4 IS NULL OR a."calendarLessonId" = ANY ($4))
       AND ($5 IS NULL OR a."studentId" = ANY ($5))
       AND ($6 IS NULL OR l."studentGroupId" = ANY ($6))
       AND ($7 IS NULL OR a."createdAt" < $7 + interval '1 millisecond')
       AND ($8 IS NULL OR a."createdAt" >= $8 + interval '1 millisecond')
       AND ($9 IS NULL OR coalesce(v."modifiedAt", a."createdAt") < $9 + interval '1 millisecond')
       AND ($10 IS NULL OR v."modifiedAt" >= $10 + interval '1 millisecond')
       AND ($11 IS NULL OR a."id" > $11)
     ORDER BY a."id"
     LIMIT $12
  $q$ USING school, app.ss12000_emitted_years(school), p_ids, p_lessons, p_students, p_groups,
            p_created_before, p_created_after, p_modified_before, p_modified_after, p_after, p_limit;
END
$$;

COMMENT ON FUNCTION app.ss12000_attendances(uuid[], uuid[], uuid[], uuid[], timestamptz, timestamptz, timestamptz, timestamptz, uuid, integer) IS
  'SS12000 Attendance under the service principal: the emitted columns of the school''s attendance of active pupils in emitted years, only to a key that may read attendances (app.service_reads_attendance). Never note, recordedById or recordedAt.';

-- The date and the times as text (YYYY-MM-DD, HH24:MI:SS): what the gateway
-- lifts onto the school's clock. A school's absences are tens of thousands
-- at most, read whole and paged in memory as the other resources are.
CREATE FUNCTION app.ss12000_absences(p_ids uuid[], p_students uuid[])
RETURNS TABLE ("id" uuid, "studentId" uuid, "date" text, "startTime" text, "endTime" text,
               "grantedLeave" boolean, "createdAt" timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT a."id", a."studentId", to_char(a."date", 'YYYY-MM-DD'),
         to_char(a."startTime", 'HH24:MI:SS'), to_char(a."endTime", 'HH24:MI:SS'),
         a."grantedLeave", a."createdAt"
    FROM "AbsenceReports" a
    JOIN "Users" u ON u."id" = a."studentId" AND u."isActive" AND u."role" = 'STUDENT'
   WHERE (SELECT app.service_reads_attendance('absences.read'))
     AND a."schoolId" = (SELECT app.current_service_school_id())
     AND (p_ids IS NULL OR a."id" = ANY (p_ids))
     AND (p_students IS NULL OR a."studentId" = ANY (p_students))
$$;

COMMENT ON FUNCTION app.ss12000_absences(uuid[], uuid[]) IS
  'SS12000 Absence under the service principal: the emitted columns of the school''s absence reports of active pupils, only to a key that may read absences (app.service_reads_attendance). Never note, type or reportedById.';

-- ---------------------------------------------------------------------------
-- The administrator's arms on the decisions
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    CREATE POLICY "attendance_sharing_decisions_admin_select" ON "AttendanceSharingDecisions"
        FOR SELECT TO "app_authenticated"
        USING (
            "schoolId" = (select app.current_school_id())
            AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
        );

    CREATE POLICY "attendance_sharing_decisions_admin_insert" ON "AttendanceSharingDecisions"
        FOR INSERT TO "app_authenticated"
        WITH CHECK (
            "schoolId" = (select app.current_school_id())
            AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
        );
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- The recorders, while the school shares
-- ---------------------------------------------------------------------------

-- AttendanceRecords.
CREATE FUNCTION app.ss12000_v_attendance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  r record;
  years uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR r IN SELECT n."schoolId" s, array_agg(n."id") ids FROM n GROUP BY 1 LOOP
      CONTINUE WHEN NOT app.attendance_shared(r.s);
      PERFORM app.ss12000_bump(r.s, 'Attendance', app.ss12000_attendance_emitted(r.s, r.ids));
    END LOOP;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Not recordedAt: the register stamps it anew at every save, and it is
    -- not emitted (reportedTimestamp is left out for that reason).
    FOR r IN
      SELECT n."schoolId" s, array_agg(n."id") ids
        FROM n JOIN o ON o."id" = n."id"
       WHERE (n."status", n."calendarLessonId", n."studentId")
             IS DISTINCT FROM (o."status", o."calendarLessonId", o."studentId")
       GROUP BY 1
    LOOP
      CONTINUE WHEN NOT app.attendance_shared(r.s);
      PERFORM app.ss12000_bump(r.s, 'Attendance', app.ss12000_attendance_emitted(r.s, r.ids));
    END LOOP;
  ELSE
    -- A pupil already gone was buried with their leaving; a lesson of a year
    -- not emitted never left. A lesson, group or pupil deleted in the same
    -- statement (a cascade) is no longer there to ask, and is buried.
    FOR r IN SELECT DISTINCT o."schoolId" s FROM o LOOP
      CONTINUE WHEN NOT app.attendance_shared(r.s);
      years := app.ss12000_emitted_years(r.s);
      PERFORM app.ss12000_bury(r.s, 'Attendance', ARRAY(
        SELECT o."id"
          FROM o
          LEFT JOIN "Users" u ON u."id" = o."studentId"
          LEFT JOIN "CalendarLessons" l ON l."id" = o."calendarLessonId"
          LEFT JOIN "StudentGroups" g ON g."id" = l."studentGroupId"
         WHERE o."schoolId" = r.s
           AND (u."id" IS NULL OR (u."isActive" AND u."role" = 'STUDENT'))
           AND (g."id" IS NULL OR g."academicYearId" = ANY (years))));
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;

-- AbsenceReports.
CREATE FUNCTION app.ss12000_v_absences() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR r IN SELECT n."schoolId" s, array_agg(n."id") ids FROM n GROUP BY 1 LOOP
      CONTINUE WHEN NOT app.attendance_shared(r.s);
      PERFORM app.ss12000_bump(r.s, 'Absence', app.ss12000_absence_emitted(r.s, r.ids));
    END LOOP;
  ELSIF TG_OP = 'UPDATE' THEN
    FOR r IN
      SELECT n."schoolId" s, array_agg(n."id") ids
        FROM n JOIN o ON o."id" = n."id"
       WHERE (n."date", n."startTime", n."endTime", n."grantedLeave", n."studentId")
             IS DISTINCT FROM (o."date", o."startTime", o."endTime", o."grantedLeave", o."studentId")
       GROUP BY 1
    LOOP
      CONTINUE WHEN NOT app.attendance_shared(r.s);
      PERFORM app.ss12000_bump(r.s, 'Absence', app.ss12000_absence_emitted(r.s, r.ids));
    END LOOP;
  ELSE
    FOR r IN
      SELECT o."schoolId" s, array_agg(o."id") ids
        FROM o
        LEFT JOIN "Users" u ON u."id" = o."studentId"
       WHERE u."id" IS NULL OR (u."isActive" AND u."role" = 'STUDENT')
       GROUP BY 1
    LOOP
      CONTINUE WHEN NOT app.attendance_shared(r.s);
      PERFORM app.ss12000_bury(r.s, 'Absence', r.ids);
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;

-- Users: a pupil who leaves (deactivated, or no longer a pupil), comes back,
-- or is linked to the source.
CREATE FUNCTION app.ss12000_v_attendance_pupils() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  r record;
  years uuid[];
BEGIN
  FOR r IN
    SELECT n."schoolId" s,
           array_agg(n."id") FILTER (WHERE (o."isActive" AND o."role" = 'STUDENT')
                                       AND NOT (n."isActive" AND n."role" = 'STUDENT')) gone,
           array_agg(n."id") FILTER (WHERE (n."isActive" AND n."role" = 'STUDENT')
                                       AND NOT (o."isActive" AND o."role" = 'STUDENT')) back,
           array_agg(n."id") FILTER (WHERE (n."isActive" AND n."role" = 'STUDENT')
                                       AND (o."isActive" AND o."role" = 'STUDENT')
                                       AND n."ss12000Id" IS DISTINCT FROM o."ss12000Id") relinked
      FROM n JOIN o ON o."id" = n."id"
     WHERE n."role" = 'STUDENT' OR o."role" = 'STUDENT'
     GROUP BY 1
  LOOP
    CONTINUE WHEN r.gone IS NULL AND r.back IS NULL AND r.relinked IS NULL;
    CONTINUE WHEN NOT app.attendance_shared(r.s);
    IF r.gone IS NOT NULL THEN
      years := app.ss12000_emitted_years(r.s);
      PERFORM app.ss12000_bury(r.s, 'Attendance', ARRAY(
        SELECT a."id" FROM "AttendanceRecords" a
          JOIN "CalendarLessons" l ON l."id" = a."calendarLessonId"
          JOIN "StudentGroups" g ON g."id" = l."studentGroupId"
         WHERE a."studentId" = ANY (r.gone) AND g."academicYearId" = ANY (years)));
      PERFORM app.ss12000_bury(r.s, 'Absence', ARRAY(
        SELECT a."id" FROM "AbsenceReports" a WHERE a."studentId" = ANY (r.gone)));
    END IF;
    IF r.back IS NOT NULL OR r.relinked IS NOT NULL THEN
      PERFORM app.ss12000_unbury(r.s, 'Attendance', ARRAY(
        SELECT a."id" FROM "AttendanceRecords" a WHERE a."studentId" = ANY (coalesce(r.back, ARRAY[]::uuid[]))));
      PERFORM app.ss12000_unbury(r.s, 'Absence', ARRAY(
        SELECT a."id" FROM "AbsenceReports" a WHERE a."studentId" = ANY (coalesce(r.back, ARRAY[]::uuid[]))));
      PERFORM app.ss12000_bump(r.s, 'Attendance', app.ss12000_attendance_emitted(r.s, ARRAY(
        SELECT a."id" FROM "AttendanceRecords" a
         WHERE a."studentId" = ANY (coalesce(r.back, ARRAY[]::uuid[]) || coalesce(r.relinked, ARRAY[]::uuid[])))));
      PERFORM app.ss12000_bump(r.s, 'Absence', app.ss12000_absence_emitted(r.s, ARRAY(
        SELECT a."id" FROM "AbsenceReports" a
         WHERE a."studentId" = ANY (coalesce(r.back, ARRAY[]::uuid[]) || coalesce(r.relinked, ARRAY[]::uuid[])))));
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

-- CalendarLessons: new times are new minutes; a new group may be another year.
CREATE FUNCTION app.ss12000_v_attendance_lessons() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT n."schoolId" s, array_agg(n."id") lessons
      FROM n JOIN o ON o."id" = n."id"
     WHERE (n."startsAt", n."endsAt", n."studentGroupId") IS DISTINCT FROM (o."startsAt", o."endsAt", o."studentGroupId")
     GROUP BY 1
  LOOP
    CONTINUE WHEN NOT app.attendance_shared(r.s);
    PERFORM app.ss12000_bump(r.s, 'Attendance', app.ss12000_attendance_emitted(r.s, ARRAY(
      SELECT a."id" FROM "AttendanceRecords" a WHERE a."calendarLessonId" = ANY (r.lessons))));
  END LOOP;
  RETURN NULL;
END
$$;

-- Schools: a full-day absence is the school's local day.
CREATE FUNCTION app.ss12000_v_absence_timezone() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT n."id" s FROM n JOIN o ON o."id" = n."id" WHERE n."timezone" IS DISTINCT FROM o."timezone"
  LOOP
    CONTINUE WHEN NOT app.attendance_shared(r.s);
    PERFORM app.ss12000_bump(r.s, 'Absence', app.ss12000_absence_emitted(r.s, ARRAY(
      SELECT a."id" FROM "AbsenceReports" a WHERE a."schoolId" = r.s)));
  END LOOP;
  RETURN NULL;
END
$$;

-- AcademicYears: a year activated makes its lessons' attendance emitted.
-- Only rows without a version: one of a year that was emitted already has
-- what it needs, or is dated by its creation and was in a full read.
CREATE FUNCTION app.ss12000_v_attendance_years() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT n."schoolId" s, array_agg(n."id") years
      FROM n JOIN o ON o."id" = n."id"
     WHERE n."isActive" AND NOT o."isActive"
     GROUP BY 1
  LOOP
    CONTINUE WHEN NOT app.attendance_shared(r.s);
    PERFORM app.ss12000_bump(r.s, 'Attendance', app.ss12000_attendance_emitted(r.s, ARRAY(
      SELECT a."id" FROM "AttendanceRecords" a
        JOIN "CalendarLessons" l ON l."id" = a."calendarLessonId"
        JOIN "StudentGroups" g ON g."id" = l."studentGroupId"
       WHERE g."academicYearId" = ANY (r.years)
         AND NOT EXISTS (SELECT 1 FROM "Ss12000EntityVersions" v
                          WHERE v."schoolId" = r.s AND v."resource" = 'Attendance' AND v."entityId" = a."id"))));
  END LOOP;
  RETURN NULL;
END
$$;

CREATE TRIGGER "AttendanceRecords_ss12000_versions_ins"
    AFTER INSERT ON "AttendanceRecords" REFERENCING NEW TABLE AS n
    FOR EACH STATEMENT EXECUTE FUNCTION app.ss12000_v_attendance();
CREATE TRIGGER "AttendanceRecords_ss12000_versions_upd"
    AFTER UPDATE ON "AttendanceRecords" REFERENCING OLD TABLE AS o NEW TABLE AS n
    FOR EACH STATEMENT EXECUTE FUNCTION app.ss12000_v_attendance();
CREATE TRIGGER "AttendanceRecords_ss12000_versions_del"
    AFTER DELETE ON "AttendanceRecords" REFERENCING OLD TABLE AS o
    FOR EACH STATEMENT EXECUTE FUNCTION app.ss12000_v_attendance();

CREATE TRIGGER "AbsenceReports_ss12000_versions_ins"
    AFTER INSERT ON "AbsenceReports" REFERENCING NEW TABLE AS n
    FOR EACH STATEMENT EXECUTE FUNCTION app.ss12000_v_absences();
CREATE TRIGGER "AbsenceReports_ss12000_versions_upd"
    AFTER UPDATE ON "AbsenceReports" REFERENCING OLD TABLE AS o NEW TABLE AS n
    FOR EACH STATEMENT EXECUTE FUNCTION app.ss12000_v_absences();
CREATE TRIGGER "AbsenceReports_ss12000_versions_del"
    AFTER DELETE ON "AbsenceReports" REFERENCING OLD TABLE AS o
    FOR EACH STATEMENT EXECUTE FUNCTION app.ss12000_v_absences();

CREATE TRIGGER "Users_ss12000_attendance_upd"
    AFTER UPDATE ON "Users" REFERENCING OLD TABLE AS o NEW TABLE AS n
    FOR EACH STATEMENT EXECUTE FUNCTION app.ss12000_v_attendance_pupils();
CREATE TRIGGER "CalendarLessons_ss12000_attendance_upd"
    AFTER UPDATE ON "CalendarLessons" REFERENCING OLD TABLE AS o NEW TABLE AS n
    FOR EACH STATEMENT EXECUTE FUNCTION app.ss12000_v_attendance_lessons();
CREATE TRIGGER "Schools_ss12000_attendance_upd"
    AFTER UPDATE ON "Schools" REFERENCING OLD TABLE AS o NEW TABLE AS n
    FOR EACH STATEMENT EXECUTE FUNCTION app.ss12000_v_absence_timezone();
CREATE TRIGGER "AcademicYears_ss12000_attendance_upd"
    AFTER UPDATE ON "AcademicYears" REFERENCING OLD TABLE AS o NEW TABLE AS n
    FOR EACH STATEMENT EXECUTE FUNCTION app.ss12000_v_attendance_years();

-- ---------------------------------------------------------------------------
-- The scopes (IntegrationApiKeys, read by every integration request)
-- ---------------------------------------------------------------------------

ALTER TABLE "IntegrationApiKeys" DROP CONSTRAINT "IntegrationApiKeys_scopes_are_known";
ALTER TABLE "IntegrationApiKeys"
    ADD CONSTRAINT "IntegrationApiKeys_scopes_are_known" CHECK (
        cardinality("scopes") BETWEEN 1 AND 14
        AND array_position("scopes", NULL) IS NULL
        AND "scopes" <@ ARRAY['ss12000.v1', 'ss12000.v1.import', 'organisations.read', 'persons.read', 'responsibles.read',
                              'groups.read', 'duties.read', 'activities.read', 'calendarEvents.read', 'rooms.read',
                              'syllabuses.read', 'subscriptions.write', 'attendances.read', 'absences.read']::text[]);

-- ---------------------------------------------------------------------------
-- Notices: attendance only while the school shares and the key may read it
-- ---------------------------------------------------------------------------

-- The resource types of a subscription that may be notified now: all of
-- them, except Attendance and Absence unless the school shares and the key
-- holds their scope.
CREATE FUNCTION app.ss12000_notifies(p_types text[], p_scopes text[], p_school uuid) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT coalesce(array_agg(t), ARRAY[]::text[])
    FROM unnest(p_types) t
   WHERE t NOT IN ('Attendance', 'Absence')
      OR (app.attendance_shared(p_school)
          AND (CASE t WHEN 'Attendance' THEN 'attendances.read' ELSE 'absences.read' END) = ANY (p_scopes))
$$;

-- Asked once per subscription (the lateral `nt`), never per version or
-- tombstone scanned.
CREATE OR REPLACE FUNCTION app.ss12000_due_notifications(p_limit integer)
RETURNS TABLE (subscription_id uuid, school_id uuid, key_id uuid, target text, modified text[], deleted boolean,
               watermark_to text, attempts integer, failing_since timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  horizon xid8 := pg_snapshot_xmin(pg_current_snapshot());
BEGIN
  IF NOT app.ss12000_is_delivery_context() THEN
    RAISE EXCEPTION 'SS12000_DELIVERY_ONLY: bara utskicket hämtar prenumerationer att avisera' USING ERRCODE = 'SS403';
  END IF;
  RETURN QUERY
  WITH due AS (
    SELECT s."id", nt.types
      FROM "Ss12000Subscriptions" s
      JOIN "IntegrationApiKeys" k ON k."id" = s."keyId" AND k."schoolId" = s."schoolId"
      CROSS JOIN LATERAL (SELECT app.ss12000_notifies(s."resourceTypes", k."scopes", s."schoolId") AS types OFFSET 0) nt
     WHERE s."endedAt" IS NULL AND s."suspendedAt" IS NULL AND s."expiresAt" > now()
       AND k."revokedAt" IS NULL
       AND s."nextAttemptAt" <= now()
       AND (s."claimedAt" IS NULL OR s."claimedAt" < now() - interval '5 minutes')
       AND (EXISTS (SELECT 1 FROM "Ss12000EntityVersions" v
                     WHERE v."schoolId" = s."schoolId" AND v."xid" >= s."watermark" AND v."xid" < horizon
                       AND v."resource" = ANY (nt.types))
            OR EXISTS (SELECT 1 FROM "Ss12000Tombstones" t
                        WHERE t."schoolId" = s."schoolId" AND t."xid" >= s."watermark" AND t."xid" < horizon
                          AND (CASE WHEN t."resource" = 'AdhocActivity' THEN 'Activity' ELSE t."resource" END) = ANY (nt.types)))
     ORDER BY s."nextAttemptAt", s."id"
     LIMIT greatest(least(p_limit, 200), 1)
     FOR UPDATE OF s SKIP LOCKED
  ), claimed AS (
    UPDATE "Ss12000Subscriptions" s SET "claimedAt" = now()
      FROM due WHERE s."id" = due."id"
    RETURNING s."id", s."schoolId", s."keyId", s."target", due.types AS "types", s."watermark", s."attempts", s."failingSince"
  )
  SELECT c."id", c."schoolId", c."keyId", c."target",
         ARRAY(SELECT DISTINCT v."resource" FROM "Ss12000EntityVersions" v
                WHERE v."schoolId" = c."schoolId" AND v."xid" >= c."watermark" AND v."xid" < horizon
                  AND v."resource" = ANY (c."types")
                ORDER BY 1),
         EXISTS (SELECT 1 FROM "Ss12000Tombstones" t
                  WHERE t."schoolId" = c."schoolId" AND t."xid" >= c."watermark" AND t."xid" < horizon
                    AND (CASE WHEN t."resource" = 'AdhocActivity' THEN 'Activity' ELSE t."resource" END) = ANY (c."types")),
         horizon::text, c."attempts", c."failingSince"
    FROM claimed c;
END
$$;

-- ---------------------------------------------------------------------------
-- Versions and tombstones: two more resources, read only by those who may
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'Ss12000EntityVersions' AND policyname = 'ss12000_entity_versions_service_select') THEN
    ALTER POLICY "ss12000_entity_versions_service_select" ON "Ss12000EntityVersions"
        USING (
            "schoolId" = app.current_service_school_id()
            AND ("resource" NOT IN ('Attendance', 'Absence')
                 OR ("resource" = 'Attendance' AND (select app.service_reads_attendance('attendances.read')))
                 OR ("resource" = 'Absence' AND (select app.service_reads_attendance('absences.read'))))
        );
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'Ss12000Tombstones' AND policyname = 'ss12000_tombstones_service_select') THEN
    ALTER POLICY "ss12000_tombstones_service_select" ON "Ss12000Tombstones"
        USING (
            "schoolId" = app.current_service_school_id()
            AND ("resource" NOT IN ('Attendance', 'Absence')
                 OR ("resource" = 'Attendance' AND (select app.service_reads_attendance('attendances.read')))
                 OR ("resource" = 'Absence' AND (select app.service_reads_attendance('absences.read'))))
        );
  END IF;
END
$$;

-- Last, so a lesson edit that waits for this migration has taken no lock
-- that these need. The new CHECKs are supersets of the old: every row passes.
ALTER TABLE "Ss12000EntityVersions" DROP CONSTRAINT "Ss12000EntityVersions_resource_is_emitted";
ALTER TABLE "Ss12000EntityVersions"
    ADD CONSTRAINT "Ss12000EntityVersions_resource_is_emitted" CHECK ("resource" IN
        ('Organisation', 'Person', 'Group', 'Duty', 'Activity', 'CalendarEvent', 'Room', 'Syllabus',
         'Attendance', 'Absence'));

ALTER TABLE "Ss12000Tombstones" DROP CONSTRAINT "Ss12000Tombstones_resource_is_emitted";
ALTER TABLE "Ss12000Tombstones"
    ADD CONSTRAINT "Ss12000Tombstones_resource_is_emitted" CHECK ("resource" IN
        ('Organisation', 'Person', 'Group', 'Duty', 'Activity', 'AdhocActivity', 'CalendarEvent', 'Room', 'Syllabus',
         'Attendance', 'Absence'));

ALTER TABLE "Ss12000Subscriptions" DROP CONSTRAINT "Ss12000Subscriptions_resourceTypes_are_emitted";
ALTER TABLE "Ss12000Subscriptions"
    ADD CONSTRAINT "Ss12000Subscriptions_resourceTypes_are_emitted" CHECK (
        cardinality("resourceTypes") BETWEEN 1 AND 10
        AND array_position("resourceTypes", NULL) IS NULL
        AND "resourceTypes" <@ ARRAY['Organisation', 'Person', 'Group', 'Duty', 'Activity', 'CalendarEvent', 'Room', 'Syllabus',
                                     'Attendance', 'Absence']::text[]);

-- ---------------------------------------------------------------------------
-- Grants, guarded
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  fn text;
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['app_authenticated', 'authenticated', 'anon', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "AttendanceSharingDecisions" FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT SELECT ON "AttendanceSharingDecisions" TO "app_authenticated";
    GRANT INSERT ("schoolId", "shares", "reference") ON "AttendanceSharingDecisions" TO "app_authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT ON "AttendanceSharingDecisions" TO "service_role";
  END IF;

  -- Nobody calls these but the triggers and the functions above.
  FOREACH fn IN ARRAY ARRAY[
    'app.attendance_sharing_decisions_are_stamped()',
    'app.attendance_sharing_decisions_are_append_only()',
    'app.attendance_shared(uuid)',
    'app.absence_reports_granted_leave_is_decided()',
    'app.ss12000_emitted_years(uuid)',
    'app.ss12000_attendance_emitted(uuid, uuid[])',
    'app.ss12000_absence_emitted(uuid, uuid[])',
    'app.ss12000_v_attendance()',
    'app.ss12000_v_absences()',
    'app.ss12000_v_attendance_pupils()',
    'app.ss12000_v_attendance_lessons()',
    'app.ss12000_v_absence_timezone()',
    'app.ss12000_v_attendance_years()',
    'app.ss12000_notifies(text[], text[], uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', fn, r);
      END IF;
    END LOOP;
  END LOOP;

  -- The provider's question and its two reads: the API alone.
  FOREACH fn IN ARRAY ARRAY[
    'app.service_reads_attendance(text)',
    'app.ss12000_attendances(uuid[], uuid[], uuid[], uuid[], timestamptz, timestamptz, timestamptz, timestamptz, uuid, integer)',
    'app.ss12000_absences(uuid[], uuid[])'
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

RESET lock_timeout;
