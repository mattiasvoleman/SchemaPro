-- Frånvarostatistik över tid: frånvaron per månad över tre läsår för skolan och
-- varje klass, mönstren per elev och klass inför utvecklingssamtal, och
-- rapporteringsgraden bredvid.
--
-- Skola24 Frånvarostatistik visar tre år månad för månad, mönster per elev och
-- klass, och köps av rektor, huvudman och mentor inför varje termin. Rastra
-- hade minutrapporten per klass och period (/admin/reports) och
-- Frånvarobevakningens gränser, men ingen som såg hur det utvecklas, och
-- närvaron gallras: en skola som sparar den ett år kan inte räkna om tre.
-- Migreringen gör det som går att göra utan att spara en elev längre än skolan
-- beslutat: en tabell med månadssummor per klass och för skolan utan ett enda
-- elev-id, ett nattligt jobb som fyller den, och läsdörrar som räknar elevnivån
-- ur de markeringar som finns kvar.
--
-- ## Definitionen, en enda
--
-- Minuter räknas som /admin/reports och Frånvarobevakningen
-- (app.absence_watch_evaluate, 20261231090100) räknar dem, rad för rad:
--
--   PRESENT   närvaro
--   EXCUSED   giltig frånvaro
--   ABSENT    ogiltig frånvaro
--   LATE      ogiltig frånvaro med 15 minuter, högst lektionens längd; sen
--             ankomst är dessutom ett eget antal
--   UNKNOWN   räknas ingenstans
--
-- och bara lektioner som hålls (status SCHEDULED eller COMPLETED): en inställd
-- lektion är aldrig frånvaro, vad som än sparats på den, och en
-- ersättningslektion (Schemabrytande aktivitet) är en lektion som alla andra.
-- Andelen är frånvaron av de registrerade minuterna, som i Frånvarobevakningen.
-- Skillnaden mot den är vilka elever som räknas: bevakningen ser den som är
-- aktiv nu, statistiken ser också den som slutat, eftersom en elev som lämnat
-- skolan hör till hur hösten för två år sedan såg ut.
--
-- Rapporteringsgraden är D2:s, med ETT villkor ändrat: lektionerna kommer ur
-- app.absence_stats_lessons, som är app.reporting_lessons (20270112090100),
-- definitionen av en hållen lektion med lärare på sig och av en rapporterad,
-- en gång per lektion (den har en rad per lärare), utom i en enda sak. D2
-- frågar vem som arbetar NU (Users.isActive), vilket är rätt för "vad ska
-- läraren rapportera", men fel för en månad för två år sedan: en lärare som
-- har slutat tappade då alla sina lektioner ur historiken, och en månad som
-- en gång är lagrad räknas aldrig om (planen frågar bara efter månader utan
-- rad, och när markeringarna har gallrats går den inte att räkna om alls).
-- Här gäller det som gällde lektionsdagen: läraren räknas om hen inte hade
-- slutat när lektionen var slut (Users.deactivatedAt är null, eller senare än
-- lektionens slut). D2:s egen funktion är orörd, och dess lärarlista likaså.
--
-- Funktionerna är två texter för samma definition, så de binds ihop: en test
-- (src/absence-stats/absence-stats-definition.spec.ts) och ett avsnitt i
-- rls-owner-checks.sql (392o) fäller om app.absence_stats_lessons skiljer sig
-- från den senaste app.reporting_lessons på något annat än den raden. Skriver
-- en senare fas om app.reporting_lessons (Elevens lektion för dagen, 20270122,
-- lägger ett villkor om en elev som flyttats från lektionen) fäller de båda
-- tills app.absence_stats_lessons bär samma ändring: rapporteringsgraden i
-- historiken ska vara den som Rapporteringsgraden visar för samma månad.
--
-- En lektion räknas för klassen den ligger på, för en halvklass för dess klass,
-- och för en klass den delar med en annan; en undervisningsgrupp över
-- klassgränser räknas för skolan och ingen klass.
--
-- ## Vilken klass en elev hörde till
--
-- Den klass eleven hade LEKTIONENS dag (StudentEnrollments, klasshistoriken),
-- aldrig dagens klasslista: läsårsaktiveringen flyttar varje elev till nästa
-- års klass och tömmer förra årets, så en läsning av dagens lista skulle ge
-- förra årets klasser noll elever. En klass som följer av en annan
-- (StudentGroups.predecessorId, 7A -> 8A -> 9A) läses som en följd: utvecklingen
-- över tre läsår är kullens.
--
-- ## BESLUT: vad som lagras, och vad som aldrig lagras
--
-- Närvaron gallras efter skolans beslut (RetentionDecisions, ATTENDANCE) och
-- AttendanceRecords är det enda som säger vilken elev som var borta. Därför:
--
--   * ELEVNIVÅN LAGRAS ALDRIG. Det som visas om en enskild elev räknas ur de
--     markeringar som finns kvar, och försvinner med dem. Ingen rad per elev,
--     inget elev-id i någon ny tabell, ingenting att gallra.
--   * AbsenceStatsMonths lagrar summor per klass och månad, och för hela
--     skolan, och ingenting annat: antal, minuter, lektioner. Den har ingen
--     kolumn som pekar på en person (inte ens en främmande nyckel till Users),
--     och en test fäller en tabell som får en.
--   * MINSTA GRUPPSTORLEK 5. En klass med färre än fem elever lagras inte
--     alls (dess minuter finns bara i skolans summa), en månad där färre än
--     fem elever har en registrerad markering lagrar ingen minut (bara
--     lektionerna och rapporteringsgraden, som är lärarnas och inte elevernas),
--     och tabellen vägrar en rad som bryter mot det (CHECK). Siffran är en
--     funktion, app.absence_stats_min_group(), och patterns-dörren läser samma.
--   * SUMMORNA GALLRAS INTE MED NÄRVARON. Att nå tre år när närvaron sparas ett
--     är hela poängen, och en summa över minst fem elever är statistik, inte en
--     uppgift om en person. De tas i stället bort av jobbet när månaden ligger
--     före tredje läsårets början, och med skolan eller klassen (CASCADE).
--     Ingen ny RetentionDataType, och app.gallring_due och app.gallring_purge
--     rörs inte: en test fäller om någon gallringsgren pekar på tabellen.
--   * Skolan kan inte stänga av summeringen: den är inte en uppgift om en elev.
--     Det sägs i DEPLOYMENT.md och i manualen, eftersom den sparar något längre
--     än närvaron, och en skola som beslutat gallra närvaron efter en månad
--     får fortfarande tre läsårs summor.
--
-- ## Vem läser vad
--
-- Tabellen har ingen läsarm för någon roll: alla läsningar går genom
-- funktionerna nedan, som läser identiteten ur anroparens claims. Gatewayen
-- loggar vad som namnger en elev.
--
--   administratören           hela skolan, varje klass och varje elev, alla
--                             profiler (läsningen är varje profils, som
--                             närvaron i /admin/reports)
--   en mentor                 sina egna mentorselever och de klasser de är
--                             mentorer för, med samma definition som
--                             Frånvarobevakningen (app.absence_watch_mentees /
--                             app.absence_watch_is_mentor_of), idag
--   huvudmannens läsare       skolans summor och varje klass summor, aldrig en
--                             elev: läsaren har inget användar-id, och varje
--                             dörr som namnger en elev vägrar den (AS403)
--   övriga lärare, elever, vårdnadshavare, anon  ingenting
--
-- SKYDDAD IDENTITET: en markerad elev finns inte i någon lista som namnger
-- elever (klassens elevlista utelämnar den; en mentor ser inte ens att någon
-- saknas) och en enskild elevs statistik öppnas för en markerad elev bara av
-- en administratör; utskriften är webbens och håller ut den (web/lib/people-files.ts).
-- Summorna räknar eleven med: en klass summa namnger ingen.
--
-- ## Gallringsskyddet för summorna
--
-- En månad räknas bara om medan alla dess markeringar finns kvar: har skolan
-- någon gång beslutat gallra närvaron räknas bara månader från den kortaste
-- gallringstid den någonsin valt (som app.reporting_compute), också sedan den
-- bytt till att bevara. En månad vars markeringar kan ha gallrats skrivs aldrig
-- över med en summa som bara är resten.
--
-- ## Vid sidan av det API som körs
--
-- Produktionen kör migreringen medan API:et före den betjänar förfrågningar.
-- Ingen befintlig tabell får en kolumn; den nya nyckeln till StudentGroups och
-- Schools tar SHARE ROW EXCLUSIVE, som blockerar skrivningar (inte läsningar
-- och inte den KEY SHARE en främmande nyckels kontroll tar) så länge filen går.
-- En förfrågan skriver Schools och StudentGroups i samma transaktion, så låsen
-- tas tillsammans, NOWAIT, i en loop: en vägran rullar tillbaka delbehandlingen
-- med vad den fått och försöker igen 50 ms senare, och den väntar aldrig med
-- ett lås i handen. Efter 30 s stannar den med ingenting gjort och kan köras om
-- (prisma migrate resolve --rolled-back, sedan deploy). Det gamla API:et känner
-- inte tabellen eller funktionerna.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Schools" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "StudentGroups" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Schools and StudentGroups were not free at once in 30 s: nothing is changed. Prisma now holds this migration as failed, so run "prisma migrate resolve --rolled-back 20270121090000_franvaron_over_tre_lasar_lagras_per_klass_och_manad_aldrig_per_elev" and then "prisma migrate deploy" again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- AbsenceStatsMonths
-- ---------------------------------------------------------------------------

