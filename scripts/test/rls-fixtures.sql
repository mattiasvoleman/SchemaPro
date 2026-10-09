-- Fixtures for scripts/test/rls-policies.sql. Run as the database OWNER, since
-- it must create rows across two tenants:
--
--   docker compose exec -T db psql -U postgres -d schemapro \
--     -v ON_ERROR_STOP=1 -f scripts/test/rls-fixtures.sql
--
-- Assumes `npm run db:seed` has already created the demo school. Adds a second
-- school plus one user, so the policy tests can prove a principal scoped to the
-- first school cannot see the second. Without a second tenant, every isolation
-- assertion would pass vacuously.
--
-- Idempotent: safe to re-run.

\set ON_ERROR_STOP on

INSERT INTO "Schools" (name, slug, timezone, "updatedAt")
VALUES ('RLS Fixture School', 'rls-fixture-school', 'Europe/Stockholm', now())
ON CONFLICT (slug) DO NOTHING;

-- Users has no unique constraint beyond the primary key, so guard with NOT
-- EXISTS rather than ON CONFLICT to stay idempotent.
INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
SELECT s.id, 'rls-fixture@example.invalid', 'Fixture', 'User', 'TEACHER',
       '00000000-0000-4000-8000-000000000001', true, now()
FROM "Schools" s
WHERE s.slug = 'rls-fixture-school'
  AND NOT EXISTS (
    SELECT 1 FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000001'
  );

-- A PUPIL in the second school. The cross-tenant guardian assertion needs a
-- real child to try to claim; without one it would pass while proving nothing,
-- which is the failure mode every fixture here exists to avoid.
INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
SELECT s.id, 'rls-fixture-pupil@example.invalid', 'Fixture', 'Pupil', 'STUDENT',
       '00000000-0000-4000-8000-000000000002', true, now()
FROM "Schools" s
WHERE s.slug = 'rls-fixture-school'
  AND NOT EXISTS (
    SELECT 1 FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000002'
  );

-- A DEACTIVATED SCHOOL_ADMIN in the FIRST school — the principal the identity
-- helpers must now resolve to nothing. An admin rather than a teacher because
-- an admin is the worst case: before the helpers required `isActive`, a
-- deactivated one kept full read and write access to the school and could set
-- their own `isActive` back to true through `users_admin_all`.
--
-- They belong to the first school on purpose. The assertions also prove the
-- other half — that an ACTIVE admin of that same school still sees this row
-- and can still reactivate it, which is the only way back for a locked-out
-- colleague.
INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
SELECT s.id, 'rls-fixture-inactive@example.invalid', 'Fixture', 'Inactive', 'SCHOOL_ADMIN',
       '00000000-0000-4000-8000-000000000003', false, now()
FROM "Schools" s
WHERE s.slug <> 'rls-fixture-school'
  AND NOT EXISTS (
    SELECT 1 FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000003'
  )
ORDER BY s."createdAt" LIMIT 1;

-- The reactivation assertion flips this row and rolls back, so a completed run
-- leaves it inactive. A run killed mid-transaction would not, and the next run
-- would then assert "an inactive principal sees nothing" against an active
-- user and pass while proving nothing. Repair it rather than assume it.
UPDATE "Users" SET "isActive" = false, "updatedAt" = now()
 WHERE "authId" = '00000000-0000-4000-8000-000000000003' AND "isActive";

-- A GUARDIAN in the FIRST school, linked to one pupil who has a home class.
--
-- Section 7e needs one. The lunch and rast policies join a guardian to their
-- child through Users."studentGroupId" — the home class — and the seed creates
-- no guardian link at all, so without this the guardian arm would be asserted
-- against an empty set and pass while proving nothing.
INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
SELECT s.id, 'rls-fixture-guardian@example.invalid', 'Fixture', 'Guardian', 'GUARDIAN',
       '00000000-0000-4000-8000-000000000004', true, now()
FROM "Schools" s
WHERE s.slug <> 'rls-fixture-school'
  AND NOT EXISTS (
    SELECT 1 FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000004'
  )
ORDER BY s."createdAt" LIMIT 1;

INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId", "createdAt")
SELECT g."schoolId", g.id, c.id, now()
FROM "Users" g
CROSS JOIN LATERAL (
  SELECT u.id FROM "Users" u
  WHERE u."schoolId" = g."schoolId" AND u.role = 'STUDENT'
    AND u."studentGroupId" IS NOT NULL
  ORDER BY u.id LIMIT 1
) c
WHERE g."authId" = '00000000-0000-4000-8000-000000000004'
  AND NOT EXISTS (
    SELECT 1 FROM "GuardianStudents" gs
    WHERE gs."guardianId" = g.id AND gs."studentId" = c.id
  );

-- A room rule in the SECOND school, with its one room, so the tenant half of
-- section 7d counts rows that exist over there rather than a table that
-- happens to be empty. A LOCK rather than a wish because 7d counts locks: a
-- policy that lost its tenant predicate then moves the teacher's count as well
-- as the admin's. The fixture school has no subject or room of its own, so it
-- gets one of each.
INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt")
SELECT s.id, 'RLS Fixture Subject', 'RLSFIX', now()
FROM "Schools" s
WHERE s.slug = 'rls-fixture-school'
ON CONFLICT ("schoolId", code) DO NOTHING;

INSERT INTO "Rooms" ("schoolId", name, code, capacity, "updatedAt")
SELECT s.id, 'RLS Fixture Room', 'RLSFIX', 20, now()
FROM "Schools" s
WHERE s.slug = 'rls-fixture-school'
ON CONFLICT ("schoolId", name) DO NOTHING;

-- RoomPreferences has no unique key (equal locks union, so duplicates are
-- harmless to the solver), hence NOT EXISTS rather than ON CONFLICT.
INSERT INTO "RoomPreferences" ("schoolId", "subjectId", kind, weight, "updatedAt")
SELECT sub."schoolId", sub.id, 'LOCK', 5, now()
FROM "Subjects" sub
JOIN "Schools" s ON s.id = sub."schoolId"
WHERE s.slug = 'rls-fixture-school'
  AND sub.code = 'RLSFIX'
  AND NOT EXISTS (
    SELECT 1 FROM "RoomPreferences" p WHERE p."subjectId" = sub.id
  );

INSERT INTO "RoomPreferenceRooms" ("schoolId", "preferenceId", "roomId")
SELECT p."schoolId", p.id, r.id
FROM "RoomPreferences" p
JOIN "Schools" s ON s.id = p."schoolId"
JOIN "Rooms" r ON r."schoolId" = p."schoolId" AND r.code = 'RLSFIX'
WHERE s.slug = 'rls-fixture-school'
ON CONFLICT ("preferenceId", "roomId") DO NOTHING;

-- A lesson in EACH school, weekly and dated, with a row in every table the
-- SS12000 feeds select through. `/activities` reads MasterLessons with their
-- Subjects, StudentGroups, MasterLessonGroups and MasterLessonStudents;
-- `/calendarEvents` reads CalendarLessons with Subjects, StudentGroups, Rooms,
-- CalendarLessonTeachers, CalendarLessonGroups and CalendarLessonStudents.
--
-- The seed creates no lessons at all. Without these, section 3 would find the
-- service principal's own lesson rows missing for want of rows rather than for
-- want of a policy, and would find none of the other school's because there
-- are none to find.
--
-- The second school has no year or class of its own, so it gets one year and
-- two classes: the lesson's own and an extra one.
INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
SELECT s.id, 'RLS Fixture Year', current_date - 180, current_date + 180, true, now()
FROM "Schools" s
WHERE s.slug = 'rls-fixture-school'
ON CONFLICT ("schoolId", name) DO NOTHING;

INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "updatedAt")
SELECT y."schoolId", y.id, g.name, now()
FROM "AcademicYears" y
JOIN "Schools" s ON s.id = y."schoolId"
CROSS JOIN (VALUES ('RLS Fixture Class'), ('RLS Fixture Extra')) AS g(name)
WHERE s.slug = 'rls-fixture-school' AND y.name = 'RLS Fixture Year'
ON CONFLICT ("schoolId", "academicYearId", name) DO NOTHING;

