-- En vikarieförfrågan går till kollegor, och den första som tackar ja får uppdraget.
--
-- The data and the rules of Vikariefrågan (D4). Until now the cover board
-- (20261012100000) put a vikarie on a lesson only when an administrator
-- picked one, so a school that wanted to ask rang round in the morning. Now
-- the administrator asks chosen colleagues for one or more lessons at once;
-- the first who says yes gets all of them, the others are told it is taken,
-- and the vikarie confirms the pass with one tap. This migration is the
-- stored half; src/cover/cover-requests.service.ts is the other.
--
--   * CoverRequests            one request: who sent it, until when it can be
--                              answered, and how it ended.
--   * CoverRequestLessons      the (absence, lesson) pairs it asks for.
--   * CoverRequestRecipients   the colleagues asked, and what each answered.
--   * CoverConfirmations       the vikarie's tap on a pass, whoever put them
--                              on it: a request's winner is confirmed by
--                              their yes.
--
-- Nothing here changes an existing table's columns. Nothing reaches the
-- engine.
--
-- ## The yes is one row lock
--
-- A request ends once. Its status goes OPEN -> ACCEPTED | WITHDRAWN |
-- EXPIRED | CLOSED and never back (app.cover_requests_are_one_way, below),
-- and the gateway takes the request's row FOR UPDATE before it reads
-- anything else, so any number of colleagues answering yes in the same
-- moment queue on that one row: the first through writes ACCEPTED, and every
-- other finds it no longer OPEN when its turn comes and is told it is
-- taken. The database also refuses by itself an ACCEPTED that names someone
-- who was not asked, or that comes after the request expired
-- (CR410): the clock on the row is the database's.
--
-- A request closes on its own when the lesson it asks for is decided some
-- other way: an administrator puts someone else on it, cancels it, or
-- chooses självstudier. TeacherAbsenceCovers gains a trigger for it
-- (app.cover_request_closes_on_decision), so no writer of a decision, the
-- cover board, the old assign page, Fördela dagen or anything added later,
-- can leave a request open that cannot be answered. A lesson cancelled
-- another way (an avbokning, a schemabrytande aktivitet) is not a decision
-- of this table; the gateway refuses such a request when it is answered,
-- and the nightly expiry closes it.
--
-- ## One open request per lesson
--
-- CoverRequestLessons."open" follows the request's status (the trigger
-- below sets it false when the request ends) and the partial unique index
-- CoverRequestLessons_one_open_per_pair holds one open request per
-- (absence, lesson). Two requests for one lesson can then never both be
-- answered yes.
--
-- ## Who reads and who writes
--
-- Through the gateway only (app_authenticated); nothing for authenticated or
-- anon, service_role keeps its SELECT and nothing more, and MAINTAIN is the
-- owner's on 17 — as on every table since 20261016130000. No arm deletes: a
-- request goes only by gallring (COVER_REQUESTS) or with the school or the
-- person it names.
--
--   cover_requests_admin_select / _insert / _update
--       (a request is born open and in the name of whoever writes it: a
--       trigger stamps both, so a writer cannot send it as somebody else)
--   cover_request_lessons_admin_select / _insert / _update
--   cover_request_recipients_admin_select / _insert / _update
--   cover_confirmations_admin_select / _insert / _update
--       the school's SCHOOL_ADMIN; writes by whoever writes Drift
--       (app.current_user_may('DRIFT', true)), as the board's decisions.
--   cover_requests_recipient_select
--   cover_request_lessons_recipient_select
--       a TEACHER the requests they were asked, and the lessons on them.
--   cover_request_recipients_own_select
--       a TEACHER their own row.
--   cover_request_recipients_own_decline
--       a TEACHER their own row, to say no while the request is open
--       (app.cover_recipient_answer_is_narrow holds it to exactly that).
--   cover_confirmations_substitute_select
--       a TEACHER the confirmations of the passes that are theirs.
--
-- A teacher says yes through the gateway, which runs the placement as the
-- administrator who sent the request (src/cover/cover-requests.service.ts
-- says why and what keeps it narrow). The teacher's own part in the
-- database is app.cover_request_sender, which answers who that is only to a
-- colleague who was asked, while the request is open; and the tap on a pass,
-- app.cover_confirm, which writes the teacher's own confirmation and nobody
-- else's. A vikarie cannot read the decisions (they name the absent
-- colleague), so app.cover_my_passes answers what they need of them: their
-- own passes ahead and whether each is confirmed. app.cover_requests_expire
-- is the nightly job's, called with no login.
--
-- ## Every key
--
-- ON UPDATE NO ACTION throughout: ids are never rewritten, and a cascade
-- would carry an owner's change of a row's school into the board with row
-- security off.
--
--   * Request -> Schools CASCADE; lines, recipients -> request CASCADE.
--   * The person keys are ("id", "schoolId") to Users: the sender and the
--     one who accepted are SET NULL on their own column (a person removed
--     keeps the request's history; the request can then not be answered,
--     since nobody can place it), a recipient and a confirming vikarie are
--     CASCADE (a person removed answers nothing).
--   * A line's pair is CASCADE to the absence and the lesson, as a decision
--     is. A lesson the timetable removes takes it out of the request; a
--     request with no line left is closed by the gateway when it is
--     answered.
--   * A confirmation is CASCADE to its decision (absenceId, calendarLessonId)
--     in TeacherAbsenceCovers: an undone decision takes the confirmation
--     with it.
--
-- ## Beside the live API: every lock at once, or none
--
-- Production runs this while the API before it serves requests. No existing
-- table gains a column; the new keys take Schools, Users, TeacherAbsences,
-- CalendarLessons and TeacherAbsenceCovers in SHARE ROW EXCLUSIVE, which
-- blocks writes to them (not reads, and not the KEY SHARE a foreign-key
-- check takes) for the length of the file; the new tables are empty, so
-- each key validates nothing. A request writes CalendarLessons,
-- TeacherAbsences and Users in one transaction, so the locks are taken
-- together, NOWAIT, in a loop: a refusal rolls the subtransaction back with
-- whatever it got and tries again 50 ms later; it never waits while it
-- holds a lock, and no request queues behind it. After 30 s it stops with
-- nothing done and can be rerun (prisma migrate resolve --rolled-back, then
-- deploy). lock_timeout bounds any wait nobody foresaw. Run it outside an
-- SS12000 sync window, as 20261207090000.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Schools" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Users" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "TeacherAbsences" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "CalendarLessons" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "TeacherAbsenceCovers" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Schools, Users, TeacherAbsences, CalendarLessons and TeacherAbsenceCovers were not free at once in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

