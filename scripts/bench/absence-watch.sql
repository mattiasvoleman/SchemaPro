-- Frånvarobevakning (20261231090100): the nightly job on a school of 500 pupils
-- with a year of attendance.
--
--   docker compose exec -T db psql -U postgres -d <a throwaway database> -v ON_ERROR_STOP=1 -f /dev/stdin < scripts/bench/absence-watch.sql
--
-- Run it on a database that has the migrations and nothing you want: it plants
-- a school (slug bench-absence-watch) with
--
--   * 25 classes of 20 pupils, a mentor for each, two guardians for most pupils,
--     five administrators of the profiles that hear a digest;
--   * a year of school days (the last 365 days less the summer and the winter
--     break), six lessons a day for every class, and every pupil's mark on
--     each: about 570 000 rows of AttendanceRecords over 28 000 lessons;
--   * marks as a school has them: 92.5 % present, 3 % late, 2 % giltig and 2 %
--     ogiltig absence, 0.5 % not registered; and 30 pupils who are away a good
--     deal more (every tenth of their days, and a run of five school days in
--     the last fortnight for ten of them);
--   * the four limits of the manual's example: mentors 10 % ogiltig over 14
--     days, guardians 20 % ogiltig over 14 days, rektor 5 school days in a row
--     (all absence), kansli 15 % of all absence over 28 days;
--
-- then times, each three times, what the job asks of the database in a night:
-- the count (app.absence_watch_evaluate), the question of what is due, and
-- the four digests (app.absence_watch_digest, whose plan is the recipients of a
-- group). \timing is on. The first count opens the findings, the second and
-- third keep them: that is every night after the first.

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
  DELETE FROM "Schools" WHERE slug = 'bench-absence-watch';
  INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ('Bench frånvarobevakning', 'bench-absence-watch', 'Europe/Stockholm', now()) RETURNING id INTO s;
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
  VALUES (s, 'bench', today - 400, today + 300, true, 'NIOARIG', now()) RETURNING id INTO y;
  INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES (s, 'Bench', 'BNC', now()) RETURNING id INTO subj;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "updatedAt")
  SELECT s, 'bench-admin' || n || '@example.invalid', 'Admin', n::text, 'SCHOOL_ADMIN',
         (ARRAY['FULL', 'REKTOR', 'EXPEDITION', 'EXPEDITION', 'SCHEMALAGGARE'])[n]::"AdminProfile", gen_random_uuid(), true, now()
    FROM generate_series(1, 5) n;
  FOR k IN 1..25 LOOP
    INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt")
    VALUES (s, y, 'BN' || k, 4 + k % 6, now()) RETURNING id INTO g;
    INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
    VALUES (s, 'bench-mentor' || k || '@example.invalid', 'Mentor', k::text, 'TEACHER', gen_random_uuid(), true, now());
    INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "studentGroupId", "updatedAt")
    SELECT s, id, y, 'MENTORSKAP', 'Mentor BN' || k, 60, g, now() FROM "Users" WHERE "schoolId" = s AND email = 'bench-mentor' || k || '@example.invalid';
    INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "studentGroupId", "authId", "isActive", "updatedAt")
    SELECT s, 'bench-p' || k || '-' || n || '@example.invalid', 'Elev', k || '-' || n, 'STUDENT', g, gen_random_uuid(), true, now()
      FROM generate_series(1, 20) n;
  END LOOP;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  SELECT s, 'bench-g' || n || '@example.invalid', 'Vårdnadshavare', n::text, 'GUARDIAN', gen_random_uuid(), true, now()
    FROM generate_series(1, 800) n;
  -- Pupil n of the school (by email order) has guardian n and, for most, guardian 500 + n.
  INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId")
  SELECT s, gu.id, p.id
    FROM (SELECT id, row_number() OVER (ORDER BY email) AS n FROM "Users" WHERE "schoolId" = s AND role = 'STUDENT') p
    JOIN (SELECT id, row_number() OVER (ORDER BY email) AS n FROM "Users" WHERE "schoolId" = s AND role = 'GUARDIAN') gu
      ON gu.n = p.n OR (gu.n = 500 + p.n AND p.n <= 300);
  -- The 570 000 marks and their lessons go in with the triggers off: the SS12000
  -- versioning they run is for a school that shares attendance, and this one does not.
  PERFORM set_config('session_replication_role', 'replica', true);

  -- The calendar: weekdays of the last 365 days outside the summer and the winter break.
  CREATE TEMP TABLE bench_days ON COMMIT DROP AS
    SELECT d::date AS day FROM generate_series(today - 365, today - 1, interval '1 day') d
     WHERE extract(isodow FROM d) < 6
       AND NOT (extract(month FROM d) IN (6, 7) AND extract(day FROM d) >= 1 AND NOT (extract(month FROM d) = 6 AND extract(day FROM d) < 10))
       AND NOT (extract(month FROM d) = 8 AND extract(day FROM d) < 15)
       AND NOT (extract(month FROM d) = 12 AND extract(day FROM d) >= 20)
       AND NOT (extract(month FROM d) = 1 AND extract(day FROM d) < 7);
  INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", "updatedAt")
  SELECT s, subj, sg.id, bd.day,
         (bd.day + time '08:00') AT TIME ZONE 'Europe/Stockholm' + slot * interval '70 minutes',
         (bd.day + time '09:00') AT TIME ZONE 'Europe/Stockholm' + slot * interval '70 minutes', now()
    FROM bench_days bd CROSS JOIN (SELECT id FROM "StudentGroups" WHERE "schoolId" = s) sg CROSS JOIN generate_series(0, 5) slot;

  -- Thirty pupils who are away more: every tenth day, and ten with a run of five days in the last fortnight.
  CREATE TEMP TABLE bench_away ON COMMIT DROP AS
    SELECT id, row_number() OVER (ORDER BY email) AS n FROM "Users" WHERE "schoolId" = s AND role = 'STUDENT' AND (hashtext(email) % 17) = 0 LIMIT 30;
  CREATE TEMP TABLE bench_run_days ON COMMIT DROP AS
    SELECT day FROM bench_days ORDER BY day DESC LIMIT 5;
  INSERT INTO "AttendanceRecords" ("schoolId", "calendarLessonId", "studentId", status, "updatedAt")
  SELECT s, l.id, u.id,
         (CASE
            WHEN a.id IS NOT NULL AND a.n <= 10 AND l.date IN (SELECT day FROM bench_run_days) THEN 'ABSENT'
            WHEN a.id IS NOT NULL AND (l.date - date '2000-01-01') % 10 = a.n % 10 THEN 'ABSENT'
            ELSE (ARRAY['PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'PRESENT',
                          'PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'PRESENT',
                          'LATE', 'LATE', 'LATE', 'EXCUSED', 'EXCUSED', 'ABSENT', 'ABSENT', 'UNKNOWN'])
                 [1 + (abs(hashtext(l.id::text || u.id::text)) % 48)]
          END)::"AttendanceStatus",
         now()
    FROM "CalendarLessons" l
    JOIN "Users" u ON u."studentGroupId" = l."studentGroupId" AND u.role = 'STUDENT'
    LEFT JOIN bench_away a ON a.id = u.id
   WHERE l."schoolId" = s;

  -- The date the switch went on is the trigger's, which is off here: it went on long ago.
  INSERT INTO "AbsenceWatchSettings" ("schoolId", enabled, "enabledOn") VALUES (s, true, today - 90);
  PERFORM set_config('session_replication_role', 'origin', true);
  INSERT INTO "AbsenceWatchLimits" ("schoolId", "recipientGroup", kind, basis, percent, "windowDays") VALUES
    (s, 'MENTOR', 'SHARE', 'INVALID', 10, 14), (s, 'GUARDIAN', 'SHARE', 'INVALID', 20, 14), (s, 'KANSLI', 'SHARE', 'ALL', 15, 28);
  INSERT INTO "AbsenceWatchLimits" ("schoolId", "recipientGroup", kind, basis, "consecutiveDays") VALUES (s, 'REKTOR', 'CONSECUTIVE', 'ALL', 5);
