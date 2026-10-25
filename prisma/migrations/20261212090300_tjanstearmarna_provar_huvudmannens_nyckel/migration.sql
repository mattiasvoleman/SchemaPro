-- Huvudmannens nyckel skriver inget, och tjänstens skola prövas i databasen.
--
-- 20261212090000 opens a school for a huvudman's SS12000 key by setting
-- app.service_school_id (app.huvudman_key_opens_school), beside
-- app.service_huvudman_key_id, so that the key reads the school as the
-- school's own key does, through the same arms. This migration closes the
-- rest in the database, so that a fault in the gateway's loop over the
-- schools cannot open another school, and the key cannot write:
--
-- ## app.current_service_school_id() asks whether the huvudman owns it
--
-- It was LANGUAGE sql, the setting alone. It is now SECURITY DEFINER
-- (STABLE, search_path public, pg_temp), and:
--
--   * with no huvudman's key set (app.service_huvudman_key_id empty: every
--     school key, the sync, the jobs) it answers the setting at once and
--     reads no table, as before;
--   * with a huvudman's key set, the setting only while that key is live
--     and its huvudman owns the school; NULL otherwise, so every service
--     arm and every function that asks it is closed for that school.
--
-- EXECUTE is what it was (PUBLIC's, as every role had it before): CREATE OR
-- REPLACE keeps the grants. 19 functions call it in their bodies; they get
-- the same answer for a school's own key and the check for a huvudman's.
--
-- ## The 36 arms that ask it ask it once
--
-- 35 of the 36 policies that name app.current_service_school_id() called it
-- row by row; a SECURITY DEFINER function there would be a call per row.
-- Each is rewritten to the initplan, (SELECT app.current_service_school_id()),
-- by the catalogue's own text: only the call changes, every other word of
-- the expression is what pg_policies prints. RLS section 266 measures the
-- same rows for the school's principal and the key's before and after.
--
-- ## The key writes nothing
--
-- Four of the arms write, for the SS12000 sync and the provider's
-- subscriptions' bookkeeping:
--
--   users_service_update              UPDATE "Users"
--   guardian_students_service_insert  INSERT "GuardianStudents"
--   guardian_students_service_update  UPDATE "GuardianStudents"
--   student_groups_service_insert     INSERT "StudentGroups"
--
-- (The subscriptions' two also ask app.current_service_key_id(), the
-- school's own key, which a huvudman's key never sets.) Each asked only for
-- the school, so a huvudman's key's transaction at a school its huvudman
-- owns passed them; the gateway's routes for the key are reads, and that
-- was all that held the key to reading. Each now also asks that no
-- huvudman's key is set. RLS section 266 tries each, for the key and for
-- the school's own principal.
--
-- ## Three functions that took any service principal, or any administrator
--
--   * app.leave_requests_tell_new_mentors() wrote the mentors' notices and
--     answered their addresses for any service principal: a huvudman's key,
--     opened for a school, is now no principal there (no route asks it so);
--   * app.ss12000_source_secrets() handed the source's encrypted secrets to
--     any administrator, the läsare and the huvudman's reader included: now
--     only to one who writes the integrations (the sync runs as before);
--   * app.ss12000_is_delivery_context() took "no user id" for the delivery
--     job: it now also asks for no claims at all and no huvudman's key.
--
-- RLS section 266 asks each.
--
-- ## Beside the live API
--
-- ALTER POLICY takes ACCESS EXCLUSIVE on its table: the 30 tables of the 36
-- arms (and the table of any arm a phase merged before this one adds,
-- which is rewritten alike), NOWAIT and together in a loop, as
-- 20261212090000. A refusal rolls
-- the subtransaction back with whatever it got and tries again 50 ms later,
-- so the migration never waits while it holds a lock and no request queues
-- behind it; once it holds them all it changes the catalogue only, in
-- milliseconds; after 30 s it stops with nothing changed (prisma migrate
-- resolve --rolled-back, then deploy). Run it outside the SS12000 sync's
-- window. The API before this release works on it unchanged: with no
-- huvudman's key the function and every arm answer what they did.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
  t text;
  tables text[];
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  SELECT array_agg(DISTINCT p.tablename ORDER BY p.tablename) INTO tables
    FROM pg_policies p
   WHERE p.schemaname = 'public'
     AND (coalesce(p.qual, '') || coalesce(p.with_check, '')) ~ 'app\.current_service_school_id\(\)';
  -- 30 tables when this was written (36 arms); a phase that lands first
  -- with an arm of its own adds its table, and its arm is rewritten too.
  IF coalesce(cardinality(tables), 0) < 30 THEN
    RAISE EXCEPTION 'the service arms are on % tables, fewer than the 30 this migration was written for: %', cardinality(tables), tables;
  END IF;
  LOOP
    BEGIN
      FOREACH t IN ARRAY tables LOOP
        EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE NOWAIT', t);
      END LOOP;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'the % tables of the service arms were not free at once in 30 s: nothing is changed, run the migration again', cardinality(tables);
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION app.current_service_school_id() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  v_school uuid := nullif(current_setting('app.service_school_id', true), '')::uuid;
  v_key    text := nullif(current_setting('app.service_huvudman_key_id', true), '');
BEGIN
  -- A school's own key, the sync and every job: the setting, and no table.
  IF v_key IS NULL OR v_school IS NULL THEN
    RETURN v_school;
  END IF;
  -- A huvudman's key: only a school its huvudman owns, while the key lives.
  PERFORM 1
     FROM "HuvudmanApiKeys" k
     JOIN "HuvudmanSchools" hs ON hs."huvudmanId" = k."huvudmanId"
    WHERE k."id" = v_key::uuid AND k."revokedAt" IS NULL AND hs."schoolId" = v_school;
  IF FOUND THEN
    RETURN v_school;
  END IF;
  RETURN NULL;
END
$$;

COMMENT ON FUNCTION app.current_service_school_id() IS
  'The school the transaction''s service principal reads (app.service_school_id). With a huvudman''s SS12000 key set (app.service_huvudman_key_id, 20261212090300) only a school the key''s huvudman owns while the key is live, else NULL; with none, the setting as read, and no table.';

-- The 36 arms: the call, once per statement.
DO $$
DECLARE
  p record;
  bare constant text := '(?<!SELECT )app\.current_service_school_id\(\)';
  once constant text := '(SELECT app.current_service_school_id())';
  n int := 0;
BEGIN
  FOR p IN
    SELECT tablename, policyname, cmd, qual, with_check
      FROM pg_policies
     WHERE schemaname = 'public'
       AND (coalesce(qual, '') || coalesce(with_check, '')) ~ bare
     ORDER BY tablename, policyname
  LOOP
    IF p.qual IS NOT NULL AND p.with_check IS NOT NULL THEN
      EXECUTE format('ALTER POLICY %I ON public.%I USING (%s) WITH CHECK (%s)', p.policyname, p.tablename,
                     regexp_replace(p.qual, bare, once, 'g'), regexp_replace(p.with_check, bare, once, 'g'));
    ELSIF p.qual IS NOT NULL THEN
      EXECUTE format('ALTER POLICY %I ON public.%I USING (%s)', p.policyname, p.tablename,
                     regexp_replace(p.qual, bare, once, 'g'));
    ELSE
      EXECUTE format('ALTER POLICY %I ON public.%I WITH CHECK (%s)', p.policyname, p.tablename,
                     regexp_replace(p.with_check, bare, once, 'g'));
    END IF;
    n := n + 1;
  END LOOP;
  IF n < 35 THEN
    RAISE EXCEPTION 'rewrote % service arms, fewer than the 35 that called the function row by row', n;
  END IF;
  RAISE NOTICE 'the service arms: % rewritten to call app.current_service_school_id() once per statement', n;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
              AND (coalesce(qual, '') || coalesce(with_check, '')) ~ bare) THEN
    RAISE EXCEPTION 'a service arm still calls app.current_service_school_id() row by row';
  END IF;

  -- The arms' second function is run as the querying role, which needs
  -- EXECUTE. It reads one setting of the transaction's, which PostgREST
  -- cannot set.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT EXECUTE ON FUNCTION app.current_service_huvudman_key_id() TO "app_authenticated";
  END IF;
