-- En skola har rastvaktsområden och ett daterat rastvaktsschema.
--
-- Every grundskola watches its pupils between lessons: a teacher on the yard
-- at the morning rast, two in the dining hall at lunch, one in the corridor
-- on plan 2. Until now SchemaPro could hold that only as an uppdrag of the
-- kind RASTVAKT with a figure typed by hand ("Rastvakt, 60 min/vecka"), which
-- says how much and nothing of where or when: nobody could see that the yard
-- is empty on Tuesdays, and the figure in a teacher's load was whatever was
-- typed, not what the schedule gave them. This migration is the data of
-- Rastvaktsschema:
--
--   * SupervisionAreas: the places the school watches, and in which breaks.
--   * SupervisionShifts: the rastvaktsschema, one row per pass — an area, a
--     weekday, a time, a teacher, between two dates of a läsår.
--
-- What the rows MEAN — which breaks an area needs watched, which of them
-- nobody watches, and the minutes a teacher's passes add to their load — is
-- the gateway's (src/supervision). Nothing here reaches the engine, whose
-- contract does not change.
--
-- ## An area is the school's, not the year's
--
-- Like a rast (Rasts, 20260905090000), an area describes the building and the
-- yard: "skolgården" is there next August too. So it has no läsår, and the
-- rollover has nothing of it to carry (rollover-registry.spec.ts lists the
-- year-scoped models; SupervisionAreas is not one).
--
--   * name 1..60 characters, trimmed, unique per school (the Sites rule).
--   * siteId: the skolområde the area is on (Sites, 20261124090000), null when
--     the school has not said. ("siteId", "schoolId") -> Sites ("id",
--     "schoolId"), ON DELETE SET NULL ("siteId"), ON UPDATE NO ACTION, as a
--     room's: deleting a site leaves its areas on none.
--   * minGradeLevel, maxGradeLevel: whose breaks the area is watched in,
--     0..12 inclusive as a rast's span, both or neither (neither: every
--     stage). Matching is OVERLAP, the rule every stage span here follows: a
--     lågstadiegård for åk 0–3 is watched while any of those years is out.
--   * duringRasts, duringLunch: which of their breaks — the rasts (Rasts) and
--     the meal (LunchServings, or the school's lunch window where no sitting
--     speaks about the stage). The yard at rast, the hall at lunch; both is
--     legal, and so is neither: an area at the bus stop has passes but no
--     break of its own to be watched in.
--   * guardsNeeded 0..10, default 1: rastvakter at once. 0 is a real answer —
--     passes may be planned there, and no break is said to be unwatched.
--   * countsAsTeaching, default false: whether a pass here consumes the
--     teaching target, as an uppdrag marked so does. Rastvakt is övrig
--     arbetstid at most schools; a school that counts its rastaktivitet as
--     undervisning says so on that area, not for every place at once.
--
-- ## A pass has its own time, and its own dates
--
-- A pass names the area, a weekday 1..7, a start and an end in whole minutes
-- (start before end), and Från and Till (validFrom, validTo, inclusive; null
-- is the läsår's own bound, as on an uppdrag, 20261017090000). It does NOT
-- reference a Rast: a rast moved in March must not rewrite who watched in
-- February, deleting a rast must not delete a schedule, and a pass at the bus
-- at 15:00 or in the entrance at 07:45 belongs to no rast at all. The
-- gateway matches passes to breaks by time, and a break no pass covers is the
-- warning.
--
--   * ("academicYearId", "schoolId") -> AcademicYears, ON DELETE CASCADE.
--   * ("areaId", "schoolId") -> SupervisionAreas, ON DELETE CASCADE: a pass
--     is a pass of its place, and the web says how many go with it.
--   * ("userId", "schoolId") -> Users, ON DELETE CASCADE: a person removed is
--     on no schedule, and the break they watched shows as unwatched.
--   * Every key ON UPDATE NO ACTION, as 20261124090000's: ids are never
--     rewritten, and a cascade would carry an owner's change of a row's
--     school into the schedule with row security off.
--   * Från not after Till (CHECK); both inside the läsår (the service, against
--     the year's bounds read FOR SHARE, as an uppdrag's are).
--   * note: at most 200 characters, trimmed, or null.
--
-- ONE PLACE AT A TIME. Two passes of one teacher in one läsår on one weekday
-- never share a minute on a date both run (SupervisionShifts_one_place_at_a_
-- time, EXCLUDE USING gist; btree_gist is installed since 20260822131500).
-- The minutes are [start, end): 11:30–12:00 in the hall and 12:00–12:30 on
-- the yard is one teacher's lunch, and allowed. The service answers the same
-- question first and names the other pass (409 SUPERVISION_SHIFT_CLASH); the
-- constraint is what holds when two saves race.
--
-- ## In the load: an uppdrag, and the RASTVAKT uppdrag becomes the ram
--
-- The gateway reads a teacher's passes into the load as uppdrag
-- (src/supervision/supervision-load.ts): a pass's minutes, every week its
-- dates run, through the same arithmetic as a dated uppdrag (teaching weeks,
-- school-wide lov subtracted), counted against the target only where its
-- area countsAsTeaching. On the dates a teacher has a pass, their uppdrag of
-- the kind RASTVAKT stop counting: the schedule is then what they do, and
-- the typed figure is the ram the schedule is planned against, shown beside
-- it. A teacher with no pass keeps the uppdrag as it always counted, so a
-- school that never opens the page reads the load it always did.
--
-- ## Who reads and who writes
--
-- Through the gateway only (the API role, app_authenticated); nothing for
-- authenticated or anon, and service_role keeps its SELECT and nothing more,
-- as on every table (20261016130000).
--
--   supervision_areas_staff_select
--       the school's SCHOOL_ADMIN and TEACHER: a place and its breaks are no
--       one's personal data, and a teacher's own load reads its areas' rule.
--   supervision_shifts_admin_select
--       the school's SCHOOL_ADMIN: the whole schedule.
--   supervision_shifts_teacher_own_select
--       a TEACHER their OWN passes, as teacher_duties_teacher_own_select keeps
--       their uppdrag: a pass is part of the tjänst, and its minutes are in
--       the load. Who else watches the yard is the next phase's question
--       (Rastvakt i vardagen), not answered here by a wide arm.
--   *_admin_insert / _update / _delete on both
--       the school's SCHOOL_ADMIN who writes PLANERING
--       (app.current_user_may('PLANERING', true)), as the uppdrag and the
--       rasts; the update arm asks it in WITH CHECK only, so a row lock for a
--       read keeps working for every administrator (RLS section 106 c).
--       TABLE_WRITE_GATES in src/auth/admin-areas.ts says the same, and RLS
--       section 116 runs every profile against both tables.
--
-- The gateway records an administrator's read of the schedule in the
-- läslogg (EMPLOYMENT, as an uppdrag's: who carries what of the tjänst).
--
-- The SS12000 providers emit nothing new: the duties resource reads the
-- post, not its uppdrag, and no S1 object has a slot for a pass.
--
-- ## Beside the live API: every lock at once, or none
--
-- Production runs this while the API before it serves requests. No existing
-- table gains a column; the new tables' keys take Schools, AcademicYears,
-- Users and Sites in SHARE ROW EXCLUSIVE, which blocks writes to them (not
-- reads, and not the KEY SHARE a foreign-key check takes) for the length of
-- the file. A request can write two of them in one transaction — the year's
-- activation writes AcademicYears and then the pupils in Users — so a
-- migration that took them one at a time, waiting for each, would hold the
-- first while it waited for the next: a request writing them the other way
-- round closes a cycle, and a waiting lock queues every later writer of its
-- table (every Users write, for as long as the slowest open writer runs).
-- So all four are taken first, NOWAIT and together: a refusal rolls the
-- subtransaction back and with it whatever it got, and it tries again 50 ms
-- later. It never waits while it holds a lock, and no request queues behind
-- it. After 30 s of refusals it stops with nothing done and can be rerun
-- (prisma migrate resolve --rolled-back, then deploy). lock_timeout bounds
-- any wait nobody foresaw.
--
-- The API before it reads neither table and its Prisma client names neither,
-- so it works unchanged between this migration and the deploy.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Schools" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "AcademicYears" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Users" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Sites" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Schools, AcademicYears, Users and Sites were not free at once in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- SupervisionAreas
-- ---------------------------------------------------------------------------

CREATE TABLE "SupervisionAreas" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "siteId" UUID,
    "minGradeLevel" INTEGER,
    "maxGradeLevel" INTEGER,
    "duringRasts" BOOLEAN NOT NULL DEFAULT true,
    "duringLunch" BOOLEAN NOT NULL DEFAULT false,
    "guardsNeeded" INTEGER NOT NULL DEFAULT 1,
    "countsAsTeaching" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupervisionAreas_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SupervisionAreas_name_named" CHECK (
        "name" = btrim("name") AND char_length("name") BETWEEN 1 AND 60
    ),
    -- Both ends or neither, said as an equality: an OR of "both null" and
    -- "both in range" would read one null end as unknown, which a CHECK
    -- lets through.
    CONSTRAINT "SupervisionAreas_grade_span" CHECK (
        ("minGradeLevel" IS NULL) = ("maxGradeLevel" IS NULL)
        AND ("minGradeLevel" IS NULL
             OR ("minGradeLevel" BETWEEN 0 AND 12
                 AND "maxGradeLevel" BETWEEN 0 AND 12
                 AND "minGradeLevel" <= "maxGradeLevel"))
    ),
    CONSTRAINT "SupervisionAreas_guards_range" CHECK ("guardsNeeded" BETWEEN 0 AND 10)
);

