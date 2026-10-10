-- En nyckel har sitt omfång.
--
-- The provider half of "SS12000 both ways" serves SIS's SS12000 OpenAPI
-- 2.1.0 (openapi_ss12000_version2_1_0.yaml, korrigendum augusti 2022, sha256
-- aee9a95a4c5bd25cebaf357d266592f94e9388ae785ee9ac3b58e1992acccd28) under
-- /ss12000/v2.0, beside the house-shaped /ss12000/v1 that keeps working byte
-- for byte. A library system needs no parents and a lesson export needs no
-- persons' emails, so a key now says what it may read. This migration is the
-- key's reach and its webhook signing secret; the versions, tombstones and
-- subscriptions the provider serves are the next one (20261014130000).
--
-- ## IntegrationApiKeys.scopes
--
-- text[] NOT NULL DEFAULT '{ss12000.v1,ss12000.v1.import}'. The default is
-- the backfill: ADD COLUMN with a constant default gives every existing key
-- exactly the reach it has today — all of /ss12000/v1 and its POST
-- import/persons — and nothing of v2. So no existing integration changes
-- behaviour: the v1 guard's new 403 for a missing ss12000.v1 is one no key
-- that exists today can meet. A new key may be read-only (v1 without the
-- import) or v2-only. The CHECK mirrors the DTO (src/integration/
-- ss12000-v2/scopes.ts): 1..12 scopes, each one of
--
--   ss12000.v1            /ss12000/v1 (the house-shaped feeds)
--   ss12000.v1.import     POST /ss12000/v1/import/persons
--   organisations.read    /v2.0/organisations*
--   persons.read          /v2.0/persons*, pupils and staff
--   responsibles.read     guardians in /persons and every responsibles[]
--   groups.read           /v2.0/groups*
--   duties.read           /v2.0/duties*, Duty ids in activities and events
--   activities.read       /v2.0/activities*
--   calendarEvents.read   /v2.0/calendarEvents*
--   rooms.read            /v2.0/rooms*
--   syllabuses.read       /v2.0/syllabuses*
--   subscriptions.write   /v2.0/subscriptions*
--
-- The key lookup's UPDATE arm (integration_keys_service_touch,
-- 20260806010000) names no column, and the guard's lastUsedAt stamp has been
-- the only thing keeping the lookup from rewriting a key. Now that a key
-- carries its own reach that is not enough: a BEFORE UPDATE guard,
-- app.integration_key_lookup_writes_are_narrow, refuses (SS403) every change
-- under app.service_key_lookup except lastUsedAt. The lookup reads scopes; it
-- never writes them. The admin arm (integration_api_keys_admin_all) is how
-- scopes change: PATCH /api/v1/integration-keys/:id.
--
-- UNIQUE (id, schoolId) is added as the target of the composite keys below
-- and in 20261014130000 (a subscription and a secret belong to a key OF THEIR
-- school, whatever writes them).
--
-- ## IntegrationKeyWebhookSecrets
--
-- The HMAC key a subscription's notices are signed with (X-SchemaPro-
-- Signature: v1=<hex HMAC-SHA256(secret, timestamp + "." + body)>). S1
-- defines no signing; it is a SchemaPro header extension and the body stays
-- S1's. One row per key, made by the admin (POST /api/v1/integration-keys/
-- :id/webhook-secret, shown once) and stored as AES-256-GCM ciphertext with
-- INTEGRATION_SECRETS_KEY, like the source's credentials (20261014090000),
-- with the AAD `integration-key-webhook:<schoolId>:<keyId>`: a ciphertext
-- moved to another key or school does not open. A new secret keeps the
-- previous one valid for 24 hours (previous* columns, previousValidUntil),
-- during which a notice carries both signatures, so a consumer can rotate
-- without dropping a notice.
--
-- RLS ENABLED WITH NO ARM and no grant (PushTickets' and
-- Ss12000SourceSecrets' pattern). Only these SECURITY DEFINER functions touch
-- it:
--
--   * app.integration_key_set_webhook_secret(key, ciphertext, iv, tag,
--     encKeyId): a SCHOOL_ADMIN of the key's school (claims only, no
--     principal beside them; else SS403), for a live key of that school
--     (else SS404). Moves the current secret to previous* for 24 hours.
--   * app.integration_key_webhook_secret_presence(): which of the school's
--     keys have a secret, when it was set and until when the previous one
--     holds — never a ciphertext. SCHOOL_ADMIN only.
--   * app.ss12000_webhook_secrets(key): the ciphertexts, current and a still
--     valid previous, for the DELIVERY only: no claims, no service and no
--     sync principal set (withDeliveryService). A SCHOOL_ADMIN, a TEACHER,
--     STUDENT or GUARDIAN claim, the service principal and the sync
--     principal are all refused (SS403).
--   * app.ss12000_webhook_secret_exists(): whether the CURRENT service key
--     has one (POST /subscriptions answers 409 WEBHOOK_SECRET_MISSING until
--     it does, so no unsigned notice is ever sent). Reads the key from
--     app.service_key_id, set by withServicePrincipal (20261014130000
--     defines app.current_service_key_id(); this function reads the setting
--     itself, so this migration stands alone).
--
-- ## Grants
--
-- Guarded as in 20261014090000. Nothing on IntegrationKeyWebhookSecrets for
-- any API role. The functions: EXECUTE for app_authenticated only. The
-- migration ends with WEBHOOK_SECRET_REACH.

