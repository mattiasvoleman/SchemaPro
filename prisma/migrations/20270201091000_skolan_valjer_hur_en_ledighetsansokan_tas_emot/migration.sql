-- Skolan väljer hur en ledighetsansökan tas emot.
--
-- Skola24 Ledighetsansökan låter skolan ställa tre krav på en ansökan från
-- vårdnadshavare, och Rastra har hittills haft ingen av dem. Det här är de tre,
-- som skolan väljer var för sig. Alla tre är avstängda tills en administratör som
-- beslutar slår på dem: en skola utan rad i LeavePolicies, eller med rad där inget
-- är valt, ser exakt det flöde som fanns före den här migreringen.
--
--   1. Varje vårdnadshavares samtycke (requireAllGuardians). Ansökan går till
--      beslut först när alla vårdnadshavare som har aktiv vårdnad samtyckt. De
--      andra vårdnadshavarna får en notis (LEAVE_CONSENT_REQUESTED) och en enda
--      påminnelse (LEAVE_CONSENT_REMINDER), och samtycker i appen eller på
--      webben. Ett nej avslutar ansökan (status GUARDIAN_DECLINED) och den som
--      ansökte får ett besked (LEAVE_CONSENT_REFUSED) som inte säger vem.
--   2. Minsta antal dagar i förväg (minDaysAhead, shortNotice). En ansökan
--      vars första dag ligger närmare än så nekas av formuläret (REFUSE), eller
--      släpps in och flaggas för den som beslutar (FLAG).
--   3. En tillfällig kontakt under ledigheten (contact: OFF, OPTIONAL,
--      REQUIRED): namn, telefon och relation, en tredje parts personuppgifter.
--
-- ## Skolans val, kopierat till ansökan
--
-- LeavePolicies har en rad per skola. Ansökan bär det den möttes av när den
-- skrevs: consentRequired (skolan bad om alla vårdnadshavares samtycke) och
-- shortNotice (den kom närmare än minimum), båda satta av triggern
-- LeaveRequests_policy och inget en skrivare kan välja. Ett senare byte av skolans val
-- flyttar därför ingen ansökan som redan är inne, som Kvittens påminnelsetid.
-- Skolans val läses av alla i skolan genom app.leave_policy() (formuläret
-- behöver dem) och skrivs av administratörer som beslutar.
--
-- ## Vem som frågas, och när samtycket är klart
--
-- LeaveConsents är ögonblicksbilden av vilka vårdnadshavare som skulle frågas
-- när ansökan skrevs: de som hade aktiv vårdnad om eleven då, utom den som
-- ansökte (att ansöka är att samtycka). En administratör som ansöker åt en
-- familj, eller en elev som ansöker själv, frågar alla vårdnadshavare. En
-- vårdnadshavare som kopplas till eleven senare frågas inte.
--
-- "Aktiv vårdnad" är Kvittens regel och ingen ny: app.ack_receipt_open, en
-- koppling och båda personerna aktiva. En vårdnadshavare vars vårdnad upphört håller
-- inte upp ansökan (och kan inte svara, LV410), men ett samtycke hen gav innan står
-- kvar. Samtycket är klart när ingen som fortfarande kan svara väntar och ingen
-- sagt nej (app.leave_consent_met_raw, den enda definitionen). Klart lagras inte:
-- en vårdnadshavare vars vårdnad upphör släpper ansökan i samma ögonblick, utan
-- att något jobb behöver hinna före, och två samtidiga svar har inget
-- sammanräknat tillstånd att skriva fel. Det enda som lagras är svaret, och ett nej
-- som ansökans slutläge (GUARDIAN_DECLINED), skrivet i samma transaktion som nejet.
--
-- Svaret är slutgiltigt och skrivs av app.leave_consent_answer och av
-- ingenting annat: ingen roll har någon rättighet på LeaveConsents, och ingen
-- policy. En vårdnadshavare ser därför aldrig vad en annan svarat, och personalen
-- ser ett antal (hur många som frågats, samtyckt och väntar), aldrig vem. Notisen
-- till den andra vårdnadshavaren och beskedet om ett nej nämner inte vem som
-- ansökte respektive sa nej: särlevande vårdnadshavare kan dölja sig för varandra.
--
-- ## Vad som hålls tillbaka tills samtycket är klart
--
--   * Beslutet. Triggern LeaveRequests_gate vägrar (LV412) att en ansökan med
--     consentRequired går från PENDING till APPROVED eller REJECTED innan samtycket
--     är klart, på varje väg: administratörens, mentorns och en rad som någon
--     försöker skriva direkt. Den vägrar också att något utom svaret gör en
--     ansökan GUARDIAN_DECLINED, och att en sådan ansökan lämnar det läget.
--   * Mentorn. Armarna leave_requests_mentor_select och _update, app.leave_request_refer,
--     app.leave_tell_mentors och app.leave_request_facts släpper bara fram en
--     ansökan vars samtycke är klart. Mentorn får inte LEAVE_REQUESTED förrän då: den
--     som lämnar sista samtycket, och jobbet app.leave_consent_pass för en
--     vårdnad som upphört, skriver den. Administratören ser en ansökan som väntar
--     men kan inte besluta den.
--
-- ## Den tillfälliga kontakten
--
-- Tre kolumner på LeaveRequests: contactName, contactPhone, contactRelation, alla tre
-- eller ingen. De läses av den som läser raden och av ingen annan: familjen som
-- skrev dem, administratören och mentorn som beslutar. Ingen annan lärare läser
-- någon ansökan (20261015090000), så kontakten syns inte för dem. Raden gallras
-- som ansökan (LEAVE_REQUESTS, md5 för gallringens funktioner är orörda), ingår i
-- skolans export (data/ledigheter.csv) och i registerutdraget, och räknas med
-- ansökan i borttagningsinventariet. Är kontakten avstängd nollar triggern den: en
-- skola ber inte om en tredje parts uppgifter den inte valt att ha.
--
-- ## Vägrade ansökningar och vilka som slipper
--
-- Minimum och kontaktkravet gäller vårdnadshavare och elever, de som formuläret
-- vänder sig till. En administratör får fortfarande skriva en ansökan åt en familj
-- som ringt; den flaggas om den kommer för sent. Triggern är nätet för varje väg
-- till tabellen (PostgREST med den inloggades egen session, den förra appversionen),
-- och app.leave_filing_check är gatewayns förfrågan före skrivningen, så att
-- formuläret kan svara med en kod på familjens språk. Båda frågar samma
-- funktion (app.leave_filing_refusal). Minimum räknas i kalenderdagar från skolans
-- dag (skolans tidszon) till ansökans första dag.
--
-- ## Påminnelsen och jobbet
--
-- Efter två dygn påminns en vårdnadshavare som inte svarat, en gång, så länge ansökan
-- väntar och ledigheten inte tagit slut (LeaveConsents.remindedAt). Samma pass av
-- jobbet (app.leave_consent_pass) skriver LEAVE_REQUESTED till mentorerna för en
-- ansökan som blivit klar av att en vårdnad upphörde. Funktionen är jobbets, inte
-- en inloggads: kallas den av en inloggning svarar den med ingenting.
--
-- ## Vid sidan av det API som körs
--
-- Migreringen körs medan API:et före den betjänar förfrågningar. Tre nya
-- kolumner på LeaveRequests har förvalen false/NULL och är metadata-snabba; det
-- gamla API:et skriver dem inte och läser dem inte (det väljer sina kolumner),
-- och en ansökan det skriver får förvalen, alltså inget krav. De nya nycklarna
-- tar Schools, Users och LeaveRequests, så låsen tas tillsammans, NOWAIT, i en
-- loop: en vägran rullar tillbaka delbehandlingen och försöker igen 50 ms
-- senare, och den väntar aldrig med ett lås i handen. Efter 30 s stannar den med
-- ingenting gjort och kan köras om (prisma migrate resolve --rolled-back, sedan
-- deploy). Den nya statusen och notistyperna kom i 20270201090000.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Schools" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Users" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "LeaveRequests" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Schools, Users and LeaveRequests were not free at once in 30 s: nothing is changed. Prisma now holds this migration as failed, so run "prisma migrate resolve --rolled-back 20270201091000_skolan_valjer_hur_en_ledighetsansokan_tas_emot" and then "prisma migrate deploy" again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

