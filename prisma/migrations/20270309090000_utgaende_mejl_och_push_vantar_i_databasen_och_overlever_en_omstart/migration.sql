-- Utgående mejl och push väntar i databasen och överlever en omstart (H3, omgång 15).
--
-- ## Vad som fanns
--
-- Leveransen (src/notifications/notification-delivery.service.ts) fick efter varje commit en samling notiser och köade dem i
-- processens minne: ett mejl var en väntande post i en array, och en driftsättning (API:t driftsätts vid varje merge) tog den
-- med sig. En påminnelse till hela skolan är cirka 82 mejl och 4 000 pushar, en minut eller så i kön, och en omstart under
-- den minuten tappade resten tyst: inkorgsraderna fanns, men mejlet och pushen kom aldrig, och inget försökte igen.
--
-- ## Vad det blir
--
-- En kö i databasen, OutboundNotices, och en liten tabell för takten, OutboundPace.
--
--   * EN RAD PER KÖRFÄLT OCH SKOLA UR EN COMMITTAD TRANSAKTION. Det är samma enhet som leveransen hade i minnet (en
--     OutboxBatch delad på larmens körfält och på skola), eftersom pushen slår ihop en persons notiser av samma slag inom
--     en transaktion ("3 lektioner är inställda"). Raden bär notisernas typ och meta, mejlets ämne och text (som för tre
--     brevtyper nämner ett barns namn, dataskyddsbeskrivningen 4.3) och mottagarnas id, aldrig en adress, en token eller
--     en push-text: de slås upp i det ögonblick raden tas och sparas på raden som en plan (se nedan).
--   * EN LEASE PER RAD, som Generera-körningarna (20270222090000): app.outbound_claim tar den äldsta raden som väntar eller
--     vars lease har gått ut, FOR UPDATE SKIP LOCKED, och ger den en claim (konsumentens namn och ett slumptal) som varje
--     senare steg måste visa upp. Två API-instanser, eller en ny och en gammal under en driftsättning, tar därför aldrig
--     samma rad, och en process som stått still och vaknar med en gammal claim får nej på sitt nästa steg. Leasen förnyas av
--     varje steg; en process som dör lämnar den att gå ut, och nästa konsument tar raden där den lämnades.
--   * PLANEN FRYSES. Första gången en rad tas räknar gatewayen ut vilka adresser mejlet går till (efter avanmälningar), i
--     paket om 49 som Resend tar, och vilka enheter pushen går till med färdig text, i paket om 100 som Expo tar, och sparar
--     det som raden plan (app.outbound_plan). Ett omförsök skickar samma paket med samma innehåll, och det är det som gör
--     att en idempotensnyckel håller: Resend jämför innehållet och svarar 409 om en nyckel kommer tillbaka med ett annat.
--   * TVÅ RÄKNARE, mailDone och pushDone, hur många paket som är färdiga. Ett mejlpaket räknas efter att Resend tog det, och
--     ett omförsök efter en omstart går under samma Idempotency-Key (24 timmar hos Resend), så ett paket som hann iväg innan
--     processen dog skickas inte två gånger. Expo har ingen idempotensnyckel: ett pushpaket räknas FÖRE anropet, så ett som
--     var på väg när processen dog skickas inte om. Det är avvägningen: ett pushpaket kan i ett sådant ögonblick bli borta, men
--     aldrig dubbelt.
--   * TAKTEN GÄLLER FLOTTAN. app.outbound_slot ger varje mejl och varje pushpaket en tid i en gemensam kö i databasen
--     (OutboundPace.nextAt, en rad per kanal): ett mejl var 500 ms och ett pushpaket var 200 ms, vilken instans som än
--     skickar. Det var processens egen takt förut, och två instanser under en driftsättning dubblade den.
--   * GALLRING. När en rad är klar (DONE) eller har gett upp (GAVE_UP) töms den på allt som rör en person: notiserna,
--     mottagarna, planen med adresser och tokens. En CHECK håller det: en färdig rad kan inte bära dem. Det som blir kvar
--     är skolan, tidpunkterna och fyra tal (hur många mejl och pushar som gick och hur många som inte gjorde det), och de
--     tas bort efter sju dagar (app.outbound_sweep). En rad som fastnat, till exempel för att en leverantör varit nere, ger
--     upp efter 20 timmar (mindre än Resends 24 timmar för en nyckel) eller 30 försök.
--
-- ## Vad som inte är en kö här
--
-- Nattens lunchbrev till köket (meal-letter) skickas direkt som förut: det är ett mejl en gång om dagen med en egen claim
-- hos sitt jobb. Det tar sin tid i samma takt (app.outbound_slot) och får en idempotensnyckel som är ett fingeravtryck av
-- brevet, så att ett omförsök inom dygnet inte ger två brev.
--
-- ## Vem som läser och skriver
--
-- Ingen roll läser eller skriver tabellerna direkt. RLS är på utan något arm (inte för anon, inte för authenticated, inte för
-- någon administratör) och inga rättigheter ges: bara funktionerna nedan rör dem. Funktionerna är SECURITY DEFINER med
-- fastlåst search_path och EXECUTE för app_authenticated ensam (PUBLIC, anon, authenticated och service_role återkallas, så
-- PostgREST når dem inte), och varje funktion är en jobbdörr med Dörrvaktens vakt (20270220090000): den nekar (OB403) en
-- session som har någon inloggning alls. Leveransen kallar dem efter commit i en transaktion utan principal
-- (PrismaService.withDeliveryService), med skolan som gatewayen bestämt.
--
-- ## Det som en person bär i kön
--
-- recipientIds och notificationIds: id:n som redan står i Notifications, så länge raden väntar, och i entries mejlets ämne och
-- text, som för tre brevtyper nämner ett barns namn. Ingen adress och ingen token (de ligger i planen först när raden tas, och
-- planen töms med raden). En person som tagits bort eller är inaktiv vid det ögonblicket får ingenting: adressen läses ur
-- Users (isActive) och pushens token ur DevicePushTokens när raden tas, och en person som inte finns har varken. Registerutdraget
-- lämnar tabellen utanför med skäl (person-tables.ts), eftersom raden är en kopia av det som utdragets notiser.csv redan har
-- och töms när notisen är skickad eller har gett upp, högst 20 timmar efter att den lades in.
--
-- ## Låsen
--
-- Tabellerna är nya och ingen begäran rör dem förrän API:t som skriver dem har driftsatts. Främmande nyckeln till Schools tar
-- SHARE ROW EXCLUSIVE på Schools (en läsare blockeras inte, en skrivare väntar): låset tas NOWAIT i en slinga med tak på 30 s
-- och lock_timeout 5 s (policy-migration-lock-order), så att filen aldrig väntar med ett lås i handen. Funktionerna skapas
-- efteråt och låser ingen tabell.
--
-- ## Under en driftsättning
--
-- API:t före detta känner varken tabellen eller funktionerna och köar som förut i minnet: de två köerna lever bredvid varandra
-- tills den gamla instansen är nedtagen, och en notis går i den kö som den instans som skrev den har. Ingen notis går i
-- båda, eftersom varje notis köas av den instans vars transaktion skrev den.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Schools" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Schools was not free in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

