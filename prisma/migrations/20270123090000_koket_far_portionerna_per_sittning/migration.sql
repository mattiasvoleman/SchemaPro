-- Köket får portionerna per sittning.
--
-- Måltidskollen (D8). Köket får dagliga portionsantal per lunchsittning, räknade
-- ur det PUBLICERADE schemat: en rad i CalendarLunches är en klass måltid ett
-- visst datum, och den finns bara för det som publicerats (lov och studiedagar
-- har redan hoppats över av publiceringen). Antalet per sittning och dag är
--
--   eleverna i klasserna som äter i sittningen          (aktiva elever, klassen
--                                                         som hemklass)
--   minus anmäld frånvaro som kommit före brytpunkten   (AbsenceReports som
--                                                         täcker hela sittningen)
--   plus personal som äter i sittningen                 (pedagogisk lunch med
--                                                         fast tid, om skolan lagt
--                                                         en)
--
-- Brytpunkten är en tid per skola (KitchenSettings.cutoffTime). Är den inte satt
-- räknas ingen frånvaro bort. Frånvaro som anmäls efter brytpunkten dras aldrig
-- av: den räknas och visas för sig ("anmäld efter brytpunkten"), så att köket
-- ser vad som ändrats sedan beställningen utan att siffran den lutade sig mot
-- ändras bakom ryggen på den. Brytpunkten för ett datum D är D kl. cutoffTime
-- i skolans tidszon; en frånvaro räknas som "före" när dess första anmälan
-- (AbsenceReports.createdAt) är äldre än så. Siffrorna beror alltså inte på
-- vilken tid det är nu, och ett brev som går sent visar samma tal som ett som
-- gick i tid.
--
-- ## Vad som medvetet inte räknas
--
--   * Ingen specialkost. Allergier och kostval är hälsouppgifter och lagras inte
--     i Rastra. Inget i den här migreringen, i sidan, i filen eller i brevet har
--     en kolumn eller ett ord för dem.
--   * En schemabrytande aktivitet (D3) säger inte om klassen äter i skolan eller
--     har egen lunch, så den dras inte av. Det som finns är att klassen har en
--     ersättningslektion över sittningen; det visas för sig ("varav i klasser
--     med aktivitet") och räknas ändå, eftersom ett kök som beställer för få
--     portioner är värre än ett som beställer för många.
--   * Personal räknas bara när skolan lagt en pedagogisk lunch (TeacherDuties
--     kind PEDAGOGISK_LUNCH) med fast tid (TeacherDutySlots). Utan en sådan
--     står personalen utanför och svaret säger det (staffModelled = false).
--     Läraren hör till den sittning vars fönster den fasta tiden överlappar mest
--     (lika: den tidigaste), en gång per dag. En lärares frånvaro drar inte av
--     personalen: vikarien tar ofta platsen.
--   * Frånvaro som bara täcker en del av sittningen (ett läkarbesök 11:00-11:20
--     i en sittning 11:00-11:30) dras inte av: eleven äter. Bara en anmälan som
--     täcker hela sittningen räknas.
--
-- ## Rosterns grund är dagens
--
-- Eleverna är aktiva elever vars hemklass (Users.studentGroupId) är klassen i
-- CalendarLunches, som lektionernas lista (calendar/lesson-roster.ts): dagens
-- klasslistor, inte historik. Webben och brevet frågar bara efter dagar från
-- och med idag, för efter en rullning är en gammal klass tom och ett gammalt
-- datum skulle räknas med dagens klasser.
--
-- ## Vad som läggs till
--
--   KitchenSettings        en rad per skola: brytpunkten, om dagens brev är på,
--                          och köksadressen. Avstängd som förval (ingen rad =
--                          ingen brytpunkt, inget brev). Köksadressen är skolans
--                          uppgift och ingen användare. Inga personuppgifter.
--   app.meal_counts        kärnan: antalet per klass och dag, personalen per
--                          sittning och om personal finns i modellen, som en
--                          jsonb. Ägarens; ingen roll har EXECUTE.
--   app.meal_counts_for_me sidans dörr: en administratör som läser Drift ber om
--                          sin egen skolas dagar. Skolan kommer ur inloggningen.
--   app.meal_letter_schools, app.meal_letter
--                          jobbets två anrop: vilka skolor som är sena nog
--                          för dagens brev, och en skolas dag med köksadressen.
--   app.meal_letter_last_for_me
--                          den senaste dagen ett brev gick, för sidan.
--
-- Funktionerna skriver ingenting och läser bara. Tabellen är den enda nya.
--
-- ## Vem läser och skriver
--
-- Genom gatewayen (app_authenticated); inget för authenticated eller anon,
-- service_role behåller sin SELECT, och MAINTAIN är ägarens (Postgres 17).
--
--   kitchen_settings_admin_select    varje administratör läser (Drift, och
--                                    huvudmannens läsare, läser varje område)
--   kitchen_settings_admin_insert / _update
--                                    de som skriver Drift: full, rektor,
--                                    schemaläggare och expedition
--
-- Ingen annan roll har en arm: en lärare, en elev och en vårdnadshavare läser
-- ingenting av detta. Ingen arm raderar; inställningen byts, den tas inte bort.
--
-- ## Brevet
--
-- Ett dagligt brev går vid brytpunkten till köksadressen, om skolan slagit på
-- det och angett en adress. Det bär bara antal och klassernas namn, aldrig en
-- elevs. Jobbet frågar app.meal_letter_schools vilka skolor som passerat
-- brytpunkten i dag (och inte längre än tre timmar: ett brev efter lunchen är
-- inget brev) och har en sittning i dag, tar skolans natt som en claim
-- (app.job_claim_nightly), och bygger brevet ur app.meal_letter. En skola utan
-- sittning den dagen får ingen claim och inget brev. Skickas det genom den
-- befintliga leveransen, som varje annat brev.
--
-- ## Beside the live API: one lock, or none
--
-- Production runs this while the API before it serves requests. The one new key
-- takes Schools in SHARE ROW EXCLUSIVE, which blocks writes to it (not reads,
-- and not the KEY SHARE a foreign-key check takes) for the length of the file;
-- the new table is empty, so the key validates nothing. A request writes
-- Schools in a transaction of its own, so the lock is taken NOWAIT in a loop:
-- a refusal tries again 50 ms later; it never waits while it holds a lock and
-- no request queues behind it. After 30 s it stops with nothing done and can be
-- rerun (prisma migrate resolve --rolled-back, then deploy).

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Schools" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Schools was not free in 30 s: nothing is changed, run the migration again (prisma migrate resolve --rolled-back 20270123090000_koket_far_portionerna_per_sittning, then deploy)';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- KitchenSettings
-- ---------------------------------------------------------------------------

CREATE TABLE "KitchenSettings" (
    "schoolId" UUID NOT NULL,
    -- Brytpunkten: skolans lokala tid på dagen. NULL = ingen, och då dras ingen
    -- frånvaro av.
    "cutoffTime" TIME(0),
    -- Dagens brev till köket. Av som förval.
    "letterEnabled" BOOLEAN NOT NULL DEFAULT false,
    -- En adress, skolans uppgift (köket, en funktionsbrevlåda). Ingen användare.
    "kitchenEmail" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KitchenSettings_pkey" PRIMARY KEY ("schoolId"),
    -- En tid på dagen: en TIME tar emot 24:00, som inte är någon.
    CONSTRAINT "KitchenSettings_the_cutoff_is_a_time_of_day" CHECK ("cutoffTime" IS NULL OR "cutoffTime" < time '24:00'),
    -- Ett brev som är på har en adress att gå till och en tid att gå vid.
    CONSTRAINT "KitchenSettings_a_letter_has_an_address_and_an_hour"
        CHECK (NOT "letterEnabled" OR ("cutoffTime" IS NOT NULL AND "kitchenEmail" IS NOT NULL)),
    -- En adress, inte en lista: ingen mellanslag, komma, semikolon eller
    -- vinkelparentes, så att den inte kan bli två mottagare eller ett huvud.
    CONSTRAINT "KitchenSettings_the_address_is_one_address"
        CHECK ("kitchenEmail" IS NULL
               OR (char_length("kitchenEmail") BETWEEN 3 AND 254
                   AND "kitchenEmail" ~ '^[^@[:space:],;<>"()]+@[^@[:space:],;<>"()]+\.[^@[:space:],;<>"()]+$'))
);

ALTER TABLE "KitchenSettings"
    ADD CONSTRAINT "KitchenSettings_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Kärnan: antalet per klass och dag.
-- ---------------------------------------------------------------------------

-- Skolans dagar p_from..p_to (båda med): en rad per klass och dag som äter, och
-- personalen per sittning. Svaret är en jsonb:
--
--   cutoff         brytpunkten "HH:MM", eller null
--   staffModelled  finns en pedagogisk lunch med fast tid som gäller i perioden
--   classes        [{day, groupId, name, start, end, pupils, absentBefore,
--                    absentAfter, underActivity}], start och slut "HH:MM" i
--                  skolans tid
--   staff          [{day, start, end, staff}], bara sittningar med personal
--
-- Läser bara. Ägarens: ingen roll har EXECUTE, de två dörrarna nedan anropar den.
-- Allt i ett uttryck, så att klasserna och personalen ser samma ögonblick.
CREATE FUNCTION app.meal_counts(p_school uuid, p_from date, p_to date)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" SET jit = off AS $$
  WITH school AS (
    SELECT s."id", s."timezone" AS tz, k."cutoffTime" AS cutoff
      FROM "Schools" s
      LEFT JOIN "KitchenSettings" k ON k."schoolId" = s."id"
     WHERE s."id" = p_school
  ),
  -- Måltiderna i det publicerade schemat: en rad per klass och dag.
  lunch AS (
    SELECT cl."date" AS day,
           cl."studentGroupId" AS group_id,
           g."name" AS group_name,
           cl."startsAt" AS starts_at,
           cl."endsAt" AS ends_at,
           (cl."startsAt" AT TIME ZONE school.tz)::time AS start_local,
           (cl."endsAt" AT TIME ZONE school.tz)::time AS end_local,
           -- D kl. brytpunkten i skolans tid, som ett ögonblick.
           CASE WHEN school.cutoff IS NULL THEN NULL
                ELSE (cl."date" + school.cutoff) AT TIME ZONE school.tz END AS cutoff_at
      FROM school
      JOIN "CalendarLunches" cl ON cl."schoolId" = school."id"
      JOIN "StudentGroups" g ON g."id" = cl."studentGroupId" AND g."schoolId" = cl."schoolId"
     WHERE cl."date" BETWEEN p_from AND p_to
  ),
  pupils AS (
    SELECT u."studentGroupId" AS group_id, count(*)::integer AS n
      FROM "Users" u
     WHERE u."schoolId" = p_school
       AND u."role" = 'STUDENT'
       AND u."isActive"
       AND u."studentGroupId" IN (SELECT l.group_id FROM lunch l)
     GROUP BY u."studentGroupId"
  ),
  -- Varje elev med en anmälan som täcker hela sittningen, och när den först
  -- anmäldes. En elev räknas en gång även med flera anmälningar.
  absent_pupils AS (
    SELECT l.day, l.group_id, ar."studentId", min(ar."createdAt") AS first_reported, l.cutoff_at
      FROM lunch l
      JOIN "Users" u ON u."schoolId" = p_school AND u."studentGroupId" = l.group_id
                    AND u."role" = 'STUDENT' AND u."isActive"
      JOIN "AbsenceReports" ar ON ar."schoolId" = p_school AND ar."studentId" = u."id"
                              AND ar."date" = l.day
                              AND coalesce(ar."startTime", time '00:00') <= l.start_local
                              AND coalesce(ar."endTime", time '24:00') >= l.end_local
     GROUP BY l.day, l.group_id, ar."studentId", l.cutoff_at
  ),
  absent AS (
    SELECT a.day, a.group_id,
           count(*) FILTER (WHERE a.cutoff_at IS NOT NULL AND a.first_reported < a.cutoff_at)::integer AS before_n,
           count(*) FILTER (WHERE a.cutoff_at IS NOT NULL AND a.first_reported >= a.cutoff_at)::integer AS after_n
      FROM absent_pupils a
     GROUP BY a.day, a.group_id
  ),
  -- Klasser med en ersättningslektion (D3) som hålls över sittningen.
  activity AS (
    SELECT DISTINCT l.day, l.group_id
      FROM lunch l
      JOIN "ScheduleActivityLessons" sal ON sal."schoolId" = p_school
                                        AND sal."studentGroupId" = l.group_id AND sal."date" = l.day
      JOIN "ScheduleActivities" a ON a."id" = sal."activityId" AND a."schoolId" = p_school AND a."removedAt" IS NULL
      JOIN "CalendarLessons" cal ON cal."id" = sal."calendarLessonId" AND cal."schoolId" = p_school
                                AND cal."status" <> 'CANCELLED'
     WHERE cal."startsAt" < l.ends_at AND cal."endsAt" > l.starts_at
  ),
  -- Sittningarna: ett fönster per dag.
  windows AS (
    SELECT DISTINCT l.day, l.starts_at, l.ends_at, l.start_local, l.end_local FROM lunch l
  ),
  -- Pedagogisk lunch med fast tid, giltig den dagen: läraren, veckodagen och tiden.
  duty_slots AS (
    SELECT d."userId", d."academicYearId", ay."startDate" AS year_from, ay."endDate" AS year_to,
           coalesce(d."validFrom", ay."startDate") AS valid_from,
           coalesce(d."validTo", ay."endDate") AS valid_to,
           c."dayOfWeek", c."startTime", c."endTime"
      FROM "TeacherDuties" d
      JOIN "AcademicYears" ay ON ay."id" = d."academicYearId" AND ay."schoolId" = d."schoolId"
      JOIN "Users" u ON u."id" = d."userId" AND u."schoolId" = d."schoolId" AND u."isActive"
      JOIN "TeacherDutySlots" ds ON ds."teacherDutyId" = d."id" AND ds."schoolId" = d."schoolId"
      JOIN "AvailabilityConstraints" c ON c."id" = ds."availabilityConstraintId" AND c."schoolId" = ds."schoolId"
     WHERE d."schoolId" = p_school
       AND d."kind" = 'PEDAGOGISK_LUNCH'
       AND c."dayOfWeek" IS NOT NULL
       AND coalesce(d."validFrom", ay."startDate") <= p_to
       AND coalesce(d."validTo", ay."endDate") >= p_from
  ),
  -- Lärarens minuter i varje sittning den dagen; läraren hör till sittningen med
  -- flest (lika: den tidigaste), en gång per dag.
  staff_overlap AS (
    SELECT w.day, w.start_local, w.end_local, ds."userId",
           sum(extract(epoch FROM least(w.end_local, ds."endTime") - greatest(w.start_local, ds."startTime")) / 60) AS minutes
      FROM windows w
      JOIN duty_slots ds ON ds."dayOfWeek" = extract(isodow FROM w.day)::integer
                        AND ds.valid_from <= w.day AND ds.valid_to >= w.day
                        AND ds.year_from <= w.day AND ds.year_to >= w.day
     WHERE least(w.end_local, ds."endTime") > greatest(w.start_local, ds."startTime")
     GROUP BY w.day, w.start_local, w.end_local, ds."userId"
  ),
  staff AS (
    SELECT p.day, p.start_local, p.end_local, count(*)::integer AS n
      FROM (SELECT DISTINCT ON (o.day, o."userId") o.day, o."userId", o.start_local, o.end_local
              FROM staff_overlap o
             ORDER BY o.day, o."userId", o.minutes DESC, o.start_local) p
     GROUP BY p.day, p.start_local, p.end_local
  )
  SELECT jsonb_build_object(
    'cutoff', (SELECT to_char(school.cutoff, 'HH24:MI') FROM school),
    'staffModelled', EXISTS (SELECT 1 FROM duty_slots),
    'classes', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'day', to_char(l.day, 'YYYY-MM-DD'),
               'groupId', l.group_id,
               'name', l.group_name,
               'start', to_char(l.start_local, 'HH24:MI'),
               'end', to_char(l.end_local, 'HH24:MI'),
               'pupils', coalesce(p.n, 0),
               'absentBefore', coalesce(a.before_n, 0),
               'absentAfter', coalesce(a.after_n, 0),
               'underActivity', act.group_id IS NOT NULL)
             ORDER BY l.day, l.start_local, l.end_local, l.group_name COLLATE "C")
        FROM lunch l
        LEFT JOIN pupils p ON p.group_id = l.group_id
        LEFT JOIN absent a ON a.day = l.day AND a.group_id = l.group_id
        LEFT JOIN activity act ON act.day = l.day AND act.group_id = l.group_id), '[]'::jsonb),
    'staff', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'day', to_char(s.day, 'YYYY-MM-DD'),
               'start', to_char(s.start_local, 'HH24:MI'),
               'end', to_char(s.end_local, 'HH24:MI'),
               'staff', s.n)
             ORDER BY s.day, s.start_local, s.end_local)
        FROM staff s), '[]'::jsonb));