CREATE TYPE "CoverRequestStatus" AS ENUM ('OPEN', 'ACCEPTED', 'WITHDRAWN', 'EXPIRED', 'CLOSED');
CREATE TYPE "CoverRecipientAnswer" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');

-- ---------------------------------------------------------------------------
-- CoverRequests
-- ---------------------------------------------------------------------------

CREATE TABLE "CoverRequests" (
    "id"                UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"          UUID NOT NULL,
    "requestedByUserId" UUID,
    "status"            "CoverRequestStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "expiresAt"         TIMESTAMPTZ(6) NOT NULL,
    "closedAt"          TIMESTAMPTZ(6),
    "acceptedByUserId"  UUID,
    "acceptedAt"        TIMESTAMPTZ(6),

    CONSTRAINT "CoverRequests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CoverRequests_expires_after_it_is_sent" CHECK ("expiresAt" > "createdAt"),
    -- Said as equalities (an OR would read a null as unknown, which a CHECK lets through).
    CONSTRAINT "CoverRequests_closed_iff_not_open" CHECK (("status" = 'OPEN') = ("closedAt" IS NULL)),
    CONSTRAINT "CoverRequests_accepted_iff_accepted" CHECK (("status" = 'ACCEPTED') = ("acceptedAt" IS NOT NULL))
);

CREATE UNIQUE INDEX "CoverRequests_id_schoolId_key" ON "CoverRequests"("id", "schoolId");
-- The board's window and the fairness view's period, newest first.
CREATE INDEX "CoverRequests_schoolId_createdAt_idx" ON "CoverRequests"("schoolId", "createdAt");
-- The nightly expiry: the open requests, and nothing else.
CREATE INDEX "CoverRequests_open_expiresAt_idx" ON "CoverRequests"("expiresAt") WHERE "status" = 'OPEN';
-- Gallring's predicate (COVER_REQUESTS): the closed requests of a school.
CREATE INDEX "CoverRequests_schoolId_closedAt_idx" ON "CoverRequests"("schoolId", "closedAt") WHERE "closedAt" IS NOT NULL;
-- The person keys' SET NULL.
CREATE INDEX "CoverRequests_requestedByUserId_schoolId_idx" ON "CoverRequests"("requestedByUserId", "schoolId");
CREATE INDEX "CoverRequests_acceptedByUserId_schoolId_idx" ON "CoverRequests"("acceptedByUserId", "schoolId");

