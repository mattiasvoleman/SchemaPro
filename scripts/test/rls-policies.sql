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

-- ---------------------------------------------------------------------------
-- 7b. FrameTimes: everyone in the school reads them, only an admin writes.
--
-- The catalog sweep at the end proves the switch is on and a policy exists. It
-- cannot prove the policy is the right one, and the two ways this pair goes
-- wrong are both silent. A missing member SELECT leaves a teacher's grid
-- stopping at 15:00 with nothing readable to explain why. A member-writable
-- table lets any teacher move the whole stage's day — the same escalation
-- section 7 closed for årskurs locks, and the shape here is closer, because a
-- frame carries no userId to hang a "their own row" policy on at all.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'admin_auth_id')::text,
  true
);

DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() <> 'SCHOOL_ADMIN' THEN
    RAISE EXCEPTION 'frame-times: expected to be acting as an admin, am %',
      app.current_user_role();
  END IF;

  INSERT INTO "FrameTimes"
    ("schoolId", "minGradeLevel", "maxGradeLevel", "dayOfWeek",
     "startTime", "endTime", "updatedAt")
  VALUES (app.current_school_id(), 4, 6, 1, '08:00', '15:00', now());

  SELECT count(*) INTO n FROM "FrameTimes";
  IF n <> 1 THEN
    RAISE EXCEPTION 'frame-times: an admin cannot write their own school''s ramtid (% row(s))', n;
  END IF;

  -- A row stamped with a school that is not this one. The id is a literal
  -- because psql does not substitute :variables inside a DO block, and it does
  -- not need to be a real school: WITH CHECK and the foreign key are both
  -- correct ways to refuse this, and neither of them is silence. What matters
  -- is that nothing lands, which the count below asserts rather than trusting
  -- whichever of the two answered.
  BEGIN
    INSERT INTO "FrameTimes"
      ("schoolId", "minGradeLevel", "maxGradeLevel", "dayOfWeek",
       "startTime", "endTime", "updatedAt")
    VALUES ('00000000-0000-4000-8000-0000000000ff', 4, 6, 2, '08:00', '15:00', now());
    RAISE EXCEPTION 'frame-times: an admin wrote a ramtid into another school';
  EXCEPTION
    WHEN insufficient_privilege OR foreign_key_violation THEN NULL;
  END;

  SELECT count(*) INTO n FROM "FrameTimes"
   WHERE "schoolId" <> app.current_school_id();
  IF n <> 0 THEN
    RAISE EXCEPTION 'frame-times: an admin wrote a ramtid into another school (% row(s))', n;
  END IF;
END
$$;

-- Now the same table as a teacher of this school. The admin's row is still in
-- the open transaction, so there is something real to read and to fail to
-- delete.
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
DECLARE n bigint;
BEGIN
  IF app.current_user_role() <> 'TEACHER' THEN
    RAISE EXCEPTION 'frame-times: expected to be acting as a teacher, am %',
      app.current_user_role();
  END IF;

  SELECT count(*) INTO n FROM "FrameTimes";
  IF n <> 1 THEN
    RAISE EXCEPTION
      'frame-times: a teacher cannot read the ramtid that ends their day (% row(s))', n;
  END IF;

  BEGIN
    INSERT INTO "FrameTimes"
      ("schoolId", "minGradeLevel", "maxGradeLevel", "dayOfWeek",
       "startTime", "endTime", "updatedAt")
    VALUES (app.current_school_id(), 7, 9, 3, '08:00', '12:00', now());
    RAISE EXCEPTION 'frame-times: a teacher wrote a ramtid for a whole stage';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  -- USING, not only WITH CHECK. Readable and not deletable is the whole shape.
  DELETE FROM "FrameTimes";
  SELECT count(*) INTO n FROM "FrameTimes";
  IF n <> 1 THEN
    RAISE EXCEPTION
      'frame-times: a teacher deleted the school''s ramtid (% row(s) left)', n;
  END IF;