$$;

-- Sidans dörr. En administratör som läser Drift (varje administratör, och
-- huvudmannens läsare) ber om sin egen skolas dagar, högst 31. Skolan kommer ur
-- inloggningen, aldrig ur anropet.
CREATE FUNCTION app.meal_counts_for_me(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" SET jit = off AS $$
BEGIN
  IF NOT app.current_user_may('DRIFT', false) THEN
    RAISE EXCEPTION 'MEAL_COUNTS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 30 THEN
    RAISE EXCEPTION 'MEAL_COUNTS_RANGE' USING ERRCODE = '22023';
  END IF;
  RETURN app.meal_counts(app.current_school_id(), p_from, p_to);
END
$$;

-- Den senaste dagen ett brev gick: den senaste claim jobbet avslutat. Bara
-- dagar med en sittning får en claim, och en claim avslutas först när brevet
-- lämnats till leveransen. Spåret finns i 35 dagar (JobClaims städas då).
CREATE FUNCTION app.meal_letter_last_for_me()
RETURNS date
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF NOT app.current_user_may('DRIFT', false) THEN
    RAISE EXCEPTION 'MEAL_COUNTS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN (SELECT max(c."day") FROM "JobClaims" c
           WHERE c."job" = 'meal-letter' AND c."schoolId" = app.current_school_id() AND c."finishedAt" IS NOT NULL);