-- The second school's guardian, linked to that school's pupil, so section 3
-- counts a GuardianStudents row that exists over there. The first school's
-- guardian above is the one sections 7e and 7f act as; this one is never a
-- principal.
INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
SELECT s.id, 'rls-fixture-guardian-b@example.invalid', 'Fixture', 'Guardian B', 'GUARDIAN',
       '00000000-0000-4000-8000-000000000005', true, now()
FROM "Schools" s
WHERE s.slug = 'rls-fixture-school'
  AND NOT EXISTS (
    SELECT 1 FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000005'
  );

INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId", "createdAt")
SELECT g."schoolId", g.id, p.id, now()
FROM "Users" g
JOIN "Users" p ON p."authId" = '00000000-0000-4000-8000-000000000002'
WHERE g."authId" = '00000000-0000-4000-8000-000000000005'
ON CONFLICT ("guardianId", "studentId") DO NOTHING;

-- A PUPIL WITH A CLASS in the SECOND school, so section 26's tenant half
-- counts class history that exists over there: the Users trigger
-- (20261010120000) opens the segment as this row is written. A pupil of its
-- own rather than the cross-tenant guardian assertion's child above, whose
-- classlessness other sections may rely on.
INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt", "studentGroupId")
SELECT s.id, 'rls-fixture-pupil-class@example.invalid', 'Fixture', 'Pupil With Class', 'STUDENT',
       '00000000-0000-4000-8000-000000000007', true, now(), g.id
FROM "Schools" s
JOIN "AcademicYears" y ON y."schoolId" = s.id AND y.name = 'RLS Fixture Year'
JOIN "StudentGroups" g ON g."academicYearId" = y.id AND g.name = 'RLS Fixture Class'
WHERE s.slug = 'rls-fixture-school'
  AND NOT EXISTS (
    SELECT 1 FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000007'
  );

-- A tillgodoräknad dag in the SECOND school, its fixture class scoped and its
-- fixture subject named, so section 23's tenant half counts a credit that
-- exists over there. NOT EXISTS rather than ON CONFLICT: the table has no
-- natural key (a split day is two rows), on purpose.
INSERT INTO "TimplanCredits"
  ("schoolId", "academicYearId", date, minutes, "subjectId", "studentGroupId", name, "updatedAt")
SELECT y."schoolId", y.id, y."startDate" + 30, 300, sub.id, g.id, 'RLS fixture friluftsdag', now()
FROM "AcademicYears" y
JOIN "Schools" s ON s.id = y."schoolId"
JOIN "Subjects" sub ON sub."schoolId" = y."schoolId" AND sub.code = 'RLSFIX'
JOIN "StudentGroups" g ON g."academicYearId" = y.id AND g.name = 'RLS Fixture Class'
WHERE s.slug = 'rls-fixture-school' AND y.name = 'RLS Fixture Year'
  AND NOT EXISTS (
    SELECT 1 FROM "TimplanCredits" c WHERE c."schoolId" = y."schoolId" AND c.name = 'RLS fixture friluftsdag'
  );

-- A policy, a post and a behörighet in the SECOND school, for its fixture
-- teacher in its fixture year and subject, so the tenant half of section 7h
-- counts rows that exist over there rather than a table that happens to be
-- empty — the reason the room lock above exists for 7d. The post is the one
-- that matters: TeacherEmployments is the first table whose teacher arm is
-- narrower than the school, and a tenant predicate it lost would show here
-- before anything the API renders would notice.
INSERT INTO "StaffingPolicies" ("schoolId", "fullTimeTeachingMinutesPerWeek", "updatedAt")
SELECT s.id, 1080, now()
FROM "Schools" s
WHERE s.slug = 'rls-fixture-school'
ON CONFLICT ("schoolId") DO NOTHING;

INSERT INTO "TeacherEmployments"
  ("schoolId", "userId", "academicYearId", "employmentPercent", "signature", "updatedAt")
SELECT u."schoolId", u.id, y.id, 80, 'RLS', now()
FROM "Users" u
JOIN "AcademicYears" y ON y."schoolId" = u."schoolId" AND y.name = 'RLS Fixture Year'
WHERE u."authId" = '00000000-0000-4000-8000-000000000001'
ON CONFLICT ("schoolId", "userId", "academicYearId") DO NOTHING;

