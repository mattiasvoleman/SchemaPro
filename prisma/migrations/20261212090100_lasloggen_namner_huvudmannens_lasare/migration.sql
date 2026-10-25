-- Läsloggen namnger huvudmannens läsare och huvudmannens nyckel.
--
-- Huvudman (20261212090000): a member of the huvudman reads a school it owns
-- with no Users row there, and the huvudman's SS12000 key reads it as the
-- school's service principal. Every gateway read of another person's data
-- goes through app.personal_data_read (recordRead), and the school must be
-- able to answer "who has read about this pupil" for those readers too. So
-- the school's own log gets two columns:
--
--   * "huvudmanMemberId"  the huvudman's reader (HuvudmanMembers), whose
--                         "actorId" cannot be a Users row of the school:
--                         "actorId" is NULL, "actorRole" SCHOOL_ADMIN (they
--                         read as the läsare), the channel the client's;
--   * "huvudmanApiKeyId"  the huvudman's key of an integration read, beside
--                         a NULL "apiKeyId" (which names a school's own key).
--
-- Both are NULL on every row before this, and on every row a school's own
-- people or keys write. The CHECK binds them to that shape; it is added NOT
-- VALID and validated in 20261212090200, which blocks no write.
--
-- app.personal_data_read takes the reader as before and, when no Users row
-- reads, asks app.current_huvudman_member_id(); a huvudman's key is accepted
-- only while it is live and its huvudman owns the school, else PD403 as for
-- a school's key of another school. The quarter-hour dedupe looks back over
-- the school's (schoolId, at) index for these two readers, as it does for a
-- key-less integration read: no new index, so no CONCURRENTLY file.
--
-- ## Beside the live API
--
-- The log is written by every recorded read. ADD COLUMN with no default
-- changes the catalogue only, but takes ACCESS EXCLUSIVE; the foreign keys,
-- NOT VALID, take SHARE ROW EXCLUSIVE on the two huvudman tables, which the
-- API before this release never touches. All three NOWAIT and together, in
-- 20261212090000's loop: no recorded read queues behind the migration, and
-- after 30 s it stops with nothing changed. The function is replaced with
-- the same signature and the same answers for every reader that existed, so
-- the API before this release works unchanged.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "PersonalDataAccess" IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "HuvudmanMembers" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "HuvudmanApiKeys" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'PersonalDataAccess, HuvudmanMembers and HuvudmanApiKeys were not free at once in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

ALTER TABLE "PersonalDataAccess"
    ADD COLUMN "huvudmanMemberId" UUID,
    ADD COLUMN "huvudmanApiKeyId" UUID;

ALTER TABLE "PersonalDataAccess"
    ADD CONSTRAINT "PersonalDataAccess_huvudmanMemberId_fkey"
    FOREIGN KEY ("huvudmanMemberId") REFERENCES "HuvudmanMembers"("id")
    ON DELETE SET NULL ON UPDATE NO ACTION NOT VALID;
ALTER TABLE "PersonalDataAccess"
    ADD CONSTRAINT "PersonalDataAccess_huvudmanApiKeyId_fkey"
    FOREIGN KEY ("huvudmanApiKeyId") REFERENCES "HuvudmanApiKeys"("id")
    ON DELETE SET NULL ON UPDATE NO ACTION NOT VALID;
-- The huvudman's reader is a person reading through a client, with no Users
-- row of the school; the huvudman's key is an integration, never beside a
-- school's own key.
ALTER TABLE "PersonalDataAccess"
    ADD CONSTRAINT "PersonalDataAccess_a_huvudman_reader_or_key" CHECK (
        ("huvudmanMemberId" IS NULL OR ("actorId" IS NULL AND "channel" <> 'INTEGRATION'))
        AND ("huvudmanApiKeyId" IS NULL OR ("channel" = 'INTEGRATION' AND "apiKeyId" IS NULL))
    ) NOT VALID;

COMMENT ON COLUMN "PersonalDataAccess"."huvudmanMemberId" IS
  'Huvudman (20261212090100): the huvudman''s reader who read, with no Users row of the school (actorId NULL, actorRole SCHOOL_ADMIN); NULL once the member is deleted.';
COMMENT ON COLUMN "PersonalDataAccess"."huvudmanApiKeyId" IS
  'Huvudman (20261212090100): the huvudman''s SS12000 key of an integration read (apiKeyId NULL); NULL once the key is deleted.';

-- ---------------------------------------------------------------------------
-- app.personal_data_read: 20261112091000's body, with the lines marked
-- "huvudman".
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.personal_data_read(
    p_kind "PersonalDataAccessKind",
    p_channel "PersonalDataAccessChannel",
    p_subjects uuid[]
) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  v_school  uuid := app.current_service_school_id();
  v_actor   uuid;
  v_member  uuid;  -- huvudman
  v_role    "UserRole";
  v_key     uuid;
  v_hkey    uuid;  -- huvudman
  v_channel "PersonalDataAccessChannel";
  v_since   timestamptz := clock_timestamp() - interval '15 minutes';
  v_recent  uuid[];
  v_read    uuid[];
  v_new     uuid[];
BEGIN
  IF p_kind IS NULL THEN
    RAISE EXCEPTION 'PERSONAL_DATA_READ_HAS_A_KIND' USING ERRCODE = 'PD400';
  END IF;
  IF app.current_sync_school_id() IS NOT NULL THEN
    RAISE EXCEPTION 'PERSONAL_DATA_READ_HAS_NO_READER: synken läser åt ingen'
      USING ERRCODE = 'PD403';
  END IF;
  IF v_school IS NOT NULL THEN
    v_key := app.current_service_key_id();
    v_hkey := app.current_service_huvudman_key_id();  -- huvudman
    v_channel := 'INTEGRATION';
    -- A key of another school is no key of this read.
    IF v_key IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM "IntegrationApiKeys" k WHERE k."id" = v_key AND k."schoolId" = v_school) THEN
      RAISE EXCEPTION 'PERSONAL_DATA_READ_HAS_NO_READER: nyckeln hör inte till skolan'
        USING ERRCODE = 'PD403';
    END IF;
    -- huvudman: nor is a huvudman's key that is revoked, beside a school's
    -- key, or of a huvudman that does not own the school.
    IF v_hkey IS NOT NULL AND (v_key IS NOT NULL OR NOT EXISTS (
         SELECT 1 FROM "HuvudmanApiKeys" k
           JOIN "HuvudmanSchools" hs ON hs."huvudmanId" = k."huvudmanId"
          WHERE k."id" = v_hkey AND k."revokedAt" IS NULL AND hs."schoolId" = v_school)) THEN
      RAISE EXCEPTION 'PERSONAL_DATA_READ_HAS_NO_READER: nyckeln är inte huvudmannens för skolan'
        USING ERRCODE = 'PD403';
    END IF;
  ELSE
    v_actor := app.current_user_id();
    v_school := app.current_school_id();
    v_role := app.current_user_role();
    -- huvudman: no Users row reads, so it may be the huvudman's reader.
    IF v_actor IS NULL THEN
      v_member := app.current_huvudman_member_id();
    END IF;
    IF (v_actor IS NULL AND v_member IS NULL) OR v_school IS NULL OR v_role IS NULL THEN
      RAISE EXCEPTION 'PERSONAL_DATA_READ_HAS_NO_READER: ingen inloggad läser'
        USING ERRCODE = 'PD403';
    END IF;
    v_channel := CASE WHEN p_channel IN ('WEB', 'APP') THEN p_channel ELSE 'OTHER' END;
  END IF;

  -- Who this reader (or key) already has in a row of the kind from the last
  -- quarter-hour. One branch per reader, each on its own index.
  IF v_actor IS NOT NULL THEN
    SELECT coalesce(array_agg(DISTINCT s.id), '{}'::uuid[]) INTO v_recent
      FROM "PersonalDataAccess" a, unnest(a."subjectIds") AS s(id)
     WHERE a."actorId" = v_actor AND a."kind" = p_kind AND a."at" > v_since
       AND a."channel" <> 'CALENDAR';  -- kalendern
  ELSIF v_member IS NOT NULL THEN  -- huvudman: over the school's (schoolId, at)
    SELECT coalesce(array_agg(DISTINCT s.id), '{}'::uuid[]) INTO v_recent
      FROM "PersonalDataAccess" a, unnest(a."subjectIds") AS s(id)
     WHERE a."schoolId" = v_school AND a."at" > v_since
       AND a."huvudmanMemberId" = v_member AND a."kind" = p_kind
       AND a."channel" <> 'CALENDAR';
  ELSIF v_key IS NOT NULL THEN
    SELECT coalesce(array_agg(DISTINCT s.id), '{}'::uuid[]) INTO v_recent
      FROM "PersonalDataAccess" a, unnest(a."subjectIds") AS s(id)
     WHERE a."schoolId" = v_school AND a."channel" = 'INTEGRATION' AND a."apiKeyId" = v_key
       AND a."kind" = p_kind AND a."at" > v_since;
  ELSIF v_hkey IS NOT NULL THEN  -- huvudman: over the school's (schoolId, at)
    SELECT coalesce(array_agg(DISTINCT s.id), '{}'::uuid[]) INTO v_recent
      FROM "PersonalDataAccess" a, unnest(a."subjectIds") AS s(id)
     WHERE a."schoolId" = v_school AND a."at" > v_since
       AND a."channel" = 'INTEGRATION' AND a."huvudmanApiKeyId" = v_hkey
       AND a."kind" = p_kind;
  ELSE
    SELECT coalesce(array_agg(DISTINCT s.id), '{}'::uuid[]) INTO v_recent
      FROM "PersonalDataAccess" a, unnest(a."subjectIds") AS s(id)
     WHERE a."schoolId" = v_school AND a."channel" = 'INTEGRATION' AND a."apiKeyId" IS NULL
       AND a."huvudmanApiKeyId" IS NULL  -- huvudman
       AND a."kind" = p_kind AND a."at" > v_since;
  END IF;

  -- Everyone of the school the read named, the reader aside: the read's size.
  SELECT coalesce(array_agg(u."id" ORDER BY u."id"), '{}'::uuid[]) INTO v_read
    FROM "Users" u
   WHERE u."schoolId" = v_school
     AND u."id" = ANY (p_subjects)
     AND u."id" IS DISTINCT FROM v_actor;
  v_new := ARRAY(SELECT x FROM unnest(v_read) AS x WHERE NOT (x = ANY (v_recent)) ORDER BY x);

  IF cardinality(v_new) = 0 THEN
    RETURN 0;
  END IF;
  INSERT INTO "PersonalDataAccess" ("schoolId", "actorId", "actorRole", "apiKeyId", "channel", "kind", "subjectIds", "readSize",
                                    "huvudmanMemberId", "huvudmanApiKeyId")  -- huvudman
  VALUES (v_school, v_actor, v_role, v_key, v_channel, p_kind, v_new, cardinality(v_read),
          v_member, v_hkey);
  RETURN cardinality(v_new);
