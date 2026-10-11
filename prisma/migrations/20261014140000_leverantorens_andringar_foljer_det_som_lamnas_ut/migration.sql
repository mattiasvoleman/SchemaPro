-- Leverantörens ändringar följer det som lämnas ut.
--
-- 20261014130000 records when an object /ss12000/v2.0 emits changes
-- (Ss12000EntityVersions) or is removed (Ss12000Tombstones), so a consumer
-- that reads with meta.modified.after and /deletedEntities — and a
-- subscription's notice — sees every change S1 Meta.modified names: "den
-- senaste tidpunkt när något av de attribut som direkt tillhör entiteten har
-- ändrats" (S1: SIS openapi_ss12000_version2_1_0.yaml, 2.1.0, sha256
-- aee9a95a4c5bd25cebaf357d266592f94e9388ae785ee9ac3b58e1992acccd28). A
-- review of that migration against a throwaway database found three places
-- where the record and what the gateway emits disagree, and one grant wider
-- than its use. This migration replaces four trigger functions in place
-- (CREATE OR REPLACE keeps their triggers and privileges) and narrows the
-- grant. No table, column, row or policy changes.
--
-- ## A deactivated teacher's Duty disappears, so it is buried
--
-- The gateway emits a Duty only for an active user (Model.duties), so
-- deactivating a teacher removes their Duty from /duties and their duty id
-- from every Activity.teachers and CalendarEvent.teacherExceptions.
-- app.ss12000_v_users buried only the Person: no Duty tombstone, no new
-- meta.modified on the activities and events, no notice. Reproduced: after
-- UPDATE "Users" SET "isActive" = false on a teacher with a post, the only
-- tombstone was (Person, …), and the Duty and Activity versions kept their
-- times. Now a deactivation buries the teacher's emitted duty id of the
-- active year (app.ss12000_duty_id: the source's linked id or the post's),
-- and bumps the activities and lessons naming the teacher; a reactivation
-- unburies it and bumps the post, the activities and the lessons. The same
-- statements app.ss12000_duty_links_moved already runs for a link change.
--
-- ## countsTowardTimplan moves Activity.activityType
--
-- The gateway emits activityType 'Undervisning' for a subject that counts
-- toward the timplan and 'Elevaktivitet' otherwise. app.ss12000_v_subjects
-- bumped the activities only on a name change, so marking a subject as not
-- counting changed every activity of it without moving meta.modified.
-- Reproduced: after the flag went true -> false, the Activity version kept
-- its insert time. countsTowardTimplan is now compared beside name.
--
-- ## No HR side channel through meta.modified
--
-- With shareEmploymentWithIntegrations off (Fas 3), no dutyPercent or
-- hoursPerYear leaves. Yet app.ss12000_v_employments bumped the Duty when
-- employmentPercent or contractKind changed, so the Duty reappeared under
-- meta.modified.after, and a subscriber got a Duty notice with no visible
-- field changed: that told a consumer the teacher's employment terms moved.
-- Reproduced: employmentPercent 100 -> 80 with the opt-in off moved the
-- Duty version. Now employmentPercent and contractKind are compared only in
-- a school that shares them; signature, userId and academicYearId always.
-- app.ss12000_v_staffing_policies likewise bumps the Duties for a changed
-- fullTimeAnnualHours only while sharing is on (or when the opt-in itself
-- changes, which changes what every Duty carries). The gateway's fallback
-- for a post with no version row is its createdAt, not its updatedAt, for
-- the same reason (src/integration/ss12000-v2/model.ts).
--
-- ## Three helpers no API role calls
--
-- app.ss12000_year_is_emitted, app.ss12000_active_year and
-- app.ss12000_duty_id are SECURITY DEFINER and were granted to
-- app_authenticated as if the gateway called them. It does not (the
-- gateway reads the same rules from the rows its principal may see); only
-- the trigger functions above call them, as their owner. Granted, they read
-- across schools past RLS: as app_authenticated with no principal, a
-- TeacherEmployments count was 0 while app.ss12000_duty_id(<school>, …)
-- returned the post's id. EXECUTE is revoked from every API role, as for
-- the other trigger helpers. SS12000_PROVIDER_HELPERS_REACH asserts it.

