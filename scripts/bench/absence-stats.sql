-- Frånvarostatistik över tid (20270121090000): a school of 2 000 pupils with three läsår.
--
--   docker compose exec -T db psql -U postgres -d <a throwaway database> -v ON_ERROR_STOP=1 -f /dev/stdin < scripts/bench/absence-stats.sql
--
-- Run it on a database that has the migrations and nothing you want. The first run
-- plants a school (slug bench-absence-stats) and COMMITS it: an hour on a busy
-- host, and a run after it finds the school and goes straight to the timings, so a
-- change of the functions is measured in minutes (DELETE FROM "Schools" WHERE slug =
-- 'bench-absence-stats' plants it again). The timings themselves run in a transaction
-- that is rolled back, with the stored sums, so every run is a first night. The school has
--
--   * 80 classes of 25 pupils in each of three läsår (the last begins on the
--     17th of August of the school year holding today), each class the successor
--     of the same number a year before, and the pupils following their class number
--     in every year: 2 000 pupils, 6 000 segments of history;
--   * 120 teachers, a mentor and an administrator;
--   * every school day of the three läsår up to yesterday, six lessons a day
--     for every class: about 210 000 lessons;
--   * the marks (every pupil of the class marked on 95 % of the lessons, 94 %
--     present, 3 % absent, 2 % excused and 1 % late) for the last three months
--     of every class (about 550 000 marks) and for all three läsår of the
--     first class of each year, the cohort the pupil and class doors are timed
--     on (about 70 000): not the five million of every pupil's three years, which
--     a shared disk does not hold. What each door costs rests on the rows it reads,
--     and those are all here: a month is counted from its own 260 000 marks, a
--     class's three läsår are its own, a pupil's are his own;
--   * the sums of every class and month of the three läsår, as the nights
--     would have left them (the ones without marks put in as they are, the others
--     counted by the nights below), so that the school's and the classes' views
--     read the 2 900 rows they read in production;
--
-- then times, three times each and as the API's role under an administrator's
-- or a mentor's claims, what a page asks of the database: the window, the school's
-- months, a class's months and its patterns, the classes of the läsår, a
-- class's pupils, a pupil's card (head, three läsår of months, patterns); and
-- as the owner what the job asks in a night: the first night of a school
-- (the plan and every month of the three läsår, three at a time as a night
-- backfills them) and an ordinary night (the plan, the months of the last 62
-- days, the trim). The gateway gives a statement 2 s; the job's door gives a month 9 s.
-- The figures are printed as notices, the best of three in milliseconds.
-- Mind the host: under a load average of tens, every figure carries it, and the
-- wall clock above is no measure at all (a 20-million-row count took 60 s of it on
-- the host this was written on, one second on an idle one). Measure the CPU instead:
-- run the door alone with `SET log_statement_stats = on; SET client_min_messages = log;`
-- and read the "user" seconds beside those of `SELECT count(*) FROM generate_series(1,
-- 5000000)` in the same session (a quarter of a second on an idle host); the ratio
-- is what a door costs. EXPLAIN (ANALYZE, BUFFERS) says what it reads, which no load changes.

\set ON_ERROR_STOP on
\timing off

SELECT EXISTS (SELECT 1 FROM "Schools" WHERE slug = 'bench-absence-stats') AS planted \gset
\if :planted
\echo 'bench-absence-stats is planted: timing it (DELETE FROM "Schools" WHERE slug = ''bench-absence-stats'' to plant it again)'
\else
BEGIN;

-- Stage 1: the school, its three läsår, the classes, the people. (The planner has no statistics for rows of this
-- transaction until it is asked: each stage is analysed before the next reads it, or the joins below are nested loops.)
DO $$
DECLARE
  s uuid;
  y3_start date := make_date(extract(year FROM current_date - 228)::int, 8, 17);
  starts date[];
  ends date[];
  ys uuid[];
  yi integer;
  yid uuid;
  m1 uuid;
