-- En administratör som undervisar, del 3 (20270216090000): the snapshot that shows NOTHING ELSE CHANGED.
--
-- Run as the API's role (app_authenticated) on a database that has the fixtures of rls-fixtures.sql, once on the schema of main and
-- once on the branch's, by scripts/test/teaches-arms-snapshot.sh, and the two outputs are compared line by line. One line per
-- principal x mark x database role x table x verb:
--   * the principals are the armar school's (…5001–5006 administrators, …5010/5011 teachers, …5020 a pupil) and the matrix school's
--     (every profile, a teacher, a pupil, a guardian); the five who can be marked are run twice, unmarked and marked (the mark
--     is written by rektor inside the transaction, which is rolled back at the end);
--   * the database roles are the API's ('app_authenticated') and PostgREST's ('authenticated');
--   * the tables are every table of the public schema that has row security;
--   * the verbs are a read (the rows counted) and, as section 116 does, an INSERT of a copy of a row, an UPDATE that writes a column
--     as it is, and a DELETE, each on a row picked inside the principal's own school, twice: the first row (by ctid) and, where the
--     table names a person (userId, teacherId, absentTeacherId, authorId, studentId, guardianId), the first row that is the
--     principal's own. Each runs in a subtransaction that is undone, and ends as 'ok N' (rows touched) or the SQLSTATE it met.
-- The difference between the two outputs may be only the marked principals, on the tables of the 16 converted arms (and the log of
-- the mark itself, UserRoleChanges, which five marks write five rows to). Anything else is a change nobody meant.

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
    ['armar-rektor',   '00000000-0000-4000-8000-000000005001', 'y'],
    ['armar-full',     '00000000-0000-4000-8000-000000005002', 'y'],
    ['armar-schema',   '00000000-0000-4000-8000-000000005003', 'y'],
    ['armar-exp',      '00000000-0000-4000-8000-000000005004', 'y'],
    ['armar-schemahr', '00000000-0000-4000-8000-000000005005', 'y'],
    ['armar-lasare',   '00000000-0000-4000-8000-000000005006', 'n'],
    ['armar-t1',       '00000000-0000-4000-8000-000000005010', 'n'],
    ['armar-t2',       '00000000-0000-4000-8000-000000005011', 'n'],
    ['armar-pupil',    '00000000-0000-4000-8000-000000005020', 'n'],
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
BEGIN
  SELECT array_agg(c.relname::text ORDER BY c.relname COLLATE "C") INTO tbls
    FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND c.relrowsecurity;
  FOREACH pass IN ARRAY ARRAY['unmarked', 'marked'] LOOP
    IF pass = 'marked' THEN
      PERFORM pg_temp.sn_claim('00000000-0000-4000-8000-000000005001');
      FOR n IN 1 .. 5 LOOP
        IF pg_temp.sn_try('app_authenticated', format($q$UPDATE "Users" SET teaches = true WHERE "authId" = %L$q$, principals[n][2])) <> 'ok 1' THEN
          RAISE EXCEPTION 'snapshot: could not mark %', principals[n][1];
        END IF;
      END LOOP;
    END IF;
    FOR p IN 1 .. array_length(principals, 1) LOOP
      CONTINUE WHEN pass = 'marked' AND principals[p][3] <> 'y';
      PERFORM pg_temp.sn_claim(principals[p][2]);
      me := app.current_user_id();
      school := app.current_school_id();
      IF me IS NULL OR school IS NULL THEN RAISE EXCEPTION 'snapshot: % does not resolve (fixtures?)', principals[p][1]; END IF;
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
    END LOOP;
  END LOOP;
END $$;
SELECT k || ' = ' || v FROM sn_out ORDER BY k COLLATE "C";
ROLLBACK;
