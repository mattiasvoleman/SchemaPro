-- ===========================================================================
-- RLS checks that read every row past row security, run as the tables' owner
-- after rls-policies.sql (scripts/test/run-rls-tests.sh).
--
-- rls-policies.sql runs as the API's role, which row security limits to what
-- it may see; the checks here ask what a policy would admit among every row,
-- including the rows a principal cannot see. They run as the owner rather
-- than through a SECURITY DEFINER helper the API's role could call, so the
-- test database holds no function that reads past row security for it.
-- ===========================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- Section 263d: huvudmannens läsare skriver ingenting, på ägarsidan
-- (20261212090000).
--
-- Every write policy on public's tables, evaluated over every row of its
-- table as P, K and the roller school's läsare, naming each school through
-- the setting (the gateway's app.chosen_school_id) and through the header
-- (PostgREST's x-school-id, for the policies of the role PostgREST uses):
-- an INSERT's WITH CHECK, an UPDATE's (or its USING where it has none), a
-- DELETE's USING, and both of an ALL policy's. None admits a row, but for
-- K's own work as the huvudman's kommunadministratör: the four policies
-- through which K keeps H's members and keys, which admit K at every school
-- named, as they would with none (they ask for K's membership, not the
-- school). They are named; P and the läsare are admitted by none of them.
-- An UPDATE's USING alone is left out: it chooses the rows the WITH CHECK
-- then refuses, as for the läsare.
--
-- A row a principal may write is one these expressions admit, whichever
-- columns the write gives it, so long as the expression asks the session
-- for who writes. 263a in rls-policies.sql writes through the API's role,
-- which meets only the rows it sees; this sees all of them. As a control,
-- the roller school's full administrator, through the setting, is admitted
-- by many; the counts are printed, with floors.
-- ---------------------------------------------------------------------------

BEGIN;
DO $$
DECLARE
  who record;
  sc record;
  via text;
  pol record;
  which text;
  ex text;
  n bigint;
  evaluated int := 0;
  admitted_full int := 0;
  wrong text[] := '{}';
  policies int;
  kommunadmin constant text[] := ARRAY['HuvudmanApiKeys.huvudman_api_keys_kommunadmin_insert',
                                       'HuvudmanApiKeys.huvudman_api_keys_kommunadmin_update',
                                       'HuvudmanMembers.huvudman_members_kommunadmin_insert',
                                       'HuvudmanMembers.huvudman_members_kommunadmin_update'];
  ks text[] := '{}';
BEGIN
  SELECT count(*) INTO policies FROM pg_policies WHERE schemaname = 'public' AND cmd <> 'SELECT';
  FOR who IN SELECT * FROM (VALUES ('P', 'fe000000-0000-4000-8000-000000000260'),
                                   ('K', 'fe000000-0000-4000-8000-000000000261'),
                                   ('the läsare', '00000000-0000-4000-8000-000000000115'),
                                   ('FULL', '00000000-0000-4000-8000-000000000105')) v(name, sub) LOOP
    FOR sc IN SELECT id, slug FROM "Schools" ORDER BY slug LOOP
      FOREACH via IN ARRAY ARRAY['setting', 'header'] LOOP
        CONTINUE WHEN who.name = 'FULL' AND (via = 'header' OR sc.slug <> 'rls-roller-school');
        PERFORM set_config('request.jwt.claims', json_build_object('sub', who.sub, 'role', 'authenticated')::text, true),
                set_config('request.jwt.claim.sub', who.sub, true),
                set_config('request.jwt.claim.role', 'authenticated', true),
                set_config('app.chosen_school_id', CASE via WHEN 'setting' THEN sc.id::text ELSE '' END, true),
                set_config('request.headers', CASE via WHEN 'header' THEN json_build_object('x-school-id', sc.id)::text ELSE '' END, true);
        FOR pol IN
          SELECT tablename, policyname, cmd, qual, with_check FROM pg_policies
           WHERE schemaname = 'public' AND cmd <> 'SELECT'
             AND (via = 'setting' OR roles && ARRAY['authenticated', 'public']::name[])
           ORDER BY tablename, policyname
        LOOP
          FOREACH which IN ARRAY CASE pol.cmd WHEN 'INSERT' THEN ARRAY['check'] WHEN 'UPDATE' THEN ARRAY['check']
                                              WHEN 'DELETE' THEN ARRAY['using'] ELSE ARRAY['using', 'check'] END LOOP
            ex := CASE which WHEN 'using' THEN pol.qual ELSE coalesce(pol.with_check, pol.qual) END;
            IF ex IS NULL THEN
              wrong := wrong || format('%s on %s has no %s expression', pol.policyname, pol.tablename, which);
              CONTINUE;
            END IF;
            BEGIN
              EXECUTE format('SELECT count(*) FROM public.%I WHERE (%s)', pol.tablename, ex) INTO n;
            EXCEPTION WHEN OTHERS THEN
              wrong := wrong || format('%s on %s (%s) as %s at %s by %s: %s %s', pol.policyname, pol.tablename, which,
                                       who.name, sc.slug, via, SQLSTATE, SQLERRM);
              CONTINUE;
            END;
            IF who.name = 'FULL' THEN
              admitted_full := admitted_full + (n > 0)::int;
            ELSE
              evaluated := evaluated + 1;
              IF n > 0 AND who.name = 'K' AND pol.tablename || '.' || pol.policyname = ANY (kommunadmin) THEN
                ks := ks || (pol.tablename || '.' || pol.policyname);
              ELSIF n > 0 THEN
                wrong := wrong || format('%s on %s (%s) admits %s rows to %s at %s by %s', pol.policyname, pol.tablename, which,
                                         n, who.name, sc.slug, via);
              END IF;
            END IF;
          END LOOP;
        END LOOP;
      END LOOP;
    END LOOP;
  END LOOP;
  PERFORM set_config(g, '', true)
     FROM unnest(ARRAY['request.jwt.claims', 'request.jwt.claim.sub', 'request.jwt.claim.role', 'app.chosen_school_id', 'request.headers']) g;
  IF policies < 270 THEN
    wrong := wrong || format('only %s write policies (at least 270)', policies);
  END IF;
  IF evaluated < 25000 THEN
    wrong := wrong || format('only %s expressions evaluated (at least 25000)', evaluated);
  END IF;
  IF (SELECT array_agg(DISTINCT k ORDER BY k) FROM unnest(ks) k) IS DISTINCT FROM kommunadmin THEN
    wrong := wrong || format('K''s own work admits K through %s, not %s', (SELECT array_agg(DISTINCT k ORDER BY k) FROM unnest(ks) k), kommunadmin);
  END IF;
  IF admitted_full < 200 THEN
    wrong := wrong || format('the full administrator is admitted by only %s expressions (at least 200): the session reaches no policy', admitted_full);
  END IF;
  IF cardinality(wrong) > 0 THEN
    RAISE EXCEPTION 'huvudman 263d: %', array_to_string(wrong[1:20], '; ');
  END IF;
  RAISE NOTICE 'huvudman 263d: % write policies, % expressions evaluated for P, K and the läsare, none admits a row but K''s own work (% times); the full administrator is admitted by %',
    policies, evaluated, cardinality(ks), admitted_full;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 278i: salslånens tre EXCLUDE-villkor håller också mot en skrivare
-- som inte går genom funktionerna, och en skola som lämnar huvudmannen tar
-- inte bort något (20261217090000).
--
-- The functions refuse a second local room, a local room for two rooms and
-- an approval over an approved loan before the constraints have to; here
-- the owner writes past them, as two requests racing would, and each is
-- refused by its constraint (23P01); an ended loan binds no local room,
-- and an approved loan has its room (23514). Then the roller school leaves
-- H: its loans and the travel to school A stay, unread (section 279a).
-- ---------------------------------------------------------------------------

BEGIN;
DO $$
DECLARE
  loan "RoomLoans";
  other_room uuid;
  other_local uuid;
  m uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-roller-school');
  st text;
  wrong text[] := '{}';
BEGIN
  SELECT * INTO loan FROM "RoomLoans" WHERE status = 'APPROVED' LIMIT 1;
  IF loan.id IS NULL THEN
    RAISE EXCEPTION 'delade 278i: the approved loan is missing; fixtures did not run';
  END IF;
  INSERT INTO "Rooms" ("schoolId", name, "updatedAt") VALUES (loan."ownerSchoolId", 'Delade 278i ägare', now()) RETURNING id INTO other_room;
  INSERT INTO "Rooms" ("schoolId", name, "updatedAt") VALUES (loan."borrowerSchoolId", 'Delade 278i lokal', now()) RETURNING id INTO other_local;

  -- The same room with another local room at the same borrower.
  BEGIN
    INSERT INTO "RoomLoans" ("ownerSchoolId", "roomId", "borrowerSchoolId", "localRoomId", "dayOfWeek", "startTime", "endTime", "startDate", "endDate")
    VALUES (loan."ownerSchoolId", loan."roomId", loan."borrowerSchoolId", other_local, 5, '08:00', '09:00', loan."startDate", loan."endDate");
    wrong := wrong || 'a second local room for one room'::text;
  EXCEPTION WHEN exclusion_violation THEN NULL;
  END;
  -- The local room standing for another room too.
  BEGIN
    INSERT INTO "RoomLoans" ("ownerSchoolId", "roomId", "borrowerSchoolId", "localRoomId", "dayOfWeek", "startTime", "endTime", "startDate", "endDate")
    VALUES (loan."ownerSchoolId", other_room, loan."borrowerSchoolId", loan."localRoomId", 5, '08:00', '09:00', loan."startDate", loan."endDate");
    wrong := wrong || 'a local room for two rooms'::text;
  EXCEPTION WHEN exclusion_violation THEN NULL;
  END;
  -- A second approved loan that meets the first, and one that does not.
  BEGIN
    INSERT INTO "RoomLoans" ("ownerSchoolId", "roomId", "borrowerSchoolId", "localRoomId", "dayOfWeek", "startTime", "endTime",
                             "startDate", "endDate", status, "decidedAt")
    VALUES (loan."ownerSchoolId", loan."roomId", loan."borrowerSchoolId", loan."localRoomId", loan."dayOfWeek",
            loan."endTime" - interval '1 minute', loan."endTime" + interval '1 hour', loan."endDate", loan."endDate", 'APPROVED', now());
    wrong := wrong || 'two approved loans of a room on one minute and one date'::text;
  EXCEPTION WHEN exclusion_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "RoomLoans" ("ownerSchoolId", "roomId", "borrowerSchoolId", "localRoomId", "dayOfWeek", "startTime", "endTime",
                             "startDate", "endDate", status, "decidedAt")
    VALUES (loan."ownerSchoolId", loan."roomId", loan."borrowerSchoolId", loan."localRoomId", loan."dayOfWeek",
            loan."endTime", loan."endTime" + interval '1 hour', loan."startDate", loan."endDate", 'APPROVED', now());
  EXCEPTION WHEN exclusion_violation THEN
    wrong := wrong || 'an approved loan right after another is refused'::text;
  END;

  -- An ended loan binds no local room: a withdrawn loan of the room by
  -- another local room is taken.
  BEGIN
    INSERT INTO "RoomLoans" ("ownerSchoolId", "roomId", "borrowerSchoolId", "localRoomId", "dayOfWeek", "startTime", "endTime",
                             "startDate", "endDate", status, "endedAt")
    VALUES (loan."ownerSchoolId", loan."roomId", loan."borrowerSchoolId", other_local, 5, '08:00', '09:00',
            loan."startDate", loan."endDate", 'WITHDRAWN', now());
  EXCEPTION WHEN exclusion_violation THEN
    wrong := wrong || 'an ended loan binds its local room'::text;
  END;
  -- An approved loan has its room.
  BEGIN
    INSERT INTO "RoomLoans" ("ownerSchoolId", "roomId", "borrowerSchoolId", "localRoomName", "dayOfWeek", "startTime", "endTime",
                             "startDate", "endDate", status, "decidedAt")
    VALUES (loan."ownerSchoolId", other_room, loan."borrowerSchoolId", 'Delade 278i namn', 5, '08:00', '09:00',
            loan."startDate", loan."endDate", 'APPROVED', now());
    wrong := wrong || 'an approved loan without its room'::text;
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- The roller school leaves its huvudman; nothing of the sharing goes.
  DELETE FROM "HuvudmanSchools" WHERE "schoolId" = m;
  IF (SELECT count(*) FROM "RoomLoans" WHERE m IN ("ownerSchoolId", "borrowerSchoolId")) < 2
     OR NOT EXISTS (SELECT 1 FROM "SchoolTravelTimes" WHERE m IN ("schoolAId", "schoolBId")) THEN
    wrong := wrong || 'a departure deleted loans or travel'::text;
  END IF;

  IF cardinality(wrong) > 0 THEN
    RAISE EXCEPTION 'delade 278i: %', array_to_string(wrong, '; ');
  END IF;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 290o: årskurspannet på en beslutad plan, ägarens sida
-- (20261219090000).
--
-- Section 290 of rls-policies.sql runs as a signed-in admin, whose span the
-- trigger stamps with who (the caller) and when (now()). The owner (migrations,
-- the seed, these fixtures) carries no JWT subject: it is not a person, so the
-- trigger does not choose a name for it, and a span it gives a decided plan has
-- to state both stamps itself. The CHECKs that tie a stamp to a decided plan
-- that has a span hold for everyone, which only the owner can reach without the
-- trigger clearing the stamps first.
-- ---------------------------------------------------------------------------

BEGIN;
DO $$
DECLARE
  school  uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-fixture-school');
  admin_  uuid;
  stranger uuid;
  b1      uuid;
  plan    uuid;
  drafty  uuid;
  rec     record;
BEGIN
  SELECT id INTO admin_ FROM "Users" WHERE "schoolId" = school AND role = 'SCHOOL_ADMIN' AND "isActive" LIMIT 1;
  SELECT id INTO stranger FROM "Users" WHERE "schoolId" <> school LIMIT 1;
  SELECT id INTO b1 FROM "NationalTimplanVersions" WHERE code = 'SFS2023:945/B1';
  IF school IS NULL OR admin_ IS NULL OR stranger IS NULL OR b1 IS NULL THEN
    RAISE EXCEPTION 'span (owner): the fixture school, its admin, another school''s user or bilaga 1 is missing';
  END IF;

  INSERT INTO "LocalTimplans" ("schoolId", name, "schoolForm", "nationalTimplanVersionId", "updatedAt")
  VALUES (school, 'RLS-span ägare utkast', 'GRUNDSKOLA', b1, now()) RETURNING id INTO drafty;
  INSERT INTO "LocalTimplans" ("schoolId", name, "schoolForm", "nationalTimplanVersionId",
                               status, "decidedAt", "decidedByUserId", "decisionNote", "updatedAt")
  VALUES (school, 'RLS-span ägare beslutad', 'GRUNDSKOLA', b1, 'DECIDED', now(), admin_, 'ägarens beslut', now())
  RETURNING id INTO plan;

  -- The owner is no person, so a span with no stamp is not a change the record can attribute.
  BEGIN
    UPDATE "LocalTimplans" SET "gradeFrom" = 4, "gradeTo" = 9 WHERE id = plan;
    RAISE EXCEPTION 'span (owner): a decided plan took a span with no stamp';
  EXCEPTION WHEN SQLSTATE 'TP409' THEN NULL;
  END;
  BEGIN
    UPDATE "LocalTimplans" SET "gradeFrom" = 4, "gradeTo" = 9, "gradeSpanSetAt" = now() WHERE id = plan;
    RAISE EXCEPTION 'span (owner): a stamp with no person was admitted';
  EXCEPTION WHEN SQLSTATE 'TP409' THEN NULL;
  END;
  -- A stamp that names another school's user is a foreign key violation: the key is (id, schoolId).
  BEGIN
    UPDATE "LocalTimplans" SET "gradeFrom" = 4, "gradeTo" = 9, "gradeSpanSetAt" = now(), "gradeSpanSetByUserId" = stranger
     WHERE id = plan;
    RAISE EXCEPTION 'span (owner): another school''s user was named as the setter';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  UPDATE "LocalTimplans"
     SET "gradeFrom" = 4, "gradeTo" = 9, "gradeSpanSetAt" = '2026-11-03 08:00+00', "gradeSpanSetByUserId" = admin_
   WHERE id = plan;
  SELECT "gradeFrom" AS f, "gradeTo" AS t, "gradeSpanSetAt" AS set_at, "gradeSpanSetByUserId" AS set_by INTO rec
    FROM "LocalTimplans" WHERE id = plan;
  IF rec.f <> 4 OR rec.t <> 9 OR rec.set_at <> '2026-11-03 08:00+00'::timestamptz OR rec.set_by <> admin_ THEN
    RAISE EXCEPTION 'span (owner): the stated stamp was not kept as written (%)', rec;
  END IF;
  BEGIN
    UPDATE "LocalTimplans" SET "gradeFrom" = 1, "gradeTo" = 9 WHERE id = plan;
    RAISE EXCEPTION 'span (owner): a span set once was set again';
  EXCEPTION WHEN SQLSTATE 'TP409' THEN NULL;
  END;

  -- The stamp belongs to a decided plan that has a span, whoever writes it,
  -- and is both halves or neither (the trigger lets a draft's row through
  -- untouched for the owner, so the CHECKs are what answer).
  BEGIN
    INSERT INTO "LocalTimplans" ("schoolId", name, "schoolForm", "nationalTimplanVersionId",
                                 status, "decidedAt", "decidedByUserId", "decisionNote",
                                 "gradeFrom", "gradeTo", "gradeSpanSetAt", "updatedAt")
    VALUES (school, 'RLS-span ägare halv stämpel', 'GRUNDSKOLA', b1, 'DECIDED', now(), admin_, 'x', 4, 9, now(), now());
    RAISE EXCEPTION 'span (owner): a stamp of one half was admitted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE "LocalTimplans" SET "gradeFrom" = 4, "gradeTo" = 9, "gradeSpanSetAt" = now(), "gradeSpanSetByUserId" = admin_
     WHERE id = drafty;
    RAISE EXCEPTION 'span (owner): a draft carries a span stamp';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "LocalTimplans" ("schoolId", name, "schoolForm", "nationalTimplanVersionId",
                                 status, "decidedAt", "decidedByUserId", "decisionNote",
                                 "gradeSpanSetAt", "gradeSpanSetByUserId", "updatedAt")
    VALUES (school, 'RLS-span ägare stämpel utan spann', 'GRUNDSKOLA', b1, 'DECIDED', now(), admin_, 'x', now(), admin_, now());
    RAISE EXCEPTION 'span (owner): a decided plan with no span carries a span stamp';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- A plan born decided, with its span and stamps in one INSERT, is the owner's to plant (the fixtures do).
  INSERT INTO "LocalTimplans" ("schoolId", name, "schoolForm", "nationalTimplanVersionId",
                               status, "decidedAt", "decidedByUserId", "decisionNote",
                               "gradeFrom", "gradeTo", "gradeSpanSetAt", "gradeSpanSetByUserId", "updatedAt")
  VALUES (school, 'RLS-span ägare född med spann', 'GRUNDSKOLA', b1, 'DECIDED', now(), admin_, 'x', 6, 9, now(), admin_, now());

  -- Last, because the claim stays for the rest of the transaction: a signed-in
  -- writer with no user of the school behind the subject is refused, as the
  -- decision's own guard refuses one, and a setter that does not exist is not
  -- named. (Unreachable through row security, which admits no such writer to
  -- the plan at all; the owner bypasses it, so the guard can be asked here.)
  INSERT INTO "LocalTimplans" ("schoolId", name, "schoolForm", "nationalTimplanVersionId",
                               status, "decidedAt", "decidedByUserId", "decisionNote", "updatedAt")
  VALUES (school, 'RLS-span ägare utan användare', 'GRUNDSKOLA', b1, 'DECIDED', now(), admin_, 'x', now())
  RETURNING id INTO plan;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid())::text, true);
  BEGIN
    UPDATE "LocalTimplans" SET "gradeFrom" = 4, "gradeTo" = 9 WHERE id = plan;
    RAISE EXCEPTION 'span (owner): a subject with no user set a span';
  EXCEPTION WHEN SQLSTATE 'TP403' THEN NULL;
  END;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 291: en borttagen person hittar sina rader i ett index, på
-- ägarsidan (20261220090000).
--
-- Removing a Users or HuvudmanMembers row makes Postgres look, in every table
-- with a foreign key to it, for the rows that name it (to null them, remove
-- them or refuse the removal with). The lookup is an equality on the key's
-- columns, and with no index it reads the table once for each person removed,
-- which is what took the bulk removal of pupils past its time over a school's
-- attendance. So:
--
--   1. the twenty-four indexes the migration adds exist, are valid and have
--      the columns, and for the partial one the predicate, it gives them;
--   2. every foreign key to a person table has an index that serves the
--      lookup: one that starts with the person's column, or whose first
--      columns are the key's own in any order (an equality on each is
--      answered by it whichever comes first), full or partial WHERE the
--      person's column is not NULL (the lookup's equality implies it). A key
--      added later without one fails here, named;
--   3. the planner, asked for the lookup's plan (the statement ri_triggers.c
--      issues, generic, with sequential scans switched off), never answers
--      with a Seq Scan, and, given a copy of PersonalDataAccess that is empty
--      and has only the one partial index (built from the real index's own
--      definition), takes that index for each of its two keys: the proof that
--      a partial index whose predicate the lookup implies is used. The copy,
--      not the live table: with several indexes to choose between, the
--      planner's pick follows the table's statistics (a läslogg of a single
--      actor, a thousand rows or more, is read through another index, and
--      nothing is wrong with either), so a check that the live table's pick is
--      the partial index fails on a development database and proves nothing
--      about the predicate.
--
-- Run as the owner: the policies of the API's role add predicates of their
-- own, and the lookup Postgres makes for a foreign key sees none of them.
-- The count of keys asked has a floor, so a catalogue read that found none
-- cannot pass.
-- ---------------------------------------------------------------------------

BEGIN;
DO $$
DECLARE
  want record;
  got record;
  fk record;
  line text;
  plan text;
  where_sql text;
  types text;
  nulls text;
  key_cols text;
  person_col text;
  expected_index text;
  probe_def text;
  asked int := 0;
  answered_by_partial int := 0;
  unled text[] := '{}';
  bare text[] := '{}';
  wrong text[] := '{}';
BEGIN
  -- 1. The twenty-four indexes.
  FOR want IN
    SELECT * FROM (VALUES
      ('AttendanceRecords',            'AttendanceRecords_recordedById_idx',                      ARRAY['recordedById'],                 NULL),
      ('AbsenceReports',               'AbsenceReports_reportedById_idx',                         ARRAY['reportedById'],                 NULL),
      ('LeaveRequests',                'LeaveRequests_requestedById_idx',                         ARRAY['requestedById'],                NULL),
      ('LeaveRequests',                'LeaveRequests_decidedById_idx',                           ARRAY['decidedById'],                  NULL),
      ('LeaveRequests',                'LeaveRequests_referredById_idx',                          ARRAY['referredById'],                 NULL),
      ('RoomBookings',                 'RoomBookings_decidedById_idx',                            ARRAY['decidedById'],                  NULL),
      ('DevicePushTokens',             'DevicePushTokens_userId_schoolId_idx',                    ARRAY['userId', 'schoolId'],           NULL),
      ('PersonalDataAccess',           'PersonalDataAccess_huvudmanMemberId_idx',                 ARRAY['huvudmanMemberId'],             '("huvudmanMemberId" IS NOT NULL)'),
      ('AttendanceSharingDecisions',   'AttendanceSharingDecisions_decidedById_schoolId_idx',     ARRAY['decidedById', 'schoolId'],      NULL),
      ('HuvudmanApiKeys',              'HuvudmanApiKeys_createdById_huvudmanId_idx',              ARRAY['createdById', 'huvudmanId'],    NULL),
      ('HuvudmanSchoolEvents',         'HuvudmanSchoolEvents_byMemberId_huvudmanId_idx',          ARRAY['byMemberId', 'huvudmanId'],     NULL),
      ('HuvudmanSchoolEvents',         'HuvudmanSchoolEvents_byUserId_schoolId_idx',              ARRAY['byUserId', 'schoolId'],         NULL),
      ('HuvudmanSchoolRequests',       'HuvudmanSchoolRequests_requestedById_huvudmanId_idx',     ARRAY['requestedById', 'huvudmanId'],  NULL),
      ('HuvudmanSchools',              'HuvudmanSchools_requestedById_huvudmanId_idx',            ARRAY['requestedById', 'huvudmanId'],  NULL),
      ('HuvudmanSchools',              'HuvudmanSchools_acceptedById_schoolId_idx',               ARRAY['acceptedById', 'schoolId'],     NULL),
      ('LeaveDelegationDecisions',     'LeaveDelegationDecisions_decidedById_schoolId_idx',       ARRAY['decidedById', 'schoolId'],      NULL),
      ('LocalTimplans',                'LocalTimplans_decidedByUserId_schoolId_idx',              ARRAY['decidedByUserId', 'schoolId'],  NULL),
      ('LocalTimplans',                'LocalTimplans_gradeSpanSetByUserId_schoolId_idx',         ARRAY['gradeSpanSetByUserId', 'schoolId'], NULL),
      ('MasterLessons',                'MasterLessons_coTeacherId_schoolId_idx',                  ARRAY['coTeacherId', 'schoolId'],      NULL),
      ('RetentionDecisions',           'RetentionDecisions_decidedById_schoolId_idx',             ARRAY['decidedById', 'schoolId'],      NULL),
      ('RoomLoans',                    'RoomLoans_decidedById_ownerSchoolId_idx',                 ARRAY['decidedById', 'ownerSchoolId'], NULL),
      ('RoomLoans',                    'RoomLoans_requestedById_borrowerSchoolId_idx',            ARRAY['requestedById', 'borrowerSchoolId'], NULL),
      ('TeacherDuties',                'TeacherDuties_userId_schoolId_idx',                       ARRAY['userId', 'schoolId'],           NULL),
      ('TeachingRequirements',         'TeachingRequirements_coTeacherId_schoolId_idx',           ARRAY['coTeacherId', 'schoolId'],      NULL)
    ) v(tbl, idx, cols, pred)
  LOOP
    SELECT i.indrelid = to_regclass(format('public.%I', want.tbl)) AS on_table,
           i.indisvalid AND i.indisready AS usable,
           am.amname AS method,
           (SELECT array_agg(a.attname::text ORDER BY k.ord)
              FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) AS cols,
           pg_get_expr(i.indpred, i.indrelid) AS pred
      INTO got
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_am am ON am.oid = c.relam
     WHERE c.oid = to_regclass(format('public.%I', want.idx));
    IF NOT FOUND THEN
      RAISE EXCEPTION 'fk-index: % on % does not exist', want.idx, want.tbl;
    END IF;
    IF NOT (got.on_table AND got.usable AND got.method = 'btree') THEN
      RAISE EXCEPTION 'fk-index: % is not a valid btree index on % (%)', want.idx, want.tbl, got;
    END IF;
    IF got.cols IS DISTINCT FROM want.cols THEN
      RAISE EXCEPTION 'fk-index: % is on % where % was meant', want.idx, got.cols, want.cols;
    END IF;
    IF got.pred IS DISTINCT FROM want.pred THEN
      RAISE EXCEPTION 'fk-index: % has the predicate % where % was meant', want.idx, got.pred, want.pred;
    END IF;
  END LOOP;

  -- 2 and 3. Every key to a person table: an index that leads with the person's
  -- column, and the plan of the lookup.
  PERFORM set_config('plan_cache_mode', 'force_generic_plan', true);
  PERFORM set_config('enable_seqscan', 'off', true);
  FOR fk IN
    SELECT c.conrelid, c.conkey, cl.relname AS tbl,
           (SELECT c.conkey[i]
              FROM generate_subscripts(c.conkey, 1) i
             WHERE (SELECT a.attname FROM pg_attribute a
                     WHERE a.attrelid = c.confrelid AND a.attnum = c.confkey[i]) = 'id') AS person_attnum
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_namespace ns ON ns.oid = cl.relnamespace AND ns.nspname = 'public'
     WHERE c.contype = 'f'
       AND c.confrelid IN (to_regclass('public."Users"'), to_regclass('public."HuvudmanMembers"'))
     ORDER BY cl.relname, c.conname
  LOOP
    SELECT string_agg(format('$%s = x.%I', u.ord, a.attname), ' AND ' ORDER BY u.ord),
           string_agg(format_type(a.atttypid, a.atttypmod), ',' ORDER BY u.ord),
           string_agg('NULL', ',' ORDER BY u.ord),
           string_agg(a.attname::text, ',' ORDER BY u.ord),
           max(a.attname::text) FILTER (WHERE a.attnum = fk.person_attnum)
      INTO where_sql, types, nulls, key_cols, person_col
      FROM unnest(fk.conkey) WITH ORDINALITY u(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = fk.conrelid AND a.attnum = u.attnum;
    asked := asked + 1;

    IF NOT EXISTS (
      SELECT 1 FROM pg_index i
       WHERE i.indrelid = fk.conrelid AND i.indisvalid AND i.indisready AND i.indexprs IS NULL
         AND (i.indpred IS NULL OR pg_get_expr(i.indpred, i.indrelid) = format('(%I IS NOT NULL)', person_col))
         AND ((i.indkey::int2[])[0] = fk.person_attnum
              OR (i.indnkeyatts >= cardinality(fk.conkey)
                  AND (SELECT array_agg(k ORDER BY k) FROM unnest((i.indkey::int2[])[0:cardinality(fk.conkey) - 1]) k)
                    = (SELECT array_agg(k ORDER BY k) FROM unnest(fk.conkey) k)))
    ) THEN
      unled := unled || format('%s(%s)', fk.tbl, key_cols);
    END IF;

    EXECUTE format('PREPARE fk_index_lookup(%s) AS SELECT 1 FROM ONLY %I x WHERE %s FOR KEY SHARE OF x',
                   types, fk.tbl, where_sql);
    plan := '';
    FOR line IN EXECUTE format('EXPLAIN EXECUTE fk_index_lookup(%s)', nulls) LOOP
      plan := plan || line || E'\n';
    END LOOP;
    DEALLOCATE fk_index_lookup;
    IF plan ~ 'Seq Scan' THEN
      bare := bare || format('%s(%s)', fk.tbl, key_cols);
    END IF;

    -- The two partial indexes of the läslogg: the planner must take them, asked
    -- of an empty copy of the table with that one index on it (see 3 above), so
    -- that the answer is the same on every database whatever the table holds.
    expected_index := CASE fk.tbl || '(' || key_cols || ')'
      WHEN 'PersonalDataAccess(huvudmanMemberId)' THEN 'PersonalDataAccess_huvudmanMemberId_idx'
      WHEN 'PersonalDataAccess(actorId,schoolId)' THEN 'PersonalDataAccess_actorId_kind_at_idx'
    END;
    IF expected_index IS NOT NULL THEN
      probe_def := replace(pg_get_indexdef(to_regclass(format('public.%I', expected_index))),
                           ' ON public."PersonalDataAccess" ', ' ON pg_temp.fk_index_probe ');
      IF probe_def IS NULL THEN
        wrong := wrong || format('%s(%s): %s does not exist', fk.tbl, key_cols, expected_index);
      ELSIF probe_def NOT LIKE '% ON pg_temp.fk_index_probe %' THEN
        RAISE EXCEPTION 'fk-index: the definition of % could not be moved to the probe table (%)', expected_index, probe_def;
      ELSE
        EXECUTE 'CREATE TEMP TABLE fk_index_probe (LIKE "PersonalDataAccess")';
        EXECUTE probe_def;
        EXECUTE format('PREPARE fk_index_probe_lookup(%s) AS SELECT 1 FROM ONLY pg_temp.fk_index_probe x WHERE %s FOR KEY SHARE OF x',
                       types, where_sql);
        plan := '';
        FOR line IN EXECUTE format('EXPLAIN EXECUTE fk_index_probe_lookup(%s)', nulls) LOOP
          plan := plan || line || E'\n';
        END LOOP;
        DEALLOCATE fk_index_probe_lookup;
        DROP TABLE pg_temp.fk_index_probe;
        IF position(expected_index IN plan) = 0 OR plan ~ 'Seq Scan' THEN
          wrong := wrong || format('%s(%s) is not answered by %s, alone on an empty copy of the table', fk.tbl, key_cols, expected_index);
        ELSE
          answered_by_partial := answered_by_partial + 1;
        END IF;
      END IF;
    END IF;
  END LOOP;

  IF asked < 60 THEN
    RAISE EXCEPTION 'fk-index: only % keys to a person table were asked, the catalogue holds more than 60', asked;
  END IF;
  IF cardinality(unled) > 0 THEN
    RAISE EXCEPTION 'fk-index: removing a person has no index to find the rows of % with (give each key one: a plain index on its columns, the person''s first)', unled;
  END IF;
  IF cardinality(bare) > 0 THEN
    RAISE EXCEPTION 'fk-index: removing a person reads the whole of % (no index of any kind answers the lookup)', bare;
  END IF;
  IF cardinality(wrong) > 0 THEN
    RAISE EXCEPTION 'fk-index: %', wrong;
  END IF;
  IF answered_by_partial <> 2 THEN
    RAISE EXCEPTION 'fk-index: % of the 2 keys with a partial index were answered by it', answered_by_partial;
  END IF;
  RAISE NOTICE 'fk-index: % keys to a person table asked, each served by an index, none left to a Seq Scan, 2 answered by a partial index', asked;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Sections 305-309 on the owner's side: Frånvarobevakning (20261231090100).
--
-- What rls-policies.sql cannot ask: the findings' own constraints (no role
-- writes the table), the periods a digest is due for (they hang on the date
-- the switch went on, which a trigger stamps), the mentor rule held to the
-- leave decision's, and gallring's reach over the findings.
-- ---------------------------------------------------------------------------

-- The helpers the owner's sections share (temporary, as the ones in rls-policies.sql).
CREATE FUNCTION pg_temp.fbo_refuses(p_sql text, p_constraint text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RAISE EXCEPTION 'frånvarobevakning: accepted: %', p_sql;
EXCEPTION WHEN check_violation OR unique_violation THEN
  IF position(p_constraint IN SQLERRM) = 0 THEN
    RAISE EXCEPTION 'frånvarobevakning: % was refused, but not by %: %', p_sql, p_constraint, SQLERRM;
  END IF;
END $$;
CREATE FUNCTION pg_temp.fbo_expect(p_label text, p_got text, p_want text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_want THEN
    RAISE EXCEPTION E'frånvarobevakning %: got\n%\nwanted\n%', p_label, p_got, p_want;
  END IF;
END $$;

-- 305o: the findings' constraints, the keys and the indexes.
BEGIN;
DO $$
DECLARE
  school uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-franvarobevakning-school');
  p1 uuid := (SELECT id FROM "Users" WHERE "schoolId" = school AND email = 'fb-p1@example.invalid');
  p2 uuid := (SELECT id FROM "Users" WHERE "schoolId" = school AND email = 'fb-p2@example.invalid');
  lim uuid := gen_random_uuid();
  idx text;
  upd text;
BEGIN
  -- Each of these must be refused, by its constraint.
  PERFORM pg_temp.fbo_refuses(format($f$INSERT INTO "AbsenceWatchFindings" ("schoolId", "studentId", "limitId", "recipientGroup", kind, basis, percent, "windowDays", "firstCrossedOn", "lastSeenOn", "absentMinutes", "recordedMinutes")
    VALUES (%L, %L, %L, 'MENTOR', 'SHARE', 'ALL', 10, 14, '2026-09-10', '2026-09-09', 60, 600)$f$, school, p1, lim), 'days_are_ordered');
  PERFORM pg_temp.fbo_refuses(format($f$INSERT INTO "AbsenceWatchFindings" ("schoolId", "studentId", "limitId", "recipientGroup", kind, basis, percent, "windowDays", "firstCrossedOn", "lastSeenOn", "clearedOn", "absentMinutes", "recordedMinutes")
    VALUES (%L, %L, %L, 'MENTOR', 'SHARE', 'ALL', 10, 14, '2026-09-10', '2026-09-12', '2026-09-09', 60, 600)$f$, school, p1, lim), 'days_are_ordered');
  -- A share has minutes, none of them above the recorded ones, and no streak.
  PERFORM pg_temp.fbo_refuses(format($f$INSERT INTO "AbsenceWatchFindings" ("schoolId", "studentId", "limitId", "recipientGroup", kind, basis, percent, "windowDays", "firstCrossedOn", "lastSeenOn", "absentMinutes", "recordedMinutes")
    VALUES (%L, %L, %L, 'MENTOR', 'SHARE', 'ALL', 10, 14, '2026-09-10', '2026-09-10', 601, 600)$f$, school, p1, lim), 'a_kind_has_its_figures');
  PERFORM pg_temp.fbo_refuses(format($f$INSERT INTO "AbsenceWatchFindings" ("schoolId", "studentId", "limitId", "recipientGroup", kind, basis, percent, "windowDays", "firstCrossedOn", "lastSeenOn", "absentMinutes", "recordedMinutes")
    VALUES (%L, %L, %L, 'MENTOR', 'SHARE', 'ALL', 10, 14, '2026-09-10', '2026-09-10', 0, 0)$f$, school, p1, lim), 'a_kind_has_its_figures');
  PERFORM pg_temp.fbo_refuses(format($f$INSERT INTO "AbsenceWatchFindings" ("schoolId", "studentId", "limitId", "recipientGroup", kind, basis, percent, "windowDays", "firstCrossedOn", "lastSeenOn", "absentMinutes", "recordedMinutes", "streakDays")
    VALUES (%L, %L, %L, 'MENTOR', 'SHARE', 'ALL', 10, 14, '2026-09-10', '2026-09-10', 60, 600, 3)$f$, school, p1, lim), 'a_kind_has_its_figures');
  PERFORM pg_temp.fbo_refuses(format($f$INSERT INTO "AbsenceWatchFindings" ("schoolId", "studentId", "limitId", "recipientGroup", kind, basis, percent, "windowDays", "firstCrossedOn", "lastSeenOn")
    VALUES (%L, %L, %L, 'MENTOR', 'SHARE', 'ALL', 10, 14, '2026-09-10', '2026-09-10')$f$, school, p1, lim), 'a_kind_has_its_figures');
  -- A run has its days, at least the limit's, and no minutes.
  PERFORM pg_temp.fbo_refuses(format($f$INSERT INTO "AbsenceWatchFindings" ("schoolId", "studentId", "limitId", "recipientGroup", kind, basis, "consecutiveDays", "firstCrossedOn", "lastSeenOn", "streakDays")
    VALUES (%L, %L, %L, 'REKTOR', 'CONSECUTIVE', 'ALL', 3, '2026-09-10', '2026-09-10', 2)$f$, school, p1, lim), 'a_kind_has_its_figures');
  PERFORM pg_temp.fbo_refuses(format($f$INSERT INTO "AbsenceWatchFindings" ("schoolId", "studentId", "limitId", "recipientGroup", kind, basis, "consecutiveDays", "firstCrossedOn", "lastSeenOn", "streakDays", "absentMinutes", "recordedMinutes")
    VALUES (%L, %L, %L, 'REKTOR', 'CONSECUTIVE', 'ALL', 3, '2026-09-10', '2026-09-10', 3, 60, 600)$f$, school, p1, lim), 'a_kind_has_its_figures');
  PERFORM pg_temp.fbo_refuses(format($f$INSERT INTO "AbsenceWatchFindings" ("schoolId", "studentId", "limitId", "recipientGroup", kind, basis, "consecutiveDays", "firstCrossedOn", "lastSeenOn")
    VALUES (%L, %L, %L, 'REKTOR', 'CONSECUTIVE', 'ALL', 3, '2026-09-10', '2026-09-10')$f$, school, p1, lim), 'a_kind_has_its_figures');

  -- One open finding per limit and pupil; a closed one beside it, and another pupil's, are fine.
  INSERT INTO "AbsenceWatchFindings" ("schoolId", "studentId", "limitId", "recipientGroup", kind, basis, percent, "windowDays", "firstCrossedOn", "lastSeenOn", "absentMinutes", "recordedMinutes")
  VALUES (school, p1, lim, 'MENTOR', 'SHARE', 'ALL', 10, 14, '2026-09-10', '2026-09-10', 60, 600);
  PERFORM pg_temp.fbo_refuses(format($f$INSERT INTO "AbsenceWatchFindings" ("schoolId", "studentId", "limitId", "recipientGroup", kind, basis, percent, "windowDays", "firstCrossedOn", "lastSeenOn", "absentMinutes", "recordedMinutes")
    VALUES (%L, %L, %L, 'MENTOR', 'SHARE', 'ALL', 10, 14, '2026-09-11', '2026-09-11', 60, 600)$f$, school, p1, lim), 'one_open_key');
  INSERT INTO "AbsenceWatchFindings" ("schoolId", "studentId", "limitId", "recipientGroup", kind, basis, percent, "windowDays", "firstCrossedOn", "lastSeenOn", "clearedOn", "absentMinutes", "recordedMinutes")
  VALUES (school, p1, lim, 'MENTOR', 'SHARE', 'ALL', 10, 14, '2026-08-10', '2026-08-12', '2026-08-13', 60, 600);
  INSERT INTO "AbsenceWatchFindings" ("schoolId", "studentId", "limitId", "recipientGroup", kind, basis, percent, "windowDays", "firstCrossedOn", "lastSeenOn", "absentMinutes", "recordedMinutes")
  VALUES (school, p2, lim, 'MENTOR', 'SHARE', 'ALL', 10, 14, '2026-09-10', '2026-09-10', 60, 600);

  -- A pupil from another school is not a pupil of this one: the key is (id, school).
  BEGIN
    INSERT INTO "AbsenceWatchFindings" ("schoolId", "studentId", "limitId", "recipientGroup", kind, basis, percent, "windowDays", "firstCrossedOn", "lastSeenOn", "absentMinutes", "recordedMinutes")
    SELECT school, u.id, gen_random_uuid(), 'MENTOR', 'SHARE', 'ALL', 10, 14, '2026-09-10', '2026-09-10', 60, 600
      FROM "Users" u JOIN "Schools" s ON s.id = u."schoolId" AND s.slug = 'rls-franvarobevakning-annan' WHERE u.role = 'STUDENT';
    RAISE EXCEPTION 'frånvarobevakning 305o: a finding of this school names a pupil of another';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  -- The key to the pupil is the person's removal: it cascades, and an index leads with the pupil.
  SELECT confdeltype::text, confupdtype::text INTO idx, upd
    FROM pg_constraint WHERE conrelid = 'public."AbsenceWatchFindings"'::regclass AND conname = 'AbsenceWatchFindings_studentId_schoolId_fkey';
  IF idx IS DISTINCT FROM 'c' THEN RAISE EXCEPTION 'frånvarobevakning 305o: the pupil key does not cascade (%)', idx; END IF;
  IF NOT EXISTS (
       SELECT 1 FROM pg_index i
        WHERE i.indrelid = 'public."AbsenceWatchFindings"'::regclass
          AND (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = i.indrelid AND a.attnum = i.indkey[0]) = 'studentId'
          AND (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = i.indrelid AND a.attnum = i.indkey[1]) = 'schoolId') THEN
    RAISE EXCEPTION 'frånvarobevakning 305o: no index leads with the key to the pupil, so removing a person scans the findings';
  END IF;
  -- The limit is no key: a finding outlives it.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public."AbsenceWatchFindings"'::regclass AND contype = 'f' AND confrelid = 'public."AbsenceWatchLimits"'::regclass) THEN
    RAISE EXCEPTION 'frånvarobevakning 305o: the finding has a key to the limit, which a removed limit would take with it';
  END IF;
  DELETE FROM "Users" WHERE id = p2;
  IF EXISTS (SELECT 1 FROM "AbsenceWatchFindings" WHERE "studentId" = p2) THEN
    RAISE EXCEPTION 'frånvarobevakning 305o: a removed pupil''s finding stayed';
  END IF;
  IF (SELECT count(*) FROM "AbsenceWatchFindings" WHERE "studentId" = p1) <> 2 THEN RAISE EXCEPTION 'frånvarobevakning 305o: another pupil''s findings went'; END IF;

  -- The switch carries a date when it is on (a check the trigger always meets).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public."AbsenceWatchSettings"'::regclass AND conname = 'AbsenceWatchSettings_on_has_a_date') THEN
    RAISE EXCEPTION 'frånvarobevakning 305o: a switch can be on without a date';
  END IF;
END $$;
ROLLBACK;

-- 308o: which periods are due, to the day. The date the switch went on is the
-- trigger's, so the trigger is held off (session_replication_role) and the
-- owner writes it. Weeks run Monday to Sunday; a month is the last whole one.
BEGIN;
SET LOCAL session_replication_role = replica;
DO $$
DECLARE
  school uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-franvarobevakning-school');
  got text;
BEGIN
  INSERT INTO "AbsenceWatchSettings" ("schoolId", enabled, "enabledOn", "mentorCadence", "rektorCadence", "kansliCadence", "guardianCadence")
  VALUES (school, true, '2026-09-10', 'WEEKLY', 'WEEKLY', 'MONTHLY', 'MONTHLY');
  -- Mentors and rektor weekly, kansli and guardians monthly. Kansli has no limit: nothing due for it.
  INSERT INTO "AbsenceWatchLimits" ("schoolId", "recipientGroup", kind, basis, percent, "windowDays") VALUES
    (school, 'MENTOR', 'SHARE', 'INVALID', 10, 14), (school, 'REKTOR', 'SHARE', 'INVALID', 10, 14), (school, 'GUARDIAN', 'SHARE', 'INVALID', 10, 14);

  -- Monday the 14th: the week of the 7th to the 13th, and September for nobody yet (August ended before the switch).
  PERFORM pg_temp.fbo_expect('Monday 09-14', (SELECT string_agg(recipient_group || ' ' || period_start || ' ' || period_end, '; ' ORDER BY recipient_group::text) FROM app.absence_watch_digest_due(school, '2026-09-14')),
    'MENTOR 2026-09-07 2026-09-13; REKTOR 2026-09-07 2026-09-13');
  -- Sunday the 13th: the week is not over, the last whole one ended the 6th, before the switch.
  PERFORM pg_temp.fbo_expect('Sunday 09-13', (SELECT count(*)::text FROM app.absence_watch_digest_due(school, '2026-09-13')), '0');
  -- Tuesday the 15th: still the same week's, until it is written.
  PERFORM pg_temp.fbo_expect('Tuesday 09-15', (SELECT string_agg(recipient_group || ' ' || period_end, '; ' ORDER BY recipient_group::text) FROM app.absence_watch_digest_due(school, '2026-09-15')),
    'MENTOR 2026-09-13; REKTOR 2026-09-13');
  INSERT INTO "AbsenceWatchDigests" ("schoolId", "recipientGroup", "periodStart", "periodEnd", recipients, pupils) VALUES (school, 'MENTOR', '2026-09-07', '2026-09-13', 1, 1);
  PERFORM pg_temp.fbo_expect('written', (SELECT string_agg(recipient_group::text, ';') FROM app.absence_watch_digest_due(school, '2026-09-15')), 'REKTOR');
  PERFORM pg_temp.fbo_expect('next Monday', (SELECT string_agg(recipient_group || ' ' || period_start || ' ' || period_end, '; ' ORDER BY recipient_group::text) FROM app.absence_watch_digest_due(school, '2026-09-21')),
    'MENTOR 2026-09-14 2026-09-20; REKTOR 2026-09-14 2026-09-20');
  -- The month: the first of October asks for September, for the guardians, and the middle of October for the same.
  PERFORM pg_temp.fbo_expect('1 Oct', (SELECT string_agg(recipient_group || ' ' || period_start || ' ' || period_end, '; ' ORDER BY recipient_group::text) FROM app.absence_watch_digest_due(school, '2026-10-01') WHERE recipient_group = 'GUARDIAN'),
    'GUARDIAN 2026-09-01 2026-09-30');
  PERFORM pg_temp.fbo_expect('15 Oct', (SELECT string_agg(recipient_group || ' ' || period_start || ' ' || period_end, '; ') FROM app.absence_watch_digest_due(school, '2026-10-15') WHERE recipient_group = 'GUARDIAN'),
    'GUARDIAN 2026-09-01 2026-09-30');
  -- The last day of the month asks for the month before: the month has not ended.
  PERFORM pg_temp.fbo_expect('30 Sep', (SELECT count(*)::text FROM app.absence_watch_digest_due(school, '2026-09-30') WHERE recipient_group = 'GUARDIAN'), '0');
  -- Kansli has no limit: never due, whatever the day.
  PERFORM pg_temp.fbo_expect('kansli', (SELECT count(*)::text FROM app.absence_watch_digest_due(school, '2026-10-15') WHERE recipient_group = 'KANSLI'), '0');
  -- A limit gives the group a digest.
  INSERT INTO "AbsenceWatchLimits" ("schoolId", "recipientGroup", kind, basis, "consecutiveDays") VALUES (school, 'KANSLI', 'CONSECUTIVE', 'ALL', 3);
  PERFORM pg_temp.fbo_expect('kansli with a limit', (SELECT period_start || ' ' || period_end FROM app.absence_watch_digest_due(school, '2026-10-15') WHERE recipient_group = 'KANSLI'), '2026-09-01 2026-09-30');
  -- The switch on the 13th, a Sunday: the week of the 7th to the 13th ended that day and is due; on the 14th as well.
  UPDATE "AbsenceWatchSettings" SET "enabledOn" = '2026-09-13';
  DELETE FROM "AbsenceWatchDigests";
  PERFORM pg_temp.fbo_expect('switch on the Sunday', (SELECT count(*)::text FROM app.absence_watch_digest_due(school, '2026-09-14') WHERE recipient_group IN ('MENTOR', 'REKTOR')), '2');
  UPDATE "AbsenceWatchSettings" SET "enabledOn" = '2026-09-14';
  PERFORM pg_temp.fbo_expect('switch on the Monday', (SELECT count(*)::text FROM app.absence_watch_digest_due(school, '2026-09-14')), '0');
  PERFORM pg_temp.fbo_expect('switch on the Monday, a week on', (SELECT period_start || ' ' || period_end FROM app.absence_watch_digest_due(school, '2026-09-21') WHERE recipient_group = 'MENTOR'), '2026-09-14 2026-09-20');
  -- A week over the new year, and the months over it and over a leap day.
  UPDATE "AbsenceWatchSettings" SET "enabledOn" = '2025-01-01', "guardianCadence" = 'MONTHLY';
  PERFORM pg_temp.fbo_expect('new year week', (SELECT period_start || ' ' || period_end FROM app.absence_watch_digest_due(school, '2026-01-05') WHERE recipient_group = 'MENTOR'), '2025-12-29 2026-01-04');
  PERFORM pg_temp.fbo_expect('new year month', (SELECT period_start || ' ' || period_end FROM app.absence_watch_digest_due(school, '2026-01-01') WHERE recipient_group = 'GUARDIAN'), '2025-12-01 2025-12-31');
  PERFORM pg_temp.fbo_expect('february', (SELECT period_start || ' ' || period_end FROM app.absence_watch_digest_due(school, '2026-03-01') WHERE recipient_group = 'GUARDIAN'), '2026-02-01 2026-02-28');
  PERFORM pg_temp.fbo_expect('leap february', (SELECT period_start || ' ' || period_end FROM app.absence_watch_digest_due(school, '2028-03-01') WHERE recipient_group = 'GUARDIAN'), '2028-02-01 2028-02-29');
  -- The weeks of the summer-time switches are seven calendar days all the same.
  PERFORM pg_temp.fbo_expect('spring week', (SELECT period_start || ' ' || period_end FROM app.absence_watch_digest_due(school, '2026-03-30') WHERE recipient_group = 'MENTOR'), '2026-03-23 2026-03-29');
  PERFORM pg_temp.fbo_expect('fall week', (SELECT period_start || ' ' || period_end FROM app.absence_watch_digest_due(school, '2026-10-26') WHERE recipient_group = 'MENTOR'), '2026-10-19 2026-10-25');
  -- Off: nothing is due, and the school is not on the job's list.
  PERFORM pg_temp.fbo_expect('listed', (SELECT count(*)::text FROM app.absence_watch_schools() s WHERE s = school), '1');
  UPDATE "AbsenceWatchSettings" SET enabled = false;
  PERFORM pg_temp.fbo_expect('off', (SELECT count(*)::text FROM app.absence_watch_digest_due(school, '2026-10-15')), '0');
  PERFORM pg_temp.fbo_expect('not listed', (SELECT count(*)::text FROM app.absence_watch_schools() s WHERE s = school), '0');
END $$;
ROLLBACK;

-- 309o: gallring. The findings go with the attendance they are counted from:
-- under ATTENDANCE, by the day they were last seen, in the same batch.
BEGIN;
DO $$
DECLARE
  school uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-franvarobevakning-school');
  other uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-franvarobevakning-annan');
  admin uuid := (SELECT id FROM "Users" WHERE "schoolId" = school AND email = 'fb-full@example.invalid');
  p1 uuid := (SELECT id FROM "Users" WHERE "schoolId" = school AND email = 'fb-p1@example.invalid');
  p3 uuid := (SELECT id FROM "Users" WHERE "schoolId" = school AND email = 'fb-p3@example.invalid');
  po uuid := (SELECT id FROM "Users" WHERE "schoolId" = other AND email = 'fb-annan-p@example.invalid');
  today date := (now() AT TIME ZONE 'Europe/Stockholm')::date;
  run uuid;
  n integer;
  counts jsonb;
  tbls text[];
BEGIN
  -- Findings last seen at three ages, here and at the school with no decision.
  INSERT INTO "AbsenceWatchFindings" ("schoolId", "studentId", "limitId", "recipientGroup", kind, basis, percent, "windowDays", "firstCrossedOn", "lastSeenOn", "clearedOn", "absentMinutes", "recordedMinutes") VALUES
    (school, p1, gen_random_uuid(), 'MENTOR', 'SHARE', 'ALL', 10, 14, today - 900, today - 890, today - 889, 60, 600),
    (school, p3, gen_random_uuid(), 'MENTOR', 'SHARE', 'ALL', 10, 14, today - 400, today - 395, today - 394, 60, 600),
    (school, p1, gen_random_uuid(), 'GUARDIAN', 'SHARE', 'ALL', 10, 14, today - 40, today - 30, NULL, 60, 600),
    (other, po, gen_random_uuid(), 'MENTOR', 'SHARE', 'ALL', 10, 14, today - 900, today - 890, today - 889, 60, 600);
  ALTER TABLE "RetentionDecisions" DISABLE TRIGGER "RetentionDecisions_stamped";
  INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision, months, reference, "decidedById", "decidedAt")
  VALUES (school, 'ATTENDANCE', 'PURGE_AFTER', 12, 'AW 309', admin, now() - interval '2 days');
  ALTER TABLE "RetentionDecisions" ENABLE TRIGGER "RetentionDecisions_stamped";

  -- What is due, as the one predicate answers it: the two old findings of this school and nothing of the other's.
  SELECT array_agg(DISTINCT d.tbl) INTO tbls FROM app.gallring_due(school, 'ATTENDANCE', today - 365, today) d;
  IF tbls IS DISTINCT FROM ARRAY['AbsenceWatchFindings'] THEN
    RAISE EXCEPTION 'frånvarobevakning 309o: the kinds due are % (the school''s attendance was planted by no one here)', tbls;
  END IF;
  IF (SELECT count(*) FROM app.gallring_due(school, 'ATTENDANCE', today - 365, today) d WHERE d.tbl = 'AbsenceWatchFindings') <> 2 THEN
    RAISE EXCEPTION 'frånvarobevakning 309o: not the two findings last seen before the cutoff are due';
  END IF;
  IF EXISTS (SELECT 1 FROM app.gallring_due(school, 'ABSENCE_REPORTS', today - 365, today) d WHERE d.tbl = 'AbsenceWatchFindings')
     OR EXISTS (SELECT 1 FROM app.gallring_due(school, 'NOTIFICATIONS', today - 365, today) d WHERE d.tbl = 'AbsenceWatchFindings') THEN
    RAISE EXCEPTION 'frånvarobevakning 309o: the findings are due under another kind than ATTENDANCE';
  END IF;
  IF EXISTS (SELECT 1 FROM app.gallring_due(other, 'ATTENDANCE', today - 365, today) d WHERE d.tbl = 'AbsenceWatchFindings'
              AND d.id IN (SELECT id FROM "AbsenceWatchFindings" WHERE "schoolId" = school)) THEN
    RAISE EXCEPTION 'frånvarobevakning 309o: a school''s findings are due under another school''s run';
  END IF;

  -- The night: the old ones go, the one seen thirty days ago stays, the other school's stay.
  run := app.gallring_begin(school, now());
  LOOP
    n := app.gallring_purge(run, 'ATTENDANCE', 1);
    EXIT WHEN n = 0;
  END LOOP;
  PERFORM app.gallring_finish(run, '{}', now());
  IF (SELECT count(*) FROM "AbsenceWatchFindings" WHERE "schoolId" = school) <> 1
     OR NOT EXISTS (SELECT 1 FROM "AbsenceWatchFindings" WHERE "schoolId" = school AND "recipientGroup" = 'GUARDIAN') THEN
    RAISE EXCEPTION 'frånvarobevakning 309o: gallring left % findings of the school, not the one seen 30 days ago', (SELECT count(*) FROM "AbsenceWatchFindings" WHERE "schoolId" = school);
  END IF;
  IF (SELECT count(*) FROM "AbsenceWatchFindings" WHERE "schoolId" = other) <> 1 THEN
    RAISE EXCEPTION 'frånvarobevakning 309o: a school with no decision lost its findings';
  END IF;
  SELECT g.counts INTO counts FROM "GallringRuns" g WHERE g.id = run;
  IF (counts ->> 'ATTENDANCE')::integer <> 2 THEN
    RAISE EXCEPTION 'frånvarobevakning 309o: the run counts % rows under ATTENDANCE, not the two findings', counts ->> 'ATTENDANCE';
  END IF;

  -- The batch is shared with the attendance: with a budget of one the run is not complete until nothing is left.
  INSERT INTO "AbsenceWatchFindings" ("schoolId", "studentId", "limitId", "recipientGroup", kind, basis, percent, "windowDays", "firstCrossedOn", "lastSeenOn", "clearedOn", "absentMinutes", "recordedMinutes") VALUES
    (school, p1, gen_random_uuid(), 'MENTOR', 'SHARE', 'ALL', 10, 14, today - 800, today - 790, today - 789, 60, 600),
    (school, p3, gen_random_uuid(), 'MENTOR', 'SHARE', 'ALL', 10, 14, today - 800, today - 790, today - 789, 60, 600);
  run := app.gallring_begin(school, now());
  IF app.gallring_purge(run, 'ATTENDANCE', 1) <> 1 THEN RAISE EXCEPTION 'frånvarobevakning 309o: a batch of one took more or less than one finding'; END IF;
  IF (SELECT (complete ->> 'ATTENDANCE')::boolean FROM "GallringRuns" WHERE id = run) THEN
    RAISE EXCEPTION 'frånvarobevakning 309o: a full batch said nothing was left';
  END IF;
  IF app.gallring_purge(run, 'ATTENDANCE', 1) <> 1 OR app.gallring_purge(run, 'ATTENDANCE', 1) <> 0 THEN
    RAISE EXCEPTION 'frånvarobevakning 309o: the second finding was not taken in the next batch';
  END IF;
  PERFORM app.gallring_finish(run, '{}', now());

  -- KEEP stops it at once.
  ALTER TABLE "RetentionDecisions" DISABLE TRIGGER "RetentionDecisions_stamped";
  INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision, reference, "decidedById", "decidedAt")
  VALUES (school, 'ATTENDANCE', 'KEEP', 'AW 309 keep', admin, now() - interval '1 hour');
  ALTER TABLE "RetentionDecisions" ENABLE TRIGGER "RetentionDecisions_stamped";
  INSERT INTO "AbsenceWatchFindings" ("schoolId", "studentId", "limitId", "recipientGroup", kind, basis, percent, "windowDays", "firstCrossedOn", "lastSeenOn", "clearedOn", "absentMinutes", "recordedMinutes")
  VALUES (school, p1, gen_random_uuid(), 'MENTOR', 'SHARE', 'ALL', 10, 14, today - 800, today - 790, today - 789, 60, 600);
  run := app.gallring_begin(school, now());
  IF app.gallring_purge(run, 'ATTENDANCE', 100) <> 0 THEN RAISE EXCEPTION 'frånvarobevakning 309o: a school that keeps its attendance lost a finding'; END IF;
  PERFORM app.gallring_finish(run, '{}', now());
END $$;
ROLLBACK;

-- 306o: the mentor rule is the leave decision's, for every pupil of the school: the
-- list a digest is built from and the one question the policy asks give the same mentors.
BEGIN;
DO $$
DECLARE
  school uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-franvarobevakning-school');
  today date := (now() AT TIME ZONE 'Europe/Stockholm')::date;
  pupil uuid;
  mine uuid[];
  theirs uuid[];
  seen integer := 0;
BEGIN
  FOR pupil IN SELECT id FROM "Users" WHERE "schoolId" = school AND role = 'STUDENT' LOOP
    mine := ARRAY(SELECT mentor_id FROM app.absence_watch_mentees(school, today) WHERE student_id = pupil ORDER BY 1);
    theirs := ARRAY(SELECT DISTINCT m FROM app.leave_mentors(school, pupil, today, today) m ORDER BY 1);
    IF mine IS DISTINCT FROM theirs THEN
      RAISE EXCEPTION 'frånvarobevakning 306o: the mentors of % are % by the digest''s rule and % by the leave decision''s', pupil, mine, theirs;
    END IF;
    seen := seen + cardinality(mine);
  END LOOP;
  IF seen <> 4 THEN RAISE EXCEPTION 'frånvarobevakning 306o: % mentor links in the school, not the four of its active pupils', seen; END IF;
  -- A duty that has ended, or has not begun, mentors nobody; a duty of the other school's year is not this school's.
  UPDATE "TeacherDuties" SET "validTo" = today - 1 WHERE "schoolId" = school AND label = 'Mentor 7A';
  IF EXISTS (SELECT 1 FROM app.absence_watch_mentees(school, today) m JOIN "Users" u ON u.id = m.mentor_id WHERE u.email = 'fb-m1@example.invalid') THEN
    RAISE EXCEPTION 'frånvarobevakning 306o: a duty that ended yesterday still mentors';
  END IF;
  UPDATE "TeacherDuties" SET "validTo" = NULL, "validFrom" = today + 1 WHERE "schoolId" = school AND label = 'Mentor 7A';
  IF EXISTS (SELECT 1 FROM app.absence_watch_mentees(school, today) m JOIN "Users" u ON u.id = m.mentor_id WHERE u.email = 'fb-m1@example.invalid') THEN
    RAISE EXCEPTION 'frånvarobevakning 306o: a duty that begins tomorrow already mentors';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.absence_watch_mentees(school, today + 1) m JOIN "Users" u ON u.id = m.mentor_id WHERE u.email = 'fb-m1@example.invalid') THEN
    RAISE EXCEPTION 'frånvarobevakning 306o: a duty that begins tomorrow does not mentor tomorrow';
  END IF;
  -- The deactivated teacher who once mentored 7A is no mentor.
  IF EXISTS (SELECT 1 FROM app.absence_watch_mentees(school, today) m JOIN "Users" u ON u.id = m.mentor_id WHERE u.email = 'fb-t4@example.invalid') THEN
    RAISE EXCEPTION 'frånvarobevakning 306o: a deactivated teacher mentors';
  END IF;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Sections 345-349 on the owner's side: Rapporteringsgrad (20270112090100).
--
-- What rls-policies.sql cannot ask: the tables' own constraints (no role
-- writes the days, the ledgers or the dates), the definition's edges that
-- only the owner may call, the reminders over a switch dated back, which weeks
-- are due, and gallring's reach over the days and the reminders.
-- ---------------------------------------------------------------------------

CREATE FUNCTION pg_temp.rgo_refuses(p_sql text, p_constraint text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RAISE EXCEPTION 'rapporteringsgrad: accepted: %', p_sql;
EXCEPTION WHEN check_violation OR unique_violation OR foreign_key_violation THEN
  IF position(p_constraint IN SQLERRM) = 0 THEN
    RAISE EXCEPTION 'rapporteringsgrad: % was refused, but not by %: %', p_sql, p_constraint, SQLERRM;
  END IF;
END $$;
CREATE FUNCTION pg_temp.rgo_expect(p_label text, p_got text, p_want text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_want THEN
    RAISE EXCEPTION E'rapporteringsgrad %: got\n%\nwanted\n%', p_label, p_got, p_want;
  END IF;
END $$;

-- A lesson of the school, as the policy side's rg_lesson plants it (the owner has no principal to name the school).
CREATE FUNCTION pg_temp.rgo_lesson(p_school uuid, p_day date, p_hour integer, p_teachers uuid[] DEFAULT '{}', p_marks text[] DEFAULT '{}',
                                   p_status "LessonStatus" DEFAULT 'SCHEDULED', p_group text DEFAULT 'RG7A', p_extra text[] DEFAULT '{}')
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  l uuid;
  starts timestamptz := (p_day + make_time(p_hour, 0, 0)) AT TIME ZONE 'Europe/Stockholm';
  i integer;
  subj uuid := (SELECT id FROM "Subjects" WHERE "schoolId" = p_school AND code = 'RGSUBJ');
  grp uuid := (SELECT id FROM "StudentGroups" WHERE "schoolId" = p_school AND name = p_group);
  pupils uuid[] := ARRAY(SELECT id FROM "Users" WHERE "schoolId" = p_school AND role = 'STUDENT' ORDER BY email);
BEGIN
  INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", status, "updatedAt")
  VALUES (p_school, subj, grp, p_day, starts, starts + interval '50 minutes', p_status, now()) RETURNING id INTO l;
  FOR i IN 1..coalesce(cardinality(p_teachers), 0) LOOP
    INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role) VALUES (p_school, l, p_teachers[i], 'LEAD');
  END LOOP;
  INSERT INTO "CalendarLessonGroups" ("schoolId", "calendarLessonId", "studentGroupId")
  SELECT p_school, l, g."id" FROM "StudentGroups" g WHERE g."schoolId" = p_school AND g."name" = ANY (p_extra);
  FOR i IN 1..coalesce(cardinality(p_marks), 0) LOOP
    INSERT INTO "AttendanceRecords" ("schoolId", "calendarLessonId", "studentId", status, "updatedAt") VALUES (p_school, l, pupils[i], p_marks[i]::"AttendanceStatus", now());
  END LOOP;
  RETURN l;
END $$;

-- What the reminders told, as 'xx count/limit', one per teacher, in the order of their addresses.
CREATE FUNCTION pg_temp.rgo_reminded(p_school uuid, p_today date) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(substr(r.email, 4, 2) || ' ' || (r.meta ->> 'count') || '/' || (r.meta ->> 'limitDays'), ', ' ORDER BY r.email), '')
    FROM app.reporting_remind(p_school, p_today) r
$$;

-- 345o: the tables' constraints, the keys, the indexes, the privileges and the functions.
BEGIN;
DO $$
DECLARE
  school uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-rapporteringsgrad-school');
  other uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-rapporteringsgrad-annan');
  t1 uuid := (SELECT id FROM "Users" WHERE "schoolId" = school AND email = 'rg-t1@example.invalid');
  t_other uuid := (SELECT id FROM "Users" WHERE "schoolId" = other AND email = 'rg-annan-t@example.invalid');
  lesson uuid := gen_random_uuid();
  leaving uuid;
  bad text;
  fk record;
BEGIN
  -- A day is a held lesson or more, and reported never exceeds held.
  PERFORM pg_temp.rgo_refuses(format('INSERT INTO "TeacherReportingDays" ("schoolId", "teacherId", day, held, reported) VALUES (%L, %L, ''2026-01-05'', 0, 0)', school, t1), 'counts_are_counts');
  PERFORM pg_temp.rgo_refuses(format('INSERT INTO "TeacherReportingDays" ("schoolId", "teacherId", day, held, reported) VALUES (%L, %L, ''2026-01-05'', 3, 4)', school, t1), 'counts_are_counts');
  PERFORM pg_temp.rgo_refuses(format('INSERT INTO "TeacherReportingDays" ("schoolId", "teacherId", day, held, reported) VALUES (%L, %L, ''2026-01-05'', 3, -1)', school, t1), 'counts_are_counts');
  INSERT INTO "TeacherReportingDays" ("schoolId", "teacherId", day, held, reported) VALUES (school, t1, '2026-01-05', 3, 3), (school, t1, '2026-01-06', 1, 0);
  -- One row per teacher and day.
  PERFORM pg_temp.rgo_refuses(format('INSERT INTO "TeacherReportingDays" ("schoolId", "teacherId", day, held, reported) VALUES (%L, %L, ''2026-01-05'', 1, 1)', school, t1), 'teacherId_schoolId_day_key');
  -- A teacher of another school is no teacher of this one's days, nor of its reminders.
  PERFORM pg_temp.rgo_refuses(format('INSERT INTO "TeacherReportingDays" ("schoolId", "teacherId", day, held, reported) VALUES (%L, %L, ''2026-01-05'', 1, 1)', school, t_other), 'TeacherReportingDays_teacherId_schoolId_fkey');
  PERFORM pg_temp.rgo_refuses(format('INSERT INTO "ReportingReminders" ("schoolId", "teacherId", "calendarLessonId", "lessonDate") VALUES (%L, %L, %L, ''2026-01-05'')', school, t_other, lesson), 'ReportingReminders_teacherId_schoolId_fkey');
  -- A lesson is reminded of once for a teacher, and another teacher is another reminder.
  INSERT INTO "ReportingReminders" ("schoolId", "teacherId", "calendarLessonId", "lessonDate") VALUES (school, t1, lesson, '2026-01-05');
  PERFORM pg_temp.rgo_refuses(format('INSERT INTO "ReportingReminders" ("schoolId", "teacherId", "calendarLessonId", "lessonDate") VALUES (%L, %L, %L, ''2026-01-06'')', school, t1, lesson), 'ReportingReminders_lesson_teacher_key');
  -- The week's ledger: ordered, with counts that are counts, one row per school and week end.
  PERFORM pg_temp.rgo_refuses(format('INSERT INTO "ReportingDigests" ("schoolId", "periodStart", "periodEnd", recipients, teachers, held, reported) VALUES (%L, ''2026-01-12'', ''2026-01-11'', 1, 1, 1, 1)', school), 'period_is_ordered');
  PERFORM pg_temp.rgo_refuses(format('INSERT INTO "ReportingDigests" ("schoolId", "periodStart", "periodEnd", recipients, teachers, held, reported) VALUES (%L, ''2026-01-05'', ''2026-01-11'', 1, 1, 3, 4)', school), 'counts_are_counts');
  PERFORM pg_temp.rgo_refuses(format('INSERT INTO "ReportingDigests" ("schoolId", "periodStart", "periodEnd", recipients, teachers, held, reported) VALUES (%L, ''2026-01-05'', ''2026-01-11'', -1, 1, 3, 3)', school), 'counts_are_counts');
  INSERT INTO "ReportingDigests" ("schoolId", "periodStart", "periodEnd", recipients, teachers, held, reported) VALUES (school, '2026-01-05', '2026-01-11', 1, 1, 3, 3);
  PERFORM pg_temp.rgo_refuses(format('INSERT INTO "ReportingDigests" ("schoolId", "periodStart", "periodEnd", recipients, teachers, held, reported) VALUES (%L, ''2026-01-05'', ''2026-01-11'', 1, 1, 3, 3)', school), 'ReportingDigests_pkey');

  -- The settings: a switch that is on has a date, which the trigger writes even for the owner, and the
  -- limit has its range. With the trigger held off an on-switch without a date is the table's refusal.
  DELETE FROM "ReportingSettings" WHERE "schoolId" = school;
  INSERT INTO "ReportingSettings" ("schoolId", "teacherReminders", "rektorDigest") VALUES (school, true, true);
  IF (SELECT "teacherRemindersOn" FROM "ReportingSettings" WHERE "schoolId" = school) IS DISTINCT FROM (now() AT TIME ZONE 'Europe/Stockholm')::date
     OR (SELECT "rektorDigestOn" FROM "ReportingSettings" WHERE "schoolId" = school) IS DISTINCT FROM (now() AT TIME ZONE 'Europe/Stockholm')::date THEN
    RAISE EXCEPTION 'rapporteringsgrad 345o: a row inserted with both on was not dated at once';
  END IF;
  DELETE FROM "ReportingSettings" WHERE "schoolId" = school;
  SET LOCAL session_replication_role = replica;
  PERFORM pg_temp.rgo_refuses(format('INSERT INTO "ReportingSettings" ("schoolId", "teacherReminders") VALUES (%L, true)', school), 'on_has_a_date');
  PERFORM pg_temp.rgo_refuses(format('INSERT INTO "ReportingSettings" ("schoolId", "rektorDigest") VALUES (%L, true)', school), 'on_has_a_date');
  PERFORM pg_temp.rgo_refuses(format('INSERT INTO "ReportingSettings" ("schoolId", "openAfterDays") VALUES (%L, 0)', school), 'open_after_days_is_sane');
  PERFORM pg_temp.rgo_refuses(format('INSERT INTO "ReportingSettings" ("schoolId", "openAfterDays") VALUES (%L, 31)', school), 'open_after_days_is_sane');
  SET LOCAL session_replication_role = origin;

  -- Removing a person takes their days and their reminders with them: the keys' indexes serve the cascade.
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (school, 'rg-leaving@example.invalid', 'Rapportering', 'Lämnar', 'TEACHER', gen_random_uuid(), true, now()) RETURNING id INTO leaving;
  INSERT INTO "TeacherReportingDays" ("schoolId", "teacherId", day, held, reported) VALUES (school, leaving, '2026-01-05', 2, 1);
  INSERT INTO "ReportingReminders" ("schoolId", "teacherId", "calendarLessonId", "lessonDate") VALUES (school, leaving, gen_random_uuid(), '2026-01-05');
  DELETE FROM "Users" WHERE id = leaving;
  IF EXISTS (SELECT 1 FROM "TeacherReportingDays" WHERE "teacherId" = leaving) OR EXISTS (SELECT 1 FROM "ReportingReminders" WHERE "teacherId" = leaving) THEN
    RAISE EXCEPTION 'rapporteringsgrad 345o: a removed person left a day or a reminder';
  END IF;

  -- Every foreign key of the three tables has an index that starts with its columns (the FK index audit).
  FOR fk IN
    SELECT c.conname, c.conrelid::regclass::text AS tbl
      FROM pg_constraint c
     WHERE c.contype = 'f' AND c.conrelid::regclass::text IN ('"TeacherReportingDays"', '"ReportingReminders"', '"ReportingDigests"', '"ReportingSettings"')
       AND NOT EXISTS (
             SELECT 1 FROM pg_index i
              WHERE i.indrelid = c.conrelid AND i.indisvalid
                AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] = c.conkey)
  LOOP
    RAISE EXCEPTION 'rapporteringsgrad 345o: % on % has no index that starts with its columns', fk.conname, fk.tbl;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
              WHERE c.relname IN ('TeacherReportingDays', 'ReportingReminders', 'ReportingDigests', 'ReportingSettings') AND NOT i.indisvalid) THEN
    RAISE EXCEPTION 'rapporteringsgrad 345o: an index is invalid';
  END IF;

  -- Row security is on for all four, and the settings keep their trigger.
  SELECT string_agg(c.relname, ', ') INTO bad FROM pg_class c
   WHERE c.relname IN ('TeacherReportingDays', 'ReportingReminders', 'ReportingDigests', 'ReportingSettings') AND NOT c.relrowsecurity;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'rapporteringsgrad 345o: row security is off for %', bad; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'ReportingSettings_stamp' AND tgrelid = '"ReportingSettings"'::regclass AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'rapporteringsgrad 345o: the settings'' trigger is missing or off';
  END IF;

  -- The definers pin their search path, and the definition is not a definer at all (it runs as its caller, the owner).
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO bad FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app' AND p.proname LIKE 'reporting\_%' AND p.proname <> 'reporting_lessons'
     AND (NOT p.prosecdef OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'));
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'rapporteringsgrad 345o: not a definer with a pinned search path: %', bad; END IF;
  IF (SELECT prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' AND p.proname = 'reporting_lessons') THEN
    RAISE EXCEPTION 'rapporteringsgrad 345o: the definition is a definer, and so hands its rows to whoever may run it';
  END IF;

  -- PostgreSQL 17's MAINTAIN (REINDEX, CLUSTER, VACUUM, LOCK): the owner's alone.
  IF current_setting('server_version_num')::int >= 170000 THEN
    SELECT string_agg(r.rolname || ' on ' || t.t, ', ') INTO bad
      FROM pg_roles r, (VALUES ('TeacherReportingDays'), ('ReportingReminders'), ('ReportingDigests'), ('ReportingSettings')) t(t)
     WHERE r.rolname IN ('authenticated', 'app_authenticated', 'service_role', 'anon')
       AND has_table_privilege(r.rolname, format('public.%I', t.t), 'MAINTAIN');
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'rapporteringsgrad 345o: MAINTAIN is held by %', bad; END IF;
  END IF;
END $$;
ROLLBACK;

-- 346o: the definition's edges that only the owner may ask.
BEGIN;
DO $$
DECLARE
  school uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-rapporteringsgrad-school');
  other uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-rapporteringsgrad-annan');
  admin uuid := (SELECT id FROM "Users" WHERE "schoolId" = school AND email = 'rg-full@example.invalid');
  t1 uuid := (SELECT id FROM "Users" WHERE "schoolId" = school AND email = 'rg-t1@example.invalid');
  t2 uuid := (SELECT id FROM "Users" WHERE "schoolId" = school AND email = 'rg-t2@example.invalid');
  t_other uuid := (SELECT id FROM "Users" WHERE "schoolId" = other AND email = 'rg-annan-t@example.invalid');
  today date := (now() AT TIME ZONE 'Europe/Stockholm')::date;
  l uuid;
  starts timestamptz;
  cutoff date;
  n integer;
  got text;
BEGIN
  -- A lesson counts when it has ended: at its end, not a second before.
  l := pg_temp.rgo_lesson(school, '2026-09-15', 8, ARRAY[t1]);
  starts := ('2026-09-15 08:00')::timestamp AT TIME ZONE 'Europe/Stockholm';
  PERFORM pg_temp.rgo_expect('346o not ended', (SELECT count(*)::text FROM app.reporting_lessons(school, '2026-09-15', '2026-09-15', starts + interval '49 minutes 59 seconds')), '0');
  PERFORM pg_temp.rgo_expect('346o ended', (SELECT count(*)::text FROM app.reporting_lessons(school, '2026-09-15', '2026-09-15', starts + interval '50 minutes')), '1');
  PERFORM pg_temp.rgo_expect('346o not on the day', (SELECT count(*)::text FROM app.reporting_lessons(school, '2026-09-16', '2026-09-30', now())), '0');
  PERFORM pg_temp.rgo_expect('346o the other school', (SELECT count(*)::text FROM app.reporting_lessons(other, '2026-09-15', '2026-09-15', now())), '0');
  PERFORM pg_temp.rgo_expect('346o what a row says', (SELECT reported::text FROM app.reporting_lessons(school, '2026-09-15', '2026-09-15', now())), 'false');

  -- (A teacher of another school on a lesson of this one, and a row filed under another school's id for a teacher
  -- of this school, were once planted here to prove that the lesson's own school decides; the keys to the lesson
  -- and to the teacher are composite since 20270115090000, the database refuses both rows, and section 330 proves it.)
  PERFORM pg_temp.rgo_expect('346o the lesson', (SELECT string_agg(teacher_id::text, ',' ORDER BY teacher_id) FROM app.reporting_lessons(school, '2026-09-15', '2026-09-15', now())), t1::text);
  PERFORM app.reporting_compute(school, '2026-09-30');
  PERFORM pg_temp.rgo_expect('346o the days', (SELECT string_agg(day || ' ' || reported || '/' || held, ', ') FROM "TeacherReportingDays" WHERE "schoolId" = school), '2026-09-15 0/1');

  -- The window is 90 days up to and including the day asked for: a day inside it with no lesson is removed,
  -- one before it is final and stays as it was.
  INSERT INTO "TeacherReportingDays" ("schoolId", "teacherId", day, held, reported) VALUES
    (school, t2, '2026-07-02', 5, 5), (school, t2, '2026-07-03', 5, 5);
  PERFORM pg_temp.rgo_expect('346o window', (SELECT written || '/' || removed FROM app.reporting_compute(school, '2026-09-30')), '0/1');
  PERFORM pg_temp.rgo_expect('346o final', (SELECT string_agg(day::text, ',' ORDER BY day) FROM "TeacherReportingDays" WHERE "teacherId" = t2), '2026-07-02');

  -- A school that purges attendance: the count leaves the days before the cutoff of the shortest period it has
  -- chosen as they are, whatever the lessons of those days look like now, and counts the days from the cutoff
  -- on. Without a decision it counts them all again.
  cutoff := (today - interval '2 months')::date;
  DELETE FROM "TeacherReportingDays" WHERE "schoolId" = school;
  DELETE FROM "CalendarLessons" WHERE "schoolId" = school AND date >= '2026-09-01';
  INSERT INTO "TeacherReportingDays" ("schoolId", "teacherId", day, held, reported) VALUES (school, t1, cutoff - 10, 1, 1);
  PERFORM pg_temp.rgo_lesson(school, cutoff - 10, 8, ARRAY[t1]);       -- its register is long gone
  PERFORM pg_temp.rgo_lesson(school, cutoff + 1, 8, ARRAY[t1]);        -- inside what is kept
  PERFORM pg_temp.rgo_expect('346o without a decision', (SELECT written || '/' || removed FROM app.reporting_compute(school, today - 1)), '2/0');
  PERFORM pg_temp.rgo_expect('346o without a decision, the old day', (SELECT reported || '/' || held FROM "TeacherReportingDays" WHERE day = cutoff - 10), '0/1');
  UPDATE "TeacherReportingDays" SET held = 1, reported = 1 WHERE day = cutoff - 10;
  DELETE FROM "TeacherReportingDays" WHERE day = cutoff + 1;
  ALTER TABLE "RetentionDecisions" DISABLE TRIGGER "RetentionDecisions_stamped";
  INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision, months, reference, "decidedById", "decidedAt")
  VALUES (school, 'ATTENDANCE', 'PURGE_AFTER', 2, 'RG 346', admin, now() - interval '2 days');
  ALTER TABLE "RetentionDecisions" ENABLE TRIGGER "RetentionDecisions_stamped";
  PERFORM pg_temp.rgo_expect('346o with a decision', (SELECT written || '/' || removed FROM app.reporting_compute(school, today - 1)), '1/0');
  PERFORM pg_temp.rgo_expect('346o with a decision, the old day', (SELECT reported || '/' || held FROM "TeacherReportingDays" WHERE day = cutoff - 10), '1/1');
  PERFORM pg_temp.rgo_expect('346o with a decision, the kept day', (SELECT reported || '/' || held FROM "TeacherReportingDays" WHERE day = cutoff + 1), '0/1');
  -- A day inside the window with no lesson is still removed under the decision.
  INSERT INTO "TeacherReportingDays" ("schoolId", "teacherId", day, held, reported) VALUES (school, t2, cutoff + 5, 2, 2);
  PERFORM pg_temp.rgo_expect('346o with a decision, a day with no lesson', (SELECT written || '/' || removed FROM app.reporting_compute(school, today - 1)), '0/1');
  -- A decision to keep afterwards does not give the marks back: the days before the cutoff stay as they were.
  ALTER TABLE "RetentionDecisions" DISABLE TRIGGER "RetentionDecisions_stamped";
  INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision, reference, "decidedById", "decidedAt")
  VALUES (school, 'ATTENDANCE', 'KEEP', 'RG 346 keep', admin, now() - interval '1 hour');
  ALTER TABLE "RetentionDecisions" ENABLE TRIGGER "RetentionDecisions_stamped";
  PERFORM pg_temp.rgo_expect('346o keep', (SELECT written || '/' || removed FROM app.reporting_compute(school, today - 1)), '0/0');
END $$;
ROLLBACK;

-- 346o, the class as it was. The class history (StudentEnrollments) says who sat in a class on a lesson's day,
-- as the segment [validFrom, validTo) that holds the date, so a lesson of a class that is empty today still has a
-- roster when pupils sat in it then, to the day. The läsårsaktivering moves every pupil to next year's class
-- (Users.studentGroupId) and empties last year's, and a lesson that nobody could mark must not be taken out of
-- days that were already counted because of it. The history is written by a trigger and guarded against every other
-- writer, so the rows are planted with the triggers held off (session_replication_role), and so is the pupils' move.
BEGIN;
SET LOCAL session_replication_role = replica;
DO $$
DECLARE
  school uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-rapporteringsgrad-school');
  yr uuid := (SELECT id FROM "AcademicYears" WHERE "schoolId" = school);
  t1 uuid := (SELECT id FROM "Users" WHERE "schoolId" = school AND email = 'rg-t1@example.invalid');
  p1 uuid := (SELECT id FROM "Users" WHERE "schoolId" = school AND email = 'rg-p1@example.invalid');
  p2 uuid := (SELECT id FROM "Users" WHERE "schoolId" = school AND email = 'rg-p2@example.invalid');
  gb uuid := (SELECT id FROM "StudentGroups" WHERE "schoolId" = school AND name = 'RG7B');
  n integer;
BEGIN
  -- RG7B has nobody today; p1 sat in it from the 17th of August up to, not including, the 20th of September.
  INSERT INTO "StudentEnrollments" ("schoolId", "studentId", "academicYearId", "studentGroupId", "gradeLevel", "validFrom", "validTo")
  VALUES (school, p1, yr, gb, 7, '2026-08-17', '2026-09-20');
  PERFORM pg_temp.rgo_lesson(school, '2026-08-14', 8, ARRAY[t1], '{}', 'SCHEDULED', 'RG7B');           -- the Friday before: nobody sat there
  PERFORM pg_temp.rgo_lesson(school, '2026-08-17', 8, ARRAY[t1], '{}', 'SCHEDULED', 'RG7B');           -- the first day: they did
  PERFORM pg_temp.rgo_lesson(school, '2026-09-19', 8, ARRAY[t1], '{}', 'SCHEDULED', 'RG7B');           -- the last day: they did
  PERFORM pg_temp.rgo_lesson(school, '2026-09-20', 8, ARRAY[t1], '{}', 'SCHEDULED', 'RG7B');           -- the day the segment ends: not inside it
  PERFORM pg_temp.rgo_expect('346o the class as it was', (SELECT string_agg(day::text, ',' ORDER BY day) FROM app.reporting_lessons(school, '2026-08-01', '2026-09-30', now())), '2026-08-17,2026-09-19');
  -- A class joined to a lesson of another class counts as it was too.
  PERFORM pg_temp.rgo_lesson(school, '2026-09-01', 9, ARRAY[t1], '{}', 'SCHEDULED', 'RG7C', ARRAY['RG7B']);   -- inside
  PERFORM pg_temp.rgo_lesson(school, '2026-09-21', 9, ARRAY[t1], '{}', 'SCHEDULED', 'RG7C', ARRAY['RG7B']);   -- after
  PERFORM pg_temp.rgo_expect('346o a joined class as it was', (SELECT string_agg(day::text, ',' ORDER BY day) FROM app.reporting_lessons(school, '2026-08-01', '2026-09-30', now())), '2026-08-17,2026-09-01,2026-09-19');
  SELECT count(*) INTO n FROM "StudentEnrollments" WHERE "schoolId" = school AND "studentGroupId" = gb;
  IF n <> 1 THEN RAISE EXCEPTION 'rapporteringsgrad 346o: the fixture history of the class is % rows, not 1', n; END IF;
END $$;
ROLLBACK;

-- 346o, the läsårsaktivering: stored days stand still. RG7A's pupils sat in it for the whole year; the activation
-- moves them to a class of the next year and closes their segment at the year's end. The lessons of RG7A, the
-- unregistered one too, are counted as before, and the night writes nothing.
BEGIN;
SET LOCAL session_replication_role = replica;
DO $$
DECLARE
  school uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-rapporteringsgrad-school');
  yr uuid := (SELECT id FROM "AcademicYears" WHERE "schoolId" = school);
  t1 uuid := (SELECT id FROM "Users" WHERE "schoolId" = school AND email = 'rg-t1@example.invalid');
  gb uuid := (SELECT id FROM "StudentGroups" WHERE "schoolId" = school AND name = 'RG7B');
  ga uuid := (SELECT id FROM "StudentGroups" WHERE "schoolId" = school AND name = 'RG7A');
BEGIN
  -- The pupils' open segments begin on the day the fixtures were made; the year's pupils were there from its start.
  UPDATE "StudentEnrollments" SET "validFrom" = '2026-01-01'
   WHERE "schoolId" = school AND "studentGroupId" = ga AND "validTo" IS NULL;
  PERFORM pg_temp.rgo_lesson(school, '2026-09-15', 8, ARRAY[t1], ARRAY['PRESENT', 'PRESENT']);
  PERFORM pg_temp.rgo_lesson(school, '2026-09-15', 9, ARRAY[t1]);
  PERFORM pg_temp.rgo_lesson(school, '2026-09-16', 8, ARRAY[t1]);
  PERFORM pg_temp.rgo_expect('346o before the activation', (SELECT written || '/' || held || '/' || reported FROM app.reporting_compute(school, '2026-09-30')), '2/3/1');

  -- The activation, as the service does it: the pupils move, and the history follows in the same statements.
  UPDATE "StudentEnrollments" SET "validTo" = '2027-01-01' WHERE "schoolId" = school AND "studentGroupId" = ga AND "validTo" IS NULL;
  INSERT INTO "StudentEnrollments" ("schoolId", "studentId", "academicYearId", "studentGroupId", "gradeLevel", "validFrom")
  SELECT school, u."id", yr, gb, 8, '2027-01-01' FROM "Users" u WHERE u."schoolId" = school AND u."studentGroupId" = ga;
  UPDATE "Users" SET "studentGroupId" = gb WHERE "schoolId" = school AND "studentGroupId" = ga;
  IF EXISTS (SELECT 1 FROM "Users" WHERE "schoolId" = school AND "studentGroupId" = ga) THEN
    RAISE EXCEPTION 'rapporteringsgrad 346o: the old class still has pupils, so the activation was not simulated';
  END IF;
  PERFORM pg_temp.rgo_expect('346o after the activation', (SELECT written || '/' || removed || '/' || held || '/' || reported FROM app.reporting_compute(school, '2026-09-30')), '0/0/3/1');

  -- Without the history the unregistered lessons would have gone with the pupils: the stored day moves.
  DELETE FROM "StudentEnrollments" WHERE "schoolId" = school AND "studentGroupId" = ga;
  PERFORM pg_temp.rgo_expect('346o without the history', (SELECT written || '/' || removed || '/' || held || '/' || reported FROM app.reporting_compute(school, '2026-09-30')), '1/1/1/1');
END $$;
ROLLBACK;

-- 348o: the reminders over a switch dated back, to the day. The date the switch went on is the trigger's, so
-- the trigger is held off (session_replication_role) and the owner writes it. A lesson is open past the limit
-- when its day is the limit's number of days back or more; the school's day is what is passed in.
BEGIN;
SET LOCAL session_replication_role = replica;
DO $$
DECLARE
  school uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-rapporteringsgrad-school');
  t1 uuid := (SELECT id FROM "Users" WHERE "schoolId" = school AND email = 'rg-t1@example.invalid');
  t2 uuid := (SELECT id FROM "Users" WHERE "schoolId" = school AND email = 'rg-t2@example.invalid');
  t3 uuid := (SELECT id FROM "Users" WHERE "schoolId" = school AND email = 'rg-t3@example.invalid');
  t4 uuid := (SELECT id FROM "Users" WHERE "schoolId" = school AND email = 'rg-t4@example.invalid');
  got text;
BEGIN
  INSERT INTO "ReportingSettings" ("schoolId", "teacherReminders", "teacherRemindersOn", "rektorDigest", "rektorDigestOn", "openAfterDays")
  VALUES (school, true, '2026-09-01', true, '2026-09-10', 2);
  PERFORM pg_temp.rgo_lesson(school, '2026-09-14', 8, ARRAY[t1]);                          -- Monday, open
  PERFORM pg_temp.rgo_lesson(school, '2026-09-15', 8, ARRAY[t1]);                          -- Tuesday, open
  PERFORM pg_temp.rgo_lesson(school, '2026-09-16', 8, ARRAY[t1], ARRAY['PRESENT']);        -- Wednesday, saved
  PERFORM pg_temp.rgo_lesson(school, '2026-09-15', 9, ARRAY[t2]);                          -- Tuesday, T2's
  PERFORM pg_temp.rgo_lesson(school, '2026-08-20', 8, ARRAY[t1]);                          -- before the switch went on
  PERFORM pg_temp.rgo_lesson(school, '2026-09-14', 9, ARRAY[t4]);                          -- a teacher who has left
  PERFORM pg_temp.rgo_lesson(school, '2026-09-15', 10, ARRAY[t1], ARRAY[]::text[], 'CANCELLED');
  PERFORM pg_temp.rgo_lesson(school, '2026-09-15', 11, ARRAY[t3]);                         -- T3 is away
  INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt", "updatedAt")
  VALUES (school, t3, ('2026-09-15 07:00')::timestamp AT TIME ZONE 'Europe/Stockholm', ('2026-09-15 17:00')::timestamp AT TIME ZONE 'Europe/Stockholm', now());
  PERFORM pg_temp.rgo_lesson(school, '2026-09-17', 8, ARRAY[t1]);                          -- Thursday, open

  -- The weekend: nothing, whatever is open.
  PERFORM pg_temp.rgo_expect('348o Saturday', pg_temp.rgo_reminded(school, '2026-09-19'), '');
  PERFORM pg_temp.rgo_expect('348o Sunday', pg_temp.rgo_reminded(school, '2026-09-20'), '');
  -- Friday 18: lessons up to Wednesday are past the limit of two days. T1 has two (the Monday and the Tuesday),
  -- T2 one; the one before the switch, the cancelled one, the absent teacher's, the departed teacher's and the
  -- saved one are not reminded of, and Thursday's is within the limit.
  PERFORM pg_temp.rgo_expect('348o Friday', pg_temp.rgo_reminded(school, '2026-09-18'), 't1 2/2, t2 1/2');
  IF (SELECT count(*) FROM "ReportingReminders" WHERE "schoolId" = school) <> 3 THEN RAISE EXCEPTION 'rapporteringsgrad 348o: the ledger has % rows, not 3', (SELECT count(*) FROM "ReportingReminders" WHERE "schoolId" = school); END IF;
  IF (SELECT count(*) FROM "Notifications" WHERE "schoolId" = school AND type = 'LESSON_REPORT_REMINDER') <> 2 THEN RAISE EXCEPTION 'rapporteringsgrad 348o: not two notices written'; END IF;
  IF EXISTS (SELECT 1 FROM "Notifications" WHERE "schoolId" = school AND type = 'LESSON_REPORT_REMINDER' AND meta::text ~* '(Rapportering|rg-|@|2026-)') THEN
    RAISE EXCEPTION 'rapporteringsgrad 348o: a reminder names a subject, a class, a person or a day';
  END IF;
  -- Told once: the same day again, and the next, say nothing of them.
  PERFORM pg_temp.rgo_expect('348o again', pg_temp.rgo_reminded(school, '2026-09-18'), '');
  -- Monday 21: Thursday's lesson is past the limit now, and only it.
  PERFORM pg_temp.rgo_expect('348o Monday', pg_temp.rgo_reminded(school, '2026-09-21'), 't1 1/2');
  -- A register saved after the reminder changes nothing; one saved before it spares the reminder.
  PERFORM pg_temp.rgo_lesson(school, '2026-09-18', 8, ARRAY[t1], ARRAY['PRESENT']);
  PERFORM pg_temp.rgo_lesson(school, '2026-09-18', 9, ARRAY[t1]);
  PERFORM pg_temp.rgo_expect('348o Tuesday', pg_temp.rgo_reminded(school, '2026-09-22'), 't1 1/2');
  -- On the limit to the day: a lesson on Monday 21 is within two days on Tuesday 22, past them on Wednesday 23.
  PERFORM pg_temp.rgo_lesson(school, '2026-09-21', 8, ARRAY[t2]);
  PERFORM pg_temp.rgo_expect('348o not yet', pg_temp.rgo_reminded(school, '2026-09-22'), '');
  PERFORM pg_temp.rgo_expect('348o on the limit', pg_temp.rgo_reminded(school, '2026-09-23'), 't2 1/2');
  -- The limit is the school's: five days, and a lesson of the 21st waits until the 26th, a Saturday, and so the 28th.
  UPDATE "ReportingSettings" SET "openAfterDays" = 5;
  PERFORM pg_temp.rgo_lesson(school, '2026-09-22', 8, ARRAY[t2]);
  PERFORM pg_temp.rgo_expect('348o five days, short', pg_temp.rgo_reminded(school, '2026-09-25'), '');
  PERFORM pg_temp.rgo_expect('348o five days, the Saturday', pg_temp.rgo_reminded(school, '2026-09-26'), '');
  PERFORM pg_temp.rgo_expect('348o five days, the Monday', pg_temp.rgo_reminded(school, '2026-09-28'), 't2 1/5');
  UPDATE "ReportingSettings" SET "openAfterDays" = 2;
  -- The ledger keeps a lesson for 60 days: older rows are cleared, and the rest are left.
  INSERT INTO "ReportingReminders" ("schoolId", "teacherId", "calendarLessonId", "lessonDate") VALUES
    (school, t1, gen_random_uuid(), '2026-07-20'), (school, t1, gen_random_uuid(), '2026-07-26');
  PERFORM pg_temp.rgo_reminded(school, '2026-09-24');
  got := (SELECT string_agg("lessonDate"::text, ',' ORDER BY "lessonDate") FROM "ReportingReminders" WHERE "lessonDate" < '2026-08-01');
  PERFORM pg_temp.rgo_expect('348o the ledger is cleared', got, '2026-07-26');
  -- Thirty days back and no further: a lesson that stood open longer is let go of, not reminded of in a month.
  DELETE FROM "ReportingReminders" WHERE "schoolId" = school;
  DELETE FROM "Notifications" WHERE "schoolId" = school;
  PERFORM pg_temp.rgo_lesson(school, '2026-10-30', 8, ARRAY[t1]);
  PERFORM pg_temp.rgo_expect('348o a month on', pg_temp.rgo_reminded(school, '2026-11-02'), 't1 1/2');
  -- The switch's own day is the first day reminded of, and the day before it is not.
  DELETE FROM "ReportingReminders" WHERE "schoolId" = school;
  UPDATE "ReportingSettings" SET "teacherRemindersOn" = '2026-09-15';
  PERFORM pg_temp.rgo_expect('348o dated the 15th', pg_temp.rgo_reminded(school, '2026-09-18'), 't1 1/2, t2 1/2');
  DELETE FROM "ReportingReminders" WHERE "schoolId" = school;
  UPDATE "ReportingSettings" SET "teacherRemindersOn" = '2026-09-16';
  PERFORM pg_temp.rgo_expect('348o dated the 16th', pg_temp.rgo_reminded(school, '2026-09-18'), '');
  -- Switched off: nothing, and nothing is written.
  DELETE FROM "ReportingReminders" WHERE "schoolId" = school;
  UPDATE "ReportingSettings" SET "teacherRemindersOn" = '2026-09-01', "teacherReminders" = false;
  PERFORM pg_temp.rgo_expect('348o off', pg_temp.rgo_reminded(school, '2026-09-18'), '');
  IF EXISTS (SELECT 1 FROM "ReportingReminders" WHERE "schoolId" = school) THEN RAISE EXCEPTION 'rapporteringsgrad 348o: a switch that is off wrote a ledger row'; END IF;
  UPDATE "ReportingSettings" SET "teacherReminders" = true;

  -- The switch back over the end of summer time (Sunday 25 October): the limit counts calendar days, so
  -- Friday's lesson is past three days on Monday and Thursday's lesson is too, whatever the Sunday's 25 hours.
  DELETE FROM "ReportingReminders" WHERE "schoolId" = school;
  DELETE FROM "CalendarLessons" WHERE "schoolId" = school AND date >= '2026-09-01';
  UPDATE "ReportingSettings" SET "openAfterDays" = 3, "teacherRemindersOn" = '2026-10-01';
  PERFORM pg_temp.rgo_lesson(school, '2026-10-22', 8, ARRAY[t1]);
  PERFORM pg_temp.rgo_lesson(school, '2026-10-23', 8, ARRAY[t1]);
  PERFORM pg_temp.rgo_lesson(school, '2026-10-24', 8, ARRAY[t2]);
  PERFORM pg_temp.rgo_expect('348o autumn Sunday', pg_temp.rgo_reminded(school, '2026-10-25'), '');
  PERFORM pg_temp.rgo_expect('348o autumn Monday', pg_temp.rgo_reminded(school, '2026-10-26'), 't1 2/3');
  PERFORM pg_temp.rgo_expect('348o autumn Tuesday', pg_temp.rgo_reminded(school, '2026-10-27'), 't2 1/3');
  -- And over the switch to summer time (Sunday 29 March): Thursday and Friday before it, Monday after.
  DELETE FROM "ReportingReminders" WHERE "schoolId" = school;
  DELETE FROM "CalendarLessons" WHERE "schoolId" = school AND date >= '2026-03-01' AND date < '2026-04-30';
  UPDATE "ReportingSettings" SET "teacherRemindersOn" = '2026-03-01';
  PERFORM pg_temp.rgo_lesson(school, '2026-03-26', 8, ARRAY[t1]);
  PERFORM pg_temp.rgo_lesson(school, '2026-03-27', 8, ARRAY[t1]);
  PERFORM pg_temp.rgo_expect('348o spring Monday', pg_temp.rgo_reminded(school, '2026-03-30'), 't1 2/3');

  -- Which weeks are due, to the day. Weeks run Monday to Sunday.
  DELETE FROM "ReportingDigests" WHERE "schoolId" = school;
  PERFORM pg_temp.rgo_expect('348o Monday 09-14', (SELECT period_start || ' ' || period_end FROM app.reporting_digest_due(school, '2026-09-14')), '2026-09-07 2026-09-13');
  PERFORM pg_temp.rgo_expect('348o Sunday 09-13', (SELECT count(*)::text FROM app.reporting_digest_due(school, '2026-09-13')), '0');
  PERFORM pg_temp.rgo_expect('348o Tuesday 09-15', (SELECT period_end::text FROM app.reporting_digest_due(school, '2026-09-15')), '2026-09-13');
  INSERT INTO "ReportingDigests" ("schoolId", "periodStart", "periodEnd", recipients, teachers, held, reported) VALUES (school, '2026-09-07', '2026-09-13', 1, 1, 3, 3);
  PERFORM pg_temp.rgo_expect('348o written', (SELECT count(*)::text FROM app.reporting_digest_due(school, '2026-09-15')), '0');
  PERFORM pg_temp.rgo_expect('348o next Monday', (SELECT period_start || ' ' || period_end FROM app.reporting_digest_due(school, '2026-09-21')), '2026-09-14 2026-09-20');
  -- The switch on a Sunday: the week that ended that day is due on the Monday; on the Monday, the one after.
  DELETE FROM "ReportingDigests" WHERE "schoolId" = school;
  UPDATE "ReportingSettings" SET "rektorDigestOn" = '2026-09-13';
  PERFORM pg_temp.rgo_expect('348o switch on the Sunday', (SELECT count(*)::text FROM app.reporting_digest_due(school, '2026-09-14')), '1');
  UPDATE "ReportingSettings" SET "rektorDigestOn" = '2026-09-14';
  PERFORM pg_temp.rgo_expect('348o switch on the Monday', (SELECT count(*)::text FROM app.reporting_digest_due(school, '2026-09-14')), '0');
  PERFORM pg_temp.rgo_expect('348o switch on the Monday, a week on', (SELECT period_start || ' ' || period_end FROM app.reporting_digest_due(school, '2026-09-21')), '2026-09-14 2026-09-20');
  -- A week over the new year, and the weeks of the summer-time switches are seven calendar days all the same.
  UPDATE "ReportingSettings" SET "rektorDigestOn" = '2025-01-01';
  PERFORM pg_temp.rgo_expect('348o new year', (SELECT period_start || ' ' || period_end FROM app.reporting_digest_due(school, '2026-01-05')), '2025-12-29 2026-01-04');
  PERFORM pg_temp.rgo_expect('348o spring week', (SELECT period_start || ' ' || period_end FROM app.reporting_digest_due(school, '2026-03-30')), '2026-03-23 2026-03-29');
  PERFORM pg_temp.rgo_expect('348o fall week', (SELECT period_start || ' ' || period_end FROM app.reporting_digest_due(school, '2026-10-26')), '2026-10-19 2026-10-25');
  -- Off: nothing is due.
  UPDATE "ReportingSettings" SET "rektorDigest" = false;
  PERFORM pg_temp.rgo_expect('348o off', (SELECT count(*)::text FROM app.reporting_digest_due(school, '2026-10-26')), '0');
  -- The job asks for every school with a lesson in the last 90 days, switches or not.
  DELETE FROM "CalendarLessons" WHERE "schoolId" = school;
  PERFORM pg_temp.rgo_expect('348o not listed without a lesson', (SELECT count(*)::text FROM app.reporting_schools() s WHERE s = school), '0');
  PERFORM pg_temp.rgo_lesson(school, (now() AT TIME ZONE 'Europe/Stockholm')::date - 91, 8, ARRAY[t1]);
  PERFORM pg_temp.rgo_expect('348o not listed with a lesson 91 days back', (SELECT count(*)::text FROM app.reporting_schools() s WHERE s = school), '0');
  PERFORM pg_temp.rgo_lesson(school, (now() AT TIME ZONE 'Europe/Stockholm')::date - 90, 8, ARRAY[t1]);
  PERFORM pg_temp.rgo_expect('348o listed with a lesson 90 days back', (SELECT count(*)::text FROM app.reporting_schools() s WHERE s = school), '1');
END $$;
ROLLBACK;

-- 348o, the weekly notice: only for a whole week that is over, Monday to Sunday in the school's dates. The
-- ledger's row for a week stops the real notice of it, so a week to come, a stretch that is no week, and a
-- school that is not there are refused, and write nothing.
BEGIN;
CREATE FUNCTION pg_temp.rgo_digest_state(p_school uuid, p_start date, p_end date) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app.reporting_digest(p_school, p_start, p_end);
  RETURN 'accepted';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE;
END $$;
DO $$
DECLARE
  school uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-rapporteringsgrad-school');
  monday date := (now() AT TIME ZONE 'Europe/Stockholm')::date - (extract(isodow FROM (now() AT TIME ZONE 'Europe/Stockholm')::date)::integer - 1);
  zone text;
  sunday date;
BEGIN
  INSERT INTO "ReportingSettings" ("schoolId", "rektorDigest") VALUES (school, true);
  PERFORM pg_temp.rgo_expect('348o this week', pg_temp.rgo_digest_state(school, monday, monday + 6), 'RR400');
  PERFORM pg_temp.rgo_expect('348o next week', pg_temp.rgo_digest_state(school, monday + 7, monday + 13), 'RR400');
  PERFORM pg_temp.rgo_expect('348o a Tuesday to a Monday', pg_temp.rgo_digest_state(school, monday - 6, monday), 'RR400');
  PERFORM pg_temp.rgo_expect('348o eight days', pg_temp.rgo_digest_state(school, monday - 14, monday - 7), 'RR400');
  PERFORM pg_temp.rgo_expect('348o six days', pg_temp.rgo_digest_state(school, monday - 14, monday - 9), 'RR400');
  PERFORM pg_temp.rgo_expect('348o the end before the start', pg_temp.rgo_digest_state(school, monday - 7, monday - 14), 'RR400');
  PERFORM pg_temp.rgo_expect('348o no start', pg_temp.rgo_digest_state(school, NULL, monday - 1), 'RR400');
  PERFORM pg_temp.rgo_expect('348o no end', pg_temp.rgo_digest_state(school, monday - 7, NULL), 'RR400');
  PERFORM pg_temp.rgo_expect('348o no such school', pg_temp.rgo_digest_state(gen_random_uuid(), monday - 7, monday - 1), 'RR404');
  -- On a Sunday the week that ends today is not over yet, and the day before is. The clock is the database's own,
  -- so a school's timezone finds the Sunday: one of these zones has one whenever it is a Saturday, Sunday or
  -- Monday somewhere in the world (the other days of the week cannot reach the edge, and then nothing is asked).
  FOR zone IN SELECT unnest(ARRAY['Etc/GMT+12', 'Europe/Stockholm', 'Pacific/Kiritimati']) LOOP
    sunday := (clock_timestamp() AT TIME ZONE zone)::date;
    IF extract(isodow FROM sunday) = 7 THEN
      UPDATE "Schools" SET "timezone" = zone WHERE "id" = school;
      PERFORM pg_temp.rgo_expect('348o the Sunday itself, in ' || zone, pg_temp.rgo_digest_state(school, sunday - 6, sunday), 'RR400');
      PERFORM pg_temp.rgo_expect('348o the Sunday before, in ' || zone, pg_temp.rgo_digest_state(school, sunday - 13, sunday - 7), 'accepted');
      DELETE FROM "ReportingDigests" WHERE "schoolId" = school;
      UPDATE "Schools" SET "timezone" = 'Europe/Stockholm' WHERE "id" = school;
      EXIT;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM "ReportingDigests" WHERE "schoolId" = school) THEN
    RAISE EXCEPTION 'rapporteringsgrad 348o: a refused week wrote a ledger row';
  END IF;
  -- The week that is over: accepted, and entered once.
  PERFORM pg_temp.rgo_expect('348o last week', pg_temp.rgo_digest_state(school, monday - 7, monday - 1), 'accepted');
  PERFORM pg_temp.rgo_expect('348o last week, entered', (SELECT "periodStart"::text FROM "ReportingDigests" WHERE "schoolId" = school), (monday - 7)::text);
  PERFORM pg_temp.rgo_expect('348o a week long ago', pg_temp.rgo_digest_state(school, '2026-09-14', '2026-09-20'), 'accepted');
END $$;
ROLLBACK;

-- 349o: gallring. The days and the reminders go with the attendance they are counted from: under ATTENDANCE,
-- by the day they stand for and by the lesson's day, in the same batch.
BEGIN;
DO $$
DECLARE
  school uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-rapporteringsgrad-school');
  other uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-rapporteringsgrad-annan');
  admin uuid := (SELECT id FROM "Users" WHERE "schoolId" = school AND email = 'rg-full@example.invalid');
  t1 uuid := (SELECT id FROM "Users" WHERE "schoolId" = school AND email = 'rg-t1@example.invalid');
  t_other uuid := (SELECT id FROM "Users" WHERE "schoolId" = other AND email = 'rg-annan-t@example.invalid');
  today date := (now() AT TIME ZONE 'Europe/Stockholm')::date;
  run uuid;
  n integer;
  counts jsonb;
  tbls text[];
BEGIN
  -- Days and reminders at three ages, here and at the school with no decision (which has its fixture day too).
  INSERT INTO "TeacherReportingDays" ("schoolId", "teacherId", day, held, reported) VALUES
    (school, t1, today - 900, 3, 2), (school, t1, today - 400, 3, 2), (school, t1, today - 30, 3, 2),
    (other, t_other, today - 900, 3, 2);
  INSERT INTO "ReportingReminders" ("schoolId", "teacherId", "calendarLessonId", "lessonDate") VALUES
    (school, t1, gen_random_uuid(), today - 900), (school, t1, gen_random_uuid(), today - 400), (school, t1, gen_random_uuid(), today - 30),
    (other, t_other, gen_random_uuid(), today - 900);
  INSERT INTO "ReportingDigests" ("schoolId", "periodStart", "periodEnd", recipients, teachers, held, reported) VALUES
    (school, today - 910, today - 904, 1, 1, 3, 2);
  ALTER TABLE "RetentionDecisions" DISABLE TRIGGER "RetentionDecisions_stamped";
  INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision, months, reference, "decidedById", "decidedAt")
  VALUES (school, 'ATTENDANCE', 'PURGE_AFTER', 12, 'RG 349', admin, now() - interval '2 days');
  ALTER TABLE "RetentionDecisions" ENABLE TRIGGER "RetentionDecisions_stamped";

  -- What is due, as the one predicate answers it: the two old days and the two old reminders of this school.
  SELECT array_agg(DISTINCT d.tbl ORDER BY d.tbl) INTO tbls FROM app.gallring_due(school, 'ATTENDANCE', today - 365, today) d;
  IF tbls IS DISTINCT FROM ARRAY['ReportingReminders', 'TeacherReportingDays'] THEN
    RAISE EXCEPTION 'rapporteringsgrad 349o: the kinds due are % (the week''s ledger is counts and is not gallring''s)', tbls;
  END IF;
  IF (SELECT count(*) FROM app.gallring_due(school, 'ATTENDANCE', today - 365, today) d WHERE d.tbl = 'TeacherReportingDays') <> 2
     OR (SELECT count(*) FROM app.gallring_due(school, 'ATTENDANCE', today - 365, today) d WHERE d.tbl = 'ReportingReminders') <> 2 THEN
    RAISE EXCEPTION 'rapporteringsgrad 349o: not the two days and the two reminders before the cutoff are due';
  END IF;
  IF EXISTS (SELECT 1 FROM app.gallring_due(school, 'ABSENCE_REPORTS', today - 365, today) d WHERE d.tbl IN ('TeacherReportingDays', 'ReportingReminders'))
     OR EXISTS (SELECT 1 FROM app.gallring_due(school, 'NOTIFICATIONS', today - 365, today) d WHERE d.tbl IN ('TeacherReportingDays', 'ReportingReminders'))
     OR EXISTS (SELECT 1 FROM app.gallring_due(school, 'CHANGE_LOGS', today - 365, today) d WHERE d.tbl IN ('TeacherReportingDays', 'ReportingReminders')) THEN
    RAISE EXCEPTION 'rapporteringsgrad 349o: the days or the reminders are due under another kind than ATTENDANCE';
  END IF;
  IF EXISTS (SELECT 1 FROM app.gallring_due(other, 'ATTENDANCE', today - 365, today) d
              WHERE d.id IN (SELECT id FROM "TeacherReportingDays" WHERE "schoolId" = school UNION ALL SELECT id FROM "ReportingReminders" WHERE "schoolId" = school)) THEN
    RAISE EXCEPTION 'rapporteringsgrad 349o: a school''s days are due under another school''s run';
  END IF;

  -- The night: the old ones go, the one thirty days back stays, the other school's stay, the ledger is not touched.
  run := app.gallring_begin(school, now());
  LOOP
    n := app.gallring_purge(run, 'ATTENDANCE', 1);
    EXIT WHEN n = 0;
  END LOOP;
  PERFORM app.gallring_finish(run, '{}', now());
  IF (SELECT count(*) FROM "TeacherReportingDays" WHERE "schoolId" = school) <> 1 OR (SELECT count(*) FROM "ReportingReminders" WHERE "schoolId" = school) <> 1 THEN
    RAISE EXCEPTION 'rapporteringsgrad 349o: gallring left % days and % reminders of the school, not the one of each from 30 days ago',
      (SELECT count(*) FROM "TeacherReportingDays" WHERE "schoolId" = school), (SELECT count(*) FROM "ReportingReminders" WHERE "schoolId" = school);
  END IF;
  IF (SELECT day FROM "TeacherReportingDays" WHERE "schoolId" = school) <> today - 30 OR (SELECT "lessonDate" FROM "ReportingReminders" WHERE "schoolId" = school) <> today - 30 THEN
    RAISE EXCEPTION 'rapporteringsgrad 349o: gallring kept the wrong day';
  END IF;
  IF (SELECT count(*) FROM "TeacherReportingDays" WHERE "schoolId" = other) <> 2 OR (SELECT count(*) FROM "ReportingReminders" WHERE "schoolId" = other) <> 1 THEN
    RAISE EXCEPTION 'rapporteringsgrad 349o: a school with no decision lost its days or reminders';
  END IF;
  IF (SELECT count(*) FROM "ReportingDigests" WHERE "schoolId" = school) <> 1 THEN RAISE EXCEPTION 'rapporteringsgrad 349o: gallring took the week''s ledger'; END IF;
  SELECT g.counts INTO counts FROM "GallringRuns" g WHERE g.id = run;
  IF (counts ->> 'ATTENDANCE')::integer <> 4 THEN
    RAISE EXCEPTION 'rapporteringsgrad 349o: the run counts % rows under ATTENDANCE, not the four', counts ->> 'ATTENDANCE';
  END IF;

  -- The batch is shared with the attendance: with a budget of one the run is not complete until nothing is left.
  INSERT INTO "TeacherReportingDays" ("schoolId", "teacherId", day, held, reported) VALUES (school, t1, today - 800, 1, 1), (school, t1, today - 799, 1, 1);
  INSERT INTO "ReportingReminders" ("schoolId", "teacherId", "calendarLessonId", "lessonDate") VALUES (school, t1, gen_random_uuid(), today - 800);
  run := app.gallring_begin(school, now());
  IF app.gallring_purge(run, 'ATTENDANCE', 1) <> 1 THEN RAISE EXCEPTION 'rapporteringsgrad 349o: a batch of one took more or less than one row'; END IF;
  IF (SELECT (complete ->> 'ATTENDANCE')::boolean FROM "GallringRuns" WHERE id = run) THEN
    RAISE EXCEPTION 'rapporteringsgrad 349o: a full batch said nothing was left';
  END IF;
  IF app.gallring_purge(run, 'ATTENDANCE', 1) <> 1 OR app.gallring_purge(run, 'ATTENDANCE', 1) <> 1 OR app.gallring_purge(run, 'ATTENDANCE', 1) <> 0 THEN
    RAISE EXCEPTION 'rapporteringsgrad 349o: the three rows were not taken in the next batches';
  END IF;
  PERFORM app.gallring_finish(run, '{}', now());

  -- KEEP stops it at once.
  ALTER TABLE "RetentionDecisions" DISABLE TRIGGER "RetentionDecisions_stamped";
  INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision, reference, "decidedById", "decidedAt")
  VALUES (school, 'ATTENDANCE', 'KEEP', 'RG 349 keep', admin, now() - interval '1 hour');
  ALTER TABLE "RetentionDecisions" ENABLE TRIGGER "RetentionDecisions_stamped";
  INSERT INTO "TeacherReportingDays" ("schoolId", "teacherId", day, held, reported) VALUES (school, t1, today - 800, 1, 1);
  run := app.gallring_begin(school, now());
  IF app.gallring_purge(run, 'ATTENDANCE', 100) <> 0 THEN RAISE EXCEPTION 'rapporteringsgrad 349o: a school that keeps its attendance lost a day'; END IF;
  PERFORM app.gallring_finish(run, '{}', now());
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Sections 330 and 334 on the owner's side: Nycklar mellan skolbundna tabeller
-- (20270115090000).
--
-- Every foreign key between two tables that both carry "schoolId" is
-- ("x", "schoolId") -> table ("id", "schoolId"), so a row cannot name a row of
-- another school. Sections 331-333 of rls-policies.sql re-point school B's rows
-- at school A's as B's principals; what only the owner can ask is here:
--
--   330   the catalogue, the way section 291 asks it of the person keys. Every
--         foreign key from a table with "schoolId" to another table with it
--         holds the child's "schoolId" against the parent's, except five that
--         something else holds (named, with what holds each): a key added
--         later that does not fails here, named. The guard's own predicate is
--         run over a stand-in pair with a key of each kind and must report the
--         plain one alone. The thirty-eight keys of the migration are what the
--         migration made them (columns, parent, actions, validated), the plain
--         keys they replaced are gone, each key has an index that serves the
--         lookup of a removed parent and the planner never answers it with a
--         Seq Scan, and the database itself, with row security out of the way,
--         refuses a row that names another school's. The guard sees a table's
--         school under any column named <something>SchoolId when it has no
--         "schoolId" of its own (RoomLoans).
--         What a key does when its PARENT is updated is asked of every composite
--         key that holds a school, not only these: section 388.
--         What these keys also hold: the policies' SELECT arms ask the school
--         of the ROW, and the fixtures that once planted a row naming another
--         school's (to tell an arm asking the row's school from one asking the
--         parent's) are gone, since such a row cannot be written. Loosen a key
--         here and that distinction is untested again, not only this section.
--   334   what a removed parent does is what it did: CASCADE removes the row,
--         SET NULL nulls the column and nothing else ("schoolId" stays), RESTRICT
--         refuses. What a parent moved to another school does is nothing: the
--         keys are ON UPDATE NO ACTION, so the move is refused by the key of
--         the row that would have been carried along (it was CASCADE, and a room
--         followed its room type to another school without a word).
--
-- The rows are rls-tenantkey-a's and -b's (fixtures: 7e<school><entity>-…).
-- Run as the owner: the policies of the API's role add predicates of their own
-- (sections 331-333 are theirs), and the referential lookups see none.
-- ---------------------------------------------------------------------------

CREATE FUNCTION pg_temp.tk_id(s int, n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT ('7e' || lpad(s::text, 2, '0') || lpad(to_hex(n), 4, '0') || '-0000-4000-8000-000000000000')::uuid
$$;

-- The keys of the migration: the table, the column, the parent, ON DELETE (c, n, r), the row of school B
-- the column is moved on, the row of school A it is pointed at, and the entity of school B the
-- column is moved to for 334 (null: the column's own parent is deleted).
CREATE FUNCTION pg_temp.tk_keys() RETURNS TABLE (child text, col text, parent text, del char, row_n int, victim_n int)
LANGUAGE sql AS $$
  SELECT * FROM (VALUES
    ('AbsenceReports',          'reportedById',       'Users',           'c', 60,  5),
    ('AbsenceReports',          'studentId',          'Users',           'c', 60,  4),
    ('AttendanceRecords',       'calendarLessonId',   'CalendarLessons', 'c', 38, 13),
    ('AttendanceRecords',       'recordedById',       'Users',           'n', 38,  3),
    ('AttendanceRecords',       'studentId',          'Users',           'c', 38,  4),
    ('AvailabilityConstraints', 'roomId',             'Rooms',           'c', 58, 10),
    ('AvailabilityConstraints', 'studentGroupId',     'StudentGroups',   'c', 59,  6),
    ('AvailabilityConstraints', 'userId',             'Users',           'c', 57,  3),
    ('CalendarLessonGroups',    'calendarLessonId',   'CalendarLessons', 'c', 35, 13),
    ('CalendarLessonGroups',    'studentGroupId',     'StudentGroups',   'c', 35,  7),
    ('CalendarLessonStudents',  'calendarLessonId',   'CalendarLessons', 'c', 36, 13),
    ('CalendarLessonStudents',  'studentId',          'Users',           'c', 36,  4),
    ('CalendarLessonTeachers',  'calendarLessonId',   'CalendarLessons', 'c', 37, 13),
    ('CalendarLessonTeachers',  'teacherId',          'Users',           'c', 37,  3),
    ('CalendarLessons',         'masterLessonId',     'MasterLessons',   'n', 13, 12),
    ('CalendarLessons',         'roomId',             'Rooms',           'n', 13, 10),
    ('CalendarLessons',         'studentGroupId',     'StudentGroups',   'c', 13,  6),
    ('CalendarLessons',         'subjectId',          'Subjects',        'c', 13, 11),
    ('LeaveRequests',           'decidedById',        'Users',           'n', 15,  2),
    ('LeaveRequests',           'referredById',       'Users',           'n', 15,  3),
    ('LeaveRequests',           'requestedById',      'Users',           'c', 15,  5),
    ('LeaveRequests',           'studentId',          'Users',           'c', 15,  4),
    ('MasterLessonGroups',      'masterLessonId',     'MasterLessons',   'c', 33, 12),
    ('MasterLessonStudents',    'masterLessonId',     'MasterLessons',   'c', 34, 12),
    ('Notifications',           'userId',             'Users',           'c', 61,  3),
    ('RoomBookings',            'bookedById',         'Users',           'c', 62,  3),
    ('RoomBookings',            'decidedById',        'Users',           'n', 62,  2),
    ('RoomBookings',            'roomId',             'Rooms',           'c', 62, 10),
    ('RoomPreferenceRooms',     'preferenceId',       'RoomPreferences', 'c', 63, 14),
    ('RoomPreferenceRooms',     'roomId',             'Rooms',           'c', 63, 10),
    ('RoomPreferences',         'roomTypeId',         'RoomTypes',       'c', 14,  9),
    ('RoomPreferences',         'subjectId',          'Subjects',        'c', 14, 11),
    ('Rooms',                   'roomTypeId',         'RoomTypes',       'r', 10,  9),
    ('StudentGroupMembers',     'studentGroupId',     'StudentGroups',   'c', 32,  7),
    ('StudentGroupMembers',     'studentId',          'Users',           'c', 32,  4),
    ('StudentGroups',           'academicYearId',     'AcademicYears',   'c',  7,  8),
    ('Subjects',                'requiredRoomTypeId', 'RoomTypes',       'r', 11,  9),
    -- No id of its own (its key is the pair): moved by the pair, in 330 only.
    ('LeaveRequestNotices',     'leaveRequestId',     'LeaveRequests',   'c', 15, 15)
  ) v(child, col, parent, del, row_n, victim_n)
$$;

-- The columns of a table that say which school a row belongs to: "schoolId", or, in a table that has none of
-- that name (RoomLoans: the owner's school and the borrower's), every column named like <something>SchoolId.
CREATE FUNCTION pg_temp.tk_school_cols(p_rel oid) RETURNS int2[] LANGUAGE sql AS $$
  SELECT coalesce(
    (SELECT array_agg(a.attnum) FROM pg_attribute a WHERE a.attrelid = p_rel AND a.attname = 'schoolId' AND NOT a.attisdropped),
    (SELECT array_agg(a.attnum) FROM pg_attribute a WHERE a.attrelid = p_rel AND a.attnum > 0 AND NOT a.attisdropped AND a.attname ~ '[a-z]SchoolId$'))
$$;

-- The guard's predicate, over the foreign keys of one schema's tables: those whose child and parent both
-- carry a school column (above) and that do not hold one of the child's against one of the parent's at some
-- position of the key. Run over "public" for the guard, and over this session's temporary tables for its
-- self-test.
CREATE FUNCTION pg_temp.tk_gaps(p_schema oid) RETURNS TABLE (tbl text, conname text, cols text)
LANGUAGE sql AS $$
  SELECT cl.relname::text, c.conname::text,
         (SELECT string_agg(a.attname, ',' ORDER BY u.ord)
            FROM unnest(c.conkey) WITH ORDINALITY u(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum)
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid AND cl.relnamespace = p_schema
    CROSS JOIN LATERAL (SELECT pg_temp.tk_school_cols(c.conrelid) AS cs, pg_temp.tk_school_cols(c.confrelid) AS ps) s
   WHERE c.contype = 'f'
     AND s.cs IS NOT NULL AND s.ps IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM generate_subscripts(c.conkey, 1) i
                      WHERE c.conkey[i] = ANY (s.cs) AND c.confkey[i] = ANY (s.ps))
$$;

-- ---------------------------------------------------------------------------
-- Section 330, the guard.
-- ---------------------------------------------------------------------------

BEGIN;
DO $$
DECLARE
  exempt constant text[] := ARRAY[
    'CrisisPupils.CrisisPupils_callId_alarmId_fkey',
    'CrisisReports.CrisisReports_callId_alarmId_fkey',
    'CrisisReports.CrisisReports_callId_studentId_fkey',
    'CrisisReports.CrisisReports_foundInCallId_alarmId_fkey',
    'Users.Users_studentGroupId_fkey'];
  found text[];
  extra text[];
  gone text[];
  asked int;
  unvalid text[];
  chain record;
BEGIN
  SELECT array_agg(g.tbl || '.' || g.conname ORDER BY g.tbl, g.conname) INTO found FROM pg_temp.tk_gaps('public'::regnamespace) g;
  SELECT array_agg(f ORDER BY f) INTO extra FROM unnest(found) f WHERE f <> ALL (exempt);
  SELECT array_agg(e ORDER BY e) INTO gone FROM unnest(exempt) e WHERE e <> ALL (coalesce(found, '{}'));
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'tenant keys 330: a key between two tables that carry "schoolId" does not hold them together: % (make it (x, "schoolId") -> parent (id, "schoolId"), the parent having that unique key, as 20270115090000 did for 38 others; or, if something else holds it, name what in this list)', extra;
  END IF;
  IF gone IS NOT NULL THEN
    RAISE EXCEPTION 'tenant keys 330: a key this list says something else holds is gone or has become composite: % (take it off the list)', gone;
  END IF;

  SELECT count(*) INTO asked
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid AND cl.relnamespace = 'public'::regnamespace
   WHERE c.contype = 'f'
     AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attname = 'schoolId' AND NOT a.attisdropped)
     AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.confrelid AND a.attname = 'schoolId' AND NOT a.attisdropped);
  IF asked < 200 THEN
    RAISE EXCEPTION 'tenant keys 330: only % keys between tables with "schoolId" were asked, the catalogue holds more than 200', asked;
  END IF;

  -- A key left NOT VALID judges new rows and nothing before them.
  SELECT array_agg(cl.relname || '.' || c.conname ORDER BY cl.relname, c.conname) INTO unvalid
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid AND cl.relnamespace = 'public'::regnamespace
   WHERE c.contype = 'f' AND NOT c.convalidated
     AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attname = 'schoolId' AND NOT a.attisdropped);
  IF unvalid IS NOT NULL THEN
    RAISE EXCEPTION 'tenant keys 330: keys that were never validated: % (VALIDATE CONSTRAINT)', unvalid;
  END IF;

  -- What holds each of the five: the Crisis keys, the keys beside them on the same call.
  FOR chain IN SELECT * FROM (VALUES
      ('CrisisPupils',  'CrisisPupils_callId_schoolId_fkey'),
      ('CrisisReports', 'CrisisReports_callId_schoolId_fkey'),
      ('CrisisCalls',   'CrisisCalls_alarmId_schoolId_fkey')) v(tbl, conname)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                    WHERE c.conname = chain.conname AND c.conrelid = to_regclass(format('public.%I', chain.tbl)) AND c.contype = 'f' AND c.convalidated
                      AND (SELECT string_agg(a.attname::text, ',' ORDER BY u.ord) FROM unnest(c.conkey) WITH ORDINALITY u(attnum, ord)
                             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum) LIKE '%,schoolId') THEN
      RAISE EXCEPTION 'tenant keys 330: %.% is gone, and it is what holds the Crisis keys to one school', chain.tbl, chain.conname;
    END IF;
  END LOOP;
  -- And a pupil's class: the trigger that refuses another school's, in the key's own words.
  IF (SELECT count(*) FROM pg_trigger t
       WHERE t.tgrelid = '"Users"'::regclass AND t.tgname IN ('Users_enrollment_on_insert', 'Users_enrollment_on_update')
         AND t.tgenabled = 'O' AND t.tgfoid = 'app.student_enrollments_follow_the_class'::regproc) <> 2 THEN
    RAISE EXCEPTION 'tenant keys 330: the triggers that hold a pupil''s class to the pupil''s school are not both there and on';
  END IF;
END $$;
ROLLBACK;

-- The guard's own predicate, over stand-ins: the plain keys and the two that hold a school against
-- something else are reported, the composite one is not. A guard that let one through, or reported the
-- composite one, fails here.
BEGIN;
DO $$
DECLARE
  got text[];
BEGIN
  CREATE TEMP TABLE tk_parent (id uuid PRIMARY KEY, "schoolId" uuid NOT NULL, UNIQUE (id, "schoolId"));
  CREATE TEMP TABLE tk_plain (id uuid PRIMARY KEY, "schoolId" uuid NOT NULL, x uuid REFERENCES tk_parent (id));
  CREATE TEMP TABLE tk_composite (id uuid PRIMARY KEY, "schoolId" uuid NOT NULL, x uuid,
                                  FOREIGN KEY (x, "schoolId") REFERENCES tk_parent (id, "schoolId"));
  -- Both in one table: the composite key does not make the plain one beside it right.
  CREATE TEMP TABLE tk_both (id uuid PRIMARY KEY, "schoolId" uuid NOT NULL, x uuid REFERENCES tk_parent (id),
                             FOREIGN KEY (x, "schoolId") REFERENCES tk_parent (id, "schoolId"));
  -- The child's school held against a column of the parent's that is not its school.
  CREATE TEMP TABLE tk_parent2 (id uuid PRIMARY KEY, "schoolId" uuid NOT NULL, other uuid NOT NULL, UNIQUE (id, other));
  CREATE TEMP TABLE tk_crossed (id uuid PRIMARY KEY, "schoolId" uuid NOT NULL, x uuid,
                                FOREIGN KEY (x, "schoolId") REFERENCES tk_parent2 (id, other));
  -- The parent's school held against a column of the child's that is not its school.
  CREATE TEMP TABLE tk_wrongcol (id uuid PRIMARY KEY, "schoolId" uuid NOT NULL, x uuid, y uuid,
                                 FOREIGN KEY (x, y) REFERENCES tk_parent (id, "schoolId"));
  -- A table without the column on either side is none of the guard's business.
  CREATE TEMP TABLE tk_bare (id uuid PRIMARY KEY);
  CREATE TEMP TABLE tk_bare_child (id uuid PRIMARY KEY, x uuid REFERENCES tk_bare (id));
  -- A table whose school is not called "schoolId" (RoomLoans: ownerSchoolId, borrowerSchoolId): a plain key
  -- from it is a gap, a key that holds one of its school columns against the parent's is not.
  CREATE TEMP TABLE tk_loan_plain (id uuid PRIMARY KEY, "ownerSchoolId" uuid NOT NULL, "borrowerSchoolId" uuid NOT NULL, x uuid REFERENCES tk_parent (id));
  CREATE TEMP TABLE tk_loan_owner (id uuid PRIMARY KEY, "ownerSchoolId" uuid NOT NULL, "borrowerSchoolId" uuid NOT NULL, x uuid,
                                   FOREIGN KEY (x, "ownerSchoolId") REFERENCES tk_parent (id, "schoolId"));
  CREATE TEMP TABLE tk_loan_borrower (id uuid PRIMARY KEY, "ownerSchoolId" uuid NOT NULL, "borrowerSchoolId" uuid NOT NULL, x uuid,
                                      FOREIGN KEY (x, "borrowerSchoolId") REFERENCES tk_parent (id, "schoolId"));
  -- The same table the other way round: a school-bound table naming a row of a table whose school is called
  -- <x>SchoolId, plain.
  CREATE TEMP TABLE tk_loaned (id uuid PRIMARY KEY, "ownerSchoolId" uuid NOT NULL, UNIQUE (id, "ownerSchoolId"));
  CREATE TEMP TABLE tk_names_loaned (id uuid PRIMARY KEY, "schoolId" uuid NOT NULL, x uuid REFERENCES tk_loaned (id));
  SELECT array_agg(g.tbl ORDER BY g.tbl) INTO got FROM pg_temp.tk_gaps(pg_my_temp_schema()) g;
  IF got IS DISTINCT FROM ARRAY['tk_both', 'tk_crossed', 'tk_loan_plain', 'tk_names_loaned', 'tk_plain', 'tk_wrongcol'] THEN
    RAISE EXCEPTION 'tenant keys 330: the guard reported % over the stand-ins, not the keys that do not hold the school alone (tk_both, tk_crossed, tk_loan_plain, tk_names_loaned, tk_plain, tk_wrongcol)', got;
  END IF;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 330, the thirty-eight keys.
-- ---------------------------------------------------------------------------

BEGIN;
DO $$
DECLARE
  k record;
  def text;
  want text;
  valid boolean;
  idx text;
  line text;
  plan text;
  types text;
  nulls text;
  where_sql text;
  kname text;
  checked int := 0;
  unled text[] := '{}';
  bare text[] := '{}';
BEGIN
  PERFORM set_config('plan_cache_mode', 'force_generic_plan', true);
  PERFORM set_config('enable_seqscan', 'off', true);
  FOR k IN SELECT * FROM pg_temp.tk_keys() LOOP
    kname := k.child || '_' || k.col || '_schoolId_fkey';
    SELECT pg_get_constraintdef(c.oid), c.convalidated INTO def, valid
      FROM pg_constraint c WHERE c.conname = kname AND c.conrelid = to_regclass(format('public.%I', k.child)) AND c.contype = 'f';
    IF def IS NULL THEN
      RAISE EXCEPTION 'tenant keys 330: % is gone', kname;
    END IF;
    -- ON UPDATE NO ACTION is the default and pg_get_constraintdef does not print it; the catalogue's own
    -- letter is asked as well, so a key that follows its parent to another school (CASCADE, SET NULL) fails here.
    want := format('FOREIGN KEY (%I, "schoolId") REFERENCES %I(id, "schoolId") ON DELETE %s', k.col, k.parent,
                   CASE k.del WHEN 'c' THEN 'CASCADE' WHEN 'r' THEN 'RESTRICT' ELSE format('SET NULL (%I)', k.col) END);
    IF def IS DISTINCT FROM want THEN
      RAISE EXCEPTION E'tenant keys 330: % is\n  %\nnot\n  %', kname, def, want;
    END IF;
    IF (SELECT c.confupdtype FROM pg_constraint c WHERE c.conname = kname AND c.conrelid = to_regclass(format('public.%I', k.child))) <> 'a' THEN
      RAISE EXCEPTION 'tenant keys 330: % follows its parent when the parent is updated (ON UPDATE is not NO ACTION)', kname;
    END IF;
    IF NOT valid THEN
      RAISE EXCEPTION 'tenant keys 330: % was never validated', kname;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = k.child || '_' || k.col || '_fkey' AND c.conrelid = to_regclass(format('public.%I', k.child))) THEN
      RAISE EXCEPTION 'tenant keys 330: the plain key %_%_fkey is back beside the composite one', k.child, k.col;
    END IF;

    -- The lookup of a removed parent: an equality on the key's columns. An index that starts with the
    -- column (the school is a filter on the rows it finds), or whose first two columns are the key's
    -- own in either order, serves it; and the planner, asked for the lookup with sequential scans off,
    -- never answers with a Seq Scan.
    IF NOT EXISTS (
      SELECT 1 FROM pg_index i
       WHERE i.indrelid = to_regclass(format('public.%I', k.child)) AND i.indisvalid AND i.indisready AND i.indexprs IS NULL
         AND (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = i.indrelid AND a.attnum = (i.indkey::int2[])[0]) = k.col
    ) THEN
      unled := unled || (k.child || '(' || k.col || ')');
    END IF;
    SELECT string_agg(format('$%s = x.%I', u.ord, a.attname), ' AND ' ORDER BY u.ord),
           string_agg(format_type(a.atttypid, a.atttypmod), ',' ORDER BY u.ord),
           string_agg('NULL', ',' ORDER BY u.ord)
      INTO where_sql, types, nulls
      FROM unnest(ARRAY[k.col, 'schoolId']) WITH ORDINALITY u(name, ord)
      JOIN pg_attribute a ON a.attrelid = to_regclass(format('public.%I', k.child)) AND a.attname = u.name;
    EXECUTE format('PREPARE tk_lookup(%s) AS SELECT 1 FROM ONLY %I x WHERE %s FOR KEY SHARE OF x', types, k.child, where_sql);
    plan := '';
    FOR line IN EXECUTE format('EXPLAIN EXECUTE tk_lookup(%s)', nulls) LOOP plan := plan || line || E'\n'; END LOOP;
    DEALLOCATE tk_lookup;
    IF plan ~ 'Seq Scan' THEN bare := bare || (k.child || '(' || k.col || ')'); END IF;
    checked := checked + 1;
  END LOOP;
  IF checked <> 38 THEN RAISE EXCEPTION 'tenant keys 330: % keys checked, 38 expected', checked; END IF;
  IF cardinality(unled) > 0 THEN
    RAISE EXCEPTION 'tenant keys 330: removing a parent has no index to find the rows of % with (give each key one that starts with its column)', unled;
  END IF;
  IF cardinality(bare) > 0 THEN
    RAISE EXCEPTION 'tenant keys 330: removing a parent reads the whole of % (no index of any kind answers the lookup)', bare;
  END IF;

  -- The four parents' key and the four indexes the migration added for the lookups.
  FOR idx IN SELECT unnest(ARRAY['MasterLessons_id_schoolId_key', 'RoomPreferences_id_schoolId_key', 'RoomTypes_id_schoolId_key', 'LeaveRequests_id_schoolId_key']) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = to_regclass(format('public.%I', idx)) AND i.indisunique AND i.indisvalid AND i.indisready
                      AND (SELECT array_agg(a.attname::text ORDER BY u.ord) FROM unnest(i.indkey::int2[]) WITH ORDINALITY u(attnum, ord)
                             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = u.attnum) = ARRAY['id', 'schoolId']) THEN
      RAISE EXCEPTION 'tenant keys 330: % is not a valid unique key on (id, schoolId)', idx;
    END IF;
  END LOOP;
  FOR idx IN SELECT unnest(ARRAY['CalendarLessons_subjectId_schoolId_idx', 'RoomPreferences_subjectId_schoolId_idx',
                                  'RoomPreferences_roomTypeId_schoolId_idx', 'RoomPreferenceRooms_roomId_schoolId_idx']) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = to_regclass(format('public.%I', idx)) AND NOT i.indisunique AND i.indisvalid AND i.indisready) THEN
      RAISE EXCEPTION 'tenant keys 330: % is not a valid index', idx;
    END IF;
  END LOOP;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 330, the database itself. School B's rows, re-pointed at school A's with row security out of
-- the way (the owner): every key refuses, by its own name, by UPDATE and by INSERT. A pupil's class is
-- the one the trigger refuses (in the key's words), and the control, a row of B's own, goes through.
-- ---------------------------------------------------------------------------

BEGIN;
DO $$
DECLARE
  k record;
  snap jsonb;
  got text;
  cname text;
  bad text[] := '{}';
  n int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Schools" WHERE id = pg_temp.tk_id(2, 1) AND slug = 'rls-tenantkey-b') THEN
    RAISE EXCEPTION 'tenant keys 330: the fixture schools are not there; fixtures did not run';
  END IF;
  FOR k IN SELECT * FROM pg_temp.tk_keys() WHERE child <> 'LeaveRequestNotices' LOOP
    -- UPDATE
    BEGIN
      EXECUTE format('UPDATE %I SET %I = $1 WHERE id = $2', k.child, k.col) USING pg_temp.tk_id(1, k.victim_n), pg_temp.tk_id(2, k.row_n);
      got := 'OK';
      RAISE EXCEPTION 'rollback' USING ERRCODE = 'TF999';
    EXCEPTION
      WHEN SQLSTATE 'TF999' THEN NULL;
      WHEN foreign_key_violation THEN GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME; got := 'fk:' || cname;
      WHEN OTHERS THEN got := 'other:' || SQLSTATE;
    END;
    IF got = 'fk:' || k.child || '_' || k.col || '_schoolId_fkey' OR (got = 'other:LV409' AND k.child = 'LeaveRequests') THEN
      n := n + 1;
    ELSE
      bad := bad || format('%s.%s UPDATE: %s', k.child, k.col, got);
    END IF;
    -- INSERT: the row as it is, removed, and written again with the other school's row in the column.
    BEGIN
      EXECUTE format('SELECT to_jsonb(c) FROM %I c WHERE id = $1', k.child) INTO snap USING pg_temp.tk_id(2, k.row_n);
      EXECUTE format('DELETE FROM %I WHERE id = $1', k.child) USING pg_temp.tk_id(2, k.row_n);
      EXECUTE format('INSERT INTO %1$I SELECT (jsonb_populate_record(NULL::%1$I, $1 || jsonb_build_object(%2$L, $2))).*', k.child, k.col) USING snap, pg_temp.tk_id(1, k.victim_n);
      got := 'OK';
      RAISE EXCEPTION 'rollback' USING ERRCODE = 'TF999';
    EXCEPTION
      WHEN SQLSTATE 'TF999' THEN NULL;
      WHEN foreign_key_violation THEN GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME; got := 'fk:' || cname;
      WHEN OTHERS THEN got := 'other:' || SQLSTATE;
    END;
    IF got = 'fk:' || k.child || '_' || k.col || '_schoolId_fkey' THEN
      n := n + 1;
    ELSE
      bad := bad || format('%s.%s INSERT: %s', k.child, k.col, got);
    END IF;
  END LOOP;
  -- The notice has no id: its key is the pair, and the pair is moved.
  BEGIN
    UPDATE "LeaveRequestNotices" SET "leaveRequestId" = pg_temp.tk_id(1, 15) WHERE "leaveRequestId" = pg_temp.tk_id(2, 15);
    got := 'OK';
    RAISE EXCEPTION 'rollback' USING ERRCODE = 'TF999';
  EXCEPTION
    WHEN SQLSTATE 'TF999' THEN NULL;
    WHEN foreign_key_violation THEN GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME; got := 'fk:' || cname;
    WHEN OTHERS THEN got := 'other:' || SQLSTATE;
  END;
  IF got = 'fk:LeaveRequestNotices_leaveRequestId_schoolId_fkey' THEN n := n + 1; ELSE bad := bad || format('LeaveRequestNotices.leaveRequestId UPDATE: %s', got); END IF;
  IF cardinality(bad) > 0 THEN
    RAISE EXCEPTION E'tenant keys 330: the database took, or refused otherwise than by the key, a row naming another school''s:\n%', array_to_string(bad, E'\n');
  END IF;
  IF n <> 75 THEN
    RAISE EXCEPTION 'tenant keys 330: % refusals by a key or its trigger, 75 expected (37 keys by two paths, less the two leave-request UPDATEs a trigger refuses first, plus the notice)', n;
  END IF;
END $$;
ROLLBACK;

-- A pupil's class is not a key of the migration's kind: the trigger refuses another school's class in the
-- key's own words, and a class of the pupil's school goes through.
BEGIN;
DO $$
DECLARE
  own_class uuid := gen_random_uuid();
  msg text;
BEGIN
  INSERT INTO "StudentGroups" (id, "schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt")
  VALUES (own_class, pg_temp.tk_id(2, 1), pg_temp.tk_id(2, 8), 'TK330 egen klass', 'CLASS', 7, now());
  UPDATE "Users" SET "studentGroupId" = own_class WHERE id = pg_temp.tk_id(2, 17);
  BEGIN
    UPDATE "Users" SET "studentGroupId" = pg_temp.tk_id(1, 6) WHERE id = pg_temp.tk_id(2, 17);
    RAISE EXCEPTION 'tenant keys 330: a pupil was given another school''s class';
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS msg = CONSTRAINT_NAME;
    IF msg IS DISTINCT FROM 'Users_studentGroupId_fkey' THEN RAISE EXCEPTION 'tenant keys 330: the refusal of another school''s class named %', msg; END IF;
  END;
  BEGIN
    INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
    VALUES (pg_temp.tk_id(2, 1), 'tk330-pupil@example.invalid', 'Tk', 'Pupil', 'STUDENT', gen_random_uuid(), true, pg_temp.tk_id(1, 6), now());
    RAISE EXCEPTION 'tenant keys 330: a pupil was written into another school''s class';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 334: what a removed parent does is what it did.
--
-- Each key's own parent (the row its column names) is removed, as the owner, in a
-- subtransaction that is rolled back: CASCADE removes the row; SET NULL nulls the
-- column and leaves "schoolId" and the rest of the row as they were (the key is
-- on the pair, and only the column is nulled); RESTRICT refuses and the row stays.
-- The two RESTRICT keys are tried one at a time, the other's rows moved off the type.
-- ---------------------------------------------------------------------------

BEGIN;
DO $$
DECLARE
  k record;
  parent_id uuid;
  school uuid;
  after_col uuid;
  after_school uuid;
  still boolean;
  cname text;
  refused boolean;
  ok int := 0;
BEGIN
  FOR k IN SELECT * FROM pg_temp.tk_keys() WHERE child <> 'LeaveRequestNotices' LOOP
    BEGIN
      EXECUTE format('SELECT %I, "schoolId" FROM %I WHERE id = $1', k.col, k.child) INTO parent_id, school USING pg_temp.tk_id(2, k.row_n);
      IF school IS DISTINCT FROM pg_temp.tk_id(2, 1) THEN
        RAISE EXCEPTION 'tenant keys 334: % of the fixture is not school B''s', k.child;
      END IF;
      IF parent_id IS NULL THEN
        -- A column the fixture leaves empty (who decided, who referred) names school B's counterpart of the row
        -- 331 points at school A.
        parent_id := pg_temp.tk_id(2, k.victim_n);
        EXECUTE format('UPDATE %I SET %I = $1 WHERE id = $2', k.child, k.col) USING parent_id, pg_temp.tk_id(2, k.row_n);
      END IF;
      refused := false;
      -- A room type is held by two RESTRICT keys (a room's and a subject's): each is tried alone, the rows of
      -- the other moved off the type, and the removal of a type for the keys that follow it out first.
      IF k.parent = 'RoomTypes' THEN
        IF k.child <> 'Rooms' THEN UPDATE "Rooms" SET "roomTypeId" = NULL WHERE "schoolId" = school; END IF;
        IF k.child <> 'Subjects' THEN UPDATE "Subjects" SET "requiredRoomTypeId" = NULL WHERE "schoolId" = school; END IF;
      END IF;
      IF k.del = 'r' THEN
        BEGIN
          EXECUTE format('DELETE FROM %I WHERE id = $1', k.parent) USING parent_id;
        EXCEPTION WHEN restrict_violation OR foreign_key_violation THEN
          GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
          refused := true;
          IF cname IS DISTINCT FROM k.child || '_' || k.col || '_schoolId_fkey' THEN
            RAISE EXCEPTION 'tenant keys 334: removing the type was refused by % and not by %', cname, k.child || '_' || k.col || '_schoolId_fkey';
          END IF;
        END;
        IF NOT refused THEN RAISE EXCEPTION 'tenant keys 334: % % did not refuse the removal of its parent', k.child, k.col; END IF;
      ELSE
        EXECUTE format('DELETE FROM %I WHERE id = $1', k.parent) USING parent_id;
        EXECUTE format('SELECT true, %I, "schoolId" FROM %I WHERE id = $1', k.col, k.child) INTO still, after_col, after_school USING pg_temp.tk_id(2, k.row_n);
        IF k.del = 'c' AND still IS NOT NULL THEN
          RAISE EXCEPTION 'tenant keys 334: % % did not follow its parent out', k.child, k.col;
        END IF;
        IF k.del = 'n' AND (still IS NOT TRUE OR after_col IS NOT NULL OR after_school IS DISTINCT FROM school) THEN
          RAISE EXCEPTION 'tenant keys 334: % % was %/% after its parent went, not null with the school kept', k.child, k.col, after_col, after_school;
        END IF;
      END IF;
      ok := ok + 1;
      RAISE EXCEPTION 'rollback' USING ERRCODE = 'TF999';
    EXCEPTION WHEN SQLSTATE 'TF999' THEN NULL;
    END;
  END LOOP;
  IF ok <> 37 THEN RAISE EXCEPTION 'tenant keys 334: % keys of 37 removed their parent', ok; END IF;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 334, the other half: a parent moved to another school is not followed.
--
-- A room type of school B with one room of B's, moved to school A by an UPDATE of its "schoolId" (the owner;
-- no role the API runs as can). ON UPDATE CASCADE would have carried the room along, and the move would have
-- passed in silence, a room in a school that never made it; NO ACTION refuses, and the refusal is the room's
-- key. The room type is a fresh one so that nothing but the room holds it.
-- ---------------------------------------------------------------------------

BEGIN;
DO $$
DECLARE
  rtype uuid := gen_random_uuid();
  room uuid := gen_random_uuid();
  cname text;
  moved boolean := false;
BEGIN
  INSERT INTO "RoomTypes" (id, "schoolId", name, "updatedAt") VALUES (rtype, pg_temp.tk_id(2, 1), 'TK334 flyttad typ', now());
  INSERT INTO "Rooms" (id, "schoolId", name, "roomTypeId", "updatedAt") VALUES (room, pg_temp.tk_id(2, 1), 'TK334 flyttat rum', rtype, now());
  BEGIN
    UPDATE "RoomTypes" SET "schoolId" = pg_temp.tk_id(1, 1) WHERE id = rtype;
    moved := true;
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
  END;
  IF moved THEN
    RAISE EXCEPTION 'tenant keys 334: a room type was moved to another school and its room was %', (SELECT "schoolId" FROM "Rooms" WHERE id = room);
  END IF;
  IF cname IS DISTINCT FROM 'Rooms_roomTypeId_schoolId_fkey' THEN
    RAISE EXCEPTION 'tenant keys 334: moving the room type was refused by % and not by Rooms_roomTypeId_schoolId_fkey', cname;
  END IF;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Kvittens (F4, 20270117091000), owner checks. What needs the owner: removing a
-- person, a request whose time has been moved, the lock a confirmation takes,
-- and a gallring run.
-- ---------------------------------------------------------------------------

CREATE FUNCTION pg_temp.kvo_expect(p_label text, p_got text, p_want text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_want THEN
    RAISE EXCEPTION E'kvittens %: got\n%\nwanted\n%', p_label, p_got, p_want;
  END IF;
END $$;
-- A statement the table must refuse, by a fragment of the constraint's name (or the SQLSTATE).
CREATE FUNCTION pg_temp.kvo_refuses(p_sql text, p_fragment text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RAISE EXCEPTION 'kvittens: accepted: %', p_sql;
EXCEPTION WHEN check_violation OR unique_violation OR foreign_key_violation OR not_null_violation THEN
  IF position(p_fragment IN SQLERRM) = 0 AND p_fragment <> SQLSTATE THEN
    RAISE EXCEPTION 'kvittens: % was refused, but not by %: %', p_sql, p_fragment, SQLERRM;
  END IF;
END $$;
-- The school's people by e-mail, and a request written as the owner (no login: the author is given).
CREATE FUNCTION pg_temp.kvo_user(p_email text) RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM "Users" WHERE email = p_email || '@example.invalid'
$$;
CREATE FUNCTION pg_temp.kvo_request(p_school uuid, p_author uuid, p_title text, p_rule "AckRule", p_pairs text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  req uuid := gen_random_uuid();
  pair text;
BEGIN
  INSERT INTO "AckRequests" (id, "schoolId", "authorId", title, body, rule) VALUES (req, p_school, p_author, p_title, 'Text för ' || p_title, p_rule);
  FOREACH pair IN ARRAY string_to_array(p_pairs, ',') LOOP
    INSERT INTO "AckReceipts" ("requestId", "schoolId", "studentId", "guardianId")
    VALUES (req, p_school, pg_temp.kvo_user('kv-' || split_part(pair, ':', 1)), pg_temp.kvo_user('kv-' || split_part(pair, ':', 2)));
  END LOOP;
  RETURN req;
END $$;

-- 370o: the constraints, what removing a person takes, and the keys' indexes.
BEGIN;
DO $$
DECLARE
  school uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-kvittens-school');
  full_ uuid := pg_temp.kvo_user('kv-full');
  author uuid;
  req uuid;
  fk record;
BEGIN
  -- An author the owner names is kept, and the name is the person's.
  req := pg_temp.kvo_request(school, full_, 'Ägd', 'ANY', 'p1:g1');
  PERFORM pg_temp.kvo_expect('370o owner''s request keeps its author', (SELECT "authorName" FROM "AckRequests" WHERE id = req), 'Kvittens Full');
  -- Without an author there is no name, and the CHECK says so.
  PERFORM pg_temp.kvo_refuses(format($q$INSERT INTO "AckRequests" ("schoolId", title, body) VALUES (%L, 'T', 'B')$q$, school), 'an_author_has_a_name');
  -- An author of another school is no author of this one's.
  PERFORM pg_temp.kvo_refuses(format($q$INSERT INTO "AckRequests" ("schoolId", "authorId", title, body) VALUES (%L, %L, 'T', 'B')$q$, school, pg_temp.kvo_user('kv-annan-admin')), 'an_author_has_a_name');
  -- A receipt filed under another school than its request's is refused by the composite key.
  PERFORM pg_temp.kvo_refuses(format($q$INSERT INTO "AckReceipts" ("requestId", "schoolId", "studentId", "guardianId") VALUES (%L, %L, %L, %L)$q$,
                                     req, (SELECT id FROM "Schools" WHERE slug = 'rls-kvittens-annan'), pg_temp.kvo_user('kv-annan-p'), pg_temp.kvo_user('kv-annan-g')), 'AckReceipts_requestId_schoolId_fkey');
  -- A guardian of one school asked about a pupil of another is refused by the keys to Users.
  PERFORM pg_temp.kvo_refuses(format($q$INSERT INTO "AckReceipts" ("requestId", "schoolId", "studentId", "guardianId") VALUES (%L, %L, %L, %L)$q$,
                                     req, school, pg_temp.kvo_user('kv-annan-p'), pg_temp.kvo_user('kv-g1')), '_studentId_schoolId_fkey');

  -- Removing the author keeps the request, with the name, and the school.
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (school, 'kv-leaving@example.invalid', 'Kvittens', 'Lämnar', 'TEACHER', gen_random_uuid(), true, now()) RETURNING id INTO author;
  req := pg_temp.kvo_request(school, author, 'Lämnarens', 'ANY', 'p1:g1');
  DELETE FROM "Users" WHERE id = author;
  PERFORM pg_temp.kvo_expect('370o a removed author', (SELECT concat_ws('|', "authorId" IS NULL, "schoolId" = school, "authorName") FROM "AckRequests" WHERE id = req), 't|t|Kvittens Lämnar');
  -- Removing a guardian takes their receipts; removing a pupil takes all that ask about the pupil; the request, all under it.
  req := pg_temp.kvo_request(school, full_, 'Tre rader', 'ALL', 'p1:g1,p1:g2,p2:g1');
  DELETE FROM "Users" WHERE id = pg_temp.kvo_user('kv-g2');
  PERFORM pg_temp.kvo_expect('370o a removed guardian', (SELECT count(*)::text FROM "AckReceipts" WHERE "requestId" = req), '2');
  DELETE FROM "Users" WHERE id = pg_temp.kvo_user('kv-p2');
  PERFORM pg_temp.kvo_expect('370o a removed pupil', (SELECT count(*)::text FROM "AckReceipts" WHERE "requestId" = req), '1');
  DELETE FROM "AckRequests" WHERE id = req;
  PERFORM pg_temp.kvo_expect('370o a removed request', (SELECT count(*)::text FROM "AckReceipts" WHERE "requestId" = req), '0');

  -- Every foreign key of the three tables has an index that starts with its columns (the FK index audit).
  FOR fk IN
    SELECT c.conname, c.conrelid::regclass::text AS tbl
      FROM pg_constraint c
     WHERE c.contype = 'f' AND c.conrelid::regclass::text IN ('"AckSettings"', '"AckRequests"', '"AckReceipts"')
       AND NOT EXISTS (
             SELECT 1 FROM pg_index i
              WHERE i.indrelid = c.conrelid AND i.indisvalid
                AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] = c.conkey)
  LOOP
    RAISE EXCEPTION 'kvittens 370o: % on % has no index that starts with its columns', fk.conname, fk.tbl;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE c.relname IN ('AckSettings', 'AckRequests', 'AckReceipts') AND NOT i.indisvalid) THEN
    RAISE EXCEPTION 'kvittens 370o: an index is invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'AckRequests_stamp' AND tgrelid = '"AckRequests"'::regclass AND tgenabled = 'O')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'AckSettings_stamp' AND tgrelid = '"AckSettings"'::regclass AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'kvittens 370o: a stamp is missing or off';
  END IF;

  -- The outcome of a reminder: only a sent one has a time, and only a request with a reminder has an outcome.
  req := pg_temp.kvo_request(school, full_, 'Utfall', 'ANY', 'p1:g1');
  PERFORM pg_temp.kvo_refuses(format($q$UPDATE "AckRequests" SET "reminderSentAt" = now() WHERE id = %L$q$, req), 'only_a_sent_reminder_has_a_time');
  PERFORM pg_temp.kvo_refuses(format($q$UPDATE "AckRequests" SET "reminderOutcome" = 'SENT' WHERE id = %L$q$, req), 'only_a_sent_reminder_has_a_time');
  PERFORM pg_temp.kvo_refuses(format($q$UPDATE "AckRequests" SET "reminderOutcome" = 'STOPPED', "reminderSentAt" = now() WHERE id = %L$q$, req), 'only_a_sent_reminder_has_a_time');
  UPDATE "AckRequests" SET "reminderOutcome" = 'SENT', "reminderSentAt" = now() WHERE id = req;
  UPDATE "AckRequests" SET "reminderOutcome" = 'NOT_NEEDED', "reminderSentAt" = NULL WHERE id = req;
  UPDATE "AckRequests" SET "remindAt" = NULL, "reminderOutcome" = NULL, "reminderSentAt" = NULL WHERE id = req;
  PERFORM pg_temp.kvo_refuses(format($q$UPDATE "AckRequests" SET "reminderOutcome" = 'STOPPED' WHERE id = %L$q$, req), 'a_reminder_was_due');
END $$;
ROLLBACK;

-- 370o: the limits. A person writes ten requests an hour and a school 20 000 receipts a day (KV429, KV428),
-- as a logged-in writer; the owner (this script, a migration) is not counted against and writes as it likes. The
-- claims are set under the owner so the statement runs the triggers as a login would; the policies are the
-- policy suite's (370).
BEGIN;
DO $$
DECLARE
  school uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-kvittens-school');
  other uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-kvittens-annan');
  full_ uuid := pg_temp.kvo_user('kv-full');
  req uuid;
  i integer;
BEGIN
  -- Ten requests made the owner's way, an hour and a half ago, count for nothing when the person is logged in.
  FOR i IN 1..10 LOOP
    req := pg_temp.kvo_request(school, full_, 'Gammal ' || i, 'ANY', 'p1:g1');
    UPDATE "AckRequests" SET "createdAt" = now() - interval '90 minutes' WHERE id = req;
  END LOOP;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-f40000000001')::text, true);
  FOR i IN 1..10 LOOP
    INSERT INTO "AckRequests" ("schoolId", title, body) VALUES (school, 'Ny ' || i, 'B');
  END LOOP;
  BEGIN
    INSERT INTO "AckRequests" ("schoolId", title, body) VALUES (school, 'Elfte', 'B');
    RAISE EXCEPTION 'kvittens 370o: an eleventh request in an hour was written';
  EXCEPTION WHEN SQLSTATE 'KV429' THEN NULL;
  END;
  -- The window moves: when the oldest of the ten is more than an hour old the person writes again.
  UPDATE "AckRequests" SET "createdAt" = now() - interval '61 minutes' WHERE title = 'Ny 1';
  INSERT INTO "AckRequests" ("schoolId", title, body) VALUES (school, 'Efter en timme', 'B');
  -- The limit is per person: a colleague writes on, and so does the person in no other school's count.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-f40000000008')::text, true);
  INSERT INTO "AckRequests" ("schoolId", title, body) VALUES (school, 'Kollegan', 'B');
  PERFORM set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-f40000000031')::text, true);
  FOR i IN 1..10 LOOP
    INSERT INTO "AckRequests" ("schoolId", title, body) VALUES (other, 'Annans ' || i, 'B');
  END LOOP;
  -- And the owner is not a person: no claims, no count, any number.
  PERFORM set_config('request.jwt.claims', '', true);
  FOR i IN 1..12 LOOP
    PERFORM pg_temp.kvo_request(school, full_, 'Ägarens ' || i, 'ANY', 'p1:g1');
  END LOOP;
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE
  school uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-kvittens-school');
  other uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-kvittens-annan');
  t3 uuid := pg_temp.kvo_user('kv-t3');
  req uuid;
BEGIN
  -- A school's day: 19 999 receipts the owner's way (1 000 requests, twenty receipts each less one), then a person
  -- asks for one more (the 20 000th, which is allowed) and one more still (refused, with nothing written).
  INSERT INTO "AckRequests" (id, "schoolId", "authorId", title, body)
  SELECT gen_random_uuid(), school, t3, 'Dygn ' || g, 'B' FROM generate_series(1, 1000) g;
  INSERT INTO "AckReceipts" ("requestId", "schoolId", "studentId", "guardianId")
  SELECT q.id, school, p.id, gu.id
    FROM (SELECT id FROM "AckRequests" WHERE "schoolId" = school AND title LIKE 'Dygn %') q
    CROSS JOIN (SELECT id FROM "Users" WHERE "schoolId" = school AND role = 'STUDENT' AND email LIKE 'kv-p_@example.invalid') p
    CROSS JOIN (SELECT id FROM "Users" WHERE "schoolId" = school AND role = 'GUARDIAN' AND email LIKE 'kv-g_@example.invalid') gu
   LIMIT 19999;
  PERFORM pg_temp.kvo_expect('370o the owner''s day', (SELECT count(*)::text FROM "AckReceipts" WHERE "schoolId" = school AND "createdAt" > now() - interval '24 hours'), '19999');

  PERFORM set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-f40000000001')::text, true);
  INSERT INTO "AckRequests" (id, "schoolId", title, body) VALUES (gen_random_uuid(), school, 'Dagens', 'B') RETURNING id INTO req;
  INSERT INTO "AckReceipts" ("requestId", "schoolId", "studentId", "guardianId") VALUES (req, school, pg_temp.kvo_user('kv-p1'), pg_temp.kvo_user('kv-g1'));
  BEGIN
    INSERT INTO "AckReceipts" ("requestId", "schoolId", "studentId", "guardianId")
    VALUES (req, school, pg_temp.kvo_user('kv-p1'), pg_temp.kvo_user('kv-g2')), (req, school, pg_temp.kvo_user('kv-p3'), pg_temp.kvo_user('kv-g3'));
    RAISE EXCEPTION 'kvittens 370o: a school''s 20 002nd receipt in a day was written';
  EXCEPTION WHEN SQLSTATE 'KV428' THEN NULL;
  END;
  -- The statement was refused whole: neither of its rows is there.
  PERFORM pg_temp.kvo_expect('370o a refused statement writes nothing', (SELECT count(*)::text FROM "AckReceipts" WHERE "requestId" = req), '1');
  -- Another school is another count; and the same school writes again when the day has moved on.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-f40000000031')::text, true);
  INSERT INTO "AckRequests" (id, "schoolId", title, body) VALUES (gen_random_uuid(), other, 'Annans dag', 'B') RETURNING id INTO req;
  INSERT INTO "AckReceipts" ("requestId", "schoolId", "studentId", "guardianId") VALUES (req, other, pg_temp.kvo_user('kv-annan-p'), pg_temp.kvo_user('kv-annan-g'));
  PERFORM set_config('request.jwt.claims', '', true);
  UPDATE "AckReceipts" SET "createdAt" = now() - interval '25 hours' WHERE "schoolId" = school AND "requestId" IN (SELECT id FROM "AckRequests" WHERE title LIKE 'Dygn %');
  PERFORM set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-f40000000001')::text, true);
  INSERT INTO "AckReceipts" ("requestId", "schoolId", "studentId", "guardianId")
  VALUES ((SELECT id FROM "AckRequests" WHERE title = 'Dagens'), school, pg_temp.kvo_user('kv-p1'), pg_temp.kvo_user('kv-g2'));
END $$;
ROLLBACK;

-- 372o: what a confirmation locks on the guardian's links. A link that is removed waits for the
-- confirmation (FOR KEY SHARE) or is gone before it, and the confirmation then refuses (KV410): the
-- row locks of the transaction show as its xmax. The request's own lock (FOR SHARE, against the
-- reminder pass's FOR UPDATE SKIP LOCKED) cannot be read this way, since writing its receipts has
-- key-shared it already: the adapter probe (probe-kvittens.ts) holds a confirmation open on one
-- connection and runs the pass on another.
BEGIN;
DO $$
DECLARE
  school uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-kvittens-school');
  req uuid;
  me text := pg_current_xact_id()::xid::text;
  g1 uuid := pg_temp.kvo_user('kv-g1');
BEGIN
  req := pg_temp.kvo_request(school, pg_temp.kvo_user('kv-full'), 'Lås', 'ALL', 'p1:g1,p2:g1');
  PERFORM set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-f40000000021')::text, true);
  IF EXISTS (SELECT 1 FROM "GuardianStudents" WHERE xmax::text = me) THEN
    RAISE EXCEPTION 'kvittens 372o: a link was locked before the confirmation';
  END IF;
  PERFORM app.ack_confirm(req);
  PERFORM pg_temp.kvo_expect('372o the guardian''s links are key-shared',
    (SELECT string_agg((xmax::text = me)::text, ',' ORDER BY "studentId") FROM "GuardianStudents" WHERE "guardianId" = g1), 'true,true');
  IF (SELECT count(*) FROM "GuardianStudents" WHERE xmax::text = me) <> 2 THEN
    RAISE EXCEPTION 'kvittens 372o: a confirmation locked a link that is not the guardian''s, or too few';
  END IF;
END $$;
ROLLBACK;

-- 372o: a confirmation marks the guardian's own notices about the request as read (the request and the
-- reminder: nothing is left to do), and no others: not another request's, not another type's that happens to
-- carry the id, not the other guardian's.
BEGIN;
DO $$
DECLARE
  school uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-kvittens-school');
  full_ uuid := pg_temp.kvo_user('kv-full');
  g1 uuid := pg_temp.kvo_user('kv-g1');
  g2 uuid := pg_temp.kvo_user('kv-g2');
  req uuid;
  other_req uuid;
  first_read timestamptz;
  seen text;
BEGIN
  req := pg_temp.kvo_request(school, full_, 'Läst', 'ANY', 'p1:g1,p1:g2');
  other_req := pg_temp.kvo_request(school, full_, 'Annan', 'ANY', 'p1:g1');
  INSERT INTO "Notifications" ("schoolId", "userId", type, meta) VALUES
    (school, g1, 'ACK_REQUESTED', jsonb_build_object('requestId', req, 'title', 'Läst')),
    (school, g1, 'ACK_REMINDER', jsonb_build_object('requestId', req, 'title', 'Läst')),
    (school, g1, 'ACK_REQUESTED', jsonb_build_object('requestId', other_req, 'title', 'Annan')),
    (school, g1, 'LESSON_CANCELLED', jsonb_build_object('requestId', req)),
    (school, g2, 'ACK_REQUESTED', jsonb_build_object('requestId', req, 'title', 'Läst'));
  PERFORM set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-f40000000021')::text, true);
  PERFORM app.ack_confirm(req);
  PERFORM set_config('request.jwt.claims', '', true);
  SELECT string_agg((CASE n."userId" WHEN g1 THEN 'g1' ELSE 'g2' END) || ' ' || n.type::text || ' ' || coalesce(n.meta ->> 'title', '-') || ' ' || (n."readAt" IS NOT NULL)::text,
                    E'\n' ORDER BY n."userId" = g1 DESC, n.type::text, n.meta ->> 'title')
    INTO seen FROM "Notifications" n WHERE n."schoolId" = school AND n.type IN ('ACK_REQUESTED', 'ACK_REMINDER', 'LESSON_CANCELLED');
  PERFORM pg_temp.kvo_expect('372o which notices a confirmation reads', seen,
    E'g1 ACK_REMINDER Läst true\ng1 ACK_REQUESTED Annan false\ng1 ACK_REQUESTED Läst true\ng1 LESSON_CANCELLED - false\ng2 ACK_REQUESTED Läst false');
  -- A second tap changes nothing, the time of the reading included.
  SELECT min("readAt") INTO first_read FROM "Notifications" WHERE "userId" = g1 AND type = 'ACK_REMINDER';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-f40000000021')::text, true);
  PERFORM app.ack_confirm(req);
  PERFORM set_config('request.jwt.claims', '', true);
  IF (SELECT min("readAt") FROM "Notifications" WHERE "userId" = g1 AND type = 'ACK_REMINDER') IS DISTINCT FROM first_read THEN
    RAISE EXCEPTION 'kvittens 372o: a second tap moved the time a notice was read';
  END IF;
END $$;
ROLLBACK;

-- 373o: the reminder. Which guardians, how many, how each request ends, and never twice. A request is made due
-- by moving its time, which no role may do. The pass is the job's: no claims here, as the delivery's door has none.
BEGIN;
DO $$
DECLARE
  school uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-kvittens-school');
  other uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-kvittens-annan');
  full_ uuid := pg_temp.kvo_user('kv-full');
  q1 uuid; q2 uuid; q3 uuid; q4 uuid; q5 uuid; q6 uuid; q7 uuid; q9 uuid; q10 uuid; q11 uuid;
  told text;
  n integer;
  ids uuid[];
  mine uuid[];
BEGIN
  INSERT INTO "AckSettings" ("schoolId", enabled, "remindAfterDays") VALUES (school, true, 2), (other, true, 2)
    ON CONFLICT ("schoolId") DO UPDATE SET enabled = true, "remindAfterDays" = 2;
  -- Q1  ALL, P1 asks G1 and G2, P2 asks G1: due, nobody has confirmed.
  q1 := pg_temp.kvo_request(school, full_, 'Q1', 'ALL', 'p1:g1,p1:g2,p2:g1');
  -- Q2  ANY, P1 asks G1 and G2: due, G1 has confirmed so the pupil is met, and G2 is reminded all the same:
  --     whether the other guardian has answered is not something a missing reminder may tell.
  q2 := pg_temp.kvo_request(school, full_, 'Q2', 'ANY', 'p1:g1,p1:g2');
  UPDATE "AckReceipts" SET "ackedAt" = now() WHERE "requestId" = q2 AND "guardianId" = pg_temp.kvo_user('kv-g1');
  -- Q3  ALL, P1 asks G1 and G2: due, G2 has confirmed, so G1 alone is asked.
  q3 := pg_temp.kvo_request(school, full_, 'Q3', 'ALL', 'p1:g1,p1:g2');
  UPDATE "AckReceipts" SET "ackedAt" = now() WHERE "requestId" = q3 AND "guardianId" = pg_temp.kvo_user('kv-g2');
  -- Q4  not yet due (two days off).
  q4 := pg_temp.kvo_request(school, full_, 'Q4', 'ALL', 'p3:g3');
  -- Q5  due 40 days ago: closed without a word.
  q5 := pg_temp.kvo_request(school, full_, 'Q5', 'ALL', 'p3:g3');
  -- Q6  ALL, P4's only guardian has no link any more: nobody to ask.
  q6 := pg_temp.kvo_request(school, full_, 'Q6', 'ALL', 'p4:g4');
  DELETE FROM "GuardianStudents" WHERE "guardianId" = pg_temp.kvo_user('kv-g4') AND "studentId" = pg_temp.kvo_user('kv-p4');
  -- Q7  the other school's, due: told in its own school, to its own guardian.
  q7 := pg_temp.kvo_request(other, pg_temp.kvo_user('kv-annan-admin'), 'Q7', 'ALL', 'annan-p:annan-g');
  -- Q9  due, stopped by its author before the pass: nobody is told.
  q9 := pg_temp.kvo_request(school, full_, 'Q9', 'ANY', 'p3:g3');
  -- Q10 due, everybody has confirmed: nothing to remind.
  q10 := pg_temp.kvo_request(school, full_, 'Q10', 'ANY', 'p3:g3');
  UPDATE "AckReceipts" SET "ackedAt" = now() WHERE "requestId" = q10;
  UPDATE "AckRequests" SET "remindAt" = now() - interval '1 hour' WHERE id IN (q1, q2, q3, q6, q7, q9, q10);
  UPDATE "AckRequests" SET "remindAt" = now() - interval '40 days' WHERE id = q5;
  mine := ARRAY[q1, q2, q3, q4, q5, q6, q7, q9, q10];
  PERFORM set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-f40000000001')::text, true);
  PERFORM pg_temp.kvo_expect('373o stopped before the pass', app.ack_stop_reminder(q9)::text, 'STOPPED');
  PERFORM set_config('request.jwt.claims', '', true);

  -- The queue: what is due and not dealt with, the oldest first, bounded; nothing of Q4 (not yet), Q9 (stopped).
  SELECT array_agg(r.request_id ORDER BY r.ord) INTO ids FROM (SELECT d.request_id, row_number() OVER () AS ord FROM app.ack_remind_queue(100) d) r;
  IF NOT (ids @> ARRAY[q1, q2, q3, q5, q6, q7, q10]) OR q4 = ANY (ids) OR q9 = ANY (ids) THEN
    RAISE EXCEPTION 'kvittens 373o: the queue is not what is due and not dealt with';
  END IF;
  -- Oldest first: Q5 (forty days) before the ones that fell due an hour ago.
  IF array_position(ids, q5) > least(array_position(ids, q1), array_position(ids, q2), array_position(ids, q3), array_position(ids, q6), array_position(ids, q7), array_position(ids, q10)) THEN
    RAISE EXCEPTION 'kvittens 373o: the queue does not begin with the oldest (Q5, forty days)';
  END IF;
  IF (SELECT count(*) FROM app.ack_remind_queue(2)) <> 2 OR (SELECT count(*) FROM app.ack_remind_queue(0)) <> 0 THEN
    RAISE EXCEPTION 'kvittens 373o: the queue does not keep to its bound';
  END IF;

  -- A logged-in caller is handed nothing from either step, and writes nothing, with these due.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-f40000000021')::text, true);
  IF EXISTS (SELECT 1 FROM app.ack_remind_queue(100)) OR EXISTS (SELECT 1 FROM app.ack_remind_request(q1)) THEN
    RAISE EXCEPTION 'kvittens 373o: a guardian was handed the queue or a reminder';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-f40000000001')::text, true);
  IF EXISTS (SELECT 1 FROM app.ack_remind_queue(100)) OR EXISTS (SELECT 1 FROM app.ack_remind_request(q1)) THEN
    RAISE EXCEPTION 'kvittens 373o: an administrator was handed the queue or a reminder';
  END IF;
  PERFORM set_config('request.jwt.claims', '', true);
  IF (SELECT "reminderOutcome" FROM "AckRequests" WHERE id = q1) IS NOT NULL OR EXISTS (SELECT 1 FROM "Notifications" WHERE type = 'ACK_REMINDER') THEN
    RAISE EXCEPTION 'kvittens 373o: a logged-in caller moved the pass';
  END IF;

  -- The pass, a request at a time: Q1 tells G1 once (two children) and G2; Q2 tells G2; Q3 tells G1; Q7 the other school's guardian.
  SELECT string_agg(r.title || ' ' || substr(u.email, 4, 3) || ' ' || (r.school_id = a."schoolId")::text || ' ' || (r.email = u.email)::text,
                    ', ' ORDER BY r.title, u.email)
    INTO told
    FROM (SELECT d.notification_id, d.user_id, d.school_id, d.email, d.meta ->> 'title' AS title
            FROM unnest(ARRAY[q1, q2, q3, q4, q5, q6, q7, q9, q10]) AS due(request_id), LATERAL app.ack_remind_request(due.request_id) d) r
    JOIN "Users" u ON u.id = r.user_id
    JOIN "AckRequests" a ON a.title = r.title AND a."schoolId" = r.school_id;
  PERFORM pg_temp.kvo_expect('373o who is reminded', told, 'Q1 g1@ true true, Q1 g2@ true true, Q2 g2@ true true, Q3 g1@ true true, Q7 ann true true');
  PERFORM pg_temp.kvo_expect('373o the notices written',
    (SELECT string_agg(n.type::text || ' ' || (n.meta ->> 'title'), ', ' ORDER BY n.meta ->> 'title', n."userId"::text) FROM "Notifications" n WHERE n.type = 'ACK_REMINDER'),
    'ACK_REMINDER Q1, ACK_REMINDER Q1, ACK_REMINDER Q2, ACK_REMINDER Q3, ACK_REMINDER Q7');

  -- Receipts marked: all of Q1's, G2's of Q2, only G1's of Q3, none of Q4, Q5, Q6, Q9, Q10.
  PERFORM pg_temp.kvo_expect('373o receipts reminded',
    (SELECT string_agg(q.title || ':' || (SELECT count(*) FROM "AckReceipts" r WHERE r."requestId" = q.id AND r."remindedAt" IS NOT NULL), ' ' ORDER BY q.title)
       FROM "AckRequests" q WHERE q.id IN (q1, q2, q3, q4, q5, q6, q7, q9, q10)),
    'Q1:3 Q10:0 Q2:1 Q3:1 Q4:0 Q5:0 Q6:0 Q7:1 Q9:0');
  -- How each ended, and a time only where something was sent.
  PERFORM pg_temp.kvo_expect('373o how the reminders ended',
    (SELECT string_agg(q.title || ':' || coalesce(q."reminderOutcome"::text, '-') || ':' || (q."reminderSentAt" IS NOT NULL)::text, ' ' ORDER BY q.title)
       FROM "AckRequests" q WHERE q.id IN (q1, q2, q3, q4, q5, q6, q7, q9, q10)),
    'Q1:SENT:true Q10:NOT_NEEDED:false Q2:SENT:true Q3:SENT:true Q4:-:false Q5:LAPSED:false Q6:NOT_NEEDED:false Q7:SENT:true Q9:STOPPED:false');
  -- Never twice: none of these is in the queue again, and the request is not asked again by name.
  SELECT array_agg(d.request_id) INTO ids FROM app.ack_remind_queue(1000) d WHERE d.request_id = ANY (mine);
  IF ids IS NOT NULL THEN RAISE EXCEPTION 'kvittens 373o: a second queue has % of these requests, wanted none', ids; END IF;
  SELECT count(*) INTO n FROM app.ack_remind_request(q1);
  IF n <> 0 THEN RAISE EXCEPTION 'kvittens 373o: a second pass over Q1 reminded % guardians', n; END IF;
  -- Even a request opened again (which no role may do) asks nobody twice: the receipt remembers, and it ends as needing no one.
  UPDATE "AckRequests" SET "reminderOutcome" = NULL, "reminderSentAt" = NULL WHERE id IN (q1, q3);
  SELECT count(*) INTO n FROM (SELECT * FROM app.ack_remind_request(q1) UNION ALL SELECT * FROM app.ack_remind_request(q3)) x;
  IF n <> 0 THEN RAISE EXCEPTION 'kvittens 373o: a request opened again reminded % guardians who had been reminded', n; END IF;
  IF (SELECT string_agg("reminderOutcome"::text, ',') FROM "AckRequests" WHERE id IN (q1, q3)) <> 'NOT_NEEDED,NOT_NEEDED' THEN
    RAISE EXCEPTION 'kvittens 373o: a request opened again did not end as needing no reminder';
  END IF;
  -- Q4 comes due: it is told then, and only then.
  UPDATE "AckRequests" SET "remindAt" = now() - interval '1 minute' WHERE id = q4;
  SELECT count(*) INTO n FROM app.ack_remind_request(q4);
  IF n <> 1 THEN RAISE EXCEPTION 'kvittens 373o: Q4 reminded % guardians when it came due', n; END IF;
  -- A request that is not due, one that does not exist and a null are nothing.
  q11 := pg_temp.kvo_request(school, full_, 'Q11', 'ANY', 'p3:g3');
  IF EXISTS (SELECT 1 FROM app.ack_remind_request(q11)) OR EXISTS (SELECT 1 FROM app.ack_remind_request(gen_random_uuid())) OR EXISTS (SELECT 1 FROM app.ack_remind_request(NULL)) THEN
    RAISE EXCEPTION 'kvittens 373o: a request that is not due, or no request, was reminded';
  END IF;
  -- A school with no reminder (NULL days) gets a request with no time and is never told.
  UPDATE "AckSettings" SET "remindAfterDays" = NULL WHERE "schoolId" = school;
  q4 := pg_temp.kvo_request(school, full_, 'Q8', 'ANY', 'p3:g3');
  IF (SELECT "remindAt" FROM "AckRequests" WHERE id = q4) IS NOT NULL THEN RAISE EXCEPTION 'kvittens 373o: a school with no reminder gave a request a time'; END IF;
  IF EXISTS (SELECT 1 FROM app.ack_remind_queue(100) d WHERE d.request_id = q4) OR EXISTS (SELECT 1 FROM app.ack_remind_request(q4)) THEN
    RAISE EXCEPTION 'kvittens 373o: a request with no reminder time was reminded';
  END IF;
END $$;
ROLLBACK;

-- 373o: turning kvittens off stops the reminders of the school's requests whose time comes while it is off, for good:
-- turned on again, the pass does not send what fell due in between (OFF), and a request not yet due is reminded as before.
BEGIN;
DO $$
DECLARE
  school uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-kvittens-school');
  full_ uuid := pg_temp.kvo_user('kv-full');
  due_ uuid; later uuid; n integer;
BEGIN
  INSERT INTO "AckSettings" ("schoolId", enabled, "remindAfterDays") VALUES (school, true, 2)
    ON CONFLICT ("schoolId") DO UPDATE SET enabled = true, "remindAfterDays" = 2;
  due_ := pg_temp.kvo_request(school, full_, 'Av 1', 'ANY', 'p1:g1');
  later := pg_temp.kvo_request(school, full_, 'Av 2', 'ANY', 'p3:g3');
  UPDATE "AckRequests" SET "remindAt" = now() - interval '1 hour' WHERE id = due_;
  UPDATE "AckSettings" SET enabled = false WHERE "schoolId" = school;
  SELECT count(*) INTO n FROM app.ack_remind_request(due_);
  IF n <> 0 THEN RAISE EXCEPTION 'kvittens 373o: % guardians were reminded in a school that has turned kvittens off', n; END IF;
  PERFORM pg_temp.kvo_expect('373o a reminder that fell due while off', (SELECT "reminderOutcome"::text FROM "AckRequests" WHERE id = due_), 'OFF');
  UPDATE "AckSettings" SET enabled = true WHERE "schoolId" = school;
  SELECT count(*) INTO n FROM app.ack_remind_request(due_);
  IF n <> 0 OR EXISTS (SELECT 1 FROM app.ack_remind_queue(100) d WHERE d.request_id = due_) THEN
    RAISE EXCEPTION 'kvittens 373o: turned on again, the reminder that fell due while off was sent';
  END IF;
  -- The one that came due after it was turned on again is reminded.
  UPDATE "AckRequests" SET "remindAt" = now() - interval '1 minute' WHERE id = later;
  SELECT count(*) INTO n FROM app.ack_remind_request(later);
  IF n <> 1 THEN RAISE EXCEPTION 'kvittens 373o: a request that came due with kvittens on reminded % guardians', n; END IF;
END $$;
ROLLBACK;

-- 374o: gallring. A request goes with the school's choice for NOTIFICATIONS, by the day it was
-- made, with the receipts under it, in the same batch as the notices.
BEGIN;
DO $$
DECLARE
  school uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-kvittens-school');
  other uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-kvittens-annan');
  admin uuid := pg_temp.kvo_user('kv-full');
  today date := (now() AT TIME ZONE 'Europe/Stockholm')::date;
  old1 uuid; old2 uuid; recent uuid; foreign_ uuid;
  run uuid;
  n integer;
  counts jsonb;
  tbls text[];
BEGIN
  old1 := pg_temp.kvo_request(school, admin, 'Gammal 1', 'ALL', 'p1:g1,p1:g2,p2:g1');
  old2 := pg_temp.kvo_request(school, admin, 'Gammal 2', 'ANY', 'p3:g3');
  recent := pg_temp.kvo_request(school, admin, 'Ny', 'ANY', 'p3:g3');
  foreign_ := pg_temp.kvo_request(other, pg_temp.kvo_user('kv-annan-admin'), 'Annans gamla', 'ANY', 'annan-p:annan-g');
  UPDATE "AckRequests" SET "createdAt" = now() - interval '900 days' WHERE id IN (old1, foreign_);
  UPDATE "AckRequests" SET "createdAt" = now() - interval '400 days' WHERE id = old2;
  UPDATE "AckRequests" SET "createdAt" = now() - interval '30 days' WHERE id = recent;
  ALTER TABLE "RetentionDecisions" DISABLE TRIGGER "RetentionDecisions_stamped";
  INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision, months, reference, "decidedById", "decidedAt")
  VALUES (school, 'NOTIFICATIONS', 'PURGE_AFTER', 12, 'KV 374', admin, now() - interval '2 days');
  ALTER TABLE "RetentionDecisions" ENABLE TRIGGER "RetentionDecisions_stamped";

  -- What is due, as the one predicate answers it: the two old requests of this school, under NOTIFICATIONS and nothing else.
  SELECT array_agg(DISTINCT d.tbl) INTO tbls FROM app.gallring_due(school, 'NOTIFICATIONS', today - 365, today) d WHERE d.tbl = 'AckRequests';
  IF tbls IS DISTINCT FROM ARRAY['AckRequests'] THEN RAISE EXCEPTION 'kvittens 374o: the kinds due are %', tbls; END IF;
  IF (SELECT count(*) FROM app.gallring_due(school, 'NOTIFICATIONS', today - 365, today) d WHERE d.tbl = 'AckRequests') <> 2
     OR NOT EXISTS (SELECT 1 FROM app.gallring_due(school, 'NOTIFICATIONS', today - 365, today) d WHERE d.id = old1)
     OR NOT EXISTS (SELECT 1 FROM app.gallring_due(school, 'NOTIFICATIONS', today - 365, today) d WHERE d.id = old2) THEN
    RAISE EXCEPTION 'kvittens 374o: not the two requests made before the cutoff are due';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['ATTENDANCE', 'ABSENCE_REPORTS', 'LEAVE_REQUESTS', 'CHANGE_LOGS', 'ABSENCE_REASONS', 'ACCESS_LOG', 'COVER_REQUESTS']::"RetentionDataType"[]) t
              WHERE EXISTS (SELECT 1 FROM app.gallring_due(school, t, today - 365, today) d WHERE d.tbl = 'AckRequests')) THEN
    RAISE EXCEPTION 'kvittens 374o: the requests are due under another kind than NOTIFICATIONS';
  END IF;
  IF EXISTS (SELECT 1 FROM app.gallring_due(other, 'NOTIFICATIONS', today - 365, today) d WHERE d.id IN (old1, old2)) THEN
    RAISE EXCEPTION 'kvittens 374o: a school''s requests are due under another school''s run';
  END IF;

  -- The night: the two old requests go with their five receipts; the recent one and the other school's stay.
  run := app.gallring_begin(school, now());
  LOOP
    n := app.gallring_purge(run, 'NOTIFICATIONS', 1);
    EXIT WHEN n = 0;
  END LOOP;
  PERFORM app.gallring_finish(run, '{}', now());
  PERFORM pg_temp.kvo_expect('374o what is left',
    (SELECT string_agg(q.title || ':' || (SELECT count(*) FROM "AckReceipts" r WHERE r."requestId" = q.id), ' ' ORDER BY q.title) FROM "AckRequests" q WHERE q.id IN (old1, old2, recent, foreign_)),
    'Annans gamla:1 Ny:1');
  SELECT g.counts INTO counts FROM "GallringRuns" g WHERE g.id = run;
  IF (counts ->> 'NOTIFICATIONS')::integer <> 2 THEN RAISE EXCEPTION 'kvittens 374o: the run counts % under NOTIFICATIONS, not the two requests', counts ->> 'NOTIFICATIONS'; END IF;

  -- The batch is shared with the notices: with a budget of one the run is not complete until nothing is left.
  old1 := pg_temp.kvo_request(school, admin, 'Gammal 3', 'ANY', 'p3:g3');
  old2 := pg_temp.kvo_request(school, admin, 'Gammal 4', 'ANY', 'p3:g3');
  UPDATE "AckRequests" SET "createdAt" = now() - interval '800 days' WHERE id IN (old1, old2);
  run := app.gallring_begin(school, now());
  IF app.gallring_purge(run, 'NOTIFICATIONS', 1) <> 1 THEN RAISE EXCEPTION 'kvittens 374o: a batch of one took more or less than one request'; END IF;
  IF (SELECT (complete ->> 'NOTIFICATIONS')::boolean FROM "GallringRuns" WHERE id = run) THEN
    RAISE EXCEPTION 'kvittens 374o: a full batch said nothing was left';
  END IF;
  IF app.gallring_purge(run, 'NOTIFICATIONS', 1) <> 1 OR app.gallring_purge(run, 'NOTIFICATIONS', 1) <> 0 THEN
    RAISE EXCEPTION 'kvittens 374o: the second request was not taken in the next batch';
  END IF;
  PERFORM app.gallring_finish(run, '{}', now());

  -- KEEP stops it at once.
  ALTER TABLE "RetentionDecisions" DISABLE TRIGGER "RetentionDecisions_stamped";
  INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision, reference, "decidedById", "decidedAt")
  VALUES (school, 'NOTIFICATIONS', 'KEEP', 'KV 374 keep', admin, now() - interval '1 hour');
  ALTER TABLE "RetentionDecisions" ENABLE TRIGGER "RetentionDecisions_stamped";
  old1 := pg_temp.kvo_request(school, admin, 'Gammal 5', 'ANY', 'p3:g3');
  UPDATE "AckRequests" SET "createdAt" = now() - interval '800 days' WHERE id = old1;
  run := app.gallring_begin(school, now());
  IF app.gallring_purge(run, 'NOTIFICATIONS', 100) <> 0 THEN RAISE EXCEPTION 'kvittens 374o: a school that keeps its notices lost a request'; END IF;
  PERFORM app.gallring_finish(run, '{}', now());
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Kvittens, after the review of F4 (20270119090000), owner checks.
--
--   380o  a reminder that has gone is marked as mailed by the delivery, and by nobody else
--   381o  a sender's share of the school's day (KV427) beside the school's own (KV428)
-- ---------------------------------------------------------------------------

-- 380o: app.ack_reminder_mirrored. The delivery's door sets no claims, and the function answers nothing to a login
-- that resolves to a person. Only a SENT reminder is marked, once; the first time stands.
BEGIN;
DO $$
DECLARE
  school uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-kvittens-school');
  full_ uuid := pg_temp.kvo_user('kv-full');
  sent uuid; unconfirmed uuid; nobody uuid; scheduled uuid; stopped uuid;
  first_time timestamptz;
BEGIN
  INSERT INTO "AckSettings" ("schoolId", enabled, "remindAfterDays") VALUES (school, true, 2)
    ON CONFLICT ("schoolId") DO UPDATE SET enabled = true, "remindAfterDays" = 2;
  -- SENT: due, G1 has not confirmed, so G1 is reminded.
  sent := pg_temp.kvo_request(school, full_, 'Skickad', 'ANY', 'p1:g1');
  -- NOT_NEEDED: due, but everybody has confirmed.
  nobody := pg_temp.kvo_request(school, full_, 'Ingen kvar', 'ANY', 'p3:g3');
  UPDATE "AckReceipts" SET "ackedAt" = now() WHERE "requestId" = nobody;
  -- Not yet due, and one that is stopped before the pass.
  scheduled := pg_temp.kvo_request(school, full_, 'Inte än', 'ANY', 'p1:g2');
  stopped := pg_temp.kvo_request(school, full_, 'Stoppad', 'ANY', 'p2:g1');
  UPDATE "AckRequests" SET "remindAt" = now() - interval '1 hour' WHERE id IN (sent, nobody, stopped);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-f40000000001')::text, true);
  PERFORM app.ack_stop_reminder(stopped);
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM count(*) FROM app.ack_remind_request(sent);
  PERFORM count(*) FROM app.ack_remind_request(nobody);
  PERFORM pg_temp.kvo_expect('380o the pass', (SELECT string_agg(title || ':' || coalesce("reminderOutcome"::text, '-') || ':' || ("reminderMirroredAt" IS NOT NULL), ' ' ORDER BY title COLLATE "C")
                                                 FROM "AckRequests" WHERE id IN (sent, nobody, scheduled, stopped)),
                             'Ingen kvar:NOT_NEEDED:false Inte än:-:false Skickad:SENT:false Stoppad:STOPPED:false');

  -- A login that resolves to a person marks nothing, whoever they are.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-f40000000001')::text, true);
  PERFORM app.ack_reminder_mirrored(sent);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-f40000000021')::text, true);
  PERFORM app.ack_reminder_mirrored(sent);
  PERFORM pg_temp.kvo_expect('380o a person marks', (SELECT ("reminderMirroredAt" IS NOT NULL)::text FROM "AckRequests" WHERE id = sent), 'false');

  -- The delivery's door (no claims) marks the SENT reminder, and nothing else.
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM app.ack_reminder_mirrored(sent);
  PERFORM app.ack_reminder_mirrored(nobody);
  PERFORM app.ack_reminder_mirrored(scheduled);
  PERFORM app.ack_reminder_mirrored(stopped);
  PERFORM app.ack_reminder_mirrored(gen_random_uuid());
  PERFORM pg_temp.kvo_expect('380o the delivery marks', (SELECT string_agg(title || ':' || ("reminderMirroredAt" IS NOT NULL), ' ' ORDER BY title COLLATE "C") FROM "AckRequests" WHERE id IN (sent, nobody, scheduled, stopped)),
                             'Ingen kvar:false Inte än:false Skickad:true Stoppad:false');
  IF (SELECT "reminderMirroredAt" FROM "AckRequests" WHERE id = sent) < (SELECT "reminderSentAt" FROM "AckRequests" WHERE id = sent) THEN
    RAISE EXCEPTION 'kvittens 380o: the mail went before the notices were written';
  END IF;

  -- Marked once: a second word from the delivery does not move the time.
  first_time := (SELECT "reminderMirroredAt" FROM "AckRequests" WHERE id = sent);
  PERFORM pg_sleep(0.02);
  PERFORM app.ack_reminder_mirrored(sent);
  IF (SELECT "reminderMirroredAt" FROM "AckRequests" WHERE id = sent) IS DISTINCT FROM first_time THEN
    RAISE EXCEPTION 'kvittens 380o: a second mark moved the time';
  END IF;

  -- The table says the same as the function: the column is only on a SENT reminder.
  PERFORM pg_temp.kvo_refuses(format($q$UPDATE "AckRequests" SET "reminderMirroredAt" = now() WHERE id = %L$q$, nobody), 'only_a_sent_reminder_is_mirrored');
  PERFORM pg_temp.kvo_refuses(format($q$UPDATE "AckRequests" SET "reminderMirroredAt" = now() WHERE id = %L$q$, scheduled), 'only_a_sent_reminder_is_mirrored');
  PERFORM pg_temp.kvo_refuses(format($q$UPDATE "AckRequests" SET "reminderOutcome" = 'STOPPED' WHERE id = %L$q$, sent), 'only_a_sent_reminder');
END $$;
ROLLBACK;

-- 381o: the limits' numbers, and a sender's share. The numbers are the function's, and they keep the proportions the
-- share was chosen for: no sender alone, and no two administrators, can use the school's day; an administrator's share
-- holds a whole-school request of the largest school we count on (2 600 pupils, 2.2 guardians: 5 720 receipts); a
-- teacher's holds fifteen requests to a class of sixty (132 receipts each). An unknown kind is an error, never "no limit".
BEGIN;
DO $$
DECLARE
  school_ integer := app.ack_day_limit('SCHOOL');
  admin_ integer := app.ack_day_limit('SCHOOL_ADMIN');
  teacher_ integer := app.ack_day_limit('TEACHER');
BEGIN
  PERFORM pg_temp.kvo_expect('381o the numbers', school_ || '/' || admin_ || '/' || teacher_, '20000/8000/2000');
  IF NOT (2 * admin_ < school_ AND 3 * admin_ >= school_) THEN
    RAISE EXCEPTION 'kvittens 381o: two administrators can use the school''s day, or three cannot';
  END IF;
  IF NOT (admin_ >= 5720 AND teacher_ >= 15 * 132 AND teacher_ < admin_) THEN
    RAISE EXCEPTION 'kvittens 381o: a share is too small for what it was chosen to hold';
  END IF;
  BEGIN
    PERFORM app.ack_day_limit('GUARDIAN');
    RAISE EXCEPTION 'kvittens 381o: an unknown kind has a limit';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'ACK_UNKNOWN_LIMIT%' THEN RAISE; END IF;
  END;
END $$;
ROLLBACK;

-- 381o: a teacher's share. Her requests of the last day count, whoever wrote their rows; the owner (no login) is not
-- counted against and brings her to 1 996 of her 2 000, five hours ago, so the hour's limit is not in play. A request
-- of four receipts (all her own pupils have: P1 with G1 and G2, P2 with G1, P4 with G4) makes the 2 000th, which is
-- allowed; one more is refused whole (KV427) and writes nothing.
BEGIN;
DO $$
DECLARE
  school uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-kvittens-school');
  m1 uuid := pg_temp.kvo_user('kv-m1');
  req uuid;
BEGIN
  INSERT INTO "AckSettings" ("schoolId", enabled) VALUES (school, true) ON CONFLICT ("schoolId") DO UPDATE SET enabled = true;
  INSERT INTO "AckRequests" (id, "schoolId", "authorId", title, body, "createdAt")
  SELECT gen_random_uuid(), school, m1, 'Andel ' || g, 'B', now() - interval '5 hours' FROM generate_series(1, 100) g;
  INSERT INTO "AckReceipts" ("requestId", "schoolId", "studentId", "guardianId")
  SELECT q.id, school, p.id, gu.id
    FROM (SELECT id FROM "AckRequests" WHERE "schoolId" = school AND title LIKE 'Andel %') q
    CROSS JOIN (SELECT id FROM "Users" WHERE "schoolId" = school AND role = 'STUDENT' AND email LIKE 'kv-p_@example.invalid') p
    CROSS JOIN (SELECT id FROM "Users" WHERE "schoolId" = school AND role = 'GUARDIAN' AND email LIKE 'kv-g_@example.invalid') gu
   LIMIT 1996;
  PERFORM pg_temp.kvo_expect('381o the owner''s rows', (SELECT count(*)::text FROM "AckReceipts" r JOIN "AckRequests" q ON q.id = r."requestId" WHERE q."authorId" = m1 AND q.title LIKE 'Andel %'), '1996');

  PERFORM set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-f40000000006')::text, true);
  INSERT INTO "AckRequests" (id, "schoolId", title, body) VALUES (gen_random_uuid(), school, 'Den 2 000:e', 'B') RETURNING id INTO req;
  INSERT INTO "AckReceipts" ("requestId", "schoolId", "studentId", "guardianId")
  VALUES (req, school, pg_temp.kvo_user('kv-p1'), pg_temp.kvo_user('kv-g1')), (req, school, pg_temp.kvo_user('kv-p1'), pg_temp.kvo_user('kv-g2')),
         (req, school, pg_temp.kvo_user('kv-p2'), pg_temp.kvo_user('kv-g1')), (req, school, pg_temp.kvo_user('kv-p4'), pg_temp.kvo_user('kv-g4'));
  PERFORM pg_temp.kvo_expect('381o her day is full', (SELECT count(*)::text FROM "AckReceipts" r JOIN "AckRequests" q ON q.id = r."requestId" WHERE q."authorId" = m1), '2000');

  -- One more, in a request of its own: refused, and the request with it.
  BEGIN
    INSERT INTO "AckRequests" (id, "schoolId", title, body) VALUES (gen_random_uuid(), school, 'Över andelen', 'B') RETURNING id INTO req;
    INSERT INTO "AckReceipts" ("requestId", "schoolId", "studentId", "guardianId") VALUES (req, school, pg_temp.kvo_user('kv-p1'), pg_temp.kvo_user('kv-g1'));
    RAISE EXCEPTION 'kvittens 381o: a teacher''s 2 001st receipt in a day was written';
  EXCEPTION WHEN SQLSTATE 'KV427' THEN NULL;
  END;
  PERFORM pg_temp.kvo_expect('381o a refused share writes nothing', (SELECT count(*)::text FROM "AckRequests" WHERE title = 'Över andelen'), '0');

  -- The share is hers: a colleague mentoring the other class, and an administrator, write on; and the school has room.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-f40000000007')::text, true);
  INSERT INTO "AckRequests" (id, "schoolId", title, body) VALUES (gen_random_uuid(), school, 'Kollegan', 'B') RETURNING id INTO req;
  INSERT INTO "AckReceipts" ("requestId", "schoolId", "studentId", "guardianId") VALUES (req, school, pg_temp.kvo_user('kv-p3'), pg_temp.kvo_user('kv-g3'));
  PERFORM set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-f40000000001')::text, true);
  INSERT INTO "AckRequests" (id, "schoolId", title, body) VALUES (gen_random_uuid(), school, 'Administratören', 'B') RETURNING id INTO req;
  INSERT INTO "AckReceipts" ("requestId", "schoolId", "studentId", "guardianId") VALUES (req, school, pg_temp.kvo_user('kv-p1'), pg_temp.kvo_user('kv-g1'));
  -- The share moves with the day: when her requests are more than 24 hours old she writes again.
  PERFORM set_config('request.jwt.claims', '', true);
  UPDATE "AckRequests" SET "createdAt" = now() - interval '25 hours' WHERE "authorId" = m1;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-f40000000006')::text, true);
  INSERT INTO "AckRequests" (id, "schoolId", title, body) VALUES (gen_random_uuid(), school, 'Nästa dygn', 'B') RETURNING id INTO req;
  INSERT INTO "AckReceipts" ("requestId", "schoolId", "studentId", "guardianId") VALUES (req, school, pg_temp.kvo_user('kv-p1'), pg_temp.kvo_user('kv-g1'));
END $$;
ROLLBACK;

-- 381o: an administrator's share, 8 000, and the order of the two limits. Her rows brought to 7 995 the owner's way; a
-- request of five (P1 with G1 and G2, P2 with G1, P3 with G3, P4 with G4) is the 8 000th; one more is refused (KV427).
-- Then the school's day is brought past 20 000 with a teacher's rows, and the administrator, over her own share as well,
-- is told it is her share (the sender's first); a mentor with room of her own is told it is the school's (KV428).
BEGIN;
DO $$
DECLARE
  school uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-kvittens-school');
  full_ uuid := pg_temp.kvo_user('kv-full');
  t3 uuid := pg_temp.kvo_user('kv-t3');
  req uuid;
  got text;
BEGIN
  INSERT INTO "AckSettings" ("schoolId", enabled) VALUES (school, true) ON CONFLICT ("schoolId") DO UPDATE SET enabled = true;
  INSERT INTO "AckRequests" (id, "schoolId", "authorId", title, body, "createdAt")
  SELECT gen_random_uuid(), school, full_, 'Admin ' || g, 'B', now() - interval '5 hours' FROM generate_series(1, 400) g;
  INSERT INTO "AckReceipts" ("requestId", "schoolId", "studentId", "guardianId")
  SELECT q.id, school, p.id, gu.id
    FROM (SELECT id FROM "AckRequests" WHERE "schoolId" = school AND title LIKE 'Admin %') q
    CROSS JOIN (SELECT id FROM "Users" WHERE "schoolId" = school AND role = 'STUDENT' AND email LIKE 'kv-p_@example.invalid') p
    CROSS JOIN (SELECT id FROM "Users" WHERE "schoolId" = school AND role = 'GUARDIAN' AND email LIKE 'kv-g_@example.invalid') gu
   LIMIT 7995;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-f40000000001')::text, true);
  INSERT INTO "AckRequests" (id, "schoolId", title, body) VALUES (gen_random_uuid(), school, 'Den 8 000:e', 'B') RETURNING id INTO req;
  INSERT INTO "AckReceipts" ("requestId", "schoolId", "studentId", "guardianId")
  VALUES (req, school, pg_temp.kvo_user('kv-p1'), pg_temp.kvo_user('kv-g1')), (req, school, pg_temp.kvo_user('kv-p1'), pg_temp.kvo_user('kv-g2')),
         (req, school, pg_temp.kvo_user('kv-p2'), pg_temp.kvo_user('kv-g1')), (req, school, pg_temp.kvo_user('kv-p3'), pg_temp.kvo_user('kv-g3')),
         (req, school, pg_temp.kvo_user('kv-p4'), pg_temp.kvo_user('kv-g4'));
  BEGIN
    INSERT INTO "AckRequests" (id, "schoolId", title, body) VALUES (gen_random_uuid(), school, 'Över andelen', 'B') RETURNING id INTO req;
    INSERT INTO "AckReceipts" ("requestId", "schoolId", "studentId", "guardianId") VALUES (req, school, pg_temp.kvo_user('kv-p1'), pg_temp.kvo_user('kv-g1'));
    RAISE EXCEPTION 'kvittens 381o: an administrator''s 8 001st receipt in a day was written';
  EXCEPTION WHEN SQLSTATE 'KV427' THEN NULL;
  END;
  PERFORM pg_temp.kvo_expect('381o a refused share writes nothing', (SELECT count(*)::text FROM "AckRequests" WHERE title = 'Över andelen'), '0');

  -- The school's day: 8 000 here, and 12 000 more of a teacher's the owner's way (no login: nothing is counted against
  -- her): the school is at 20 000.
  PERFORM set_config('request.jwt.claims', '', true);
  INSERT INTO "AckRequests" (id, "schoolId", "authorId", title, body, "createdAt")
  SELECT gen_random_uuid(), school, t3, 'Lärare ' || g, 'B', now() - interval '5 hours' FROM generate_series(1, 600) g;
  INSERT INTO "AckReceipts" ("requestId", "schoolId", "studentId", "guardianId")
  SELECT q.id, school, p.id, gu.id
    FROM (SELECT id FROM "AckRequests" WHERE "schoolId" = school AND title LIKE 'Lärare %') q
    CROSS JOIN (SELECT id FROM "Users" WHERE "schoolId" = school AND role = 'STUDENT' AND email LIKE 'kv-p_@example.invalid') p
    CROSS JOIN (SELECT id FROM "Users" WHERE "schoolId" = school AND role = 'GUARDIAN' AND email LIKE 'kv-g_@example.invalid') gu
   LIMIT 12000;
  PERFORM pg_temp.kvo_expect('381o the school''s day', (SELECT count(*)::text FROM "AckReceipts" WHERE "schoolId" = school AND "createdAt" > now() - interval '24 hours'), '20000');

  -- Over both: the administrator is told it is her share. A mentor under her own share is told it is the school's.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-f40000000001')::text, true);
  BEGIN
    INSERT INTO "AckRequests" (id, "schoolId", title, body) VALUES (gen_random_uuid(), school, 'Över båda', 'B') RETURNING id INTO req;
    INSERT INTO "AckReceipts" ("requestId", "schoolId", "studentId", "guardianId") VALUES (req, school, pg_temp.kvo_user('kv-p1'), pg_temp.kvo_user('kv-g1'));
    RAISE EXCEPTION 'kvittens 381o: a receipt over both limits was written';
  EXCEPTION WHEN SQLSTATE 'KV427' THEN NULL;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-f40000000007')::text, true);
  BEGIN
    INSERT INTO "AckRequests" (id, "schoolId", title, body) VALUES (gen_random_uuid(), school, 'Skolans dygn', 'B') RETURNING id INTO req;
    INSERT INTO "AckReceipts" ("requestId", "schoolId", "studentId", "guardianId") VALUES (req, school, pg_temp.kvo_user('kv-p3'), pg_temp.kvo_user('kv-g3'));
    RAISE EXCEPTION 'kvittens 381o: a receipt past the school''s day was written';
  EXCEPTION WHEN SQLSTATE 'KV428' THEN NULL;
  END;
  -- Another school's day is its own.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-f40000000031')::text, true);
  INSERT INTO "AckRequests" (id, "schoolId", title, body) VALUES (gen_random_uuid(), (SELECT id FROM "Schools" WHERE slug = 'rls-kvittens-annan'), 'Annans dag', 'B') RETURNING id INTO req;
  INSERT INTO "AckReceipts" ("requestId", "schoolId", "studentId", "guardianId")
  VALUES (req, (SELECT id FROM "Schools" WHERE slug = 'rls-kvittens-annan'), pg_temp.kvo_user('kv-annan-p'), pg_temp.kvo_user('kv-annan-g'));

  -- The usage the page shows is these rows: the school at 20 000 of 20 000 and the sender at 8 000 of 8 000.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-f40000000001')::text, true);
  SELECT string_agg(u.scope || coalesce(':' || u.author_name, '') || ' ' || u.used || '/' || u.cap, ', ' ORDER BY u.n) INTO got
    FROM app.ack_usage(5) WITH ORDINALITY u(scope, author_id, author_name, used, cap, n);
  PERFORM pg_temp.kvo_expect('381o the usage', got, 'SCHOOL 20000/20000, ME 8000/8000, SENDER:Kvittens Utan klass 12000/2000, SENDER:Kvittens Full 8000/8000');
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Sections 385-389 on the owner's side: Ett läsårs lektioner tas bort först
-- (20270120090000), and the composite keys' ON UPDATE (the review of #272).
--
-- A year's removal cascades into its lessons by two routes, and which route runs
-- first is the order of the keys' triggers by name, which a key dropped and added
-- again moves. Run the wrong way round, the lessons lose their master lesson
-- before they go and app.ss12000_v_lessons() files an AdhocActivity tombstone for
-- each of them. A BEFORE DELETE trigger on AcademicYears takes the lessons first,
-- whoever removes the year. It runs as the owner (SECURITY DEFINER); the reasons
-- are in the migration, and what they rest on is tested here.
--
--   385  the trigger and its function in the catalogue: BEFORE DELETE, per row,
--        on, the owner's, a fixed search_path, no EXECUTE for anyone, and the
--        premise of the owner's rights (row security is not forced on the
--        tables it deletes from)
--   386  every door files the same tombstones: a DELETE of the year as the
--        owner, as the API's role and as PostgREST's, for a year that was sent
--        and for the active one (a CalendarEvent for each lesson, an AdhocActivity
--        only for the one that never had a master lesson; among the lessons a
--        cancelled one, one with a teacher, one with an attendance record and one
--        dated before today, which a trigger that chose its lessons would leave
--        to the cascade) and for one that was never sent (none), and nothing else
--        of the school goes
--   387  who reaches it and who does not: a profile that writes PLANERING and
--        not DRIFT (the year goes, and its lessons go first all the same: the
--        service's own DELETE of them deleted nothing for it), a profile that
--        writes DRIFT and not PLANERING, another school's administrator and a
--        teacher (the year stays, the lessons stay), and a year whose removal is
--        refused (the lessons come back)
--   388  a composite key that holds a school does not follow its parent when the
--        parent is updated (ON UPDATE CASCADE): 98 older ones are named, and the
--        list only gets shorter
--   389  the guard of 388 over stand-ins, and over the list
--
-- These run as the owner and set the role of the API and of PostgREST with the
-- claims of a signed-in person, because they read the tombstones, which only the
-- owner reads. The rows are this section's own (ids 7f...), in two schools of its
-- own, and are rolled back.
-- ---------------------------------------------------------------------------

CREATE FUNCTION pg_temp.ylg_id(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT ('7f' || lpad(to_hex(n), 6, '0') || '-0000-4000-8000-000000000000')::uuid
$$;

-- The number a row of this section was given, from its id.
CREATE FUNCTION pg_temp.ylg_n(p_id uuid) RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT ('x' || substr(p_id::text, 3, 6))::bit(24)::int
$$;

CREATE FUNCTION pg_temp.ylg_auth(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT ('00000000-0000-4000-8000-7f' || lpad(n::text, 10, '0'))::uuid
$$;

-- Two schools. School 1 has an active year (10), a year that was sent (11) and one that was never sent
-- (12); a class in each (33, 30, 31) with a master lesson (53, 50, 51). The active year has two lessons, one
-- that keeps its master lesson (67) and one that never had it (68). The sent year has three plain lessons, of
-- which two keep their master lesson and one never had it (60-62), and four more that keep it and that a
-- trigger written to be selective would be tempted to leave to the cascade: one that is CANCELLED (72), one
-- with a teacher (73), one with an attendance record (74) and one dated before today and before the year
-- began (75; 2020, the others are 2097-2099). The unsent year has three (63-65) and a lesson (66) that names
-- the sent year's class as an extra group. Its people: a full administrator (80), a teacher (81), an
-- administrator of the expedition (82), one of the schedulers (84), a pupil (85). School 2 has a year (20),
-- a class (32) with two lessons (70 keyed, 71 not) and a full administrator (83).
--
-- A lesson that keeps its master lesson is what shows a lesson left to the cascade: the master lessons' key
-- runs first and sets "masterLessonId" to NULL on it, and it is filed as an AdhocActivity too. A lesson that
-- never had one is filed as one whichever way it goes, and shows nothing. So every lesson that must not be
-- skipped is keyed (67, 72-75): a trigger that skips the active year, the lessons that have a teacher or an
-- attendance record, the cancelled ones or the past ones leaves them to the cascade, and 386 sees it (the
-- review of #276, M2).
CREATE FUNCTION pg_temp.ylg_world() RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  s1 uuid := pg_temp.ylg_id(1);
  s2 uuid := pg_temp.ylg_id(2);
  lesson record;
BEGIN
  INSERT INTO "Schools" (id, name, slug, timezone, "updatedAt") VALUES
    (s1, 'YLG skola 1', 'ylg-1', 'Europe/Stockholm', now()),
    (s2, 'YLG skola 2', 'ylg-2', 'Europe/Stockholm', now());
  INSERT INTO "AcademicYears" (id, "schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt") VALUES
    (pg_temp.ylg_id(10), s1, 'aktivt',  '2098-08-17', '2099-06-12', true,  'NIOARIG', now()),
    (pg_temp.ylg_id(11), s1, 'förra',   '2097-08-18', '2098-06-12', false, 'NIOARIG', now()),
    (pg_temp.ylg_id(12), s1, 'nästa',   '2099-08-16', '2100-06-12', false, 'NIOARIG', now()),
    (pg_temp.ylg_id(20), s2, 'aktivt',  '2098-08-17', '2099-06-12', true,  'NIOARIG', now());
  INSERT INTO "Subjects" (id, "schoolId", name, code, "updatedAt") VALUES
    (pg_temp.ylg_id(40), s1, 'YLG ämne 1', 'YL1', now()),
    (pg_temp.ylg_id(41), s2, 'YLG ämne 2', 'YL2', now());
  INSERT INTO "StudentGroups" (id, "schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES
    (pg_temp.ylg_id(30), s1, pg_temp.ylg_id(11), 'YLG förra',  'TEACHING_GROUP', 7, now()),
    (pg_temp.ylg_id(31), s1, pg_temp.ylg_id(12), 'YLG nästa',  'TEACHING_GROUP', 7, now()),
    (pg_temp.ylg_id(32), s2, pg_temp.ylg_id(20), 'YLG andra',  'TEACHING_GROUP', 7, now()),
    (pg_temp.ylg_id(33), s1, pg_temp.ylg_id(10), 'YLG aktivt', 'TEACHING_GROUP', 7, now());
  INSERT INTO "MasterLessons" (id, "schoolId", "academicYearId", "subjectId", "studentGroupId", "dayOfWeek", "startTime", "endTime", "updatedAt") VALUES
    (pg_temp.ylg_id(50), s1, pg_temp.ylg_id(11), pg_temp.ylg_id(40), pg_temp.ylg_id(30), 1, '08:00', '08:50', now()),
    (pg_temp.ylg_id(51), s1, pg_temp.ylg_id(12), pg_temp.ylg_id(40), pg_temp.ylg_id(31), 1, '08:00', '08:50', now()),
    (pg_temp.ylg_id(52), s2, pg_temp.ylg_id(20), pg_temp.ylg_id(41), pg_temp.ylg_id(32), 1, '08:00', '08:50', now()),
    (pg_temp.ylg_id(53), s1, pg_temp.ylg_id(10), pg_temp.ylg_id(40), pg_temp.ylg_id(33), 1, '08:00', '08:50', now());
  FOR lesson IN SELECT * FROM (VALUES
      (60, s1, 50, 40, 30, date '2097-08-25', 'SCHEDULED'), (61, s1, 50, 40, 30, date '2097-09-01', 'SCHEDULED'), (62, s1, NULL, 40, 30, date '2097-09-02', 'SCHEDULED'),
      (63, s1, 51, 40, 31, date '2099-08-23', 'SCHEDULED'), (64, s1, 51, 40, 31, date '2099-08-30', 'SCHEDULED'), (65, s1, NULL, 40, 31, date '2099-09-01', 'SCHEDULED'),
      (66, s1, 51, 40, 31, date '2099-09-06', 'SCHEDULED'),
      (67, s1, 53, 40, 33, date '2098-08-24', 'SCHEDULED'), (68, s1, NULL, 40, 33, date '2098-08-25', 'SCHEDULED'),
      (70, s2, 52, 41, 32, date '2098-08-24', 'SCHEDULED'), (71, s2, NULL, 41, 32, date '2098-08-25', 'SCHEDULED'),
      (72, s1, 50, 40, 30, date '2097-09-08', 'CANCELLED'), (73, s1, 50, 40, 30, date '2097-09-15', 'SCHEDULED'),
      (74, s1, 50, 40, 30, date '2097-09-22', 'SCHEDULED'), (75, s1, 50, 40, 30, date '2020-02-03', 'SCHEDULED')) v(n, school, master, subject, grp, day, state)
  LOOP
    INSERT INTO "CalendarLessons" (id, "schoolId", "masterLessonId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", status, "updatedAt")
    VALUES (pg_temp.ylg_id(lesson.n), lesson.school, CASE WHEN lesson.master IS NULL THEN NULL ELSE pg_temp.ylg_id(lesson.master) END,
            pg_temp.ylg_id(lesson.subject), pg_temp.ylg_id(lesson.grp), lesson.day,
            (lesson.day + time '08:00') AT TIME ZONE 'Europe/Stockholm', (lesson.day + time '08:50') AT TIME ZONE 'Europe/Stockholm',
            lesson.state::"LessonStatus", now());
  END LOOP;
  INSERT INTO "CalendarLessonGroups" (id, "schoolId", "calendarLessonId", "studentGroupId")
  VALUES (pg_temp.ylg_id(90), s1, pg_temp.ylg_id(66), pg_temp.ylg_id(30));
  INSERT INTO "Users" (id, "schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "updatedAt") VALUES
    (pg_temp.ylg_id(80), s1, 'ylg-full@example.invalid',   'Full',  'Admin',   'SCHOOL_ADMIN', 'FULL',          pg_temp.ylg_auth(80), true, now()),
    (pg_temp.ylg_id(81), s1, 'ylg-lararen@example.invalid', 'Lärare', 'Ett',     'TEACHER',      NULL,            pg_temp.ylg_auth(81), true, now()),
    (pg_temp.ylg_id(82), s1, 'ylg-exp@example.invalid',    'Exp',   'Admin',   'SCHOOL_ADMIN', 'EXPEDITION',    pg_temp.ylg_auth(82), true, now()),
    (pg_temp.ylg_id(84), s1, 'ylg-sched@example.invalid',  'Sched', 'Admin',   'SCHOOL_ADMIN', 'SCHEMALAGGARE', pg_temp.ylg_auth(84), true, now()),
    (pg_temp.ylg_id(85), s1, 'ylg-eleven@example.invalid', 'Elev',  'Ett',     'STUDENT',      NULL,            pg_temp.ylg_auth(85), true, now()),
    (pg_temp.ylg_id(83), s2, 'ylg-full2@example.invalid',  'Full',  'Andra',   'SCHOOL_ADMIN', 'FULL',          pg_temp.ylg_auth(83), true, now());
  -- What hangs on a lesson: a teacher (73) and a pupil's attendance (74), which go with it.
  INSERT INTO "CalendarLessonTeachers" (id, "schoolId", "calendarLessonId", "teacherId")
  VALUES (pg_temp.ylg_id(91), s1, pg_temp.ylg_id(73), pg_temp.ylg_id(81));
  INSERT INTO "AttendanceRecords" (id, "schoolId", "calendarLessonId", "studentId", "updatedAt")
  VALUES (pg_temp.ylg_id(92), s1, pg_temp.ylg_id(74), pg_temp.ylg_id(85), now());
  DELETE FROM "Ss12000Tombstones" WHERE "schoolId" IN (s1, s2);
END $$;

-- The tombstones a school has for the lessons of this section, as '<resource> <numbers>; <resource> <numbers>',
-- the numbers being the lessons' (60-79): '' when there are none.
CREATE FUNCTION pg_temp.ylg_tombs(p_school uuid) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(r.resource || ' ' || r.ids, '; ' ORDER BY r.resource COLLATE "C"), '')
    FROM (SELECT t.resource, string_agg(pg_temp.ylg_n(t."emittedId")::text, ',' ORDER BY pg_temp.ylg_n(t."emittedId")) AS ids
            FROM "Ss12000Tombstones" t
           WHERE t."schoolId" = p_school AND t."emittedId" IN (SELECT pg_temp.ylg_id(n) FROM generate_series(60, 79) n)
           GROUP BY t.resource) r
$$;

-- The numbers of the lessons of this section that are left, among 60-79.
CREATE FUNCTION pg_temp.ylg_lessons() RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(pg_temp.ylg_n(l.id)::text, ',' ORDER BY pg_temp.ylg_n(l.id)), '')
    FROM "CalendarLessons" l WHERE l.id IN (SELECT pg_temp.ylg_id(n) FROM generate_series(60, 79) n)
$$;

-- Removes one year by a DELETE of its own, as <p_role> (the owner when null) with the claims of person <p_who>.
-- Answers what the statement did: the number of rows, 'denied' for a missing privilege, or 'error: ...'.
-- Back as the owner.
CREATE FUNCTION pg_temp.ylg_delete_year(p_year int, p_role text, p_who int) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  n bigint;
  -- Everything of pg_temp's is read before the role is set: a role without the privilege to create temporary
  -- objects does not see the schema.
  year_id uuid := pg_temp.ylg_id(p_year);
  claims text := json_build_object('sub', pg_temp.ylg_auth(p_who))::text;
BEGIN
  IF p_role IS NOT NULL THEN
    EXECUTE format('SET LOCAL ROLE %I', p_role);
    PERFORM set_config('request.jwt.claims', claims, true);
  END IF;
  BEGIN
    DELETE FROM "AcademicYears" WHERE id = year_id;
    GET DIAGNOSTICS n = ROW_COUNT;
  EXCEPTION
    WHEN insufficient_privilege THEN
      RESET ROLE;
      RETURN 'denied';
    WHEN OTHERS THEN
      RESET ROLE;
      RETURN 'error: ' || SQLERRM;
  END;
  RESET ROLE;
  RETURN n::text;
END $$;

-- One scenario, in a subtransaction that is always rolled back: the world, then <p_prep> (SQL, as the owner),
-- then (when p_probe) what person <p_who> does with a DELETE of lesson 60 on its own, then the DELETE of year
-- <p_year> by person <p_who> as <p_role>. Answers what is left: the statement's answer, whether the year is,
-- the lessons of the section, the tombstones of school 1 and of school 2, and the probe's answer.
CREATE FUNCTION pg_temp.ylg_scenario(p_year int, p_role text, p_who int, p_prep text DEFAULT NULL, p_probe boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  answer text;
  probe text := NULL;
  n bigint;
  result jsonb;
  lesson_60 uuid := pg_temp.ylg_id(60);
  claims text := json_build_object('sub', pg_temp.ylg_auth(p_who))::text;
BEGIN
  BEGIN
    PERFORM pg_temp.ylg_world();
    IF p_prep IS NOT NULL THEN EXECUTE p_prep; END IF;
    IF p_probe THEN
      BEGIN
        EXECUTE format('SET LOCAL ROLE %I', p_role);
        PERFORM set_config('request.jwt.claims', claims, true);
        DELETE FROM "CalendarLessons" WHERE id = lesson_60;
        GET DIAGNOSTICS n = ROW_COUNT;
        probe := n::text;
        RESET ROLE;
        RAISE EXCEPTION 'rollback the probe' USING ERRCODE = 'TF998';
      EXCEPTION WHEN SQLSTATE 'TF998' THEN NULL;
      END;
      RESET ROLE;
    END IF;
    answer := pg_temp.ylg_delete_year(p_year, p_role, p_who);
    result := jsonb_build_object(
      'answer', answer,
      'year', EXISTS (SELECT 1 FROM "AcademicYears" WHERE id = pg_temp.ylg_id(p_year)),
      'lessons', pg_temp.ylg_lessons(),
      'tombs1', pg_temp.ylg_tombs(pg_temp.ylg_id(1)),
      'tombs2', pg_temp.ylg_tombs(pg_temp.ylg_id(2)),
      'probe', probe);
    RAISE EXCEPTION 'rollback' USING ERRCODE = 'TF999';
  EXCEPTION WHEN SQLSTATE 'TF999' THEN NULL;
  END;
  RETURN result;
END $$;

-- ---------------------------------------------------------------------------
-- Section 385: the trigger, in the catalogue.
-- ---------------------------------------------------------------------------

BEGIN;
DO $$
DECLARE
  t record;
  fn record;
  grantee oid;
  role_ text;
BEGIN
  SELECT * INTO t FROM pg_trigger WHERE tgrelid = '"AcademicYears"'::regclass AND tgname = 'AcademicYears_a_lessons_go_first' AND NOT tgisinternal;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lektioner först 385: AcademicYears has no trigger AcademicYears_a_lessons_go_first';
  END IF;
  -- tgtype: 1 ROW, 2 BEFORE, 8 DELETE, 16 UPDATE, 4 INSERT, 32 TRUNCATE, 64 INSTEAD: BEFORE DELETE for each row, and that alone.
  IF t.tgtype <> 1 + 2 + 8 THEN
    RAISE EXCEPTION 'lektioner först 385: the trigger is not BEFORE DELETE FOR EACH ROW and nothing else (tgtype %)', t.tgtype;
  END IF;
  IF t.tgenabled <> 'O' THEN
    RAISE EXCEPTION 'lektioner först 385: the trigger is not enabled (tgenabled %)', t.tgenabled;
  END IF;
  IF t.tgfoid <> 'app.academic_year_lessons_go_first()'::regprocedure THEN
    RAISE EXCEPTION 'lektioner först 385: the trigger runs % and not app.academic_year_lessons_go_first()', t.tgfoid::regproc;
  END IF;
  IF t.tgattr::text <> '' OR t.tgqual IS NOT NULL THEN
    RAISE EXCEPTION 'lektioner först 385: the trigger has a column list or a WHEN: it would not run for every year';
  END IF;

  SELECT p.prosecdef, p.proconfig, p.proowner, p.proacl, p.prorettype::regtype::text AS ret, p.prolang
    INTO fn FROM pg_proc p WHERE p.oid = 'app.academic_year_lessons_go_first()'::regprocedure;
  IF NOT fn.prosecdef THEN
    RAISE EXCEPTION 'lektioner först 385: the function runs as its caller: a profile that may delete a year and not lessons would delete none (386, 387)';
  END IF;
  -- However the setting is spelled (public, pg_temp / "public", "pg_temp"), it is that one and no other.
  IF fn.proconfig IS NULL OR cardinality(fn.proconfig) <> 1 OR replace(replace(fn.proconfig[1], '"', ''), ' ', '') <> 'search_path=public,pg_temp' THEN
    RAISE EXCEPTION 'lektioner först 385: the function''s settings are %, not a fixed search_path of public, pg_temp', fn.proconfig;
  END IF;
  IF fn.ret <> 'trigger' THEN
    RAISE EXCEPTION 'lektioner först 385: the function returns %', fn.ret;
  END IF;

  -- It runs as the tables' owner, whose rights are the year's own cascade's: the referential actions run as
  -- the owner of the table whose rows they delete, and row security is not forced on an owner.
  IF fn.proowner <> (SELECT relowner FROM pg_class WHERE oid = '"AcademicYears"'::regclass)
     OR fn.proowner <> (SELECT relowner FROM pg_class WHERE oid = '"CalendarLessons"'::regclass)
     OR fn.proowner <> (SELECT relowner FROM pg_class WHERE oid = '"StudentGroups"'::regclass) THEN
    RAISE EXCEPTION 'lektioner först 385: the function is not owned by the owner of AcademicYears, CalendarLessons and StudentGroups';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE oid IN ('"AcademicYears"'::regclass, '"CalendarLessons"'::regclass, '"StudentGroups"'::regclass) AND relforcerowsecurity) THEN
    RAISE EXCEPTION 'lektioner först 385: row security is forced on a table the trigger deletes from or reads: the owner is no longer outside it, and neither is the year''s cascade';
  END IF;
  -- Nobody holds EXECUTE on it: not PUBLIC, not the roles that are named, nobody but the owner. A trigger
  -- needs none to fire.
  FOR grantee IN SELECT a.grantee FROM aclexplode(coalesce(fn.proacl, acldefault('f', fn.proowner))) a WHERE a.grantee <> fn.proowner LOOP
    RAISE EXCEPTION 'lektioner först 385: EXECUTE on the function is held by %', CASE WHEN grantee = 0 THEN 'PUBLIC' ELSE grantee::regrole::text END;
  END LOOP;
  FOREACH role_ IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_)
       AND has_function_privilege(role_, 'app.academic_year_lessons_go_first()', 'EXECUTE') THEN
      RAISE EXCEPTION 'lektioner först 385: % can execute the function', role_;
    END IF;
  END LOOP;

  -- No other trigger on the year deletes the lessons, or the year would be deleted by two.
  IF EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = '"AcademicYears"'::regclass AND NOT g.tgisinternal AND g.tgname <> t.tgname
               AND g.tgtype & 8 = 8 AND g.tgtype & 2 = 2) THEN
    RAISE EXCEPTION 'lektioner först 385: another BEFORE DELETE trigger on AcademicYears has been added: it may run before the lessons go (it is named AcademicYears_a_..., which sorts first only while it stays alone)';
  END IF;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 386: every door files the same tombstones.
--
-- A sent year (11): a CalendarEvent for each of its seven lessons (60-62, 72-75) and an AdhocActivity for the
-- one that never had a master lesson (62). Of the seven, four are the kind a trigger that chose its lessons
-- would leave to the cascade, which files an AdhocActivity for each of those too: 72 is CANCELLED, 73 has a
-- teacher, 74 has an attendance record and 75 is dated before today (and before the year began). The active
-- year (10): a CalendarEvent for each of its two lessons (67 keyed, 68 not) and an AdhocActivity for 68; a
-- trigger that left the active year to the cascade files one for 67 as well. A year that was never sent (12):
-- none. The lesson of the unsent year that names the sent year's class as an extra group (66) stays, and
-- school 2 is not touched. The lessons are the rows of the section: 60-68 and 72-75 of school 1, 70-71 of
-- school 2.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  door record;
  r jsonb;
  sent_tombs constant text := 'AdhocActivity 62; CalendarEvent 60,61,62,72,73,74,75';
BEGIN
  FOR door IN SELECT * FROM (VALUES
      ('the owner', NULL::text, 0), ('the API''s role', 'app_authenticated', 80), ('PostgREST''s role', 'authenticated', 80)) v(who, via, person)
  LOOP
    r := pg_temp.ylg_scenario(11, door.via, door.person);
    IF r ->> 'answer' <> '1' OR (r ->> 'year')::boolean THEN
      RAISE EXCEPTION 'lektioner först 386: % did not remove the sent year: %', door.who, r;
    END IF;
    IF r ->> 'tombs1' <> sent_tombs THEN
      RAISE EXCEPTION 'lektioner först 386: % filed [%] for the sent year, not [%] (an AdhocActivity for a lesson that had a master lesson: the cascade ran the master lessons'' key before the classes'', so the lesson was left to it: a cancelled one, one with a teacher or an attendance record, a past one, or all of the year''s)', door.who, r ->> 'tombs1', sent_tombs;
    END IF;
    IF r ->> 'lessons' <> '63,64,65,66,67,68,70,71' THEN
      RAISE EXCEPTION 'lektioner först 386: % left lessons [%] after the sent year went, not [63,64,65,66,67,68,70,71] (its own seven go; the other years'', the one with the extra group included, and school 2''s stay)', door.who, r ->> 'lessons';
    END IF;
    IF r ->> 'tombs2' <> '' THEN
      RAISE EXCEPTION 'lektioner först 386: % filed [%] for school 2 when a year of school 1 went', door.who, r ->> 'tombs2';
    END IF;

    -- The active year is a sent year too (app.ss12000_year_is_emitted): its lessons are filed the same way.
    r := pg_temp.ylg_scenario(10, door.via, door.person);
    IF r ->> 'answer' <> '1' OR (r ->> 'year')::boolean THEN
      RAISE EXCEPTION 'lektioner först 386: % did not remove the active year: %', door.who, r;
    END IF;
    IF r ->> 'tombs1' <> 'AdhocActivity 68; CalendarEvent 67,68' THEN
      RAISE EXCEPTION 'lektioner först 386: % filed [%] for the active year, not [AdhocActivity 68; CalendarEvent 67,68] (an AdhocActivity for the lesson that had a master lesson: the active year was left to the cascade)', door.who, r ->> 'tombs1';
    END IF;
    IF r ->> 'lessons' <> '60,61,62,63,64,65,66,70,71,72,73,74,75' THEN
      RAISE EXCEPTION 'lektioner först 386: % left lessons [%] after the active year went, not [60,61,62,63,64,65,66,70,71,72,73,74,75]', door.who, r ->> 'lessons';
    END IF;
    IF r ->> 'tombs2' <> '' THEN
      RAISE EXCEPTION 'lektioner först 386: % filed [%] for school 2 when the active year of school 1 went', door.who, r ->> 'tombs2';
    END IF;

    r := pg_temp.ylg_scenario(12, door.via, door.person);
    IF r ->> 'answer' <> '1' OR (r ->> 'year')::boolean THEN
      RAISE EXCEPTION 'lektioner först 386: % did not remove the unsent year: %', door.who, r;
    END IF;
    IF r ->> 'tombs1' <> '' THEN
      RAISE EXCEPTION 'lektioner först 386: % filed [%] for the lessons of a year that was never sent, and the flow sends none', door.who, r ->> 'tombs1';
    END IF;
    IF r ->> 'lessons' <> '60,61,62,67,68,70,71,72,73,74,75' THEN
      RAISE EXCEPTION 'lektioner först 386: % left lessons [%] after the unsent year went, not [60,61,62,67,68,70,71,72,73,74,75]', door.who, r ->> 'lessons';
    END IF;
  END LOOP;

  -- What the set is the set of: the lessons removed on their own first, with the trigger out of the way, which
  -- is what the service did since #272. The trigger makes every door file that.
  r := pg_temp.ylg_scenario(11, NULL, 0, 'ALTER TABLE "AcademicYears" DISABLE TRIGGER "AcademicYears_a_lessons_go_first"; DELETE FROM "CalendarLessons" WHERE id IN (SELECT pg_temp.ylg_id(n) FROM unnest(ARRAY[60, 61, 62, 72, 73, 74, 75]) n)');
  IF r ->> 'tombs1' <> sent_tombs THEN
    RAISE EXCEPTION 'lektioner först 386: the lessons removed first, with the trigger out of the way, filed [%], not the set the doors above are held to [%]', r ->> 'tombs1', sent_tombs;
  END IF;
  r := pg_temp.ylg_scenario(10, NULL, 0, 'ALTER TABLE "AcademicYears" DISABLE TRIGGER "AcademicYears_a_lessons_go_first"; DELETE FROM "CalendarLessons" WHERE id IN (SELECT pg_temp.ylg_id(n) FROM unnest(ARRAY[67, 68]) n)');
  IF r ->> 'tombs1' <> 'AdhocActivity 68; CalendarEvent 67,68' THEN
    RAISE EXCEPTION 'lektioner först 386: the active year''s lessons removed first, with the trigger out of the way, filed [%], not the set the doors above are held to [AdhocActivity 68; CalendarEvent 67,68]', r ->> 'tombs1';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Section 387: who reaches the trigger, who does not, and what a refusal does.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  r jsonb;
  via text;
  all_lessons constant text := '60,61,62,63,64,65,66,67,68,70,71,72,73,74,75';
  sent_tombs constant text := 'AdhocActivity 62; CalendarEvent 60,61,62,72,73,74,75';
BEGIN
  -- A profile that writes PLANERING and not DRIFT (none does today: this is the next one). The simulation
  -- must bite: its own DELETE of a lesson deletes nothing, and its DELETE of the year deletes the year, and
  -- the lessons go first all the same.
  FOREACH via IN ARRAY ARRAY['app_authenticated', 'authenticated'] LOOP
    r := pg_temp.ylg_scenario(11, via, 84,
      $q$CREATE OR REPLACE FUNCTION app.admin_profile_writes(p_profile "AdminProfile") RETURNS "AdminArea"[] LANGUAGE sql IMMUTABLE AS
         $f$ SELECT CASE p_profile WHEN 'SCHEMALAGGARE' THEN ARRAY['PLANERING']::"AdminArea"[] ELSE '{}'::"AdminArea"[] END $f$ $q$, true);
    IF r ->> 'probe' IS DISTINCT FROM '0' THEN
      RAISE EXCEPTION 'lektioner först 387: the profile that writes PLANERING only deleted % lesson(s) of its own by a DELETE as %: the simulation does not bite', r ->> 'probe', via;
    END IF;
    IF r ->> 'answer' <> '1' OR (r ->> 'year')::boolean THEN
      RAISE EXCEPTION 'lektioner först 387: a profile that writes PLANERING only did not remove the year as %: %', via, r;
    END IF;
    IF r ->> 'tombs1' <> sent_tombs OR r ->> 'lessons' <> '63,64,65,66,67,68,70,71' THEN
      RAISE EXCEPTION 'lektioner först 387: a profile that writes PLANERING only, as %, filed [%] and left lessons [%]: the lessons did not go first (the cascade ran, as the owner, in the keys'' order)', via, r ->> 'tombs1', r ->> 'lessons';
    END IF;
  END LOOP;

  -- A profile that writes DRIFT and not PLANERING (the expedition) cannot remove the year; a teacher cannot; the
  -- administrator of another school cannot. Nothing is removed and nothing is filed, as either role.
  FOREACH via IN ARRAY ARRAY['app_authenticated', 'authenticated'] LOOP
    r := pg_temp.ylg_scenario(11, via, 82);
    IF r ->> 'answer' <> '0' OR NOT (r ->> 'year')::boolean OR r ->> 'lessons' <> all_lessons OR r ->> 'tombs1' <> '' THEN
      RAISE EXCEPTION 'lektioner först 387: the expedition, as %, removed or filed something: %', via, r;
    END IF;
    r := pg_temp.ylg_scenario(11, via, 83);
    IF r ->> 'answer' <> '0' OR NOT (r ->> 'year')::boolean OR r ->> 'lessons' <> all_lessons OR r ->> 'tombs1' <> '' OR r ->> 'tombs2' <> '' THEN
      RAISE EXCEPTION 'lektioner först 387: the administrator of another school, as %, reached the year or its lessons: %', via, r;
    END IF;
    r := pg_temp.ylg_scenario(11, via, 81);
    IF r ->> 'answer' NOT IN ('0', 'denied') OR NOT (r ->> 'year')::boolean OR r ->> 'lessons' <> all_lessons OR r ->> 'tombs1' <> '' THEN
      RAISE EXCEPTION 'lektioner först 387: a teacher, as %, reached the year or its lessons: %', via, r;
    END IF;
  END LOOP;

  -- A year whose removal is refused takes nothing with it: the lessons are back (one statement, one transaction).
  r := pg_temp.ylg_scenario(11, NULL, 0,
    $q$CREATE FUNCTION app.ylg_refuses() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'ylg refuses'; END $f$;
       CREATE TRIGGER "AcademicYears_z_ylg_refuses" BEFORE DELETE ON "AcademicYears" FOR EACH ROW EXECUTE FUNCTION app.ylg_refuses()$q$);
  IF r ->> 'answer' NOT LIKE 'error: ylg refuses%' OR NOT (r ->> 'year')::boolean OR r ->> 'lessons' <> all_lessons OR r ->> 'tombs1' <> '' THEN
    RAISE EXCEPTION 'lektioner först 387: a removal that was refused took lessons or tombstones with it: %', r;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Section 388: a key that holds a school does not follow its parent.
--
-- Section 330 asks that a key between two tables that carry a school hold the school: (x, "schoolId") ->
-- parent ("id", "schoolId"). It did not ask what the key does when the parent is UPDATEd. ON UPDATE CASCADE
-- carries the child along when a parent's id or school is changed: a parent moved to another school took its
-- rows with it, without a word (tried on 232 parents in the review of #272: with CASCADE three went, a room
-- with its room type; with NO ACTION none moved and each refusal named the key). 20270115090000 made the
-- thirty-eight keys it replaced NO ACTION. The composite keys before them are the ones named below, 98 on the
-- schema of 20270118090000: 93 older, with the five that came with #273 and #274 after #272. They are named
-- because they are, not because they are right; no code path updates an id or a school of any parent, and
-- nothing is carried along that the owner has not asked for. The list only gets shorter: a key that is made
-- NO ACTION (or removed) is taken off it here, and the section fails until it is. A new key that follows its
-- parent fails by name, and adding its name to the list instead fails the list's ceiling (98): raising it is a
-- decision that shows in the diff.
--
-- A key is "one that holds a school" when it has more than one column and one of them is a school column of
-- its table: "schoolId", or in a table without one, a column named like <something>SchoolId (RoomLoans),
-- as section 330 reads a table's school. "Follows its parent" is any ON UPDATE but NO ACTION and RESTRICT.
-- ---------------------------------------------------------------------------

CREATE FUNCTION pg_temp.tk_follows(p_schema oid) RETURNS TABLE (tbl text, conname text, cols text, on_update text)
LANGUAGE sql AS $$
  SELECT cl.relname::text, c.conname::text,
         (SELECT string_agg(a.attname, ',' ORDER BY u.ord)
            FROM unnest(c.conkey) WITH ORDINALITY u(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum),
         CASE c.confupdtype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid AND cl.relnamespace = p_schema
    CROSS JOIN LATERAL (SELECT pg_temp.tk_school_cols(c.conrelid) AS cs) s
   WHERE c.contype = 'f'
     AND cardinality(c.conkey) > 1
     AND s.cs IS NOT NULL
     AND EXISTS (SELECT 1 FROM unnest(c.conkey) k WHERE k = ANY (s.cs))
     AND c.confupdtype NOT IN ('a', 'r')
$$;

BEGIN;
DO $$
DECLARE
  exempt constant text[] := ARRAY[
    'AcademicYearTimplans.AcademicYearTimplans_academicYearId_schoolId_fkey',
    'AcademicYearTimplans.AcademicYearTimplans_localTimplanId_schoolId_fkey',
    'AckReceipts.AckReceipts_requestId_schoolId_fkey',  -- #273, after #272
    'CalendarFeeds.CalendarFeeds_studentId_schoolId_fkey',
    'CalendarFeeds.CalendarFeeds_userId_schoolId_fkey',
    'CalendarLunches.CalendarLunches_studentGroupId_schoolId_fkey',
    'CalendarRasts.CalendarRasts_studentGroupId_schoolId_fkey',
    'CancellationBatchCredits.CancellationBatchCredits_batchId_schoolId_fkey',
    'CancellationBatchCredits.CancellationBatchCredits_creditId_schoolId_fkey',
    'CancellationBatchLessons.CancellationBatchLessons_batchId_schoolId_fkey',
    'CancellationBatchLessons.CancellationBatchLessons_calendarLessonId_schoolId_fkey',
    'CancellationBatches.CancellationBatches_academicYearId_schoolId_fkey',
    'CoverConfirmations.CoverConfirmations_calendarLessonId_schoolId_fkey',
    'CoverRequestLessons.CoverRequestLessons_calendarLessonId_schoolId_fkey',
    'DevicePushTokens.DevicePushTokens_userId_schoolId_fkey',
    'GuardianStudents.GuardianStudents_guardianId_schoolId_fkey',
    'GuardianStudents.GuardianStudents_studentId_schoolId_fkey',
    'IntegrationKeyWebhookSecrets.IntegrationKeyWebhookSecrets_keyId_schoolId_fkey',
    'LeaveDelegationDecisions.LeaveDelegationDecisions_decidedById_schoolId_fkey',
    'LeaveRequestNotices.LeaveRequestNotices_userId_schoolId_fkey',
    'LocalTimplanEntries.LocalTimplanEntries_localTimplanId_schoolId_fkey',
    'LocalTimplanEntries.LocalTimplanEntries_subjectId_schoolId_fkey',
    'LunchSittings.LunchSittings_academicYearId_schoolId_fkey',
    'LunchSittings.LunchSittings_studentGroupId_schoolId_fkey',
    'MasterLessonGroups.MasterLessonGroups_studentGroupId_schoolId_fkey',
    'MasterLessonStudents.MasterLessonStudents_studentId_schoolId_fkey',
    'MasterLessons.MasterLessons_academicYearId_schoolId_fkey',
    'MasterLessons.MasterLessons_coTeacherId_schoolId_fkey',
    'MasterLessons.MasterLessons_roomId_schoolId_fkey',
    'MasterLessons.MasterLessons_studentGroupId_schoolId_fkey',
    'MasterLessons.MasterLessons_subjectId_schoolId_fkey',
    'MasterLessons.MasterLessons_teacherId_schoolId_fkey',
    'NotificationOptOuts.NotificationOptOuts_userId_schoolId_fkey',
    'PersonalDataAccess.PersonalDataAccess_actorId_schoolId_fkey',
    'PersonalDataAccess.PersonalDataAccess_apiKeyId_schoolId_fkey',
    'PublicTimetableHidden.PublicTimetableHidden_targetGroupId_schoolId_fkey',  -- #274, after #272
    'PublicTimetableHidden.PublicTimetableHidden_targetRoomId_schoolId_fkey',  -- #274, after #272
    'PublicTimetableHidden.PublicTimetableHidden_targetStudentId_schoolId_fkey',  -- #274, after #272
    'PublicTimetableLinks.PublicTimetableLinks_academicYearId_schoolId_fkey',
    'PublicTimetableLinks.PublicTimetableLinks_targetGroupId_schoolId_fkey',
    'PublicTimetableLinks.PublicTimetableLinks_targetRoomId_schoolId_fkey',
    'PublicTimetableLinks.PublicTimetableLinks_targetStudentId_schoolId_fkey',  -- #274, after #272
    'PublicTimetableLinks.PublicTimetableLinks_targetTeacherId_schoolId_fkey',
    'PublicationPendingRemovals.PublicationPendingRemovals_academicYearId_schoolId_fkey',
    'PublicationPendingRemovals.PublicationPendingRemovals_calendarLessonId_schoolId_fkey',
    'PublishedLessons.PublishedLessons_publicationId_academicYearId_schoolId_fkey',
    'PublishedLunchSittings.PublishedLunchSittings_publicationId_academicYearId_schoolId_fk',
    'PushTickets.PushTickets_tokenId_schoolId_fkey',
    'RetentionDecisions.RetentionDecisions_decidedById_schoolId_fkey',
    'ScheduleActivities.ScheduleActivities_academicYearId_schoolId_fkey',
    'ScheduleActivities.ScheduleActivities_batchId_schoolId_fkey',
    'ScheduleActivities.ScheduleActivities_replacementSubjectId_schoolId_fkey',
    'ScheduleActivityLessons.ScheduleActivityLessons_activityId_schoolId_fkey',
    'ScheduleActivityLessons.ScheduleActivityLessons_calendarLessonId_schoolId_fkey',
    'ScheduleActivityTeachers.ScheduleActivityTeachers_activityId_schoolId_fkey',
    'ScheduleCandidateRuns.ScheduleCandidateRuns_academicYearId_schoolId_fkey',
    'ScheduleCandidates.ScheduleCandidates_runId_schoolId_fkey',
    'SchoolBreaks.SchoolBreaks_academicYearId_schoolId_fkey',
    'Ss12000DutyLinks.Ss12000DutyLinks_academicYearId_schoolId_fkey',
    'Ss12000DutyLinks.Ss12000DutyLinks_userId_schoolId_fkey',
    'Ss12000SourceSecrets.Ss12000SourceSecrets_sourceId_schoolId_fkey',
    'Ss12000SubscriptionDeliveries.Ss12000SubscriptionDeliveries_subscription_fkey',
    'Ss12000Subscriptions.Ss12000Subscriptions_keyId_schoolId_fkey',
    'Ss12000SyncChanges.Ss12000SyncChanges_runId_schoolId_fkey',
    'Ss12000SyncRuns.Ss12000SyncRuns_sourceId_schoolId_fkey',
    'StudentEnrollments.StudentEnrollments_academicYearId_schoolId_fkey',
    'StudentEnrollments.StudentEnrollments_studentId_schoolId_fkey',
    'SubstituteAvailabilities.SubstituteAvailabilities_member_fkey',
    'SubstitutePoolMembers.SubstitutePoolMembers_userId_schoolId_fkey',
    'TeacherAbsenceCovers.TeacherAbsenceCovers_calendarLessonId_schoolId_fkey',
    'TeacherAbsences.TeacherAbsences_userId_schoolId_fkey',
    'TeacherDuties.TeacherDuties_academicYearId_schoolId_fkey',
    'TeacherDuties.TeacherDuties_userId_schoolId_fkey',
    'TeacherEmploymentLogs.TeacherEmploymentLogs_academicYearId_schoolId_fkey',
    'TeacherEmploymentLogs.TeacherEmploymentLogs_userId_schoolId_fkey',
    'TeacherEmploymentPeriods.TeacherEmploymentPeriods_employment_fkey',
    'TeacherEmployments.TeacherEmployments_academicYearId_schoolId_fkey',
    'TeacherEmployments.TeacherEmployments_userId_schoolId_fkey',
    'TeacherPublicLabels.TeacherPublicLabels_userId_schoolId_fkey',
    'TeacherSubjectQualifications.TeacherSubjectQualifications_subjectId_schoolId_fkey',
    'TeacherSubjectQualifications.TeacherSubjectQualifications_userId_schoolId_fkey',
    'TeacherWorkRules.TeacherWorkRules_userId_schoolId_fkey',
    'TeachingBlocks.TeachingBlocks_academicYearId_schoolId_fkey',
    'TeachingRequirementShares.TeachingRequirementShares_requirementId_schoolId_fkey',
    'TeachingRequirementShares.TeachingRequirementShares_teacherId_schoolId_fkey',
    'TeachingRequirements.TeachingRequirements_academicYearId_schoolId_fkey',
    'TeachingRequirements.TeachingRequirements_coTeacherId_schoolId_fkey',
    'TeachingRequirements.TeachingRequirements_studentGroupId_schoolId_fkey',
    'TeachingRequirements.TeachingRequirements_subjectId_schoolId_fkey',
    'TeachingRequirements.TeachingRequirements_teacherId_schoolId_fkey',
    'TimetablePublications.TimetablePublications_academicYearId_schoolId_fkey',
    'TimplanCredits.TimplanCredits_academicYearId_schoolId_fkey',
    'TimplanCredits.TimplanCredits_studentGroupId_schoolId_fkey',
    'TimplanCredits.TimplanCredits_subjectId_schoolId_fkey',
    'TimplanStatementPublications.TimplanStatementPublications_academicYearId_schoolId_fkey',
    'TimplanStatements.TimplanStatements_publicationId_academicYearId_asOfDate_schoolI',
    'TimplanStatements.TimplanStatements_studentId_schoolId_fkey',
    'UserRoleChanges.UserRoleChanges_userId_schoolId_fkey'];
  -- The list can only get shorter. It is checked to be exactly the keys that follow their parent (below), so
  -- a new key that follows could be passed by adding its name; the ceiling (max_names) makes that a decision
  -- that shows in the diff, a number raised on purpose with a reason in the change. 98 is what the schema of
  -- 20270118090000 has. When the list gets shorter, lower the ceiling with it, or the next name added fits
  -- under it.
  max_names constant int := 98;
  found text[];
  extra text[];
  gone text[];
  dup text[];
BEGIN
  SELECT array_agg(f.tbl || '.' || f.conname ORDER BY f.tbl || '.' || f.conname COLLATE "C") INTO found FROM pg_temp.tk_follows('public'::regnamespace) f;
  SELECT array_agg(f ORDER BY f COLLATE "C") INTO extra FROM unnest(found) f WHERE f <> ALL (exempt);
  SELECT array_agg(e ORDER BY e COLLATE "C") INTO gone FROM unnest(exempt) e WHERE e <> ALL (coalesce(found, '{}'));
  SELECT array_agg(e ORDER BY e COLLATE "C") INTO dup FROM (SELECT e FROM unnest(exempt) e GROUP BY e HAVING count(*) > 1) d;
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'tenant keys 388: a key that holds a school follows its parent when the parent is updated (ON UPDATE is not NO ACTION): % (make it ON UPDATE NO ACTION, as 20270115090000 did for 38 others: a parent moved to another school would carry its rows along without a word)', extra;
  END IF;
  IF gone IS NOT NULL THEN
    RAISE EXCEPTION 'tenant keys 388: a key this list names no longer follows its parent (it is gone, or it is NO ACTION now): % (take it off the list)', gone;
  END IF;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION 'tenant keys 388: named twice in the list: %', dup;
  END IF;
  IF cardinality(exempt) > max_names THEN
    RAISE EXCEPTION 'tenant keys 388: the list names % keys, more than its ceiling of %: a key that follows its parent was added to the list instead of being made ON UPDATE NO ACTION (if it has to follow, raise max_names in this change and say why)', cardinality(exempt), max_names;
  END IF;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 389: the guard's predicate, over stand-ins.
--
-- The keys that follow their parent are reported, those that do not are not: NO ACTION and RESTRICT, a key of
-- one column, a key that holds nothing of the child's school, and a table without a school. A guard that let
-- one of the first through, or reported one of the last, fails here.
-- ---------------------------------------------------------------------------

BEGIN;
DO $$
DECLARE
  got text[];
BEGIN
  CREATE TEMP TABLE tk_up_parent (id uuid PRIMARY KEY, "schoolId" uuid NOT NULL, other uuid NOT NULL, UNIQUE (id, "schoolId"), UNIQUE (id, other));
  -- Do not follow.
  CREATE TEMP TABLE tk_up_noaction (id uuid PRIMARY KEY, "schoolId" uuid NOT NULL, x uuid,
                                    FOREIGN KEY (x, "schoolId") REFERENCES tk_up_parent (id, "schoolId") ON UPDATE NO ACTION);
  CREATE TEMP TABLE tk_up_default (id uuid PRIMARY KEY, "schoolId" uuid NOT NULL, x uuid,
                                   FOREIGN KEY (x, "schoolId") REFERENCES tk_up_parent (id, "schoolId"));
  CREATE TEMP TABLE tk_up_restrict (id uuid PRIMARY KEY, "schoolId" uuid NOT NULL, x uuid,
                                    FOREIGN KEY (x, "schoolId") REFERENCES tk_up_parent (id, "schoolId") ON UPDATE RESTRICT);
  CREATE TEMP TABLE tk_up_single (id uuid PRIMARY KEY, "schoolId" uuid NOT NULL, x uuid REFERENCES tk_up_parent (id) ON UPDATE CASCADE);
  -- A key that holds nothing of the child's school (the parent's school is held by a column that is not the child's).
  CREATE TEMP TABLE tk_up_other (id uuid PRIMARY KEY, "schoolId" uuid NOT NULL, x uuid, y uuid,
                                 FOREIGN KEY (x, y) REFERENCES tk_up_parent (id, other) ON UPDATE CASCADE);
  -- Tables with no school of their own.
  CREATE TEMP TABLE tk_up_bare_parent (id uuid PRIMARY KEY, y uuid NOT NULL, UNIQUE (id, y));
  CREATE TEMP TABLE tk_up_bare (id uuid PRIMARY KEY, x uuid, y uuid, FOREIGN KEY (x, y) REFERENCES tk_up_bare_parent (id, y) ON UPDATE CASCADE);
  -- Follow.
  CREATE TEMP TABLE tk_up_cascade (id uuid PRIMARY KEY, "schoolId" uuid NOT NULL, x uuid,
                                   FOREIGN KEY (x, "schoolId") REFERENCES tk_up_parent (id, "schoolId") ON UPDATE CASCADE);
  CREATE TEMP TABLE tk_up_setnull (id uuid PRIMARY KEY, "schoolId" uuid, x uuid,
                                   FOREIGN KEY (x, "schoolId") REFERENCES tk_up_parent (id, "schoolId") ON UPDATE SET NULL);
  -- A table whose school is not called "schoolId" (RoomLoans: ownerSchoolId, borrowerSchoolId).
  CREATE TEMP TABLE tk_up_loan_owner (id uuid PRIMARY KEY, "ownerSchoolId" uuid NOT NULL, "borrowerSchoolId" uuid NOT NULL, x uuid,
                                      FOREIGN KEY (x, "ownerSchoolId") REFERENCES tk_up_parent (id, "schoolId") ON UPDATE CASCADE);
  CREATE TEMP TABLE tk_up_loan_noaction (id uuid PRIMARY KEY, "ownerSchoolId" uuid NOT NULL, "borrowerSchoolId" uuid NOT NULL, x uuid,
                                         FOREIGN KEY (x, "borrowerSchoolId") REFERENCES tk_up_parent (id, "schoolId") ON UPDATE NO ACTION);
  SELECT array_agg(f.tbl ORDER BY f.tbl COLLATE "C") INTO got FROM pg_temp.tk_follows(pg_my_temp_schema()) f;
  IF got IS DISTINCT FROM ARRAY['tk_up_cascade', 'tk_up_loan_owner', 'tk_up_setnull'] THEN
    RAISE EXCEPTION 'tenant keys 389: the guard reported % over the stand-ins, not the keys that follow their parent (tk_up_cascade, tk_up_loan_owner, tk_up_setnull)', got;
  END IF;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Frånvarostatistik över tid (D6, 20270121090000), the owner's side of sections
-- 390-394: what a policy cannot say, and what only the owner may call.
--
--   390o  the table: its columns (not one that names a person), its checks
--         (five pupils behind a group and behind a figure, a month is its first
--         day), its keys (a class of the same school, gone with its class),
--         and its two unique indexes
--   391o  the count, month by month, from hand-made marks: the definition
--         (what a mark of each kind comes to, a cancelled lesson, a late
--         arrival capped at the lesson), the class a pupil sat in on the day,
--         the smallest group, and that a second night changes nothing
--   392o  the nights: the plan, the trim, the guard over a month whose marks
--         may be gone, and the sums that outlive the attendance they were
--         counted from; the lessons of a month are Rapporteringsgradens (once
--         each, a teacher who has left still has hers, and the two lesson
--         functions differ by that one condition and no other)
--   394   the mentor: the pupils and the classes of Frånvarobevakningen's
--         mentor definition are the ones the statistics hand a mentor
-- ---------------------------------------------------------------------------

CREATE FUNCTION pg_temp.d6o_expect(p_label text, p_got text, p_expected text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION E'frånvarostatistik %:\n   got      %\n   expected %', p_label, coalesce(p_got, '<null>'), p_expected;
  END IF;
END $$;

-- A statement that must be refused, with a part of the refusal's text.
CREATE FUNCTION pg_temp.d6o_refuses(p_sql text, p_fragment text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  refused boolean := false;
  msg text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    refused := true;
    msg := SQLERRM || ' [' || SQLSTATE || ']';
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'frånvarostatistik: % was not refused', p_sql;
  END IF;
  IF msg NOT LIKE '%' || p_fragment || '%' THEN
    RAISE EXCEPTION 'frånvarostatistik: % was refused with [%], not [%]', p_sql, msg, p_fragment;
  END IF;
END $$;

-- A school of its own: a läsår from 2025-08-01 to 2096, class A with p_a pupils and class B with p_b (a1.., b1..;
-- pupil emails d6o-<slug>-<name>), one subject and one teacher. The pupils' history begins on 2025-08-01.
CREATE FUNCTION pg_temp.d6o_school(p_slug text, p_a integer, p_b integer) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  s uuid; y uuid; ga uuid; gb uuid; u uuid; i integer;
BEGIN
  PERFORM set_config('session_replication_role', 'origin', true);
  INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ('D6 ' || p_slug, p_slug, 'Europe/Stockholm', now()) RETURNING id INTO s;
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
  VALUES (s, 'D6 ' || p_slug, '2025-08-01', '2096-07-31', true, now()) RETURNING id INTO y;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt") VALUES (s, y, 'A', 7, now()) RETURNING id INTO ga;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt") VALUES (s, y, 'B', 7, now()) RETURNING id INTO gb;
  INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES (s, 'D6', 'D6', now());
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s, 'd6o-' || p_slug || '-t@example.invalid', 'D6', 'Lärare', 'TEACHER', gen_random_uuid(), true, now());
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "updatedAt")
  VALUES (s, 'd6o-' || p_slug || '-adm@example.invalid', 'D6', 'Admin', 'SCHOOL_ADMIN', 'FULL', gen_random_uuid(), true, now());
  FOR i IN 1..p_a LOOP
    INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
    VALUES (s, 'd6o-' || p_slug || '-a' || i || '@example.invalid', 'A', 'Elev' || i, 'STUDENT', gen_random_uuid(), true, now()) RETURNING id INTO u;
  END LOOP;
  FOR i IN 1..p_b LOOP
    INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
    VALUES (s, 'd6o-' || p_slug || '-b' || i || '@example.invalid', 'B', 'Elev' || i, 'STUDENT', gen_random_uuid(), true, now()) RETURNING id INTO u;
  END LOOP;
  PERFORM set_config('session_replication_role', 'replica', true);
  INSERT INTO "StudentEnrollments" ("schoolId", "studentId", "academicYearId", "studentGroupId", "gradeLevel", "validFrom")
  SELECT s, x."id", y, CASE WHEN x."email" ~ '-a[0-9]+@' THEN ga ELSE gb END, 7, '2025-08-01' FROM "Users" x WHERE x."schoolId" = s AND x."role" = 'STUDENT';
  UPDATE "Users" SET "studentGroupId" = CASE WHEN "email" ~ '-a[0-9]+@' THEN ga ELSE gb END WHERE "schoolId" = s AND "role" = 'STUDENT';
  RETURN s;
END $$;

-- Acts as the scenario school's administrator for the rest of the transaction (the doors read the claims).
CREATE FUNCTION pg_temp.d6o_login(p_school uuid, p_slug text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', (SELECT "authId" FROM "Users" WHERE "schoolId" = p_school AND email = 'd6o-' || p_slug || '-adm@example.invalid'), 'role', 'authenticated')::text, true);
  PERFORM set_config('app.chosen_school_id', '', true);
END $$;

-- A lesson of a class with its marks: p_marks is 'a1=PRESENT,a2=EXCUSED' (the pupil's name, its status). The lesson is
-- p_mins long from p_hour:00, and the teacher of the school is on it.
CREATE FUNCTION pg_temp.d6o_lesson(p_school uuid, p_slug text, p_class text, p_day date, p_hour integer, p_mins integer,
                                   p_status text, p_marks text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  l uuid;
  starts timestamptz := (p_day + make_time(p_hour, 0, 0)) AT TIME ZONE 'Europe/Stockholm';
  m text;
BEGIN
  PERFORM set_config('session_replication_role', 'replica', true);
  INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", status, "updatedAt")
  VALUES (p_school, (SELECT id FROM "Subjects" WHERE "schoolId" = p_school AND code = 'D6'),
          (SELECT id FROM "StudentGroups" WHERE "schoolId" = p_school AND name = p_class), p_day, starts,
          starts + make_interval(mins => p_mins), p_status::"LessonStatus", now()) RETURNING id INTO l;
  INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role)
  VALUES (p_school, l, (SELECT id FROM "Users" WHERE "schoolId" = p_school AND email = 'd6o-' || p_slug || '-t@example.invalid'), 'LEAD');
  IF coalesce(p_marks, '') <> '' THEN
    FOREACH m IN ARRAY string_to_array(p_marks, ',') LOOP
      INSERT INTO "AttendanceRecords" ("schoolId", "calendarLessonId", "studentId", status, "updatedAt")
      VALUES (p_school, l, (SELECT id FROM "Users" WHERE "schoolId" = p_school AND email = 'd6o-' || p_slug || '-' || split_part(m, '=', 1) || '@example.invalid'),
              split_part(m, '=', 2)::"AttendanceStatus", now());
    END LOOP;
  END IF;
  RETURN l;
END $$;

-- The stored figures of a school's month, as one line: 'class pupils/registered recorded/valid/absent/late/lateCount held/reported'.
CREATE FUNCTION pg_temp.d6o_rows(p_school uuid, p_month date) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(coalesce(g."name", 'school') || ' ' || a."pupils" || '/' || a."pupilsRegistered" || ' '
                             || coalesce(a."recordedMinutes"::text, '-') || '/' || coalesce(a."validMinutes"::text, '-') || '/' || coalesce(a."absentMinutes"::text, '-')
                             || '/' || coalesce(a."lateMinutes"::text, '-') || '/' || coalesce(a."lateCount"::text, '-')
                             || ' ' || a."lessonsHeld" || '/' || a."lessonsReported", ' | ' ORDER BY coalesce(g."name", '')), '')
    FROM "AbsenceStatsMonths" a LEFT JOIN "StudentGroups" g ON g."id" = a."studentGroupId"
   WHERE a."schoolId" = p_school AND a."month" = p_month
$$;

-- Asks a door of the statistics under a login's claims (ok:<rows> or err:<SQLSTATE>), as the owner may.
CREATE FUNCTION pg_temp.d6o_as(p_sub text, p_q text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  n integer;
BEGIN
  PERFORM set_config('request.jwt.claims', CASE WHEN p_sub IS NULL THEN '' ELSE json_build_object('sub', p_sub, 'role', 'authenticated')::text END, true);
  PERFORM set_config('app.chosen_school_id', '', true);
  BEGIN
    EXECUTE 'SELECT count(*) FROM (' || p_q || ') x' INTO n;
    RETURN 'ok:' || n;
  EXCEPTION WHEN OTHERS THEN
    RETURN 'err:' || SQLSTATE;
  END;
END $$;

-- 390o: the table.
BEGIN;
DO $$
DECLARE
  school uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-franvarostatistik-school');
  other uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-franvarostatistik-annan');
  c8a uuid := (SELECT id FROM "StudentGroups" WHERE "schoolId" = school AND name = 'FS8A');
  c_other uuid := (SELECT id FROM "StudentGroups" WHERE "schoolId" = other AND name = 'FS9A');
  ins constant text := 'INSERT INTO "AbsenceStatsMonths" ("schoolId", "studentGroupId", "month", "throughDay", "pupils", "pupilsRegistered", "recordedMinutes", "validMinutes", "absentMinutes", "lateMinutes", "lateCount", "lessonsHeld", "lessonsReported") VALUES ';
  fk record;
  cols text;
BEGIN
  -- No column names a person, and no key goes to Users: the sums have no pupil, and a test fails a table that gets one.
  SELECT string_agg(a.attname, ',' ORDER BY a.attnum) INTO cols
    FROM pg_attribute a WHERE a.attrelid = '"AbsenceStatsMonths"'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
  PERFORM pg_temp.d6o_expect('390o the columns', cols,
    'id,schoolId,studentGroupId,month,throughDay,pupils,pupilsRegistered,recordedMinutes,validMinutes,absentMinutes,lateMinutes,lateCount,lessonsHeld,lessonsReported,computedAt');
  PERFORM pg_temp.d6o_expect('390o the keys',
    (SELECT string_agg(c.confrelid::regclass::text || ' ' || c.confdeltype::text || c.confupdtype::text, ', ' ORDER BY c.confrelid::regclass::text)
       FROM pg_constraint c WHERE c.conrelid = '"AbsenceStatsMonths"'::regclass AND c.contype = 'f'),
    '"Schools" cc, "StudentGroups" ca');
  PERFORM pg_temp.d6o_expect('390o the class key is composite',
    (SELECT array_length(c.conkey, 1)::text FROM pg_constraint c WHERE c.conrelid = '"AbsenceStatsMonths"'::regclass AND c.conname = 'AbsenceStatsMonths_studentGroupId_schoolId_fkey'), '2');

  -- The smallest group is one number in three places.
  PERFORM pg_temp.d6o_expect('390o the group size', app.absence_stats_min_group()::text, '5');
  PERFORM pg_temp.d6o_expect('390o the check says the same',
    (SELECT CASE WHEN pg_get_constraintdef(c.oid) LIKE '%pupils% >= 5%' THEN 'five' ELSE pg_get_constraintdef(c.oid) END
       FROM pg_constraint c WHERE c.conrelid = '"AbsenceStatsMonths"'::regclass AND c.conname = 'AbsenceStatsMonths_a_group_has_five_pupils'), 'five');

  -- A good row, and each way a row is refused (the fixtures' own months out of the way).
  DELETE FROM "AbsenceStatsMonths" WHERE "schoolId" = school;
  EXECUTE ins || format('(%L, NULL, ''2020-03-01'', ''2020-03-31'', 9, 9, 100, 10, 20, 5, 1, 10, 9)', school);
  PERFORM pg_temp.d6o_refuses(ins || format('(%L, NULL, ''2020-03-01'', ''2020-03-31'', 9, 9, 100, 10, 20, 5, 1, 10, 9)', school), 'AbsenceStatsMonths_school_month_key');
  EXECUTE ins || format('(%L, %L, ''2020-03-01'', ''2020-03-31'', 9, 9, 100, 10, 20, 5, 1, 10, 9)', school, c8a);
  PERFORM pg_temp.d6o_refuses(ins || format('(%L, %L, ''2020-03-01'', ''2020-03-15'', 9, 9, 100, 10, 20, 5, 1, 10, 9)', school, c8a), 'AbsenceStatsMonths_class_month_key');
  PERFORM pg_temp.d6o_refuses(ins || format('(%L, %L, ''2020-04-01'', ''2020-04-30'', 4, 0, NULL, NULL, NULL, NULL, NULL, 10, 9)', school, c8a), 'a_group_has_five_pupils');
  PERFORM pg_temp.d6o_refuses(ins || format('(%L, %L, ''2020-04-01'', ''2020-04-30'', 9, 10, 100, 10, 20, 5, 1, 10, 9)', school, c8a), 'counts_are_counts');
  PERFORM pg_temp.d6o_refuses(ins || format('(%L, %L, ''2020-04-01'', ''2020-04-30'', 9, 9, 100, 10, 20, 5, 1, 9, 10)', school, c8a), 'counts_are_counts');
  PERFORM pg_temp.d6o_refuses(ins || format('(%L, %L, ''2020-04-01'', ''2020-04-30'', 9, 9, 100, 10, 20, 5, 1, -1, -2)', school, c8a), 'counts_are_counts');
  -- Fewer than five pupils behind the minutes: none may be stored. Five or more: all must be.
  PERFORM pg_temp.d6o_refuses(ins || format('(%L, %L, ''2020-04-01'', ''2020-04-30'', 9, 4, 100, 10, 20, 5, 1, 10, 9)', school, c8a), 'a_figure_has_five_pupils_behind_it');
  PERFORM pg_temp.d6o_refuses(ins || format('(%L, %L, ''2020-04-01'', ''2020-04-30'', 9, 4, 0, 0, 0, 0, 0, 10, 9)', school, c8a), 'a_figure_has_five_pupils_behind_it');
  PERFORM pg_temp.d6o_refuses(ins || format('(%L, %L, ''2020-04-01'', ''2020-04-30'', 9, 5, NULL, NULL, NULL, NULL, NULL, 10, 9)', school, c8a), 'a_figure_has_five_pupils_behind_it');
  PERFORM pg_temp.d6o_refuses(ins || format('(%L, %L, ''2020-04-01'', ''2020-04-30'', 9, 5, 100, 10, 20, NULL, 1, 10, 9)', school, c8a), 'a_figure_has_five_pupils_behind_it');
  PERFORM pg_temp.d6o_refuses(ins || format('(%L, %L, ''2020-04-01'', ''2020-04-30'', 9, 5, 100, 50, 40, 20, 1, 10, 9)', school, c8a), 'a_figure_has_five_pupils_behind_it');
  PERFORM pg_temp.d6o_refuses(ins || format('(%L, %L, ''2020-04-01'', ''2020-04-30'', 9, 5, 100, -5, 20, 5, 1, 10, 9)', school, c8a), 'a_figure_has_five_pupils_behind_it');
  -- A month is its first day, and the last day counted is in it.
  PERFORM pg_temp.d6o_refuses(ins || format('(%L, %L, ''2020-04-02'', ''2020-04-30'', 9, 9, 100, 10, 20, 5, 1, 10, 9)', school, c8a), 'a_month_is_its_first_day');
  PERFORM pg_temp.d6o_refuses(ins || format('(%L, %L, ''2020-04-01'', ''2020-05-01'', 9, 9, 100, 10, 20, 5, 1, 10, 9)', school, c8a), 'a_through_day_is_in_the_month');
  PERFORM pg_temp.d6o_refuses(ins || format('(%L, %L, ''2020-04-01'', ''2020-03-31'', 9, 9, 100, 10, 20, 5, 1, 10, 9)', school, c8a), 'a_through_day_is_in_the_month');
  -- The class is the school's own: another school's class cannot carry a row of this one.
  PERFORM pg_temp.d6o_refuses(ins || format('(%L, %L, ''2020-04-01'', ''2020-04-30'', 9, 9, 100, 10, 20, 5, 1, 10, 9)', school, c_other), 'AbsenceStatsMonths_studentGroupId_schoolId_fkey');
  EXECUTE ins || format('(%L, %L, ''2020-04-01'', ''2020-04-30'', 9, 9, 100, 10, 20, 5, 1, 10, 9)', other, c_other);

  -- A school takes its months with it; a class takes its own and the school's stay.
  PERFORM pg_temp.d6o_expect('390o the class before it is gone', (SELECT count(*)::text FROM "AbsenceStatsMonths" WHERE "schoolId" = school), '2');
  DELETE FROM "AbsenceStatsMonths" WHERE "schoolId" = other;
  PERFORM set_config('session_replication_role', 'replica', true);
  DELETE FROM "StudentEnrollments" WHERE "studentGroupId" = c8a;
  DELETE FROM "CalendarLessons" WHERE "studentGroupId" = c8a;
  DELETE FROM "TeacherDuties" WHERE "studentGroupId" = c8a;
  UPDATE "StudentGroups" SET "predecessorId" = NULL WHERE "predecessorId" = c8a;
  PERFORM set_config('session_replication_role', 'origin', true);
  DELETE FROM "StudentGroups" WHERE id = c8a;
  PERFORM pg_temp.d6o_expect('390o a class takes its months and the school keeps its own',
    (SELECT count(*) || '/' || count(*) FILTER (WHERE "studentGroupId" IS NULL) FROM "AbsenceStatsMonths" WHERE "schoolId" = school), '1/1');
END $$;
ROLLBACK;

-- 391o: the count. A school of its own, in February 2026.
--
-- Class A has six pupils (a1..a6), class B four (b1..b4). A's lessons:
--   Mon 2026-02-02 08:00  50 min: a1 PRESENT, a2 EXCUSED, a3 ABSENT, a4 LATE, a5 UNKNOWN, a6 no mark
--   Mon 2026-02-02 09:00  10 min: a1 ABSENT, a4 LATE (15 minutes of a lesson of 10: 10)
--   Mon 2026-02-02 10:00  50 min CANCELLED: everyone ABSENT (counts for nothing)
--   Mon 2026-02-02 11:00  50 min COMPLETED: a1 ABSENT, a2 PRESENT, a5 PRESENT
--   Tue 2026-02-03 08:00  50 min: nobody marked (held, never reported)
-- B's lesson Mon 2026-02-02 09:00 (50 min): b1..b4 PRESENT.
-- So A: recorded 4*50 + 2*10 + 3*50 = 370 (the UNKNOWN is not recorded), valid 50, absent 50 + 10 + 50 = 110,
-- late 15 + 10 = 25 in two marks, five pupils with a mark (a1..a5), four lessons held and three reported. B
-- has four pupils: no row, but its 200 minutes and its lesson are in the school's: ten pupils, nine with
-- a mark, 570 recorded, five lessons held and four reported.
BEGIN;
DO $$
DECLARE
  s uuid := pg_temp.d6o_school('d6o-def', 6, 4);
  feb constant date := '2026-02-01';
  l uuid;
  w text;
BEGIN
  PERFORM pg_temp.d6o_lesson(s, 'd6o-def', 'A', '2026-02-02', 8, 50, 'SCHEDULED', 'a1=PRESENT,a2=EXCUSED,a3=ABSENT,a4=LATE,a5=UNKNOWN');
  PERFORM pg_temp.d6o_lesson(s, 'd6o-def', 'A', '2026-02-02', 9, 10, 'SCHEDULED', 'a1=ABSENT,a4=LATE');
  PERFORM pg_temp.d6o_lesson(s, 'd6o-def', 'A', '2026-02-02', 10, 50, 'CANCELLED', 'a1=ABSENT,a2=ABSENT,a3=ABSENT,a4=ABSENT,a5=ABSENT,a6=ABSENT');
  PERFORM pg_temp.d6o_lesson(s, 'd6o-def', 'A', '2026-02-02', 11, 50, 'COMPLETED', 'a1=ABSENT,a2=PRESENT,a5=PRESENT');
  PERFORM pg_temp.d6o_lesson(s, 'd6o-def', 'A', '2026-02-03', 8, 50, 'SCHEDULED', NULL);
  PERFORM pg_temp.d6o_lesson(s, 'd6o-def', 'B', '2026-02-02', 9, 50, 'SCHEDULED', 'b1=PRESENT,b2=PRESENT,b3=PRESENT,b4=PRESENT');

  SELECT m.written || '/' || m.removed || '/' || m.classes INTO w FROM app.absence_stats_month(s, feb, '2026-03-01') m;
  PERFORM pg_temp.d6o_expect('391o the first night writes the school and one class', w, '2/0/1');
  PERFORM pg_temp.d6o_expect('391o the month, by hand', pg_temp.d6o_rows(s, feb),
    'school 10/9 570/50/110/25/2 5/4 | A 6/5 370/50/110/25/2 4/3');
  PERFORM pg_temp.d6o_expect('391o the last day counted', (SELECT string_agg(DISTINCT "throughDay"::text, ',') FROM "AbsenceStatsMonths" WHERE "schoolId" = s), '2026-02-28');
  SELECT m.written || '/' || m.removed || '/' || m.classes INTO w FROM app.absence_stats_month(s, feb, '2026-03-01') m;
  PERFORM pg_temp.d6o_expect('391o a second night changes nothing', w, '0/0/1');

  -- The month that is going on counts up to the day asked, and says which.
  SELECT m.written || '/' || m.removed || '/' || m.classes INTO w FROM app.absence_stats_month(s, feb, '2026-02-02') m;
  PERFORM pg_temp.d6o_expect('391o a month counted to its second day rewrites both rows', w, '2/0/1');
  PERFORM pg_temp.d6o_expect('391o the day it counted to', (SELECT string_agg(DISTINCT "throughDay"::text, ',') FROM "AbsenceStatsMonths" WHERE "schoolId" = s), '2026-02-02');
  PERFORM pg_temp.d6o_expect('391o the lesson of the 3rd is not in it', pg_temp.d6o_rows(s, feb),
    'school 10/9 570/50/110/25/2 4/4 | A 6/5 370/50/110/25/2 3/3');
  PERFORM app.absence_stats_month(s, feb, '2026-03-01');

  -- One changed mark changes the class and the school, and nothing else is written.
  UPDATE "AttendanceRecords" SET status = 'EXCUSED'
   WHERE "calendarLessonId" = (SELECT id FROM "CalendarLessons" WHERE "schoolId" = s AND date = '2026-02-02' AND extract(hour FROM "startsAt" AT TIME ZONE 'Europe/Stockholm') = 11)
     AND "studentId" = (SELECT id FROM "Users" WHERE "schoolId" = s AND email = 'd6o-d6o-def-a1@example.invalid');
  SELECT m.written || '/' || m.removed || '/' || m.classes INTO w FROM app.absence_stats_month(s, feb, '2026-03-01') m;
  PERFORM pg_temp.d6o_expect('391o a changed mark rewrites the two rows', w, '2/0/1');
  PERFORM pg_temp.d6o_expect('391o and moves 50 minutes from ogiltig to giltig', pg_temp.d6o_rows(s, feb),
    'school 10/9 570/100/60/25/2 5/4 | A 6/5 370/100/60/25/2 4/3');
  UPDATE "AttendanceRecords" SET status = 'ABSENT'
   WHERE "calendarLessonId" = (SELECT id FROM "CalendarLessons" WHERE "schoolId" = s AND date = '2026-02-02' AND extract(hour FROM "startsAt" AT TIME ZONE 'Europe/Stockholm') = 11)
     AND "studentId" = (SELECT id FROM "Users" WHERE "schoolId" = s AND email = 'd6o-d6o-def-a1@example.invalid');
  PERFORM app.absence_stats_month(s, feb, '2026-03-01');

  -- A pupil with five marks gone: the class has five pupils and four with a mark, so the minutes go, not the lessons.
  DELETE FROM "AttendanceRecords" WHERE "studentId" = (SELECT id FROM "Users" WHERE "schoolId" = s AND email = 'd6o-d6o-def-a5@example.invalid');
  PERFORM app.absence_stats_month(s, feb, '2026-03-01');
  PERFORM pg_temp.d6o_expect('391o four pupils with a mark: no minute for the class, the lessons stay; the school has eight', pg_temp.d6o_rows(s, feb),
    'school 10/8 520/50/110/25/2 5/4 | A 6/4 -/-/-/-/- 4/3');

  -- A pupil with a mark and no history is in the school's sums and in no class's.
  PERFORM set_config('session_replication_role', 'origin', true);
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s, 'd6o-d6o-def-x1@example.invalid', 'X', 'Utan klass', 'STUDENT', gen_random_uuid(), true, now());
  PERFORM pg_temp.d6o_lesson(s, 'd6o-def', 'A', '2026-02-04', 8, 50, 'SCHEDULED', 'x1=ABSENT');
  PERFORM app.absence_stats_month(s, feb, '2026-03-01');
  PERFORM pg_temp.d6o_expect('391o a pupil with no class is in the school and in no class', pg_temp.d6o_rows(s, feb),
    'school 11/9 570/50/160/25/2 6/5 | A 6/4 -/-/-/-/- 5/4');
END $$;
ROLLBACK;

-- 391o: the class a pupil sat in on the day. a1 sits in A until 2026-02-04, then in B (a move that A's history keeps);
-- the activation then empties both classes and the months come out the same. Lessons of A on the 2nd and the 3rd
-- (a1 present, the rest present) and of B on the 4th and the 5th.
BEGIN;
DO $$
DECLARE
  s uuid := pg_temp.d6o_school('d6o-cls', 5, 4);
  feb constant date := '2026-02-01';
  a1 uuid;
  ga uuid;
  gb uuid;
  y uuid;
  before text;
  pa text;
  pb text;
  five constant text := 'a1=PRESENT,a2=PRESENT,a3=PRESENT,a4=PRESENT,a5=PRESENT';
BEGIN
  SELECT id INTO a1 FROM "Users" WHERE "schoolId" = s AND email = 'd6o-d6o-cls-a1@example.invalid';
  SELECT id INTO ga FROM "StudentGroups" WHERE "schoolId" = s AND name = 'A';
  SELECT id INTO gb FROM "StudentGroups" WHERE "schoolId" = s AND name = 'B';
  SELECT id INTO y FROM "AcademicYears" WHERE "schoolId" = s;
  PERFORM set_config('session_replication_role', 'replica', true);
  UPDATE "StudentEnrollments" SET "validTo" = '2026-02-04' WHERE "studentId" = a1;
  INSERT INTO "StudentEnrollments" ("schoolId", "studentId", "academicYearId", "studentGroupId", "gradeLevel", "validFrom") VALUES (s, a1, y, gb, 7, '2026-02-04');
  UPDATE "Users" SET "studentGroupId" = gb WHERE id = a1;
  PERFORM pg_temp.d6o_lesson(s, 'd6o-cls', 'A', '2026-02-02', 8, 50, 'SCHEDULED', five);
  PERFORM pg_temp.d6o_lesson(s, 'd6o-cls', 'A', '2026-02-03', 8, 50, 'SCHEDULED', five);
  PERFORM pg_temp.d6o_lesson(s, 'd6o-cls', 'B', '2026-02-04', 8, 50, 'SCHEDULED', 'a1=ABSENT,b1=PRESENT,b2=PRESENT,b3=PRESENT,b4=PRESENT');
  PERFORM pg_temp.d6o_lesson(s, 'd6o-cls', 'B', '2026-02-05', 8, 50, 'SCHEDULED', 'a1=ABSENT,b1=PRESENT,b2=PRESENT,b3=PRESENT,b4=PRESENT');
  PERFORM app.absence_stats_month(s, feb, '2026-03-01');
  -- A: five pupils, each marked on both its days (the day a1 left is the day after the last). B: four and a1 = five, a1 absent twice.
  PERFORM pg_temp.d6o_expect('391o the class on the day', pg_temp.d6o_rows(s, feb),
    'school 9/9 1000/0/100/0/0 4/4 | A 5/5 500/0/0/0/0 2/2 | B 5/5 500/0/100/0/0 2/2');
  before := pg_temp.d6o_rows(s, feb);
  -- The patterns read the class by the day as well: A's are the Monday and Tuesday of its five pupils, with a1 only on
  -- the days he sat in it; B's are the Wednesday and Thursday of its four and a1, who is absent on both.
  PERFORM pg_temp.d6o_login(s, 'd6o-cls');
  pa := (SELECT string_agg(key || ' ' || recorded_minutes || '/' || absent_minutes, ' | ' ORDER BY key) FROM app.absence_stats_patterns(ga, NULL, '2026-02-01', '2026-02-28') WHERE dimension = 'WEEKDAY');
  pb := (SELECT string_agg(key || ' ' || recorded_minutes || '/' || absent_minutes, ' | ' ORDER BY key) FROM app.absence_stats_patterns(gb, NULL, '2026-02-01', '2026-02-28') WHERE dimension = 'WEEKDAY');
  PERFORM pg_temp.d6o_expect('391o the patterns of A, by the day', pa, '1 250/0 | 2 250/0');
  PERFORM pg_temp.d6o_expect('391o the patterns of B, by the day', pb, '3 250/50 | 4 250/50');
  -- The pupils of a class add up to the class: a1's rows are the days he sat in each, not every mark of the month.
  PERFORM pg_temp.d6o_expect('391o the pupils of A add up to A’s month',
    (SELECT sum(recorded_minutes) || '/' || sum(absent_minutes) || '/' || count(*) FROM app.absence_stats_class_pupils(ga, '2026-02-01', '2026-02-28')), '500/0/5');
  PERFORM pg_temp.d6o_expect('391o and a1 has his two days in A',
    (SELECT recorded_minutes || '/' || absent_minutes FROM app.absence_stats_class_pupils(ga, '2026-02-01', '2026-02-28') WHERE first_name = 'A' AND last_name = 'Elev1'), '100/0');
  PERFORM pg_temp.d6o_expect('391o the pupils of B add up to B’s month',
    (SELECT sum(recorded_minutes) || '/' || sum(absent_minutes) || '/' || count(*) FROM app.absence_stats_class_pupils(gb, '2026-02-01', '2026-02-28')), '500/100/5');
  PERFORM pg_temp.d6o_expect('391o and a1 has his two days in B, absent on both',
    (SELECT recorded_minutes || '/' || absent_minutes FROM app.absence_stats_class_pupils(gb, '2026-02-01', '2026-02-28') WHERE first_name = 'A' AND last_name = 'Elev1'), '100/100');
  -- The period's first day counts: one lesson, on the 2nd, five pupils.
  PERFORM pg_temp.d6o_expect('391o a period that is the first lesson day only has that day',
    (SELECT sum(recorded_minutes) || '/' || count(*) FROM app.absence_stats_class_pupils(ga, '2026-02-02', '2026-02-02')), '250/5');
  -- The period's last day is the day a1 joined B: he is on the list with that day's lesson.
  PERFORM pg_temp.d6o_expect('391o a period that ends the day a1 joined B has him, with that day',
    (SELECT recorded_minutes || '/' || absent_minutes FROM app.absence_stats_class_pupils(gb, '2026-02-02', '2026-02-04') WHERE first_name = 'A' AND last_name = 'Elev1'), '50/50');
  -- A period that holds only the days before the move shows a1 in A only.
  PERFORM pg_temp.d6o_expect('391o a period of the days before the move: a1 is in A and in no B',
    (SELECT count(*) FROM app.absence_stats_class_pupils(gb, '2026-02-02', '2026-02-03') WHERE first_name = 'A' AND last_name = 'Elev1')::text, '0');
  -- The activation: every pupil moves on and the classes are left empty. The months stand.
  UPDATE "Users" SET "studentGroupId" = NULL WHERE "schoolId" = s AND role = 'STUDENT';
  UPDATE "StudentEnrollments" SET "validTo" = '2026-02-28' WHERE "schoolId" = s AND "validTo" IS NULL;
  PERFORM app.absence_stats_month(s, feb, '2026-03-01');
  PERFORM pg_temp.d6o_expect('391o the activation empties the classes and the month is the same', pg_temp.d6o_rows(s, feb), before);
  PERFORM pg_temp.d6o_login(s, 'd6o-cls');
  PERFORM pg_temp.d6o_expect('391o and so are the patterns of A',
    (SELECT string_agg(key || ' ' || recorded_minutes || '/' || absent_minutes, ' | ' ORDER BY key) FROM app.absence_stats_patterns(ga, NULL, '2026-02-01', '2026-02-28') WHERE dimension = 'WEEKDAY'), pa);
  -- And without the history it would not be: the marks would belong to no class.
  DELETE FROM "StudentEnrollments" WHERE "schoolId" = s;
  PERFORM app.absence_stats_month(s, feb, '2026-03-01');
  PERFORM pg_temp.d6o_expect('391o with no history the classes have no pupils and no row', pg_temp.d6o_rows(s, feb), 'school 9/9 1000/0/100/0/0 4/4');
END $$;
ROLLBACK;


-- 391o: a class and its predecessor. The five pupils a1..a5 of A move on to N (A's successor) on 2026-01-15; a6 goes to B, whose
-- mentor is somebody else. A had a lesson on 2025-12-01 (a6 present too) and N has one on 2026-02-02. N's pupils are N's own
-- five, with the days of both classes (as N's patterns are): a6 sat in A and never came to N, so she is not on N's list, not
-- for an administrator and not for N's mentor, who could not open her card either. A period that holds only the days in N
-- shows N's day alone.
BEGIN;
DO $$
DECLARE
  s uuid := pg_temp.d6o_school('d6o-lin', 6, 0);
  ga uuid; gb uuid; gn uuid; y uuid; mentor uuid; msub uuid := gen_random_uuid(); a6 uuid; names text; r record; opened int := 0;
  five constant text := 'a1=PRESENT,a2=PRESENT,a3=PRESENT,a4=PRESENT,a5=PRESENT';
BEGIN
  SELECT id INTO ga FROM "StudentGroups" WHERE "schoolId" = s AND name = 'A';
  SELECT id INTO gb FROM "StudentGroups" WHERE "schoolId" = s AND name = 'B';
  SELECT id INTO y FROM "AcademicYears" WHERE "schoolId" = s;
  SELECT id INTO a6 FROM "Users" WHERE "schoolId" = s AND email = 'd6o-d6o-lin-a6@example.invalid';
  PERFORM set_config('session_replication_role', 'replica', true);
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "predecessorId", "updatedAt") VALUES (s, y, 'N', 8, ga, now()) RETURNING id INTO gn;
  UPDATE "StudentEnrollments" SET "validTo" = '2026-01-15' WHERE "schoolId" = s AND "studentGroupId" = ga;
  INSERT INTO "StudentEnrollments" ("schoolId", "studentId", "academicYearId", "studentGroupId", "gradeLevel", "validFrom")
  SELECT s, x."id", y, CASE WHEN x."email" ~ '-a6@' THEN gb ELSE gn END, 8, '2026-01-15' FROM "Users" x WHERE x."schoolId" = s AND x."role" = 'STUDENT';
  UPDATE "Users" SET "studentGroupId" = CASE WHEN "email" ~ '-a6@' THEN gb ELSE gn END WHERE "schoolId" = s AND "role" = 'STUDENT';
  PERFORM set_config('session_replication_role', 'origin', true);
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s, 'd6o-d6o-lin-mn@example.invalid', 'M', 'MentorN', 'TEACHER', msub, true, now()) RETURNING id INTO mentor;
  INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "studentGroupId", "updatedAt")
  VALUES (s, mentor, y, 'MENTORSKAP', 'Mentor N', 60, gn, now());
  PERFORM pg_temp.d6o_lesson(s, 'd6o-lin', 'A', '2025-12-01', 8, 50, 'SCHEDULED', five || ',a6=PRESENT');
  PERFORM pg_temp.d6o_lesson(s, 'd6o-lin', 'N', '2026-02-02', 8, 50, 'SCHEDULED', five);
  PERFORM pg_temp.d6o_login(s, 'd6o-lin');
  PERFORM pg_temp.d6o_expect('391o the cohort in N has the days in A and in N',
    (SELECT sum(recorded_minutes) || '/' || count(*) FROM app.absence_stats_class_pupils(gn, '2025-11-01', '2026-02-28')), '500/5');
  PERFORM pg_temp.d6o_expect('391o and the days in N alone, when the period is those',
    (SELECT sum(recorded_minutes) || '/' || count(*) FROM app.absence_stats_class_pupils(gn, '2026-01-20', '2026-02-28')), '250/5');
  PERFORM pg_temp.d6o_expect('391o A itself has its own day, and the successor’s is not its: all six sat in A',
    (SELECT sum(recorded_minutes) || '/' || count(*) FROM app.absence_stats_class_pupils(ga, '2025-11-01', '2026-02-28')), '300/6');
  PERFORM pg_temp.d6o_expect('391o a6 is on A’s list and on no list of N’s',
    (SELECT count(*)::text FROM app.absence_stats_class_pupils(gn, '2025-08-01', '2026-11-06') WHERE last_name = 'Elev6'), '0');
  PERFORM pg_temp.d6o_expect('391o and N’s list is N’s five, by name',
    (SELECT string_agg(last_name, ',' ORDER BY last_name COLLATE "C") FROM app.absence_stats_class_pupils(gn, '2025-08-01', '2026-11-06')), 'Elev1,Elev2,Elev3,Elev4,Elev5');
  -- The mentor of N, asking for a period that reaches back into A (the web’s “Alla” and “Föregående läsår”).
  PERFORM set_config('request.jwt.claims', json_build_object('sub', msub, 'role', 'authenticated')::text, true);
  PERFORM set_config('app.chosen_school_id', '', true);
  SELECT string_agg(last_name || ' ' || recorded_minutes, ',' ORDER BY last_name COLLATE "C") INTO names
    FROM app.absence_stats_class_pupils(gn, '2025-08-01', '2026-11-06');
  PERFORM pg_temp.d6o_expect('391o the mentor of N gets N’s five and nobody who only sat in A', names, 'Elev1 100,Elev2 100,Elev3 100,Elev4 100,Elev5 100');
  -- Every pupil the list names the mentor may open: the list and the card are the same set.
  FOR r IN SELECT student_id FROM app.absence_stats_class_pupils(gn, '2025-08-01', '2026-11-06') LOOP
    IF pg_temp.d6o_as(msub::text, format($q$SELECT * FROM app.absence_stats_pupil_head(%L)$q$, r.student_id)) <> 'ok:1' THEN
      RAISE EXCEPTION 'frånvarostatistik 391o: the mentor of N is listed a pupil whose card she may not open (%)', r.student_id;
    END IF;
    opened := opened + 1;
  END LOOP;
  PERFORM pg_temp.d6o_expect('391o and she opened all five', opened::text, '5');
  PERFORM pg_temp.d6o_expect('391o a6’s card is not hers', pg_temp.d6o_as(msub::text, format($q$SELECT * FROM app.absence_stats_pupil_head(%L)$q$, a6)), 'err:AS403');
  PERFORM pg_temp.d6o_expect('391o and A’s list is not hers', pg_temp.d6o_as(msub::text, format($q$SELECT * FROM app.absence_stats_class_pupils(%L, '2025-08-01', '2026-11-06')$q$, ga)), 'err:AS403');
END $$;
ROLLBACK;

-- 392o: the nights. The plan, the trim, the refusal of a day that is not over, the guard over a month whose
-- marks may be gone, and the sums that outlive the attendance.
BEGIN;
DO $$
DECLARE
  s uuid := pg_temp.d6o_school('d6o-plan', 6, 0);
  months text;
  -- The school's today (its clock is Stockholm's), not the session's: between 23:00 and 24:00 UTC the two dates differ and
  -- the session's current_date is a day that is over for the school.
  school_today constant date := (clock_timestamp() AT TIME ZONE 'Europe/Stockholm')::date;
BEGIN
  -- A lesson in every month of the läsår but November: a month with nothing to count (the summer, a school's gap) is not asked for.
  PERFORM pg_temp.d6o_lesson(s, 'd6o-plan', 'A', t.d, 8, 50, 'SCHEDULED', NULL)
    FROM unnest(ARRAY['2025-08-18', '2025-09-01', '2025-10-06', '2025-12-01', '2026-01-12', '2026-02-02', '2026-03-02']::date[]) AS t(d);
  -- The school's läsår begins 2025-08-01, so for the night of 2026-03-15 the window starts in August 2025; the months of
  -- the last 62 days are January to March, and three older ones are asked for besides, newest first.
  SELECT string_agg(to_char(p.month, 'YYYY-MM'), ' ' ORDER BY ord) INTO months FROM app.absence_stats_plan(s, '2026-03-15') WITH ORDINALITY p(month, ord);
  PERFORM pg_temp.d6o_expect('392o the plan, nothing counted yet, November has no lesson', months, '2026-03 2026-02 2026-01 2025-12 2025-10 2025-09');
  SELECT string_agg(to_char(p.month, 'YYYY-MM'), ' ' ORDER BY ord) INTO months FROM app.absence_stats_plan(s, '2026-03-15', 0) WITH ORDINALITY p(month, ord);
  PERFORM pg_temp.d6o_expect('392o the plan with no backfill', months, '2026-03 2026-02 2026-01');
  SELECT string_agg(to_char(p.month, 'YYYY-MM'), ' ' ORDER BY ord) INTO months FROM app.absence_stats_plan(s, '2026-03-15', 1) WITH ORDINALITY p(month, ord);
  PERFORM pg_temp.d6o_expect('392o the plan with a backfill of one', months, '2026-03 2026-02 2026-01 2025-12');
  PERFORM app.absence_stats_month(s, '2025-12-01', '2026-03-15');
  PERFORM app.absence_stats_month(s, '2025-10-01', '2026-03-15');
  PERFORM app.absence_stats_month(s, '2025-09-01', '2026-03-15');
  SELECT string_agg(to_char(p.month, 'YYYY-MM'), ' ' ORDER BY ord) INTO months FROM app.absence_stats_plan(s, '2026-03-15') WITH ORDINALITY p(month, ord);
  PERFORM pg_temp.d6o_expect('392o the plan the next night', months, '2026-03 2026-02 2026-01 2025-08');
  PERFORM app.absence_stats_month(s, '2025-08-01', '2026-03-15');
  SELECT string_agg(to_char(p.month, 'YYYY-MM'), ' ' ORDER BY ord) INTO months FROM app.absence_stats_plan(s, '2026-03-15') WITH ORDINALITY p(month, ord);
  PERFORM pg_temp.d6o_expect('392o the plan when the läsår is counted: November never was asked for', months, '2026-03 2026-02 2026-01');
  -- A month counted though it has no lesson leaves a row of nothing, which the doors leave out.
  PERFORM app.absence_stats_month(s, '2025-11-01', '2026-03-15');
  PERFORM pg_temp.d6o_expect('392o an empty month asked for leaves a row', pg_temp.d6o_rows(s, '2025-11-01'), 'school 6/0 -/-/-/-/- 0/0');
  -- The first of the months asked for, and the last day a night may count to.
  PERFORM pg_temp.d6o_expect('392o the plan on the 1st of March reaches back to December: 61 days before is the 30th',
    (SELECT string_agg(to_char(p.month, 'YYYY-MM'), ' ' ORDER BY ord) FROM app.absence_stats_plan(s, '2026-03-01', 0) WITH ORDINALITY p(month, ord)), '2026-03 2026-02 2026-01 2025-12');
  PERFORM pg_temp.d6o_expect('392o before the läsår there is nothing to count',
    (SELECT count(*)::text FROM app.absence_stats_plan(s, '2025-08-15')), '1');

  -- The trim: months before the window, and only they.
  INSERT INTO "AbsenceStatsMonths" ("schoolId", "month", "throughDay", pupils, "pupilsRegistered", "lessonsHeld", "lessonsReported")
  VALUES (s, '2024-01-01', '2024-01-31', 9, 0, 0, 0), (s, '2025-07-01', '2025-07-31', 9, 0, 0, 0);
  PERFORM pg_temp.d6o_expect('392o the trim removes the two months before the läsår', app.absence_stats_trim(s, '2026-03-15')::text, '2');
  PERFORM pg_temp.d6o_expect('392o and not the first month of it', (SELECT count(*)::text FROM "AbsenceStatsMonths" WHERE "schoolId" = s AND month = '2025-08-01' AND "studentGroupId" IS NULL), '1');
  PERFORM pg_temp.d6o_expect('392o and a second trim finds nothing', app.absence_stats_trim(s, '2026-03-15')::text, '0');

  -- A day that is not over, a month that is not a month, a school that is not there.
  PERFORM pg_temp.d6o_refuses(format('SELECT * FROM app.absence_stats_plan(%L, %L)', s, school_today), 'ABSENCE_STATS_DAY_IS_NOT_OVER');
  PERFORM pg_temp.d6o_refuses(format('SELECT * FROM app.absence_stats_plan(%L, NULL)', s), 'ABSENCE_STATS_DAY_IS_NOT_OVER');
  PERFORM pg_temp.d6o_refuses(format('SELECT * FROM app.absence_stats_month(%L, ''2026-03-01'', %L)', s, school_today), 'ABSENCE_STATS_DAY_IS_NOT_OVER');
  PERFORM pg_temp.d6o_refuses(format('SELECT * FROM app.absence_stats_month(%L, ''2026-03-01'', %L)', s, school_today + 3), 'ABSENCE_STATS_DAY_IS_NOT_OVER');
  PERFORM pg_temp.d6o_refuses(format('SELECT app.absence_stats_trim(%L, %L)', s, school_today), 'ABSENCE_STATS_DAY_IS_NOT_OVER');
  PERFORM pg_temp.d6o_refuses(format('SELECT * FROM app.absence_stats_month(%L, ''2026-03-02'', ''2026-03-15'')', s), 'ABSENCE_STATS_BAD_MONTH');
  PERFORM pg_temp.d6o_refuses(format('SELECT * FROM app.absence_stats_month(%L, ''2026-04-01'', ''2026-03-15'')', s), 'ABSENCE_STATS_BAD_MONTH');
  PERFORM pg_temp.d6o_refuses(format('SELECT * FROM app.absence_stats_month(%L, NULL, ''2026-03-15'')', s), 'ABSENCE_STATS_BAD_MONTH');
  PERFORM pg_temp.d6o_refuses('SELECT * FROM app.absence_stats_plan(gen_random_uuid(), ''2026-03-15'')', 'ABSENCE_STATS_NO_SCHOOL');
  PERFORM pg_temp.d6o_refuses('SELECT * FROM app.absence_stats_month(gen_random_uuid(), ''2026-03-01'', ''2026-03-15'')', 'ABSENCE_STATS_NO_SCHOOL');
  PERFORM pg_temp.d6o_refuses('SELECT app.absence_stats_trim(gen_random_uuid(), ''2026-03-15'')', 'ABSENCE_STATS_NO_SCHOOL');
END $$;
ROLLBACK;

-- 392o: a school of three pupils has no row at all.
BEGIN;
DO $$
DECLARE
  s uuid := pg_temp.d6o_school('d6o-small', 3, 0);
BEGIN
  PERFORM pg_temp.d6o_lesson(s, 'd6o-small', 'A', '2026-02-02', 8, 50, 'SCHEDULED', 'a1=ABSENT,a2=PRESENT,a3=PRESENT');
  PERFORM pg_temp.d6o_expect('392o a school of three writes nothing', (SELECT written || '/' || removed || '/' || classes FROM app.absence_stats_month(s, '2026-02-01', '2026-03-01')), '0/0/0');
  PERFORM pg_temp.d6o_expect('392o and has no row', (SELECT count(*)::text FROM "AbsenceStatsMonths" WHERE "schoolId" = s), '0');
END $$;
ROLLBACK;

-- 392o: the guard over a month whose marks may be gone. Without a decision to purge the attendance, a month whose
-- marks are gone is counted as nobody having reported (the control); with one, the month is left as it was counted,
-- and a decision to keep it afterwards does not give the marks back.
BEGIN;
DO $$
DECLARE
  s uuid := pg_temp.d6o_school('d6o-ctl', 5, 0);
  g uuid := pg_temp.d6o_school('d6o-grd', 5, 0);
  five constant text := 'a1=PRESENT,a2=ABSENT,a3=PRESENT,a4=PRESENT,a5=PRESENT';
  counted constant text := 'school 5/5 250/0/50/0/0 1/1 | A 5/5 250/0/50/0/0 1/1';
BEGIN
  PERFORM pg_temp.d6o_lesson(s, 'd6o-ctl', 'A', '2026-02-02', 8, 50, 'SCHEDULED', five);
  PERFORM pg_temp.d6o_lesson(g, 'd6o-grd', 'A', '2026-02-02', 8, 50, 'SCHEDULED', five);
  PERFORM app.absence_stats_month(s, '2026-02-01', '2026-03-01');
  PERFORM app.absence_stats_month(g, '2026-02-01', '2026-03-01');
  PERFORM pg_temp.d6o_expect('392o counted, the control school', pg_temp.d6o_rows(s, '2026-02-01'), counted);
  PERFORM pg_temp.d6o_expect('392o counted, the guarded school', pg_temp.d6o_rows(g, '2026-02-01'), counted);

  -- The control: its marks are purged and the month is counted again.
  DELETE FROM "AttendanceRecords" WHERE "schoolId" = s;
  PERFORM app.absence_stats_month(s, '2026-02-01', '2026-03-01');
  PERFORM pg_temp.d6o_expect('392o with no decision the month is counted again, as a month nobody reported', pg_temp.d6o_rows(s, '2026-02-01'),
    'school 5/0 -/-/-/-/- 1/0 | A 5/0 -/-/-/-/- 1/0');

  -- The guarded school has decided to purge after a month (a decision not yet in force counts too: it is a day's notice).
  INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision, months) VALUES (g, 'ATTENDANCE', 'PURGE_AFTER', 1);
  DELETE FROM "AttendanceRecords" WHERE "schoolId" = g;
  PERFORM pg_temp.d6o_expect('392o with a decision the month is left as it was', (SELECT m.written || '/' || m.removed || '/' || m.classes FROM app.absence_stats_month(g, '2026-02-01', '2026-03-01') m), '0/0/0');
  PERFORM pg_temp.d6o_expect('392o and its sums are still there', pg_temp.d6o_rows(g, '2026-02-01'), counted);
  PERFORM pg_temp.d6o_expect('392o and the plan does not ask for it', (SELECT count(*)::text FROM app.absence_stats_plan(g, '2026-03-15')), '0');
  -- To keep it later does not bring the marks back.
  INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision) VALUES (g, 'ATTENDANCE', 'KEEP');
  PERFORM pg_temp.d6o_expect('392o after a decision to keep, the month is still left alone', (SELECT m.written || '/' || m.removed || '/' || m.classes FROM app.absence_stats_month(g, '2026-02-01', '2026-03-01') m), '0/0/0');
  PERFORM pg_temp.d6o_expect('392o and the sums stand', pg_temp.d6o_rows(g, '2026-02-01'), counted);
  -- A month inside the period of the decision is counted as usual: the month of today.
  PERFORM pg_temp.d6o_expect('392o the month of today is counted',
    (SELECT count(*)::text FROM app.absence_stats_plan(g, current_date - 1) p WHERE p.month = date_trunc('month', current_date - 1)::date), '1');
END $$;
ROLLBACK;

-- 392o: the sums outlive the attendance. A school purges after a month; the real gallring takes the marks of February
-- 2026 and nothing of the sums, which no kind of gallring lists.
BEGIN;
DO $$
DECLARE
  s uuid := pg_temp.d6o_school('d6o-gal', 5, 0);
  five constant text := 'a1=PRESENT,a2=ABSENT,a3=PRESENT,a4=PRESENT,a5=PRESENT';
  counted constant text := 'school 5/5 250/0/50/0/0 1/1 | A 5/5 250/0/50/0/0 1/1';
  run uuid;
  t "RetentionDataType";
  listed integer := 0;
BEGIN
  PERFORM pg_temp.d6o_lesson(s, 'd6o-gal', 'A', '2026-02-02', 8, 50, 'SCHEDULED', five);
  PERFORM app.absence_stats_month(s, '2026-02-01', '2026-03-01');
  PERFORM pg_temp.d6o_expect('392o counted before the gallring', pg_temp.d6o_rows(s, '2026-02-01'), counted);

  ALTER TABLE "RetentionDecisions" DISABLE TRIGGER "RetentionDecisions_stamped";
  INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision, months, "decidedAt") VALUES (s, 'ATTENDANCE', 'PURGE_AFTER', 1, now() - interval '3 days');
  ALTER TABLE "RetentionDecisions" ENABLE TRIGGER "RetentionDecisions_stamped";
  FOREACH t IN ARRAY enum_range(NULL::"RetentionDataType") LOOP
    SELECT listed + count(*) INTO listed FROM app.gallring_due(s, t, current_date + 1, current_date) d WHERE d.tbl = 'AbsenceStatsMonths';
  END LOOP;
  PERFORM pg_temp.d6o_expect('392o no kind of gallring lists the sums', listed::text, '0');

  run := app.gallring_begin(s, now());
  IF app.gallring_purge(run, 'ATTENDANCE', 1000) < 5 THEN RAISE EXCEPTION 'frånvarostatistik 392o: the gallring took fewer than the five marks'; END IF;
  PERFORM app.gallring_finish(run, '{}', now());
  PERFORM pg_temp.d6o_expect('392o the marks are gone', (SELECT count(*)::text FROM "AttendanceRecords" WHERE "schoolId" = s), '0');
  PERFORM pg_temp.d6o_expect('392o the sums are not', pg_temp.d6o_rows(s, '2026-02-01'), counted);
  -- The nightly job still reads the three läsår: the pupil-level door finds nothing left of the pupil, the sums do.
  PERFORM pg_temp.d6o_expect('392o and the nights leave them', (SELECT m.written || '/' || m.removed FROM app.absence_stats_month(s, '2026-02-01', '2026-03-01') m), '0/0');
END $$;
ROLLBACK;

-- 392o: a Sunday is the seventh weekday (the patterns count the ISO weekday), and the pass is the school's wall clock.
BEGIN;
DO $$
DECLARE
  s uuid := pg_temp.d6o_school('d6o-pat', 5, 0);
BEGIN
  PERFORM pg_temp.d6o_lesson(s, 'd6o-pat', 'A', '2026-02-01', 8, 50, 'SCHEDULED', 'a1=ABSENT,a2=PRESENT,a3=PRESENT,a4=PRESENT,a5=PRESENT');
  PERFORM pg_temp.d6o_lesson(s, 'd6o-pat', 'A', '2026-02-02', 23, 50, 'SCHEDULED', 'a1=PRESENT,a2=PRESENT,a3=PRESENT,a4=PRESENT,a5=PRESENT');
  PERFORM pg_temp.d6o_login(s, 'd6o-pat');
  PERFORM pg_temp.d6o_expect('392o the weekdays and the passes',
    (SELECT string_agg(dimension || ' ' || key || ' ' || recorded_minutes || '/' || absent_minutes, ' | ' ORDER BY dimension, key)
       FROM app.absence_stats_patterns((SELECT id FROM "StudentGroups" WHERE "schoolId" = s AND name = 'A'), NULL, '2026-02-01', '2026-02-28') WHERE dimension <> 'SUBJECT'),
    'SLOT 08:00 250/50 | SLOT 23:00 250/0 | WEEKDAY 1 250/0 | WEEKDAY 7 250/50');
  PERFORM pg_temp.d6o_expect('392o and a pupil''s',
    (SELECT string_agg(key || ' ' || recorded_minutes || '/' || absent_minutes, ' | ' ORDER BY key)
       FROM app.absence_stats_patterns(NULL, (SELECT id FROM "Users" WHERE "schoolId" = s AND email = 'd6o-d6o-pat-a1@example.invalid'), '2026-02-01', '2026-02-28') WHERE dimension = 'WEEKDAY'),
    '1 50/0 | 7 50/50');
END $$;
ROLLBACK;

-- 392o: the window is the three latest läsår that have begun, in the plan, the trim and the doors. Years of 2022, 2023,
-- 2024 and 2025 have begun on 2026-03-15 and one of 2026 has not; a row from before the window that the trim has not yet
-- removed is read by nobody.
BEGIN;
DO $$
DECLARE
  s uuid := pg_temp.d6o_school('d6o-win', 5, 0);
  ga uuid;
BEGIN
  SELECT id INTO ga FROM "StudentGroups" WHERE "schoolId" = s AND name = 'A';
  -- The pupils sat in the class from the start of 2022, and there are lessons before the window and in it.
  UPDATE "StudentEnrollments" SET "validFrom" = '2022-01-01' WHERE "schoolId" = s;
  PERFORM pg_temp.d6o_lesson(s, 'd6o-win', 'A', t.d, 8, 50, 'SCHEDULED', NULL)
    FROM unnest(ARRAY['2022-07-04', '2022-09-05', '2022-12-05']::date[]) AS t(d);
  PERFORM set_config('session_replication_role', 'origin', true);
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt") VALUES
    (s, 'W22', '2022-08-01', '2023-07-31', false, now()), (s, 'W23', '2023-08-01', '2024-07-31', false, now()),
    (s, 'W24', '2024-08-01', '2025-07-31', false, now()), (s, 'W27', '2096-08-01', '2097-07-31', false, now());
  PERFORM pg_temp.d6o_expect('392o the window of 2026-03-15 begins with the third latest läsår that has begun', app.absence_stats_window_first(s, '2026-03-15')::text, '2023-08-01');
  PERFORM pg_temp.d6o_expect('392o a year earlier the window is a year earlier', app.absence_stats_window_first(s, '2025-03-15')::text, '2022-08-01');
  PERFORM pg_temp.d6o_expect('392o with only one läsår begun it begins with it', app.absence_stats_window_first(s, '2023-03-15')::text, '2022-08-01');
  PERFORM pg_temp.d6o_expect('392o a school with no läsår has no window', (SELECT app.absence_stats_window_first(gen_random_uuid(), '2026-03-15')::text), NULL);
  -- The night of 2023-03-15: the three months of the last 62 days, and of the older ones those with a lesson inside the window
  -- (2022-09 and 2022-12, not 2022-07, which began before the läsår).
  PERFORM pg_temp.d6o_expect('392o the plan reaches back to the window and no further', (SELECT count(*)::text FROM app.absence_stats_plan(s, '2023-03-15', 100)), '5');
  INSERT INTO "AbsenceStatsMonths" ("schoolId", "studentGroupId", "month", "throughDay", pupils, "pupilsRegistered", "lessonsHeld", "lessonsReported") VALUES
    (s, NULL, '2023-01-01', '2023-01-31', 9, 0, 5, 5), (s, NULL, '2024-09-01', '2024-09-30', 9, 0, 5, 5),
    (s, ga, '2023-01-01', '2023-01-31', 9, 0, 5, 5), (s, ga, '2024-09-01', '2024-09-30', 9, 0, 5, 5);
  PERFORM pg_temp.d6o_login(s, 'd6o-win');
  PERFORM pg_temp.d6o_expect('392o a month before the window is not read in the school''s months', (SELECT string_agg(to_char(month, 'YYYY-MM'), ' ') FROM app.absence_stats_series()), '2024-09');
  PERFORM pg_temp.d6o_expect('392o nor in a class''s', (SELECT string_agg(to_char(month, 'YYYY-MM'), ' ') FROM app.absence_stats_series(ga)), '2024-09');
  PERFORM pg_temp.d6o_expect('392o nor in the classes of a period', (SELECT string_agg(class_name || ' ' || lessons_held, ' ') FROM app.absence_stats_classes('2023-01-01', '2026-03-01')), 'A 5');
END $$;
ROLLBACK;

-- 392o: the lessons are Rapporteringsgradens, once each. Class A has six pupils, B five.
--   L1 A Mon 08:00, one teacher, a mark                       held and reported for A
--   L2 A Mon 09:00, two teachers, no mark                     held once, not reported
--   L3 B Mon 10:00, joined with class A, a mark               held and reported for both
--   L4 a teaching group across classes (G), a mark            the school's, no class's
--   L5 a half of A (H), a mark                                A's
--   L6 A Tue 10:00 cancelled                                  nobody's
-- A: held L1 L2 L3 L5 = 4, reported 3. B: L3 = 1/1. The school: L1-L5 = 5, reported L1 L3 L4 L5 = 4.
BEGIN;
DO $$
DECLARE
  s uuid := pg_temp.d6o_school('d6o-rep', 6, 5);
  y uuid; ga uuid; gb uuid; gg uuid; gh uuid; t2 uuid; l uuid;
BEGIN
  SELECT id INTO y FROM "AcademicYears" WHERE "schoolId" = s;
  SELECT id INTO ga FROM "StudentGroups" WHERE "schoolId" = s AND name = 'A';
  SELECT id INTO gb FROM "StudentGroups" WHERE "schoolId" = s AND name = 'B';
  PERFORM set_config('session_replication_role', 'replica', true);
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "updatedAt") VALUES (s, y, 'G', 'TEACHING_GROUP', now()) RETURNING id INTO gg;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "halfOfId", "updatedAt") VALUES (s, y, 'H', 'TEACHING_GROUP', ga, now()) RETURNING id INTO gh;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s, 'd6o-d6o-rep-t2@example.invalid', 'D6', 'Lärare2', 'TEACHER', gen_random_uuid(), true, now()) RETURNING id INTO t2;
  PERFORM pg_temp.d6o_lesson(s, 'd6o-rep', 'A', '2026-02-02', 8, 50, 'SCHEDULED', 'a1=PRESENT');
  l := pg_temp.d6o_lesson(s, 'd6o-rep', 'A', '2026-02-02', 9, 50, 'SCHEDULED', NULL);
  INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role) VALUES (s, l, t2, 'ASSISTANT');
  l := pg_temp.d6o_lesson(s, 'd6o-rep', 'B', '2026-02-02', 10, 50, 'SCHEDULED', 'b1=PRESENT');
  INSERT INTO "CalendarLessonGroups" ("schoolId", "calendarLessonId", "studentGroupId") VALUES (s, l, ga);
  PERFORM pg_temp.d6o_lesson(s, 'd6o-rep', 'G', '2026-02-03', 8, 50, 'SCHEDULED', 'a1=PRESENT');
  PERFORM pg_temp.d6o_lesson(s, 'd6o-rep', 'H', '2026-02-03', 9, 50, 'SCHEDULED', 'a2=PRESENT');
  PERFORM pg_temp.d6o_lesson(s, 'd6o-rep', 'A', '2026-02-03', 10, 50, 'CANCELLED', 'a1=ABSENT');
  PERFORM app.absence_stats_month(s, '2026-02-01', '2026-03-01');
  PERFORM pg_temp.d6o_expect('392o the lessons, once each', 
    (SELECT string_agg(coalesce(g.name, 'school') || ' ' || a."lessonsHeld" || '/' || a."lessonsReported", ' | ' ORDER BY coalesce(g.name, '')) FROM "AbsenceStatsMonths" a LEFT JOIN "StudentGroups" g ON g.id = a."studentGroupId" WHERE a."schoolId" = s AND a.month = '2026-02-01'),
    'school 5/4 | A 4/3 | B 1/1');
  -- And they are the ones Rapporteringsgraden counts: a lesson once, however many teachers stand on it.
  PERFORM pg_temp.d6o_expect('392o the school’s are D2’s distinct lessons',
    (SELECT count(DISTINCT r.lesson_id) || '/' || count(DISTINCT r.lesson_id) FILTER (WHERE r.reported) FROM app.reporting_lessons(s, '2026-02-01', '2026-02-28', clock_timestamp()) r), '5/4');
END $$;
ROLLBACK;

-- 392o: a teacher who has left still has the lessons she held. Class A has five pupils, and a teacher t and a
-- colleague t2:
--   L1 Mon 2026-02-02 08:00  t, a mark                     held and reported
--   L2 Tue 2026-02-03 08:00  t, no mark                    held, not reported
--   L3 Wed 2026-02-04 08:00  t and t2, a mark              held and reported, once
--   L4 Mon 2026-02-16 08:00  t, a mark                     held and reported while t is a teacher of the school
-- Everyone active: 4 held, 3 reported. Reporting lessons is the live question (who is to report now), so a month that
-- is counted again after t has left must not lose what she held: t leaves on 2026-03-15 and February is the same; t
-- leaves on 2026-02-10 and L4, which no one was left to report, goes while L1-L3 stay; t is back and L4 is again.
-- (Rapporteringsgraden's own function drops the teacher in every one of these, which is its question and not this.)
BEGIN;
DO $$
DECLARE
  s uuid := pg_temp.d6o_school('d6o-gone', 5, 0);
  feb constant date := '2026-02-01';
  t uuid;
  t2 uuid;
  l uuid;
  all5 constant text := 'a1=PRESENT,a2=PRESENT,a3=PRESENT,a4=PRESENT,a5=PRESENT';
  whole constant text := 'school 5/5 750/0/50/0/0 4/3 | A 5/5 750/0/50/0/0 4/3';
BEGIN
  SELECT id INTO t FROM "Users" WHERE "schoolId" = s AND email = 'd6o-d6o-gone-t@example.invalid';
  PERFORM pg_temp.d6o_lesson(s, 'd6o-gone', 'A', '2026-02-02', 8, 50, 'SCHEDULED', all5);
  PERFORM pg_temp.d6o_lesson(s, 'd6o-gone', 'A', '2026-02-03', 8, 50, 'SCHEDULED', NULL);
  l := pg_temp.d6o_lesson(s, 'd6o-gone', 'A', '2026-02-04', 8, 50, 'SCHEDULED', 'a1=ABSENT,a2=PRESENT,a3=PRESENT,a4=PRESENT,a5=PRESENT');
  PERFORM set_config('session_replication_role', 'origin', true);
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s, 'd6o-d6o-gone-t2@example.invalid', 'D6', 'Lärare2', 'TEACHER', gen_random_uuid(), true, now()) RETURNING id INTO t2;
  INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role) VALUES (s, l, t2, 'ASSISTANT');
  PERFORM pg_temp.d6o_lesson(s, 'd6o-gone', 'A', '2026-02-16', 8, 50, 'SCHEDULED', all5);

  PERFORM app.absence_stats_month(s, feb, '2026-03-01');
  PERFORM pg_temp.d6o_expect('392o everyone active: four held, three reported', pg_temp.d6o_rows(s, feb), whole);

  -- Leaves after the month (deactivatedAt is the instant the trigger would have written; the triggers are off here).
  PERFORM set_config('session_replication_role', 'replica', true);
  UPDATE "Users" SET "isActive" = false, "deactivatedAt" = '2026-03-15 12:00+01' WHERE id = t;
  PERFORM app.absence_stats_month(s, feb, '2026-03-01');
  PERFORM pg_temp.d6o_expect('392o a teacher who left after the month: February is what it was', pg_temp.d6o_rows(s, feb), whole);
  PERFORM pg_temp.d6o_expect('392o and the reporting function drops her, which is its question',
    (SELECT count(DISTINCT lesson_id)::text FROM app.reporting_lessons(s, '2026-02-01', '2026-02-28', clock_timestamp())), '1');

  -- Leaves in the middle of it: the lesson after she left has no one left to report it.
  UPDATE "Users" SET "deactivatedAt" = '2026-02-10 12:00+01' WHERE id = t;
  PERFORM app.absence_stats_month(s, feb, '2026-03-01');
  PERFORM pg_temp.d6o_expect('392o a teacher who left on the 10th: L1 to L3 stay, L4 goes',
    pg_temp.d6o_rows(s, feb), 'school 5/5 750/0/50/0/0 3/2 | A 5/5 750/0/50/0/0 3/2');
  -- The instant is the lesson's end: a lesson over before she left is hers, one that ends after is not.
  UPDATE "Users" SET "deactivatedAt" = '2026-02-02 08:50+01' WHERE id = t;
  PERFORM app.absence_stats_month(s, feb, '2026-03-01');
  PERFORM pg_temp.d6o_expect('392o left the minute L1 ended: L1 is hers, L2 is not, L3 has t2',
    pg_temp.d6o_rows(s, feb), 'school 5/5 750/0/50/0/0 2/2 | A 5/5 750/0/50/0/0 2/2');
  UPDATE "Users" SET "deactivatedAt" = '2026-02-02 08:49+01' WHERE id = t;
  PERFORM app.absence_stats_month(s, feb, '2026-03-01');
  PERFORM pg_temp.d6o_expect('392o left a minute before L1 ended: only L3, which t2 held',
    pg_temp.d6o_rows(s, feb), 'school 5/5 750/0/50/0/0 1/1 | A 5/5 750/0/50/0/0 1/1');

  -- Back again: the lessons come back.
  UPDATE "Users" SET "isActive" = true, "deactivatedAt" = NULL WHERE id = t;
  PERFORM app.absence_stats_month(s, feb, '2026-03-01');
  PERFORM pg_temp.d6o_expect('392o a teacher who is back: four held, three reported', pg_temp.d6o_rows(s, feb), whole);

  -- Only a teacher counts: a lesson whose only person is an administrator of the school is nobody's to report.
  l := pg_temp.d6o_lesson(s, 'd6o-gone', 'A', '2026-02-05', 8, 50, 'SCHEDULED', all5);
  DELETE FROM "CalendarLessonTeachers" WHERE "calendarLessonId" = l;
  INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role) VALUES (s, l, t2, 'LEAD');
  PERFORM app.absence_stats_month(s, feb, '2026-03-01');
  PERFORM pg_temp.d6o_expect('392o a lesson of t2 alone is held and reported', pg_temp.d6o_rows(s, feb),
    'school 5/5 1000/0/50/0/0 5/4 | A 5/5 1000/0/50/0/0 5/4');
  UPDATE "Users" SET role = 'SCHOOL_ADMIN', "adminProfile" = 'FULL' WHERE id = t2;
  PERFORM app.absence_stats_month(s, feb, '2026-03-01');
  PERFORM pg_temp.d6o_expect('392o t2 an administrator: her lesson is no teacher’s, and L3 still has t',
    pg_temp.d6o_rows(s, feb), 'school 5/5 1000/0/50/0/0 4/3 | A 5/5 1000/0/50/0/0 4/3');
END $$;
ROLLBACK;

-- 392o: the two lesson functions are one definition. app.absence_stats_lessons is app.reporting_lessons with the one line
-- about the teacher, and nothing else: whoever rewrites the one (Elevens lektion för dagen adds a condition about a pupil
-- moved off a lesson) has to carry it into the other, or the history's reporting rate is not Rapporteringsgradens.
-- Compared as the catalogue holds them, with the comments cut and the white space collapsed.
BEGIN;
CREATE FUNCTION pg_temp.d6o_norm(p_src text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT btrim(regexp_replace(regexp_replace(p_src, '--[^' || chr(10) || ']*', '', 'g'), '\s+', ' ', 'g'))
$f$;
DO $$
DECLARE
  d2 text := pg_temp.d6o_norm((SELECT prosrc FROM pg_proc WHERE oid = 'app.reporting_lessons(uuid, date, date, timestamptz)'::regprocedure));
  d6 text := pg_temp.d6o_norm((SELECT prosrc FROM pg_proc WHERE oid = 'app.absence_stats_lessons(uuid, date, date, timestamptz)'::regprocedure));
  live constant text := E'AND u."role" = ''TEACHER'' AND u."isActive"';
  gone constant text := E'AND u."role" = ''TEACHER'' AND (u."deactivatedAt" IS NULL OR cl."endsAt" <= u."deactivatedAt")';
BEGIN
  PERFORM pg_temp.d6o_expect('392o D2 asks who is a teacher now', ((length(d2) - length(replace(d2, live, ''))) / length(live))::text, '1');
  PERFORM pg_temp.d6o_expect('392o the history asks who had not left', ((length(d6) - length(replace(d6, gone, ''))) / length(gone))::text, '1');
  PERFORM pg_temp.d6o_expect('392o and not who is a teacher now', ((length(d6) - length(replace(d6, live, ''))) / length(live))::text, '0');
  PERFORM pg_temp.d6o_expect('392o the two bodies are the same but for that line', (replace(d2, live, gone) = d6)::text, 'true');
  PERFORM pg_temp.d6o_expect('392o neither is a definer or has a path of its own (they are inlined into the caller)',
    (SELECT string_agg(p.proname || ':' || p.prosecdef::text || ':' || coalesce(p.proconfig::text, ''), ',' ORDER BY p.proname COLLATE "C")
       FROM pg_proc p WHERE p.oid IN ('app.reporting_lessons(uuid, date, date, timestamptz)'::regprocedure, 'app.absence_stats_lessons(uuid, date, date, timestamptz)'::regprocedure)),
    'absence_stats_lessons:false:,reporting_lessons:false:');
  PERFORM pg_temp.d6o_expect('392o the history’s is the owner’s alone',
    (SELECT string_agg(r || ':' || has_function_privilege(r, 'app.absence_stats_lessons(uuid, date, date, timestamptz)', 'EXECUTE')::text, ',' ORDER BY r COLLATE "C")
       FROM unnest(ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated']) r WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)),
    'anon:false,app_authenticated:false,authenticated:false,service_role:false');
  -- The control: the check cuts what it says it cuts (a body that differs in a comment and in white space only is the same).
  PERFORM pg_temp.d6o_expect('392o a comment and the white space are not a difference',
    (pg_temp.d6o_norm(E'SELECT 1   -- one\n  FROM t') = pg_temp.d6o_norm(E'SELECT 1 FROM t'))::text, 'true');
  PERFORM pg_temp.d6o_expect('392o a condition is', (pg_temp.d6o_norm(E'SELECT 1 FROM t WHERE a') = pg_temp.d6o_norm(E'SELECT 1 FROM t WHERE b'))::text, 'false');
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- 394o: the mentor is the mentor of Frånvarobevakningen. For each
-- teacher, the pupils whose statistics they can open are the pupils
-- app.absence_watch_mentees names for them (less the marked), and the classes
-- they reach are the classes those pupils sit in: one definition, asked
-- twice. A teacher the watch gives no pupil reaches none.
-- ---------------------------------------------------------------------------

BEGIN;
DO $$
DECLARE
  full_sub constant text := '00000000-0000-4000-8000-d60000000001';
  school uuid;
  today date;
  t record;
  mine uuid[];
  theirs uuid[];
  my_classes uuid[];
  their_classes uuid[];
  c record;
  p record;
  total int := 0;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', full_sub)::text, true);
  school := app.current_school_id();
  today := app.school_today();
  FOR t IN SELECT * FROM (VALUES ('fs-m1@example.invalid', '00000000-0000-4000-8000-d60000000006'),
                                 ('fs-m2@example.invalid', '00000000-0000-4000-8000-d60000000007'),
                                 ('fs-t3@example.invalid', '00000000-0000-4000-8000-d60000000008')) v(email, sub)
  LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', full_sub)::text, true);
    -- What the watch says: the mentor's mentees, today, but not the marked.
    SELECT coalesce(array_agg(mm.student_id ORDER BY mm.student_id), '{}') INTO theirs
      FROM app.absence_watch_mentees(school, today) mm
     WHERE mm.mentor_id = (SELECT id FROM "Users" WHERE "schoolId" = school AND email = t.email)
       AND NOT EXISTS (SELECT 1 FROM "PersonProtections" pp WHERE pp."userId" = mm.student_id AND pp."schoolId" = school);
    SELECT coalesce(array_agg(DISTINCT e."studentGroupId" ORDER BY e."studentGroupId"), '{}') INTO their_classes
      FROM app.absence_watch_mentees(school, today) mm
      JOIN "StudentEnrollments" e ON e."studentId" = mm.student_id AND e."schoolId" = school
       AND e."validFrom" <= today AND (e."validTo" IS NULL OR today < e."validTo")
     WHERE mm.mentor_id = (SELECT id FROM "Users" WHERE "schoolId" = school AND email = t.email);
    -- What the statistics say, asked of every pupil and class of the school.
    mine := '{}';
    my_classes := '{}';
    FOR p IN SELECT id FROM "Users" WHERE "schoolId" = school AND role = 'STUDENT' ORDER BY id LOOP
      total := total + 1;
      IF pg_temp.d6o_as(t.sub, format($q$SELECT * FROM app.absence_stats_pupil_head(%L)$q$, p.id)) = 'ok:1' THEN
        mine := mine || p.id;
      END IF;
    END LOOP;
    FOR c IN SELECT id FROM "StudentGroups" WHERE "schoolId" = school AND name IN ('FS8A', 'FS8B', 'FS8C') ORDER BY id LOOP
      total := total + 1;
      IF pg_temp.d6o_as(t.sub, format($q$SELECT * FROM app.absence_stats_series(%L)$q$, c.id)) LIKE 'ok:%' THEN
        my_classes := my_classes || c.id;
      END IF;
    END LOOP;
    IF mine IS DISTINCT FROM theirs OR my_classes IS DISTINCT FROM their_classes THEN
      RAISE EXCEPTION 'frånvarostatistik 394: % reaches pupils % and classes %, the watch gives pupils % and classes %', t.email, mine, my_classes, theirs, their_classes;
    END IF;
  END LOOP;
  -- And the control: the mentors have pupils (the check is not two empty sets).
  IF (SELECT count(*) FROM app.absence_watch_mentees(school, today)) < 14 THEN
    RAISE EXCEPTION 'frånvarostatistik 394: the watch gives the mentors % pupils, not the fixtures'' 14 (eight and six, p9 among them)', (SELECT count(*) FROM app.absence_watch_mentees(school, today));
  END IF;
  RAISE NOTICE 'frånvarostatistik 394: % calls', total;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 399o: Elevens lektion för dagen (D7, 20270122091000), the owner's
-- side. What no login may call (the readers of the feed and of Schemavisaren,
-- rapporteringsgrad, gallring), what the keys do past row security, what an
-- arrival may be, and that the integrations are told. The doors themselves are
-- written by the sections 395-398 of rls-policies.sql; here the owner takes the
-- claims of the school's full administrator and walks through the same door.
-- Fixtures: rls-d7-school (and rls-d7-annan), with fixed ids.
-- ---------------------------------------------------------------------------

CREATE FUNCTION pg_temp.d7_as(p_auth text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', p_auth)::text, true)
$$;
CREATE FUNCTION pg_temp.d7_auth(n integer) RETURNS text LANGUAGE sql AS $$
  SELECT '00000000-0000-4000-8000-d7000000' || lpad(n::text, 2, '0') || '00'
$$;
CREATE FUNCTION pg_temp.d7f(p_name text) RETURNS uuid LANGUAGE sql AS $$
  SELECT CASE p_name
    WHEN 'school' THEN 'd7000000-0000-4000-8000-0000000000c1'
    WHEN 'other' THEN 'd7000000-0000-4000-8000-0000000000c2'
    ELSE ('d7000000-0000-4000-8000-b000000000' || CASE p_name
      WHEN 'full' THEN '01' WHEN 't1' THEN '06' WHEN 't2' THEN '07' WHEN 'p1' THEN '11' WHEN 'p2' THEN '12' WHEN 'p3' THEN '13'
      WHEN 'po' THEN '32' END)::uuid
  END
$$;
CREATE FUNCTION pg_temp.d7_l(n integer) RETURNS uuid LANGUAGE sql AS $$
  SELECT ('d7000000-0000-4000-8000-000000000a' || lpad(n::text, 2, '0'))::uuid
$$;
CREATE FUNCTION pg_temp.d7_expect(p_label text, p_got text, p_want text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_want THEN
    RAISE EXCEPTION E'elevens lektion %: got\n%\nwanted\n%', p_label, p_got, p_want;
  END IF;
END $$;
CREATE FUNCTION pg_temp.d7_refuses(p_sql text, p_state text, p_what text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  got text := 'none';
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    got := SQLSTATE;
  END;
  IF got IS DISTINCT FROM p_state THEN
    RAISE EXCEPTION 'elevens lektion: % should be refused with %, was %', p_what, p_state, got;
  END IF;
END $$;
-- The moves as one text, "pupil:from>to" by the last two digits of their ids.
CREATE FUNCTION pg_temp.d7_moves() RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(right(m."studentId"::text, 2) || ':' || right(m."fromLessonId"::text, 2) || '>' || right(m."toLessonId"::text, 2),
                             ', ' ORDER BY m."studentId", m."fromLessonId"), '')
    FROM "LessonPupilMoves" m WHERE m."schoolId" = pg_temp.d7f('school')
$$;
CREATE FUNCTION pg_temp.d7_day1() RETURNS date LANGUAGE sql AS $$
  SELECT date FROM "CalendarLessons" WHERE id = pg_temp.d7_l(1)
$$;
-- A feed or a viewer page as the numbers/subjects of its lessons that are not cancelled.
CREATE FUNCTION pg_temp.d7_feed(p_pupil text) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(right(x ->> 'id', 2), ',' ORDER BY x ->> 'id'), '')
    FROM jsonb_array_elements(app.calendar_feed_pupil_lessons(pg_temp.d7f('school'), pg_temp.d7f(p_pupil),
           pg_temp.d7_day1(), pg_temp.d7_day1(), 'Europe/Stockholm', 'SIGNATURE')) x
   WHERE NOT (x ->> 'cancelled')::boolean
$$;
CREATE FUNCTION pg_temp.d7_page(p_pupil text) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(l ->> 'subject', ',' ORDER BY l ->> 'start', l ->> 'subject'), '')
    FROM jsonb_array_elements(app.timetable_pupil_days(pg_temp.d7f('school'), pg_temp.d7f(p_pupil),
           pg_temp.d7_day1(), 'Europe/Stockholm', 'SIGNATURE')) d,
         jsonb_array_elements(d -> 'lessons') l
   WHERE NOT (l ->> 'cancelled')::boolean
$$;
CREATE FUNCTION pg_temp.d7_class(p_class text) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(l ->> 'subject', ',' ORDER BY l ->> 'start', l ->> 'subject'), '')
    FROM jsonb_array_elements(app.timetable_week_days(pg_temp.d7f('school'), 'GROUP',
           (SELECT id FROM "StudentGroups" WHERE name = p_class AND "schoolId" = pg_temp.d7f('school')),
           pg_temp.d7_day1(), 'Europe/Stockholm', 'SIGNATURE', false, 0)) d,
         jsonb_array_elements(d -> 'lessons') l
   WHERE NOT coalesce((l ->> 'cancelled')::boolean, false)
$$;

-- The calendar feed of a pupil and the viewer's page of the pupil, the week of the class and of the
-- target: the feed leaves the source out and has the target; the class lesson the pupil arrived at
-- is still on the class's page and on its other pupils' pages (an arrival does not make it a lesson
-- for named pupils).
BEGIN;
DO $$
BEGIN
  PERFORM pg_temp.d7_expect('before: the feed of a D77A pupil', pg_temp.d7_feed('p1'), '01,04');
  PERFORM pg_temp.d7_expect('before: the page of a D77B pupil', pg_temp.d7_page('p3'), 'D7 Engelska,D7 Svenska');
  PERFORM pg_temp.d7_expect('before: the page of D77B', pg_temp.d7_class('D77B'), 'D7 Engelska,D7 Svenska');
  PERFORM pg_temp.d7_as(pg_temp.d7_auth(1));
  PERFORM app.lesson_pupil_move(pg_temp.d7f('p1'), pg_temp.d7_l(1), pg_temp.d7_l(2));
  PERFORM pg_temp.d7_expect('the moved pupil''s feed', pg_temp.d7_feed('p1'), '02,04');
  PERFORM pg_temp.d7_expect('a classmate''s feed', pg_temp.d7_feed('p2'), '01,04');
  PERFORM pg_temp.d7_expect('the target class''s pupil''s feed', pg_temp.d7_feed('p3'), '02,03');
  PERFORM pg_temp.d7_expect('the moved pupil''s page', pg_temp.d7_page('p1'), 'D7 Engelska,D7 Svenska');
  PERFORM pg_temp.d7_expect('the target class''s pupil still has the lesson on their page', pg_temp.d7_page('p3'), 'D7 Engelska,D7 Svenska');
  PERFORM pg_temp.d7_expect('the target class''s own page still has the lesson', pg_temp.d7_class('D77B'), 'D7 Engelska,D7 Svenska');
  PERFORM pg_temp.d7_expect('the source class''s page is the class''s lessons', pg_temp.d7_class('D77A'), 'D7 Matematik,D7 Svenska');
END $$;
ROLLBACK;

-- Rapporteringsgrad: a lesson whose only pupil was a named one who is moved off has no one on its list.
BEGIN;
DO $$
DECLARE
  school uuid := pg_temp.d7f('school');
  stoed uuid;
  lonely uuid := gen_random_uuid();
  other uuid := gen_random_uuid();
  cnt text;
BEGIN
  -- A group no one is in, a lesson of it two days back naming p1 alone, and a parallel lesson of D77B.
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt")
  SELECT school, y.id, 'D7 stöd', 7, now() FROM "AcademicYears" y WHERE y."schoolId" = school LIMIT 1 RETURNING id INTO stoed;
  INSERT INTO "CalendarLessons" (id, "schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", status, "updatedAt")
  SELECT lonely, school, l."subjectId", stoed, l.date - 2, l."startsAt" - interval '2 days', l."endsAt" - interval '2 days', 'SCHEDULED', now()
    FROM "CalendarLessons" l WHERE l.id = pg_temp.d7_l(1);
  INSERT INTO "CalendarLessons" (id, "schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", status, "updatedAt")
  SELECT other, school, l."subjectId", l."studentGroupId", l.date - 2, l."startsAt" - interval '2 days', l."endsAt" - interval '2 days', 'SCHEDULED', now()
    FROM "CalendarLessons" l WHERE l.id = pg_temp.d7_l(2);
  INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId") VALUES (school, lonely, pg_temp.d7f('t1'));
  INSERT INTO "CalendarLessonStudents" ("schoolId", "calendarLessonId", "studentId") VALUES (school, lonely, pg_temp.d7f('p1'));
  SELECT count(*)::text INTO cnt FROM app.reporting_lessons(school, (current_date - 5), (current_date + 1), now() + interval '2 days') r WHERE r.lesson_id = lonely;
  PERFORM pg_temp.d7_expect('a lesson naming a pupil is a lesson with a list', cnt, '1');
  -- The move, written past the doors (they refuse the past; the table's trigger does not).
  INSERT INTO "LessonPupilMoves" ("schoolId", "studentId", "fromLessonId", "toLessonId") VALUES (school, pg_temp.d7f('p1'), lonely, other);
  SELECT count(*)::text INTO cnt FROM app.reporting_lessons(school, (current_date - 5), (current_date + 1), now() + interval '2 days') r WHERE r.lesson_id = lonely;
  PERFORM pg_temp.d7_expect('moved off, nobody is on its list', cnt, '0');
END $$;
ROLLBACK;

-- Gallring: a move is due with the register of the day it took a pupil out of, for ATTENDANCE only, and goes
-- in the night; another school's does not, and a move newer than the limit stays.
BEGIN;
DO $$
DECLARE
  school uuid := pg_temp.d7f('school');
  day date;
  due text;
  run uuid;
  n integer;
  counts jsonb;
BEGIN
  PERFORM pg_temp.d7_as(pg_temp.d7_auth(1));
  PERFORM app.lesson_pupil_move(pg_temp.d7f('p1'), pg_temp.d7_l(1), pg_temp.d7_l(2));
  PERFORM set_config('request.jwt.claims', '', true);
  day := pg_temp.d7_day1();
  SELECT string_agg(d.tbl, ',') INTO due FROM app.gallring_due(school, 'ATTENDANCE', day, day) d WHERE d.tbl = 'LessonPupilMoves';
  PERFORM pg_temp.d7_expect('not due before the day is past the limit', coalesce(due, 'none'), 'none');
  SELECT string_agg(d.tbl, ',') INTO due FROM app.gallring_due(school, 'ATTENDANCE', day + 1, day + 1) d WHERE d.tbl = 'LessonPupilMoves';
  PERFORM pg_temp.d7_expect('due with the register', coalesce(due, 'none'), 'LessonPupilMoves');
  SELECT string_agg(d.tbl, ',') INTO due FROM app.gallring_due(school, 'ABSENCE_REPORTS', day + 1, day + 1) d WHERE d.tbl = 'LessonPupilMoves';
  PERFORM pg_temp.d7_expect('not another kind''s', coalesce(due, 'none'), 'none');
  SELECT string_agg(d.tbl, ',') INTO due FROM app.gallring_due(pg_temp.d7f('other'), 'ATTENDANCE', day + 1, day + 1) d WHERE d.tbl = 'LessonPupilMoves';
  PERFORM pg_temp.d7_expect('not another school''s', coalesce(due, 'none'), 'none');

  -- The night: the school keeps attendance for 12 months; make the lessons of the move old, and run.
  ALTER TABLE "RetentionDecisions" DISABLE TRIGGER "RetentionDecisions_stamped";
  INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision, months, reference, "decidedById", "decidedAt")
  VALUES (school, 'ATTENDANCE', 'PURGE_AFTER', 12, 'D7 398', pg_temp.d7f('full'), now() - interval '2 days');
  ALTER TABLE "RetentionDecisions" ENABLE TRIGGER "RetentionDecisions_stamped";
  UPDATE "CalendarLessons" SET status = 'SCHEDULED' WHERE id = pg_temp.d7_l(1);
  ALTER TABLE "CalendarLessons" DISABLE TRIGGER "CalendarLessons_pupil_moves_lapse";
  UPDATE "CalendarLessons" SET date = date - 900, "startsAt" = "startsAt" - interval '900 days', "endsAt" = "endsAt" - interval '900 days'
   WHERE id IN (pg_temp.d7_l(1), pg_temp.d7_l(2));
  ALTER TABLE "CalendarLessons" ENABLE TRIGGER "CalendarLessons_pupil_moves_lapse";
  run := app.gallring_begin(school, now());
  LOOP
    n := app.gallring_purge(run, 'ATTENDANCE', 1);
    EXIT WHEN n = 0;
  END LOOP;
  PERFORM app.gallring_finish(run, '{}', now());
  PERFORM pg_temp.d7_expect('the night takes the move', pg_temp.d7_moves(), '');
  SELECT g.counts INTO counts FROM "GallringRuns" g WHERE g.id = run;
  IF (counts ->> 'ATTENDANCE')::integer < 1 THEN
    RAISE EXCEPTION 'elevens lektion 399o: the run counts % under ATTENDANCE, not the move', counts ->> 'ATTENDANCE';
  END IF;
  PERFORM pg_temp.d7_expect('... and the arrival is not the gallring''s to take (it goes with the move by its key)',
    (SELECT count(*)::text FROM "CalendarLessonStudents" WHERE "studentId" = pg_temp.d7f('p1')), '0');
END $$;
ROLLBACK;

-- A pupil removed takes the move and its arrival; a lesson removed takes the move and the other lesson's arrival.
BEGIN;
DO $$
BEGIN
  PERFORM pg_temp.d7_as(pg_temp.d7_auth(1));
  PERFORM app.lesson_pupil_move(pg_temp.d7f('p1'), pg_temp.d7_l(1), pg_temp.d7_l(2));
  PERFORM app.lesson_pupil_move(pg_temp.d7f('p2'), pg_temp.d7_l(1), pg_temp.d7_l(3));
  PERFORM set_config('request.jwt.claims', '', true);
  DELETE FROM "Users" WHERE id = pg_temp.d7f('p1');
  PERFORM pg_temp.d7_expect('a removed pupil takes the move', pg_temp.d7_moves(), '12:01>03');
  PERFORM pg_temp.d7_expect('... and the arrival', (SELECT count(*)::text FROM "CalendarLessonStudents" WHERE "calendarLessonId" = pg_temp.d7_l(2)), '0');
  DELETE FROM "CalendarLessons" WHERE id = pg_temp.d7_l(3);
  PERFORM pg_temp.d7_expect('a removed lesson takes the move', pg_temp.d7_moves(), '');
  PERFORM pg_temp.d7_expect('... and the pupil is where the class is', (SELECT count(*)::text FROM "CalendarLessonStudents" WHERE "studentId" = pg_temp.d7f('p2')), '0');
END $$;
ROLLBACK;

-- An arrival is the move's: its lesson and its pupil are the move's, and one deleted by itself takes the move.
BEGIN;
DO $$
DECLARE
  mv uuid;
BEGIN
  PERFORM pg_temp.d7_as(pg_temp.d7_auth(1));
  PERFORM app.lesson_pupil_move(pg_temp.d7f('p1'), pg_temp.d7_l(1), pg_temp.d7_l(2));
  PERFORM set_config('request.jwt.claims', '', true);
  mv := (SELECT id FROM "LessonPupilMoves" WHERE "schoolId" = pg_temp.d7f('school'));
  PERFORM pg_temp.d7_refuses(format('INSERT INTO "CalendarLessonStudents" ("schoolId", "calendarLessonId", "studentId", "moveId") VALUES (%L, %L, %L, %L)',
    pg_temp.d7f('school'), pg_temp.d7_l(3), pg_temp.d7f('p2'), mv), 'LM409', 'an arrival of another lesson and pupil than the move''s');
  PERFORM pg_temp.d7_refuses(format('INSERT INTO "CalendarLessonStudents" ("schoolId", "calendarLessonId", "studentId", "moveId") VALUES (%L, %L, %L, %L)',
    pg_temp.d7f('school'), pg_temp.d7_l(3), pg_temp.d7f('p2'), gen_random_uuid()), 'LM409', 'an arrival of a move that is not there');
  PERFORM pg_temp.d7_refuses(format('UPDATE "CalendarLessonStudents" SET "calendarLessonId" = %L WHERE "moveId" = %L', pg_temp.d7_l(3), mv), 'LM409', 'an arrival moved to another lesson');
  -- A named pupil without a move is as before.
  INSERT INTO "CalendarLessonStudents" ("schoolId", "calendarLessonId", "studentId") VALUES (pg_temp.d7f('school'), pg_temp.d7_l(3), pg_temp.d7f('p2'));
  DELETE FROM "CalendarLessonStudents" WHERE "moveId" = mv;
  PERFORM pg_temp.d7_expect('an arrival taken away by itself takes the move', pg_temp.d7_moves(), '');
END $$;
ROLLBACK;

-- A move across two schools is refused by the keys, whoever writes it; so is a lesson moved onto itself, and two
-- lessons that do not overlap, written past the doors.
BEGIN;
DO $$
BEGIN
  PERFORM pg_temp.d7_refuses(format('INSERT INTO "LessonPupilMoves" ("schoolId", "studentId", "fromLessonId", "toLessonId") VALUES (%L, %L, %L, %L)',
    pg_temp.d7f('school'), pg_temp.d7f('p1'), pg_temp.d7_l(1), pg_temp.d7_l(7)), 'LM404', 'a target of another school');
  PERFORM pg_temp.d7_refuses(format('INSERT INTO "LessonPupilMoves" ("schoolId", "studentId", "fromLessonId", "toLessonId") VALUES (%L, %L, %L, %L)',
    pg_temp.d7f('school'), pg_temp.d7f('po'), pg_temp.d7_l(1), pg_temp.d7_l(2)), 'LM404', 'a pupil of another school');
  -- The trigger is the first line; the keys are the second, and hold with the trigger away.
  ALTER TABLE "LessonPupilMoves" DISABLE TRIGGER "LessonPupilMoves_are_parallel";
  PERFORM pg_temp.d7_refuses(format('INSERT INTO "LessonPupilMoves" ("schoolId", "studentId", "fromLessonId", "toLessonId") VALUES (%L, %L, %L, %L)',
    pg_temp.d7f('school'), pg_temp.d7f('p1'), pg_temp.d7_l(1), pg_temp.d7_l(7)), '23503', 'a target of another school, past the trigger');
  PERFORM pg_temp.d7_refuses(format('INSERT INTO "LessonPupilMoves" ("schoolId", "studentId", "fromLessonId", "toLessonId") VALUES (%L, %L, %L, %L)',
    pg_temp.d7f('school'), pg_temp.d7f('po'), pg_temp.d7_l(1), pg_temp.d7_l(2)), '23503', 'a pupil of another school, past the trigger');
  ALTER TABLE "LessonPupilMoves" ENABLE TRIGGER "LessonPupilMoves_are_parallel";
  PERFORM pg_temp.d7_refuses(format('INSERT INTO "LessonPupilMoves" ("schoolId", "studentId", "fromLessonId", "toLessonId") VALUES (%L, %L, %L, %L)',
    pg_temp.d7f('school'), pg_temp.d7f('p1'), pg_temp.d7_l(1), pg_temp.d7_l(1)), '23514', 'a lesson moved onto itself');
  PERFORM pg_temp.d7_refuses(format('INSERT INTO "LessonPupilMoves" ("schoolId", "studentId", "fromLessonId", "toLessonId") VALUES (%L, %L, %L, %L)',
    pg_temp.d7f('school'), pg_temp.d7f('p1'), pg_temp.d7_l(1), pg_temp.d7_l(4)), 'LM412', 'two lessons that do not overlap, written past the door');
END $$;
ROLLBACK;

-- The integrations are told of both lessons by a move (one call, so that a move one way and a move the other
-- take the version rows in one order): each lesson's CalendarEvent version is written in this transaction.
BEGIN;
DO $$
DECLARE
  mv uuid;
  school uuid := pg_temp.d7f('school');
BEGIN
  IF NOT app.ss12000_year_is_emitted((SELECT "academicYearId" FROM "StudentGroups" WHERE name = 'D77A' AND "schoolId" = school)) THEN
    RAISE EXCEPTION 'elevens lektion 399o: the fixture year is not emitted, so the versions cannot be checked';
  END IF;
  PERFORM pg_temp.d7_expect('before: no version written in this transaction',
    (SELECT count(*)::text FROM "Ss12000EntityVersions" WHERE resource = 'CalendarEvent' AND "entityId" IN (pg_temp.d7_l(1), pg_temp.d7_l(2)) AND xid = pg_current_xact_id()), '0');
  PERFORM pg_temp.d7_as(pg_temp.d7_auth(1));
  mv := app.lesson_pupil_move(pg_temp.d7f('p1'), pg_temp.d7_l(1), pg_temp.d7_l(2));
  PERFORM pg_temp.d7_expect('a move tells the integrations of both lessons',
    (SELECT count(*)::text FROM "Ss12000EntityVersions" WHERE resource = 'CalendarEvent' AND "entityId" IN (pg_temp.d7_l(1), pg_temp.d7_l(2)) AND xid = pg_current_xact_id()), '2');
  PERFORM pg_temp.d7_expect('... and not a third', (SELECT count(*)::text FROM "Ss12000EntityVersions" WHERE resource = 'CalendarEvent' AND "entityId" = pg_temp.d7_l(3) AND xid = pg_current_xact_id()), '0');
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 429o: Klasslärarens schema (G5, 20270128090000), the owner's side.
-- Two rules the database keeps in two places, and the function that asks the
-- second place only if the first is gone: the rows the tables forbid are written
-- here with their guard taken away (inside a transaction that is rolled back),
-- so that the function's own test is the only thing between the row and the
-- answer. Without this a loosened function passes every section, because no row
-- the tables allow can tell it from the original. Fixtures: rls-klasslarare-school.
--
--   * a room loan that has ended is not a loan: app.class_teacher_room_is_lent_in
--     asks for endedAt IS NULL as well as for the status, and the table's CHECK
--     (an ended loan says when, and only a WITHDRAWN or REVOKED one has ended)
--     keeps a PENDING or APPROVED loan from having ended;
--   * a klasslärare belongs to a home class, not to the half of one: the guard
--     of the appointments asks for halfOfId IS NULL as well as for the kind, and
--     the trigger of the groups (HC409) keeps a class from being the half of one.
-- ---------------------------------------------------------------------------

BEGIN;
DO $$
DECLARE
  school uuid;
  room uuid;
  class uuid;
  teacher uuid;
  half uuid;
  year uuid;
  got text := 'none';
BEGIN
  SELECT id INTO school FROM "Schools" WHERE slug = 'rls-klasslarare-school';
  SELECT id INTO room FROM "Rooms" WHERE "schoolId" = school AND name = 'KL Sal U (utgången)';
  SELECT id, "academicYearId" INTO class, year FROM "StudentGroups" WHERE "schoolId" = school AND name = 'KL4A';
  SELECT id INTO teacher FROM "Users" WHERE "schoolId" = school AND email = 'kl-t3@example.invalid';
  IF school IS NULL OR room IS NULL OR class IS NULL OR teacher IS NULL THEN
    RAISE EXCEPTION 'klasslärare 429o: the fixtures did not run (school %, room %, class %, teacher %)', school, room, class, teacher;
  END IF;

  -- A room loan that has ended. The fixture's loan was approved and its last day has gone by: not lent, by its dates.
  IF app.class_teacher_room_is_lent_in(school, room) THEN
    RAISE EXCEPTION 'klasslärare 429o: the room whose loan has run out is lent';
  END IF;
  -- Take the CHECK away and let the loan run on for ten days with the moment it was ended written on it: by its status and its
  -- dates alone the room would be lent; it is not, because the loan has ended.
  ALTER TABLE "RoomLoans" DROP CONSTRAINT "RoomLoans_an_ended_loan_says_when";
  UPDATE "RoomLoans" SET "endDate" = current_date + 10, "endedAt" = now() WHERE "roomId" = room AND "ownerSchoolId" = school;
  IF NOT FOUND THEN RAISE EXCEPTION 'klasslärare 429o: the fixture has no loan of the room'; END IF;
  IF app.class_teacher_room_is_lent_in(school, room) THEN
    RAISE EXCEPTION 'klasslärare 429o: a loan that has ended (endedAt written) lends the room';
  END IF;
  -- The control: without the moment it ended, the same row lends it. The stand-in bites, and the function reads the column.
  UPDATE "RoomLoans" SET "endedAt" = NULL WHERE "roomId" = room AND "ownerSchoolId" = school;
  IF NOT app.class_teacher_room_is_lent_in(school, room) THEN
    RAISE EXCEPTION 'klasslärare 429o: the approved loan with no end does not lend the room';
  END IF;

  -- A half of a class that is itself a class (kind CLASS with a halfOfId): the trigger of the groups refuses it, so it is
  -- written past the trigger.
  BEGIN
    INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", kind, "halfOfId", "updatedAt")
    VALUES (school, year, 'KL4A-klass', 4, 'CLASS', class, now());
  EXCEPTION WHEN OTHERS THEN
    got := SQLSTATE;
  END;
  IF got IS DISTINCT FROM 'HC409' THEN
    RAISE EXCEPTION 'klasslärare 429o: a class that is the half of one was %, not refused with HC409', got;
  END IF;
  ALTER TABLE "StudentGroups" DISABLE TRIGGER "StudentGroups_half_is_of_a_class";
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", kind, "halfOfId", "updatedAt")
  VALUES (school, year, 'KL4A-klass', 4, 'CLASS', class, now()) RETURNING id INTO half;
  -- A teacher of the school, a group of the right kind, and still no appointment: it is the half of a class.
  got := 'none';
  BEGIN
    INSERT INTO "ClassTeacherAppointments" ("schoolId", "academicYearId", "studentGroupId", "userId") VALUES (school, year, half, teacher);
  EXCEPTION WHEN OTHERS THEN
    got := SQLSTATE;
  END;
  IF got IS DISTINCT FROM 'CT400' THEN
    RAISE EXCEPTION 'klasslärare 429o: appointing a klasslärare of the half of a class was %, not refused with CT400', got;
  END IF;
  -- The control: the same teacher, appointed to the class itself.
  INSERT INTO "ClassTeacherAppointments" ("schoolId", "academicYearId", "studentGroupId", "userId") VALUES (school, year, class, teacher);
END $$;
ROLLBACK;


-- ---------------------------------------------------------------------------
-- Checklistor (F5, 20270129091000), section 434: the owner's side. What needs the owner: removing a person, a class, a
-- subject and a request; the keys across schools; the keys' indexes; and a gallring run.
-- ---------------------------------------------------------------------------

CREATE FUNCTION pg_temp.clo_expect(p_label text, p_got text, p_want text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_want THEN
    RAISE EXCEPTION E'checklistor %: got\n%\nwanted\n%', p_label, p_got, p_want;
  END IF;
END $$;
-- A statement the tables must refuse, by a fragment of the constraint's name (or the SQLSTATE).
CREATE FUNCTION pg_temp.clo_refuses(p_sql text, p_fragment text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RAISE EXCEPTION 'checklistor: accepted: %', p_sql;
EXCEPTION WHEN check_violation OR unique_violation OR foreign_key_violation OR not_null_violation OR SQLSTATE 'CL422' OR SQLSTATE 'CL409' THEN
  IF position(p_fragment IN SQLERRM) = 0 AND p_fragment <> SQLSTATE THEN
    RAISE EXCEPTION 'checklistor: % was refused, but not by %: %', p_sql, p_fragment, SQLERRM;
  END IF;
END $$;
CREATE FUNCTION pg_temp.clo_user(p_email text) RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM "Users" WHERE email = 'cl-' || p_email || '@example.invalid'
$$;
-- A request of the rule ALL, as the owner writes it, with a receipt for each pair 'p1:g1,p1:g2'.
CREATE FUNCTION pg_temp.clo_request(p_school uuid, p_author uuid, p_title text, p_pairs text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  req uuid := gen_random_uuid();
  pair text;
BEGIN
  INSERT INTO "AckRequests" (id, "schoolId", "authorId", title, body, rule) VALUES (req, p_school, p_author, p_title, 'Text för ' || p_title, 'ALL');
  FOREACH pair IN ARRAY string_to_array(p_pairs, ',') LOOP
    INSERT INTO "AckReceipts" ("requestId", "schoolId", "studentId", "guardianId")
    VALUES (req, p_school, pg_temp.clo_user(split_part(pair, ':', 1)), pg_temp.clo_user(split_part(pair, ':', 2)));
  END LOOP;
  RETURN req;
END $$;

-- 434a: the keys across schools, what removing a person, a class, a subject and a request takes, and the keys' indexes.
BEGIN;
DO $$
DECLARE
  school uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-checklistor-school');
  other uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-checklistor-annan');
  full_ uuid := pg_temp.clo_user('full');
  c7a uuid := (SELECT id FROM "StudentGroups" WHERE name = 'CL7A');
  cx uuid;
  subj uuid := (SELECT id FROM "Subjects" WHERE code = 'CLS');
  tpl uuid := gen_random_uuid();
  tpl_o uuid := gen_random_uuid();
  lst uuid := gen_random_uuid();
  lst_x uuid := gen_random_uuid();
  lst_o uuid := gen_random_uuid();
  req uuid;
  fk record;
BEGIN
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt")
  VALUES (school, (SELECT "academicYearId" FROM "StudentGroups" WHERE id = c7a), 'CLX', 7, now()) RETURNING id INTO cx;
  INSERT INTO "InstructionTemplates" (id, "schoolId", "subjectId", title) VALUES (tpl, school, subj, 'Cirkelsågen');
  INSERT INTO "InstructionTemplates" (id, "schoolId", title) VALUES (tpl_o, other, 'Annans mall');
  INSERT INTO "ConsentLists" (id, "schoolId", "studentGroupId", title, body, "createdById") VALUES (lst, school, c7a, 'Fotografering', 'Text', pg_temp.clo_user('t1'));
  INSERT INTO "ConsentLists" (id, "schoolId", "studentGroupId", title, body, "createdById") VALUES (lst_x, school, cx, 'Fotografering', 'Text', pg_temp.clo_user('t3'));
  INSERT INTO "ConsentLists" (id, "schoolId", "studentGroupId", title, body) VALUES (lst_o, other, (SELECT id FROM "StudentGroups" WHERE name = 'CL9A'), 'Annan lista', 'Text');

  -- A key across schools is refused by the composite key, whatever the stamp lets by.
  PERFORM pg_temp.clo_refuses(format($q$INSERT INTO "InstructionProofs" ("schoolId", "templateId", "studentId", "instructedOn") VALUES (%L, %L, %L, current_date)$q$,
                                     other, tpl, pg_temp.clo_user('annan-p')), 'InstructionProofs_templateId_schoolId_fkey');
  PERFORM pg_temp.clo_refuses(format($q$INSERT INTO "ConsentEntries" ("schoolId", "listId", "studentId", kind, "givenOn") VALUES (%L, %L, %L, 'GRANTED', current_date)$q$,
                                     other, lst, pg_temp.clo_user('annan-p')), 'ConsentEntries_listId_schoolId_fkey');
  PERFORM pg_temp.clo_refuses(format($q$INSERT INTO "InstructionProofs" ("schoolId", "templateId", "studentId", "instructedOn") VALUES (%L, %L, %L, current_date)$q$,
                                     school, tpl, pg_temp.clo_user('annan-p')), 'CL422');
  -- A class of another school is no class of a list's school, and neither is a subject.
  PERFORM pg_temp.clo_refuses(format($q$INSERT INTO "ConsentLists" ("schoolId", "studentGroupId", title, body) VALUES (%L, %L, 'Fel klass', 'Text')$q$,
                                     school, (SELECT id FROM "StudentGroups" WHERE name = 'CL9A')), 'CL422');
  PERFORM pg_temp.clo_refuses(format($q$INSERT INTO "InstructionTemplates" ("schoolId", "subjectId", title) VALUES (%L, %L, 'Fel ämne')$q$,
                                     school, (SELECT id FROM "Subjects" WHERE code = 'ASL')), 'InstructionTemplates_subjectId_schoolId_fkey');
  -- An instructor of another school is no instructor.
  PERFORM pg_temp.clo_refuses(format($q$INSERT INTO "InstructionProofs" ("schoolId", "templateId", "studentId", "instructedOn", "instructorId") VALUES (%L, %L, %L, current_date, %L)$q$,
                                     school, tpl, pg_temp.clo_user('p1'), pg_temp.clo_user('annan-t')), 'CL422');

  -- What a person who is removed takes, and what stays. A teacher who gave instruction and wrote ticks and answers:
  -- the rows stay without them. A pupil: all that is about the pupil goes.
  INSERT INTO "InstructionProofs" ("schoolId", "templateId", "studentId", "instructedOn", "instructorId", "recordedById")
  VALUES (school, tpl, pg_temp.clo_user('p1'), current_date - 5, pg_temp.clo_user('t1'), pg_temp.clo_user('t1'));
  INSERT INTO "InstructionProofs" ("schoolId", "templateId", "studentId", "instructedOn", "instructorId", "recordedById")
  VALUES (school, tpl, pg_temp.clo_user('p5'), current_date - 5, pg_temp.clo_user('t1'), pg_temp.clo_user('t1'));
  INSERT INTO "ConsentEntries" ("schoolId", "listId", "studentId", kind, "givenOn", "recordedById") VALUES
    (school, lst, pg_temp.clo_user('p1'), 'GRANTED', current_date - 1, pg_temp.clo_user('t1')),
    (school, lst_x, pg_temp.clo_user('p5'), 'GRANTED', current_date - 1, pg_temp.clo_user('t1'));
  UPDATE "InstructionProofs" SET "voidedAt" = now(), "voidedById" = pg_temp.clo_user('t1'), "voidReason" = 'Test' WHERE "studentId" = pg_temp.clo_user('p5');
  DELETE FROM "Users" WHERE id = pg_temp.clo_user('t1');
  PERFORM pg_temp.clo_expect('434a a removed teacher', (SELECT concat_ws('|', count(*), count("instructorId"), count("recordedById"), count("voidedById"), count("voidedAt")) FROM "InstructionProofs" WHERE "templateId" = tpl), '2|0|0|0|1');
  PERFORM pg_temp.clo_expect('434a a removed teacher''s answers', (SELECT count(*)::text FROM "ConsentEntries" WHERE "schoolId" = school) || '|' || (SELECT count("recordedById")::text FROM "ConsentEntries" WHERE "schoolId" = school), '2|0');
  PERFORM pg_temp.clo_expect('434a a removed teacher''s list', (SELECT count(*)::text FROM "ConsentLists" WHERE "schoolId" = school AND "createdById" IS NULL), '1');
  DELETE FROM "Users" WHERE id = pg_temp.clo_user('p5');
  PERFORM pg_temp.clo_expect('434a a removed pupil', (SELECT count(*)::text FROM "InstructionProofs" WHERE "templateId" = tpl) || '|' || (SELECT count(*)::text FROM "ConsentEntries" WHERE "schoolId" = school), '1|1');
  -- A removed class leaves its list, with the name it had.
  DELETE FROM "StudentGroups" WHERE id = cx;
  PERFORM pg_temp.clo_expect('434a a removed class', (SELECT concat_ws('|', "studentGroupId" IS NULL, "schoolId" = school, "groupName") FROM "ConsentLists" WHERE id = lst_x), 't|t|CLX');
  -- A removed subject leaves its template, without a subject.
  DELETE FROM "Subjects" WHERE id = subj;
  PERFORM pg_temp.clo_expect('434a a removed subject', (SELECT concat_ws('|', "subjectId" IS NULL, "schoolId" = school, active) FROM "InstructionTemplates" WHERE id = tpl), 't|t|t');
  -- A template with proofs is not removed; one without is (the owner's, since no role has DELETE).
  PERFORM pg_temp.clo_refuses(format($q$DELETE FROM "InstructionTemplates" WHERE id = %L$q$, tpl), 'InstructionProofs_templateId_schoolId_fkey');
  DELETE FROM "InstructionTemplates" WHERE id = tpl_o;
  -- A removed request takes its link and leaves the answers it wrote.
  req := pg_temp.clo_request(school, full_, 'Samtycke: Fotografering', 'p2:g1');
  INSERT INTO "ConsentAsks" ("ackRequestId", "schoolId", "listId") VALUES (req, school, lst);
  UPDATE "AckReceipts" SET "ackedAt" = now() WHERE "requestId" = req;
  PERFORM pg_temp.clo_expect('434a the bridge, as the owner updates', (SELECT count(*)::text FROM "ConsentEntries" WHERE "ackRequestId" = req), '1');
  DELETE FROM "AckRequests" WHERE id = req;
  PERFORM pg_temp.clo_expect('434a a removed request', (SELECT count(*)::text FROM "ConsentAsks" WHERE "ackRequestId" = req) || '|' || (SELECT count(*)::text FROM "ConsentEntries" WHERE "listId" = lst), '0|2');

  -- Every foreign key of the five tables has an index that starts with its columns (the FK index audit).
  FOR fk IN
    SELECT c.conname, c.conrelid::regclass::text AS tbl
      FROM pg_constraint c
     WHERE c.contype = 'f' AND c.conrelid::regclass::text IN ('"InstructionTemplates"', '"InstructionProofs"', '"ConsentLists"', '"ConsentEntries"', '"ConsentAsks"')
       AND NOT EXISTS (
             SELECT 1 FROM pg_index i
              WHERE i.indrelid = c.conrelid AND i.indisvalid
                AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] = c.conkey)
  LOOP
    RAISE EXCEPTION 'checklistor 434a: % on % has no index that starts with its columns', fk.conname, fk.tbl;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
              WHERE c.relname IN ('InstructionTemplates', 'InstructionProofs', 'ConsentLists', 'ConsentEntries', 'ConsentAsks') AND NOT i.indisvalid) THEN
    RAISE EXCEPTION 'checklistor 434a: an index is invalid';
  END IF;
END $$;
ROLLBACK;

-- 434b: gallring. The proofs and answers of a pupil who has left go when the school's period for CHECKLISTS has passed since;
-- a pupil who is still at the school has none due, however long the period; a list goes when it is old and empty. Nothing is
-- due under another kind, nothing under no decision, and the other school's rows stay.
BEGIN;
DO $$
DECLARE
  school uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-checklistor-school');
  other uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-checklistor-annan');
  full_ uuid := pg_temp.clo_user('full');
  c7a uuid := (SELECT id FROM "StudentGroups" WHERE name = 'CL7A');
  tpl uuid := gen_random_uuid();
  tpl_o uuid := gen_random_uuid();
  lst uuid := gen_random_uuid();
  lst_old_empty uuid := gen_random_uuid();
  lst_new_empty uuid := gen_random_uuid();
  lst_o uuid := gen_random_uuid();
  today date := (now() AT TIME ZONE 'Europe/Stockholm')::date;
  p1 uuid := pg_temp.clo_user('p1');
  p2 uuid := pg_temp.clo_user('p2');
  p3 uuid := pg_temp.clo_user('p3');
  run uuid;
  n integer;
  total integer := 0;
  counts jsonb;
  pr_p1 uuid;
  pe_p1 uuid;
BEGIN
  INSERT INTO "InstructionTemplates" (id, "schoolId", title) VALUES (tpl, school, 'Gallring');
  INSERT INTO "InstructionTemplates" (id, "schoolId", title) VALUES (tpl_o, other, 'Annans');
  -- p1 left 400 days ago, p2 left 100 days ago, p3 is at the school. Each has a proof and an answer.
  INSERT INTO "InstructionProofs" ("schoolId", "templateId", "studentId", "instructedOn") VALUES
    (school, tpl, p1, current_date - 500), (school, tpl, p2, current_date - 500), (school, tpl, p3, current_date - 500),
    (other, tpl_o, pg_temp.clo_user('annan-p'), current_date - 500);
  INSERT INTO "ConsentLists" (id, "schoolId", "studentGroupId", title, body, "createdAt") VALUES (lst, school, c7a, 'Foto', 'Text', now() - interval '900 days');
  INSERT INTO "ConsentLists" (id, "schoolId", "studentGroupId", title, body, "createdAt") VALUES (lst_old_empty, school, c7a, 'Gammal tom', 'Text', now() - interval '900 days');
  INSERT INTO "ConsentLists" (id, "schoolId", "studentGroupId", title, body) VALUES (lst_new_empty, school, c7a, 'Ny tom', 'Text');
  INSERT INTO "ConsentLists" (id, "schoolId", "studentGroupId", title, body, "createdAt")
  VALUES (lst_o, other, (SELECT id FROM "StudentGroups" WHERE name = 'CL9A'), 'Annans gamla', 'Text', now() - interval '900 days');
  INSERT INTO "ConsentEntries" ("schoolId", "listId", "studentId", kind, "givenOn") VALUES
    (school, lst, p1, 'GRANTED', current_date - 500), (school, lst, p2, 'GRANTED', current_date - 500), (school, lst, p3, 'GRANTED', current_date - 500);
  ALTER TABLE "Users" DISABLE TRIGGER "Users_deactivation_is_dated_on_update";
  UPDATE "Users" SET "isActive" = false, "deactivatedAt" = now() - interval '400 days' WHERE id = p1;
  UPDATE "Users" SET "isActive" = false, "deactivatedAt" = now() - interval '100 days' WHERE id = p2;
  UPDATE "Users" SET "isActive" = false, "deactivatedAt" = now() - interval '400 days' WHERE id = pg_temp.clo_user('annan-p');
  ALTER TABLE "Users" ENABLE TRIGGER "Users_deactivation_is_dated_on_update";
  SELECT id INTO pr_p1 FROM "InstructionProofs" WHERE "studentId" = p1;
  SELECT id INTO pe_p1 FROM "ConsentEntries" WHERE "studentId" = p1;

  -- What is due, as the one predicate answers it, a year after: p1's proof and answer, and the old empty list, nothing of p2 (who
  -- left too recently), p3 (still at the school) or the other school. The answer is named as the proof is, so that it is p1's
  -- answer that is due and not p2's (a comparison turned the wrong way in the answers' branch left the old text as it was; review
  -- of #288, round 2, MEDEL-4).
  PERFORM pg_temp.clo_expect('434b due',
    (SELECT string_agg(d.tbl || ':' || (CASE WHEN d.id IN (pr_p1, pe_p1) THEN 'p1' ELSE '' END), ' ' ORDER BY d.tbl) FROM app.gallring_due(school, 'CHECKLISTS', today - 365, today) d),
    'ConsentEntries:p1 ConsentLists: InstructionProofs:p1');
  PERFORM pg_temp.clo_expect('434b due, the old empty list only',
    (SELECT string_agg(d.id::text, ' ') FROM app.gallring_due(school, 'CHECKLISTS', today - 365, today) d WHERE d.tbl = 'ConsentLists'), lst_old_empty::text);
  -- A pupil who is at the school has none due, however far on the cutoff is; neither has the list with their answer.
  PERFORM pg_temp.clo_expect('434b a pupil at the school is never due',
    (SELECT count(*)::text FROM app.gallring_due(school, 'CHECKLISTS', today + 10000, today) d
      WHERE d.id IN (SELECT id FROM "InstructionProofs" WHERE "studentId" = p3) OR d.id IN (SELECT id FROM "ConsentEntries" WHERE "studentId" = p3)), '0');
  PERFORM pg_temp.clo_expect('434b a list with an answer of a pupil at the school stays',
    (SELECT count(*)::text FROM app.gallring_due(school, 'CHECKLISTS', today + 10000, today) d WHERE d.id = lst), '0');
  -- Nothing under another kind, and nothing of the other school under this school's.
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['ATTENDANCE', 'ABSENCE_REPORTS', 'LEAVE_REQUESTS', 'NOTIFICATIONS', 'CHANGE_LOGS', 'ABSENCE_REASONS', 'ACCESS_LOG', 'COVER_REQUESTS',
                                         'CRISIS_DRILLS', 'CRISIS_ALARMS', 'DEPARTED_PEOPLE']::"RetentionDataType"[]) t
              WHERE EXISTS (SELECT 1 FROM app.gallring_due(school, t, today - 365, today) d WHERE d.tbl IN ('InstructionProofs', 'ConsentEntries', 'ConsentLists'))) THEN
    RAISE EXCEPTION 'checklistor 434b: a checklist row is due under another kind than CHECKLISTS';
  END IF;
  IF EXISTS (SELECT 1 FROM app.gallring_due(school, 'CHECKLISTS', today - 365, today) d WHERE d.id IN (SELECT id FROM "InstructionProofs" WHERE "schoolId" = other UNION SELECT lst_o)) THEN
    RAISE EXCEPTION 'checklistor 434b: the other school''s rows are due under this school''s run';
  END IF;

  -- No decision: nothing goes. A decision of twelve months: the run takes p1's proof and answer and the old empty list, in batches of one.
  run := app.gallring_begin(school, now());
  IF app.gallring_purge(run, 'CHECKLISTS', 100) <> 0 THEN RAISE EXCEPTION 'checklistor 434b: a school with no decision lost a row'; END IF;
  PERFORM app.gallring_finish(run, '{}', now());
  ALTER TABLE "RetentionDecisions" DISABLE TRIGGER "RetentionDecisions_stamped";
  INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision, months, reference, "decidedById", "decidedAt")
  VALUES (school, 'CHECKLISTS', 'PURGE_AFTER', 12, 'CL 434', full_, now() - interval '2 days');
  ALTER TABLE "RetentionDecisions" ENABLE TRIGGER "RetentionDecisions_stamped";
  run := app.gallring_begin(school, now());
  IF app.gallring_purge(run, 'CHECKLISTS', 1) <> 1 THEN RAISE EXCEPTION 'checklistor 434b: a batch of one took more or less than one row'; END IF;
  IF (SELECT (complete ->> 'CHECKLISTS')::boolean FROM "GallringRuns" WHERE id = run) THEN RAISE EXCEPTION 'checklistor 434b: a full batch said nothing was left'; END IF;
  LOOP
    n := app.gallring_purge(run, 'CHECKLISTS', 1);
    EXIT WHEN n = 0;
    total := total + n;
  END LOOP;
  PERFORM app.gallring_finish(run, '{}', now());
  IF total <> 2 THEN RAISE EXCEPTION 'checklistor 434b: the batches after the first took % more rows, not two', total; END IF;
  PERFORM pg_temp.clo_expect('434b what is left',
    (SELECT concat_ws('|', (SELECT count(*) FROM "InstructionProofs" WHERE "schoolId" = school), (SELECT count(*) FROM "ConsentEntries" WHERE "schoolId" = school),
                      (SELECT string_agg(title, ',' ORDER BY title) FROM "ConsentLists" WHERE "schoolId" = school))),
    '2|2|Foto,Ny tom');
  -- ... and whose: p1's proof and answer went, p2's and p3's stay (p2 left too recently, p3 is at the school).
  PERFORM pg_temp.clo_expect('434b whose proofs and answers are left',
    'proofs ' || coalesce((SELECT string_agg(x.l, ',' ORDER BY x.l)
                             FROM (SELECT CASE "studentId" WHEN p1 THEN 'p1' WHEN p2 THEN 'p2' WHEN p3 THEN 'p3' END AS l FROM "InstructionProofs" WHERE "schoolId" = school) x), '')
      || ' answers ' || coalesce((SELECT string_agg(x.l, ',' ORDER BY x.l)
                                    FROM (SELECT CASE "studentId" WHEN p1 THEN 'p1' WHEN p2 THEN 'p2' WHEN p3 THEN 'p3' END AS l FROM "ConsentEntries" WHERE "schoolId" = school) x), ''),
    'proofs p2,p3 answers p2,p3');
  SELECT g.counts INTO counts FROM "GallringRuns" g WHERE g.id = run;
  IF (counts ->> 'CHECKLISTS')::integer <> 3 THEN RAISE EXCEPTION 'checklistor 434b: the run counts % under CHECKLISTS, not three (the proof, the answer and the old list)', counts ->> 'CHECKLISTS'; END IF;
  PERFORM pg_temp.clo_expect('434b the other school is left alone',
    (SELECT count(*)::text FROM "InstructionProofs" WHERE "schoolId" = other) || '|' || (SELECT count(*)::text FROM "ConsentLists" WHERE "schoolId" = other), '1|1');
  -- KEEP stops it at once.
  ALTER TABLE "Users" DISABLE TRIGGER "Users_deactivation_is_dated_on_update";
  UPDATE "Users" SET "isActive" = false, "deactivatedAt" = now() - interval '400 days' WHERE id = p3;
  ALTER TABLE "Users" ENABLE TRIGGER "Users_deactivation_is_dated_on_update";
  ALTER TABLE "RetentionDecisions" DISABLE TRIGGER "RetentionDecisions_stamped";
  INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision, reference, "decidedById", "decidedAt")
  VALUES (school, 'CHECKLISTS', 'KEEP', 'CL 434 keep', full_, now() - interval '1 hour');
  ALTER TABLE "RetentionDecisions" ENABLE TRIGGER "RetentionDecisions_stamped";
  run := app.gallring_begin(school, now());
  IF app.gallring_purge(run, 'CHECKLISTS', 100) <> 0 THEN RAISE EXCEPTION 'checklistor 434b: a school that keeps its checklists lost a row'; END IF;
  PERFORM app.gallring_finish(run, '{}', now());

  -- A pupil who comes back is not due: the school reactivates p2 (last, since a reactivation queues a deferred event on Users that
  -- stops the next ALTER TABLE), and nothing of p2 is due however far on the cutoff is.
  UPDATE "Users" SET "isActive" = true WHERE id = p2;
  PERFORM pg_temp.clo_expect('434b a pupil who is back',
    (SELECT count(*)::text FROM app.gallring_due(school, 'CHECKLISTS', today + 10000, today) d
      WHERE d.id IN (SELECT id FROM "InstructionProofs" WHERE "studentId" = p2 UNION SELECT id FROM "ConsentEntries" WHERE "studentId" = p2)), '0');
END $$;
ROLLBACK;


-- ---------------------------------------------------------------------------
-- Kvittens, after the independent review of #277 (20270202090000), owner checks.
--
--   450o  the delivery's three doors (the list, the pass, the mark) answer nothing to any login, a person or not
--   451o  the sender rows of the usage are read under Drift
--   452o  the day's window in the usage: the school's rows, one's own and the senders'
--   453o  a removed sender's share, and the mark leaves the time the reminder went alone
-- ---------------------------------------------------------------------------

CREATE FUNCTION pg_temp.kq_expect(p_label text, p_got text, p_want text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_want THEN
    RAISE EXCEPTION E'kvittens %: got\n%\nwanted\n%', p_label, p_got, p_want;
  END IF;
END $$;
-- The usage as one text for a caller, in the order the function answers (claims set for this transaction).
CREATE FUNCTION pg_temp.kq_usage(p_auth text, p_senders integer DEFAULT 5) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  seen text;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_auth)::text, true);
  SELECT coalesce(string_agg(u.scope || coalesce(':' || u.author_name, '') || ' ' || u.used || '/' || u.cap, ', ' ORDER BY u.n), '')
    INTO seen
    FROM app.ack_usage(p_senders) WITH ORDINALITY u(scope, author_id, author_name, used, cap, n);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN seen;
END $$;

-- 450o: app.ack_remind_queue, app.ack_remind_request and app.ack_reminder_mirrored are the delivery's doors, and the
-- delivery sets no claims. A session with any claims gets nothing from them, and that includes a login that is no person:
-- the huvudman's reader (a läsare of the school it chose, with no Users row there, so app.current_user_id() is NULL) is
-- the one a guard on the person row let through, and the list is the door that handed it every school's due requests.
-- A subject setting alone (the older claim style, which Supabase's auth.uid() also reads) is a login too. The same
-- functions then do their work for the door, so none of this passes because they do nothing at all. (The guard's text and
-- the doors' behaviour under every setting without a due row are 450's.)
BEGIN;
DO $$
DECLARE
  school uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-kvittens-school');
  roller uuid := (SELECT "schoolId" FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000115');
  full_ uuid := pg_temp.kvo_user('kv-full');
  waits uuid;        -- a SENT reminder that waits for the delivery's mark
  by_reader uuid;    -- a due request each of the three logins asks the pass to take
  by_sub uuid;
  by_person uuid;
  asked uuid[];
  n bigint;
  notices bigint;
BEGIN
  INSERT INTO "AckSettings" ("schoolId", enabled, "remindAfterDays") VALUES (school, true, 2)
    ON CONFLICT ("schoolId") DO UPDATE SET enabled = true, "remindAfterDays" = 2;
  waits := pg_temp.kvo_request(school, full_, 'Väntar på märket', 'ANY', 'p1:g1');
  by_reader := pg_temp.kvo_request(school, full_, 'Läsarens', 'ANY', 'p1:g1');
  by_sub := pg_temp.kvo_request(school, full_, 'Subjektets', 'ANY', 'p2:g1');
  by_person := pg_temp.kvo_request(school, full_, 'Personens', 'ANY', 'p3:g3');
  asked := ARRAY[by_reader, by_sub, by_person];
  UPDATE "AckRequests" SET "remindAt" = now() - interval '1 hour' WHERE id = ANY (asked || waits);

  -- The delivery's door (no claims; the empty string is what a pooled connection reads after a login's transaction)
  -- is handed the four due requests by the list, and takes the first one: SENT, and not yet marked.
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  SELECT count(*) INTO n FROM app.ack_remind_queue(1000) q WHERE q.request_id = ANY (asked || waits);
  IF n <> 4 THEN RAISE EXCEPTION 'kvittens 450o: the door''s list holds % of the four due requests, not 4', n; END IF;
  SELECT count(*) INTO n FROM app.ack_remind_request(waits);
  IF n <> 1 THEN RAISE EXCEPTION 'kvittens 450o: the door wrote % notices for the first request, not 1', n; END IF;
  PERFORM pg_temp.kq_expect('450o the first reminder is SENT and not marked',
                            (SELECT "reminderOutcome"::text || ':' || ("reminderMirroredAt" IS NOT NULL) FROM "AckRequests" WHERE id = waits), 'SENT:false');
  notices := (SELECT count(*) FROM "Notifications" WHERE "schoolId" = school AND "type"::text = 'ACK_REMINDER');

  -- The huvudman's reader at the roller school: a login with no person there.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', 'fe000000-0000-4000-8000-000000000260')::text, true);
  PERFORM set_config('app.chosen_school_id', roller::text, true);
  IF app.current_user_id() IS NOT NULL OR app.current_user_role() IS DISTINCT FROM 'SCHOOL_ADMIN' OR app.current_school_id() IS DISTINCT FROM roller THEN
    RAISE EXCEPTION 'kvittens 450o: P is not the reader at the roller school (school %, person %, role %)', app.current_school_id(), app.current_user_id(), app.current_user_role();
  END IF;
  SELECT count(*) INTO n FROM app.ack_remind_queue(1000);
  IF n <> 0 THEN RAISE EXCEPTION 'kvittens 450o: a login with no person was handed the list of % due requests, of every school', n; END IF;
  SELECT count(*) INTO n FROM app.ack_remind_request(by_reader);
  IF n <> 0 THEN RAISE EXCEPTION 'kvittens 450o: a login with no person was handed % notices to deliver', n; END IF;
  PERFORM app.ack_reminder_mirrored(waits);
  PERFORM set_config('app.chosen_school_id', '', true);

  -- A subject setting alone: no claims JSON, the older style. On this database auth.uid() does not read it, so no person
  -- resolves, which is what makes it tell a guard on the person row from a guard on any login.
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-f40000000001', true);
  SELECT count(*) INTO n FROM app.ack_remind_queue(1000);
  IF n <> 0 THEN RAISE EXCEPTION 'kvittens 450o: a session with only a subject setting was handed the list of % due requests', n; END IF;
  SELECT count(*) INTO n FROM app.ack_remind_request(by_sub);
  IF n <> 0 THEN RAISE EXCEPTION 'kvittens 450o: a session with only a subject setting was handed % notices to deliver', n; END IF;
  PERFORM app.ack_reminder_mirrored(waits);
  PERFORM set_config('request.jwt.claim.sub', '', true);

  -- A person.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-f40000000001')::text, true);
  IF app.current_user_id() IS DISTINCT FROM full_ THEN RAISE EXCEPTION 'kvittens 450o: the person is not Full'; END IF;
  SELECT count(*) INTO n FROM app.ack_remind_queue(1000);
  IF n <> 0 THEN RAISE EXCEPTION 'kvittens 450o: a person was handed the list of % due requests', n; END IF;
  SELECT count(*) INTO n FROM app.ack_remind_request(by_person);
  IF n <> 0 THEN RAISE EXCEPTION 'kvittens 450o: a person was handed % notices to deliver', n; END IF;
  PERFORM app.ack_reminder_mirrored(waits);
  PERFORM set_config('request.jwt.claims', '', true);

  -- Nothing was written by any of the three: no outcome, no notice, no guardian marked as reminded, no mark.
  PERFORM pg_temp.kq_expect('450o nothing reminded by a login',
                            (SELECT string_agg(coalesce("reminderOutcome"::text, '-'), ',' ORDER BY title COLLATE "C") FROM "AckRequests" WHERE id = ANY (asked)), '-,-,-');
  PERFORM pg_temp.kq_expect('450o no notice written by a login',
                            ((SELECT count(*) FROM "Notifications" WHERE "schoolId" = school AND "type"::text = 'ACK_REMINDER') - notices)::text, '0');
  PERFORM pg_temp.kq_expect('450o no guardian marked reminded by a login',
                            (SELECT count(*)::text FROM "AckReceipts" WHERE "requestId" = ANY (asked) AND "remindedAt" IS NOT NULL), '0');
  PERFORM pg_temp.kq_expect('450o nothing marked mailed by a login',
                            (SELECT ("reminderMirroredAt" IS NOT NULL)::text FROM "AckRequests" WHERE id = waits), 'false');

  -- The door does all of it: the three requests are taken (they were due and waiting, so they are not skipped for some
  -- other reason) and the SENT reminder is marked.
  SELECT count(*) INTO n FROM app.ack_remind_request(by_reader);
  SELECT n + count(*) INTO n FROM app.ack_remind_request(by_sub);
  SELECT n + count(*) INTO n FROM app.ack_remind_request(by_person);
  IF n <> 3 THEN RAISE EXCEPTION 'kvittens 450o: the door wrote % notices for the three requests, not 3', n; END IF;
  PERFORM app.ack_reminder_mirrored(waits);
  PERFORM pg_temp.kq_expect('450o the door takes the requests',
                            (SELECT string_agg(coalesce("reminderOutcome"::text, '-'), ',' ORDER BY title COLLATE "C") FROM "AckRequests" WHERE id = ANY (asked)), 'SENT,SENT,SENT');
  PERFORM pg_temp.kq_expect('450o the door marks', (SELECT ("reminderMirroredAt" IS NOT NULL)::text FROM "AckRequests" WHERE id = waits), 'true');
  PERFORM pg_temp.kq_expect('450o the list no longer holds what the door took',
                            (SELECT count(*)::text FROM app.ack_remind_queue(1000) q WHERE q.request_id = ANY (asked || waits)), '0');
END $$;
ROLLBACK;

-- 451o: the sender rows of the usage name people, so they are read under Drift (a gate on the function and not only on
-- the route). Every profile of today reads Drift, so the real function shows them to every administrator and the gate
-- decides nothing yet; the first profile without it would, and there is no such profile to ask. A stand-in for
-- app.current_user_may that says no to a read of Drift, made inside this transaction and rolled back with it, is that
-- profile: the school and one's own share are shown, no sender is.
BEGIN;
DO $$
DECLARE
  school uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-kvittens-school');
  full_ uuid := pg_temp.kvo_user('kv-full');
  the_md5 text := md5((SELECT prosrc FROM pg_proc WHERE oid = 'app.current_user_may("AdminArea", boolean)'::regprocedure));
BEGIN
  INSERT INTO "AckSettings" ("schoolId", enabled) VALUES (school, true) ON CONFLICT ("schoolId") DO UPDATE SET enabled = true;
  PERFORM pg_temp.kvo_request(school, full_, 'Drift-grinden', 'ANY', 'p1:g1');
  PERFORM pg_temp.kq_expect('451o an administrator who reads Drift is told the senders',
                            pg_temp.kq_usage('00000000-0000-4000-8000-f40000000001'), 'SCHOOL 1/20000, ME 1/8000, SENDER:Kvittens Full 1/8000');

  CREATE OR REPLACE FUNCTION app.current_user_may(p_area "AdminArea", p_write boolean) RETURNS boolean LANGUAGE sql STABLE AS $f$
    SELECT NOT (p_area = 'DRIFT' AND NOT coalesce(p_write, true))
  $f$;
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = 'app.current_user_may("AdminArea", boolean)'::regprocedure)) = the_md5 THEN
    RAISE EXCEPTION 'kvittens 451o: the stand-in for the Drift gate was not made';
  END IF;
  PERFORM pg_temp.kq_expect('451o an administrator who may not read Drift is told no sender, and still the school and their own share',
                            pg_temp.kq_usage('00000000-0000-4000-8000-f40000000001'), 'SCHOOL 1/20000, ME 1/8000');
END $$;
ROLLBACK;

-- 452o: the day is the last 24 hours, in all three of the usage's counts. A request with its receipts made 24 hours and
-- ten minutes ago is no part of it, one made 23 hours and fifty minutes ago is. (The limits count the same window:
-- 381o moves a request across it and watches the limit open.)
BEGIN;
DO $$
DECLARE
  school uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-kvittens-school');
  full_ uuid := pg_temp.kvo_user('kv-full');
  old_req uuid := gen_random_uuid();
  new_req uuid := gen_random_uuid();
  long_ago constant timestamptz := now() - interval '24 hours 10 minutes';
  lately constant timestamptz := now() - interval '23 hours 50 minutes';
BEGIN
  INSERT INTO "AckSettings" ("schoolId", enabled) VALUES (school, true) ON CONFLICT ("schoolId") DO UPDATE SET enabled = true;
  INSERT INTO "AckRequests" (id, "schoolId", "authorId", title, body, "createdAt")
  VALUES (old_req, school, full_, 'Över ett dygn', 'B', long_ago), (new_req, school, full_, 'Strax under ett dygn', 'B', lately);
  INSERT INTO "AckReceipts" ("requestId", "schoolId", "studentId", "guardianId", "createdAt")
  VALUES (old_req, school, pg_temp.kvo_user('kv-p1'), pg_temp.kvo_user('kv-g1'), long_ago),
         (old_req, school, pg_temp.kvo_user('kv-p1'), pg_temp.kvo_user('kv-g2'), long_ago),
         (new_req, school, pg_temp.kvo_user('kv-p1'), pg_temp.kvo_user('kv-g1'), lately),
         (new_req, school, pg_temp.kvo_user('kv-p1'), pg_temp.kvo_user('kv-g2'), lately),
         (new_req, school, pg_temp.kvo_user('kv-p2'), pg_temp.kvo_user('kv-g1'), lately);
  PERFORM pg_temp.kvo_expect('452o the rows are there', (SELECT count(*)::text FROM "AckReceipts" WHERE "schoolId" = school), '5');
  PERFORM pg_temp.kq_expect('452o only the last 24 hours are counted: the school, one''s own share and the sender',
                            pg_temp.kq_usage('00000000-0000-4000-8000-f40000000001'), 'SCHOOL 3/20000, ME 3/8000, SENDER:Kvittens Full 3/8000');
END $$;
ROLLBACK;

-- 453o: a sender whose Users row is gone (a teacher removed after she asked) has no role to look up, and is read with the
-- stricter share, a teacher's 2 000, never an administrator's 8 000: the name stays, the person does not. And the mark
-- that the delivery makes moves nothing else: the time the reminder went is the pass's and stays what it was, with the
-- mark after it.
BEGIN;
DO $$
DECLARE
  school uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-kvittens-school');
  full_ uuid := pg_temp.kvo_user('kv-full');
  gone uuid;
  waits uuid;
  went timestamptz;
BEGIN
  INSERT INTO "AckSettings" ("schoolId", enabled, "remindAfterDays") VALUES (school, true, 2)
    ON CONFLICT ("schoolId") DO UPDATE SET enabled = true, "remindAfterDays" = 2;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (school, 'kv-borta@example.invalid', 'Kvittens', 'Borta', 'TEACHER', gen_random_uuid(), true, now()) RETURNING id INTO gone;
  PERFORM pg_temp.kvo_request(school, gone, 'Borttagens', 'ANY', 'p1:g1');
  DELETE FROM "Users" WHERE id = gone;
  PERFORM pg_temp.kq_expect('453o a removed sender is read with the teacher''s share',
                            pg_temp.kq_usage('00000000-0000-4000-8000-f40000000001'), 'SCHOOL 1/20000, ME 0/8000, SENDER:Kvittens Borta 1/2000');

  waits := pg_temp.kvo_request(school, full_, 'Går och märks', 'ANY', 'p1:g1');
  UPDATE "AckRequests" SET "remindAt" = now() - interval '1 hour' WHERE id = waits;
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM count(*) FROM app.ack_remind_request(waits);
  went := (SELECT "reminderSentAt" FROM "AckRequests" WHERE id = waits);
  IF went IS NULL THEN RAISE EXCEPTION 'kvittens 453o: the request was not sent'; END IF;
  PERFORM pg_sleep(0.02);
  PERFORM app.ack_reminder_mirrored(waits);
  PERFORM pg_temp.kq_expect('453o the mark leaves the time the reminder went alone',
                            (SELECT "reminderSentAt" = went FROM "AckRequests" WHERE id = waits)::text, 'true');
  PERFORM pg_temp.kq_expect('453o the mark is after the time the reminder went',
                            (SELECT ("reminderMirroredAt" > "reminderSentAt")::text FROM "AckRequests" WHERE id = waits), 'true');
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Lokal (K3, 20270204091000), section 444b-d, on the owner's side: what gallring does with a series of external bookings and its
-- days, what the removal of the person who registered one leaves, and what a delete of a school takes. 440-443 and 444a are
-- rls-policies.sql's.
-- ---------------------------------------------------------------------------

CREATE FUNCTION pg_temp.k3_owner_expect(p_label text, p_got text, p_want text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_want THEN RAISE EXCEPTION E'lokal %: got\n%\nwanted\n%', p_label, p_got, p_want; END IF;
END $$;

-- 444b: gallring. A series that has ended, or been cancelled, longer ago than the school's period goes with its days (and only
-- then); a series that runs never does, however long the period; nothing is due under another kind; the other school's stay.
BEGIN;
DO $$
DECLARE
  school uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-lokal-school');
  other uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-lokal-annan');
  full_ uuid := (SELECT id FROM "Users" WHERE email = 'lk-full@example.invalid');
  full_o uuid := (SELECT id FROM "Users" WHERE email = 'lk-annan-full@example.invalid');
  hall uuid := (SELECT id FROM "Rooms" WHERE "schoolId" = school AND name = 'Idrottshallen');
  hall_o uuid := (SELECT id FROM "Rooms" WHERE "schoolId" = other);
  today date := (now() AT TIME ZONE 'Europe/Stockholm')::date;
  old_ended uuid; old_cancelled uuid; recent uuid; running uuid; theirs uuid;
  run uuid;
  n integer;
  total integer := 0;
  counts jsonb;
  src text;
BEGIN
  -- Four series of the school: over for 500 days, cancelled 500 days ago (its last day only 165 days past), over for 100 days, running.
  -- Each has one day; the old ones' days are past.
  INSERT INTO "ExternalBookings" ("schoolId", "roomId", organisation, "contactName", "contactPhone", weekdays, "startDate", "endDate", "startTime", "endTime", "registeredById")
  VALUES (school, hall, 'Gammal', 'A', '070', ARRAY[2]::smallint[], today - 600, today - 500, '18:00', '20:00', full_) RETURNING id INTO old_ended;
  INSERT INTO "ExternalBookings" ("schoolId", "roomId", organisation, "contactName", "contactPhone", weekdays, "startDate", "endDate", "startTime", "endTime", "registeredById", "cancelledAt")
  VALUES (school, hall, 'Avbokad', 'B', '070', ARRAY[2]::smallint[], today - 560, today - 165, '18:00', '20:00', full_, now() - interval '500 days') RETURNING id INTO old_cancelled;
  INSERT INTO "ExternalBookings" ("schoolId", "roomId", organisation, "contactName", "contactPhone", weekdays, "startDate", "endDate", "startTime", "endTime", "registeredById")
  VALUES (school, hall, 'Nyss slut', 'C', '070', ARRAY[2]::smallint[], today - 200, today - 100, '18:00', '20:00', full_) RETURNING id INTO recent;
  INSERT INTO "ExternalBookings" ("schoolId", "roomId", organisation, "contactName", "contactPhone", weekdays, "startDate", "endDate", "startTime", "endTime", "registeredById")
  VALUES (school, hall, 'Pågår', 'D', '070', ARRAY[2]::smallint[], today - 10, today + 60, '18:00', '20:00', full_) RETURNING id INTO running;
  INSERT INTO "ExternalBookings" ("schoolId", "roomId", organisation, "contactName", "contactPhone", weekdays, "startDate", "endDate", "startTime", "endTime", "registeredById")
  VALUES (other, hall_o, 'Annans gamla', 'E', '070', ARRAY[2]::smallint[], today - 600, today - 500, '18:00', '20:00', full_o) RETURNING id INTO theirs;
  INSERT INTO "RoomBookings" ("schoolId", "roomId", "bookedById", title, "startsAt", "endsAt", "updatedAt", "externalBookingId")
  SELECT x."schoolId", x."roomId", x."registeredById", 'Extern bokning', (x."endDate" - 3 + time '18:00')::timestamp AT TIME ZONE 'Europe/Stockholm', (x."endDate" - 3 + time '20:00')::timestamp AT TIME ZONE 'Europe/Stockholm', now(), x.id
    FROM "ExternalBookings" x WHERE x.id IN (old_ended, old_cancelled, recent, running, theirs);
  -- A booking of the school's own that gallring must not touch.
  INSERT INTO "RoomBookings" ("schoolId", "roomId", "bookedById", title, "startsAt", "endsAt", "updatedAt")
  VALUES (school, hall, full_, 'Egen', now() - interval '600 days', now() - interval '600 days' + interval '1 hour', now());

  -- What is due a year on, by the one predicate: the two old series, not the one that ended 100 days ago, not the running one,
  -- not the other school's; and nothing of it under any other kind.
  PERFORM pg_temp.k3_owner_expect('444b due',
    (SELECT string_agg(d.id::text, ' ' ORDER BY d.id::text) FROM app.gallring_due(school, 'EXTERNAL_BOOKINGS', today - 365, today) d WHERE d.tbl = 'ExternalBookings'),
    (SELECT string_agg(i::text, ' ' ORDER BY i::text) FROM unnest(ARRAY[old_ended, old_cancelled]) i));
  PERFORM pg_temp.k3_owner_expect('444b nothing is due of anything else',
    (SELECT count(*)::text FROM app.gallring_due(school, 'EXTERNAL_BOOKINGS', today - 365, today) d WHERE d.tbl <> 'ExternalBookings'), '0');
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['ATTENDANCE', 'ABSENCE_REPORTS', 'LEAVE_REQUESTS', 'NOTIFICATIONS', 'CHANGE_LOGS', 'ABSENCE_REASONS', 'ACCESS_LOG', 'COVER_REQUESTS',
                                         'CRISIS_DRILLS', 'CRISIS_ALARMS', 'CHECKLISTS', 'DEPARTED_PEOPLE']::"RetentionDataType"[]) t
              WHERE EXISTS (SELECT 1 FROM app.gallring_due(school, t, today - 365, today) d WHERE d.tbl = 'ExternalBookings')) THEN
    RAISE EXCEPTION 'lokal 444b: a series is due under another kind than EXTERNAL_BOOKINGS';
  END IF;
  -- A running series is never due, however far on the cutoff is, until it has ended.
  PERFORM pg_temp.k3_owner_expect('444b a running series is not due',
    (SELECT count(*)::text FROM app.gallring_due(school, 'EXTERNAL_BOOKINGS', today + 30, today) d WHERE d.id = running), '0');
  PERFORM pg_temp.k3_owner_expect('444b a series of the other school is not due under this school''s run',
    (SELECT count(*)::text FROM app.gallring_due(school, 'EXTERNAL_BOOKINGS', today - 365, today) d WHERE d.id = theirs), '0');

  -- No decision: nothing goes. A decision of twelve months: the run takes the two series, one at a time, with their days.
  run := app.gallring_begin(school, now());
  IF app.gallring_purge(run, 'EXTERNAL_BOOKINGS', 100) <> 0 THEN RAISE EXCEPTION 'lokal 444b: a school with no decision lost a series'; END IF;
  PERFORM app.gallring_finish(run, '{}', now());
  ALTER TABLE "RetentionDecisions" DISABLE TRIGGER "RetentionDecisions_stamped";
  INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision, months, reference, "decidedById", "decidedAt")
  VALUES (school, 'EXTERNAL_BOOKINGS', 'PURGE_AFTER', 12, 'LK 444', full_, now() - interval '2 days');
  ALTER TABLE "RetentionDecisions" ENABLE TRIGGER "RetentionDecisions_stamped";
  run := app.gallring_begin(school, now());
  IF app.gallring_purge(run, 'EXTERNAL_BOOKINGS', 1) <> 1 THEN RAISE EXCEPTION 'lokal 444b: a batch of one took more or less than one series'; END IF;
  LOOP
    n := app.gallring_purge(run, 'EXTERNAL_BOOKINGS', 1);
    EXIT WHEN n = 0;
    total := total + n;
  END LOOP;
  PERFORM app.gallring_finish(run, '{}', now());
  IF total <> 1 THEN RAISE EXCEPTION 'lokal 444b: the batches after the first took % more series, not one', total; END IF;
  SELECT g.counts INTO counts FROM "GallringRuns" g WHERE g.id = run;
  IF (counts ->> 'EXTERNAL_BOOKINGS')::integer <> 2 THEN RAISE EXCEPTION 'lokal 444b: the run counts % under EXTERNAL_BOOKINGS, not two series', counts ->> 'EXTERNAL_BOOKINGS'; END IF;
  PERFORM pg_temp.k3_owner_expect('444b what is left of the school',
    (SELECT string_agg(organisation, ',' ORDER BY organisation) FROM "ExternalBookings" WHERE "schoolId" = school), 'Nyss slut,Pågår');
  PERFORM pg_temp.k3_owner_expect('444b the days went with their series, and the school''s own booking stayed',
    (SELECT string_agg(coalesce(x.organisation, title), ',' ORDER BY coalesce(x.organisation, title))
       FROM "RoomBookings" b LEFT JOIN "ExternalBookings" x ON x.id = b."externalBookingId" WHERE b."schoolId" = school),
    'Egen,Nyss slut,Pågår');
  PERFORM pg_temp.k3_owner_expect('444b the other school was left alone',
    (SELECT count(*)::text FROM "ExternalBookings" WHERE "schoolId" = other) || '/' || (SELECT count(*)::text FROM "RoomBookings" WHERE "schoolId" = other), '1/1');

  -- The branch is there in the source (and the others are kept: RLS sections 350 and 374 and src/gallring/gallring-branches.spec.ts say which).
  SELECT prosrc INTO src FROM pg_proc WHERE oid = 'app.gallring_due(uuid, "RetentionDataType", date, date)'::regprocedure;
  IF src NOT LIKE '%''ExternalBookings''%' OR src NOT LIKE '%EXTERNAL_BOOKINGS%' THEN RAISE EXCEPTION 'lokal 444b: gallring_due has no branch for the external bookings'; END IF;
  SELECT prosrc INTO src FROM pg_proc WHERE oid = 'app.gallring_purge(uuid, "RetentionDataType", integer)'::regprocedure;
  IF src NOT LIKE '%WHEN ''EXTERNAL_BOOKINGS'' THEN%' OR src NOT LIKE '%DELETE FROM "ExternalBookings"%' THEN RAISE EXCEPTION 'lokal 444b: gallring_purge has no branch for the external bookings'; END IF;
END $$;
ROLLBACK;

-- 444c: a person who registered a series is removed. The series stays, with nobody as its registrar; the days they booked go with
-- them (the key from a booking to its booker is CASCADE, as every booking's), which is why the gateway refuses the removal of a
-- person whose series still runs; the person's other bookings of a resource go too, and a decision they made stays, unlinked.
BEGIN;
DO $$
DECLARE
  school uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-lokal-school');
  hall uuid := (SELECT id FROM "Rooms" WHERE "schoolId" = school AND name = 'Idrottshallen');
  gone uuid;
  decider uuid;
  rtype uuid; res uuid; series uuid; mine uuid; decided uuid;
  today date := (now() AT TIME ZONE 'Europe/Stockholm')::date;
BEGIN
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (school, 'lk-borta@example.invalid', 'Lokal', 'Borta', 'SCHOOL_ADMIN', gen_random_uuid(), true, now()) RETURNING id INTO gone;
  decider := (SELECT id FROM "Users" WHERE email = 'lk-t2@example.invalid');
  INSERT INTO "ResourceTypes" ("schoolId", name) VALUES (school, 'Borttagningens') RETURNING id INTO rtype;
  INSERT INTO "Resources" ("schoolId", "resourceTypeId", name, quantity) VALUES (school, rtype, 'Borttagningens resurs', 10) RETURNING id INTO res;
  INSERT INTO "ExternalBookings" ("schoolId", "roomId", organisation, "contactName", "contactEmail", weekdays, "startDate", "endDate", "startTime", "endTime", "registeredById")
  VALUES (school, hall, 'Registrerad av den borttagne', 'F', 'f@example.invalid', ARRAY[2]::smallint[], today + 300, today + 330, '18:00', '20:00', gone) RETURNING id INTO series;
  INSERT INTO "RoomBookings" ("schoolId", "roomId", "bookedById", title, "startsAt", "endsAt", "updatedAt", "externalBookingId")
  VALUES (school, hall, gone, 'Extern bokning', ((today + 305) + time '18:00')::timestamp AT TIME ZONE 'Europe/Stockholm', ((today + 305) + time '20:00')::timestamp AT TIME ZONE 'Europe/Stockholm', now(), series);
  INSERT INTO "ResourceBookings" ("schoolId", "resourceId", "bookedById", title, quantity, "startsAt", "endsAt")
  VALUES (school, res, gone, 'Den borttagnes', 1, now() + interval '300 days', now() + interval '300 days 1 hour') RETURNING id INTO mine;
  INSERT INTO "ResourceBookings" ("schoolId", "resourceId", "bookedById", title, quantity, status, "decidedById", "decidedAt", "startsAt", "endsAt")
  VALUES (school, res, decider, 'Beslutad av den borttagne', 1, 'APPROVED', gone, now(), now() + interval '301 days', now() + interval '301 days 1 hour') RETURNING id INTO decided;

  DELETE FROM "Users" WHERE id = gone;
  PERFORM pg_temp.k3_owner_expect('444c the series stays, with nobody as registrar',
    (SELECT concat_ws('|', count(*), count("registeredById")) FROM "ExternalBookings" WHERE id = series), '1|0');
  PERFORM pg_temp.k3_owner_expect('444c the days they booked went with them', (SELECT count(*)::text FROM "RoomBookings" WHERE "externalBookingId" = series), '0');
  PERFORM pg_temp.k3_owner_expect('444c their other bookings went too', (SELECT count(*)::text FROM "ResourceBookings" WHERE id = mine), '0');
  PERFORM pg_temp.k3_owner_expect('444c a decision they made stays, unlinked',
    (SELECT concat_ws('|', count(*), count("decidedById")) FROM "ResourceBookings" WHERE id = decided), '1|0');
END $$;
ROLLBACK;

-- 444d: the removal of a school takes everything of Lokal (the keys from the four tables to Schools are CASCADE), and a resource or
-- a room that has a series is not deleted from under it, nor a kind that has a resource (restrict), by anyone.
BEGIN;
DO $$
DECLARE
  school uuid;
  hall uuid;
  rtype uuid; res uuid; series uuid;
BEGIN
  INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ('RLS Lokal tillfällig', 'rls-lokal-tillfallig', 'Europe/Stockholm', now()) RETURNING id INTO school;
  INSERT INTO "Rooms" ("schoolId", name, "updatedAt") VALUES (school, 'Tillfälliga hallen', now()) RETURNING id INTO hall;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (school, 'lk-tillf@example.invalid', 'Lokal', 'Tillfällig', 'SCHOOL_ADMIN', gen_random_uuid(), true, now());
  INSERT INTO "ResourceTypes" ("schoolId", name) VALUES (school, 'Slag') RETURNING id INTO rtype;
  INSERT INTO "Resources" ("schoolId", "resourceTypeId", name) VALUES (school, rtype, 'Resurs') RETURNING id INTO res;
  INSERT INTO "ExternalBookings" ("schoolId", "resourceId", "resourceQuantity", organisation, "contactName", "contactPhone", weekdays, "startDate", "endDate", "startTime", "endTime")
  VALUES (school, res, 1, 'Förening', 'G', '070', ARRAY[3]::smallint[], current_date + 10, current_date + 20, '18:00', '19:00') RETURNING id INTO series;
  BEGIN
    DELETE FROM "Resources" WHERE id = res;
    RAISE EXCEPTION 'lokal 444d: a resource that is let out was deleted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    DELETE FROM "ResourceTypes" WHERE id = rtype;
    RAISE EXCEPTION 'lokal 444d: a kind with a resource was deleted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  DELETE FROM "Schools" WHERE id = school;
  PERFORM pg_temp.k3_owner_expect('444d nothing of the school is left',
    (SELECT concat_ws('/', (SELECT count(*) FROM "ResourceTypes" WHERE "schoolId" = school), (SELECT count(*) FROM "Resources" WHERE "schoolId" = school),
                      (SELECT count(*) FROM "ExternalBookings" WHERE "schoolId" = school), (SELECT count(*) FROM "ResourceBookings" WHERE "schoolId" = school))), '0/0/0/0');
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Ledighetspolicy (K4, 20270205091000), the owner's side: sections 445o-449o. The checks a
-- policy cannot make (a table's own CHECKs and the gate, for a writer with no login), and
-- the job's pass, whose logic needs requests made in the past. Fixtures: rls-kvittens-school.
--
--   445o  what the tables hold whoever writes them
--   448o  the pass: one reminder, to a guardian who can still answer, two days after the
--         request; the mentors of a request a custody that ended made clear, once
--   449o  gone with the request and with the person
-- ---------------------------------------------------------------------------

CREATE FUNCTION pg_temp.k4o_user(p_email text) RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM "Users" WHERE email = p_email || '@example.invalid'
$$;
CREATE FUNCTION pg_temp.k4o_refuses(p_sql text, p_state text, p_what text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  got text := 'none';
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    got := SQLSTATE;
  END;
  IF got IS DISTINCT FROM p_state THEN
    RAISE EXCEPTION 'ledighetspolicy: % should be refused with %, was %', p_what, p_state, got;
  END IF;
END $$;
-- A request made by `by`, `age` ago, from `from` days ahead for one day; the owner writes it, so nothing is stamped
-- and nothing is refused, and the trigger that asks the guardians reads the row as written.
CREATE FUNCTION pg_temp.k4o_request(p_pupil text, p_by text, p_age interval, p_from integer, p_consent boolean) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  req uuid := gen_random_uuid();
BEGIN
  INSERT INTO "LeaveRequests" (id, "schoolId", "studentId", "requestedById", "startDate", "endDate", reason, "consentRequired", "createdAt")
  VALUES (req, (SELECT id FROM "Schools" WHERE slug = 'rls-kvittens-school'), pg_temp.k4o_user(p_pupil), pg_temp.k4o_user(p_by),
          current_date + p_from, current_date + p_from, 'Resa', p_consent, now() - p_age);
  RETURN req;
END $$;
-- Who has what, as text: the recipients' short names, sorted, of the notices of a type.
CREATE FUNCTION pg_temp.k4o_rows(p_rows text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  got text;
BEGIN
  EXECUTE p_rows INTO got;
  RETURN coalesce(got, '');
END $$;

-- 445o: what the tables hold whoever writes them.
BEGIN;
DO $$
DECLARE
  school uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-kvittens-school');
  req uuid;
  other uuid;
BEGIN
  IF school IS NULL THEN RAISE EXCEPTION 'ledighetspolicy 445o: the fixtures did not run'; END IF;
  PERFORM set_config('request.jwt.claims', '', true);
  req := pg_temp.k4o_request('kv-p1', 'kv-g1', interval '0', 10, false);
  -- The contact is all three or none, whoever writes it: the CHECKs, not the trigger, which a writer with no login passes.
  PERFORM pg_temp.k4o_refuses(format($q$UPDATE "LeaveRequests" SET "contactName" = 'Farmor' WHERE id = %L$q$, req), 'LV409', 'a contact written on a request already filed');
  PERFORM pg_temp.k4o_refuses(format($q$INSERT INTO "LeaveRequests" ("schoolId", "studentId", "requestedById", "startDate", "endDate", reason, "contactName")
    VALUES (%L, %L, %L, current_date, current_date, 'Resa', 'Farmor')$q$, school, pg_temp.k4o_user('kv-p1'), pg_temp.k4o_user('kv-g1')), '23514', 'a name alone, written with no trigger in the way');
  PERFORM pg_temp.k4o_refuses(format($q$INSERT INTO "LeaveRequests" ("schoolId", "studentId", "requestedById", "startDate", "endDate", reason, "contactName", "contactPhone", "contactRelation")
    VALUES (%L, %L, %L, current_date, current_date, 'Resa', 'Farmor', '123', 'Farmor')$q$, school, pg_temp.k4o_user('kv-p1'), pg_temp.k4o_user('kv-g1')), '23514', 'a telephone number of three characters, written with no trigger in the way');
  -- A stopped request is a consent request whose no ended it, with no decider.
  PERFORM pg_temp.k4o_refuses(format($q$INSERT INTO "LeaveRequests" ("schoolId", "studentId", "requestedById", "startDate", "endDate", reason, status)
    VALUES (%L, %L, %L, current_date, current_date, 'Resa', 'GUARDIAN_DECLINED')$q$, school, pg_temp.k4o_user('kv-p1'), pg_temp.k4o_user('kv-g1')), '23514', 'a stopped request the school never asked consent for');
  PERFORM pg_temp.k4o_refuses(format($q$INSERT INTO "LeaveRequests" ("schoolId", "studentId", "requestedById", "startDate", "endDate", reason, status, "consentRequired", "decidedById")
    VALUES (%L, %L, %L, current_date, current_date, 'Resa', 'GUARDIAN_DECLINED', true, %L)$q$, school, pg_temp.k4o_user('kv-p1'), pg_temp.k4o_user('kv-g1'), pg_temp.k4o_user('kv-full')), '23514', 'a stopped request with a decider');
  -- The gate holds for the owner too: a stop needs a guardian's no, and a decision needs the consent.
  req := pg_temp.k4o_request('kv-p1', 'kv-g1', interval '0', 10, true);
  PERFORM pg_temp.k4o_refuses(format($q$UPDATE "LeaveRequests" SET status = 'GUARDIAN_DECLINED', "decidedAt" = now() WHERE id = %L$q$, req), 'LV416', 'a stop with no no');
  PERFORM pg_temp.k4o_refuses(format($q$UPDATE "LeaveRequests" SET status = 'APPROVED', "decidedAt" = now() WHERE id = %L$q$, req), 'LV412', 'an approval before the consent');
  -- A rejection grants nothing and is not held back (the review of #292, MEDEL-1).
  other := pg_temp.k4o_request('kv-p1', 'kv-g1', interval '0', 11, true);
  UPDATE "LeaveRequests" SET status = 'REJECTED', "decidedAt" = now() WHERE id = other;
  IF (SELECT status FROM "LeaveRequests" WHERE id = other) <> 'REJECTED' THEN RAISE EXCEPTION 'ledighetspolicy 445o: a request that waits for consent could not be rejected'; END IF;
  UPDATE "LeaveConsents" SET consented = false, "answeredAt" = now() WHERE "leaveRequestId" = req;
  IF NOT FOUND THEN RAISE EXCEPTION 'ledighetspolicy 445o: the trigger asked nobody for a request that needs consent'; END IF;
  -- A no is not a yes: the consent is not there, and the stop is now allowed.
  PERFORM pg_temp.k4o_refuses(format($q$UPDATE "LeaveRequests" SET status = 'APPROVED', "decidedAt" = now() WHERE id = %L$q$, req), 'LV412', 'an approval after a no');
  UPDATE "LeaveRequests" SET status = 'GUARDIAN_DECLINED', "decidedAt" = now() WHERE id = req;
  IF app.leave_consent_met_raw(req, school) THEN RAISE EXCEPTION 'ledighetspolicy 445o: a request a guardian refused has its consent'; END IF;
END $$;
ROLLBACK;

-- 448o: the pass.
BEGIN;
DO $$
DECLARE
  school uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-kvittens-school');
  due uuid;
  early uuid;
  past uuid;
  answered uuid;
  gone uuid;
  rejected uuid;
  held uuid;
  clear uuid;
  rows_ text;
BEGIN
  IF school IS NULL THEN RAISE EXCEPTION 'ledighetspolicy 448o: the fixtures did not run'; END IF;
  PERFORM set_config('request.jwt.claims', '', true);
  -- Three days old and G2 has not answered: due. One day old: not yet. The leave over: no point. G2 answered: nothing to ask.
  due := pg_temp.k4o_request('kv-p1', 'kv-g1', interval '3 days', 10, true);
  early := pg_temp.k4o_request('kv-p1', 'kv-g1', interval '1 day', 11, true);
  past := pg_temp.k4o_request('kv-p1', 'kv-g1', interval '3 days', -5, true);
  answered := pg_temp.k4o_request('kv-p1', 'kv-g1', interval '3 days', 12, true);
  UPDATE "LeaveConsents" SET consented = true, "answeredAt" = now() WHERE "leaveRequestId" = answered;
  -- A custody that has ended: the guardian of P3 is no longer linked, so nobody can be reminded.
  gone := pg_temp.k4o_request('kv-p3', 'kv-full', interval '3 days', 13, true);
  DELETE FROM "GuardianStudents" WHERE "guardianId" = pg_temp.k4o_user('kv-g3') AND "studentId" = pg_temp.k4o_user('kv-p3');
  -- A request rektor rejected while it waited is not reminded: the wait is over.
  rejected := pg_temp.k4o_request('kv-p1', 'kv-g1', interval '3 days', 16, true);
  UPDATE "LeaveRequests" SET status = 'REJECTED', "decidedAt" = now() WHERE id = rejected;
  -- The pass is the delivery door's, which sets no claims. A login of any kind is not it, also one with no person row (the
  -- huvudman's reader, a municipal administrator): the guard asks the claims, not the person (the review of #292, LÅG-1).
  PERFORM set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid())::text, true);
  IF (SELECT count(*) FROM app.leave_consent_pass()) <> 0 THEN RAISE EXCEPTION 'ledighetspolicy 448o: the pass answered a login with no person row'; END IF;
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
  IF (SELECT count(*) FROM app.leave_consent_pass()) <> 0 THEN RAISE EXCEPTION 'ledighetspolicy 448o: the pass answered a login set the older way'; END IF;
  PERFORM set_config('request.jwt.claim.sub', '', true);

  IF (SELECT count(*) FROM "LeaveConsents" WHERE "leaveRequestId" IN (due, early, past, answered, gone)) <> 5 THEN
    RAISE EXCEPTION 'ledighetspolicy 448o: the trigger did not ask the guardians of the five requests';
  END IF;
  -- (Kept in a table first: a statement does not see the rows its own function wrote.)
  CREATE TEMP TABLE k4o_pass ON COMMIT DROP AS SELECT * FROM app.leave_consent_pass();
  SELECT string_agg(n.type::text || ' ' || split_part(u.email, '@', 1) || ' ' || (n.meta ->> 'leaveRequestId' = due::text)::text || ' ' || coalesce(split_part(p.email, '@', 1), '-'), ', ' ORDER BY u.email)
    INTO rows_
    FROM k4o_pass p
    JOIN "Notifications" n ON n.id = p."notificationId"
    JOIN "Users" u ON u.id = p."userId";
  IF rows_ IS DISTINCT FROM 'LEAVE_CONSENT_REMINDER kv-g2 true kv-g2' THEN
    RAISE EXCEPTION 'ledighetspolicy 448o: the first pass wrote %, not one reminder to G2 for the request that is due', rows_;
  END IF;
  IF (SELECT count(*) FROM "LeaveConsents" WHERE "remindedAt" IS NOT NULL) <> 1 THEN RAISE EXCEPTION 'ledighetspolicy 448o: the pass marked a guardian that was not reminded'; END IF;
  -- Once: a second pass writes nothing. The reminder says what the first notice does, and nothing of who applied.
  IF (SELECT count(*) FROM app.leave_consent_pass()) <> 0 THEN RAISE EXCEPTION 'ledighetspolicy 448o: the second pass reminded again'; END IF;
  IF (SELECT meta::text FROM "Notifications" WHERE type = 'LEAVE_CONSENT_REMINDER' AND "userId" = pg_temp.k4o_user('kv-g2')) LIKE '%' || pg_temp.k4o_user('kv-g1')::text || '%' THEN
    RAISE EXCEPTION 'ledighetspolicy 448o: the reminder says who applied';
  END IF;
  -- Two days is the line: a request 47 hours old waits, one 49 hours old is reminded.
  early := pg_temp.k4o_request('kv-p1', 'kv-g1', interval '47 hours', 14, true);
  IF (SELECT count(*) FROM app.leave_consent_pass() p WHERE p.type = 'LEAVE_CONSENT_REMINDER') <> 0 THEN RAISE EXCEPTION 'ledighetspolicy 448o: a request of 47 hours was reminded'; END IF;
  early := pg_temp.k4o_request('kv-p1', 'kv-g1', interval '49 hours', 15, true);
  IF (SELECT count(*) FROM app.leave_consent_pass() p WHERE p.type = 'LEAVE_CONSENT_REMINDER') <> 1 THEN RAISE EXCEPTION 'ledighetspolicy 448o: a request of 49 hours was not reminded'; END IF;
  -- A limit of none is a pass that does nothing.
  UPDATE "LeaveConsents" SET "remindedAt" = NULL WHERE "leaveRequestId" = due;
  IF (SELECT count(*) FROM app.leave_consent_pass(0)) <> 0 THEN RAISE EXCEPTION 'ledighetspolicy 448o: a pass with a limit of none wrote a reminder'; END IF;
  -- A decided request is not reminded: the guardian's no ended it.
  UPDATE "LeaveConsents" SET consented = false, "answeredAt" = now() WHERE "leaveRequestId" = due;
  UPDATE "LeaveRequests" SET status = 'GUARDIAN_DECLINED', "decidedAt" = now() WHERE id = due;
  UPDATE "LeaveConsents" SET consented = NULL, "answeredAt" = NULL WHERE "leaveRequestId" = due;
  IF (SELECT count(*) FROM app.leave_consent_pass()) <> 0 THEN RAISE EXCEPTION 'ledighetspolicy 448o: a request that has ended was reminded'; END IF;

  -- THE MENTORS. A request a custody that ended made clear is told to the mentor who decides it, once. Rektor delegates five days;
  -- M1 mentors KV7A, where P1 is, and M2 KV7B, where P3 and P5 are.
  INSERT INTO "LeaveDelegationDecisions" ("schoolId", "mentorMaxSchoolDays") VALUES (school, 5);
  held := pg_temp.k4o_request('kv-p1', 'kv-full', interval '0', 30, true);
  clear := pg_temp.k4o_request('kv-p5', 'kv-full', interval '0', 31, true);
  -- A pupil nobody can answer for has the consent at the filing, so the filing's own trigger tells the mentor.
  IF (SELECT count(*) FROM "LeaveRequestNotices" WHERE "leaveRequestId" = clear AND "userId" = pg_temp.k4o_user('kv-m2')) <> 1 THEN
    RAISE EXCEPTION 'ledighetspolicy 448o: the mentor of a pupil nobody answers for is not told at the filing';
  END IF;
  SELECT string_agg(split_part(u.email, '@', 1) || ' ' || (p.meta ->> 'leaveRequestId')::uuid::text, ', ' ORDER BY p.meta ->> 'leaveRequestId')
    INTO rows_
    FROM app.leave_consent_pass() p JOIN "Users" u ON u.id = p."userId" WHERE p.type = 'LEAVE_REQUESTED';
  IF rows_ IS NOT NULL AND rows_ LIKE '%' || held::text || '%' THEN RAISE EXCEPTION 'ledighetspolicy 448o: the pass told a mentor of a request that waits: %', rows_; END IF;
  IF (SELECT count(*) FROM "LeaveRequestNotices" WHERE "leaveRequestId" = held) <> 0 THEN RAISE EXCEPTION 'ledighetspolicy 448o: a mentor is marked told of a request that waits'; END IF;
  -- The guardian left: the request is clear, and the next pass tells the mentor, once.
  DELETE FROM "GuardianStudents" WHERE "guardianId" = pg_temp.k4o_user('kv-g1') AND "studentId" = pg_temp.k4o_user('kv-p1');
  DELETE FROM "GuardianStudents" WHERE "guardianId" = pg_temp.k4o_user('kv-g2') AND "studentId" = pg_temp.k4o_user('kv-p1');
  SELECT string_agg(split_part(u.email, '@', 1), ', ') INTO rows_
    FROM app.leave_consent_pass() p JOIN "Users" u ON u.id = p."userId" WHERE p.type = 'LEAVE_REQUESTED' AND p.meta ->> 'leaveRequestId' = held::text;
  IF rows_ IS DISTINCT FROM 'kv-m1' THEN RAISE EXCEPTION 'ledighetspolicy 448o: the pass told % of the released request, not M1', rows_; END IF;
  IF (SELECT count(*) FROM app.leave_consent_pass() p WHERE p.type = 'LEAVE_REQUESTED' AND p.meta ->> 'leaveRequestId' = held::text) <> 0 THEN
    RAISE EXCEPTION 'ledighetspolicy 448o: the pass told the mentor twice';
  END IF;
  IF (SELECT count(*) FROM "LeaveRequestNotices" WHERE "leaveRequestId" = held AND "userId" = pg_temp.k4o_user('kv-m1')) <> 1 THEN RAISE EXCEPTION 'ledighetspolicy 448o: the mentor is not marked told'; END IF;
  -- The answer of the last guardian tells the mentor in its own transaction, so the pass has nothing left for it.
  IF (SELECT count(*) FROM "Notifications" WHERE type = 'LEAVE_REQUESTED' AND meta ->> 'leaveRequestId' = held::text) <> 1 THEN RAISE EXCEPTION 'ledighetspolicy 448o: not exactly one notice for the mentor'; END IF;
END $$;
ROLLBACK;

-- 449o: gone with the request and with the person.
BEGIN;
DO $$
DECLARE
  school uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-kvittens-school');
  a uuid;
  b uuid;
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  a := pg_temp.k4o_request('kv-p1', 'kv-g1', interval '0', 10, true);
  b := pg_temp.k4o_request('kv-p1', 'kv-g1', interval '0', 11, true);
  -- The request goes (gallring deletes a request whole): its answers go with it, the other request's do not.
  DELETE FROM "LeaveRequests" WHERE id = a;
  IF EXISTS (SELECT 1 FROM "LeaveConsents" WHERE "leaveRequestId" = a) THEN RAISE EXCEPTION 'ledighetspolicy 449o: the answers outlived their request'; END IF;
  IF (SELECT count(*) FROM "LeaveConsents" WHERE "leaveRequestId" = b) <> 1 THEN RAISE EXCEPTION 'ledighetspolicy 449o: the other request lost its answers'; END IF;
  -- The guardian goes: the row about them goes, the request stays, and holds nothing up for want of them.
  DELETE FROM "Users" WHERE id = pg_temp.k4o_user('kv-g2');
  IF EXISTS (SELECT 1 FROM "LeaveConsents" WHERE "leaveRequestId" = b) THEN RAISE EXCEPTION 'ledighetspolicy 449o: the answers outlived the guardian'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "LeaveRequests" WHERE id = b) THEN RAISE EXCEPTION 'ledighetspolicy 449o: the request went with the guardian who was asked'; END IF;
  IF NOT app.leave_consent_met_raw(b, school) THEN RAISE EXCEPTION 'ledighetspolicy 449o: a request nobody is left to answer has no consent'; END IF;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 474o: the row lock the two functions take on the post (20270208090000, the owner's side of section 474).
--
-- ONE WRITER OF A POST AT A TIME: the immediate function and the deferred function each take the post's row FOR NO KEY
-- UPDATE (not FOR UPDATE: the placement's own key holds KEY SHARE on the same row and the two do not conflict) before
-- they read the rows, and the deferred one before it asks whether the post has any förläggning at all, because a share's
-- DELETE holds no lock on its post and a förläggning another transaction committed meanwhile would be missing from an
-- unlocked read. A section that rolls back has no second connection to wait for the lock, so it is read where it lands:
-- xmax of the post's row, which is this transaction's id once the transaction has locked the row and zero while nothing has.
-- That reading is only clean if nothing else in the transaction locked the row, and the foreign keys do (a KEY SHARE on
-- the post for every row that names it), so the owner plants the rows with session_replication_role = replica (no
-- key checks, no triggers: the rows are as a writer's COMMIT left them) and sets it back to origin before the statement
-- under test. Owner-only, as every block of this file (the role is a superuser in the suite's database). The lock's mode
-- is read with pgrowlocks where the database has it (the extension is created inside the transaction and goes with it):
-- "For No Key Update", never "For Update", which the placement's key would wait for.
--   post P1  two rows (nobody's, the post shares nothing): one row DELETEd, which only the immediate function sees;
--   post P2  a share and a row: the share DELETEd, which only the deferred function sees, when the rules are asked for;
--   post P3  a share and no row at all: the deferred function takes the lock before it finds that there is nothing to fit.
-- ---------------------------------------------------------------------------

BEGIN;
DO $$
DECLARE
  school constant uuid := gen_random_uuid();
  room constant uuid := gen_random_uuid();
  teacher constant uuid := gen_random_uuid();
  other constant uuid := gen_random_uuid();
  p1 constant uuid := gen_random_uuid();
  p2 constant uuid := gen_random_uuid();
  p3 constant uuid := gen_random_uuid();
  mine constant xid := pg_current_xact_id()::xid;
  modes text;
  have_rowlocks boolean := EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pgrowlocks');
BEGIN
  IF have_rowlocks THEN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS pgrowlocks';
  END IF;
  PERFORM set_config('session_replication_role', 'replica', true);
  INSERT INTO "TeachingRequirements" (id, "schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "minutesPerLesson", "updatedAt")
  SELECT x, school, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), teacher, 3, 60, now() FROM unnest(ARRAY[p1, p2, p3]) x;
  INSERT INTO "TeachingRequirementShares" ("schoolId", "requirementId", "teacherId", lessons, minutes, "updatedAt")
  SELECT school, x, other, 1, 60, now() FROM unnest(ARRAY[p2, p3]) x;
  INSERT INTO "TeachingRequirementPlacements" ("schoolId", "requirementId", "dayOfWeek", "startTime", minutes, "roomId", recurrence, "teacherId", "updatedAt")
  VALUES (school, p1, 1, '08:00', 60, room, 'ALL_WEEKS', NULL, now()), (school, p1, 2, '08:00', 60, room, 'ALL_WEEKS', NULL, now()),
         (school, p2, 1, '08:00', 60, room, 'ALL_WEEKS', NULL, now());
  PERFORM set_config('session_replication_role', 'origin', true);
  IF current_setting('session_replication_role') <> 'origin' THEN RAISE EXCEPTION 'delade 474o: the role did not go back to origin'; END IF;

  -- Nothing has locked any of the three yet.
  IF (SELECT count(*) FROM "TeachingRequirements" WHERE id IN (p1, p2, p3) AND xmax::text = '0') <> 3 THEN
    RAISE EXCEPTION 'delade 474o: planting with the keys off left a lock on a post (the reading below would prove nothing)';
  END IF;

  -- The immediate function: a row of P1 removed, and only P1 is locked.
  DELETE FROM "TeachingRequirementPlacements" WHERE "requirementId" = p1 AND "dayOfWeek" = 2;
  IF (SELECT xmax FROM "TeachingRequirements" WHERE id = p1) IS DISTINCT FROM mine THEN
    RAISE EXCEPTION 'delade 474o: the immediate function did not lock the post it judged (xmax %, this transaction %)', (SELECT xmax FROM "TeachingRequirements" WHERE id = p1), mine;
  END IF;
  IF (SELECT count(*) FROM "TeachingRequirements" WHERE id IN (p2, p3) AND xmax::text = '0') <> 2 THEN
    RAISE EXCEPTION 'delade 474o: the immediate function locked a post it was not asked about';
  END IF;

  -- The deferred function: a share's DELETE holds no lock on its post by itself, and the rules asked for take it.
  DELETE FROM "TeachingRequirementShares" WHERE "requirementId" = p2;
  IF (SELECT xmax::text FROM "TeachingRequirements" WHERE id = p2) <> '0' THEN
    RAISE EXCEPTION 'delade 474o: a share''s DELETE locked its post by itself, before the rules were asked for';
  END IF;
  SET CONSTRAINTS "TeachingRequirementShares_placement_teachers_fit" IMMEDIATE;
  IF (SELECT xmax FROM "TeachingRequirements" WHERE id = p2) IS DISTINCT FROM mine THEN
    RAISE EXCEPTION 'delade 474o: the deferred function did not lock the post it judged (xmax %, this transaction %)', (SELECT xmax FROM "TeachingRequirements" WHERE id = p2), mine;
  END IF;
  -- A post with no förläggning at all: the lock comes before the question of whether there is anything to fit.
  IF (SELECT xmax::text FROM "TeachingRequirements" WHERE id = p3) <> '0' THEN
    RAISE EXCEPTION 'delade 474o: P3 was locked before its share was removed';
  END IF;
  SET CONSTRAINTS "TeachingRequirementShares_placement_teachers_fit" DEFERRED;
  DELETE FROM "TeachingRequirementShares" WHERE "requirementId" = p3;
  SET CONSTRAINTS "TeachingRequirementShares_placement_teachers_fit" IMMEDIATE;
  IF (SELECT xmax FROM "TeachingRequirements" WHERE id = p3) IS DISTINCT FROM mine THEN
    RAISE EXCEPTION 'delade 474o: the deferred function did not lock a post with no förläggning before finding that there is nothing to fit';
  END IF;

  -- The mode, where pgrowlocks is available: FOR NO KEY UPDATE on all three.
  IF have_rowlocks THEN
    SELECT string_agg(DISTINCT m, ',') INTO modes
      FROM pgrowlocks('"TeachingRequirements"') r, unnest(r.modes) m WHERE r.locker = mine::text::xid;
    IF modes IS DISTINCT FROM 'For No Key Update' THEN
      RAISE EXCEPTION 'delade 474o: the post rows are locked in mode "%", not "For No Key Update" (FOR UPDATE would wait for the placements'' own key)', modes;
    END IF;
  END IF;
END $$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Section 474o (second part): a removal is judged for its teacher's pairs of its length, and for nothing else.
--
-- A row removed can break nothing but the pairing of its own teacher's rows of its own length, and must not be refused for another
-- row that did not fit before it (a state the owner can leave, or an older writer: the rows below are planted with the keys and
-- triggers off, as a COMMIT left them). A section that goes through the API's role cannot show it: every state it makes is judged
-- as a whole by the events of the statements that made it. Three posts, each with a row that does not fit and one that is removed:
--   P4  a post that shares nothing, a row naming a teacher (TEACHER) and a row naming nobody, which is removed;
--   P5  a post of A's lessons of 60 and 40 and Z's of 60, A's lone odd row of 60 (not a pair) and A's row of 40, which is removed.
-- Each removal passes the rules asked for. (The immediate function judges a removal for the pairs of the removed row's length across
-- the whole post, as 20270207090000 does, so a row of the same length that does not pair is its refusal and not this one's; the
-- removal the deferred function alone refuses, A's odd row and B's even row together, is section 471's.)
-- ---------------------------------------------------------------------------

BEGIN;
DO $$
DECLARE
  school constant uuid := gen_random_uuid();
  room constant uuid := gen_random_uuid();
  a constant uuid := gen_random_uuid();
  z constant uuid := gen_random_uuid();
  p4 constant uuid := gen_random_uuid();
  p5 constant uuid := gen_random_uuid();
BEGIN
  PERFORM set_config('session_replication_role', 'replica', true);
  INSERT INTO "TeachingRequirements" (id, "schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "minutesPerLesson", "lessonLengths", "updatedAt") VALUES
    (p4, school, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), a, 3, 60, '{}', now()),
    (p5, school, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), a, 3, 60, '{60,60,40}', now());
  INSERT INTO "TeachingRequirementShares" ("schoolId", "requirementId", "teacherId", lessons, minutes, "updatedAt") VALUES (school, p5, z, 1, 60, now());
  INSERT INTO "TeachingRequirementPlacements" (id, "schoolId", "requirementId", "dayOfWeek", "startTime", minutes, "roomId", recurrence, "teacherId", "updatedAt") VALUES
    ('00000000-0000-4000-8000-0000000d4041', school, p4, 1, '08:00', 60, room, 'ALL_WEEKS', z, now()),
    ('00000000-0000-4000-8000-0000000d4042', school, p4, 2, '08:00', 60, room, 'ALL_WEEKS', NULL, now()),
    ('00000000-0000-4000-8000-0000000d4051', school, p5, 1, '08:00', 60, room, 'ODD_WEEKS', a, now()),
    ('00000000-0000-4000-8000-0000000d4052', school, p5, 2, '08:00', 40, room, 'ALL_WEEKS', a, now());
  PERFORM set_config('session_replication_role', 'origin', true);

  -- The rows that do not fit are judged when a row of theirs is written; a removal of another row is not refused for them.
  -- P4's removed row names nobody and P5's is a row of 40: neither is a half of anything.
  DELETE FROM "TeachingRequirementPlacements" WHERE id = '00000000-0000-4000-8000-0000000d4042';
  SET CONSTRAINTS "TeachingRequirementPlacements_teachers_fit" IMMEDIATE;
  SET CONSTRAINTS "TeachingRequirementPlacements_teachers_fit" DEFERRED;
  DELETE FROM "TeachingRequirementPlacements" WHERE id = '00000000-0000-4000-8000-0000000d4052';
  SET CONSTRAINTS "TeachingRequirementPlacements_teachers_fit" IMMEDIATE;
  SET CONSTRAINTS "TeachingRequirementPlacements_teachers_fit" DEFERRED;
  IF (SELECT count(*) FROM "TeachingRequirementPlacements" WHERE "requirementId" IN (p4, p5)) <> 2 THEN
    RAISE EXCEPTION 'delade 474o: the removals did not leave the two rows that do not fit';
  END IF;
END $$;
ROLLBACK;
