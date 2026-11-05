-- Frånvarobevakning med gränser och sammanställningar.
--
-- Skolan sätter gränser för frånvaro, och Rastra säger till när en elev
-- passerat en: andel frånvaro över ett fönster av dagar ("10 % över 14
-- dagar") eller så många skoldagar i följd ("5 dagar i följd"), med giltig och
-- ogiltig frånvaro var för sig. En gräns hör till en mottagargrupp (mentor,
-- rektor, kansli, vårdnadshavare). Varje natt räknar ett jobb om vilka elever
-- som är över en gräns, och varje vecka eller månad får mottagarna en
-- sammanställning: ett antal, aldrig en anledning och aldrig ett namn i e-posten
-- eller i pushen. Vilka eleverna är står i en vy i webben, bakom inloggningen.
-- Avstängt som standard: en skola utan rad i AbsenceWatchSettings, eller med
-- enabled = false, bevakas inte och får inga sammanställningar.
--
-- ## Fyra tabeller
--
--   AbsenceWatchSettings   en rad per skola: på eller av, och hur ofta varje
--                          mottagargrupp får sin sammanställning (vecka eller
--                          månad). Inga personuppgifter.
--   AbsenceWatchLimits     skolans gränser: (mottagargrupp, slag, grund) är
--                          unik, så en skola har högst sex gränser per grupp.
--                          Inga personuppgifter.
--   AbsenceWatchFindings   en rad per gräns och elev som passerat den: sedan
--                          vilken dag, när den senast sågs över gränsen, och
--                          mätetalen i minuter eller dagar. Raden bor kvar
--                          sedan eleven kommit under gränsen (clearedOn), så
--                          vyn kan säga "sedan när". Personuppgifter: den
--                          gallras som närvaron (se nedan).
--   AbsenceWatchDigests    huvudboken över skrivna sammanställningar: en rad
--                          per skola, grupp och periodslut. Den gör att en
--                          sammanställning skrivs en gång även om jobbet körs
--                          två gånger. Bara antal, inga personuppgifter.
--
-- Fynden skrivs av app.absence_watch_evaluate och av ingenting annat: ingen
-- roll har en skrivarm på tabellen, och API:ets roll har bara SELECT.
--
-- ## Rätt räkning
--
-- Räkningen bygger på närvaron i minuter som rapporten på /admin/reports
-- redan räknar (AttendanceRecords och lektionens längd), med samma regler:
--
--   PRESENT   närvaro
--   EXCUSED   giltig frånvaro, lektionens minuter
--   ABSENT    ogiltig frånvaro, lektionens minuter
--   LATE      15 minuter ogiltig (högst lektionens längd), och lektionen räknas
--             som närvaro i övrigt
--   UNKNOWN   registrerad ingenstans: räknas varken i täljare eller nämnare
--
-- Bara lektioner som hålls räknas: SCHEDULED och COMPLETED, de statusar som
-- levererad tid också räknar (P3, timplan-delivered). En inställd lektion
-- (CANCELLED) är aldrig frånvaro, vad som än registrerats på den, och en
-- ersättningslektion (Schemabrytande aktivitet) räknas som vilken lektion som
-- helst. Lov, helger och ledighet följer de befintliga reglerna utan egen
-- kod: en dag utan en enda registrerad lektion är ingen skoldag för räkningen
-- och hoppas över, i stället för att bryta en följd eller räknas som frånvaro,
-- och beviljad ledighet är EXCUSED som den alltid varit.
--
-- Andelen är frånvarominuter delat med registrerade minuter över fönstret
-- [dag - (dagar - 1), dag], båda ändar med, i skolans lokala datum. Gränsen är
-- nådd när andelen är lika med eller över den (ett heltal, jämfört utan
-- avrundning: frånvaro * 100 >= gräns * registrerat). Dagar i följd räknas på
-- elevens registrerade dagar, bakifrån: en dag är frånvaro när varje
-- registrerad lektion den dagen är det (EXCUSED för giltig, ABSENT för ogiltig,
-- någon av dem för alla), och följden gäller bara om dess senaste dag är högst
-- sju dagar gammal. Den räknar högst 90 dagar bakåt. En andel gäller på samma sätt
-- bara om elevens senaste registrerade dag är högst sju dagar gammal: frånvaro som
-- pågår, så ingen står kvar över en gräns över ett lov.
--
-- Dagen som räknas är aldrig i dag: jobbet räknar till och med gårdagen i
-- skolans tidszon, och app.absence_watch_evaluate vägrar en dag som inte gått.
--
-- ## Mottagare och vad var och en ser
--
-- Alla läsarmar på AbsenceWatchFindings är TO app_authenticated: fynden når
-- ingen genom PostgREST utan bara genom gatewayen, som loggar varje läsning i
-- läsloggen (ATTENDANCE och PEOPLE, recordRead).
--
--   absence_watch_findings_admin_select
--       skolans SCHOOL_ADMIN, varje profil: alla fynd.
--   absence_watch_findings_mentor_select
--       en TEACHER, de fynd av en MENTOR-gräns som gäller en elev i en klass
--       läraren har MENTORSKAP för i dag (app.absence_watch_is_mentor_of,
--       samma mentorsregel som ledighetsbeslutet: app.leave_mentors).
--   absence_watch_findings_guardian_select
--       en GUARDIAN, de fynd av en GUARDIAN-gräns som gäller ett eget barn.
--
-- Gränserna och inställningarna läses och skrivs av skolans administratör
-- (Drift, som frånvaron och ledigheten); ingen annan når dem. Fynden bär en
-- kopia av gränsen som den stod när fyndet sist sågs, så vyn säger vad eleven
-- passerade även sedan gränsen ändrats eller tagits bort.
--
-- Mottagarna är de aktiva: mentorerna (app.absence_watch_mentees), rektor
-- (administratörer med profilen REKTOR eller FULL), kansliet (profilen
-- EXPEDITION) och elevens vårdnadshavare. En sammanställning skrivs bara till
-- den som har något att höra: ett antal över noll.
--
-- ## Läsloggen, också i jobbet
--
-- app.personal_data_read tar läsaren ur inloggningens claims och vägrar en
-- transaktion utan läsare (PD403), så jobbet kan inte logga som sig självt, och
-- ingen funktion får läsa ut en annan persons authId för att jobbet ska kunna ta
-- mottagarens claims (avsnitt 10 håller den listan). En sammanställning är ändå
-- en läsning: den ger varje mottagare ett antal av de elever vars närvaro de
-- skulle se i vyn. app.absence_watch_digest skriver därför en rad i läsloggen
-- för varje mottagare (ATTENDANCE, kanalen OTHER, mottagaren som läsare, de
-- elever sammanställningen bygger på) i samma sats som notiserna och huvudboken.
-- Funktionen tar varken läsare eller elever av sin anropare: båda är vad
-- app.absence_watch_digest_plan svarar, så den kan inte användas för att skriva
-- en läsning som sammanställningen inte gör. Samma 15-minutersregel som
-- app.personal_data_read: den som redan har eleven i en rad av slaget senaste
-- kvarten får ingen ny. Faller loggen faller sammanställningen med den.
--
-- ## Gallring
--
-- Fynden är närvaro i en annan form och gallras som den: gallringstypen
-- ATTENDANCE gäller dem, med fyndets lastSeenOn som datum. Ingen ny
-- RetentionDataType behövs, och en skola som inte bestämt något gallrar inget
-- av dem, som förut. app.gallring_due och app.gallring_purge nedan är
-- 20261026091000:s kroppar med en gren för fynden.
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
-- tabellerna och skriver aldrig en notis av den nya typen.

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
        RAISE EXCEPTION 'Schools and Users were not free at once in 30 s: nothing is changed. Prisma now holds this migration as failed, so run "prisma migrate resolve --rolled-back 20261231090100_franvarobevakning_med_granser_och_sammanstallningar" and then "prisma migrate deploy" again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

CREATE TYPE "AbsenceWatchGroup" AS ENUM ('MENTOR', 'REKTOR', 'KANSLI', 'GUARDIAN');
CREATE TYPE "AbsenceWatchKind" AS ENUM ('SHARE', 'CONSECUTIVE');
CREATE TYPE "AbsenceWatchBasis" AS ENUM ('VALID', 'INVALID', 'ALL');
CREATE TYPE "AbsenceWatchCadence" AS ENUM ('WEEKLY', 'MONTHLY');

-- ---------------------------------------------------------------------------
-- AbsenceWatchSettings
-- ---------------------------------------------------------------------------

CREATE TABLE "AbsenceWatchSettings" (
    "schoolId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    -- Skolans lokala datum då bevakningen senast slogs på, satt av triggern;
    -- NULL så länge den aldrig varit på. En sammanställning skrivs bara för en
    -- period som slutat på eller efter det datumet.
    "enabledOn" DATE,
    "mentorCadence" "AbsenceWatchCadence" NOT NULL DEFAULT 'WEEKLY',
    "rektorCadence" "AbsenceWatchCadence" NOT NULL DEFAULT 'WEEKLY',
    "kansliCadence" "AbsenceWatchCadence" NOT NULL DEFAULT 'WEEKLY',
    "guardianCadence" "AbsenceWatchCadence" NOT NULL DEFAULT 'MONTHLY',
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AbsenceWatchSettings_pkey" PRIMARY KEY ("schoolId"),
    CONSTRAINT "AbsenceWatchSettings_on_has_a_date" CHECK (NOT "enabled" OR "enabledOn" IS NOT NULL)
);

ALTER TABLE "AbsenceWatchSettings"
    ADD CONSTRAINT "AbsenceWatchSettings_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- AbsenceWatchLimits
-- ---------------------------------------------------------------------------

CREATE TABLE "AbsenceWatchLimits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "recipientGroup" "AbsenceWatchGroup" NOT NULL,
    "kind" "AbsenceWatchKind" NOT NULL,
    "basis" "AbsenceWatchBasis" NOT NULL,
    -- SHARE: andel frånvaro i procent (1..100) över windowDays (7..60) dagar.
    "percent" SMALLINT,
    "windowDays" SMALLINT,
    -- CONSECUTIVE: så många skoldagar i följd (2..30).
    "consecutiveDays" SMALLINT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AbsenceWatchLimits_pkey" PRIMARY KEY ("id"),
    -- Sagt med IS NOT NULL i varje gren: en NULL i en jämförelse är okänd, och
    -- en CHECK släpper igenom okänt.
    CONSTRAINT "AbsenceWatchLimits_a_kind_has_its_figures" CHECK (
        ("kind" = 'SHARE'
         AND "percent" IS NOT NULL AND "percent" BETWEEN 1 AND 100
         AND "windowDays" IS NOT NULL AND "windowDays" BETWEEN 7 AND 60
         AND "consecutiveDays" IS NULL)
        OR
        ("kind" = 'CONSECUTIVE'
         AND "consecutiveDays" IS NOT NULL AND "consecutiveDays" BETWEEN 2 AND 30
         AND "percent" IS NULL AND "windowDays" IS NULL)
    )
);