BEGIN
  DELETE FROM "Schools" WHERE slug = 'bench-absence-stats';
  INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ('Bench Frånvarostatistik', 'bench-absence-stats', 'Europe/Stockholm', now()) RETURNING id INTO s;
  starts := ARRAY[(y3_start - interval '2 years')::date, (y3_start - interval '1 year')::date, y3_start];
  ends := ARRAY[starts[1] + 299, starts[2] + 299, starts[3] + 299];
  FOR yi IN 1..3 LOOP
    INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "predecessorId", "updatedAt")
    VALUES (s, 'Bench ' || yi, starts[yi], ends[yi], yi = 3, CASE WHEN yi > 1 THEN ys[yi - 1] END, now())
    RETURNING id INTO yid;
    ys := ys || yid;
  END LOOP;
  INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES (s, 'Bench', 'BENCH', now());

  -- The classes of each year, each the successor of the same number a year before.
  FOR yi IN 1..3 LOOP
    INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "predecessorId", "updatedAt")
    SELECT s, ys[yi], 'B' || yi || '-' || lpad(n::text, 2, '0'), 1 + (n - 1) / 9 + yi - 1, p."id", now()
      FROM generate_series(1, 80) n
      LEFT JOIN "StudentGroups" p ON yi > 1 AND p."schoolId" = s AND p."academicYearId" = ys[yi - 1] AND p."name" = 'B' || (yi - 1) || '-' || lpad(n::text, 2, '0');
  END LOOP;

  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "updatedAt")
  VALUES (s, 'bench-admin@example.invalid', 'Bench', 'Admin', 'SCHOOL_ADMIN', 'FULL', '00000000-0000-4000-8000-b0000000a001', true, now());
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  SELECT s, 'bench-t' || n || '@example.invalid', 'Bench', 'Lärare' || lpad(n::text, 3, '0'), 'TEACHER',
         CASE WHEN n = 1 THEN '00000000-0000-4000-8000-b0000000a002'::uuid ELSE gen_random_uuid() END, true, now()
    FROM generate_series(1, 120) n;
  SELECT "id" INTO m1 FROM "Users" WHERE "schoolId" = s AND "email" = 'bench-t1@example.invalid';
  INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "studentGroupId", "updatedAt")
  SELECT s, m1, ys[3], 'MENTORSKAP', 'Mentor B3-01', 60, g."id", now() FROM "StudentGroups" g WHERE g."schoolId" = s AND g."name" = 'B3-01';
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  SELECT s, 'bench-p' || n || '@example.invalid', 'Elev', 'Bench' || lpad(n::text, 4, '0'), 'STUDENT', gen_random_uuid(), true, now()
    FROM generate_series(1, 2000) n;
END $$;
ANALYZE "Users";
ANALYZE "StudentGroups";
ANALYZE "AcademicYears";

-- Stage 2: the history (the triggers held off, as the tests do): 2 000 pupils in the class of their number, each year.
DO $$
DECLARE
  s uuid := (SELECT id FROM "Schools" WHERE slug = 'bench-absence-stats');
  ys uuid[] := ARRAY(SELECT id FROM "AcademicYears" WHERE "schoolId" = s ORDER BY "startDate");
  starts date[] := ARRAY(SELECT "startDate" FROM "AcademicYears" WHERE "schoolId" = s ORDER BY "startDate");
  yi integer;
BEGIN
  PERFORM set_config('session_replication_role', 'replica', true);
  FOR yi IN 1..3 LOOP
    INSERT INTO "StudentEnrollments" ("schoolId", "studentId", "academicYearId", "studentGroupId", "gradeLevel", "validFrom", "validTo")
    SELECT s, u."id", ys[yi], g."id", g."gradeLevel", starts[yi], CASE WHEN yi < 3 THEN starts[yi + 1] END
      FROM (SELECT "id", row_number() OVER (ORDER BY "email") - 1 AS n FROM "Users" WHERE "schoolId" = s AND role = 'STUDENT') u
      JOIN "StudentGroups" g ON g."schoolId" = s AND g."academicYearId" = ys[yi] AND g."name" = 'B' || yi || '-' || lpad((u.n / 25 + 1)::text, 2, '0');
  END LOOP;
  UPDATE "Users" u SET "studentGroupId" = e."studentGroupId"
    FROM "StudentEnrollments" e WHERE u."schoolId" = s AND e."studentId" = u."id" AND e."validTo" IS NULL;
END $$;
ANALYZE "StudentEnrollments";

