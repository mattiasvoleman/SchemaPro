-- Ett utkast syns bara för admin.
--
-- A school may now choose publiceringsläge DRAFT (PublicationSettings,
-- 20261011090000): edits to the grundschema stay a draft that teachers,
-- pupils, guardians, the mobile app and SS12000 do not see until an admin
-- publishes them. DIRECT — no settings row, or publishMode DIRECT — is
-- today's behaviour, and nothing below changes a single row it reads.
--
-- ## Where the draft lives
--
-- In DRAFT, MasterLessons IS the draft and the calendar IS the published
-- state, as in DIRECT; what DRAFT adds is that the writers stop carrying an
-- edit into the calendar (the API skips propagate, the delete's calendar
-- sweep, regeneration's sweep and the room optimisation's calendar update),
-- and a publish carries the difference over later. Readers that are not the
-- admin read the calendar — every web and mobile schedule view already does
-- — or, for the grundschema itself (the teacher's figure endpoints, the
-- family statements, SS12000 /activities), the published snapshot
-- (PublishedLessons) instead of MasterLessons.
--
-- ## The RLS predicate
--
-- app.current_school_grundschema_is_live(): true when the caller's school is
-- DIRECT (no settings row counts as DIRECT). STABLE, SECURITY DEFINER (the
-- settings row is the admin's to read; the predicate needs one bit of it),
-- and written as (select …) in every arm so the planner runs it once per
-- statement (initPlan), as the house's other helpers are.
-- app.school_grundschema_is_live(uuid) is the same question for the SS12000
-- service principal's arms, which name their school by parameter.
--
-- Every arm on MasterLessons, MasterLessonGroups, MasterLessonStudents and
-- LunchSittings that admits someone other than the SCHOOL_ADMIN is recreated
-- with the predicate — including the two staff arms 20260713150000
-- generated through format() (masterlessongroups_staff_select,
-- masterlessonstudents_staff_select), which name no master lesson in their
-- policy name and were missed by every list written by hand. In DIRECT the
-- predicate is true and each arm admits exactly whom it admitted. The
-- *_admin_all arms are untouched: the admin reads and writes the draft.
--
-- The migration ends with a guard: it reads pg_policies for the four tables
-- and RAISEs if any SELECT or ALL arm other than an *_admin_all lacks the
-- predicate. An arm forgotten here, or added later without it, fails the
-- deploy instead of leaking a draft in production.
--
-- ## Lessons deleted in a draft
--
-- CalendarLessons.masterLessonId is ON DELETE SET NULL. In DIRECT the API
-- deletes a template's future rows before the template; in DRAFT it must not
-- (the deletion is a draft), so the rows outlive their template and would be
-- orphans nobody can find again. PublicationPendingRemovals records them:
-- a BEFORE DELETE trigger on MasterLessons, in a DRAFT school only, inserts
-- every row of the deleted template that has not begun and carries no
-- attendance — every status, because a cancelled row (a teacher's absence, an
-- avbokning) is just as much a row a later publish must either adopt or
-- leave — with the template's id and whether the row was still SCHEDULED.
-- The next publish adopts a row the new grundschema would materialise on the
-- same date and slot (so a regeneration or a restore keeps its vikarie, room
-- change, note and cancellation), deletes a SCHEDULED one it does not adopt,
-- and leaves the rest orphaned as DIRECT does. Readers that are not the admin
-- key such a row on coalesce(cl."masterLessonId", ppr."masterLessonId") —
-- the published key — so a draft delete moves no teacher's figure.
--
-- The trigger returns at once when pg_trigger_depth() > 1: a cascade (a läsår
-- or a school deleted) arrives through the referential trigger, and a row
-- recorded for a calendar row deleted by the same cascade would fail its own
-- foreign key and turn the year's deletion into an error. It is SECURITY
-- DEFINER, owned by the migration owner; a second guard refuses every other
-- INSERT or UPDATE of the table, and TRUNCATE.
--
-- calendarLessonId is the primary key and a composite (id, schoolId) key to
-- CalendarLessons, ON DELETE CASCADE: a recorded row deleted by the publish,
-- or by an admin by hand, takes its record with it. That key needs a unique
-- index on CalendarLessons(id, schoolId), created here. It is the one
-- statement in this migration that scans a hot table: on production
-- (≈114 000 rows) it holds a write lock on CalendarLessons for the length of
-- an index build, measured before the deploy.
--
-- ## The publication lock
--
-- app.enter_grundschema_write(school): the FIRST statement of every
-- grundschema writer. It takes the shared lock
-- pg_advisory_xact_lock_shared(hashtext('publication'), hashtext(school))
-- under a 5 s lock_timeout (restored afterwards) and answers the school's
-- mode — so a writer reads the mode in the same statement that orders it
-- against a publish. One statement more on every master create, update and
-- delete, regeneration, room optimisation and restore, in DIRECT too.
-- app.enter_publication(school) takes the same key EXCLUSIVELY (10 s); only
-- a DRAFT publish, its preview, a discard, a refill and a mode switch take
-- it, so a DIRECT school's writers never wait for anything but a mode switch.
-- Both refuse a school that is not the caller's.
--
-- ## Row-level security on the new table
--
--   * publication_pending_removals_admin_select / _admin_delete: the admin
--     reads the pending rows (the state and the preview) and the publish
--     deletes them.
--   * publication_pending_removals_staff_select: a TEACHER, so the teacher
--     figure endpoints can join the published key (ids only).
--   * publication_pending_removals_service_select: SS12000 calendarEvents.
--
-- No INSERT or UPDATE arm: only the trigger writes. No STUDENT or GUARDIAN
-- arm. Grants guarded; anon, authenticated and service_role hold no write.

-- ---------------------------------------------------------------------------
-- The mode, as one word, and the predicate.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.school_publish_mode(school uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT coalesce((SELECT s."publishMode"::text FROM "PublicationSettings" s WHERE s."schoolId" = school), 'DIRECT')
$$;

CREATE FUNCTION app.school_grundschema_is_live(school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT app.school_publish_mode(school) = 'DIRECT'
$$;

CREATE FUNCTION app.current_school_grundschema_is_live() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT app.school_grundschema_is_live(app.current_school_id())
$$;

CREATE FUNCTION app.enter_grundschema_write(school uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  previous text := current_setting('lock_timeout');
BEGIN
  IF school IS DISTINCT FROM app.current_school_id() THEN
    RAISE EXCEPTION 'PUBLICATION_LOCK_NOT_YOURS: en skola tar bara sitt eget publiceringslås'
      USING ERRCODE = 'PB403';
  END IF;
  PERFORM set_config('lock_timeout', '5s', true);
  PERFORM pg_advisory_xact_lock_shared(hashtext('publication'), hashtext(school::text));
  PERFORM set_config('lock_timeout', previous, true);
  RETURN app.school_publish_mode(school);
END
$$;

CREATE FUNCTION app.enter_publication(school uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  previous text := current_setting('lock_timeout');
BEGIN
  IF school IS DISTINCT FROM app.current_school_id() THEN
    RAISE EXCEPTION 'PUBLICATION_LOCK_NOT_YOURS: en skola tar bara sitt eget publiceringslås'
      USING ERRCODE = 'PB403';
  END IF;
  PERFORM set_config('lock_timeout', '10s', true);
  PERFORM pg_advisory_xact_lock(hashtext('publication'), hashtext(school::text));
  PERFORM set_config('lock_timeout', previous, true);
  RETURN app.school_publish_mode(school);
END
$$;

-- ---------------------------------------------------------------------------
-- Every arm that admits somebody other than the admin, recreated with the
-- predicate. The admin arms stay as they are.
-- ---------------------------------------------------------------------------

DROP POLICY "master_lessons_staff_select" ON "MasterLessons";
CREATE POLICY "master_lessons_staff_select" ON "MasterLessons"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) IN ('TEACHER', 'SCHOOL_ADMIN')
        AND ((select app.current_user_role()) = 'SCHOOL_ADMIN' OR (select app.current_school_grundschema_is_live()))
    );

DROP POLICY "master_lessons_student_select" ON "MasterLessons";
CREATE POLICY "master_lessons_student_select" ON "MasterLessons"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND "studentGroupId" = (select app.current_user_group_id())
        AND (select app.current_school_grundschema_is_live())
    );

DROP POLICY "master_lessons_participant_select" ON "MasterLessons";
CREATE POLICY "master_lessons_participant_select" ON "MasterLessons"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_school_grundschema_is_live())
        AND (
            EXISTS (SELECT 1 FROM "MasterLessonStudents" mls
                     WHERE mls."masterLessonId" = "MasterLessons"."id"
                       AND mls."studentId" = (select app.current_user_id()))
            OR EXISTS (SELECT 1 FROM "MasterLessonGroups" mlg
                        WHERE mlg."masterLessonId" = "MasterLessons"."id"
                          AND mlg."studentGroupId" = (select app.current_user_group_id()))
        )
    );

