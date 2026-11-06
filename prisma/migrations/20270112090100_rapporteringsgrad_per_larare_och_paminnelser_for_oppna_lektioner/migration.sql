-- Rapporteringsgrad: varje lärares andel lektioner med sparat register,
-- påminnelser för öppna lektioner och ett veckobesked till rektor.
--
-- Skola24 Frånvaro köps också för att rektor ska se vilka lärare som inte
-- tagit närvaro, och WebUntis påminner om öppna lektioner. Rastra hade
-- närvaron och lärarna på lektionerna men ingen som lade ihop dem. Den här
-- migreringen gör det: en definition av en rapporterad lektion, ett nattligt
-- jobb som lagrar varje lärares dag, en vy för rektor, en för läraren själv och
-- två påminnelser som skolan slår på.
--
-- ## Definitionen, en enda, i app.reporting_lessons
--
-- En lektion räknas för en lärare när
--
--   1. den har slutat (endsAt <= nu);
--   2. den hålls: status SCHEDULED eller COMPLETED. En inställd lektion
--      räknas aldrig, vad som än sparats på den, och inte heller en lektion
--      som ett lov tagit bort, för lovet tar bort lektionerna (det är inga
--      rader att räkna) eller ställer in dem;
--   3. läraren står på den (CalendarLessonTeachers), är en aktiv lärare och
--      hör till skolan. Villkor 1-3 är, utom lärarens roll, de levererad tid
--      (P3, src/timplan/timplan-delivered.sql.ts) ställer på en hållen lektion
--      med lärare, och samma statusar som Frånvarobevakning räknar
--      (20261231090100). En avaktiverad lärare och en administratör som står
--      på en lektion är ingen lärare här: ingen kan påminnas, och en rad med
--      noll procent för någon som slutat är ett mått på ingen. Ingen ny gren: en
--      ersättningslektion (Schemabrytande aktivitet, 20270101090000) är en
--      lektion som alla andra och räknas hos de lärare som står på den, och en
--      vikarie står på de lektioner den tagit, i stället för den frånvarande
--      (en vikariefråga, Vikariefrågan 20270102091000, och tavlans beslut gör
--      det genom att byta raden);
--   4. läraren inte själv är frånvarande då: en aktiv frånvaro
--      (TeacherAbsences) som överlappar lektionen tar den ur räkningen för
--      den läraren. En lektion som ingen tagit beslut om ligger kvar på den
--      frånvarande, som inte kan ha tagit närvaro;
--   5. lektionen har någon elev på sin lista, eller har redan ett sparat
--      register. Ett register kan bara sparas för en elev på listan, så en
--      lektion utan elever kan aldrig bli rapporterad, och läraren kan inte göra
--      något åt det: den räknas varken som hållen, som öppen eller som
--      rapporterad. Listan är registrets egen (calendar/lesson-roster.ts), men
--      läst så att en dag som en gång räknats inte ändras av att tiden går:
--
--        * hemklassens elever i lektionens klass och i grupperna lagda på den
--          räknas både som de är nu (aktiva elever i Users.studentGroupId, de
--          som läraren kan ta närvaro på nu) och som de var på lektionens dag
--          (StudentEnrollments, klasshistoriken: ett segment [validFrom,
--          validTo) som täcker datumet). Läsårsaktiveringen flyttar varje elev
--          till nästa års klass och tömmer förra årets, men historiken har kvar
--          vilka som satt där till årets slut; en lektion är orapporterbar bara
--          om ingen satt i klassen då och ingen kan markeras nu;
--        * medlemmarna i en undervisningsgrupp (StudentGroupMembers) och elever
--          lektionen namnger (CalendarLessonStudents) saknar datum, så de räknas
--          som de är registrerade, vad eleven är nu (aktiv eller inte, men en
--          elev): det registret tar emot för sparande (RECORDED), och en elev
--          som slutat sedan lektionen hölls ändrar inte dess dag.
--
--      Ett register som redan är sparat är alltid ett register, vad listan än
--      har blivit sedan: lektionen är hållen och rapporterad.
--      Ersättande grupper (SvA7 tar eleverna ur svenskan) räknas inte av här: en
--      lektion där varje elev tas bort av en sådan grupp räknas ändå som hållen.
--      Det ger sällan noll, och regeln är för lång att skriva två gånger. En
--      aktivering före det gamla årets slut stänger klassens segment den dagen,
--      så en klass tom därefter tar sina sista veckors oregistrerade lektioner
--      med sig ur dagarna.
--
-- Lektionen är rapporterad när dess register är sparat: minst en markering
-- som inte är UNKNOWN. Det är registrets enda skrivare
-- (AttendanceService.reportAttendance) och samma markeringar som
-- Frånvarobevakning räknar; webbens register skickar bara de elever läraren
-- tagit ställning till. En lektion räknas för varje lärare som står på den, och
-- registret är lektionens, så en kollega som sparat det har rapporterat det
-- också för den andra.
--
-- ## Lagrat per lärare och dag
--
-- Betygen över veckor, månader och läsår läggs ihop ur TeacherReportingDays:
-- en rad per lärare och dag med antal hållna och rapporterade lektioner, dagen
-- i skolans datum (CalendarLessons.date). Raderna räknas inte om live ur
-- närvaron, av två skäl. Gallring raderar närvaro efter skolans beslut, och en
-- vy som räknade om skulle då visa varje gammal lektion som orapporterad; de
-- lagrade raderna gallras i stället med närvaron (se nedan). Och D6,
-- frånvarostatistik över tid, behöver en grad för tre år bakåt.
--
-- Jobbet räknar om de senaste 90 dagarna varje natt (app.reporting_compute),
-- eftersom ett register kan sparas dagar efter lektionen; en dag äldre än så
-- är färdig. Rader skrivs bara när de ändras, och en dag som inte längre har en
-- hållen lektion tas bort. Har skolan någon gång beslutat att gallra närvaro
-- räknas bara dagar från den kortaste gallringstid den någonsin valt om, också
-- sedan den bytt till att bevara: en dag vars närvaro kan ha gallrats får aldrig
-- skrivas över med en grad som bara är ett tomt register.
--
-- ## Påminnelser och veckobesked, av som standard
--
--   ReportingSettings.teacherReminders  en lärare får ett besked när en
--       lektion stått öppen längre än openAfterDays dagar (kalenderdagar i
--       skolans datum, inte 24 timmar: ett dygn byter längd vid sommartid).
--       Ett besked per lärare och natt med antalet lektioner som passerat
--       gränsen sedan förra beskedet, aldrig ämne, klass eller tid; en lektion
--       påminns högst en gång per lärare (ReportingReminders). Inte på
--       helger, och inte om lektionen ligger före dagen påminnelserna slogs på
--       eller äldre än 30 dagar.
--   ReportingSettings.rektorDigest  rektor (profilen REKTOR eller FULL) får en
--       gång i veckan, måndag, förra veckans andel i skolan som helhet: antal
--       hållna och rapporterade lektioner och hur många lärare de fördelar
--       sig på. Aldrig ett namn.
--
-- Båda är av som standard, och gränsen (openAfterDays, 1 till 30, två dagar
-- från början) är skolans.
--
-- ## Vem ser vad
--
-- Raderna når bara gatewayen (alla läsarmar är TO app_authenticated), som
-- loggar varje läsning av andras rader i läsloggen (EMPLOYMENT).
--
--   en lärare            sina egna dagar (reporting_days_teacher_select) och
--                        skolans gräns; sina öppna lektioner genom
--                        app.reporting_open_lessons, som bara svarar för den
--                        inloggade
--   en administratör     alla lärares dagar, varje profil (läsaren också);
--                        gränsen och påminnelsernas knappar skriver Drift
--   en elev, en vårdnadshavare, anon, authenticated  ingenting
--
-- ## Gallring
--
-- Dagarna och påminnelsernas rader är närvaro i en annan form och gallras som
-- den: gallringstypen ATTENDANCE gäller dem, med dagen respektive lektionens
-- datum som datum. Ingen ny RetentionDataType behövs. app.gallring_due och
-- app.gallring_purge nedan är 20270107090000:s kroppar (Skyddad identitets, som
-- bär Vikariefrågans och Frånvarobevakningens grenar) plus grenarna märkta
-- "rapporteringsgrad". Påminnelsernas rader rensas dessutom av
-- app.reporting_remind själv efter 60 dagar, eftersom de bara behövs så länge
-- en lektion kan påminnas om.
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
-- tabellerna och skriver aldrig en notis av de nya typerna. Inget lås tas på
-- CalendarLessons: påminnelserna pekar på en lektion med ett id utan främmande
-- nyckel, och en rad vars lektion försvunnit är ofarlig och rensas.

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
        RAISE EXCEPTION 'Schools and Users were not free at once in 30 s: nothing is changed. Prisma now holds this migration as failed, so run "prisma migrate resolve --rolled-back 20270112090100_rapporteringsgrad_per_larare_och_paminnelser_for_oppna_lektioner" and then "prisma migrate deploy" again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- ReportingSettings