-- Stage 3: every school day of the three läsår up to yesterday, six lessons a day for every class, one teacher each.
DO $$
DECLARE
  s uuid := (SELECT id FROM "Schools" WHERE slug = 'bench-absence-stats');
  ys uuid[] := ARRAY(SELECT id FROM "AcademicYears" WHERE "schoolId" = s ORDER BY "startDate");
  starts date[] := ARRAY(SELECT "startDate" FROM "AcademicYears" WHERE "schoolId" = s ORDER BY "startDate");
  ends date[] := ARRAY(SELECT "endDate" FROM "AcademicYears" WHERE "schoolId" = s ORDER BY "startDate");
  subj uuid := (SELECT id FROM "Subjects" WHERE "schoolId" = s AND code = 'BENCH');
  teachers uuid[] := ARRAY(SELECT id FROM "Users" WHERE "schoolId" = s AND role = 'TEACHER' ORDER BY email);
  today date := (now() AT TIME ZONE 'Europe/Stockholm')::date;
  yi integer;
BEGIN
  PERFORM set_config('session_replication_role', 'replica', true);
  FOR yi IN 1..3 LOOP
    INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", status, "updatedAt")
    SELECT s, subj, g."id", days.d, (days.d + make_time(8 + h, 0, 0)) AT TIME ZONE 'Europe/Stockholm',
           (days.d + make_time(8 + h, 0, 0)) AT TIME ZONE 'Europe/Stockholm' + interval '50 minutes', 'SCHEDULED', now()
      FROM "StudentGroups" g
     CROSS JOIN (SELECT x::date AS d FROM generate_series(starts[yi], least(ends[yi], today - 1), interval '1 day') x WHERE extract(isodow FROM x) < 6) days
     CROSS JOIN generate_series(0, 5) h
     WHERE g."schoolId" = s AND g."academicYearId" = ys[yi];
  END LOOP;
  INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role)
  SELECT s, cl."id", teachers[1 + (abs(hashtext(cl."studentGroupId"::text)) + extract(hour FROM cl."startsAt" AT TIME ZONE 'Europe/Stockholm')::int * 7) % 120], 'LEAD'
    FROM "CalendarLessons" cl WHERE cl."schoolId" = s;
END $$;
ANALYZE "CalendarLessons";
ANALYZE "CalendarLessonTeachers";

-- Stage 4: the marks of the last three months of every class and of the first class of each year, 95 % of the lessons.
DO $$
DECLARE
  s uuid := (SELECT id FROM "Schools" WHERE slug = 'bench-absence-stats');
  today date := (now() AT TIME ZONE 'Europe/Stockholm')::date;
  t0 timestamptz := clock_timestamp();
BEGIN
  PERFORM set_config('session_replication_role', 'replica', true);
  INSERT INTO "AttendanceRecords" ("schoolId", "calendarLessonId", "studentId", status, "recordedAt", "updatedAt")
  SELECT s, cl."id", e."studentId",
         (CASE WHEN x.h % 100 < 94 THEN 'PRESENT' WHEN x.h % 100 < 97 THEN 'ABSENT' WHEN x.h % 100 < 99 THEN 'EXCUSED' ELSE 'LATE' END)::"AttendanceStatus",
         cl."startsAt", now()
    FROM "CalendarLessons" cl
    JOIN "StudentGroups" g ON g."id" = cl."studentGroupId"
    JOIN "StudentEnrollments" e ON e."schoolId" = s AND e."studentGroupId" = cl."studentGroupId" AND e."validFrom" <= cl."date" AND (e."validTo" IS NULL OR cl."date" < e."validTo")
   CROSS JOIN LATERAL (SELECT abs(hashtext(cl."id"::text || e."studentId"::text)) AS h) x
   WHERE cl."schoolId" = s
     AND abs(hashtext(cl."id"::text)) % 20 <> 0
     AND (cl."date" >= date_trunc('month', today)::date - interval '2 months' OR g."name" LIKE 'B_-01');
  PERFORM set_config('session_replication_role', 'origin', true);
  RAISE NOTICE 'planted % lessons and % marks, the marks in % s',
    (SELECT count(*) FROM "CalendarLessons" WHERE "schoolId" = s), (SELECT count(*) FROM "AttendanceRecords" WHERE "schoolId" = s),
    round(extract(epoch FROM clock_timestamp() - t0)::numeric, 1);
END $$;
ANALYZE "AttendanceRecords";
COMMIT;
\endif

BEGIN;

-- The job. The first nights of the school: the plan and every month it asks for, night after night (three older
-- months a night) until all three läsår are counted; then an ordinary night.
DO $$
DECLARE
  s uuid := (SELECT id FROM "Schools" WHERE slug = 'bench-absence-stats');
  as_of date := (now() AT TIME ZONE 'Europe/Stockholm')::date - 1;
  m record;
  t timestamptz;
  t_night timestamptz;
  night integer := 0;
  months integer := 0;
  slowest numeric := 0;
  longest_night numeric := 0;
  took numeric;