CREATE UNIQUE INDEX "SupervisionAreas_schoolId_name_key" ON "SupervisionAreas"("schoolId", "name");
CREATE UNIQUE INDEX "SupervisionAreas_id_schoolId_key" ON "SupervisionAreas"("id", "schoolId");
-- The site key's SET NULL scans by it when a site is deleted.
CREATE INDEX "SupervisionAreas_siteId_idx" ON "SupervisionAreas"("siteId");

ALTER TABLE "SupervisionAreas"
    ADD CONSTRAINT "SupervisionAreas_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupervisionAreas"
    ADD CONSTRAINT "SupervisionAreas_siteId_schoolId_fkey" FOREIGN KEY ("siteId", "schoolId")
    REFERENCES "Sites"("id", "schoolId") ON UPDATE NO ACTION ON DELETE SET NULL ("siteId");

-- ---------------------------------------------------------------------------
-- SupervisionShifts
-- ---------------------------------------------------------------------------

CREATE TABLE "SupervisionShifts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "academicYearId" UUID NOT NULL,
    "areaId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startTime" TIME(0) NOT NULL,
    "endTime" TIME(0) NOT NULL,
    "validFrom" DATE,
    "validTo" DATE,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupervisionShifts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SupervisionShifts_day_is_iso" CHECK ("dayOfWeek" BETWEEN 1 AND 7),
    CONSTRAINT "SupervisionShifts_window_is_ordered" CHECK ("endTime" > "startTime"),
    CONSTRAINT "SupervisionShifts_whole_minutes" CHECK (
        EXTRACT(SECOND FROM "startTime") = 0 AND EXTRACT(SECOND FROM "endTime") = 0
    ),
    CONSTRAINT "SupervisionShifts_dates_are_ordered" CHECK (
        "validFrom" IS NULL OR "validTo" IS NULL OR "validTo" >= "validFrom"
    ),
    CONSTRAINT "SupervisionShifts_note_is_short" CHECK (
        "note" IS NULL OR ("note" = btrim("note") AND char_length("note") BETWEEN 1 AND 200)
    ),
    -- One person, one place at a time. After the primary key, so a copied
    -- row meets the key first (RLS section 116 copies rows to probe INSERT).
    -- A null date is unbounded in a daterange, which is the läsår's own bound
    -- here: academicYearId keeps two years' undated passes apart.
    CONSTRAINT "SupervisionShifts_one_place_at_a_time" EXCLUDE USING gist (
        "userId" WITH =,
        "academicYearId" WITH =,
        "dayOfWeek" WITH =,
        tsrange(DATE '2000-01-03' + "startTime", DATE '2000-01-03' + "endTime") WITH &&,
        daterange("validFrom", "validTo", '[]') WITH &&
    )
);