ALTER TABLE "IntegrationApiKeys"
    ADD COLUMN "scopes" TEXT[] NOT NULL DEFAULT '{ss12000.v1,ss12000.v1.import}';

ALTER TABLE "IntegrationApiKeys"
    ADD CONSTRAINT "IntegrationApiKeys_scopes_are_known" CHECK (
        cardinality("scopes") BETWEEN 1 AND 12
        AND array_position("scopes", NULL) IS NULL
        AND "scopes" <@ ARRAY[
            'ss12000.v1', 'ss12000.v1.import',
            'organisations.read', 'persons.read', 'responsibles.read', 'groups.read', 'duties.read',
            'activities.read', 'calendarEvents.read', 'rooms.read', 'syllabuses.read',
            'subscriptions.write'
        ]::text[]);

CREATE UNIQUE INDEX "IntegrationApiKeys_id_schoolId_key" ON "IntegrationApiKeys"("id", "schoolId");

-- ---------------------------------------------------------------------------
-- The key lookup stamps lastUsedAt and nothing else.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.integration_key_lookup_writes_are_narrow() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF NOT app.is_service_key_lookup() THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'lastUsedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'lastUsedAt') THEN
    RAISE EXCEPTION 'INTEGRATION_KEY_LOOKUP_WRITES_ARE_NARROW: nyckeluppslaget stämplar bara senaste användning'
      USING ERRCODE = 'SS403';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "IntegrationApiKeys_lookup_writes_are_narrow"
    BEFORE UPDATE ON "IntegrationApiKeys"
    FOR EACH ROW EXECUTE FUNCTION app.integration_key_lookup_writes_are_narrow();

REVOKE ALL ON FUNCTION app.integration_key_lookup_writes_are_narrow() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- The webhook signing secret. See the preamble.
-- ---------------------------------------------------------------------------

CREATE TABLE "IntegrationKeyWebhookSecrets" (
    "keyId"              UUID NOT NULL,
    "schoolId"           UUID NOT NULL,
    "ciphertext"         BYTEA NOT NULL,
    "iv"                 BYTEA NOT NULL,
    "authTag"            BYTEA NOT NULL,
    "encKeyId"           TEXT NOT NULL,
    "setAt"              TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "setById"            UUID,
    "previousCiphertext" BYTEA,
    "previousIv"         BYTEA,
    "previousAuthTag"    BYTEA,
    "previousEncKeyId"   TEXT,
    "previousValidUntil" TIMESTAMPTZ(6),

    CONSTRAINT "IntegrationKeyWebhookSecrets_pkey" PRIMARY KEY ("keyId"),
    CONSTRAINT "IntegrationKeyWebhookSecrets_iv_is_gcm" CHECK (octet_length("iv") = 12),
    CONSTRAINT "IntegrationKeyWebhookSecrets_authTag_is_gcm" CHECK (octet_length("authTag") = 16),
    CONSTRAINT "IntegrationKeyWebhookSecrets_ciphertext_is_bounded" CHECK (octet_length("ciphertext") BETWEEN 1 AND 1024),
    CONSTRAINT "IntegrationKeyWebhookSecrets_encKeyId_is_sane" CHECK ("encKeyId" ~ '^[0-9a-f]{8,64}$'),
    CONSTRAINT "IntegrationKeyWebhookSecrets_previous_is_whole" CHECK (
        ("previousCiphertext" IS NULL) = ("previousIv" IS NULL)
        AND ("previousCiphertext" IS NULL) = ("previousAuthTag" IS NULL)
        AND ("previousCiphertext" IS NULL) = ("previousEncKeyId" IS NULL)
        AND ("previousCiphertext" IS NULL) = ("previousValidUntil" IS NULL))
);

