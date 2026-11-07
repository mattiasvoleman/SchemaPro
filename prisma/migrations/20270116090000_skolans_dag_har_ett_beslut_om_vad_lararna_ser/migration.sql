-- Skolans dag har ett beslut om vad lärarna ser.
--
-- The stored half of Skolans dag i ett svep (D5): the school's day and week as
-- grids over its classes, teachers and rooms, and the search for who and what
-- is free over an interval. Everything the page shows is read from tables that
-- exist (CalendarLessons and their teachers, SchoolBreaks, RoomBookings,
-- AvailabilityConstraints, TeacherAbsences, SupervisionShifts); this migration
-- adds the two things it cannot read.
--
--   * SchoolDaySettings         what a TEACHER has of the page. One row per
--                               school; no row = NONE. Decided by those who
--                               decide (rektor, full).
--   * app.school_day_protected_staff()
--                               the ids of the school's staff that the school
--                               marked as having a protected identity, for the
--                               gateway to leave out of the answer a teacher
--                               gets.
--
-- Nothing here changes an existing table. Nothing reaches the engine.
--
-- ## The school decides what its teachers see
--
-- The page is the administrators' (every profile reads it: nothing on it
-- writes). A teacher has what the school lets them, as a rule of the school's
-- own and never a default of the product's (PRODUCT.md): NONE until the school
-- decides, then ROOMS (the free rooms and the rooms' own day and week) or ALL
-- (the classes' and the teachers' lessons as well). Never who is FREE: absence,
-- uppdrag and rastvakt are not a teacher's to read (teacher_absences_own_select,
-- supervision_shifts_teacher_own_select, teacher_duty_slots_teacher_own_select),
-- so a list of free colleagues built from what a teacher can read would call an
-- absent one free. The free teachers are the administrators'.
--
--   school_day_settings_staff_select
--       every administrator and every teacher of the school reads the row: the
--       teacher's page must know whether to show itself, and the gateway reads
--       it to decide what to answer.
--   school_day_settings_admin_insert / _update
--       those who decide write it; the läsare, the expedition and the
--       schemaläggare do not. No arm deletes: the row goes with the school.
--
-- A pupil and a guardian have no arm.
--
-- ## Who is marked, for a teacher
--
-- Skyddad identitet (20270107090000) keeps the marks readable by the
-- administrators alone (person_protections_admin_select). The page names
-- every teacher on the school's day on one screen, which is more than a lesson
-- row a teacher reads one at a time; a person the school has marked is named
-- for administrators only. A teacher's gateway therefore needs to know WHICH
-- staff are marked, and nothing else: app.school_day_protected_staff() answers
-- the ids of the caller's school whose Users row is a TEACHER or a SCHOOL_ADMIN
-- (never a pupil or a guardian: no pupil is ever named on the page, and a list
-- of marked pupils would be the one thing worth stealing), and only to a
-- teacher or an administrator of that school. The gateway uses it to leave
-- the person out of the answer without an id, and counts; it is not an answer
-- of the API.
--
-- ## Beside the live API: Schools at once, or nothing
--
-- Production runs this while the API before it serves requests. The one key
-- (SchoolDaySettings -> Schools) takes Schools in SHARE ROW EXCLUSIVE, which
-- blocks writes to it (not reads, and not the KEY SHARE a foreign-key check
-- takes) for the length of the file; the table is empty, so the key validates
-- nothing. The lock is taken NOWAIT, in a loop: a refusal rolls the
-- subtransaction back and tries again 50 ms later; it never waits while it
-- holds a lock, and no request queues behind it. After 30 s it stops with
-- nothing done and can be rerun (prisma migrate resolve --rolled-back, then
-- deploy). lock_timeout bounds any wait nobody foresaw.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Schools" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Schools was not free in 30 s: nothing is changed, run the migration again (prisma migrate resolve --rolled-back 20270116090000_skolans_dag_har_ett_beslut_om_vad_lararna_ser, then deploy)';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

CREATE TYPE "SchoolDayTeacherView" AS ENUM ('NONE', 'ROOMS', 'ALL');

CREATE TABLE "SchoolDaySettings" (
    "schoolId"    UUID NOT NULL,
    "teacherView" "SchoolDayTeacherView" NOT NULL DEFAULT 'NONE',
    "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "SchoolDaySettings_pkey" PRIMARY KEY ("schoolId")
);

