-- En vårdnadshavare bekräftar ett meddelande om sitt barn.
--
-- Personal ber vårdnadshavarna till en eller flera elever att bekräfta att de
-- sett ett meddelande ("utflykten är på torsdag", "beslutet om ledighet", "vad
-- som hände vid larmet i går"). Vårdnadshavaren bekräftar med ett tryck i
-- appen eller webben, och den som bad ser vem som bekräftat och när. Skolan
-- väljer efter hur lång tid en vårdnadshavare som inte bekräftat påminns, en
-- gång. Avstängt som standard: en skola utan rad i AckSettings, eller med
-- enabled = false, har ingen kvittens och ingen kan skriva en förfrågan.
--
-- ## Tre tabeller
--
--   AckSettings   en rad per skola: på eller av, och efter hur många dygn den
--                 enda påminnelsen kommer (NULL: ingen). Inga personuppgifter.
--   AckRequests   förfrågan: titel, text, och om det räcker att en
--                 vårdnadshavare bekräftar eller om alla ska (ANY, ALL), ett
--                 val per förfrågan. Skrivs en gång och ändras aldrig: texten
--                 är det vårdnadshavaren såg. Personuppgifter (fri text om en
--                 elev): gallras med skolans val för NOTIFICATIONS.
--   AckReceipts   en rad per (förfrågan, elev, vårdnadshavare): vem som
--                 fick frågan om vilken elev, och när hen bekräftade. Raden är
--                 ögonblicksbilden av vem som frågades då förfrågan skrevs: en
--                 vårdnadshavare som kopplas till eleven senare är inte med,
--                 och en vårdnadshavare vars koppling upphört står kvar men
--                 kan inte bekräfta längre. En vårdnadshavare med två barn i
--                 förfrågan bekräftar en gång för båda.
--
-- ## Vem som är klar
--
-- Klart avgörs per elev, av en enda definition (app.ack_status), och lagras
-- inte: ANY är klar när någon vårdnadshavare bekräftat; ALL när någon
-- bekräftat och ingen vårdnadshavare som fortfarande är kopplad till eleven
-- väntar. En vårdnadshavare vars koppling upphört räknas inte som väntande
-- (hen kan inte bekräfta), men en bekräftelse hen gjorde innan dess står kvar.
-- En elev vars alla vårdnadshavare slutat utan bekräftelse är inte klar och har
-- ingen att fråga (waiting = 0). Eftersom klart inte lagras finns inget
-- tillstånd som två samtidiga bekräftelser kan skriva fel.
--
-- ## Bekräftelsen och påminnelsen
--
-- ackedAt och remindedAt skrivs av app.ack_confirm och app.ack_remind_due och
-- av ingenting annat: ingen roll har UPDATE på AckReceipts. Bekräftelsen
-- tar förfrågans rad FOR SHARE och elevens vårdnadskoppling FOR KEY SHARE:
-- två bekräftelser väntar inte på varandra, en koppling som tas bort
-- väntar tills bekräftelsen är klar (eller bekräftelsen på kopplingens
-- borttagning, och vägrar då), och påminnelsepasset, som tar förfrågans rad
-- FOR UPDATE SKIP LOCKED, hoppar över en förfrågan som just bekräftas i
-- stället för att fråga någon som just svarat. En bekräftelse som kommer
-- efter passets lås väntar på det. Dubbeltryck är ofarligt: den andra hittar
-- ackedAt satt och svarar samma tid.
--
-- ## Läsning
--
-- En vårdnadshavare ser bara sina egna rader och bara förfrågningar där hen
-- har en rad för ett barn hen fortfarande är kopplad till: efter att vårdnaden
-- upphört finns förfrågan inte för hen. Personal ser det de skrivit
-- (författaren), och en mentor ser rader om sina mentorselever; en administratör
-- ser skolans alla. En vårdnadshavare ser aldrig att den andra
-- vårdnadshavaren bekräftat eller inte: ingen arm ger henne en annans rad.
-- Allt går genom gatewayen, som loggar läsningen; ingen arm är öppen för
-- PostgREST (bara app_authenticated).
--
-- ## Gallring
--
-- En förfrågan och dess rader gallras när förfrågan är äldre än gränsen för
-- NOTIFICATIONS (skolans lokala midnatt), med raderna under sig via nyckeln.
-- Ingen ny RetentionDataType. app.gallring_due och app.gallring_purge nedan
-- är 20270113091000:s kroppar (Krisläges, som bär Rapporteringsgrads,
-- Frånvarobevakningens, Vikariefrågans och Skyddad identitets grenar) med en
-- gren märkt "kvittens"; en senare release som skriver om funktionerna igen
-- måste bära varje gren.
--
-- ## Vid sidan av det API som körs
--
-- Produktionen kör migreringen medan API:et före den betjänar förfrågningar.
-- Ingen befintlig tabell får en kolumn; de nya nycklarna tar Schools och Users
-- i SHARE ROW EXCLUSIVE, som blockerar skrivningar (inte läsningar och inte den
-- KEY SHARE en främmande nyckels kontroll tar) så länge filen går. En
-- förfrågan skriver Users och Schools i samma transaktion, så låsen tas
-- tillsammans, NOWAIT, i en loop: en vägran rullar tillbaka delbehandlingen
-- med vad den fått och försöker igen 50 ms senare, och den väntar aldrig med
-- ett lås i handen. Efter 30 s stannar den med ingenting gjort och kan köras
-- om (prisma migrate resolve --rolled-back, sedan deploy). lock_timeout
-- begränsar varje väntan ingen räknat med. Det gamla API:et känner ingen av
-- tabellerna och skriver aldrig en notis av de nya typerna.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Schools" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Users" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Schools and Users were not free at once in 30 s: nothing is changed. Prisma now holds this migration as failed, so run "prisma migrate resolve --rolled-back 20270117091000_en_vardnadshavare_bekraftar_ett_meddelande_om_sitt_barn" and then "prisma migrate deploy" again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

CREATE TYPE "AckRule" AS ENUM ('ANY', 'ALL');

-- ---------------------------------------------------------------------------
-- AckSettings
-- ---------------------------------------------------------------------------

CREATE TABLE "AckSettings" (
    "schoolId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    -- Dygn från att en förfrågan skrivs till den enda påminnelsen; NULL: ingen.
    "remindAfterDays" SMALLINT DEFAULT 2,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AckSettings_pkey" PRIMARY KEY ("schoolId"),
    CONSTRAINT "AckSettings_the_reminder_is_one_to_thirty_days" CHECK ("remindAfterDays" IS NULL OR "remindAfterDays" BETWEEN 1 AND 30)
);

ALTER TABLE "AckSettings"
    ADD CONSTRAINT "AckSettings_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- AckRequests
-- ---------------------------------------------------------------------------

CREATE TABLE "AckRequests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    -- Den som skrev; NULL sedan personen tagits bort (förfrågan står kvar).
    "authorId" UUID,
    -- Författarens namn när förfrågan skrevs, stämplat av triggern (en skrivare
    -- kan inte välja det; CHECK:en nedan vägrar det tomma): en vårdnadshavare
    -- läser inte personalens rader i Users, och namnet står kvar när personen
    -- tagits bort.
    "authorName" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "rule" "AckRule" NOT NULL DEFAULT 'ANY',
    -- Satt av triggern ur skolans val när förfrågan skrivs; en senare ändring
    -- av valet flyttar inte en förfrågan som redan gått ut.
    "remindAt" TIMESTAMPTZ(6),
    -- Jobbets märke att dess enda genomgång är gjord.
    "reminderSentAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AckRequests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AckRequests_id_schoolId_key" UNIQUE ("id", "schoolId"),
    CONSTRAINT "AckRequests_an_author_has_a_name" CHECK (char_length(btrim("authorName")) BETWEEN 1 AND 200),
    CONSTRAINT "AckRequests_a_title_is_one_to_120_characters" CHECK (char_length(btrim("title")) BETWEEN 1 AND 120),
    CONSTRAINT "AckRequests_a_text_is_one_to_2000_characters" CHECK (char_length(btrim("body")) BETWEEN 1 AND 2000),
    CONSTRAINT "AckRequests_a_reminder_was_due" CHECK ("reminderSentAt" IS NULL OR "remindAt" IS NOT NULL)
);