INSERT INTO "TeacherSubjectQualifications"
  ("schoolId", "userId", "subjectId", "minGradeLevel", "maxGradeLevel", kind, "updatedAt")
SELECT u."schoolId", u.id, sub.id, 1, 9, 'LEGITIMATION', now()
FROM "Users" u
JOIN "Subjects" sub ON sub."schoolId" = u."schoolId" AND sub.code = 'RLSFIX'
WHERE u."authId" = '00000000-0000-4000-8000-000000000001'
ON CONFLICT ("schoolId", "userId", "subjectId") DO NOTHING;

-- An uppdrag in the SECOND school with its fixed slot: the fixture teacher's
-- APT on Tuesdays, an UNAVAILABLE TEACHER constraint, and a duty linked to it.
-- Section 17 needs both. The duty is what the tenant half counts (school A's
-- admin, teacher and service principal see none of it; school B's admin sees
-- it), and the constraint is what an admin of school A points a duty of their
-- own at, stamped with their own school — the shape only the composite key
-- refuses, and which the link trigger must leave to that key rather than
-- answer about school B. AvailabilityConstraints has no unique key, so NOT
-- EXISTS on the reason keeps this idempotent.
INSERT INTO "AvailabilityConstraints"
  ("schoolId", "resourceType", "userId", "dayOfWeek", "startTime", "endTime", type, reason, "updatedAt")
SELECT u."schoolId", 'TEACHER', u.id, 2, '15:00', '17:00', 'UNAVAILABLE', 'RLS fixture: APT', now()
FROM "Users" u
WHERE u."authId" = '00000000-0000-4000-8000-000000000001'
  AND NOT EXISTS (
    SELECT 1 FROM "AvailabilityConstraints" c
     WHERE c."schoolId" = u."schoolId" AND c.reason = 'RLS fixture: APT'
  );

INSERT INTO "TeacherDuties"
  ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "blockedConstraintId", "updatedAt")
SELECT u."schoolId", u.id, y.id, 'APT_KONFERENS', 'RLS fixture APT', 120, c.id, now()
FROM "Users" u
JOIN "AcademicYears" y ON y."schoolId" = u."schoolId" AND y.name = 'RLS Fixture Year'
JOIN "AvailabilityConstraints" c ON c."schoolId" = u."schoolId" AND c.reason = 'RLS fixture: APT'
WHERE u."authId" = '00000000-0000-4000-8000-000000000001'
  AND NOT EXISTS (
    SELECT 1 FROM "TeacherDuties" d
     WHERE d."schoolId" = u."schoolId" AND d.label = 'RLS fixture APT'
  );

-- A SCHOOL_ADMIN in the SECOND school, and two local timplans there — a DRAFT
-- and a DECIDED one, each with an entry — so section 16 can ask both halves of
-- tenant isolation with rows that exist: school A's admin sees none of these,
-- and this admin, acting in their own school, sees these and none of A's. An
-- admin rather than the fixture teacher because admin_all is the widest arm on
-- the two tables; a tenant predicate it lost is the one that would leak most.
INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
SELECT s.id, 'rls-fixture-admin-b@example.invalid', 'Fixture', 'Admin B', 'SCHOOL_ADMIN',
       '00000000-0000-4000-8000-000000000006', true, now()
FROM "Schools" s
WHERE s.slug = 'rls-fixture-school'
  AND NOT EXISTS (
    SELECT 1 FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000006'
  );

INSERT INTO "LocalTimplans" ("schoolId", name, "schoolForm", "nationalTimplanVersionId", "updatedAt")
SELECT s.id, p.name, 'GRUNDSKOLA', v.id, now()
FROM "Schools" s
JOIN "NationalTimplanVersions" v ON v.code = 'SFS2023:945/B1'
CROSS JOIN (VALUES ('RLS Fixture Utkast'), ('RLS Fixture Beslutad')) AS p(name)
WHERE s.slug = 'rls-fixture-school'
ON CONFLICT ("schoolId", name) DO NOTHING;

