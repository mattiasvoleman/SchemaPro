-- Elevens lektion för dagen (D7).
--
-- En lärare, en mentor eller en administratör med Drift flyttar en elev från en
-- lektion till en parallell lektion, en som överlappar den i tid, för ett
-- datum. Eleven är då på mållektionen och inte på källektionen: närvaron,
-- minuterna, den levererade tiden, elevens och barnets schema, kalenderflödet,
-- Schemavisaren och SS12000-exporten följer. Flytten är daterad och hänger på
-- de två lektionerna av dagen; grundlektionen (MasterLessons) rörs aldrig.
--
-- ## Vad som byggs på vad
--
-- Flytten bygger på det som redan fanns, inte på en ny mekanik:
--
--   * Ankomsten är en namngiven elev på mållektionen: en rad i
--     CalendarLessonStudents (som Lektionsdeltagare, 20260713150000). Därför
--     ser varje läsare av namngivna elever eleven där utan en ny arm: elevens
--     egen vecka (calendar_lessons_participant_select), vårdnadshavarens
--     (calendar_lessons_guardian_select), kalenderflödet, SS12000:s
--     deltagare och registret. Raden bär flyttens id (moveId) och ägs av
--     flytten: den går när flytten går (ON DELETE CASCADE).
--   * Avgången är det enda modellen saknade ord för, och läses där en ersättande
--     grupps "off" läses (Ersättande grupper, 20261211090000):
--     app.current_student_replaced_lesson_ids() (elevens egna tre armar på
--     CalendarLessons), kalenderflödet app.calendar_feed_pupil_lessons och, i
--     gatewayen, listläsaren calendar/lesson-roster.ts, familjens vecka,
--     SS12000:s studentExceptions och levererad tid.
--
-- ## Tabellen och de två dörrarna
--
--   LessonPupilMoves   en rad per (elev, källektion): vem, vart, vem som
--                      flyttade, och elevens markering på källan före flytten
--                      (displacedMark), så att Ångra kan lägga tillbaka den.
--
-- Tabellen har ingen skrivarm: den skrivs av app.lesson_pupil_move och
-- app.lesson_pupil_move_undo (SECURITY DEFINER, bara API-rollen), som ställer
-- samma fråga som arm efter arm skulle ha gjort och tar de två lektionernas
-- rader i id-ordning (FOR NO KEY UPDATE) innan något annat. Den som tar emot
-- ett register tar sin lektions rad FOR SHARE (AttendanceService, genom
-- app.lesson_pupil_register_lock), så en flytt
-- och ett sparat register möts i en ordning och aldrig mitt i: en markering
-- som sparats före flytten ligger kvar att flytta undan, och ett register som
-- sparas efter ser flytten och lämnar eleven utanför.
--
-- Regler som databasen håller (inte bara gatewayen):
--
--   * båda lektionerna hålls (SCHEDULED eller COMPLETED) och överlappar
--     varandra i tid; den ena är inte den andra; allt i samma skola;
--   * eleven är en aktiv elev i skolan; den som flyttar har rätt (Drift för en
--     administratör; en lärare som undervisar källan, målet eller den lektion
--     eleven just nu är på, eller är elevens mentor den dagen, med
--     app.leave_mentors, ledighetsbeslutets och frånvarobevakningens enda
--     definition av en mentor);
--   * dagen är inte förbi och lektionen eleven flyttas från är inte slut: en
--     flytt görs för i dag eller senare, och en ny flytt görs aldrig ur en
--     lektion vars sluttid har passerat (LM416, för alla). En ny flytt skriver
--     över elevens markering på källan, och en lektions register är dess
--     lärares: den som bara undervisar målet får inte genom flytten ändra
--     eller radera en markering på en lektion hen inte kan spara register för;
--   * en flytt som redan gjorts kan rättas efter lektionens slut, samma dag,
--     men bara av dem som får spara den lektionens register: en administratör
--     med Drift och en lärare på lektionen (app.lesson_move_may_correct).
--     Ångra och en flytt tillbaka lägger tillbaka källärarens egen markering
--     med dess författare och tid, så de gäller källektionen; en flytt vidare
--     skriver ingenting på den första källan (markeringen bärs med i
--     displacedMark) och tar bara eleven ur den lektion hen står på, så den
--     gäller den lektionen. Den som bara undervisar målet, en mentor och alla
--     andra får LM416. Ångra tar aldrig bort en markering på målet: den
--     vägras (LM415) för alla tills markeringen är borttagen;
--   * eleven står inte redan på mållektionen som namngiven.
--
-- Vem som är på källektionen (hemklass, grupp, ersättande grupp) och att
-- eleven inte dubbelbokas av en tredje lektion är gatewayens fråga, den ena
-- listläsaren (calendar/lesson-roster.ts) har det svaret i TypeScript. En
-- flytt går också att göra om: flyttar man eleven vidare från mållektionen
-- till en tredje lektion byts raden (källan är fortfarande den första), och
-- flyttar man tillbaka till källan försvinner den.
--
-- ## Markeringen på källan
--
-- Elevens markering på källektionen sätts till UNKNOWN (registrerad
-- ingenstans: räknas varken i täljare eller nämnare i frånvarobevakningen,
-- minutstatistiken och SS12000:s närvaro) och den gamla sparas i
-- displacedMark. Det är en enda ändring på ett ställe i stället för en
-- ändring i varje läsare av AttendanceRecords. Ångra lägger tillbaka den, om
-- ingen skrivit en ny markering sedan. Att eleven har en markering på
-- mållektionen hindrar Ångra (och en flytt vidare): markeringen skulle bli
-- kvar på en lektion eleven inte längre är på.
--
-- ## En flytt faller när lektionerna inte längre bär den
--
-- En lektion som ställs in, ersätts av en schemabrytande aktivitet (D3), flyttas
-- så att de två inte längre överlappar eller tas bort tar flytten med sig
-- (trigger på CalendarLessons, bara när tid eller status ändras). Eleven är då
-- tillbaka på sin ordinarie lektion; ingen markering läggs tillbaka (eleven
-- kan ha gått dit nu). En borttagen elev eller lektion tar raden via nycklarna.
--
-- ## Rättigheter, läsning och SS12000
--
-- Läsarmar (alla TO app_authenticated): administratörer läser alla skolans
-- flyttar; en lärare dem på lektioner hen undervisar och dem hen är mentor
-- för; en elev sina egna; en vårdnadshavare sina barns; SS12000-leverantören
-- (skolans tjänsteprincipal) skolans alla, som den läser ankomsten bredvid.
-- Ingen skrivarm.
-- Varje rad som skrivs eller tas bort bumpar båda lektionernas CalendarEvent
-- i ett anrop (app.ss12000_bump_lessons tar versionsraderna i id-ordning),
-- så en flytt och en flytt åt andra hållet inte låser varandra korsvis.
--
-- Gallring: flytten följer närvaron (ATTENDANCE) och går när källektionens
-- datum är äldre än skolans gräns. app.gallring_due och app.gallring_purge är
-- 20270117091000:s kroppar (prod md5 före: due f884a3c77b5234c3d77ae6b77d17f0e7,
-- purge 21746d3990375d467cdeec6294308363) plus en gren märkt "elevens lektion";
-- en senare release som skriver om dem igen måste bära den.
--
-- ## Läsare som skrivs om
--
-- Alla utom de två första är 20270118090000:s och 20270112090100:s kroppar
-- med en rad tillagd; varje funktion vägs mot sin gamla kropps md5 innan den
-- ersätts, och migreringen stannar om den inte är som skriven.
--
--   app.current_student_replaced_lesson_ids   elevens avgångar läggs till
--   app.calendar_feed_pupil_lessons           kalenderflödet tar inte med en lektion eleven flyttats från
--   app.timetable_pupil_days                  en ankomst gör inte lektionen "bara för de namngivna"
--   app.timetable_week_days                   (samma sak på klassens, lärarens och salens sida)
--   app.reporting_lessons                     en namngiven elev som flyttats bort räknas inte som elev på listan
--   app.gallring_due / app.gallring_purge     flytten gallras med närvaron
--
-- ## Skolans val
--
-- SchoolDaySettings."guardianNoticeOnMove": en notis till vårdnadshavaren när
-- barnet flyttas. Av som förval. Lärarna på de två lektionerna får alltid en
-- notis (LESSON_PUPIL_MOVED, 20270122090000). Ingen push eller e-post nämner
-- barnet; ämne och tid står där och barnets namn står i inkorgen.
--
-- ## Vid sidan av det levande API:t: alla lås på en gång, eller inga
--
-- Migreringen lägger en kolumn på CalendarLessonStudents och SchoolDaySettings
-- (ACCESS EXCLUSIVE, ögonblickligt) och nycklar och triggrar som tar Schools,
-- Users och CalendarLessons i SHARE ROW EXCLUSIVE, vilket blockerar skrivningar
-- till dem (inte läsningar) så länge filen går. Ett register eller en
-- avbokning skriver CalendarLessons och Users i en och samma transaktion, så
-- låsen tas tillsammans, NOWAIT, i en slinga: ett nej rullar tillbaka
-- delbegäran med det den fått och försöker igen 50 ms senare. Efter 30 s
-- stoppar den utan att ha ändrat något. Prisma har då skrivit ett misslyckat
-- försök i _prisma_migrations och svarar P3009 på nästa deploy tills
-- `prisma migrate resolve --rolled-back 20270122091000_en_elev_byter_till_en_parallell_lektion_for_en_dag`
-- har körts; sedan kan filen köras om. Den tidigare
-- API-versionen känner varken kolumnerna eller tabellen och skriver aldrig
-- till dem; den läser inte heller flytten, men det finns ingen flytt förrän
-- den nya versionen kör.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Schools" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Users" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "CalendarLessons" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "CalendarLessonStudents" IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "SchoolDaySettings" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Schools, Users, CalendarLessons, CalendarLessonStudents and SchoolDaySettings were not free at once in 30 s: nothing is changed; run prisma migrate resolve --rolled-back 20270122091000_en_elev_byter_till_en_parallell_lektion_for_en_dag and deploy again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- De funktioner som skrivs om är som skrivna, eller inget ändras.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  fn record;
  body text;