ALTER TABLE "CoverRequests"
    ADD CONSTRAINT "CoverRequests_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CoverRequests"
    ADD CONSTRAINT "CoverRequests_requestedByUserId_schoolId_fkey" FOREIGN KEY ("requestedByUserId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE SET NULL ("requestedByUserId") ON UPDATE NO ACTION;
ALTER TABLE "CoverRequests"
    ADD CONSTRAINT "CoverRequests_acceptedByUserId_schoolId_fkey" FOREIGN KEY ("acceptedByUserId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE SET NULL ("acceptedByUserId") ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- CoverRequestLessons
-- ---------------------------------------------------------------------------

CREATE TABLE "CoverRequestLessons" (
    "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"         UUID NOT NULL,
    "requestId"        UUID NOT NULL,
    "absenceId"        UUID NOT NULL,
    "calendarLessonId" UUID NOT NULL,
    -- True while the request is OPEN; the trigger below turns it off.
    "open"             BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "CoverRequestLessons_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CoverRequestLessons_requestId_pair_key"
    ON "CoverRequestLessons"("requestId", "absenceId", "calendarLessonId");
-- One open request per pair: two can never both be answered yes.
CREATE UNIQUE INDEX "CoverRequestLessons_one_open_per_pair"
    ON "CoverRequestLessons"("absenceId", "calendarLessonId") WHERE "open";
-- The request key's cascade and the request's lessons.
CREATE INDEX "CoverRequestLessons_requestId_schoolId_idx" ON "CoverRequestLessons"("requestId", "schoolId");
-- The lesson key's cascade and a lesson's requests.
CREATE INDEX "CoverRequestLessons_calendarLessonId_schoolId_idx" ON "CoverRequestLessons"("calendarLessonId", "schoolId");
-- The absence key's cascade.
CREATE INDEX "CoverRequestLessons_absenceId_schoolId_idx" ON "CoverRequestLessons"("absenceId", "schoolId");

ALTER TABLE "CoverRequestLessons"
    ADD CONSTRAINT "CoverRequestLessons_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CoverRequestLessons"
    ADD CONSTRAINT "CoverRequestLessons_requestId_schoolId_fkey" FOREIGN KEY ("requestId", "schoolId")
    REFERENCES "CoverRequests"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "CoverRequestLessons"
    ADD CONSTRAINT "CoverRequestLessons_absenceId_schoolId_fkey" FOREIGN KEY ("absenceId", "schoolId")
    REFERENCES "TeacherAbsences"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "CoverRequestLessons"
    ADD CONSTRAINT "CoverRequestLessons_calendarLessonId_schoolId_fkey" FOREIGN KEY ("calendarLessonId", "schoolId")
    REFERENCES "CalendarLessons"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- CoverRequestRecipients
-- ---------------------------------------------------------------------------

CREATE TABLE "CoverRequestRecipients" (
    "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"   UUID NOT NULL,
    "requestId"  UUID NOT NULL,
    "userId"     UUID NOT NULL,
    "answer"     "CoverRecipientAnswer" NOT NULL DEFAULT 'PENDING',
    "answeredAt" TIMESTAMPTZ(6),
    "createdAt"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "CoverRequestRecipients_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CoverRequestRecipients_answered_iff_answer" CHECK (("answer" = 'PENDING') = ("answeredAt" IS NULL))
);

CREATE UNIQUE INDEX "CoverRequestRecipients_requestId_userId_key" ON "CoverRequestRecipients"("requestId", "userId");
-- A colleague's requests, newest first; the person key's cascade.
CREATE INDEX "CoverRequestRecipients_userId_schoolId_createdAt_idx"
    ON "CoverRequestRecipients"("userId", "schoolId", "createdAt");
-- The request key's cascade.
CREATE INDEX "CoverRequestRecipients_requestId_schoolId_idx" ON "CoverRequestRecipients"("requestId", "schoolId");

ALTER TABLE "CoverRequestRecipients"
    ADD CONSTRAINT "CoverRequestRecipients_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CoverRequestRecipients"
    ADD CONSTRAINT "CoverRequestRecipients_requestId_schoolId_fkey" FOREIGN KEY ("requestId", "schoolId")
    REFERENCES "CoverRequests"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "CoverRequestRecipients"
    ADD CONSTRAINT "CoverRequestRecipients_userId_schoolId_fkey" FOREIGN KEY ("userId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- CoverConfirmations
-- ---------------------------------------------------------------------------

CREATE TABLE "CoverConfirmations" (
    "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"         UUID NOT NULL,
    "absenceId"        UUID NOT NULL,
    "calendarLessonId" UUID NOT NULL,
    -- The vikarie who confirmed. It counts only while the decision still
    -- names them; a decision handed to somebody else deletes the row
    -- (app.cover_confirmations_follow_decision).
    "userId"           UUID NOT NULL,
    "confirmedAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "CoverConfirmations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CoverConfirmations_absenceId_calendarLessonId_key"
    ON "CoverConfirmations"("absenceId", "calendarLessonId");
-- The vikarie's passes; the person key's cascade.
CREATE INDEX "CoverConfirmations_userId_schoolId_idx" ON "CoverConfirmations"("userId", "schoolId");
-- The lesson key's cascade; the board's window.
CREATE INDEX "CoverConfirmations_calendarLessonId_schoolId_idx" ON "CoverConfirmations"("calendarLessonId", "schoolId");
-- Gallring's predicate (COVER_REQUESTS).
CREATE INDEX "CoverConfirmations_schoolId_confirmedAt_idx" ON "CoverConfirmations"("schoolId", "confirmedAt");

ALTER TABLE "CoverConfirmations"
    ADD CONSTRAINT "CoverConfirmations_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CoverConfirmations"
    ADD CONSTRAINT "CoverConfirmations_absenceId_schoolId_fkey" FOREIGN KEY ("absenceId", "schoolId")
    REFERENCES "TeacherAbsences"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "CoverConfirmations"
    ADD CONSTRAINT "CoverConfirmations_calendarLessonId_schoolId_fkey" FOREIGN KEY ("calendarLessonId", "schoolId")
    REFERENCES "CalendarLessons"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CoverConfirmations"
    ADD CONSTRAINT "CoverConfirmations_userId_schoolId_fkey" FOREIGN KEY ("userId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "CoverConfirmations"
    ADD CONSTRAINT "CoverConfirmations_decision_fkey" FOREIGN KEY ("absenceId", "calendarLessonId")
    REFERENCES "TeacherAbsenceCovers"("absenceId", "calendarLessonId") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- A request ends once, and only the database says when.
-- ---------------------------------------------------------------------------

-- A request is born open and in the name of whoever writes it: the sender is
-- the one the gateway places a vikarie as (app.cover_request_sender), so a
-- writer with a login cannot name another administrator. A writer with no
-- login (the owner, a fixture) states what it likes.
CREATE FUNCTION app.cover_request_is_born_open_and_sent_by_its_writer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF app.current_user_id() IS NOT NULL THEN
    IF NEW."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'COVER_REQUEST_IS_FIXED: en förfrågan föds öppen'
        USING ERRCODE = 'CR400';
    END IF;
    NEW."requestedByUserId" := app.current_user_id();
    NEW."createdAt" := now();
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.cover_request_is_born_open_and_sent_by_its_writer() FROM PUBLIC;

CREATE TRIGGER "CoverRequests_a_born_open" BEFORE INSERT ON "CoverRequests"
    FOR EACH ROW EXECUTE FUNCTION app.cover_request_is_born_open_and_sent_by_its_writer();

CREATE FUNCTION app.cover_requests_are_one_way() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF NEW."schoolId" IS DISTINCT FROM OLD."schoolId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" THEN
    RAISE EXCEPTION 'COVER_REQUEST_IS_FIXED: en förfrågan byter inte skola eller tider'
      USING ERRCODE = 'CR400';
  END IF;
  -- A person removed clears their own column (the key's SET NULL), and
  -- nothing else of the request moves with it.
  IF NEW."requestedByUserId" IS DISTINCT FROM OLD."requestedByUserId" AND NEW."requestedByUserId" IS NOT NULL THEN
    RAISE EXCEPTION 'COVER_REQUEST_IS_FIXED: en förfrågan byter avsändare'
      USING ERRCODE = 'CR400';
  END IF;

  IF OLD."status" <> 'OPEN' THEN
    IF NEW."status" IS DISTINCT FROM OLD."status"
       OR NEW."closedAt" IS DISTINCT FROM OLD."closedAt"
       OR NEW."acceptedAt" IS DISTINCT FROM OLD."acceptedAt"
       OR (NEW."acceptedByUserId" IS DISTINCT FROM OLD."acceptedByUserId" AND NEW."acceptedByUserId" IS NOT NULL) THEN
      RAISE EXCEPTION 'COVER_REQUEST_ENDED: en avslutad förfrågan öppnas inte igen'
        USING ERRCODE = 'CR412';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."status" = 'OPEN' THEN
    RETURN NEW;
  END IF;

  -- OPEN -> an end: stamped with the database's clock, whatever the writer sent.
  NEW."closedAt" := clock_timestamp();
  IF NEW."status" = 'ACCEPTED' THEN
    IF NEW."acceptedByUserId" IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM "CoverRequestRecipients" r
          WHERE r."requestId" = NEW."id" AND r."userId" = NEW."acceptedByUserId" AND r."answer" = 'PENDING') THEN
      RAISE EXCEPTION 'COVER_REQUEST_NOT_ASKED: bara den som är tillfrågad och inte har svarat kan tacka ja'
        USING ERRCODE = 'CR404';
    END IF;
    IF OLD."expiresAt" <= clock_timestamp() THEN
      RAISE EXCEPTION 'COVER_REQUEST_EXPIRED: förfrågan har gått ut'
        USING ERRCODE = 'CR410';
    END IF;
    NEW."acceptedAt" := NEW."closedAt";
  ELSE
    NEW."acceptedByUserId" := NULL;
    NEW."acceptedAt" := NULL;
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.cover_requests_are_one_way() FROM PUBLIC;

CREATE TRIGGER "CoverRequests_a_one_way" BEFORE UPDATE ON "CoverRequests"
    FOR EACH ROW EXECUTE FUNCTION app.cover_requests_are_one_way();

-- A request that ends closes its lessons to a new request.
CREATE FUNCTION app.cover_request_lines_follow_status() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  UPDATE "CoverRequestLessons" SET "open" = false WHERE "requestId" = NEW."id" AND "open";
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION app.cover_request_lines_follow_status() FROM PUBLIC;

CREATE TRIGGER "CoverRequests_b_close_lines" AFTER UPDATE OF "status" ON "CoverRequests"
    FOR EACH ROW WHEN (OLD."status" = 'OPEN' AND NEW."status" <> 'OPEN')
    EXECUTE FUNCTION app.cover_request_lines_follow_status();

-- ---------------------------------------------------------------------------
-- A colleague answers for themself, once, and only to say no.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.cover_recipient_answer_is_narrow() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  req "CoverRequests";
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."answer" <> 'PENDING' THEN
      RAISE EXCEPTION 'COVER_RECIPIENT_ANSWER_NARROW: en tillfrågad börjar utan svar'
        USING ERRCODE = 'CR403';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."schoolId" IS DISTINCT FROM OLD."schoolId"
     OR NEW."requestId" IS DISTINCT FROM OLD."requestId"
     OR NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'COVER_RECIPIENT_ANSWER_NARROW: en tillfrågad byter inte förfrågan eller person'
      USING ERRCODE = 'CR403';
  END IF;
  IF NEW."answer" IS NOT DISTINCT FROM OLD."answer" THEN
    RETURN NEW;
  END IF;
  -- A person answers once: PENDING -> ACCEPTED | DECLINED, and never again.
  IF OLD."answer" <> 'PENDING' THEN
    RAISE EXCEPTION 'COVER_RECIPIENT_ANSWER_NARROW: svaret är givet'
      USING ERRCODE = 'CR411';
  END IF;
  IF app.current_user_role() = 'TEACHER' THEN
    IF NEW."answer" <> 'DECLINED' OR OLD."userId" IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'COVER_RECIPIENT_ANSWER_NARROW: en lärare kan bara tacka nej för egen del'
        USING ERRCODE = 'CR403';
    END IF;
    SELECT * INTO req FROM "CoverRequests" c WHERE c."id" = OLD."requestId";
    IF req."status" IS DISTINCT FROM 'OPEN' OR req."expiresAt" <= clock_timestamp() THEN
      RAISE EXCEPTION 'COVER_REQUEST_ENDED: förfrågan är avslutad'
        USING ERRCODE = 'CR412';
    END IF;
  END IF;
  NEW."answeredAt" := clock_timestamp();
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.cover_recipient_answer_is_narrow() FROM PUBLIC;

CREATE TRIGGER "CoverRequestRecipients_a_narrow" BEFORE INSERT OR UPDATE ON "CoverRequestRecipients"
    FOR EACH ROW EXECUTE FUNCTION app.cover_recipient_answer_is_narrow();

-- ---------------------------------------------------------------------------
-- A decision on the lesson ends the request for it, and a decision handed to
-- somebody else drops the old vikarie's confirmation.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.cover_request_closes_on_decision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  UPDATE "CoverRequests" r SET "status" = 'CLOSED'
   WHERE r."status" = 'OPEN'
     AND r."id" IN (
       SELECT l."requestId" FROM "CoverRequestLessons" l
        WHERE l."open" AND l."absenceId" = NEW."absenceId" AND l."calendarLessonId" = NEW."calendarLessonId");
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION app.cover_request_closes_on_decision() FROM PUBLIC;

CREATE TRIGGER "TeacherAbsenceCovers_c_closes_requests" AFTER INSERT OR UPDATE ON "TeacherAbsenceCovers"
    FOR EACH ROW EXECUTE FUNCTION app.cover_request_closes_on_decision();

CREATE FUNCTION app.cover_confirmations_follow_decision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  DELETE FROM "CoverConfirmations" c
   WHERE c."absenceId" = NEW."absenceId" AND c."calendarLessonId" = NEW."calendarLessonId"
     AND c."userId" IS DISTINCT FROM NEW."substituteId";
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION app.cover_confirmations_follow_decision() FROM PUBLIC;

CREATE TRIGGER "TeacherAbsenceCovers_d_drops_confirmations" AFTER UPDATE OF "substituteId", "decision" ON "TeacherAbsenceCovers"
    FOR EACH ROW EXECUTE FUNCTION app.cover_confirmations_follow_decision();

-- ---------------------------------------------------------------------------
-- The colleague asked: who placed the request, and the tap on a pass.
-- ---------------------------------------------------------------------------

-- The administrator who sent a request, to a colleague who was asked and has
-- not answered, while it is open: the principal the gateway places the
-- vikarie as. Nobody else is told, and the answers are refusals with their
-- own SQLSTATE:
--   CR404  not asked (or no such request in the caller's school)
--   CR409  taken: another colleague said yes first
--   CR410  gone: withdrawn, expired or closed by a decision on the lesson
--   CR411  the caller has answered already
--   CR412  the request has ended (the triggers' word for it)
--   CR422  the sender can no longer place a vikarie (removed, deactivated,
--          or no longer writes Drift)
CREATE FUNCTION app.cover_request_sender(p_request uuid)
RETURNS TABLE ("userId" uuid, "authId" uuid, "adminProfile" "AdminProfile", "hrRead" boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  me uuid := app.current_user_id();
  req "CoverRequests";
  mine "CoverRecipientAnswer";
BEGIN
  IF me IS NULL OR app.current_user_role() IS DISTINCT FROM 'TEACHER' THEN
    RAISE EXCEPTION 'COVER_REQUEST_NOT_FOUND' USING ERRCODE = 'CR404';
  END IF;
  SELECT * INTO req FROM "CoverRequests" c
   WHERE c."id" = p_request AND c."schoolId" = app.current_school_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'COVER_REQUEST_NOT_FOUND' USING ERRCODE = 'CR404';
  END IF;
  SELECT x."answer" INTO mine FROM "CoverRequestRecipients" x
   WHERE x."requestId" = req."id" AND x."userId" = me;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'COVER_REQUEST_NOT_FOUND' USING ERRCODE = 'CR404';
  END IF;
  IF req."status" = 'ACCEPTED' THEN
    RAISE EXCEPTION 'COVER_REQUEST_TAKEN' USING ERRCODE = 'CR409';
  END IF;
  IF req."status" <> 'OPEN' OR req."expiresAt" <= clock_timestamp() THEN
    RAISE EXCEPTION 'COVER_REQUEST_GONE' USING ERRCODE = 'CR410';
  END IF;
  IF mine <> 'PENDING' THEN
    RAISE EXCEPTION 'COVER_REQUEST_ANSWERED' USING ERRCODE = 'CR411';
  END IF;
  RETURN QUERY
    SELECT u."id", u."authId", u."adminProfile", u."hrRead"
      FROM "Users" u
     WHERE u."id" = req."requestedByUserId" AND u."schoolId" = req."schoolId"
       AND u."isActive" AND u."role" = 'SCHOOL_ADMIN'
       AND 'DRIFT' = ANY (app.admin_profile_writes(u."adminProfile"));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'COVER_REQUEST_SENDER_GONE' USING ERRCODE = 'CR422';
  END IF;
END
$$;

COMMENT ON FUNCTION app.cover_request_sender(uuid) IS
  'The administrator who sent request p_request, answered only to a TEACHER of the same school who was asked and has not answered while the request is open. The gateway places the vikarie as them. Refusals CR404, CR409, CR410, CR411 and CR422.';

-- The tap on a pass: the caller confirms every pass of theirs on the lesson
-- that a cover decision gave them, once. Answers how many are confirmed
-- (CR404 when the lesson is not theirs to confirm).
CREATE FUNCTION app.cover_confirm(p_lesson uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  me uuid := app.current_user_id();
  school uuid := app.current_school_id();
  d record;
  n integer := 0;
BEGIN
  IF me IS NULL OR school IS NULL OR app.current_user_role() IS DISTINCT FROM 'TEACHER' THEN
    RAISE EXCEPTION 'COVER_PASS_NOT_FOUND' USING ERRCODE = 'CR404';
  END IF;
  FOR d IN
    SELECT c."absenceId", c."calendarLessonId"
      FROM "TeacherAbsenceCovers" c
      JOIN "CalendarLessons" l ON l."id" = c."calendarLessonId" AND l."schoolId" = c."schoolId"
      JOIN "CalendarLessonTeachers" t ON t."calendarLessonId" = l."id" AND t."teacherId" = me AND t."role" = 'SUBSTITUTE'
     WHERE c."calendarLessonId" = p_lesson AND c."schoolId" = school
       AND c."decision" = 'SUBSTITUTE' AND c."substituteId" = me
       AND l."status" = 'SCHEDULED' AND l."endsAt" > now()
     ORDER BY c."absenceId"
  LOOP
    DELETE FROM "CoverConfirmations" x
     WHERE x."absenceId" = d."absenceId" AND x."calendarLessonId" = d."calendarLessonId" AND x."userId" <> me;
    INSERT INTO "CoverConfirmations" ("schoolId", "absenceId", "calendarLessonId", "userId")
         VALUES (school, d."absenceId", d."calendarLessonId", me)
    ON CONFLICT ("absenceId", "calendarLessonId") DO NOTHING;
    n := n + 1;
  END LOOP;
  IF n = 0 THEN
    RAISE EXCEPTION 'COVER_PASS_NOT_FOUND' USING ERRCODE = 'CR404';
  END IF;
  RETURN n;
END
$$;

COMMENT ON FUNCTION app.cover_confirm(uuid) IS
  'The calling TEACHER confirms their own pass on lesson p_lesson (a cover decision names them and they are on the lesson as SUBSTITUTE). Idempotent; answers how many passes it holds confirmed; CR404 when none is theirs.';

-- The caller's own passes in a window, as a cover decision gave them, and
-- whether they have confirmed each: a vikarie cannot read the decisions (they
-- name the absent colleague), so this answers the one thing they need, one
-- row per lesson and whether every decision on it is confirmed.
CREATE FUNCTION app.cover_my_passes(p_from timestamptz, p_to timestamptz)
RETURNS TABLE ("calendarLessonId" uuid, "confirmedAt" timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT c."calendarLessonId",
         CASE WHEN bool_and(k."id" IS NOT NULL) THEN max(k."confirmedAt") END
    FROM "TeacherAbsenceCovers" c
    JOIN "CalendarLessons" l ON l."id" = c."calendarLessonId" AND l."schoolId" = c."schoolId"
    JOIN "CalendarLessonTeachers" t
      ON t."calendarLessonId" = l."id" AND t."teacherId" = c."substituteId" AND t."role" = 'SUBSTITUTE'
    LEFT JOIN "CoverConfirmations" k
      ON k."absenceId" = c."absenceId" AND k."calendarLessonId" = c."calendarLessonId" AND k."userId" = c."substituteId"
   WHERE app.current_user_role() = 'TEACHER'
     AND c."schoolId" = app.current_school_id()
     AND c."decision" = 'SUBSTITUTE' AND c."substituteId" = app.current_user_id()
     AND l."status" = 'SCHEDULED' AND l."endsAt" > p_from AND l."startsAt" < p_to
   GROUP BY c."calendarLessonId"
$$;

COMMENT ON FUNCTION app.cover_my_passes(timestamptz, timestamptz) IS
  'The calling TEACHER''s SCHEDULED passes in the window that a cover decision gave them, with the time they confirmed (null while any is unconfirmed).';

-- The nightly expiry: the open requests whose time is out. Called by the job
-- with no principal, as the push receipts are; answers a count.
CREATE FUNCTION app.cover_requests_expire() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  n integer;
BEGIN
  UPDATE "CoverRequests" SET "status" = 'EXPIRED'
   WHERE "status" = 'OPEN' AND "expiresAt" <= clock_timestamp();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

COMMENT ON FUNCTION app.cover_requests_expire() IS
  'Ends the open requests whose expiresAt has passed (EXPIRED) in every school; answers how many.';

-- ---------------------------------------------------------------------------
-- Row-level security and grants. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "CoverRequests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoverRequestLessons" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoverRequestRecipients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoverConfirmations" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r text;
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    -- CoverRequests
    CREATE POLICY "cover_requests_admin_select" ON "CoverRequests"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "cover_requests_recipient_select" ON "CoverRequests"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'TEACHER'
               AND EXISTS (SELECT 1 FROM "CoverRequestRecipients" x
                            WHERE x."requestId" = "CoverRequests"."id"
                              AND x."userId" = (select app.current_user_id())));
    CREATE POLICY "cover_requests_admin_insert" ON "CoverRequests"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true)));
    CREATE POLICY "cover_requests_admin_update" ON "CoverRequests"
        FOR UPDATE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true)));

    -- CoverRequestLessons
    CREATE POLICY "cover_request_lessons_admin_select" ON "CoverRequestLessons"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "cover_request_lessons_recipient_select" ON "CoverRequestLessons"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'TEACHER'
               AND EXISTS (SELECT 1 FROM "CoverRequestRecipients" x
                            WHERE x."requestId" = "CoverRequestLessons"."requestId"
                              AND x."userId" = (select app.current_user_id())));
    CREATE POLICY "cover_request_lessons_admin_insert" ON "CoverRequestLessons"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true)));
    CREATE POLICY "cover_request_lessons_admin_update" ON "CoverRequestLessons"
        FOR UPDATE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true)));

    -- CoverRequestRecipients
    CREATE POLICY "cover_request_recipients_admin_select" ON "CoverRequestRecipients"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "cover_request_recipients_own_select" ON "CoverRequestRecipients"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'TEACHER'
               AND "userId" = (select app.current_user_id()));
    CREATE POLICY "cover_request_recipients_admin_insert" ON "CoverRequestRecipients"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true)));
    CREATE POLICY "cover_request_recipients_admin_update" ON "CoverRequestRecipients"
        FOR UPDATE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true)));
    CREATE POLICY "cover_request_recipients_own_decline" ON "CoverRequestRecipients"
        FOR UPDATE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'TEACHER'
               AND "userId" = (select app.current_user_id()))
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'TEACHER'
                    AND "userId" = (select app.current_user_id())
                    AND "answer" = 'DECLINED');

    -- CoverConfirmations
    CREATE POLICY "cover_confirmations_admin_select" ON "CoverConfirmations"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "cover_confirmations_substitute_select" ON "CoverConfirmations"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'TEACHER'
               AND "userId" = (select app.current_user_id()));
    CREATE POLICY "cover_confirmations_admin_insert" ON "CoverConfirmations"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true)));
    CREATE POLICY "cover_confirmations_admin_update" ON "CoverConfirmations"
        FOR UPDATE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true)));

    FOREACH t IN ARRAY ARRAY['CoverRequests', 'CoverRequestLessons', 'CoverRequestRecipients', 'CoverConfirmations'] LOOP
      EXECUTE format('REVOKE ALL ON %I FROM app_authenticated', t);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO app_authenticated', t);
    END LOOP;

    GRANT EXECUTE ON FUNCTION app.cover_request_sender(uuid) TO "app_authenticated";
    GRANT EXECUTE ON FUNCTION app.cover_confirm(uuid) TO "app_authenticated";
    GRANT EXECUTE ON FUNCTION app.cover_my_passes(timestamptz, timestamptz) TO "app_authenticated";
    GRANT EXECUTE ON FUNCTION app.cover_requests_expire() TO "app_authenticated";
  END IF;

  FOREACH t IN ARRAY ARRAY['CoverRequests', 'CoverRequestLessons', 'CoverRequestRecipients', 'CoverConfirmations'] LOOP
    FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM service_role', t);
    END IF;
    -- PostgreSQL 17's MAINTAIN (REINDEX, CLUSTER, VACUUM, LOCK): the owner's alone.
    IF current_setting('server_version_num')::int >= 170000 THEN
      FOREACH r IN ARRAY ARRAY['authenticated', 'app_authenticated', 'service_role', 'anon'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
          EXECUTE format('REVOKE MAINTAIN ON %I FROM %I', t, r);
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  -- The functions answer the API's role alone.
  FOREACH t IN ARRAY ARRAY['app.cover_request_sender(uuid)', 'app.cover_confirm(uuid)', 'app.cover_my_passes(timestamptz, timestamptz)', 'app.cover_requests_expire()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- COVER_REQUEST_REACH: the arms above and no other; none for a PostgREST
-- role, the service or the sync principal. Each expression an arm has
-- (USING, WITH CHECK) names the caller's school and the arm's role, has no
-- OR and no NOT, and a teacher's arm anchors its own column or its own
-- recipient row to the caller: a name and a command alone would let
-- `USING (true)` through.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  bad text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    RETURN;
  END IF;
  SELECT string_agg(p.tablename || '.' || p.policyname || ' ' || p.cmd || ' ' || p.roles::text, ', ' ORDER BY p.tablename, p.policyname) INTO bad
    FROM pg_policies p
   WHERE p.schemaname = 'public'
     AND p.tablename IN ('CoverRequests', 'CoverRequestLessons', 'CoverRequestRecipients', 'CoverConfirmations')
     AND NOT coalesce(
           p.roles = '{app_authenticated}'::name[]
           AND p.permissive = 'PERMISSIVE'
           AND (p.tablename, p.policyname, p.cmd) IN (
                 ('CoverRequests', 'cover_requests_admin_select', 'SELECT'),
                 ('CoverRequests', 'cover_requests_recipient_select', 'SELECT'),
                 ('CoverRequests', 'cover_requests_admin_insert', 'INSERT'),
                 ('CoverRequests', 'cover_requests_admin_update', 'UPDATE'),
                 ('CoverRequestLessons', 'cover_request_lessons_admin_select', 'SELECT'),
                 ('CoverRequestLessons', 'cover_request_lessons_recipient_select', 'SELECT'),
                 ('CoverRequestLessons', 'cover_request_lessons_admin_insert', 'INSERT'),
                 ('CoverRequestLessons', 'cover_request_lessons_admin_update', 'UPDATE'),
                 ('CoverRequestRecipients', 'cover_request_recipients_admin_select', 'SELECT'),
                 ('CoverRequestRecipients', 'cover_request_recipients_own_select', 'SELECT'),
                 ('CoverRequestRecipients', 'cover_request_recipients_admin_insert', 'INSERT'),
                 ('CoverRequestRecipients', 'cover_request_recipients_admin_update', 'UPDATE'),
                 ('CoverRequestRecipients', 'cover_request_recipients_own_decline', 'UPDATE'),
                 ('CoverConfirmations', 'cover_confirmations_admin_select', 'SELECT'),
                 ('CoverConfirmations', 'cover_confirmations_substitute_select', 'SELECT'),
                 ('CoverConfirmations', 'cover_confirmations_admin_insert', 'INSERT'),
                 ('CoverConfirmations', 'cover_confirmations_admin_update', 'UPDATE'))
           AND (SELECT bool_and(
                         e LIKE '%current_school_id()%'
                         AND e NOT LIKE '% OR %'
                         AND e NOT LIKE '%NOT %'
                         AND e LIKE CASE WHEN p.policyname LIKE '%\_admin\_%' ESCAPE '\'
                                         THEN '%current_user_role()%= ''SCHOOL_ADMIN''::"UserRole"%'
                                         ELSE '%current_user_role()%= ''TEACHER''::"UserRole"%' END
                         AND e LIKE CASE
                                      WHEN p.policyname LIKE '%\_admin\_%' ESCAPE '\' THEN '%'
                                      WHEN p.policyname IN ('cover_requests_recipient_select', 'cover_request_lessons_recipient_select')
                                        THEN '%"userId" = ( SELECT app.current_user_id() AS current_user_id)%'
                                      ELSE '%("userId" = ( SELECT app.current_user_id() AS current_user_id))%' END)
                  FROM unnest(ARRAY[p.qual, p.with_check]) e
                 WHERE e IS NOT NULL)
           AND (p.cmd = 'SELECT' OR p.policyname NOT LIKE '%\_admin\_%' ESCAPE '\'
                OR coalesce(p.with_check, p.qual) LIKE '%current_user_may(''DRIFT''%'),
         false);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'COVER_REQUEST_REACH: these arms reach the vikarieförfrågningar beyond the admin''s, the recipient''s own and Drift''s writes: %', bad;
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'
       AND tablename IN ('CoverRequests', 'CoverRequestLessons', 'CoverRequestRecipients', 'CoverConfirmations')) <> 17 THEN
    RAISE EXCEPTION 'COVER_REQUEST_REACH: the four tables have % arms, not the seventeen above',
      (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'
        AND tablename IN ('CoverRequests', 'CoverRequestLessons', 'CoverRequestRecipients', 'CoverConfirmations'));
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Gallring: COVER_REQUESTS (20270102090000). Both bodies are 20261026091000's
-- plus the one branch marked "vikarieförfrågningar". A request goes once it
-- has ended and its end is before the cutoff (the school's local midnight),
-- with its lessons and its recipients; a confirmation goes once it is that
-- old. An OPEN request is never due: it ends first.
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
  -- vikarieförfrågningar
  SELECT 'CoverRequests', q."id"
    FROM school, "public"."CoverRequests" q
   WHERE p_type = 'COVER_REQUESTS' AND q."schoolId" = school."id"
     AND q."status" <> 'OPEN' AND q."closedAt" < school.before_at
  UNION ALL
  SELECT 'CoverConfirmations', c."id"
    FROM school, "public"."CoverConfirmations" c
   WHERE p_type = 'COVER_REQUESTS' AND c."schoolId" = school."id" AND c."confirmedAt" < school.before_at
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
    -- vikarieförfrågningar
    WHEN 'COVER_REQUESTS' THEN
      DELETE FROM "CoverRequests" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'CoverRequests' LIMIT budget);
      GET DIAGNOSTICS step = ROW_COUNT;
      n := step;
      IF n < budget THEN
        DELETE FROM "CoverConfirmations" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'CoverConfirmations' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
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
