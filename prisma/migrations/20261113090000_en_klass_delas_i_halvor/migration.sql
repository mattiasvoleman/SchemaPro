-- En klass delas i halvor.
--
-- Slöjd, NO-laborationer and hemkunskap are taught to half a class at a time:
-- 7A:1 has trä- och metallslöjd while 7A:2 has NO in the lab next door, and
-- the halves swap the lesson after. The halves are planned in the spring,
-- before anyone has decided which pupil goes in which half, and the generator
-- must place their lessons all the same. Today a half can only be a teaching
-- group with no members, and a group with no members shares no pupil with
-- anything: the gateway derives the engine's groupConflicts from shared
-- pupils alone, so 7A's own lessons, its språkval and both halves' lessons
-- could all land on the same hour.
--
-- This migration is the data of Halvklasser:
--   * StudentGroups."halfOfId": a half is a TEACHING_GROUP that names its
--     CLASS, in the class's year and school. It is set when the half is made
--     ("Dela klassen") and never changes; deleting the class deletes its halves.
--   * StudentGroupMembers."halfOfId": the class of the half a membership is
--     in, copied from the group by a trigger, so a unique index can hold a
--     pupil to one half per class.
--   * A pupil placed in a half is a pupil of its class: a trigger refuses a
--     membership in a half of another class, and a pupil who changes class
--     within the läsår leaves the old class's halves.
--   * PublicationSettings."gateEmptyHalf": the publish check of a half with
--     lessons and no pupils (PUB_EMPTY_HALF), WARN by default like every gate.
--
-- What a half MEANS to the schedule is the gateway's, not the database's: a
-- half's lessons keep its class and every group sharing the class's pupils
-- off the hour, except the other half (src/common/class-halves.ts). Nothing
-- here reaches the engine, whose contract does not change.
--
-- ## StudentGroups."halfOfId"
--
--   * UUID NULL, FK ("halfOfId", "schoolId") -> StudentGroups ("id",
--     "schoolId"). Composite, for the reason every tenant reference here is
--     (20260822130000): the referential check runs as the referenced table's
--     owner with row security off, so a plain id key would accept another
--     school's class under a row stamped with this school's id.
--   * ON DELETE CASCADE: a half is part of its class. Deleting 7A deletes 7A:1
--     and 7A:2, their timplansposter and lessons, as it deletes 7A's own.
--     ON UPDATE NO ACTION: ids are never rewritten.
--   * CHECK "halfOfId" <> "id".
--   * An index on ("halfOfId", "schoolId") for the cascade's scan and for
--     "the halves of this class".
--
-- ## The trigger that keeps a half a half
--
-- app.student_groups_half_is_of_a_class, AFTER INSERT OR UPDATE OF
-- "halfOfId", "kind", "academicYearId" ON "StudentGroups", raising SQLSTATE
-- 'HC409' — a class PostgreSQL does not define and nothing else raises — with
-- a MESSAGE that starts with a reason token and names nothing:
--
--   HALF_OF_NOT_A_CLASS        the group a half names is not a CLASS
--   HALF_NOT_A_TEACHING_GROUP  a half is not a TEACHING_GROUP
--   HALF_IN_OTHER_YEAR         a half and its class are in different läsår
--   HALF_LINK_IS_FIXED         a half's class was set or changed after the INSERT
--   CLASS_HAS_HALVES           a class with halves changed kind or läsår
--
-- rethrowPrismaError maps each to the 409 of the same name. A half's class is
-- read by ("halfOfId", "schoolId") FOR SHARE, so a concurrent UPDATE turning
-- the class into a teaching group or moving it to another year waits, and then
-- meets the half that now exists (CLASS_HAS_HALVES). A class not found by that
-- pair is the composite key's to refuse, with a 23503 that says nothing about
-- the other school. The foreign key's own CASCADE deletes the halves with the
-- class and never reaches the trigger, which fires on no DELETE.
--
-- Kind and year are guarded because everything that reads a half reads them:
-- a half turned into a CLASS would be some pupils' home class with half the
-- class's lessons, and a half in another year than its class would carry its
-- lessons into a year its pupils are not in.
--
-- ## StudentGroupMembers."halfOfId": one half per class
--
-- A pupil in both halves of 7A would be at slöjd and at NO at once. The rule
-- is about two rows (two memberships of one pupil), so it is held by a unique
-- index over a copy of the class on the membership row:
--
--   * "halfOfId" UUID NULL, written only by app.student_group_members_half_of,
--     BEFORE INSERT OR UPDATE OF "studentGroupId": the group's own "halfOfId",
--     read by ("studentGroupId", "schoolId"), whatever the writer sent. It
--     raises nothing, so running ahead of the RLS check tells a writer nothing
--     about another school's group; a row stamped with another school reads
--     NULL here and is refused by the policy as before. A group's "halfOfId"
--     never changes (above), so the copy never goes stale.
--   * UNIQUE ("halfOfId", "studentId") WHERE "halfOfId" IS NOT NULL
--     ("StudentGroupMembers_one_half_per_class"): race-free, where a trigger
--     reading the other half would need a lock to be. rethrowPrismaError maps
--     its 23505 to the 409 HALF_MEMBER_IN_OTHER_HALF.
--
-- app.student_group_members_in_the_class, AFTER INSERT OR UPDATE OF
-- "studentGroupId", "studentId": a membership in a half needs the pupil's
-- home class to be the half's class (HALF_MEMBER_NOT_IN_CLASS, HC409). Or the
-- class's predecessor: läsårsrullning copies last year's halves' members into
-- next year's halves before activation moves the pupils (7A:1's pupils into
-- 8A:1 while they are still in 7A). AFTER, for 20261006120000's reason: it
-- only ever sees rows that passed every RLS WITH CHECK. The pupil's row is
-- read FOR SHARE: a class change committing beside the placement would
-- otherwise clean up before the placement is visible to it, and leave the
-- pupil placed in the class they just left. Either the change waits for the
-- placement and then removes it, or the placement waits for the change and
-- then judges the new class.
--
-- ## A pupil who changes class leaves its halves
--
-- app.users_leave_the_old_class_halves, AFTER UPDATE OF "studentGroupId" ON
-- "Users". The member trigger judges a membership when it is written, not
-- when its pupil moves, so a class change re-judges the pupil's halves by
-- the same rule: a membership in a half whose class is neither the pupil's
-- new class nor that class's predecessor is deleted. Moved from 7A to 7B in
-- the läsår, or out of any class, the pupil leaves 7A's halves — and next
-- year's 8A's, which took them as 7A's pupil before activation; left there
-- they would go into 8B at activation still placed in 8A:1, and the next
-- rollover would copy a member its trigger refuses. Moved straight into
-- next year's 8B, the same. Moved by activation into 8A, they keep 8A:1.
--
-- Except history: a half of a läsår that started before the active one is
-- left as it was. Activation makes the new year active before it moves
-- anyone, so 7A's halves stay with the pupils it moves to 8A, and 9A's with
-- the graduates it moves out of any class — the pupils' lessons that year
-- were taught in them. The rule asks no foreign key what it is doing, so a
-- class deleted under its pupils (its successor's link and the pupils' class
-- cleared by two SET NULL actions, in an order nobody chose) leaves them in
-- none of next year's halves either way. Every writer of a home class goes
-- through it: the people page, the SS12000 sync, the import, activation.
--
-- All three functions are SECURITY DEFINER, owned by the migration owner, in
-- schema "app" with a pinned search_path and EXECUTE taken from PUBLIC: they
-- look rows up by the (id, schoolId) the written row carries, and the
-- cleanup deletes what the writer of a class change may not be allowed to
-- write itself (the SS12000 principal has no DELETE on memberships). DETAIL
-- carries only the written row's own id, never a name and never another row's.
--
-- ## Row-level security and grants
--
-- No new table, so no new policy and no GRANT, and nothing for the area
-- split (20261110100000) to have missed: the new columns are read and
-- written under the arms that already exist, which that migration split per
-- area — StudentGroups' and StudentGroupMembers' admin writes ask
-- app.current_user_may('PLANERING', true) (TABLE_WRITE_GATES), Users'
-- PERSONAL or PLANERING — beside staff and own-class SELECT and the SS12000
-- principal. A pupil already reads their own membership rows, the half among
-- them, and the lessons of a teaching group they are in
-- (calendar_lessons_teaching_group_select), so a placed pupil sees their
-- half's lessons with no new arm. The class-change cleanup is SECURITY
-- DEFINER: an expedition (PERSONAL, not PLANERING) that moves a pupil to
-- another class takes them out of the old class's halves, which it may not
-- write itself, as the class change implies.
--
-- ## Beside the live API: every lock at once, or none
--
-- Production runs this while the API before it serves requests. It alters
-- StudentGroups, StudentGroupMembers and PublicationSettings (ACCESS
-- EXCLUSIVE: columns, a CHECK, keys, indexes) and creates a trigger on Users
-- (SHARE ROW EXCLUSIVE: it blocks writes to Users, not reads). Requests take
-- these in both orders — a class change writes Users and then reads the
-- groups; a group write takes StudentGroups and then a pupil's Users row —
-- so a migration that waited for one while it held another could close a
-- cycle with either, and a waiting ACCESS EXCLUSIVE queues every reader
-- behind it. So all four are taken first, NOWAIT and together: a refusal
-- rolls the subtransaction back and with it whatever it got, and it tries
-- again 50 ms later. It never waits while it holds a lock, and no request
-- queues behind it. After 30 s of refusals it stops with nothing done and
-- can be rerun (prisma migrate resolve --rolled-back, then deploy).
-- lock_timeout bounds any wait nobody foresaw.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "StudentGroups" IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "StudentGroupMembers" IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "PublicationSettings" IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Users" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'StudentGroups, StudentGroupMembers, PublicationSettings and Users were not free at once in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- StudentGroups."halfOfId"
-- ---------------------------------------------------------------------------

