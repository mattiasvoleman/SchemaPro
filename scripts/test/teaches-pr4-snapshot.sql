-- En administratör som undervisar, del 4 (20270219090000): the snapshot that shows NOTHING ELSE CHANGED.
--
-- Run as the API's role (app_authenticated) on a database that has the fixtures of rls-fixtures.sql, once on the schema of main and
-- once on the branch's, by scripts/test/teaches-pr4-snapshot.sh, and the two outputs are compared line by line. One line per
-- principal x mark x database role x table x verb, as the snapshot of 20270216090000 does it, and then, per principal and mark, what
-- the five definer functions the API's role may call (and the teacher's reporting list) answer, so that the difference that the
-- mark is meant to make is in the output, and the run shows it:
--   * the principals are the larm school's (…6001–6004 the four administrators who can be marked, …6006 a läsare, …6010–6012
--     teachers, …6021 a pupil) and the matrix school's (every profile, a teacher, a pupil, a guardian); the four who can be marked
--     are run twice, unmarked and marked (rektor writes the mark inside the transaction, which is rolled back at the end);
--   * an alarm is planted first, by the full administratör, the way the gateway does it (an exercise and a real alarm, groups, their
--     teachers and pupils, and one mark), so that CrisisReports has a row to copy and a group to answer for;
--   * the database roles are the API's ('app_authenticated') and PostgREST's ('authenticated');
--   * the tables are every table of the public schema that has row security; the verbs are a read (the rows counted) and an INSERT
--     of a copy of a row, an UPDATE that writes a column as it is and a DELETE, as section 116 does.
-- The difference between the two outputs may be only the marked principals on CrisisReports (the three insert arms) and the
-- function lines (the mentor, the lessons of the reporting rate), and the log of the mark itself (UserRoleChanges).

CREATE TEMP TABLE sn_out (k text, v text);

