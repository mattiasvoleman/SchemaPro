-- En skola har skolenheter.
--
-- Skolverket's skolenhetsregister, SCB's Pedagogisk personal and SS12000
-- all count by skolenhet, not by school: the SCB file has a SkolenhetsKod
-- column on every row, and an SS12000 Organisation of type Skolenhet carries
-- the eight-digit schoolUnitCode. A school in SchemaPro can be one skolenhet
-- (most are), or several: an F–9 school is often an F–6 and a 7–9 unit with a
-- rektor each, and anpassad grundskola is a unit of its own. Until now the
-- school had no such thing: the provider emitted the school itself (under
-- the source's id when exactly one was chosen, else as a "Skola" with no
-- code) and the SCB file left SkolenhetsKod empty.
--
-- ## SchoolUnits
--
--   * name 1..300 characters, not blank (a tab or an NBSP alone is blank).
--   * code: the skolenhetskod, exactly eight digits as the register prints
--     it, or null while the school has not entered it. Unique per school
--     where set (partial index). Not unique across schools: a uniqueness
--     violation would tell one tenant that another holds the code.
--   * schoolTypes: the skolformer, as S1 SchoolTypesEnum spells them, of the
--     seven a grundskola-shaped school has: FKLASS, FTH, GR, GRS (anpassad
--     grundskola), TR (anpassad grundskola, ämnesområden; S1 2.1.0 still says
--     träningsskola), SP, SAM. No null element.
--   * gradeFrom..gradeTo: the årskurser the unit holds, 0 (förskoleklass) to
--     10, both or neither. A unit with no span (a fritidshem) holds no class.
--   * ss12000Id: the source's Organisation id once an admin linked the unit,
--     unique per school where set. Written only by an admin, by the same
--     trigger function that guards Users and StudentGroups
--     (app.ss12000_ids_are_written_by_an_admin, SS403).
--
-- ## A class belongs to a unit through its årskurs
--
-- The span is the map: class 7A belongs to the unit whose span holds 7. No
-- column on StudentGroups, so the läsårsrullning carries nothing new (7A
-- becomes 8A and lands in the unit holding 8 by itself) and an F–9 school
-- split into F–6 and 7–9 is two rows. The rule, the same in the gateway
-- (src/school-units/school-unit-map.ts) and the web (web/lib/school-units.ts):
--
--   * no unit: as before this migration;
--   * one unit: everything is that unit's;
--   * several: the unit whose span holds the grade; a grade no span holds,
--     and what has no grade (a room, an undervisningsgrupp without one), is
--     the first unit's: lowest gradeFrom (units without a span last), then
--     code, then name, then id.
--
-- Two units' spans may not overlap within a school
-- (app.school_unit_spans_do_not_overlap, BEFORE INSERT OR UPDATE, SQLSTATE
-- SU409). It runs as the writer (SECURITY INVOKER), so it reads only what
-- the writer's arms let it read and names no other school's unit.
--
-- ONE WRITER OF A SCHOOL'S UNITS AT A TIME. Every insert, update and delete
-- of a unit takes a transaction-level advisory lock on its school first
-- (app.school_units_take_school_lock, BEFORE ROW), and so do a change of
-- the source's chosen skolenheter (app.ss12000_organisation_moved) and the
-- sync's locked read before an apply (src/integration/ss12000-sync/
-- local-slice.ts) and SchoolUnitsService's writes, with the same key
-- (hashtextextended('SchoolUnits:' || school, 0)). The second writer waits
-- for the first to commit, and its span check and the tracking below, each
-- a statement of its own under READ COMMITTED, see the first one's rows:
-- without it two transactions deleting the last two units would each see
-- the other's, and neither would unbury the school's own Organisation.
-- A principal of another school takes no lock on this one. That is the limit the timplan already has:
-- AcademicYearTimplans holds one plan, so one skolform, per årskurs and
-- läsår, so a grundskola 4A and an anpassad 4A in the same school and year
-- cannot both be planned today either.
--
-- ## What the SS12000 provider emits (src/integration/ss12000-v2/model.ts)
--
-- One Organisation per unit, organisationType "Skolenhet", id the source's
-- (ss12000Id) or the unit's own, schoolUnitCode when set. A school with no
-- unit is emitted exactly as before (a "Skola" when it chose several of the
-- source's skolenheter): a type that changed with the code and not with the
-- data would move no meta.modified, and the sync turns those skolenheter
-- into units, whose arrival is tracked.
-- app.ss12000_organisation_ids(school) is the emitted set, the gateway's
-- IdSpace the same rule.
--
-- Change tracking (20261014130000's versions and tombstones):
--
--   * SchoolUnits: any change to an emitted or mapping column (name, code,
--     schoolTypes, the span, ss12000Id), an insert or a delete, buries the
--     emitted ids that went (the school's own id when the first unit
--     arrives, a deleted unit's, a relinked unit's old one), unburies the
--     live ones, and moves every object that names an organisation: the
--     units, pupils (Person.enrolments.enroledAt), groups, the active year's
--     duties (dutyAt), rooms (owner) and activities. Calendar events carry
--     no organisation and do not move.
--   * StudentGroups: a changed gradeLevel in a school with two or more units
--     can move the class to another unit, so it moves the same objects.
--   * app.ss12000_organisation_moved (the source's chosen ids changed) is
--     replaced: with units, the chosen ids name no emitted object, so it
--     does nothing; without, it does what it did.
--   * A unit's meta.modified is the later of its own version and the
--     school's (entityId = schoolId), so what moves the school's
--     Organisation today (a timplan's skolform, the school's name) still
--     moves the units.
--
-- ## Who reads and writes
--
-- Every arm is TO app_authenticated, the gateway's role: none reaches a
-- PostgREST session.
--
--   school_units_admin_all       the school's SCHOOL_ADMIN, every command.
--   school_units_service_select  the service principal of the row's school
--                                (the provider reads the units).
--   school_units_sync_select     the sync principal of the row's school (the
--                                nightly dry run compares the source's
--                                units with these). No write: a unit change
--                                waits for an admin's apply.
--
-- Grants: app_authenticated SELECT, INSERT, UPDATE, DELETE; authenticated
-- and anon nothing; service_role SELECT only (20261016130000); MAINTAIN off
-- for all three on PostgreSQL 17 (20261016120000).
--
-- Additive: one new type, one new table, new functions and triggers, and one
-- function replaced with a body that behaves as before for every school
-- without a unit, which is every school when this runs.

CREATE TYPE "SchoolUnitType" AS ENUM ('FKLASS', 'FTH', 'GR', 'GRS', 'TR', 'SP', 'SAM');

CREATE TABLE "SchoolUnits" (
    "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"    UUID NOT NULL,
    "name"        TEXT NOT NULL,
    "code"        TEXT,
    "schoolTypes" "SchoolUnitType"[] NOT NULL DEFAULT '{}',
    "gradeFrom"   INTEGER,
    "gradeTo"     INTEGER,
    "ss12000Id"   UUID,
    "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "SchoolUnits_pkey" PRIMARY KEY ("id"),
    -- Not blank as the DTO's /\S/ means it (20261006120000's class): a tab
    -- or an NBSP is no name. 300: the longest displayName the sync reads.
    CONSTRAINT "SchoolUnits_name_check" CHECK (
        "name" ~ '[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]' AND char_length("name") <= 300),
    CONSTRAINT "SchoolUnits_code_check" CHECK ("code" ~ '^[0-9]{8}$'),
    CONSTRAINT "SchoolUnits_school_types_check" CHECK (array_position("schoolTypes", NULL) IS NULL),
    CONSTRAINT "SchoolUnits_span_check" CHECK (
        ("gradeFrom" IS NULL) = ("gradeTo" IS NULL)
        AND ("gradeFrom" IS NULL OR (0 <= "gradeFrom" AND "gradeFrom" <= "gradeTo" AND "gradeTo" <= 10)))
);

CREATE UNIQUE INDEX "SchoolUnits_id_schoolId_key" ON "SchoolUnits"("id", "schoolId");
CREATE UNIQUE INDEX "SchoolUnits_schoolId_code_key" ON "SchoolUnits"("schoolId", "code") WHERE "code" IS NOT NULL;
CREATE UNIQUE INDEX "SchoolUnits_schoolId_ss12000Id_key" ON "SchoolUnits"("schoolId", "ss12000Id") WHERE "ss12000Id" IS NOT NULL;
CREATE INDEX "SchoolUnits_schoolId_idx" ON "SchoolUnits"("schoolId");

ALTER TABLE "SchoolUnits"
    ADD CONSTRAINT "SchoolUnits_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Two units of a school never hold the same årskurs. See the preamble.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.school_unit_spans_do_not_overlap() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = "public", "pg_temp" AS $$
DECLARE
  other record;
BEGIN
  -- No span, or not one (half of one, backwards): SchoolUnits_span_check
  -- answers for the second. Another school's row: the arms refuse it.
  IF NEW."gradeFrom" IS NULL OR NEW."gradeTo" IS NULL OR NEW."gradeFrom" > NEW."gradeTo"
     OR NEW."schoolId" IS DISTINCT FROM coalesce(app.current_school_id(), NEW."schoolId") THEN
    RETURN NEW;
  END IF;
  -- The school's lock (app.school_units_take_school_lock) is held: the
  -- read below sees every committed unit of the school.
  SELECT u."name", u."gradeFrom", u."gradeTo" INTO other
    FROM "SchoolUnits" u
   WHERE u."schoolId" = NEW."schoolId" AND u."id" <> NEW."id" AND u."gradeFrom" IS NOT NULL
     AND int4range(u."gradeFrom", u."gradeTo", '[]') && int4range(NEW."gradeFrom", NEW."gradeTo", '[]')
   ORDER BY u."gradeFrom"
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'SCHOOL_UNIT_SPAN_OVERLAP: två skolenheter i samma skola kan inte ha samma årskurs'
      USING ERRCODE = 'SU409',
            DETAIL  = format('other=%s span=%s-%s', other."name", other."gradeFrom", other."gradeTo");
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SchoolUnits_spans_do_not_overlap"
    BEFORE INSERT OR UPDATE OF "gradeFrom", "gradeTo", "schoolId" ON "SchoolUnits"
    FOR EACH ROW
    EXECUTE FUNCTION app.school_unit_spans_do_not_overlap();

-- One writer of a school's units at a time. See the preamble. Named to fire
-- before the span check (BEFORE triggers fire in name order).
CREATE FUNCTION app.school_units_take_school_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = "public", "pg_temp" AS $$
DECLARE
  mine uuid := app.current_school_id();
  s uuid;
BEGIN
  FOREACH s IN ARRAY ARRAY[
    CASE WHEN TG_OP <> 'INSERT' THEN OLD."schoolId" END,
    CASE WHEN TG_OP <> 'DELETE' THEN NEW."schoolId" END
  ] LOOP
    IF s IS NOT NULL AND (mine IS NULL OR s = mine) THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('SchoolUnits:' || s::text, 0));
    END IF;
  END LOOP;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE TRIGGER "SchoolUnits_lock_the_school"
    BEFORE INSERT OR UPDATE OR DELETE ON "SchoolUnits"
    FOR EACH ROW
    EXECUTE FUNCTION app.school_units_take_school_lock();