ALTER TABLE "StudentGroups"
    ADD COLUMN "halfOfId" UUID;

ALTER TABLE "StudentGroups"
    ADD CONSTRAINT "StudentGroups_is_not_its_own_half" CHECK (
        "halfOfId" IS NULL OR "halfOfId" <> "id"
    );

CREATE INDEX "StudentGroups_halfOfId_schoolId_idx"
    ON "StudentGroups"("halfOfId", "schoolId");

ALTER TABLE "StudentGroups"
    ADD CONSTRAINT "StudentGroups_halfOfId_schoolId_fkey"
    FOREIGN KEY ("halfOfId", "schoolId") REFERENCES "StudentGroups"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE NO ACTION;

CREATE FUNCTION app.student_groups_half_is_of_a_class() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  class_kind "StudentGroupKind";
  class_year uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- The link is written once, at the half's INSERT.
    IF OLD."halfOfId" IS DISTINCT FROM NEW."halfOfId" THEN
      RAISE EXCEPTION 'HALF_LINK_IS_FIXED: en halvklass hör till den klass den delades ur och flyttas inte till en annan'
        USING ERRCODE = 'HC409',
              DETAIL  = format('studentGroupId=%s', NEW."id");
    END IF;
    -- A class with halves keeps its kind and its läsår.
    IF (OLD."kind" IS DISTINCT FROM NEW."kind" OR OLD."academicYearId" IS DISTINCT FROM NEW."academicYearId")
       AND EXISTS (SELECT 1 FROM "StudentGroups" h
                    WHERE h."halfOfId" = NEW."id" AND h."schoolId" = NEW."schoolId") THEN
      RAISE EXCEPTION 'CLASS_HAS_HALVES: en klass som är delad i halvor byter inte typ eller läsår'
        USING ERRCODE = 'HC409',
              DETAIL  = format('studentGroupId=%s', NEW."id");
    END IF;
  END IF;

  IF NEW."halfOfId" IS NULL THEN
    RETURN NULL;
  END IF;

  IF NEW."kind" <> 'TEACHING_GROUP' THEN
    RAISE EXCEPTION 'HALF_NOT_A_TEACHING_GROUP: en halvklass är en undervisningsgrupp, inte en klass'
      USING ERRCODE = 'HC409',
            DETAIL  = format('studentGroupId=%s', NEW."id");
  END IF;

  SELECT c."kind", c."academicYearId" INTO class_kind, class_year
    FROM "StudentGroups" c
   WHERE c."id" = NEW."halfOfId" AND c."schoolId" = NEW."schoolId"
     FOR SHARE;
  -- Not found by (id, schoolId): the composite foreign key's to refuse.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF class_kind <> 'CLASS' THEN
    RAISE EXCEPTION 'HALF_OF_NOT_A_CLASS: en halvklass är en halva av en klass, inte av en undervisningsgrupp'
      USING ERRCODE = 'HC409',
            DETAIL  = format('studentGroupId=%s', NEW."id");
  END IF;
  IF class_year IS DISTINCT FROM NEW."academicYearId" THEN
    RAISE EXCEPTION 'HALF_IN_OTHER_YEAR: en halvklass ligger i samma läsår som sin klass'
      USING ERRCODE = 'HC409',
            DETAIL  = format('studentGroupId=%s', NEW."id");
  END IF;
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION app.student_groups_half_is_of_a_class() FROM PUBLIC;