-- Entries go in while the plan is a draft — the entries trigger refuses them
-- once it is decided, so a re-run must not try (the BEFORE INSERT trigger
-- fires before ON CONFLICT can skip the row).
INSERT INTO "LocalTimplanEntries" ("schoolId", "localTimplanId", "subjectId", "gradeLevel", "minutesPerWeek")
SELECT p."schoolId", p.id, sub.id, 7, 120
FROM "LocalTimplans" p
JOIN "Schools" s ON s.id = p."schoolId"
JOIN "Subjects" sub ON sub."schoolId" = p."schoolId" AND sub.code = 'RLSFIX'
WHERE s.slug = 'rls-fixture-school' AND p.status = 'DRAFT'
ON CONFLICT ("localTimplanId", "subjectId", "gradeLevel") DO NOTHING;

UPDATE "LocalTimplans" p
   SET status = 'DECIDED', "decidedAt" = now(), "decidedByUserId" = u.id,
       "decisionNote" = 'RLS fixture: beslutad', "updatedAt" = now()
  FROM "Users" u
 WHERE u."authId" = '00000000-0000-4000-8000-000000000006'
   AND p."schoolId" = u."schoolId"
   AND p.name = 'RLS Fixture Beslutad'
   AND p.status = 'DRAFT';

-- The second school's year follows both of its plans: årskurs 7 the DECIDED
-- one, årskurs 8 the DRAFT. Section 18 asserts that school A sees neither
-- attachment and that school B's admin sees both; with nothing planted here
-- each half would pass while proving nothing. One of each status, for the
-- reason the plans above have one: a family arm that ignored the tenant would
-- show the decided one, an admin arm that ignored it would show both.
INSERT INTO "AcademicYearTimplans" ("schoolId", "academicYearId", "gradeLevel", "localTimplanId", "updatedAt")
SELECT p."schoolId", y.id, g.grade, p.id, now()
FROM "LocalTimplans" p
JOIN "Schools" s ON s.id = p."schoolId"
JOIN "AcademicYears" y ON y."schoolId" = p."schoolId" AND y.name = 'RLS Fixture Year'
JOIN (VALUES ('RLS Fixture Beslutad', 7), ('RLS Fixture Utkast', 8)) AS g(name, grade)
  ON g.name = p.name
WHERE s.slug = 'rls-fixture-school'
ON CONFLICT ("academicYearId", "gradeLevel") DO NOTHING;

-- What each school's lesson is made of, and the lessons themselves once they
-- exist. A view rather than a CTE because every statement below reads it
-- afresh, so the link rows find the lessons the statements before them
-- inserted. The weekly lesson sits on a Monday at 06:10, an hour no seeded or
-- generated timetable uses, and that is what it is recognised by.
--
-- Every ingredient is joined LEFT, so a school that lacks one still has a row
-- here and the check below can name what is missing.
CREATE OR REPLACE TEMP VIEW rls_fixture_lesson AS
SELECT s.id AS "schoolId", y.id AS year_id, sub.id AS subject_id, room.id AS room_id,
       home.id AS group_id, extra.id AS extra_group_id, teacher.id AS teacher_id,
       pupil.id AS pupil_id,
       y."startDate" + (8 - extract(isodow FROM y."startDate")::int) % 7 AS lesson_date,
       ml.id AS master_lesson_id, cl.id AS calendar_lesson_id
