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
-- nobody maintains. This one has a single exemption, from its no-policy half
-- only: `_prisma_migrations`, Prisma's own history, has row security on and no
-- policy on purpose, because no API role is meant to reach it at all (section
-- 14). A new table cannot be added without either satisfying the rule or
-- changing it on purpose.
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
    AND c.relname <> '_prisma_migrations'
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
-- are there and enabled, and their functions run as the owner.
DO $$
DECLARE tbl text; n integer;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['LocalTimplans', 'LocalTimplanEntries']
  LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = format('public.%I', tbl)::regclass) THEN
      RAISE EXCEPTION 'timplan: row security is off on %', tbl;
    END IF;
    SELECT count(*) INTO n FROM pg_policy WHERE polrelid = format('public.%I', tbl)::regclass;
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
-- The second half is the link. blockedConstraintId must name a weekly
-- UNAVAILABLE TEACHER constraint of the duty's own teacher, and the two
-- triggers say so with SQLSTATE TD409 for every writer, the admin through
-- PostgREST's SQL included: a colleague's constraint, a ROOM's, a wish
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
                               "studentGroupId", "blockedConstraintId", "updatedAt")
  VALUES (school, me, year, 'APT_KONFERENS', 'APT', 120, grp, c_me, now()) RETURNING id INTO d_me;
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
    INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "blockedConstraintId", "updatedAt")
    VALUES (school, me, year, 'ANNAT', 'Fel lärare', 30, c_col, now());
    RAISE EXCEPTION 'duties: a duty took a colleague''s constraint as its slot';
  EXCEPTION WHEN SQLSTATE 'TD409' THEN NULL;
  END;
  BEGIN
    INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "blockedConstraintId", "updatedAt")
    VALUES (school, me, year, 'ANNAT', 'Sal', 30, room_c, now());
    RAISE EXCEPTION 'duties: a duty took a ROOM constraint as its slot';
  EXCEPTION WHEN SQLSTATE 'TD409' THEN NULL;
  END;
  BEGIN
    INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "blockedConstraintId", "updatedAt")
    VALUES (school, me, year, 'ANNAT', 'Önskemål', 30, c_wish, now());
    RAISE EXCEPTION 'duties: a duty took a PREFERRED_FREE wish as its slot';
  EXCEPTION WHEN SQLSTATE 'TD409' THEN NULL;
  END;
  BEGIN
    INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "blockedConstraintId", "updatedAt")
    VALUES (school, me, year, 'ANNAT', 'En dag', 30, c_date, now());
    RAISE EXCEPTION 'duties: a duty took a one-off dated constraint as its weekly slot';
  EXCEPTION WHEN SQLSTATE 'TD409' THEN NULL;
  END;
  -- By UPDATE as well: the colleague's duty given the acting teacher's slot,
  -- and the APT duty moved to the colleague with the acting teacher's slot.
  BEGIN
    UPDATE "TeacherDuties" SET "blockedConstraintId" = c_me2 WHERE id = d_col;
    RAISE EXCEPTION 'duties: an UPDATE gave a colleague''s duty this teacher''s slot';
  EXCEPTION WHEN SQLSTATE 'TD409' THEN NULL;
  END;
  BEGIN
    UPDATE "TeacherDuties" SET "userId" = colleague WHERE id = d_me;
    RAISE EXCEPTION 'duties: a duty moved to another teacher kept the first teacher''s slot';
  EXCEPTION WHEN SQLSTATE 'TD409' THEN NULL;
  END;
  -- One duty per slot: the unique key, not the trigger.
  BEGIN
    INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "blockedConstraintId", "updatedAt")
    VALUES (school, me, year, 'ANNAT', 'Samma tid', 30, c_me, now());
    RAISE EXCEPTION 'duties: two duties hold one slot';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- Another school's slot, stamped with this school: the composite key's.
  -- Caught as foreign_key_violation ONLY — a TD409 here would be the trigger
  -- describing school B's row, which it must never reach.
  BEGIN
    INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "blockedConstraintId", "updatedAt")
    VALUES (school, me, year, 'ANNAT', 'Skola B', 30, current_setting('app.test_constraint_b')::uuid, now());
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
  SELECT id INTO d_me FROM "TeacherDuties" WHERE "blockedConstraintId" = c_me;
  SELECT id INTO d_me2 FROM "TeacherDuties" WHERE kind = 'AMNESANSVAR';

  -- The admin deletes the slot: the duty stays, in its school, with no slot.
  DELETE FROM "AvailabilityConstraints" WHERE id = c_me;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'duties: an admin could not delete a duty''s slot (% row(s))', n;
  END IF;
  SELECT count(*) INTO n FROM "TeacherDuties"
   WHERE id = d_me AND "blockedConstraintId" IS NULL AND "schoolId" = school
     AND "studentGroupId" IS NOT NULL AND "minutesPerWeek" = 120;
  IF n <> 1 THEN
    RAISE EXCEPTION 'duties: deleting the slot did more than clear blockedConstraintId';
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
-- blocking the teacher in every later generation. The AFTER DELETE trigger
-- takes it; both doors are exercised here, as the admin through RLS.
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
  INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "blockedConstraintId", "updatedAt")
  VALUES (school, me, year, 'RASTVAKT', 'Morgonvakt', 30, c_one, now()) RETURNING id INTO d_one;
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
  INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "blockedConstraintId", "updatedAt")
  VALUES (school, me, next_year, 'APT_KONFERENS', 'APT nästa år', 120, c_next, now()) RETURNING id INTO d_next;
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

