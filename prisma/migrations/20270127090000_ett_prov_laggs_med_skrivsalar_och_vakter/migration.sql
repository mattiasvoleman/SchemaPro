-- Ett prov läggs med skrivsalar och vakter.
--
-- Skolan lägger in ett prov (ämne, klasser, längd, antal skrivande och ett
-- önskat fönster) och en liten modell i motorn hittar tid, skrivsalar och
-- vakter. Provet blir en schemabrytande aktivitet (20270101090000): de
-- ordinarie lektionerna ställs in, en ersättningslektion per klass bär
-- närvaron, och de lärare som håller vakt står på den. Det här är tabellerna
-- för det som aktiviteten inte bär: vad skolan bad om, vilka salar som får
-- användas, vilken sal som rymmer hur många, och vem som vakar var.
--
-- ## Sex tabeller
--
-- ExamPlanSettings: en rad per skola. enabled är FALSE som förval: motorns
-- modell slås på per skola efter egen mätning, och en skola som aldrig gör det
-- kan ändå lägga in prov. Taken (högst N prov per klass och dag, M per vecka),
-- hur många skrivande en vakt rymmer, omställningen mellan två prov i samma sal
-- eller för samma vakt, och ämnet ersättningslektionerna hålls i (ett som inte
-- räknas mot timplanen, som aktivitetens: provets egna minuter kommer som en
-- kredit på provets ämne, så att en lektion inte räknas två gånger).
--
-- ExamRooms: de salar skolan märkt som skrivsalar, med hur många platser ett
-- prov har där (färre än salens kapacitet när bänkarna står glesare). Raden är
-- märket. Salen tas bort och märket går med den.
--
-- Exams: provet. Ett fönster av två slag (CHECK): WEEK, ett spann om högst 31
-- dagar med valfria dagliga gränser för start och slut, och FIXED, ett datum
-- och en starttid (nationella prov). activityId sätts när provet är lagt och är
-- aktiviteten som bär det: dag och tid ligger i aktivitetens avbokning och
-- skrivs inte en gång till här. lastReason är skälet till att senaste körningen
-- inte kunde lägga det (en kod, med sina siffror), så att det syns kvar sedan
-- förslaget stängts.
--
-- ExamGroups: klasserna och grupperna provet gäller. studentGroupId är ingen
-- främmande nyckel, av samma skäl som aktivitetens (20270101090000): klassen
-- står redan i ett urval som tas bort med den, och en nyckel dit skulle bara
-- lägga en rad till i dialogen för att ta bort en klass. En klass som tagits
-- bort ur läsåret faller ur provet när det läses.
--
-- ExamSittings: en rad per sal provet skrivs i, med hur många som skriver där
-- och den bokning (RoomBookings) som håller salen. En bokning är det som får
-- salen att synas upptagen i sökningen efter lediga salar och i bokningssidan.
--
-- ExamInvigilators: läraren som vakar i en sal. En lärare vakar i en sal per
-- prov (UNIQUE examId, teacherId). Personal och ingen elev; en lärare som tas
-- bort tar sina rader med sig (CASCADE).
--
-- ## Skyddad identitet
--
-- Planeraren lämnar en lärare med skyddad identitet ur vaktpoolen (hon namnges
-- på ingen lista utanför registret, och en vaktlista namnger), så ingen rad här
-- skapas för henne. Markeras en lärare efter att hon fått en vaktrad visar
-- skärmarna och utskriften inte raden. Det kan databasen inte uttrycka: ett
-- märke i PersonProtections säger inget om vilka läsningar som blir listor.
--
-- ## Radnivåsäkerhet
--
-- Fyra policyer per tabell, för administratörer (läsare inräknade) att läsa och
-- för området DRIFT att skriva (app.current_user_may), som aktivitetens tre
-- tabeller. De gäller app_authenticated, API:ts roll. Ingen arm för lärare,
-- elev eller vårdnadshavare: de läser provet som en ersättningslektion i
-- kalendern, och de som vakar som lärarrad på den. Ingenting för anon,
-- authenticated eller service_role, och MAINTAIN är ägarens (Postgres 17).
-- Ingen gallring har något att göra här: tabellerna bär ingen personuppgift
-- utöver lärarens id.
--
-- ## Brevid det API som körs
--
-- Additiv: sex nya tabeller, en unik nyckel på RoomBookings (id, schoolId) som
-- ExamSittings.bookingId pekar på, och inget annat. Det API som körs läser och
-- skriver ingen av dem.
--
-- ## Lås
--
-- De främmande nycklarna tar SHARE ROW EXCLUSIVE på de tabeller de pekar på,
-- bland dem Users och Rooms, och den unika nyckeln på RoomBookings tar SHARE.
-- Låsen tas NOWAIT och tillsammans i en slinga med 30 sekunders tak, som de
-- migreringar gör som rör heta tabeller: ingen förfrågan köar bakom
-- migreringen, och den väntar aldrig medan den håller ett lås. Efter 30
-- sekunders nekanden stannar den utan att ha gjort något; Prisma kör inte
-- filen igen (P3009) förrän den markerats återrullad, vilket felet säger.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Schools", "AcademicYears", "Users", "Subjects", "Rooms",
                 "RoomBookings", "ScheduleActivities" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'The tables the new keys point at were not free at once in 30 s: nothing is changed. Mark this migration rolled back (prisma migrate resolve --rolled-back 20270127090000_ett_prov_laggs_med_skrivsalar_och_vakter) and run prisma migrate deploy again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

