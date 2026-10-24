-- En elev ser lektioner dit hens undervisningsgrupp är tillagd.
--
-- 7B's svenska carries the teaching group SvA7 as an extra group
-- (CalendarLessonGroups), and a 7A pupil is in SvA7 (StudentGroupMembers).
-- The pupil's guardian reads the lesson (calendar_lessons_guardian_select:
-- app.current_guardian_lesson_ids() includes every lesson carrying one of the
-- children's groups as an extra group, 20261013090000). The pupil did not:
--
--   calendar_lessons_participant_select   matches an extra group only when it
--                                         is the pupil's HOME class
--                                         (app.current_user_group_id());
--   calendar_lessons_teaching_group_select matches a teaching group only when
--                                         it is the lesson's OWN group;
--   calendar_lessons_student_select       the lesson's own group is the home
--                                         class.
--
-- None of them asks whether an extra group is one of the pupil's teaching
-- groups, so the lesson was missing from the pupil's week (the web's
-- /student and the app read CalendarLessons directly), and since the
-- lektionslogg's family arm (lesson_logs_family_select) defers to the
-- caller's own lesson arms, its topic and homework were missing too, while
-- the guardian saw both. 20261013090000 named the gap and left it.
--
-- The pupil's arm on CalendarLessonGroups (calendar_lesson_groups_member_select)
-- had the same gap: it shows a row only when the extra group is the home
-- class. The gateway's pupil list of logs (GET /api/v1/lesson-logs,
-- lesson-log.service.ts) reads each lesson's extra groups and asks the one
-- roster reader (src/calendar/lesson-roster.ts) whether the pupil is on it, so
-- with the lesson visible and its SvA7 row hidden the pupil is still not on
-- the roster, and the log is still missing. Both arms are widened.
--
-- ## Two helpers, and the pupil's two arms widened
--
-- As the guardian's (20261013090000), each helper is STABLE SECURITY DEFINER
-- with search_path pinned and answers '{}' to anyone who is not a STUDENT:
--
--   * app.current_student_teaching_group_ids(): the caller's own teaching
--     groups (StudentGroupMembers) in the caller's school;
--   * app.current_student_joined_lesson_ids(): the calendar lessons of the
--     caller's school that carry one of those groups as an extra group.
--     Bounded by the pupil's teaching groups; the rollover keeps a past
--     year's memberships, so it also holds the lessons of past years still
--     kept, as the guardian's helper does.
--
-- Inside them every call to the caller's helpers goes through (select ...),
-- so each is asked once per call and not once per membership or extra-group
-- row.
--
-- calendar_lessons_participant_select: a pupil is on the lesson by a named
-- row, or by an extra group that is their home class, as before, or now,
-- inside the same school check, by
--
--     "id" = ANY ((select CASE WHEN app.current_user_role() = 'STUDENT'
--                  THEN app.current_student_joined_lesson_ids() END)::uuid[])
--
-- The old predicate is kept verbatim.
--
-- calendar_lesson_groups_member_select: the extra group is one of
--
--     (select CASE WHEN app.current_user_role() = 'STUDENT'
--             THEN app.current_student_teaching_group_ids() || app.current_user_group_id()
--             ELSE ARRAY[app.current_user_group_id()] END)
--
-- in the caller's school: a pupil's teaching groups and home class, and for
-- every other role exactly what the arm matched before, "studentGroupId" =
-- app.current_user_group_id(). So a pupil reads the extra-group rows of the
-- home class and of their teaching groups, which is the guardian's reach for
-- their child exactly (calendar_lesson_groups_guardian_select over
-- current_guardian_group_ids: the classes and teaching groups of the
-- children).
--
-- Before it widens them the migration checks that each arm still says what
-- 20260822120000 wrote, as text with its whitespace folded, with search_path
-- set to public, pg_temp for the rest of the migration: pg_policies.qual
-- names a function relative to the search_path (app.current_school_id()
-- reads current_school_id() for a session with app on its path), so the
-- check would otherwise depend on the session that runs it. An arm changed
-- since stops the migration, naming what it found, instead of being written
-- over.
--
-- ## Why these shapes: what an arm costs every staff read
--
-- The planner reads a staff member's week as a BitmapOr with one index scan
-- per permissive arm, built from each arm's indexable conditions whichever
-- arm will answer, and the arms of CalendarLessons and CalendarLessonGroups
-- are planned again wherever another table's arms read them (the teacher's
-- week carries them inside CalendarLessonTeachers' arms), each time with
-- their initplans. A role check is not indexable, so in front of an arm it
-- decides nothing for the scan:
--
--   * a new arm on CalendarLessons, role first, as the guardian's: its
--     "id" = ANY (helper) matches the ("id", "schoolId") key, so its scan was
--     built on the helper's array and the helper ran for every teacher and
--     administrator. With the role inside the initplan (a CASE) the helper
--     stayed away, but the arm still added initplans and an index scan;
--   * inside the participant arm the branch adds no scan: the arm's scan
--     stays on "schoolId" and the date, and the row filter tries the
--     permissive arms in the order Postgres 16 and 17 give them (EXPLAIN
--     lists them in reverse name order), which puts the staff arm (TEACHER,
--     SCHOOL_ADMIN) before the participant arm, so a teacher's or an
--     administrator's row is decided before the branch is reached. That order
--     is the planner's, not a promise: were it to change, staff reads would
--     slow down and no answer would;
--   * on CalendarLessonGroups an OR branch in the member arm cost its
--     selective scan ("studentGroupId" of the home class, which is nobody's
--     for staff) for one on "schoolId"; a new arm beside it kept a selective
--     scan but brought initplans of its own. One array keeps the scan on
--     "studentGroupId" with no arm added: for staff the CASE answers the old
--     array without the helper, and the scan finds what it found before.
--
-- Paired A/B on one connection (the shared-Mac rule), as
-- scripts/bench/family-arms.ts does, on timplan-delivered's scale-a school
-- (792 lessons in the week), median EXPLAIN ANALYZE as app_authenticated
-- against the arms before this migration; run-to-run noise is about three
-- points. The shapes, measured before 20261204090000 (Flera skolor) rewrote
-- the helpers every arm calls:
--
--                                         teacher's  administrator's  their extra
--                                         week       week             groups
--   new lesson arm, role first             +19.8 %    +54.3 %          +9.6 %  (PG16, 61 rounds)
--   new lesson arm, role in a CASE          +7.7 %     +8.9 %          -2.4 %  (PG16, 61)
--   participant widened, OR in member       +2.4 %     +0.6 %          +4.0 %  (PG17, 61)
--                                           +1.1 %     +0.4 %         +10.8 %  (PG16, 61)
--   participant widened, new group arm      +4.8 %     +3.4 %          -1.1 %  (PG17, 121)
--   this migration, the same run            +2.3 %     +0.9 %          -3.3 %  (PG17, 121)
--
-- On main 20af0442, one run on Postgres 17 with the RLS suite's fixtures
-- loaded (121 rounds), against the two EXISTS shapes the independent review
-- suggested so that a pupil's cost would not grow with retained years:
--
--   the participant arm's EXISTS on
--   CalendarLessonGroups, widened to the
--   pupil's groups                         +28.7 %     +1.8 %          -9.6 %
--   a second EXISTS for the teaching groups +48.8 %    +11.8 %          -7.2 %
--   this migration                          +2.2 %     +0.9 %         -13.3 %
--
-- Either EXISTS moved the teacher's week to another plan (from the teacher's
-- CalendarLessonTeachers rows instead of the week's lessons): the planner
-- costs an EXISTS on a set of groups higher than one on a single group, and
-- the two plans are close enough for that to decide. This migration's
-- branch leaves every plan as it was. A second run of it on each, the same
-- fixtures:
--
--                                           +1.7 %     +2.5 %         -11.0 %  (PG17)
--                                           +1.4 %     +0.2 %          -6.2 %  (PG16)
--
-- within the 5 % the guardian arms were held to.
--
-- The price is the pupil's own week. Every lesson row it reads searches the
-- array of joined lessons, and the array holds every retained year's
-- (memberships carry no läsår). On Postgres 17, with N past lessons joined
-- to the pupil's teaching group, against the arms before this migration:
--
--   N        before   this migration   EXISTS widened
--   0        1.55     2.00             1.83 ms
--   1 000    1.50     3.72             3.38 ms
--   3 000    1.64     7.88             6.54 ms
--
-- A SvA group joined three times a week is about 110 lessons a läsår. The
-- guardian's own read, which this mirrors, the independent review measured
-- at about 60 ms with N = 3 001 (current_guardian_lesson_ids).
--
-- ## For authenticated, as before
--
-- Both arms keep their roles: TO authenticated, like every pupil arm on the
-- lesson tables, so they also answer the API's role (app_authenticated is a
-- member of authenticated). A pupil's lessons are the pupil's own rows, which
-- is what authenticated still reads directly (20261026100000: "the logged-in
-- reads only their own directly"), and the web's /student week and the app's
-- schedule read CalendarLessons through PostgREST: an arm for the API's role
-- alone would show the joined lesson's log through the gateway and leave the
-- lesson itself out of the pupil's week. The guardian's lesson arms are the
-- API's alone because a guardian reads someone else's rows (their child's); a
-- pupil reading their own lesson reads nothing a home-class lesson does not
-- already show them. Both helpers are executable by the two roles the arms
-- answer and by nobody else.
--
-- ## Beside the live API: every lock at once, or none
--
-- Production runs this while the API before it serves requests. ALTER POLICY
-- takes ACCESS EXCLUSIVE on its table, so this takes it on CalendarLessons and
-- on CalendarLessonGroups; and parsing an expression takes ACCESS SHARE on
-- the tables it reads: CalendarLessonGroups and StudentGroupMembers for the
-- helpers' bodies, CalendarLessonStudents for the participant arm's EXISTS.
-- Requests take the two lesson tables together in one transaction — a lesson
-- read with its extra groups (Prisma's include, the cover board), the
-- guardian's lesson arm reading the groups inside a read of the lessons, a
-- write of a lesson's groups checking its key into the lessons — so a
-- migration that waited for one while it held the other would queue every
-- reader of both behind it, and could close a cycle with a request that took
-- them the other way. So all four are taken first, NOWAIT and together: a
-- refusal rolls the subtransaction back and with it whatever it got, and it
-- tries again 50 ms later (policy-migration-lock-order). It never waits while
-- it holds a lock, and no request queues behind a lock it is still waiting
-- for; once it holds them, a reader waits only for the two ALTERs, which take
-- milliseconds. After 30 s of refusals it
-- stops with nothing done and can be rerun (prisma migrate resolve
-- --rolled-back, then deploy). lock_timeout bounds any wait nobody foresaw.
--
-- The arms only widen, so the API before this one works unchanged between
-- this migration and the deploy: a pupil sees one more lesson, and nothing in
-- the code depends on it.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "CalendarLessons", "CalendarLessonGroups" IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "CalendarLessonStudents", "StudentGroupMembers" IN ACCESS SHARE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'CalendarLessons, CalendarLessonGroups, CalendarLessonStudents and StudentGroupMembers were not free at once in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- The arms say what 20260822120000 wrote (pg_policies.qual with its
-- whitespace folded), or nothing is changed. set_config(..., true) is SET
-- LOCAL: the search_path holds for this block and, since Prisma runs the
-- file as one transaction, for the rest of the migration.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  arm record;
  found text;
BEGIN
  PERFORM set_config('search_path', 'public, pg_temp', true);
  FOR arm IN SELECT * FROM (VALUES
    ('CalendarLessons', 'calendar_lessons_participant_select',
     '(("schoolId" = ( SELECT app.current_school_id() AS current_school_id)) AND ((EXISTS ( SELECT 1 FROM "CalendarLessonStudents" cls '
     'WHERE ((cls."calendarLessonId" = "CalendarLessons".id) AND (cls."studentId" = ( SELECT app.current_user_id() AS current_user_id))))) '
     'OR (EXISTS ( SELECT 1 FROM "CalendarLessonGroups" clg WHERE ((clg."calendarLessonId" = "CalendarLessons".id) '
     'AND (clg."studentGroupId" = ( SELECT app.current_user_group_id() AS current_user_group_id)))))))'),
    ('CalendarLessonGroups', 'calendar_lesson_groups_member_select',
     '(("schoolId" = ( SELECT app.current_school_id() AS current_school_id)) '
     'AND ("studentGroupId" = ( SELECT app.current_user_group_id() AS current_user_group_id)))')
  ) AS t(tbl, name, expected)
  LOOP
    SELECT regexp_replace(p.qual, '\s+', ' ', 'g') INTO found
      FROM pg_policies p
     WHERE p.schemaname = 'public' AND p.tablename = arm.tbl AND p.policyname = arm.name;
    IF found IS DISTINCT FROM arm.expected THEN
      RAISE EXCEPTION '% is not as 20260822120000 wrote it, so it is not widened: it says %, and this migration expects %',
        arm.name, coalesce(found, '(no such arm)'), arm.expected;
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- The helpers.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.current_student_teaching_group_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT coalesce(array_agg(m."studentGroupId" ORDER BY m."studentGroupId"), '{}'::uuid[])
    FROM "StudentGroupMembers" m
   WHERE (select app.current_user_role()) = 'STUDENT'
     AND m."studentId" = (select app.current_user_id())
     AND m."schoolId" = (select app.current_school_id())
$$;

CREATE FUNCTION app.current_student_joined_lesson_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT coalesce(array_agg(DISTINCT x."calendarLessonId"), '{}'::uuid[])
    FROM "CalendarLessonGroups" x
   WHERE x."studentGroupId" = ANY ((select app.current_student_teaching_group_ids())::uuid[])
     AND x."schoolId" = (select app.current_school_id())
$$;

COMMENT ON FUNCTION app.current_student_teaching_group_ids() IS
  'The calling STUDENT''s own teaching groups (StudentGroupMembers) in the caller''s school; empty for every other role.';
COMMENT ON FUNCTION app.current_student_joined_lesson_ids() IS
  'The calendar lessons of the caller''s school that carry a group of app.current_student_teaching_group_ids() as an extra group.';

REVOKE ALL ON FUNCTION app.current_student_teaching_group_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.current_student_joined_lesson_ids() FROM PUBLIC;

DO $$
DECLARE
  fn text;
  r text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['app.current_student_teaching_group_ids()', 'app.current_student_joined_lesson_ids()'] LOOP
    FOREACH r IN ARRAY ARRAY['authenticated', 'app_authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn, r);
      END IF;
    END LOOP;
    FOREACH r IN ARRAY ARRAY['anon', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', fn, r);
      END IF;
    END LOOP;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- The arms, widened.
-- ---------------------------------------------------------------------------

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
    );

ALTER POLICY "calendar_lesson_groups_member_select" ON "CalendarLessonGroups"
    USING (
        "schoolId" = (select app.current_school_id())
        AND "studentGroupId" = ANY ((select CASE WHEN app.current_user_role() = 'STUDENT'
                                                 THEN app.current_student_teaching_group_ids() || app.current_user_group_id()
                                                 ELSE ARRAY[app.current_user_group_id()] END)::uuid[])
    );
