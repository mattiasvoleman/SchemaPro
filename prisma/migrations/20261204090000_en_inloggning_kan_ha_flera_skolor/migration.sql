-- En inloggning kan ha flera skolor, och varje anrop säger vilken det gäller.
--
-- Roadmap: Kommun lane, phase "Flera skolor per inloggning". A person who
-- works at two schools, or a guardian with children at two, signs in once
-- and switches between the schools.
--
-- ## The model: one row per school, several rows per login
--
-- A person keeps one "Users" row per school: the row carries the role, the
-- administrator's profile, HR-läs, the class and the person's details there,
-- and every composite foreign key (id, schoolId) and every policy goes on
-- assuming it. What changes is that a row is no longer the only one for its
-- login: Users_authId_key gives way to Users_authId_schoolId_key, so a login
-- has at most one row per school. One role per school, as before.
--
-- ## Which row a request is
--
-- No policy reads "authId" or auth.uid(); all 479 ask six functions who the
-- caller is (app.current_user_id, current_school_id, current_user_role,
-- current_user_group_id, current_user_may, current_user_decides), and every
-- call in a policy is wrapped as (SELECT …), an initplan run once per
-- statement. So the access rules change here, in those six, and no policy is
-- rewritten. Each resolved the caller by authId alone; now app.current_user_id()
-- picks one of the login's own active rows, and the other five read that row.
--
--   * A school the request names: the gateway's transaction setting
--     app.chosen_school_id (PrismaService.withRls sets it to the school the
--     gateway resolved), else PostgREST's request header x-school-id
--     (request.headers). The row there, if it is active and the session may
--     enter the school (below). Otherwise no row at all: every helper is
--     NULL and every table answers nothing, as for an inactive person. A
--     choice that cannot be followed never falls back to another school, so
--     a write can never land in a school the client did not name.
--   * No school named: the login's active row, of those the session may
--     enter, that took the login first ("loginSince", below; then createdAt
--     and id). For a login with one row, which is every login
--     before this release, that is the row it always was.
--
-- The choice only ever picks among rows whose authId is auth.uid(): a forged
-- or stale value gives nobody more than the rows they already have. Before
-- this, current_user_may and current_user_decides took bool_or over every
-- row of the login; with two rows a läsare at one school would have written
-- with the profile of the other. They now ask the chosen row only.
--
-- ## Schools a session may not enter (Logga in med skolkonto, 20261020090000)
--
-- The access-token hook judged one row (SELECT INTO from sign_in.rules took
-- whichever came first). It now judges each of the person's rows under that
-- row's school's rules:
--
--   * no active school lets the session in: the same 403 as before, with the
--     first active row's reason. For a person with one school, today's
--     answer exactly;
--   * some do: the token is issued, with the claim rastra_closed_schools
--     {schoolId: reason} naming every school that refused, an inactive row's
--     too, so a row made active again during the token's life is not open
--     for having been skipped. The resolver never picks a closed school, and
--     app.my_schools() says why it is closed. The claim is set only when
--     something is closed, so the token of a person with one school is byte
--     for byte what it was.
--
-- A person all of whose rows are inactive is judged on every row, as before.
-- With the hook off, as until docs/DEPLOYMENT.md §11.2 is done, nothing is
-- closed. The verdicts are the token's: a row that takes the login after the
-- token was issued is judged at the next refresh, within the token's
-- lifetime, as a school turning on "Kräv skolkonto" already is (§11).
--
-- ## A login joins another school only through an invitation
--
-- Users_a_login_joins_another_school_by_invitation (an AFTER trigger, so
-- row security has refused any writer it would refuse first) refuses a row
-- taking a login another row already holds, unless the transaction says it is the
-- gateway's invitation adopting that login for that row (app.login_join set
-- to the row's id, UsersService.adoptIdentity). It refuses as the unique
-- index used to (23505, Users_authId_key), so the API before this release,
-- which sets nothing, answers 409 exactly as before. PostgREST cannot set
-- app.* settings; the SS12000 sync and the seed write placeholder logins.
--
-- A shared login is the person's, not any one school's:
--
--   * app.login_is_held_elsewhere(authId, userId): whether a row other than
--     userId holds the login. The gateway asks it before it deletes or moves
--     a login (a removal, a re-invitation), and leaves a shared one alone;
--   * app.gallring_claim_person answers invited = false for a login another
--     row holds, so the nightly job pseudonymises the row and leaves the
--     login to the other school. The job before this release reads the
--     column the same way and needs no change.
--
-- Each of those asks just before it acts at the auth provider, which no
-- transaction holds. Two schools acting on one person in the same moment
-- (one inviting, one removing) can therefore leave the inviting school's row
-- on a login the other has just deleted; inviting the person again gives the
-- row a login. A lock across the provider's call would make every invitation
-- wait on it, and the trigger may not take one (an advisory lock held across
-- the row's foreign-key checks deadlocks, as 20261101090000 found).
--
-- ## For the switcher
--
-- app.my_schools(): the caller's own active rows with their schools' names,
-- whether the session may enter each (and why not) and which one this
-- request is. SECURITY DEFINER over the caller's own rows only; the API role
-- may execute it.
--
-- ## Beside the live API
--
-- Production runs this before the release's code. Users is read by every
-- request (the helpers) and the index swap needs its ACCESS EXCLUSIVE lock,
-- taken first, NOWAIT, in a loop: a refusal rolls the subtransaction back
-- and tries again 50 ms later, so the migration never waits while holding a
-- lock and no request queues behind it; after 30 s it stops with nothing
-- changed and can be run again. lock_timeout bounds any wait nobody
-- foresaw. Users is small; the new unique index builds in milliseconds.
-- Nothing else is locked: functions are replaced without a table lock.
--
-- The API before this release keeps working on this schema. Every login has
-- one row, so the resolver gives it the row it had; its findUnique on authId
-- reads that row under RLS; an invitation to an address with a login at
-- another school gets the 409 it got; gallring and the hook answer a person
-- with one school as before. No data changes.
--
-- Deploy the API and the web of this release together. The web sends
-- x-school-id only for a session with more than one school, and none can
-- exist before the release's API adopts a login for a second school.
--
-- A rollback past this release, once a login has a second school: the old
-- API deletes a login when one school removes or re-invites its row, which
-- would end the person's access at the other school too. Before rolling
-- back, list the shared logins:
--   SELECT "authId", count(*) FROM "Users" GROUP BY 1 HAVING count(*) > 1;

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

-- ---------------------------------------------------------------------------
-- One row per school per login.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX "Users_authId_schoolId_key" ON "Users" ("authId", "schoolId");
DROP INDEX "Users_authId_key";

-- 20260822140000 wrote on the column that its uniqueness held the helpers
-- up, and that it was not to be relaxed but in the migration that rewrites
-- them. This is that migration; the column now says what holds instead.
COMMENT ON COLUMN "Users"."authId" IS
  'Supabase Auth user id (auth.users.id = JWT sub = auth.uid()). Unique per school (Users_authId_schoolId_key) since 20261204090000: a login has one row per school. The six helpers (app.current_user_id, current_school_id, current_user_role, current_user_group_id, current_user_may, current_user_decides) pick one row of the login, by the school the request names or else the row that took the login first, with one clause that rls-policies.sql section 10 holds equal; no function reads Users by authId but those section 10 allows. A row takes a login another row holds only through the gateway''s invitation (Users_a_login_joins_another_school_by_invitation).';

-- When the row took the login it holds now. The default, with no school
-- named, is the login's row that took it first; not the oldest row, since
-- rows are often made long before anybody is invited (an SS12000 import,
-- the catalogue built before term) and a school that invites the person
-- later must not become the school their app opens on. Kept by the trigger
-- below, whatever a statement writes: an invitation that hands a row a new
-- login restamps it, one that leaves the login where it is does not, and no
-- administrator can move a person's default by setting it.
--
-- A constant default, so every existing row takes this migration's moment
-- without a rewrite and without an UPDATE (which would fire every Users
-- trigger, the SS12000 versions among them). Every existing login has one
-- row, so the ties order nothing.
ALTER TABLE "Users" ADD COLUMN "loginSince" timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN "Users"."loginSince" IS
  'Flera skolor (20261204090000): when the row took the login it holds now (Users_login_since_is_the_logins). The login''s default row, with no school named, is the one that took it first.';

-- ---------------------------------------------------------------------------
-- What the request names.
-- ---------------------------------------------------------------------------

-- The school the request names, lower case, as text: the gateway's setting
-- first, PostgREST's header second (parsed only when the setting names
-- none), NULL when neither names one. Text, so a value that is no uuid
-- matches no row instead of failing the statement.
--
-- Both functions are a single expression with no SET and no SECURITY
-- DEFINER, so the planner inlines them into the helpers below: every policy
-- of every table asks the helpers, and a function call of their own (with
-- its search_path saved and restored on each call) measured five times the
-- cost of the lookup they serve. They read nothing but settings and
-- pg_catalog functions, which resolve first whatever the search_path.
CREATE FUNCTION app.requested_school() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT lower(coalesce(
           nullif(btrim(current_setting('app.chosen_school_id', true)), ''),
           nullif(btrim(nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-school-id'), '')
         ))
$$;

-- The schools this session may not enter, from the access-token hook's
-- claim {schoolId: reason}; '{}' when there is none. A school is closed by
-- being a key (or, should a claim ever be an array, an element) of it. The
-- claims are parsed only when their text names the claim, which a token
-- with nothing closed (every token but a few) never does.
CREATE FUNCTION app.closed_schools() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN strpos(coalesce(current_setting('request.jwt.claims', true), ''), 'rastra_closed_schools') = 0 THEN '{}'::jsonb
    ELSE coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'rastra_closed_schools', '{}'::jsonb)
  END
$$;

COMMENT ON FUNCTION app.requested_school() IS
  'Flera skolor (20261204090000): the school a request names, lower case: app.chosen_school_id (the gateway), else the x-school-id request header (PostgREST); NULL when neither.';
COMMENT ON FUNCTION app.closed_schools() IS
  'Flera skolor (20261204090000): the schools the session may not enter, from the access-token hook''s rastra_closed_schools claim; {} when none.';

REVOKE ALL ON FUNCTION app.requested_school() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.closed_schools() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- The six helpers every policy is built on.
--
-- Each picks the row itself, with the same clause (the login's active rows,
-- not closed, at the school named if one is, first by "loginSince"), rather than
-- asking app.current_user_id() for it: a SECURITY DEFINER call inside
-- another, and a second lookup of the row, in every helper of every policy.
-- RLS section 10 holds the six clauses equal, and section 240 the answers.
--
-- In PL/pgSQL rather than SQL, and that is a measured choice. A SQL
-- function's body is planned again on every call in PostgreSQL 16 and 17,
-- and the clause is more to plan than the old lookup was: as SQL, the six
-- made a policy-guarded statement 1.7 times slower than main's helpers did.
-- PL/pgSQL keeps the plan for the connection. Measured paired on PG16, 12
-- rounds of 600 statements as the API role (a count of CalendarLessons and a
-- write gate): main's helpers 1.34 ms a statement, these 0.63 ms (median),
-- faster in every round. Nothing in the plan is the caller's: auth.uid()
-- and the settings are read when it runs.
--
-- CREATE OR REPLACE keeps each function's owner and grants, and resets what
-- it does not restate, so LANGUAGE, STABLE, SECURITY DEFINER and search_path
-- are restated as they were. Losing SECURITY DEFINER would make every policy
-- recurse back through "Users".
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  RETURN (
    SELECT u."id"
      FROM "Users" u
     WHERE u."authId" = (select auth.uid()) AND u."isActive"
       AND NOT (app.closed_schools() ? u."schoolId"::text)
       AND coalesce(app.requested_school() = u."schoolId"::text, true)
     ORDER BY u."loginSince", u."createdAt", u."id"
     LIMIT 1
  );
END
$$;

CREATE OR REPLACE FUNCTION app.current_school_id() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  RETURN (
    SELECT u."schoolId"
      FROM "Users" u
     WHERE u."authId" = (select auth.uid()) AND u."isActive"
       AND NOT (app.closed_schools() ? u."schoolId"::text)
       AND coalesce(app.requested_school() = u."schoolId"::text, true)
     ORDER BY u."loginSince", u."createdAt", u."id"
     LIMIT 1
  );
END
$$;

CREATE OR REPLACE FUNCTION app.current_user_role() RETURNS "UserRole"
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  RETURN (
    SELECT u."role"
      FROM "Users" u
     WHERE u."authId" = (select auth.uid()) AND u."isActive"
       AND NOT (app.closed_schools() ? u."schoolId"::text)
       AND coalesce(app.requested_school() = u."schoolId"::text, true)
     ORDER BY u."loginSince", u."createdAt", u."id"
     LIMIT 1
  );
END
$$;

CREATE OR REPLACE FUNCTION app.current_user_group_id() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  RETURN (
    SELECT u."studentGroupId"
      FROM "Users" u
     WHERE u."authId" = (select auth.uid()) AND u."isActive"
       AND NOT (app.closed_schools() ? u."schoolId"::text)
       AND coalesce(app.requested_school() = u."schoolId"::text, true)
     ORDER BY u."loginSince", u."createdAt", u."id"
     LIMIT 1
  );
END
$$;

CREATE OR REPLACE FUNCTION app.current_user_may(p_area "AdminArea", p_write boolean) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  RETURN (
    SELECT coalesce((
      SELECT u."role" = 'SCHOOL_ADMIN'
             AND p_area IS NOT NULL
             AND (NOT coalesce(p_write, true) OR p_area = ANY (app.admin_profile_writes(u."adminProfile")))
        FROM "Users" u
       WHERE u."authId" = (select auth.uid()) AND u."isActive"
         AND NOT (app.closed_schools() ? u."schoolId"::text)
         AND coalesce(app.requested_school() = u."schoolId"::text, true)
       ORDER BY u."loginSince", u."createdAt", u."id"
       LIMIT 1
    ), false)
  );
END
$$;

CREATE OR REPLACE FUNCTION app.current_user_decides() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  RETURN (
    SELECT coalesce((
      SELECT u."role" = 'SCHOOL_ADMIN' AND app.admin_profile_decides(u."adminProfile")
        FROM "Users" u
       WHERE u."authId" = (select auth.uid()) AND u."isActive"
         AND NOT (app.closed_schools() ? u."schoolId"::text)
         AND coalesce(app.requested_school() = u."schoolId"::text, true)
       ORDER BY u."loginSince", u."createdAt", u."id"
       LIMIT 1
    ), false)
  );
END
$$;

COMMENT ON FUNCTION app.current_user_id() IS
  'Users.id of the signed-in principal at the school the request names (app.requested_school), else at the school whose row took the login first; only an ACTIVE row of auth.uid()''s, at a school the session may enter (app.closed_schools). NULL when none: a named school that cannot be followed falls back to no other.';
COMMENT ON FUNCTION app.current_school_id() IS
  'Tenant of the signed-in principal: the school of the row app.current_user_id() picks (the same clause), or NULL.';
COMMENT ON FUNCTION app.current_user_role() IS
  'Role of the signed-in principal at the chosen school (the row app.current_user_id() picks), or NULL.';
COMMENT ON FUNCTION app.current_user_group_id() IS
  'Home class of the signed-in principal at the chosen school; NULL for staff and for anyone inactive.';
COMMENT ON FUNCTION app.current_user_may("AdminArea", boolean) IS
  'May the signed-in, active SCHOOL_ADMIN read (every one) or write (by profile) the area, at the chosen school only. False for everybody else.';
COMMENT ON FUNCTION app.current_user_decides() IS
  'Is the signed-in, active SCHOOL_ADMIN rektor or full at the chosen school. False for everybody else.';

-- ---------------------------------------------------------------------------
-- The switcher's list.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.my_schools()
RETURNS TABLE (
    user_id       uuid,
    school_id     uuid,
    school_name   text,
    role          "UserRole",
    admin_profile "AdminProfile",
    closed_reason text,
    is_current    boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT u."id", u."schoolId", s."name", u."role", u."adminProfile",
         app.closed_schools() ->> u."schoolId"::text,
         u."id" IS NOT DISTINCT FROM app.current_user_id()
    FROM "Users" u
    JOIN "Schools" s ON s."id" = u."schoolId"
   WHERE u."authId" = (select auth.uid()) AND u."isActive"
   ORDER BY u."loginSince", u."createdAt", u."id"
$$;

COMMENT ON FUNCTION app.my_schools() IS
  'Flera skolor (20261204090000): the signed-in login''s own active rows, first by loginSince, with the school''s name, why the session may not enter it (NULL when it may) and whether it is the row this request is. For the gateway''s GET /api/v1/me/schools.';

-- ---------------------------------------------------------------------------
-- A login joins another school only through an invitation.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.users_a_login_joins_another_school_by_invitation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."authId" IS NOT DISTINCT FROM OLD."authId" THEN
    RETURN NULL;
  END IF;
  -- Two writers handing one login to rows at two schools at once would
  -- each miss the other's row, not yet committed, and both commit; the
  -- unique index made the second wait for the first and fail. This lock
  -- does the same: the second waits here until the first has committed,
  -- and the check below, a statement of its own (READ COMMITTED), then
  -- sees the first's row. Only for a row that is invited to the login it
  -- takes: a catalogue row's placeholder (an SS12000 import, gallring,
  -- invitedAt NULL) is nobody's login, and a bulk write would take one lock
  -- a row.
  IF NEW."invitedAt" IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('Users.authId'), hashtext(NEW."authId"::text));
  END IF;
  IF EXISTS (SELECT 1 FROM "Users" o WHERE o."authId" = NEW."authId" AND o."id" <> NEW."id")
     AND current_setting('app.login_join', true) IS DISTINCT FROM NEW."id"::text THEN
    -- As the unique index refused it before 20261204090000, so that a
    -- writer that does not know about logins shared by schools sees what it
    -- always saw.
    RAISE EXCEPTION 'duplicate key value violates unique constraint "Users_authId_key"'
      USING ERRCODE = 'unique_violation',
            CONSTRAINT = 'Users_authId_key',
            DETAIL = 'Key ("authId")=(' || NEW."authId" || ') already exists.',
            HINT = 'A login joins another school only through the gateway''s invitation (app.login_join).';
  END IF;
  RETURN NULL;
