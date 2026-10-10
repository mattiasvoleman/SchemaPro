-- En enhet kan ta emot notiser.
--
-- Push for the mobile app: a registry of the devices a person has allowed
-- notifications on, and what the gateway needs to send through Expo's push
-- service and to learn which devices are gone. Push is OFF unless the API is
-- configured for it (PUSH_NOTIFICATIONS=expo): while it is off the API
-- refuses registration (409 PUSH_DISABLED), so nothing is written here, no
-- ticket is stored and no receipt is checked. This migration changes nothing
-- in production until somebody turns push on.
--
-- ## The token and its owner
--
-- An Expo push token addresses one installation of the app on one device.
-- One device is one token, and a token has ONE owner: UNIQUE(token). A
-- sign-in that registers a token another person holds takes it over, so the
-- previous person's notices stop reaching a device that is no longer theirs
-- — the shared teacher tablet, a phone handed down in a family. The
-- takeover crosses schools on purpose: UNIQUE(token) is global, and a device
-- that moves from one school's account to another's must stop receiving the
-- first school's notices. Holding the token is the authority, the same one
-- Expo's own model rests on (whoever holds a token can be sent to it); the
-- functions say nothing about the row they delete, so nothing of the other
-- school leaks.
--
-- DevicePushTokens: platform (IOS, ANDROID), the token in Expo's format
-- (a CHECK mirroring the DTO), the language the device asked for (sv, en),
-- created, last seen (refreshed by every registration) and revoked (with
-- the one reason we record: Expo said DEVICE_NOT_REGISTERED). At most ten
-- live tokens per person; a registration beyond that drops the oldest.
--
-- ## Who reads and writes
--
--   * The owner reads and deletes their own rows (device_push_tokens_own_select,
--     _own_delete: "schoolId" = app.current_school_id() AND "userId" =
--     app.current_user_id()), every role. Logging out deletes the row.
--   * Nobody writes a row directly: there is no INSERT or UPDATE arm and no
--     grant for them. Taking a token over deletes another person's row,
--     which no arm may allow, so registration is
--     app.claim_device_push_token(token, platform, locale), acting for the
--     claims' own user and school (PU401 without an active principal).
--   * app.release_device_push_token(token) deletes whichever row holds the
--     token: the app calls it at the next sign-in when a logout could not
--     reach the API (offline, a 4 s timeout), so the previous person's
--     notices stop even if the next person never turns push on. Same
--     authority as the claim: holding the device's token.
--   * No admin, staff or service arm: a person's devices are theirs.
--
-- PushTickets: Expo's receipt ids for messages sent, kept until the receipt
-- has been read (at least 15 minutes after sending, Expo keeps them 24 h).
-- RLS ENABLED WITH NO ARM AT ALL, and no grant: only the SECURITY DEFINER
-- functions below touch it.
--
-- ## The delivery's functions
--
-- All SECURITY DEFINER, search_path pinned, EXECUTE for app_authenticated
-- only (PUBLIC, anon, authenticated and service_role revoked), so PostgREST
-- cannot reach them. The delivery calls them after the commit in a
-- transaction with no principal (PrismaService.withDeliveryService), naming
-- the school the notice was written in.
--
--   * app.push_targets(school, users, type, required): live tokens of active
--     users of the school among `users`, minus those who opted out of the
--     type (NotificationOptOuts) unless the notice is one the school must
--     deliver (`required`), with the school's timezone. Nothing for
--     TEACHER_ABSENCE_REPORTED, a second line behind the gateway's own rule:
--     a colleague's absence is HR data and never on a lock screen.
--   * app.push_settle(school, dead, tickets): revokes the tokens Expo
--     refused outright (DeviceNotRegistered in the ticket) and stores the ok
--     tickets, both only for tokens of that school.
--   * app.push_due_receipts(limit): claims tickets at least 15 minutes old
--     that nobody claimed in the last hour (FOR UPDATE SKIP LOCKED, so two
--     API instances never read the same ticket), after housekeeping: tickets
--     older than 24 h (Expo has dropped their receipts), tokens revoked more
--     than 30 days ago and tokens not seen for 180 days are deleted.
--   * app.push_receipts_settled(checked, dead): revokes the tokens of the
--     receipts that said DeviceNotRegistered and deletes the checked tickets.
--
-- ## Retention
--
-- A token lives while its device keeps registering (every sign-in and app
-- start refreshes lastSeenAt), and goes on logout, on a takeover, 30 days
-- after Expo said the device is gone, or after 180 days unseen. A ticket
-- lives at most 24 hours. No row holds anything but ids, a token, a platform
-- and a language: no notice text, no name.
--
-- Grants guarded as in 20261012090000: app_authenticated SELECT and DELETE
-- on DevicePushTokens and nothing on PushTickets; INSERT, UPDATE, TRUNCATE,
-- REFERENCES and TRIGGER revoked from authenticated on DevicePushTokens
-- (pg_default_acl grants it arwd on every new table, and app_authenticated
-- is its member) and ALL on PushTickets; anon nothing; service_role no
-- write. The migration ends with PUSH_TOKEN_REACH.

