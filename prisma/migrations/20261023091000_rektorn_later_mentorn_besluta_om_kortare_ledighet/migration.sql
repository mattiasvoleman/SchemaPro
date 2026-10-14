-- Rektorn låter mentorn besluta om kortare ledighet.
--
-- Skollagen 7 kap. 18 § lets rektor grant a pupil kortare ledighet for
-- enskilda angelägenheter, and 2 kap. 10 § lets rektor delegate the decision.
-- Schools do: a common delegationsordning lets the mentor decide a request of
-- a few skoldagar and keeps everything longer with rektor. Until now only a
-- SCHOOL_ADMIN decided in SchemaPro (family.controller.ts), and since
-- 20261015090000 no TEACHER reads any leave request at all.
--
-- This migration lets each school record rektor's delegation and gives the
-- mentor exactly the requests it covers. Nothing is delegated until a school
-- records it: every school starts at "ingen delegering", where the admin
-- decides everything as before (PRODUCT.md principle 6). How far rektor may
-- delegate is for the school's jurist to confirm; the product never defaults
-- to delegating.
--
-- ## Rektor's decision ("LeaveDelegationDecisions"), append-only
--
-- One row per decision: "mentorMaxSchoolDays" (the mentor decides a request
-- of at most that many skoldagar; NULL is "ingen delegering", the admin
-- decides all) and an optional reference to the delegationsordning (dnr, at
-- most 200 characters). The trigger stamps "decidedAt" (clock_timestamp) and
-- "decidedById" (app.current_user_id()) whatever the statement says, and
-- refuses UPDATE, DELETE and TRUNCATE except by a referential action, as
-- RetentionDecisions does (20261021110000): the table is the history of who
-- delegated what and when. The latest row of a school is in force.
--
-- The limit is 1 to 10 skoldagar. Längre ledighet stays with rektor whatever
-- a school records: the law does not define kortare ledighet, and ten
-- skoldagar a request is the widest reading in use. A school that wants less
-- records less.
--
-- ## A skoldag (app.leave_school_days)
--
-- A day of the request counts when it is a weekday (Monday to Friday), it
-- lies in one of the school's läsår (or after the last one the school has
-- recorded, whose year is not set up yet), and no SchoolBreak of the school
-- covers the pupil on it. A break with no grade span covers everybody; a
-- spanned break (prao för åk 9, a studiedag for the lower years) covers the
-- pupil when the årskurs of their class that day (StudentEnrollments) lies
-- inside it, and a pupil whose class has no årskurs is not covered, which is
-- calendar/publish-days.ts breakCoversGroup. Both HOLIDAY and STAFF_DAY close
-- the pupil's day. src/family/school-days.ts is the same rule in TypeScript,
-- for the absence an approval writes; a shared table of cases
-- (src/family/school-days.cases.json) is run against both, by jest and by the
-- adapter probe in CI.
--
-- ## Who decides a request
--
-- The pupil's mentors on the request's dates (app.leave_mentors): active
-- TEACHERs holding a MENTORSKAP uppdrag (TeacherDuties) on the pupil's class
-- on some day of the request, where the class on a day is the pupil's
-- StudentEnrollments segment and the uppdrag runs on it by its own Från and
-- Till inside its läsår (src/staffing/duty-dates.ts dutiesRunningDuring).
-- A period over a mentor change gives both mentors; two mentors of one class
-- are both mentors. Evaluated when asked, never stored: the uppdrag and the
-- class as they are now say who reads and decides a request now. So editing
-- an uppdrag's dates, removing it, rolling the mentorships over into next
-- year's classes, moving the pupil, or recording a new delegation moves the
-- pending requests with it (RLS section 97).
--
-- The mentors decide (app.leave_deciding_mentors) when the school's limit in
-- force is not NULL and the request has at most that many skoldagar. Either
-- mentor may decide, and the first decision wins: the decision is a
-- conditional UPDATE of a PENDING row, so the second finds none. Otherwise,
-- and for a pupil with no mentor on those dates, the admin decides. The
-- mentor may also pass a request on to rektor ("referredAt",
-- "referredById"); it is then the admin's.
--
-- ## The new columns of "LeaveRequests"
--
--   * "decidedAs" MENTOR or ADMIN: in which role the decision was made. Every
--     decision before this one was made through the admin's route; the rows
--     whose decider is a SCHOOL_ADMIN are backfilled ADMIN. A row decided
--     before 20261015140000 closed the guardian's insert arm could carry a
--     decision nobody made; its decider is no SCHOOL_ADMIN, and it is left
--     NULL rather than credited to the admin. The guardian sees "Beslutad av
--     mentor" for MENTOR.
--   * "referredAt", "referredById": when and by whom a mentor passed it on.
--     The referrer is kept while they are a Users row and NULL once deleted.
--   * Two CHECKs: a role is recorded only for a decision, and a mentor's
--     decision is never on a request passed on to rektor; a referrer has a
--     time. The previous API release writes neither column, and an admin
--     decision it makes leaves "decidedAs" NULL, which both CHECKs allow.
--   * A third CHECK bounds the request itself: its last day is on or after
--     its first, and it covers at most 366 days. A guardian's own session
--     may still insert (the previous app build did), and a range of
--     thousands of years would otherwise be counted day by day in every
--     inbox and inside the mentor's arm. Production held no leave request
--     when this was written (a read-only count, 2026-10-14); it is added NOT
--     VALID and then validated, so a row outside it would stop the
--     migration rather than slip past it.
--   * A trigger refuses a change of the request itself: its school, pupil,
--     requester, dates, reason or creation time. No route changes them, and
--     the mentor's UPDATE arm cannot say which columns may change.
--
-- ## Who reads and writes what
--
--   * leave_requests_mentor_select (app_authenticated only): a TEACHER reads
--     a request of their school that is PENDING, not passed on, and theirs
--     to decide, and a request they decided as mentor. The reason with it:
--     the mentor decides on it. Nothing else, not after passing it on, not
--     a co-mentor's decision, and nothing through PostgREST's role, because
--     a teacher's own Supabase session must not decide (family schedule's
--     pattern, 20261013090000).
--   * leave_requests_mentor_update (app_authenticated only): the same
--     pending request, into a decision as MENTOR by the caller. Passing it
--     on is app.leave_request_refer's: an UPDATE whose WHERE reads the row
--     must leave a row the caller still SELECTs, and a request passed on is
--     no longer the mentor's to read.
--   * absence_reports_mentor_leave_insert (app_authenticated only): the
--     approving mentor files the full-day AbsenceReports of the leave, in
--     their own name, of type OTHER with the note "Approved leave" (as the
--     admin's approval writes them), only for a pupil and a day inside a
--     request they approved as mentor. A teacher still reads no report
--     (20261015120000).
--   * The guardian's and the pupil's insert arms also admit only a request
--     that is not passed on (no "referredAt", no "referredById").
--   * LeaveDelegationDecisions: the school's TEACHERs and SCHOOL_ADMINs read
--     its decisions (a delegationsordning is a public document of the
--     school); a SCHOOL_ADMIN records one. Through the API's role only.
--
-- ## Functions
--
-- Internal, the owner's (plain SQL, every name schema-qualified, no SET; no
-- API role may call them, and the definer functions below call them with the
-- owner's rights): app.leave_mentor_limit, app.leave_school_days,
-- app.leave_mentors, app.leave_deciding_mentors, and app.leave_tell_mentors,
-- which writes the notices. For the gateway (app_authenticated), SECURITY
-- DEFINER with a pinned search_path, six:
--
--   * app.leave_mine_to_decide(school, pupil, from, to): is the caller a
--     TEACHER of the school among the deciding mentors? The mentor arms ask
--     it, and so do app.leave_request_refer and app.leave_request_facts.
--   * app.leave_request_refer(id): the caller, a mentor who may decide the
--     pending request, passes it on to rektor; true when it did. The first
--     of a decision and a referral wins, as two decisions do.
--   * app.leave_request_facts(ids): per request the caller may read as an
--     admin or as its mentor, its skoldagar, the limit, the mentors and the
--     deciding mentors, its läsår, and the pupil's other leave in that läsår
--     (approved skoldagar and requests, pending requests), never their
--     reasons. The decider sees the pupil's leave so far this läsår.
--   * app.leave_request_notices(id): the LEAVE_REQUESTED notices this
--     transaction wrote about a request the caller filed, with the mentors'
--     addresses, which the gateway hands to the e-mail and the push.
--   * app.leave_requests_tell_new_mentors(): for a TEACHER or SCHOOL_ADMIN,
--     writes the notices the school's pending requests still owe and returns
--     them with the addresses. The gateway calls it after a new delegation
--     and after an uppdrag of MENTORSKAP is written, which both move pending
--     requests to mentors who were never told.
--   * app.leave_request_taken(id): whether a request the caller no longer
--     reads is one of their own pupils' that is no longer theirs to decide
--     (decided, passed on, or out of the delegation), so the gateway answers
--     409 rather than 404. Nothing else about the request is said.
--
-- ## The notice, written from the row
--
-- A guardian and a pupil may neither insert a notification nor read a
-- teacher's address, and a request may arrive by a path that runs no gateway
-- code (the previous app build inserts through PostgREST). So an AFTER INSERT
-- trigger writes the LEAVE_REQUESTED notices of every new request to its
-- deciding mentors (app.leave_tell_mentors, the owner's), and each mentor is
-- told at most once per request whoever asks again. The e-mail and the push
-- are the gateway's after the commit, for the filings and the catch-ups that
-- pass through it.
--
-- RLS sections 95 to 99 assert all of it.

-- ---------------------------------------------------------------------------
-- Types and columns
-- ---------------------------------------------------------------------------

CREATE TYPE "LeaveDeciderRole" AS ENUM ('MENTOR', 'ADMIN');

ALTER TABLE "LeaveRequests"
    ADD COLUMN "decidedAs"    "LeaveDeciderRole",
    ADD COLUMN "referredAt"   TIMESTAMPTZ(6),
    ADD COLUMN "referredById" UUID;

UPDATE "LeaveRequests" r
   SET "decidedAs" = 'ADMIN'
  FROM "Users" u
 WHERE r."status" <> 'PENDING' AND u."id" = r."decidedById" AND u."role" = 'SCHOOL_ADMIN';

ALTER TABLE "LeaveRequests"
    ADD CONSTRAINT "LeaveRequests_a_role_decided" CHECK (
        "decidedAs" IS NULL OR ("status" <> 'PENDING' AND ("decidedAs" = 'ADMIN' OR "referredAt" IS NULL))
    ),
    ADD CONSTRAINT "LeaveRequests_a_referral_has_a_time" CHECK ("referredById" IS NULL OR "referredAt" IS NOT NULL);

ALTER TABLE "LeaveRequests"
    ADD CONSTRAINT "LeaveRequests_a_year_at_most"
    CHECK ("endDate" >= "startDate" AND "endDate" - "startDate" < 366) NOT VALID;
ALTER TABLE "LeaveRequests" VALIDATE CONSTRAINT "LeaveRequests_a_year_at_most";

ALTER TABLE "LeaveRequests"
    ADD CONSTRAINT "LeaveRequests_referredById_fkey"
    FOREIGN KEY ("referredById") REFERENCES "Users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE FUNCTION app.leave_requests_request_is_fixed() RETURNS trigger
LANGUAGE plpgsql SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF NEW."schoolId" IS DISTINCT FROM OLD."schoolId"
     OR NEW."studentId" IS DISTINCT FROM OLD."studentId"
     OR NEW."requestedById" IS DISTINCT FROM OLD."requestedById"
     OR NEW."startDate" IS DISTINCT FROM OLD."startDate"
     OR NEW."endDate" IS DISTINCT FROM OLD."endDate"
     OR NEW."reason" IS DISTINCT FROM OLD."reason"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'LEAVE_REQUEST_IS_FIXED: en ansökans elev, datum och anledning ändras inte'
      USING ERRCODE = 'LV409';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.leave_requests_request_is_fixed() FROM PUBLIC;

CREATE TRIGGER "LeaveRequests_request_is_fixed"
    BEFORE UPDATE ON "LeaveRequests"
    FOR EACH ROW EXECUTE FUNCTION app.leave_requests_request_is_fixed();

-- ---------------------------------------------------------------------------
-- Rektor's delegation
-- ---------------------------------------------------------------------------

CREATE TABLE "LeaveDelegationDecisions" (
    "id"                  UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"            UUID NOT NULL,
    "mentorMaxSchoolDays" INTEGER,
    "reference"           TEXT,
    "decidedById"         UUID,
    "decidedAt"           TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "LeaveDelegationDecisions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LeaveDelegationDecisions_kortare_ledighet" CHECK ("mentorMaxSchoolDays" IS NULL OR "mentorMaxSchoolDays" BETWEEN 1 AND 10),
    CONSTRAINT "LeaveDelegationDecisions_reference_is_short" CHECK ("reference" IS NULL OR char_length("reference") BETWEEN 1 AND 200)
);

CREATE INDEX "LeaveDelegationDecisions_schoolId_decidedAt_idx"
    ON "LeaveDelegationDecisions"("schoolId", "decidedAt" DESC);

ALTER TABLE "LeaveDelegationDecisions"
    ADD CONSTRAINT "LeaveDelegationDecisions_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeaveDelegationDecisions"
    ADD CONSTRAINT "LeaveDelegationDecisions_decidedById_schoolId_fkey"
    FOREIGN KEY ("decidedById", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE SET NULL ("decidedById") ON UPDATE CASCADE;

CREATE FUNCTION app.leave_delegation_decisions_are_stamped() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  NEW."decidedAt" := clock_timestamp();
  NEW."decidedById" := app.current_user_id();
  RETURN NEW;
END
$$;

CREATE FUNCTION app.leave_delegation_decisions_are_append_only() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  -- A school's or a decider's referential action (cascade, SET NULL).
  IF TG_OP <> 'TRUNCATE' AND pg_trigger_depth() > 1 THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'LEAVE_DELEGATION_IS_APPEND_ONLY: rektors beslut om delegering ändras inte, ett nytt beslut ersätter det'
    USING ERRCODE = 'LV409',
          DETAIL  = format('operation=%s', TG_OP);
END
$$;

REVOKE ALL ON FUNCTION app.leave_delegation_decisions_are_stamped() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.leave_delegation_decisions_are_append_only() FROM PUBLIC;

CREATE TRIGGER "LeaveDelegationDecisions_stamped"
    BEFORE INSERT ON "LeaveDelegationDecisions"
    FOR EACH ROW EXECUTE FUNCTION app.leave_delegation_decisions_are_stamped();
CREATE TRIGGER "LeaveDelegationDecisions_append_only"
    BEFORE UPDATE OR DELETE ON "LeaveDelegationDecisions"
    FOR EACH ROW EXECUTE FUNCTION app.leave_delegation_decisions_are_append_only();
CREATE TRIGGER "LeaveDelegationDecisions_no_truncate"
    BEFORE TRUNCATE ON "LeaveDelegationDecisions"
    FOR EACH STATEMENT EXECUTE FUNCTION app.leave_delegation_decisions_are_append_only();

ALTER TABLE "LeaveDelegationDecisions" ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- The rule, in four internal functions (the owner's)
-- ---------------------------------------------------------------------------

-- The limit in force: the school's latest decision. NULL is no delegation,
-- and so is a school that recorded none.
CREATE FUNCTION app.leave_mentor_limit(p_school uuid) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT d."mentorMaxSchoolDays"
    FROM "public"."LeaveDelegationDecisions" d
   WHERE d."schoolId" = p_school
   ORDER BY d."decidedAt" DESC, d."id" DESC
   LIMIT 1
$$;

-- The pupil's skoldagar in [p_from, p_to], in order. See "A skoldag" above;
-- src/family/school-days.ts is the same rule. The days are p_from plus an
-- integer, at most 366 of them: LeaveRequests_a_year_at_most bounds every
-- request, and the clamp bounds whatever else is asked, so no per-row call
-- can walk an unbounded series (and no date is cast to a timestamp).
CREATE FUNCTION app.leave_school_days(p_school uuid, p_student uuid, p_from date, p_to date)
RETURNS SETOF date
LANGUAGE sql STABLE AS $$
  SELECT g.day
    FROM (SELECT p_from + s.i AS day FROM generate_series(0, LEAST(p_to - p_from, 365)) AS s(i)) g
   WHERE extract(isodow FROM g.day) < 6
     AND (EXISTS (SELECT 1 FROM "public"."AcademicYears" y
                   WHERE y."schoolId" = p_school AND g.day BETWEEN y."startDate" AND y."endDate")
          OR NOT EXISTS (SELECT 1 FROM "public"."AcademicYears" y
                          WHERE y."schoolId" = p_school AND y."endDate" >= g.day))
     AND NOT EXISTS (
           SELECT 1 FROM "public"."SchoolBreaks" b
            WHERE b."schoolId" = p_school AND g.day BETWEEN b."startDate" AND b."endDate"
              AND ((b."minGradeLevel" IS NULL AND b."maxGradeLevel" IS NULL)
                   OR EXISTS (
                        SELECT 1
                          FROM (SELECT e."gradeLevel"
                                  FROM "public"."StudentEnrollments" e
                                 WHERE e."schoolId" = p_school AND e."studentId" = p_student
                                   AND e."validFrom" <= g.day AND (e."validTo" IS NULL OR g.day < e."validTo")
                                 ORDER BY e."validFrom" DESC
                                 LIMIT 1) grade
                         WHERE grade."gradeLevel" IS NOT NULL
                           AND (b."minGradeLevel" IS NULL OR grade."gradeLevel" >= b."minGradeLevel")
                           AND (b."maxGradeLevel" IS NULL OR grade."gradeLevel" <= b."maxGradeLevel"))))
   ORDER BY g.day
$$;

-- The pupil's mentors on some day of [p_from, p_to]: active TEACHERs holding
-- MENTORSKAP on the pupil's class of a day on which their uppdrag runs (its
-- own Från and Till, inside its läsår) and the request does.
CREATE FUNCTION app.leave_mentors(p_school uuid, p_student uuid, p_from date, p_to date)
RETURNS SETOF uuid
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT t."userId"
    FROM "public"."StudentEnrollments" e
    JOIN "public"."TeacherDuties" t
      ON t."schoolId" = e."schoolId" AND t."studentGroupId" = e."studentGroupId" AND t."kind" = 'MENTORSKAP'
    JOIN "public"."AcademicYears" y
      ON y."id" = t."academicYearId" AND y."schoolId" = t."schoolId"
    JOIN "public"."Users" u
      ON u."id" = t."userId" AND u."schoolId" = t."schoolId" AND u."isActive" AND u."role" = 'TEACHER'
   WHERE e."schoolId" = p_school AND e."studentId" = p_student
     AND GREATEST(p_from, e."validFrom", y."startDate", COALESCE(t."validFrom", y."startDate"))
      <= LEAST(p_to, COALESCE(e."validTo" - 1, p_to), y."endDate", COALESCE(t."validTo", y."endDate"))
$$;

-- The mentors who decide a request of these dates: the pupil's mentors, when
-- the school delegates and the request has at most the limit's skoldagar.
-- None means the admin decides.
CREATE FUNCTION app.leave_deciding_mentors(p_school uuid, p_student uuid, p_from date, p_to date)
RETURNS SETOF uuid
LANGUAGE sql STABLE AS $$
  SELECT m.id
    FROM (SELECT app.leave_mentor_limit(p_school) AS max_days) lim,
         LATERAL app.leave_mentors(p_school, p_student, p_from, p_to) AS m(id)
   WHERE lim.max_days IS NOT NULL
     AND (SELECT count(*) FROM app.leave_school_days(p_school, p_student, p_from, p_to)) <= lim.max_days
$$;

REVOKE ALL ON FUNCTION app.leave_mentor_limit(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.leave_school_days(uuid, uuid, date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.leave_mentors(uuid, uuid, date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.leave_deciding_mentors(uuid, uuid, date, date) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- The notices and the gateway's functions
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.leave_mine_to_decide(p_school uuid, p_student uuid, p_from date, p_to date)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'TEACHER' OR p_school IS DISTINCT FROM app.current_school_id() THEN
    RETURN false;
  END IF;
  -- Most schools delegate nothing; ask that before anything costs a join.
  IF app.leave_mentor_limit(p_school) IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM app.leave_deciding_mentors(p_school, p_student, p_from, p_to) AS m(id)
     WHERE m.id = app.current_user_id()
  );
END
$$;

CREATE FUNCTION app.leave_request_refer(p_request uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  n integer;
BEGIN
  UPDATE "LeaveRequests" r
     SET "referredAt" = now(), "referredById" = app.current_user_id()
   WHERE r."id" = p_request
     AND r."status" = 'PENDING' AND r."referredAt" IS NULL
     AND app.leave_mine_to_decide(r."schoolId", r."studentId", r."startDate", r."endDate");
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END
$$;

CREATE FUNCTION app.leave_request_facts(p_requests uuid[])
RETURNS TABLE (
    "requestId"            uuid,
    "schoolDays"           integer,
    "mentorLimit"          integer,
    "mentorIds"            uuid[],
    "decidingMentorIds"    uuid[],
    "yearName"             text,
    "yearStart"            date,
    "yearEnd"              date,
    "yearApprovedDays"     integer,
    "yearApprovedRequests" integer,
    "yearPendingRequests"  integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  WITH me AS (
    SELECT app.current_school_id() AS school, app.current_user_id() AS id, app.current_user_role() AS role
  ),
  readable AS (
    -- The rows leave_requests_admin_all and leave_requests_mentor_select give
    -- the caller, by the same tests (RLS section 99 asserts they agree).
    SELECT r.*
      FROM "LeaveRequests" r, me
     WHERE r."id" = ANY (p_requests)
       AND r."schoolId" = me.school
       AND (me.role = 'SCHOOL_ADMIN'
            OR (me.role = 'TEACHER'
                AND ((r."decidedAs" = 'MENTOR' AND r."decidedById" = me.id)
                     OR (r."status" = 'PENDING' AND r."referredAt" IS NULL
                         AND app.leave_mine_to_decide(r."schoolId", r."studentId", r."startDate", r."endDate")))))
  )
  SELECT r."id",
         (SELECT count(*)::int FROM app.leave_school_days(r."schoolId", r."studentId", r."startDate", r."endDate")),
         app.leave_mentor_limit(r."schoolId"),
         ARRAY(SELECT m.id FROM app.leave_mentors(r."schoolId", r."studentId", r."startDate", r."endDate") AS m(id) ORDER BY 1),
         CASE WHEN r."status" = 'PENDING' AND r."referredAt" IS NULL
              THEN ARRAY(SELECT m.id FROM app.leave_deciding_mentors(r."schoolId", r."studentId", r."startDate", r."endDate") AS m(id) ORDER BY 1)
              ELSE '{}'::uuid[] END,
         y."name", y."startDate", y."endDate",
         other.approved_days, other.approved, other.pending
    FROM readable r
    LEFT JOIN LATERAL (
      SELECT a."name", a."startDate", a."endDate"
        FROM "AcademicYears" a
       WHERE a."schoolId" = r."schoolId" AND r."startDate" BETWEEN a."startDate" AND a."endDate"
       ORDER BY a."startDate" DESC
       LIMIT 1
    ) y ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum((SELECT count(*) FROM app.leave_school_days(o."schoolId", o."studentId",
                                                  GREATEST(o."startDate", y."startDate"), LEAST(o."endDate", y."endDate"))))
                        FILTER (WHERE o."status" = 'APPROVED'), 0)::int AS approved_days,
             (count(*) FILTER (WHERE o."status" = 'APPROVED'))::int AS approved,
             (count(*) FILTER (WHERE o."status" = 'PENDING'))::int AS pending
        FROM "LeaveRequests" o
       WHERE y."startDate" IS NOT NULL
         AND o."schoolId" = r."schoolId" AND o."studentId" = r."studentId" AND o."id" <> r."id"
         AND o."startDate" <= y."endDate" AND o."endDate" >= y."startDate"
    ) other ON true
   ORDER BY r."createdAt" DESC, r."id"
$$;

-- The LEAVE_REQUESTED notices the school's pending, not-passed-on requests
-- still owe: one per deciding mentor who has none about the request. One
-- request when p_request is given, every one of the school's otherwise. The
-- owner's: the trigger below and the staff catch-up call it.
CREATE FUNCTION app.leave_tell_mentors(p_school uuid, p_request uuid)
RETURNS TABLE ("notificationId" uuid, "userId" uuid, "email" text, "meta" jsonb)
LANGUAGE sql VOLATILE AS $$
  WITH pending AS (
    SELECT r."id", r."schoolId", r."studentId", r."startDate", r."endDate",
           s."firstName" || ' ' || s."lastName" AS student_name
      FROM "public"."LeaveRequests" r
      JOIN "public"."Users" s ON s."id" = r."studentId"
     WHERE r."schoolId" = p_school AND r."status" = 'PENDING' AND r."referredAt" IS NULL
       AND (p_request IS NULL OR r."id" = p_request)
  ),
  owed AS (
    SELECT p."id" AS request, p."schoolId" AS school, m.id AS mentor,
           jsonb_build_object(
             'leaveRequestId', p."id",
             'studentName', p.student_name,
             'startDate', p."startDate"::text,
             'endDate', p."endDate"::text,
             'schoolDays', (SELECT count(*) FROM app.leave_school_days(p."schoolId", p."studentId", p."startDate", p."endDate"))
           ) AS notice
      FROM pending p,
           LATERAL app.leave_deciding_mentors(p."schoolId", p."studentId", p."startDate", p."endDate") AS m(id)
     WHERE NOT EXISTS (
             SELECT 1 FROM "public"."Notifications" n
              WHERE n."userId" = m.id AND n."type" = 'LEAVE_REQUESTED'
                AND n."meta" ->> 'leaveRequestId' = p."id"::text)
  ),
  written AS (
    INSERT INTO "public"."Notifications" ("id", "schoolId", "userId", "type", "meta")
    SELECT gen_random_uuid(), o.school, o.mentor, 'LEAVE_REQUESTED', o.notice FROM owed o
    RETURNING "id", "userId", "meta"
  )
  SELECT w."id", w."userId", u."email", w."meta"
    FROM written w JOIN "public"."Users" u ON u."id" = w."userId"
$$;

REVOKE ALL ON FUNCTION app.leave_tell_mentors(uuid, uuid) FROM PUBLIC;

CREATE FUNCTION app.leave_requests_tell_mentors() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  PERFORM count(*) FROM app.leave_tell_mentors(NEW."schoolId", NEW."id");
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION app.leave_requests_tell_mentors() FROM PUBLIC;

CREATE TRIGGER "LeaveRequests_tell_mentors"
    AFTER INSERT ON "LeaveRequests"
    FOR EACH ROW EXECUTE FUNCTION app.leave_requests_tell_mentors();

-- What the filing's own transaction wrote (the trigger's notices carry the
-- transaction's now()), for a request the caller filed.
CREATE FUNCTION app.leave_request_notices(p_request uuid)
RETURNS TABLE ("notificationId" uuid, "userId" uuid, "email" text, "meta" jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT n."id", n."userId", u."email", n."meta"
    FROM "LeaveRequests" r
    JOIN "Notifications" n
      ON n."schoolId" = r."schoolId" AND n."createdAt" = now() AND n."type" = 'LEAVE_REQUESTED'
     AND n."meta" ->> 'leaveRequestId' = r."id"::text
    JOIN "Users" u ON u."id" = n."userId"
   WHERE r."id" = p_request
     AND r."schoolId" = app.current_school_id()
     AND r."requestedById" = app.current_user_id()
   ORDER BY n."userId"
$$;

CREATE FUNCTION app.leave_requests_tell_new_mentors()
RETURNS TABLE ("notificationId" uuid, "userId" uuid, "email" text, "meta" jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF NOT coalesce(app.current_user_role() IN ('TEACHER', 'SCHOOL_ADMIN'), false) OR app.current_school_id() IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT t."notificationId", t."userId", t."email", t."meta"
                 FROM app.leave_tell_mentors(app.current_school_id(), NULL) AS t
                ORDER BY t."userId";
END
$$;

CREATE FUNCTION app.leave_request_taken(p_request uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT coalesce((
    SELECT app.current_user_role() = 'TEACHER'
       AND app.current_user_id() IN (SELECT m.id FROM app.leave_mentors(r."schoolId", r."studentId", r."startDate", r."endDate") AS m(id))
       AND NOT (r."status" = 'PENDING' AND r."referredAt" IS NULL
                AND app.current_user_id() IN (
                      SELECT m.id FROM app.leave_deciding_mentors(r."schoolId", r."studentId", r."startDate", r."endDate") AS m(id)))
      FROM "LeaveRequests" r
     WHERE r."id" = p_request AND r."schoolId" = app.current_school_id()
  ), false)
$$;

COMMENT ON FUNCTION app.leave_school_days(uuid, uuid, date, date) IS
  'A pupil''s skoldagar in a period: weekdays inside a läsår (or after the last recorded one) that no SchoolBreak covering the pupil closes. src/family/school-days.ts is the same rule.';
COMMENT ON FUNCTION app.leave_mentors(uuid, uuid, date, date) IS
  'Active TEACHERs holding MENTORSKAP on the pupil''s class on some day of the period, by StudentEnrollments and the uppdrag''s own dates inside its läsår.';
COMMENT ON FUNCTION app.leave_deciding_mentors(uuid, uuid, date, date) IS
  'The mentors who decide a request of these dates under the school''s delegation in force; none means the admin decides.';
COMMENT ON FUNCTION app.leave_mine_to_decide(uuid, uuid, date, date) IS
  'Whether the caller is a TEACHER of the school among the mentors who decide a request of these dates.';
COMMENT ON FUNCTION app.leave_request_refer(uuid) IS
  'A mentor who may decide the pending request passes it on to rektor; true when it did.';
COMMENT ON FUNCTION app.leave_request_facts(uuid[]) IS
  'For the requests the caller reads as admin or deciding mentor: skoldagar, limit, mentors, läsår and the pupil''s other leave in it, never a reason.';
COMMENT ON FUNCTION app.leave_tell_mentors(uuid, uuid) IS
  'Writes the LEAVE_REQUESTED notices the school''s pending requests owe, once per mentor and request; returns them with the addresses.';
COMMENT ON FUNCTION app.leave_request_notices(uuid) IS
  'The LEAVE_REQUESTED notices this transaction wrote about a request the caller filed, with the mentors'' addresses.';
COMMENT ON FUNCTION app.leave_requests_tell_new_mentors() IS
  'For the school''s staff: writes the notices its pending requests still owe (after a delegation or an uppdrag moved them); returns them with the addresses.';
COMMENT ON FUNCTION app.leave_request_taken(uuid) IS
  'Whether a request is one of the calling mentor''s pupils'' that is no longer theirs to decide; nothing else about it.';

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "leave_requests_guardian_insert" ON "LeaveRequests";
CREATE POLICY "leave_requests_guardian_insert" ON "LeaveRequests"
    FOR INSERT TO "authenticated"
    WITH CHECK (
        "schoolId" = (select app.current_school_id())
        AND "requestedById" = (select app.current_user_id())
        AND "studentId" IN (
            SELECT gs."studentId" FROM "GuardianStudents" gs
            WHERE gs."guardianId" = (select app.current_user_id())
              AND gs."schoolId" = (select app.current_school_id())
        )
        AND "status" = 'PENDING'
        AND "decidedById" IS NULL
        AND "decidedAt" IS NULL
        AND "decisionNote" IS NULL
        AND "decidedAs" IS NULL
        AND "referredAt" IS NULL
        AND "referredById" IS NULL
    );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    DROP POLICY IF EXISTS "leave_requests_student_insert" ON "LeaveRequests";
    CREATE POLICY "leave_requests_student_insert" ON "LeaveRequests"
        FOR INSERT TO "app_authenticated"
        WITH CHECK (
            (select app.current_user_role()) = 'STUDENT'
            AND "schoolId" = (select app.current_school_id())
            AND "studentId" = (select app.current_user_id())
            AND "requestedById" = (select app.current_user_id())
            AND "status" = 'PENDING'
            AND "decidedById" IS NULL
            AND "decidedAt" IS NULL
            AND "decisionNote" IS NULL
            AND "decidedAs" IS NULL
            AND "referredAt" IS NULL
            AND "referredById" IS NULL
        );

    CREATE POLICY "leave_requests_mentor_select" ON "LeaveRequests"
        FOR SELECT TO "app_authenticated"
        USING (
            (select app.current_user_role()) = 'TEACHER'
            AND "schoolId" = (select app.current_school_id())
            AND (
                ("decidedAs" = 'MENTOR' AND "decidedById" = (select app.current_user_id()))
                OR ("status" = 'PENDING' AND "referredAt" IS NULL
                    AND app.leave_mine_to_decide("schoolId", "studentId", "startDate", "endDate"))
            )
        );

    CREATE POLICY "leave_requests_mentor_update" ON "LeaveRequests"
        FOR UPDATE TO "app_authenticated"
        USING (
            (select app.current_user_role()) = 'TEACHER'
            AND "schoolId" = (select app.current_school_id())
            AND "status" = 'PENDING' AND "referredAt" IS NULL
            AND app.leave_mine_to_decide("schoolId", "studentId", "startDate", "endDate")
        )
        WITH CHECK (
            (select app.current_user_role()) = 'TEACHER'
            AND "schoolId" = (select app.current_school_id())
            AND "status" IN ('APPROVED', 'REJECTED') AND "decidedAs" = 'MENTOR'
            AND "decidedById" = (select app.current_user_id()) AND "decidedAt" IS NOT NULL
            AND "referredAt" IS NULL AND "referredById" IS NULL
        );

    CREATE POLICY "absence_reports_mentor_leave_insert" ON "AbsenceReports"
        FOR INSERT TO "app_authenticated"
        WITH CHECK (
            (select app.current_user_role()) = 'TEACHER'
            AND "schoolId" = (select app.current_school_id())
            AND "reportedById" = (select app.current_user_id())
            AND "type" = 'OTHER'
            AND "note" = 'Approved leave'
            AND "startTime" IS NULL AND "endTime" IS NULL
            AND EXISTS (
                SELECT 1 FROM "LeaveRequests" r
                 WHERE r."schoolId" = "AbsenceReports"."schoolId"
                   AND r."studentId" = "AbsenceReports"."studentId"
                   AND r."status" = 'APPROVED' AND r."decidedAs" = 'MENTOR'
                   AND r."decidedById" = (select app.current_user_id())
                   AND "AbsenceReports"."date" BETWEEN r."startDate" AND r."endDate"
            )
        );

    CREATE POLICY "leave_delegation_decisions_staff_select" ON "LeaveDelegationDecisions"
        FOR SELECT TO "app_authenticated"
        USING (
            "schoolId" = (select app.current_school_id())
            AND (select app.current_user_role()) IN ('TEACHER', 'SCHOOL_ADMIN')
        );

    CREATE POLICY "leave_delegation_decisions_admin_insert" ON "LeaveDelegationDecisions"
        FOR INSERT TO "app_authenticated"
        WITH CHECK (
            "schoolId" = (select app.current_school_id())
            AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
        );
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Grants, guarded.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  fn text;
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['app_authenticated', 'authenticated', 'anon', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "LeaveDelegationDecisions" FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT SELECT ON "LeaveDelegationDecisions" TO "app_authenticated";
    GRANT INSERT ("schoolId", "mentorMaxSchoolDays", "reference") ON "LeaveDelegationDecisions" TO "app_authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT ON "LeaveDelegationDecisions" TO "service_role";
  END IF;

  FOREACH fn IN ARRAY ARRAY[
    'app.leave_mine_to_decide(uuid, uuid, date, date)',
    'app.leave_request_refer(uuid)',
    'app.leave_request_facts(uuid[])',
    'app.leave_request_notices(uuid)',
    'app.leave_requests_tell_new_mentors()',
    'app.leave_request_taken(uuid)'
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
