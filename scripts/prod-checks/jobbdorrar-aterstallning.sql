-- Återställning av 20270224090000_jobbens_ovriga_dorrar_svarar_inte_en_inloggning: de 38 funktionerna med de kroppar och
-- kommentarer de hade före den (main 181cfc6f, #344). Kör som en ny migrering (nästa stämpel); skriv inte om den gamla, vars
-- sha256 står i _prisma_migrations. md5(prosrc) av varje kropp efter körningen ska vara "före"-kolumnen i migreringens huvud.

CREATE OR REPLACE FUNCTION app.absence_stats_month(p_school uuid, p_month date, p_as_of date)
 RETURNS TABLE(written integer, removed integer, classes integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET jit TO 'off'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION app.absence_stats_plan(p_school uuid, p_as_of date, p_backfill integer DEFAULT 3)
 RETURNS TABLE(month date)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION app.absence_stats_trim(p_school uuid, p_as_of date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION app.absence_watch_digest(p_school uuid, p_group "AbsenceWatchGroup", p_start date, p_end date, p_on date)
 RETURNS TABLE(notification_id uuid, user_id uuid, email text, meta jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION app.absence_watch_digest_due(p_school uuid, p_today date)
 RETURNS TABLE(recipient_group "AbsenceWatchGroup", period_start date, period_end date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION app.absence_watch_evaluate(p_school uuid, p_as_of date)
 RETURNS TABLE(opened integer, kept integer, closed integer, pupils integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION app.absence_watch_schools()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT s."schoolId" FROM "AbsenceWatchSettings" s WHERE s."enabled" ORDER BY s."schoolId"
$function$;

CREATE OR REPLACE FUNCTION app.delivery_opt_outs(p_school uuid, p_users uuid[], p_type "NotificationType")
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT o."userId"
    FROM "NotificationOptOuts" o
   WHERE o."schoolId" = p_school
     AND o."userId" = ANY (p_users)
     AND o."type" = p_type
$function$;

CREATE OR REPLACE FUNCTION app.gallring_begin(p_school uuid, p_at timestamp with time zone)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_kind "RetentionDataType";
  v_months integer;
  v_periods jsonb := '{}';
  v_cutoffs jsonb := '{}';
  v_run uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Schools" s WHERE s."id" = p_school) THEN
    RAISE EXCEPTION 'GALLRING_NO_SCHOOL' USING ERRCODE = 'GL404';
  END IF;
  -- A run is tonight's: a time far from now would read another day's
  -- decisions, and a later one would step past the 24-hour wait.
  IF p_at NOT BETWEEN clock_timestamp() - interval '10 minutes' AND clock_timestamp() + interval '10 minutes' THEN
    RAISE EXCEPTION 'GALLRING_RUN_IS_NOW' USING ERRCODE = 'GL400';
  END IF;
  UPDATE "GallringRuns" SET "status" = 'INTERRUPTED', "finishedAt" = p_at
   WHERE "schoolId" = p_school AND "status" = 'RUNNING';
  FOREACH v_kind IN ARRAY enum_range(NULL::"RetentionDataType") LOOP
    v_months := app.retention_months_in_force(p_school, v_kind, p_at);
    IF v_months IS NOT NULL THEN
      v_periods := v_periods || jsonb_build_object(v_kind::text, v_months);
      v_cutoffs := v_cutoffs || jsonb_build_object(v_kind::text, app.retention_cutoff(p_school, v_months, p_at)::text);
    END IF;
  END LOOP;
  INSERT INTO "GallringRuns" ("schoolId", "localDay", "startedAt", "periods", "cutoffs")
  VALUES (p_school, app.gallring_today(p_school, p_at), p_at, v_periods, v_cutoffs)
  RETURNING "id" INTO v_run;
  RETURN v_run;
END
$function$;

CREATE OR REPLACE FUNCTION app.gallring_claim_person(p_run uuid, p_user uuid)
 RETURNS TABLE(auth_id uuid, invited boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r "GallringRuns";
  cutoff date;
  today date;
BEGIN
  SELECT * INTO r FROM "GallringRuns" WHERE "id" = p_run AND "status" = 'RUNNING' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GALLRING_RUN_NOT_RUNNING' USING ERRCODE = 'GL404';
  END IF;
  -- The lock comes first: a reactivation in flight is waited for, one that
  -- comes later waits for this transaction, and every statement below reads
  -- after the wait (read committed: a new snapshot per statement).
  PERFORM 1 FROM "Users" u WHERE u."id" = p_user AND u."schoolId" = r."schoolId" FOR NO KEY UPDATE;
  IF NOT FOUND
     OR r."cutoffs" ->> 'DEPARTED_PEOPLE' IS NULL
     OR app.retention_months_in_force(r."schoolId", 'DEPARTED_PEOPLE', clock_timestamp()) IS NULL THEN
    RETURN;
  END IF;
  -- In variables, as in the run's other functions, so app.gallring_due is
  -- inlined and looks the one person up by id.
  cutoff := app.gallring_run_cutoff(r."schoolId", r."startedAt", r."cutoffs", 'DEPARTED_PEOPLE');
  today := app.gallring_today(r."schoolId", r."startedAt");
  RETURN QUERY
  SELECT u."authId",
         u."invitedAt" IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM "Users" o WHERE o."authId" = u."authId" AND o."id" <> u."id")
         AND NOT EXISTS (SELECT 1 FROM "HuvudmanMembers" hm WHERE hm."authId" = u."authId")
    FROM app.gallring_due(r."schoolId", 'DEPARTED_PEOPLE', cutoff, today) d
    JOIN "Users" u ON u."id" = d."id"
   WHERE d."id" = p_user;
END
$function$;

CREATE OR REPLACE FUNCTION app.gallring_departed_due(p_run uuid, p_limit integer)
 RETURNS TABLE(user_id uuid, auth_id uuid, invited boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r "GallringRuns";
  cutoff date;
  today date;
BEGIN
  SELECT * INTO r FROM "GallringRuns" WHERE "id" = p_run AND "status" = 'RUNNING' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GALLRING_RUN_NOT_RUNNING' USING ERRCODE = 'GL404';
  END IF;
  IF r."cutoffs" ->> 'DEPARTED_PEOPLE' IS NULL
     OR app.retention_months_in_force(r."schoolId", 'DEPARTED_PEOPLE', clock_timestamp()) IS NULL THEN
    RETURN;
  END IF;
  cutoff := app.gallring_run_cutoff(r."schoolId", r."startedAt", r."cutoffs", 'DEPARTED_PEOPLE');
  today := app.gallring_today(r."schoolId", r."startedAt");
  UPDATE "GallringRuns" SET
    "waiting" = "waiting" || jsonb_build_object('DEPARTED_PEOPLE_SCB', app.gallring_held(r."schoolId", cutoff, today))
   WHERE "id" = p_run;
  RETURN QUERY
  SELECT u."id", u."authId", u."invitedAt" IS NOT NULL
    FROM app.gallring_due(r."schoolId", 'DEPARTED_PEOPLE', cutoff, today) d
    JOIN "Users" u ON u."id" = d."id"
   ORDER BY u."deactivatedAt", u."id"
   LIMIT greatest(least(p_limit, 500), 0);
END
$function$;

CREATE OR REPLACE FUNCTION app.gallring_finish(p_run uuid, p_waiting jsonb, p_at timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r "GallringRuns";
  left_people bigint;
BEGIN
  SELECT * INTO r FROM "GallringRuns" WHERE "id" = p_run AND "status" = 'RUNNING' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GALLRING_RUN_NOT_RUNNING' USING ERRCODE = 'GL404';
  END IF;
  -- People: complete when nobody past the cutoff is left but those held.
  IF r."cutoffs" ? 'DEPARTED_PEOPLE' THEN
    SELECT count(*) INTO left_people
      FROM app.gallring_due(r."schoolId", 'DEPARTED_PEOPLE', (r."cutoffs" ->> 'DEPARTED_PEOPLE')::date,
                            app.gallring_today(r."schoolId", r."startedAt"));
    r."complete" := r."complete" || jsonb_build_object('DEPARTED_PEOPLE', left_people = 0);
  END IF;
  UPDATE "GallringRuns" SET
    "status" = 'DONE', "finishedAt" = p_at,
    "complete" = r."complete",
    "waiting" = "waiting" || COALESCE(p_waiting, '{}'::jsonb)
   WHERE "id" = p_run;
END
$function$;

CREATE OR REPLACE FUNCTION app.gallring_pseudonymise(p_run uuid, p_users uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r "GallringRuns";
  cutoff date;
  today date;
  due uuid[];
  n integer;
BEGIN
  SELECT * INTO r FROM "GallringRuns" WHERE "id" = p_run AND "status" = 'RUNNING' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GALLRING_RUN_NOT_RUNNING' USING ERRCODE = 'GL404';
  END IF;
  -- The rows before the question: a reactivation in flight is waited for,
  -- one that comes later waits for this transaction, and every statement
  -- below reads after the wait. Id order, so two callers cannot deadlock.
  PERFORM 1 FROM "Users" u
   WHERE u."schoolId" = r."schoolId" AND u."id" = ANY (p_users)
   ORDER BY u."id"
     FOR NO KEY UPDATE;
  IF r."cutoffs" ->> 'DEPARTED_PEOPLE' IS NULL
     OR app.retention_months_in_force(r."schoolId", 'DEPARTED_PEOPLE', clock_timestamp()) IS NULL THEN
    RETURN 0;
  END IF;
  cutoff := app.gallring_run_cutoff(r."schoolId", r."startedAt", r."cutoffs", 'DEPARTED_PEOPLE');
  today := app.gallring_today(r."schoolId", r."startedAt");
  -- Asked again: somebody reactivated since the list was read is not due.
  due := ARRAY(
    SELECT d."id" FROM app.gallring_due(r."schoolId", 'DEPARTED_PEOPLE', cutoff, today) d
     WHERE d."id" = ANY (p_users)
     ORDER BY d."id"
     LIMIT 500);

  PERFORM set_config('app.gallring', r."schoolId"::text, true);
  UPDATE "Users" u SET
      "firstName"       = 'Pseudonym',
      "lastName"        = upper(left(replace(u."id"::text, '-', ''), 6)),
      "email"           = 'pseudonym-' || u."id"::text || '@pseudonym.invalid',
      "phone"           = NULL,
      "ss12000Id"       = NULL,
      "authId"          = gen_random_uuid(),
      "invitedAt"       = NULL,
      "pseudonymisedAt" = now(),
      "updatedAt"       = now()
   WHERE u."schoolId" = r."schoolId" AND u."id" = ANY (due);
  GET DIAGNOSTICS n = ROW_COUNT;
  -- Löne-id (20270206090000): the payroll system's number, as the signature.
  UPDATE "TeacherEmployments" SET "signature" = NULL, "note" = NULL, "payrollNumber" = NULL
   WHERE "schoolId" = r."schoolId" AND "userId" = ANY (due)
     AND ("signature" IS NOT NULL OR "note" IS NOT NULL OR "payrollNumber" IS NOT NULL);
  -- Löne-id (20270206091000): the versions of a pseudonym's posts lose the number too (the log's guard
  -- lets gallring make this one change).
  UPDATE "TeacherEmploymentLogs" SET
      "before" = CASE WHEN "before" ? 'payrollNumber' THEN jsonb_set("before", '{payrollNumber}', 'null'::jsonb) ELSE "before" END,
      "after"  = CASE WHEN "after" ? 'payrollNumber' THEN jsonb_set("after", '{payrollNumber}', 'null'::jsonb) ELSE "after" END
   WHERE "schoolId" = r."schoolId" AND "userId" = ANY (due) AND "entity" = 'EMPLOYMENT'
     AND (coalesce("before" -> 'payrollNumber', 'null'::jsonb) <> 'null'::jsonb
          OR coalesce("after" -> 'payrollNumber', 'null'::jsonb) <> 'null'::jsonb);
  -- Rastvaktsschema (20261207090000): a pass's note, as the tjänst's.
  UPDATE "SupervisionShifts" SET "note" = NULL, "updatedAt" = now()
   WHERE "schoolId" = r."schoolId" AND "userId" = ANY (due) AND "note" IS NOT NULL;
  DELETE FROM "GuardianStudents"
   WHERE "schoolId" = r."schoolId" AND ("guardianId" = ANY (due) OR "studentId" = ANY (due));
  DELETE FROM "PushTickets" p USING "DevicePushTokens" t
   WHERE p."tokenId" = t."id" AND p."schoolId" = t."schoolId"
     AND t."schoolId" = r."schoolId" AND t."userId" = ANY (due);
  DELETE FROM "DevicePushTokens" WHERE "schoolId" = r."schoolId" AND "userId" = ANY (due);
  DELETE FROM "NotificationOptOuts" WHERE "schoolId" = r."schoolId" AND "userId" = ANY (due);
  DELETE FROM "Notifications" WHERE "schoolId" = r."schoolId" AND "userId" = ANY (due);
  -- skyddad identitet (20270107090000): a pseudonym's mark.
  DELETE FROM "PersonProtections" WHERE "schoolId" = r."schoolId" AND "userId" = ANY (due);
  PERFORM set_config('app.gallring', '', true);

  UPDATE "GallringRuns" SET
    "counts" = "counts" || jsonb_build_object('DEPARTED_PEOPLE', COALESCE(("counts" ->> 'DEPARTED_PEOPLE')::bigint, 0) + n),
    "cutoffs" = "cutoffs" || jsonb_build_object('DEPARTED_PEOPLE', cutoff::text)
   WHERE "id" = p_run;
  RETURN n;
END
$function$;

CREATE OR REPLACE FUNCTION app.gallring_purge(p_run uuid, p_type "RetentionDataType", p_limit integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    -- checklistor: the proofs and the answers of a pupil who has left, then the lists that are left empty
    WHEN 'CHECKLISTS' THEN
      DELETE FROM "InstructionProofs" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'InstructionProofs' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n < budget THEN
        DELETE FROM "ConsentEntries" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'ConsentEntries' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
      IF n < budget THEN
        DELETE FROM "ConsentLists" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'ConsentLists' LIMIT budget - n);
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
    -- extern bokning: a series goes with its days, by the key
    WHEN 'EXTERNAL_BOOKINGS' THEN
      DELETE FROM "ExternalBookings" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'ExternalBookings' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
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
$function$;

CREATE OR REPLACE FUNCTION app.gallring_schools()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT DISTINCT latest."schoolId"
    FROM (SELECT DISTINCT ON (d."schoolId", d."dataType") d."schoolId", d."decision"
            FROM "RetentionDecisions" d
           ORDER BY d."schoolId", d."dataType", d."decidedAt" DESC, d."id" DESC) latest
   WHERE latest."decision" = 'PURGE_AFTER';
$function$;

CREATE OR REPLACE FUNCTION app.job_claim_finished(p_job text, p_school uuid, p_day date, p_at timestamp with time zone)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  UPDATE "JobClaims" SET "finishedAt" = p_at
   WHERE "job" = p_job AND "schoolId" = p_school AND "day" = p_day AND "finishedAt" IS NULL;
$function$;

CREATE OR REPLACE FUNCTION app.job_claim_nightly(p_job text, p_hour integer, p_schools uuid[], p_limit integer, p_at timestamp with time zone)
 RETURNS TABLE(school_id uuid, local_day date)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  DELETE FROM "JobClaims" WHERE "claimedAt" < p_at - interval '35 days';
  RETURN QUERY
  WITH due AS (
    SELECT s."id", (p_at AT TIME ZONE s."timezone")::date AS d
      FROM "Schools" s
     WHERE s."id" = ANY (p_schools)
       AND extract(hour FROM p_at AT TIME ZONE s."timezone") >= p_hour
       AND NOT EXISTS (
             SELECT 1 FROM "JobClaims" c
              WHERE c."job" = p_job AND c."schoolId" = s."id"
                AND c."day" = (p_at AT TIME ZONE s."timezone")::date
                AND (c."finishedAt" IS NOT NULL OR c."claimedAt" > p_at - interval '2 hours'))
     ORDER BY s."id"
     LIMIT greatest(least(p_limit, 50), 0)
  )
  INSERT INTO "JobClaims" AS c ("job", "schoolId", "day", "claimedAt")
  SELECT p_job, due."id", due.d, p_at FROM due
  ON CONFLICT ("job", "schoolId", "day") DO UPDATE SET "claimedAt" = EXCLUDED."claimedAt"
     WHERE c."finishedAt" IS NULL AND c."claimedAt" <= p_at - interval '2 hours'
  RETURNING c."schoolId", c."day";
END
$function$;

CREATE OR REPLACE FUNCTION app.job_run_settled(p_job text, p_started timestamp with time zone, p_finished timestamp with time zone, p_ok boolean, p_error text, p_counts jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  d date := (p_finished AT TIME ZONE 'UTC')::date;
BEGIN
  DELETE FROM "JobRuns" WHERE "day" < d - 90;
  INSERT INTO "JobRuns" AS r ("job", "day", "runs", "failures", "counts",
                              "lastStartedAt", "lastFinishedAt", "lastFailedAt", "lastError")
  VALUES (p_job, d, 1, CASE WHEN p_ok THEN 0 ELSE 1 END, COALESCE(p_counts, '{}'::jsonb),
          p_started, p_finished, CASE WHEN p_ok THEN NULL ELSE p_finished END,
          CASE WHEN p_ok THEN NULL ELSE p_error END)
  ON CONFLICT ("job", "day") DO UPDATE SET
    "runs"           = r."runs" + 1,
    "failures"       = r."failures" + CASE WHEN p_ok THEN 0 ELSE 1 END,
    -- Key by key: a key either side lacks counts as 0.
    "counts"         = (SELECT COALESCE(jsonb_object_agg(k, COALESCE((r."counts" ->> k)::bigint, 0)
                                                           + COALESCE((EXCLUDED."counts" ->> k)::bigint, 0)), '{}'::jsonb)
                          FROM (SELECT jsonb_object_keys(r."counts") UNION SELECT jsonb_object_keys(EXCLUDED."counts")) AS keys(k)),
    "lastStartedAt"  = greatest(r."lastStartedAt", EXCLUDED."lastStartedAt"),
    "lastFinishedAt" = greatest(r."lastFinishedAt", EXCLUDED."lastFinishedAt"),
    "lastFailedAt"   = COALESCE(EXCLUDED."lastFailedAt", r."lastFailedAt"),
    "lastError"      = CASE WHEN p_ok THEN r."lastError" ELSE EXCLUDED."lastError" END;
END
$function$;

CREATE OR REPLACE FUNCTION app.job_runs_latest()
 RETURNS TABLE(job text, last_finished timestamp with time zone, last_failed timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT DISTINCT ON (r."job") r."job", r."lastFinishedAt", r."lastFailedAt"
    FROM "JobRuns" r
   ORDER BY r."job", r."day" DESC;
$function$;

CREATE OR REPLACE FUNCTION app.login_is_held_elsewhere(p_auth_id uuid, p_user uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (SELECT 1 FROM "Users" WHERE "authId" = p_auth_id AND "id" IS DISTINCT FROM p_user)
      OR EXISTS (SELECT 1 FROM "HuvudmanMembers" WHERE "authId" = p_auth_id)
$function$;

CREATE OR REPLACE FUNCTION app.push_due_receipts(p_limit integer)
 RETURNS TABLE(ticket_id text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  DELETE FROM "PushTickets" WHERE "createdAt" < now() - interval '24 hours';
  DELETE FROM "DevicePushTokens" WHERE "revokedAt" < now() - interval '30 days';
  DELETE FROM "DevicePushTokens" WHERE "lastSeenAt" < now() - interval '180 days';
  RETURN QUERY
  WITH due AS (
    SELECT p."id" FROM "PushTickets" p
     WHERE p."createdAt" <= now() - interval '15 minutes'
       AND (p."claimedAt" IS NULL OR p."claimedAt" < now() - interval '1 hour')
     ORDER BY p."createdAt"
     LIMIT greatest(least(p_limit, 1000), 0)
       FOR UPDATE SKIP LOCKED
  )
  UPDATE "PushTickets" p SET "claimedAt" = now() FROM due WHERE p."id" = due."id"
  RETURNING p."id";
END
$function$;

CREATE OR REPLACE FUNCTION app.push_receipts_settled(p_checked text[], p_dead text[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE "DevicePushTokens" t
     SET "revokedAt" = now(), "revokedReason" = 'DEVICE_NOT_REGISTERED'
    FROM "PushTickets" p
   WHERE p."id" = ANY (p_dead) AND p."tokenId" = t."id" AND p."schoolId" = t."schoolId" AND t."revokedAt" IS NULL;
  DELETE FROM "PushTickets" WHERE "id" = ANY (p_checked) OR "id" = ANY (p_dead);
END
$function$;

CREATE OR REPLACE FUNCTION app.push_settle(p_school uuid, p_dead uuid[], p_tickets jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE "DevicePushTokens"
     SET "revokedAt" = now(), "revokedReason" = 'DEVICE_NOT_REGISTERED'
   WHERE "schoolId" = p_school AND "id" = ANY (p_dead) AND "revokedAt" IS NULL;
  INSERT INTO "PushTickets" ("id", "schoolId", "tokenId")
  SELECT x."id", p_school, x."tokenId"
    FROM jsonb_to_recordset(coalesce(p_tickets, '[]'::jsonb)) AS x("id" text, "tokenId" uuid)
    JOIN "DevicePushTokens" t ON t."id" = x."tokenId" AND t."schoolId" = p_school
  ON CONFLICT ("id") DO NOTHING;
END
$function$;

CREATE OR REPLACE FUNCTION app.push_targets(p_school uuid, p_users uuid[], p_type "NotificationType", p_required boolean)
 RETURNS TABLE(token_id uuid, user_id uuid, token text, locale text, timezone text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT t."id", t."userId", t."token", t."locale", coalesce(s."timezone", 'Europe/Stockholm')
    FROM "DevicePushTokens" t
    JOIN "Users" u ON u."id" = t."userId" AND u."schoolId" = t."schoolId" AND u."isActive"
    JOIN "Schools" s ON s."id" = t."schoolId"
   WHERE t."schoolId" = p_school
     AND t."userId" = ANY (p_users)
     AND t."revokedAt" IS NULL
     AND p_type <> 'TEACHER_ABSENCE_REPORTED'
     AND (p_required OR NOT EXISTS (
           SELECT 1 FROM "NotificationOptOuts" o
            WHERE o."userId" = t."userId" AND o."schoolId" = t."schoolId" AND o."type" = p_type))
   ORDER BY t."userId", t."id"
$function$;

CREATE OR REPLACE FUNCTION app.reporting_compute(p_school uuid, p_as_of date)
 RETURNS TABLE(written integer, removed integer, teachers integer, held integer, reported integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION app.reporting_digest(p_school uuid, p_start date, p_end date)
 RETURNS TABLE(notification_id uuid, user_id uuid, email text, meta jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION app.reporting_digest_due(p_school uuid, p_today date)
 RETURNS TABLE(period_start date, period_end date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT e.end_day - 6, e.end_day
    FROM "ReportingSettings" s
   CROSS JOIN LATERAL (SELECT p_today - extract(isodow FROM p_today)::integer AS end_day) AS e
   WHERE s."schoolId" = p_school AND s."rektorDigest" AND s."rektorDigestOn" IS NOT NULL
     AND e.end_day >= s."rektorDigestOn"
     AND NOT EXISTS (SELECT 1 FROM "ReportingDigests" d
                      WHERE d."schoolId" = p_school AND d."periodEnd" = e.end_day)
$function$;

CREATE OR REPLACE FUNCTION app.reporting_remind(p_school uuid, p_today date)
 RETURNS TABLE(notification_id uuid, user_id uuid, email text, meta jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION app.reporting_schools()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT s."id" FROM "Schools" s
   WHERE EXISTS (SELECT 1 FROM "CalendarLessons" cl
                  WHERE cl."schoolId" = s."id"
                    AND cl."date" >= (clock_timestamp() AT TIME ZONE s."timezone")::date - 90)
   ORDER BY s."id"
$function$;

CREATE OR REPLACE FUNCTION app.schedule_candidates_sweep()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  abandoned integer;
  removed integer;
BEGIN
  -- A run's task bumps heartbeatAt before every candidate; its lease is twice
  -- the longest call it makes. Past that, or half an hour after it began, the
  -- instance that ran it is gone, and the run holds the year's one active
  -- place until it is marked.
  WITH stale AS (
    SELECT "id" FROM "ScheduleCandidateRuns"
     WHERE "status" IN ('PENDING', 'RUNNING', 'CANCELLING')
       AND ("heartbeatAt" + make_interval(secs => "leaseSeconds") < now()
            OR "createdAt" < now() - interval '30 minutes')
     FOR UPDATE SKIP LOCKED
  )
  UPDATE "ScheduleCandidateRuns" r
     SET "status" = 'FAILED',
         "error" = 'The run stopped before it finished.',
         "errorCode" = 'CANDIDATE_RUN_ABANDONED',
         "errorParams" = NULL,
         "finishedAt" = now()
    FROM stale
   WHERE r."id" = stale."id";
  GET DIAGNOSTICS abandoned = ROW_COUNT;

  -- Older than seven days, or removed by a discard or a newer batch while
  -- its engine call could still be solving and that call's time now past.
  WITH old AS (
    SELECT "id" FROM "ScheduleCandidateRuns"
     WHERE "createdAt" < now() - interval '7 days'
        OR ("discardedAt" IS NOT NULL AND ("engineBusyUntil" IS NULL OR "engineBusyUntil" <= now()))
     FOR UPDATE SKIP LOCKED
  )
  DELETE FROM "ScheduleCandidateRuns" r
   USING old
   WHERE r."id" = old."id";
  GET DIAGNOSTICS removed = ROW_COUNT;

  RETURN abandoned + removed;
END
$function$;

CREATE OR REPLACE FUNCTION app.school_export_claim(p_lease interval)
 RETURNS TABLE(export_id uuid, school_id uuid, user_id uuid, auth_id uuid, admin_profile "AdminProfile", hr_read boolean, attempt integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  picked  "SchoolExports"%ROWTYPE;
  login   uuid;
  profile "AdminProfile";
  hr      boolean;
BEGIN
  IF p_lease IS NULL OR p_lease < interval '10 seconds' OR p_lease > interval '1 hour' THEN
    RAISE EXCEPTION 'school_export_claim: the lease is between 10 seconds and 1 hour' USING ERRCODE = 'SS409';
  END IF;
  LOOP
    SELECT e.* INTO picked
      FROM "SchoolExports" e
     WHERE e."status" = 'QUEUED'
        OR (e."status" = 'RUNNING' AND e."heartbeatAt" < clock_timestamp() - p_lease)
     ORDER BY e."requestedAt", e."id"
     LIMIT 1
       FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      RETURN;
    END IF;

    SELECT u."authId", u."adminProfile", u."hrRead" INTO login, profile, hr
      FROM "Users" u
     WHERE u."id" = picked."requestedById" AND u."schoolId" = picked."schoolId"
       AND u."isActive" AND u."role" = 'SCHOOL_ADMIN' AND app.admin_profile_decides(u."adminProfile");

    IF login IS NULL OR picked."attempts" >= 3 THEN
      DELETE FROM "SchoolExportChunks" WHERE "exportId" = picked."id";
      UPDATE "SchoolExports"
         SET "status" = 'FAILED', "finishedAt" = clock_timestamp(),
             "errorClass" = CASE WHEN login IS NULL THEN 'RequesterGone' ELSE 'TooManyAttempts' END
       WHERE "id" = picked."id";
      CONTINUE;
    END IF;

    DELETE FROM "SchoolExportChunks" WHERE "exportId" = picked."id";
    UPDATE "SchoolExports"
       SET "status" = 'RUNNING',
           "startedAt" = clock_timestamp(),
           "heartbeatAt" = clock_timestamp(),
           "attempts" = "attempts" + 1
     WHERE "id" = picked."id";
    RETURN QUERY SELECT picked."id", picked."schoolId", picked."requestedById", login, profile, hr, picked."attempts" + 1;
    RETURN;
  END LOOP;
END
$function$;

CREATE OR REPLACE FUNCTION app.school_export_expire(p_ledger interval)
 RETURNS TABLE(expired integer, purged integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  n_expired integer;
  n_purged  integer;
BEGIN
  IF p_ledger IS NULL OR p_ledger < interval '30 days' THEN
    RAISE EXCEPTION 'school_export_expire: the ledger is kept for at least 30 days' USING ERRCODE = 'SS409';
  END IF;
  DELETE FROM "SchoolExportChunks" c
   USING "SchoolExports" e
   WHERE e."id" = c."exportId" AND e."status" = 'READY' AND e."expiresAt" <= clock_timestamp();
  WITH gone AS (
    UPDATE "SchoolExports" SET "status" = 'EXPIRED', "readAbout" = NULL
     WHERE "status" = 'READY' AND "expiresAt" <= clock_timestamp()
    RETURNING 1)
  SELECT count(*)::integer INTO n_expired FROM gone;
  WITH gone AS (
    DELETE FROM "SchoolExports"
     WHERE "status" IN ('EXPIRED', 'FAILED') AND "finishedAt" < clock_timestamp() - p_ledger
    RETURNING 1)
  SELECT count(*)::integer INTO n_purged FROM gone;
  RETURN QUERY SELECT n_expired, n_purged;
END
$function$;

CREATE OR REPLACE FUNCTION app.school_export_fail(p_id uuid, p_error text, p_attempt integer DEFAULT NULL::integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE "SchoolExports"
     SET "status" = 'FAILED', "finishedAt" = clock_timestamp(),
         "errorClass" = CASE WHEN p_error ~ '^[A-Za-z][A-Za-z0-9_]{0,79}$' THEN p_error ELSE 'Error' END
   WHERE "id" = p_id AND "status" = 'RUNNING' AND (p_attempt IS NULL OR "attempts" = p_attempt);
  IF FOUND THEN
    DELETE FROM "SchoolExportChunks" WHERE "exportId" = p_id;
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION app.school_export_finish(p_id uuid, p_bytes bigint, p_chunks integer, p_sha256 text, p_files jsonb, p_held_out jsonb, p_read_about jsonb, p_keep interval, p_attempt integer DEFAULT NULL::integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  have_chunks integer;
  have_bytes  bigint;
BEGIN
  IF p_keep IS NULL OR p_keep <= interval '0' OR p_keep > interval '14 days' THEN
    RAISE EXCEPTION 'school_export_finish: a file is kept for between nothing and 14 days' USING ERRCODE = 'SS409';
  END IF;
  SELECT count(*)::integer, coalesce(sum(octet_length(c."bytes")), 0)
    INTO have_chunks, have_bytes
    FROM "SchoolExportChunks" c WHERE c."exportId" = p_id;
  IF have_chunks <> p_chunks OR have_bytes <> p_bytes THEN
    RAISE EXCEPTION 'SCHOOL_EXPORT_FILE_INCOMPLETE: % pieces and % bytes stored, % and % said', have_chunks, have_bytes, p_chunks, p_bytes
      USING ERRCODE = 'SS409';
  END IF;
  UPDATE "SchoolExports"
     SET "status" = 'READY', "finishedAt" = clock_timestamp(),
         "expiresAt" = clock_timestamp() + p_keep,
         "byteSize" = p_bytes, "chunkCount" = p_chunks, "sha256" = p_sha256,
         "files" = p_files, "heldOut" = p_held_out, "readAbout" = p_read_about
   WHERE "id" = p_id AND "status" = 'RUNNING' AND (p_attempt IS NULL OR "attempts" = p_attempt);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SCHOOL_EXPORT_NOT_RUNNING: the export is not being built' USING ERRCODE = 'SS409';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION app.school_export_heartbeat(p_id uuid, p_attempt integer DEFAULT NULL::integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE "SchoolExports" SET "heartbeatAt" = clock_timestamp()
   WHERE "id" = p_id AND "status" = 'RUNNING' AND (p_attempt IS NULL OR "attempts" = p_attempt);
  RETURN FOUND;
END
$function$;

CREATE OR REPLACE FUNCTION app.school_export_put(p_id uuid, p_seq integer, p_bytes bytea, p_attempt integer DEFAULT NULL::integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO "SchoolExportChunks" ("exportId", "seq", "schoolId", "bytes")
  SELECT e."id", p_seq, e."schoolId", p_bytes
    FROM "SchoolExports" e
   WHERE e."id" = p_id AND e."status" = 'RUNNING' AND (p_attempt IS NULL OR e."attempts" = p_attempt);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SCHOOL_EXPORT_NOT_RUNNING: the export is not being built' USING ERRCODE = 'SS409';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION app.ss12000_due_sources(p_limit integer, p_now timestamp with time zone DEFAULT now())
 RETURNS TABLE(source_id uuid, school_id uuid, full_due boolean, local_date date)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT s."id", (p_now AT TIME ZONE coalesce(sc."timezone", 'Europe/Stockholm'))::date AS today
      FROM "Ss12000Sources" s
      JOIN "Schools" sc ON sc."id" = s."schoolId"
     WHERE s."enabled" AND s."scheduleEnabled"
       AND cardinality(s."organisationIds") > 0
       AND extract(hour FROM (p_now AT TIME ZONE coalesce(sc."timezone", 'Europe/Stockholm'))) >= s."scheduleHourLocal"
       AND (s."lastScheduledLocalDate" IS NULL
            OR s."lastScheduledLocalDate" < (p_now AT TIME ZONE coalesce(sc."timezone", 'Europe/Stockholm'))::date)
     ORDER BY s."lastScheduledLocalDate" NULLS FIRST, s."id"
     LIMIT greatest(least(p_limit, 50), 0)
       FOR UPDATE OF s SKIP LOCKED
  )
  UPDATE "Ss12000Sources" s
     SET "schedulerClaimedAt" = p_now, "lastScheduledLocalDate" = due.today
    FROM due
   WHERE s."id" = due."id"
  RETURNING s."id", s."schoolId",
            (s."lastFullAt" IS NULL OR s."modifiedCursor" IS NULL OR s."incrementalUnsupported"
             OR s."lastFullAt" < p_now - make_interval(days => s."fullEveryDays")),
            due.today;
END
$function$;

CREATE OR REPLACE FUNCTION app.ss12000_housekeeping(p_now timestamp with time zone DEFAULT now())
 RETURNS TABLE(stale integer, expired integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  n_stale integer;
  n_expired integer;
BEGIN
  UPDATE "Ss12000SyncRuns"
     SET "status" = 'FETCH_FAILED', "statusCode" = 'STALE', "finishedAt" = p_now
   WHERE "status" = 'RUNNING' AND "startedAt" < p_now - interval '15 minutes';
  GET DIAGNOSTICS n_stale = ROW_COUNT;
  UPDATE "Ss12000SyncRuns"
     SET "status" = 'DISCARDED', "statusCode" = 'EXPIRED', "finishedAt" = p_now
   WHERE "status" = 'DIFF_READY' AND coalesce("fetchedAt", "startedAt") < p_now - interval '30 days';
  GET DIAGNOSTICS n_expired = ROW_COUNT;
  RETURN QUERY SELECT n_stale, n_expired;
END
$function$;

COMMENT ON FUNCTION app.absence_stats_month(uuid, date, date) IS
  'Frånvarostatistik: räknar om en månad för skolan och varje klass med minst fem elever (klassen vid lektionens dag, lektionerna ur app.absence_stats_lessons), och tar bort rader månaden inte längre har skäl till.';
COMMENT ON FUNCTION app.absence_stats_plan(uuid, date, integer) IS
  'Frånvarostatistik: månaderna jobbet räknar denna natt, i skolans datum: de senaste 62 dagarna och högst p_backfill äldre som saknar en rad, har en hållen lektion och minst fem elever på klasslistorna, bara de vars markeringar kan finnas kvar.';
COMMENT ON FUNCTION app.absence_stats_trim(uuid, date) IS
  'Frånvarostatistik: tar bort månader före de tre senaste läsårens början.';
COMMENT ON FUNCTION app.absence_watch_digest(uuid, "AbsenceWatchGroup", date, date, date) IS
  'Frånvarobevakning: writes a group''s digest once per period, with a read-log row for each recipient, and answers the notices with the addresses, for the delivery after the commit.';
COMMENT ON FUNCTION app.absence_watch_digest_due(uuid, date) IS
  'Frånvarobevakning: the groups whose last completed week or month has no digest yet.';
COMMENT ON FUNCTION app.absence_watch_evaluate(uuid, date) IS
  'Frånvarobevakning: who is over which limit as of the end of p_as_of (a day that has passed, in the school''s dates); opens, refreshes and closes findings; answers how many.';
COMMENT ON FUNCTION app.absence_watch_schools() IS
  '';
COMMENT ON FUNCTION app.delivery_opt_outs(uuid, uuid[], "NotificationType") IS
  'Which of p_users in p_school opted out of e-mail and push for p_type. The API''s delivery alone calls it, after the commit.';
COMMENT ON FUNCTION app.gallring_begin(uuid, timestamp with time zone) IS
  'Opens the night''s gallring run of a school with the periods in force and their cutoffs; an unfinished earlier run is INTERRUPTED.';
COMMENT ON FUNCTION app.gallring_claim_person(uuid, uuid) IS
  'For the nightly job, right before a departed person''s login is deleted: locks their Users row and answers their authId and whether they have a login of their own to delete (invited, and held by no other row: a login another school''s row holds stays, 20261204090000, and so does one a huvudman''s membership holds, 20261212090000), only while they are still due under the period in force now; no row otherwise.';
COMMENT ON FUNCTION app.gallring_departed_due(uuid, integer) IS
  'The departed people a run may pseudonymise, oldest departure first; each is claimed (app.gallring_claim_person) before their login is deleted. Counts those held for SCB.';
COMMENT ON FUNCTION app.gallring_finish(uuid, jsonb, timestamp with time zone) IS
  '';
COMMENT ON FUNCTION app.gallring_pseudonymise(uuid, uuid[]) IS
  'Locks the rows of p_users in the run''s school, then pseudonymises those still due: name, e-mail, phone, SS12000 id and login replaced; their tjänster''s signature, note and payroll number, the payroll number in those tjänster''s versions, and their rastvaktspass'' notes, cleared; their guardian links, push devices, notification opt-outs, all their own notices (whatever NOTIFICATIONS says) and their mark of a protected identity removed. Returns how many it pseudonymised.';
COMMENT ON FUNCTION app.gallring_purge(uuid, "RetentionDataType", integer) IS
  'Purges at most p_limit rows of one kind for a run and counts them on it; never more than the period in force now allows.';
COMMENT ON FUNCTION app.gallring_schools() IS
  '';
COMMENT ON FUNCTION app.job_claim_finished(text, uuid, date, timestamp with time zone) IS
  'Marks a school''s nightly claim finished, so it is not taken again that day.';
COMMENT ON FUNCTION app.job_claim_nightly(text, integer, uuid[], integer, timestamp with time zone) IS
  'Claims the nightly job for those of p_schools at or past p_hour local time with no claim that local day; returns the claims this call made.';
COMMENT ON FUNCTION app.job_run_settled(text, timestamp with time zone, timestamp with time zone, boolean, text, jsonb) IS
  'Counts one tick of a job in its row for the UTC day: runs, failures and the pass''s counts, summed key by key.';
COMMENT ON FUNCTION app.job_runs_latest() IS
  'The newest JobRuns row of each job: when it last finished and last failed.';
COMMENT ON FUNCTION app.login_is_held_elsewhere(uuid, uuid) IS
  'Flera skolor (20261204090000): whether a Users row other than p_user, or (Huvudman, 20261212090000) a huvudman''s membership, holds the login p_auth_id. A shared login is the person''s: no one school deletes or moves it.';
COMMENT ON FUNCTION app.push_due_receipts(integer) IS
  'Housekeeping, then claims up to p_limit tickets due for a receipt check (SKIP LOCKED).';
COMMENT ON FUNCTION app.push_receipts_settled(text[], text[]) IS
  'Revokes the tokens of DeviceNotRegistered receipts and deletes the checked tickets.';
COMMENT ON FUNCTION app.push_settle(uuid, uuid[], jsonb) IS
  'Revokes tokens Expo refused and stores ok tickets, for tokens of p_school only.';
COMMENT ON FUNCTION app.push_targets(uuid, uuid[], "NotificationType", boolean) IS
  'Live push tokens of active users of p_school among p_users, minus opt-outs unless p_required; never for TEACHER_ABSENCE_REPORTED.';
COMMENT ON FUNCTION app.reporting_compute(uuid, date) IS
  'Rapporteringsgrad: the school''s last 90 days up to p_as_of (a day that has passed), one row per teacher and day with a held lesson; rewrites what changed, removes what lost its lessons; from the cutoff of the shortest period the school has ever chosen to purge attendance after, when it has. Answers what it wrote.';
COMMENT ON FUNCTION app.reporting_digest(uuid, date, date) IS
  'Rapporteringsgrad: writes the week''s notice once, for a whole week (Monday to Sunday) that is over, to the active rektor and full administrators, with the school''s totals and never a name; answers the notices with the addresses.';
COMMENT ON FUNCTION app.reporting_digest_due(uuid, date) IS
  'Rapporteringsgrad: the last completed week, if the school has the weekly notice on and it has no entry yet.';
COMMENT ON FUNCTION app.reporting_remind(uuid, date) IS
  'Rapporteringsgrad: tells each teacher of lessons that stood open longer than the school''s limit, once per lesson, in one statement with the ledger; nothing at the weekend or with the switch off. Answers the notices with the addresses, for the delivery after the commit.';
COMMENT ON FUNCTION app.reporting_schools() IS
  '';
COMMENT ON FUNCTION app.schedule_candidates_sweep() IS
  'Schemaförslag (20261125090000): marks an active run past its lease or 30 minutes old FAILED (CANDIDATE_RUN_ABANDONED) and deletes, with their candidates, runs older than 7 days and discarded runs whose engine call can no longer be solving, skipping rows another transaction holds; returns how many rows it changed. Takes no argument and reads nothing back.';
COMMENT ON FUNCTION app.school_export_claim(interval) IS
  'K5: the oldest QUEUED export, or a RUNNING one whose heartbeat is older than the lease, FOR UPDATE SKIP LOCKED, with the login of the deciding administrator who ordered it. A taken-over export restarts with no pieces; one whose person is gone or on its third attempt FAILS.';
COMMENT ON FUNCTION app.school_export_expire(interval) IS
  'K5: READY files past their expiry lose their pieces and their list of persons (EXPIRED); finished orders past the ledger''s period are deleted.';
COMMENT ON FUNCTION app.school_export_fail(uuid, text, integer) IS
  '';
COMMENT ON FUNCTION app.school_export_finish(uuid, bigint, integer, text, jsonb, jsonb, jsonb, interval, integer) IS
  'K5: READY, after counting and summing the stored pieces against what the job says it wrote; kept for at most 14 days.';
COMMENT ON FUNCTION app.school_export_heartbeat(uuid, integer) IS
  '';
COMMENT ON FUNCTION app.school_export_put(uuid, integer, bytea, integer) IS
  'K5: one piece of a RUNNING export''s file, in the export''s own school.';
COMMENT ON FUNCTION app.ss12000_due_sources(integer, timestamp with time zone) IS
  'Claims scheduled sources whose school-local hour is at or past scheduleHourLocal and that have not run this local day (SKIP LOCKED).';
COMMENT ON FUNCTION app.ss12000_housekeeping(timestamp with time zone) IS
  'Marks RUNNING runs older than 15 minutes FETCH_FAILED (STALE) and DIFF_READY runs older than 30 days DISCARDED (EXPIRED).';
