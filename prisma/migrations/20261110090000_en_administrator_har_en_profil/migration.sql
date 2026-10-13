-- Roller i skolan, del 1: en administratör har en profil.
--
-- ## Why
--
-- A school has had one Administratör role, and every administrator could
-- change everything: the timplan, the schedule, its publication, the school
-- day, the roster, the integrations and the decisions about data. A school
-- has a schemaläggare, a rektor and an expedition who do different jobs, and
-- a kommun's procurement asks that each of them can change only their own.
--
-- ## What this migration adds (and what it leaves to the next)
--
-- * "AdminProfile" (FULL, REKTOR, SCHEMALAGGARE, EXPEDITION) as a profile of
--   SCHOOL_ADMIN, in Users."adminProfile". Not new UserRole values: about 39
--   staff arms ask for TEACHER or SCHOOL_ADMIN and stay exactly as they are.
--   Every existing administrator becomes FULL, which writes everything, so
--   nothing changes on deploy.
-- * Users."hrRead", HR-läs: a schemaläggare or an expedition who may read
--   tjänst % and nedsättning. Rektor and full read them anyway.
-- * "AdminArea", the six areas an administrator's writes fall in, and the
--   matrix of which profile writes which: app.admin_profile_writes(). The
--   gateway keeps the same matrix in src/auth/admin-areas.ts; a jest test
--   reads this file's function and the RLS suite's matrix (section 116) runs
--   it against every table, so the two cannot drift apart.
-- * app.current_user_may(area, write): may the caller read (always, for an
--   active administrator) or write the area. app.current_user_decides():
--   is the caller rektor or full, who own the decisions (who is an
--   administrator and with which profile, HR-läs, tjänst %, and dataskydd).
-- * A trigger that lets only a decider create, change or remove an
--   administrator, or change anybody's role, profile or HR-läs; and a log of
--   every such change, UserRoleChanges, written by a trigger.
--
-- The arms themselves are split in 20261110100000. This migration changes no
-- policy, so on its own it changes no administrator's reach: every one is
-- FULL, and a FULL administrator decides.
--
-- ## The matrix
--
--   profile        writes                                          decides
--   FULL           every area                                      yes
--   REKTOR         every area                                      yes
--   SCHEMALAGGARE  planering, schemaläggning, publicering, drift   no
--   EXPEDITION     drift, personal                                 no
--
-- Every profile reads every area. Tjänst % and nedsättning are read by FULL,
-- REKTOR and HR-läs only; the gateway is the one path to another person's
-- (their administrators' arms are the API role's, 20261028090000).
--
-- ## Backward compatibility for one release
--
-- The gateway before this release writes Users without the new columns. A
-- trigger therefore gives an administrator written without a profile FULL,
-- which is what an administrator was, and takes the profile and HR-läs from
-- anybody who stops being one. The two CHECKs hold the same rules for every
-- writer.
--
-- ## Beside the live API: every lock at once, or none
--
-- Production runs this while the API before it serves requests. The ALTER of
-- Users takes its ACCESS EXCLUSIVE lock, and UserRoleChanges' foreign key a
-- SHARE ROW EXCLUSIVE one on Schools. A migration that waited for one of them
-- while it held the other could close a cycle with a request that holds the
-- second and wants the first, and a waiting ACCESS EXCLUSIVE lock queues every
-- request behind it. So both are taken first, NOWAIT and together: a refusal
-- rolls the subtransaction back and with it whatever it got, and it tries
-- again 50 ms later. The migration never waits while it holds a lock, and no
-- request queues behind it. After 30 s of refusals it stops with nothing done
-- and can be rerun. lock_timeout bounds any wait nobody foresaw.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Users" IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Schools" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Users and Schools were not free at once in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Types and columns
-- ---------------------------------------------------------------------------

CREATE TYPE "AdminProfile" AS ENUM ('FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION');
CREATE TYPE "AdminArea" AS ENUM ('PLANERING', 'SCHEMALAGGNING', 'PUBLICERING', 'DRIFT', 'PERSONAL', 'INTEGRATIONER');

ALTER TABLE "Users"
    ADD COLUMN "adminProfile" "AdminProfile",
    ADD COLUMN "hrRead" BOOLEAN NOT NULL DEFAULT false;

UPDATE "Users" SET "adminProfile" = 'FULL' WHERE "role" = 'SCHOOL_ADMIN';

ALTER TABLE "Users"
    ADD CONSTRAINT "Users_a_profile_is_an_administrators"
    CHECK (("role" = 'SCHOOL_ADMIN') = ("adminProfile" IS NOT NULL));
ALTER TABLE "Users"
    ADD CONSTRAINT "Users_hr_read_is_a_narrow_administrators"
    CHECK (NOT "hrRead" OR "adminProfile" IN ('SCHEMALAGGARE', 'EXPEDITION'));

COMMENT ON COLUMN "Users"."adminProfile" IS
  'The administrator''s profile; set exactly on a SCHOOL_ADMIN. Which areas it writes: app.admin_profile_writes().';
COMMENT ON COLUMN "Users"."hrRead" IS
  'HR-läs: a SCHEMALAGGARE or EXPEDITION who may read tjänst % and nedsättning.';