BEGIN
  LOOP
    night := night + 1;
    t_night := clock_timestamp();
    FOR m IN SELECT p.month FROM app.absence_stats_plan(s, as_of) p LOOP
      t := clock_timestamp();
      PERFORM app.absence_stats_month(s, m.month, as_of);
      took := extract(epoch FROM clock_timestamp() - t) * 1000;
      slowest := greatest(slowest, took);
      months := months + 1;
    END LOOP;
    longest_night := greatest(longest_night, extract(epoch FROM clock_timestamp() - t_night) * 1000);
    EXIT WHEN night >= 14 OR NOT EXISTS (SELECT 1 FROM app.absence_stats_plan(s, as_of) p WHERE p.month < date_trunc('month', (as_of - 61)::timestamp)::date);
  END LOOP;
  RAISE NOTICE 'first nights: % nights, % months counted, the slowest month % ms, the longest night % ms', night, months, round(slowest), round(longest_night);
  RAISE NOTICE 'the sums: % rows, % classes with a month',
    (SELECT count(*) FROM "AbsenceStatsMonths" WHERE "schoolId" = s), (SELECT count(DISTINCT "studentGroupId") FROM "AbsenceStatsMonths" WHERE "schoolId" = s);
END $$;

-- The rest of the sums, as the nights would have left them for classes whose marks are not planted above (a class of 25
-- pupils, a full month): 80 classes in each of three läsår, so that the views read what they read in production.
DO $$
DECLARE
  s uuid := (SELECT id FROM "Schools" WHERE slug = 'bench-absence-stats');
  as_of date := (now() AT TIME ZONE 'Europe/Stockholm')::date - 1;
BEGIN
  INSERT INTO "AbsenceStatsMonths" ("schoolId", "studentGroupId", "month", "throughDay", pupils, "pupilsRegistered", "recordedMinutes", "validMinutes",
                                    "absentMinutes", "lateMinutes", "lateCount", "lessonsHeld", "lessonsReported")
  SELECT s, g."id", m::date, least((m + interval '1 month' - interval '1 day')::date, as_of), 25, 25, 165000, 3300, 4950, 1650, 110, 132, 125
    FROM "StudentGroups" g
    JOIN "AcademicYears" y ON y."id" = g."academicYearId" AND y."schoolId" = g."schoolId"
   CROSS JOIN generate_series(date_trunc('month', y."startDate"::timestamp), date_trunc('month', least(y."endDate", as_of)::timestamp), interval '1 month') m
   WHERE g."schoolId" = s AND m::date <= as_of
  ON CONFLICT ("schoolId", "studentGroupId", "month") WHERE "studentGroupId" IS NOT NULL DO NOTHING;
  RAISE NOTICE 'the sums: % rows (%  classes)', (SELECT count(*) FROM "AbsenceStatsMonths" WHERE "schoolId" = s), (SELECT count(DISTINCT "studentGroupId") FROM "AbsenceStatsMonths" WHERE "schoolId" = s);
END $$;
ANALYZE "AbsenceStatsMonths";

DO $$
DECLARE
  s uuid := (SELECT id FROM "Schools" WHERE slug = 'bench-absence-stats');
  as_of date := (now() AT TIME ZONE 'Europe/Stockholm')::date - 1;
  m record;
  t timestamptz;
  best numeric := 1e9;
  took numeric;
  i integer;
BEGIN
  FOR i IN 1..3 LOOP
    t := clock_timestamp();
    PERFORM count(*) FROM app.absence_stats_plan(s, as_of);
    FOR m IN SELECT p.month FROM app.absence_stats_plan(s, as_of) p LOOP
      PERFORM app.absence_stats_month(s, m.month, as_of);
    END LOOP;
    PERFORM app.absence_stats_trim(s, as_of);
    took := extract(epoch FROM clock_timestamp() - t) * 1000;
    best := least(best, took);
  END LOOP;
  RAISE NOTICE 'an ordinary night (the plan, the months of the last 62 days, the trim): % ms for % months', round(best), (SELECT count(*) FROM app.absence_stats_plan(s, as_of) p WHERE p.month >= date_trunc('month', as_of - 61));
END $$;

