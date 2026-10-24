-- En timplanspost delar sina lektioner mellan lärare.
--
-- A school fills its teachers' tjänster to the minute, and a post of three
-- lessons a week rarely lands whole on one teacher: Anna takes two of 9A's
-- three matematik and Bo the third, because Bo's post has room for exactly one
-- more lesson and Anna's for two. Today the post names one teacher who takes
-- every lesson, and a medlärare who is in the room for every lesson as well
-- (co-teaching). Neither says "two of the three are Anna's". The user's
-- addition to round 5 (2026-10-24) is that: DELADE LEKTIONER, each lesson of
-- the post has one teacher, each teacher has only their own lessons in the
-- timetable, and each tjänst is charged the minutes its teacher actually has.
--
-- ## The change
--
--   * "TeachingRequirementShares": the lessons of a post one teacher other
--     than its own takes, by length — "Bo: 1 × 60". The post's teacherId stays
--     its huvudlärare, who takes every lesson no share takes. A post with no
--     share is the post it always was, and every reader of teacherId keeps
--     seeing a teacher who really does teach some of its lessons.
--   * A unique index on TeachingRequirements ("id", "schoolId"): the target
--     the shares' composite key needs, for the reason every reference from
--     TeachingRequirements carries schoolId (20260822130000).
--
-- ## What a share is
--
-- `lessons` lessons of `minutes` each, taught by `teacherId`. The length is
-- one of the post's own lengths (its lessonLengths, or minutesPerLesson on a
-- uniform post): on idrott 1 × 80 + 1 × 40, Bo may take "1 × 40", and then the
-- load he is charged is exact and the generator knows which lesson is his. The
-- lessons of one length are interchangeable, so a count per length is all
-- there is to say. Integers, so every lesson has one teacher: a share is never
-- "half of a lesson". The share of the minutes a teacher has follows from the
-- counts, and that is what the dialog shows as their faktor.
--
-- ## The shares fit the post: SQLSTATE TS409, REQUIREMENT_SHARES_DO_NOT_FIT
--
-- Four rules, judged on the post as it stands after each statement:
--
--   (a) every share's length is one of the post's lengths;
--   (b) per length, the shares take no more lessons than the post has of it;
--   (c) the shares take at most lessonsPerWeek − 1: the huvudlärare keeps at
--       least one lesson, so a post of one lesson cannot be shared and a post
--       whose shares took everything would name a lead who teaches nothing;
--   (d) no share's teacher is the post's huvudlärare or medlärare. One person
--       twice on a post is SAME_TEACHER_TWICE's reason again: every reader
--       counts a person once per role.
--
-- The huvudlärare may be NULL. Then the lessons the shares leave are the
-- post's unstaffed ones, which is how a post with no teacher has always read.
--
-- A refusal is SQLSTATE TS409, a class Postgres does not define, mapped by the
-- gateway to the 409 REQUIREMENT_SHARES_DO_NOT_FIT whatever service wrote: the
-- requirements PATCH, the import, the rollover. The gateway judges the same
-- rules first and names the one broken; the trigger is what a write through
-- any other path meets.
--
-- AN AFTER ROW TRIGGER ON BOTH TABLES, NOT DEFERRED, as TB409: on the shares'
-- INSERT and UPDATE, and on the post's UPDATE of the five columns the rules
-- read, only when one of them changed. The gateway writes a post and its
-- shares in that order — old shares deleted, the post updated, the new shares
-- inserted — so each statement meets a consistent pair. Not deferred to
-- COMMIT, where its refusal would reach the gateway as a failed commit rather
-- than as the statement that caused it.
--
-- ONE WRITER OF A POST'S SHARES AT A TIME. Two transactions can each add a
-- share and each find the other's missing, both pass, and both commit more
-- lessons than the post has. So the function first takes the post's row FOR
-- NO KEY UPDATE, held until COMMIT, and only then reads the shares: in READ
-- COMMITTED that read is a new snapshot, taken after the lock. FOR NO KEY
-- UPDATE and not FOR UPDATE, because the share's own foreign key holds KEY
-- SHARE on the same row and the two do not conflict. SECURITY DEFINER, owned
-- by the migration owner, so the lock and the read are the post's whatever the
-- caller may see; it reads only the post named and its shares, in the row's
-- own school.
--
-- ## A teacher who is removed leaves their lessons without one
--
-- ON DELETE SET NULL ("teacherId"), as the post's own teacher key: deleting a
-- user leaves their share standing with no teacher, which the gateway reads as
-- that many unstaffed lessons. Cascading the share away would hand its lessons
-- to the huvudlärare in silence — a heavier tjänst nobody wrote, past every
-- staffing check. The unique key (requirementId, teacherId, minutes) is NULLS
-- DISTINCT on purpose: two deleted teachers leave two teacherless shares, and
-- a user's deletion must not fail on a unique key. Readers sum them.
--
-- ## Who may read and write
--
-- Through the gateway only, as Sites (20261124090000): the API role,
-- app_authenticated, holds SELECT, INSERT, UPDATE and DELETE; authenticated and
-- anon nothing; service_role SELECT and nothing more; no TRUNCATE, REFERENCES,
-- TRIGGER or, on Postgres 17, MAINTAIN.
--
--   teaching_requirement_shares_staff_select
--       the school's SCHOOL_ADMIN and TEACHER, as TeachingRequirements
--       (teaching_requirements_staff_select): a post's teachers are read by
--       every member of staff, and a teacher's Min tjänst counts their own.
--   teaching_requirement_shares_admin_insert / _update / _delete
--       the school's SCHOOL_ADMIN who writes PLANERING, as the post; the
--       update arm asks it in WITH CHECK only, so a row lock for a read keeps
--       working for every administrator (RLS section 106 c). TABLE_WRITE_GATES
--       says the same, and section 116 runs every profile against the table.
--
-- The SS12000 providers emit nothing new: an Activity is a MasterLesson and
-- names the lesson's own teachers, which the generator now writes per lesson.
--
-- ## Beside the live API: every lock at once, or none
--
-- Production runs this while the API before it serves requests. The index and
-- the trigger take TeachingRequirements in SHARE ROW EXCLUSIVE (writes wait,
-- reads do not); the new table's keys take Users, Schools and
-- TeachingRequirements in SHARE ROW EXCLUSIVE. Requests take them in every
-- order — a post written and then its teacher's row, a user saved and then
-- the posts read — so a migration that waited for one while holding another
-- could close a cycle. So all three are taken first, NOWAIT and together: a
-- refusal rolls the subtransaction back and with it whatever it got, and it
-- tries again 50 ms later. It never waits while it holds a lock, and no request
-- queues behind it. After 30 s of refusals it stops with nothing done and can
-- be rerun (prisma migrate resolve --rolled-back, then deploy). lock_timeout
-- bounds any wait nobody foresaw.
--
-- BACKWARD COMPATIBLE FOR ONE RELEASE. An empty table nobody writes yet, an
-- index on a key that is already unique, and a trigger that finds no share and
-- lets every write of main's API through.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Schools" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Users" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "TeachingRequirements" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Schools, Users and TeachingRequirements were not free at once in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- The post's composite target. "id" is the primary key, so the index holds
-- whatever rows exist, and it is built here under the locks above rather
-- than CONCURRENTLY in a file of its own: the table is small, and the build
-- is all the time those locks are held. Measured on PostgreSQL 17 with the
-- table filled to 10,000, 100,000 and 500,000 posts (3.6, 34 and 168 MB with
-- its indexes): the index alone took 12, 28 and 317 ms, and the whole of this
-- file held its three locks 45, 44 and 505 ms (182 ms on a second run at
-- 500,000). A write to TeachingRequirements or Users asked meanwhile waits
-- that long and no longer, 85 and 71 ms in that run; a read does not wait.
-- A school has some hundreds of posts a läsår.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX "TeachingRequirements_id_schoolId_key"
    ON "TeachingRequirements"("id", "schoolId");