-- ---------------------------------------------------------------------------

CREATE TABLE "ReportingSettings" (
    "schoolId" UUID NOT NULL,
    -- Påminnelser till lärare om lektioner som stått öppna. Av från början.
    "teacherReminders" BOOLEAN NOT NULL DEFAULT false,
    -- Skolans lokala datum då den senast slogs på, satt av triggern; NULL så
    -- länge den aldrig varit på. En lektion före det datumet påminns inte om.
    "teacherRemindersOn" DATE,
    -- Veckobeskedet till rektor. Av från början.
    "rektorDigest" BOOLEAN NOT NULL DEFAULT false,
    -- Datumet den slogs på; en vecka som slutade före det får inget besked.
    "rektorDigestOn" DATE,
    -- Så många kalenderdagar efter lektionens dag får ett register vänta innan
    -- lektionen räknas som öppen för länge.
    "openAfterDays" SMALLINT NOT NULL DEFAULT 2,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportingSettings_pkey" PRIMARY KEY ("schoolId"),
    CONSTRAINT "ReportingSettings_open_after_days_is_sane" CHECK ("openAfterDays" BETWEEN 1 AND 30),
    CONSTRAINT "ReportingSettings_on_has_a_date" CHECK (
        (NOT "teacherReminders" OR "teacherRemindersOn" IS NOT NULL)
        AND (NOT "rektorDigest" OR "rektorDigestOn" IS NOT NULL))
);

