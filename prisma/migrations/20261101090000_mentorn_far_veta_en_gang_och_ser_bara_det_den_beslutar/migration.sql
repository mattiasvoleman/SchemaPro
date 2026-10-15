-- Mentorn får veta en gång om varje ansökan, och ser bara det den beslutar.
--
-- Four findings of the final review of Mentorns ledighetsbeslut
-- (20261023091000), and one of the review of its catch-up fix. That
-- migration is applied in production and stays as it is; this one replaces
-- four of its functions and adds one table.
--
-- ## Who was told is a fact of the request ("LeaveRequestNotices")
--
-- app.leave_tell_mentors counted a LEAVE_REQUESTED notice as owed whenever
-- no Notifications row said the mentor had been told. Two things undid that:
--
--   * Gallring. NOTIFICATIONS deletes notices by age, also the notice of a
--     request still pending. The next catch-up (a lov or läsår edit, a class
--     move, a new delegation) then found nothing and sent the mentor the
--     e-mail and the push again, once per retention period for as long as
--     the request waited.
--   * Concurrency. Nothing unique backed the test, and the API's
--     transactions run at READ COMMITTED: two catch-ups at once (two admins
--     saving a MENTORSKAP, a delegation saved beside an uppdrag edit) both
--     found the notice owed and both wrote it, so the mentor got two inbox
--     rows, two e-mails and two pushes.
--
-- The review proposed a unique index on Notifications ("userId",
-- meta->>'leaveRequestId'). It would stop the second, not the first: once
-- gallring has deleted the notice, an index on Notifications remembers
-- nothing. So the fact that a mentor was told about a request now lives with
-- the request, one row per (request, mentor), in "LeaveRequestNotices":
--
--   * PRIMARY KEY ("leaveRequestId", "userId"). app.leave_tell_mentors
--     inserts the told row first, ON CONFLICT DO NOTHING, and writes the
--     inbox notice only for the rows that insert returned. A second writer
--     racing the first waits on the key, finds the row committed and writes
--     nothing; a writer whose rival rolled back writes it. Exactly one
--     notice per request and mentor, whoever asks.
--   * It cascades from the request ("leaveRequestId" ON DELETE CASCADE), so
--     it goes when gallring of LEAVE_REQUESTS takes the request, and never
--     before: NOTIFICATIONS keeps its own meaning, and "gallrat före" for
--     notices still says that every notice before the date is gone. RLS
--     section 81 requires every key into LeaveRequests to cascade.
--   * That key is checked when a told row goes in, so a request deleted
--     under a catch-up (a pupil removed, a gallring batch) would fail the
--     check, and with it the write that ran the catch-up. The function
--     therefore locks the requests it reads FOR KEY SHARE, SKIP LOCKED: a
--     request whose delete is in flight is skipped, one it has locked
--     cannot be deleted before its commit. A decision or a referral locks
--     the row FOR NO KEY UPDATE, which KEY SHARE passes, so neither is ever
--     skipped. A skipped request whose delete rolls back is told at the
--     next catch-up.
--   * It cascades from the mentor's Users row ("userId", "schoolId"), as a
--     notice does. The key keeps the mentor in the row's school, and
--     app.leave_tell_mentors writes the request's school there.
--   * Row security on and no policy at all: only the owner's functions
--     below read and write it. No API role, PostgREST's or the gateway's,
--     holds any privilege on it.
--   * Backfilled from every LEAVE_REQUESTED notice still in Notifications,
--     one row per request and mentor however many notices there are (the
--     earliest notice's time), so no mentor whose notice is there is told
--     again, and no duplicate already in Notifications can stop the
--     migration. A notice gallring took before this migration is owed once
--     more, as it was before it. The backfill runs before the keys are
--     added, so the keys' lock on Users and LeaveRequests is held only for
--     their check of the few rows here.
--
-- ## A notice is never lost to a race (pg_advisory_xact_lock per school)
--
-- A guardian's INSERT racing a delegation could end with nobody told: the
-- INSERT's trigger asked for the deciding mentors before the delegation had
-- committed (no delegation, so nobody), and the delegation's catch-up ran
-- before the request had committed (no request, so nobody). The same holds
-- for an uppdrag, a class move or a lov written beside a filing.
--
-- The trigger function and app.leave_requests_tell_new_mentors now both take
-- pg_advisory_xact_lock(hashtext('leave_tell_mentors'), hashtext(school))
-- before they ask, and hold it to their commit. Whichever comes second waits
-- for the first to commit, and its next statement, under READ COMMITTED,
-- sees what the first wrote: the catch-up sees the request, or the trigger
-- sees the delegation. A filing waits only for the filings and catch-ups of
-- its own school that are in flight.
--
-- The trigger takes the lock before the INSERT's own foreign-key checks
-- (KEY SHARE on the pupil's and the filer's Users rows, and later on the
-- mentors'). So a catch-up must never run in a transaction that already
-- holds one of those rows FOR UPDATE, or each would wait for the other. The
-- gateway's callers lock rows FOR NO KEY UPDATE, which a key check passes,
-- except the admin's SS12000 apply, which may change an e-mail (a unique
-- key, so the row is held FOR UPDATE): it catches up in a transaction of its
-- own after its commit.
--
-- ## The sync and an integration key catch up too
--
-- The nightly SS12000 auto-apply (PrismaService.withSyncPrincipal) and the
-- v1 importPersons push (withServicePrincipal) move pupils between classes,
-- and app.leave_mentors reads the class. Both run with no person behind
-- them, and the catch-up answered them with nothing (TEACHER or SCHOOL_ADMIN
-- only), so the mentors were told only at the school's next staff write.
-- Now the catch-up runs for:
--
--   * a TEACHER or SCHOOL_ADMIN with no principal beside them, for their
--     school, as before;
--   * no person and exactly one of the two principals, for the school its
--     setting names (app.current_sync_school_id(),
--     app.current_service_school_id()), read the way their arms read it.
--     Those settings come only from a source row or a verified key.
--
-- Anyone else, a person beside a principal included, is answered with
-- nothing. The gateway sends the e-mail and the push after the commit: those
-- transactions have no outbox (Ss12000SyncService.autoApply,
-- Ss12000Service.importPersons).
--
-- ## The year's totals go to whoever decides (app.leave_request_facts)
--
-- The facts gave every row the caller read the pupil's leave so far in the
-- läsår: approved skoldagar, approved and pending requests, counted on every
-- read. A teacher reads the requests they decided as mentor for good, so
-- after the pupil changed class, or the teacher lost the MENTORSKAP, they
-- still saw later leave that others decided. The totals are what the decider
-- weighs, and now only the decider gets them: the admin on every row, a
-- TEACHER on a pending request theirs to decide (the only pending rows the
-- mentor arm gives them). On a TEACHER's decided row the läsår and its
-- totals are NULL. The rest of the facts are unchanged.
--
-- RLS sections 98 and 99 assert all of it.

-- ---------------------------------------------------------------------------
-- Who was told
-- ---------------------------------------------------------------------------

CREATE TABLE "LeaveRequestNotices" (
    "leaveRequestId" UUID NOT NULL,
    "userId"         UUID NOT NULL,
    "schoolId"       UUID NOT NULL,
    "toldAt"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "LeaveRequestNotices_pkey" PRIMARY KEY ("leaveRequestId", "userId")
);

CREATE INDEX "LeaveRequestNotices_userId_schoolId_idx" ON "LeaveRequestNotices"("userId", "schoolId");

INSERT INTO "LeaveRequestNotices" ("leaveRequestId", "userId", "schoolId", "toldAt")
SELECT r."id", n."userId", r."schoolId", min(n."createdAt")
  FROM "Notifications" n
  JOIN "LeaveRequests" r ON r."id"::text = n."meta" ->> 'leaveRequestId' AND r."schoolId" = n."schoolId"
  JOIN "Users" u ON u."id" = n."userId" AND u."schoolId" = r."schoolId"
 WHERE n."type" = 'LEAVE_REQUESTED'
 GROUP BY r."id", n."userId", r."schoolId";

ALTER TABLE "LeaveRequestNotices"
    ADD CONSTRAINT "LeaveRequestNotices_leaveRequestId_fkey"
    FOREIGN KEY ("leaveRequestId") REFERENCES "LeaveRequests"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeaveRequestNotices"
    ADD CONSTRAINT "LeaveRequestNotices_userId_schoolId_fkey"
    FOREIGN KEY ("userId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LeaveRequestNotices" ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE "LeaveRequestNotices" IS
  'A mentor told of a leave request (LEAVE_REQUESTED), one row per request and mentor. app.leave_tell_mentors reads and writes it; it goes with the request.';

-- ---------------------------------------------------------------------------
-- The notices
-- ---------------------------------------------------------------------------

-- The LEAVE_REQUESTED notices the school's pending, not-passed-on requests
-- still owe: one per deciding mentor not yet told of the request. One request
-- when p_request is given, every one of the school's otherwise, each locked
-- FOR KEY SHARE and skipped while its delete is in flight. The told row
-- goes in first, and a notice is written only for a told row this statement
-- inserted. The owner's: the trigger and the catch-up below call it, each
-- holding the school's lock.
CREATE OR REPLACE FUNCTION app.leave_tell_mentors(p_school uuid, p_request uuid)
RETURNS TABLE ("notificationId" uuid, "userId" uuid, "email" text, "meta" jsonb)
LANGUAGE sql VOLATILE AS $$
  WITH pending AS (
    SELECT r."id", r."schoolId", r."studentId", r."startDate", r."endDate",
           s."firstName" || ' ' || s."lastName" AS student_name
      FROM "public"."LeaveRequests" r
      JOIN "public"."Users" s ON s."id" = r."studentId"
     WHERE r."schoolId" = p_school AND r."status" = 'PENDING' AND r."referredAt" IS NULL
       AND (p_request IS NULL OR r."id" = p_request)
       FOR KEY SHARE OF r SKIP LOCKED
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
             SELECT 1 FROM "public"."LeaveRequestNotices" t
              WHERE t."leaveRequestId" = p."id" AND t."userId" = m.id)
  ),
  told AS (
    INSERT INTO "public"."LeaveRequestNotices" ("leaveRequestId", "userId", "schoolId")
    SELECT o.request, o.mentor, o.school FROM owed o
    ON CONFLICT ("leaveRequestId", "userId") DO NOTHING
    RETURNING "leaveRequestId", "userId"
  ),
  written AS (
    INSERT INTO "public"."Notifications" ("id", "schoolId", "userId", "type", "meta")
    SELECT gen_random_uuid(), o.school, o.mentor, 'LEAVE_REQUESTED', o.notice
      FROM owed o
      JOIN told t ON t."leaveRequestId" = o.request AND t."userId" = o.mentor
    RETURNING "id", "userId", "meta"
  )
  SELECT w."id", w."userId", u."email", w."meta"
    FROM written w JOIN "public"."Users" u ON u."id" = w."userId"
$$;

REVOKE ALL ON FUNCTION app.leave_tell_mentors(uuid, uuid) FROM PUBLIC;

-- The trigger: a new request's deciding mentors, after the school's lock, so
-- a delegation or an uppdrag committed while it waited is one it sees.
CREATE OR REPLACE FUNCTION app.leave_requests_tell_mentors() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('leave_tell_mentors'), hashtext(NEW."schoolId"::text));
  PERFORM count(*) FROM app.leave_tell_mentors(NEW."schoolId", NEW."id");
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION app.leave_requests_tell_mentors() FROM PUBLIC;

