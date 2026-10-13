-- Roller i skolan, del 2: varje administratörsarm frågar efter området.
--
-- ## What changes
--
-- Before this migration an administrator's arm on a table was one FOR ALL
-- policy, the same expression in USING and in WITH CHECK: the school's
-- SCHOOL_ADMIN may do everything. Each such arm is now four, one per command:
--
--   <table>_admin_select  every administrator, as before;
--   <table>_admin_insert  the area's writers (WITH CHECK);
--   <table>_admin_update  USING every administrator, WITH CHECK the area's
--                         writers;
--   <table>_admin_delete  the area's writers (USING).
--
-- The update arm's USING admits every administrator on purpose. Postgres
-- applies the UPDATE policies' USING to a SELECT ... FOR UPDATE / FOR SHARE,
-- and the gateway takes such locks in other areas' work: the timplansposter
-- lock the teachers' posts, an uppdrag locks the teacher's Users row,
-- a lov locks its läsår. A USING that asked for the area would hand those
-- reads zero rows, silently, mid-term. The area sits in WITH CHECK instead,
-- where an update by somebody outside it is refused with an error rather
-- than turned into nothing.
--
-- The administrator's arms that were already one command (published
-- lessons, the SS12000 tables, sign-in, retention decisions and the like)
-- keep their names and gain the same question in WITH CHECK, or in USING for
-- a delete. The two staff arms that admit an administrator beside a teacher
-- (Notifications, RoomBookings) ask it for the administrator's half.
--
-- ## Read from the catalogue, as it stands when this runs
--
-- The arms are not spelled out here. The DO block below reads each one from
-- pg_policy when the migration runs and splits or amends it keeping its
-- roles (TO authenticated, TO app_authenticated, or both) and its expression
-- exactly as earlier migrations left them. Other branches move arms between
-- the API roles (the läslogg's TO app_authenticated) and this migration sorts
-- after them, so a fixed TO here would undo their move, and a fixed
-- expression would undo any change they made to one.
--
-- What this file states is the area of each table: the VALUES list, which
-- is src/auth/admin-areas.ts TABLE_WRITE_GATES as rows. A command with no
-- area is one no administrator had a grant for, and gets no arm. The RLS
-- suite's sections 116 and 106 hold the result to the same list, cell by
-- cell and arm by arm.
--
-- In short:
--
--   planering       grunddata (skolenheter too), the timplan and its
--                   blocks, staffing rules, the year
--   schemaläggning  the grundschema, its versions, what Generera writes
--   publicering     publications, Schemavisaren, undervisningstid
--   drift           the dated calendar, cover, absence, leave, bookings
--   personal        the roster: people and guardian links
--   integrationer   keys, SS12000, the school's sign-in
--   the decisions   tjänst % and nedsättning (TeacherEmployments and their
--                   periods), dataskydd (RetentionDecisions, and reading
--                   the läslogg), the delegation of leave decisions to the
--                   mentors (LeaveDelegationDecisions), and who administers
--                   (the trigger from 20261110090000)
--
-- Two tables are more than one area:
--
-- * Users: the roster is personal's. A planner may also move a pupil
--   between classes, because Aktivera does that, and a trigger holds such an
--   update to the class of a pupil and nothing else.
-- * StaffingPolicies is planering's, except shareEmploymentWithIntegrations,
--   which hands tjänst % to the school's integrations: a decision.
--
-- And three SECURITY DEFINER functions write the integrations' secrets past
-- every arm; they now ask for integrationer too, as does the trigger that
-- lets an administrator write a row's SS12000 id.
--
-- ## Tjänst % and nedsättning
--
-- Read by rektor, full and HR-läs. Row security cannot hide a column, and
-- the row also carries the lärarsignatur the schedule shows to every
-- administrator, so every administrator's arm reads the row and the gateway
-- leaves the two percentages out of what it answers anybody else, with the
-- post's periods (when and how a post changes is HR data too) and every
-- yearly figure read off them. The gateway is the only path to another
-- person's post: the administrators' arms on TeacherEmployments, their
-- periods and their log are the API role's alone (20261028090000,
-- 20261022120000), and this migration keeps that role when it splits them.
-- Through PostgREST a person reads their own post and nothing else (the
-- teacher's own arms), whatever their profile.
--
-- ## The läslogg
--
-- Who has read whose personal data is dataskydd's: PersonalDataAccess is
-- read by those who decide (rektor and full), its one read arm asking
-- app.current_user_decides(). It is the one table every administrator does
-- not read.
--
-- ## Nothing changes on deploy
--
-- Every administrator is FULL (20261110090000), and FULL writes every area
-- and decides, so each new arm admits exactly what the old one did. The RLS
-- suite's matrix asserts FULL's cells against the commands each table's arms
-- and grants allow.
--
-- ## The guard at the end
--
-- The migration ends by refusing to commit if any write arm that admits an
-- administrator does not ask the area or the decisions: an arm on a table
-- the VALUES list does not name, added by a branch this one has not seen,
-- fails here by name instead of leaving a table every profile writes.
--
-- ## Locks: every one at once, or none
--
-- Production runs this while the API before it serves requests. Each DROP,
-- CREATE or ALTER POLICY below takes its table's ACCESS EXCLUSIVE lock, on
-- some eighty tables, Users among them. Requests take those tables in either
-- order: through the API every statement reads Users in the RLS helpers,
-- after the planner has locked the table it names, and a job on the owner's
-- role may write one table and then read Users. A migration that waited for
-- one table while it held another could close a cycle with either kind, in
-- whatever order it took them, and a request could be the one Postgres
-- aborts; a waiting ACCESS EXCLUSIVE lock also queues every request behind
-- it. So every table this migration changes is locked before anything else,
-- NOWAIT and together: a refusal rolls the subtransaction back and with it
-- whatever it got, and it tries again 50 ms later. The migration never waits
-- while it holds a lock, and no request queues behind it; once it has them
-- all it runs without waiting for anything a request holds. After 30 s of
-- refusals it stops with nothing done and can be rerun. lock_timeout bounds
-- any wait nobody foresaw.

DO $$
DECLARE
  tables text;
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  -- Every table with a policy that names an administrator (the arms below,
  -- the two staff arms among them) and StaffingPolicies (its trigger).
  SELECT string_agg(quote_ident(c.relname), ', ' ORDER BY c.relname) INTO tables
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND c.relname <> 'Users'
     AND (c.relname = 'StaffingPolicies'
          OR EXISTS (SELECT 1 FROM pg_policy p
                      WHERE p.polrelid = c.oid
                        AND (coalesce(pg_get_expr(p.polqual, p.polrelid), '')
                             || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) LIKE '%SCHOOL_ADMIN%'));
  LOOP
    BEGIN
      EXECUTE format('LOCK TABLE "Users", %s IN ACCESS EXCLUSIVE MODE NOWAIT', tables);
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'The tables whose arms ask the area were not free at once in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- The arms, table by table, read from the catalogue.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  g record;
  p record;
  roles text;
  prefix text;
  gate_ins text;
  gate_upd text;
  gate_del text;
  gate_rd text;
  split integer := 0;
  amended integer := 0;
BEGIN
  FOR g IN
    SELECT v.tbl, v.ins::text[] AS ins, v.upd::text[] AS upd, v.del::text[] AS del, v.rd::text[] AS rd
      FROM (VALUES
      ('AbsenceReports', '{DRIFT}', '{DRIFT}', '{DRIFT}', '{}'),
      ('AcademicYearTimplans', '{PLANERING}', '{PLANERING}', '{PLANERING}', '{}'),
      ('AcademicYears', '{PLANERING}', '{PLANERING}', '{PLANERING}', '{}'),
      ('AttendanceRecords', '{DRIFT}', '{DRIFT}', '{DRIFT}', '{}'),
      ('AvailabilityConstraints', '{PLANERING}', '{PLANERING}', '{PLANERING}', '{}'),
      ('CalendarLessonGroups', '{DRIFT}', '{DRIFT}', '{DRIFT}', '{}'),
      ('CalendarLessonStudents', '{DRIFT}', '{DRIFT}', '{DRIFT}', '{}'),
      ('CalendarLessonTeachers', '{DRIFT}', '{DRIFT}', '{DRIFT}', '{}'),
      ('CalendarLessons', '{DRIFT}', '{DRIFT}', '{DRIFT}', '{}'),
      ('CalendarLunches', '{DRIFT}', '{DRIFT}', '{DRIFT}', '{}'),
      ('CalendarRasts', '{DRIFT}', '{DRIFT}', '{DRIFT}', '{}'),
      ('CancellationBatchCredits', '{DRIFT}', '{DRIFT}', '{DRIFT}', '{}'),
      ('CancellationBatchLessons', '{DRIFT}', '{DRIFT}', '{DRIFT}', '{}'),
      ('CancellationBatches', '{DRIFT}', '{DRIFT}', '{DRIFT}', '{}'),
      ('CoverSettings', '{DRIFT}', '{DRIFT}', '{DRIFT}', '{}'),
      ('FrameTimes', '{PLANERING}', '{PLANERING}', '{PLANERING}', '{}'),
      ('GallringRuns', '{}', '{}', '{}', '{}'),
      ('GuardianStudentHistory', '{}', '{}', '{}', '{}'),
      ('GuardianStudents', '{PERSONAL}', '{PERSONAL}', '{PERSONAL}', '{}'),
      ('IntegrationApiKeys', '{INTEGRATIONER}', '{INTEGRATIONER}', '{INTEGRATIONER}', '{}'),
      ('LeaveDelegationDecisions', '{DECIDES}', '{}', '{}', '{}'),
      ('LeaveRequests', '{DRIFT}', '{DRIFT}', '{DRIFT}', '{}'),
      ('LocalTimplanEntries', '{PLANERING}', '{PLANERING}', '{PLANERING}', '{}'),
      ('LocalTimplans', '{PLANERING}', '{PLANERING}', '{PLANERING}', '{}'),
      ('LunchServings', '{PLANERING}', '{PLANERING}', '{PLANERING}', '{}'),
      ('LunchSettings', '{PLANERING}', '{PLANERING}', '{PLANERING}', '{}'),
      ('LunchSittings', '{SCHEMALAGGNING}', '{SCHEMALAGGNING}', '{SCHEMALAGGNING}', '{}'),
      ('MasterLessonGroups', '{SCHEMALAGGNING}', '{SCHEMALAGGNING}', '{SCHEMALAGGNING}', '{}'),
      ('MasterLessonStudents', '{SCHEMALAGGNING}', '{SCHEMALAGGNING}', '{SCHEMALAGGNING}', '{}'),
      ('MasterLessons', '{SCHEMALAGGNING}', '{SCHEMALAGGNING}', '{SCHEMALAGGNING}', '{}'),
      ('Notifications', '{DRIFT}', '{}', '{}', '{}'),
      ('OptimizationJobs', '{SCHEMALAGGNING}', '{SCHEMALAGGNING}', '{SCHEMALAGGNING}', '{}'),
      ('PersonalDataAccess', '{}', '{}', '{}', '{DECIDES}'),
      ('PublicTimetableLinks', '{PUBLICERING}', '{PUBLICERING}', '{PUBLICERING}', '{}'),
      ('PublicationPendingRemovals', '{}', '{}', '{PUBLICERING}', '{}'),
      ('PublicationSettings', '{PUBLICERING}', '{PUBLICERING}', '{PUBLICERING}', '{}'),
      ('PublishedLessons', '{PUBLICERING}', '{PUBLICERING}', '{}', '{}'),
      ('PublishedLunchSittings', '{PUBLICERING}', '{}', '{}', '{}'),
      ('Rasts', '{PLANERING}', '{PLANERING}', '{PLANERING}', '{}'),
      ('RetentionDecisions', '{DECIDES}', '{}', '{}', '{}'),
      ('RoomBookings', '{DRIFT}', '{DRIFT}', '{DRIFT}', '{}'),
      ('RoomPreferenceRooms', '{PLANERING}', '{PLANERING}', '{PLANERING}', '{}'),
      ('RoomPreferences', '{PLANERING}', '{PLANERING}', '{PLANERING}', '{}'),
      ('RoomTypes', '{PLANERING}', '{PLANERING}', '{PLANERING}', '{}'),
      ('Rooms', '{PLANERING}', '{PLANERING}', '{PLANERING}', '{}'),
      ('ScheduleChangeLogs', '{SCHEMALAGGNING}', '{}', '{}', '{}'),
      ('ScheduleVersions', '{SCHEMALAGGNING}', '{SCHEMALAGGNING}', '{SCHEMALAGGNING}', '{}'),
      ('SchoolBreaks', '{PLANERING}', '{PLANERING}', '{PLANERING}', '{}'),
      ('SchoolSignInMethods', '{INTEGRATIONER}', '{INTEGRATIONER}', '{INTEGRATIONER}', '{}'),
      ('SchoolUnits', '{PLANERING}', '{PLANERING}', '{PLANERING}', '{}'),
      ('Schools', '{}', '{PLANERING}', '{}', '{}'),
      ('Ss12000DutyLinks', '{INTEGRATIONER}', '{INTEGRATIONER}', '{}', '{}'),
      ('Ss12000Sources', '{INTEGRATIONER}', '{INTEGRATIONER}', '{}', '{}'),
      ('Ss12000SubscriptionDeliveries', '{}', '{}', '{}', '{}'),
      ('Ss12000Subscriptions', '{}', '{INTEGRATIONER}', '{}', '{}'),
      ('Ss12000SyncChanges', '{}', '{INTEGRATIONER}', '{}', '{}'),
      ('Ss12000SyncRuns', '{INTEGRATIONER}', '{INTEGRATIONER}', '{}', '{}'),
      ('StaffingPolicies', '{PLANERING}', '{PLANERING}', '{PLANERING}', '{}'),
      ('StudentEnrollments', '{}', '{}', '{}', '{}'),
      ('StudentGroupMembers', '{PLANERING}', '{PLANERING}', '{PLANERING}', '{}'),
      ('StudentGroups', '{PLANERING}', '{PLANERING}', '{PLANERING}', '{}'),
      ('Subjects', '{PLANERING}', '{PLANERING}', '{PLANERING}', '{}'),
      ('SubstituteAvailabilities', '{DRIFT}', '{DRIFT}', '{DRIFT}', '{}'),
      ('SubstitutePoolMembers', '{DRIFT}', '{DRIFT}', '{DRIFT}', '{}'),
      ('TeacherAbsenceCovers', '{DRIFT}', '{DRIFT}', '{DRIFT}', '{}'),
      ('TeacherAbsenceReasons', '{DRIFT}', '{DRIFT}', '{DRIFT}', '{}'),
      ('TeacherAbsences', '{DRIFT}', '{DRIFT}', '{DRIFT}', '{}'),
      ('TeacherDuties', '{PLANERING}', '{PLANERING}', '{PLANERING}', '{}'),
      ('TeacherDutySlots', '{PLANERING}', '{}', '{PLANERING}', '{}'),
      ('TeacherEmploymentLogs', '{}', '{}', '{}', '{}'),
      ('TeacherEmploymentPeriods', '{DECIDES}', '{DECIDES}', '{DECIDES}', '{}'),
      ('TeacherEmployments', '{DECIDES}', '{DECIDES}', '{DECIDES}', '{}'),
      ('TeacherPublicLabels', '{PUBLICERING}', '{PUBLICERING}', '{PUBLICERING}', '{}'),
      ('TeacherSubjectQualifications', '{PLANERING}', '{PLANERING}', '{PLANERING}', '{}'),
      ('TeacherWorkRules', '{PLANERING}', '{PLANERING}', '{PLANERING}', '{}'),
      ('TeachingBlocks', '{PLANERING}', '{PLANERING}', '{PLANERING}', '{}'),
      ('TeachingRequirements', '{PLANERING}', '{PLANERING}', '{PLANERING}', '{}'),
      ('TimetablePublications', '{PUBLICERING}', '{}', '{}', '{}'),
      ('TimplanCredits', '{DRIFT}', '{DRIFT}', '{DRIFT}', '{}'),
      ('TimplanStatementPublications', '{PUBLICERING}', '{PUBLICERING}', '{PUBLICERING}', '{}'),
      ('TimplanStatements', '{PUBLICERING}', '{PUBLICERING}', '{PUBLICERING}', '{}'),
      ('UserRoleChanges', '{}', '{}', '{}', '{}'),
      ('Users', '{PERSONAL}', '{PERSONAL,PLANERING}', '{PERSONAL}', '{}')
      ) AS v(tbl, ins, upd, del, rd)
  LOOP
    -- Each command's gate as SQL, NULL for a command with none.
    SELECT string_agg(CASE x WHEN 'DECIDES' THEN '(select app.current_user_decides())'
                             ELSE format('(select app.current_user_may(%L, true))', x) END, ' OR ')
      INTO gate_ins FROM unnest(g.ins) x;
    SELECT string_agg(CASE x WHEN 'DECIDES' THEN '(select app.current_user_decides())'
                             ELSE format('(select app.current_user_may(%L, true))', x) END, ' OR ')
      INTO gate_upd FROM unnest(g.upd) x;
    SELECT string_agg(CASE x WHEN 'DECIDES' THEN '(select app.current_user_decides())'
                             ELSE format('(select app.current_user_may(%L, true))', x) END, ' OR ')
      INTO gate_del FROM unnest(g.del) x;
    SELECT string_agg(CASE x WHEN 'DECIDES' THEN '(select app.current_user_decides())'
                             ELSE format('(select app.current_user_may(%L, true))', x) END, ' OR ')
      INTO gate_rd FROM unnest(g.rd) x;

    FOR p IN
      SELECT pol.polname AS name, pol.polcmd AS cmd,
             pg_get_expr(pol.polqual, pol.polrelid) AS qual,
             pg_get_expr(pol.polwithcheck, pol.polrelid) AS chk,
             CASE WHEN pol.polroles = '{0}'::oid[] THEN 'PUBLIC'
                  ELSE (SELECT string_agg(quote_ident(r.rolname), ', ' ORDER BY r.rolname)
                          FROM pg_roles r WHERE r.oid = ANY (pol.polroles)) END AS roles
        FROM pg_policy pol
       WHERE pol.polrelid = format('public.%I', g.tbl)::regclass
         AND (coalesce(pg_get_expr(pol.polqual, pol.polrelid), '')
              || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')) LIKE '%SCHOOL_ADMIN%'
         -- The two staff arms are amended by hand below.
         AND (coalesce(pg_get_expr(pol.polqual, pol.polrelid), '')
              || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')) NOT LIKE '%TEACHER%'
       ORDER BY pol.polname
    LOOP
      IF p.cmd = '*' THEN
        IF p.name NOT LIKE '%\_admin\_all' OR coalesce(p.chk, p.qual) IS DISTINCT FROM p.qual THEN
          RAISE EXCEPTION 'ADMIN_ARM_UNEXPECTED: %.% is an administrator''s FOR ALL arm this migration does not know how to split', g.tbl, p.name;
        END IF;
        prefix := left(p.name, -length('all'));
        EXECUTE format('DROP POLICY %I ON %I', p.name, g.tbl);
        EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO %s USING (%s)',
                       prefix || 'select', g.tbl, p.roles,
                       CASE WHEN gate_rd IS NULL THEN p.qual ELSE format('(%s) AND (%s)', p.qual, gate_rd) END);
        IF gate_ins IS NOT NULL THEN
          EXECUTE format('CREATE POLICY %I ON %I FOR INSERT TO %s WITH CHECK ((%s) AND (%s))',
                         prefix || 'insert', g.tbl, p.roles, p.qual, gate_ins);
        END IF;
        IF gate_upd IS NOT NULL THEN
          EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE TO %s USING (%s) WITH CHECK ((%s) AND (%s))',
                         prefix || 'update', g.tbl, p.roles, p.qual, p.qual, gate_upd);
        END IF;
        IF gate_del IS NOT NULL THEN
          EXECUTE format('CREATE POLICY %I ON %I FOR DELETE TO %s USING ((%s) AND (%s))',
                         prefix || 'delete', g.tbl, p.roles, p.qual, gate_del);
        END IF;
        split := split + 1;
      ELSIF p.cmd = 'r' THEN
        IF gate_rd IS NOT NULL THEN
          EXECUTE format('ALTER POLICY %I ON %I USING ((%s) AND (%s))', p.name, g.tbl, p.qual, gate_rd);
          amended := amended + 1;
        END IF;
      ELSIF p.cmd = 'a' THEN
        IF gate_ins IS NULL THEN
          RAISE EXCEPTION 'ADMIN_ARM_UNEXPECTED: %.% inserts for an administrator, and the matrix gives % no insert', g.tbl, p.name, g.tbl;
        END IF;
        EXECUTE format('ALTER POLICY %I ON %I WITH CHECK ((%s) AND (%s))', p.name, g.tbl, p.chk, gate_ins);
        amended := amended + 1;
      ELSIF p.cmd = 'w' THEN
        IF gate_upd IS NULL THEN
          RAISE EXCEPTION 'ADMIN_ARM_UNEXPECTED: %.% updates for an administrator, and the matrix gives % no update', g.tbl, p.name, g.tbl;
        END IF;
        EXECUTE format('ALTER POLICY %I ON %I USING (%s) WITH CHECK ((%s) AND (%s))',
                       p.name, g.tbl, p.qual, coalesce(p.chk, p.qual), gate_upd);
        amended := amended + 1;
      ELSIF p.cmd = 'd' THEN
        IF gate_del IS NULL THEN
          RAISE EXCEPTION 'ADMIN_ARM_UNEXPECTED: %.% deletes for an administrator, and the matrix gives % no delete', g.tbl, p.name, g.tbl;
        END IF;
        EXECUTE format('ALTER POLICY %I ON %I USING ((%s) AND (%s))', p.name, g.tbl, p.qual, gate_del);
        amended := amended + 1;
      END IF;
    END LOOP;
  END LOOP;
  RAISE NOTICE 'administrator arms: % split, % amended', split, amended;
END
$$;

-- ---------------------------------------------------------------------------
-- The staff arms that admit an administrator beside a teacher.
-- ---------------------------------------------------------------------------

ALTER POLICY "notifications_staff_insert" ON "Notifications"
    WITH CHECK ("schoolId" = (select app.current_school_id())
                AND ((select app.current_user_role()) = 'TEACHER'
                     OR ((select app.current_user_role()) = 'SCHOOL_ADMIN' AND (select app.current_user_may('DRIFT', true)))));

ALTER POLICY "room_bookings_teacher_insert" ON "RoomBookings"
    WITH CHECK ("schoolId" = (select app.current_school_id())
                AND "bookedById" = (select app.current_user_id())
                AND ((select app.current_user_role()) = 'TEACHER'
                     OR ((select app.current_user_role()) = 'SCHOOL_ADMIN' AND (select app.current_user_may('DRIFT', true)))));

-- ---------------------------------------------------------------------------
-- Users: a planner moves a pupil between classes, and nothing more.
--
-- users_admin_update admits personal's writers and planering's. Somebody who
-- holds planering without personal is here for a class move (Aktivera, which
-- moves the pupils of last year's classes into this year's): the row must be
-- a pupil, and nothing but the class may change. Judged, like
-- Users_administrators_are_decided, for a signed-in person only.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.users_class_moves_are_narrow() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  free text[] := ARRAY['studentGroupId', 'updatedAt'];
BEGIN
  IF app.current_user_id() IS NULL
     OR app.current_service_school_id() IS NOT NULL
     OR app.current_sync_school_id() IS NOT NULL
     OR app.current_user_may('PERSONAL', true) THEN
    RETURN NEW;
  END IF;
  IF OLD."role" <> 'STUDENT' OR (to_jsonb(NEW) - free) IS DISTINCT FROM (to_jsonb(OLD) - free) THEN
    RAISE EXCEPTION 'USER_WRITE_IS_THE_ROSTERS: utan personal flyttar en administratör bara en elev mellan klasser'
      USING ERRCODE = 'AR403',
            DETAIL  = 'area=PERSONAL';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Users_class_moves_are_narrow"
    BEFORE UPDATE ON "Users"
    FOR EACH ROW EXECUTE FUNCTION app.users_class_moves_are_narrow();

-- ---------------------------------------------------------------------------
-- StaffingPolicies: sharing tjänst % with the integrations is a decision.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.staffing_policies_sharing_is_decided() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  was boolean := false;
BEGIN
  IF app.current_user_id() IS NULL
     OR app.current_service_school_id() IS NOT NULL
     OR app.current_sync_school_id() IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    was := OLD."shareEmploymentWithIntegrations";
  END IF;
  IF NEW."shareEmploymentWithIntegrations" IS DISTINCT FROM was AND NOT app.current_user_decides() THEN
    RAISE EXCEPTION 'SHARING_EMPLOYMENT_IS_A_DECISION: bara rektor eller en fullständig administratör delar tjänstgöringsgraden med integrationerna'
      USING ERRCODE = 'AR403',
            DETAIL  = 'area=DECIDES';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "StaffingPolicies_sharing_is_decided"
    BEFORE INSERT OR UPDATE ON "StaffingPolicies"
    FOR EACH ROW EXECUTE FUNCTION app.staffing_policies_sharing_is_decided();

-- ---------------------------------------------------------------------------
-- The integrations' secrets and source ids: integrationer's.
--
-- The three functions below are their earlier bodies with one change: the
-- school comes from app.ss12000_admin_writer_school(), which answers only for
-- an administrator who writes integrationer. Reading a secret's presence
-- stays every administrator's (app.ss12000_admin_school()).
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.ss12000_admin_writer_school() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT CASE WHEN app.current_user_may('INTEGRATIONER', true) THEN app.ss12000_admin_school() END
$$;

COMMENT ON FUNCTION app.ss12000_admin_writer_school() IS
  'app.ss12000_admin_school() for an administrator who writes integrationer, else NULL.';

CREATE OR REPLACE FUNCTION app.integration_key_set_webhook_secret(p_key uuid, p_ciphertext bytea, p_iv bytea, p_tag bytea, p_enc_key_id text)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  school uuid := app.ss12000_admin_writer_school();
  stamped timestamptz := now();
BEGIN
  IF school IS NULL THEN
    RAISE EXCEPTION 'WEBHOOK_SECRET_REFUSED: bara skolans administratör skapar en signeringsnyckel' USING ERRCODE = 'SS403';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "IntegrationApiKeys" k WHERE k."id" = p_key AND k."schoolId" = school AND k."revokedAt" IS NULL) THEN
    RAISE EXCEPTION 'INTEGRATION_KEY_NOT_FOUND: skolan har ingen sådan aktiv nyckel' USING ERRCODE = 'SS404';
  END IF;
  INSERT INTO "IntegrationKeyWebhookSecrets" AS w
         ("keyId", "schoolId", "ciphertext", "iv", "authTag", "encKeyId", "setAt", "setById")
  VALUES (p_key, school, p_ciphertext, p_iv, p_tag, p_enc_key_id, stamped, app.current_user_id())
  ON CONFLICT ("keyId") DO UPDATE
     SET "previousCiphertext" = w."ciphertext", "previousIv" = w."iv", "previousAuthTag" = w."authTag",
         "previousEncKeyId" = w."encKeyId", "previousValidUntil" = stamped + interval '24 hours',
         "ciphertext" = EXCLUDED."ciphertext", "iv" = EXCLUDED."iv", "authTag" = EXCLUDED."authTag",
         "encKeyId" = EXCLUDED."encKeyId", "setAt" = EXCLUDED."setAt", "setById" = EXCLUDED."setById";
  RETURN stamped;