END
$$;

COMMENT ON FUNCTION app.personal_data_read("PersonalDataAccessKind", "PersonalDataAccessChannel", uuid[]) IS
  'Records that the transaction''s reader (a person by their claims, the huvudman''s reader, an SS12000 key of the school or of its huvudman) read p_kind about p_subjects; leaves out the reader, people of other schools and anyone the same reader read of that kind in the last 15 minutes (a calendar feed''s rows aside), and keeps the read''s whole size. Answers how many people it recorded.';

-- ---------------------------------------------------------------------------
-- The names of the huvudman's readers and keys in the school's own log, for
-- the school's deciders (who read the log; personal_data_access_admin_select).
-- Only of a huvudman that has owned the school (a JOINED in the school's
-- history), the only one whose reader or key can stand in its log: so the
-- function names nobody of another huvudman, and asks the school's small
-- history rather than walking its read log, which has no index on these ids.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.access_log_huvudman_names(p_members uuid[], p_keys uuid[])
RETURNS TABLE (id uuid, kind text, name text, role "HuvudmanRole", huvudman_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT m."id", 'MEMBER', trim(m."firstName" || ' ' || m."lastName"), m."role", h."name"
    FROM "HuvudmanMembers" m
    JOIN "Huvudmen" h ON h."id" = m."huvudmanId"
   WHERE m."id" = ANY (p_members)
     AND app.current_user_decides()
     AND EXISTS (SELECT 1 FROM "HuvudmanSchoolEvents" e
                  WHERE e."schoolId" = app.current_school_id() AND e."huvudmanId" = m."huvudmanId"
                    AND e."kind" = 'JOINED')
  UNION ALL
  SELECT k."id", 'KEY', k."name", NULL::"HuvudmanRole", h."name"
    FROM "HuvudmanApiKeys" k
    JOIN "Huvudmen" h ON h."id" = k."huvudmanId"
   WHERE k."id" = ANY (p_keys)
     AND app.current_user_decides()
     AND EXISTS (SELECT 1 FROM "HuvudmanSchoolEvents" e
                  WHERE e."schoolId" = app.current_school_id() AND e."huvudmanId" = k."huvudmanId"
                    AND e."kind" = 'JOINED')
$$;

COMMENT ON FUNCTION app.access_log_huvudman_names(uuid[], uuid[]) IS
  'Huvudman (20261212090100): for the chosen school''s decider, the names of the readers and keys among p_members and p_keys of a huvudman that has owned the school (whose ids its read log can name), with their huvudman.';

DO $$
DECLARE
  r text;
BEGIN
  REVOKE ALL ON FUNCTION app.access_log_huvudman_names(uuid[], uuid[]) FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated', 'supabase_auth_admin'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION app.access_log_huvudman_names(uuid[], uuid[]) FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT EXECUTE ON FUNCTION app.access_log_huvudman_names(uuid[], uuid[]) TO "app_authenticated";
  END IF;
END
$$;
