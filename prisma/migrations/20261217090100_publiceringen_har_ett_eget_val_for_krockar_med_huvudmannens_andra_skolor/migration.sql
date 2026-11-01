-- Publiceringen har ett eget val för krockar med huvudmannens andra skolor.
--
-- Roadmap: Kommun lane, phase "Delade lokaler och lärare", second half (the
-- generator and the publish). The publish check PUB_OTHER_SCHOOL names the
-- lessons that meet another school of the huvudman: a shared teacher's
-- lesson there with the walk between the schools, a room lent to it in an
-- approved window, or the school's own room for a borrowed one outside every
-- approved window (src/publication/other-school-finding.ts).
--
-- Every check follows one policy column (src/publication/publication-gates.ts
-- GATE_COLUMN, one to one, held by its spec), and the school decides each:
-- a school may stop a publish on its own clashes and only be warned about
-- another school's timetable, which it cannot change itself, or the other way
-- round. So the check has a column of its own, WARN like every other until
-- the school chooses: a school that never opens the settings is refused
-- nothing it can publish today.
--
--   PublicationSettings."gateOtherSchool"  "PublishGateMode" NOT NULL DEFAULT 'WARN'
--
-- A constant default: PostgreSQL adds the column without rewriting the
-- table. No new policy and no GRANT: the arms and the grants are the
-- table's, row by row, as for every gate column before it (20261113090000's
-- gateEmptyHalf).
--
-- ## Beside the live API
--
-- ADD COLUMN takes ACCESS EXCLUSIVE on "PublicationSettings", one row per
-- school, written when a school saves its settings and read by every
-- publish. Taken NOWAIT in a loop: a refusal tries again 50 ms later, so the
-- migration never waits while it holds the lock and no publish queues behind
-- it; after 30 s it stops with nothing changed. lock_timeout bounds any wait
-- nobody foresaw. The API before this release reads the row by name of the
-- columns it knows and is unchanged.
--
-- ## An approval holds by the room a sibling loan holds by
--
-- app.room_loan_decide (20261217090000) is replaced, signature, attributes
-- and grants unchanged (CREATE OR REPLACE keeps the owner, the EXECUTE and
-- the comment's place). A borrower may ask for a room without a room of its
-- own and then ask for it again naming one (the API takes localRoomId). The
-- first request's approval then made a second room for the same room, and
-- RoomLoans_one_local_room_per_room refused it among the live loans
-- (23P01): the request could not be approved at all. The approval now holds
-- by the room another live loan of the room already holds by, and makes one
-- only when none has; either way every request of the room still waiting
-- without one is given it, as before. No table is locked: the function takes
-- the room's advisory lock, as every act on a loan does.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "PublicationSettings" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'PublicationSettings was not free in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

ALTER TABLE "PublicationSettings"
    ADD COLUMN "gateOtherSchool" "PublishGateMode" NOT NULL DEFAULT 'WARN';

COMMENT ON COLUMN "PublicationSettings"."gateOtherSchool" IS
  'Delade lokaler och lärare (20261217090100): whether PUB_OTHER_SCHOOL, a lesson that meets another school of the huvudman (a shared teacher, a lent or a borrowed room), warns or stops a publish. WARN until the school chooses.';

CREATE OR REPLACE FUNCTION app.room_loan_decide(p_loan uuid, p_approve boolean) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  v_user  uuid := app.room_loan_planner();
  v_loan  "RoomLoans" := app.room_loan_of(p_loan, true);
  v_local uuid := v_loan."localRoomId";
BEGIN
  IF p_approve IS NULL THEN
    RAISE EXCEPTION 'ROOM_LOAN_DECISION_MISSING' USING ERRCODE = 'RL400';
  END IF;
  IF v_loan."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'ROOM_LOAN_ALREADY_DECIDED' USING ERRCODE = 'RL409';
  END IF;
  -- The borrower's room: the loan's own, the one another live loan of the
  -- room holds by, or one made now; every request of the room still waiting
  -- without one is given it too. A declined request makes none.
  IF p_approve AND v_local IS NULL THEN
    SELECT l."localRoomId" INTO v_local FROM "RoomLoans" l
     WHERE l."borrowerSchoolId" = v_loan."borrowerSchoolId" AND l."roomId" = v_loan."roomId"
       AND l."localRoomId" IS NOT NULL AND l."status" IN ('PENDING', 'APPROVED')
     LIMIT 1;
    IF v_local IS NULL THEN
      v_local := app.room_loan_local_room(v_loan);
    END IF;
    UPDATE "RoomLoans"
       SET "localRoomId" = v_local, "updatedAt" = clock_timestamp()
     WHERE "borrowerSchoolId" = v_loan."borrowerSchoolId" AND "roomId" = v_loan."roomId"
       AND "status" = 'PENDING' AND "localRoomId" IS NULL AND "id" <> p_loan;
  END IF;
  -- An approval over another approved loan of the room: 23P01, and the room
  -- made above goes with the transaction.
  UPDATE "RoomLoans"
     SET "status" = CASE WHEN p_approve THEN 'APPROVED'::"RoomLoanStatus" ELSE 'DECLINED'::"RoomLoanStatus" END,
         "localRoomId" = v_local,
         "decidedById" = v_user, "decidedAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
   WHERE "id" = p_loan;
END
$$;

COMMENT ON FUNCTION app.room_loan_decide(uuid, boolean) IS
  'Delade lokaler och lärare (20261217090000, 20261217090100): the owner school''s planner approves or declines a pending loan of its room; an approval of a loan with no room of the borrower''s holds by the room another live loan of the room holds by, or makes one, and gives it to the borrower''s other waiting requests of the room. RL403, RL404, RL409 (decided already), 23P01 (approved over another approved loan of the room).';
