-- En huvudman äger skolor, och huvudmannens personer läser dem utan att anställas där.
--
-- Roadmap: Kommun lane, phase "Huvudman". A huvudman (a kommun, a friskola's
-- owner) owns schools; a kommunadministratör keeps the huvudman's members,
-- schools and SS12000 keys; central planners read across the huvudman's
-- schools. Built on Flera skolor per inloggning (20261204090000), whose
-- resolver this extends, and Läsbehörighet (20261120090000), whose läsare
-- the huvudman's people read as.
--
-- ## The model
--
--   "Huvudmen"                the huvudman: name, organisationsnummer,
--                             kommunkod. Made by the operator, as a school is
--                             (docs/DEPLOYMENT.md §14); no API role writes it.
--   "HuvudmanMembers"         a person of the huvudman by their login
--                             (authId), KOMMUNADMINISTRATOR or PLANERARE. The
--                             kommunadministratör writes the rows through the
--                             gateway; the login only through
--                             app.huvudman_member_takes_login.
--   "HuvudmanSchools"         the huvudman owns the school, one huvudman per
--                             school. Written only by the school's own
--                             decision (app.school_accepts_huvudman) and
--                             ended by either side.
--   "HuvudmanSchoolRequests"  the huvudman asks to own a school; the school's
--                             decider (rektor or full) answers.
--   "HuvudmanSchoolEvents"    append-only: who asked, answered, joined, left
--                             or let go, and when. Both sides read their own.
--   "HuvudmanApiKeys"         the huvudman's SS12000 keys (sh_…), read scopes
--                             only; see "One SS12000 key" below.
--
-- No column is added to "Schools" or "Users": a school without a huvudman
-- has no row anywhere new, and its rows are what they were.
--
-- ## The huvudman reads a school; it is not employed there
--
-- A member gets no "Users" row at the huvudman's schools. A Users row is a
-- person of the school's register, listed by the people page, the SS12000
-- provider, the sync's matching, the notices' recipients and gallring, and a
-- school's administrator may change it; the huvudman's reader is none of
-- that. Instead the resolver answers for a reader when a request names a
-- school the huvudman owns and the login has no own active row there.
--
-- Three of the six helpers every policy asks (app.current_school_id,
-- current_user_role, current_user_may) keep 20261204090000's clause word for
-- word as their first branch, and get a second one, run only when the first
-- found no row and the request names a school:
--
--   * the login's active membership of the huvudman that owns the school
--     named (HuvudmanSchools), the school not closed for the session, for
--     its own rows or for the reader (the hook's two keys, below);
--   * then the school is the one named, the role SCHOOL_ADMIN, and
--     current_user_may(area, write) is true for a read of any area and false
--     for every write: the läsare's answer (admin_profile_writes('LASARE')
--     is empty), written out here rather than asked of the profile, so that
--     no later change to the läsare ever gives the huvudman a write.
--
-- The other three stay byte for byte as 20261204090000 wrote them, and
-- answer the reader as they answer anybody without a row: current_user_id
-- and current_user_group_id NULL, current_user_decides false. So every arm
-- keyed on the caller's own id ("userId" = app.current_user_id()) matches
-- nothing, every function that needs a person refuses (no policy compares
-- the id with <>, IS DISTINCT FROM or IS NULL), and no decision is the
-- reader's. Who the reader is, app.current_huvudman_member_id() says, with
-- the same second branch; only the read log, the switcher's list and the
-- gateway's lookup ask it.
--
-- What does not change:
--
--   * an own row wins: a planner who is also a teacher at a school is the
--     teacher there. The huvudman reads only where the login has no active,
--     open row of its own. A deactivated row does not win: under
--     20261204090000 it gives no principal, and here, at a school the
--     huvudman owns, it gives the huvudman's reader, since the huvudman's
--     access is its own decision, which the school took. The school's
--     deciders see it (app.school_huvudman_readers, own_row INACTIVE);
--   * nothing named never gives the reader: the default is 20261204090000's,
--     the own row that took the login first, or no principal;
--   * a school named that cannot be followed is still no principal: a school
--     the huvudman does not own, one it only asked for or no longer owns, an
--     inactive membership, a closed school, a member of another huvudman;
--   * the choice picks among the login's own rows and memberships only, so a
--     forged header gives nobody more than they have.
--
-- A school has one huvudman and a login one membership per huvudman, so at
-- most one membership answers for a school.
--
-- Three arms asked whether the caller is a Users row at all: the national
-- timplan's (20261006090000), (select app.current_user_id()) IS NOT NULL,
-- "an active principal reads the statute". They now ask the same of the
-- school, (select app.current_school_id()) IS NOT NULL: the same people as
-- before (every active row has a school, a deactivated one none), and the
-- huvudman's reader, who reads the timplan pages as the läsare does. No
-- other arm compares app.current_user_id() with IS NULL, <> or IS DISTINCT
-- FROM (RLS section 262 found these three by comparing the reader with the
-- school's läsare, table by table).
--
-- ## The access-token hook judges the huvudman's schools too
--
-- sign_in.rules gains a branch and a column ("huvudmanReader"): a row for
-- each school a membership reaches, active or not, with the role
-- SCHOOL_ADMIN (staff), loginSince 'infinity' (after every own row) and the
-- school's sign-in rules. The hook judges each such row under its school's
-- rules, as every own row, and names a refusal under the key
-- 'reader:<schoolId>' of rastra_closed_schools, beside the school's own key
-- for the login's own rows. The second branch is closed by either key, the
-- first by the school's alone. So a school that requires a school account of
-- staff is closed to a planner's password session, and stays open to the
-- same login's own guardian row there, which the school does not require it
-- of. The reader is judged even where the login has an active row of its
-- own, and on an inactive membership: a row made inactive, or a membership
-- made active, during the token's life does not open a school that was
-- never judged for the reader. Without the hook's verdict a planner would
-- read with a password a school that requires Entra. A membership whose
-- huvudman owns nothing adds no rule, and the token is issued as before;
-- that session reaches no school's data. A school the huvudman comes to own
-- during the token's life is judged at the next refresh, as a school row
-- that takes the login then is (20261204090000).
--
-- ## One SS12000 key for all of the huvudman's schools
--
-- A huvudman's key reads each school its huvudman owns, and each read is
-- that one school's service principal, exactly as the school's own key's:
-- the gateway opens a school for the key with app.huvudman_key_opens_school,
-- which sets app.service_school_id only when the key is live and its
-- huvudman owns the school, beside app.service_huvudman_key_id. Nothing else
-- of the service principal changes: app.current_service_school_id() is
-- evaluated row by row in 36 arms and is left alone. The key's schools come
-- from app.huvudman_key_schools(), which reads the key from that setting;
-- PostgREST cannot set app.* settings. The four arms where the service
-- principal writes (a sync's Users, GuardianStudents and StudentGroups) are
-- closed to a huvudman's key in 20261212090300, so the key writes nothing
-- in the database either, whatever the gateway lets through.
--
-- A school's own keys, their table, principal, scopes, subscriptions and
-- secrets are untouched. The huvudman's key reads no school's keys, holds no
-- subscription and no v1 scope, and reads no attendance or absence (the
-- CHECK below): sharing those stays each school's decision about its own
-- keys. The school sees the key on Integrationer and its reads in the read
-- log (20261212090100); a school that leaves the huvudman drops out of the
-- key at the next statement.
--
-- ## Ownership takes both sides
--
-- A kommunadministratör asks for a school by its slug
-- (app.huvudman_request_school); the school's decider accepts or declines
-- (app.school_accepts_huvudman, app.school_declines_huvudman: rektor or
-- full, app.current_user_decides(), as the school's other decisions). Either
-- side ends it (app.school_leaves_huvudman, app.huvudman_release_school), and
-- ending only ever takes access away. Each takes the school's lock first
-- (an advisory lock per school, before any row), so two answers to one
-- school queue.
--
-- ## Beside the live API
--
-- The new tables' foreign keys take SHARE ROW EXCLUSIVE on "Schools" and
-- "Users" (writes wait, reads do not), and the three ALTER POLICY ACCESS
-- EXCLUSIVE on the national timplan's tables (written by no API role, read
-- by the timplan pages), NOWAIT and together in a loop: a
-- refusal rolls the subtransaction back with whatever it got and tries again
-- 50 ms later, so the migration never waits while it holds a lock and no
-- request queues behind it; after 30 s it stops with nothing changed (prisma
-- migrate resolve --rolled-back, then deploy). lock_timeout bounds any wait
-- nobody foresaw. Functions are replaced without a table lock.
--
-- The API before this release works on this schema unchanged: no huvudman
-- exists until the operator makes one, so the second branch answers nothing;
-- app.my_schools() has three more columns, and that API names the six it
-- reads; sign_in.rules is the hook's alone, and the hook is replaced with
-- it. Deploy the API and the web of this release together, then make the
-- first huvudman.
--
-- A rollback past this release: delete the "HuvudmanSchools" rows first, so
-- no reader is left that the older code would not know.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Schools" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Users" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "NationalTimplanVersions" IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "NationalSubjects" IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "NationalTimplanEntries" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Schools, Users and the national timplan''s three tables were not free at once in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Types and tables.
-- ---------------------------------------------------------------------------

CREATE TYPE "HuvudmanRole" AS ENUM ('KOMMUNADMINISTRATOR', 'PLANERARE');
CREATE TYPE "HuvudmanSchoolEventKind" AS ENUM ('REQUESTED', 'WITHDRAWN', 'DECLINED', 'JOINED', 'LEFT', 'RELEASED');

CREATE TABLE "Huvudmen" (
    "id"                 UUID NOT NULL DEFAULT gen_random_uuid(),
    "name"               TEXT NOT NULL,
    "organisationNumber" TEXT,
    "municipalityCode"   TEXT,
    "createdAt"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "Huvudmen_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Huvudmen_name_is_a_name" CHECK (char_length("name") BETWEEN 1 AND 300 AND "name" ~ '\S'),
    CONSTRAINT "Huvudmen_organisation_number_is_ten_digits" CHECK ("organisationNumber" ~ '^[0-9]{10}$'),
    CONSTRAINT "Huvudmen_municipality_code_is_four_digits" CHECK ("municipalityCode" ~ '^[0-9]{4}$')
);
CREATE UNIQUE INDEX "Huvudmen_organisationNumber_key" ON "Huvudmen"("organisationNumber");

CREATE TABLE "HuvudmanMembers" (
    "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
    "huvudmanId" UUID NOT NULL,
    "authId"     UUID,
    "email"      TEXT NOT NULL,
    "firstName"  TEXT NOT NULL,
    "lastName"   TEXT NOT NULL,
    "role"       "HuvudmanRole" NOT NULL,
    "isActive"   BOOLEAN NOT NULL DEFAULT true,
    "invitedAt"  TIMESTAMPTZ(6),
    "createdAt"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "HuvudmanMembers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "HuvudmanMembers_email_is_an_address" CHECK (char_length("email") BETWEEN 3 AND 320 AND "email" ~ '^[^@\s]+@[^@\s]+$'),
    CONSTRAINT "HuvudmanMembers_names_are_names" CHECK (
        char_length("firstName") BETWEEN 1 AND 100 AND "firstName" ~ '\S'
        AND char_length("lastName") BETWEEN 1 AND 100 AND "lastName" ~ '\S'
    ),
    -- A login is invited: it has a moment it was handed over.
    CONSTRAINT "HuvudmanMembers_a_login_was_invited" CHECK ("authId" IS NULL OR "invitedAt" IS NOT NULL),
    CONSTRAINT "HuvudmanMembers_huvudmanId_fkey" FOREIGN KEY ("huvudmanId") REFERENCES "Huvudmen"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "HuvudmanMembers_huvudmanId_authId_key" ON "HuvudmanMembers"("huvudmanId", "authId");
CREATE UNIQUE INDEX "HuvudmanMembers_id_huvudmanId_key" ON "HuvudmanMembers"("id", "huvudmanId");
CREATE UNIQUE INDEX "HuvudmanMembers_huvudmanId_email_key" ON "HuvudmanMembers"("huvudmanId", lower("email"));
-- The resolver's lookup: the login's memberships.
CREATE INDEX "HuvudmanMembers_authId_idx" ON "HuvudmanMembers"("authId");

CREATE TABLE "HuvudmanSchools" (
    "schoolId"      UUID NOT NULL,
    "huvudmanId"    UUID NOT NULL,
    "since"         TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "acceptedById"  UUID,
    "requestedById" UUID,

    CONSTRAINT "HuvudmanSchools_pkey" PRIMARY KEY ("schoolId"),
    CONSTRAINT "HuvudmanSchools_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "Schools"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION,
    -- A huvudman that owns schools lets them go before it is deleted.
    CONSTRAINT "HuvudmanSchools_huvudmanId_fkey" FOREIGN KEY ("huvudmanId") REFERENCES "Huvudmen"("id")
        ON DELETE RESTRICT ON UPDATE NO ACTION,
    -- The decider of the school, never moving with them (as the attendance
    -- decision's, 20261114090000).
    CONSTRAINT "HuvudmanSchools_acceptedById_schoolId_fkey" FOREIGN KEY ("acceptedById", "schoolId")
        REFERENCES "Users"("id", "schoolId") ON DELETE SET NULL ("acceptedById") ON UPDATE NO ACTION,
    CONSTRAINT "HuvudmanSchools_requestedById_huvudmanId_fkey" FOREIGN KEY ("requestedById", "huvudmanId")
        REFERENCES "HuvudmanMembers"("id", "huvudmanId") ON DELETE SET NULL ("requestedById") ON UPDATE NO ACTION
);
CREATE INDEX "HuvudmanSchools_huvudmanId_idx" ON "HuvudmanSchools"("huvudmanId");

CREATE TABLE "HuvudmanSchoolRequests" (
    "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
    "huvudmanId"    UUID NOT NULL,
    "schoolId"      UUID NOT NULL,
    "requestedById" UUID,
    "requestedAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "HuvudmanSchoolRequests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "HuvudmanSchoolRequests_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "Schools"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "HuvudmanSchoolRequests_huvudmanId_fkey" FOREIGN KEY ("huvudmanId") REFERENCES "Huvudmen"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "HuvudmanSchoolRequests_requestedById_huvudmanId_fkey" FOREIGN KEY ("requestedById", "huvudmanId")
        REFERENCES "HuvudmanMembers"("id", "huvudmanId") ON DELETE SET NULL ("requestedById") ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "HuvudmanSchoolRequests_schoolId_huvudmanId_key" ON "HuvudmanSchoolRequests"("schoolId", "huvudmanId");
CREATE INDEX "HuvudmanSchoolRequests_huvudmanId_idx" ON "HuvudmanSchoolRequests"("huvudmanId");

CREATE TABLE "HuvudmanSchoolEvents" (
    "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
    "huvudmanId" UUID NOT NULL,
    "schoolId"   UUID NOT NULL,
    "kind"       "HuvudmanSchoolEventKind" NOT NULL,
    "at"         TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "byUserId"   UUID,
    "byMemberId" UUID,

    CONSTRAINT "HuvudmanSchoolEvents_pkey" PRIMARY KEY ("id"),
    -- A person of the school, or a member of the huvudman, never both.
    CONSTRAINT "HuvudmanSchoolEvents_one_side_acts" CHECK ("byUserId" IS NULL OR "byMemberId" IS NULL),
    CONSTRAINT "HuvudmanSchoolEvents_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "Schools"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "HuvudmanSchoolEvents_huvudmanId_fkey" FOREIGN KEY ("huvudmanId") REFERENCES "Huvudmen"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "HuvudmanSchoolEvents_byUserId_schoolId_fkey" FOREIGN KEY ("byUserId", "schoolId")
        REFERENCES "Users"("id", "schoolId") ON DELETE SET NULL ("byUserId") ON UPDATE NO ACTION,
    CONSTRAINT "HuvudmanSchoolEvents_byMemberId_huvudmanId_fkey" FOREIGN KEY ("byMemberId", "huvudmanId")
        REFERENCES "HuvudmanMembers"("id", "huvudmanId") ON DELETE SET NULL ("byMemberId") ON UPDATE NO ACTION
);
CREATE INDEX "HuvudmanSchoolEvents_schoolId_at_idx" ON "HuvudmanSchoolEvents"("schoolId", "at");
CREATE INDEX "HuvudmanSchoolEvents_huvudmanId_at_idx" ON "HuvudmanSchoolEvents"("huvudmanId", "at");

CREATE TABLE "HuvudmanApiKeys" (
    "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
    "huvudmanId"  UUID NOT NULL,
    "name"        TEXT NOT NULL,
    "keyHash"     TEXT NOT NULL,
    "scopes"      TEXT[] NOT NULL,
    "createdById" UUID,
    "lastUsedAt"  TIMESTAMPTZ(6),
    "revokedAt"   TIMESTAMPTZ(6),
    "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "HuvudmanApiKeys_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "HuvudmanApiKeys_name_is_a_name" CHECK (char_length("name") BETWEEN 1 AND 100 AND "name" ~ '\S'),
    CONSTRAINT "HuvudmanApiKeys_hash_is_sha256" CHECK ("keyHash" ~ '^[0-9a-f]{64}$'),
    -- Read scopes of the v2.0 provider, at least one. Not attendances.read
    -- or absences.read (each school decides about its own keys), not
    -- subscriptions.write (a subscription holds a school's secret and
    -- address), not v1's (src/integration/ss12000-v2/scopes.ts:
    -- HUVUDMAN_SCOPES is this list).
    CONSTRAINT "HuvudmanApiKeys_scopes_are_reads" CHECK (
        cardinality("scopes") >= 1
        AND array_position("scopes", NULL) IS NULL
        AND "scopes" <@ ARRAY['organisations.read', 'persons.read', 'responsibles.read', 'groups.read',
                              'duties.read', 'activities.read', 'calendarEvents.read', 'rooms.read',
                              'syllabuses.read']::text[]
    ),
    CONSTRAINT "HuvudmanApiKeys_huvudmanId_fkey" FOREIGN KEY ("huvudmanId") REFERENCES "Huvudmen"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "HuvudmanApiKeys_createdById_huvudmanId_fkey" FOREIGN KEY ("createdById", "huvudmanId")
        REFERENCES "HuvudmanMembers"("id", "huvudmanId") ON DELETE SET NULL ("createdById") ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "HuvudmanApiKeys_keyHash_key" ON "HuvudmanApiKeys"("keyHash");
CREATE INDEX "HuvudmanApiKeys_huvudmanId_idx" ON "HuvudmanApiKeys"("huvudmanId");

COMMENT ON TABLE "Huvudmen" IS
  'Huvudman (20261212090000): a kommun or a friskola''s owner. Made by the operator (docs/DEPLOYMENT.md §14); no API role writes it.';
COMMENT ON TABLE "HuvudmanMembers" IS
  'Huvudman (20261212090000): a person of the huvudman by their login. Both roles read every school the huvudman owns as its läsare, with no Users row there (the second branch of app.current_school_id, current_user_role and current_user_may).';
COMMENT ON TABLE "HuvudmanSchools" IS
  'Huvudman (20261212090000): the huvudman owns the school, by the school''s decider''s yes (app.school_accepts_huvudman); ended by either side.';
COMMENT ON TABLE "HuvudmanSchoolEvents" IS
  'Huvudman (20261212090000): append-only history between a huvudman and a school, written only by the app.huvudman_* and app.school_*_huvudman functions.';
COMMENT ON TABLE "HuvudmanApiKeys" IS
  'Huvudman (20261212090000): the huvudman''s SS12000 keys (sh_…), read scopes only; each read is one owned school''s service principal (app.huvudman_key_opens_school).';

-- ---------------------------------------------------------------------------
-- The national timplan: an active principal at a school reads it. See the
-- preamble. ALTER POLICY keeps the arms' roles.
-- ---------------------------------------------------------------------------

ALTER POLICY "national_timplan_versions_select" ON "NationalTimplanVersions"
    USING ((select app.current_school_id()) IS NOT NULL);
ALTER POLICY "national_subjects_select" ON "NationalSubjects"
    USING ((select app.current_school_id()) IS NOT NULL);
ALTER POLICY "national_timplan_entries_select" ON "NationalTimplanEntries"
    USING ((select app.current_school_id()) IS NOT NULL);

-- ---------------------------------------------------------------------------
-- Who the caller is to a huvudman.
--
-- Arrays, so that an arm asks once per statement (an initplan:
-- "huvudmanId" = ANY ((select app.my_huvudman_ids())::uuid[])). The
-- huvudman's own tables are small, and none of these is asked by any policy
-- of a school's table.
-- ---------------------------------------------------------------------------

-- The huvudmän the login is an active member of.
CREATE FUNCTION app.my_huvudman_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT coalesce(array_agg(m."huvudmanId"), '{}'::uuid[])
    FROM "HuvudmanMembers" m
   WHERE m."authId" = (select auth.uid()) AND m."isActive"
$$;

-- The huvudmän the login keeps: an active kommunadministratör.
CREATE FUNCTION app.my_kommunadmin_huvudman_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT coalesce(array_agg(m."huvudmanId"), '{}'::uuid[])
    FROM "HuvudmanMembers" m
   WHERE m."authId" = (select auth.uid()) AND m."isActive" AND m."role" = 'KOMMUNADMINISTRATOR'
$$;

-- For a school's administrators: the huvudman that owns the school, and any
-- that asks to. So the school reads the name of who owns or asks for it.
CREATE FUNCTION app.school_huvudman_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT coalesce(array_agg(DISTINCT x."huvudmanId"), '{}'::uuid[])
    FROM (SELECT hs."huvudmanId" FROM "HuvudmanSchools" hs WHERE hs."schoolId" = app.current_school_id()
          UNION ALL
          SELECT r."huvudmanId" FROM "HuvudmanSchoolRequests" r WHERE r."schoolId" = app.current_school_id()) x
   WHERE app.current_user_role() = 'SCHOOL_ADMIN'
$$;

COMMENT ON FUNCTION app.my_huvudman_ids() IS
  'Huvudman (20261212090000): the huvudmän the signed-in login is an active member of.';
COMMENT ON FUNCTION app.my_kommunadmin_huvudman_ids() IS
  'Huvudman (20261212090000): the huvudmän the signed-in login is an active kommunadministratör of.';
COMMENT ON FUNCTION app.school_huvudman_ids() IS
  'Huvudman (20261212090000): for an administrator of the chosen school, the huvudman owning it and those asking to; empty for everybody else.';

-- ---------------------------------------------------------------------------
-- The resolver. See the preamble.
--
-- The first branch of each is 20261204090000's clause word for word (RLS
-- section 10 holds it equal to app.current_user_id()'s); the second is the
-- same clause in all four that have it (section 10 again). As SELECT … INTO
-- and FOUND rather than RETURN (SELECT …), so that the first branch finding
-- a row decides, whatever the row's value: the second never runs for a
-- login with a row at the school named, nor for a request that names none.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.current_school_id() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  v uuid;
BEGIN
  SELECT u."schoolId" INTO v
      FROM "Users" u
     WHERE u."authId" = (select auth.uid()) AND u."isActive"
       AND NOT (app.closed_schools() ? u."schoolId"::text)
       AND coalesce(app.requested_school() = u."schoolId"::text, true)
     ORDER BY u."loginSince", u."createdAt", u."id"
     LIMIT 1;
  IF FOUND THEN
    RETURN v;
  END IF;
  -- The huvudman's reader: the school named, when the huvudman owns it.
  SELECT hs."schoolId" INTO v
      FROM "HuvudmanMembers" m
      JOIN "HuvudmanSchools" hs ON hs."huvudmanId" = m."huvudmanId"
     WHERE app.requested_school() IS NOT NULL
       AND m."authId" = (select auth.uid()) AND m."isActive"
       AND hs."schoolId"::text = app.requested_school()
       AND NOT (app.closed_schools() ?| ARRAY[hs."schoolId"::text, 'reader:' || hs."schoolId"::text])
     LIMIT 1;
  RETURN v;
END
$$;

CREATE OR REPLACE FUNCTION app.current_user_role() RETURNS "UserRole"
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  v "UserRole";
BEGIN
  SELECT u."role" INTO v
      FROM "Users" u
     WHERE u."authId" = (select auth.uid()) AND u."isActive"
       AND NOT (app.closed_schools() ? u."schoolId"::text)
       AND coalesce(app.requested_school() = u."schoolId"::text, true)
     ORDER BY u."loginSince", u."createdAt", u."id"
     LIMIT 1;
  IF FOUND THEN
    RETURN v;
  END IF;
  -- The huvudman's reader reads as the school's läsare: an administrator.
  PERFORM 1
      FROM "HuvudmanMembers" m
      JOIN "HuvudmanSchools" hs ON hs."huvudmanId" = m."huvudmanId"
     WHERE app.requested_school() IS NOT NULL
       AND m."authId" = (select auth.uid()) AND m."isActive"
       AND hs."schoolId"::text = app.requested_school()
       AND NOT (app.closed_schools() ?| ARRAY[hs."schoolId"::text, 'reader:' || hs."schoolId"::text])
     LIMIT 1;
  IF FOUND THEN
    RETURN 'SCHOOL_ADMIN';
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION app.current_user_may(p_area "AdminArea", p_write boolean) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  v boolean;
BEGIN
  SELECT u."role" = 'SCHOOL_ADMIN'
         AND p_area IS NOT NULL
         AND (NOT coalesce(p_write, true) OR p_area = ANY (app.admin_profile_writes(u."adminProfile")))
    INTO v
      FROM "Users" u
     WHERE u."authId" = (select auth.uid()) AND u."isActive"
       AND NOT (app.closed_schools() ? u."schoolId"::text)
       AND coalesce(app.requested_school() = u."schoolId"::text, true)
     ORDER BY u."loginSince", u."createdAt", u."id"
     LIMIT 1;
  IF FOUND THEN
    RETURN coalesce(v, false);
  END IF;
  -- The huvudman's reader reads every area and writes none. Written out,
  -- not asked of the läsare's profile: no change to that profile ever gives
  -- the huvudman a write.
  PERFORM 1
      FROM "HuvudmanMembers" m
      JOIN "HuvudmanSchools" hs ON hs."huvudmanId" = m."huvudmanId"
     WHERE app.requested_school() IS NOT NULL
       AND m."authId" = (select auth.uid()) AND m."isActive"
       AND hs."schoolId"::text = app.requested_school()
       AND NOT (app.closed_schools() ?| ARRAY[hs."schoolId"::text, 'reader:' || hs."schoolId"::text])
     LIMIT 1;
  RETURN FOUND AND p_area IS NOT NULL AND NOT coalesce(p_write, true);
END
$$;

-- Who the huvudman's reader is: the membership the second branch finds, or
-- NULL (for a login with a row at the school named, a request naming none,
-- and everybody else).
CREATE FUNCTION app.current_huvudman_member_id() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  v uuid;
BEGIN
  PERFORM 1
      FROM "Users" u
     WHERE u."authId" = (select auth.uid()) AND u."isActive"
       AND NOT (app.closed_schools() ? u."schoolId"::text)
       AND coalesce(app.requested_school() = u."schoolId"::text, true)
     ORDER BY u."loginSince", u."createdAt", u."id"
     LIMIT 1;
  IF FOUND THEN
    RETURN NULL;
  END IF;
  SELECT m."id" INTO v
      FROM "HuvudmanMembers" m
      JOIN "HuvudmanSchools" hs ON hs."huvudmanId" = m."huvudmanId"
     WHERE app.requested_school() IS NOT NULL
       AND m."authId" = (select auth.uid()) AND m."isActive"
       AND hs."schoolId"::text = app.requested_school()
       AND NOT (app.closed_schools() ?| ARRAY[hs."schoolId"::text, 'reader:' || hs."schoolId"::text])
     LIMIT 1;
  RETURN v;
END
$$;

COMMENT ON FUNCTION app.current_school_id() IS
  'Tenant of the signed-in principal: the school of the row app.current_user_id() picks (the same clause), else, for a school named that the login''s huvudman owns and the login has no active row at, that school (Huvudman, 20261212090000); or NULL.';
COMMENT ON FUNCTION app.current_user_role() IS
  'Role of the signed-in principal at the chosen school (the row app.current_user_id() picks), SCHOOL_ADMIN for the huvudman''s reader (20261212090000), or NULL.';
COMMENT ON FUNCTION app.current_user_may("AdminArea", boolean) IS
  'May the signed-in, active SCHOOL_ADMIN read (every one) or write (by profile) the area, at the chosen school only. The huvudman''s reader reads every area and writes none (20261212090000). False for everybody else.';
COMMENT ON FUNCTION app.current_huvudman_member_id() IS
  'Huvudman (20261212090000): the HuvudmanMembers row the huvudman''s reader is, at the school named; NULL for a login with an active row there, a request naming none, and everybody else. Asked by app.personal_data_read, app.my_schools and app.huvudman_reader only.';

-- The gateway's lookup of the reader (JwtStrategy, on the rare path where
-- the login has no row at the school named): who, of which huvudman, at
-- which school. Nothing for anybody else.
CREATE FUNCTION app.huvudman_reader()
RETURNS TABLE (
    member_id     uuid,
    huvudman_id   uuid,
    huvudman_name text,
    member_role   "HuvudmanRole",
    first_name    text,
    last_name     text,
    school_id     uuid
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT m."id", h."id", h."name", m."role", m."firstName", m."lastName", hs."schoolId"
    FROM "HuvudmanMembers" m
    JOIN "Huvudmen" h ON h."id" = m."huvudmanId"
    JOIN "HuvudmanSchools" hs ON hs."huvudmanId" = m."huvudmanId"
   WHERE m."id" = app.current_huvudman_member_id()
     AND hs."schoolId" = app.current_school_id()
$$;

COMMENT ON FUNCTION app.huvudman_reader() IS
  'Huvudman (20261212090000): the huvudman''s reader this request is, at the school named, with the huvudman and the member''s name; no row for anybody else. For the gateway''s JwtStrategy.';

-- ---------------------------------------------------------------------------
-- The switcher's list: the login's own rows, as 20261204090000 listed them,
-- then each school its huvudman owns where it has no active row of its own,
-- as the läsare it reads there. DROP and CREATE: three columns more. The API
-- before this release names the six it reads.
-- ---------------------------------------------------------------------------

DROP FUNCTION app.my_schools();

CREATE FUNCTION app.my_schools()
RETURNS TABLE (
    user_id            uuid,
    school_id          uuid,
    school_name        text,
    role               "UserRole",
    admin_profile      "AdminProfile",
    closed_reason      text,
    is_current         boolean,
    huvudman_member_id uuid,
    huvudman_name      text,
    huvudman_role      "HuvudmanRole"
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT x.user_id, x.school_id, x.school_name, x.role, x.admin_profile, x.closed_reason, x.is_current,
         x.huvudman_member_id, x.huvudman_name, x.huvudman_role
    FROM (
      SELECT u."id" AS user_id, u."schoolId" AS school_id, s."name" AS school_name, u."role" AS role,
             u."adminProfile" AS admin_profile,
             app.closed_schools() ->> u."schoolId"::text AS closed_reason,
             u."id" IS NOT DISTINCT FROM app.current_user_id() AS is_current,
             NULL::uuid AS huvudman_member_id, NULL::text AS huvudman_name, NULL::"HuvudmanRole" AS huvudman_role,
             0 AS part, u."loginSince" AS since, u."createdAt" AS made, ''::text AS by_name, u."id" AS tie
        FROM "Users" u
        JOIN "Schools" s ON s."id" = u."schoolId"
       WHERE u."authId" = (select auth.uid()) AND u."isActive"
      UNION ALL
      SELECT NULL::uuid, hs."schoolId", s."name", 'SCHOOL_ADMIN'::"UserRole", 'LASARE'::"AdminProfile",
             coalesce(app.closed_schools() ->> ('reader:' || hs."schoolId"::text), app.closed_schools() ->> hs."schoolId"::text),
             m."id" IS NOT DISTINCT FROM app.current_huvudman_member_id()
               AND hs."schoolId" IS NOT DISTINCT FROM app.current_school_id(),
             m."id", h."name", m."role",
             1, NULL::timestamptz, NULL::timestamptz, s."name", hs."schoolId"
        FROM "HuvudmanMembers" m
        JOIN "Huvudmen" h ON h."id" = m."huvudmanId"
        JOIN "HuvudmanSchools" hs ON hs."huvudmanId" = m."huvudmanId"
        JOIN "Schools" s ON s."id" = hs."schoolId"
       WHERE m."authId" = (select auth.uid()) AND m."isActive"
         AND NOT EXISTS (SELECT 1 FROM "Users" o
                          WHERE o."authId" = m."authId" AND o."schoolId" = hs."schoolId" AND o."isActive")
    ) x
   ORDER BY x.part, x.since, x.made, x.by_name, x.tie
$$;

COMMENT ON FUNCTION app.my_schools() IS
  'Flera skolor (20261204090000): the signed-in login''s own active rows, first by loginSince, with the school''s name, why the session may not enter it (NULL when it may) and whether it is the row this request is; then (Huvudman, 20261212090000) each school its huvudman owns where it has no active row, as the läsare it reads there, with the membership, the huvudman and its role. For the gateway''s GET /api/v1/me/schools.';

-- ---------------------------------------------------------------------------
-- The access-token hook's rows: 20261204090000's, then one for each school a
-- membership reaches, marked "huvudmanReader", which the hook names under
-- the key 'reader:<schoolId>' when it refuses it. 'infinity': after every
-- own row, so the first refusal the hook names is still the first own
-- row's. DROP and CREATE for the column; the hook is replaced below.
-- ---------------------------------------------------------------------------

DROP FUNCTION sign_in.rules(uuid);

CREATE FUNCTION sign_in.rules(p_auth_id uuid)
RETURNS TABLE (
    "schoolId"             uuid,
    "isActive"             boolean,
    "loginSince"           timestamptz,
    "createdAt"            timestamptz,
    "userId"               uuid,
    "role"                 "UserRole",
    "provider"             "SignInProvider",
    "entraTenantId"        uuid,
    "googleHostedDomain"   text,
    "ssoOnlyForStaff"      boolean,
    "huvudmanReader"       boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
BEGIN ATOMIC
  SELECT r."schoolId", r."isActive", r."loginSince", r."createdAt", r."userId",
         r."role", r."provider", r."entraTenantId", r."googleHostedDomain", r."ssoOnlyForStaff",
         r."huvudmanReader"
    FROM (
      SELECT u."schoolId", u."isActive", u."loginSince", u."createdAt", u."id" AS "userId",
             u."role", m."provider", m."entraTenantId", m."googleHostedDomain", m."ssoOnlyForStaff",
             false AS "huvudmanReader"
        FROM public."Users" u
        LEFT JOIN public."SchoolSignInMethods" m ON m."schoolId" = u."schoolId"
       WHERE u."authId" = p_auth_id
      UNION ALL
      SELECT hs."schoolId", hm."isActive", 'infinity'::timestamptz, hm."createdAt", hm."id",
             'SCHOOL_ADMIN'::public."UserRole", sm."provider", sm."entraTenantId", sm."googleHostedDomain", sm."ssoOnlyForStaff",
             true
        FROM public."HuvudmanMembers" hm
        JOIN public."HuvudmanSchools" hs ON hs."huvudmanId" = hm."huvudmanId"
        LEFT JOIN public."SchoolSignInMethods" sm ON sm."schoolId" = hs."schoolId"
       WHERE hm."authId" = p_auth_id
    ) r
   ORDER BY r."loginSince", r."createdAt", r."userId";
END;

COMMENT ON FUNCTION sign_in.rules(uuid) IS
  'Logga in med skolkonto (20261020090000), per school since 20261204090000: each row of the person with this Auth id, first by loginSince, with its role and its school''s sign-in row; then (Huvudman, 20261212090000) each school a membership reaches, active or not, as staff, last, marked huvudmanReader. No row when there is no such person. For the access-token hook only.';

-- The hook: 20261204090000's, word for word, except that a refusal of the
-- huvudman's reader is named under 'reader:<schoolId>' (see the preamble).
CREATE OR REPLACE FUNCTION sign_in.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE
  auth_id uuid := (event->>'user_id')::uuid;
  methods text[];
  rules record;
  any_active boolean;
  identities jsonb := '[]'::jsonb;
  school_account_age interval;
  verdict text;
  first_refusal text;
  open_schools int := 0;
  closed jsonb := '{}'::jsonb;
BEGIN
  -- The session's methods, from the claims Auth is about to sign (objects
  -- {method, timestamp}; plain strings are accepted too), plus the method of
  -- this issuance.
  methods := ARRAY(
    SELECT coalesce(a->>'method', a #>> '{}')
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(event->'claims'->'amr') = 'array' THEN event->'claims'->'amr' ELSE '[]'::jsonb END) a
  ) || (event->>'authentication_method');

  SELECT bool_or(r."isActive") INTO any_active FROM sign_in.rules(auth_id) r;
  IF any_active IS NULL THEN
    RETURN jsonb_build_object('claims', event->'claims');
  END IF;

  -- Only a school-account session needs the identities, and how long ago it
  -- signed in at the provider: the newest oauth entry's timestamp (epoch
  -- seconds), NULL when there is none. Both are the session's, whichever
  -- school judges them.
  IF 'oauth' = ANY (methods) THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('provider', i.provider, 'identity_data', i.identity_data)), '[]'::jsonb)
      INTO identities
      FROM auth.identities i
     WHERE i.user_id = auth_id;
    SELECT now() - to_timestamp(max((a->>'timestamp')::double precision))
      INTO school_account_age
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(event->'claims'->'amr') = 'array' THEN event->'claims'->'amr' ELSE '[]'::jsonb END) a
     WHERE jsonb_typeof(a) = 'object' AND a->>'method' = 'oauth'
       AND jsonb_typeof(a->'timestamp') = 'number';
  END IF;

  -- Each row under its own school's rules. Every row that its school refuses
  -- is closed, an inactive one too, so that a row made active again during
  -- the token's life is not open by being skipped. Whether the token is
  -- issued at all is judged on the active rows, or on every row of a person
  -- who has no active one (as the one row was judged before).
  FOR rules IN SELECT * FROM sign_in.rules(auth_id) r ORDER BY r."loginSince", r."createdAt", r."userId" LOOP
    verdict := sign_in.verdict(rules."role", rules."provider", rules."entraTenantId",
                               rules."googleHostedDomain", rules."ssoOnlyForStaff", methods, identities,
                               school_account_age);
    IF verdict IS NOT NULL THEN
      -- Huvudman (20261212090000): the huvudman's reader's verdict under a
      -- key of its own, so that it closes the school to the reader and not
      -- to the login's own row there.
      closed := closed || jsonb_build_object(
        CASE WHEN rules."huvudmanReader" THEN 'reader:' || rules."schoolId"::text ELSE rules."schoolId"::text END,
        verdict);
    END IF;
    CONTINUE WHEN any_active AND NOT rules."isActive";
    IF verdict IS NULL THEN
      open_schools := open_schools + 1;
    ELSE
      first_refusal := coalesce(first_refusal, verdict);
    END IF;
  END LOOP;

  IF open_schools = 0 THEN
    RETURN jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', first_refusal));
  END IF;
  IF closed = '{}'::jsonb THEN
    RETURN jsonb_build_object('claims', (event->'claims') - 'rastra_closed_schools');
  END IF;
  RETURN jsonb_build_object('claims',
    ((event->'claims') - 'rastra_closed_schools') || jsonb_build_object('rastra_closed_schools', closed));
END
$$;

COMMENT ON FUNCTION sign_in.custom_access_token_hook(jsonb) IS
  'Logga in med skolkonto (20261020090000), per school since 20261204090000: Supabase Auth''s custom access token hook. Judges each of the person''s rows under its school''s rules. A 403 (sign_in_method_not_allowed, sso_not_enabled, sso_identity_not_allowed, sso_required or sso_reauth_required, the first active row''s) when no active school lets the session in; else the claims, with rastra_closed_schools {schoolId: reason} naming every school, active row or not, that does not, and (Huvudman, 20261212090000) {reader:schoolId: reason} every school of a membership that does not let the huvudman''s reader in.';

-- ---------------------------------------------------------------------------
-- A member's login, set only here: after the gateway's invitation of the
-- member's address (SupabaseAdminService.inviteUser), by a kommunadministratör
-- of the member's huvudman.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.huvudman_member_takes_login(p_member uuid, p_auth_id uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF p_auth_id IS NULL THEN
    RAISE EXCEPTION 'HUVUDMAN_MEMBER_LOGIN_MISSING' USING ERRCODE = 'HM400';
  END IF;
  UPDATE "HuvudmanMembers" m
     SET "authId" = p_auth_id, "invitedAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
   WHERE m."id" = p_member
     AND m."huvudmanId" = ANY (app.my_kommunadmin_huvudman_ids());
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HUVUDMAN_NOT_YOURS' USING ERRCODE = 'HM403';
  END IF;
END
$$;

COMMENT ON FUNCTION app.huvudman_member_takes_login(uuid, uuid) IS
  'Huvudman (20261212090000): hands a member the login the gateway''s invitation gave their address, for a kommunadministratör of the member''s huvudman; HM403 for anybody else. The only writer of HuvudmanMembers.authId and invitedAt.';

-- ---------------------------------------------------------------------------
-- A member's login is held: neither a school nor gallring deletes it.
--
-- The invitation finds the login an address already has, so a teacher's
-- login can also be a member's. As 20261204090000 wrote the two, except that
-- a membership (active or not: it can be made active again) holds the login
-- as another school's row does. Without this a school that removes its row,
-- or gallring that pseudonymises it, deletes the login the planner signs in
-- with, and the huvudman has no way to give it back.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.login_is_held_elsewhere(p_auth_id uuid, p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT EXISTS (SELECT 1 FROM "Users" WHERE "authId" = p_auth_id AND "id" IS DISTINCT FROM p_user)
      OR EXISTS (SELECT 1 FROM "HuvudmanMembers" WHERE "authId" = p_auth_id)
$$;

COMMENT ON FUNCTION app.login_is_held_elsewhere(uuid, uuid) IS
  'Flera skolor (20261204090000): whether a Users row other than p_user, or (Huvudman, 20261212090000) a huvudman''s membership, holds the login p_auth_id. A shared login is the person''s: no one school deletes or moves it.';

CREATE OR REPLACE FUNCTION app.gallring_claim_person(p_run uuid, p_user uuid)
RETURNS TABLE (auth_id uuid, invited boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  r "GallringRuns";
  cutoff date;
  today date;
BEGIN
  SELECT * INTO r FROM "GallringRuns" WHERE "id" = p_run AND "status" = 'RUNNING' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GALLRING_RUN_NOT_RUNNING' USING ERRCODE = 'GL404';
  END IF;
  -- The lock comes first: a reactivation in flight is waited for, one that
  -- comes later waits for this transaction, and every statement below reads
  -- after the wait (read committed: a new snapshot per statement).
  PERFORM 1 FROM "Users" u WHERE u."id" = p_user AND u."schoolId" = r."schoolId" FOR NO KEY UPDATE;
  IF NOT FOUND
     OR r."cutoffs" ->> 'DEPARTED_PEOPLE' IS NULL
     OR app.retention_months_in_force(r."schoolId", 'DEPARTED_PEOPLE', clock_timestamp()) IS NULL THEN
    RETURN;
  END IF;
  -- In variables, as in the run's other functions, so app.gallring_due is
  -- inlined and looks the one person up by id.
  cutoff := app.gallring_run_cutoff(r."schoolId", r."startedAt", r."cutoffs", 'DEPARTED_PEOPLE');
  today := app.gallring_today(r."schoolId", r."startedAt");
  RETURN QUERY
  SELECT u."authId",
         u."invitedAt" IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM "Users" o WHERE o."authId" = u."authId" AND o."id" <> u."id")
         AND NOT EXISTS (SELECT 1 FROM "HuvudmanMembers" hm WHERE hm."authId" = u."authId")
    FROM app.gallring_due(r."schoolId", 'DEPARTED_PEOPLE', cutoff, today) d
    JOIN "Users" u ON u."id" = d."id"
   WHERE d."id" = p_user;
END
$$;

COMMENT ON FUNCTION app.gallring_claim_person(uuid, uuid) IS
  'For the nightly job, right before a departed person''s login is deleted: locks their Users row and answers their authId and whether they have a login of their own to delete (invited, and held by no other row: a login another school''s row holds stays, 20261204090000, and so does one a huvudman''s membership holds, 20261212090000), only while they are still due under the period in force now; no row otherwise.';

-- ---------------------------------------------------------------------------
-- Ownership. See the preamble. Each takes the school's lock before it reads
-- anything, so that two answers to one school queue rather than both pass.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.huvudman_school_lock(p_school uuid) RETURNS void
LANGUAGE sql VOLATILE SET search_path = "public", "pg_temp" AS $$
  SELECT pg_advisory_xact_lock(hashtext('HuvudmanSchools'), hashtext(p_school::text))
$$;

-- The kommunadministratör's member id at p_huvudman, or HM403.
CREATE FUNCTION app.huvudman_kommunadmin(p_huvudman uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  v uuid;
BEGIN
  SELECT m."id" INTO v
    FROM "HuvudmanMembers" m
   WHERE m."huvudmanId" = p_huvudman AND m."authId" = (select auth.uid())
     AND m."isActive" AND m."role" = 'KOMMUNADMINISTRATOR';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HUVUDMAN_NOT_YOURS' USING ERRCODE = 'HM403';
  END IF;
  RETURN v;
END
$$;

-- The school's decider (rektor or full) of the chosen school, or HM403.
CREATE FUNCTION app.school_decider() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  v uuid := app.current_user_id();
BEGIN
  IF v IS NULL OR app.current_school_id() IS NULL OR NOT app.current_user_decides() THEN
    RAISE EXCEPTION 'HUVUDMAN_DECISION_NOT_YOURS' USING ERRCODE = 'HM403';
  END IF;
  RETURN v;
END
$$;

CREATE FUNCTION app.huvudman_request_school(p_huvudman uuid, p_slug text)
RETURNS TABLE (school_id uuid, school_name text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  v_member uuid := app.huvudman_kommunadmin(p_huvudman);
  v_school uuid;
  v_name   text;
  v_owner  uuid;
BEGIN
  SELECT s."id", s."name" INTO v_school, v_name FROM "Schools" s WHERE s."slug" = btrim(coalesce(p_slug, ''));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HUVUDMAN_SCHOOL_NOT_FOUND' USING ERRCODE = 'HM404';
  END IF;
  PERFORM app.huvudman_school_lock(v_school);
  SELECT hs."huvudmanId" INTO v_owner FROM "HuvudmanSchools" hs WHERE hs."schoolId" = v_school;
  IF FOUND THEN
    IF v_owner = p_huvudman THEN
      RAISE EXCEPTION 'HUVUDMAN_SCHOOL_IS_OURS' USING ERRCODE = 'HM409';
    END IF;
    RAISE EXCEPTION 'HUVUDMAN_SCHOOL_HAS_A_HUVUDMAN' USING ERRCODE = 'HM409';
  END IF;
  INSERT INTO "HuvudmanSchoolRequests" ("huvudmanId", "schoolId", "requestedById")
  VALUES (p_huvudman, v_school, v_member)
  ON CONFLICT ("schoolId", "huvudmanId") DO NOTHING;
  IF FOUND THEN
    INSERT INTO "HuvudmanSchoolEvents" ("huvudmanId", "schoolId", "kind", "byMemberId")
    VALUES (p_huvudman, v_school, 'REQUESTED', v_member);
  END IF;
  RETURN QUERY SELECT v_school, v_name;
END
$$;

CREATE FUNCTION app.huvudman_withdraw_request(p_huvudman uuid, p_school uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  v_member uuid := app.huvudman_kommunadmin(p_huvudman);
BEGIN
  PERFORM app.huvudman_school_lock(p_school);
  DELETE FROM "HuvudmanSchoolRequests" r WHERE r."huvudmanId" = p_huvudman AND r."schoolId" = p_school;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HUVUDMAN_REQUEST_NOT_FOUND' USING ERRCODE = 'HM404';
  END IF;
  INSERT INTO "HuvudmanSchoolEvents" ("huvudmanId", "schoolId", "kind", "byMemberId")
  VALUES (p_huvudman, p_school, 'WITHDRAWN', v_member);
END
$$;

CREATE FUNCTION app.huvudman_release_school(p_huvudman uuid, p_school uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  v_member uuid := app.huvudman_kommunadmin(p_huvudman);
BEGIN
  PERFORM app.huvudman_school_lock(p_school);
  DELETE FROM "HuvudmanSchools" hs WHERE hs."huvudmanId" = p_huvudman AND hs."schoolId" = p_school;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HUVUDMAN_SCHOOL_NOT_OURS' USING ERRCODE = 'HM404';
  END IF;
  INSERT INTO "HuvudmanSchoolEvents" ("huvudmanId", "schoolId", "kind", "byMemberId")
  VALUES (p_huvudman, p_school, 'RELEASED', v_member);
END
$$;

CREATE FUNCTION app.school_accepts_huvudman(p_huvudman uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  v_user   uuid := app.school_decider();
  v_school uuid := app.current_school_id();
  v_asked  "HuvudmanSchoolRequests";
  other    record;
BEGIN
  PERFORM app.huvudman_school_lock(v_school);
  SELECT * INTO v_asked FROM "HuvudmanSchoolRequests" r WHERE r."schoolId" = v_school AND r."huvudmanId" = p_huvudman;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HUVUDMAN_REQUEST_NOT_FOUND' USING ERRCODE = 'HM404';
  END IF;
  IF EXISTS (SELECT 1 FROM "HuvudmanSchools" hs WHERE hs."schoolId" = v_school) THEN
    RAISE EXCEPTION 'HUVUDMAN_SCHOOL_HAS_A_HUVUDMAN' USING ERRCODE = 'HM409';
  END IF;
  INSERT INTO "HuvudmanSchools" ("schoolId", "huvudmanId", "acceptedById", "requestedById")
  VALUES (v_school, p_huvudman, v_user, v_asked."requestedById");
  INSERT INTO "HuvudmanSchoolEvents" ("huvudmanId", "schoolId", "kind", "byUserId")
  VALUES (p_huvudman, v_school, 'JOINED', v_user);
  -- A school has one huvudman: every other question is answered no.
  FOR other IN DELETE FROM "HuvudmanSchoolRequests" r WHERE r."schoolId" = v_school RETURNING r."huvudmanId" LOOP
    IF other."huvudmanId" <> p_huvudman THEN
      INSERT INTO "HuvudmanSchoolEvents" ("huvudmanId", "schoolId", "kind", "byUserId")
      VALUES (other."huvudmanId", v_school, 'DECLINED', v_user);
    END IF;
  END LOOP;
END
$$;

CREATE FUNCTION app.school_declines_huvudman(p_huvudman uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  v_user   uuid := app.school_decider();
  v_school uuid := app.current_school_id();
BEGIN
  PERFORM app.huvudman_school_lock(v_school);
  DELETE FROM "HuvudmanSchoolRequests" r WHERE r."schoolId" = v_school AND r."huvudmanId" = p_huvudman;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HUVUDMAN_REQUEST_NOT_FOUND' USING ERRCODE = 'HM404';
  END IF;
  INSERT INTO "HuvudmanSchoolEvents" ("huvudmanId", "schoolId", "kind", "byUserId")
  VALUES (p_huvudman, v_school, 'DECLINED', v_user);
END
$$;

CREATE FUNCTION app.school_leaves_huvudman() RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  v_user   uuid := app.school_decider();
  v_school uuid := app.current_school_id();
  v_owner  uuid;
BEGIN
  PERFORM app.huvudman_school_lock(v_school);
  DELETE FROM "HuvudmanSchools" hs WHERE hs."schoolId" = v_school RETURNING hs."huvudmanId" INTO v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HUVUDMAN_SCHOOL_HAS_NONE' USING ERRCODE = 'HM404';
  END IF;
  INSERT INTO "HuvudmanSchoolEvents" ("huvudmanId", "schoolId", "kind", "byUserId")
  VALUES (v_owner, v_school, 'LEFT', v_user);
END
$$;

COMMENT ON FUNCTION app.huvudman_request_school(uuid, text) IS
  'Huvudman (20261212090000): a kommunadministratör of p_huvudman asks to own the school with the slug; answers the school''s id and name. HM403 (not theirs), HM404 (no such school), HM409 (the school has a huvudman).';
COMMENT ON FUNCTION app.school_accepts_huvudman(uuid) IS
  'Huvudman (20261212090000): the chosen school''s decider (rektor or full) says yes to p_huvudman''s question: the huvudman owns the school, and every other question is answered no.';
COMMENT ON FUNCTION app.school_declines_huvudman(uuid) IS
  'Huvudman (20261212090000): the chosen school''s decider says no to p_huvudman''s question.';
COMMENT ON FUNCTION app.school_leaves_huvudman() IS
  'Huvudman (20261212090000): the chosen school''s decider ends its huvudman''s ownership.';
COMMENT ON FUNCTION app.huvudman_withdraw_request(uuid, uuid) IS
  'Huvudman (20261212090000): a kommunadministratör of p_huvudman takes its question to p_school back.';
COMMENT ON FUNCTION app.huvudman_release_school(uuid, uuid) IS
  'Huvudman (20261212090000): a kommunadministratör of p_huvudman lets p_school go.';

-- ---------------------------------------------------------------------------
-- What a school's administrators read about their huvudman, beyond its
-- name: who of it reads the school (name and role, never the address or the
-- login), and its keys (name, scopes, when made and last used, whether
-- revoked; never the hash). For every administrator of the school, the
-- huvudman's readers included.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.school_huvudman_readers()
RETURNS TABLE (member_id uuid, first_name text, last_name text, role "HuvudmanRole", is_active boolean, own_row text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  -- own_row: whether the member's login has a row of its own at the school,
  -- ACTIVE (then the person there, never the huvudman's reader) or INACTIVE
  -- (then the huvudman's reader: a deactivated row of the school's gives way
  -- to the huvudman's access, which the school's own decision gave).
  SELECT m."id", m."firstName", m."lastName", m."role", m."isActive",
         (SELECT CASE WHEN bool_or(u."isActive") THEN 'ACTIVE' WHEN count(*) > 0 THEN 'INACTIVE' END
            FROM "Users" u WHERE u."authId" = m."authId" AND u."schoolId" = hs."schoolId")
    FROM "HuvudmanSchools" hs
    JOIN "HuvudmanMembers" m ON m."huvudmanId" = hs."huvudmanId"
   WHERE hs."schoolId" = app.current_school_id()
     AND app.current_user_decides()
   ORDER BY m."lastName", m."firstName", m."id"
$$;

CREATE FUNCTION app.school_huvudman_keys()
RETURNS TABLE (key_id uuid, name text, scopes text[], created_at timestamptz, last_used_at timestamptz, revoked_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT k."id", k."name", k."scopes", k."createdAt", k."lastUsedAt", k."revokedAt"
    FROM "HuvudmanSchools" hs
    JOIN "HuvudmanApiKeys" k ON k."huvudmanId" = hs."huvudmanId"
   WHERE hs."schoolId" = app.current_school_id()
     AND app.current_user_decides()
   ORDER BY k."createdAt", k."id"
$$;

COMMENT ON FUNCTION app.school_huvudman_readers() IS
  'Huvudman (20261212090000): for a decider of the chosen school (rektor or full, as the gateway''s Dataskydd), the members of the huvudman that owns it, who read it: name, role, active, and whether the login has a row of its own at the school (ACTIVE: the person there; INACTIVE: the huvudman''s reader, the row deactivated). Nothing for the huvudman''s own reader, who decides nothing.';
COMMENT ON FUNCTION app.school_huvudman_keys() IS
  'Huvudman (20261212090000): for a decider of the chosen school, the SS12000 keys of the huvudman that owns it: name, scopes, made, last used, revoked. Nothing for the huvudman''s reader: of the huvudman''s own people only the kommunadministratör reads its keys.';

-- The huvudman's side: the schools it owns or asks for, with their names
-- and slugs (a member reads no school's own rows), and its history with the
-- schools' names, for its members. A school's people are named by neither:
-- an act of the school is the school's.
CREATE FUNCTION app.huvudman_schools(p_huvudman uuid)
RETURNS TABLE (school_id uuid, school_name text, slug text, state text, since timestamptz, requested_by uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT x.school_id, x.school_name, x.slug, x.state, x.since, x.requested_by
    FROM (
      SELECT s."id" AS school_id, s."name" AS school_name, s."slug" AS slug, 'OWNED'::text AS state,
             hs."since" AS since, hs."requestedById" AS requested_by
        FROM "HuvudmanSchools" hs JOIN "Schools" s ON s."id" = hs."schoolId"
       WHERE hs."huvudmanId" = p_huvudman
      UNION ALL
      SELECT s."id", s."name", s."slug", 'REQUESTED', r."requestedAt", r."requestedById"
        FROM "HuvudmanSchoolRequests" r JOIN "Schools" s ON s."id" = r."schoolId"
       WHERE r."huvudmanId" = p_huvudman
    ) x
   WHERE p_huvudman = ANY (app.my_huvudman_ids())
   ORDER BY x.state, x.school_name, x.school_id
$$;

CREATE FUNCTION app.huvudman_history(p_huvudman uuid, p_limit integer)
RETURNS TABLE (at timestamptz, kind "HuvudmanSchoolEventKind", school_id uuid, school_name text, by_member uuid, by_school boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT e."at", e."kind", e."schoolId", s."name", e."byMemberId", e."byUserId" IS NOT NULL
    FROM "HuvudmanSchoolEvents" e JOIN "Schools" s ON s."id" = e."schoolId"
   WHERE e."huvudmanId" = p_huvudman AND p_huvudman = ANY (app.my_huvudman_ids())
   ORDER BY e."at" DESC, e."id" DESC
   LIMIT least(greatest(coalesce(p_limit, 100), 1), 500)
$$;

-- The school's side: its history with every huvudman it has had or been
-- asked by, with their names (a huvudman it has left is no longer readable
-- through Huvudmen), for the school's administrators.
CREATE FUNCTION app.school_huvudman_history(p_limit integer)
RETURNS TABLE (at timestamptz, kind "HuvudmanSchoolEventKind", huvudman_id uuid, huvudman_name text, by_user uuid, by_huvudman boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT e."at", e."kind", e."huvudmanId", h."name", e."byUserId", e."byMemberId" IS NOT NULL
    FROM "HuvudmanSchoolEvents" e JOIN "Huvudmen" h ON h."id" = e."huvudmanId"
   WHERE e."schoolId" = app.current_school_id() AND app.current_user_decides()
   ORDER BY e."at" DESC, e."id" DESC
   LIMIT least(greatest(coalesce(p_limit, 100), 1), 500)
$$;

COMMENT ON FUNCTION app.huvudman_schools(uuid) IS
  'Huvudman (20261212090000): for a member of p_huvudman, the schools it owns (OWNED, since when) and asks for (REQUESTED), with name and slug.';
COMMENT ON FUNCTION app.huvudman_history(uuid, integer) IS
  'Huvudman (20261212090000): for a member of p_huvudman, its history with the schools, newest first, at most p_limit (1–500) rows; the member who acted, or that the school did.';
COMMENT ON FUNCTION app.school_huvudman_history(integer) IS
  'Huvudman (20261212090000): for a decider of the chosen school, its history with every huvudman, newest first, with the huvudman''s name; the school''s person who acted, or that the huvudman did.';

-- For the next phase (Delade lokaler och lärare): whether two schools have
-- the same huvudman. No API role may call it; the narrow cross-school reads
-- that phase adds, as SECURITY DEFINER functions of their own, may.
CREATE FUNCTION app.same_huvudman(p_a uuid, p_b uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT EXISTS (SELECT 1 FROM "HuvudmanSchools" a JOIN "HuvudmanSchools" b ON b."huvudmanId" = a."huvudmanId"
                  WHERE a."schoolId" = p_a AND b."schoolId" = p_b)
$$;

COMMENT ON FUNCTION app.same_huvudman(uuid, uuid) IS
  'Huvudman (20261212090000): whether one huvudman owns both schools. For the SECURITY DEFINER functions of Delade lokaler och lärare; no API role may call it.';

-- ---------------------------------------------------------------------------
-- The huvudman's SS12000 key. See the preamble.
-- ---------------------------------------------------------------------------

-- The key the gateway opened, from the transaction's setting.
CREATE FUNCTION app.current_service_huvudman_key_id() RETURNS uuid
LANGUAGE sql STABLE SET search_path = "public", "pg_temp" AS $$
  SELECT nullif(current_setting('app.service_huvudman_key_id', true), '')::uuid
$$;

-- The schools the key reads, in a fixed order: none for a revoked key.
CREATE FUNCTION app.huvudman_key_schools() RETURNS TABLE (school_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT hs."schoolId"
    FROM "HuvudmanApiKeys" k
    JOIN "HuvudmanSchools" hs ON hs."huvudmanId" = k."huvudmanId"
   WHERE k."id" = app.current_service_huvudman_key_id() AND k."revokedAt" IS NULL
   ORDER BY hs."schoolId"
$$;

-- The key's huvudman, for the provider's Organisation of type Huvudman:
-- none for a revoked key.
CREATE FUNCTION app.huvudman_key_owner()
RETURNS TABLE (huvudman_id uuid, name text, organisation_number text, municipality_code text,
               created_at timestamptz, updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT h."id", h."name", h."organisationNumber", h."municipalityCode", h."createdAt", h."updatedAt"
    FROM "HuvudmanApiKeys" k JOIN "Huvudmen" h ON h."id" = k."huvudmanId"
   WHERE k."id" = app.current_service_huvudman_key_id() AND k."revokedAt" IS NULL
$$;

COMMENT ON FUNCTION app.huvudman_key_owner() IS
  'Huvudman (20261212090000): the huvudman of the transaction''s huvudman key (app.service_huvudman_key_id), for the provider''s Organisation of type Huvudman; none for a revoked key.';

-- Opens p_school for the key: the service principal of that one school,
-- beside the key, only when the key is live and its huvudman owns the
-- school; HM403 otherwise, and nothing is set. The only way the gateway
-- sets app.service_school_id for a huvudman's key.
CREATE FUNCTION app.huvudman_key_opens_school(p_key uuid, p_school uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF p_key IS NULL OR p_school IS NULL OR NOT EXISTS (
       SELECT 1 FROM "HuvudmanApiKeys" k
         JOIN "HuvudmanSchools" hs ON hs."huvudmanId" = k."huvudmanId"
        WHERE k."id" = p_key AND k."revokedAt" IS NULL AND hs."schoolId" = p_school) THEN
    RAISE EXCEPTION 'HUVUDMAN_KEY_DOES_NOT_READ_THE_SCHOOL' USING ERRCODE = 'HM403';
  END IF;
  PERFORM set_config('app.service_huvudman_key_id', p_key::text, true),
          set_config('app.service_school_id', p_school::text, true);
END
$$;

COMMENT ON FUNCTION app.current_service_huvudman_key_id() IS
  'Huvudman (20261212090000): the huvudman''s SS12000 key a transaction reads for (app.service_huvudman_key_id), or NULL.';
COMMENT ON FUNCTION app.huvudman_key_schools() IS
  'Huvudman (20261212090000): the schools the transaction''s huvudman key reads (app.service_huvudman_key_id), by id; none for a revoked key.';
COMMENT ON FUNCTION app.huvudman_key_opens_school(uuid, uuid) IS
  'Huvudman (20261212090000): sets the transaction''s service principal to p_school for the huvudman key p_key, when the key is live and its huvudman owns the school; HM403 otherwise, with nothing set.';

-- The key lookup stamps lastUsedAt and nothing else; a revoked key stays
-- revoked. (20261014120000's guard for a school's keys, for the huvudman's.)
CREATE FUNCTION app.huvudman_api_keys_writes_are_narrow() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF app.is_service_key_lookup()
     AND (to_jsonb(NEW) - 'lastUsedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'lastUsedAt') THEN
    RAISE EXCEPTION 'INTEGRATION_KEY_LOOKUP_WRITES_ARE_NARROW: nyckeluppslaget stämplar bara senaste användning'
      USING ERRCODE = 'SS403';
  END IF;
  IF OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt" THEN
    RAISE EXCEPTION 'HUVUDMAN_KEY_STAYS_REVOKED: en återkallad nyckel förblir återkallad'
      USING ERRCODE = 'HM409';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "HuvudmanApiKeys_writes_are_narrow"
    BEFORE UPDATE ON "HuvudmanApiKeys"
    FOR EACH ROW EXECUTE FUNCTION app.huvudman_api_keys_writes_are_narrow();

-- ---------------------------------------------------------------------------
-- Row security and grants.
--
-- The gateway's role only: the web and the app read none of these tables
-- through PostgREST. A school's own tables get no arm here, and no school's
-- arm asks about a huvudman except through the three helpers.
-- ---------------------------------------------------------------------------

ALTER TABLE "Huvudmen" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "HuvudmanMembers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "HuvudmanSchools" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "HuvudmanSchoolRequests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "HuvudmanSchoolEvents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "HuvudmanApiKeys" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
  r text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    -- The huvudman: its members, and the administrators of a school it owns
    -- or asks for.
    CREATE POLICY "huvudmen_member_select" ON "Huvudmen"
        FOR SELECT TO "app_authenticated"
        USING ("id" = ANY ((select app.my_huvudman_ids())::uuid[])
               OR "id" = ANY ((select app.school_huvudman_ids())::uuid[]));

    -- Members: the huvudman's members read each other; the
    -- kommunadministratör writes them (the login aside: column grants below,
    -- and app.huvudman_member_takes_login).
    CREATE POLICY "huvudman_members_member_select" ON "HuvudmanMembers"
        FOR SELECT TO "app_authenticated"
        USING ("huvudmanId" = ANY ((select app.my_huvudman_ids())::uuid[]));
    CREATE POLICY "huvudman_members_kommunadmin_insert" ON "HuvudmanMembers"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("huvudmanId" = ANY ((select app.my_kommunadmin_huvudman_ids())::uuid[])
                    AND "authId" IS NULL AND "invitedAt" IS NULL);
    CREATE POLICY "huvudman_members_kommunadmin_update" ON "HuvudmanMembers"
        FOR UPDATE TO "app_authenticated"
        USING ("huvudmanId" = ANY ((select app.my_kommunadmin_huvudman_ids())::uuid[]))
        WITH CHECK ("huvudmanId" = ANY ((select app.my_kommunadmin_huvudman_ids())::uuid[]));

    -- Ownership, questions and their history: the huvudman's members, and
    -- the administrators of the school. Written only by the functions above.
    CREATE POLICY "huvudman_schools_select" ON "HuvudmanSchools"
        FOR SELECT TO "app_authenticated"
        USING ("huvudmanId" = ANY ((select app.my_huvudman_ids())::uuid[])
               OR ("schoolId" = (select app.current_school_id())
                   AND (select app.current_user_role()) = 'SCHOOL_ADMIN'));
    CREATE POLICY "huvudman_school_requests_select" ON "HuvudmanSchoolRequests"
        FOR SELECT TO "app_authenticated"
        USING ("huvudmanId" = ANY ((select app.my_huvudman_ids())::uuid[])
               OR ("schoolId" = (select app.current_school_id())
                   AND (select app.current_user_role()) = 'SCHOOL_ADMIN'));
    CREATE POLICY "huvudman_school_events_select" ON "HuvudmanSchoolEvents"
        FOR SELECT TO "app_authenticated"
        USING ("huvudmanId" = ANY ((select app.my_huvudman_ids())::uuid[])
               OR ("schoolId" = (select app.current_school_id())
                   AND (select app.current_user_role()) = 'SCHOOL_ADMIN'));

    -- Keys: the kommunadministratör makes, reads and revokes them; the key
    -- lookup reads a live one and stamps when it was used.
    CREATE POLICY "huvudman_api_keys_kommunadmin_select" ON "HuvudmanApiKeys"
        FOR SELECT TO "app_authenticated"
        USING ("huvudmanId" = ANY ((select app.my_kommunadmin_huvudman_ids())::uuid[]));
    CREATE POLICY "huvudman_api_keys_kommunadmin_insert" ON "HuvudmanApiKeys"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("huvudmanId" = ANY ((select app.my_kommunadmin_huvudman_ids())::uuid[])
                    AND "revokedAt" IS NULL AND "lastUsedAt" IS NULL);
    CREATE POLICY "huvudman_api_keys_kommunadmin_update" ON "HuvudmanApiKeys"
        FOR UPDATE TO "app_authenticated"
        USING ("huvudmanId" = ANY ((select app.my_kommunadmin_huvudman_ids())::uuid[]))
        WITH CHECK ("huvudmanId" = ANY ((select app.my_kommunadmin_huvudman_ids())::uuid[]));
    CREATE POLICY "huvudman_api_keys_service_lookup" ON "HuvudmanApiKeys"
        FOR SELECT TO "app_authenticated"
        USING ((select app.is_service_key_lookup()) AND "revokedAt" IS NULL);
    CREATE POLICY "huvudman_api_keys_service_touch" ON "HuvudmanApiKeys"
        FOR UPDATE TO "app_authenticated"
        USING ((select app.is_service_key_lookup()) AND "revokedAt" IS NULL)
        WITH CHECK ((select app.is_service_key_lookup()) AND "revokedAt" IS NULL);

    FOREACH t IN ARRAY ARRAY['Huvudmen', 'HuvudmanMembers', 'HuvudmanSchools', 'HuvudmanSchoolRequests',
                             'HuvudmanSchoolEvents', 'HuvudmanApiKeys'] LOOP
      EXECUTE format('REVOKE ALL ON %I FROM "app_authenticated"', t);
      EXECUTE format('GRANT SELECT ON %I TO "app_authenticated"', t);
    END LOOP;
    GRANT INSERT ("huvudmanId", "email", "firstName", "lastName", "role", "isActive", "updatedAt")
        ON "HuvudmanMembers" TO "app_authenticated";
    GRANT UPDATE ("firstName", "lastName", "role", "isActive", "updatedAt")
        ON "HuvudmanMembers" TO "app_authenticated";
    GRANT INSERT ("huvudmanId", "name", "keyHash", "scopes", "createdById")
        ON "HuvudmanApiKeys" TO "app_authenticated";
    GRANT UPDATE ("revokedAt", "lastUsedAt") ON "HuvudmanApiKeys" TO "app_authenticated";
  END IF;

  FOREACH t IN ARRAY ARRAY['Huvudmen', 'HuvudmanMembers', 'HuvudmanSchools', 'HuvudmanSchoolRequests',
                           'HuvudmanSchoolEvents', 'HuvudmanApiKeys'] LOOP
    FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM "service_role"', t);
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
-- Function grants, guarded.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  fn text;
  r text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'app.my_huvudman_ids()',
    'app.my_kommunadmin_huvudman_ids()',
    'app.school_huvudman_ids()',
    'app.current_huvudman_member_id()',
    'app.huvudman_reader()',
    'app.my_schools()',
    'app.huvudman_member_takes_login(uuid, uuid)',
    'app.huvudman_school_lock(uuid)',
    'app.huvudman_kommunadmin(uuid)',
    'app.school_decider()',
    'app.huvudman_request_school(uuid, text)',
    'app.huvudman_withdraw_request(uuid, uuid)',
    'app.huvudman_release_school(uuid, uuid)',
    'app.school_accepts_huvudman(uuid)',
    'app.school_declines_huvudman(uuid)',
    'app.school_leaves_huvudman()',
    'app.school_huvudman_readers()',
    'app.school_huvudman_keys()',
    'app.huvudman_schools(uuid)',
    'app.huvudman_history(uuid, integer)',
    'app.school_huvudman_history(integer)',
    'app.same_huvudman(uuid, uuid)',
    'app.current_service_huvudman_key_id()',
    'app.huvudman_key_schools()',
    'app.huvudman_key_owner()',
    'app.huvudman_key_opens_school(uuid, uuid)',
    'app.huvudman_api_keys_writes_are_narrow()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated', 'supabase_auth_admin'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', fn, r);
      END IF;
    END LOOP;
  END LOOP;

  -- sign_in.rules was made anew: the hook's callee, as 20261204090000 gave it.
  EXECUTE 'REVOKE ALL ON FUNCTION sign_in.rules(uuid) FROM PUBLIC';
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated', 'supabase_auth_admin'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION sign_in.rules(uuid) FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    GRANT EXECUTE ON FUNCTION sign_in.rules(uuid) TO "supabase_auth_admin";
  END IF;

  -- The gateway: the arms' membership helpers (a policy's function is run
  -- as the querying role, which needs EXECUTE), the reader's lookup, the
  -- switcher's list, the huvudman's and the school's acts, what a school
  -- reads of its huvudman, and the key.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    FOREACH fn IN ARRAY ARRAY[
      'app.my_huvudman_ids()',
      'app.my_kommunadmin_huvudman_ids()',
      'app.school_huvudman_ids()',
      'app.huvudman_reader()',
      'app.my_schools()',
      'app.huvudman_member_takes_login(uuid, uuid)',
      'app.huvudman_request_school(uuid, text)',
      'app.huvudman_withdraw_request(uuid, uuid)',
      'app.huvudman_release_school(uuid, uuid)',
      'app.school_accepts_huvudman(uuid)',
      'app.school_declines_huvudman(uuid)',
      'app.school_leaves_huvudman()',
      'app.school_huvudman_readers()',
      'app.school_huvudman_keys()',
      'app.huvudman_schools(uuid)',
      'app.huvudman_history(uuid, integer)',
      'app.school_huvudman_history(integer)',
      'app.huvudman_key_schools()',
      'app.huvudman_key_owner()',
      'app.huvudman_key_opens_school(uuid, uuid)'
    ] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO "app_authenticated"', fn);
    END LOOP;
  END IF;
END
$$;