-- ---------------------------------------------------------------------------
-- Users: a teacher's Duty leaves and returns with the teacher.
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
      PERFORM app.ss12000_bump(r.s, 'Duty', ARRAY(
        SELECT e."id" FROM "TeacherEmployments" e WHERE e."userId" = ANY (r.ids)));
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
-- Subjects: a name or countsTowardTimplan (activityType) moves the activities.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.ss12000_v_subjects() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR r IN SELECT n."schoolId" s, array_agg(n."id") ids FROM n GROUP BY 1 LOOP
      PERFORM app.ss12000_bump(r.s, 'Syllabus', r.ids);
    END LOOP;
  ELSIF TG_OP = 'UPDATE' THEN
    FOR r IN
      SELECT n."schoolId" s, array_agg(n."id") ids FROM n JOIN o ON o."id" = n."id"
       WHERE (n."name", n."nationalCode") IS DISTINCT FROM (o."name", o."nationalCode") GROUP BY 1
    LOOP
      PERFORM app.ss12000_bump(r.s, 'Syllabus', r.ids);
    END LOOP;
    FOR r IN
      SELECT n."schoolId" s, array_agg(n."id") ids FROM n JOIN o ON o."id" = n."id"
       WHERE (n."name", n."countsTowardTimplan") IS DISTINCT FROM (o."name", o."countsTowardTimplan") GROUP BY 1
    LOOP
      PERFORM app.ss12000_bump_activities(r.s, NULL, r.ids, NULL, false);
    END LOOP;
  ELSE
    FOR r IN SELECT o."schoolId" s, array_agg(o."id") ids FROM o GROUP BY 1 LOOP
      PERFORM app.ss12000_bury(r.s, 'Syllabus', r.ids);
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;

-- ---------------------------------------------------------------------------
-- TeacherEmployments and StaffingPolicies: HR figures move a Duty only
-- where the school shares them.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.ss12000_v_employments() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    FOR r IN
      SELECT n."schoolId" s, array_agg(n."id") ids FROM n JOIN o ON o."id" = n."id"
       WHERE (n."signature", n."userId", n."academicYearId") IS DISTINCT FROM (o."signature", o."userId", o."academicYearId")
          OR ((n."employmentPercent", n."contractKind") IS DISTINCT FROM (o."employmentPercent", o."contractKind")
              AND coalesce((SELECT p."shareEmploymentWithIntegrations" FROM "StaffingPolicies" p WHERE p."schoolId" = n."schoolId"), false))
       GROUP BY 1
    LOOP
      PERFORM app.ss12000_bump(r.s, 'Duty', r.ids);
    END LOOP;
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    FOR r IN SELECT n."schoolId" s, array_agg(n."id") ids, array_agg(DISTINCT n."userId") users FROM n GROUP BY 1 LOOP
      PERFORM app.ss12000_bump(r.s, 'Duty', r.ids);
      PERFORM app.ss12000_unbury(r.s, 'Duty', r.ids);
      PERFORM app.ss12000_bump_activities(r.s, NULL, NULL, r.users, false);
      PERFORM app.ss12000_bump_lessons(r.s, ARRAY(SELECT ct."calendarLessonId" FROM "CalendarLessonTeachers" ct WHERE ct."teacherId" = ANY (r.users)));
    END LOOP;
  ELSE
    FOR r IN SELECT o."schoolId" s, array_agg(o."id") ids, array_agg(DISTINCT o."userId") users FROM o GROUP BY 1 LOOP
      PERFORM app.ss12000_bury(r.s, 'Duty', r.ids);
      PERFORM app.ss12000_bump_activities(r.s, NULL, NULL, r.users, false);
      PERFORM app.ss12000_bump_lessons(r.s, ARRAY(SELECT ct."calendarLessonId" FROM "CalendarLessonTeachers" ct WHERE ct."teacherId" = ANY (r.users)));
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION app.ss12000_v_staffing_policies() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR r IN SELECT DISTINCT x."schoolId" s FROM n x WHERE x."shareEmploymentWithIntegrations" LOOP
      PERFORM app.ss12000_bump(r.s, 'Duty', ARRAY(
        SELECT e."id" FROM "TeacherEmployments" e WHERE e."schoolId" = r.s AND e."academicYearId" = app.ss12000_active_year(r.s)));
    END LOOP;
  ELSE
    FOR r IN
      SELECT DISTINCT x."schoolId" s FROM n x JOIN o y ON y."id" = x."id"
       WHERE x."shareEmploymentWithIntegrations" IS DISTINCT FROM y."shareEmploymentWithIntegrations"
          OR (x."shareEmploymentWithIntegrations" AND x."fullTimeAnnualHours" IS DISTINCT FROM y."fullTimeAnnualHours")
    LOOP
      PERFORM app.ss12000_bump(r.s, 'Duty', ARRAY(
        SELECT e."id" FROM "TeacherEmployments" e WHERE e."schoolId" = r.s AND e."academicYearId" = app.ss12000_active_year(r.s)));
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;

-- ---------------------------------------------------------------------------
-- The helpers only the trigger functions call: no API role executes them.
-- ---------------------------------------------------------------------------

DO $$
DECLARE fn text; r text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'app.ss12000_year_is_emitted(uuid)',
    'app.ss12000_active_year(uuid)',
    'app.ss12000_duty_id(uuid, uuid, uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', fn, r);
      END IF;
    END LOOP;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- SS12000_PROVIDER_HELPERS_REACH: no API role may call a helper that reads
-- across schools, and every recorder and trigger function stays revoked.
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
                        'ss12000_duty_links_moved')
          OR p.proname LIKE 'ss12000\_v\_%')
     AND has_function_privilege(r.oid, p.oid, 'EXECUTE');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'SS12000_PROVIDER_HELPERS_REACH: these provider helpers are executable by an API role: %', bad;
  END IF;
END
$$;