CREATE TABLE "OutboundNotices" (
    "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"        UUID NOT NULL,
    -- Larmens körfält (CRISIS_ALARM, CRISIS_ENDED) och det vanliga: två konsumenter, så att ett larm inte väntar på en skolas våg.
    "urgent"          BOOLEAN NOT NULL DEFAULT false,
    -- [{ "type", "meta", "n", "email": { "subject", "body" } }, ...]: en post per notis-anrop, n mottagare var, i tur och ordning i de två raderna nedan.
    "entries"         JSONB NOT NULL,
    "recipientIds"    UUID[] NOT NULL,
    "notificationIds" UUID[] NOT NULL,
    "status"          TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    -- Tidigast när raden tas (ett omförsök efter ett tillfälligt fel väntar här).
    "notBefore"       TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "claimedBy"       TEXT,
    "leaseUntil"      TIMESTAMPTZ(6),
    "attempts"        INTEGER NOT NULL DEFAULT 0,
    -- Frysta paket: { "from", "mail": [[adress, ...], ...], "push": [[{ ... }, ...], ...] }. Töms med raden.
    "plan"            JSONB,
    "mailDone"        INTEGER NOT NULL DEFAULT 0,
    "pushDone"        INTEGER NOT NULL DEFAULT 0,
    "mailsSent"       INTEGER NOT NULL DEFAULT 0,
    "mailsFailed"     INTEGER NOT NULL DEFAULT 0,
    "pushSent"        INTEGER NOT NULL DEFAULT 0,
    "pushFailed"      INTEGER NOT NULL DEFAULT 0,
    "finishedAt"      TIMESTAMPTZ(6),
    "reason"          TEXT,

    CONSTRAINT "OutboundNotices_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OutboundNotices_status_is_known" CHECK ("status" IN ('PENDING', 'CLAIMED', 'DONE', 'GAVE_UP')),
    -- Hållen är allt eller inget: en rad som väntar eller är färdig har varken en claim eller en lease.
    CONSTRAINT "OutboundNotices_claim_matches_status" CHECK (
      ("status" = 'CLAIMED') = ("claimedBy" IS NOT NULL) AND ("status" = 'CLAIMED') = ("leaseUntil" IS NOT NULL)
    ),
    CONSTRAINT "OutboundNotices_finished_has_a_time" CHECK (("status" IN ('DONE', 'GAVE_UP')) = ("finishedAt" IS NOT NULL)),
    CONSTRAINT "OutboundNotices_reason_is_known" CHECK (
      "reason" IS NULL OR ("status" = 'GAVE_UP' AND "reason" IN ('STALE', 'ATTEMPTS'))
    ),
    CONSTRAINT "OutboundNotices_recipients_match" CHECK (cardinality("recipientIds") = cardinality("notificationIds")),
    CONSTRAINT "OutboundNotices_entries_is_a_list" CHECK (jsonb_typeof("entries") = 'array'),
    -- Gallring: en färdig rad bär ingenting om en person (inga mottagare, ingen notis, ingen plan med adresser och tokens).
    CONSTRAINT "OutboundNotices_finished_holds_no_person" CHECK (
      "status" NOT IN ('DONE', 'GAVE_UP')
      OR ("entries" = '[]'::jsonb AND cardinality("recipientIds") = 0 AND cardinality("notificationIds") = 0 AND "plan" IS NULL)
    ),
    CONSTRAINT "OutboundNotices_waiting_has_recipients" CHECK (
      "status" IN ('DONE', 'GAVE_UP') OR (cardinality("recipientIds") BETWEEN 1 AND 20000 AND jsonb_array_length("entries") BETWEEN 1 AND 2000)
    ),
    CONSTRAINT "OutboundNotices_counters_are_counts" CHECK (
      "attempts" >= 0 AND "mailDone" >= 0 AND "pushDone" >= 0
      AND "mailsSent" >= 0 AND "mailsFailed" >= 0 AND "pushSent" >= 0 AND "pushFailed" >= 0
    )
);