-- ---------------------------------------------------------------------------
-- The table.
-- ---------------------------------------------------------------------------

CREATE TABLE "TeachingRequirementShares" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "requirementId" UUID NOT NULL,
    "teacherId" UUID,
    "lessons" INTEGER NOT NULL,
    "minutes" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "TeachingRequirementShares_pkey" PRIMARY KEY ("id"),
    -- The DTO's bounds. At most 39: the post's own @Max(40), less the one
    -- lesson its huvudlärare keeps.
    CONSTRAINT "TeachingRequirementShares_lessons_is_sane"
        CHECK ("lessons" BETWEEN 1 AND 39),
    -- One lesson's bounds and grid, as TeachingRequirements_lesson_lengths_are_canonical.
    CONSTRAINT "TeachingRequirementShares_minutes_is_sane"
        CHECK ("minutes" BETWEEN 15 AND 240 AND "minutes" % 5 = 0)
);

-- One row per teacher and length; the post's key leads, so it is also the
-- index the post's foreign key and the trigger's read scan. NULLS DISTINCT:
-- see the preamble.
CREATE UNIQUE INDEX "TeachingRequirementShares_requirementId_teacherId_minutes_key"
    ON "TeachingRequirementShares"("requirementId", "teacherId", "minutes");
-- A teacher's shares: the load report's read, and the key's SET NULL.
CREATE INDEX "TeachingRequirementShares_teacherId_idx" ON "TeachingRequirementShares"("teacherId");
CREATE INDEX "TeachingRequirementShares_schoolId_idx" ON "TeachingRequirementShares"("schoolId");

