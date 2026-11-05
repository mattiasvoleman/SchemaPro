-- Skolan minns att en person har skyddad identitet.
--
-- A school can now say that a person has a protected identity (skyddad
-- identitet), and the files Rastra writes about people leave that person
-- out. Until now Rastra kept no such mark. The SS12000 sync read a person's
-- securityMarking on every run, held every change for that person for the
-- administrator's review, and forgot the marking when the run ended
-- (20261014110000). That kept a protected person out of the register only
-- while every change for them stayed unticked. A person whose changes an
-- administrator ticked, who was typed in by hand, read from a CSV file or
-- registered before the source marked them was an ordinary row, and went
-- out in elever.csv, in vardnadshavare.csv and in the guardian links in bulk
-- (the review of #261). This migration is the stored half;
-- src/users/person-protections.ts and the exports are the other.
--
-- ## PersonProtections: that the protection exists, never what it is
--
--   userId    the person, keyed by the Users row
--   schoolId  their school
--   source    SS12000 (the sync wrote it) or MANUAL (an administrator did)
--
-- Nothing else. Not which protection (Sekretessmarkering or Skyddad
-- folkbokföring). A person is marked while any row names them. The key is
-- (userId, schoolId, source): a person may hold the sync's mark and an
-- administrator's beside it, and each is lifted only by its own writer. An
-- administrator's mark therefore stands when the register later says
-- "Ingen", and the sync never touches it. The school is in the key, so a
-- write naming another school's person fails on the person key (23503)
-- whether or not that person is marked there: no answer tells one school
-- about another's marks.
--
-- A column on Users was rejected. Users is read by the person's teachers
-- (users_staff_select), by a guardian for their children and by the person
-- themselves (users_self_select), and a column would go with every one of
-- those reads. A table of its own is read by the arms below and no others.
--
-- ## Why this does not undo 20261014110000's minimisation
--
-- 20261014110000 decided that a run's names and addresses, and the flag
-- saying a person is protected, exist only while the run is DIFF_READY,
-- and are nulled the moment it ends. That decision served one purpose: an
-- administrator reviews a change before it is made. Once the change was
-- made or dropped, the payload had no use left, and keeping it would have
-- kept a second copy of the register. The flag went with it, because its
-- one use was to hold the change for review.
--
-- This migration serves a purpose the earlier one did not have: keeping a
-- protected person out of the files Rastra writes. A file is written on any
-- day, about people who may never have passed a sync, so the fact has to be
-- at hand then, and it has to be kept. What is kept is weighed against the
-- minimisation principle (GDPR art. 5.1 c) on its own terms:
--
--   * It is the least that serves: one bit, that a protection exists, and
--     where Rastra learnt it. The kind is not kept. Skyddad folkbokföring
--     tells a reader that the person lives hidden from somebody;
--     Sekretessmarkering says less. Nothing Rastra does with the mark tells
--     them apart, so the stored fact is the same for both and says less
--     than either. It is a fact that the protection exists, not a fact of
--     the protection.
--   * It is read where its purpose is: by the administrators who write the
--     files, and by the sync that keeps it. Teachers, pupils, guardians and
--     PostgREST's roles read nothing, as they read nothing of a run.
--   * It lasts as long as its purpose. The sync removes a mark it wrote when
--     the register says "Ingen" for the person; it goes with the person
--     (the key cascades), and when gallring pseudonymises a departed person
--     (app.gallring_pseudonymise, below).
--   * Who set or removed a mark, and when, is kept apart, in
--     PersonProtectionEvents (below): a mark taken off a protected child is
--     a decision somebody made, and it must not leave no trace. The history
--     holds the same one bit and the source, the action, the time and who
--     did it, read by the same administrators and purged with the school's
--     other change logs.
--   * The run stays as minimal as before. The sync's change that sets or
--     lifts a mark (entity PROTECTION, below) names its person only in its
--     after, which the minimisation nulls; a finished run says how many
--     marks it set or lifted, never whose. A CHECK holds it there
--     (Ss12000SyncChanges_a_mark_names_its_person_in_after_alone): such a
--     change has no externalId and no localId, the columns the minimisation
--     keeps. The minimisation itself is not touched: a change's before,
--     after and protectedIdentity are nulled as they were.
--
-- The alternative, asking the register when a file is written, was
-- rejected: it reaches only the people the sync has linked, makes every
-- export wait on the register, and holds the same fact in memory anyway.
--
-- ## The sync
--
-- Ss12000ChangeEntity gains PROTECTION, with op ADD (set the mark) or END
-- (lift it), so the sync shows the mark as a change before it makes it,
-- like every other change (src/integration/ss12000-sync/diff.ts):
--
--   * A person the register marks, already linked and with no mark here:
--     PROTECTION ADD, selected and made by the nightly auto-apply too. It
--     only takes the person out of files, so it is the one change about a
--     protected person that is automatic. protectedIdentity stays false on
--     it (Ss12000SyncChanges_protected_is_never_automatic).
--   * A person the register marks and who is in Rastra unlinked, matched by
--     address (the run proposes LINK or RELINK): PROTECTION ADD for that
--     local row, selected and automatic too, whether or not the link is
--     made. A person typed in by hand, read from a file or imported before
--     the register protected them is marked by the first run that finds
--     them, not when somebody ticks the link.
--   * A person the register marks and this apply creates, links or relinks:
--     the apply writes the mark with that change, which stays deselected
--     for review as before; ticked, the person never exists unmarked.
--   * A mark the sync wrote, for a linked person whom a FULL run reads as
--     "Ingen" everywhere it names them, and as nothing else: PROTECTION
--     END, deselected and never automatic, so an apply with the defaults
--     never lifts a protection. An absent marking is not "Ingen", and an
--     INCREMENTAL run lifts nothing, since it may not read the record (a
--     child's) that still marks the person. A MANUAL mark is the
--     administrator's and the sync never lifts it.
--
-- ## Who reads and who writes
--
-- Through the gateway only (app_authenticated); nothing for authenticated or
-- anon, service_role keeps its SELECT and nothing more, and MAINTAIN is the
-- owner's on 17. A mark is set or removed, never changed: no arm updates
-- and the API's role holds no UPDATE.
--
--   person_protections_admin_select   the school's SCHOOL_ADMIN, every
--                                     profile (they write the files)
--   person_protections_admin_insert   and whoever writes Personal
--                                     (app.current_user_may('PERSONAL', true))
--   person_protections_admin_delete   and those who decide (rektor, full:
--                                     app.current_user_decides()): lifting a
--                                     protection is a decision, as gallring
--                                     and the posts are
--   person_protections_sync_select    the sync principal of the school
--   person_protections_sync_insert    the same, and only source SS12000
--   person_protection_events_admin_select  the school's SCHOOL_ADMIN, every
--                                     profile; written by the trigger alone
--
-- The sync principal lifts nothing: an END is never automatic, so only an
-- administrator's apply removes a mark, and only one who decides (the
-- profiles that write Integrationer, which apply a sync, all do).
--
-- ## PersonProtectionEvents: who set or removed a mark, and when
--
--   userId, schoolId  the person and the school (no key to Users: the
--                     history outlives the person, ids only, as
--                     GuardianStudentHistory does)
--   action            ADDED or REMOVED
--   source            the mark's: SS12000 or MANUAL
--   actorId           app.current_user_id() of the write: the administrator,
--                     or NULL for the sync's principal, gallring and a
--                     school's own removal
--   at                when
--
-- Written by an AFTER INSERT OR DELETE trigger on PersonProtections
-- (app.person_protection_events_record), so every writer is recorded: the
-- gateway's mark by hand and its removal, the sync's apply by night or by
-- an administrator, a person's removal and gallring's pseudonymisation. An
-- insert the key turns away (ON CONFLICT DO NOTHING) records nothing. No
-- arm writes it and a guard refuses every other write
-- (app.person_protection_events_written_by_trigger, SS403), as the guardian
-- links' history. It goes with the school, and by gallring under
-- CHANGE_LOGS, beside the guardian links' history (app.gallring_due and
-- app.gallring_purge, below).
--
-- ## Keys
--
--   * ("userId", "schoolId") -> Users ("id", "schoolId") ON DELETE CASCADE:
--     the mark goes with the person. ON UPDATE NO ACTION, as every person
--     key since 20270102091000.
--   * "schoolId" -> Schools ON DELETE CASCADE, for both tables.
--
-- ## Beside the live API: every lock at once, or none
--
-- The new keys take Users and Schools in SHARE ROW EXCLUSIVE, which blocks
-- writes to them (not reads, and not the KEY SHARE a key check takes) for
-- the length of the file; the new tables are empty, so the keys validate
-- nothing. The CHECK takes Ss12000SyncChanges in ACCESS EXCLUSIVE, and is
-- added NOT VALID: no row before this file can be a PROTECTION change, so
-- there is nothing to scan, and every row written or updated from now on is
-- judged. A request writes Users and Schools in one transaction (a pupil's
-- row and the school's), and an apply writes Users and then
-- Ss12000SyncChanges, so the three are taken together, NOWAIT, in a loop: a refusal rolls
-- the subtransaction back with whatever it got and tries again 50 ms later;
-- it never waits while it holds a lock, and no request queues behind it.
-- After 30 s it stops with nothing changed: prisma migrate resolve
-- --rolled-back 20270107090000_skolan_minns_att_en_person_har_skyddad_identitet,
-- then deploy again. lock_timeout bounds any wait nobody foresaw. Adding a
-- value to Ss12000ChangeEntity and replacing app.gallring_due,
-- app.gallring_purge and app.gallring_pseudonymise lock no table. Run it
-- outside an SS12000 sync window, as 20261207090000.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Schools" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Users" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Ss12000SyncChanges" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Schools, Users and Ss12000SyncChanges were not free at once in 30 s: nothing is changed. Run: npx prisma migrate resolve --rolled-back 20270107090000_skolan_minns_att_en_person_har_skyddad_identitet, then deploy again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

CREATE TYPE "PersonProtectionSource" AS ENUM ('SS12000', 'MANUAL');
CREATE TYPE "PersonProtectionAction" AS ENUM ('ADDED', 'REMOVED');

-- ---------------------------------------------------------------------------
-- PersonProtections
-- ---------------------------------------------------------------------------

CREATE TABLE "PersonProtections" (
    "userId"   UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "source"   "PersonProtectionSource" NOT NULL,

    CONSTRAINT "PersonProtections_pkey" PRIMARY KEY ("userId", "schoolId", "source")
);

-- The school's list (the exports, the person page) and the school key's cascade.
CREATE INDEX "PersonProtections_schoolId_idx" ON "PersonProtections"("schoolId");

ALTER TABLE "PersonProtections"
    ADD CONSTRAINT "PersonProtections_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "PersonProtections"
    ADD CONSTRAINT "PersonProtections_userId_schoolId_fkey" FOREIGN KEY ("userId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;

COMMENT ON TABLE "PersonProtections" IS
  'Skyddad identitet: that the person has a protected identity and whether the SS12000 sync or an administrator said so, a row each; never which protection. Admin-only; every file of people leaves these persons out (20270107090000).';

-- ---------------------------------------------------------------------------
-- PersonProtectionEvents
-- ---------------------------------------------------------------------------

CREATE TABLE "PersonProtectionEvents" (
    "id"       UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "userId"   UUID NOT NULL,
    "action"   "PersonProtectionAction" NOT NULL,
    "source"   "PersonProtectionSource" NOT NULL,
    "actorId"  UUID,
    "at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "PersonProtectionEvents_pkey" PRIMARY KEY ("id")
);

-- A person's history, newest first; gallring's predicate (CHANGE_LOGS).
CREATE INDEX "PersonProtectionEvents_schoolId_userId_at_idx" ON "PersonProtectionEvents"("schoolId", "userId", "at");
CREATE INDEX "PersonProtectionEvents_schoolId_at_idx" ON "PersonProtectionEvents"("schoolId", "at");

ALTER TABLE "PersonProtectionEvents"
    ADD CONSTRAINT "PersonProtectionEvents_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

COMMENT ON TABLE "PersonProtectionEvents" IS
  'Skyddad identitet: who set or removed a mark, when, and the mark''s source; never which protection. Written by app.person_protection_events_record alone, read by the school''s administrators, purged under CHANGE_LOGS (20270107090000).';

CREATE FUNCTION app.person_protection_events_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  mark "PersonProtections";
BEGIN
  IF TG_OP = 'INSERT' THEN
    mark := NEW;
  ELSE
    mark := OLD;
  END IF;
  -- Inside a school's cascade the school is already gone: nothing to record.
  IF NOT EXISTS (SELECT 1 FROM "Schools" s WHERE s."id" = mark."schoolId") THEN
    RETURN NULL;
  END IF;
  INSERT INTO "PersonProtectionEvents" ("schoolId", "userId", "action", "source", "actorId")
  VALUES (mark."schoolId", mark."userId",
          (CASE TG_OP WHEN 'INSERT' THEN 'ADDED' ELSE 'REMOVED' END)::"PersonProtectionAction",
          mark."source", app.current_user_id());
  RETURN NULL;
END
$$;

CREATE FUNCTION app.person_protection_events_written_by_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF TG_OP <> 'TRUNCATE' AND pg_trigger_depth() > 1 THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  -- gallring: the school's own purge of change logs past its period.
  IF TG_OP = 'DELETE' AND app.gallring_in_progress(OLD."schoolId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'PERSON_PROTECTION_EVENTS_ARE_RECORDED: historiken över markeringarna skrivs bara av databasen'
    USING ERRCODE = 'SS403',
          DETAIL  = format('operation=%s', TG_OP);
END
$$;

CREATE TRIGGER "PersonProtections_events"
    AFTER INSERT OR DELETE ON "PersonProtections"
    FOR EACH ROW EXECUTE FUNCTION app.person_protection_events_record();

CREATE TRIGGER "PersonProtectionEvents_written_by_trigger"
    BEFORE INSERT OR UPDATE OR DELETE ON "PersonProtectionEvents"
    FOR EACH ROW EXECUTE FUNCTION app.person_protection_events_written_by_trigger();

CREATE TRIGGER "PersonProtectionEvents_no_truncate"
    BEFORE TRUNCATE ON "PersonProtectionEvents"
    FOR EACH STATEMENT EXECUTE FUNCTION app.person_protection_events_written_by_trigger();

REVOKE ALL ON FUNCTION app.person_protection_events_record() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.person_protection_events_written_by_trigger() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Row-level security and grants. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "PersonProtections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PersonProtectionEvents" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r text;
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    CREATE POLICY "person_protections_admin_select" ON "PersonProtections"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "person_protections_admin_insert" ON "PersonProtections"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('PERSONAL', true)));
    CREATE POLICY "person_protections_admin_delete" ON "PersonProtections"
        FOR DELETE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
               AND (select app.current_user_decides()));
    CREATE POLICY "person_protections_sync_select" ON "PersonProtections"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_sync_school_id()));
    CREATE POLICY "person_protections_sync_insert" ON "PersonProtections"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_sync_school_id())
                    AND "source" = 'SS12000');

    CREATE POLICY "person_protection_events_admin_select" ON "PersonProtectionEvents"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

    REVOKE ALL ON "PersonProtections" FROM "app_authenticated";
    GRANT SELECT, INSERT, DELETE ON "PersonProtections" TO "app_authenticated";
    REVOKE ALL ON "PersonProtectionEvents" FROM "app_authenticated";
    GRANT SELECT ON "PersonProtectionEvents" TO "app_authenticated";
  END IF;

  FOREACH t IN ARRAY ARRAY['PersonProtections', 'PersonProtectionEvents'] LOOP
    FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM service_role', t);
    END IF;
    -- PostgreSQL 17's MAINTAIN (REINDEX, CLUSTER, VACUUM, LOCK): the owner's alone.
    IF current_setting('server_version_num')::int >= 170000 THEN
      FOREACH r IN ARRAY ARRAY['authenticated', 'app_authenticated', 'service_role', 'anon'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
          EXECUTE format('REVOKE MAINTAIN ON %I FROM %I', t, r);
        END IF;
      END LOOP;
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- PERSON_PROTECTION_REACH: the six arms above and no other; none for a
-- PostgREST role or the service principal. Each expression an arm has
-- (USING, WITH CHECK) names the caller's school (the login's, or the sync
-- principal's), has no OR and no NOT; an administrator's arm names the
-- SCHOOL_ADMIN role, its insert the Personal area and its delete the
-- decisions; the sync's insert names the source SS12000; the history is
-- read and never written by an arm. A name and a command alone would let
-- `USING (true)` through.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  bad text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    RETURN;
  END IF;
  SELECT string_agg(p.tablename || '.' || p.policyname || ' ' || p.cmd || ' ' || p.roles::text, ', ' ORDER BY p.tablename, p.policyname) INTO bad
    FROM pg_policies p
   WHERE p.schemaname = 'public'
     AND p.tablename IN ('PersonProtections', 'PersonProtectionEvents')
     AND NOT coalesce(
           p.roles = '{app_authenticated}'::name[]
           AND p.permissive = 'PERMISSIVE'
           AND (p.tablename, p.policyname, p.cmd) IN (
                 ('PersonProtections', 'person_protections_admin_select', 'SELECT'),
                 ('PersonProtections', 'person_protections_admin_insert', 'INSERT'),
                 ('PersonProtections', 'person_protections_admin_delete', 'DELETE'),
                 ('PersonProtections', 'person_protections_sync_select', 'SELECT'),
                 ('PersonProtections', 'person_protections_sync_insert', 'INSERT'),
                 ('PersonProtectionEvents', 'person_protection_events_admin_select', 'SELECT'))
           AND (SELECT bool_and(
                         e NOT LIKE '% OR %'
                         AND e NOT LIKE '%NOT %'
                         AND CASE WHEN p.policyname LIKE '%\_admin\_%' ESCAPE '\'
                                  THEN e LIKE '%"schoolId" = ( SELECT app.current_school_id() AS current_school_id)%'
                                       AND e LIKE '%current_user_role()%= ''SCHOOL_ADMIN''::"UserRole"%'
                                       AND (p.cmd <> 'INSERT' OR e LIKE '%current_user_may(''PERSONAL''::"AdminArea", true)%')
                                       AND (p.cmd <> 'DELETE' OR e LIKE '%current_user_decides()%')
                                  ELSE e LIKE '%"schoolId" = ( SELECT app.current_sync_school_id() AS current_sync_school_id)%'
                                       AND (p.cmd = 'SELECT' OR e LIKE '%(source = ''SS12000''::"PersonProtectionSource")%')
                             END)
                  FROM unnest(ARRAY[p.qual, p.with_check]) e
                 WHERE e IS NOT NULL),
         false);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'PERSON_PROTECTION_REACH: these arms reach the marks beyond the administrator''s, Personal''s and the decisions'' writes and the sync''s own: %', bad;
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('PersonProtections', 'PersonProtectionEvents')) <> 6 THEN
    RAISE EXCEPTION 'PERSON_PROTECTION_REACH: the marks and their history have % arms, not the six above',
      (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('PersonProtections', 'PersonProtectionEvents'));
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Gallring of the marks' history under CHANGE_LOGS. Both bodies are
-- 20270102091000's (Vikariefrågan's, which carry Frånvarobevakning's findings
-- and the vikarieförfrågningar) plus the branch marked "skyddad identitet",
-- beside the guardian links' history: an event goes once it is older than the
-- cutoff (the school's local midnight). A later release that restates the
-- functions again must carry every branch.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.gallring_due(p_school uuid, p_type "RetentionDataType", p_before date, p_today date)
RETURNS TABLE (tbl text, id uuid)
LANGUAGE sql STABLE AS $$
  WITH school AS (
    SELECT s."id", (p_before::timestamp AT TIME ZONE s."timezone") AS before_at
      FROM "public"."Schools" s WHERE s."id" = p_school AND p_before IS NOT NULL
  )
  SELECT 'AttendanceRecords', a."id"
    FROM school, "public"."AttendanceRecords" a
    JOIN "public"."CalendarLessons" l ON l."id" = a."calendarLessonId"
   WHERE p_type = 'ATTENDANCE' AND a."schoolId" = school."id" AND l."date" < p_before
  UNION ALL
  -- frånvarobevakning
  SELECT 'AbsenceWatchFindings', w."id"
    FROM school, "public"."AbsenceWatchFindings" w
   WHERE p_type = 'ATTENDANCE' AND w."schoolId" = school."id" AND w."lastSeenOn" < p_before
  UNION ALL
  SELECT 'AbsenceReports', r."id"
    FROM school, "public"."AbsenceReports" r
   WHERE p_type = 'ABSENCE_REPORTS' AND r."schoolId" = school."id" AND r."date" < p_before
  UNION ALL
  SELECT 'LeaveRequests', r."id"
    FROM school, "public"."LeaveRequests" r
   WHERE p_type = 'LEAVE_REQUESTS' AND r."schoolId" = school."id" AND r."endDate" < p_before
  UNION ALL
  SELECT 'Notifications', n."id"
    FROM school, "public"."Notifications" n
   WHERE p_type = 'NOTIFICATIONS' AND n."schoolId" = school."id" AND n."createdAt" < school.before_at
  UNION ALL
  SELECT 'ScheduleChangeLogs', c."id"
    FROM school, "public"."ScheduleChangeLogs" c
   WHERE p_type = 'CHANGE_LOGS' AND c."schoolId" = school."id" AND c."createdAt" < school.before_at
  UNION ALL
  SELECT 'TeacherEmploymentLogs', g."id"
    FROM school, "public"."TeacherEmploymentLogs" g
    JOIN "public"."AcademicYears" y ON y."id" = g."academicYearId" AND y."schoolId" = g."schoolId"
   WHERE p_type = 'CHANGE_LOGS' AND g."schoolId" = school."id" AND y."endDate" < p_before
  UNION ALL
  SELECT 'GuardianStudentHistory', h."id"
    FROM school, "public"."GuardianStudentHistory" h
   WHERE p_type = 'CHANGE_LOGS' AND h."schoolId" = school."id" AND h."unlinkedAt" < school.before_at
  UNION ALL
  -- skyddad identitet
  SELECT 'PersonProtectionEvents', e."id"
    FROM school, "public"."PersonProtectionEvents" e
   WHERE p_type = 'CHANGE_LOGS' AND e."schoolId" = school."id" AND e."at" < school.before_at
  UNION ALL
  SELECT 'TeacherAbsences', t."id"
    FROM school, "public"."TeacherAbsences" t
   WHERE p_type = 'ABSENCE_REASONS' AND t."schoolId" = school."id" AND t."reasonId" IS NOT NULL
     AND t."endsAt" < school.before_at
  UNION ALL
  -- läslogg
  SELECT 'PersonalDataAccess', p."id"
    FROM school, "public"."PersonalDataAccess" p
   WHERE p_type = 'ACCESS_LOG' AND p."schoolId" = school."id" AND p."at" < school.before_at
  UNION ALL
  -- vikarieförfrågningar
  SELECT 'CoverRequests', q."id"
    FROM school, "public"."CoverRequests" q
   WHERE p_type = 'COVER_REQUESTS' AND q."schoolId" = school."id"
     AND ((q."status" <> 'OPEN' AND q."closedAt" < school.before_at)
          OR (q."status" = 'OPEN' AND q."expiresAt" < school.before_at))
  UNION ALL
  SELECT 'CoverConfirmations', c."id"
    FROM school, "public"."CoverConfirmations" c
   WHERE p_type = 'COVER_REQUESTS' AND c."schoolId" = school."id" AND c."confirmedAt" < school.before_at
  UNION ALL
  SELECT 'Users', u."id"
    FROM school, "public"."Users" u
   WHERE p_type = 'DEPARTED_PEOPLE' AND u."schoolId" = school."id"
     AND NOT u."isActive" AND u."pseudonymisedAt" IS NULL
     AND u."deactivatedAt" < school.before_at
     AND NOT app.gallring_held_for_scb(u."id", u."schoolId", p_today);
$$;

CREATE OR REPLACE FUNCTION app.gallring_purge(p_run uuid, p_type "RetentionDataType", p_limit integer) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  r "GallringRuns";
  cutoff date;
  today date;
  budget integer := greatest(least(p_limit, 5000), 1);
  n integer := 0;
  step integer;
BEGIN
  IF p_type = 'DEPARTED_PEOPLE' THEN
    RAISE EXCEPTION 'GALLRING_PEOPLE_ARE_PSEUDONYMISED' USING ERRCODE = 'GL400';
  END IF;
  -- FOR UPDATE: one call of a run at a time.
  SELECT * INTO r FROM "GallringRuns" WHERE "id" = p_run AND "status" = 'RUNNING' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GALLRING_RUN_NOT_RUNNING' USING ERRCODE = 'GL404';
  END IF;
  -- Both NULL when nothing of the kind may go: least() of a NULL is the other.
  IF r."cutoffs" ->> p_type::text IS NULL
     OR app.retention_months_in_force(r."schoolId", p_type, clock_timestamp()) IS NULL THEN
    RETURN 0;
  END IF;
  cutoff := app.gallring_run_cutoff(r."schoolId", r."startedAt", r."cutoffs", p_type);
  today := app.gallring_today(r."schoolId", r."startedAt");

  PERFORM set_config('app.gallring', r."schoolId"::text, true);
  CASE p_type
    WHEN 'ATTENDANCE' THEN
      DELETE FROM "AttendanceRecords" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'AttendanceRecords' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
      -- frånvarobevakning
      IF n < budget THEN
        DELETE FROM "AbsenceWatchFindings" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'AbsenceWatchFindings' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
    WHEN 'ABSENCE_REPORTS' THEN
      DELETE FROM "AbsenceReports" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'AbsenceReports' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
    WHEN 'LEAVE_REQUESTS' THEN
      DELETE FROM "LeaveRequests" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'LeaveRequests' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
    WHEN 'NOTIFICATIONS' THEN
      DELETE FROM "Notifications" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'Notifications' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
    WHEN 'CHANGE_LOGS' THEN
      DELETE FROM "ScheduleChangeLogs" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'ScheduleChangeLogs' LIMIT budget);
      GET DIAGNOSTICS step = ROW_COUNT;
      n := step;
      IF n < budget THEN
        DELETE FROM "TeacherEmploymentLogs" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'TeacherEmploymentLogs' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
      IF n < budget THEN
        DELETE FROM "GuardianStudentHistory" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'GuardianStudentHistory' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
      -- skyddad identitet
      IF n < budget THEN
        DELETE FROM "PersonProtectionEvents" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'PersonProtectionEvents' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
    WHEN 'ABSENCE_REASONS' THEN
      UPDATE "TeacherAbsences" SET "reasonId" = NULL WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'TeacherAbsences' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
    -- läslogg
    WHEN 'ACCESS_LOG' THEN
      DELETE FROM "PersonalDataAccess" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'PersonalDataAccess' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
    -- vikarieförfrågningar
    WHEN 'COVER_REQUESTS' THEN
      DELETE FROM "CoverRequests" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'CoverRequests' LIMIT budget);
      GET DIAGNOSTICS step = ROW_COUNT;
      n := step;
      IF n < budget THEN
        DELETE FROM "CoverConfirmations" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'CoverConfirmations' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
  END CASE;
  PERFORM set_config('app.gallring', '', true);

  UPDATE "GallringRuns" SET
    "counts"   = "counts" || jsonb_build_object(p_type::text, COALESCE(("counts" ->> p_type::text)::bigint, 0) + n),
    "complete" = "complete" || jsonb_build_object(p_type::text, n < budget),
    "cutoffs"  = "cutoffs" || jsonb_build_object(p_type::text, cutoff::text)
   WHERE "id" = p_run;
  RETURN n;
