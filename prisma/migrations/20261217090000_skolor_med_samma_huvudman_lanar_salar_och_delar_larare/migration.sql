-- Skolor med samma huvudman lånar varandras salar, delar lärare och anger restiden mellan sig.
--
-- Roadmap: Kommun lane, phase "Delade lokaler och lärare", first half (the
-- data, who reads it and who writes it). Built on Huvudman (20261212090000),
-- whose HuvudmanSchools says which schools belong together, and on Flera
-- skolor per inloggning (20261204090000), whose one login with a Users row
-- per school is what makes a teacher the same person at two schools. The
-- generator and the publish checks read what this file adds in the second
-- half, in a later release; nothing the API does today changes here.
--
-- ## No school reads another school's tables
--
-- Not one existing policy is changed, and no column is added to an existing
-- table. Every read across two schools is a SECURITY DEFINER function below
-- that answers for the chosen school (app.current_school_id()), only about a
-- school with the same huvudman, and only with the columns the sharing
-- needs. The two new tables hold rows that belong to two schools at once,
-- and each side reads them under its own arms.
--
-- A school that leaves its huvudman, or that the huvudman lets go, drops out
-- of all of it at the next statement: its rows stay where they are, and no
-- arm or function reads them while the two schools have different huvudmän.
--
-- ## Restid mellan skolorna ("SchoolTravelTimes")
--
-- The minutes between two schools of one huvudman: one figure per pair, the
-- same both ways, stored once with the lower id first (CHECK), 0..240, as
-- "SiteTravelTimes" (20261124090000) holds a school's own sites. The pair is
-- the schools, not their sites: most schools have one site or none, and a
-- rule that needed sites on both sides would do nothing until both schools
-- had drawn them. A school with sites far apart states the longest walk.
-- Either school's planner (PLANERING) writes the figure, "setBySchoolId"
-- says which did last, and both schools' staff read it.
--
-- ## Delade lärare (no table)
--
-- A teacher is shared when one login holds an active staff row (TEACHER or
-- SCHOOL_ADMIN) at two schools with the same huvudman. That is the identity
-- 20261204090000 already keeps: a second school takes a login only through
-- its invitation (the trigger Users_a_login_joins_another_school_by_
-- invitation refuses every other writer), and a row never invited holds a
-- placeholder that matches nobody. Matching on e-mail was weighed and left
-- out: a mistyped address at B would hand B somebody else's times at A. So
-- was a link table the two schools approve: A cannot name B's row without
-- reading B's staff, and the login already proves what the link would.
--
--   app.shared_teachers()            the chosen school's own rows that are
--                                    shared, with the other school's id and
--                                    name. Never the other school's row,
--                                    name or role.
--   app.shared_teacher_busy(from, to)
--                                    the other school's lessons of each
--                                    shared teacher the chosen school itself
--                                    plans (a timplanspost, a share of one,
--                                    or a lesson of its grundschema): the
--                                    weekday, start, end, weeks (ALL, ODD,
--                                    EVEN) and dates, and the minutes
--                                    between the two schools. Not the
--                                    subject, the group, the room or a pupil.
--                                    From the other school's grundschema
--                                    (MasterLessons), parked lessons left
--                                    out, in its läsår that meet the dates.
--
-- "That the school itself plans": a teacher's times at A reach B only when
-- B has given the teacher teaching to plan. The times are what B's
-- generator and publish need, and nothing more: a row B invites without
-- planning any lesson for it reads nothing of A.
--
-- Both ask for an administrator who reads Schemaläggning (every profile
-- does, the huvudman's reader too, as the school's läsare). A teacher's
-- lesson times are the timetable layer, which every member of staff reads
-- at the school itself; the read log does not record them
-- (src/access-log/access-log.ts says why).
--
-- ## Salslån ("RoomLoans")
--
-- A loan is a weekly window (weekday, start, end) between two dates, at most
-- 400 days apart, of a room of the owner school (A), for the borrower school
-- (B): how a kommun shares a sports hall or a slöjd room, the same times all
-- year.
--
--   * The borrower's lessons need a room of their own school: MasterLessons
--     and CalendarLessons hold (roomId, schoolId) to "Rooms". So the
--     borrower keeps a room of its own for the room it borrows, say
--     "Idrottshallen (Skola A)", made by the gateway in B's own transaction
--     at the first request and named again by every later one
--     ("localRoomId"). Two EXCLUDE constraints hold the pairing: one room of
--     A has one local room at B, and a local room stands for one room.
--   * Only the four functions below write a loan, each for one side:
--       room_loan_request   B's planner asks (PENDING);
--       room_loan_decide    A's planner approves or declines;
--       room_loan_withdraw  B withdraws a pending or approved loan;
--       room_loan_revoke    A ends an approved one.
--     No API role inserts, updates or deletes the table: a row of two
--     schools has no column either side may write alone.
--   * The owner's planner (PLANERING) decides every loan, whatever the
--     room's requiresApproval says. That flag is about the school's own
--     people booking a special room for an hour; a loan holds the room in
--     another school's grundschema for a year.
--   * Two approved loans of one room never share a minute on a date both
--     run: RoomLoans_a_room_is_lent_once (EXCLUDE, as SupervisionShifts;
--     btree_gist is installed since 20260822131500). Approving one that
--     would is refused (23P01, which the gateway gives as 409).
--   * Both schools' staff read the loans between them. A planner of B reads
--     the rooms B may ask for through app.lendable_rooms(): a sibling
--     school's rooms, name, capacity and room type, never a local room. No
--     person's name crosses: B reads "approved by Skola A", A reads "asked
--     by Skola B".
--
-- ## Beside the live API
--
-- The new tables' foreign keys take SHARE ROW EXCLUSIVE on "Schools",
-- "Rooms" and "Users" (writes wait, reads do not), NOWAIT and together in a
-- loop: a refusal rolls the subtransaction back with whatever it got and
-- tries again 50 ms later, so the migration never waits while it holds a
-- lock and no request queues behind it; after 30 s it stops with nothing
-- changed (prisma migrate resolve --rolled-back, then deploy). lock_timeout
-- bounds any wait nobody foresaw. Functions are made without a table lock.
--
-- The API before this release reads none of it: it works on this schema
-- unchanged, and a rollback past the release leaves two tables nobody reads.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Schools" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Rooms" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Users" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Schools, Rooms and Users were not free at once in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- SchoolTravelTimes
-- ---------------------------------------------------------------------------