-- Passet frågar efter förfrågningar vars påminnelse är förfallen och inte gjord.
CREATE INDEX "AckRequests_reminder_due_idx" ON "AckRequests"("remindAt") WHERE "reminderSentAt" IS NULL AND "remindAt" IS NOT NULL;
-- Gallringens villkor och skolans lista.
CREATE INDEX "AckRequests_schoolId_createdAt_idx" ON "AckRequests"("schoolId", "createdAt");
-- En borttagen person hittar förfrågningarna hen skrev.
CREATE INDEX "AckRequests_authorId_schoolId_idx" ON "AckRequests"("authorId", "schoolId");

ALTER TABLE "AckRequests"
    ADD CONSTRAINT "AckRequests_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SET NULL på kolumnen ensam: en vanlig SET NULL på nyckeln (authorId, schoolId)
-- skulle tömma schoolId också och fälla gallringen med 23502 varje natt.
ALTER TABLE "AckRequests"
    ADD CONSTRAINT "AckRequests_authorId_schoolId_fkey" FOREIGN KEY ("authorId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE SET NULL ("authorId") ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- AckReceipts
-- ---------------------------------------------------------------------------

CREATE TABLE "AckReceipts" (
    "requestId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "guardianId" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "ackedAt" TIMESTAMPTZ(6),
    "remindedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- schoolId second, so the key starts with the columns of the key to AckRequests
    -- (the cascade from a removed request finds its receipts by it).
    CONSTRAINT "AckReceipts_pkey" PRIMARY KEY ("requestId", "schoolId", "studentId", "guardianId")
);

CREATE INDEX "AckReceipts_guardianId_schoolId_idx" ON "AckReceipts"("guardianId", "schoolId");
CREATE INDEX "AckReceipts_studentId_schoolId_idx" ON "AckReceipts"("studentId", "schoolId");
CREATE INDEX "AckReceipts_schoolId_idx" ON "AckReceipts"("schoolId");

ALTER TABLE "AckReceipts"
    ADD CONSTRAINT "AckReceipts_requestId_schoolId_fkey" FOREIGN KEY ("requestId", "schoolId")
    REFERENCES "AckRequests"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AckReceipts"
    ADD CONSTRAINT "AckReceipts_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AckReceipts"
    ADD CONSTRAINT "AckReceipts_guardianId_schoolId_fkey" FOREIGN KEY ("guardianId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "AckReceipts"
    ADD CONSTRAINT "AckReceipts_studentId_schoolId_fkey" FOREIGN KEY ("studentId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- Triggers: the setting's date, and the request's reminder time.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.ack_settings_stamp() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  NEW."updatedAt" := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER "AckSettings_stamp"
    BEFORE INSERT OR UPDATE ON "AckSettings"
    FOR EACH ROW EXECUTE FUNCTION app.ack_settings_stamp();

-- remindAt is the database's, from the school's setting at the moment the
-- request is written: a writer cannot choose it, and reminderSentAt starts
-- empty. A school without a row has the default (two days). The author is the
-- caller: a request is never written in a colleague's name, whatever authorId
-- the row says (the trigger runs before the policy's check), and authorName is
-- that person's name as Users has it, which a writer cannot choose either. A
-- writer with no login (the owner, a migration) keeps the authorId it gives.
CREATE FUNCTION app.ack_requests_stamp() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  days smallint;
  named text;
BEGIN
  NEW."authorId" := coalesce(app.current_user_id(), NEW."authorId");
  SELECT btrim(u."firstName" || ' ' || u."lastName") INTO named
    FROM "Users" u WHERE u."id" = NEW."authorId" AND u."schoolId" = NEW."schoolId";
  -- An author who is not a person of the request's school leaves the name empty:
  -- the policy refuses a caller of another school first, and the CHECK refuses the rest.
  NEW."authorName" := coalesce(named, '');
  SELECT s."remindAfterDays" INTO days FROM "AckSettings" s WHERE s."schoolId" = NEW."schoolId";
  IF NOT FOUND THEN
    days := 2;
  END IF;
  NEW."remindAt" := CASE WHEN days IS NULL THEN NULL ELSE now() + make_interval(days => days) END;
  NEW."reminderSentAt" := NULL;
  RETURN NEW;
END
$$;

CREATE TRIGGER "AckRequests_stamp"
    BEFORE INSERT ON "AckRequests"
    FOR EACH ROW EXECUTE FUNCTION app.ack_requests_stamp();

-- ---------------------------------------------------------------------------
-- The questions the policies and the gateway ask.
-- ---------------------------------------------------------------------------

-- Whether the caller's school has kvittens on.
CREATE FUNCTION app.ack_enabled() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT coalesce((SELECT s."enabled" FROM "AckSettings" s WHERE s."schoolId" = app.current_school_id()), false)
$$;

-- How many days the school lets a request wait before the one reminder (NULL:
-- none), for a teacher, who does not read the setting's row.
CREATE FUNCTION app.ack_remind_after_days() RETURNS smallint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM "AckSettings" s WHERE s."schoolId" = app.current_school_id())
              THEN (SELECT s."remindAfterDays" FROM "AckSettings" s WHERE s."schoolId" = app.current_school_id())
              ELSE 2::smallint END
$$;

-- The pupils the calling teacher mentors today: the one definition of who
-- mentors whom (Frånvarobevakning's, the leave decision's), read once per
-- statement by the arms below. Empty for anyone but a teacher.
CREATE FUNCTION app.ack_mentee_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT coalesce(array_agg(m.student_id ORDER BY m.student_id), '{}'::uuid[])
    FROM app.absence_watch_mentees(app.current_school_id(), app.school_today()) m
   WHERE app.current_user_role() = 'TEACHER' AND m.mentor_id = app.current_user_id()
$$;

-- Whether the guardian can still be asked about the pupil, which is the one
-- rule of "custody has ended": a link, and both persons still active. The
-- confirmation, the status and the reminder all ask it.
CREATE FUNCTION app.ack_receipt_open(p_guardian uuid, p_student uuid, p_school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT EXISTS (
    SELECT 1
      FROM "GuardianStudents" gs
      JOIN "Users" g ON g."id" = gs."guardianId" AND g."schoolId" = gs."schoolId" AND g."isActive" AND g."role" = 'GUARDIAN'
      JOIN "Users" s ON s."id" = gs."studentId" AND s."schoolId" = gs."schoolId" AND s."isActive" AND s."role" = 'STUDENT'
     WHERE gs."guardianId" = p_guardian AND gs."studentId" = p_student AND gs."schoolId" = p_school)
$$;

-- The same rule in the caller's own school, which is the question the policies of
-- AckReceipts ask (a policy runs with the caller's privileges, and the rule above
-- answers for any school it is given, so it is the owner's alone).
CREATE FUNCTION app.ack_asks_open(p_student uuid, p_guardian uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT app.ack_receipt_open(p_guardian, p_student, app.current_school_id())
$$;

-- The caller wrote the request.
CREATE FUNCTION app.ack_is_author(p_request uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT EXISTS (
    SELECT 1 FROM "AckRequests" q
     WHERE q."id" = p_request AND q."schoolId" = app.current_school_id()
       AND q."authorId" = app.current_user_id())
$$;

-- The request asks about one of these pupils (a teacher's mentees, handed in by
-- the policy as an initplan so the list is built once per statement).
CREATE FUNCTION app.ack_request_concerns(p_request uuid, p_pupils uuid[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT EXISTS (
    SELECT 1 FROM "AckReceipts" r
     WHERE r."requestId" = p_request AND r."schoolId" = app.current_school_id()
       AND r."studentId" = ANY (p_pupils))
$$;

-- The calling guardian has a row in the request for one of these children (their
-- children they are still linked to, handed in by the policy). After the
-- custody has ended the request does not exist for them.
CREATE FUNCTION app.ack_guardian_may_see(p_request uuid, p_children uuid[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT EXISTS (
    SELECT 1 FROM "AckReceipts" r
     WHERE r."requestId" = p_request AND r."schoolId" = app.current_school_id()
       AND r."guardianId" = app.current_user_id()
       AND r."studentId" = ANY (p_children))
$$;

-- ---------------------------------------------------------------------------
-- Who is done: the one definition, per request and pupil.
-- ---------------------------------------------------------------------------

-- asked: guardians asked about the pupil. acked: how many confirmed. waiting:
-- guardians who have not confirmed and still can. met: ANY, someone
-- confirmed; ALL, someone confirmed and nobody who still can is waiting.
-- Not authorised: the owner's, for the reminder pass and for ack_status.
CREATE FUNCTION app.ack_status_raw(p_requests uuid[])
RETURNS TABLE (request_id uuid, student_id uuid, asked integer, acked integer, waiting integer, met boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT r."requestId", r."studentId", count(*)::integer,
         (count(*) FILTER (WHERE r."ackedAt" IS NOT NULL))::integer,
         (count(*) FILTER (WHERE r."ackedAt" IS NULL AND app.ack_receipt_open(r."guardianId", r."studentId", r."schoolId")))::integer,
         CASE q."rule"
           WHEN 'ANY' THEN bool_or(r."ackedAt" IS NOT NULL)
           ELSE bool_or(r."ackedAt" IS NOT NULL)
                AND NOT bool_or(r."ackedAt" IS NULL AND app.ack_receipt_open(r."guardianId", r."studentId", r."schoolId"))
         END
    FROM "AckReceipts" r
    JOIN "AckRequests" q ON q."id" = r."requestId" AND q."schoolId" = r."schoolId"
   WHERE r."requestId" = ANY (p_requests)
   GROUP BY r."requestId", r."studentId", q."rule"
$$;

-- The staff's view of it: the caller's own school, and for a teacher the
-- pupils they may see (their mentees, and all of a request they wrote); an
-- administrator sees the school's. Nobody else gets a row.
CREATE FUNCTION app.ack_status(p_requests uuid[])
RETURNS TABLE (request_id uuid, student_id uuid, asked integer, acked integer, waiting integer, met boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT s.*
    FROM app.ack_status_raw(p_requests) s
    JOIN "AckRequests" q ON q."id" = s.request_id
   WHERE q."schoolId" = app.current_school_id()
     AND (app.current_user_role() = 'SCHOOL_ADMIN'
          OR (app.current_user_role() = 'TEACHER'
              AND (q."authorId" = app.current_user_id() OR s.student_id = ANY ((SELECT app.ack_mentee_ids())::uuid[]))))
$$;

-- The (pupil, guardian) pairs of a request that can still confirm, for the
-- staff's list of who has and who waits; the same visibility as ack_status.
CREATE FUNCTION app.ack_open_pairs(p_request uuid)
RETURNS TABLE (student_id uuid, guardian_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT r."studentId", r."guardianId"
    FROM "AckReceipts" r
    JOIN "AckRequests" q ON q."id" = r."requestId" AND q."schoolId" = r."schoolId"
   WHERE r."requestId" = p_request AND q."schoolId" = app.current_school_id()
     AND (app.current_user_role() = 'SCHOOL_ADMIN'
          OR (app.current_user_role() = 'TEACHER'
              AND (q."authorId" = app.current_user_id() OR r."studentId" = ANY ((SELECT app.ack_mentee_ids())::uuid[]))))
     AND app.ack_receipt_open(r."guardianId", r."studentId", r."schoolId")
$$;

-- ---------------------------------------------------------------------------
-- The confirmation.
-- ---------------------------------------------------------------------------

-- The calling guardian confirms a request for every child of theirs in it who
-- they are still linked to, at one time; answers that time, or the time of the
-- first confirmation when they had already confirmed (a second tap changes
-- nothing). KV403: not a guardian. KV404: no such request for this guardian.
-- KV410: the guardian is no longer linked to any child in it.
CREATE FUNCTION app.ack_confirm(p_request uuid) RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  me uuid := app.current_user_id();
  sch uuid := app.current_school_id();
  stamp timestamptz;
  linked integer;
  result timestamptz;
BEGIN
  IF me IS NULL OR app.current_user_role() IS DISTINCT FROM 'GUARDIAN' THEN
    RAISE EXCEPTION 'ACK_NOT_A_GUARDIAN' USING ERRCODE = 'KV403';
  END IF;
  -- Shared: confirmations do not wait for one another, and the reminder pass
  -- (FOR UPDATE SKIP LOCKED) neither waits for this nor asks someone who is
  -- answering.
  PERFORM 1 FROM "AckRequests" q WHERE q."id" = p_request AND q."schoolId" = sch FOR SHARE;
  IF NOT FOUND OR NOT EXISTS (
       SELECT 1 FROM "AckReceipts" r WHERE r."requestId" = p_request AND r."guardianId" = me AND r."schoolId" = sch) THEN
    RAISE EXCEPTION 'ACK_NOT_FOUND' USING ERRCODE = 'KV404';
  END IF;
  -- The links, key-shared: a link that is being removed finishes first and this
  -- then refuses; a link this has locked is removed after this commits.
  SELECT count(*) INTO linked FROM (
    SELECT 1
      FROM "AckReceipts" r
      JOIN "GuardianStudents" gs ON gs."guardianId" = r."guardianId" AND gs."studentId" = r."studentId" AND gs."schoolId" = r."schoolId"
     WHERE r."requestId" = p_request AND r."guardianId" = me AND r."schoolId" = sch
       AND app.ack_receipt_open(r."guardianId", r."studentId", r."schoolId")
       FOR KEY SHARE OF gs) x;
  IF linked = 0 THEN
    RAISE EXCEPTION 'ACK_CUSTODY_ENDED' USING ERRCODE = 'KV410';
  END IF;
  stamp := clock_timestamp();
  UPDATE "AckReceipts" r SET "ackedAt" = stamp
   WHERE r."requestId" = p_request AND r."guardianId" = me AND r."schoolId" = sch AND r."ackedAt" IS NULL
     AND app.ack_receipt_open(r."guardianId", r."studentId", r."schoolId");
  SELECT min(r."ackedAt") INTO result
    FROM "AckReceipts" r
   WHERE r."requestId" = p_request AND r."guardianId" = me AND r."schoolId" = sch AND r."ackedAt" IS NOT NULL;
  RETURN result;
END
$$;

-- ---------------------------------------------------------------------------
-- The reminder: once, to a guardian who has not confirmed.
-- ---------------------------------------------------------------------------

-- The job's pass over every school. For each request whose time has come and
-- whose pass is not done, and which nobody is confirming just now, claims
-- the receipts that are unconfirmed, not reminded, still possible and about
-- a pupil who is not met, writes one ACK_REMINDER per guardian and hands the
-- notices back with the addresses, for the delivery after the commit. A
-- request more than 30 days past its time is closed without a word. A
-- guardian with two children in a request is reminded once.
CREATE FUNCTION app.ack_remind_due()
RETURNS TABLE (notification_id uuid, user_id uuid, school_id uuid, email text, meta jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  q record;
BEGIN
  FOR q IN
    SELECT a."id", a."schoolId", a."title", a."remindAt"
      FROM "AckRequests" a
     WHERE a."remindAt" IS NOT NULL AND a."remindAt" <= clock_timestamp() AND a."reminderSentAt" IS NULL
     ORDER BY a."remindAt"
     LIMIT 200
       FOR UPDATE SKIP LOCKED
  LOOP
    IF q."remindAt" >= clock_timestamp() - interval '30 days' THEN
      RETURN QUERY
      WITH unmet AS (
        SELECT s.student_id FROM app.ack_status_raw(ARRAY[q."id"]) s WHERE NOT s.met
      ),
      due AS (
        UPDATE "AckReceipts" r SET "remindedAt" = clock_timestamp()
         WHERE r."requestId" = q."id" AND r."ackedAt" IS NULL AND r."remindedAt" IS NULL
           AND r."studentId" IN (SELECT u.student_id FROM unmet u)
           AND app.ack_receipt_open(r."guardianId", r."studentId", r."schoolId")
        RETURNING r."guardianId"
      ),
      who AS (SELECT DISTINCT d."guardianId" FROM due d),
      written AS (
        INSERT INTO "Notifications" AS nt ("schoolId", "userId", "type", "meta")
        SELECT q."schoolId", w."guardianId", 'ACK_REMINDER',
               jsonb_build_object('requestId', q."id", 'title', q."title")
          FROM who w
        RETURNING nt."id", nt."userId", nt."meta"
      )
      SELECT wr."id", wr."userId", q."schoolId", u."email", wr."meta"
        FROM written wr
        JOIN "Users" u ON u."id" = wr."userId" AND u."schoolId" = q."schoolId";
    END IF;
    UPDATE "AckRequests" a SET "reminderSentAt" = clock_timestamp() WHERE a."id" = q."id";
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Row-level security and grants. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "AckSettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AckRequests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AckReceipts" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r text;
  tbl text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    -- Settings: the school's administrators read, Drift writes. A teacher asks
    -- app.ack_enabled() and never reads the row.
    CREATE POLICY "ack_settings_admin_select" ON "AckSettings"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "ack_settings_admin_insert" ON "AckSettings"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true)));
    CREATE POLICY "ack_settings_admin_update" ON "AckSettings"
        FOR UPDATE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true)));

    -- Requests: three readers, one writer, and nobody who changes or removes one.
    CREATE POLICY "ack_requests_admin_select" ON "AckRequests"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "ack_requests_teacher_select" ON "AckRequests"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'TEACHER'
               AND (app.ack_is_author("id") OR app.ack_request_concerns("id", (select app.ack_mentee_ids()))));
    CREATE POLICY "ack_requests_guardian_select" ON "AckRequests"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'GUARDIAN'
               AND app.ack_guardian_may_see("id", (select app.current_guardian_child_ids())));
    -- The author is the caller whatever the row says: AckRequests_stamp sets it.
    CREATE POLICY "ack_requests_staff_insert" ON "AckRequests"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.ack_enabled())
                    AND ((select app.current_user_role()) = 'TEACHER'
                         OR ((select app.current_user_role()) = 'SCHOOL_ADMIN' AND (select app.current_user_may('DRIFT', true)))));

    -- Receipts: the guardian reads only their own rows for children they are
    -- still linked to; staff read what they wrote or what concerns their mentees.
    CREATE POLICY "ack_receipts_admin_select" ON "AckReceipts"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "ack_receipts_teacher_select" ON "AckReceipts"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'TEACHER'
               AND ("studentId" = ANY ((select app.ack_mentee_ids())::uuid[]) OR app.ack_is_author("requestId")));
    CREATE POLICY "ack_receipts_guardian_select" ON "AckReceipts"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'GUARDIAN'
               AND "guardianId" = (select app.current_user_id())
               AND "studentId" = ANY ((select app.current_guardian_child_ids())::uuid[]));
    -- A teacher asks about their mentees, in a request they wrote; an
    -- administrator under Drift about any pupil of the school. Both ask only
    -- guardians the pupil is linked to, and a row starts unconfirmed and unreminded.
    CREATE POLICY "ack_receipts_teacher_insert" ON "AckReceipts"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'TEACHER'
                    AND "ackedAt" IS NULL AND "remindedAt" IS NULL
                    AND app.ack_is_author("requestId")
                    AND app.ack_asks_open("studentId", "guardianId")
                    AND "studentId" = ANY ((select app.ack_mentee_ids())::uuid[]));
    CREATE POLICY "ack_receipts_admin_insert" ON "AckReceipts"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true))
                    AND "ackedAt" IS NULL AND "remindedAt" IS NULL
                    AND app.ack_asks_open("studentId", "guardianId"));

    FOREACH tbl IN ARRAY ARRAY['AckSettings', 'AckRequests', 'AckReceipts'] LOOP
      EXECUTE format('REVOKE ALL ON %I FROM "app_authenticated"', tbl);
    END LOOP;
    GRANT SELECT, INSERT, UPDATE ON "AckSettings" TO "app_authenticated";
    GRANT SELECT, INSERT ON "AckRequests" TO "app_authenticated";
    GRANT SELECT, INSERT ON "AckReceipts" TO "app_authenticated";
  END IF;

  FOREACH tbl IN ARRAY ARRAY['AckSettings', 'AckRequests', 'AckReceipts'] LOOP
    FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', tbl, r);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM "service_role"', tbl);
    END IF;
    -- PostgreSQL 17's MAINTAIN (REINDEX, CLUSTER, VACUUM, LOCK): the owner's alone.
    IF current_setting('server_version_num')::int >= 170000 THEN
      FOREACH r IN ARRAY ARRAY['authenticated', 'app_authenticated', 'service_role', 'anon'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
          EXECUTE format('REVOKE MAINTAIN ON %I FROM %I', tbl, r);
        END IF;
      END LOOP;
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Gallring: a request goes with the school's choice for NOTIFICATIONS. Both
-- bodies are 20270113091000's (prod md5 before: due 1d002a81c954ccda01acc9bf0cabdbb3,
-- purge 21b7b43da05c4ff63f045ee769b1ba5c) plus the one branch marked
-- "kvittens", so none of Krisläge's, Rapporteringsgrads, Frånvarobevakningens,
-- Vikariefrågans or Skyddad identitets is lost. A later release that restates
-- the functions again must carry every branch (RLS section 350 and 374 fail
-- on a branch that is gone).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.gallring_due(p_school uuid, p_type "RetentionDataType", p_before date, p_today date)
RETURNS TABLE (tbl text, id uuid)
LANGUAGE sql STABLE AS $$
  WITH school AS (
    SELECT s."id", (p_before::timestamp AT TIME ZONE s."timezone") AS before_at
      FROM "public"."Schools" s WHERE s."id" = p_school AND p_before IS NOT NULL
  )
  SELECT 'AttendanceRecords', a."id"
    FROM school, "public"."AttendanceRecords" a
    JOIN "public"."CalendarLessons" l ON l."id" = a."calendarLessonId"
   WHERE p_type = 'ATTENDANCE' AND a."schoolId" = school."id" AND l."date" < p_before
  UNION ALL
  -- frånvarobevakning
  SELECT 'AbsenceWatchFindings', w."id"
    FROM school, "public"."AbsenceWatchFindings" w
   WHERE p_type = 'ATTENDANCE' AND w."schoolId" = school."id" AND w."lastSeenOn" < p_before
  UNION ALL
  -- rapporteringsgrad
  SELECT 'TeacherReportingDays', d."id"
    FROM school, "public"."TeacherReportingDays" d
   WHERE p_type = 'ATTENDANCE' AND d."schoolId" = school."id" AND d."day" < p_before
  UNION ALL
  SELECT 'ReportingReminders', r."id"
    FROM school, "public"."ReportingReminders" r
   WHERE p_type = 'ATTENDANCE' AND r."schoolId" = school."id" AND r."lessonDate" < p_before
  UNION ALL
  SELECT 'AbsenceReports', r."id"
    FROM school, "public"."AbsenceReports" r
   WHERE p_type = 'ABSENCE_REPORTS' AND r."schoolId" = school."id" AND r."date" < p_before
  UNION ALL
  SELECT 'LeaveRequests', r."id"
    FROM school, "public"."LeaveRequests" r
   WHERE p_type = 'LEAVE_REQUESTS' AND r."schoolId" = school."id" AND r."endDate" < p_before
  UNION ALL
  SELECT 'Notifications', n."id"
    FROM school, "public"."Notifications" n
   WHERE p_type = 'NOTIFICATIONS' AND n."schoolId" = school."id" AND n."createdAt" < school.before_at
  UNION ALL
  -- kvittens
  SELECT 'AckRequests', k."id"
    FROM school, "public"."AckRequests" k
   WHERE p_type = 'NOTIFICATIONS' AND k."schoolId" = school."id" AND k."createdAt" < school.before_at
  UNION ALL
  SELECT 'ScheduleChangeLogs', c."id"
    FROM school, "public"."ScheduleChangeLogs" c
   WHERE p_type = 'CHANGE_LOGS' AND c."schoolId" = school."id" AND c."createdAt" < school.before_at
  UNION ALL
  SELECT 'TeacherEmploymentLogs', g."id"
    FROM school, "public"."TeacherEmploymentLogs" g
    JOIN "public"."AcademicYears" y ON y."id" = g."academicYearId" AND y."schoolId" = g."schoolId"
   WHERE p_type = 'CHANGE_LOGS' AND g."schoolId" = school."id" AND y."endDate" < p_before
  UNION ALL
  SELECT 'GuardianStudentHistory', h."id"
    FROM school, "public"."GuardianStudentHistory" h
   WHERE p_type = 'CHANGE_LOGS' AND h."schoolId" = school."id" AND h."unlinkedAt" < school.before_at
  UNION ALL
  -- skyddad identitet
  SELECT 'PersonProtectionEvents', e."id"
    FROM school, "public"."PersonProtectionEvents" e
   WHERE p_type = 'CHANGE_LOGS' AND e."schoolId" = school."id" AND e."at" < school.before_at
  UNION ALL
  SELECT 'TeacherAbsences', t."id"
    FROM school, "public"."TeacherAbsences" t
   WHERE p_type = 'ABSENCE_REASONS' AND t."schoolId" = school."id" AND t."reasonId" IS NOT NULL
     AND t."endsAt" < school.before_at
  UNION ALL
  -- läslogg
  SELECT 'PersonalDataAccess', p."id"
    FROM school, "public"."PersonalDataAccess" p
   WHERE p_type = 'ACCESS_LOG' AND p."schoolId" = school."id" AND p."at" < school.before_at
  UNION ALL
  -- vikarieförfrågningar
  SELECT 'CoverRequests', q."id"
    FROM school, "public"."CoverRequests" q
   WHERE p_type = 'COVER_REQUESTS' AND q."schoolId" = school."id"
     AND ((q."status" <> 'OPEN' AND q."closedAt" < school.before_at)
          OR (q."status" = 'OPEN' AND q."expiresAt" < school.before_at))
  UNION ALL
  SELECT 'CoverConfirmations', c."id"
    FROM school, "public"."CoverConfirmations" c
   WHERE p_type = 'COVER_REQUESTS' AND c."schoolId" = school."id" AND c."confirmedAt" < school.before_at
  UNION ALL
  -- krisläge
  SELECT 'CrisisAlarms', k."id"
    FROM school, "public"."CrisisAlarms" k
   WHERE k."schoolId" = school."id" AND k."endedAt" < school.before_at
     AND ((p_type = 'CRISIS_DRILLS' AND k."mode" = 'DRILL')
          OR (p_type = 'CRISIS_ALARMS' AND k."mode" = 'LIVE'))
  UNION ALL
  SELECT 'Users', u."id"
    FROM school, "public"."Users" u
   WHERE p_type = 'DEPARTED_PEOPLE' AND u."schoolId" = school."id"
     AND NOT u."isActive" AND u."pseudonymisedAt" IS NULL
     AND u."deactivatedAt" < school.before_at
     AND NOT app.gallring_held_for_scb(u."id", u."schoolId", p_today);
