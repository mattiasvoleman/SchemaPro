-- En tjänst som ändras under året lämnas ut som en Duty per period.
--
-- The SS12000 providers emit a post that changes during the year
-- (TeacherEmploymentPeriods, 20261022120000) as one Duty per stretch of the
-- year in which its grad stays the same whole percent — where the school
-- shares employment with integrations (src/integration/ss12000-duties.ts,
-- toSs12000Duties). The first stretch keeps the post's id; a period's
-- stretch is the period's id; the post's own figures after a period are
-- app.ss12000_after_id(that period). This migration makes the versions and
-- the tombstones (20261014130000) follow those ids: an id that starts being
-- emitted is unburied and versioned, one that stops is buried, and every
-- change to what they carry moves their meta.modified — and nothing else
-- does. No table changes. One existing function does: app.ss12000_bump,
-- which every trigger calls with a post's id when the post's Duty changes,
-- now bumps the post's stretches with it. The new triggers sit beside the
-- old.
--
-- ## The ids, the database's and the gateway's
--
-- app.ss12000_duty_stretches walks a post's periods exactly as dutySegments
-- does: clamped to the läsår, by Från, stretches next to each other whose
-- grad rounds to the same whole percent made one (a Duty's dutyPercent is an
-- integer), the first stretch the post's own. app.ss12000_split_duty_ids is
-- its ids beyond the first, and empty when the post is emitted as one Duty:
-- no periods that change the grad, the school not sharing, the year not
-- active, the teacher inactive, or the teacher under a source's Duty id
-- (app.ss12000_duty_id is not the post's). app.ss12000_uuid_v3 is
-- src/integration/ss12000-v2/ids.ts uuidV3: RFC 4122 version 3, MD5 over
-- SchemaPro's SS12000 namespace and the name, since md5() needs no
-- extension. scripts/test/probe-ss12000-provider.ts compares the two
-- through a real database.
--
-- ## When the set of ids moves
--
-- app.ss12000_reconcile_split_duties takes the posts that may have moved:
-- it buries every derived id of theirs the provider has versioned and no
-- longer emits (never one it never emitted, and never one already buried),
-- unburies what it emits now, and bumps the post's Duty and so its
-- stretches. A write to a period calls it only when the post's stretches —
-- ids, dates, grad — are not what they were before the write: a period that
-- changes only the nedsättning or the target, or adds a stretch with the
-- grad around it, moves no Duty, so meta.modified tells nobody that it was
-- written (20261014140000 keeps the same promise for the post itself); a
-- post deleted with its periods has their stretches buried. A
-- post's grad, teacher or year, the school's opt-in or annual hours, a
-- teacher's isActive, a duty link and a year's activation or dates call it
-- too. Everything else a Duty carries — the signature, the avtalsform, the
-- person, the skolenhet, the mentorskap — is the post's, and the triggers
-- that bump the post's Duty for it bump its stretches through
-- app.ss12000_bump. A school that does not share bumps nothing here.
--
-- ## The posts split already
--
-- The periods are on main before this migration. A post a period already
-- splits gets its stretches versioned as this migration runs, and its own
-- Duty bumped (its end date moves), so a consumer reading what changed
-- since its last sync is told (app.ss12000_version_split_duties). The
-- gateway that emits the stretches deploys after the migration: a consumer
-- that reads in between is told again if the owner runs
-- SELECT app.ss12000_version_split_duties() once the gateway is up. It
-- bumps nothing a school does not share, and nothing twice in one call.
--
-- ## Grants
--
-- Every function here is the trigger functions' alone: EXECUTE is revoked
-- from PUBLIC and from every API role, and SS12000_PROVIDER_HELPERS_REACH
-- below asserts it, as 20261014140000 does for the older helpers. RLS
-- section 105 asserts the same, and what the triggers write.

CREATE FUNCTION app.ss12000_uuid_v3(p_name text) RETURNS uuid
LANGUAGE sql IMMUTABLE SET search_path = "public", "pg_temp" AS $$
  SELECT (substr(h, 1, 12) || '3' || substr(h, 14, 3)
          || to_hex((('x' || substr(h, 17, 1))::bit(4)::int & 3) | 8)
          || substr(h, 18, 15))::uuid
    FROM (SELECT md5(decode('5c1e2f7a0b944d3e9a517c2d8e6f4b10', 'hex') || convert_to(p_name, 'UTF8')) AS h) x
$$;

CREATE FUNCTION app.ss12000_after_id(p_period uuid) RETURNS uuid
LANGUAGE sql IMMUTABLE SET search_path = "public", "pg_temp" AS $$
  SELECT app.ss12000_uuid_v3('duty-after:' || lower(p_period::text))
$$;

-- Whether the post is emitted on its own id, by a school that shares, in the
-- active year, for an active teacher: the posts a period can split.
CREATE FUNCTION app.ss12000_split_capable(p_employment uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT EXISTS (
    SELECT 1 FROM "TeacherEmployments" e
      JOIN "Users" u ON u."id" = e."userId" AND u."isActive"
     WHERE e."id" = p_employment
       AND coalesce((SELECT p."shareEmploymentWithIntegrations" FROM "StaffingPolicies" p WHERE p."schoolId" = e."schoolId"), false)
       AND e."academicYearId" = app.ss12000_active_year(e."schoolId")
       AND app.ss12000_duty_id(e."schoolId", e."userId", e."academicYearId") = e."id")
$$;

-- A post's periods as app.ss12000_duty_stretches reads them, but those named.
CREATE FUNCTION app.ss12000_periods_json(p_employment uuid, p_except uuid[]) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', q."id", 'f', q."validFrom"::date, 't', q."validTo"::date, 'pct', q."employmentPercent")), '[]'::jsonb)
    FROM "TeacherEmploymentPeriods" q
   WHERE q."employmentId" = p_employment
     AND NOT (q."id" = ANY (coalesce(p_except, ARRAY[]::uuid[])))
$$;

-- A post's stretches as the gateway emits them (dutySegments), each
-- 'id|from|to|grad', from periods given as jsonb [{id, f, t, pct}]: so a
-- trigger can ask what they were before a write as well as what they are.
-- A merged stretch keeps its first part's grad, as dutySegments does.
CREATE FUNCTION app.ss12000_duty_stretches(p_employment uuid, p_periods jsonb) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  e record;
  y record;
  p record;
  piece_id uuid[] := ARRAY[]::uuid[];
  piece_from date[] := ARRAY[]::date[];
  piece_to date[] := ARRAY[]::date[];
  piece_pct numeric[] := ARRAY[]::numeric[];
  cursor_day date;
  after_period uuid := NULL;
  stretches text[] := ARRAY[]::text[];
  cur_id uuid := NULL;
  cur_from date;
  cur_to date;
  cur_pct numeric;
BEGIN
  SELECT x."employmentPercent" AS pct, x."academicYearId" AS yr INTO e FROM "TeacherEmployments" x WHERE x."id" = p_employment;
  IF NOT FOUND THEN
    RETURN stretches;
  END IF;
  SELECT a."startDate"::date AS s, a."endDate"::date AS t INTO y FROM "AcademicYears" a WHERE a."id" = e.yr;
  cursor_day := y.s;
  -- The pieces: the post's own figures between and around its periods, and each period.
  FOR p IN
    SELECT q.id, greatest(q.f, y.s) AS f, least(coalesce(q.t, y.t), y.t) AS t, q.pct
      FROM jsonb_to_recordset(coalesce(p_periods, '[]'::jsonb)) AS q(id uuid, f date, t date, pct numeric)
     ORDER BY 2, 1
  LOOP
    CONTINUE WHEN p.f > p.t;
    IF p.f > cursor_day THEN
      piece_id := piece_id || coalesce(app.ss12000_after_id(after_period), p_employment);
      piece_from := piece_from || cursor_day;
      piece_to := piece_to || (p.f - 1);
      piece_pct := piece_pct || e.pct;
    END IF;
    piece_id := piece_id || p.id;
    piece_from := piece_from || p.f;
    piece_to := piece_to || p.t;
    piece_pct := piece_pct || p.pct;
    after_period := p.id;
    cursor_day := p.t + 1;
  END LOOP;
  IF cursor_day <= y.t THEN
    piece_id := piece_id || coalesce(app.ss12000_after_id(after_period), p_employment);
    piece_from := piece_from || cursor_day;
    piece_to := piece_to || y.t;
    piece_pct := piece_pct || e.pct;
  END IF;
  -- Pieces next to each other whose grad is the same whole percent are one;
  -- the first stretch is the post's own.
  FOR i IN 1 .. coalesce(array_length(piece_id, 1), 0) LOOP
    IF cur_id IS NOT NULL AND round(cur_pct) = round(piece_pct[i]) THEN
      cur_to := piece_to[i];
    ELSE
      IF cur_id IS NOT NULL THEN
        stretches := stretches || concat_ws('|', cur_id, cur_from, cur_to, trim_scale(cur_pct));
      END IF;
      cur_id := CASE WHEN cur_id IS NULL THEN p_employment ELSE piece_id[i] END;
      cur_from := piece_from[i];
      cur_to := piece_to[i];
      cur_pct := piece_pct[i];
    END IF;
  END LOOP;
  IF cur_id IS NOT NULL THEN
    stretches := stretches || concat_ws('|', cur_id, cur_from, cur_to, trim_scale(cur_pct));
  END IF;
  RETURN stretches;
END
$$;

-- The Duty ids the post emits beside its own: dutySegments' ids, in SQL.
CREATE FUNCTION app.ss12000_split_duty_ids(p_employment uuid) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT CASE WHEN app.ss12000_split_capable(p_employment) THEN ARRAY(
           SELECT split_part(s.v, '|', 1)::uuid
             FROM unnest(app.ss12000_duty_stretches(p_employment, app.ss12000_periods_json(p_employment, NULL)))
                  WITH ORDINALITY AS s(v, i)
            WHERE s.i > 1
            ORDER BY s.i)
         ELSE ARRAY[]::uuid[] END
$$;

-- A post's Duty is every Duty it is emitted as: what moves the post's moves
-- its stretches. 20261014130000's function, with that one addition.
CREATE OR REPLACE FUNCTION app.ss12000_bump(p_school uuid, p_resource text, p_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  ids uuid[] := p_ids;
BEGIN
  IF p_school IS NULL OR p_ids IS NULL OR cardinality(p_ids) = 0
     OR NOT EXISTS (SELECT 1 FROM "Schools" s WHERE s."id" = p_school) THEN
    RETURN;
  END IF;
  IF p_resource = 'Duty' THEN
    ids := ids || ARRAY(
      SELECT i FROM "TeacherEmployments" e, unnest(app.ss12000_split_duty_ids(e."id")) i
       WHERE e."id" = ANY (p_ids) AND e."schoolId" = p_school);
  END IF;
  INSERT INTO "Ss12000EntityVersions" AS v ("schoolId", "resource", "entityId", "createdAt", "modifiedAt", "xid")
  SELECT p_school, p_resource, d.id, now(), now(), pg_current_xact_id()
    FROM (SELECT DISTINCT x AS id FROM unnest(ids) x WHERE x IS NOT NULL) d
  ON CONFLICT ("schoolId", "resource", "entityId") DO UPDATE
     SET "modifiedAt" = EXCLUDED."modifiedAt", "xid" = EXCLUDED."xid"
   WHERE v."xid" IS DISTINCT FROM EXCLUDED."xid";
END
$$;

CREATE FUNCTION app.ss12000_reconcile_split_duties(p_school uuid, p_employments uuid[], p_gone uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  posts uuid[];
  now_ids uuid[];
  candidates uuid[];
BEGIN
  IF p_school IS NULL THEN
    RETURN;
  END IF;
  posts := ARRAY(SELECT DISTINCT x FROM unnest(coalesce(p_employments, ARRAY[]::uuid[])) x WHERE x IS NOT NULL);
  now_ids := ARRAY(SELECT DISTINCT i FROM unnest(posts) e, unnest(app.ss12000_split_duty_ids(e)) i);
  candidates := ARRAY(
    SELECT x FROM unnest(coalesce(p_gone, ARRAY[]::uuid[])) x WHERE x IS NOT NULL
    UNION SELECT q."id" FROM "TeacherEmploymentPeriods" q WHERE q."employmentId" = ANY (posts)
    UNION SELECT app.ss12000_after_id(q."id") FROM "TeacherEmploymentPeriods" q WHERE q."employmentId" = ANY (posts));
  PERFORM app.ss12000_bury(p_school, 'Duty', ARRAY(
    SELECT v."entityId" FROM "Ss12000EntityVersions" v
     WHERE v."schoolId" = p_school AND v."resource" = 'Duty'
       AND v."entityId" = ANY (candidates) AND NOT (v."entityId" = ANY (now_ids))
       AND NOT EXISTS (
         SELECT 1 FROM "Ss12000Tombstones" t
          WHERE t."schoolId" = p_school AND t."resource" = 'Duty' AND t."emittedId" = v."entityId")));
  PERFORM app.ss12000_unbury(p_school, 'Duty', now_ids);
  -- The post's Duty, and through app.ss12000_bump its stretches.
  PERFORM app.ss12000_bump(p_school, 'Duty', ARRAY(SELECT x FROM unnest(posts) x WHERE app.ss12000_split_capable(x)));
END
$$;

-- The posts of a year with periods, for a reconcile over a school or a year.
CREATE FUNCTION app.ss12000_posts_with_periods(p_school uuid, p_year uuid, p_users uuid[]) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT ARRAY(
    SELECT DISTINCT q."employmentId" FROM "TeacherEmploymentPeriods" q
     WHERE q."schoolId" = p_school
       AND (p_year IS NULL OR q."academicYearId" = p_year)
       AND (p_users IS NULL OR q."userId" = ANY (p_users)))
$$;

-- ---------------------------------------------------------------------------
-- The trigger functions.
-- ---------------------------------------------------------------------------

-- A write to periods: for each post it touched that can be split, the
-- stretches before the write (the periods now, those written taken out and
-- what they were put back) against the stretches now. Only a post whose
-- stretches differ is reconciled; what it emitted before is what may be
-- buried. A post that cannot be split — deleted, its periods going with
-- it — has what its written periods named buried, if it was emitted.
CREATE FUNCTION app.ss12000_v_split_periods() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  r record;
  written uuid[] := ARRAY[]::uuid[];
  was jsonb := '[]'::jsonb;
  before_stretches text[];
  ids uuid[];
  moved_school uuid[] := ARRAY[]::uuid[];
  moved_post uuid[] := ARRAY[]::uuid[];
  gone_school uuid[] := ARRAY[]::uuid[];
  gone_id uuid[] := ARRAY[]::uuid[];
  school_id uuid;
BEGIN
  IF TG_OP <> 'DELETE' THEN
    SELECT coalesce(array_agg(x."id"), ARRAY[]::uuid[]) INTO written FROM n x;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'id', x."id", 'post', x."employmentId", 'school', x."schoolId",
             'f', x."validFrom"::date, 't', x."validTo"::date, 'pct', x."employmentPercent")), '[]'::jsonb)
      INTO was FROM o x;
  END IF;
  FOR r IN
    SELECT DISTINCT q.school, q.post FROM (
      SELECT x."schoolId" AS school, x."employmentId" AS post FROM "TeacherEmploymentPeriods" x WHERE x."id" = ANY (written)
      UNION SELECT (j->>'school')::uuid, (j->>'post')::uuid FROM jsonb_array_elements(was) j) q
  LOOP
    IF NOT app.ss12000_split_capable(r.post) THEN
      -- Nothing it emits moves. But a post deleted takes its periods with
      -- it, and what they emitted while it could be split is buried: only
      -- an id with a version, so a school that never shared buries nothing.
      ids := ARRAY(
        SELECT (j->>'id')::uuid FROM jsonb_array_elements(was) j WHERE (j->>'post')::uuid = r.post
        UNION SELECT app.ss12000_after_id((j->>'id')::uuid) FROM jsonb_array_elements(was) j WHERE (j->>'post')::uuid = r.post);
    ELSE
      before_stretches := app.ss12000_duty_stretches(r.post,
        app.ss12000_periods_json(r.post, written)
        || coalesce((SELECT jsonb_agg(j) FROM jsonb_array_elements(was) j WHERE (j->>'post')::uuid = r.post), '[]'::jsonb));
      CONTINUE WHEN before_stretches IS NOT DISTINCT FROM app.ss12000_duty_stretches(r.post, app.ss12000_periods_json(r.post, NULL));
      ids := ARRAY(SELECT split_part(s.v, '|', 1)::uuid FROM unnest(before_stretches) WITH ORDINALITY AS s(v, i) WHERE s.i > 1);
    END IF;
    moved_school := moved_school || r.school;
    moved_post := moved_post || r.post;
    gone_id := gone_id || ids;
    gone_school := gone_school || array_fill(r.school, ARRAY[cardinality(ids)]);
  END LOOP;
  -- One reconcile per school over every post the statement moved: an id one
  -- of them stops emitting while another starts (a period moved from one
  -- post to another) is emitted, so not buried, whatever order they came in.
  FOR school_id IN SELECT DISTINCT x FROM unnest(moved_school) x LOOP
    PERFORM app.ss12000_reconcile_split_duties(school_id,
      ARRAY(SELECT u.p FROM unnest(moved_school, moved_post) AS u(sc, p) WHERE u.sc = school_id),
      ARRAY(SELECT u.g FROM unnest(gone_school, gone_id) AS u(sc, g) WHERE u.sc = school_id));
  END LOOP;
  RETURN NULL;
END
$$;

CREATE FUNCTION app.ss12000_v_split_employments() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT x."schoolId" s, array_agg(x."id") posts FROM n x JOIN o y ON y."id" = x."id"
     WHERE (x."employmentPercent", x."userId", x."academicYearId") IS DISTINCT FROM (y."employmentPercent", y."userId", y."academicYearId")
     GROUP BY 1
  LOOP
    PERFORM app.ss12000_reconcile_split_duties(r.s, r.posts, NULL);
  END LOOP;
  RETURN NULL;
END
$$;

CREATE FUNCTION app.ss12000_v_split_policies() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR r IN SELECT DISTINCT x."schoolId" s FROM n x WHERE x."shareEmploymentWithIntegrations" LOOP
      PERFORM app.ss12000_reconcile_split_duties(r.s, app.ss12000_posts_with_periods(r.s, app.ss12000_active_year(r.s), NULL), NULL);
    END LOOP;
  ELSE
    FOR r IN
      SELECT DISTINCT x."schoolId" s FROM n x JOIN o y ON y."id" = x."id"
       WHERE x."shareEmploymentWithIntegrations" IS DISTINCT FROM y."shareEmploymentWithIntegrations"
          OR (x."shareEmploymentWithIntegrations" AND x."fullTimeAnnualHours" IS DISTINCT FROM y."fullTimeAnnualHours")
    LOOP
      PERFORM app.ss12000_reconcile_split_duties(r.s, app.ss12000_posts_with_periods(r.s, app.ss12000_active_year(r.s), NULL), NULL);
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION app.ss12000_v_split_users() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT x."schoolId" s, array_agg(x."id") users FROM n x JOIN o y ON y."id" = x."id"
     WHERE x."isActive" IS DISTINCT FROM y."isActive" AND x."schoolId" IS NOT NULL
     GROUP BY 1
  LOOP
    PERFORM app.ss12000_reconcile_split_duties(r.s, app.ss12000_posts_with_periods(r.s, NULL, r.users), NULL);
  END LOOP;
  RETURN NULL;
END
$$;

-- A duty link moves the teacher's Duty id to the source's (A5.5): the
-- teacher's posts are reconciled.
CREATE FUNCTION app.ss12000_v_split_teachers() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record;
BEGIN
  IF TG_OP <> 'DELETE' THEN
    FOR r IN SELECT x."schoolId" s, array_agg(DISTINCT x."userId") users FROM n x GROUP BY 1 LOOP
      PERFORM app.ss12000_reconcile_split_duties(r.s, app.ss12000_posts_with_periods(r.s, NULL, r.users), NULL);
    END LOOP;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    FOR r IN SELECT x."schoolId" s, array_agg(DISTINCT x."userId") users FROM o x GROUP BY 1 LOOP
      PERFORM app.ss12000_reconcile_split_duties(r.s, app.ss12000_posts_with_periods(r.s, NULL, r.users), NULL);
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION app.ss12000_v_split_years() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT x."schoolId" s, x."id" y FROM n x JOIN o z ON z."id" = x."id"
     WHERE (x."isActive", x."startDate", x."endDate") IS DISTINCT FROM (z."isActive", z."startDate", z."endDate")
  LOOP
    PERFORM app.ss12000_reconcile_split_duties(r.s, app.ss12000_posts_with_periods(r.s, r.y, NULL), NULL);
  END LOOP;
  RETURN NULL;
END
$$;

DO $$
DECLARE spec record;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('TeacherEmploymentPeriods', 'app.ss12000_v_split_periods()', true, true, true),
      ('TeacherEmployments', 'app.ss12000_v_split_employments()', false, true, false),
      ('StaffingPolicies', 'app.ss12000_v_split_policies()', true, true, false),
      ('Users', 'app.ss12000_v_split_users()', false, true, false),
      ('Ss12000DutyLinks', 'app.ss12000_v_split_teachers()', true, true, true),
      ('AcademicYears', 'app.ss12000_v_split_years()', false, true, false)
    ) AS t(tbl, fn, on_insert, on_update, on_delete)
  LOOP
    IF spec.on_insert THEN
      EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON %I REFERENCING NEW TABLE AS n FOR EACH STATEMENT EXECUTE FUNCTION %s',
                     spec.tbl || '_ss12000_split_ins', spec.tbl, spec.fn);
    END IF;
    IF spec.on_update THEN
      EXECUTE format('CREATE TRIGGER %I AFTER UPDATE ON %I REFERENCING OLD TABLE AS o NEW TABLE AS n FOR EACH STATEMENT EXECUTE FUNCTION %s',
                     spec.tbl || '_ss12000_split_upd', spec.tbl, spec.fn);
    END IF;
    IF spec.on_delete THEN
      EXECUTE format('CREATE TRIGGER %I AFTER DELETE ON %I REFERENCING OLD TABLE AS o FOR EACH STATEMENT EXECUTE FUNCTION %s',
                     spec.tbl || '_ss12000_split_del', spec.tbl, spec.fn);
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- The posts split already: their stretches versioned, their own Duty bumped.
-- Outside a trigger, so under app.ss12000_housekeeping for the transaction,
-- and the setting put back. It returns how many posts it bumped.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.ss12000_version_split_duties() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  r record;
  bumped integer := 0;
  was text := current_setting('app.ss12000_housekeeping', true);
