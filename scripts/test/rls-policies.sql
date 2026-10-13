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
  tbl      text;
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

  -- Every other table the SS12000 feeds and the import read, beyond Schools and
  -- Users above. Until 20260914150000 seven of them had no policy for this
  -- principal, so a lesson's required subject came back missing and both lesson
  -- feeds answered 500 for any school with a lesson, and nothing here counted
  -- them. Both halves count real rows: the fixtures plant rows in each table in
  -- both schools, and the runner refuses to start without the other school's.
  --
  -- The five link tables also hold rows filed under the other school but
  -- attached to this school's lessons. The policies answer by the row's own
  -- school, so those rows belong to the second half; a policy that asked the
  -- lesson's school instead would count them there.
  FOREACH tbl IN ARRAY ARRAY[
    'AcademicYears', 'StudentGroups', 'GuardianStudents',
    'MasterLessons', 'CalendarLessons', 'Subjects', 'Rooms',
    'MasterLessonGroups', 'MasterLessonStudents',
    'CalendarLessonTeachers', 'CalendarLessonGroups', 'CalendarLessonStudents'
  ] LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE "schoolId" = $1', tbl)
      INTO n USING school_a;
    IF n = 0 THEN
      RAISE EXCEPTION
        'service-principal: saw 0 % rows for its own school — SS12000 cannot read them', tbl;
    END IF;

    EXECUTE format('SELECT count(*) FROM %I WHERE "schoolId" <> $1', tbl)
      INTO n USING school_a;
    IF n <> 0 THEN
      RAISE EXCEPTION
        'service-principal: leaked % % rows from other schools', n, tbl;
    END IF;
  END LOOP;

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
-- 4b. A connection a user request has used still serves the next principal.
--
-- Section 4 proves the claims' value ends at COMMIT. The setting does not go
-- back to unset, though: once a transaction on a connection has set
-- request.jwt.claims, current_setting('request.jwt.claims', true) reads ''
-- there instead of NULL. withRls sets claims on every user request and the API
-- pools connections, so the SS12000 principal and the key lookup open their
-- transactions on exactly such connections. The fallback auth.uid() cast that
-- '' to jsonb and raised, and every policy calling app.current_*() raised with
-- it: through the real PrismaService both helpers failed with 22P02 until
-- 20260914230000_en_tom_claimsinstallning_ar_ingen_anvandare. Sections 1-3
-- could not see it, because no section before them sets claims.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'admin_auth_id', 'role', 'authenticated')::text,
  true
);
COMMIT;

-- The state under test, asserted rather than assumed: were the setting NULL
-- here, the blocks below would pass without exercising anything.
DO $$
BEGIN
  IF current_setting('request.jwt.claims', true) IS DISTINCT FROM '' THEN
    RAISE EXCEPTION
      'used-connection: expected request.jwt.claims to read '''' after COMMIT, got %',
      quote_nullable(current_setting('request.jwt.claims', true));
  END IF;
END
$$;

-- Each handler names invalid_text_representation, the 22P02 the cast raised,
-- so the bare JSON error comes out saying which principal broke. The count
-- assertions raise P0001, which the handler does not catch.
BEGIN;
SELECT set_config('app.service_school_id', :'school_a', true);

DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "Schools";
  IF n <> 1 THEN
    RAISE EXCEPTION
      'used-connection: service principal sees % school(s), expected its own one', n;
  END IF;
EXCEPTION WHEN invalid_text_representation THEN
  RAISE EXCEPTION
    'used-connection: service principal raised on a connection that had carried user claims: %',
    SQLERRM;
END
$$;
COMMIT;

BEGIN;
SELECT set_config('app.service_key_lookup', 'on', true);

DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "IntegrationApiKeys";
  IF n = 0 THEN
    RAISE EXCEPTION 'used-connection: key lookup sees no api key';
  END IF;
EXCEPTION WHEN invalid_text_representation THEN
  RAISE EXCEPTION
    'used-connection: key lookup raised on a connection that had carried user claims: %',
    SQLERRM;
END
$$;
COMMIT;

-- And no principal at all is still deny, not an error.
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "Users";
  IF n <> 0 THEN
    RAISE EXCEPTION 'used-connection: no principal sees % user(s), expected 0', n;
  END IF;
EXCEPTION WHEN invalid_text_representation THEN
  RAISE EXCEPTION
    'used-connection: no principal raised instead of seeing nothing: %', SQLERRM;
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
-- Claims are reset to an empty object rather than left alone. A ROLLBACK
-- leaves the setting reading '', which auth.uid() took for malformed JSON
-- until 20260914230000; section 4b asserts that case by itself, so this block
-- stays about the policy. '{}' is the honest encoding of "no user".
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
-- 7d. RoomPreferences: the table that shipped with no assertions at all.
--
-- The comment at the top of section 7b noted this file had none for this table.
-- It mattered less while every row was a WISH the solver could trade away. It
-- matters now: a row can be a LOCK, which forbids a subject's lessons every
-- room but the named ones and refuses the week if that is impossible. A teacher
-- who could write one would be redirecting a whole stage's lessons from their
-- own session; a teacher who could not READ one would meet a refusal with no
-- visible cause.
--
-- The child table is asserted with it. RoomPreferenceRooms carries its own
-- schoolId and its own pair of policies, and a rule whose ROOMS a teacher can
-- rewrite is a rule a teacher can rewrite.
--
-- The read was asserted only from the side that must SEE it. Both
-- `_staff_select` policies carried the tenant predicate and no role, so every
-- pupil and guardian of the school read the rules as well, through Supabase,
-- where the table grant to "authenticated" is the only other gate. A pupil and
-- a guardian are therefore asserted against the very lock the teacher just
-- read, in the same transaction — without that row their zero proves nothing.
-- The fixtures plant a lock in the second school for the same reason, so the
-- tenant half is not asserted against an empty table either.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'admin_auth_id')::text,
  true
);

DO $$
DECLARE me uuid; subject_id uuid; room_id uuid; n bigint;
BEGIN
  SELECT id INTO subject_id FROM "Subjects"
   WHERE "schoolId" = app.current_school_id() LIMIT 1;
  SELECT id INTO room_id FROM "Rooms"
   WHERE "schoolId" = app.current_school_id() LIMIT 1;
  IF subject_id IS NULL OR room_id IS NULL THEN
    RAISE EXCEPTION 'room-rules: the seed has no subject or no room to rule about';
  END IF;

  -- Asked before this school has a rule of its own in the transaction, so a
  -- lost tenant predicate is named as one. Asked after the insert below it
  -- surfaces as the lock count reading 2, which is true and says nothing about
  -- why. What it would find is the lock the fixtures plant in the second
  -- school; the policies, not a WHERE clause, must keep that out.
  SELECT count(*) INTO n FROM "RoomPreferences"
   WHERE "schoolId" <> app.current_school_id();
  IF n <> 0 THEN
    RAISE EXCEPTION
      'room-rules: % rule(s) from another school visible — tenant isolation is not enforced', n;
  END IF;
  SELECT count(*) INTO n FROM "RoomPreferenceRooms"
   WHERE "schoolId" <> app.current_school_id();
  IF n <> 0 THEN
    RAISE EXCEPTION
      'room-rules: % rule room(s) from another school visible — tenant isolation is not enforced', n;
  END IF;

  INSERT INTO "RoomPreferences"
    ("schoolId", "subjectId", "kind", "minGradeLevel", "maxGradeLevel",
     "weight", "updatedAt")
  VALUES (app.current_school_id(), subject_id, 'LOCK', 4, 4, 5, now())
  RETURNING id INTO me;

  INSERT INTO "RoomPreferenceRooms" ("schoolId", "preferenceId", "roomId")
  VALUES (app.current_school_id(), me, room_id);

  SELECT count(*) INTO n FROM "RoomPreferences" WHERE kind = 'LOCK';
  IF n <> 1 THEN
    RAISE EXCEPTION 'room-rules: an admin cannot write a lock (% row(s))', n;
  END IF;

  -- Another school's rule, stamped with an id this one cannot reach. WITH CHECK
  -- and the foreign key are both correct ways to refuse it; what matters is
  -- that nothing lands, which the count below asserts rather than trusting
  -- whichever answered.
  BEGIN
    INSERT INTO "RoomPreferences"
      ("schoolId", "subjectId", "kind", "weight", "updatedAt")
    VALUES ('00000000-0000-4000-8000-0000000000ff', subject_id, 'LOCK', 5, now());
    RAISE EXCEPTION 'room-rules: an admin wrote a rule into another school';
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
DECLARE subject_id uuid; n bigint;
BEGIN
  SELECT id INTO subject_id FROM "Subjects"
   WHERE "schoolId" = app.current_school_id() LIMIT 1;

  -- Readable: a lock is the reason a lesson cannot be moved, and a teacher who
  -- cannot see it meets a refusal with no visible cause.
  SELECT count(*) INTO n FROM "RoomPreferences" WHERE kind = 'LOCK';
  IF n <> 1 THEN
    RAISE EXCEPTION 'room-rules: a teacher cannot read the lock that binds them (% row(s))', n;
  END IF;
  SELECT count(*) INTO n FROM "RoomPreferenceRooms";
  IF n <> 1 THEN
    RAISE EXCEPTION 'room-rules: a teacher cannot read a rule''s rooms (% row(s))', n;
  END IF;

  BEGIN
    INSERT INTO "RoomPreferences"
      ("schoolId", "subjectId", "kind", "weight", "updatedAt")
    VALUES (app.current_school_id(), subject_id, 'LOCK', 5, now());
    RAISE EXCEPTION 'room-rules: a teacher wrote a lock binding a whole stage';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  -- USING, not only WITH CHECK, and on the child too: a rule whose ROOMS a
  -- teacher can delete is a rule a teacher can disarm.
  DELETE FROM "RoomPreferenceRooms";
  SELECT count(*) INTO n FROM "RoomPreferenceRooms";
  IF n <> 1 THEN
    RAISE EXCEPTION 'room-rules: a teacher emptied a lock''s room list (% left)', n;
  END IF;

  DELETE FROM "RoomPreferences";
  SELECT count(*) INTO n FROM "RoomPreferences" WHERE kind = 'LOCK';
  IF n <> 1 THEN
    RAISE EXCEPTION 'room-rules: a teacher deleted a lock (% row(s) left)', n;
  END IF;
END
$$;

-- A pupil of the same school, whom the tenant predicate alone let straight
-- through. Looked up while the teacher is still in force: a teacher reads the
-- school's users and a pupil reads only their own row, so this is the one
-- order in which the lookup is legal (the same reason 7e gives).
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',
    (SELECT "authId" FROM "Users"
      WHERE "schoolId" = app.current_school_id() AND role = 'STUDENT'
      ORDER BY "authId" LIMIT 1)
  )::text,
  true
);

DO $$
DECLARE n bigint;
BEGIN
  -- Without this guard the block passes vacuously: an authId that resolves to
  -- no user has no role, reads nothing, and looks exactly like success.
  IF app.current_user_role() IS DISTINCT FROM 'STUDENT' THEN
    RAISE EXCEPTION
      'room-rules: expected to be acting as a STUDENT of school A, resolved role %',
      coalesce(app.current_user_role()::text, '<none>');
  END IF;

  -- The assertion the tenant-only staff read failed. The teacher above has
  -- just proved the lock and its room are in this transaction to be seen.
  SELECT count(*) INTO n FROM "RoomPreferences";
  IF n <> 0 THEN
    RAISE EXCEPTION
      'room-rules: a pupil reads % rule(s) of their school; the staff read has lost its role check', n;
  END IF;
  SELECT count(*) INTO n FROM "RoomPreferenceRooms";
  IF n <> 0 THEN
    RAISE EXCEPTION
      'room-rules: a pupil reads % rule room(s) of their school; the staff read has lost its role check', n;
  END IF;
END
$$;

-- And a guardian, who has no policy of their own on either table and reached
-- both through the same staff read. The literal authId, because the pupil in
-- force cannot look up anyone else's row.
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-4000-8000-000000000004')::text,
  true
);

DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'GUARDIAN' THEN
    RAISE EXCEPTION
      'room-rules: expected to be acting as a GUARDIAN of school A, resolved role %',
      coalesce(app.current_user_role()::text, '<none>');
  END IF;

  SELECT count(*) INTO n FROM "RoomPreferences";
  IF n <> 0 THEN
    RAISE EXCEPTION
      'room-rules: a guardian reads % rule(s) of the school; the staff read has lost its role check', n;
  END IF;
  SELECT count(*) INTO n FROM "RoomPreferenceRooms";
  IF n <> 0 THEN
    RAISE EXCEPTION
      'room-rules: a guardian reads % rule room(s) of the school; the staff read has lost its role check', n;
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
-- 7e. The meal: a pupil sees their own class's, not the school's.
--
-- LunchSittings and CalendarLunches shipped with one read policy each, both
-- saying `"schoolId" = current_school_id()`, and neither had a line in this
-- file. That is the whole story: the pupil page carries two comments claiming
-- RLS scopes the read the way it scopes lessons, and nothing here contradicted
-- them for as long as they were wrong.
--
-- Four principals, four different answers, and the interesting one is the
-- SECOND PUPIL. Asserting only that a pupil sees their own meal would pass
-- against the school-wide policy this section was written to bury — a pupil
-- sees their own class's row under both. What separates them is the row
-- belonging to the OTHER class, so that is what is counted.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'admin_auth_id')::text,
  true
);

DO $$
DECLARE
  n bigint;
  class_a uuid;
  class_b uuid;
  year_id uuid;
BEGIN
  -- Class A is the guardian fixture's child's class, so the pupil arm and the
  -- guardian arm below are asserted against the SAME meal. Choosing it any
  -- other way couples this section to the order the fixture happened to pick a
  -- child in, and the guardian then reads a class with no row and fails for a
  -- reason that has nothing to do with the policy.
  SELECT u."studentGroupId" INTO class_a
    FROM "GuardianStudents" gs
    JOIN "Users" u ON u.id = gs."studentId"
   WHERE gs."guardianId" = (SELECT id FROM "Users"
                             WHERE "authId" = '00000000-0000-4000-8000-000000000004')
     AND u."studentGroupId" IS NOT NULL
   LIMIT 1;
  SELECT "studentGroupId" INTO class_b
    FROM "Users"
   WHERE "schoolId" = app.current_school_id() AND role = 'STUDENT'
     AND "studentGroupId" IS NOT NULL AND "studentGroupId" IS DISTINCT FROM class_a
   ORDER BY "studentGroupId" LIMIT 1;
  IF class_a IS NULL OR class_b IS NULL THEN
    RAISE EXCEPTION
      'lunch-reads: no guardian child with a home class, or fewer than two classes with pupils; every assertion below would be vacuous';
  END IF;
  SELECT "academicYearId" INTO year_id FROM "StudentGroups" WHERE id = class_a;

  INSERT INTO "LunchSittings"
    ("schoolId", "academicYearId", "studentGroupId", "dayOfWeek",
     "startTime", "endTime", "headcount", "updatedAt")
  VALUES
    (app.current_school_id(), year_id, class_a, 1, '11:40', '12:00', 24, now()),
    (app.current_school_id(), year_id, class_b, 1, '12:00', '12:20', 22, now());

  INSERT INTO "CalendarLunches"
    ("schoolId", "studentGroupId", "date", "startsAt", "endsAt", "updatedAt")
  VALUES
    (app.current_school_id(), class_a, DATE '2026-09-07',
     TIMESTAMPTZ '2026-09-07 11:40+02', TIMESTAMPTZ '2026-09-07 12:00+02', now()),
    (app.current_school_id(), class_b, DATE '2026-09-07',
     TIMESTAMPTZ '2026-09-07 12:00+02', TIMESTAMPTZ '2026-09-07 12:20+02', now());

  SELECT count(*) INTO n FROM "CalendarLunches";
  IF n <> 2 THEN
    RAISE EXCEPTION 'lunch-reads: an admin cannot see the meals they just wrote (% row(s))', n;
  END IF;
END
$$;

-- A teacher sees the whole school's, because /admin/lunch-servings draws the
-- kitchen's waves from every sitting and /admin/timetable draws the bands.
--
-- The order of the four principals below is load-bearing: each set_config
-- resolves the NEXT principal's authId while the CURRENT one is in force, and a
-- pupil cannot read a teacher's row. Admin, teacher, pupil, guardian is the only
-- order in which every lookup is legal.
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
  SELECT count(*) INTO n FROM "CalendarLunches";
  IF n <> 2 THEN
    RAISE EXCEPTION 'lunch-reads: a teacher cannot see the school''s meals (% row(s))', n;
  END IF;
  SELECT count(*) INTO n FROM "LunchSittings";
  IF n <> 2 THEN
    RAISE EXCEPTION 'lunch-reads: a teacher cannot see the school''s sittings (% row(s))', n;
  END IF;

  BEGIN
    DELETE FROM "CalendarLunches";
    IF (SELECT count(*) FROM "CalendarLunches") <> 2 THEN
      RAISE EXCEPTION 'lunch-reads: a teacher deleted a published meal';
    END IF;
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END
$$;
-- A pupil of that class. Sees theirs, and only theirs.
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',
    (SELECT u."authId" FROM "Users" u
      WHERE u."schoolId" = app.current_school_id() AND u.role = 'STUDENT'
        AND u."studentGroupId" = (
          SELECT c."studentGroupId"
            FROM "GuardianStudents" gs
            JOIN "Users" c ON c.id = gs."studentId"
           WHERE gs."guardianId" = (SELECT id FROM "Users"
                                     WHERE "authId" = '00000000-0000-4000-8000-000000000004')
             AND c."studentGroupId" IS NOT NULL
           LIMIT 1)
      ORDER BY u."authId" LIMIT 1)
  )::text,
  true
);

DO $$
DECLARE own bigint; others bigint;
BEGIN
  SELECT count(*) INTO own
    FROM "CalendarLunches" WHERE "studentGroupId" = app.current_user_group_id();
  SELECT count(*) INTO others
    FROM "CalendarLunches" WHERE "studentGroupId" <> app.current_user_group_id();

  IF own <> 1 THEN
    RAISE EXCEPTION 'lunch-reads: a pupil cannot see their own class''s meal (% row(s))', own;
  END IF;
  -- The assertion the school-wide policy failed.
  IF others <> 0 THEN
    RAISE EXCEPTION
      'lunch-reads: a pupil sees another class''s meal (% row(s)) — the read is school-wide again', others;
  END IF;

  SELECT count(*) INTO others
    FROM "LunchSittings" WHERE "studentGroupId" <> app.current_user_group_id();
  IF others <> 0 THEN
    RAISE EXCEPTION
      'lunch-reads: a pupil sees another class''s sitting (% row(s))', others;
  END IF;
END
$$;

-- The guardian of that pupil, joined through the HOME CLASS. Keying this on
-- StudentGroupMembers instead — which is what calendar_lessons_guardian_*
-- does — returns nothing, because nothing writes a membership row for a home
-- class. That is the defect this arm was written to avoid, so it is the one
-- asserted.
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    -- The literal, not a lookup: the principal in force here is the pupil
    -- above, who by design cannot read another user's row — a SELECT would
    -- resolve to null and set no principal at all.
    'sub', '00000000-0000-4000-8000-000000000004'
  )::text,
  true
);

DO $$
DECLARE own bigint; others bigint; child_group uuid;
BEGIN
  SELECT u."studentGroupId" INTO child_group
    FROM "GuardianStudents" gs
    JOIN "Users" u ON u.id = gs."studentId"
   WHERE gs."guardianId" = app.current_user_id()
   LIMIT 1;
  IF child_group IS NULL THEN
    RAISE EXCEPTION
      'lunch-reads: the guardian fixture has no child with a home class; the arm below is vacuous';
  END IF;

  SELECT count(*) INTO own
    FROM "CalendarLunches" WHERE "studentGroupId" = child_group;
  SELECT count(*) INTO others
    FROM "CalendarLunches" WHERE "studentGroupId" <> child_group;

  IF own <> 1 THEN
    RAISE EXCEPTION 'lunch-reads: a guardian cannot see their child''s meal (% row(s))', own;
  END IF;
  IF others <> 0 THEN
    RAISE EXCEPTION 'lunch-reads: a guardian sees another class''s meal (% row(s))', others;
  END IF;
END
$$;

ROLLBACK;

-- ---------------------------------------------------------------------------
-- 7f. The rast: same three arms as the meal, asserted the same way.
--
-- CalendarRasts shipped with a pupil arm, a guardian arm and a staff arm and no
-- line in this file — which is the exact pattern section 7e was written to
-- bury. A table whose policies nothing exercises is a table whose policies are
-- a guess.
--
-- The discriminating assertion is again the OTHER class's row: a pupil sees
-- their own break under a school-wide policy too.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'admin_auth_id')::text,
  true
);

DO $$
DECLARE
  n bigint;
  class_a uuid;
  class_b uuid;
BEGIN
  SELECT u."studentGroupId" INTO class_a
    FROM "GuardianStudents" gs
    JOIN "Users" u ON u.id = gs."studentId"
   WHERE gs."guardianId" = (SELECT id FROM "Users"
                             WHERE "authId" = '00000000-0000-4000-8000-000000000004')
     AND u."studentGroupId" IS NOT NULL
   LIMIT 1;
  SELECT "studentGroupId" INTO class_b
    FROM "Users"
   WHERE "schoolId" = app.current_school_id() AND role = 'STUDENT'
     AND "studentGroupId" IS NOT NULL AND "studentGroupId" IS DISTINCT FROM class_a
   ORDER BY "studentGroupId" LIMIT 1;
  IF class_a IS NULL OR class_b IS NULL THEN
    RAISE EXCEPTION 'rast-reads: fewer than two classes with pupils; the assertions below would be vacuous';
  END IF;

  INSERT INTO "CalendarRasts"
    ("schoolId", "studentGroupId", "name", "date", "startsAt", "endsAt", "updatedAt")
  VALUES
    (app.current_school_id(), class_a, 'Förmiddagsrast', DATE '2026-09-07',
     TIMESTAMPTZ '2026-09-07 09:40+02', TIMESTAMPTZ '2026-09-07 10:00+02', now()),
    (app.current_school_id(), class_b, 'Förmiddagsrast', DATE '2026-09-07',
     TIMESTAMPTZ '2026-09-07 10:00+02', TIMESTAMPTZ '2026-09-07 10:20+02', now());

  SELECT count(*) INTO n FROM "CalendarRasts";
  IF n <> 2 THEN
    RAISE EXCEPTION 'rast-reads: an admin cannot see the rasts they just wrote (% row(s))', n;
  END IF;
END
$$;

-- A teacher sees the whole school's: /teacher narrows to the classes they take,
-- and it can only narrow what it is allowed to read.
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
  SELECT count(*) INTO n FROM "CalendarRasts";
  IF n <> 2 THEN
    RAISE EXCEPTION 'rast-reads: a teacher cannot see the school''s rasts (% row(s))', n;
  END IF;
END
$$;

-- A pupil of the guardian fixture's child's class.
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',
    (SELECT u."authId" FROM "Users" u
      WHERE u."schoolId" = app.current_school_id() AND u.role = 'STUDENT'
        AND u."studentGroupId" = (
          SELECT c."studentGroupId"
            FROM "GuardianStudents" gs
            JOIN "Users" c ON c.id = gs."studentId"
           WHERE gs."guardianId" = (SELECT id FROM "Users"
                                     WHERE "authId" = '00000000-0000-4000-8000-000000000004')
             AND c."studentGroupId" IS NOT NULL
           LIMIT 1)
      ORDER BY u."authId" LIMIT 1)
  )::text,
  true
);

DO $$
DECLARE own bigint; others bigint;
BEGIN
  SELECT count(*) INTO own
    FROM "CalendarRasts" WHERE "studentGroupId" = app.current_user_group_id();
  SELECT count(*) INTO others
    FROM "CalendarRasts" WHERE "studentGroupId" <> app.current_user_group_id();

  IF own <> 1 THEN
    RAISE EXCEPTION 'rast-reads: a pupil cannot see their own class''s rast (% row(s))', own;
  END IF;
  IF others <> 0 THEN
    RAISE EXCEPTION
      'rast-reads: a pupil sees another class''s rast (% row(s)) — the read is school-wide', others;
  END IF;
END
$$;

-- And the guardian, through the home class.
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-4000-8000-000000000004')::text,
  true
);

DO $$
DECLARE own bigint; others bigint; child_group uuid;
BEGIN
  SELECT u."studentGroupId" INTO child_group
    FROM "GuardianStudents" gs
    JOIN "Users" u ON u.id = gs."studentId"
   WHERE gs."guardianId" = app.current_user_id()
   LIMIT 1;

  SELECT count(*) INTO own
    FROM "CalendarRasts" WHERE "studentGroupId" = child_group;
  SELECT count(*) INTO others
    FROM "CalendarRasts" WHERE "studentGroupId" <> child_group;

  IF own <> 1 THEN
    RAISE EXCEPTION 'rast-reads: a guardian cannot see their child''s rast (% row(s))', own;
  END IF;
  IF others <> 0 THEN
    RAISE EXCEPTION 'rast-reads: a guardian sees another class''s rast (% row(s))', others;
  END IF;
END
$$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- 7g. TeacherWorkRules: a teacher owns their own arbetstid and nobody else's.
--
-- Three arms, and the third is why this section is not a copy of 7b. Admin-all
-- and staff-select are the familiar pair. On top of them a TEACHER may read and
-- WRITE their own row — the first write policy since availability_teacher_modify
-- that lets a member author anything at all — and that policy is the one whose
-- failures are silent in both directions.
--
-- Too narrow, and a teacher cannot record the lunch the whole table exists to
-- protect, so the feature is simply dead for everyone but the administrator. Too
-- wide, and a teacher edits a COLLEAGUE'S row: raising somebody else's rest to
-- eleven hours is an admin-only decision that would refuse the school's week by
-- name, reached from a session that has no business making it, and lowering it
-- takes away a protection the colleague was promised. Deleting it is the same
-- escalation once more, which is why USING carries the id test and not only WITH
-- CHECK — the hole section 7 found on AvailabilityConstraints.
--
-- The admin's row is written for a DIFFERENT teacher than the one that acts
-- below, on purpose: @@unique([userId]) means one row per teacher, so a teacher
-- asserting "I can write my own" against a row that is already theirs would be
-- measuring the unique index instead of the policy.
--
-- A pupil and a guardian are asserted against those very rows, in the same
-- transaction, for the reason 7d gives: their zero proves nothing against an
-- empty table. And both are asserted at all because `_staff_select` is the
-- policy shape that twice shipped carrying the tenant predicate and no role
-- check — here it would hand a pupil the name-shaped question "when does my
-- teacher eat".
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'admin_auth_id')::text,
  true
);
-- psql does not expand :variables inside a dollar-quoted block, so the other
-- school's pupil is handed to the block through a setting, as section 8 does.
SELECT set_config('app.test_student_b', :'student_b', true);

DO $$
DECLARE colleague uuid; n bigint;
BEGIN
  IF app.current_user_role() <> 'SCHOOL_ADMIN' THEN
    RAISE EXCEPTION 'work-rules: expected to be acting as an admin, am %',
      app.current_user_role();
  END IF;

  -- The SECOND teacher by authId. The teacher who acts further down is the
  -- first, and the third is the one nobody has a rule for yet — the three are
  -- picked by the same ordering in every block here so they stay distinct.
  SELECT id INTO colleague FROM "Users"
   WHERE "schoolId" = app.current_school_id() AND role = 'TEACHER'
   ORDER BY "authId" OFFSET 1 LIMIT 1;
  IF colleague IS NULL THEN
    RAISE EXCEPTION 'work-rules: the seed has fewer than two teachers to tell apart';
  END IF;

  -- The whole rule, with the trio and the night. An admin manages any teacher's
  -- arbetstid, which is the path a school actually fills the table in by.
  INSERT INTO "TeacherWorkRules"
    ("schoolId", "userId", "lunchMinutes", "lunchStartTime", "lunchEndTime",
     "minDailyRestMinutes", "updatedAt")
  VALUES (app.current_school_id(), colleague, 30, '10:30', '13:30', 660, now());

  SELECT count(*) INTO n FROM "TeacherWorkRules";
  IF n <> 1 THEN
    RAISE EXCEPTION
      'work-rules: an admin cannot write their own school''s arbetstid (% row(s))', n;
  END IF;

  -- Another school's USER, stamped with this school's id — the shape a policy
  -- alone cannot refuse, since the row's schoolId is honestly this admin's. The
  -- composite (userId, schoolId) foreign key is what answers, and it has to:
  -- referential integrity runs as Users' OWNER with row security off, so a
  -- single-column key would validate a teacher this school cannot even SELECT.
  -- The pupil is the one foreign user the runner can hand in; the key knows
  -- nothing about roles, so it is the same assertion a foreign teacher would be.
  BEGIN
    INSERT INTO "TeacherWorkRules"
      ("schoolId", "userId", "minDailyRestMinutes", "updatedAt")
    VALUES (app.current_school_id(), current_setting('app.test_student_b')::uuid,
            660, now());
    RAISE EXCEPTION
      'work-rules: an admin wrote an arbetstid about another school''s user';
  EXCEPTION
    WHEN foreign_key_violation OR insufficient_privilege THEN NULL;
  END;

  -- And a row stamped with a school that is not this one. The id is a literal
  -- because psql does not substitute :variables inside a DO block, and it does
  -- not need to be a real school: WITH CHECK and the foreign key are both
  -- correct ways to refuse this. What matters is that nothing lands.
  BEGIN
    INSERT INTO "TeacherWorkRules"
      ("schoolId", "userId", "minDailyRestMinutes", "updatedAt")
    VALUES ('00000000-0000-4000-8000-0000000000ff', colleague, 660, now());
    RAISE EXCEPTION 'work-rules: an admin wrote an arbetstid into another school';
  EXCEPTION
    WHEN insufficient_privilege OR foreign_key_violation THEN NULL;
  END;

  -- The weaker half of the tenant question, and it is named as weak: the
  -- fixtures plant no rule in the second school, so with nothing over there this
  -- reads zero whatever the policies say. The two refused writes above are what
  -- actually bite. Making this half prove something needs a rule planted in the
  -- other tenant and a runner guard that the planting happened, the way section
  -- 7d's room lock has — both live in files this section does not own.
  SELECT count(*) INTO n FROM "TeacherWorkRules"
   WHERE "schoolId" <> app.current_school_id();
  IF n <> 0 THEN
    RAISE EXCEPTION
      'work-rules: % arbetstid(er) from another school visible — tenant isolation is not enforced', n;
  END IF;
END
$$;

-- Now the same table as a teacher of this school. The admin's row is still in
-- the open transaction, so there is a colleague's rule to read and to fail to
-- rewrite.
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
DECLARE me uuid := app.current_user_id(); colleague uuid; stranger uuid; n bigint;
BEGIN
  IF me IS NULL OR app.current_user_role() <> 'TEACHER' THEN
    RAISE EXCEPTION
      'work-rules: expected to be acting as a TEACHER of school A, am % (%)',
      app.current_user_role(), me;
  END IF;

  SELECT id INTO colleague FROM "Users"
   WHERE "schoolId" = app.current_school_id() AND role = 'TEACHER'
   ORDER BY "authId" OFFSET 1 LIMIT 1;
  SELECT id INTO stranger FROM "Users"
   WHERE "schoolId" = app.current_school_id() AND role = 'TEACHER'
   ORDER BY "authId" OFFSET 2 LIMIT 1;
  IF colleague = me OR stranger IS NULL OR stranger = me THEN
    RAISE EXCEPTION 'work-rules: the three teachers this block needs are not distinct';
  END IF;

  -- Readable: the grid shows a colleague's day, and a refusal that names a rule
  -- row is unreadable to somebody who cannot open it.
  SELECT count(*) INTO n FROM "TeacherWorkRules";
  IF n <> 1 THEN
    RAISE EXCEPTION
      'work-rules: a teacher cannot read the arbetstid that binds their week (% row(s))', n;
  END IF;

  -- Their OWN row, which is the whole point of the third policy.
  INSERT INTO "TeacherWorkRules"
    ("schoolId", "userId", "lunchMinutes", "lunchStartTime", "lunchEndTime", "updatedAt")
  VALUES (app.current_school_id(), me, 30, '10:30', '13:30', now());
  SELECT count(*) INTO n FROM "TeacherWorkRules" WHERE "userId" = me;
  IF n <> 1 THEN
    RAISE EXCEPTION
      'work-rules: a teacher cannot record their own lunch (% row(s))', n;
  END IF;

  UPDATE "TeacherWorkRules" SET "minDailyRestMinutes" = 660, "updatedAt" = now()
   WHERE "userId" = me;
  SELECT count(*) INTO n FROM "TeacherWorkRules"
   WHERE "userId" = me AND "minDailyRestMinutes" = 660;
  IF n <> 1 THEN
    RAISE EXCEPTION 'work-rules: a teacher cannot change their own arbetstid';
  END IF;

  -- A third teacher's row, which they have no business authoring. WITH CHECK is
  -- what refuses this, and it must: an arbetstid is a hard rule, so writing one
  -- onto a colleague is refusing the school's week in that colleague's name.
  BEGIN
    INSERT INTO "TeacherWorkRules"
      ("schoolId", "userId", "minDailyRestMinutes", "updatedAt")
    VALUES (app.current_school_id(), stranger, 1320, now());
    RAISE EXCEPTION
      'work-rules: a teacher authored a colleague''s arbetstid';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  -- And the colleague's EXISTING row, which is where USING does the work. A
  -- policy that checked only WITH CHECK leaves these two statements silent: no
  -- error, no rows matched by USING, and the update simply appears to have been
  -- applied. So the row is read back rather than the statement trusted.
  UPDATE "TeacherWorkRules" SET "minDailyRestMinutes" = 61, "updatedAt" = now()
   WHERE "userId" = colleague;
  SELECT count(*) INTO n FROM "TeacherWorkRules"
   WHERE "userId" = colleague AND "minDailyRestMinutes" = 660;
  IF n <> 1 THEN
    RAISE EXCEPTION
      'work-rules: a teacher rewrote a colleague''s night (% row(s) left at 660)', n;
  END IF;

  DELETE FROM "TeacherWorkRules" WHERE "userId" = colleague;
  SELECT count(*) INTO n FROM "TeacherWorkRules" WHERE "userId" = colleague;
  IF n <> 1 THEN
    RAISE EXCEPTION
      'work-rules: a teacher deleted a colleague''s arbetstid (% row(s) left)', n;
  END IF;
END
$$;

-- A pupil of the same school, whom a tenant-only staff read would let straight
-- through. Looked up while the teacher is still in force: a teacher reads the
-- school's users and a pupil reads only their own row, so this is the one order
-- in which the lookup is legal (the same reason 7d and 7e give).
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',
    (SELECT "authId" FROM "Users"
      WHERE "schoolId" = app.current_school_id() AND role = 'STUDENT'
      ORDER BY "authId" LIMIT 1)
  )::text,
  true
);

DO $$
DECLARE n bigint;
BEGIN
  -- Without this guard the block passes vacuously: an authId that resolves to no
  -- user has no role, reads nothing, and looks exactly like success.
  IF app.current_user_role() IS DISTINCT FROM 'STUDENT' THEN
    RAISE EXCEPTION
      'work-rules: expected to be acting as a STUDENT of school A, resolved role %',
      coalesce(app.current_user_role()::text, '<none>');
  END IF;

  -- Two rows are in this transaction to be seen — the admin wrote one and the
  -- teacher the other.
  SELECT count(*) INTO n FROM "TeacherWorkRules";
  IF n <> 0 THEN
    RAISE EXCEPTION
      'work-rules: a pupil reads % teacher arbetstid(er); the staff read has lost its role check', n;
  END IF;
END
$$;

-- And a guardian, who has no policy of their own on this table and would reach
-- it through the same staff read. The literal authId, because the pupil in force
-- cannot look up anyone else's row.
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-4000-8000-000000000004')::text,
  true
);

DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'GUARDIAN' THEN
    RAISE EXCEPTION
      'work-rules: expected to be acting as a GUARDIAN of school A, resolved role %',
      coalesce(app.current_user_role()::text, '<none>');
  END IF;

  SELECT count(*) INTO n FROM "TeacherWorkRules";
  IF n <> 0 THEN
    RAISE EXCEPTION
      'work-rules: a guardian reads % teacher arbetstid(er); the staff read has lost its role check', n;
  END IF;
END
$$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- 7h. Tjänstefördelning: a post is HR data, a behörighet is not, and the policy
-- is the school's.
--
-- Three tables from 20261006100000 with three DIFFERENT second arms, which is
-- why this section is not a copy of 7g and must not become one. TeacherWorkRules
-- has staff_select plus a teacher_own arm FOR ALL: a colleague's lunch is
-- deliberately visible, and a teacher writes their own. TeacherEmployments has
-- neither. A teacher reads their OWN tjänstgöringsgrad, reads nobody else's, and
-- writes nothing — the employer sets a post, the employee is told. A colleague's
-- deltid and nedsättning are personnel facts.
--
-- The failure this guards is the copy-paste one: a `_staff_select` pasted from
-- 7g's table onto this one hands every teacher the whole staff's percentages,
-- and nothing in the API would notice, because the API filters by userId anyway
-- and the leak is through Supabase, where the table grant is the only other
-- gate. So the admin plants a post for TWO teachers — the one who acts below
-- and a colleague — and the teacher's read is asserted as a count of exactly
-- one, their own, against two rows that exist in the same transaction.
--
-- TeacherSubjectQualifications goes the other way: every teacher reads a
-- colleague's behörighet (the substitute picker lists colleagues by it) and no
-- teacher writes one, their own included — a legitimation is recorded by the
-- administrator against a document, not claimed by its holder. StaffingPolicies
-- is read by all staff and written by the admin.
--
-- Writes a policy filters raise nothing, so every "cannot change" below is a
-- ROW_COUNT and a read-back, never a statement trusted — and the rows the
-- teacher tried to change are read back once more as the admin at the end,
-- since the teacher cannot see the colleague's row to prove it unchanged.
--
-- The tenant half bites here, unlike 7g's: the fixtures plant a policy, a post
-- and a behörighet in the second school and the runner refuses to start without
-- them, so an admin counting another school's rows counts rows that are there.
--
-- The service principal closes the section, in the same transaction with the
-- user principal cleared: it reads this school's posts (the SS12000 /duties
-- feed, Fas 3), none of the other school's, and no qualification, which has no
-- arm for it. Since 20261010110000 it reads its own school's policy (the feed's
-- switch and annual hours) and still no other school's, and no post's history.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'admin_auth_id')::text,
  true
);
-- psql does not expand :variables inside a dollar-quoted block, so the other
-- school's pupil and this school's id are handed to the blocks through settings.
SELECT set_config('app.test_student_b', :'student_b', true);
SELECT set_config('app.test_school_a', :'school_a', true);

DO $$
DECLARE me uuid; colleague uuid; year uuid; subject uuid; n bigint;
BEGIN
  IF app.current_user_role() <> 'SCHOOL_ADMIN' THEN
    RAISE EXCEPTION 'staffing: expected to be acting as an admin, am %',
      app.current_user_role();
  END IF;

  -- The FIRST teacher by authId is the one who acts further down; the second
  -- is the colleague. The same ordering in every block, so they stay distinct.
  SELECT id INTO me FROM "Users"
   WHERE "schoolId" = app.current_school_id() AND role = 'TEACHER'
   ORDER BY "authId" LIMIT 1;
  SELECT id INTO colleague FROM "Users"
   WHERE "schoolId" = app.current_school_id() AND role = 'TEACHER'
   ORDER BY "authId" OFFSET 1 LIMIT 1;
  SELECT id INTO year FROM "AcademicYears"
   WHERE "schoolId" = app.current_school_id() AND "isActive" LIMIT 1;
  SELECT id INTO subject FROM "Subjects"
   WHERE "schoolId" = app.current_school_id() ORDER BY code LIMIT 1;
  IF me IS NULL OR colleague IS NULL OR year IS NULL OR subject IS NULL THEN
    RAISE EXCEPTION
      'staffing: the seed lacks two teachers (%, %), an active year (%) or a subject (%)',
      me, colleague, year, subject;
  END IF;

  -- The tenant half, asked BEFORE this school has rows of its own in the
  -- transaction so a lost tenant predicate is named as one (7d's reason). What
  -- it would find is the row the fixtures plant in the second school, and the
  -- runner has already refused to start if that row is missing.
  SELECT count(*) INTO n FROM "StaffingPolicies"
   WHERE "schoolId" <> app.current_school_id();
  IF n <> 0 THEN
    RAISE EXCEPTION
      'staffing: % policy row(s) from another school visible — tenant isolation is not enforced', n;
  END IF;
  SELECT count(*) INTO n FROM "TeacherEmployments"
   WHERE "schoolId" <> app.current_school_id();
  IF n <> 0 THEN
    RAISE EXCEPTION
      'staffing: % post(s) from another school visible — tenant isolation is not enforced', n;
  END IF;
  SELECT count(*) INTO n FROM "TeacherSubjectQualifications"
   WHERE "schoolId" <> app.current_school_id();
  IF n <> 0 THEN
    RAISE EXCEPTION
      'staffing: % behörighet(er) from another school visible — tenant isolation is not enforced', n;
  END IF;

  -- The policy, with a riktmärke, which is the path a school turns the load
  -- report on by.
  INSERT INTO "StaffingPolicies" ("schoolId", "fullTimeTeachingMinutesPerWeek", "updatedAt")
  VALUES (app.current_school_id(), 1080, now());
  SELECT count(*) INTO n FROM "StaffingPolicies";
  IF n <> 1 THEN
    RAISE EXCEPTION
      'staffing: an admin cannot write their own school''s policy (% row(s))', n;
  END IF;

  -- Two posts: the acting teacher's and the colleague's.
  INSERT INTO "TeacherEmployments"
    ("schoolId", "userId", "academicYearId", "employmentPercent", "signature", "updatedAt")
  VALUES (app.current_school_id(), me,        year, 100, 'ABC', now()),
         (app.current_school_id(), colleague, year,  80, 'DEF', now());
  SELECT count(*) INTO n FROM "TeacherEmployments";
  IF n <> 2 THEN
    RAISE EXCEPTION
      'staffing: an admin cannot write their own school''s posts (% row(s))', n;
  END IF;

  -- A behörighet for the colleague, which the acting teacher must be able to
  -- read and must not be able to touch.
  INSERT INTO "TeacherSubjectQualifications"
    ("schoolId", "userId", "subjectId", "minGradeLevel", "maxGradeLevel", kind, "updatedAt")
  VALUES (app.current_school_id(), colleague, subject, 1, 9, 'LEGITIMATION', now());
  SELECT count(*) INTO n FROM "TeacherSubjectQualifications";
  IF n <> 1 THEN
    RAISE EXCEPTION
      'staffing: an admin cannot write their own school''s behörigheter (% row(s))', n;
  END IF;

  -- Another school's USER, stamped with this school's id — the shape a policy
  -- alone cannot refuse, since the row's schoolId is honestly this admin's. The
  -- composite (userId, schoolId) key is what answers, for the reason 7g gives.
  -- The pupil is the one foreign user the runner can hand in; the key knows
  -- nothing about roles.
  BEGIN
    INSERT INTO "TeacherEmployments"
      ("schoolId", "userId", "academicYearId", "employmentPercent", "updatedAt")
    VALUES (app.current_school_id(), current_setting('app.test_student_b')::uuid,
            year, 100, now());
    RAISE EXCEPTION 'staffing: an admin wrote a post for another school''s user';
  EXCEPTION
    WHEN foreign_key_violation OR insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO "TeacherSubjectQualifications"
      ("schoolId", "userId", "subjectId", "minGradeLevel", "maxGradeLevel", kind, "updatedAt")
    VALUES (app.current_school_id(), current_setting('app.test_student_b')::uuid,
            subject, 1, 9, 'BEHORIG', now());
    RAISE EXCEPTION 'staffing: an admin wrote a behörighet for another school''s user';
  EXCEPTION
    WHEN foreign_key_violation OR insufficient_privilege THEN NULL;
  END;

  -- And rows stamped with a school that is not this one. WITH CHECK and the
  -- foreign key are both correct ways to refuse these; what matters is that
  -- nothing lands.
  BEGIN
    INSERT INTO "StaffingPolicies" ("schoolId", "updatedAt")
    VALUES ('00000000-0000-4000-8000-0000000000ff', now());
    RAISE EXCEPTION 'staffing: an admin wrote a policy into another school';
  EXCEPTION
    WHEN insufficient_privilege OR foreign_key_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "TeacherEmployments"
      ("schoolId", "userId", "academicYearId", "employmentPercent", "updatedAt")
    VALUES ('00000000-0000-4000-8000-0000000000ff', me, year, 100, now());
    RAISE EXCEPTION 'staffing: an admin wrote a post into another school';
  EXCEPTION
    WHEN insufficient_privilege OR foreign_key_violation THEN NULL;
  END;
END
$$;

-- Now as the first teacher of this school. The admin's rows are still in the
-- open transaction: a post of their own to read, a colleague's to fail to
-- read, and a colleague's behörighet to read and fail to rewrite.
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
DECLARE me uuid := app.current_user_id(); colleague uuid; year uuid; subject uuid; n bigint;
BEGIN
  IF me IS NULL OR app.current_user_role() <> 'TEACHER' THEN
    RAISE EXCEPTION
      'staffing: expected to be acting as a TEACHER of school A, am % (%)',
      app.current_user_role(), me;
  END IF;

  SELECT id INTO colleague FROM "Users"
   WHERE "schoolId" = app.current_school_id() AND role = 'TEACHER'
   ORDER BY "authId" OFFSET 1 LIMIT 1;
  SELECT id INTO year FROM "AcademicYears"
   WHERE "schoolId" = app.current_school_id() AND "isActive" LIMIT 1;
  SELECT id INTO subject FROM "Subjects"
   WHERE "schoolId" = app.current_school_id() ORDER BY code LIMIT 1;
  IF colleague IS NULL OR colleague = me THEN
    RAISE EXCEPTION 'staffing: the two teachers this block needs are not distinct';
  END IF;

  -- The policy: readable, because the teacher's own load bar is drawn against
  -- its riktmärke, and a refusal naming a mode is unreadable to somebody who
  -- cannot open the setting.
  SELECT count(*) INTO n FROM "StaffingPolicies";
  IF n <> 1 THEN
    RAISE EXCEPTION
      'staffing: a teacher cannot read the riktmärke their load is measured against (% row(s))', n;
  END IF;
  -- And not writable. No row is visible to the UPDATE, so it matches nothing
  -- and raises nothing; the count is the assertion.
  UPDATE "StaffingPolicies" SET "fullTimeTeachingMinutesPerWeek" = 1, "updatedAt" = now();
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'staffing: a teacher rewrote the school''s policy (% row(s))', n;
  END IF;
  SELECT count(*) INTO n FROM "StaffingPolicies" WHERE "fullTimeTeachingMinutesPerWeek" = 1080;
  IF n <> 1 THEN
    RAISE EXCEPTION 'staffing: the policy a teacher could not update has changed anyway';
  END IF;

  -- The posts. Two exist; exactly one is theirs; the count says which arm the
  -- table actually carries.
  SELECT count(*) INTO n FROM "TeacherEmployments";
  IF n = 0 THEN
    RAISE EXCEPTION
      'staffing: a teacher cannot read their own tjänstgöringsgrad — the own-row arm is missing';
  ELSIF n <> 1 THEN
    RAISE EXCEPTION
      'staffing: a teacher reads % posts where only their own may show — the HR arm has become a staff read', n;
  END IF;
  SELECT count(*) INTO n FROM "TeacherEmployments" WHERE "userId" = me;
  IF n <> 1 THEN
    RAISE EXCEPTION
      'staffing: the one post a teacher reads is not their own (% own row(s))', n;
  END IF;
  SELECT count(*) INTO n FROM "TeacherEmployments" WHERE "userId" = colleague;
  IF n <> 0 THEN
    RAISE EXCEPTION 'staffing: a teacher reads a colleague''s tjänstgöringsgrad';
  END IF;

  -- No write of their own, not even a new one: a post is set by the employer.
  -- The insert targets the same year as the row the admin planted, so the
  -- unique key would also refuse it — but only AFTER the policy has had its
  -- say, since WITH CHECK runs before constraints. Only insufficient_privilege
  -- is caught; a unique_violation here would mean the policy let the row
  -- through to the index, and must fail the run.
  BEGIN
    INSERT INTO "TeacherEmployments"
      ("schoolId", "userId", "academicYearId", "employmentPercent", "updatedAt")
    VALUES (app.current_school_id(), me, year, 100, now());
    RAISE EXCEPTION 'staffing: a teacher authored their own post';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  -- Their OWN row, which they can see and must not be able to change. A
  -- SELECT-only arm leaves the UPDATE with no visible row: ROW_COUNT 0, no
  -- error. Read back as well, since "0 rows" is also what a wrong WHERE gives.
  UPDATE "TeacherEmployments" SET "employmentPercent" = 50, "updatedAt" = now()
   WHERE "userId" = me;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION
      'staffing: a teacher changed their own tjänstgöringsgrad (% row(s))', n;
  END IF;
  SELECT count(*) INTO n FROM "TeacherEmployments"
   WHERE "userId" = me AND "employmentPercent" = 100;
  IF n <> 1 THEN
    RAISE EXCEPTION 'staffing: a teacher''s own post changed under an update that matched nothing';
  END IF;

  DELETE FROM "TeacherEmployments" WHERE "userId" = me;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'staffing: a teacher deleted their own post (% row(s))', n;
  END IF;

  -- The colleague's, which they cannot see; asserted anyway because USING on
  -- the write path is a separate predicate from USING on the read path, and 7
  -- found a table where they differed. The read-back is the admin's, below.
  UPDATE "TeacherEmployments" SET "employmentPercent" = 1, "updatedAt" = now()
   WHERE "userId" = colleague;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'staffing: a teacher changed a colleague''s tjänstgöringsgrad (% row(s))', n;
  END IF;
  DELETE FROM "TeacherEmployments" WHERE "userId" = colleague;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'staffing: a teacher deleted a colleague''s post (% row(s))', n;
  END IF;

  -- Behörigheter: a colleague's is readable. This is the one place the two HR
  -- tables part ways, and a teacher_own arm pasted here by symmetry would blind
  -- the substitute picker for every teacher.
  SELECT count(*) INTO n FROM "TeacherSubjectQualifications" WHERE "userId" = colleague;
  IF n <> 1 THEN
    RAISE EXCEPTION
      'staffing: a teacher cannot read a colleague''s behörighet (% row(s)); the substitute picker is blind', n;
  END IF;

  -- And no teacher writes one, their own included.
  BEGIN
    INSERT INTO "TeacherSubjectQualifications"
      ("schoolId", "userId", "subjectId", "minGradeLevel", "maxGradeLevel", kind, "updatedAt")
    VALUES (app.current_school_id(), me, subject, 1, 9, 'LEGITIMATION', now());
    RAISE EXCEPTION 'staffing: a teacher granted themselves a legitimation';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  -- The colleague's row is visible to the SELECT arm and must be invisible to
  -- the UPDATE and DELETE paths; it is read back as still LEGITIMATION, which
  -- this teacher can see.
  UPDATE "TeacherSubjectQualifications" SET kind = 'TILLATEN', "updatedAt" = now()
   WHERE "userId" = colleague;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'staffing: a teacher downgraded a colleague''s behörighet (% row(s))', n;
  END IF;
  SELECT count(*) INTO n FROM "TeacherSubjectQualifications"
   WHERE "userId" = colleague AND kind = 'LEGITIMATION';
  IF n <> 1 THEN
    RAISE EXCEPTION 'staffing: a colleague''s behörighet changed under an update that matched nothing';
  END IF;
  DELETE FROM "TeacherSubjectQualifications" WHERE "userId" = colleague;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'staffing: a teacher deleted a colleague''s behörighet (% row(s))', n;
  END IF;
  SELECT count(*) INTO n FROM "TeacherSubjectQualifications" WHERE "userId" = colleague;
  IF n <> 1 THEN
    RAISE EXCEPTION 'staffing: a colleague''s behörighet is gone after a delete that matched nothing';
  END IF;
END
$$;

-- A pupil of the same school. Looked up while the teacher is still in force, for
-- the reason 7g gives. Four rows across three tables are in the transaction to
-- be seen; a pupil sees none of them.
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',
    (SELECT "authId" FROM "Users"
      WHERE "schoolId" = app.current_school_id() AND role = 'STUDENT'
      ORDER BY "authId" LIMIT 1)
  )::text,
  true
);

DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'STUDENT' THEN
    RAISE EXCEPTION
      'staffing: expected to be acting as a STUDENT of school A, resolved role %',
      coalesce(app.current_user_role()::text, '<none>');
  END IF;

  SELECT count(*) INTO n FROM "StaffingPolicies";
  IF n <> 0 THEN
    RAISE EXCEPTION 'staffing: a pupil reads % policy row(s); the staff read has lost its role check', n;
  END IF;
  SELECT count(*) INTO n FROM "TeacherEmployments";
  IF n <> 0 THEN
    RAISE EXCEPTION 'staffing: a pupil reads % teacher post(s)', n;
  END IF;
  SELECT count(*) INTO n FROM "TeacherSubjectQualifications";
  IF n <> 0 THEN
    RAISE EXCEPTION 'staffing: a pupil reads % behörighet(er); the staff read has lost its role check', n;
  END IF;
END
$$;

-- And a guardian, by the literal authId the fixtures plant, since the pupil in
-- force cannot look up anyone else's row.
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-4000-8000-000000000004')::text,
  true
);

DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'GUARDIAN' THEN
    RAISE EXCEPTION
      'staffing: expected to be acting as a GUARDIAN of school A, resolved role %',
      coalesce(app.current_user_role()::text, '<none>');
  END IF;

  SELECT count(*) INTO n FROM "StaffingPolicies";
  IF n <> 0 THEN
    RAISE EXCEPTION 'staffing: a guardian reads % policy row(s)', n;
  END IF;
  SELECT count(*) INTO n FROM "TeacherEmployments";
  IF n <> 0 THEN
    RAISE EXCEPTION 'staffing: a guardian reads % teacher post(s)', n;
  END IF;
  SELECT count(*) INTO n FROM "TeacherSubjectQualifications";
  IF n <> 0 THEN
    RAISE EXCEPTION 'staffing: a guardian reads % behörighet(er)', n;
  END IF;
END
$$;

-- Back as the admin: the rows the teacher tried to change are what they were.
-- The teacher could not see the colleague's post to prove it unchanged, so the
-- proof is read here, by the one principal who sees both.
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'admin_auth_id')::text,
  true
);

DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() <> 'SCHOOL_ADMIN' THEN
    RAISE EXCEPTION 'staffing: expected to be back as the admin, am %', app.current_user_role();
  END IF;

  SELECT count(*) INTO n FROM "TeacherEmployments" WHERE "employmentPercent" IN (100, 80);
  IF n <> 2 THEN
    RAISE EXCEPTION
      'staffing: % of the two posts survive unchanged after the teacher''s writes', n;
  END IF;
  SELECT count(*) INTO n FROM "TeacherSubjectQualifications" WHERE kind = 'LEGITIMATION';
  IF n <> 1 THEN
    RAISE EXCEPTION 'staffing: the colleague''s behörighet did not survive the teacher''s writes';
  END IF;
END
$$;

-- The service principal, with the user principal CLEARED: an empty claims
-- setting is no user (20260914230000), so only the service arms answer. It
-- reads this school's posts for the /duties feed, none of the other school's,
-- and has no arm at all on the two tables SS12000 has no field for.
SELECT set_config('request.jwt.claims', '', true);
SELECT set_config('app.service_school_id', :'school_a', true);

DO $$
DECLARE n bigint; school_a uuid := app.current_service_school_id();
BEGIN
  IF app.current_user_id() IS NOT NULL OR app.current_user_role() IS NOT NULL THEN
    RAISE EXCEPTION
      'staffing: a user principal (%, %) is still in force; the service assertions would measure its arms',
      app.current_user_id(), app.current_user_role();
  END IF;
  IF school_a IS NULL THEN
    RAISE EXCEPTION 'staffing: the service principal is not in effect';
  END IF;

  SELECT count(*) INTO n FROM "TeacherEmployments" WHERE "schoolId" = school_a;
  IF n <> 2 THEN
    RAISE EXCEPTION
      'staffing: the service principal reads % post(s) of its own school, expected 2 — the /duties feed would be empty or wrong', n;
  END IF;
  -- No WHERE on the school: the policy alone must confine this, and the
  -- fixture row in the second school is there to be leaked.
  SELECT count(*) INTO n FROM "TeacherEmployments" WHERE "schoolId" <> school_a;
  IF n <> 0 THEN
    RAISE EXCEPTION 'staffing: the service principal leaked % post(s) from another school', n;
  END IF;

  SELECT count(*) INTO n FROM "TeacherSubjectQualifications";
  IF n <> 0 THEN
    RAISE EXCEPTION
      'staffing: the service principal reads % behörighet(er); it has no arm there', n;
  END IF;
  -- 20261010110000 gave it the policy of its own school (the /duties
  -- switch and fullTimeAnnualHours: configuration, not a person's data), and
  -- still none of another school's.
  SELECT count(*) INTO n FROM "StaffingPolicies" WHERE "schoolId" = school_a;
  IF n <> 1 THEN
    RAISE EXCEPTION
      'staffing: the service principal reads % policy row(s) of its own school, expected 1 — /duties cannot read the switch', n;
  END IF;
  SELECT count(*) INTO n FROM "StaffingPolicies" WHERE "schoolId" <> school_a;
  IF n <> 0 THEN
    RAISE EXCEPTION 'staffing: the service principal leaked % policy row(s) from another school', n;
  END IF;
  -- And never a post's history: the log has no principal arm.
  SELECT count(*) INTO n FROM "TeacherEmploymentLogs";
  IF n <> 0 THEN
    RAISE EXCEPTION 'staffing: the service principal reads % history row(s); it has no arm there', n;
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
  -- Prisma's own schema history — no tenant data, and no API role may touch
  -- it at all (section 14) — and is the single exclusion.
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
-- nobody maintains. This one has six exemptions, from its no-policy half
-- only, and all for the same reason: no API role is meant to reach the table
-- at all. `_prisma_migrations` is Prisma's own history (section 14);
-- `PushTickets` (20261013110000) holds Expo receipt ids that only the
-- SECURITY DEFINER app.push_* functions touch, with no grant to any API role
-- (section 29f); `Ss12000SourceSecrets` (20261014090000) holds the SS12000
-- source's sealed credentials that only the app.ss12000_*secret* functions
-- touch, likewise with no grant (section 30i); `IntegrationKeyWebhookSecrets`
-- (20261014120000) holds the keys' sealed webhook signing secrets that only
-- the app.*webhook_secret* functions touch, with no grant (section 31f);
-- `JobRuns` and `JobClaims` (20261021090000) hold the job runner's counts and
-- nightly claims that only the app.job_* functions touch, with no grant
-- (section 80). A new table cannot be added
-- without either satisfying the rule or changing it on purpose.
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
  WHERE n.nspname = 'public' AND c.relkind = 'r';

  IF checked < 25 THEN
    RAISE EXCEPTION
      'only % table(s) were examined; the catalog query proved nothing', checked;
  END IF;

  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO unprotected
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND NOT c.relrowsecurity;

  IF unprotected IS NOT NULL THEN
    RAISE EXCEPTION
      'tables with row security switched off, readable across every school: %',
      unprotected;
  END IF;

  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO policyless
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND c.relname NOT IN ('_prisma_migrations', 'PushTickets', 'Ss12000SourceSecrets', 'IntegrationKeyWebhookSecrets',
                          'JobRuns', 'JobClaims')
    AND c.relrowsecurity
    AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid);

  IF policyless IS NOT NULL THEN
    RAISE EXCEPTION
      'tables with row security on and no policy at all — denied to everyone: %',
      policyless;
  END IF;
END $$;


-- ---------------------------------------------------------------------------
-- Section 13: only a pupil has a class, whichever door the write comes in by.
--
-- app.current_user_group_id() returns "studentGroupId" without asking the
-- role, so a teacher or guardian holding a class reads its lessons, meals and
-- rasts the way its pupils do. UsersService refuses that row in words, but
-- users_admin_all lets an admin's own token UPDATE "Users" through PostgREST,
-- and a check read in one statement can be outrun before the write in the
-- next. Only Users_only_a_student_has_a_class holds for every writer, so it is
-- exercised here as that admin, by both doors: a class given to a teacher, and
-- a pupil made a teacher who keeps theirs.
--
-- The legitimate half sits beside them. A constraint that refused every class
-- write, or a policy that hid the rows, would pass the two refusals alone.
-- ---------------------------------------------------------------------------

BEGIN;

SELECT set_config('request.jwt.claims',
  json_build_object('sub', :'admin_auth_id', 'role', 'authenticated')::text, true);

DO $$
DECLARE
  pupil   uuid;
  teacher uuid;
  home    uuid;
  other   uuid;
  n       bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'SCHOOL_ADMIN' THEN
    RAISE EXCEPTION
      'student-class: expected to act as an admin of school A, resolved role %',
      app.current_user_role();
  END IF;

  SELECT id, "studentGroupId" INTO pupil, home FROM "Users"
   WHERE role = 'STUDENT' AND "studentGroupId" IS NOT NULL
   ORDER BY id LIMIT 1;
  SELECT id INTO teacher FROM "Users"
   WHERE role = 'TEACHER' AND "studentGroupId" IS NULL
   ORDER BY id LIMIT 1;
  SELECT id INTO other FROM "StudentGroups"
   WHERE id <> home
   ORDER BY id LIMIT 1;
  IF pupil IS NULL OR teacher IS NULL OR other IS NULL THEN
    RAISE EXCEPTION
      'student-class: no pupil with a class (%), teacher (%) or second class (%) to test with',
      pupil, teacher, other;
  END IF;

  -- A pupil moving class still goes through.
  UPDATE "Users" SET "studentGroupId" = other WHERE id = pupil;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'student-class: moving a pupil to another class updated % row(s)', n;
  END IF;

  -- A class given to a teacher. The RAISE inside the block is no
  -- check_violation, so it escapes the handler: an accepted write (1 row) and
  -- a policy-filtered one (0) both fail here, each under its own count.
  BEGIN
    UPDATE "Users" SET "studentGroupId" = home WHERE id = teacher;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE EXCEPTION
      'student-class: a teacher was put in a class (% row(s) updated)', n;
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- A pupil made a teacher who keeps the class: `PATCH { role }` before
  -- 3b1931c, and a direct write through PostgREST after it.
  BEGIN
    UPDATE "Users" SET role = 'TEACHER' WHERE id = pupil;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE EXCEPTION
      'student-class: a pupil became a teacher and kept their class (% row(s) updated)', n;
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- The same change made whole, role and class in one write, is allowed.
  UPDATE "Users" SET role = 'TEACHER', "studentGroupId" = NULL WHERE id = pupil;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION
      'student-class: making a pupil a teacher without their class updated % row(s)', n;
  END IF;
END $$;

ROLLBACK;


-- ---------------------------------------------------------------------------
-- Section 14: Prisma's migration history is refused to every API role.
--
-- `_prisma_migrations` holds no tenant data, which is why it has no policy.
-- What it holds is the schema's history: a deleted row makes the next
-- `migrate deploy` run that migration again, and an unfinished one stops every
-- deploy after it. Both table-wide GRANTs in the migrations reached it, so
-- until 20260914180000 app_authenticated read all of it and could delete all
-- of it, with no principal and inside a service transaction alike.
--
-- A refusal is required, not an empty result. Empty is also what row security
-- alone gives a role that has been granted the table again, and that is the
-- regression to catch: the next `GRANT ... ON ALL TABLES IN SCHEMA "public"`.
-- The catalog half names the roles this connection cannot become: anon, which
-- PostgREST uses for a request with no token, and service_role, which bypasses
-- row security and so has nothing but the missing grant between it and the
-- history.
-- ---------------------------------------------------------------------------

-- Exercised as this role, under each principal it can hold. The RAISE inside
-- each block is no insufficient_privilege, so it escapes the handler: a read
-- or a delete that went through fails the run, inside a transaction that psql
-- then never commits.
BEGIN;
SELECT set_config('app.test_school_a', :'school_a', true);

DO $$
DECLARE
  principal text;
  n         bigint;
BEGIN
  FOREACH principal IN ARRAY ARRAY['no principal', 'the service principal', 'the key lookup']
  LOOP
    PERFORM set_config('app.service_school_id',
      CASE principal WHEN 'the service principal'
        THEN current_setting('app.test_school_a') ELSE '' END, true);
    PERFORM set_config('app.service_key_lookup',
      CASE principal WHEN 'the key lookup' THEN 'on' ELSE '' END, true);

    -- A refusal needs no principal at all, so the principal is shown to be in
    -- effect before its refusals are counted as its own. Through the helpers,
    -- not a table: a count of "Schools" would run the authenticated policies
    -- too, and so measure what every policy admits rather than which
    -- principal is set.
    IF principal = 'the service principal' THEN
      IF app.current_service_school_id()
           IS DISTINCT FROM current_setting('app.test_school_a')::uuid THEN
        RAISE EXCEPTION
          'migration-history: the service principal is not in effect (school %)',
          app.current_service_school_id();
      END IF;
    ELSIF principal = 'the key lookup' AND NOT app.is_service_key_lookup() THEN
      RAISE EXCEPTION 'migration-history: the key lookup is not in effect';
    END IF;

    BEGIN
      SELECT count(*) INTO n FROM "_prisma_migrations";
      RAISE EXCEPTION
        'migration-history: app_authenticated with % read % row(s) of _prisma_migrations',
        principal, n;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;

    BEGIN
      DELETE FROM "_prisma_migrations";
      GET DIAGNOSTICS n = ROW_COUNT;
      RAISE EXCEPTION
        'migration-history: app_authenticated with % deleted % row(s) of _prisma_migrations',
        principal, n;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
  END LOOP;
END $$;

ROLLBACK;

DO $$
DECLARE
  api_role text;
  held     text;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class
           WHERE oid = 'public._prisma_migrations'::regclass) THEN
    RAISE EXCEPTION 'migration-history: row security is off on _prisma_migrations';
  END IF;

  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated']
  LOOP
    SELECT string_agg(p, ', ') INTO held
      FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE',
                        'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
     WHERE has_table_privilege(api_role, 'public._prisma_migrations', p);
    IF held IS NOT NULL THEN
      RAISE EXCEPTION
        'migration-history: % holds % on _prisma_migrations', api_role, held;
    END IF;
  END LOOP;
END $$;


-- ---------------------------------------------------------------------------
-- Section 15: the national timplan is read by every active user and written by
-- nobody who connects as an API role.
--
-- NationalTimplanVersions, NationalSubjects and NationalTimplanEntries are the
-- only tables here with no "schoolId" (20261006090000): they hold
-- skolförordningen bilaga 1–4, identical for every tenant and written only by
-- the migration that seeded them. So the question this file asks of every
-- other table — does school A see school B? — has no meaning for them, and
-- two others take its place. Can every signed-in role READ them, including a
-- pupil and a guardian, whom the coverage pages will one day show "undervisningstid
-- i år"? And can NO API principal WRITE them — not an admin, whose own
-- Supabase key reaches the table through PostgREST, not the service principal,
-- not a token with no principal at all? A statute an admin can edit is a
-- coverage page that reports what the school wished the law said.
--
-- The refusal asserted for writes is the LOUD one, insufficient_privilege,
-- because the migration revokes the write grants that 20260806000000's ALTER
-- DEFAULT PRIVILEGES hands every new table. A policy alone would refuse an
-- UPDATE by matching no row, which is silent, and silent is what let a
-- regression here go unnoticed; section 14 asserts _prisma_migrations the same
-- way for the same reason. The catalog half at the end names the grant and the
-- policy shape directly, so the next `GRANT ... ON ALL TABLES` is caught even
-- before a write is attempted.
--
-- The reads are asserted against FIGURES, not against "more than zero": the
-- version row for bilaga 1 must say 6 890, and it must carry the 48 cells the
-- bilaga prints. A seed that half-applied, or a policy that let the right role
-- see the wrong subset, cannot pass that by accident.
--
-- Deactivation is section 9's, which sweeps every readable table and found
-- these three the first time they were tried with USING (true): a revoked
-- token kept reading them. The policy now asks for an active principal, and
-- the no-principal block below is the same property from the other side.
--
-- Last, the foreign key the whole mapping rests on: Subject.nationalCode may
-- name only a code the statute knows. Asserted as the admin, since that is
-- the principal that writes subjects, with the positive half beside it — a
-- key that refused every code would pass the refusal alone.
-- ---------------------------------------------------------------------------

-- No principal at all reads nothing, as everywhere else in this schema.
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "NationalTimplanVersions";
  IF n <> 0 THEN
    RAISE EXCEPTION 'national: no principal reads % timplan version(s)', n;
  END IF;
  SELECT count(*) INTO n FROM "NationalSubjects";
  IF n <> 0 THEN
    RAISE EXCEPTION 'national: no principal reads % national subject(s)', n;
  END IF;
  SELECT count(*) INTO n FROM "NationalTimplanEntries";
  IF n <> 0 THEN
    RAISE EXCEPTION 'national: no principal reads % timplan cell(s)', n;
  END IF;
END
$$;

BEGIN;
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'admin_auth_id')::text,
  true
);

DO $$
DECLARE n bigint; total integer; row_count bigint;
BEGIN
  IF app.current_user_role() <> 'SCHOOL_ADMIN' THEN
    RAISE EXCEPTION 'national: expected to be acting as an admin, am %', app.current_user_role();
  END IF;

  -- The statute is there, and it is the statute: the bilaga 1 row says 6 890
  -- and carries its 48 printed cells; 28 ämnen are named across the four
  -- bilagor; the 2028 law is a row with no cells.
  SELECT count(*) INTO n FROM "NationalTimplanVersions";
  IF n < 6 THEN
    RAISE EXCEPTION 'national: an admin reads % timplan version(s), the migration seeds six', n;
  END IF;
  SELECT "totalHours" INTO total FROM "NationalTimplanVersions" WHERE code = 'SFS2023:945/B1';
  IF total IS DISTINCT FROM 6890 THEN
    RAISE EXCEPTION 'national: bilaga 1 reads % h for an admin, the statute says 6 890', total;
  END IF;
  SELECT count(*) INTO n FROM "NationalTimplanEntries" e
    JOIN "NationalTimplanVersions" v ON v.id = e."versionId"
   WHERE v.code = 'SFS2023:945/B1';
  IF n <> 48 THEN
    RAISE EXCEPTION 'national: an admin reads % of bilaga 1''s 48 cells', n;
  END IF;
  SELECT count(*) INTO n FROM "NationalSubjects";
  IF n <> 28 THEN
    RAISE EXCEPTION 'national: an admin reads % of the 28 national subjects', n;
  END IF;
  SELECT count(*) INTO n FROM "NationalTimplanEntries" e
    JOIN "NationalTimplanVersions" v ON v.id = e."versionId"
   WHERE v.code = 'SFS2025:729';
  IF n <> 0 THEN
    RAISE EXCEPTION 'national: the 2028 law shows % cell(s); its fördelning is not published', n;
  END IF;

  -- Every write an admin's own key could attempt, each refused loudly.
  BEGIN
    UPDATE "NationalTimplanVersions" SET "totalHours" = 1 WHERE code = 'SFS2023:945/B1';
    GET DIAGNOSTICS row_count = ROW_COUNT;
    RAISE EXCEPTION 'national: an admin''s UPDATE of a timplan version was not refused (% row(s))', row_count;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO "NationalTimplanVersions"
      (code, sfs, title, "schoolForm", "totalHours", "appliesFromCohortTerm")
    VALUES ('RLS-TEST', '0:0', 'RLS test', 'GRUNDSKOLA', 1, 'HT2099');
    RAISE EXCEPTION 'national: an admin INSERTed a timplan version';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM "NationalTimplanVersions" WHERE code = 'SFS2025:729';
    GET DIAGNOSTICS row_count = ROW_COUNT;
    RAISE EXCEPTION 'national: an admin''s DELETE of a timplan version was not refused (% row(s))', row_count;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE "NationalSubjects" SET name = 'x' WHERE code = 'MA';
    GET DIAGNOSTICS row_count = ROW_COUNT;
    RAISE EXCEPTION 'national: an admin''s UPDATE of a national subject was not refused (% row(s))', row_count;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO "NationalSubjects" (code, name) VALUES ('RLSTEST', 'RLS test');
    RAISE EXCEPTION 'national: an admin INSERTed a national subject';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM "NationalSubjects" WHERE code = 'ROD';
    GET DIAGNOSTICS row_count = ROW_COUNT;
    RAISE EXCEPTION 'national: an admin''s DELETE of a national subject was not refused (% row(s))', row_count;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE "NationalTimplanEntries" SET hours = 0 WHERE "subjectCode" = 'MA';
    GET DIAGNOSTICS row_count = ROW_COUNT;
    RAISE EXCEPTION 'national: an admin''s UPDATE of a timplan cell was not refused (% row(s))', row_count;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO "NationalTimplanEntries" ("versionId", "subjectCode", stage, hours)
    SELECT id, 'TSP', 'LAG', 1 FROM "NationalTimplanVersions" WHERE code = 'SFS2025:729';
    RAISE EXCEPTION 'national: an admin INSERTed a timplan cell';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM "NationalTimplanEntries";
    GET DIAGNOSTICS row_count = ROW_COUNT;
    RAISE EXCEPTION 'national: an admin''s DELETE of timplan cells was not refused (% row(s))', row_count;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- Read back: nothing above moved anything.
  SELECT "totalHours" INTO total FROM "NationalTimplanVersions" WHERE code = 'SFS2023:945/B1';
  IF total IS DISTINCT FROM 6890 THEN
    RAISE EXCEPTION 'national: bilaga 1 reads % h after the refused writes', total;
  END IF;

  -- The mapping: a school subject may name a known national code and no other.
  -- Case-exact as well — 'ma' is not 'MA', and a CSV that lower-cased a column
  -- must be refused rather than silently unmapped.
  INSERT INTO "Subjects" ("schoolId", name, code, "nationalCode", "updatedAt")
  VALUES (app.current_school_id(), 'RLS-nationellt ämne', 'RLSNAT', 'MA', now());
  SELECT count(*) INTO n FROM "Subjects"
   WHERE code = 'RLSNAT' AND "nationalCode" = 'MA' AND "countsTowardTimplan";
  IF n <> 1 THEN
    RAISE EXCEPTION 'national: a subject mapped to a known code did not land with countsTowardTimplan true (% row(s))', n;
  END IF;
  BEGIN
    INSERT INTO "Subjects" ("schoolId", name, code, "nationalCode", "updatedAt")
    VALUES (app.current_school_id(), 'RLS-okänd kod', 'RLSBAD', 'XX', now());
    RAISE EXCEPTION 'national: a subject with the unknown national code XX was accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    UPDATE "Subjects" SET "nationalCode" = 'ma' WHERE code = 'RLSNAT';
    RAISE EXCEPTION 'national: a subject was remapped to the lower-case code ''ma''';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END
$$;

-- A teacher reads the same statute.
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
DECLARE n bigint; total integer; row_count bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'TEACHER' THEN
    RAISE EXCEPTION 'national: expected to be acting as a TEACHER of school A, resolved role %',
      coalesce(app.current_user_role()::text, '<none>');
  END IF;
  SELECT "totalHours" INTO total FROM "NationalTimplanVersions" WHERE code = 'SFS2023:945/B1';
  IF total IS DISTINCT FROM 6890 THEN
    RAISE EXCEPTION 'national: a teacher reads % for bilaga 1''s 6 890 h', coalesce(total::text, '<nothing>');
  END IF;
  SELECT count(*) INTO n FROM "NationalTimplanEntries";
  IF n = 0 THEN
    RAISE EXCEPTION 'national: a teacher reads no timplan cells';
  END IF;
  SELECT count(*) INTO n FROM "NationalSubjects";
  IF n <> 28 THEN
    RAISE EXCEPTION 'national: a teacher reads % of the 28 national subjects', n;
  END IF;
  BEGIN
    UPDATE "NationalTimplanEntries" SET hours = 0 WHERE "subjectCode" = 'MA';
    GET DIAGNOSTICS row_count = ROW_COUNT;
    RAISE EXCEPTION 'national: a teacher''s UPDATE of a timplan cell was not refused (% row(s))', row_count;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;

-- A pupil. Looked up while the teacher is still in force, for the reason 7g
-- gives: a pupil can read only their own row.
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',
    (SELECT "authId" FROM "Users"
      WHERE "schoolId" = app.current_school_id() AND role = 'STUDENT'
      ORDER BY "authId" LIMIT 1)
  )::text,
  true
);

DO $$
DECLARE n bigint; total integer; row_count bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'STUDENT' THEN
    RAISE EXCEPTION 'national: expected to be acting as a STUDENT of school A, resolved role %',
      coalesce(app.current_user_role()::text, '<none>');
  END IF;
  SELECT "totalHours" INTO total FROM "NationalTimplanVersions" WHERE code = 'SFS2023:945/B1';
  IF total IS DISTINCT FROM 6890 THEN
    RAISE EXCEPTION 'national: a pupil reads % for bilaga 1''s 6 890 h', coalesce(total::text, '<nothing>');
  END IF;
  SELECT count(*) INTO n FROM "NationalTimplanEntries";
  IF n = 0 THEN
    RAISE EXCEPTION 'national: a pupil reads no timplan cells';
  END IF;
  SELECT count(*) INTO n FROM "NationalSubjects";
  IF n <> 28 THEN
    RAISE EXCEPTION 'national: a pupil reads % of the 28 national subjects', n;
  END IF;
  BEGIN
    DELETE FROM "NationalTimplanEntries";
    GET DIAGNOSTICS row_count = ROW_COUNT;
    RAISE EXCEPTION 'national: a pupil''s DELETE of timplan cells was not refused (% row(s))', row_count;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;

-- And a guardian, by the fixture's literal authId.
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-4000-8000-000000000004')::text,
  true
);

DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'GUARDIAN' THEN
    RAISE EXCEPTION 'national: expected to be acting as a GUARDIAN of school A, resolved role %',
      coalesce(app.current_user_role()::text, '<none>');
  END IF;
  SELECT count(*) INTO n FROM "NationalTimplanVersions";
  IF n < 6 THEN
    RAISE EXCEPTION 'national: a guardian reads % timplan version(s), the migration seeds six', n;
  END IF;
END
$$;
ROLLBACK;

-- The service principal: a tenant-scoped reader with no Users row, which the
-- active-principal predicate must leave with nothing, and whose writes are
-- refused by the missing grant like everyone else's.
BEGIN;
SELECT set_config('app.service_school_id', :'school_a', true);
DO $$
DECLARE n bigint; row_count bigint;
BEGIN
  IF app.current_service_school_id() IS NULL THEN
    RAISE EXCEPTION 'national: the service principal is not in effect';
  END IF;
  SELECT count(*) INTO n FROM "NationalTimplanVersions";
  IF n <> 0 THEN
    RAISE EXCEPTION 'national: the service principal reads % timplan version(s)', n;
  END IF;
  BEGIN
    UPDATE "NationalTimplanVersions" SET "totalHours" = 1;
    GET DIAGNOSTICS row_count = ROW_COUNT;
    RAISE EXCEPTION 'national: the service principal''s UPDATE was not refused (% row(s))', row_count;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;
ROLLBACK;

-- The catalog half: the grant that is missing and the policy that is there.
DO $$
DECLARE
  tbl      text;
  api_role text;
  held     text;
  n        integer;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['NationalTimplanVersions', 'NationalSubjects', 'NationalTimplanEntries']
  LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = format('public.%I', tbl)::regclass) THEN
      RAISE EXCEPTION 'national: row security is off on %', tbl;
    END IF;

    -- Exactly one policy, and it is FOR SELECT: a second policy on a table
    -- nobody may write is a write policy by another name.
    SELECT count(*) INTO n FROM pg_policy
     WHERE polrelid = format('public.%I', tbl)::regclass;
    IF n <> 1 THEN
      RAISE EXCEPTION 'national: % has % policies, expected the one SELECT policy', tbl, n;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policy
                    WHERE polrelid = format('public.%I', tbl)::regclass AND polcmd = 'r') THEN
      RAISE EXCEPTION 'national: the one policy on % is not FOR SELECT', tbl;
    END IF;

    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated']
    LOOP
      SELECT string_agg(p, ', ') INTO held
        FROM unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
       WHERE has_table_privilege(api_role, format('public.%I', tbl), p);
      IF held IS NOT NULL THEN
        RAISE EXCEPTION 'national: % holds % on %', api_role, held, tbl;
      END IF;
    END LOOP;

    IF has_table_privilege('anon', format('public.%I', tbl), 'SELECT') THEN
      RAISE EXCEPTION 'national: anon may SELECT %', tbl;
    END IF;
    IF NOT has_table_privilege('authenticated', format('public.%I', tbl), 'SELECT')
       OR NOT has_table_privilege('app_authenticated', format('public.%I', tbl), 'SELECT') THEN
      RAISE EXCEPTION 'national: the API role has lost SELECT on %', tbl;
    END IF;
  END LOOP;
END $$;


-- ---------------------------------------------------------------------------
-- Section 16: a local timplan is the school's, a draft is the staff's, and a
-- decided plan is a record nobody edits.
--
-- LocalTimplans and LocalTimplanEntries (20261006120000) carry three arms
-- each: admin_all, staff_select (every plan, drafts included) and
-- family_select (STUDENT and GUARDIAN read DECIDED plans and their entries,
-- never a draft). The third arm is the one this section exists for: it widens
-- a planning table to pupils, and the failure that matters is a draft leaking
-- to them — so the admin plants one plan of each status, each with entries,
-- and the pupil's and the guardian's reads are asserted as exact counts
-- against both rows existing in the same transaction.
--
-- The second half is the record. Two triggers refuse, with SQLSTATE TP409,
-- every UPDATE of a decided plan and every INSERT, UPDATE and DELETE of its
-- entries — for the admin too, through the same SQL PostgREST would send. And
-- the trigger's "the parent still exists" clause cuts both ways, which is why
-- both are asserted here rather than trusted: deleting a DECIDED plan must
-- cascade its entries cleanly (the parent is gone when the cascade arrives),
-- and deleting a SUBJECT a decided plan contains must raise (the parent still
-- stands). A subject only in a DRAFT plan cascades as it always has.
--
-- The copiedFromId pointer is the one column a decided plan may lose: when
-- the plan it was copied from is deleted, ON DELETE SET NULL ("copiedFromId")
-- must pass the update trigger, and clearing it by hand while the source
-- still exists must not.
--
-- Composite keys: another school's subject in an entry, another school's
-- plan as copiedFromId, another school's user as decidedByUserId — each a
-- foreign_key_violation, since the row's own schoolId is honestly this
-- school's and no policy can see the difference. And the school-form rule
-- (the plan's form is its version's) is a foreign key too, asserted both on
-- INSERT and on a draft changing one of the two columns alone.
--
-- The tenant half: school B's admin (fixture authId ...0006) acts last and
-- sees its own two plans and none of A's; school A's admin, first, sees none
-- of B's. The runner refuses to start without B's rows.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'admin_auth_id')::text,
  true
);
SELECT set_config('app.test_plan_b', :'plan_b', true);
SELECT set_config('app.test_subject_b', :'subject_b', true);
SELECT set_config('app.test_school_b', :'school_b', true);
SELECT set_config('app.test_student_b', :'student_b', true);

DO $$
DECLARE
  school uuid := app.current_school_id();
  me     uuid := app.current_user_id();
  b1     uuid;
  b3     uuid;
  s1 uuid; s2 uuid; s3 uuid;
  draft uuid; decided uuid;
  n bigint;
  msg text; detail text;
BEGIN
  IF app.current_user_role() <> 'SCHOOL_ADMIN' THEN
    RAISE EXCEPTION 'timplan: expected to be acting as an admin, am %', app.current_user_role();
  END IF;

  -- Tenant half first, before this school has rows of its own (7d's reason).
  SELECT count(*) INTO n FROM "LocalTimplans" WHERE "schoolId" <> school;
  IF n <> 0 THEN
    RAISE EXCEPTION 'timplan: % local timplan(s) from another school visible — tenant isolation is not enforced', n;
  END IF;
  SELECT count(*) INTO n FROM "LocalTimplanEntries" WHERE "schoolId" <> school;
  IF n <> 0 THEN
    RAISE EXCEPTION 'timplan: % timplan entr(y/ies) from another school visible — tenant isolation is not enforced', n;
  END IF;

  SELECT id INTO b1 FROM "NationalTimplanVersions" WHERE code = 'SFS2023:945/B1';
  SELECT id INTO b3 FROM "NationalTimplanVersions" WHERE code = 'SFS2023:945/B3';

  -- Three subjects of this transaction's own, so a subject delete below
  -- cascades into nothing but the timplan rows under test.
  INSERT INTO "Subjects" ("schoolId", name, code, "nationalCode", "updatedAt")
  VALUES (school, 'RLS-tp-matematik', 'RLSTP1', 'MA', now()),
         (school, 'RLS-tp-bild',      'RLSTP2', 'BL', now()),
         (school, 'RLS-tp-utkast',    'RLSTP3', NULL, now());
  SELECT id INTO s1 FROM "Subjects" WHERE "schoolId" = school AND code = 'RLSTP1';
  SELECT id INTO s2 FROM "Subjects" WHERE "schoolId" = school AND code = 'RLSTP2';
  SELECT id INTO s3 FROM "Subjects" WHERE "schoolId" = school AND code = 'RLSTP3';

  INSERT INTO "LocalTimplans" ("schoolId", name, "schoolForm", "nationalTimplanVersionId", "updatedAt")
  VALUES (school, 'RLS-tp utkast',   'GRUNDSKOLA', b1, now()),
         (school, 'RLS-tp beslutad', 'GRUNDSKOLA', b1, now());
  SELECT id INTO draft   FROM "LocalTimplans" WHERE name = 'RLS-tp utkast';
  SELECT id INTO decided FROM "LocalTimplans" WHERE name = 'RLS-tp beslutad';

  INSERT INTO "LocalTimplanEntries" ("schoolId", "localTimplanId", "subjectId", "gradeLevel", "minutesPerWeek")
  VALUES (school, draft,   s1, 4, 180),
         (school, draft,   s3, 4,  40),
         (school, decided, s1, 7, 120),
         (school, decided, s2, 7,  60),
         (school, decided, s2, 8,  60);

  -- The decision: DRAFT -> DECIDED is the one transition the trigger admits.
  UPDATE "LocalTimplans"
     SET status = 'DECIDED', "decidedAt" = now(), "decidedByUserId" = me,
         "decisionNote" = 'Beslutat av huvudman, dnr RLS-1', "updatedAt" = now()
   WHERE id = decided;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'timplan: an admin could not decide their own draft (% row(s))', n;
  END IF;

  -- How a decision is made: in the signed-in admin's own name, at the
  -- database's now(), and only as DRAFT -> DECIDED. Each of these was accepted
  -- before the record trigger took INSERT as well as UPDATE.
  DECLARE
    pupil  uuid;
    probe  uuid;
    stamped timestamptz;
  BEGIN
    SELECT id INTO pupil FROM "Users" WHERE "schoolId" = school AND role = 'STUDENT' LIMIT 1;
    IF pupil IS NULL THEN
      RAISE EXCEPTION 'timplan: the fixture school has no pupil to name as a decider';
    END IF;
    BEGIN
      INSERT INTO "LocalTimplans"
        ("schoolId", name, "schoolForm", "nationalTimplanVersionId", status,
         "decidedAt", "decidedByUserId", "decisionNote", "updatedAt")
      VALUES (school, 'RLS-tp född beslutad', 'GRUNDSKOLA', b1, 'DECIDED',
              now(), me, 'beslutad vid födseln', now());
      RAISE EXCEPTION 'timplan: an admin inserted a plan that was decided from the start';
    EXCEPTION WHEN SQLSTATE 'TP403' THEN NULL;
    END;
    INSERT INTO "LocalTimplans" ("schoolId", name, "schoolForm", "nationalTimplanVersionId", "createdAt", "updatedAt")
    VALUES (school, 'RLS-tp stämpel', 'GRUNDSKOLA', b1, '2018-01-01', now())
    RETURNING id, "createdAt" INTO probe, stamped;
    IF stamped <> now() THEN
      RAISE EXCEPTION 'timplan: an admin backdated a plan''s createdAt to %', stamped;
    END IF;
    BEGIN
      UPDATE "LocalTimplans"
         SET status = 'DECIDED', "decidedAt" = now(), "decidedByUserId" = pupil, "decisionNote" = 'x'
       WHERE id = probe;
      RAISE EXCEPTION 'timplan: an admin recorded a pupil as the person who decided a plan';
    EXCEPTION WHEN SQLSTATE 'TP403' THEN NULL;
    END;
    UPDATE "LocalTimplans"
       SET status = 'DECIDED', "decidedAt" = '2019-01-01', "decidedByUserId" = me, "decisionNote" = 'x'
     WHERE id = probe
    RETURNING "decidedAt" INTO stamped;
    IF stamped <> now() THEN
      RAISE EXCEPTION 'timplan: an admin backdated a decision to %', stamped;
    END IF;
    DELETE FROM "LocalTimplans" WHERE id = probe;
  END;

  -- Blank is what the DTO's /\S/ calls blank: a tab, a newline or an NBSP is
  -- no name and no decision note.
  BEGIN
    INSERT INTO "LocalTimplans" ("schoolId", name, "schoolForm", "nationalTimplanVersionId", "updatedAt")
    VALUES (school, E'\t', 'GRUNDSKOLA', b1, now());
    RAISE EXCEPTION 'timplan: a plan was named with a tab';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "LocalTimplans" ("schoolId", name, "schoolForm", "nationalTimplanVersionId", "updatedAt")
    VALUES (school, chr(160) || chr(12288), 'GRUNDSKOLA', b1, now());
    RAISE EXCEPTION 'timplan: a plan was named with an NBSP and an ideographic space';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE "LocalTimplans" SET name = 'RLS-tp utkast ' || chr(160) WHERE id = draft;
    UPDATE "LocalTimplans" SET name = 'RLS-tp utkast' WHERE id = draft;
  END;
  BEGIN
    UPDATE "LocalTimplans"
       SET status = 'DECIDED', "decidedAt" = now(), "decidedByUserId" = me, "decisionNote" = E'\t\n'
     WHERE id = draft;
    RAISE EXCEPTION 'timplan: a plan was decided with a blank decision note';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- The draft stays editable, plan and entries alike.
  UPDATE "LocalTimplans" SET "planningWeeks" = 36.0, "updatedAt" = now() WHERE id = draft;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'timplan: an admin could not edit a draft (% row(s))', n;
  END IF;
  UPDATE "LocalTimplanEntries" SET "minutesPerWeek" = 200 WHERE "localTimplanId" = draft AND "subjectId" = s1;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'timplan: an admin could not edit a draft''s entry (% row(s))', n;
  END IF;

  -- The decided plan: every column refused, the status included.
  BEGIN
    UPDATE "LocalTimplans" SET name = 'omdöpt', "updatedAt" = now() WHERE id = decided;
    RAISE EXCEPTION 'timplan: an admin renamed a decided plan';
  EXCEPTION WHEN SQLSTATE 'TP409' THEN NULL;
  END;
  BEGIN
    UPDATE "LocalTimplans" SET "planningWeeks" = 30.0 WHERE id = decided;
    RAISE EXCEPTION 'timplan: an admin changed a decided plan''s planningWeeks';
  EXCEPTION WHEN SQLSTATE 'TP409' THEN NULL;
  END;
  BEGIN
    UPDATE "LocalTimplans"
       SET status = 'DRAFT', "decidedAt" = NULL, "decidedByUserId" = NULL, "decisionNote" = NULL
     WHERE id = decided;
    RAISE EXCEPTION 'timplan: an admin turned a decided plan back into a draft';
  EXCEPTION WHEN SQLSTATE 'TP409' THEN NULL;
  END;
  BEGIN
    UPDATE "LocalTimplans" SET "decisionNote" = 'ändrad notering' WHERE id = decided;
    RAISE EXCEPTION 'timplan: an admin rewrote a decided plan''s decision note';
  EXCEPTION WHEN SQLSTATE 'TP409' THEN NULL;
  END;

  -- Its entries: INSERT, UPDATE, DELETE, and moving a draft's entry into it.
  BEGIN
    INSERT INTO "LocalTimplanEntries" ("schoolId", "localTimplanId", "subjectId", "gradeLevel", "minutesPerWeek")
    VALUES (school, decided, s1, 9, 100);
    RAISE EXCEPTION 'timplan: an admin added an entry to a decided plan';
  EXCEPTION WHEN SQLSTATE 'TP409' THEN NULL;
  END;
  BEGIN
    UPDATE "LocalTimplanEntries" SET "minutesPerWeek" = 1 WHERE "localTimplanId" = decided;
    RAISE EXCEPTION 'timplan: an admin changed a decided plan''s entries';
  EXCEPTION WHEN SQLSTATE 'TP409' THEN NULL;
  END;
  BEGIN
    DELETE FROM "LocalTimplanEntries" WHERE "localTimplanId" = decided AND "gradeLevel" = 8;
    RAISE EXCEPTION 'timplan: an admin deleted an entry of a decided plan';
  EXCEPTION WHEN SQLSTATE 'TP409' THEN NULL;
  END;
  BEGIN
    UPDATE "LocalTimplanEntries" SET "localTimplanId" = decided, "gradeLevel" = 9
     WHERE "localTimplanId" = draft AND "subjectId" = s3;
    RAISE EXCEPTION 'timplan: an admin moved a draft''s entry into a decided plan';
  EXCEPTION WHEN SQLSTATE 'TP409' THEN NULL;
  END;
  SELECT count(*) INTO n FROM "LocalTimplanEntries"
   WHERE "localTimplanId" = decided AND "minutesPerWeek" IN (120, 60);
  IF n <> 3 THEN
    RAISE EXCEPTION 'timplan: the decided plan holds % of its 3 entries unchanged after the refused writes', n;
  END IF;

  -- A subject the decided plan contains cannot be deleted: the cascade meets
  -- the trigger. The refusal is the gateway's to translate, so its words are
  -- asserted too — the code first, and the plan in DETAIL.
  BEGIN
    DELETE FROM "Subjects" WHERE id = s2;
    RAISE EXCEPTION 'timplan: a subject in a decided plan was deleted';
  EXCEPTION WHEN SQLSTATE 'TP409' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT, detail = PG_EXCEPTION_DETAIL;
    IF msg NOT LIKE 'TIMPLAN_IS_DECIDED:%RLS-tp beslutad%' THEN
      RAISE EXCEPTION 'timplan: the refused subject delete says "%", not TIMPLAN_IS_DECIDED naming the plan', msg;
    END IF;
    IF detail IS DISTINCT FROM 'localTimplanId=' || decided THEN
      RAISE EXCEPTION 'timplan: the refused subject delete carries DETAIL "%", not the plan id', detail;
    END IF;
  END;
  SELECT count(*) INTO n FROM "Subjects" WHERE id = s2;
  IF n <> 1 THEN
    RAISE EXCEPTION 'timplan: the subject a decided plan contains is gone after a refused delete';
  END IF;
  -- s1 is in BOTH plans: the decided one refuses for both.
  BEGIN
    DELETE FROM "Subjects" WHERE id = s1;
    RAISE EXCEPTION 'timplan: a subject in a decided and a draft plan was deleted';
  EXCEPTION WHEN SQLSTATE 'TP409' THEN NULL;
  END;
  SELECT count(*) INTO n FROM "LocalTimplanEntries" WHERE "subjectId" = s1;
  IF n <> 2 THEN
    RAISE EXCEPTION 'timplan: % of s1''s two entries survive its refused delete', n;
  END IF;

  -- A subject only in the draft cascades, as every subject always has.
  DELETE FROM "Subjects" WHERE id = s3;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'timplan: a subject only in a draft could not be deleted (% row(s))', n;
  END IF;
  SELECT count(*) INTO n FROM "LocalTimplanEntries" WHERE "localTimplanId" = draft;
  IF n <> 1 THEN
    RAISE EXCEPTION 'timplan: the draft holds % entr(y/ies) after its subject was deleted, expected 1', n;
  END IF;

  -- Composite keys. Each row is stamped with this school's id; only the key
  -- can tell that what it names is another school's.
  BEGIN
    INSERT INTO "LocalTimplanEntries" ("schoolId", "localTimplanId", "subjectId", "gradeLevel", "minutesPerWeek")
    VALUES (school, draft, current_setting('app.test_subject_b')::uuid, 5, 60);
    RAISE EXCEPTION 'timplan: an admin put another school''s subject in their plan';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "LocalTimplanEntries" ("schoolId", "localTimplanId", "subjectId", "gradeLevel", "minutesPerWeek")
    VALUES (school, current_setting('app.test_plan_b')::uuid, s1, 5, 60);
    RAISE EXCEPTION 'timplan: an admin wrote an entry into another school''s plan';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  -- And a row STAMPED with school B and naming B's decided plan and subject.
  -- RLS must answer it, with 42501 — not the decided-record trigger with
  -- TP409, which would tell school A that B has a decided plan and its name.
  -- Caught here only as insufficient_privilege; a TP409 fails the run.
  BEGIN
    UPDATE "LocalTimplanEntries"
       SET "schoolId" = current_setting('app.test_school_b')::uuid,
           "localTimplanId" = current_setting('app.test_plan_b')::uuid,
           "subjectId" = current_setting('app.test_subject_b')::uuid
     WHERE "localTimplanId" = draft AND "subjectId" = s1;
    RAISE EXCEPTION 'timplan: an admin moved their entry into another school''s plan';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO "LocalTimplanEntries" ("schoolId", "localTimplanId", "subjectId", "gradeLevel", "minutesPerWeek")
    VALUES (current_setting('app.test_school_b')::uuid, current_setting('app.test_plan_b')::uuid,
            current_setting('app.test_subject_b')::uuid, 5, 60);
    RAISE EXCEPTION 'timplan: an admin wrote an entry stamped with another school';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE "LocalTimplans" SET "copiedFromId" = current_setting('app.test_plan_b')::uuid WHERE id = draft;
    RAISE EXCEPTION 'timplan: an admin marked their draft as copied from another school''s plan';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "LocalTimplans"
      ("schoolId", name, "schoolForm", "nationalTimplanVersionId", status,
       "decidedAt", "decidedByUserId", "decisionNote", "updatedAt")
    VALUES (school, 'RLS-tp främling', 'GRUNDSKOLA', b1, 'DECIDED',
            now(), current_setting('app.test_student_b')::uuid, 'beslutad av en främling', now());
    RAISE EXCEPTION 'timplan: an admin recorded another school''s user as the decider';
  -- TP403 since the record trigger guards how a decision is made: a signed-in
  -- writer cannot insert a decided plan at all, nor name anyone but
  -- themselves. The composite key that refuses another school's user under
  -- the owner (who is not asked) is asserted by the owner probe.
  EXCEPTION WHEN SQLSTATE 'TP403' OR foreign_key_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "LocalTimplans" ("schoolId", name, "schoolForm", "nationalTimplanVersionId", "updatedAt")
    VALUES ('00000000-0000-4000-8000-0000000000ff', 'RLS-tp annan skola', 'GRUNDSKOLA', b1, now());
    RAISE EXCEPTION 'timplan: an admin wrote a plan into another school';
  EXCEPTION WHEN insufficient_privilege OR foreign_key_violation THEN NULL;
  END;

  -- The plan's school form is its version's.
  BEGIN
    INSERT INTO "LocalTimplans" ("schoolId", name, "schoolForm", "nationalTimplanVersionId", "updatedAt")
    VALUES (school, 'RLS-tp fel form', 'SAMESKOLA', b1, now());
    RAISE EXCEPTION 'timplan: a sameskola plan was checked against bilaga 1';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    UPDATE "LocalTimplans" SET "schoolForm" = 'SPECIALSKOLA' WHERE id = draft;
    RAISE EXCEPTION 'timplan: a draft changed its school form away from its version''s';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    UPDATE "LocalTimplans" SET "nationalTimplanVersionId" = b3 WHERE id = draft;
    RAISE EXCEPTION 'timplan: a grundskola draft moved to the specialskola version';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  -- Both together is a legal change of a draft.
  UPDATE "LocalTimplans" SET "schoolForm" = 'SPECIALSKOLA', "nationalTimplanVersionId" = b3 WHERE id = draft;
  UPDATE "LocalTimplans" SET "schoolForm" = 'GRUNDSKOLA',   "nationalTimplanVersionId" = b1 WHERE id = draft;
END
$$;

-- A teacher of the school reads both plans, drafts included, and writes
-- nothing. Filtered writes raise nothing, so every refusal below is a
-- ROW_COUNT; inserts meet WITH CHECK and raise.
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
DECLARE n bigint; draft uuid; decided uuid; s1 uuid;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'TEACHER' THEN
    RAISE EXCEPTION 'timplan: expected to be acting as a TEACHER of school A, resolved role %',
      coalesce(app.current_user_role()::text, '<none>');
  END IF;
  SELECT id INTO draft   FROM "LocalTimplans" WHERE name = 'RLS-tp utkast';
  SELECT id INTO decided FROM "LocalTimplans" WHERE name = 'RLS-tp beslutad';
  IF draft IS NULL OR decided IS NULL THEN
    RAISE EXCEPTION 'timplan: a teacher cannot read the school''s plans (draft %, decided %)', draft, decided;
  END IF;
  SELECT count(*) INTO n FROM "LocalTimplanEntries" WHERE "localTimplanId" IN (draft, decided);
  IF n <> 4 THEN
    RAISE EXCEPTION 'timplan: a teacher reads % of the 4 entries of the school''s two plans', n;
  END IF;
  SELECT count(*) INTO n FROM "LocalTimplans" WHERE "schoolId" <> app.current_school_id();
  IF n <> 0 THEN
    RAISE EXCEPTION 'timplan: a teacher reads % plan(s) of another school', n;
  END IF;
  SELECT id INTO s1 FROM "Subjects" WHERE "schoolId" = app.current_school_id() AND code = 'RLSTP1';

  BEGIN
    INSERT INTO "LocalTimplans" ("schoolId", name, "schoolForm", "nationalTimplanVersionId", "updatedAt")
    SELECT app.current_school_id(), 'RLS-tp lärarens', 'GRUNDSKOLA', id, now()
      FROM "NationalTimplanVersions" WHERE code = 'SFS2023:945/B1';
    RAISE EXCEPTION 'timplan: a teacher wrote a plan';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO "LocalTimplanEntries" ("schoolId", "localTimplanId", "subjectId", "gradeLevel", "minutesPerWeek")
    VALUES (app.current_school_id(), draft, s1, 6, 60);
    RAISE EXCEPTION 'timplan: a teacher wrote an entry into a draft';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  UPDATE "LocalTimplans" SET name = 'lärarens namn', "updatedAt" = now() WHERE id = draft;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'timplan: a teacher renamed a draft (% row(s))', n;
  END IF;
  UPDATE "LocalTimplanEntries" SET "minutesPerWeek" = 1 WHERE "localTimplanId" = draft;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'timplan: a teacher changed a draft''s entries (% row(s))', n;
  END IF;
  DELETE FROM "LocalTimplanEntries" WHERE "localTimplanId" = draft;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'timplan: a teacher deleted a draft''s entries (% row(s))', n;
  END IF;
  DELETE FROM "LocalTimplans" WHERE id IN (draft, decided);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'timplan: a teacher deleted a plan (% row(s))', n;
  END IF;
END
$$;

-- A pupil: the decided plan and its three entries, and nothing of the draft.
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',
    (SELECT "authId" FROM "Users"
      WHERE "schoolId" = app.current_school_id() AND role = 'STUDENT'
      ORDER BY "authId" LIMIT 1)
  )::text,
  true
);

DO $$
DECLARE n bigint; decided uuid;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'STUDENT' THEN
    RAISE EXCEPTION 'timplan: expected to be acting as a STUDENT of school A, resolved role %',
      coalesce(app.current_user_role()::text, '<none>');
  END IF;
  SELECT count(*) INTO n FROM "LocalTimplans" WHERE name = 'RLS-tp utkast';
  IF n <> 0 THEN
    RAISE EXCEPTION 'timplan: a pupil reads a DRAFT plan — the family arm has lost its status test';
  END IF;
  SELECT id INTO decided FROM "LocalTimplans" WHERE name = 'RLS-tp beslutad';
  IF decided IS NULL THEN
    RAISE EXCEPTION 'timplan: a pupil cannot read the school''s decided plan';
  END IF;
  SELECT count(*) INTO n FROM "LocalTimplans";
  IF n <> 1 THEN
    RAISE EXCEPTION 'timplan: a pupil reads % plans where only the one decided plan exists', n;
  END IF;
  SELECT count(*) INTO n FROM "LocalTimplanEntries";
  IF n <> 3 THEN
    RAISE EXCEPTION 'timplan: a pupil reads % entries where the decided plan has 3 and the draft''s must not show', n;
  END IF;
  BEGIN
    INSERT INTO "LocalTimplans" ("schoolId", name, "schoolForm", "nationalTimplanVersionId", "updatedAt")
    SELECT app.current_school_id(), 'RLS-tp elevens', 'GRUNDSKOLA', id, now()
      FROM "NationalTimplanVersions" WHERE code = 'SFS2023:945/B1';
    RAISE EXCEPTION 'timplan: a pupil wrote a plan';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  DELETE FROM "LocalTimplans" WHERE id = decided;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'timplan: a pupil deleted the decided plan (% row(s))', n;
  END IF;
END
$$;

-- A guardian, by the fixture's literal authId: the same two reads.
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-4000-8000-000000000004')::text,
  true
);

DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'GUARDIAN' THEN
    RAISE EXCEPTION 'timplan: expected to be acting as a GUARDIAN of school A, resolved role %',
      coalesce(app.current_user_role()::text, '<none>');
  END IF;
  SELECT count(*) INTO n FROM "LocalTimplans";
  IF n <> 1 THEN
    RAISE EXCEPTION 'timplan: a guardian reads % plans where only the one decided plan may show', n;
  END IF;
  SELECT count(*) INTO n FROM "LocalTimplans" WHERE status = 'DRAFT';
  IF n <> 0 THEN
    RAISE EXCEPTION 'timplan: a guardian reads a DRAFT plan';
  END IF;
  SELECT count(*) INTO n FROM "LocalTimplanEntries";
  IF n <> 3 THEN
    RAISE EXCEPTION 'timplan: a guardian reads % entries, expected the decided plan''s 3', n;
  END IF;
  UPDATE "LocalTimplanEntries" SET "minutesPerWeek" = 1;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'timplan: a guardian changed % entr(y/ies)', n;
  END IF;
END
$$;

-- The other school's admin: their own two fixture plans, none of school A's.
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-4000-8000-000000000006')::text,
  true
);

DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'SCHOOL_ADMIN' THEN
    RAISE EXCEPTION 'timplan: expected to be acting as school B''s SCHOOL_ADMIN, resolved role %',
      coalesce(app.current_user_role()::text, '<none>');
  END IF;
  SELECT count(*) INTO n FROM "LocalTimplans" WHERE name LIKE 'RLS-tp%';
  IF n <> 0 THEN
    RAISE EXCEPTION 'timplan: another school''s admin reads % of school A''s plans', n;
  END IF;
  SELECT count(*) INTO n FROM "LocalTimplans" WHERE "schoolId" <> app.current_school_id();
  IF n <> 0 THEN
    RAISE EXCEPTION 'timplan: another school''s admin reads % plan(s) outside their school', n;
  END IF;
  SELECT count(*) INTO n FROM "LocalTimplanEntries" WHERE "schoolId" <> app.current_school_id();
  IF n <> 0 THEN
    RAISE EXCEPTION 'timplan: another school''s admin reads % entr(y/ies) outside their school', n;
  END IF;
  SELECT count(*) INTO n FROM "LocalTimplans";
  IF n < 2 THEN
    RAISE EXCEPTION 'timplan: school B''s admin reads % of their own two fixture plans', n;
  END IF;
  -- And cannot reach A's rows by writing either.
  UPDATE "LocalTimplans" SET "planningWeeks" = 21.0 WHERE name LIKE 'RLS-tp%';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'timplan: another school''s admin changed % of school A''s plans', n;
  END IF;
  DELETE FROM "LocalTimplanEntries" WHERE "schoolId" <> app.current_school_id();
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'timplan: another school''s admin deleted % of school A''s entries', n;
  END IF;
END
$$;

-- Back as school A's admin: nothing above moved, and then the deletions the
-- record still allows — the pointer cleared by a deleted source, and the
-- decided plan itself.
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'admin_auth_id')::text,
  true
);

DO $$
DECLARE
  school uuid := app.current_school_id();
  me     uuid := app.current_user_id();
  b1 uuid; draft uuid; decided uuid; reopened uuid; s2 uuid; n bigint;
BEGIN
  IF app.current_user_role() <> 'SCHOOL_ADMIN' THEN
    RAISE EXCEPTION 'timplan: expected to be back as the admin, am %', app.current_user_role();
  END IF;
  SELECT id INTO draft   FROM "LocalTimplans" WHERE name = 'RLS-tp utkast' AND "planningWeeks" = 36.0;
  SELECT id INTO decided FROM "LocalTimplans" WHERE name = 'RLS-tp beslutad' AND "planningWeeks" = 35.6;
  IF draft IS NULL OR decided IS NULL THEN
    RAISE EXCEPTION 'timplan: a plan changed under writes that matched nothing (draft %, decided %)', draft, decided;
  END IF;
  SELECT count(*) INTO n FROM "LocalTimplanEntries" WHERE "localTimplanId" = draft AND "minutesPerWeek" = 200;
  IF n <> 1 THEN
    RAISE EXCEPTION 'timplan: the draft''s entry changed under writes that matched nothing';
  END IF;
  SELECT id INTO b1 FROM "NationalTimplanVersions" WHERE code = 'SFS2023:945/B1';
  SELECT id INTO s2 FROM "Subjects" WHERE "schoolId" = school AND code = 'RLSTP2';

  -- Reopen: a copy of the decided plan, then decided in its turn — a decided
  -- plan whose copiedFromId points at another decided plan.
  INSERT INTO "LocalTimplans" ("schoolId", name, "schoolForm", "nationalTimplanVersionId", "copiedFromId", "updatedAt")
  VALUES (school, 'RLS-tp återöppnad', 'GRUNDSKOLA', b1, decided, now());
  SELECT id INTO reopened FROM "LocalTimplans" WHERE name = 'RLS-tp återöppnad';
  INSERT INTO "LocalTimplanEntries" ("schoolId", "localTimplanId", "subjectId", "gradeLevel", "minutesPerWeek")
  SELECT "schoolId", reopened, "subjectId", "gradeLevel", "minutesPerWeek"
    FROM "LocalTimplanEntries" WHERE "localTimplanId" = decided;
  UPDATE "LocalTimplans"
     SET status = 'DECIDED', "decidedAt" = now(), "decidedByUserId" = me,
         "decisionNote" = 'Beslutat igen, dnr RLS-2', "updatedAt" = now()
   WHERE id = reopened;
  -- The draft is a copy too, so the SET NULL has a DRAFT row to clear as well.
  UPDATE "LocalTimplans" SET "copiedFromId" = decided WHERE id = draft;

  -- Clearing the pointer by hand while its source stands is an edit.
  BEGIN
    UPDATE "LocalTimplans" SET "copiedFromId" = NULL WHERE id = reopened;
    RAISE EXCEPTION 'timplan: a decided plan''s copiedFromId was cleared while its source exists';
  EXCEPTION WHEN SQLSTATE 'TP409' THEN NULL;
  END;

  -- Deleting the decided source: allowed, its entries cascade, and both
  -- copies keep their school and lose only the pointer.
  DELETE FROM "LocalTimplans" WHERE id = decided;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'timplan: an admin could not delete a decided plan (% row(s))', n;
  END IF;
  SELECT count(*) INTO n FROM "LocalTimplanEntries" WHERE "localTimplanId" = decided;
  IF n <> 0 THEN
    RAISE EXCEPTION 'timplan: % entr(y/ies) of a deleted decided plan survive its cascade', n;
  END IF;
  SELECT count(*) INTO n FROM "LocalTimplans"
   WHERE id IN (draft, reopened) AND "copiedFromId" IS NULL AND "schoolId" = school;
  IF n <> 2 THEN
    RAISE EXCEPTION 'timplan: % of the two copies lost only their pointer when the source was deleted', n;
  END IF;
  SELECT count(*) INTO n FROM "LocalTimplans"
   WHERE id = reopened AND status = 'DECIDED' AND "decisionNote" = 'Beslutat igen, dnr RLS-2';
  IF n <> 1 THEN
    RAISE EXCEPTION 'timplan: the decided copy is no longer the decision it was';
  END IF;

  -- s2 is now in the reopened decided plan only: still refused.
  BEGIN
    DELETE FROM "Subjects" WHERE id = s2;
    RAISE EXCEPTION 'timplan: a subject in the reopened decided plan was deleted';
  EXCEPTION WHEN SQLSTATE 'TP409' THEN NULL;
  END;
  -- Delete the decided copy too, and the subject is free to go.
  DELETE FROM "LocalTimplans" WHERE id = reopened;
  DELETE FROM "Subjects" WHERE id = s2;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'timplan: a subject in no decided plan any more could not be deleted (% row(s))', n;
  END IF;
END
$$;
ROLLBACK;

-- The catalog half: both tables carry exactly the three arms, both triggers
-- are there and enabled, and their functions run as the owner. LocalTimplans
-- has a fourth since 20261014130000: local_timplans_service_select, the
-- SS12000 v2.0 provider's read of a plan's schoolForm (a group's and an
-- enrolment's schoolType), for the service principal of the row's school.
DO $$
DECLARE tbl text; n integer;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['LocalTimplans', 'LocalTimplanEntries']
  LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = format('public.%I', tbl)::regclass) THEN
      RAISE EXCEPTION 'timplan: row security is off on %', tbl;
    END IF;
    SELECT count(*) INTO n FROM pg_policy WHERE polrelid = format('public.%I', tbl)::regclass
       AND NOT (tbl = 'LocalTimplans' AND polname = 'local_timplans_service_select'
                AND pg_get_expr(polqual, polrelid) = '("schoolId" = app.current_service_school_id())');
    IF n <> 3 THEN
      RAISE EXCEPTION 'timplan: % has % policies, expected admin_all, staff_select and family_select', tbl, n;
    END IF;
  END LOOP;

  SELECT count(*) INTO n
    FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
   WHERE NOT t.tgisinternal AND t.tgenabled = 'O' AND p.prosecdef
     AND (t.tgrelid, t.tgname) IN (
       ('public."LocalTimplans"'::regclass,       'LocalTimplans_keep_the_record'),
       ('public."LocalTimplanEntries"'::regclass, 'LocalTimplanEntries_refuse_decided'));
  IF n <> 2 THEN
    RAISE EXCEPTION 'timplan: % of the two decided-record triggers are present, enabled and SECURITY DEFINER', n;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Section 17: an uppdrag is the teacher's to read and the admin's to write,
-- and its fixed slot is the teacher's own weekly UNAVAILABLE time.
--
-- TeacherDuties (20261007090000) carries TeacherEmployments' three arms, not
-- TeacherWorkRules': admin_all, teacher_own_select and service_select. The
-- failure that matters is again the copy-paste one — a staff_select would hand
-- every teacher the colleague's förstelärare minutes and mentorships — so the
-- admin plants duties for TWO teachers and the teacher's read is an exact
-- count of their own, against the colleague's existing in the transaction.
--
-- The second half is the link, a TeacherDutySlots row since 20261017090000
-- (the one-time column blockedConstraintId it replaced is retired by
-- 20261022090000; section 90). A link must name a weekly UNAVAILABLE TEACHER
-- constraint of the duty's own teacher, and the triggers say so with SQLSTATE
-- TD409 for every writer, the admin through PostgREST's SQL included: a colleague's constraint, a ROOM's, a wish
-- (PREFERRED_FREE), a one-off date, a duty moved to another teacher with its
-- slot, and the constraint itself moved or retyped under a linked duty. A
-- constraint in ANOTHER school, under a row honestly stamped with this one,
-- is the composite key's to refuse (23503), and the trigger must not answer
-- it first — it would be describing school B's row to school A. A teacher
-- may not change or delete the slot an uppdrag holds (TD403), while their
-- other constraints stay theirs. An admin's delete of the slot clears the
-- pointer and nothing else, and deleting a duty's subject or class clears
-- that link alone, never the duty.
--
-- Every "cannot change" is a ROW_COUNT and a read-back, as in 7h. The tenant
-- half: school A's admin, teacher and service principal see none of the
-- fixture duty in school B, and school B's admin (fixture authId ...0006)
-- sees that one and none of A's.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'admin_auth_id')::text,
  true
);
SELECT set_config('app.test_student_b', :'student_b', true);
SELECT set_config('app.test_school_b', :'school_b', true);
SELECT set_config('app.test_constraint_b', :'constraint_b', true);

DO $$
DECLARE
  school uuid := app.current_school_id();
  me uuid; colleague uuid; year uuid; room_c uuid;
  subj uuid; grp uuid;
  c_me uuid; c_me2 uuid; c_col uuid; c_wish uuid; c_date uuid; c_spare uuid;
  d_me uuid; d_me2 uuid; d_col uuid;
  n bigint;
BEGIN
  IF app.current_user_role() <> 'SCHOOL_ADMIN' THEN
    RAISE EXCEPTION 'duties: expected to be acting as an admin, am %', app.current_user_role();
  END IF;

  -- 7h's two teachers, by the same ordering.
  SELECT id INTO me FROM "Users"
   WHERE "schoolId" = school AND role = 'TEACHER' ORDER BY "authId" LIMIT 1;
  SELECT id INTO colleague FROM "Users"
   WHERE "schoolId" = school AND role = 'TEACHER' ORDER BY "authId" OFFSET 1 LIMIT 1;
  SELECT id INTO year FROM "AcademicYears" WHERE "schoolId" = school AND "isActive" LIMIT 1;
  SELECT id INTO room_c FROM "AvailabilityConstraints"
   WHERE "schoolId" = school AND "resourceType" = 'ROOM' LIMIT 1;
  IF me IS NULL OR colleague IS NULL OR year IS NULL OR room_c IS NULL THEN
    RAISE EXCEPTION 'duties: the seed lacks two teachers (%, %), an active year (%) or a ROOM constraint (%)',
      me, colleague, year, room_c;
  END IF;

  -- The tenant half first, before this school has duties of its own.
  SELECT count(*) INTO n FROM "TeacherDuties";
  IF n <> 0 THEN
    RAISE EXCEPTION 'duties: % duty row(s) visible before any were written — the seed has none and school B''s must not show', n;
  END IF;
  SELECT count(*) INTO n FROM "AvailabilityConstraints"
   WHERE id = current_setting('app.test_constraint_b')::uuid;
  IF n <> 0 THEN
    RAISE EXCEPTION 'duties: school B''s duty slot is visible to school A''s admin';
  END IF;

  -- A subject and a class of the transaction's own, so that deleting them
  -- below touches nothing seeded.
  INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt")
  VALUES (school, 'RLS17 Ämnesansvar', 'RLS17', now()) RETURNING id INTO subj;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "updatedAt")
  VALUES (school, year, 'RLS17 Mentorsklass', now()) RETURNING id INTO grp;

  -- The constraints a duty may and may not point at.
  INSERT INTO "AvailabilityConstraints" ("schoolId", "resourceType", "userId", "dayOfWeek", "startTime", "endTime", type, reason, "updatedAt")
  VALUES (school, 'TEACHER', me, 2, '15:00', '17:00', 'UNAVAILABLE', 'RLS17 APT', now()) RETURNING id INTO c_me;
  INSERT INTO "AvailabilityConstraints" ("schoolId", "resourceType", "userId", "dayOfWeek", "startTime", "endTime", type, reason, "updatedAt")
  VALUES (school, 'TEACHER', me, 4, '12:00', '12:30', 'UNAVAILABLE', 'RLS17 rastvakt', now()) RETURNING id INTO c_me2;
  INSERT INTO "AvailabilityConstraints" ("schoolId", "resourceType", "userId", "dayOfWeek", "startTime", "endTime", type, reason, "updatedAt")
  VALUES (school, 'TEACHER', colleague, 2, '15:00', '17:00', 'UNAVAILABLE', 'RLS17 kollegans', now()) RETURNING id INTO c_col;
  INSERT INTO "AvailabilityConstraints" ("schoolId", "resourceType", "userId", "dayOfWeek", "startTime", "endTime", type, reason, "updatedAt")
  VALUES (school, 'TEACHER', me, 3, '08:00', '09:00', 'PREFERRED_FREE', 'RLS17 önskemål', now()) RETURNING id INTO c_wish;
  INSERT INTO "AvailabilityConstraints" ("schoolId", "resourceType", "userId", "date", "startTime", "endTime", type, reason, "updatedAt")
  VALUES (school, 'TEACHER', me, DATE '2099-01-05', '08:00', '09:00', 'UNAVAILABLE', 'RLS17 en dag', now()) RETURNING id INTO c_date;
  INSERT INTO "AvailabilityConstraints" ("schoolId", "resourceType", "userId", "dayOfWeek", "startTime", "endTime", type, reason, "updatedAt")
  VALUES (school, 'TEACHER', me, 5, '14:00', '15:00', 'UNAVAILABLE', 'RLS17 ledig', now()) RETURNING id INTO c_spare;

  -- Three duties: two of the acting teacher's (one with the APT slot, the
  -- mentor class and the subject), one of the colleague's.
  INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek",
                               "studentGroupId", "updatedAt")
  VALUES (school, me, year, 'APT_KONFERENS', 'APT', 120, grp, now()) RETURNING id INTO d_me;
  INSERT INTO "TeacherDutySlots" ("schoolId", "teacherDutyId", "availabilityConstraintId") VALUES (school, d_me, c_me);
  INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek",
                               "countsAsTeaching", "subjectId", "updatedAt")
  VALUES (school, me, year, 'AMNESANSVAR', 'Ämnesansvar', 60, true, subj, now()) RETURNING id INTO d_me2;
  INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "updatedAt")
  VALUES (school, colleague, year, 'RASTVAKT', 'Rastvakt', 30, now()) RETURNING id INTO d_col;
  SELECT count(*) INTO n FROM "TeacherDuties";
  IF n <> 3 THEN
    RAISE EXCEPTION 'duties: an admin cannot write their own school''s duties (% row(s))', n;
  END IF;

  -- The link, refused for every wrong target. Only TD409 is caught: any
  -- other error (a CHECK, a key) would mean the guard never got its say.
  BEGIN
    INSERT INTO "TeacherDutySlots" ("schoolId", "teacherDutyId", "availabilityConstraintId") VALUES (school, d_me2, c_col);
    RAISE EXCEPTION 'duties: a duty took a colleague''s constraint as its slot';
  EXCEPTION WHEN SQLSTATE 'TD409' THEN NULL;
  END;
  BEGIN
    INSERT INTO "TeacherDutySlots" ("schoolId", "teacherDutyId", "availabilityConstraintId") VALUES (school, d_me2, room_c);
    RAISE EXCEPTION 'duties: a duty took a ROOM constraint as its slot';
  EXCEPTION WHEN SQLSTATE 'TD409' THEN NULL;
  END;
  BEGIN
    INSERT INTO "TeacherDutySlots" ("schoolId", "teacherDutyId", "availabilityConstraintId") VALUES (school, d_me2, c_wish);
    RAISE EXCEPTION 'duties: a duty took a PREFERRED_FREE wish as its slot';
  EXCEPTION WHEN SQLSTATE 'TD409' THEN NULL;
  END;
  BEGIN
    INSERT INTO "TeacherDutySlots" ("schoolId", "teacherDutyId", "availabilityConstraintId") VALUES (school, d_me2, c_date);
    RAISE EXCEPTION 'duties: a duty took a one-off dated constraint as its weekly slot';
  EXCEPTION WHEN SQLSTATE 'TD409' THEN NULL;
  END;
  -- The colleague's duty given the acting teacher's slot, and the APT duty
  -- moved to the colleague with the acting teacher's slot.
  BEGIN
    INSERT INTO "TeacherDutySlots" ("schoolId", "teacherDutyId", "availabilityConstraintId") VALUES (school, d_col, c_me2);
    RAISE EXCEPTION 'duties: a link gave a colleague''s duty this teacher''s slot';
  EXCEPTION WHEN SQLSTATE 'TD409' THEN NULL;
  END;
  BEGIN
    UPDATE "TeacherDuties" SET "userId" = colleague WHERE id = d_me;
    RAISE EXCEPTION 'duties: a duty moved to another teacher kept the first teacher''s slot';
  EXCEPTION WHEN SQLSTATE 'TD409' THEN NULL;
  END;
  -- One duty per slot: the unique key, not the trigger.
  BEGIN
    INSERT INTO "TeacherDutySlots" ("schoolId", "teacherDutyId", "availabilityConstraintId") VALUES (school, d_me2, c_me);
    RAISE EXCEPTION 'duties: two duties hold one slot';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- Another school's slot, stamped with this school: the composite key's.
  -- Caught as foreign_key_violation ONLY — a TD409 here would be the trigger
  -- describing school B's row, which it must never reach.
  BEGIN
    INSERT INTO "TeacherDutySlots" ("schoolId", "teacherDutyId", "availabilityConstraintId")
    VALUES (school, d_me2, current_setting('app.test_constraint_b')::uuid);
    RAISE EXCEPTION 'duties: a duty in school A took school B''s constraint as its slot';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  -- Another school's person; and a row stamped with another school.
  BEGIN
    INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "updatedAt")
    VALUES (school, current_setting('app.test_student_b')::uuid, year, 'ANNAT', 'Skola B', 30, now());
    RAISE EXCEPTION 'duties: an admin wrote a duty for another school''s user';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "updatedAt")
    VALUES (current_setting('app.test_school_b')::uuid, me, year, 'ANNAT', 'Skola B', 30, now());
    RAISE EXCEPTION 'duties: an admin wrote a duty into another school';
  EXCEPTION WHEN insufficient_privilege OR foreign_key_violation THEN NULL;
  END;

  -- The constraint side: the slot under a linked duty keeps its shape.
  BEGIN
    UPDATE "AvailabilityConstraints" SET "userId" = colleague WHERE id = c_me;
    RAISE EXCEPTION 'duties: a linked slot was moved to another teacher';
  EXCEPTION WHEN SQLSTATE 'TD409' THEN NULL;
  END;
  BEGIN
    UPDATE "AvailabilityConstraints" SET type = 'PREFERRED_FREE' WHERE id = c_me;
    RAISE EXCEPTION 'duties: a linked slot became a wish';
  EXCEPTION WHEN SQLSTATE 'TD409' THEN NULL;
  END;
  BEGIN
    UPDATE "AvailabilityConstraints" SET "dayOfWeek" = NULL, "date" = DATE '2099-01-06' WHERE id = c_me;
    RAISE EXCEPTION 'duties: a linked weekly slot became a one-off date';
  EXCEPTION WHEN SQLSTATE 'TD409' THEN NULL;
  END;
  BEGIN
    UPDATE "AvailabilityConstraints"
       SET "resourceType" = 'ROOM', "userId" = NULL,
           "roomId" = (SELECT "roomId" FROM "AvailabilityConstraints" WHERE id = room_c)
     WHERE id = c_me;
    RAISE EXCEPTION 'duties: a linked slot became a room''s';
  EXCEPTION WHEN SQLSTATE 'TD409' THEN NULL;
  END;
  -- Retimed by the admin is the slot moving, which is legal.
  UPDATE "AvailabilityConstraints" SET "startTime" = '15:30' WHERE id = c_me;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'duties: an admin could not retime a duty''s slot (% row(s))', n;
  END IF;
  SELECT count(*) INTO n FROM "AvailabilityConstraints"
   WHERE id = c_me AND "userId" = me AND type = 'UNAVAILABLE' AND "dayOfWeek" = 2 AND "startTime" = '15:30';
  IF n <> 1 THEN
    RAISE EXCEPTION 'duties: the linked slot is not what the refused updates left it';
  END IF;
END
$$;

-- As the first teacher: their own two duties, not the colleague's, no write;
-- and the slot of their APT is not theirs to move, while their other
-- constraints are.
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
DECLARE me uuid := app.current_user_id(); year uuid; c_me uuid; c_spare uuid; n bigint;
BEGIN
  IF me IS NULL OR app.current_user_role() <> 'TEACHER' THEN
    RAISE EXCEPTION 'duties: expected to be acting as a TEACHER of school A, am % (%)',
      app.current_user_role(), me;
  END IF;
  SELECT id INTO year FROM "AcademicYears" WHERE "schoolId" = app.current_school_id() AND "isActive" LIMIT 1;
  SELECT id INTO c_me FROM "AvailabilityConstraints" WHERE reason = 'RLS17 APT';
  SELECT id INTO c_spare FROM "AvailabilityConstraints" WHERE reason = 'RLS17 ledig';
  IF c_me IS NULL OR c_spare IS NULL THEN
    RAISE EXCEPTION 'duties: a teacher cannot read their own constraints (APT %, ledig %)', c_me, c_spare;
  END IF;

  SELECT count(*) INTO n FROM "TeacherDuties";
  IF n = 0 THEN
    RAISE EXCEPTION 'duties: a teacher cannot read their own uppdrag — the own-row arm is missing';
  ELSIF n <> 2 THEN
    RAISE EXCEPTION 'duties: a teacher reads % duties where only their own two may show — the HR arm has become a staff read', n;
  END IF;
  SELECT count(*) INTO n FROM "TeacherDuties" WHERE "userId" <> me;
  IF n <> 0 THEN
    RAISE EXCEPTION 'duties: a teacher reads % of a colleague''s uppdrag', n;
  END IF;

  -- No write: not a new one, not their own, not the colleague's.
  BEGIN
    INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "updatedAt")
    VALUES (app.current_school_id(), me, year, 'ANNAT', 'Eget', 30, now());
    RAISE EXCEPTION 'duties: a teacher assigned themselves an uppdrag';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  UPDATE "TeacherDuties" SET "minutesPerWeek" = 1, "updatedAt" = now();
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'duties: a teacher rewrote % uppdrag', n;
  END IF;
  DELETE FROM "TeacherDuties";
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'duties: a teacher deleted % uppdrag', n;
  END IF;

  -- The APT slot: their own TEACHER row, which availability_teacher_modify
  -- admits, and the trigger refuses because a duty holds it.
  BEGIN
    UPDATE "AvailabilityConstraints" SET "startTime" = '16:00' WHERE id = c_me;
    RAISE EXCEPTION 'duties: a teacher moved the slot their APT holds';
  EXCEPTION WHEN SQLSTATE 'TD403' THEN NULL;
  END;
  BEGIN
    DELETE FROM "AvailabilityConstraints" WHERE id = c_me;
    RAISE EXCEPTION 'duties: a teacher deleted the slot their APT holds';
  EXCEPTION WHEN SQLSTATE 'TD403' THEN NULL;
  END;
  -- A constraint no duty holds is still theirs, both ways.
  UPDATE "AvailabilityConstraints" SET "startTime" = '14:15' WHERE id = c_spare;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'duties: the duty guard took a teacher''s own unlinked constraint from them (% row(s))', n;
  END IF;
  DELETE FROM "AvailabilityConstraints" WHERE id = c_spare;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'duties: a teacher could not delete their own unlinked constraint (% row(s))', n;
  END IF;
END
$$;

-- A pupil and a guardian of the same school read none of the three.
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',
    (SELECT "authId" FROM "Users"
      WHERE "schoolId" = app.current_school_id() AND role = 'STUDENT'
      ORDER BY "authId" LIMIT 1)
  )::text,
  true
);

DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'STUDENT' THEN
    RAISE EXCEPTION 'duties: expected to be acting as a STUDENT of school A, resolved role %',
      coalesce(app.current_user_role()::text, '<none>');
  END IF;
  SELECT count(*) INTO n FROM "TeacherDuties";
  IF n <> 0 THEN
    RAISE EXCEPTION 'duties: a pupil reads % teacher uppdrag', n;
  END IF;
END
$$;

SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-4000-8000-000000000004')::text,
  true
);

DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'GUARDIAN' THEN
    RAISE EXCEPTION 'duties: expected to be acting as a GUARDIAN of school A, resolved role %',
      coalesce(app.current_user_role()::text, '<none>');
  END IF;
  SELECT count(*) INTO n FROM "TeacherDuties";
  IF n <> 0 THEN
    RAISE EXCEPTION 'duties: a guardian reads % teacher uppdrag', n;
  END IF;
END
$$;

-- School B's admin: their own fixture duty, none of the three A wrote.
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-4000-8000-000000000006')::text,
  true
);

DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'SCHOOL_ADMIN'
     OR app.current_school_id() IS DISTINCT FROM current_setting('app.test_school_b')::uuid THEN
    RAISE EXCEPTION 'duties: expected to be school B''s admin, am % of %',
      app.current_user_role(), app.current_school_id();
  END IF;
  SELECT count(*) INTO n FROM "TeacherDuties";
  IF n <> 1 THEN
    RAISE EXCEPTION 'duties: school B''s admin reads % duties, expected their one fixture duty and none of A''s', n;
  END IF;
  SELECT count(*) INTO n FROM "TeacherDuties" WHERE "schoolId" <> app.current_school_id();
  IF n <> 0 THEN
    RAISE EXCEPTION 'duties: school B''s admin reads % of school A''s duties', n;
  END IF;
END
$$;

-- Back as school A's admin: the teacher's writes changed nothing; then the
-- deletes that must clear one column and keep the duty.
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'admin_auth_id')::text,
  true
);

DO $$
DECLARE
  school uuid := app.current_school_id();
  d_me uuid; d_me2 uuid; c_me uuid; n bigint;
BEGIN
  IF app.current_user_role() <> 'SCHOOL_ADMIN' THEN
    RAISE EXCEPTION 'duties: expected to be back as the admin, am %', app.current_user_role();
  END IF;
  SELECT count(*) INTO n FROM "TeacherDuties" WHERE "minutesPerWeek" IN (120, 60, 30);
  IF n <> 3 THEN
    RAISE EXCEPTION 'duties: % of the three duties survive the teacher''s writes unchanged', n;
  END IF;
  SELECT id INTO c_me FROM "AvailabilityConstraints" WHERE reason = 'RLS17 APT' AND "startTime" = '15:30';
  IF c_me IS NULL THEN
    RAISE EXCEPTION 'duties: the APT slot moved or vanished under the teacher''s refused writes';
  END IF;
  SELECT "teacherDutyId" INTO d_me FROM "TeacherDutySlots" WHERE "availabilityConstraintId" = c_me;
  SELECT id INTO d_me2 FROM "TeacherDuties" WHERE kind = 'AMNESANSVAR';
  IF d_me IS NULL THEN
    RAISE EXCEPTION 'duties: the APT''s link is gone before its slot was deleted';
  END IF;

  -- The admin deletes the slot: the duty stays, in its school, with no slot.
  DELETE FROM "AvailabilityConstraints" WHERE id = c_me;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'duties: an admin could not delete a duty''s slot (% row(s))', n;
  END IF;
  SELECT count(*) INTO n FROM "TeacherDuties"
   WHERE id = d_me AND "schoolId" = school
     AND "studentGroupId" IS NOT NULL AND "minutesPerWeek" = 120;
  IF n <> 1 THEN
    RAISE EXCEPTION 'duties: deleting the slot did more than remove its link';
  END IF;
  SELECT count(*) INTO n FROM "TeacherDutySlots" WHERE "teacherDutyId" = d_me;
  IF n <> 0 THEN
    RAISE EXCEPTION 'duties: a deleted slot left % link(s) on its duty', n;
  END IF;

  -- The mentor class and the ämnesansvar subject deleted: links cleared, duties kept.
  DELETE FROM "StudentGroups" WHERE name = 'RLS17 Mentorsklass';
  DELETE FROM "Subjects" WHERE code = 'RLS17';
  SELECT count(*) INTO n FROM "TeacherDuties"
   WHERE id IN (d_me, d_me2) AND "studentGroupId" IS NULL AND "subjectId" IS NULL AND "schoolId" = school;
  IF n <> 2 THEN
    RAISE EXCEPTION 'duties: % of two duties survive their class and subject being deleted with only the link cleared', n;
  END IF;
END
$$;

-- A slot goes with its uppdrag, however the uppdrag goes. The service deletes
-- both in one transaction, but a duty also leaves by PostgREST and by the
-- year's cascade (DELETE /academic-years/:id is tx.academicYear.delete), and
-- a slot left behind is a weekly UNAVAILABLE row no uppdrag shows any more,
-- blocking the teacher in every later generation. The link cascades and its
-- AFTER DELETE trigger takes the slot; both doors are exercised here, as the
-- admin through RLS.
DO $$
DECLARE
  school uuid := app.current_school_id();
  me uuid; year uuid; next_year uuid;
  c_one uuid; c_next uuid; d_one uuid; d_next uuid;
  n bigint;
BEGIN
  SELECT id INTO me FROM "Users"
   WHERE "schoolId" = school AND role = 'TEACHER' ORDER BY "authId" LIMIT 1;
  SELECT id INTO year FROM "AcademicYears" WHERE "schoolId" = school AND "isActive" LIMIT 1;

  -- A duty deleted on its own, not through the service.
  INSERT INTO "AvailabilityConstraints" ("schoolId", "resourceType", "userId", "dayOfWeek", "startTime", "endTime", type, reason, "updatedAt")
  VALUES (school, 'TEACHER', me, 1, '07:30', '08:00', 'UNAVAILABLE', 'RLS17 städas', now()) RETURNING id INTO c_one;
  INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "updatedAt")
  VALUES (school, me, year, 'RASTVAKT', 'Morgonvakt', 30, now()) RETURNING id INTO d_one;
  INSERT INTO "TeacherDutySlots" ("schoolId", "teacherDutyId", "availabilityConstraintId") VALUES (school, d_one, c_one);
  DELETE FROM "TeacherDuties" WHERE id = d_one;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'duties: an admin could not delete a duty (% row(s))', n;
  END IF;
  SELECT count(*) INTO n FROM "AvailabilityConstraints" WHERE id = c_one;
  IF n <> 0 THEN
    RAISE EXCEPTION 'duties: a duty deleted outside the service left its slot behind';
  END IF;

  -- Next year's duty, its year deleted: the duty cascades, and its slot with it.
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
  VALUES (school, 'RLS17 nästa år', DATE '2098-08-15', DATE '2099-06-10', false, now()) RETURNING id INTO next_year;
  INSERT INTO "AvailabilityConstraints" ("schoolId", "resourceType", "userId", "dayOfWeek", "startTime", "endTime", type, reason, "updatedAt")
  VALUES (school, 'TEACHER', me, 3, '15:00', '17:00', 'UNAVAILABLE', 'RLS17 nästa års APT', now()) RETURNING id INTO c_next;
  INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "updatedAt")
  VALUES (school, me, next_year, 'APT_KONFERENS', 'APT nästa år', 120, now()) RETURNING id INTO d_next;
  INSERT INTO "TeacherDutySlots" ("schoolId", "teacherDutyId", "availabilityConstraintId") VALUES (school, d_next, c_next);
  DELETE FROM "AcademicYears" WHERE id = next_year;
  SELECT count(*) INTO n FROM "TeacherDuties" WHERE id = d_next;
  IF n <> 0 THEN
    RAISE EXCEPTION 'duties: a deleted year kept its duty';
  END IF;
  SELECT count(*) INTO n FROM "AvailabilityConstraints" WHERE id = c_next;
  IF n <> 0 THEN
    RAISE EXCEPTION 'duties: a deleted year''s duty left its slot behind as a plain UNAVAILABLE row';
  END IF;
END
$$;

-- The service principal, user cleared: this school's three, none of B's.
SELECT set_config('request.jwt.claims', '', true);
SELECT set_config('app.service_school_id', :'school_a', true);

DO $$
DECLARE n bigint; school_a uuid := app.current_service_school_id();
BEGIN
  IF app.current_user_id() IS NOT NULL OR school_a IS NULL THEN
    RAISE EXCEPTION 'duties: the service principal is not alone in force (user %, school %)',
      app.current_user_id(), school_a;
  END IF;
  SELECT count(*) INTO n FROM "TeacherDuties" WHERE "schoolId" = school_a;
  IF n <> 3 THEN
    RAISE EXCEPTION 'duties: the service principal reads % duties of its own school, expected 3', n;
  END IF;
  SELECT count(*) INTO n FROM "TeacherDuties" WHERE "schoolId" <> school_a;
  IF n <> 0 THEN
    RAISE EXCEPTION 'duties: the service principal leaked % duties from another school', n;
  END IF;
  -- And it writes nothing: its arm is FOR SELECT.
  UPDATE "TeacherDuties" SET "minutesPerWeek" = 1;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'duties: the service principal rewrote % duties', n;
  END IF;
END
$$;
ROLLBACK;

-- The catalog half: three arms, the slot triggers enabled and SECURITY DEFINER
-- (the link's since 20261017090000; the old column's are gone, section 90),
-- and the two new load-percent CHECKs on TeachingRequirements.
DO $$
DECLARE n integer;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public."TeacherDuties"'::regclass) THEN
    RAISE EXCEPTION 'duties: row security is off on TeacherDuties';
  END IF;
  SELECT count(*) INTO n FROM pg_policy WHERE polrelid = 'public."TeacherDuties"'::regclass;
  IF n <> 3 THEN
    RAISE EXCEPTION 'duties: TeacherDuties has % policies, expected admin_all, teacher_own_select and service_select', n;
  END IF;
  SELECT count(*) INTO n
    FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
   WHERE NOT t.tgisinternal AND t.tgenabled = 'O' AND p.prosecdef
     AND (t.tgrelid, t.tgname) IN (
       ('public."TeacherDutySlots"'::regclass,        'TeacherDutySlots_are_the_teachers'),
       ('public."TeacherDutySlots"'::regclass,        'TeacherDutySlots_take_their_block'),
       ('public."TeacherDuties"'::regclass,           'TeacherDuties_slots_stay_the_teachers'),
       ('public."AvailabilityConstraints"'::regclass, 'AvailabilityConstraints_keep_duty_blocks'));
  IF n <> 4 THEN
    RAISE EXCEPTION 'duties: % of the four slot triggers are present, enabled and SECURITY DEFINER', n;
  END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public."TeachingRequirements"'::regclass AND contype = 'c'
     AND conname IN ('TeachingRequirements_teacher_load_percent_is_sane',
                     'TeachingRequirements_co_teacher_load_percent_is_sane');
  IF n <> 2 THEN
    RAISE EXCEPTION 'duties: % of the two load-percent CHECKs on TeachingRequirements exist', n;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Section 18: which plan a year's årskurs follows is the admin's to say, the
-- staff's to read, and a family's to read only once the plan is decided.
--
-- AcademicYearTimplans (20261007130000) carries LocalTimplans' three arms:
-- admin_all, staff_select (every attachment, drafts included) and
-- family_select (STUDENT and GUARDIAN read the rows whose plan is DECIDED).
-- The failure that matters is again the third arm's: a pupil or guardian
-- learning that next year's grade is being planned on a draft. So the admin
-- attaches one year's grades to a plan of each status, and every family read
-- is an exact count against both rows existing in the transaction.
--
-- The second half is the plan key. ON DELETE RESTRICT refuses deleting a plan
-- a year follows — decided or draft — for the admin too, through the same SQL
-- PostgREST would send, and the refusal names the constraint the gateway
-- translates into 409 TIMPLAN_IN_USE. Detaching first lets the plan go; a
-- year deleted takes its attachments and leaves the plan standing.
--
-- Composite keys: another school's year, another school's plan, each under a
-- row honestly stamped with this school — foreign_key_violation, since no
-- policy can see the difference; a row STAMPED with school B is RLS's to
-- refuse (42501). The CHECK mirrors the DTO's 0..10, and the key is one plan
-- per (year, grade).
--
-- The tenant half: school B's admin (fixture authId ...0006) acts last and
-- sees its own two fixture attachments and none of A's; everyone of school A
-- sees none of B's. The runner refuses to start without B's rows.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'admin_auth_id')::text,
  true
);
SELECT set_config('app.test_plan_b', :'plan_b', true);
SELECT set_config('app.test_school_b', :'school_b', true);
SELECT set_config('app.test_year_b', :'year_b', true);

DO $$
DECLARE
  school uuid := app.current_school_id();
  me     uuid := app.current_user_id();
  b1 uuid; year uuid; draft uuid; decided uuid; spare uuid;
  n bigint;
  msg text; con text;
BEGIN
  IF app.current_user_role() <> 'SCHOOL_ADMIN' THEN
    RAISE EXCEPTION 'year timplans: expected to be acting as an admin, am %', app.current_user_role();
  END IF;

  -- Tenant half first, before this school has rows of its own (7d's reason).
  SELECT count(*) INTO n FROM "AcademicYearTimplans" WHERE "schoolId" <> school;
  IF n <> 0 THEN
    RAISE EXCEPTION 'year timplans: % attachment(s) from another school visible — tenant isolation is not enforced', n;
  END IF;

  SELECT id INTO b1 FROM "NationalTimplanVersions" WHERE code = 'SFS2023:945/B1';

  -- A year of this transaction's own, far from any seeded one, and three plans:
  -- one decided, one draft, and a spare that nothing will point at.
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
  VALUES (school, 'RLS18 år', DATE '2097-08-15', DATE '2098-06-10', false, now())
  RETURNING id INTO year;
  INSERT INTO "LocalTimplans" ("schoolId", name, "schoolForm", "nationalTimplanVersionId", "updatedAt")
  VALUES (school, 'RLS18 beslutad', 'GRUNDSKOLA', b1, now()),
         (school, 'RLS18 utkast',   'GRUNDSKOLA', b1, now()),
         (school, 'RLS18 reserv',   'GRUNDSKOLA', b1, now());
  SELECT id INTO decided FROM "LocalTimplans" WHERE "schoolId" = school AND name = 'RLS18 beslutad';
  SELECT id INTO draft   FROM "LocalTimplans" WHERE "schoolId" = school AND name = 'RLS18 utkast';
  SELECT id INTO spare   FROM "LocalTimplans" WHERE "schoolId" = school AND name = 'RLS18 reserv';
  UPDATE "LocalTimplans"
     SET status = 'DECIDED', "decidedAt" = now(), "decidedByUserId" = me,
         "decisionNote" = 'Beslutat, dnr RLS-18', "updatedAt" = now()
   WHERE id = decided;

  -- Grades 0 and 7 follow the decided plan, grade 8 the draft: a draft may be
  -- attached, because next year is planned before it is decided.
  INSERT INTO "AcademicYearTimplans" ("schoolId", "academicYearId", "gradeLevel", "localTimplanId", "updatedAt")
  VALUES (school, year, 0, decided, now()),
         (school, year, 7, decided, now()),
         (school, year, 8, draft,   now());
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 3 THEN
    RAISE EXCEPTION 'year timplans: an admin attached % of 3 grades', n;
  END IF;

  -- One plan per (year, grade).
  BEGIN
    INSERT INTO "AcademicYearTimplans" ("schoolId", "academicYearId", "gradeLevel", "localTimplanId", "updatedAt")
    VALUES (school, year, 7, spare, now());
    RAISE EXCEPTION 'year timplans: a grade followed two plans in one year';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- The DTO's 0..10, as a CHECK.
  BEGIN
    INSERT INTO "AcademicYearTimplans" ("schoolId", "academicYearId", "gradeLevel", "localTimplanId", "updatedAt")
    VALUES (school, year, 11, spare, now());
    RAISE EXCEPTION 'year timplans: årskurs 11 was attached to a plan';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS con = CONSTRAINT_NAME;
    IF con IS DISTINCT FROM 'AcademicYearTimplans_gradeLevel_is_sane' THEN
      RAISE EXCEPTION 'year timplans: årskurs 11 was refused by "%", not the gradeLevel CHECK the gateway names', con;
    END IF;
  END;
  BEGIN
    UPDATE "AcademicYearTimplans" SET "gradeLevel" = -1 WHERE "academicYearId" = year AND "gradeLevel" = 0;
    RAISE EXCEPTION 'year timplans: årskurs -1 was attached to a plan';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- Composite keys. Each row is stamped with this school's id; only the key
  -- can tell that what it names is another school's.
  BEGIN
    INSERT INTO "AcademicYearTimplans" ("schoolId", "academicYearId", "gradeLevel", "localTimplanId", "updatedAt")
    VALUES (school, current_setting('app.test_year_b')::uuid, 5, spare, now());
    RAISE EXCEPTION 'year timplans: an admin attached their plan to another school''s year';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "AcademicYearTimplans" ("schoolId", "academicYearId", "gradeLevel", "localTimplanId", "updatedAt")
    VALUES (school, year, 5, current_setting('app.test_plan_b')::uuid, now());
    RAISE EXCEPTION 'year timplans: an admin attached another school''s plan to their year';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    UPDATE "AcademicYearTimplans" SET "localTimplanId" = current_setting('app.test_plan_b')::uuid
     WHERE "academicYearId" = year AND "gradeLevel" = 8;
    RAISE EXCEPTION 'year timplans: an admin pointed a grade at another school''s plan';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  -- And rows STAMPED with school B: RLS answers, not a key.
  BEGIN
    INSERT INTO "AcademicYearTimplans" ("schoolId", "academicYearId", "gradeLevel", "localTimplanId", "updatedAt")
    VALUES (current_setting('app.test_school_b')::uuid, current_setting('app.test_year_b')::uuid, 5,
            current_setting('app.test_plan_b')::uuid, now());
    RAISE EXCEPTION 'year timplans: an admin wrote an attachment stamped with another school';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE "AcademicYearTimplans"
       SET "schoolId" = current_setting('app.test_school_b')::uuid,
           "academicYearId" = current_setting('app.test_year_b')::uuid,
           "localTimplanId" = current_setting('app.test_plan_b')::uuid,
           "gradeLevel" = 5
     WHERE "academicYearId" = year AND "gradeLevel" = 8;
    RAISE EXCEPTION 'year timplans: an admin moved their attachment into another school';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- The plan key: a plan a year follows cannot be deleted, decided or draft.
  -- The constraint is asserted by name because the gateway recognises the
  -- refusal by it.
  BEGIN
    DELETE FROM "LocalTimplans" WHERE id = decided;
    RAISE EXCEPTION 'year timplans: an admin deleted a decided plan two grades follow';
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS con = CONSTRAINT_NAME, msg = MESSAGE_TEXT;
    IF con IS DISTINCT FROM 'AcademicYearTimplans_localTimplanId_schoolId_fkey' THEN
      RAISE EXCEPTION 'year timplans: the refused plan delete names "%" (%), not the attachment key', con, msg;
    END IF;
  END;
  BEGIN
    DELETE FROM "LocalTimplans" WHERE id = draft;
    RAISE EXCEPTION 'year timplans: an admin deleted a draft a grade follows';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  SELECT count(*) INTO n FROM "LocalTimplans" WHERE id IN (decided, draft);
  IF n <> 2 THEN
    RAISE EXCEPTION 'year timplans: % of the two attached plans survive their refused deletes', n;
  END IF;
  SELECT count(*) INTO n FROM "AcademicYearTimplans" WHERE "academicYearId" = year;
  IF n <> 3 THEN
    RAISE EXCEPTION 'year timplans: the year holds % of its 3 attachments after the refused writes', n;
  END IF;

  -- A plan nothing points at goes as it always has.
  DELETE FROM "LocalTimplans" WHERE id = spare;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'year timplans: an unattached plan could not be deleted (% row(s))', n;
  END IF;
END
$$;

-- A teacher of the school reads all three, the draft's included, and writes
-- nothing. Filtered writes raise nothing, so each refusal is a ROW_COUNT;
-- inserts meet WITH CHECK and raise.
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
DECLARE n bigint; year uuid; decided uuid;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'TEACHER' THEN
    RAISE EXCEPTION 'year timplans: expected to be acting as a TEACHER of school A, resolved role %',
      coalesce(app.current_user_role()::text, '<none>');
  END IF;
  SELECT id INTO year FROM "AcademicYears" WHERE name = 'RLS18 år';
  SELECT id INTO decided FROM "LocalTimplans" WHERE name = 'RLS18 beslutad';
  SELECT count(*) INTO n FROM "AcademicYearTimplans" WHERE "academicYearId" = year;
  IF n <> 3 THEN
    RAISE EXCEPTION 'year timplans: a teacher reads % of the year''s 3 attachments, the draft''s included', n;
  END IF;
  SELECT count(*) INTO n FROM "AcademicYearTimplans" WHERE "schoolId" <> app.current_school_id();
  IF n <> 0 THEN
    RAISE EXCEPTION 'year timplans: a teacher reads % attachment(s) of another school', n;
  END IF;
  BEGIN
    INSERT INTO "AcademicYearTimplans" ("schoolId", "academicYearId", "gradeLevel", "localTimplanId", "updatedAt")
    VALUES (app.current_school_id(), year, 9, decided, now());
    RAISE EXCEPTION 'year timplans: a teacher attached a grade';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  UPDATE "AcademicYearTimplans" SET "localTimplanId" = decided WHERE "academicYearId" = year AND "gradeLevel" = 8;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'year timplans: a teacher re-pointed a grade (% row(s))', n;
  END IF;
  DELETE FROM "AcademicYearTimplans" WHERE "academicYearId" = year;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'year timplans: a teacher detached % grade(s)', n;
  END IF;
END
$$;

-- A pupil: the two grades that follow the decided plan, and nothing of the
-- grade that follows the draft.
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',
    (SELECT "authId" FROM "Users"
      WHERE "schoolId" = app.current_school_id() AND role = 'STUDENT'
      ORDER BY "authId" LIMIT 1)
  )::text,
  true
);

DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'STUDENT' THEN
    RAISE EXCEPTION 'year timplans: expected to be acting as a STUDENT of school A, resolved role %',
      coalesce(app.current_user_role()::text, '<none>');
  END IF;
  -- The pupil reads no draft plan, so the year's draft attachment is found by
  -- its grade; it is the only row of grade 8 in the transaction's year.
  SELECT count(*) INTO n FROM "AcademicYearTimplans" a
    JOIN "AcademicYears" y ON y.id = a."academicYearId"
   WHERE y.name = 'RLS18 år';
  IF n <> 2 THEN
    RAISE EXCEPTION 'year timplans: a pupil reads % of the year''s attachments, expected the decided plan''s 2', n;
  END IF;
  SELECT count(*) INTO n FROM "AcademicYearTimplans" a
    JOIN "AcademicYears" y ON y.id = a."academicYearId"
   WHERE y.name = 'RLS18 år' AND a."gradeLevel" = 8;
  IF n <> 0 THEN
    RAISE EXCEPTION 'year timplans: a pupil reads the grade that follows a DRAFT — the family arm has lost its status test';
  END IF;
  SELECT count(*) INTO n FROM "AcademicYearTimplans" a
   WHERE NOT EXISTS (SELECT 1 FROM "LocalTimplans" p WHERE p.id = a."localTimplanId" AND p.status = 'DECIDED');
  IF n <> 0 THEN
    RAISE EXCEPTION 'year timplans: a pupil reads % attachment(s) whose plan is not a decided plan they can read', n;
  END IF;
  SELECT count(*) INTO n FROM "AcademicYearTimplans" WHERE "schoolId" <> app.current_school_id();
  IF n <> 0 THEN
    RAISE EXCEPTION 'year timplans: a pupil reads % attachment(s) of another school', n;
  END IF;
  BEGIN
    INSERT INTO "AcademicYearTimplans" ("schoolId", "academicYearId", "gradeLevel", "localTimplanId", "updatedAt")
    SELECT a."schoolId", a."academicYearId", 9, a."localTimplanId", now()
      FROM "AcademicYearTimplans" a JOIN "AcademicYears" y ON y.id = a."academicYearId"
     WHERE y.name = 'RLS18 år' LIMIT 1;
    RAISE EXCEPTION 'year timplans: a pupil attached a grade';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  DELETE FROM "AcademicYearTimplans";
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'year timplans: a pupil detached % grade(s)', n;
  END IF;
END
$$;

-- A guardian, by the fixture's literal authId: the same reads, no writes.
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-4000-8000-000000000004')::text,
  true
);

DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'GUARDIAN' THEN
    RAISE EXCEPTION 'year timplans: expected to be acting as a GUARDIAN of school A, resolved role %',
      coalesce(app.current_user_role()::text, '<none>');
  END IF;
  SELECT count(*) INTO n FROM "AcademicYearTimplans" a
    JOIN "AcademicYears" y ON y.id = a."academicYearId"
   WHERE y.name = 'RLS18 år';
  IF n <> 2 THEN
    RAISE EXCEPTION 'year timplans: a guardian reads % of the year''s attachments, expected the decided plan''s 2', n;
  END IF;
  SELECT count(*) INTO n FROM "AcademicYearTimplans" WHERE "gradeLevel" = 8
     AND "academicYearId" = (SELECT id FROM "AcademicYears" WHERE name = 'RLS18 år');
  IF n <> 0 THEN
    RAISE EXCEPTION 'year timplans: a guardian reads the grade that follows a DRAFT';
  END IF;
  SELECT count(*) INTO n FROM "AcademicYearTimplans" WHERE "schoolId" <> app.current_school_id();
  IF n <> 0 THEN
    RAISE EXCEPTION 'year timplans: a guardian reads % attachment(s) of another school', n;
  END IF;
  UPDATE "AcademicYearTimplans" SET "gradeLevel" = 9;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'year timplans: a guardian changed % attachment(s)', n;
  END IF;
END
$$;

-- The other school's admin: their own two fixture attachments, none of A's.
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-4000-8000-000000000006')::text,
  true
);

DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'SCHOOL_ADMIN' THEN
    RAISE EXCEPTION 'year timplans: expected to be acting as school B''s SCHOOL_ADMIN, resolved role %',
      coalesce(app.current_user_role()::text, '<none>');
  END IF;
  SELECT count(*) INTO n FROM "AcademicYearTimplans" WHERE "schoolId" <> app.current_school_id();
  IF n <> 0 THEN
    RAISE EXCEPTION 'year timplans: another school''s admin reads % attachment(s) outside their school', n;
  END IF;
  SELECT count(*) INTO n FROM "AcademicYearTimplans";
  IF n < 2 THEN
    RAISE EXCEPTION 'year timplans: school B''s admin reads % of their own two fixture attachments', n;
  END IF;
  UPDATE "AcademicYearTimplans" SET "gradeLevel" = 9 WHERE "schoolId" <> app.current_school_id();
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'year timplans: another school''s admin changed % of school A''s attachments', n;
  END IF;
  DELETE FROM "AcademicYearTimplans" WHERE "schoolId" <> app.current_school_id();
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'year timplans: another school''s admin deleted % of school A''s attachments', n;
  END IF;
END
$$;

-- Back as school A's admin: nothing above moved; then the ways out — a grade
-- detached frees its plan, and a deleted year takes its attachments and
-- leaves the plan standing.
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'admin_auth_id')::text,
  true
);

DO $$
DECLARE year uuid; draft uuid; decided uuid; n bigint;
BEGIN
  IF app.current_user_role() <> 'SCHOOL_ADMIN' THEN
    RAISE EXCEPTION 'year timplans: expected to be back as the admin, am %', app.current_user_role();
  END IF;
  SELECT id INTO year    FROM "AcademicYears" WHERE name = 'RLS18 år';
  SELECT id INTO decided FROM "LocalTimplans" WHERE name = 'RLS18 beslutad';
  SELECT id INTO draft   FROM "LocalTimplans" WHERE name = 'RLS18 utkast';
  SELECT count(*) INTO n FROM "AcademicYearTimplans"
   WHERE "academicYearId" = year
     AND ("gradeLevel", "localTimplanId") IN ((0, decided), (7, decided), (8, draft));
  IF n <> 3 THEN
    RAISE EXCEPTION 'year timplans: % of the year''s 3 attachments are as the admin left them', n;
  END IF;

  DELETE FROM "AcademicYearTimplans" WHERE "academicYearId" = year AND "gradeLevel" = 8;
  DELETE FROM "LocalTimplans" WHERE id = draft;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'year timplans: a detached draft could not be deleted (% row(s))', n;
  END IF;

  DELETE FROM "AcademicYears" WHERE id = year;
  SELECT count(*) INTO n FROM "AcademicYearTimplans" WHERE "academicYearId" = year;
  IF n <> 0 THEN
    RAISE EXCEPTION 'year timplans: a deleted year left % attachment(s) behind', n;
  END IF;
  SELECT count(*) INTO n FROM "LocalTimplans" WHERE id = decided AND status = 'DECIDED';
  IF n <> 1 THEN
    RAISE EXCEPTION 'year timplans: deleting a year took the plan it followed with it';
  END IF;
  DELETE FROM "LocalTimplans" WHERE id = decided;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'year timplans: a plan no year follows any more could not be deleted (% row(s))', n;
  END IF;
END
$$;
ROLLBACK;

-- The catalog half: row security on, exactly the three arms, the plan key is
-- RESTRICT and the year key CASCADE.
DO $$
DECLARE n integer; action "char";
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public."AcademicYearTimplans"'::regclass) THEN
    RAISE EXCEPTION 'year timplans: row security is off on AcademicYearTimplans';
  END IF;
  -- The fourth arm since 20261014130000 is the v2.0 provider's read of the
  -- school types, for the service principal of the row's school only.
  SELECT count(*) INTO n FROM pg_policy WHERE polrelid = 'public."AcademicYearTimplans"'::regclass
     AND NOT (polname = 'academic_year_timplans_service_select'
              AND pg_get_expr(polqual, polrelid) = '("schoolId" = app.current_service_school_id())');
  IF n <> 3 THEN
    RAISE EXCEPTION 'year timplans: AcademicYearTimplans has % policies, expected admin_all, staff_select and family_select', n;
  END IF;
  SELECT confdeltype INTO action FROM pg_constraint
   WHERE conname = 'AcademicYearTimplans_localTimplanId_schoolId_fkey';
  IF action IS DISTINCT FROM 'r' THEN
    RAISE EXCEPTION 'year timplans: the plan key deletes with action %, expected RESTRICT (r)', action;
  END IF;
  SELECT confdeltype INTO action FROM pg_constraint
   WHERE conname = 'AcademicYearTimplans_academicYearId_schoolId_fkey';
  IF action IS DISTINCT FROM 'c' THEN
    RAISE EXCEPTION 'year timplans: the year key deletes with action %, expected CASCADE (c)', action;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Section 19: a läsår and a class have at most one successor, a class's
-- predecessor is in the year before its own, and a link stays as written.
--
-- 20261007150000 gives AcademicYears and StudentGroups a predecessorId, the
-- link läsårsrullning writes (7A in 2026/27 -> 8A in 2027/28) and activation
-- follows to move every pupil. A wrong link moves a whole class into another
-- cohort, so it is held by the database for every writer: composite keys
-- (another school's year or group is 23503), one successor each (23505), a
-- CHECK against pointing at oneself (23514), and two triggers raising SQLSTATE
-- LR409 with a reason token — ROLLOVER_LINK_MISMATCH for a group whose
-- predecessor is not in its year's predecessor year, ROLLOVER_LINK_IS_FIXED
-- for any link set, re-pointed or cleared after the INSERT, and
-- ROLLOVER_GROUP_IS_LINKED for a linked group (either end) moved to another
-- year. Only LR409 is caught where LR409 is expected, and its token is read:
-- a CHECK or a key answering instead would mean the guard never had its say.
--
-- The tenant half is the cross-school group: school A's admin files a linked
-- group under school B's year (the plain academicYearId key lets that
-- through), and the trigger refuses it without its message or DETAIL naming
-- school B's school, year or class. The deletes that must pass — the
-- predecessor year, a predecessor group, the successor year — run as the
-- admin through RLS, and the successor's columns are compared whole before and
-- after. Deleting a whole school with a three-year chain is the adapter
-- probe's (v), as the owner: this role has no DELETE on Schools.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'admin_auth_id')::text,
  true
);
SELECT set_config('app.test_school_b', :'school_b', true);
SELECT set_config('app.test_year_b', :'year_b', true);
SELECT set_config('app.test_group_b', :'group_b', true);

DO $$
DECLARE
  school uuid := app.current_school_id();
  seed_year uuid; seed_group uuid;
  y1 uuid; y2 uuid; y3 uuid; self uuid := gen_random_uuid();
  g7 uuid; g7b uuid; g8 uuid; g9 uuid; loose uuid;
  n bigint;
  msg text; det text;
BEGIN
  IF app.current_user_role() <> 'SCHOOL_ADMIN' THEN
    RAISE EXCEPTION 'rollover: expected to be acting as an admin, am %', app.current_user_role();
  END IF;
  SELECT id INTO seed_year FROM "AcademicYears" WHERE "schoolId" = school AND "isActive" LIMIT 1;
  SELECT id INTO seed_group FROM "StudentGroups" WHERE "academicYearId" = seed_year ORDER BY name LIMIT 1;
  IF seed_year IS NULL OR seed_group IS NULL THEN
    RAISE EXCEPTION 'rollover: the seed lacks an active year (%) or a group in it (%)', seed_year, seed_group;
  END IF;
  SELECT count(*) INTO n FROM "AcademicYears" WHERE id = current_setting('app.test_year_b')::uuid;
  IF n <> 0 THEN
    RAISE EXCEPTION 'rollover: school B''s year is visible to school A''s admin';
  END IF;

  -- A three-year chain with a class in each, as the rollover writes it, and
  -- two unlinked groups: a parallel 7B and a teaching group in year 2.
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "updatedAt")
  VALUES (school, 'RLS19 år 1', DATE '2095-08-15', DATE '2096-06-10', now()) RETURNING id INTO y1;
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "predecessorId", "graduatingGradeLevel", "updatedAt")
  VALUES (school, 'RLS19 år 2', DATE '2096-08-15', DATE '2097-06-10', y1, 9, now()) RETURNING id INTO y2;
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "predecessorId", "graduatingGradeLevel", "updatedAt")
  VALUES (school, 'RLS19 år 3', DATE '2097-08-15', DATE '2098-06-10', y2, 9, now()) RETURNING id INTO y3;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt")
  VALUES (school, y1, 'RLS19 7A', 7, now()) RETURNING id INTO g7;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt")
  VALUES (school, y1, 'RLS19 7B', 7, now()) RETURNING id INTO g7b;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "predecessorId", "updatedAt")
  VALUES (school, y2, 'RLS19 8A', 8, g7, now()) RETURNING id INTO g8;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "predecessorId", "updatedAt")
  VALUES (school, y3, 'RLS19 9A', 9, g8, now()) RETURNING id INTO g9;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "updatedAt")
  VALUES (school, y2, 'RLS19 språkval', 'TEACHING_GROUP', now()) RETURNING id INTO loose;
  SELECT count(*) INTO n FROM "AcademicYears" WHERE (id, "predecessorId") IN ((y2, y1), (y3, y2));
  IF n <> 2 THEN
    RAISE EXCEPTION 'rollover: an admin could not write a successor year (% of 2 links read back)', n;
  END IF;
  SELECT count(*) INTO n FROM "StudentGroups" WHERE (id, "predecessorId") IN ((g8, g7), (g9, g8));
  IF n <> 2 THEN
    RAISE EXCEPTION 'rollover: an admin could not write a linked group (% of 2 links read back)', n;
  END IF;

  -- graduatingGradeLevel: 0..12, and writable (it labels; it moves nobody).
  BEGIN
    UPDATE "AcademicYears" SET "graduatingGradeLevel" = 13 WHERE id = y2;
    RAISE EXCEPTION 'rollover: a graduating årskurs of 13 was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE "AcademicYears" SET "graduatingGradeLevel" = 6 WHERE id = y2;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'rollover: an admin could not correct a graduating årskurs (% row(s))', n;
  END IF;

  -- Not its own predecessor.
  BEGIN
    INSERT INTO "AcademicYears" (id, "schoolId", name, "startDate", "endDate", "predecessorId", "updatedAt")
    VALUES (self, school, 'RLS19 sig själv', DATE '2099-08-15', DATE '2100-06-10', self, now());
    RAISE EXCEPTION 'rollover: a year was stored as its own predecessor';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "StudentGroups" (id, "schoolId", "academicYearId", name, "predecessorId", "updatedAt")
    VALUES (self, school, y2, 'RLS19 sig själv', self, now());
    RAISE EXCEPTION 'rollover: a group was stored as its own predecessor';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- One successor each: the unique keys.
  BEGIN
    INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "predecessorId", "updatedAt")
    VALUES (school, 'RLS19 år 2 igen', DATE '2096-08-15', DATE '2097-06-10', y1, now());
    RAISE EXCEPTION 'rollover: a year was rolled over twice';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "predecessorId", "updatedAt")
    VALUES (school, y2, 'RLS19 8A igen', g7, now());
    RAISE EXCEPTION 'rollover: a class got two successors';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- A predecessor outside the year before: LR409 ROLLOVER_LINK_MISMATCH.
  -- Two years back; the group's own year; a year with no predecessor at all;
  -- and the seed's running year, which is not in the chain.
  BEGIN
    INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "predecessorId", "updatedAt")
    VALUES (school, y3, 'RLS19 två år', g7b, now());
    RAISE EXCEPTION 'rollover: a group took a predecessor two years back';
  EXCEPTION WHEN SQLSTATE 'LR409' THEN
    IF SQLERRM NOT LIKE 'ROLLOVER_LINK_MISMATCH:%' THEN
      RAISE EXCEPTION 'rollover: two years back answered %', SQLERRM;
    END IF;
  END;
  BEGIN
    INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "predecessorId", "updatedAt")
    VALUES (school, y2, 'RLS19 samma år', loose, now());
    RAISE EXCEPTION 'rollover: a group took a predecessor in its own year';
  EXCEPTION WHEN SQLSTATE 'LR409' THEN
    IF SQLERRM NOT LIKE 'ROLLOVER_LINK_MISMATCH:%' THEN
      RAISE EXCEPTION 'rollover: the same year answered %', SQLERRM;
    END IF;
  END;
  BEGIN
    INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "predecessorId", "updatedAt")
    VALUES (school, y1, 'RLS19 inget år före', seed_group, now());
    RAISE EXCEPTION 'rollover: a group in a year with no predecessor took a predecessor';
  EXCEPTION WHEN SQLSTATE 'LR409' THEN
    IF SQLERRM NOT LIKE 'ROLLOVER_LINK_MISMATCH:%' THEN
      RAISE EXCEPTION 'rollover: a year with no predecessor answered %', SQLERRM;
    END IF;
  END;
  BEGIN
    INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "predecessorId", "updatedAt")
    VALUES (school, seed_year, 'RLS19 utanför kedjan', g7b, now());
    RAISE EXCEPTION 'rollover: a group in the running year took a predecessor from an unrelated year';
  EXCEPTION WHEN SQLSTATE 'LR409' THEN
    IF SQLERRM NOT LIKE 'ROLLOVER_LINK_MISMATCH:%' THEN
      RAISE EXCEPTION 'rollover: an unrelated year answered %', SQLERRM;
    END IF;
  END;

  -- Another school's year or group as the predecessor, under a row honestly
  -- stamped with this school: the composite keys', and only theirs.
  BEGIN
    INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "predecessorId", "updatedAt")
    VALUES (school, 'RLS19 efter skola B', DATE '2099-08-15', DATE '2100-06-10',
            current_setting('app.test_year_b')::uuid, now());
    RAISE EXCEPTION 'rollover: a year in school A took school B''s year as its predecessor';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "predecessorId", "updatedAt")
    VALUES (school, y2, 'RLS19 efter skola B', current_setting('app.test_group_b')::uuid, now());
    RAISE EXCEPTION 'rollover: a group in school A took school B''s class as its predecessor';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  -- A row stamped with school B: the policy's.
  BEGIN
    INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "predecessorId", "updatedAt")
    VALUES (current_setting('app.test_school_b')::uuid, 'RLS19 i skola B', DATE '2099-08-15', DATE '2100-06-10',
            current_setting('app.test_year_b')::uuid, now());
    RAISE EXCEPTION 'rollover: an admin wrote a successor year into another school';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- A linked group filed under school B's year: the plain academicYearId key
  -- lets it through, the trigger refuses it — and names nothing of school B.
  BEGIN
    INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "predecessorId", "updatedAt")
    VALUES (school, current_setting('app.test_year_b')::uuid, 'RLS19 i skola B:s år', g7b, now());
    RAISE EXCEPTION 'rollover: a linked group was filed under another school''s year';
  EXCEPTION WHEN SQLSTATE 'LR409' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT, det = PG_EXCEPTION_DETAIL;
    IF msg NOT LIKE 'ROLLOVER_LINK_MISMATCH:%' OR det NOT LIKE 'studentGroupId=%' THEN
      RAISE EXCEPTION 'rollover: a group in school B''s year answered % / %', msg, det;
    END IF;
    IF position(current_setting('app.test_year_b') IN msg || det) > 0
       OR position(current_setting('app.test_school_b') IN msg || det) > 0
       OR position(current_setting('app.test_group_b') IN msg || det) > 0 THEN
      RAISE EXCEPTION 'rollover: the refusal named school B''s rows: % / %', msg, det;
    END IF;
  END;

  -- Set once: no writer re-points, sets or clears a link. Not even a re-point
  -- to a group that would pass the year rule, and not a cycle.
  BEGIN
    UPDATE "AcademicYears" SET "predecessorId" = NULL WHERE id = y2;
    RAISE EXCEPTION 'rollover: a year''s link was cleared while its predecessor stands';
  EXCEPTION WHEN SQLSTATE 'LR409' THEN
    IF SQLERRM NOT LIKE 'ROLLOVER_LINK_IS_FIXED:%' THEN
      RAISE EXCEPTION 'rollover: clearing a year''s link answered %', SQLERRM;
    END IF;
  END;
  BEGIN
    UPDATE "AcademicYears" SET "predecessorId" = y3 WHERE id = y1;
    RAISE EXCEPTION 'rollover: a year was linked after the fact, into a cycle';
  EXCEPTION WHEN SQLSTATE 'LR409' THEN
    IF SQLERRM NOT LIKE 'ROLLOVER_LINK_IS_FIXED:%' THEN
      RAISE EXCEPTION 'rollover: a cycle answered %', SQLERRM;
    END IF;
  END;
  BEGIN
    UPDATE "AcademicYears" SET "predecessorId" = seed_year WHERE id = y1;
    RAISE EXCEPTION 'rollover: a year without a predecessor was given one after the fact';
  EXCEPTION WHEN SQLSTATE 'LR409' THEN
    IF SQLERRM NOT LIKE 'ROLLOVER_LINK_IS_FIXED:%' THEN
      RAISE EXCEPTION 'rollover: setting a year''s link answered %', SQLERRM;
    END IF;
  END;
  BEGIN
    UPDATE "StudentGroups" SET "predecessorId" = NULL WHERE id = g8;
    RAISE EXCEPTION 'rollover: a group''s link was cleared while its predecessor stands';
  EXCEPTION WHEN SQLSTATE 'LR409' THEN
    IF SQLERRM NOT LIKE 'ROLLOVER_LINK_IS_FIXED:%' THEN
      RAISE EXCEPTION 'rollover: clearing a group''s link answered %', SQLERRM;
    END IF;
  END;
  BEGIN
    UPDATE "StudentGroups" SET "predecessorId" = g7b WHERE id = g8;
    RAISE EXCEPTION 'rollover: 8A was re-pointed from 7A to 7B';
  EXCEPTION WHEN SQLSTATE 'LR409' THEN
    IF SQLERRM NOT LIKE 'ROLLOVER_LINK_IS_FIXED:%' THEN
      RAISE EXCEPTION 'rollover: re-pointing a group answered %', SQLERRM;
    END IF;
  END;
  BEGIN
    UPDATE "StudentGroups" SET "predecessorId" = g7b WHERE id = loose;
    RAISE EXCEPTION 'rollover: an unlinked group was given a predecessor after the fact';
  EXCEPTION WHEN SQLSTATE 'LR409' THEN
    IF SQLERRM NOT LIKE 'ROLLOVER_LINK_IS_FIXED:%' THEN
      RAISE EXCEPTION 'rollover: setting a group''s link answered %', SQLERRM;
    END IF;
  END;
  -- An UPDATE that names the column and leaves it as it was is no change.
  UPDATE "AcademicYears" SET "predecessorId" = "predecessorId", name = 'RLS19 år 2 (ny)' WHERE id = y2;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'rollover: an unchanged link refused a rename of its year (% row(s))', n;
  END IF;
  UPDATE "StudentGroups" SET "predecessorId" = g7 WHERE id = g8;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'rollover: rewriting a group''s link to the same value was refused (% row(s))', n;
  END IF;

  -- A group linked at either end stays in its year: LR409 ROLLOVER_GROUP_IS_LINKED.
  BEGIN
    UPDATE "StudentGroups" SET "academicYearId" = y3 WHERE id = g8;
    RAISE EXCEPTION 'rollover: a group with a predecessor moved to another year';
  EXCEPTION WHEN SQLSTATE 'LR409' THEN
    IF SQLERRM NOT LIKE 'ROLLOVER_GROUP_IS_LINKED:%' THEN
      RAISE EXCEPTION 'rollover: moving a successor answered %', SQLERRM;
    END IF;
  END;
  BEGIN
    UPDATE "StudentGroups" SET "academicYearId" = seed_year WHERE id = g7;
    RAISE EXCEPTION 'rollover: a group that is a predecessor moved to another year';
  EXCEPTION WHEN SQLSTATE 'LR409' THEN
    IF SQLERRM NOT LIKE 'ROLLOVER_GROUP_IS_LINKED:%' THEN
      RAISE EXCEPTION 'rollover: moving a predecessor answered %', SQLERRM;
    END IF;
  END;
  -- An unlinked group still moves, and a linked one is still renamed, retyped
  -- and regraded: the trigger guards the link and the year, nothing else.
  UPDATE "StudentGroups" SET "academicYearId" = y3 WHERE id = loose;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'rollover: an unlinked group could not change year (% row(s))', n;
  END IF;
  UPDATE "StudentGroups" SET "academicYearId" = y2 WHERE id = loose;
  UPDATE "StudentGroups" SET name = 'RLS19 8A (ny)', kind = 'TEACHING_GROUP', "gradeLevel" = 9 WHERE id = g8;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'rollover: a linked group could not be renamed, retyped or regraded (% row(s))', n;
  END IF;
  UPDATE "StudentGroups" SET name = 'RLS19 8A', kind = 'CLASS', "gradeLevel" = 8 WHERE id = g8;

  -- Every refusal above left the chain as it was.
  SELECT count(*) INTO n FROM "AcademicYears"
   WHERE (id, "predecessorId") IN ((y2, y1), (y3, y2)) OR (id = y1 AND "predecessorId" IS NULL);
  IF n <> 3 THEN
    RAISE EXCEPTION 'rollover: the year chain is not what the refused writes left it (% of 3)', n;
  END IF;
  SELECT count(*) INTO n FROM "StudentGroups"
   WHERE ((id, "predecessorId", "academicYearId") IN ((g8, g7, y2), (g9, g8, y3)))
      OR (id IN (g7, g7b) AND "predecessorId" IS NULL AND "academicYearId" = y1)
      OR (id = loose AND "predecessorId" IS NULL AND "academicYearId" = y2);
  IF n <> 5 THEN
    RAISE EXCEPTION 'rollover: the group chain is not what the refused writes left it (% of 5)', n;
  END IF;
END
$$;

-- A teacher reads the links (a year and a group are staff reading) and writes
-- none of them: no successor year, no linked group, no clearing, no move.
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
DECLARE school uuid := app.current_school_id(); y3 uuid; g9 uuid; n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'TEACHER' THEN
    RAISE EXCEPTION 'rollover: expected to be acting as a TEACHER of school A, am %', app.current_user_role();
  END IF;
  SELECT count(*) INTO n FROM "AcademicYears" WHERE name LIKE 'RLS19 %' AND "predecessorId" IS NOT NULL;
  IF n <> 2 THEN
    RAISE EXCEPTION 'rollover: a teacher reads % linked years, expected 2', n;
  END IF;
  SELECT id INTO y3 FROM "AcademicYears" WHERE name = 'RLS19 år 3';
  SELECT id INTO g9 FROM "StudentGroups" WHERE name = 'RLS19 9A';
  IF y3 IS NULL OR g9 IS NULL THEN
    RAISE EXCEPTION 'rollover: a teacher cannot read the chain''s last year (%) or class (%)', y3, g9;
  END IF;

  BEGIN
    INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "predecessorId", "updatedAt")
    VALUES (school, 'RLS19 lärarens år', DATE '2098-08-15', DATE '2099-06-10', y3, now());
    RAISE EXCEPTION 'rollover: a teacher rolled a year over';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "predecessorId", "updatedAt")
    VALUES (school, y3, 'RLS19 lärarens grupp', g9, now());
    RAISE EXCEPTION 'rollover: a teacher wrote a linked group';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  UPDATE "AcademicYears" SET "predecessorId" = NULL, "graduatingGradeLevel" = 3 WHERE name LIKE 'RLS19 %';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'rollover: a teacher rewrote % years'' links', n;
  END IF;
  UPDATE "StudentGroups" SET "predecessorId" = NULL WHERE name LIKE 'RLS19 %';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'rollover: a teacher cleared % groups'' links', n;
  END IF;
  UPDATE "StudentGroups" SET "academicYearId" = y3 WHERE name LIKE 'RLS19 %';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'rollover: a teacher moved % groups', n;
  END IF;
  DELETE FROM "AcademicYears" WHERE name LIKE 'RLS19 %';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'rollover: a teacher deleted % years', n;
  END IF;
END
$$;

-- A pupil writes none of it either.
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',
    (SELECT "authId" FROM "Users"
      WHERE "schoolId" = app.current_school_id() AND role = 'STUDENT'
      ORDER BY "authId" LIMIT 1)
  )::text,
  true
);

DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'STUDENT' THEN
    RAISE EXCEPTION 'rollover: expected to be acting as a STUDENT of school A, am %', app.current_user_role();
  END IF;
  UPDATE "AcademicYears" SET "predecessorId" = NULL WHERE name LIKE 'RLS19 %';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'rollover: a pupil rewrote % years'' links', n;
  END IF;
  UPDATE "StudentGroups" SET "predecessorId" = NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'rollover: a pupil cleared % groups'' links', n;
  END IF;
END
$$;

-- The SS12000 service principal INSERTs groups (student_groups_service_insert)
-- and meets the same rule; it updates none.
SELECT set_config('request.jwt.claims', '', true);
SELECT set_config('app.service_school_id', :'school_a', true);

DO $$
DECLARE school uuid := app.current_service_school_id(); y3 uuid; g7b uuid; n bigint;
BEGIN
  IF app.current_user_id() IS NOT NULL OR school IS NULL THEN
    RAISE EXCEPTION 'rollover: the service principal is not alone in force (user %, school %)',
      app.current_user_id(), school;
  END IF;
  SELECT id INTO y3 FROM "AcademicYears" WHERE name = 'RLS19 år 3';
  SELECT id INTO g7b FROM "StudentGroups" WHERE name = 'RLS19 7B';
  IF y3 IS NULL OR g7b IS NULL THEN
    RAISE EXCEPTION 'rollover: the service principal cannot read its own school''s year (%) or group (%)', y3, g7b;
  END IF;
  BEGIN
    INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "predecessorId", "updatedAt")
    VALUES (school, y3, 'RLS19 importerad', g7b, now());
    RAISE EXCEPTION 'rollover: the service principal imported a group linked two years back';
  EXCEPTION WHEN SQLSTATE 'LR409' THEN
    IF SQLERRM NOT LIKE 'ROLLOVER_LINK_MISMATCH:%' THEN
      RAISE EXCEPTION 'rollover: the service principal''s wrong link answered %', SQLERRM;
    END IF;
  END;
  UPDATE "StudentGroups" SET "predecessorId" = NULL WHERE name LIKE 'RLS19 %';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'rollover: the service principal cleared % groups'' links', n;
  END IF;
END
$$;

-- Back as the admin: the deletes that must pass, and what they leave.
SELECT set_config('app.service_school_id', '', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'admin_auth_id')::text,
  true
);

DO $$
DECLARE
  school uuid := app.current_school_id();
  y1 uuid; y2 uuid; y3 uuid; y4 uuid;
  g7 uuid; g8 uuid; g9 uuid; g9b uuid; loose uuid;
  y2_before jsonb; g8_before jsonb;
  n bigint;
BEGIN
  IF app.current_user_role() <> 'SCHOOL_ADMIN' THEN
    RAISE EXCEPTION 'rollover: expected to be back as the admin, am %', app.current_user_role();
  END IF;
  SELECT id INTO y1 FROM "AcademicYears" WHERE name = 'RLS19 år 1';
  SELECT id INTO y2 FROM "AcademicYears" WHERE name = 'RLS19 år 2 (ny)';
  SELECT id INTO y3 FROM "AcademicYears" WHERE name = 'RLS19 år 3';
  SELECT id INTO g7 FROM "StudentGroups" WHERE name = 'RLS19 7A';
  SELECT id INTO g8 FROM "StudentGroups" WHERE name = 'RLS19 8A';
  SELECT id INTO g9 FROM "StudentGroups" WHERE name = 'RLS19 9A';
  SELECT id INTO loose FROM "StudentGroups" WHERE name = 'RLS19 språkval';
  IF y2 IS NULL OR g9 IS NULL THEN
    RAISE EXCEPTION 'rollover: the chain did not survive the other roles'' writes (year 2 %, 9A %)', y2, g9;
  END IF;

  -- The successor year deleted (the undo of a rollover): its class goes with
  -- it, and the year and class it continued are exactly as they were.
  SELECT to_jsonb(y) INTO y2_before FROM "AcademicYears" y WHERE id = y2;
  SELECT to_jsonb(g) INTO g8_before FROM "StudentGroups" g WHERE id = g8;
  DELETE FROM "AcademicYears" WHERE id = y3;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'rollover: an admin could not delete a successor year (% row(s))', n;
  END IF;
  SELECT count(*) INTO n FROM "StudentGroups" WHERE id = g9;
  IF n <> 0 THEN
    RAISE EXCEPTION 'rollover: a deleted year kept its class';
  END IF;
  IF (SELECT to_jsonb(y) FROM "AcademicYears" y WHERE id = y2) IS DISTINCT FROM y2_before
     OR (SELECT to_jsonb(g) FROM "StudentGroups" g WHERE id = g8) IS DISTINCT FROM g8_before THEN
    RAISE EXCEPTION 'rollover: deleting the successor year changed the year or class it continued';
  END IF;

  -- The predecessor year deleted: its classes cascade, and the successor year
  -- and its classes stand, with the links cleared by the foreign keys — no
  -- LR409 (any error here fails the suite) — and the graduating årskurs kept.
  DELETE FROM "AcademicYears" WHERE id = y1;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'rollover: an admin could not delete a predecessor year (% row(s))', n;
  END IF;
  SELECT count(*) INTO n FROM "AcademicYears"
   WHERE id = y2 AND "predecessorId" IS NULL AND "graduatingGradeLevel" = 6 AND "schoolId" = school;
  IF n <> 1 THEN
    RAISE EXCEPTION 'rollover: deleting the predecessor year did more than clear the successor''s link';
  END IF;
  SELECT count(*) INTO n FROM "StudentGroups"
   WHERE id = g8 AND "predecessorId" IS NULL AND "academicYearId" = y2 AND "schoolId" = school;
  IF n <> 1 THEN
    RAISE EXCEPTION 'rollover: deleting the predecessor year did more than clear the successor class''s link';
  END IF;
  SELECT count(*) INTO n FROM "StudentGroups" WHERE id = g7;
  IF n <> 0 THEN
    RAISE EXCEPTION 'rollover: a deleted year kept its class';
  END IF;

  -- A predecessor GROUP deleted on its own: the successor stands, unlinked,
  -- and a cleared link is not set again.
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "predecessorId", "updatedAt")
  VALUES (school, 'RLS19 år 4', DATE '2097-08-15', DATE '2098-06-10', y2, now()) RETURNING id INTO y4;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "predecessorId", "updatedAt")
  VALUES (school, y4, 'RLS19 9A igen', 9, g8, now()) RETURNING id INTO g9b;
  DELETE FROM "StudentGroups" WHERE id = g8;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'rollover: an admin could not delete a predecessor class (% row(s))', n;
  END IF;
  SELECT count(*) INTO n FROM "StudentGroups" WHERE id = g9b AND "predecessorId" IS NULL AND "academicYearId" = y4;
  IF n <> 1 THEN
    RAISE EXCEPTION 'rollover: deleting a predecessor class did more than clear its successor''s link';
  END IF;
  BEGIN
    UPDATE "StudentGroups" SET "predecessorId" = loose WHERE id = g9b;
    RAISE EXCEPTION 'rollover: a cleared link was set again';
  EXCEPTION WHEN SQLSTATE 'LR409' THEN
    IF SQLERRM NOT LIKE 'ROLLOVER_LINK_IS_FIXED:%' THEN
      RAISE EXCEPTION 'rollover: re-setting a cleared link answered %', SQLERRM;
    END IF;
  END;
END
$$;
ROLLBACK;

-- The catalog half: the keys, the CHECKs, both triggers enabled and SECURITY
-- DEFINER in schema app, and no EXECUTE for PUBLIC or the API role.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM pg_constraint
   WHERE contype = 'f' AND confdeltype = 'n'
     AND (conrelid, conname) IN (
       ('public."AcademicYears"'::regclass, 'AcademicYears_predecessorId_schoolId_fkey'),
       ('public."StudentGroups"'::regclass, 'StudentGroups_predecessorId_schoolId_fkey'))
     -- SET NULL of the link column only: schoolId is NOT NULL.
     AND array_length(confdelsetcols, 1) = 1;
  IF n <> 2 THEN
    RAISE EXCEPTION 'rollover: % of the two predecessor keys are ON DELETE SET NULL ("predecessorId")', n;
  END IF;
  SELECT count(*) INTO n FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE i.indisunique AND c.relname IN ('AcademicYears_predecessorId_schoolId_key', 'StudentGroups_predecessorId_schoolId_key');
  IF n <> 2 THEN
    RAISE EXCEPTION 'rollover: % of the two one-successor keys exist', n;
  END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE contype = 'c' AND conname IN ('AcademicYears_is_not_its_own_predecessor',
                                       'AcademicYears_graduatingGradeLevel_is_sane',
                                       'StudentGroups_is_not_its_own_predecessor');
  IF n <> 3 THEN
    RAISE EXCEPTION 'rollover: % of the three CHECKs exist', n;
  END IF;
  SELECT count(*) INTO n
    FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
   WHERE NOT t.tgisinternal AND t.tgenabled = 'O' AND p.prosecdef
     AND p.pronamespace = 'app'::regnamespace
     AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
     AND NOT has_function_privilege('app_authenticated', p.oid, 'EXECUTE')
     AND (t.tgrelid, t.tgname) IN (
       ('public."AcademicYears"'::regclass, 'AcademicYears_predecessor_is_fixed'),
       ('public."StudentGroups"'::regclass, 'StudentGroups_predecessor_is_last_years'));
  IF n <> 2 THEN
    RAISE EXCEPTION 'rollover: % of the two link triggers are present, enabled, SECURITY DEFINER in app and closed to PUBLIC', n;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Section 20: a carried tjänst is an ordinary row.
--
-- Staffing Fas 5 carries tjänster and uppdrag into the next läsår, inside the
-- rollover and afterwards into a year rolled without them. It adds no policy,
-- no trigger and no column: a carried post is a TeacherEmployments row of the
-- new year, a carried uppdrag a TeacherDuties row linked to a NEW weekly
-- UNAVAILABLE TEACHER constraint with the reason 'Uppdrag'. Everything this
-- section asserts is therefore a claim that the arms written for Fas 1 and
-- Fas 2 already hold for those rows, written as the carry writes them:
--
--  - the admin writes them, and the Fas 2 link guard (TD409) refuses the same
--    duty pointed at a colleague's constraint, carry or not;
--  - the first teacher reads exactly their own post and uppdrag of the new
--    year, none of the colleague's, writes no post, and may not move or
--    delete the slot their carried uppdrag holds (TD403);
--  - the colleague reads that slot through availability_teacher_select, with
--    the reason 'Uppdrag' and nothing of the uppdrag behind it, and none of
--    the first teacher's posts or uppdrag in either year (C20: the HR
--    argument, made concrete);
--  - a pupil and a guardian read none of it;
--  - deleting the new year takes its posts, its uppdrag and the carried slot,
--    and leaves the source year's uppdrag and slot as they were.
--
-- Two years of its own, linked as the rollover links them, with one class in
-- each, so the seed's active year is untouched and the whole runs in one
-- transaction that is rolled back.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'admin_auth_id')::text,
  true
);

DO $$
DECLARE
  school uuid := app.current_school_id();
  me uuid; colleague uuid;
  y1 uuid; y2 uuid; g7 uuid; g8 uuid;
  s_old uuid; c_new uuid; c_col uuid;
  n bigint;
BEGIN
  IF app.current_user_role() <> 'SCHOOL_ADMIN' THEN
    RAISE EXCEPTION 'carried: expected to be acting as an admin, am %', app.current_user_role();
  END IF;
  -- Section 17's two teachers, by the same ordering.
  SELECT id INTO me FROM "Users"
   WHERE "schoolId" = school AND role = 'TEACHER' ORDER BY "authId" LIMIT 1;
  SELECT id INTO colleague FROM "Users"
   WHERE "schoolId" = school AND role = 'TEACHER' ORDER BY "authId" OFFSET 1 LIMIT 1;
  IF me IS NULL OR colleague IS NULL THEN
    RAISE EXCEPTION 'carried: the seed lacks two teachers (%, %)', me, colleague;
  END IF;

  -- The source year and its successor, a class in each, linked.
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "updatedAt")
  VALUES (school, 'RLS20 källa', DATE '2089-08-15', DATE '2090-06-10', now()) RETURNING id INTO y1;
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "predecessorId", "graduatingGradeLevel", "updatedAt")
  VALUES (school, 'RLS20 mål', DATE '2090-08-15', DATE '2091-06-10', y1, 9, now()) RETURNING id INTO y2;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt")
  VALUES (school, y1, 'RLS20 7A', 7, now()) RETURNING id INTO g7;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "predecessorId", "updatedAt")
  VALUES (school, y2, 'RLS20 8A', 8, g7, now()) RETURNING id INTO g8;

  -- The source year's rows: both posts, the first teacher's mentorskap with its slot.
  INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", "reductionPercent", signature, "updatedAt")
  VALUES (school, me, y1, 100, 10, 'R20A', now()), (school, colleague, y1, 80, 0, 'R20B', now());
  INSERT INTO "AvailabilityConstraints" ("schoolId", "resourceType", "userId", "dayOfWeek", "startTime", "endTime", type, reason, "updatedAt")
  VALUES (school, 'TEACHER', me, 2, '15:00', '15:30', 'UNAVAILABLE', 'Uppdrag', now()) RETURNING id INTO s_old;
  INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek",
                               "studentGroupId", "updatedAt")
  VALUES (school, me, y1, 'MENTORSKAP', 'RLS20 Mentor 7A', 60, g7, now());
  INSERT INTO "TeacherDutySlots" ("schoolId", "teacherDutyId", "availabilityConstraintId")
  SELECT school, d.id, s_old FROM "TeacherDuties" d WHERE d.label = 'RLS20 Mentor 7A';

  -- The carry's writes, in its order and shape: the posts (the same
  -- signatures, which the per-year key allows), a NEW slot from the builder's
  -- columns (the ones it leaves empty written as NULL), and the uppdrag on
  -- the successor class, relabelled, linked to the new slot. The colleague
  -- gets an uppdrag without a slot, so the first teacher's reads below have
  -- something of theirs to not see.
  INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", "reductionPercent", signature, "updatedAt")
  VALUES (school, me, y2, 100, 10, 'R20A', now()), (school, colleague, y2, 80, 0, 'R20B', now());
  INSERT INTO "AvailabilityConstraints" ("schoolId", "resourceType", "userId", "roomId", "studentGroupId",
                                         "minGradeLevel", "maxGradeLevel", "dayOfWeek", "date",
                                         "startTime", "endTime", type, reason, "updatedAt")
  VALUES (school, 'TEACHER', me, NULL, NULL, NULL, NULL, 2, NULL, '15:00', '15:30', 'UNAVAILABLE', 'Uppdrag', now())
  RETURNING id INTO c_new;
  INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek",
                               "studentGroupId", "updatedAt")
  VALUES (school, me, y2, 'MENTORSKAP', 'RLS20 Mentor 8A', 60, g8, now());
  INSERT INTO "TeacherDutySlots" ("schoolId", "teacherDutyId", "availabilityConstraintId")
  SELECT school, d.id, c_new FROM "TeacherDuties" d WHERE d.label = 'RLS20 Mentor 8A';
  INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "updatedAt")
  VALUES (school, colleague, y2, 'RASTVAKT', 'RLS20 Rastvakt', 30, now());
  SELECT count(*) INTO n FROM "TeacherDuties" WHERE "academicYearId" = y2;
  IF n <> 2 THEN
    RAISE EXCEPTION 'carried: an admin could not write the carried uppdrag (% row(s))', n;
  END IF;
  IF c_new = s_old THEN
    RAISE EXCEPTION 'carried: the carried uppdrag shares the source year''s slot';
  END IF;

  -- The same uppdrag pointed at the colleague's constraint: the Fas 2 guard
  -- refuses it whoever writes it. Only TD409 is caught.
  INSERT INTO "AvailabilityConstraints" ("schoolId", "resourceType", "userId", "dayOfWeek", "startTime", "endTime", type, reason, "updatedAt")
  VALUES (school, 'TEACHER', colleague, 2, '15:00', '15:30', 'UNAVAILABLE', 'Uppdrag', now()) RETURNING id INTO c_col;
  BEGIN
    INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek",
                                 "studentGroupId", "updatedAt")
    VALUES (school, me, y2, 'MENTORSKAP', 'RLS20 Fel lärare', 60, g8, now());
    INSERT INTO "TeacherDutySlots" ("schoolId", "teacherDutyId", "availabilityConstraintId")
    SELECT school, d.id, c_col FROM "TeacherDuties" d WHERE d.label = 'RLS20 Fel lärare';
    RAISE EXCEPTION 'carried: a carried uppdrag took the colleague''s constraint as its slot';
  EXCEPTION WHEN SQLSTATE 'TD409' THEN NULL;
  END;
  DELETE FROM "AvailabilityConstraints" WHERE id = c_col;

  -- Handed to the blocks below, which act as people who cannot read these.
  PERFORM set_config('app.test_rls20_y1', y1::text, true);
  PERFORM set_config('app.test_rls20_y2', y2::text, true);
  PERFORM set_config('app.test_rls20_me', me::text, true);
  PERFORM set_config('app.test_rls20_slot', c_new::text, true);
  PERFORM set_config('app.test_rls20_old_slot', s_old::text, true);
END
$$;

-- As the first teacher: their own carried post and uppdrag, nothing of the
-- colleague's, no post written, and the carried slot not theirs to move.
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
DECLARE
  me uuid := app.current_user_id();
  y2 uuid := current_setting('app.test_rls20_y2')::uuid;
  slot uuid := current_setting('app.test_rls20_slot')::uuid;
  n bigint;
BEGIN
  IF me IS NULL OR app.current_user_role() <> 'TEACHER' OR me <> current_setting('app.test_rls20_me')::uuid THEN
    RAISE EXCEPTION 'carried: expected to be acting as the first TEACHER of school A, am % (%)',
      app.current_user_role(), me;
  END IF;
  SELECT count(*) INTO n FROM "TeacherEmployments" WHERE "academicYearId" = y2;
  IF n <> 1 THEN
    RAISE EXCEPTION 'carried: a teacher reads % posts in the new year, expected exactly their own', n;
  END IF;
  SELECT count(*) INTO n FROM "TeacherEmployments" WHERE "academicYearId" = y2 AND "userId" = me AND "reductionPercent" = 10;
  IF n <> 1 THEN
    RAISE EXCEPTION 'carried: a teacher cannot read their own carried post';
  END IF;
  SELECT count(*) INTO n FROM "TeacherDuties" WHERE "academicYearId" = y2;
  IF n <> 1 THEN
    RAISE EXCEPTION 'carried: a teacher reads % uppdrag in the new year, expected exactly their own', n;
  END IF;
  SELECT count(*) INTO n FROM "TeacherDuties" d
    JOIN "TeacherDutySlots" s ON s."teacherDutyId" = d.id AND s."schoolId" = d."schoolId"
   WHERE d."academicYearId" = y2 AND s."availabilityConstraintId" = slot;
  IF n <> 1 THEN
    RAISE EXCEPTION 'carried: a teacher cannot read their own carried uppdrag with its slot';
  END IF;
  SELECT count(*) INTO n FROM "TeacherDuties" WHERE "userId" <> me;
  IF n <> 0 THEN
    RAISE EXCEPTION 'carried: a teacher reads % of a colleague''s uppdrag', n;
  END IF;
  SELECT count(*) INTO n FROM "TeacherEmployments" WHERE "userId" <> me;
  IF n <> 0 THEN
    RAISE EXCEPTION 'carried: a teacher reads % of a colleague''s posts', n;
  END IF;

  -- No post written: not a new one, not their own carried one.
  BEGIN
    INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", "updatedAt")
    VALUES (app.current_school_id(), me, current_setting('app.test_rls20_y1')::uuid, 50, now());
    RAISE EXCEPTION 'carried: a teacher wrote themselves a post';
  EXCEPTION WHEN insufficient_privilege OR unique_violation THEN NULL;
  END;
  UPDATE "TeacherEmployments" SET "reductionPercent" = 0, "updatedAt" = now() WHERE "academicYearId" = y2;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'carried: a teacher rewrote % carried post(s)', n;
  END IF;
  DELETE FROM "TeacherEmployments" WHERE "academicYearId" = y2;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'carried: a teacher deleted % carried post(s)', n;
  END IF;

  -- The carried slot is their own TEACHER row, which availability_teacher_modify
  -- admits; the Fas 2 trigger refuses it because a duty holds it.
  BEGIN
    UPDATE "AvailabilityConstraints" SET "startTime" = '14:30' WHERE id = slot;
    RAISE EXCEPTION 'carried: a teacher moved the slot their carried uppdrag holds';
  EXCEPTION WHEN SQLSTATE 'TD403' THEN NULL;
  END;
  BEGIN
    DELETE FROM "AvailabilityConstraints" WHERE id = slot;
    RAISE EXCEPTION 'carried: a teacher deleted the slot their carried uppdrag holds';
  EXCEPTION WHEN SQLSTATE 'TD403' THEN NULL;
  END;
END
$$;

-- As the colleague: the carried slot is a time the first teacher is busy,
-- 'Uppdrag' and nothing more; their post and uppdrag stay theirs.
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',
    (SELECT "authId" FROM "Users"
      WHERE "schoolId" = app.current_school_id() AND role = 'TEACHER'
      ORDER BY "authId" OFFSET 1 LIMIT 1)
  )::text,
  true
);

DO $$
DECLARE
  me uuid := current_setting('app.test_rls20_me')::uuid;
  y2 uuid := current_setting('app.test_rls20_y2')::uuid;
  why text; n bigint;
BEGIN
  IF app.current_user_role() <> 'TEACHER' OR app.current_user_id() = me THEN
    RAISE EXCEPTION 'carried: expected to be acting as the colleague, am % (%)', app.current_user_role(), app.current_user_id();
  END IF;
  SELECT count(*), max(reason) INTO n, why FROM "AvailabilityConstraints"
   WHERE id = current_setting('app.test_rls20_slot')::uuid;
  IF n <> 1 OR why IS DISTINCT FROM 'Uppdrag' THEN
    RAISE EXCEPTION 'carried: the colleague reads the carried slot % time(s) with reason %, expected once with ''Uppdrag''', n, why;
  END IF;
  SELECT count(*) INTO n FROM "TeacherDuties" WHERE "userId" = me;
  IF n <> 0 THEN
    RAISE EXCEPTION 'carried: the colleague reads % of the first teacher''s uppdrag', n;
  END IF;
  SELECT count(*) INTO n FROM "TeacherEmployments" WHERE "userId" = me;
  IF n <> 0 THEN
    RAISE EXCEPTION 'carried: the colleague reads % of the first teacher''s posts', n;
  END IF;
  -- Not vacuous: the colleague does read their own carried rows.
  SELECT count(*) INTO n FROM "TeacherEmployments" WHERE "academicYearId" = y2;
  IF n <> 1 THEN
    RAISE EXCEPTION 'carried: the colleague reads % posts in the new year, expected their own one', n;
  END IF;
  SELECT count(*) INTO n FROM "TeacherDuties" WHERE "academicYearId" = y2;
  IF n <> 1 THEN
    RAISE EXCEPTION 'carried: the colleague reads % uppdrag in the new year, expected their own one', n;
  END IF;
END
$$;

-- A pupil and a guardian of the same school: none of it.
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',
    (SELECT "authId" FROM "Users"
      WHERE "schoolId" = app.current_school_id() AND role = 'STUDENT'
      ORDER BY "authId" LIMIT 1)
  )::text,
  true
);

DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'STUDENT' THEN
    RAISE EXCEPTION 'carried: expected to be acting as a STUDENT of school A, resolved role %',
      coalesce(app.current_user_role()::text, '<none>');
  END IF;
  SELECT (SELECT count(*) FROM "TeacherEmployments") + (SELECT count(*) FROM "TeacherDuties") INTO n;
  IF n <> 0 THEN
    RAISE EXCEPTION 'carried: a pupil reads % posts or uppdrag', n;
  END IF;
END
$$;

SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-4000-8000-000000000004')::text,
  true
);

DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'GUARDIAN' THEN
    RAISE EXCEPTION 'carried: expected to be acting as a GUARDIAN of school A, resolved role %',
      coalesce(app.current_user_role()::text, '<none>');
  END IF;
  SELECT (SELECT count(*) FROM "TeacherEmployments") + (SELECT count(*) FROM "TeacherDuties") INTO n;
  IF n <> 0 THEN
    RAISE EXCEPTION 'carried: a guardian reads % posts or uppdrag', n;
  END IF;
END
$$;

-- Back as the admin: the teachers' writes changed nothing, and deleting the
-- new year takes everything carried into it and nothing of the source.
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'admin_auth_id')::text,
  true
);

DO $$
DECLARE
  y1 uuid := current_setting('app.test_rls20_y1')::uuid;
  y2 uuid := current_setting('app.test_rls20_y2')::uuid;
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM "TeacherEmployments" WHERE "academicYearId" = y2 AND "reductionPercent" IN (10, 0);
  IF n <> 2 THEN
    RAISE EXCEPTION 'carried: % of the two carried posts survive the teachers'' refused writes', n;
  END IF;
  SELECT count(*) INTO n FROM "AvailabilityConstraints"
   WHERE id = current_setting('app.test_rls20_slot')::uuid AND "startTime" = '15:00';
  IF n <> 1 THEN
    RAISE EXCEPTION 'carried: the carried slot moved or vanished under the teacher''s refused writes';
  END IF;

  DELETE FROM "AcademicYears" WHERE id = y2;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'carried: an admin could not delete the new year (% row(s))', n;
  END IF;
  SELECT (SELECT count(*) FROM "TeacherEmployments" WHERE "academicYearId" = y2)
       + (SELECT count(*) FROM "TeacherDuties" WHERE "academicYearId" = y2) INTO n;
  IF n <> 0 THEN
    RAISE EXCEPTION 'carried: a deleted year kept % carried post(s) or uppdrag', n;
  END IF;
  SELECT count(*) INTO n FROM "AvailabilityConstraints" WHERE id = current_setting('app.test_rls20_slot')::uuid;
  IF n <> 0 THEN
    RAISE EXCEPTION 'carried: a deleted year''s carried uppdrag left its slot behind';
  END IF;
  SELECT count(*) INTO n FROM "TeacherDuties" d
    JOIN "TeacherDutySlots" s ON s."teacherDutyId" = d.id AND s."schoolId" = d."schoolId"
    JOIN "AvailabilityConstraints" c ON c.id = s."availabilityConstraintId"
   WHERE d."academicYearId" = y1 AND c.id = current_setting('app.test_rls20_old_slot')::uuid
     AND c."dayOfWeek" = 2 AND c."startTime" = '15:00';
  IF n <> 1 THEN
    RAISE EXCEPTION 'carried: deleting the new year touched the source year''s uppdrag or its slot';
  END IF;
  SELECT count(*) INTO n FROM "TeacherEmployments" WHERE "academicYearId" = y1;
  IF n <> 2 THEN
    RAISE EXCEPTION 'carried: deleting the new year took % of the source year''s two posts', 2 - n;
  END IF;
END
$$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 21: a timplanspost's lektionslängder are one canonical list, whoever
-- writes it.
--
-- 20261008090000 adds TeachingRequirements."lessonLengths" INTEGER[] NOT NULL
-- DEFAULT '{}' and the CHECK TeachingRequirements_lesson_lengths_are_canonical,
-- which calls app.lesson_lengths_are_canonical. No policy changes: the column
-- sits on a table whose arms are row predicates. What this section proves is
-- the CHECK, through the SQL a SCHOOL_ADMIN's PostgREST PATCH sends, because
-- that writer never meets the DTO or the service:
--
--  - the catalog: the column's type, nullability and default, the CHECK, and
--    the function IMMUTABLE, not SECURITY DEFINER, not STRICT (a STRICT
--    function answers NULL to a NULL, and a CHECK passes on NULL);
--  - accepted: {80,40} at (2, 80), then back to '{}' at (2, 80) — both as the
--    admin, so EXECUTE left to PUBLIC is what lets the writer's CHECK run;
--  - refused 23514: a split row PATCHed with lessonsPerWeek alone, {60,60}
--    (uniform written as a list), {60,42} (off the grid), {40,80} (unsorted),
--    four different lengths, a list starting at subscript 0, {80,40,NULL}
--    (bool_and and count(DISTINCT) skip a NULL; the explicit test and the
--    coalesce do not) and a two-dimensional array;
--  - a teacher's UPDATE touches no row (teaching_requirements_staff_select is
--    the only arm a teacher has), so the list is the admin's to write.
--
-- Its own year, subject and class, in one transaction that is rolled back.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'admin_auth_id')::text,
  true
);

DO $$
DECLARE
  school uuid := app.current_school_id();
  y uuid; s uuid; g uuid; r uuid;
  n bigint;
  bad record;
BEGIN
  IF app.current_user_role() <> 'SCHOOL_ADMIN' THEN
    RAISE EXCEPTION 'lengths: expected to be acting as an admin, am %', app.current_user_role();
  END IF;

  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'TeachingRequirements'
     AND column_name = 'lessonLengths' AND data_type = 'ARRAY' AND udt_name = '_int4'
     AND is_nullable = 'NO' AND column_default = '''{}''::integer[]';
  IF n <> 1 THEN
    RAISE EXCEPTION 'lengths: TeachingRequirements.lessonLengths is not an int[] NOT NULL DEFAULT ''{}''';
  END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public."TeachingRequirements"'::regclass AND contype = 'c'
     AND conname = 'TeachingRequirements_lesson_lengths_are_canonical';
  IF n <> 1 THEN
    RAISE EXCEPTION 'lengths: the canonical-list CHECK is missing';
  END IF;
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'app' AND p.proname = 'lesson_lengths_are_canonical'
     AND p.provolatile = 'i' AND NOT p.prosecdef AND NOT p.proisstrict;
  IF n <> 1 THEN
    RAISE EXCEPTION 'lengths: app.lesson_lengths_are_canonical is not IMMUTABLE, invoker-rights and non-STRICT';
  END IF;

  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "updatedAt")
  VALUES (school, 'RLS21 läsår', DATE '2093-08-15', DATE '2094-06-10', now()) RETURNING id INTO y;
  INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt")
  VALUES (school, 'RLS21 idrott', 'RLS21ID', now()) RETURNING id INTO s;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt")
  VALUES (school, y, 'RLS21 7A', 7, now()) RETURNING id INTO g;
  INSERT INTO "TeachingRequirements"
    ("schoolId", "academicYearId", "subjectId", "studentGroupId", "lessonsPerWeek", "minutesPerLesson", "updatedAt")
  VALUES (school, y, s, g, 2, 60, now()) RETURNING id INTO r;
  SELECT count(*) INTO n FROM "TeachingRequirements" WHERE id = r AND "lessonLengths" = '{}';
  IF n <> 1 THEN
    RAISE EXCEPTION 'lengths: a row written without the column did not get ''{}''';
  END IF;

  -- Accepted: the split, written with its scalars in one statement.
  UPDATE "TeachingRequirements"
     SET "lessonLengths" = '{80,40}', "lessonsPerWeek" = 2, "minutesPerLesson" = 80
   WHERE id = r;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'lengths: an admin could not write {80,40} at (2, 80) (% row(s))', n;
  END IF;

  -- Refused: a half-write of a split row, and every non-canonical list.
  BEGIN
    UPDATE "TeachingRequirements" SET "lessonsPerWeek" = 3 WHERE id = r;
    RAISE EXCEPTION 'lengths: lessonsPerWeek alone on a split row was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  FOR bad IN
    SELECT * FROM (VALUES
      ('{60,60}'::int[], 2, 60, 'a uniform row written as a list'),
      ('{60,42}'::int[], 2, 60, 'a length off the grid'),
      ('{40,80}'::int[], 2, 40, 'a list not sorted longest first'),
      ('{90,80,60,40}'::int[], 4, 90, 'four different lengths'),
      ('[0:1]={80,40}'::int[], 2, 80, 'a list starting at subscript 0'),
      ('{80,40,NULL}'::int[], 3, 80, 'a list holding a NULL'),
      ('{{80,40}}'::int[], 2, 80, 'a two-dimensional array'),
      ('{245,40}'::int[], 2, 245, 'a length above 240'),
      ('{80,40}'::int[], 3, 80, 'a count that disagrees with the list'),
      ('{80,40}'::int[], 2, 60, 'a longest that disagrees with the list')
    ) AS v(lengths, lessons, longest, why)
  LOOP
    BEGIN
      UPDATE "TeachingRequirements"
         SET "lessonLengths" = bad.lengths, "lessonsPerWeek" = bad.lessons, "minutesPerLesson" = bad.longest
       WHERE id = r;
      RAISE EXCEPTION 'lengths: % was accepted', bad.why;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;

  SELECT count(*) INTO n FROM "TeachingRequirements"
   WHERE id = r AND "lessonLengths" = '{80,40}' AND "lessonsPerWeek" = 2 AND "minutesPerLesson" = 80;
  IF n <> 1 THEN
    RAISE EXCEPTION 'lengths: a refused write changed the split row';
  END IF;

  PERFORM set_config('app.test_rls21_requirement', r::text, true);
END
$$;

-- As a teacher of the same school: the row is readable and not writable.
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
DECLARE
  r uuid := current_setting('app.test_rls21_requirement')::uuid;
  n bigint;
BEGIN
  IF app.current_user_role() <> 'TEACHER' THEN
    RAISE EXCEPTION 'lengths: expected to be acting as a TEACHER, am %', app.current_user_role();
  END IF;
  SELECT count(*) INTO n FROM "TeachingRequirements" WHERE id = r AND "lessonLengths" = '{80,40}';
  IF n <> 1 THEN
    RAISE EXCEPTION 'lengths: a teacher cannot read the split row (% row(s))', n;
  END IF;
  UPDATE "TeachingRequirements"
     SET "lessonLengths" = '{}', "lessonsPerWeek" = 2, "minutesPerLesson" = 80
   WHERE id = r;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'lengths: a teacher rewrote the lengths of % row(s)', n;
  END IF;
END
$$;

-- Back as the admin: the teacher changed nothing, and '{}' makes the row uniform.
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'admin_auth_id')::text,
  true
);

DO $$
DECLARE
  r uuid := current_setting('app.test_rls21_requirement')::uuid;
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM "TeachingRequirements" WHERE id = r AND "lessonLengths" = '{80,40}';
  IF n <> 1 THEN
    RAISE EXCEPTION 'lengths: the split row did not survive the teacher''s refused write';
  END IF;
  UPDATE "TeachingRequirements" SET "lessonLengths" = '{}' WHERE id = r;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'lengths: an admin could not make the row uniform again (% row(s))', n;
  END IF;
  SELECT count(*) INTO n FROM "TeachingRequirements"
   WHERE id = r AND "lessonLengths" = '{}' AND "lessonsPerWeek" = 2 AND "minutesPerLesson" = 80;
  IF n <> 1 THEN
    RAISE EXCEPTION 'lengths: the uniform row is not 2 × 80 with an empty list';
  END IF;
END
$$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 22: an inställd lektion knows why, and the column is nothing more.
--
-- 20261009090000 adds CalendarLessons."cancelCause", a nullable enum with no
-- default and no CHECK tying it to the status. The catalog half pins that
-- shape (a default would stamp every new row with a cause it does not have, a
-- NOT NULL would refuse publish's SCHEDULED rows). The row half: the admin
-- writes each cause and NULL through the same SQL PostgREST sends, a value
-- outside the enum is refused, a teacher's write reaches no row (the staff
-- arm is SELECT only, as before), and a teacher reads the cause.
-- ---------------------------------------------------------------------------

DO $$
DECLARE nullable text; typ text; def text; labels text;
BEGIN
  SELECT c.is_nullable, c.udt_name, c.column_default INTO nullable, typ, def
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'CalendarLessons' AND c.column_name = 'cancelCause';
  IF typ IS DISTINCT FROM 'LessonCancelCause' OR nullable IS DISTINCT FROM 'YES' OR def IS NOT NULL THEN
    RAISE EXCEPTION 'cancel cause: CalendarLessons.cancelCause is % (nullable %, default %), expected a nullable LessonCancelCause with no default',
      coalesce(typ, '<missing>'), nullable, coalesce(def, 'none');
  END IF;
  SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder) INTO labels
    FROM pg_enum WHERE enumtypid = '"LessonCancelCause"'::regtype;
  -- EVENT since 20261011103000: a bulk avbokning's cause.
  IF labels IS DISTINCT FROM 'TEACHER_UNAVAILABLE,ROOM_UNAVAILABLE,MANUAL,EVENT' THEN
    RAISE EXCEPTION 'cancel cause: the enum is (%), expected TEACHER_UNAVAILABLE, ROOM_UNAVAILABLE, MANUAL, EVENT', labels;
  END IF;
END $$;

BEGIN;
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'admin_auth_id')::text,
  true
);

DO $$
DECLARE
  school uuid := app.current_school_id();
  lesson uuid;
  n bigint;
BEGIN
  INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", status, "updatedAt")
  SELECT school, s.id, g.id, DATE '2099-01-05', timestamptz '2099-01-05 08:00+00', timestamptz '2099-01-05 09:00+00',
         'SCHEDULED', now()
    FROM "Subjects" s, "StudentGroups" g
   WHERE s."schoolId" = school AND g."schoolId" = school
   ORDER BY s.id, g.id LIMIT 1
  RETURNING id INTO lesson;
  IF lesson IS NULL THEN
    RAISE EXCEPTION 'cancel cause: no subject and group of school A to plant a lesson with';
  END IF;
  PERFORM set_config('app.test_rls22_lesson', lesson::text, true);
  SELECT count(*) INTO n FROM "CalendarLessons" WHERE id = lesson AND "cancelCause" IS NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION 'cancel cause: a new lesson was not written with no cause';
  END IF;
  UPDATE "CalendarLessons" SET status = 'CANCELLED', "cancelCause" = 'TEACHER_UNAVAILABLE' WHERE id = lesson;
  UPDATE "CalendarLessons" SET "cancelCause" = 'MANUAL' WHERE id = lesson;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'cancel cause: an admin could not record a cause (% row(s))', n;
  END IF;
  BEGIN
    UPDATE "CalendarLessons" SET "cancelCause" = 'SICK' WHERE id = lesson;
    RAISE EXCEPTION 'cancel cause: a cause outside the enum was stored';
  EXCEPTION WHEN invalid_text_representation THEN NULL;
  END;
  -- No CHECK ties it to the status: a reinstated row may keep it; the reader
  -- never asks a scheduled row.
  UPDATE "CalendarLessons" SET status = 'SCHEDULED' WHERE id = lesson;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'cancel cause: a status flip with a cause standing was refused';
  END IF;
  UPDATE "CalendarLessons" SET status = 'CANCELLED' WHERE id = lesson;
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
DECLARE lesson uuid := current_setting('app.test_rls22_lesson')::uuid; n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'TEACHER' THEN
    RAISE EXCEPTION 'cancel cause: expected to be acting as a TEACHER of school A, resolved role %',
      coalesce(app.current_user_role()::text, '<none>');
  END IF;
  SELECT count(*) INTO n FROM "CalendarLessons" WHERE id = lesson AND "cancelCause" = 'MANUAL';
  IF n <> 1 THEN
    RAISE EXCEPTION 'cancel cause: a teacher does not read the cause of a cancelled lesson of the school';
  END IF;
  UPDATE "CalendarLessons" SET "cancelCause" = 'TEACHER_UNAVAILABLE' WHERE id = lesson;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'cancel cause: a teacher rewrote the cause of % lesson(s)', n;
  END IF;
END
$$;
ROLLBACK;

-- Section 22, second half: who reads a lesson's teacher rows, after
-- 20261009110000 asked the pupil's arm for a pupil first. A pupil reads the
-- teacher row of their own class's lesson and not another class's; a teacher
-- reads both. The rows are planted by the admin and rolled back; the teacher
-- acts before the pupil, who cannot see the teacher's user row to switch to.
BEGIN;
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'admin_auth_id')::text,
  true
);

DO $$
DECLARE
  school uuid := app.current_school_id();
  pupil_group uuid;
  other_group uuid;
  subject uuid;
  teacher uuid;
  own uuid;
  foreign_lesson uuid;
BEGIN
  SELECT "studentGroupId" INTO pupil_group FROM "Users"
   WHERE "schoolId" = school AND role = 'STUDENT' AND "studentGroupId" IS NOT NULL
   ORDER BY "authId" LIMIT 1;
  SELECT id INTO other_group FROM "StudentGroups" WHERE "schoolId" = school AND id <> pupil_group ORDER BY id LIMIT 1;
  SELECT id INTO subject FROM "Subjects" WHERE "schoolId" = school ORDER BY id LIMIT 1;
  SELECT id INTO teacher FROM "Users" WHERE "schoolId" = school AND role = 'TEACHER' ORDER BY "authId" LIMIT 1;
  IF pupil_group IS NULL OR other_group IS NULL OR subject IS NULL OR teacher IS NULL THEN
    RAISE EXCEPTION 'teacher rows: school A lacks a pupil with a class, a second group, a subject or a teacher';
  END IF;
  INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", "updatedAt")
  VALUES (school, subject, pupil_group, DATE '2099-01-06', timestamptz '2099-01-06 08:00+00', timestamptz '2099-01-06 09:00+00', now())
  RETURNING id INTO own;
  INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", "updatedAt")
  VALUES (school, subject, other_group, DATE '2099-01-06', timestamptz '2099-01-06 08:00+00', timestamptz '2099-01-06 09:00+00', now())
  RETURNING id INTO foreign_lesson;
  INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId")
  VALUES (school, own, teacher), (school, foreign_lesson, teacher);
  PERFORM set_config('app.test_rls22_own', own::text, true);
  PERFORM set_config('app.test_rls22_foreign', foreign_lesson::text, true);
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
  SELECT count(*) INTO n FROM "CalendarLessonTeachers"
   WHERE "calendarLessonId" IN (current_setting('app.test_rls22_own')::uuid, current_setting('app.test_rls22_foreign')::uuid);
  IF n <> 2 THEN
    RAISE EXCEPTION 'teacher rows: a teacher reads % of the 2 teacher rows', n;
  END IF;
END
$$;
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',
    (SELECT "authId" FROM "Users"
      WHERE "schoolId" = app.current_school_id() AND role = 'STUDENT' AND "studentGroupId" IS NOT NULL
      ORDER BY "authId" LIMIT 1)
  )::text,
  true
);

DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'STUDENT' THEN
    RAISE EXCEPTION 'teacher rows: expected to be acting as a STUDENT of school A, resolved role %',
      coalesce(app.current_user_role()::text, '<none>');
  END IF;
  SELECT count(*) INTO n FROM "CalendarLessonTeachers"
   WHERE "calendarLessonId" = current_setting('app.test_rls22_own')::uuid;
  IF n <> 1 THEN
    RAISE EXCEPTION 'teacher rows: a pupil reads % teacher row(s) of their own class''s lesson, expected 1', n;
  END IF;
  SELECT count(*) INTO n FROM "CalendarLessonTeachers"
   WHERE "calendarLessonId" = current_setting('app.test_rls22_foreign')::uuid;
  IF n <> 0 THEN
    RAISE EXCEPTION 'teacher rows: a pupil reads % teacher row(s) of another class''s lesson', n;
  END IF;
END
$$;

ROLLBACK;

-- The catalog half: the pupil's arm asks for a pupil's group before it looks
-- up a lesson (20261009110000).
DO $$
DECLARE qual text;
BEGIN
  SELECT pg_get_expr(polqual, polrelid) INTO qual FROM pg_policy
   WHERE polname = 'calendar_lesson_teachers_student_select';
  IF qual IS NULL OR position('IS NOT NULL' IN qual) = 0 OR position('IS NOT NULL' IN qual) > position('EXISTS' IN qual) THEN
    RAISE EXCEPTION 'teacher rows: the pupil arm does not ask for a pupil''s group before its EXISTS: %', qual;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Section 23: a tillgodoräknad dag is the admin's decision to write, the
-- staff's to read, and nobody else's.
--
-- TimplanCredits (20261009100000) has two arms: admin_all and staff_select
-- (TEACHER and admin read every credit of the school — a teacher's coverage
-- read runs under their own RLS and must count the same credits the admin's
-- does). No family arm until P4: a pupil and a guardian read nothing.
--
-- The CHECKs mirror the DTO and each is refused by NAME, because the gateway
-- answers a CHECK reached past the DTO with a 400 naming the field it finds
-- by the constraint: minutes 0 and 601; half a span; a span 8..7; a group and
-- a span together; a blank, a tab-only, an NBSP-only and an 81-character
-- name; a 501-character note and a blank one.
--
-- Composite keys: another school's year, subject or group, each under a row
-- honestly stamped with this school — foreign_key_violation; a row STAMPED
-- with school B is RLS's to refuse (42501). School B's admin acts last and
-- sees its own fixture credit and none of A's; A's admin and teacher see
-- none of B's. The runner refuses to start without B's credit.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'admin_auth_id')::text,
  true
);
SELECT set_config('app.test_school_b', :'school_b', true);
SELECT set_config('app.test_year_b', :'year_b', true);
SELECT set_config('app.test_subject_b', :'subject_b', true);
SELECT set_config('app.test_group_b', :'group_b', true);

DO $$
DECLARE
  school uuid := app.current_school_id();
  year uuid; subject uuid; grp uuid; credit uuid;
  n bigint;
  con text;
  probe record;
BEGIN
  IF app.current_user_role() <> 'SCHOOL_ADMIN' THEN
    RAISE EXCEPTION 'credits: expected to be acting as an admin, am %', app.current_user_role();
  END IF;

  SELECT count(*) INTO n FROM "TimplanCredits" WHERE "schoolId" <> school;
  IF n <> 0 THEN
    RAISE EXCEPTION 'credits: % credit(s) from another school visible — tenant isolation is not enforced', n;
  END IF;

  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
  VALUES (school, 'RLS23 år', DATE '2096-08-15', DATE '2097-06-10', false, now())
  RETURNING id INTO year;
  INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt")
  VALUES (school, 'RLS23 idrott', 'RLS23', now()) RETURNING id INTO subject;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt")
  VALUES (school, year, 'RLS23 7A', 'CLASS', 7, now()) RETURNING id INTO grp;

  -- Each scope: the whole school, a span, a group; a subject or none.
  INSERT INTO "TimplanCredits" ("schoolId", "academicYearId", date, minutes, "subjectId", "minGradeLevel", "maxGradeLevel", name, note, "updatedAt")
  VALUES (school, year, DATE '2096-09-25', 300, subject, 7, 9, 'Friluftsdag', 'Beslut rektor 2096-09-01', now())
  RETURNING id INTO credit;
  INSERT INTO "TimplanCredits" ("schoolId", "academicYearId", date, minutes, "studentGroupId", name, "updatedAt")
  VALUES (school, year, DATE '2096-10-02', 120, grp, 'Temaeftermiddag', now());
  INSERT INTO "TimplanCredits" ("schoolId", "academicYearId", date, minutes, name, "updatedAt")
  VALUES (school, year, DATE '2096-10-03', 600, 'Lägerskola dag 1', now());
  SELECT count(*) INTO n FROM "TimplanCredits" WHERE "academicYearId" = year;
  IF n <> 3 THEN
    RAISE EXCEPTION 'credits: an admin wrote % of 3 credits', n;
  END IF;
  -- A split day is two rows: no uniqueness on (year, date, scope, subject).
  INSERT INTO "TimplanCredits" ("schoolId", "academicYearId", date, minutes, "subjectId", "minGradeLevel", "maxGradeLevel", name, "updatedAt")
  VALUES (school, year, DATE '2096-09-25', 120, subject, 7, 9, 'Friluftsdag', now());
  UPDATE "TimplanCredits" SET minutes = 180 WHERE id = credit;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'credits: an admin could not edit a credit (% row(s))', n;
  END IF;

  -- Every CHECK, by name.
  FOR probe IN
    SELECT * FROM (VALUES
      (0,   NULL::int, NULL::int, false, 'Friluftsdag', NULL::text, 'TimplanCredits_minutes_is_sane'),
      (601, NULL, NULL, false, 'Friluftsdag', NULL, 'TimplanCredits_minutes_is_sane'),
      (300, 7, NULL, false, 'Friluftsdag', NULL, 'TimplanCredits_grade_span_is_whole'),
      (300, 8, 7, false, 'Friluftsdag', NULL, 'TimplanCredits_grade_span_is_ordered'),
      (300, 7, 13, false, 'Friluftsdag', NULL, 'TimplanCredits_grade_span_is_ordered'),
      (300, 7, 9, true, 'Friluftsdag', NULL, 'TimplanCredits_scope_is_one'),
      (300, NULL, NULL, false, '', NULL, 'TimplanCredits_name_is_sane'),
      (300, NULL, NULL, false, '   ', NULL, 'TimplanCredits_name_is_sane'),
      (300, NULL, NULL, false, E'\t', NULL, 'TimplanCredits_name_is_sane'),
      (300, NULL, NULL, false, U&'\00A0\2003', NULL, 'TimplanCredits_name_is_sane'),
      (300, NULL, NULL, false, repeat('x', 81), NULL, 'TimplanCredits_name_is_sane'),
      (300, NULL, NULL, false, 'Friluftsdag', repeat('x', 501), 'TimplanCredits_note_is_sane'),
      (300, NULL, NULL, false, 'Friluftsdag', U&'\FEFF ', 'TimplanCredits_note_is_sane')
    ) AS v(minutes, min_grade, max_grade, with_group, name, note, expected)
  LOOP
    BEGIN
      INSERT INTO "TimplanCredits" ("schoolId", "academicYearId", date, minutes, "studentGroupId", "minGradeLevel", "maxGradeLevel", name, note, "updatedAt")
      VALUES (school, year, DATE '2096-11-01', probe.minutes, CASE WHEN probe.with_group THEN grp END,
              probe.min_grade, probe.max_grade, probe.name, probe.note, now());
      RAISE EXCEPTION 'credits: the row expected to break % was stored', probe.expected;
    EXCEPTION WHEN check_violation THEN
      GET STACKED DIAGNOSTICS con = CONSTRAINT_NAME;
      IF con IS DISTINCT FROM probe.expected THEN
        RAISE EXCEPTION 'credits: a row was refused by "%", expected "%"', con, probe.expected;
      END IF;
    END;
  END LOOP;
  -- The bounds themselves are legal: 1 and 600, an 80-character name, a 500 note.
  INSERT INTO "TimplanCredits" ("schoolId", "academicYearId", date, minutes, name, note, "updatedAt")
  VALUES (school, year, DATE '2096-11-02', 1, repeat('å', 80), repeat('ä', 500), now());

  -- Composite keys: another school's year, subject, group.
  BEGIN
    INSERT INTO "TimplanCredits" ("schoolId", "academicYearId", date, minutes, name, "updatedAt")
    VALUES (school, current_setting('app.test_year_b')::uuid, DATE '2096-09-25', 300, 'X', now());
    RAISE EXCEPTION 'credits: an admin credited a day of another school''s year';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "TimplanCredits" ("schoolId", "academicYearId", date, minutes, "subjectId", name, "updatedAt")
    VALUES (school, year, DATE '2096-09-25', 300, current_setting('app.test_subject_b')::uuid, 'X', now());
    RAISE EXCEPTION 'credits: an admin credited another school''s subject';
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS con = CONSTRAINT_NAME;
    IF con IS DISTINCT FROM 'TimplanCredits_subjectId_schoolId_fkey' THEN
      RAISE EXCEPTION 'credits: another school''s subject was refused by "%", not the subject key the gateway names', con;
    END IF;
  END;
  BEGIN
    UPDATE "TimplanCredits" SET "studentGroupId" = current_setting('app.test_group_b')::uuid,
                                "minGradeLevel" = NULL, "maxGradeLevel" = NULL
     WHERE id = credit;
    RAISE EXCEPTION 'credits: an admin scoped a credit to another school''s group';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  -- A row STAMPED with school B: RLS answers.
  BEGIN
    INSERT INTO "TimplanCredits" ("schoolId", "academicYearId", date, minutes, name, "updatedAt")
    VALUES (current_setting('app.test_school_b')::uuid, current_setting('app.test_year_b')::uuid,
            DATE '2096-09-25', 300, 'X', now());
    RAISE EXCEPTION 'credits: an admin wrote a credit stamped with another school';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE "TimplanCredits" SET "schoolId" = current_setting('app.test_school_b')::uuid,
                                "academicYearId" = current_setting('app.test_year_b')::uuid
     WHERE id = credit;
    RAISE EXCEPTION 'credits: an admin moved a credit into another school';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  SELECT count(*) INTO n FROM "TimplanCredits" WHERE "academicYearId" = year;
  IF n <> 5 THEN
    RAISE EXCEPTION 'credits: the year holds % of its 5 credits after the refused writes', n;
  END IF;
END
$$;

-- A teacher reads every credit of the school and writes none.
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
DECLARE n bigint; year uuid;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'TEACHER' THEN
    RAISE EXCEPTION 'credits: expected to be acting as a TEACHER of school A, resolved role %',
      coalesce(app.current_user_role()::text, '<none>');
  END IF;
  SELECT id INTO year FROM "AcademicYears" WHERE name = 'RLS23 år';
  SELECT count(*) INTO n FROM "TimplanCredits" WHERE "academicYearId" = year;
  IF n <> 5 THEN
    RAISE EXCEPTION 'credits: a teacher reads % of the year''s 5 credits', n;
  END IF;
  SELECT count(*) INTO n FROM "TimplanCredits" WHERE "schoolId" <> app.current_school_id();
  IF n <> 0 THEN
    RAISE EXCEPTION 'credits: a teacher reads % credit(s) of another school', n;
  END IF;
  BEGIN
    INSERT INTO "TimplanCredits" ("schoolId", "academicYearId", date, minutes, name, "updatedAt")
    VALUES (app.current_school_id(), year, DATE '2096-09-26', 60, 'X', now());
    RAISE EXCEPTION 'credits: a teacher credited a day';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  UPDATE "TimplanCredits" SET minutes = 600 WHERE "academicYearId" = year;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'credits: a teacher changed % credit(s)', n;
  END IF;
  DELETE FROM "TimplanCredits" WHERE "academicYearId" = year;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'credits: a teacher deleted % credit(s)', n;
  END IF;
END
$$;

-- A pupil and a guardian read nothing: no family arm until P4.
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',
    (SELECT "authId" FROM "Users"
      WHERE "schoolId" = app.current_school_id() AND role = 'STUDENT'
      ORDER BY "authId" LIMIT 1)
  )::text,
  true
);

DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'STUDENT' THEN
    RAISE EXCEPTION 'credits: expected to be acting as a STUDENT of school A, resolved role %',
      coalesce(app.current_user_role()::text, '<none>');
  END IF;
  SELECT count(*) INTO n FROM "TimplanCredits";
  IF n <> 0 THEN
    RAISE EXCEPTION 'credits: a pupil reads % credit(s); there is no family arm', n;
  END IF;
  DELETE FROM "TimplanCredits";
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'credits: a pupil deleted % credit(s)', n;
  END IF;
END
$$;

SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-4000-8000-000000000004')::text,
  true
);

DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'GUARDIAN' THEN
    RAISE EXCEPTION 'credits: expected to be acting as a GUARDIAN of school A, resolved role %',
      coalesce(app.current_user_role()::text, '<none>');
  END IF;
  SELECT count(*) INTO n FROM "TimplanCredits";
  IF n <> 0 THEN
    RAISE EXCEPTION 'credits: a guardian reads % credit(s); there is no family arm', n;
  END IF;
END
$$;

-- The other school's admin: their own fixture credit, none of A's.
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-4000-8000-000000000006')::text,
  true
);

DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'SCHOOL_ADMIN' THEN
    RAISE EXCEPTION 'credits: expected to be acting as school B''s SCHOOL_ADMIN, resolved role %',
      coalesce(app.current_user_role()::text, '<none>');
  END IF;
  SELECT count(*) INTO n FROM "TimplanCredits" WHERE "schoolId" <> app.current_school_id();
  IF n <> 0 THEN
    RAISE EXCEPTION 'credits: another school''s admin reads % credit(s) outside their school', n;
  END IF;
  SELECT count(*) INTO n FROM "TimplanCredits" WHERE name = 'RLS fixture friluftsdag';
  IF n < 1 THEN
    RAISE EXCEPTION 'credits: school B''s admin does not read their own fixture credit';
  END IF;
  DELETE FROM "TimplanCredits" WHERE "schoolId" <> app.current_school_id();
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'credits: another school''s admin deleted % of school A''s credits', n;
  END IF;
END
$$;

-- Back as A's admin: nothing moved, and the cascades — a deleted group or
-- subject takes its credits, a deleted year takes the rest.
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'admin_auth_id')::text,
  true
);

DO $$
DECLARE year uuid; n bigint;
BEGIN
  SELECT id INTO year FROM "AcademicYears" WHERE name = 'RLS23 år';
  SELECT count(*) INTO n FROM "TimplanCredits" WHERE "academicYearId" = year;
  IF n <> 5 THEN
    RAISE EXCEPTION 'credits: % of the year''s 5 credits are as the admin left them', n;
  END IF;
  DELETE FROM "StudentGroups" WHERE name = 'RLS23 7A' AND "academicYearId" = year;
  DELETE FROM "Subjects" WHERE code = 'RLS23' AND "schoolId" = app.current_school_id();
  SELECT count(*) INTO n FROM "TimplanCredits" WHERE "academicYearId" = year;
  IF n <> 2 THEN
    RAISE EXCEPTION 'credits: after the group and the subject went, % credit(s) remain, expected the 2 that named neither', n;
  END IF;
  DELETE FROM "AcademicYears" WHERE id = year;
  SELECT count(*) INTO n FROM "TimplanCredits" WHERE "academicYearId" = year;
  IF n <> 0 THEN
    RAISE EXCEPTION 'credits: a deleted year left % credit(s) behind', n;
  END IF;
END
$$;
ROLLBACK;

-- The catalog half: row security on, exactly the two arms, each with the role
-- in USING (and the admin's in WITH CHECK), the composite keys, the grant.
DO $$
DECLARE n integer; action "char"; bad text;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public."TimplanCredits"'::regclass) THEN
    RAISE EXCEPTION 'credits: row security is off on TimplanCredits';
  END IF;
  SELECT string_agg(polname, ',' ORDER BY polname) INTO bad FROM pg_policy
   WHERE polrelid = 'public."TimplanCredits"'::regclass;
  IF bad IS DISTINCT FROM 'timplan_credits_admin_all,timplan_credits_staff_select' THEN
    RAISE EXCEPTION 'credits: TimplanCredits has policies (%), expected admin_all and staff_select', bad;
  END IF;
  SELECT string_agg(polname, ',') INTO bad FROM pg_policy
   WHERE polrelid = 'public."TimplanCredits"'::regclass
     AND (pg_get_expr(polqual, polrelid) NOT LIKE '%current_user_role%'
          OR (polcmd = '*' AND pg_get_expr(polwithcheck, polrelid) NOT LIKE '%SCHOOL_ADMIN%'));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'credits: policies without the role in USING / WITH CHECK: %', bad;
  END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public."TimplanCredits"'::regclass AND contype = 'f' AND array_length(conkey, 1) = 2
     AND confdeltype = 'c';
  IF n <> 3 THEN
    RAISE EXCEPTION 'credits: % composite cascading keys, expected year, subject and group', n;
  END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public."TimplanCredits"'::regclass AND contype = 'c'
     AND conname IN ('TimplanCredits_minutes_is_sane', 'TimplanCredits_grade_span_is_whole',
                     'TimplanCredits_grade_span_is_ordered', 'TimplanCredits_scope_is_one',
                     'TimplanCredits_name_is_sane', 'TimplanCredits_note_is_sane');
  IF n <> 6 THEN
    RAISE EXCEPTION 'credits: % of the 6 named CHECKs exist', n;
  END IF;
  IF NOT has_table_privilege('app_authenticated', 'public."TimplanCredits"', 'SELECT, INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION 'credits: app_authenticated lacks its grant on TimplanCredits';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Section 24: en tjänsts historik är skolans och lärarens egen.
--
-- TeacherEmploymentLogs (20261010090000) is written by a trigger on
-- TeacherEmployments and TeacherDuties, never by a role, and read through two
-- arms: the admin reads the school's, a TEACHER the rows ABOUT THEM. What this
-- section asserts, in one transaction that is rolled back:
--
--  - every write the admin makes through app_authenticated is a version, with
--    the admin as actor, numbered 1..n per (teacher, year) with no gap; a save
--    that changes nothing is no version; the JSON carries no schoolId,
--    createdAt or updatedAt;
--  - a duty moved to a colleague (PostgREST can, the DTO cannot) is two rows,
--    one under each teacher, so neither reads the other's half;
--  - nobody writes the log: INSERT, UPDATE and DELETE are refused to the API
--    role by the grant (and to every role by the guards — the owner's half of
--    that is the probe's, which holds an owner connection);
--  - the first teacher reads exactly their own rows, the colleague exactly
--    theirs, a pupil and a guardian nothing (the service principal's nothing
--    is in 7h);
--  - the existence rule: deleting a person with a post, with an uppdrag that
--    holds a blocked slot, with a mentorship, and deleting a year whose class
--    has a mentor, each SUCCEED and leave no history behind; a subject deleted
--    under an ämnesansvar IS a version (its SET NULL), with the admin as actor.
--    Deleting a school is the probe's (the API role cannot).
--
-- The tenant half bites: the fixtures' posts and uppdrag in the second school
-- were written by the owner, so the second school has history rows, and the
-- runner refuses to start without them.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'admin_auth_id')::text,
  true
);

DO $$
DECLARE
  school uuid := app.current_school_id();
  admin uuid := app.current_user_id();
  me uuid; colleague uuid; y uuid; g uuid; d_mentor uuid; d_vakt uuid;
  n bigint; versions int[];
BEGIN
  IF app.current_user_role() <> 'SCHOOL_ADMIN' THEN
    RAISE EXCEPTION 'history: expected to be acting as an admin, am %', app.current_user_role();
  END IF;
  -- The tenant half first, before this school has rows of its own here.
  SELECT count(*) INTO n FROM "TeacherEmploymentLogs" WHERE "schoolId" <> school;
  IF n <> 0 THEN
    RAISE EXCEPTION 'history: % row(s) of another school''s history visible — tenant isolation is not enforced', n;
  END IF;

  SELECT id INTO me FROM "Users"
   WHERE "schoolId" = school AND role = 'TEACHER' ORDER BY "authId" LIMIT 1;
  SELECT id INTO colleague FROM "Users"
   WHERE "schoolId" = school AND role = 'TEACHER' ORDER BY "authId" OFFSET 1 LIMIT 1;
  IF me IS NULL OR colleague IS NULL THEN
    RAISE EXCEPTION 'history: the seed lacks two teachers (%, %)', me, colleague;
  END IF;

  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
  VALUES (school, 'RLS24 år', DATE '2100-08-16', DATE '2101-06-10', false, now()) RETURNING id INTO y;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt")
  VALUES (school, y, 'RLS24 7A', 'CLASS', 7, now()) RETURNING id INTO g;

  -- Two posts, a change, a save that changes nothing, two uppdrag.
  INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", "reductionPercent", "updatedAt")
  VALUES (school, me, y, 100, 0, now()), (school, colleague, y, 80, 0, now());
  UPDATE "TeacherEmployments" SET "employmentPercent" = 80, "reductionPercent" = 10, "updatedAt" = now()
   WHERE "userId" = me AND "academicYearId" = y;
  UPDATE "TeacherEmployments" SET "employmentPercent" = 80, "updatedAt" = now() + interval '1 minute'
   WHERE "userId" = me AND "academicYearId" = y;
  INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "studentGroupId", "updatedAt")
  VALUES (school, me, y, 'MENTORSKAP', 'RLS24 Mentor 7A', 90, g, now()) RETURNING id INTO d_mentor;
  INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "updatedAt")
  VALUES (school, me, y, 'RASTVAKT', 'RLS24 Rastvakt', 30, now()) RETURNING id INTO d_vakt;
  -- Moved to the colleague, as PostgREST could.
  UPDATE "TeacherDuties" SET "userId" = colleague WHERE id = d_vakt;

  SELECT array_agg(version ORDER BY version) INTO versions
    FROM "TeacherEmploymentLogs" WHERE "userId" = me AND "academicYearId" = y;
  IF versions IS DISTINCT FROM ARRAY[1, 2, 3, 4, 5] THEN
    RAISE EXCEPTION 'history: the first teacher''s versions are %, expected 1..5 (two post writes, a no-op skipped, two uppdrag, one moved away)', versions;
  END IF;
  SELECT array_agg(version ORDER BY version) INTO versions
    FROM "TeacherEmploymentLogs" WHERE "userId" = colleague AND "academicYearId" = y;
  IF versions IS DISTINCT FROM ARRAY[1, 2] THEN
    RAISE EXCEPTION 'history: the colleague''s versions are %, expected 1..2 (their post, the uppdrag moved to them)', versions;
  END IF;

  -- What each version says.
  SELECT count(*) INTO n FROM "TeacherEmploymentLogs"
   WHERE "userId" = me AND "academicYearId" = y AND (
         (version = 1 AND entity = 'EMPLOYMENT' AND action = 'CREATE' AND before IS NULL AND (after->>'employmentPercent')::numeric = 100)
      OR (version = 2 AND entity = 'EMPLOYMENT' AND action = 'UPDATE' AND (before->>'employmentPercent')::numeric = 100
          AND (after->>'employmentPercent')::numeric = 80 AND (after->>'reductionPercent')::numeric = 10)
      OR (version = 3 AND entity = 'DUTY' AND action = 'CREATE' AND "entityId" = d_mentor AND after->>'label' = 'RLS24 Mentor 7A')
      OR (version = 4 AND entity = 'DUTY' AND action = 'CREATE' AND "entityId" = d_vakt)
      OR (version = 5 AND entity = 'DUTY' AND action = 'DELETE' AND "entityId" = d_vakt AND after IS NULL
          AND before->>'label' = 'RLS24 Rastvakt' AND (before->>'userId')::uuid = me));
  IF n <> 5 THEN
    RAISE EXCEPTION 'history: % of the first teacher''s 5 versions read as written', n;
  END IF;
  SELECT count(*) INTO n FROM "TeacherEmploymentLogs"
   WHERE "userId" = colleague AND "academicYearId" = y AND version = 2 AND action = 'CREATE'
     AND before IS NULL AND (after->>'userId')::uuid = colleague AND "entityId" = d_vakt;
  IF n <> 1 THEN
    RAISE EXCEPTION 'history: the moved uppdrag is not a CREATE under the colleague';
  END IF;
  SELECT count(*) INTO n FROM "TeacherEmploymentLogs"
   WHERE "academicYearId" = y AND ("actorId" IS DISTINCT FROM admin
      OR COALESCE(before, after) ?| ARRAY['schoolId', 'createdAt', 'updatedAt']);
  IF n <> 0 THEN
    RAISE EXCEPTION 'history: % row(s) without the admin as actor, or carrying schoolId/createdAt/updatedAt', n;
  END IF;

  -- Nobody writes the log: the API role holds SELECT and nothing else.
  BEGIN
    INSERT INTO "TeacherEmploymentLogs" ("schoolId", "userId", "academicYearId", version, entity, "entityId", action, after)
    VALUES (school, me, y, 99, 'EMPLOYMENT', d_mentor, 'CREATE', '{}'::jsonb);
    RAISE EXCEPTION 'history: an admin wrote a version by hand';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE "TeacherEmploymentLogs" SET "actorId" = NULL WHERE "userId" = me;
    RAISE EXCEPTION 'history: an admin rewrote a version';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM "TeacherEmploymentLogs" WHERE "userId" = me;
    RAISE EXCEPTION 'history: an admin deleted a version';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  PERFORM set_config('app.test_rls24_year', y::text, true);
  PERFORM set_config('app.test_rls24_me', me::text, true);
  PERFORM set_config('app.test_rls24_colleague', colleague::text, true);
END
$$;

-- The first teacher: exactly their own five, the moved uppdrag's DELETE half
-- among them, and nothing of the colleague's.
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', (SELECT "authId" FROM "Users"
                             WHERE "schoolId" = app.current_school_id() AND role = 'TEACHER'
                             ORDER BY "authId" LIMIT 1))::text,
  true
);

DO $$
DECLARE
  me uuid := app.current_user_id();
  y uuid := current_setting('app.test_rls24_year')::uuid;
  n bigint;
BEGIN
  IF me IS DISTINCT FROM current_setting('app.test_rls24_me')::uuid OR app.current_user_role() <> 'TEACHER' THEN
    RAISE EXCEPTION 'history: expected to be acting as the first TEACHER, am % (%)', app.current_user_role(), me;
  END IF;
  SELECT count(*) INTO n FROM "TeacherEmploymentLogs" WHERE "academicYearId" = y;
  IF n <> 5 THEN
    RAISE EXCEPTION 'history: a teacher reads % row(s) of the year''s history, expected exactly their own 5', n;
  END IF;
  SELECT count(*) INTO n FROM "TeacherEmploymentLogs" WHERE "userId" <> me;
  IF n <> 0 THEN
    RAISE EXCEPTION 'history: a teacher reads % row(s) of a colleague''s history', n;
  END IF;
END
$$;

-- The colleague: their two, never the first teacher's mentorship or post.
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', (SELECT "authId" FROM "Users"
                             WHERE "schoolId" = app.current_school_id() AND role = 'TEACHER'
                             ORDER BY "authId" OFFSET 1 LIMIT 1))::text,
  true
);

DO $$
DECLARE
  me uuid := app.current_user_id();
  y uuid := current_setting('app.test_rls24_year')::uuid;
  n bigint;
BEGIN
  IF me IS DISTINCT FROM current_setting('app.test_rls24_colleague')::uuid THEN
    RAISE EXCEPTION 'history: expected to be acting as the colleague, am %', me;
  END IF;
  SELECT count(*) INTO n FROM "TeacherEmploymentLogs" WHERE "academicYearId" = y;
  IF n <> 2 THEN
    RAISE EXCEPTION 'history: the colleague reads % row(s), expected exactly their own 2', n;
  END IF;
  SELECT count(*) INTO n FROM "TeacherEmploymentLogs"
   WHERE "academicYearId" = y AND (before::text LIKE '%Mentor 7A%' OR after::text LIKE '%Mentor 7A%'
                                   OR before IS NOT NULL);
  IF n <> 0 THEN
    RAISE EXCEPTION 'history: the colleague reads % row(s) carrying the first teacher''s side of the uppdrag', n;
  END IF;
END
$$;

-- A pupil and a guardian of the same school: nothing.
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', (SELECT "authId" FROM "Users"
                             WHERE "schoolId" = app.current_school_id() AND role = 'STUDENT'
                             ORDER BY "authId" LIMIT 1))::text,
  true
);
DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'STUDENT' THEN
    RAISE EXCEPTION 'history: expected a STUDENT, resolved %', app.current_user_role();
  END IF;
  SELECT count(*) INTO n FROM "TeacherEmploymentLogs";
  IF n <> 0 THEN
    RAISE EXCEPTION 'history: a pupil reads % history row(s)', n;
  END IF;
END
$$;
-- The fixtures' guardian of school A, by authId (a pupil cannot look one up).
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-4000-8000-000000000004')::text,
  true
);
DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'GUARDIAN' THEN
    RAISE EXCEPTION 'history: expected a GUARDIAN, resolved %', coalesce(app.current_user_role()::text, '<none>');
  END IF;
  SELECT count(*) INTO n FROM "TeacherEmploymentLogs";
  IF n <> 0 THEN
    RAISE EXCEPTION 'history: a guardian reads % history row(s)', n;
  END IF;
END
$$;

-- The existence rule, as the admin: every delete that works without the log
-- still works, and leaves no history behind it.
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'admin_auth_id')::text,
  true
);

DO $$
DECLARE
  school uuid := app.current_school_id();
  admin uuid := app.current_user_id();
  me uuid := current_setting('app.test_rls24_me')::uuid;
  y uuid := current_setting('app.test_rls24_year')::uuid;
  y2 uuid; g2 uuid; u uuid; slot uuid; s uuid; d uuid;
  kind text;
  n bigint;
BEGIN
  FOREACH kind IN ARRAY ARRAY['post', 'slot', 'mentor'] LOOP
    INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
    VALUES (school, 'rls24-' || kind || '@example.invalid', 'RLS24', kind, 'TEACHER', gen_random_uuid(), true, now())
    RETURNING id INTO u;
    IF kind = 'post' THEN
      INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", "updatedAt")
      VALUES (school, u, y, 50, now());
      UPDATE "TeacherEmployments" SET "employmentPercent" = 60 WHERE "userId" = u;
    ELSIF kind = 'slot' THEN
      INSERT INTO "AvailabilityConstraints" ("schoolId", "resourceType", "userId", "dayOfWeek", "startTime", "endTime", type, reason, "updatedAt")
      VALUES (school, 'TEACHER', u, 2, '15:00', '16:00', 'UNAVAILABLE', 'Uppdrag', now()) RETURNING id INTO slot;
      INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "updatedAt")
      VALUES (school, u, y, 'APT_KONFERENS', 'RLS24 APT', 60, now()) RETURNING id INTO d;
      INSERT INTO "TeacherDutySlots" ("schoolId", "teacherDutyId", "availabilityConstraintId") VALUES (school, d, slot);
    ELSE
      INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "studentGroupId", "updatedAt")
      SELECT school, u, y, 'MENTORSKAP', 'RLS24 Mentor', 60, g."id", now()
        FROM "StudentGroups" g WHERE g."academicYearId" = y AND g.name = 'RLS24 7A';
    END IF;
    SELECT count(*) INTO n FROM "TeacherEmploymentLogs" WHERE "userId" = u;
    IF n = 0 THEN
      RAISE EXCEPTION 'history: the % person''s writes left no version to cascade', kind;
    END IF;
    -- The delete that works today must still work.
    DELETE FROM "Users" WHERE id = u;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN
      RAISE EXCEPTION 'history: deleting a person with a % deleted % row(s)', kind, n;
    END IF;
    SELECT count(*) INTO n FROM "TeacherEmploymentLogs" WHERE "userId" = u;
    IF n <> 0 THEN
      RAISE EXCEPTION 'history: a deleted person (%) left % history row(s)', kind, n;
    END IF;
  END LOOP;

  -- A year whose class has a mentor: the class's SET NULL on the uppdrag
  -- happens while the year is being deleted.
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
  VALUES (school, 'RLS24 år två', DATE '2101-08-15', DATE '2102-06-10', false, now()) RETURNING id INTO y2;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt")
  VALUES (school, y2, 'RLS24 8A', 'CLASS', 8, now()) RETURNING id INTO g2;
  INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", "updatedAt")
  VALUES (school, me, y2, 100, now());
  INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "studentGroupId", "updatedAt")
  VALUES (school, me, y2, 'MENTORSKAP', 'RLS24 Mentor 8A', 60, g2, now());
  DELETE FROM "AcademicYears" WHERE id = y2;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'history: deleting a year whose class has a mentor deleted % row(s)', n;
  END IF;
  SELECT count(*) INTO n FROM "TeacherEmploymentLogs" WHERE "academicYearId" = y2;
  IF n <> 0 THEN
    RAISE EXCEPTION 'history: a deleted year left % history row(s)', n;
  END IF;

  -- A subject deleted under an ämnesansvar: the SET NULL is a version, by the admin.
  INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt")
  VALUES (school, 'RLS24 ämne', 'RLS24', now()) RETURNING id INTO s;
  INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "subjectId", "updatedAt")
  VALUES (school, me, y, 'AMNESANSVAR', 'RLS24 Ämnesansvar', 30, s, now()) RETURNING id INTO d;
  DELETE FROM "Subjects" WHERE id = s;
  SELECT count(*) INTO n FROM "TeacherEmploymentLogs"
   WHERE "entityId" = d AND action = 'UPDATE' AND (before->>'subjectId')::uuid = s
     AND after->'subjectId' = 'null'::jsonb AND "actorId" = admin;
  IF n <> 1 THEN
    RAISE EXCEPTION 'history: a subject deleted under an ämnesansvar is % version(s), expected one UPDATE by the admin', n;
  END IF;

  -- A note's text never enters the history, so correcting the row corrects
  -- it; that it was written is a version ("noteChanged"), and re-saving the
  -- same note is none.
  UPDATE "TeacherEmployments" SET note = 'RLS24 hemlig anteckning', "updatedAt" = now()
   WHERE "userId" = me AND "academicYearId" = y;
  UPDATE "TeacherEmployments" SET note = 'RLS24 hemlig anteckning', "updatedAt" = now() + interval '1 minute'
   WHERE "userId" = me AND "academicYearId" = y;
  UPDATE "TeacherDuties" SET note = 'RLS24 hemlig uppdragsanteckning', "updatedAt" = now() WHERE id = d;
  INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", note, "updatedAt")
  VALUES (school, me, y, 'ANNAT', 'RLS24 med anteckning', 10, 'RLS24 hemlig från början', now());
  SELECT count(*) INTO n FROM "TeacherEmploymentLogs"
   WHERE "schoolId" = school AND (COALESCE(before::text, '') || COALESCE(after::text, '')) LIKE '%hemlig%';
  IF n <> 0 THEN
    RAISE EXCEPTION 'history: % version(s) keep a note''s text — a corrected note can never be corrected in the history', n;
  END IF;
  SELECT count(*) INTO n FROM "TeacherEmploymentLogs"
   WHERE "userId" = me AND "academicYearId" = y AND "actorId" = admin
     AND (before IS NULL OR NOT before ? 'note') AND (after IS NULL OR NOT after ? 'note')
     AND after->'noteChanged' = 'true'::jsonb
     AND ((entity = 'EMPLOYMENT' AND action = 'UPDATE')
          OR (entity = 'DUTY' AND action = 'UPDATE' AND "entityId" = d)
          OR (entity = 'DUTY' AND action = 'CREATE' AND after->>'label' = 'RLS24 med anteckning'));
  IF n <> 3 THEN
    RAISE EXCEPTION 'history: % note version(s) marked noteChanged, expected three (a post''s note, an uppdrag''s, a new uppdrag''s) and none for the identical re-save', n;
  END IF;
END
$$;
ROLLBACK;

-- The catalog half: row security on, exactly the two read arms, each with the
-- role in USING, the guards and writers present as SECURITY DEFINER, the
-- composite keys, SELECT and nothing else for the API role, no TRUNCATE,
-- REFERENCES or TRIGGER for any API role.
DO $$
DECLARE n integer; bad text; api_role text;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public."TeacherEmploymentLogs"'::regclass) THEN
    RAISE EXCEPTION 'history: row security is off on TeacherEmploymentLogs';
  END IF;
  SELECT string_agg(polname || ':' || polcmd::text, ',' ORDER BY polname) INTO bad FROM pg_policy
   WHERE polrelid = 'public."TeacherEmploymentLogs"'::regclass;
  IF bad IS DISTINCT FROM 'teacher_employment_logs_admin_select:r,teacher_employment_logs_teacher_own_select:r' THEN
    RAISE EXCEPTION 'history: TeacherEmploymentLogs has policies (%), expected the two SELECT arms', bad;
  END IF;
  SELECT string_agg(polname, ',') INTO bad FROM pg_policy
   WHERE polrelid = 'public."TeacherEmploymentLogs"'::regclass
     AND pg_get_expr(polqual, polrelid) NOT LIKE '%current_user_role%';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'history: policies without the role in USING: %', bad;
  END IF;
  SELECT count(*) INTO n
    FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
   WHERE NOT t.tgisinternal AND t.tgenabled = 'O' AND p.prosecdef
     AND (t.tgrelid, t.tgname) IN (
       ('public."TeacherEmployments"'::regclass,    'TeacherEmployments_log'),
       ('public."TeacherDuties"'::regclass,         'TeacherDuties_log'),
       ('public."TeacherEmploymentLogs"'::regclass, 'TeacherEmploymentLogs_append_only'),
       ('public."TeacherEmploymentLogs"'::regclass, 'TeacherEmploymentLogs_no_truncate'));
  IF n <> 4 THEN
    RAISE EXCEPTION 'history: % of the four log triggers are present, enabled and SECURITY DEFINER', n;
  END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public."TeacherEmploymentLogs"'::regclass AND contype = 'f' AND array_length(conkey, 1) = 2
     AND confdeltype = 'c';
  IF n <> 2 THEN
    RAISE EXCEPTION 'history: % composite cascading keys, expected teacher and year', n;
  END IF;
  IF NOT has_table_privilege('app_authenticated', 'public."TeacherEmploymentLogs"', 'SELECT') THEN
    RAISE EXCEPTION 'history: app_authenticated cannot read TeacherEmploymentLogs';
  END IF;
  IF has_table_privilege('app_authenticated', 'public."TeacherEmploymentLogs"', 'INSERT')
     OR has_table_privilege('app_authenticated', 'public."TeacherEmploymentLogs"', 'UPDATE')
     OR has_table_privilege('app_authenticated', 'public."TeacherEmploymentLogs"', 'DELETE') THEN
    RAISE EXCEPTION 'history: app_authenticated holds a write privilege on TeacherEmploymentLogs';
  END IF;
  -- TRUNCATE fires no row trigger and ignores RLS: no API role may hold it,
  -- nor REFERENCES or TRIGGER, whatever default ACL the environment has
  -- (Supabase's hands all three to anon, authenticated and service_role).
  FOR api_role IN SELECT rolname FROM pg_roles
                   WHERE rolname IN ('anon', 'authenticated', 'service_role', 'app_authenticated')
  LOOP
    SELECT string_agg(p, ', ') INTO bad
      FROM unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
     WHERE has_table_privilege(api_role, 'public."TeacherEmploymentLogs"', p);
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'history: % holds % on TeacherEmploymentLogs', api_role, bad;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND has_table_privilege('anon', 'public."TeacherEmploymentLogs"', 'SELECT') THEN
    RAISE EXCEPTION 'history: anon may SELECT TeacherEmploymentLogs';
  END IF;
  -- The API role cannot empty it either (refused by the grant, and the
  -- statement guard behind it). The owner, whom no grant binds, meets the
  -- guard alone: that half is the probe's (ö3), which holds an owner
  -- connection.
  BEGIN
    TRUNCATE "TeacherEmploymentLogs";
    RAISE EXCEPTION 'history: % truncated TeacherEmploymentLogs — the history can be emptied', current_user;
  EXCEPTION WHEN insufficient_privilege OR SQLSTATE 'TL403' THEN
    NULL;
  END;
END $$;

-- ---------------------------------------------------------------------------
-- Section 25: ett ämnes faktor och integrationens strömbrytare.
--
-- 20261010100000 adds Subjects."loadFactor" NUMERIC(4,3) NOT NULL DEFAULT
-- 1.000 with CHECK 0.5..3.0 (Subjects_loadFactor_is_sane), mirroring the DTO;
-- 20261010110000 adds StaffingPolicies."shareEmploymentWithIntegrations"
-- NOT NULL DEFAULT false. Both are refused or defaulted for every writer, the
-- admin's PostgREST included: the bounds are legal, 0.499 and 3.001 are not,
-- by name, and a fresh subject and a fresh policy read the defaults.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'admin_auth_id')::text,
  true
);
DO $$
DECLARE school uuid := app.current_school_id(); s uuid; f numeric; v numeric; con text; flag boolean;
BEGIN
  INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt")
  VALUES (school, 'RLS25 slöjd', 'RLS25', now()) RETURNING id, "loadFactor" INTO s, f;
  IF f IS DISTINCT FROM 1.000 THEN
    RAISE EXCEPTION 'factor: a new subject reads factor %, expected 1.000', f;
  END IF;
  FOREACH v IN ARRAY ARRAY[0.5, 0.7, 3.0] LOOP
    UPDATE "Subjects" SET "loadFactor" = v WHERE id = s;
  END LOOP;
  FOREACH v IN ARRAY ARRAY[0.499, 3.001, 0] LOOP
    BEGIN
      UPDATE "Subjects" SET "loadFactor" = v WHERE id = s;
      RAISE EXCEPTION 'factor: % was stored', v;
    EXCEPTION WHEN check_violation THEN
      GET STACKED DIAGNOSTICS con = CONSTRAINT_NAME;
      IF con IS DISTINCT FROM 'Subjects_loadFactor_is_sane' THEN
        RAISE EXCEPTION 'factor: % was refused by "%", expected Subjects_loadFactor_is_sane', v, con;
      END IF;
    END;
  END LOOP;

  SELECT "shareEmploymentWithIntegrations" INTO flag FROM "StaffingPolicies" WHERE "schoolId" = school;
  IF flag IS NOT NULL AND flag THEN
    RAISE EXCEPTION 'integrations: the seeded policy shares employment with integrations by default';
  END IF;
  SELECT column_default INTO con FROM information_schema.columns
   WHERE table_name = 'StaffingPolicies' AND column_name = 'shareEmploymentWithIntegrations' AND is_nullable = 'NO';
  IF con IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'integrations: the switch is not NOT NULL DEFAULT false (default %)', con;
  END IF;
END
$$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 26: en elev minns sina klasser.
--
-- StudentEnrollments (20261010120000) is a pupil's home-class history, written
-- only by the Users trigger, read through four arms. Pupil data is the most
-- sensitive in the product, so each arm is asserted from the side it must
-- EXCLUDE, in the transaction that just showed the rows exist:
--
--  26a the admin and a teacher read the school's rows; a STUDENT exactly their
--      own and none of a classmate's the teacher just read; the fixtures'
--      GUARDIAN exactly their child's; every role none of the second school's.
--  26b nobody writes it: INSERT, UPDATE, DELETE and TRUNCATE are refused to the
--      API role whatever the claims (the grant; the guard behind it is the
--      probe's, which holds an owner connection).
--  26c every trigger path at the SQL level, as the admin through the API role
--      — PostgREST's door: a pupil created in an ended year's class; the
--      activation's hint backdating a cross-year move to the year's start; a
--      move closing one segment and opening the next; a move back the same
--      day coalescing; the class cleared; deactivation and reactivation; a
--      malformed hint ignored; a grade corrected; a class with history moved
--      to another year (23503); a class deleted (a closed segment, no class,
--      its grade); a role change; another school's class (23503, for an
--      active and an inactive pupil alike, in the words of an unknown id); a
--      year deleted (its segments with it, nothing raised).
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
SELECT set_config('app.test_group_b', :'group_b', true);

DO $$
DECLARE
  school uuid := app.current_school_id();
  n bigint; m bigint;
  child uuid; other uuid;
BEGIN
  IF app.current_user_role() <> 'SCHOOL_ADMIN' THEN
    RAISE EXCEPTION 'enrolment: expected to be acting as an admin, am %', app.current_user_role();
  END IF;
  SELECT count(*) INTO n FROM "StudentEnrollments";
  SELECT count(*) INTO m FROM "StudentEnrollments" WHERE "schoolId" = school;
  IF n = 0 OR n <> m THEN
    RAISE EXCEPTION 'enrolment: the admin reads % row(s), % of them the school''s — expected the school''s and only them', n, m;
  END IF;
  -- The fixtures' guardian's child, and a classmate who is not their child.
  SELECT gs."studentId" INTO child FROM "GuardianStudents" gs
    JOIN "Users" g ON g.id = gs."guardianId" AND g."authId" = '00000000-0000-4000-8000-000000000004';
  SELECT e."studentId" INTO other FROM "StudentEnrollments" e
   WHERE e."studentId" <> child ORDER BY e."studentId" LIMIT 1;
  IF child IS NULL OR other IS NULL
     OR NOT EXISTS (SELECT 1 FROM "StudentEnrollments" WHERE "studentId" = child) THEN
    RAISE EXCEPTION 'enrolment: the fixtures'' child (%) has no history, or there is no other pupil (%)', child, other;
  END IF;
  PERFORM set_config('app.test_rls26_child', child::text, true);
  PERFORM set_config('app.test_rls26_child_sub', (SELECT "authId"::text FROM "Users" WHERE id = child), true);
  PERFORM set_config('app.test_rls26_teacher_sub', (SELECT "authId"::text FROM "Users"
    WHERE "schoolId" = school AND role = 'TEACHER' ORDER BY "authId" LIMIT 1), true);
  PERFORM set_config('app.test_rls26_other', other::text, true);
  PERFORM set_config('app.test_rls26_total', n::text, true);
END
$$;

-- A teacher: the same rows as the admin.
SELECT set_config('request.jwt.claims', json_build_object('sub', (SELECT "authId" FROM "Users"
  WHERE "schoolId" = app.current_school_id() AND role = 'TEACHER' ORDER BY "authId" LIMIT 1))::text, true);
DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'TEACHER' THEN
    RAISE EXCEPTION 'enrolment: expected a TEACHER, resolved %', app.current_user_role();
  END IF;
  SELECT count(*) INTO n FROM "StudentEnrollments";
  IF n::text <> current_setting('app.test_rls26_total') THEN
    RAISE EXCEPTION 'enrolment: a teacher reads % row(s), the admin %', n, current_setting('app.test_rls26_total');
  END IF;
  SELECT count(*) INTO n FROM "StudentEnrollments" WHERE "studentId" = current_setting('app.test_rls26_other')::uuid;
  IF n = 0 THEN
    RAISE EXCEPTION 'enrolment: the teacher cannot read the classmate''s history the pupil below must not';
  END IF;
END
$$;

-- The child, as a STUDENT: exactly their own, nothing of the classmate's.
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls26_child_sub'))::text, true);
DO $$
DECLARE n bigint; me uuid := app.current_user_id();
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'STUDENT' OR me IS DISTINCT FROM current_setting('app.test_rls26_child')::uuid THEN
    RAISE EXCEPTION 'enrolment: expected the child as a STUDENT, resolved % (%)', app.current_user_role(), me;
  END IF;
  SELECT count(*) INTO n FROM "StudentEnrollments" WHERE "studentId" <> me;
  IF n <> 0 THEN
    RAISE EXCEPTION 'enrolment: a pupil reads % row(s) of another pupil''s class history', n;
  END IF;
  SELECT count(*) INTO n FROM "StudentEnrollments" WHERE "studentId" = me;
  IF n = 0 THEN
    RAISE EXCEPTION 'enrolment: a pupil cannot read their own class history';
  END IF;
END
$$;

-- The fixtures' guardian: their child's rows, none of the classmate's.
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000004')::text, true);
DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'GUARDIAN' THEN
    RAISE EXCEPTION 'enrolment: expected a GUARDIAN, resolved %', coalesce(app.current_user_role()::text, '<none>');
  END IF;
  SELECT count(*) INTO n FROM "StudentEnrollments" WHERE "studentId" <> current_setting('app.test_rls26_child')::uuid;
  IF n <> 0 THEN
    RAISE EXCEPTION 'enrolment: a guardian reads % row(s) of a pupil who is not their child', n;
  END IF;
  SELECT count(*) INTO n FROM "StudentEnrollments" WHERE "studentId" = current_setting('app.test_rls26_child')::uuid;
  IF n = 0 THEN
    RAISE EXCEPTION 'enrolment: a guardian cannot read their child''s class history';
  END IF;
END
$$;

-- An inactive principal (the fixtures' deactivated admin): nothing.
SELECT set_config('request.jwt.claims', json_build_object('sub', :'inactive_auth_id')::text, true);
DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS NOT NULL THEN
    RAISE EXCEPTION 'enrolment: the deactivated admin resolved to %', app.current_user_role();
  END IF;
  SELECT count(*) INTO n FROM "StudentEnrollments";
  IF n <> 0 THEN
    RAISE EXCEPTION 'enrolment: an unresolved principal reads % row(s)', n;
  END IF;
END
$$;

-- 26b: no API role writes it, whoever it claims to be.
SELECT set_config('app.test_rls26_admin', :'admin_auth_id', true);
DO $$
DECLARE sub text; who text;
BEGIN
  FOREACH sub IN ARRAY ARRAY[
    current_setting('app.test_rls26_admin'),
    current_setting('app.test_rls26_teacher_sub'),
    current_setting('app.test_rls26_child_sub'),
    '00000000-0000-4000-8000-000000000004'
  ] LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', sub)::text, true);
    who := coalesce(app.current_user_role()::text, '<none>');
    BEGIN
      INSERT INTO "StudentEnrollments" ("schoolId", "studentId", "academicYearId", "validFrom")
      SELECT "schoolId", "studentId", "academicYearId", DATE '2001-01-01' FROM "StudentEnrollments" LIMIT 1;
      RAISE EXCEPTION 'enrolment: % inserted a segment', who;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      UPDATE "StudentEnrollments" SET "validFrom" = DATE '2001-01-01';
      RAISE EXCEPTION 'enrolment: % rewrote a segment', who;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      DELETE FROM "StudentEnrollments";
      RAISE EXCEPTION 'enrolment: % deleted a segment', who;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      TRUNCATE "StudentEnrollments";
      RAISE EXCEPTION 'enrolment: % truncated the history', who;
    EXCEPTION WHEN insufficient_privilege OR SQLSTATE 'SE403' THEN NULL;
    END;
  END LOOP;
END
$$;
ROLLBACK;

-- 26c: the trigger paths, as the admin through the API role.
BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
SELECT set_config('app.test_group_b', :'group_b', true);

DO $$
DECLARE
  school uuid := app.current_school_id();
  today date := (now() AT TIME ZONE (SELECT timezone FROM "Schools" WHERE id = app.current_school_id()))::date;
  y0 uuid; y1 uuid; a0 uuid; a1 uuid; b1 uuid; p uuid; r uuid; q uuid;
  y1_start date := today - 50;
  y0_end date := today - 60;
  n bigint; seg record; con text;
  con_b text; msg_none text; det_none text; msg_b text; det_b text;
BEGIN
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
  VALUES (school, 'RLS26 förra', today - 400, y0_end, false, now()) RETURNING id INTO y0;
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
  VALUES (school, 'RLS26 i år', y1_start, today + 250, false, now()) RETURNING id INTO y1;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt")
  VALUES (school, y0, 'RLS26 7A', 'CLASS', 7, now()) RETURNING id INTO a0;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt")
  VALUES (school, y1, 'RLS26 8A', 'CLASS', 8, now()) RETURNING id INTO a1;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt")
  VALUES (school, y1, 'RLS26 8B', 'CLASS', 8, now()) RETURNING id INTO b1;

  -- A pupil created in a class of an ended year claims no day inside it.
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt", "studentGroupId")
  VALUES (school, 'rls26-p@example.invalid', 'RLS26', 'P', 'STUDENT', gen_random_uuid(), true, now(), a0) RETURNING id INTO p;
  SELECT count(*) INTO n FROM "StudentEnrollments"
   WHERE "studentId" = p AND "academicYearId" = y0 AND "validFrom" = y0_end + 1 AND "validTo" IS NULL
     AND "studentGroupId" = a0 AND "gradeLevel" = 7 AND source = 'RECORDED';
  IF n <> 1 THEN
    RAISE EXCEPTION 'enrolment: a pupil placed in an ended year''s class is not one open segment from its end + 1';
  END IF;

  -- The activation's hint: a cross-year move out of an earlier year's class is
  -- recorded from the new year's first day.
  PERFORM set_config('app.enrolment_from', y1::text || ':' || y1_start::text, true);
  UPDATE "Users" SET "studentGroupId" = a1 WHERE id = p;
  PERFORM set_config('app.enrolment_from', '', true);
  SELECT count(*) INTO n FROM "StudentEnrollments" WHERE "studentId" = p AND "academicYearId" = y0;
  IF n <> 0 THEN
    RAISE EXCEPTION 'enrolment: the ended year''s segment that held no day was kept (% row(s))', n;
  END IF;
  SELECT count(*) INTO n FROM "StudentEnrollments"
   WHERE "studentId" = p AND "academicYearId" = y1 AND "studentGroupId" = a1 AND "validFrom" = y1_start AND "validTo" IS NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION 'enrolment: the hint did not backdate the move to the year''s first day';
  END IF;

  -- A move within the year closes at today and opens at today.
  UPDATE "Users" SET "studentGroupId" = b1 WHERE id = p;
  SELECT count(*) INTO n FROM "StudentEnrollments"
   WHERE "studentId" = p AND ((("studentGroupId" = a1 AND "validFrom" = y1_start AND "validTo" = today))
                              OR ("studentGroupId" = b1 AND "validFrom" = today AND "validTo" IS NULL));
  IF n <> 2 OR (SELECT count(*) FROM "StudentEnrollments" WHERE "studentId" = p) <> 2 THEN
    RAISE EXCEPTION 'enrolment: a move did not close 8A at today and open 8B at today';
  END IF;
  -- Back the same day: one segment, as if never moved.
  UPDATE "Users" SET "studentGroupId" = a1 WHERE id = p;
  SELECT count(*) INTO n FROM "StudentEnrollments" WHERE "studentId" = p;
  IF n <> 1 OR NOT EXISTS (SELECT 1 FROM "StudentEnrollments" WHERE "studentId" = p AND "studentGroupId" = a1
                            AND "validFrom" = y1_start AND "validTo" IS NULL) THEN
    RAISE EXCEPTION 'enrolment: a move back the same day left % row(s) instead of the one re-opened segment', n;
  END IF;
  -- The class cleared closes it; set again the same day re-opens it.
  UPDATE "Users" SET "studentGroupId" = NULL WHERE id = p;
  IF NOT EXISTS (SELECT 1 FROM "StudentEnrollments" WHERE "studentId" = p AND "validTo" = today)
     OR EXISTS (SELECT 1 FROM "StudentEnrollments" WHERE "studentId" = p AND "validTo" IS NULL) THEN
    RAISE EXCEPTION 'enrolment: clearing the class did not close the segment at today';
  END IF;
  UPDATE "Users" SET "studentGroupId" = a1 WHERE id = p;
  -- Deactivation closes, reactivation (the same day) re-opens.
  UPDATE "Users" SET "isActive" = false WHERE id = p;
  IF EXISTS (SELECT 1 FROM "StudentEnrollments" WHERE "studentId" = p AND "validTo" IS NULL) THEN
    RAISE EXCEPTION 'enrolment: a deactivated pupil still has an open segment';
  END IF;
  UPDATE "Users" SET "isActive" = true WHERE id = p;
  SELECT count(*) INTO n FROM "StudentEnrollments" WHERE "studentId" = p;
  IF n <> 1 OR NOT EXISTS (SELECT 1 FROM "StudentEnrollments" WHERE "studentId" = p AND "validTo" IS NULL AND "validFrom" = y1_start) THEN
    RAISE EXCEPTION 'enrolment: reactivation the same day left % row(s), expected the one re-opened segment', n;
  END IF;

  -- A malformed hint is ignored, never raised: another pupil out of 7A.
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt", "studentGroupId")
  VALUES (school, 'rls26-r@example.invalid', 'RLS26', 'R', 'STUDENT', gen_random_uuid(), true, now(), a0) RETURNING id INTO r;
  PERFORM set_config('app.enrolment_from', y1::text || ':2026-99-99', true);
  UPDATE "Users" SET "studentGroupId" = b1 WHERE id = r;
  PERFORM set_config('app.enrolment_from', 'nonsense', true);
  IF NOT EXISTS (SELECT 1 FROM "StudentEnrollments" WHERE "studentId" = r AND "studentGroupId" = b1 AND "validFrom" = today) THEN
    RAISE EXCEPTION 'enrolment: a malformed hint was not ignored';
  END IF;
  PERFORM set_config('app.enrolment_from', '', true);

  -- A corrected class grade corrects every segment in the class.
  UPDATE "StudentGroups" SET "gradeLevel" = 9 WHERE id = a1;
  IF EXISTS (SELECT 1 FROM "StudentEnrollments" WHERE "studentGroupId" = a1 AND "gradeLevel" IS DISTINCT FROM 9) THEN
    RAISE EXCEPTION 'enrolment: a corrected class grade left a segment behind';
  END IF;
  UPDATE "StudentGroups" SET "gradeLevel" = 8 WHERE id = a1;

  -- A class with history keeps its year.
  BEGIN
    UPDATE "StudentGroups" SET "academicYearId" = y0 WHERE id = a1;
    RAISE EXCEPTION 'enrolment: a class with history was moved to another year';
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS con = CONSTRAINT_NAME;
    IF con IS DISTINCT FROM 'StudentEnrollments_studentGroupId_academicYearId_schoolId_fkey' THEN
      RAISE EXCEPTION 'enrolment: the year change was refused by "%", expected the history''s class key', con;
    END IF;
  END;

  -- Another school's class is refused for every pupil, active or not, and in
  -- Users' own key's words: the refusal of school B's class id reads exactly
  -- like that of an id that exists nowhere (no existence oracle, and nothing
  -- of school B — its year — in the detail).
  BEGIN
    UPDATE "Users" SET "studentGroupId" = gen_random_uuid() WHERE id = r;
    RAISE EXCEPTION 'enrolment: a pupil was placed in a class that does not exist';
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS con = CONSTRAINT_NAME, msg_none = MESSAGE_TEXT, det_none = PG_EXCEPTION_DETAIL;
  END;
  BEGIN
    UPDATE "Users" SET "studentGroupId" = current_setting('app.test_group_b')::uuid WHERE id = r;
    RAISE EXCEPTION 'enrolment: a pupil was placed in another school''s class';
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS con_b = CONSTRAINT_NAME, msg_b = MESSAGE_TEXT, det_b = PG_EXCEPTION_DETAIL;
    IF con_b IS DISTINCT FROM con OR msg_b IS DISTINCT FROM msg_none OR det_b IS DISTINCT FROM det_none THEN
      RAISE EXCEPTION 'enrolment: another school''s class is refused as "%" / "%" / "%", an unknown id as "%" / "%" / "%"',
        con_b, msg_b, det_b, con, msg_none, det_none;
    END IF;
  END;
  BEGIN
    UPDATE "Users" SET "isActive" = false, "studentGroupId" = current_setting('app.test_group_b')::uuid WHERE id = r;
    RAISE EXCEPTION 'enrolment: an inactive pupil was placed in another school''s class';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt", "studentGroupId")
    VALUES (school, 'rls26-x@example.invalid', 'RLS26', 'X', 'STUDENT', gen_random_uuid(), false, now(),
            current_setting('app.test_group_b')::uuid);
    RAISE EXCEPTION 'enrolment: an inactive pupil was created in another school''s class';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  -- A deleted class: a closed segment with no class and its grade.
  DELETE FROM "StudentGroups" WHERE id = a1;
  SELECT * INTO seg FROM "StudentEnrollments" WHERE "studentId" = p;
  IF seg."studentGroupId" IS NOT NULL OR seg."gradeLevel" IS DISTINCT FROM 8 OR seg."validFrom" <> y1_start
     OR seg."validTo" IS DISTINCT FROM today OR (SELECT "studentGroupId" FROM "Users" WHERE id = p) IS NOT NULL THEN
    RAISE EXCEPTION 'enrolment: a deleted class left %, expected a closed segment with no class and grade 8', row_to_json(seg);
  END IF;

  -- A role change clears the class and closes the segment (r's held no day: deleted).
  UPDATE "Users" SET role = 'TEACHER', "studentGroupId" = NULL WHERE id = r;
  SELECT count(*) INTO n FROM "StudentEnrollments" WHERE "studentId" = r;
  IF n <> 0 THEN
    RAISE EXCEPTION 'enrolment: a pupil who became staff the day they were placed keeps % segment(s)', n;
  END IF;

  -- A pupil without a class has no segment; the year deleted takes its history.
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (school, 'rls26-q@example.invalid', 'RLS26', 'Q', 'STUDENT', gen_random_uuid(), true, now()) RETURNING id INTO q;
  IF EXISTS (SELECT 1 FROM "StudentEnrollments" WHERE "studentId" = q) THEN
    RAISE EXCEPTION 'enrolment: a pupil without a class has a segment';
  END IF;
  UPDATE "Users" SET "studentGroupId" = b1 WHERE id = q;
  DELETE FROM "AcademicYears" WHERE id = y1;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 OR EXISTS (SELECT 1 FROM "StudentEnrollments" WHERE "academicYearId" = y1) THEN
    RAISE EXCEPTION 'enrolment: deleting a year with class history did not take it along';
  END IF;
  DELETE FROM "AcademicYears" WHERE id = y0;
  -- A person deleted takes theirs (GDPR erasure).
  DELETE FROM "Users" WHERE id IN (p, q);
  IF EXISTS (SELECT 1 FROM "StudentEnrollments" WHERE "studentId" IN (p, q)) THEN
    RAISE EXCEPTION 'enrolment: a deleted pupil left class history behind';
  END IF;
END
$$;
ROLLBACK;

-- The catalog half: row security on, exactly the four read arms each with the
-- role in USING, the writers and guards present and SECURITY DEFINER, SELECT
-- and nothing else for the API role, nothing for anon.
DO $$
DECLARE n integer; bad text; api_role text;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public."StudentEnrollments"'::regclass) THEN
    RAISE EXCEPTION 'enrolment: row security is off on StudentEnrollments';
  END IF;
  -- Five since 20261014130000: student_enrollments_service_select is the
  -- SS12000 v2.0 provider's read (a class's groupMemberships, a pupil's
  -- enrolments), for the service principal of the row's school only, and it
  -- is held to exactly that predicate below instead of a role.
  SELECT string_agg(polname || ':' || polcmd::text, ',' ORDER BY polname) INTO bad FROM pg_policy
   WHERE polrelid = 'public."StudentEnrollments"'::regclass;
  IF bad IS DISTINCT FROM 'student_enrollments_admin_select:r,student_enrollments_guardian_select:r,student_enrollments_service_select:r,student_enrollments_staff_select:r,student_enrollments_student_select:r' THEN
    RAISE EXCEPTION 'enrolment: StudentEnrollments has policies (%), expected the four SELECT arms and the service''s', bad;
  END IF;
  SELECT string_agg(polname, ',') INTO bad FROM pg_policy
   WHERE polrelid = 'public."StudentEnrollments"'::regclass
     AND pg_get_expr(polqual, polrelid) NOT LIKE '%current_user_role%'
     AND NOT (polname = 'student_enrollments_service_select'
              AND pg_get_expr(polqual, polrelid) = '("schoolId" = app.current_service_school_id())');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'enrolment: policies without the role in USING: %', bad;
  END IF;
  SELECT count(*) INTO n
    FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
   WHERE NOT t.tgisinternal AND t.tgenabled = 'O' AND p.prosecdef
     AND (t.tgrelid, t.tgname) IN (
       ('public."Users"'::regclass,              'Users_enrollment_on_insert'),
       ('public."Users"'::regclass,              'Users_enrollment_on_update'),
       ('public."StudentGroups"'::regclass,      'StudentGroups_enrollment_grade'),
       ('public."StudentEnrollments"'::regclass, 'StudentEnrollments_written_by_trigger'),
       ('public."StudentEnrollments"'::regclass, 'StudentEnrollments_no_truncate'));
  IF n <> 5 THEN
    RAISE EXCEPTION 'enrolment: % of the five history triggers are present, enabled and SECURITY DEFINER', n;
  END IF;
  IF NOT has_table_privilege('app_authenticated', 'public."StudentEnrollments"', 'SELECT') THEN
    RAISE EXCEPTION 'enrolment: app_authenticated cannot read StudentEnrollments';
  END IF;
  FOR api_role IN SELECT rolname FROM pg_roles
                   WHERE rolname IN ('anon', 'authenticated', 'service_role', 'app_authenticated')
  LOOP
    SELECT string_agg(p, ', ') INTO bad
      FROM unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
     WHERE has_table_privilege(api_role, 'public."StudentEnrollments"', p);
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'enrolment: % holds % on StudentEnrollments', api_role, bad;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND has_table_privilege('anon', 'public."StudentEnrollments"', 'SELECT') THEN
    RAISE EXCEPTION 'enrolment: anon may SELECT StudentEnrollments';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Section 26e: en lydelse vet hur den gäller.
--
-- 20261010130000 adds NationalTimplanVersions."appliesBy" and three totals-only
-- 2028 rows. The column is the statute's like the rest of the row: a pupil and
-- a guardian read it (their card's figures are judged by it), nobody writes
-- it, and the figures are SFS 2025:729's — 7 424, 7 199 and 5 007, with no
-- cells.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000004')::text, true);
DO $$
DECLARE n bigint; figures text;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'GUARDIAN' THEN
    RAISE EXCEPTION 'lydelse: expected a GUARDIAN, resolved %', coalesce(app.current_user_role()::text, '<none>');
  END IF;
  SELECT string_agg(code || '=' || "appliesBy" || ':' || "totalHours", ',' ORDER BY code) INTO figures
    FROM "NationalTimplanVersions" WHERE code LIKE 'SFS2025:729%';
  IF figures IS DISTINCT FROM 'SFS2025:729=COHORTS_STARTING:7424,SFS2025:729/AGA=COHORTS_STARTING:7424,SFS2025:729/AGB=COHORTS_STARTING:7199,SFS2025:729/SAM=COHORTS_STARTING:5007' THEN
    RAISE EXCEPTION 'lydelse: a guardian reads the 2028 rows as %', figures;
  END IF;
  SELECT count(*) INTO n FROM "NationalTimplanVersions" WHERE code LIKE 'SFS2023:945/%' AND "appliesBy" <> 'STAGES_NOT_COMPLETED';
  IF n <> 0 THEN
    RAISE EXCEPTION 'lydelse: % SFS 2023:945 row(s) not applied by stage', n;
  END IF;
  SELECT count(*) INTO n FROM "NationalTimplanEntries" e JOIN "NationalTimplanVersions" v ON v.id = e."versionId"
   WHERE v.code LIKE 'SFS2025:729%';
  IF n <> 0 THEN
    RAISE EXCEPTION 'lydelse: a 2028 row carries % cell(s) nobody has published', n;
  END IF;
END
$$;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
BEGIN
  BEGIN
    UPDATE "NationalTimplanVersions" SET "appliesBy" = 'COHORTS_STARTING' WHERE code = 'SFS2023:945/B1';
    RAISE EXCEPTION 'lydelse: an admin rewrote how a lydelse applies';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 26d: skolans utskick av undervisningstiden.
--
-- TimplanStatementPublications and TimplanStatements (20261010140000) hold the
-- pupils' published hours. The admin writes them; a STUDENT reads exactly
-- their own rows, a GUARDIAN exactly their children's, and neither reads the
-- publication row (it names the publishing admin and counts the school's
-- pupils; their rows carry its year and day, held equal by the key); a
-- TEACHER reads nothing; nobody reads the second school's. Asserted from the
-- excluding side, in the transaction that just wrote the rows, with role
-- guards.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
DECLARE
  school uuid := app.current_school_id();
  y uuid; pub uuid; child uuid; other uuid; n bigint;
BEGIN
  IF app.current_user_role() <> 'SCHOOL_ADMIN' THEN
    RAISE EXCEPTION 'statement: expected an admin, am %', app.current_user_role();
  END IF;
  SELECT count(*) INTO n FROM "TimplanStatements" WHERE "schoolId" <> school;
  IF n <> 0 THEN
    RAISE EXCEPTION 'statement: the admin reads % row(s) of another school''s statement', n;
  END IF;
  SELECT gs."studentId" INTO child FROM "GuardianStudents" gs
    JOIN "Users" g ON g.id = gs."guardianId" AND g."authId" = '00000000-0000-4000-8000-000000000004';
  SELECT id INTO other FROM "Users" WHERE "schoolId" = school AND role = 'STUDENT' AND id <> child ORDER BY id LIMIT 1;
  SELECT id INTO y FROM "AcademicYears" WHERE "schoolId" = school AND "isActive";
  DELETE FROM "TimplanStatementPublications";
  INSERT INTO "TimplanStatementPublications" ("schoolId", "academicYearId", "publishedByUserId", "asOfDate", pupils)
  VALUES (school, y, app.current_user_id(), current_date, 2) RETURNING id INTO pub;
  INSERT INTO "TimplanStatements" ("schoolId", "publicationId", "academicYearId", "asOfDate", "studentId", stage, "subjectCode",
                                   "distributionPublished", "gradesFrom", "gradesTo", "nationalHours", "plannedHours", "outcomeHours",
                                   "projectedHours", status, "projectedStatus", complete)
  VALUES (school, pub, y, current_date, child, 'MELLAN', 'MA', true, 4, 6, 410, 413, 263, 413, 'MET', 'MET', true),
         (school, pub, y, current_date, other, 'MELLAN', 'MA', true, 4, 6, 410, 300, 200, 300, 'BELOW', 'BELOW', true);
  -- A row's year and day are its publication's: the key refuses any other.
  BEGIN
    UPDATE "TimplanStatements" SET "asOfDate" = current_date - 1 WHERE "studentId" = child;
    RAISE EXCEPTION 'statement: a row was dated apart from its publication';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  -- The CHECKs bound what even the admin's own PostgREST writes.
  BEGIN
    UPDATE "TimplanStatements" SET "plannedHours" = 20001 WHERE "studentId" = child;
    RAISE EXCEPTION 'statement: 20001 h was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE "TimplanStatements" SET status = 'FEL' WHERE "studentId" = child;
    RAISE EXCEPTION 'statement: an unknown status was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  PERFORM set_config('app.test_rls26d_child', child::text, true);
  PERFORM set_config('app.test_rls26d_other', other::text, true);
  PERFORM set_config('app.test_rls26d_child_sub', (SELECT "authId"::text FROM "Users" WHERE id = child), true);
  PERFORM set_config('app.test_rls26d_teacher_sub', (SELECT "authId"::text FROM "Users"
    WHERE "schoolId" = school AND role = 'TEACHER' ORDER BY "authId" LIMIT 1), true);
END
$$;

-- The child as a STUDENT: their row, nothing else — not the publication row; no write.
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls26d_child_sub'))::text, true);
DO $$
DECLARE n bigint; me uuid := app.current_user_id();
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'STUDENT' OR me IS DISTINCT FROM current_setting('app.test_rls26d_child')::uuid THEN
    RAISE EXCEPTION 'statement: expected the child as a STUDENT, resolved % (%)', app.current_user_role(), me;
  END IF;
  SELECT count(*) INTO n FROM "TimplanStatements" WHERE "studentId" <> me;
  IF n <> 0 THEN
    RAISE EXCEPTION 'statement: a pupil reads % row(s) of another pupil''s hours', n;
  END IF;
  SELECT count(*) INTO n FROM "TimplanStatements" WHERE "studentId" = me;
  IF n <> 1 THEN
    RAISE EXCEPTION 'statement: a pupil reads % of their own row(s), expected 1', n;
  END IF;
  SELECT count(*) INTO n FROM "TimplanStatementPublications";
  IF n <> 0 THEN
    RAISE EXCEPTION 'statement: a pupil reads % publication row(s) — the publishing admin and the pupil count', n;
  END IF;
  -- What the card needs of the publication is on the pupil's own row.
  SELECT count(*) INTO n FROM "TimplanStatements" WHERE "studentId" = me AND "academicYearId" IS NOT NULL AND "asOfDate" = current_date;
  IF n <> 1 THEN
    RAISE EXCEPTION 'statement: the pupil''s row does not carry its year and day';
  END IF;
  BEGIN
    INSERT INTO "TimplanStatements" ("schoolId", "publicationId", "academicYearId", "asOfDate", "studentId", stage, "subjectCode",
                                     "distributionPublished", "gradesFrom", "gradesTo", "plannedHours", "outcomeHours", "projectedHours",
                                     status, "projectedStatus", complete)
    SELECT "schoolId", "publicationId", "academicYearId", "asOfDate", me, 'HOG', 'EN', true, 7, 9, 1, 1, 1, 'MET', 'MET', true
      FROM "TimplanStatements" LIMIT 1;
    RAISE EXCEPTION 'statement: a pupil wrote a statement row';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  UPDATE "TimplanStatements" SET "plannedHours" = 999 WHERE "studentId" = me;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'statement: a pupil rewrote % of their own row(s)', n;
  END IF;
  DELETE FROM "TimplanStatementPublications";
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'statement: a pupil withdrew the school''s statement';
  END IF;
END
$$;

-- The guardian: their child's row only.
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000004')::text, true);
DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'GUARDIAN' THEN
    RAISE EXCEPTION 'statement: expected a GUARDIAN, resolved %', coalesce(app.current_user_role()::text, '<none>');
  END IF;
  SELECT count(*) INTO n FROM "TimplanStatements" WHERE "studentId" <> current_setting('app.test_rls26d_child')::uuid;
  IF n <> 0 THEN
    RAISE EXCEPTION 'statement: a guardian reads % row(s) of a pupil who is not their child', n;
  END IF;
  SELECT count(*) INTO n FROM "TimplanStatements";
  IF n <> 1 THEN
    RAISE EXCEPTION 'statement: a guardian reads % of their child''s row(s), expected 1', n;
  END IF;
  SELECT count(*) INTO n FROM "TimplanStatementPublications";
  IF n <> 0 THEN
    RAISE EXCEPTION 'statement: a guardian reads % publication row(s) — the publishing admin and the pupil count', n;
  END IF;
END
$$;

-- A teacher: nothing of either table.
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls26d_teacher_sub'))::text, true);
DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'TEACHER' THEN
    RAISE EXCEPTION 'statement: expected a TEACHER, resolved %', app.current_user_role();
  END IF;
  SELECT (SELECT count(*) FROM "TimplanStatements") + (SELECT count(*) FROM "TimplanStatementPublications") INTO n;
  IF n <> 0 THEN
    RAISE EXCEPTION 'statement: a teacher reads % statement or publication row(s)', n;
  END IF;
END
$$;
ROLLBACK;

DO $$
DECLARE bad text; api_role text;
BEGIN
  SELECT string_agg(polname || ':' || polcmd::text, ',' ORDER BY polname) INTO bad FROM pg_policy
   WHERE polrelid IN ('public."TimplanStatements"'::regclass, 'public."TimplanStatementPublications"'::regclass);
  IF bad IS DISTINCT FROM 'timplan_statement_publications_admin_all:*,timplan_statements_admin_all:*,timplan_statements_guardian_select:r,timplan_statements_student_select:r' THEN
    RAISE EXCEPTION 'statement: policies are %', bad;
  END IF;
  SELECT string_agg(polname, ',') INTO bad FROM pg_policy
   WHERE polrelid IN ('public."TimplanStatements"'::regclass, 'public."TimplanStatementPublications"'::regclass)
     AND pg_get_expr(polqual, polrelid) NOT LIKE '%current_user_role%';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'statement: policies without the role in USING: %', bad;
  END IF;
  FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role', 'app_authenticated') LOOP
    SELECT string_agg(p, ', ') INTO bad
      FROM unnest(ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER']) p
     WHERE has_table_privilege(api_role, 'public."TimplanStatements"', p)
        OR has_table_privilege(api_role, 'public."TimplanStatementPublications"', p);
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'statement: % holds % on the statement tables', api_role, bad;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Section 27a: en publicering har en giltighet.
--
-- PublicationSettings, TimetablePublications and PublishedLessons
-- (20261011090000). The admin writes the policy and the log; the log is
-- append-only by privilege (no UPDATE, no DELETE for the API role); a
-- range outside its läsår is refused by the constraint trigger (PB409); a
-- snapshot row can only be erased on a person, never rewritten. A TEACHER
-- reads the snapshot (the published grundschema is theirs to see) and its
-- validity through app.publication_snapshot_ranges (20261011131000), never a
-- row of the log — whose gates name the draft — and never the policy; a
-- STUDENT and a GUARDIAN read none of the three and are given no range.
-- Asserted in the transaction that wrote the rows, then rolled back.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
DECLARE
  school uuid := app.current_school_id();
  y uuid; y_start date; y_end date; pub uuid; lesson uuid; subj uuid; grp uuid; pupil uuid; n bigint;
BEGIN
  IF app.current_user_role() <> 'SCHOOL_ADMIN' THEN
    RAISE EXCEPTION 'publication: expected an admin, am %', app.current_user_role();
  END IF;
  SELECT id, "startDate", "endDate" INTO y, y_start, y_end FROM "AcademicYears" WHERE "schoolId" = school AND "isActive";
  SELECT id INTO subj FROM "Subjects" WHERE "schoolId" = school ORDER BY id LIMIT 1;
  SELECT id INTO grp FROM "StudentGroups" WHERE "schoolId" = school AND "academicYearId" = y ORDER BY id LIMIT 1;
  SELECT id INTO pupil FROM "Users" WHERE "schoolId" = school AND role = 'STUDENT' ORDER BY id LIMIT 1;

  INSERT INTO "PublicationSettings" ("schoolId", "gateClashes") VALUES (school, 'REFUSE')
  ON CONFLICT ("schoolId") DO UPDATE SET "gateClashes" = 'REFUSE';

  INSERT INTO "TimetablePublications" ("schoolId", "academicYearId", kind, outcome, "publishMode", "validFrom", "validTo",
                                       "publishedByUserId", created, gates, "lessonCount")
  VALUES (school, y, 'PUBLISH', 'PUBLISHED', 'DRAFT', y_start, y_end, app.current_user_id(), 3, '[]', 1)
  RETURNING id INTO pub;
  -- A refused attempt whose gates name the draft (20261011131000): no teacher reads it.
  INSERT INTO "TimetablePublications" ("schoolId", "academicYearId", kind, outcome, "publishMode", "validFrom", "validTo", gates)
  VALUES (school, y, 'PUBLISH', 'REFUSED', 'DRAFT', y_start, y_end,
          '[{"code": "PUB_WEEK_SPLIT", "severity": "REFUSE", "items": [{"label": "Ma · 7A: tors → mån"}]}]');

  -- The range lies inside its läsår.
  BEGIN
    INSERT INTO "TimetablePublications" ("schoolId", "academicYearId", kind, outcome, "publishMode", "validFrom", "validTo")
    VALUES (school, y, 'PUBLISH', 'PUBLISHED', 'DIRECT', y_start - 1, y_end);
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'publication: a range starting before its year was stored';
  EXCEPTION WHEN SQLSTATE 'PB409' THEN NULL;
  END;
  BEGIN
    INSERT INTO "TimetablePublications" ("schoolId", "academicYearId", kind, outcome, "publishMode", "validFrom", "validTo")
    VALUES (school, y, 'PUBLISH', 'PUBLISHED', 'DIRECT', y_end, y_start);
    RAISE EXCEPTION 'publication: a reversed range was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- A refused attempt materialised nothing.
  BEGIN
    INSERT INTO "TimetablePublications" ("schoolId", "academicYearId", kind, outcome, "publishMode", "validFrom", "validTo", created)
    VALUES (school, y, 'PUBLISH', 'REFUSED', 'DIRECT', y_start, y_end, 1);
    RAISE EXCEPTION 'publication: a refusal that created lessons was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- Append-only: no UPDATE, no DELETE for the API role.
  BEGIN
    UPDATE "TimetablePublications" SET created = 99 WHERE id = pub;
    RAISE EXCEPTION 'publication: the log was rewritten';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM "TimetablePublications" WHERE id = pub;
    RAISE EXCEPTION 'publication: the log was deleted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  INSERT INTO "PublishedLessons" ("schoolId", "publicationId", "academicYearId", "masterLessonId", "subjectId", "studentGroupId",
                                  "dayOfWeek", "startTime", "endTime", "isLocked", "isGenerated", "isParked", recurrence, "studentIds")
  VALUES (school, pub, y, gen_random_uuid(), subj, grp, 1, '08:00', '09:00', false, true, false, 'ALL_WEEKS', ARRAY[pupil])
  RETURNING id INTO lesson;
  -- A snapshot row's year is its publication's.
  BEGIN
    INSERT INTO "PublishedLessons" ("schoolId", "publicationId", "academicYearId", "masterLessonId", "subjectId", "studentGroupId",
                                    "dayOfWeek", "startTime", "endTime", "isLocked", "isGenerated", "isParked", recurrence)
    VALUES (school, pub, gen_random_uuid(), gen_random_uuid(), subj, grp, 1, '08:00', '09:00', false, true, false, 'ALL_WEEKS');
    RAISE EXCEPTION 'publication: a snapshot row of another year was stored';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  -- Only an erasure: a moved lesson is refused, a pupil scrubbed is not.
  BEGIN
    UPDATE "PublishedLessons" SET "dayOfWeek" = 2 WHERE id = lesson;
    RAISE EXCEPTION 'publication: a published lesson was moved';
  EXCEPTION WHEN SQLSTATE 'PB409' THEN NULL;
  END;
  BEGIN
    UPDATE "PublishedLessons" SET "studentIds" = ARRAY[pupil, gen_random_uuid()] WHERE id = lesson;
    RAISE EXCEPTION 'publication: a pupil was added to a published lesson';
  EXCEPTION WHEN SQLSTATE 'PB409' THEN NULL;
  END;
  UPDATE "PublishedLessons" SET "studentIds" = '{}' WHERE id = lesson;
  BEGIN
    DELETE FROM "PublishedLessons" WHERE id = lesson;
    RAISE EXCEPTION 'publication: a published lesson was deleted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  SELECT count(*) INTO n FROM "TimetablePublications" WHERE "schoolId" <> school;
  IF n <> 0 THEN
    RAISE EXCEPTION 'publication: the admin reads % publication(s) of another school', n;
  END IF;

  PERFORM set_config('app.test_rls27_pub', pub::text, true);
  PERFORM set_config('app.test_rls27_teacher_sub', (SELECT "authId"::text FROM "Users"
    WHERE "schoolId" = school AND role = 'TEACHER' AND "isActive" ORDER BY "authId" LIMIT 1), true);
  PERFORM set_config('app.test_rls27_student_sub', (SELECT "authId"::text FROM "Users"
    WHERE "schoolId" = school AND role = 'STUDENT' AND "isActive" ORDER BY "authId" LIMIT 1), true);
END
$$;

-- A TEACHER: the snapshot and its validity (app.publication_snapshot_ranges),
-- never a row of the log — no gates, no refusal — and never the policy; no write.
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls27_teacher_sub'))::text, true);
DO $$
DECLARE n bigint; r record;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'TEACHER' THEN
    RAISE EXCEPTION 'publication: expected a TEACHER, resolved %', app.current_user_role();
  END IF;
  SELECT count(*) INTO n FROM "TimetablePublications";
  IF n <> 0 THEN RAISE EXCEPTION 'publication: a teacher reads % row(s) of the log, gates and refusals included', n; END IF;
  SELECT count(*) INTO n FROM app.publication_snapshot_ranges(
    (SELECT "academicYearId" FROM "PublishedLessons" WHERE "publicationId" = current_setting('app.test_rls27_pub')::uuid));
  IF n <> 1 THEN RAISE EXCEPTION 'publication: a teacher is given % snapshot range(s), expected 1 (no refusal)', n; END IF;
  SELECT * INTO r FROM app.publication_snapshot_ranges(
    (SELECT "academicYearId" FROM "PublishedLessons" WHERE "publicationId" = current_setting('app.test_rls27_pub')::uuid));
  IF r.id IS DISTINCT FROM current_setting('app.test_rls27_pub')::uuid THEN
    RAISE EXCEPTION 'publication: the snapshot range is %, not the publication', r.id;
  END IF;
  SELECT count(*) INTO n FROM "PublishedLessons" WHERE "publicationId" = current_setting('app.test_rls27_pub')::uuid;
  IF n <> 1 THEN RAISE EXCEPTION 'publication: a teacher reads % published lesson(s), expected 1', n; END IF;
  SELECT count(*) INTO n FROM "PublicationSettings";
  IF n <> 0 THEN RAISE EXCEPTION 'publication: a teacher reads the school''s publish policy'; END IF;
  BEGIN
    INSERT INTO "TimetablePublications" ("schoolId", "academicYearId", kind, outcome, "publishMode", "validFrom", "validTo")
    SELECT "schoolId", "academicYearId", 'PUBLISH', 'PUBLISHED', 'DIRECT', '2026-09-01', '2026-09-02'
      FROM "PublishedLessons" WHERE "publicationId" = current_setting('app.test_rls27_pub')::uuid;
    RAISE EXCEPTION 'publication: a teacher published';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;

-- A STUDENT and a GUARDIAN: none of the three.
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls27_student_sub'))::text, true);
DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'STUDENT' THEN
    RAISE EXCEPTION 'publication: expected a STUDENT, resolved %', app.current_user_role();
  END IF;
  SELECT (SELECT count(*) FROM "TimetablePublications") + (SELECT count(*) FROM "PublishedLessons")
       + (SELECT count(*) FROM "PublicationSettings")
       + (SELECT count(*) FROM app.publication_snapshot_ranges((SELECT id FROM "AcademicYears" WHERE "isActive" LIMIT 1))) INTO n;
  IF n <> 0 THEN RAISE EXCEPTION 'publication: a pupil reads % publication row(s)', n; END IF;
END
$$;
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000004')::text, true);
DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'GUARDIAN' THEN
    RAISE EXCEPTION 'publication: expected a GUARDIAN, resolved %', app.current_user_role();
  END IF;
  SELECT (SELECT count(*) FROM "TimetablePublications") + (SELECT count(*) FROM "PublishedLessons")
       + (SELECT count(*) FROM "PublicationSettings") INTO n;
  IF n <> 0 THEN RAISE EXCEPTION 'publication: a guardian reads % publication row(s)', n; END IF;
END
$$;
ROLLBACK;

DO $$
DECLARE bad text; api_role text;
BEGIN
  SELECT string_agg(polname || ':' || polcmd::text, ',' ORDER BY polname) INTO bad FROM pg_policy
   WHERE polrelid IN ('public."PublicationSettings"'::regclass, 'public."TimetablePublications"'::regclass,
                      'public."PublishedLessons"'::regclass);
  IF bad IS DISTINCT FROM 'publication_settings_admin_all:*,published_lessons_admin_erase:w,published_lessons_admin_insert:a,'
                          'published_lessons_admin_select:r,published_lessons_service_select:r,published_lessons_staff_select:r,'
                          'timetable_publications_admin_insert:a,timetable_publications_admin_select:r,'
                          'timetable_publications_service_select:r' THEN
    RAISE EXCEPTION 'publication: policies are %', bad;
  END IF;
  -- Every authenticated arm asks the role, in USING and in WITH CHECK.
  SELECT string_agg(polname, ',') INTO bad FROM pg_policy
   WHERE polrelid IN ('public."PublicationSettings"'::regclass, 'public."TimetablePublications"'::regclass,
                      'public."PublishedLessons"'::regclass)
     AND polname NOT LIKE '%service%'
     AND (coalesce(pg_get_expr(polqual, polrelid), '') NOT LIKE '%current_user_role%' AND polcmd <> 'a'
          OR (polcmd IN ('a', 'w', '*') AND coalesce(pg_get_expr(polwithcheck, polrelid), '') NOT LIKE '%current_user_role%'));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'publication: arms without the role: %', bad;
  END IF;
  FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role', 'app_authenticated') LOOP
    SELECT string_agg(p, ', ') INTO bad
      FROM unnest(ARRAY['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
     WHERE has_table_privilege(api_role, 'public."TimetablePublications"', p);
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'publication: % holds % on the log', api_role, bad;
    END IF;
    SELECT string_agg(p, ', ') INTO bad
      FROM unnest(ARRAY['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
     WHERE has_table_privilege(api_role, 'public."PublishedLessons"', p);
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'publication: % holds % on the snapshot', api_role, bad;
    END IF;
    IF api_role <> 'app_authenticated' AND has_function_privilege(api_role, 'app.publication_snapshot_ranges(uuid)', 'EXECUTE') THEN
      RAISE EXCEPTION 'publication: % may ask for the snapshot ranges', api_role;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('app_authenticated', 'app.publication_snapshot_ranges(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'publication: the API cannot ask for the snapshot ranges';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Section 27b–f: ett utkast syns bara för admin.
--
-- 20261011100000. In DRAFT every arm of MasterLessons, MasterLessonGroups,
-- MasterLessonStudents and LunchSittings that admits somebody other than the
-- admin admits nobody; in DIRECT each admits whom it always admitted. The
-- catalog is asserted from pg_policies, so a forgotten or a future arm fails
-- here as it fails the migration (b). Deleting a master in DRAFT records its
-- future rows, and nobody but the trigger writes the record (c). The lock
-- functions refuse another school (d). A cascade from a läsår records
-- nothing and does not fail (f).
-- ---------------------------------------------------------------------------

-- 27b, the catalog: no arm but the admin's reads without the predicate.
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(tablename || '.' || policyname, ', ' ORDER BY tablename, policyname) INTO bad
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('MasterLessons', 'MasterLessonGroups', 'MasterLessonStudents', 'LunchSittings')
     AND cmd IN ('SELECT', 'ALL')
     AND policyname NOT LIKE '%admin_all'
     AND coalesce(qual, '') NOT LIKE '%grundschema_is_live%';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'draft: arms without the predicate: %', bad;
  END IF;
  -- The two arms 20260713150000 generated through format() are among them.
  IF (SELECT count(*) FROM pg_policies WHERE policyname IN ('masterlessongroups_staff_select', 'masterlessonstudents_staff_select')
        AND qual LIKE '%grundschema_is_live%') <> 2 THEN
    RAISE EXCEPTION 'draft: the generated staff arms lack the predicate';
  END IF;
END $$;

-- 27b, behaviour: a lesson with an extra class, a named pupil and a meal,
-- read by every role in DIRECT and then in DRAFT, in one rolled-back
-- transaction.
BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
DECLARE
  school uuid := app.current_school_id();
  y uuid; subj uuid; home uuid; extra uuid; pupil uuid; m uuid;
BEGIN
  SELECT id INTO y FROM "AcademicYears" WHERE "schoolId" = school AND "isActive";
  SELECT id INTO subj FROM "Subjects" WHERE "schoolId" = school ORDER BY id LIMIT 1;
  -- The fixture guardian's child and their class, so the student and the
  -- guardian arms have something to admit.
  SELECT u.id, u."studentGroupId" INTO pupil, home FROM "Users" u
    JOIN "GuardianStudents" gs ON gs."studentId" = u.id
    JOIN "Users" g ON g.id = gs."guardianId" AND g."authId" = '00000000-0000-4000-8000-000000000004'
   WHERE u."schoolId" = school AND u.role = 'STUDENT' AND u."isActive" AND u."studentGroupId" IS NOT NULL
   ORDER BY u."authId" LIMIT 1;
  IF pupil IS NULL THEN
    RAISE EXCEPTION 'draft: the fixture guardian has no child with a class in the primary school';
  END IF;
  SELECT id INTO extra FROM "StudentGroups" WHERE "schoolId" = school AND "academicYearId" = y AND id <> home ORDER BY id LIMIT 1;
  INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "dayOfWeek", "startTime", "endTime", "updatedAt")
  VALUES (school, y, subj, home, 6, '07:00', '07:30', now()) RETURNING id INTO m;
  INSERT INTO "MasterLessonGroups" ("schoolId", "masterLessonId", "studentGroupId") VALUES (school, m, extra);
  INSERT INTO "MasterLessonStudents" ("schoolId", "masterLessonId", "studentId") VALUES (school, m, pupil);
  DELETE FROM "LunchSittings" WHERE "studentGroupId" = home AND "dayOfWeek" = 6;
  INSERT INTO "LunchSittings" ("schoolId", "academicYearId", "studentGroupId", "dayOfWeek", "startTime", "endTime", "updatedAt")
  VALUES (school, y, home, 6, '11:00', '11:30', now());
  PERFORM set_config('app.test_rls27b_lesson', m::text, true);
  PERFORM set_config('app.test_rls27b_home', home::text, true);
  PERFORM set_config('app.test_rls27b_teacher_sub', (SELECT "authId"::text FROM "Users"
    WHERE "schoolId" = school AND role = 'TEACHER' AND "isActive" ORDER BY "authId" LIMIT 1), true);
  PERFORM set_config('app.test_rls27b_pupil_sub', (SELECT "authId"::text FROM "Users" WHERE id = pupil), true);
  PERFORM set_config('app.test_rls27b_guardian_sub', (SELECT g."authId"::text FROM "GuardianStudents" gs
    JOIN "Users" g ON g.id = gs."guardianId" WHERE gs."studentId" = pupil AND g."isActive" LIMIT 1), true);
END $$;

CREATE TEMP TABLE rls27b_seen (phase text, who text, lessons int, groups int, pupils int, meals int) ON COMMIT DROP;
GRANT ALL ON rls27b_seen TO PUBLIC;

-- What each role sees, written to the temp table by one function-like block per role.
SELECT set_config('app.test_rls27b_phase', 'DIRECT', true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls27b_teacher_sub'))::text, true);
INSERT INTO rls27b_seen SELECT current_setting('app.test_rls27b_phase'), 'TEACHER',
  (SELECT count(*) FROM "MasterLessons" WHERE id = current_setting('app.test_rls27b_lesson')::uuid),
  (SELECT count(*) FROM "MasterLessonGroups" WHERE "masterLessonId" = current_setting('app.test_rls27b_lesson')::uuid),
  (SELECT count(*) FROM "MasterLessonStudents" WHERE "masterLessonId" = current_setting('app.test_rls27b_lesson')::uuid),
  (SELECT count(*) FROM "LunchSittings" WHERE "studentGroupId" = current_setting('app.test_rls27b_home')::uuid AND "dayOfWeek" = 6);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls27b_pupil_sub'))::text, true);
INSERT INTO rls27b_seen SELECT current_setting('app.test_rls27b_phase'), 'STUDENT',
  (SELECT count(*) FROM "MasterLessons" WHERE id = current_setting('app.test_rls27b_lesson')::uuid),
  (SELECT count(*) FROM "MasterLessonGroups" WHERE "masterLessonId" = current_setting('app.test_rls27b_lesson')::uuid),
  (SELECT count(*) FROM "MasterLessonStudents" WHERE "masterLessonId" = current_setting('app.test_rls27b_lesson')::uuid),
  (SELECT count(*) FROM "LunchSittings" WHERE "studentGroupId" = current_setting('app.test_rls27b_home')::uuid AND "dayOfWeek" = 6);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls27b_guardian_sub'))::text, true);
INSERT INTO rls27b_seen SELECT current_setting('app.test_rls27b_phase'), 'GUARDIAN', 0, 0, 0,
  (SELECT count(*) FROM "LunchSittings" WHERE "studentGroupId" = current_setting('app.test_rls27b_home')::uuid AND "dayOfWeek" = 6);

-- The school goes DRAFT, in this transaction only.
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
INSERT INTO "PublicationSettings" ("schoolId", "publishMode") VALUES (app.current_school_id(), 'DRAFT')
ON CONFLICT ("schoolId") DO UPDATE SET "publishMode" = 'DRAFT';

SELECT set_config('app.test_rls27b_phase', 'DRAFT', true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls27b_teacher_sub'))::text, true);
INSERT INTO rls27b_seen SELECT current_setting('app.test_rls27b_phase'), 'TEACHER',
  (SELECT count(*) FROM "MasterLessons" WHERE id = current_setting('app.test_rls27b_lesson')::uuid),
  (SELECT count(*) FROM "MasterLessonGroups" WHERE "masterLessonId" = current_setting('app.test_rls27b_lesson')::uuid),
  (SELECT count(*) FROM "MasterLessonStudents" WHERE "masterLessonId" = current_setting('app.test_rls27b_lesson')::uuid),
  (SELECT count(*) FROM "LunchSittings" WHERE "studentGroupId" = current_setting('app.test_rls27b_home')::uuid AND "dayOfWeek" = 6);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls27b_pupil_sub'))::text, true);
INSERT INTO rls27b_seen SELECT current_setting('app.test_rls27b_phase'), 'STUDENT',
  (SELECT count(*) FROM "MasterLessons" WHERE id = current_setting('app.test_rls27b_lesson')::uuid),
  (SELECT count(*) FROM "MasterLessonGroups" WHERE "masterLessonId" = current_setting('app.test_rls27b_lesson')::uuid),
  (SELECT count(*) FROM "MasterLessonStudents" WHERE "masterLessonId" = current_setting('app.test_rls27b_lesson')::uuid),
  (SELECT count(*) FROM "LunchSittings" WHERE "studentGroupId" = current_setting('app.test_rls27b_home')::uuid AND "dayOfWeek" = 6);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls27b_guardian_sub'))::text, true);
INSERT INTO rls27b_seen SELECT current_setting('app.test_rls27b_phase'), 'GUARDIAN', 0, 0, 0,
  (SELECT count(*) FROM "LunchSittings" WHERE "studentGroupId" = current_setting('app.test_rls27b_home')::uuid AND "dayOfWeek" = 6);

SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
DECLARE got text; admin_sees int;
BEGIN
  SELECT string_agg(format('%s/%s:%s,%s,%s,%s', phase, who, lessons, groups, pupils, meals), ' ' ORDER BY phase DESC, who)
    INTO got FROM rls27b_seen;
  -- DIRECT: as before the migration. The teacher reads the lesson, its
  -- extra class, its pupil and the meal; the pupil their own lesson, row and
  -- meal; the guardian their child's meal. DRAFT: nobody reads any of it.
  IF got IS DISTINCT FROM
     'DRAFT/GUARDIAN:0,0,0,0 DRAFT/STUDENT:0,0,0,0 DRAFT/TEACHER:0,0,0,0 '
     'DIRECT/GUARDIAN:0,0,0,1 DIRECT/STUDENT:1,0,1,1 DIRECT/TEACHER:1,1,1,1' THEN
    RAISE EXCEPTION 'draft: who sees what is %', got;
  END IF;
  -- The admin reads and writes the draft as before.
  SELECT count(*) INTO admin_sees FROM "MasterLessons" WHERE id = current_setting('app.test_rls27b_lesson')::uuid;
  IF admin_sees <> 1 THEN RAISE EXCEPTION 'draft: the admin reads % of their own draft lesson', admin_sees; END IF;
  IF app.current_school_grundschema_is_live() THEN RAISE EXCEPTION 'draft: a DRAFT school reads as live'; END IF;
END $$;

-- 27c: a master deleted in DRAFT records every row, every status, the past
-- too (20261011132000: a held row keeps its published key until the deletion
-- is published), reconcilable only where a publish may still move it — and
-- nothing else writes the record.
DO $$
DECLARE
  school uuid := app.current_school_id();
  m uuid := current_setting('app.test_rls27b_lesson')::uuid;
  future_a uuid; future_b uuid; past uuid; n bigint;
BEGIN
  INSERT INTO "CalendarLessons" ("schoolId", "masterLessonId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", status, "updatedAt")
  SELECT school, m, "subjectId", "studentGroupId", current_date + 14, now() + interval '14 days', now() + interval '14 days 30 minutes', 'SCHEDULED', now()
    FROM "MasterLessons" WHERE id = m RETURNING id INTO future_a;
  INSERT INTO "CalendarLessons" ("schoolId", "masterLessonId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", status, "cancelCause", "updatedAt")
  SELECT school, m, "subjectId", "studentGroupId", current_date + 21, now() + interval '21 days', now() + interval '21 days 30 minutes', 'CANCELLED', 'MANUAL', now()
    FROM "MasterLessons" WHERE id = m RETURNING id INTO future_b;
  INSERT INTO "CalendarLessons" ("schoolId", "masterLessonId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", status, "updatedAt")
  SELECT school, m, "subjectId", "studentGroupId", current_date - 7, now() - interval '7 days', now() - interval '7 days' + interval '30 minutes', 'SCHEDULED', now()
    FROM "MasterLessons" WHERE id = m RETURNING id INTO past;
  BEGIN
    INSERT INTO "PublicationPendingRemovals" ("calendarLessonId", "schoolId", "academicYearId", "masterLessonId", reconcilable)
    SELECT future_a, school, "academicYearId", m, true FROM "MasterLessons" WHERE id = m;
    RAISE EXCEPTION 'draft: the admin wrote a pending removal';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  DELETE FROM "MasterLessons" WHERE id = m;
  IF (SELECT string_agg(format('%s:%s', CASE "calendarLessonId" WHEN future_a THEN 'a' WHEN future_b THEN 'b' ELSE 'past' END, reconcilable), ','
                        ORDER BY reconcilable DESC, CASE "calendarLessonId" WHEN future_a THEN 1 WHEN future_b THEN 2 ELSE 3 END)
        FROM "PublicationPendingRemovals" WHERE "masterLessonId" = m) IS DISTINCT FROM 'a:t,b:f,past:f' THEN
    RAISE EXCEPTION 'draft: the deleted lesson recorded % rather than its three rows, only the scheduled future one reconcilable',
      (SELECT coalesce(string_agg(format('%s:%s', CASE "calendarLessonId" WHEN future_a THEN 'a' WHEN future_b THEN 'b' ELSE 'past' END, reconcilable), ','), 'nothing')
         FROM "PublicationPendingRemovals" WHERE "masterLessonId" = m);
  END IF;
  -- The rows stay, their key nulled by the foreign key.
  SELECT count(*) INTO n FROM "CalendarLessons" WHERE id IN (future_a, future_b, past) AND "masterLessonId" IS NULL;
  IF n <> 3 THEN RAISE EXCEPTION 'draft: % of the three rows kept, nulled', n; END IF;
  -- A deleted calendar row takes its record with it.
  DELETE FROM "CalendarLessons" WHERE id = future_a;
  SELECT count(*) INTO n FROM "PublicationPendingRemovals" WHERE "calendarLessonId" = future_a;
  IF n <> 0 THEN RAISE EXCEPTION 'draft: a deleted row''s record outlived it'; END IF;
  PERFORM set_config('app.test_rls27c_pending', future_b::text, true);
END $$;

-- A TEACHER reads the record (ids only, for the published key); a pupil does not.
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls27b_teacher_sub'))::text, true);
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "PublicationPendingRemovals" WHERE "calendarLessonId" = current_setting('app.test_rls27c_pending')::uuid;
  IF n <> 1 THEN RAISE EXCEPTION 'draft: a teacher reads % of the pending record', n; END IF;
  BEGIN
    DELETE FROM "PublicationPendingRemovals";
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN RAISE EXCEPTION 'draft: a teacher deleted % pending record(s)', n; END IF;
  END;
END $$;
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls27b_pupil_sub'))::text, true);
DO $$
BEGIN
  IF (SELECT count(*) FROM "PublicationPendingRemovals") <> 0 THEN
    RAISE EXCEPTION 'draft: a pupil reads a pending record';
  END IF;
END $$;

-- 27d: the lock functions take only the caller's own school.
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
SELECT set_config('app.test_rls27f_other', :'school_b', true);
DO $$
BEGIN
  IF app.enter_grundschema_write(app.current_school_id()) <> 'DRAFT' THEN
    RAISE EXCEPTION 'draft: the writer''s entry did not answer DRAFT';
  END IF;
  BEGIN
    PERFORM app.enter_publication(current_setting('app.test_rls27f_other', true)::uuid);
    RAISE EXCEPTION 'draft: a school took another school''s lock';
  EXCEPTION WHEN SQLSTATE 'PB403' THEN NULL;
  END;
  IF current_setting('lock_timeout') <> '0' THEN
    RAISE EXCEPTION 'draft: the entry left lock_timeout at %', current_setting('lock_timeout');
  END IF;
END $$;

-- 27f: deleting a DRAFT läsår with future published rows cascades, records
-- nothing at depth > 1, and does not fail.
DO $$
DECLARE
  school uuid := app.current_school_id();
  y uuid; g uuid; m uuid; n bigint;
BEGIN
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
  VALUES (school, 'rls27f utkastår', current_date + 400, current_date + 700, false, now()) RETURNING id INTO y;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", kind, "updatedAt")
  VALUES (school, y, 'rls27f 7A', 7, 'CLASS', now()) RETURNING id INTO g;
  INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "dayOfWeek", "startTime", "endTime", "updatedAt")
  SELECT school, y, id, g, 1, '08:00', '09:00', now() FROM "Subjects" WHERE "schoolId" = school ORDER BY id LIMIT 1
  RETURNING id INTO m;
  INSERT INTO "CalendarLessons" ("schoolId", "masterLessonId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", "updatedAt")
  SELECT school, m, "subjectId", g, current_date + 410, now() + interval '410 days', now() + interval '410 days 1 hour', now()
    FROM "MasterLessons" WHERE id = m;
  DELETE FROM "AcademicYears" WHERE id = y;
  SELECT count(*) INTO n FROM "PublicationPendingRemovals" WHERE "masterLessonId" = m;
  IF n <> 0 THEN RAISE EXCEPTION 'draft: a cascade recorded % pending row(s)', n; END IF;
END $$;
ROLLBACK;

DO $$
DECLARE bad text; api_role text;
BEGIN
  SELECT string_agg(polname || ':' || polcmd::text, ',' ORDER BY polname) INTO bad FROM pg_policy
   WHERE polrelid = 'public."PublicationPendingRemovals"'::regclass;
  IF bad IS DISTINCT FROM 'publication_pending_removals_admin_delete:d,publication_pending_removals_admin_select:r,'
                          'publication_pending_removals_service_select:r,publication_pending_removals_staff_select:r' THEN
    RAISE EXCEPTION 'draft: pending removal policies are %', bad;
  END IF;
  FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role', 'app_authenticated') LOOP
    SELECT string_agg(p, ', ') INTO bad
      FROM unnest(ARRAY['INSERT', 'UPDATE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
     WHERE has_table_privilege(api_role, 'public."PublicationPendingRemovals"', p);
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'draft: % holds % on the pending removals', api_role, bad;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'app.enter_publication(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'draft: anon may take the publication lock';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Section 27g: en avbokning gäller många lektioner.
--
-- CancellationBatches, CancellationBatchLessons and CancellationBatchCredits
-- (20261011110000). The admin writes them; the CHECKs mirror the DTO (31 days
-- at most, a whole window or none, a scope with exactly its fields, the
-- school's own causes). A TEACHER reads the credit links (ids, for the
-- timplan's schedule gap) and nothing else; a pupil and a guardian nothing.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
DECLARE
  school uuid := app.current_school_id();
  y uuid; y_start date; b uuid; lesson uuid; credit uuid; n bigint;
BEGIN
  SELECT id, "startDate" INTO y, y_start FROM "AcademicYears" WHERE "schoolId" = school AND "isActive";
  INSERT INTO "CancellationBatches" ("schoolId", "academicYearId", name, cause, "fromDate", "toDate", scope, "minGradeLevel", "maxGradeLevel")
  VALUES (school, y, 'Prao åk 9', 'EVENT', y_start, y_start + 30, 'GRADES', 9, 9) RETURNING id INTO b;
  BEGIN
    INSERT INTO "CancellationBatches" ("schoolId", "academicYearId", name, cause, "fromDate", "toDate", scope)
    VALUES (school, y, 'För lång', 'EVENT', y_start, y_start + 31, 'SCHOOL');
    RAISE EXCEPTION 'batch: 32 days were stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "CancellationBatches" ("schoolId", "academicYearId", name, cause, "fromDate", "toDate", scope)
    VALUES (school, y, 'Lärarens', 'TEACHER_UNAVAILABLE', y_start, y_start, 'SCHOOL');
    RAISE EXCEPTION 'batch: a teacher''s cause was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "CancellationBatches" ("schoolId", "academicYearId", name, cause, "fromDate", "toDate", scope, "groupIds")
    VALUES (school, y, 'Skolan med grupper', 'EVENT', y_start, y_start, 'SCHOOL', ARRAY[gen_random_uuid()]);
    RAISE EXCEPTION 'batch: a SCHOOL scope with groups was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "CancellationBatches" ("schoolId", "academicYearId", name, cause, "fromDate", "toDate", scope, "startTime")
    VALUES (school, y, 'Halvt fönster', 'EVENT', y_start, y_start, 'SCHOOL', '13:00');
    RAISE EXCEPTION 'batch: half a time window was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE "CancellationBatches" SET reinstated = 3 WHERE id = b;
    RAISE EXCEPTION 'batch: a batch not reversed reinstated lessons';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  SELECT cl.id INTO lesson FROM "CalendarLessons" cl WHERE cl."schoolId" = school ORDER BY cl.id LIMIT 1;
  IF lesson IS NULL THEN
    INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", "updatedAt")
    SELECT school, s.id, g.id, y_start, y_start::timestamptz, y_start::timestamptz + interval '1 hour', now()
      FROM "Subjects" s, "StudentGroups" g WHERE s."schoolId" = school AND g."schoolId" = school AND g."academicYearId" = y
     ORDER BY s.id, g.id LIMIT 1 RETURNING id INTO lesson;
  END IF;
  INSERT INTO "CancellationBatchLessons" ("batchId", "calendarLessonId", "schoolId", "previousNote") VALUES (b, lesson, school, NULL);
  INSERT INTO "TimplanCredits" ("schoolId", "academicYearId", date, minutes, name, "updatedAt")
  VALUES (school, y, y_start, 300, 'Friluftsdag', now()) RETURNING id INTO credit;
  INSERT INTO "CancellationBatchCredits" ("batchId", "creditId", "schoolId") VALUES (b, credit, school);
  -- A credit deleted by hand leaves the batch.
  DELETE FROM "TimplanCredits" WHERE id = credit;
  SELECT count(*) INTO n FROM "CancellationBatchCredits" WHERE "batchId" = b;
  IF n <> 0 THEN RAISE EXCEPTION 'batch: a deleted credit stayed linked'; END IF;
  INSERT INTO "TimplanCredits" ("schoolId", "academicYearId", date, minutes, name, "updatedAt")
  VALUES (school, y, y_start, 300, 'Friluftsdag', now()) RETURNING id INTO credit;
  INSERT INTO "CancellationBatchCredits" ("batchId", "creditId", "schoolId") VALUES (b, credit, school);
  PERFORM set_config('app.test_rls27g_batch', b::text, true);
  PERFORM set_config('app.test_rls27g_teacher_sub', (SELECT "authId"::text FROM "Users"
    WHERE "schoolId" = school AND role = 'TEACHER' AND "isActive" ORDER BY "authId" LIMIT 1), true);
  PERFORM set_config('app.test_rls27g_student_sub', (SELECT "authId"::text FROM "Users"
    WHERE "schoolId" = school AND role = 'STUDENT' AND "isActive" ORDER BY "authId" LIMIT 1), true);
END $$;

SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls27g_teacher_sub'))::text, true);
DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'TEACHER' THEN RAISE EXCEPTION 'batch: expected a TEACHER'; END IF;
  SELECT (SELECT count(*) FROM "CancellationBatches") + (SELECT count(*) FROM "CancellationBatchLessons") INTO n;
  IF n <> 0 THEN RAISE EXCEPTION 'batch: a teacher reads % batch row(s)', n; END IF;
  SELECT count(*) INTO n FROM "CancellationBatchCredits" WHERE "batchId" = current_setting('app.test_rls27g_batch')::uuid;
  IF n <> 1 THEN RAISE EXCEPTION 'batch: a teacher reads % of the credit link, expected 1', n; END IF;
  BEGIN
    INSERT INTO "CancellationBatches" ("schoolId", "academicYearId", name, cause, "fromDate", "toDate", scope)
    SELECT "schoolId", id, 'Lärarens egen', 'EVENT', "startDate", "startDate", 'SCHOOL' FROM "AcademicYears" WHERE "isActive";
    RAISE EXCEPTION 'batch: a teacher made a batch';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls27g_student_sub'))::text, true);
DO $$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "CancellationBatches") + (SELECT count(*) FROM "CancellationBatchLessons")
       + (SELECT count(*) FROM "CancellationBatchCredits") INTO n;
  IF n <> 0 THEN RAISE EXCEPTION 'batch: a pupil reads % batch row(s)', n; END IF;
END $$;
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000004')::text, true);
DO $$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "CancellationBatches") + (SELECT count(*) FROM "CancellationBatchLessons")
       + (SELECT count(*) FROM "CancellationBatchCredits") INTO n;
  IF n <> 0 THEN RAISE EXCEPTION 'batch: a guardian reads % batch row(s)', n; END IF;
END $$;
ROLLBACK;

DO $$
DECLARE bad text; api_role text;
BEGIN
  SELECT string_agg(polname || ':' || polcmd::text, ',' ORDER BY polname) INTO bad FROM pg_policy
   WHERE polrelid IN ('public."CancellationBatches"'::regclass, 'public."CancellationBatchLessons"'::regclass,
                      'public."CancellationBatchCredits"'::regclass);
  IF bad IS DISTINCT FROM 'cancellation_batch_credits_admin_all:*,cancellation_batch_credits_staff_select:r,'
                          'cancellation_batch_lessons_admin_all:*,cancellation_batches_admin_all:*' THEN
    RAISE EXCEPTION 'batch: policies are %', bad;
  END IF;
  SELECT string_agg(polname, ',') INTO bad FROM pg_policy
   WHERE polrelid IN ('public."CancellationBatches"'::regclass, 'public."CancellationBatchLessons"'::regclass,
                      'public."CancellationBatchCredits"'::regclass)
     AND (pg_get_expr(polqual, polrelid) NOT LIKE '%current_user_role%'
          OR (polcmd = '*' AND pg_get_expr(polwithcheck, polrelid) NOT LIKE '%current_user_role%'));
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'batch: arms without the role: %', bad; END IF;
  FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role', 'app_authenticated') LOOP
    SELECT string_agg(p, ', ') INTO bad
      FROM unnest(ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER']) p
     WHERE has_table_privilege(api_role, 'public."CancellationBatches"', p)
        OR has_table_privilege(api_role, 'public."CancellationBatchLessons"', p)
        OR has_table_privilege(api_role, 'public."CancellationBatchCredits"', p);
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'batch: % holds % on the batch tables', api_role, bad; END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Section 27h: skolans schema kan visas utan inloggning.
--
-- PublicTimetableLinks and TeacherPublicLabels (20261011120000): the admin's
-- tables, with CHECKs on the link's shape and a guard on its target; the
-- viewer's columns on PublicationSettings with theirs. The one door,
-- app.public_timetable(), is the API role's to execute and nobody else's:
-- PostgREST's anon and authenticated cannot call it. What it answers is the
-- adapter probe's to assert, against a published week.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
DECLARE
  school uuid := app.current_school_id();
  y uuid; grp uuid; pupil uuid; teacher uuid; n bigint;
BEGIN
  SELECT id INTO y FROM "AcademicYears" WHERE "schoolId" = school AND "isActive";
  SELECT id INTO teacher FROM "Users" WHERE "schoolId" = school AND role = 'TEACHER' AND "isActive" ORDER BY id LIMIT 1;
  SELECT id INTO pupil FROM "Users" WHERE "schoolId" = school AND role = 'STUDENT' AND "isActive" ORDER BY id LIMIT 1;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "updatedAt")
  VALUES (school, y, 'rls27h liten grupp', 'TEACHING_GROUP', now()) RETURNING id INTO grp;
  INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES (school, grp, pupil);
  BEGIN
    INSERT INTO "PublicTimetableLinks" ("schoolId", "academicYearId", kind, "targetGroupId", "tokenHash")
    VALUES (school, y, 'GROUP', grp, repeat('a', 64));
    RAISE EXCEPTION 'viewer: a one-pupil group was linked';
  EXCEPTION WHEN SQLSTATE 'PB400' THEN NULL;
  END;
  BEGIN
    INSERT INTO "PublicTimetableLinks" ("schoolId", "academicYearId", kind, "targetTeacherId", "tokenHash", label)
    VALUES (school, y, 'TEACHER', teacher, repeat('b', 64), 'Anna');
    RAISE EXCEPTION 'viewer: a teacher link took a free-text name';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "PublicTimetableLinks" ("schoolId", "academicYearId", kind, "tokenHash")
    VALUES (school, y, 'TEACHER', repeat('c', 64));
    RAISE EXCEPTION 'viewer: an index of teachers was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "PublicTimetableLinks" ("schoolId", "academicYearId", kind, "tokenHash")
    VALUES (school, y, 'ROOM', 'the-token-itself');
    RAISE EXCEPTION 'viewer: a token was stored instead of its hash';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO "TeacherPublicLabels" ("userId", "schoolId", hidden) VALUES (teacher, school, true);
  BEGIN
    INSERT INTO "PublicTimetableLinks" ("schoolId", "academicYearId", kind, "targetTeacherId", "tokenHash")
    VALUES (school, y, 'TEACHER', teacher, repeat('d', 64));
    RAISE EXCEPTION 'viewer: a hidden teacher was linked';
  EXCEPTION WHEN SQLSTATE 'PB400' THEN NULL;
  END;
  INSERT INTO "PublicTimetableLinks" ("schoolId", "academicYearId", kind, "tokenHash") VALUES (school, y, 'ROOM', repeat('e', 64));
  BEGIN
    INSERT INTO "PublicationSettings" ("schoolId", "publicTeachers", "publicTeacherDisplay") VALUES (school, true, 'NONE')
    ON CONFLICT ("schoolId") DO UPDATE SET "publicTeachers" = true, "publicTeacherDisplay" = 'NONE';
    RAISE EXCEPTION 'viewer: teachers'' pages naming nobody were stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "PublicationSettings" ("schoolId", "publicMinGroupSize") VALUES (school, 2)
    ON CONFLICT ("schoolId") DO UPDATE SET "publicMinGroupSize" = 2;
    RAISE EXCEPTION 'viewer: a minimum group of 2 was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  PERFORM set_config('app.test_rls27h_teacher_sub', (SELECT "authId"::text FROM "Users" WHERE id = teacher), true);
END $$;

SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls27h_teacher_sub'))::text, true);
DO $$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "PublicTimetableLinks") + (SELECT count(*) FROM "TeacherPublicLabels") INTO n;
  IF n <> 0 THEN RAISE EXCEPTION 'viewer: a teacher reads % link or label row(s) — even their own hidden flag', n; END IF;
END $$;
ROLLBACK;

DO $$
DECLARE bad text; api_role text;
BEGIN
  SELECT string_agg(polname || ':' || polcmd::text, ',' ORDER BY polname) INTO bad FROM pg_policy
   WHERE polrelid IN ('public."PublicTimetableLinks"'::regclass, 'public."TeacherPublicLabels"'::regclass);
  IF bad IS DISTINCT FROM 'public_timetable_links_admin_all:*,teacher_public_labels_admin_all:*' THEN
    RAISE EXCEPTION 'viewer: policies are %', bad;
  END IF;
  FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
    IF has_function_privilege(api_role, 'app.public_timetable(text, uuid, date)', 'EXECUTE') THEN
      RAISE EXCEPTION 'viewer: % may call the viewer''s door', api_role;
    END IF;
    SELECT string_agg(p, ', ') INTO bad FROM unnest(ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER']) p
     WHERE has_table_privilege(api_role, 'public."PublicTimetableLinks"', p);
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'viewer: % holds % on the links', api_role, bad; END IF;
  END LOOP;
  IF NOT has_function_privilege('app_authenticated', 'app.public_timetable(text, uuid, date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'viewer: the API cannot call the viewer''s door';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'app.public_timetable(text, uuid, date)'::regprocedure) THEN
    RAISE EXCEPTION 'viewer: the door is not SECURITY DEFINER';
  END IF;
END $$;

-- With no principal the API role still reads no link itself: only the door does.
DO $$
BEGIN
  IF (SELECT count(*) FROM "PublicTimetableLinks") <> 0 OR (SELECT count(*) FROM "TeacherPublicLabels") <> 0 THEN
    RAISE EXCEPTION 'viewer: links are readable without a principal';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Section 27i: en publicering minns måltiderna.
--
-- PublishedLunchSittings (20261011130000): the meals a snapshot publication
-- published, for a DRAFT school's refill. The admin inserts and reads; the
-- table is append-only by privilege (no UPDATE, no DELETE for the API role);
-- a row's year is its publication's. A TEACHER, a STUDENT and a GUARDIAN read
-- none of it: families read their meals from CalendarLunches.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
DECLARE
  school uuid := app.current_school_id();
  y uuid; y_start date; y_end date; pub uuid; grp uuid; meal uuid;
BEGIN
  SELECT id, "startDate", "endDate" INTO y, y_start, y_end FROM "AcademicYears" WHERE "schoolId" = school AND "isActive";
  SELECT id INTO grp FROM "StudentGroups" WHERE "schoolId" = school AND "academicYearId" = y ORDER BY id LIMIT 1;
  INSERT INTO "TimetablePublications" ("schoolId", "academicYearId", kind, outcome, "publishMode", "validFrom", "validTo", "lessonCount")
  VALUES (school, y, 'BASELINE', 'PUBLISHED', 'DRAFT', y_start, y_end, 0)
  RETURNING id INTO pub;
  INSERT INTO "PublishedLunchSittings" ("schoolId", "publicationId", "academicYearId", "studentGroupId", "dayOfWeek", "startTime", "endTime")
  VALUES (school, pub, y, grp, 1, '11:30', '12:00')
  RETURNING id INTO meal;
  BEGIN
    INSERT INTO "PublishedLunchSittings" ("schoolId", "publicationId", "academicYearId", "studentGroupId", "dayOfWeek", "startTime", "endTime")
    VALUES (school, pub, gen_random_uuid(), grp, 2, '11:30', '12:00');
    RAISE EXCEPTION 'meals: a snapshot meal of another year was stored';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "PublishedLunchSittings" ("schoolId", "publicationId", "academicYearId", "studentGroupId", "dayOfWeek", "startTime", "endTime")
    VALUES (school, pub, y, grp, 8, '11:30', '12:00');
    RAISE EXCEPTION 'meals: a weekday 8 was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE "PublishedLunchSittings" SET "startTime" = '12:30' WHERE id = meal;
    RAISE EXCEPTION 'meals: a published meal was moved';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM "PublishedLunchSittings" WHERE id = meal;
    RAISE EXCEPTION 'meals: a published meal was deleted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM set_config('app.test_rls27i_teacher_sub', (SELECT "authId"::text FROM "Users"
    WHERE "schoolId" = school AND role = 'TEACHER' AND "isActive" ORDER BY "authId" LIMIT 1), true);
  PERFORM set_config('app.test_rls27i_student_sub', (SELECT "authId"::text FROM "Users"
    WHERE "schoolId" = school AND role = 'STUDENT' AND "isActive" ORDER BY "authId" LIMIT 1), true);
END
$$;
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls27i_teacher_sub'))::text, true);
DO $$
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'TEACHER' THEN RAISE EXCEPTION 'meals: expected a TEACHER'; END IF;
  IF (SELECT count(*) FROM "PublishedLunchSittings") <> 0 THEN RAISE EXCEPTION 'meals: a teacher reads the snapshot meals'; END IF;
END $$;
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls27i_student_sub'))::text, true);
DO $$
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'STUDENT' THEN RAISE EXCEPTION 'meals: expected a STUDENT'; END IF;
  IF (SELECT count(*) FROM "PublishedLunchSittings") <> 0 THEN RAISE EXCEPTION 'meals: a pupil reads the snapshot meals'; END IF;
END $$;
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000004')::text, true);
DO $$
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'GUARDIAN' THEN RAISE EXCEPTION 'meals: expected a GUARDIAN'; END IF;
  IF (SELECT count(*) FROM "PublishedLunchSittings") <> 0 THEN RAISE EXCEPTION 'meals: a guardian reads the snapshot meals'; END IF;
END $$;
ROLLBACK;

DO $$
DECLARE bad text; api_role text;
BEGIN
  SELECT string_agg(polname || ':' || polcmd::text, ',' ORDER BY polname) INTO bad FROM pg_policy
   WHERE polrelid = 'public."PublishedLunchSittings"'::regclass;
  IF bad IS DISTINCT FROM 'published_lunch_sittings_admin_insert:a,published_lunch_sittings_admin_select:r' THEN
    RAISE EXCEPTION 'meals: policies are %', bad;
  END IF;
  SELECT string_agg(polname, ',') INTO bad FROM pg_policy
   WHERE polrelid = 'public."PublishedLunchSittings"'::regclass
     AND (coalesce(pg_get_expr(polqual, polrelid), '') NOT LIKE '%current_user_role%' AND polcmd <> 'a'
          OR (polcmd = 'a' AND coalesce(pg_get_expr(polwithcheck, polrelid), '') NOT LIKE '%current_user_role%'));
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'meals: arms without the role: %', bad; END IF;
  FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role', 'app_authenticated') LOOP
    SELECT string_agg(p, ', ') INTO bad
      FROM unnest(ARRAY['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
     WHERE has_table_privilege(api_role, 'public."PublishedLunchSittings"', p);
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'meals: % holds % on the snapshot meals', api_role, bad; END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Section 28: vikarieplanering.
--
-- TeacherAbsenceReasons, TeacherAbsences, CoverSettings (20261012090000),
-- TeacherAbsenceCovers (20261012100000), SubstitutePoolMembers and
-- SubstituteAvailabilities (20261012110000). An absence's reason is health
-- data: the admin and the absent teacher read it, nobody else does —
-- not a colleague by any join, not a pupil, not a guardian, not another
-- school. A self-reporting teacher writes their own absence only while the
-- school allows it, from today, and may then only end it early or withdraw
-- it (the guard, TA403). The person of an absence is fixed (TA409); a
-- decision names the absence's own person (composite key); a pool member is
-- a TEACHER (SP409). The CHECKs mirror the DTOs, the EXCLUDE refuses two
-- ACTIVE absences at once, and the catalogue guard of each migration is
-- re-asserted here, in USING and WITH CHECK. What the public viewer shows of
-- a lesson handled as självstudier is the adapter probe's to assert (pub-e),
-- as every viewer answer is.
-- ---------------------------------------------------------------------------

BEGIN;
-- 28a: the second school's rows, written by its own admin.
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000006')::text, true);
DO $$
DECLARE
  school uuid := app.current_school_id();
  t uuid; a uuid; l uuid;
BEGIN
  SELECT id INTO t FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000001';
  SELECT id INTO l FROM "CalendarLessons" WHERE "schoolId" = school ORDER BY id LIMIT 1;
  IF t IS NULL OR l IS NULL THEN RAISE EXCEPTION 'cover: the second school has no teacher or lesson to plant on'; END IF;
  INSERT INTO "TeacherAbsenceReasons" ("schoolId", label) VALUES (school, 'rls28 b-orsak');
  INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt") VALUES (school, t, now() + interval '1 day', now() + interval '2 days')
  RETURNING id INTO a;
  INSERT INTO "TeacherAbsenceCovers" ("schoolId", "absenceId", "calendarLessonId", "absentTeacherId", decision, "removedTeachers")
  VALUES (school, a, l, t, 'CO_TEACHER', jsonb_build_array(jsonb_build_object('teacherId', t, 'role', 'LEAD')));
  INSERT INTO "CoverSettings" ("schoolId") VALUES (school) ON CONFLICT ("schoolId") DO NOTHING;
  INSERT INTO "SubstitutePoolMembers" ("schoolId", "userId") VALUES (school, t);
  INSERT INTO "SubstituteAvailabilities" ("schoolId", "userId", "dayOfWeek", "startTime", "endTime") VALUES (school, t, 1, '08:00', '12:00');
END $$;

-- 28b: the primary school's admin plants an absence with its reason, a
-- decision, a pool member and the settings — and meets every refusal the
-- database owes the admin too.
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
SELECT set_config('app.test_rls28_school_b', :'school_b', true);
DO $$
DECLARE
  school uuid := app.current_school_id();
  me uuid := app.current_user_id();
  t1 uuid; t2 uuid; sick uuid; a uuid; l uuid; pupil uuid; n bigint;
BEGIN
  SELECT id INTO t1 FROM "Users" WHERE "schoolId" = school AND role = 'TEACHER' AND "isActive" ORDER BY "authId" LIMIT 1;
  SELECT id INTO t2 FROM "Users" WHERE "schoolId" = school AND role = 'TEACHER' AND "isActive" AND id <> t1 ORDER BY "authId" LIMIT 1;
  SELECT id INTO pupil FROM "Users" WHERE "schoolId" = school AND role = 'STUDENT' AND "isActive" ORDER BY "authId" LIMIT 1;
  IF t2 IS NULL OR pupil IS NULL THEN RAISE EXCEPTION 'cover: the primary school lacks two teachers or a pupil'; END IF;
  -- Two lessons of its own, far ahead: l carries the decision, l2 the refusals.
  INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", "updatedAt")
  SELECT school, (SELECT id FROM "Subjects" WHERE "schoolId" = school ORDER BY id LIMIT 1),
         (SELECT id FROM "StudentGroups" WHERE "schoolId" = school ORDER BY id LIMIT 1),
         DATE '2095-03-01' + k, timestamptz '2095-03-01 08:00 UTC' + k * interval '1 day', timestamptz '2095-03-01 09:00 UTC' + k * interval '1 day', now()
    FROM generate_series(0, 1) AS k;
  SELECT id INTO l FROM "CalendarLessons" WHERE "schoolId" = school AND date = DATE '2095-03-01';

  -- The isolation half: nothing of the second school is visible.
  SELECT (SELECT count(*) FROM "TeacherAbsenceReasons" WHERE "schoolId" <> school)
       + (SELECT count(*) FROM "TeacherAbsences" WHERE "schoolId" <> school)
       + (SELECT count(*) FROM "TeacherAbsenceCovers" WHERE "schoolId" <> school)
       + (SELECT count(*) FROM "CoverSettings" WHERE "schoolId" <> school)
       + (SELECT count(*) FROM "SubstitutePoolMembers" WHERE "schoolId" <> school)
       + (SELECT count(*) FROM "SubstituteAvailabilities" WHERE "schoolId" <> school) INTO n;
  IF n <> 0 THEN RAISE EXCEPTION 'cover: an admin reads % row(s) of another school', n; END IF;

  -- The school's categories, as the service ensures them: twice is once.
  FOR n IN 1..2 LOOP
    INSERT INTO "TeacherAbsenceReasons" ("schoolId", "builtin", "sortOrder")
    SELECT school, b::"AbsenceReasonBuiltin", (o * 10)::int
      FROM unnest(ARRAY['SICK', 'CHILD_CARE', 'WORK_TRAVEL', 'PROFESSIONAL_DEVELOPMENT', 'OTHER']) WITH ORDINALITY AS u(b, o)
    ON CONFLICT ("schoolId", "builtin") WHERE "builtin" IS NOT NULL DO NOTHING;
  END LOOP;
  SELECT count(*) INTO n FROM "TeacherAbsenceReasons" WHERE "schoolId" = school AND "builtin" IS NOT NULL;
  IF n <> 5 THEN RAISE EXCEPTION 'cover: the built-ins are % rows, not five', n; END IF;
  SELECT id INTO sick FROM "TeacherAbsenceReasons" WHERE "schoolId" = school AND "builtin" = 'SICK';

  -- CHECKs on the list.
  BEGIN
    INSERT INTO "TeacherAbsenceReasons" ("schoolId", label) VALUES (school, repeat('x', 61));
    RAISE EXCEPTION 'cover: a 61-character label was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "TeacherAbsenceReasons" ("schoolId", "builtin", label) VALUES (school, 'OTHER', 'both');
    RAISE EXCEPTION 'cover: a reason with both a built-in and a label was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- T1 away since yesterday until the day after tomorrow, sick; a decision on a lesson.
  INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt", "reasonId", "createdByUserId")
  VALUES (school, t1, now() - interval '1 day', now() + interval '2 days', sick, me) RETURNING id INTO a;
  INSERT INTO "TeacherAbsenceCovers" ("schoolId", "absenceId", "calendarLessonId", "absentTeacherId", decision, "removedTeachers", "decidedByUserId")
  VALUES (school, a, l, t1, 'CO_TEACHER', jsonb_build_array(jsonb_build_object('teacherId', t1, 'role', 'LEAD')), me);

  -- A decision always names the absence's own person.
  BEGIN
    INSERT INTO "TeacherAbsenceCovers" ("schoolId", "absenceId", "calendarLessonId", "absentTeacherId", decision, "removedTeachers")
    SELECT school, a, id, t2, 'CO_TEACHER', jsonb_build_array(jsonb_build_object('teacherId', t2, 'role', 'LEAD'))
      FROM "CalendarLessons" WHERE "schoolId" = school AND date = DATE '2095-03-02';
    RAISE EXCEPTION 'cover: a decision named somebody other than the absence''s person';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  -- removedTeachers: a list, and somebody removed unless it is a cancellation.
  BEGIN
    INSERT INTO "TeacherAbsenceCovers" ("schoolId", "absenceId", "calendarLessonId", "absentTeacherId", decision, "removedTeachers")
    SELECT school, a, id, t1, 'SUBSTITUTE', '[]'::jsonb FROM "CalendarLessons" WHERE "schoolId" = school AND date = DATE '2095-03-02';
    RAISE EXCEPTION 'cover: a SUBSTITUTE decision removing nobody was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- The person of an absence is fixed, for the admin too.
  BEGIN
    UPDATE "TeacherAbsences" SET "userId" = t2 WHERE id = a;
    RAISE EXCEPTION 'cover: an absence changed person';
  EXCEPTION WHEN SQLSTATE 'TA409' THEN NULL;
  END;

  -- Two ACTIVE absences of one person never overlap; a WITHDRAWN one may.
  BEGIN
    INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt") VALUES (school, t1, now(), now() + interval '1 hour');
    RAISE EXCEPTION 'cover: two active absences of one person overlap';
  EXCEPTION WHEN exclusion_violation THEN NULL;
  END;
  INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt", status, "withdrawnAt")
  VALUES (school, t1, now(), now() + interval '1 hour', 'WITHDRAWN', now());

  -- Half a year: 186 days and the DST hour pass, a day more does not.
  INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt")
  VALUES (school, t2, timestamptz '2090-08-17 00:00 Europe/Stockholm', timestamptz '2091-02-19 00:00 Europe/Stockholm');
  IF (SELECT "endsAt" - "startsAt" FROM "TeacherAbsences" WHERE "userId" = t2 AND "startsAt" = timestamptz '2090-08-17 00:00 Europe/Stockholm')
     <> interval '186 days 01:00' THEN
    RAISE EXCEPTION 'cover: the DST-spanning half year is not 186 days and an hour';
  END IF;
  BEGIN
    INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt")
    VALUES (school, t2, timestamptz '2092-08-17 00:00 Europe/Stockholm', timestamptz '2093-02-20 00:00 Europe/Stockholm');
    RAISE EXCEPTION 'cover: 187 days were stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- The pool: a TEACHER only.
  INSERT INTO "SubstitutePoolMembers" ("schoolId", "userId", "createdByUserId") VALUES (school, t2, me);
  BEGIN
    INSERT INTO "SubstitutePoolMembers" ("schoolId", "userId") VALUES (school, pupil);
    RAISE EXCEPTION 'cover: a pupil joined the pool';
  EXCEPTION WHEN SQLSTATE 'SP409' THEN NULL;
  END;
  BEGIN
    INSERT INTO "SubstitutePoolMembers" ("schoolId", "userId") VALUES (school, me);
    RAISE EXCEPTION 'cover: an admin joined the pool';
  EXCEPTION WHEN SQLSTATE 'SP409' THEN NULL;
  END;
  BEGIN
    INSERT INTO "SubstituteAvailabilities" ("schoolId", "userId", date, "dayOfWeek", "startTime", "endTime")
    VALUES (school, t2, current_date, 1, '08:00', '12:00');
    RAISE EXCEPTION 'cover: a window with both a date and a weekday was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  INSERT INTO "CoverSettings" ("schoolId", "teacherSelfReport") VALUES (school, false)
  ON CONFLICT ("schoolId") DO UPDATE SET "teacherSelfReport" = false;

  PERFORM set_config('app.test_rls28_t1', t1::text, true);
  PERFORM set_config('app.test_rls28_t2', t2::text, true);
  PERFORM set_config('app.test_rls28_admin', me::text, true);
  PERFORM set_config('app.test_rls28_absence', a::text, true);
  PERFORM set_config('app.test_rls28_sick', sick::text, true);
  PERFORM set_config('app.test_rls28_t1_sub', (SELECT "authId"::text FROM "Users" WHERE id = t1), true);
  PERFORM set_config('app.test_rls28_t2_sub', (SELECT "authId"::text FROM "Users" WHERE id = t2), true);
  PERFORM set_config('app.test_rls28_pupil_sub', (SELECT "authId"::text FROM "Users" WHERE id = pupil), true);
END $$;

-- 28c: a colleague. The categories and the switches, yes; any absence, any
-- reason, any decision, by any route, no.
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls28_t2_sub'))::text, true);
DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'TEACHER' THEN RAISE EXCEPTION 'cover: expected a TEACHER'; END IF;
  -- Their own absence (28b's half year) is theirs; T1's is not.
  SELECT count(*) INTO n FROM "TeacherAbsences" WHERE "userId" <> app.current_user_id();
  IF n <> 0 THEN RAISE EXCEPTION 'cover: a colleague reads % absence(s) of somebody else', n; END IF;
  SELECT count(*) INTO n FROM "TeacherAbsenceCovers";
  IF n <> 0 THEN RAISE EXCEPTION 'cover: a colleague reads % decision(s)', n; END IF;
  SELECT count(*) INTO n FROM "CalendarLessonTeachers" t
    JOIN "TeacherAbsences" a ON a."userId" = t."teacherId"
   WHERE a."reasonId" IS NOT NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'cover: a colleague reaches a reason through the calendar'; END IF;
  SELECT count(*) INTO n FROM "CalendarLessonTeachers" t
   WHERE EXISTS (SELECT 1 FROM "TeacherAbsences" a WHERE a."userId" = t."teacherId" AND a."userId" <> app.current_user_id());
  IF n <> 0 THEN RAISE EXCEPTION 'cover: a colleague learns who is away through a subselect'; END IF;
  SELECT count(*) INTO n FROM "TeacherAbsenceReasons";
  IF n < 5 THEN RAISE EXCEPTION 'cover: a colleague reads % of the school''s categories', n; END IF;
  SELECT count(*) INTO n FROM "CoverSettings";
  IF n <> 1 THEN RAISE EXCEPTION 'cover: a colleague reads % settings row(s)', n; END IF;
  BEGIN
    INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt", "createdByUserId")
    VALUES (app.current_school_id(), current_setting('app.test_rls28_t1')::uuid, now() + interval '5 days', now() + interval '6 days', app.current_user_id());
    RAISE EXCEPTION 'cover: a colleague registered somebody else''s absence';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  UPDATE "TeacherAbsences" SET "endsAt" = now() + interval '3 hours' WHERE id = current_setting('app.test_rls28_absence')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'cover: a colleague updated % absence(s) of somebody else', n; END IF;
  BEGIN
    INSERT INTO "TeacherAbsenceReasons" ("schoolId", label) VALUES (app.current_school_id(), 'rls28 lärarens');
    RAISE EXCEPTION 'cover: a teacher wrote the school''s categories';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- A pool member writes their own window, nobody else's.
  INSERT INTO "SubstituteAvailabilities" ("schoolId", "userId", "dayOfWeek", "startTime", "endTime")
  VALUES (app.current_school_id(), app.current_user_id(), 2, '08:00', '16:00');
  BEGIN
    INSERT INTO "SubstituteAvailabilities" ("schoolId", "userId", "dayOfWeek", "startTime", "endTime")
    VALUES (app.current_school_id(), current_setting('app.test_rls28_t1')::uuid, 2, '08:00', '16:00');
    RAISE EXCEPTION 'cover: a member wrote somebody else''s window';
  EXCEPTION WHEN insufficient_privilege OR foreign_key_violation THEN NULL;
  END;
  SELECT count(*) INTO n FROM "SubstitutePoolMembers";
  IF n <> 1 THEN RAISE EXCEPTION 'cover: a member reads % membership row(s), not their own one', n; END IF;
END $$;

-- 28d: the absent teacher reads their own absence, its reason and their
-- decisions; with self-report off they cannot write; a non-member writes no
-- window.
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls28_t1_sub'))::text, true);
DO $$
DECLARE n bigint; reason uuid;
BEGIN
  SELECT "reasonId" INTO reason FROM "TeacherAbsences" WHERE id = current_setting('app.test_rls28_absence')::uuid;
  IF reason IS DISTINCT FROM current_setting('app.test_rls28_sick')::uuid THEN RAISE EXCEPTION 'cover: the absent teacher does not read their reason'; END IF;
  SELECT count(*) INTO n FROM "TeacherAbsenceCovers";
  IF n <> 1 THEN RAISE EXCEPTION 'cover: the absent teacher reads % decision(s), not their one', n; END IF;
  BEGIN
    INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt", "createdByUserId")
    VALUES (app.current_school_id(), app.current_user_id(), now() + interval '5 days', now() + interval '6 days', app.current_user_id());
    RAISE EXCEPTION 'cover: a teacher registered their own absence with self-report off';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO "SubstituteAvailabilities" ("schoolId", "userId", "dayOfWeek", "startTime", "endTime")
    VALUES (app.current_school_id(), app.current_user_id(), 2, '08:00', '16:00');
    RAISE EXCEPTION 'cover: a teacher outside the pool wrote a window';
  EXCEPTION WHEN insufficient_privilege OR foreign_key_violation THEN NULL;
  END;
END $$;

-- The school allows self-report.
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
UPDATE "CoverSettings" SET "teacherSelfReport" = true WHERE "schoolId" = app.current_school_id();

-- 28e: self-report, and what the guard lets a teacher do with it.
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls28_t1_sub'))::text, true);
DO $$
DECLARE
  school uuid := app.current_school_id();
  me uuid := app.current_user_id();
  started uuid := current_setting('app.test_rls28_absence')::uuid;
  tz text := (SELECT timezone FROM "Schools" WHERE id = app.current_school_id());
  today timestamptz := (app.school_today()::timestamp AT TIME ZONE tz);
  own uuid; n bigint;
BEGIN
  -- Not the person, not the creator, not yesterday.
  BEGIN
    INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt", "createdByUserId")
    VALUES (school, current_setting('app.test_rls28_t2')::uuid, today + interval '10 days', today + interval '11 days', me);
    RAISE EXCEPTION 'cover: a teacher registered a colleague''s absence';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt", "createdByUserId")
    VALUES (school, me, today + interval '10 days', today + interval '11 days', current_setting('app.test_rls28_admin')::uuid);
    RAISE EXCEPTION 'cover: a teacher spoofed the creator';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt", "createdByUserId")
    VALUES (school, me, today - interval '1 day', today + interval '20 days', me);
    RAISE EXCEPTION 'cover: a teacher backdated an absence';
  EXCEPTION WHEN SQLSTATE 'TA403' THEN NULL;
  END;
  -- Ending early past a decision: the decision sits on a lesson in 2095,
  -- ahead and outside the shortened period, which only the admin may undo
  -- (20261012130000; the API's ABSENCE_HAS_DECISIONS). Ending early where
  -- nothing is left behind is 28h's.
  BEGIN
    UPDATE "TeacherAbsences" SET "endsAt" = now() + interval '1 hour' WHERE id = started;
    RAISE EXCEPTION 'cover: a teacher ended their absence early past a decision still ahead';
  EXCEPTION WHEN SQLSTATE 'TA403' THEN NULL;
  END;
  INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt", "createdByUserId", "reasonId")
  VALUES (school, me, today + interval '3 days', today + interval '4 days', me, current_setting('app.test_rls28_sick')::uuid)
  RETURNING id INTO own;

  -- The guard on the started one: no later end, no end before now, no new
  -- reason, no withdrawal (a decision sits on it).
  BEGIN
    UPDATE "TeacherAbsences" SET "endsAt" = now() + interval '5 days' WHERE id = started;
    RAISE EXCEPTION 'cover: a teacher extended their absence';
  EXCEPTION WHEN SQLSTATE 'TA403' THEN NULL;
  END;
  BEGIN
    UPDATE "TeacherAbsences" SET "endsAt" = now() - interval '1 minute' WHERE id = started;
    RAISE EXCEPTION 'cover: a teacher ended their absence in the past';
  EXCEPTION WHEN SQLSTATE 'TA403' THEN NULL;
  END;
  BEGIN
    UPDATE "TeacherAbsences" SET "reasonId" = NULL WHERE id = started;
    RAISE EXCEPTION 'cover: a teacher changed their reason';
  EXCEPTION WHEN SQLSTATE 'TA403' THEN NULL;
  END;
  BEGIN
    UPDATE "TeacherAbsences" SET status = 'WITHDRAWN', "withdrawnAt" = now(), "withdrawnByUserId" = me WHERE id = started;
    RAISE EXCEPTION 'cover: a teacher withdrew a started absence with a decision on it';
  EXCEPTION WHEN SQLSTATE 'TA403' THEN NULL;
  END;
  -- …but withdraws one that has not begun, as themself only.
  BEGIN
    UPDATE "TeacherAbsences" SET status = 'WITHDRAWN', "withdrawnAt" = now(), "withdrawnByUserId" = current_setting('app.test_rls28_admin')::uuid
     WHERE id = own;
    RAISE EXCEPTION 'cover: a teacher withdrew in the admin''s name';
  EXCEPTION WHEN SQLSTATE 'TA403' THEN NULL;
  END;
  UPDATE "TeacherAbsences" SET status = 'WITHDRAWN', "withdrawnAt" = now(), "withdrawnByUserId" = me, "updatedAt" = now() WHERE id = own;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'cover: a teacher could not withdraw an absence that has not begun'; END IF;
  -- A teacher deletes nothing.
  DELETE FROM "TeacherAbsences" WHERE id = own;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'cover: a teacher deleted an absence'; END IF;
END $$;

-- "Sjuk i dag": a whole day from today's school-local midnight, reported
-- now, is accepted; and the teacher who pressed the wrong day takes it back
-- within the hour, nothing having been decided on it.
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls28_t2_sub'))::text, true);
DO $$
DECLARE
  tz text := (SELECT timezone FROM "Schools" WHERE id = app.current_school_id());
  today timestamptz := (app.school_today()::timestamp AT TIME ZONE tz);
  own uuid; n bigint;
BEGIN
  INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt", "createdByUserId")
  VALUES (app.current_school_id(), app.current_user_id(), today, today + interval '1 day', app.current_user_id())
  RETURNING id INTO own;
  UPDATE "TeacherAbsences" SET status = 'WITHDRAWN', "withdrawnAt" = now(), "withdrawnByUserId" = app.current_user_id() WHERE id = own;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'cover: a teacher could not take back today''s absence within the hour'; END IF;
END $$;

-- 28h: what a teacher writes straight against the database never goes past
-- the school's decisions, and the clock is the database's (20261012130000).
-- T1 registers an absence in 2095 around the lessons 28b planted (l on 1
-- March), with a forged createdAt; the admin decides on l; T1 then cannot
-- withdraw it (before it starts, within the hour — a decision references
-- it), cannot end it before l, but can end it after l; and a withdrawal of
-- an absence without decisions stores the database's withdrawnAt and
-- updatedAt, not the forged ones.
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls28_t1_sub'))::text, true);
DO $$
DECLARE own uuid; forged timestamptz;
BEGIN
  INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt", "createdByUserId", "createdAt", "updatedAt")
  VALUES (app.current_school_id(), app.current_user_id(), timestamptz '2095-02-28 00:00 UTC', timestamptz '2095-03-05 00:00 UTC',
          app.current_user_id(), now() + interval '10 years', now() - interval '1 year')
  RETURNING id, "createdAt" INTO own, forged;
  IF forged IS DISTINCT FROM now() THEN RAISE EXCEPTION 'cover: a teacher stored createdAt %', forged; END IF;
  IF (SELECT "updatedAt" FROM "TeacherAbsences" WHERE id = own) IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'cover: a teacher stored their own updatedAt';
  END IF;
  PERFORM set_config('app.test_rls28_own_2095', own::text, true);
END $$;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
INSERT INTO "TeacherAbsenceCovers" ("schoolId", "absenceId", "calendarLessonId", "absentTeacherId", decision, "removedTeachers")
SELECT app.current_school_id(), current_setting('app.test_rls28_own_2095')::uuid, l.id, current_setting('app.test_rls28_t1')::uuid,
       'CO_TEACHER', jsonb_build_array(jsonb_build_object('teacherId', current_setting('app.test_rls28_t1'), 'role', 'LEAD'))
  FROM "CalendarLessons" l WHERE l."schoolId" = app.current_school_id() AND l.date = DATE '2095-03-01';
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls28_t1_sub'))::text, true);
DO $$
DECLARE
  own uuid := current_setting('app.test_rls28_own_2095')::uuid;
  other uuid; n bigint; stamped timestamptz; touched timestamptz;
BEGIN
  BEGIN
    UPDATE "TeacherAbsences" SET status = 'WITHDRAWN', "withdrawnAt" = now(), "withdrawnByUserId" = app.current_user_id() WHERE id = own;
    RAISE EXCEPTION 'cover: a teacher withdrew an absence a decision references';
  EXCEPTION WHEN SQLSTATE 'TA403' THEN NULL;
  END;
  BEGIN
    UPDATE "TeacherAbsences" SET "endsAt" = timestamptz '2095-03-01 00:00 UTC' WHERE id = own;
    RAISE EXCEPTION 'cover: a teacher ended an absence before a decided lesson still ahead';
  EXCEPTION WHEN SQLSTATE 'TA403' THEN NULL;
  END;
  UPDATE "TeacherAbsences" SET "endsAt" = timestamptz '2095-03-02 00:00 UTC' WHERE id = own;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'cover: a teacher could not end early with the decided lesson still inside'; END IF;

  INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt", "createdByUserId")
  VALUES (app.current_school_id(), app.current_user_id(), timestamptz '2095-04-01 00:00 UTC', timestamptz '2095-04-02 00:00 UTC', app.current_user_id())
  RETURNING id INTO other;
  UPDATE "TeacherAbsences"
     SET status = 'WITHDRAWN', "withdrawnAt" = now() - interval '1 day', "withdrawnByUserId" = app.current_user_id(),
         "updatedAt" = now() - interval '1 year'
   WHERE id = other
  RETURNING "withdrawnAt", "updatedAt" INTO stamped, touched;
  IF stamped IS DISTINCT FROM now() OR touched IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'cover: a teacher backdated a withdrawal to % (updatedAt %)', stamped, touched;
  END IF;
END $$;

-- 28f: a pupil and a guardian see nothing of any of the six tables, and write nothing.
SELECT set_config('app.test_rls28_who', 'pupil', true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls28_pupil_sub'))::text, true);
DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'STUDENT' THEN RAISE EXCEPTION 'cover: expected a STUDENT'; END IF;
  SELECT (SELECT count(*) FROM "TeacherAbsenceReasons") + (SELECT count(*) FROM "TeacherAbsences")
       + (SELECT count(*) FROM "TeacherAbsenceCovers") + (SELECT count(*) FROM "CoverSettings")
       + (SELECT count(*) FROM "SubstitutePoolMembers") + (SELECT count(*) FROM "SubstituteAvailabilities") INTO n;
  IF n <> 0 THEN RAISE EXCEPTION 'cover: a pupil reads % row(s)', n; END IF;
  BEGIN
    INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt", "createdByUserId")
    VALUES (app.current_school_id(), app.current_user_id(), now() + interval '1 day', now() + interval '2 days', app.current_user_id());
    RAISE EXCEPTION 'cover: a pupil wrote an absence';
  EXCEPTION WHEN insufficient_privilege OR foreign_key_violation THEN NULL;
  END;
END $$;
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000004')::text, true);
DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'GUARDIAN' THEN RAISE EXCEPTION 'cover: expected a GUARDIAN'; END IF;
  SELECT (SELECT count(*) FROM "TeacherAbsenceReasons") + (SELECT count(*) FROM "TeacherAbsences")
       + (SELECT count(*) FROM "TeacherAbsenceCovers") + (SELECT count(*) FROM "CoverSettings")
       + (SELECT count(*) FROM "SubstitutePoolMembers") + (SELECT count(*) FROM "SubstituteAvailabilities") INTO n;
  IF n <> 0 THEN RAISE EXCEPTION 'cover: a guardian reads % row(s)', n; END IF;
  BEGIN
    INSERT INTO "CoverSettings" ("schoolId", "teacherSelfReport") VALUES (app.current_school_id(), true)
    ON CONFLICT ("schoolId") DO UPDATE SET "teacherSelfReport" = true;
    RAISE EXCEPTION 'cover: a guardian wrote the settings';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
ROLLBACK;

-- 28g: the catalogue of every migration's guard, re-asserted — USING and
-- WITH CHECK alike, a permissive arm for authenticated, and no arm but the
-- admin's, a TEACHER's own (current_user_id) or the two catalogue arms.
-- Then the grants and the helpers' EXECUTE.
DO $$
DECLARE bad text; api_role text; fn text;
BEGIN
  SELECT string_agg(tablename || '.' || policyname, ', ' ORDER BY tablename, policyname) INTO bad
    FROM (
      SELECT p.tablename, p.policyname,
             (p.roles = '{authenticated}'::name[] AND p.permissive = 'PERMISSIVE') AS shaped,
             ARRAY_REMOVE(ARRAY[
               CASE WHEN p.cmd <> 'INSERT' THEN coalesce(p.qual, '') END,
               CASE WHEN p.cmd IN ('INSERT', 'UPDATE', 'ALL') THEN coalesce(p.with_check, p.qual, '') END
             ], NULL) AS arms
        FROM pg_policies p
       WHERE p.schemaname = 'public'
         AND p.tablename IN ('TeacherAbsenceReasons', 'TeacherAbsences', 'CoverSettings', 'TeacherAbsenceCovers',
                             'SubstitutePoolMembers', 'SubstituteAvailabilities')
    ) x
   WHERE NOT x.shaped
      OR EXISTS (SELECT 1 FROM unnest(x.arms) e WHERE NOT app.cover_policy_arm_is_narrow(x.tablename, x.policyname, e));
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'cover: arms reach an absence or the pool for somebody else: %', bad; END IF;

  -- The rule refuses what the review showed the old LIKE let through: an arm
  -- for every teacher that merely mentions current_user_id(), an own arm
  -- widened with OR, a negated admin arm, the catalogue arm's shape on a
  -- table that is not a catalogue, and an own arm anchored to the wrong
  -- column; and it passes the real arms' shapes.
  SELECT string_agg(name, ', ' ORDER BY name) INTO bad
    FROM (VALUES
      ('peek', 'TeacherAbsences', 'teacher_absences_colleague_peek',
       '(("schoolId" = ( SELECT app.current_school_id() AS current_school_id)) AND (( SELECT app.current_user_role() AS current_user_role) = ''TEACHER''::"UserRole") AND (( SELECT app.current_user_id() AS current_user_id) IS NOT NULL))', false),
      ('widened', 'TeacherAbsences', 'teacher_absences_own_select',
       '(("schoolId" = ( SELECT app.current_school_id() AS current_school_id)) AND (( SELECT app.current_user_role() AS current_user_role) = ''TEACHER''::"UserRole") AND (("userId" = ( SELECT app.current_user_id() AS current_user_id)) OR true))', false),
      ('negated', 'TeacherAbsenceCovers', 'teacher_absence_covers_admin_all',
       '(("schoolId" = ( SELECT app.current_school_id() AS current_school_id)) AND (NOT (( SELECT app.current_user_role() AS current_user_role) = ''SCHOOL_ADMIN''::"UserRole")))', false),
      ('catalogue elsewhere', 'TeacherAbsences', 'teacher_absence_reasons_staff_select',
       '(("schoolId" = ( SELECT app.current_school_id() AS current_school_id)) AND (( SELECT app.current_user_role() AS current_user_role) = ''TEACHER''::"UserRole"))', false),
      ('wrong column', 'TeacherAbsenceCovers', 'teacher_absence_covers_own_select',
       '(("schoolId" = ( SELECT app.current_school_id() AS current_school_id)) AND (( SELECT app.current_user_role() AS current_user_role) = ''TEACHER''::"UserRole") AND ("decidedByUserId" = ( SELECT app.current_user_id() AS current_user_id)))', false),
      ('own', 'TeacherAbsenceCovers', 'teacher_absence_covers_own_select',
       '(("schoolId" = ( SELECT app.current_school_id() AS current_school_id)) AND (( SELECT app.current_user_role() AS current_user_role) = ''TEACHER''::"UserRole") AND ("absentTeacherId" = ( SELECT app.current_user_id() AS current_user_id)))', true),
      ('catalogue', 'CoverSettings', 'cover_settings_staff_select',
       '(("schoolId" = ( SELECT app.current_school_id() AS current_school_id)) AND (( SELECT app.current_user_role() AS current_user_role) = ''TEACHER''::"UserRole"))', true)
    ) AS t(name, tbl, pol, arm, narrow)
   WHERE app.cover_policy_arm_is_narrow(tbl, pol, arm) IS DISTINCT FROM narrow;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'cover: the leak rule judged wrongly: %', bad; END IF;

  SELECT string_agg(tablename || '.' || policyname || ':' || cmd, ',' ORDER BY tablename, policyname) INTO bad
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('TeacherAbsenceReasons', 'TeacherAbsences', 'CoverSettings', 'TeacherAbsenceCovers',
                       'SubstitutePoolMembers', 'SubstituteAvailabilities');
  IF bad IS DISTINCT FROM
     'CoverSettings.cover_settings_admin_all:ALL,CoverSettings.cover_settings_staff_select:SELECT,'
     'SubstituteAvailabilities.substitute_availabilities_admin_all:ALL,SubstituteAvailabilities.substitute_availabilities_own_all:ALL,'
     'SubstitutePoolMembers.substitute_pool_members_admin_all:ALL,SubstitutePoolMembers.substitute_pool_members_own_select:SELECT,'
     'TeacherAbsenceCovers.teacher_absence_covers_admin_all:ALL,TeacherAbsenceCovers.teacher_absence_covers_own_select:SELECT,'
     'TeacherAbsenceReasons.teacher_absence_reasons_admin_all:ALL,TeacherAbsenceReasons.teacher_absence_reasons_staff_select:SELECT,'
     'TeacherAbsences.teacher_absences_admin_all:ALL,TeacherAbsences.teacher_absences_own_insert:INSERT,'
     'TeacherAbsences.teacher_absences_own_select:SELECT,TeacherAbsences.teacher_absences_own_update:UPDATE' THEN
    RAISE EXCEPTION 'cover: the policies are %', bad;
  END IF;

  FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role', 'app_authenticated') LOOP
    SELECT string_agg(t || ':' || p, ', ') INTO bad
      FROM unnest(ARRAY['TeacherAbsenceReasons', 'TeacherAbsences', 'CoverSettings', 'TeacherAbsenceCovers',
                        'SubstitutePoolMembers', 'SubstituteAvailabilities']) t,
           unnest(CASE api_role
                    WHEN 'anon' THEN ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
                    WHEN 'service_role' THEN ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
                    ELSE ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER'] END) p
     WHERE has_table_privilege(api_role, format('public.%I', t), p);
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'cover: % holds %', api_role, bad; END IF;
  END LOOP;
  FOREACH fn IN ARRAY ARRAY['app.cover_self_report_allowed()', 'app.school_today()'] LOOP
    IF has_function_privilege('anon', fn, 'EXECUTE') THEN RAISE EXCEPTION 'cover: anon may call %', fn; END IF;
    IF NOT has_function_privilege('app_authenticated', fn, 'EXECUTE') THEN RAISE EXCEPTION 'cover: the API may not call %', fn; END IF;
  END LOOP;
  IF has_function_privilege('anon', 'app.cover_policy_arm_is_narrow(text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'cover: anon may call the leak rule';
  END IF;
  FOREACH fn IN ARRAY ARRAY['app.teacher_absences_own_writes_are_narrow()', 'app.substitute_pool_member_is_a_teacher()'] LOOP
    IF has_function_privilege('app_authenticated', fn, 'EXECUTE') THEN RAISE EXCEPTION 'cover: the API may call the trigger %', fn; END IF;
  END LOOP;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'app.cover_self_report_allowed()'::regprocedure) THEN
    RAISE EXCEPTION 'cover: the self-report helper is not SECURITY DEFINER';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Section 29: elev- och vårdnadshavarytan.
--
-- 29a–c: a guardian reads the lessons their children are taught in, and
-- nothing else (20261013090000). The fixture guardian's child C sits in
-- home class H; planted here, as the admin, in one rolled-back transaction:
-- C in a teaching group TG; lessons of another class O carrying TG, H, a
-- sibling-only teaching group TG2 (another family's pupil S2 in H) or naming
-- C; a lesson of TG itself; and a second, deactivated child X in a third
-- class Z with a lunch there. Every assertion begins with a role guard, so
-- none passes for want of a principal, and each "zero" has a teacher in the
-- same transaction reading the same row.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
DECLARE
  school uuid := app.current_school_id();
  g uuid; c uuid; h uuid; o uuid; z uuid; s2 uuid; x uuid; tg uuid; tg2 uuid; yr uuid; subj uuid;
  t1 uuid; t2 uuid; t3 uuid;
  l uuid[] := '{}';
  k int;
  lid uuid;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'SCHOOL_ADMIN' THEN RAISE EXCEPTION 'family: expected the admin'; END IF;
  SELECT id INTO g FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000004';
  SELECT gs."studentId" INTO c FROM "GuardianStudents" gs WHERE gs."guardianId" = g ORDER BY gs."studentId" LIMIT 1;
  SELECT "studentGroupId" INTO h FROM "Users" WHERE id = c;
  SELECT "academicYearId" INTO yr FROM "StudentGroups" WHERE id = h;
  SELECT id INTO o FROM "StudentGroups" WHERE "schoolId" = school AND kind = 'CLASS' AND id <> h AND "academicYearId" = yr ORDER BY name LIMIT 1;
  SELECT id INTO z FROM "StudentGroups" WHERE "schoolId" = school AND kind = 'CLASS' AND id NOT IN (h, o) AND "academicYearId" = yr
     AND EXISTS (SELECT 1 FROM "Users" u WHERE u."studentGroupId" = "StudentGroups".id AND u.role = 'STUDENT' AND u."isActive")
   ORDER BY name LIMIT 1;
  SELECT id INTO s2 FROM "Users" WHERE "studentGroupId" = h AND role = 'STUDENT' AND "isActive" AND id <> c
     AND NOT EXISTS (SELECT 1 FROM "GuardianStudents" gs WHERE gs."studentId" = "Users".id AND gs."guardianId" = g)
   ORDER BY id LIMIT 1;
  SELECT id INTO x FROM "Users" WHERE "studentGroupId" = z AND role = 'STUDENT' AND "isActive" ORDER BY id LIMIT 1;
  SELECT id INTO subj FROM "Subjects" WHERE "schoolId" = school ORDER BY id LIMIT 1;
  SELECT id INTO t1 FROM "Users" WHERE "schoolId" = school AND role = 'TEACHER' AND "isActive" ORDER BY "authId" LIMIT 1;
  SELECT id INTO t2 FROM "Users" WHERE "schoolId" = school AND role = 'TEACHER' AND "isActive" AND id <> t1 ORDER BY "authId" LIMIT 1;
  SELECT id INTO t3 FROM "Users" WHERE "schoolId" = school AND role = 'TEACHER' AND "isActive" AND id NOT IN (t1, t2) ORDER BY "authId" LIMIT 1;
  IF g IS NULL OR c IS NULL OR h IS NULL OR o IS NULL OR z IS NULL OR s2 IS NULL OR x IS NULL OR t3 IS NULL OR subj IS NULL THEN
    RAISE EXCEPTION 'family: the fixtures lack a guardian child with a class, two more classes, a classmate or three teachers';
  END IF;

  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "updatedAt")
  VALUES (school, yr, 'RLS29 språkval', 'TEACHING_GROUP', now()) RETURNING id INTO tg;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "updatedAt")
  VALUES (school, yr, 'RLS29 syskonets grupp', 'TEACHING_GROUP', now()) RETURNING id INTO tg2;
  INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES (school, tg, c), (school, tg2, s2);
  -- X: a second child of the same guardian, who has left.
  INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId") VALUES (school, g, x);
  UPDATE "Users" SET "isActive" = false, "updatedAt" = now() WHERE id = x;

  -- l[1] H, l[2] O+TG, l[3] O+H, l[4] O naming C, l[5] O alone, l[6] O+TG2, l[7] TG, l[8] Z.
  FOR k IN 1..8 LOOP
    INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", "updatedAt")
    VALUES (school, subj, CASE k WHEN 1 THEN h WHEN 7 THEN tg WHEN 8 THEN z ELSE o END,
            DATE '2095-04-02', timestamptz '2095-04-02 06:00 UTC' + k * interval '1 hour',
            timestamptz '2095-04-02 06:45 UTC' + k * interval '1 hour', now())
    RETURNING id INTO lid;
    l := l || lid;
  END LOOP;
  INSERT INTO "CalendarLessonGroups" ("schoolId", "calendarLessonId", "studentGroupId")
  VALUES (school, l[2], tg), (school, l[3], h), (school, l[6], tg2);
  INSERT INTO "CalendarLessonStudents" ("schoolId", "calendarLessonId", "studentId") VALUES (school, l[4], c), (school, l[5], s2);
  INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role)
  VALUES (school, l[1], t1, 'LEAD'), (school, l[2], t2, 'LEAD'), (school, l[2], t1, 'ASSISTANT'),
         (school, l[3], t2, 'LEAD'), (school, l[3], t1, 'SUBSTITUTE'),
         (school, l[4], t1, 'LEAD'), (school, l[5], t1, 'LEAD'), (school, l[7], t3, 'LEAD');
  UPDATE "CalendarLessons" SET status = 'CANCELLED' WHERE id = l[4];
  INSERT INTO "CalendarLunches" ("schoolId", "studentGroupId", date, "startsAt", "endsAt", "updatedAt")
  VALUES (school, h, DATE '2095-04-02', timestamptz '2095-04-02 10:00 UTC', timestamptz '2095-04-02 10:30 UTC', now()),
         (school, z, DATE '2095-04-02', timestamptz '2095-04-02 10:30 UTC', timestamptz '2095-04-02 11:00 UTC', now()),
         (school, o, DATE '2095-04-02', timestamptz '2095-04-02 11:00 UTC', timestamptz '2095-04-02 11:30 UTC', now());
  INSERT INTO "CalendarRasts" ("schoolId", "studentGroupId", name, date, "startsAt", "endsAt", "updatedAt")
  VALUES (school, h, 'RLS29 rast', DATE '2095-04-02', timestamptz '2095-04-02 09:00 UTC', timestamptz '2095-04-02 09:15 UTC', now()),
         (school, z, 'RLS29 rast', DATE '2095-04-02', timestamptz '2095-04-02 09:00 UTC', timestamptz '2095-04-02 09:15 UTC', now());

  -- How the school names teachers to families: by signature, T1's is RL29;
  -- T3 is never named.
  INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", signature, "updatedAt")
  VALUES (school, t1, yr, 100, 'RL29', now())
  ON CONFLICT ("schoolId", "userId", "academicYearId") DO UPDATE SET signature = 'RL29';
  INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", signature, "updatedAt")
  VALUES (school, t3, yr, 100, 'RL3H', now())
  ON CONFLICT ("schoolId", "userId", "academicYearId") DO UPDATE SET signature = 'RL3H';
  INSERT INTO "TeacherPublicLabels" ("userId", "schoolId", hidden) VALUES (t3, school, true)
  ON CONFLICT ("userId") DO UPDATE SET hidden = true;
  INSERT INTO "PublicationSettings" ("schoolId", "publicTeacherDisplay", "updatedAt") VALUES (school, 'SIGNATURE', now())
  ON CONFLICT ("schoolId") DO UPDATE SET "publicTeacherDisplay" = 'SIGNATURE';

  PERFORM set_config('app.test_rls29_lessons', array_to_string(l, ','), true);
  PERFORM set_config('app.test_rls29_c', c::text, true);
  PERFORM set_config('app.test_rls29_h', h::text, true);
  PERFORM set_config('app.test_rls29_z', z::text, true);
  PERFORM set_config('app.test_rls29_t1', t1::text, true);
  PERFORM set_config('app.test_rls29_c_sub', (SELECT "authId"::text FROM "Users" WHERE id = c), true);
  PERFORM set_config('app.test_rls29_t2_sub', (SELECT "authId"::text FROM "Users" WHERE id = t2), true);
END $$;

-- 29a: a teacher of the school reads every planted lesson, so each zero
-- below is a row that exists.
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls29_t2_sub'))::text, true);
DO $$
DECLARE l uuid[] := string_to_array(current_setting('app.test_rls29_lessons'), ',')::uuid[]; n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'TEACHER' THEN RAISE EXCEPTION 'family: expected a TEACHER'; END IF;
  SELECT count(*) INTO n FROM "CalendarLessons" WHERE id = ANY (l);
  IF n <> 8 THEN RAISE EXCEPTION 'family: a teacher reads % of the 8 planted lessons', n; END IF;
  SELECT count(*) INTO n FROM "CalendarLessonTeachers" WHERE "calendarLessonId" = ANY (l);
  IF n <> 8 THEN RAISE EXCEPTION 'family: a teacher reads % of the 8 planted teacher rows', n; END IF;
  SELECT count(*) INTO n FROM "CalendarLunches" WHERE date = DATE '2095-04-02';
  IF n <> 3 THEN RAISE EXCEPTION 'family: a teacher reads % of the 3 planted lunches', n; END IF;
END $$;

-- 29a: the guardian. Home class, teaching group (as the lesson's group and as
-- an extra group), the home class as an extra group, the lesson naming C —
-- yes. Another class's own lesson, the sibling's group, a lesson naming
-- another pupil, the departed child's class — no. Teacher rows — none.
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000004')::text, true);
DO $$
DECLARE
  l uuid[] := string_to_array(current_setting('app.test_rls29_lessons'), ',')::uuid[];
  seen int[];
  n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'GUARDIAN' THEN RAISE EXCEPTION 'family: expected the GUARDIAN'; END IF;
  IF NOT current_setting('app.test_rls29_c')::uuid = ANY (app.current_guardian_child_ids()) THEN
    RAISE EXCEPTION 'family: the guardian''s child is not among their children';
  END IF;
  IF cardinality(app.current_guardian_child_ids()) <> 1 THEN
    RAISE EXCEPTION 'family: the departed child still counts (% children)', cardinality(app.current_guardian_child_ids());
  END IF;
  IF current_setting('app.test_rls29_z')::uuid = ANY (app.current_guardian_group_ids()) THEN
    RAISE EXCEPTION 'family: the departed child''s class is among the groups';
  END IF;
  SELECT array_agg(i ORDER BY i) INTO seen FROM generate_subscripts(l, 1) i
   WHERE EXISTS (SELECT 1 FROM "CalendarLessons" cl WHERE cl.id = l[i]);
  IF seen IS DISTINCT FROM ARRAY[1, 2, 3, 4, 7] THEN
    RAISE EXCEPTION 'family: the guardian reads lessons % of the planted 1..8, not 1, 2, 3, 4 and 7', seen;
  END IF;
  SELECT count(*) INTO n FROM "CalendarLessonTeachers" WHERE "calendarLessonId" = ANY (l);
  IF n <> 0 THEN RAISE EXCEPTION 'family: the guardian reads % teacher row(s)', n; END IF;
  SELECT count(*) INTO n FROM "CalendarLessonTeachers";
  IF n <> 0 THEN RAISE EXCEPTION 'family: the guardian reads % teacher row(s) anywhere', n; END IF;
  SELECT count(*) INTO n FROM "CalendarLessonGroups" WHERE "calendarLessonId" = ANY (l);
  IF n <> 2 THEN RAISE EXCEPTION 'family: the guardian reads % extra-group rows, not the TG and H ones', n; END IF;
  SELECT count(*) INTO n FROM "CalendarLessonGroups" WHERE "calendarLessonId" = l[6];
  IF n <> 0 THEN RAISE EXCEPTION 'family: the guardian reads the sibling group''s row'; END IF;
  SELECT count(*) INTO n FROM "CalendarLessonStudents" WHERE "calendarLessonId" = ANY (l);
  IF n <> 1 THEN RAISE EXCEPTION 'family: the guardian reads % named-pupil rows, not their own child''s one', n; END IF;
  SELECT count(*) INTO n FROM "CalendarLessonStudents" WHERE "studentId" <> current_setting('app.test_rls29_c')::uuid;
  IF n <> 0 THEN RAISE EXCEPTION 'family: the guardian reads % row(s) naming another pupil', n; END IF;
  -- Meals: the home class's, not the departed child's class, not another class.
  SELECT count(*) INTO n FROM "CalendarLunches" WHERE date = DATE '2095-04-02';
  IF n <> 1 THEN RAISE EXCEPTION 'family: the guardian reads % lunches, not the home class''s one', n; END IF;
  SELECT count(*) INTO n FROM "CalendarLunches" WHERE "studentGroupId" = current_setting('app.test_rls29_z')::uuid;
  IF n <> 0 THEN RAISE EXCEPTION 'family: the guardian of a departed pupil still reads that class''s lunch'; END IF;
  SELECT count(*) INTO n FROM "CalendarRasts" WHERE date = DATE '2095-04-02';
  IF n <> 1 THEN RAISE EXCEPTION 'family: the guardian reads % rasts, not the home class''s one', n; END IF;
END $$;

-- 29a: the same guardian through PostgREST's role reads no lesson row at
-- all. A row carries the cancellation's free-text note and cause and goes
-- back a year; the endpoint's whitelist and week bound are the only way a
-- family reads a lesson. The meals, which carry no free text, still answer.
SET LOCAL ROLE authenticated;
DO $$
DECLARE l uuid[] := string_to_array(current_setting('app.test_rls29_lessons'), ',')::uuid[]; n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'GUARDIAN' THEN RAISE EXCEPTION 'family: expected the GUARDIAN'; END IF;
  SELECT count(*) INTO n FROM "CalendarLessons" WHERE id = ANY (l);
  IF n <> 0 THEN RAISE EXCEPTION 'family: the guardian reads % lesson row(s) through PostgREST''s role', n; END IF;
  SELECT count(*) INTO n FROM "CalendarLessons";
  IF n <> 0 THEN RAISE EXCEPTION 'family: the guardian reads % lesson row(s) anywhere through PostgREST''s role', n; END IF;
  SELECT (SELECT count(*) FROM "CalendarLessonGroups") + (SELECT count(*) FROM "CalendarLessonStudents") INTO n;
  IF n <> 0 THEN RAISE EXCEPTION 'family: the guardian reads % extra-group or named-pupil row(s) through PostgREST''s role', n; END IF;
  SELECT count(*) INTO n FROM "CalendarLunches" WHERE date = DATE '2095-04-02';
  IF n <> 1 THEN RAISE EXCEPTION 'family: through PostgREST''s role the guardian reads % lunches, not the home class''s one', n; END IF;
  SELECT count(*) INTO n FROM "CalendarRasts" WHERE date = DATE '2095-04-02';
  IF n <> 1 THEN RAISE EXCEPTION 'family: through PostgREST''s role the guardian reads % rasts, not the home class''s one', n; END IF;
END $$;
SET LOCAL ROLE app_authenticated;

-- 29a: the pupil's own arms are unchanged: the home class, the class as an
-- extra group, the lesson naming them and their teaching group's own lesson —
-- and not the lesson carrying their teaching group as an extra group, which
-- the guardian reads (the old gap, out of scope). Their teacher rows are the
-- home class's lessons', as P3 tuned them.
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls29_c_sub'))::text, true);
DO $$
DECLARE l uuid[] := string_to_array(current_setting('app.test_rls29_lessons'), ',')::uuid[]; seen int[]; n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'STUDENT' THEN RAISE EXCEPTION 'family: expected the pupil'; END IF;
  SELECT array_agg(i ORDER BY i) INTO seen FROM generate_subscripts(l, 1) i
   WHERE EXISTS (SELECT 1 FROM "CalendarLessons" cl WHERE cl.id = l[i]);
  IF seen IS DISTINCT FROM ARRAY[1, 3, 4, 7] THEN RAISE EXCEPTION 'family: the pupil reads lessons %, not 1, 3, 4 and 7', seen; END IF;
  SELECT count(*) INTO n FROM "CalendarLessonTeachers" WHERE "calendarLessonId" = ANY (l);
  IF n <> 1 THEN RAISE EXCEPTION 'family: the pupil reads % teacher rows, not their home lesson''s one', n; END IF;
  IF cardinality(app.current_guardian_child_ids()) + cardinality(app.current_guardian_group_ids()) <> 0 THEN
    RAISE EXCEPTION 'family: a pupil has guardian helpers';
  END IF;
END $$;

-- 29a: another school's guardian reads none of it.
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000005')::text, true);
DO $$
DECLARE l uuid[] := string_to_array(current_setting('app.test_rls29_lessons'), ',')::uuid[]; n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'GUARDIAN' THEN RAISE EXCEPTION 'family: expected the second school''s GUARDIAN'; END IF;
  SELECT (SELECT count(*) FROM "CalendarLessons" WHERE id = ANY (l))
       + (SELECT count(*) FROM "CalendarLessonGroups" WHERE "calendarLessonId" = ANY (l))
       + (SELECT count(*) FROM "CalendarLessonStudents" WHERE "calendarLessonId" = ANY (l))
       + (SELECT count(*) FROM "CalendarLunches" WHERE date = DATE '2095-04-02')
       + (SELECT count(*) FROM app.family_lesson_staff(l)) INTO n;
  IF n <> 0 THEN RAISE EXCEPTION 'family: another school''s guardian reads % planted row(s)', n; END IF;
END $$;

-- 29b: app.family_lesson_staff. As the guardian: rows for the five lessons
-- they read and none other; SIGNATURE names T1 on the plain lessons, the
-- substituted lesson is "vikarie" and nameless, the cancelled one nameless
-- and no vikarie, the hidden teacher never named.
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000004')::text, true);
DO $$
DECLARE l uuid[] := string_to_array(current_setting('app.test_rls29_lessons'), ',')::uuid[]; got text;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'GUARDIAN' THEN RAISE EXCEPTION 'family: expected the GUARDIAN'; END IF;
  SELECT string_agg(array_position(l, s.lesson_id) || ':' || s.substitute || ':' || array_to_string(s.labels, '+'), ' '
                    ORDER BY array_position(l, s.lesson_id)) INTO got
    FROM app.family_lesson_staff(l) s;
  IF got IS DISTINCT FROM '1:false:RL29 2:false:RL29 3:true: 4:false: 7:false:' THEN
    RAISE EXCEPTION 'family: the staff function answers %', got;
  END IF;
END $$;

-- NAME, then NONE, then a deactivated teacher: the admin changes the setting.
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
UPDATE "PublicationSettings" SET "publicTeacherDisplay" = 'NAME' WHERE "schoolId" = app.current_school_id();
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000004')::text, true);
DO $$
DECLARE l uuid[] := string_to_array(current_setting('app.test_rls29_lessons'), ',')::uuid[]; got text[]; want text;
BEGIN
  SELECT s.labels INTO got FROM app.family_lesson_staff(ARRAY[l[1]]) s;
  SELECT "firstName" || ' ' || "lastName" INTO want FROM "Users" WHERE id = current_setting('app.test_rls29_t1')::uuid;
  -- The guardian cannot read the teacher's row, so the name is compared by
  -- length only here; the adapter probe compares it with the viewer's.
  IF cardinality(got) <> 1 OR got[1] = 'RL29' OR want IS NOT NULL THEN
    RAISE EXCEPTION 'family: NAME answers % (and the guardian read the teacher row: %)', got, want;
  END IF;
END $$;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
DECLARE l uuid[] := string_to_array(current_setting('app.test_rls29_lessons'), ',')::uuid[]; got text[]; want text;
BEGIN
  SELECT "firstName" || ' ' || "lastName" INTO want FROM "Users" WHERE id = current_setting('app.test_rls29_t1')::uuid;
  SELECT s.labels INTO got FROM app.family_lesson_staff(ARRAY[l[1]]) s;
  IF got IS DISTINCT FROM ARRAY[want] THEN RAISE EXCEPTION 'family: NAME answers the admin %, not %', got, want; END IF;
  -- The admin reaches every lesson of the school, the guardian's or not.
  IF (SELECT count(*) FROM app.family_lesson_staff(l)) <> 8 THEN RAISE EXCEPTION 'family: the admin is answered for fewer than 8 lessons'; END IF;
  UPDATE "PublicationSettings" SET "publicTeacherDisplay" = 'NONE' WHERE "schoolId" = app.current_school_id();
  IF EXISTS (SELECT 1 FROM app.family_lesson_staff(l) s WHERE cardinality(s.labels) > 0) THEN
    RAISE EXCEPTION 'family: NONE still names a teacher';
  END IF;
  UPDATE "PublicationSettings" SET "publicTeacherDisplay" = 'SIGNATURE' WHERE "schoolId" = app.current_school_id();
  UPDATE "Users" SET "isActive" = false, "updatedAt" = now() WHERE id = current_setting('app.test_rls29_t1')::uuid;
  SELECT s.labels INTO got FROM app.family_lesson_staff(ARRAY[l[1]]) s;
  IF got IS DISTINCT FROM '{}'::text[] THEN RAISE EXCEPTION 'family: a deactivated teacher is still named %', got; END IF;
  UPDATE "Users" SET "isActive" = true, "updatedAt" = now() WHERE id = current_setting('app.test_rls29_t1')::uuid;
  DELETE FROM "PublicationSettings" WHERE "schoolId" = app.current_school_id();
  IF EXISTS (SELECT 1 FROM app.family_lesson_staff(l) s WHERE cardinality(s.labels) > 0) THEN
    RAISE EXCEPTION 'family: a school without settings names a teacher';
  END IF;
END $$;

-- A TEACHER or a STUDENT caller gets no rows.
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls29_t2_sub'))::text, true);
DO $$
DECLARE l uuid[] := string_to_array(current_setting('app.test_rls29_lessons'), ',')::uuid[];
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'TEACHER' THEN RAISE EXCEPTION 'family: expected a TEACHER'; END IF;
  IF (SELECT count(*) FROM app.family_lesson_staff(l)) <> 0 THEN RAISE EXCEPTION 'family: a teacher is answered by the family function'; END IF;
END $$;
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls29_c_sub'))::text, true);
DO $$
DECLARE l uuid[] := string_to_array(current_setting('app.test_rls29_lessons'), ',')::uuid[];
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'STUDENT' THEN RAISE EXCEPTION 'family: expected the pupil'; END IF;
  IF (SELECT count(*) FROM app.family_lesson_staff(l)) <> 0 THEN RAISE EXCEPTION 'family: a pupil is answered by the family function'; END IF;
END $$;

-- 29c: PostgREST's role cannot call it; the helpers it can.
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM app.family_lesson_staff('{}'::uuid[]);
    RAISE EXCEPTION 'family: authenticated may call the staff function';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- The lesson-id helper serves only the lesson arm and the staff function,
  -- both the API's alone.
  BEGIN
    PERFORM app.current_guardian_lesson_ids();
    RAISE EXCEPTION 'family: authenticated may call the lesson-id helper';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM app.current_guardian_child_ids(), app.current_guardian_class_ids(), app.current_guardian_group_ids();
END $$;
SET LOCAL ROLE app_authenticated;
DO $$
DECLARE fn text; r text; bad text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['app.current_guardian_child_ids()', 'app.current_guardian_class_ids()', 'app.current_guardian_group_ids()',
                            'app.current_guardian_lesson_ids()', 'app.family_lesson_staff(uuid[])'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) AND has_function_privilege(r, fn, 'EXECUTE') THEN
        RAISE EXCEPTION 'family: % may call %', r, fn;
      END IF;
    END LOOP;
    IF NOT has_function_privilege('app_authenticated', fn, 'EXECUTE') THEN RAISE EXCEPTION 'family: the API may not call %', fn; END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = fn::regprocedure) THEN RAISE EXCEPTION 'family: % is not SECURITY DEFINER', fn; END IF;
    IF (SELECT proacl::text FROM pg_proc WHERE oid = fn::regprocedure) LIKE '%{=X/%' OR (SELECT proacl::text FROM pg_proc WHERE oid = fn::regprocedure) LIKE '%,=X/%' THEN
      RAISE EXCEPTION 'family: PUBLIC may call %', fn;
    END IF;
  END LOOP;
  -- The guard, re-read: the guardian arms and no teacher-row arm.
  SELECT string_agg(tablename || '.' || policyname || ':' || array_to_string(roles, '+'), ',' ORDER BY tablename, policyname) INTO bad
    FROM pg_policies
   WHERE schemaname = 'public' AND (policyname LIKE '%guardian%' OR qual LIKE '%current_guardian_%')
     AND tablename IN ('CalendarLessons', 'CalendarLessonGroups', 'CalendarLessonStudents', 'CalendarLunches', 'CalendarRasts', 'CalendarLessonTeachers');
  IF bad IS DISTINCT FROM 'CalendarLessonGroups.calendar_lesson_groups_guardian_select:app_authenticated,'
     'CalendarLessonStudents.calendar_lesson_students_guardian_select:app_authenticated,'
     'CalendarLessons.calendar_lessons_guardian_select:app_authenticated,'
     'CalendarLunches.calendar_lunches_guardian_select:authenticated,CalendarRasts.calendar_rasts_guardian_select:authenticated' THEN
    RAISE EXCEPTION 'family: the guardian arms are %', bad;
  END IF;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- 29h: why notifyUsers never reads its rows back. A TEACHER may insert a
-- notice for a pupil's guardian (the staff insert arm), and may not SELECT
-- it (notifications_own_select: the recipient's). INSERT … RETURNING applies
-- the SELECT arms to the new rows, so createManyAndReturn would fail every
-- attendance submit that tells a guardian; the gateway gives the rows their
-- ids and calls createMany.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
BEGIN
  PERFORM set_config('app.test_rls29h_guardian', (SELECT id::text FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000004'), true);
  PERFORM set_config('app.test_rls29h_teacher_sub', (SELECT "authId"::text FROM "Users" WHERE "schoolId" = app.current_school_id()
                                                       AND role = 'TEACHER' AND "isActive" ORDER BY "authId" LIMIT 1), true);
END $$;
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls29h_teacher_sub'))::text, true);
DO $$
DECLARE g uuid := current_setting('app.test_rls29h_guardian')::uuid; got uuid; n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'TEACHER' THEN RAISE EXCEPTION 'notices: expected a TEACHER'; END IF;
  INSERT INTO "Notifications" (id, "schoolId", "userId", type, meta)
  VALUES (gen_random_uuid(), app.current_school_id(), g, 'ABSENCE_UNREPORTED', '{}'::jsonb);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'notices: a teacher could not write a guardian''s notice'; END IF;
  BEGIN
    INSERT INTO "Notifications" ("schoolId", "userId", type, meta)
    VALUES (app.current_school_id(), g, 'ABSENCE_UNREPORTED', '{}'::jsonb) RETURNING id INTO got;
    RAISE EXCEPTION 'notices: a teacher read back a guardian''s notice (%), so RETURNING is no longer the reason', got;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  SELECT count(*) INTO n FROM "Notifications" WHERE "userId" = g;
  IF n <> 0 THEN RAISE EXCEPTION 'notices: a teacher reads % of a guardian''s notices', n; END IF;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- 29e: a person's choice of what leaves SchemaPro is theirs alone
-- (NotificationOptOuts, 20261013100000). Own rows for every role, no admin
-- arm, no UPDATE; never the unreported absence or a teacher's absence report
-- (CHECKs). The refusals are asserted as both roles: authenticated
-- (PostgREST) and app_authenticated (the API, a member of authenticated).
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
BEGIN
  PERFORM set_config('app.test_rls29e_teacher', (SELECT id::text FROM "Users" WHERE "schoolId" = app.current_school_id()
                                                   AND role = 'TEACHER' AND "isActive" ORDER BY "authId" LIMIT 1), true);
  PERFORM set_config('app.test_rls29e_teacher_sub', (SELECT "authId"::text FROM "Users" WHERE id = current_setting('app.test_rls29e_teacher')::uuid), true);
  PERFORM set_config('app.test_rls29e_guardian', (SELECT id::text FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000004'), true);
  INSERT INTO "NotificationOptOuts" ("userId", "schoolId", type) VALUES (app.current_user_id(), app.current_school_id(), 'LESSON_ROOM_CHANGED');
END $$;

SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000004')::text, true);
DO $$
DECLARE me uuid := app.current_user_id(); school uuid := app.current_school_id(); n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'GUARDIAN' THEN RAISE EXCEPTION 'optout: expected the GUARDIAN'; END IF;
  INSERT INTO "NotificationOptOuts" ("userId", "schoolId", type) VALUES (me, school, 'LESSON_CANCELLED');
  SELECT count(*) INTO n FROM "NotificationOptOuts";
  IF n <> 1 THEN RAISE EXCEPTION 'optout: the guardian reads % rows, not their own one (the admin''s is there)', n; END IF;
  BEGIN
    INSERT INTO "NotificationOptOuts" ("userId", "schoolId", type) VALUES (me, school, 'ABSENCE_UNREPORTED');
    RAISE EXCEPTION 'optout: the unreported absence was silenced';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "NotificationOptOuts" ("userId", "schoolId", type) VALUES (me, school, 'TEACHER_ABSENCE_REPORTED');
    RAISE EXCEPTION 'optout: a type that never leaves the inbox was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- The refusals, as each role.
SET LOCAL ROLE authenticated;
DO $$
DECLARE me uuid := app.current_user_id(); n bigint;
BEGIN
  IF current_user <> 'authenticated' THEN RAISE EXCEPTION 'optout: expected to act as authenticated'; END IF;
  BEGIN
    INSERT INTO "NotificationOptOuts" ("userId", "schoolId", type)
    VALUES (current_setting('app.test_rls29e_teacher')::uuid, app.current_school_id(), 'LESSON_CANCELLED');
    RAISE EXCEPTION 'optout: authenticated chose for somebody else';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE "NotificationOptOuts" SET type = 'SCHEDULE_CHANGED' WHERE "userId" = me;
    RAISE EXCEPTION 'optout: authenticated updated a choice';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM app.delivery_opt_outs(app.current_school_id(), ARRAY[me], 'LESSON_CANCELLED');
    RAISE EXCEPTION 'optout: authenticated may call the delivery''s read';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
SET LOCAL ROLE app_authenticated;
DO $$
DECLARE me uuid := app.current_user_id(); n bigint; got uuid[];
BEGIN
  IF current_user <> 'app_authenticated' THEN RAISE EXCEPTION 'optout: expected to act as app_authenticated'; END IF;
  BEGIN
    INSERT INTO "NotificationOptOuts" ("userId", "schoolId", type)
    VALUES (current_setting('app.test_rls29e_teacher')::uuid, app.current_school_id(), 'LESSON_CANCELLED');
    RAISE EXCEPTION 'optout: the API chose for somebody else';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE "NotificationOptOuts" SET type = 'SCHEDULE_CHANGED' WHERE "userId" = me;
    RAISE EXCEPTION 'optout: the API updated a choice';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- Deleting somebody else's row deletes nothing.
  DELETE FROM "NotificationOptOuts" WHERE "userId" <> me;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'optout: the guardian deleted % row(s) of somebody else', n; END IF;
  -- The delivery's read, as the API calls it: the guardian's choice, by user.
  SELECT array_agg(u) INTO got FROM app.delivery_opt_outs(app.current_school_id(), ARRAY[me, current_setting('app.test_rls29e_teacher')::uuid], 'LESSON_CANCELLED') u;
  IF got IS DISTINCT FROM ARRAY[me] THEN RAISE EXCEPTION 'optout: the delivery read %', got; END IF;
  SELECT count(*) INTO n FROM app.delivery_opt_outs(app.current_school_id(), ARRAY[me], 'SCHEDULE_CHANGED');
  IF n <> 0 THEN RAISE EXCEPTION 'optout: a type not chosen reads as chosen'; END IF;
END $$;

-- The admin and a teacher read none of the guardian's; the other school's guardian none at all.
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "NotificationOptOuts" WHERE "userId" <> app.current_user_id();
  IF n <> 0 THEN RAISE EXCEPTION 'optout: the admin reads % choice(s) of somebody else', n; END IF;
  DELETE FROM "NotificationOptOuts" WHERE "userId" = current_setting('app.test_rls29e_guardian')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'optout: the admin deleted a guardian''s choice'; END IF;
END $$;
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls29e_teacher_sub'))::text, true);
DO $$
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'TEACHER' THEN RAISE EXCEPTION 'optout: expected a TEACHER'; END IF;
  IF (SELECT count(*) FROM "NotificationOptOuts") <> 0 THEN RAISE EXCEPTION 'optout: a teacher reads somebody''s choices'; END IF;
END $$;
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000005')::text, true);
DO $$
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'GUARDIAN' THEN RAISE EXCEPTION 'optout: expected the second school''s GUARDIAN'; END IF;
  IF (SELECT count(*) FROM "NotificationOptOuts") <> 0 THEN RAISE EXCEPTION 'optout: another school''s guardian reads choices'; END IF;
END $$;

-- The catalogue: three own arms, the grants, the function's ACL.
DO $$
DECLARE bad text; api_role text;
BEGIN
  SELECT string_agg(policyname || ':' || cmd, ',' ORDER BY policyname) INTO bad FROM pg_policies WHERE tablename = 'NotificationOptOuts';
  IF bad IS DISTINCT FROM 'notification_opt_outs_own_delete:DELETE,notification_opt_outs_own_insert:INSERT,notification_opt_outs_own_select:SELECT' THEN
    RAISE EXCEPTION 'optout: the policies are %', bad;
  END IF;
  FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role', 'app_authenticated') LOOP
    SELECT string_agg(p, ', ') INTO bad
      FROM unnest(CASE api_role
                    WHEN 'anon' THEN ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
                    WHEN 'service_role' THEN ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
                    ELSE ARRAY['UPDATE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] END) p
     WHERE has_table_privilege(api_role, 'public."NotificationOptOuts"', p);
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'optout: % holds %', api_role, bad; END IF;
  END LOOP;
  IF NOT has_table_privilege('app_authenticated', 'public."NotificationOptOuts"', 'SELECT, INSERT, DELETE') THEN
    RAISE EXCEPTION 'optout: the API cannot read, write and delete its own choices';
  END IF;
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role)
       AND has_function_privilege(api_role, 'app.delivery_opt_outs(uuid, uuid[], "NotificationType")', 'EXECUTE') THEN
      RAISE EXCEPTION 'optout: % may call the delivery''s read', api_role;
    END IF;
  END LOOP;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'app.delivery_opt_outs(uuid, uuid[], "NotificationType")'::regprocedure) ~ '(^|[{,])(=|authenticated=)X' THEN
    RAISE EXCEPTION 'optout: PUBLIC or authenticated holds EXECUTE on the delivery''s read';
  END IF;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- 29d: a device token is its owner's (DevicePushTokens, 20261013110000).
-- Written only by app.claim_device_push_token for the claims' own user; the
-- owner reads and deletes their own rows; a claim takes a token over, across
-- schools too; release deletes whichever row holds a token. The direct
-- writes are refused as both authenticated and app_authenticated.
-- 29f: PushTickets has no arm and no grant. 29g: the catalogue.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
BEGIN
  PERFORM set_config('app.test_rls29d_teacher_sub', (SELECT "authId"::text FROM "Users" WHERE "schoolId" = app.current_school_id()
                                                       AND role = 'TEACHER' AND "isActive" ORDER BY "authId" LIMIT 1), true);
  PERFORM set_config('app.test_rls29d_guardian', (SELECT id::text FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000004'), true);
  PERFORM set_config('app.test_rls29d_school', app.current_school_id()::text, true);
END $$;

-- The guardian registers a device, and cannot write a row any other way.
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000004')::text, true);
DO $$
DECLARE id uuid; again uuid; n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'GUARDIAN' THEN RAISE EXCEPTION 'devices: expected the GUARDIAN'; END IF;
  id := app.claim_device_push_token('ExponentPushToken[rls29dAAAAAAAA]', 'IOS', 'sv');
  again := app.claim_device_push_token('ExponentPushToken[rls29dAAAAAAAA]', 'IOS', 'en');
  IF id IS NULL OR id <> again THEN RAISE EXCEPTION 'devices: a second registration of the same token made a second row'; END IF;
  SELECT count(*) INTO n FROM "DevicePushTokens" WHERE locale = 'en' AND "revokedAt" IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'devices: the owner reads % live rows of theirs in English, not their one', n; END IF;
  PERFORM set_config('app.test_rls29d_token_id', id::text, true);
  BEGIN
    PERFORM app.claim_device_push_token('ExponentPushToken[rls29dBBBBBBBB]', 'IOS', 'de');
    RAISE EXCEPTION 'devices: a language nobody speaks was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM app.claim_device_push_token('fcm:not-an-expo-token', 'ANDROID', 'sv');
    RAISE EXCEPTION 'devices: a token not in Expo''s format was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF current_user <> 'authenticated' THEN RAISE EXCEPTION 'devices: expected to act as authenticated'; END IF;
  BEGIN
    INSERT INTO "DevicePushTokens" ("schoolId", "userId", token, platform)
    VALUES (app.current_school_id(), app.current_user_id(), 'ExponentPushToken[rls29dCCCCCCCC]', 'IOS');
    RAISE EXCEPTION 'devices: authenticated wrote a token row directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE "DevicePushTokens" SET locale = 'sv' WHERE "userId" = app.current_user_id();
    RAISE EXCEPTION 'devices: authenticated updated a token row directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM app.claim_device_push_token('ExponentPushToken[rls29dDDDDDDDD]', 'IOS', 'sv');
    RAISE EXCEPTION 'devices: authenticated (PostgREST) may register a token';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM app.release_device_push_token('ExponentPushToken[rls29dAAAAAAAA]');
    RAISE EXCEPTION 'devices: authenticated may release a token';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM * FROM app.push_targets(app.current_school_id(), ARRAY[app.current_user_id()], 'LESSON_CANCELLED', false);
    RAISE EXCEPTION 'devices: authenticated may read push targets';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM app.push_settle(app.current_school_id(), '{}'::uuid[], '[]'::jsonb);
    RAISE EXCEPTION 'devices: authenticated may settle tickets';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM * FROM app.push_due_receipts(1);
    RAISE EXCEPTION 'devices: authenticated may claim receipts';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM app.push_receipts_settled('{}'::text[], '{}'::text[]);
    RAISE EXCEPTION 'devices: authenticated may settle receipts';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- 29f
  BEGIN
    PERFORM count(*) FROM "PushTickets";
    RAISE EXCEPTION 'devices: authenticated reads PushTickets';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
SET LOCAL ROLE app_authenticated;
DO $$
BEGIN
  IF current_user <> 'app_authenticated' THEN RAISE EXCEPTION 'devices: expected to act as app_authenticated'; END IF;
  BEGIN
    INSERT INTO "DevicePushTokens" ("schoolId", "userId", token, platform)
    VALUES (app.current_school_id(), app.current_user_id(), 'ExponentPushToken[rls29dCCCCCCCC]', 'IOS');
    RAISE EXCEPTION 'devices: the API wrote a token row directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE "DevicePushTokens" SET locale = 'sv' WHERE "userId" = app.current_user_id();
    RAISE EXCEPTION 'devices: the API updated a token row directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM count(*) FROM "PushTickets";
    RAISE EXCEPTION 'devices: the API reads PushTickets directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO "PushTickets" (id, "schoolId", "tokenId")
    VALUES ('rls29dticket00', app.current_school_id(), current_setting('app.test_rls29d_token_id')::uuid);
    RAISE EXCEPTION 'devices: the API wrote a ticket directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

-- The delivery's functions, as the API calls them.
DO $$
DECLARE
  school uuid := current_setting('app.test_rls29d_school')::uuid;
  g uuid := current_setting('app.test_rls29d_guardian')::uuid;
  tok uuid := current_setting('app.test_rls29d_token_id')::uuid;
  n bigint;
  got text;
BEGIN
  SELECT string_agg(user_id::text || ':' || locale || ':' || timezone, ',') INTO got
    FROM app.push_targets(school, ARRAY[g], 'LESSON_CANCELLED', false);
  IF got IS DISTINCT FROM g::text || ':en:' || (SELECT coalesce(timezone, 'Europe/Stockholm') FROM "Schools" WHERE id = school) AND got IS DISTINCT FROM g::text || ':en:Europe/Stockholm' THEN
    RAISE EXCEPTION 'devices: the targets are %', got;
  END IF;
  SELECT count(*) INTO n FROM app.push_targets(school, ARRAY[g], 'TEACHER_ABSENCE_REPORTED', true);
  IF n <> 0 THEN RAISE EXCEPTION 'devices: a teacher''s absence report has a push target'; END IF;
  SELECT count(*) INTO n FROM app.push_targets(gen_random_uuid(), ARRAY[g], 'LESSON_CANCELLED', false);
  IF n <> 0 THEN RAISE EXCEPTION 'devices: another school''s delivery reaches the guardian''s device'; END IF;
  -- An opt-out silences the type, unless the school must deliver it.
  INSERT INTO "NotificationOptOuts" ("userId", "schoolId", type) VALUES (g, school, 'LESSON_CANCELLED');
  SELECT count(*) INTO n FROM app.push_targets(school, ARRAY[g], 'LESSON_CANCELLED', false);
  IF n <> 0 THEN RAISE EXCEPTION 'devices: an opted-out type still has a target'; END IF;
  SELECT count(*) INTO n FROM app.push_targets(school, ARRAY[g], 'LESSON_CANCELLED', true);
  IF n <> 1 THEN RAISE EXCEPTION 'devices: a required notice lost its target to an opt-out'; END IF;
  -- Settling for another school changes nothing; for this one it revokes.
  PERFORM app.push_settle(gen_random_uuid(), ARRAY[tok], '[]'::jsonb);
  SELECT count(*) INTO n FROM "DevicePushTokens" WHERE id = tok AND "revokedAt" IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'devices: another school''s settle revoked the guardian''s device'; END IF;
  PERFORM app.push_settle(school, ARRAY[tok], jsonb_build_array(jsonb_build_object('id', 'rls29dticket01', 'tokenId', tok)));
  SELECT count(*) INTO n FROM "DevicePushTokens" WHERE id = tok AND "revokedReason" = 'DEVICE_NOT_REGISTERED';
  IF n <> 1 THEN RAISE EXCEPTION 'devices: settle did not revoke the dead device'; END IF;
  SELECT count(*) INTO n FROM app.push_targets(school, ARRAY[g], 'LESSON_CANCELLED', true);
  IF n <> 0 THEN RAISE EXCEPTION 'devices: a revoked device is still a target'; END IF;
  -- A fresh ticket is not due; settling receipts of unknown ids is harmless.
  SELECT count(*) INTO n FROM app.push_due_receipts(1000) WHERE ticket_id = 'rls29dticket01';
  IF n <> 0 THEN RAISE EXCEPTION 'devices: a ticket was due at once'; END IF;
  PERFORM app.push_receipts_settled(ARRAY['rls29dticket01', 'rls29dnothing'], ARRAY['rls29dnothing']);
  -- A registration revives the device.
  PERFORM app.claim_device_push_token('ExponentPushToken[rls29dAAAAAAAA]', 'IOS', 'sv');
  SELECT count(*) INTO n FROM app.push_targets(school, ARRAY[g], 'LESSON_CANCELLED', true);
  IF n <> 1 THEN RAISE EXCEPTION 'devices: a new registration did not revive the device'; END IF;
  -- At most ten live devices per person.
  FOR n IN 1..11 LOOP
    PERFORM app.claim_device_push_token(format('ExponentPushToken[rls29dmany%s]', lpad(n::text, 4, '0')), 'ANDROID', 'sv');
  END LOOP;
  SELECT count(*) INTO n FROM "DevicePushTokens";
  IF n <> 10 THEN RAISE EXCEPTION 'devices: a person holds % devices, not ten', n; END IF;
  -- Back to the one device for what follows.
  DELETE FROM "DevicePushTokens" WHERE token LIKE 'ExponentPushToken[rls29dmany%';
  PERFORM app.claim_device_push_token('ExponentPushToken[rls29dAAAAAAAA]', 'IOS', 'sv');
END $$;

-- A teacher of the school: sees none of the guardian's, deletes none, and a
-- claim of the same token takes the device over.
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls29d_teacher_sub'))::text, true);
DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'TEACHER' THEN RAISE EXCEPTION 'devices: expected a TEACHER'; END IF;
  SELECT count(*) INTO n FROM "DevicePushTokens";
  IF n <> 0 THEN RAISE EXCEPTION 'devices: a teacher reads % device(s) of somebody else', n; END IF;
  DELETE FROM "DevicePushTokens" WHERE token = 'ExponentPushToken[rls29dAAAAAAAA]';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'devices: a teacher deleted somebody else''s device'; END IF;
  PERFORM app.claim_device_push_token('ExponentPushToken[rls29dAAAAAAAA]', 'ANDROID', 'sv');
  SELECT count(*) INTO n FROM "DevicePushTokens" WHERE token = 'ExponentPushToken[rls29dAAAAAAAA]';
  IF n <> 1 THEN RAISE EXCEPTION 'devices: the teacher''s claim did not take the device'; END IF;
END $$;
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000004')::text, true);
DO $$
BEGIN
  IF (SELECT count(*) FROM "DevicePushTokens") <> 0 THEN RAISE EXCEPTION 'devices: the guardian still holds the device the teacher took'; END IF;
END $$;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
BEGIN
  IF (SELECT count(*) FROM "DevicePushTokens") <> 0 THEN RAISE EXCEPTION 'devices: the admin reads somebody''s devices'; END IF;
END $$;

-- Across schools: the second school's guardian claims the device; the teacher
-- loses it, and nothing of the first school's row is said.
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000005')::text, true);
DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'GUARDIAN' THEN RAISE EXCEPTION 'devices: expected the second school''s GUARDIAN'; END IF;
  PERFORM app.claim_device_push_token('ExponentPushToken[rls29dAAAAAAAA]', 'IOS', 'en');
  SELECT count(*) INTO n FROM "DevicePushTokens";
  IF n <> 1 THEN RAISE EXCEPTION 'devices: the second school''s guardian reads % devices, not the one they took', n; END IF;
END $$;
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls29d_teacher_sub'))::text, true);
DO $$
BEGIN
  IF (SELECT count(*) FROM "DevicePushTokens") <> 0 THEN RAISE EXCEPTION 'devices: the teacher kept a device another school took'; END IF;
  -- Release: holding the token deletes whoever holds it (the logout that did
  -- not reach the API), the other school's row included.
  PERFORM app.release_device_push_token('ExponentPushToken[rls29dAAAAAAAA]');
END $$;
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000005')::text, true);
DO $$
BEGIN
  IF (SELECT count(*) FROM "DevicePushTokens") <> 0 THEN RAISE EXCEPTION 'devices: a released device still has its row'; END IF;
END $$;

-- No principal at all: registration and release are refused.
SELECT set_config('request.jwt.claims', '', true);
DO $$
BEGIN
  BEGIN
    PERFORM app.claim_device_push_token('ExponentPushToken[rls29dEEEEEEEE]', 'IOS', 'sv');
    RAISE EXCEPTION 'devices: a device was registered without a principal';
  EXCEPTION WHEN SQLSTATE 'PU401' THEN NULL;
  END;
  BEGIN
    PERFORM app.release_device_push_token('ExponentPushToken[rls29dEEEEEEEE]');
    RAISE EXCEPTION 'devices: a device was released without a principal';
  EXCEPTION WHEN SQLSTATE 'PU401' THEN NULL;
  END;
END $$;

-- 29f/29g: the catalogue.
DO $$
DECLARE bad text; api_role text; fn text;
BEGIN
  SELECT string_agg(tablename || '.' || policyname || ':' || cmd, ',' ORDER BY tablename, policyname) INTO bad
    FROM pg_policies WHERE tablename IN ('DevicePushTokens', 'PushTickets');
  IF bad IS DISTINCT FROM 'DevicePushTokens.device_push_tokens_own_delete:DELETE,DevicePushTokens.device_push_tokens_own_select:SELECT' THEN
    RAISE EXCEPTION 'devices: the policies are %', bad;
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public."PushTickets"'::regclass) THEN
    RAISE EXCEPTION 'devices: PushTickets has no row-level security';
  END IF;
  FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role', 'app_authenticated') LOOP
    SELECT string_agg(t || ':' || p, ', ') INTO bad
      FROM (VALUES ('DevicePushTokens'), ('PushTickets')) AS x(t),
           unnest(CASE
                    WHEN api_role = 'anon' OR x.t = 'PushTickets' THEN ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
                    WHEN api_role = 'service_role' THEN ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
                    ELSE ARRAY['INSERT', 'UPDATE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] END) p
     WHERE has_table_privilege(api_role, format('public.%I', x.t), p);
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'devices: % holds %', api_role, bad; END IF;
  END LOOP;
  FOREACH fn IN ARRAY ARRAY[
    'app.claim_device_push_token(text, "DevicePlatform", text)', 'app.release_device_push_token(text)',
    'app.push_targets(uuid, uuid[], "NotificationType", boolean)', 'app.push_settle(uuid, uuid[], jsonb)',
    'app.push_due_receipts(integer)', 'app.push_receipts_settled(text[], text[])'] LOOP
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) AND has_function_privilege(api_role, fn, 'EXECUTE') THEN
        RAISE EXCEPTION 'devices: % may call %', api_role, fn;
      END IF;
    END LOOP;
    IF NOT has_function_privilege('app_authenticated', fn, 'EXECUTE') THEN RAISE EXCEPTION 'devices: the API may not call %', fn; END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = fn::regprocedure) THEN RAISE EXCEPTION 'devices: % is not SECURITY DEFINER', fn; END IF;
  END LOOP;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- 30: the SS12000 consumer (20261014090000–20261014110000). The school's
-- source, its sealed credentials, the run log and its diff are the admin's
-- and the sync principal's; nobody else reads a row, and no principal reads
-- a credential except through app.ss12000_source_secrets, which hands it to
-- the school's sync principal (no claims beside it) or its SCHOOL_ADMIN
-- only. The sync principal reads its own school and writes narrowly: on
-- Users names, the class and the deactivation of a pupil or guardian; on
-- the source its cursors. It never deletes. An ss12000Id is written by an
-- admin alone. A terminal run stays terminal, and its changes lose their
-- names and emails at once. GuardianStudentHistory records every unlink.
-- The scheduler's claim runs at or after the hour, once per local day,
-- across both DST changes. Everything planted here is rolled back.
--   30a the admin's round trip and the CHECKs; 30b the sync principal;
--   30c another school's sync and admin; 30d TEACHER / STUDENT / GUARDIAN;
--   30e the id guard against the v1 service principal; 30f the run log;
--   30g guardian history; 30h the scheduler; 30i the catalogue.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
SELECT set_config('app.test_rls30_school_b', :'school_b', true);

-- 30a
DO $$
DECLARE
  school uuid := app.current_school_id();
  src uuid;
  run uuid;
  stamped timestamptz;
  n bigint;
  yr uuid;
  tg uuid;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'SCHOOL_ADMIN' THEN RAISE EXCEPTION 'ss30a: expected the admin'; END IF;
  INSERT INTO "Ss12000Sources" ("schoolId", name, "baseUrl", "authKind", "tokenUrl", "clientId", "organisationIds")
  VALUES (school, 'RLS 30', 'https://api.ist.example/ss12000v2-api/source/SE00100/v2.0', 'OAUTH2_CLIENT_CREDENTIALS',
          'https://skolid.example/connect/token', 'rls30', ARRAY['aaaaaaaa-0000-4000-8000-000000000030']::uuid[])
  RETURNING id INTO src;
  PERFORM set_config('app.test_rls30_source', src::text, true);
  PERFORM set_config('app.test_rls30_school', school::text, true);

  -- The CHECKs mirror the DTO: https, no userinfo, no query, auto-apply needs the schedule, five organisations.
  BEGIN
    UPDATE "Ss12000Sources" SET "baseUrl" = 'http://api.ist.example/v2.0' WHERE id = src;
    RAISE EXCEPTION 'ss30a: an http base URL was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE "Ss12000Sources" SET "baseUrl" = 'https://user:pw@api.ist.example/v2.0' WHERE id = src;
    RAISE EXCEPTION 'ss30a: credentials in a base URL were stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE "Ss12000Sources" SET "tokenUrl" = 'https://skolid.example/connect/token?client_secret=x' WHERE id = src;
    RAISE EXCEPTION 'ss30a: a token URL with a query was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE "Ss12000Sources" SET "scheduleAutoApply" = true WHERE id = src;
    RAISE EXCEPTION 'ss30a: auto-apply was stored without the schedule';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE "Ss12000Sources" SET "organisationIds" = array_fill('aaaaaaaa-0000-4000-8000-000000000030'::uuid, ARRAY[6]) WHERE id = src;
    RAISE EXCEPTION 'ss30a: six organisations were stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE "Ss12000Sources" SET "authKind" = 'BEARER_TOKEN' WHERE id = src;
    RAISE EXCEPTION 'ss30a: a static token kept an OAuth client';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- A credential goes in through the function and comes out as presence only.
  stamped := app.ss12000_set_source_secret(src, 'CLIENT_SECRET', '\x0102030405'::bytea,
                                           decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'), 'abcdef0123456789');
  IF stamped IS NULL THEN RAISE EXCEPTION 'ss30a: the secret was not stored'; END IF;
  SELECT count(*) INTO n FROM app.ss12000_source_secret_presence(src);
  IF n <> 1 THEN RAISE EXCEPTION 'ss30a: presence reads % rows, not one', n; END IF;
  SELECT count(*) INTO n FROM app.ss12000_source_secrets(src);
  IF n <> 1 THEN RAISE EXCEPTION 'ss30a: the admin cannot read the ciphertext to test the connection'; END IF;
  BEGIN
    PERFORM app.ss12000_set_source_secret(src, 'CLIENT_SECRET', '\x01'::bytea, decode(repeat('00', 11), 'hex'), decode(repeat('00', 16), 'hex'), 'abcdef0123456789');
    RAISE EXCEPTION 'ss30a: an iv that is not GCM''s was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM count(*) FROM "Ss12000SourceSecrets";
    RAISE EXCEPTION 'ss30a: the admin reads the secrets table directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- "Synka nu" inserts a MANUAL RUNNING run; nothing else, and one at a time.
  INSERT INTO "Ss12000SyncRuns" ("schoolId", "sourceId", "trigger", "mode") VALUES (school, src, 'MANUAL', 'FULL') RETURNING id INTO run;
  PERFORM set_config('app.test_rls30_run', run::text, true);
  BEGIN
    INSERT INTO "Ss12000SyncRuns" ("schoolId", "sourceId", "trigger", "mode") VALUES (school, src, 'MANUAL', 'FULL');
    RAISE EXCEPTION 'ss30a: a second RUNNING run of one source was stored';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "Ss12000SyncRuns" ("schoolId", "sourceId", "trigger", "mode", "status") VALUES (school, src, 'SCHEDULED', 'FULL', 'SKIPPED');
    RAISE EXCEPTION 'ss30a: the admin wrote a scheduled run';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM "Ss12000SyncRuns" WHERE id = run;
    RAISE EXCEPTION 'ss30a: the admin deleted a run';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM "Ss12000Sources" WHERE id = src;
    RAISE EXCEPTION 'ss30a: the admin deleted the source';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- A teaching group of the school, for the sync's membership insert below.
  SELECT id INTO yr FROM "AcademicYears" WHERE "schoolId" = school ORDER BY "isActive" DESC, "startDate" DESC LIMIT 1;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "updatedAt")
  VALUES (school, yr, 'RLS 30 Spanska', 'TEACHING_GROUP', now()) RETURNING id INTO tg;
  PERFORM set_config('app.test_rls30_group', tg::text, true);
END $$;

-- 30b: the sync principal of the same school, with no claims beside it.
SELECT set_config('request.jwt.claims', '', true);
SELECT set_config('app.sync_school_id', current_setting('app.test_rls30_school'), true);
DO $$
DECLARE
  school uuid := current_setting('app.test_rls30_school')::uuid;
  src uuid := current_setting('app.test_rls30_source')::uuid;
  run uuid := current_setting('app.test_rls30_run')::uuid;
  tg uuid := current_setting('app.test_rls30_group')::uuid;
  pupil uuid; teacher uuid; admin uuid; guardian uuid;
  n bigint;
BEGIN
  IF app.current_sync_school_id() IS DISTINCT FROM school OR app.current_user_id() IS NOT NULL THEN
    RAISE EXCEPTION 'ss30b: expected the sync principal and no claims';
  END IF;
  SELECT count(*) INTO n FROM "Ss12000Sources";
  IF n <> 1 THEN RAISE EXCEPTION 'ss30b: the sync reads % sources, not its school''s one', n; END IF;
  SELECT count(*) INTO n FROM "Users" WHERE "schoolId" <> school;
  IF n <> 0 THEN RAISE EXCEPTION 'ss30b: the sync reads % users of another school', n; END IF;
  SELECT count(*) INTO n FROM "Users";
  IF n = 0 THEN RAISE EXCEPTION 'ss30b: the sync reads no user of its school'; END IF;
  SELECT count(*) INTO n FROM app.ss12000_source_secrets(src);
  IF n <> 1 THEN RAISE EXCEPTION 'ss30b: the sync cannot read its source''s credential'; END IF;

  -- The source: cursors yes, configuration never.
  UPDATE "Ss12000Sources" SET "modifiedCursor" = now(), "deletedCursor" = now(), "schoolUnitCodes" = ARRAY['12345678'] WHERE id = src;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'ss30b: the sync could not move its cursors'; END IF;
  BEGIN
    UPDATE "Ss12000Sources" SET "baseUrl" = 'https://evil.example/v2.0' WHERE id = src;
    RAISE EXCEPTION 'ss30b: the sync repointed its source';
  EXCEPTION WHEN SQLSTATE 'SS403' THEN NULL;
  END;
  BEGIN
    UPDATE "Ss12000Sources" SET "scheduleEnabled" = true WHERE id = src;
    RAISE EXCEPTION 'ss30b: the sync turned its own schedule on';
  EXCEPTION WHEN SQLSTATE 'SS403' THEN NULL;
  END;

  -- The diff: changes and the run's status.
  INSERT INTO "Ss12000SyncChanges" ("runId", "schoolId", seq, entity, op, "externalId", "after", selected, "autoApplicable")
  VALUES (run, school, 0, 'PERSON', 'UPDATE', 'bbbbbbbb-0000-4000-8000-000000000030', '{"firstName": "Ella", "lastName": "Ek"}', true, true);
  BEGIN
    INSERT INTO "Ss12000SyncChanges" ("runId", "schoolId", seq, entity, op, selected) VALUES (run, school, 1, 'PERSON', 'CONFLICT', true);
    RAISE EXCEPTION 'ss30b: a conflict was stored selected';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "Ss12000SyncChanges" ("runId", "schoolId", seq, entity, op, selected, "autoApplicable", "protectedIdentity")
    VALUES (run, school, 2, 'PERSON', 'UPDATE', false, true, true);
    RAISE EXCEPTION 'ss30b: a protected identity''s change was stored automatic';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE "Ss12000SyncRuns" SET status = 'DIFF_READY', "basisHash" = repeat('a', 64), "fetchedAt" = now() WHERE id = run;

  -- Users: names, class, deactivation of a pupil — and nothing else.
  SELECT id INTO pupil FROM "Users" u WHERE u."schoolId" = school AND u.role = 'STUDENT' AND u."isActive"
     AND NOT EXISTS (SELECT 1 FROM "GuardianStudents" gs JOIN "Users" g ON g.id = gs."guardianId"
                      WHERE gs."studentId" = u.id AND g."authId" = '00000000-0000-4000-8000-000000000004')
   ORDER BY id LIMIT 1;
  SELECT id INTO teacher FROM "Users" WHERE "schoolId" = school AND role = 'TEACHER' AND "isActive" ORDER BY id LIMIT 1;
  SELECT id INTO admin FROM "Users" WHERE "schoolId" = school AND role = 'SCHOOL_ADMIN' AND "isActive" ORDER BY id LIMIT 1;
  SELECT id INTO guardian FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000004';
  IF pupil IS NULL OR teacher IS NULL OR admin IS NULL OR guardian IS NULL THEN RAISE EXCEPTION 'ss30b: the fixtures lack a pupil, teacher, admin or guardian'; END IF;
  PERFORM set_config('app.test_rls30_pupil', pupil::text, true);

  UPDATE "Users" SET "firstName" = 'Rls30', "lastName" = 'Synk' WHERE id = pupil;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'ss30b: the sync could not update a pupil''s name'; END IF;
  BEGIN
    UPDATE "Users" SET email = 'rls30-moved@example.invalid' WHERE id = pupil;
    RAISE EXCEPTION 'ss30b: the sync changed an email';
  EXCEPTION WHEN SQLSTATE 'SS403' THEN NULL;
  END;
  BEGIN
    UPDATE "Users" SET role = 'TEACHER', "studentGroupId" = NULL WHERE id = pupil;
    RAISE EXCEPTION 'ss30b: the sync changed a role';
  EXCEPTION WHEN SQLSTATE 'SS403' THEN NULL;
  END;
  BEGIN
    UPDATE "Users" SET "ss12000Id" = 'bbbbbbbb-0000-4000-8000-000000000031' WHERE id = pupil;
    RAISE EXCEPTION 'ss30b: the sync linked a person';
  EXCEPTION WHEN SQLSTATE 'SS403' THEN NULL;
  END;
  BEGIN
    UPDATE "Users" SET "firstName" = 'Rls30' WHERE id = admin;
    RAISE EXCEPTION 'ss30b: the sync touched an admin';
  EXCEPTION WHEN SQLSTATE 'SS403' THEN NULL;
  END;
  BEGIN
    UPDATE "Users" SET "isActive" = false WHERE id = teacher;
    RAISE EXCEPTION 'ss30b: the sync deactivated a teacher';
  EXCEPTION WHEN SQLSTATE 'SS403' THEN NULL;
  END;
  UPDATE "Users" SET "isActive" = false WHERE id = pupil;
  BEGIN
    UPDATE "Users" SET "isActive" = true WHERE id = pupil;
    RAISE EXCEPTION 'ss30b: the sync reactivated somebody';
  EXCEPTION WHEN SQLSTATE 'SS403' THEN NULL;
  END;
  BEGIN
    INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "updatedAt")
    VALUES (school, 'rls30-new@example.invalid', 'Ny', 'Person', 'STUDENT', gen_random_uuid(), now());
    RAISE EXCEPTION 'ss30b: the sync created a person';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- Memberships and guardian links: inserted, never deleted.
  INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES (school, tg, pupil);
  BEGIN
    INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES (school, tg, teacher);
    RAISE EXCEPTION 'ss30b: the sync put a teacher in a teaching group';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId", origin) VALUES (school, guardian, pupil, 'SS12000');
  DELETE FROM "GuardianStudents" WHERE "studentId" = pupil;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'ss30b: the sync deleted % guardian links', n; END IF;
  DELETE FROM "StudentGroupMembers" WHERE "studentId" = pupil;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'ss30b: the sync deleted % memberships', n; END IF;

  -- Duty links: upsert and end, never delete.
  INSERT INTO "Ss12000DutyLinks" ("schoolId", "userId", "academicYearId", "ss12000DutyId", "dutyRole", "startDate", "updatedAt")
  SELECT school, teacher, y.id, 'ffffffff-0000-4000-8000-000000000030', 'Lärare', y."startDate", now()
    FROM "AcademicYears" y WHERE y."schoolId" = school ORDER BY y."isActive" DESC LIMIT 1;
  BEGIN
    UPDATE "Ss12000DutyLinks" SET "dutyRole" = 'Lärarinna' WHERE "ss12000DutyId" = 'ffffffff-0000-4000-8000-000000000030';
    RAISE EXCEPTION 'ss30b: a duty role S1 does not define was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE "Ss12000DutyLinks" SET "endedAt" = now() WHERE "ss12000DutyId" = 'ffffffff-0000-4000-8000-000000000030';
  BEGIN
    DELETE FROM "Ss12000DutyLinks" WHERE "ss12000DutyId" = 'ffffffff-0000-4000-8000-000000000030';
    RAISE EXCEPTION 'ss30b: a duty link was deleted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

-- A service principal or a person's claims beside the sync: no credential.
SELECT set_config('app.service_school_id', current_setting('app.test_rls30_school'), true);
DO $$
BEGIN
  BEGIN
    PERFORM count(*) FROM app.ss12000_source_secrets(current_setting('app.test_rls30_source')::uuid);
    RAISE EXCEPTION 'ss30b: a service principal read a credential';
  EXCEPTION WHEN SQLSTATE 'SS403' THEN NULL;
  END;
END $$;
SELECT set_config('app.service_school_id', '', true);
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
BEGIN
  BEGIN
    PERFORM count(*) FROM app.ss12000_source_secrets(current_setting('app.test_rls30_source')::uuid);
    RAISE EXCEPTION 'ss30b: the sync read a credential with a person''s claims beside it';
  EXCEPTION WHEN SQLSTATE 'SS403' THEN NULL;
  END;
  BEGIN
    PERFORM app.ss12000_set_source_secret(current_setting('app.test_rls30_source')::uuid, 'BEARER_TOKEN', '\x01'::bytea,
                                          decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'), 'abcdef0123456789');
    RAISE EXCEPTION 'ss30b: an admin wrote a credential while a sync principal was set';
  EXCEPTION WHEN SQLSTATE 'SS403' THEN NULL;
  END;
END $$;
SELECT set_config('app.sync_school_id', '', true);

-- 30c: another school's sync principal and admin see none of it.
SELECT set_config('request.jwt.claims', '', true);
SELECT set_config('app.sync_school_id', current_setting('app.test_rls30_school_b'), true);
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "Ss12000Sources" WHERE id = current_setting('app.test_rls30_source')::uuid;
  IF n <> 0 THEN RAISE EXCEPTION 'ss30c: another school''s sync reads the source'; END IF;
  SELECT count(*) INTO n FROM "Users" WHERE "schoolId" = current_setting('app.test_rls30_school')::uuid;
  IF n <> 0 THEN RAISE EXCEPTION 'ss30c: another school''s sync reads % users', n; END IF;
  SELECT count(*) INTO n FROM app.ss12000_source_secrets(current_setting('app.test_rls30_source')::uuid);
  IF n <> 0 THEN RAISE EXCEPTION 'ss30c: another school''s sync reads the credential'; END IF;
  SELECT count(*) INTO n FROM "Ss12000SyncRuns";
  IF n <> 0 THEN RAISE EXCEPTION 'ss30c: another school''s sync reads % runs', n; END IF;
END $$;
SELECT set_config('app.sync_school_id', '', true);
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000006')::text, true);
DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'SCHOOL_ADMIN' OR app.current_school_id() = current_setting('app.test_rls30_school')::uuid THEN
    RAISE EXCEPTION 'ss30c: expected the second school''s admin';
  END IF;
  SELECT count(*) INTO n FROM "Ss12000Sources";
  IF n <> 0 THEN RAISE EXCEPTION 'ss30c: another school''s admin reads % sources', n; END IF;
  SELECT count(*) INTO n FROM "Ss12000SyncRuns";
  IF n <> 0 THEN RAISE EXCEPTION 'ss30c: another school''s admin reads % runs', n; END IF;
  SELECT count(*) INTO n FROM "Ss12000SyncChanges";
  IF n <> 0 THEN RAISE EXCEPTION 'ss30c: another school''s admin reads % changes', n; END IF;
  BEGIN
    PERFORM app.ss12000_set_source_secret(current_setting('app.test_rls30_source')::uuid, 'CLIENT_SECRET', '\x01'::bytea,
                                          decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'), 'abcdef0123456789');
    RAISE EXCEPTION 'ss30c: another school''s admin wrote a credential of this source';
  EXCEPTION WHEN SQLSTATE 'SS404' THEN NULL;
  END;
  SELECT count(*) INTO n FROM app.ss12000_source_secrets(current_setting('app.test_rls30_source')::uuid);
  IF n <> 0 THEN RAISE EXCEPTION 'ss30c: another school''s admin reads this source''s credential'; END IF;
END $$;

-- 30d: a TEACHER, a STUDENT and a GUARDIAN of the school read none of it, and
-- the credential functions refuse them; the admin's read in the same
-- transaction is what makes each zero mean something.
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "Ss12000Sources") + (SELECT count(*) FROM "Ss12000SyncRuns") + (SELECT count(*) FROM "Ss12000SyncChanges")
       + (SELECT count(*) FROM "Ss12000DutyLinks") INTO n;
  IF n < 4 THEN RAISE EXCEPTION 'ss30d: the admin reads only % of the planted rows', n; END IF;
  PERFORM set_config('app.test_rls30_teacher_sub', (SELECT "authId"::text FROM "Users" WHERE "schoolId" = app.current_school_id() AND role = 'TEACHER' AND "isActive" ORDER BY "authId" LIMIT 1), true);
  PERFORM set_config('app.test_rls30_student_sub', (SELECT "authId"::text FROM "Users" WHERE "schoolId" = app.current_school_id() AND role = 'STUDENT' AND "isActive" ORDER BY "authId" LIMIT 1), true);
END $$;
CREATE TEMP TABLE rls30_subs (sub text, role text) ON COMMIT DROP;
INSERT INTO rls30_subs VALUES
  (current_setting('app.test_rls30_teacher_sub'), 'TEACHER'),
  (current_setting('app.test_rls30_student_sub'), 'STUDENT'),
  ('00000000-0000-4000-8000-000000000004', 'GUARDIAN');
DO $$
DECLARE who record; n bigint;
BEGIN
  FOR who IN SELECT sub, role FROM rls30_subs LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', who.sub)::text, true);
    IF app.current_user_role()::text IS DISTINCT FROM who.role THEN RAISE EXCEPTION 'ss30d: expected a %', who.role; END IF;
    SELECT (SELECT count(*) FROM "Ss12000Sources") + (SELECT count(*) FROM "Ss12000SyncRuns") + (SELECT count(*) FROM "Ss12000SyncChanges")
         + (SELECT count(*) FROM "Ss12000DutyLinks") + (SELECT count(*) FROM "GuardianStudentHistory") INTO n;
    IF n <> 0 THEN RAISE EXCEPTION 'ss30d: a % reads % rows of the sync', who.role, n; END IF;
    BEGIN
      PERFORM count(*) FROM app.ss12000_source_secrets(current_setting('app.test_rls30_source')::uuid);
      RAISE EXCEPTION 'ss30d: a % read a credential', who.role;
    EXCEPTION WHEN SQLSTATE 'SS403' THEN NULL;
    END;
    BEGIN
      PERFORM count(*) FROM app.ss12000_source_secret_presence(current_setting('app.test_rls30_source')::uuid);
      RAISE EXCEPTION 'ss30d: a % read which credentials exist', who.role;
    EXCEPTION WHEN SQLSTATE 'SS403' THEN NULL;
    END;
    BEGIN
      PERFORM app.ss12000_clear_source_secrets(current_setting('app.test_rls30_source')::uuid, ARRAY['CLIENT_SECRET']::"Ss12000SecretKind"[]);
      RAISE EXCEPTION 'ss30d: a % cleared a credential', who.role;
    EXCEPTION WHEN SQLSTATE 'SS403' THEN NULL;
    END;
    UPDATE "Ss12000Sources" SET name = 'taken' WHERE id = current_setting('app.test_rls30_source')::uuid;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN RAISE EXCEPTION 'ss30d: a % renamed the source', who.role; END IF;
  END LOOP;
END $$;

-- 30e: an id is an admin's to write — not the v1 import's service principal.
SELECT set_config('request.jwt.claims', '', true);
SELECT set_config('app.service_school_id', current_setting('app.test_rls30_school'), true);
DO $$
DECLARE n bigint;
BEGIN
  UPDATE "Users" SET "firstName" = "firstName" WHERE id = current_setting('app.test_rls30_pupil')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'ss30e: the v1 service principal can no longer update a user (the import)'; END IF;
  BEGIN
    UPDATE "Users" SET "ss12000Id" = 'bbbbbbbb-0000-4000-8000-000000000032' WHERE id = current_setting('app.test_rls30_pupil')::uuid;
    RAISE EXCEPTION 'ss30e: the service principal linked a person';
  EXCEPTION WHEN SQLSTATE 'SS403' THEN NULL;
  END;
  BEGIN
    UPDATE "StudentGroups" SET "ss12000Id" = 'eeeeeeee-0000-4000-8000-000000000032' WHERE id = current_setting('app.test_rls30_group')::uuid;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN RAISE EXCEPTION 'ss30e: the service principal linked a group'; END IF;
  EXCEPTION WHEN SQLSTATE 'SS403' OR insufficient_privilege THEN NULL;
  END;
END $$;
SELECT set_config('app.service_school_id', '', true);
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
DECLARE n bigint;
BEGIN
  UPDATE "Users" SET "ss12000Id" = 'bbbbbbbb-0000-4000-8000-000000000033', "isActive" = true WHERE id = current_setting('app.test_rls30_pupil')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'ss30e: the admin could not link (and reactivate) a person'; END IF;
  BEGIN
    UPDATE "Users" SET "ss12000Id" = 'bbbbbbbb-0000-4000-8000-000000000033'
     WHERE id = (SELECT id FROM "Users" WHERE "schoolId" = app.current_school_id() AND role = 'STUDENT'
                    AND id <> current_setting('app.test_rls30_pupil')::uuid ORDER BY id LIMIT 1);
    RAISE EXCEPTION 'ss30e: one source id was linked to two people';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

-- 30f: a terminal run stays terminal, and its changes carry no person data.
DO $$
DECLARE run uuid := current_setting('app.test_rls30_run')::uuid; n bigint;
BEGIN
  SELECT count(*) INTO n FROM "Ss12000SyncChanges" WHERE "runId" = run AND "after" IS NOT NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'ss30f: the diff holds % changes with a payload before the apply', n; END IF;
  UPDATE "Ss12000SyncRuns" SET status = 'APPLIED', "appliedAt" = now() WHERE id = run;
  SELECT count(*) INTO n FROM "Ss12000SyncChanges" WHERE "runId" = run AND ("before" IS NOT NULL OR "after" IS NOT NULL OR "protectedIdentity");
  IF n <> 0 THEN RAISE EXCEPTION 'ss30f: an applied run kept % payloads', n; END IF;
  SELECT count(*) INTO n FROM "Ss12000SyncChanges" WHERE "runId" = run AND op = 'UPDATE' AND "externalId" IS NOT NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'ss30f: the minimisation lost the op and the id'; END IF;
  BEGIN
    UPDATE "Ss12000SyncRuns" SET status = 'DISCARDED' WHERE id = run;
    RAISE EXCEPTION 'ss30f: a finished run changed status';
  EXCEPTION WHEN SQLSTATE 'SS409' THEN NULL;
  END;
  BEGIN
    UPDATE "Ss12000SyncChanges" SET "after" = '{"email": "x@y.se"}' WHERE "runId" = run;
    RAISE EXCEPTION 'ss30f: a finished run''s change took a payload again';
  EXCEPTION WHEN SQLSTATE 'SS409' THEN NULL;
  END;
  BEGIN
    UPDATE "Ss12000SyncChanges" SET op = 'DEACTIVATE' WHERE "runId" = run;
    RAISE EXCEPTION 'ss30f: a change was rewritten';
  EXCEPTION WHEN SQLSTATE 'SS409' THEN NULL;
  END;
  BEGIN
    DELETE FROM "Ss12000SyncChanges" WHERE "runId" = run;
    RAISE EXCEPTION 'ss30f: the admin deleted a change';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

-- 30g: every unlink is recorded, and only by the trigger.
DO $$
DECLARE g uuid; c uuid; n bigint;
BEGIN
  SELECT gs."guardianId", gs."studentId" INTO g, c FROM "GuardianStudents" gs
    JOIN "Users" u ON u.id = gs."guardianId" WHERE u."authId" = '00000000-0000-4000-8000-000000000004' ORDER BY gs."studentId" LIMIT 1;
  IF g IS NULL THEN RAISE EXCEPTION 'ss30g: the fixture guardian has no link'; END IF;
  DELETE FROM "GuardianStudents" WHERE "guardianId" = g AND "studentId" = c;
  SELECT count(*) INTO n FROM "GuardianStudentHistory"
   WHERE "guardianId" = g AND "studentId" = c AND "unlinkedById" = app.current_user_id() AND origin = 'MANUAL';
  IF n <> 1 THEN RAISE EXCEPTION 'ss30g: the unlink left % history rows naming the admin', n; END IF;
  BEGIN
    INSERT INTO "GuardianStudentHistory" ("schoolId", "guardianId", "studentId", origin, "linkedAt") VALUES (app.current_school_id(), g, c, 'MANUAL', now());
    RAISE EXCEPTION 'ss30g: the API wrote history directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM "GuardianStudentHistory";
    RAISE EXCEPTION 'ss30g: the API deleted history';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

-- 30h: the scheduler's claim, with no principal, across both DST changes in
-- Europe/Stockholm, and the housekeeping of stale and expired runs.
DO $$
BEGIN
  IF (SELECT timezone FROM "Schools" WHERE id = app.current_school_id()) IS DISTINCT FROM 'Europe/Stockholm' THEN
    RAISE EXCEPTION 'ss30h: the DST assertions need a school in Europe/Stockholm';
  END IF;
  UPDATE "Ss12000Sources" SET "scheduleEnabled" = true, "scheduleHourLocal" = 2, "lastScheduledLocalDate" = NULL
   WHERE id = current_setting('app.test_rls30_source')::uuid;
END $$;
SELECT set_config('request.jwt.claims', '', true);
DO $$
DECLARE src uuid := current_setting('app.test_rls30_source')::uuid; n bigint; is_full boolean;
BEGIN
  IF app.current_user_id() IS NOT NULL THEN RAISE EXCEPTION 'ss30h: expected no principal'; END IF;
  -- 2027-03-28 00:30Z is 01:30 CET: before the hour.
  SELECT count(*) INTO n FROM app.ss12000_due_sources(50, '2027-03-28 00:30:00+00') WHERE source_id = src;
  IF n <> 0 THEN RAISE EXCEPTION 'ss30h: claimed before the hour'; END IF;
  -- 01:30Z is 03:30 CEST: 02:00 never happened that night, and ">=" still runs it.
  SELECT count(*), bool_and(full_due) INTO n, is_full FROM app.ss12000_due_sources(50, '2027-03-28 01:30:00+00') WHERE source_id = src;
  IF n <> 1 THEN RAISE EXCEPTION 'ss30h: the spring-forward night was skipped'; END IF;
  IF NOT is_full THEN RAISE EXCEPTION 'ss30h: a source never run fully was not due FULL'; END IF;
  SELECT count(*) INTO n FROM app.ss12000_due_sources(50, '2027-03-28 20:00:00+00') WHERE source_id = src;
  IF n <> 0 THEN RAISE EXCEPTION 'ss30h: claimed twice in one local day'; END IF;
  -- Autumn: 2027-10-31 00:30Z is 02:30 CEST, 01:30Z the repeated 02:30 CET — one run.
  SELECT count(*) INTO n FROM app.ss12000_due_sources(50, '2027-10-31 00:30:00+00') WHERE source_id = src;
  IF n <> 1 THEN RAISE EXCEPTION 'ss30h: the autumn night did not run'; END IF;
  SELECT count(*) INTO n FROM app.ss12000_due_sources(50, '2027-10-31 01:30:00+00') WHERE source_id = src;
  IF n <> 0 THEN RAISE EXCEPTION 'ss30h: the repeated autumn hour ran again'; END IF;
END $$;
SELECT set_config('app.sync_school_id', current_setting('app.test_rls30_school'), true);
DO $$
DECLARE stale uuid; ready uuid;
BEGIN
  INSERT INTO "Ss12000SyncRuns" ("schoolId", "sourceId", "trigger", "mode", "startedAt")
  VALUES (current_setting('app.test_rls30_school')::uuid, current_setting('app.test_rls30_source')::uuid, 'SCHEDULED', 'FULL', now() - interval '1 hour')
  RETURNING id INTO stale;
  PERFORM set_config('app.test_rls30_stale', stale::text, true);
  INSERT INTO "Ss12000SyncRuns" ("schoolId", "sourceId", "trigger", "mode", status, "basisHash", "fetchedAt")
  VALUES (current_setting('app.test_rls30_school')::uuid, current_setting('app.test_rls30_source')::uuid, 'SCHEDULED', 'FULL', 'DIFF_READY', repeat('b', 64), now() - interval '31 days')
  RETURNING id INTO ready;
  PERFORM set_config('app.test_rls30_ready', ready::text, true);
END $$;
SELECT set_config('app.sync_school_id', '', true);
DO $$
DECLARE s integer; e integer;
BEGIN
  SELECT stale, expired INTO s, e FROM app.ss12000_housekeeping();
  IF s < 1 OR e < 1 THEN RAISE EXCEPTION 'ss30h: housekeeping found % stale and % expired runs', s, e; END IF;
END $$;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
BEGIN
  IF (SELECT status::text || ':' || "statusCode" FROM "Ss12000SyncRuns" WHERE id = current_setting('app.test_rls30_stale')::uuid) <> 'FETCH_FAILED:STALE' THEN
    RAISE EXCEPTION 'ss30h: a run a dead process left was not marked STALE';
  END IF;
  IF (SELECT status::text || ':' || "statusCode" FROM "Ss12000SyncRuns" WHERE id = current_setting('app.test_rls30_ready')::uuid) <> 'DISCARDED:EXPIRED' THEN
    RAISE EXCEPTION 'ss30h: a month-old diff was not expired';
  END IF;
END $$;

-- 30i: the catalogue. No arm and no privilege on the credentials; no DELETE
-- privilege for the API on the sync's tables; history read-only; every
-- function SECURITY DEFINER and executable by the API alone.
DO $$
DECLARE bad text; api_role text; fn text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'Ss12000SourceSecrets') THEN RAISE EXCEPTION 'ss30i: the secrets table has an arm'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public."Ss12000SourceSecrets"'::regclass) THEN RAISE EXCEPTION 'ss30i: the secrets table has no RLS'; END IF;
  SELECT string_agg(policyname || ':' || cmd, ',' ORDER BY policyname) INTO bad FROM pg_policies WHERE tablename = 'Ss12000Sources';
  IF bad IS DISTINCT FROM 'ss12000_sources_admin_insert:INSERT,ss12000_sources_admin_select:SELECT,ss12000_sources_admin_update:UPDATE,ss12000_sources_sync_select:SELECT,ss12000_sources_sync_update:UPDATE' THEN
    RAISE EXCEPTION 'ss30i: the source''s arms are % (no service arm, no DELETE)', bad;
  END IF;
  SELECT string_agg(tablename || '.' || policyname, ', ') INTO bad FROM pg_policies
   WHERE coalesce(qual, '') || coalesce(with_check, '') LIKE '%current_sync_school_id()%' AND cmd NOT IN ('SELECT', 'INSERT', 'UPDATE');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'ss30i: the sync may delete through %', bad; END IF;
  FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role', 'app_authenticated') LOOP
    SELECT string_agg(p, ', ') INTO bad
      FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
     WHERE has_table_privilege(api_role, 'public."Ss12000SourceSecrets"', p);
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'ss30i: % holds % on the secrets', api_role, bad; END IF;
    SELECT string_agg(t || ':' || p, ', ') INTO bad
      FROM unnest(ARRAY['Ss12000Sources', 'Ss12000SyncRuns', 'Ss12000SyncChanges', 'Ss12000DutyLinks', 'GuardianStudentHistory']) t,
           unnest(ARRAY['DELETE', 'TRUNCATE']) p
     WHERE has_table_privilege(api_role, format('public.%I', t), p);
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'ss30i: % holds %', api_role, bad; END IF;
    IF has_table_privilege(api_role, 'public."GuardianStudentHistory"', 'INSERT') OR has_table_privilege(api_role, 'public."GuardianStudentHistory"', 'UPDATE') THEN
      RAISE EXCEPTION 'ss30i: % may write guardian history', api_role;
    END IF;
  END LOOP;
  FOREACH fn IN ARRAY ARRAY[
    'app.ss12000_set_source_secret(uuid, "Ss12000SecretKind", bytea, bytea, bytea, text)',
    'app.ss12000_clear_source_secrets(uuid, "Ss12000SecretKind"[])',
    'app.ss12000_source_secrets(uuid)',
    'app.ss12000_source_secret_presence(uuid)',
    'app.ss12000_due_sources(integer, timestamptz)',
    'app.ss12000_housekeeping(timestamptz)'] LOOP
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) AND has_function_privilege(api_role, fn, 'EXECUTE') THEN
        RAISE EXCEPTION 'ss30i: % may call %', api_role, fn;
      END IF;
    END LOOP;
    IF NOT has_function_privilege('app_authenticated', fn, 'EXECUTE') THEN RAISE EXCEPTION 'ss30i: the API may not call %', fn; END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = fn::regprocedure) THEN RAISE EXCEPTION 'ss30i: % is not SECURITY DEFINER', fn; END IF;
  END LOOP;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- 31: the SS12000 v2.0 provider (20261014120000, 20261014130000). Keys carry
-- scopes, the key lookup writes lastUsedAt and nothing else, and a key's
-- webhook signing secret is reachable only through its functions — never by
-- a TEACHER, STUDENT or GUARDIAN, the service principal or an admin reading
-- it back. Versions and tombstones are written by the triggers alone and
-- read by the service principal of their school alone; a future year's group
-- and a DRAFT school's master edit record nothing; the service principal
-- reads the source's organisation ids through app.ss12000_provider_identity
-- and has no arm on the source. A key reads and writes its own subscriptions
-- only, and the delivery claims, settles and stops at a revoked key.
-- Everything planted here is rolled back.
--   31a writes as the admin; 31b what the triggers recorded, read by the
--   service principal; 31c subscriptions per key; 31d TEACHER / STUDENT /
--   GUARDIAN; 31e the delivery; 31f the catalogue.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
SELECT set_config('app.test_rls31_school_b', :'school_b', true);

-- 31a
DO $$
DECLARE
  school uuid := app.current_school_id();
  r uuid; pupil uuid; leaver uuid; fy uuid; fg uuid; k uuid; k2 uuid; master uuid; n bigint; stamped timestamptz;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'SCHOOL_ADMIN' THEN RAISE EXCEPTION 'ss31a: expected the admin'; END IF;
  PERFORM set_config('app.test_rls31_school', school::text, true);

  -- A key's scopes: today's v1 reach by default, the known scopes only.
  INSERT INTO "IntegrationApiKeys" ("schoolId", name, "keyHash") VALUES (school, 'RLS 31 v1', repeat('1', 64)) RETURNING id INTO k;
  IF (SELECT scopes FROM "IntegrationApiKeys" WHERE id = k) IS DISTINCT FROM '{ss12000.v1,ss12000.v1.import}'::text[] THEN
    RAISE EXCEPTION 'ss31a: a key made without scopes did not get today''s v1 reach';
  END IF;
  BEGIN
    UPDATE "IntegrationApiKeys" SET scopes = '{admin.everything}' WHERE id = k;
    RAISE EXCEPTION 'ss31a: an unknown scope was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE "IntegrationApiKeys" SET scopes = '{}' WHERE id = k;
    RAISE EXCEPTION 'ss31a: a key with no scope was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO "IntegrationApiKeys" ("schoolId", name, "keyHash", scopes)
  VALUES (school, 'RLS 31 v2', repeat('2', 64), '{groups.read,rooms.read,subscriptions.write}') RETURNING id INTO k2;
  PERFORM set_config('app.test_rls31_key', k2::text, true);
  PERFORM set_config('app.test_rls31_key_v1', k::text, true);

  -- The signing secret goes in through the function and comes out as presence only.
  stamped := app.integration_key_set_webhook_secret(k2, '\x0102'::bytea, decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'), 'abcdef0123456789');
  IF stamped IS NULL THEN RAISE EXCEPTION 'ss31a: the webhook secret was not stored'; END IF;
  PERFORM app.integration_key_set_webhook_secret(k2, '\x0304'::bytea, decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'), 'abcdef0123456789');
  SELECT count(*) INTO n FROM app.integration_key_webhook_secret_presence() WHERE key_id = k2 AND previous_valid_until > now();
  IF n <> 1 THEN RAISE EXCEPTION 'ss31a: a replaced secret left no 24-hour predecessor'; END IF;
  BEGIN
    PERFORM count(*) FROM app.ss12000_webhook_secrets(k2);
    RAISE EXCEPTION 'ss31a: the admin read a signing secret back';
  EXCEPTION WHEN SQLSTATE 'SS403' THEN NULL;
  END;
  BEGIN
    PERFORM count(*) FROM "IntegrationKeyWebhookSecrets";
    RAISE EXCEPTION 'ss31a: the admin reads the signing secrets table';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM app.integration_key_set_webhook_secret(gen_random_uuid(), '\x01'::bytea, decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'), 'abcdef0123456789');
    RAISE EXCEPTION 'ss31a: a secret was stored for a key the school does not have';
  EXCEPTION WHEN SQLSTATE 'SS404' THEN NULL;
  END;

  -- Writes the triggers must record.
  INSERT INTO "Rooms" ("schoolId", name, "updatedAt") VALUES (school, 'RLS 31 sal', now()) RETURNING id INTO r;
  PERFORM set_config('app.test_rls31_room', r::text, true);
  SELECT id INTO pupil FROM "Users" WHERE "schoolId" = school AND role = 'STUDENT' AND "isActive" AND "ss12000Id" IS NULL ORDER BY id LIMIT 1;
  SELECT id INTO leaver FROM "Users" WHERE "schoolId" = school AND role = 'STUDENT' AND "isActive" AND "ss12000Id" IS NULL AND id <> pupil ORDER BY id LIMIT 1;
  PERFORM set_config('app.test_rls31_pupil', pupil::text, true);
  PERFORM set_config('app.test_rls31_leaver', leaver::text, true);
  UPDATE "Users" SET "ss12000Id" = 'bbbbbbbb-0000-1000-8000-000000000031' WHERE id = pupil;
  UPDATE "Users" SET "isActive" = false WHERE id = leaver;

  -- A future year's group records nothing.
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "updatedAt")
  VALUES (school, 'RLS 31 framtid', '2099-08-01', '2100-06-01', now()) RETURNING id INTO fy;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "updatedAt") VALUES (school, fy, 'RLS 31 F', now()) RETURNING id INTO fg;
  PERFORM set_config('app.test_rls31_future_group', fg::text, true);

  -- A DRAFT school's master edit records nothing.
  SELECT m.id INTO master FROM "MasterLessons" m JOIN "AcademicYears" y ON y.id = m."academicYearId" AND y."isActive"
   WHERE m."schoolId" = school AND NOT m."isParked" ORDER BY m.id LIMIT 1;
  IF master IS NULL THEN RAISE EXCEPTION 'ss31a: the fixtures have no master lesson of the active year'; END IF;
  PERFORM set_config('app.test_rls31_master', master::text, true);
  INSERT INTO "PublicationSettings" ("schoolId", "publishMode") VALUES (school, 'DRAFT')
  ON CONFLICT ("schoolId") DO UPDATE SET "publishMode" = 'DRAFT';
END $$;

-- 31b: what the triggers recorded, as the service principal of the school.
SELECT set_config('request.jwt.claims', '', true);
SELECT set_config('app.service_school_id', current_setting('app.test_rls31_school'), true);
DO $$
DECLARE
  school uuid := current_setting('app.test_rls31_school')::uuid;
  pupil uuid := current_setting('app.test_rls31_pupil')::uuid;
  leaver uuid := current_setting('app.test_rls31_leaver')::uuid;
  master uuid := current_setting('app.test_rls31_master')::uuid;
  before_xid xid8; n bigint; orgs uuid[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Ss12000EntityVersions" WHERE resource = 'Room' AND "entityId" = current_setting('app.test_rls31_room')::uuid) THEN
    RAISE EXCEPTION 'ss31b: a new room has no version';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Ss12000EntityVersions" WHERE resource = 'Person' AND "entityId" = pupil) THEN
    RAISE EXCEPTION 'ss31b: a relinked person has no version';
  END IF;
  -- The relink buried the id the consumer had; the deactivation buried the leaver.
  SELECT count(*) INTO n FROM "Ss12000Tombstones" WHERE resource = 'Person' AND "emittedId" IN (pupil, leaver);
  IF n <> 2 THEN RAISE EXCEPTION 'ss31b: % of the two superseded or deactivated person ids were buried', n; END IF;
  IF EXISTS (SELECT 1 FROM "Ss12000Tombstones" WHERE "emittedId" = 'bbbbbbbb-0000-1000-8000-000000000031') THEN
    RAISE EXCEPTION 'ss31b: the live emitted id was buried';
  END IF;
  -- The relink moved the groups the pupil is listed in.
  SELECT count(*) INTO n FROM "Ss12000EntityVersions" v
   WHERE v.resource = 'Group' AND v."entityId" IN (SELECT e."studentGroupId" FROM "StudentEnrollments" e WHERE e."studentId" = pupil);
  IF n < 1 THEN RAISE EXCEPTION 'ss31b: the relinked pupil''s class did not move'; END IF;
  IF EXISTS (SELECT 1 FROM "Ss12000EntityVersions" WHERE "entityId" = current_setting('app.test_rls31_future_group')::uuid) THEN
    RAISE EXCEPTION 'ss31b: a future year''s group was recorded';
  END IF;
  -- Nothing of another school.
  SELECT count(*) INTO n FROM "Ss12000EntityVersions" WHERE "schoolId" <> school;
  IF n <> 0 THEN RAISE EXCEPTION 'ss31b: the service reads % versions of another school', n; END IF;
  -- The provider identity, and no arm on the source.
  SELECT organisation_ids INTO orgs FROM app.ss12000_provider_identity();
  SELECT count(*) INTO n FROM "Ss12000Sources";
  IF n <> 0 THEN RAISE EXCEPTION 'ss31b: the service principal reads the source''s row'; END IF;
  -- The v2 reads the migration added: its own school only.
  SELECT count(*) INTO n FROM "StudentEnrollments" WHERE "schoolId" <> school;
  IF n <> 0 THEN RAISE EXCEPTION 'ss31b: the service reads another school''s class history'; END IF;
  SELECT count(*) INTO n FROM "StudentEnrollments";
  IF n = 0 THEN RAISE EXCEPTION 'ss31b: the service reads no class history of its own school'; END IF;
  SELECT count(*) INTO n FROM "StudentGroupMembers" WHERE "schoolId" <> school;
  IF n <> 0 THEN RAISE EXCEPTION 'ss31b: the service reads another school''s teaching groups'; END IF;
  -- Direct writes are refused, by privilege before the guard.
  BEGIN
    INSERT INTO "Ss12000EntityVersions" ("schoolId", resource, "entityId") VALUES (school, 'Room', gen_random_uuid());
    RAISE EXCEPTION 'ss31b: the API wrote a version';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM "Ss12000Tombstones";
    RAISE EXCEPTION 'ss31b: the API deleted tombstones';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    TRUNCATE "Ss12000EntityVersions";
    RAISE EXCEPTION 'ss31b: the API truncated the versions';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM set_config('app.test_rls31_master_xid', coalesce((SELECT xid::text FROM "Ss12000EntityVersions" WHERE resource = 'Activity' AND "entityId" = master), ''), true);
END $$;
SELECT set_config('app.service_school_id', '', true);

-- A DRAFT school's master edit, by the admin: no Activity version moves.
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
UPDATE "MasterLessons" SET "endDate" = NULL, "startDate" = "startDate" WHERE id = current_setting('app.test_rls31_master')::uuid;
UPDATE "MasterLessons" SET "isParked" = true WHERE id = current_setting('app.test_rls31_master')::uuid;
SELECT set_config('request.jwt.claims', '', true);
SELECT set_config('app.service_school_id', current_setting('app.test_rls31_school'), true);
DO $$
DECLARE master uuid := current_setting('app.test_rls31_master')::uuid;
BEGIN
  IF coalesce((SELECT xid::text FROM "Ss12000EntityVersions" WHERE resource = 'Activity' AND "entityId" = master), '')
     IS DISTINCT FROM current_setting('app.test_rls31_master_xid') THEN
    RAISE EXCEPTION 'ss31b: a DRAFT school''s master edit moved the activity''s version';
  END IF;
  IF EXISTS (SELECT 1 FROM "Ss12000Tombstones" WHERE resource = 'Activity' AND "emittedId" = master) THEN
    RAISE EXCEPTION 'ss31b: parking a DRAFT school''s master buried a published activity';
  END IF;
END $$;

-- 31c: subscriptions, per key.
SELECT set_config('app.service_key_id', current_setting('app.test_rls31_key'), true);
DO $$
DECLARE school uuid := current_setting('app.test_rls31_school')::uuid; k uuid := current_setting('app.test_rls31_key')::uuid; s uuid; n bigint;
BEGIN
  IF NOT app.ss12000_webhook_secret_exists() THEN RAISE EXCEPTION 'ss31c: the key''s secret is not seen as present'; END IF;
  INSERT INTO "Ss12000Subscriptions" ("schoolId", "keyId", name, target, "resourceTypes")
  VALUES (school, k, 'RLS 31', 'https://hooks.example.invalid/ss12000?x=1', '{Room,Group}') RETURNING id INTO s;
  PERFORM set_config('app.test_rls31_subscription', s::text, true);
  BEGIN
    INSERT INTO "Ss12000Subscriptions" ("schoolId", "keyId", name, target, "resourceTypes")
    VALUES (school, current_setting('app.test_rls31_key_v1')::uuid, 'other key', 'https://hooks.example.invalid/', '{Room}');
    RAISE EXCEPTION 'ss31c: a key made a subscription for another key';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO "Ss12000Subscriptions" ("schoolId", "keyId", name, target, "resourceTypes") VALUES (school, k, 'x', 'http://hooks.example.invalid/', '{Room}');
    RAISE EXCEPTION 'ss31c: an http target was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "Ss12000Subscriptions" ("schoolId", "keyId", name, target, "resourceTypes") VALUES (school, k, 'x', 'https://hooks.example.invalid/', '{Absence}');
    RAISE EXCEPTION 'ss31c: a resource the provider does not emit was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE "Ss12000Subscriptions" SET target = 'https://elsewhere.example.invalid/' WHERE id = s;
    RAISE EXCEPTION 'ss31c: a key rewrote its subscription''s target';
  EXCEPTION WHEN SQLSTATE 'SS403' THEN NULL;
  END;
  UPDATE "Ss12000Subscriptions" SET "expiresAt" = now() + interval '30 days' WHERE id = s;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'ss31c: a key could not renew its subscription'; END IF;
END $$;
SELECT set_config('app.service_key_id', current_setting('app.test_rls31_key_v1'), true);
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "Ss12000Subscriptions";
  IF n <> 0 THEN RAISE EXCEPTION 'ss31c: another key reads % subscriptions', n; END IF;
  UPDATE "Ss12000Subscriptions" SET "endedAt" = now() WHERE id = current_setting('app.test_rls31_subscription')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'ss31c: another key ended a subscription'; END IF;
  IF app.ss12000_webhook_secret_exists() THEN RAISE EXCEPTION 'ss31c: a key without a secret is told it has one'; END IF;
END $$;
SELECT set_config('app.service_key_id', '', true);
SELECT set_config('app.service_school_id', current_setting('app.test_rls31_school_b'), true);
DO $$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "Ss12000EntityVersions" WHERE "schoolId" = current_setting('app.test_rls31_school')::uuid)
       + (SELECT count(*) FROM "Ss12000Tombstones" WHERE "schoolId" = current_setting('app.test_rls31_school')::uuid)
       + (SELECT count(*) FROM "Ss12000Subscriptions") INTO n;
  IF n <> 0 THEN RAISE EXCEPTION 'ss31c: another school''s service principal reads % of these rows', n; END IF;
END $$;
SELECT set_config('app.service_school_id', '', true);

-- 31d: TEACHER, STUDENT and GUARDIAN read none of it and reach no secret.
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
BEGIN
  IF (SELECT count(*) FROM "Ss12000Subscriptions") < 1 THEN RAISE EXCEPTION 'ss31d: the admin reads no subscription'; END IF;
  PERFORM set_config('app.test_rls31_teacher_sub', (SELECT "authId"::text FROM "Users" WHERE "schoolId" = app.current_school_id() AND role = 'TEACHER' AND "isActive" ORDER BY "authId" LIMIT 1), true);
  PERFORM set_config('app.test_rls31_student_sub', (SELECT "authId"::text FROM "Users" WHERE "schoolId" = app.current_school_id() AND role = 'STUDENT' AND "isActive" ORDER BY "authId" LIMIT 1), true);
END $$;
CREATE TEMP TABLE rls31_subs (sub text, role text) ON COMMIT DROP;
INSERT INTO rls31_subs VALUES
  (current_setting('app.test_rls31_teacher_sub'), 'TEACHER'),
  (current_setting('app.test_rls31_student_sub'), 'STUDENT'),
  ('00000000-0000-4000-8000-000000000004', 'GUARDIAN');
DO $$
DECLARE who record; n bigint;
BEGIN
  FOR who IN SELECT sub, role FROM rls31_subs LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', who.sub)::text, true);
    IF app.current_user_role()::text IS DISTINCT FROM who.role THEN RAISE EXCEPTION 'ss31d: expected a %', who.role; END IF;
    SELECT (SELECT count(*) FROM "Ss12000Subscriptions") + (SELECT count(*) FROM "Ss12000SubscriptionDeliveries")
         + (SELECT count(*) FROM "Ss12000EntityVersions") + (SELECT count(*) FROM "Ss12000Tombstones") INTO n;
    IF n <> 0 THEN RAISE EXCEPTION 'ss31d: a % reads % provider rows', who.role, n; END IF;
    BEGIN
      PERFORM count(*) FROM app.ss12000_webhook_secrets(current_setting('app.test_rls31_key')::uuid);
      RAISE EXCEPTION 'ss31d: a % read a signing secret', who.role;
    EXCEPTION WHEN SQLSTATE 'SS403' THEN NULL;
    END;
    BEGIN
      PERFORM count(*) FROM app.integration_key_webhook_secret_presence();
      RAISE EXCEPTION 'ss31d: a % read which keys can sign', who.role;
    EXCEPTION WHEN SQLSTATE 'SS403' THEN NULL;
    END;
    BEGIN
      PERFORM count(*) FROM app.ss12000_due_notifications(10);
      RAISE EXCEPTION 'ss31d: a % claimed notices', who.role;
    EXCEPTION WHEN SQLSTATE 'SS403' THEN NULL;
    END;
  END LOOP;
END $$;

-- The service principal reaches no secret either.
SELECT set_config('request.jwt.claims', '', true);
SELECT set_config('app.service_school_id', current_setting('app.test_rls31_school'), true);
DO $$
BEGIN
  BEGIN
    PERFORM count(*) FROM app.ss12000_webhook_secrets(current_setting('app.test_rls31_key')::uuid);
    RAISE EXCEPTION 'ss31d: the service principal read a signing secret';
  EXCEPTION WHEN SQLSTATE 'SS403' THEN NULL;
  END;
END $$;
SELECT set_config('app.service_school_id', '', true);

-- 31e: the delivery, with no principal at all.
DO $$
DECLARE d record; n bigint; verdict text; secret_rows bigint;
BEGIN
  IF app.current_user_id() IS NOT NULL THEN RAISE EXCEPTION 'ss31e: expected no principal'; END IF;
  SELECT count(*) INTO secret_rows FROM app.ss12000_webhook_secrets(current_setting('app.test_rls31_key')::uuid) WHERE previous_ciphertext IS NOT NULL;
  IF secret_rows <> 1 THEN RAISE EXCEPTION 'ss31e: the delivery did not get the current and the previous secret'; END IF;
  -- The room this transaction made is a change below no horizon yet (this
  -- transaction is still running): nothing is due until it commits.
  SELECT count(*) INTO n FROM app.ss12000_due_notifications(10) WHERE subscription_id = current_setting('app.test_rls31_subscription')::uuid;
  IF n <> 0 THEN RAISE EXCEPTION 'ss31e: a notice was claimed for a change not yet committed'; END IF;
  verdict := app.ss12000_notification_settled(current_setting('app.test_rls31_subscription')::uuid, false, 500, 'HTTP_500', '1', 12, now() + interval '1 minute');
  IF verdict <> 'RETRY' THEN RAISE EXCEPTION 'ss31e: a failed delivery settled as %', verdict; END IF;
  SELECT count(*) INTO n FROM "Ss12000SubscriptionDeliveries";
  IF n <> 0 THEN RAISE EXCEPTION 'ss31e: no principal reads delivery rows directly'; END IF;
END $$;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
BEGIN
  IF (SELECT attempts FROM "Ss12000Subscriptions" WHERE id = current_setting('app.test_rls31_subscription')::uuid) <> 1 THEN
    RAISE EXCEPTION 'ss31e: the failed attempt was not counted';
  END IF;
  IF (SELECT count(*) FROM "Ss12000SubscriptionDeliveries" WHERE "subscriptionId" = current_setting('app.test_rls31_subscription')::uuid AND outcome = 'HTTP_500') <> 1 THEN
    RAISE EXCEPTION 'ss31e: the admin does not see the attempt';
  END IF;
  -- The school pauses it; a key cannot lift the school's pause.
  UPDATE "Ss12000Subscriptions" SET "suspendedAt" = now(), "suspendedReason" = 'ADMIN' WHERE id = current_setting('app.test_rls31_subscription')::uuid;
  BEGIN
    UPDATE "Ss12000Subscriptions" SET name = 'renamed' WHERE id = current_setting('app.test_rls31_subscription')::uuid;
    RAISE EXCEPTION 'ss31e: the admin renamed a key''s subscription';
  EXCEPTION WHEN SQLSTATE 'SS403' THEN NULL;
  END;
  -- A revoked key's subscriptions are never claimed.
  UPDATE "IntegrationApiKeys" SET "revokedAt" = now() WHERE id = current_setting('app.test_rls31_key')::uuid;
END $$;
SELECT set_config('request.jwt.claims', '', true);
SELECT set_config('app.service_school_id', current_setting('app.test_rls31_school'), true);
SELECT set_config('app.service_key_id', current_setting('app.test_rls31_key'), true);
DO $$
BEGIN
  BEGIN
    UPDATE "Ss12000Subscriptions" SET "suspendedAt" = NULL, "suspendedReason" = NULL WHERE id = current_setting('app.test_rls31_subscription')::uuid;
    RAISE EXCEPTION 'ss31e: a key lifted the school''s pause';
  EXCEPTION WHEN SQLSTATE 'SS403' THEN NULL;
  END;
END $$;
SELECT set_config('app.service_key_id', '', true);
SELECT set_config('app.service_school_id', '', true);
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM app.ss12000_webhook_secrets(current_setting('app.test_rls31_key')::uuid);
  IF n <> 0 THEN RAISE EXCEPTION 'ss31e: a revoked key''s secret is still handed out'; END IF;
END $$;

-- 31f: the catalogue, and the key lookup's narrow write.
SELECT set_config('app.service_key_lookup', 'on', true);
DO $$
DECLARE n bigint;
BEGIN
  UPDATE "IntegrationApiKeys" SET "lastUsedAt" = now() WHERE id = current_setting('app.test_rls31_key_v1')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'ss31f: the lookup can no longer stamp lastUsedAt'; END IF;
  BEGIN
    UPDATE "IntegrationApiKeys" SET scopes = '{ss12000.v1,persons.read}' WHERE id = current_setting('app.test_rls31_key_v1')::uuid;
    RAISE EXCEPTION 'ss31f: the key lookup widened a key''s scopes';
  EXCEPTION WHEN SQLSTATE 'SS403' THEN NULL;
  END;
END $$;
SELECT set_config('app.service_key_lookup', '', true);
DO $$
DECLARE bad text; api_role text; fn text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'IntegrationKeyWebhookSecrets') THEN RAISE EXCEPTION 'ss31f: the signing secrets have an arm'; END IF;
  SELECT string_agg(policyname, ',' ORDER BY policyname) INTO bad FROM pg_policies WHERE tablename IN ('Ss12000EntityVersions', 'Ss12000Tombstones');
  IF bad IS DISTINCT FROM 'ss12000_entity_versions_service_select,ss12000_tombstones_service_select' THEN
    RAISE EXCEPTION 'ss31f: versions and tombstones have the arms %', bad;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'Ss12000Sources' AND coalesce(qual, '') || coalesce(with_check, '') LIKE '%current_service_school_id()%') THEN
    RAISE EXCEPTION 'ss31f: the service principal has an arm on the source';
  END IF;
  FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role', 'app_authenticated') LOOP
    SELECT string_agg(p, ', ') INTO bad
      FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
     WHERE has_table_privilege(api_role, 'public."IntegrationKeyWebhookSecrets"', p);
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'ss31f: % holds % on the signing secrets', api_role, bad; END IF;
    SELECT string_agg(t || ':' || p, ', ') INTO bad
      FROM unnest(ARRAY['Ss12000EntityVersions', 'Ss12000Tombstones', 'Ss12000Subscriptions', 'Ss12000SubscriptionDeliveries']) t,
           unnest(ARRAY['DELETE', 'TRUNCATE']) p
     WHERE has_table_privilege(api_role, format('public.%I', t), p);
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'ss31f: % holds %', api_role, bad; END IF;
    SELECT string_agg(t || ':' || p, ', ') INTO bad
      FROM unnest(ARRAY['Ss12000EntityVersions', 'Ss12000Tombstones', 'Ss12000SubscriptionDeliveries']) t,
           unnest(ARRAY['INSERT', 'UPDATE']) p
     WHERE has_table_privilege(api_role, format('public.%I', t), p);
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'ss31f: % may write %', api_role, bad; END IF;
  END LOOP;
  FOREACH fn IN ARRAY ARRAY[
    'app.integration_key_set_webhook_secret(uuid, bytea, bytea, bytea, text)',
    'app.integration_key_webhook_secret_presence()',
    'app.ss12000_webhook_secrets(uuid)',
    'app.ss12000_webhook_secret_exists()',
    'app.ss12000_provider_identity()',
    'app.ss12000_due_notifications(integer)',
    'app.ss12000_notification_settled(uuid, boolean, integer, text, text, integer, timestamptz)',
    'app.ss12000_provider_housekeeping(timestamptz)'] LOOP
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) AND has_function_privilege(api_role, fn, 'EXECUTE') THEN
        RAISE EXCEPTION 'ss31f: % may call %', api_role, fn;
      END IF;
    END LOOP;
    IF NOT has_function_privilege('app_authenticated', fn, 'EXECUTE') THEN RAISE EXCEPTION 'ss31f: the API may not call %', fn; END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = fn::regprocedure) THEN RAISE EXCEPTION 'ss31f: % is not SECURITY DEFINER', fn; END IF;
  END LOOP;
  -- The recorders: nobody calls them but the triggers.
  FOREACH fn IN ARRAY ARRAY['app.ss12000_bump(uuid, text, uuid[])', 'app.ss12000_bury(uuid, text, uuid[])', 'app.ss12000_unbury(uuid, text, uuid[])', 'app.ss12000_bump_school(uuid)'] LOOP
    IF has_function_privilege('app_authenticated', fn, 'EXECUTE') THEN RAISE EXCEPTION 'ss31f: the API may call %', fn; END IF;
  END LOOP;
  -- Statement triggers without column lists, three events at most per table.
  SELECT count(*) INTO bad FROM pg_trigger WHERE tgname LIKE '%_ss12000_versions_%' AND NOT tgisinternal AND tgattr::text <> '';
  IF bad::int <> 0 THEN RAISE EXCEPTION 'ss31f: % version triggers name columns', bad; END IF;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 32: ledighetsansökningar (LeaveRequests, 20260713170100 and
-- 20261015090000).
--
-- A request's reason is what a family wrote to the school: a trip, but also a
-- funeral, a hospital visit or a hearing. The admin who decides reads it, and
-- so do the pupil's guardians and the pupil. No TEACHER reads any row of the
-- table, not even the pupil's mentor, by any role or join: a teacher learns of
-- granted leave from the full-day AbsenceReports the decision writes, and only
-- as app.reported_absences answers them (20261015120000): the pupil and the
-- times, never the reason, which attendance shows as Anmäld frånvaro. Web
-- and mobile read the table straight through PostgREST, so the
-- teacher and the guardian are asserted under `authenticated` as well as under
-- the API's role.
-- ---------------------------------------------------------------------------

BEGIN;
-- 32a: the second school's request, written by its own admin.
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000006')::text, true);
DO $$
DECLARE pupil uuid;
BEGIN
  SELECT id INTO pupil FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000002';
  IF pupil IS NULL THEN RAISE EXCEPTION 'leave: the second school has no pupil to plant on'; END IF;
  INSERT INTO "LeaveRequests" ("schoolId", "studentId", "requestedById", "startDate", "endDate", reason)
  VALUES (app.current_school_id(), pupil, app.current_user_id(), DATE '2095-05-04', DATE '2095-05-05', 'rls32 b-skolans anledning');
END $$;

-- 32b: the primary school's admin files two requests, one of them approved
-- with the absence the decision writes, makes a teacher the mentor of the
-- guardian's child, and reads every reason of the school and none of another.
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
DECLARE
  school uuid := app.current_school_id();
  me uuid := app.current_user_id();
  child uuid; class uuid; other uuid; teacher uuid; n bigint; r text;
BEGIN
  SELECT gs."studentId" INTO child FROM "GuardianStudents" gs JOIN "Users" g ON g.id = gs."guardianId"
   WHERE g."authId" = '00000000-0000-4000-8000-000000000004' ORDER BY gs."studentId" LIMIT 1;
  SELECT "studentGroupId" INTO class FROM "Users" WHERE id = child;
  SELECT id INTO other FROM "Users" WHERE "schoolId" = school AND role = 'STUDENT' AND "isActive" AND id <> child ORDER BY id LIMIT 1;
  SELECT id INTO teacher FROM "Users" WHERE "schoolId" = school AND role = 'TEACHER' AND "isActive" AND "authId" IS NOT NULL ORDER BY "authId" LIMIT 1;
  IF child IS NULL OR class IS NULL OR other IS NULL OR teacher IS NULL THEN
    RAISE EXCEPTION 'leave: the primary school lacks the guardian''s child with a class, another pupil or a teacher';
  END IF;
  IF (SELECT "authId" FROM "Users" WHERE id = child) IS NULL THEN RAISE EXCEPTION 'leave: the guardian''s child cannot sign in'; END IF;

  INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "studentGroupId", "updatedAt")
  SELECT school, teacher, g."academicYearId", 'MENTORSKAP', 'Mentor rls32', 60, g.id, now() FROM "StudentGroups" g WHERE g.id = class;

  INSERT INTO "LeaveRequests" ("schoolId", "studentId", "requestedById", "startDate", "endDate", reason, status, "decidedById", "decidedAt")
  VALUES (school, other, me, DATE '2095-05-04', DATE '2095-05-04', 'rls32 begravning', 'APPROVED', me, now());
  INSERT INTO "AbsenceReports" ("schoolId", "studentId", "reportedById", date, type, note)
  VALUES (school, other, me, DATE '2095-05-04', 'OTHER', 'Approved leave');
  INSERT INTO "LeaveRequests" ("schoolId", "studentId", "requestedById", "startDate", "endDate", reason)
  VALUES (school, child, me, DATE '2095-05-11', DATE '2095-05-12', 'rls32 läkarbesök');

  SELECT reason INTO r FROM "LeaveRequests" WHERE "studentId" = other AND reason LIKE 'rls32 %';
  IF r IS DISTINCT FROM 'rls32 begravning' THEN RAISE EXCEPTION 'leave: the admin reads the reason %', coalesce(r, 'NULL'); END IF;
  SELECT count(*) INTO n FROM "LeaveRequests" WHERE reason LIKE 'rls32 %';
  IF n <> 2 THEN RAISE EXCEPTION 'leave: the admin reads % of the school''s two requests', n; END IF;
  SELECT count(*) INTO n FROM "LeaveRequests" WHERE "schoolId" <> school;
  IF n <> 0 THEN RAISE EXCEPTION 'leave: the admin reads % request(s) of another school', n; END IF;

  PERFORM set_config('app.test_rls32_child', child::text, true);
  PERFORM set_config('app.test_rls32_other', other::text, true);
  PERFORM set_config('app.test_rls32_child_sub', (SELECT "authId"::text FROM "Users" WHERE id = child), true);
  PERFORM set_config('app.test_rls32_teacher_sub', (SELECT "authId"::text FROM "Users" WHERE id = teacher), true);
END $$;

-- 32c: the guardian files a request through PostgREST's role, as the app
-- does, and reads both of their child's requests with the reason, under
-- either role, and nobody else's.
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000004')::text, true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE child uuid := current_setting('app.test_rls32_child')::uuid; n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'GUARDIAN' THEN RAISE EXCEPTION 'leave: expected the GUARDIAN'; END IF;
  INSERT INTO "LeaveRequests" ("schoolId", "studentId", "requestedById", "startDate", "endDate", reason)
  VALUES (app.current_school_id(), child, app.current_user_id(), DATE '2095-05-18', DATE '2095-05-22', 'rls32 familjeresa');
  SELECT count(*) INTO n FROM "LeaveRequests" WHERE "studentId" = child AND reason IN ('rls32 läkarbesök', 'rls32 familjeresa');
  IF n <> 2 THEN RAISE EXCEPTION 'leave: through PostgREST''s role the guardian reads % of their child''s two requests', n; END IF;
  SELECT count(*) INTO n FROM "LeaveRequests" WHERE "studentId" <> child;
  IF n <> 0 THEN RAISE EXCEPTION 'leave: through PostgREST''s role the guardian reads % request(s) of another pupil', n; END IF;
END $$;
SET LOCAL ROLE app_authenticated;
DO $$
DECLARE child uuid := current_setting('app.test_rls32_child')::uuid; n bigint;
BEGIN
  SELECT count(*) INTO n FROM "LeaveRequests" WHERE "studentId" = child AND reason IN ('rls32 läkarbesök', 'rls32 familjeresa');
  IF n <> 2 THEN RAISE EXCEPTION 'leave: the guardian reads % of their child''s two requests', n; END IF;
  SELECT count(*) INTO n FROM "LeaveRequests" WHERE "studentId" <> child;
  IF n <> 0 THEN RAISE EXCEPTION 'leave: the guardian reads % request(s) of another pupil', n; END IF;
END $$;

-- 32d: the pupil reads their own two requests and nobody else's.
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls32_child_sub'))::text, true);
DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'STUDENT' THEN RAISE EXCEPTION 'leave: expected the STUDENT'; END IF;
  SELECT count(*) INTO n FROM "LeaveRequests" WHERE "studentId" = app.current_user_id() AND reason LIKE 'rls32 %';
  IF n <> 2 THEN RAISE EXCEPTION 'leave: the pupil reads % of their own two requests', n; END IF;
  SELECT count(*) INTO n FROM "LeaveRequests" WHERE "studentId" <> app.current_user_id();
  IF n <> 0 THEN RAISE EXCEPTION 'leave: the pupil reads % request(s) of somebody else', n; END IF;
END $$;

-- 32e: the child's mentor reads no request and no reason, by a count, a join
-- or a subselect, under the API's role or PostgREST's, and writes none. What
-- they do learn is the approved leave's absence, through app.reported_absences
-- (20261015120000), which names the pupil and no reason.
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls32_teacher_sub'))::text, true);
DO $$
DECLARE
  child uuid := current_setting('app.test_rls32_child')::uuid;
  other uuid := current_setting('app.test_rls32_other')::uuid;
  n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'TEACHER' THEN RAISE EXCEPTION 'leave: expected a TEACHER'; END IF;
  SELECT count(*) INTO n FROM "TeacherDuties" WHERE "userId" = app.current_user_id() AND kind = 'MENTORSKAP' AND label = 'Mentor rls32';
  IF n <> 1 THEN RAISE EXCEPTION 'leave: the teacher is not the child''s mentor, so the case proves less than it says'; END IF;
  SELECT count(*) INTO n FROM "LeaveRequests";
  IF n <> 0 THEN RAISE EXCEPTION 'leave: a teacher reads % leave request(s)', n; END IF;
  SELECT count(*) INTO n FROM "LeaveRequests" WHERE reason IS NOT NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'leave: a teacher reads % reason(s)', n; END IF;
  SELECT count(*) INTO n FROM "AbsenceReports" a JOIN "LeaveRequests" l ON l."studentId" = a."studentId";
  IF n <> 0 THEN RAISE EXCEPTION 'leave: a teacher reaches % request(s) through an absence', n; END IF;
  SELECT count(*) INTO n FROM "AbsenceReports" a
   WHERE EXISTS (SELECT 1 FROM "LeaveRequests" l WHERE l."studentId" = a."studentId" AND l.reason LIKE 'rls32 %');
  IF n <> 0 THEN RAISE EXCEPTION 'leave: a teacher learns who asked for leave through a subselect'; END IF;
  UPDATE "LeaveRequests" SET status = 'APPROVED' WHERE "studentId" = child;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'leave: a teacher decided % request(s)', n; END IF;
  BEGIN
    INSERT INTO "LeaveRequests" ("schoolId", "studentId", "requestedById", "startDate", "endDate", reason)
    VALUES (app.current_school_id(), child, app.current_user_id(), DATE '2095-05-25', DATE '2095-05-25', 'rls32 lärarens');
    RAISE EXCEPTION 'leave: a teacher filed a leave request';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  SELECT count(*) INTO n FROM "AbsenceReports";
  IF n <> 0 THEN RAISE EXCEPTION 'leave: a teacher reads % absence report(s) directly', n; END IF;
  SELECT count(*) INTO n FROM app.reported_absences(DATE '2095-05-04') WHERE "studentId" = other AND "startTime" IS NULL AND "endTime" IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'leave: a teacher learns % full-day absence(s) of the approved leave, not its one', n; END IF;
END $$;
SET LOCAL ROLE authenticated;
DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'TEACHER' THEN RAISE EXCEPTION 'leave: expected a TEACHER'; END IF;
  SELECT count(*) INTO n FROM "LeaveRequests";
  IF n <> 0 THEN RAISE EXCEPTION 'leave: through PostgREST''s role a teacher reads % leave request(s)', n; END IF;
  SELECT count(*) INTO n FROM "AbsenceReports" a
   WHERE EXISTS (SELECT 1 FROM "LeaveRequests" l WHERE l."studentId" = a."studentId");
  IF n <> 0 THEN RAISE EXCEPTION 'leave: through PostgREST''s role a teacher learns who asked for leave through a subselect'; END IF;
END $$;
SET LOCAL ROLE app_authenticated;

-- 32f: the catalogue. Exactly these arms; the pupil's own insert is section
-- 34's, and the mentor's decision on the roadmap adds its own here, as a
-- decision, not as a staff-wide read.
DO $$
DECLARE arms text;
BEGIN
  SELECT string_agg(policyname, ',' ORDER BY policyname) INTO arms
    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'LeaveRequests';
  IF arms IS DISTINCT FROM 'leave_requests_admin_all,leave_requests_guardian_insert,leave_requests_guardian_select,leave_requests_student_insert,leave_requests_student_select' THEN
    RAISE EXCEPTION 'leave: the arms on LeaveRequests are %', arms;
  END IF;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 33: frånvaroanmälningar (AbsenceReports, 20260713170100 and
-- 20261015120000).
--
-- A report's note is what a family wrote to the school when the pupil stayed
-- home: a fever, but also a hospital visit, a funeral or something at home.
-- Its type says SICK, APPOINTMENT or OTHER. The admin reads both, and so do the
-- pupil's guardians and the pupil. No TEACHER reads any row of the table, by
-- any role, count, join or subselect. What attendance needs, who was reported
-- absent on a day and between which times, a TEACHER asks of
-- app.reported_absences, which answers those three columns and is the API's
-- alone. Web and mobile read the table straight through PostgREST, so the
-- teacher and the guardian are asserted under `authenticated` as well as under
-- the API's role.
-- ---------------------------------------------------------------------------

BEGIN;
-- 33a: the second school's report, written by its own admin on the same day.
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000006')::text, true);
DO $$
DECLARE pupil uuid;
BEGIN
  SELECT id INTO pupil FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000002';
  IF pupil IS NULL THEN RAISE EXCEPTION 'absence: the second school has no pupil to plant on'; END IF;
  INSERT INTO "AbsenceReports" ("schoolId", "studentId", "reportedById", date, type, note)
  VALUES (app.current_school_id(), pupil, app.current_user_id(), DATE '2095-06-01', 'SICK', 'rls33 b-skolans anteckning');
END $$;

-- 33b: the primary school's admin reports another pupil away for a morning,
-- and reads every note of the school and none of another.
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
DECLARE
  school uuid := app.current_school_id();
  child uuid; other uuid; teacher uuid; n bigint; r text;
BEGIN
  SELECT gs."studentId" INTO child FROM "GuardianStudents" gs JOIN "Users" g ON g.id = gs."guardianId"
   WHERE g."authId" = '00000000-0000-4000-8000-000000000004' ORDER BY gs."studentId" LIMIT 1;
  SELECT id INTO other FROM "Users" WHERE "schoolId" = school AND role = 'STUDENT' AND "isActive" AND id <> child ORDER BY id LIMIT 1;
  SELECT id INTO teacher FROM "Users" WHERE "schoolId" = school AND role = 'TEACHER' AND "isActive" AND "authId" IS NOT NULL ORDER BY "authId" LIMIT 1;
  IF child IS NULL OR other IS NULL OR teacher IS NULL THEN
    RAISE EXCEPTION 'absence: the primary school lacks the guardian''s child, another pupil or a teacher';
  END IF;
  IF (SELECT "authId" FROM "Users" WHERE id = child) IS NULL THEN RAISE EXCEPTION 'absence: the guardian''s child cannot sign in'; END IF;

  INSERT INTO "AbsenceReports" ("schoolId", "studentId", "reportedById", date, "startTime", "endTime", type, note)
  VALUES (school, other, app.current_user_id(), DATE '2095-06-01', TIME '08:00', TIME '10:00', 'APPOINTMENT', 'rls33 läkarbesök');

  SELECT note INTO r FROM "AbsenceReports" WHERE "studentId" = other AND date = DATE '2095-06-01';
  IF r IS DISTINCT FROM 'rls33 läkarbesök' THEN RAISE EXCEPTION 'absence: the admin reads the note %', coalesce(r, 'NULL'); END IF;
  SELECT count(*) INTO n FROM "AbsenceReports" WHERE "schoolId" <> school;
  IF n <> 0 THEN RAISE EXCEPTION 'absence: the admin reads % report(s) of another school', n; END IF;

  PERFORM set_config('app.test_rls33_child', child::text, true);
  PERFORM set_config('app.test_rls33_other', other::text, true);
  PERFORM set_config('app.test_rls33_child_sub', (SELECT "authId"::text FROM "Users" WHERE id = child), true);
  PERFORM set_config('app.test_rls33_teacher_sub', (SELECT "authId"::text FROM "Users" WHERE id = teacher), true);
END $$;

-- 33c: the guardian reports their child sick through PostgREST's role, as the
-- app does, and reads the report with its note under either role, and nobody
-- else's. They cannot call the teacher's function, and under the API's role it
-- answers them nothing.
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000004')::text, true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE child uuid := current_setting('app.test_rls33_child')::uuid; n bigint; r text;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'GUARDIAN' THEN RAISE EXCEPTION 'absence: expected the GUARDIAN'; END IF;
  INSERT INTO "AbsenceReports" ("schoolId", "studentId", "reportedById", date, type, note)
  VALUES (app.current_school_id(), child, app.current_user_id(), DATE '2095-06-01', 'SICK', 'rls33 feber');
  SELECT note INTO r FROM "AbsenceReports" WHERE "studentId" = child AND date = DATE '2095-06-01';
  IF r IS DISTINCT FROM 'rls33 feber' THEN RAISE EXCEPTION 'absence: through PostgREST''s role the guardian reads the note %', coalesce(r, 'NULL'); END IF;
  SELECT count(*) INTO n FROM "AbsenceReports" WHERE "studentId" <> child;
  IF n <> 0 THEN RAISE EXCEPTION 'absence: through PostgREST''s role the guardian reads % report(s) of another pupil', n; END IF;
  BEGIN
    PERFORM app.reported_absences(DATE '2095-06-01');
    RAISE EXCEPTION 'absence: authenticated may call app.reported_absences';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
SET LOCAL ROLE app_authenticated;
DO $$
DECLARE child uuid := current_setting('app.test_rls33_child')::uuid; n bigint;
BEGIN
  SELECT count(*) INTO n FROM "AbsenceReports" WHERE "studentId" = child AND note = 'rls33 feber' AND type = 'SICK';
  IF n <> 1 THEN RAISE EXCEPTION 'absence: the guardian reads % of their child''s one report', n; END IF;
  SELECT count(*) INTO n FROM "AbsenceReports" WHERE "studentId" <> child;
  IF n <> 0 THEN RAISE EXCEPTION 'absence: the guardian reads % report(s) of another pupil', n; END IF;
  SELECT count(*) INTO n FROM app.reported_absences(DATE '2095-06-01');
  IF n <> 0 THEN RAISE EXCEPTION 'absence: app.reported_absences answers a GUARDIAN % row(s)', n; END IF;
END $$;

-- 33d: the pupil reads their own report with its note and nobody else's; the
-- function answers a STUDENT nothing.
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls33_child_sub'))::text, true);
DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'STUDENT' THEN RAISE EXCEPTION 'absence: expected the STUDENT'; END IF;
  SELECT count(*) INTO n FROM "AbsenceReports" WHERE "studentId" = app.current_user_id() AND note = 'rls33 feber';
  IF n <> 1 THEN RAISE EXCEPTION 'absence: the pupil reads % of their own one report', n; END IF;
  SELECT count(*) INTO n FROM "AbsenceReports" WHERE "studentId" <> app.current_user_id();
  IF n <> 0 THEN RAISE EXCEPTION 'absence: the pupil reads % report(s) of somebody else', n; END IF;
  SELECT count(*) INTO n FROM app.reported_absences(DATE '2095-06-01');
  IF n <> 0 THEN RAISE EXCEPTION 'absence: app.reported_absences answers a STUDENT % row(s)', n; END IF;
END $$;

-- 33e: a teacher of the school reads no report, no note and no type, by a
-- count, a join or a subselect, under the API's role or PostgREST's, and
-- writes none. Through the function they read who is away that day and when:
-- the child all day, the other pupil 08:00-10:00, and nobody of another school.
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls33_teacher_sub'))::text, true);
DO $$
DECLARE
  child uuid := current_setting('app.test_rls33_child')::uuid;
  other uuid := current_setting('app.test_rls33_other')::uuid;
  n bigint; seen text;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'TEACHER' THEN RAISE EXCEPTION 'absence: expected a TEACHER'; END IF;
  SELECT count(*) INTO n FROM "AbsenceReports";
  IF n <> 0 THEN RAISE EXCEPTION 'absence: a teacher reads % absence report(s)', n; END IF;
  SELECT count(*) INTO n FROM "AbsenceReports" WHERE note IS NOT NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'absence: a teacher reads % note(s)', n; END IF;
  SELECT count(*) INTO n FROM "Users" u JOIN "AbsenceReports" a ON a."studentId" = u.id;
  IF n <> 0 THEN RAISE EXCEPTION 'absence: a teacher reaches % report(s) through a pupil', n; END IF;
  SELECT count(*) INTO n FROM "Users" u
   WHERE EXISTS (SELECT 1 FROM "AbsenceReports" a WHERE a."studentId" = u.id AND a.type = 'SICK');
  IF n <> 0 THEN RAISE EXCEPTION 'absence: a teacher learns who is off sick through a subselect'; END IF;

  SELECT string_agg(r."studentId"::text || ' ' || coalesce(r."startTime"::text, '-') || '-' || coalesce(r."endTime"::text, '-'), ',' ORDER BY r."studentId"::text) INTO seen
    FROM app.reported_absences(DATE '2095-06-01') r;
  IF seen IS DISTINCT FROM (SELECT string_agg(s, ',' ORDER BY s) FROM (VALUES (child::text || ' ---'), (other::text || ' 08:00:00-10:00:00')) v(s)) THEN
    RAISE EXCEPTION 'absence: through the function a teacher reads %', coalesce(seen, 'nothing');
  END IF;
  SELECT count(*) INTO n FROM app.reported_absences(DATE '2095-06-02');
  IF n <> 0 THEN RAISE EXCEPTION 'absence: the function answers % row(s) of another day', n; END IF;

  UPDATE "AbsenceReports" SET note = 'rls33 lärarens' WHERE "studentId" IN (child, other);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'absence: a teacher rewrote % report(s)', n; END IF;
  DELETE FROM "AbsenceReports" WHERE "studentId" IN (child, other);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'absence: a teacher deleted % report(s)', n; END IF;
  BEGIN
    INSERT INTO "AbsenceReports" ("schoolId", "studentId", "reportedById", date, type)
    VALUES (app.current_school_id(), child, app.current_user_id(), DATE '2095-06-03', 'OTHER');
    RAISE EXCEPTION 'absence: a teacher filed an absence report';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
SET LOCAL ROLE authenticated;
DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'TEACHER' THEN RAISE EXCEPTION 'absence: expected a TEACHER'; END IF;
  SELECT count(*) INTO n FROM "AbsenceReports";
  IF n <> 0 THEN RAISE EXCEPTION 'absence: through PostgREST''s role a teacher reads % absence report(s)', n; END IF;
  SELECT count(*) INTO n FROM "AbsenceReports" WHERE note IS NOT NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'absence: through PostgREST''s role a teacher reads % note(s)', n; END IF;
  SELECT count(*) INTO n FROM "Users" u WHERE EXISTS (SELECT 1 FROM "AbsenceReports" a WHERE a."studentId" = u.id);
  IF n <> 0 THEN RAISE EXCEPTION 'absence: through PostgREST''s role a teacher learns who is away through a subselect'; END IF;
  BEGIN
    PERFORM app.reported_absences(DATE '2095-06-01');
    RAISE EXCEPTION 'absence: through PostgREST''s role a teacher may call app.reported_absences';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
SET LOCAL ROLE app_authenticated;

-- 33f: the second school's teacher reads its own pupil's absence through the
-- function and none of the primary school's.
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000001')::text, true);
DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'TEACHER' THEN RAISE EXCEPTION 'absence: expected the second school''s TEACHER'; END IF;
  SELECT count(*) INTO n FROM app.reported_absences(DATE '2095-06-01') r
    JOIN "Users" u ON u.id = r."studentId" AND u."authId" = '00000000-0000-4000-8000-000000000002';
  IF n <> 1 THEN RAISE EXCEPTION 'absence: the second school''s teacher reads % of its pupil''s one absence', n; END IF;
  SELECT count(*) INTO n FROM app.reported_absences(DATE '2095-06-01');
  IF n <> 1 THEN RAISE EXCEPTION 'absence: the second school''s teacher reads % absence(s), not its one', n; END IF;
END $$;

-- 33g: the catalogue. Exactly these arms, and a function that answers three
-- columns, runs as its owner and is the API's alone.
DO $$
DECLARE arms text; fn text := 'app.reported_absences(date)'; r text;
BEGIN
  SELECT string_agg(policyname, ',' ORDER BY policyname) INTO arms
    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'AbsenceReports';
  IF arms IS DISTINCT FROM 'absence_reports_admin_all,absence_reports_guardian_insert,absence_reports_guardian_select,'
                           'absence_reports_reporter_delete,absence_reports_student_insert,absence_reports_student_select' THEN
    RAISE EXCEPTION 'absence: the arms on AbsenceReports are %', arms;
  END IF;
  IF pg_get_function_result(fn::regprocedure) IS DISTINCT FROM
     'TABLE("studentId" uuid, "startTime" time without time zone, "endTime" time without time zone)' THEN
    RAISE EXCEPTION 'absence: app.reported_absences answers %', pg_get_function_result(fn::regprocedure);
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = fn::regprocedure) THEN RAISE EXCEPTION 'absence: % is not SECURITY DEFINER', fn; END IF;
  IF NOT has_function_privilege('app_authenticated', fn, 'EXECUTE') THEN RAISE EXCEPTION 'absence: the API may not call %', fn; END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) AND has_function_privilege(r, fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'absence: % may call %', r, fn;
    END IF;
  END LOOP;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = fn::regprocedure) LIKE '%{=X/%' OR (SELECT proacl::text FROM pg_proc WHERE oid = fn::regprocedure) LIKE '%,=X/%' THEN
    RAISE EXCEPTION 'absence: PUBLIC may call %', fn;
  END IF;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 34: en elev ansöker om sin egen ledighet (LeaveRequests,
-- 20261015130000).
--
-- POST /leave-requests lets a STUDENT file for themselves, and the table had
-- no arm for it, so every pupil's request was a 42501 and a 500. The arm
-- leave_requests_student_insert lets an active pupil, through the API's role,
-- file one undecided request about themselves, in their own school, as its
-- requester. Every narrowing is asserted from the side it refuses: another
-- pupil, another school, another requester, each decided column on its own,
-- PostgREST's role, and a teacher or a guardian naming themselves as the
-- pupil. Then the request reaches the people who see it: the pupil, their
-- guardian and the admin who decides.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config('app.test_rls34_school_b', :'school_b', true);

-- 34a: the admin finds the guardian's child, who can sign in, another pupil
-- of the school and a teacher who can sign in.
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
DECLARE
  school uuid := app.current_school_id();
  child uuid; other uuid; teacher uuid; guardian uuid;
BEGIN
  SELECT gs."studentId", gs."guardianId" INTO child, guardian FROM "GuardianStudents" gs JOIN "Users" g ON g.id = gs."guardianId"
   WHERE g."authId" = '00000000-0000-4000-8000-000000000004' ORDER BY gs."studentId" LIMIT 1;
  SELECT id INTO other FROM "Users" WHERE "schoolId" = school AND role = 'STUDENT' AND "isActive" AND id <> child ORDER BY id LIMIT 1;
  SELECT id INTO teacher FROM "Users" WHERE "schoolId" = school AND role = 'TEACHER' AND "isActive" AND "authId" IS NOT NULL ORDER BY "authId" LIMIT 1;
  IF child IS NULL OR other IS NULL OR teacher IS NULL THEN
    RAISE EXCEPTION 'student leave: the primary school lacks the guardian''s child, another pupil or a teacher';
  END IF;
  IF (SELECT "authId" FROM "Users" WHERE id = child AND "isActive") IS NULL THEN
    RAISE EXCEPTION 'student leave: the guardian''s child cannot sign in';
  END IF;
  IF current_setting('app.test_rls34_school_b')::uuid = school THEN RAISE EXCEPTION 'student leave: school_b is the primary school'; END IF;
  PERFORM set_config('app.test_rls34_child', child::text, true);
  PERFORM set_config('app.test_rls34_other', other::text, true);
  PERFORM set_config('app.test_rls34_guardian', guardian::text, true);
  PERFORM set_config('app.test_rls34_child_sub', (SELECT "authId"::text FROM "Users" WHERE id = child), true);
  PERFORM set_config('app.test_rls34_teacher_sub', (SELECT "authId"::text FROM "Users" WHERE id = teacher), true);
END $$;

-- 34b: through the API's role the pupil files their own request, undecided,
-- and refuses every other row the arm could have let through.
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls34_child_sub'))::text, true);
DO $$
DECLARE
  me uuid := app.current_user_id();
  school uuid := app.current_school_id();
  r record; n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'STUDENT' THEN RAISE EXCEPTION 'student leave: expected the STUDENT'; END IF;
  IF me IS DISTINCT FROM current_setting('app.test_rls34_child')::uuid THEN RAISE EXCEPTION 'student leave: the claims are not the child''s'; END IF;

  INSERT INTO "LeaveRequests" ("schoolId", "studentId", "requestedById", "startDate", "endDate", reason)
  VALUES (school, me, me, DATE '2095-06-01', DATE '2095-06-02', 'rls34 elevens egen');
  SELECT count(*) INTO n FROM "LeaveRequests"
   WHERE reason = 'rls34 elevens egen' AND "studentId" = me AND "requestedById" = me AND status = 'PENDING';
  IF n <> 1 THEN RAISE EXCEPTION 'student leave: the pupil reads % of their own new request', n; END IF;

  FOR r IN SELECT * FROM (VALUES
      ('for another pupil', school, current_setting('app.test_rls34_other')::uuid, me, 'PENDING'::"LeaveRequestStatus", NULL::uuid, NULL::timestamptz, NULL::text),
      ('in another school''s name', current_setting('app.test_rls34_school_b')::uuid, me, me, 'PENDING', NULL, NULL, NULL),
      ('with the guardian as requester', school, me, current_setting('app.test_rls34_guardian')::uuid, 'PENDING', NULL, NULL, NULL),
      ('already approved', school, me, me, 'APPROVED', NULL, NULL, NULL),
      ('already rejected', school, me, me, 'REJECTED', NULL, NULL, NULL),
      ('with a decider', school, me, me, 'PENDING', me, NULL, NULL),
      ('with a decision time', school, me, me, 'PENDING', NULL, now(), NULL),
      ('with a decision note', school, me, me, 'PENDING', NULL, NULL, 'rls34 beviljad av mig själv')
    ) AS t(label, school_id, student_id, requester, status, decided_by, decided_at, note)
  LOOP
    BEGIN
      INSERT INTO "LeaveRequests" ("schoolId", "studentId", "requestedById", "startDate", "endDate", reason, status, "decidedById", "decidedAt", "decisionNote")
      VALUES (r.school_id, r.student_id, r.requester, DATE '2095-06-08', DATE '2095-06-08', 'rls34 ' || r.label, r.status, r.decided_by, r.decided_at, r.note);
      RAISE EXCEPTION 'student leave: the pupil filed a request %', r.label;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
  END LOOP;
END $$;

-- 34c: the arm is the API's alone. Through PostgREST's role the same pupil
-- files nothing, and still reads the request they filed through the API.
SET LOCAL ROLE authenticated;
DO $$
DECLARE me uuid := app.current_user_id(); n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'STUDENT' THEN RAISE EXCEPTION 'student leave: expected the STUDENT'; END IF;
  BEGIN
    INSERT INTO "LeaveRequests" ("schoolId", "studentId", "requestedById", "startDate", "endDate", reason)
    VALUES (app.current_school_id(), me, me, DATE '2095-06-15', DATE '2095-06-15', 'rls34 genom PostgREST');
    RAISE EXCEPTION 'student leave: through PostgREST''s role the pupil filed a request';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  SELECT count(*) INTO n FROM "LeaveRequests" WHERE "studentId" = me AND reason = 'rls34 elevens egen';
  IF n <> 1 THEN RAISE EXCEPTION 'student leave: through PostgREST''s role the pupil reads % of their own request', n; END IF;
END $$;
SET LOCAL ROLE app_authenticated;

-- 34d: the arm is a pupil's. A teacher and a guardian who name themselves as
-- the pupil file nothing, so no approval can write a staff member's or a
-- parent's absence.
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls34_teacher_sub'))::text, true);
DO $$
DECLARE me uuid := app.current_user_id();
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'TEACHER' THEN RAISE EXCEPTION 'student leave: expected a TEACHER'; END IF;
  BEGIN
    INSERT INTO "LeaveRequests" ("schoolId", "studentId", "requestedById", "startDate", "endDate", reason)
    VALUES (app.current_school_id(), me, me, DATE '2095-06-22', DATE '2095-06-22', 'rls34 lärarens egen');
    RAISE EXCEPTION 'student leave: a teacher filed a request about themselves';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000004')::text, true);
DO $$
DECLARE me uuid := app.current_user_id(); n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'GUARDIAN' THEN RAISE EXCEPTION 'student leave: expected the GUARDIAN'; END IF;
  BEGIN
    INSERT INTO "LeaveRequests" ("schoolId", "studentId", "requestedById", "startDate", "endDate", reason)
    VALUES (app.current_school_id(), me, me, DATE '2095-06-22', DATE '2095-06-22', 'rls34 vårdnadshavarens egen');
    RAISE EXCEPTION 'student leave: a guardian filed a request about themselves';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- 34e: the guardian reads the request their child filed.
  SELECT count(*) INTO n FROM "LeaveRequests"
   WHERE "studentId" = current_setting('app.test_rls34_child')::uuid AND reason = 'rls34 elevens egen';
  IF n <> 1 THEN RAISE EXCEPTION 'student leave: the guardian reads % of the request their child filed', n; END IF;
END $$;

-- 34f: the admin reads it and decides it. The pupil's one request is the
-- only rls34 row the section wrote.
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "LeaveRequests" WHERE reason LIKE 'rls34 %';
  IF n <> 1 THEN RAISE EXCEPTION 'student leave: the admin reads % rls34 request(s), not the pupil''s one', n; END IF;
  UPDATE "LeaveRequests" SET status = 'APPROVED', "decidedById" = app.current_user_id(), "decidedAt" = now()
   WHERE reason = 'rls34 elevens egen' AND "studentId" = current_setting('app.test_rls34_child')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'student leave: the admin decided % of the pupil''s one request', n; END IF;
END $$;

-- 34g: the arm as written: INSERT, for the API's role only.
DO $$
DECLARE arm record;
BEGIN
  SELECT cmd, roles::text AS roles INTO arm FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'LeaveRequests' AND policyname = 'leave_requests_student_insert';
  IF NOT FOUND THEN RAISE EXCEPTION 'student leave: LeaveRequests has no leave_requests_student_insert'; END IF;
  IF arm.cmd <> 'INSERT' OR arm.roles <> '{app_authenticated}' THEN
    RAISE EXCEPTION 'student leave: leave_requests_student_insert is % for %', arm.cmd, arm.roles;
  END IF;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 35: en vårdnadshavares ansökan börjar obeslutad, och bara en elev
-- anmäler sin egen frånvaro (LeaveRequests, AbsenceReports, 20261015140000).
--
-- Two INSERT arms from 20260713170100 said too little. Through PostgREST's
-- role a guardian filed a leave request for their child that was already
-- approved, with themselves as decider, and a teacher reported an absence
-- naming themselves as the pupil. Each new condition is asserted from the
-- side it refuses, under the API's role and under PostgREST's, which the app
-- writes both tables through. The rows the arms are for still go through: the
-- app's own leave request and an adult pupil's own absence report.
-- ---------------------------------------------------------------------------

BEGIN;

-- 35a: the admin finds the guardian's child, who can sign in, and a teacher
-- who can sign in.
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
DECLARE
  school uuid := app.current_school_id();
  child uuid; teacher uuid;
BEGIN
  SELECT gs."studentId" INTO child FROM "GuardianStudents" gs JOIN "Users" g ON g.id = gs."guardianId"
   WHERE g."authId" = '00000000-0000-4000-8000-000000000004' ORDER BY gs."studentId" LIMIT 1;
  SELECT id INTO teacher FROM "Users" WHERE "schoolId" = school AND role = 'TEACHER' AND "isActive" AND "authId" IS NOT NULL ORDER BY "authId" LIMIT 1;
  IF child IS NULL OR teacher IS NULL THEN
    RAISE EXCEPTION 'insert arms: the primary school lacks the guardian''s child or a teacher';
  END IF;
  IF (SELECT "authId" FROM "Users" WHERE id = child AND "isActive") IS NULL THEN
    RAISE EXCEPTION 'insert arms: the guardian''s child cannot sign in';
  END IF;
  PERFORM set_config('app.test_rls35_admin', app.current_user_id()::text, true);
  PERFORM set_config('app.test_rls35_child', child::text, true);
  PERFORM set_config('app.test_rls35_child_sub', (SELECT "authId"::text FROM "Users" WHERE id = child), true);
  PERFORM set_config('app.test_rls35_teacher_sub', (SELECT "authId"::text FROM "Users" WHERE id = teacher), true);
END $$;

-- 35b: the guardian, as each role. The app's own insert (LeaveRequestsScreen:
-- schoolId, studentId, requestedById, the dates and the reason) files an
-- undecided request. The same row with any one decision column set is
-- refused, and so is the row measured on main: approved by the guardian
-- themselves.
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000004')::text, true);
DO $$
DECLARE
  me uuid := app.current_user_id();
  school uuid := app.current_school_id();
  child uuid := current_setting('app.test_rls35_child')::uuid;
  admin uuid := current_setting('app.test_rls35_admin')::uuid;
  via text; r record; n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'GUARDIAN' THEN RAISE EXCEPTION 'guardian leave: expected the GUARDIAN'; END IF;
  FOREACH via IN ARRAY ARRAY['app_authenticated', 'authenticated'] LOOP
    EXECUTE format('SET LOCAL ROLE %I', via);
    IF current_user <> via THEN RAISE EXCEPTION 'guardian leave: running as %, not %', current_user, via; END IF;

    BEGIN
      INSERT INTO "LeaveRequests" ("schoolId", "studentId", "requestedById", "startDate", "endDate", reason)
      VALUES (school, child, me, DATE '2095-07-01', DATE '2095-07-02', 'rls35 appens ansökan genom ' || via);
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'guardian leave: through % the guardian could not file the app''s own request', via;
    END;
    SELECT count(*) INTO n FROM "LeaveRequests"
     WHERE reason = 'rls35 appens ansökan genom ' || via AND "studentId" = child AND "requestedById" = me
       AND status = 'PENDING' AND "decidedById" IS NULL AND "decidedAt" IS NULL AND "decisionNote" IS NULL;
    IF n <> 1 THEN RAISE EXCEPTION 'guardian leave: through % the guardian reads % of their undecided request', via, n; END IF;

    FOR r IN SELECT * FROM (VALUES
        ('approved by themselves, as measured on main', 'APPROVED'::"LeaveRequestStatus", me, now(), 'Beviljad'),
        ('already approved', 'APPROVED', NULL::uuid, NULL::timestamptz, NULL::text),
        ('already rejected', 'REJECTED', NULL, NULL, NULL),
        ('with the admin as decider', 'PENDING', admin, NULL, NULL),
        ('with a decision time', 'PENDING', NULL, now(), NULL),
        ('with a decision note', 'PENDING', NULL, NULL, 'Beviljad')
      ) AS t(label, status, decided_by, decided_at, note)
    LOOP
      BEGIN
        INSERT INTO "LeaveRequests" ("schoolId", "studentId", "requestedById", "startDate", "endDate", reason, status, "decidedById", "decidedAt", "decisionNote")
        VALUES (school, child, me, DATE '2095-07-08', DATE '2095-07-08', 'rls35 ' || r.label, r.status, r.decided_by, r.decided_at, r.note);
        RAISE EXCEPTION 'guardian leave: through % the guardian filed a request %', via, r.label;
      EXCEPTION WHEN insufficient_privilege THEN NULL;
      END;
    END LOOP;
  END LOOP;
  SET LOCAL ROLE app_authenticated;
END $$;

-- 35c: the absence arm is a pupil's. A teacher and a guardian who name
-- themselves as both pupil and reporter report nothing, as either role.
DO $$
DECLARE
  sub text; via text; me uuid; who text;
BEGIN
  FOREACH sub IN ARRAY ARRAY[current_setting('app.test_rls35_teacher_sub'), '00000000-0000-4000-8000-000000000004'] LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', sub)::text, true);
    me := app.current_user_id();
    who := app.current_user_role()::text;
    IF me IS NULL OR who NOT IN ('TEACHER', 'GUARDIAN') THEN RAISE EXCEPTION 'pupil absence: expected a TEACHER or the GUARDIAN, got %', who; END IF;
    FOREACH via IN ARRAY ARRAY['app_authenticated', 'authenticated'] LOOP
      EXECUTE format('SET LOCAL ROLE %I', via);
      IF current_user <> via THEN RAISE EXCEPTION 'pupil absence: running as %, not %', current_user, via; END IF;
      BEGIN
        INSERT INTO "AbsenceReports" ("schoolId", "studentId", "reportedById", date, note)
        VALUES (app.current_school_id(), me, me, DATE '2095-07-15', 'rls35 ' || lower(who) || ' om sig själv');
        RAISE EXCEPTION 'pupil absence: through % a % reported an absence about themselves', via, who;
      EXCEPTION WHEN insufficient_privilege THEN NULL;
      END;
    END LOOP;
    SET LOCAL ROLE app_authenticated;
  END LOOP;
END $$;

-- 35d: the adult pupil reports their own absence, as either role, and reads
-- it back.
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls35_child_sub'))::text, true);
DO $$
DECLARE
  me uuid := app.current_user_id();
  via text; n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'STUDENT' THEN RAISE EXCEPTION 'pupil absence: expected the STUDENT'; END IF;
  IF me IS DISTINCT FROM current_setting('app.test_rls35_child')::uuid THEN RAISE EXCEPTION 'pupil absence: the claims are not the child''s'; END IF;
  FOREACH via IN ARRAY ARRAY['app_authenticated', 'authenticated'] LOOP
    EXECUTE format('SET LOCAL ROLE %I', via);
    IF current_user <> via THEN RAISE EXCEPTION 'pupil absence: running as %, not %', current_user, via; END IF;
    BEGIN
      INSERT INTO "AbsenceReports" ("schoolId", "studentId", "reportedById", date, note)
      VALUES (app.current_school_id(), me, me, DATE '2095-07-16', 'rls35 elevens egen genom ' || via);
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'pupil absence: through % the pupil could not report their own absence', via;
    END;
    SELECT count(*) INTO n FROM "AbsenceReports" WHERE "studentId" = me AND note = 'rls35 elevens egen genom ' || via;
    IF n <> 1 THEN RAISE EXCEPTION 'pupil absence: through % the pupil reads % of their own report', via, n; END IF;
  END LOOP;
  SET LOCAL ROLE app_authenticated;
END $$;

-- 35e: the admin reads exactly the rows the section meant to write: the
-- guardian's two undecided requests and the pupil's two reports. The admin,
-- and only the admin, decides a request.
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "LeaveRequests" WHERE reason LIKE 'rls35 %';
  IF n <> 2 THEN RAISE EXCEPTION 'guardian leave: the admin reads % rls35 request(s), not the guardian''s two', n; END IF;
  SELECT count(*) INTO n FROM "LeaveRequests" WHERE reason LIKE 'rls35 %' AND status = 'PENDING';
  IF n <> 2 THEN RAISE EXCEPTION 'guardian leave: % of the guardian''s two requests wait for the admin', n; END IF;
  SELECT count(*) INTO n FROM "AbsenceReports" WHERE note LIKE 'rls35 %';
  IF n <> 2 THEN RAISE EXCEPTION 'pupil absence: the admin reads % rls35 report(s), not the pupil''s two', n; END IF;
  UPDATE "LeaveRequests" SET status = 'APPROVED', "decidedById" = app.current_user_id(), "decidedAt" = now()
   WHERE reason = 'rls35 appens ansökan genom authenticated';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'guardian leave: the admin decided % of the guardian''s request', n; END IF;
END $$;

-- 35f: the arms as written: INSERT, for PostgREST's role, which the API's
-- inherits.
DO $$
DECLARE arm record;
BEGIN
  FOR arm IN SELECT * FROM (VALUES
      ('LeaveRequests', 'leave_requests_guardian_insert'),
      ('AbsenceReports', 'absence_reports_student_insert')
    ) AS t(tbl, name)
  LOOP
    PERFORM 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = arm.tbl AND policyname = arm.name
       AND cmd = 'INSERT' AND roles::text = '{authenticated}';
    IF NOT FOUND THEN RAISE EXCEPTION 'insert arms: % is not an INSERT arm for authenticated on %', arm.name, arm.tbl; END IF;
  END LOOP;
END $$;
ROLLBACK;


-- ---------------------------------------------------------------------------
-- Section 36: den som inte är inloggad når ingen tabell (anon,
-- 20261016090000).
--
-- anon is the role PostgREST and pg_graphql use for a request that carries no
-- user token. No path of SchemaPro's uses it: web and mobile read tables once
-- Supabase Auth has a user, and the public timetable and the SS12000 API go
-- through the gateway as app_authenticated. On Supabase, though, the default
-- ACL of the role that runs the migrations gave anon ALL on every table that
-- role created in "public", and 46 tables kept that until 20261016090000. Row
-- security held the rows back, but 56 policies are TO public and admit a row
-- on a GUC alone (app.service_school_id, app.sync_school_id,
-- app.service_key_lookup), so the table grant is the layer that has to
-- refuse.
--
-- This connection cannot become anon, so the section reads the catalogue, as
-- section 14 does. It lists anon's whole reach in "public" and "app" and
-- compares it with what is meant to remain, which is USAGE on schema
-- "public" and nothing else:
--
--   * USAGE and CREATE on either schema;
--   * every privilege on a table, view or foreign table, and on a sequence,
--     whether granted to anon or to PUBLIC (has_*_privilege counts both).
--     MAINTAIN is counted on Postgres 17 and later, which have it
--     (20261016120000);
--   * EXECUTE on a function in "public", which PostgREST serves as an RPC.
--     Extension members are left out: pgcrypto and btree_gist sit in
--     "public" here and in "extensions" on Supabase, and are not ours;
--   * a function in either schema whose ACL names anon itself. A function
--     in "app" that only PUBLIC executes is not listed: anon cannot name it
--     without USAGE on "app", which the first item covers;
--   * a default ACL entry, of any role and in any schema or none, that gives
--     anon (or, for tables and sequences, PUBLIC) anything. That is how the
--     46 got their grant.
--
-- CI's database has no Supabase default ACL, so there anon held none of this
-- even before 20261016090000, and the section guards against a regression: a
-- GRANT to anon or to PUBLIC, a function in "public" or a default ACL fails
-- it. On a database with Supabase's default ACL it fails without the
-- migration, naming the 46 tables and the three default entries.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  tables   int;
  reach    text[];
  maintain text[] := CASE WHEN current_setting('server_version_num')::int >= 170000
                          THEN ARRAY['MAINTAIN'] ELSE '{}' END;
  expected text[] := ARRAY['schema public: USAGE'];
  extra    text;
  extras   int;
  missing  text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE EXCEPTION 'anon: the role does not exist, so nothing below says anything';
  END IF;

  SELECT count(*)::int INTO tables
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r';
  IF tables < 25 THEN
    RAISE EXCEPTION 'anon: only % table(s) were examined; the catalog query proved nothing', tables;
  END IF;

  SELECT coalesce(array_agg(item ORDER BY item), '{}') INTO reach FROM (
    SELECT 'schema ' || n.nspname || ': ' || string_agg(p, ', ' ORDER BY p) AS item
      FROM pg_namespace n CROSS JOIN unnest(ARRAY['USAGE', 'CREATE']) p
     WHERE n.nspname IN ('public', 'app') AND has_schema_privilege('anon', n.oid, p)
     GROUP BY n.nspname
    UNION ALL
    SELECT 'relation ' || c.oid::regclass::text || ': ' || string_agg(p, ', ' ORDER BY p)
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] || maintain) p
     WHERE n.nspname IN ('public', 'app') AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND has_table_privilege('anon', c.oid, p)
     GROUP BY c.oid
    UNION ALL
    SELECT 'sequence ' || c.oid::regclass::text || ': ' || string_agg(p, ', ' ORDER BY p)
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     CROSS JOIN unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) p
     WHERE n.nspname IN ('public', 'app') AND c.relkind = 'S'
       AND has_sequence_privilege('anon', c.oid, p)
     GROUP BY c.oid
    UNION ALL
    SELECT 'function ' || f.oid::regprocedure::text || ': EXECUTE'
      FROM pg_proc f JOIN pg_namespace n ON n.oid = f.pronamespace
     WHERE n.nspname IN ('public', 'app')
       AND has_function_privilege('anon', f.oid, 'EXECUTE')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_proc'::regclass AND d.objid = f.oid AND d.deptype = 'e')
       AND (n.nspname = 'public'
            OR EXISTS (SELECT 1 FROM aclexplode(f.proacl) a WHERE a.grantee = 'anon'::regrole))
    UNION ALL
    SELECT 'default for ' || pg_get_userbyid(d.defaclrole)
           || coalesce(' in schema ' || n.nspname, ' in every schema')
           || ', new ' || CASE d.defaclobjtype WHEN 'r' THEN 'tables' WHEN 'S' THEN 'sequences'
                            WHEN 'f' THEN 'functions' WHEN 'T' THEN 'types' WHEN 'n' THEN 'schemas'
                            ELSE d.defaclobjtype::text END
           || ' to ' || CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE 'anon' END
           || ': ' || string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type)
      FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
     CROSS JOIN aclexplode(d.defaclacl) a
     WHERE a.grantee = 'anon'::regrole
        OR (a.grantee = 0 AND d.defaclobjtype IN ('r', 'S'))
     GROUP BY d.oid, n.nspname, a.grantee
  ) r;

  SELECT string_agg(x, '; ' ORDER BY x), count(*) INTO extra, extras
    FROM unnest(reach) x WHERE x <> ALL (expected);
  SELECT string_agg(x, '; ' ORDER BY x) INTO missing
    FROM unnest(expected) x WHERE x <> ALL (reach);

  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'anon: % holding(s) beyond USAGE on schema public: %', extras, extra;
  END IF;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'anon: no longer holds %; the section names what anon holds exactly, so change it on purpose', missing;
  END IF;
END $$;


-- ---------------------------------------------------------------------------
-- Section 37: tjänsteprincipalens och synkens armar gäller bara API:ts roll
-- (20261016100000).
--
-- The service principal's, the sync's and the key lookup's arms admit a row
-- on a GUC alone: app.service_school_id, app.sync_school_id and
-- app.service_key_lookup. Only the gateway sets them, as app_authenticated
-- (PrismaService.withServicePrincipal, withSyncPrincipal and
-- withServiceKeyLookup). Until 20261016100000 the 56 arms were TO public, so
-- they also applied to PostgREST's authenticated and to anon. Only
-- PostgREST's refusal to let a client set the GUC kept a signed-in user from
-- being the service principal. As authenticated with no user and
-- app.service_school_id set, all 91 Users rows of the seeded school were read
-- and updated.
--
-- 37a reads the catalogue. No policy in "public" or "app" applies to PUBLIC,
-- with no exceptions, since none of the arms has to stay that way. Every
-- policy whose expression calls a principal's function belongs to
-- app_authenticated alone. That is read from pg_depend, not from the text, so
-- a reformatted expression cannot hide an arm, and an arm a later migration
-- writes TO authenticated fails too.
--
-- 37b sets each principal's GUC in turn, with no user signed in, and runs the
-- same statements as both roles. As app_authenticated the principal reads the
-- school's rows and updates them, and the service principal inserts a class.
-- As authenticated the GUC adds nothing: nothing is read or updated, and the
-- insert is refused. This leg also catches an arm that reads the GUC some
-- other way, through current_setting() or a wrapper function, which pg_depend
-- does not see.
--
-- anon is not run here, since this connection cannot become anon. After
-- 20261016090000 it holds no table (section 36), and 37a leaves it no
-- principal's arm either.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  principal_fns oid[] := ARRAY[
    'app.current_service_school_id()'::regprocedure,
    'app.current_sync_school_id()'::regprocedure,
    'app.is_service_key_lookup()'::regprocedure,
    'app.current_service_key_id()'::regprocedure
  ]::oid[];
  arms  int;
  wrong text;
BEGIN
  SELECT string_agg(schemaname || '.' || tablename || '.' || policyname, ', ' ORDER BY schemaname, tablename, policyname)
    INTO wrong
    FROM pg_policies
   WHERE schemaname IN ('public', 'app') AND 'public' = ANY (roles);
  IF wrong IS NOT NULL THEN
    RAISE EXCEPTION 'principal arms: these policies apply TO public, and so to PostgREST''s authenticated and to anon: %', wrong;
  END IF;

  SELECT count(*)::int,
         string_agg(c.relname || '.' || p.polname || ' TO ' || r.roles, ', ' ORDER BY c.relname, p.polname)
           FILTER (WHERE r.roles <> 'app_authenticated')
    INTO arms, wrong
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
   CROSS JOIN LATERAL (
     SELECT string_agg(CASE x WHEN 0 THEN 'public' ELSE x::regrole::text END, ',' ORDER BY x) AS roles
       FROM unnest(p.polroles) x
   ) r
   WHERE EXISTS (SELECT 1 FROM pg_depend d
                  WHERE d.classid = 'pg_policy'::regclass AND d.objid = p.oid
                    AND d.refclassid = 'pg_proc'::regclass AND d.refobjid = ANY (principal_fns));
  IF arms < 56 THEN
    RAISE EXCEPTION 'principal arms: only % policies call a principal''s function, where 20261016100000 moved 56; the catalogue query proved nothing', arms;
  END IF;
  IF wrong IS NOT NULL THEN
    RAISE EXCEPTION 'principal arms: an arm that admits on a principal''s GUC is not app_authenticated''s alone: %', wrong;
  END IF;
END $$;

BEGIN;
SELECT set_config('app.test_rls37_school', :'school_a', true);
SELECT set_config('request.jwt.claims', '', true);

DO $$
DECLARE
  school uuid := current_setting('app.test_rls37_school')::uuid;
  year uuid;
  principal text; via text; t record; n bigint;
BEGIN
  -- The class insert needs one of the school's years, read as the service
  -- principal before the loop.
  PERFORM set_config('app.service_school_id', school::text, true);
  SELECT id INTO year FROM "AcademicYears" ORDER BY "startDate" LIMIT 1;
  PERFORM set_config('app.service_school_id', '', true);
  IF year IS NULL THEN
    RAISE EXCEPTION 'principal arms: the service principal finds no year in the primary school';
  END IF;

  FOREACH principal IN ARRAY ARRAY['service principal', 'sync', 'key lookup'] LOOP
    FOREACH via IN ARRAY ARRAY['app_authenticated', 'authenticated'] LOOP
      EXECUTE format('SET LOCAL ROLE %I', via);
      IF current_user <> via THEN RAISE EXCEPTION 'principal arms: running as %, not %', current_user, via; END IF;
      PERFORM set_config('app.service_school_id', CASE principal WHEN 'service principal' THEN school::text ELSE '' END, true);
      PERFORM set_config('app.sync_school_id', CASE principal WHEN 'sync' THEN school::text ELSE '' END, true);
      PERFORM set_config('app.service_key_lookup', CASE principal WHEN 'key lookup' THEN 'on' ELSE '' END, true);
      IF app.current_user_id() IS NOT NULL THEN
        RAISE EXCEPTION 'principal arms: a user is signed in, so the % leg says nothing about the arms', principal;
      END IF;

      FOR t IN SELECT * FROM (VALUES
          ('service principal', 'Users'), ('service principal', 'Schools'),
          ('service principal', 'AcademicYears'), ('service principal', 'StudentGroups'),
          ('service principal', 'StudentGroupMembers'), ('service principal', 'GuardianStudents'),
          ('service principal', 'Subjects'), ('service principal', 'Rooms'),
          ('service principal', 'MasterLessons'), ('service principal', 'CalendarLessons'),
          ('sync', 'Users'), ('sync', 'Schools'), ('sync', 'AcademicYears'),
          ('sync', 'StudentGroups'), ('sync', 'StudentGroupMembers'), ('sync', 'GuardianStudents'),
          ('key lookup', 'IntegrationApiKeys')
        ) AS v(who, tbl) WHERE v.who = principal
      LOOP
        EXECUTE format('SELECT count(*) FROM %I', t.tbl) INTO n;
        IF via = 'app_authenticated' AND n = 0 THEN
          RAISE EXCEPTION 'principal arms: as app_authenticated the % reads nothing in %', principal, t.tbl;
        ELSIF via = 'authenticated' AND n <> 0 THEN
          RAISE EXCEPTION 'principal arms: through PostgREST''s authenticated the % reads % row(s) of %', principal, n, t.tbl;
        END IF;
      END LOOP;

      -- The service principal's update and the key lookup's touch (the
      -- guard's own write) read no column. A statement that reads one needs
      -- a SELECT arm as well, so an UPDATE arm that leaks on its own fails
      -- here only this way. The sync may not touch an admin
      -- (users_sync_writes_are_narrow), so its update names the pupils.
      EXECUTE CASE principal
        WHEN 'service principal' THEN 'UPDATE "Users" SET "updatedAt" = now()'
        WHEN 'sync' THEN 'UPDATE "Users" SET "updatedAt" = now() WHERE role = ''STUDENT'''
        ELSE 'UPDATE "IntegrationApiKeys" SET "lastUsedAt" = now()'
      END;
      GET DIAGNOSTICS n = ROW_COUNT;
      IF via = 'app_authenticated' AND n = 0 THEN
        RAISE EXCEPTION 'principal arms: as app_authenticated the % updates nothing', principal;
      ELSIF via = 'authenticated' AND n <> 0 THEN
        RAISE EXCEPTION 'principal arms: through PostgREST''s authenticated the % updates % row(s)', principal, n;
      END IF;

      IF principal = 'service principal' THEN
        BEGIN
          INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "updatedAt")
          VALUES (school, year, 'RLS37 klass genom ' || via, now());
          IF via = 'authenticated' THEN
            RAISE EXCEPTION 'principal arms: through PostgREST''s authenticated the service principal created a class';
          END IF;
        EXCEPTION WHEN insufficient_privilege THEN
          IF via = 'app_authenticated' THEN
            RAISE EXCEPTION 'principal arms: as app_authenticated the service principal could not create a class';
          END IF;
        END;
      END IF;
    END LOOP;
  END LOOP;
  SET LOCAL ROLE app_authenticated;
END $$;
ROLLBACK;


-- ---------------------------------------------------------------------------
-- Section 38: den inloggade tömmer ingen tabell, sätter ingen trigger på den
-- och pekar ingen främmande nyckel mot den (authenticated, 20261016110000),
-- bara ägaren underhåller en tabell (MAINTAIN, 20261016120000), och
-- tjänstenyckeln läser men skriver ingen tabell (service_role,
-- 20261016130000).
--
-- authenticated is PostgREST's role for a signed-in user, and
-- app_authenticated, the gateway's role, inherits everything it holds. On
-- Supabase the default ACL of the role that runs the migrations gave
-- authenticated ALL on every table that role created in "public", and 46
-- tables kept TRUNCATE, REFERENCES and TRIGGER until 20261016110000. Neither
-- role needs any of the three: PostgREST cannot issue them, and the gateway's
-- SQL is DML. TRUNCATE does not consult row security, so one statement
-- through either role emptied a table for every school. TRIGGER let either
-- role attach a function to a table, and every later writer would run it.
--
-- Postgres 17, which production runs, adds MAINTAIN. It allows VACUUM,
-- ANALYZE, REINDEX, CLUSTER, REFRESH MATERIALIZED VIEW and LOCK TABLE in any
-- mode on a table the role does not own, and ALL includes it. The same
-- default ACL gave it to authenticated and to service_role on 77 tables: the
-- 46, and every table created since, whose REVOKE lists were written for 16.
-- As either API role, VACUUM FULL, CLUSTER and REINDEX ran, each holding
-- ACCESS EXCLUSIVE.
--
-- service_role, which a request with Supabase's service key runs as, has
-- BYPASSRLS. On the same 46 tables it held INSERT, UPDATE, DELETE, TRUNCATE,
-- REFERENCES and TRIGGER: the first three from the init migration and
-- 20260806000000, all six from that default ACL, so a request with the key
-- could change or remove every school's rows. Nothing writes as
-- service_role: the gateway uses the key for GoTrue's admin API alone. The
-- tables created since 20261010090000 already leave it SELECT, and
-- 20261016130000 does the same for the 46.
--
-- 38a reads the catalogue. Neither role holds TRUNCATE, REFERENCES or
-- TRIGGER on any table, view or foreign table in "public" or "app". That
-- counts grants to the role itself, to a role it inherits from and to PUBLIC,
-- and REFERENCES on a single column as well. service_role holds none of the
-- three there either, nor INSERT, UPDATE or DELETE, and INSERT and UPDATE on
-- a single column count too. On 17 and later, none of the three roles holds
-- MAINTAIN there. So service_role holds SELECT or nothing on every relation.
-- This connection cannot become service_role, so its part is asserted from
-- the catalogue alone. No default ACL entry, of any role and in any schema or
-- none, gives new tables any of the three to authenticated or
-- app_authenticated, to a role they inherit from or to PUBLIC, nor MAINTAIN
-- to them. None gives service_role or PUBLIC anything but SELECT. Postgres 16
-- has no MAINTAIN, and has_table_privilege rejects the name, so on 16 that
-- part is skipped.
--
-- 38b runs the statements as each role in turn. It runs TRUNCATE on a table
-- no foreign key points at, so the grant is the only thing that refuses it.
-- It runs CREATE TRIGGER with a built-in function that everyone may execute,
-- and REINDEX TABLE on the same table. It also runs LOCK TABLE ... IN ACCESS
-- EXCLUSIVE MODE on TeacherEmploymentLogs, where neither role may update,
-- delete or truncate, so on 17 only MAINTAIN could allow it. UPDATE alone
-- allows any lock, so on a table the role may update the probe would prove
-- nothing. All four must be refused by the grant (42501). On 16, REINDEX
-- needs ownership and LOCK needs UPDATE, DELETE or TRUNCATE, so the probes
-- hold there too. VACUUM and ANALYZE are not run. They skip a table they may
-- not touch with a warning instead of an error, and VACUUM cannot run in a
-- transaction. REFERENCES would need a table of the role's own, which
-- neither role can create, so the catalogue alone covers it.
--
-- CI's database has no Supabase default ACL, so there authenticated held none
-- of this even before 20261016110000, and the section guards against a
-- regression. On a database with Supabase's default ACL it fails without the
-- migration, naming the 46 tables. With only the tables revoked, it names the
-- migration role's default entry. On 17 with that default ACL and without
-- 20261016120000, it names MAINTAIN on the 77. service_role exists on CI too,
-- since the init migration creates it, and holds INSERT, UPDATE and DELETE
-- there from the init migration and 20260806000000. So without
-- 20261016130000 the section fails on CI as well, naming service_role's
-- writes.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  tables   int;
  via      text;
  held     text;
  n        int;
  maintain text[] := CASE WHEN current_setting('server_version_num')::int >= 170000
                          THEN ARRAY['MAINTAIN'] ELSE '{}' END;
  denied   text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    RAISE EXCEPTION 'table rights: the role authenticated does not exist, so nothing below says anything';
  END IF;

  SELECT count(*)::int INTO tables
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public' AND c.relkind = 'r';
  IF tables < 46 THEN
    RAISE EXCEPTION 'table rights: only % table(s) were examined; the catalog query proved nothing', tables;
  END IF;

  FOREACH via IN ARRAY ARRAY['authenticated', 'app_authenticated', 'service_role'] LOOP
    denied := CASE via WHEN 'service_role' THEN ARRAY['INSERT', 'UPDATE', 'DELETE'] ELSE '{}' END
              || ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER'] || maintain;
    SELECT string_agg(item, '; ' ORDER BY item), count(*)::int INTO held, n FROM (
      SELECT c.oid::regclass::text || ': ' || string_agg(p, ', ' ORDER BY p) AS item
        FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
       CROSS JOIN unnest(denied) p
       WHERE ns.nspname IN ('public', 'app') AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND CASE WHEN p IN ('INSERT', 'UPDATE', 'REFERENCES') THEN has_any_column_privilege(via, c.oid, p)
                  ELSE has_table_privilege(via, c.oid, p) END
       GROUP BY c.oid
    ) x;
    IF held IS NOT NULL THEN
      RAISE EXCEPTION 'table rights: % holds % on % relation(s): %', via,
        regexp_replace(array_to_string(denied, ', '), ', (\w+)$', ' or \1'), n, held;
    END IF;
  END LOOP;

  SELECT string_agg(item, '; ' ORDER BY item) INTO held FROM (
    SELECT 'default for ' || pg_get_userbyid(d.defaclrole)
           || coalesce(' in schema ' || ns.nspname, ' in every schema')
           || ', new tables to ' || CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
           || ': ' || string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type) AS item
      FROM pg_default_acl d LEFT JOIN pg_namespace ns ON ns.oid = d.defaclnamespace
     CROSS JOIN aclexplode(d.defaclacl) a
     WHERE d.defaclobjtype = 'r'
       AND CASE WHEN a.grantee = 0 OR pg_has_role('service_role', a.grantee, 'USAGE')
                  THEN a.privilege_type <> 'SELECT'
                ELSE a.privilege_type IN ('TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN')
                     AND (pg_has_role('authenticated', a.grantee, 'USAGE')
                          OR pg_has_role('app_authenticated', a.grantee, 'USAGE')) END
     GROUP BY d.oid, ns.nspname, a.grantee
  ) x;
  IF held IS NOT NULL THEN
    RAISE EXCEPTION 'table rights: a default ACL gives new tables TRUNCATE, REFERENCES, TRIGGER or MAINTAIN, or gives service_role or PUBLIC more than SELECT: %', held;
  END IF;
END $$;

BEGIN;
DO $$
DECLARE
  via text;
BEGIN
  FOREACH via IN ARRAY ARRAY['authenticated', 'app_authenticated'] LOOP
    EXECUTE format('SET LOCAL ROLE %I', via);
    IF current_user <> via THEN RAISE EXCEPTION 'table rights: running as %, not %', current_user, via; END IF;
    BEGIN
      TRUNCATE "GuardianStudents";
      RAISE EXCEPTION 'table rights: % emptied GuardianStudents for every school, past row security', via;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      CREATE TRIGGER rls38_trigger BEFORE UPDATE ON "GuardianStudents"
        FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger();
      RAISE EXCEPTION 'table rights: % attached a trigger to GuardianStudents', via;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      REINDEX TABLE "GuardianStudents";
      RAISE EXCEPTION 'table rights: % reindexed GuardianStudents, which holds its writes for every school', via;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      LOCK TABLE "TeacherEmploymentLogs" IN ACCESS EXCLUSIVE MODE;
      RAISE EXCEPTION 'table rights: % locked TeacherEmploymentLogs against every reader and writer, a table it may only read', via;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
  END LOOP;
  SET LOCAL ROLE app_authenticated;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 40: ett uppdrags tider är länkar som uppdraget själv läses genom
-- (TeacherDutySlots, 20261017090000).
--
-- An uppdrag holds any number of fixed times, one link row per time. The
-- link carries nothing but two ids, and it is read exactly as the uppdrag
-- is: the admin all of the school's, a TEACHER the links of their OWN
-- uppdrag (through an EXISTS that their own arm on TeacherDuties narrows),
-- nobody else — not a colleague, a pupil, a guardian or the service
-- principal, and nobody another school's. Which of a colleague's weekly
-- UNAVAILABLE rows is an uppdrag is exactly what teacher_own_select keeps
-- from them, so the teacher's read is an exact count against links the
-- colleague holds in the same transaction, under the API's role and under
-- PostgREST's. A teacher writes no link: an uppdrag is assigned.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
DECLARE
  school uuid := app.current_school_id();
  me uuid; colleague uuid; year uuid;
  c1 uuid; c2 uuid; c3 uuid; d_me uuid; d_col uuid;
  n bigint;
BEGIN
  IF app.current_user_role() <> 'SCHOOL_ADMIN' THEN
    RAISE EXCEPTION 'duty links: expected to be acting as an admin, am %', app.current_user_role();
  END IF;
  SELECT id INTO me FROM "Users" WHERE "schoolId" = school AND role = 'TEACHER' ORDER BY "authId" LIMIT 1;
  SELECT id INTO colleague FROM "Users" WHERE "schoolId" = school AND role = 'TEACHER' ORDER BY "authId" OFFSET 1 LIMIT 1;
  SELECT id INTO year FROM "AcademicYears" WHERE "schoolId" = school AND "isActive" LIMIT 1;
  IF me IS NULL OR colleague IS NULL OR year IS NULL THEN
    RAISE EXCEPTION 'duty links: the seed lacks two teachers or an active year';
  END IF;
  -- The tenant half first: the second school's fixture uppdrag holds a time,
  -- and none of its links is this admin's to see.
  SELECT count(*) INTO n FROM "TeacherDutySlots";
  IF n <> 0 THEN
    RAISE EXCEPTION 'duty links: % link row(s) visible before any were written — the seed has none and school B''s must not show', n;
  END IF;

  INSERT INTO "AvailabilityConstraints" ("schoolId", "resourceType", "userId", "dayOfWeek", "startTime", "endTime", type, reason, "updatedAt")
  VALUES (school, 'TEACHER', me, 1, '10:00', '10:20', 'UNAVAILABLE', 'Uppdrag', now()) RETURNING id INTO c1;
  INSERT INTO "AvailabilityConstraints" ("schoolId", "resourceType", "userId", "dayOfWeek", "startTime", "endTime", type, reason, "updatedAt")
  VALUES (school, 'TEACHER', me, 3, '10:00', '10:20', 'UNAVAILABLE', 'Uppdrag', now()) RETURNING id INTO c2;
  INSERT INTO "AvailabilityConstraints" ("schoolId", "resourceType", "userId", "dayOfWeek", "startTime", "endTime", type, reason, "updatedAt")
  VALUES (school, 'TEACHER', colleague, 2, '12:00', '12:30', 'UNAVAILABLE', 'Uppdrag', now()) RETURNING id INTO c3;
  INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "updatedAt")
  VALUES (school, me, year, 'RASTVAKT', 'RLS40 rastvakt', 40, now()) RETURNING id INTO d_me;
  INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "updatedAt")
  VALUES (school, colleague, year, 'FORSTELARARE', 'RLS40 förstelärare', 60, now()) RETURNING id INTO d_col;
  INSERT INTO "TeacherDutySlots" ("schoolId", "teacherDutyId", "availabilityConstraintId")
  VALUES (school, d_me, c1), (school, d_me, c2), (school, d_col, c3);
  SELECT count(*) INTO n FROM "TeacherDutySlots";
  IF n <> 3 THEN
    RAISE EXCEPTION 'duty links: the admin reads % of the three links they wrote', n;
  END IF;
  PERFORM set_config('app.test_rls40_mine', d_me::text, true);
  PERFORM set_config('app.test_rls40_theirs', d_col::text, true);
END $$;

-- The first teacher, under both roles.
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', (SELECT "authId" FROM "Users"
                             WHERE "schoolId" = app.current_school_id() AND role = 'TEACHER'
                             ORDER BY "authId" LIMIT 1))::text,
  true
);
DO $$
DECLARE
  mine uuid := current_setting('app.test_rls40_mine')::uuid;
  theirs uuid := current_setting('app.test_rls40_theirs')::uuid;
  school uuid := app.current_school_id();
  via text; n bigint; c uuid;
BEGIN
  IF app.current_user_role() <> 'TEACHER' THEN
    RAISE EXCEPTION 'duty links: expected the teacher, am %', app.current_user_role();
  END IF;
  FOREACH via IN ARRAY ARRAY['app_authenticated', 'authenticated'] LOOP
    EXECUTE format('SET LOCAL ROLE %I', via);
    IF current_user <> via THEN RAISE EXCEPTION 'duty links: running as %, not %', current_user, via; END IF;
    SELECT count(*) INTO n FROM "TeacherDutySlots";
    IF n <> 2 THEN
      RAISE EXCEPTION 'duty links: through % a teacher reads % link(s), expected exactly the 2 of their own uppdrag', via, n;
    END IF;
    SELECT count(*) INTO n FROM "TeacherDutySlots" WHERE "teacherDutyId" = theirs;
    IF n <> 0 THEN
      RAISE EXCEPTION 'duty links: through % a teacher reads which of a colleague''s times is an uppdrag', via;
    END IF;
    -- No write: not a new link, not a removed one.
    SELECT "availabilityConstraintId" INTO c FROM "TeacherDutySlots" WHERE "teacherDutyId" = mine LIMIT 1;
    BEGIN
      INSERT INTO "TeacherDutySlots" ("schoolId", "teacherDutyId", "availabilityConstraintId") VALUES (school, mine, c);
      RAISE EXCEPTION 'duty links: through % a teacher linked a time to their uppdrag', via;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    DELETE FROM "TeacherDutySlots" WHERE "teacherDutyId" = mine;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN
      RAISE EXCEPTION 'duty links: through % a teacher removed % of their uppdrag''s times', via, n;
    END IF;
  END LOOP;
  SET LOCAL ROLE app_authenticated;
END $$;

-- A pupil and a guardian of the school: nothing.
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000004')::text, true);
DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'GUARDIAN' THEN RAISE EXCEPTION 'duty links: expected the guardian'; END IF;
  SELECT count(*) INTO n FROM "TeacherDutySlots";
  IF n <> 0 THEN RAISE EXCEPTION 'duty links: a guardian reads % link(s)', n; END IF;
END $$;
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', (SELECT "authId" FROM "Users"
                             WHERE "schoolId" = app.current_school_id() AND role = 'STUDENT' AND "authId" IS NOT NULL
                             ORDER BY "authId" LIMIT 1))::text,
  true
);
DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'STUDENT' THEN RAISE EXCEPTION 'duty links: expected a pupil, am %', app.current_user_role(); END IF;
  SELECT count(*) INTO n FROM "TeacherDutySlots";
  IF n <> 0 THEN RAISE EXCEPTION 'duty links: a pupil reads % link(s)', n; END IF;
END $$;

-- School B's admin: their fixture uppdrag's link, made from its old column by
-- the trigger, and none of school A's.
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000006')::text, true);
DO $$
DECLARE n bigint; mine bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'SCHOOL_ADMIN' THEN RAISE EXCEPTION 'duty links: expected school B''s admin'; END IF;
  SELECT count(*) INTO n FROM "TeacherDutySlots";
  SELECT count(*) INTO mine FROM "TeacherDutySlots" s
    JOIN "TeacherDuties" d ON d.id = s."teacherDutyId" WHERE d.label = 'RLS fixture APT';
  IF mine <> 1 OR n <> 1 THEN
    RAISE EXCEPTION 'duty links: school B''s admin reads % link(s), % of them its fixture uppdrag''s; expected exactly that one', n, mine;
  END IF;
END $$;

-- The service principal, user cleared: no arm, no link.
SELECT set_config('request.jwt.claims', '', true);
SELECT set_config('app.service_school_id', :'school_a', true);
DO $$
DECLARE n bigint;
BEGIN
  IF app.current_service_school_id() IS NULL THEN RAISE EXCEPTION 'duty links: the service principal is not in force'; END IF;
  SELECT count(*) INTO n FROM "TeacherDutySlots";
  IF n <> 0 THEN RAISE EXCEPTION 'duty links: the service principal reads % link(s); no integration reads an uppdrag''s times', n; END IF;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 41: en länk pekar på uppdragslärarens egen veckotid, och tiden
-- förblir den (20261017090000).
--
-- 20261007090000's three rules, held for every link: the constraint is a
-- weekly UNAVAILABLE TEACHER row of the duty's own teacher (TD409 on the
-- link's INSERT for a colleague's, a ROOM's, a wish and a one-off date), a
-- duty moved to another teacher may not take its times along (TD409 on the
-- duty's UPDATE of userId), and a linked constraint keeps its shape under an
-- admin (TD409) and is the admin's under a teacher (TD403), found through
-- the link alone. A constraint of another school under a row stamped with
-- this one is the composite key's (23503), and a time is one uppdrag's (the
-- unique pair, 23505). A link is never updated: the API's two roles hold no
-- UPDATE on it.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
SELECT set_config('app.test_constraint_b', :'constraint_b', true);
DO $$
DECLARE
  school uuid := app.current_school_id();
  me uuid; colleague uuid; year uuid; room_c uuid;
  c_me uuid; c_col uuid; c_wish uuid; c_date uuid; d_me uuid; d_other uuid;
  n bigint;
BEGIN
  SELECT id INTO me FROM "Users" WHERE "schoolId" = school AND role = 'TEACHER' ORDER BY "authId" LIMIT 1;
  SELECT id INTO colleague FROM "Users" WHERE "schoolId" = school AND role = 'TEACHER' ORDER BY "authId" OFFSET 1 LIMIT 1;
  SELECT id INTO year FROM "AcademicYears" WHERE "schoolId" = school AND "isActive" LIMIT 1;
  SELECT id INTO room_c FROM "AvailabilityConstraints" WHERE "schoolId" = school AND "resourceType" = 'ROOM' LIMIT 1;
  IF room_c IS NULL THEN RAISE EXCEPTION 'duty link guards: the seed lacks a ROOM constraint'; END IF;

  INSERT INTO "AvailabilityConstraints" ("schoolId", "resourceType", "userId", "dayOfWeek", "startTime", "endTime", type, reason, "updatedAt")
  VALUES (school, 'TEACHER', me, 2, '15:00', '17:00', 'UNAVAILABLE', 'Uppdrag', now()) RETURNING id INTO c_me;
  INSERT INTO "AvailabilityConstraints" ("schoolId", "resourceType", "userId", "dayOfWeek", "startTime", "endTime", type, reason, "updatedAt")
  VALUES (school, 'TEACHER', colleague, 2, '15:00', '17:00', 'UNAVAILABLE', 'RLS41 kollegans', now()) RETURNING id INTO c_col;
  INSERT INTO "AvailabilityConstraints" ("schoolId", "resourceType", "userId", "dayOfWeek", "startTime", "endTime", type, reason, "updatedAt")
  VALUES (school, 'TEACHER', me, 3, '08:00', '09:00', 'PREFERRED_FREE', 'RLS41 önskemål', now()) RETURNING id INTO c_wish;
  INSERT INTO "AvailabilityConstraints" ("schoolId", "resourceType", "userId", "date", "startTime", "endTime", type, reason, "updatedAt")
  VALUES (school, 'TEACHER', me, DATE '2099-01-05', '08:00', '09:00', 'UNAVAILABLE', 'RLS41 en dag', now()) RETURNING id INTO c_date;
  INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "updatedAt")
  VALUES (school, me, year, 'APT_KONFERENS', 'RLS41 APT', 120, now()) RETURNING id INTO d_me;
  INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "updatedAt")
  VALUES (school, me, year, 'ANNAT', 'RLS41 annat', 30, now()) RETURNING id INTO d_other;

  -- The link the service writes: accepted.
  INSERT INTO "TeacherDutySlots" ("schoolId", "teacherDutyId", "availabilityConstraintId") VALUES (school, d_me, c_me);

  -- Every wrong target. Only TD409 is caught: any other error would mean the
  -- guard never got its say.
  BEGIN
    INSERT INTO "TeacherDutySlots" ("schoolId", "teacherDutyId", "availabilityConstraintId") VALUES (school, d_other, c_col);
    RAISE EXCEPTION 'duty link guards: a link took a colleague''s constraint as the uppdrag''s time';
  EXCEPTION WHEN SQLSTATE 'TD409' THEN NULL;
  END;
  BEGIN
    INSERT INTO "TeacherDutySlots" ("schoolId", "teacherDutyId", "availabilityConstraintId") VALUES (school, d_other, room_c);
    RAISE EXCEPTION 'duty link guards: a link took a ROOM constraint';
  EXCEPTION WHEN SQLSTATE 'TD409' THEN NULL;
  END;
  BEGIN
    INSERT INTO "TeacherDutySlots" ("schoolId", "teacherDutyId", "availabilityConstraintId") VALUES (school, d_other, c_wish);
    RAISE EXCEPTION 'duty link guards: a link took a PREFERRED_FREE wish';
  EXCEPTION WHEN SQLSTATE 'TD409' THEN NULL;
  END;
  BEGIN
    INSERT INTO "TeacherDutySlots" ("schoolId", "teacherDutyId", "availabilityConstraintId") VALUES (school, d_other, c_date);
    RAISE EXCEPTION 'duty link guards: a link took a one-off dated constraint as a weekly time';
  EXCEPTION WHEN SQLSTATE 'TD409' THEN NULL;
  END;
  -- Another school's constraint under this school's id: the key's 23503,
  -- not the guard describing school B's row to school A.
  BEGIN
    INSERT INTO "TeacherDutySlots" ("schoolId", "teacherDutyId", "availabilityConstraintId")
    VALUES (school, d_other, current_setting('app.test_constraint_b')::uuid);
    RAISE EXCEPTION 'duty link guards: a link reached another school''s constraint';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  -- One time, one uppdrag.
  BEGIN
    INSERT INTO "TeacherDutySlots" ("schoolId", "teacherDutyId", "availabilityConstraintId") VALUES (school, d_other, c_me);
    RAISE EXCEPTION 'duty link guards: one time was linked to two uppdrag';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- The duty moved to the colleague, its time along: refused.
  BEGIN
    UPDATE "TeacherDuties" SET "userId" = colleague WHERE id = d_me;
    RAISE EXCEPTION 'duty link guards: an uppdrag moved to a colleague took its teacher''s time with it';
  EXCEPTION WHEN SQLSTATE 'TD409' THEN NULL;
  END;
  -- A duty with no time may move (PostgREST can; the DTO cannot).
  UPDATE "TeacherDuties" SET "userId" = colleague WHERE id = d_other;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'duty link guards: a duty without a time could not move (% rows)', n; END IF;

  -- The linked constraint keeps its shape, found through the link alone.
  BEGIN
    UPDATE "AvailabilityConstraints" SET "userId" = colleague WHERE id = c_me;
    RAISE EXCEPTION 'duty link guards: a linked time moved to a colleague';
  EXCEPTION WHEN SQLSTATE 'TD409' THEN NULL;
  END;
  BEGIN
    UPDATE "AvailabilityConstraints" SET type = 'PREFERRED_FREE' WHERE id = c_me;
    RAISE EXCEPTION 'duty link guards: a linked time became a wish';
  EXCEPTION WHEN SQLSTATE 'TD409' THEN NULL;
  END;
  BEGIN
    UPDATE "AvailabilityConstraints" SET "dayOfWeek" = NULL, date = DATE '2099-01-06' WHERE id = c_me;
    RAISE EXCEPTION 'duty link guards: a linked weekly time became one date';
  EXCEPTION WHEN SQLSTATE 'TD409' THEN NULL;
  END;
  -- Retimed, it stays the same link: allowed.
  UPDATE "AvailabilityConstraints" SET "startTime" = '15:30' WHERE id = c_me;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'duty link guards: an admin could not retime a linked time'; END IF;

  PERFORM set_config('app.test_rls41_c_me', c_me::text, true);
END $$;

-- The teacher, under both roles: not their uppdrag's time (TD403), their own
-- other rows yes; and no UPDATE of a link for either role.
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', (SELECT "authId" FROM "Users"
                             WHERE "schoolId" = app.current_school_id() AND role = 'TEACHER'
                             ORDER BY "authId" LIMIT 1))::text,
  true
);
DO $$
DECLARE
  c_me uuid := current_setting('app.test_rls41_c_me')::uuid;
  via text; n bigint;
BEGIN
  FOREACH via IN ARRAY ARRAY['app_authenticated', 'authenticated'] LOOP
    EXECUTE format('SET LOCAL ROLE %I', via);
    BEGIN
      UPDATE "AvailabilityConstraints" SET "startTime" = '16:00' WHERE id = c_me;
      RAISE EXCEPTION 'duty link guards: through % a teacher moved the time their uppdrag holds', via;
    EXCEPTION WHEN SQLSTATE 'TD403' THEN NULL;
    END;
    BEGIN
      DELETE FROM "AvailabilityConstraints" WHERE id = c_me;
      RAISE EXCEPTION 'duty link guards: through % a teacher deleted the time their uppdrag holds', via;
    EXCEPTION WHEN SQLSTATE 'TD403' THEN NULL;
    END;
    UPDATE "AvailabilityConstraints" SET reason = 'RLS41 eget' WHERE reason = 'RLS41 önskemål';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN RAISE EXCEPTION 'duty link guards: through % a teacher lost their own wish (% rows)', via, n; END IF;
    UPDATE "AvailabilityConstraints" SET reason = 'RLS41 önskemål' WHERE reason = 'RLS41 eget';
  END LOOP;
  SET LOCAL ROLE app_authenticated;
END $$;

SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
DECLARE via text;
BEGIN
  FOREACH via IN ARRAY ARRAY['app_authenticated', 'authenticated'] LOOP
    EXECUTE format('SET LOCAL ROLE %I', via);
    BEGIN
      UPDATE "TeacherDutySlots" SET "createdAt" = now();
      RAISE EXCEPTION 'duty link guards: through % an admin updated a link; a link is deleted and made again', via;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
  END LOOP;
  SET LOCAL ROLE app_authenticated;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 42: en tid går med sin länk, och en länk med sin tid och sitt
-- uppdrag (20261017090000).
--
-- A link removed takes its constraint (no weekly UNAVAILABLE row outlives the
-- uppdrag time it was); a constraint the admin deletes takes its link and
-- leaves the uppdrag; a duty deleted takes its links and their constraints.
-- The old one-time column's half of this section, a write of it becoming a
-- link, went with that trigger (20261022090000); section 90 holds the column
-- to meaning nothing.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
DECLARE
  school uuid := app.current_school_id();
  me uuid; year uuid;
  c1 uuid; c2 uuid; c3 uuid; c4 uuid; d1 uuid; d2 uuid; d3 uuid;
  n bigint;
BEGIN
  SELECT id INTO me FROM "Users" WHERE "schoolId" = school AND role = 'TEACHER' ORDER BY "authId" LIMIT 1;
  SELECT id INTO year FROM "AcademicYears" WHERE "schoolId" = school AND "isActive" LIMIT 1;
  FOR n IN 1..4 LOOP
    INSERT INTO "AvailabilityConstraints" ("schoolId", "resourceType", "userId", "dayOfWeek", "startTime", "endTime", type, reason, "updatedAt")
    VALUES (school, 'TEACHER', me, n, '07:30', '07:55', 'UNAVAILABLE', 'RLS42 ' || n, now());
  END LOOP;
  SELECT id INTO c1 FROM "AvailabilityConstraints" WHERE reason = 'RLS42 1';
  SELECT id INTO c2 FROM "AvailabilityConstraints" WHERE reason = 'RLS42 2';
  SELECT id INTO c3 FROM "AvailabilityConstraints" WHERE reason = 'RLS42 3';
  SELECT id INTO c4 FROM "AvailabilityConstraints" WHERE reason = 'RLS42 4';
  INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "updatedAt")
  VALUES (school, me, year, 'RASTVAKT', 'RLS42 morgonvakt', 60, now()) RETURNING id INTO d1;
  INSERT INTO "TeacherDutySlots" ("schoolId", "teacherDutyId", "availabilityConstraintId") VALUES (school, d1, c1), (school, d1, c2);

  -- A link removed: its constraint goes, the uppdrag stays.
  DELETE FROM "TeacherDutySlots" WHERE "availabilityConstraintId" = c1;
  SELECT count(*) INTO n FROM "AvailabilityConstraints" WHERE id = c1;
  IF n <> 0 THEN RAISE EXCEPTION 'duty link cleanup: a removed link left its time as a plain UNAVAILABLE row'; END IF;
  -- A constraint deleted: its link goes, the uppdrag stays.
  DELETE FROM "AvailabilityConstraints" WHERE id = c2;
  SELECT count(*) INTO n FROM "TeacherDutySlots" WHERE "teacherDutyId" = d1;
  IF n <> 0 THEN RAISE EXCEPTION 'duty link cleanup: a deleted time left % link(s)', n; END IF;
  SELECT count(*) INTO n FROM "TeacherDuties" WHERE id = d1;
  IF n <> 1 THEN RAISE EXCEPTION 'duty link cleanup: deleting a time deleted its uppdrag'; END IF;

  -- Two more uppdrag, one time each.
  INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "updatedAt")
  VALUES (school, me, year, 'APT_KONFERENS', 'RLS42 APT', 90, now()) RETURNING id INTO d2;
  INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "updatedAt")
  VALUES (school, me, year, 'ANNAT', 'RLS42 annat', 30, now()) RETURNING id INTO d3;
  INSERT INTO "TeacherDutySlots" ("schoolId", "teacherDutyId", "availabilityConstraintId") VALUES (school, d2, c3), (school, d3, c4);

  -- A duty deleted: its links and their constraints with it.
  DELETE FROM "TeacherDuties" WHERE id IN (d2, d3);
  SELECT count(*) INTO n FROM "AvailabilityConstraints" WHERE id IN (c3, c4);
  IF n <> 0 THEN RAISE EXCEPTION 'duty link cleanup: deleted uppdrag left % time(s) behind', n; END IF;
  SELECT count(*) INTO n FROM "TeacherDutySlots" WHERE "teacherDutyId" IN (d2, d3);
  IF n <> 0 THEN RAISE EXCEPTION 'duty link cleanup: deleted uppdrag left % link(s)', n; END IF;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 43: ett uppdrags tider är en version, en per sats och uppdrag
-- (20261017090000).
--
-- The history (20261010090000) logs the duty row; the times live in the link
-- table, so a statement adding or removing links writes ONE DUTY UPDATE
-- version per uppdrag it touched, {"slotCount": before} -> {"slotCount":
-- after}, by the admin. A duty created with three times is its CREATE and
-- one "0 -> 3"; two removed in one statement one "3 -> 1"; a deleted duty is
-- its DELETE alone, its links' cascade adding nothing. blockedConstraintId is
-- no longer logged (and retired since 20261022090000): a time the admin
-- deletes on tillgänglighet is the link's removal, one version.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
DECLARE
  school uuid := app.current_school_id();
  admin uuid := app.current_user_id();
  me uuid; colleague uuid; y uuid;
  c1 uuid; c2 uuid; c3 uuid; c4 uuid; d1 uuid; d2 uuid;
  got text; n bigint;
BEGIN
  SELECT id INTO me FROM "Users" WHERE "schoolId" = school AND role = 'TEACHER' ORDER BY "authId" LIMIT 1;
  SELECT id INTO colleague FROM "Users" WHERE "schoolId" = school AND role = 'TEACHER' ORDER BY "authId" OFFSET 1 LIMIT 1;
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
  VALUES (school, 'RLS43 år', DATE '2100-08-16', DATE '2101-06-10', false, now()) RETURNING id INTO y;
  FOR n IN 1..3 LOOP
    INSERT INTO "AvailabilityConstraints" ("schoolId", "resourceType", "userId", "dayOfWeek", "startTime", "endTime", type, reason, "updatedAt")
    VALUES (school, 'TEACHER', me, (n * 2) - 1, '12:00', '12:20', 'UNAVAILABLE', 'RLS43 ' || n, now());
  END LOOP;
  INSERT INTO "AvailabilityConstraints" ("schoolId", "resourceType", "userId", "dayOfWeek", "startTime", "endTime", type, reason, "updatedAt")
  VALUES (school, 'TEACHER', colleague, 2, '12:00', '12:20', 'UNAVAILABLE', 'RLS43 kollegans', now()) RETURNING id INTO c4;
  SELECT id INTO c1 FROM "AvailabilityConstraints" WHERE reason = 'RLS43 1';
  SELECT id INTO c2 FROM "AvailabilityConstraints" WHERE reason = 'RLS43 2';
  SELECT id INTO c3 FROM "AvailabilityConstraints" WHERE reason = 'RLS43 3';

  INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "updatedAt")
  VALUES (school, me, y, 'RASTVAKT', 'RLS43 rastvakt', 60, now()) RETURNING id INTO d1;
  INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "updatedAt")
  VALUES (school, colleague, y, 'RASTVAKT', 'RLS43 kollegans rastvakt', 20, now()) RETURNING id INTO d2;
  -- One statement, two uppdrag: one version each.
  INSERT INTO "TeacherDutySlots" ("schoolId", "teacherDutyId", "availabilityConstraintId")
  VALUES (school, d1, c1), (school, d1, c2), (school, d1, c3), (school, d2, c4);
  -- Two removed in one statement.
  DELETE FROM "TeacherDutySlots" WHERE "availabilityConstraintId" IN (c1, c3);

  SELECT string_agg(format('%s:%s:%s:%s', version, action, coalesce(before::text, '-'), coalesce(after::text, '-')), ' | ' ORDER BY version)
    INTO got FROM "TeacherEmploymentLogs" WHERE "userId" = me AND "academicYearId" = y;
  IF got IS DISTINCT FROM concat_ws(' | ',
       format('1:CREATE:-:%s', (SELECT after::text FROM "TeacherEmploymentLogs" WHERE "entityId" = d1 AND version = 1)),
       '2:UPDATE:{"slotCount": 0}:{"slotCount": 3}',
       '3:UPDATE:{"slotCount": 3}:{"slotCount": 1}') THEN
    RAISE EXCEPTION 'times history: the first teacher''s versions are %', got;
  END IF;
  SELECT count(*) INTO n FROM "TeacherEmploymentLogs"
   WHERE "userId" = colleague AND "academicYearId" = y AND version = 2 AND entity = 'DUTY' AND action = 'UPDATE'
     AND "entityId" = d2 AND after = '{"slotCount": 1}'::jsonb AND before = '{"slotCount": 0}'::jsonb AND "actorId" = admin;
  IF n <> 1 THEN RAISE EXCEPTION 'times history: the colleague''s link in the same statement is not one version of its own'; END IF;
  SELECT count(*) INTO n FROM "TeacherEmploymentLogs"
   WHERE "academicYearId" = y AND ("actorId" IS DISTINCT FROM admin OR COALESCE(before, after) ? 'blockedConstraintId');
  IF n <> 0 THEN RAISE EXCEPTION 'times history: % version(s) without the admin as actor, or logging blockedConstraintId', n; END IF;

  -- The time deleted on its constraint: the link's cascade is one version.
  DELETE FROM "AvailabilityConstraints" WHERE id = c2;
  SELECT string_agg(format('%s:%s:%s', version, action, coalesce(after::text, '-')), ' | ' ORDER BY version)
    INTO got FROM "TeacherEmploymentLogs" WHERE "userId" = me AND "academicYearId" = y AND version > 3;
  IF got IS DISTINCT FROM '4:UPDATE:{"slotCount": 0}' THEN
    RAISE EXCEPTION 'times history: deleting a linked time wrote %', got;
  END IF;

  -- A duty deleted with its links: its DELETE alone.
  DELETE FROM "TeacherDuties" WHERE id = d2;
  SELECT string_agg(format('%s:%s', version, action), ' | ' ORDER BY version)
    INTO got FROM "TeacherEmploymentLogs" WHERE "userId" = colleague AND "academicYearId" = y;
  IF got IS DISTINCT FROM '1:CREATE | 2:UPDATE | 3:DELETE' THEN
    RAISE EXCEPTION 'times history: deleting an uppdrag with a time wrote %', got;
  END IF;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 44: ett uppdrags Till ligger inte före dess Från (20261017090000).
--
-- TeacherDuties_dates_are_ordered, for every writer: Till before Från is a
-- 23514; the same day, one bound alone and none are accepted. That the dates
-- lie inside the läsår is the service's (academic-year-bounds.ts), as for a
-- requirement's period, and not asserted here.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
DECLARE
  school uuid := app.current_school_id();
  me uuid; year uuid; n bigint;
BEGIN
  SELECT id INTO me FROM "Users" WHERE "schoolId" = school AND role = 'TEACHER' ORDER BY "authId" LIMIT 1;
  SELECT id INTO year FROM "AcademicYears" WHERE "schoolId" = school AND "isActive" LIMIT 1;
  BEGIN
    INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "validFrom", "validTo", "updatedAt")
    VALUES (school, me, year, 'MENTORSKAP', 'RLS44 baklänges', 90, DATE '2027-01-07', DATE '2026-12-18', now());
    RAISE EXCEPTION 'duty dates: an uppdrag ending before it starts was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "validFrom", "validTo", "updatedAt")
  VALUES (school, me, year, 'ANNAT', 'RLS44 en dag', 30, DATE '2027-03-01', DATE '2027-03-01', now()),
         (school, me, year, 'MENTORSKAP', 'RLS44 till jul', 90, NULL, DATE '2026-12-18', now()),
         (school, me, year, 'MENTORSKAP', 'RLS44 från januari', 90, DATE '2027-01-07', NULL, now());
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 3 THEN RAISE EXCEPTION 'duty dates: % of three ordered uppdrag stored', n; END IF;
  BEGIN
    UPDATE "TeacherDuties" SET "validTo" = DATE '2027-01-06' WHERE label = 'RLS44 från januari';
    RAISE EXCEPTION 'duty dates: an UPDATE put Till before Från';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 45: länktabellen börjar som en ny tabell ska (20261017090000).
--
-- Row security on, and the grants of a table created after 20261016130000:
-- the API role reads, inserts and deletes and never updates (a link is
-- deleted and made again); PostgREST's role likewise has no UPDATE; anon
-- holds nothing and service_role SELECT alone. Sections 36 to 38 hold every
-- table to the general rule; this holds the link table to its own.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  rel regclass := '"TeacherDutySlots"'::regclass;
  wrong text;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = rel) THEN
    RAISE EXCEPTION 'link table rights: TeacherDutySlots has row security off';
  END IF;
  SELECT string_agg(item, ', ') INTO wrong FROM (
    SELECT format('%s %s %s', r, p, has_table_privilege(r, rel, p)) AS item
      FROM (VALUES ('app_authenticated', 'SELECT', true), ('app_authenticated', 'INSERT', true),
                   ('app_authenticated', 'DELETE', true), ('app_authenticated', 'UPDATE', false),
                   ('authenticated', 'UPDATE', false), ('authenticated', 'TRUNCATE', false),
                   ('authenticated', 'REFERENCES', false), ('authenticated', 'TRIGGER', false))
           AS t(r, p, expected)
     WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)
       AND has_table_privilege(r, rel, p) IS DISTINCT FROM expected
  ) x;
  IF wrong IS NOT NULL THEN
    RAISE EXCEPTION 'link table rights: %', wrong;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND has_any_column_privilege('anon', rel, 'SELECT') THEN
    RAISE EXCEPTION 'link table rights: anon reads TeacherDutySlots';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
     AND (has_table_privilege('service_role', rel, 'INSERT') OR has_table_privilege('service_role', rel, 'UPDATE')
          OR has_table_privilege('service_role', rel, 'DELETE')) THEN
    RAISE EXCEPTION 'link table rights: service_role writes TeacherDutySlots';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Section 50: en notis om en lektion når alla på lektionen.
--
-- Notiser som når fram (20261018090000). Every lesson notice reads its
-- roster through one reader (src/calendar/lesson-roster.ts): the home class
-- of the lesson's class and of every group joined to it, the members of
-- those groups (StudentGroupMembers) and the pupils named on the lesson
-- (CalendarLessonStudents), then their guardians (GuardianStudents). The
-- reads run under the caller's RLS. Most callers are admins, but a TEACHER
-- who withdraws or shortens their own absence undoes the board's decisions
-- in their own transaction, and the class notices that the undo sends
-- (LESSON_REINSTATED) are read and written as that teacher. A policy that
-- hid one source from a teacher would cut people silently from the notice
-- and fail nothing.
--
-- 50a, as an admin, plants one lesson that a pupil reaches each way: a
-- home-class pupil, a member of a teaching group joined to the lesson, and a
-- named pupil with a guardian. 50b, as a teacher on that lesson, runs the
-- reader's statements as Prisma sends them, finds all three and the
-- guardian, and writes the three new types for them without reading them
-- back. 50c, as the guardian and as the named pupil, reads its own rows of
-- the new types, and the guardian opts out of each of them (the
-- NotificationOptOuts CHECKs refuse only the two notices the school must
-- deliver). The delivery's door, app.delivery_opt_outs, answers the opt-outs
-- by type.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
DECLARE
  school uuid := app.current_school_id();
  y uuid; y_start date;
  home_class uuid; grp uuid; lesson uuid;
  p_home uuid; p_member uuid; p_named uuid; teacher uuid; guardian uuid;
BEGIN
  SELECT id, "startDate" INTO y, y_start FROM "AcademicYears" WHERE "schoolId" = school AND "isActive";
  SELECT u.id, u."studentGroupId" INTO p_home, home_class FROM "Users" u
   WHERE u."schoolId" = school AND u.role = 'STUDENT' AND u."isActive" AND u."studentGroupId" IS NOT NULL
   ORDER BY u.id LIMIT 1;
  SELECT u.id INTO p_member FROM "Users" u
   WHERE u."schoolId" = school AND u.role = 'STUDENT' AND u."isActive" AND u."studentGroupId" IS DISTINCT FROM home_class
   ORDER BY u.id LIMIT 1;
  SELECT u.id INTO p_named FROM "Users" u
   WHERE u."schoolId" = school AND u.role = 'STUDENT' AND u."isActive" AND u."authId" IS NOT NULL
     AND u."studentGroupId" IS DISTINCT FROM home_class AND u.id <> p_member
   ORDER BY u.id LIMIT 1;
  SELECT id INTO teacher FROM "Users"
   WHERE "schoolId" = school AND role = 'TEACHER' AND "isActive" AND "authId" IS NOT NULL ORDER BY "authId" LIMIT 1;
  SELECT id INTO guardian FROM "Users"
   WHERE "schoolId" = school AND role = 'GUARDIAN' AND "isActive" AND "authId" IS NOT NULL ORDER BY "authId" LIMIT 1;
  IF y IS NULL OR p_home IS NULL OR p_member IS NULL OR p_named IS NULL OR teacher IS NULL OR guardian IS NULL THEN
    RAISE EXCEPTION 'roster: the fixtures lack a year, three pupils, a teacher or a guardian to test with';
  END IF;

  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "updatedAt")
  VALUES (school, y, 'RLS50 nivågrupp', 'TEACHING_GROUP', now()) RETURNING id INTO grp;
  INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES (school, grp, p_member);
  INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", "updatedAt")
  SELECT school, s.id, home_class, y_start, y_start::timestamptz + interval '5 hours', y_start::timestamptz + interval '6 hours', now()
    FROM "Subjects" s WHERE s."schoolId" = school ORDER BY s.id LIMIT 1
  RETURNING id INTO lesson;
  INSERT INTO "CalendarLessonGroups" ("schoolId", "calendarLessonId", "studentGroupId") VALUES (school, lesson, grp);
  INSERT INTO "CalendarLessonStudents" ("schoolId", "calendarLessonId", "studentId") VALUES (school, lesson, p_named);
  INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role) VALUES (school, lesson, teacher, 'LEAD');
  INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId") VALUES (school, guardian, p_named)
  ON CONFLICT ("guardianId", "studentId") DO NOTHING;

  PERFORM set_config('app.test_rls50_lesson', lesson::text, true);
  PERFORM set_config('app.test_rls50_pupils', array_to_string(ARRAY[p_home, p_member, p_named], ','), true);
  PERFORM set_config('app.test_rls50_guardian', guardian::text, true);
  PERFORM set_config('app.test_rls50_teacher_sub', (SELECT "authId"::text FROM "Users" WHERE id = teacher), true);
  PERFORM set_config('app.test_rls50_guardian_sub', (SELECT "authId"::text FROM "Users" WHERE id = guardian), true);
  PERFORM set_config('app.test_rls50_pupil_sub', (SELECT "authId"::text FROM "Users" WHERE id = p_named), true);
END $$;

SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls50_teacher_sub'))::text, true);
DO $$
DECLARE
  lesson   uuid := current_setting('app.test_rls50_lesson')::uuid;
  expected uuid[] := string_to_array(current_setting('app.test_rls50_pupils'), ',')::uuid[];
  guardian uuid := current_setting('app.test_rls50_guardian')::uuid;
  groups uuid[]; named uuid[]; pupils uuid[]; guardians uuid[];
  missing text;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'TEACHER' THEN RAISE EXCEPTION 'roster: expected a TEACHER'; END IF;
  SELECT array_agg(g) INTO groups FROM (
    SELECT "studentGroupId" AS g FROM "CalendarLessons" WHERE id = lesson
    UNION SELECT "studentGroupId" FROM "CalendarLessonGroups" WHERE "calendarLessonId" = lesson) x;
  IF coalesce(cardinality(groups), 0) <> 2 THEN
    RAISE EXCEPTION 'roster: a teacher reads % of the lesson''s class and its joined group, expected 2', coalesce(cardinality(groups), 0);
  END IF;
  SELECT array_agg("studentId") INTO named FROM "CalendarLessonStudents" WHERE "calendarLessonId" = lesson;
  -- lesson-roster.ts, ACTIVE: three sources, active pupils only.
  SELECT array_agg(DISTINCT id) INTO pupils FROM (
    SELECT id FROM "Users" WHERE "studentGroupId" = ANY (groups) AND role = 'STUDENT' AND "isActive"
    UNION
    SELECT m."studentId" FROM "StudentGroupMembers" m
     WHERE m."studentGroupId" = ANY (groups)
       AND EXISTS (SELECT 1 FROM "Users" u WHERE u.id = m."studentId" AND u.role = 'STUDENT' AND u."isActive")
    UNION
    SELECT id FROM "Users" WHERE id = ANY (coalesce(named, '{}')) AND role = 'STUDENT' AND "isActive") x;
  SELECT string_agg(e::text, ', ') INTO missing FROM unnest(expected) e WHERE NOT (e = ANY (coalesce(pupils, '{}')));
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'roster: a teacher''s transaction does not reach % of the lesson''s pupils (home class, teaching group, named): %',
      cardinality(string_to_array(missing, ', ')), missing;
  END IF;
  SELECT array_agg(DISTINCT "guardianId") INTO guardians FROM "GuardianStudents" WHERE "studentId" = ANY (pupils);
  IF NOT (guardian = ANY (coalesce(guardians, '{}'))) THEN
    RAISE EXCEPTION 'roster: a teacher''s transaction does not reach the named pupil''s guardian';
  END IF;
  -- The class notices, written without RETURNING as notifyUsers writes them.
  INSERT INTO "Notifications" (id, "schoolId", "userId", type, meta)
  SELECT gen_random_uuid(), app.current_school_id(), u, t, '{"subjectName": "RLS50"}'::jsonb
    FROM unnest(expected || guardian) u
   CROSS JOIN unnest(ARRAY['LESSON_REINSTATED', 'LESSON_SUPERVISED_STUDY', 'CANCELLATION_DIGEST']::"NotificationType"[]) t;
END $$;

SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls50_guardian_sub'))::text, true);
DO $$
DECLARE
  n bigint;
  types "NotificationType"[] := ARRAY['LESSON_REINSTATED', 'LESSON_SUPERVISED_STUDY', 'CANCELLATION_DIGEST']::"NotificationType"[];
  t "NotificationType";
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'GUARDIAN' THEN RAISE EXCEPTION 'roster: expected a GUARDIAN'; END IF;
  SELECT count(*) INTO n FROM "Notifications" WHERE "userId" = app.current_user_id() AND type = ANY (types) AND meta->>'subjectName' = 'RLS50';
  IF n <> 3 THEN RAISE EXCEPTION 'roster: the guardian reads % of their own three new notices', n; END IF;
  INSERT INTO "NotificationOptOuts" ("userId", "schoolId", type)
  SELECT app.current_user_id(), app.current_school_id(), x FROM unnest(types) x;
  FOREACH t IN ARRAY types LOOP
    SELECT count(*) INTO n FROM app.delivery_opt_outs(app.current_school_id(), ARRAY[app.current_user_id()], t) u
     WHERE u = app.current_user_id();
    IF n <> 1 THEN RAISE EXCEPTION 'roster: the delivery does not see the guardian''s opt-out of %', t; END IF;
  END LOOP;
END $$;

SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls50_pupil_sub'))::text, true);
DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'STUDENT' THEN RAISE EXCEPTION 'roster: expected a STUDENT'; END IF;
  SELECT count(*) INTO n FROM "Notifications"
   WHERE type IN ('LESSON_REINSTATED', 'LESSON_SUPERVISED_STUDY', 'CANCELLATION_DIGEST') AND meta->>'subjectName' = 'RLS50';
  IF n <> 3 THEN RAISE EXCEPTION 'roster: the named pupil reads % new notice(s), expected their own three', n; END IF;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 51: en avbokning minns om den berättade.
--
-- CancellationBatches.notifies (20261018091000): whether a batch sent its
-- digest, so its reversal sends one too. A batch written without it (every
-- batch before the column, and one from a gateway that predates it) is
-- false, never null. The admin writes it; a teacher, who reads no batch at
-- all (27g), changes none.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
DECLARE
  school uuid := app.current_school_id();
  y uuid; y_start date; quiet uuid; told uuid; flag boolean;
BEGIN
  SELECT id, "startDate" INTO y, y_start FROM "AcademicYears" WHERE "schoolId" = school AND "isActive";
  INSERT INTO "CancellationBatches" ("schoolId", "academicYearId", name, cause, "fromDate", "toDate", scope)
  VALUES (school, y, 'RLS51 tyst', 'EVENT', y_start, y_start, 'SCHOOL') RETURNING id INTO quiet;
  SELECT notifies INTO flag FROM "CancellationBatches" WHERE id = quiet;
  IF flag IS DISTINCT FROM false THEN RAISE EXCEPTION 'notifies: a batch written without it is %, expected false', flag; END IF;
  INSERT INTO "CancellationBatches" ("schoolId", "academicYearId", name, cause, "fromDate", "toDate", scope, notifies)
  VALUES (school, y, 'RLS51 berättade', 'EVENT', y_start, y_start, 'SCHOOL', true) RETURNING id INTO told;
  SELECT notifies INTO flag FROM "CancellationBatches" WHERE id = told;
  IF flag IS DISTINCT FROM true THEN RAISE EXCEPTION 'notifies: the admin''s true reads back as %', flag; END IF;
  BEGIN
    UPDATE "CancellationBatches" SET notifies = NULL WHERE id = quiet;
    RAISE EXCEPTION 'notifies: a batch was stored with no answer';
  EXCEPTION WHEN not_null_violation THEN NULL;
  END;
  PERFORM set_config('app.test_rls51_batch', quiet::text, true);
  PERFORM set_config('app.test_rls51_teacher_sub', (SELECT "authId"::text FROM "Users"
    WHERE "schoolId" = school AND role = 'TEACHER' AND "isActive" AND "authId" IS NOT NULL ORDER BY "authId" LIMIT 1), true);
END $$;

SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls51_teacher_sub'))::text, true);
DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'TEACHER' THEN RAISE EXCEPTION 'notifies: expected a TEACHER'; END IF;
  -- No WHERE and no column read: a WHERE would apply the SELECT arms too,
  -- and an UPDATE-only leak would then update nothing and pass.
  UPDATE "CancellationBatches" SET notifies = true;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'notifies: a teacher made a batch tell its people'; END IF;
END $$;

SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
DECLARE flag boolean;
BEGIN
  SELECT notifies INTO flag FROM "CancellationBatches" WHERE id = current_setting('app.test_rls51_batch')::uuid;
  IF flag IS DISTINCT FROM false THEN RAISE EXCEPTION 'notifies: the batch reads % after the teacher''s write', flag; END IF;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 60: ett ämne fördelar sina lektioner över veckan.
--
-- 20261019090000 adds the ämnesfördelning: Subjects."maxLessonsPerDay" and
-- "minDaysBetween", nullable, and the same two on TeachingRequirements beside
-- "ownDistribution" NOT NULL DEFAULT false. No policy changes — every arm on
-- both tables is a row predicate that names no column — so what is held here
-- is that the CHECKs hold for every writer, the admin's PostgREST role
-- included, which meets no DTO: the bounds are legal, the values past them
-- are refused by name, a fresh row reads no rule, and a timplanspost that
-- follows its subject cannot carry numbers of its own.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'admin_auth_id')::text,
  true
);
DO $$
DECLARE
  via text;
  school uuid;
  year uuid;
  grp uuid;
  s uuid;
  r uuid;
  perday int;
  apart int;
  own boolean;
  con text;
  bad record;
BEGIN
  FOREACH via IN ARRAY ARRAY['app_authenticated', 'authenticated'] LOOP
    EXECUTE format('SET LOCAL ROLE %I', via);
    IF current_user <> via THEN
      RAISE EXCEPTION 'fördelning: running as %, not %', current_user, via;
    END IF;
    school := app.current_school_id();
    SELECT id INTO year FROM "AcademicYears" WHERE "schoolId" = school ORDER BY id LIMIT 1;
    SELECT id INTO grp FROM "StudentGroups" WHERE "academicYearId" = year ORDER BY id LIMIT 1;
    IF year IS NULL OR grp IS NULL THEN
      RAISE EXCEPTION 'fördelning (%): the seed has no year or class to hang a timplanspost on', via;
    END IF;

    INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt")
    VALUES (school, 'RLS60 idrott ' || via, 'RLS60' || left(via, 3), now())
    RETURNING id, "maxLessonsPerDay", "minDaysBetween" INTO s, perday, apart;
    IF perday IS NOT NULL OR apart IS NOT NULL THEN
      RAISE EXCEPTION 'fördelning (%): a new subject reads a rule (%, %), expected none', via, perday, apart;
    END IF;
    UPDATE "Subjects" SET "maxLessonsPerDay" = 1, "minDaysBetween" = 2 WHERE id = s;
    UPDATE "Subjects" SET "maxLessonsPerDay" = 20, "minDaysBetween" = 6 WHERE id = s;
    UPDATE "Subjects" SET "maxLessonsPerDay" = NULL, "minDaysBetween" = NULL WHERE id = s;
    FOR bad IN
      SELECT * FROM (VALUES
        (0, NULL::int, 'Subjects_max_lessons_per_day_is_sane'),
        (21, NULL, 'Subjects_max_lessons_per_day_is_sane'),
        (NULL, 1, 'Subjects_min_days_between_is_sane'),
        (NULL, 7, 'Subjects_min_days_between_is_sane')
      ) AS t(perday, apart, name)
    LOOP
      BEGIN
        UPDATE "Subjects" SET "maxLessonsPerDay" = bad.perday, "minDaysBetween" = bad.apart WHERE id = s;
        RAISE EXCEPTION 'fördelning (%): the subject stored (%, %)', via, bad.perday, bad.apart;
      EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS con = CONSTRAINT_NAME;
        IF con IS DISTINCT FROM bad.name THEN
          RAISE EXCEPTION 'fördelning (%): (%, %) on the subject was refused by "%", expected %', via, bad.perday, bad.apart, con, bad.name;
        END IF;
      END;
    END LOOP;

    INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "updatedAt")
    VALUES (school, year, s, grp, now())
    RETURNING id, "ownDistribution", "maxLessonsPerDay", "minDaysBetween" INTO r, own, perday, apart;
    IF own IS DISTINCT FROM false OR perday IS NOT NULL OR apart IS NOT NULL THEN
      RAISE EXCEPTION 'fördelning (%): a new timplanspost reads (%, %, %), expected (false, null, null)', via, own, perday, apart;
    END IF;
    -- Its own rule, its own rule of none, and back to the subject.
    UPDATE "TeachingRequirements" SET "ownDistribution" = true, "maxLessonsPerDay" = 2, "minDaysBetween" = 3 WHERE id = r;
    UPDATE "TeachingRequirements" SET "maxLessonsPerDay" = NULL, "minDaysBetween" = NULL WHERE id = r;
    UPDATE "TeachingRequirements" SET "ownDistribution" = false WHERE id = r;
    FOR bad IN
      SELECT * FROM (VALUES
        (false, 1, NULL::int, 'TeachingRequirements_distribution_is_own_or_absent'),
        (false, NULL, 2, 'TeachingRequirements_distribution_is_own_or_absent'),
        (true, 0, NULL, 'TeachingRequirements_max_lessons_per_day_is_sane'),
        (true, 21, NULL, 'TeachingRequirements_max_lessons_per_day_is_sane'),
        (true, NULL, 1, 'TeachingRequirements_min_days_between_is_sane'),
        (true, NULL, 7, 'TeachingRequirements_min_days_between_is_sane')
      ) AS t(own, perday, apart, name)
    LOOP
      BEGIN
        UPDATE "TeachingRequirements"
           SET "ownDistribution" = bad.own, "maxLessonsPerDay" = bad.perday, "minDaysBetween" = bad.apart
         WHERE id = r;
        RAISE EXCEPTION 'fördelning (%): the timplanspost stored (%, %, %)', via, bad.own, bad.perday, bad.apart;
      EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS con = CONSTRAINT_NAME;
        IF con IS DISTINCT FROM bad.name THEN
          RAISE EXCEPTION 'fördelning (%): (%, %, %) on the timplanspost was refused by "%", expected %', via, bad.own, bad.perday, bad.apart, con, bad.name;
        END IF;
      END;
    END LOOP;
    -- Switching back to the subject while numbers remain is the same refusal:
    -- the row would carry a rule nothing reads.
    UPDATE "TeachingRequirements" SET "ownDistribution" = true, "maxLessonsPerDay" = 1 WHERE id = r;
    BEGIN
      UPDATE "TeachingRequirements" SET "ownDistribution" = false WHERE id = r;
      RAISE EXCEPTION 'fördelning (%): a timplanspost went back to its subject still carrying its own cap', via;
    EXCEPTION WHEN check_violation THEN
      GET STACKED DIAGNOSTICS con = CONSTRAINT_NAME;
      IF con IS DISTINCT FROM 'TeachingRequirements_distribution_is_own_or_absent' THEN
        RAISE EXCEPTION 'fördelning (%): the switch back was refused by "%"', via, con;
      END IF;
    END;
  END LOOP;
  SET LOCAL ROLE app_authenticated;
END
$$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 70: en skolas inloggning med skolkonto är skolans administratörs
-- (SchoolSignInMethods, 20261020090000).
--
-- The row says how a school's people may sign in with their school account
-- and pins the access-token hook to the school's Entra tenant or Google
-- Workspace. A teacher who could turn ssoOnlyForStaff off, or an admin of
-- another school who could change the tenant, would decide who may sign in
-- at a school that is not theirs. So: the school's admin reads and writes
-- the row through the API's role; through PostgREST's role the admin reads
-- it and writes nothing; nobody else in the school reads it; nobody reaches
-- the other school's row, which the fixtures plant (Entra, SSO-only).
-- ---------------------------------------------------------------------------

BEGIN;

SELECT set_config('app.test_rls70_school_b', :'school_b', true);
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);

-- 70a: school A's admin.
DO $$
DECLARE
  school uuid := app.current_school_id();
  school_b uuid := current_setting('app.test_rls70_school_b')::uuid;
  via text; n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'SCHOOL_ADMIN' THEN RAISE EXCEPTION 'sign-in methods: expected school A''s SCHOOL_ADMIN'; END IF;
  PERFORM set_config('app.test_rls70_school', school::text, true);
  PERFORM set_config('app.test_rls70_teacher_sub', coalesce((SELECT "authId"::text FROM "Users" WHERE "schoolId" = school AND role = 'TEACHER' AND "isActive" ORDER BY "authId" LIMIT 1), ''), true);
  PERFORM set_config('app.test_rls70_pupil_sub', coalesce((SELECT "authId"::text FROM "Users" WHERE "schoolId" = school AND role = 'STUDENT' AND "isActive" ORDER BY "authId" LIMIT 1), ''), true);
  IF current_setting('app.test_rls70_teacher_sub') = '' OR current_setting('app.test_rls70_pupil_sub') = '' THEN
    RAISE EXCEPTION 'sign-in methods: school A has no active teacher or pupil to ask';
  END IF;

  FOREACH via IN ARRAY ARRAY['app_authenticated', 'authenticated'] LOOP
    EXECUTE format('SET LOCAL ROLE %I', via);
    IF current_user <> via THEN RAISE EXCEPTION 'sign-in methods: running as %, not %', current_user, via; END IF;
    SELECT count(*) INTO n FROM "SchoolSignInMethods";
    IF n <> 0 THEN RAISE EXCEPTION 'sign-in methods: through % school A''s admin reads % row(s) before school A has one', via, n; END IF;
  END LOOP;

  -- The API's role writes the school's own row, all four ways.
  SET LOCAL ROLE app_authenticated;
  INSERT INTO "SchoolSignInMethods" ("schoolId", provider, domains, "googleHostedDomain", "updatedAt")
  VALUES (school, 'google', ARRAY['rls70-a.example'], 'rls70-a.example', now());
  UPDATE "SchoolSignInMethods" SET "ssoOnlyForStaff" = true, "updatedAt" = now() WHERE "schoolId" = school;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'sign-in methods: the admin updated % of the school''s row', n; END IF;
  DELETE FROM "SchoolSignInMethods" WHERE "schoolId" = school;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'sign-in methods: the admin deleted % of the school''s row', n; END IF;
  INSERT INTO "SchoolSignInMethods" ("schoolId", provider, domains, "googleHostedDomain", "updatedAt")
  VALUES (school, 'google', ARRAY['rls70-a.example'], 'rls70-a.example', now());

  -- School B's row: not written, not changed, not removed, through either
  -- role. The UPDATEs and the DELETE carry no WHERE: a WHERE on a column
  -- needs SELECT, which brings the SELECT arm in, and that arm would hide a
  -- weaker UPDATE or DELETE arm behind it. So the arms alone decide what a
  -- statement reaches, and through the API's role that is the school's own
  -- row and nothing else. 70c reads school B's row back as it was planted.
  FOREACH via IN ARRAY ARRAY['app_authenticated', 'authenticated'] LOOP
    EXECUTE format('SET LOCAL ROLE %I', via);
    BEGIN
      INSERT INTO "SchoolSignInMethods" ("schoolId", provider, domains, "entraTenantId", "updatedAt")
      VALUES (school_b, 'azure', ARRAY['rls70-b.example'], gen_random_uuid(), now());
      RAISE EXCEPTION 'sign-in methods: through % school A''s admin wrote school B''s row', via;
    EXCEPTION
      WHEN insufficient_privilege THEN NULL;
      WHEN unique_violation THEN
        RAISE EXCEPTION 'sign-in methods: through % school A''s admin got past the arm with school B''s row; only the one-row index stopped it', via;
    END;
    BEGIN
      UPDATE "SchoolSignInMethods" SET "ssoOnlyForStaff" = true, "updatedAt" = now();
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n <> 1 THEN RAISE EXCEPTION 'sign-in methods: through % school A''s admin changed % row(s), not the school''s own one', via, n; END IF;
    EXCEPTION WHEN insufficient_privilege THEN
      IF via = 'app_authenticated' THEN RAISE EXCEPTION 'sign-in methods: the API''s role could not change the school''s own row'; END IF;
    END;
    BEGIN
      UPDATE "SchoolSignInMethods" SET "schoolId" = school_b, "updatedAt" = now();
      RAISE EXCEPTION 'sign-in methods: through % school A''s admin moved the school''s row to school B', via;
    EXCEPTION
      WHEN insufficient_privilege THEN NULL;
      WHEN unique_violation THEN
        RAISE EXCEPTION 'sign-in methods: through % school A''s admin moved the school''s row past the arm; only the one-row index stopped it', via;
    END;
    BEGIN
      DELETE FROM "SchoolSignInMethods";
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n <> 1 THEN RAISE EXCEPTION 'sign-in methods: through % school A''s admin removed % row(s), not the school''s own one', via, n; END IF;
      INSERT INTO "SchoolSignInMethods" ("schoolId", provider, domains, "googleHostedDomain", "updatedAt")
      VALUES (school, 'google', ARRAY['rls70-a.example'], 'rls70-a.example', now());
    EXCEPTION WHEN insufficient_privilege THEN
      IF via = 'app_authenticated' THEN RAISE EXCEPTION 'sign-in methods: the API''s role could not remove the school''s own row'; END IF;
    END;
    SELECT count(*) INTO n FROM "SchoolSignInMethods" WHERE "schoolId" <> school;
    IF n <> 0 THEN RAISE EXCEPTION 'sign-in methods: through % school A''s admin reads % row(s) of another school', via, n; END IF;
    SELECT count(*) INTO n FROM "SchoolSignInMethods" WHERE "schoolId" = school;
    IF n <> 1 THEN RAISE EXCEPTION 'sign-in methods: through % school A''s admin reads % of the school''s own row', via, n; END IF;
  END LOOP;

  -- PostgREST's role reads and writes nothing: the admin card goes through the API.
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE "SchoolSignInMethods" SET "ssoOnlyForStaff" = false, "updatedAt" = now() WHERE "schoolId" = school;
    RAISE EXCEPTION 'sign-in methods: through authenticated the admin changed the row';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM "SchoolSignInMethods" WHERE "schoolId" = school;
    RAISE EXCEPTION 'sign-in methods: through authenticated the admin removed the row';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO "SchoolSignInMethods" ("schoolId", provider, domains, "entraTenantId", "updatedAt")
    VALUES (school, 'azure', ARRAY['rls70-c.example'], gen_random_uuid(), now());
    RAISE EXCEPTION 'sign-in methods: through authenticated the admin wrote a row';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  SET LOCAL ROLE app_authenticated;
END $$;

-- 70b: the school's teacher, pupil and guardian read nothing and write nothing,
-- through either role, while the school has a row.
DO $$
DECLARE
  school uuid := current_setting('app.test_rls70_school')::uuid;
  sub text; via text; who text; n bigint;
BEGIN
  FOREACH sub IN ARRAY ARRAY[current_setting('app.test_rls70_teacher_sub'), current_setting('app.test_rls70_pupil_sub'), '00000000-0000-4000-8000-000000000004'] LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', sub)::text, true);
    who := app.current_user_role()::text;
    IF app.current_school_id() IS DISTINCT FROM school OR who NOT IN ('TEACHER', 'STUDENT', 'GUARDIAN') THEN
      RAISE EXCEPTION 'sign-in methods: expected a TEACHER, STUDENT or GUARDIAN of school A, got %', who;
    END IF;
    FOREACH via IN ARRAY ARRAY['app_authenticated', 'authenticated'] LOOP
      EXECUTE format('SET LOCAL ROLE %I', via);
      SELECT count(*) INTO n FROM "SchoolSignInMethods";
      IF n <> 0 THEN RAISE EXCEPTION 'sign-in methods: through % a % reads % row(s)', via, who, n; END IF;
      -- No WHERE, as in 70a: the UPDATE and DELETE arms alone decide.
      BEGIN
        UPDATE "SchoolSignInMethods" SET "ssoOnlyForStaff" = false, "updatedAt" = now();
        GET DIAGNOSTICS n = ROW_COUNT;
        IF n <> 0 THEN RAISE EXCEPTION 'sign-in methods: through % a % changed % row(s)', via, who, n; END IF;
      EXCEPTION WHEN insufficient_privilege THEN NULL;
      END;
      BEGIN
        DELETE FROM "SchoolSignInMethods";
        GET DIAGNOSTICS n = ROW_COUNT;
        IF n <> 0 THEN RAISE EXCEPTION 'sign-in methods: through % a % removed % row(s)', via, who, n; END IF;
      EXCEPTION WHEN insufficient_privilege THEN NULL;
      END;
      BEGIN
        INSERT INTO "SchoolSignInMethods" ("schoolId", provider, domains, "entraTenantId", "updatedAt")
        VALUES (school, 'azure', ARRAY['rls70-d.example'], gen_random_uuid(), now());
        RAISE EXCEPTION 'sign-in methods: through % a % wrote a row', via, who;
      EXCEPTION
        WHEN insufficient_privilege THEN NULL;
        WHEN unique_violation THEN
          RAISE EXCEPTION 'sign-in methods: through % a % got past the arm; only the one-row index stopped the row', via, who;
      END;
    END LOOP;
    SET LOCAL ROLE app_authenticated;
  END LOOP;
END $$;

-- 70c: school B's admin reads school B's row, Entra and SSO-only as the
-- fixtures planted it, and not school A's.
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000006')::text, true);
DO $$
DECLARE
  school_b uuid := current_setting('app.test_rls70_school_b')::uuid;
  via text; n bigint;
BEGIN
  IF app.current_school_id() IS DISTINCT FROM school_b OR app.current_user_role() IS DISTINCT FROM 'SCHOOL_ADMIN' THEN
    RAISE EXCEPTION 'sign-in methods: expected school B''s SCHOOL_ADMIN';
  END IF;
  FOREACH via IN ARRAY ARRAY['app_authenticated', 'authenticated'] LOOP
    EXECUTE format('SET LOCAL ROLE %I', via);
    SELECT count(*) INTO n FROM "SchoolSignInMethods";
    IF n <> 1 THEN RAISE EXCEPTION 'sign-in methods: through % school B''s admin reads % row(s), not its own one', via, n; END IF;
    SELECT count(*) INTO n FROM "SchoolSignInMethods"
     WHERE "schoolId" = school_b AND provider = 'azure' AND "ssoOnlyForStaff" AND "entraTenantId" IS NOT NULL;
    IF n <> 1 THEN RAISE EXCEPTION 'sign-in methods: school B''s fixture row is missing or not Entra and SSO-only'; END IF;
  END LOOP;
  SET LOCAL ROLE app_authenticated;
END $$;

-- 70d: no principal reads anything.
SELECT set_config('request.jwt.claims', '{}', true);
DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_id() IS NOT NULL THEN RAISE EXCEPTION 'sign-in methods: the empty claims resolved to a user'; END IF;
  SELECT count(*) INTO n FROM "SchoolSignInMethods";
  IF n <> 0 THEN RAISE EXCEPTION 'sign-in methods: with no principal % row(s) are read', n; END IF;
END $$;

ROLLBACK;


-- ---------------------------------------------------------------------------
-- Section 71: en inloggningsrad har en form som kroken kan lita på
-- (SchoolSignInMethods' CHECKs, 20261020090000).
--
-- The hook compares a school-account identity with entraTenantId or
-- googleHostedDomain, and /login compares a typed domain with `domains`, all
-- in lower case. A row with both pins, the wrong one, none, an upper-case
-- domain or a domain that is no host name would make the hook or the lookup
-- answer something nobody chose. So would a consumer mail domain such as
-- gmail.com, listed or as the hd: a personal account carries no hd and is no
-- tenant's, so the hook could never let it in, and /login would send every
-- address on it to this provider. Each shape is written by school A's admin
-- through the API's role; the bad ones must be refused by a CHECK (or the
-- NOT NULL, or the one-row-per-school index), the good ones must go in.
-- ---------------------------------------------------------------------------

BEGIN;

SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
DECLARE
  school uuid := app.current_school_id();
  r record;
  got text;
  twenty text[] := ARRAY(SELECT 'd' || i || '.rls71.example' FROM generate_series(1, 20) i);
  long_label text := repeat('a', 64) || '.example';
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'SCHOOL_ADMIN' THEN RAISE EXCEPTION 'sign-in shape: expected school A''s SCHOOL_ADMIN'; END IF;
  SET LOCAL ROLE app_authenticated;
  FOR r IN SELECT * FROM (VALUES
      ('Entra with its tenant',                 'azure',  ARRAY['skola.rls71.example'], '9f8e7d6c-5b4a-4321-8fed-cba987654321'::uuid, NULL::text, 'ok'),
      ('Google with its hd',                    'google', ARRAY['skola.rls71.example'], NULL, 'skola.rls71.example', 'ok'),
      ('punycode and hyphens',                  'azure',  ARRAY['xn--skla-ppa.rls71.example', 'a-b.c-d.rls71.example'], gen_random_uuid(), NULL, 'ok'),
      ('twenty domains',                        'azure',  twenty, gen_random_uuid(), NULL, 'ok'),
      ('Entra without a tenant',                'azure',  ARRAY['skola.rls71.example'], NULL, NULL, '23514'),
      ('Entra with an hd as well',              'azure',  ARRAY['skola.rls71.example'], gen_random_uuid(), 'skola.rls71.example', '23514'),
      ('Google without an hd',                  'google', ARRAY['skola.rls71.example'], NULL, NULL, '23514'),
      ('Google with a tenant as well',          'google', ARRAY['skola.rls71.example'], gen_random_uuid(), 'skola.rls71.example', '23514'),
      ('no domain',                             'azure',  '{}'::text[], gen_random_uuid(), NULL, '23514'),
      ('a NULL domain',                         'azure',  ARRAY['skola.rls71.example', NULL], gen_random_uuid(), NULL, '23514'),
      ('twenty-one domains',                    'azure',  twenty || 'd21.rls71.example'::text, gen_random_uuid(), NULL, '23514'),
      ('an upper-case domain',                  'azure',  ARRAY['Skola.rls71.example'], gen_random_uuid(), NULL, '23514'),
      ('a domain without a dot',                'azure',  ARRAY['localhost'], gen_random_uuid(), NULL, '23514'),
      ('a domain with a space',                 'azure',  ARRAY['skola rls71.example'], gen_random_uuid(), NULL, '23514'),
      ('a domain ending in a dot',              'azure',  ARRAY['skola.rls71.example.'], gen_random_uuid(), NULL, '23514'),
      ('a label starting with a hyphen',        'azure',  ARRAY['-skola.rls71.example'], gen_random_uuid(), NULL, '23514'),
      ('an address, not a domain',              'azure',  ARRAY['anna@skola.rls71.example'], gen_random_uuid(), NULL, '23514'),
      ('an IP address',                         'azure',  ARRAY['10.0.0.1'], gen_random_uuid(), NULL, '23514'),
      ('a label of 64 characters',              'azure',  ARRAY[long_label], gen_random_uuid(), NULL, '23514'),
      ('a good domain beside a bad one',        'azure',  ARRAY['skola.rls71.example', 'Bad.example'], gen_random_uuid(), NULL, '23514'),
      ('an upper-case hd',                      'google', ARRAY['skola.rls71.example'], NULL, 'Skola.rls71.example', '23514'),
      ('an hd that is no host name',            'google', ARRAY['skola.rls71.example'], NULL, 'skola', '23514'),
      ('a personal mail domain beside a good one', 'azure', ARRAY['skola.rls71.example', 'gmail.com'], gen_random_uuid(), NULL, '23514'),
      ('a Swedish personal mail domain',        'google', ARRAY['hotmail.se'], NULL, 'skola.rls71.example', '23514'),
      ('a personal mail domain as the hd',      'google', ARRAY['skola.rls71.example'], NULL, 'gmail.com', '23514'),
      ('a domain that only contains one',       'azure',  ARRAY['gmail.com.rls71.example', 'outlook.se.rls71.example'], gen_random_uuid(), NULL, 'ok'),
      ('no domains at all',                     'azure',  NULL::text[], gen_random_uuid(), NULL, '23502')
    ) AS t(label, provider, domains, tenant, hd, expect)
  LOOP
    BEGIN
      INSERT INTO "SchoolSignInMethods" ("schoolId", provider, domains, "entraTenantId", "googleHostedDomain", "updatedAt")
      VALUES (school, r.provider::"SignInProvider", r.domains, r.tenant, r.hd, now());
      got := 'ok';
      DELETE FROM "SchoolSignInMethods" WHERE "schoolId" = school;
    EXCEPTION WHEN check_violation OR not_null_violation THEN
      got := SQLSTATE;
    END;
    IF got <> r.expect THEN
      RAISE EXCEPTION 'sign-in shape: % gave %, expected %', r.label, got, r.expect;
    END IF;
  END LOOP;

  -- The personal mail domains are refused by their own CHECK, not by
  -- another one that happened to object, listed or as the hd.
  FOR r IN SELECT * FROM (VALUES
      ('listed', ARRAY['skola.rls71.example', 'proton.me'], 'skola.rls71.example'),
      ('as the hd', ARRAY['skola.rls71.example'], 'googlemail.com')
    ) AS t(label, domains, hd)
  LOOP
    BEGIN
      INSERT INTO "SchoolSignInMethods" ("schoolId", provider, domains, "googleHostedDomain", "updatedAt")
      VALUES (school, 'google', r.domains, r.hd, now());
      RAISE EXCEPTION 'sign-in shape: a personal mail domain % went in', r.label;
    EXCEPTION WHEN check_violation THEN
      GET STACKED DIAGNOSTICS got = CONSTRAINT_NAME;
      IF got IS DISTINCT FROM 'SchoolSignInMethods_no_personal_mail_domains' THEN
        RAISE EXCEPTION 'sign-in shape: a personal mail domain % was refused by %, expected SchoolSignInMethods_no_personal_mail_domains', r.label, got;
      END IF;
    END;
  END LOOP;

  -- One row per school.
  INSERT INTO "SchoolSignInMethods" ("schoolId", provider, domains, "entraTenantId", "updatedAt")
  VALUES (school, 'azure', ARRAY['skola.rls71.example'], gen_random_uuid(), now());
  BEGIN
    INSERT INTO "SchoolSignInMethods" ("schoolId", provider, domains, "googleHostedDomain", "updatedAt")
    VALUES (school, 'google', ARRAY['skola.rls71.example'], 'skola.rls71.example', now());
    RAISE EXCEPTION 'sign-in shape: a school got a second row';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

ROLLBACK;


-- ---------------------------------------------------------------------------
-- Section 72: kroken körs bara av Supabase Auth, och uppslaget bara av API:t
-- (the five functions of 20261020090000, and the schema "sign_in").
--
-- sign_in.custom_access_token_hook decides whether a token is issued, and
-- sign_in.rules hands out any person's role and their school's pins by Auth
-- id. Either one callable through PostgREST would let a signed-in user read
-- another school's tenant or probe who exists. So:
--
--   * the hook runs with its caller's rights (Supabase's advice): no
--     SECURITY DEFINER, and an empty search_path;
--   * sign_in.rules, app.sign_in_provider_for_domain and the domain
--     trigger's app.sign_in_domain_keeps_its_provider are SECURITY DEFINER
--     with an empty search_path, and nobody executes the trigger function;
--   * sign_in.verdict is IMMUTABLE, invoker-rights, and reads nothing;
--   * EXECUTE: the hook and sign_in.rules for supabase_auth_admin only; the
--     lookup for app_authenticated only; the verdict for those two. Never
--     PUBLIC, anon, authenticated or service_role. Counted with
--     has_function_privilege, so a grant to a role they inherit from counts
--     too. CI's database has a stand-in supabase_auth_admin
--     (scripts/db-init), so its grants are counted there too;
--   * USAGE on "sign_in" for supabase_auth_admin and app_authenticated only,
--     the schema holds the three functions and nothing else, and
--     supabase_auth_admin has no USAGE on "app", whose PUBLIC-executable
--     helpers include SECURITY DEFINER readers of any school's settings.
--
-- Then the refusals are run: as app_authenticated and as authenticated the
-- hook and sign_in.rules answer 42501, and as authenticated so does the
-- lookup.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  r record;
  who text;
  allowed boolean;
  expected boolean;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('sign_in.custom_access_token_hook(jsonb)', false, 's', ARRAY['supabase_auth_admin']),
      ('sign_in.rules(uuid)', true, 's', ARRAY['supabase_auth_admin']),
      ('sign_in.verdict("UserRole","SignInProvider",uuid,text,boolean,text[],jsonb,interval)', false, 'i', ARRAY['supabase_auth_admin', 'app_authenticated']),
      ('app.sign_in_provider_for_domain(text)', true, 's', ARRAY['app_authenticated']),
      ('app.sign_in_domain_keeps_its_provider()', true, 'v', '{}'::text[])
    ) AS t(fn, definer, volatility, callers)
  LOOP
    IF (SELECT prosecdef FROM pg_proc WHERE oid = r.fn::regprocedure) IS DISTINCT FROM r.definer THEN
      RAISE EXCEPTION 'sign-in functions: % is % SECURITY DEFINER', r.fn, CASE WHEN r.definer THEN 'not' ELSE 'unexpectedly' END;
    END IF;
    IF (SELECT provolatile FROM pg_proc WHERE oid = r.fn::regprocedure) <> r.volatility THEN
      RAISE EXCEPTION 'sign-in functions: % is not of volatility %', r.fn, r.volatility;
    END IF;
    IF NOT coalesce((SELECT 'search_path=""' = ANY (proconfig) FROM pg_proc WHERE oid = r.fn::regprocedure), false) THEN
      RAISE EXCEPTION 'sign-in functions: % does not pin an empty search_path', r.fn;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                WHERE p.oid = r.fn::regprocedure AND a.grantee = 0) THEN
      RAISE EXCEPTION 'sign-in functions: PUBLIC may execute %', r.fn;
    END IF;
    FOREACH who IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated', 'supabase_auth_admin'] LOOP
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = who);
      allowed := has_function_privilege(who, r.fn::regprocedure, 'EXECUTE');
      expected := who = ANY (r.callers);
      IF allowed IS DISTINCT FROM expected THEN
        RAISE EXCEPTION 'sign-in functions: % % execute %', who, CASE WHEN allowed THEN 'may' ELSE 'may not' END, r.fn;
      END IF;
    END LOOP;
  END LOOP;

  -- The schema: USAGE for the two callers only, the three functions only.
  FOREACH who IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated', 'supabase_auth_admin'] LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = who);
    allowed := has_schema_privilege(who, 'sign_in', 'USAGE');
    expected := who IN ('app_authenticated', 'supabase_auth_admin');
    IF allowed IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'sign-in functions: % % use schema sign_in', who, CASE WHEN allowed THEN 'may' ELSE 'may not' END;
    END IF;
    IF has_schema_privilege(who, 'sign_in', 'CREATE') THEN
      RAISE EXCEPTION 'sign-in functions: % may create in schema sign_in', who;
    END IF;
  END LOOP;
  IF has_schema_privilege('supabase_auth_admin', 'app', 'USAGE') THEN
    RAISE EXCEPTION 'sign-in functions: supabase_auth_admin may use schema app and run its PUBLIC helpers';
  END IF;
  IF (SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) FROM pg_proc p
       WHERE p.pronamespace = 'sign_in'::regnamespace)
     IS DISTINCT FROM 'sign_in.custom_access_token_hook(jsonb), sign_in.rules(uuid), sign_in.verdict("UserRole","SignInProvider",uuid,text,boolean,text[],jsonb,interval)' THEN
    RAISE EXCEPTION 'sign-in functions: schema sign_in holds something besides the hook and its two callees';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = 'sign_in'::regnamespace) THEN
    RAISE EXCEPTION 'sign-in functions: schema sign_in holds a relation';
  END IF;
END $$;

BEGIN;
DO $$
DECLARE
  via text;
  ignored jsonb;
BEGIN
  FOREACH via IN ARRAY ARRAY['app_authenticated', 'authenticated'] LOOP
    EXECUTE format('SET LOCAL ROLE %I', via);
    IF current_user <> via THEN RAISE EXCEPTION 'sign-in functions: running as %, not %', current_user, via; END IF;
    BEGIN
      ignored := sign_in.custom_access_token_hook(jsonb_build_object('user_id', gen_random_uuid(), 'claims', '{}'::jsonb, 'authentication_method', 'password'));
      RAISE EXCEPTION 'sign-in functions: % ran the access-token hook', via;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM * FROM sign_in.rules(gen_random_uuid());
      RAISE EXCEPTION 'sign-in functions: % read a person''s sign-in rules', via;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
  END LOOP;
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM app.sign_in_provider_for_domain('rls-fixture-b.example');
    RAISE EXCEPTION 'sign-in functions: authenticated looked a domain up';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  SET LOCAL ROLE app_authenticated;
END $$;
ROLLBACK;


-- ---------------------------------------------------------------------------
-- Section 73: kroken släpper igenom skolans skolkonton och personalens
-- lösenord bara när skolan vill, och ett skolkonto högst ett dygn i taget
-- (sign_in.verdict, 20261020090000).
--
-- The verdict is the whole decision of the access-token hook; the hook only
-- gathers its inputs (the person's role and school row by Auth id, the
-- session's methods from the claims, and the person's identities from
-- auth.identities, which CI's database does not have, and how long ago the
-- session signed in at the provider). Each case below is a session and a
-- person, with the answer the hook must give: NULL issues the token, a code
-- refuses it with 403. A school-account session older than 24 hours, or with
-- no sign-in time, goes back to the provider; a password session's age is
-- not the hook's business. The identities are shaped as Supabase
-- Auth stores them (identity_data.iss is the ID token's issuer, the token's
-- other claims sit in identity_data.custom_claims).
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  tid text := '2f6a1c3e-8b4d-4f5a-9c7e-1d2b3a4c5e6f';
  other_tid text := '5e4d3c2b-1a09-4877-8665-544332211000';
  entra jsonb := jsonb_build_object('provider', 'azure', 'identity_data', jsonb_build_object(
    'iss', 'https://login.microsoftonline.com/' || tid || '/v2.0', 'sub', 'entra-sub',
    'custom_claims', jsonb_build_object('tid', tid, 'email', 'anna@skola.rls73.example')));
  entra_other jsonb := jsonb_build_object('provider', 'azure', 'identity_data', jsonb_build_object(
    'iss', 'https://login.microsoftonline.com/' || other_tid || '/v2.0', 'sub', 'other-sub',
    'custom_claims', jsonb_build_object('tid', other_tid)));
  entra_upper jsonb := jsonb_build_object('provider', 'azure', 'identity_data', jsonb_build_object(
    'iss', 'https://login.microsoftonline.com/' || upper(tid) || '/v2.0', 'sub', 'upper-sub'));
  entra_disagrees jsonb := jsonb_build_object('provider', 'azure', 'identity_data', jsonb_build_object(
    'iss', 'https://login.microsoftonline.com/' || tid || '/v2.0', 'sub', 'odd-sub',
    'custom_claims', jsonb_build_object('tid', other_tid)));
  entra_common jsonb := jsonb_build_object('provider', 'azure', 'identity_data', jsonb_build_object(
    'iss', 'https://login.microsoftonline.com/common/v2.0', 'sub', 'common-sub',
    'custom_claims', jsonb_build_object('tid', tid)));
  entra_ciam jsonb := jsonb_build_object('provider', 'azure', 'identity_data', jsonb_build_object(
    'iss', 'https://skola.ciamlogin.com/' || tid || '/v2.0', 'sub', 'ciam-sub'));
  google jsonb := jsonb_build_object('provider', 'google', 'identity_data', jsonb_build_object(
    'iss', 'https://accounts.google.com', 'sub', 'google-sub', 'custom_claims', jsonb_build_object('hd', 'skola.rls73.example')));
  google_upper jsonb := jsonb_build_object('provider', 'google', 'identity_data', jsonb_build_object(
    'iss', 'accounts.google.com', 'sub', 'google-upper', 'custom_claims', jsonb_build_object('hd', 'Skola.RLS73.example')));
  google_other jsonb := jsonb_build_object('provider', 'google', 'identity_data', jsonb_build_object(
    'iss', 'https://accounts.google.com', 'sub', 'google-other', 'custom_claims', jsonb_build_object('hd', 'annan.rls73.example')));
  google_consumer jsonb := jsonb_build_object('provider', 'google', 'identity_data', jsonb_build_object(
    'iss', 'https://accounts.google.com', 'sub', 'google-consumer'));
  google_userinfo jsonb := jsonb_build_object('provider', 'google', 'identity_data', jsonb_build_object(
    'iss', 'https://www.googleapis.com/userinfo/v2/me', 'sub', 'google-userinfo', 'custom_claims', jsonb_build_object('hd', 'skola.rls73.example')));
  github jsonb := jsonb_build_object('provider', 'github', 'identity_data', jsonb_build_object('sub', 'gh'));
  -- Filed under another provider than its issuer's: Auth never stores one, and
  -- the verdict reads both, so neither alone lets an identity through.
  misfiled jsonb := jsonb_build_object('provider', 'google', 'identity_data', jsonb_build_object(
    'iss', 'https://login.microsoftonline.com/' || tid || '/v2.0', 'sub', 'misfiled', 'custom_claims', jsonb_build_object('tid', tid)));
  saml jsonb := jsonb_build_object('provider', 'sso:5f1c', 'identity_data', jsonb_build_object('sub', 'saml'));
  address jsonb := jsonb_build_object('provider', 'email', 'identity_data', jsonb_build_object('sub', 'x', 'email', 'anna@skola.rls73.example'));
  r record;
  got text;
  cases int := 0;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      -- Passwords and links, by role and by the school's choice.
      ('a teacher''s password, no school row',             'TEACHER',      NULL, NULL::text, NULL::text, NULL::boolean, ARRAY['password'], ''::text, NULL::text, interval '1 hour'),
      ('a teacher''s password, school accounts optional',  'TEACHER',      'azure', 'T', NULL, false, ARRAY['password'], '', NULL, interval '1 hour'),
      ('a teacher''s password, SSO-only',                  'TEACHER',      'azure', 'T', NULL, true, ARRAY['password'], '', 'sso_required', interval '1 hour'),
      ('an admin''s password, SSO-only',                   'SCHOOL_ADMIN', 'google', NULL, 'skola.rls73.example', true, ARRAY['password'], '', 'sso_required', interval '1 hour'),
      ('a pupil''s password, SSO-only',                    'STUDENT',      'azure', 'T', NULL, true, ARRAY['password'], '', NULL, interval '1 hour'),
      ('a guardian''s password, SSO-only',                 'GUARDIAN',     'azure', 'T', NULL, true, ARRAY['password'], '', NULL, interval '1 hour'),
      ('a teacher''s recovery link, SSO-only',             'TEACHER',      'azure', 'T', NULL, true, ARRAY['recovery'], '', 'sso_required', interval '1 hour'),
      ('a teacher''s invitation link, SSO-only',           'TEACHER',      'azure', 'T', NULL, true, ARRAY['invite'], '', 'sso_required', interval '1 hour'),
      ('a teacher''s magic link, SSO-only',                'TEACHER',      'azure', 'T', NULL, true, ARRAY['magiclink', 'otp'], '', 'sso_required', interval '1 hour'),
      ('a teacher''s password session refreshed, SSO-only', 'TEACHER',     'azure', 'T', NULL, true, ARRAY['password', 'token_refresh'], '', 'sso_required', interval '1 hour'),
      ('a teacher''s password session refreshed, optional', 'TEACHER',     'azure', 'T', NULL, false, ARRAY['password', 'token_refresh'], '', NULL, interval '1 hour'),
      ('a session of no method, SSO-only',                 'TEACHER',      'azure', 'T', NULL, true, '{}'::text[], '', 'sso_required', interval '1 hour'),
      ('a session of no method, no school row',            'TEACHER',      NULL, NULL, NULL, NULL, '{}'::text[], '', NULL, interval '1 hour'),
      ('password and a school account mixed, SSO-only',    'TEACHER',      'azure', 'T', NULL, true, ARRAY['oauth', 'password'], 'E', 'sso_required', interval '1 hour'),
      -- School accounts.
      ('a school account, no school row',                  'TEACHER',      NULL, NULL, NULL, NULL, ARRAY['oauth'], 'E', 'sso_not_enabled', interval '1 hour'),
      ('a pupil''s school account, no school row',         'STUDENT',      NULL, NULL, NULL, NULL, ARRAY['oauth'], 'E', 'sso_not_enabled', interval '1 hour'),
      ('Entra, the school''s tenant',                      'TEACHER',      'azure', 'T', NULL, false, ARRAY['oauth'], 'E', NULL, interval '1 hour'),
      ('Entra, the school''s tenant, SSO-only',            'SCHOOL_ADMIN', 'azure', 'T', NULL, true, ARRAY['oauth'], 'E', NULL, interval '1 hour'),
      ('Entra beside the address identity',                'TEACHER',      'azure', 'T', NULL, true, ARRAY['oauth'], 'EA', NULL, interval '1 hour'),
      ('Entra with a second factor',                       'TEACHER',      'azure', 'T', NULL, true, ARRAY['oauth', 'totp'], 'E', NULL, interval '1 hour'),
      ('Entra refreshed',                                  'TEACHER',      'azure', 'T', NULL, true, ARRAY['oauth', 'token_refresh'], 'E', NULL, interval '1 hour'),
      ('Entra, a pupil, SSO-only',                         'STUDENT',      'azure', 'T', NULL, true, ARRAY['oauth'], 'E', NULL, interval '1 hour'),
      ('Entra, the tenant in upper case',                  'TEACHER',      'azure', 'T', NULL, false, ARRAY['oauth'], 'U', NULL, interval '1 hour'),
      ('Entra, another tenant',                            'TEACHER',      'azure', 'T', NULL, false, ARRAY['oauth'], 'O', 'sso_identity_not_allowed', interval '1 hour'),
      ('Entra, the right tenant and another one',          'TEACHER',      'azure', 'T', NULL, false, ARRAY['oauth'], 'EO', 'sso_identity_not_allowed', interval '1 hour'),
      ('Entra, the claimed tid disagrees with iss',        'TEACHER',      'azure', 'T', NULL, false, ARRAY['oauth'], 'D', 'sso_identity_not_allowed', interval '1 hour'),
      ('Entra, the common issuer',                         'TEACHER',      'azure', 'T', NULL, false, ARRAY['oauth'], 'C', 'sso_identity_not_allowed', interval '1 hour'),
      ('Entra, a CIAM issuer',                             'TEACHER',      'azure', 'T', NULL, false, ARRAY['oauth'], 'M', 'sso_identity_not_allowed', interval '1 hour'),
      ('Entra refreshed, another tenant',                  'TEACHER',      'azure', 'T', NULL, false, ARRAY['oauth', 'token_refresh'], 'O', 'sso_identity_not_allowed', interval '1 hour'),
      ('Google at an Entra school',                        'TEACHER',      'azure', 'T', NULL, false, ARRAY['oauth'], 'G', 'sso_identity_not_allowed', interval '1 hour'),
      ('Entra and Google at an Entra school',              'TEACHER',      'azure', 'T', NULL, false, ARRAY['oauth'], 'EG', 'sso_identity_not_allowed', interval '1 hour'),
      ('Google, the school''s hd',                         'TEACHER',      'google', NULL, 'skola.rls73.example', false, ARRAY['oauth'], 'G', NULL, interval '1 hour'),
      ('Google, the hd in upper case',                     'TEACHER',      'google', NULL, 'skola.rls73.example', true, ARRAY['oauth'], 'g', NULL, interval '1 hour'),
      ('Google, another hd',                               'TEACHER',      'google', NULL, 'skola.rls73.example', false, ARRAY['oauth'], 'H', 'sso_identity_not_allowed', interval '1 hour'),
      ('Google, no hd',                                    'TEACHER',      'google', NULL, 'skola.rls73.example', false, ARRAY['oauth'], 'N', 'sso_identity_not_allowed', interval '1 hour'),
      ('Google, read from the userinfo endpoint',          'TEACHER',      'google', NULL, 'skola.rls73.example', false, ARRAY['oauth'], 'I', 'sso_identity_not_allowed', interval '1 hour'),
      ('Entra at a Google school',                         'TEACHER',      'google', NULL, 'skola.rls73.example', false, ARRAY['oauth'], 'E', 'sso_identity_not_allowed', interval '1 hour'),
      ('another provider',                                 'TEACHER',      'azure', 'T', NULL, false, ARRAY['oauth'], 'E2', 'sso_identity_not_allowed', interval '1 hour'),
      ('a SAML identity',                                  'TEACHER',      'azure', 'T', NULL, false, ARRAY['oauth'], 'ES', 'sso_identity_not_allowed', interval '1 hour'),
      ('the school''s Entra issuer filed as Google',       'TEACHER',      'azure', 'T', NULL, false, ARRAY['oauth'], 'F', 'sso_identity_not_allowed', interval '1 hour'),
      ('a school account and no identity',                 'TEACHER',      'azure', 'T', NULL, false, ARRAY['oauth'], '', 'sso_identity_not_allowed', interval '1 hour'),
      ('a school account and only the address',            'TEACHER',      'azure', 'T', NULL, false, ARRAY['oauth'], 'A', 'sso_identity_not_allowed', interval '1 hour'),
      ('a school account and no identity list',            'TEACHER',      'azure', 'T', NULL, false, ARRAY['oauth'], NULL, 'sso_identity_not_allowed', interval '1 hour'),
      -- How long ago the session signed in at the provider.
      ('Entra refreshed 23 hours after signing in',         'TEACHER',      'azure', 'T', NULL, true, ARRAY['oauth', 'token_refresh'], 'E', NULL, interval '23 hours'),
      ('Entra refreshed 25 hours after signing in',         'TEACHER',      'azure', 'T', NULL, true, ARRAY['oauth', 'token_refresh'], 'E', 'sso_reauth_required', interval '25 hours'),
      ('Entra with no sign-in time',                        'SCHOOL_ADMIN', 'azure', 'T', NULL, false, ARRAY['oauth'], 'E', 'sso_reauth_required', NULL::interval),
      ('Google, a pupil, 25 hours after signing in',        'STUDENT',      'google', NULL, 'skola.rls73.example', false, ARRAY['oauth', 'token_refresh'], 'G', 'sso_reauth_required', interval '25 hours'),
      ('another tenant, long ago: the tenant is the answer', 'TEACHER',     'azure', 'T', NULL, false, ARRAY['oauth'], 'O', 'sso_identity_not_allowed', interval '30 days'),
      ('a password with no sign-in time, optional',         'TEACHER',      'azure', 'T', NULL, false, ARRAY['password', 'token_refresh'], '', NULL, NULL),
      ('a password a month old, no school row',             'TEACHER',      NULL, NULL, NULL, NULL, ARRAY['password', 'token_refresh'], '', NULL, interval '30 days'),
      -- Ways of signing in the hook does not pin are refused until they are.
      ('SAML, no school row',                                'TEACHER',      NULL, NULL, NULL, NULL, ARRAY['sso/saml'], '', 'sign_in_method_not_allowed', interval '1 hour'),
      ('SAML at a school with school accounts',              'STUDENT',      'azure', 'T', NULL, false, ARRAY['sso/saml', 'token_refresh'], 'ES', 'sign_in_method_not_allowed', interval '1 hour'),
      ('a passkey',                                          'TEACHER',      'azure', 'T', NULL, false, ARRAY['passkey'], '', 'sign_in_method_not_allowed', interval '1 hour'),
      ('web3',                                               'GUARDIAN',     NULL, NULL, NULL, NULL, ARRAY['web3'], '', 'sign_in_method_not_allowed', interval '1 hour'),
      ('an anonymous sign-in',                               'STUDENT',      NULL, NULL, NULL, NULL, ARRAY['anonymous'], '', 'sign_in_method_not_allowed', interval '1 hour'),
      ('a method Auth adds later',                           'TEACHER',      NULL, NULL, NULL, NULL, ARRAY['something/new'], '', 'sign_in_method_not_allowed', interval '1 hour'),
      ('Entra and SAML mixed',                               'TEACHER',      'azure', 'T', NULL, false, ARRAY['oauth', 'sso/saml'], 'E', 'sign_in_method_not_allowed', interval '1 hour'),
      ('a sign-up link, optional',                           'GUARDIAN',     'azure', 'T', NULL, false, ARRAY['email/signup'], '', NULL, interval '1 hour'),
      ('an e-mail change, SSO-only',                         'TEACHER',      'azure', 'T', NULL, true, ARRAY['email_change'], '', 'sso_required', interval '1 hour')
    ) AS t(label, role, provider, tenant, hd, sso_only, methods, ids, expect, age)
  LOOP
    got := sign_in.verdict(
      r.role::"UserRole",
      r.provider::"SignInProvider",
      CASE WHEN r.tenant = 'T' THEN tid::uuid END,
      r.hd,
      r.sso_only,
      r.methods,
      CASE WHEN r.ids IS NULL THEN NULL ELSE (
        SELECT coalesce(jsonb_agg(CASE c WHEN 'E' THEN entra WHEN 'O' THEN entra_other WHEN 'U' THEN entra_upper
                                         WHEN 'D' THEN entra_disagrees WHEN 'C' THEN entra_common WHEN 'M' THEN entra_ciam
                                         WHEN 'G' THEN google WHEN 'g' THEN google_upper WHEN 'H' THEN google_other
                                         WHEN 'N' THEN google_consumer WHEN 'I' THEN google_userinfo WHEN '2' THEN github
                                         WHEN 'S' THEN saml WHEN 'A' THEN address WHEN 'F' THEN misfiled END ORDER BY o), '[]'::jsonb)
          FROM unnest(string_to_array(r.ids, NULL)) WITH ORDINALITY AS x(c, o)
         WHERE r.ids <> '') END,
      r.age);
    IF got IS DISTINCT FROM r.expect THEN
      RAISE EXCEPTION 'sign-in verdict: % gave %, expected %', r.label, coalesce(got, 'a token'), coalesce(r.expect, 'a token');
    END IF;
    cases := cases + 1;
  END LOOP;
  IF cases < 59 THEN RAISE EXCEPTION 'sign-in verdict: only % case(s) ran', cases; END IF;
END $$;


-- ---------------------------------------------------------------------------
-- Section 74: inloggningen hittar skolkontot från e-postadressens domän och
-- säger inget annat (app.sign_in_provider_for_domain, 20261020090000).
--
-- /login asks the gateway which provider a typed address's domain signs in
-- with; the gateway asks this function, with no principal. It answers the
-- provider and nothing more: no school, no tenant, no SSO-only. Two schools
-- may name one domain only with one provider (section 75), so a domain's
-- answer is the same whichever school names it, and a second school naming
-- it with that provider changes nothing.
-- ---------------------------------------------------------------------------

BEGIN;

SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
DECLARE
  school uuid := app.current_school_id();
  r record;
  got text;
BEGIN
  IF (SELECT prorettype FROM pg_proc WHERE oid = 'app.sign_in_provider_for_domain(text)'::regprocedure)
     <> '"SignInProvider"'::regtype THEN
    RAISE EXCEPTION 'sign-in lookup: the function answers more than a provider';
  END IF;

  SET LOCAL ROLE app_authenticated;
  -- School A, Google, on a domain of its own.
  INSERT INTO "SchoolSignInMethods" ("schoolId", provider, domains, "googleHostedDomain", "updatedAt")
  VALUES (school, 'google', ARRAY['rls74-a.example'], 'rls74-a.example', now());
  PERFORM set_config('request.jwt.claims', '{}', true);

  FOR r IN SELECT * FROM (VALUES
      ('school B''s own domain',                  'rls-fixture-b.example', 'azure'),
      ('the same, in capitals and padded',        '  RLS-Fixture-B.Example ', 'azure'),
      ('school A''s own domain',                  'rls74-a.example', 'google'),
      ('the domain only school B names',          'rls-delad.example', 'azure'),
      ('a domain nobody names',                   'okand.example', NULL),
      ('an empty string',                         '', NULL),
      ('NULL',                                    NULL, NULL),
      ('a whole address',                         'anna@rls-fixture-b.example', NULL),
      ('a pattern, which is no wildcard',         '%.example', NULL)
    ) AS t(label, domain, expect)
  LOOP
    got := app.sign_in_provider_for_domain(r.domain)::text;
    IF got IS DISTINCT FROM r.expect THEN
      RAISE EXCEPTION 'sign-in lookup: % gave %, expected %', r.label, coalesce(got, 'nothing'), coalesce(r.expect, 'nothing');
    END IF;
  END LOOP;
END $$;

-- When school A moves to Entra and names the shared domain too, both
-- schools' domains answer Entra.
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
DECLARE got text;
BEGIN
  UPDATE "SchoolSignInMethods"
     SET provider = 'azure', "googleHostedDomain" = NULL, "entraTenantId" = gen_random_uuid(),
         domains = ARRAY['rls74-a.example', 'rls-delad.example'], "updatedAt" = now()
   WHERE "schoolId" = app.current_school_id();
  FOREACH got IN ARRAY ARRAY[app.sign_in_provider_for_domain('rls-delad.example')::text, app.sign_in_provider_for_domain('rls74-a.example')::text] LOOP
    IF got IS DISTINCT FROM 'azure' THEN
      RAISE EXCEPTION 'sign-in lookup: two Entra schools on one domain gave %, expected azure', coalesce(got, 'nothing');
    END IF;
  END LOOP;
END $$;

ROLLBACK;


-- ---------------------------------------------------------------------------
-- Section 75: en skola kan inte ändra vad /login svarar för en annan skolas
-- domän (the trigger app.sign_in_domain_keeps_its_provider, 20261020090000).
--
-- /login sends a typed address to the provider its domain signs in with,
-- and at a school that requires the school account that is the only way in
-- for staff. If school A could name school B's domain with the other
-- provider, the lookup would have no single answer, B's staff would find no
-- school-account sign-in, and the hook would refuse their passwords. So a
-- domain another school names may be named again only with the same
-- provider, on insert and on every update that changes the provider or the
-- domains, whatever else the row says. The refusal is SQLSTATE SI409 and
-- names only the saving school's own domains. Sharing one provider stays
-- allowed: a kommun's schools often share a domain, and the hook pins each
-- school's people to its own tenant or Workspace anyway. A school that
-- requires the school account names every domain its staff are on (the
-- gateway refuses anything else), so what another school later does with its
-- own row never changes the answer for them: a shared domain it names is one
-- this trigger keeps on its provider. The fixtures plant school B on Entra
-- with rls-fixture-b.example and rls-delad.example.
-- ---------------------------------------------------------------------------

BEGIN;

SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
DECLARE
  school uuid := app.current_school_id();
  detail text;
  n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'SCHOOL_ADMIN' THEN RAISE EXCEPTION 'domain rule: expected school A''s SCHOOL_ADMIN'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = '"SchoolSignInMethods"'::regclass
                  AND t.tgname = 'SchoolSignInMethods_domain_keeps_its_provider' AND t.tgenabled = 'O') THEN
    RAISE EXCEPTION 'domain rule: the trigger is missing or disabled';
  END IF;
  SET LOCAL ROLE app_authenticated;

  -- 75a: Google on school B's Entra domain is refused, naming only that domain.
  BEGIN
    INSERT INTO "SchoolSignInMethods" ("schoolId", provider, domains, "googleHostedDomain", "updatedAt")
    VALUES (school, 'google', ARRAY['rls75-a.example', 'rls-delad.example'], 'rls75-a.example', now());
    RAISE EXCEPTION 'domain rule: school A named school B''s Entra domain with Google';
  EXCEPTION WHEN SQLSTATE 'SI409' THEN
    GET STACKED DIAGNOSTICS detail = PG_EXCEPTION_DETAIL;
    IF detail IS DISTINCT FROM 'domains=rls-delad.example' THEN
      RAISE EXCEPTION 'domain rule: the refusal said %, expected only the saving school''s own taken domain', detail;
    END IF;
  END;

  -- 75b: Entra on the same domain is allowed: one provider, one answer.
  BEGIN
    INSERT INTO "SchoolSignInMethods" ("schoolId", provider, domains, "entraTenantId", "updatedAt")
    VALUES (school, 'azure', ARRAY['rls75-a.example', 'rls-delad.example'], gen_random_uuid(), now());
  EXCEPTION WHEN SQLSTATE 'SI409' THEN
    RAISE EXCEPTION 'domain rule: school A could not share school B''s domain on the same provider';
  END;

  -- 75c: switching to Google while the shared domain is named is refused.
  BEGIN
    UPDATE "SchoolSignInMethods"
       SET provider = 'google', "entraTenantId" = NULL, "googleHostedDomain" = 'rls75-a.example', "updatedAt" = now();
    RAISE EXCEPTION 'domain rule: school A moved a domain school B names to Google';
  EXCEPTION WHEN SQLSTATE 'SI409' THEN NULL;
  END;

  -- 75d: without the shared domain, the switch is the school's own business,
  -- and its own earlier row does not count against it.
  BEGIN
    UPDATE "SchoolSignInMethods"
       SET provider = 'google', "entraTenantId" = NULL, "googleHostedDomain" = 'rls75-a.example',
           domains = ARRAY['rls75-a.example'], "updatedAt" = now();
    GET DIAGNOSTICS n = ROW_COUNT;
  EXCEPTION WHEN SQLSTATE 'SI409' THEN
    RAISE EXCEPTION 'domain rule: school A''s own earlier row was counted against its own switch';
  END;
  IF n <> 1 THEN RAISE EXCEPTION 'domain rule: school A could not move its own domain to Google'; END IF;

  -- 75e: adding school B's other domain to the Google row is refused too.
  BEGIN
    UPDATE "SchoolSignInMethods" SET domains = ARRAY['rls75-a.example', 'rls-fixture-b.example'], "updatedAt" = now();
    RAISE EXCEPTION 'domain rule: school A added school B''s Entra domain to its Google row';
  EXCEPTION WHEN SQLSTATE 'SI409' THEN NULL;
  END;

  -- And school B's answer never moved.
  IF app.sign_in_provider_for_domain('rls-delad.example') IS DISTINCT FROM 'azure'
     OR app.sign_in_provider_for_domain('rls-fixture-b.example') IS DISTINCT FROM 'azure' THEN
    RAISE EXCEPTION 'domain rule: school B''s domains no longer answer Entra';
  END IF;
END $$;

ROLLBACK;


-- ---------------------------------------------------------------------------
-- Section 76: kroken själv, anropad som Supabase Auth anropar den
-- (sign_in.custom_access_token_hook, 20261020090000).
--
-- The hook runs before every access token Auth issues, for every person of
-- every school. A fault in it, in sign_in.rules or in their grants refuses
-- every sign-in and every refresh in the project the moment the hook is on,
-- so the hook itself is called here, as supabase_auth_admin, with events of
-- the shape Auth sends (user_id, claims with amr entries {method,
-- timestamp}, authentication_method). CI's database gets that role and a
-- stand-in auth.identities from scripts/db-init, and app_authenticated may
-- SET ROLE to it there (without inheriting its rights).
--
--   76a  everyone the hook must leave alone gets exactly the claims Auth
--        signed, wrapped as {"claims": …}: a stranger without a Users row
--        (by password and by school account), school A's guardian, pupil,
--        teacher and admin and its deactivated admin (school A has no
--        school-account row), a recovery link and a refresh, and school B's
--        pupil, whose school requires the school account of staff only;
--   76b  the refusals come back as Auth reads them, {"error": {"http_code":
--        403, "message": <code>}}: school B's teacher and admin by password
--        and invitation link (sso_required), a school-account session with no
--        identity, with the right tenant beside another and with SAML, a
--        sign-in more than a day old, school A's teacher by school account
--        (sso_not_enabled), and a school-account issuance whose amr has not
--        caught up (the issuance's own method counts);
--   76c  school B's teacher with an Entra identity of B's tenant gets the
--        claims;
--   76d  as supabase_auth_admin, Users cannot be read directly and nothing in
--        "app" can be executed: the hook reaches SchemaPro's data only
--        through sign_in.rules.
-- ---------------------------------------------------------------------------

BEGIN;

SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
DECLARE
  school uuid := app.current_school_id();
BEGIN
  PERFORM set_config('app.test_rls76_admin_auth', (SELECT "authId"::text FROM "Users" WHERE id = app.current_user_id()), true);
  PERFORM set_config('app.test_rls76_teacher_sub', coalesce((SELECT "authId"::text FROM "Users" WHERE "schoolId" = school AND role = 'TEACHER' AND "isActive" ORDER BY "authId" LIMIT 1), ''), true);
  PERFORM set_config('app.test_rls76_pupil_sub', coalesce((SELECT "authId"::text FROM "Users" WHERE "schoolId" = school AND role = 'STUDENT' AND "isActive" ORDER BY "authId" LIMIT 1), ''), true);
  IF current_setting('app.test_rls76_teacher_sub') = '' OR current_setting('app.test_rls76_pupil_sub') = '' THEN
    RAISE EXCEPTION 'hook: school A has no active teacher or pupil to ask about';
  END IF;
END $$;

DO $$
DECLARE
  now_s bigint := extract(epoch FROM now())::bigint;
  b_tenant text := '7b0c2a9e-3c1d-4e5f-8a6b-0c1d2e3f4a5b';
  r record;
  claims jsonb;
  got jsonb;
  expected jsonb;
  cases int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    RAISE EXCEPTION 'hook: the role supabase_auth_admin does not exist (scripts/db-init/02-auth-hook-stand-in.sql), so the hook is never called';
  END IF;
  SET LOCAL ROLE supabase_auth_admin;
  IF current_user <> 'supabase_auth_admin' THEN RAISE EXCEPTION 'hook: running as %, not supabase_auth_admin', current_user; END IF;

  FOR r IN SELECT * FROM (VALUES
      -- 76a: left alone.
      ('a stranger by password',                  gen_random_uuid()::text, 'password', ARRAY['password'], NULL::bigint, NULL::text),
      ('a stranger by school account',            gen_random_uuid()::text, 'oauth', ARRAY['oauth'], 0, NULL),
      ('school A''s guardian by password',        '00000000-0000-4000-8000-000000000004', 'password', ARRAY['password'], NULL, NULL),
      ('school A''s pupil by password',           current_setting('app.test_rls76_pupil_sub'), 'password', ARRAY['password'], NULL, NULL),
      ('school A''s teacher by password',         current_setting('app.test_rls76_teacher_sub'), 'password', ARRAY['password'], NULL, NULL),
      ('school A''s admin by password',           current_setting('app.test_rls76_admin_auth'), 'password', ARRAY['password'], NULL, NULL),
      ('school A''s deactivated admin',           '00000000-0000-4000-8000-000000000003', 'password', ARRAY['password'], NULL, NULL),
      ('school A''s teacher by recovery link',    current_setting('app.test_rls76_teacher_sub'), 'recovery', ARRAY['recovery'], NULL, NULL),
      ('school A''s teacher refreshed',           current_setting('app.test_rls76_teacher_sub'), 'token_refresh', ARRAY['password'], NULL, NULL),
      ('school B''s pupil by password',           '00000000-0000-4000-8000-000000000007', 'password', ARRAY['password'], NULL, NULL),
      -- 76b: refused.
      ('school B''s teacher by password',         '00000000-0000-4000-8000-000000000001', 'password', ARRAY['password'], NULL, 'sso_required'),
      ('school B''s admin by invitation link',    '00000000-0000-4000-8000-000000000006', 'invite', ARRAY['invite'], NULL, 'sso_required'),
      ('school B''s teacher refreshing a password', '00000000-0000-4000-8000-000000000001', 'token_refresh', ARRAY['password'], NULL, 'sso_required'),
      ('school B''s teacher, school account, no identity', '00000000-0000-4000-8000-000000000001', 'oauth', ARRAY['oauth'], 0, 'sso_identity_not_allowed'),
      ('school B''s teacher by SAML',             '00000000-0000-4000-8000-000000000001', 'sso/saml', ARRAY['sso/saml'], NULL, 'sign_in_method_not_allowed'),
      ('school A''s teacher by school account',   current_setting('app.test_rls76_teacher_sub'), 'oauth', ARRAY['oauth'], 0, 'sso_not_enabled')
    ) AS t(label, sub, method, amr, age_s, expect)
  LOOP
    claims := jsonb_build_object(
      'aud', 'authenticated', 'sub', r.sub, 'role', 'authenticated', 'email', 'rls76@example.invalid',
      'session_id', gen_random_uuid(), 'aal', 'aal1', 'is_anonymous', false,
      'app_metadata', jsonb_build_object('provider', 'email'), 'user_metadata', '{}'::jsonb,
      'amr', (SELECT jsonb_agg(jsonb_build_object('method', m, 'timestamp', now_s - coalesce(r.age_s, 60))) FROM unnest(r.amr) m));
    got := sign_in.custom_access_token_hook(jsonb_build_object('user_id', r.sub, 'claims', claims, 'authentication_method', r.method));
    expected := CASE WHEN r.expect IS NULL THEN jsonb_build_object('claims', claims)
                     ELSE jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', r.expect)) END;
    IF got IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'hook: % gave %, expected %', r.label, got, expected;
    END IF;
    cases := cases + 1;
  END LOOP;

  -- 76c: school B's teacher with an Entra identity of B's tenant.
  INSERT INTO auth.identities (provider_id, user_id, identity_data, provider)
  VALUES ('rls76-entra', '00000000-0000-4000-8000-000000000001',
          jsonb_build_object('iss', 'https://login.microsoftonline.com/' || b_tenant || '/v2.0', 'sub', 'rls76-entra',
                             'custom_claims', jsonb_build_object('tid', b_tenant)),
          'azure');
  FOR r IN SELECT * FROM (VALUES
      ('B''s tenant, signed in a minute ago',        'oauth', '[{"method":"oauth","timestamp":0}]'::jsonb, 60, NULL::text),
      ('B''s tenant, refreshed after 23 hours',      'token_refresh', '[{"method":"oauth","timestamp":0}]', 23 * 3600, NULL),
      ('B''s tenant, refreshed after 25 hours',      'token_refresh', '[{"method":"oauth","timestamp":0}]', 25 * 3600, 'sso_reauth_required'),
      ('B''s tenant, with a second factor',          'totp', '[{"method":"oauth","timestamp":0},{"method":"totp","timestamp":0}]', 60, NULL),
      ('an issuance whose amr has not caught up',    'oauth', '[]', 60, 'sso_reauth_required'),
      ('B''s tenant, amr entries as plain strings',  'token_refresh', '["oauth"]', 60, 'sso_reauth_required')
    ) AS t(label, method, amr, age_s, expect)
  LOOP
    claims := jsonb_build_object(
      'aud', 'authenticated', 'sub', '00000000-0000-4000-8000-000000000001', 'role', 'authenticated',
      'session_id', gen_random_uuid(), 'aal', 'aal1', 'is_anonymous', false,
      'amr', (SELECT coalesce(jsonb_agg(CASE WHEN jsonb_typeof(e) = 'object'
                                             THEN e || jsonb_build_object('timestamp', now_s - r.age_s) ELSE e END), '[]'::jsonb)
                FROM jsonb_array_elements(r.amr) e));
    got := sign_in.custom_access_token_hook(jsonb_build_object(
      'user_id', '00000000-0000-4000-8000-000000000001', 'claims', claims, 'authentication_method', r.method));
    expected := CASE WHEN r.expect IS NULL THEN jsonb_build_object('claims', claims)
                     ELSE jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', r.expect)) END;
    IF got IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'hook: % gave %, expected %', r.label, got, expected;
    END IF;
    cases := cases + 1;
  END LOOP;

  -- The right tenant beside another one is refused.
  INSERT INTO auth.identities (provider_id, user_id, identity_data, provider)
  VALUES ('rls76-other', '00000000-0000-4000-8000-000000000001',
          jsonb_build_object('iss', 'https://login.microsoftonline.com/5e4d3c2b-1a09-4877-8665-544332211000/v2.0', 'sub', 'rls76-other'),
          'azure');
  claims := jsonb_build_object('sub', '00000000-0000-4000-8000-000000000001', 'role', 'authenticated',
                               'amr', jsonb_build_array(jsonb_build_object('method', 'oauth', 'timestamp', now_s - 60)));
  got := sign_in.custom_access_token_hook(jsonb_build_object(
    'user_id', '00000000-0000-4000-8000-000000000001', 'claims', claims, 'authentication_method', 'oauth'));
  IF got IS DISTINCT FROM '{"error": {"http_code": 403, "message": "sso_identity_not_allowed"}}'::jsonb THEN
    RAISE EXCEPTION 'hook: the right tenant beside another gave %', got;
  END IF;
  cases := cases + 1;

  -- 76d: nothing of SchemaPro's but through sign_in.rules.
  BEGIN
    PERFORM 1 FROM public."Users" LIMIT 1;
    RAISE EXCEPTION 'hook: supabase_auth_admin read Users directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM app.current_school_id();
    RAISE EXCEPTION 'hook: supabase_auth_admin ran a helper in app';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  IF cases < 23 THEN RAISE EXCEPTION 'hook: only % case(s) ran', cases; END IF;
  SET LOCAL ROLE app_authenticated;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 80: ett jobb körs en gång per skola och natt, och varje körning
-- räknas (JobRuns, JobClaims, 20261021090000).
--
-- The gateway's job runner keeps two tables only its SECURITY DEFINER
-- functions touch. 80a reads the catalogue: no API role holds any privilege
-- on either table, and the four app.job_* functions are EXECUTE for
-- app_authenticated alone. 80b claims the gallring school's nightly job at
-- fixed local times of today: once at noon, not again within two hours, again
-- once a claim has gone two hours unfinished (its instance died), not at all
-- once finished, and never before the hour. Two instances asking at once are
-- the primary key's to settle, so one claim per (job, school, day) is the
-- property. 80c settles two ticks: runs, failures and counts sum, and a
-- count that is not a count, or an error that is not a class name, is
-- refused by the table, so no id, name or message can be written there.
-- ---------------------------------------------------------------------------

BEGIN;

-- 80a.
DO $$
DECLARE
  bad text;
  checked int;
BEGIN
  SELECT count(*) INTO checked FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname IN ('JobRuns', 'JobClaims');
  IF checked <> 2 THEN RAISE EXCEPTION 'job runner: expected JobRuns and JobClaims, found % of them', checked; END IF;

  SELECT string_agg(format('%s on %s', r.rolname, c.relname), ', ') INTO bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   CROSS JOIN pg_roles r
   WHERE n.nspname = 'public' AND c.relname IN ('JobRuns', 'JobClaims')
     AND r.rolname IN ('app_authenticated', 'authenticated', 'anon', 'service_role')
     AND (has_table_privilege(r.oid, c.oid, 'SELECT') OR has_table_privilege(r.oid, c.oid, 'INSERT')
          OR has_table_privilege(r.oid, c.oid, 'UPDATE') OR has_table_privilege(r.oid, c.oid, 'DELETE')
          OR has_table_privilege(r.oid, c.oid, 'TRUNCATE'));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'job runner: an API role reaches the runner''s tables directly: %', bad;
  END IF;

  SELECT string_agg(p.oid::regprocedure::text || ' for ' || r.rolname, ', ') INTO bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   CROSS JOIN pg_roles r
   WHERE n.nspname = 'app' AND p.proname LIKE 'job\_%'
     AND r.rolname IN ('authenticated', 'anon', 'service_role')
     AND has_function_privilege(r.oid, p.oid, 'EXECUTE');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'job runner: a role other than the gateway''s may run %', bad;
  END IF;
  SELECT count(*) INTO checked FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app' AND p.proname LIKE 'job\_%'
     AND p.prosecdef AND has_function_privilege('app_authenticated', p.oid, 'EXECUTE');
  IF checked <> 4 THEN
    RAISE EXCEPTION 'job runner: expected the four app.job_* definer functions for the gateway, found %', checked;
  END IF;
END $$;

-- 80b. The gallring school's id, read as its admin; the claims run with no
-- principal, as the runner does.
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000081')::text, true);
SELECT set_config('app.test_rls80_school', app.current_school_id()::text, true);
SELECT set_config('request.jwt.claims', '', true);
DO $$
DECLARE
  school uuid := current_setting('app.test_rls80_school')::uuid;
  today date := (now() AT TIME ZONE 'Europe/Stockholm')::date;
  at_local timestamp;
  n int;
  d date;
BEGIN
  IF school IS NULL THEN RAISE EXCEPTION 'job claims: the gallring fixture school is missing'; END IF;
  IF app.current_user_id() IS NOT NULL THEN RAISE EXCEPTION 'job claims: expected no principal'; END IF;

  -- Before the hour: nothing.
  SELECT count(*) INTO n FROM app.job_claim_nightly('rls80', 3, ARRAY[school], 5, (today + time '02:30') AT TIME ZONE 'Europe/Stockholm');
  IF n <> 0 THEN RAISE EXCEPTION 'job claims: claimed at 02:30 for a 03:00 job'; END IF;

  SELECT count(*), max(local_day) INTO n, d FROM app.job_claim_nightly('rls80', 3, ARRAY[school], 5, (today + time '12:00') AT TIME ZONE 'Europe/Stockholm');
  IF n <> 1 OR d <> today THEN RAISE EXCEPTION 'job claims: the first claim of the day gave % row(s) for %', n, d; END IF;

  SELECT count(*) INTO n FROM app.job_claim_nightly('rls80', 3, ARRAY[school], 5, (today + time '13:00') AT TIME ZONE 'Europe/Stockholm');
  IF n <> 0 THEN RAISE EXCEPTION 'job claims: a second instance claimed the same school and night an hour later'; END IF;

  -- Two hours unfinished: its instance died, and the night is taken again.
  SELECT count(*) INTO n FROM app.job_claim_nightly('rls80', 3, ARRAY[school], 5, (today + time '14:30') AT TIME ZONE 'Europe/Stockholm');
  IF n <> 1 THEN RAISE EXCEPTION 'job claims: a claim unfinished for two and a half hours was not taken again'; END IF;

  PERFORM app.job_claim_finished('rls80', school, today, (today + time '14:40') AT TIME ZONE 'Europe/Stockholm');
  SELECT count(*) INTO n FROM app.job_claim_nightly('rls80', 3, ARRAY[school], 5, (today + time '23:00') AT TIME ZONE 'Europe/Stockholm');
  IF n <> 0 THEN RAISE EXCEPTION 'job claims: a finished night was claimed again'; END IF;

  -- Another job's claim is its own.
  SELECT count(*) INTO n FROM app.job_claim_nightly('rls80-other', 3, ARRAY[school], 5, (today + time '23:00') AT TIME ZONE 'Europe/Stockholm');
  IF n <> 1 THEN RAISE EXCEPTION 'job claims: one job''s claim blocked another job'; END IF;
END $$;

-- A school another instance is working on does not use up the limit: with
-- one of two schools claimed an hour ago, a limit of one claims the other.
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
SELECT set_config('app.test_rls80_school_a', app.current_school_id()::text, true);
SELECT set_config('request.jwt.claims', '', true);
DO $$
DECLARE
  schools uuid[] := ARRAY[current_setting('app.test_rls80_school')::uuid, current_setting('app.test_rls80_school_a')::uuid];
  first_ uuid := least(schools[1], schools[2]);
  other uuid := greatest(schools[1], schools[2]);
  today date := (now() AT TIME ZONE 'Europe/Stockholm')::date;
  got uuid[];
BEGIN
  PERFORM app.job_claim_nightly('rls80-limit', 3, ARRAY[first_], 1, (today + time '12:00') AT TIME ZONE 'Europe/Stockholm');
  got := ARRAY(SELECT school_id FROM app.job_claim_nightly('rls80-limit', 3, schools, 1, (today + time '13:00') AT TIME ZONE 'Europe/Stockholm'));
  IF got IS DISTINCT FROM ARRAY[other] THEN
    RAISE EXCEPTION 'job claims: with one school taken, a limit of one claimed % instead of the other school', got;
  END IF;
END $$;

-- 80c.
DO $$
DECLARE
  latest record;
BEGIN
  PERFORM app.job_run_settled('rls80', now() - interval '2 seconds', now() - interval '1 second', true, NULL, '{"claimed": 2, "purged": 5}');
  PERFORM app.job_run_settled('rls80', now() - interval '1 second', now(), false, 'PrismaClientKnownRequestError', '{"claimed": 1}');
  SELECT * INTO latest FROM app.job_runs_latest() WHERE job = 'rls80';
  IF latest.last_failed IS NULL THEN RAISE EXCEPTION 'job runs: the failed tick left no failure'; END IF;

  BEGIN
    PERFORM app.job_run_settled('rls80', now(), now(), true, NULL, '{"school": "6f1c…"}');
    RAISE EXCEPTION 'job runs: a text value was written among the counts';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM app.job_run_settled('rls80', now(), now(), true, NULL, '{"purged": -1}');
    RAISE EXCEPTION 'job runs: a negative count was written';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM app.job_run_settled('rls80', now(), now(), true, NULL, '{"user 6f1c": 1}');
    RAISE EXCEPTION 'job runs: a count under a key that is no name was written';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM app.job_run_settled('rls80', now(), now(), false, 'connect ECONNREFUSED postgresql://u:p@db/app', '{}');
    RAISE EXCEPTION 'job runs: an error message, not a class name, was written';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- The sums, read as the owner would: through the one row the two settles
-- made. No API role may read the table, so the definer reader is asked for
-- the day's row by a second settle of zero counts and the latest row.
DO $$
DECLARE
  latest record;
BEGIN
  SELECT * INTO latest FROM app.job_runs_latest() WHERE job = 'rls80';
  IF latest.last_finished IS NULL THEN RAISE EXCEPTION 'job runs: no row for the job'; END IF;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 81: skolans beslut om gallring och körningarna är administratörens
-- (RetentionDecisions, GallringRuns, 20261021110000).
--
-- A decision is the school administrator's to record and read; nobody else
-- of the school reads or writes one, and no administrator reaches another
-- school's. The row is stamped by the database: decidedAt and decidedById are
-- not the statement's to give (no column grant), and a decision is never
-- changed or removed (no grant; the trigger refuses even the owner, outside a
-- cascade). Runs are read by the administrator and written only by the
-- gallring functions. PostgREST's role reaches neither table. Last, a rule for
-- later phases: every foreign key into LeaveRequests cascades, so whatever a
-- later phase hangs off a leave request (a mentor's decision, say) goes with
-- it when gallring takes the request, or sets only its nullable link column
-- NULL, so a row of another kind stays and the purge is never refused.
-- ---------------------------------------------------------------------------

BEGIN;

-- 81a: the gallring school's admin records and reads a decision.
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000081')::text, true);
DO $$
DECLARE
  me uuid := app.current_user_id();
  school uuid := app.current_school_id();
  row_ record;
  n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'SCHOOL_ADMIN' THEN RAISE EXCEPTION 'retention decisions: expected the gallring admin'; END IF;
  INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision, months, reference)
  VALUES (school, 'NOTIFICATIONS', 'PURGE_AFTER', 3, 'rls81');
  SELECT * INTO row_ FROM "RetentionDecisions" WHERE reference = 'rls81';
  IF row_."decidedById" IS DISTINCT FROM me THEN RAISE EXCEPTION 'retention decisions: decidedById is %, not the admin', row_."decidedById"; END IF;
  IF row_."decidedAt" < now() OR row_."decidedAt" > clock_timestamp() THEN
    RAISE EXCEPTION 'retention decisions: decidedAt % is not the moment of the insert', row_."decidedAt";
  END IF;

  BEGIN
    INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision, months, "decidedAt")
    VALUES (school, 'NOTIFICATIONS', 'PURGE_AFTER', 1, now() - interval '3 days');
    RAISE EXCEPTION 'retention decisions: the admin back-dated a decision past the 24-hour wait';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision, months, "decidedById")
    VALUES (school, 'NOTIFICATIONS', 'PURGE_AFTER', 1, NULL);
    RAISE EXCEPTION 'retention decisions: the admin named who decided';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE "RetentionDecisions" SET months = 1 WHERE reference = 'rls81';
    RAISE EXCEPTION 'retention decisions: a recorded decision was changed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM "RetentionDecisions" WHERE reference = 'rls81';
    RAISE EXCEPTION 'retention decisions: a recorded decision was removed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision) VALUES (school, 'NOTIFICATIONS', 'PURGE_AFTER');
    RAISE EXCEPTION 'retention decisions: a period without months was recorded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision, months) VALUES (school, 'NOTIFICATIONS', 'KEEP', 12);
    RAISE EXCEPTION 'retention decisions: KEEP was recorded with months';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision, months) VALUES (school, 'NOTIFICATIONS', 'PURGE_AFTER', 121);
    RAISE EXCEPTION 'retention decisions: a period over ten years was recorded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  SELECT count(*) INTO n FROM "RetentionDecisions";
  IF n < 7 THEN RAISE EXCEPTION 'retention decisions: the admin sees % of the school''s decisions', n; END IF;
  SELECT count(*) INTO n FROM "RetentionDecisions" WHERE "schoolId" <> school;
  IF n <> 0 THEN RAISE EXCEPTION 'retention decisions: the admin sees % decision(s) of another school', n; END IF;
  PERFORM set_config('app.test_rls81_school', school::text, true);
END $$;

-- 81b: school A's admin sees none of the gallring school's decisions and may
-- not record one for it; a teacher records and reads none, as both roles.
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
DECLARE
  other uuid := current_setting('app.test_rls81_school')::uuid;
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM "RetentionDecisions" WHERE "schoolId" = other;
  IF n <> 0 THEN RAISE EXCEPTION 'retention decisions: school A''s admin reads % decision(s) of another school', n; END IF;
  SELECT count(*) INTO n FROM "GallringRuns" WHERE "schoolId" = other;
  IF n <> 0 THEN RAISE EXCEPTION 'gallring runs: school A''s admin reads another school''s runs'; END IF;
  BEGIN
    INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision, months) VALUES (other, 'ATTENDANCE', 'PURGE_AFTER', 1);
    RAISE EXCEPTION 'retention decisions: school A''s admin recorded a period for another school';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000082')::text, true);
DO $$
DECLARE
  school uuid := app.current_school_id();
  via text;
  n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'TEACHER' THEN RAISE EXCEPTION 'retention decisions: expected the gallring teacher'; END IF;
  FOREACH via IN ARRAY ARRAY['app_authenticated', 'authenticated'] LOOP
    EXECUTE format('SET LOCAL ROLE %I', via);
    IF current_user <> via THEN RAISE EXCEPTION 'retention decisions: running as %, not %', current_user, via; END IF;
    BEGIN
      SELECT count(*) INTO n FROM "RetentionDecisions";
      IF n <> 0 THEN RAISE EXCEPTION 'retention decisions: a teacher reads % decision(s) through %', n, via; END IF;
    EXCEPTION WHEN insufficient_privilege THEN
      IF via = 'app_authenticated' THEN RAISE EXCEPTION 'retention decisions: the gateway''s role cannot read the table at all'; END IF;
    END;
    BEGIN
      INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision) VALUES (school, 'ATTENDANCE', 'KEEP');
      RAISE EXCEPTION 'retention decisions: a teacher recorded a decision through %', via;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      SELECT count(*) INTO n FROM "GallringRuns";
      IF n <> 0 THEN RAISE EXCEPTION 'gallring runs: a teacher reads % run(s) through %', n, via; END IF;
    EXCEPTION WHEN insufficient_privilege THEN
      IF via = 'app_authenticated' THEN RAISE EXCEPTION 'gallring runs: the gateway''s role cannot read the table at all'; END IF;
    END;
  END LOOP;
  SET LOCAL ROLE app_authenticated;
END $$;

-- 81c: the catalogue. PostgREST's role and anon hold nothing on either table;
-- the gateway's role reads both and inserts decisions without decidedAt or
-- decidedById, and writes no run; service_role reads at most.
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(format('%s %s on %s', r.rolname, p.priv, c.relname), ', ') INTO bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   CROSS JOIN pg_roles r
   CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p(priv)
   WHERE n.nspname = 'public' AND c.relname IN ('RetentionDecisions', 'GallringRuns')
     AND (
          (r.rolname IN ('authenticated', 'anon') AND has_table_privilege(r.oid, c.oid, p.priv))
       OR (r.rolname = 'service_role' AND p.priv <> 'SELECT' AND has_table_privilege(r.oid, c.oid, p.priv))
       OR (r.rolname = 'app_authenticated' AND p.priv NOT IN ('SELECT', 'INSERT') AND has_table_privilege(r.oid, c.oid, p.priv))
       OR (r.rolname = 'app_authenticated' AND c.relname = 'GallringRuns' AND p.priv = 'INSERT' AND has_table_privilege(r.oid, c.oid, p.priv))
     );
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'retention tables: a role holds more than it needs: %', bad; END IF;
  IF has_any_column_privilege('app_authenticated', '"GallringRuns"', 'INSERT')
     OR has_column_privilege('app_authenticated', '"RetentionDecisions"', 'decidedAt', 'INSERT')
     OR has_column_privilege('app_authenticated', '"RetentionDecisions"', 'decidedById', 'INSERT')
     OR has_any_column_privilege('app_authenticated', '"RetentionDecisions"', 'UPDATE') THEN
    RAISE EXCEPTION 'retention tables: the gateway''s role may write a stamp or a run';
  END IF;
  IF NOT has_column_privilege('app_authenticated', '"RetentionDecisions"', 'months', 'INSERT') THEN
    RAISE EXCEPTION 'retention tables: the gateway''s role cannot record a period';
  END IF;

  -- The functions: the nine the gateway calls are its alone; the helpers
  -- they share (the predicate, the period in force, the guard's test) are
  -- the owner's.
  SELECT string_agg(p.oid::regprocedure::text || ' for ' || r.rolname, ', ') INTO bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   CROSS JOIN pg_roles r
   WHERE n.nspname = 'app' AND (p.proname LIKE 'gallring\_%' OR p.proname LIKE 'retention\_%')
     AND (r.rolname IN ('authenticated', 'anon', 'service_role')
          OR (r.rolname = 'app_authenticated' AND p.proname NOT IN (
                'gallring_schools', 'gallring_begin', 'gallring_purge', 'gallring_departed_due', 'gallring_claim_person',
                'gallring_pseudonymise', 'gallring_finish', 'gallring_preview', 'retention_purged_before')))
     AND has_function_privilege(r.oid, p.oid, 'EXECUTE');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'retention functions: a role may run more than it needs: %', bad; END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'app' AND p.prosecdef AND has_function_privilege('app_authenticated', p.oid, 'EXECUTE')
         AND p.proname IN ('gallring_schools', 'gallring_begin', 'gallring_purge', 'gallring_departed_due', 'gallring_claim_person',
                           'gallring_pseudonymise', 'gallring_finish', 'gallring_preview', 'retention_purged_before')) <> 9 THEN
    RAISE EXCEPTION 'retention functions: the gateway lacks one of its nine definer functions';
  END IF;
END $$;

-- 81d: a foreign key into LeaveRequests cascades (a row that is part of the
-- request goes with it) or sets NULL (a row of another kind of data keeps its
-- own period and loses the link, 20261021120000). NO ACTION or RESTRICT would
-- refuse the purge, SET DEFAULT would point the row at another request.
--
-- A SET NULL clears only columns that may be NULL. Keys between a school's
-- tables are composite with "schoolId", which is NOT NULL, so a plain
-- ON DELETE SET NULL on a key into a request would clear it too: 23502
-- inside app.gallring_purge, and the school's LEAVE_REQUESTS purge failing
-- every night. Such a key names its link column, ON DELETE SET NULL
-- ("…Id"), as section 19's predecessor keys do. The columns a SET NULL
-- clears are those it names (confdelsetcols), or else the whole key.
--
-- The same reading runs over a stand-in of the session's own, two temporary
-- tables with one key of each kind, so it is shown to refuse what it must.
CREATE TEMP TABLE rls81d_request (id uuid, "schoolId" uuid NOT NULL, UNIQUE (id), UNIQUE (id, "schoolId")) ON COMMIT DROP;
CREATE TEMP TABLE rls81d_row (
  "requestId" uuid,
  "schoolId" uuid NOT NULL,
  CONSTRAINT rls81d_part FOREIGN KEY ("requestId", "schoolId") REFERENCES rls81d_request (id, "schoolId") ON DELETE CASCADE,
  CONSTRAINT rls81d_link FOREIGN KEY ("requestId", "schoolId") REFERENCES rls81d_request (id, "schoolId") ON DELETE SET NULL ("requestId"),
  CONSTRAINT rls81d_loose FOREIGN KEY ("requestId") REFERENCES rls81d_request (id) ON DELETE SET NULL,
  CONSTRAINT rls81d_whole FOREIGN KEY ("requestId", "schoolId") REFERENCES rls81d_request (id, "schoolId") ON DELETE SET NULL,
  CONSTRAINT rls81d_school FOREIGN KEY ("requestId", "schoolId") REFERENCES rls81d_request (id, "schoolId") ON DELETE SET NULL ("schoolId"),
  CONSTRAINT rls81d_refuses FOREIGN KEY ("requestId", "schoolId") REFERENCES rls81d_request (id, "schoolId")
) ON COMMIT DROP;
DO $$
DECLARE
  target regclass;
  bad text;
BEGIN
  FOREACH target IN ARRAY ARRAY['"LeaveRequests"'::regclass, 'rls81d_request'::regclass] LOOP
    SELECT string_agg(format('%s (%s)', con.conname, con.conrelid::regclass), ', ' ORDER BY con.conname) INTO bad
      FROM pg_constraint con
     WHERE con.contype = 'f' AND con.confrelid = target
       AND (con.confdeltype NOT IN ('c', 'n')
            OR (con.confdeltype = 'n' AND EXISTS (
                  SELECT 1 FROM pg_attribute a
                   WHERE a.attrelid = con.conrelid AND a.attnotnull
                     AND a.attnum = ANY (COALESCE(con.confdelsetcols, con.conkey)))));
    IF target = '"LeaveRequests"'::regclass AND bad IS NOT NULL THEN
      RAISE EXCEPTION 'leave retention: % neither cascades nor sets only nullable columns NULL; cascade it if it is part of the request, ON DELETE SET NULL ("…Id") naming the link if it is a row of another kind', bad;
    END IF;
    IF target = 'rls81d_request'::regclass
       AND bad IS DISTINCT FROM 'rls81d_refuses (rls81d_row), rls81d_school (rls81d_row), rls81d_whole (rls81d_row)' THEN
      RAISE EXCEPTION 'leave retention: of the stand-in''s keys the rule refused %, not the NO ACTION one and the two that clear "schoolId"', COALESCE(bad, 'none');
    END IF;
  END LOOP;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 82: ett beslut som gallrar mer väntar ett dygn, ett som gallrar
-- mindre gäller direkt (app.retention_months_in_force, 20261021110000).
--
-- The gallring school's fixture decisions are two days old: attendance 12
-- months and no decision on notices. As its admin, new decisions are recorded
-- in the transaction and a run is opened; the periods it applies are read off
-- the run. A shorter attendance period (1 month) changes nothing yet; a longer
-- one (36) applies at once and the longest of the day's wins; KEEP and
-- UNDECIDED stop it at once. A first period for notices applies nothing for a
-- day. A school with no decision at all (school A) opens a run with no
-- period.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000081')::text, true);
DO $$
DECLARE
  school uuid := app.current_school_id();
  run uuid;
  p jsonb;
BEGIN
  run := app.gallring_begin(school, clock_timestamp());
  SELECT periods INTO p FROM "GallringRuns" WHERE id = run;
  IF p <> '{"ATTENDANCE": 12, "ABSENCE_REPORTS": 6, "LEAVE_REQUESTS": 12, "CHANGE_LOGS": 24, "ABSENCE_REASONS": 12, "DEPARTED_PEOPLE": 12}'::jsonb THEN
    RAISE EXCEPTION 'period in force: the fixture''s decisions gave %', p;
  END IF;

  INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision, months) VALUES (school, 'ATTENDANCE', 'PURGE_AFTER', 1);
  INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision, months) VALUES (school, 'NOTIFICATIONS', 'PURGE_AFTER', 1);
  run := app.gallring_begin(school, clock_timestamp());
  SELECT periods INTO p FROM "GallringRuns" WHERE id = run;
  IF (p ->> 'ATTENDANCE')::int IS DISTINCT FROM 12 THEN
    RAISE EXCEPTION 'period in force: a shorter period applied at once (attendance %)', p ->> 'ATTENDANCE';
  END IF;
  IF p ? 'NOTIFICATIONS' THEN
    RAISE EXCEPTION 'period in force: a first period applied at once (notices %)', p ->> 'NOTIFICATIONS';
  END IF;
  IF (SELECT count(*) FROM "GallringRuns" WHERE "schoolId" = school AND status = 'INTERRUPTED') <> 1 THEN
    RAISE EXCEPTION 'period in force: the earlier unfinished run was not marked INTERRUPTED';
  END IF;

  INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision, months) VALUES (school, 'ATTENDANCE', 'PURGE_AFTER', 36);
  run := app.gallring_begin(school, clock_timestamp());
  SELECT periods INTO p FROM "GallringRuns" WHERE id = run;
  IF (p ->> 'ATTENDANCE')::int IS DISTINCT FROM 36 THEN
    RAISE EXCEPTION 'period in force: a longer period did not apply at once (attendance %)', p ->> 'ATTENDANCE';
  END IF;

  INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision) VALUES (school, 'ABSENCE_REPORTS', 'KEEP');
  INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision) VALUES (school, 'LEAVE_REQUESTS', 'UNDECIDED');
  run := app.gallring_begin(school, clock_timestamp());
  SELECT periods INTO p FROM "GallringRuns" WHERE id = run;
  IF p ? 'ABSENCE_REPORTS' OR p ? 'LEAVE_REQUESTS' THEN
    RAISE EXCEPTION 'period in force: KEEP or UNDECIDED did not stop the next run (%)', p;
  END IF;

  BEGIN
    PERFORM app.gallring_begin(school, now() + interval '25 hours');
    RAISE EXCEPTION 'period in force: a run was opened a day ahead, past the wait';
  EXCEPTION WHEN SQLSTATE 'GL400' THEN NULL;
  END;

  -- A decision recorded while a run is open spares what it spares: the run
  -- asks again before every batch.
  run := app.gallring_begin(school, clock_timestamp());
  INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision) VALUES (school, 'ABSENCE_REASONS', 'KEEP');
  IF app.gallring_purge(run, 'ABSENCE_REASONS', 5000) <> 0 THEN
    RAISE EXCEPTION 'period in force: an open run purged a kind the school had just decided to keep';
  END IF;
END $$;

SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
DECLARE
  school uuid := app.current_school_id();
  run uuid;
  kind "RetentionDataType";
  p jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM "RetentionDecisions") THEN
    RAISE EXCEPTION 'unset period: school A has a decision; this section needs a school with none';
  END IF;
  run := app.gallring_begin(school, clock_timestamp());
  SELECT periods INTO p FROM "GallringRuns" WHERE id = run;
  IF p <> '{}'::jsonb THEN RAISE EXCEPTION 'unset period: a school with no decision got periods %', p; END IF;
  FOREACH kind IN ARRAY ARRAY['ATTENDANCE', 'ABSENCE_REPORTS', 'LEAVE_REQUESTS', 'NOTIFICATIONS', 'CHANGE_LOGS', 'ABSENCE_REASONS']::"RetentionDataType"[] LOOP
    IF app.gallring_purge(run, kind, 5000) <> 0 THEN
      RAISE EXCEPTION 'unset period: % rows went from school A, which decided nothing', kind;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM app.gallring_departed_due(run, 500)) THEN
    RAISE EXCEPTION 'unset period: school A has people due for pseudonymisation';
  END IF;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 83: gallringen tar exakt det perioden säger, och inget annat
-- (app.gallring_*, 20261021110000).
--
-- One night in the gallring school, run as the job runs it: no principal.
-- Before and after, its admin counts each kind on both sides of its cutoff,
-- and school A's admin counts school A. Everything dated before a cutoff of a
-- decided kind is gone, everything on or after it is still there, the notice
-- of the undecided kind is still there, the reason of an old absence is NULL
-- while its cover stays, and school A has not moved. The run's counts are the
-- rows that went, and "gallrat före" answers the cutoffs. Run under an admin
-- principal instead, the purge of the tjänst history is refused (TL403): the
-- guards let a purge through only with no principal set.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
BEGIN
  PERFORM set_config('app.test_rls83_a', (
    SELECT jsonb_build_object(
      'att', (SELECT count(*) FROM "AttendanceRecords"), 'abs', (SELECT count(*) FROM "AbsenceReports"),
      'leave', (SELECT count(*) FROM "LeaveRequests"), 'noti', (SELECT count(*) FROM "Notifications"),
      'log', (SELECT count(*) FROM "ScheduleChangeLogs"), 'emp', (SELECT count(*) FROM "TeacherEmploymentLogs"),
      'hist', (SELECT count(*) FROM "GuardianStudentHistory"),
      'reasons', (SELECT count(*) FROM "TeacherAbsences" WHERE "reasonId" IS NOT NULL),
      'users', (SELECT md5(string_agg(u::text, ',' ORDER BY id)) FROM "Users" u))::text), true);
END $$;

SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000006')::text, true);
DO $$
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'SCHOOL_ADMIN' THEN RAISE EXCEPTION 'gallring: expected school B''s admin'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "AbsenceReports" WHERE date < DATE '2021-01-01') THEN
    RAISE EXCEPTION 'gallring: school B has no old rows; a purge that forgot its school would pass';
  END IF;
  PERFORM set_config('app.test_rls83_b', (
    SELECT jsonb_build_object(
      'att', (SELECT count(*) FROM "AttendanceRecords"), 'abs', (SELECT count(*) FROM "AbsenceReports"),
      'leave', (SELECT count(*) FROM "LeaveRequests"), 'noti', (SELECT count(*) FROM "Notifications"),
      'log', (SELECT count(*) FROM "ScheduleChangeLogs"), 'emp', (SELECT count(*) FROM "TeacherEmploymentLogs"),
      'hist', (SELECT count(*) FROM "GuardianStudentHistory"),
      'reasons', (SELECT count(*) FROM "TeacherAbsences" WHERE "reasonId" IS NOT NULL),
      'users', (SELECT md5(string_agg(u::text, ',' ORDER BY id)) FROM "Users" u))::text), true);
END $$;

SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000081')::text, true);
DO $$
DECLARE
  school uuid := app.current_school_id();
  today date := (now() AT TIME ZONE 'Europe/Stockholm')::date;
BEGIN
  PERFORM set_config('app.test_rls83_school', school::text, true);
  PERFORM set_config('app.test_rls83_before', jsonb_build_object(
    'att_old', (SELECT count(*) FROM "AttendanceRecords" a JOIN "CalendarLessons" l ON l.id = a."calendarLessonId" WHERE l.date < today - interval '12 months'),
    'att_kept', (SELECT count(*) FROM "AttendanceRecords" a JOIN "CalendarLessons" l ON l.id = a."calendarLessonId" WHERE l.date >= today - interval '12 months'),
    'abs_old', (SELECT count(*) FROM "AbsenceReports" WHERE date < today - interval '6 months'),
    'abs_kept', (SELECT count(*) FROM "AbsenceReports" WHERE date >= today - interval '6 months'),
    'leave_old', (SELECT count(*) FROM "LeaveRequests" WHERE "endDate" < today - interval '12 months'),
    'leave_kept', (SELECT count(*) FROM "LeaveRequests" WHERE "endDate" >= today - interval '12 months'),
    'noti', (SELECT count(*) FROM "Notifications" WHERE "createdAt" < now() - interval '1 year'),
    'emp_cur', (SELECT count(*) FROM "TeacherEmploymentLogs" g JOIN "AcademicYears" y ON y.id = g."academicYearId" WHERE y."isActive"),
    'emp_old', (SELECT count(*) FROM "TeacherEmploymentLogs" g JOIN "AcademicYears" y ON y.id = g."academicYearId" WHERE y."endDate" < today - interval '24 months'),
    'covers', (SELECT count(*) FROM "TeacherAbsenceCovers"))::text, true);
  IF (current_setting('app.test_rls83_before')::jsonb ->> 'att_old')::int < 2
     OR (current_setting('app.test_rls83_before')::jsonb ->> 'att_kept')::int < 2
     OR (current_setting('app.test_rls83_before')::jsonb ->> 'emp_old')::int < 2
     OR (current_setting('app.test_rls83_before')::jsonb ->> 'noti')::int < 1 THEN
    RAISE EXCEPTION 'gallring: the fixture school lacks rows on both sides of its cutoffs: %', current_setting('app.test_rls83_before');
  END IF;
END $$;

-- Under the admin's own principal the history's guard holds.
DO $$
DECLARE
  run uuid := app.gallring_begin(app.current_school_id(), clock_timestamp());
BEGIN
  BEGIN
    PERFORM app.gallring_purge(run, 'CHANGE_LOGS', 5000);
    RAISE EXCEPTION 'gallring: a purge under a person''s principal went past the tjänst history''s guard';
  EXCEPTION WHEN SQLSTATE 'TL403' THEN NULL;
  END;
END $$;

-- The night, with no principal: the people first (so 84 can see that their
-- tjänst lost its signature without a version), then every kind until done.
SELECT set_config('request.jwt.claims', '', true);
DO $$
DECLARE
  school uuid := current_setting('app.test_rls83_school')::uuid;
  run uuid;
  kind "RetentionDataType";
  n int;
  people uuid[];
BEGIN
  IF app.current_user_id() IS NOT NULL THEN RAISE EXCEPTION 'gallring: expected no principal for the night'; END IF;
  run := app.gallring_begin(school, clock_timestamp());
  PERFORM set_config('app.test_rls83_run', run::text, true);
  people := ARRAY(SELECT user_id FROM app.gallring_departed_due(run, 500));
  PERFORM set_config('app.test_rls83_people', array_to_string(people, ','), true);
  n := app.gallring_pseudonymise(run, people);
  IF n <> 2 THEN RAISE EXCEPTION 'gallring: % people pseudonymised, expected the departed pupil and teacher', n; END IF;
  FOREACH kind IN ARRAY ARRAY['ATTENDANCE', 'ABSENCE_REPORTS', 'LEAVE_REQUESTS', 'NOTIFICATIONS', 'CHANGE_LOGS', 'ABSENCE_REASONS']::"RetentionDataType"[] LOOP
    LOOP
      n := app.gallring_purge(run, kind, 1);
      EXIT WHEN n = 0;
    END LOOP;
  END LOOP;
  PERFORM app.gallring_finish(run, '{}', now());
END $$;

SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000081')::text, true);
DO $$
DECLARE
  today date := (now() AT TIME ZONE 'Europe/Stockholm')::date;
  b jsonb := current_setting('app.test_rls83_before')::jsonb;
  run record;
  n bigint;
  purged record;
BEGIN
  SELECT count(*) INTO n FROM "AttendanceRecords" a JOIN "CalendarLessons" l ON l.id = a."calendarLessonId" WHERE l.date < today - interval '12 months';
  IF n <> 0 THEN RAISE EXCEPTION 'gallring: % attendance row(s) older than 12 months stayed', n; END IF;
  SELECT count(*) INTO n FROM "AttendanceRecords" a JOIN "CalendarLessons" l ON l.id = a."calendarLessonId" WHERE l.date >= today - interval '12 months';
  IF n <> (b ->> 'att_kept')::bigint THEN RAISE EXCEPTION 'gallring: attendance on or after the cutoff went (% of %)', n, b ->> 'att_kept'; END IF;

  SELECT count(*) INTO n FROM "AbsenceReports" WHERE date < today - interval '6 months';
  IF n <> 0 THEN RAISE EXCEPTION 'gallring: % absence report(s) older than 6 months stayed', n; END IF;
  SELECT count(*) INTO n FROM "AbsenceReports";
  IF n <> (b ->> 'abs_kept')::bigint THEN RAISE EXCEPTION 'gallring: a newer absence report went'; END IF;

  SELECT count(*) INTO n FROM "LeaveRequests" WHERE "endDate" < today - interval '12 months';
  IF n <> 0 THEN RAISE EXCEPTION 'gallring: % leave request(s) ended before the cutoff stayed', n; END IF;
  SELECT count(*) INTO n FROM "LeaveRequests";
  IF n <> (b ->> 'leave_kept')::bigint OR NOT EXISTS (SELECT 1 FROM "LeaveRequests" WHERE reason = 'Gallring: lång') THEN
    RAISE EXCEPTION 'gallring: a request that ended after the cutoff went (the one begun before it included)';
  END IF;

  SELECT count(*) INTO n FROM "Notifications" WHERE "createdAt" < now() - interval '1 year';
  IF n <> (b ->> 'noti')::bigint THEN RAISE EXCEPTION 'gallring: a notice went although the school decided nothing about notices'; END IF;

  SELECT count(*) INTO n FROM "ScheduleChangeLogs" WHERE "createdAt" < now() - interval '24 months';
  IF n <> 0 THEN RAISE EXCEPTION 'gallring: a schedule log older than 24 months stayed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "ScheduleChangeLogs" WHERE "createdAt" >= now() - interval '24 months') THEN
    RAISE EXCEPTION 'gallring: a newer schedule log went';
  END IF;
  SELECT count(*) INTO n FROM "TeacherEmploymentLogs" g JOIN "AcademicYears" y ON y.id = g."academicYearId" WHERE y."endDate" < today - interval '24 months';
  IF n <> 0 THEN RAISE EXCEPTION 'gallring: % tjänst history row(s) of a läsår past the period stayed', n; END IF;
  SELECT count(*) INTO n FROM "TeacherEmploymentLogs" g JOIN "AcademicYears" y ON y.id = g."academicYearId" WHERE y."isActive";
  IF n <> (b ->> 'emp_cur')::bigint THEN RAISE EXCEPTION 'gallring: this läsår''s tjänst history moved (% of %)', n, b ->> 'emp_cur'; END IF;
  IF EXISTS (SELECT 1 FROM "GuardianStudentHistory" WHERE "unlinkedAt" < now() - interval '24 months') THEN
    RAISE EXCEPTION 'gallring: a guardian unlink older than 24 months stayed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "GuardianStudentHistory" WHERE "unlinkedAt" BETWEEN now() - interval '2 months' AND now() - interval '2 weeks') THEN
    RAISE EXCEPTION 'gallring: a newer guardian unlink went';
  END IF;

  IF EXISTS (SELECT 1 FROM "TeacherAbsences" WHERE "endsAt" < now() - interval '12 months' AND "reasonId" IS NOT NULL) THEN
    RAISE EXCEPTION 'gallring: an old absence kept its reason';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "TeacherAbsences" WHERE "endsAt" >= now() - interval '12 months' AND "reasonId" IS NOT NULL) THEN
    RAISE EXCEPTION 'gallring: a newer absence lost its reason';
  END IF;
  IF (SELECT count(*) FROM "TeacherAbsences") <> 2 OR (SELECT count(*) FROM "TeacherAbsenceCovers") <> (b ->> 'covers')::bigint THEN
    RAISE EXCEPTION 'gallring: an absence or its cover went with the reason; payroll needs them';
  END IF;

  -- The run's evidence: what went, per kind, and that nothing was left.
  SELECT * INTO run FROM "GallringRuns" WHERE id = current_setting('app.test_rls83_run')::uuid;
  IF run.status <> 'DONE' OR run."finishedAt" IS NULL THEN RAISE EXCEPTION 'gallring: the run is %, not DONE', run.status; END IF;
  IF (run.counts ->> 'ATTENDANCE')::bigint <> (b ->> 'att_old')::bigint
     OR (run.counts ->> 'ABSENCE_REPORTS')::bigint <> (b ->> 'abs_old')::bigint
     OR (run.counts ->> 'LEAVE_REQUESTS')::bigint <> (b ->> 'leave_old')::bigint
     OR (run.counts ->> 'NOTIFICATIONS') IS NOT NULL
     OR (run.counts ->> 'DEPARTED_PEOPLE')::bigint <> 2 THEN
    RAISE EXCEPTION 'gallring: the run counted % against %', run.counts, b;
  END IF;
  IF run.complete <> '{"ATTENDANCE": true, "ABSENCE_REPORTS": true, "LEAVE_REQUESTS": true, "CHANGE_LOGS": true, "ABSENCE_REASONS": true, "DEPARTED_PEOPLE": true}'::jsonb THEN
    RAISE EXCEPTION 'gallring: the run says % is complete', run.complete;
  END IF;
  IF (run.waiting ->> 'DEPARTED_PEOPLE_SCB')::int IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'gallring: the run held % for SCB, expected the teacher with a tjänst this läsår', run.waiting ->> 'DEPARTED_PEOPLE_SCB';
  END IF;

  FOR purged IN SELECT * FROM app.retention_purged_before() LOOP
    IF purged.purged_before <> (CASE purged.data_type
         WHEN 'ATTENDANCE' THEN today - interval '12 months' WHEN 'ABSENCE_REPORTS' THEN today - interval '6 months'
         WHEN 'LEAVE_REQUESTS' THEN today - interval '12 months' WHEN 'CHANGE_LOGS' THEN today - interval '24 months'
         WHEN 'ABSENCE_REASONS' THEN today - interval '12 months' END)::date THEN
      RAISE EXCEPTION 'gallring: % is gallrat före %, not the cutoff', purged.data_type, purged.purged_before;
    END IF;
  END LOOP;
  SELECT count(*) INTO n FROM app.retention_purged_before();
  IF n <> 5 THEN RAISE EXCEPTION 'gallring: "gallrat före" answers % kinds, expected the five decided row kinds', n; END IF;
END $$;

-- School A has not moved.
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
DECLARE
  now_ jsonb;
BEGIN
  SELECT jsonb_build_object(
      'att', (SELECT count(*) FROM "AttendanceRecords"), 'abs', (SELECT count(*) FROM "AbsenceReports"),
      'leave', (SELECT count(*) FROM "LeaveRequests"), 'noti', (SELECT count(*) FROM "Notifications"),
      'log', (SELECT count(*) FROM "ScheduleChangeLogs"), 'emp', (SELECT count(*) FROM "TeacherEmploymentLogs"),
      'hist', (SELECT count(*) FROM "GuardianStudentHistory"),
      'reasons', (SELECT count(*) FROM "TeacherAbsences" WHERE "reasonId" IS NOT NULL),
      'users', (SELECT md5(string_agg(u::text, ',' ORDER BY id)) FROM "Users" u))
    INTO now_;
  IF now_ <> current_setting('app.test_rls83_a')::jsonb THEN
    RAISE EXCEPTION 'gallring: school A moved: % before, % after', current_setting('app.test_rls83_a'), now_;
  END IF;
  IF EXISTS (SELECT 1 FROM app.retention_purged_before()) THEN
    RAISE EXCEPTION 'gallring: school A reads "gallrat före" of another school';
  END IF;
END $$;

-- Nor has school B, whose rows are years old.
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000006')::text, true);
DO $$
DECLARE
  now_ jsonb;
BEGIN
  SELECT jsonb_build_object(
      'att', (SELECT count(*) FROM "AttendanceRecords"), 'abs', (SELECT count(*) FROM "AbsenceReports"),
      'leave', (SELECT count(*) FROM "LeaveRequests"), 'noti', (SELECT count(*) FROM "Notifications"),
      'log', (SELECT count(*) FROM "ScheduleChangeLogs"), 'emp', (SELECT count(*) FROM "TeacherEmploymentLogs"),
      'hist', (SELECT count(*) FROM "GuardianStudentHistory"),
      'reasons', (SELECT count(*) FROM "TeacherAbsences" WHERE "reasonId" IS NOT NULL),
      'users', (SELECT md5(string_agg(u::text, ',' ORDER BY id)) FROM "Users" u))
    INTO now_;
  IF now_ <> current_setting('app.test_rls83_b')::jsonb THEN
    RAISE EXCEPTION 'gallring: school B moved during another school''s night: % before, % after', current_setting('app.test_rls83_b'), now_;
  END IF;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 84: en slutad person pseudonymiseras på plats (Users,
-- 20261021100000 and 20261021110000).
--
-- The people step alone, with no principal. The pupil deactivated two years
-- ago and the teacher whose only tjänst was 2019/20 lose name, e-mail, phone
-- and login and keep their row; the teacher's signature and note go without
-- a new version of the tjänst; the pupil's guardian link goes and is
-- recorded as an unlink. The pupil deactivated a month ago, the teacher SCB
-- holds and every active person are untouched. Every person named to the
-- step is locked before it asks who is due (20261021130000), so a
-- reactivation in flight is waited for rather than failing the night; that
-- it waits needs two connections, the adapter probe's (gg). A pseudonym
-- cannot be made active again, and an active person cannot be given a
-- deactivation date by hand.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000081')::text, true);
DO $$
BEGIN
  PERFORM set_config('app.test_rls84_school', app.current_school_id()::text, true);
  PERFORM set_config('app.test_rls84_before', (
    SELECT md5(string_agg(u::text, ',' ORDER BY id)) FROM "Users" u
     WHERE "authId" NOT IN ('00000000-0000-4000-8000-000000000085', '00000000-0000-4000-8000-000000000087')), true);
  PERFORM set_config('app.test_rls84_versions', (SELECT count(*)::text FROM "TeacherEmploymentLogs"), true);
  PERFORM set_config('app.test_rls84_unlinks', (SELECT count(*)::text FROM "GuardianStudentHistory"), true);
  PERFORM set_config('app.test_rls84_others', (SELECT string_agg(id::text, ',') FROM "Users"
     WHERE "authId" IN ('00000000-0000-4000-8000-000000000083', '00000000-0000-4000-8000-000000000086', '00000000-0000-4000-8000-000000000088')), true);
  IF (SELECT "deactivatedAt" FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000085') > now() - interval '23 months' THEN
    RAISE EXCEPTION 'pseudonymisation: the fixture pupil was not deactivated two years ago';
  END IF;
END $$;

SELECT set_config('request.jwt.claims', '', true);
DO $$
DECLARE
  run uuid := app.gallring_begin(current_setting('app.test_rls84_school')::uuid, clock_timestamp());
  due record;
  n int;
BEGIN
  n := 0;
  FOR due IN SELECT * FROM app.gallring_departed_due(run, 500) LOOP
    n := n + 1;
    IF due.auth_id = '00000000-0000-4000-8000-000000000085' AND NOT due.invited THEN
      RAISE EXCEPTION 'pseudonymisation: the invited pupil''s login was not named for deletion';
    END IF;
    IF due.auth_id NOT IN ('00000000-0000-4000-8000-000000000085', '00000000-0000-4000-8000-000000000087') THEN
      RAISE EXCEPTION 'pseudonymisation: % is due and should not be', due.auth_id;
    END IF;
  END LOOP;
  IF n <> 2 THEN RAISE EXCEPTION 'pseudonymisation: % due, expected 2', n; END IF;
  -- Only those named: a person whose login could not be deleted is left out
  -- by the gateway, and must wait for the next night.
  n := app.gallring_pseudonymise(run, ARRAY(
         SELECT user_id FROM app.gallring_departed_due(run, 500) WHERE auth_id = '00000000-0000-4000-8000-000000000085'));
  IF n <> 1 THEN RAISE EXCEPTION 'pseudonymisation: naming one person pseudonymised %', n; END IF;
  IF (SELECT count(*) FROM app.gallring_departed_due(run, 500)) <> 1 THEN
    RAISE EXCEPTION 'pseudonymisation: a person left out of the list was pseudonymised anyway';
  END IF;
  -- Somebody not due, named anyway, is not touched.
  n := app.gallring_pseudonymise(run, ARRAY(
         SELECT user_id FROM app.gallring_departed_due(run, 500))
         || string_to_array(current_setting('app.test_rls84_others'), ',')::uuid[]);
  IF n <> 1 THEN RAISE EXCEPTION 'pseudonymisation: % pseudonymised, expected the teacher alone', n; END IF;
END $$;

SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000081')::text, true);
DO $$
DECLARE
  p record;
  n bigint;
BEGIN
  FOR p IN SELECT * FROM "Users" WHERE "pseudonymisedAt" IS NOT NULL LOOP
    IF p."firstName" <> 'Pseudonym' OR p."lastName" !~ '^[0-9A-F]{6}$'
       OR p.email <> 'pseudonym-' || p.id || '@pseudonym.invalid'
       OR p.phone IS NOT NULL OR p."ss12000Id" IS NOT NULL OR p."invitedAt" IS NOT NULL
       OR p."authId"::text LIKE '00000000-0000-4000-8000-%' OR p."isActive" THEN
      RAISE EXCEPTION 'pseudonymisation: % still identifies the person or can sign in', row_to_json(p);
    END IF;
  END LOOP;
  SELECT count(*) INTO n FROM "Users" WHERE "pseudonymisedAt" IS NOT NULL;
  IF n <> 2 THEN RAISE EXCEPTION 'pseudonymisation: % pseudonyms, expected 2', n; END IF;

  IF (SELECT md5(string_agg(u::text, ',' ORDER BY id)) FROM "Users" u WHERE "pseudonymisedAt" IS NULL)
     IS DISTINCT FROM current_setting('app.test_rls84_before') THEN
    RAISE EXCEPTION 'pseudonymisation: somebody not due changed (the recent leaver, the teacher SCB holds or an active person)';
  END IF;
  -- The three named but not due were locked all the same: a row's xmax is the
  -- transaction that last locked it, and nothing else in this one has.
  SELECT count(*) INTO n FROM "Users"
   WHERE id = ANY (string_to_array(current_setting('app.test_rls84_others'), ',')::uuid[])
     AND xmax = pg_current_xact_id()::xid;
  IF n <> 3 THEN
    RAISE EXCEPTION 'pseudonymisation: % of the three people named but not due were locked before the step asked; a reactivation in flight would fail the night', n;
  END IF;

  SELECT count(*) INTO n FROM "TeacherEmployments" e JOIN "Users" u ON u.id = e."userId"
   WHERE u."pseudonymisedAt" IS NOT NULL AND (e.signature IS NOT NULL OR e.note IS NOT NULL);
  IF n <> 0 THEN RAISE EXCEPTION 'pseudonymisation: a pseudonym''s tjänst kept its signature or note'; END IF;
  IF (SELECT count(*) FROM "TeacherEmployments" e JOIN "Users" u ON u.id = e."userId" WHERE u."pseudonymisedAt" IS NOT NULL) <> 1 THEN
    RAISE EXCEPTION 'pseudonymisation: the departed teacher''s tjänst went; it stays for the history';
  END IF;
  IF (SELECT count(*) FROM "TeacherEmploymentLogs")::text <> current_setting('app.test_rls84_versions') THEN
    RAISE EXCEPTION 'pseudonymisation: clearing the signature wrote a version of the tjänst';
  END IF;

  IF EXISTS (SELECT 1 FROM "GuardianStudents" gs JOIN "Users" u ON u.id IN (gs."guardianId", gs."studentId") WHERE u."pseudonymisedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'pseudonymisation: a pseudonym kept a guardian link';
  END IF;
  IF (SELECT count(*) FROM "GuardianStudentHistory")::int <> current_setting('app.test_rls84_unlinks')::int + 1 THEN
    RAISE EXCEPTION 'pseudonymisation: the removed guardian link was not recorded as an unlink';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "GuardianStudents" gs JOIN "Users" u ON u.id = gs."studentId" WHERE u."authId" = '00000000-0000-4000-8000-000000000083') THEN
    RAISE EXCEPTION 'pseudonymisation: the guardian''s link to an active pupil went';
  END IF;
  IF EXISTS (SELECT 1 FROM "Notifications" n JOIN "Users" u ON u.id = n."userId" WHERE u."pseudonymisedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'pseudonymisation: a pseudonym kept their own notices';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "AttendanceRecords" a JOIN "Users" u ON u.id = a."studentId" WHERE u."pseudonymisedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'pseudonymisation: the pupil''s attendance went with the name; it is a period of its own';
  END IF;

  BEGIN
    UPDATE "Users" SET "isActive" = true WHERE "pseudonymisedAt" IS NOT NULL;
    RAISE EXCEPTION 'pseudonymisation: a pseudonym was made active again';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE "Users" SET "deactivatedAt" = now() - interval '5 years'
   WHERE "authId" = '00000000-0000-4000-8000-000000000086';
  IF (SELECT "deactivatedAt" FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000086') < now() - interval '2 months' THEN
    RAISE EXCEPTION 'pseudonymisation: the admin back-dated a deactivation past the period';
  END IF;
  UPDATE "Users" SET "isActive" = false WHERE "authId" = '00000000-0000-4000-8000-000000000083';
  IF (SELECT "deactivatedAt" FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000083') IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'pseudonymisation: a deactivation was not dated now';
  END IF;
  UPDATE "Users" SET "isActive" = true WHERE "authId" = '00000000-0000-4000-8000-000000000083';
  IF (SELECT "deactivatedAt" FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000083') IS NOT NULL THEN
    RAISE EXCEPTION 'pseudonymisation: a reactivated person kept a deactivation date';
  END IF;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 85: inställningen app.gallring är ingen behörighet
-- (app.gallring_in_progress, 20261021110000).
--
-- Anyone can set a setting. The guards trust app.gallring only with no
-- principal set, and then neither API role may delete from the two
-- append-only tables (no grant) or see a row to update (row security). As
-- the gateway's role and PostgREST's, with the setting naming the school:
-- deleting the tjänst history or the guardian history is refused; and as the
-- school's admin with the setting, a change of a tjänst is still versioned.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000081')::text, true);
DO $$
DECLARE
  school uuid := app.current_school_id();
  before_ bigint;
BEGIN
  PERFORM set_config('app.test_rls85_school', school::text, true);
  PERFORM set_config('app.gallring', school::text, true);
  SELECT count(*) INTO before_ FROM "TeacherEmploymentLogs";
  UPDATE "TeacherEmployments" SET note = 'rls85' WHERE "schoolId" = school AND signature = 'GLÄ'
     AND "academicYearId" = (SELECT id FROM "AcademicYears" WHERE "isActive");
  IF (SELECT count(*) FROM "TeacherEmploymentLogs") <> before_ + 1 THEN
    RAISE EXCEPTION 'forged gallring: an admin''s change of a tjänst went unversioned under the setting';
  END IF;
END $$;

SELECT set_config('request.jwt.claims', '', true);
DO $$
DECLARE
  school uuid := current_setting('app.test_rls85_school')::uuid;
  via text;
  n bigint;
BEGIN
  PERFORM set_config('app.gallring', school::text, true);
  FOREACH via IN ARRAY ARRAY['app_authenticated', 'authenticated'] LOOP
    EXECUTE format('SET LOCAL ROLE %I', via);
    BEGIN
      DELETE FROM "TeacherEmploymentLogs" WHERE "schoolId" = school;
      RAISE EXCEPTION 'forged gallring: % deleted the tjänst history under the setting', via;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      DELETE FROM "GuardianStudentHistory" WHERE "schoolId" = school;
      RAISE EXCEPTION 'forged gallring: % deleted the guardian history under the setting', via;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      UPDATE "Users" SET "ss12000Id" = NULL WHERE "schoolId" = school;
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n <> 0 THEN RAISE EXCEPTION 'forged gallring: % changed % person row(s) with no principal', via, n; END IF;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
  END LOOP;
  SET LOCAL ROLE app_authenticated;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 86: förhandsvisningen är administratörens och räknar som natten
-- (app.gallring_preview, 20261021110000).
--
-- The page shows what a period would take before it is chosen. Only the
-- school's SCHOOL_ADMIN may ask (GL403 for a teacher and for no principal),
-- the count is of the asker's own school, and it is the number the night
-- then removes: 86 previews, runs the night with no principal, and previews
-- again. A period outside 1..120 is refused (GL400).
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000082')::text, true);
DO $$
BEGIN
  BEGIN
    PERFORM * FROM app.gallring_preview('ATTENDANCE', 12);
    RAISE EXCEPTION 'preview: a teacher saw what would be gallrat';
  EXCEPTION WHEN SQLSTATE 'GL403' THEN NULL;
  END;
END $$;
SELECT set_config('request.jwt.claims', '', true);
DO $$
BEGIN
  BEGIN
    PERFORM * FROM app.gallring_preview('ATTENDANCE', 12);
    RAISE EXCEPTION 'preview: no principal saw what would be gallrat';
  EXCEPTION WHEN SQLSTATE 'GL403' THEN NULL;
  END;
END $$;

SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000081')::text, true);
DO $$
DECLARE
  today date := (now() AT TIME ZONE 'Europe/Stockholm')::date;
  pv record;
  kinds jsonb := '{}';
BEGIN
  PERFORM set_config('app.test_rls86_school', app.current_school_id()::text, true);
  FOR pv IN SELECT k.kind, k.months, p.* FROM (VALUES
      ('ATTENDANCE'::"RetentionDataType", 12), ('ABSENCE_REPORTS', 6), ('LEAVE_REQUESTS', 12),
      ('NOTIFICATIONS', 12), ('CHANGE_LOGS', 24), ('ABSENCE_REASONS', 12), ('DEPARTED_PEOPLE', 12)) AS k(kind, months)
    CROSS JOIN LATERAL app.gallring_preview(k.kind, k.months) p LOOP
    IF pv.cutoff <> (today - make_interval(months => pv.months))::date THEN
      RAISE EXCEPTION 'preview: % months gives cutoff %', pv.months, pv.cutoff;
    END IF;
    kinds := kinds || jsonb_build_object(pv.kind::text, pv.due);
    IF pv.kind = 'DEPARTED_PEOPLE' AND pv.held <> 1 THEN RAISE EXCEPTION 'preview: % held for SCB, expected 1', pv.held; END IF;
  END LOOP;
  IF kinds <> '{"ATTENDANCE": 2, "ABSENCE_REPORTS": 1, "LEAVE_REQUESTS": 1, "NOTIFICATIONS": 1, "CHANGE_LOGS": 4, "ABSENCE_REASONS": 1, "DEPARTED_PEOPLE": 2}'::jsonb THEN
    RAISE EXCEPTION 'preview: the counts are %', kinds;
  END IF;
  PERFORM set_config('app.test_rls86_preview', kinds::text, true);
  BEGIN
    PERFORM * FROM app.gallring_preview('ATTENDANCE', 0);
    RAISE EXCEPTION 'preview: a period of 0 months was previewed';
  EXCEPTION WHEN SQLSTATE 'GL400' THEN NULL;
  END;
END $$;

SELECT set_config('request.jwt.claims', '', true);
DO $$
DECLARE
  run uuid := app.gallring_begin(current_setting('app.test_rls86_school')::uuid, clock_timestamp());
  kind "RetentionDataType";
  went jsonb := '{}';
BEGIN
  FOREACH kind IN ARRAY ARRAY['ATTENDANCE', 'ABSENCE_REPORTS', 'LEAVE_REQUESTS', 'CHANGE_LOGS', 'ABSENCE_REASONS']::"RetentionDataType"[] LOOP
    went := went || jsonb_build_object(kind::text, app.gallring_purge(run, kind, 5000));
  END LOOP;
  went := went || jsonb_build_object('DEPARTED_PEOPLE', app.gallring_pseudonymise(run, ARRAY(SELECT user_id FROM app.gallring_departed_due(run, 500))));
  IF went <> (current_setting('app.test_rls86_preview')::jsonb - 'NOTIFICATIONS') THEN
    RAISE EXCEPTION 'preview: the night took % after the page promised %', went, current_setting('app.test_rls86_preview');
  END IF;
END $$;

SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000081')::text, true);
DO $$
DECLARE n bigint;
BEGIN
  SELECT due INTO n FROM app.gallring_preview('ATTENDANCE', 12);
  IF n <> 0 THEN RAISE EXCEPTION 'preview: % attendance rows still due after the night', n; END IF;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 87: "gallrat före" gäller bara det som verkligen är borta
-- (app.retention_purged_before, 20261021110000).
--
-- A run that stopped at its batch cap leaves rows older than its cutoff, and
-- a report must not say they are gone. One run takes one of the two
-- attendance rows due and finishes: attendance has no "gallrat före" yet.
-- The next run takes the other: now it has.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000081')::text, true);
SELECT set_config('app.test_rls87_school', app.current_school_id()::text, true);
SELECT set_config('request.jwt.claims', '', true);
DO $$
DECLARE
  run uuid := app.gallring_begin(current_setting('app.test_rls87_school')::uuid, clock_timestamp());
BEGIN
  IF app.gallring_purge(run, 'ATTENDANCE', 1) <> 1 THEN RAISE EXCEPTION 'purged before: the capped batch took no row'; END IF;
  PERFORM app.gallring_finish(run, '{}', clock_timestamp());
END $$;
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000081')::text, true);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM app.retention_purged_before() WHERE data_type = 'ATTENDANCE') THEN
    RAISE EXCEPTION 'purged before: attendance reads as gallrat after a run stopped at its cap';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "GallringRuns" WHERE (complete ->> 'ATTENDANCE')::boolean = false) THEN
    RAISE EXCEPTION 'purged before: the capped run did not record attendance as incomplete';
  END IF;
END $$;
SELECT set_config('request.jwt.claims', '', true);
DO $$
DECLARE
  run uuid := app.gallring_begin(current_setting('app.test_rls87_school')::uuid, clock_timestamp());
BEGIN
  IF app.gallring_purge(run, 'ATTENDANCE', 5000) <> 1 THEN RAISE EXCEPTION 'purged before: the second run did not take the row left'; END IF;
  PERFORM app.gallring_finish(run, '{}', clock_timestamp());
END $$;
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000081')::text, true);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.retention_purged_before() WHERE data_type = 'ATTENDANCE'
                  AND purged_before = ((now() AT TIME ZONE 'Europe/Stockholm')::date - interval '12 months')::date) THEN
    RAISE EXCEPTION 'purged before: attendance is not gallrat after the run that finished it';
  END IF;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 88: en slutad persons inloggning tas bort bara medan personen
-- fortfarande ska pseudonymiseras (app.gallring_claim_person, 20261021120000).
--
-- With no principal, as the job asks it right before deleting a login. The
-- claim answers the invited pupil who left two years ago with their login,
-- and the teacher whose only tjänst was 2019/20 with no login to delete. It
-- answers nothing for the pupil who left a month ago, the teacher SCB holds,
-- an active pupil, school B's departed pupil or an id nobody has; nothing for
-- a pseudonym or for the pupil once an admin has made them active again; and
-- it writes no row. In a second transaction: nothing once a KEEP is recorded
-- after the run began (the period in force is asked at clock_timestamp(),
-- not at the run's start), and GL404 for a run that has finished. That it
-- waits for a reactivation in flight needs two connections: the adapter
-- probe's (gf).
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000006')::text, true);
DO $$
BEGIN
  PERFORM set_config('app.test_rls88_b_gone', COALESCE((
    SELECT id::text FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000089' AND NOT "isActive"), ''), true);
  IF current_setting('app.test_rls88_b_gone') = '' THEN
    RAISE EXCEPTION 'claim: school B''s departed pupil is not in the fixtures';
  END IF;
END $$;

SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000081')::text, true);
DO $$
BEGIN
  PERFORM set_config('app.test_rls88_school', app.current_school_id()::text, true);
  PERFORM set_config('app.test_rls88_people', (
    SELECT jsonb_object_agg(right("authId"::text, 2), id)::text FROM "Users"
     WHERE "authId"::text LIKE '00000000-0000-4000-8000-00000000008_'), true);
  PERFORM set_config('app.test_rls88_users', (SELECT md5(string_agg(u::text, ',' ORDER BY id)) FROM "Users" u), true);
END $$;

SELECT set_config('request.jwt.claims', '', true);
DO $$
DECLARE
  people jsonb := current_setting('app.test_rls88_people')::jsonb;
  run uuid := app.gallring_begin(current_setting('app.test_rls88_school')::uuid, clock_timestamp());
  c record;
  nobody text;
BEGIN
  PERFORM set_config('app.test_rls88_run', run::text, true);
  SELECT * INTO c FROM app.gallring_claim_person(run, (people ->> '85')::uuid);
  IF c.auth_id IS DISTINCT FROM '00000000-0000-4000-8000-000000000085' OR c.invited IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'claim: the invited pupil who left two years ago was not claimed with their login (% %)', c.auth_id, c.invited;
  END IF;
  SELECT * INTO c FROM app.gallring_claim_person(run, (people ->> '87')::uuid);
  IF c.auth_id IS DISTINCT FROM '00000000-0000-4000-8000-000000000087' OR c.invited IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'claim: the teacher whose tjänst was 2019/20 was not claimed, or claimed with a login (% %)', c.auth_id, c.invited;
  END IF;
  SELECT string_agg(who, ', ') INTO nobody
    FROM (VALUES ('the pupil who left a month ago', (people ->> '86')::uuid),
                 ('the teacher SCB holds', (people ->> '88')::uuid),
                 ('an active pupil', (people ->> '83')::uuid),
                 ('school B''s departed pupil', current_setting('app.test_rls88_b_gone')::uuid),
                 ('an id nobody has', gen_random_uuid())) AS t(who, id)
   WHERE EXISTS (SELECT 1 FROM app.gallring_claim_person(run, t.id));
  IF nobody IS NOT NULL THEN RAISE EXCEPTION 'claim: answered for %', nobody; END IF;
END $$;

SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000081')::text, true);
DO $$
BEGIN
  IF (SELECT md5(string_agg(u::text, ',' ORDER BY id)) FROM "Users" u) IS DISTINCT FROM current_setting('app.test_rls88_users') THEN
    RAISE EXCEPTION 'claim: a claim changed a person';
  END IF;
  UPDATE "Users" SET "isActive" = true WHERE "authId" = '00000000-0000-4000-8000-000000000085';
  IF NOT FOUND THEN RAISE EXCEPTION 'claim: the admin could not make the pupil active again'; END IF;
END $$;

SELECT set_config('request.jwt.claims', '', true);
DO $$
DECLARE
  people jsonb := current_setting('app.test_rls88_people')::jsonb;
  run uuid := current_setting('app.test_rls88_run')::uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM app.gallring_claim_person(run, (people ->> '85')::uuid)) THEN
    RAISE EXCEPTION 'claim: answered for a pupil made active again since the run began';
  END IF;
  IF app.gallring_pseudonymise(run, ARRAY[(people ->> '87')::uuid]) <> 1 THEN
    RAISE EXCEPTION 'claim: the claimed teacher was not pseudonymised';
  END IF;
  IF EXISTS (SELECT 1 FROM app.gallring_claim_person(run, (people ->> '87')::uuid)) THEN
    RAISE EXCEPTION 'claim: answered for a pseudonym';
  END IF;
END $$;
ROLLBACK;

BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000081')::text, true);
DO $$
BEGIN
  PERFORM set_config('app.test_rls88_school', app.current_school_id()::text, true);
  PERFORM set_config('app.test_rls88_pupil', (SELECT id::text FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000085'), true);
END $$;
SELECT set_config('request.jwt.claims', '', true);
DO $$
DECLARE
  run uuid := app.gallring_begin(current_setting('app.test_rls88_school')::uuid, clock_timestamp());
BEGIN
  PERFORM set_config('app.test_rls88_run', run::text, true);
  IF NOT EXISTS (SELECT 1 FROM app.gallring_claim_person(run, current_setting('app.test_rls88_pupil')::uuid)) THEN
    RAISE EXCEPTION 'claim: the departed pupil was not claimed before the KEEP';
  END IF;
END $$;
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000081')::text, true);
INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision)
VALUES (current_setting('app.test_rls88_school')::uuid, 'DEPARTED_PEOPLE', 'KEEP');
SELECT set_config('request.jwt.claims', '', true);
DO $$
DECLARE
  run uuid := current_setting('app.test_rls88_run')::uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM app.gallring_claim_person(run, current_setting('app.test_rls88_pupil')::uuid)) THEN
    RAISE EXCEPTION 'claim: answered under a KEEP recorded after the run began';
  END IF;
  PERFORM app.gallring_finish(run, '{}', clock_timestamp());
  BEGIN
    PERFORM app.gallring_claim_person(run, current_setting('app.test_rls88_pupil')::uuid);
    RAISE EXCEPTION 'claim: a finished run claimed a person';
  EXCEPTION WHEN SQLSTATE 'GL404' THEN NULL;
  END;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 90: ett uppdrags gamla engångskolumn betyder ingenting
-- (20261022090000).
--
-- 20261017090000 moved an uppdrag's times to TeacherDutySlots and kept the
-- one-time column blockedConstraintId, its keys and its triggers for the API
-- release before it. 20261022090000 retires them. The catalogue half: no
-- trigger and no function of the column is left, no foreign key, unique
-- constraint or index names it, the constraint guard finds the duty through
-- the link alone, and a validated CHECK holds the column empty until a later
-- migration drops it. The behaviour half, as the admin: a value written to
-- the column is refused (23514) by INSERT and by UPDATE, rather than made a
-- link or silently kept; null is accepted, which is all the previous
-- release's rollover writes; and no link appears for the time named.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  rel regclass := '"TeacherDuties"'::regclass;
  col smallint;
  n integer;
  def text;
BEGIN
  SELECT attnum INTO col FROM pg_attribute WHERE attrelid = rel AND attname = 'blockedConstraintId' AND NOT attisdropped;
  IF col IS NULL THEN
    RAISE EXCEPTION 'retired column: TeacherDuties has no blockedConstraintId — this section is for the release that still has it';
  END IF;
  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgrelid = rel AND NOT tgisinternal
     AND tgname IN ('TeacherDuties_block_is_the_teachers', 'TeacherDuties_take_their_block',
                    'TeacherDuties_old_block_is_a_slot');
  IF n <> 0 THEN
    RAISE EXCEPTION 'retired column: % of the old column''s triggers are still on TeacherDuties', n;
  END IF;
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
   WHERE s.nspname = 'app'
     AND p.proname IN ('teacher_duties_block_is_the_teachers', 'teacher_duties_take_their_block',
                       'teacher_duties_old_block_is_a_slot');
  IF n <> 0 THEN
    RAISE EXCEPTION 'retired column: % of the old column''s trigger functions are still in app', n;
  END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = rel AND contype IN ('f', 'u', 'p') AND col = ANY (conkey);
  IF n <> 0 THEN
    RAISE EXCEPTION 'retired column: % key(s) on TeacherDuties still name blockedConstraintId', n;
  END IF;
  SELECT count(*) INTO n FROM pg_index WHERE indrelid = rel AND col = ANY (indkey::smallint[]);
  IF n <> 0 THEN
    RAISE EXCEPTION 'retired column: % index(es) on TeacherDuties still cover blockedConstraintId', n;
  END IF;
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
   WHERE s.nspname = 'app' AND p.prosrc LIKE '%blockedConstraintId%'
     AND p.proname <> 'teacher_staffing_log';
  IF n <> 0 THEN
    RAISE EXCEPTION 'retired column: % function(s) in app besides the log''s strip list still read blockedConstraintId', n;
  END IF;
  SELECT pg_get_constraintdef(c.oid) INTO def FROM pg_constraint c
   WHERE c.conrelid = rel AND c.conname = 'TeacherDuties_blockedConstraintId_is_retired'
     AND c.contype = 'c' AND c.convalidated;
  IF def IS DISTINCT FROM 'CHECK (("blockedConstraintId" IS NULL))' THEN
    RAISE EXCEPTION 'retired column: the CHECK holding blockedConstraintId empty is %', coalesce(def, 'missing or not validated');
  END IF;
END $$;

BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
DECLARE
  school uuid := app.current_school_id();
  me uuid; year uuid; c uuid; d uuid; n bigint;
BEGIN
  IF app.current_user_role() <> 'SCHOOL_ADMIN' THEN
    RAISE EXCEPTION 'retired column: expected to be acting as an admin, am %', app.current_user_role();
  END IF;
  SELECT id INTO me FROM "Users" WHERE "schoolId" = school AND role = 'TEACHER' ORDER BY "authId" LIMIT 1;
  SELECT id INTO year FROM "AcademicYears" WHERE "schoolId" = school AND "isActive" LIMIT 1;
  INSERT INTO "AvailabilityConstraints" ("schoolId", "resourceType", "userId", "dayOfWeek", "startTime", "endTime", type, reason, "updatedAt")
  VALUES (school, 'TEACHER', me, 3, '15:00', '16:00', 'UNAVAILABLE', 'RLS90 APT', now()) RETURNING id INTO c;
  INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "updatedAt")
  VALUES (school, me, year, 'APT_KONFERENS', 'RLS90 APT', 60, now()) RETURNING id INTO d;

  BEGIN
    INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "blockedConstraintId", "updatedAt")
    VALUES (school, me, year, 'APT_KONFERENS', 'RLS90 gammal APT', 60, c, now());
    RAISE EXCEPTION 'retired column: an INSERT stored a value in blockedConstraintId';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE "TeacherDuties" SET "blockedConstraintId" = c WHERE id = d;
    RAISE EXCEPTION 'retired column: an UPDATE stored a value in blockedConstraintId';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  SELECT count(*) INTO n FROM "TeacherDutySlots" WHERE "availabilityConstraintId" = c;
  IF n <> 0 THEN
    RAISE EXCEPTION 'retired column: a write of the old column left % link(s)', n;
  END IF;

  -- Null, as the previous release's rollover writes it.
  INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "blockedConstraintId", "updatedAt")
  VALUES (school, me, year, 'RASTVAKT', 'RLS90 rullad', 20, NULL, now());
  UPDATE "TeacherDuties" SET "blockedConstraintId" = NULL, "minutesPerWeek" = 61 WHERE id = d;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'retired column: an UPDATE writing null to it changed % row(s)', n;
  END IF;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 120: läsloggen skrivs bara av databasen och läses bara av skolans
-- administratör genom API:t (PersonalDataAccess, 20261026091000).
--
-- The catalogue: no API role holds INSERT, UPDATE, DELETE, TRUNCATE,
-- REFERENCES or TRIGGER on the log; PostgREST's authenticated and anon hold
-- nothing at all on it; app_authenticated holds SELECT, through its own grant
-- and not authenticated's. The one writer, app.personal_data_read, is
-- app_authenticated's alone to execute (not PUBLIC's, not authenticated's).
-- The table's one policy is SELECT TO app_authenticated.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  r text;
  p text;
  n bigint;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = '"PersonalDataAccess"'::regclass) THEN
    RAISE EXCEPTION 'read log: row security is off';
  END IF;
  FOREACH r IN ARRAY ARRAY['app_authenticated', 'authenticated', 'anon', 'service_role'] LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
    FOREACH p IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(r, '"PersonalDataAccess"', p) THEN
        RAISE EXCEPTION 'read log: % holds % on the log', r, p;
      END IF;
    END LOOP;
  END LOOP;
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
    IF has_table_privilege(r, '"PersonalDataAccess"', 'SELECT') THEN
      RAISE EXCEPTION 'read log: % may read the log', r;
    END IF;
    IF has_function_privilege(r, 'app.personal_data_read("PersonalDataAccessKind", "PersonalDataAccessChannel", uuid[])', 'EXECUTE') THEN
      RAISE EXCEPTION 'read log: % may write the log', r;
    END IF;
  END LOOP;
  IF NOT has_table_privilege('app_authenticated', '"PersonalDataAccess"', 'SELECT') THEN
    RAISE EXCEPTION 'read log: the API may not read the log';
  END IF;
  IF NOT has_function_privilege('app_authenticated', 'app.personal_data_read("PersonalDataAccessKind", "PersonalDataAccessChannel", uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'read log: the API may not write the log';
  END IF;
  SELECT count(*) INTO n
    FROM pg_proc pr, aclexplode(coalesce(pr.proacl, acldefault('f', pr.proowner))) a
   WHERE pr.oid = 'app.personal_data_read("PersonalDataAccessKind", "PersonalDataAccessChannel", uuid[])'::regprocedure
     AND a.grantee = 0;
  IF n <> 0 THEN RAISE EXCEPTION 'read log: PUBLIC may write the log'; END IF;
  SELECT count(*) INTO n FROM pg_policies WHERE tablename = 'PersonalDataAccess';
  IF n <> 1 OR NOT EXISTS (
       SELECT 1 FROM pg_policies
        WHERE tablename = 'PersonalDataAccess' AND cmd = 'SELECT' AND roles = '{app_authenticated}') THEN
    RAISE EXCEPTION 'read log: the policies are not the one SELECT arm TO app_authenticated';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Section 121: en läsning skrivs med läsaren ur transaktionen, utan läsaren
-- själv och utan den som samma läsare läst samma slag av den senaste
-- kvarten (app.personal_data_read, 20261026091000).
--
-- The läslogg school's teacher (122) records reads through the function as
-- the gateway does, and the school's admin (121) then reads exactly what was
-- written: who (the claims' user and role, never an argument), which
-- channel (WEB or APP as given, anything else OTHER), which kind, and only
-- people of the school other than the reader. The quarter-hour is measured
-- against the fixtures' rows of teacher 126, ten and twenty minutes old.
-- ---------------------------------------------------------------------------

BEGIN;
-- Another school's pupil, read by the runner as the owner: the teacher's
-- own row security could not name them.
SELECT set_config('app.test_rls121_stranger', :'student_b', true);
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000122')::text, true);
DO $$
DECLARE
  me uuid := app.current_user_id();
  p123 uuid := (SELECT id FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000123');
  p124 uuid := (SELECT id FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000124');
  n integer;
BEGIN
  IF me IS NULL OR p123 IS NULL OR p124 IS NULL THEN RAISE EXCEPTION 'read log: the läslogg school is not planted'; END IF;
  n := app.personal_data_read('ROSTER', 'APP', ARRAY[p123, p124, me, p123]);
  IF n <> 2 THEN RAISE EXCEPTION 'read log: a roster of two pupils and the reader recorded % people', n; END IF;
  n := app.personal_data_read('ROSTER', 'APP', ARRAY[p124, p123]);
  IF n <> 0 THEN RAISE EXCEPTION 'read log: the same roster again within the quarter-hour recorded % people', n; END IF;
  n := app.personal_data_read('ATTENDANCE', 'WEB', ARRAY[p123]);
  IF n <> 1 THEN RAISE EXCEPTION 'read log: another kind about the same pupil was left out as a repeat'; END IF;
  n := app.personal_data_read('ROSTER', 'APP', ARRAY[me]);
  IF n <> 0 THEN RAISE EXCEPTION 'read log: the reader was recorded reading about themself'; END IF;
  n := app.personal_data_read('ROSTER', 'APP', ARRAY[current_setting('app.test_rls121_stranger')::uuid]);
  IF n <> 0 THEN RAISE EXCEPTION 'read log: a pupil of another school was recorded'; END IF;
  n := app.personal_data_read('ROSTER', 'APP', ARRAY[gen_random_uuid()]);
  IF n <> 0 THEN RAISE EXCEPTION 'read log: an id of nobody was recorded'; END IF;
  n := app.personal_data_read('PEOPLE', 'INTEGRATION', ARRAY[p123]);
  IF n <> 1 THEN RAISE EXCEPTION 'read log: a person''s read naming INTEGRATION was not recorded'; END IF;
  n := app.personal_data_read('GUARDIANS', NULL, ARRAY[p124]);
  IF n <> 1 THEN RAISE EXCEPTION 'read log: a read without a channel was not recorded'; END IF;
  BEGIN
    PERFORM app.personal_data_read(NULL, 'WEB', ARRAY[p123]);
    RAISE EXCEPTION 'read log: a read of no kind was recorded';
  EXCEPTION WHEN SQLSTATE 'PD400' THEN NULL;
  END;
  -- A teacher records reads and reads none of them back.
  SELECT count(*) INTO n FROM "PersonalDataAccess";
  IF n <> 0 THEN RAISE EXCEPTION 'read log: a teacher reads % row(s) of the log', n; END IF;
END $$;

-- The quarter-hour, against the fixtures' rows of teacher 126. A roster of
-- both pupils then records only the one not read ten minutes ago, and keeps
-- the read's size, two (checked as the admin below).
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000126')::text, true);
DO $$
DECLARE
  p123 uuid := (SELECT id FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000123');
  p124 uuid := (SELECT id FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000124');
  n integer;
BEGIN
  n := app.personal_data_read('ROSTER', 'WEB', ARRAY[p124]);
  IF n <> 0 THEN RAISE EXCEPTION 'read log: a roster read ten minutes ago was recorded again'; END IF;
  n := app.personal_data_read('ATTENDANCE', 'WEB', ARRAY[p124]);
  IF n <> 1 THEN RAISE EXCEPTION 'read log: an attendance read twenty minutes ago kept the next one out'; END IF;
  n := app.personal_data_read('ROSTER', 'WEB', ARRAY[p124, p123]);
  IF n <> 1 THEN RAISE EXCEPTION 'read log: a roster of one new and one recent pupil recorded % people, not the new one', n; END IF;
END $$;

SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000121')::text, true);
DO $$
DECLARE
  t122 uuid := (SELECT id FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000122');
  p123 uuid := (SELECT id FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000123');
  p124 uuid := (SELECT id FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000124');
  got text;
BEGIN
  SELECT string_agg(format('%s/%s/%s/%s/%s', kind, channel, "actorRole",
                           (SELECT string_agg(CASE s WHEN p123 THEN '123' WHEN p124 THEN '124' ELSE 'X' END, '+' ORDER BY s = p124, s)
                              FROM unnest("subjectIds") s), "readSize"),
                    ' ' ORDER BY "at", kind)
    INTO got
    FROM "PersonalDataAccess"
   WHERE "actorId" = t122 AND "at" > now() - interval '1 minute' AND "apiKeyId" IS NULL;
  IF got IS DISTINCT FROM 'ROSTER/APP/TEACHER/123+124/2 ATTENDANCE/WEB/TEACHER/123/1 PEOPLE/OTHER/TEACHER/123/1 GUARDIANS/OTHER/TEACHER/124/1' THEN
    RAISE EXCEPTION 'read log: the teacher''s reads were recorded as %', got;
  END IF;
  -- Teacher 126's roster of both pupils: the row keeps the new pupil and the
  -- read's size, so "others in the same read" counts the read, not the row.
  SELECT string_agg(format('%s/%s', (SELECT string_agg(CASE s WHEN p123 THEN '123' WHEN p124 THEN '124' ELSE 'X' END, '+') FROM unnest("subjectIds") s), "readSize"), ' ')
    INTO got
    FROM "PersonalDataAccess"
   WHERE "actorId" = (SELECT id FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000126')
     AND kind = 'ROSTER' AND "at" > now() - interval '1 minute';
  IF got IS DISTINCT FROM '123/2' THEN
    RAISE EXCEPTION 'read log: the deduped roster was recorded as % (pupils/size), not 123/2', got;
  END IF;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 122: bara skolans administratör läser läsloggen, och bara genom
-- API:ts roll.
--
-- The läslogg school's admin reads the school's rows and none of another
-- school's; school A's admin reads none of the läslogg school's; a guardian
-- reads none. As PostgREST's authenticated, the läslogg admin neither reads
-- the log nor writes it (no grant on either; anon's grants are section
-- 120's, since the suite's role cannot become anon).
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000121')::text, true);
DO $$
DECLARE
  school uuid := app.current_school_id();
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM "PersonalDataAccess" WHERE "schoolId" = school;
  IF n < 4 THEN RAISE EXCEPTION 'read log: the admin reads % of the school''s planted rows', n; END IF;
  SELECT count(*) INTO n FROM "PersonalDataAccess" WHERE "schoolId" <> school;
  IF n <> 0 THEN RAISE EXCEPTION 'read log: the admin reads % row(s) of another school', n; END IF;
  PERFORM set_config('app.test_rls122_school', school::text, true);
END $$;

SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_auth_id')::text, true);
DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM "PersonalDataAccess" WHERE "schoolId" = current_setting('app.test_rls122_school')::uuid;
  IF n <> 0 THEN RAISE EXCEPTION 'read log: school A''s admin reads the läslogg school''s log'; END IF;
END $$;

SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000125')::text, true);
DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM "PersonalDataAccess";
  IF n <> 0 THEN RAISE EXCEPTION 'read log: a guardian reads % row(s) of the log', n; END IF;
END $$;

SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000121')::text, true);
DO $$
DECLARE
  via text;
BEGIN
  FOREACH via IN ARRAY ARRAY['authenticated'] LOOP
    EXECUTE format('SET LOCAL ROLE %I', via);
    IF current_user <> via THEN RAISE EXCEPTION 'read log: could not act as %', via; END IF;
    BEGIN
      PERFORM count(*) FROM "PersonalDataAccess";
      RAISE EXCEPTION 'read log: % read the log', via;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM app.personal_data_read('PEOPLE', 'WEB', ARRAY[gen_random_uuid()]);
      RAISE EXCEPTION 'read log: % called the writer', via;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
  END LOOP;
  SET LOCAL ROLE app_authenticated;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 123: en integrations läsning skrivs som nyckeln, och synken eller
-- ingen alls läser inte.
--
-- As the service principal of the läslogg school with its key, a read is
-- recorded with the key, channel INTEGRATION and no person whatever the
-- caller names, and the quarter-hour holds per key. A key of another school,
-- the sync principal and no principal at all are refused with PD403, so a
-- read that cannot be recorded fails.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000121')::text, true);
DO $$
BEGIN
  PERFORM set_config('app.test_rls123_school', app.current_school_id()::text, true);
  PERFORM set_config('app.test_rls123_key', (SELECT id::text FROM "IntegrationApiKeys" WHERE name = 'Läslogg-nyckel'), true);
  PERFORM set_config('app.test_rls123_pupil', (SELECT id::text FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000124'), true);
END $$;
SELECT set_config('request.jwt.claims', '', true);
DO $$
DECLARE
  school uuid := current_setting('app.test_rls123_school')::uuid;
  pupil uuid := current_setting('app.test_rls123_pupil')::uuid;
  n integer;
BEGIN
  PERFORM set_config('app.service_school_id', school::text, true);
  PERFORM set_config('app.service_key_id', current_setting('app.test_rls123_key'), true);
  n := app.personal_data_read('PEOPLE', 'APP', ARRAY[pupil]);
  IF n <> 1 THEN RAISE EXCEPTION 'read log: the key''s read was not recorded'; END IF;
  n := app.personal_data_read('PEOPLE', 'APP', ARRAY[pupil]);
  IF n <> 0 THEN RAISE EXCEPTION 'read log: the key''s repeat within the quarter-hour was recorded'; END IF;
  PERFORM set_config('app.service_key_id', gen_random_uuid()::text, true);
  BEGIN
    PERFORM app.personal_data_read('PEOPLE', 'APP', ARRAY[pupil]);
    RAISE EXCEPTION 'read log: a key of no school of the read was recorded';
  EXCEPTION WHEN SQLSTATE 'PD403' THEN NULL;
  END;
  PERFORM set_config('app.service_key_id', '', true);
  PERFORM set_config('app.service_school_id', '', true);
  BEGIN
    PERFORM app.personal_data_read('PEOPLE', 'WEB', ARRAY[pupil]);
    RAISE EXCEPTION 'read log: a read with no reader was recorded';
  EXCEPTION WHEN SQLSTATE 'PD403' THEN NULL;
  END;
  -- The sync reads its own source for nobody, even beside a key.
  PERFORM set_config('app.sync_school_id', school::text, true);
  BEGIN
    PERFORM app.personal_data_read('PEOPLE', 'WEB', ARRAY[pupil]);
    RAISE EXCEPTION 'read log: the sync was recorded as a reader';
  EXCEPTION WHEN SQLSTATE 'PD403' THEN NULL;
  END;
  PERFORM set_config('app.service_school_id', school::text, true);
  PERFORM set_config('app.service_key_id', current_setting('app.test_rls123_key'), true);
  BEGIN
    PERFORM app.personal_data_read('ROSTER', 'WEB', ARRAY[pupil]);
    RAISE EXCEPTION 'read log: the sync beside a key was recorded as the key';
  EXCEPTION WHEN SQLSTATE 'PD403' THEN NULL;
  END;
  PERFORM set_config('app.service_key_id', '', true);
  PERFORM set_config('app.service_school_id', '', true);
  PERFORM set_config('app.sync_school_id', '', true);
END $$;
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000121')::text, true);
DO $$
DECLARE
  row_ record;
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM "PersonalDataAccess" WHERE channel = 'INTEGRATION' AND "at" > now() - interval '1 minute';
  IF n <> 1 THEN RAISE EXCEPTION 'read log: % integration row(s) were written', n; END IF;
  SELECT * INTO row_ FROM "PersonalDataAccess" WHERE channel = 'INTEGRATION' AND "at" > now() - interval '1 minute';
  IF row_."apiKeyId" IS DISTINCT FROM current_setting('app.test_rls123_key')::uuid
     OR row_."actorId" IS NOT NULL OR row_."actorRole" IS NOT NULL OR row_.kind <> 'PEOPLE'
     OR row_."subjectIds" <> ARRAY[current_setting('app.test_rls123_pupil')::uuid] THEN
    RAISE EXCEPTION 'read log: the key''s read was recorded as %', row_;
  END IF;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 124: ingen API-roll ändrar eller tar bort en rad i läsloggen.
--
-- No grant: INSERT, UPDATE, DELETE and TRUNCATE are refused as the API's
-- role and as PostgREST's, the school's own admin included. (The owner is
-- refused by the append-only trigger outside a cascade or gallring; the
-- adapter probe checks that as the owner, (lä3).)
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000121')::text, true);
DO $$
DECLARE
  via text;
  school uuid := app.current_school_id();
BEGIN
  FOREACH via IN ARRAY ARRAY['app_authenticated', 'authenticated'] LOOP
    EXECUTE format('SET LOCAL ROLE %I', via);
    BEGIN
      INSERT INTO "PersonalDataAccess" ("schoolId", channel, kind, "subjectIds", "actorRole")
      VALUES (school, 'WEB', 'PEOPLE', ARRAY[gen_random_uuid()], 'SCHOOL_ADMIN');
      RAISE EXCEPTION 'read log: % wrote a row of its own', via;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      UPDATE "PersonalDataAccess" SET "at" = now();
      RAISE EXCEPTION 'read log: % changed a row', via;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      DELETE FROM "PersonalDataAccess";
      RAISE EXCEPTION 'read log: % removed rows', via;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      TRUNCATE "PersonalDataAccess";
      RAISE EXCEPTION 'read log: % emptied the log', via;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
  END LOOP;
  SET LOCAL ROLE app_authenticated;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 125: läsloggen gallras som skolan bestämt, och bara skolans
-- (ACCESS_LOG, 20261026090000 and 20261026091000).
--
-- The läslogg school keeps the log 12 months (decided two days ago in the
-- fixtures). The preview counts the 13-month row; the night's purge takes
-- it past the append-only trigger, leaves the 11-month row and the gallring
-- school's five-year-old row (that school decided nothing for ACCESS_LOG),
-- counts it on the run, and "gallrat före" then answers ACCESS_LOG.
-- ---------------------------------------------------------------------------

BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000121')::text, true);
DO $$
DECLARE
  prev record;
BEGIN
  SELECT * INTO prev FROM app.gallring_preview('ACCESS_LOG', 12);
  IF prev.due <> 1 THEN RAISE EXCEPTION 'read log gallring: the preview counts % row(s), not the 13-month one', prev.due; END IF;
  PERFORM set_config('app.test_rls125_school', app.current_school_id()::text, true);
END $$;
SELECT set_config('request.jwt.claims', '', true);
DO $$
DECLARE
  run uuid := app.gallring_begin(current_setting('app.test_rls125_school')::uuid, clock_timestamp());
  n integer;
BEGIN
  n := app.gallring_purge(run, 'ACCESS_LOG', 5000);
  IF n <> 1 THEN RAISE EXCEPTION 'read log gallring: the purge took % row(s), not 1', n; END IF;
  n := app.gallring_purge(run, 'ACCESS_LOG', 5000);
  IF n <> 0 THEN RAISE EXCEPTION 'read log gallring: a second batch took % more', n; END IF;
  PERFORM app.gallring_finish(run, '{}', clock_timestamp());
  PERFORM set_config('app.test_rls125_run', run::text, true);
END $$;
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000121')::text, true);
DO $$
DECLARE
  run "GallringRuns";
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM "PersonalDataAccess" WHERE "at" < now() - interval '12 months';
  IF n <> 0 THEN RAISE EXCEPTION 'read log gallring: % row(s) older than the period are left', n; END IF;
  SELECT count(*) INTO n FROM "PersonalDataAccess" WHERE "at" < now() - interval '10 months';
  IF n <> 1 THEN RAISE EXCEPTION 'read log gallring: the 11-month row is gone or doubled (% left)', n; END IF;
  SELECT * INTO run FROM "GallringRuns" WHERE id = current_setting('app.test_rls125_run')::uuid;
  IF (run.counts ->> 'ACCESS_LOG')::int IS DISTINCT FROM 1 OR (run.complete ->> 'ACCESS_LOG')::boolean IS NOT TRUE
     OR (run.periods ->> 'ACCESS_LOG')::int IS DISTINCT FROM 12 THEN
    RAISE EXCEPTION 'read log gallring: the run says %, %, %', run.periods, run.counts, run.complete;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.retention_purged_before() WHERE data_type = 'ACCESS_LOG') THEN
    RAISE EXCEPTION 'read log gallring: "gallrat före" does not answer ACCESS_LOG';
  END IF;
END $$;
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000081')::text, true);
DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM "PersonalDataAccess" WHERE "at" < now() - interval '4 years';
  IF n <> 1 THEN RAISE EXCEPTION 'read log gallring: another school''s purge took the gallring school''s old row'; END IF;
END $$;
ROLLBACK;
