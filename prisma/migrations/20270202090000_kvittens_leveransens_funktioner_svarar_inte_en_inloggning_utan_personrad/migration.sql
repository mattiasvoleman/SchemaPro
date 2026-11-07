-- Kvittens, efter den oberoende granskningen av #277 (LÅG-1): leveransens två
-- funktioner svarar ingenting åt en inloggning, också när inloggningen inte är
-- en person.
--
-- ## Vad som fanns
--
-- app.ack_remind_request (påminnelsepassets dörr, 20270117091000) och
-- app.ack_reminder_mirrored (leveransens märkning, 20270119090000) är till för
-- jobbets dörr, som inte sätter några claims. Båda vaktade på det de kallade
-- "en inloggad":
--
--   IF app.current_user_id() IS NOT NULL THEN RETURN; END IF;
--
-- Men en inloggning behöver inte vara en person. Huvudmannens läsare och
-- kommunadministratören har claims och väljer en skola, och
-- app.current_user_id() är NULL för dem, eftersom de saknar Users-rad där. För
-- dem släppte vakten igenom, och UPDATE-satsen i märkningen har ingen
-- skolkontroll: kommentaren på funktionen ("svarar inget till en inloggad
-- anropare") sade mer än vakten höll. Ingen gatewayväg når funktionerna med ett
-- id som en inloggad väljer (påminnelsepasset tar id:t ur sin egen kö), och
-- läsaren kan inte skriva AckRequests, så ingenting har hänt; det var ett
-- försvar på djupet som inte höll för den inloggning som saknar personrad.
--
-- ## Vad det blir
--
-- Vakten frågar efter det leveransens dörr faktiskt är, ingen inloggning alls:
-- inga claims (request.jwt.claims) och ingen ensam subjektsinställning
-- (request.jwt.claim.sub, som äldre byggen och Supabase läser). Tom sträng räknas
-- som ingenting, eftersom en poolad anslutning som någon förfrågan har använt
-- läser inställningarna som '' och inte som NULL. En person, huvudmannens
-- läsare och en kommunadministratör är alla inloggningar, och
-- funktionerna svarar dem ingenting. Rättigheten är oförändrad: det är
-- fortfarande GRANT EXECUTE till app_authenticated som gör funktionerna till
-- leveransens; vakten stänger bara ute dem som har en inloggning.
--
-- ## Vad som inte ändras
--
-- Signaturer, returtyp, VOLATILE, SECURITY DEFINER, search_path och rättigheterna
-- är desamma (CREATE OR REPLACE behåller ägare och ACL; det som inte sägs om igen
-- återställs, så LANGUAGE, flyktighet och search_path är skrivna som förut).
-- Kropparna är i övrigt tecken för tecken de förras: bara vakten är ny.
--
--                           md5(prosrc) före                   efter
--   ack_remind_request      894541402de92108263324294f19c4db   6836f7ae29327c074a4dc7b62776837b
--   ack_reminder_mirrored   edaea80452b04494beeb73668086bcc0   308fe14167295988d49d575cdf0f1856
--
-- Ingen annan funktion ändras: de tjugo andra app.ack_-funktionerna (app.ack_usage, 2534cef97c828b5999ce076aff18f9d3,
-- bland dem) och de tre gallring-funktionerna har samma md5 före och efter.
--
-- ## Låsen
--
-- Ingen tabell rörs, så ingen tabell låses: CREATE OR REPLACE FUNCTION tar bara
-- ett kort lås på funktionens egen rad i pg_proc. Lärdomen från #277:s fil (en
-- ADD COLUMN tar ACCESS EXCLUSIVE på AckRequests först i filen och håller den
-- till filens slut) gäller den som lägger en ALTER TABLE här: den ska stå sist,
-- eller ta låset med NOWAIT i en slinga med tak (docs/DEPLOYMENT.md, Kvittens).

-- ---------------------------------------------------------------------------
-- Påminnelsepassets dörr
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.ack_remind_request(p_request uuid)
RETURNS TABLE (notification_id uuid, user_id uuid, school_id uuid, email text, meta jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  q record;
  ids uuid[] := '{}';
  how "AckReminderOutcome";
BEGIN
  -- Leveransens dörr sätter inga claims; varje inloggning gör det, också en som inte är en person (huvudmannens läsare).
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RETURN;
  END IF;
  SELECT a."id", a."schoolId", a."title", a."remindAt" INTO q
    FROM "AckRequests" a
   WHERE a."id" = p_request AND a."remindAt" IS NOT NULL AND a."remindAt" <= clock_timestamp() AND a."reminderOutcome" IS NULL
     FOR NO KEY UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF NOT coalesce((SELECT s."enabled" FROM "AckSettings" s WHERE s."schoolId" = q."schoolId"), false) THEN
    how := 'OFF';
  ELSIF q."remindAt" < clock_timestamp() - interval '30 days' THEN
    how := 'LAPSED';
  ELSE
    WITH due AS (
      UPDATE "AckReceipts" r SET "remindedAt" = clock_timestamp()
       WHERE r."requestId" = q."id" AND r."schoolId" = q."schoolId" AND r."ackedAt" IS NULL AND r."remindedAt" IS NULL
         AND app.ack_receipt_open(r."guardianId", r."studentId", r."schoolId")
      RETURNING r."guardianId"
    ),
    who AS (SELECT DISTINCT d."guardianId" FROM due d),
    written AS (
      INSERT INTO "Notifications" AS nt ("schoolId", "userId", "type", "meta")
      SELECT q."schoolId", w."guardianId", 'ACK_REMINDER',
             jsonb_build_object('requestId', q."id", 'title', q."title")
        FROM who w
      RETURNING nt."id"
    )
    SELECT coalesce(array_agg(wr."id"), '{}'::uuid[]) INTO ids FROM written wr;
    how := CASE WHEN cardinality(ids) > 0 THEN 'SENT'::"AckReminderOutcome" ELSE 'NOT_NEEDED'::"AckReminderOutcome" END;
  END IF;

  UPDATE "AckRequests" a
     SET "reminderOutcome" = how,
         "reminderSentAt" = CASE WHEN how = 'SENT' THEN clock_timestamp() END
   WHERE a."id" = q."id";

  RETURN QUERY
    SELECT nt."id", nt."userId", nt."schoolId", u."email", nt."meta"
      FROM "Notifications" nt
      JOIN "Users" u ON u."id" = nt."userId" AND u."schoolId" = nt."schoolId"
     WHERE nt."id" = ANY (ids);
END
$$;

-- ---------------------------------------------------------------------------
-- Leveransens märkning
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.ack_reminder_mirrored(p_request uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  -- Leveransens dörr sätter inga claims; varje inloggning gör det, också en som inte är en person (huvudmannens läsare).
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RETURN;
  END IF;
  UPDATE "AckRequests" a
     SET "reminderMirroredAt" = clock_timestamp()
   WHERE a."id" = p_request AND a."reminderOutcome" = 'SENT' AND a."reminderMirroredAt" IS NULL;
END
$$;

COMMENT ON FUNCTION app.ack_remind_request(uuid) IS
  'Kvittens: the job''s pass over one request, in its own transaction; writes one ACK_REMINDER per guardian who has not confirmed and still can, records how the reminder ended, and answers the notices with the addresses for the delivery after the commit; nothing for a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.ack_reminder_mirrored(uuid) IS
  'Kvittens: the delivery marks a SENT reminder as taken by its channels. Answers nothing to a session with any login (claims), a person or not, for a request not SENT or already marked.';
