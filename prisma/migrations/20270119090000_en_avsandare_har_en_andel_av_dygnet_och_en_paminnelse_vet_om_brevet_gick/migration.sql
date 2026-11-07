-- Kvittens, efter granskningen av F4 (20270117091000): två saker som granskarna
-- fann innan någon skola slagit på funktionen.
--
-- ## En påminnelse som står som skickad
--
-- Påminnelsepasset skrev notiserna och märkte förfrågan SENT i samma
-- transaktion; brevet och pushen går efter commit, genom leveransens kö i
-- processens minne. En omstart mitt i kön tömmer den, och personalens vy sa
-- "Skickad" för en påminnelse vars brev aldrig gick. SENT betyder fortfarande
-- det databasen vet: notiserna ligger i vårdnadshavarnas inkorgar. Det nya är
-- "AckRequests"."reminderMirroredAt": när leveransen sa att e-posten och pushen
-- hade tagits emot av sina kanaler (eller att det inte fanns någon kanal utanför
-- inkorgen). Den sätts av leveransen, genom app.ack_reminder_mirrored, aldrig av
-- en skrivare, och bara på en förfrågan som är SENT. Saknas den visar
-- gatewayen tillståndet WRITTEN ("lagd i inkorgen"): sant, men brevet och
-- pushen är inte bekräftade. Ingen skickar om dem; en påminnelse går en gång.
--
-- ## En avsändares andel av skolans dygn
--
-- Skolans gräns på 20 000 nya rader på ett dygn (KV428) delades av alla
-- avsändare: två mentorskonton med 30 elever vardera skriver 66 rader per
-- förfrågan och tio förfrågningar i timmen, 15 840 rader var på ett dygn, och
-- tömde skolans dygn för alla, rektorn med. Varje avsändare har därför en egen
-- andel av dygnet (KV427, ACK_SENDER_DAY_LIMIT), räknad som raderna i de
-- förfrågningar hen skrivit de senaste 24 timmarna:
--
--   en administratör   8 000 rader
--   en lärare          2 000 rader
--
-- Talen är valda ur vad en avsändare behöver, och vad som får hända när hen
-- kapas. En helskolsförfrågan är elever x vårdnadshavare: 4 000 rader för 2 000
-- elever med två vårdnadshavare var, och 5 700 för den största skolan vi räknar
-- med (2 600 elever); en administratör behöver rymma en sådan, och 8 000 rymmer
-- en sådan och en halv till, eller två av de vanliga. En lärare frågar bara om
-- sina mentorselever, 30 till 60, alltså 66 till 132 rader per förfrågan: 2 000
-- rader är femton till trettio förfrågningar på ett dygn, mer än tio gånger vad
-- en mentor skriver. Mot skolans 20 000: ingen ensam avsändare kan tömma dygnet,
-- inte heller två administratörer (16 000), och för lärare krävs tio konton (att
-- två mentorskonton tömde skolan var granskningens fynd). Skolans gräns står
-- kvar som taket över alla.
--
-- Andelen räknas per författare till förfrågan, inte per den som skriver
-- raderna: det är författaren som skickar, och en administratör som lägger ett
-- kvitto i någon annans förfrågan (L1 i granskningen) ökar inte sin egen andel
-- utan författarens. Avsändarens lås (samma nyckel som ack_requests_stamp tar)
-- tas före skolans, alltid i den ordningen, så att två förfrågningar från samma
-- avsändare inte båda passerar gränsen. Tidsgränsen för 24 timmar läses en gång
-- per uttalande i en variabel, inte med clock_timestamp() i villkoret: en
-- volatil funktion i ett villkor är inget indexvillkor, och skolans räkning
-- läste då alla skolans rader i stället för dygnets.
--
-- Gränserna har ett ställe var, app.ack_day_limit; ack_receipts_limit och
-- app.ack_usage (administratörens förbrukning på Kvittens-sidan) frågar båda
-- den, så att räkningen som visas och räkningen som nekar inte kan glida isär.
--
-- ## Låsen
--
-- En kolumn utan förval och en CHECK på en tabell som ingen skola har rader i
-- (Kvittens är av överallt); ACCESS EXCLUSIVE tas i några millisekunder, med
-- lock_timeout. Nycklarna i 20270117091000 rörs inte, så Users och Schools
-- behöver inte låsas.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "AckRequests" ADD COLUMN "reminderMirroredAt" TIMESTAMPTZ(6);
-- Bara en SENT-påminnelse har gått ut genom leveransen; satt av leveransen (app.ack_reminder_mirrored), aldrig av en skrivare.
ALTER TABLE "AckRequests"
    ADD CONSTRAINT "AckRequests_only_a_sent_reminder_is_mirrored"
    CHECK ("reminderMirroredAt" IS NULL OR "reminderOutcome" IS NOT DISTINCT FROM 'SENT');

