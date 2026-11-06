-- Rapporteringsgrad (20270112090100): the nightly job on a school of 500 pupils
-- with a year of lessons.
--
--   docker compose exec -T db psql -U postgres -d <a throwaway database> -v ON_ERROR_STOP=1 -f /dev/stdin < scripts/bench/reporting-rate.sql
--
-- Run it on a database that has the migrations and nothing you want. It plants a
-- school (slug bench-reporting-rate) inside a transaction that is rolled back at
-- the end, with
--
--   * 25 classes of 20 pupils and 50 teachers, every class taught by 9 or 10 of
--     them, and 5 administrators of the profiles that hear the week;
--   * a year of school days (the last 365 days less eight weeks of
--     summer), six lessons a day for every class: about 28 000 lessons;
--   * a register on 85 % of the lessons of the last 120 days (every pupil's mark,
--     about 400 000 rows, and the last two days with fewer), none older: the
--     night only looks at 90 days;
--   * 8 teachers who save about a third of their lessons;
--
-- then times, each three times, what the job asks of the database in a night:
-- the count (app.reporting_compute), the reminders (app.reporting_remind, with
-- the switch dated 40 days back so the lessons count) and the week's notice, and
-- what a teacher's page view asks (app.reporting_open_lessons). \timing is on. The first count writes the days, the second and third keep them: that is
-- every night after the first. The count is also run once with the school's
-- attendance gallring decided, to show that the guard costs nothing.

\set ON_ERROR_STOP on
\timing off

BEGIN;

DO $$
DECLARE
  s uuid;
  y uuid;
  subj uuid;
  g uuid;
  k integer;
  today date := (now() AT TIME ZONE 'Europe/Stockholm')::date;
BEGIN
  DELETE FROM "Schools" WHERE slug = 'bench-reporting-rate';
  INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ('Bench rapporteringsgrad', 'bench-reporting-rate', 'Europe/Stockholm', now()) RETURNING id INTO s;
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
  VALUES (s, 'bench', today - 400, today + 300, true, 'NIOARIG', now()) RETURNING id INTO y;
  INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES (s, 'Bench', 'BNC', now()) RETURNING id INTO subj;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "updatedAt")
  SELECT s, 'bench-admin' || n || '@example.invalid', 'Admin', n::text, 'SCHOOL_ADMIN',
         (ARRAY['FULL', 'REKTOR', 'EXPEDITION', 'SCHEMALAGGARE', 'LASARE'])[n]::"AdminProfile", gen_random_uuid(), true, now()
    FROM generate_series(1, 5) n;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  SELECT s, 'bench-t' || n || '@example.invalid', 'Lärare', n::text, 'TEACHER', gen_random_uuid(), true, now()
    FROM generate_series(1, 50) n;
  FOR k IN 1..25 LOOP
    INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt")
    VALUES (s, y, 'BN' || k, 4 + k % 6, now()) RETURNING id INTO g;
    INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
    SELECT s, 'bench-p' || k || '-' || n || '@example.invalid', 'Elev', k || '-' || n, 'STUDENT', gen_random_uuid(), true, g, now()
      FROM generate_series(1, 20) n;
  END LOOP;

  -- The school days of the last year: weekdays less 56 days of summer break.
  CREATE TEMP TABLE bench_days ON COMMIT DROP AS
  SELECT d::date AS day, row_number() OVER (ORDER BY d) AS n
    FROM generate_series(today - 365, today - 1, interval '1 day') d
   WHERE extract(isodow FROM d) < 6
     AND NOT (d::date BETWEEN today - 300 AND today - 245);

  -- Six lessons a day for every class, each with one teacher: the class's teachers take turns by slot.
  INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", status, "updatedAt")
  SELECT s, subj, sg.id, bd.day,
         (bd.day + make_time(7 + slot * 1, 30, 0)) AT TIME ZONE 'Europe/Stockholm',
         (bd.day + make_time(7 + slot * 1, 30, 0) + interval '50 minutes') AT TIME ZONE 'Europe/Stockholm',
         'SCHEDULED', now()
    FROM bench_days bd
   CROSS JOIN "StudentGroups" sg
   CROSS JOIN generate_series(1, 6) slot
   WHERE sg."schoolId" = s;

  -- The teacher of a lesson: one of the 50, by class number and slot, so that nobody is in two rooms at once.
  INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role)
  SELECT s, cl.id, t.id, 'LEAD'
    FROM "CalendarLessons" cl
    JOIN "StudentGroups" sg ON sg.id = cl."studentGroupId"
    JOIN LATERAL (
         SELECT u.id FROM "Users" u WHERE u."schoolId" = s AND u.role = 'TEACHER'
          ORDER BY u.email
         OFFSET ((substring(sg.name FROM 3)::int * 7 + extract(hour FROM cl."startsAt" AT TIME ZONE 'Europe/Stockholm')::int * 11 + extract(doy FROM cl.date)::int) % 50) LIMIT 1) t ON true
   WHERE cl."schoolId" = s;

  -- A register on 85 % of the lessons of the last 120 days, from every pupil of the class; the eight teachers
  -- who "save a third" are the first eight, whose lessons get a register one time in three.
  INSERT INTO "AttendanceRecords" ("schoolId", "calendarLessonId", "studentId", status, "updatedAt")
  SELECT s, cl.id, p.id, 'PRESENT', now()
    FROM "CalendarLessons" cl
    JOIN "CalendarLessonTeachers" clt ON clt."calendarLessonId" = cl.id
    JOIN "Users" t ON t.id = clt."teacherId"
    JOIN "Users" p ON p."studentGroupId" = cl."studentGroupId" AND p.role = 'STUDENT'
   WHERE cl."schoolId" = s AND cl.date >= today - 120
     AND (CASE WHEN substring(t.email FROM 8 FOR position('@' IN t.email) - 8)::int <= 8
               THEN abs(hashtext(cl.id::text)) % 3 = 0
               ELSE abs(hashtext(cl.id::text)) % 100 < 85 END);
