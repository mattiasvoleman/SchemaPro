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
-- 6. LunchSettings: one row per school, visible to that school alone.
--
-- Lunch times and the number of seats in the dining hall are what an
-- administrator has to define before publishing a timetable, so this row is
-- read on the publish path and written from exactly one form. It is also the
-- first table added since RoomPreferences, which shipped with no assertions in
-- this file at all — its grant and its policies are still unverified by CI,
-- and this section exists so the same is not true here.
--
-- Acting as a signed-in ADMIN of school A, the principal the lunch-settings
-- endpoints run under. The seed creates the one row these counts expect.
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
  SELECT count(*) INTO n FROM "LunchSettings";
  IF n <> 1 THEN
    RAISE EXCEPTION
      'lunch-settings: admin of school A sees % row(s), expected exactly 1 (missing seed row, missing grant, or a policy that denies everything)', n;
  END IF;

  -- No WHERE clause: the policy, not the query, must do the scoping.
  SELECT count(*) INTO other FROM "LunchSettings"
   WHERE "schoolId" <> app.current_school_id();
  IF other <> 0 THEN
    RAISE EXCEPTION
      'lunch-settings: % row(s) from another school visible — tenant isolation is not enforced', other;
  END IF;

  -- An admin may replace its own school's settings. The row is deleted first
  -- because the table is a singleton per school, and the counts in between are
  -- the point: under RLS a write that the policy refuses is not an error, it
  -- simply affects nothing, so "no exception" proves nothing on its own.
  DELETE FROM "LunchSettings" WHERE "schoolId" = app.current_school_id();
  SELECT count(*) INTO n FROM "LunchSettings";
  IF n <> 0 THEN
    RAISE EXCEPTION
      'lunch-settings: admin DELETE was silently filtered by policy, % row(s) remain', n;
  END IF;

  INSERT INTO "LunchSettings"
    ("schoolId", "lunchEnabled", "lunchStartTime", "lunchEndTime", "lunchMinutes", "diningSeats", "updatedAt")
  VALUES (app.current_school_id(), true, '11:00', '12:30', 30, 120, now());
  SELECT count(*) INTO n FROM "LunchSettings";
  IF n <> 1 THEN
    RAISE EXCEPTION 'lunch-settings: admin INSERT did not land, % row(s) visible', n;
  END IF;
END
$$;
ROLLBACK;

-- Settings for a school that is not the caller's are refused by the policy
-- itself. The handler names insufficient_privilege rather than catching
-- everything, so a passing run cannot be explained away by the foreign key
-- rejecting an id that happens not to exist.
BEGIN;
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'admin_auth_id')::text,
  true
);

DO $$
BEGIN
  INSERT INTO "LunchSettings"
    ("schoolId", "lunchStartTime", "lunchEndTime", "lunchMinutes", "updatedAt")
  VALUES (gen_random_uuid(), '11:00', '12:30', 30, now());
  RAISE EXCEPTION
    'lunch-settings: an admin wrote settings for a school that is not theirs';
EXCEPTION
  WHEN insufficient_privilege THEN NULL;
END
$$;
ROLLBACK;

-- The SS12000 service principal has no lunch-settings policy and must see
-- nothing. Claims are reset to '{}' for the reason given in section 5.
BEGIN;
SELECT set_config('request.jwt.claims', '{}', true);
SELECT set_config('app.service_school_id', :'school_a', true);

DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "LunchSettings";
  IF n <> 0 THEN
    RAISE EXCEPTION
      'lunch-settings: the integration principal sees % row(s); it is granted none', n;
  END IF;
END
$$;
COMMIT;