CREATE TABLE "AbsenceStatsMonths" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    -- Klassen; null är hela skolan.
    "studentGroupId" UUID,
    -- Månadens första dag, i skolans datum.
    "month" DATE NOT NULL,
    -- Sista dagen som är med: månadens sista, eller i går för den pågående.
    "throughDay" DATE NOT NULL,
    -- Gruppens storlek: eleverna som hörde till klassen någon dag i månaden
    -- (skolan: alla som hörde till en klass eller hade en markering). Minst fem.
    "pupils" INTEGER NOT NULL,
    -- Av dem, eleverna med minst en registrerad markering den månaden.
    "pupilsRegistered" INTEGER NOT NULL,
    -- Minuterna, null när färre än fem elever har en markering: då visas ingen
    -- siffra och ingen lagras.
    "recordedMinutes" INTEGER,
    "validMinutes" INTEGER,
    "absentMinutes" INTEGER,
    "lateMinutes" INTEGER,
    "lateCount" INTEGER,
    -- Rapporteringsgraden: hållna lektioner med lärare på sig, och hur många av
    -- dem som har ett sparat register (app.absence_stats_lessons, D2:s definition), en gång per lektion.
    "lessonsHeld" INTEGER NOT NULL,
    "lessonsReported" INTEGER NOT NULL,
    "computedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "AbsenceStatsMonths_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AbsenceStatsMonths_a_month_is_its_first_day" CHECK ("month" = date_trunc('month', "month"::timestamp)::date),
    CONSTRAINT "AbsenceStatsMonths_a_through_day_is_in_the_month"
        CHECK ("throughDay" >= "month" AND "throughDay" < ("month" + interval '1 month')::date),
    -- MINSTA GRUPPSTORLEK: samma tal som app.absence_stats_min_group().
    CONSTRAINT "AbsenceStatsMonths_a_group_has_five_pupils" CHECK ("pupils" >= 5),
    CONSTRAINT "AbsenceStatsMonths_counts_are_counts" CHECK (
        "pupilsRegistered" >= 0 AND "pupilsRegistered" <= "pupils"
        AND "lessonsHeld" >= 0 AND "lessonsReported" >= 0 AND "lessonsReported" <= "lessonsHeld"),
    -- En siffra över färre än fem elever lagras inte: alla minuter finns, eller ingen.
    CONSTRAINT "AbsenceStatsMonths_a_figure_has_five_pupils_behind_it" CHECK (
        ("pupilsRegistered" >= 5
         AND "recordedMinutes" IS NOT NULL AND "validMinutes" IS NOT NULL AND "absentMinutes" IS NOT NULL
         AND "lateMinutes" IS NOT NULL AND "lateCount" IS NOT NULL
         AND "validMinutes" >= 0 AND "absentMinutes" >= 0 AND "lateMinutes" >= 0 AND "lateCount" >= 0
         AND "validMinutes" + "absentMinutes" + "lateMinutes" <= "recordedMinutes")
        OR ("pupilsRegistered" < 5
         AND "recordedMinutes" IS NULL AND "validMinutes" IS NULL AND "absentMinutes" IS NULL
         AND "lateMinutes" IS NULL AND "lateCount" IS NULL))
);

-- En rad per klass och månad, och en per skola och månad (null är inte lika med
-- null i en vanlig unik nyckel, så de är två): det ON CONFLICT i
-- app.absence_stats_month pekar på.
CREATE UNIQUE INDEX "AbsenceStatsMonths_class_month_key"
    ON "AbsenceStatsMonths"("schoolId", "studentGroupId", "month") WHERE "studentGroupId" IS NOT NULL;
CREATE UNIQUE INDEX "AbsenceStatsMonths_school_month_key"
    ON "AbsenceStatsMonths"("schoolId", "month") WHERE "studentGroupId" IS NULL;
-- Den främmande nyckelns index: en klass som tas bort letar efter sina rader.
CREATE INDEX "AbsenceStatsMonths_studentGroupId_schoolId_idx" ON "AbsenceStatsMonths"("studentGroupId", "schoolId");

ALTER TABLE "AbsenceStatsMonths"
    ADD CONSTRAINT "AbsenceStatsMonths_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Sammansatt, som varje nyckel mellan skolbundna tabeller (20270115090000): en
-- klass i en annan skola kan inte få en rad här. En klass som tas bort tar sin
-- historik med sig; skolans summa finns kvar.
ALTER TABLE "AbsenceStatsMonths"
    ADD CONSTRAINT "AbsenceStatsMonths_studentGroupId_schoolId_fkey" FOREIGN KEY ("studentGroupId", "schoolId")
    REFERENCES "StudentGroups"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- Siffrorna som delas
-- ---------------------------------------------------------------------------

-- Den minsta gruppen under vilken en siffra inte lagras eller visas. En
-- funktion och inte en konstant i varje funktion, så att det finns ett ställe
-- att ändra på, och en CHECK ovan som en test jämför med den.
CREATE FUNCTION app.absence_stats_min_group() RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT 5 $$;

-- Månaden fönstret börjar i: första dagen i det äldsta av skolans tre senaste
-- läsår (startDate högst p_on). Null när skolan inget läsår har.
CREATE FUNCTION app.absence_stats_window_first(p_school uuid, p_on date) RETURNS date
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT date_trunc('month', min(y."startDate")::timestamp)::date
    FROM (SELECT a."startDate" FROM "AcademicYears" a
           WHERE a."schoolId" = p_school AND a."startDate" <= p_on
           ORDER BY a."startDate" DESC LIMIT 3) y
$$;

-- Fönstret som anroparens skola har, för sidorna: första månaden, skolans dag
-- idag och läsåret som rymmer idag (det senast påbörjade, det aktiva före ett
-- inaktivt). Ingen elev berörs, men bara en administratör eller en lärare frågar.
CREATE FUNCTION app.absence_stats_window()
RETURNS TABLE (first_month date, today date, year_name text, year_start date, year_end date)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
#variable_conflict use_column
DECLARE
  sid uuid := app.current_school_id();
  who "UserRole" := app.current_user_role();
  t date := app.school_today();
BEGIN
  IF sid IS NULL OR who IS NULL OR who NOT IN ('SCHOOL_ADMIN', 'TEACHER') THEN
    RAISE EXCEPTION 'ABSENCE_STATS_NOT_YOURS' USING ERRCODE = 'AS403';
  END IF;
  RETURN QUERY
  SELECT coalesce(app.absence_stats_window_first(sid, t), date_trunc('month', t - interval '36 months')::date),
         t, y."name"::text, y."startDate", y."endDate"
    FROM (SELECT 1) one
    LEFT JOIN LATERAL (
           SELECT a."name", a."startDate", a."endDate" FROM "AcademicYears" a
            WHERE a."schoolId" = sid AND a."startDate" <= t
            ORDER BY (a."endDate" >= t) DESC, a."isActive" DESC, a."startDate" DESC, a."id"
            LIMIT 1) y ON true;
END
$$;

-- ---------------------------------------------------------------------------
-- Jobbets funktioner
-- ---------------------------------------------------------------------------

-- Månaderna som ska räknas denna natt, i skolans datum: de som ligger inom de
-- senaste 62 dagarna (ett register kan sparas dagar efter lektionen) och högst
-- p_backfill äldre månader som saknar en rad, de nyaste först. Bara månader
-- vars alla markeringar kan finnas kvar (se gallringsskyddet i huvudet).
-- En äldre månad efterfrågas bara om den har en hållen lektion och minst fem
-- elever som hörde till en klass i den: en månad utan lektioner (sommaren) eller
-- utan elever på listan (mellan två läsår, när aktiveringen stängt förra årets
-- klasser och inte öppnat nästa) får ingen rad och ska inte räknas om varje natt,
-- och får inte ta platserna från månaderna som har något att räkna.
CREATE FUNCTION app.absence_stats_plan(p_school uuid, p_as_of date, p_backfill integer DEFAULT 3)
RETURNS TABLE ("month" date)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
#variable_conflict use_column
DECLARE
  tz text;
  today date;
  shortest integer;
  cut date;
  first_month date;
  recent_first date;
BEGIN
  SELECT s."timezone" INTO tz FROM "Schools" s WHERE s."id" = p_school;
  IF tz IS NULL THEN
    RAISE EXCEPTION 'ABSENCE_STATS_NO_SCHOOL' USING ERRCODE = 'AS404';
  END IF;
  today := (clock_timestamp() AT TIME ZONE tz)::date;
  IF p_as_of IS NULL OR p_as_of >= today THEN
    RAISE EXCEPTION 'ABSENCE_STATS_DAY_IS_NOT_OVER: statistiken räknar till och med en dag som gått'
      USING ERRCODE = 'AS400';
  END IF;
  SELECT min(d."months") INTO shortest FROM "RetentionDecisions" d
   WHERE d."schoolId" = p_school AND d."dataType" = 'ATTENDANCE' AND d."decision" = 'PURGE_AFTER';
  cut := app.retention_cutoff(p_school, shortest, clock_timestamp());
  first_month := coalesce(app.absence_stats_window_first(p_school, p_as_of),
                          date_trunc('month', p_as_of - interval '36 months')::date);
  recent_first := greatest(first_month, date_trunc('month', (p_as_of - 61)::timestamp)::date);
  RETURN QUERY
  WITH months AS (
    SELECT g.m::date AS m
      FROM generate_series(first_month::timestamp, date_trunc('month', p_as_of::timestamp), interval '1 month') g(m)
     WHERE cut IS NULL OR g.m::date >= cut
  ),
  missing AS (
    SELECT x.m FROM months x
     WHERE x.m < recent_first
       AND NOT EXISTS (SELECT 1 FROM "AbsenceStatsMonths" s
                        WHERE s."schoolId" = p_school AND s."studentGroupId" IS NULL AND s."month" = x.m)
       AND EXISTS (SELECT 1 FROM "CalendarLessons" cl
                    WHERE cl."schoolId" = p_school AND cl."date" >= x.m AND cl."date" < (x.m + interval '1 month')::date
                      AND cl."status" IN ('SCHEDULED', 'COMPLETED'))
       AND (SELECT count(*) FROM (SELECT DISTINCT e."studentId" FROM "StudentEnrollments" e
                                   WHERE e."schoolId" = p_school AND e."validFrom" < (x.m + interval '1 month')::date
                                     AND (e."validTo" IS NULL OR e."validTo" > x.m)
                                   LIMIT app.absence_stats_min_group()) q) >= app.absence_stats_min_group()
     ORDER BY x.m DESC
     LIMIT greatest(p_backfill, 0)
  ),
  chosen AS (
    SELECT x.m, 0 AS pass FROM months x WHERE x.m >= recent_first
    UNION ALL
    SELECT y.m, 1 FROM missing y
  )
  SELECT c.m FROM chosen c ORDER BY c.pass, c.m DESC;
