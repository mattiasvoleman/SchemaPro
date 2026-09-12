-- Row-level-security policy tests, run against a real database as the role the
-- API actually connects with.
--
--   docker compose exec -T db env PGPASSWORD=app_authenticated_local \
--     psql -U app_authenticated -h localhost -d schemapro -v ON_ERROR_STOP=1 \
--     -f scripts/test/rls-policies.sql
--
-- Every assertion RAISEs on failure, and ON_ERROR_STOP makes psql exit
-- non-zero, so this works as a CI gate with no test framework.
--
-- ## Why this file exists
--
-- Three production-breaking bugs shipped because the e2e suite substitutes a
-- mock for PrismaService and never touches Postgres: missing table grants, an
-- identity lookup that returned zero rows under RLS, and an entire integration
-- API that returned empty payloads. None of them are visible to a test that
-- mocks the database — the thing that was broken *was* the database contract.
--
-- These tests assert the security properties directly, as the unprivileged
-- role, with no application code in the way. In particular they check the
-- negative cases: that a principal sees nothing it should not, including when
-- a query forgets its own tenant filter.
--
-- Requires `:school_a` — the tenant to act as. This role cannot look it up
-- itself: with no principal set it sees zero schools, which is the very
-- property being tested. scripts/test/run-rls-tests.sh reads it as the owner
-- and passes it in with -v. Run scripts/test/rls-fixtures.sql first so a
-- second tenant exists; without one, every isolation assertion passes
-- vacuously.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. No principal: the default must be deny, not allow.
--
-- This is the state `withSystemTransaction` leaves a transaction in. It used to
-- be believed to bypass RLS; it returns nothing instead, silently.
-- ---------------------------------------------------------------------------

DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "Users";
  IF n <> 0 THEN
    RAISE EXCEPTION 'no-principal: expected 0 users visible, got %', n;
  END IF;

  SELECT count(*) INTO n FROM "Schools";
  IF n <> 0 THEN
    RAISE EXCEPTION 'no-principal: expected 0 schools visible, got %', n;
  END IF;

  SELECT count(*) INTO n FROM "IntegrationApiKeys";
  IF n <> 0 THEN
    RAISE EXCEPTION 'no-principal: expected 0 api keys visible, got %', n;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. Key-lookup principal: may resolve an API key, and nothing else.
--
-- This is the one operation that cannot be tenant-scoped, so its blast radius
-- must be exactly one table.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config('app.service_key_lookup', 'on', true);

DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "IntegrationApiKeys";
  IF n = 0 THEN
    RAISE EXCEPTION 'key-lookup: expected to see at least one api key, saw none';
  END IF;

  SELECT count(*) INTO n FROM "Users";
  IF n <> 0 THEN
    RAISE EXCEPTION
      'key-lookup: leaked % user rows — this principal must only read IntegrationApiKeys', n;
  END IF;

  SELECT count(*) INTO n FROM "Schools";
  IF n <> 0 THEN
    RAISE EXCEPTION 'key-lookup: leaked % school rows', n;
  END IF;
END
$$;
COMMIT;

-- Revoked keys must stay invisible even to the lookup principal.
BEGIN;
SELECT set_config('app.service_key_lookup', 'on', true);

DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "IntegrationApiKeys" WHERE "revokedAt" IS NOT NULL;
  IF n <> 0 THEN
    RAISE EXCEPTION 'key-lookup: % revoked key(s) visible; revocation is not enforced', n;
  END IF;
END
$$;
COMMIT;

-- ---------------------------------------------------------------------------
-- 3. Service principal: scoped to one school, even without a WHERE clause.
--
-- The point of the policies is that application code forgetting its own tenant
-- filter cannot leak. So these queries deliberately omit one.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config('app.service_school_id', :'school_a', true);

DO $$
DECLARE
  n        bigint;
  school_a uuid := app.current_service_school_id();
