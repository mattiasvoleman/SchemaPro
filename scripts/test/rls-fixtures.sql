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

-- A published "Undervisningstid" statement in the SECOND school, about its
-- pupil with a class, so section 26d's tenant half counts a statement and a
-- publication that exist over there. The publisher is NULL (the column's
-- SET NULL state), which the CHECKs and keys allow.
INSERT INTO "TimplanStatementPublications" ("schoolId", "academicYearId", "asOfDate", "pupils")
SELECT y."schoolId", y.id, current_date, 1
FROM "AcademicYears" y
JOIN "Schools" s ON s.id = y."schoolId"
WHERE s.slug = 'rls-fixture-school' AND y.name = 'RLS Fixture Year'
ON CONFLICT ("schoolId") DO NOTHING;

INSERT INTO "TimplanStatements"
  ("schoolId", "publicationId", "academicYearId", "asOfDate", "studentId", stage, "subjectCode", "versionCode",
   "distributionPublished", "gradesFrom", "gradesTo", "nationalHours", "plannedHours", "outcomeHours", "projectedHours",
   status, "projectedStatus", complete)
SELECT p."schoolId", p.id, p."academicYearId", p."asOfDate", u.id, 'HOG', 'MA', 'SFS2023:945/B1', true, 7, 9, 400, 403, 100, 403,
       'UNRECORDED', 'UNRECORDED', false
FROM "TimplanStatementPublications" p
JOIN "Schools" s ON s.id = p."schoolId"
JOIN "Users" u ON u."authId" = '00000000-0000-4000-8000-000000000007'
WHERE s.slug = 'rls-fixture-school'
ON CONFLICT ("publicationId", "studentId", stage, "subjectCode") DO NOTHING;

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
-- APT on Tuesdays, an UNAVAILABLE TEACHER constraint, and a duty linked to it
-- through a TeacherDutySlots row (20261017090000). Sections 17 and 40 need them. The duty is what the tenant half counts (school A's
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
  ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "updatedAt")
SELECT u."schoolId", u.id, y.id, 'APT_KONFERENS', 'RLS fixture APT', 120, now()
FROM "Users" u
JOIN "AcademicYears" y ON y."schoolId" = u."schoolId" AND y.name = 'RLS Fixture Year'
WHERE u."authId" = '00000000-0000-4000-8000-000000000001'
  AND NOT EXISTS (
    SELECT 1 FROM "TeacherDuties" d
     WHERE d."schoolId" = u."schoolId" AND d.label = 'RLS fixture APT'
  );