END
$$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- 7c. LunchServings: read by everyone, written by the administrator alone.
--
-- Same pair and the same two silent failures as the frames above. A sitting a
-- teacher can rewrite is the whole school's lunch flow rewritten from one
-- session, and a sitting nobody can read leaves a pupil unable to find out when
-- their own class eats.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'admin_auth_id')::text,
  true
);

DO $$
DECLARE n bigint;
BEGIN
  INSERT INTO "LunchServings"
    ("schoolId", "minGradeLevel", "maxGradeLevel", "dayOfWeek",
     "startTime", "endTime", "updatedAt")
  VALUES (app.current_school_id(), 4, 6, NULL, '11:40', '12:20', now());

  SELECT count(*) INTO n FROM "LunchServings";
  IF n <> 1 THEN
    RAISE EXCEPTION 'lunch-servings: an admin cannot write their own school''s sitting (% row(s))', n;
  END IF;

  BEGIN
    INSERT INTO "LunchServings"
      ("schoolId", "minGradeLevel", "maxGradeLevel", "dayOfWeek",
       "startTime", "endTime", "updatedAt")
    VALUES ('00000000-0000-4000-8000-0000000000ff', 4, 6, NULL, '11:40', '12:20', now());
    RAISE EXCEPTION 'lunch-servings: an admin wrote a sitting into another school';
  EXCEPTION
    WHEN insufficient_privilege OR foreign_key_violation THEN NULL;
  END;
END
$$;

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
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "LunchServings";
  IF n <> 1 THEN
    RAISE EXCEPTION
      'lunch-servings: a teacher cannot read when their own class eats (% row(s))', n;
  END IF;

  BEGIN
    INSERT INTO "LunchServings"
      ("schoolId", "minGradeLevel", "maxGradeLevel", "dayOfWeek",
       "startTime", "endTime", "updatedAt")
    VALUES (app.current_school_id(), 7, 9, NULL, '12:20', '13:00', now());
    RAISE EXCEPTION 'lunch-servings: a teacher rewrote the school''s lunch flow';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  DELETE FROM "LunchServings";
  SELECT count(*) INTO n FROM "LunchServings";
  IF n <> 1 THEN
    RAISE EXCEPTION 'lunch-servings: a teacher deleted a sitting (% row(s) left)', n;
  END IF;
END
$$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 8: a guardian link cannot reach across schools.
--
-- This was a live cross-tenant hole, reproduced end to end before it was fixed:
-- the write policy checked only that the ROW carried the admin's own schoolId,
-- and nothing tied the named pupil to that school. The forged link then
-- unlocked another school's child — profile, absence notes carrying health
-- information, leave reasons, group memberships and timetable — through six
-- policies that trusted the link without asking whose it was.
--
-- The fix is a pair of composite foreign keys rather than a policy predicate,
-- because a policy that reads Users recurses (Users' own guardian policy reads
-- GuardianStudents right back, and Postgres refuses the cycle) and because keys
-- bind every writer, not only `authenticated`.
-- ---------------------------------------------------------------------------

BEGIN;

SET LOCAL ROLE app_authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', :'admin_auth_id')::text, true);
-- psql does not expand :variables inside a dollar-quoted block, so the pupil's
-- id is handed to the block through a setting instead of pasted into it.
SELECT set_config('app.test_student_b', :'student_b', true);

DO $$
DECLARE
  forged boolean := false;
BEGIN
  BEGIN
    INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId")
    VALUES ((select app.current_school_id()), (select app.current_user_id()),
            current_setting('app.test_student_b')::uuid);
    forged := true;
  EXCEPTION
    WHEN foreign_key_violation THEN forged := false;
    WHEN insufficient_privilege THEN forged := false;
  END;

  IF forged THEN
    RAISE EXCEPTION
      'cross-tenant guardian link accepted: another school''s pupil can be filed as this admin''s child';
  END IF;
