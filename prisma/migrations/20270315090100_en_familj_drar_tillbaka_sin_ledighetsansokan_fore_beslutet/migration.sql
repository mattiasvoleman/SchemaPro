-- En familj drar tillbaka sin ledighetsansökan före beslutet (K6, omgång 15).
--
-- ## Vad som fanns
--
-- En familj som ansökt om ledighet och ångrat sig kunde be skolan avslå (DEPLOYMENT 18.2: "there is no withdrawal by the family in this
-- release (BESLUT, follow-up): it needs a status of its own and a rule for what happens to a request already granted"). En vårdnadshavare
-- eller en elev har ingen UPDATE-rättighet på LeaveRequests alls, med flit: ansökans elev, datum och anledning ändras inte
-- (LeaveRequests_request_is_fixed), och beslutet är skolans.
--
-- ## Vad det blir
--
-- Den som ansökte kan dra tillbaka en ansökan som ännu väntar (PENDING). Ansökan får statusen WITHDRAWN (20270315090000) och tidpunkten i
-- decidedAt, som GUARDIAN_DECLINEDs slut har den, och ingen beslutsfattare: en CHECK håller det. Regeln för det som redan är beslutat är att
-- det inte dras tillbaka: en beviljad ansökan har skrivit frånvaro, och att ta tillbaka den är skolans beslut. Familjen ber skolan om det, som
-- förut. En ansökan som en vårdnadshavares nej har avslutat (GUARDIAN_DECLINED) eller en som redan är tillbakadragen dras inte tillbaka igen.
--
--   * app.leave_request_withdraw(p_request): den som ansökte, och bara hen (requestedById är den inloggade personen), för en ansökan i hens
--     egen skola som väntar. En lärare, en annan vårdnadshavare och en administratör som inte ansökte kan det inte: en administratör avslår
--     i stället. Svarar om ansökan drogs tillbaka; falskt för varje annat fall, så att gatewayen kan svara 409 utan att läsa om raden.
--     SECURITY DEFINER, fastlåst search_path, EXECUTE för app_authenticated ensam: PostgREST når den inte, och en vårdnadshavares egen
--     Supabase-session drar inget tillbaka. Den kräver en inloggad person (LV403), motsatsen till jobbens dörrar.
--   * Triggern LeaveRequests_gate (20270205091000) lär sig statusen: en tillbakadragen ansökan beslutas inte och lämnar inte sin status
--     (LV409, som en som en vårdnadshavares nej avslutat), en annan status än PENDING går inte till WITHDRAWN (LV417), ingen annan än den som
--     ansökte sätter den (LV418: inte heller en administratör med en egen UPDATE, och inte en skrivning utan inloggad person), och när ansökan dras
--     tillbaka läses de notiser som bad om något av den som inte längre har något att göra: vårdnadshavarnas begäran om samtycke och mentorernas
--     "ny ansökan" (som den väntande avslagna ansökans samtyckesnotiser läses i dag). Allt annat i gate-funktionen är oförändrat, ord för ord.
--
-- ## Vad som inte ändras
--
-- Ingen policy, ingen rättighet på tabellen och ingen annan funktion: mentorns arm släpper bara fram väntande ansökningar och slutar därmed
-- se den, påminnelsejobbet och samtyckessvaren frågar efter PENDING och släpper den, och en vårdnadshavares svar på en tillbakadragen begäran är
-- ett 409 (LEAVE_CONSENT_REQUEST_ENDED) som för varje annan avslutad. Gallringen tar ansökan på sin sista dag oavsett status. Statistiken
-- (app.leave_request_facts) räknar bara APPROVED och PENDING. Ingen ny gallringstyp och ingen ny kolumn, så skolans export och registerutdraget
-- är desamma (statusen står i ledigheter.csv som varje annan).
--
-- ## Låset
--
-- ADD CONSTRAINT ... NOT VALID tar ACCESS EXCLUSIVE på LeaveRequests en kort stund, och VALIDATE blockerar ingen läsare eller skrivare. En
-- begäran skriver tabellen (en ansökan, ett beslut, en vårdnadshavares svar läser den), så låset tas NOWAIT i en slinga på 30 s med
-- lock_timeout 5 s (policy-migration-lock-order): filen väntar aldrig med ett lås i handen, och stannar efter 30 s utan att ha ändrat något.
-- Ingen rad har statusen än, så valideringen läser tabellen en gång och hittar ingenting att neka. Funktionerna tar inget tabelllås.
--
-- ## Under en driftsättning
--
-- API:t före detta känner inte statusen och anropar inte funktionen. En ansökan som dras tillbaka av API:t efter migreringen och som den gamla
-- instansen läser får en status den inte känner (Prismas enum läser den som ett fel för en modelläsning av raden: se DEPLOYMENT 18.1 om
-- GUARDIAN_DECLINED, samma sak). Släpp därför gatewayen i samma veva som migreringen, och dra inte tillbaka gatewayen utan att läsa avsnittet "A family takes back a leave request" i DEPLOYMENT
-- (Rolling back). Avsnittets nummer står inte här: parallella pull requests numrerar om sina, och en tillämpad migrering ändras inte.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "LeaveRequests" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'LeaveRequests was not free in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;

  ALTER TABLE "LeaveRequests"
    ADD CONSTRAINT "LeaveRequests_a_withdrawn_request_has_no_decider" CHECK (
      "status" <> 'WITHDRAWN' OR ("decidedById" IS NULL AND "decidedAs" IS NULL AND "decidedAt" IS NOT NULL)
    ) NOT VALID;
  ALTER TABLE "LeaveRequests" VALIDATE CONSTRAINT "LeaveRequests_a_withdrawn_request_has_no_decider";
END
$$;

CREATE OR REPLACE FUNCTION app.leave_requests_gate() RETURNS trigger
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
  IF OLD."status" = 'PENDING' AND NEW."status" = 'APPROVED' AND OLD."consentRequired"
     AND NOT app.leave_consent_met_raw(OLD."id", OLD."schoolId") THEN
    RAISE EXCEPTION 'LEAVE_AWAITING_CONSENT: ansökan väntar på vårdnadshavarnas samtycke'
      USING ERRCODE = 'LV412';
  END IF;
  -- A request rektor rejects while it waits for consent is decided: the guardians' unanswered requests for it are no longer work
  -- to do. Found by the guardians asked (their own notices, by the index on the person), not by scanning the school's.
  IF OLD."status" = 'PENDING' AND NEW."status" = 'REJECTED' AND OLD."consentRequired" THEN
    UPDATE "Notifications" nt SET "readAt" = now()
     WHERE nt."userId" IN (SELECT c."guardianId" FROM "LeaveConsents" c WHERE c."leaveRequestId" = OLD."id" AND c."schoolId" = OLD."schoolId")
       AND nt."schoolId" = OLD."schoolId" AND nt."readAt" IS NULL
       AND nt."type" IN ('LEAVE_CONSENT_REQUESTED', 'LEAVE_CONSENT_REMINDER')
       AND nt."meta" ->> 'leaveRequestId' = OLD."id"::text;
  END IF;
  -- K6: a request the family took back. Final, and only from PENDING.
  IF OLD."status" = 'WITHDRAWN' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'LEAVE_REQUEST_WITHDRAWN: en ansökan som dragits tillbaka beslutas inte'
      USING ERRCODE = 'LV409';
  END IF;
  IF NEW."status" = 'WITHDRAWN' AND OLD."status" IS DISTINCT FROM NEW."status" THEN
    IF OLD."status" <> 'PENDING' THEN
      RAISE EXCEPTION 'LEAVE_WITHDRAW_IS_BEFORE_THE_DECISION: bara en ansökan som väntar dras tillbaka'
        USING ERRCODE = 'LV417';
    END IF;
    -- Tillbakadragen betyder att den som ansökte tog tillbaka den: ingen annan sätter statusen, och inte heller en skrivning utan inloggad person.
    IF OLD."requestedById" IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'LEAVE_WITHDRAW_IS_THE_FILERS: en ansökan dras tillbaka av den som ansökte'
        USING ERRCODE = 'LV418';
    END IF;
    -- What the request asked of anybody is no work to do any more: the guardians' requests for consent and the mentors' "a new request".
    UPDATE "Notifications" nt SET "readAt" = now()
     WHERE nt."schoolId" = OLD."schoolId" AND nt."readAt" IS NULL
       AND nt."type" IN ('LEAVE_CONSENT_REQUESTED', 'LEAVE_CONSENT_REMINDER', 'LEAVE_REQUESTED')
       AND nt."meta" ->> 'leaveRequestId' = OLD."id"::text;
  END IF;
  RETURN NEW;
END
$$;

-- Den som ansökte drar tillbaka en ansökan som väntar. Svarar om den drogs tillbaka.
CREATE FUNCTION app.leave_request_withdraw(p_request uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  me uuid := app.current_user_id();
  school uuid := app.current_school_id();
  changed integer;
BEGIN
  IF me IS NULL OR school IS NULL THEN
    RAISE EXCEPTION 'LEAVE_WITHDRAW_NEEDS_A_PERSON: en ansökan dras tillbaka av den som ansökte'
      USING ERRCODE = 'LV403';
  END IF;
  UPDATE "LeaveRequests" r
     SET "status" = 'WITHDRAWN', "decidedAt" = clock_timestamp()
   WHERE r."id" = p_request AND r."schoolId" = school AND r."requestedById" = me AND r."status" = 'PENDING';
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END
$$;

COMMENT ON FUNCTION app.leave_request_withdraw(uuid) IS
  'K6: the person who filed a leave request takes it back while it waits (WITHDRAWN, decidedAt the moment, no decider); false for anything else. Refused (LV403) to a session with no person.';

REVOKE ALL ON FUNCTION app.leave_request_withdraw(uuid) FROM PUBLIC;
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION app.leave_request_withdraw(uuid) FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT EXECUTE ON FUNCTION app.leave_request_withdraw(uuid) TO "app_authenticated";
  END IF;
END
$$;
