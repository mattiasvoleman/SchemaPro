-- En person och en klass minns sitt SS12000-id.
--
-- A sync that matches people by email and classes by name re-keys the
-- roster every night and guesses every time a name repeats: next year's 8A
-- is this year's 7A, and two guardians share a household address. SS12000
-- 2.1.0 gives every object an id that is "samma överförings-ID mellan
-- samtliga ingående system" ("ett enda namespace för de gemensamma ID:na",
-- Person.id, openapi_ss12000_version2_1_0.yaml L5061). This migration stores
-- that id on our rows, so a matched person or class stays matched by id
-- (src/integration/ss12000-sync/diff.ts matches a stored id first, and
-- proposes a LINK by email or name only for an admin to confirm).
--
-- ## The columns
--
--   * Users."ss12000Id" uuid, UNIQUE (schoolId, ss12000Id) WHERE NOT NULL.
--   * StudentGroups."ss12000Id" uuid, the same. An SS12000 group is one
--     object per period, so in practice one per läsår.
--   * GuardianStudents."origin" MANUAL | SS12000, default MANUAL: which links
--     a sync made. A responsible relation has no id in S1, so there is none
--     to store.
--   * Ss12000DutyLinks: which source Duty a teacher holds in which läsår
--     (id, person, role, dates, endedAt), UNIQUE (schoolId, academicYearId,
--     ss12000DutyId), composite keys to Users(id, schoolId) and
--     AcademicYears(id, schoolId). No HR figure: dutyPercent and
--     hoursPerYear are never read into storage (a tjänstgöringsgrad is Fas
--     3's HR data and has its own opt-in), and a link that ended at the
--     source gets endedAt and is never deleted. The provider half will use
--     it to reference the source's Duty ids.
--
-- Every column is new and nullable or defaulted; no existing row changes.
-- The P4 class-history trigger (20261010120000) fires on UPDATE OF
-- studentGroupId, isActive, role, so a new column does not wake it, and
-- every class move a sync makes still goes through it and is recorded.
--
-- ## Who writes an id
--
-- app.ss12000_ids_are_written_by_an_admin (BEFORE INSERT and BEFORE UPDATE
-- OF ss12000Id on Users and StudentGroups, only when the value is set or
-- moves): a SCHOOL_ADMIN acting with their own claims for the row's school,
-- and nobody else (SS403). A LINK, a RELINK and a CREATE are therefore
-- always an admin's apply: neither the nightly run (the sync principal)
-- nor the v1 import (the service principal) can attach a person to a
-- source identity, and a teacher cannot claim one.
--
-- ## What the sync principal may write
--
-- The nightly run applies only what the admin let it (scheduleAutoApply)
-- and only the safe kinds of change. The database holds it to that:
--
--   * Users: SELECT and UPDATE of its school's rows, narrowed by
--     app.users_sync_writes_are_narrow (BEFORE UPDATE): firstName,
--     lastName, studentGroupId, and isActive true -> false only, and that
--     only for a pupil or a guardian (a wrong end date at the source must
--     not lock a teacher out the next morning). Never on a SCHOOL_ADMIN
--     row, never a reactivation (a person an admin deactivated stays so,
--     and a login cannot come back by itself), never an email (an
--     invitation goes to it), never an id, a role or authId. No INSERT arm:
--     a new person is always an admin's apply, and only a catalogue row
--     (UsersService's identity rule: no Supabase identity, no mail).
--   * StudentGroups: SELECT only. A rename waits for an admin.
--   * StudentGroupMembers: SELECT and INSERT, the insert holding the group
--     and the pupil to the same school and the pupil to role STUDENT.
--   * GuardianStudents: SELECT and INSERT. Both ends are already held to
--     the school by the composite keys of 20260822090000.
--   * Ss12000DutyLinks: SELECT, INSERT and UPDATE.
--   * AcademicYears, Schools: SELECT.
--
-- No DELETE arm for the principal anywhere: a sync never removes a row. A
-- guardian link the source ended is either the guardian's deactivation
-- (no child left) or a conflict the admin resolves with the existing
-- unlink; the closing guard SS12000_SYNC_REACH fails the deploy if any arm
-- naming app.current_sync_school_id() is DELETE or ALL.
--
-- ## GuardianStudentHistory
--
-- A guardian link is access to a child's schedule, and until now an unlink
-- left no trace. An AFTER DELETE trigger on GuardianStudents
-- (app.guardian_student_history_record, SECURITY DEFINER) writes every
-- unlink, manual or not, as ids only: guardian, pupil, origin, when the link
-- was made, when it went and who removed it (app.current_user_id(), NULL
-- for the owner). Written only by that trigger (a guard refuses direct
-- writes and TRUNCATE, P4's pattern); read by the school's admin. Inside a
-- school's own deletion the school is already gone, and nothing is
-- recorded.
--
-- ## Grants
--
-- Guarded as in 20261013110000. Ss12000DutyLinks: app_authenticated
-- SELECT, INSERT, UPDATE. GuardianStudentHistory: SELECT only. authenticated
-- loses what pg_default_acl gives beyond that; anon nothing; service_role
-- no write.

ALTER TABLE "Users" ADD COLUMN "ss12000Id" UUID;
ALTER TABLE "StudentGroups" ADD COLUMN "ss12000Id" UUID;

CREATE UNIQUE INDEX "Users_schoolId_ss12000Id_key" ON "Users"("schoolId", "ss12000Id") WHERE "ss12000Id" IS NOT NULL;
CREATE UNIQUE INDEX "StudentGroups_schoolId_ss12000Id_key" ON "StudentGroups"("schoolId", "ss12000Id") WHERE "ss12000Id" IS NOT NULL;

CREATE TYPE "GuardianLinkOrigin" AS ENUM ('MANUAL', 'SS12000');
ALTER TABLE "GuardianStudents" ADD COLUMN "origin" "GuardianLinkOrigin" NOT NULL DEFAULT 'MANUAL';

CREATE TABLE "Ss12000DutyLinks" (
    "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"       UUID NOT NULL,
    "userId"         UUID NOT NULL,
    "academicYearId" UUID NOT NULL,
    "ss12000DutyId"  UUID NOT NULL,
    "dutyRole"       TEXT NOT NULL,
    "startDate"      DATE NOT NULL,
    "endDate"        DATE,
    "endedAt"        TIMESTAMPTZ(6),
    "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "Ss12000DutyLinks_pkey" PRIMARY KEY ("id"),
    -- S1's DutyRole enum (openapi_ss12000_version2_1_0.yaml), spelled as it is.
    CONSTRAINT "Ss12000DutyLinks_dutyRole_is_s1" CHECK ("dutyRole" IN (
        'Rektor', 'Lärare', 'Förskollärare', 'Barnskötare', 'Bibliotekarie', 'Lärarassistent',
        'Fritidspedagog', 'Annan personal', 'Studie- och yrkesvägledare', 'Förstelärare', 'Kurator',
        'Skolsköterska', 'Skolläkare', 'Skolpsykolog', 'Speciallärare/specialpedagog',
        'Skoladministratör', 'Övrig arbetsledning', 'Övrig pedagogisk personal', 'Förskolechef')),
    CONSTRAINT "Ss12000DutyLinks_dates_are_ordered" CHECK ("endDate" IS NULL OR "endDate" >= "startDate")
);

CREATE UNIQUE INDEX "Ss12000DutyLinks_schoolId_academicYearId_ss12000DutyId_key"
    ON "Ss12000DutyLinks"("schoolId", "academicYearId", "ss12000DutyId");
CREATE INDEX "Ss12000DutyLinks_userId_schoolId_idx" ON "Ss12000DutyLinks"("userId", "schoolId");
CREATE INDEX "Ss12000DutyLinks_academicYearId_schoolId_idx" ON "Ss12000DutyLinks"("academicYearId", "schoolId");

ALTER TABLE "Ss12000DutyLinks"
    ADD CONSTRAINT "Ss12000DutyLinks_userId_schoolId_fkey"
    FOREIGN KEY ("userId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Ss12000DutyLinks"
    ADD CONSTRAINT "Ss12000DutyLinks_academicYearId_schoolId_fkey"
    FOREIGN KEY ("academicYearId", "schoolId") REFERENCES "AcademicYears"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "GuardianStudentHistory" (
    "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"     UUID NOT NULL,
    "guardianId"   UUID NOT NULL,
    "studentId"    UUID NOT NULL,
    "origin"       "GuardianLinkOrigin" NOT NULL,
    "linkedAt"     TIMESTAMPTZ(6) NOT NULL,
    "unlinkedAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "unlinkedById" UUID,

    CONSTRAINT "GuardianStudentHistory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GuardianStudentHistory_schoolId_studentId_idx" ON "GuardianStudentHistory"("schoolId", "studentId");

ALTER TABLE "GuardianStudentHistory"
    ADD CONSTRAINT "GuardianStudentHistory_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Who writes an id. See the preamble.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.ss12000_ids_are_written_by_an_admin() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF app.current_service_school_id() IS NULL
     AND app.current_sync_school_id() IS NULL
     AND app.current_user_role() = 'SCHOOL_ADMIN'
     AND app.current_school_id() = NEW."schoolId" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'SS12000_ID_IS_WRITTEN_BY_AN_ADMIN: bara skolans administratör kopplar en rad till källsystemet'
    USING ERRCODE = 'SS403',
          DETAIL  = format('table=%s operation=%s', TG_TABLE_NAME, TG_OP);
END
$$;

CREATE TRIGGER "Users_ss12000Id_on_insert"
    BEFORE INSERT ON "Users"
    FOR EACH ROW
    WHEN (NEW."ss12000Id" IS NOT NULL)
    EXECUTE FUNCTION app.ss12000_ids_are_written_by_an_admin();
CREATE TRIGGER "Users_ss12000Id_on_update"
    BEFORE UPDATE OF "ss12000Id" ON "Users"
    FOR EACH ROW
    WHEN (OLD."ss12000Id" IS DISTINCT FROM NEW."ss12000Id")
    EXECUTE FUNCTION app.ss12000_ids_are_written_by_an_admin();
CREATE TRIGGER "StudentGroups_ss12000Id_on_insert"
    BEFORE INSERT ON "StudentGroups"
    FOR EACH ROW
    WHEN (NEW."ss12000Id" IS NOT NULL)
    EXECUTE FUNCTION app.ss12000_ids_are_written_by_an_admin();
CREATE TRIGGER "StudentGroups_ss12000Id_on_update"
    BEFORE UPDATE OF "ss12000Id" ON "StudentGroups"
    FOR EACH ROW
    WHEN (OLD."ss12000Id" IS DISTINCT FROM NEW."ss12000Id")
    EXECUTE FUNCTION app.ss12000_ids_are_written_by_an_admin();

-- ---------------------------------------------------------------------------
-- What the sync principal may change on a person. See the preamble.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.users_sync_writes_are_narrow() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  free text[] := ARRAY['firstName', 'lastName', 'studentGroupId', 'isActive', 'updatedAt'];
BEGIN
  IF app.current_sync_school_id() IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD."role" = 'SCHOOL_ADMIN' THEN
    RAISE EXCEPTION 'SS12000_SYNC_WRITES_ARE_NARROW: en synk ändrar aldrig en administratör'
      USING ERRCODE = 'SS403';
  END IF;
  IF NEW."isActive" AND NOT OLD."isActive" THEN
    RAISE EXCEPTION 'SS12000_SYNC_WRITES_ARE_NARROW: en synk återaktiverar ingen, det gör en administratör'
      USING ERRCODE = 'SS403';
  END IF;
  IF OLD."isActive" AND NOT NEW."isActive" AND OLD."role" NOT IN ('STUDENT', 'GUARDIAN') THEN
    RAISE EXCEPTION 'SS12000_SYNC_WRITES_ARE_NARROW: en synk avaktiverar aldrig personal, det gör en administratör'
      USING ERRCODE = 'SS403';
  END IF;
  IF (to_jsonb(NEW) - free) IS DISTINCT FROM (to_jsonb(OLD) - free) THEN
    RAISE EXCEPTION 'SS12000_SYNC_WRITES_ARE_NARROW: en synk ändrar bara namn, klass och avaktivering'
      USING ERRCODE = 'SS403';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Users_sync_writes_are_narrow"
    BEFORE UPDATE ON "Users"
    FOR EACH ROW EXECUTE FUNCTION app.users_sync_writes_are_narrow();

-- ---------------------------------------------------------------------------
-- GuardianStudentHistory: every unlink, written by the trigger alone.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.guardian_student_history_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  -- Inside a school's cascade the school is already gone: nothing to record.
  IF NOT EXISTS (SELECT 1 FROM "Schools" s WHERE s."id" = OLD."schoolId") THEN
    RETURN NULL;
  END IF;
  INSERT INTO "GuardianStudentHistory" ("schoolId", "guardianId", "studentId", "origin", "linkedAt", "unlinkedAt", "unlinkedById")
  VALUES (OLD."schoolId", OLD."guardianId", OLD."studentId", OLD."origin", OLD."createdAt", now(), app.current_user_id());
  RETURN NULL;
END
$$;

CREATE FUNCTION app.guardian_student_history_written_by_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF TG_OP <> 'TRUNCATE' AND pg_trigger_depth() > 1 THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'GUARDIAN_HISTORY_IS_RECORDED: historiken över vårdnadshavarkopplingar skrivs bara av databasen'
    USING ERRCODE = 'SS403',
          DETAIL  = format('operation=%s', TG_OP);
END
$$;

CREATE TRIGGER "GuardianStudents_history_on_delete"
    AFTER DELETE ON "GuardianStudents"
    FOR EACH ROW EXECUTE FUNCTION app.guardian_student_history_record();

CREATE TRIGGER "GuardianStudentHistory_written_by_trigger"
    BEFORE INSERT OR UPDATE OR DELETE ON "GuardianStudentHistory"
    FOR EACH ROW EXECUTE FUNCTION app.guardian_student_history_written_by_trigger();

CREATE TRIGGER "GuardianStudentHistory_no_truncate"
    BEFORE TRUNCATE ON "GuardianStudentHistory"
    FOR EACH STATEMENT EXECUTE FUNCTION app.guardian_student_history_written_by_trigger();

REVOKE ALL ON FUNCTION app.ss12000_ids_are_written_by_an_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.users_sync_writes_are_narrow() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.guardian_student_history_record() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.guardian_student_history_written_by_trigger() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Row-level security. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "Ss12000DutyLinks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GuardianStudentHistory" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ss12000_duty_links_admin_select" ON "Ss12000DutyLinks"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
CREATE POLICY "ss12000_duty_links_admin_insert" ON "Ss12000DutyLinks"
    FOR INSERT TO "authenticated"
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
CREATE POLICY "ss12000_duty_links_admin_update" ON "Ss12000DutyLinks"
    FOR UPDATE TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

CREATE POLICY "guardian_student_history_admin_select" ON "GuardianStudentHistory"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

-- The sync principal's arms.
CREATE POLICY "users_sync_select" ON "Users"
    FOR SELECT
    USING ("schoolId" = app.current_sync_school_id());
CREATE POLICY "users_sync_update" ON "Users"
    FOR UPDATE
    USING ("schoolId" = app.current_sync_school_id())
    WITH CHECK ("schoolId" = app.current_sync_school_id());

CREATE POLICY "student_groups_sync_select" ON "StudentGroups"
    FOR SELECT
    USING ("schoolId" = app.current_sync_school_id());

CREATE POLICY "student_group_members_sync_select" ON "StudentGroupMembers"
    FOR SELECT
    USING ("schoolId" = app.current_sync_school_id());
CREATE POLICY "student_group_members_sync_insert" ON "StudentGroupMembers"
    FOR INSERT
    WITH CHECK (
        "schoolId" = app.current_sync_school_id()
        AND EXISTS (SELECT 1 FROM "StudentGroups" g
                     WHERE g."id" = "StudentGroupMembers"."studentGroupId" AND g."schoolId" = "StudentGroupMembers"."schoolId")
        AND EXISTS (SELECT 1 FROM "Users" u
                     WHERE u."id" = "StudentGroupMembers"."studentId" AND u."schoolId" = "StudentGroupMembers"."schoolId"
                       AND u."role" = 'STUDENT'));

CREATE POLICY "guardian_students_sync_select" ON "GuardianStudents"
    FOR SELECT
    USING ("schoolId" = app.current_sync_school_id());
CREATE POLICY "guardian_students_sync_insert" ON "GuardianStudents"
    FOR INSERT
    WITH CHECK ("schoolId" = app.current_sync_school_id());

CREATE POLICY "academic_years_sync_select" ON "AcademicYears"
    FOR SELECT
    USING ("schoolId" = app.current_sync_school_id());

CREATE POLICY "schools_sync_select" ON "Schools"
    FOR SELECT
    USING ("id" = app.current_sync_school_id());

CREATE POLICY "ss12000_duty_links_sync_select" ON "Ss12000DutyLinks"
    FOR SELECT
    USING ("schoolId" = app.current_sync_school_id());
CREATE POLICY "ss12000_duty_links_sync_insert" ON "Ss12000DutyLinks"
    FOR INSERT
    WITH CHECK ("schoolId" = app.current_sync_school_id());
CREATE POLICY "ss12000_duty_links_sync_update" ON "Ss12000DutyLinks"
    FOR UPDATE
    USING ("schoolId" = app.current_sync_school_id())
    WITH CHECK ("schoolId" = app.current_sync_school_id());

-- ---------------------------------------------------------------------------
-- Grants, guarded.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT SELECT, INSERT, UPDATE ON "Ss12000DutyLinks" TO "app_authenticated";
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON "Ss12000DutyLinks" FROM "app_authenticated";
    GRANT SELECT ON "GuardianStudentHistory" TO "app_authenticated";
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "GuardianStudentHistory" FROM "app_authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON "Ss12000DutyLinks" FROM "authenticated";
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "GuardianStudentHistory" FROM "authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "Ss12000DutyLinks" FROM "anon";
    REVOKE ALL ON "GuardianStudentHistory" FROM "anon";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "Ss12000DutyLinks" FROM "service_role";
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "GuardianStudentHistory" FROM "service_role";
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- SS12000_SYNC_REACH: no arm naming the sync principal is DELETE or ALL, or
-- carries an OR; the duty links and the guardian history are reached by
-- their admin arms and the sync's, nothing else.
-- ---------------------------------------------------------------------------

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(p.tablename || '.' || p.policyname, ', ' ORDER BY p.tablename, p.policyname) INTO bad
    FROM pg_policies p
   WHERE p.schemaname = 'public'
     AND (
           (coalesce(p.qual, '') || coalesce(p.with_check, '') LIKE '%current_sync_school_id()%'
            AND (p.cmd NOT IN ('SELECT', 'INSERT', 'UPDATE') OR coalesce(p.qual, '') || coalesce(p.with_check, '') ~* '\mOR\M'))
        OR (p.tablename = 'Ss12000DutyLinks' AND NOT (
                 p.policyname LIKE 'ss12000_duty_links_admin_%' AND p.roles = '{authenticated}'::name[]
                 AND coalesce(p.qual, p.with_check) LIKE '%SCHOOL_ADMIN%'
              OR p.policyname LIKE 'ss12000_duty_links_sync_%'))
        OR (p.tablename = 'GuardianStudentHistory' AND NOT (
                 p.policyname = 'guardian_student_history_admin_select' AND p.cmd = 'SELECT'
                 AND coalesce(p.qual, '') LIKE '%SCHOOL_ADMIN%'))
     );
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'SS12000_SYNC_REACH: these arms reach further than the sync and the admin may: %', bad;
  END IF;
END
$$;