-- What a page asks, as the API's role.
CREATE FUNCTION pg_temp.bench_read(p_label text, p_sub text, p_q text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  best numeric := 1e9;
  worst numeric := 0;
  n integer;
  t timestamptz;
  took numeric;
  i integer;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_sub)::text, true);
  FOR i IN 1..3 LOOP
    t := clock_timestamp();
    EXECUTE 'SELECT count(*) FROM (' || p_q || ') x' INTO n;
    took := extract(epoch FROM clock_timestamp() - t) * 1000;
    best := least(best, took);
    worst := greatest(worst, took);
  END LOOP;
  RAISE NOTICE '% ms (worst %)  % rows  %', lpad(round(best, 1)::text, 7), round(worst, 1), n, p_label;
END $$;

DO $$
DECLARE
  s uuid := (SELECT id FROM "Schools" WHERE slug = 'bench-absence-stats');
  adm constant text := '00000000-0000-4000-8000-b0000000a001';
  mentor constant text := '00000000-0000-4000-8000-b0000000a002';
  cls uuid := (SELECT id FROM "StudentGroups" WHERE "schoolId" = s AND name = 'B3-01');
  -- A pupil of the mentor's class, so that the mentor's reads below are the mentor's own pupil's.
  pupil uuid := (SELECT e."studentId" FROM "StudentEnrollments" e
                  WHERE e."schoolId" = s AND e."studentGroupId" = (SELECT id FROM "StudentGroups" WHERE "schoolId" = s AND name = 'B3-01')
                    AND e."validTo" IS NULL ORDER BY e."studentId" LIMIT 1);
  yr_start date := (SELECT "startDate" FROM "AcademicYears" WHERE "schoolId" = s AND "isActive");
  first_day date := (SELECT min("startDate") FROM "AcademicYears" WHERE "schoolId" = s);
  yesterday date := (now() AT TIME ZONE 'Europe/Stockholm')::date - 1;
BEGIN
  SET LOCAL ROLE app_authenticated;
  PERFORM pg_temp.bench_read('window', adm, 'SELECT * FROM app.absence_stats_window()');
  PERFORM pg_temp.bench_read('the school''s months (3 läsår)', adm, 'SELECT * FROM app.absence_stats_series()');
  PERFORM pg_temp.bench_read('a class''s months (the cohort''s three classes)', adm, format('SELECT * FROM app.absence_stats_series(%L)', cls));
  PERFORM pg_temp.bench_read('a class''s months, as its mentor', mentor, format('SELECT * FROM app.absence_stats_series(%L)', cls));
  PERFORM pg_temp.bench_read('the 80 classes of the läsår so far', adm, format('SELECT * FROM app.absence_stats_classes(%L, %L)', yr_start, yesterday));
  PERFORM pg_temp.bench_read('the 80 classes of the three läsår', adm, format('SELECT * FROM app.absence_stats_classes(%L, %L)', first_day, yesterday));
  PERFORM pg_temp.bench_read('a class''s pupils over the läsår', adm, format('SELECT * FROM app.absence_stats_class_pupils(%L, %L, %L)', cls, yr_start, yesterday));
  PERFORM pg_temp.bench_read('a class''s pupils over the three läsår', adm, format('SELECT * FROM app.absence_stats_class_pupils(%L, %L, %L)', cls, first_day, yesterday));
  PERFORM pg_temp.bench_read('a class''s patterns over the läsår', adm, format('SELECT * FROM app.absence_stats_patterns(%L, NULL, %L, %L)', cls, yr_start, yesterday));
  PERFORM pg_temp.bench_read('a class''s patterns over the three läsår (the cohort)', adm, format('SELECT * FROM app.absence_stats_patterns(%L, NULL, %L, %L)', cls, first_day, yesterday));
  PERFORM pg_temp.bench_read('a pupil: the head', adm, format('SELECT * FROM app.absence_stats_pupil_head(%L)', pupil));
  PERFORM pg_temp.bench_read('a pupil: the months of three läsår', adm, format('SELECT * FROM app.absence_stats_pupil(%L, %L, %L)', pupil, first_day, yesterday));
  PERFORM pg_temp.bench_read('a pupil: the months, as the mentor', mentor, format('SELECT * FROM app.absence_stats_pupil(%L, %L, %L)', pupil, first_day, yesterday));
  PERFORM pg_temp.bench_read('a pupil: the patterns over three läsår', adm, format('SELECT * FROM app.absence_stats_patterns(NULL, %L, %L, %L)', pupil, first_day, yesterday));
END $$;

ROLLBACK;
