-- En tjänst som ändras under året lämnas ut som en Duty per period.
--
-- The SS12000 providers emit a post that changes during the year
-- (TeacherEmploymentPeriods, 20261022120000) as one Duty per stretch of the
-- year in which its grad stays the same — where the school shares employment
-- with integrations (src/integration/ss12000-duties.ts, toSs12000Duties).
-- The first stretch keeps the post's id; a period's stretch is the period's
-- id; the post's own figures after a period are app.ss12000_after_id(that
-- period). This migration makes the versions and the tombstones
-- (20261014130000) follow those ids: an id that starts being emitted is
-- unburied and versioned, one that stops is buried, and every change to
-- what they carry moves their meta.modified. Nothing in an existing table,
-- function or trigger changes; the new triggers sit beside the old.
--
-- ## The ids, the database's and the gateway's
--
-- app.ss12000_split_duty_ids walks a post's periods exactly as dutySegments
-- does: clamped to the läsår, by Från, stretches with the same grad next to
-- each other made one, the first stretch the post's own. Empty when the
-- post is emitted as one Duty: no periods that change the grad, the school
-- not sharing, the year not active, the teacher inactive, or the teacher
-- under a source's Duty id (app.ss12000_duty_id is not the post's).
-- app.ss12000_uuid_v3 is src/integration/ss12000-v2/ids.ts uuidV3: RFC 4122
-- version 3, MD5 over SchemaPro's SS12000 namespace and the name, since
-- md5() needs no extension. scripts/test/probe-ss12000-provider.ts compares
-- the two through a real database.
--
-- ## When the set of ids moves
--
-- app.ss12000_reconcile_split_duties takes the posts that may have moved:
-- it buries every derived id of theirs the provider has versioned and no
-- longer emits (never one it never emitted, and never one already buried),
-- unburies what it emits now, and bumps those and, where the post can be
-- split at all, the post's own Duty, whose end date moves with its first
-- period. It is called after a write to: a period; a post's grad, teacher
-- or year; the school's opt-in or its annual hours; a teacher's isActive; a
-- duty link; a year's activation or dates; a mentorskap (the Duties carry
-- it, clipped to their dates). A school that does not share bumps nothing
-- here: a period is HR data, and with the opt-in off no Duty moves for it.
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

-- The Duty ids the post emits beside its own: dutySegments, in SQL.
CREATE FUNCTION app.ss12000_split_duty_ids(p_employment uuid) RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  e record;
  y record;
  p record;
  ids uuid[] := ARRAY[]::uuid[];
  cursor_day date;
  last_percent numeric;
  after_period uuid := NULL;
  started boolean := false;
BEGIN
  IF NOT app.ss12000_split_capable(p_employment) THEN
    RETURN ids;
  END IF;
  SELECT x."employmentPercent", x."academicYearId" INTO e FROM "TeacherEmployments" x WHERE x."id" = p_employment;
  SELECT a."startDate"::date s, a."endDate"::date t INTO y FROM "AcademicYears" a WHERE a."id" = e."academicYearId";
  cursor_day := y.s;
  FOR p IN
    SELECT q."id", greatest(q."validFrom"::date, y.s) f, least(coalesce(q."validTo"::date, y.t), y.t) t, q."employmentPercent" pct
      FROM "TeacherEmploymentPeriods" q
     WHERE q."employmentId" = p_employment
     ORDER BY 2
  LOOP
    CONTINUE WHEN p.f > p.t;
    -- The post's own figures before this period.
    IF p.f > cursor_day THEN
      IF NOT started THEN
        started := true;
        last_percent := e."employmentPercent";
      ELSIF e."employmentPercent" IS DISTINCT FROM last_percent THEN
        ids := ids || app.ss12000_after_id(after_period);
        last_percent := e."employmentPercent";
      END IF;
    END IF;
    -- The period.
    IF NOT started THEN
      started := true;
      last_percent := p.pct;
    ELSIF p.pct IS DISTINCT FROM last_percent THEN
      ids := ids || p."id";
      last_percent := p.pct;
    END IF;
    after_period := p."id";
    cursor_day := p.t + 1;
  END LOOP;
  -- The post's own figures after the last period.
  IF started AND cursor_day <= y.t AND e."employmentPercent" IS DISTINCT FROM last_percent THEN
    ids := ids || app.ss12000_after_id(after_period);
  END IF;
  RETURN ids;
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
  PERFORM app.ss12000_bump(p_school, 'Duty', now_ids || ARRAY(SELECT x FROM unnest(posts) x WHERE app.ss12000_split_capable(x)));
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