END
$$;

-- De hållna lektionerna med lärare på sig och om de är rapporterade, för en
-- månad som kan ligga flera år tillbaka: app.reporting_lessons (20270112090100)
-- med EN ändrad rad. D2:s funktion svarar på "vilka lektioner ska en lärare som
-- arbetar nu rapportera" och kräver att läraren är aktiv nu; historiken frågar
-- vilka lektioner som hölls, och en lärare som har slutat höll dem. Läraren
-- räknas därför om hen inte hade slutat när lektionen var slut:
--
--     AND u."role" = 'TEACHER' AND u."isActive"                               (D2)
--     AND u."role" = 'TEACHER' AND (u."deactivatedAt" IS NULL OR cl."endsAt" <= u."deactivatedAt")
--
-- (Users_deactivation_is_dated: isActive är det samma som deactivatedAt IS NULL.
-- En lektion efter att läraren slutat har ingen som rapporterar den och räknas
-- inte, som i D2.) Resten är D2:s ord för ord, också elevlistans villkor, så att
-- en lektion utan lista inte kräver ett register; skriver en senare release om
-- app.reporting_lessons ska den här bära samma ändring (se huvudet).
--
-- Inte SECURITY DEFINER och utan SET, som D2:s, och med samma skäl: den ska kunna
-- läsas in i anroparen, och varje namn är schemakvalificerat eftersom en
-- inlinad kropp kör med anroparens search_path. Ägarens ensam; anropas bara av
-- app.absence_stats_month. Inga kommentarer i kroppen, så att den går att jämföra
-- med D2:s (proven klipper kommentarer och blanksteg; prod-efter jämför tecken
-- för tecken).
CREATE FUNCTION app.absence_stats_lessons(p_school uuid, p_from date, p_to date, p_now timestamptz)
RETURNS TABLE (lesson_id uuid, teacher_id uuid, day date,
               starts_at timestamptz, ends_at timestamptz, reported boolean)
LANGUAGE sql STABLE AS $$
  SELECT cl."id", t."teacherId", cl."date", cl."startsAt", cl."endsAt", r."saved"
    FROM "public"."CalendarLessons" cl
    JOIN "public"."CalendarLessonTeachers" t
      ON t."calendarLessonId" = cl."id" AND t."schoolId" = cl."schoolId"
    JOIN "public"."Users" u
      ON u."id" = t."teacherId" AND u."schoolId" = cl."schoolId"
     AND u."role" = 'TEACHER' AND (u."deactivatedAt" IS NULL OR cl."endsAt" <= u."deactivatedAt")
   CROSS JOIN LATERAL (
           SELECT EXISTS (SELECT 1 FROM "public"."AttendanceRecords" a
                           WHERE a."calendarLessonId" = t."calendarLessonId" AND a."status" <> 'UNKNOWN') AS "saved") r
   WHERE cl."schoolId" = p_school
     AND cl."date" BETWEEN p_from AND p_to
     AND cl."status" IN ('SCHEDULED', 'COMPLETED')
     AND cl."endsAt" <= p_now
     AND (
           r."saved"
        OR EXISTS (SELECT 1 FROM "public"."Users" p
                    WHERE p."studentGroupId" = cl."studentGroupId" AND p."role" = 'STUDENT' AND p."isActive")
        OR EXISTS (SELECT 1 FROM "public"."StudentEnrollments" e
                    WHERE e."studentGroupId" = cl."studentGroupId"
                      AND e."validFrom" <= cl."date" AND (e."validTo" IS NULL OR cl."date" < e."validTo"))
        OR EXISTS (SELECT 1 FROM "public"."StudentGroupMembers" m
                    JOIN "public"."Users" p ON p."id" = m."studentId"
                   WHERE m."studentGroupId" = cl."studentGroupId" AND p."role" = 'STUDENT')
        OR EXISTS (SELECT 1 FROM "public"."CalendarLessonGroups" x
                    JOIN "public"."Users" p ON p."studentGroupId" = x."studentGroupId"
                   WHERE x."calendarLessonId" = cl."id" AND p."role" = 'STUDENT' AND p."isActive")
        OR EXISTS (SELECT 1 FROM "public"."CalendarLessonGroups" x
                    JOIN "public"."StudentEnrollments" e ON e."studentGroupId" = x."studentGroupId"
                   WHERE x."calendarLessonId" = cl."id"
                     AND e."validFrom" <= cl."date" AND (e."validTo" IS NULL OR cl."date" < e."validTo"))
        OR EXISTS (SELECT 1 FROM "public"."CalendarLessonGroups" x
                    JOIN "public"."StudentGroupMembers" m ON m."studentGroupId" = x."studentGroupId"
                    JOIN "public"."Users" p ON p."id" = m."studentId"
                   WHERE x."calendarLessonId" = cl."id" AND p."role" = 'STUDENT')
        OR EXISTS (SELECT 1 FROM "public"."CalendarLessonStudents" n
                    JOIN "public"."Users" p ON p."id" = n."studentId"
                   WHERE n."calendarLessonId" = cl."id" AND p."role" = 'STUDENT')
         )
     AND NOT EXISTS (
           SELECT 1 FROM "public"."TeacherAbsences" ab
            WHERE ab."schoolId" = cl."schoolId" AND ab."userId" = t."teacherId"
              AND ab."status" = 'ACTIVE'
              AND ab."startsAt" < cl."endsAt" AND cl."startsAt" < ab."endsAt")
$$;

