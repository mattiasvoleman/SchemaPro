-- Ett uppdrag har datum och flera tider.
--
-- 20261007090000 made an uppdrag a row per läsår with at most one fixed weekly
-- time, held by one UNAVAILABLE TEACHER constraint the duty pointed at
-- (blockedConstraintId). Two things every school does do not fit that row:
--
--   * a mentor change at jul. Anna is mentor for 7B until the jullov and
--     Bertil from January. Today that is two whole-year uppdrag, so both
--     teachers carry 90 minutes a week all year, the load report is wrong for
--     both, and nothing can answer "who is 7B's mentor on 3 March" — the
--     question mentor approval of leave asks.
--   * a rastvakt on Monday, Wednesday and Friday. Today that is three
--     uppdrag with one time each, so the uppdragsbeskrivning lists the same
--     duty three times and the minutes are typed three times or split by
--     hand.
--
-- This migration gives an uppdrag dates and any number of fixed times. It is
-- EXPAND-ONLY: Railway runs the old and the new API side by side while a
-- deploy rolls, so the old column stays, keeps its triggers and stays true
-- for one release. A later migration drops it.
--
-- ## Från and Till: TeacherDuties.validFrom, validTo
--
-- DATE NULL, both inclusive, as TeachingRequirements' startDate/endDate are:
-- null means the year's own bound, so every existing uppdrag reads exactly
-- as it did — the whole läsår. CHECK validFrom <= validTo when both are set,
-- here because a CHECK sees one row. That the dates lie INSIDE the läsår is a
-- fact about another table, and it is enforced where the requirements' and
-- the lov's dates are: TeacherDutiesService reads the year's bounds FOR SHARE
-- in the duty's transaction, and AcademicYearsService.update counts the
-- uppdrag a new bound would strand (academic-year-bounds.ts says why both
-- ends and why FOR SHARE). A row PostgREST writes outside its year is
-- clamped by every reader to the year, as a requirement's is.
--
-- The dates are on the uppdrag, not on its times: "Mentor 7B from January"
-- is one fact, and every time the uppdrag holds runs on its dates.
--
-- An index on (schoolId, studentGroupId, kind) for the question the next
-- Skoldagen phase asks — which teacher holds MENTORSKAP for this class on
-- these dates — and for the class's ON DELETE SET NULL, which had to scan the
-- table for a referencing row.
--
-- ## Several times: TeacherDutySlots
--
-- One row per fixed time of an uppdrag: (teacherDutyId, availabilityConstraintId),
-- each constraint an ordinary weekly UNAVAILABLE TEACHER row of the duty's own
-- teacher, exactly the shape blockedConstraintId has held since 20261007090000.
-- The engine still receives one weekly row per time and learns nothing about
-- uppdrag; the year filter the readers apply (duty-slot-year.ts) reads the
-- link through this table now.
--
--   * A link row, nothing else. The time lives on the constraint and is read
--     back from it, as it always was, so the two can never disagree. The row
--     is never updated (a trigger refuses it, TD409): an uppdrag whose time
--     moves updates the constraint, one that gets another time gets another
--     row, and every guard below then only has INSERT and DELETE to watch.
--   * UNIQUE (availabilityConstraintId, schoolId): a constraint is one time of
--     one uppdrag.
--   * Composite keys, (x, schoolId) -> (id, schoolId), for the reason every
--     child table here has them. TeacherDuties gets the UNIQUE (id, schoolId)
--     the target needs. Both ON DELETE CASCADE: a duty deleted takes its
--     link rows, and a constraint an admin deletes takes its link (the old
--     column's SET NULL, for a row whose only content is the link).
--   * ON DELETE of a link row, a trigger deletes its constraint, as
--     TeacherDuties_take_their_block does for the old column: the rows leave
--     with a duty through the year's cascade, the person's and PostgREST as
--     well as through the service, and a time no uppdrag shows any more must
--     not keep blocking the teacher.
--
-- ## The guards, carried over to the link
--
-- 20261007090000's three rules hold for every link row, with the same
-- SQLSTATEs, so rethrowPrismaError and the drawer need nothing new:
--
--   * AFTER INSERT ON "TeacherDutySlots": the constraint found by
--     (availabilityConstraintId, schoolId) is TEACHER, UNAVAILABLE, weekly and
--     the duty's own teacher's (TD409). A pair that finds no duty or no
--     constraint is left to the composite keys, whose 23503 says nothing
--     about the other school. Both rows are read FOR SHARE, so a concurrent
--     move of either waits for this write or is seen by it.
--   * AFTER UPDATE OF "userId" ON "TeacherDuties": a duty moved to another
--     teacher (PostgREST can; the DTO cannot) must not take a colleague's
--     time with it, for any of its times (TD409).
--   * app.availability_constraints_keep_duty_blocks, the BEFORE UPDATE OR
--     DELETE guard on AvailabilityConstraints, now finds the linking duty
--     through either link: a teacher may not change or delete a time an
--     uppdrag holds (TD403), and an admin's change keeps the shape (TD409).
--
-- ## The old column, for one release
--
-- blockedConstraintId keeps its foreign key, its UNIQUE and its three
-- triggers, and is backfilled into a link row here, so each existing time is
-- a TeacherDutySlots row from this migration on. The new API reads and writes
-- the link table only. The OLD API, still answering for a minute or two while
-- Railway swaps them, writes the column; so does an admin's own PostgREST
-- key. One more trigger makes every such write a link row as well:
--
--   * AFTER INSERT OR UPDATE OF "blockedConstraintId" ON "TeacherDuties", a
--     non-null value gets its link row in the same statement. A constraint
--     another uppdrag already holds through the link table is refused (TD409)
--     rather than silently left with two owners; one this uppdrag already
--     holds is no change.
--
-- So "which constraints are uppdrag times, and whose" has one answer for the
-- new readers — the link table — whichever API version or door wrote it.
-- What the new API writes is invisible to an old reader during the swap: it
-- sees an uppdrag created by the new API without its time, and that time as
-- an ordinary unavailability for every year, until the old API stops. That
-- over-blocks for a minute and never under-blocks.
--
-- ## The history: the times are a version
--
-- TeacherEmploymentLogs (20261010090000) logs the duty row as to_jsonb, so
-- validFrom and validTo are in every version from now on without a change.
-- blockedConstraintId was in it too, and the Historik card read it as
-- "Blockerad tid". The times now live in another table, so:
--
--   * blockedConstraintId leaves the logged JSON (app.teacher_staffing_log
--     strips it beside schoolId, createdAt and updatedAt). Its value is a
--     constraint id, which says nothing a reader can use, and kept it would
--     make every time an admin removes from an existing uppdrag TWO versions:
--     the old column's SET NULL and the link's own. Versions written before
--     this migration keep it, and the card still reads them.
--   * A statement that adds or removes link rows writes ONE version per
--     uppdrag it touched, an UPDATE of the duty whose before and after say
--     how many fixed times it had: {"slotCount": 1} -> {"slotCount": 3}. Per
--     statement, through transition tables, so a rastvakt created with three
--     times is the duty's CREATE and one "0 -> 3", not three versions; per
--     uppdrag, because a version is about one row. The count rather than the
--     clock: a link removed because its constraint was deleted has no clock
--     left to read. A time moved on its constraint is no version, as it was
--     not before. The write goes through app.teacher_staffing_log_write, so
--     the existence rule and the advisory lock are the same; an uppdrag
--     deleted in the same statement (its links cascading) is skipped, since
--     its DELETE version says it all.
--
-- ## Row-level security
--
-- TeacherDuties' arms, read through the duty: the admin FOR ALL, a TEACHER
-- the links of their OWN uppdrag (through an EXISTS on TeacherDuties, which
-- that teacher's own arm narrows), nobody else. A link reveals nothing a
-- colleague cannot read already — the constraint is staff-readable and holds
-- only the word "Uppdrag" — but which of a colleague's times is an uppdrag is
-- exactly what teacher_duties_teacher_own_select keeps from them. No service
-- principal arm: no integration reads the times.
--
-- New tables start closed since 20261016090000-130000 (anon nothing,
-- service_role SELECT, authenticated no TRUNCATE, REFERENCES, TRIGGER or
-- MAINTAIN). UPDATE is taken from authenticated here as well, since the row
-- is never updated; the API role gets SELECT, INSERT and DELETE, guarded as
-- 20260930120000 explains.
--
-- Every trigger function is SECURITY DEFINER, owned by the migration owner,
-- in "app" with a pinned search_path and EXECUTE taken from PUBLIC, for
-- 20261007090000's reasons. Messages name no person and no label.

-- ---------------------------------------------------------------------------
-- TeacherDuties: Från and Till, the composite target, the mentor index
-- ---------------------------------------------------------------------------

ALTER TABLE "TeacherDuties" ADD COLUMN "validFrom" DATE;
ALTER TABLE "TeacherDuties" ADD COLUMN "validTo" DATE;

ALTER TABLE "TeacherDuties"
    ADD CONSTRAINT "TeacherDuties_dates_are_ordered"
    CHECK ("validFrom" IS NULL OR "validTo" IS NULL OR "validFrom" <= "validTo");

CREATE UNIQUE INDEX "TeacherDuties_id_schoolId_key"
    ON "TeacherDuties"("id", "schoolId");

CREATE INDEX "TeacherDuties_schoolId_studentGroupId_kind_idx"
    ON "TeacherDuties"("schoolId", "studentGroupId", "kind");

-- ---------------------------------------------------------------------------
-- TeacherDutySlots
-- ---------------------------------------------------------------------------

CREATE TABLE "TeacherDutySlots" (
    "id"                       UUID           NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"                 UUID           NOT NULL,
    "teacherDutyId"            UUID           NOT NULL,
    "availabilityConstraintId" UUID           NOT NULL,
    "createdAt"                TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "TeacherDutySlots_pkey" PRIMARY KEY ("id")
);

-- The duty's list of times, and its cascade.
CREATE INDEX "TeacherDutySlots_teacherDutyId_schoolId_idx"
    ON "TeacherDutySlots"("teacherDutyId", "schoolId");
-- One uppdrag per constraint; also the guard's and the cascade's lookup.
CREATE UNIQUE INDEX "TeacherDutySlots_availabilityConstraintId_schoolId_key"
    ON "TeacherDutySlots"("availabilityConstraintId", "schoolId");

ALTER TABLE "TeacherDutySlots"
    ADD CONSTRAINT "TeacherDutySlots_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "TeacherDutySlots"
    ADD CONSTRAINT "TeacherDutySlots_teacherDutyId_schoolId_fkey"
    FOREIGN KEY ("teacherDutyId", "schoolId") REFERENCES "TeacherDuties"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "TeacherDutySlots"
    ADD CONSTRAINT "TeacherDutySlots_availabilityConstraintId_schoolId_fkey"
    FOREIGN KEY ("availabilityConstraintId", "schoolId") REFERENCES "AvailabilityConstraints"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE NO ACTION;

-- Every existing time, before any trigger below exists: these rows passed the
-- old guard when they were written, and backfilling them is no version.
INSERT INTO "TeacherDutySlots" ("schoolId", "teacherDutyId", "availabilityConstraintId", "createdAt")
SELECT d."schoolId", d."id", d."blockedConstraintId", d."updatedAt"
  FROM "TeacherDuties" d
 WHERE d."blockedConstraintId" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The guards. See the preamble.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.teacher_duty_slots_are_the_teachers() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  duty record;
  blocked record;
BEGIN
  -- By the pairs the composite keys match on: a row naming another school's
  -- duty or constraint finds nothing here and is the foreign key's to refuse.
  SELECT d."userId" INTO duty
    FROM "TeacherDuties" d
   WHERE d."id" = NEW."teacherDutyId" AND d."schoolId" = NEW."schoolId"
     FOR SHARE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT c."resourceType", c."type", c."userId", c."dayOfWeek", c."date"
    INTO blocked
    FROM "AvailabilityConstraints" c
   WHERE c."id" = NEW."availabilityConstraintId" AND c."schoolId" = NEW."schoolId"
     FOR SHARE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF blocked."resourceType" <> 'TEACHER'
     OR blocked."type" <> 'UNAVAILABLE'
     OR blocked."userId" IS DISTINCT FROM duty."userId"
     OR blocked."dayOfWeek" IS NULL
     OR blocked."date" IS NOT NULL THEN
    RAISE EXCEPTION 'TEACHER_DUTY_BLOCK_MISMATCH: ett uppdrags blockerade tid är en återkommande otillgänglighet för uppdragets egen lärare'
      USING ERRCODE = 'TD409',
            DETAIL  = format('teacherDutyId=%s availabilityConstraintId=%s', NEW."teacherDutyId", NEW."availabilityConstraintId");
  END IF;
  -- An AFTER trigger's return value is ignored.
  RETURN NULL;
END
$$;

CREATE FUNCTION app.teacher_duty_slots_are_links() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  RAISE EXCEPTION 'TEACHER_DUTY_SLOT_IS_A_LINK: en tid flyttas på sin otillgänglighet, och ett uppdrag får en ny tid som en ny rad'
    USING ERRCODE = 'TD409',
          DETAIL  = format('teacherDutySlotId=%s', OLD."id");
END
$$;

CREATE FUNCTION app.teacher_duties_slots_stay_the_teachers() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  stray uuid;
BEGIN
  SELECT c."id" INTO stray
    FROM "TeacherDutySlots" s
    JOIN "AvailabilityConstraints" c
      ON c."id" = s."availabilityConstraintId" AND c."schoolId" = s."schoolId"
   WHERE s."teacherDutyId" = NEW."id" AND s."schoolId" = NEW."schoolId"
     AND c."userId" IS DISTINCT FROM NEW."userId"
   LIMIT 1
     FOR SHARE OF c;
  IF FOUND THEN
    RAISE EXCEPTION 'TEACHER_DUTY_BLOCK_MISMATCH: ett uppdrags blockerade tid är en återkommande otillgänglighet för uppdragets egen lärare'
      USING ERRCODE = 'TD409',
            DETAIL  = format('teacherDutyId=%s availabilityConstraintId=%s', NEW."id", stray);
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION app.teacher_duty_slots_take_their_block() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  -- When the constraint's own delete is what removed this row (its cascade),
  -- the constraint is already gone and this finds nothing, which is no error.
  DELETE FROM "AvailabilityConstraints"
   WHERE "id" = OLD."availabilityConstraintId" AND "schoolId" = OLD."schoolId";
  RETURN NULL;
END
$$;

-- The old column's writes become link rows. See the preamble.
CREATE FUNCTION app.teacher_duties_old_block_is_a_slot() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  holder uuid;
BEGIN
  SELECT s."teacherDutyId" INTO holder
    FROM "TeacherDutySlots" s
   WHERE s."availabilityConstraintId" = NEW."blockedConstraintId" AND s."schoolId" = NEW."schoolId";
  IF FOUND THEN
    IF holder <> NEW."id" THEN
      RAISE EXCEPTION 'TEACHER_DUTY_BLOCK_MISMATCH: tiden hör redan till ett annat uppdrag'
        USING ERRCODE = 'TD409',
              DETAIL  = format('teacherDutyId=%s availabilityConstraintId=%s', NEW."id", NEW."blockedConstraintId");
    END IF;
    RETURN NULL;
  END IF;
  -- Another school's constraint: the old column's own key refuses it.
  IF NOT EXISTS (
       SELECT 1 FROM "AvailabilityConstraints" c
        WHERE c."id" = NEW."blockedConstraintId" AND c."schoolId" = NEW."schoolId"
     ) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "TeacherDutySlots" ("schoolId", "teacherDutyId", "availabilityConstraintId")
  VALUES (NEW."schoolId", NEW."id", NEW."blockedConstraintId");
  RETURN NULL;
END
$$;

-- The constraint's guard, finding the duty through either link.
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
    SELECT d."id", d."userId"
      INTO duty
      FROM "TeacherDuties" d
     WHERE d."blockedConstraintId" = OLD."id" AND d."schoolId" = OLD."schoolId";
  END IF;
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
    -- An admin's delete; the link row cascades and the old column's
    -- ON DELETE SET NULL ("blockedConstraintId") clears that pointer.
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
-- The history. See the preamble.
-- ---------------------------------------------------------------------------

-- blockedConstraintId leaves the logged JSON; the rest is 20261010090000's
-- function unchanged.
CREATE OR REPLACE FUNCTION app.teacher_staffing_log() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  entity "TeacherLogEntity" :=
    CASE TG_TABLE_NAME WHEN 'TeacherEmployments' THEN 'EMPLOYMENT'::"TeacherLogEntity"
                       ELSE 'DUTY'::"TeacherLogEntity" END;
  -- blockedConstraintId (20261017090000): an uppdrag's times are versions of
  -- their own, counted from TeacherDutySlots.
  stripped text[] := ARRAY['schoolId', 'createdAt', 'updatedAt', 'blockedConstraintId'];
  -- The note's text never enters the log; "noteChanged" says it was written.
  note_written constant jsonb := '{"noteChanged": true}'::jsonb;
  old_row jsonb;
  new_row jsonb;
  actor uuid := app.current_user_id();
BEGIN
  IF TG_OP = 'INSERT' THEN
    new_row := to_jsonb(NEW) - stripped - 'note';
    IF COALESCE(NEW."note", '') <> '' THEN
      new_row := new_row || note_written;
    END IF;
    PERFORM app.teacher_staffing_log_write(NEW."schoolId", NEW."userId", NEW."academicYearId",
                                           entity, NEW."id", 'CREATE', NULL, new_row, actor);
    RETURN NULL;
  END IF;

  IF TG_OP = 'DELETE' THEN
    old_row := to_jsonb(OLD) - stripped - 'note';
    PERFORM app.teacher_staffing_log_write(OLD."schoolId", OLD."userId", OLD."academicYearId",
                                           entity, OLD."id", 'DELETE', old_row, NULL, actor);
    RETURN NULL;
  END IF;

  IF (to_jsonb(OLD) - stripped) = (to_jsonb(NEW) - stripped) AND OLD."schoolId" = NEW."schoolId" THEN
    -- A save that changed nothing, the note included, is no version.
    RETURN NULL;
  END IF;
  old_row := to_jsonb(OLD) - stripped - 'note';
  new_row := to_jsonb(NEW) - stripped - 'note';

  IF OLD."userId" IS DISTINCT FROM NEW."userId"
     OR OLD."academicYearId" IS DISTINCT FROM NEW."academicYearId"
     OR OLD."schoolId" IS DISTINCT FROM NEW."schoolId"
     OR OLD."id" IS DISTINCT FROM NEW."id" THEN
    -- Moved to another owner: each owner gets their own half, so no teacher's
    -- arm ever shows them a colleague's `before`.
    PERFORM app.teacher_staffing_log_write(OLD."schoolId", OLD."userId", OLD."academicYearId",
                                           entity, OLD."id", 'DELETE', old_row, NULL, actor);
    IF COALESCE(NEW."note", '') <> '' THEN
      new_row := new_row || note_written;
    END IF;
    PERFORM app.teacher_staffing_log_write(NEW."schoolId", NEW."userId", NEW."academicYearId",
                                           entity, NEW."id", 'CREATE', NULL, new_row, actor);
    RETURN NULL;
  END IF;

  IF OLD."note" IS DISTINCT FROM NEW."note" THEN
    new_row := new_row || note_written;
  END IF;
  PERFORM app.teacher_staffing_log_write(NEW."schoolId", NEW."userId", NEW."academicYearId",
                                         entity, NEW."id", 'UPDATE', old_row, new_row, actor);
  -- An AFTER trigger's return value is ignored.
  RETURN NULL;
END
$$;

-- One version per uppdrag a statement added links to or removed them from.
-- `changes` is (teacherDutyId, schoolId, delta); the count after is read from
-- the table, the count before is that minus what the statement did.
CREATE FUNCTION app.teacher_duty_slots_log_write(changes jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  change record;
  duty record;
  now_count integer;
  actor uuid := app.current_user_id();
BEGIN
  FOR change IN
    SELECT (x->>'teacherDutyId')::uuid AS duty_id,
           (x->>'schoolId')::uuid AS school_id,
           sum((x->>'delta')::integer)::integer AS delta
      FROM jsonb_array_elements(changes) AS x
     GROUP BY 1, 2
     ORDER BY 1
  LOOP
    SELECT d."userId", d."academicYearId" INTO duty
      FROM "TeacherDuties" d
     WHERE d."id" = change.duty_id AND d."schoolId" = change.school_id;
    -- Deleted in this statement (its links cascading): its DELETE says it.
    CONTINUE WHEN NOT FOUND OR change.delta = 0;
    SELECT count(*) INTO now_count
      FROM "TeacherDutySlots" s
     WHERE s."teacherDutyId" = change.duty_id AND s."schoolId" = change.school_id;
    PERFORM app.teacher_staffing_log_write(
      change.school_id, duty."userId", duty."academicYearId",
      'DUTY', change.duty_id, 'UPDATE',
      jsonb_build_object('slotCount', now_count - change.delta),
      jsonb_build_object('slotCount', now_count),
      actor);
  END LOOP;
END
$$;

CREATE FUNCTION app.teacher_duty_slots_log_added() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  PERFORM app.teacher_duty_slots_log_write(
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('teacherDutyId', a."teacherDutyId", 'schoolId', a."schoolId", 'delta', 1)), '[]'::jsonb)
       FROM added a));
  RETURN NULL;