CREATE FUNCTION pg_temp.sn_claim(auth text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', auth)::text, true);
END $f$;

CREATE FUNCTION pg_temp.sn_try(via text, stmt text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n bigint;
BEGIN
  IF via <> 'app_authenticated' THEN EXECUTE format('SET LOCAL ROLE %I', via); END IF;
  BEGIN
    EXECUTE stmt;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE EXCEPTION USING ERRCODE = 'ZSN01', MESSAGE = 'ok ' || n;
  EXCEPTION WHEN SQLSTATE 'ZSN01' THEN
    GET STACKED DIAGNOSTICS stmt = MESSAGE_TEXT;
    RESET ROLE;
    RETURN stmt;
  WHEN OTHERS THEN
    RESET ROLE;
    RETURN SQLSTATE;
  END;
END $f$;

CREATE FUNCTION pg_temp.sn_val(via text, q text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v text;
BEGIN
  IF via <> 'app_authenticated' THEN EXECUTE format('SET LOCAL ROLE %I', via); END IF;
  EXECUTE q INTO v;
  RESET ROLE;
  RETURN v;
EXCEPTION WHEN OTHERS THEN
  RETURN 'E:' || SQLSTATE;
END $f$;

BEGIN;
DO $$
DECLARE
  principals constant text[][] := ARRAY[
    ['larm-rektor',    '00000000-0000-4000-8000-000000006001', 'y'],
    ['larm-full',      '00000000-0000-4000-8000-000000006002', 'y'],
    ['larm-schema',    '00000000-0000-4000-8000-000000006003', 'y'],
    ['larm-exp',       '00000000-0000-4000-8000-000000006004', 'y'],
    ['larm-lasare',    '00000000-0000-4000-8000-000000006006', 'n'],
    ['larm-t1',        '00000000-0000-4000-8000-000000006010', 'n'],
    ['larm-t2',        '00000000-0000-4000-8000-000000006011', 'n'],
    ['larm-t3',        '00000000-0000-4000-8000-000000006012', 'n'],
    ['larm-pupil',     '00000000-0000-4000-8000-000000006021', 'n'],
    ['roller-full',    '00000000-0000-4000-8000-000000000105', 'n'],
    ['roller-rektor',  '00000000-0000-4000-8000-000000000106', 'n'],
    ['roller-schema',  '00000000-0000-4000-8000-000000000107', 'n'],
    ['roller-exp',     '00000000-0000-4000-8000-000000000108', 'n'],
    ['roller-schemahr','00000000-0000-4000-8000-000000000109', 'n'],
    ['roller-exphr',   '00000000-0000-4000-8000-000000000110', 'n'],
    ['roller-teacher', '00000000-0000-4000-8000-000000000111', 'n'],
    ['roller-pupil',   '00000000-0000-4000-8000-000000000112', 'n'],
    ['roller-guardian','00000000-0000-4000-8000-000000000113', 'n'],
    ['roller-lasare',  '00000000-0000-4000-8000-000000000115', 'n'],
    ['roller-lasarehr','00000000-0000-4000-8000-000000000116', 'n']];
  person_cols constant text[] := ARRAY['userId', 'teacherId', 'absentTeacherId', 'authorId', 'studentId', 'guardianId'];
  pass text;
  p int;
  via text;
  t text;
  tbls text[];
  me uuid;
  school uuid;
  ins_cols text;
  upd_col text;
  own_col text;
  pick text;
  picks text[];
  pk text;
  n int;
  s uuid; d uuid; l uuid; cd uuid; c1 uuid; c2 uuid; cn uuid;
  pa1 uuid; pa2 uuid; pb1 uuid; pc1 uuid; pd1 uuid; t1 uuid; t2 uuid; adm uuid[]; who uuid;
  req uuid; req_school uuid; req_student uuid; req_from date; req_to date;
BEGIN
  -- The alarm, planted by the full administratör of the larm school (rolled back with everything else).
  PERFORM pg_temp.sn_claim('00000000-0000-4000-8000-000000006002');
  s := app.current_school_id();
  IF s IS NULL THEN RAISE EXCEPTION 'snapshot: the larm school does not resolve (fixtures?)'; END IF;
  pa1 := (SELECT id FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000006021'); pa2 := (SELECT id FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000006022');
  pb1 := (SELECT id FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000006023'); pc1 := (SELECT id FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000006024');
  pd1 := (SELECT id FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000006025');
  t1 := (SELECT id FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000006010'); t2 := (SELECT id FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000006011');
  adm := ARRAY(SELECT id FROM "Users" WHERE "authId" IN ('00000000-0000-4000-8000-000000006001', '00000000-0000-4000-8000-000000006002', '00000000-0000-4000-8000-000000006003', '00000000-0000-4000-8000-000000006004') ORDER BY "authId");
  INSERT INTO "CrisisAlarms" ("schoolId", kind, mode) VALUES (s, 'LOCKDOWN', 'DRILL') RETURNING id INTO d;
  INSERT INTO "CrisisAlarms" ("schoolId", kind, mode) VALUES (s, 'EVACUATION', 'LIVE') RETURNING id INTO l;
  INSERT INTO "CrisisCalls" ("schoolId", "alarmId", basis, "groupName", "subjectName", "lessonStartsAt", "lessonEndsAt")
  VALUES (s, d, 'LESSON', 'Larm övning', 'Matematik', now() - interval '30 minutes', now() + interval '30 minutes') RETURNING id INTO cd;
  INSERT INTO "CrisisCalls" ("schoolId", "alarmId", basis, "groupName", "subjectName", "lessonStartsAt", "lessonEndsAt")
  VALUES (s, l, 'LESSON', 'LA7A', 'Matematik', now() - interval '30 minutes', now() + interval '30 minutes') RETURNING id INTO c1;
  INSERT INTO "CrisisCalls" ("schoolId", "alarmId", basis, "groupName", "subjectName", "lessonStartsAt", "lessonEndsAt")
  VALUES (s, l, 'NEXT_LESSON', 'LA7B', 'Svenska', now() + interval '10 minutes', now() + interval '60 minutes') RETURNING id INTO c2;
  INSERT INTO "CrisisCalls" ("schoolId", "alarmId", basis, "groupName", "subjectName", "lessonStartsAt", "lessonEndsAt")
  VALUES (s, l, 'NO_LESSON', 'Ej i lektion just nu', 'Ingen lektion pågår', now(), now()) RETURNING id INTO cn;
  INSERT INTO "CrisisCallTeachers" ("schoolId", "callId", "teacherId", role) VALUES (s, cd, t1, 'LEAD'), (s, c1, t1, 'LEAD'), (s, c2, t2, 'LEAD');
  FOREACH who IN ARRAY adm LOOP
    INSERT INTO "CrisisCallTeachers" ("schoolId", "callId", "teacherId", role) VALUES (s, c1, who, 'ASSISTANT');
  END LOOP;
  INSERT INTO "CrisisPupils" ("schoolId", "alarmId", "callId", "studentId")
  VALUES (s, d, cd, pa1), (s, d, cd, pa2), (s, d, cd, pb1), (s, d, cd, pc1), (s, d, cd, pd1),
         (s, l, c1, pa1), (s, l, c1, pa2), (s, l, c2, pb1), (s, l, cn, pc1), (s, l, cn, pd1);
  UPDATE "CrisisAlarms" SET "listsSealedAt" = now() WHERE id IN (d, l);
  INSERT INTO "CrisisReports" (id, "schoolId", "alarmId", "callId", "studentId", state, at) VALUES (gen_random_uuid(), s, l, c1, pa1, 'FOUND', now());
  SELECT r.id, r."schoolId", r."studentId", r."startDate", r."endDate" INTO req, req_school, req_student, req_from, req_to FROM "LeaveRequests" r WHERE r.reason = 'Larm ledighet A';
  IF req IS NULL THEN RAISE EXCEPTION 'snapshot: the larm school''s pending leave request is not there (fixtures?)'; END IF;
  SELECT array_agg(c.relname::text ORDER BY c.relname COLLATE "C") INTO tbls
    FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND c.relrowsecurity;
  FOREACH pass IN ARRAY ARRAY['unmarked', 'marked'] LOOP
    IF pass = 'marked' THEN
      -- Rektor marks the four (each has a post from the fixtures). Written here and not through sn_try, which undoes what it runs.
      PERFORM pg_temp.sn_claim('00000000-0000-4000-8000-000000006001');
      FOR n IN 1 .. 4 LOOP
        UPDATE "Users" SET teaches = true WHERE "authId" = principals[n][2]::uuid;
        IF NOT FOUND THEN RAISE EXCEPTION 'snapshot: could not mark %', principals[n][1]; END IF;
      END LOOP;
    END IF;
    FOR p IN 1 .. array_length(principals, 1) LOOP
      CONTINUE WHEN pass = 'marked' AND principals[p][3] <> 'y';
      PERFORM pg_temp.sn_claim(principals[p][2]);
      me := app.current_user_id();
      school := app.current_school_id();
      IF me IS NULL OR school IS NULL THEN RAISE EXCEPTION 'snapshot: % does not resolve (fixtures?)', principals[p][1]; END IF;
      -- The mark is what it is said to be: the four who can be marked are, in the second pass, and nobody is in the first.
      IF app.current_user_teaches() IS DISTINCT FROM (pass = 'marked') THEN
        RAISE EXCEPTION 'snapshot: % is % in the % pass', principals[p][1], CASE WHEN app.current_user_teaches() THEN 'marked' ELSE 'not marked' END, pass;
      END IF;
      FOREACH via IN ARRAY ARRAY['app_authenticated', 'authenticated'] LOOP
        FOREACH t IN ARRAY tbls LOOP
          INSERT INTO sn_out VALUES (format('%s|%s|%s|%s|read', principals[p][1], pass, via, t),
            CASE WHEN has_table_privilege(via, format('public.%I', t), 'SELECT') THEN pg_temp.sn_val(via, format('SELECT count(*) FROM %I', t)) ELSE 'no privilege' END);
          -- The writes need a row of the principal's own school to pick, and a column that says which school it is.
          IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = format('public.%I', t)::regclass AND attname = 'schoolId' AND NOT attisdropped) THEN
            CONTINUE;
          END IF;
          SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO ins_cols
            FROM pg_attribute a WHERE a.attrelid = format('public.%I', t)::regclass AND a.attnum > 0 AND NOT a.attisdropped
             AND has_column_privilege(via, format('public.%I', t), a.attname, 'INSERT');
          SELECT quote_ident(a.attname) INTO upd_col
            FROM pg_attribute a WHERE a.attrelid = format('public.%I', t)::regclass AND a.attnum > 0 AND NOT a.attisdropped
             AND has_column_privilege(via, format('public.%I', t), a.attname, 'UPDATE') ORDER BY (a.attname = 'schoolId') DESC, a.attnum LIMIT 1;
          SELECT a.attname INTO own_col FROM pg_attribute a
           WHERE a.attrelid = format('public.%I', t)::regclass AND a.attname = ANY (person_cols) AND NOT a.attisdropped
           ORDER BY array_position(person_cols, a.attname::text) LIMIT 1;
          picks := ARRAY[format('(SELECT ctid FROM %I WHERE "schoolId" = %L LIMIT 1)', t, school)];
          IF own_col IS NOT NULL THEN
            picks := picks || format('(SELECT ctid FROM %I WHERE %I = %L AND "schoolId" = %L LIMIT 1)', t, own_col, me, school);
          END IF;
          FOR n IN 1 .. array_length(picks, 1) LOOP
            pk := CASE n WHEN 1 THEN 'first' ELSE 'own' END;
            INSERT INTO sn_out VALUES (format('%s|%s|%s|%s|insert|%s', principals[p][1], pass, via, t, pk),
              CASE WHEN ins_cols IS NULL THEN 'denied'
                   ELSE pg_temp.sn_try(via, format('INSERT INTO %I (%s) SELECT %s FROM %I WHERE ctid = %s', t, ins_cols, ins_cols, t, picks[n])) END);
            INSERT INTO sn_out VALUES (format('%s|%s|%s|%s|update|%s', principals[p][1], pass, via, t, pk),
              CASE WHEN upd_col IS NULL THEN 'denied'
                   ELSE pg_temp.sn_try(via, format('UPDATE %I SET %s = %s WHERE ctid = %s', t, upd_col, upd_col, picks[n])) END);
            INSERT INTO sn_out VALUES (format('%s|%s|%s|%s|delete|%s', principals[p][1], pass, via, t, pk),
              pg_temp.sn_try(via, format('DELETE FROM %I WHERE ctid = %s', t, picks[n])));
          END LOOP;
        END LOOP;
      END LOOP;
      -- What the five definer functions and the teacher's reporting list answer for this person (the difference the mark is meant to make).
      INSERT INTO sn_out VALUES (format('%s|%s|app_authenticated|FN:leave_mine_to_decide|call', principals[p][1], pass), pg_temp.sn_val('app_authenticated', format('SELECT app.leave_mine_to_decide(%L, %L, %L, %L)::text', req_school, req_student, req_from, req_to)));
      INSERT INTO sn_out VALUES (format('%s|%s|app_authenticated|FN:leave_request_taken|call', principals[p][1], pass), pg_temp.sn_val('app_authenticated', format('SELECT app.leave_request_taken(%L)::text', req)));
      INSERT INTO sn_out VALUES (format('%s|%s|app_authenticated|FN:absence_watch_is_mentor_of|call', principals[p][1], pass), pg_temp.sn_val('app_authenticated', format('SELECT app.absence_watch_is_mentor_of(%L)::text', req_student)));
      INSERT INTO sn_out VALUES (format('%s|%s|app_authenticated|FN:ack_mentee_ids|call', principals[p][1], pass), pg_temp.sn_val('app_authenticated', 'SELECT cardinality(app.ack_mentee_ids())::text'));
      INSERT INTO sn_out VALUES (format('%s|%s|app_authenticated|FN:lesson_move_is_mentor|call', principals[p][1], pass), pg_temp.sn_val('app_authenticated', format('SELECT app.lesson_move_is_mentor(%L, current_date)::text', req_student)));
      INSERT INTO sn_out VALUES (format('%s|%s|app_authenticated|FN:reporting_open_lessons|call', principals[p][1], pass), pg_temp.sn_val('app_authenticated', 'SELECT count(*)::text FROM app.reporting_open_lessons(30)'));
    END LOOP;
  END LOOP;
END $$;
SELECT k || ' = ' || v FROM sn_out ORDER BY k COLLATE "C";
ROLLBACK;
