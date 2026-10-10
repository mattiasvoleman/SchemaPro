-- En skola kan hämta från sitt elevregister.
--
-- The consumer half of "SS12000 both ways": a school names the SS12000
-- provider its pupils, staff, guardians and classes live in (IST, Edlevo or
-- any other implementation of SIS's SS12000 OpenAPI), and SchemaPro pulls
-- the roster from it instead of having it typed in twice. This migration is
-- the configuration and the credentials; the ids stored on our people and
-- classes are the next one (20261014100000) and the run log the one after
-- (20261014110000). Nothing here reads or writes a person: a source with no
-- run is inert, and a run changes nothing until an admin applies its diff.
--
-- The standard is SIS TK450's "SS12000 OpenAPI 3.0", info.version 2.1.0
-- (korrigendum augusti 2022), openapi_ss12000_version2_1_0.yaml, sha256
-- aee9a95a4c5bd25cebaf357d266592f94e9388ae785ee9ac3b58e1992acccd28
-- (https://www.sis.se/globalassets/standardutveckling/tksidor/tk-450/
-- openapi_ss12000_version2_1_0.yaml). It says how a token is PRESENTED
-- (securitySchemes.BearerAuth: http bearer) and not how one is obtained;
-- that is each provider's business, so a source names one of three ways:
--
--   * OAUTH2_CLIENT_CREDENTIALS: POST tokenUrl with grant_type=
--     client_credentials, the client id and secret in an HTTP Basic header
--     or in the form (IST EduCloud, "Fetch and use access token", 2021-12-30:
--     https://skolid.se/connect/token, HTTP Basic allowed, expires_in 3600).
--   * BEARER_TOKEN: a static token the provider issued.
--   * MTLS_CLIENT_CERT: a TLS client certificate and key (Tieto Edlevo per
--     Skolon's support article of 2025-02-27: API keys plus a client
--     certificate), optionally with an OAuth2 client or a bearer on top.
--
-- ## Ss12000Sources: one per school
--
-- UNIQUE(schoolId). Every CHECK mirrors the DTO (src/integration/
-- ss12000-sync/dto.ts):
--
--   * baseUrl: the provider's URL up to and including its "/v2.0" (S1's
--     servers.url is ".../v2.0"; IST's is .../ss12000v2-api/source/<id>/
--     v2.0). https ALWAYS, no userinfo in the authority (no '@' before the
--     path), no query or fragment, no trailing slash, at most 2048
--     characters. A CHECK cannot read NODE_ENV, so there is no http escape
--     hatch here: the tests run their mock provider over TLS with a test CA.
--     Credentials never sit in a URL, so a URL in a log is never a secret.
--   * tokenUrl and clientId: both or neither; required for OAUTH2, refused
--     for BEARER_TOKEN, optional on top of MTLS. The same URL rule. The
--     client id is not a secret (IST shows it in its admin UI) and is shown
--     back to the admin.
--   * organisationIds: the source's ids of the skolenheter this school is
--     (an F-3 and a 4-9 under different codes in one timetable are two),
--     0..5, chosen after "Testa anslutning". A run refuses while it is empty.
--     schoolUnitCodes: their skolenhetskoder as the last run read them.
--   * pageSize 100..2000 (IST suggests 1 000–2 000 a page), scheduleHourLocal
--     0..23 in the school's timezone, fullEveryDays 1..31.
--   * scheduleEnabled and scheduleAutoApply default false, and auto-apply
--     needs the schedule: nothing runs at night, and nothing is applied
--     without an admin, until the admin turns each on.
--   * lastTestOutcome is a code (OK, SS12000_TOKEN_REFUSED, ...), never a
--     sentence from the far side.
--   * modifiedCursor / deletedCursor / lastFullAt / incrementalUnsupported:
--     where the next incremental run starts (meta.modified.after and
--     /deletedEntities?after=), and whether the provider refused those
--     filters so every run is FULL.
--   * schedulerClaimedAt / lastScheduledLocalDate: written by the claim
--     (20261014110000).
--
-- ## Ss12000SourceSecrets: written and read only by functions
--
-- RLS ENABLED WITH NO ARM AT ALL and no grant (PushTickets' pattern): no
-- principal reads or writes a row directly. Each row is one credential
-- (CLIENT_SECRET, BEARER_TOKEN, CLIENT_KEY_PEM, CLIENT_CERT_PEM) as
-- AES-256-GCM ciphertext, 12-byte iv and 16-byte tag, made by the gateway
-- with INTEGRATION_SECRETS_KEY (never in the database) and keyId naming
-- which key, so a rotation can still decrypt the previous one. The AAD is
-- `ss12000-source:<schoolId>:<sourceId>:<kind>:<origin>`, where origin is
-- the scheme+host+port the secret is SENT to (tokenUrl's for CLIENT_SECRET,
-- baseUrl's for the others): a ciphertext moved to another school, source
-- or kind does not decrypt, and neither does one whose host the admin
-- changed. The gateway's PUT clears the affected kinds in the same
-- transaction as a host change, so an admin session, compromised or
-- mistaken, cannot send the stored IST secret to a new host without knowing
-- it.
--
--   * app.ss12000_set_source_secret(source, kind, ciphertext, iv, tag, keyId)
--     and app.ss12000_clear_source_secrets(source, kinds[]) act for a
--     SCHOOL_ADMIN's claims on their own school's source, and for nobody
--     else (SS403). Clearing is the one DELETE: it removes a credential, not
--     school data.
--   * app.ss12000_source_secrets(source) hands the ciphertexts to the sync
--     principal of the source's school (app.sync_school_id, no claims) or to
--     a SCHOOL_ADMIN of it ("Testa anslutning"), and refuses a TEACHER,
--     STUDENT or GUARDIAN claim and every service principal (SS403).
--   * app.ss12000_source_secret_presence(source): kind and setAt, for the
--     admin's form ("Sparad 2026-10-14" / "Inte satt"). No API returns a
--     ciphertext, a secret or a token.
--
-- ## The sync principal
--
-- app.current_sync_school_id() reads app.sync_school_id, set transaction-
-- locally by PrismaService.withSyncPrincipal for the school a run acts for:
-- the nightly run has no person behind it, and the manual run's fetch and
-- diff run after the 202 answered. NULLIF(..., '') because a setting once
-- set on a pooled connection reads back as '' after the transaction, not as
-- NULL. On this table the principal reads its school's source and may
-- write only the cursor, claim and test columns and schoolUnitCodes (the
-- skolenhetskoder the run read from the chosen organisations, display and
-- the provider's): the BEFORE UPDATE guard
-- app.ss12000_sources_sync_writes_are_narrow refuses anything else (SS403),
-- so a sync can never repoint its own base URL, organisation or schedule.
--
-- No service-principal arm: the SS12000 provider (a later migration) will
-- read the two columns it needs through a SECURITY DEFINER function, since
-- an arm cannot restrict columns and app_authenticated is every principal.
--
-- ## Grants
--
-- Guarded as in 20261013110000: app_authenticated SELECT, INSERT and UPDATE
-- on Ss12000Sources (no DELETE: disabling a source is `enabled = false`, and
-- a source with history is kept) and nothing on Ss12000SourceSecrets;
-- authenticated loses what pg_default_acl gives it beyond that; anon
-- nothing; service_role no write. The secret functions and
-- app.ss12000_admin_school(): EXECUTE for app_authenticated only.
-- app.current_sync_school_id() keeps PUBLIC's EXECUTE, as
-- app.current_service_school_id() does: the sync arms (here and in
-- 20261014100000) carry no TO, so every role reading Users evaluates them,
-- and must get zero rows from them, not "permission denied". The migration
-- ends with SS12000_SOURCE_REACH.

CREATE TYPE "Ss12000AuthKind" AS ENUM ('OAUTH2_CLIENT_CREDENTIALS', 'BEARER_TOKEN', 'MTLS_CLIENT_CERT');
CREATE TYPE "Ss12000TokenAuthStyle" AS ENUM ('BASIC', 'FORM');
CREATE TYPE "Ss12000SecretKind" AS ENUM ('CLIENT_SECRET', 'BEARER_TOKEN', 'CLIENT_KEY_PEM', 'CLIENT_CERT_PEM');

CREATE TABLE "Ss12000Sources" (
    "id"                     UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"               UUID NOT NULL,
    "name"                   TEXT NOT NULL,
    "baseUrl"                TEXT NOT NULL,
    "authKind"               "Ss12000AuthKind" NOT NULL,
    "tokenUrl"               TEXT,
    "clientId"               TEXT,
    "tokenScope"             TEXT,
    "tokenAuthStyle"         "Ss12000TokenAuthStyle" NOT NULL DEFAULT 'BASIC',
    "organisationIds"        UUID[] NOT NULL DEFAULT '{}',
    "schoolUnitCodes"        TEXT[] NOT NULL DEFAULT '{}',
    "pageSize"               INTEGER NOT NULL DEFAULT 1000,
    "enabled"                BOOLEAN NOT NULL DEFAULT true,
    "scheduleEnabled"        BOOLEAN NOT NULL DEFAULT false,
    "scheduleAutoApply"      BOOLEAN NOT NULL DEFAULT false,
    "scheduleHourLocal"      INTEGER NOT NULL DEFAULT 2,
    "fullEveryDays"          INTEGER NOT NULL DEFAULT 7,
    "incrementalUnsupported" BOOLEAN NOT NULL DEFAULT false,
    "modifiedCursor"         TIMESTAMPTZ(6),
    "deletedCursor"          TIMESTAMPTZ(6),
    "lastFullAt"             TIMESTAMPTZ(6),
    "lastAppliedAt"          TIMESTAMPTZ(6),
    "lastTestedAt"           TIMESTAMPTZ(6),
    "lastTestOutcome"        TEXT,
    "schedulerClaimedAt"     TIMESTAMPTZ(6),
    "lastScheduledLocalDate" DATE,
    "createdById"            UUID,
    "createdAt"              TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"              TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "Ss12000Sources_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Ss12000Sources_name_is_sane" CHECK (char_length(btrim("name")) BETWEEN 1 AND 120),
    CONSTRAINT "Ss12000Sources_baseUrl_is_https" CHECK (
        char_length("baseUrl") <= 2048
        AND "baseUrl" ~ '^https://[^/?#@[:space:]]+(/[^?#[:space:]]*)?$'
        AND "baseUrl" !~ '/$'),
    CONSTRAINT "Ss12000Sources_tokenUrl_is_https" CHECK (
        "tokenUrl" IS NULL OR (
            char_length("tokenUrl") <= 2048
            AND "tokenUrl" ~ '^https://[^/?#@[:space:]]+(/[^?#[:space:]]*)?$')),
    CONSTRAINT "Ss12000Sources_client_is_whole" CHECK (("tokenUrl" IS NULL) = ("clientId" IS NULL)),
    CONSTRAINT "Ss12000Sources_client_fits_the_kind" CHECK (
        CASE "authKind"
          WHEN 'OAUTH2_CLIENT_CREDENTIALS' THEN "tokenUrl" IS NOT NULL
          WHEN 'BEARER_TOKEN' THEN "tokenUrl" IS NULL
          ELSE true
        END),
    CONSTRAINT "Ss12000Sources_clientId_is_sane" CHECK ("clientId" IS NULL OR char_length("clientId") BETWEEN 1 AND 256),
    CONSTRAINT "Ss12000Sources_tokenScope_is_sane" CHECK ("tokenScope" IS NULL OR char_length("tokenScope") BETWEEN 1 AND 512),
    CONSTRAINT "Ss12000Sources_organisations_are_few" CHECK (cardinality("organisationIds") <= 5 AND array_position("organisationIds", NULL) IS NULL),
    CONSTRAINT "Ss12000Sources_schoolUnitCodes_are_few" CHECK (cardinality("schoolUnitCodes") <= 5),
    CONSTRAINT "Ss12000Sources_pageSize_is_sane" CHECK ("pageSize" BETWEEN 100 AND 2000),
    CONSTRAINT "Ss12000Sources_scheduleHourLocal_is_an_hour" CHECK ("scheduleHourLocal" BETWEEN 0 AND 23),
    CONSTRAINT "Ss12000Sources_fullEveryDays_is_sane" CHECK ("fullEveryDays" BETWEEN 1 AND 31),
    CONSTRAINT "Ss12000Sources_auto_apply_needs_the_schedule" CHECK (NOT "scheduleAutoApply" OR "scheduleEnabled"),
    CONSTRAINT "Ss12000Sources_lastTestOutcome_is_a_code" CHECK ("lastTestOutcome" IS NULL OR "lastTestOutcome" ~ '^[A-Z][A-Z0-9_]{1,63}$')
);

CREATE UNIQUE INDEX "Ss12000Sources_schoolId_key" ON "Ss12000Sources"("schoolId");
CREATE UNIQUE INDEX "Ss12000Sources_id_schoolId_key" ON "Ss12000Sources"("id", "schoolId");

ALTER TABLE "Ss12000Sources"
    ADD CONSTRAINT "Ss12000Sources_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Ss12000SourceSecrets" (
    "sourceId"   UUID NOT NULL,
    "schoolId"   UUID NOT NULL,
    "kind"       "Ss12000SecretKind" NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "iv"         BYTEA NOT NULL,
    "authTag"    BYTEA NOT NULL,
    "keyId"      TEXT NOT NULL,
    "setAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "setById"    UUID,

    CONSTRAINT "Ss12000SourceSecrets_pkey" PRIMARY KEY ("sourceId", "kind"),
    CONSTRAINT "Ss12000SourceSecrets_iv_is_gcm" CHECK (octet_length("iv") = 12),
    CONSTRAINT "Ss12000SourceSecrets_authTag_is_gcm" CHECK (octet_length("authTag") = 16),
    CONSTRAINT "Ss12000SourceSecrets_ciphertext_is_bounded" CHECK (octet_length("ciphertext") BETWEEN 1 AND 16384),
    CONSTRAINT "Ss12000SourceSecrets_keyId_is_sane" CHECK ("keyId" ~ '^[0-9a-f]{8,64}$')
);

ALTER TABLE "Ss12000SourceSecrets"
    ADD CONSTRAINT "Ss12000SourceSecrets_sourceId_schoolId_fkey"
    FOREIGN KEY ("sourceId", "schoolId") REFERENCES "Ss12000Sources"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- The sync principal, and who acts as an admin here.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.current_sync_school_id() RETURNS uuid
LANGUAGE sql STABLE SET search_path = "public", "pg_temp" AS $$
  SELECT NULLIF(current_setting('app.sync_school_id', true), '')::uuid
$$;

COMMENT ON FUNCTION app.current_sync_school_id() IS
  'School an SS12000 sync run acts for, or NULL. Set transaction-locally by PrismaService.withSyncPrincipal.';

-- The school of a SCHOOL_ADMIN acting with their own claims and no
-- principal beside them, else NULL.
CREATE FUNCTION app.ss12000_admin_school() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT CASE
           WHEN app.current_service_school_id() IS NULL
            AND app.current_sync_school_id() IS NULL
            AND app.current_user_role() = 'SCHOOL_ADMIN'
           THEN app.current_school_id()
         END
$$;

COMMENT ON FUNCTION app.ss12000_admin_school() IS
  'The school of a SCHOOL_ADMIN acting with their own claims and no service or sync principal set, else NULL.';

-- ---------------------------------------------------------------------------
-- The secrets' functions. See the preamble.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.ss12000_set_source_secret(
    p_source uuid, p_kind "Ss12000SecretKind", p_ciphertext bytea, p_iv bytea, p_tag bytea, p_key_id text)
RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  school uuid := app.ss12000_admin_school();
  stamped timestamptz;
BEGIN
  IF school IS NULL THEN
    RAISE EXCEPTION 'SS12000_SECRET_REFUSED: bara skolans administratör sparar källsystemets hemligheter' USING ERRCODE = 'SS403';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Ss12000Sources" s WHERE s."id" = p_source AND s."schoolId" = school) THEN
    RAISE EXCEPTION 'SS12000_SOURCE_NOT_FOUND: skolan har inget sådant källsystem' USING ERRCODE = 'SS404';
  END IF;
  INSERT INTO "Ss12000SourceSecrets" ("sourceId", "schoolId", "kind", "ciphertext", "iv", "authTag", "keyId", "setAt", "setById")
  VALUES (p_source, school, p_kind, p_ciphertext, p_iv, p_tag, p_key_id, now(), app.current_user_id())
  ON CONFLICT ("sourceId", "kind") DO UPDATE
     SET "ciphertext" = EXCLUDED."ciphertext", "iv" = EXCLUDED."iv", "authTag" = EXCLUDED."authTag",
         "keyId" = EXCLUDED."keyId", "setAt" = EXCLUDED."setAt", "setById" = EXCLUDED."setById"
  RETURNING "setAt" INTO stamped;
  RETURN stamped;
END
$$;

CREATE FUNCTION app.ss12000_clear_source_secrets(p_source uuid, p_kinds "Ss12000SecretKind"[])
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  school uuid := app.ss12000_admin_school();
  cleared integer;
BEGIN
  IF school IS NULL THEN
    RAISE EXCEPTION 'SS12000_SECRET_REFUSED: bara skolans administratör tar bort källsystemets hemligheter' USING ERRCODE = 'SS403';
  END IF;
  DELETE FROM "Ss12000SourceSecrets"
   WHERE "sourceId" = p_source AND "schoolId" = school AND "kind" = ANY (p_kinds);
  GET DIAGNOSTICS cleared = ROW_COUNT;
  RETURN cleared;
END
$$;

CREATE FUNCTION app.ss12000_source_secrets(p_source uuid)
RETURNS TABLE (kind "Ss12000SecretKind", ciphertext bytea, iv bytea, auth_tag bytea, key_id text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  sync uuid := app.current_sync_school_id();
  school uuid;
BEGIN
  IF app.current_service_school_id() IS NOT NULL THEN
    RAISE EXCEPTION 'SS12000_SECRET_REFUSED: integrationen läser inga hemligheter' USING ERRCODE = 'SS403';
  END IF;
  IF sync IS NOT NULL THEN
    -- The run, with nobody's claims beside it.
    IF app.current_user_id() IS NOT NULL THEN
      RAISE EXCEPTION 'SS12000_SECRET_REFUSED: en synk läser hemligheterna utan någons inloggning' USING ERRCODE = 'SS403';
    END IF;
    school := sync;
  ELSE
    school := app.ss12000_admin_school();
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
$$;

CREATE FUNCTION app.ss12000_source_secret_presence(p_source uuid)
RETURNS TABLE (kind "Ss12000SecretKind", set_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  school uuid := app.ss12000_admin_school();
BEGIN
  IF school IS NULL THEN
    RAISE EXCEPTION 'SS12000_SECRET_REFUSED: bara skolans administratör ser vilka hemligheter som är sparade' USING ERRCODE = 'SS403';
  END IF;
  RETURN QUERY
  SELECT x."kind", x."setAt" FROM "Ss12000SourceSecrets" x
   WHERE x."sourceId" = p_source AND x."schoolId" = school
   ORDER BY x."kind";
END
$$;

COMMENT ON FUNCTION app.ss12000_set_source_secret(uuid, "Ss12000SecretKind", bytea, bytea, bytea, text) IS
  'Stores one encrypted credential of the caller''s school''s source; SCHOOL_ADMIN claims only (SS403).';
COMMENT ON FUNCTION app.ss12000_clear_source_secrets(uuid, "Ss12000SecretKind"[]) IS
  'Deletes credentials of the caller''s school''s source; SCHOOL_ADMIN claims only (SS403).';
COMMENT ON FUNCTION app.ss12000_source_secrets(uuid) IS
  'The ciphertexts of a source, for its school''s sync principal or SCHOOL_ADMIN only; never a service principal (SS403).';
COMMENT ON FUNCTION app.ss12000_source_secret_presence(uuid) IS
  'Which credentials a source has and when they were set; SCHOOL_ADMIN claims only.';

-- ---------------------------------------------------------------------------
-- The sync principal writes cursors, never configuration.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.ss12000_sources_sync_writes_are_narrow() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  free text[] := ARRAY['modifiedCursor', 'deletedCursor', 'lastFullAt', 'incrementalUnsupported',
                       'lastAppliedAt', 'lastTestedAt', 'lastTestOutcome', 'schedulerClaimedAt',
                       'lastScheduledLocalDate', 'schoolUnitCodes', 'updatedAt'];
BEGIN
  IF app.current_sync_school_id() IS NULL THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - free) IS DISTINCT FROM (to_jsonb(OLD) - free) THEN
    RAISE EXCEPTION 'SS12000_SYNC_WRITES_ARE_NARROW: en synk flyttar bara sina markörer, aldrig källsystemets inställningar'
      USING ERRCODE = 'SS403';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Ss12000Sources_sync_writes_are_narrow"
    BEFORE UPDATE ON "Ss12000Sources"
    FOR EACH ROW EXECUTE FUNCTION app.ss12000_sources_sync_writes_are_narrow();

REVOKE ALL ON FUNCTION app.ss12000_sources_sync_writes_are_narrow() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Row-level security. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "Ss12000Sources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Ss12000SourceSecrets" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ss12000_sources_admin_select" ON "Ss12000Sources"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
CREATE POLICY "ss12000_sources_admin_insert" ON "Ss12000Sources"
    FOR INSERT TO "authenticated"
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
CREATE POLICY "ss12000_sources_admin_update" ON "Ss12000Sources"
    FOR UPDATE TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

CREATE POLICY "ss12000_sources_sync_select" ON "Ss12000Sources"
    FOR SELECT
    USING ("schoolId" = app.current_sync_school_id());
CREATE POLICY "ss12000_sources_sync_update" ON "Ss12000Sources"
    FOR UPDATE
    USING ("schoolId" = app.current_sync_school_id())
    WITH CHECK ("schoolId" = app.current_sync_school_id());

-- ---------------------------------------------------------------------------
-- Grants, guarded.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  fn text;
  r text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT SELECT, INSERT, UPDATE ON "Ss12000Sources" TO "app_authenticated";
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON "Ss12000Sources" FROM "app_authenticated";
    REVOKE ALL ON "Ss12000SourceSecrets" FROM "app_authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON "Ss12000Sources" FROM "authenticated";
    REVOKE ALL ON "Ss12000SourceSecrets" FROM "authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "Ss12000Sources" FROM "anon";
    REVOKE ALL ON "Ss12000SourceSecrets" FROM "anon";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "Ss12000Sources" FROM "service_role";
    REVOKE ALL ON "Ss12000SourceSecrets" FROM "service_role";
  END IF;

  -- app.current_sync_school_id() keeps PostgreSQL's default EXECUTE for
  -- PUBLIC, as app.current_service_school_id() does: the sync arms carry no
  -- TO, so every role that reads Users or StudentGroups evaluates them, and
  -- a role without EXECUTE would get "permission denied" where it must get
  -- zero rows. It only reads a transaction-local setting.
  FOREACH fn IN ARRAY ARRAY[
    'app.ss12000_admin_school()',
    'app.ss12000_set_source_secret(uuid, "Ss12000SecretKind", bytea, bytea, bytea, text)',
    'app.ss12000_clear_source_secrets(uuid, "Ss12000SecretKind"[])',
    'app.ss12000_source_secrets(uuid)',
    'app.ss12000_source_secret_presence(uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', fn, r);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO "app_authenticated"', fn);
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- SS12000_SOURCE_REACH: Ss12000Sources has exactly the admin arms (naming the
-- claims' school and SCHOOL_ADMIN) and the sync arms (naming the sync
-- principal's school), none of them DELETE or ALL, none with an OR; and
-- Ss12000SourceSecrets has no arm at all.
-- ---------------------------------------------------------------------------

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(p.tablename || '.' || p.policyname, ', ' ORDER BY p.tablename, p.policyname) INTO bad
    FROM pg_policies p
   WHERE p.schemaname = 'public'
     AND (
           p.tablename = 'Ss12000SourceSecrets'
        OR (p.tablename = 'Ss12000Sources' AND (
                 p.permissive <> 'PERMISSIVE'
              OR p.cmd NOT IN ('SELECT', 'INSERT', 'UPDATE')
              OR coalesce(p.qual, '') || coalesce(p.with_check, '') ~* '\mOR\M'
              OR NOT (
                   (p.policyname LIKE 'ss12000_sources_admin_%'
                    AND p.roles = '{authenticated}'::name[]
                    AND coalesce(p.qual, p.with_check) LIKE '%current_school_id()%'
                    AND coalesce(p.qual, p.with_check) LIKE '%SCHOOL_ADMIN%')
                OR (p.policyname LIKE 'ss12000_sources_sync_%'
                    AND p.cmd IN ('SELECT', 'UPDATE')
                    AND coalesce(p.qual, p.with_check) LIKE '%current_sync_school_id()%'))))
     );
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'SS12000_SOURCE_REACH: these arms reach a source or its secrets beyond the admin and the sync: %', bad;
  END IF;
END
$$;
