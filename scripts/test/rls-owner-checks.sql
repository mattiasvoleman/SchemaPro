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
