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
-- refused by its constraint (23P01). Then the roller school leaves H: its
-- loans and the travel to school A stay, unread (section 279a).
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