END
$$;

-- The four that write: no huvudman's key.
ALTER POLICY "users_service_update" ON "Users"
  USING ("schoolId" = (SELECT app.current_service_school_id()) AND (SELECT app.current_service_huvudman_key_id()) IS NULL)
  WITH CHECK ("schoolId" = (SELECT app.current_service_school_id()) AND (SELECT app.current_service_huvudman_key_id()) IS NULL);

ALTER POLICY "guardian_students_service_insert" ON "GuardianStudents"
  WITH CHECK ("schoolId" = (SELECT app.current_service_school_id()) AND (SELECT app.current_service_huvudman_key_id()) IS NULL);

ALTER POLICY "guardian_students_service_update" ON "GuardianStudents"
  USING ("schoolId" = (SELECT app.current_service_school_id()) AND (SELECT app.current_service_huvudman_key_id()) IS NULL)
  WITH CHECK ("schoolId" = (SELECT app.current_service_school_id()) AND (SELECT app.current_service_huvudman_key_id()) IS NULL);

ALTER POLICY "student_groups_service_insert" ON "StudentGroups"
  WITH CHECK ("schoolId" = (SELECT app.current_service_school_id()) AND (SELECT app.current_service_huvudman_key_id()) IS NULL);

-- ---------------------------------------------------------------------------
-- The three functions (see the preamble).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.leave_requests_tell_new_mentors()
 RETURNS TABLE("notificationId" uuid, "userId" uuid, email text, meta jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_sync    uuid := app.current_sync_school_id();
  -- A huvudman's key, opened for a school, is no principal here.
  v_service uuid := CASE WHEN app.current_service_huvudman_key_id() IS NULL THEN app.current_service_school_id() END;
  v_school  uuid;
BEGIN
  IF app.current_user_id() IS NOT NULL THEN
    IF v_sync IS NULL AND v_service IS NULL
       AND coalesce(app.current_user_role() IN ('TEACHER', 'SCHOOL_ADMIN'), false) THEN
      v_school := app.current_school_id();
    END IF;
  ELSIF v_sync IS NULL OR v_service IS NULL THEN
    v_school := coalesce(v_sync, v_service);
  END IF;
  IF v_school IS NULL THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('leave_tell_mentors'), hashtext(v_school::text));
  RETURN QUERY SELECT t."notificationId", t."userId", t."email", t."meta"
                 FROM app.leave_tell_mentors(v_school, NULL) AS t
                ORDER BY t."userId";