END
$function$;

CREATE OR REPLACE FUNCTION app.ss12000_set_source_secret(p_source uuid, p_kind "Ss12000SecretKind", p_ciphertext bytea, p_iv bytea, p_tag bytea, p_key_id text)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  school uuid := app.ss12000_admin_writer_school();
  stamped timestamptz;
BEGIN
  IF school IS NULL THEN
    RAISE EXCEPTION 'SS12000_SECRET_REFUSED: bara skolans administratör sparar källsystemets hemligheter' USING ERRCODE = 'SS403';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Ss12000Sources" s WHERE s."id" = p_source AND s."schoolId" = school) THEN
    RAISE EXCEPTION 'SS12000_SOURCE_NOT_FOUND: skolan har inget sådant källsystem' USING ERRCODE = 'SS404';
  END IF;
  INSERT INTO "Ss12000SourceSecrets" ("sourceId", "schoolId", "kind", "ciphertext", "iv", "authTag", "keyId", "setAt", "setById")
  VALUES (p_source, school, p_kind, p_ciphertext, p_iv, p_tag, p_key_id, now(), app.current_user_id())
  ON CONFLICT ("sourceId", "kind") DO UPDATE
     SET "ciphertext" = EXCLUDED."ciphertext", "iv" = EXCLUDED."iv", "authTag" = EXCLUDED."authTag",
         "keyId" = EXCLUDED."keyId", "setAt" = EXCLUDED."setAt", "setById" = EXCLUDED."setById"
  RETURNING "setAt" INTO stamped;
  RETURN stamped;
