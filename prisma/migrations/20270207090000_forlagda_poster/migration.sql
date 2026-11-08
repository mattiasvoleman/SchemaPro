-- Förlagda poster: a timplanspost can be given a day, a time and a room before
-- Generera sends it to the engine.
--
-- A schemaläggare knows some lessons cannot go anywhere else: the swimming hall
-- is booked on Tuesdays at 10:00, so idrott for 7A is there and then. Until
-- now the only way to say so was to generate a week, find the lesson wherever
-- the engine had put it, move it by hand and lock it, and then hope the next
-- Generera kept it. This migration is the place the school says it first.
--
-- ## What a förläggning is
--
-- One row of "TeachingRequirementPlacements" is one of a post's lessons at a
-- day, a start, a length that is one of the post's, a room and the weeks it
-- runs. The class, the subject and the teachers are the POST's and are read at
-- every Generera, so a teacher swapped on the post (the tillsättning and the
-- timplan do that in bulk) takes the förläggning with it and nothing here has
-- to follow. The room is NOT NULL: a placement without one is a lock the engine
-- would leave roomless, which is not what anyone asked for.
--
-- Generera sends each row as a locked lesson, takes it off the post's demand
-- the way a covering lock is taken off, and writes it into the grundschema as
-- a locked, generated lesson marked "MasterLessons"."fromPlacement". Locked, so
-- a swap, Optimera salar and drag-and-drop leave it; marked, so the next
-- Generera replaces it, and writes it again from the rows as they then stand.
--
-- ## The keys
--
--   * "schoolId" -> "Schools", CASCADE, as every table of a school.
--   * ("requirementId", "schoolId") -> "TeachingRequirements" ("id",
--     "schoolId"), ON DELETE CASCADE ON UPDATE NO ACTION. A post that goes
--     takes its placements with it. The key holds the school, so a row cannot
--     name another school's post (the sweep of 20270115090000, sections 330 and
--     388), and NO ACTION because a parent moved to another school would
--     otherwise take its children along.
--   * ("roomId", "schoolId") -> "Rooms" ("id", "schoolId"), ON DELETE NO
--     ACTION ON UPDATE NO ACTION. A room that a förläggning names is NOT
--     removed: SET NULL would leave a placement the engine would lock roomless,
--     and CASCADE would delete the school's decision without a word. The room's
--     removal is refused by name in the gateway (rooms.service.ts); this is
--     what stops any other writer. Both are checked at the end of the
--     statement, so a school removed in one statement (CASCADE from "Schools"
--     takes the placements and the rooms together) is not stopped by it.
--
-- ## The CHECKs
--
-- Each is named, because a name is what an error and a review point at.
--
--   * "dayOfWeek" 1..5: the engine's school week (SCHEDULE_DAYS). A lock outside
--     it reaches the engine as a window nothing meets, so it would block nothing
--     and still be written.
--   * "minutes" 15..240 on the five-minute grid: one lesson's bounds, as
--     "TeachingRequirementShares_minutes_is_sane" and the post's own.
--   * "startTime" on the five-minute grid: no seconds and a minute divisible by
--     five (the engine's slot).
--   * the lesson inside the engine's day, 08:00 to 18:00 (solver-grid.ts). Done
--     in seconds since midnight, not as "startTime + minutes": a time plus an
--     interval wraps past midnight, and 22:00 + 240 minutes is 02:00, which is
--     before 18:00.
--
-- ## The lesson written from a placement: a flag, not a key
--
-- "MasterLessons"."fromPlacement" boolean NOT NULL DEFAULT false is true on the
-- lessons Generera wrote from a förläggning, and every Generera replaces such a
-- lesson (PRESERVED_FROM_REGENERATION keeps a locked lesson only while the flag
-- is false). It is a flag and not a key to the row because the timplan's dialog
-- replaces a post's rows whole (deleteMany + createMany, new ids): a key to the
-- row broke at every edit, and the lesson it had named became an ordinary lock
-- that covered the lesson, so the next förläggning was refused as OVER_DEMAND.
-- With a flag, a placement edited or removed reaches the grundschema at the next
-- Generera, and the lesson is placed freely once nothing pins it. Nothing in the
-- grundschema moves until somebody generates.
--
-- The column is added with a constant default, which Postgres 11 and later
-- stores in the catalogue without rewriting the table; the old API does not name
-- it and every row it writes reads false. MasterLessons is granted by table
-- (SELECT, INSERT, UPDATE, DELETE to the API's role), so the column needs no
-- GRANT of its own, as "isGenerated" and "isLocked" have none.
--
-- ## The placements fit the post: SQLSTATE FP409, REQUIREMENT_PLACEMENTS_DO_NOT_FIT
--
-- The rules are src/requirement-placements/placement-fit.ts's, in the order it
-- applies them, and the message starts with the rule broken:
--
--   BLOCK   the post is in a parallel block (a placement of one member would be
--           a partly locked block, which Generera refuses);
--   SHARES  the post shares its lessons between teachers (which of them a
--           placement is has not been decided);
--   LENGTH  a row's length is not one of the post's;
--   WEEKS   on a post of odd or even weeks, a row runs other weeks than the
--           post's;
--   PAIRS   on an every-week post, odd and even rows of one length are not
--           equally many: the two are ONE lesson at two places ("odd weeks
--           Tuesday in the swimming hall, even weeks Thursday"), and a lone odd
--           row would leave the even weeks' lesson nowhere;
--   COUNT   more lessons of a length are placed than the post has;
--   POST    the post's class or subject is changed while it has rows;
--   ISOLATION  the write is in REPEATABLE READ (below).
--
-- THE SQLSTATE IS FP409 AND NOT TP409. The contract for this phase named TP409,
-- by analogy with TS409 (shares) and TB409 (blocks). TP409 is taken: the
-- decided-timplan triggers (20261006120000, 20261219090000) raise it, their
-- migration says "nothing else in this schema raises it", and
-- decidedTimplanRefusal (prisma-errors.ts) answers EVERY TP409 with
-- TIMPLAN_IS_DECIDED, first in the chain, so a placement that does not fit
-- would have been reported as a decided plan. FP409 is unused; the class FP
-- is not one PostgreSQL defines. DETAIL carries requirementId=<uuid>
-- reason=<RULE> and never a person.
--
-- ROW TRIGGERS THAT JUDGE THE POST'S WHOLE SET, NOT A STATEMENT TRIGGER WITH A
-- TRANSITION TABLE. The set is what fits or not (a pair is two rows), and the
-- gateway replaces it with deleteMany + createMany: the new set is one INSERT of
-- N rows. An AFTER ROW trigger is queued and fires when the statement has
-- finished, so by then every row of the statement is there, and it reads the
-- post's rows from the table. A pair written in one statement therefore
-- passes, and the same two rows in two statements do not: the first would be a
-- lone odd row (PAIRS). A transition table would say the same with more
-- machinery: it cannot name a column list, so an UPDATE trigger would fire for
-- every update of the table, and one trigger takes one event, so the table
-- would carry three of them; and the rules need the post's rows that are NOT in
-- the statement as well, which the transition table does not hold. The cost of
-- the row form is one evaluation per row of the statement (at most 80 rows
-- of one post, each a few index probes).
--
-- WHAT EACH WRITE IS JUDGED ON:
--   * a placement's INSERT or UPDATE: the post it names (and, if the row is
--     moved to another post, the post it left) against every rule but POST;
--   * a placement's DELETE, and the post a row left: PAIRS only, and only for the
--     length the removed row had. Removing a row can break nothing else, and a
--     removal must not be blocked by rows of another length that did not fit
--     before it;
--   * the post's UPDATE of lessonsPerWeek, minutesPerLesson, lessonLengths,
--     recurrence, blockId, studentGroupId or subjectId, when one changed: every
--     rule, POST first, only if the post has rows (one index probe otherwise,
--     as the shares trigger does);
--   * a share's INSERT, or UPDATE of its post: SHARES, when the post has rows.
-- A trigger is NOT DEFERRED: a refusal at COMMIT would reach the gateway as a
-- failed commit (a raw adapter error) instead of as the statement that caused
-- it.
--
-- ONE WRITER OF A POST AT A TIME, AS 20261205090000. Two transactions can each
-- add a placement and each find the other's missing, or one add a placement
-- while another adds a share, and both commit a set that does not fit. So the
-- function takes the post's row FOR NO KEY UPDATE first (not FOR UPDATE: the
-- placement's own key holds KEY SHARE on the same row, and the two do not
-- conflict) and only then reads the rows, in READ COMMITTED a new snapshot
-- taken after the lock. The post's UPDATE holds that lock already, so the
-- cheap "no rows" probe there is safe without it. SERIALIZABLE aborts one side
-- of the same cycle (40001). REPEATABLE READ cannot be made safe by a lock: the
-- read after it sees the transaction's first snapshot, so a write there is
-- refused outright (ISOLATION) rather than judged on a snapshot that may be
-- missing a concurrent row. Nothing in the gateway or the scripts writes in
-- REPEATABLE READ.
--
-- SECURITY DEFINER, owned by the migration owner, so the lock and the reads are
-- the post's whatever the caller may see; it reads the post named, its rows and
-- its shares, in the row's own school. A row that names a post of another school
-- finds no post here and is left to the key, which refuses it without
-- describing the other school's row.
--
-- ## Who may read and write
--
-- Through the gateway only, as the shares (20261205090000): the API role,
-- app_authenticated, holds SELECT, INSERT, UPDATE and DELETE; authenticated and
-- anon nothing; service_role SELECT and nothing more; no TRUNCATE, REFERENCES,
-- TRIGGER or, on Postgres 17, MAINTAIN. Every policy is TO app_authenticated.
--
--   teaching_requirement_placements_admin_select
--       the school's SCHOOL_ADMIN: every administrator reads, as the timplan
--       page does. NOT the school's teachers, which is where this departs from
--       the shares' staff read: nothing a teacher does reads a placement (the
--       lesson written from it is the teacher's to see in the timetable), and
--       a table nobody needs to read is one fewer thing a policy mistake can
--       expose.
--   teaching_requirement_placements_admin_insert / _update / _delete
--       the school's SCHOOL_ADMIN who writes PLANERING, as the post. The update
--       arm asks the area in WITH CHECK only, so a row lock for a read keeps
--       working for every administrator (RLS section 106 c). TABLE_WRITE_GATES
--       says the same.
--
-- FORCE ROW LEVEL SECURITY is off, as on every table of the schema: the
-- migration owner reads past the policies, and the definer triggers (here and
-- everywhere) rely on it.
--
-- ## Beside the live API: every lock at once, or none
--
-- Production runs this while the API before it serves requests. The new table's
-- keys take Schools, TeachingRequirements and Rooms in SHARE ROW EXCLUSIVE
-- (writes wait, reads do not); the two triggers take TeachingRequirements and
-- TeachingRequirementShares in the same mode; the new columns of MasterLessons
-- and PublishedLessons take ACCESS EXCLUSIVE. Requests take these
-- in every order, so a migration that waited for one while holding another
-- could close a cycle. So all six are taken first, NOWAIT and together: a
-- refusal rolls the subtransaction back and with it whatever it got, and it
-- tries again 50 ms later. It never waits while it holds a lock, and no request
-- queues behind it. After 30 s of refusals it stops with nothing done and can
-- be rerun (prisma migrate resolve --rolled-back, then deploy). lock_timeout
-- bounds any wait nobody foresaw.
--
-- BACKWARD COMPATIBLE FOR ONE RELEASE. A new table nobody writes yet, a
-- nullable column the old API does not name, and triggers that find no row and
-- let every write of the old API through.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Schools" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "TeachingRequirements" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "TeachingRequirementShares" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Rooms" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "MasterLessons" IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "PublishedLessons" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Schools, TeachingRequirements, TeachingRequirementShares, Rooms, MasterLessons and PublishedLessons were not free at once in 30 s: nothing is changed. Run prisma migrate resolve --rolled-back 20270207090000_forlagda_poster, then deploy again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- The table.
-- ---------------------------------------------------------------------------

CREATE TABLE "TeachingRequirementPlacements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "requirementId" UUID NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startTime" TIME(0) NOT NULL,
    "minutes" INTEGER NOT NULL,
    "roomId" UUID NOT NULL,
    "recurrence" "LessonRecurrence" NOT NULL DEFAULT 'ALL_WEEKS',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "TeachingRequirementPlacements_pkey" PRIMARY KEY ("id"),
    -- Monday to Friday: the engine's school week.
    CONSTRAINT "TeachingRequirementPlacements_dayOfWeek_is_a_school_day"
        CHECK ("dayOfWeek" BETWEEN 1 AND 5),
    -- One lesson's bounds and grid, as TeachingRequirementShares_minutes_is_sane.
    CONSTRAINT "TeachingRequirementPlacements_minutes_is_sane"
        CHECK ("minutes" BETWEEN 15 AND 240 AND "minutes" % 5 = 0),
    -- The engine's slot: no seconds, and a minute divisible by five.
    CONSTRAINT "TeachingRequirementPlacements_startTime_is_on_the_grid"
        CHECK (EXTRACT(SECOND FROM "startTime") = 0 AND EXTRACT(MINUTE FROM "startTime")::integer % 5 = 0),
    -- Inside the engine's day, 08:00 to 18:00. Seconds since midnight, because a
    -- time plus an interval wraps (22:00 + 240 minutes is 02:00).
    CONSTRAINT "TeachingRequirementPlacements_inside_the_school_day"
        CHECK (EXTRACT(EPOCH FROM "startTime") >= 8 * 3600
               AND EXTRACT(EPOCH FROM "startTime") + "minutes" * 60 <= 18 * 3600)
);

