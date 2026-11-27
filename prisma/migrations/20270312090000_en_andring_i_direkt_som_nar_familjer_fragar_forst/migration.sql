-- Omgång 15, P5 Förvalen en ny skola möter: en ändring i läget Direkt som når familjer frågar först.
--
-- ## Vad
--
-- En kolumn, PublicationSettings."directReachAcknowledgedAt" (timestamptz, nullbar, utan standardvärde), och en läsfunktion,
-- app.direct_reach_facts(year_id uuid). Ingen annan kolumn, ingen trigger, inget index, ingen ny tabell.
--
-- ## Varför
--
-- Direkt är förvalet, och i Direkt flyttar en ändring av grundschemat de publicerade lektionerna i kalendern på en gång och skickar
-- en notis till eleverna i lektionen och deras vårdnadshavare (master-lessons.service, SCHEDULE_CHANGED). En skola som har publicerat
-- en period och sedan drar en lektion på måndagsmorgonen skickar alltså notiser utan att något har frågat om det. Beslut 8 behåller
-- Direkt som förval men låter sidan fråga före den första ändringen som når familjer i en publicerad period, och säga vem som får
-- notisen. Svaret ("Fortsätt i Direkt") sparas här, så att frågan inte ställs vid varje drag.
--
-- ## Ett svar, en gång, tills läget byts
--
-- Svaret är skolans och ges en gång: det är besvarat så länge directReachAcknowledgedAt inte är NULL. Frågan ställs inte vid varje drag,
-- och inte heller vid varje ny publicering: en skola som har valt att stå kvar i Direkt har valt det. Det som gör frågan ny är ett byte
-- av läge, åt vilket håll det än går (DraftService.switchMode skriver NULL): en skola som har varit i utkast och kommer tillbaka till
-- Direkt har fattat ett nytt beslut om vem som nås. En skola som aldrig har svarat har NULL och blir tillfrågad vid sin första ändring
-- som når familjer.
--
-- ## Läsfunktionen
--
-- PublicationSettings och TimetablePublications är områdesarmarnas (Publicering, 20261110100000). I dag skriver varje profil som flyttar
-- en lektion (full, rektor, schemaläggare: PROFILE_WRITES) också Publicering, så armarna skulle släppa läsningen. Men vakten i
-- master-lessons-skrivningen ska inte hänga på det: en vakt som läser noll rader för att en arm döljer dem tiger i stället för att
-- fråga, och en dag då områdena delas upp hade skolans ändringar nått familjer ofrågat utan att något sagt det. Därför en
-- SECURITY DEFINER-funktion i samma form som app.school_publish_mode: den svarar bara för den inloggades egen skola (app.current_school_id()),
-- för ett läsår, och ger högst en rad: senaste giltiga publiceringens tid och giltighet och skolans svar. Ingen person, inget namn.
-- Utan inloggning (inga claims) är skolan NULL och funktionen ger ingen rad.
--
-- ## Radsäkerhet
--
-- Inga armar ändras: kolumnen är tabellens och följer arm "publication_settings_admin_all" / områdesarmen (Publicering skriver den). API-rollen
-- får köra funktionen; PostgREST-rollerna (anon, authenticated, service_role) gör det inte.
--
-- ## Vid sidan av det levande API:t
--
-- API:t före den här namnger sina kolumner och läser ingen "directReachAcknowledgedAt", så det påverkas inte. Migreringen körs före merge
-- (DEPLOYMENT §2), och en vakt som körs före migreringen finns inte.
--
-- ADD COLUMN tar tabellens ACCESS EXCLUSIVE, och varje skrivning av grundschemat läser inställningen (app.school_publish_mode): en migrering som
-- väntar på låset ställer dem alla bakom sig. Därför tas låset NOWAIT, om igen 50 ms senare medan en begäran håller det, och efter 30 s
-- stannar den utan att ha gjort något och kan köras om (som 20270228090000). Filen har en $$-kropp, så Prisma kör den som en transaktion:
-- ett avslag nedan lämnar inget ändrat.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "PublicationSettings" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'PublicationSettings was not free in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;

  ALTER TABLE "PublicationSettings"
    ADD COLUMN "directReachAcknowledgedAt" TIMESTAMPTZ(6);
END
$$;

COMMENT ON COLUMN "PublicationSettings"."directReachAcknowledgedAt" IS
  'P5 (20270312090000): when an administrator answered "Fortsätt i Direkt" to the question asked before the first change that reaches families in a published period. Not null: answered, once, until the school switches mode (DraftService.switchMode writes null); null: never answered, or the mode was switched since.';

-- The latest publication of the year that still holds (PUBLISHED, not a REFILL: the system's own copy of an older one, as
-- publications.service counts them for validity), and the school's answer. "Today" is the school's, as the publish window reads it.
CREATE FUNCTION app.direct_reach_facts(year_id uuid)
RETURNS TABLE ("publishedAt" timestamptz, "validFrom" date, "validTo" date, "acknowledgedAt" timestamptz, "answered" boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT p."publishedAt", p."validFrom", p."validTo", a."at", a."at" IS NOT NULL
    FROM "TimetablePublications" p
    JOIN "Schools" sc ON sc."id" = p."schoolId"
    LEFT JOIN LATERAL (
      SELECT s."directReachAcknowledgedAt" AS "at" FROM "PublicationSettings" s WHERE s."schoolId" = p."schoolId"
    ) a ON true
   WHERE p."schoolId" = app.current_school_id()
     AND p."academicYearId" = year_id
     AND p."outcome" = 'PUBLISHED'
     AND p."kind" <> 'REFILL'
     AND p."validTo" >= (now() AT TIME ZONE sc."timezone")::date
   ORDER BY p."publishedAt" DESC, p."id" DESC
   LIMIT 1
$$;

COMMENT ON FUNCTION app.direct_reach_facts(uuid) IS
  'P5 (20270312090000): the caller''s school''s latest publication of the year that has not ended, and the school''s answer to the question asked before a change in Direkt reaches families. One row at most; none without a login or without a valid publication.';

REVOKE ALL ON FUNCTION app.direct_reach_facts(uuid) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT EXECUTE ON FUNCTION app.direct_reach_facts(uuid) TO "app_authenticated";
  END IF;
END
$$;
