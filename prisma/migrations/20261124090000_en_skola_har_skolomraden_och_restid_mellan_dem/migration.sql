-- En skola har skolområden, och restid mellan dem.
--
-- A school can stand on more than one campus: a högstadium in the town and
-- the F–6 building across the river, an idrottshall a bus ride away, slöjd in
-- the other school's house. A teacher who has a lesson at one site and the
-- next at the other needs the minutes in between, and so do the pupils; a
-- timetable that does not leave them passes every check SchemaPro has and
-- cannot be walked. This migration is the data of Skolområden och restid:
--
--   * Sites: a school's skolområden, by name.
--   * SiteTravelTimes: the minutes between two of them.
--   * Rooms."siteId": the site a room stands on.
--
-- What the data MEANS — the warning on a hand edit, the warning beside a
-- vikarie suggestion, the restid in a teacher's load — is the gateway's
-- (src/common/site-travel.ts). Nothing here reaches the engine, whose
-- contract does not change; Restid i generatorn will read these same rows.
--
-- ## A site is above the building, and is not the skolenhet
--
-- Room.building (20260911120000) says where a room is within a campus, for
-- the room optimisation's walks; a site is the campus. The skolenhet
-- (SchoolUnits, 20261031090000) is what Skolverket registers: one skolenhet
-- can span two sites and one site can house two skolenheter, so neither is
-- the other's column.
--
--   * name 1..60 characters, trimmed (the gateway trims; the CHECK refuses
--     what it did not), unique per school.
--   * ("id", "schoolId") unique: the target of the composite keys below.
--
-- ## The travel time is one figure per pair, the same both ways
--
-- A school says "tio minuter mellan Norra och Södra", not one figure each
-- way, and the rule it feeds is a minimum gap between two lessons: whichever
-- way the teacher goes, the gap must hold the walk. Two figures per pair
-- would double what a school types and let a typo make A→B and B→A disagree,
-- so a warning would come or go with the order two lessons fall in. Where a
-- real asymmetry exists — a bus that only loops one way — the school enters
-- the longer time, which is the safe side of a minimum. So:
--
--   * one row per pair, the lower id first (CHECK "siteAId" < "siteBId",
--     uuid order, which is the order of the lower-case text the gateway
--     compares): a second, contradicting row cannot exist;
--   * minutes 0..240. 0 is a real answer — two named parts of one campus —
--     and it is not the same as no row: no row is unknown, and the card on
--     /admin/rooms lists the pairs still missing one;
--   * ("siteAId", "schoolId") and ("siteBId", "schoolId") reference Sites
--     ("id", "schoolId"), ON DELETE CASCADE: a pair goes with either site.
--     ON UPDATE NO ACTION, as 20261113090000's: ids are never rewritten, and
--     a cascade would carry an owner's change of a site's school into rooms
--     and lessons with row security off.
--
-- Composite, for the reason every tenant reference is (20260822130000): the
-- referential check runs as the referenced table's owner with row security
-- off, so a plain id key would accept another school's site under a row
-- stamped with this school's id.
--
-- ## Rooms."siteId"
--
-- UUID NULL, ("siteId", "schoolId") -> Sites ("id", "schoolId"), ON UPDATE
-- NO ACTION, ON DELETE SET NULL ("siteId"): deleting a site leaves its rooms
-- without one, as deleting a teacher leaves a lesson without one. Null is
-- UNKNOWN, never "the same site as the lesson before": a lesson in a room
-- with no site, or in no room, is held to no travel time and charged none.
-- Room.floor's null reads the same way (a guess would charge a walk the
-- school never described). The rooms page counts the rooms without a site
-- once the school has two.
--
-- A school with no site, or with one, is the school it always was: travel is
-- only ever counted between two DIFFERENT sites with a figure between them.
--
-- The SS12000 providers emit nothing new: S1's Room has no slot for a site
-- (id, meta, displayName, seats, owner), and the Rooms trigger
-- (app.ss12000_v_rooms, 20261014130000) bumps a room's meta.modified only
-- for its name and capacity, so setting a room's site moves no version.
-- Rooms has no läsår, so the läsårsrullning carries nothing new
-- (rollover-registry.spec.ts's year-scoped models do not include it).
--
-- ## Who reads and who writes
--
-- Through the gateway only (the API role, app_authenticated); nothing for
-- authenticated or anon, and service_role keeps its SELECT and nothing more,
-- as on every table (20261016130000). Rooms keep their arms; the new column
-- is read wherever a room is.
--
--   sites_staff_select / site_travel_times_staff_select
--       the school's SCHOOL_ADMIN and TEACHER: the rooms page, the warnings
--       and the vikarie suggestions are the administrator's, and a teacher's
--       own load (Min tjänst) counts their restid from the same rows.
--   sites_admin_insert / _update / _delete, and the same on SiteTravelTimes
--       the school's SCHOOL_ADMIN who writes PLANERING
--       (app.current_user_may('PLANERING', true)), as Rooms; the update arm
--       asks it in WITH CHECK only, so a row lock for a read keeps working
--       for every administrator (RLS section 106 c). TABLE_WRITE_GATES in
--       src/auth/admin-areas.ts says the same, and RLS section 116 runs every
--       profile against both tables.
--
-- ## Beside the live API: every lock at once, or none
--
-- Production runs this while the API before it serves requests. The new
-- column and its key take Rooms in ACCESS EXCLUSIVE; the two new tables'
-- keys to Schools take Schools in SHARE ROW EXCLUSIVE (it blocks writes to a
-- school row, not reads). Requests take the two in both orders — a school's
-- settings saved and then its rooms read, a room read and then the school
-- written — so a migration that waited for one while it held the other could
-- close a cycle with either, and a waiting ACCESS EXCLUSIVE queues every
-- reader of a room behind it. So both are taken first, NOWAIT and together:
-- a refusal rolls the subtransaction back and with it whatever it got, and it
-- tries again 50 ms later. It never waits while it holds a lock, and no
-- request queues behind it. After 30 s of refusals it stops with nothing done
-- and can be rerun (prisma migrate resolve --rolled-back, then deploy).
-- lock_timeout bounds any wait nobody foresaw.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Schools" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Rooms" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Schools and Rooms were not free at once in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Sites
-- ---------------------------------------------------------------------------

CREATE TABLE "Sites" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Sites_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Sites_name_named" CHECK (
        "name" = btrim("name") AND char_length("name") BETWEEN 1 AND 60
    )
);