ALTER TABLE "SchoolDaySettings"
    ADD CONSTRAINT "SchoolDaySettings_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- The marked staff of the caller's school, for a teacher's gateway.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.school_day_protected_staff() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT DISTINCT p."userId"
    FROM "PersonProtections" p
    JOIN "Users" u ON u."id" = p."userId" AND u."schoolId" = p."schoolId"
   WHERE p."schoolId" = app.current_school_id()
     AND app.current_user_role() IN ('TEACHER', 'SCHOOL_ADMIN')
     AND u."role" IN ('TEACHER', 'SCHOOL_ADMIN')
$$;

COMMENT ON FUNCTION app.school_day_protected_staff() IS
  'The ids of the caller''s school''s staff (a TEACHER or SCHOOL_ADMIN row) that carry a mark of protected identity, for a teacher or an administrator of that school; nobody else, and never a pupil or a guardian. For the gateway to leave a marked teacher out of the answer a teacher gets from Skolans dag.';

-- ---------------------------------------------------------------------------
-- Row-level security and grants. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "SchoolDaySettings" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    CREATE POLICY "school_day_settings_staff_select" ON "SchoolDaySettings"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) IN ('SCHOOL_ADMIN', 'TEACHER'));
    CREATE POLICY "school_day_settings_admin_insert" ON "SchoolDaySettings"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_decides()));
    CREATE POLICY "school_day_settings_admin_update" ON "SchoolDaySettings"
        FOR UPDATE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_decides()));

    REVOKE ALL ON "SchoolDaySettings" FROM app_authenticated;
    GRANT SELECT, INSERT, UPDATE ON "SchoolDaySettings" TO app_authenticated;

    GRANT EXECUTE ON FUNCTION app.school_day_protected_staff() TO "app_authenticated";
  END IF;

  FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "SchoolDaySettings" FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "SchoolDaySettings" FROM service_role;
  END IF;
  -- PostgreSQL 17's MAINTAIN (REINDEX, CLUSTER, VACUUM, LOCK): the owner's alone.
  IF current_setting('server_version_num')::int >= 170000 THEN
    FOREACH r IN ARRAY ARRAY['authenticated', 'app_authenticated', 'service_role', 'anon'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE MAINTAIN ON "SchoolDaySettings" FROM %I', r);
      END IF;
    END LOOP;
  END IF;

  -- The function answers the API's role alone.
  REVOKE ALL ON FUNCTION app.school_day_protected_staff() FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION app.school_day_protected_staff() FROM %I', r);
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- SCHOOL_DAY_REACH: the arms above and no other. Each names the caller's
-- school and the arm's role, has no OR and no NOT, and a write is behind the
-- decision; a name and a command alone would let `USING (true)` through.
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
   WHERE p.schemaname = 'public' AND p.tablename = 'SchoolDaySettings'
     AND NOT coalesce(
           p.roles = '{app_authenticated}'::name[]
           AND p.permissive = 'PERMISSIVE'
           AND (p.policyname, p.cmd) IN (
                 ('school_day_settings_staff_select', 'SELECT'),
                 ('school_day_settings_admin_insert', 'INSERT'),
                 ('school_day_settings_admin_update', 'UPDATE'))
           AND (SELECT bool_and(
                         e LIKE '%current_school_id()%'
                         AND e NOT LIKE '% OR %'
                         AND e NOT LIKE '%NOT %'
                         AND e LIKE CASE WHEN p.policyname = 'school_day_settings_staff_select'
                                         THEN '%current_user_role()%'
                                         ELSE '%current_user_role()%= ''SCHOOL_ADMIN''::"UserRole"%' END)
                  FROM unnest(ARRAY[p.qual, p.with_check]) e
                 WHERE e IS NOT NULL)
           AND (p.cmd = 'SELECT' OR coalesce(p.with_check, p.qual) LIKE '%current_user_decides()%'),
         false);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'SCHOOL_DAY_REACH: these arms reach SchoolDaySettings beyond the staff''s read and the deciders'' write: %', bad;
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'SchoolDaySettings') <> 3 THEN
    RAISE EXCEPTION 'SCHOOL_DAY_REACH: SchoolDaySettings has % arms, not the three above',
      (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'SchoolDaySettings');
  END IF;
END
$$;