DROP POLICY "master_lessons_service_select" ON "MasterLessons";
CREATE POLICY "master_lessons_service_select" ON "MasterLessons"
    FOR SELECT
    USING ("schoolId" = app.current_service_school_id() AND app.school_grundschema_is_live("schoolId"));

DROP POLICY "master_lesson_groups_member_select" ON "MasterLessonGroups";
CREATE POLICY "master_lesson_groups_member_select" ON "MasterLessonGroups"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND "studentGroupId" = (select app.current_user_group_id())
        AND (select app.current_school_grundschema_is_live())
    );

DROP POLICY "masterlessongroups_staff_select" ON "MasterLessonGroups";
CREATE POLICY "masterlessongroups_staff_select" ON "MasterLessonGroups"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) IN ('TEACHER', 'SCHOOL_ADMIN')
        AND ((select app.current_user_role()) = 'SCHOOL_ADMIN' OR (select app.current_school_grundschema_is_live()))
    );

DROP POLICY "master_lesson_groups_service_select" ON "MasterLessonGroups";
CREATE POLICY "master_lesson_groups_service_select" ON "MasterLessonGroups"
    FOR SELECT
    USING ("schoolId" = app.current_service_school_id() AND app.school_grundschema_is_live("schoolId"));

DROP POLICY "master_lesson_students_self_select" ON "MasterLessonStudents";
CREATE POLICY "master_lesson_students_self_select" ON "MasterLessonStudents"
    FOR SELECT TO "authenticated"
    USING (
        "studentId" = (select app.current_user_id())
        AND (select app.current_school_grundschema_is_live())
    );