CREATE UNIQUE INDEX "Sites_schoolId_name_key" ON "Sites"("schoolId", "name");
CREATE UNIQUE INDEX "Sites_id_schoolId_key" ON "Sites"("id", "schoolId");

ALTER TABLE "Sites"
    ADD CONSTRAINT "Sites_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- SiteTravelTimes
-- ---------------------------------------------------------------------------

CREATE TABLE "SiteTravelTimes" (
    "schoolId" UUID NOT NULL,
    "siteAId" UUID NOT NULL,
    "siteBId" UUID NOT NULL,
    "minutes" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteTravelTimes_pkey" PRIMARY KEY ("siteAId", "siteBId"),
    CONSTRAINT "SiteTravelTimes_lower_id_first" CHECK ("siteAId" < "siteBId"),
    CONSTRAINT "SiteTravelTimes_minutes_range" CHECK ("minutes" BETWEEN 0 AND 240)
);

CREATE INDEX "SiteTravelTimes_schoolId_idx" ON "SiteTravelTimes"("schoolId");
CREATE INDEX "SiteTravelTimes_siteBId_schoolId_idx" ON "SiteTravelTimes"("siteBId", "schoolId");

ALTER TABLE "SiteTravelTimes"
    ADD CONSTRAINT "SiteTravelTimes_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SiteTravelTimes"
    ADD CONSTRAINT "SiteTravelTimes_siteAId_schoolId_fkey" FOREIGN KEY ("siteAId", "schoolId")
    REFERENCES "Sites"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "SiteTravelTimes"
    ADD CONSTRAINT "SiteTravelTimes_siteBId_schoolId_fkey" FOREIGN KEY ("siteBId", "schoolId")
    REFERENCES "Sites"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- Rooms."siteId"
-- ---------------------------------------------------------------------------

ALTER TABLE "Rooms" ADD COLUMN "siteId" UUID;