CREATE UNIQUE INDEX "AbsenceWatchLimits_one_per_group_kind_basis_key"
    ON "AbsenceWatchLimits"("schoolId", "recipientGroup", "kind", "basis");

ALTER TABLE "AbsenceWatchLimits"
    ADD CONSTRAINT "AbsenceWatchLimits_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- AbsenceWatchFindings
-- ---------------------------------------------------------------------------

CREATE TABLE "AbsenceWatchFindings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    -- Gränsen fyndet gäller. Ingen främmande nyckel, med avsikt: ett fynd
    -- överlever sin gräns och säger vad eleven passerade (kopian nedan); en
    -- trigger på gränsen stänger dess öppna fynd när den tas bort.
    "limitId" UUID NOT NULL,
    "recipientGroup" "AbsenceWatchGroup" NOT NULL,
    "kind" "AbsenceWatchKind" NOT NULL,
    "basis" "AbsenceWatchBasis" NOT NULL,
    "percent" SMALLINT,
    "windowDays" SMALLINT,
    "consecutiveDays" SMALLINT,
    -- Första dag gränsen sågs passerad. För dagar i följd den dag följden nådde
    -- gränsen; för andel den kväll bevakningen först såg den (andelen räknas
    -- inte om dag för dag bakåt).
    "firstCrossedOn" DATE NOT NULL,
    -- Senaste dag fyndet höll. Öppet fynd: gårdagen vid senaste körningen.
    "lastSeenOn" DATE NOT NULL,
    -- Dagen eleven kom under gränsen; NULL medan fyndet är öppet.
    "clearedOn" DATE,
    -- Mätetalen vid senaste sikt. Andel: frånvarominuter av registrerade
    -- minuter. Följd: antal dagar. Ingen anledning, ingen typ, ingen anteckning.
    "absentMinutes" INTEGER,
    "recordedMinutes" INTEGER,
    "streakDays" SMALLINT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AbsenceWatchFindings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AbsenceWatchFindings_days_are_ordered" CHECK (
        "lastSeenOn" >= "firstCrossedOn" AND ("clearedOn" IS NULL OR "clearedOn" >= "firstCrossedOn")
    ),
    CONSTRAINT "AbsenceWatchFindings_a_kind_has_its_figures" CHECK (
        ("kind" = 'SHARE'
         AND "percent" IS NOT NULL AND "percent" BETWEEN 1 AND 100
         AND "windowDays" IS NOT NULL AND "windowDays" BETWEEN 7 AND 60
         AND "consecutiveDays" IS NULL
         AND "recordedMinutes" IS NOT NULL AND "recordedMinutes" > 0
         AND "absentMinutes" IS NOT NULL AND "absentMinutes" >= 0 AND "absentMinutes" <= "recordedMinutes"
         AND "streakDays" IS NULL)
        OR
        ("kind" = 'CONSECUTIVE'
         AND "consecutiveDays" IS NOT NULL AND "consecutiveDays" BETWEEN 2 AND 30
         AND "percent" IS NULL AND "windowDays" IS NULL
         AND "streakDays" IS NOT NULL AND "streakDays" >= "consecutiveDays"
         AND "absentMinutes" IS NULL AND "recordedMinutes" IS NULL)
    )
);