DROP POLICY "masterlessonstudents_staff_select" ON "MasterLessonStudents";
CREATE POLICY "masterlessonstudents_staff_select" ON "MasterLessonStudents"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) IN ('TEACHER', 'SCHOOL_ADMIN')
        AND ((select app.current_user_role()) = 'SCHOOL_ADMIN' OR (select app.current_school_grundschema_is_live()))
    );

DROP POLICY "master_lesson_students_service_select" ON "MasterLessonStudents";
CREATE POLICY "master_lesson_students_service_select" ON "MasterLessonStudents"
    FOR SELECT
    USING ("schoolId" = app.current_service_school_id() AND app.school_grundschema_is_live("schoolId"));

DROP POLICY "lunch_sittings_staff_select" ON "LunchSittings";
CREATE POLICY "lunch_sittings_staff_select" ON "LunchSittings"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) IN ('TEACHER', 'SCHOOL_ADMIN')
        AND ((select app.current_user_role()) = 'SCHOOL_ADMIN' OR (select app.current_school_grundschema_is_live()))
    );

DROP POLICY "lunch_sittings_student_select" ON "LunchSittings";
CREATE POLICY "lunch_sittings_student_select" ON "LunchSittings"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND "studentGroupId" = (select app.current_user_group_id())
        AND (select app.current_school_grundschema_is_live())
    );

DROP POLICY "lunch_sittings_guardian_select" ON "LunchSittings";
CREATE POLICY "lunch_sittings_guardian_select" ON "LunchSittings"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_school_grundschema_is_live())
        AND "studentGroupId" IN (
            SELECT u."studentGroupId"
              FROM "Users" u
              JOIN "GuardianStudents" gs ON gs."studentId" = u."id"
             WHERE gs."guardianId" = (select app.current_user_id())
               AND gs."schoolId" = (select app.current_school_id())
               AND u."studentGroupId" IS NOT NULL
        )
    );

-- ---------------------------------------------------------------------------
-- Lessons deleted in a draft. See the preamble.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX "CalendarLessons_id_schoolId_key" ON "CalendarLessons"("id", "schoolId");

CREATE TABLE "PublicationPendingRemovals" (
    "calendarLessonId" UUID NOT NULL,
    "schoolId"         UUID NOT NULL,
    "academicYearId"   UUID NOT NULL,
    "masterLessonId"   UUID NOT NULL,
    "reconcilable"     BOOLEAN NOT NULL,
    "recordedAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "PublicationPendingRemovals_pkey" PRIMARY KEY ("calendarLessonId")
);

CREATE INDEX "PublicationPendingRemovals_academicYearId_schoolId_idx"
    ON "PublicationPendingRemovals"("academicYearId", "schoolId");
CREATE INDEX "PublicationPendingRemovals_schoolId_idx" ON "PublicationPendingRemovals"("schoolId");

ALTER TABLE "PublicationPendingRemovals"
    ADD CONSTRAINT "PublicationPendingRemovals_calendarLessonId_schoolId_fkey"
    FOREIGN KEY ("calendarLessonId", "schoolId") REFERENCES "CalendarLessons"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PublicationPendingRemovals"
    ADD CONSTRAINT "PublicationPendingRemovals_academicYearId_schoolId_fkey"
    FOREIGN KEY ("academicYearId", "schoolId") REFERENCES "AcademicYears"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Only the trigger below writes; it says so by setting this for its own insert.