CREATE TYPE "LeaveShortNotice" AS ENUM ('REFUSE', 'FLAG');
CREATE TYPE "LeaveContactMode" AS ENUM ('OFF', 'OPTIONAL', 'REQUIRED');

-- ---------------------------------------------------------------------------
-- LeavePolicies
-- ---------------------------------------------------------------------------

CREATE TABLE "LeavePolicies" (
    "schoolId" UUID NOT NULL,
    "requireAllGuardians" BOOLEAN NOT NULL DEFAULT false,
    -- Fewest calendar days from the filing day to the first day of leave; NULL: no minimum.
    "minDaysAhead" SMALLINT,
    "shortNotice" "LeaveShortNotice" NOT NULL DEFAULT 'REFUSE',
    "contact" "LeaveContactMode" NOT NULL DEFAULT 'OFF',
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeavePolicies_pkey" PRIMARY KEY ("schoolId"),
    CONSTRAINT "LeavePolicies_the_minimum_is_one_to_ninety_days" CHECK ("minDaysAhead" IS NULL OR "minDaysAhead" BETWEEN 1 AND 90)
);

ALTER TABLE "LeavePolicies"
    ADD CONSTRAINT "LeavePolicies_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE FUNCTION app.leave_policies_stamp() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  NEW."updatedAt" := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER "LeavePolicies_stamp"
    BEFORE INSERT OR UPDATE ON "LeavePolicies"
    FOR EACH ROW EXECUTE FUNCTION app.leave_policies_stamp();

-- ---------------------------------------------------------------------------
-- LeaveRequests: what the school's policy stamped, and the contact
-- ---------------------------------------------------------------------------

ALTER TABLE "LeaveRequests"
    ADD COLUMN "consentRequired" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "shortNotice" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "contactName" TEXT,
    ADD COLUMN "contactPhone" TEXT,
    ADD COLUMN "contactRelation" TEXT;

-- All three of the contact or none; each of a sane length. Added NOT VALID and
-- then validated: the columns are new, so no row can be outside them, and the
-- validation only reads.
ALTER TABLE "LeaveRequests"
    ADD CONSTRAINT "LeaveRequests_a_contact_is_whole" CHECK (
        ("contactName" IS NULL) = ("contactPhone" IS NULL) AND ("contactName" IS NULL) = ("contactRelation" IS NULL)
    ) NOT VALID,
    ADD CONSTRAINT "LeaveRequests_a_contact_is_short" CHECK (
        "contactName" IS NULL OR (
            char_length(btrim("contactName")) BETWEEN 1 AND 100
            AND char_length(btrim("contactPhone")) BETWEEN 5 AND 30
            AND char_length(btrim("contactRelation")) BETWEEN 1 AND 60
        )
    ) NOT VALID,
    ADD CONSTRAINT "LeaveRequests_a_stopped_request_has_no_decider" CHECK (
        "status" <> 'GUARDIAN_DECLINED' OR ("consentRequired" AND "decidedById" IS NULL AND "decidedAs" IS NULL AND "referredAt" IS NULL)
    ) NOT VALID;
ALTER TABLE "LeaveRequests" VALIDATE CONSTRAINT "LeaveRequests_a_contact_is_whole";
ALTER TABLE "LeaveRequests" VALIDATE CONSTRAINT "LeaveRequests_a_contact_is_short";
ALTER TABLE "LeaveRequests" VALIDATE CONSTRAINT "LeaveRequests_a_stopped_request_has_no_decider";

-- The pass asks for the school's pending requests that wait for consent.
CREATE INDEX "LeaveRequests_consent_pending_idx" ON "LeaveRequests"("schoolId")
    WHERE "consentRequired" AND "status" = 'PENDING';

-- ---------------------------------------------------------------------------
-- LeaveConsents
-- ---------------------------------------------------------------------------

CREATE TABLE "LeaveConsents" (
    "leaveRequestId" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "guardianId" UUID NOT NULL,
    -- NULL until the guardian answers; the answer is final.
    "consented" BOOLEAN,
    "answeredAt" TIMESTAMPTZ(6),
    "remindedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaveConsents_pkey" PRIMARY KEY ("leaveRequestId", "schoolId", "guardianId"),
    CONSTRAINT "LeaveConsents_an_answer_has_a_time" CHECK (("consented" IS NULL) = ("answeredAt" IS NULL))
);

CREATE INDEX "LeaveConsents_guardianId_schoolId_idx" ON "LeaveConsents"("guardianId", "schoolId");
CREATE INDEX "LeaveConsents_schoolId_createdAt_idx" ON "LeaveConsents"("schoolId", "createdAt");
-- The pass asks for the guardians who have not answered and have not been reminded.
CREATE INDEX "LeaveConsents_to_remind_idx" ON "LeaveConsents"("createdAt") WHERE "consented" IS NULL AND "remindedAt" IS NULL;