END $$;
COMMIT;

ANALYZE "CalendarLessons"; ANALYZE "AttendanceRecords"; ANALYZE "Users"; ANALYZE "StudentEnrollments"; ANALYZE "GuardianStudents";

SELECT (SELECT count(*) FROM "AttendanceRecords" a JOIN "Schools" s ON s.id = a."schoolId" WHERE s.slug = 'bench-absence-watch') AS attendance_rows,
       (SELECT count(*) FROM "CalendarLessons" l JOIN "Schools" s ON s.id = l."schoolId" WHERE s.slug = 'bench-absence-watch') AS lessons,
       (SELECT count(*) FROM "Users" u JOIN "Schools" s ON s.id = u."schoolId" WHERE s.slug = 'bench-absence-watch' AND u.role = 'STUDENT') AS pupils;

\timing on
\echo -- the count of last night, three times (the first opens the findings)
SELECT * FROM app.absence_watch_evaluate((SELECT id FROM "Schools" WHERE slug = 'bench-absence-watch'), (now() AT TIME ZONE 'Europe/Stockholm')::date - 1);
SELECT * FROM app.absence_watch_evaluate((SELECT id FROM "Schools" WHERE slug = 'bench-absence-watch'), (now() AT TIME ZONE 'Europe/Stockholm')::date - 1);
SELECT * FROM app.absence_watch_evaluate((SELECT id FROM "Schools" WHERE slug = 'bench-absence-watch'), (now() AT TIME ZONE 'Europe/Stockholm')::date - 1);
SELECT f."recipientGroup", count(*) AS findings, count(DISTINCT f."studentId") AS pupils
  FROM "AbsenceWatchFindings" f JOIN "Schools" s ON s.id = f."schoolId" AND s.slug = 'bench-absence-watch' WHERE f."clearedOn" IS NULL
 GROUP BY 1 ORDER BY 1;