ALTER TABLE "ReportingSettings"
    ADD CONSTRAINT "ReportingSettings_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- TeacherReportingDays
-- ---------------------------------------------------------------------------

CREATE TABLE "TeacherReportingDays" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "teacherId" UUID NOT NULL,
    -- Skolans lokala datum (CalendarLessons.date).
    "day" DATE NOT NULL,
    -- Lärarens hållna lektioner den dagen och hur många av dem som har ett
    -- sparat register. Aldrig en rad utan en hållen lektion.
    "held" INTEGER NOT NULL,
    "reported" INTEGER NOT NULL,
    "changedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "TeacherReportingDays_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TeacherReportingDays_counts_are_counts" CHECK ("held" > 0 AND "reported" >= 0 AND "reported" <= "held")
);

-- En rad per lärare och dag: det ON CONFLICT i app.reporting_compute pekar på,
-- och den främmande nyckelns index när en person tas bort.
CREATE UNIQUE INDEX "TeacherReportingDays_teacherId_schoolId_day_key"
    ON "TeacherReportingDays"("teacherId", "schoolId", "day");
-- Rektors vy över en period och gallringens villkor.
CREATE INDEX "TeacherReportingDays_schoolId_day_idx" ON "TeacherReportingDays"("schoolId", "day");

ALTER TABLE "TeacherReportingDays"
    ADD CONSTRAINT "TeacherReportingDays_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeacherReportingDays"
    ADD CONSTRAINT "TeacherReportingDays_teacherId_schoolId_fkey" FOREIGN KEY ("teacherId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- ReportingReminders
-- ---------------------------------------------------------------------------

-- Vilka lektioner en lärare redan påmints om, så att ingen lektion påminns
-- om två gånger. Lektionen är ett id utan främmande nyckel, med avsikt: det
-- här är en liten bokföring av beskeden, inte en uppgift om lektionen, och
-- migreringen låser därför inte CalendarLessons. Raden rensas efter 60 dagar.
CREATE TABLE "ReportingReminders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "teacherId" UUID NOT NULL,
    "calendarLessonId" UUID NOT NULL,
    "lessonDate" DATE NOT NULL,
    "remindedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "ReportingReminders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReportingReminders_lesson_teacher_key"
    ON "ReportingReminders"("calendarLessonId", "teacherId");
-- Den främmande nyckelns kaskad när en person tas bort.
CREATE INDEX "ReportingReminders_teacherId_schoolId_idx" ON "ReportingReminders"("teacherId", "schoolId");
-- Rensningens och gallringens villkor.
CREATE INDEX "ReportingReminders_schoolId_lessonDate_idx" ON "ReportingReminders"("schoolId", "lessonDate");

ALTER TABLE "ReportingReminders"
    ADD CONSTRAINT "ReportingReminders_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReportingReminders"
    ADD CONSTRAINT "ReportingReminders_teacherId_schoolId_fkey" FOREIGN KEY ("teacherId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- ReportingDigests
-- ---------------------------------------------------------------------------

-- Huvudboken över skrivna veckobesked: en rad per skola och veckoslut. Den gör
-- att ett besked skrivs en gång även om jobbet körs två gånger. Bara antal,
-- inga personuppgifter.
CREATE TABLE "ReportingDigests" (
    "schoolId" UUID NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "composedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "recipients" INTEGER NOT NULL,
    "teachers" INTEGER NOT NULL,
    "held" INTEGER NOT NULL,
    "reported" INTEGER NOT NULL,

    CONSTRAINT "ReportingDigests_pkey" PRIMARY KEY ("schoolId", "periodEnd"),
    CONSTRAINT "ReportingDigests_period_is_ordered" CHECK ("periodEnd" >= "periodStart"),
    CONSTRAINT "ReportingDigests_counts_are_counts" CHECK (
        "recipients" >= 0 AND "teachers" >= 0 AND "held" >= 0 AND "reported" >= 0 AND "reported" <= "held")
);

ALTER TABLE "ReportingDigests"
    ADD CONSTRAINT "ReportingDigests_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- The switches' dates.
-- ---------------------------------------------------------------------------

-- teacherRemindersOn and rektorDigestOn are the trigger's: a writer cannot set
-- them. Each is the school's local date when its switch last went from off to
-- on, and NULL for one that never was.
CREATE FUNCTION app.reporting_settings_stamp() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  today date := (clock_timestamp() AT TIME ZONE coalesce(
      (SELECT s."timezone" FROM "Schools" s WHERE s."id" = NEW."schoolId"), 'Europe/Stockholm'))::date;
BEGIN
  NEW."updatedAt" := now();
  IF NEW."teacherReminders" AND (TG_OP = 'INSERT' OR NOT OLD."teacherReminders") THEN
    NEW."teacherRemindersOn" := today;
  ELSIF TG_OP = 'INSERT' THEN
    NEW."teacherRemindersOn" := NULL;
  ELSE
    NEW."teacherRemindersOn" := OLD."teacherRemindersOn";
  END IF;
  IF NEW."rektorDigest" AND (TG_OP = 'INSERT' OR NOT OLD."rektorDigest") THEN
    NEW."rektorDigestOn" := today;
  ELSIF TG_OP = 'INSERT' THEN
    NEW."rektorDigestOn" := NULL;
  ELSE
    NEW."rektorDigestOn" := OLD."rektorDigestOn";
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ReportingSettings_stamp"
    BEFORE INSERT OR UPDATE ON "ReportingSettings"
    FOR EACH ROW EXECUTE FUNCTION app.reporting_settings_stamp();

-- ---------------------------------------------------------------------------
-- The definition: one function, read by every caller.
-- ---------------------------------------------------------------------------

-- A row per held lesson of the school dated p_from..p_to that has ended by
-- p_now, and per active teacher on it: whether its register is saved. See the
-- preamble; this is the one place the rule is written. Not SECURITY DEFINER and
-- with no SET, so it can be inlined, which the planner does when p_now is no
-- volatile call. The teacher's list passes now() and is inlined, so that its
-- filter on the teacher is a condition of the join with the teacher rows; the
-- nightly callers pass clock_timestamp() and get it as a function scan, run
-- once for the whole school, which is what they ask for. The register check
-- names the teacher row's lesson (t."calendarLessonId", the same id as
-- cl."id" by the join), and so does the roster test, which is OR-ed with it:
-- a condition that touches only the lesson is run for every lesson the scan
-- reads, a school's month, before the join with the teacher cuts them to the
-- teacher's few; one that touches the teacher row is run after it. Every name
-- is schema-qualified because an inlined body runs under its caller's search
-- path. The owner's alone: nobody else may ask it for another person's rows.
CREATE FUNCTION app.reporting_lessons(p_school uuid, p_from date, p_to date, p_now timestamptz)
RETURNS TABLE (lesson_id uuid, teacher_id uuid, day date,
               starts_at timestamptz, ends_at timestamptz, reported boolean)
LANGUAGE sql STABLE AS $$
  SELECT cl."id", t."teacherId", cl."date", cl."startsAt", cl."endsAt", r."saved"
    FROM "public"."CalendarLessons" cl
    JOIN "public"."CalendarLessonTeachers" t
      ON t."calendarLessonId" = cl."id" AND t."schoolId" = cl."schoolId"
    JOIN "public"."Users" u
      ON u."id" = t."teacherId" AND u."schoolId" = cl."schoolId"
     AND u."role" = 'TEACHER' AND u."isActive"
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

-- ---------------------------------------------------------------------------
-- The nightly count.
-- ---------------------------------------------------------------------------

-- The schools with a lesson in the last 90 days: what the job asks before it
-- claims a night. Every such school is counted; only the reminders and the
-- weekly notice are switches.
CREATE FUNCTION app.reporting_schools() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT s."id" FROM "Schools" s
   WHERE EXISTS (SELECT 1 FROM "CalendarLessons" cl
                  WHERE cl."schoolId" = s."id"
                    AND cl."date" >= (clock_timestamp() AT TIME ZONE s."timezone")::date - 90)
   ORDER BY s."id"
$$;

-- The school's days up to and including p_as_of (a day that has passed, in the
-- school's local dates), the last 90 of them: writes a row for each teacher and
-- day with a held lesson, rewrites the rows whose figures changed, and removes
-- the rows whose day has no held lesson any more. Answers how many it wrote and
-- removed, how many teachers had a held lesson, and the lessons' totals.
-- Serialised per school. Days from the cutoff of the shortest period the
-- school has ever chosen to purge attendance after, only: see the preamble.
CREATE FUNCTION app.reporting_compute(p_school uuid, p_as_of date)
RETURNS TABLE (written integer, removed integer, teachers integer, held integer, reported integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
#variable_conflict use_column
DECLARE
  tz text;
  today date;
  first_day date;
  cutoff date;
  shortest integer;
  n_written integer;
  n_removed integer;
  n_teachers integer;
  n_held integer;
  n_reported integer;
BEGIN
  SELECT s."timezone" INTO tz FROM "Schools" s WHERE s."id" = p_school;
  IF tz IS NULL THEN
    RAISE EXCEPTION 'REPORTING_NO_SCHOOL' USING ERRCODE = 'RR404';
  END IF;
  today := (clock_timestamp() AT TIME ZONE tz)::date;
  IF p_as_of IS NULL OR p_as_of >= today THEN
    RAISE EXCEPTION 'REPORTING_DAY_IS_NOT_OVER: graden räknas till och med en dag som gått'
      USING ERRCODE = 'RR400';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('reporting-rate:' || p_school::text, 0));

  first_day := p_as_of - 89;
  -- A school that has chosen to purge attendance: a day before the cutoff of the
  -- shortest period it has chosen (a decision to keep afterwards does not give
  -- the marks back) may have lost its marks, and counted again it would read as
  -- a day nobody reported. A decision that is not in force yet counts: it is a
  -- day's notice, and the days it will reach are final already.
  SELECT min(d."months") INTO shortest FROM "RetentionDecisions" d
   WHERE d."schoolId" = p_school AND d."dataType" = 'ATTENDANCE' AND d."decision" = 'PURGE_AFTER';
  cutoff := app.retention_cutoff(p_school, shortest, clock_timestamp());
  IF cutoff IS NOT NULL THEN
    first_day := greatest(first_day, cutoff);
  END IF;

  -- What the lessons say, what is stored, and the two side by side in one FULL JOIN: a join that cannot be
  -- a nested loop, so that the night costs the same whatever the planner thinks the lessons come to (a NOT
  -- EXISTS against the counted days was planned as one, and took a second more than the count itself).
  WITH counted AS MATERIALIZED (
    SELECT l.teacher_id, l.day,
           count(*)::integer AS held,
           (count(*) FILTER (WHERE l.reported))::integer AS reported
      FROM app.reporting_lessons(p_school, first_day, p_as_of, clock_timestamp()) l
     GROUP BY l.teacher_id, l.day
  ),
  diff AS MATERIALIZED (
    SELECT d."id" AS old_id, d."held" AS old_held, d."reported" AS old_reported,
           c.teacher_id, c.day, c.held, c.reported
      FROM (SELECT x."id", x."teacherId", x."day", x."held", x."reported" FROM "TeacherReportingDays" x
             WHERE x."schoolId" = p_school AND x."day" BETWEEN first_day AND p_as_of) d
      FULL JOIN counted c ON c.teacher_id = d."teacherId" AND c.day = d."day"
  ),
  up AS (
    INSERT INTO "TeacherReportingDays" ("schoolId", "teacherId", "day", "held", "reported")
    SELECT p_school, f.teacher_id, f.day, f.held, f.reported FROM diff f
     WHERE f.teacher_id IS NOT NULL
       AND (f.old_id IS NULL OR (f.old_held, f.old_reported) IS DISTINCT FROM (f.held, f.reported))
    ON CONFLICT ("teacherId", "schoolId", "day") DO UPDATE
       SET "held" = EXCLUDED."held", "reported" = EXCLUDED."reported", "changedAt" = clock_timestamp()
    RETURNING 1
  ),
  gone AS (
    DELETE FROM "TeacherReportingDays" d
     WHERE d."id" IN (SELECT f.old_id FROM diff f WHERE f.teacher_id IS NULL)
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM up)::integer,
         (SELECT count(*) FROM gone)::integer,
         (SELECT count(DISTINCT c.teacher_id) FROM counted c)::integer,
         (SELECT coalesce(sum(c.held), 0) FROM counted c)::integer,
         (SELECT coalesce(sum(c.reported), 0) FROM counted c)::integer
    INTO n_written, n_removed, n_teachers, n_held, n_reported;

  RETURN QUERY SELECT n_written, n_removed, n_teachers, n_held, n_reported;
END
$$;

-- ---------------------------------------------------------------------------
-- The teacher's own open lessons.
-- ---------------------------------------------------------------------------

-- The caller's held lessons of the last p_days days (1..90) with no saved
-- register, newest first, with the subject's and the class's names, and whether
-- the lesson has stood open longer than the school's limit. For the caller
-- alone: the identity is the claims', so the function can be asked by the
-- gateway in anybody's request and answers that person only. A caller who is
-- not a teacher, and the delivery's principal, get nothing.
--
-- It asks for the school, the person and the day once, in a CTE the planner may
-- not fold back, and hands them to the definition as values. The helpers are
-- SECURITY DEFINER functions that look the caller up, so left in a filter they
-- are called for every lesson the planner reads (a school's lessons of a month,
-- not the teacher's own). The teacher is a scalar subquery of the CTE, which the
-- planner takes as a parameter and can match against the teacher rows' index.
-- The definition runs inlined, which it only does for a stable p_now (now(),
-- never clock_timestamp()), and its register and roster conditions are written
-- to run after the join with the teacher (see the definition). On a school of
-- 60 classes, 120 teachers and 80 000 lessons the list takes 7-12 ms for 30
-- days and 10 ms for 90 (24 and 58 ms with the teacher a plain CTE column, 70
-- and 220 ms in the first version). scripts/bench/reporting-rate.sql times it.
CREATE FUNCTION app.reporting_open_lessons(p_days integer DEFAULT 30)
RETURNS TABLE (lesson_id uuid, day date, starts_at timestamptz, ends_at timestamptz,
               subject_name text, group_name text, overdue boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  WITH me AS MATERIALIZED (
    SELECT app.current_school_id() AS school, app.current_user_id() AS teacher, app.school_today() AS today
  )
  SELECT l.lesson_id, l.day, l.starts_at, l.ends_at, sj."name", g."name",
         l.day <= me.today - coalesce(
           (SELECT st."openAfterDays" FROM "ReportingSettings" st WHERE st."schoolId" = me.school), 2)
    FROM me
   CROSS JOIN LATERAL app.reporting_lessons(
           me.school, me.today - least(greatest(p_days, 1), 90), me.today, now()) l
    JOIN "CalendarLessons" cl ON cl."id" = l.lesson_id
    JOIN "Subjects" sj ON sj."id" = cl."subjectId"
    JOIN "StudentGroups" g ON g."id" = cl."studentGroupId"
   WHERE l.teacher_id = (SELECT me2.teacher FROM me me2)
     AND NOT l.reported
   ORDER BY l.starts_at DESC, l.lesson_id
$$;

-- ---------------------------------------------------------------------------
-- The reminders.
-- ---------------------------------------------------------------------------

-- Tells each teacher of the lessons that have stood open longer than the
-- school's limit and that they were not told of before: the ledger rows and the
-- notices are written in one statement, so a teacher cannot be told without a
-- row to say so, or have a row without the notice. Answers the notices with the
-- addresses, for the e-mail and the push the gateway sends after the commit.
-- Nothing when the switch is off, on a Saturday or a Sunday (p_today is the
-- school's local date), and nothing for a lesson dated before the switch went
-- on or more than 30 days ago.
CREATE FUNCTION app.reporting_remind(p_school uuid, p_today date)
RETURNS TABLE (notification_id uuid, user_id uuid, email text, meta jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
#variable_conflict use_column
DECLARE
  st "ReportingSettings";
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('reporting-remind:' || p_school::text, 0));
  SELECT * INTO st FROM "ReportingSettings" s WHERE s."schoolId" = p_school AND s."teacherReminders" FOR SHARE;
  IF NOT FOUND OR extract(isodow FROM p_today) >= 6 THEN
    RETURN;
  END IF;
  DELETE FROM "ReportingReminders" r WHERE r."schoolId" = p_school AND r."lessonDate" < p_today - 60;
  RETURN QUERY
  WITH due AS MATERIALIZED (
    SELECT l.lesson_id, l.teacher_id, l.day
      FROM app.reporting_lessons(
             p_school, greatest(p_today - 30, st."teacherRemindersOn"), p_today - st."openAfterDays", clock_timestamp()) l
     WHERE NOT l.reported
  ),
  -- Once per lesson and teacher: the ledger's key says so, and a lesson already in it adds no row here.
  ledger AS (
    INSERT INTO "ReportingReminders" ("schoolId", "teacherId", "calendarLessonId", "lessonDate")
    SELECT p_school, d.teacher_id, d.lesson_id, d.day FROM due d
    ON CONFLICT ("calendarLessonId", "teacherId") DO NOTHING
    RETURNING "teacherId"
  ),
  per_teacher AS (
    SELECT g."teacherId" AS user_id, count(*)::integer AS n FROM ledger g GROUP BY g."teacherId"
  ),
  written AS (
    INSERT INTO "Notifications" ("schoolId", "userId", "type", "meta")
    SELECT p_school, pt.user_id, 'LESSON_REPORT_REMINDER',
           jsonb_build_object('count', pt.n, 'limitDays', st."openAfterDays")
      FROM per_teacher pt
    RETURNING "id", "userId", "meta"
  )
  SELECT w."id", w."userId", u."email", w."meta"
    FROM written w JOIN "Users" u ON u."id" = w."userId" AND u."schoolId" = p_school;
END
$$;

-- ---------------------------------------------------------------------------
-- The weekly notice to rektor.
-- ---------------------------------------------------------------------------

-- The week (Monday to Sunday) that is due and not yet written, if the school
-- has the notice on: the last completed week, when it ended on or after the
-- day the switch went on. A week the job missed is made up the next night and
-- never twice (the ledger).
CREATE FUNCTION app.reporting_digest_due(p_school uuid, p_today date)
RETURNS TABLE (period_start date, period_end date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT e.end_day - 6, e.end_day
    FROM "ReportingSettings" s
   CROSS JOIN LATERAL (SELECT p_today - extract(isodow FROM p_today)::integer AS end_day) AS e
   WHERE s."schoolId" = p_school AND s."rektorDigest" AND s."rektorDigestOn" IS NOT NULL
     AND e.end_day >= s."rektorDigestOn"
     AND NOT EXISTS (SELECT 1 FROM "ReportingDigests" d
                      WHERE d."schoolId" = p_school AND d."periodEnd" = e.end_day)
$$;

-- Writes the week's notice once: the ledger row (a second call writes nothing
-- and answers nothing) and a notice to each active administrator with the
-- profile REKTOR or FULL, with the school's totals for the week from the stored
-- days: held and reported lessons, and how many teachers they are spread over.
-- A week with no held lesson is entered in the ledger and told to nobody. Never
-- a name. Answers the notices with the addresses, for the delivery after the
-- commit. Only for a whole week that is over, Monday to Sunday in the school's
-- dates: the ledger's row for a week stops the real notice of it, so a week to
-- come, or a stretch that is no week, is refused (RR400).
CREATE FUNCTION app.reporting_digest(p_school uuid, p_start date, p_end date)
RETURNS TABLE (notification_id uuid, user_id uuid, email text, meta jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
#variable_conflict use_column
DECLARE
  tz text;
BEGIN
  SELECT s."timezone" INTO tz FROM "Schools" s WHERE s."id" = p_school;
  IF tz IS NULL THEN
    RAISE EXCEPTION 'REPORTING_NO_SCHOOL' USING ERRCODE = 'RR404';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR extract(isodow FROM p_start) <> 1 OR p_end <> p_start + 6
     OR p_end >= (clock_timestamp() AT TIME ZONE tz)::date THEN
    RAISE EXCEPTION 'REPORTING_WEEK_IS_NOT_OVER: veckobeskedet gäller en hel vecka, måndag till söndag, som gått'
      USING ERRCODE = 'RR400';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('reporting-digest:' || p_school::text, 0));
  PERFORM 1 FROM "ReportingSettings" s WHERE s."schoolId" = p_school AND s."rektorDigest" FOR SHARE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  RETURN QUERY
  WITH totals AS MATERIALIZED (
    SELECT coalesce(sum(d."held"), 0)::integer AS held,
           coalesce(sum(d."reported"), 0)::integer AS reported,
           count(DISTINCT d."teacherId")::integer AS teachers
      FROM "TeacherReportingDays" d
     WHERE d."schoolId" = p_school AND d."day" BETWEEN p_start AND p_end
  ),
  recipients AS MATERIALIZED (
    SELECT u."id", u."email"
      FROM "Users" u
     WHERE u."schoolId" = p_school AND u."role" = 'SCHOOL_ADMIN' AND u."isActive"
       AND u."adminProfile" IN ('REKTOR', 'FULL')
       AND (SELECT t.held FROM totals t) > 0
  ),
  ledger AS (
    INSERT INTO "ReportingDigests" ("schoolId", "periodStart", "periodEnd", "recipients", "teachers", "held", "reported")
    SELECT p_school, p_start, p_end, (SELECT count(*) FROM recipients)::integer, t.teachers, t.held, t.reported
      FROM totals t
    ON CONFLICT ("schoolId", "periodEnd") DO NOTHING
    RETURNING 1
  ),
  written AS (
    INSERT INTO "Notifications" ("schoolId", "userId", "type", "meta")
    SELECT p_school, r."id", 'REPORTING_RATE_DIGEST',
           jsonb_build_object('periodStart', p_start, 'periodEnd', p_end,
                              'held', t.held, 'reported', t.reported, 'teachers', t.teachers)
      FROM recipients r, totals t
     WHERE EXISTS (SELECT 1 FROM ledger)
    RETURNING "id", "userId", "meta"
  )
  SELECT w."id", w."userId", rc."email", w."meta"
    FROM written w JOIN recipients rc ON rc."id" = w."userId";
END
$$;

-- ---------------------------------------------------------------------------
-- Row-level security and grants. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "ReportingSettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TeacherReportingDays" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReportingReminders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReportingDigests" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r text;
  tbl text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    -- The switches and the limit: every administrator reads, Drift writes, and a
    -- teacher reads (the limit is what the teacher's own list is measured by).
    -- Never deleted.
    CREATE POLICY "reporting_settings_admin_select" ON "ReportingSettings"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "reporting_settings_teacher_select" ON "ReportingSettings"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'TEACHER');
    CREATE POLICY "reporting_settings_admin_insert" ON "ReportingSettings"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true)));
    CREATE POLICY "reporting_settings_admin_update" ON "ReportingSettings"
        FOR UPDATE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true)));

    -- The days: a teacher reads their own, every administrator reads all, and
    -- no arm writes (app.reporting_compute does). A pupil and a guardian have
    -- no arm.
    CREATE POLICY "reporting_days_admin_select" ON "TeacherReportingDays"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "reporting_days_teacher_select" ON "TeacherReportingDays"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'TEACHER'
               AND "teacherId" = (select app.current_user_id()));

    -- The week's ledger: counts only.
    CREATE POLICY "reporting_digests_admin_select" ON "ReportingDigests"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

    -- The reminders' ledger has no arm at all: only app.reporting_remind reads
    -- or writes it, as the owner.

    FOREACH tbl IN ARRAY ARRAY['ReportingSettings', 'TeacherReportingDays', 'ReportingReminders', 'ReportingDigests'] LOOP
      EXECUTE format('REVOKE ALL ON %I FROM "app_authenticated"', tbl);
    END LOOP;
    GRANT SELECT, INSERT, UPDATE ON "ReportingSettings" TO "app_authenticated";
    GRANT SELECT ON "TeacherReportingDays" TO "app_authenticated";
    GRANT SELECT ON "ReportingDigests" TO "app_authenticated";
  END IF;

  FOREACH tbl IN ARRAY ARRAY['ReportingSettings', 'TeacherReportingDays', 'ReportingReminders', 'ReportingDigests'] LOOP
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
-- Gallring: the days and the reminders go with the attendance they are counted
-- from. Both bodies are 20270107090000's plus the lines marked
-- "rapporteringsgrad". A later release that restates the functions again must
-- carry every branch.
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

