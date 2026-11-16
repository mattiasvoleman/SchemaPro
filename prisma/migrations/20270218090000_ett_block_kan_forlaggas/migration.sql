-- Ett block kan förläggas: a parallel block can be given a day and a time before
-- Generera sends it to the engine.
--
-- Språkval åk 7 (Spanska, Tyska and Franska for groups that cut across 7A, 7B and
-- 7C) is a block: its posts' lessons are placed at the same times. A post in a
-- block cannot have a förläggning of its own (TeachingRequirementPlacements,
-- 20270207090000, rule BLOCK: one member's placement would make the block partly
-- locked, which Generera refuses). So a school that knows its språkval is on
-- Tuesday at 10:00 had no way to say so. This migration is the place it says it.
--
-- ## What a block's förläggning is
--
-- One row of "TeachingBlockPlacements" is ONE lesson of the block at a day, a start
-- and a length that is one of the block's, in the block's weeks. It is a fact about
-- the block and not one row per post, so it cannot be written half: nothing has to
-- hold rows of several posts together. Each member sits it at that time. A member
-- that has a room of its own for it has a row in "TeachingBlockPlacementRooms"
-- (placement, post, room); a member WITHOUT a row is a member whose room the
-- engine chooses at every Generera. The two tables are the whole of it. The
-- class, the subject and the teachers are the POSTS' and are read at every
-- Generera, as for a post's förläggning.
--
-- Generera sends each member's lesson as a pinned lesson (a fäst lektion,
-- AnonymousRequirement.pinnedLessons, 20270207090000 and the engine's B1), the same
-- place k at every member, with the room the member's row names when it has one.
-- It is NEVER a lock: a lock inside a block is refused as a partly locked block
-- (BLOCK_PARTLY_LOCKED), and a pinned lesson with a room does the same job without
-- that. It writes the lesson that comes back for each member as a locked, generated
-- lesson marked "MasterLessons"."fromPlacement" (20270207090000), so the next
-- Generera replaces it from the rows as they then stand.
--
-- ## The keys
--
-- Every key is ("x", "schoolId") onto the parent's ("id", "schoolId") with ON UPDATE
-- NO ACTION, as the sweep of 20270115090000 made them (a parent moved to another
-- school must not take its children along, and a row cannot name another school's
-- parent). Checked by section 330 of the RLS suite.
--
--   * "TeachingBlockPlacements" ("blockId", "academicYearId", "schoolId") ->
--     "TeachingBlocks" ("id", "academicYearId", "schoolId"), ON DELETE CASCADE. A
--     block that goes takes its placements with it. THE KEY IS THE BLOCK'S EXISTING
--     ONE, which is why the placement carries "academicYearId": "TeachingBlocks"
--     is unique on (id, academicYearId, schoolId) and not on (id, schoolId), and a
--     new unique index on a table Generera reads in long transactions would be one
--     more thing to take a lock for. The year is then held by the key (a block of
--     2026/27 cannot hold a lesson of 2027/28), and the year's rows are read without
--     a join.
--   * "TeachingBlockPlacementRooms" ("placementId", "schoolId") ->
--     "TeachingBlockPlacements" ("id", "schoolId"), CASCADE: a placement that goes
--     (every ersättning of the list, a block that goes) takes its room rows.
--   * ("requirementId", "schoolId") -> "TeachingRequirements" ("id", "schoolId"),
--     CASCADE: a post that goes takes its room rows. A post that LEAVES the block is
--     not a deletion, and is handled by a trigger below.
--   * ("roomId", "schoolId") -> "Rooms" ("id", "schoolId"), ON DELETE NO ACTION: a
--     room a block's lesson names is NOT removed (SET NULL would turn the post's
--     choice into the engine's without a word, and CASCADE would delete the school's
--     decision). rooms.service.ts refuses its removal by name before this key.
--
-- ## The CHECKs
--
-- As the post's row, each named: "dayOfWeek" 1..5, "minutes" 15..240 on the five-
-- minute grid, "startTime" on the grid, and the lesson inside the engine's day,
-- 08:00 to 18:00 (in seconds since midnight, because a time plus an interval wraps).
--
-- ## The placements fit the block: SQLSTATE BP409, BLOCK_PLACEMENTS_DO_NOT_FIT
--
-- BP409 is unused (FP409 is a post's rows, TB409 a block's members, TP409 the decided
-- timplan, TS409 shares). The message starts with the rule broken, in the order the
-- rules are asked:
--
--   ISOLATION  the write is in REPEATABLE READ (below);
--   FOLLOWER   the block follows another block's times (sameTimesAsBlockId): it is
--              placed through the block it follows, whose lessons it then takes;
--   EMPTY      the block has no members to sit the lesson;
--   SHARES     a member shares its lessons between teachers (which of them a
--              placement is has not been decided: the plan's decision 9);
--   LENGTH     a row's length is not one of the block's;
--   WEEKS      a row runs other weeks than the block's. Pairs (odd and even weeks in
--              different places) are not supported for a block, so on an every-week
--              block a row of odd or even weeks is refused as well;
--   COUNT      more lessons of a length are placed than the block has;
--   MEMBER     a room row names a post that is not a member of the placement's block.
--
-- THE BLOCK'S LESSONS ARE ANY MEMBER'S. TB409 (20261024090000) already makes every
-- member agree on lessonsPerWeek, minutesPerLesson, lessonLengths and recurrence, so
-- the rules read the member with the lowest id and no more.
--
-- WHAT EACH WRITE IS JUDGED ON: a placement's INSERT, or UPDATE of its block, length
-- or weeks; a room row's INSERT, or UPDATE of its placement or post (MEMBER); a
-- member's UPDATE of lessonsPerWeek, minutesPerLesson, lessonLengths or recurrence; a
-- share written for a member (INSERT, or UPDATE of its post); the block's UPDATE of
-- sameTimesAsBlockId to a block. Nothing else can make a row wrong: a DELETE only
-- ever leaves fewer rows, a move to another day or hour changes nothing the rules
-- read, and MEMBERSHIP IS NEVER REFUSED. A post that joins a block has the lesson
-- directly (the engine chooses its room); a post that leaves it takes only its room
-- row with it (the second trigger below). A block left with no member keeps its
-- placements, which Generera then sends to nobody.
--
-- ROW TRIGGERS THAT JUDGE THE BLOCK'S WHOLE SET AFTER THE STATEMENT, as the post's
-- (20270207090000): an AFTER ROW trigger fires when the statement has finished, so a
-- list written as one INSERT of N rows is judged as a whole. Not deferred: a refusal at
-- COMMIT would reach the gateway as a failed commit rather than as the statement.
--
-- ONE WRITER OF A BLOCK AT A TIME, ON EVERY PATH. The trigger takes the block's row FOR
-- NO KEY UPDATE first and only then reads, in READ COMMITTED a new snapshot taken after
-- the lock. It is not enough to lock when a placement is written: a member's change of
-- lessons and a share written for a member must take the same lock, because a writer of
-- a placement does not lock the members' rows (the post's own trigger could, because a
-- post's writer locks the post), so without it a placement and a member's change could
-- each pass the other and commit a set that does not fit. TB409 takes the block's row
-- FOR UPDATE when a member's lessons change, so the lock is the one every path orders on.
-- FOR NO KEY UPDATE (not FOR UPDATE) because the placement's own key holds KEY SHARE on
-- the same row, and the two do not conflict. No advisory lock: it would be held across the
-- row's own foreign-key checks (advisory-lock-in-trigger-vs-fk-checks). The triggers fire
-- in name order and the RI_ConstraintTrigger_ ones first, so a room row's keys have taken
-- their KEY SHARE before this lock is asked for, and nothing the trigger does then waits
-- for a row a writer holds. REPEATABLE READ cannot be made safe by a lock (the read after
-- it sees the first snapshot), so a write there is refused (ISOLATION) rather than judged
-- on a snapshot that may be missing a concurrent row; nothing in the gateway writes in it.
--
-- THE ORDER OF EVERY LOCK IS THE POST'S ROW FIRST AND THE BLOCKS' ROWS AFTER IT, IN ID ORDER.
-- Every writer that holds a post's row and then asks for a block's row (a member's change of
-- lessons: the UPDATE holds the post, TB409 and this trigger then take the block) would meet a
-- writer that took the block's row and then the post's (a share written for the member: this
-- trigger took the block, and the shares' own trigger the post) in a deadlock (40P01), which
-- two 300-attempt hunts found at 17 and 26 in 300. So the share path takes the post's row
-- before the block's, as the shares' own trigger does later. And a post that moves from one
-- block to another holds the post and takes the OLD block (below) while TB409 takes the NEW one:
-- two posts moving in opposite directions took the two blocks in opposite orders (75 to 101
-- deadlocks in 300). So the trigger below takes both blocks, in id order, and is named to fire
-- BEFORE TB409's trigger ("..._block_leave_takes_rooms" sorts before "..._block_members_agree"),
-- so no other trigger of the move has taken one of them first.
--
-- SECURITY DEFINER, owned by the migration owner, so the lock and the reads are the
-- block's whatever the caller may see.
--
-- ## A post leaves the block: its room row goes, nothing is refused
--
-- "TeachingRequirements"."blockId" changes in three places (the import, the term split,
-- the block's members), and a room row for a post that is not a member says nothing
-- about anything: it is removed. The trigger takes the OLD block's row and the NEW one's
-- (when there is one) first, in id order, so a room row another transaction is inserting for
-- this post, while it is still a member, is seen by the delete or the insert is refused as
-- MEMBER.
--
-- ## Who may read and write
--
-- Through the gateway only, as the post's rows: the API role, app_authenticated, holds
-- SELECT, INSERT, UPDATE and DELETE on both tables; authenticated and anon nothing;
-- service_role SELECT and nothing more; no TRUNCATE, REFERENCES, TRIGGER or, on Postgres
-- 17, MAINTAIN. Every policy is TO app_authenticated: the school's SCHOOL_ADMIN reads,
-- and the one who writes PLANERING writes. No arm names TEACHER, so section 494 (the
-- catalogue guard of Users.teaches) is not touched. FORCE ROW LEVEL SECURITY is off, as
-- on every table of the schema.
--
-- ## Beside the live API: every lock at once, or none
--
-- Production runs this while the API before it serves requests. The keys take Schools,
-- TeachingBlocks, TeachingRequirements and Rooms in SHARE ROW EXCLUSIVE (writes wait,
-- reads do not); the triggers take TeachingRequirements, TeachingRequirementShares and
-- TeachingBlocks in the same mode. Requests take these in every order, so a migration that
-- waited for one while holding another could close a cycle. So all five are taken first,
-- NOWAIT and together: a refusal rolls the subtransaction back and with it whatever it
-- got, and it tries again 50 ms later. It never waits while it holds a lock, and no
-- request queues behind it. After 30 s of refusals it stops with nothing done and can be
-- rerun (prisma migrate resolve --rolled-back, then deploy). lock_timeout bounds any wait
-- nobody foresaw. No existing column changes, so nothing is taken in ACCESS EXCLUSIVE.
--
-- BACKWARD COMPATIBLE FOR ONE RELEASE. Two tables nobody writes yet and triggers that find
-- no row and let every write of the old API through. The API before this one ignores the
-- new tables, so a block with placements is then laid freely by Generera, without a word
-- (DEPLOYMENT.md): going back loses the placements silently.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Schools" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "TeachingBlocks" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "TeachingRequirements" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "TeachingRequirementShares" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Rooms" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Schools, TeachingBlocks, TeachingRequirements, TeachingRequirementShares and Rooms were not free at once in 30 s: nothing is changed. Run prisma migrate resolve --rolled-back 20270218090000_ett_block_kan_forlaggas, then deploy again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- The tables.
-- ---------------------------------------------------------------------------

CREATE TABLE "TeachingBlockPlacements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "blockId" UUID NOT NULL,
    "academicYearId" UUID NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startTime" TIME(0) NOT NULL,
    "minutes" INTEGER NOT NULL,
    "recurrence" "LessonRecurrence" NOT NULL DEFAULT 'ALL_WEEKS',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "TeachingBlockPlacements_pkey" PRIMARY KEY ("id"),
    -- Monday to Friday: the engine's school week.
    CONSTRAINT "TeachingBlockPlacements_dayOfWeek_is_a_school_day"
        CHECK ("dayOfWeek" BETWEEN 1 AND 5),
    -- One lesson's bounds and grid, as the post's row.
    CONSTRAINT "TeachingBlockPlacements_minutes_is_sane"
        CHECK ("minutes" BETWEEN 15 AND 240 AND "minutes" % 5 = 0),
    -- The engine's slot: no seconds, and a minute divisible by five.
    CONSTRAINT "TeachingBlockPlacements_startTime_is_on_the_grid"
        CHECK (EXTRACT(SECOND FROM "startTime") = 0 AND EXTRACT(MINUTE FROM "startTime")::integer % 5 = 0),
    -- Inside the engine's day, 08:00 to 18:00, in seconds since midnight.
    CONSTRAINT "TeachingBlockPlacements_inside_the_school_day"
        CHECK (EXTRACT(EPOCH FROM "startTime") >= 8 * 3600
               AND EXTRACT(EPOCH FROM "startTime") + "minutes" * 60 <= 18 * 3600)
);

-- The (id, schoolId) target the room rows' key points at.
CREATE UNIQUE INDEX "TeachingBlockPlacements_id_schoolId_key"
    ON "TeachingBlockPlacements"("id", "schoolId");
-- A block's rows: the trigger's read, the block's CASCADE and the gateway's.
CREATE INDEX "TeachingBlockPlacements_blockId_idx"
    ON "TeachingBlockPlacements"("blockId");
-- A year's rows: the week's read.
CREATE INDEX "TeachingBlockPlacements_academicYearId_idx"
    ON "TeachingBlockPlacements"("academicYearId");
CREATE INDEX "TeachingBlockPlacements_schoolId_idx"
    ON "TeachingBlockPlacements"("schoolId");

ALTER TABLE "TeachingBlockPlacements"
    ADD CONSTRAINT "TeachingBlockPlacements_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeachingBlockPlacements"
    ADD CONSTRAINT "TeachingBlockPlacements_blockId_academicYearId_schoolId_fkey"
    FOREIGN KEY ("blockId", "academicYearId", "schoolId") REFERENCES "TeachingBlocks"("id", "academicYearId", "schoolId")
    ON DELETE CASCADE ON UPDATE NO ACTION;

COMMENT ON TABLE "TeachingBlockPlacements" IS
  'Förlagda block: one lesson of a parallel block (day, start, length, weeks) the school placed before Generera, which sends it as a pinned lesson of every member and writes it into the grundschema marked MasterLessons.fromPlacement. A member''s own room is a row of TeachingBlockPlacementRooms; a member without one has its room chosen by the engine.';

CREATE TABLE "TeachingBlockPlacementRooms" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "placementId" UUID NOT NULL,
    "requirementId" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "TeachingBlockPlacementRooms_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TeachingBlockPlacementRooms_id_schoolId_key"
    ON "TeachingBlockPlacementRooms"("id", "schoolId");
-- One room per post and lesson. Leads with the placement, so it is the key's index too.
CREATE UNIQUE INDEX "TeachingBlockPlacementRooms_placementId_requirementId_key"
    ON "TeachingBlockPlacementRooms"("placementId", "requirementId");
-- A post's rows: the CASCADE of a post that goes and the trigger of a post that leaves.
CREATE INDEX "TeachingBlockPlacementRooms_requirementId_schoolId_idx"
    ON "TeachingBlockPlacementRooms"("requirementId", "schoolId");
-- A room's rows: the NO ACTION check when a room is removed, and the refusal by name that comes before it.
CREATE INDEX "TeachingBlockPlacementRooms_roomId_schoolId_idx"
    ON "TeachingBlockPlacementRooms"("roomId", "schoolId");
CREATE INDEX "TeachingBlockPlacementRooms_schoolId_idx"
    ON "TeachingBlockPlacementRooms"("schoolId");

ALTER TABLE "TeachingBlockPlacementRooms"
    ADD CONSTRAINT "TeachingBlockPlacementRooms_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeachingBlockPlacementRooms"
    ADD CONSTRAINT "TeachingBlockPlacementRooms_placementId_schoolId_fkey"
    FOREIGN KEY ("placementId", "schoolId") REFERENCES "TeachingBlockPlacements"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "TeachingBlockPlacementRooms"
    ADD CONSTRAINT "TeachingBlockPlacementRooms_requirementId_schoolId_fkey"
    FOREIGN KEY ("requirementId", "schoolId") REFERENCES "TeachingRequirements"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "TeachingBlockPlacementRooms"
    ADD CONSTRAINT "TeachingBlockPlacementRooms_roomId_schoolId_fkey"
    FOREIGN KEY ("roomId", "schoolId") REFERENCES "Rooms"("id", "schoolId")
    ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMENT ON TABLE "TeachingBlockPlacementRooms" IS
  'The room a member of a block chose for one of the block''s förläggningar. A member without a row here has its room chosen by the engine at every Generera.';

-- ---------------------------------------------------------------------------
-- The placements fit the block.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.teaching_block_placements_fit()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  block_id uuid;
  school_id uuid;
  blk record;
  member record;
  has_member boolean;
  lengths int[];
  reason text;
  sentence text;
BEGIN
  -- Which block this write puts in question. Assignments in branches, not one CASE:
  -- PL/pgSQL resolves every field an expression names, and OLD or NEW of one table
  -- has no field of another's.
  IF TG_TABLE_NAME = 'TeachingBlockPlacements' THEN
    block_id := NEW."blockId";
    school_id := NEW."schoolId";
  ELSIF TG_TABLE_NAME = 'TeachingBlockPlacementRooms' THEN
    SELECT p."blockId" INTO block_id
      FROM "TeachingBlockPlacements" p
     WHERE p."id" = NEW."placementId" AND p."schoolId" = NEW."schoolId";
    school_id := NEW."schoolId";
  ELSIF TG_TABLE_NAME = 'TeachingRequirements' THEN
    block_id := NEW."blockId";
    school_id := NEW."schoolId";
  ELSIF TG_TABLE_NAME = 'TeachingRequirementShares' THEN
    -- The post's row BEFORE the block's, as every writer that holds a post goes on to the block
    -- (the preamble: the order of every lock): a member's change of lessons holds the post and
    -- then takes the block, and this path would otherwise take the block and wait for the post.
    SELECT r."blockId" INTO block_id
      FROM "TeachingRequirements" r
     WHERE r."id" = NEW."requirementId" AND r."schoolId" = NEW."schoolId"
       FOR NO KEY UPDATE;
    school_id := NEW."schoolId";
  ELSE
    block_id := NEW."id";
    school_id := NEW."schoolId";
  END IF;
  -- A post in no block, or a row whose placement the key answers for.
  IF block_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- See ONE WRITER OF A BLOCK AT A TIME: the one level the lock below does not make
  -- the read safe in. On every write, because the "no rows" shortcut below reads
  -- the same stale snapshot.
  IF current_setting('transaction_isolation') = 'repeatable read' THEN
    RAISE EXCEPTION 'ISOLATION: förlagda block och de blockfält de prövas mot skrivs i READ COMMITTED eller SERIALIZABLE, inte i REPEATABLE READ'
      USING ERRCODE = 'BP409',
            DETAIL = format('blockId=%s reason=ISOLATION', block_id);
  END IF;

  -- The block's row first, on every path, held to COMMIT. A block that is not there
  -- is another school's or one removed in this statement, which the key answers.
  SELECT b."id", b."sameTimesAsBlockId" INTO blk
    FROM "TeachingBlocks" b
   WHERE b."id" = block_id AND b."schoolId" = school_id
     FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- After the lock, a new snapshot in READ COMMITTED: what another writer committed
  -- while this one waited is seen. A block with no placement has nothing to fit,
  -- which is every block of every school until one writes a placement.
  IF NOT EXISTS (SELECT 1 FROM "TeachingBlockPlacements" p
                  WHERE p."blockId" = block_id AND p."schoolId" = school_id) THEN
    RETURN NULL;
  END IF;

  -- The block's lessons are any member's (TB409 makes the members agree).
  SELECT r."lessonsPerWeek", r."minutesPerLesson", r."lessonLengths", r."recurrence"
    INTO member
    FROM "TeachingRequirements" r
   WHERE r."blockId" = block_id AND r."schoolId" = school_id
   ORDER BY r."id"
   LIMIT 1;
  has_member := FOUND;

  reason := NULL;
  IF blk."sameTimesAsBlockId" IS NOT NULL THEN
    reason := 'FOLLOWER';
  ELSIF NOT has_member THEN
    reason := 'EMPTY';
  ELSE
    -- GREATEST: no writer stores a negative count, but array_fill would answer one
    -- with 54000 rather than the refusal below (no lessons: nothing fits).
    lengths := CASE WHEN cardinality(member."lessonLengths") = 0
                    THEN array_fill(member."minutesPerLesson", ARRAY[GREATEST(member."lessonsPerWeek", 0)])
                    ELSE member."lessonLengths" END;

    IF EXISTS (SELECT 1
                 FROM "TeachingRequirementShares" s
                 JOIN "TeachingRequirements" r ON r."id" = s."requirementId" AND r."schoolId" = s."schoolId"
                WHERE r."blockId" = block_id AND r."schoolId" = school_id) THEN
      reason := 'SHARES';
    ELSIF EXISTS (SELECT 1 FROM "TeachingBlockPlacements" p
                   WHERE p."blockId" = block_id AND p."schoolId" = school_id
                     AND NOT (p."minutes" = ANY (lengths))) THEN
      reason := 'LENGTH';
    ELSIF EXISTS (SELECT 1 FROM "TeachingBlockPlacements" p
                   WHERE p."blockId" = block_id AND p."schoolId" = school_id
                     AND p."recurrence" <> member."recurrence") THEN
      reason := 'WEEKS';
    ELSIF EXISTS (
        SELECT 1
          FROM (SELECT p."minutes", count(*) AS placed
                  FROM "TeachingBlockPlacements" p
                 WHERE p."blockId" = block_id AND p."schoolId" = school_id
                 GROUP BY p."minutes") t
         WHERE t.placed > (SELECT count(*) FROM unnest(lengths) l WHERE l = t."minutes")) THEN
      reason := 'COUNT';
    ELSIF EXISTS (
        SELECT 1
          FROM "TeachingBlockPlacementRooms" x
          JOIN "TeachingBlockPlacements" p ON p."id" = x."placementId" AND p."schoolId" = x."schoolId"
          LEFT JOIN "TeachingRequirements" r ON r."id" = x."requirementId" AND r."schoolId" = x."schoolId"
         WHERE p."blockId" = block_id AND p."schoolId" = school_id
           AND r."blockId" IS DISTINCT FROM p."blockId") THEN
      reason := 'MEMBER';
    END IF;
  END IF;

  IF reason IS NOT NULL THEN
    sentence := CASE reason
      WHEN 'FOLLOWER' THEN 'ett block som följer ett annat blocks tider förläggs inte själv: förlägg det block det följer'
      WHEN 'EMPTY' THEN 'ett block utan poster kan inte ha förlagda lektioner'
      WHEN 'SHARES' THEN 'ett block där en post delar sina lektioner kan inte ha förlagda lektioner'
      WHEN 'LENGTH' THEN 'en förlagd lektion har en längd som blockets poster inte har'
      WHEN 'WEEKS' THEN 'en förlagd lektion går andra veckor än blockets'
      WHEN 'COUNT' THEN 'fler lektioner av en längd är förlagda än blocket har'
      ELSE 'en förlagd lektion har en sal för en post som inte ligger i blocket'
    END;
    RAISE EXCEPTION '%: %', reason, sentence
      USING ERRCODE = 'BP409',
            DETAIL = format('blockId=%s reason=%s', block_id, reason);
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION app.teaching_block_placements_fit() IS
  'BP409 (BLOCK_PLACEMENTS_DO_NOT_FIT): the placements of a parallel block fit it (FOLLOWER, EMPTY, SHARES, LENGTH, WEEKS, COUNT, MEMBER). Judges the block''s whole set after the statement; locks the block row first on every path.';

-- The placements' own writes. Not UPDATE of every column: a move to another day or time changes nothing the rules read.
CREATE TRIGGER "TeachingBlockPlacements_fit"
    AFTER INSERT OR UPDATE OF "blockId", "minutes", "recurrence"
    ON "TeachingBlockPlacements"
    FOR EACH ROW
    EXECUTE FUNCTION app.teaching_block_placements_fit();

-- A room row: its post is a member.
CREATE TRIGGER "TeachingBlockPlacementRooms_fit"
    AFTER INSERT OR UPDATE OF "placementId", "requirementId"
    ON "TeachingBlockPlacementRooms"
    FOR EACH ROW
    EXECUTE FUNCTION app.teaching_block_placements_fit();

-- A member's change of the lessons the rules read. A member that is in no block asks nothing.
CREATE TRIGGER "TeachingRequirements_block_placements_fit"
    AFTER UPDATE OF "lessonsPerWeek", "minutesPerLesson", "lessonLengths", "recurrence"
    ON "TeachingRequirements"
    FOR EACH ROW
    WHEN (NEW."blockId" IS NOT NULL
          AND (OLD."lessonsPerWeek", OLD."minutesPerLesson", OLD."lessonLengths", OLD."recurrence")
              IS DISTINCT FROM
              (NEW."lessonsPerWeek", NEW."minutesPerLesson", NEW."lessonLengths", NEW."recurrence"))
    EXECUTE FUNCTION app.teaching_block_placements_fit();

-- A share written for a member. An UPDATE only matters when it moves the share to another post.
CREATE TRIGGER "TeachingRequirementShares_block_placements_fit"
    AFTER INSERT OR UPDATE OF "requirementId"
    ON "TeachingRequirementShares"
    FOR EACH ROW
    EXECUTE FUNCTION app.teaching_block_placements_fit();

-- A block that is set to follow another block's times. Clearing the link asks nothing.
CREATE TRIGGER "TeachingBlocks_placements_fit"
    AFTER UPDATE OF "sameTimesAsBlockId"
    ON "TeachingBlocks"
    FOR EACH ROW
    WHEN (NEW."sameTimesAsBlockId" IS NOT NULL
          AND OLD."sameTimesAsBlockId" IS DISTINCT FROM NEW."sameTimesAsBlockId")
    EXECUTE FUNCTION app.teaching_block_placements_fit();

-- ---------------------------------------------------------------------------
-- A post that leaves its block takes its room rows with it.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.teaching_block_placement_rooms_leave()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  -- The block it leaves AND the block it goes to, in id order (the preamble: the order of every
  -- lock), before any other trigger of the move takes one of them: a room row another
  -- transaction is inserting for this post while it is still a member is then seen by the delete
  -- below, or is refused there as MEMBER, and two posts that change places never take the two
  -- blocks in opposite orders. ORDER BY under FOR NO KEY UPDATE locks the rows in that order.
  PERFORM 1
     FROM "TeachingBlocks" b
    WHERE b."schoolId" = OLD."schoolId" AND b."id" IN (OLD."blockId", NEW."blockId")
    ORDER BY b."id"
      FOR NO KEY UPDATE;
  DELETE FROM "TeachingBlockPlacementRooms" x
   WHERE x."requirementId" = OLD."id" AND x."schoolId" = OLD."schoolId";
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION app.teaching_block_placement_rooms_leave() IS
  'A timplanspost that leaves its block (blockId changes) loses its rows in TeachingBlockPlacementRooms: its room is the engine''s to choose again. Membership is never refused. Locks the old and the new block row, in id order, before TB409''s trigger takes one of them.';

-- Named to sort before TB409's "TeachingRequirements_block_members_agree": triggers fire in name order, and this one takes
-- both blocks of the move, in id order, before that one takes the block the post goes to.
CREATE TRIGGER "TeachingRequirements_block_leave_takes_rooms"
    AFTER UPDATE OF "blockId"
    ON "TeachingRequirements"
    FOR EACH ROW
    WHEN (OLD."blockId" IS NOT NULL AND OLD."blockId" IS DISTINCT FROM NEW."blockId")
    EXECUTE FUNCTION app.teaching_block_placement_rooms_leave();

-- ---------------------------------------------------------------------------
-- Row-level security and grants. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "TeachingBlockPlacements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TeachingBlockPlacementRooms" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r text;
  t text;
  p text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    FOREACH t IN ARRAY ARRAY['TeachingBlockPlacements', 'TeachingBlockPlacementRooms'] LOOP
      p := CASE t WHEN 'TeachingBlockPlacements' THEN 'teaching_block_placements' ELSE 'teaching_block_placement_rooms' END;
      EXECUTE format($f$CREATE POLICY %I ON %I FOR SELECT TO "app_authenticated"
          USING ("schoolId" = (select app.current_school_id())
                 AND (select app.current_user_role()) = 'SCHOOL_ADMIN')$f$, p || '_admin_select', t);
      EXECUTE format($f$CREATE POLICY %I ON %I FOR INSERT TO "app_authenticated"
          WITH CHECK ("schoolId" = (select app.current_school_id())
                      AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                      AND (select app.current_user_may('PLANERING', true)))$f$, p || '_admin_insert', t);
      EXECUTE format($f$CREATE POLICY %I ON %I FOR UPDATE TO "app_authenticated"
          USING ("schoolId" = (select app.current_school_id())
                 AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
          WITH CHECK ("schoolId" = (select app.current_school_id())
                      AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                      AND (select app.current_user_may('PLANERING', true)))$f$, p || '_admin_update', t);
      EXECUTE format($f$CREATE POLICY %I ON %I FOR DELETE TO "app_authenticated"
          USING ("schoolId" = (select app.current_school_id())
                 AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                 AND (select app.current_user_may('PLANERING', true)))$f$, p || '_admin_delete', t);
      EXECUTE format('REVOKE ALL ON %I FROM "app_authenticated"', t);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO "app_authenticated"', t);
    END LOOP;
  END IF;
  FOREACH t IN ARRAY ARRAY['TeachingBlockPlacements', 'TeachingBlockPlacementRooms'] LOOP
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

  FOREACH t IN ARRAY ARRAY['app.teaching_block_placements_fit()', 'app.teaching_block_placement_rooms_leave()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- BLOCK_PLACEMENTS_REACH: the four arms of each table and no other; none for a
-- PostgREST role, the service or the sync principal.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  bad text;
  t text;
  p text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    RETURN;
  END IF;
  FOREACH t IN ARRAY ARRAY['TeachingBlockPlacements', 'TeachingBlockPlacementRooms'] LOOP
    p := CASE t WHEN 'TeachingBlockPlacements' THEN 'teaching_block_placements_' ELSE 'teaching_block_placement_rooms_' END;
    SELECT string_agg(x.policyname || ' ' || x.cmd || ' ' || x.roles::text, ', ' ORDER BY x.policyname) INTO bad
      FROM pg_policies x
     WHERE x.schemaname = 'public' AND x.tablename = t
       AND NOT (x.roles = '{app_authenticated}'::name[]
                AND x.policyname = p || CASE x.cmd WHEN 'SELECT' THEN 'admin_select'
                                                   WHEN 'INSERT' THEN 'admin_insert'
                                                   WHEN 'UPDATE' THEN 'admin_update'
                                                   WHEN 'DELETE' THEN 'admin_delete'
                                                   ELSE 'an arm for every command' END
                AND (x.cmd = 'SELECT' OR coalesce(x.with_check, x.qual) LIKE '%current_user_may(''PLANERING''%'));
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'BLOCK_PLACEMENTS_REACH: these arms reach % beyond the administrators'' read and the planner''s writes: %', t, bad;
    END IF;
    IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = t) <> 4 THEN
      RAISE EXCEPTION 'BLOCK_PLACEMENTS_REACH: % has % arms, not the four above',
        t, (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = t);
    END IF;
  END LOOP;
END
$$;