$$;

CREATE OR REPLACE FUNCTION app.gallring_purge(p_run uuid, p_type "RetentionDataType", p_limit integer) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  r "GallringRuns";
  cutoff date;
  today date;
  budget integer := greatest(least(p_limit, 5000), 1);
  n integer := 0;
  step integer;
BEGIN
  IF p_type = 'DEPARTED_PEOPLE' THEN
    RAISE EXCEPTION 'GALLRING_PEOPLE_ARE_PSEUDONYMISED' USING ERRCODE = 'GL400';
  END IF;
  -- FOR UPDATE: one call of a run at a time.
  SELECT * INTO r FROM "GallringRuns" WHERE "id" = p_run AND "status" = 'RUNNING' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GALLRING_RUN_NOT_RUNNING' USING ERRCODE = 'GL404';
  END IF;
  -- Both NULL when nothing of the kind may go: least() of a NULL is the other.
  IF r."cutoffs" ->> p_type::text IS NULL
     OR app.retention_months_in_force(r."schoolId", p_type, clock_timestamp()) IS NULL THEN
    RETURN 0;
  END IF;
  cutoff := app.gallring_run_cutoff(r."schoolId", r."startedAt", r."cutoffs", p_type);
  today := app.gallring_today(r."schoolId", r."startedAt");

  PERFORM set_config('app.gallring', r."schoolId"::text, true);
  CASE p_type
    WHEN 'ATTENDANCE' THEN
      DELETE FROM "AttendanceRecords" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'AttendanceRecords' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
      -- frånvarobevakning
      IF n < budget THEN
        DELETE FROM "AbsenceWatchFindings" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'AbsenceWatchFindings' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
      -- rapporteringsgrad
      IF n < budget THEN
        DELETE FROM "TeacherReportingDays" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'TeacherReportingDays' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
      IF n < budget THEN
        DELETE FROM "ReportingReminders" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'ReportingReminders' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
    WHEN 'ABSENCE_REPORTS' THEN
      DELETE FROM "AbsenceReports" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'AbsenceReports' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
    WHEN 'LEAVE_REQUESTS' THEN
      DELETE FROM "LeaveRequests" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'LeaveRequests' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
    WHEN 'NOTIFICATIONS' THEN
      DELETE FROM "Notifications" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'Notifications' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
      -- kvittens: a request goes with the rows under it, by their key
      IF n < budget THEN
        DELETE FROM "AckRequests" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'AckRequests' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
    WHEN 'CHANGE_LOGS' THEN
      DELETE FROM "ScheduleChangeLogs" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'ScheduleChangeLogs' LIMIT budget);
      GET DIAGNOSTICS step = ROW_COUNT;
      n := step;
      IF n < budget THEN
        DELETE FROM "TeacherEmploymentLogs" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'TeacherEmploymentLogs' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
      IF n < budget THEN
        DELETE FROM "GuardianStudentHistory" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'GuardianStudentHistory' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
      -- skyddad identitet
      IF n < budget THEN
        DELETE FROM "PersonProtectionEvents" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'PersonProtectionEvents' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
    WHEN 'ABSENCE_REASONS' THEN
      UPDATE "TeacherAbsences" SET "reasonId" = NULL WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'TeacherAbsences' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
    -- läslogg
    WHEN 'ACCESS_LOG' THEN
      DELETE FROM "PersonalDataAccess" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'PersonalDataAccess' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
    -- vikarieförfrågningar
    WHEN 'COVER_REQUESTS' THEN
      DELETE FROM "CoverRequests" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'CoverRequests' LIMIT budget);
      GET DIAGNOSTICS step = ROW_COUNT;
      n := step;
      IF n < budget THEN
        DELETE FROM "CoverConfirmations" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'CoverConfirmations' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
    -- krisläge
    WHEN 'CRISIS_DRILLS', 'CRISIS_ALARMS' THEN
      DELETE FROM "CrisisAlarms" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'CrisisAlarms' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
  END CASE;
  PERFORM set_config('app.gallring', '', true);

  UPDATE "GallringRuns" SET
    "counts"   = "counts" || jsonb_build_object(p_type::text, COALESCE(("counts" ->> p_type::text)::bigint, 0) + n),
    "complete" = "complete" || jsonb_build_object(p_type::text, n < budget),
    "cutoffs"  = "cutoffs" || jsonb_build_object(p_type::text, cutoff::text)
   WHERE "id" = p_run;
  RETURN n;