-- The target of ExamSittings.bookingId, so that the key can carry the school.
CREATE UNIQUE INDEX "RoomBookings_id_schoolId_key" ON "RoomBookings"("id", "schoolId");

CREATE TABLE "ExamPlanSettings" (
    "schoolId"              UUID NOT NULL,
    "enabled"               BOOLEAN NOT NULL DEFAULT false,
    "maxPerClassPerDay"     INTEGER NOT NULL DEFAULT 1,
    "maxPerClassPerWeek"    INTEGER NOT NULL DEFAULT 3,
    "writersPerInvigilator" INTEGER NOT NULL DEFAULT 30,
    "turnoverMinutes"       INTEGER NOT NULL DEFAULT 10,
    "replacementSubjectId"  UUID,
    "updatedAt"             TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "ExamPlanSettings_pkey" PRIMARY KEY ("schoolId"),
    CONSTRAINT "ExamPlanSettings_per_day_is_sane" CHECK ("maxPerClassPerDay" BETWEEN 1 AND 10),
    CONSTRAINT "ExamPlanSettings_per_week_is_sane" CHECK ("maxPerClassPerWeek" BETWEEN 1 AND 30),
    -- A week holds at least a day's worth.
    CONSTRAINT "ExamPlanSettings_week_holds_a_day" CHECK ("maxPerClassPerWeek" >= "maxPerClassPerDay"),
    CONSTRAINT "ExamPlanSettings_ratio_is_sane" CHECK ("writersPerInvigilator" BETWEEN 1 AND 200),
    CONSTRAINT "ExamPlanSettings_turnover_is_sane" CHECK ("turnoverMinutes" BETWEEN 0 AND 120)
);

CREATE INDEX "ExamPlanSettings_replacementSubjectId_schoolId_idx" ON "ExamPlanSettings"("replacementSubjectId", "schoolId");

ALTER TABLE "ExamPlanSettings"
    ADD CONSTRAINT "ExamPlanSettings_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- A subject deleted empties the choice; the school picks another before the next plan.
ALTER TABLE "ExamPlanSettings"
    ADD CONSTRAINT "ExamPlanSettings_replacementSubjectId_schoolId_fkey"
    FOREIGN KEY ("replacementSubjectId", "schoolId") REFERENCES "Subjects"("id", "schoolId")
    ON DELETE SET NULL ("replacementSubjectId") ON UPDATE NO ACTION;

CREATE TABLE "ExamRooms" (
    "roomId"    UUID NOT NULL,
    "schoolId"  UUID NOT NULL,
    "seats"     INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "ExamRooms_pkey" PRIMARY KEY ("roomId"),
    CONSTRAINT "ExamRooms_seats_are_sane" CHECK ("seats" BETWEEN 1 AND 2000)
);

CREATE INDEX "ExamRooms_schoolId_idx" ON "ExamRooms"("schoolId");

ALTER TABLE "ExamRooms"
    ADD CONSTRAINT "ExamRooms_roomId_schoolId_fkey"
    FOREIGN KEY ("roomId", "schoolId") REFERENCES "Rooms"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE NO ACTION;

