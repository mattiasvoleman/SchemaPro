-- En kalenderhändelse säger vilka av gruppens elever som inte är med.
--
-- Elevlistan i uppföljningen (omgång 7). #201 (20261211090000) made a
-- replacing group take its members off its subject's other lessons: SvA7
-- replaces Svenska, so Alva of 7A and SvA7 is not on 7A's svenska. Its
-- design note left SS12000 to this phase ("app.ss12000_v_groups jämför bara
-- namn, kind, årskurs, läsår och ss12000Id. En ändrad ersättning syns därför
-- inte i SS12000-flödet").
--
-- The gateway now sends that as S1 says it: a CalendarEvent of 7A's svenska
-- carries studentExceptions [{student: Alva, participates: false}]
-- (src/integration/ss12000-v2/ss12000-v2.service.ts, by the one rule in
-- src/common/replacing-groups.ts lessonPupils). studentExceptions is an
-- attribute "som direkt tillhör entiteten" (S1 Meta.modified), so the event's
-- meta.modified — and a subscription's notice — must move whenever that list
-- may change. Nothing recorded it: a pupil joining SvA7 moved the Group, not
-- 7A's events, and setting replacesSubjectId moved nothing at all.
--
-- ## What moves now
--
--   StudentGroupMembers   a membership in or out: the pupil's events in a
--                         subject one of their replacing groups replaces (in
--                         that group's läsår) — those that carry the row's
--                         group, and, when the row's group itself replaces a
--                         subject, every one of that subject that carries a
--                         group of theirs (home class, teaching groups).
--   StudentGroups         replacesSubjectId set, moved or ended, or kind
--                         changed (which decides whether a teaching group's
--                         own lessons keep its members on, keptByOf): the
--                         same, for the group's members, over the old and
--                         the new subject. A replacing group removed: every
--                         event of its subject in its läsår (its members
--                         went first, by the cascade, so who it took off is
--                         no longer known; a removal is rare).
--   Users                 a class move (studentGroupId): the same, for the
--                         class left and the class joined; a relinked
--                         ss12000Id (A5.3, "everything that names the person
--                         moves"): every event that may name them as not
--                         participating, beside those naming them as
--                         participating.
--
-- Deactivation is unchanged: a deactivated pupil leaves every exception, as
-- one named on a lesson always has, and the Person's tombstone says so
-- (20261014130000). CalendarLessons, CalendarLessonGroups and
-- CalendarLessonStudents already move their event on any change.
--
-- A statement's pupils are read together (a membership import, an
-- activation): over a batch an event may move that changed for none of
-- them — a consumer reads it again — and none that changed is missed. A
-- school with no replacing group reads one empty list and moves nothing more
-- than before.
--
-- ## How
--
-- One new helper, app.ss12000_bump_replaced, SECURITY DEFINER with a locked
-- search_path like every bump helper, and executable by no API role
-- (SS12000_PROVIDER_HELPERS_REACH below; RLS suite sections 282–283). The
-- three trigger functions are replaced in place: CREATE OR REPLACE keeps
-- their triggers and their (revoked) privileges and takes no lock on any
-- table, so no NOWAIT loop is needed. Each body is the one it replaces with
-- the lines above added; the guard below stops the migration, changing
-- nothing, if any of the three is not the body 20261014130000/140000 wrote.
--
-- No table, column, row, policy or grant on a table changes.

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(f.name, ', ' ORDER BY f.name) INTO bad
    FROM (VALUES ('ss12000_v_users', '76d25707cfb54ccb33826b7aa2532b14'),
                 ('ss12000_v_group_members', '29f18a20dcaf07e2322364b5134d0163'),
                 ('ss12000_v_groups', 'b5e5bdcc3b014044e75125edf9dd9ea8')) AS f(name, md5)
   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                      WHERE ns.nspname = 'app' AND p.proname = f.name AND md5(p.prosrc) = f.md5);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'SS12000_REPLACED_TRIGGERS_MOVED: % is not the body this migration replaces; nothing is changed', bad;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- The events whose studentExceptions THE RULE may change for these pupils.
-- ---------------------------------------------------------------------------
--
-- "Theirs" are p_pupils' groups (home class and teaching groups) and
-- p_groups, the groups that changed for them (a membership's group, the
-- class left and the class joined). "Replaced" are the (subject, läsår) pairs
-- of the replacing groups among theirs; "changed" are those among p_groups,
-- with the (p_subjects[i], p_years[i]) pairs given (a replacement just moved
-- or ended) in both. A CalendarLesson moves (app.ss12000_bump_lessons, which
-- keeps to the emitted years) when its subject and its own group's läsår are
-- replaced, one of its groups (own or extra) is theirs, and it is the
-- change's: one of its groups changed, or its pair did. p_groups NULL: every
-- event that may list the pupils (their emitted id moved).

CREATE FUNCTION app.ss12000_bump_replaced(
  p_school uuid, p_pupils uuid[], p_groups uuid[], p_subjects uuid[] DEFAULT NULL, p_years uuid[] DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  theirs uuid[];
  subjects uuid[];
  years uuid[];
  changed_subjects uuid[];
  changed_years uuid[];
BEGIN
  IF p_school IS NULL THEN
    RETURN;
  END IF;
  theirs := ARRAY(
    SELECT u."studentGroupId" FROM "Users" u
     WHERE u."schoolId" = p_school AND u."id" = ANY (coalesce(p_pupils, '{}'::uuid[])) AND u."studentGroupId" IS NOT NULL
    UNION
    SELECT m."studentGroupId" FROM "StudentGroupMembers" m
     WHERE m."schoolId" = p_school AND m."studentId" = ANY (coalesce(p_pupils, '{}'::uuid[]))
    UNION
    SELECT x FROM unnest(coalesce(p_groups, '{}'::uuid[])) x WHERE x IS NOT NULL);
  SELECT array_agg(pair.s), array_agg(pair.y) INTO subjects, years FROM (
    SELECT r."replacesSubjectId" s, r."academicYearId" y FROM "StudentGroups" r
     WHERE r."schoolId" = p_school AND r."replacesSubjectId" IS NOT NULL AND r."id" = ANY (theirs)
    UNION
    SELECT x.s, x.y FROM unnest(coalesce(p_subjects, '{}'::uuid[]), coalesce(p_years, '{}'::uuid[])) AS x(s, y)
     WHERE x.s IS NOT NULL AND x.y IS NOT NULL
  ) pair;
  IF subjects IS NULL THEN
    RETURN;
  END IF;
  SELECT array_agg(pair.s), array_agg(pair.y) INTO changed_subjects, changed_years FROM (
    SELECT r."replacesSubjectId" s, r."academicYearId" y FROM "StudentGroups" r
     WHERE r."schoolId" = p_school AND r."replacesSubjectId" IS NOT NULL AND r."id" = ANY (coalesce(p_groups, '{}'::uuid[]))
    UNION
    SELECT x.s, x.y FROM unnest(coalesce(p_subjects, '{}'::uuid[]), coalesce(p_years, '{}'::uuid[])) AS x(s, y)
     WHERE x.s IS NOT NULL AND x.y IS NOT NULL
  ) pair;
  PERFORM app.ss12000_bump_lessons(p_school, ARRAY(
    SELECT c."id" FROM unnest(subjects, years) AS rp(s, y)
      JOIN "CalendarLessons" c ON c."schoolId" = p_school AND c."subjectId" = rp.s
      JOIN "StudentGroups" own ON own."id" = c."studentGroupId" AND own."academicYearId" = rp.y
     WHERE (c."studentGroupId" = ANY (theirs)
            OR EXISTS (SELECT 1 FROM "CalendarLessonGroups" cg
                        WHERE cg."calendarLessonId" = c."id" AND cg."studentGroupId" = ANY (theirs)))
       AND (p_groups IS NULL
            OR c."studentGroupId" = ANY (p_groups)
            OR EXISTS (SELECT 1 FROM "CalendarLessonGroups" cg
                        WHERE cg."calendarLessonId" = c."id" AND cg."studentGroupId" = ANY (p_groups))
            OR EXISTS (SELECT 1 FROM unnest(changed_subjects, changed_years) AS cp(s, y)
                        WHERE cp.s = c."subjectId" AND cp.y = own."academicYearId"))));
END
$$;

-- ---------------------------------------------------------------------------
-- StudentGroupMembers: a membership in or out.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.ss12000_v_group_members() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record;
BEGIN
  IF TG_OP <> 'DELETE' THEN
    FOR r IN SELECT x."schoolId" s, array_agg(DISTINCT x."studentGroupId") groups, array_agg(DISTINCT x."studentId") pupils FROM n x GROUP BY 1 LOOP
      PERFORM app.ss12000_bump_groups(r.s, r.groups);
      PERFORM app.ss12000_bump_replaced(r.s, r.pupils, r.groups);
    END LOOP;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    FOR r IN SELECT x."schoolId" s, array_agg(DISTINCT x."studentGroupId") groups, array_agg(DISTINCT x."studentId") pupils FROM o x GROUP BY 1 LOOP
      PERFORM app.ss12000_bump_groups(r.s, r.groups);
      PERFORM app.ss12000_bump_replaced(r.s, r.pupils, r.groups);
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;


-- ---------------------------------------------------------------------------
-- StudentGroups: a replacement set, moved or ended; a kind; a removal.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.ss12000_v_groups() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR r IN SELECT n."schoolId" s, array_agg(n."id") ids FROM n GROUP BY 1 LOOP
      PERFORM app.ss12000_bump_groups(r.s, r.ids);
    END LOOP;
  ELSIF TG_OP = 'UPDATE' THEN
    FOR r IN
      SELECT n."schoolId" s, array_agg(n."id") ids FROM n JOIN o ON o."id" = n."id"
       WHERE (n."name", n."kind", n."gradeLevel", n."academicYearId", n."ss12000Id")
             IS DISTINCT FROM (o."name", o."kind", o."gradeLevel", o."academicYearId", o."ss12000Id")
       GROUP BY 1
    LOOP
      PERFORM app.ss12000_bump_groups(r.s, r.ids);
    END LOOP;
    FOR r IN
      SELECT n."schoolId" s, array_agg(n."id") ids FROM n JOIN o ON o."id" = n."id"
       WHERE (n."name", n."ss12000Id") IS DISTINCT FROM (o."name", o."ss12000Id")
       GROUP BY 1
    LOOP
      PERFORM app.ss12000_bump_activities(r.s, r.ids, NULL, NULL, false);
    END LOOP;
    -- Ersättande grupper: a replacement set, moved or ended, or a kind that
    -- decides whether a group's own lessons keep its members on (keptByOf),
    -- changes which of its members' events list them as not participating.
    FOR r IN
      SELECT n."schoolId" s, n."id" g, n."academicYearId" y, o."replacesSubjectId" was, n."replacesSubjectId" now
        FROM n JOIN o ON o."id" = n."id"
       WHERE (n."replacesSubjectId", n."kind") IS DISTINCT FROM (o."replacesSubjectId", o."kind")
    LOOP
      PERFORM app.ss12000_bump_replaced(r.s,
        ARRAY(SELECT m."studentId" FROM "StudentGroupMembers" m WHERE m."studentGroupId" = r.g
              UNION SELECT u."id" FROM "Users" u WHERE u."studentGroupId" = r.g),
        ARRAY[r.g], ARRAY[r.was, r.now], ARRAY[r.y, r.y]);
    END LOOP;
    FOR r IN
      SELECT n."schoolId" s, array_agg(coalesce(o."ss12000Id", o."id")) old_ids, array_agg(coalesce(n."ss12000Id", n."id")) new_ids
        FROM n JOIN o ON o."id" = n."id"
       WHERE o."ss12000Id" IS DISTINCT FROM n."ss12000Id" AND app.ss12000_year_is_emitted(n."academicYearId")
       GROUP BY 1
    LOOP
      PERFORM app.ss12000_bury(r.s, 'Group', r.old_ids);
      PERFORM app.ss12000_unbury(r.s, 'Group', r.new_ids);
    END LOOP;
  ELSE
    FOR r IN
      SELECT o."schoolId" s, array_agg(coalesce(o."ss12000Id", o."id")) ids FROM o
       WHERE app.ss12000_year_is_emitted(o."academicYearId") GROUP BY 1
    LOOP
      PERFORM app.ss12000_bury(r.s, 'Group', r.ids);
    END LOOP;
    -- A replacing group removed: its memberships went before this statement
    -- trigger runs (the foreign key's cascade), so who it took off is no
    -- longer known. Every event of its subject in its läsår moves; a
    -- removal is rare, and a consumer reads an unchanged event again.
    FOR r IN SELECT o."schoolId" s, o."replacesSubjectId" subject, o."academicYearId" y FROM o WHERE o."replacesSubjectId" IS NOT NULL LOOP
      PERFORM app.ss12000_bump_lessons(r.s, ARRAY(
        SELECT c."id" FROM "CalendarLessons" c JOIN "StudentGroups" own ON own."id" = c."studentGroupId"
         WHERE c."schoolId" = r.s AND c."subjectId" = r.subject AND own."academicYearId" = r.y));
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;


-- ---------------------------------------------------------------------------
-- Users: a class move; a relinked emitted id.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.ss12000_v_users() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR r IN SELECT n."schoolId" s, array_agg(n."id") ids FROM n WHERE n."isActive" GROUP BY 1 LOOP
      PERFORM app.ss12000_bump(r.s, 'Person', r.ids);
    END LOOP;
  ELSIF TG_OP = 'UPDATE' THEN
    FOR r IN
      SELECT n."schoolId" s, array_agg(n."id") ids FROM n JOIN o ON o."id" = n."id"
       WHERE (n."firstName", n."lastName", n."email", n."role", n."isActive", n."ss12000Id")
             IS DISTINCT FROM (o."firstName", o."lastName", o."email", o."role", o."isActive", o."ss12000Id")
       GROUP BY 1
    LOOP
      PERFORM app.ss12000_bump(r.s, 'Person', r.ids);
    END LOOP;
    -- Deactivated, or relinked: the id the consumer had is gone.
    FOR r IN
      SELECT o."schoolId" s, array_agg(coalesce(o."ss12000Id", o."id")) ids FROM n JOIN o ON o."id" = n."id"
       WHERE o."isActive" AND (NOT n."isActive" OR o."ss12000Id" IS DISTINCT FROM n."ss12000Id")
       GROUP BY 1
    LOOP
      PERFORM app.ss12000_bury(r.s, 'Person', r.ids);
    END LOOP;
    -- Live again under an id: no longer deleted.
    FOR r IN
      SELECT n."schoolId" s, array_agg(coalesce(n."ss12000Id", n."id")) ids FROM n JOIN o ON o."id" = n."id"
       WHERE n."isActive" AND (NOT o."isActive" OR o."ss12000Id" IS DISTINCT FROM n."ss12000Id")
       GROUP BY 1
    LOOP
      PERFORM app.ss12000_unbury(r.s, 'Person', r.ids);
    END LOOP;
    -- Deactivated: the teacher's Duty of the active year leaves with them,
    -- and every activity and event naming them changes.
    FOR r IN
      SELECT n."schoolId" s, array_agg(n."id") ids FROM n JOIN o ON o."id" = n."id"
       WHERE o."isActive" AND NOT n."isActive"
       GROUP BY 1
    LOOP
      PERFORM app.ss12000_bury(r.s, 'Duty', ARRAY(
        SELECT app.ss12000_duty_id(r.s, u, app.ss12000_active_year(r.s)) FROM unnest(r.ids) u));
      PERFORM app.ss12000_bump_activities(r.s, NULL, NULL, r.ids, false);
      PERFORM app.ss12000_bump_lessons(r.s, ARRAY(
        SELECT ct."calendarLessonId" FROM "CalendarLessonTeachers" ct WHERE ct."teacherId" = ANY (r.ids)));
    END LOOP;
    -- Reactivated: it returns.
    FOR r IN
      SELECT n."schoolId" s, array_agg(n."id") ids FROM n JOIN o ON o."id" = n."id"
       WHERE n."isActive" AND NOT o."isActive"
       GROUP BY 1
    LOOP
      PERFORM app.ss12000_unbury(r.s, 'Duty', ARRAY(
        SELECT app.ss12000_duty_id(r.s, u, app.ss12000_active_year(r.s)) FROM unnest(r.ids) u));
      PERFORM app.ss12000_bump(r.s, 'Duty', ARRAY(
        SELECT e."id" FROM "TeacherEmployments" e
         WHERE e."schoolId" = r.s AND e."userId" = ANY (r.ids) AND e."academicYearId" = app.ss12000_active_year(r.s)));
      PERFORM app.ss12000_bump_activities(r.s, NULL, NULL, r.ids, false);
      PERFORM app.ss12000_bump_lessons(r.s, ARRAY(
        SELECT ct."calendarLessonId" FROM "CalendarLessonTeachers" ct WHERE ct."teacherId" = ANY (r.ids)));
    END LOOP;
    -- The emitted id moved: everything that names the person moves (A5.3).
    FOR r IN
      SELECT n."schoolId" s, array_agg(n."id") ids FROM n JOIN o ON o."id" = n."id"
       WHERE o."ss12000Id" IS DISTINCT FROM n."ss12000Id" AND n."isActive"
       GROUP BY 1
    LOOP
      PERFORM app.ss12000_bump_groups(r.s, ARRAY(
        SELECT e."studentGroupId" FROM "StudentEnrollments" e WHERE e."studentId" = ANY (r.ids) AND e."studentGroupId" IS NOT NULL
        UNION SELECT m."studentGroupId" FROM "StudentGroupMembers" m WHERE m."studentId" = ANY (r.ids)));
      PERFORM app.ss12000_bump(r.s, 'Person', ARRAY(
        SELECT gs."studentId" FROM "GuardianStudents" gs WHERE gs."guardianId" = ANY (r.ids)
        UNION SELECT gs."guardianId" FROM "GuardianStudents" gs WHERE gs."studentId" = ANY (r.ids)));
      PERFORM app.ss12000_bump_lessons(r.s, ARRAY(
        SELECT cs."calendarLessonId" FROM "CalendarLessonStudents" cs WHERE cs."studentId" = ANY (r.ids)));
      -- The events that name them as not participating (ersättande grupper).
      PERFORM app.ss12000_bump_replaced(r.s, r.ids, NULL);
      PERFORM app.ss12000_bump(r.s, 'Duty', ARRAY(
        SELECT e."id" FROM "TeacherEmployments" e WHERE e."userId" = ANY (r.ids)));
    END LOOP;
    -- A pupil who moves class leaves the old class's events and joins the new
    -- one's: where a group of theirs replaces the subject, an event that
    -- named them as not participating no longer does, and one of the new
    -- class's does (ersättande grupper).
    FOR r IN
      SELECT n."schoolId" s, array_agg(n."id") ids, array_agg(o."studentGroupId") || array_agg(n."studentGroupId") moved
        FROM n JOIN o ON o."id" = n."id"
       WHERE o."studentGroupId" IS DISTINCT FROM n."studentGroupId"
       GROUP BY 1
    LOOP
      PERFORM app.ss12000_bump_replaced(r.s, r.ids, r.moved);
    END LOOP;
  ELSE
    FOR r IN SELECT o."schoolId" s, array_agg(coalesce(o."ss12000Id", o."id")) ids FROM o WHERE o."isActive" GROUP BY 1 LOOP
      PERFORM app.ss12000_bury(r.s, 'Person', r.ids);
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;


-- ---------------------------------------------------------------------------
-- The helper only the trigger functions call: no API role executes it.
-- ---------------------------------------------------------------------------

DO $$
DECLARE r text;
BEGIN
  REVOKE ALL ON FUNCTION app.ss12000_bump_replaced(uuid, uuid[], uuid[], uuid[], uuid[]) FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION app.ss12000_bump_replaced(uuid, uuid[], uuid[], uuid[], uuid[]) FROM %I', r);
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- SS12000_PROVIDER_HELPERS_REACH, as 20261014140000 asserts it, with the new
-- helper: no API role may call a helper that reads across schools, and
-- every trigger function stays revoked.
-- ---------------------------------------------------------------------------

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(format('%s by %s', p.oid::regprocedure, r.rolname), ', ' ORDER BY 1) INTO bad
    FROM pg_proc p
    JOIN pg_namespace ns ON ns.oid = p.pronamespace AND ns.nspname = 'app'
    CROSS JOIN pg_roles r
   WHERE r.rolname IN ('anon', 'authenticated', 'service_role', 'app_authenticated')
     AND (p.proname IN ('ss12000_year_is_emitted', 'ss12000_active_year', 'ss12000_duty_id',
                        'ss12000_bump', 'ss12000_bury', 'ss12000_unbury', 'ss12000_bump_groups',
                        'ss12000_bump_lessons', 'ss12000_bump_activities', 'ss12000_bump_school',
                        'ss12000_duty_links_moved', 'ss12000_bump_replaced')
          OR p.proname LIKE 'ss12000\_v\_%')
     AND has_function_privilege(r.oid, p.oid, 'EXECUTE');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'SS12000_PROVIDER_HELPERS_REACH: these provider helpers are executable by an API role: %', bad;
  END IF;
END
$$;