-- The profile follows the role. Named to fire before the decision guard
-- below (BEFORE triggers fire in name order), so the guard judges the row as
-- it will be written.
CREATE FUNCTION app.users_profile_follows_the_role() RETURNS trigger
LANGUAGE plpgsql SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF NEW."role" = 'SCHOOL_ADMIN' THEN
    IF NEW."adminProfile" IS NULL THEN
      NEW."adminProfile" := 'FULL';
    END IF;
    IF NEW."adminProfile" IN ('FULL', 'REKTOR') THEN
      NEW."hrRead" := false;
    END IF;
  ELSE
    NEW."adminProfile" := NULL;
    NEW."hrRead" := false;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Users_a_profile_follows_the_role"
    BEFORE INSERT OR UPDATE OF "role", "adminProfile", "hrRead" ON "Users"
    FOR EACH ROW EXECUTE FUNCTION app.users_profile_follows_the_role();

-- ---------------------------------------------------------------------------
-- The matrix
-- ---------------------------------------------------------------------------

-- Which areas a profile writes. The one place the database states it; the
-- gateway's copy is src/auth/admin-areas.ts (PROFILE_WRITES). Keep the WHEN
-- lines in this shape: the parity test reads them.
CREATE FUNCTION app.admin_profile_writes(p_profile "AdminProfile") RETURNS "AdminArea"[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_profile
    WHEN 'FULL'          THEN ARRAY['PLANERING', 'SCHEMALAGGNING', 'PUBLICERING', 'DRIFT', 'PERSONAL', 'INTEGRATIONER']::"AdminArea"[]
    WHEN 'REKTOR'        THEN ARRAY['PLANERING', 'SCHEMALAGGNING', 'PUBLICERING', 'DRIFT', 'PERSONAL', 'INTEGRATIONER']::"AdminArea"[]
    WHEN 'SCHEMALAGGARE' THEN ARRAY['PLANERING', 'SCHEMALAGGNING', 'PUBLICERING', 'DRIFT']::"AdminArea"[]
    WHEN 'EXPEDITION'    THEN ARRAY['DRIFT', 'PERSONAL']::"AdminArea"[]
    ELSE '{}'::"AdminArea"[]
  END
$$;

-- Whether a profile owns the decisions. The gateway's copy is PROFILE_DECIDES.
CREATE FUNCTION app.admin_profile_decides(p_profile "AdminProfile") RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(p_profile IN ('FULL', 'REKTOR'), false)
$$;

-- May the signed-in, active administrator read (p_write false) or write the
-- area? Reading is every administrator's; NULL for p_write is a write. False
-- for anybody who is not an active SCHOOL_ADMIN, and for a NULL area.
CREATE FUNCTION app.current_user_may(p_area "AdminArea", p_write boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT coalesce(bool_or(
           u."role" = 'SCHOOL_ADMIN'
           AND p_area IS NOT NULL
           AND (NOT coalesce(p_write, true) OR p_area = ANY (app.admin_profile_writes(u."adminProfile")))
         ), false)
    FROM "Users" u
   WHERE u."authId" = (select auth.uid()) AND u."isActive"
$$;

-- Is the signed-in, active administrator one who decides: rektor or full?
CREATE FUNCTION app.current_user_decides() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT coalesce(bool_or(u."role" = 'SCHOOL_ADMIN' AND app.admin_profile_decides(u."adminProfile")), false)
    FROM "Users" u
   WHERE u."authId" = (select auth.uid()) AND u."isActive"
$$;

COMMENT ON FUNCTION app.admin_profile_writes("AdminProfile") IS
  'The areas a profile writes. The gateway''s copy is src/auth/admin-areas.ts; tests hold them equal.';
COMMENT ON FUNCTION app.admin_profile_decides("AdminProfile") IS
  'Whether a profile owns the decisions: who administers with which profile, HR-läs, tjänst %, dataskydd.';
COMMENT ON FUNCTION app.current_user_may("AdminArea", boolean) IS
  'May the signed-in, active SCHOOL_ADMIN read (every one) or write (by profile) the area. False for everybody else.';
COMMENT ON FUNCTION app.current_user_decides() IS
  'Is the signed-in, active SCHOOL_ADMIN rektor or full. False for everybody else.';

-- ---------------------------------------------------------------------------
-- Only a decider makes, changes or removes an administrator, or changes a
-- role, a profile or HR-läs.
--
-- Judged for a signed-in person's own writes only. The owner (a migration,
-- the seed), gallring and the auth hook act with no person; the service
-- principal and the sync have their own rules (users_sync_writes_are_narrow
-- refuses a sync any change of an administrator). Row security already
-- refuses every write by somebody who is not an active administrator, so no
-- person passes this trigger without one.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.users_administrators_are_decided() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  touches boolean;
BEGIN
  IF app.current_user_id() IS NULL
     OR app.current_service_school_id() IS NOT NULL
     OR app.current_sync_school_id() IS NOT NULL THEN
    RETURN coalesce(NEW, OLD);
  END IF;

  IF TG_OP = 'INSERT' THEN
    touches := NEW."role" = 'SCHOOL_ADMIN';
  ELSIF TG_OP = 'DELETE' THEN
    touches := OLD."role" = 'SCHOOL_ADMIN';
  ELSE
    touches := OLD."role" = 'SCHOOL_ADMIN'
            OR NEW."role" IS DISTINCT FROM OLD."role"
            OR NEW."adminProfile" IS DISTINCT FROM OLD."adminProfile"
            OR NEW."hrRead" IS DISTINCT FROM OLD."hrRead";
  END IF;

  IF touches AND NOT app.current_user_decides() THEN
    RAISE EXCEPTION 'ADMINISTRATOR_IS_A_DECISION: bara rektor eller en fullständig administratör ändrar en administratör, en roll eller HR-läs'
      USING ERRCODE = 'AR403',
            DETAIL  = format('operation=%s', TG_OP);
  END IF;
  RETURN coalesce(NEW, OLD);
END
$$;

CREATE TRIGGER "Users_administrators_are_decided"
    BEFORE INSERT OR UPDATE OR DELETE ON "Users"
    FOR EACH ROW EXECUTE FUNCTION app.users_administrators_are_decided();

-- ---------------------------------------------------------------------------
-- The log: UserRoleChanges
-- ---------------------------------------------------------------------------

CREATE TABLE "UserRoleChanges" (
    "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"    UUID NOT NULL,
    "userId"      UUID NOT NULL,
    "fromRole"    "UserRole",
    "toRole"      "UserRole" NOT NULL,
    "fromProfile" "AdminProfile",
    "toProfile"   "AdminProfile",
    "fromHrRead"  BOOLEAN,
    "toHrRead"    BOOLEAN NOT NULL,
    "actorId"     UUID,
    "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "UserRoleChanges_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "UserRoleChanges_schoolId_fkey" FOREIGN KEY ("schoolId")
        REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "UserRoleChanges_userId_schoolId_fkey" FOREIGN KEY ("userId", "schoolId")
        REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "UserRoleChanges_schoolId_userId_createdAt_idx"
    ON "UserRoleChanges" ("schoolId", "userId", "createdAt" DESC);

COMMENT ON TABLE "UserRoleChanges" IS
  'Every change of a person''s role, administrator profile or HR-läs, and every administrator''s creation. Written by Users_role_changes_are_logged alone.';

-- AFTER, so a write the decision guard or a CHECK refuses logs nothing. An
-- administrator created gets a row; anybody else created does not, since a
-- new pupil or teacher changes nobody's reach.
CREATE FUNCTION app.users_role_changes_are_logged() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."role" <> 'SCHOOL_ADMIN' THEN
      RETURN NULL;
    END IF;
    INSERT INTO "UserRoleChanges" ("schoolId", "userId", "fromRole", "toRole", "fromProfile", "toProfile",
                                   "fromHrRead", "toHrRead", "actorId")
    VALUES (NEW."schoolId", NEW."id", NULL, NEW."role", NULL, NEW."adminProfile",
            NULL, NEW."hrRead", app.current_user_id());
    RETURN NULL;
  END IF;

  IF (NEW."role", NEW."adminProfile", NEW."hrRead") IS NOT DISTINCT FROM (OLD."role", OLD."adminProfile", OLD."hrRead") THEN
    RETURN NULL;
  END IF;
  INSERT INTO "UserRoleChanges" ("schoolId", "userId", "fromRole", "toRole", "fromProfile", "toProfile",
                                 "fromHrRead", "toHrRead", "actorId")
  VALUES (NEW."schoolId", NEW."id", OLD."role", NEW."role", OLD."adminProfile", NEW."adminProfile",
          OLD."hrRead", NEW."hrRead", app.current_user_id());
  RETURN NULL;
END
$$;

CREATE TRIGGER "Users_role_changes_are_logged"
    AFTER INSERT OR UPDATE OF "role", "adminProfile", "hrRead" ON "Users"
    FOR EACH ROW EXECUTE FUNCTION app.users_role_changes_are_logged();

-- Read by the school's administrators, every profile, through the gateway;
-- written by nobody but the trigger. No arm writes, and no API role holds
-- more than SELECT.
ALTER TABLE "UserRoleChanges" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_role_changes_admin_select" ON "UserRoleChanges"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

-- ---------------------------------------------------------------------------
-- Grants, guarded: the gateway reads the log, PostgREST's role and anon hold
-- nothing on it, service_role reads (20261016130000). REVOKE ALL first, so
-- MAINTAIN goes too on Postgres 17 (20261016120000). The trigger functions
-- are no API role's to call.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  fn text;
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['app_authenticated', 'authenticated', 'anon', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "UserRoleChanges" FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT SELECT ON "UserRoleChanges" TO "app_authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT ON "UserRoleChanges" TO "service_role";
  END IF;

  FOREACH fn IN ARRAY ARRAY[
    'app.users_profile_follows_the_role()',
    'app.users_administrators_are_decided()',
    'app.users_role_changes_are_logged()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'app_authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', fn, r);
      END IF;
    END LOOP;
  END LOOP;
END
$$;