CREATE INDEX "SupervisionShifts_academicYearId_schoolId_idx" ON "SupervisionShifts"("academicYearId", "schoolId");
CREATE INDEX "SupervisionShifts_areaId_schoolId_idx" ON "SupervisionShifts"("areaId", "schoolId");
CREATE INDEX "SupervisionShifts_userId_schoolId_idx" ON "SupervisionShifts"("userId", "schoolId");

ALTER TABLE "SupervisionShifts"
    ADD CONSTRAINT "SupervisionShifts_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupervisionShifts"
    ADD CONSTRAINT "SupervisionShifts_academicYearId_schoolId_fkey" FOREIGN KEY ("academicYearId", "schoolId")
    REFERENCES "AcademicYears"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "SupervisionShifts"
    ADD CONSTRAINT "SupervisionShifts_areaId_schoolId_fkey" FOREIGN KEY ("areaId", "schoolId")
    REFERENCES "SupervisionAreas"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "SupervisionShifts"
    ADD CONSTRAINT "SupervisionShifts_userId_schoolId_fkey" FOREIGN KEY ("userId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- Row-level security and grants. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "SupervisionAreas" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupervisionShifts" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t record;
  r text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    CREATE POLICY "supervision_areas_staff_select" ON "SupervisionAreas"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) IN ('SCHOOL_ADMIN', 'TEACHER'));
    CREATE POLICY "supervision_shifts_admin_select" ON "SupervisionShifts"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    -- app.current_user_id() is NULL for anybody without an active Users row,
    -- and "userId" = NULL matches nothing.
    CREATE POLICY "supervision_shifts_teacher_own_select" ON "SupervisionShifts"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'TEACHER'
               AND "userId" = (select app.current_user_id()));
  END IF;

  FOR t IN SELECT * FROM (VALUES ('SupervisionAreas', 'supervision_areas'),
                                 ('SupervisionShifts', 'supervision_shifts')) AS v(tbl, arm) LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
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
-- SUPERVISION_REACH: the arms above on each table and no other; none for a
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
   WHERE p.schemaname = 'public' AND p.tablename IN ('SupervisionAreas', 'SupervisionShifts')
     AND NOT (p.roles = '{app_authenticated}'::name[]
              AND (p.tablename, p.policyname, p.cmd) IN (
                    ('SupervisionAreas', 'supervision_areas_staff_select', 'SELECT'),
                    ('SupervisionAreas', 'supervision_areas_admin_insert', 'INSERT'),
                    ('SupervisionAreas', 'supervision_areas_admin_update', 'UPDATE'),
                    ('SupervisionAreas', 'supervision_areas_admin_delete', 'DELETE'),
                    ('SupervisionShifts', 'supervision_shifts_admin_select', 'SELECT'),
                    ('SupervisionShifts', 'supervision_shifts_teacher_own_select', 'SELECT'),
                    ('SupervisionShifts', 'supervision_shifts_admin_insert', 'INSERT'),
                    ('SupervisionShifts', 'supervision_shifts_admin_update', 'UPDATE'),
                    ('SupervisionShifts', 'supervision_shifts_admin_delete', 'DELETE'))
              AND (p.cmd = 'SELECT' OR coalesce(p.with_check, p.qual) LIKE '%current_user_may(''PLANERING''%'));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'SUPERVISION_REACH: these arms reach SupervisionAreas or SupervisionShifts beyond the staff read, the teacher''s own passes and the planner''s writes: %', bad;
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'
         AND tablename IN ('SupervisionAreas', 'SupervisionShifts')) <> 9 THEN
    RAISE EXCEPTION 'SUPERVISION_REACH: SupervisionAreas and SupervisionShifts have % arms, not the nine above',
      (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('SupervisionAreas', 'SupervisionShifts'));
  END IF;
END
$$;