-- The link. A database at an older suite's fixtures already has it: the
-- one-time column it was written through was backfilled (20261017090000).
INSERT INTO "TeacherDutySlots" ("schoolId", "teacherDutyId", "availabilityConstraintId")
SELECT d."schoolId", d.id, c.id
FROM "TeacherDuties" d
JOIN "AvailabilityConstraints" c ON c."schoolId" = d."schoolId" AND c.reason = 'RLS fixture: APT'
WHERE d.label = 'RLS fixture APT'
  AND NOT EXISTS (
    SELECT 1 FROM "TeacherDutySlots" s
     WHERE s."schoolId" = d."schoolId" AND s."availabilityConstraintId" = c.id
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

-- A THIRD school for gallring (sections 80 to 89), planted once. Its own
-- school, because a purge deletes rows and sections 83 and 84 must count
-- exactly what goes; nothing of school A or B may move. Every date is
-- relative to today in Europe/Stockholm, so the cutoffs below hold whenever
-- the suite runs:
--
--   ATTENDANCE       12 months   lessons 13 months ago (go), on the cutoff day
--                                and 11 months ago (stay)
--   ABSENCE_REPORTS   6 months   reports 7 months ago (go), 5 months ago (stay)
--   LEAVE_REQUESTS   12 months   ended 13 months ago (goes); ended 11 months
--                                ago, and one that began 14 months ago but
--                                ended 11 months ago (stay)
--   NOTIFICATIONS    no decision a notice five years old (stays)
--   CHANGE_LOGS      24 months   schedule logs 25 and 23 months ago; the
--                                tjänst history of 2019/20 (goes) and of this
--                                läsår (stays); guardian unlinks 25 months
--                                and one month ago
--   ABSENCE_REASONS  12 months   absences ended 13 months ago (reason goes,
--                                cover stays) and 11 months ago (stays)
--   DEPARTED_PEOPLE  12 months   a pupil deactivated two years ago (goes),
--                                one deactivated a month ago (stays), a
--                                teacher two years ago with a tjänst only in
--                                2019/20 (goes) and one two years ago with a
--                                tjänst this läsår (held for SCB)
--
-- The decisions are dated two days back, past the 24-hour wait, with the
-- stamping trigger off for those inserts only; the history dates and the
-- deactivation dates likewise. Nothing else here goes past a trigger.
DO $$
DECLARE
  g uuid;
  today date := (now() AT TIME ZONE 'Europe/Stockholm')::date;
  y_old uuid; y_prev uuid; y_cur uuid;
  grp uuid; sub uuid; reason uuid;
  admin uuid; teacher uuid; pupil uuid; guardian uuid;
  pupil_gone uuid; pupil_recent uuid; teacher_gone uuid; teacher_scb uuid;
  l_old uuid; l_edge uuid; l_new uuid;
  a_old uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM "Schools" WHERE slug = 'rls-gallring-school') THEN
    RETURN;
  END IF;
  INSERT INTO "Schools" (name, slug, timezone, "updatedAt")
  VALUES ('RLS Gallring School', 'rls-gallring-school', 'Europe/Stockholm', now())
  RETURNING id INTO g;

  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
  VALUES (g, 'Gallring 2019/20', '2019-08-01', '2020-06-30', false, now()) RETURNING id INTO y_old;
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
  VALUES (g, 'Gallring förra', today - interval '15 months', today - interval '62 days', false, now()) RETURNING id INTO y_prev;
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
  VALUES (g, 'Gallring i år', today - 30, today + 300, true, now()) RETURNING id INTO y_cur;

  INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES (g, 'Gallringsämne', 'GAL', now()) RETURNING id INTO sub;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "updatedAt") VALUES (g, y_prev, 'G7A', now()) RETURNING id INTO grp;

  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt") VALUES
    (g, 'gallring-admin@example.invalid', 'Gallring', 'Admin', 'SCHOOL_ADMIN', '00000000-0000-4000-8000-000000000081', true, now())
    RETURNING id INTO admin;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt") VALUES
    (g, 'gallring-teacher@example.invalid', 'Gallring', 'Lärare', 'TEACHER', '00000000-0000-4000-8000-000000000082', true, now())
    RETURNING id INTO teacher;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt") VALUES
    (g, 'gallring-pupil@example.invalid', 'Gallring', 'Elev', 'STUDENT', '00000000-0000-4000-8000-000000000083', true, now())
    RETURNING id INTO pupil;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt") VALUES
    (g, 'gallring-guardian@example.invalid', 'Gallring', 'Vårdnadshavare', 'GUARDIAN', '00000000-0000-4000-8000-000000000084', true, now())
    RETURNING id INTO guardian;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "invitedAt", "phone", "ss12000Id", "updatedAt") VALUES
    (g, 'gallring-gone@example.invalid', 'Slutad', 'Elevsson', 'STUDENT', '00000000-0000-4000-8000-000000000085', false, now(), '070-0000000', NULL, now())
    RETURNING id INTO pupil_gone;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt") VALUES
    (g, 'gallring-recent@example.invalid', 'Nyss', 'Slutad', 'STUDENT', '00000000-0000-4000-8000-000000000086', false, now())
    RETURNING id INTO pupil_recent;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt") VALUES
    (g, 'gallring-teacher-gone@example.invalid', 'Gammal', 'Lärare', 'TEACHER', '00000000-0000-4000-8000-000000000087', true, now())
    RETURNING id INTO teacher_gone;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt") VALUES
    (g, 'gallring-teacher-scb@example.invalid', 'Höstens', 'Lärare', 'TEACHER', '00000000-0000-4000-8000-000000000088', true, now())
    RETURNING id INTO teacher_scb;

  -- Tjänster: 2019/20 for the teacher and the departed teacher (whose
  -- signature and note pseudonymisation clears), this läsår for the teacher
  -- and the one SCB holds. Written while both are active; the log trigger
  -- versions each.
  INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", signature, note, "updatedAt") VALUES
    (g, teacher, y_old, 100, 'GLÄ', NULL, now()),
    (g, teacher_gone, y_old, 80, 'GAL', 'Gallring: anteckning', now()),
    (g, teacher, y_cur, 100, 'GLÄ', NULL, now()),
    (g, teacher_scb, y_cur, 50, 'HÖL', NULL, now());
  UPDATE "Users" SET "isActive" = false, "updatedAt" = now() WHERE id IN (teacher_gone, teacher_scb);

  -- An SS12000 id for the departed pupil, written as the school's admin, the
  -- only writer the guard allows: pseudonymisation must clear it.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000081')::text, true);
  UPDATE "Users" SET "ss12000Id" = gen_random_uuid() WHERE id = pupil_gone;
  PERFORM set_config('request.jwt.claims', '', true);

  ALTER TABLE "Users" DISABLE TRIGGER "Users_deactivation_is_dated_on_update";
  UPDATE "Users" SET "deactivatedAt" = now() - interval '2 years' WHERE id IN (pupil_gone, teacher_gone, teacher_scb);
  UPDATE "Users" SET "deactivatedAt" = now() - interval '1 month' WHERE id = pupil_recent;
  ALTER TABLE "Users" ENABLE TRIGGER "Users_deactivation_is_dated_on_update";

  -- The departed pupil's guardian link, device, opt-out and own notice.
  INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId") VALUES (g, guardian, pupil_gone), (g, guardian, pupil);
  INSERT INTO "DevicePushTokens" ("schoolId", "userId", token, platform) VALUES (g, pupil_gone, 'ExponentPushToken[gallringgone01]', 'IOS');
  INSERT INTO "NotificationOptOuts" ("userId", "schoolId", type) VALUES (pupil_gone, g, 'SCHEDULE_CHANGED');
  INSERT INTO "Notifications" ("schoolId", "userId", type, "createdAt") VALUES (g, pupil_gone, 'SCHEDULE_CHANGED', now());
  -- NOTIFICATIONS has no decision: this one is five years old and stays.
  INSERT INTO "Notifications" ("schoolId", "userId", type, "createdAt") VALUES (g, pupil, 'SCHEDULE_CHANGED', now() - interval '5 years');

  -- Lessons and attendance.
  INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", "updatedAt")
  VALUES (g, sub, grp, today - interval '13 months', (today - interval '13 months')::date + time '06:10', (today - interval '13 months')::date + time '06:50', now())
  RETURNING id INTO l_old;
  INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", "updatedAt")
  VALUES (g, sub, grp, today - interval '12 months', (today - interval '12 months')::date + time '06:10', (today - interval '12 months')::date + time '06:50', now())
  RETURNING id INTO l_edge;
  INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", "updatedAt")
  VALUES (g, sub, grp, today - interval '11 months', (today - interval '11 months')::date + time '06:10', (today - interval '11 months')::date + time '06:50', now())
  RETURNING id INTO l_new;
  INSERT INTO "AttendanceRecords" ("schoolId", "calendarLessonId", "studentId", status, "updatedAt") VALUES
    (g, l_old, pupil, 'PRESENT', now()), (g, l_old, pupil_gone, 'ABSENT', now()),
    (g, l_edge, pupil, 'PRESENT', now()), (g, l_new, pupil, 'PRESENT', now());

  INSERT INTO "AbsenceReports" ("schoolId", "studentId", "reportedById", date) VALUES
    (g, pupil, guardian, today - interval '7 months'), (g, pupil, guardian, today - interval '5 months');

  INSERT INTO "LeaveRequests" ("schoolId", "studentId", "requestedById", "startDate", "endDate", reason) VALUES
    (g, pupil, guardian, today - interval '14 months', today - interval '13 months', 'Gallring: gammal'),
    (g, pupil, guardian, today - interval '14 months', today - interval '11 months', 'Gallring: lång'),
    (g, pupil, guardian, today - interval '11 months', today - interval '11 months', 'Gallring: ny');

  INSERT INTO "ScheduleChangeLogs" ("schoolId", "academicYearId", action, "createdAt") VALUES
    (g, y_prev, 'UPDATE', now() - interval '25 months'), (g, y_prev, 'UPDATE', now() - interval '23 months');

  ALTER TABLE "GuardianStudentHistory" DISABLE TRIGGER "GuardianStudentHistory_written_by_trigger";
  INSERT INTO "GuardianStudentHistory" ("schoolId", "guardianId", "studentId", origin, "linkedAt", "unlinkedAt") VALUES
    (g, guardian, pupil, 'MANUAL', now() - interval '30 months', now() - interval '25 months'),
    (g, guardian, pupil, 'MANUAL', now() - interval '3 months', now() - interval '1 month');
  ALTER TABLE "GuardianStudentHistory" ENABLE TRIGGER "GuardianStudentHistory_written_by_trigger";

  INSERT INTO "TeacherAbsenceReasons" ("schoolId", builtin) VALUES (g, 'SICK') RETURNING id INTO reason;
  INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt", "reasonId") VALUES
    (g, teacher, now() - interval '13 months' - interval '2 days', now() - interval '13 months', reason)
    RETURNING id INTO a_old;
  INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt", "reasonId") VALUES
    (g, teacher, now() - interval '11 months' - interval '2 days', now() - interval '11 months', reason);
  INSERT INTO "TeacherAbsenceCovers" ("schoolId", "absenceId", "calendarLessonId", "absentTeacherId", decision) VALUES
    (g, a_old, l_old, teacher, 'CANCELLED');

  ALTER TABLE "RetentionDecisions" DISABLE TRIGGER "RetentionDecisions_stamped";
  INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision, months, reference, "decidedById", "decidedAt") VALUES
    (g, 'ATTENDANCE', 'PURGE_AFTER', 12, 'DHP 1.2', admin, now() - interval '2 days'),
    (g, 'ABSENCE_REPORTS', 'PURGE_AFTER', 6, NULL, admin, now() - interval '2 days'),
    (g, 'LEAVE_REQUESTS', 'PURGE_AFTER', 12, NULL, admin, now() - interval '2 days'),
    (g, 'CHANGE_LOGS', 'PURGE_AFTER', 24, NULL, admin, now() - interval '2 days'),
    (g, 'ABSENCE_REASONS', 'PURGE_AFTER', 12, NULL, admin, now() - interval '2 days'),
    (g, 'DEPARTED_PEOPLE', 'PURGE_AFTER', 12, NULL, admin, now() - interval '2 days');
  ALTER TABLE "RetentionDecisions" ENABLE TRIGGER "RetentionDecisions_stamped";