BEGIN
  PERFORM set_config('search_path', 'public, pg_temp', true);
  FOR fn IN SELECT * FROM (VALUES
    ('app.current_student_replaced_lesson_ids()', '20261211090000', '40ec1dad4dc5024dfbad454679c742e9'),
    ('app.calendar_feed_pupil_lessons(uuid, uuid, date, date, text, "TeacherDisplay")', '20270118090000', 'edec662e41a36cca8086484a5de74895'),
    ('app.timetable_pupil_days(uuid, uuid, date, text, "TeacherDisplay")', '20270118090000', '16164f62372b5886f55743657fac1d46'),
    ('app.reporting_lessons(uuid, date, date, timestamptz)', '20270112090100', 'd6a074eea241802f4e7bbd980e4f29ea'),
    ('app.gallring_due(uuid, "RetentionDataType", date, date)', '20270117091000', 'f884a3c77b5234c3d77ae6b77d17f0e7'),
    ('app.gallring_purge(uuid, "RetentionDataType", integer)', '20270117091000', '21746d3990375d467cdeec6294308363')
  ) AS t(sig, wrote, expected)
  LOOP
    SELECT md5(p.prosrc) INTO body FROM pg_proc p WHERE p.oid = to_regprocedure(fn.sig);
    IF body IS DISTINCT FROM fn.expected THEN
      RAISE EXCEPTION '% is not as % wrote it (md5 of its body %, expected %), so it is not replaced',
        fn.sig, fn.wrote, coalesce(body, '(no such function)'), fn.expected;
    END IF;
  END LOOP;

  -- timetable_week_days has several overloads' worth of history; its guard is
  -- the one body that carries a pupil's page.
  SELECT md5(p.prosrc) INTO body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app' AND p.proname = 'timetable_week_days';
  IF body IS DISTINCT FROM 'd871d3d16dbd336b80ea677ac23abded' THEN
    RAISE EXCEPTION 'app.timetable_week_days is not as 20270118090000 wrote it (md5 of its body %, expected d871d3d16dbd336b80ea677ac23abded), so it is not replaced',
      coalesce(body, '(no such function)');
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Skolans val
-- ---------------------------------------------------------------------------

ALTER TABLE "SchoolDaySettings" ADD COLUMN "guardianNoticeOnMove" BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN "SchoolDaySettings"."guardianNoticeOnMove" IS
  'Elevens lektion för dagen: om vårdnadshavaren får en notis när barnet flyttas till en parallell lektion för en dag. Av som förval; lärarna på de två lektionerna får alltid en.';

-- ---------------------------------------------------------------------------
-- LessonPupilMoves
-- ---------------------------------------------------------------------------

CREATE TABLE "LessonPupilMoves" (
    "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"      UUID NOT NULL,
    "studentId"     UUID NOT NULL,
    -- The lesson the pupil would have been on, and the parallel lesson they
    -- are on instead.
    "fromLessonId"  UUID NOT NULL,
    "toLessonId"    UUID NOT NULL,
    -- Who moved the pupil; NULL once that person is removed (SET NULL of this
    -- column alone).
    "movedById"     UUID,
    -- The pupil's mark on the source before the move: {status, note,
    -- recordedAt, recordedById}, or NULL if there was none (or it counted for
    -- nobody).
    "displacedMark" JSONB,
    "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "LessonPupilMoves_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LessonPupilMoves_two_lessons" CHECK ("fromLessonId" <> "toLessonId")
);

-- The target of CalendarLessonStudents."moveId".
CREATE UNIQUE INDEX "LessonPupilMoves_id_schoolId_key" ON "LessonPupilMoves"("id", "schoolId");
-- A pupil leaves a lesson once and joins a lesson once. Both start with their
-- key's columns, so they are also the keys' indexes (the FK index audit).
CREATE UNIQUE INDEX "LessonPupilMoves_fromLessonId_schoolId_studentId_key"
    ON "LessonPupilMoves"("fromLessonId", "schoolId", "studentId");
CREATE UNIQUE INDEX "LessonPupilMoves_toLessonId_schoolId_studentId_key"
    ON "LessonPupilMoves"("toLessonId", "schoolId", "studentId");
-- The pupil's moves (the helper of the pupil's own arms; the person key's cascade).
CREATE INDEX "LessonPupilMoves_studentId_schoolId_createdAt_idx"
    ON "LessonPupilMoves"("studentId", "schoolId", "createdAt");
-- The person key's SET NULL.
CREATE INDEX "LessonPupilMoves_movedById_schoolId_idx" ON "LessonPupilMoves"("movedById", "schoolId");
-- Gallring's and the school's list.
CREATE INDEX "LessonPupilMoves_schoolId_createdAt_idx" ON "LessonPupilMoves"("schoolId", "createdAt");