-- The catalog half: three arms, the three triggers enabled and SECURITY DEFINER,
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
       ('public."TeacherDuties"'::regclass,           'TeacherDuties_block_is_the_teachers'),
       ('public."TeacherDuties"'::regclass,           'TeacherDuties_take_their_block'),
       ('public."AvailabilityConstraints"'::regclass, 'AvailabilityConstraints_keep_duty_blocks'));
  IF n <> 3 THEN
    RAISE EXCEPTION 'duties: % of the three slot triggers are present, enabled and SECURITY DEFINER', n;
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
  SELECT count(*) INTO n FROM pg_policy WHERE polrelid = 'public."AcademicYearTimplans"'::regclass;
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
                               "studentGroupId", "blockedConstraintId", "updatedAt")
  VALUES (school, me, y1, 'MENTORSKAP', 'RLS20 Mentor 7A', 60, g7, s_old, now());

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
                               "studentGroupId", "blockedConstraintId", "updatedAt")
  VALUES (school, me, y2, 'MENTORSKAP', 'RLS20 Mentor 8A', 60, g8, c_new, now());
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
                                 "studentGroupId", "blockedConstraintId", "updatedAt")
    VALUES (school, me, y2, 'MENTORSKAP', 'RLS20 Fel lärare', 60, g8, c_col, now());
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
  SELECT count(*) INTO n FROM "TeacherDuties" WHERE "academicYearId" = y2 AND "blockedConstraintId" = slot;
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
    JOIN "AvailabilityConstraints" c ON c.id = d."blockedConstraintId"
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
  IF labels IS DISTINCT FROM 'TEACHER_UNAVAILABLE,ROOM_UNAVAILABLE,MANUAL' THEN
    RAISE EXCEPTION 'cancel cause: the enum is (%), expected TEACHER_UNAVAILABLE, ROOM_UNAVAILABLE, MANUAL', labels;
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
      INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "blockedConstraintId", "updatedAt")
      VALUES (school, u, y, 'APT_KONFERENS', 'RLS24 APT', 60, slot, now());
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
  SELECT string_agg(polname || ':' || polcmd::text, ',' ORDER BY polname) INTO bad FROM pg_policy
   WHERE polrelid = 'public."StudentEnrollments"'::regclass;
  IF bad IS DISTINCT FROM 'student_enrollments_admin_select:r,student_enrollments_guardian_select:r,student_enrollments_staff_select:r,student_enrollments_student_select:r' THEN
    RAISE EXCEPTION 'enrolment: StudentEnrollments has policies (%), expected the four SELECT arms', bad;
  END IF;
  SELECT string_agg(polname, ',') INTO bad FROM pg_policy
   WHERE polrelid = 'public."StudentEnrollments"'::regclass
     AND pg_get_expr(polqual, polrelid) NOT LIKE '%current_user_role%';
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
-- reads the log and the snapshot (the published grundschema is theirs to
-- see) and never the policy; a STUDENT and a GUARDIAN read none of the
-- three. Asserted in the transaction that wrote the rows, then rolled back.
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
                                       "publishedByUserId", created, gates)
  VALUES (school, y, 'PUBLISH', 'PUBLISHED', 'DRAFT', y_start, y_end, app.current_user_id(), 3, '[]')
  RETURNING id INTO pub;

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

-- A TEACHER: the log and the snapshot, never the policy; no write.
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.test_rls27_teacher_sub'))::text, true);
DO $$
DECLARE n bigint;
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'TEACHER' THEN
    RAISE EXCEPTION 'publication: expected a TEACHER, resolved %', app.current_user_role();
  END IF;
  SELECT count(*) INTO n FROM "TimetablePublications" WHERE id = current_setting('app.test_rls27_pub')::uuid;
  IF n <> 1 THEN RAISE EXCEPTION 'publication: a teacher reads % of the publication, expected 1', n; END IF;
  SELECT count(*) INTO n FROM "PublishedLessons" WHERE "publicationId" = current_setting('app.test_rls27_pub')::uuid;
  IF n <> 1 THEN RAISE EXCEPTION 'publication: a teacher reads % published lesson(s), expected 1', n; END IF;
  SELECT count(*) INTO n FROM "PublicationSettings";
  IF n <> 0 THEN RAISE EXCEPTION 'publication: a teacher reads the school''s publish policy'; END IF;
  BEGIN
    INSERT INTO "TimetablePublications" ("schoolId", "academicYearId", kind, outcome, "publishMode", "validFrom", "validTo")
    SELECT "schoolId", "academicYearId", 'PUBLISH', 'PUBLISHED', 'DIRECT', "validFrom", "validTo"
      FROM "TimetablePublications" WHERE id = current_setting('app.test_rls27_pub')::uuid;
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
       + (SELECT count(*) FROM "PublicationSettings") INTO n;
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
                          'timetable_publications_service_select:r,timetable_publications_staff_select:r' THEN
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
  END LOOP;
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

-- 27c: a master deleted in DRAFT records its future rows, every status, and
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
                        ORDER BY reconcilable DESC)
        FROM "PublicationPendingRemovals" WHERE "masterLessonId" = m) IS DISTINCT FROM 'a:t,b:f' THEN
    RAISE EXCEPTION 'draft: the deleted lesson recorded % rather than its two future rows',
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
