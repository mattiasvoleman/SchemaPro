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
--
-- Everything is taken from ONE school, in a fixed order. Every pick below used
-- to be an unordered `LIMIT 1` or a school-wide one, and the write scenario
-- measured nothing for it: see the roster note further down.

\set ON_ERROR_STOP on

-- A SCHEDULED lesson with a LEAD teacher, for a home class that has pupils.
--
-- The class matters. AttendanceService rejects any batch naming a pupil who is
-- not on the lesson's roster (assertStudentsAreOnRoster), for every role —
-- SCHOOL_ADMIN skips the teacher-assignment check, not that one. This fixture
-- predates the roster check and took "any group" for the lesson and "the
-- school's first three pupils" for the payload; on the seeded school that is
-- class 7B and three pupils of 7A, so every sampled POST was a 403 and the
-- ≤150ms update budget was measured over rejections.
--
-- The assignment is created even though SCHOOL_ADMIN does not need it, so the
-- fixture is also usable with a teacher principal.
WITH ctx AS (
  SELECT s.id AS school,
         (SELECT id FROM "Subjects" WHERE "schoolId" = s.id ORDER BY "createdAt", id LIMIT 1) AS subject,
         (SELECT g.id FROM "StudentGroups" g
          WHERE g."schoolId" = s.id
            AND g.kind = 'CLASS'
            AND (SELECT count(*) FROM "Users" u
                 WHERE u."studentGroupId" = g.id AND u.role = 'STUDENT' AND u."isActive") >= 3
          ORDER BY g.name, g.id
          LIMIT 1) AS grp,
         (SELECT id FROM "Users"
          WHERE "schoolId" = s.id AND role = 'TEACHER' AND "isActive"
          ORDER BY "createdAt", id LIMIT 1) AS teacher
  FROM "Schools" s
  ORDER BY s."createdAt", s.id
  LIMIT 1
), existing AS (
  SELECT cl.id FROM "CalendarLessons" cl, ctx
  WHERE cl."schoolId" = ctx.school AND cl.status = 'SCHEDULED' AND cl."studentGroupId" = ctx.grp
  ORDER BY cl."createdAt", cl.id
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

-- The admin of that same school. An admin of another tenant would read the
-- lesson through RLS as absent and every POST would be a 404 instead.
SELECT 'authId=' || u."authId" FROM "Users" u
WHERE u.role = 'SCHOOL_ADMIN' AND u."isActive"
  AND u."schoolId" = (SELECT id FROM "Schools" ORDER BY "createdAt", id LIMIT 1)
ORDER BY u."createdAt", u.id
LIMIT 1;

SELECT 'academicYearId=' || id FROM "AcademicYears"
WHERE "schoolId" = (SELECT id FROM "Schools" ORDER BY "createdAt", id LIMIT 1)
ORDER BY "createdAt", id
LIMIT 1;

-- Attendance payload: up to three pupils ON THE ROSTER of the school's first
-- scheduled lesson that has any, read the way assertStudentsAreOnRoster reads
-- it — the lesson's own group through home class or teaching-group membership.
-- On the fresh database CI builds that is the lesson created above. On one that
-- already holds lessons it may be an older one, and the pupils are then that
-- lesson's own, so the body never pairs a lesson with somebody else's class.
SELECT 'writeBody=' || json_build_object(
         'calendarLessonId', cl.id,
         'records', COALESCE(
           (SELECT json_agg(json_build_object('studentId', r.id, 'status', 'PRESENT'))
            FROM (
              SELECT u.id FROM "Users" u
              WHERE u."schoolId" = cl."schoolId" AND u.role = 'STUDENT' AND u."isActive"
                AND (
                  u."studentGroupId" = cl."studentGroupId"
                  OR EXISTS (
                    SELECT 1 FROM "StudentGroupMembers" m
                    WHERE m."studentGroupId" = cl."studentGroupId" AND m."studentId" = u.id
                  )
                )
              ORDER BY u."createdAt", u.id
              LIMIT 3
            ) r),
           '[]'::json)
       )::text
FROM "CalendarLessons" cl
WHERE cl.status = 'SCHEDULED'
  AND cl."schoolId" = (SELECT id FROM "Schools" ORDER BY "createdAt", id LIMIT 1)
  AND EXISTS (
    SELECT 1 FROM "Users" u
    WHERE u.role = 'STUDENT' AND u."isActive"
      AND (
        u."studentGroupId" = cl."studentGroupId"
        OR EXISTS (
          SELECT 1 FROM "StudentGroupMembers" m
          WHERE m."studentGroupId" = cl."studentGroupId" AND m."studentId" = u.id
        )
      )
  )
ORDER BY cl."createdAt", cl.id
LIMIT 1;