END $$;

ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 9: deactivation actually takes access away — and only from the
-- person who was deactivated.
--
-- Deactivating someone writes `Users."isActive" = false` and nothing else, and
-- the four identity helpers under every policy in this schema used to ignore
-- that column. Web and mobile read Supabase directly, so the account kept the
-- role and the tenant it had a moment earlier: a deactivated SCHOOL_ADMIN
-- still read the whole school, still wrote to it, and could set their own
-- `isActive` back to true through `users_admin_all`. The helpers now require
-- `isActive`, which resolves such a caller to NULL on all four and makes every
-- policy predicate NULL — never true.
--
-- The trap in that change is over-correction. The helpers resolve the CALLER,
-- never the row under test, so an ACTIVE admin must still see a deactivated
-- colleague and must still be able to switch them back on — otherwise
-- deactivation is a one-way door and the fix is worse than the hole. Both
-- halves are asserted here, and the round trip between them, because a
-- plausible wrong fix (putting `isActive` in the Users policies instead of the
-- helpers) passes the first half and quietly fails the second.
--
-- Acts as the deactivated admin the fixtures plant in school A. Their ids come
-- in with -v: an inactive principal cannot look up anything, itself included.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'inactive_auth_id', 'role', 'authenticated')::text,
  true
);
-- psql does not expand :variables inside a dollar-quoted block, so the ids the
-- assertions need are handed to the blocks through settings instead.
SELECT set_config('app.test_school_a', :'school_a', true);
SELECT set_config('app.test_inactive_user_id', :'inactive_user_id', true);

DO $$
DECLARE t record; n bigint; checked int := 0;
BEGIN
  IF app.current_user_id() IS NOT NULL OR app.current_school_id() IS NOT NULL
     OR app.current_user_role() IS NOT NULL OR app.current_user_group_id() IS NOT NULL THEN
    RAISE EXCEPTION
      'inactive: a deactivated admin still resolves to a principal (user %, school %, role %, group %)',
      app.current_user_id(), app.current_school_id(),
      app.current_user_role(), app.current_user_group_id();
  END IF;

  -- Every table rather than a chosen few: "sees nothing" is only worth
  -- asserting if nothing is what it means, and a table added later must not be
  -- able to opt out of it by being forgotten here. `_prisma_migrations` is
  -- Prisma's own schema history — no tenant data, no RLS — and is the single
  -- exclusion.
  FOR t IN
    SELECT c.oid, c.relname
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND c.relname <> '_prisma_migrations'
       AND has_table_privilege(c.oid, 'SELECT')
     ORDER BY c.relname
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', t.relname) INTO n;
    IF n <> 0 THEN
      RAISE EXCEPTION
        'inactive: a deactivated admin reads % row(s) of "%"', n, t.relname;
    END IF;
    checked := checked + 1;
  END LOOP;

  -- The schema has 30 such tables today. The floor only has to be high enough
  -- that a catalog query which quietly stopped matching anything cannot pass
  -- for a clean run.
  IF checked < 25 THEN
    RAISE EXCEPTION
      'inactive: only % table(s) were checked; the catalog query proved nothing', checked;
  END IF;
END
$$;

-- Reads are the half that is easy to notice. Writes are the half that lets a
-- deactivated admin undo their own deactivation, so both are asserted. The
-- school id is pasted in from outside because they can no longer resolve it.
DO $$
DECLARE n bigint;
BEGIN
  BEGIN
    INSERT INTO "Rooms" ("schoolId", "name", "updatedAt")
    VALUES (current_setting('app.test_school_a')::uuid, 'RLS-inaktiv-sal', now());
    RAISE EXCEPTION
      'inactive: a deactivated admin created a room in the school they were removed from';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  -- The escalation itself: switching yourself back on. A policy that refuses
  -- an UPDATE does not raise, it simply matches no row, so the row count is
  -- the assertion.
  UPDATE "Users" SET "isActive" = true, "updatedAt" = now()
   WHERE "id" = current_setting('app.test_inactive_user_id')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION
      'inactive: a deactivated admin reactivated themselves (% row(s) updated)', n;
  END IF;
END
$$;
ROLLBACK;