BEGIN
  IF school_a IS NULL THEN
    RAISE EXCEPTION 'service-principal: app.current_service_school_id() returned NULL';
  END IF;

  SELECT count(*) INTO n FROM "Schools";
  IF n <> 1 THEN
    RAISE EXCEPTION 'service-principal: expected exactly 1 school visible, got %', n;
  END IF;

  -- No WHERE clause: the policy alone must confine this to one tenant.
  SELECT count(*) INTO n FROM "Users" WHERE "schoolId" <> school_a;
  IF n <> 0 THEN
    RAISE EXCEPTION
      'service-principal: leaked % user rows from other schools', n;
  END IF;

  SELECT count(*) INTO n FROM "Users";
  IF n = 0 THEN
    RAISE EXCEPTION
      'service-principal: saw 0 users for its own school — policy is too strict, or fixtures are empty';
  END IF;

  SELECT count(*) INTO n FROM "StudentGroups" WHERE "schoolId" <> school_a;
  IF n <> 0 THEN
    RAISE EXCEPTION 'service-principal: leaked % student groups from other schools', n;
  END IF;

  SELECT count(*) INTO n FROM "IntegrationApiKeys";
  IF n <> 0 THEN
    RAISE EXCEPTION
      'service-principal: can read % api key(s); key material must not be reachable after authentication', n;
  END IF;
END
$$;
COMMIT;

-- ---------------------------------------------------------------------------
-- 4. Settings are transaction-local and do not survive COMMIT.
--
-- The whole design rests on this: a pooled connection must never carry a
-- principal into the next request.
-- ---------------------------------------------------------------------------

DO $$
DECLARE n bigint;
BEGIN
  IF app.current_service_school_id() IS NOT NULL THEN
    RAISE EXCEPTION
      'leak: app.service_school_id survived COMMIT — set_config was not transaction-local';
  END IF;

  IF app.is_service_key_lookup() THEN
    RAISE EXCEPTION 'leak: app.service_key_lookup survived COMMIT';
  END IF;

  SELECT count(*) INTO n FROM "Users";
  IF n <> 0 THEN
    RAISE EXCEPTION 'leak: % users still visible after COMMIT', n;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 5. RoomTypes: school-owned rows, isolated like every other tenant table.
--
-- Room types carry a school's own vocabulary (Hemkunskapssal, Trä- och
-- metallslöjd). A new table starts with NO policies and NO grants — the two
-- failure modes this file exists to catch. A missing grant makes every request
-- 500; a missing policy leaks one school's setup into another's picker.
--
-- These act as a real signed-in ADMIN of school A, which is the principal the
-- room-type endpoints run under, by setting the JWT claims app.current_*()
-- reads. The service principal is deliberately not used: SS12000 has no
-- business with room types and is granted none, which the last block asserts.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'admin_auth_id')::text,
  true
);

DO $$
DECLARE n bigint; other bigint;
BEGIN
  -- The grant exists at all: without it this SELECT raises "permission denied".
  SELECT count(*) INTO n FROM "RoomTypes";
  IF n = 0 THEN
    RAISE EXCEPTION
      'room-types: admin of school A sees no types (missing rows, missing grant, or a policy that denies everything)';
  END IF;

  -- No WHERE clause: the policy, not the query, must do the scoping.
  SELECT count(*) INTO other FROM "RoomTypes"
   WHERE "schoolId" <> app.current_school_id();
  IF other <> 0 THEN
    RAISE EXCEPTION
      'room-types: % row(s) from another school visible — tenant isolation is not enforced', other;
  END IF;

  -- An admin may write its own school's types.
  INSERT INTO "RoomTypes" ("schoolId", "name")
  VALUES (app.current_school_id(), 'RLS-testtyp');
  DELETE FROM "RoomTypes" WHERE "name" = 'RLS-testtyp';
END
$$;
ROLLBACK;

-- The SS12000 service principal has no room-type policy and must see nothing.
--
-- Claims are reset to an empty object rather than left alone: a ROLLBACK
-- restores the setting to '' rather than unsetting it, and auth.uid() cannot
-- parse an empty string as JSON. '{}' is the honest encoding of "no user".
BEGIN;
SELECT set_config('request.jwt.claims', '{}', true);
SELECT set_config('app.service_school_id', :'school_a', true);

DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "RoomTypes";
  IF n <> 0 THEN
    RAISE EXCEPTION
      'room-types: the integration principal sees % type(s); it is granted none', n;
  END IF;
END
$$;
COMMIT;

