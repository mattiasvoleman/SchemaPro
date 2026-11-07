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
-- Kvittens, after the independent review of #277 (20270202090000), owner checks.
--
--   450o  the delivery's two doors answer nothing to any login, a person or not
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

-- 450o: app.ack_remind_request and app.ack_reminder_mirrored are the delivery's doors, and the delivery sets no claims.
-- A session with any claims gets nothing from them, and that includes a login that is no person: the huvudman's reader
-- (a läsare of the school it chose, with no Users row there, so app.current_user_id() is NULL) is the one a guard on the
-- person row let through. A subject setting alone (the older claim style, which Supabase's auth.uid() also reads) is a
-- login too. The same functions then do their work for the door, so none of this passes because they do nothing at all.
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
  -- takes the first one: SENT, and not yet marked.
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
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
  SELECT count(*) INTO n FROM app.ack_remind_request(by_reader);
  IF n <> 0 THEN RAISE EXCEPTION 'kvittens 450o: a login with no person was handed % notices to deliver', n; END IF;
  PERFORM app.ack_reminder_mirrored(waits);
  PERFORM set_config('app.chosen_school_id', '', true);

  -- A subject setting alone: no claims JSON, the older style. On this database auth.uid() does not read it, so no person
  -- resolves, which is what makes it tell a guard on the person row from a guard on any login.
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-f40000000001', true);
  SELECT count(*) INTO n FROM app.ack_remind_request(by_sub);
  IF n <> 0 THEN RAISE EXCEPTION 'kvittens 450o: a session with only a subject setting was handed % notices to deliver', n; END IF;
  PERFORM app.ack_reminder_mirrored(waits);
  PERFORM set_config('request.jwt.claim.sub', '', true);

  -- A person.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-f40000000001')::text, true);
  IF app.current_user_id() IS DISTINCT FROM full_ THEN RAISE EXCEPTION 'kvittens 450o: the person is not Full'; END IF;
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