-- The other half: an ACTIVE admin of the same school still sees the
-- deactivated colleague and can still put them back. This is the only way back
-- for a locked-out account, so it is asserted rather than assumed.
BEGIN;
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'admin_auth_id', 'role', 'authenticated')::text,
  true
);
SELECT set_config('app.test_inactive_auth_id', :'inactive_auth_id', true);
SELECT set_config('app.test_inactive_user_id', :'inactive_user_id', true);

DO $$
DECLARE
  target  uuid := current_setting('app.test_inactive_user_id')::uuid;
  t       record;
  n       bigint;
  visible int := 0;
BEGIN
  -- IS DISTINCT FROM, not <>: an over-strict helper resolves the role to NULL,
  -- and `NULL <> 'SCHOOL_ADMIN'` is NULL, so a plain <> would wave it through.
  -- That is the same NULL semantics the fix relies on, pointed the other way.
  IF app.current_user_role() IS DISTINCT FROM 'SCHOOL_ADMIN' THEN
    RAISE EXCEPTION
      'reactivation: expected to act as an ACTIVE admin of school A, resolved role %',
      coalesce(app.current_user_role()::text, '<none>');
  END IF;

  -- Counts the tables this admin can actually read something from. Without it,
  -- the "0 rows everywhere" loop above could pass on an empty database and
  -- prove nothing at all. A seeded database gives 12; the floor is set well
  -- below that so a seed that grows or shrinks a little does not fail CI for
  -- an unrelated reason.
  FOR t IN
    SELECT c.oid, c.relname
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND c.relname <> '_prisma_migrations'
       AND has_table_privilege(c.oid, 'SELECT')
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', t.relname) INTO n;
    IF n > 0 THEN visible := visible + 1; END IF;
  END LOOP;

  IF visible < 8 THEN
    RAISE EXCEPTION
      'reactivation: an active admin sees rows in only % table(s); the lockout assertion above is vacuous',
      visible;
  END IF;

  -- Former staff stay listed. `users_staff_select` and `users_admin_all` ask
  -- about the caller, never about the target's isActive, and that is exactly
  -- what keeps the admin screen able to show a deactivated person at all.
  SELECT count(*) INTO n FROM "Users" WHERE "id" = target;
  IF n <> 1 THEN
    RAISE EXCEPTION
      'reactivation: an active admin sees % row(s) for the deactivated colleague, expected 1', n;
  END IF;

  -- That the colleague is genuinely deactivated at this point is guaranteed
  -- twice over — the runner refuses to start unless the fixture row is
  -- inactive, and the block above raises if a deactivated principal resolves
  -- at all — so it is not re-checked here.

  -- A USING clause that hid the row would leave the row count at 0; a WITH
  -- CHECK clause that refused the new value raises instead. Both are ways for
  -- reactivation to stop working, so both are named here rather than left to
  -- surface as a bare "new row violates row-level security policy".
  BEGIN
    UPDATE "Users" SET "isActive" = true, "updatedAt" = now() WHERE "id" = target;
    GET DIAGNOSTICS n = ROW_COUNT;
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE EXCEPTION
        'reactivation: an admin''s reactivation was refused by a WITH CHECK clause';
  END;

  IF n <> 1 THEN
    RAISE EXCEPTION
      'reactivation: an admin''s reactivation was filtered by policy (% row(s) updated)', n;
  END IF;

  -- And the round trip closes: the same account, reactivated in this very
  -- transaction, resolves to a principal again. Deactivation is a door, not a
  -- wall.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', current_setting('app.test_inactive_auth_id'),
                      'role', 'authenticated')::text, true);

  IF app.current_user_id() IS DISTINCT FROM target
     OR app.current_user_role() IS DISTINCT FROM 'SCHOOL_ADMIN' THEN
    RAISE EXCEPTION
      'reactivation: the reactivated admin still resolves to nothing (user %, role %)',
      coalesce(app.current_user_id()::text, '<none>'),
      coalesce(app.current_user_role()::text, '<none>');
  END IF;

  SELECT count(*) INTO n FROM "Schools";
  IF n <> 1 THEN
    RAISE EXCEPTION
      'reactivation: the reactivated admin sees % school(s), expected their own', n;
  END IF;
