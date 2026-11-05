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