\echo -- what is due today
SELECT * FROM app.absence_watch_digest_due((SELECT id FROM "Schools" WHERE slug = 'bench-absence-watch'), (now() AT TIME ZONE 'Europe/Stockholm')::date);
\echo -- the recipients of each group (the plan), and the digest of each, which is the plan, the read log and the notices
SELECT 'MENTOR' AS g, count(*) AS recipients FROM app.absence_watch_digest_plan((SELECT id FROM "Schools" WHERE slug = 'bench-absence-watch'), 'MENTOR', current_date - 14, current_date - 1, current_date);
SELECT 'GUARDIAN' AS g, count(*) AS recipients FROM app.absence_watch_digest_plan((SELECT id FROM "Schools" WHERE slug = 'bench-absence-watch'), 'GUARDIAN', current_date - 31, current_date - 1, current_date);
SELECT 'REKTOR' AS g, count(*) AS recipients FROM app.absence_watch_digest_plan((SELECT id FROM "Schools" WHERE slug = 'bench-absence-watch'), 'REKTOR', current_date - 14, current_date - 1, current_date);
SELECT 'KANSLI' AS g, count(*) AS recipients FROM app.absence_watch_digest_plan((SELECT id FROM "Schools" WHERE slug = 'bench-absence-watch'), 'KANSLI', current_date - 14, current_date - 1, current_date);
BEGIN;
SELECT 'MENTOR' AS g, count(*) AS notices FROM app.absence_watch_digest((SELECT id FROM "Schools" WHERE slug = 'bench-absence-watch'), 'MENTOR', current_date - 14, current_date - 1, current_date);
SELECT 'GUARDIAN' AS g, count(*) AS notices FROM app.absence_watch_digest((SELECT id FROM "Schools" WHERE slug = 'bench-absence-watch'), 'GUARDIAN', current_date - 31, current_date - 1, current_date);
SELECT 'REKTOR' AS g, count(*) AS notices FROM app.absence_watch_digest((SELECT id FROM "Schools" WHERE slug = 'bench-absence-watch'), 'REKTOR', current_date - 14, current_date - 1, current_date);
SELECT 'KANSLI' AS g, count(*) AS notices FROM app.absence_watch_digest((SELECT id FROM "Schools" WHERE slug = 'bench-absence-watch'), 'KANSLI', current_date - 14, current_date - 1, current_date);
ROLLBACK;
\timing off