ALTER TABLE "OutboundNotices"
    ADD CONSTRAINT "OutboundNotices_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Det som väntar, i den ordning det tas (de två körfälten för sig).
CREATE INDEX "OutboundNotices_waiting_idx" ON "OutboundNotices"("urgent", "createdAt") WHERE "status" IN ('PENDING', 'CLAIMED');
-- Städningen av färdiga rader.
CREATE INDEX "OutboundNotices_finished_idx" ON "OutboundNotices"("finishedAt") WHERE "finishedAt" IS NOT NULL;
-- Nyckelns uppslag när en skola tas bort.
CREATE INDEX "OutboundNotices_schoolId_idx" ON "OutboundNotices"("schoolId");

CREATE TABLE "OutboundPace" (
    "channel" TEXT NOT NULL,
    "nextAt"  TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "OutboundPace_pkey" PRIMARY KEY ("channel"),
    CONSTRAINT "OutboundPace_channel_is_known" CHECK ("channel" IN ('EMAIL', 'PUSH'))
);

ALTER TABLE "OutboundNotices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OutboundPace" ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE "OutboundNotices" IS
  'H3 (20270309090000): the queue of outgoing e-mail and push, one row per lane and school of a committed transaction''s notices. Leased per row (app.outbound_claim), planned once (app.outbound_plan), stepped by two counters, emptied of everything about a person when it is DONE or GAVE_UP. RLS on, no arm and no grant: only the app.outbound_* functions touch it.';