CREATE TRIGGER "StudentGroups_half_is_of_a_class"
    AFTER INSERT OR UPDATE OF "halfOfId", "kind", "academicYearId" ON "StudentGroups"
    FOR EACH ROW EXECUTE FUNCTION app.student_groups_half_is_of_a_class();

-- ---------------------------------------------------------------------------
-- StudentGroupMembers."halfOfId": one half per class
-- ---------------------------------------------------------------------------

ALTER TABLE "StudentGroupMembers"
    ADD COLUMN "halfOfId" UUID;

CREATE FUNCTION app.student_group_members_half_of() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  NEW."halfOfId" := (SELECT g."halfOfId" FROM "StudentGroups" g
                      WHERE g."id" = NEW."studentGroupId" AND g."schoolId" = NEW."schoolId");
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.student_group_members_half_of() FROM PUBLIC;

CREATE TRIGGER "StudentGroupMembers_half_of"
    BEFORE INSERT OR UPDATE OF "studentGroupId", "schoolId", "halfOfId" ON "StudentGroupMembers"
    FOR EACH ROW EXECUTE FUNCTION app.student_group_members_half_of();

CREATE UNIQUE INDEX "StudentGroupMembers_one_half_per_class"
    ON "StudentGroupMembers"("halfOfId", "studentId")
    WHERE "halfOfId" IS NOT NULL;

