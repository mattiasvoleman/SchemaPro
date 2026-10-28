-- Ett block på ett annat blocks tider har dess lektioner.
--
-- "Dela i halvklass" with one subject read in turn (hemkunskap: 6A:1 the
-- first half of the autumn, 6A:2 the second) writes two posts, each in a
-- block of its own, and the second block names the first
-- (TeachingBlocks."sameTimesAsBlockId", 20261128090000). The generator places
-- the first half's post and writes the second half's at the same times in its
-- own weeks (same-times.ts), which needs the same lessons on both. TB409
-- (20261024090000) holds a block's posts to one another, and a post alone in
-- its block has nobody to be held to: a PATCH of 6A:2's lessons was saved, and
-- the next generation refused the pair with BLOCK_SAME_TIMES_DIFFER. With two
-- subjects (slöjd) the same PATCH was refused at once, by the other post in
-- the block.
--
-- ## The change: the same function, one more comparison
--
-- app.teaching_block_members_agree() also compares a post whose LESSONS
-- change, in the block it stays in, with the posts of the block on the same
-- times — the block its block names, and the block that names its block. The
-- lessons only: lessonsPerWeek, minutesPerLesson and lessonLengths. The
-- weeks are not compared, since the two blocks are two periods by design and
-- their posts have other weeks; whether those weeks meet stays the
-- generator's to judge, with the subjects and groups, as before.
--
-- A refusal is the same SQLSTATE TB409 and message token BLOCK_MEMBERS_DIFFER,
-- so an API that does not know this migration maps it as it maps every TB409
-- (rethrowPrismaError, a 409 naming the post's block). The message names both
-- blocks, and DETAIL carries a fourth key, sameTimesBlockId, which the new
-- gateway reads to say which block the post is held to. The message keeps the
-- old reader's pattern (i blocket "<name>" har inte samma), so the old API
-- still names the post's block.
--
-- ONLY A CHANGE OF LESSONS IN A BLOCK THE POST STAYS IN. An INSERT, a post
-- joining or leaving a block, and a change of weeks alone are judged as
-- before and nothing more:
--   * the rollover inserts next year's posts as this year's stand, and a
--     pair that has already drifted apart must not stop the whole rollover;
--   * a post joining a block (a block's membership PATCH) holds its own
--     block's row before the UPDATE, and taking the other block's row after
--     it could wait in a cycle with the same PATCH on the other block;
--   * "Dela i halvklass" inserts its posts into blocks it has just created.
-- What is left to the generator is what was left before: posts put into a
-- linked block with other lessons, by hand, between generations.
--
-- WHAT KEEPS WORKING. "Ändra lektioner" on either block writes every post of
-- both blocks in one UPDATE (teaching-blocks.service.ts, setLessons), and an
-- AFTER ROW trigger fires at the end of its statement, so each post is
-- compared with the other block's posts as the statement leaves them. The
-- CSV import writes a linked pair's changed rows in one statement too
-- (import.service.ts). With two subjects nothing a post's own PATCH could do
-- is refused that was not refused before: the other post in its block is
-- compared first, and the new comparison only adds a block whose posts all
-- changed while the other block's did not, which no writer of the API does.
--
-- ONE WRITER OF A PAIR AT A TIME. Two transactions that each change one half
-- would each find the other half as it was, both pass, and commit a pair that
-- disagrees. So before it reads, the function takes both blocks' rows FOR
-- UPDATE in id order — the order setLessons' lockSameTimes takes them in —
-- and holds them to COMMIT: the second writer waits, and reads after the lock
-- what the first committed (READ COMMITTED takes a new snapshot per
-- statement). In id order, not its own block first, because the two writers
-- of a pair start from opposite ends of it. A change that does not take the
-- new comparison locks its own block as before, and nothing else.
--
-- ## Beside the live API
--
-- CREATE OR REPLACE FUNCTION rewrites the function's row in pg_proc and takes
-- no lock on TeachingRequirements or TeachingBlocks: the trigger, its columns
-- and its WHEN are unchanged, and so are the function's owner and grants
-- (REPLACE keeps the ACL; SECURITY DEFINER and the pinned search_path are
-- restated, as REPLACE writes them anew). A request inside the trigger while
-- this runs finishes on the body it started with. lock_timeout bounds any wait
-- nobody foresaw, and a timeout leaves nothing changed: `prisma migrate
-- resolve --rolled-back
-- 20261213090000_ett_block_pa_ett_annat_blocks_tider_har_dess_lektioner`,
-- then deploy again.

SELECT set_config('lock_timeout', '5s', true);

CREATE OR REPLACE FUNCTION app.teaching_block_members_agree()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  block_name text;
  other uuid;
  same_times uuid;
  same_times_name text;
  lessons_changed boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    lessons_changed :=
      OLD."blockId" IS NOT DISTINCT FROM NEW."blockId"
      AND (OLD."lessonsPerWeek", OLD."minutesPerLesson", OLD."lessonLengths")
          IS DISTINCT FROM
          (NEW."lessonsPerWeek", NEW."minutesPerLesson", NEW."lessonLengths");
  END IF;

  -- The block and the block on its times, or whose times it takes, in id
  -- order (setLessons' lockSameTimes reads the same rows).
  IF lessons_changed THEN
    PERFORM 1
       FROM "TeachingBlocks" b
      WHERE b."schoolId" = NEW."schoolId"
        AND (b."id" = NEW."blockId"
             OR b."sameTimesAsBlockId" = NEW."blockId"
             OR b."id" = (SELECT s."sameTimesAsBlockId"
                            FROM "TeachingBlocks" s
                           WHERE s."id" = NEW."blockId" AND s."schoolId" = NEW."schoolId"))
      ORDER BY b."id"
        FOR UPDATE;
  END IF;

  SELECT b."name" INTO block_name
    FROM "TeachingBlocks" b
   WHERE b."id" = NEW."blockId" AND b."schoolId" = NEW."schoolId"
     FOR UPDATE;

  SELECT r."id" INTO other
    FROM "TeachingRequirements" r
   WHERE r."blockId" = NEW."blockId"
     AND r."schoolId" = NEW."schoolId"
     AND r."id" <> NEW."id"
     AND (r."lessonsPerWeek", r."minutesPerLesson", r."lessonLengths",
          r."recurrence", r."startDate", r."endDate")
         IS DISTINCT FROM
         (NEW."lessonsPerWeek", NEW."minutesPerLesson", NEW."lessonLengths",
          NEW."recurrence", NEW."startDate", NEW."endDate")
   ORDER BY r."id"
   LIMIT 1;

  IF other IS NOT NULL THEN
    RAISE EXCEPTION 'BLOCK_MEMBERS_DIFFER: timplansposterna i blocket "%" har inte samma lektioner och veckor', block_name
      USING ERRCODE = 'TB409',
            DETAIL = format('teachingBlockId=%s requirementId=%s otherRequirementId=%s',
                            NEW."blockId", NEW."id", other);
  END IF;

  IF lessons_changed THEN
    SELECT r."id", b."id", b."name" INTO other, same_times, same_times_name
      FROM "TeachingBlocks" own
      JOIN "TeachingBlocks" b
        ON b."schoolId" = own."schoolId"
       AND b."id" <> own."id"
       AND (b."id" = own."sameTimesAsBlockId" OR b."sameTimesAsBlockId" = own."id")
      JOIN "TeachingRequirements" r
        ON r."blockId" = b."id" AND r."schoolId" = own."schoolId"
     WHERE own."id" = NEW."blockId"
       AND own."schoolId" = NEW."schoolId"
       AND (r."lessonsPerWeek", r."minutesPerLesson", r."lessonLengths")
           IS DISTINCT FROM
           (NEW."lessonsPerWeek", NEW."minutesPerLesson", NEW."lessonLengths")
     ORDER BY r."id"
     LIMIT 1;

    IF other IS NOT NULL THEN
      RAISE EXCEPTION 'BLOCK_MEMBERS_DIFFER: timplansposten i blocket "%" har inte samma lektioner som posterna i blocket "%", som läggs på samma tider',
                      block_name, same_times_name
        USING ERRCODE = 'TB409',
              DETAIL = format('teachingBlockId=%s requirementId=%s otherRequirementId=%s sameTimesBlockId=%s',
                              NEW."blockId", NEW."id", other, same_times);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION app.teaching_block_members_agree() IS
  'TB409 BLOCK_MEMBERS_DIFFER: a timplanspost in a block has the lessons and weeks of every other member, and a change of its lessons has the lessons of the posts of the block on the same times. Locks the block row first, and for a change of lessons both blocks in id order.';