ALTER TABLE "IntegrationKeyWebhookSecrets"
    ADD CONSTRAINT "IntegrationKeyWebhookSecrets_keyId_schoolId_fkey"
    FOREIGN KEY ("keyId", "schoolId") REFERENCES "IntegrationApiKeys"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "IntegrationKeyWebhookSecrets_schoolId_idx" ON "IntegrationKeyWebhookSecrets"("schoolId");

ALTER TABLE "IntegrationKeyWebhookSecrets" ENABLE ROW LEVEL SECURITY;

-- No principal at all: the delivery's door (withDeliveryService).
CREATE FUNCTION app.ss12000_is_delivery_context() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT app.current_user_id() IS NULL
     AND NULLIF(current_setting('request.jwt.claim.sub', true), '') IS NULL
     AND NULLIF(current_setting('app.service_school_id', true), '') IS NULL
     AND NULLIF(current_setting('app.sync_school_id', true), '') IS NULL
     AND NOT app.is_service_key_lookup()
$$;

COMMENT ON FUNCTION app.ss12000_is_delivery_context() IS
  'True only in a transaction with no claims and no service, sync or key-lookup principal: the webhook delivery''s.';

CREATE FUNCTION app.integration_key_set_webhook_secret(
    p_key uuid, p_ciphertext bytea, p_iv bytea, p_tag bytea, p_enc_key_id text)
RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  school uuid := app.ss12000_admin_school();
  stamped timestamptz := now();
BEGIN
  IF school IS NULL THEN
    RAISE EXCEPTION 'WEBHOOK_SECRET_REFUSED: bara skolans administratör skapar en signeringsnyckel' USING ERRCODE = 'SS403';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "IntegrationApiKeys" k WHERE k."id" = p_key AND k."schoolId" = school AND k."revokedAt" IS NULL) THEN
    RAISE EXCEPTION 'INTEGRATION_KEY_NOT_FOUND: skolan har ingen sådan aktiv nyckel' USING ERRCODE = 'SS404';
  END IF;
  INSERT INTO "IntegrationKeyWebhookSecrets" AS w
         ("keyId", "schoolId", "ciphertext", "iv", "authTag", "encKeyId", "setAt", "setById")
  VALUES (p_key, school, p_ciphertext, p_iv, p_tag, p_enc_key_id, stamped, app.current_user_id())
  ON CONFLICT ("keyId") DO UPDATE
     SET "previousCiphertext" = w."ciphertext", "previousIv" = w."iv", "previousAuthTag" = w."authTag",
         "previousEncKeyId" = w."encKeyId", "previousValidUntil" = stamped + interval '24 hours',
         "ciphertext" = EXCLUDED."ciphertext", "iv" = EXCLUDED."iv", "authTag" = EXCLUDED."authTag",
         "encKeyId" = EXCLUDED."encKeyId", "setAt" = EXCLUDED."setAt", "setById" = EXCLUDED."setById";
  RETURN stamped;
END
$$;