END
$$;

COMMENT ON FUNCTION app.users_a_login_joins_another_school_by_invitation() IS
  'Flera skolor (20261204090000): a row takes a login another row holds only when the transaction''s app.login_join names it (UsersService.adoptIdentity); otherwise 23505 on Users_authId_key, as before the login could be shared.';

REVOKE ALL ON FUNCTION app.users_a_login_joins_another_school_by_invitation() FROM PUBLIC;

-- AFTER, not BEFORE: a BEFORE trigger runs ahead of row security, and its
-- 23505 would tell a writer row security refuses (PostgREST's role may
-- INSERT into Users, and the arms refuse it) whether some row anywhere holds
-- a given login. After the row has passed row security, only a writer who
-- may write the row hears it.
CREATE TRIGGER "Users_a_login_joins_another_school_by_invitation"
    AFTER INSERT OR UPDATE OF "authId" ON "Users"
    FOR EACH ROW EXECUTE FUNCTION app.users_a_login_joins_another_school_by_invitation();

-- "loginSince" is the moment the row took its login, and only that.
CREATE FUNCTION app.users_login_since_is_the_logins() RETURNS trigger
LANGUAGE plpgsql SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW."authId" IS DISTINCT FROM OLD."authId" THEN
    NEW."loginSince" := clock_timestamp();
  ELSE
    NEW."loginSince" := OLD."loginSince";
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app.users_login_since_is_the_logins() IS
  'Flera skolor (20261204090000): stamps Users.loginSince when a row is made or takes another login, and keeps it on every other write.';