END $$;

-- Old rows of every kind in the SECOND school, which has decided nothing:
-- sections 83 and 86 run the gallring school's night and assert that none of
-- these moves. Without them a purge that forgot its school would pass, since
-- the seeded school has nothing that old. Planted once.
DO $$
DECLARE
  b uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-fixture-school');
  teacher uuid := (SELECT id FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000001');
  pupil uuid := (SELECT id FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000002');
  y uuid; grp uuid; sub uuid; lesson uuid; reason uuid; gone uuid;
BEGIN
  IF b IS NULL OR teacher IS NULL OR pupil IS NULL THEN
    RAISE EXCEPTION 'rls-fixtures: the second school lacks its teacher or pupil for the old rows';
  END IF;
  IF EXISTS (SELECT 1 FROM "AcademicYears" WHERE "schoolId" = b AND name = 'RLS Fixture 2019/20') THEN
    RETURN;
  END IF;
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
  VALUES (b, 'RLS Fixture 2019/20', '2019-08-01', '2020-06-30', false, now()) RETURNING id INTO y;
  SELECT id INTO sub FROM "Subjects" WHERE "schoolId" = b ORDER BY code LIMIT 1;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "updatedAt") VALUES (b, y, 'RLS 2019', now()) RETURNING id INTO grp;
  INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", "updatedAt")
  VALUES (b, teacher, y, 100, now());
  INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", "updatedAt")
  VALUES (b, sub, grp, '2020-01-15', '2020-01-15 07:10+00', '2020-01-15 07:50+00', now()) RETURNING id INTO lesson;
  INSERT INTO "AttendanceRecords" ("schoolId", "calendarLessonId", "studentId", status, "updatedAt") VALUES (b, lesson, pupil, 'ABSENT', now());
  INSERT INTO "AbsenceReports" ("schoolId", "studentId", "reportedById", date) VALUES (b, pupil, pupil, '2020-01-15');
  INSERT INTO "LeaveRequests" ("schoolId", "studentId", "requestedById", "startDate", "endDate", reason)
  VALUES (b, pupil, pupil, '2020-01-10', '2020-01-12', 'RLS fixture: gammal ledighet');
  INSERT INTO "Notifications" ("schoolId", "userId", type, "createdAt") VALUES (b, pupil, 'SCHEDULE_CHANGED', '2020-01-15');
  INSERT INTO "ScheduleChangeLogs" ("schoolId", "academicYearId", action, "createdAt") VALUES (b, y, 'UPDATE', '2020-01-01');
  ALTER TABLE "GuardianStudentHistory" DISABLE TRIGGER "GuardianStudentHistory_written_by_trigger";
  INSERT INTO "GuardianStudentHistory" ("schoolId", "guardianId", "studentId", origin, "linkedAt", "unlinkedAt")
  VALUES (b, teacher, pupil, 'MANUAL', '2019-09-01', '2020-01-01');
  ALTER TABLE "GuardianStudentHistory" ENABLE TRIGGER "GuardianStudentHistory_written_by_trigger";
  INSERT INTO "TeacherAbsenceReasons" ("schoolId", builtin) VALUES (b, 'SICK') RETURNING id INTO reason;
  INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt", "reasonId")
  VALUES (b, teacher, '2020-01-13 07:00+00', '2020-01-14 16:00+00', reason);
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (b, 'rls-fixture-gone@example.invalid', 'Fixture', 'Gone', 'STUDENT', '00000000-0000-4000-8000-000000000089', false, now())
  RETURNING id INTO gone;
  ALTER TABLE "Users" DISABLE TRIGGER "Users_deactivation_is_dated_on_update";
  UPDATE "Users" SET "deactivatedAt" = '2020-01-01' WHERE id = gone;
  ALTER TABLE "Users" ENABLE TRIGGER "Users_deactivation_is_dated_on_update";
END $$;

-- The SECOND school's sign-in method (20261020090000): Entra ID, SSO-only for
-- staff, on a domain of its own and on one it shares. Sections 70 and 74 ask
-- whether school A's admin sees or changes it and what /login's lookup makes
-- of a domain two schools name; with nothing planted over there both pass
-- while proving nothing.
INSERT INTO "SchoolSignInMethods" ("schoolId", provider, domains, "entraTenantId", "ssoOnlyForStaff", "updatedAt")
SELECT id, 'azure', ARRAY['rls-fixture-b.example', 'rls-delad.example'],
       '7b0c2a9e-3c1d-4e5f-8a6b-0c1d2e3f4a5b', true, now()
FROM "Schools" WHERE slug = 'rls-fixture-school'
ON CONFLICT ("schoolId") DO NOTHING;

-- The läslogg's school (20261026091000, sections 120–127): an admin (121),
-- two teachers (122, 126), two pupils of one class (123, 124), the
-- guardian of the first (125), a teaching group of the first with a lesson,
-- marks, a report and a request for the first, and an integration key.
--
-- The read log as it stood before the suite: the teacher 122 read pupil
-- 123's roster 13 and 11 months ago, and ACCESS_LOG is to be kept 12
-- months, decided two days ago (section 125 gallrar the first). The
-- GALLRING school, which has decided nothing for ACCESS_LOG, has a log row
-- five years old that no other school's purge may take. The rows section
-- 121 measures the quarter-hour against are planted fresh on every run,
-- below.
DO $$
DECLARE
  l uuid;
  g uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-gallring-school');
  today date := (now() AT TIME ZONE 'Europe/Stockholm')::date;
  y uuid; home uuid; tg uuid; sub uuid; lesson uuid;
  admin uuid; t122 uuid; t126 uuid; p123 uuid; p124 uuid; g125 uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM "Schools" WHERE slug = 'rls-laslogg-school') THEN
    RETURN;
  END IF;
  INSERT INTO "Schools" (name, slug, timezone, "updatedAt")
  VALUES ('RLS Läslogg School', 'rls-laslogg-school', 'Europe/Stockholm', now())
  RETURNING id INTO l;
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
  VALUES (l, 'Läslogg i år', today - 30, today + 300, true, now()) RETURNING id INTO y;
  INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES (l, 'Läsloggsämne', 'LÄS', now()) RETURNING id INTO sub;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "updatedAt") VALUES (l, y, 'L7A', now()) RETURNING id INTO home;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "updatedAt") VALUES (l, y, 'L7 Ma-nivå', now()) RETURNING id INTO tg;

  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt") VALUES
    (l, 'laslogg-admin@example.invalid', 'Läslogg', 'Admin', 'SCHOOL_ADMIN', '00000000-0000-4000-8000-000000000121', true, now())
    RETURNING id INTO admin;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt") VALUES
    (l, 'laslogg-teacher@example.invalid', 'Läslogg', 'Lärare', 'TEACHER', '00000000-0000-4000-8000-000000000122', true, now())
    RETURNING id INTO t122;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt") VALUES
    (l, 'laslogg-pupil@example.invalid', 'Läslogg', 'Elev', 'STUDENT', '00000000-0000-4000-8000-000000000123', true, home, now())
    RETURNING id INTO p123;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt") VALUES
    (l, 'laslogg-pupil2@example.invalid', 'Läslogg', 'Klasskamrat', 'STUDENT', '00000000-0000-4000-8000-000000000124', true, home, now())
    RETURNING id INTO p124;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt") VALUES
    (l, 'laslogg-guardian@example.invalid', 'Läslogg', 'Vårdnadshavare', 'GUARDIAN', '00000000-0000-4000-8000-000000000125', true, now())
    RETURNING id INTO g125;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt") VALUES
    (l, 'laslogg-teacher2@example.invalid', 'Läslogg', 'Kollega', 'TEACHER', '00000000-0000-4000-8000-000000000126', true, now())
    RETURNING id INTO t126;

  INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId") VALUES (l, g125, p123);
  INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES (l, tg, p123);
  INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", "updatedAt")
  VALUES (l, sub, tg, today, today + time '07:10', today + time '07:50', now()) RETURNING id INTO lesson;
  INSERT INTO "CalendarLessonTeachers" ("calendarLessonId", "teacherId", "schoolId") VALUES (lesson, t122, l);
  INSERT INTO "AttendanceRecords" ("schoolId", "calendarLessonId", "studentId", status, "updatedAt")
  VALUES (l, lesson, p123, 'PRESENT', now());
  INSERT INTO "AbsenceReports" ("schoolId", "studentId", "reportedById", date, note)
  VALUES (l, p123, g125, today + 1, 'Läslogg: tandläkare');
  INSERT INTO "LeaveRequests" ("schoolId", "studentId", "requestedById", "startDate", "endDate", reason)
  VALUES (l, p123, g125, today + 10, today + 12, 'Läslogg: resa');
  INSERT INTO "IntegrationApiKeys" ("schoolId", name, "keyHash", "createdAt")
  VALUES (l, 'Läslogg-nyckel', md5('rls-laslogg-key') || md5('rls-laslogg-key-2'), now());

  INSERT INTO "PersonalDataAccess" ("schoolId", "at", "actorId", "actorRole", channel, kind, "subjectIds", "readSize") VALUES
    (l, now() - interval '13 months', t122, 'TEACHER', 'APP', 'ROSTER', ARRAY[p123], 1),
    (l, now() - interval '11 months', t122, 'TEACHER', 'APP', 'ROSTER', ARRAY[p123], 1);
  INSERT INTO "PersonalDataAccess" ("schoolId", "at", "actorId", "actorRole", channel, kind, "subjectIds", "readSize")
  SELECT g, now() - interval '5 years', u.id, 'SCHOOL_ADMIN', 'WEB', 'PEOPLE', ARRAY[(SELECT id FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000083')], 1
    FROM "Users" u WHERE u."authId" = '00000000-0000-4000-8000-000000000081';

  ALTER TABLE "RetentionDecisions" DISABLE TRIGGER "RetentionDecisions_stamped";
  INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision, months, reference, "decidedById", "decidedAt")
  VALUES (l, 'ACCESS_LOG', 'PURGE_AFTER', 12, 'DHP 9.1', admin, now() - interval '2 days');
  ALTER TABLE "RetentionDecisions" ENABLE TRIGGER "RetentionDecisions_stamped";
END $$;

-- The quarter-hour of section 121, on EVERY run: the teacher 126 read pupil
-- 124's roster ten minutes ago and its attendance twenty minutes ago.
-- Planted once with the school they would age past the window between two
-- runs on one database, and the suite would fail for the clock's sake. The
-- log is append-only to its owner too, so the earlier run's rows go the one
-- way the trigger allows: app.gallring set to the school, no principal.
DO $$
DECLARE
  l uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-laslogg-school');
  t126 uuid := (SELECT id FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000126');
  p124 uuid := (SELECT id FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000124');
BEGIN
  PERFORM set_config('app.gallring', l::text, true);
  DELETE FROM "PersonalDataAccess" WHERE "schoolId" = l AND "actorId" = t126;
  PERFORM set_config('app.gallring', '', true);
  INSERT INTO "PersonalDataAccess" ("schoolId", "at", "actorId", "actorRole", channel, kind, "subjectIds", "readSize") VALUES
    (l, now() - interval '10 minutes', t126, 'TEACHER', 'WEB', 'ROSTER', ARRAY[p124], 1),
    (l, now() - interval '20 minutes', t126, 'TEACHER', 'WEB', 'ATTENDANCE', ARRAY[p124], 1);
END $$;

-- The policy tests run as the unprivileged role, which by design cannot see
-- any school until a principal is set — so it cannot discover these ids for
-- itself. The runner reads them here (as owner) and passes them in with -v.
\pset tuples_only on
\pset format unaligned
SELECT id FROM "Schools" WHERE slug <> 'rls-fixture-school' ORDER BY "createdAt" LIMIT 1;