ALTER TABLE "LessonPupilMoves"
    ADD CONSTRAINT "LessonPupilMoves_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LessonPupilMoves"
    ADD CONSTRAINT "LessonPupilMoves_fromLessonId_schoolId_fkey" FOREIGN KEY ("fromLessonId", "schoolId")
    REFERENCES "CalendarLessons"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "LessonPupilMoves"
    ADD CONSTRAINT "LessonPupilMoves_toLessonId_schoolId_fkey" FOREIGN KEY ("toLessonId", "schoolId")
    REFERENCES "CalendarLessons"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "LessonPupilMoves"
    ADD CONSTRAINT "LessonPupilMoves_studentId_schoolId_fkey" FOREIGN KEY ("studentId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "LessonPupilMoves"
    ADD CONSTRAINT "LessonPupilMoves_movedById_schoolId_fkey" FOREIGN KEY ("movedById", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE SET NULL ("movedById") ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- The arrival: a named pupil of the target that the move owns.
-- ---------------------------------------------------------------------------

ALTER TABLE "CalendarLessonStudents" ADD COLUMN "moveId" UUID;

-- The move's cascade; nothing else asks by it.
CREATE INDEX "CalendarLessonStudents_moveId_schoolId_idx" ON "CalendarLessonStudents"("moveId", "schoolId");

ALTER TABLE "CalendarLessonStudents"
    ADD CONSTRAINT "CalendarLessonStudents_moveId_schoolId_fkey" FOREIGN KEY ("moveId", "schoolId")
    REFERENCES "LessonPupilMoves"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;

COMMENT ON COLUMN "CalendarLessonStudents"."moveId" IS
  'Elevens lektion för dagen: satt när raden är ankomsten av en elev som flyttats hit för dagen (LessonPupilMoves). Flytten äger raden och tar den med sig. En läsare som tar namngivna elever för att lektionen bara är för dem räknar inte dessa rader.';

-- A row that carries a move is the move's arrival and nothing else: the
-- lesson and the pupil are the move's. Only app.lesson_pupil_move writes one,
-- but an administrator's own arm on this table (calendarlessonstudents_admin_all)
-- could name any move.
CREATE FUNCTION app.lesson_pupil_arrival_is_the_moves() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF NEW."moveId" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "LessonPupilMoves" m
        WHERE m."id" = NEW."moveId" AND m."schoolId" = NEW."schoolId"
          AND m."toLessonId" = NEW."calendarLessonId" AND m."studentId" = NEW."studentId") THEN
    RAISE EXCEPTION 'LESSON_MOVE_ARRIVAL_IS_THE_MOVES: en ankomst hör till sin flytt, till samma lektion och elev'
      USING ERRCODE = 'LM409';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.lesson_pupil_arrival_is_the_moves() FROM PUBLIC;

CREATE TRIGGER "CalendarLessonStudents_arrival_is_the_moves"
    BEFORE INSERT OR UPDATE OF "moveId", "calendarLessonId", "studentId" ON "CalendarLessonStudents"
    FOR EACH ROW EXECUTE FUNCTION app.lesson_pupil_arrival_is_the_moves();

-- An arrival that is deleted by itself (an administrator's arm, a pupil's row
-- going) takes its move with it, so a pupil is never moved off one lesson and
-- onto none. The cascade from the move deletes the arrival with the move
-- already gone: the delete below then finds nothing.
CREATE FUNCTION app.lesson_pupil_arrival_goes_with_the_move() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  DELETE FROM "LessonPupilMoves" WHERE "id" = OLD."moveId" AND "schoolId" = OLD."schoolId";
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION app.lesson_pupil_arrival_goes_with_the_move() FROM PUBLIC;

CREATE TRIGGER "CalendarLessonStudents_arrival_goes_with_the_move"
    AFTER DELETE ON "CalendarLessonStudents"
    FOR EACH ROW WHEN (OLD."moveId" IS NOT NULL)
    EXECUTE FUNCTION app.lesson_pupil_arrival_goes_with_the_move();

-- ---------------------------------------------------------------------------
-- What a move is: two parallel lessons that are held, a pupil of the school.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.lesson_pupil_move_is_parallel() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  a record;
  b record;
BEGIN
  SELECT l."schoolId", l."status", l."cancelCause", l."startsAt", l."endsAt" INTO a
    FROM "CalendarLessons" l WHERE l."id" = NEW."fromLessonId";
  SELECT l."schoolId", l."status", l."cancelCause", l."startsAt", l."endsAt" INTO b
    FROM "CalendarLessons" l WHERE l."id" = NEW."toLessonId";
  IF a."schoolId" IS DISTINCT FROM NEW."schoolId" OR b."schoolId" IS DISTINCT FROM NEW."schoolId" THEN
    RAISE EXCEPTION 'LESSON_MOVE_LESSON_NOT_FOUND: lektionen finns inte i skolan'
      USING ERRCODE = 'LM404';
  END IF;
  IF a."status" = 'CANCELLED' AND a."cancelCause" = 'EVENT' THEN
    RAISE EXCEPTION 'LESSON_MOVE_REPLACED_BY_ACTIVITY: källektionen är ersatt av en schemabrytande aktivitet'
      USING ERRCODE = 'LM413', DETAIL = 'FROM';
  END IF;
  IF b."status" = 'CANCELLED' AND b."cancelCause" = 'EVENT' THEN
    RAISE EXCEPTION 'LESSON_MOVE_REPLACED_BY_ACTIVITY: mållektionen är ersatt av en schemabrytande aktivitet'
      USING ERRCODE = 'LM413', DETAIL = 'TO';
  END IF;
  IF a."status" NOT IN ('SCHEDULED', 'COMPLETED') THEN
    RAISE EXCEPTION 'LESSON_MOVE_LESSON_NOT_HELD: källektionen hålls inte'
      USING ERRCODE = 'LM410', DETAIL = 'FROM';
  END IF;
  IF b."status" NOT IN ('SCHEDULED', 'COMPLETED') THEN
    RAISE EXCEPTION 'LESSON_MOVE_LESSON_NOT_HELD: mållektionen hålls inte'
      USING ERRCODE = 'LM410', DETAIL = 'TO';
  END IF;
  IF NOT (a."startsAt" < b."endsAt" AND b."startsAt" < a."endsAt") THEN
    RAISE EXCEPTION 'LESSON_MOVE_NOT_PARALLEL: lektionerna överlappar inte varandra i tid'
      USING ERRCODE = 'LM412';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Users" u
                  WHERE u."id" = NEW."studentId" AND u."schoolId" = NEW."schoolId"
                    AND u."role" = 'STUDENT' AND u."isActive") THEN
    RAISE EXCEPTION 'LESSON_MOVE_NOT_A_PUPIL: bara en aktiv elev i skolan kan flyttas'
      USING ERRCODE = 'LM404';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.lesson_pupil_move_is_parallel() FROM PUBLIC;

CREATE TRIGGER "LessonPupilMoves_are_parallel"
    BEFORE INSERT ON "LessonPupilMoves"
    FOR EACH ROW EXECUTE FUNCTION app.lesson_pupil_move_is_parallel();

-- A move written or taken away tells the integrations about both lessons in
-- one call: app.ss12000_bump_lessons takes the version rows in entityId
-- order, so a move one way and a move the other never hold one each of what
-- the other waits for. The target's CalendarEvent is also bumped by its
-- arrival's own trigger; the source's is bumped by nothing else, since its
-- studentExceptions (the pupil who does not take part) is computed from this
-- table.
CREATE FUNCTION app.lesson_pupil_move_tells_the_integrations() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  row_ "LessonPupilMoves";
BEGIN
  row_ := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  PERFORM app.ss12000_bump_lessons(row_."schoolId", ARRAY[row_."fromLessonId", row_."toLessonId"]);
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION app.lesson_pupil_move_tells_the_integrations() FROM PUBLIC;

CREATE TRIGGER "LessonPupilMoves_tell_the_integrations"
    AFTER INSERT OR DELETE ON "LessonPupilMoves"
    FOR EACH ROW EXECUTE FUNCTION app.lesson_pupil_move_tells_the_integrations();

-- ---------------------------------------------------------------------------
-- A move falls when its lessons no longer carry it.
-- ---------------------------------------------------------------------------

-- Only when a lesson's time or status changes (the WHEN), and then one delete
-- through the two keys' unique indexes; a school without a move pays two empty
-- index probes per changed lesson.
CREATE FUNCTION app.lesson_pupil_moves_lapse() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  DELETE FROM "LessonPupilMoves" m
   USING "CalendarLessons" a, "CalendarLessons" b
   WHERE (m."fromLessonId" = NEW."id" OR m."toLessonId" = NEW."id")
     AND a."id" = m."fromLessonId" AND b."id" = m."toLessonId"
     AND NOT (a."status" IN ('SCHEDULED', 'COMPLETED') AND b."status" IN ('SCHEDULED', 'COMPLETED')
              AND a."startsAt" < b."endsAt" AND b."startsAt" < a."endsAt");
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION app.lesson_pupil_moves_lapse() FROM PUBLIC;

CREATE TRIGGER "CalendarLessons_pupil_moves_lapse"
    AFTER UPDATE OF "startsAt", "endsAt", "status" ON "CalendarLessons"
    FOR EACH ROW
    WHEN (OLD."startsAt" IS DISTINCT FROM NEW."startsAt"
          OR OLD."endsAt" IS DISTINCT FROM NEW."endsAt"
          OR OLD."status" IS DISTINCT FROM NEW."status")
    EXECUTE FUNCTION app.lesson_pupil_moves_lapse();

-- ---------------------------------------------------------------------------
-- Who may move a pupil: the one question, asked by the writers.
-- ---------------------------------------------------------------------------

-- An administrator with Drift; a teacher who teaches one of the lessons, or
-- who mentors the pupil on the day (the leave decision's definition of a
-- mentor). Not a LASARE, not a pupil, not a guardian.
CREATE FUNCTION app.lesson_move_may(p_student uuid, p_lessons uuid[], p_on date) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT CASE app.current_user_role()::text
    WHEN 'SCHOOL_ADMIN' THEN app.current_user_may('DRIFT', true)
    WHEN 'TEACHER' THEN
      EXISTS (SELECT 1 FROM "CalendarLessonTeachers" t
               WHERE t."calendarLessonId" = ANY (p_lessons)
                 AND t."teacherId" = app.current_user_id()
                 AND t."schoolId" = app.current_school_id())
      OR EXISTS (SELECT 1 FROM app.leave_mentors(app.current_school_id(), p_student, p_on, p_on) AS m(id)
                  WHERE m.id = app.current_user_id())
    ELSE false
  END
$$;

REVOKE ALL ON FUNCTION app.lesson_move_may(uuid, uuid[], date) FROM PUBLIC;