END
$$;
ROLLBACK;

SELECT 'rls-policies: all assertions passed' AS result;


-- ---------------------------------------------------------------------------
-- Section 9: no read policy answers "is this row mine?" without also asking
-- "is this row my school's?".
--
-- Nine SELECT policies keyed on the caller's group or membership and never on
-- the row's schoolId. On its own that is only theoretical — but the create
-- endpoints for teaching requirements and master lessons copy studentGroupId
-- straight from the request without checking whose it is, and PostgreSQL runs
-- foreign-key checks as the referenced table's OWNER with row security off, so
-- an FK pointing at a row the caller cannot even SELECT still validates. An
-- admin of one school could therefore write a row carrying their own schoolId
-- and another school's group, and that school's pupils saw it in their
-- timetable while their own admin could neither see nor delete it.
--
-- Asserted over the catalog rather than with fixture rows on purpose. The
-- defect was not one wrong policy; it was a shape that nine policies shared and
-- that the next one written the same way would share too. A catalog check
-- fails on the tenth before anybody plants anything.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(tablename || '.' || policyname, ', ' ORDER BY tablename, policyname)
    INTO offenders
  FROM pg_policies
  WHERE schemaname = 'public'
    AND (
      qual LIKE '%current_user_group_id%'
      OR qual LIKE '%StudentGroupMembers%'
      OR qual LIKE '%CalendarLessonStudents%'
    )
    AND qual NOT LIKE '%current_school_id%'
    -- StudentGroupMembers' own policies are the exception the rule needs: the
    -- table IS the membership, so a policy over it that asked the caller's
    -- school would be asking about itself. They carry schoolId predicates of
    -- their own where they need them.
    AND tablename <> 'StudentGroupMembers';

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'read policies that never ask which school the row belongs to: %', offenders;
  END IF;
END $$;


-- ---------------------------------------------------------------------------
-- Section 10: a lesson row's school is the school of everything the row names,
-- and a key is what says so.
--
-- The other half of the defect Section 9 guards. Both create endpoints copy
-- their reference ids out of the request — teaching requirements check none of
-- the five, master lessons check only the academic year — and `schoolId` comes
-- from the principal, so the row passes its own WITH CHECK. PostgreSQL runs
-- referential-integrity checks as the referenced table's OWNER with row
-- security off, which is why RLS cannot be the thing that stops this: a
-- foreign key pointing at a row the caller cannot even SELECT still validates.
--
-- Asserted over the catalog, like Section 9 and for the same reason. The next
-- reference column added to one of these tables is the one that would slip
-- through, and it will not be added by anyone thinking about tenancy.
--
-- Scoped to the four tables 20260822130000 pinned. The rest of the schema
-- still references school-owned rows by id alone; that is known, and widening
-- this list is what closing each of those looks like.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(child.relname || '.' || c.conname, ', ' ORDER BY child.relname, c.conname)
    INTO offenders
  FROM pg_constraint c
  JOIN pg_class child  ON child.oid  = c.conrelid
  JOIN pg_class parent ON parent.oid = c.confrelid
  WHERE c.contype = 'f'
    AND child.relname IN ('TeachingRequirements', 'MasterLessons',
                          'MasterLessonGroups', 'MasterLessonStudents')
    -- Only references to school-owned rows can cross a tenant boundary.
    -- "Schools" itself has no schoolId and is excluded by this test.
    AND EXISTS (
      SELECT 1 FROM pg_attribute a
       WHERE a.attrelid = parent.oid AND a.attname = 'schoolId' AND NOT a.attisdropped
    )
    -- The two links to the lesson itself are deliberately plain: the child
    -- row's school is already pinned to its group's or its pupil's by the key
    -- beside it, and nothing reads a lesson through those links without asking
    -- the lesson's own schoolId first.
    AND parent.relname <> 'MasterLessons'
    AND NOT EXISTS (
      SELECT 1 FROM unnest(c.conkey) AS k
      JOIN pg_attribute a ON a.attrelid = child.oid AND a.attnum = k
      WHERE a.attname = 'schoolId'
    );

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'lesson references that never say which school they belong to: %', offenders;
  END IF;
