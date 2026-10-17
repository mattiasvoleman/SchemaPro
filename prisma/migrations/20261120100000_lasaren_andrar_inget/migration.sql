-- Läsbehörighet, del 2: läsaren läser allt och ändrar inget.
--
-- ## Why
--
-- 20261120090000 added the profile 'LASARE' ("Läsare"). This migration says
-- what it is: an administrator who writes no area and decides nothing, and
-- who, like a schemaläggare or an expedition, may be given HR-läs.
--
-- ## What this migration changes
--
-- * app.admin_profile_writes() states the profile's line: no area. The ELSE
--   already gave an unknown profile none, so no administrator's reach
--   changes; the line is there because the matrix is read from this function
--   (src/auth/admin-areas.spec.ts) and a profile the function does not name
--   is one the test cannot hold the gateway to.
-- * app.admin_profile_decides() is unchanged: rektor and full decide, so a
--   läsare does not, and the läslogg (PersonalDataAccess), which only the
--   deciders read, stays closed to it.
-- * Users_hr_read_is_a_narrow_administrators admits HR-läs on a läsare. HR-läs
--   is its own grant: a läsare reads tjänst % and nedsättning only when a
--   decider has given it, as for a schemaläggare. The trigger that takes
--   HR-läs from rektor and full (app.users_profile_follows_the_role) names
--   them and needs no change.
--
-- What the profile reads needs nothing here: every administrator's read arm
-- admits every profile, and every write arm asks app.current_user_may(area,
-- true) or app.current_user_decides() (20261110100000), which a profile with
-- no area and no decisions never passes. The RLS suite's matrix (section 116)
-- runs the läsare against every table.
--
-- ## Beside the live API: every lock at once, or none
--
-- Replacing the CHECK takes Users' ACCESS EXCLUSIVE lock, and every request
-- reads Users (the RLS helpers). The lock is taken first, NOWAIT: a refusal
-- rolls the subtransaction back and tries again 50 ms later, so the
-- migration never waits while it holds a lock and no request queues behind
-- it. After 30 s of refusals it stops with nothing done and can be rerun.
-- lock_timeout bounds any wait nobody foresaw. The new CHECK admits every row
-- the old one did, so validating it changes nothing; it scans Users once.
--
-- The API before this release keeps working: it writes no 'LASARE', and the
-- function and the CHECK answer every other profile as before.
--
-- ## Deploy order
--
-- Both migrations first, then the API and the web of this release together,
-- and no läsare until both are live. The previous API and web look a
-- profile's areas up by name and fail on one they do not know: a läsare's
-- page would break and its writes would end in a server error, not the
-- named refusal (nothing would be written either way). For the same reason
-- a rollback past this release changes every läsare to another profile
-- first.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Users" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Users was not free in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

-- Which areas a profile writes. Keep the WHEN lines in this shape: the parity
-- test reads them (src/auth/admin-areas.spec.ts).
CREATE OR REPLACE FUNCTION app.admin_profile_writes(p_profile "AdminProfile") RETURNS "AdminArea"[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_profile
    WHEN 'FULL'          THEN ARRAY['PLANERING', 'SCHEMALAGGNING', 'PUBLICERING', 'DRIFT', 'PERSONAL', 'INTEGRATIONER']::"AdminArea"[]
    WHEN 'REKTOR'        THEN ARRAY['PLANERING', 'SCHEMALAGGNING', 'PUBLICERING', 'DRIFT', 'PERSONAL', 'INTEGRATIONER']::"AdminArea"[]
    WHEN 'SCHEMALAGGARE' THEN ARRAY['PLANERING', 'SCHEMALAGGNING', 'PUBLICERING', 'DRIFT']::"AdminArea"[]
    WHEN 'EXPEDITION'    THEN ARRAY['DRIFT', 'PERSONAL']::"AdminArea"[]
    WHEN 'LASARE'        THEN ARRAY[]::"AdminArea"[]
    ELSE '{}'::"AdminArea"[]
  END
$$;

COMMENT ON FUNCTION app.admin_profile_writes("AdminProfile") IS
  'The areas a profile writes; a läsare (LASARE) writes none. The gateway''s copy is src/auth/admin-areas.ts; tests hold them equal.';

ALTER TABLE "Users" DROP CONSTRAINT "Users_hr_read_is_a_narrow_administrators";
ALTER TABLE "Users"
    ADD CONSTRAINT "Users_hr_read_is_a_narrow_administrators"
    CHECK (NOT "hrRead" OR "adminProfile" IN ('SCHEMALAGGARE', 'EXPEDITION', 'LASARE'));

COMMENT ON COLUMN "Users"."hrRead" IS
  'HR-läs: a SCHEMALAGGARE, EXPEDITION or LASARE who may read tjänst % and nedsättning.';
COMMENT ON COLUMN "Users"."adminProfile" IS
  'The administrator''s profile; set exactly on a SCHOOL_ADMIN. Which areas it writes: app.admin_profile_writes(); LASARE writes none.';