CREATE FUNCTION app.ss12000_v_split_periods() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record;
BEGIN
  IF TG_OP <> 'DELETE' THEN
    FOR r IN SELECT x."schoolId" s, array_agg(DISTINCT x."employmentId") posts FROM n x GROUP BY 1 LOOP
      PERFORM app.ss12000_reconcile_split_duties(r.s, r.posts, NULL);
    END LOOP;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    FOR r IN
      SELECT x."schoolId" s, array_agg(DISTINCT x."employmentId") posts,
             array_agg(x."id") || array_agg(app.ss12000_after_id(x."id")) gone
        FROM o x GROUP BY 1
    LOOP
      PERFORM app.ss12000_reconcile_split_duties(r.s, r.posts, r.gone);
    END LOOP;
  END IF;
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

-- A mentorskap is the one uppdrag a Duty carries (its assignmentRole); no
-- other uppdrag moves a Duty, here as in app.ss12000_v_teacher_duties.
CREATE FUNCTION app.ss12000_v_split_mentorships() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record;
BEGIN
  IF TG_OP <> 'DELETE' THEN
    FOR r IN SELECT x."schoolId" s, array_agg(DISTINCT x."userId") users FROM n x WHERE x."kind" = 'MENTORSKAP' GROUP BY 1 LOOP
      PERFORM app.ss12000_reconcile_split_duties(r.s, app.ss12000_posts_with_periods(r.s, NULL, r.users), NULL);
    END LOOP;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    FOR r IN SELECT x."schoolId" s, array_agg(DISTINCT x."userId") users FROM o x WHERE x."kind" = 'MENTORSKAP' GROUP BY 1 LOOP
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
      ('TeacherDuties', 'app.ss12000_v_split_mentorships()', true, true, true),
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
-- The helpers and trigger functions are the triggers' alone.
-- ---------------------------------------------------------------------------

DO $$
DECLARE fn text; r text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'app.ss12000_uuid_v3(text)',
    'app.ss12000_after_id(uuid)',
    'app.ss12000_split_capable(uuid)',
    'app.ss12000_split_duty_ids(uuid)',
    'app.ss12000_reconcile_split_duties(uuid, uuid[], uuid[])',
    'app.ss12000_posts_with_periods(uuid, uuid, uuid[])',
    'app.ss12000_v_split_periods()',
    'app.ss12000_v_split_employments()',
    'app.ss12000_v_split_policies()',
    'app.ss12000_v_split_users()',
    'app.ss12000_v_split_teachers()',
    'app.ss12000_v_split_mentorships()',
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
     AND p.proname IN ('ss12000_uuid_v3', 'ss12000_after_id', 'ss12000_split_capable', 'ss12000_split_duty_ids',
                       'ss12000_reconcile_split_duties', 'ss12000_posts_with_periods', 'ss12000_v_split_periods',
                       'ss12000_v_split_employments', 'ss12000_v_split_policies', 'ss12000_v_split_users',
                       'ss12000_v_split_teachers', 'ss12000_v_split_mentorships', 'ss12000_v_split_years')
     AND has_function_privilege(r.oid, p.oid, 'EXECUTE');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'SS12000_PROVIDER_HELPERS_REACH: these provider helpers are executable by an API role: %', bad;
  END IF;
END
$$;