-- Ett öppet fynd per gräns och elev: det som gör att två körningar inte
-- skriver två, och det ON CONFLICT i app.absence_watch_evaluate pekar på.
CREATE UNIQUE INDEX "AbsenceWatchFindings_one_open_key"
    ON "AbsenceWatchFindings"("limitId", "studentId") WHERE "clearedOn" IS NULL;
-- Elevens fynd, och den främmande nyckelns kaskad när en person tas bort.
CREATE INDEX "AbsenceWatchFindings_studentId_schoolId_idx" ON "AbsenceWatchFindings"("studentId", "schoolId");
-- Gallringens villkor och skolans vy.
CREATE INDEX "AbsenceWatchFindings_schoolId_lastSeenOn_idx" ON "AbsenceWatchFindings"("schoolId", "lastSeenOn");

ALTER TABLE "AbsenceWatchFindings"
    ADD CONSTRAINT "AbsenceWatchFindings_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AbsenceWatchFindings"
    ADD CONSTRAINT "AbsenceWatchFindings_studentId_schoolId_fkey" FOREIGN KEY ("studentId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- AbsenceWatchDigests
-- ---------------------------------------------------------------------------

CREATE TABLE "AbsenceWatchDigests" (
    "schoolId" UUID NOT NULL,
    "recipientGroup" "AbsenceWatchGroup" NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "composedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    -- Hur många mottagare fick en sammanställning, och hur många elever den
    -- byggde på (olika elever över alla mottagare).
    "recipients" INTEGER NOT NULL,
    "pupils" INTEGER NOT NULL,

    CONSTRAINT "AbsenceWatchDigests_pkey" PRIMARY KEY ("schoolId", "recipientGroup", "periodEnd"),
    CONSTRAINT "AbsenceWatchDigests_period_is_ordered" CHECK ("periodEnd" >= "periodStart"),
    CONSTRAINT "AbsenceWatchDigests_counts_are_counts" CHECK ("recipients" >= 0 AND "pupils" >= 0)
);

ALTER TABLE "AbsenceWatchDigests"
    ADD CONSTRAINT "AbsenceWatchDigests_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Triggers: the switch's date, and what a stop or a removed limit closes.
-- ---------------------------------------------------------------------------

-- enabledOn is the trigger's: a writer cannot set it. It is the school's local
-- date when the switch last went from off to on.
CREATE FUNCTION app.absence_watch_settings_stamp() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  NEW."updatedAt" := now();
  IF NEW."enabled" AND (TG_OP = 'INSERT' OR NOT OLD."enabled") THEN
    NEW."enabledOn" := (clock_timestamp() AT TIME ZONE coalesce(
        (SELECT s."timezone" FROM "Schools" s WHERE s."id" = NEW."schoolId"), 'Europe/Stockholm'))::date;
  ELSIF TG_OP = 'INSERT' THEN
    NEW."enabledOn" := NULL;
  ELSE
    NEW."enabledOn" := OLD."enabledOn";
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "AbsenceWatchSettings_stamp"
    BEFORE INSERT OR UPDATE ON "AbsenceWatchSettings"
    FOR EACH ROW EXECUTE FUNCTION app.absence_watch_settings_stamp();

-- Turned off: nothing stays open in a view that is no longer fed.
CREATE FUNCTION app.absence_watch_settings_stop() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  today date := (clock_timestamp() AT TIME ZONE coalesce(
      (SELECT s."timezone" FROM "Schools" s WHERE s."id" = NEW."schoolId"), 'Europe/Stockholm'))::date;
BEGIN
  UPDATE "AbsenceWatchFindings" f
     SET "clearedOn" = greatest(today, f."lastSeenOn")
   WHERE f."schoolId" = NEW."schoolId" AND f."clearedOn" IS NULL;
  RETURN NULL;
END
$$;

CREATE TRIGGER "AbsenceWatchSettings_stop"
    AFTER UPDATE OF "enabled" ON "AbsenceWatchSettings"
    FOR EACH ROW WHEN (OLD."enabled" AND NOT NEW."enabled")
    EXECUTE FUNCTION app.absence_watch_settings_stop();

CREATE FUNCTION app.absence_watch_limits_stamp() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."updatedAt" := now();
  -- A limit keeps its group, its kind and its basis: they are what makes it
  -- the limit its findings belong to. Another one is a new limit.
  IF TG_OP = 'UPDATE' AND (NEW."schoolId" IS DISTINCT FROM OLD."schoolId"
                           OR NEW."recipientGroup" IS DISTINCT FROM OLD."recipientGroup"
                           OR NEW."kind" IS DISTINCT FROM OLD."kind"
                           OR NEW."basis" IS DISTINCT FROM OLD."basis") THEN
    RAISE EXCEPTION 'ABSENCE_WATCH_LIMIT_IS_FIXED: en gräns byter inte grupp, slag eller grund'
      USING ERRCODE = 'AW409';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "AbsenceWatchLimits_stamp"
    BEFORE UPDATE ON "AbsenceWatchLimits"
    FOR EACH ROW EXECUTE FUNCTION app.absence_watch_limits_stamp();

-- A removed limit closes its open findings at once, not at the next night.
CREATE FUNCTION app.absence_watch_limits_removed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  today date := (clock_timestamp() AT TIME ZONE coalesce(
      (SELECT s."timezone" FROM "Schools" s WHERE s."id" = OLD."schoolId"), 'Europe/Stockholm'))::date;
BEGIN
  UPDATE "AbsenceWatchFindings" f
     SET "clearedOn" = greatest(today, f."lastSeenOn")
   WHERE f."limitId" = OLD."id" AND f."clearedOn" IS NULL;
  RETURN NULL;
END
$$;

CREATE TRIGGER "AbsenceWatchLimits_removed"
    AFTER DELETE ON "AbsenceWatchLimits"
    FOR EACH ROW EXECUTE FUNCTION app.absence_watch_limits_removed();

-- ---------------------------------------------------------------------------
-- The mentors: one definition of who mentors whom, as the leave decision has.
-- ---------------------------------------------------------------------------

-- Every (mentor, pupil) pair of the school on p_on: the same rule as
-- app.leave_mentors for a request of the one day p_on, for the whole school at
-- once (a digest asks every mentor's pupils; the policy below asks one).
CREATE FUNCTION app.absence_watch_mentees(p_school uuid, p_on date)
RETURNS TABLE (mentor_id uuid, student_id uuid)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT t."userId", e."studentId"
    FROM "public"."TeacherDuties" t
    JOIN "public"."StudentEnrollments" e
      ON e."schoolId" = t."schoolId" AND e."studentGroupId" = t."studentGroupId"
     AND e."validFrom" <= p_on AND (e."validTo" IS NULL OR p_on < e."validTo")
    JOIN "public"."AcademicYears" y
      ON y."id" = t."academicYearId" AND y."schoolId" = t."schoolId"
    JOIN "public"."Users" u
      ON u."id" = t."userId" AND u."schoolId" = t."schoolId" AND u."isActive" AND u."role" = 'TEACHER'
   WHERE t."schoolId" = p_school AND t."kind" = 'MENTORSKAP'
     AND p_on BETWEEN y."startDate" AND y."endDate"
     AND p_on >= COALESCE(t."validFrom", y."startDate")
     AND p_on <= COALESCE(t."validTo", y."endDate")
$$;

-- The caller is a teacher who mentors the pupil today: the mentor arm's whole
-- question. The caller's own TeacherDuties row is theirs to read, but the
-- enrolments are not, so the lookup runs as the owner like the leave arm's.
CREATE FUNCTION app.absence_watch_is_mentor_of(p_student uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT app.current_user_role() = 'TEACHER'
     AND EXISTS (
           SELECT 1
             FROM app.leave_mentors(app.current_school_id(), p_student, app.school_today(), app.school_today()) AS m(id)
            WHERE m.id = app.current_user_id())
$$;

-- ---------------------------------------------------------------------------
-- The nightly count.
-- ---------------------------------------------------------------------------

-- The schools with the switch on: what the job asks before it claims a night.
CREATE FUNCTION app.absence_watch_schools() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT s."schoolId" FROM "AbsenceWatchSettings" s WHERE s."enabled" ORDER BY s."schoolId"
$$;

-- Who is over which limit as of the end of p_as_of, in the school's local
-- dates: opens a finding for each new pair, refreshes the open ones that still
-- hold, and closes the open ones that do not (or whose limit is gone). Answers
-- how many it opened, kept and closed, and how many pupils had a registered
-- lesson in the lookback. Serialised per school. Nothing is read twice: one
-- scan of the registered lessons feeds both kinds of limit.
CREATE FUNCTION app.absence_watch_evaluate(p_school uuid, p_as_of date)
RETURNS TABLE (opened integer, kept integer, closed integer, pupils integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  tz text;
  today date;
  lookback integer;
  first_day date;
  n_opened integer;
  n_kept integer;
  n_closed integer;
  n_pupils integer;
BEGIN
  SELECT s."timezone" INTO tz FROM "Schools" s WHERE s."id" = p_school;
  IF tz IS NULL THEN
    RAISE EXCEPTION 'ABSENCE_WATCH_NO_SCHOOL' USING ERRCODE = 'AW404';
  END IF;
  today := (clock_timestamp() AT TIME ZONE tz)::date;
  IF p_as_of IS NULL OR p_as_of >= today THEN
    RAISE EXCEPTION 'ABSENCE_WATCH_DAY_IS_NOT_OVER: bevakningen räknar till och med en dag som gått'
      USING ERRCODE = 'AW400';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('absence-watch:' || p_school::text, 0));

  -- FOR SHARE: turning the switch off waits for a count in progress, and its trigger then
  -- closes what the count wrote; a count that starts after it finds it off.
  PERFORM 1 FROM "AbsenceWatchSettings" s WHERE s."schoolId" = p_school AND s."enabled" FOR SHARE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 0, 0, 0, 0;
    RETURN;
  END IF;

  SELECT greatest(
           coalesce(max(l."windowDays") FILTER (WHERE l."kind" = 'SHARE'), 0),
           CASE WHEN bool_or(l."kind" = 'CONSECUTIVE') THEN 90 ELSE 0 END)
    INTO lookback
    FROM "AbsenceWatchLimits" l WHERE l."schoolId" = p_school;
  first_day := p_as_of - (lookback - 1);

  WITH cfg AS (
    SELECT l.* FROM "AbsenceWatchLimits" l WHERE l."schoolId" = p_school
  ),
  -- The registered lessons that were held, per active pupil: the one scan.
  marks AS (
    SELECT a."studentId" AS student, cl."date" AS day, a."status" AS status,
           round(extract(epoch FROM (cl."endsAt" - cl."startsAt")) / 60)::integer AS mins
      FROM "CalendarLessons" cl
      JOIN "AttendanceRecords" a ON a."calendarLessonId" = cl."id"
      JOIN "Users" u ON u."id" = a."studentId" AND u."schoolId" = p_school
                    AND u."isActive" AND u."role" = 'STUDENT'
     WHERE cl."schoolId" = p_school
       AND cl."date" BETWEEN first_day AND p_as_of
       AND cl."status" IN ('SCHEDULED', 'COMPLETED')
       AND a."status" <> 'UNKNOWN'
  ),
  -- One row per pupil and day with the minutes of each kind and whether every
  -- registered lesson that day was of one kind: what both kinds of limit are
  -- counted from, so the marks (170 000 in a school of 500 over 90 days) are
  -- read once and the limits work on 30 times fewer rows.
  daily AS (
    SELECT m.student, m.day,
           sum(m.mins)::integer AS recorded,
           sum(CASE WHEN m.status = 'EXCUSED' THEN m.mins ELSE 0 END)::integer AS valid_mins,
           sum(CASE m.status WHEN 'ABSENT' THEN m.mins WHEN 'LATE' THEN least(15, m.mins) ELSE 0 END)::integer AS invalid_mins,
           bool_and(m.status = 'EXCUSED') AS all_excused,
           bool_and(m.status = 'ABSENT') AS all_absent,
           bool_and(m.status IN ('EXCUSED', 'ABSENT')) AS all_away
      FROM marks m
     GROUP BY m.student, m.day
  ),
  share AS (
    SELECT t.limit_id, t.student, t.recorded, t.absent
      FROM (SELECT c."id" AS limit_id, c."percent", d.student,
                   max(d.day) AS last_day,
                   sum(d.recorded)::integer AS recorded,
                   sum(CASE c."basis" WHEN 'VALID' THEN d.valid_mins WHEN 'INVALID' THEN d.invalid_mins
                                      ELSE d.valid_mins + d.invalid_mins END)::integer AS absent
              FROM cfg c
              JOIN daily d ON c."kind" = 'SHARE' AND d.day > p_as_of - c."windowDays"
             GROUP BY c."id", c."percent", d.student) t
     -- Absence that is going on: the pupil's latest registered day is at most a week old, as a
     -- run's is, so a pupil who was over a limit when term ended is not still over it in July.
     WHERE t.recorded > 0 AND t.absent * 100 >= t."percent" * t.recorded AND t.last_day >= p_as_of - 7
  ),
  -- A day is absence when every registered lesson that day is.
  days AS (
    SELECT c."id" AS limit_id, d.student, d.day,
           CASE c."basis" WHEN 'VALID' THEN d.all_excused WHEN 'INVALID' THEN d.all_absent ELSE d.all_away END AS absent_day
      FROM cfg c
      JOIN daily d ON c."kind" = 'CONSECUTIVE'
  ),
  ranked AS (
    SELECT d.limit_id, d.student, d.day, d.absent_day,
           row_number() OVER (PARTITION BY d.limit_id, d.student ORDER BY d.day DESC) AS rn,
           max(d.day) OVER (PARTITION BY d.limit_id, d.student) AS last_day
      FROM days d
  ),
  -- The run of absence days at the end of the pupil's registered days.
  streaks AS (
    SELECT r.limit_id, r.student,
           coalesce(min(r.rn) FILTER (WHERE NOT r.absent_day) - 1, count(*))::integer AS len,
           max(r.last_day) AS last_day
      FROM ranked r
     GROUP BY r.limit_id, r.student
  ),
  -- The day the run reached the limit is a row of ranked: a join, because a subquery
  -- per pupil over a limit reads all of ranked each time (an influenza wave, with
  -- hundreds of hits and a hundred thousand rows, took the count past its 9 s).
  consecutive AS (
    SELECT s.limit_id, s.student, s.len, r2.day AS reached_on
      FROM streaks s
      JOIN cfg c ON c."id" = s.limit_id
      JOIN ranked r2 ON r2.limit_id = s.limit_id AND r2.student = s.student AND r2.rn = s.len - c."consecutiveDays" + 1
     WHERE s.len >= c."consecutiveDays" AND s.last_day >= p_as_of - 7
  ),
  hits AS (
    SELECT sh.limit_id, sh.student, sh.recorded, sh.absent, NULL::integer AS streak, p_as_of AS crossed_on
      FROM share sh
    UNION ALL
    SELECT co.limit_id, co.student, NULL::integer, NULL::integer, co.len, co.reached_on
      FROM consecutive co
  ),
  upd AS (
    UPDATE "AbsenceWatchFindings" f
       SET "lastSeenOn" = greatest(f."lastSeenOn", p_as_of),
           "recipientGroup" = c."recipientGroup", "kind" = c."kind", "basis" = c."basis",
           "percent" = c."percent", "windowDays" = c."windowDays", "consecutiveDays" = c."consecutiveDays",
           "absentMinutes" = h.absent, "recordedMinutes" = h.recorded, "streakDays" = h.streak
      FROM hits h JOIN cfg c ON c."id" = h.limit_id
     WHERE f."schoolId" = p_school AND f."clearedOn" IS NULL
       AND f."limitId" = h.limit_id AND f."studentId" = h.student
    RETURNING f."limitId", f."studentId"
  ),
  clr AS (
    UPDATE "AbsenceWatchFindings" f
       SET "clearedOn" = greatest(p_as_of, f."lastSeenOn")
     WHERE f."schoolId" = p_school AND f."clearedOn" IS NULL
       AND NOT EXISTS (SELECT 1 FROM hits h WHERE h.limit_id = f."limitId" AND h.student = f."studentId")
    RETURNING 1
  ),
  ins AS (
    INSERT INTO "AbsenceWatchFindings" ("schoolId", "studentId", "limitId", "recipientGroup", "kind", "basis",
                                        "percent", "windowDays", "consecutiveDays",
                                        "firstCrossedOn", "lastSeenOn", "absentMinutes", "recordedMinutes", "streakDays")
    SELECT p_school, h.student, h.limit_id, c."recipientGroup", c."kind", c."basis",
           c."percent", c."windowDays", c."consecutiveDays",
           h.crossed_on, p_as_of, h.absent, h.recorded, h.streak
      FROM hits h JOIN cfg c ON c."id" = h.limit_id
     WHERE NOT EXISTS (SELECT 1 FROM upd u WHERE u."limitId" = h.limit_id AND u."studentId" = h.student)
    ON CONFLICT ("limitId", "studentId") WHERE "clearedOn" IS NULL DO NOTHING
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM ins)::integer,
         (SELECT count(*) FROM upd)::integer,
         (SELECT count(*) FROM clr)::integer,
         (SELECT count(DISTINCT student) FROM daily)::integer
    INTO n_opened, n_kept, n_closed, n_pupils;

  RETURN QUERY SELECT n_opened, n_kept, n_closed, n_pupils;
END
$$;

-- ---------------------------------------------------------------------------
-- The digests.
-- ---------------------------------------------------------------------------

-- The periods of the school that are due and not yet written: for each group
-- that has a limit, the last completed week (Monday to Sunday) or month. A
-- period that ended before the switch went on is not due, and one is due for
-- as long as it has no row in AbsenceWatchDigests, so a night the job missed
-- is made up the next night and never twice.
CREATE FUNCTION app.absence_watch_digest_due(p_school uuid, p_today date)
RETURNS TABLE (recipient_group "AbsenceWatchGroup", period_start date, period_end date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT g.grp, per.start_day, e.end_day
    FROM "AbsenceWatchSettings" s
   CROSS JOIN LATERAL (VALUES ('MENTOR'::"AbsenceWatchGroup", s."mentorCadence"),
                              ('REKTOR'::"AbsenceWatchGroup", s."rektorCadence"),
                              ('KANSLI'::"AbsenceWatchGroup", s."kansliCadence"),
                              ('GUARDIAN'::"AbsenceWatchGroup", s."guardianCadence")) AS g(grp, cadence)
   CROSS JOIN LATERAL (SELECT CASE g.cadence
                                WHEN 'WEEKLY' THEN p_today - extract(isodow FROM p_today)::integer
                                ELSE (date_trunc('month', p_today)::date - 1)
                              END AS end_day) AS e
   CROSS JOIN LATERAL (SELECT CASE g.cadence
                                WHEN 'WEEKLY' THEN e.end_day - 6
                                ELSE date_trunc('month', e.end_day)::date
                              END AS start_day) AS per
   WHERE s."schoolId" = p_school AND s."enabled" AND s."enabledOn" IS NOT NULL
     AND e.end_day >= s."enabledOn"
     AND EXISTS (SELECT 1 FROM "AbsenceWatchLimits" l WHERE l."schoolId" = p_school AND l."recipientGroup" = g.grp)
     AND NOT EXISTS (SELECT 1 FROM "AbsenceWatchDigests" d
                      WHERE d."schoolId" = p_school AND d."recipientGroup" = g.grp AND d."periodEnd" = e.end_day)
   ORDER BY g.grp
$$;

-- Who has something to hear in a group's digest, and about which pupils: the
-- open findings of the group's limits, and those that were crossed in the
-- period (also when the pupil is back under since). open_n and crossed_n are
-- counts of pupils; student_ids are the pupils the digest rests on, the ones
-- app.absence_watch_digest records the recipient as having been told of.
--
--   MENTOR     the mentors of the pupils, as of p_on (the digest's day)
--   GUARDIAN   the pupil's guardians
--   REKTOR     the active administrators with profile REKTOR or FULL
--   KANSLI     the active administrators with profile EXPEDITION
CREATE FUNCTION app.absence_watch_digest_plan(
    p_school uuid, p_group "AbsenceWatchGroup", p_start date, p_end date, p_on date)
RETURNS TABLE (user_id uuid, email text, open_n integer, crossed_n integer, student_ids uuid[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  WITH f AS (
    SELECT x."studentId" AS student, (x."clearedOn" IS NULL) AS is_open,
           (x."firstCrossedOn" BETWEEN p_start AND p_end) AS is_new
      FROM "AbsenceWatchFindings" x
      JOIN "Users" pu ON pu."id" = x."studentId" AND pu."schoolId" = p_school AND pu."isActive"
     WHERE x."schoolId" = p_school AND x."recipientGroup" = p_group
       AND (x."clearedOn" IS NULL OR x."firstCrossedOn" BETWEEN p_start AND p_end)
  ),
  scope AS (
    SELECT mm.mentor_id AS user_id, mm.student_id AS student
      FROM app.absence_watch_mentees(p_school, p_on) mm
     WHERE p_group = 'MENTOR'
    UNION ALL
    SELECT gs."guardianId", gs."studentId"
      FROM "GuardianStudents" gs
     WHERE gs."schoolId" = p_school AND p_group = 'GUARDIAN'
    UNION ALL
    SELECT a."id", fs.student
      FROM "Users" a
     CROSS JOIN (SELECT DISTINCT f.student FROM f) fs
     WHERE a."schoolId" = p_school AND a."role" = 'SCHOOL_ADMIN' AND a."isActive"
       AND ((p_group = 'REKTOR' AND a."adminProfile" IN ('REKTOR', 'FULL'))
            OR (p_group = 'KANSLI' AND a."adminProfile" = 'EXPEDITION'))
  )
  SELECT u."id", u."email",
         (count(DISTINCT f.student) FILTER (WHERE f.is_open))::integer,
         (count(DISTINCT f.student) FILTER (WHERE f.is_new))::integer,
         array_agg(DISTINCT f.student ORDER BY f.student)
    FROM scope s
    JOIN f ON f.student = s.student
    JOIN "Users" u ON u."id" = s.user_id AND u."schoolId" = p_school AND u."isActive"
                  AND u."role" = CASE p_group WHEN 'MENTOR' THEN 'TEACHER' WHEN 'GUARDIAN' THEN 'GUARDIAN' ELSE 'SCHOOL_ADMIN' END::"UserRole"
   GROUP BY u."id", u."email"
   ORDER BY u."id"
$$;

-- Writes one group's digest: the ledger row (once per school, group and period
-- end: a second call writes nothing and answers nothing), a row in the read log
-- for each recipient with something to hear (see the preamble) and their notice.
-- Answers what it wrote, with the addresses, for the e-mail and the push the
-- gateway sends after the commit.
--
-- ONE STATEMENT. The plan is read once, as a materialised CTE, and the ledger,
-- the read log and the notices are all written from that one reading, in a
-- single statement with a single snapshot: a recipient cannot be told without a
-- row in the log, or the ledger count a recipient the notices left out, whatever
-- commits beside it. The count of the school's nightly run (app.absence_watch_evaluate)
-- is waited for first, so the digest is of what that count left.
CREATE FUNCTION app.absence_watch_digest(
    p_school uuid, p_group "AbsenceWatchGroup", p_start date, p_end date, p_on date)
RETURNS TABLE (notification_id uuid, user_id uuid, email text, meta jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
#variable_conflict use_column
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('absence-watch:' || p_school::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('absence-watch-digest:' || p_school::text || ':' || p_group::text, 0));
  PERFORM 1 FROM "AbsenceWatchSettings" s WHERE s."schoolId" = p_school AND s."enabled" FOR SHARE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  RETURN QUERY
  WITH plan AS MATERIALIZED (
    SELECT * FROM app.absence_watch_digest_plan(p_school, p_group, p_start, p_end, p_on)
  ),
  ledger AS (
    INSERT INTO "AbsenceWatchDigests" ("schoolId", "recipientGroup", "periodStart", "periodEnd", "recipients", "pupils")
    SELECT p_school, p_group, p_start, p_end,
           (SELECT count(*) FROM plan)::integer,
           (SELECT count(DISTINCT pupil) FROM plan p, LATERAL unnest(p.student_ids) AS pupil)::integer
    ON CONFLICT ("schoolId", "recipientGroup", "periodEnd") DO NOTHING
    RETURNING 1
  ),
  -- As personal_data_read does, it leaves out the reader and whoever the reader has of the
  -- kind from the last quarter-hour, and keeps the read's whole size.
  logged AS (
    INSERT INTO "PersonalDataAccess" ("schoolId", "actorId", "actorRole", "channel", "kind", "subjectIds", "readSize")
    SELECT p_school, p.user_id, u."role", 'OTHER', 'ATTENDANCE', fresh.ids, cardinality(p.student_ids)
      FROM plan p
      JOIN "Users" u ON u."id" = p.user_id AND u."schoolId" = p_school
     CROSS JOIN LATERAL (
           SELECT coalesce(array_agg(pupil ORDER BY pupil), '{}'::uuid[]) AS ids
             FROM unnest(p.student_ids) AS pupil
            WHERE pupil <> p.user_id
              AND NOT EXISTS (
                    SELECT 1 FROM "PersonalDataAccess" a
                     WHERE a."actorId" = p.user_id AND a."kind" = 'ATTENDANCE'
                       AND a."at" > clock_timestamp() - interval '15 minutes'
                       AND a."channel" <> 'CALENDAR' AND pupil = ANY (a."subjectIds"))
           ) fresh
     WHERE EXISTS (SELECT 1 FROM ledger) AND cardinality(fresh.ids) > 0
    RETURNING 1
  ),
  written AS (
    INSERT INTO "Notifications" ("schoolId", "userId", "type", "meta")
    SELECT p_school, p.user_id, 'ABSENCE_WATCH_DIGEST',
           jsonb_build_object('group', p_group::text, 'periodStart', p_start, 'periodEnd', p_end,
                              'open', p.open_n, 'crossed', p.crossed_n)
      FROM plan p
     WHERE EXISTS (SELECT 1 FROM ledger)
    RETURNING "id", "userId", "meta"
  )
  SELECT w."id", w."userId", pl.email, w."meta"
    FROM written w JOIN plan pl ON pl.user_id = w."userId";
END
$$;

-- ---------------------------------------------------------------------------
-- Row-level security and grants. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "AbsenceWatchSettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AbsenceWatchLimits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AbsenceWatchFindings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AbsenceWatchDigests" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r text;
  tbl text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    -- Settings and limits: the school's administrators read, Drift writes.
    CREATE POLICY "absence_watch_settings_admin_select" ON "AbsenceWatchSettings"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "absence_watch_settings_admin_insert" ON "AbsenceWatchSettings"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true)));
    CREATE POLICY "absence_watch_settings_admin_update" ON "AbsenceWatchSettings"
        FOR UPDATE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true)));

    CREATE POLICY "absence_watch_limits_admin_select" ON "AbsenceWatchLimits"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "absence_watch_limits_admin_insert" ON "AbsenceWatchLimits"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true)));
    CREATE POLICY "absence_watch_limits_admin_update" ON "AbsenceWatchLimits"
        FOR UPDATE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true)));
    CREATE POLICY "absence_watch_limits_admin_delete" ON "AbsenceWatchLimits"
        FOR DELETE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
               AND (select app.current_user_may('DRIFT', true)));

    -- Findings: three read arms, one per kind of reader, and no write arm.
    CREATE POLICY "absence_watch_findings_admin_select" ON "AbsenceWatchFindings"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "absence_watch_findings_mentor_select" ON "AbsenceWatchFindings"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'TEACHER'
               AND "recipientGroup" = 'MENTOR'
               AND app.absence_watch_is_mentor_of("studentId"));
    CREATE POLICY "absence_watch_findings_guardian_select" ON "AbsenceWatchFindings"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'GUARDIAN'
               AND "recipientGroup" = 'GUARDIAN'
               AND "studentId" = ANY ((select app.current_guardian_child_ids())::uuid[]));

    CREATE POLICY "absence_watch_digests_admin_select" ON "AbsenceWatchDigests"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

    FOREACH tbl IN ARRAY ARRAY['AbsenceWatchSettings', 'AbsenceWatchLimits', 'AbsenceWatchFindings', 'AbsenceWatchDigests'] LOOP
      EXECUTE format('REVOKE ALL ON %I FROM "app_authenticated"', tbl);
    END LOOP;
    GRANT SELECT, INSERT, UPDATE ON "AbsenceWatchSettings" TO "app_authenticated";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "AbsenceWatchLimits" TO "app_authenticated";
    GRANT SELECT ON "AbsenceWatchFindings" TO "app_authenticated";
    GRANT SELECT ON "AbsenceWatchDigests" TO "app_authenticated";
  END IF;

  FOREACH tbl IN ARRAY ARRAY['AbsenceWatchSettings', 'AbsenceWatchLimits', 'AbsenceWatchFindings', 'AbsenceWatchDigests'] LOOP
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
-- Gallring: the findings go with the attendance they are counted from. Both
-- bodies are 20261026091000's plus the lines marked "frånvarobevakning".
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