END $$;

-- The squatting half, which the composite keys close as a side effect and
-- which this asserts on its own so it stays closed if one is ever relaxed.
-- TeachingRequirements' unique key was (academicYearId, studentGroupId,
-- subjectId) with no school in it: one school's forged row took the slot for
-- another school's real combination, and that school's admin then got a 409
-- creating their own while seeing no row anywhere that explained it.
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(i.relname, ', ' ORDER BY i.relname)
    INTO offenders
  FROM pg_index x
  JOIN pg_class t ON t.oid = x.indrelid
  JOIN pg_class i ON i.oid = x.indexrelid
  WHERE t.relname = 'TeachingRequirements'
    AND x.indisunique
    AND NOT x.indisprimary
    AND NOT EXISTS (
      SELECT 1 FROM unnest(x.indkey::smallint[]) AS k
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k
      WHERE a.attname = 'schoolId'
    );

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'unique keys on TeachingRequirements that one school can fill for another: %', offenders;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Section 11: the same rule, exercised rather than read off the catalog.
--
-- Three writes that reached into another tenant before 20260822130000, each
-- paired with the ordinary writes it must not have cost. The legitimate half
-- is asserted in the same breath on purpose: a probe that only shows the
-- forged write failing passes just as well when the fixture is empty or the
-- principal resolved to nobody — and an over-strict key (MATCH FULL) refuses
-- every unassigned requirement in the product while still passing Section 10.
-- ---------------------------------------------------------------------------

BEGIN;

SELECT set_config('request.jwt.claims',
  json_build_object('sub', :'admin_auth_id', 'role', 'authenticated')::text, true);
-- The pupil of the OTHER school. An attacker knowing a uuid from another
-- tenant is the finding's stated precondition; this role could never read it.
SELECT set_config('app.test_student_b', :'student_b', true);

