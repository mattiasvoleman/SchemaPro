-- Fixtures for the API latency benchmark. Run as the database OWNER:
--
--   docker compose exec -T db psql -U postgres -d schemapro \
--     -v ON_ERROR_STOP=1 -tA -f scripts/bench/fixtures.sql
--
-- Emits three `key=value` lines for the caller to capture:
--
--   authId=…          an active SCHOOL_ADMIN  → mint-token.mjs --sub
--   academicYearId=…                          → api-latency.mjs --academic-year
--   writeBody={…}     JSON attendance payload → api-latency.mjs --write-body
--
-- Keyed rather than positional because psql prints a command tag ("INSERT 0 1")
-- for the data-modifying statement above, which silently shifts line numbers
-- and makes the caller mint a token for a subject named "INSERT 0 0".
--
-- Why a fixture is needed at all: `npm run db:seed` stops before schedule
-- generation, so the database has teachers, students and requirements but zero
-- CalendarLessons. Without one there is nothing to report attendance against,
-- the write scenario is skipped, and the ≤150ms update budget silently goes
-- unmeasured while the job still reports success.
--
-- Attendance reporting is an upsert, so the benchmark can hit this same lesson
-- repeatedly without accumulating rows or tripping a constraint.
--
-- Idempotent: re-running reuses the lesson created by a previous run.

\set ON_ERROR_STOP on

-- A SCHEDULED lesson with a LEAD teacher. SCHOOL_ADMIN bypasses the
-- teacher-assignment check in AttendanceService, but the assignment is created
-- anyway so the fixture is also usable with a teacher principal.
WITH ctx AS (
  SELECT s.id AS school,
         (SELECT id FROM "Subjects"       WHERE "schoolId" = s.id LIMIT 1) AS subject,
         (SELECT id FROM "StudentGroups"  WHERE "schoolId" = s.id LIMIT 1) AS grp,
         (SELECT id FROM "Users"          WHERE "schoolId" = s.id AND role = 'TEACHER' AND "isActive" LIMIT 1) AS teacher
  FROM "Schools" s
  ORDER BY s."createdAt"
  LIMIT 1
), existing AS (
  SELECT cl.id FROM "CalendarLessons" cl, ctx
  WHERE cl."schoolId" = ctx.school AND cl.status = 'SCHEDULED'
  LIMIT 1
), created AS (
  INSERT INTO "CalendarLessons"
    ("schoolId","subjectId","studentGroupId","date","startsAt","endsAt","updatedAt")
  SELECT ctx.school, ctx.subject, ctx.grp,
         CURRENT_DATE,
         CURRENT_DATE + TIME '08:00',
         CURRENT_DATE + TIME '09:00',
         now()
  FROM ctx
  WHERE NOT EXISTS (SELECT 1 FROM existing)
    AND ctx.subject IS NOT NULL AND ctx.grp IS NOT NULL
  RETURNING id, "schoolId"
), lesson AS (
  SELECT id FROM existing
  UNION ALL
  SELECT id FROM created
)
INSERT INTO "CalendarLessonTeachers" ("calendarLessonId","schoolId","teacherId","role")
SELECT lesson.id, ctx.school, ctx.teacher, 'LEAD'
FROM lesson, ctx
WHERE ctx.teacher IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "CalendarLessonTeachers" t
    WHERE t."calendarLessonId" = lesson.id AND t."teacherId" = ctx.teacher
  );

SELECT 'authId=' || "authId" FROM "Users"
WHERE role = 'SCHOOL_ADMIN' AND "isActive"
ORDER BY "createdAt"
LIMIT 1;

SELECT 'academicYearId=' || id FROM "AcademicYears" ORDER BY "createdAt" LIMIT 1;

-- Attendance payload for the lesson above, with up to three of its students.
SELECT 'writeBody=' || json_build_object(
         'calendarLessonId', cl.id,
         'records', COALESCE(
           (SELECT json_agg(json_build_object('studentId', u.id, 'status', 'PRESENT'))
            FROM (
              SELECT id FROM "Users"
              WHERE "schoolId" = cl."schoolId" AND role = 'STUDENT' AND "isActive"
              ORDER BY "createdAt"
              LIMIT 3
            ) u),
           '[]'::json)
       )::text
FROM "CalendarLessons" cl
WHERE cl.status = 'SCHEDULED'
ORDER BY cl."createdAt"
LIMIT 1;