CREATE TYPE "DevicePlatform" AS ENUM ('IOS', 'ANDROID');

CREATE TABLE "DevicePushTokens" (
    "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"      UUID NOT NULL,
    "userId"        UUID NOT NULL,
    "token"         TEXT NOT NULL,
    "platform"      "DevicePlatform" NOT NULL,
    "locale"        TEXT NOT NULL DEFAULT 'sv',
    "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "lastSeenAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "revokedAt"     TIMESTAMPTZ(6),
    "revokedReason" TEXT,

    CONSTRAINT "DevicePushTokens_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DevicePushTokens_token_is_an_expo_token" CHECK ("token" ~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$'),
    CONSTRAINT "DevicePushTokens_locale_is_known" CHECK ("locale" IN ('sv', 'en')),
    CONSTRAINT "DevicePushTokens_revocation_has_a_reason" CHECK (("revokedAt" IS NULL) = ("revokedReason" IS NULL)),
    CONSTRAINT "DevicePushTokens_reason_is_known" CHECK ("revokedReason" IS NULL OR "revokedReason" = 'DEVICE_NOT_REGISTERED')
);

CREATE UNIQUE INDEX "DevicePushTokens_token_key" ON "DevicePushTokens"("token");
CREATE UNIQUE INDEX "DevicePushTokens_id_schoolId_key" ON "DevicePushTokens"("id", "schoolId");
CREATE INDEX "DevicePushTokens_live_idx" ON "DevicePushTokens"("schoolId", "userId") WHERE "revokedAt" IS NULL;

ALTER TABLE "DevicePushTokens"
    ADD CONSTRAINT "DevicePushTokens_userId_schoolId_fkey"
    FOREIGN KEY ("userId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PushTickets" (
    "id"        TEXT NOT NULL,
    "schoolId"  UUID NOT NULL,
    "tokenId"   UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "claimedAt" TIMESTAMPTZ(6),

    CONSTRAINT "PushTickets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PushTickets_id_is_an_expo_id" CHECK ("id" ~ '^[A-Za-z0-9-]{8,64}$')
);

CREATE INDEX "PushTickets_due_idx" ON "PushTickets"("createdAt") WHERE "claimedAt" IS NULL;
CREATE INDEX "PushTickets_tokenId_schoolId_idx" ON "PushTickets"("tokenId", "schoolId");

ALTER TABLE "PushTickets"
    ADD CONSTRAINT "PushTickets_tokenId_schoolId_fkey"
    FOREIGN KEY ("tokenId", "schoolId") REFERENCES "DevicePushTokens"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DevicePushTokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PushTickets" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "device_push_tokens_own_select" ON "DevicePushTokens"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND "userId" = (select app.current_user_id()));
CREATE POLICY "device_push_tokens_own_delete" ON "DevicePushTokens"
    FOR DELETE TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND "userId" = (select app.current_user_id()));

-- ---------------------------------------------------------------------------
-- Registration and release, for the claims' own user.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.claim_device_push_token(p_token text, p_platform "DevicePlatform", p_locale text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  me uuid := app.current_user_id();
  school uuid := app.current_school_id();
  claimed uuid;
BEGIN
  IF me IS NULL OR school IS NULL THEN
    RAISE EXCEPTION 'PUSH_NO_PRINCIPAL: en enhet registreras av en inloggad användare' USING ERRCODE = 'PU401';
  END IF;
  -- Whoever held the token before — another person, another school — stops
  -- receiving on this device.
  DELETE FROM "DevicePushTokens" WHERE "token" = p_token AND ("userId" <> me OR "schoolId" <> school);
  INSERT INTO "DevicePushTokens" ("schoolId", "userId", "token", "platform", "locale")
  VALUES (school, me, p_token, p_platform, p_locale)
  ON CONFLICT ("token") DO UPDATE
     SET "platform" = EXCLUDED."platform", "locale" = EXCLUDED."locale", "lastSeenAt" = now(),
         "revokedAt" = NULL, "revokedReason" = NULL
   WHERE "DevicePushTokens"."userId" = me AND "DevicePushTokens"."schoolId" = school
  RETURNING "id" INTO claimed;
  IF claimed IS NULL THEN
    -- Another registration of the same token committed between the delete
    -- and the insert: the device is being claimed twice at once.
    RAISE EXCEPTION 'PUSH_TOKEN_BUSY: enheten registreras redan' USING ERRCODE = 'PU409';
  END IF;
  -- At most ten live devices per person: the oldest goes.
  DELETE FROM "DevicePushTokens"
   WHERE "id" IN (SELECT t."id" FROM "DevicePushTokens" t
                   WHERE t."userId" = me AND t."schoolId" = school
                   ORDER BY t."lastSeenAt" DESC, t."id" OFFSET 10);
  RETURN claimed;
END
$$;

CREATE FUNCTION app.release_device_push_token(p_token text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF app.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'PUSH_NO_PRINCIPAL: en enhet släpps av en inloggad användare' USING ERRCODE = 'PU401';
  END IF;
  DELETE FROM "DevicePushTokens" WHERE "token" = p_token;
END
$$;

-- ---------------------------------------------------------------------------
-- The delivery's functions, called with no principal and a school the
-- gateway names.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.push_targets(p_school uuid, p_users uuid[], p_type "NotificationType", p_required boolean)
RETURNS TABLE (token_id uuid, user_id uuid, token text, locale text, timezone text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT t."id", t."userId", t."token", t."locale", coalesce(s."timezone", 'Europe/Stockholm')
    FROM "DevicePushTokens" t
    JOIN "Users" u ON u."id" = t."userId" AND u."schoolId" = t."schoolId" AND u."isActive"
    JOIN "Schools" s ON s."id" = t."schoolId"
   WHERE t."schoolId" = p_school
     AND t."userId" = ANY (p_users)
     AND t."revokedAt" IS NULL
     AND p_type <> 'TEACHER_ABSENCE_REPORTED'
     AND (p_required OR NOT EXISTS (
           SELECT 1 FROM "NotificationOptOuts" o
            WHERE o."userId" = t."userId" AND o."schoolId" = t."schoolId" AND o."type" = p_type))
   ORDER BY t."userId", t."id"
$$;

CREATE FUNCTION app.push_settle(p_school uuid, p_dead uuid[], p_tickets jsonb)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  UPDATE "DevicePushTokens"
     SET "revokedAt" = now(), "revokedReason" = 'DEVICE_NOT_REGISTERED'
   WHERE "schoolId" = p_school AND "id" = ANY (p_dead) AND "revokedAt" IS NULL;
  INSERT INTO "PushTickets" ("id", "schoolId", "tokenId")
  SELECT x."id", p_school, x."tokenId"
    FROM jsonb_to_recordset(coalesce(p_tickets, '[]'::jsonb)) AS x("id" text, "tokenId" uuid)
    JOIN "DevicePushTokens" t ON t."id" = x."tokenId" AND t."schoolId" = p_school
  ON CONFLICT ("id") DO NOTHING;
END
$$;

CREATE FUNCTION app.push_due_receipts(p_limit integer)
RETURNS TABLE (ticket_id text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  DELETE FROM "PushTickets" WHERE "createdAt" < now() - interval '24 hours';
  DELETE FROM "DevicePushTokens" WHERE "revokedAt" < now() - interval '30 days';
  DELETE FROM "DevicePushTokens" WHERE "lastSeenAt" < now() - interval '180 days';
  RETURN QUERY
  WITH due AS (
    SELECT p."id" FROM "PushTickets" p
     WHERE p."createdAt" <= now() - interval '15 minutes'
       AND (p."claimedAt" IS NULL OR p."claimedAt" < now() - interval '1 hour')
     ORDER BY p."createdAt"
     LIMIT greatest(least(p_limit, 1000), 0)
       FOR UPDATE SKIP LOCKED
  )
  UPDATE "PushTickets" p SET "claimedAt" = now() FROM due WHERE p."id" = due."id"
  RETURNING p."id";
END
$$;

CREATE FUNCTION app.push_receipts_settled(p_checked text[], p_dead text[])
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  UPDATE "DevicePushTokens" t
     SET "revokedAt" = now(), "revokedReason" = 'DEVICE_NOT_REGISTERED'
    FROM "PushTickets" p
   WHERE p."id" = ANY (p_dead) AND p."tokenId" = t."id" AND p."schoolId" = t."schoolId" AND t."revokedAt" IS NULL;
  DELETE FROM "PushTickets" WHERE "id" = ANY (p_checked) OR "id" = ANY (p_dead);
END
$$;

COMMENT ON FUNCTION app.claim_device_push_token(text, "DevicePlatform", text) IS
  'Registers the device token for the claims'' own user, taking it over from whoever held it.';
COMMENT ON FUNCTION app.release_device_push_token(text) IS
  'Deletes whichever row holds the device token: a logout that could not reach the API, finished at the next sign-in.';
COMMENT ON FUNCTION app.push_targets(uuid, uuid[], "NotificationType", boolean) IS
  'Live push tokens of active users of p_school among p_users, minus opt-outs unless p_required; never for TEACHER_ABSENCE_REPORTED.';
COMMENT ON FUNCTION app.push_settle(uuid, uuid[], jsonb) IS
  'Revokes tokens Expo refused and stores ok tickets, for tokens of p_school only.';
COMMENT ON FUNCTION app.push_due_receipts(integer) IS
  'Housekeeping, then claims up to p_limit tickets due for a receipt check (SKIP LOCKED).';
COMMENT ON FUNCTION app.push_receipts_settled(text[], text[]) IS
  'Revokes the tokens of DeviceNotRegistered receipts and deletes the checked tickets.';

-- ---------------------------------------------------------------------------
-- Grants, guarded.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  fn text;
  r text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT SELECT, DELETE ON "DevicePushTokens" TO "app_authenticated";
    REVOKE INSERT, UPDATE, TRUNCATE, REFERENCES, TRIGGER ON "DevicePushTokens" FROM "app_authenticated";
    REVOKE ALL ON "PushTickets" FROM "app_authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE INSERT, UPDATE, TRUNCATE, REFERENCES, TRIGGER ON "DevicePushTokens" FROM "authenticated";
    REVOKE ALL ON "PushTickets" FROM "authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "DevicePushTokens" FROM "anon";
    REVOKE ALL ON "PushTickets" FROM "anon";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "DevicePushTokens" FROM "service_role";
    REVOKE ALL ON "PushTickets" FROM "service_role";
  END IF;

  FOREACH fn IN ARRAY ARRAY[
    'app.claim_device_push_token(text, "DevicePlatform", text)',
    'app.release_device_push_token(text)',
    'app.push_targets(uuid, uuid[], "NotificationType", boolean)',
    'app.push_settle(uuid, uuid[], jsonb)',
    'app.push_due_receipts(integer)',
    'app.push_receipts_settled(text[], text[])'
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
-- PUSH_TOKEN_REACH: every arm on DevicePushTokens is a permissive SELECT or
-- DELETE arm for authenticated naming the person's own id and school, with no
-- OR; PushTickets has no arm at all.
-- ---------------------------------------------------------------------------

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(p.tablename || '.' || p.policyname, ', ' ORDER BY p.tablename, p.policyname) INTO bad
    FROM pg_policies p
   WHERE p.schemaname = 'public'
     AND (
           p.tablename = 'PushTickets'
        OR (p.tablename = 'DevicePushTokens' AND (
                 p.permissive <> 'PERMISSIVE'
              OR p.roles <> '{authenticated}'::name[]
              OR p.cmd NOT IN ('SELECT', 'DELETE')
              OR coalesce(p.qual, '') NOT LIKE '%current_user_id()%'
              OR coalesce(p.qual, '') NOT LIKE '%current_school_id()%'
              OR coalesce(p.qual, '') ~* '\mOR\M'))
     );
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'PUSH_TOKEN_REACH: these arms reach somebody else''s devices or the tickets: %', bad;
  END IF;
END
$$;