CREATE FUNCTION app.publication_pending_removals_only_by_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' OR current_setting('app.recording_pending_removals', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'PUBLICATION_PENDING_IS_RECORDED: bara raderingen av en lektion i ett utkast skriver hit'
      USING ERRCODE = 'PB409';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PublicationPendingRemovals_only_by_trigger"
    BEFORE INSERT OR UPDATE ON "PublicationPendingRemovals"
    FOR EACH ROW EXECUTE FUNCTION app.publication_pending_removals_only_by_trigger();
CREATE TRIGGER "PublicationPendingRemovals_no_truncate"
    BEFORE TRUNCATE ON "PublicationPendingRemovals"
    FOR EACH STATEMENT EXECUTE FUNCTION app.publication_pending_removals_only_by_trigger();

CREATE FUNCTION app.master_lessons_record_pending_removals() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  -- A cascade (a läsår or a school deleted) needs no record, and could not
  -- keep one: the calendar rows go in the same cascade.
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  IF app.school_publish_mode(OLD."schoolId") <> 'DRAFT' THEN
    RETURN OLD;
  END IF;
  PERFORM set_config('app.recording_pending_removals', 'on', true);
  INSERT INTO "PublicationPendingRemovals" ("calendarLessonId", "schoolId", "academicYearId", "masterLessonId", "reconcilable")
  SELECT cl."id", cl."schoolId", OLD."academicYearId", OLD."id", cl."status" = 'SCHEDULED'
    FROM "CalendarLessons" cl
   WHERE cl."masterLessonId" = OLD."id"
     AND cl."schoolId" = OLD."schoolId"
     AND cl."startsAt" > now()
     AND NOT EXISTS (SELECT 1 FROM "AttendanceRecords" a WHERE a."calendarLessonId" = cl."id")
  ON CONFLICT ("calendarLessonId") DO NOTHING;
  PERFORM set_config('app.recording_pending_removals', 'off', true);
  RETURN OLD;
END
$$;

CREATE TRIGGER "MasterLessons_record_pending_removals"
    BEFORE DELETE ON "MasterLessons"
    FOR EACH ROW EXECUTE FUNCTION app.master_lessons_record_pending_removals();

REVOKE ALL ON FUNCTION app.publication_pending_removals_only_by_trigger() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.master_lessons_record_pending_removals() FROM PUBLIC;

ALTER TABLE "PublicationPendingRemovals" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "publication_pending_removals_admin_select" ON "PublicationPendingRemovals"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
CREATE POLICY "publication_pending_removals_admin_delete" ON "PublicationPendingRemovals"
    FOR DELETE TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
CREATE POLICY "publication_pending_removals_staff_select" ON "PublicationPendingRemovals"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'TEACHER');
CREATE POLICY "publication_pending_removals_service_select" ON "PublicationPendingRemovals"
    FOR SELECT
    USING ("schoolId" = app.current_service_school_id());

-- ---------------------------------------------------------------------------
-- Grants. The predicate functions are called from policies, so every role a
-- policy is evaluated for may execute them; the lock functions are the API's.
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION app.enter_grundschema_write(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enter_publication(uuid) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT SELECT, DELETE ON "PublicationPendingRemovals" TO "app_authenticated";
    REVOKE INSERT, UPDATE, TRUNCATE, REFERENCES, TRIGGER ON "PublicationPendingRemovals" FROM "app_authenticated";
    GRANT EXECUTE ON FUNCTION app.enter_grundschema_write(uuid) TO "app_authenticated";
    GRANT EXECUTE ON FUNCTION app.enter_publication(uuid) TO "app_authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE INSERT, UPDATE, TRUNCATE, REFERENCES, TRIGGER ON "PublicationPendingRemovals" FROM "authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "PublicationPendingRemovals" FROM "anon";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "PublicationPendingRemovals" FROM "service_role";
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- The guard: no arm but the admin's reads these tables without the predicate.
-- ---------------------------------------------------------------------------

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(tablename || '.' || policyname, ', ' ORDER BY tablename, policyname) INTO bad
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('MasterLessons', 'MasterLessonGroups', 'MasterLessonStudents', 'LunchSittings')
     AND cmd IN ('SELECT', 'ALL')
     AND policyname NOT LIKE '%admin_all'
     AND coalesce(qual, '') NOT LIKE '%grundschema_is_live%';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'DRAFT_LEAK: these arms read the grundschema without the publish predicate: %', bad;
  END IF;
END
$$;
