-- Ett uppdrags tider är bara länkar.
--
-- 20261017090000 moved an uppdrag's fixed times from the one-time column
-- TeacherDuties.blockedConstraintId to the link table TeacherDutySlots, and was
-- EXPAND-ONLY: the column kept its foreign key, its UNIQUE and its three
-- triggers, and a fourth trigger turned every write of it into a link row, so
-- that the API release before it could keep writing it while Railway swapped
-- the two. That release has not run since 2026-10-12. This is the CONTRACT
-- step, in two halves across two releases:
--
--   * HERE: everything that gives the column a meaning goes. Its triggers and
--     their functions, its foreign key and its UNIQUE, and the guard's
--     fallback that found a duty through it. The column is cleared and held
--     empty by a CHECK.
--   * A LATER MIGRATION drops the column itself, once no running API names it.
--
-- WHY NOT DROP THE COLUMN NOW. The API release this migration is deployed
-- under (it runs before the merge, so for a few minutes the previous release
-- answers on top of it) generated its Prisma client from a schema with the
-- column, and Prisma names every scalar column of a model in its SELECT and
-- RETURNING lists: `findMany` on TeacherDuty selects "blockedConstraintId" by
-- name (measured on that client). With the column gone, every uppdrag read and
-- write of the previous release would fail until it stopped. With the column
-- kept, cleared and CHECKed, the previous release reads null, as it does for
-- every uppdrag it did not write before 20261017090000, and its one write of
-- the column — the rollover's `blockedConstraintId: null` — passes the CHECK.
-- The release that ships with this migration does not name the column, so the
-- later drop is safe once that release is the one running.
--
-- WHY NOTHING IS LOST. Every value the column holds is a link row already:
-- 20261017090000 backfilled each one, and the trigger dropped here made each
-- later write a link in the same statement. The first statement below asserts
-- it rather than assuming it, and refuses to go on if a value has no link —
-- a time no reader would show any more, which is for a person to look at,
-- not for a migration to guess about.
--
-- WHAT THE DROPPED TRIGGERS DID, AND WHO DOES IT NOW:
--
--   * TeacherDuties_block_is_the_teachers (20261007090000): the column's
--     constraint is a weekly UNAVAILABLE TEACHER row of the duty's teacher,
--     also when the duty moves to another teacher. Now
--     TeacherDutySlots_are_the_teachers on the link's INSERT and
--     TeacherDuties_slots_stay_the_teachers on the duty's UPDATE OF "userId",
--     with the same SQLSTATE (TD409).
--   * TeacherDuties_take_their_block (20261007090000): a deleted duty takes
--     its time. Now the link's ON DELETE CASCADE and
--     TeacherDutySlots_take_their_block.
--   * TeacherDuties_old_block_is_a_slot (20261017090000): a write of the
--     column becomes a link. Nothing replaces it: the CHECK refuses the write
--     (23514), which is what a PostgREST writer of the column now meets.
--   * app.availability_constraints_keep_duty_blocks keeps its trigger and
--     loses its second lookup: the linking duty is found through
--     TeacherDutySlots alone.
--
-- THE HISTORY is unchanged. app.teacher_staffing_log strips the key
-- 'blockedConstraintId' from the logged row since 20261017090000; versions
-- written before that keep it, and the Historik card still reads them. The
-- UPDATE below that clears the column changes nothing else in any row, so the
-- log trigger sees an unchanged row and writes no version.

-- ---------------------------------------------------------------------------
-- Every value of the column is a link already.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  unlinked integer;
BEGIN
  SELECT count(*) INTO unlinked
    FROM "TeacherDuties" d
   WHERE d."blockedConstraintId" IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM "TeacherDutySlots" s
        WHERE s."teacherDutyId" = d."id"
          AND s."schoolId" = d."schoolId"
          AND s."availabilityConstraintId" = d."blockedConstraintId"
     );
  IF unlinked > 0 THEN
    RAISE EXCEPTION 'TEACHER_DUTY_OLD_BLOCK_UNLINKED: % uppdrag name a time in blockedConstraintId that no TeacherDutySlots row holds', unlinked;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- The column's triggers and their functions.
-- ---------------------------------------------------------------------------

DROP TRIGGER "TeacherDuties_old_block_is_a_slot" ON "TeacherDuties";
DROP TRIGGER "TeacherDuties_block_is_the_teachers" ON "TeacherDuties";
DROP TRIGGER "TeacherDuties_take_their_block" ON "TeacherDuties";

DROP FUNCTION app.teacher_duties_old_block_is_a_slot();
DROP FUNCTION app.teacher_duties_block_is_the_teachers();
DROP FUNCTION app.teacher_duties_take_their_block();

-- The constraint's guard, finding the duty through the link alone; otherwise
-- 20261017090000's function unchanged.
CREATE OR REPLACE FUNCTION app.availability_constraints_keep_duty_blocks() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  duty record;
BEGIN
  SELECT d."id", d."userId"
    INTO duty
    FROM "TeacherDutySlots" s
    JOIN "TeacherDuties" d ON d."id" = s."teacherDutyId" AND d."schoolId" = s."schoolId"
   WHERE s."availabilityConstraintId" = OLD."id" AND s."schoolId" = OLD."schoolId";
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  -- The slot is the duty's, and the duty is the admin's.
  IF (select app.current_user_role()) = 'TEACHER' THEN
    RAISE EXCEPTION 'TEACHER_DUTY_BLOCK_IS_THE_ADMINS: tiden är blockerad av ett uppdrag och ändras genom uppdraget'
      USING ERRCODE = 'TD403',
            DETAIL  = format('teacherDutyId=%s availabilityConstraintId=%s', duty."id", OLD."id");
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- An admin's delete; the link row cascades.
    RETURN OLD;
  END IF;

  IF NEW."resourceType" <> 'TEACHER'
     OR NEW."type" <> 'UNAVAILABLE'
     OR NEW."userId" IS DISTINCT FROM duty."userId"
     OR NEW."dayOfWeek" IS NULL
     OR NEW."date" IS NOT NULL THEN
    RAISE EXCEPTION 'TEACHER_DUTY_BLOCK_MISMATCH: tiden är blockerad av ett uppdrag och förblir en återkommande otillgänglighet för uppdragets lärare'
      USING ERRCODE = 'TD409',
            DETAIL  = format('teacherDutyId=%s availabilityConstraintId=%s', duty."id", OLD."id");
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------
-- The column's keys.
-- ---------------------------------------------------------------------------

ALTER TABLE "TeacherDuties" DROP CONSTRAINT "TeacherDuties_blockedConstraintId_schoolId_fkey";
DROP INDEX "TeacherDuties_blockedConstraintId_schoolId_key";

-- ---------------------------------------------------------------------------
-- The column, cleared and held empty until a later migration drops it.
-- ---------------------------------------------------------------------------

UPDATE "TeacherDuties" SET "blockedConstraintId" = NULL WHERE "blockedConstraintId" IS NOT NULL;

ALTER TABLE "TeacherDuties"
    ADD CONSTRAINT "TeacherDuties_blockedConstraintId_is_retired"
    CHECK ("blockedConstraintId" IS NULL);