COMMENT ON TABLE "OutboundPace" IS
  'H3 (20270309090000): when the next mail (EMAIL) and the next push request (PUSH) may go, whichever API instance sends it (app.outbound_slot). RLS on, no arm and no grant.';
COMMENT ON COLUMN "OutboundNotices"."recipientIds" IS
  'The people the notices are for, flattened in the order of "entries" (entry k holds its "n" ids). Ids only, as Notifications has them; gone when the row is DONE or GAVE_UP (CHECK).';
COMMENT ON COLUMN "OutboundNotices"."plan" IS
  'Frozen at the first claim: the mail packets (addresses after opt-outs) and the push packets (devices with their text). A retry sends the same packets, which is what an idempotency key needs. Holds addresses and tokens: gone when the row is DONE or GAVE_UP (CHECK).';
COMMENT ON COLUMN "OutboundNotices"."mailDone" IS
  'Mail packets taken by Resend. Counted AFTER the call: a retry after a crash sends the same packet under the same Idempotency-Key.';
COMMENT ON COLUMN "OutboundNotices"."pushDone" IS
  'Push packets begun. Counted BEFORE the call: Expo has no idempotency key, so a packet that was on its way when the process died is not sent again.';

-- ---------------------------------------------------------------------------
-- Dörrarna. Alla: SECURITY DEFINER, ingen inloggning (OB403), EXECUTE för app_authenticated ensam.
-- ---------------------------------------------------------------------------

-- Lägger in en rad. p_entries är entry-listan och p_recipients/p_notices de utplattade mottagarna (n per post). En full kö
-- (5 000 rader som väntar) nekas OB429: inkorgsraderna är redan skrivna, och leveransen loggar och går vidare.
CREATE FUNCTION app.outbound_enqueue(p_school uuid, p_urgent boolean, p_entries jsonb, p_recipients uuid[], p_notices uuid[])
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  made uuid;
  counted bigint;
BEGIN
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'OUTBOUND_NOTICES_IS_THE_JOBS' USING ERRCODE = 'OB403';
  END IF;
  SELECT count(*) INTO counted FROM "OutboundNotices" WHERE "status" IN ('PENDING', 'CLAIMED');
  IF counted >= 5000 THEN
    RAISE EXCEPTION 'OUTBOUND_QUEUE_FULL' USING ERRCODE = 'OB429';
  END IF;
  INSERT INTO "OutboundNotices" ("schoolId", "urgent", "entries", "recipientIds", "notificationIds")
  VALUES (p_school, p_urgent, p_entries, p_recipients, p_notices)
  RETURNING "id" INTO made;
  RETURN made;
END
$$;