-- ---------------------------------------------------------------------------
-- Att brevet och pushen togs emot
-- ---------------------------------------------------------------------------

-- Märker en SENT-påminnelse som vidarebefordrad av leveransen: dess e-post och
-- push har tagits emot av sina kanaler. Kallas av leveransen efter att den
-- tagits emot, i en transaktion av sin egen; svarar inget till en inloggad
-- anropare (jobbets dörr sätter inga claims), för en förfrågan som inte är SENT
-- eller redan märkt. Märker aldrig om: första tiden står.
CREATE FUNCTION app.ack_reminder_mirrored(p_request uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF app.current_user_id() IS NOT NULL THEN
    RETURN;
  END IF;
  UPDATE "AckRequests" a
     SET "reminderMirroredAt" = clock_timestamp()
   WHERE a."id" = p_request AND a."reminderOutcome" = 'SENT' AND a."reminderMirroredAt" IS NULL;
END
$$;

-- ---------------------------------------------------------------------------
-- Dygnets gränser, på ett ställe
-- ---------------------------------------------------------------------------

-- Hur många nya rader av AckReceipts en skola ('SCHOOL') och en avsändare av en
-- roll ('SCHOOL_ADMIN', 'TEACHER') får ha på 24 timmar. Ändra ett tal är en
-- migrering (CREATE OR REPLACE av den här funktionen).
CREATE FUNCTION app.ack_day_limit(p_kind text) RETURNS integer
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF p_kind = 'SCHOOL' THEN RETURN 20000; END IF;
  IF p_kind = 'SCHOOL_ADMIN' THEN RETURN 8000; END IF;
  IF p_kind = 'TEACHER' THEN RETURN 2000; END IF;
  -- En gräns som inte finns får aldrig läsas som "ingen gräns" (NULL i en jämförelse).
  RAISE EXCEPTION 'ACK_UNKNOWN_LIMIT %', p_kind;
END
$$;

-- Skolans dygn och avsändarens andel. Räknas efter uttalandet, över skolans
-- senaste dygn, så att uttalandets egna rader är med och en förfrågan som går
-- över rullas tillbaka hel. Avsändarens först (KV427): den kan avsändaren själv
-- göra något åt. Lås: avsändarna först (sorterade), skolan sedan, alltid i den
-- ordningen; ack_requests_stamp tar avsändarens redan när förfrågan skrivs.
CREATE OR REPLACE FUNCTION app.ack_receipts_limit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  school uuid;
  author uuid;
  authors uuid[];
  kind text;
  cutoff timestamptz;
BEGIN
  IF app.current_user_id() IS NULL THEN
    RETURN NULL;
  END IF;
  FOR school IN SELECT DISTINCT i."schoolId" FROM ins i ORDER BY 1 LOOP
    SELECT coalesce(array_agg(DISTINCT q."authorId" ORDER BY q."authorId"), '{}') INTO authors
      FROM ins i JOIN "AckRequests" q ON q."id" = i."requestId" AND q."schoolId" = i."schoolId"
     WHERE i."schoolId" = school AND q."authorId" IS NOT NULL;
    FOREACH author IN ARRAY authors LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended('ack-author:' || author::text, 0));
    END LOOP;
    PERFORM pg_advisory_xact_lock(hashtextextended('ack-school:' || school::text, 0));
    cutoff := clock_timestamp() - interval '24 hours';

    FOREACH author IN ARRAY authors LOOP
      SELECT CASE u."role" WHEN 'SCHOOL_ADMIN' THEN 'SCHOOL_ADMIN' ELSE 'TEACHER' END INTO kind
        FROM "Users" u WHERE u."id" = author AND u."schoolId" = school;
      IF (SELECT count(*) FROM "AckRequests" q
            JOIN "AckReceipts" r ON r."requestId" = q."id" AND r."schoolId" = q."schoolId"
           WHERE q."authorId" = author AND q."schoolId" = school AND q."createdAt" > cutoff)
         > app.ack_day_limit(coalesce(kind, 'TEACHER')) THEN
        RAISE EXCEPTION 'ACK_SENDER_DAY_LIMIT' USING ERRCODE = 'KV427';
      END IF;
    END LOOP;

    IF (SELECT count(*) FROM "AckReceipts" r WHERE r."schoolId" = school AND r."createdAt" > cutoff)
       > app.ack_day_limit('SCHOOL') THEN
      RAISE EXCEPTION 'ACK_TOO_MANY_RECIPIENTS' USING ERRCODE = 'KV428';
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

-- ---------------------------------------------------------------------------
-- Förbrukningen på Kvittens-sidan
-- ---------------------------------------------------------------------------

