-- En schemabrytande aktivitet ställer in lektionerna och ersätter dem med en
-- lektion per klass som bär närvaron.
--
-- Friluftsdagen, praon och de nationella proven ställer in klassens ordinarie
-- lektioner. Det kunde skolan göra redan (en avbokning, 20261011110000, med
-- en tillgodoräknad tid), men eleverna stod då utan en lektion att vara
-- närvarande på: frånvaron i registret var det enda som återstod, och en
-- lärare som följde klassen syntes ingenstans. Aktiviteten är avbokningen
-- och det som kommer i stället.
--
-- ## Tre tabeller
--
-- ScheduleActivities: aktiviteten. Den äger EN avbokning (batchId, unik): namn,
-- datumspann, tidsfönster och urval bor i avbokningen och finns på ett ställe.
-- Här bor det som är aktivitetens: ämnet för ersättningslektionerna, en
-- beskrivning som eleverna läser på lektionen, och de klasser och grupper
-- administratören nämnde (scopeGroupIds, före avbokningens utvidgning med
-- halvklasser och grupper som ligger helt inom klasserna). removedAt är
-- borttagningen, en gång: posten blir kvar som avbokningens egen post gör.
--
-- ScheduleActivityTeachers: de ansvariga lärarna per klass eller grupp. LEAD
-- (högst en per grupp) eller ASSISTANT, aldrig SUBSTITUTE: en vikarie är en
-- lektions sak och sätts på den enskilda ersättningslektionen.
--
-- ScheduleActivityLessons: ersättningslektionerna. En CalendarLesson utan
-- masterLessonId, en per grupp och dag (unik), märkt här. Samma tabell säger
-- vilken lektion som är aktivitetens och vilken som är grundschemats.
--
-- ## Gruppnycklarna
--
-- studentGroupId på ScheduleActivityTeachers och ScheduleActivityLessons är
-- ingen främmande nyckel. Klassen står i aktivitetens urval (scopeGroupIds),
-- och ersättningslektionen är en lektion i klassen som tas bort med den
-- (CalendarLessons.studentGroupId, CASCADE, och märkningen följer lektionen):
-- en nyckel till klassen skulle bara lägga en rad till i dialogen för att ta
-- bort en klass som redan räknar lektionerna, och som ingen administratör har
-- något att vänta sig av. En lärarrad för en klass som tagits bort står kvar
-- utan verkan; nästa ändring av aktiviteten skriver om raderna. Kolumnerna har
-- sina index, för slagningarna.
--
-- ## Ersättningslektionens ämne
--
-- Ett ämne som inte räknas mot timplanen (Subjects.countsTowardTimplan =
-- false). Aktivitetens minuter kommer in som krediter på de ämnen skolan
-- namnger (TimplanCredits, via avbokningens kreditlänk), och en lektion som
-- också räknades som genomförd i ett ämne skulle räknas två gånger. Tjänsten
-- vägrar ett ämne som räknas (ACTIVITY_SUBJECT_COUNTS); databasen kan inte
-- hålla det, eftersom ämnets egen kolumn kan ändras efteråt, så vyn säger
-- det om det händer. Lektionen är genomförd tid för läraren (personalens
-- avstämning läser alla ämnen) och för ingen elevs timplan: se
-- src/common/timplan-delivered.ts.
--
-- ## Radnivåsäkerhet
--
-- Fyra policyer per tabell: personalen (administratör och lärare) läser, och
-- administratören lägger till, ändrar och tar bort i området DRIFT
-- (app.current_user_may), som avbokningens tabeller gör. De gäller
-- app_authenticated, API:ts roll; PostgREST:s roll (authenticated) har ingenting
-- här, till skillnad från avbokningens tabeller, eftersom ingen sida läser dem
-- därifrån. Ingen arm för elev eller vårdnadshavare: de läser
-- ersättningslektionen i kalendern som vilken lektion som helst, och de
-- ansvariga lärarna i lektionens egen lärarrad. Inga personuppgifter finns i
-- tabellerna utöver lärarens id; en lärare som tas bort tar sina rader med
-- sig (CASCADE), och den som skapade eller tog bort aktiviteten lämnar posten
-- (SET NULL på sin egen kolumn). Ingen gallring har något att göra här.
--
-- ## Brevid det API som körs
--
-- Additiv: tre nya tabeller och inget annat. API:t före detta läser och skriver
-- ingen av dem, och avbokningens egna tabeller är orörda. En avbokning som
-- gamla API:t gör bärs av ingen aktivitet.
--
-- ## Lås
--
-- De främmande nycklarna tar SHARE ROW EXCLUSIVE på de tabeller de pekar på,
-- bland dem Users och CalendarLessons. Låsen tas NOWAIT och tillsammans i en
-- slinga med 30 sekunders tak, som de migreringar gör som rör heta tabeller:
-- ingen förfrågan köar bakom migreringen, och den väntar aldrig medan den
-- håller ett lås. Efter 30 sekunders nekanden stannar den utan att ha gjort
-- något; Prisma kör inte filen igen (P3009) förrän den markerats återrullad,
-- vilket felet säger.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Schools", "AcademicYears", "Users", "StudentGroups", "Subjects", "CalendarLessons",
                 "CancellationBatches" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'The tables the new keys point at were not free at once in 30 s: nothing is changed. Mark this migration rolled back (prisma migrate resolve --rolled-back 20270101090000_en_schemabrytande_aktivitet_stoller_in_och_ersatter_lektionerna) and run prisma migrate deploy again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