COMMENT ON FUNCTION app.reporting_lessons(uuid, date, date, timestamptz) IS
  'Rapporteringsgrad: the one definition. A row per held lesson (SCHEDULED or COMPLETED, ended, with at least one active pupil on its roster) and active teacher on it, whose teacher is not themself absent, with whether its register is saved (a mark that is not UNKNOWN). The owner''s alone.';
COMMENT ON FUNCTION app.reporting_compute(uuid, date) IS
  'Rapporteringsgrad: the school''s last 90 days up to p_as_of (a day that has passed), one row per teacher and day with a held lesson; rewrites what changed, removes what lost its lessons; from the cutoff of the shortest period the school has ever chosen to purge attendance after, when it has. Answers what it wrote.';
COMMENT ON FUNCTION app.reporting_open_lessons(integer) IS
  'Rapporteringsgrad: the caller''s own held lessons of the last p_days days with no saved register, and whether each stood open longer than the school''s limit. Answers the caller alone; nothing for anyone who is not a teacher.';
COMMENT ON FUNCTION app.reporting_remind(uuid, date) IS
  'Rapporteringsgrad: tells each teacher of lessons that stood open longer than the school''s limit, once per lesson, in one statement with the ledger; nothing at the weekend or with the switch off. Answers the notices with the addresses, for the delivery after the commit.';