ALTER TABLE "TeachingRequirementShares"
    ADD CONSTRAINT "TeachingRequirementShares_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeachingRequirementShares"
    ADD CONSTRAINT "TeachingRequirementShares_requirementId_schoolId_fkey"
    FOREIGN KEY ("requirementId", "schoolId") REFERENCES "TeachingRequirements"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeachingRequirementShares"
    ADD CONSTRAINT "TeachingRequirementShares_teacherId_schoolId_fkey"
    FOREIGN KEY ("teacherId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON UPDATE CASCADE ON DELETE SET NULL ("teacherId");

-- ---------------------------------------------------------------------------
-- The shares fit the post.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.teaching_requirement_shares_fit()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  post_id uuid;
  post record;
  lengths int[];
  reason text;
BEGIN
  IF TG_TABLE_NAME = 'TeachingRequirementShares' THEN
    post_id := NEW."requirementId";
  ELSE
    post_id := NEW."id";
    -- A post with no share has nothing to fit, and is every post of every
    -- school until one writes a share: no lock, one index probe.
    IF NOT EXISTS (SELECT 1 FROM "TeachingRequirementShares" s
                    WHERE s."requirementId" = post_id AND s."schoolId" = NEW."schoolId") THEN
      RETURN NULL;
    END IF;
  END IF;

  SELECT r."lessonsPerWeek", r."minutesPerLesson", r."lessonLengths", r."teacherId", r."coTeacherId"
    INTO post
    FROM "TeachingRequirements" r
   WHERE r."id" = post_id AND r."schoolId" = NEW."schoolId"
     FOR NO KEY UPDATE;
  -- The share's foreign key answers a post that is not there.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  lengths := CASE WHEN cardinality(post."lessonLengths") = 0
                  THEN array_fill(post."minutesPerLesson", ARRAY[post."lessonsPerWeek"])
                  ELSE post."lessonLengths" END;

  IF EXISTS (SELECT 1 FROM "TeachingRequirementShares" s
              WHERE s."requirementId" = post_id
                AND s."teacherId" IS NOT NULL
                AND (s."teacherId" = post."teacherId" OR s."teacherId" = post."coTeacherId")) THEN
    reason := 'TEACHER_ON_POST';
  ELSIF EXISTS (SELECT 1 FROM "TeachingRequirementShares" s
                 WHERE s."requirementId" = post_id AND NOT (s."minutes" = ANY (lengths))) THEN
    reason := 'LENGTH_NOT_ON_POST';
  ELSIF EXISTS (SELECT 1
                  FROM (SELECT s."minutes", sum(s."lessons") AS taken
                          FROM "TeachingRequirementShares" s
                         WHERE s."requirementId" = post_id
                         GROUP BY s."minutes") t
                 WHERE t.taken > (SELECT count(*) FROM unnest(lengths) l WHERE l = t."minutes")) THEN
    reason := 'TOO_MANY_OF_LENGTH';
  ELSIF (SELECT coalesce(sum(s."lessons"), 0) FROM "TeachingRequirementShares" s
          WHERE s."requirementId" = post_id) > post."lessonsPerWeek" - 1 THEN
    reason := 'LEAD_KEEPS_NONE';
  END IF;

  IF reason IS NOT NULL THEN
    RAISE EXCEPTION 'REQUIREMENT_SHARES_DO_NOT_FIT: timplanspostens lärarandelar ryms inte i dess lektioner (%)', reason
      USING ERRCODE = 'TS409',
            DETAIL = format('requirementId=%s reason=%s', post_id, reason);
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION app.teaching_requirement_shares_fit() IS
  'TS409 REQUIREMENT_SHARES_DO_NOT_FIT: a timplanspost''s shares take lengths it has, no more of each than it has, leave its huvudlärare a lesson, and name neither of its own teachers. Locks the post row first.';

CREATE TRIGGER "TeachingRequirementShares_fit"
    AFTER INSERT OR UPDATE OF "requirementId", "teacherId", "lessons", "minutes"
    ON "TeachingRequirementShares"
    FOR EACH ROW
    EXECUTE FUNCTION app.teaching_requirement_shares_fit();

CREATE TRIGGER "TeachingRequirements_shares_fit"
    AFTER UPDATE OF "lessonsPerWeek", "minutesPerLesson", "lessonLengths", "teacherId", "coTeacherId"
    ON "TeachingRequirements"
    FOR EACH ROW
    WHEN ((OLD."lessonsPerWeek", OLD."minutesPerLesson", OLD."lessonLengths", OLD."teacherId", OLD."coTeacherId")
          IS DISTINCT FROM
          (NEW."lessonsPerWeek", NEW."minutesPerLesson", NEW."lessonLengths", NEW."teacherId", NEW."coTeacherId"))
    EXECUTE FUNCTION app.teaching_requirement_shares_fit();

-- ---------------------------------------------------------------------------
-- Row-level security and grants. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "TeachingRequirementShares" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    CREATE POLICY "teaching_requirement_shares_staff_select" ON "TeachingRequirementShares"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) IN ('SCHOOL_ADMIN', 'TEACHER'));
    CREATE POLICY "teaching_requirement_shares_admin_insert" ON "TeachingRequirementShares"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('PLANERING', true)));
    CREATE POLICY "teaching_requirement_shares_admin_update" ON "TeachingRequirementShares"
        FOR UPDATE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('PLANERING', true)));
    CREATE POLICY "teaching_requirement_shares_admin_delete" ON "TeachingRequirementShares"
        FOR DELETE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
               AND (select app.current_user_may('PLANERING', true)));
    REVOKE ALL ON "TeachingRequirementShares" FROM "app_authenticated";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "TeachingRequirementShares" TO "app_authenticated";
  END IF;
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "TeachingRequirementShares" FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "TeachingRequirementShares" FROM "service_role";
  END IF;
  -- PostgreSQL 17's MAINTAIN (REINDEX, CLUSTER, VACUUM, LOCK): the owner's alone.
  IF current_setting('server_version_num')::int >= 170000 THEN
    FOREACH r IN ARRAY ARRAY['authenticated', 'app_authenticated', 'service_role', 'anon'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE MAINTAIN ON "TeachingRequirementShares" FROM %I', r);
      END IF;
    END LOOP;
  END IF;

  REVOKE ALL ON FUNCTION app.teaching_requirement_shares_fit() FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION app.teaching_requirement_shares_fit() FROM %I', r);
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- SHARES_REACH: the four arms above and no other; none for a PostgREST role,
-- the service or the sync principal.
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
   WHERE p.schemaname = 'public' AND p.tablename = 'TeachingRequirementShares'
     AND NOT (p.roles = '{app_authenticated}'::name[]
              AND p.policyname = 'teaching_requirement_shares_'
                                 || CASE p.cmd WHEN 'SELECT' THEN 'staff_select'
                                               WHEN 'INSERT' THEN 'admin_insert'
                                               WHEN 'UPDATE' THEN 'admin_update'
                                               WHEN 'DELETE' THEN 'admin_delete'
                                               ELSE 'an arm for every command' END
              AND (p.cmd = 'SELECT' OR coalesce(p.with_check, p.qual) LIKE '%current_user_may(''PLANERING''%'));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'SHARES_REACH: these arms reach TeachingRequirementShares beyond the staff read and the planner''s writes: %', bad;
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'TeachingRequirementShares') <> 4 THEN
    RAISE EXCEPTION 'SHARES_REACH: TeachingRequirementShares has % arms, not the four above',
      (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'TeachingRequirementShares');
  END IF;
END
$$;