END
$$;

-- ---------------------------------------------------------------------------
-- Jobbets två anrop.
-- ---------------------------------------------------------------------------

-- De skolor som har brevet på och vars brytpunkt passerat i dag men inte med mer
-- än p_grace_minutes, och som har en sittning i dag. Svaret är kandidaterna; vem
-- som tar kvällens körning avgör app.job_claim_nightly.
CREATE FUNCTION app.meal_letter_schools(p_at timestamptz, p_grace_minutes integer)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" SET jit = off AS $$
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
   WHERE l.now_local >= l.cutoff_local
     AND l.now_local < l.cutoff_local + make_interval(mins => greatest(p_grace_minutes, 0))
     AND EXISTS (SELECT 1 FROM "CalendarLunches" cl
                  WHERE cl."schoolId" = l.school_id AND cl."date" = l.now_local::date)
   ORDER BY l.school_id
$$;

-- Skolans namn, köksadressen och dagens tal. NULL när skolan inte längre har
-- brevet på (brytaren kan ha slagits av sedan jobbet frågade).
CREATE FUNCTION app.meal_letter(p_school uuid, p_day date)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" SET jit = off AS $$
  SELECT jsonb_build_object('school', s."name", 'email', k."kitchenEmail") || app.meal_counts(p_school, p_day, p_day)
    FROM "KitchenSettings" k
    JOIN "Schools" s ON s."id" = k."schoolId"
   WHERE k."schoolId" = p_school AND k."letterEnabled" AND k."kitchenEmail" IS NOT NULL