-- Dygnets förbrukning, för personal. Tre sorters rader:
--   SCHOOL   skolans rader det senaste dygnet och skolans gräns (en administratör);
--   ME       anroparens egna rader (de förfrågningar hen skrivit) och hens andel;
--   SENDER   de p_senders avsändare som skrivit flest, med sina andelar (en
--            administratör som får läsa Drift): namnet som det stod när
--            förfrågan skrevs, NULL som id för en som tagits bort.
-- Sorteringen bland lika är namnet med COLLATE "C" och id:t: svaret ska vara
-- detsamma på varje databas. En vårdnadshavare, en elev eller en inloggning
-- utan person får KV403.
CREATE FUNCTION app.ack_usage(p_senders integer DEFAULT 5)
RETURNS TABLE (scope text, author_id uuid, author_name text, used integer, cap integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  me uuid := app.current_user_id();
  sch uuid := app.current_school_id();
  my_role text := app.current_user_role();
  cutoff timestamptz := clock_timestamp() - interval '24 hours';
BEGIN
  IF me IS NULL OR sch IS NULL OR my_role NOT IN ('TEACHER', 'SCHOOL_ADMIN') THEN
    RAISE EXCEPTION 'ACK_NOT_STAFF' USING ERRCODE = 'KV403';
  END IF;

  IF my_role = 'SCHOOL_ADMIN' THEN
    RETURN QUERY
      SELECT 'SCHOOL'::text, NULL::uuid, NULL::text,
             (SELECT count(*)::integer FROM "AckReceipts" r WHERE r."schoolId" = sch AND r."createdAt" > cutoff),
             app.ack_day_limit('SCHOOL');
  END IF;

  RETURN QUERY
    SELECT 'ME'::text, me, NULL::text,
           (SELECT count(*)::integer FROM "AckRequests" q
              JOIN "AckReceipts" r ON r."requestId" = q."id" AND r."schoolId" = q."schoolId"
             WHERE q."authorId" = me AND q."schoolId" = sch AND q."createdAt" > cutoff),
           app.ack_day_limit(my_role);

  IF my_role = 'SCHOOL_ADMIN' AND app.current_user_may('DRIFT', false) THEN
    RETURN QUERY
      WITH sent AS (
        SELECT q."authorId" AS author, max(q."authorName") AS named, count(*)::integer AS rows_sent
          FROM "AckRequests" q
          JOIN "AckReceipts" r ON r."requestId" = q."id" AND r."schoolId" = q."schoolId"
         WHERE q."schoolId" = sch AND q."createdAt" > cutoff
         GROUP BY q."authorId"
      )
      SELECT 'SENDER'::text, s.author, s.named, s.rows_sent,
             app.ack_day_limit(coalesce((SELECT CASE u."role" WHEN 'SCHOOL_ADMIN' THEN 'SCHOOL_ADMIN' ELSE 'TEACHER' END
                                           FROM "Users" u WHERE u."id" = s.author AND u."schoolId" = sch), 'TEACHER'))
        FROM sent s
       ORDER BY s.rows_sent DESC, s.named COLLATE "C", s.author
       LIMIT greatest(p_senders, 0);
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Rättigheter och kommentarer
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  fn text;
  r text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'app.ack_reminder_mirrored(uuid)',
    'app.ack_day_limit(text)',
    'app.ack_usage(integer)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', fn, r);
      END IF;
    END LOOP;
  END LOOP;
  -- The API role runs the delivery's mark and the usage; the limits are the owner's, asked by the trigger and the usage.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    FOREACH fn IN ARRAY ARRAY['app.ack_reminder_mirrored(uuid)', 'app.ack_usage(integer)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO "app_authenticated"', fn);
    END LOOP;
  END IF;
END
$$;

COMMENT ON COLUMN "AckRequests"."reminderMirroredAt" IS
  'Kvittens: when the delivery said the reminder''s e-mail and push were taken by their channels (or that there were none outside the inbox). NULL on a SENT reminder: the inbox notices are written, the rest is not confirmed. Set by app.ack_reminder_mirrored only.';
COMMENT ON FUNCTION app.ack_reminder_mirrored(uuid) IS
  'Kvittens: the delivery marks a SENT reminder as taken by its channels. Answers nothing to a logged-in caller, for a request not SENT or already marked.';
COMMENT ON FUNCTION app.ack_day_limit(text) IS
  'Kvittens: new AckReceipts rows in 24 hours that a school (SCHOOL, 20 000), an administrator (SCHOOL_ADMIN, 8 000) and a teacher (TEACHER, 2 000) may have. An unknown kind is an error, never "no limit".';
COMMENT ON FUNCTION app.ack_receipts_limit() IS
  'Kvittens: a sender has at most her share of the school''s day (KV427) and the school at most 20 000 new rows of AckReceipts in 24 hours (KV428), for a logged-in writer.';
COMMENT ON FUNCTION app.ack_usage(integer) IS
  'Kvittens: the last 24 hours'' use of the limits, for staff: the school (administrator), the caller, and the largest senders (an administrator who reads Drift).';