-- The catch-up: for the school's staff, or for the sync or an integration
-- key with no person behind it, after the school's lock, so a request filed
-- while it waited is one it sees.
CREATE OR REPLACE FUNCTION app.leave_requests_tell_new_mentors()
RETURNS TABLE ("notificationId" uuid, "userId" uuid, "email" text, "meta" jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  v_sync    uuid := app.current_sync_school_id();
  v_service uuid := app.current_service_school_id();
  v_school  uuid;
BEGIN
  IF app.current_user_id() IS NOT NULL THEN
    IF v_sync IS NULL AND v_service IS NULL
       AND coalesce(app.current_user_role() IN ('TEACHER', 'SCHOOL_ADMIN'), false) THEN
      v_school := app.current_school_id();
    END IF;
  ELSIF v_sync IS NULL OR v_service IS NULL THEN
    v_school := coalesce(v_sync, v_service);
  END IF;
  IF v_school IS NULL THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('leave_tell_mentors'), hashtext(v_school::text));
  RETURN QUERY SELECT t."notificationId", t."userId", t."email", t."meta"
                 FROM app.leave_tell_mentors(v_school, NULL) AS t
                ORDER BY t."userId";
END
$$;

-- ---------------------------------------------------------------------------
-- The facts
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.leave_request_facts(p_requests uuid[])
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
    -- the caller, by the same tests (RLS section 99 asserts they agree), and
    -- whether the caller weighs the pupil's year on it: the admin always, a
    -- teacher on a pending request, which the arm gives them only to decide.
    SELECT r.*,
           (me.role = 'SCHOOL_ADMIN' OR (r."status" = 'PENDING' AND r."referredAt" IS NULL)) AS weighs
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
         CASE WHEN r.weighs THEN other.approved_days END,
         CASE WHEN r.weighs THEN other.approved END,
         CASE WHEN r.weighs THEN other.pending END
    FROM readable r
    LEFT JOIN LATERAL (
      SELECT a."name", a."startDate", a."endDate"
        FROM "AcademicYears" a
       WHERE r.weighs
         AND a."schoolId" = r."schoolId" AND r."startDate" BETWEEN a."startDate" AND a."endDate"
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

COMMENT ON FUNCTION app.leave_tell_mentors(uuid, uuid) IS
  'Writes the LEAVE_REQUESTED notices the school''s pending requests owe, once per mentor and request by LeaveRequestNotices; returns them with the addresses. Callers hold the school''s leave_tell_mentors lock.';
COMMENT ON FUNCTION app.leave_requests_tell_new_mentors() IS
  'For the school''s staff, or the SS12000 sync or an integration key with no person: writes the notices its pending requests still owe, under the school''s lock; returns them with the addresses.';
COMMENT ON FUNCTION app.leave_request_facts(uuid[]) IS
  'For the requests the caller reads as admin or deciding mentor: skoldagar, limit, mentors, and the läsår with the pupil''s other leave in it for whoever weighs it (the admin, the mentor of a pending request); never a reason.';

-- ---------------------------------------------------------------------------
-- Grants, guarded. The table is nobody's but the owner's; the functions keep
-- the grants 20261023091000 gave them (CREATE OR REPLACE leaves them).
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['app_authenticated', 'authenticated', 'anon', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "LeaveRequestNotices" FROM %I', r);
    END IF;
  END LOOP;
END
$$;