CREATE TABLE "Exams" (
    "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"         UUID NOT NULL,
    "academicYearId"   UUID NOT NULL,
    "subjectId"        UUID NOT NULL,
    "name"             TEXT NOT NULL,
    "lengthMinutes"    INTEGER NOT NULL,
    "writers"          INTEGER NOT NULL,
    "windowKind"       TEXT NOT NULL,
    "windowFrom"       DATE NOT NULL,
    "windowTo"         DATE NOT NULL,
    "fixedStart"       TIME(6),
    "earliestStart"    TIME(6),
    "latestEnd"        TIME(6),
    "activityId"       UUID,
    "lastReason"       TEXT,
    "lastReasonParams" JSONB,
    "lastPlannedAt"    TIMESTAMPTZ(6),
    "createdAt"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "createdByUserId"  UUID,

    CONSTRAINT "Exams_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Exams_name_is_sane" CHECK (char_length(btrim("name")) BETWEEN 1 AND 80),
    CONSTRAINT "Exams_length_is_sane" CHECK ("lengthMinutes" BETWEEN 5 AND 480),
    CONSTRAINT "Exams_writers_are_sane" CHECK ("writers" BETWEEN 1 AND 2000),
    CONSTRAINT "Exams_window_kind" CHECK ("windowKind" IN ('WEEK', 'FIXED')),
    -- 31 days inclusive, as an avbokning (CancellationBatches).
    CONSTRAINT "Exams_window_is_in_order" CHECK ("windowTo" >= "windowFrom" AND "windowTo" - "windowFrom" <= 30),
    -- A fixed exam is one date and a start; the daily bounds are for a window that leaves the time open.
    CONSTRAINT "Exams_fixed_is_a_date_and_a_start" CHECK (
        ("windowKind" = 'FIXED' AND "windowFrom" = "windowTo" AND "fixedStart" IS NOT NULL
         AND "earliestStart" IS NULL AND "latestEnd" IS NULL)
        OR ("windowKind" = 'WEEK' AND "fixedStart" IS NULL)
    ),
    CONSTRAINT "Exams_bounds_are_in_order" CHECK (
        "earliestStart" IS NULL OR "latestEnd" IS NULL OR "earliestStart" < "latestEnd"
    ),
    CONSTRAINT "Exams_reason_is_a_code" CHECK (
        ("lastReason" IS NULL AND "lastReasonParams" IS NULL AND "lastPlannedAt" IS NULL)
        OR ("lastReason" IS NOT NULL AND char_length("lastReason") BETWEEN 1 AND 60 AND "lastPlannedAt" IS NOT NULL
            AND ("lastReasonParams" IS NULL OR jsonb_typeof("lastReasonParams") = 'object'))
    )
);

CREATE UNIQUE INDEX "Exams_id_schoolId_key" ON "Exams"("id", "schoolId");
-- An activity carries one exam.
CREATE UNIQUE INDEX "Exams_activityId_key" ON "Exams"("activityId") WHERE "activityId" IS NOT NULL;
CREATE INDEX "Exams_schoolId_idx" ON "Exams"("schoolId");
CREATE INDEX "Exams_academicYearId_schoolId_windowFrom_idx" ON "Exams"("academicYearId", "schoolId", "windowFrom");
CREATE INDEX "Exams_subjectId_schoolId_idx" ON "Exams"("subjectId", "schoolId");
CREATE INDEX "Exams_activityId_schoolId_idx" ON "Exams"("activityId", "schoolId");
CREATE INDEX "Exams_createdByUserId_schoolId_idx" ON "Exams"("createdByUserId", "schoolId");

ALTER TABLE "Exams"
    ADD CONSTRAINT "Exams_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Exams"
    ADD CONSTRAINT "Exams_academicYearId_schoolId_fkey"
    FOREIGN KEY ("academicYearId", "schoolId") REFERENCES "AcademicYears"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;
-- A subject deleted takes its exams with it, as it takes a lesson and a credit.
ALTER TABLE "Exams"
    ADD CONSTRAINT "Exams_subjectId_schoolId_fkey"
    FOREIGN KEY ("subjectId", "schoolId") REFERENCES "Subjects"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE NO ACTION;