REVOKE ALL ON FUNCTION app.users_login_since_is_the_logins() FROM PUBLIC;

CREATE TRIGGER "Users_login_since_is_the_logins"
    BEFORE INSERT OR UPDATE OF "authId", "loginSince" ON "Users"
    FOR EACH ROW EXECUTE FUNCTION app.users_login_since_is_the_logins();

-- Whether a row other than p_user holds the login. Asked by the gateway
-- before it deletes or moves a login, which it then leaves alone.
CREATE FUNCTION app.login_is_held_elsewhere(p_auth_id uuid, p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT EXISTS (SELECT 1 FROM "Users" WHERE "authId" = p_auth_id AND "id" IS DISTINCT FROM p_user)
$$;

COMMENT ON FUNCTION app.login_is_held_elsewhere(uuid, uuid) IS
  'Flera skolor (20261204090000): whether a Users row other than p_user holds the login p_auth_id. A shared login is the person''s: no one school deletes or moves it.';

-- ---------------------------------------------------------------------------
-- Gallring leaves a shared login to the other school.
--
-- As 20261021120000 wrote it, except that "invited" now says the row has a
-- login of its own to delete: invited, and no other row holds the login.
-- ---------------------------------------------------------------------------

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
    FROM app.gallring_due(r."schoolId", 'DEPARTED_PEOPLE', cutoff, today) d
    JOIN "Users" u ON u."id" = d."id"
   WHERE d."id" = p_user;
END
$$;

COMMENT ON FUNCTION app.gallring_claim_person(uuid, uuid) IS
  'For the nightly job, right before a departed person''s login is deleted: locks their Users row and answers their authId and whether they have a login of their own to delete (invited, and held by no other row: a login another school''s row holds stays, 20261204090000), only while they are still due under the period in force now; no row otherwise.';

-- ---------------------------------------------------------------------------
-- The access-token hook judges each school.
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
    "ssoOnlyForStaff"      boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
BEGIN ATOMIC
  SELECT u."schoolId", u."isActive", u."loginSince", u."createdAt", u."id",
         u."role", m."provider", m."entraTenantId", m."googleHostedDomain", m."ssoOnlyForStaff"
    FROM public."Users" u
    LEFT JOIN public."SchoolSignInMethods" m ON m."schoolId" = u."schoolId"
   WHERE u."authId" = p_auth_id
   ORDER BY u."loginSince", u."createdAt", u."id";
END;

COMMENT ON FUNCTION sign_in.rules(uuid) IS
  'Logga in med skolkonto (20261020090000), per school since 20261204090000: each row of the person with this Auth id, first by loginSince, with its role and its school''s sign-in row; no row when there is no such person. For the access-token hook only.';

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
      closed := closed || jsonb_build_object(rules."schoolId"::text, verdict);
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
  'Logga in med skolkonto (20261020090000), per school since 20261204090000: Supabase Auth''s custom access token hook. Judges each of the person''s rows under its school''s rules. A 403 (sign_in_method_not_allowed, sso_not_enabled, sso_identity_not_allowed, sso_required or sso_reauth_required, the first active row''s) when no active school lets the session in; else the claims, with rastra_closed_schools {schoolId: reason} naming every school, active row or not, that does not.';

-- ---------------------------------------------------------------------------
-- Grants, guarded.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  fn text;
  r text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'sign_in.rules(uuid)',
    'app.my_schools()',
    'app.login_is_held_elsewhere(uuid, uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated', 'supabase_auth_admin'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', fn, r);
      END IF;
    END LOOP;
  END LOOP;

  -- Supabase Auth's role: the hook's callee again, as 20261020090000 gave it.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    GRANT EXECUTE ON FUNCTION sign_in.rules(uuid) TO "supabase_auth_admin";
  END IF;

  -- The gateway: the switcher's list, and whether a login is shared.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT EXECUTE ON FUNCTION app.my_schools() TO "app_authenticated";
    GRANT EXECUTE ON FUNCTION app.login_is_held_elsewhere(uuid, uuid) TO "app_authenticated";
  END IF;
END
$$;