CREATE TABLE "ScheduleActivities" (
    "id"                   UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"             UUID NOT NULL,
    "academicYearId"       UUID NOT NULL,
    "batchId"              UUID NOT NULL,
    "replacementSubjectId" UUID NOT NULL,
    "description"          TEXT,
    "scopeGroupIds"        UUID[] NOT NULL DEFAULT '{}',
    "createdAt"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "createdByUserId"      UUID,
    "updatedAt"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "removedAt"            TIMESTAMPTZ(6),
    "removedByUserId"      UUID,

    CONSTRAINT "ScheduleActivities_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ScheduleActivities_description_is_sane" CHECK (
        "description" IS NULL OR char_length(btrim("description")) BETWEEN 1 AND 300
    ),
    CONSTRAINT "ScheduleActivities_scope_ids_are_few" CHECK (cardinality("scopeGroupIds") <= 200),
    -- Whoever removed it needs a time to have removed it at. (That a removal is
    -- never taken back is the service's rule: the database does not hold it.)
    CONSTRAINT "ScheduleActivities_removal_is_recorded" CHECK ("removedAt" IS NOT NULL OR "removedByUserId" IS NULL)
);

CREATE UNIQUE INDEX "ScheduleActivities_id_schoolId_key" ON "ScheduleActivities"("id", "schoolId");
CREATE UNIQUE INDEX "ScheduleActivities_batchId_key" ON "ScheduleActivities"("batchId");
CREATE INDEX "ScheduleActivities_schoolId_idx" ON "ScheduleActivities"("schoolId");
CREATE INDEX "ScheduleActivities_academicYearId_schoolId_idx" ON "ScheduleActivities"("academicYearId", "schoolId");
CREATE INDEX "ScheduleActivities_replacementSubjectId_schoolId_idx" ON "ScheduleActivities"("replacementSubjectId", "schoolId");
CREATE INDEX "ScheduleActivities_createdByUserId_schoolId_idx" ON "ScheduleActivities"("createdByUserId", "schoolId");
CREATE INDEX "ScheduleActivities_removedByUserId_schoolId_idx" ON "ScheduleActivities"("removedByUserId", "schoolId");

ALTER TABLE "ScheduleActivities"
    ADD CONSTRAINT "ScheduleActivities_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScheduleActivities"
    ADD CONSTRAINT "ScheduleActivities_academicYearId_schoolId_fkey"
    FOREIGN KEY ("academicYearId", "schoolId") REFERENCES "AcademicYears"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;
-- The avbokning goes only when the school does (its own composite key cascades
-- from the year); an activity without its avbokning is nothing.
ALTER TABLE "ScheduleActivities"
    ADD CONSTRAINT "ScheduleActivities_batchId_schoolId_fkey"
    FOREIGN KEY ("batchId", "schoolId") REFERENCES "CancellationBatches"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;
-- A subject deleted takes the activity with it, as it takes a credit and a lesson.
ALTER TABLE "ScheduleActivities"
    ADD CONSTRAINT "ScheduleActivities_replacementSubjectId_schoolId_fkey"
    FOREIGN KEY ("replacementSubjectId", "schoolId") REFERENCES "Subjects"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScheduleActivities"
    ADD CONSTRAINT "ScheduleActivities_createdByUserId_schoolId_fkey"
    FOREIGN KEY ("createdByUserId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE SET NULL ("createdByUserId") ON UPDATE NO ACTION;
ALTER TABLE "ScheduleActivities"
    ADD CONSTRAINT "ScheduleActivities_removedByUserId_schoolId_fkey"
    FOREIGN KEY ("removedByUserId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE SET NULL ("removedByUserId") ON UPDATE NO ACTION;

CREATE TABLE "ScheduleActivityTeachers" (
    "activityId"     UUID NOT NULL,
    "studentGroupId" UUID NOT NULL,
    "teacherId"      UUID NOT NULL,
    "schoolId"       UUID NOT NULL,
    "role"           "TeacherAssignmentRole" NOT NULL DEFAULT 'LEAD',

    CONSTRAINT "ScheduleActivityTeachers_pkey" PRIMARY KEY ("activityId", "studentGroupId", "teacherId"),
    CONSTRAINT "ScheduleActivityTeachers_role_is_responsible" CHECK ("role" IN ('LEAD', 'ASSISTANT'))
);

-- One lead per group (the lesson's first teacher); assistants are as many as the school names.
CREATE UNIQUE INDEX "ScheduleActivityTeachers_one_lead_per_group"
    ON "ScheduleActivityTeachers"("activityId", "studentGroupId") WHERE "role" = 'LEAD';
CREATE INDEX "ScheduleActivityTeachers_studentGroupId_schoolId_idx" ON "ScheduleActivityTeachers"("studentGroupId", "schoolId");
CREATE INDEX "ScheduleActivityTeachers_teacherId_schoolId_idx" ON "ScheduleActivityTeachers"("teacherId", "schoolId");
CREATE INDEX "ScheduleActivityTeachers_schoolId_idx" ON "ScheduleActivityTeachers"("schoolId");

ALTER TABLE "ScheduleActivityTeachers"
    ADD CONSTRAINT "ScheduleActivityTeachers_activityId_schoolId_fkey"
    FOREIGN KEY ("activityId", "schoolId") REFERENCES "ScheduleActivities"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScheduleActivityTeachers"
    ADD CONSTRAINT "ScheduleActivityTeachers_teacherId_schoolId_fkey"
    FOREIGN KEY ("teacherId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE NO ACTION;

CREATE TABLE "ScheduleActivityLessons" (
    "activityId"       UUID NOT NULL,
    "calendarLessonId" UUID NOT NULL,
    "studentGroupId"   UUID NOT NULL,
    "date"             DATE NOT NULL,
    "schoolId"         UUID NOT NULL,

    CONSTRAINT "ScheduleActivityLessons_pkey" PRIMARY KEY ("activityId", "calendarLessonId")
);

-- A lesson belongs to one activity, and a group has one replacement lesson a day.
CREATE UNIQUE INDEX "ScheduleActivityLessons_calendarLessonId_key" ON "ScheduleActivityLessons"("calendarLessonId");
CREATE UNIQUE INDEX "ScheduleActivityLessons_activityId_studentGroupId_date_key"
    ON "ScheduleActivityLessons"("activityId", "studentGroupId", "date");
CREATE INDEX "ScheduleActivityLessons_studentGroupId_schoolId_idx" ON "ScheduleActivityLessons"("studentGroupId", "schoolId");
CREATE INDEX "ScheduleActivityLessons_schoolId_idx" ON "ScheduleActivityLessons"("schoolId");

ALTER TABLE "ScheduleActivityLessons"
    ADD CONSTRAINT "ScheduleActivityLessons_activityId_schoolId_fkey"
    FOREIGN KEY ("activityId", "schoolId") REFERENCES "ScheduleActivities"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScheduleActivityLessons"
    ADD CONSTRAINT "ScheduleActivityLessons_calendarLessonId_schoolId_fkey"
    FOREIGN KEY ("calendarLessonId", "schoolId") REFERENCES "CalendarLessons"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security and grants. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "ScheduleActivities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScheduleActivityTeachers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScheduleActivityLessons" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t record;
  r text;
BEGIN
  FOR t IN SELECT * FROM (VALUES ('ScheduleActivities', 'schedule_activities'),
                                 ('ScheduleActivityTeachers', 'schedule_activity_teachers'),
                                 ('ScheduleActivityLessons', 'schedule_activity_lessons')) AS v(tbl, arm) LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
      EXECUTE format($p$
        CREATE POLICY %I ON %I
            FOR SELECT TO "app_authenticated"
            USING ("schoolId" = (select app.current_school_id())
                   AND (select app.current_user_role()) IN ('SCHOOL_ADMIN', 'TEACHER'))
      $p$, t.arm || '_staff_select', t.tbl);
      EXECUTE format($p$
        CREATE POLICY %I ON %I
            FOR INSERT TO "app_authenticated"
            WITH CHECK ("schoolId" = (select app.current_school_id())
                        AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                        AND (select app.current_user_may('DRIFT', true)))
      $p$, t.arm || '_admin_insert', t.tbl);
      EXECUTE format($p$
        CREATE POLICY %I ON %I
            FOR UPDATE TO "app_authenticated"
            USING ("schoolId" = (select app.current_school_id())
                   AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
            WITH CHECK ("schoolId" = (select app.current_school_id())
                        AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                        AND (select app.current_user_may('DRIFT', true)))
      $p$, t.arm || '_admin_update', t.tbl);
      EXECUTE format($p$
        CREATE POLICY %I ON %I
            FOR DELETE TO "app_authenticated"
            USING ("schoolId" = (select app.current_school_id())
                   AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                   AND (select app.current_user_may('DRIFT', true)))
      $p$, t.arm || '_admin_delete', t.tbl);
      EXECUTE format('REVOKE ALL ON %I FROM "app_authenticated"', t.tbl);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO "app_authenticated"', t.tbl);
    END IF;
    FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', t.tbl, r);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM "service_role"', t.tbl);
    END IF;
    -- PostgreSQL 17's MAINTAIN (REINDEX, CLUSTER, VACUUM, LOCK): the owner's alone.
    IF current_setting('server_version_num')::int >= 170000 THEN
      FOREACH r IN ARRAY ARRAY['authenticated', 'app_authenticated', 'service_role', 'anon'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
          EXECUTE format('REVOKE MAINTAIN ON %I FROM %I', t.tbl, r);
        END IF;
      END LOOP;
    END IF;
  END LOOP;
END
$$;