DO $$
DECLARE
  own_year    uuid;
  own_group   uuid;
  own_subject uuid;
  free_subjects uuid[];
  own_teacher uuid;
  own_room    uuid;
  own_student uuid;
  student_b   uuid := current_setting('app.test_student_b')::uuid;
  lesson      uuid;
  n           bigint;
  accepted    boolean;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'SCHOOL_ADMIN' THEN
    RAISE EXCEPTION
      'lesson-references: expected to act as an admin of school A, resolved role %',
      coalesce(app.current_user_role()::text, '<none>');
  END IF;

  -- The forged id must genuinely be out of reach, or every refusal below could
  -- be explained by the row simply not existing.
  SELECT count(*) INTO n FROM "Users" WHERE id = student_b;
  IF n <> 0 THEN
    RAISE EXCEPTION
      'lesson-references: the other school''s pupil is visible to this admin; the probe proves nothing';
  END IF;

  SELECT id INTO own_teacher FROM "Users" WHERE role = 'TEACHER' LIMIT 1;
  SELECT id INTO own_student FROM "Users" WHERE role = 'STUDENT' LIMIT 1;
  SELECT id INTO own_room    FROM "Rooms" LIMIT 1;
  -- The group with the most (year, group, subject) slots the seeded curriculum
  -- has not taken, so neither legitimate create below can fail as a 409 and be
  -- mistaken for the key doing its job. Two slots are needed: one for the
  -- assigned requirement, one for the unassigned one.
  SELECT y.id, g.id INTO own_year, own_group
    FROM "AcademicYears" y
    JOIN "StudentGroups" g ON g."academicYearId" = y.id
   ORDER BY (
     SELECT count(*) FROM "Subjects" s
      WHERE NOT EXISTS (
        SELECT 1 FROM "TeachingRequirements" t
         WHERE t."academicYearId" = y.id AND t."studentGroupId" = g.id AND t."subjectId" = s.id
      )
   ) DESC
   LIMIT 1;
  SELECT array_agg(s.id) INTO free_subjects
    FROM "Subjects" s
   WHERE NOT EXISTS (
     SELECT 1 FROM "TeachingRequirements" t
      WHERE t."academicYearId" = own_year AND t."studentGroupId" = own_group
        AND t."subjectId" = s.id
   );

  IF own_teacher IS NULL OR own_student IS NULL OR own_room IS NULL
     OR own_year IS NULL OR coalesce(array_length(free_subjects, 1), 0) < 2 THEN
    RAISE EXCEPTION
      'lesson-references: school A is missing fixtures (teacher %, pupil %, room %, free slots %)',
      own_teacher, own_student, own_room, coalesce(array_length(free_subjects, 1), 0);
  END IF;
  own_subject := free_subjects[1];

  -- 1. The requirement naming the other school's pupil as its teacher, and
  --    then the legitimate one into the very same slot. That order matters:
  --    the second insert would collide with the first on the unique key if the
  --    first had been accepted, so "refused" and "left nothing behind" are the
  --    same assertion.
  accepted := true;
  BEGIN
    INSERT INTO "TeachingRequirements"
      ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "updatedAt")
    VALUES ((select app.current_school_id()), own_year, own_subject, own_group, student_b, now());
  EXCEPTION WHEN foreign_key_violation THEN accepted := false;
  END;
  IF accepted THEN
    RAISE EXCEPTION
      'lesson-references: a teaching requirement accepted another school''s user as its teacher';
  END IF;

  INSERT INTO "TeachingRequirements"
    ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "updatedAt")
  VALUES ((select app.current_school_id()), own_year, own_subject, own_group, own_teacher, now());
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'lesson-references: a school''s own teaching requirement was refused';
  END IF;

  -- And a requirement with nobody teaching it yet, which is the normal state of
  -- a curriculum being planned. `teacherId` is nullable and `schoolId` is not,
  -- so the default MATCH SIMPLE skips the check entirely for this row; MATCH
  -- FULL — the plausible wrong way to write these keys — would refuse every
  -- unassigned requirement in the product.
  BEGIN
    INSERT INTO "TeachingRequirements"
      ("schoolId", "academicYearId", "subjectId", "studentGroupId", "updatedAt")
    VALUES ((select app.current_school_id()), own_year, free_subjects[2], own_group, now());
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE EXCEPTION
      'lesson-references: a requirement with no teacher was refused (%); the key is MATCH FULL',
      SQLERRM;
  END;

  -- 2. The same pair for the master timetable.
  INSERT INTO "MasterLessons"
    ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "roomId",
     "dayOfWeek", "startTime", "endTime", "updatedAt")
  VALUES ((select app.current_school_id()), own_year, own_subject, own_group, own_teacher,
          own_room, 7, '08:00', '09:00', now())
  RETURNING id INTO lesson;
  IF lesson IS NULL THEN
    RAISE EXCEPTION 'lesson-references: a school''s own master lesson was refused';
  END IF;

  BEGIN
    INSERT INTO "MasterLessons"
      ("schoolId", "academicYearId", "subjectId", "studentGroupId",
       "dayOfWeek", "startTime", "endTime", "updatedAt")
    VALUES ((select app.current_school_id()), own_year, own_subject, own_group,
            7, '10:00', '11:00', now());
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE EXCEPTION
      'lesson-references: a lesson with no teacher and no room was refused (%); the keys are MATCH FULL',
      SQLERRM;
  END;

  accepted := true;
  BEGIN
    INSERT INTO "MasterLessons"
      ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId",
       "dayOfWeek", "startTime", "endTime", "updatedAt")
    VALUES ((select app.current_school_id()), own_year, own_subject, own_group, student_b,
            7, '09:00', '10:00', now());
  EXCEPTION WHEN foreign_key_violation THEN accepted := false;
  END;
  IF accepted THEN
    RAISE EXCEPTION
      'lesson-references: a master lesson accepted another school''s user as its teacher';
  END IF;

  -- 3. And the participant rows, which are the ones a pupil's own read policy
  --    trusts: master_lesson_students_self_select asks only "is this about
  --    me?", so only this key makes a row that answers yes a row from the
  --    pupil's own school.
  INSERT INTO "MasterLessonStudents" ("schoolId", "masterLessonId", "studentId")
  VALUES ((select app.current_school_id()), lesson, own_student);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'lesson-references: a school''s own pupil was refused as a participant';
  END IF;

  accepted := true;
  BEGIN
    INSERT INTO "MasterLessonStudents" ("schoolId", "masterLessonId", "studentId")
    VALUES ((select app.current_school_id()), lesson, student_b);
  EXCEPTION WHEN foreign_key_violation THEN accepted := false;
  END;
  IF accepted THEN
    RAISE EXCEPTION
      'lesson-references: another school''s pupil was added to this school''s lesson';
  END IF;
