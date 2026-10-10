-- En vårdnadshavare ser sina barns schema.
--
-- A guardian has never been able to read their child's week. The one arm
-- meant for it, calendar_lessons_guardian_teaching_group_select (20260817100000,
-- re-scoped in 20260822090000), keys on StudentGroupMembers, which by the
-- schema's own definition holds a pupil's TEACHING groups and never the home
-- class: 20260904090000 already said that "a guardian reading through that
-- table sees nothing". Guardians had no arm at all on CalendarLessonGroups or
-- CalendarLessonStudents. This migration gives a guardian the lessons their
-- children are taught in, and nothing else, so GET /api/v1/family/schedule
-- (FamilyScheduleService) can answer under the guardian's own RLS.
--
-- ## The lessons the child is taught in
--
-- Four helpers, each STABLE SECURITY DEFINER with search_path pinned, each
-- answering '{}' to anyone who is not a GUARDIAN:
--
--   * app.current_guardian_child_ids(): the caller's linked children who are
--     ACTIVE STUDENTs of the caller's school. A pupil who left (isActive
--     false), a link to another school and a linked non-pupil are not
--     children here;
--   * app.current_guardian_class_ids(): those children's home classes
--     (Users.studentGroupId, the class the pupil is in TODAY);
--   * app.current_guardian_group_ids(): the classes plus the children's
--     teaching groups (StudentGroupMembers);
--   * app.current_guardian_lesson_ids(): the calendar lessons that carry one
--     of those groups as an extra group or name a child. Bounded by the
--     children's groups (one läsår's groups) and their named lessons.
--
-- The arms, each beginning (select app.current_user_role()) = 'GUARDIAN' AND
-- "schoolId" = (select app.current_school_id()):
--
--   CalendarLessons        the lesson's class is a group of a child, or the
--                          lesson is one of current_guardian_lesson_ids();
--   CalendarLessonGroups   the extra group is a group of a child;
--   CalendarLessonStudents the named pupil is a child;
--   CalendarLunches,
--   CalendarRasts          the class is a child's home class (re-keyed, below);
--   CalendarLessonTeachers NO arm (below).
--
-- This is "the lessons the child is taught in", not "what the child reads":
-- the pupil's own arms (calendar_lessons_participant_select and
-- calendar_lesson_groups_member_select) match extra groups only for the
-- HOME class, so a lesson carrying the child's teaching group as an extra
-- group is visible to the guardian and not to the pupil. That gap in the
-- pupil's arms is old and out of scope here.
--
-- calendar_lessons_guardian_teaching_group_select is REPLACED, not left
-- beside the new arm: it is the half that never worked, it has no role
-- check (any role holding a GuardianStudents row would match it), and its
-- reach is a subset of the new arm's.
--
-- A guardian of two children reading CalendarLessons directly (PostgREST)
-- now gets both children's lessons together. The endpoint splits them per
-- child; the arm is the boundary that holds if the endpoint's filter is
-- wrong: whatever the endpoint does, it can only return the caller's own
-- children's lessons.
--
-- ## No arm on CalendarLessonTeachers
--
-- Cover deletes the absent teacher's CalendarLessonTeachers row and restores
-- it on undo (src/cover/cover.service.ts). An arm there would let any
-- guardian read, through PostgREST, which teacher UUID disappears from
-- which lessons on which dates: a colleague's absence window, which is HR
-- data (20261012090000). What a family needs is a boolean, "vikarie", and
-- how the school names a teacher to families. Both come from
-- app.family_lesson_staff(), a SECURITY DEFINER function the API alone may
-- call (EXECUTE for app_authenticated, revoked from authenticated, so
-- PostgREST cannot reach it). It also leaves P3's tuned teacher arms
-- (20261009110000) exactly as they are.
--
-- app.family_lesson_staff(p_lesson_ids uuid[]) RETURNS (lesson_id,
-- substitute, labels). School and role come from the claims, never from an
-- argument. A GUARDIAN gets rows only for lessons the arm above lets them
-- read, a SCHOOL_ADMIN for the school's lessons, anyone else nothing.
--
--   * substitute: the lesson is not cancelled and has a SUBSTITUTE row;
--   * labels: empty when the lesson is cancelled or substituted, or when
--     PublicationSettings.publicTeacherDisplay is NONE (or the school has no
--     settings row). Otherwise the public viewer's own expression
--     (app.public_timetable, 20261011133000): roles LEAD and ASSISTANT,
--     never a TeacherPublicLabels.hidden teacher, NAME as "first last",
--     SIGNATURE as the post's signature in the academic year of the
--     lesson's own class (per lesson, as the viewer takes it). One stricter
--     rule: only active TEACHER and SCHOOL_ADMIN users of the school are
--     labelled. The viewer does not ask; a deactivated teacher still on a
--     lesson is a stale row, not somebody to name to a family.
--
-- One setting names teachers outside the staff room: publicTeacherDisplay,
-- the viewer's. A logged-in family of the class is a narrower audience than
-- anyone holding a share link, and a second setting would let the viewer
-- and the app disagree about the same teacher.
--
-- ## The meal arms, re-keyed
--
-- calendar_lunches_guardian_select (20260904090000) and
-- calendar_rasts_guardian_select (20260906090000) asked neither the role
-- nor whether the child is still active: a guardian of a pupil who left
-- kept reading that class's lunches and rasts through PostgREST. Both are
-- recreated on app.current_guardian_class_ids() with the role check: the
-- home classes of active children, as before for a child still at school.
--
-- ## Performance
--
-- The role check comes first and is a one-time initplan; the helpers are
-- STABLE and called through (select ...), so each is computed once per
-- statement, not per row, and for a teacher or an admin the AND stops at the
-- role (P3's lesson, 985 → 755 ms, 20261009110000).
--
-- The arm on CalendarLessons asks an array of lesson ids, not two EXISTS on
-- CalendarLessonGroups and CalendarLessonStudents. The EXISTS form was
-- measured first and cost every staff read of CalendarLessons 5–9 % even
-- though a staff reader never evaluates it: the two subplans, each carrying
-- the initplans of its own table's arms, are built at executor start for
-- every statement. With the array the arm is four initplans and no subplan.
-- scripts/bench/family-arms.ts measures it on timplan-delivered's scale-a
-- school (792 lessons in the week), as app_authenticated, 61 paired rounds
-- alternating before/after on one connection: a teacher's week read
-- (useTeacherLessons) 2.39 → 2.31 ms (−3.1 %), an admin's school week
-- (useCalendarLessons) 0.91 → 0.83 ms (−8.3 %) and its extra groups
-- 2.02 → 2.04 ms (+0.9 %), all within the 5 % budget. A guardian's own week
-- read is 12.1 ms (the lesson-id helper reads the children's extra-group
-- lessons of the year).
--
-- ## No draft leaks
--
-- Only calendar tables are read, and the calendar is the published layer:
-- in DRAFT, master edits never reach CalendarLessons, CalendarLunches or
-- CalendarRasts until a publish (20261011100000).
--
-- ## Grants and the guard
--
-- No table grant changes. The helpers: REVOKE ALL FROM PUBLIC (a function
-- is created executable by PUBLIC), then EXECUTE to authenticated and
-- app_authenticated, because a policy runs as whoever reads. The label
-- function: EXECUTE to app_authenticated only; PUBLIC, anon, authenticated
-- and service_role revoked. All guarded on pg_roles, as in 20261012090000.
--
-- The migration ends with GUARDIAN_REACH over the six tables: every arm that
-- reaches a guardian is a permissive arm for authenticated with the role
-- check, the school check and a current_guardian_ helper, and
-- CalendarLessonTeachers has none.

-- ---------------------------------------------------------------------------
-- The helpers.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.current_guardian_child_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT coalesce(array_agg(u."id" ORDER BY u."id"), '{}'::uuid[])
    FROM "GuardianStudents" gs
    JOIN "Users" u ON u."id" = gs."studentId" AND u."schoolId" = gs."schoolId"
   WHERE app.current_user_role() = 'GUARDIAN'
     AND gs."guardianId" = app.current_user_id()
     AND gs."schoolId" = app.current_school_id()
     AND u."role" = 'STUDENT'
     AND u."isActive"
$$;

CREATE FUNCTION app.current_guardian_class_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT coalesce(array_agg(DISTINCT g."id"), '{}'::uuid[])
    FROM "Users" u
    JOIN "StudentGroups" g ON g."id" = u."studentGroupId" AND g."schoolId" = u."schoolId"
   WHERE u."id" = ANY (app.current_guardian_child_ids())
$$;

CREATE FUNCTION app.current_guardian_group_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT coalesce(array_agg(DISTINCT x.id), '{}'::uuid[])
    FROM (
      SELECT unnest(app.current_guardian_class_ids()) AS id
      UNION
      SELECT m."studentGroupId"
        FROM "StudentGroupMembers" m
       WHERE m."studentId" = ANY (app.current_guardian_child_ids())
         AND m."schoolId" = app.current_school_id()
    ) x
$$;

CREATE FUNCTION app.current_guardian_lesson_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT coalesce(array_agg(DISTINCT x.id), '{}'::uuid[])
    FROM (
      SELECT x."calendarLessonId" AS id
        FROM "CalendarLessonGroups" x
       WHERE x."studentGroupId" = ANY (app.current_guardian_group_ids())
         AND x."schoolId" = app.current_school_id()
      UNION ALL
      SELECT p."calendarLessonId"
        FROM "CalendarLessonStudents" p
       WHERE p."studentId" = ANY (app.current_guardian_child_ids())
         AND p."schoolId" = app.current_school_id()
    ) x
$$;

COMMENT ON FUNCTION app.current_guardian_child_ids() IS
  'The calling GUARDIAN''s linked, active STUDENT children in the caller''s school; empty for every other role.';
COMMENT ON FUNCTION app.current_guardian_class_ids() IS
  'The home classes (Users.studentGroupId) of app.current_guardian_child_ids().';
COMMENT ON FUNCTION app.current_guardian_group_ids() IS
  'The home classes and teaching groups (StudentGroupMembers) of app.current_guardian_child_ids().';
COMMENT ON FUNCTION app.current_guardian_lesson_ids() IS
  'The calendar lessons that carry a group of app.current_guardian_group_ids() as an extra group, or name a child.';

-- ---------------------------------------------------------------------------
-- The arms.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "calendar_lessons_guardian_teaching_group_select" ON "CalendarLessons";
CREATE POLICY "calendar_lessons_guardian_select" ON "CalendarLessons"
    FOR SELECT TO "authenticated"
    USING (
        (select app.current_user_role()) = 'GUARDIAN'
        AND "schoolId" = (select app.current_school_id())
        AND (
            "studentGroupId" = ANY ((select app.current_guardian_group_ids())::uuid[])
            OR "id" = ANY ((select app.current_guardian_lesson_ids())::uuid[])
        )
    );

CREATE POLICY "calendar_lesson_groups_guardian_select" ON "CalendarLessonGroups"
    FOR SELECT TO "authenticated"
    USING (
        (select app.current_user_role()) = 'GUARDIAN'
        AND "schoolId" = (select app.current_school_id())
        AND "studentGroupId" = ANY ((select app.current_guardian_group_ids())::uuid[])
    );

CREATE POLICY "calendar_lesson_students_guardian_select" ON "CalendarLessonStudents"
    FOR SELECT TO "authenticated"
    USING (
        (select app.current_user_role()) = 'GUARDIAN'
        AND "schoolId" = (select app.current_school_id())
        AND "studentId" = ANY ((select app.current_guardian_child_ids())::uuid[])
    );

DROP POLICY IF EXISTS "calendar_lunches_guardian_select" ON "CalendarLunches";
CREATE POLICY "calendar_lunches_guardian_select" ON "CalendarLunches"
    FOR SELECT TO "authenticated"
    USING (
        (select app.current_user_role()) = 'GUARDIAN'
        AND "schoolId" = (select app.current_school_id())
        AND "studentGroupId" = ANY ((select app.current_guardian_class_ids())::uuid[])
    );

DROP POLICY IF EXISTS "calendar_rasts_guardian_select" ON "CalendarRasts";
CREATE POLICY "calendar_rasts_guardian_select" ON "CalendarRasts"
    FOR SELECT TO "authenticated"
    USING (
        (select app.current_user_role()) = 'GUARDIAN'
        AND "schoolId" = (select app.current_school_id())
        AND "studentGroupId" = ANY ((select app.current_guardian_class_ids())::uuid[])
    );

-- ---------------------------------------------------------------------------
-- What a family is told about a lesson's teachers.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.family_lesson_staff(p_lesson_ids uuid[])
RETURNS TABLE (lesson_id uuid, substitute boolean, labels text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  WITH me AS (
    SELECT app.current_school_id() AS school,
           app.current_user_role() AS role,
           app.current_guardian_group_ids() AS groups,
           app.current_guardian_lesson_ids() AS lessons
  ),
  cfg AS (
    SELECT coalesce(
             (SELECT s."publicTeacherDisplay" FROM "PublicationSettings" s, me WHERE s."schoolId" = me.school),
             'NONE'::"TeacherDisplay") AS display
  ),
  reach AS (
    SELECT cl."id", cl."schoolId", cl."studentGroupId", cl."status",
           EXISTS (SELECT 1 FROM "CalendarLessonTeachers" t
                    WHERE t."calendarLessonId" = cl."id" AND t."role" = 'SUBSTITUTE') AS has_substitute
      FROM "CalendarLessons" cl, me
     WHERE cl."id" = ANY (p_lesson_ids)
       AND me.school IS NOT NULL
       AND cl."schoolId" = me.school
       AND (
             me.role = 'SCHOOL_ADMIN'
          OR (me.role = 'GUARDIAN' AND (cl."studentGroupId" = ANY (me.groups) OR cl."id" = ANY (me.lessons)))
       )
  )
  SELECT r."id",
         r."status" <> 'CANCELLED' AND r.has_substitute,
         CASE
           WHEN r."status" = 'CANCELLED' OR r.has_substitute OR cfg.display = 'NONE' THEN '{}'::text[]
           ELSE coalesce((
             SELECT array_agg(lbl ORDER BY lbl) FROM (
               SELECT CASE cfg.display
                        WHEN 'NAME' THEN u."firstName" || ' ' || u."lastName"
                        ELSE (SELECT e."signature" FROM "TeacherEmployments" e
                                JOIN "StudentGroups" gy ON gy."id" = r."studentGroupId"
                               WHERE e."userId" = u."id" AND e."academicYearId" = gy."academicYearId")
                      END AS lbl
                 FROM "CalendarLessonTeachers" t
                 JOIN "Users" u ON u."id" = t."teacherId"
                WHERE t."calendarLessonId" = r."id"
                  AND t."role" IN ('LEAD', 'ASSISTANT')
                  AND u."schoolId" = r."schoolId"
                  AND u."isActive"
                  AND u."role" IN ('TEACHER', 'SCHOOL_ADMIN')
                  AND NOT EXISTS (SELECT 1 FROM "TeacherPublicLabels" h WHERE h."userId" = u."id" AND h."hidden")
             ) l WHERE lbl IS NOT NULL), '{}'::text[])
         END
    FROM reach r, cfg
$$;

COMMENT ON FUNCTION app.family_lesson_staff(uuid[]) IS
  'Per lesson the caller may see as a family (GUARDIAN) or the school''s admin: whether a substitute holds it, and the teachers as the school names them outside the staff room (publicTeacherDisplay). The API alone calls it.';

-- ---------------------------------------------------------------------------
-- Grants, guarded.
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION app.current_guardian_child_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.current_guardian_class_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.current_guardian_group_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.current_guardian_lesson_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.family_lesson_staff(uuid[]) FROM PUBLIC;

DO $$
DECLARE
  fn text;
  r text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['app.current_guardian_child_ids()', 'app.current_guardian_class_ids()',
                            'app.current_guardian_group_ids()', 'app.current_guardian_lesson_ids()'] LOOP
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
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION app.family_lesson_staff(uuid[]) FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT EXECUTE ON FUNCTION app.family_lesson_staff(uuid[]) TO "app_authenticated";
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- GUARDIAN_REACH: every arm on the six tables that can answer a guardian is
-- a permissive arm for authenticated that checks the role GUARDIAN and the
-- school and keys on a current_guardian_ helper; CalendarLessonTeachers has
-- no such arm at all. An arm reaches a guardian if its name says so or its
-- expression mentions the role, a helper or the link table.
-- ---------------------------------------------------------------------------

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(p.tablename || '.' || p.policyname, ', ' ORDER BY p.tablename, p.policyname) INTO bad
    FROM pg_policies p
   WHERE p.schemaname = 'public'
     AND p.tablename IN ('CalendarLessons', 'CalendarLessonGroups', 'CalendarLessonStudents',
                         'CalendarLunches', 'CalendarRasts', 'CalendarLessonTeachers')
     AND (p.policyname LIKE '%guardian%'
          OR coalesce(p.qual, '') || coalesce(p.with_check, '') LIKE '%GUARDIAN%'
          OR coalesce(p.qual, '') || coalesce(p.with_check, '') LIKE '%current_guardian_%'
          OR coalesce(p.qual, '') || coalesce(p.with_check, '') LIKE '%GuardianStudents%')
     AND (
           p.tablename = 'CalendarLessonTeachers'
        OR p.cmd <> 'SELECT'
        OR p.permissive <> 'PERMISSIVE'
        OR p.roles <> '{authenticated}'::name[]
        OR coalesce(p.qual, '') NOT LIKE '%current_user_role()%= ''GUARDIAN''::"UserRole"%'
        OR coalesce(p.qual, '') NOT LIKE '%current_school_id()%'
        OR coalesce(p.qual, '') NOT LIKE '%current_guardian_%'
        OR coalesce(p.qual, '') LIKE '%GuardianStudents%'
     );
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'GUARDIAN_REACH: these arms reach a guardian without the role, the school and a child helper, or reach a lesson''s teacher rows: %', bad;
  END IF;
END
$$;