BEGIN
  PERFORM set_config('app.ss12000_housekeeping', 'on', true);
  FOR r IN
    SELECT e."schoolId" AS s, array_agg(e."id") AS posts
      FROM "TeacherEmployments" e
     WHERE EXISTS (SELECT 1 FROM "TeacherEmploymentPeriods" q WHERE q."employmentId" = e."id")
       AND cardinality(app.ss12000_split_duty_ids(e."id")) > 0
     GROUP BY 1
  LOOP
    PERFORM app.ss12000_bump(r.s, 'Duty', r.posts);
    bumped := bumped + cardinality(r.posts);
  END LOOP;
  PERFORM set_config('app.ss12000_housekeeping', coalesce(was, ''), true);
  RETURN bumped;
END
$$;

DO $$
BEGIN
  PERFORM app.ss12000_version_split_duties();
END
$$;

-- ---------------------------------------------------------------------------
-- The helpers and trigger functions are the triggers' alone.
-- ---------------------------------------------------------------------------

DO $$
DECLARE fn text; r text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'app.ss12000_uuid_v3(text)',
    'app.ss12000_after_id(uuid)',
    'app.ss12000_split_capable(uuid)',
    'app.ss12000_periods_json(uuid, uuid[])',
    'app.ss12000_duty_stretches(uuid, jsonb)',
    'app.ss12000_split_duty_ids(uuid)',
    'app.ss12000_bump(uuid, text, uuid[])',
    'app.ss12000_reconcile_split_duties(uuid, uuid[], uuid[])',
    'app.ss12000_posts_with_periods(uuid, uuid, uuid[])',
    'app.ss12000_version_split_duties()',
    'app.ss12000_v_split_periods()',
    'app.ss12000_v_split_employments()',
    'app.ss12000_v_split_policies()',
    'app.ss12000_v_split_users()',
    'app.ss12000_v_split_teachers()',
    'app.ss12000_v_split_years()'
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

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(format('%s by %s', p.oid::regprocedure, r.rolname), ', ' ORDER BY 1) INTO bad
    FROM pg_proc p
    JOIN pg_namespace ns ON ns.oid = p.pronamespace AND ns.nspname = 'app'
    CROSS JOIN pg_roles r
   WHERE r.rolname IN ('anon', 'authenticated', 'service_role', 'app_authenticated')
     AND p.proname IN ('ss12000_uuid_v3', 'ss12000_after_id', 'ss12000_split_capable', 'ss12000_periods_json',
                       'ss12000_duty_stretches', 'ss12000_split_duty_ids', 'ss12000_bump',
                       'ss12000_reconcile_split_duties', 'ss12000_posts_with_periods',
                       'ss12000_version_split_duties', 'ss12000_v_split_periods',
                       'ss12000_v_split_employments', 'ss12000_v_split_policies', 'ss12000_v_split_users',
                       'ss12000_v_split_teachers', 'ss12000_v_split_years')
     AND has_function_privilege(r.oid, p.oid, 'EXECUTE');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'SS12000_PROVIDER_HELPERS_REACH: these provider helpers are executable by an API role: %', bad;
  END IF;
END
$$;