FROM "Schools" s
LEFT JOIN LATERAL (
  SELECT id, "startDate" FROM "AcademicYears"
  WHERE "schoolId" = s.id AND "isActive" ORDER BY "createdAt" LIMIT 1
) y ON true
LEFT JOIN LATERAL (
  SELECT id FROM "Subjects" WHERE "schoolId" = s.id ORDER BY code LIMIT 1
) sub ON true
LEFT JOIN LATERAL (
  SELECT id FROM "Rooms" WHERE "schoolId" = s.id ORDER BY name LIMIT 1
) room ON true
LEFT JOIN LATERAL (
  SELECT id FROM "StudentGroups"
  WHERE "schoolId" = s.id AND "academicYearId" = y.id AND kind = 'CLASS'
  ORDER BY name LIMIT 1
) home ON true
LEFT JOIN LATERAL (
  SELECT id FROM "StudentGroups"
  WHERE "schoolId" = s.id AND "academicYearId" = y.id AND kind = 'CLASS'
  ORDER BY name OFFSET 1 LIMIT 1
) extra ON true
LEFT JOIN LATERAL (
  SELECT id FROM "Users"
  WHERE "schoolId" = s.id AND role = 'TEACHER' AND "isActive" ORDER BY email LIMIT 1
) teacher ON true
LEFT JOIN LATERAL (
  SELECT id FROM "Users"
  WHERE "schoolId" = s.id AND role = 'STUDENT' AND "isActive" ORDER BY email LIMIT 1
) pupil ON true
LEFT JOIN LATERAL (
  SELECT id FROM "MasterLessons"
  WHERE "schoolId" = s.id AND "dayOfWeek" = 1 AND "startTime" = '06:10' LIMIT 1
) ml ON true
LEFT JOIN LATERAL (
  SELECT id FROM "CalendarLessons" WHERE "masterLessonId" = ml.id LIMIT 1
) cl ON true
WHERE s.slug = 'rls-fixture-school'
   OR s.id = (SELECT id FROM "Schools" WHERE slug <> 'rls-fixture-school'
              ORDER BY "createdAt" LIMIT 1);

-- A school the view cannot build a lesson for would otherwise get none, and
-- section 3 would then report the service principal's zero there as a policy
-- that cannot read, which sends whoever reads the failure to the wrong file.
DO $$
DECLARE
  f       record;
  schools int;
  missing text;
BEGIN
  SELECT count(*) INTO schools FROM rls_fixture_lesson;
  IF schools <> 2 THEN
    RAISE EXCEPTION
      'rls-fixtures: found % school(s) for the lesson fixture, expected the seeded school and rls-fixture-school', schools;
  END IF;

  FOR f IN SELECT * FROM rls_fixture_lesson LOOP
    missing := concat_ws(', ',
      CASE WHEN f.year_id IS NULL THEN 'an active academic year' END,
      CASE WHEN f.subject_id IS NULL THEN 'a subject' END,
      CASE WHEN f.room_id IS NULL THEN 'a room' END,
      CASE WHEN f.extra_group_id IS NULL THEN 'two classes in its active year' END,
      CASE WHEN f.teacher_id IS NULL THEN 'an active teacher' END,
      CASE WHEN f.pupil_id IS NULL THEN 'an active pupil' END);
    IF missing <> '' THEN
      RAISE EXCEPTION
        'rls-fixtures: school % lacks %, so the lesson fixture cannot plant a lesson there',
        f."schoolId", missing;
    END IF;
  END LOOP;
END $$;

INSERT INTO "MasterLessons"
  ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "roomId",
   "dayOfWeek", "startTime", "endTime", "updatedAt")
SELECT "schoolId", year_id, subject_id, group_id, teacher_id, room_id,
       1, '06:10', '06:50', now()
FROM rls_fixture_lesson
WHERE master_lesson_id IS NULL;

INSERT INTO "MasterLessonGroups" ("schoolId", "masterLessonId", "studentGroupId")
SELECT "schoolId", master_lesson_id, extra_group_id FROM rls_fixture_lesson
ON CONFLICT ("masterLessonId", "studentGroupId") DO NOTHING;

INSERT INTO "MasterLessonStudents" ("schoolId", "masterLessonId", "studentId")
SELECT "schoolId", master_lesson_id, pupil_id FROM rls_fixture_lesson
ON CONFLICT ("masterLessonId", "studentId") DO NOTHING;

INSERT INTO "CalendarLessons"
  ("schoolId", "masterLessonId", "subjectId", "studentGroupId", "roomId",
   date, "startsAt", "endsAt", "updatedAt")
SELECT "schoolId", master_lesson_id, subject_id, group_id, room_id, lesson_date,
       (lesson_date + time '06:10') AT TIME ZONE 'Europe/Stockholm',
       (lesson_date + time '06:50') AT TIME ZONE 'Europe/Stockholm', now()
FROM rls_fixture_lesson
WHERE calendar_lesson_id IS NULL;

INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId")
SELECT "schoolId", calendar_lesson_id, teacher_id FROM rls_fixture_lesson
ON CONFLICT ("calendarLessonId", "teacherId") DO NOTHING;