-- Who may correct a move after a lesson is over: those who may save that
-- lesson's register (AttendanceService), an administrator with Drift or a
-- teacher assigned to it. Asked for the lesson a correction takes the pupil
-- out of (Ångra and a move back: the first source, where the source teacher's
-- own mark is put back; a move on: the lesson the pupil stands on). Not the
-- mentor, not the teacher of the target alone: that is the one who could
-- erase a colleague's mark, which is the whole of what LM416 is for.
CREATE FUNCTION app.lesson_move_may_correct(p_lesson uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT CASE app.current_user_role()::text
    WHEN 'SCHOOL_ADMIN' THEN app.current_user_may('DRIFT', true)
    WHEN 'TEACHER' THEN
      EXISTS (SELECT 1 FROM "CalendarLessonTeachers" t
               WHERE t."calendarLessonId" = p_lesson
                 AND t."teacherId" = app.current_user_id()
                 AND t."schoolId" = app.current_school_id())
    ELSE false
  END
$$;

REVOKE ALL ON FUNCTION app.lesson_move_may_correct(uuid) FROM PUBLIC;

-- Whether the calling teacher mentors the pupil on the day: the read arm's
-- question (the policy cannot call leave_mentors, which reads the enrolments).
CREATE FUNCTION app.lesson_move_is_mentor(p_student uuid, p_on date) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT app.current_user_role()::text = 'TEACHER'
     AND EXISTS (SELECT 1 FROM app.leave_mentors(app.current_school_id(), p_student, p_on, p_on) AS m(id)
                  WHERE m.id = app.current_user_id())
$$;

REVOKE ALL ON FUNCTION app.lesson_move_is_mentor(uuid, date) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Taking a move away: the one place, for Ångra, a move back and a move on.
-- ---------------------------------------------------------------------------

-- Deletes the move (its arrival goes by the key). With p_restore the pupil's
-- displaced mark is put back on the source when nobody has written one since.
-- The caller holds the two lessons' locks and has asked app.lesson_move_may.
CREATE FUNCTION app.lesson_pupil_move_remove(p_move uuid, p_restore boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  m "LessonPupilMoves";
BEGIN
  DELETE FROM "LessonPupilMoves" WHERE "id" = p_move RETURNING * INTO m;
  IF m."id" IS NULL THEN
    RETURN NULL;
  END IF;
  IF p_restore AND m."displacedMark" IS NOT NULL THEN
    UPDATE "AttendanceRecords" a SET
           "status"       = (m."displacedMark" ->> 'status')::"AttendanceStatus",
           "note"         = m."displacedMark" ->> 'note',
           "recordedAt"   = (m."displacedMark" ->> 'recordedAt')::timestamptz,
           "recordedById" = (m."displacedMark" ->> 'recordedById')::uuid,
           "updatedAt"    = now()
     WHERE a."calendarLessonId" = m."fromLessonId" AND a."studentId" = m."studentId"
       AND a."schoolId" = m."schoolId" AND a."status" = 'UNKNOWN';
  END IF;
  RETURN m."displacedMark";
END
$$;

REVOKE ALL ON FUNCTION app.lesson_pupil_move_remove(uuid, boolean) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- The door: move a pupil off a lesson onto a parallel one for the day.
-- ---------------------------------------------------------------------------

-- p_from is the lesson the pupil is on (their own, or the one a move put them
-- on); p_to the lesson they go to. Answers the new move's id, or NULL when the
-- pupil is sent back to the lesson they started on (the move is undone).
-- Refusals have a SQLSTATE of their own (LM4xx) and say which lesson with
-- DETAIL FROM or TO where it matters.
CREATE FUNCTION app.lesson_pupil_move(p_student uuid, p_from uuid, p_to uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  me uuid := app.current_user_id();
  school uuid := app.current_school_id();
  actor text := app.current_user_role()::text;
  prev "LessonPupilMoves";
  origin uuid;
  origin_date date;
  origin_ends timestamptz;
  leaving uuid;
  leaving_ends timestamptz;
  mark record;
  displaced jsonb;
  new_id uuid;
BEGIN
  IF me IS NULL OR school IS NULL OR actor NOT IN ('SCHOOL_ADMIN', 'TEACHER') THEN
    RAISE EXCEPTION 'LESSON_MOVE_NOT_ALLOWED: bara personal flyttar en elev' USING ERRCODE = 'LM403';
  END IF;
  IF p_from = p_to THEN
    RAISE EXCEPTION 'LESSON_MOVE_NOT_PARALLEL: en elev flyttas till en annan lektion' USING ERRCODE = 'LM412';
  END IF;

  -- Where the pupil started: the lesson itself, or the source of the move
  -- that put them on p_from.
  SELECT * INTO prev FROM "LessonPupilMoves"
   WHERE "toLessonId" = p_from AND "studentId" = p_student AND "schoolId" = school;
  origin := coalesce(prev."fromLessonId", p_from);

  -- The lessons, in id order, before anything else: a register save, a
  -- cancellation and another move all queue here (FOR NO KEY UPDATE conflicts
  -- with the FOR SHARE the register takes and with every update).
  PERFORM 1 FROM "CalendarLessons"
   WHERE "id" IN (p_from, p_to, origin) AND "schoolId" = school
   ORDER BY "id"
     FOR NO KEY UPDATE;
  IF (SELECT count(*) FROM "CalendarLessons" WHERE "id" IN (p_from, p_to, origin) AND "schoolId" = school)
     <> (SELECT count(DISTINCT x) FROM unnest(ARRAY[p_from, p_to, origin]) AS x) THEN
    RAISE EXCEPTION 'LESSON_MOVE_LESSON_NOT_FOUND: lektionen finns inte i skolan' USING ERRCODE = 'LM404';
  END IF;

  -- The move may have been undone or changed while this waited.
  IF prev."id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "LessonPupilMoves" WHERE "id" = prev."id") THEN
    RAISE EXCEPTION 'LESSON_MOVE_CHANGED: flytten ändrades just nu, försök igen' USING ERRCODE = 'LM409';
  END IF;

  SELECT l."date", l."endsAt" INTO origin_date, origin_ends FROM "CalendarLessons" l WHERE l."id" = origin;
  IF NOT app.lesson_move_may(p_student, ARRAY[origin, p_from, p_to], origin_date) THEN
    RAISE EXCEPTION 'LESSON_MOVE_NOT_ALLOWED: du får inte flytta den här eleven' USING ERRCODE = 'LM403';
  END IF;
  IF origin_date < app.school_today() THEN
    RAISE EXCEPTION 'LESSON_MOVE_IN_THE_PAST: en flytt görs för i dag eller senare' USING ERRCODE = 'LM414';
  END IF;
  -- The day is not the hour: a lesson that ended this morning is still
  -- today's. Its register is its teachers' to change. now() is the
  -- transaction's start: a lesson that ends exactly now is over.
  IF prev."id" IS NULL THEN
    -- A new move writes the pupil's mark on the source (UNKNOWN, the mover as
    -- author), so the teacher of the target alone could erase a colleague's
    -- mark by moving the pupil off a lesson that is over. Refused for everybody.
    IF origin_ends <= now() THEN
      RAISE EXCEPTION 'LESSON_MOVE_LESSON_OVER: lektionen eleven flyttas från är slut, så ingen ny flytt görs ur den'
        USING ERRCODE = 'LM416';
    END IF;
  ELSE
    -- Back to the start (Ångra, from here) puts the source teacher's own mark
    -- back, so the first source is the lesson it is about; a move on writes
    -- nothing on the first source (the displaced mark is carried) and takes the
    -- pupil out of the lesson they stand on, so that one is. Over: only those
    -- who may save that lesson's register may correct the move.
    leaving := CASE WHEN p_to = origin THEN origin ELSE p_from END;
    SELECT l."endsAt" INTO leaving_ends FROM "CalendarLessons" l WHERE l."id" = leaving;
    IF leaving_ends <= now() AND NOT app.lesson_move_may_correct(leaving) THEN
      RAISE EXCEPTION 'LESSON_MOVE_LESSON_OVER: lektionen är slut, så en flytt rättas bara av en administratör med Drift eller en lärare på lektionen eleven lämnar'
        USING ERRCODE = 'LM416';
    END IF;
  END IF;

  -- Leaving a lesson the pupil was moved onto: not while it holds a mark of
  -- theirs, which would stay on a lesson they are no longer on.
  IF prev."id" IS NOT NULL AND EXISTS (
       SELECT 1 FROM "AttendanceRecords" a
        WHERE a."calendarLessonId" = p_from AND a."studentId" = p_student AND a."schoolId" = school
          AND a."status" <> 'UNKNOWN') THEN
    RAISE EXCEPTION 'LESSON_MOVE_HAS_ATTENDANCE: eleven har redan en närvaromarkering på lektionen de flyttats till'
      USING ERRCODE = 'LM415';
  END IF;

  -- Back where they started: the move is undone, the mark put back.
  IF prev."id" IS NOT NULL AND p_to = origin THEN
    PERFORM app.lesson_pupil_move_remove(prev."id", true);
    RETURN NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM "CalendarLessonStudents" n WHERE n."calendarLessonId" = p_to AND n."studentId" = p_student) THEN
    RAISE EXCEPTION 'LESSON_MOVE_ALREADY_ON_TARGET: eleven står redan på mållektionen' USING ERRCODE = 'LM409';
  END IF;
  -- Already moved off this lesson: the pupil is not on it to be moved from.
  IF prev."id" IS NULL AND EXISTS (SELECT 1 FROM "LessonPupilMoves" WHERE "fromLessonId" = origin AND "studentId" = p_student) THEN
    RAISE EXCEPTION 'LESSON_MOVE_EXISTS: eleven är redan flyttad från lektionen' USING ERRCODE = 'LM409';
  END IF;

  IF prev."id" IS NOT NULL THEN
    -- Moved on from the lesson they were moved to: the first move's source and
    -- its displaced mark are kept.
    displaced := app.lesson_pupil_move_remove(prev."id", false);
  ELSE
    -- The pupil's mark on the source counts for nobody now. It is kept to be
    -- put back; UNKNOWN is the state the reports, the watch and SS12000 leave
    -- out. A mark made later by a phone's queue is turned away by the register
    -- (AttendanceService), and an older one by recordedAt below.
    SELECT a."status", a."note", a."recordedAt", a."recordedById" INTO mark
      FROM "AttendanceRecords" a
     WHERE a."calendarLessonId" = origin AND a."studentId" = p_student AND a."schoolId" = school
       FOR UPDATE;
    IF FOUND AND mark."status" <> 'UNKNOWN' THEN
      displaced := jsonb_build_object('status', mark."status", 'note', mark."note",
                                      'recordedAt', mark."recordedAt", 'recordedById', mark."recordedById");
      UPDATE "AttendanceRecords" a SET
             "status" = 'UNKNOWN', "note" = NULL, "recordedAt" = now(), "recordedById" = me, "updatedAt" = now()
       WHERE a."calendarLessonId" = origin AND a."studentId" = p_student AND a."schoolId" = school;
    END IF;
  END IF;

  INSERT INTO "LessonPupilMoves" ("schoolId", "studentId", "fromLessonId", "toLessonId", "movedById", "displacedMark")
  VALUES (school, p_student, origin, p_to, me, displaced)
  RETURNING "id" INTO new_id;

  INSERT INTO "CalendarLessonStudents" ("schoolId", "calendarLessonId", "studentId", "moveId")
  VALUES (school, p_to, p_student, new_id);

  RETURN new_id;
END
$$;

REVOKE ALL ON FUNCTION app.lesson_pupil_move(uuid, uuid, uuid) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- The door back: Ångra.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.lesson_pupil_move_undo(p_move uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  school uuid := app.current_school_id();
  m "LessonPupilMoves";
  on_day date;
  ends_at timestamptz;
BEGIN
  IF app.current_user_id() IS NULL OR school IS NULL THEN
    RAISE EXCEPTION 'LESSON_MOVE_NOT_ALLOWED: bara personal ångrar en flytt' USING ERRCODE = 'LM403';
  END IF;
  SELECT * INTO m FROM "LessonPupilMoves" WHERE "id" = p_move AND "schoolId" = school;
  IF m."id" IS NULL THEN
    RAISE EXCEPTION 'LESSON_MOVE_NOT_FOUND: flytten finns inte' USING ERRCODE = 'LM404';
  END IF;

  PERFORM 1 FROM "CalendarLessons"
   WHERE "id" IN (m."fromLessonId", m."toLessonId") AND "schoolId" = school
   ORDER BY "id"
     FOR NO KEY UPDATE;
  -- Gone while this waited (a lapse, or another Ångra).
  IF NOT EXISTS (SELECT 1 FROM "LessonPupilMoves" WHERE "id" = p_move) THEN
    RAISE EXCEPTION 'LESSON_MOVE_NOT_FOUND: flytten finns inte' USING ERRCODE = 'LM404';
  END IF;

  SELECT l."date", l."endsAt" INTO on_day, ends_at FROM "CalendarLessons" l WHERE l."id" = m."fromLessonId";
  IF NOT app.lesson_move_may(m."studentId", ARRAY[m."fromLessonId", m."toLessonId"], on_day) THEN
    RAISE EXCEPTION 'LESSON_MOVE_NOT_ALLOWED: du får inte ångra den här flytten' USING ERRCODE = 'LM403';
  END IF;
  IF on_day < app.school_today() THEN
    RAISE EXCEPTION 'LESSON_MOVE_IN_THE_PAST: en flytt ångras för i dag eller senare' USING ERRCODE = 'LM414';
  END IF;
  -- Ångra puts the pupil's mark back on the lesson they were moved from, with
  -- its author and time: once that lesson is over, only those who may save its
  -- register may do it (the source's teacher, an administrator with Drift).
  IF ends_at <= now() AND NOT app.lesson_move_may_correct(m."fromLessonId") THEN
    RAISE EXCEPTION 'LESSON_MOVE_LESSON_OVER: lektionen eleven flyttades från är slut, så flytten ångras bara av en administratör med Drift eller en lärare på den lektionen'
      USING ERRCODE = 'LM416';
  END IF;
  IF EXISTS (SELECT 1 FROM "AttendanceRecords" a
              WHERE a."calendarLessonId" = m."toLessonId" AND a."studentId" = m."studentId"
                AND a."schoolId" = school AND a."status" <> 'UNKNOWN') THEN
    RAISE EXCEPTION 'LESSON_MOVE_HAS_ATTENDANCE: eleven har redan en närvaromarkering på lektionen de flyttats till'
      USING ERRCODE = 'LM415';
  END IF;

  PERFORM app.lesson_pupil_move_remove(p_move, true);
END
$$;

REVOKE ALL ON FUNCTION app.lesson_pupil_move_undo(uuid) FROM PUBLIC;

-- The register's side of the same order: a lesson's row FOR SHARE, which a move
-- (FOR NO KEY UPDATE) waits for and which waits for a move. A function of its
-- own because the lock cannot be taken from the gateway: a row lock on a table
-- with row security runs the UPDATE policy over the row too, a teacher has none
-- on CalendarLessons, and the statement then locks nothing and says nothing.
-- Found by the adapter probe, with a save and a move started together.
CREATE FUNCTION app.lesson_pupil_register_lock(p_lesson uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  PERFORM 1 FROM "CalendarLessons"
   WHERE "id" = p_lesson AND "schoolId" = app.current_school_id()
     FOR SHARE;
  RETURN FOUND;
END
$$;

REVOKE ALL ON FUNCTION app.lesson_pupil_register_lock(uuid) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- The pupil's own arms: the lessons they were moved off.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.current_student_replaced_lesson_ids() RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  me uuid;
  school uuid;
  home uuid;
  hidden uuid[];
  moved uuid[];
BEGIN
  IF app.current_user_role() IS DISTINCT FROM 'STUDENT' THEN
    RETURN '{}'::uuid[];
  END IF;
  me := app.current_user_id();
  school := app.current_school_id();
  IF me IS NULL OR school IS NULL THEN
    RETURN '{}'::uuid[];
  END IF;
  -- Elevens lektion för dagen (20270122091000): the lessons they were moved
  -- off for a day, the replacing groups' "off" beside it. An index lookup on
  -- (studentId, schoolId); every pupil pays it, three times a statement (once
  -- in each of the three arms' initplans), and a pupil with none gets '{}'.
  SELECT coalesce(array_agg(mv."fromLessonId"), '{}'::uuid[]) INTO moved
    FROM "LessonPupilMoves" mv WHERE mv."studentId" = me AND mv."schoolId" = school;
  -- No replacing group of theirs: only what they were moved off is hidden.
  -- Every pupil of a school that uses none returns here, on cached index
  -- lookups.
  IF NOT EXISTS (SELECT 1
                   FROM "StudentGroupMembers" m
                   JOIN "StudentGroups" g ON g."id" = m."studentGroupId" AND g."schoolId" = school
                  WHERE m."studentId" = me AND m."schoolId" = school AND g."replacesSubjectId" IS NOT NULL) THEN
    RETURN moved;
  END IF;
  home := app.current_user_group_id();
  WITH replacing AS (
    -- The caller's replacing groups, the subject each replaces and its läsår.
    -- The membership row and the group both of the caller's school: a row
    -- another school's administrator wrote changes nothing here.
    SELECT g."id", g."replacesSubjectId" AS subject, g."academicYearId" AS year
      FROM "StudentGroupMembers" m
      JOIN "StudentGroups" g ON g."id" = m."studentGroupId" AND g."schoolId" = school
     WHERE m."studentId" = me AND m."schoolId" = school AND g."replacesSubjectId" IS NOT NULL
  ),
  mine AS (
    -- The groups the caller reaches a lesson through: the home class and
    -- every teaching group, as calendar_lessons_teaching_group_select reads
    -- them (by the pupil alone), so no lesson an arm admits goes unasked.
    SELECT home AS id WHERE home IS NOT NULL
    UNION
    SELECT m."studentGroupId" FROM "StudentGroupMembers" m WHERE m."studentId" = me
  ),
  reached AS (
    -- Their lessons in a replaced subject, by the lesson's own group or an
    -- extra one, with the läsår of the lesson's own group and whether that
    -- group is a teaching group and not a half (its members keep its lessons).
    SELECT cl."id", cl."subjectId", cl."studentGroupId", og."academicYearId" AS year,
           (og."kind" = 'TEACHING_GROUP' AND og."halfOfId" IS NULL) AS teaching
      FROM "CalendarLessons" cl
      JOIN "StudentGroups" og ON og."id" = cl."studentGroupId"
     WHERE cl."schoolId" = school
       AND cl."studentGroupId" IN (SELECT id FROM mine)
       AND cl."subjectId" IN (SELECT subject FROM replacing)
    UNION
    SELECT cl."id", cl."subjectId", cl."studentGroupId", og."academicYearId",
           (og."kind" = 'TEACHING_GROUP' AND og."halfOfId" IS NULL)
      FROM "CalendarLessonGroups" x
      JOIN "CalendarLessons" cl ON cl."id" = x."calendarLessonId" AND cl."schoolId" = school
      JOIN "StudentGroups" og ON og."id" = cl."studentGroupId"
     WHERE x."schoolId" = school
       AND x."studentGroupId" IN (SELECT id FROM mine)
       AND cl."subjectId" IN (SELECT subject FROM replacing)
  )
  SELECT coalesce(array_agg(DISTINCT r."id"), '{}'::uuid[]) INTO hidden
    FROM reached r
   -- A replacing group of theirs for the lesson's subject and läsår ...
   WHERE EXISTS (SELECT 1 FROM replacing g WHERE g.subject = r."subjectId" AND g.year = r.year)
     -- ... none of which is added to the lesson (SvA7 and SvA7 stöd both
     -- replace svenska: a pupil in both keeps the lessons of either) ...
     AND NOT EXISTS (SELECT 1 FROM replacing g
                      WHERE g.subject = r."subjectId"
                        AND g.year = r.year
                        AND EXISTS (SELECT 1 FROM "CalendarLessonGroups" x
                                     WHERE x."calendarLessonId" = r."id" AND x."studentGroupId" = g."id"))
     -- ... nor is the lesson's own group a teaching group they are placed in
     -- (a replacing group of theirs as the lesson's own is one: the CHECK
     -- makes it a teaching group and never a half). Placed in means a
     -- membership, as every other reader asks it, and not the home class: a
     -- pupil whose home row names a teaching group is not placed in it ...
     AND NOT (r.teaching AND r."studentGroupId" IN (SELECT m."studentGroupId" FROM "StudentGroupMembers" m
                                                     WHERE m."studentId" = me))
     -- ... and they are not named on it.
     AND NOT EXISTS (SELECT 1 FROM "CalendarLessonStudents" s
                      WHERE s."calendarLessonId" = r."id" AND s."studentId" = me);
  RETURN hidden || moved;
END
$$;

COMMENT ON FUNCTION app.current_student_replaced_lesson_ids() IS
  'The calendar lessons of the calling STUDENT''s school that the pupil does not attend: those that carry their home class or one of their teaching groups and that a replacing group of theirs takes them off (Ersättande grupper: the subject replaced in the lesson''s läsår, none of their groups replacing it on the lesson, the lesson''s own group not a teaching group they are in, the caller not named), and those they were moved off for the day (Elevens lektion för dagen, LessonPupilMoves); empty for every other role.';

-- ---------------------------------------------------------------------------
-- The feed of a pupil, the move applied. Everything but "theirs" is
-- 20270118090000's.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.calendar_feed_pupil_lessons(p_school uuid, p_pupil uuid, p_from date, p_to date, p_tz text, p_display "TeacherDisplay")
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = "public", "pg_temp" AS $$
  WITH pupil AS (
    SELECT u."studentGroupId" AS home FROM "Users" u WHERE u."id" = p_pupil AND u."schoolId" = p_school
  ),
  teaching AS (
    SELECT m."studentGroupId" AS g FROM "StudentGroupMembers" m WHERE m."studentId" = p_pupil
  ),
  homedays AS (
    SELECT e."validFrom", e."validTo"
      FROM "StudentEnrollments" e, pupil
     WHERE e."studentId" = p_pupil AND e."studentGroupId" = pupil.home
  ),
  -- The lessons the family's week matches: the pupil named on it, a teaching
  -- group's (its own group or an extra one), and the home class's on the
  -- days the class history names it.
  named AS (
    SELECT p."calendarLessonId" AS id FROM "CalendarLessonStudents" p WHERE p."studentId" = p_pupil
  ),
  taught AS (
    SELECT cl."id" FROM "CalendarLessons" cl
     WHERE cl."studentGroupId" IN (SELECT g FROM teaching) AND cl."date" BETWEEN p_from AND p_to
    UNION
    SELECT x."calendarLessonId" FROM "CalendarLessonGroups" x WHERE x."studentGroupId" IN (SELECT g FROM teaching)
  ),
  homed AS (
    SELECT cl."id", cl."date" FROM "CalendarLessons" cl, pupil
     WHERE cl."studentGroupId" = pupil.home AND cl."date" BETWEEN p_from AND p_to
    UNION
    SELECT cl."id", cl."date"
      FROM "CalendarLessonGroups" x JOIN "CalendarLessons" cl ON cl."id" = x."calendarLessonId", pupil
     WHERE x."studentGroupId" = pupil.home AND cl."date" BETWEEN p_from AND p_to
  ),
  candidates AS (
    SELECT id FROM named
    UNION
    SELECT id FROM taught
    UNION
    SELECT h."id" FROM homed h
     WHERE EXISTS (SELECT 1 FROM homedays d
                    WHERE d."validFrom" <= h."date" AND (d."validTo" IS NULL OR h."date" < d."validTo"))
  ),
  -- Ersättande grupper (20261211090000): the pupil's replacing groups, the
  -- subject each replaces and its läsår; the membership and the group both
  -- of the school.
  replacing AS (
    SELECT g."id", g."replacesSubjectId" AS subject, g."academicYearId" AS year
      FROM "StudentGroupMembers" m JOIN "StudentGroups" g ON g."id" = m."studentGroupId"
     WHERE m."studentId" = p_pupil AND m."schoolId" = p_school AND g."schoolId" = p_school
       AND g."replacesSubjectId" IS NOT NULL
  ),
  theirs AS (
    SELECT cl."id", cl."date", cl."startsAt", cl."endsAt", cl."status", cl."subjectId", cl."roomId", cl."updatedAt"
      FROM "CalendarLessons" cl
     WHERE cl."id" IN (SELECT c.id FROM candidates c)
       AND cl."schoolId" = p_school
       AND cl."date" BETWEEN p_from AND p_to
       AND cl."status" IN ('SCHEDULED', 'COMPLETED', 'CANCELLED')
       -- Elevens lektion för dagen (20270122091000): a lesson the pupil was
       -- moved off for the day is not theirs that day, whatever else says it is
       -- (a named row of theirs included: the move is the later word).
       AND NOT EXISTS (SELECT 1 FROM "LessonPupilMoves" mv
                        WHERE mv."fromLessonId" = cl."id" AND mv."studentId" = p_pupil AND mv."schoolId" = p_school)
       -- A replacing group takes the pupil off the class's lessons in its
       -- subject, of its läsår. The pupil keeps one that names them, one with
       -- no replacing group of theirs for its subject, one any of them is
       -- added to, and one whose own group is a teaching group (not a half)
       -- they are placed in.
       AND (
             cl."id" IN (SELECT id FROM named)
          OR NOT EXISTS (SELECT 1 FROM replacing g
                          WHERE g.subject = cl."subjectId"
                            AND g.year = (SELECT og."academicYearId" FROM "StudentGroups" og WHERE og."id" = cl."studentGroupId"))
          OR EXISTS (SELECT 1 FROM replacing g
                      WHERE g.subject = cl."subjectId"
                        AND g.year = (SELECT og."academicYearId" FROM "StudentGroups" og WHERE og."id" = cl."studentGroupId")
                        AND EXISTS (SELECT 1 FROM "CalendarLessonGroups" x
                                     WHERE x."calendarLessonId" = cl."id" AND x."studentGroupId" = g."id"))
          -- (a replacing group of theirs as the lesson's own group is a
          -- teaching group they are placed in: the next branch keeps them.)
          OR EXISTS (SELECT 1 FROM "StudentGroups" og
                      WHERE og."id" = cl."studentGroupId"
                        AND og."kind" = 'TEACHING_GROUP' AND og."halfOfId" IS NULL
                        AND og."id" IN (SELECT t.g FROM teaching t))
       )
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', l."id",
           'date', to_char(l."date", 'YYYY-MM-DD'),
           'start', to_char(l."startsAt" AT TIME ZONE p_tz, 'YYYYMMDD"T"HH24MISS'),
           'end', to_char(l."endsAt" AT TIME ZONE p_tz, 'YYYYMMDD"T"HH24MISS'),
           'startUtc', to_char(l."startsAt" AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS"Z"'),
           'endUtc', to_char(l."endsAt" AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS"Z"'),
           'cancelled', l."status" = 'CANCELLED',
           'subject', s."name",
           'room', r."name",
           'groups', '[]'::jsonb,
           'teachers', to_jsonb(coalesce(st.labels, '{}'::text[])),
           'substitute', coalesce(st.substitute, false),
           'version', to_char(l."updatedAt" AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS"Z"'))
         ORDER BY l."startsAt", l."endsAt", l."id"), '[]'::jsonb)
    FROM theirs l
    JOIN "Subjects" s ON s."id" = l."subjectId"
    LEFT JOIN "Rooms" r ON r."id" = l."roomId"
    LEFT JOIN app.family_lesson_labels(p_school, p_display, ARRAY(SELECT t."id" FROM theirs t), true) st ON st.lesson_id = l."id"
$$;

-- ---------------------------------------------------------------------------
-- Schemavisaren: an arrival does not make a lesson "for named pupils". The
-- week builder and the pupil's page are 20270118090000's, line for line, with
-- the one condition on n."moveId" / p."moveId".
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.timetable_pupil_days(p_school uuid, p_pupil uuid, p_from date, p_tz text, p_display "TeacherDisplay")
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = "public", "pg_temp" AS $$
  WITH shown AS (
    -- The lessons the family's week matches, once: the calendar feed's pupil
    -- builder says which, and names their teachers as the school names them
    -- to families, without a hidden teacher or one with a protected identity.
    -- The viewer's page keeps its times, subject, room, teachers and
    -- cancelled, and no group: which teaching groups a pupil is in is not for
    -- a page held by a code. A lesson for a few named pupils is on the page of
    -- one of them and on no other's.
    SELECT (l ->> 'date')::date AS "date", l ->> 'start' AS "starts",
           jsonb_build_object(
             'start', substr(l ->> 'start', 10, 2) || ':' || substr(l ->> 'start', 12, 2),
             'end', substr(l ->> 'end', 10, 2) || ':' || substr(l ->> 'end', 12, 2),
             'subject', l -> 'subject',
             'groups', '[]'::jsonb,
             -- A room the school hides is named on no page, a pupil's own too.
             'room', CASE WHEN EXISTS (SELECT 1 FROM "CalendarLessons" cl
                                         JOIN "PublicTimetableHidden" h ON h."targetRoomId" = cl."roomId"
                                        WHERE cl."id" = (l ->> 'id')::uuid)
                          THEN 'null'::jsonb ELSE l -> 'room' END,
             'teachers', l -> 'teachers',
             'cancelled', (l ->> 'cancelled')::boolean) AS "lesson"
      FROM jsonb_array_elements(app.calendar_feed_pupil_lessons(p_school, p_pupil, p_from, p_from + 6, p_tz, p_display)) l
     -- (An arrival of a pupil moved here for the day, n."moveId", does not make
     -- the lesson one for named pupils: it is a class's lesson with one more pupil.)
     WHERE NOT EXISTS (SELECT 1 FROM "CalendarLessonStudents" n WHERE n."calendarLessonId" = (l ->> 'id')::uuid AND n."moveId" IS NULL)
        OR EXISTS (SELECT 1 FROM "CalendarLessonStudents" n WHERE n."calendarLessonId" = (l ->> 'id')::uuid AND n."studentId" = p_pupil)
  )
  SELECT coalesce(jsonb_agg(day_json ORDER BY d), '[]'::jsonb)
    FROM (
      SELECT d::date AS d,
             jsonb_build_object(
               'date', to_char(d, 'YYYY-MM-DD'),
               'lessons', coalesce((SELECT jsonb_agg(s."lesson" ORDER BY s."starts", s."lesson" ->> 'end')
                                      FROM shown s WHERE s."date" = d::date), '[]'::jsonb)
             ) AS day_json
        FROM generate_series(p_from, p_from + 6, interval '1 day') d
    ) w
$$;

CREATE OR REPLACE FUNCTION app.timetable_week_days(
    p_school   uuid,
    p_kind     "PublicScopeKind",
    p_target   uuid,
    p_from     date,
    p_tz       text,
    p_display  "TeacherDisplay",
    p_meals    boolean,
    p_min_size integer
) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = "public", "pg_temp" AS $$
  SELECT CASE WHEN p_kind::text = 'STUDENT'
         THEN app.timetable_pupil_days(p_school, p_target, p_from, p_tz, p_display)
         ELSE (
  WITH lessons AS (
    SELECT cl."id", cl."date", cl."startsAt", cl."endsAt", cl."status", cl."roomId", cl."subjectId", cl."studentGroupId",
           EXISTS (SELECT 1 FROM "CalendarLessonStudents" p WHERE p."calendarLessonId" = cl."id" AND p."moveId" IS NULL) AS "named"
      FROM "CalendarLessons" cl
     WHERE cl."schoolId" = p_school
       AND cl."date" BETWEEN p_from AND p_from + 6
       AND CASE p_kind
             WHEN 'GROUP' THEN (cl."studentGroupId" = p_target
                                OR EXISTS (SELECT 1 FROM "CalendarLessonGroups" x
                                            WHERE x."calendarLessonId" = cl."id" AND x."studentGroupId" = p_target))
             WHEN 'ROOM' THEN cl."roomId" = p_target
             ELSE EXISTS (SELECT 1 FROM "CalendarLessonTeachers" t WHERE t."calendarLessonId" = cl."id" AND t."teacherId" = p_target)
           END
       AND CASE p_kind
             WHEN 'TEACHER' THEN cl."status" IN ('SCHEDULED', 'COMPLETED')
             ELSE cl."status" IN ('SCHEDULED', 'COMPLETED', 'CANCELLED')
           END
  ),
  shown AS (
    SELECT l."date", l."startsAt",
           CASE
             WHEN l."named" AND p_kind = 'ROOM' THEN
               jsonb_build_object('start', to_char(l."startsAt" AT TIME ZONE p_tz, 'HH24:MI'),
                                  'end', to_char(l."endsAt" AT TIME ZONE p_tz, 'HH24:MI'),
                                  'busy', true)
             ELSE
               jsonb_build_object(
                 'start', to_char(l."startsAt" AT TIME ZONE p_tz, 'HH24:MI'),
                 'end', to_char(l."endsAt" AT TIME ZONE p_tz, 'HH24:MI'),
                 'subject', (SELECT s."name" FROM "Subjects" s WHERE s."id" = l."subjectId"),
                 'groups', (
                   SELECT coalesce(jsonb_agg(
                            CASE WHEN g."kind" = 'CLASS' OR app.public_group_size(g."id") >= p_min_size
                                 THEN to_jsonb(g."name") ELSE 'null'::jsonb END
                            ORDER BY (g."id" <> l."studentGroupId"), g."name"), '[]'::jsonb)
                     FROM "StudentGroups" g
                    WHERE (g."id" = l."studentGroupId"
                           OR g."id" IN (SELECT x."studentGroupId" FROM "CalendarLessonGroups" x WHERE x."calendarLessonId" = l."id"))
                      -- A class or group the school hides is named on no page.
                      AND NOT EXISTS (SELECT 1 FROM "PublicTimetableHidden" hg WHERE hg."targetGroupId" = g."id")),
                 -- Nor a room.
                 'room', (SELECT r."name" FROM "Rooms" r WHERE r."id" = l."roomId"
                             AND NOT EXISTS (SELECT 1 FROM "PublicTimetableHidden" hr WHERE hr."targetRoomId" = r."id")),
                 'teachers', CASE WHEN p_display = 'NONE' OR l."status" = 'CANCELLED' THEN '[]'::jsonb ELSE (
                   SELECT coalesce(jsonb_agg(lbl ORDER BY lbl), '[]'::jsonb) FROM (
                     SELECT CASE p_display
                              WHEN 'NAME' THEN u."firstName" || ' ' || u."lastName"
                              ELSE (SELECT e."signature" FROM "TeacherEmployments" e
                                     JOIN "StudentGroups" gy ON gy."id" = l."studentGroupId"
                                    WHERE e."userId" = u."id" AND e."academicYearId" = gy."academicYearId")
                            END AS lbl
                       FROM "CalendarLessonTeachers" t JOIN "Users" u ON u."id" = t."teacherId"
                      WHERE t."calendarLessonId" = l."id"
                        AND t."role" IN ('LEAD', 'ASSISTANT')
                        AND NOT EXISTS (SELECT 1 FROM "TeacherPublicLabels" h WHERE h."userId" = u."id" AND h."hidden")
                        AND NOT app.viewer_person_is_protected(u."id")
                   ) labels WHERE lbl IS NOT NULL) END
               )
               || CASE WHEN p_kind = 'TEACHER' THEN '{}'::jsonb
                       ELSE jsonb_build_object('cancelled', l."status" = 'CANCELLED') END
           END AS "lesson"
      FROM lessons l
     -- A few named pupils' lesson is theirs: not on a group's or a teacher's week.
     WHERE NOT (l."named" AND p_kind <> 'ROOM')
  )
  SELECT coalesce(jsonb_agg(day_json ORDER BY d), '[]'::jsonb)
    FROM (
      SELECT d::date AS d,
             jsonb_build_object(
               'date', to_char(d, 'YYYY-MM-DD'),
               'lessons', coalesce((SELECT jsonb_agg(s."lesson" ORDER BY s."startsAt", s."lesson"->>'end')
                                      FROM shown s WHERE s."date" = d::date), '[]'::jsonb)
             )
             || CASE WHEN p_kind = 'GROUP' AND p_meals
                          AND EXISTS (SELECT 1 FROM "StudentGroups" g WHERE g."id" = p_target AND g."kind" = 'CLASS')
                     THEN jsonb_build_object('meals', coalesce((
                            SELECT jsonb_agg(jsonb_build_object(
                                     'start', to_char(m."startsAt" AT TIME ZONE p_tz, 'HH24:MI'),
                                     'end', to_char(m."endsAt" AT TIME ZONE p_tz, 'HH24:MI')) ORDER BY m."startsAt")
                              FROM "CalendarLunches" m WHERE m."studentGroupId" = p_target AND m."date" = d::date), '[]'::jsonb))
                     ELSE '{}'::jsonb END AS day_json
        FROM generate_series(p_from, p_from + 6, interval '1 day') d
    ) w
         ) END
$$;

-- ---------------------------------------------------------------------------
-- Rapporteringsgrad: a lesson whose only pupils were moved away has no list.
-- 20270112090100's body with the one condition.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.reporting_lessons(p_school uuid, p_from date, p_to date, p_now timestamptz)
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
                   WHERE n."calendarLessonId" = cl."id" AND p."role" = 'STUDENT'
                     -- Elevens lektion för dagen: a named pupil moved off the lesson is not on its list.
                     AND NOT EXISTS (SELECT 1 FROM "public"."LessonPupilMoves" mv
                                      WHERE mv."fromLessonId" = cl."id" AND mv."studentId" = n."studentId"))
         )
     AND NOT EXISTS (
           SELECT 1 FROM "public"."TeacherAbsences" ab
            WHERE ab."schoolId" = cl."schoolId" AND ab."userId" = t."teacherId"
              AND ab."status" = 'ACTIVE'
              AND ab."startsAt" < cl."endsAt" AND cl."startsAt" < ab."endsAt")
$$;

-- ---------------------------------------------------------------------------
-- Gallring: a move goes with the school's choice for ATTENDANCE. Both bodies
-- are 20270117091000's plus the one branch marked "elevens lektion", so none
-- of Kvittens', Krisläges, Rapporteringsgrads, Frånvarobevakningens,
-- Vikariefrågans or Skyddad identitets is lost. A later release that
-- restates the functions again must carry every branch.
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
  -- elevens lektion: a move goes with the register of the day it took a pupil out of
  SELECT 'LessonPupilMoves', mv."id"
    FROM school, "public"."LessonPupilMoves" mv
    JOIN "public"."CalendarLessons" l ON l."id" = mv."fromLessonId" AND l."schoolId" = mv."schoolId"
   WHERE p_type = 'ATTENDANCE' AND mv."schoolId" = school."id" AND l."date" < p_before
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
      -- elevens lektion
      IF n < budget THEN
        DELETE FROM "LessonPupilMoves" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'LessonPupilMoves' LIMIT budget - n);
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
-- Row-level security and grants. See the preamble: read arms only, and the two
-- doors write.
-- ---------------------------------------------------------------------------

ALTER TABLE "LessonPupilMoves" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r text;
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    CREATE POLICY "lesson_pupil_moves_admin_select" ON "LessonPupilMoves"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    -- A teacher reads the moves on the lessons they teach, and those of the
    -- pupils they mentor that day.
    CREATE POLICY "lesson_pupil_moves_teacher_select" ON "LessonPupilMoves"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'TEACHER'
               AND (EXISTS (SELECT 1 FROM "CalendarLessonTeachers" t
                             WHERE t."calendarLessonId" IN ("LessonPupilMoves"."fromLessonId", "LessonPupilMoves"."toLessonId")
                               AND t."teacherId" = (select app.current_user_id()))
                    OR app.lesson_move_is_mentor("LessonPupilMoves"."studentId",
                                                 (SELECT l."date" FROM "CalendarLessons" l WHERE l."id" = "LessonPupilMoves"."fromLessonId"))));
    CREATE POLICY "lesson_pupil_moves_student_select" ON "LessonPupilMoves"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'STUDENT'
               AND "studentId" = (select app.current_user_id()));
    CREATE POLICY "lesson_pupil_moves_guardian_select" ON "LessonPupilMoves"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND "studentId" = ANY ((select CASE WHEN app.current_user_role() = 'GUARDIAN'
                                                   THEN app.current_guardian_child_ids() END)::uuid[]));

    -- The SS12000 provider (a school's service principal) reads a move to say who does not take
    -- part in an event, as it reads the arrival beside it (calendar_lesson_students_service_select).
    CREATE POLICY "lesson_pupil_moves_service_select" ON "LessonPupilMoves"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_service_school_id()));

    REVOKE ALL ON "LessonPupilMoves" FROM app_authenticated;
    GRANT SELECT ON "LessonPupilMoves" TO app_authenticated;

    GRANT EXECUTE ON FUNCTION app.lesson_pupil_move(uuid, uuid, uuid) TO "app_authenticated";
    GRANT EXECUTE ON FUNCTION app.lesson_pupil_move_undo(uuid) TO "app_authenticated";
    GRANT EXECUTE ON FUNCTION app.lesson_move_is_mentor(uuid, date) TO "app_authenticated";
    GRANT EXECUTE ON FUNCTION app.lesson_pupil_register_lock(uuid) TO "app_authenticated";
  END IF;

  FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "LessonPupilMoves" FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "LessonPupilMoves" FROM service_role';
  END IF;
  -- PostgreSQL 17's MAINTAIN (REINDEX, CLUSTER, VACUUM, LOCK): the owner's alone.
  IF current_setting('server_version_num')::int >= 170000 THEN
    FOREACH r IN ARRAY ARRAY['authenticated', 'app_authenticated', 'service_role', 'anon'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE MAINTAIN ON "LessonPupilMoves" FROM %I', r);
      END IF;
    END LOOP;
  END IF;

  -- The functions answer the API's role alone.
  FOREACH t IN ARRAY ARRAY[
    'app.lesson_pupil_move(uuid, uuid, uuid)', 'app.lesson_pupil_move_undo(uuid)',
    'app.lesson_pupil_move_remove(uuid, boolean)', 'app.lesson_move_may(uuid, uuid[], date)', 'app.lesson_move_may_correct(uuid)',
    'app.lesson_move_is_mentor(uuid, date)', 'app.lesson_pupil_move_is_parallel()',
    'app.lesson_pupil_move_tells_the_integrations()', 'app.lesson_pupil_moves_lapse()',
    'app.lesson_pupil_arrival_is_the_moves()', 'app.lesson_pupil_arrival_goes_with_the_move()',
    'app.lesson_pupil_register_lock(uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
END
$$;

COMMENT ON TABLE "LessonPupilMoves" IS
  'Elevens lektion för dagen: en elev flyttad från en lektion till en parallell för ett datum. Skrivs bara av app.lesson_pupil_move / app.lesson_pupil_move_undo; faller när lektionerna inte längre bär den. Ankomsten är en rad i CalendarLessonStudents med moveId.';
COMMENT ON FUNCTION app.lesson_pupil_move(uuid, uuid, uuid) IS
  'Flyttar en elev (p_student) från lektionen hen är på (p_from) till en parallell lektion (p_to) för dagen. Svarar flyttens id, eller NULL när eleven skickas tillbaka till sin ursprungliga lektion. Frågar app.lesson_move_may, tar lektionernas rader i id-ordning och sätter elevens markering på källan till UNKNOWN, men aldrig vid en ny flytt ur en lektion som är slut (LM416); efter slutet rättas en flytt (tillbaka, vidare) bara av den som får spara lektionens register. Felen har SQLSTATE LM4xx.';
COMMENT ON FUNCTION app.lesson_pupil_move_undo(uuid) IS
  'Ångrar en flytt: tar bort den (ankomsten går med) och lägger tillbaka elevens markering på källan om ingen skrivit en ny. Vägras (LM415) när eleven har en markering på mållektionen (den tas aldrig bort), (LM414) när källektionens dag är förbi, och (LM416) när källektionen är slut och den som ångrar varken är en administratör med Drift eller en lärare på den.';
COMMENT ON FUNCTION app.lesson_pupil_move_remove(uuid, boolean) IS
  'Tar bort en flytt och, med p_restore, lägger tillbaka den undanflyttade markeringen. Den som anropar har lektionernas lås och har frågat app.lesson_move_may.';
COMMENT ON FUNCTION app.lesson_pupil_register_lock(uuid) IS
  'Registret tar lektionens rad FOR SHARE, så en flytt och ett sparat register möts i en ordning. En funktion för att en lärare saknar UPDATE-policy på CalendarLessons och ett radlås under RLS då inte tar något lås.';
COMMENT ON FUNCTION app.lesson_move_may(uuid, uuid[], date) IS
  'Får den inloggade flytta eleven: en administratör med Drift, eller en lärare som undervisar någon av lektionerna eller är elevens mentor den dagen (app.leave_mentors).';
COMMENT ON FUNCTION app.lesson_move_may_correct(uuid) IS
  'Får den inloggade rätta en flytt efter att lektionen är slut: den som får spara lektionens register, en administratör med Drift eller en lärare på lektionen. Inte mentorn och inte målets lärare. Frågas för lektionen rättelsen tar eleven ur.';
COMMENT ON FUNCTION app.lesson_move_is_mentor(uuid, date) IS
  'Om den inloggade läraren är elevens mentor den dagen (ledighetsbeslutets definition). Läsarmens fråga.';
COMMENT ON FUNCTION app.lesson_pupil_move_is_parallel() IS
  'En flytt är två hållna lektioner i samma skola som överlappar i tid, och en aktiv elev i skolan. SQLSTATE LM410 (hålls inte), LM412 (inte parallella), LM413 (ersatt av aktivitet), LM404.';
COMMENT ON FUNCTION app.lesson_pupil_moves_lapse() IS
  'En flytt faller när en av lektionerna ställs in, ersätts eller flyttas så att de inte längre överlappar. Körs bara när tid eller status ändras.';