COMMENT ON FUNCTION app.reporting_digest_due(uuid, date) IS
  'Rapporteringsgrad: the last completed week, if the school has the weekly notice on and it has no entry yet.';
COMMENT ON FUNCTION app.reporting_digest(uuid, date, date) IS
  'Rapporteringsgrad: writes the week''s notice once, for a whole week (Monday to Sunday) that is over, to the active rektor and full administrators, with the school''s totals and never a name; answers the notices with the addresses.';

DO $$
DECLARE
  fn text;
  r text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'app.reporting_settings_stamp()',
    'app.reporting_lessons(uuid, date, date, timestamptz)',
    'app.reporting_schools()',
    'app.reporting_compute(uuid, date)',
    'app.reporting_open_lessons(integer)',
    'app.reporting_remind(uuid, date)',
    'app.reporting_digest_due(uuid, date)',
    'app.reporting_digest(uuid, date, date)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', fn, r);
      END IF;
    END LOOP;
  END LOOP;
  -- The API role runs the teacher's own list and the job's six calls. The
  -- trigger function needs no grant, and the definition is read by the owner's
  -- functions alone.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    FOREACH fn IN ARRAY ARRAY[
      'app.reporting_schools()',
      'app.reporting_compute(uuid, date)',
      'app.reporting_open_lessons(integer)',
      'app.reporting_remind(uuid, date)',
      'app.reporting_digest_due(uuid, date)',
      'app.reporting_digest(uuid, date, date)'
    ] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO "app_authenticated"', fn);
    END LOOP;
  END IF;
END
$$;