END $$;

ANALYZE "CalendarLessons";
ANALYZE "CalendarLessonTeachers";
ANALYZE "AttendanceRecords";
ANALYZE "Users";

SELECT count(*) AS lessons FROM "CalendarLessons" WHERE "schoolId" = (SELECT id FROM "Schools" WHERE slug = 'bench-reporting-rate') \gset
SELECT count(*) AS marks FROM "AttendanceRecords" WHERE "schoolId" = (SELECT id FROM "Schools" WHERE slug = 'bench-reporting-rate') \gset
\echo lessons :lessons, marks :marks

\timing on
\echo -- the count, three nights (the first writes the days, the others keep them)
SELECT written, removed, teachers, held, reported FROM app.reporting_compute((SELECT id FROM "Schools" WHERE slug = 'bench-reporting-rate'), (now() AT TIME ZONE 'Europe/Stockholm')::date - 1);
SELECT written, removed, teachers, held, reported FROM app.reporting_compute((SELECT id FROM "Schools" WHERE slug = 'bench-reporting-rate'), (now() AT TIME ZONE 'Europe/Stockholm')::date - 1);
SELECT written, removed, teachers, held, reported FROM app.reporting_compute((SELECT id FROM "Schools" WHERE slug = 'bench-reporting-rate'), (now() AT TIME ZONE 'Europe/Stockholm')::date - 1);

\echo -- the school-list question the job asks first
SELECT count(*) FROM app.reporting_schools();

\timing off
INSERT INTO "ReportingSettings" ("schoolId", "teacherReminders", "rektorDigest", "openAfterDays")
SELECT id, true, true, 2 FROM "Schools" WHERE slug = 'bench-reporting-rate';
ALTER TABLE "ReportingSettings" DISABLE TRIGGER "ReportingSettings_stamp";
UPDATE "ReportingSettings" SET "teacherRemindersOn" = (now() AT TIME ZONE 'Europe/Stockholm')::date - 40, "rektorDigestOn" = (now() AT TIME ZONE 'Europe/Stockholm')::date - 40
 WHERE "schoolId" = (SELECT id FROM "Schools" WHERE slug = 'bench-reporting-rate');
ALTER TABLE "ReportingSettings" ENABLE TRIGGER "ReportingSettings_stamp";