-- Räknar om en månad för skolan: en rad för skolan och en för varje klass med
-- minst fem elever, och tar bort de rader månaden inte längre har skäl till.
-- Räknar bara en månad vars markeringar kan finnas kvar; annars rör den ingenting.
-- Svarar hur många rader den skrev (ändrade eller nya), tog bort, och hur många
-- klasser månaden fick. Serialiserad per skola.
CREATE FUNCTION app.absence_stats_month(p_school uuid, p_month date, p_as_of date)
RETURNS TABLE (written integer, removed integer, classes integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" SET jit = off AS $$
#variable_conflict use_column
DECLARE
  tz text;
  today date;
  shortest integer;
  cut date;
  m_first date := p_month;
  m_next date := (p_month + interval '1 month')::date;
  m_last date;
  k constant integer := app.absence_stats_min_group();
  n_written integer;
  n_removed integer;
  n_classes integer;
BEGIN
  SELECT s."timezone" INTO tz FROM "Schools" s WHERE s."id" = p_school;
  IF tz IS NULL THEN
    RAISE EXCEPTION 'ABSENCE_STATS_NO_SCHOOL' USING ERRCODE = 'AS404';
  END IF;
  today := (clock_timestamp() AT TIME ZONE tz)::date;
  IF p_as_of IS NULL OR p_as_of >= today THEN
    RAISE EXCEPTION 'ABSENCE_STATS_DAY_IS_NOT_OVER: statistiken räknar till och med en dag som gått'
      USING ERRCODE = 'AS400';
  END IF;
  IF p_month IS NULL OR p_month <> date_trunc('month', p_month::timestamp)::date OR p_month > p_as_of THEN
    RAISE EXCEPTION 'ABSENCE_STATS_BAD_MONTH: en månad är dess första dag, och inte efter dagen som räknas till'
      USING ERRCODE = 'AS400';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('absence-stats:' || p_school::text, 0));

  -- Gallringsskyddet: en månad före den kortaste gallringstid skolan någonsin
  -- valt kan ha tappat markeringar, och räknad igen blir den en månad ingen rapporterade.
  SELECT min(d."months") INTO shortest FROM "RetentionDecisions" d
   WHERE d."schoolId" = p_school AND d."dataType" = 'ATTENDANCE' AND d."decision" = 'PURGE_AFTER';
  cut := app.retention_cutoff(p_school, shortest, clock_timestamp());
  IF cut IS NOT NULL AND m_first < cut THEN
    RETURN QUERY SELECT 0, 0, 0;
    RETURN;
  END IF;
  m_last := least(m_next - 1, p_as_of);

  WITH lessons AS MATERIALIZED (
    SELECT cl."id", cl."date" AS day,
           round(extract(epoch FROM (cl."endsAt" - cl."startsAt")) / 60)::integer AS mins
      FROM "CalendarLessons" cl
     WHERE cl."schoolId" = p_school AND cl."date" BETWEEN m_first AND m_last
       AND cl."status" IN ('SCHEDULED', 'COMPLETED')
  ),
  -- Per elev och dag: minuterna av varje slag, så att markeringarna (en skola
  -- med 2 000 elever har drygt 200 000 en månad) läses en gång.
  daily AS MATERIALIZED (
    SELECT a."studentId" AS student, l.day,
           sum(l.mins)::integer AS recorded,
           sum(CASE WHEN a."status" = 'EXCUSED' THEN l.mins ELSE 0 END)::integer AS valid_mins,
           sum(CASE WHEN a."status" = 'ABSENT' THEN l.mins ELSE 0 END)::integer AS absent_mins,
           sum(CASE WHEN a."status" = 'LATE' THEN least(15, l.mins) ELSE 0 END)::integer AS late_mins,
           (count(*) FILTER (WHERE a."status" = 'LATE'))::integer AS late_n
      FROM lessons l
      JOIN "AttendanceRecords" a ON a."calendarLessonId" = l."id" AND a."schoolId" = p_school
     WHERE a."status" <> 'UNKNOWN'
     GROUP BY a."studentId", l.day
  ),
  -- Klassen eleven hade den dagen: segmentet som täcker datumet, aldrig dagens klasslista.
  with_class AS MATERIALIZED (
    SELECT d.*, c.grp
      FROM daily d
      LEFT JOIN LATERAL (
            SELECT e."studentGroupId" AS grp FROM "StudentEnrollments" e
             WHERE e."studentId" = d.student AND e."schoolId" = p_school
               AND e."validFrom" <= d.day AND (e."validTo" IS NULL OR d.day < e."validTo")
             ORDER BY e."validFrom" DESC LIMIT 1) c ON true
  ),
  enrolled AS (
    SELECT e."studentGroupId" AS grp, count(DISTINCT e."studentId")::integer AS n
      FROM "StudentEnrollments" e
     WHERE e."schoolId" = p_school AND e."studentGroupId" IS NOT NULL
       AND e."validFrom" < m_next AND (e."validTo" IS NULL OR e."validTo" > m_first)
     GROUP BY e."studentGroupId"
  ),
  class_marks AS (
    SELECT w.grp, count(DISTINCT w.student)::integer AS registered,
           sum(w.recorded)::integer AS recorded, sum(w.valid_mins)::integer AS valid_mins,
           sum(w.absent_mins)::integer AS absent_mins, sum(w.late_mins)::integer AS late_mins,
           sum(w.late_n)::integer AS late_n
      FROM with_class w WHERE w.grp IS NOT NULL
     GROUP BY w.grp
  ),
  -- Lektionerna är D2:s (utom att en lärare som slutat räknas för lektionerna som hölls), en gång per lektion.
  rl AS MATERIALIZED (
    SELECT DISTINCT ON (r.lesson_id) r.lesson_id, r.reported
      FROM app.absence_stats_lessons(p_school, m_first, m_last, clock_timestamp()) r
     ORDER BY r.lesson_id
  ),
  -- Lektionens klasser: dess egen grupp och de extra grupperna, slagna upp med sin nyckel (inte en genomläsning av
  -- skolans alla grupper för varje lektion), en halvklass som sin klass, en gång per lektion och klass.
  lesson_classes AS (
    SELECT DISTINCT rl.lesson_id, rl.reported, coalesce(g."halfOfId", g."id") AS cid
      FROM rl
      JOIN "CalendarLessons" cl ON cl."id" = rl.lesson_id
     CROSS JOIN LATERAL (
           SELECT cl."studentGroupId" AS gid
           UNION
           SELECT x."studentGroupId" FROM "CalendarLessonGroups" x WHERE x."calendarLessonId" = cl."id") ids
      JOIN "StudentGroups" g ON g."id" = ids.gid AND g."schoolId" = p_school
                            AND (g."kind" = 'CLASS' OR g."halfOfId" IS NOT NULL)
  ),
  class_lessons AS (
    SELECT lc.cid, count(*)::integer AS held, (count(*) FILTER (WHERE lc.reported))::integer AS reported
      FROM lesson_classes lc GROUP BY lc.cid
  ),
  class_rows AS (
    SELECT en.grp AS class_id, en.n AS pupils,
           coalesce(cm.registered, 0) AS registered,
           CASE WHEN coalesce(cm.registered, 0) >= k THEN cm.recorded END AS recorded,
           CASE WHEN coalesce(cm.registered, 0) >= k THEN cm.valid_mins END AS valid_mins,
           CASE WHEN coalesce(cm.registered, 0) >= k THEN cm.absent_mins END AS absent_mins,
           CASE WHEN coalesce(cm.registered, 0) >= k THEN cm.late_mins END AS late_mins,
           CASE WHEN coalesce(cm.registered, 0) >= k THEN cm.late_n END AS late_n,
           coalesce(cl.held, 0) AS held, coalesce(cl.reported, 0) AS reported
      FROM enrolled en
      LEFT JOIN class_marks cm ON cm.grp = en.grp
      LEFT JOIN class_lessons cl ON cl.cid = en.grp
     WHERE en.n >= k AND (coalesce(cm.registered, 0) > 0 OR coalesce(cl.held, 0) > 0)
  ),
  school_pupils AS (
    SELECT count(*)::integer AS n FROM (
      SELECT d.student FROM daily d
      UNION
      SELECT e."studentId" FROM "StudentEnrollments" e
       WHERE e."schoolId" = p_school AND e."validFrom" < m_next AND (e."validTo" IS NULL OR e."validTo" > m_first)) u
  ),
  school_row AS (
    SELECT sp.n AS pupils,
           (SELECT count(DISTINCT d.student) FROM daily d)::integer AS registered,
           (SELECT sum(d.recorded) FROM daily d)::integer AS recorded,
           (SELECT sum(d.valid_mins) FROM daily d)::integer AS valid_mins,
           (SELECT sum(d.absent_mins) FROM daily d)::integer AS absent_mins,
           (SELECT sum(d.late_mins) FROM daily d)::integer AS late_mins,
           (SELECT sum(d.late_n) FROM daily d)::integer AS late_n,
           (SELECT count(*) FROM rl)::integer AS held,
           (SELECT count(*) FROM rl WHERE rl.reported)::integer AS reported
      FROM school_pupils sp
  ),
  up_class AS (
    INSERT INTO "AbsenceStatsMonths" ("schoolId", "studentGroupId", "month", "throughDay", "pupils", "pupilsRegistered",
                                      "recordedMinutes", "validMinutes", "absentMinutes", "lateMinutes", "lateCount",
                                      "lessonsHeld", "lessonsReported")
    SELECT p_school, c.class_id, m_first, m_last, c.pupils, c.registered,
           c.recorded, c.valid_mins, c.absent_mins, c.late_mins, c.late_n, c.held, c.reported
      FROM class_rows c
    ON CONFLICT ("schoolId", "studentGroupId", "month") WHERE "studentGroupId" IS NOT NULL DO UPDATE
       SET "throughDay" = EXCLUDED."throughDay", "pupils" = EXCLUDED."pupils", "pupilsRegistered" = EXCLUDED."pupilsRegistered",
           "recordedMinutes" = EXCLUDED."recordedMinutes", "validMinutes" = EXCLUDED."validMinutes",
           "absentMinutes" = EXCLUDED."absentMinutes", "lateMinutes" = EXCLUDED."lateMinutes", "lateCount" = EXCLUDED."lateCount",
           "lessonsHeld" = EXCLUDED."lessonsHeld", "lessonsReported" = EXCLUDED."lessonsReported", "computedAt" = clock_timestamp()
     WHERE ("AbsenceStatsMonths"."throughDay", "AbsenceStatsMonths"."pupils", "AbsenceStatsMonths"."pupilsRegistered",
            "AbsenceStatsMonths"."recordedMinutes", "AbsenceStatsMonths"."validMinutes", "AbsenceStatsMonths"."absentMinutes",
            "AbsenceStatsMonths"."lateMinutes", "AbsenceStatsMonths"."lateCount",
            "AbsenceStatsMonths"."lessonsHeld", "AbsenceStatsMonths"."lessonsReported")
           IS DISTINCT FROM
           (EXCLUDED."throughDay", EXCLUDED."pupils", EXCLUDED."pupilsRegistered",
            EXCLUDED."recordedMinutes", EXCLUDED."validMinutes", EXCLUDED."absentMinutes",
            EXCLUDED."lateMinutes", EXCLUDED."lateCount", EXCLUDED."lessonsHeld", EXCLUDED."lessonsReported")
    RETURNING 1
  ),
  up_school AS (
    INSERT INTO "AbsenceStatsMonths" ("schoolId", "studentGroupId", "month", "throughDay", "pupils", "pupilsRegistered",
                                      "recordedMinutes", "validMinutes", "absentMinutes", "lateMinutes", "lateCount",
                                      "lessonsHeld", "lessonsReported")
    SELECT p_school, NULL, m_first, m_last, s.pupils, s.registered,
           CASE WHEN s.registered >= k THEN coalesce(s.recorded, 0) END,
           CASE WHEN s.registered >= k THEN coalesce(s.valid_mins, 0) END,
           CASE WHEN s.registered >= k THEN coalesce(s.absent_mins, 0) END,
           CASE WHEN s.registered >= k THEN coalesce(s.late_mins, 0) END,
           CASE WHEN s.registered >= k THEN coalesce(s.late_n, 0) END,
           s.held, s.reported
      FROM school_row s
     WHERE s.pupils >= k
    ON CONFLICT ("schoolId", "month") WHERE "studentGroupId" IS NULL DO UPDATE
       SET "throughDay" = EXCLUDED."throughDay", "pupils" = EXCLUDED."pupils", "pupilsRegistered" = EXCLUDED."pupilsRegistered",
           "recordedMinutes" = EXCLUDED."recordedMinutes", "validMinutes" = EXCLUDED."validMinutes",
           "absentMinutes" = EXCLUDED."absentMinutes", "lateMinutes" = EXCLUDED."lateMinutes", "lateCount" = EXCLUDED."lateCount",
           "lessonsHeld" = EXCLUDED."lessonsHeld", "lessonsReported" = EXCLUDED."lessonsReported", "computedAt" = clock_timestamp()
     WHERE ("AbsenceStatsMonths"."throughDay", "AbsenceStatsMonths"."pupils", "AbsenceStatsMonths"."pupilsRegistered",
            "AbsenceStatsMonths"."recordedMinutes", "AbsenceStatsMonths"."validMinutes", "AbsenceStatsMonths"."absentMinutes",
            "AbsenceStatsMonths"."lateMinutes", "AbsenceStatsMonths"."lateCount",
            "AbsenceStatsMonths"."lessonsHeld", "AbsenceStatsMonths"."lessonsReported")
           IS DISTINCT FROM
           (EXCLUDED."throughDay", EXCLUDED."pupils", EXCLUDED."pupilsRegistered",
            EXCLUDED."recordedMinutes", EXCLUDED."validMinutes", EXCLUDED."absentMinutes",
            EXCLUDED."lateMinutes", EXCLUDED."lateCount", EXCLUDED."lessonsHeld", EXCLUDED."lessonsReported")
    RETURNING 1
  ),
  gone AS (
    DELETE FROM "AbsenceStatsMonths" s
     WHERE s."schoolId" = p_school AND s."month" = m_first
       AND ((s."studentGroupId" IS NULL AND NOT EXISTS (SELECT 1 FROM school_row r WHERE r.pupils >= k))
            OR (s."studentGroupId" IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM class_rows c WHERE c.class_id = s."studentGroupId")))
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM up_class)::integer + (SELECT count(*) FROM up_school)::integer,
         (SELECT count(*) FROM gone)::integer,
         (SELECT count(*) FROM class_rows)::integer
    INTO n_written, n_removed, n_classes;

  RETURN QUERY SELECT n_written, n_removed, n_classes;