-- The (id, schoolId) target every school-bound table offers a key to. Nothing
-- points at a placement today (the lessons carry a flag), and the Prisma schema
-- states it, so it is kept.
CREATE UNIQUE INDEX "TeachingRequirementPlacements_id_schoolId_key"
    ON "TeachingRequirementPlacements"("id", "schoolId");
-- A post's rows: the trigger's read, the post's CASCADE and the gateway's.
CREATE INDEX "TeachingRequirementPlacements_requirementId_idx"
    ON "TeachingRequirementPlacements"("requirementId");
-- A room's rows: the NO ACTION check when a room is removed, and the refusal
-- by name that comes before it.
CREATE INDEX "TeachingRequirementPlacements_roomId_schoolId_idx"
    ON "TeachingRequirementPlacements"("roomId", "schoolId");
CREATE INDEX "TeachingRequirementPlacements_schoolId_idx"
    ON "TeachingRequirementPlacements"("schoolId");

ALTER TABLE "TeachingRequirementPlacements"
    ADD CONSTRAINT "TeachingRequirementPlacements_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeachingRequirementPlacements"
    ADD CONSTRAINT "TeachingRequirementPlacements_requirementId_schoolId_fkey"
    FOREIGN KEY ("requirementId", "schoolId") REFERENCES "TeachingRequirements"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "TeachingRequirementPlacements"
    ADD CONSTRAINT "TeachingRequirementPlacements_roomId_schoolId_fkey"
    FOREIGN KEY ("roomId", "schoolId") REFERENCES "Rooms"("id", "schoolId")
    ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMENT ON TABLE "TeachingRequirementPlacements" IS
  'Förlagda poster: one of a timplanspost''s lessons that the school placed (day, start, length, room, weeks) before Generera, which sends it as a locked lesson and writes it into the grundschema marked MasterLessons.fromPlacement. The class, subject and teachers are the post''s.';

