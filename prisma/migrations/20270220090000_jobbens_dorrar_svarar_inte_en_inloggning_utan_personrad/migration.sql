-- Dörrvakten: fyra av jobbens dörrar, och måltidsbrevets två, svarar inte en inloggning, också när inloggningen inte är
-- en person.
--
-- ## Vad som fanns
--
-- Sex SECURITY DEFINER-funktioner i app, som API-rollen får köra, är till för det som körs utan inloggning: bakgrundsjobben
-- (vikarieförfrågningens avslut, krislägets avslut, måltidsbrevet) och synkens och integrationsnyckelns principal.
-- Ingen sätter några claims. Fyra av dem vaktade på det de kallade "en inloggad":
--
--   IF app.current_user_id() IS NOT NULL THEN ...
--
-- Men en inloggning behöver inte vara en person. Huvudmannens läsare och kommunadministratören har claims och väljer
-- (eller väljer inte) en skola, och app.current_user_id() är NULL för dem, eftersom de saknar Users-rad där. För dem
-- släppte vakten igenom. Samma form rättades för Kvittens i 20270202090000 (#289); granskningen av den (U-1) räknade upp
-- de fyra som var kvar, och granskningen av D8 (#279, U-1) de två måltidsdörrarna.
--
-- Mätt som app_authenticated med claims för huvudmannens läsare, kommunadministratören och en skolans administratör, på
-- riktiga rader (dorrvakt-data/lage-idag.sql i samordnarens anteckningar):
--
--   app.cover_requests_settle      stängde varje skolas förfallna vikarieförfrågningar och gav tillbaka avsändarens authId
--                                  och profil (rader över skolgränsen). Jobbet går miss om sin avisering när en inloggning
--                                  hunnit före: förfrågan är då redan avslutad och ingen får veta det.
--   app.crisis_settle              avslutade varje skolas larm som stått öppna längre än 12 (skarpt) eller 3 (övning) timmar,
--                                  samma sak som jobbet gör, men i förväg och av en inloggning.
--   app.leave_requests_tell_new_mentors och app.ss12000_source_secrets
--                                  har en dörr för personen (skolans personal, skolans administratör) och en för det som körs
--                                  utan inloggning (synkens och integrationsnyckelns principal). En inloggning utan personrad
--                                  fick ingenting på egen hand, men principalgrenen frågade efter personrad och inte efter
--                                  inloggning: en inloggning utan personrad släpptes in i den grenen. Den gav skolans skyldiga
--                                  ledighetsnotiser (och skrev dem), respektive källans hemligheter i krypterad form.
--   app.meal_letter och app.meal_letter_schools
--                                  hade ingen vakt alls: vilken inloggning som helst, också en lärare på en annan skola, fick
--                                  skolans köksadress och dagens tal, och listan på skolorna med brevet på.
--
-- Ingen gatewayväg når någon av dem med en inloggning: jobben kör dem i withDeliveryService (ingen principal, inga claims),
-- synken och integrationsnyckeln i withSyncPrincipal och withServicePrincipal (inga claims), och personens dörr i en
-- vanlig begäran. Det var ett försvar på djupet som inte höll för den inloggning som saknar personrad.
--
-- ## Vad det blir
--
-- Vakten frågar efter det dörren faktiskt är, ingen inloggning alls: inga claims (request.jwt.claims) och ingen ensam
-- subjektsinställning (request.jwt.claim.sub, som äldre byggen och Supabase läser). Tom sträng räknas som ingenting, eftersom
-- en poolad anslutning som någon förfrågan har använt läser inställningarna som '' och inte som NULL. Samma två villkor som
-- app.ack_remind_request fick i 20270202090000, skrivna efter varje dörrs eget svar. Varje dörr behåller det:
--
--   cover_requests_settle, crisis_settle   nekar (CR403, KL403) varje inloggning, som de nekade en person förut (en nekning
--                                          är kontraktet: proven och gatewayns felkarta känner koderna);
--   leave_requests_tell_new_mentors        personens dörr är oförändrad; principalgrenen släpper bara in en session utan
--                                          inloggning;
--   ss12000_source_secrets                 en synk utan någons inloggning är det som släpps in; en inloggning bredvid synkens
--                                          inställning nekas (SS403) som en person gjorde förut; skolans administratör
--                                          är oförändrad;
--   meal_letter, meal_letter_schools       svarar NULL respektive ingenting åt en inloggning. De är kvar LANGUAGE sql, med
--                                          vakten som ett villkor i frågan, så att planen är den samma som förut (en
--                                          plpgsql-funktion planeras annorlunda efter fem anrop, och jobbet kör dem var
--                                          andra minut).
--
-- ## Vad som inte ändras
--
-- Signaturer, returtyper, flyktighet, SECURITY DEFINER, search_path (och jit = off för måltidsdörrarna) och rättigheterna
-- är desamma: CREATE OR REPLACE behåller ägare och ACL, så GRANT EXECUTE till app_authenticated rörs inte, och det som inte
-- sägs om igen återställs, så LANGUAGE, flyktighet och inställningar är skrivna som förut. Kropparna är i övrigt tecken för
-- tecken de förras: bara vakten är ny.
--
--                                   md5(prosrc) före                   efter
--   cover_requests_settle             4abfa824fd204376ba82929f62c90a96   8b8cc3e8b34179d90746aa1fc038694f
--   crisis_settle                     7674b1cf4892beaba5f48926b8da17a0   df2d2c9d74b0245233de7b67c4b5c78f
--   leave_requests_tell_new_mentors   a75dd0895a688871a0654c8c4f97f3cf   3a42a387791b438d815432064bf82e80
--   ss12000_source_secrets            4ca02603ce4956cf53c4a00296e6a3c9   b820ebf456539d236b1bc4fea0e729bc
--   meal_letter                       2a5d90dedca1516969347a06d216e87b   ceb84a1e99239a88f75064e6f15463f3
--   meal_letter_schools               f117f51aaf39fe038a4b516dbd82a367   d30fffeb44fbaa9ac84ffcca38145914
--
-- Före-kropparna är de som 20270102091000 (cover), 20270113091000 (crisis), 20261212090300 (leave, secrets) och
-- 20270123090000 (meal) lade, och som main hade när det här skrevs. Ingen annan funktion ändras.
--
-- ## Vad som inte rättas här
--
-- Vakten räknar inte tjänsteprincipalerna (app.service_school_id och app.sync_school_id): cover_requests_settle och
-- crisis_settle nekar inte en session som bara bär en principalinställning och inga claims. Det är samma avgränsning som
-- #289:s (dess U-2). Ingen gatewayväg anropar dörrarna med en principal, och de andra jobbfunktionerna (app.absence_stats_*,
-- app.gallring_*, ...) har ingen vakt alls och är orörda: de är en egen genomgång.
--
-- ## Låsen
--
-- Ingen tabell skrivs eller ändras, så ingen tabell låses mot en läsare eller en skrivare. Varje CREATE OR REPLACE FUNCTION tar
-- ShareUpdateExclusive på funktionens egen rad i pg_proc. De två LANGUAGE sql-funktionerna kontrolleras dessutom när de skapas
-- och tar då ACCESS SHARE på tabellerna de läser (KitchenSettings, Schools, CalendarLunches) till filens slut: det hindrar bara
-- ett ACCESS EXCLUSIVE (en ALTER TABLE), och ingen begäran tar ett sådant. Mätt på PostgreSQL 17 (dorrvakt-data/lock-test.log): filen
-- går på 0,13 s medan en annan session håller dörrarna öppna, och dörrarna svarar på 0,14 s medan filens transaktion står öppen.
-- Lärdomen från #277:s fil (en ADD COLUMN tar ACCESS EXCLUSIVE först i filen och håller det till filens slut) gäller den som lägger
-- en ALTER TABLE här: den ska stå sist, eller ta låset med NOWAIT i en slinga med tak (docs/DEPLOYMENT.md, Kvittens).

-- ---------------------------------------------------------------------------
-- Vikarieförfrågningens avslut (jobbet, var femte minut)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.cover_requests_settle()
RETURNS TABLE ("requestId" uuid, "schoolId" uuid, outcome text, "senderId" uuid, "senderAuthId" uuid, "senderProfile" "AdminProfile", "senderHrRead" boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person (huvudmannens läsare).
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'COVER_REQUEST_SETTLING_IS_THE_JOBS' USING ERRCODE = 'CR403';
  END IF;
  RETURN QUERY
  WITH cand AS (
    SELECT q."id",
           (NOT EXISTS (SELECT 1 FROM "CoverRequestLessons" x WHERE x."requestId" = q."id")
            OR EXISTS (SELECT 1
                         FROM "CoverRequestLessons" x
                         JOIN "CalendarLessons" l ON l."id" = x."calendarLessonId"
                         JOIN "TeacherAbsences" a ON a."id" = x."absenceId"
                        WHERE x."requestId" = q."id"
                          AND (l."status" = 'CANCELLED'
                               OR a."status" <> 'ACTIVE'
                               OR NOT (l."startsAt" < a."endsAt" AND l."endsAt" > a."startsAt")
                               OR (NOT EXISTS (SELECT 1 FROM "CalendarLessonTeachers" t
                                                WHERE t."calendarLessonId" = l."id" AND t."teacherId" = a."userId")
                                   AND NOT EXISTS (SELECT 1 FROM "TeacherAbsenceCovers" c
                                                    WHERE c."absenceId" = a."id" AND c."calendarLessonId" = l."id"))))) AS unfounded
      FROM "CoverRequests" q
     WHERE q."status" = 'OPEN'
  ), due AS (
    SELECT q."id", o.unfounded
      FROM "CoverRequests" q
      JOIN cand o ON o."id" = q."id"
     WHERE q."status" = 'OPEN' AND (o.unfounded OR q."expiresAt" <= clock_timestamp())
     ORDER BY q."id" FOR UPDATE OF q SKIP LOCKED
  ), ended AS (
    UPDATE "CoverRequests" c
       SET "status" = CASE WHEN d.unfounded THEN 'CLOSED'::"CoverRequestStatus" ELSE 'EXPIRED'::"CoverRequestStatus" END
      FROM due d
     WHERE c."id" = d."id" AND c."status" = 'OPEN'
    RETURNING c."id" AS rid, c."schoolId" AS sid, c."requestedByUserId" AS uid, d.unfounded
  )
  SELECT e.rid, e.sid, CASE WHEN e.unfounded THEN 'NOT_NEEDED' ELSE 'EXPIRED' END,
         u."id", u."authId", u."adminProfile", u."hrRead"
    FROM ended e
    LEFT JOIN "Users" u
      ON u."id" = e.uid AND u."schoolId" = e.sid AND u."isActive" AND u."role" = 'SCHOOL_ADMIN'
     AND 'DRIFT' = ANY (app.admin_profile_writes(u."adminProfile"))
   ORDER BY e.rid;
END
$$;

-- ---------------------------------------------------------------------------
-- Krislägets avslut (jobbet, var kvart)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.crisis_settle()
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  n integer;
BEGIN
  -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person (huvudmannens läsare).
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'CRISIS_SETTLE_IS_THE_JOBS' USING ERRCODE = 'KL403';
  END IF;
  UPDATE "CrisisAlarms" a
     SET "endedAt" = clock_timestamp(), "autoEnded" = true
   WHERE a."endedAt" IS NULL
     AND a."startedAt" < clock_timestamp() - CASE a."mode" WHEN 'LIVE' THEN interval '12 hours' ELSE interval '3 hours' END;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

-- ---------------------------------------------------------------------------
-- Ledighetens notiser till nya mentorer (personens dörr och synkens/nyckelns)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.leave_requests_tell_new_mentors()
RETURNS TABLE ("notificationId" uuid, "userId" uuid, email text, meta jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  v_sync    uuid := app.current_sync_school_id();
  -- A huvudman's key, opened for a school, is no principal here.
  v_service uuid := CASE WHEN app.current_service_huvudman_key_id() IS NULL THEN app.current_service_school_id() END;
  v_school  uuid;
BEGIN
  IF app.current_user_id() IS NOT NULL THEN
    IF v_sync IS NULL AND v_service IS NULL
       AND coalesce(app.current_user_role() IN ('TEACHER', 'SCHOOL_ADMIN'), false) THEN
      v_school := app.current_school_id();
    END IF;
  -- Utan person: bara det som körs utan inloggning (synken, integrationsnyckeln). Varje inloggning sätter claims, också
  -- en som inte är en person (huvudmannens läsare), och den är ingen principal här.
  ELSIF nullif(current_setting('request.jwt.claims', true), '') IS NULL
        AND nullif(current_setting('request.jwt.claim.sub', true), '') IS NULL
        AND (v_sync IS NULL OR v_service IS NULL) THEN
    v_school := coalesce(v_sync, v_service);
  END IF;
  IF v_school IS NULL THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('leave_tell_mentors'), hashtext(v_school::text));
  RETURN QUERY SELECT t."notificationId", t."userId", t."email", t."meta"
                 FROM app.leave_tell_mentors(v_school, NULL) AS t
                ORDER BY t."userId";
END
$$;

-- ---------------------------------------------------------------------------
-- Källsystemets hemligheter (skolans administratör och synkens principal)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.ss12000_source_secrets(p_source uuid)
RETURNS TABLE (kind "Ss12000SecretKind", ciphertext bytea, iv bytea, auth_tag bytea, key_id text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  sync uuid := app.current_sync_school_id();
  school uuid;
BEGIN
  IF app.current_service_school_id() IS NOT NULL OR app.current_service_huvudman_key_id() IS NOT NULL THEN
    RAISE EXCEPTION 'SS12000_SECRET_REFUSED: integrationen läser inga hemligheter' USING ERRCODE = 'SS403';
  END IF;
  IF sync IS NOT NULL THEN
    -- The run, with nobody's claims beside it.
    -- Varje inloggning sätter claims, också en som inte är en person (huvudmannens läsare).
    IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
       OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
      RAISE EXCEPTION 'SS12000_SECRET_REFUSED: en synk läser hemligheterna utan någons inloggning' USING ERRCODE = 'SS403';
    END IF;
    school := sync;
  ELSE
    -- Huvudman (20261212090300): the administrator who writes the
    -- integrations, not any: the läsare, and the huvudman's reader, read no
    -- source's secrets.
    school := app.ss12000_admin_writer_school();
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

-- ---------------------------------------------------------------------------
-- Måltidsbrevet: dagens tal och köksadressen (jobbet)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.meal_letter(p_school uuid, p_day date)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp"
  SET jit = off AS $$
  SELECT jsonb_build_object('school', s."name", 'email', k."kitchenEmail") || app.meal_counts(p_school, p_day, p_day)
    FROM "KitchenSettings" k
    JOIN "Schools" s ON s."id" = k."schoolId"
   WHERE k."schoolId" = p_school AND k."letterEnabled" AND k."kitchenEmail" IS NOT NULL
     -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person: den får inget brev.
     AND nullif(current_setting('request.jwt.claims', true), '') IS NULL
     AND nullif(current_setting('request.jwt.claim.sub', true), '') IS NULL
$$;

-- ---------------------------------------------------------------------------
-- Måltidsbrevet: skolorna vars brev ska gå (jobbet, var andra minut)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.meal_letter_schools(p_at timestamptz, p_grace_minutes integer)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp"
  SET jit = off AS $$
  WITH local AS (
    SELECT k."schoolId" AS school_id,
           (p_at AT TIME ZONE s."timezone") AS now_local,
           ((p_at AT TIME ZONE s."timezone")::date + k."cutoffTime") AS cutoff_local
      FROM "KitchenSettings" k
      JOIN "Schools" s ON s."id" = k."schoolId"
     WHERE k."letterEnabled" AND k."cutoffTime" IS NOT NULL AND k."kitchenEmail" IS NOT NULL
  )
  SELECT l.school_id
    FROM local l
   -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person: den får ingen skola.
   WHERE nullif(current_setting('request.jwt.claims', true), '') IS NULL
     AND nullif(current_setting('request.jwt.claim.sub', true), '') IS NULL
     AND l.now_local >= l.cutoff_local
     AND l.now_local < l.cutoff_local + make_interval(mins => greatest(p_grace_minutes, 0))
     AND EXISTS (SELECT 1 FROM "CalendarLunches" cl
                  WHERE cl."schoolId" = l.school_id AND cl."date" = l.now_local::date)
   ORDER BY l.school_id
$$;

-- Kommentarerna säger nu det vakten gör: ingen inloggning alls, en person eller inte.
COMMENT ON FUNCTION app.cover_requests_settle() IS
  'Ends the open requests in every school: EXPIRED when expiresAt has passed, CLOSED (outcome NOT_NEEDED) when a line is no longer a lesson to cover; skips any a yes holds; answers one row per request with the administrator who sent it, or NULLs when they can no longer place a vikarie. Refused (CR403) to a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.crisis_settle() IS
  'Ends the open alarms older than 12 hours (a real one) or 3 hours (an exercise), marked autoEnded; answers how many. Refused (KL403) to a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.leave_requests_tell_new_mentors() IS
  'For the school''s staff, or the SS12000 sync or an integration key with no login: writes the notices its pending requests still owe, under the school''s lock; returns them with the addresses. Nothing for a login with no person row, also beside a principal setting.';
COMMENT ON FUNCTION app.ss12000_source_secrets(uuid) IS
  'The ciphertexts of a source, for its school''s sync principal (no login beside it) or SCHOOL_ADMIN only; never a service principal, and never a login with no person row beside the sync principal (SS403).';
COMMENT ON FUNCTION app.meal_letter(uuid, date) IS
  'Måltidskollen: skolans namn, köksadressen och dagens tal (app.meal_counts), eller NULL när brevet inte är på. Jobbets dörr: NULL åt en session med inloggning (claims), en person eller inte.';
COMMENT ON FUNCTION app.meal_letter_schools(timestamp with time zone, integer) IS
  'Måltidskollen: skolorna med brevet på vars brytpunkt passerat i dag (inom p_grace_minutes) och som har en sittning i dag. Jobbets dörr: ingenting åt en session med inloggning (claims), en person eller inte.';
