-- En tjänst minns sina versioner.
--
-- A tjänstefördelning is negotiated. The samverkan protokoll of a spring
-- meeting says "Anna 80 %, nedsättning 10 %, mentor 7B 90 min" — and in
-- September nobody can say whether that is what the system held when the
-- protokoll was signed, because TeacherEmployments and TeacherDuties keep the
-- row as it is NOW and nothing else. Fas 3 gives a post and its uppdrag a
-- history: every write records the row before and after, who wrote it and
-- when, in the same transaction as the write, so a protokoll can cite
-- "Tjänstens version 7 (2026-04-14)" and the version still says the same
-- thing a year later.
--
-- ## One table, about the TEACHER and the YEAR
--
-- TeacherEmploymentLogs: one row per change to one employment or one duty.
-- Duties are in it, deliberately: uppdrag are part of the tjänst samverkan
-- negotiates (mentorskap, förstelärare, ämnesansvar), and a history that cites
-- the post without its uppdrag cites half of it. The row is keyed by the
-- teacher the change is ABOUT (userId) and the läsår, because that is the
-- question asked of it — "what was Anna's tjänst this year, version by
-- version" — and because RLS answers a teacher by that column.
--
--   * entity EMPLOYMENT | DUTY, entityId the row's id. entityId has NO foreign
--     key: the history outlives a deleted duty, which is exactly when it is
--     read ("what did she have before it was removed?").
--   * action CREATE | UPDATE | DELETE, with before/after JSONB shaped by the
--     action (TeacherEmploymentLogs_shape): CREATE has only after, DELETE only
--     before, UPDATE both. The JSON is the row as the table holds it, minus
--     schoolId (the log row carries it), createdAt and updatedAt (bookkeeping
--     that changes on every save and would make every no-op a version).
--   * actorId: app.current_user_id() of the writer — the admin behind the
--     request, the import, the rollover — and NULL for a migration, the seed or
--     the owner's own psql. No foreign key, as ScheduleChangeLogs.actorId has
--     none: it is a citation of who wrote, not a relation, and a person
--     deleted later must not take colleagues' histories with them.
--
-- ## Version, not a sequence
--
-- "version" INT, per (schoolId, userId, academicYearId), starting at 1 and
-- assigned by the trigger as max + 1 under a transaction-level advisory lock on
-- the (teacher, year) pair. Not a global IDENTITY: "Version #18234" is no
-- citation a protokoll can carry, and a BIGINT would be the schema's first —
-- Prisma reads it as a BigInt, which JSON.stringify refuses in a Nest response.
-- Because the log is append-only (below), "Version 7" names the same change
-- forever. The UNIQUE index on (schoolId, userId, academicYearId, version) is
-- both the guarantee and the history read's index. The advisory lock is what
-- makes max + 1 safe at READ COMMITTED: two transactions writing Anna's post
-- at once would otherwise read the same max and one would die on the unique
-- index; with the lock the second waits for the first to commit and reads its
-- row. hashtextextended over the two ids is a 64-bit key; a collision between
-- two pairs costs a wait, never a wrong answer.
--
-- createdAt is clock_timestamp(), not now(): now() is the transaction's start,
-- so the two rows an owner change writes (below) and an import's hundred
-- rows would all carry one instant. The version orders them; the time is the
-- time the row was written.
--
-- ## Written by a trigger, on every writer
--
-- AFTER INSERT OR UPDATE OR DELETE FOR EACH ROW on both tables. Not in the
-- services: six code paths write these rows today — the employment PUT and
-- DELETE, the duty POST/PATCH/DELETE, the CSV import (employments and duties),
-- the läsårsrullning's carry (createMany twice), the staffing-rollover endpoint
-- — and an admin's own Supabase token reaches both tables through PostgREST
-- without meeting a service at all. A trigger is the only "same transaction,
-- every writer" there is. Its function is SECURITY DEFINER, owned by the
-- migration owner, in "app" with a pinned search_path and EXECUTE taken from
-- PUBLIC, for 20261007090000's reasons; it inserts into an RLS table that has
-- no INSERT policy, which works because the owner is not subject to RLS (no
-- table here has FORCE ROW LEVEL SECURITY; the Fas 2 triggers rely on the
-- same).
--
--   * An UPDATE whose stripped JSON is unchanged writes nothing. The
--     employment PUT replaces the whole row every time and an import re-sends
--     identical rows; neither is a version.
--   * An UPDATE that moves a row to another teacher, year or school writes
--     TWO rows: a DELETE-shaped one under the OLD owner (before = OLD) and a
--     CREATE-shaped one under the NEW (after = NEW). The DTOs forbid moving a
--     post, but PostgREST does not; with one row filed under the new owner,
--     teacher B's own arm would show B the `before` of teacher A's duty —
--     label, minutes, note. Each owner sees exactly their own half.
--
-- ## The existence rule: nothing that works today is refused
--
-- A log row has composite keys to Users, AcademicYears and Schools, ON DELETE
-- CASCADE, so a person's or a year's history goes with them. That makes the
-- trigger dangerous inside a cascade. Deleting a teacher cascades to their
-- TeacherEmployments row (a DELETE the trigger sees) and to their
-- AvailabilityConstraints, which SET NULLs TeacherDuties.blockedConstraintId (an
-- UPDATE the trigger sees); deleting a year cascades to its StudentGroups,
-- which SET NULLs TeacherDuties.studentGroupId. A log row written there would
-- reference the very person or year the outer statement has already removed,
-- the log's own foreign key would refuse it, and the delete of the person, the
-- year or the whole school would abort — depending on the order Postgres
-- happens to fire the referential triggers in, which is by trigger name, i.e.
-- not something anybody chose.
--
-- So each log row is written only if its school, its teacher and its year
-- still exist, read as the definer. The outer DELETE is visible inside the
-- cascade, so a person or year being deleted is already gone and the change
-- is simply not logged — its history is about to cascade away with it anyway,
-- which is the GDPR-consistent outcome: a person who is erased is erased from
-- the history too. A SET NULL from a subject being deleted (TeacherDuties
-- .subjectId) leaves teacher and year in place and IS logged, with the admin
-- who deleted the subject as actor.
--
-- The test runs for EVERY row, not only "inside a cascade". The design
-- proposed pg_trigger_depth() > 1 as a cheap pre-test; measured on
-- PostgreSQL 16, the AFTER row triggers a referential CASCADE queues fire at
-- the end of the outer statement and report depth 1, exactly like a direct
-- write, so the pre-test would skip the check in the one case it exists for
-- (deleting a person with a post failed on the log's user key). Three primary
-- key probes per logged row is the whole cost.
--
-- ## Append-only, for every role
--
-- RLS and GRANTs do not bind the owner or Supabase's service_role (BYPASSRLS),
-- and a history that the service key can rewrite is no history. So three
-- guards on the log itself, BEFORE INSERT / UPDATE / DELETE FOR EACH ROW:
--
--   * INSERT is refused unless it comes from a trigger (pg_trigger_depth() >
--     1 inside the guard): the logging trigger's own insert passes, a direct
--     INSERT from any role does not.
--   * UPDATE is refused unless it is a cascade (depth > 1). Nothing updates a
--     log row; the only update that can reach one is ON UPDATE CASCADE of a
--     parent's id, which the house keys allow and which must not abort the
--     parent.
--   * DELETE is refused unless it is a cascade (depth > 1): the person, the
--     year or the school deleted takes the history with them (above); nobody
--     deletes a version on its own.
--
-- The depth reads differently here than in the writer, and was measured so:
-- a BEFORE row trigger fires inside the referential action's own statement,
-- which runs inside the RI trigger, so a cascaded DELETE meets this guard at
-- depth 2 while a DELETE typed by anybody meets it at depth 1.
--
-- The guards raise SQLSTATE 'TL403' with no person or label in the message,
-- for 20261007090000's reason: a refusal is logged.
--
-- ## Row-level security: the teacher's own, and the admin's
--
--   * teacher_employment_logs_admin_select: the school's SCHOOL_ADMIN reads
--     every row.
--   * teacher_employment_logs_teacher_own_select: a TEACHER reads the rows
--     ABOUT THEM and no colleague's — TeacherEmployments' and TeacherDuties'
--     own arms, for their reason: a colleague's deltid, nedsättning and
--     uppdrag are HR data.
--
-- Both TO "authenticated", role and id tests in USING. No write arm for anyone
-- (the trigger writes as the owner), no staff arm, no pupil or guardian arm,
-- no service-principal arm: SS12000's /duties reads the posts, not their
-- history. GRANT SELECT to app_authenticated, guarded as every migration here
-- guards it; and INSERT, UPDATE, DELETE are REVOKEd from authenticated, anon
-- and service_role, which 20260806000000's default privileges would otherwise
-- hand them — RLS would refuse authenticated anyway, but the grant states the
-- intent, and for service_role the REVOKE and the guards are what refuse.

-- ---------------------------------------------------------------------------
-- Enums and the table
-- ---------------------------------------------------------------------------

CREATE TYPE "TeacherLogEntity" AS ENUM ('EMPLOYMENT', 'DUTY');
CREATE TYPE "TeacherLogAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE');

CREATE TABLE "TeacherEmploymentLogs" (
    "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"       UUID NOT NULL,
    "userId"         UUID NOT NULL,
    "academicYearId" UUID NOT NULL,
    "version"        INTEGER NOT NULL,
    "entity"         "TeacherLogEntity" NOT NULL,
    "entityId"       UUID NOT NULL,
    "action"         "TeacherLogAction" NOT NULL,
    "before"         JSONB,
    "after"          JSONB,
    "actorId"        UUID,
    "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "TeacherEmploymentLogs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TeacherEmploymentLogs_version_positive" CHECK ("version" >= 1),
    CONSTRAINT "TeacherEmploymentLogs_shape" CHECK (
        ("action" = 'CREATE' AND "before" IS NULL AND "after" IS NOT NULL)
        OR ("action" = 'UPDATE' AND "before" IS NOT NULL AND "after" IS NOT NULL)
        OR ("action" = 'DELETE' AND "before" IS NOT NULL AND "after" IS NULL)
    )
);

-- The guarantee and the history read's index: one version number per teacher
-- and year, read newest first.
CREATE UNIQUE INDEX "TeacherEmploymentLogs_version_key"
    ON "TeacherEmploymentLogs"("schoolId", "userId", "academicYearId", "version");
-- "Which versions touched this duty": the history card groups by it.
CREATE INDEX "TeacherEmploymentLogs_entityId_idx" ON "TeacherEmploymentLogs"("entityId");

ALTER TABLE "TeacherEmploymentLogs"
    ADD CONSTRAINT "TeacherEmploymentLogs_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TeacherEmploymentLogs"
    ADD CONSTRAINT "TeacherEmploymentLogs_userId_schoolId_fkey"
    FOREIGN KEY ("userId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TeacherEmploymentLogs"
    ADD CONSTRAINT "TeacherEmploymentLogs_academicYearId_schoolId_fkey"
    FOREIGN KEY ("academicYearId", "schoolId") REFERENCES "AcademicYears"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- The writer. See the preamble.
-- ---------------------------------------------------------------------------

-- One log row, if its parents still exist (the existence rule), at the next
-- version of its (teacher, year).
CREATE FUNCTION app.teacher_staffing_log_write(
    p_school uuid, p_user uuid, p_year uuid,
    p_entity "TeacherLogEntity", p_entity_id uuid, p_action "TeacherLogAction",
    p_before jsonb, p_after jsonb, p_actor uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  next_version integer;
BEGIN
  -- Inside a cascade the outer statement's delete is visible: a person, year
  -- or school being deleted is already gone, and its history goes with it.
  -- Asked of every row: a cascade's AFTER triggers report depth 1 too.
  IF NOT (
       EXISTS (SELECT 1 FROM "Schools" s WHERE s."id" = p_school)
       AND EXISTS (SELECT 1 FROM "Users" u WHERE u."id" = p_user AND u."schoolId" = p_school)
       AND EXISTS (SELECT 1 FROM "AcademicYears" y WHERE y."id" = p_year AND y."schoolId" = p_school)
     ) THEN
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_user::text || ':' || p_year::text, 0));
  SELECT COALESCE(max(l."version"), 0) + 1
    INTO next_version
    FROM "TeacherEmploymentLogs" l
   WHERE l."schoolId" = p_school AND l."userId" = p_user AND l."academicYearId" = p_year;

  INSERT INTO "TeacherEmploymentLogs"
      ("schoolId", "userId", "academicYearId", "version", "entity", "entityId",
       "action", "before", "after", "actorId", "createdAt")
  VALUES (p_school, p_user, p_year, next_version, p_entity, p_entity_id,
          p_action, p_before, p_after, p_actor, clock_timestamp());
END
$$;

CREATE FUNCTION app.teacher_staffing_log() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  entity "TeacherLogEntity" :=
    CASE TG_TABLE_NAME WHEN 'TeacherEmployments' THEN 'EMPLOYMENT'::"TeacherLogEntity"
                       ELSE 'DUTY'::"TeacherLogEntity" END;
  stripped text[] := ARRAY['schoolId', 'createdAt', 'updatedAt'];
  old_row jsonb;
  new_row jsonb;
  actor uuid := app.current_user_id();
BEGIN
  IF TG_OP = 'INSERT' THEN
    new_row := to_jsonb(NEW) - stripped;
    PERFORM app.teacher_staffing_log_write(NEW."schoolId", NEW."userId", NEW."academicYearId",
                                           entity, NEW."id", 'CREATE', NULL, new_row, actor);
    RETURN NULL;
  END IF;

  IF TG_OP = 'DELETE' THEN
    old_row := to_jsonb(OLD) - stripped;
    PERFORM app.teacher_staffing_log_write(OLD."schoolId", OLD."userId", OLD."academicYearId",
                                           entity, OLD."id", 'DELETE', old_row, NULL, actor);
    RETURN NULL;
  END IF;

  old_row := to_jsonb(OLD) - stripped;
  new_row := to_jsonb(NEW) - stripped;
  IF old_row = new_row AND OLD."schoolId" = NEW."schoolId" THEN
    -- A save that changed nothing a reader can see is no version.
    RETURN NULL;
  END IF;

  IF OLD."userId" IS DISTINCT FROM NEW."userId"
     OR OLD."academicYearId" IS DISTINCT FROM NEW."academicYearId"
     OR OLD."schoolId" IS DISTINCT FROM NEW."schoolId"
     OR OLD."id" IS DISTINCT FROM NEW."id" THEN
    -- Moved to another owner: each owner gets their own half, so no teacher's
    -- arm ever shows them a colleague's `before`.
    PERFORM app.teacher_staffing_log_write(OLD."schoolId", OLD."userId", OLD."academicYearId",
                                           entity, OLD."id", 'DELETE', old_row, NULL, actor);
    PERFORM app.teacher_staffing_log_write(NEW."schoolId", NEW."userId", NEW."academicYearId",
                                           entity, NEW."id", 'CREATE', NULL, new_row, actor);
    RETURN NULL;
  END IF;

  PERFORM app.teacher_staffing_log_write(NEW."schoolId", NEW."userId", NEW."academicYearId",
                                         entity, NEW."id", 'UPDATE', old_row, new_row, actor);
  -- An AFTER trigger's return value is ignored.
  RETURN NULL;
END
$$;

-- The guards. Inside a trigger function pg_trigger_depth() is 1 when a
-- statement fired it directly and more when another trigger or a referential
-- action did.
CREATE FUNCTION app.teacher_employment_logs_append_only() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    -- INSERT: the logging trigger's own write. UPDATE/DELETE: a parent's
    -- referential action (an id renamed, a person, year or school deleted).
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'TEACHER_EMPLOYMENT_LOG_IS_APPEND_ONLY: en tjänsts historik skrivs bara av databasen och ändras aldrig'
    USING ERRCODE = 'TL403',
          DETAIL  = format('operation=%s', TG_OP);
END
$$;

REVOKE ALL ON FUNCTION app.teacher_staffing_log_write(uuid, uuid, uuid, "TeacherLogEntity", uuid, "TeacherLogAction", jsonb, jsonb, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.teacher_staffing_log() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.teacher_employment_logs_append_only() FROM PUBLIC;

CREATE TRIGGER "TeacherEmployments_log"
    AFTER INSERT OR UPDATE OR DELETE ON "TeacherEmployments"
    FOR EACH ROW EXECUTE FUNCTION app.teacher_staffing_log();

CREATE TRIGGER "TeacherDuties_log"
    AFTER INSERT OR UPDATE OR DELETE ON "TeacherDuties"
    FOR EACH ROW EXECUTE FUNCTION app.teacher_staffing_log();

CREATE TRIGGER "TeacherEmploymentLogs_append_only"
    BEFORE INSERT OR UPDATE OR DELETE ON "TeacherEmploymentLogs"
    FOR EACH ROW EXECUTE FUNCTION app.teacher_employment_logs_append_only();

-- ---------------------------------------------------------------------------
-- Row-level security. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "TeacherEmploymentLogs" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "teacher_employment_logs_admin_select" ON "TeacherEmploymentLogs"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

-- Their own history, read only. app.current_user_id() is NULL for anybody
-- without an active Users row, and "userId" = NULL matches nothing.
CREATE POLICY "teacher_employment_logs_teacher_own_select" ON "TeacherEmploymentLogs"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) = 'TEACHER'
        AND "userId" = (select app.current_user_id())
    );

-- Read for the API role; never written by any API role. Guarded, as
-- 20260930120000 and 20260914180000 explain: a role missing in one
-- environment must not abort the deploy there.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT SELECT ON "TeacherEmploymentLogs" TO "app_authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE INSERT, UPDATE, DELETE ON "TeacherEmploymentLogs" FROM "authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE INSERT, UPDATE, DELETE ON "TeacherEmploymentLogs" FROM "anon";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE INSERT, UPDATE, DELETE ON "TeacherEmploymentLogs" FROM "service_role";
  END IF;
END
$$;