END
$$;

-- ---------------------------------------------------------------------------
-- app.gallring_pseudonymise: 20261207090000's body, and a pseudonym loses
-- its mark. The row stays as a pseudonym, which identifies nobody, and the
-- sync can no longer reach it (ss12000Id is cleared), so the mark has no
-- purpose left. A later release that restates the function must carry the
-- line marked "skyddad identitet".
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.gallring_pseudonymise(p_run uuid, p_users uuid[]) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  r "GallringRuns";
  cutoff date;
  today date;
  due uuid[];
  n integer;
BEGIN
  SELECT * INTO r FROM "GallringRuns" WHERE "id" = p_run AND "status" = 'RUNNING' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GALLRING_RUN_NOT_RUNNING' USING ERRCODE = 'GL404';
  END IF;
  -- The rows before the question: a reactivation in flight is waited for,
  -- one that comes later waits for this transaction, and every statement
  -- below reads after the wait. Id order, so two callers cannot deadlock.
  PERFORM 1 FROM "Users" u
   WHERE u."schoolId" = r."schoolId" AND u."id" = ANY (p_users)
   ORDER BY u."id"
     FOR NO KEY UPDATE;
  IF r."cutoffs" ->> 'DEPARTED_PEOPLE' IS NULL
     OR app.retention_months_in_force(r."schoolId", 'DEPARTED_PEOPLE', clock_timestamp()) IS NULL THEN
    RETURN 0;
  END IF;
  cutoff := app.gallring_run_cutoff(r."schoolId", r."startedAt", r."cutoffs", 'DEPARTED_PEOPLE');
  today := app.gallring_today(r."schoolId", r."startedAt");
  -- Asked again: somebody reactivated since the list was read is not due.
  due := ARRAY(
    SELECT d."id" FROM app.gallring_due(r."schoolId", 'DEPARTED_PEOPLE', cutoff, today) d
     WHERE d."id" = ANY (p_users)
     ORDER BY d."id"
     LIMIT 500);

  PERFORM set_config('app.gallring', r."schoolId"::text, true);
  UPDATE "Users" u SET
      "firstName"       = 'Pseudonym',
      "lastName"        = upper(left(replace(u."id"::text, '-', ''), 6)),
      "email"           = 'pseudonym-' || u."id"::text || '@pseudonym.invalid',
      "phone"           = NULL,
      "ss12000Id"       = NULL,
      "authId"          = gen_random_uuid(),
      "invitedAt"       = NULL,
      "pseudonymisedAt" = now(),
      "updatedAt"       = now()
   WHERE u."schoolId" = r."schoolId" AND u."id" = ANY (due);
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE "TeacherEmployments" SET "signature" = NULL, "note" = NULL
   WHERE "schoolId" = r."schoolId" AND "userId" = ANY (due)
     AND ("signature" IS NOT NULL OR "note" IS NOT NULL);
  -- Rastvaktsschema (20261207090000): a pass's note, as the tjänst's.
  UPDATE "SupervisionShifts" SET "note" = NULL, "updatedAt" = now()
   WHERE "schoolId" = r."schoolId" AND "userId" = ANY (due) AND "note" IS NOT NULL;
  DELETE FROM "GuardianStudents"
   WHERE "schoolId" = r."schoolId" AND ("guardianId" = ANY (due) OR "studentId" = ANY (due));
  DELETE FROM "PushTickets" p USING "DevicePushTokens" t
   WHERE p."tokenId" = t."id" AND p."schoolId" = t."schoolId"
     AND t."schoolId" = r."schoolId" AND t."userId" = ANY (due);
  DELETE FROM "DevicePushTokens" WHERE "schoolId" = r."schoolId" AND "userId" = ANY (due);
  DELETE FROM "NotificationOptOuts" WHERE "schoolId" = r."schoolId" AND "userId" = ANY (due);
  DELETE FROM "Notifications" WHERE "schoolId" = r."schoolId" AND "userId" = ANY (due);
  -- skyddad identitet (20270107090000): a pseudonym's mark.
  DELETE FROM "PersonProtections" WHERE "schoolId" = r."schoolId" AND "userId" = ANY (due);
  PERFORM set_config('app.gallring', '', true);

  UPDATE "GallringRuns" SET
    "counts" = "counts" || jsonb_build_object('DEPARTED_PEOPLE', COALESCE(("counts" ->> 'DEPARTED_PEOPLE')::bigint, 0) + n),
    "cutoffs" = "cutoffs" || jsonb_build_object('DEPARTED_PEOPLE', cutoff::text)
   WHERE "id" = p_run;
  RETURN n;
END
$$;

COMMENT ON FUNCTION app.gallring_pseudonymise(uuid, uuid[]) IS
  'Locks the rows of p_users in the run''s school, then pseudonymises those still due: name, e-mail, phone, SS12000 id and login replaced; their tjänster''s signature and note, and their rastvaktspass'' notes, cleared; their guardian links, push devices, notification opt-outs, all their own notices (whatever NOTIFICATIONS says) and their mark of a protected identity removed. Returns how many it pseudonymised.';

-- ---------------------------------------------------------------------------
-- The sync's change that sets or lifts a mark. A value added to an enum may
-- not be used in the transaction that adds it, so the CHECK compares the
-- value's text, which names no enum member.
-- ---------------------------------------------------------------------------

ALTER TYPE "Ss12000ChangeEntity" ADD VALUE 'PROTECTION';

ALTER TABLE "Ss12000SyncChanges"
    ADD CONSTRAINT "Ss12000SyncChanges_a_mark_names_its_person_in_after_alone"
    CHECK ("entity"::text <> 'PROTECTION' OR ("op" IN ('ADD', 'END') AND "externalId" IS NULL AND "localId" IS NULL))
    NOT VALID;