\timing on
\echo -- the reminders, three nights (the first writes them, the others find them done), on a Wednesday
SELECT count(*) AS notices, sum((meta ->> 'count')::int) AS lessons
  FROM app.reporting_remind((SELECT id FROM "Schools" WHERE slug = 'bench-reporting-rate'),
       (SELECT d::date FROM generate_series((now() AT TIME ZONE 'Europe/Stockholm')::date - 6, (now() AT TIME ZONE 'Europe/Stockholm')::date, interval '1 day') d WHERE extract(isodow FROM d) = 3));
SELECT count(*) AS notices FROM app.reporting_remind((SELECT id FROM "Schools" WHERE slug = 'bench-reporting-rate'),
       (SELECT d::date FROM generate_series((now() AT TIME ZONE 'Europe/Stockholm')::date - 6, (now() AT TIME ZONE 'Europe/Stockholm')::date, interval '1 day') d WHERE extract(isodow FROM d) = 3));
SELECT count(*) AS notices FROM app.reporting_remind((SELECT id FROM "Schools" WHERE slug = 'bench-reporting-rate'),
       (SELECT d::date FROM generate_series((now() AT TIME ZONE 'Europe/Stockholm')::date - 6, (now() AT TIME ZONE 'Europe/Stockholm')::date, interval '1 day') d WHERE extract(isodow FROM d) = 3));

\echo -- the weeks notice, for last week, and again
SELECT count(*) AS notices FROM app.reporting_digest((SELECT id FROM "Schools" WHERE slug = 'bench-reporting-rate'),
       date_trunc('week', (now() AT TIME ZONE 'Europe/Stockholm')::date - 7)::date, (date_trunc('week', (now() AT TIME ZONE 'Europe/Stockholm')::date - 7) + interval '6 days')::date);
SELECT count(*) AS notices FROM app.reporting_digest((SELECT id FROM "Schools" WHERE slug = 'bench-reporting-rate'),
       date_trunc('week', (now() AT TIME ZONE 'Europe/Stockholm')::date - 7)::date, (date_trunc('week', (now() AT TIME ZONE 'Europe/Stockholm')::date - 7) + interval '6 days')::date);

\echo -- the teachers own list (what Min rapportering asks on every page view), as a teacher, three times: it must
\echo -- cost what the teachers lessons cost, not the schools (an inlined definition takes the teacher into the scan)
SELECT set_config('request.jwt.claims', json_build_object('sub', (SELECT "authId" FROM "Users" WHERE email = 'bench-t20@example.invalid'))::text, true);
SET LOCAL ROLE app_authenticated;
SELECT count(*) AS open_lessons FROM app.reporting_open_lessons(30);
SELECT count(*) AS open_lessons FROM app.reporting_open_lessons(30);
SELECT count(*) AS open_lessons FROM app.reporting_open_lessons(30);
RESET ROLE;

\echo -- the view the rektor opens: a lasar added up per teacher, and the teachers own list
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY ON)
SELECT d."teacherId", sum(d.held), sum(d.reported) FROM "TeacherReportingDays" d
 WHERE d."schoolId" = (SELECT id FROM "Schools" WHERE slug = 'bench-reporting-rate') AND d.day BETWEEN current_date - 365 AND current_date GROUP BY 1;

\echo -- the count with the schools attendance gallring decided (the guard asks the decision table once)
\timing off
ALTER TABLE "RetentionDecisions" DISABLE TRIGGER "RetentionDecisions_stamped";
INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision, months, reference, "decidedById", "decidedAt")
SELECT s.id, 'ATTENDANCE', 'PURGE_AFTER', 24, 'bench', (SELECT id FROM "Users" WHERE "schoolId" = s.id AND role = 'SCHOOL_ADMIN' LIMIT 1), now() - interval '2 days'
  FROM "Schools" s WHERE s.slug = 'bench-reporting-rate';
ALTER TABLE "RetentionDecisions" ENABLE TRIGGER "RetentionDecisions_stamped";
\timing on
SELECT written, removed, teachers, held, reported FROM app.reporting_compute((SELECT id FROM "Schools" WHERE slug = 'bench-reporting-rate'), (now() AT TIME ZONE 'Europe/Stockholm')::date - 1);

ROLLBACK;