END
$$;

-- Tar bort månaderna före fönstret (de tre senaste läsårens början). Svarar
-- hur många rader det var. Serialiserad med räkningen.
CREATE FUNCTION app.absence_stats_trim(p_school uuid, p_as_of date) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  tz text;
  today date;
  first_month date;
  n integer;
BEGIN
  SELECT s."timezone" INTO tz FROM "Schools" s WHERE s."id" = p_school;
  IF tz IS NULL THEN
    RAISE EXCEPTION 'ABSENCE_STATS_NO_SCHOOL' USING ERRCODE = 'AS404';
  END IF;
  today := (clock_timestamp() AT TIME ZONE tz)::date;
  IF p_as_of IS NULL OR p_as_of >= today THEN
    RAISE EXCEPTION 'ABSENCE_STATS_DAY_IS_NOT_OVER: statistiken räknar till och med en dag som gått'
      USING ERRCODE = 'AS400';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('absence-stats:' || p_school::text, 0));
  first_month := coalesce(app.absence_stats_window_first(p_school, p_as_of),
                          date_trunc('month', p_as_of - interval '36 months')::date);
  DELETE FROM "AbsenceStatsMonths" s WHERE s."schoolId" = p_school AND s."month" < first_month;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

-- ---------------------------------------------------------------------------
-- Läsdörrarna
-- ---------------------------------------------------------------------------