ALTER TABLE "LeaveConsents"
    ADD CONSTRAINT "LeaveConsents_leaveRequestId_schoolId_fkey" FOREIGN KEY ("leaveRequestId", "schoolId")
    REFERENCES "LeaveRequests"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "LeaveConsents"
    ADD CONSTRAINT "LeaveConsents_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeaveConsents"
    ADD CONSTRAINT "LeaveConsents_guardianId_schoolId_fkey" FOREIGN KEY ("guardianId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- The rules, in internal functions (the owner's; no API role calls them)
-- ---------------------------------------------------------------------------

-- The school's policy; a school with no row has all three off. Always one row.
CREATE FUNCTION app.leave_policy_of(p_school uuid)
RETURNS TABLE ("requireAllGuardians" boolean, "minDaysAhead" integer, "shortNotice" "LeaveShortNotice", "contact" "LeaveContactMode")
LANGUAGE sql STABLE AS $$
  SELECT coalesce(p."requireAllGuardians", false), p."minDaysAhead"::integer,
         coalesce(p."shortNotice", 'REFUSE'::"public"."LeaveShortNotice"),
         coalesce(p."contact", 'OFF'::"public"."LeaveContactMode")
    FROM (SELECT 1) one
    LEFT JOIN "public"."LeavePolicies" p ON p."schoolId" = p_school
$$;

-- The school's day today, in its own time zone.
CREATE FUNCTION app.leave_today(p_school uuid) RETURNS date
LANGUAGE sql STABLE AS $$
  SELECT (now() AT TIME ZONE s."timezone")::date FROM "public"."Schools" s WHERE s."id" = p_school
$$;

-- Whether a filing meets the school's policy: no row if it does, otherwise the code of
-- the first thing it breaks (and the minimum, for the first). The rules apply to a
-- guardian and a pupil, whom the form is for; an administrator filing for a family is
-- let through, and flagged by the trigger if the request is late. A contact given in
-- part is refused whoever files it.
CREATE FUNCTION app.leave_filing_refusal(p_school uuid, p_role text, p_start date, p_name text, p_phone text, p_relation text)
RETURNS TABLE ("code" text, "days" integer)
LANGUAGE sql STABLE AS $$
  WITH pol AS (SELECT * FROM app.leave_policy_of(p_school)),
  given AS (
    SELECT (nullif(btrim(p_name), '') IS NOT NULL)::integer
         + (nullif(btrim(p_phone), '') IS NOT NULL)::integer
         + (nullif(btrim(p_relation), '') IS NOT NULL)::integer AS n
  )
  SELECT v."code", v."days"
    FROM (
      SELECT 1 AS ord, 'LEAVE_REQUEST_TOO_LATE'::text AS "code", pol."minDaysAhead" AS "days"
        FROM pol
       WHERE p_role IN ('GUARDIAN', 'STUDENT') AND pol."minDaysAhead" IS NOT NULL AND pol."shortNotice" = 'REFUSE'
         AND p_start - app.leave_today(p_school) < pol."minDaysAhead"
      UNION ALL
      SELECT 2, 'LEAVE_CONTACT_INCOMPLETE', NULL::integer FROM pol, given WHERE pol."contact" <> 'OFF' AND given.n IN (1, 2)
      UNION ALL
      SELECT 3, 'LEAVE_CONTACT_REQUIRED', NULL::integer
        FROM pol, given WHERE pol."contact" = 'REQUIRED' AND p_role IN ('GUARDIAN', 'STUDENT') AND given.n = 0
    ) v
   ORDER BY v.ord
   LIMIT 1
$$;

-- Whether a request has its consent: nobody who can still answer is waiting and nobody
-- said no. The one definition; "can still answer" is app.ack_receipt_open, the rule of
-- Kvittens. A request the school asked nobody about has it. Answers for any school it is
-- given, so it is the owner's; the callers below and the arms ask with the caller's own.
CREATE FUNCTION app.leave_consent_met_raw(p_request uuid, p_school uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (
    SELECT 1
      FROM "public"."LeaveConsents" c
      JOIN "public"."LeaveRequests" r ON r."id" = c."leaveRequestId" AND r."schoolId" = c."schoolId"
     WHERE c."leaveRequestId" = p_request AND c."schoolId" = p_school
       AND (c."consented" IS FALSE
            OR (c."consented" IS NULL AND app.ack_receipt_open(c."guardianId", r."studentId", c."schoolId")))
  )
$$;

REVOKE ALL ON FUNCTION app.leave_policy_of(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.leave_today(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.leave_filing_refusal(uuid, text, date, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.leave_consent_met_raw(uuid, uuid) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- The triggers
-- ---------------------------------------------------------------------------

-- BEFORE INSERT: the policy the request meets, copied onto it, and the refusals. A
-- writer with no login (the owner, a migration) keeps what it gives. The values are the
-- database's whatever the row says; the trigger runs before the policy's check, which
-- looks at none of these columns.
CREATE FUNCTION app.leave_requests_policy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  pol record;
  refusal record;
BEGIN
  IF app.current_user_id() IS NULL THEN
    RETURN NEW;
  END IF;
  NEW."contactName" := nullif(btrim(NEW."contactName"), '');
  NEW."contactPhone" := nullif(btrim(NEW."contactPhone"), '');
  NEW."contactRelation" := nullif(btrim(NEW."contactRelation"), '');
  SELECT * INTO pol FROM app.leave_policy_of(NEW."schoolId");
  IF pol."contact" = 'OFF' THEN
    NEW."contactName" := NULL;
    NEW."contactPhone" := NULL;
    NEW."contactRelation" := NULL;
  END IF;
  SELECT * INTO refusal
    FROM app.leave_filing_refusal(NEW."schoolId", app.current_user_role()::text, NEW."startDate", NEW."contactName", NEW."contactPhone", NEW."contactRelation");
  IF FOUND THEN
    IF refusal."code" = 'LEAVE_REQUEST_TOO_LATE' THEN
      RAISE EXCEPTION 'LEAVE_REQUEST_TOO_LATE' USING ERRCODE = 'LV413', DETAIL = format('days=%s', refusal."days");
    ELSIF refusal."code" = 'LEAVE_CONTACT_REQUIRED' THEN
      RAISE EXCEPTION 'LEAVE_CONTACT_REQUIRED' USING ERRCODE = 'LV414';
    ELSE
      RAISE EXCEPTION 'LEAVE_CONTACT_INCOMPLETE' USING ERRCODE = 'LV415';
    END IF;
  END IF;
  NEW."consentRequired" := pol."requireAllGuardians";
  NEW."shortNotice" := pol."minDaysAhead" IS NOT NULL AND NEW."startDate" - app.leave_today(NEW."schoolId") < pol."minDaysAhead";
  RETURN NEW;
END
$$;

CREATE TRIGGER "LeaveRequests_policy"
    BEFORE INSERT ON "LeaveRequests"
    FOR EACH ROW EXECUTE FUNCTION app.leave_requests_policy();

-- AFTER INSERT: the guardians the school asks, and the notice each gets. Fires before
-- LeaveRequests_tell_mentors (triggers run in name order), so the rows are there when the
-- mentors are told, and a request with nobody to ask is told at once. The notice names the
-- child and the dates; the reason stays in the application, and nothing says who applied.
CREATE FUNCTION app.leave_requests_ask_guardians() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF NOT NEW."consentRequired" THEN
    RETURN NULL;
  END IF;
  INSERT INTO "LeaveConsents" ("leaveRequestId", "schoolId", "guardianId")
  SELECT NEW."id", NEW."schoolId", gs."guardianId"
    FROM "GuardianStudents" gs
   WHERE gs."studentId" = NEW."studentId" AND gs."schoolId" = NEW."schoolId"
     AND gs."guardianId" <> NEW."requestedById"
     AND app.ack_receipt_open(gs."guardianId", gs."studentId", gs."schoolId");
  INSERT INTO "Notifications" ("schoolId", "userId", "type", "meta")
  SELECT NEW."schoolId", c."guardianId", 'LEAVE_CONSENT_REQUESTED',
         jsonb_build_object(
           'leaveRequestId', NEW."id",
           'studentName', s."firstName" || ' ' || s."lastName",
           'startDate', NEW."startDate"::text,
           'endDate', NEW."endDate"::text)
    FROM "LeaveConsents" c
    JOIN "Users" s ON s."id" = NEW."studentId" AND s."schoolId" = NEW."schoolId"
   WHERE c."leaveRequestId" = NEW."id" AND c."schoolId" = NEW."schoolId";
  RETURN NULL;
END
$$;

CREATE TRIGGER "LeaveRequests_ask_guardians"
    AFTER INSERT ON "LeaveRequests"
    FOR EACH ROW EXECUTE FUNCTION app.leave_requests_ask_guardians();

-- BEFORE UPDATE: what the consent holds back, and what a request keeps once filed.
--   * A stopped request (GUARDIAN_DECLINED) stays stopped, and only a guardian's no
--     stops one: the status needs a refusal in LeaveConsents.
--   * A request that needs consent is not decided (APPROVED, REJECTED) before it has it.
--   * The consent requirement, the notice flag and the contact are as filed.
CREATE FUNCTION app.leave_requests_gate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF NEW."consentRequired" IS DISTINCT FROM OLD."consentRequired"
     OR NEW."shortNotice" IS DISTINCT FROM OLD."shortNotice"
     OR NEW."contactName" IS DISTINCT FROM OLD."contactName"
     OR NEW."contactPhone" IS DISTINCT FROM OLD."contactPhone"
     OR NEW."contactRelation" IS DISTINCT FROM OLD."contactRelation" THEN
    RAISE EXCEPTION 'LEAVE_REQUEST_IS_FIXED: en ansökans samtyckeskrav, flagga och kontakt ändras inte'
      USING ERRCODE = 'LV409';
  END IF;
  IF OLD."status" = 'GUARDIAN_DECLINED' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'LEAVE_REQUEST_STOPPED: en ansökan som en vårdnadshavare nekat samtycke till beslutas inte'
      USING ERRCODE = 'LV409';
  END IF;
  IF NEW."status" = 'GUARDIAN_DECLINED' AND OLD."status" IS DISTINCT FROM NEW."status" THEN
    IF OLD."status" <> 'PENDING' OR NOT OLD."consentRequired" OR NOT EXISTS (
         SELECT 1 FROM "LeaveConsents" c
          WHERE c."leaveRequestId" = OLD."id" AND c."schoolId" = OLD."schoolId" AND c."consented" IS FALSE) THEN
      RAISE EXCEPTION 'LEAVE_DECLINE_IS_A_GUARDIANS: bara en vårdnadshavares nej stoppar en ansökan'
        USING ERRCODE = 'LV416';
    END IF;
  END IF;
  IF OLD."status" = 'PENDING' AND NEW."status" IN ('APPROVED', 'REJECTED') AND OLD."consentRequired"
     AND NOT app.leave_consent_met_raw(OLD."id", OLD."schoolId") THEN
    RAISE EXCEPTION 'LEAVE_AWAITING_CONSENT: ansökan väntar på vårdnadshavarnas samtycke'
      USING ERRCODE = 'LV412';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "LeaveRequests_gate"
    BEFORE UPDATE ON "LeaveRequests"
    FOR EACH ROW EXECUTE FUNCTION app.leave_requests_gate();

REVOKE ALL ON FUNCTION app.leave_policies_stamp() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.leave_requests_policy() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.leave_requests_ask_guardians() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.leave_requests_gate() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- The gateway's functions (SECURITY DEFINER, pinned search_path)
-- ---------------------------------------------------------------------------

-- The caller's school's policy, for the form and the settings page. Always one row.
CREATE FUNCTION app.leave_policy()
RETURNS TABLE ("requireAllGuardians" boolean, "minDaysAhead" integer, "shortNotice" "LeaveShortNotice", "contact" "LeaveContactMode")
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT p."requireAllGuardians", p."minDaysAhead", p."shortNotice", p."contact"
    FROM app.leave_policy_of(app.current_school_id()) p
$$;

-- What the gateway asks before it writes a filing: the code the policy refuses it with,
-- and the minimum, or no row. The trigger asks the same function.
CREATE FUNCTION app.leave_filing_check(p_start date, p_name text, p_phone text, p_relation text)
RETURNS TABLE ("code" text, "days" integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT r."code", r."days"
    FROM app.leave_filing_refusal(app.current_school_id(), app.current_user_role()::text, p_start, p_name, p_phone, p_relation) r
$$;

-- Whether a request of the caller's school has its consent; what the mentor's arms ask.
CREATE FUNCTION app.leave_consent_met(p_request uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT app.leave_consent_met_raw(p_request, app.current_school_id())
$$;

-- The consent of the requests the caller reads, as the caller may know it: the state
-- for anyone who reads the request, the counts for staff (how many were asked, have
-- consented, still wait, never who), and for a guardian their own answer. Reads the
-- same rows the arms give: the administrator's every request of the school, a mentor's
-- the pending ones that are theirs to decide and have their consent or that they decided,
-- a guardian's those of their children, a pupil's their own.
--   state  NOT_REQUIRED | WAITING | GIVEN | REFUSED
--   mine   NOT_ASKED | WAITING | GIVEN | REFUSED | ENDED (the guardian's custody has ended)
CREATE FUNCTION app.leave_consent_facts(p_requests uuid[])
RETURNS TABLE ("requestId" uuid, "required" boolean, "state" text, "asked" integer, "given" integer, "waiting" integer, "mine" text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  WITH me AS (
    SELECT app.current_school_id() AS school, app.current_user_id() AS id, app.current_user_role() AS role
  ),
  readable AS (
    SELECT r.*, me.role AS caller_role, me.id AS caller
      FROM "LeaveRequests" r, me
     WHERE r."id" = ANY (p_requests)
       AND r."schoolId" = me.school
       AND (me.role = 'SCHOOL_ADMIN'
            OR (me.role = 'TEACHER'
                AND ((r."decidedAs" = 'MENTOR' AND r."decidedById" = me.id)
                     OR (r."status" = 'PENDING' AND r."referredAt" IS NULL
                         AND app.leave_mine_to_decide(r."schoolId", r."studentId", r."startDate", r."endDate")
                         AND (NOT r."consentRequired" OR app.leave_consent_met_raw(r."id", r."schoolId")))))
            OR (me.role = 'GUARDIAN' AND r."studentId" = ANY ((SELECT app.current_guardian_child_ids())::uuid[]))
            OR (me.role = 'STUDENT' AND r."studentId" = me.id))
  )
  SELECT r."id",
         r."consentRequired",
         CASE WHEN NOT r."consentRequired" THEN 'NOT_REQUIRED'
              WHEN r."status" = 'GUARDIAN_DECLINED' THEN 'REFUSED'
              WHEN app.leave_consent_met_raw(r."id", r."schoolId") THEN 'GIVEN'
              ELSE 'WAITING' END,
         CASE WHEN r."consentRequired" AND r.caller_role IN ('SCHOOL_ADMIN', 'TEACHER')
              THEN (SELECT count(*)::integer FROM "LeaveConsents" c WHERE c."leaveRequestId" = r."id" AND c."schoolId" = r."schoolId") END,
         CASE WHEN r."consentRequired" AND r.caller_role IN ('SCHOOL_ADMIN', 'TEACHER')
              THEN (SELECT count(*)::integer FROM "LeaveConsents" c WHERE c."leaveRequestId" = r."id" AND c."schoolId" = r."schoolId" AND c."consented" IS TRUE) END,
         CASE WHEN r."consentRequired" AND r.caller_role IN ('SCHOOL_ADMIN', 'TEACHER')
              THEN (SELECT count(*)::integer FROM "LeaveConsents" c
                     WHERE c."leaveRequestId" = r."id" AND c."schoolId" = r."schoolId" AND c."consented" IS NULL
                       AND app.ack_receipt_open(c."guardianId", r."studentId", c."schoolId")) END,
         CASE WHEN r.caller_role <> 'GUARDIAN' THEN 'NOT_ASKED'
              ELSE coalesce((SELECT CASE WHEN c."consented" IS TRUE THEN 'GIVEN'
                                         WHEN c."consented" IS FALSE THEN 'REFUSED'
                                         WHEN app.ack_receipt_open(c."guardianId", r."studentId", c."schoolId") THEN 'WAITING'
                                         ELSE 'ENDED' END
                               FROM "LeaveConsents" c
                              WHERE c."leaveRequestId" = r."id" AND c."schoolId" = r."schoolId" AND c."guardianId" = r.caller), 'NOT_ASKED') END
    FROM readable r
   ORDER BY r."createdAt" DESC, r."id"
$$;

-- The LEAVE_CONSENT_REQUESTED notices this transaction wrote about a request the caller
-- filed, with the guardians' addresses, which the gateway hands to the e-mail and the push
-- (the filer may not read another person's address).
CREATE FUNCTION app.leave_consent_notices(p_request uuid)
RETURNS TABLE ("notificationId" uuid, "userId" uuid, "email" text, "type" text, "meta" jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT n."id", n."userId", u."email", n."type"::text, n."meta"
    FROM "LeaveRequests" r
    JOIN "Notifications" n
      ON n."schoolId" = r."schoolId" AND n."createdAt" = now() AND n."type" = 'LEAVE_CONSENT_REQUESTED'
     AND n."meta" ->> 'leaveRequestId' = r."id"::text
    JOIN "Users" u ON u."id" = n."userId" AND u."schoolId" = n."schoolId"
   WHERE r."id" = p_request
     AND r."schoolId" = app.current_school_id()
     AND r."requestedById" = app.current_user_id()
   ORDER BY n."userId"
$$;

-- The calling guardian's answer to a request the school asked them about. Final: a
-- second, equal answer changes nothing (and writes nothing), a different one is refused.
-- A no ends the request (GUARDIAN_DECLINED) and tells whoever applied; the last yes
-- tells the mentors who decide it. Answers the notices written, with the addresses, for
-- the delivery after the commit; nothing for an answer that was already given.
--   LV403 not a guardian        LV404 not asked about this request
--   LV409 the request is decided or stopped
--   LV410 the guardian's custody has ended
--   LV411 the guardian answered the other way before
-- The request's row is taken FOR NO KEY UPDATE, so answers and a decision meet in an
-- order; the school's mentor lock comes after it, as it does in a filing.
CREATE FUNCTION app.leave_consent_answer(p_request uuid, p_consent boolean)
RETURNS TABLE ("notificationId" uuid, "userId" uuid, "email" text, "type" text, "meta" jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  me uuid := app.current_user_id();
  sch uuid := app.current_school_id();
  q record;
  c record;
  stamp timestamptz := clock_timestamp();
BEGIN
  IF me IS NULL OR app.current_user_role() IS DISTINCT FROM 'GUARDIAN' OR p_consent IS NULL THEN
    RAISE EXCEPTION 'LEAVE_CONSENT_NOT_A_GUARDIAN' USING ERRCODE = 'LV403';
  END IF;
  SELECT r."id", r."schoolId", r."studentId", r."status", r."requestedById", r."startDate", r."endDate" INTO q
    FROM "LeaveRequests" r
   WHERE r."id" = p_request AND r."schoolId" = sch AND r."consentRequired"
     FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LEAVE_CONSENT_NOT_FOUND' USING ERRCODE = 'LV404';
  END IF;
  SELECT lc."consented" INTO c
    FROM "LeaveConsents" lc
   WHERE lc."leaveRequestId" = p_request AND lc."schoolId" = sch AND lc."guardianId" = me
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LEAVE_CONSENT_NOT_FOUND' USING ERRCODE = 'LV404';
  END IF;
  IF c."consented" IS NOT NULL THEN
    IF c."consented" = p_consent THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'LEAVE_CONSENT_ANSWERED' USING ERRCODE = 'LV411';
  END IF;
  IF q."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'LEAVE_CONSENT_REQUEST_ENDED' USING ERRCODE = 'LV409';
  END IF;
  IF NOT app.ack_receipt_open(me, q."studentId", sch) THEN
    RAISE EXCEPTION 'LEAVE_CONSENT_CUSTODY_ENDED' USING ERRCODE = 'LV410';
  END IF;

  UPDATE "LeaveConsents" lc SET "consented" = p_consent, "answeredAt" = stamp
   WHERE lc."leaveRequestId" = p_request AND lc."schoolId" = sch AND lc."guardianId" = me;
  -- Nothing is left to do about the notices that asked.
  UPDATE "Notifications" nt SET "readAt" = stamp
   WHERE nt."schoolId" = sch AND nt."readAt" IS NULL
     AND nt."type" IN ('LEAVE_CONSENT_REQUESTED', 'LEAVE_CONSENT_REMINDER')
     AND nt."meta" ->> 'leaveRequestId' = p_request::text
     AND (nt."userId" = me OR NOT p_consent);

  IF NOT p_consent THEN
    UPDATE "LeaveRequests" r SET "status" = 'GUARDIAN_DECLINED', "decidedAt" = stamp WHERE r."id" = p_request;
    RETURN QUERY
      WITH written AS (
        INSERT INTO "Notifications" AS nt ("schoolId", "userId", "type", "meta")
        SELECT q."schoolId", q."requestedById", 'LEAVE_CONSENT_REFUSED',
               jsonb_build_object(
                 'leaveRequestId', q."id",
                 'studentName', s."firstName" || ' ' || s."lastName",
                 'startDate', q."startDate"::text,
                 'endDate', q."endDate"::text)
          FROM "Users" s WHERE s."id" = q."studentId" AND s."schoolId" = q."schoolId"
        RETURNING nt."id", nt."userId", nt."type", nt."meta"
      )
      SELECT w."id", w."userId", u."email", w."type"::text, w."meta"
        FROM written w JOIN "Users" u ON u."id" = w."userId" AND u."schoolId" = sch;
    RETURN;
  END IF;

  IF app.leave_consent_met_raw(p_request, sch) THEN
    PERFORM pg_advisory_xact_lock(hashtext('leave_tell_mentors'), hashtext(sch::text));
    RETURN QUERY
      SELECT t."notificationId", t."userId", t."email", 'LEAVE_REQUESTED'::text, t."meta"
        FROM app.leave_tell_mentors(sch, p_request) t
       ORDER BY t."userId";
  END IF;
END
$$;

-- The job's pass (Ledighetspolicyn): one reminder to each guardian who has not answered a
-- request two days after it was filed, while it waits and the leave is not over; and the
-- LEAVE_REQUESTED notices to the mentors of a request that became clear because a custody
-- ended (a yes tells them in its own transaction). At most p_limit reminders. Answers the
-- notices with the addresses for the delivery after the commit. The owner's: nothing for a
-- logged-in caller, and the delivery door, which sets no claims, is what tells them apart.
CREATE FUNCTION app.leave_consent_pass(p_limit integer DEFAULT 200)
RETURNS TABLE ("notificationId" uuid, "userId" uuid, "email" text, "type" text, "meta" jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  school uuid;
BEGIN
  IF app.current_user_id() IS NOT NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
    WITH due AS (
      SELECT c."leaveRequestId", c."schoolId", c."guardianId", r."studentId", r."startDate", r."endDate"
        FROM "LeaveConsents" c
        JOIN "LeaveRequests" r ON r."id" = c."leaveRequestId" AND r."schoolId" = c."schoolId"
        JOIN "Schools" sc ON sc."id" = c."schoolId"
       WHERE c."consented" IS NULL AND c."remindedAt" IS NULL
         AND r."status" = 'PENDING' AND r."createdAt" <= clock_timestamp() - interval '2 days'
         AND r."endDate" >= (now() AT TIME ZONE sc."timezone")::date
         AND app.ack_receipt_open(c."guardianId", r."studentId", c."schoolId")
       ORDER BY r."createdAt", c."guardianId"
       LIMIT greatest(p_limit, 0)
         FOR UPDATE OF c SKIP LOCKED
    ),
    marked AS (
      UPDATE "LeaveConsents" c SET "remindedAt" = clock_timestamp()
        FROM due d
       WHERE c."leaveRequestId" = d."leaveRequestId" AND c."schoolId" = d."schoolId" AND c."guardianId" = d."guardianId"
      RETURNING c."leaveRequestId", c."schoolId", c."guardianId"
    ),
    written AS (
      INSERT INTO "Notifications" AS nt ("schoolId", "userId", "type", "meta")
      SELECT d."schoolId", d."guardianId", 'LEAVE_CONSENT_REMINDER',
             jsonb_build_object(
               'leaveRequestId', d."leaveRequestId",
               'studentName', s."firstName" || ' ' || s."lastName",
               'startDate', d."startDate"::text,
               'endDate', d."endDate"::text)
        FROM due d
        JOIN marked m ON m."leaveRequestId" = d."leaveRequestId" AND m."schoolId" = d."schoolId" AND m."guardianId" = d."guardianId"
        JOIN "Users" s ON s."id" = d."studentId" AND s."schoolId" = d."schoolId"
      RETURNING nt."id", nt."userId", nt."type", nt."meta"
    )
    SELECT w."id", w."userId", u."email", w."type"::text, w."meta"
      FROM written w JOIN "Users" u ON u."id" = w."userId";

  FOR school IN
    SELECT DISTINCT r."schoolId" FROM "LeaveRequests" r
     WHERE r."consentRequired" AND r."status" = 'PENDING' AND r."referredAt" IS NULL
     ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext('leave_tell_mentors'), hashtext(school::text));
    RETURN QUERY
      SELECT t."notificationId", t."userId", t."email", 'LEAVE_REQUESTED'::text, t."meta"
        FROM app.leave_tell_mentors(school, NULL) t
       ORDER BY t."userId";
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- What the mentor reads, decides and is told: only a request with its consent.
-- Each body is the one 20261023091000 or 20261101090000 wrote, plus the one condition.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.leave_request_refer(p_request uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  n integer;
BEGIN
  UPDATE "LeaveRequests" r
     SET "referredAt" = now(), "referredById" = app.current_user_id()
   WHERE r."id" = p_request
     AND r."status" = 'PENDING' AND r."referredAt" IS NULL
     AND (NOT r."consentRequired" OR app.leave_consent_met_raw(r."id", r."schoolId"))
     AND app.leave_mine_to_decide(r."schoolId", r."studentId", r."startDate", r."endDate");
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END
$$;

CREATE OR REPLACE FUNCTION app.leave_tell_mentors(p_school uuid, p_request uuid)
RETURNS TABLE ("notificationId" uuid, "userId" uuid, "email" text, "meta" jsonb)
LANGUAGE sql VOLATILE AS $$
  WITH pending AS (
    SELECT r."id", r."schoolId", r."studentId", r."startDate", r."endDate",
           s."firstName" || ' ' || s."lastName" AS student_name
      FROM "public"."LeaveRequests" r
      JOIN "public"."Users" s ON s."id" = r."studentId"
     WHERE r."schoolId" = p_school AND r."status" = 'PENDING' AND r."referredAt" IS NULL
       AND (NOT r."consentRequired" OR app.leave_consent_met_raw(r."id", r."schoolId"))
       AND (p_request IS NULL OR r."id" = p_request)
       FOR KEY SHARE OF r SKIP LOCKED
  ),
  owed AS (
    SELECT p."id" AS request, p."schoolId" AS school, m.id AS mentor,
           jsonb_build_object(
             'leaveRequestId', p."id",
             'studentName', p.student_name,
             'startDate', p."startDate"::text,
             'endDate', p."endDate"::text,
             'schoolDays', (SELECT count(*) FROM app.leave_school_days(p."schoolId", p."studentId", p."startDate", p."endDate"))
           ) AS notice
      FROM pending p,
           LATERAL app.leave_deciding_mentors(p."schoolId", p."studentId", p."startDate", p."endDate") AS m(id)
     WHERE NOT EXISTS (
             SELECT 1 FROM "public"."LeaveRequestNotices" t
              WHERE t."leaveRequestId" = p."id" AND t."userId" = m.id)
  ),
  told AS (
    INSERT INTO "public"."LeaveRequestNotices" ("leaveRequestId", "userId", "schoolId")
    SELECT o.request, o.mentor, o.school FROM owed o
    ON CONFLICT ("leaveRequestId", "userId") DO NOTHING
    RETURNING "leaveRequestId", "userId"
  ),
  written AS (
    INSERT INTO "public"."Notifications" ("id", "schoolId", "userId", "type", "meta")
    SELECT gen_random_uuid(), o.school, o.mentor, 'LEAVE_REQUESTED', o.notice
      FROM owed o
      JOIN told t ON t."leaveRequestId" = o.request AND t."userId" = o.mentor
    RETURNING "id", "userId", "meta"
  )
  SELECT w."id", w."userId", u."email", w."meta"
    FROM written w JOIN "public"."Users" u ON u."id" = w."userId"
$$;

CREATE OR REPLACE FUNCTION app.leave_request_facts(p_requests uuid[])
RETURNS TABLE (
    "requestId"            uuid,
    "schoolDays"           integer,
    "mentorLimit"          integer,
    "mentorIds"            uuid[],
    "decidingMentorIds"    uuid[],
    "yearName"             text,
    "yearStart"            date,
    "yearEnd"              date,
    "yearApprovedDays"     integer,
    "yearApprovedRequests" integer,
    "yearPendingRequests"  integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  WITH me AS (
    SELECT app.current_school_id() AS school, app.current_user_id() AS id, app.current_user_role() AS role
  ),
  readable AS (
    -- The rows leave_requests_admin_all and leave_requests_mentor_select give
    -- the caller, by the same tests (RLS section 99 asserts they agree), and
    -- whether the caller weighs the pupil's year on it: the admin always, a
    -- teacher on a pending request, which the arm gives them only to decide.
    SELECT r.*,
           (me.role = 'SCHOOL_ADMIN' OR (r."status" = 'PENDING' AND r."referredAt" IS NULL)) AS weighs
      FROM "LeaveRequests" r, me
     WHERE r."id" = ANY (p_requests)
       AND r."schoolId" = me.school
       AND (me.role = 'SCHOOL_ADMIN'
            OR (me.role = 'TEACHER'
                AND ((r."decidedAs" = 'MENTOR' AND r."decidedById" = me.id)
                     OR (r."status" = 'PENDING' AND r."referredAt" IS NULL
                         AND (NOT r."consentRequired" OR app.leave_consent_met_raw(r."id", r."schoolId"))
                         AND app.leave_mine_to_decide(r."schoolId", r."studentId", r."startDate", r."endDate")))))
  )
  SELECT r."id",
         (SELECT count(*)::int FROM app.leave_school_days(r."schoolId", r."studentId", r."startDate", r."endDate")),
         app.leave_mentor_limit(r."schoolId"),
         ARRAY(SELECT m.id FROM app.leave_mentors(r."schoolId", r."studentId", r."startDate", r."endDate") AS m(id) ORDER BY 1),
         CASE WHEN r."status" = 'PENDING' AND r."referredAt" IS NULL
              THEN ARRAY(SELECT m.id FROM app.leave_deciding_mentors(r."schoolId", r."studentId", r."startDate", r."endDate") AS m(id) ORDER BY 1)
              ELSE '{}'::uuid[] END,
         y."name", y."startDate", y."endDate",
         CASE WHEN r.weighs THEN other.approved_days END,
         CASE WHEN r.weighs THEN other.approved END,
         CASE WHEN r.weighs THEN other.pending END
    FROM readable r
    LEFT JOIN LATERAL (
      SELECT a."name", a."startDate", a."endDate"
        FROM "AcademicYears" a
       WHERE r.weighs
         AND a."schoolId" = r."schoolId" AND r."startDate" BETWEEN a."startDate" AND a."endDate"
       ORDER BY a."startDate" DESC
       LIMIT 1
    ) y ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum((SELECT count(*) FROM app.leave_school_days(o."schoolId", o."studentId",
                                                  GREATEST(o."startDate", y."startDate"), LEAST(o."endDate", y."endDate"))))
                        FILTER (WHERE o."status" = 'APPROVED'), 0)::int AS approved_days,
             (count(*) FILTER (WHERE o."status" = 'APPROVED'))::int AS approved,
             (count(*) FILTER (WHERE o."status" = 'PENDING'))::int AS pending
        FROM "LeaveRequests" o
       WHERE y."startDate" IS NOT NULL
         AND o."schoolId" = r."schoolId" AND o."studentId" = r."studentId" AND o."id" <> r."id"
         AND o."startDate" <= y."endDate" AND o."endDate" >= y."startDate"
    ) other ON true
   ORDER BY r."createdAt" DESC, r."id"
$$;

-- ---------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------

ALTER TABLE "LeavePolicies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LeaveConsents" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r text;
  tbl text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    -- The mentor sees and decides a request only once it has its consent.
    ALTER POLICY "leave_requests_mentor_select" ON "LeaveRequests"
        USING (
            (select app.current_user_role()) = 'TEACHER'
            AND "schoolId" = (select app.current_school_id())
            AND (
                ("decidedAs" = 'MENTOR' AND "decidedById" = (select app.current_user_id()))
                OR ("status" = 'PENDING' AND "referredAt" IS NULL
                    AND ("consentRequired" = false OR app.leave_consent_met("id"))
                    AND app.leave_mine_to_decide("schoolId", "studentId", "startDate", "endDate"))
            )
        );
    ALTER POLICY "leave_requests_mentor_update" ON "LeaveRequests"
        USING (
            (select app.current_user_role()) = 'TEACHER'
            AND "schoolId" = (select app.current_school_id())
            AND "status" = 'PENDING' AND "referredAt" IS NULL
            AND ("consentRequired" = false OR app.leave_consent_met("id"))
            AND app.leave_mine_to_decide("schoolId", "studentId", "startDate", "endDate")
        );

    -- The policy: the school's administrators read it, those who decide write it. Everyone
    -- else asks app.leave_policy() and never reads the row.
    CREATE POLICY "leave_policies_admin_select" ON "LeavePolicies"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "leave_policies_admin_insert" ON "LeavePolicies"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_decides()));
    CREATE POLICY "leave_policies_admin_update" ON "LeavePolicies"
        FOR UPDATE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_decides()));

    -- LeaveConsents: no policy, and no privilege either. Only the functions above read
    -- and write it, so no API role sees a guardian's answer.
    FOREACH tbl IN ARRAY ARRAY['LeavePolicies', 'LeaveConsents'] LOOP
      EXECUTE format('REVOKE ALL ON %I FROM "app_authenticated"', tbl);
    END LOOP;
    GRANT SELECT, INSERT, UPDATE ON "LeavePolicies" TO "app_authenticated";
  END IF;

  FOREACH tbl IN ARRAY ARRAY['LeavePolicies', 'LeaveConsents'] LOOP
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

COMMENT ON TABLE "LeavePolicies" IS
  'How a school receives a leave request: every guardian''s consent, the fewest days ahead, a temporary contact. One row per school, all off by default. No personal data.';
COMMENT ON TABLE "LeaveConsents" IS
  'The guardians a school asked to consent to a leave request, as of its filing, and their final answers. Read and written by the app.leave_consent_* functions alone.';
COMMENT ON COLUMN "LeaveRequests"."consentRequired" IS
  'The school asked every guardian with active custody to consent when the request was filed; set by the LeaveRequests_policy trigger.';
COMMENT ON COLUMN "LeaveRequests"."contactName" IS
  'A temporary contact during the leave: a third party''s name, telephone and relation to the pupil. Read by whoever reads the request; goes with it.';
COMMENT ON FUNCTION app.leave_policy() IS
  'The caller''s school''s leave policy: every guardian''s consent, fewest days ahead and what a late request meets, a temporary contact. Always one row.';
COMMENT ON FUNCTION app.leave_filing_check(date, text, text, text) IS
  'The code the school''s policy refuses a filing with (LEAVE_REQUEST_TOO_LATE, LEAVE_CONTACT_REQUIRED, LEAVE_CONTACT_INCOMPLETE) and the minimum days, or no row.';
COMMENT ON FUNCTION app.leave_consent_met(uuid) IS
  'Whether a request of the caller''s school has its consent: nobody who can still answer waits and nobody said no.';
COMMENT ON FUNCTION app.leave_consent_facts(uuid[]) IS
  'The consent of the requests the caller reads: the state for anyone, the counts for staff, the guardian''s own answer for a guardian. Never who answered what.';
COMMENT ON FUNCTION app.leave_consent_notices(uuid) IS
  'The LEAVE_CONSENT_REQUESTED notices this transaction wrote about a request the caller filed, with the guardians'' addresses.';
COMMENT ON FUNCTION app.leave_consent_answer(uuid, boolean) IS
  'A guardian''s final answer to a request for consent; a no ends the request and tells whoever applied, the last yes tells the mentors. LV403 not a guardian, LV404 not asked, LV409 request ended, LV410 custody ended, LV411 answered the other way.';
COMMENT ON FUNCTION app.leave_consent_pass(integer) IS
  'The job''s pass: one reminder to each guardian who has not answered after two days, and the mentors'' notices for a request a custody that ended made clear; the notices with the addresses; nothing for a logged-in caller.';
COMMENT ON FUNCTION app.leave_filing_refusal(uuid, text, date, text, text, text) IS
  'Whether a filing meets the school''s policy: the first code it breaks, or no row. Guardians and pupils are held to the minimum and the contact; an administrator is not.';
COMMENT ON FUNCTION app.leave_consent_met_raw(uuid, uuid) IS
  'The one definition of a request having its consent, for any school it is given (the owner''s).';

DO $$
DECLARE
  fn text;
  r text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'app.leave_policies_stamp()',
    'app.leave_requests_policy()',
    'app.leave_requests_ask_guardians()',
    'app.leave_requests_gate()',
    'app.leave_policy()',
    'app.leave_filing_check(date, text, text, text)',
    'app.leave_consent_met(uuid)',
    'app.leave_consent_facts(uuid[])',
    'app.leave_consent_notices(uuid)',
    'app.leave_consent_answer(uuid, boolean)',
    'app.leave_consent_pass(integer)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', fn, r);
      END IF;
    END LOOP;
  END LOOP;
  -- The API role asks the policy, the filing check, the policies' question about a request, the
  -- consent facts, the notices of a filing, the guardian's answer and the job's pass (which
  -- answers nothing to a logged-in caller). The trigger functions are the owner's: a
  -- trigger needs no grant. leave_request_refer, _tell_mentors and _facts keep the grants
  -- they had (CREATE OR REPLACE leaves them).
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    FOREACH fn IN ARRAY ARRAY[
      'app.leave_policy()',
      'app.leave_filing_check(date, text, text, text)',
      'app.leave_consent_met(uuid)',
      'app.leave_consent_facts(uuid[])',
      'app.leave_consent_notices(uuid)',
      'app.leave_consent_answer(uuid, boolean)',
      'app.leave_consent_pass(integer)'
    ] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO "app_authenticated"', fn);
    END LOOP;
  END IF;
END
$$;
