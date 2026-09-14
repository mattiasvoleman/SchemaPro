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
    -- not a table: a read of "Schools" here also runs the authenticated
    -- policies, and the fallback auth.uid() cannot cast the empty
    -- request.jwt.claims that earlier sections' transactions leave behind.
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