-- The activity goes only with its year (the avbokning's own key cascades from it); an exam without it is unplanned.
ALTER TABLE "Exams"
    ADD CONSTRAINT "Exams_activityId_schoolId_fkey"
    FOREIGN KEY ("activityId", "schoolId") REFERENCES "ScheduleActivities"("id", "schoolId")
    ON DELETE SET NULL ("activityId") ON UPDATE NO ACTION;
ALTER TABLE "Exams"
    ADD CONSTRAINT "Exams_createdByUserId_schoolId_fkey"
    FOREIGN KEY ("createdByUserId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE SET NULL ("createdByUserId") ON UPDATE NO ACTION;

CREATE TABLE "ExamGroups" (
    "examId"         UUID NOT NULL,
    "studentGroupId" UUID NOT NULL,
    "schoolId"       UUID NOT NULL,

    CONSTRAINT "ExamGroups_pkey" PRIMARY KEY ("examId", "studentGroupId")
);

CREATE INDEX "ExamGroups_studentGroupId_schoolId_idx" ON "ExamGroups"("studentGroupId", "schoolId");
CREATE INDEX "ExamGroups_schoolId_idx" ON "ExamGroups"("schoolId");

ALTER TABLE "ExamGroups"
    ADD CONSTRAINT "ExamGroups_examId_schoolId_fkey"
    FOREIGN KEY ("examId", "schoolId") REFERENCES "Exams"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE NO ACTION;

CREATE TABLE "ExamSittings" (
    "examId"    UUID NOT NULL,
    "roomId"    UUID NOT NULL,
    "schoolId"  UUID NOT NULL,
    "writers"   INTEGER NOT NULL,
    "bookingId" UUID,

    CONSTRAINT "ExamSittings_pkey" PRIMARY KEY ("examId", "roomId"),
    CONSTRAINT "ExamSittings_writers_are_sane" CHECK ("writers" BETWEEN 1 AND 2000)
);

CREATE UNIQUE INDEX "ExamSittings_examId_roomId_schoolId_key" ON "ExamSittings"("examId", "roomId", "schoolId");
CREATE INDEX "ExamSittings_roomId_schoolId_idx" ON "ExamSittings"("roomId", "schoolId");
CREATE INDEX "ExamSittings_bookingId_schoolId_idx" ON "ExamSittings"("bookingId", "schoolId");
CREATE INDEX "ExamSittings_schoolId_idx" ON "ExamSittings"("schoolId");

ALTER TABLE "ExamSittings"
    ADD CONSTRAINT "ExamSittings_examId_schoolId_fkey"
    FOREIGN KEY ("examId", "schoolId") REFERENCES "Exams"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE NO ACTION;
-- A room deleted takes its sitting; the exam then shows fewer writers seated than it has.
ALTER TABLE "ExamSittings"
    ADD CONSTRAINT "ExamSittings_roomId_schoolId_fkey"
    FOREIGN KEY ("roomId", "schoolId") REFERENCES "Rooms"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE NO ACTION;
-- A booking cancelled away (its booker deleted) leaves the sitting without it.
ALTER TABLE "ExamSittings"
    ADD CONSTRAINT "ExamSittings_bookingId_schoolId_fkey"
    FOREIGN KEY ("bookingId", "schoolId") REFERENCES "RoomBookings"("id", "schoolId")
    ON DELETE SET NULL ("bookingId") ON UPDATE NO ACTION;

CREATE TABLE "ExamInvigilators" (
    "examId"    UUID NOT NULL,
    "roomId"    UUID NOT NULL,
    "teacherId" UUID NOT NULL,
    "schoolId"  UUID NOT NULL,

    CONSTRAINT "ExamInvigilators_pkey" PRIMARY KEY ("examId", "roomId", "teacherId")
);

-- A teacher keeps watch in one room at an exam.
CREATE UNIQUE INDEX "ExamInvigilators_examId_teacherId_key" ON "ExamInvigilators"("examId", "teacherId");
CREATE INDEX "ExamInvigilators_teacherId_schoolId_idx" ON "ExamInvigilators"("teacherId", "schoolId");
CREATE INDEX "ExamInvigilators_schoolId_idx" ON "ExamInvigilators"("schoolId");

ALTER TABLE "ExamInvigilators"
    ADD CONSTRAINT "ExamInvigilators_examId_roomId_schoolId_fkey"
    FOREIGN KEY ("examId", "roomId", "schoolId") REFERENCES "ExamSittings"("examId", "roomId", "schoolId")
    ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "ExamInvigilators"
    ADD CONSTRAINT "ExamInvigilators_teacherId_schoolId_fkey"
    FOREIGN KEY ("teacherId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- Row-level security and grants. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "ExamPlanSettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExamRooms" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Exams" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExamGroups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExamSittings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExamInvigilators" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t record;
  r text;
BEGIN
  FOR t IN SELECT * FROM (VALUES ('ExamPlanSettings', 'exam_plan_settings'),
                                 ('ExamRooms', 'exam_rooms'),
                                 ('Exams', 'exams'),
                                 ('ExamGroups', 'exam_groups'),
                                 ('ExamSittings', 'exam_sittings'),
                                 ('ExamInvigilators', 'exam_invigilators')) AS v(tbl, arm) LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
      EXECUTE format($p$
        CREATE POLICY %I ON %I
            FOR SELECT TO "app_authenticated"
            USING ("schoolId" = (select app.current_school_id())
                   AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
      $p$, t.arm || '_admin_select', t.tbl);
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
