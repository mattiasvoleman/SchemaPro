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

  -- A teacher of another school stands on a lesson of this one (the key to the teacher is a single column):
  -- the lesson is not theirs to report here, and the night does not stop for it.
  INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role) VALUES (school, l, t_other, 'ASSISTANT');
  PERFORM pg_temp.rgo_expect('346o a stranger', (SELECT string_agg(teacher_id::text, ',' ORDER BY teacher_id) FROM app.reporting_lessons(school, '2026-09-15', '2026-09-15', now())), t1::text);
  PERFORM app.reporting_compute(school, '2026-09-30');
  IF EXISTS (SELECT 1 FROM "TeacherReportingDays" WHERE "teacherId" = t_other AND "schoolId" = school) THEN
    RAISE EXCEPTION 'rapporteringsgrad 346o: a teacher of another school has a day here';
  END IF;
  PERFORM pg_temp.rgo_expect('346o the days beside a stranger', (SELECT string_agg(day || ' ' || reported || '/' || held, ', ') FROM "TeacherReportingDays" WHERE "schoolId" = school), '2026-09-15 0/1');

  -- A row that puts a teacher of this school on the lesson under another school's id (the key to the lesson is a
  -- single column, so the database takes it): the lesson's own school decides, and the row is no one's here.
  INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role) VALUES (other, l, t2, 'ASSISTANT');
  PERFORM pg_temp.rgo_expect('346o a row of another school', (SELECT string_agg(teacher_id::text, ',' ORDER BY teacher_id) FROM app.reporting_lessons(school, '2026-09-15', '2026-09-15', now())), t1::text);
  DELETE FROM "CalendarLessonTeachers" WHERE "calendarLessonId" = l AND "schoolId" = other;

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

-- 373o: the reminder. Which guardians, how many, and never twice. A request is made due by moving
-- its time, which no role may do.
BEGIN;
DO $$
DECLARE
  school uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-kvittens-school');
  other uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-kvittens-annan');
  full_ uuid := pg_temp.kvo_user('kv-full');
  q1 uuid; q2 uuid; q3 uuid; q4 uuid; q5 uuid; q6 uuid; q7 uuid;
  told text;
  n integer;
BEGIN
  INSERT INTO "AckSettings" ("schoolId", enabled, "remindAfterDays") VALUES (school, true, 2), (other, true, 2)
    ON CONFLICT ("schoolId") DO UPDATE SET enabled = true, "remindAfterDays" = 2;
  -- Q1  ALL, P1 asks G1 and G2, P2 asks G1: due, nobody has confirmed.
  q1 := pg_temp.kvo_request(school, full_, 'Q1', 'ALL', 'p1:g1,p1:g2,p2:g1');
  -- Q2  ANY, P1 asks G1 and G2: due, G1 has confirmed, so the pupil is met and G2 is not asked again.
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
  UPDATE "AckRequests" SET "remindAt" = now() - interval '1 hour' WHERE id IN (q1, q2, q3, q6, q7);
  UPDATE "AckRequests" SET "remindAt" = now() - interval '40 days' WHERE id = q5;

  -- The pass: Q1 tells G1 once (two children) and G2; Q3 tells G1; Q7 tells the other school's guardian.
  SELECT string_agg(r.title || ' ' || substr(u.email, 4, 3) || ' ' || (r.school_id = a."schoolId")::text || ' ' || (r.email = u.email)::text,
                    ', ' ORDER BY r.title, u.email)
    INTO told
    FROM (SELECT d.notification_id, d.user_id, d.school_id, d.email, d.meta ->> 'title' AS title FROM app.ack_remind_due() d) r
    JOIN "Users" u ON u.id = r.user_id
    JOIN "AckRequests" a ON a.title = r.title AND a."schoolId" = r.school_id;
  PERFORM pg_temp.kvo_expect('373o who is reminded', told, 'Q1 g1@ true true, Q1 g2@ true true, Q3 g1@ true true, Q7 ann true true');
  PERFORM pg_temp.kvo_expect('373o the notices written',
    (SELECT string_agg(n.type::text || ' ' || (n.meta ->> 'title'), ', ' ORDER BY n.meta ->> 'title', n."userId"::text) FROM "Notifications" n WHERE n.type = 'ACK_REMINDER'),
    'ACK_REMINDER Q1, ACK_REMINDER Q1, ACK_REMINDER Q3, ACK_REMINDER Q7');

  -- Receipts marked: all of Q1's, only G1's of Q3, none of Q2 (met), Q6 (nobody can), Q4 and Q5.
  PERFORM pg_temp.kvo_expect('373o receipts reminded',
    (SELECT string_agg(q.title || ':' || (SELECT count(*) FROM "AckReceipts" r WHERE r."requestId" = q.id AND r."remindedAt" IS NOT NULL), ' ' ORDER BY q.title)
       FROM "AckRequests" q WHERE q.id IN (q1, q2, q3, q4, q5, q6, q7)),
    'Q1:3 Q2:0 Q3:1 Q4:0 Q5:0 Q6:0 Q7:1');
  -- The pass is done for every request it looked at, and not for the one that is not due.
  PERFORM pg_temp.kvo_expect('373o requests passed',
    (SELECT string_agg(q.title || ':' || (q."reminderSentAt" IS NOT NULL)::text, ' ' ORDER BY q.title) FROM "AckRequests" q WHERE q.id IN (q1, q2, q3, q4, q5, q6, q7)),
    'Q1:true Q2:true Q3:true Q4:false Q5:true Q6:true Q7:true');
  -- Never twice.
  SELECT count(*) INTO n FROM app.ack_remind_due();
  IF n <> 0 THEN RAISE EXCEPTION 'kvittens 373o: a second pass reminded % guardians', n; END IF;
  -- Even a request opened for a new pass (which no role may do) asks nobody twice: the receipt remembers.
  UPDATE "AckRequests" SET "reminderSentAt" = NULL WHERE id IN (q1, q3);
  SELECT count(*) INTO n FROM app.ack_remind_due();
  IF n <> 0 THEN RAISE EXCEPTION 'kvittens 373o: a request opened again reminded % guardians who had been reminded', n; END IF;
  -- Q4 comes due: it is told then, and only then.
  UPDATE "AckRequests" SET "remindAt" = now() - interval '1 minute' WHERE id = q4;
  SELECT count(*) INTO n FROM app.ack_remind_due();
  IF n <> 1 THEN RAISE EXCEPTION 'kvittens 373o: Q4 reminded % guardians when it came due', n; END IF;
  -- A school with no reminder (NULL days) gets a request with no time and is never told.
  UPDATE "AckSettings" SET "remindAfterDays" = NULL WHERE "schoolId" = school;
  q4 := pg_temp.kvo_request(school, full_, 'Q8', 'ANY', 'p3:g3');
  IF (SELECT "remindAt" FROM "AckRequests" WHERE id = q4) IS NOT NULL THEN RAISE EXCEPTION 'kvittens 373o: a school with no reminder gave a request a time'; END IF;
  SELECT count(*) INTO n FROM app.ack_remind_due();
  IF n <> 0 THEN RAISE EXCEPTION 'kvittens 373o: a request with no reminder time was reminded'; END IF;
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
