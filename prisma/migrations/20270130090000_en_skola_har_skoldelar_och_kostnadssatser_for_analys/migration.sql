-- En skola har skoldelar och kostnadssatser för analysen.
--
-- The stored half of Analys och planering (K1): nyckeltal per lärare och skola,
-- kostnadsunderlag per elev och löneunderlag med konton. Everything the three
-- views show is computed from rows that exist (the load report's teachers and
-- assignments, the timplansposter, the rosters, the held lessons of the
-- calendar and the substitutes' hour statement); this migration adds the two
-- things they cannot read.
--
--   * SchoolParts      a skoldel: a part of the school that is a kostnadsställe,
--                      with a name, a konto and the årskurser it holds (F–3,
--                      4–6, 7–9). Two skoldelar of a school never share an
--                      årskurs, so a class belongs to at most one.
--   * StaffCostRates   the school's cost of one hour in a personalkategori
--                      (a behörig lärare, a lärare utan behörighet, a vikarie).
--
-- Nothing here changes an existing table. Nothing reaches the engine.
--
-- ## No individual salary is stored
--
-- A rate belongs to a category, never to a person: StaffCostRates has no
-- column that names a user, a post or an employment, and the category is not
-- kept on anyone either. It is derived when the cost basis is made: an
-- assignment is TEACHER or, where the school has recorded behörigheter and
-- none of the teacher's covers it, UNQUALIFIED_TEACHER; a held cover lesson is
-- SUBSTITUTE. A figure on a screen is therefore hours × a rate the school
-- stated, which tells nobody what a colleague is paid. (BESLUT.)
--
-- ## The årskurser of a skoldel are the nine-year numbering's, for good
--
-- Like a skolenhet's span (SchoolUnits) and every other school-wide span, a
-- skoldel's gradeFrom and gradeTo are stated in NIOARIG; a tioårig läsår
-- reads them through toNioarig (src/common/grade-numbering.ts). 0 is
-- förskoleklass. The EXCLUDE constraint below is the database's own "a class
-- belongs to at most one skoldel": two concurrent writes cannot both pass a
-- check, so the service's own comparison only words the refusal.
--
-- ## Who reads and who writes
--
-- Every administrator profile reads both tables, and so does the huvudman's
-- reader (who is the school's läsare, with no row of their own). Those who
-- decide (rektor, full) make, change and remove a skoldel and a rate: the
-- konto a payroll is booked on and the cost of an hour are the school's
-- economy, which is a decision like the tjänst % of a post. A teacher, a pupil
-- and a guardian have no arm. What a reader is HANDED of the cost basis and
-- the payroll file is narrower than what the tables allow, and is the
-- gateway's (src/analysis): the per-teacher figures follow the HR rule, the
-- file is for those who read HR data.
--
-- ## Beside the live API: Schools at once, or nothing
--
-- Production runs this while the API before it serves requests. The two keys
-- (SchoolParts, StaffCostRates -> Schools) take Schools in SHARE ROW
-- EXCLUSIVE, which blocks writes to it (not reads, and not the KEY SHARE a
-- foreign-key check takes) for the length of the file; the tables are empty,
-- so the keys validate nothing. The lock is taken NOWAIT, in a loop: a
-- refusal rolls the subtransaction back and tries again 50 ms later; it never
-- waits while it holds a lock, and no request queues behind it. After 30 s it
-- stops with nothing done and can be rerun (prisma migrate resolve
-- --rolled-back, then deploy). lock_timeout bounds any wait nobody foresaw.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Schools" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Schools was not free in 30 s: nothing is changed, run the migration again (prisma migrate resolve --rolled-back 20270130090000_en_skola_har_skoldelar_och_kostnadssatser_for_analys, then deploy)';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

CREATE TYPE "StaffCostCategory" AS ENUM ('TEACHER', 'UNQUALIFIED_TEACHER', 'SUBSTITUTE');

CREATE TABLE "SchoolParts" (
    "id"        UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"  UUID NOT NULL,
    "name"      TEXT NOT NULL,
    "account"   TEXT NOT NULL,
    "gradeFrom" INTEGER NOT NULL,
    "gradeTo"   INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "SchoolParts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SchoolParts_name_check"
        CHECK (char_length(btrim("name")) BETWEEN 1 AND 100 AND "name" !~ '[[:cntrl:]]'),
    CONSTRAINT "SchoolParts_account_check"
        CHECK (char_length(btrim("account")) BETWEEN 1 AND 30 AND "account" !~ '[[:cntrl:]]'),
    CONSTRAINT "SchoolParts_grades_check"
        CHECK ("gradeFrom" BETWEEN 0 AND 9 AND "gradeTo" BETWEEN "gradeFrom" AND 9),
    -- The unique keys come before the exclusion on purpose: PostgreSQL checks a
    -- row against the indexes in the order they were made, so a second skoldel
    -- of the same name is refused as the name taken (23505), which the role
    -- matrix (section 116) reads as "the arm let the row through", and only a
    -- different name with a shared årskurs meets the exclusion.
    CONSTRAINT "SchoolParts_schoolId_name_key" UNIQUE ("schoolId", "name"),
    CONSTRAINT "SchoolParts_id_schoolId_key" UNIQUE ("id", "schoolId"),
    -- A class belongs to at most one skoldel of its school.
    CONSTRAINT "SchoolParts_no_shared_grade"
        EXCLUDE USING gist ("schoolId" WITH =, int4range("gradeFrom", "gradeTo" + 1) WITH &&)
);

CREATE INDEX "SchoolParts_schoolId_idx" ON "SchoolParts"("schoolId");

ALTER TABLE "SchoolParts"
    ADD CONSTRAINT "SchoolParts_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "StaffCostRates" (
    "schoolId"   UUID NOT NULL,
    "category"   "StaffCostCategory" NOT NULL,
    "hourlyCost" DECIMAL(10,2) NOT NULL,
    "createdAt"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "StaffCostRates_pkey" PRIMARY KEY ("schoolId", "category"),
    CONSTRAINT "StaffCostRates_hourlyCost_check" CHECK ("hourlyCost" BETWEEN 0 AND 100000)
);

ALTER TABLE "StaffCostRates"
    ADD CONSTRAINT "StaffCostRates_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security and grants. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "SchoolParts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StaffCostRates" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r text;
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    CREATE POLICY "school_parts_admin_select" ON "SchoolParts"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "school_parts_admin_insert" ON "SchoolParts"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_decides()));
    CREATE POLICY "school_parts_admin_update" ON "SchoolParts"
        FOR UPDATE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_decides()));
    CREATE POLICY "school_parts_admin_delete" ON "SchoolParts"
        FOR DELETE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
               AND (select app.current_user_decides()));

    CREATE POLICY "staff_cost_rates_admin_select" ON "StaffCostRates"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "staff_cost_rates_admin_insert" ON "StaffCostRates"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_decides()));
    CREATE POLICY "staff_cost_rates_admin_update" ON "StaffCostRates"
        FOR UPDATE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_decides()));
    CREATE POLICY "staff_cost_rates_admin_delete" ON "StaffCostRates"
        FOR DELETE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
               AND (select app.current_user_decides()));

    REVOKE ALL ON "SchoolParts" FROM app_authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "SchoolParts" TO app_authenticated;
    REVOKE ALL ON "StaffCostRates" FROM app_authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "StaffCostRates" TO app_authenticated;
  END IF;

  FOREACH t IN ARRAY ARRAY['SchoolParts', 'StaffCostRates'] LOOP
    FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM service_role', t);
    END IF;
    -- PostgreSQL 17's MAINTAIN (REINDEX, CLUSTER, VACUUM, LOCK): the owner's alone.
    IF current_setting('server_version_num')::int >= 170000 THEN
      FOREACH r IN ARRAY ARRAY['authenticated', 'app_authenticated', 'service_role', 'anon'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
          EXECUTE format('REVOKE MAINTAIN ON %I FROM %I', t, r);
        END IF;
      END LOOP;
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- K1_REACH: the arms above and no other. Each names the caller's school and
-- the administrator's role, has no OR and no NOT, and a write is behind the
-- decision; a name and a command alone would let `USING (true)` through.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  bad text;
  t text;
  expected text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    RETURN;
  END IF;
  FOREACH t IN ARRAY ARRAY['SchoolParts', 'StaffCostRates'] LOOP
    expected := CASE t
      WHEN 'SchoolParts' THEN ARRAY['school_parts_admin_select:SELECT', 'school_parts_admin_insert:INSERT',
                                    'school_parts_admin_update:UPDATE', 'school_parts_admin_delete:DELETE']
      ELSE ARRAY['staff_cost_rates_admin_select:SELECT', 'staff_cost_rates_admin_insert:INSERT',
                 'staff_cost_rates_admin_update:UPDATE', 'staff_cost_rates_admin_delete:DELETE']
    END;
    SELECT string_agg(p.policyname || ' ' || p.cmd || ' ' || p.roles::text, ', ' ORDER BY p.policyname) INTO bad
      FROM pg_policies p
     WHERE p.schemaname = 'public' AND p.tablename = t
       AND NOT coalesce(
             p.roles = '{app_authenticated}'::name[]
             AND p.permissive = 'PERMISSIVE'
             AND (p.policyname || ':' || p.cmd) = ANY (expected)
             AND (SELECT bool_and(
                           e LIKE '%current_school_id()%'
                           AND e NOT LIKE '% OR %'
                           AND e NOT LIKE '%NOT %'
                           AND e LIKE '%current_user_role()%= ''SCHOOL_ADMIN''::"UserRole"%')
                    FROM unnest(ARRAY[p.qual, p.with_check]) e
                   WHERE e IS NOT NULL)
             AND (p.cmd = 'SELECT' OR coalesce(p.with_check, p.qual) LIKE '%current_user_decides()%'),
           false);
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'K1_REACH: these arms reach % beyond the administrators'' read and the deciders'' write: %', t, bad;
    END IF;
    IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = t) <> 4 THEN
      RAISE EXCEPTION 'K1_REACH: % has % arms, not the four above', t,
        (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = t);
    END IF;
  END LOOP;
END
$$;