-- ---------------------------------------------------------------------------
-- The lessons Generera wrote from a placement.
-- ---------------------------------------------------------------------------

ALTER TABLE "MasterLessons" ADD COLUMN "fromPlacement" BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN "MasterLessons"."fromPlacement" IS
  'True on a lesson Generera wrote from a förläggning (TeachingRequirementPlacements); locked and generated both. Every Generera replaces such a lesson. A flag and not a key: the timplan replaces a post''s rows whole, with new ids.';

-- And on the grundschema a DRAFT publication published, which discarding the
-- draft writes back: without it a placed lesson came back as an ordinary lock
-- beside its förläggning, and every Generera of the school was refused for a
-- clash with itself (review of #293, MEDEL-2). A constant default, so the
-- table is not rewritten; granted by table like its other columns.
ALTER TABLE "PublishedLessons" ADD COLUMN "fromPlacement" BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN "PublishedLessons"."fromPlacement" IS
  'The published lesson''s MasterLessons.fromPlacement, written back when a draft is discarded.';

-- ---------------------------------------------------------------------------
-- The placements fit the post.
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
    ELSE
      posts := ARRAY[NEW."requirementId"];
      schools := ARRAY[NEW."schoolId"];
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
    posts := ARRAY[NEW."requirementId"];
    schools := ARRAY[NEW."schoolId"];
  END IF;

  -- See ONE WRITER OF A POST AT A TIME: the one level the lock below does not
  -- make the read safe in. On every write, because the "no rows" shortcut on
  -- the post's side reads the same stale snapshot.
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
    IF TG_TABLE_NAME = 'TeachingRequirementShares' THEN
      -- A share was written for a post that has rows. Nothing else changed.
      reason := 'SHARES';
    ELSIF only_pairs THEN
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
    ELSIF EXISTS (SELECT 1 FROM "TeachingRequirementShares" s
                   WHERE s."requirementId" = post_id AND s."schoolId" = school_id) THEN
      reason := 'SHARES';
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
    END IF;

    IF reason IS NOT NULL THEN
      sentence := CASE reason
        WHEN 'POST' THEN 'postens klass och ämne kan inte ändras medan den har förlagda lektioner'
        WHEN 'BLOCK' THEN 'en post i ett parallellt block kan inte ha förlagda lektioner'
        WHEN 'SHARES' THEN 'en post med delade lektioner kan inte ha förlagda lektioner'
        WHEN 'LENGTH' THEN 'en förlagd lektion har en längd som posten inte har'
        WHEN 'WEEKS' THEN 'en förlagd lektion går andra veckor än postens'
        WHEN 'PAIRS' THEN 'udda och jämna veckor av samma längd måste förläggas i par'
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
  'FP409 (REQUIREMENT_PLACEMENTS_DO_NOT_FIT): the placements of a timplanspost fit it (LENGTH, COUNT, WEEKS, PAIRS, BLOCK, SHARES, POST). Judges the post''s whole set after the statement; locks the post row first.';

-- The placements' own writes. Not UPDATE of every column: a move to another day,
-- time or room changes nothing the rules read.
CREATE TRIGGER "TeachingRequirementPlacements_fit"
    AFTER INSERT OR DELETE OR UPDATE OF "requirementId", "minutes", "recurrence"
    ON "TeachingRequirementPlacements"
    FOR EACH ROW
    EXECUTE FUNCTION app.teaching_requirement_placements_fit();

-- The post's change, when one of the seven columns the rules read changed.
CREATE TRIGGER "TeachingRequirements_placements_fit"
    AFTER UPDATE OF "lessonsPerWeek", "minutesPerLesson", "lessonLengths", "recurrence", "blockId",
                    "studentGroupId", "subjectId"
    ON "TeachingRequirements"
    FOR EACH ROW
    WHEN ((OLD."lessonsPerWeek", OLD."minutesPerLesson", OLD."lessonLengths", OLD."recurrence", OLD."blockId",
           OLD."studentGroupId", OLD."subjectId")
          IS DISTINCT FROM
          (NEW."lessonsPerWeek", NEW."minutesPerLesson", NEW."lessonLengths", NEW."recurrence", NEW."blockId",
           NEW."studentGroupId", NEW."subjectId"))
    EXECUTE FUNCTION app.teaching_requirement_placements_fit();

-- A share written for a post that has rows. An UPDATE only matters when it
-- moves the share to another post; a share's lessons, length or teacher change
-- nothing about which post it burdens.
CREATE TRIGGER "TeachingRequirementShares_placements_fit"
    AFTER INSERT OR UPDATE OF "requirementId"
    ON "TeachingRequirementShares"
    FOR EACH ROW
    EXECUTE FUNCTION app.teaching_requirement_placements_fit();

-- ---------------------------------------------------------------------------
-- Row-level security and grants. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "TeachingRequirementPlacements" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    CREATE POLICY "teaching_requirement_placements_admin_select" ON "TeachingRequirementPlacements"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "teaching_requirement_placements_admin_insert" ON "TeachingRequirementPlacements"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('PLANERING', true)));
    CREATE POLICY "teaching_requirement_placements_admin_update" ON "TeachingRequirementPlacements"
        FOR UPDATE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('PLANERING', true)));
    CREATE POLICY "teaching_requirement_placements_admin_delete" ON "TeachingRequirementPlacements"
        FOR DELETE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
               AND (select app.current_user_may('PLANERING', true)));
    REVOKE ALL ON "TeachingRequirementPlacements" FROM "app_authenticated";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "TeachingRequirementPlacements" TO "app_authenticated";
  END IF;
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "TeachingRequirementPlacements" FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "TeachingRequirementPlacements" FROM "service_role";
  END IF;
  -- PostgreSQL 17's MAINTAIN (REINDEX, CLUSTER, VACUUM, LOCK): the owner's alone.
  IF current_setting('server_version_num')::int >= 170000 THEN
    FOREACH r IN ARRAY ARRAY['authenticated', 'app_authenticated', 'service_role', 'anon'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE MAINTAIN ON "TeachingRequirementPlacements" FROM %I', r);
      END IF;
    END LOOP;
  END IF;

  REVOKE ALL ON FUNCTION app.teaching_requirement_placements_fit() FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION app.teaching_requirement_placements_fit() FROM %I', r);
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- PLACEMENTS_REACH: the four arms above and no other; none for a PostgREST
-- role, the service or the sync principal.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  bad text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    RETURN;
  END IF;
  SELECT string_agg(p.policyname || ' ' || p.cmd || ' ' || p.roles::text, ', ' ORDER BY p.policyname) INTO bad
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = 'TeachingRequirementPlacements'
     AND NOT (p.roles = '{app_authenticated}'::name[]
              AND p.policyname = 'teaching_requirement_placements_'
                                 || CASE p.cmd WHEN 'SELECT' THEN 'admin_select'
                                               WHEN 'INSERT' THEN 'admin_insert'
                                               WHEN 'UPDATE' THEN 'admin_update'
                                               WHEN 'DELETE' THEN 'admin_delete'
                                               ELSE 'an arm for every command' END
              AND (p.cmd = 'SELECT' OR coalesce(p.with_check, p.qual) LIKE '%current_user_may(''PLANERING''%'));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'PLACEMENTS_REACH: these arms reach TeachingRequirementPlacements beyond the administrators'' read and the planner''s writes: %', bad;
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'TeachingRequirementPlacements') <> 4 THEN
    RAISE EXCEPTION 'PLACEMENTS_REACH: TeachingRequirementPlacements has % arms, not the four above',
      (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'TeachingRequirementPlacements');
  END IF;
END
$$;