CREATE FUNCTION app.student_group_members_in_the_class() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  home uuid;
  class_predecessor uuid;
BEGIN
  IF NEW."halfOfId" IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT u."studentGroupId" INTO home
    FROM "Users" u
   WHERE u."id" = NEW."studentId" AND u."schoolId" = NEW."schoolId"
     FOR SHARE;
  SELECT c."predecessorId" INTO class_predecessor
    FROM "StudentGroups" c
   WHERE c."id" = NEW."halfOfId" AND c."schoolId" = NEW."schoolId";
  IF home IS NULL
     OR (home IS DISTINCT FROM NEW."halfOfId" AND home IS DISTINCT FROM class_predecessor) THEN
    RAISE EXCEPTION 'HALF_MEMBER_NOT_IN_CLASS: en elev placeras bara i en halva av sin egen klass'
      USING ERRCODE = 'HC409',
            DETAIL  = format('studentGroupMemberId=%s', NEW."id");
  END IF;
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION app.student_group_members_in_the_class() FROM PUBLIC;

CREATE TRIGGER "StudentGroupMembers_in_the_class"
    AFTER INSERT OR UPDATE OF "studentGroupId", "studentId", "halfOfId" ON "StudentGroupMembers"
    FOR EACH ROW EXECUTE FUNCTION app.student_group_members_in_the_class();

-- ---------------------------------------------------------------------------
-- A pupil who changes class within the läsår leaves the old class's halves
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.users_leave_the_old_class_halves() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  -- A pupil with no class had no half to leave: the member trigger refuses one.
  IF OLD."studentGroupId" IS NULL OR OLD."studentGroupId" IS NOT DISTINCT FROM NEW."studentGroupId" THEN
    RETURN NULL;
  END IF;
  DELETE FROM "StudentGroupMembers" m
   USING "StudentGroups" c, "AcademicYears" y
   WHERE m."studentId" = NEW."id"
     AND m."schoolId" = NEW."schoolId"
     AND c."id" = m."halfOfId" AND c."schoolId" = m."schoolId"
     AND y."id" = c."academicYearId" AND y."schoolId" = c."schoolId"
     -- Not of the class any more, by the member trigger's own rule.
     AND (NEW."studentGroupId" IS NULL
          OR (c."id" <> NEW."studentGroupId" AND c."predecessorId" IS DISTINCT FROM NEW."studentGroupId"))
     -- And not history: no active läsår began after the half's.
     AND NOT EXISTS (SELECT 1 FROM "AcademicYears" a
                      WHERE a."schoolId" = y."schoolId" AND a."isActive" AND a."startDate" > y."startDate");
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION app.users_leave_the_old_class_halves() FROM PUBLIC;

CREATE TRIGGER "Users_leave_the_old_class_halves"
    AFTER UPDATE OF "studentGroupId" ON "Users"
    FOR EACH ROW EXECUTE FUNCTION app.users_leave_the_old_class_halves();

-- ---------------------------------------------------------------------------
-- The publish check of an empty half
-- ---------------------------------------------------------------------------

ALTER TABLE "PublicationSettings"
    ADD COLUMN "gateEmptyHalf" "PublishGateMode" NOT NULL DEFAULT 'WARN';