END
$$;

CREATE FUNCTION app.teacher_duty_slots_log_removed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  PERFORM app.teacher_duty_slots_log_write(
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('teacherDutyId', r."teacherDutyId", 'schoolId', r."schoolId", 'delta', -1)), '[]'::jsonb)
       FROM removed r));
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION app.teacher_duty_slots_are_the_teachers() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.teacher_duty_slots_are_links() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.teacher_duties_slots_stay_the_teachers() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.teacher_duty_slots_take_their_block() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.teacher_duties_old_block_is_a_slot() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.teacher_duty_slots_log_write(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.teacher_duty_slots_log_added() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.teacher_duty_slots_log_removed() FROM PUBLIC;

CREATE TRIGGER "TeacherDutySlots_are_the_teachers"
    AFTER INSERT ON "TeacherDutySlots"
    FOR EACH ROW EXECUTE FUNCTION app.teacher_duty_slots_are_the_teachers();

CREATE TRIGGER "TeacherDutySlots_are_links"
    BEFORE UPDATE ON "TeacherDutySlots"
    FOR EACH ROW EXECUTE FUNCTION app.teacher_duty_slots_are_links();

CREATE TRIGGER "TeacherDutySlots_take_their_block"
    AFTER DELETE ON "TeacherDutySlots"
    FOR EACH ROW EXECUTE FUNCTION app.teacher_duty_slots_take_their_block();

CREATE TRIGGER "TeacherDutySlots_log_added"
    AFTER INSERT ON "TeacherDutySlots"
    REFERENCING NEW TABLE AS added
    FOR EACH STATEMENT EXECUTE FUNCTION app.teacher_duty_slots_log_added();

CREATE TRIGGER "TeacherDutySlots_log_removed"
    AFTER DELETE ON "TeacherDutySlots"
    REFERENCING OLD TABLE AS removed
    FOR EACH STATEMENT EXECUTE FUNCTION app.teacher_duty_slots_log_removed();

CREATE TRIGGER "TeacherDuties_slots_stay_the_teachers"
    AFTER UPDATE OF "userId" ON "TeacherDuties"
    FOR EACH ROW EXECUTE FUNCTION app.teacher_duties_slots_stay_the_teachers();

CREATE TRIGGER "TeacherDuties_old_block_is_a_slot"
    AFTER INSERT OR UPDATE OF "blockedConstraintId" ON "TeacherDuties"
    FOR EACH ROW
    WHEN (NEW."blockedConstraintId" IS NOT NULL)
    EXECUTE FUNCTION app.teacher_duties_old_block_is_a_slot();

-- ---------------------------------------------------------------------------
-- Row-level security. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "TeacherDutySlots" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "teacher_duty_slots_admin_all" ON "TeacherDutySlots"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

-- The links of their own uppdrag, read only, through the duty: the EXISTS
-- runs under the caller's own arms on TeacherDuties, which hand a teacher
-- their own rows and no colleague's.
CREATE POLICY "teacher_duty_slots_teacher_own_select" ON "TeacherDutySlots"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) = 'TEACHER'
        AND EXISTS (
            SELECT 1 FROM "TeacherDuties" d
             WHERE d."id" = "TeacherDutySlots"."teacherDutyId"
               AND d."schoolId" = "TeacherDutySlots"."schoolId"
               AND d."userId" = (select app.current_user_id())
        )
    );

-- Never updated (TeacherDutySlots_are_links): the write grants are INSERT and
-- DELETE. Guarded, as 20260930120000 explains.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE UPDATE ON "TeacherDutySlots" FROM "authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT SELECT, INSERT, DELETE ON "TeacherDutySlots" TO "app_authenticated";
    REVOKE UPDATE ON "TeacherDutySlots" FROM "app_authenticated";
  END IF;
END
$$;