-- Only an admin links a unit to the source (20261014100000's rule).
CREATE TRIGGER "SchoolUnits_ss12000Id_on_insert"
    BEFORE INSERT ON "SchoolUnits"
    FOR EACH ROW
    WHEN (NEW."ss12000Id" IS NOT NULL)
    EXECUTE FUNCTION app.ss12000_ids_are_written_by_an_admin();
CREATE TRIGGER "SchoolUnits_ss12000Id_on_update"
    BEFORE UPDATE OF "ss12000Id" ON "SchoolUnits"
    FOR EACH ROW
    WHEN (OLD."ss12000Id" IS DISTINCT FROM NEW."ss12000Id")
    EXECUTE FUNCTION app.ss12000_ids_are_written_by_an_admin();

-- ---------------------------------------------------------------------------
-- The organisations the provider emits. See the preamble.
-- ---------------------------------------------------------------------------

-- The school's single Organisation before skolenheter: the source's id when
-- exactly one is chosen, else the school's own.
CREATE FUNCTION app.ss12000_school_organisation_id(p_school uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT coalesce(
    (SELECT s."organisationIds"[1] FROM "Ss12000Sources" s
      WHERE s."schoolId" = p_school AND cardinality(s."organisationIds") = 1),
    p_school)
$$;

-- Every id emitted as an Organisation: one per unit, or the school's single
-- one when it has no unit. IdSpace (src/integration/ss12000-v2/model.ts) is
-- the same rule.
CREATE FUNCTION app.ss12000_organisation_ids(p_school uuid) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM "SchoolUnits" u WHERE u."schoolId" = p_school)
      THEN ARRAY(SELECT coalesce(u."ss12000Id", u."id") FROM "SchoolUnits" u WHERE u."schoolId" = p_school ORDER BY 1)
    ELSE ARRAY[app.ss12000_school_organisation_id(p_school)]
  END
$$;

-- The units changed (p_before: the emitted ids of the units before the
-- statement, empty when there were none): bury what went, unbury what is
-- live, and move every object that names an organisation.
CREATE FUNCTION app.ss12000_school_units_moved(p_school uuid, p_before uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  was uuid[] := CASE WHEN cardinality(coalesce(p_before, ARRAY[]::uuid[])) = 0
                     THEN ARRAY[app.ss12000_school_organisation_id(p_school)] ELSE p_before END;
  live uuid[] := app.ss12000_organisation_ids(p_school);
BEGIN
  -- A school being deleted takes its units with it: nothing to record.
  IF NOT EXISTS (SELECT 1 FROM "Schools" s WHERE s."id" = p_school) THEN
    RETURN;
  END IF;
  PERFORM app.ss12000_bury(p_school, 'Organisation', ARRAY(SELECT unnest(was) EXCEPT SELECT unnest(live)));
  PERFORM app.ss12000_unbury(p_school, 'Organisation', live);
  PERFORM app.ss12000_bump(p_school, 'Organisation',
    ARRAY(SELECT u."id" FROM "SchoolUnits" u WHERE u."schoolId" = p_school) || p_school);
  PERFORM app.ss12000_bump(p_school, 'Person', ARRAY(
    SELECT u."id" FROM "Users" u WHERE u."schoolId" = p_school AND u."role" = 'STUDENT' AND u."isActive"));
  PERFORM app.ss12000_bump_groups(p_school, ARRAY(SELECT g."id" FROM "StudentGroups" g WHERE g."schoolId" = p_school));
  PERFORM app.ss12000_bump(p_school, 'Duty', ARRAY(
    SELECT e."id" FROM "TeacherEmployments" e
     WHERE e."schoolId" = p_school AND e."academicYearId" = app.ss12000_active_year(p_school)));
  PERFORM app.ss12000_bump(p_school, 'Room', ARRAY(SELECT r."id" FROM "Rooms" r WHERE r."schoolId" = p_school));
  PERFORM app.ss12000_bump_activities(p_school, NULL, NULL, NULL, true);
END
$$;

CREATE FUNCTION app.ss12000_v_school_units() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  r record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR r IN SELECT DISTINCT x."schoolId" s FROM n x LOOP
      PERFORM app.ss12000_school_units_moved(r.s, ARRAY(
        SELECT coalesce(u."ss12000Id", u."id") FROM "SchoolUnits" u
         WHERE u."schoolId" = r.s AND NOT EXISTS (SELECT 1 FROM n x WHERE x."id" = u."id")));
    END LOOP;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Both schools of a unit that moved (the owner's write; an arm refuses
    -- an admin's): the old one loses it, the new one gains it.
    FOR r IN
      SELECT DISTINCT u.s FROM n x JOIN o y ON y."id" = x."id"
       CROSS JOIN LATERAL (VALUES (x."schoolId"), (y."schoolId")) AS u(s)
       WHERE (x."name", x."code", x."schoolTypes", x."gradeFrom", x."gradeTo", x."ss12000Id", x."schoolId")
             IS DISTINCT FROM (y."name", y."code", y."schoolTypes", y."gradeFrom", y."gradeTo", y."ss12000Id", y."schoolId")
    LOOP
      PERFORM app.ss12000_school_units_moved(r.s, ARRAY(
        SELECT coalesce(u."ss12000Id", u."id") FROM "SchoolUnits" u
         WHERE u."schoolId" = r.s AND NOT EXISTS (SELECT 1 FROM n x WHERE x."id" = u."id")
        UNION ALL
        SELECT coalesce(y."ss12000Id", y."id") FROM o y WHERE y."schoolId" = r.s));
    END LOOP;
  ELSE
    FOR r IN SELECT DISTINCT y."schoolId" s FROM o y LOOP
      PERFORM app.ss12000_school_units_moved(r.s, ARRAY(
        SELECT coalesce(u."ss12000Id", u."id") FROM "SchoolUnits" u WHERE u."schoolId" = r.s
        UNION ALL
        SELECT coalesce(y."ss12000Id", y."id") FROM o y WHERE y."schoolId" = r.s));
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;

-- A class whose årskurs changed may now be another unit's. Coarse on
-- purpose: every object naming an organisation moves, also when the class
-- stays in its unit (7 → 8 within 7–9), rather than a third copy of the
-- unit rule in SQL; a class's årskurs changes about never. A class of a year
-- the provider does not emit moves nothing.
CREATE FUNCTION app.ss12000_v_group_grades() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT x."schoolId" s FROM n x JOIN o y ON y."id" = x."id"
     WHERE x."gradeLevel" IS DISTINCT FROM y."gradeLevel" AND app.ss12000_year_is_emitted(x."academicYearId")
  LOOP
    IF (SELECT count(*) FROM "SchoolUnits" u WHERE u."schoolId" = r.s) > 1 THEN
      PERFORM app.ss12000_school_units_moved(r.s, app.ss12000_organisation_ids(r.s));
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SchoolUnits_ss12000_versions_ins"
    AFTER INSERT ON "SchoolUnits" REFERENCING NEW TABLE AS n
    FOR EACH STATEMENT EXECUTE FUNCTION app.ss12000_v_school_units();
CREATE TRIGGER "SchoolUnits_ss12000_versions_upd"
    AFTER UPDATE ON "SchoolUnits" REFERENCING OLD TABLE AS o NEW TABLE AS n
    FOR EACH STATEMENT EXECUTE FUNCTION app.ss12000_v_school_units();
CREATE TRIGGER "SchoolUnits_ss12000_versions_del"
    AFTER DELETE ON "SchoolUnits" REFERENCING OLD TABLE AS o
    FOR EACH STATEMENT EXECUTE FUNCTION app.ss12000_v_school_units();
CREATE TRIGGER "StudentGroups_ss12000_units_upd"
    AFTER UPDATE ON "StudentGroups" REFERENCING OLD TABLE AS o NEW TABLE AS n
    FOR EACH STATEMENT EXECUTE FUNCTION app.ss12000_v_group_grades();

-- With units, the source's chosen ids name no emitted object.
CREATE OR REPLACE FUNCTION app.ss12000_organisation_moved(p_school uuid, p_old uuid[], p_new uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  was uuid := CASE WHEN cardinality(p_old) = 1 THEN p_old[1] ELSE p_school END;
  now_id uuid := CASE WHEN cardinality(p_new) = 1 THEN p_new[1] ELSE p_school END;
BEGIN
  -- After a concurrent unit write commits, not beside it: see the preamble.
  PERFORM pg_advisory_xact_lock(hashtextextended('SchoolUnits:' || p_school::text, 0));
  IF EXISTS (SELECT 1 FROM "SchoolUnits" u WHERE u."schoolId" = p_school) THEN
    RETURN;
  END IF;
  IF was IS DISTINCT FROM now_id THEN
    PERFORM app.ss12000_bury(p_school, 'Organisation', ARRAY[was]);
    PERFORM app.ss12000_unbury(p_school, 'Organisation', ARRAY[now_id]);
  END IF;
  PERFORM app.ss12000_bump_school(p_school);
END
$$;

-- ---------------------------------------------------------------------------
-- Row-level security and grants. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "SchoolUnits" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r text;
  fn text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    EXECUTE $p$
      CREATE POLICY "school_units_admin_all" ON "SchoolUnits"
          FOR ALL TO "app_authenticated"
          USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
          WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    $p$;
    EXECUTE $p$
      CREATE POLICY "school_units_service_select" ON "SchoolUnits"
          FOR SELECT TO "app_authenticated"
          USING ("schoolId" = (select app.current_service_school_id()))
    $p$;
    EXECUTE $p$
      CREATE POLICY "school_units_sync_select" ON "SchoolUnits"
          FOR SELECT TO "app_authenticated"
          USING ("schoolId" = (select app.current_sync_school_id()))
    $p$;
    REVOKE ALL ON "SchoolUnits" FROM "app_authenticated";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "SchoolUnits" TO "app_authenticated";
  END IF;
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "SchoolUnits" FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "SchoolUnits" FROM "service_role";
  END IF;
  -- PostgreSQL 17's MAINTAIN (REINDEX, CLUSTER, VACUUM, LOCK): the owner's alone.
  IF current_setting('server_version_num')::int >= 170000 THEN
    FOREACH r IN ARRAY ARRAY['authenticated', 'app_authenticated', 'service_role', 'anon'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE MAINTAIN ON "SchoolUnits" FROM %I', r);
      END IF;
    END LOOP;
  END IF;

  -- The trigger functions and the rule behind them: nobody calls them but
  -- the triggers.
  FOREACH fn IN ARRAY ARRAY[
    'app.school_unit_spans_do_not_overlap()',
    'app.school_units_take_school_lock()',
    'app.ss12000_school_organisation_id(uuid)',
    'app.ss12000_organisation_ids(uuid)',
    'app.ss12000_school_units_moved(uuid, uuid[])',
    'app.ss12000_v_school_units()',
    'app.ss12000_v_group_grades()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', fn, r);
      END IF;
    END LOOP;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- SCHOOL_UNITS_REACH: the three arms above and no other; none for a
-- PostgREST role, none for the sync principal that writes.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  bad text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    RETURN;
  END IF;
  SELECT string_agg(p.policyname || ' ' || p.cmd || ' ' || p.roles::text, ', ' ORDER BY p.policyname) INTO bad
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = 'SchoolUnits'
     AND NOT (p.roles = '{app_authenticated}'::name[]
              AND ((p.policyname = 'school_units_admin_all' AND p.cmd = 'ALL'
                    AND p.qual LIKE '%SCHOOL_ADMIN%' AND p.with_check LIKE '%SCHOOL_ADMIN%')
                OR (p.policyname = 'school_units_service_select' AND p.cmd = 'SELECT'
                    AND p.qual LIKE '%current_service_school_id()%')
                OR (p.policyname = 'school_units_sync_select' AND p.cmd = 'SELECT'
                    AND p.qual LIKE '%current_sync_school_id()%')));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'SCHOOL_UNITS_REACH: these arms reach SchoolUnits beyond the admin, the service and the sync read: %', bad;
  END IF;
END
$$;