CREATE FUNCTION app.integration_key_webhook_secret_presence()
RETURNS TABLE (key_id uuid, set_at timestamptz, previous_valid_until timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  school uuid := app.ss12000_admin_school();
BEGIN
  IF school IS NULL THEN
    RAISE EXCEPTION 'WEBHOOK_SECRET_REFUSED: bara skolans administratör ser vilka nycklar som kan signera' USING ERRCODE = 'SS403';
  END IF;
  RETURN QUERY
  SELECT w."keyId", w."setAt", CASE WHEN w."previousValidUntil" > now() THEN w."previousValidUntil" END
    FROM "IntegrationKeyWebhookSecrets" w
   WHERE w."schoolId" = school
   ORDER BY w."keyId";
END
$$;

CREATE FUNCTION app.ss12000_webhook_secrets(p_key uuid)
RETURNS TABLE (school_id uuid, ciphertext bytea, iv bytea, auth_tag bytea, enc_key_id text,
               previous_ciphertext bytea, previous_iv bytea, previous_auth_tag bytea, previous_enc_key_id text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF NOT app.ss12000_is_delivery_context() THEN
    RAISE EXCEPTION 'WEBHOOK_SECRET_REFUSED: signeringsnyckeln läses bara av utskicket' USING ERRCODE = 'SS403';
  END IF;
  RETURN QUERY
  SELECT w."schoolId", w."ciphertext", w."iv", w."authTag", w."encKeyId",
         CASE WHEN w."previousValidUntil" > now() THEN w."previousCiphertext" END,
         CASE WHEN w."previousValidUntil" > now() THEN w."previousIv" END,
         CASE WHEN w."previousValidUntil" > now() THEN w."previousAuthTag" END,
         CASE WHEN w."previousValidUntil" > now() THEN w."previousEncKeyId" END
    FROM "IntegrationKeyWebhookSecrets" w
    JOIN "IntegrationApiKeys" k ON k."id" = w."keyId" AND k."schoolId" = w."schoolId"
   WHERE w."keyId" = p_key AND k."revokedAt" IS NULL;
END
$$;

CREATE FUNCTION app.ss12000_webhook_secret_exists() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT EXISTS (
    SELECT 1 FROM "IntegrationKeyWebhookSecrets" w
     WHERE w."keyId" = NULLIF(current_setting('app.service_key_id', true), '')::uuid
       AND w."schoolId" = app.current_service_school_id())
$$;

COMMENT ON FUNCTION app.integration_key_set_webhook_secret(uuid, bytea, bytea, bytea, text) IS
  'Stores a key''s encrypted webhook signing secret, keeping the previous one valid for 24 h; SCHOOL_ADMIN claims only (SS403).';
COMMENT ON FUNCTION app.integration_key_webhook_secret_presence() IS
  'Which of the school''s keys can sign webhooks, and since when; SCHOOL_ADMIN claims only.';
COMMENT ON FUNCTION app.ss12000_webhook_secrets(uuid) IS
  'A live key''s webhook secret ciphertexts (current and a still valid previous), for the delivery context only (SS403).';
COMMENT ON FUNCTION app.ss12000_webhook_secret_exists() IS
  'Whether the current service key (app.service_key_id) has a webhook signing secret.';

-- ---------------------------------------------------------------------------
-- Grants, guarded.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  fn text;
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['app_authenticated', 'authenticated', 'anon', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "IntegrationKeyWebhookSecrets" FROM %I', r);
    END IF;
  END LOOP;

  FOREACH fn IN ARRAY ARRAY[
    'app.ss12000_is_delivery_context()',
    'app.integration_key_set_webhook_secret(uuid, bytea, bytea, bytea, text)',
    'app.integration_key_webhook_secret_presence()',
    'app.ss12000_webhook_secrets(uuid)',
    'app.ss12000_webhook_secret_exists()'
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
-- WEBHOOK_SECRET_REACH: the secrets table has no arm at all, and the keys'
-- arms are exactly the three that were there before.
-- ---------------------------------------------------------------------------

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(p.tablename || '.' || p.policyname, ', ' ORDER BY p.tablename, p.policyname) INTO bad
    FROM pg_policies p
   WHERE p.schemaname = 'public'
     AND (p.tablename = 'IntegrationKeyWebhookSecrets'
          OR (p.tablename = 'IntegrationApiKeys'
              AND p.policyname NOT IN ('integration_api_keys_admin_all', 'integration_keys_service_lookup', 'integration_keys_service_touch')));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'WEBHOOK_SECRET_REACH: these arms reach a key or its signing secret: %', bad;
  END IF;
END
$$;