END
$$;

-- ---------------------------------------------------------------------------
-- Function grants: the gateway's role alone, and not through PostgREST.
-- ---------------------------------------------------------------------------

COMMENT ON FUNCTION app.ack_enabled() IS
  'Kvittens: whether the caller''s school has it on.';
COMMENT ON FUNCTION app.ack_remind_after_days() IS
  'Kvittens: the days a request waits before its one reminder (NULL: none), for a teacher, who does not read the setting.';
COMMENT ON FUNCTION app.ack_mentee_ids() IS
  'Kvittens: the pupils the calling teacher mentors today (the leave decision''s definition of a mentor), empty for anyone else.';
COMMENT ON FUNCTION app.ack_receipt_open(uuid, uuid, uuid) IS
  'Kvittens: whether the guardian can still be asked about the pupil: linked, and both active. The one rule of "custody has ended".';
COMMENT ON FUNCTION app.ack_asks_open(uuid, uuid) IS
  'Kvittens: ack_receipt_open in the caller''s own school, for the policies of AckReceipts.';
COMMENT ON FUNCTION app.ack_status_raw(uuid[]) IS
  'Kvittens: per request and pupil, how many guardians were asked, how many confirmed, how many still wait, and whether the pupil is met (ANY: someone confirmed; ALL: someone confirmed and nobody who still can is waiting). Not authorised: the owner''s.';