END $$;

ROLLBACK;


-- ---------------------------------------------------------------------------
-- Section 10: the constraint the whole authorization layer rests on.
--
-- app.current_user_id, app.current_school_id, app.current_user_role and
-- app.current_user_group_id each resolve one value WHERE "authId" = auth.uid(),
-- and each is declared RETURNS uuid rather than SETOF. With two rows for one
-- authId they do not error and do not warn — they return whichever row the heap
-- hands over first, and the answer flips when unrelated rows are rewritten.
--
-- So the UNIQUE constraint is not hygiene, it is what keeps every session
-- resolving to the school it belongs to. It also does not look load-bearing
-- from the schema, which is why this assertion exists rather than a comment
-- alone: relaxing it is the obvious first step towards one person working in
-- several schools, and doing that without rewriting those four functions in the
-- same migration would silently start resolving sessions to an arbitrary school.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (i.indkey)
    WHERE t.relname = 'Users'
      AND i.indisunique
      AND i.indnatts = 1
      AND a.attname = 'authId'
  ) THEN
    RAISE EXCEPTION
      'Users.authId is no longer uniquely constrained — the four app.current_* '
      'helpers now resolve an arbitrary row, and every session can silently '
      'land in the wrong school';
  END IF;
END $$;


-- ---------------------------------------------------------------------------
-- Section 12: every table is protected at all.
--
-- The narrower catalog check further up asks whether a policy forgets the
-- tenant. This asks the question before that one: is there a policy, and is row
-- security even on.
--
-- A table shipped with neither is not a subtle hole. `app_authenticated` holds
-- table-level GRANTs from the migration that created it, so with RLS off the
-- role reads and writes every school's rows, and nothing anywhere reports it —
-- the API keeps working, the e2e suite mocks Prisma and never sees Postgres,
-- and the table looks exactly like its protected neighbours in the schema.
-- RLS enabled with zero policies fails the other way and is nearly as bad in
-- practice: it denies everything, so the feature is simply dead for every
-- caller, which is at least loud.
--
-- Deliberately without an exception list, unlike a rule about which predicate a
-- policy must carry. That rule needs 26 exemptions here — the service role
-- crosses tenants by design, and a policy keyed on the caller's own id is
-- already inside one school — and a rule with 26 exemptions rots into a list
-- nobody maintains. This one has none, and a new table cannot be added without
-- either satisfying it or changing it on purpose.
--
-- The floor guards the query itself: a catalog filter that quietly stopped
-- matching would otherwise pass as a clean run, which is how a previous
-- assertion in this file managed to prove nothing for a while.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  unprotected text;
  policyless  text;
  checked     int;
BEGIN
  SELECT count(*)::int INTO checked
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations';

  IF checked < 25 THEN
    RAISE EXCEPTION
      'only % table(s) were examined; the catalog query proved nothing', checked;
  END IF;

  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO unprotected
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND c.relname <> '_prisma_migrations'
    AND NOT c.relrowsecurity;

  IF unprotected IS NOT NULL THEN
    RAISE EXCEPTION
      'tables with row security switched off, readable across every school: %',
      unprotected;
  END IF;

  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO policyless
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND c.relname <> '_prisma_migrations'
    AND c.relrowsecurity
    AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid);

  IF policyless IS NOT NULL THEN
    RAISE EXCEPTION
      'tables with row security on and no policy at all — denied to everyone: %',
      policyless;
  END IF;
END $$;