$$;

COMMENT ON TABLE "KitchenSettings" IS
  'Måltidskollen: skolans brytpunkt för frånvaro, om dagens brev till köket är på, och köksadressen. En rad per skola; ingen rad = ingen brytpunkt och inget brev. Inga personuppgifter.';
COMMENT ON FUNCTION app.meal_counts(uuid, date, date) IS
  'Måltidskollen: portionerna per klass och dag ur CalendarLunches, med frånvaro före och efter brytpunkten, klasser med en ersättningslektion och personalen per sittning, som en jsonb. Läser bara. Ägarens; ingen roll har EXECUTE.';
COMMENT ON FUNCTION app.meal_counts_for_me(date, date) IS
  'Måltidskollen: app.meal_counts för den inloggade administratörens egen skola (varje administratör läser Drift), högst 31 dagar.';
COMMENT ON FUNCTION app.meal_letter_last_for_me() IS
  'Måltidskollen: den senaste dagen ett brev till köket gick, ur jobbets avslutade claims (35 dagar).';
COMMENT ON FUNCTION app.meal_letter_schools(timestamptz, integer) IS
  'Måltidskollen: skolorna med brevet på vars brytpunkt passerat i dag (inom p_grace_minutes) och som har en sittning i dag.';
COMMENT ON FUNCTION app.meal_letter(uuid, date) IS
  'Måltidskollen: skolans namn, köksadressen och dagens tal (app.meal_counts), eller NULL när brevet inte är på.';