COMMENT ON FUNCTION app.absence_watch_evaluate(uuid, date) IS
  'Frånvarobevakning: who is over which limit as of the end of p_as_of (a day that has passed, in the school''s dates); opens, refreshes and closes findings; answers how many.';
COMMENT ON FUNCTION app.absence_watch_digest_due(uuid, date) IS
  'Frånvarobevakning: the groups whose last completed week or month has no digest yet.';
COMMENT ON FUNCTION app.absence_watch_digest_plan(uuid, "AbsenceWatchGroup", date, date, date) IS
  'Frånvarobevakning: the recipients of a group''s digest with the counts they would hear and the pupils the digest rests on. Returns no login id. Run by app.absence_watch_digest as the owner; the API role holds no EXECUTE on it.';
COMMENT ON FUNCTION app.absence_watch_digest(uuid, "AbsenceWatchGroup", date, date, date) IS
  'Frånvarobevakning: writes a group''s digest once per period, with a read-log row for each recipient, and answers the notices with the addresses, for the delivery after the commit.';

DO $$
DECLARE
  fn text;
  r text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'app.absence_watch_settings_stamp()',
    'app.absence_watch_settings_stop()',
    'app.absence_watch_limits_stamp()',
    'app.absence_watch_limits_removed()',
    'app.absence_watch_mentees(uuid, date)',
    'app.absence_watch_is_mentor_of(uuid)',
    'app.absence_watch_schools()',
    'app.absence_watch_evaluate(uuid, date)',
    'app.absence_watch_digest_due(uuid, date)',
    'app.absence_watch_digest_plan(uuid, "AbsenceWatchGroup", date, date, date)',
    'app.absence_watch_digest(uuid, "AbsenceWatchGroup", date, date, date)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', fn, r);
      END IF;
    END LOOP;
  END LOOP;
  -- The API role runs the policy's question and the job's four calls. The
  -- trigger functions, the mentee list and the plan are the owner's: a trigger
  -- needs no grant, and the digest functions call the list and the plan as the
  -- owner. The gateway never asks for the plan, and the plan answers the
  -- addresses and the pupils of any school it is given.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    FOREACH fn IN ARRAY ARRAY[
      'app.absence_watch_is_mentor_of(uuid)',
      'app.absence_watch_schools()',
      'app.absence_watch_evaluate(uuid, date)',
      'app.absence_watch_digest_due(uuid, date)',
      'app.absence_watch_digest(uuid, "AbsenceWatchGroup", date, date, date)'
    ] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO "app_authenticated"', fn);
    END LOOP;
  END IF;
END
$$;