-- ---------------------------------------------------------------------------
-- 7. A teacher may lock their own time, and nothing else.
--
-- `availability_teacher_modify` exists so a teacher can record "jag är ledig
-- på fredagar" without an admin. The only thing it ever checked about the
-- row's shape was `userId`, and this table has never enforced that
-- `resourceType` agrees with which id column is populated — so the moment
-- GRADE_LEVEL existed, a teacher could insert a school-wide "håll åk 7 fria på
-- tisdagar" lock and stamp their own `userId` on it to get past the policy.
-- An admin-only decision, reached from a teacher's session.
--
-- Two CHECK constraints and a narrowed policy close it. The negative half is
-- the kind that reopens quietly during a refactor, so it is asserted here
-- rather than trusted.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'admin_auth_id')::text,
  true
);

-- The admin principal above is used for one thing only: looking the teacher
-- up. With no principal this role sees no users at all, and the runner passes
-- in an admin's authId, not a teacher's.
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',
    (SELECT "authId" FROM "Users"
      WHERE "schoolId" = app.current_school_id() AND role = 'TEACHER'
      ORDER BY "authId" LIMIT 1)
  )::text,
  true
);

DO $$
DECLARE me uuid := app.current_user_id(); n bigint;
BEGIN
  IF me IS NULL OR app.current_user_role() <> 'TEACHER' THEN
    RAISE EXCEPTION
      'teacher-locks: expected to be acting as a TEACHER of school A, am % (%)',
      app.current_user_role(), me;
  END IF;

  -- The legitimate case still works — this section must not pass by having
  -- locked teachers out of the table altogether.
  INSERT INTO "AvailabilityConstraints"
    ("schoolId", "resourceType", "userId", "dayOfWeek", "startTime", "endTime", "type", "updatedAt")
  VALUES (app.current_school_id(), 'TEACHER', me, 5, '13:00', '16:00', 'UNAVAILABLE', now());
  SELECT count(*) INTO n FROM "AvailabilityConstraints"
   WHERE "userId" = me AND "dayOfWeek" = 5 AND "startTime" = '13:00';
  IF n <> 1 THEN
    RAISE EXCEPTION
      'teacher-locks: a teacher can no longer record their own unavailability (% row(s))', n;
  END IF;

  -- The escalation, with the teacher's own id stamped on it so the policy's
  -- userId test passes. Either the shape CHECK or the narrowed policy may be
  -- the one that refuses; both are correct answers, and neither is silence.
  BEGIN
    INSERT INTO "AvailabilityConstraints"
      ("schoolId", "resourceType", "userId", "minGradeLevel", "maxGradeLevel",
       "dayOfWeek", "startTime", "endTime", "type", "updatedAt")
    VALUES (app.current_school_id(), 'GRADE_LEVEL', me, 7, 7, 2, '10:00', '12:00', 'UNAVAILABLE', now());
    RAISE EXCEPTION
      'teacher-locks: a teacher authored a school-wide årskurs lock by stamping their own userId on it';
  EXCEPTION
    WHEN check_violation OR insufficient_privilege THEN NULL;
  END;

  -- And the honestly-shaped årskurs row, where only the policy can stop it.
  BEGIN
    INSERT INTO "AvailabilityConstraints"
      ("schoolId", "resourceType", "minGradeLevel", "maxGradeLevel",
       "dayOfWeek", "startTime", "endTime", "type", "updatedAt")
    VALUES (app.current_school_id(), 'GRADE_LEVEL', 7, 7, 2, '10:00', '12:00', 'UNAVAILABLE', now());
    RAISE EXCEPTION
      'teacher-locks: availability_teacher_modify accepted a GRADE_LEVEL row';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  -- USING, not only WITH CHECK: the school's own årskurs lock is readable by a
  -- teacher (the timetable views need it) and must not be deletable by one.
  DELETE FROM "AvailabilityConstraints" WHERE "resourceType" = 'GRADE_LEVEL';
  SELECT count(*) INTO n FROM "AvailabilityConstraints"
   WHERE "resourceType" = 'GRADE_LEVEL';
  IF n <> 1 THEN
    RAISE EXCEPTION
      'teacher-locks: a teacher deleted the school''s årskurs lock (% row(s) left, expected the seeded 1)', n;
  END IF;
END
$$;
ROLLBACK;

SELECT 'rls-policies: all assertions passed' AS result;
