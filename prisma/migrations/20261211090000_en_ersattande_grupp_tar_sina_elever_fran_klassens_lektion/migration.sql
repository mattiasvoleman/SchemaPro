-- En ersättande grupp tar sina elever från klassens lektion.
--
-- Ersättande grupper (omgång 6): SvA beside class svenska. A pupil in SvA7
-- goes to SvA instead of 7A's svenska, and 7A's svenska does not list them.
-- The user decided it on 2026-10-25: a replacing group REPLACES the class's
-- lesson for its pupils; it is not a parallel block.
--
-- ## The rule, once
--
-- A pupil is NOT on a lesson when they are not named on it and they are a
-- member of a replacing group R with R."replacesSubjectId" = the lesson's
-- subject, and R is not one of the lesson's groups (its own group or an extra
-- one). Otherwise today's rule decides (the home class, the teaching groups,
-- the named pupils). The gateway's copy is src/common/replacing-groups.ts,
-- the web's web/lib/replacing-groups.ts; this migration states it three times
-- in SQL, for the three readers that read neither:
--
--   * app.current_student_replaced_lesson_ids(), for the pupil's own week;
--   * app.calendar_feed_pupil_lessons, for the pupil's and the guardian's
--     calendar feeds;
--   * (the gateway's family-schedule.service.ts states it in TS, and needs
--     the guardian arm below to read the child's replacing groups.)
--
-- An extra group (CalendarLessonGroups, #193) puts its pupils ON a lesson; a
-- replacing group takes its pupils OFF its subject's other lessons, whichever
-- way they reach them: the home class, a half, a nivågrupp in the subject.
-- The two combine: SvA7 added to 7B's svenska puts SvA7's pupils on that one
-- lesson, because SvA7 is then one of its groups. A named pupil always stays.
--
-- ## StudentGroups."replacesSubjectId"
--
--   * UUID NULL. Null, every group's value here and until an administrator
--     says otherwise, replaces nothing.
--   * FK ("replacesSubjectId", "schoolId") -> Subjects ("id", "schoolId"),
--     ON DELETE SET NULL ("replacesSubjectId"): a subject of the group's own
--     school, and deleting the subject ends the replacement and keeps the
--     group (the "predecessorId" pattern).
--   * CHECK: only a TEACHING_GROUP that is not a half replaces. A class is
--     its pupils' home, and a half is a part of the class. Validated: every
--     row is NULL.
--   * No date. StudentGroupMembers carries none, so a pupil who joins SvA7 in
--     October "did not attend" class svenska in September in every reader,
--     as with every teaching group.
--   * No index. The foreign key's SET NULL scans StudentGroups, a table of a
--     few hundred rows per school; the readers ask by schoolId.
--
-- Its privileges are the table's: the administrator's arms write it (area
-- PLANERING since Roller i skolan), staff read it, the SS12000 sync's narrow
-- write never touches it, and app.ss12000_v_groups bumps versions only for
-- name, kind, grade, year and ss12000Id, so a replacement does not reach the
-- SS12000 feed (that is the next phase's, Elevlistan i uppföljningen).
--
-- ## The pupil's own week (three arms narrowed)
--
-- The web's /student and the app read CalendarLessons directly through
-- PostgREST, filtered by date alone: RLS is the only filter, so this is where
-- the week must change, and every app version already in a pupil's pocket
-- follows. A new helper, STABLE SECURITY DEFINER with search_path pinned,
-- answers '{}' for anyone who is not a STUDENT:
--
--   app.current_student_replaced_lesson_ids(): the calendar lessons of the
--   caller's school that carry the caller's home class or one of their
--   teaching groups (own or extra group) and that the rule takes the caller
--   off. Bounded by the caller's own groups: about a class's svenska per
--   retained läsår, the size of #193's joined-lessons helper.
--
-- Three arms gain, after their old predicate, verbatim,
--
--   AND NOT ("id" = ANY ((select CASE WHEN app.current_user_role() = 'STUDENT'
--            THEN app.current_student_replaced_lesson_ids()
--            ELSE '{}'::uuid[] END)::uuid[]))
--
--   calendar_lessons_student_select         own group = the home class;
--   calendar_lessons_teaching_group_select  own group = a teaching group
--                                           (svenska taught in halves);
--   calendar_lessons_participant_select     an extra group = the home class,
--                                           or #193's joined lessons.
--
-- The ELSE is '{}' and never NULL: "id" = ANY (NULL) is NULL, and NOT NULL
-- would drop the row. The participant arm's named branch is untouched in
-- effect: the helper never lists a lesson that names the caller. The arms that
-- read CalendarLessons from inside their own (lesson_logs_family_select, the
-- homework; calendar_lesson_teachers_student_select) follow without a change.
--
-- Before it narrows them the migration checks that each arm still says what
-- 20260822120000 (student, teaching group) and 20261208090000 (participant)
-- wrote, as text with its whitespace folded and search_path set to public,
-- pg_temp for the rest of the migration (pg_policies.qual names a function
-- relative to the search_path, #193's review point 1). An arm changed since
-- stops the migration, naming what it found.
--
-- Cost for staff: the CASE answers '{}' without calling the helper, and the
-- condition is a row filter after each arm's own: the student and teaching
-- group arms scan on "studentGroupId" (nobody's for staff), and the
-- participant arm's row filter is reached after the staff arm has decided a
-- teacher's or an administrator's row. Measured paired A/B, see the PR.
--
-- ## The guardian's week (one arm added)
--
-- The guardian's week is the gateway's (family-schedule.service.ts), which
-- filters per child in code: the guardian's lesson arms are per guardian,
-- not per child, and a sibling may well attend 7A's svenska. To apply the
-- rule the service reads the child's replacing groups, and a guardian has no
-- arm on StudentGroups. student_groups_guardian_select gives them exactly the
-- groups their lesson arms already reach: app.current_guardian_group_ids(),
-- the classes and teaching groups of their children. TO app_authenticated,
-- like every guardian arm: a guardian reads someone else's rows, through the
-- gateway only.
--
-- ## The calendar feeds (one function replaced)
--
-- app.calendar_feed_pupil_lessons (20261112091000), the SQL twin of the
-- family's week, reads neither RLS nor the gateway. Its "theirs" step drops
-- what the rule drops, the pupil named on the lesson excepted; the teacher's
-- feed is untouched. CREATE OR REPLACE keeps its signature, owner and ACL.
-- Before it does, the migration checks md5(prosrc) against the body
-- 20261112091000 wrote (prosrc is the text as written, so the check does not
-- depend on the session), and stops if it has changed since.
--
-- ## A school with no replacing group
--
-- Nothing changes for it: the helper finds no replacing group and answers
-- '{}', so each narrowed arm admits what it admitted; the feed's NOT EXISTS
-- finds no row; the guardian arm admits groups whose lessons the guardian
-- already reads. Proved by the identity comparison in the PR.
--
-- ## Beside the live API: every lock at once, or none
--
-- Production runs this while the API before it serves requests, and that API
-- works unchanged between this migration and the deploy: it never reads the
-- new column, a narrowed arm drops rows only for a pupil in a replacing group
-- (there is none until the new API's dialog marks one), and the guardian arm
-- only widens.
--
-- ADD COLUMN, the CHECK, CREATE POLICY and ALTER POLICY take ACCESS EXCLUSIVE
-- on StudentGroups and CalendarLessons; the foreign key takes SHARE ROW
-- EXCLUSIVE on Subjects; parsing the arms and the function bodies takes
-- ACCESS SHARE on the tables they read. Requests take these tables together
-- (a lesson read with its group and subject, the guardian's arms), so a
-- migration that waited for one while holding another would queue every
-- reader behind it and could close a cycle with a request taking them the
-- other way. So all of them are taken first, NOWAIT and together: a refusal
-- rolls the subtransaction back with whatever it got and tries again 50 ms
-- later (policy-migration-lock-order). After 30 s of refusals it stops with
-- nothing done and can be rerun (prisma migrate resolve --rolled-back, then
-- deploy). lock_timeout bounds any wait nobody foresaw.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "StudentGroups", "CalendarLessons" IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Subjects" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "StudentGroupMembers", "CalendarLessonStudents", "CalendarLessonGroups",
                 "Users", "StudentEnrollments", "Rooms" IN ACCESS SHARE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'StudentGroups, CalendarLessons, Subjects and the tables their arms read were not free at once in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- The arms say what 20260822120000 and 20261208090000 wrote, and the feed's
-- body what 20261112091000 wrote, or nothing is changed. set_config(..., true)
-- is SET LOCAL: the search_path holds for the rest of the migration, which
-- Prisma runs as one transaction.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  arm record;
  found text;
  body text;
BEGIN
  PERFORM set_config('search_path', 'public, pg_temp', true);
  FOR arm IN SELECT * FROM (VALUES
    ('calendar_lessons_student_select', '20260822120000',
     '(("schoolId" = ( SELECT app.current_school_id() AS current_school_id)) '
     'AND ("studentGroupId" = ( SELECT app.current_user_group_id() AS current_user_group_id)))'),
    ('calendar_lessons_teaching_group_select', '20260822120000',
     '(("schoolId" = ( SELECT app.current_school_id() AS current_school_id)) '
     'AND ("studentGroupId" IN ( SELECT sgm."studentGroupId" FROM "StudentGroupMembers" sgm '
     'WHERE (sgm."studentId" = ( SELECT app.current_user_id() AS current_user_id)))))'),
    ('calendar_lessons_participant_select', '20261208090000',
     '(("schoolId" = ( SELECT app.current_school_id() AS current_school_id)) AND ((EXISTS ( SELECT 1 FROM "CalendarLessonStudents" cls '
     'WHERE ((cls."calendarLessonId" = "CalendarLessons".id) AND (cls."studentId" = ( SELECT app.current_user_id() AS current_user_id))))) '
     'OR (EXISTS ( SELECT 1 FROM "CalendarLessonGroups" clg WHERE ((clg."calendarLessonId" = "CalendarLessons".id) '
     'AND (clg."studentGroupId" = ( SELECT app.current_user_group_id() AS current_user_group_id))))) '
     'OR (id = ANY (( SELECT CASE WHEN (app.current_user_role() = ''STUDENT''::"UserRole") THEN app.current_student_joined_lesson_ids() '
     'ELSE NULL::uuid[] END AS "case")::uuid[]))))')
  ) AS t(name, wrote, expected)
  LOOP
    SELECT regexp_replace(p.qual, '\s+', ' ', 'g') INTO found
      FROM pg_policies p
     WHERE p.schemaname = 'public' AND p.tablename = 'CalendarLessons' AND p.policyname = arm.name;
    IF found IS DISTINCT FROM arm.expected THEN
      RAISE EXCEPTION '% is not as % wrote it, so it is not narrowed: it says %, and this migration expects %',
        arm.name, arm.wrote, coalesce(found, '(no such arm)'), arm.expected;
    END IF;
  END LOOP;

  SELECT md5(p.prosrc) INTO body
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('app.calendar_feed_pupil_lessons(uuid, uuid, date, date, text, "TeacherDisplay")');
  IF body IS DISTINCT FROM 'b295b3d08eeb543f851fef4efed66402' THEN
    RAISE EXCEPTION 'app.calendar_feed_pupil_lessons is not as 20261112091000 wrote it (md5 of its body %, expected b295b3d08eeb543f851fef4efed66402), so it is not replaced',
      coalesce(body, '(no such function)');
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- StudentGroups."replacesSubjectId"
-- ---------------------------------------------------------------------------

ALTER TABLE "StudentGroups"
    ADD COLUMN "replacesSubjectId" UUID;

ALTER TABLE "StudentGroups"
    ADD CONSTRAINT "StudentGroups_only_a_teaching_group_replaces" CHECK (
        "replacesSubjectId" IS NULL OR ("kind" = 'TEACHING_GROUP' AND "halfOfId" IS NULL)
    );

ALTER TABLE "StudentGroups"
    ADD CONSTRAINT "StudentGroups_replacesSubjectId_schoolId_fkey"
    FOREIGN KEY ("replacesSubjectId", "schoolId") REFERENCES "Subjects"("id", "schoolId")
    ON DELETE SET NULL ("replacesSubjectId") ON UPDATE NO ACTION;

COMMENT ON COLUMN "StudentGroups"."replacesSubjectId" IS
  'Ersättande grupper: the subject whose other lessons this teaching group''s members leave (SvA7 replaces Svenska). A pupil in the group is on no lesson in the subject that neither carries the group (own or extra group) nor names them. NULL replaces nothing.';

-- ---------------------------------------------------------------------------
-- The pupil's helper.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.current_student_replaced_lesson_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  WITH me AS (
    SELECT (select app.current_user_id()) AS id,
           (select app.current_school_id()) AS school,
           (select app.current_user_group_id()) AS home
     WHERE (select app.current_user_role()) = 'STUDENT'
  ),
  -- The caller's replacing groups, and the subject each replaces.
  replacing AS (
    SELECT g."id", g."replacesSubjectId" AS subject
      FROM me
      JOIN "StudentGroupMembers" m ON m."studentId" = me.id AND m."schoolId" = me.school
      JOIN "StudentGroups" g ON g."id" = m."studentGroupId" AND g."schoolId" = me.school
     WHERE g."replacesSubjectId" IS NOT NULL
  ),
  -- The groups the caller reaches a lesson through: the home class and every
  -- teaching group. Read only when the caller replaces something.
  mine AS (
    SELECT me.home AS id FROM me WHERE me.home IS NOT NULL AND EXISTS (SELECT 1 FROM replacing)
    UNION
    SELECT m."studentGroupId"
      FROM me JOIN "StudentGroupMembers" m ON m."studentId" = me.id AND m."schoolId" = me.school
     WHERE EXISTS (SELECT 1 FROM replacing)
  ),
  -- Their lessons in a replaced subject, by the lesson's own group or an
  -- extra one.
  reached AS (
    SELECT cl."id", cl."subjectId", cl."studentGroupId"
      FROM me JOIN "CalendarLessons" cl ON cl."schoolId" = me.school
     WHERE cl."studentGroupId" IN (SELECT id FROM mine)
       AND cl."subjectId" IN (SELECT subject FROM replacing)
    UNION
    SELECT cl."id", cl."subjectId", cl."studentGroupId"
      FROM me
      JOIN "CalendarLessonGroups" x ON x."schoolId" = me.school AND x."studentGroupId" IN (SELECT id FROM mine)
      JOIN "CalendarLessons" cl ON cl."id" = x."calendarLessonId" AND cl."schoolId" = me.school
     WHERE cl."subjectId" IN (SELECT subject FROM replacing)
  )
  SELECT coalesce(array_agg(DISTINCT r."id"), '{}'::uuid[])
    FROM reached r, me
   WHERE EXISTS (SELECT 1 FROM replacing g
                  WHERE g.subject = r."subjectId"
                    AND g."id" <> r."studentGroupId"
                    AND NOT EXISTS (SELECT 1 FROM "CalendarLessonGroups" x
                                     WHERE x."calendarLessonId" = r."id" AND x."studentGroupId" = g."id"))
     AND NOT EXISTS (SELECT 1 FROM "CalendarLessonStudents" s
                      WHERE s."calendarLessonId" = r."id" AND s."studentId" = me.id)
$$;

COMMENT ON FUNCTION app.current_student_replaced_lesson_ids() IS
  'The calendar lessons of the calling STUDENT''s school that carry their home class or one of their teaching groups and that a replacing group of theirs takes them off (Ersättande grupper: the subject replaced, the group not on the lesson, the caller not named); empty for every other role.';

REVOKE ALL ON FUNCTION app.current_student_replaced_lesson_ids() FROM PUBLIC;

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['authenticated', 'app_authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION app.current_student_replaced_lesson_ids() TO %I', r);
    END IF;
  END LOOP;
  FOREACH r IN ARRAY ARRAY['anon', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION app.current_student_replaced_lesson_ids() FROM %I', r);
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- The pupil's three arms, narrowed. Each old predicate is kept verbatim.
-- ---------------------------------------------------------------------------

ALTER POLICY "calendar_lessons_student_select" ON "CalendarLessons"
    USING (
        "schoolId" = (select app.current_school_id())
        AND "studentGroupId" = (select app.current_user_group_id())
        AND NOT ("id" = ANY ((select CASE WHEN app.current_user_role() = 'STUDENT'
                                          THEN app.current_student_replaced_lesson_ids()
                                          ELSE '{}'::uuid[] END)::uuid[]))
    );

ALTER POLICY "calendar_lessons_teaching_group_select" ON "CalendarLessons"
    USING (
        "schoolId" = (select app.current_school_id())
        AND "studentGroupId" IN (
            SELECT sgm."studentGroupId" FROM "StudentGroupMembers" sgm
             WHERE sgm."studentId" = (select app.current_user_id())
        )
        AND NOT ("id" = ANY ((select CASE WHEN app.current_user_role() = 'STUDENT'
                                          THEN app.current_student_replaced_lesson_ids()
                                          ELSE '{}'::uuid[] END)::uuid[]))
    );

ALTER POLICY "calendar_lessons_participant_select" ON "CalendarLessons"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (
            EXISTS (SELECT 1 FROM "CalendarLessonStudents" cls
                     WHERE cls."calendarLessonId" = "CalendarLessons"."id"
                       AND cls."studentId" = (select app.current_user_id()))
            OR EXISTS (SELECT 1 FROM "CalendarLessonGroups" clg
                        WHERE clg."calendarLessonId" = "CalendarLessons"."id"
                          AND clg."studentGroupId" = (select app.current_user_group_id()))
            OR "id" = ANY ((select CASE WHEN app.current_user_role() = 'STUDENT'
                                        THEN app.current_student_joined_lesson_ids() END)::uuid[])
        )
        AND NOT ("id" = ANY ((select CASE WHEN app.current_user_role() = 'STUDENT'
                                          THEN app.current_student_replaced_lesson_ids()
                                          ELSE '{}'::uuid[] END)::uuid[]))
    );

-- ---------------------------------------------------------------------------
-- The guardian reads their children's groups.
-- ---------------------------------------------------------------------------

CREATE POLICY "student_groups_guardian_select" ON "StudentGroups"
    FOR SELECT TO "app_authenticated"
    USING (
        (select app.current_user_role()) = 'GUARDIAN'
        AND "schoolId" = (select app.current_school_id())
        AND "id" = ANY ((select app.current_guardian_group_ids())::uuid[])
    );

-- ---------------------------------------------------------------------------
-- The calendar feed of a pupil, the rule applied. Everything but "theirs" is
-- as 20261112091000 wrote it.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.calendar_feed_pupil_lessons(p_school uuid, p_pupil uuid, p_from date, p_to date, p_tz text, p_display "TeacherDisplay")
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = "public", "pg_temp" AS $$
  WITH pupil AS (
    SELECT u."studentGroupId" AS home FROM "Users" u WHERE u."id" = p_pupil AND u."schoolId" = p_school
  ),
  teaching AS (
    SELECT m."studentGroupId" AS g FROM "StudentGroupMembers" m WHERE m."studentId" = p_pupil
  ),
  homedays AS (
    SELECT e."validFrom", e."validTo"
      FROM "StudentEnrollments" e, pupil
     WHERE e."studentId" = p_pupil AND e."studentGroupId" = pupil.home
  ),
  -- The lessons the family's week matches: the pupil named on it, a teaching
  -- group's (its own group or an extra one), and the home class's on the
  -- days the class history names it.
  named AS (
    SELECT p."calendarLessonId" AS id FROM "CalendarLessonStudents" p WHERE p."studentId" = p_pupil
  ),
  taught AS (
    SELECT cl."id" FROM "CalendarLessons" cl
     WHERE cl."studentGroupId" IN (SELECT g FROM teaching) AND cl."date" BETWEEN p_from AND p_to
    UNION
    SELECT x."calendarLessonId" FROM "CalendarLessonGroups" x WHERE x."studentGroupId" IN (SELECT g FROM teaching)
  ),
  homed AS (
    SELECT cl."id", cl."date" FROM "CalendarLessons" cl, pupil
     WHERE cl."studentGroupId" = pupil.home AND cl."date" BETWEEN p_from AND p_to
    UNION
    SELECT cl."id", cl."date"
      FROM "CalendarLessonGroups" x JOIN "CalendarLessons" cl ON cl."id" = x."calendarLessonId", pupil
     WHERE x."studentGroupId" = pupil.home AND cl."date" BETWEEN p_from AND p_to
  ),
  candidates AS (
    SELECT id FROM named
    UNION
    SELECT id FROM taught
    UNION
    SELECT h."id" FROM homed h
     WHERE EXISTS (SELECT 1 FROM homedays d
                    WHERE d."validFrom" <= h."date" AND (d."validTo" IS NULL OR h."date" < d."validTo"))
  ),
  -- Ersättande grupper (20261211090000): the pupil's replacing groups, and
  -- the subject each replaces.
  replacing AS (
    SELECT g."id", g."replacesSubjectId" AS subject
      FROM "StudentGroupMembers" m JOIN "StudentGroups" g ON g."id" = m."studentGroupId"
     WHERE m."studentId" = p_pupil AND g."schoolId" = p_school AND g."replacesSubjectId" IS NOT NULL
  ),
  theirs AS (
    SELECT cl."id", cl."date", cl."startsAt", cl."endsAt", cl."status", cl."subjectId", cl."roomId", cl."updatedAt"
      FROM "CalendarLessons" cl
     WHERE cl."id" IN (SELECT c.id FROM candidates c)
       AND cl."schoolId" = p_school
       AND cl."date" BETWEEN p_from AND p_to
       AND cl."status" IN ('SCHEDULED', 'COMPLETED', 'CANCELLED')
       -- A replacing group takes the pupil off its subject's other lessons:
       -- those that neither carry it nor name the pupil.
       AND (
             cl."id" IN (SELECT id FROM named)
          OR NOT EXISTS (SELECT 1 FROM replacing g
                          WHERE g.subject = cl."subjectId"
                            AND g."id" <> cl."studentGroupId"
                            AND NOT EXISTS (SELECT 1 FROM "CalendarLessonGroups" x
                                             WHERE x."calendarLessonId" = cl."id" AND x."studentGroupId" = g."id"))
       )
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', l."id",
           'date', to_char(l."date", 'YYYY-MM-DD'),
           'start', to_char(l."startsAt" AT TIME ZONE p_tz, 'YYYYMMDD"T"HH24MISS'),
           'end', to_char(l."endsAt" AT TIME ZONE p_tz, 'YYYYMMDD"T"HH24MISS'),
           'startUtc', to_char(l."startsAt" AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS"Z"'),
           'endUtc', to_char(l."endsAt" AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS"Z"'),
           'cancelled', l."status" = 'CANCELLED',
           'subject', s."name",
           'room', r."name",
           'groups', '[]'::jsonb,
           'teachers', to_jsonb(coalesce(st.labels, '{}'::text[])),
           'substitute', coalesce(st.substitute, false),
           'version', to_char(l."updatedAt" AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS"Z"'))
         ORDER BY l."startsAt", l."endsAt", l."id"), '[]'::jsonb)
    FROM theirs l
    JOIN "Subjects" s ON s."id" = l."subjectId"
    LEFT JOIN "Rooms" r ON r."id" = l."roomId"
    LEFT JOIN app.family_lesson_labels(p_school, p_display, ARRAY(SELECT t."id" FROM theirs t)) st ON st.lesson_id = l."id"
$$;

COMMENT ON FUNCTION app.calendar_feed_pupil_lessons(uuid, uuid, date, date, text, "TeacherDisplay") IS
  'A pupil''s week for a calendar feed, the pupil''s own or a guardian''s: the lessons the family''s week matches, less those a replacing group takes the pupil off (20261211090000), teachers as the school names them to families. The owner''s, inside app.calendar_feed.';