END
$function$;

CREATE OR REPLACE FUNCTION app.ss12000_clear_source_secrets(p_source uuid, p_kinds "Ss12000SecretKind"[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  school uuid := app.ss12000_admin_writer_school();
  cleared integer;
BEGIN
  IF school IS NULL THEN
    RAISE EXCEPTION 'SS12000_SECRET_REFUSED: bara skolans administratör tar bort källsystemets hemligheter' USING ERRCODE = 'SS403';
  END IF;
  DELETE FROM "Ss12000SourceSecrets"
   WHERE "sourceId" = p_source AND "schoolId" = school AND "kind" = ANY (p_kinds);
  GET DIAGNOSTICS cleared = ROW_COUNT;
  RETURN cleared;
END
$function$;

-- A row's SS12000 id is written by an administrator's apply of a sync, which
-- is integrationer's work. Its earlier body, with the area added.
CREATE OR REPLACE FUNCTION app.ss12000_ids_are_written_by_an_admin()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF app.current_service_school_id() IS NULL
     AND app.current_sync_school_id() IS NULL
     AND app.current_user_role() = 'SCHOOL_ADMIN'
     AND app.current_user_may('INTEGRATIONER', true)
     AND app.current_school_id() = NEW."schoolId" THEN
    RETURN NEW;
  END IF;
  -- gallring: a pseudonymised person keeps no source id.
  IF TG_TABLE_NAME = 'Users' AND TG_OP = 'UPDATE' AND NEW."ss12000Id" IS NULL
     AND app.gallring_in_progress(NEW."schoolId") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'SS12000_ID_IS_WRITTEN_BY_AN_ADMIN: bara skolans administratör kopplar en rad till källsystemet'
    USING ERRCODE = 'SS403',
          DETAIL  = format('table=%s operation=%s', TG_TABLE_NAME, TG_OP);
END
$function$;

-- ---------------------------------------------------------------------------
-- Grants, guarded. The new functions are the API's to call where they are
-- called at all; the trigger functions are nobody's.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  fn text;
  r text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'app.users_class_moves_are_narrow()',
    'app.staffing_policies_sharing_is_decided()',
    'app.ss12000_admin_writer_school()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'app_authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', fn, r);
      END IF;
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT EXECUTE ON FUNCTION app.ss12000_admin_writer_school() TO "app_authenticated";
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- The guard: no write arm admits an administrator without asking the area or
-- the decisions. USING for a delete, WITH CHECK for an insert or an update,
-- both for a FOR ALL arm.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(format('%s.%s', tablename, policyname), ', ' ORDER BY tablename, policyname) INTO bad
    FROM pg_policies
   WHERE schemaname = 'public'
     AND cmd <> 'SELECT'
     AND (coalesce(qual, '') || coalesce(with_check, '')) LIKE '%SCHOOL_ADMIN%'
     AND NOT CASE cmd
           WHEN 'INSERT' THEN coalesce(with_check, '') ~ 'app\.current_user_(may|decides)\('
           WHEN 'UPDATE' THEN coalesce(with_check, '') ~ 'app\.current_user_(may|decides)\('
           WHEN 'DELETE' THEN coalesce(qual, '') ~ 'app\.current_user_(may|decides)\('
           ELSE coalesce(qual, '') ~ 'app\.current_user_(may|decides)\('
                AND coalesce(with_check, qual, '') ~ 'app\.current_user_(may|decides)\('
         END;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'ADMIN_ARM_WITHOUT_AREA: % admit an administrator''s write without asking the area', bad;
  END IF;
END
$$;
