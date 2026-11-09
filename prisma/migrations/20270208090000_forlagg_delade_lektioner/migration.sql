-- Förlägg delade lektioner: a timplanspost that shares its lessons between
-- teachers can have förlagda lektioner, each one a teacher's.
--
-- Förlagda poster (20270207090000) let a school give one of a post's lessons a
-- day, a time and a room before Generera, and refused a post with delade
-- lektioner outright (SHARES): which teacher's lesson a förläggning was had not
-- been decided. On 2026-11-09 the user asked for exactly that — the teachers
-- are given their lessons first, then one or more of those lessons are placed —
-- and chose two things: a lesson nobody teaches cannot be placed (the school
-- chooses its teacher first), and a change of teacher on the post carries the
-- förläggningar along when it is unambiguous and is stopped otherwise, with the
-- förläggning that has to be changed first named.
--
-- ## The change
--
--   * "TeachingRequirementPlacements"."teacherId", nullable. On a post that
--     shares nothing it is NULL, and the post's teacher is the lesson's, as
--     every row written before this migration has it: such a post behaves
--     exactly as it did. On a shared post it is the lesson's teacher — the
--     post's huvudlärare or a share's teacher — and the row's length is one of
--     that teacher's lengths. NULL on a shared post is a lesson nobody teaches,
--     which only a removed teacher leaves (below); no writer may put it there.
--   * The förläggning is tied to the teacher and the length, NOT to a share
--     row: every writer of shares replaces a post's rows whole (deleteMany +
--     createMany, new ids), which is why MasterLessons.fromPlacement is a flag
--     and not a key (20270207090000).
--   * app.teaching_requirement_placements_fit() is replaced (CREATE OR
--     REPLACE, built on 20270207090000's body; md5 of its source before and
--     after in the PR): SHARES is gone, NO_TEACHER is new. Its trigger on the
--     placements is created again with "teacherId" among the columns, and its
--     trigger on the shares, whose only answer was SHARES, is dropped.
--   * app.teaching_requirement_placement_teachers_fit(), new: the rules per
--     teacher, by three DEFERRED constraint triggers (below).
--
-- ## The key to Users
--
-- ("teacherId", "schoolId") -> "Users" ("id", "schoolId"), as every key between
-- two tables of a school (20270115090000, sections 330 and 388):
--
--   ON DELETE SET NULL ("teacherId"). A teacher removed leaves the lesson
--     standing, unstaffed, at the day, time and room the school chose — the
--     way the post's own teacherId and the share's teacherId are SET NULL by
--     the same removal, so the three agree: the share becomes that many lessons
--     nobody teaches, and the förläggning is one of them. CASCADE would delete
--     the school's decision without a word (the reason the room's key is NO
--     ACTION in 20270207090000); NO ACTION would make every removal of a
--     teacher wait for somebody to edit the timplan first, and a person's
--     removal is the registry's (borttagningsinventariet tells it, kind
--     otherLinks, as the share's key). Only "teacherId" is cleared: the row
--     stays the school's.
--   ON UPDATE NO ACTION. A parent moved to another school must not take its
--     children along (section 388 refuses any other action on a key that holds
--     a school).
--
-- Indexed ("teacherId", "schoolId") for the key's SET NULL when a person is
-- removed, and for the registerutdrag's read of a person's rows.
--
-- ## The rules per teacher: SQLSTATE FP409, REQUIREMENT_PLACEMENTS_DO_NOT_FIT
--
-- src/requirement-placements/placement-fit.ts (teacherFitOf) in the order it
-- applies them, the rule first in the message and in DETAIL
-- requirementId=<uuid> reason=<RULE>, never a person:
--
--   TEACHER         a förläggning names somebody with no lesson of the post, or
--                   anybody on a post that shares nothing (a NULL förläggning on
--                   a shared post is held to the lessons nobody teaches);
--   TEACHER_LENGTH  its teacher has lessons of the post, none of its length;
--   TEACHER_PAIRS   on an every-week post, one teacher's odd and even rows of
--                   a length do not pair: a pair is ONE lesson in two places,
--                   so it is one teacher's;
--   TEACHER_COUNT   more of a teacher's lessons of a length are placed than
--                   their part has (an odd and an even row are one lesson).
--
-- A teacher's part is lessonTeachersOf's: the huvudlärare takes every lesson
-- of a length that no share of that length takes, each share its lessons, and
-- a post with no huvudlärare or a removed teacher's share is lessons nobody
-- teaches (NULL), summed as every reader of shares sums them.
--
-- AND ONE RULE OF THE ROW BEING WRITTEN, in the first function, judged at once:
--
--   NO_TEACHER      a förläggning INSERTed on a shared post names nobody, or
--                   is UPDATEd to nobody while the teacher it named is still a
--                   person of the school. The second half is what lets a
--                   person's removal through: their key's SET NULL updates the
--                   row after the person is gone. A NULL förläggning on a
--                   shared post therefore exists only as what a removal left,
--                   and it stays, on the lessons nobody teaches, until the
--                   school chooses a teacher (the dialog asks for one).
--
-- WHY THE RULES PER TEACHER ARE DEFERRED. A writer of shares replaces them by
-- a DELETE and an INSERT (src/resources/requirement-shares.ts, in that order so
-- that the shares' own trigger TS409 meets a consistent pair at each
-- statement), and when Bo's share becomes Carl's the förläggning of Bo's
-- lesson follows in a third statement. Judged after each statement, the first
-- would leave Bo's förläggning without a share and refuse a change that ends
-- right. So these rules are CONSTRAINT TRIGGERS, DEFERRABLE INITIALLY
-- DEFERRED, and are judged on the post as the transaction leaves it: at its
-- COMMIT, or earlier when the writer asks with SET CONSTRAINTS. The gateway
-- asks, by these three names (never ALL: SS12000's flush is deferred too and
-- must stay at COMMIT), at the end of every write that changes a shared post's
-- teachers or its förläggningar (placement-teachers.ts), so that a refusal
-- reaches it as a statement it maps to a 409, and judges the same rules itself
-- before it writes, so that a refusal names the förläggning. Any other writer
-- meets them at its COMMIT. A person's removal sets three keys to NULL in one
-- statement (the post's, the share's, the förläggning's), in whatever order
-- the catalogue fires them, and is judged once all three have run.
--
--   TeachingRequirementPlacements_teachers_fit
--       INSERT, DELETE, UPDATE OF requirementId, teacherId, minutes,
--       recurrence. A DELETE (and the post a row is moved from) is judged for
--       TEACHER_PAIRS alone, and only for the removed row's teacher and length,
--       as 20270207090000 judges a removal for PAIRS alone: a removal can break
--       nothing else, and must not be refused for another row.
--   TeachingRequirementShares_placement_teachers_fit
--       INSERT, DELETE, UPDATE OF requirementId, teacherId, lessons, minutes:
--       every rule, on the post (and on the post a share is moved from).
--   TeachingRequirements_placement_teachers_fit
--       UPDATE OF teacherId, lessonsPerWeek, minutesPerLesson, lessonLengths,
--       recurrence, when one changed: who the huvudlärare is and how many of
--       each length are theirs.
--
-- The post's own rules (POST, BLOCK, LENGTH, WEEKS, PAIRS, COUNT) stay in the
-- first function and are judged after each statement, as before: none of them
-- reads a share, so a replacement of shares cannot meet them half done.
--
-- ONE WRITER OF A POST AT A TIME, as both functions before it: the post's row
-- FOR NO KEY UPDATE first, then the reads, in READ COMMITTED a new snapshot
-- after the lock. A share's DELETE takes no lock on its post by itself, and a
-- förläggning written at once in another transaction would be missing from an
-- unlocked read, so the deferred function locks the post before it asks
-- whether the post has förläggningar at all. REPEATABLE READ is refused
-- (ISOLATION), as everywhere the two migrations before this one judge.
--
-- ## Beside the live API: every lock at once, or none
--
-- The column, its key and the placements' triggers take
-- TeachingRequirementPlacements in ACCESS EXCLUSIVE; the trigger dropped from
-- TeachingRequirementShares takes that table in ACCESS EXCLUSIVE (DROP TRIGGER
-- does); the key takes Users, and the trigger created on it takes
-- TeachingRequirements, in SHARE ROW EXCLUSIVE (writes wait, reads do not).
-- Requests take these in every order, so all four are taken first, NOWAIT and
-- together, in a loop with a 30 s deadline: a refusal rolls back whatever the
-- attempt got and it tries again 50 ms later, so the migration never waits
-- while it holds a lock and no request queues behind it. After 30 s it stops
-- with nothing changed (prisma migrate resolve --rolled-back, then deploy).
--
-- BACKWARD COMPATIBLE FOR ONE RELEASE. The API before this one never names the
-- column, and every row it writes is NULL, on a post that shares nothing (its
-- own placement-fit refuses a shared post). Its writes of shares on a post with
-- förläggningar, which the dropped trigger refused at the INSERT (SHARES), are
-- refused at their COMMIT instead (TEACHER: the rows name nobody on a post
-- that now shares), which that API reports as an error rather than its 409,
-- for the minutes until the new API serves.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "TeachingRequirementPlacements" IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "TeachingRequirementShares" IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "TeachingRequirements" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Users" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'TeachingRequirementPlacements, TeachingRequirementShares, TeachingRequirements and Users were not free at once in 30 s: nothing is changed. Run prisma migrate resolve --rolled-back 20270208090000_forlagg_delade_lektioner, then deploy again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;

  -- The invariant 20270207090000 kept (SHARES): no post has both. Every row
  -- below is then a NULL on a post that shares nothing, which the new rules
  -- accept. Said by count, never by row.
  IF EXISTS (SELECT 1 FROM "TeachingRequirementPlacements" p
              WHERE EXISTS (SELECT 1 FROM "TeachingRequirementShares" s
                             WHERE s."requirementId" = p."requirementId" AND s."schoolId" = p."schoolId")) THEN
    RAISE EXCEPTION 'FORLAGG_DELADE: % timplansposter have both förläggningar and shares, which 20270207090000 refused; nothing is changed',
      (SELECT count(DISTINCT p."requirementId") FROM "TeachingRequirementPlacements" p
        WHERE EXISTS (SELECT 1 FROM "TeachingRequirementShares" s
                       WHERE s."requirementId" = p."requirementId" AND s."schoolId" = p."schoolId"));
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- The column and its key.
-- ---------------------------------------------------------------------------

ALTER TABLE "TeachingRequirementPlacements" ADD COLUMN "teacherId" UUID;

CREATE INDEX "TeachingRequirementPlacements_teacherId_schoolId_idx"
    ON "TeachingRequirementPlacements"("teacherId", "schoolId");

ALTER TABLE "TeachingRequirementPlacements"
    ADD CONSTRAINT "TeachingRequirementPlacements_teacherId_schoolId_fkey"
    FOREIGN KEY ("teacherId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE SET NULL ("teacherId") ON UPDATE NO ACTION;

COMMENT ON COLUMN "TeachingRequirementPlacements"."teacherId" IS
  'Delade lektioner: whose lesson it is on a post that shares its lessons (its huvudlärare or a share''s teacher, with a lesson of this length). NULL on a post that shares nothing (the post''s teacher is the lesson''s), and on a shared post once the teacher is removed.';

COMMENT ON TABLE "TeachingRequirementPlacements" IS
  'Förlagda poster: one of a timplanspost''s lessons that the school placed (day, start, length, room, weeks) before Generera, which sends it as a locked lesson and writes it into the grundschema marked MasterLessons.fromPlacement. The class, subject and co-teacher are the post''s; the teacher is the post''s, or on a post with delade lektioner the row''s own (teacherId).';

-- ---------------------------------------------------------------------------
-- The post's own rules, and the row being written: 20270207090000's function,
-- without SHARES and with NO_TEACHER.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.teaching_requirement_placements_fit()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  posts uuid[];
  schools uuid[];
  i integer;
  post_id uuid;
  school_id uuid;
  only_pairs boolean;
  left_minutes integer;
  post_moved boolean := false;
  -- The row being written names nobody where it may have to name somebody (NO_TEACHER).
  names_nobody boolean := false;
  post record;
  lengths int[];
  reason text;
  sentence text;
BEGIN
  -- Which posts this write puts in question, and in which school. Assignments in
  -- branches, not one CASE: PL/pgSQL resolves every field an expression names,
  -- and OLD or NEW of one table has no field of another's.
  only_pairs := false;
  IF TG_TABLE_NAME = 'TeachingRequirementPlacements' THEN
    IF TG_OP = 'DELETE' THEN
      posts := ARRAY[OLD."requirementId"];
      schools := ARRAY[OLD."schoolId"];
      only_pairs := true;
      left_minutes := OLD."minutes";
    ELSIF TG_OP = 'INSERT' THEN
      posts := ARRAY[NEW."requirementId"];
      schools := ARRAY[NEW."schoolId"];
      names_nobody := NEW."teacherId" IS NULL;
    ELSE
      posts := ARRAY[NEW."requirementId"];
      schools := ARRAY[NEW."schoolId"];
      -- Made nobody's by a writer: the teacher it named is still a person of
      -- the school. A person's removal clears the key after the person is
      -- gone, and is let through (see the preamble).
      names_nobody := NEW."teacherId" IS NULL AND OLD."teacherId" IS NOT NULL
                      AND EXISTS (SELECT 1 FROM "Users" u WHERE u."id" = OLD."teacherId");
      -- A row moved to another post: the post it left lost a row, and a row
      -- of a pair is the one thing that can break by that.
      IF (OLD."requirementId", OLD."schoolId") IS DISTINCT FROM (NEW."requirementId", NEW."schoolId") THEN
        posts := posts || OLD."requirementId";
        schools := schools || OLD."schoolId";
        left_minutes := OLD."minutes";
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'TeachingRequirements' THEN
    posts := ARRAY[NEW."id"];
    schools := ARRAY[NEW."schoolId"];
    post_moved := (OLD."studentGroupId", OLD."subjectId") IS DISTINCT FROM (NEW."studentGroupId", NEW."subjectId");
  ELSE
    RETURN NULL;
  END IF;

  -- See ONE WRITER OF A POST AT A TIME (20270207090000): the one level the
  -- lock below does not make the read safe in. On every write, because the
  -- "no rows" shortcut on the post's side reads the same stale snapshot.
  IF current_setting('transaction_isolation') = 'repeatable read' THEN
    RAISE EXCEPTION 'ISOLATION: förlagda lektioner och de postfält de prövas mot skrivs i READ COMMITTED eller SERIALIZABLE, inte i REPEATABLE READ'
      USING ERRCODE = 'FP409',
            DETAIL = format('requirementId=%s reason=ISOLATION', posts[1]);
  END IF;

  FOR i IN 1 .. cardinality(posts) LOOP
    post_id := posts[i];
    school_id := schools[i];
    -- The post a moved row left is judged for PAIRS alone, as a delete is.
    IF i > 1 THEN
      only_pairs := true;
    END IF;

    IF TG_TABLE_NAME = 'TeachingRequirements' THEN
      -- A post with no placement has nothing to fit, and is every post of every
      -- school until one writes a placement: no lock, one index probe. Safe
      -- unlocked, because this UPDATE holds the post's row, and a writer of a
      -- placement waits for it and then judges the post as it now is.
      IF NOT EXISTS (SELECT 1 FROM "TeachingRequirementPlacements" p
                      WHERE p."requirementId" = post_id AND p."schoolId" = school_id) THEN
        CONTINUE;
      END IF;
    END IF;

    SELECT r."lessonsPerWeek", r."minutesPerLesson", r."lessonLengths", r."recurrence", r."blockId"
      INTO post
      FROM "TeachingRequirements" r
     WHERE r."id" = post_id AND r."schoolId" = school_id
       FOR NO KEY UPDATE;
    -- The placement's foreign key answers a post that is not there (or is
    -- another school's), and a post removed in this statement takes its rows
    -- with it.
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    -- After the lock, a new snapshot in READ COMMITTED: the rows another writer
    -- committed while this one waited are seen.
    IF NOT EXISTS (SELECT 1 FROM "TeachingRequirementPlacements" p
                    WHERE p."requirementId" = post_id AND p."schoolId" = school_id) THEN
      CONTINUE;
    END IF;

    -- GREATEST: no writer stores a negative count, but array_fill would answer
    -- one with 54000 rather than the refusal below (no lessons: nothing fits).
    lengths := CASE WHEN cardinality(post."lessonLengths") = 0
                    THEN array_fill(post."minutesPerLesson", ARRAY[GREATEST(post."lessonsPerWeek", 0)])
                    ELSE post."lessonLengths" END;

    reason := NULL;
    IF only_pairs THEN
      -- Only the length the removed row had: a removal can unbalance that length's pairs and nothing else, and it must not
      -- be refused for a different length's rows that did not fit before it.
      IF post."recurrence" = 'ALL_WEEKS'
         AND EXISTS (SELECT 1 FROM "TeachingRequirementPlacements" p
                      WHERE p."requirementId" = post_id AND p."schoolId" = school_id AND p."minutes" = left_minutes
                      GROUP BY p."minutes"
                     HAVING count(*) FILTER (WHERE p."recurrence" = 'ODD_WEEKS')
                            <> count(*) FILTER (WHERE p."recurrence" = 'EVEN_WEEKS')) THEN
        reason := 'PAIRS';
      END IF;
    ELSIF post_moved THEN
      reason := 'POST';
    ELSIF post."blockId" IS NOT NULL THEN
      reason := 'BLOCK';
    ELSIF EXISTS (SELECT 1 FROM "TeachingRequirementPlacements" p
                   WHERE p."requirementId" = post_id AND p."schoolId" = school_id
                     AND NOT (p."minutes" = ANY (lengths))) THEN
      reason := 'LENGTH';
    ELSIF post."recurrence" <> 'ALL_WEEKS'
          AND EXISTS (SELECT 1 FROM "TeachingRequirementPlacements" p
                       WHERE p."requirementId" = post_id AND p."schoolId" = school_id
                         AND p."recurrence" <> post."recurrence") THEN
      reason := 'WEEKS';
    ELSIF post."recurrence" = 'ALL_WEEKS'
          AND EXISTS (SELECT 1 FROM "TeachingRequirementPlacements" p
                       WHERE p."requirementId" = post_id AND p."schoolId" = school_id
                       GROUP BY p."minutes"
                      HAVING count(*) FILTER (WHERE p."recurrence" = 'ODD_WEEKS')
                             <> count(*) FILTER (WHERE p."recurrence" = 'EVEN_WEEKS')) THEN
      reason := 'PAIRS';
    ELSIF EXISTS (
        -- The lessons a length has placed: a row of the post's own weeks is one
        -- lesson, and on an every-week post an odd and an even row of one length
        -- are one lesson together (PAIRS has made them equally many), so the
        -- even rows are not counted again.
        SELECT 1
          FROM (SELECT p."minutes",
                       count(*) - CASE WHEN post."recurrence" = 'ALL_WEEKS'
                                       THEN count(*) FILTER (WHERE p."recurrence" = 'EVEN_WEEKS')
                                       ELSE 0 END AS placed
                  FROM "TeachingRequirementPlacements" p
                 WHERE p."requirementId" = post_id AND p."schoolId" = school_id
                 GROUP BY p."minutes") t
         WHERE t.placed > (SELECT count(*) FROM unnest(lengths) l WHERE l = t."minutes")) THEN
      reason := 'COUNT';
    ELSIF names_nobody
          AND EXISTS (SELECT 1 FROM "TeachingRequirementShares" s
                       WHERE s."requirementId" = post_id AND s."schoolId" = school_id) THEN
      -- Delade lektioner: a lesson nobody teaches is not placed. The rules per
      -- teacher are the deferred function's (app.teaching_requirement_placement_teachers_fit).
      reason := 'NO_TEACHER';
    END IF;

    IF reason IS NOT NULL THEN
      sentence := CASE reason
        WHEN 'POST' THEN 'postens klass och ämne kan inte ändras medan den har förlagda lektioner'
        WHEN 'BLOCK' THEN 'en post i ett parallellt block kan inte ha förlagda lektioner'
        WHEN 'LENGTH' THEN 'en förlagd lektion har en längd som posten inte har'
        WHEN 'WEEKS' THEN 'en förlagd lektion går andra veckor än postens'
        WHEN 'PAIRS' THEN 'udda och jämna veckor av samma längd måste förläggas i par'
        WHEN 'NO_TEACHER' THEN 'en förlagd lektion på en post med delade lektioner anger sin lärare'
        ELSE 'fler lektioner av en längd är förlagda än posten har'
      END;
      RAISE EXCEPTION '%: %', reason, sentence
        USING ERRCODE = 'FP409',
              DETAIL = format('requirementId=%s reason=%s', post_id, reason);
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION app.teaching_requirement_placements_fit() IS
  'FP409 (REQUIREMENT_PLACEMENTS_DO_NOT_FIT): the placements of a timplanspost fit it (LENGTH, COUNT, WEEKS, PAIRS, BLOCK, POST), and one written on a post with delade lektioner names its teacher (NO_TEACHER). Judges the post''s whole set after the statement; locks the post row first. The rules per teacher are app.teaching_requirement_placement_teachers_fit''s.';

-- "teacherId" among the columns, for NO_TEACHER. A move to another day, time
-- or room still changes nothing the rules read.
DROP TRIGGER "TeachingRequirementPlacements_fit" ON "TeachingRequirementPlacements";
CREATE TRIGGER "TeachingRequirementPlacements_fit"
    AFTER INSERT OR DELETE OR UPDATE OF "requirementId", "teacherId", "minutes", "recurrence"
    ON "TeachingRequirementPlacements"
    FOR EACH ROW
    EXECUTE FUNCTION app.teaching_requirement_placements_fit();

-- Its only answer was SHARES, which is gone: a share's writes are the deferred
-- function's now.
DROP TRIGGER "TeachingRequirementShares_placements_fit" ON "TeachingRequirementShares";

-- ---------------------------------------------------------------------------
-- The rules per teacher, at the end of the transaction.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.teaching_requirement_placement_teachers_fit()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  posts uuid[];
  schools uuid[];
  i integer;
  post_id uuid;
  school_id uuid;
  -- A förläggning removed (or moved away): only its teacher's pairs of its length are judged.
  pairs_only boolean;
  left_teacher uuid;
  left_minutes integer;
  post record;
  lengths int[];
  reason text;
  sentence text;
BEGIN
  -- Which posts, as the first function says it: branches, because OLD and NEW
  -- of one table have no field of another's. Only the keys of OLD and NEW are
  -- read, and the removed row's teacher and length: a deferred trigger is
  -- handed the row as it was at the event, and the rules are asked of the post
  -- as it is now.
  IF TG_TABLE_NAME = 'TeachingRequirementPlacements' THEN
    IF TG_OP = 'DELETE' THEN
      posts := ARRAY[OLD."requirementId"];
      schools := ARRAY[OLD."schoolId"];
      left_teacher := OLD."teacherId";
      left_minutes := OLD."minutes";
    ELSE
      posts := ARRAY[NEW."requirementId"];
      schools := ARRAY[NEW."schoolId"];
      IF TG_OP = 'UPDATE'
         AND (OLD."requirementId", OLD."schoolId") IS DISTINCT FROM (NEW."requirementId", NEW."schoolId") THEN
        posts := posts || OLD."requirementId";
        schools := schools || OLD."schoolId";
        left_teacher := OLD."teacherId";
        left_minutes := OLD."minutes";
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'TeachingRequirementShares' THEN
    IF TG_OP = 'DELETE' THEN
      posts := ARRAY[OLD."requirementId"];
      schools := ARRAY[OLD."schoolId"];
    ELSE
      posts := ARRAY[NEW."requirementId"];
      schools := ARRAY[NEW."schoolId"];
      -- A share moved to another post took its lessons from the post it left.
      IF TG_OP = 'UPDATE'
         AND (OLD."requirementId", OLD."schoolId") IS DISTINCT FROM (NEW."requirementId", NEW."schoolId") THEN
        posts := posts || OLD."requirementId";
        schools := schools || OLD."schoolId";
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'TeachingRequirements' THEN
    posts := ARRAY[NEW."id"];
    schools := ARRAY[NEW."schoolId"];
  ELSE
    RETURN NULL;
  END IF;

  IF current_setting('transaction_isolation') = 'repeatable read' THEN
    RAISE EXCEPTION 'ISOLATION: förlagda lektioner, lärarandelar och de postfält de prövas mot skrivs i READ COMMITTED eller SERIALIZABLE, inte i REPEATABLE READ'
      USING ERRCODE = 'FP409',
            DETAIL = format('requirementId=%s reason=ISOLATION', posts[1]);
  END IF;

  FOR i IN 1 .. cardinality(posts) LOOP
    post_id := posts[i];
    school_id := schools[i];
    pairs_only := TG_TABLE_NAME = 'TeachingRequirementPlacements' AND (TG_OP = 'DELETE' OR i > 1);

    -- The post's row first, then every read (see ONE WRITER OF A POST AT A
    -- TIME in the preamble): a share's DELETE holds no lock on its post.
    SELECT r."lessonsPerWeek", r."minutesPerLesson", r."lessonLengths", r."recurrence", r."teacherId"
      INTO post
      FROM "TeachingRequirements" r
     WHERE r."id" = post_id AND r."schoolId" = school_id
       FOR NO KEY UPDATE;
    -- A post removed in this transaction took its rows with it.
    IF NOT FOUND THEN
      CONTINUE;
    END IF;
    -- A post with nothing placed has nothing to fit: every share and every
    -- change of every post of every school ends here until one is placed.
    IF NOT EXISTS (SELECT 1 FROM "TeachingRequirementPlacements" p
                    WHERE p."requirementId" = post_id AND p."schoolId" = school_id) THEN
      CONTINUE;
    END IF;

    reason := NULL;
    IF NOT EXISTS (SELECT 1 FROM "TeachingRequirementShares" s
                    WHERE s."requirementId" = post_id AND s."schoolId" = school_id) THEN
      -- A post that shares nothing: its teacher is every lesson's, and a row
      -- that names one is a share's förläggning left behind. A removal is
      -- never refused here.
      IF NOT pairs_only
         AND EXISTS (SELECT 1 FROM "TeachingRequirementPlacements" p
                      WHERE p."requirementId" = post_id AND p."schoolId" = school_id
                        AND p."teacherId" IS NOT NULL) THEN
        reason := 'TEACHER';
      END IF;
    ELSIF pairs_only THEN
      IF post."recurrence" = 'ALL_WEEKS'
         AND EXISTS (SELECT 1 FROM "TeachingRequirementPlacements" p
                      WHERE p."requirementId" = post_id AND p."schoolId" = school_id
                        AND p."teacherId" IS NOT DISTINCT FROM left_teacher AND p."minutes" = left_minutes
                     HAVING count(*) FILTER (WHERE p."recurrence" = 'ODD_WEEKS')
                            <> count(*) FILTER (WHERE p."recurrence" = 'EVEN_WEEKS')) THEN
        reason := 'TEACHER_PAIRS';
      END IF;
    ELSE
      lengths := CASE WHEN cardinality(post."lessonLengths") = 0
                      THEN array_fill(post."minutesPerLesson", ARRAY[GREATEST(post."lessonsPerWeek", 0)])
                      ELSE post."lessonLengths" END;
      WITH lens AS (
             SELECT l AS minutes, count(*)::integer AS n FROM unnest(lengths) l GROUP BY l),
           shared AS (
             SELECT s."teacherId" AS teacher, s."minutes", sum(s."lessons")::integer AS n
               FROM "TeachingRequirementShares" s
              WHERE s."requirementId" = post_id AND s."schoolId" = school_id
              GROUP BY s."teacherId", s."minutes"),
           -- Each teacher's lessons of each length: the huvudlärare's are the
           -- length's lessons no share takes. GROUP BY puts the NULLs (nobody's
           -- lessons: no huvudlärare, a removed teacher's share) together.
           part AS (
             SELECT x.teacher, x.minutes, sum(x.n)::integer AS n
               FROM (SELECT post."teacherId" AS teacher, lens.minutes,
                            lens.n - coalesce((SELECT sum(shared.n) FROM shared WHERE shared.minutes = lens.minutes), 0)::integer AS n
                       FROM lens
                     UNION ALL
                     SELECT shared.teacher, shared.minutes, shared.n FROM shared) x
              GROUP BY x.teacher, x.minutes
             HAVING sum(x.n) > 0),
           placed AS (
             SELECT p."teacherId" AS teacher, p."minutes",
                    count(*) AS rows,
                    count(*) FILTER (WHERE p."recurrence" = 'ODD_WEEKS') AS odd,
                    count(*) FILTER (WHERE p."recurrence" = 'EVEN_WEEKS') AS even
               FROM "TeachingRequirementPlacements" p
              WHERE p."requirementId" = post_id AND p."schoolId" = school_id
              GROUP BY p."teacherId", p."minutes")
      SELECT CASE
               WHEN EXISTS (SELECT 1 FROM placed
                             WHERE NOT EXISTS (SELECT 1 FROM part WHERE part.teacher IS NOT DISTINCT FROM placed.teacher))
                 THEN 'TEACHER'
               WHEN EXISTS (SELECT 1 FROM placed
                             WHERE NOT EXISTS (SELECT 1 FROM part WHERE part.teacher IS NOT DISTINCT FROM placed.teacher
                                                                     AND part.minutes = placed.minutes))
                 THEN 'TEACHER_LENGTH'
               WHEN post."recurrence" = 'ALL_WEEKS' AND EXISTS (SELECT 1 FROM placed WHERE placed.odd <> placed.even)
                 THEN 'TEACHER_PAIRS'
               -- A row of the post's own weeks is one lesson; on an every-week
               -- post an odd and an even row are one together (paired above).
               WHEN EXISTS (SELECT 1 FROM placed
                              JOIN part ON part.teacher IS NOT DISTINCT FROM placed.teacher AND part.minutes = placed.minutes
                             WHERE placed.rows - CASE WHEN post."recurrence" = 'ALL_WEEKS' THEN placed.even ELSE 0 END > part.n)
                 THEN 'TEACHER_COUNT'
             END
        INTO reason;
    END IF;

    IF reason IS NOT NULL THEN
      sentence := CASE reason
        WHEN 'TEACHER' THEN 'en förlagd lektion anger en lärare som inte har någon av postens lektioner'
        WHEN 'TEACHER_LENGTH' THEN 'en förlagd lektions lärare har ingen lektion av den längden på posten'
        WHEN 'TEACHER_PAIRS' THEN 'en lärares udda och jämna veckor av samma längd måste förläggas i par'
        ELSE 'fler av en lärares lektioner av en längd är förlagda än lärarens del har'
      END;
      RAISE EXCEPTION '%: %', reason, sentence
        USING ERRCODE = 'FP409',
              DETAIL = format('requirementId=%s reason=%s', post_id, reason);
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION app.teaching_requirement_placement_teachers_fit() IS
  'FP409 (REQUIREMENT_PLACEMENTS_DO_NOT_FIT): on a timplanspost with delade lektioner each förläggning is a lesson of its teacher (TEACHER, TEACHER_LENGTH, TEACHER_PAIRS, TEACHER_COUNT); on one without, none names a teacher (TEACHER). Deferred constraint triggers on the placements, the shares and the post; locks the post row first.';

CREATE CONSTRAINT TRIGGER "TeachingRequirementPlacements_teachers_fit"
    AFTER INSERT OR DELETE OR UPDATE OF "requirementId", "teacherId", "minutes", "recurrence"
    ON "TeachingRequirementPlacements"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION app.teaching_requirement_placement_teachers_fit();

CREATE CONSTRAINT TRIGGER "TeachingRequirementShares_placement_teachers_fit"
    AFTER INSERT OR DELETE OR UPDATE OF "requirementId", "teacherId", "lessons", "minutes"
    ON "TeachingRequirementShares"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION app.teaching_requirement_placement_teachers_fit();

CREATE CONSTRAINT TRIGGER "TeachingRequirements_placement_teachers_fit"
    AFTER UPDATE OF "teacherId", "lessonsPerWeek", "minutesPerLesson", "lessonLengths", "recurrence"
    ON "TeachingRequirements"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN ((OLD."teacherId", OLD."lessonsPerWeek", OLD."minutesPerLesson", OLD."lessonLengths", OLD."recurrence")
          IS DISTINCT FROM
          (NEW."teacherId", NEW."lessonsPerWeek", NEW."minutesPerLesson", NEW."lessonLengths", NEW."recurrence"))
    EXECUTE FUNCTION app.teaching_requirement_placement_teachers_fit();

-- ---------------------------------------------------------------------------
-- Nobody calls the new function but its triggers.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  r text;
BEGIN
  REVOKE ALL ON FUNCTION app.teaching_requirement_placement_teachers_fit() FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION app.teaching_requirement_placement_teachers_fit() FROM %I', r);
    END IF;
  END LOOP;
END
$$;