ALTER TABLE "Rooms"
    ADD CONSTRAINT "Rooms_siteId_schoolId_fkey" FOREIGN KEY ("siteId", "schoolId")
    REFERENCES "Sites"("id", "schoolId") ON UPDATE NO ACTION ON DELETE SET NULL ("siteId");

-- Every row is NULL here, so the index is built at once; the key's SET NULL
-- scans it when a site is deleted.
CREATE INDEX "Rooms_siteId_idx" ON "Rooms"("siteId");

-- ---------------------------------------------------------------------------
-- Row-level security and grants. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "Sites" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SiteTravelTimes" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t record;
  r text;
BEGIN
  FOR t IN SELECT * FROM (VALUES ('Sites', 'sites'), ('SiteTravelTimes', 'site_travel_times')) AS v(tbl, arm) LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
      EXECUTE format($p$
        CREATE POLICY %I ON %I
            FOR SELECT TO "app_authenticated"
            USING ("schoolId" = (select app.current_school_id())
                   AND (select app.current_user_role()) IN ('SCHOOL_ADMIN', 'TEACHER'))
      $p$, t.arm || '_staff_select', t.tbl);
      EXECUTE format($p$
        CREATE POLICY %I ON %I
            FOR INSERT TO "app_authenticated"
            WITH CHECK ("schoolId" = (select app.current_school_id())
                        AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                        AND (select app.current_user_may('PLANERING', true)))
      $p$, t.arm || '_admin_insert', t.tbl);
      EXECUTE format($p$
        CREATE POLICY %I ON %I
            FOR UPDATE TO "app_authenticated"
            USING ("schoolId" = (select app.current_school_id())
                   AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
            WITH CHECK ("schoolId" = (select app.current_school_id())
                        AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                        AND (select app.current_user_may('PLANERING', true)))
      $p$, t.arm || '_admin_update', t.tbl);
      EXECUTE format($p$
        CREATE POLICY %I ON %I
            FOR DELETE TO "app_authenticated"
            USING ("schoolId" = (select app.current_school_id())
                   AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                   AND (select app.current_user_may('PLANERING', true)))
      $p$, t.arm || '_admin_delete', t.tbl);
      EXECUTE format('REVOKE ALL ON %I FROM "app_authenticated"', t.tbl);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO "app_authenticated"', t.tbl);
    END IF;
    FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', t.tbl, r);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM "service_role"', t.tbl);
    END IF;
    -- PostgreSQL 17's MAINTAIN (REINDEX, CLUSTER, VACUUM, LOCK): the owner's alone.
    IF current_setting('server_version_num')::int >= 170000 THEN
      FOREACH r IN ARRAY ARRAY['authenticated', 'app_authenticated', 'service_role', 'anon'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
          EXECUTE format('REVOKE MAINTAIN ON %I FROM %I', t.tbl, r);
        END IF;
      END LOOP;
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- SITES_REACH: the four arms above on each table and no other; none for a
-- PostgREST role, the service or the sync principal.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  bad text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    RETURN;
  END IF;
  SELECT string_agg(p.tablename || '.' || p.policyname || ' ' || p.cmd || ' ' || p.roles::text, ', '
                    ORDER BY p.tablename, p.policyname) INTO bad
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename IN ('Sites', 'SiteTravelTimes')
     AND NOT (p.roles = '{app_authenticated}'::name[]
              AND p.policyname IN (CASE p.tablename WHEN 'Sites' THEN 'sites' ELSE 'site_travel_times' END
                                   || '_' || CASE p.cmd WHEN 'SELECT' THEN 'staff_select'
                                                        WHEN 'INSERT' THEN 'admin_insert'
                                                        WHEN 'UPDATE' THEN 'admin_update'
                                                        WHEN 'DELETE' THEN 'admin_delete'
                                                        ELSE 'an arm for every command' END)
              AND (p.cmd = 'SELECT' OR coalesce(p.with_check, p.qual) LIKE '%current_user_may(''PLANERING''%'));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'SITES_REACH: these arms reach Sites or SiteTravelTimes beyond the staff read and the planner''s writes: %', bad;
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('Sites', 'SiteTravelTimes')) <> 8 THEN
    RAISE EXCEPTION 'SITES_REACH: Sites and SiteTravelTimes have % arms, not the eight above',
      (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('Sites', 'SiteTravelTimes'));
  END IF;
END
$$;