-- ---------------------------------------------------------------------------
-- Row-level security and grants. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "KitchenSettings" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r text;
  fn text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    CREATE POLICY "kitchen_settings_admin_select" ON "KitchenSettings"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "kitchen_settings_admin_insert" ON "KitchenSettings"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true)));
    CREATE POLICY "kitchen_settings_admin_update" ON "KitchenSettings"
        FOR UPDATE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true)));

    REVOKE ALL ON "KitchenSettings" FROM "app_authenticated";
    GRANT SELECT, INSERT, UPDATE ON "KitchenSettings" TO "app_authenticated";
  END IF;

  FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "KitchenSettings" FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "KitchenSettings" FROM "service_role"';
  END IF;
  -- PostgreSQL 17's MAINTAIN (REINDEX, CLUSTER, VACUUM, LOCK): the owner's alone.
  IF current_setting('server_version_num')::int >= 170000 THEN
    FOREACH r IN ARRAY ARRAY['authenticated', 'app_authenticated', 'service_role', 'anon'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE MAINTAIN ON "KitchenSettings" FROM %I', r);
      END IF;
    END LOOP;
  END IF;

  -- The functions: the gateway's role alone, and not through PostgREST. The
  -- core is the owner's; the four doors run it.
  FOREACH fn IN ARRAY ARRAY[
    'app.meal_counts(uuid, date, date)',
    'app.meal_counts_for_me(date, date)',
    'app.meal_letter_last_for_me()',
    'app.meal_letter_schools(timestamptz, integer)',
    'app.meal_letter(uuid, date)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', fn, r);
      END IF;
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    FOREACH fn IN ARRAY ARRAY[
      'app.meal_counts_for_me(date, date)',
      'app.meal_letter_last_for_me()',
      'app.meal_letter_schools(timestamptz, integer)',
      'app.meal_letter(uuid, date)'
    ] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO "app_authenticated"', fn);
    END LOOP;
  END IF;
END
$$;