-- Tar den äldsta raden i körfältet som väntar och är på tur, eller vars lease har gått ut, och ger den en claim.
CREATE FUNCTION app.outbound_claim(p_consumer text, p_urgent boolean, p_lease interval)
RETURNS TABLE (notice_id uuid, claim text, school_id uuid, urgent boolean, entries jsonb, recipient_ids uuid[],
               notification_ids uuid[], plan jsonb, mail_done integer, push_done integer, mails_failed integer, push_failed integer,
               attempts integer, created_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  picked uuid;
  token text := left(coalesce(p_consumer, 'consumer'), 80) || '/' || gen_random_uuid()::text;
  till timestamptz := clock_timestamp() + least(greatest(p_lease, interval '10 seconds'), interval '15 minutes');
BEGIN
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'OUTBOUND_NOTICES_IS_THE_JOBS' USING ERRCODE = 'OB403';
  END IF;
  SELECT n."id" INTO picked
    FROM "OutboundNotices" n
   WHERE n."urgent" = p_urgent
     AND ((n."status" = 'PENDING' AND n."notBefore" <= clock_timestamp())
          OR (n."status" = 'CLAIMED' AND n."leaseUntil" < clock_timestamp()))
   ORDER BY n."createdAt", n."id"
   LIMIT 1
     FOR UPDATE SKIP LOCKED;
  IF picked IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  WITH taken AS (
    UPDATE "OutboundNotices" n
       SET "status" = 'CLAIMED', "claimedBy" = token, "leaseUntil" = till, "attempts" = n."attempts" + 1
     WHERE n."id" = picked
    RETURNING n."id", n."schoolId", n."urgent", n."entries", n."recipientIds", n."notificationIds", n."plan",
              n."mailDone", n."pushDone", n."mailsFailed", n."pushFailed", n."attempts", n."createdAt"
  )
  SELECT t."id", token, t."schoolId", t."urgent", t."entries", t."recipientIds", t."notificationIds", t."plan",
         t."mailDone", t."pushDone", t."mailsFailed", t."pushFailed", t."attempts", t."createdAt"
    FROM taken t;
END
$$;

-- Sparar planen, en gång, för den som håller claimen.
CREATE FUNCTION app.outbound_plan(p_id uuid, p_claim text, p_plan jsonb, p_lease interval)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  changed integer;
BEGIN
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'OUTBOUND_NOTICES_IS_THE_JOBS' USING ERRCODE = 'OB403';
  END IF;
  UPDATE "OutboundNotices"
     SET "plan" = p_plan,
         "leaseUntil" = clock_timestamp() + least(greatest(p_lease, interval '10 seconds'), interval '15 minutes')
   WHERE "id" = p_id AND "status" = 'CLAIMED' AND "claimedBy" = p_claim AND "plan" IS NULL;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END
$$;

-- Ett steg: räknarna går framåt (aldrig bakåt), talen läggs till och leasen förnyas. Nej (false) betyder att någon annan har raden.
CREATE FUNCTION app.outbound_advance(p_id uuid, p_claim text, p_lease interval, p_mail_done integer, p_push_done integer,
                                     p_mail_sent integer, p_mail_failed integer, p_push_sent integer, p_push_failed integer)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  changed integer;
BEGIN
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'OUTBOUND_NOTICES_IS_THE_JOBS' USING ERRCODE = 'OB403';
  END IF;
  UPDATE "OutboundNotices"
     SET "mailDone" = greatest("mailDone", p_mail_done),
         "pushDone" = greatest("pushDone", p_push_done),
         "mailsSent" = "mailsSent" + greatest(p_mail_sent, 0),
         "mailsFailed" = "mailsFailed" + greatest(p_mail_failed, 0),
         "pushSent" = "pushSent" + greatest(p_push_sent, 0),
         "pushFailed" = "pushFailed" + greatest(p_push_failed, 0),
         "leaseUntil" = clock_timestamp() + least(greatest(p_lease, interval '10 seconds'), interval '15 minutes')
   WHERE "id" = p_id AND "status" = 'CLAIMED' AND "claimedBy" = p_claim;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END
$$;

-- Färdig eller uppgiven: raden töms på allt om en person och blir en rad av tal.
CREATE FUNCTION app.outbound_finish(p_id uuid, p_claim text, p_status text, p_reason text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  changed integer;
BEGIN
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'OUTBOUND_NOTICES_IS_THE_JOBS' USING ERRCODE = 'OB403';
  END IF;
  IF p_status NOT IN ('DONE', 'GAVE_UP') THEN
    RAISE EXCEPTION 'OUTBOUND_STATUS_IS_UNKNOWN' USING ERRCODE = '22023';
  END IF;
  UPDATE "OutboundNotices"
     SET "status" = p_status,
         "reason" = CASE WHEN p_status = 'GAVE_UP' THEN p_reason ELSE NULL END,
         "finishedAt" = clock_timestamp(),
         "claimedBy" = NULL, "leaseUntil" = NULL,
         "entries" = '[]'::jsonb, "recipientIds" = '{}', "notificationIds" = '{}', "plan" = NULL
   WHERE "id" = p_id AND "status" = 'CLAIMED' AND "claimedBy" = p_claim;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END
$$;

-- Lämnar tillbaka raden för ett omförsök efter p_delay (ett tillfälligt fel, eller en process som stängs ner), med planen och räknarna kvar.
CREATE FUNCTION app.outbound_release(p_id uuid, p_claim text, p_delay interval)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  changed integer;
BEGIN
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'OUTBOUND_NOTICES_IS_THE_JOBS' USING ERRCODE = 'OB403';
  END IF;
  UPDATE "OutboundNotices"
     SET "status" = 'PENDING', "claimedBy" = NULL, "leaseUntil" = NULL,
         "notBefore" = clock_timestamp() + least(greatest(p_delay, interval '0 seconds'), interval '1 hour')
   WHERE "id" = p_id AND "status" = 'CLAIMED' AND "claimedBy" = p_claim;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END
$$;

-- Nästa tid för ett mejl (EMAIL) eller ett pushanrop (PUSH), för hela flottan: hur många millisekunder som återstår tills det får gå.
-- Varje anrop tar en plats p_interval_ms efter den förra, så två instanser delar leverantörens takt i stället för att dubblera den.
CREATE FUNCTION app.outbound_slot(p_channel text, p_interval_ms integer)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  step interval := make_interval(secs => least(greatest(p_interval_ms, 1), 10000) / 1000.0);
  at timestamptz;
BEGIN
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'OUTBOUND_NOTICES_IS_THE_JOBS' USING ERRCODE = 'OB403';
  END IF;
  INSERT INTO "OutboundPace" AS p ("channel", "nextAt") VALUES (p_channel, clock_timestamp() + step)
  ON CONFLICT ("channel") DO UPDATE
     SET "nextAt" = greatest(p."nextAt", clock_timestamp()) + step
  RETURNING p."nextAt" - step INTO at;
  RETURN greatest(0, ceil(extract(epoch FROM (at - clock_timestamp())) * 1000))::integer;
END
$$;

-- Städningen: det som fastnat ger upp (20 timmar, eller 30 försök) och det som är färdigt tas bort efter sju dagar.
CREATE FUNCTION app.outbound_sweep()
RETURNS TABLE (gave_up integer, deleted integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  gone integer;
  removed integer;
BEGIN
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'OUTBOUND_NOTICES_IS_THE_JOBS' USING ERRCODE = 'OB403';
  END IF;
  WITH stale AS (
    SELECT n."id" FROM "OutboundNotices" n
     WHERE n."status" IN ('PENDING', 'CLAIMED')
       AND (n."createdAt" < clock_timestamp() - interval '20 hours' OR n."attempts" >= 30)
       AND (n."status" = 'PENDING' OR n."leaseUntil" < clock_timestamp())
       FOR UPDATE SKIP LOCKED
  )
  UPDATE "OutboundNotices" n
     SET "status" = 'GAVE_UP',
         "reason" = CASE WHEN n."createdAt" < clock_timestamp() - interval '20 hours' THEN 'STALE' ELSE 'ATTEMPTS' END,
         "finishedAt" = clock_timestamp(),
         "claimedBy" = NULL, "leaseUntil" = NULL,
         "entries" = '[]'::jsonb, "recipientIds" = '{}', "notificationIds" = '{}', "plan" = NULL
    FROM stale
   WHERE n."id" = stale."id";
  GET DIAGNOSTICS gone = ROW_COUNT;
  DELETE FROM "OutboundNotices" WHERE "finishedAt" < clock_timestamp() - interval '7 days';
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN QUERY SELECT gone, removed;
END
$$;

-- Adresserna till de mottagare som finns kvar: aktiva personer i skolan med en adress. Läses när raden planeras, inte när den köas.
CREATE FUNCTION app.outbound_addresses(p_school uuid, p_users uuid[])
RETURNS TABLE (user_id uuid, email text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT u."id", u."email"
    FROM "Users" u
   WHERE u."schoolId" = p_school
     AND nullif(current_setting('request.jwt.claims', true), '') IS NULL
     AND nullif(current_setting('request.jwt.claim.sub', true), '') IS NULL
     AND u."id" = ANY (p_users)
     AND u."isActive"
     AND nullif(btrim(u."email"), '') IS NOT NULL
   ORDER BY u."id"
$$;

COMMENT ON FUNCTION app.outbound_enqueue(uuid, boolean, jsonb, uuid[], uuid[]) IS
  'H3: adds one row to the outgoing queue (one lane of one school''s notices from a committed transaction). Refuses (OB429) a queue of 5000 rows waiting. Jobbets dörr: refused (OB403) to a session with any login.';
COMMENT ON FUNCTION app.outbound_claim(text, boolean, interval) IS
  'H3: the oldest row of the lane that waits and is due, or whose lease has run out, FOR UPDATE SKIP LOCKED; answers it with a claim every later step must show. Jobbets dörr: refused (OB403) to a session with any login.';
COMMENT ON FUNCTION app.outbound_plan(uuid, text, jsonb, interval) IS
  'H3: stores the frozen packets once, for the holder of the claim. False when somebody else holds the row or it is planned already.';
COMMENT ON FUNCTION app.outbound_advance(uuid, text, interval, integer, integer, integer, integer, integer, integer) IS
  'H3: moves the packet counters forward (never back), adds the sent and failed counts and renews the lease, for the holder of the claim. False when somebody else holds the row.';
COMMENT ON FUNCTION app.outbound_finish(uuid, text, text, text) IS
  'H3: DONE or GAVE_UP; the row is emptied of the notices, the recipients and the plan (a CHECK holds it to that). False when somebody else holds the row.';
COMMENT ON FUNCTION app.outbound_release(uuid, text, interval) IS
  'H3: hands the row back for a retry after p_delay (at most an hour), with its plan and counters kept, for the holder of the claim.';
COMMENT ON FUNCTION app.outbound_slot(text, integer) IS
  'H3: the provider''s pace for the whole fleet: reserves the next slot of EMAIL or PUSH p_interval_ms after the last and answers how many milliseconds until it comes.';
COMMENT ON FUNCTION app.outbound_sweep() IS
  'H3: gives up a row that has waited 20 hours or been tried 30 times (emptied like a DONE row) and deletes finished rows older than seven days. Answers how many of each.';
COMMENT ON FUNCTION app.outbound_addresses(uuid, uuid[]) IS
  'H3: the e-mail addresses of the active people of p_school among p_users who have one. Jobbets dörr: empty for a session with any login.';

-- ---------------------------------------------------------------------------
-- Rättigheter, vaktade som 20261013110000.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  fn text;
  r text;
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['OutboundNotices', 'OutboundPace'] LOOP
    FOREACH r IN ARRAY ARRAY['app_authenticated', 'authenticated', 'anon', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;

  FOREACH fn IN ARRAY ARRAY[
    'app.outbound_enqueue(uuid, boolean, jsonb, uuid[], uuid[])',
    'app.outbound_claim(text, boolean, interval)',
    'app.outbound_plan(uuid, text, jsonb, interval)',
    'app.outbound_advance(uuid, text, interval, integer, integer, integer, integer, integer, integer)',
    'app.outbound_finish(uuid, text, text, text)',
    'app.outbound_release(uuid, text, interval)',
    'app.outbound_slot(text, integer)',
    'app.outbound_sweep()',
    'app.outbound_addresses(uuid, uuid[])'
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
-- OUTBOUND_REACH: ingen policy på tabellerna, och ingen roll har en rättighet på dem.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(p.tablename || '.' || p.policyname, ', ' ORDER BY p.tablename, p.policyname) INTO bad
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename IN ('OutboundNotices', 'OutboundPace');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'OUTBOUND_REACH: the outgoing queue has arms: %', bad;
  END IF;
  SELECT string_agg(g.grantee || ' on ' || g.table_name, ', ') INTO bad
    FROM information_schema.role_table_grants g
   WHERE g.table_schema = 'public' AND g.table_name IN ('OutboundNotices', 'OutboundPace')
     AND g.grantee IN ('app_authenticated', 'authenticated', 'anon', 'service_role', 'PUBLIC');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'OUTBOUND_REACH: the outgoing queue has grants: %', bad;
  END IF;
END
$$;