INSERT INTO "CalendarLessonGroups" ("schoolId", "calendarLessonId", "studentGroupId")
SELECT "schoolId", calendar_lesson_id, extra_group_id FROM rls_fixture_lesson
ON CONFLICT ("calendarLessonId", "studentGroupId") DO NOTHING;

INSERT INTO "CalendarLessonStudents" ("schoolId", "calendarLessonId", "studentId")
SELECT "schoolId", calendar_lesson_id, pupil_id FROM rls_fixture_lesson
ON CONFLICT ("calendarLessonId", "studentId") DO NOTHING;

-- One link row of each kind filed under the SECOND school but attached to the
-- FIRST school's lessons: the second school's extra class, pupil and teacher.
-- Every link table references its lesson by id alone, so such a row can be
-- written. The service-principal policies answer by the row's own school, so
-- the first school's principal must not see these, and section 3 counts them
-- in its "none of another school's" half. A policy that asked the lesson's
-- school instead would show them there.
CREATE OR REPLACE TEMP VIEW rls_fixture_crossed AS
SELECT b."schoolId", a.master_lesson_id, a.calendar_lesson_id,
       b.extra_group_id, b.teacher_id, b.pupil_id
FROM rls_fixture_lesson a
JOIN rls_fixture_lesson b ON b."schoolId" <> a."schoolId"
JOIN "Schools" s ON s.id = b."schoolId"
WHERE s.slug = 'rls-fixture-school';

INSERT INTO "MasterLessonGroups" ("schoolId", "masterLessonId", "studentGroupId")
SELECT "schoolId", master_lesson_id, extra_group_id FROM rls_fixture_crossed
ON CONFLICT ("masterLessonId", "studentGroupId") DO NOTHING;

INSERT INTO "MasterLessonStudents" ("schoolId", "masterLessonId", "studentId")
SELECT "schoolId", master_lesson_id, pupil_id FROM rls_fixture_crossed
ON CONFLICT ("masterLessonId", "studentId") DO NOTHING;

INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId")
SELECT "schoolId", calendar_lesson_id, teacher_id FROM rls_fixture_crossed
ON CONFLICT ("calendarLessonId", "teacherId") DO NOTHING;

INSERT INTO "CalendarLessonGroups" ("schoolId", "calendarLessonId", "studentGroupId")
SELECT "schoolId", calendar_lesson_id, extra_group_id FROM rls_fixture_crossed
ON CONFLICT ("calendarLessonId", "studentGroupId") DO NOTHING;

INSERT INTO "CalendarLessonStudents" ("schoolId", "calendarLessonId", "studentId")
SELECT "schoolId", calendar_lesson_id, pupil_id FROM rls_fixture_crossed
ON CONFLICT ("calendarLessonId", "studentId") DO NOTHING;

-- An active key for the FIRST school, so the key-lookup assertions have
-- something to find, and a revoked one so revocation can be asserted.
INSERT INTO "IntegrationApiKeys" ("schoolId", name, "keyHash", "createdAt")
SELECT id, 'rls-fixture-active',
       encode(sha256('rls-fixture-active-key'::bytea), 'hex'), now()
FROM "Schools" WHERE slug <> 'rls-fixture-school' ORDER BY "createdAt" LIMIT 1
ON CONFLICT ("keyHash") DO NOTHING;

INSERT INTO "IntegrationApiKeys" ("schoolId", name, "keyHash", "createdAt", "revokedAt")
SELECT id, 'rls-fixture-revoked',
       encode(sha256('rls-fixture-revoked-key'::bytea), 'hex'), now(), now()
FROM "Schools" WHERE slug <> 'rls-fixture-school' ORDER BY "createdAt" LIMIT 1
ON CONFLICT ("keyHash") DO NOTHING;

-- The policy tests run as the unprivileged role, which by design cannot see
-- any school until a principal is set — so it cannot discover these ids for
-- itself. The runner reads them here (as owner) and passes them in with -v.
\pset tuples_only on
\pset format unaligned
SELECT id FROM "Schools" WHERE slug <> 'rls-fixture-school' ORDER BY "createdAt" LIMIT 1;
