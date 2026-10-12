-- En slutad person minns när den slutade.
--
-- Gallring of departed people (20261021110000) counts its period from the
-- day a person was deactivated, and Users had no such day: "isActive" is a
-- boolean, and "updatedAt" moves with every later edit. This migration adds
-- the date and keeps it with a trigger, so no writer can forget it or move
-- it.
--
-- ## The columns
--
--   * Users."deactivatedAt": when "isActive" last went from true to false.
--     NULL while the person is active. Users_deactivation_is_dated holds the
--     two together.
--   * Users."pseudonymisedAt": when gallring replaced the person's name,
--     e-mail and the rest with a pseudonym (20261021110000). NULL for
--     everybody else. Users_a_pseudonym_stays_inactive: a pseudonymised row
--     is never active again. Its name and login are gone, so a returning
--     person is added anew, and UsersService says so (409 instead of the
--     constraint).
--
-- ## The trigger
--
-- app.users_deactivation_is_dated, BEFORE INSERT and BEFORE UPDATE OF
-- isActive, deactivatedAt: an active row gets NULL; a row that is inserted
-- inactive, or goes inactive, gets now(); an inactive row that stays inactive
-- keeps its date whatever the statement says. Every writer goes through it:
-- the admin's edit (UsersService.update), an SS12000 apply that ends a pupil
-- or guardian (apply.ts, as the sync principal), the seed and the RLS
-- fixtures. A release that does not know the column writes isActive alone and
-- gets the date anyway, so this is backward compatible.
--
-- app.users_sync_writes_are_narrow (20261014100000) lets the sync principal
-- change firstName, lastName, studentGroupId, isActive and updatedAt and
-- nothing else, comparing the whole row before and after. "deactivatedAt"
-- joins that list: it follows isActive by the trigger above, and BEFORE
-- triggers fire in name order, so without it a nightly run that ends a pupil
-- would be refused whenever the dating trigger fired first. The function is
-- otherwise unchanged.
--
-- ## Existing inactive rows
--
-- They are dated by their "updatedAt". Every deactivation so far went through
-- Prisma's @updatedAt or the sync's own stamp (apply.ts sets "updatedAt" in
-- the same statement), and a later edit only moves "updatedAt" forward, so
-- the date is never earlier than the real one: a period counted from it never
-- ends early. Measured on the seed: every inactive row gets a date.

ALTER TABLE "Users"
    ADD COLUMN "deactivatedAt"   TIMESTAMPTZ(6),
    ADD COLUMN "pseudonymisedAt" TIMESTAMPTZ(6);

UPDATE "Users" SET "deactivatedAt" = "updatedAt" WHERE NOT "isActive";

ALTER TABLE "Users"
    ADD CONSTRAINT "Users_deactivation_is_dated" CHECK ("isActive" = ("deactivatedAt" IS NULL)),
    ADD CONSTRAINT "Users_a_pseudonym_stays_inactive" CHECK ("pseudonymisedAt" IS NULL OR NOT "isActive");

-- Gallring finds departed people by school and date.
CREATE INDEX "Users_schoolId_deactivatedAt_idx" ON "Users"("schoolId", "deactivatedAt") WHERE "deactivatedAt" IS NOT NULL;

CREATE FUNCTION app.users_deactivation_is_dated() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF NEW."isActive" THEN
    NEW."deactivatedAt" := NULL;
  ELSIF TG_OP = 'INSERT' OR OLD."isActive" THEN
    NEW."deactivatedAt" := now();
  ELSE
    NEW."deactivatedAt" := OLD."deactivatedAt";
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.users_deactivation_is_dated() FROM PUBLIC;

CREATE TRIGGER "Users_deactivation_is_dated_on_insert"
    BEFORE INSERT ON "Users"
    FOR EACH ROW EXECUTE FUNCTION app.users_deactivation_is_dated();

CREATE TRIGGER "Users_deactivation_is_dated_on_update"
    BEFORE UPDATE OF "isActive", "deactivatedAt" ON "Users"
    FOR EACH ROW EXECUTE FUNCTION app.users_deactivation_is_dated();

-- 20261014100000's function, with "deactivatedAt" among the columns the sync
-- may change. Nothing else differs.
CREATE OR REPLACE FUNCTION app.users_sync_writes_are_narrow() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  free text[] := ARRAY['firstName', 'lastName', 'studentGroupId', 'isActive', 'deactivatedAt', 'updatedAt'];
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