CREATE TABLE "SchoolTravelTimes" (
    "schoolAId"     UUID NOT NULL,
    "schoolBId"     UUID NOT NULL,
    "minutes"       INTEGER NOT NULL,
    "setBySchoolId" UUID NOT NULL,
    "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SchoolTravelTimes_pkey" PRIMARY KEY ("schoolAId", "schoolBId"),
    CONSTRAINT "SchoolTravelTimes_lower_id_first" CHECK ("schoolAId" < "schoolBId"),
    CONSTRAINT "SchoolTravelTimes_minutes_range" CHECK ("minutes" BETWEEN 0 AND 240),
    CONSTRAINT "SchoolTravelTimes_set_by_one_of_the_two" CHECK ("setBySchoolId" IN ("schoolAId", "schoolBId"))
);

CREATE INDEX "SchoolTravelTimes_schoolBId_idx" ON "SchoolTravelTimes"("schoolBId");

ALTER TABLE "SchoolTravelTimes"
    ADD CONSTRAINT "SchoolTravelTimes_schoolAId_fkey" FOREIGN KEY ("schoolAId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SchoolTravelTimes"
    ADD CONSTRAINT "SchoolTravelTimes_schoolBId_fkey" FOREIGN KEY ("schoolBId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- RoomLoans
-- ---------------------------------------------------------------------------

CREATE TYPE "RoomLoanStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED', 'WITHDRAWN', 'REVOKED');

CREATE TABLE "RoomLoans" (
    "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
    "ownerSchoolId"    UUID NOT NULL,
    "roomId"           UUID NOT NULL,
    "borrowerSchoolId" UUID NOT NULL,
    "localRoomId"      UUID NOT NULL,
    "dayOfWeek"        INTEGER NOT NULL,
    "startTime"        TIME(0) NOT NULL,
    "endTime"          TIME(0) NOT NULL,
    "startDate"        DATE NOT NULL,
    "endDate"          DATE NOT NULL,
    "status"           "RoomLoanStatus" NOT NULL DEFAULT 'PENDING',
    "note"             TEXT,
    "requestedById"    UUID,
    "decidedById"      UUID,
    "decidedAt"        TIMESTAMPTZ(6),
    "endedAt"          TIMESTAMPTZ(6),
    "createdAt"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoomLoans_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RoomLoans_between_two_schools" CHECK ("ownerSchoolId" <> "borrowerSchoolId"),
    CONSTRAINT "RoomLoans_day_of_week_range" CHECK ("dayOfWeek" BETWEEN 1 AND 7),
    CONSTRAINT "RoomLoans_start_before_end" CHECK ("startTime" < "endTime"),
    CONSTRAINT "RoomLoans_dates_in_order" CHECK ("startDate" <= "endDate"),
    CONSTRAINT "RoomLoans_at_most_400_days" CHECK ("endDate" <= "startDate" + 400),
    CONSTRAINT "RoomLoans_note_is_text" CHECK ("note" IS NULL OR (char_length("note") BETWEEN 1 AND 300 AND "note" = btrim("note"))),
    -- A pending loan has no decision; an approved, declined or revoked one
    -- has; a withdrawn one has one when it was approved first.
    CONSTRAINT "RoomLoans_a_pending_loan_is_undecided" CHECK ("status" <> 'PENDING' OR ("decidedAt" IS NULL AND "decidedById" IS NULL)),
    CONSTRAINT "RoomLoans_a_decided_loan_says_when" CHECK ("status" NOT IN ('APPROVED', 'DECLINED', 'REVOKED') OR "decidedAt" IS NOT NULL),
    CONSTRAINT "RoomLoans_an_ended_loan_says_when" CHECK (("endedAt" IS NOT NULL) = ("status" IN ('WITHDRAWN', 'REVOKED'))),
    -- Two approved loans of one room never share a minute on a date both run.
    CONSTRAINT "RoomLoans_a_room_is_lent_once" EXCLUDE USING gist (
        "roomId" WITH =,
        "dayOfWeek" WITH =,
        tsrange(DATE '2000-01-03' + "startTime", DATE '2000-01-03' + "endTime") WITH &&,
        daterange("startDate", "endDate", '[]') WITH &&
    ) WHERE ("status" = 'APPROVED'),
    -- One room of the owner has one local room at the borrower ...
    CONSTRAINT "RoomLoans_one_local_room_per_room" EXCLUDE USING gist (
        "borrowerSchoolId" WITH =,
        "roomId" WITH =,
        "localRoomId" WITH <>
    ),
    -- ... and a local room stands for one room.
    CONSTRAINT "RoomLoans_a_local_room_stands_for_one_room" EXCLUDE USING gist (
        "localRoomId" WITH =,
        "roomId" WITH <>
    )
);

CREATE INDEX "RoomLoans_ownerSchoolId_status_idx" ON "RoomLoans"("ownerSchoolId", "status");
CREATE INDEX "RoomLoans_borrowerSchoolId_status_idx" ON "RoomLoans"("borrowerSchoolId", "status");
-- The two foreign keys' ON DELETE CASCADE scan these.
CREATE INDEX "RoomLoans_roomId_idx" ON "RoomLoans"("roomId");
CREATE INDEX "RoomLoans_localRoomId_idx" ON "RoomLoans"("localRoomId");

ALTER TABLE "RoomLoans"
    ADD CONSTRAINT "RoomLoans_ownerSchoolId_fkey" FOREIGN KEY ("ownerSchoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoomLoans"
    ADD CONSTRAINT "RoomLoans_borrowerSchoolId_fkey" FOREIGN KEY ("borrowerSchoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoomLoans"
    ADD CONSTRAINT "RoomLoans_roomId_ownerSchoolId_fkey" FOREIGN KEY ("roomId", "ownerSchoolId")
    REFERENCES "Rooms"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "RoomLoans"
    ADD CONSTRAINT "RoomLoans_localRoomId_borrowerSchoolId_fkey" FOREIGN KEY ("localRoomId", "borrowerSchoolId")
    REFERENCES "Rooms"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "RoomLoans"
    ADD CONSTRAINT "RoomLoans_requestedById_borrowerSchoolId_fkey" FOREIGN KEY ("requestedById", "borrowerSchoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE SET NULL ("requestedById") ON UPDATE NO ACTION;
ALTER TABLE "RoomLoans"
    ADD CONSTRAINT "RoomLoans_decidedById_ownerSchoolId_fkey" FOREIGN KEY ("decidedById", "ownerSchoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE SET NULL ("decidedById") ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- The schools of the chosen school's huvudman.
-- ---------------------------------------------------------------------------

-- The chosen school and every other school its huvudman owns, or nothing
-- for a school without one (and for no principal). The arms below ask it
-- once per statement: = ANY ((select app.same_huvudman_school_ids())::uuid[]).
CREATE FUNCTION app.same_huvudman_school_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT coalesce(array_agg(b."schoolId" ORDER BY b."schoolId"), '{}'::uuid[])
    FROM "HuvudmanSchools" a
    JOIN "HuvudmanSchools" b ON b."huvudmanId" = a."huvudmanId"
   WHERE a."schoolId" = app.current_school_id()
$$;

COMMENT ON FUNCTION app.same_huvudman_school_ids() IS
  'Delade lokaler och lärare (20261217090000): the chosen school and the other schools of its huvudman; empty without a huvudman.';

-- The other schools of the huvudman, by name, for the school's staff.
CREATE FUNCTION app.sibling_schools() RETURNS TABLE (school_id uuid, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT s."id", s."name"
    FROM "Schools" s
   WHERE s."id" = ANY ((select app.same_huvudman_school_ids())::uuid[])
     AND s."id" <> (select app.current_school_id())
     AND (select app.current_user_role()) IN ('SCHOOL_ADMIN', 'TEACHER')
   ORDER BY s."name", s."id"
$$;

COMMENT ON FUNCTION app.sibling_schools() IS
  'Delade lokaler och lärare (20261217090000): the other schools of the chosen school''s huvudman, id and name, for its staff.';

-- ---------------------------------------------------------------------------
-- Delade lärare. See the preamble.
-- ---------------------------------------------------------------------------

-- The chosen school's own rows that one login shares with an active staff
-- row at another school of the huvudman, with that school's id and name.
CREATE FUNCTION app.shared_teachers() RETURNS TABLE (teacher_id uuid, school_id uuid, school_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT own."id", other."schoolId", s."name"
    FROM "Users" own
    JOIN "Users" other ON other."authId" = own."authId" AND other."schoolId" <> own."schoolId"
    JOIN "Schools" s ON s."id" = other."schoolId"
   WHERE own."schoolId" = (select app.current_school_id())
     AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
     AND (select app.current_user_may('SCHEMALAGGNING', false))
     AND own."isActive" AND own."role" IN ('TEACHER', 'SCHOOL_ADMIN')
     AND other."isActive" AND other."role" IN ('TEACHER', 'SCHOOL_ADMIN')
     AND other."schoolId" = ANY ((select app.same_huvudman_school_ids())::uuid[])
   ORDER BY own."id", s."name", other."schoolId"
$$;

COMMENT ON FUNCTION app.shared_teachers() IS
  'Delade lokaler och lärare (20261217090000): the chosen school''s own staff rows whose login holds an active staff row at another school of the huvudman, with that school''s id and name. For an administrator; never the other school''s row.';

-- The other schools' lessons of each shared teacher the chosen school plans,
-- in their grundschema's läsår that meet [p_from, p_to]: times, weeks and
-- dates only, with the minutes between the two schools (NULL: not stated).
CREATE FUNCTION app.shared_teacher_busy(p_from date, p_to date)
RETURNS TABLE (teacher_id uuid, school_id uuid, day_of_week integer, start_time time, end_time time,
               recurrence "LessonRecurrence", start_date date, end_date date, travel_minutes integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  WITH shared AS (
    SELECT own."id" AS own_id, other."id" AS other_id, other."schoolId" AS other_school, own."schoolId" AS own_school
      FROM "Users" own
      JOIN "Users" other ON other."authId" = own."authId" AND other."schoolId" <> own."schoolId"
     WHERE own."schoolId" = (select app.current_school_id())
       AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
       AND (select app.current_user_may('SCHEMALAGGNING', false))
       AND own."isActive" AND own."role" IN ('TEACHER', 'SCHOOL_ADMIN')
       AND other."isActive" AND other."role" IN ('TEACHER', 'SCHOOL_ADMIN')
       AND other."schoolId" = ANY ((select app.same_huvudman_school_ids())::uuid[])
       -- The chosen school plans teaching for the teacher.
       AND (EXISTS (SELECT 1 FROM "TeachingRequirements" r
                     WHERE r."schoolId" = own."schoolId" AND (r."teacherId" = own."id" OR r."coTeacherId" = own."id"))
            OR EXISTS (SELECT 1 FROM "TeachingRequirementShares" sh
                        WHERE sh."schoolId" = own."schoolId" AND sh."teacherId" = own."id")
            OR EXISTS (SELECT 1 FROM "MasterLessons" ml
                        WHERE ml."schoolId" = own."schoolId" AND (ml."teacherId" = own."id" OR ml."coTeacherId" = own."id")))
  )
  SELECT sh.own_id, sh.other_school, m."dayOfWeek", m."startTime", m."endTime", m."recurrence",
         coalesce(m."startDate", y."startDate"), coalesce(m."endDate", y."endDate"), tt."minutes"
    FROM shared sh
    JOIN "MasterLessons" m ON m."schoolId" = sh.other_school
                          AND (m."teacherId" = sh.other_id OR m."coTeacherId" = sh.other_id)
    JOIN "AcademicYears" y ON y."id" = m."academicYearId" AND y."schoolId" = m."schoolId"
    LEFT JOIN "SchoolTravelTimes" tt ON tt."schoolAId" = least(sh.own_school, sh.other_school)
                                    AND tt."schoolBId" = greatest(sh.own_school, sh.other_school)
   WHERE NOT m."isParked"
     AND p_from IS NOT NULL AND p_to IS NOT NULL AND p_from <= p_to
     AND coalesce(m."startDate", y."startDate") <= p_to
     AND coalesce(m."endDate", y."endDate") >= p_from
   ORDER BY sh.own_id, sh.other_school, m."dayOfWeek", m."startTime", m."endTime"
$$;

COMMENT ON FUNCTION app.shared_teacher_busy(date, date) IS
  'Delade lokaler och lärare (20261217090000): the lessons at another school of the huvudman of each shared teacher the chosen school plans: weekday, times, weeks, dates and the minutes between the schools. Never the subject, group, room or pupils. For an administrator.';

-- ---------------------------------------------------------------------------
-- Salslån. See the preamble.
-- ---------------------------------------------------------------------------

-- The rooms the chosen school may ask to borrow: every room of another
-- school of the huvudman, except a room that school itself borrows.
CREATE FUNCTION app.lendable_rooms()
RETURNS TABLE (school_id uuid, room_id uuid, name text, capacity integer, room_type_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT r."schoolId", r."id", r."name", r."capacity", t."name"
    FROM "Rooms" r
    LEFT JOIN "RoomTypes" t ON t."id" = r."roomTypeId"
   WHERE r."schoolId" = ANY ((select app.same_huvudman_school_ids())::uuid[])
     AND r."schoolId" <> (select app.current_school_id())
     AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
     AND (select app.current_user_may('PLANERING', false))
     AND NOT EXISTS (SELECT 1 FROM "RoomLoans" l WHERE l."localRoomId" = r."id")
   ORDER BY r."schoolId", r."name", r."id"
$$;

COMMENT ON FUNCTION app.lendable_rooms() IS
  'Delade lokaler och lärare (20261217090000): the rooms of the other schools of the huvudman the chosen school may ask to borrow (name, capacity, room type), never a room that school itself borrows. For an administrator.';

-- The chosen school's planner (PLANERING write) and their row, or RL403.
CREATE FUNCTION app.room_loan_planner() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  v_user uuid := app.current_user_id();
BEGIN
  IF v_user IS NULL OR app.current_school_id() IS NULL
     OR app.current_user_role() IS DISTINCT FROM 'SCHOOL_ADMIN'
     OR NOT coalesce(app.current_user_may('PLANERING', true), false) THEN
    RAISE EXCEPTION 'ROOM_LOAN_NOT_YOURS' USING ERRCODE = 'RL403';
  END IF;
  RETURN v_user;
END
$$;

-- One room's loans, in order: a request names the local room again, and two
-- requests at once must agree on it before the EXCLUDE has to say so.
CREATE FUNCTION app.room_loan_lock(p_room uuid) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('RoomLoans:' || p_room::text, 0))
$$;

CREATE FUNCTION app.room_loan_request(p_room uuid, p_local_room uuid, p_day integer, p_start time, p_end time,
                                      p_from date, p_to date, p_note text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  v_user   uuid := app.room_loan_planner();
  v_school uuid := app.current_school_id();
  v_owner  uuid;
  v_local  uuid;
  v_id     uuid;
BEGIN
  -- A room of a school without the same huvudman is not there to ask for,
  -- and nor is a room its school borrows itself (app.lendable_rooms()).
  SELECT r."schoolId" INTO v_owner FROM "Rooms" r WHERE r."id" = p_room;
  IF NOT FOUND OR v_owner = v_school OR NOT (v_owner = ANY (app.same_huvudman_school_ids()))
     OR EXISTS (SELECT 1 FROM "RoomLoans" l WHERE l."localRoomId" = p_room) THEN
    RAISE EXCEPTION 'ROOM_LOAN_ROOM_NOT_FOUND' USING ERRCODE = 'RL404';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Rooms" r WHERE r."id" = p_local_room AND r."schoolId" = v_school) THEN
    RAISE EXCEPTION 'ROOM_LOAN_LOCAL_ROOM_NOT_FOUND' USING ERRCODE = 'RL404';
  END IF;
  PERFORM app.room_loan_lock(p_room);
  -- The local room stands for this room alone, and is not lent out itself.
  IF EXISTS (SELECT 1 FROM "RoomLoans" l WHERE l."roomId" = p_local_room) THEN
    RAISE EXCEPTION 'ROOM_LOAN_LOCAL_ROOM_IS_LENT' USING ERRCODE = 'RL409';
  END IF;
  SELECT l."localRoomId" INTO v_local FROM "RoomLoans" l
   WHERE l."borrowerSchoolId" = v_school AND l."roomId" = p_room LIMIT 1;
  IF FOUND AND v_local <> p_local_room THEN
    RAISE EXCEPTION 'ROOM_LOAN_LOCAL_ROOM_IS_ANOTHER' USING ERRCODE = 'RL409';
  END IF;
  IF EXISTS (SELECT 1 FROM "RoomLoans" l WHERE l."localRoomId" = p_local_room AND l."roomId" <> p_room) THEN
    RAISE EXCEPTION 'ROOM_LOAN_LOCAL_ROOM_IS_ANOTHER' USING ERRCODE = 'RL409';
  END IF;
  INSERT INTO "RoomLoans" ("ownerSchoolId", "roomId", "borrowerSchoolId", "localRoomId", "dayOfWeek",
                           "startTime", "endTime", "startDate", "endDate", "note", "requestedById")
  VALUES (v_owner, p_room, v_school, p_local_room, p_day, p_start, p_end, p_from, p_to,
          nullif(btrim(p_note), ''), v_user)
  RETURNING "id" INTO v_id;
  RETURN v_id;
END
$$;

COMMENT ON FUNCTION app.room_loan_request(uuid, uuid, integer, time, time, date, date, text) IS
  'Delade lokaler och lärare (20261217090000): the chosen school''s planner asks to borrow a room of another school of the huvudman, one weekly window between two dates, held at the chosen school by its own local room. RL403 (not a planner), RL404 (no such room to ask for, or no such local room), RL409 (a local room that stands for another room or is lent out).';

-- The loan of p_loan the chosen school is the owner (or borrower) of, while
-- the other school has the same huvudman, locked; or RL404.
CREATE FUNCTION app.room_loan_of(p_loan uuid, p_as_owner boolean) RETURNS "RoomLoans"
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  v_school uuid := app.current_school_id();
  v_loan   "RoomLoans";
BEGIN
  SELECT * INTO v_loan FROM "RoomLoans" l WHERE l."id" = p_loan;
  IF NOT FOUND
     OR (CASE WHEN p_as_owner THEN v_loan."ownerSchoolId" ELSE v_loan."borrowerSchoolId" END) IS DISTINCT FROM v_school
     OR NOT (v_loan."ownerSchoolId" = ANY (app.same_huvudman_school_ids()))
     OR NOT (v_loan."borrowerSchoolId" = ANY (app.same_huvudman_school_ids())) THEN
    RAISE EXCEPTION 'ROOM_LOAN_NOT_FOUND' USING ERRCODE = 'RL404';
  END IF;
  PERFORM app.room_loan_lock(v_loan."roomId");
  SELECT * INTO v_loan FROM "RoomLoans" l WHERE l."id" = p_loan FOR UPDATE;
  RETURN v_loan;
END
$$;

CREATE FUNCTION app.room_loan_decide(p_loan uuid, p_approve boolean) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  v_user uuid := app.room_loan_planner();
  v_loan "RoomLoans" := app.room_loan_of(p_loan, true);
BEGIN
  IF p_approve IS NULL THEN
    RAISE EXCEPTION 'ROOM_LOAN_DECISION_MISSING' USING ERRCODE = 'RL400';
  END IF;
  IF v_loan."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'ROOM_LOAN_ALREADY_DECIDED' USING ERRCODE = 'RL409';
  END IF;
  -- An approval over another approved loan of the room: 23P01.
  UPDATE "RoomLoans"
     SET "status" = CASE WHEN p_approve THEN 'APPROVED'::"RoomLoanStatus" ELSE 'DECLINED'::"RoomLoanStatus" END,
         "decidedById" = v_user, "decidedAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
   WHERE "id" = p_loan;
END
$$;

COMMENT ON FUNCTION app.room_loan_decide(uuid, boolean) IS
  'Delade lokaler och lärare (20261217090000): the owner school''s planner approves or declines a pending loan of its room. RL403, RL404, RL409 (decided already), 23P01 (approved over another approved loan of the room).';

CREATE FUNCTION app.room_loan_withdraw(p_loan uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  v_user uuid := app.room_loan_planner();
  v_loan "RoomLoans" := app.room_loan_of(p_loan, false);
BEGIN
  IF v_loan."status" NOT IN ('PENDING', 'APPROVED') THEN
    RAISE EXCEPTION 'ROOM_LOAN_ALREADY_ENDED' USING ERRCODE = 'RL409';
  END IF;
  UPDATE "RoomLoans" SET "status" = 'WITHDRAWN', "endedAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
   WHERE "id" = p_loan;
END
$$;

COMMENT ON FUNCTION app.room_loan_withdraw(uuid) IS
  'Delade lokaler och lärare (20261217090000): the borrower school''s planner withdraws a pending or approved loan. RL403, RL404, RL409 (ended or declined already).';

CREATE FUNCTION app.room_loan_revoke(p_loan uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  v_user uuid := app.room_loan_planner();
  v_loan "RoomLoans" := app.room_loan_of(p_loan, true);
BEGIN
  IF v_loan."status" <> 'APPROVED' THEN
    RAISE EXCEPTION 'ROOM_LOAN_NOT_APPROVED' USING ERRCODE = 'RL409';
  END IF;
  UPDATE "RoomLoans" SET "status" = 'REVOKED', "endedAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
   WHERE "id" = p_loan;
END
$$;

COMMENT ON FUNCTION app.room_loan_revoke(uuid) IS
  'Delade lokaler och lärare (20261217090000): the owner school''s planner ends an approved loan of its room. RL403, RL404, RL409 (not approved).';

-- ---------------------------------------------------------------------------
-- Row-level security and grants. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "SchoolTravelTimes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RoomLoans" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
  r text;
  fn text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    -- Restid mellan skolorna: both schools' staff read the pair, and either
    -- school's planner writes it, signed with its own school, while the two
    -- have the same huvudman. UPDATE asks PLANERING in its WITH CHECK alone,
    -- so a refused update is an error, as on SiteTravelTimes.
    CREATE POLICY school_travel_times_staff_select ON "SchoolTravelTimes"
        FOR SELECT TO "app_authenticated"
        USING ((select app.current_school_id()) IN ("schoolAId", "schoolBId")
               AND "schoolAId" = ANY ((select app.same_huvudman_school_ids())::uuid[])
               AND "schoolBId" = ANY ((select app.same_huvudman_school_ids())::uuid[])
               AND (select app.current_user_role()) IN ('SCHOOL_ADMIN', 'TEACHER'));
    CREATE POLICY school_travel_times_admin_insert ON "SchoolTravelTimes"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("setBySchoolId" = (select app.current_school_id())
                    AND "schoolAId" = ANY ((select app.same_huvudman_school_ids())::uuid[])
                    AND "schoolBId" = ANY ((select app.same_huvudman_school_ids())::uuid[])
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('PLANERING', true)));
    CREATE POLICY school_travel_times_admin_update ON "SchoolTravelTimes"
        FOR UPDATE TO "app_authenticated"
        USING ((select app.current_school_id()) IN ("schoolAId", "schoolBId")
               AND "schoolAId" = ANY ((select app.same_huvudman_school_ids())::uuid[])
               AND "schoolBId" = ANY ((select app.same_huvudman_school_ids())::uuid[])
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
        WITH CHECK ("setBySchoolId" = (select app.current_school_id())
                    AND "schoolAId" = ANY ((select app.same_huvudman_school_ids())::uuid[])
                    AND "schoolBId" = ANY ((select app.same_huvudman_school_ids())::uuid[])
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('PLANERING', true)));
    CREATE POLICY school_travel_times_admin_delete ON "SchoolTravelTimes"
        FOR DELETE TO "app_authenticated"
        USING ((select app.current_school_id()) IN ("schoolAId", "schoolBId")
               AND "schoolAId" = ANY ((select app.same_huvudman_school_ids())::uuid[])
               AND "schoolBId" = ANY ((select app.same_huvudman_school_ids())::uuid[])
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
               AND (select app.current_user_may('PLANERING', true)));

    -- Salslån: both schools' staff read the loans between them; the four
    -- functions write them.
    CREATE POLICY room_loans_staff_select ON "RoomLoans"
        FOR SELECT TO "app_authenticated"
        USING ((select app.current_school_id()) IN ("ownerSchoolId", "borrowerSchoolId")
               AND "ownerSchoolId" = ANY ((select app.same_huvudman_school_ids())::uuid[])
               AND "borrowerSchoolId" = ANY ((select app.same_huvudman_school_ids())::uuid[])
               AND (select app.current_user_role()) IN ('SCHOOL_ADMIN', 'TEACHER'));

    REVOKE ALL ON "SchoolTravelTimes" FROM "app_authenticated";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "SchoolTravelTimes" TO "app_authenticated";
    REVOKE ALL ON "RoomLoans" FROM "app_authenticated";
    GRANT SELECT ON "RoomLoans" TO "app_authenticated";
  END IF;

  FOREACH t IN ARRAY ARRAY['SchoolTravelTimes', 'RoomLoans'] LOOP
    FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM "service_role"', t);
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

  -- The functions: nobody's but the gateway's. A policy's function is run as
  -- the querying role, which needs EXECUTE on same_huvudman_school_ids; the
  -- helpers the functions call run as the owner and need no grant.
  FOREACH fn IN ARRAY ARRAY[
    'app.same_huvudman_school_ids()',
    'app.sibling_schools()',
    'app.shared_teachers()',
    'app.shared_teacher_busy(date, date)',
    'app.lendable_rooms()',
    'app.room_loan_planner()',
    'app.room_loan_lock(uuid)',
    'app.room_loan_request(uuid, uuid, integer, time, time, date, date, text)',
    'app.room_loan_of(uuid, boolean)',
    'app.room_loan_decide(uuid, boolean)',
    'app.room_loan_withdraw(uuid)',
    'app.room_loan_revoke(uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated', 'supabase_auth_admin'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', fn, r);
      END IF;
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    FOREACH fn IN ARRAY ARRAY[
      'app.same_huvudman_school_ids()',
      'app.sibling_schools()',
      'app.shared_teachers()',
      'app.shared_teacher_busy(date, date)',
      'app.lendable_rooms()',
      'app.room_loan_request(uuid, uuid, integer, time, time, date, date, text)',
      'app.room_loan_decide(uuid, boolean)',
      'app.room_loan_withdraw(uuid)',
      'app.room_loan_revoke(uuid)'
    ] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO "app_authenticated"', fn);
    END LOOP;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- SHARING_REACH: the five arms above and no other; none for a PostgREST
-- role, the service or the sync principal; every arm keyed on the same
-- huvudman for both schools of the row.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  bad text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    RETURN;
  END IF;
  SELECT string_agg(p.tablename || '.' || p.policyname || ' ' || p.cmd || ' ' || p.roles::text, ', '
                    ORDER BY p.tablename, p.policyname) INTO bad
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename IN ('SchoolTravelTimes', 'RoomLoans')
     AND NOT (p.roles = '{app_authenticated}'::name[]
              AND (p.tablename, p.policyname, p.cmd) IN (
                    ('SchoolTravelTimes', 'school_travel_times_staff_select', 'SELECT'),
                    ('SchoolTravelTimes', 'school_travel_times_admin_insert', 'INSERT'),
                    ('SchoolTravelTimes', 'school_travel_times_admin_update', 'UPDATE'),
                    ('SchoolTravelTimes', 'school_travel_times_admin_delete', 'DELETE'),
                    ('RoomLoans', 'room_loans_staff_select', 'SELECT'))
              AND coalesce(p.qual, '') || coalesce(p.with_check, '') LIKE '%same_huvudman_school_ids()%'
              AND (p.cmd = 'SELECT' OR coalesce(p.with_check, p.qual) LIKE '%current_user_may(''PLANERING''%'));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'SHARING_REACH: these arms reach SchoolTravelTimes or RoomLoans beyond the staff read and the planner''s writes: %', bad;
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('SchoolTravelTimes', 'RoomLoans')) <> 5 THEN
    RAISE EXCEPTION 'SHARING_REACH: SchoolTravelTimes and RoomLoans have % arms, not the five above',
      (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('SchoolTravelTimes', 'RoomLoans'));
  END IF;
END
$$;