-- ---------------------------------------------------------------------------
-- 6. RoomPreferences: soft room rules, readable by staff only.
--
-- Both tables shipped with a SELECT policy named `_staff_select` that carried
-- the tenant predicate and nothing else, so every principal of the school
-- passed it — students and guardians included. Nothing here caught it: the
-- seed created no rows, and this file made no assertion about either table, so
-- the leak was invisible in exactly the way a policy gap always is. Both
-- halves are fixed; these assertions keep the gap from reopening.
--
-- What the policy protects is the planning layer, not the timetable. Which
-- subject a school wants in which room, and how hard it is willing to fight
-- for it, is staff business the way TeachingRequirements is — unlike Rooms,
-- which every member reads to render their own schedule.
--
-- Requires `:student_auth_id` alongside `:admin_auth_id`: the negative case is
-- the whole point, and only a real STUDENT of the school can prove it.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'admin_auth_id')::text,
  true
);

DO $$
DECLARE n bigint; other bigint; preference uuid;
BEGIN
  -- The grant exists at all: without it these SELECTs raise "permission denied".
  SELECT count(*) INTO n FROM "RoomPreferences";
  IF n = 0 THEN
    RAISE EXCEPTION
      'room-preferences: admin of school A sees no preferences (missing seed rows, missing grant, or a policy that denies everything)';
  END IF;

  SELECT count(*) INTO n FROM "RoomPreferenceRooms";
  IF n = 0 THEN
    RAISE EXCEPTION
      'room-preference-rooms: admin of school A sees no rows (missing seed rows, missing grant, or a policy that denies everything)';
  END IF;

  -- No WHERE clause on the tenant: the policy, not the query, must scope these.
  SELECT count(*) INTO other FROM "RoomPreferences"
   WHERE "schoolId" <> app.current_school_id();
  IF other <> 0 THEN
    RAISE EXCEPTION
      'room-preferences: % row(s) from another school visible — tenant isolation is not enforced', other;
  END IF;

  SELECT count(*) INTO other FROM "RoomPreferenceRooms"
   WHERE "schoolId" <> app.current_school_id();
  IF other <> 0 THEN
    RAISE EXCEPTION
      'room-preference-rooms: % row(s) from another school visible — tenant isolation is not enforced', other;
  END IF;

  -- An admin may write its own school's rules, parent row and child rows both.
  INSERT INTO "RoomPreferences" ("schoolId", "subjectId", "weight", "updatedAt")
  SELECT app.current_school_id(), s."id", 5, now()
    FROM "Subjects" s
   WHERE s."schoolId" = app.current_school_id()
   LIMIT 1
  RETURNING "id" INTO preference;

  IF preference IS NULL THEN
    RAISE EXCEPTION
      'room-preferences: the insert produced no row — school A has no subject to point a preference at';
  END IF;

  INSERT INTO "RoomPreferenceRooms" ("schoolId", "preferenceId", "roomId")
  SELECT app.current_school_id(), preference, r."id"
    FROM "Rooms" r
   WHERE r."schoolId" = app.current_school_id()
   LIMIT 1;

  DELETE FROM "RoomPreferenceRooms" WHERE "preferenceId" = preference;
  DELETE FROM "RoomPreferences" WHERE "id" = preference;
END
$$;
ROLLBACK;

-- The negative case: a STUDENT of the same school, which the tenant predicate
-- alone would have let straight through. This is the assertion the original
-- policies failed.
BEGIN;
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'student_auth_id')::text,
  true
);

DO $$
DECLARE n bigint;
BEGIN
  -- Without this guard the block passes vacuously: an authId that resolves to
  -- no user has no role, sees nothing, and looks exactly like success.
  IF app.current_user_role() IS DISTINCT FROM 'STUDENT' THEN
    RAISE EXCEPTION
      'room-preferences: expected to be acting as a STUDENT, got % — the fixtures did not supply one',
      coalesce(app.current_user_role()::text, 'no user at all');
  END IF;

  SELECT count(*) INTO n FROM "RoomPreferences";
  IF n <> 0 THEN
    RAISE EXCEPTION
      'room-preferences: a STUDENT of the school reads % row(s); the staff policy has lost its role check', n;
  END IF;

  SELECT count(*) INTO n FROM "RoomPreferenceRooms";
  IF n <> 0 THEN
    RAISE EXCEPTION
      'room-preference-rooms: a STUDENT of the school reads % row(s); the staff policy has lost its role check', n;
  END IF;
END
$$;
COMMIT;

SELECT 'rls-policies: all assertions passed' AS result;