-- Får anroparen läsa en enskild elev? En administratör med ett eget
-- användar-id, vilken profil som helst; en mentor för eleven idag (som
-- Frånvarobevakningen räknar), om eleven inte är markerad. Huvudmannens
-- läsare har inget användar-id och får aldrig en elev. Svarar inte: den
-- vägrar (AS403) eller tiger. Anropas bara av dörrarna nedan, som ägaren.
CREATE FUNCTION app.absence_stats_pupil_access(p_student uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  sid uuid := app.current_school_id();
  uid uuid := app.current_user_id();
  who "UserRole" := app.current_user_role();
  marked boolean;
BEGIN
  IF sid IS NULL OR who IS NULL THEN
    RAISE EXCEPTION 'ABSENCE_STATS_NOT_YOURS' USING ERRCODE = 'AS403';
  END IF;
  IF who = 'SCHOOL_ADMIN' THEN
    IF uid IS NULL THEN
      RAISE EXCEPTION 'ABSENCE_STATS_NO_PUPILS_FOR_THE_READER: huvudmannens läsare ser summor, aldrig en elev' USING ERRCODE = 'AS403';
    END IF;
  ELSIF who = 'TEACHER' THEN
    IF NOT app.absence_watch_is_mentor_of(p_student) THEN
      RAISE EXCEPTION 'ABSENCE_STATS_NOT_YOURS' USING ERRCODE = 'AS403';
    END IF;
    SELECT EXISTS (SELECT 1 FROM "PersonProtections" pp WHERE pp."userId" = p_student AND pp."schoolId" = sid) INTO marked;
    IF marked THEN
      RAISE EXCEPTION 'ABSENCE_STATS_NOT_YOURS' USING ERRCODE = 'AS403';
    END IF;
  ELSE
    RAISE EXCEPTION 'ABSENCE_STATS_NOT_YOURS' USING ERRCODE = 'AS403';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Users" u WHERE u."id" = p_student AND u."schoolId" = sid AND u."role" = 'STUDENT') THEN
    RAISE EXCEPTION 'ABSENCE_STATS_NO_SUCH_PUPIL' USING ERRCODE = 'AS404';
  END IF;
END
$$;

-- Får anroparen läsa en klass summor? En administratör (läsaren också), eller
-- en mentor för klassen idag: en klass där någon av mentorns mentorselever går
-- (app.absence_watch_mentees, Frånvarobevakningens definition).
CREATE FUNCTION app.absence_stats_class_access(p_class uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  sid uuid := app.current_school_id();
  uid uuid := app.current_user_id();
  who "UserRole" := app.current_user_role();
  today date := app.school_today();
BEGIN
  IF sid IS NULL OR who IS NULL OR p_class IS NULL THEN
    RAISE EXCEPTION 'ABSENCE_STATS_NOT_YOURS' USING ERRCODE = 'AS403';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "StudentGroups" g WHERE g."id" = p_class AND g."schoolId" = sid) THEN
    RAISE EXCEPTION 'ABSENCE_STATS_NO_SUCH_CLASS' USING ERRCODE = 'AS404';
  END IF;
  IF who = 'SCHOOL_ADMIN' THEN
    RETURN;
  END IF;
  IF who = 'TEACHER' AND EXISTS (
       SELECT 1
         FROM app.absence_watch_mentees(sid, today) mm
         JOIN "StudentEnrollments" e ON e."studentId" = mm.student_id AND e."schoolId" = sid
          AND e."validFrom" <= today AND (e."validTo" IS NULL OR today < e."validTo")
        WHERE mm.mentor_id = uid AND e."studentGroupId" = p_class) THEN
    RETURN;
  END IF;
  RAISE EXCEPTION 'ABSENCE_STATS_NOT_YOURS' USING ERRCODE = 'AS403';
END
$$;

-- Månadsraderna för skolan (p_class null, bara en administratör) eller en
-- klass och dess föregångare (p_class), de tre senaste läsåren, och bara
-- månader med en lektion eller en markering. Siffror som saknas är null: färre
-- än fem elever stod bakom dem.
CREATE FUNCTION app.absence_stats_series(p_class uuid DEFAULT NULL)
RETURNS TABLE ("month" date, through_day date, class_id uuid, class_name text, pupils integer, pupils_registered integer,
               recorded_minutes integer, valid_minutes integer, absent_minutes integer, late_minutes integer, late_count integer,
               lessons_held integer, lessons_reported integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" SET jit = off AS $$
#variable_conflict use_column
DECLARE
  sid uuid := app.current_school_id();
  who "UserRole" := app.current_user_role();
  today date := app.school_today();
  first_month date;
BEGIN
  IF p_class IS NULL THEN
    IF sid IS NULL OR who IS DISTINCT FROM 'SCHOOL_ADMIN' THEN
      RAISE EXCEPTION 'ABSENCE_STATS_NOT_YOURS' USING ERRCODE = 'AS403';
    END IF;
  ELSE
    PERFORM app.absence_stats_class_access(p_class);
  END IF;
  first_month := coalesce(app.absence_stats_window_first(sid, today), date_trunc('month', today - interval '36 months')::date);
  RETURN QUERY
  WITH RECURSIVE lineage AS (
    SELECT g."id", g."predecessorId", 1 AS depth
      FROM "StudentGroups" g WHERE g."id" = p_class AND g."schoolId" = sid
    UNION ALL
    SELECT g."id", g."predecessorId", l.depth + 1
      FROM lineage l JOIN "StudentGroups" g ON g."id" = l."predecessorId" AND g."schoolId" = sid
     WHERE l.depth < 4
  )
  SELECT s."month", s."throughDay", s."studentGroupId", g."name"::text, s."pupils", s."pupilsRegistered",
         s."recordedMinutes", s."validMinutes", s."absentMinutes", s."lateMinutes", s."lateCount",
         s."lessonsHeld", s."lessonsReported"
    FROM "AbsenceStatsMonths" s
    LEFT JOIN "StudentGroups" g ON g."id" = s."studentGroupId" AND g."schoolId" = s."schoolId"
   WHERE s."schoolId" = sid AND s."month" >= first_month
     AND (s."lessonsHeld" > 0 OR s."pupilsRegistered" > 0)
     AND ((p_class IS NULL AND s."studentGroupId" IS NULL)
          OR (p_class IS NOT NULL AND s."studentGroupId" IN (SELECT l.id FROM lineage l)))
   ORDER BY s."month", g."name" COLLATE "C";
END
$$;

-- Klasserna i en period (månaderna p_from..p_to hela), med summan av deras
-- månader: för en administratör (läsaren också) alla klasser med en rad, för
-- en mentor klasserna de är mentorer för och deras föregångare. Månader utan
-- siffra (färre än fem elever) räknas inte in, och months_counted säger hur
-- många som gjorde det.
CREATE FUNCTION app.absence_stats_classes(p_from date, p_to date)
RETURNS TABLE (class_id uuid, class_name text, year_name text, months_counted integer, pupils integer, pupils_registered integer,
               recorded_minutes double precision, valid_minutes double precision, absent_minutes double precision,
               late_minutes double precision, late_count double precision, lessons_held double precision, lessons_reported double precision)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" SET jit = off AS $$
#variable_conflict use_column
DECLARE
  sid uuid := app.current_school_id();
  uid uuid := app.current_user_id();
  who "UserRole" := app.current_user_role();
  today date := app.school_today();
  first_month date;
  from_month date := date_trunc('month', p_from::timestamp)::date;
  to_month date := date_trunc('month', p_to::timestamp)::date;
BEGIN
  IF sid IS NULL OR who IS NULL OR who NOT IN ('SCHOOL_ADMIN', 'TEACHER') THEN
    RAISE EXCEPTION 'ABSENCE_STATS_NOT_YOURS' USING ERRCODE = 'AS403';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 1200 THEN
    RAISE EXCEPTION 'ABSENCE_STATS_BAD_PERIOD: från före till, högst 1 200 dagar' USING ERRCODE = 'AS400';
  END IF;
  first_month := coalesce(app.absence_stats_window_first(sid, today), date_trunc('month', today - interval '36 months')::date);
  RETURN QUERY
  WITH RECURSIVE mine AS (
    SELECT DISTINCT e."studentGroupId" AS id
      FROM app.absence_watch_mentees(sid, today) mm
      JOIN "StudentEnrollments" e ON e."studentId" = mm.student_id AND e."schoolId" = sid
       AND e."validFrom" <= today AND (e."validTo" IS NULL OR today < e."validTo")
     WHERE who = 'TEACHER' AND mm.mentor_id = uid AND e."studentGroupId" IS NOT NULL
  ),
  lineage AS (
    SELECT g."id", g."predecessorId", 1 AS depth FROM "StudentGroups" g WHERE g."id" IN (SELECT m.id FROM mine m) AND g."schoolId" = sid
    UNION ALL
    SELECT g."id", g."predecessorId", l.depth + 1
      FROM lineage l JOIN "StudentGroups" g ON g."id" = l."predecessorId" AND g."schoolId" = sid
     WHERE l.depth < 4
  )
  SELECT s."studentGroupId", g."name"::text, y."name"::text,
         (count(*) FILTER (WHERE s."recordedMinutes" IS NOT NULL))::integer,
         max(s."pupils")::integer, max(s."pupilsRegistered")::integer,
         sum(s."recordedMinutes")::double precision, sum(s."validMinutes")::double precision,
         sum(s."absentMinutes")::double precision, sum(s."lateMinutes")::double precision,
         sum(s."lateCount")::double precision,
         sum(s."lessonsHeld")::double precision, sum(s."lessonsReported")::double precision
    FROM "AbsenceStatsMonths" s
    JOIN "StudentGroups" g ON g."id" = s."studentGroupId" AND g."schoolId" = s."schoolId"
    LEFT JOIN "AcademicYears" y ON y."id" = g."academicYearId" AND y."schoolId" = g."schoolId"
   WHERE s."schoolId" = sid AND s."studentGroupId" IS NOT NULL
     AND s."month" BETWEEN greatest(from_month, first_month) AND to_month
     AND (who = 'SCHOOL_ADMIN' OR s."studentGroupId" IN (SELECT l.id FROM lineage l))
   GROUP BY s."studentGroupId", g."name", y."name", y."startDate"
   ORDER BY y."startDate" DESC NULLS LAST, g."name" COLLATE "C";
END
$$;

-- Eleverna i en klass under en period med sina summor, för ett utvecklingssamtal:
-- de som hörde till klassen eller en föregångare någon dag i perioden
-- (StudentEnrollments, som månadsraderna och mönstren läser en klass), och deras
-- markeringar för DAGARNA de hörde dit, som klassens månadsrad och mönster räknar
-- dem (segmentet som täcker lektionens datum). Elevernas summor blir därmed
-- klassens summa: en elev som bytte klass mitt i en månad räknas i den gamla
-- klassen till bytet och i den nya efter det, och mentorn ser inte frånvaron
-- under dagar eleven hörde till en annan klass och en annan mentor. (Elevens
-- eget kort, app.absence_stats_pupil, visar alla hens markeringar.) En
-- administratör med eget användar-id eller klassens mentor; en markerad elev är
-- en tom rad för en administratör (is_protected, utan namn och siffror) och
-- finns inte alls för en mentor.
CREATE FUNCTION app.absence_stats_class_pupils(p_class uuid, p_from date, p_to date)
RETURNS TABLE (student_id uuid, first_name text, last_name text, is_protected boolean,
               recorded_minutes integer, valid_minutes integer, absent_minutes integer, late_minutes integer, late_count integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" SET jit = off AS $$
#variable_conflict use_column
DECLARE
  sid uuid := app.current_school_id();
  uid uuid := app.current_user_id();
  who "UserRole" := app.current_user_role();
BEGIN
  PERFORM app.absence_stats_class_access(p_class);
  IF who = 'SCHOOL_ADMIN' AND uid IS NULL THEN
    RAISE EXCEPTION 'ABSENCE_STATS_NO_PUPILS_FOR_THE_READER: huvudmannens läsare ser summor, aldrig en elev' USING ERRCODE = 'AS403';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 1200 THEN
    RAISE EXCEPTION 'ABSENCE_STATS_BAD_PERIOD: från före till, högst 1 200 dagar' USING ERRCODE = 'AS400';
  END IF;
  RETURN QUERY
  WITH RECURSIVE lineage AS (
    SELECT g."id", g."predecessorId", 1 AS depth FROM "StudentGroups" g WHERE g."id" = p_class AND g."schoolId" = sid
    UNION ALL
    SELECT g."id", g."predecessorId", l.depth + 1
      FROM lineage l JOIN "StudentGroups" g ON g."id" = l."predecessorId" AND g."schoolId" = sid
     WHERE l.depth < 4
  ),
  segments AS (
    SELECT e."studentId" AS id, e."validFrom", e."validTo"
      FROM "StudentEnrollments" e
     WHERE e."schoolId" = sid AND e."studentGroupId" IN (SELECT l.id FROM lineage l)
       AND e."validFrom" <= p_to AND (e."validTo" IS NULL OR e."validTo" > p_from)
  ),
  pupils AS (
    SELECT DISTINCT sg.id FROM segments sg
  ),
  marked AS (
    SELECT p.id, EXISTS (SELECT 1 FROM "PersonProtections" pp WHERE pp."userId" = p.id AND pp."schoolId" = sid) AS is_marked
      FROM pupils p
  ),
  figures AS (
    SELECT a."studentId" AS id,
           sum(round(extract(epoch FROM (cl."endsAt" - cl."startsAt")) / 60))::integer AS recorded,
           sum(CASE WHEN a."status" = 'EXCUSED' THEN round(extract(epoch FROM (cl."endsAt" - cl."startsAt")) / 60) ELSE 0 END)::integer AS valid_mins,
           sum(CASE WHEN a."status" = 'ABSENT' THEN round(extract(epoch FROM (cl."endsAt" - cl."startsAt")) / 60) ELSE 0 END)::integer AS absent_mins,
           sum(CASE WHEN a."status" = 'LATE' THEN least(15, round(extract(epoch FROM (cl."endsAt" - cl."startsAt")) / 60)) ELSE 0 END)::integer AS late_mins,
           (count(*) FILTER (WHERE a."status" = 'LATE'))::integer AS late_n
      FROM marked m
      JOIN "AttendanceRecords" a ON a."studentId" = m.id AND a."schoolId" = sid AND a."status" <> 'UNKNOWN'
      JOIN "CalendarLessons" cl ON cl."id" = a."calendarLessonId" AND cl."schoolId" = sid
     WHERE NOT m.is_marked AND cl."date" BETWEEN p_from AND p_to AND cl."status" IN ('SCHEDULED', 'COMPLETED')
       AND EXISTS (SELECT 1 FROM segments sg
                    WHERE sg.id = a."studentId" AND sg."validFrom" <= cl."date" AND (sg."validTo" IS NULL OR cl."date" < sg."validTo"))
     GROUP BY a."studentId"
  )
  SELECT CASE WHEN m.is_marked THEN NULL ELSE m.id END,
         CASE WHEN m.is_marked THEN NULL ELSE u."firstName"::text END,
         CASE WHEN m.is_marked THEN NULL ELSE u."lastName"::text END,
         m.is_marked,
         CASE WHEN m.is_marked THEN NULL ELSE coalesce(f.recorded, 0) END,
         CASE WHEN m.is_marked THEN NULL ELSE coalesce(f.valid_mins, 0) END,
         CASE WHEN m.is_marked THEN NULL ELSE coalesce(f.absent_mins, 0) END,
         CASE WHEN m.is_marked THEN NULL ELSE coalesce(f.late_mins, 0) END,
         CASE WHEN m.is_marked THEN NULL ELSE coalesce(f.late_n, 0) END
    FROM marked m
    JOIN "Users" u ON u."id" = m.id AND u."schoolId" = sid AND u."role" = 'STUDENT'
    LEFT JOIN figures f ON f.id = m.id
   WHERE who = 'SCHOOL_ADMIN' OR NOT m.is_marked
   ORDER BY m.is_marked, u."lastName" COLLATE "C", u."firstName" COLLATE "C", m.id;
END
$$;

-- Eleven själv: namn, klass idag, och första och sista dagen med en
-- markering kvar. Dörren som öppnar en elev.
CREATE FUNCTION app.absence_stats_pupil_head(p_student uuid)
RETURNS TABLE (student_id uuid, first_name text, last_name text, class_id uuid, class_name text,
               first_day date, last_day date, is_protected boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" SET jit = off AS $$
#variable_conflict use_column
DECLARE
  sid uuid := app.current_school_id();
  today date := app.school_today();
BEGIN
  PERFORM app.absence_stats_pupil_access(p_student);
  RETURN QUERY
  SELECT u."id", u."firstName"::text, u."lastName"::text, g."id", g."name"::text,
         (SELECT min(cl."date") FROM "AttendanceRecords" a JOIN "CalendarLessons" cl ON cl."id" = a."calendarLessonId"
           WHERE a."studentId" = p_student AND a."schoolId" = sid AND a."status" <> 'UNKNOWN' AND cl."status" IN ('SCHEDULED', 'COMPLETED')),
         (SELECT max(cl."date") FROM "AttendanceRecords" a JOIN "CalendarLessons" cl ON cl."id" = a."calendarLessonId"
           WHERE a."studentId" = p_student AND a."schoolId" = sid AND a."status" <> 'UNKNOWN' AND cl."status" IN ('SCHEDULED', 'COMPLETED')),
         EXISTS (SELECT 1 FROM "PersonProtections" pp WHERE pp."userId" = p_student AND pp."schoolId" = sid)
    FROM "Users" u
    LEFT JOIN LATERAL (
           SELECT e."studentGroupId" FROM "StudentEnrollments" e
            WHERE e."studentId" = u."id" AND e."schoolId" = sid
              AND e."validFrom" <= today AND (e."validTo" IS NULL OR today < e."validTo")
            ORDER BY e."validFrom" DESC LIMIT 1) cur ON true
    LEFT JOIN "StudentGroups" g ON g."id" = cur."studentGroupId" AND g."schoolId" = sid
   WHERE u."id" = p_student AND u."schoolId" = sid;
END
$$;

-- Elevens månader ur markeringarna som finns kvar, minuterna som ovan och
-- antalet lektioner. En månad utan markering är ingen rad.
CREATE FUNCTION app.absence_stats_pupil(p_student uuid, p_from date, p_to date)
RETURNS TABLE ("month" date, recorded_minutes integer, valid_minutes integer, absent_minutes integer,
               late_minutes integer, late_count integer, lessons integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" SET jit = off AS $$
#variable_conflict use_column
DECLARE
  sid uuid := app.current_school_id();
BEGIN
  PERFORM app.absence_stats_pupil_access(p_student);
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 1200 THEN
    RAISE EXCEPTION 'ABSENCE_STATS_BAD_PERIOD: från före till, högst 1 200 dagar' USING ERRCODE = 'AS400';
  END IF;
  RETURN QUERY
  SELECT date_trunc('month', cl."date"::timestamp)::date,
         sum(round(extract(epoch FROM (cl."endsAt" - cl."startsAt")) / 60))::integer,
         sum(CASE WHEN a."status" = 'EXCUSED' THEN round(extract(epoch FROM (cl."endsAt" - cl."startsAt")) / 60) ELSE 0 END)::integer,
         sum(CASE WHEN a."status" = 'ABSENT' THEN round(extract(epoch FROM (cl."endsAt" - cl."startsAt")) / 60) ELSE 0 END)::integer,
         sum(CASE WHEN a."status" = 'LATE' THEN least(15, round(extract(epoch FROM (cl."endsAt" - cl."startsAt")) / 60)) ELSE 0 END)::integer,
         (count(*) FILTER (WHERE a."status" = 'LATE'))::integer,
         count(*)::integer
    FROM "AttendanceRecords" a
    JOIN "CalendarLessons" cl ON cl."id" = a."calendarLessonId" AND cl."schoolId" = sid
   WHERE a."studentId" = p_student AND a."schoolId" = sid AND a."status" <> 'UNKNOWN'
     AND cl."date" BETWEEN p_from AND p_to AND cl."status" IN ('SCHEDULED', 'COMPLETED')
   GROUP BY 1
   ORDER BY 1;
END
$$;

-- Mönstren: veckodag, pass (lektionens starttid på skolans klocka) och ämne,
-- för en elev (p_student) eller en klass och dess föregångare (p_class), ur
-- markeringarna som finns kvar, elevernas klass räknad vid lektionens dag. En
-- klass med färre än fem elever med en markering i perioden svarar en enda rad
-- med suppressed och inga siffror: mönster över färre är en uppgift om var och en.
CREATE FUNCTION app.absence_stats_patterns(p_class uuid, p_student uuid, p_from date, p_to date)
RETURNS TABLE (dimension text, "key" text, label text, group_size integer, suppressed boolean,
               recorded_minutes integer, valid_minutes integer, absent_minutes integer, late_minutes integer, late_count integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" SET jit = off AS $$
#variable_conflict use_column
DECLARE
  sid uuid := app.current_school_id();
  tz text;
  k constant integer := app.absence_stats_min_group();
BEGIN
  IF (p_class IS NULL) = (p_student IS NULL) THEN
    RAISE EXCEPTION 'ABSENCE_STATS_BAD_SCOPE: en klass eller en elev' USING ERRCODE = 'AS400';
  END IF;
  IF p_class IS NOT NULL THEN
    PERFORM app.absence_stats_class_access(p_class);
  ELSE
    PERFORM app.absence_stats_pupil_access(p_student);
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 1200 THEN
    RAISE EXCEPTION 'ABSENCE_STATS_BAD_PERIOD: från före till, högst 1 200 dagar' USING ERRCODE = 'AS400';
  END IF;
  SELECT s."timezone" INTO tz FROM "Schools" s WHERE s."id" = sid;

  RETURN QUERY
  WITH RECURSIVE lineage AS (
    SELECT g."id", g."predecessorId", 1 AS depth FROM "StudentGroups" g WHERE g."id" = p_class AND g."schoolId" = sid
    UNION ALL
    SELECT g."id", g."predecessorId", l.depth + 1
      FROM lineage l JOIN "StudentGroups" g ON g."id" = l."predecessorId" AND g."schoolId" = sid
     WHERE l.depth < 4
  ),
  -- Klassens elever i perioden, med segmenten de satt i klassen eller i en föregångare.
  roster AS MATERIALIZED (
    SELECT e."studentId" AS student, e."validFrom", e."validTo"
      FROM "StudentEnrollments" e
     WHERE p_class IS NOT NULL AND e."schoolId" = sid AND e."studentGroupId" IN (SELECT l.id FROM lineage l)
       AND e."validFrom" <= p_to AND (e."validTo" IS NULL OR e."validTo" > p_from)
  ),
  -- Markeringarna mönstret räknas ur: en elevs egna, eller klassens elevers. Varje
  -- elev läses en gång genom sitt eget index, hur många segment hen än har. (Att gå
  -- från segmenten till markeringarna läste varje markering en gång per segment och
  -- byggde en hash över skolans alla lektioner i perioden: tre läsår för en kull
  -- tog fem gånger så lång tid som klassens elevlista.)
  marks AS (
    SELECT a."studentId" AS student, a."calendarLessonId" AS lesson, a."status"
      FROM "AttendanceRecords" a
     WHERE p_student IS NOT NULL AND a."studentId" = p_student AND a."schoolId" = sid AND a."status" <> 'UNKNOWN'
    UNION ALL
    SELECT a."studentId", a."calendarLessonId", a."status"
      FROM (SELECT DISTINCT r.student FROM roster r) p
      JOIN "AttendanceRecords" a ON a."studentId" = p.student AND a."schoolId" = sid AND a."status" <> 'UNKNOWN'
  ),
  -- Lektionen slås upp med sin nyckel (LATERAL ... LIMIT 1 hindrar en hash över
  -- skolans lektioner). I en klass räknas markeringen bara om eleven satt i klassen
  -- eller en föregångare lektionens dag. En markerad elev räknas med i en klass: en
  -- summa namnger ingen.
  base AS (
    SELECT m.student, extract(isodow FROM cl."date")::integer AS isodow,
           date_trunc('minute', cl."startsAt" AT TIME ZONE tz)::time AS slot, cl."subjectId" AS subject_id,
           round(extract(epoch FROM (cl."endsAt" - cl."startsAt")) / 60)::integer AS mins, m."status"
      FROM marks m
     CROSS JOIN LATERAL (
           SELECT c."date", c."startsAt", c."endsAt", c."subjectId" FROM "CalendarLessons" c
            WHERE c."id" = m.lesson AND c."schoolId" = sid AND c."date" BETWEEN p_from AND p_to
              AND c."status" IN ('SCHEDULED', 'COMPLETED')
            LIMIT 1) cl
     WHERE p_class IS NULL
        OR EXISTS (SELECT 1 FROM roster r
                    WHERE r.student = m.student AND cl."date" >= r."validFrom" AND (r."validTo" IS NULL OR cl."date" < r."validTo"))
  ),
  -- Ett enda varv över markeringarna för alla fyra grupperingarna: veckodag, pass,
  -- ämne och eleverna (hur många som har en markering). grouping() är 7, 11, 13
  -- respektive 14 för dem, med en etta för varje kolumn som inte grupperas.
  agg AS (
    SELECT grouping(b.isodow, b.slot, b.subject_id, b.student) AS g, b.isodow, b.slot, b.subject_id,
           sum(b.mins)::integer AS recorded,
           sum(CASE WHEN b."status" = 'EXCUSED' THEN b.mins ELSE 0 END)::integer AS valid_mins,
           sum(CASE WHEN b."status" = 'ABSENT' THEN b.mins ELSE 0 END)::integer AS absent_mins,
           sum(CASE WHEN b."status" = 'LATE' THEN least(15, b.mins) ELSE 0 END)::integer AS late_mins,
           (count(*) FILTER (WHERE b."status" = 'LATE'))::integer AS late_n
      FROM base b
     GROUP BY GROUPING SETS ((b.isodow), (b.slot), (b.subject_id), (b.student))
  ),
  size AS (
    SELECT count(*)::integer AS n FROM agg WHERE agg.g = 14
  ),
  cells AS (
    SELECT (CASE a.g WHEN 7 THEN 'WEEKDAY' WHEN 11 THEN 'SLOT' ELSE 'SUBJECT' END)::text AS dimension,
           (CASE a.g WHEN 7 THEN a.isodow::text WHEN 11 THEN to_char(a.slot, 'HH24:MI') ELSE a.subject_id::text END)::text AS key,
           (CASE a.g WHEN 13 THEN su."name"::text ELSE ''::text END)::text AS label,
           a.recorded, a.valid_mins, a.absent_mins, a.late_mins, a.late_n
      FROM agg a
      LEFT JOIN "Subjects" su ON a.g = 13 AND su."id" = a.subject_id AND su."schoolId" = sid
     WHERE a.g <> 14
  )
  -- A class of fewer than five pupils with a mark: one row that says so.
  SELECT 'ALL'::text, ''::text, ''::text, z.n, true,
         NULL::integer, NULL::integer, NULL::integer, NULL::integer, NULL::integer
    FROM size z WHERE p_class IS NOT NULL AND z.n > 0 AND z.n < k
  UNION ALL
  SELECT c.dimension, c.key, c.label, z.n, false, c.recorded, c.valid_mins, c.absent_mins, c.late_mins, c.late_n
    FROM cells c CROSS JOIN size z
   WHERE p_class IS NULL OR z.n >= k;
END
$$;

-- ---------------------------------------------------------------------------
-- Row-level security och rättigheter
-- ---------------------------------------------------------------------------

ALTER TABLE "AbsenceStatsMonths" ENABLE ROW LEVEL SECURITY;

-- Tabellen har ingen policy för någon roll, med avsikt: dörrarna ovan läser
-- den som ägaren och är det enda sättet in.
DO $$
DECLARE
  r text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    EXECUTE 'REVOKE ALL ON "AbsenceStatsMonths" FROM "app_authenticated"';
  END IF;
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "AbsenceStatsMonths" FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "AbsenceStatsMonths" FROM "service_role"';
  END IF;
  -- PostgreSQL 17's MAINTAIN (REINDEX, CLUSTER, VACUUM, LOCK): the owner's alone.
  IF current_setting('server_version_num')::int >= 170000 THEN
    FOREACH r IN ARRAY ARRAY['authenticated', 'app_authenticated', 'service_role', 'anon'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE MAINTAIN ON "AbsenceStatsMonths" FROM %I', r);
      END IF;
    END LOOP;
  END IF;
END
$$;

COMMENT ON TABLE "AbsenceStatsMonths" IS
  'Frånvarostatistik: summor per klass och månad och för hela skolan, aldrig ett elev-id. Minst fem elever bakom en rad, och bakom en siffra. Läses bara genom app.absence_stats_*, skrivs bara av app.absence_stats_month.';
COMMENT ON FUNCTION app.absence_stats_min_group() IS
  'Frånvarostatistik: den minsta gruppen under vilken en siffra inte lagras eller visas (CHECK AbsenceStatsMonths_a_group_has_five_pupils säger samma tal).';
COMMENT ON FUNCTION app.absence_stats_window_first(uuid, date) IS
  'Frånvarostatistik: första dagen i månaden då det äldsta av skolans tre senaste läsår började; null utan läsår.';
COMMENT ON FUNCTION app.absence_stats_window() IS
  'Frånvarostatistik: första månaden i fönstret, skolans dag idag och läsåret som rymmer idag, för en administratör eller en lärare.';
COMMENT ON FUNCTION app.absence_stats_plan(uuid, date, integer) IS
  'Frånvarostatistik: månaderna jobbet räknar denna natt, i skolans datum: de senaste 62 dagarna och högst p_backfill äldre som saknar en rad, har en hållen lektion och minst fem elever på klasslistorna, bara de vars markeringar kan finnas kvar.';
COMMENT ON FUNCTION app.absence_stats_lessons(uuid, date, date, timestamptz) IS
  'Frånvarostatistik: app.reporting_lessons (Rapporteringsgrad) med en ändrad rad: en lärare räknas om hen inte hade slutat när lektionen var slut, så att en månad för två år sedan har sina lektioner också när läraren har slutat. En test och 392o fäller om den skiljer sig från den senaste app.reporting_lessons på något annat.';
COMMENT ON FUNCTION app.absence_stats_month(uuid, date, date) IS
  'Frånvarostatistik: räknar om en månad för skolan och varje klass med minst fem elever (klassen vid lektionens dag, lektionerna ur app.absence_stats_lessons), och tar bort rader månaden inte längre har skäl till.';
COMMENT ON FUNCTION app.absence_stats_trim(uuid, date) IS
  'Frånvarostatistik: tar bort månader före de tre senaste läsårens början.';
COMMENT ON FUNCTION app.absence_stats_pupil_access(uuid) IS
  'Frånvarostatistik: vägrar (AS403) om anroparen inte är en administratör med eget användar-id eller elevens mentor idag (en markerad elev bara för en administratör).';
COMMENT ON FUNCTION app.absence_stats_class_access(uuid) IS
  'Frånvarostatistik: vägrar (AS403) om anroparen inte är en administratör (läsaren också) eller klassens mentor idag.';
COMMENT ON FUNCTION app.absence_stats_series(uuid) IS
  'Frånvarostatistik: månadsraderna för skolan (bara en administratör) eller en klass och dess föregångare, de tre senaste läsåren.';
COMMENT ON FUNCTION app.absence_stats_classes(date, date) IS
  'Frånvarostatistik: klasserna i en period med summan av sina månader (en administratör: alla; en mentor: sina klasser).';
COMMENT ON FUNCTION app.absence_stats_class_pupils(uuid, date, date) IS
  'Frånvarostatistik: eleverna i en klass under en period med sina summor för dagarna de hörde till klassen, ur markeringarna som finns kvar; en markerad elev utelämnas (för en administratör en tom rad).';
COMMENT ON FUNCTION app.absence_stats_pupil_head(uuid) IS
  'Frånvarostatistik: en elevs namn, klass idag och första och sista dagen med en markering kvar.';
COMMENT ON FUNCTION app.absence_stats_pupil(uuid, date, date) IS
  'Frånvarostatistik: en elevs månader ur markeringarna som finns kvar.';
COMMENT ON FUNCTION app.absence_stats_patterns(uuid, uuid, date, date) IS
  'Frånvarostatistik: mönster per veckodag, pass och ämne för en elev eller en klass; en klass med färre än fem elever svarar en rad med suppressed.';

DO $$
DECLARE
  fn text;
  r text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'app.absence_stats_min_group()',
    'app.absence_stats_window_first(uuid, date)',
    'app.absence_stats_plan(uuid, date, integer)',
    'app.absence_stats_lessons(uuid, date, date, timestamptz)',
    'app.absence_stats_month(uuid, date, date)',
    'app.absence_stats_trim(uuid, date)',
    'app.absence_stats_window()',
    'app.absence_stats_pupil_access(uuid)',
    'app.absence_stats_class_access(uuid)',
    'app.absence_stats_series(uuid)',
    'app.absence_stats_classes(date, date)',
    'app.absence_stats_class_pupils(uuid, date, date)',
    'app.absence_stats_pupil_head(uuid)',
    'app.absence_stats_pupil(uuid, date, date)',
    'app.absence_stats_patterns(uuid, uuid, date, date)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', fn, r);
      END IF;
    END LOOP;
  END LOOP;
  -- The API role runs the readers and the job's three calls. The access checks,
  -- the window and the group size are the owner's functions' own.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    FOREACH fn IN ARRAY ARRAY[
      'app.absence_stats_plan(uuid, date, integer)',
      'app.absence_stats_month(uuid, date, date)',
      'app.absence_stats_trim(uuid, date)',
      'app.absence_stats_window()',
      'app.absence_stats_series(uuid)',
      'app.absence_stats_classes(date, date)',
      'app.absence_stats_class_pupils(uuid, date, date)',
      'app.absence_stats_pupil_head(uuid)',
      'app.absence_stats_pupil(uuid, date, date)',
      'app.absence_stats_patterns(uuid, uuid, date, date)'
    ] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO "app_authenticated"', fn);
    END LOOP;
  END IF;
END
$$;