END
$function$;

CREATE OR REPLACE FUNCTION app.ss12000_source_secrets(p_source uuid)
 RETURNS TABLE(kind "Ss12000SecretKind", ciphertext bytea, iv bytea, auth_tag bytea, key_id text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  sync uuid := app.current_sync_school_id();
  school uuid;
BEGIN
  IF app.current_service_school_id() IS NOT NULL OR app.current_service_huvudman_key_id() IS NOT NULL THEN
    RAISE EXCEPTION 'SS12000_SECRET_REFUSED: integrationen läser inga hemligheter' USING ERRCODE = 'SS403';
  END IF;
  IF sync IS NOT NULL THEN
    -- The run, with nobody's claims beside it.
    IF app.current_user_id() IS NOT NULL THEN
      RAISE EXCEPTION 'SS12000_SECRET_REFUSED: en synk läser hemligheterna utan någons inloggning' USING ERRCODE = 'SS403';
    END IF;
    school := sync;
  ELSE
    -- Huvudman (20261212090300): the administrator who writes the
    -- integrations, not any: the läsare, and the huvudman's reader, read no
    -- source's secrets.
    school := app.ss12000_admin_writer_school();
  END IF;
  IF school IS NULL THEN
    RAISE EXCEPTION 'SS12000_SECRET_REFUSED: bara synken och skolans administratör läser källsystemets hemligheter' USING ERRCODE = 'SS403';
  END IF;
  RETURN QUERY
  SELECT x."kind", x."ciphertext", x."iv", x."authTag", x."keyId"
    FROM "Ss12000SourceSecrets" x
   WHERE x."sourceId" = p_source AND x."schoolId" = school
   ORDER BY x."kind";
END
$function$;

CREATE OR REPLACE FUNCTION app.ss12000_is_delivery_context()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- No user id is not enough (the huvudman's reader has none): no claims at
  -- all, no school's or huvudman's key, no sync, no key lookup.
  SELECT app.current_user_id() IS NULL
     AND NULLIF(current_setting('request.jwt.claim.sub', true), '') IS NULL
     AND NULLIF(current_setting('request.jwt.claims', true), '') IS NULL
     AND NULLIF(current_setting('app.service_school_id', true), '') IS NULL
     AND NULLIF(current_setting('app.service_huvudman_key_id', true), '') IS NULL
     AND NULLIF(current_setting('app.sync_school_id', true), '') IS NULL
     AND NOT app.is_service_key_lookup()
$function$;