COMMENT ON FUNCTION app.ack_status(uuid[]) IS
  'Kvittens: ack_status_raw for the caller''s school, limited to the pupils a teacher may see.';
COMMENT ON FUNCTION app.ack_open_pairs(uuid) IS
  'Kvittens: the (pupil, guardian) pairs of a request that can still confirm, for the staff''s list; the visibility of ack_status.';
COMMENT ON FUNCTION app.ack_confirm(uuid) IS
  'Kvittens: the calling guardian confirms a request for the children of theirs in it they are still linked to; idempotent; KV403 not a guardian, KV404 no such request for them, KV410 custody ended.';
COMMENT ON FUNCTION app.ack_remind_due() IS
  'Kvittens: the job''s pass; claims and writes one ACK_REMINDER per unconfirmed guardian of a request whose time has come, and answers the notices with the addresses for the delivery after the commit.';

DO $$
DECLARE
  fn text;
  r text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'app.ack_settings_stamp()',
    'app.ack_requests_stamp()',
    'app.ack_enabled()',
    'app.ack_remind_after_days()',
    'app.ack_mentee_ids()',
    'app.ack_receipt_open(uuid, uuid, uuid)',
    'app.ack_asks_open(uuid, uuid)',
    'app.ack_is_author(uuid)',
    'app.ack_request_concerns(uuid, uuid[])',
    'app.ack_guardian_may_see(uuid, uuid[])',
    'app.ack_status_raw(uuid[])',
    'app.ack_status(uuid[])',
    'app.ack_open_pairs(uuid)',
    'app.ack_confirm(uuid)',
    'app.ack_remind_due()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', fn, r);
      END IF;
    END LOOP;
  END LOOP;
  -- The API role runs the policies' questions, the staff's status, the
  -- guardian's confirmation and the job's pass. The trigger functions, the
  -- guardian-open rule and the raw status are the owner's: a trigger needs no
  -- grant, and the others are called by the functions above as the owner (the
  -- raw status answers any school it is given).
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    FOREACH fn IN ARRAY ARRAY[
      'app.ack_enabled()',
      'app.ack_remind_after_days()',
      'app.ack_mentee_ids()',
      'app.ack_asks_open(uuid, uuid)',
      'app.ack_is_author(uuid)',
      'app.ack_request_concerns(uuid, uuid[])',
      'app.ack_guardian_may_see(uuid, uuid[])',
      'app.ack_status(uuid[])',
      'app.ack_open_pairs(uuid)',
      'app.ack_confirm(uuid)',
      'app.ack_remind_due()'
    ] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO "app_authenticated"', fn);
    END LOOP;
  END IF;
END
$$;
