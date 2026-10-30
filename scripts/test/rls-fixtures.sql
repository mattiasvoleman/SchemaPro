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

-- A period of that post (20261022120000): section 91's tenant half counts
-- it, and school B's admin reads it and nothing of school A's.
INSERT INTO "TeacherEmploymentPeriods"
  ("schoolId", "employmentId", "userId", "academicYearId", "validFrom", "employmentPercent", "updatedAt")
SELECT e."schoolId", e.id, e."userId", e."academicYearId", y."startDate" + 14, 60, now()
FROM "TeacherEmployments" e
JOIN "Users" u ON u.id = e."userId"
JOIN "AcademicYears" y ON y.id = e."academicYearId" AND y.name = 'RLS Fixture Year'
WHERE u."authId" = '00000000-0000-4000-8000-000000000001'
  AND NOT EXISTS (SELECT 1 FROM "TeacherEmploymentPeriods" p WHERE p."employmentId" = e.id);

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
-- relative to today in Europe/Stockholm and a month or more from its cutoff,
-- so the cutoffs below hold whenever the suite runs, a midnight between these
-- fixtures and the suite included. A row ON a cutoff has no such margin: the
-- lesson on the attendance cutoff is planted by sections 83, 86 and 87 inside
-- their own transactions, a year before their own school day. Planted here,
-- a Stockholm midnight before the suite would leave it a day before the
-- cutoff, and the night would take it.
--
--   ATTENDANCE       12 months   lessons 13 months ago (go) and 11 months ago
--                                (stays); the sections add one on the
--                                cutoff day (stays)
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
  l_old uuid; l_new uuid;
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
  VALUES (g, sub, grp, today - interval '11 months', (today - interval '11 months')::date + time '06:10', (today - interval '11 months')::date + time '06:50', now())
  RETURNING id INTO l_new;
  INSERT INTO "AttendanceRecords" ("schoolId", "calendarLessonId", "studentId", status, "updatedAt") VALUES
    (g, l_old, pupil, 'PRESENT', now()), (g, l_old, pupil_gone, 'ABSENT', now()),
    (g, l_new, pupil, 'PRESENT', now());

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

-- The läslogg school's staff and timplan rows (20261028090000, sections 128
-- and 129): a post, an uppdrag and an absence for each teacher (122 and
-- 126), a time for 122's uppdrag and a cover of 122's absence on 122's
-- lesson, a published statement for both pupils, and an SS12000 run with
-- one change about pupil 123. The posts' and uppdrag's history is the log
-- trigger's; the class history is the class trigger's, from the pupils'
-- home class. Planted once.
DO $$
DECLARE
  l uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-laslogg-school');
  t122 uuid := (SELECT id FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000122');
  t126 uuid := (SELECT id FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000126');
  p123 uuid := (SELECT id FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000123');
  p124 uuid := (SELECT id FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000124');
  today date := (now() AT TIME ZONE 'Europe/Stockholm')::date;
  y uuid; lesson uuid; slot uuid; duty uuid; absence uuid; pub uuid; src uuid; run uuid;
BEGIN
  IF l IS NULL OR t122 IS NULL OR t126 IS NULL OR p123 IS NULL OR p124 IS NULL THEN
    RAISE EXCEPTION 'rls-fixtures: the läslogg school lacks its teachers or pupils for the staff rows';
  END IF;
  IF EXISTS (SELECT 1 FROM "TeacherEmployments" WHERE "schoolId" = l) THEN
    RETURN;
  END IF;
  SELECT id INTO y FROM "AcademicYears" WHERE "schoolId" = l;
  SELECT c.id INTO lesson FROM "CalendarLessons" c
    JOIN "CalendarLessonTeachers" t ON t."calendarLessonId" = c.id AND t."teacherId" = t122
   WHERE c."schoolId" = l;

  INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", note, "updatedAt") VALUES
    (l, t122, y, 100, NULL, now()),
    (l, t126, y, 80, 'Läslogg: tjänstledig på fredagar', now());

  INSERT INTO "AvailabilityConstraints" ("schoolId", "resourceType", "userId", "dayOfWeek", "startTime", "endTime", type, reason, "updatedAt")
  VALUES (l, 'TEACHER', t122, 2, '15:00', '17:00', 'UNAVAILABLE', 'Läslogg: APT', now()) RETURNING id INTO slot;
  INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "updatedAt")
  VALUES (l, t122, y, 'APT_KONFERENS', 'Läslogg APT', 120, now()) RETURNING id INTO duty;
  INSERT INTO "TeacherDutySlots" ("schoolId", "teacherDutyId", "availabilityConstraintId") VALUES (l, duty, slot);
  INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "updatedAt")
  VALUES (l, t126, y, 'APT_KONFERENS', 'Läslogg APT', 120, now());

  INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt")
  VALUES (l, t122, today::timestamptz, today::timestamptz + interval '1 day') RETURNING id INTO absence;
  INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt")
  VALUES (l, t126, today::timestamptz + interval '2 days', today::timestamptz + interval '3 days');
  INSERT INTO "TeacherAbsenceCovers" ("schoolId", "absenceId", "calendarLessonId", "absentTeacherId", decision)
  VALUES (l, absence, lesson, t122, 'CANCELLED');

  INSERT INTO "TimplanStatementPublications" ("schoolId", "academicYearId", "asOfDate", "pupils")
  VALUES (l, y, today, 2) RETURNING id INTO pub;
  INSERT INTO "TimplanStatements"
    ("schoolId", "publicationId", "academicYearId", "asOfDate", "studentId", stage, "subjectCode", "versionCode",
     "distributionPublished", "gradesFrom", "gradesTo", "nationalHours", "plannedHours", "outcomeHours", "projectedHours",
     status, "projectedStatus", complete)
  SELECT l, pub, y, today, pupil, 'HOG', 'MA', 'SFS2023:945/B1', true, 7, 9, 400, 403, 100, 403, 'UNRECORDED', 'UNRECORDED', false
    FROM unnest(ARRAY[p123, p124]) pupil;

  INSERT INTO "Ss12000Sources" ("schoolId", name, "baseUrl", "authKind", "tokenUrl", "clientId", "organisationIds")
  VALUES (l, 'Läslogg', 'https://api.ist.example/ss12000v2-api/source/SE00100/v2.0', 'OAUTH2_CLIENT_CREDENTIALS',
          'https://skolid.example/connect/token', 'laslogg', ARRAY['aaaaaaaa-0000-4000-8000-000000000128']::uuid[])
  RETURNING id INTO src;
  INSERT INTO "Ss12000SyncRuns" ("schoolId", "sourceId", "trigger", "mode") VALUES (l, src, 'MANUAL', 'FULL') RETURNING id INTO run;
  INSERT INTO "Ss12000SyncChanges" ("runId", "schoolId", seq, entity, op, "externalId", "localId", "before", "after", selected)
  VALUES (run, l, 0, 'PERSON', 'UPDATE', 'bbbbbbbb-0000-4000-8000-000000000128', p123,
          '{"lastName": "Elev"}', '{"lastName": "Elevsdotter"}', true);
  UPDATE "Ss12000SyncRuns" SET status = 'DIFF_READY', "basisHash" = repeat('c', 64), "fetchedAt" = now() WHERE id = run;
END $$;

-- Mentorns ledighetsbeslut (20261023091000, RLS sections 95–99): a school of
-- its own, with fixed dates in läsår 2095/96 so no section depends on today.
-- 9A has two mentors, Anna for the whole year and Bertil until the jullov;
-- 9B has Cecilia; 9C's only mentor, Erik, has left (inactive), so 9C's pupils
-- have no mentor. David holds no mentorskap. The guardian's children are Ella
-- (9A) and Frida (9C); Gustav (9B) signs in himself. Sportlov is v.8, the
-- jullov runs 2095-12-21 to 2096-01-06, and åk 9 has prao in v.10. No
-- delegation is recorded: the sections record their own and roll it back.
-- Planted once.
DO $$
DECLARE
  l uuid; y uuid; g9a uuid; g9b uuid; g9c uuid;
  admin uuid; anna uuid; bertil uuid; cecilia uuid; erik uuid; guardian uuid; ella uuid; frida uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM "Schools" WHERE slug = 'rls-ledighet') THEN
    RETURN;
  END IF;
  INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ('RLS Ledighet', 'rls-ledighet', 'Europe/Stockholm', now())
  RETURNING id INTO l;
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
  VALUES (l, 'Ledighet 2095/96', '2095-08-15', '2096-06-12', false, now()) RETURNING id INTO y;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt") VALUES (l, y, '9A', 9, now()) RETURNING id INTO g9a;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt") VALUES (l, y, '9B', 9, now()) RETURNING id INTO g9b;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt") VALUES (l, y, '9C', 9, now()) RETURNING id INTO g9c;
  INSERT INTO "SchoolBreaks" ("schoolId", "academicYearId", name, "startDate", "endDate", "updatedAt") VALUES
    (l, y, 'Jullov', '2095-12-21', '2096-01-06', now()),
    (l, y, 'Sportlov', '2096-02-20', '2096-02-24', now());
  INSERT INTO "SchoolBreaks" ("schoolId", "academicYearId", name, "startDate", "endDate", "minGradeLevel", "maxGradeLevel", "updatedAt") VALUES
    (l, y, 'Prao åk 9', '2096-03-05', '2096-03-09', 9, 9, now());

  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt") VALUES
    (l, 'ledighet-rektor@example.invalid', 'Rut', 'Rektor', 'SCHOOL_ADMIN', '00000000-0000-4000-8000-000000000950', true, now())
    RETURNING id INTO admin;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt") VALUES
    (l, 'ledighet-anna@example.invalid', 'Anna', 'Mentor', 'TEACHER', '00000000-0000-4000-8000-000000000951', true, now())
    RETURNING id INTO anna;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt") VALUES
    (l, 'ledighet-bertil@example.invalid', 'Bertil', 'Mentor', 'TEACHER', '00000000-0000-4000-8000-000000000952', true, now())
    RETURNING id INTO bertil;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt") VALUES
    (l, 'ledighet-cecilia@example.invalid', 'Cecilia', 'Mentor', 'TEACHER', '00000000-0000-4000-8000-000000000953', true, now())
    RETURNING id INTO cecilia;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt") VALUES
    (l, 'ledighet-david@example.invalid', 'David', 'Lärare', 'TEACHER', '00000000-0000-4000-8000-000000000954', true, now());
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt") VALUES
    (l, 'ledighet-erik@example.invalid', 'Erik', 'Slutad', 'TEACHER', '00000000-0000-4000-8000-000000000959', true, now())
    RETURNING id INTO erik;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt") VALUES
    (l, 'ledighet-guardian@example.invalid', 'Vera', 'Vårdnadshavare', 'GUARDIAN', '00000000-0000-4000-8000-000000000955', true, now())
    RETURNING id INTO guardian;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt") VALUES
    (l, 'ledighet-ella@example.invalid', 'Ella', 'Elev', 'STUDENT', '00000000-0000-4000-8000-000000000956', true, g9a, now())
    RETURNING id INTO ella;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt") VALUES
    (l, 'ledighet-gustav@example.invalid', 'Gustav', 'Elev', 'STUDENT', '00000000-0000-4000-8000-000000000957', true, g9b, now());
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt") VALUES
    (l, 'ledighet-frida@example.invalid', 'Frida', 'Elev', 'STUDENT', '00000000-0000-4000-8000-000000000958', true, g9c, now())
    RETURNING id INTO frida;
  INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId") VALUES (l, guardian, ella), (l, guardian, frida);

  INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "studentGroupId", "validTo", "updatedAt") VALUES
    (l, anna, y, 'MENTORSKAP', 'Mentor 9A', 60, g9a, NULL, now()),
    (l, bertil, y, 'MENTORSKAP', 'Mentor 9A', 60, g9a, '2095-12-20', now()),
    (l, cecilia, y, 'MENTORSKAP', 'Mentor 9B', 60, g9b, NULL, now()),
    (l, erik, y, 'MENTORSKAP', 'Mentor 9C', 60, g9c, NULL, now());
  UPDATE "Users" SET "isActive" = false, "updatedAt" = now() WHERE id = erik;

  -- Gustav's own request, filed in this earlier transaction while the
  -- school delegated nothing, so its trigger told nobody: section 98 asserts
  -- that the staff catch-up tells its mentor once.
  INSERT INTO "LeaveRequests" ("schoolId", "studentId", "requestedById", "startDate", "endDate", reason)
  SELECT l, u.id, u.id, '2096-01-23', '2096-01-23', 'rls fixture tidigare'
    FROM "Users" u WHERE u."authId" = '00000000-0000-4000-8000-000000000957';
END $$;

-- Skolenheter (sections 130–133, 20261031090000). Two schools: one with no
-- unit yet (its admin creates them inside the sections' transactions) and a
-- source choosing one skolenhet, and one already split into F–6 and 7–9,
-- committed, so a class's årskurs can be moved under it.
DO $$
DECLARE
  today date := current_date;
  s1 uuid;
  s2 uuid;
  y uuid;
  klass uuid;
  pupil uuid;
  guardian uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM "Schools" WHERE slug = 'rls-skolenheter-school') THEN
    RETURN;
  END IF;
  INSERT INTO "Schools" (name, slug, timezone, "updatedAt")
  VALUES ('RLS Skolenheter', 'rls-skolenheter-school', 'Europe/Stockholm', now()) RETURNING id INTO s1;
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
  VALUES (s1, 'Skolenheter i år', today - 30, today + 300, true, now()) RETURNING id INTO y;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt")
  VALUES (s1, y, 'SE7A', 7, now()) RETURNING id INTO klass;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt") VALUES
    (s1, 'skolenheter-admin@example.invalid', 'Skolenhet', 'Admin', 'SCHOOL_ADMIN', '00000000-0000-4000-8000-000000000130', true, now()),
    (s1, 'skolenheter-teacher@example.invalid', 'Skolenhet', 'Lärare', 'TEACHER', '00000000-0000-4000-8000-000000000131', true, now());
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
  VALUES (s1, 'skolenheter-pupil@example.invalid', 'Skolenhet', 'Elev', 'STUDENT', '00000000-0000-4000-8000-000000000132', true, klass, now())
  RETURNING id INTO pupil;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s1, 'skolenheter-guardian@example.invalid', 'Skolenhet', 'Vårdnadshavare', 'GUARDIAN', '00000000-0000-4000-8000-000000000133', true, now())
  RETURNING id INTO guardian;
  INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId") VALUES (s1, guardian, pupil);
  INSERT INTO "Ss12000Sources" ("schoolId", name, "baseUrl", "authKind", "tokenUrl", "clientId", "organisationIds")
  VALUES (s1, 'Skolenheter', 'https://api.ist.example/ss12000v2-api/source/SE00130/v2.0', 'OAUTH2_CLIENT_CREDENTIALS',
          'https://skolid.example/connect/token', 'skolenheter', ARRAY['aaaaaaaa-0000-4000-8000-000000000130']::uuid[]);

  INSERT INTO "Schools" (name, slug, timezone, "updatedAt")
  VALUES ('RLS Skolenheter delad', 'rls-skolenheter-delad', 'Europe/Stockholm', now()) RETURNING id INTO s2;
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
  VALUES (s2, 'Delad i år', today - 30, today + 300, true, now()) RETURNING id INTO y;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt")
  VALUES (s2, y, 'SD6A', 6, now()) RETURNING id INTO klass;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s2, 'skolenheter-delad-admin@example.invalid', 'Delad', 'Admin', 'SCHOOL_ADMIN', '00000000-0000-4000-8000-000000000134', true, now());
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
  VALUES (s2, 'skolenheter-delad-pupil@example.invalid', 'Delad', 'Elev', 'STUDENT', '00000000-0000-4000-8000-000000000135', true, klass, now());
  INSERT INTO "SchoolUnits" ("schoolId", name, code, "schoolTypes", "gradeFrom", "gradeTo") VALUES
    (s2, 'Delad F–6', '31313131', '{FKLASS,GR}', 0, 6),
    (s2, 'Delad 7–9', '32323232', '{GR}', 7, 9);
END $$;

-- Skolområden och restid (20261124090000), sections 180–183: a school with
-- two sites, a room on each, the minutes between them, and every role; and
-- another school with a site of its own that nothing here may reach.
DO $$
DECLARE
  s1 uuid;
  s2 uuid;
  y uuid;
  klass uuid;
  pupil uuid;
  guardian uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM "Schools" WHERE slug = 'rls-skolomraden-school') THEN
    RETURN;
  END IF;
  INSERT INTO "Schools" (name, slug, timezone, "updatedAt")
  VALUES ('RLS Skolområden', 'rls-skolomraden-school', 'Europe/Stockholm', now()) RETURNING id INTO s1;
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
  VALUES (s1, 'Skolområden i år', current_date - 30, current_date + 300, true, now()) RETURNING id INTO y;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt")
  VALUES (s1, y, 'SO7A', 7, now()) RETURNING id INTO klass;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "updatedAt") VALUES
    (s1, 'skolomraden-admin@example.invalid', 'Skolområde', 'Admin', 'SCHOOL_ADMIN', 'FULL', '00000000-0000-4000-8000-000000001240', true, now()),
    (s1, 'skolomraden-exp@example.invalid', 'Skolområde', 'Expedition', 'SCHOOL_ADMIN', 'EXPEDITION', '00000000-0000-4000-8000-000000001244', true, now());
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s1, 'skolomraden-teacher@example.invalid', 'Skolområde', 'Lärare', 'TEACHER', '00000000-0000-4000-8000-000000001241', true, now());
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
  VALUES (s1, 'skolomraden-pupil@example.invalid', 'Skolområde', 'Elev', 'STUDENT', '00000000-0000-4000-8000-000000001242', true, klass, now())
  RETURNING id INTO pupil;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s1, 'skolomraden-guardian@example.invalid', 'Skolområde', 'Vårdnadshavare', 'GUARDIAN', '00000000-0000-4000-8000-000000001243', true, now())
  RETURNING id INTO guardian;
  INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId") VALUES (s1, guardian, pupil);
  INSERT INTO "Sites" ("schoolId", name) VALUES (s1, 'SO Norra'), (s1, 'SO Södra');
  INSERT INTO "SiteTravelTimes" ("schoolId", "siteAId", "siteBId", minutes)
  SELECT s1, least(a.id, b.id), greatest(a.id, b.id), 15
    FROM "Sites" a, "Sites" b WHERE a."schoolId" = s1 AND b."schoolId" = s1 AND a.name = 'SO Norra' AND b.name = 'SO Södra';
  INSERT INTO "Rooms" ("schoolId", name, "siteId", "updatedAt")
  SELECT s1, 'SO ' || x.name, x.id, now() FROM "Sites" x WHERE x."schoolId" = s1;

  INSERT INTO "Schools" (name, slug, timezone, "updatedAt")
  VALUES ('RLS Skolområden annan', 'rls-skolomraden-annan', 'Europe/Stockholm', now()) RETURNING id INTO s2;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "updatedAt")
  VALUES (s2, 'skolomraden-annan-admin@example.invalid', 'Annan', 'Admin', 'SCHOOL_ADMIN', 'FULL', '00000000-0000-4000-8000-000000001245', true, now());
  INSERT INTO "Sites" ("schoolId", name) VALUES (s2, 'Annan Norra'), (s2, 'Annan Södra');
  INSERT INTO "SiteTravelTimes" ("schoolId", "siteAId", "siteBId", minutes)
  SELECT s2, least(a.id, b.id), greatest(a.id, b.id), 20
    FROM "Sites" a, "Sites" b WHERE a."schoolId" = s2 AND b."schoolId" = s2 AND a.name = 'Annan Norra' AND b.name = 'Annan Södra';
  INSERT INTO "Rooms" ("schoolId", name, "siteId", "updatedAt")
  SELECT s2, 'Annan rum', id, now() FROM "Sites" WHERE "schoolId" = s2 AND name = 'Annan Norra';
END $$;

-- The role × table matrix's school (Roller i skolan, 20261110100000): one row
-- in every table an administrator's arm reaches, and one administrator of
-- each profile. Section 116 runs every profile against every table here; no
-- other section looks at this school, so nothing planted here moves theirs.
-- Planted as the owner, so row security does not apply and the triggers that
-- answer only for a signed-in person let the rows through.
DO $$
DECLARE
  m uuid;
  yr uuid;
  subj uuid;
  rtype uuid;
  room uuid;
  grp uuid;
  tgrp uuid;
  admin_full uuid;
  teacher uuid;
  pupil uuid;
  pupil2 uuid;
  guardian uuid;
  ml uuid;
  cl uuid;
  cl2 uuid;
  plan uuid;
  ntv uuid;
  absence uuid;
  reason uuid;
  batch uuid;
  credit uuid;
  pref uuid;
  pub uuid;
  tpub uuid;
  src uuid;
  run uuid;
  ikey uuid;
  sub uuid;
  ac uuid;
  duty uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM "Schools" WHERE slug = 'rls-roller-school') THEN
    RETURN;
  END IF;

  INSERT INTO "Schools" (name, slug, "updatedAt") VALUES ('RLS Roller', 'rls-roller-school', now()) RETURNING id INTO m;
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
  VALUES (m, 'Roller 2030/31', '2030-08-15', '2031-06-15', true, now()) RETURNING id INTO yr;
  INSERT INTO "RoomTypes" ("schoolId", name) VALUES (m, 'Roller sal') RETURNING id INTO rtype;
  INSERT INTO "Rooms" ("schoolId", name, "roomTypeId", "updatedAt") VALUES (m, 'Roller 1', rtype, now()) RETURNING id INTO room;
  INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES (m, 'Roller ämne', 'RLSR', now()) RETURNING id INTO subj;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt")
  VALUES (m, yr, 'Roller 7A', 7, now()) RETURNING id INTO grp;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", kind, "updatedAt")
  VALUES (m, yr, 'Roller Spanska', 7, 'TEACHING_GROUP', now()) RETURNING id INTO tgrp;

  -- One administrator of each profile; two with HR-läs. The log trigger
  -- gives each a UserRoleChanges row, which is that table's row here. The
  -- läsare are planted in the block after this one.
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "hrRead", "authId", "isActive", "updatedAt")
  VALUES
    (m, 'roller-full@example.invalid',    'Roller', 'Full',          'SCHOOL_ADMIN', 'FULL',          false, '00000000-0000-4000-8000-000000000105', true, now()),
    (m, 'roller-rektor@example.invalid',  'Roller', 'Rektor',        'SCHOOL_ADMIN', 'REKTOR',        false, '00000000-0000-4000-8000-000000000106', true, now()),
    (m, 'roller-schema@example.invalid',  'Roller', 'Schemaläggare', 'SCHOOL_ADMIN', 'SCHEMALAGGARE', false, '00000000-0000-4000-8000-000000000107', true, now()),
    (m, 'roller-exp@example.invalid',     'Roller', 'Expedition',    'SCHOOL_ADMIN', 'EXPEDITION',    false, '00000000-0000-4000-8000-000000000108', true, now()),
    (m, 'roller-schema-hr@example.invalid','Roller', 'Schema HR',    'SCHOOL_ADMIN', 'SCHEMALAGGARE', true,  '00000000-0000-4000-8000-000000000109', true, now()),
    (m, 'roller-exp-hr@example.invalid',  'Roller', 'Expedition HR', 'SCHOOL_ADMIN', 'EXPEDITION',    true,  '00000000-0000-4000-8000-000000000110', true, now());
  SELECT id INTO admin_full FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000105';
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (m, 'roller-teacher@example.invalid', 'Roller', 'Lärare', 'TEACHER', '00000000-0000-4000-8000-000000000111', true, now())
  RETURNING id INTO teacher;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
  VALUES (m, 'roller-pupil@example.invalid', 'Roller', 'Elev', 'STUDENT', '00000000-0000-4000-8000-000000000112', true, grp, now())
  RETURNING id INTO pupil;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
  VALUES (m, 'roller-pupil2@example.invalid', 'Roller', 'Elev Två', 'STUDENT', '00000000-0000-4000-8000-000000000114', true, grp, now())
  RETURNING id INTO pupil2;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (m, 'roller-guardian@example.invalid', 'Roller', 'Vårdnadshavare', 'GUARDIAN', '00000000-0000-4000-8000-000000000113', true, now())
  RETURNING id INTO guardian;

  INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId") VALUES (m, guardian, pupil);
  INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES (m, tgrp, pupil);

  -- Planering.
  SELECT id INTO ntv FROM "NationalTimplanVersions" WHERE "schoolForm" = 'GRUNDSKOLA' ORDER BY id LIMIT 1;
  INSERT INTO "LocalTimplans" ("schoolId", name, "schoolForm", "nationalTimplanVersionId", "updatedAt")
  VALUES (m, 'Roller timplan', 'GRUNDSKOLA', ntv, now()) RETURNING id INTO plan;
  INSERT INTO "LocalTimplanEntries" ("schoolId", "localTimplanId", "subjectId", "gradeLevel", "minutesPerWeek")
  VALUES (m, plan, subj, 7, 60);
  INSERT INTO "AcademicYearTimplans" ("schoolId", "academicYearId", "gradeLevel", "localTimplanId", "updatedAt")
  VALUES (m, yr, 7, plan, now());
  INSERT INTO "TimplanCredits" ("schoolId", "academicYearId", date, minutes, name, "updatedAt")
  VALUES (m, yr, '2030-09-10', 60, 'Roller friluftsdag', now()) RETURNING id INTO credit;
  INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "updatedAt")
  VALUES (m, yr, subj, grp, teacher, 1, now());
  INSERT INTO "AvailabilityConstraints" ("schoolId", "resourceType", "userId", "dayOfWeek", "startTime", "endTime", "updatedAt")
  VALUES (m, 'TEACHER', teacher, 1, '08:00', '09:00', now()) RETURNING id INTO ac;
  INSERT INTO "SchoolBreaks" ("schoolId", "academicYearId", name, "startDate", "endDate", "updatedAt")
  VALUES (m, yr, 'Roller lov', '2030-10-28', '2030-11-01', now());
  INSERT INTO "FrameTimes" ("schoolId", "minGradeLevel", "maxGradeLevel", "startTime", "endTime", "updatedAt")
  VALUES (m, 7, 9, '08:00', '16:00', now());
  INSERT INTO "Rasts" ("schoolId", name, "minGradeLevel", "maxGradeLevel", "startTime", "endTime", "updatedAt")
  VALUES (m, 'Roller rast', 7, 9, '10:00', '10:15', now());
  INSERT INTO "LunchSettings" ("schoolId", "lunchStartTime", "lunchEndTime", "lunchMinutes", "updatedAt")
  VALUES (m, '11:00', '13:00', 30, now());
  INSERT INTO "LunchServings" ("schoolId", "minGradeLevel", "maxGradeLevel", "startTime", "endTime", "updatedAt")
  VALUES (m, 7, 9, '11:30', '12:00', now());
  INSERT INTO "LunchSittings" ("schoolId", "academicYearId", "studentGroupId", "dayOfWeek", "startTime", "endTime", "updatedAt")
  VALUES (m, yr, grp, 1, '11:30', '12:00', now());
  INSERT INTO "RoomPreferences" ("schoolId", "subjectId", "updatedAt") VALUES (m, subj, now()) RETURNING id INTO pref;
  INSERT INTO "RoomPreferenceRooms" ("schoolId", "preferenceId", "roomId") VALUES (m, pref, room);
  INSERT INTO "StaffingPolicies" ("schoolId", "updatedAt") VALUES (m, now());
  INSERT INTO "TeacherSubjectQualifications" ("schoolId", "userId", "subjectId", "minGradeLevel", "maxGradeLevel", kind, "updatedAt")
  VALUES (m, teacher, subj, 7, 9, 'LEGITIMATION', now());
  INSERT INTO "TeacherWorkRules" ("schoolId", "userId", "updatedAt") VALUES (m, teacher, now());
  INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "updatedAt")
  VALUES (m, teacher, yr, 'RASTVAKT', 'Roller rastvakt', 30, now()) RETURNING id INTO duty;
  INSERT INTO "AvailabilityConstraints" ("schoolId", "resourceType", "userId", "dayOfWeek", "startTime", "endTime", "updatedAt")
  VALUES (m, 'TEACHER', teacher, 2, '12:00', '12:30', now()) RETURNING id INTO ac;
  INSERT INTO "TeacherDutySlots" ("schoolId", "teacherDutyId", "availabilityConstraintId") VALUES (m, duty, ac);
  -- HR: the post, which the log trigger also records, and a period of it
  -- from two weeks into the year (Tjänstens perioder).
  INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", "reductionPercent", signature, "updatedAt")
  VALUES (m, teacher, yr, 80, 10, 'RL', now());
  INSERT INTO "TeacherEmploymentPeriods" ("schoolId", "employmentId", "userId", "academicYearId", "validFrom", "employmentPercent", "updatedAt")
  SELECT e."schoolId", e.id, e."userId", e."academicYearId", y."startDate" + 14, 60, now()
    FROM "TeacherEmployments" e JOIN "AcademicYears" y ON y.id = e."academicYearId"
   WHERE e."schoolId" = m AND e."userId" = teacher;

  -- Planering: a skolenhet and a block of parallel teaching.
  INSERT INTO "SchoolUnits" ("schoolId", name, code, "schoolTypes", "gradeFrom", "gradeTo")
  VALUES (m, 'Roller F–9', '41414141', '{FKLASS,GR}', 0, 9);
  INSERT INTO "TeachingBlocks" ("schoolId", "academicYearId", name, "updatedAt") VALUES (m, yr, 'Roller block', now());

  -- The decisions: rektor's delegation of short leave to the mentors.
  INSERT INTO "LeaveDelegationDecisions" ("schoolId", "mentorMaxSchoolDays", reference) VALUES (m, 3, 'Roller');

  -- Schemaläggning.
  INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "roomId",
                               "dayOfWeek", "startTime", "endTime", "updatedAt")
  VALUES (m, yr, subj, grp, teacher, room, 1, '09:00', '10:00', now()) RETURNING id INTO ml;
  INSERT INTO "MasterLessonGroups" ("schoolId", "masterLessonId", "studentGroupId") VALUES (m, ml, tgrp);
  INSERT INTO "MasterLessonStudents" ("schoolId", "masterLessonId", "studentId") VALUES (m, ml, pupil2);
  INSERT INTO "ScheduleVersions" ("schoolId", "academicYearId", name, lessons, "lessonCount") VALUES (m, yr, 'Roller version', '[]', 0);
  INSERT INTO "ScheduleChangeLogs" ("schoolId", "academicYearId", action) VALUES (m, yr, 'CREATE');
  INSERT INTO "OptimizationJobs" ("schoolId", "academicYearId") VALUES (m, yr);

  -- Drift.
  INSERT INTO "CalendarLessons" ("schoolId", "masterLessonId", "subjectId", "studentGroupId", "roomId", date, "startsAt", "endsAt", "updatedAt")
  VALUES (m, ml, subj, grp, room, '2030-09-02', '2030-09-02 07:00+00', '2030-09-02 08:00+00', now()) RETURNING id INTO cl;
  INSERT INTO "CalendarLessons" ("schoolId", "masterLessonId", "subjectId", "studentGroupId", "roomId", date, "startsAt", "endsAt", "updatedAt")
  VALUES (m, ml, subj, grp, room, '2030-09-09', '2030-09-09 07:00+00', '2030-09-09 08:00+00', now()) RETURNING id INTO cl2;
  INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId") VALUES (m, cl, teacher);
  INSERT INTO "CalendarLessonGroups" ("schoolId", "calendarLessonId", "studentGroupId") VALUES (m, cl, tgrp);
  INSERT INTO "CalendarLessonStudents" ("schoolId", "calendarLessonId", "studentId") VALUES (m, cl, pupil2);
  INSERT INTO "CalendarLunches" ("schoolId", "studentGroupId", date, "startsAt", "endsAt", "updatedAt")
  VALUES (m, grp, '2030-09-02', '2030-09-02 09:30+00', '2030-09-02 10:00+00', now());
  INSERT INTO "CalendarRasts" ("schoolId", "studentGroupId", name, date, "startsAt", "endsAt", "updatedAt")
  VALUES (m, grp, 'Roller rast', '2030-09-02', '2030-09-02 08:00+00', '2030-09-02 08:15+00', now());
  INSERT INTO "AttendanceRecords" ("schoolId", "calendarLessonId", "studentId", "updatedAt") VALUES (m, cl, pupil, now());
  INSERT INTO "AbsenceReports" ("schoolId", "studentId", "reportedById", date) VALUES (m, pupil, guardian, '2030-09-03');
  INSERT INTO "LeaveRequests" ("schoolId", "studentId", "requestedById", "startDate", "endDate", reason)
  VALUES (m, pupil, guardian, '2030-09-20', '2030-09-20', 'Roller');
  INSERT INTO "RoomBookings" ("schoolId", "roomId", "bookedById", title, "startsAt", "endsAt", "updatedAt")
  VALUES (m, room, teacher, 'Roller bokning', '2030-09-04 12:00+00', '2030-09-04 13:00+00', now());
  INSERT INTO "Notifications" ("schoolId", "userId", type) VALUES (m, teacher, 'SCHEDULE_CHANGED');
  INSERT INTO "TeacherAbsenceReasons" ("schoolId", builtin) VALUES (m, 'SICK') RETURNING id INTO reason;
  INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt", "reasonId")
  VALUES (m, teacher, '2030-09-02 06:00+00', '2030-09-02 15:00+00', reason) RETURNING id INTO absence;
  INSERT INTO "TeacherAbsenceCovers" ("schoolId", "absenceId", "calendarLessonId", "absentTeacherId", decision)
  VALUES (m, absence, cl, teacher, 'CANCELLED');
  INSERT INTO "CoverSettings" ("schoolId") VALUES (m);
  INSERT INTO "SubstitutePoolMembers" ("schoolId", "userId") VALUES (m, teacher);
  INSERT INTO "SubstituteAvailabilities" ("schoolId", "userId", "dayOfWeek", "startTime", "endTime")
  VALUES (m, teacher, 3, '08:00', '12:00');
  INSERT INTO "CancellationBatches" ("schoolId", "academicYearId", name, cause, "fromDate", "toDate", scope)
  VALUES (m, yr, 'Roller prao', 'EVENT', '2030-09-09', '2030-09-09', 'SCHOOL') RETURNING id INTO batch;
  INSERT INTO "CancellationBatchLessons" ("schoolId", "batchId", "calendarLessonId") VALUES (m, batch, cl2);
  INSERT INTO "CancellationBatchCredits" ("schoolId", "batchId", "creditId") VALUES (m, batch, credit);

  -- Publicering.
  INSERT INTO "PublicationSettings" ("schoolId") VALUES (m);
  INSERT INTO "TimetablePublications" ("schoolId", "academicYearId", kind, outcome, "publishMode", "validFrom", "validTo", "publishedByUserId")
  VALUES (m, yr, 'PUBLISH', 'PUBLISHED', 'DRAFT', '2030-08-15', '2031-06-15', admin_full) RETURNING id INTO pub;
  INSERT INTO "PublishedLessons" ("schoolId", "publicationId", "academicYearId", "masterLessonId", "subjectId", "studentGroupId",
                                  "dayOfWeek", "startTime", "endTime", "isLocked", "isGenerated", "isParked", recurrence)
  VALUES (m, pub, yr, ml, subj, grp, 1, '09:00', '10:00', false, false, false, 'ALL_WEEKS');
  INSERT INTO "PublishedLunchSittings" ("schoolId", "publicationId", "academicYearId", "studentGroupId", "dayOfWeek", "startTime", "endTime")
  VALUES (m, pub, yr, grp, 1, '11:30', '12:00');
  ALTER TABLE "PublicationPendingRemovals" DISABLE TRIGGER "PublicationPendingRemovals_only_by_trigger";
  INSERT INTO "PublicationPendingRemovals" ("schoolId", "calendarLessonId", "academicYearId", "masterLessonId", reconcilable)
  VALUES (m, cl2, yr, ml, true);
  ALTER TABLE "PublicationPendingRemovals" ENABLE TRIGGER "PublicationPendingRemovals_only_by_trigger";
  INSERT INTO "PublicTimetableLinks" ("schoolId", "academicYearId", kind, "targetGroupId", "tokenHash")
  VALUES (m, yr, 'GROUP', grp, encode(sha256('roller-token'), 'hex'));
  INSERT INTO "TeacherPublicLabels" ("userId", "schoolId", hidden) VALUES (teacher, m, true);
  INSERT INTO "TimplanStatementPublications" ("schoolId", "academicYearId", "asOfDate", pupils)
  VALUES (m, yr, '2030-12-01', 1) RETURNING id INTO tpub;
  INSERT INTO "TimplanStatements" ("schoolId", "publicationId", "academicYearId", "asOfDate", "studentId", stage, "subjectCode",
                                   "distributionPublished", "gradesFrom", "gradesTo", "plannedHours", "outcomeHours", "projectedHours",
                                   status, "projectedStatus", complete)
  VALUES (m, tpub, yr, '2030-12-01', pupil, 'HOG', 'EN', true, 7, 9, 10, 5, 10, 'MET', 'MET', false);

  -- Integrationer.
  INSERT INTO "IntegrationApiKeys" ("schoolId", name, "keyHash") VALUES (m, 'Roller nyckel', encode(sha256('roller-key'), 'hex')) RETURNING id INTO ikey;
  INSERT INTO "Ss12000Subscriptions" ("schoolId", "keyId", name, target, "resourceTypes")
  VALUES (m, ikey, 'Roller prenumeration', 'https://roller.example.invalid/hook', ARRAY['Person']) RETURNING id INTO sub;
  INSERT INTO "Ss12000SubscriptionDeliveries" ("schoolId", "subscriptionId", outcome, "durationMs") VALUES (m, sub, 'OK', 10);
  INSERT INTO "Ss12000Sources" ("schoolId", name, "baseUrl", "authKind") VALUES (m, 'Roller källa', 'https://roller.example.invalid', 'BEARER_TOKEN')
  RETURNING id INTO src;
  INSERT INTO "Ss12000SyncRuns" ("schoolId", "sourceId", trigger, mode, status) VALUES (m, src, 'MANUAL', 'FULL', 'RUNNING') RETURNING id INTO run;
  INSERT INTO "Ss12000SyncChanges" ("schoolId", "runId", seq, entity, op, selected) VALUES (m, run, 1, 'PERSON', 'INFO', false);
  INSERT INTO "Ss12000DutyLinks" ("schoolId", "userId", "academicYearId", "ss12000DutyId", "dutyRole", "startDate")
  VALUES (m, teacher, yr, gen_random_uuid(), 'Lärare', '2030-08-15');
  INSERT INTO "SchoolSignInMethods" ("schoolId", provider, domains, "entraTenantId", "ssoOnlyForStaff", "updatedAt") VALUES (m, 'azure', ARRAY['rls-roller.example'], '7b0c2a9e-3c1d-4e5f-8a6b-0c1d2e3f4a5c', false, now());

  -- Beslut: a dataskydd decision, and a gallring run beside it.
  INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision) VALUES (m, 'NOTIFICATIONS', 'KEEP');
  INSERT INTO "GallringRuns" ("schoolId", "localDay", "startedAt") VALUES (m, '2030-09-01', now());

  -- A link removed, so the history has its row.
  INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId") VALUES (m, guardian, pupil2);
  DELETE FROM "GuardianStudents" WHERE "guardianId" = guardian AND "studentId" = pupil2;

  -- A read in the läslogg, which those who decide read (20261026091000).
  INSERT INTO "PersonalDataAccess" ("schoolId", "at", "actorId", "actorRole", channel, kind, "subjectIds", "readSize")
  VALUES (m, now(), teacher, 'TEACHER', 'WEB', 'ROSTER', ARRAY[pupil], 1);
END $$;

-- The läsare of the matrix's school (Läsbehörighet, 20261120100000): an
-- administrator whose profile writes nothing, with and without HR-läs.
-- Planted on their own and only when missing, so a database whose
-- rls-roller-school an older suite made (production's order, main's suite
-- first) gets them too.
DO $$
DECLARE
  m uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-roller-school');
BEGIN
  IF m IS NULL OR EXISTS (SELECT 1 FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000115') THEN
    RETURN;
  END IF;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "hrRead", "authId", "isActive", "updatedAt")
  VALUES
    (m, 'roller-lasare@example.invalid',    'Roller', 'Läsare',    'SCHOOL_ADMIN', 'LASARE', false, '00000000-0000-4000-8000-000000000115', true, now()),
    (m, 'roller-lasare-hr@example.invalid', 'Roller', 'Läsare HR', 'SCHOOL_ADMIN', 'LASARE', true,  '00000000-0000-4000-8000-000000000116', true, now());
END $$;

-- SS12000-närvaro (sections 155–159, 20261114090000). Two schools with a
-- lesson, two pupils' attendance and absences and integration keys: one that
-- has not decided (its admin decides inside the sections' transactions) and
-- one that shares, so a key of either can be held to its own school's rows.
-- A lesson of next year, whose attendance the provider never emits.
DO $$
DECLARE
  today date := current_date;
  s1 uuid;
  s2 uuid;
  y uuid;
  nextYear uuid;
  klass uuid;
  nextClass uuid;
  subj uuid;
  lesson uuid;
  later uuid;
  admin uuid;
  pupil uuid;
  classmate uuid;
  guardian uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM "Schools" WHERE slug = 'rls-narvaro-school') THEN
    RETURN;
  END IF;
  -- Roller i skolan's matrix school (section 116) gets a decision not to share, so the role
  -- matrix has a row of AttendanceSharingDecisions to probe and the school's recorders stay
  -- idle. Here and not in its block: on a database that ran main's fixtures, that block has
  -- already returned.
  INSERT INTO "AttendanceSharingDecisions" ("schoolId", shares, reference)
  SELECT id, false, 'Roller' FROM "Schools" WHERE slug = 'rls-roller-school';
  INSERT INTO "Schools" (name, slug, timezone, "updatedAt")
  VALUES ('RLS Närvaro', 'rls-narvaro-school', 'Europe/Stockholm', now()) RETURNING id INTO s1;
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
  VALUES (s1, 'Närvaro i år', today - 30, today + 300, true, now()) RETURNING id INTO y;
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
  VALUES (s1, 'Närvaro nästa år', today + 330, today + 650, false, now()) RETURNING id INTO nextYear;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt")
  VALUES (s1, y, 'NV7A', 7, now()) RETURNING id INTO klass;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt")
  VALUES (s1, nextYear, 'NV8A', 8, now()) RETURNING id INTO nextClass;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s1, 'narvaro-admin@example.invalid', 'Närvaro', 'Admin', 'SCHOOL_ADMIN', '00000000-0000-4000-8000-000000000150', true, now())
  RETURNING id INTO admin;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s1, 'narvaro-teacher@example.invalid', 'Närvaro', 'Lärare', 'TEACHER', '00000000-0000-4000-8000-000000000151', true, now());
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s1, 'narvaro-guardian@example.invalid', 'Närvaro', 'Vårdnadshavare', 'GUARDIAN', '00000000-0000-4000-8000-000000000152', true, now())
  RETURNING id INTO guardian;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
  VALUES (s1, 'narvaro-pupil@example.invalid', 'Närvaro', 'Elev', 'STUDENT', '00000000-0000-4000-8000-000000000153', true, klass, now())
  RETURNING id INTO pupil;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
  VALUES (s1, 'narvaro-classmate@example.invalid', 'Närvaro', 'Klasskamrat', 'STUDENT', '00000000-0000-4000-8000-000000000154', true, klass, now())
  RETURNING id INTO classmate;
  INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId") VALUES (s1, guardian, pupil);
  INSERT INTO "Subjects" ("schoolId", name, "updatedAt") VALUES (s1, 'NV Matematik', now()) RETURNING id INTO subj;
  INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", status, "updatedAt")
  VALUES (s1, subj, klass, today - 2, (today - 2) + time '08:00', (today - 2) + time '09:00', 'SCHEDULED', now()) RETURNING id INTO lesson;
  INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", status, "updatedAt")
  VALUES (s1, subj, nextClass, today + 340, (today + 340) + time '08:00', (today + 340) + time '09:00', 'SCHEDULED', now()) RETURNING id INTO later;
  INSERT INTO "AttendanceRecords" ("schoolId", "calendarLessonId", "studentId", status, note, "updatedAt") VALUES
    (s1, lesson, pupil, 'PRESENT', 'rls155 anteckning', now()),
    (s1, lesson, classmate, 'ABSENT', 'rls155 anteckning', now()),
    (s1, later, pupil, 'ABSENT', 'rls155 nästa år', now());
  INSERT INTO "AbsenceReports" ("schoolId", "studentId", "reportedById", date, type, note, "grantedLeave") VALUES
    (s1, pupil, guardian, today - 2, 'SICK', 'rls155 feber', false),
    (s1, classmate, admin, today + 5, 'OTHER', 'Approved leave', true);
  INSERT INTO "IntegrationApiKeys" ("schoolId", name, "keyHash", scopes, "revokedAt") VALUES
    (s1, 'NV hel', repeat('a1', 32), '{attendances.read,absences.read}', NULL),
    (s1, 'NV utan', repeat('a2', 32), '{persons.read}', NULL),
    (s1, 'NV återkallad', repeat('a3', 32), '{attendances.read,absences.read}', now()),
    (s1, 'NV frånvaro', repeat('a4', 32), '{absences.read}', NULL);

  INSERT INTO "Schools" (name, slug, timezone, "updatedAt")
  VALUES ('RLS Närvaro delar', 'rls-narvaro-shares', 'Europe/Stockholm', now()) RETURNING id INTO s2;
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
  VALUES (s2, 'Delar i år', today - 30, today + 300, true, now()) RETURNING id INTO y;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt")
  VALUES (s2, y, 'ND7A', 7, now()) RETURNING id INTO klass;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s2, 'narvaro-delar-admin@example.invalid', 'Delar', 'Admin', 'SCHOOL_ADMIN', '00000000-0000-4000-8000-000000000155', true, now())
  RETURNING id INTO admin;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
  VALUES (s2, 'narvaro-delar-pupil@example.invalid', 'Delar', 'Elev', 'STUDENT', '00000000-0000-4000-8000-000000000156', true, klass, now())
  RETURNING id INTO pupil;
  -- Decided before its rows are written, so they are versioned as they come.
  INSERT INTO "AttendanceSharingDecisions" ("schoolId", shares, reference) VALUES (s2, true, 'RLS: delar');
  INSERT INTO "Subjects" ("schoolId", name, "updatedAt") VALUES (s2, 'ND Matematik', now()) RETURNING id INTO subj;
  INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", status, "updatedAt")
  VALUES (s2, subj, klass, today - 2, (today - 2) + time '08:00', (today - 2) + time '09:00', 'SCHEDULED', now()) RETURNING id INTO lesson;
  INSERT INTO "AttendanceRecords" ("schoolId", "calendarLessonId", "studentId", status, "updatedAt") VALUES (s2, lesson, pupil, 'LATE', now());
  INSERT INTO "AbsenceReports" ("schoolId", "studentId", "reportedById", date, type) VALUES (s2, pupil, pupil, today - 2, 'SICK');
  INSERT INTO "IntegrationApiKeys" ("schoolId", name, "keyHash", scopes) VALUES (s2, 'ND hel', repeat('b1', 32), '{attendances.read,absences.read}');
END $$;

-- Lärarens dag (section 160, 20261123090000): the matrix school's teacher
-- has a daily cap of 300 minutes and wishes Fridays free, written here as
-- the owner, with no person signed in, which the cap's trigger lets through.
-- On EVERY run, for the same reason as the närvaro block's decision above:
-- on a database that ran main's fixtures the matrix school's block has
-- already returned. Section 116's probes copy, touch and take this row, as
-- they did the bare one: every profile that writes planering may, and the
-- trigger asks nobody else, since the row is none of theirs.
DO $$
BEGIN
  UPDATE "TeacherWorkRules" w SET "maxTeachingMinutesPerDay" = 300, "preferredFreeDayOfWeek" = 5
    FROM "Users" u
   WHERE u.id = w."userId" AND u."authId" = '00000000-0000-4000-8000-000000000111';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rls-fixtures: the matrix school''s teacher has no work rule to plan';
  END IF;
END $$;

-- The matrix school's skolområden (Skolområden och restid, 20261124090000):
-- two sites, the minutes between them, a room on one. A block of its own,
-- not inside the matrix school's: in production order that block has
-- already run on main and returns at once, and the rows below would never
-- be planted.
DO $$
DECLARE
  m uuid;
BEGIN
  SELECT id INTO m FROM "Schools" WHERE slug = 'rls-roller-school';
  IF m IS NULL OR EXISTS (SELECT 1 FROM "Sites" WHERE "schoolId" = m) THEN
    RETURN;
  END IF;
  INSERT INTO "Sites" ("schoolId", name) VALUES (m, 'Roller Norra'), (m, 'Roller Södra');
  INSERT INTO "SiteTravelTimes" ("schoolId", "siteAId", "siteBId", minutes)
  SELECT m, least(a.id, b.id), greatest(a.id, b.id), 10
    FROM "Sites" a, "Sites" b
   WHERE a."schoolId" = m AND b."schoolId" = m AND a.name = 'Roller Norra' AND b.name = 'Roller Södra';
  UPDATE "Rooms" SET "siteId" = (SELECT id FROM "Sites" WHERE "schoolId" = m AND name = 'Roller Norra')
   WHERE "schoolId" = m AND name = 'Roller 1';
END $$;

-- Schemaförslag (20261125090000): Roller i skolan's matrix school gets a finished run with one
-- candidate, so the role matrix (section 116) has a row of each table to probe. A block of its
-- own that asks for the run, not the school: on a database that ran main's fixtures, the
-- school's block has already returned.
DO $$
DECLARE
  m uuid;
  yr uuid;
  run uuid;
BEGIN
  SELECT id INTO m FROM "Schools" WHERE slug = 'rls-roller-school';
  IF m IS NULL OR EXISTS (SELECT 1 FROM "ScheduleCandidateRuns" WHERE "schoolId" = m) THEN
    RETURN;
  END IF;
  SELECT id INTO yr FROM "AcademicYears" WHERE "schoolId" = m ORDER BY "createdAt" LIMIT 1;
  INSERT INTO "ScheduleCandidateRuns" ("schoolId", "academicYearId", status, requested, progress, basis, "startedAt", "finishedAt")
  VALUES (m, yr, 'SUCCEEDED', 2, 2, repeat('a', 64), now(), now()) RETURNING id INTO run;
  INSERT INTO "ScheduleCandidates" ("runId", "schoolId", ordinal, variant, "solverStatus", lessons)
  VALUES (run, m, 1, 'CLOSE', 'OPTIMAL', '[]');
END $$;

-- Lektionslogg (20261203090000), sections 230–235: a school where each way
-- of standing to a lesson has a person — its own teacher on the lesson (A),
-- its substitute (B), a colleague on none (C), the absent teacher a cover
-- decision was made for (D), and a teacher the grundschema puts on the
-- lesson's master but the published lesson does not have (E): in a school
-- that publishes through a draft, a draft nobody has published — and every
-- other role, with logs and notes planted as the owner; and another school
-- with a log and a note nothing here may reach.
-- Each lesson carries its name in "note", so a section finds it as staff.
DO $$
DECLARE
  s1 uuid;
  s2 uuid;
  y uuid;
  y2 uuid;
  subj uuid;
  subj2 uuid;
  k uuid;
  k2 uuid;
  tg uuid;
  k9 uuid;
  a uuid;
  b uuid;
  c uuid;
  d uuid;
  e uuid;
  f uuid;
  p1 uuid;
  p2 uuid;
  g1 uuid;
  g2 uuid;
  m2 uuid;
  l1 uuid;
  l2 uuid;
  l3 uuid;
  l4 uuid;
  l9 uuid;
  abs uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM "Schools" WHERE slug = 'rls-lektionslogg-school') THEN
    RETURN;
  END IF;
  INSERT INTO "Schools" (name, slug, timezone, "updatedAt")
  VALUES ('RLS Lektionslogg', 'rls-lektionslogg-school', 'Europe/Stockholm', now()) RETURNING id INTO s1;
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
  VALUES (s1, 'Lektionslogg i år', current_date - 30, current_date + 300, true, now()) RETURNING id INTO y;
  INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES (s1, 'Logg ämne', 'RLSLL', now()) RETURNING id INTO subj;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt")
  VALUES (s1, y, 'LL7A', 7, now()) RETURNING id INTO k;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt")
  VALUES (s1, y, 'LL7B', 7, now()) RETURNING id INTO k2;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", kind, "updatedAt")
  VALUES (s1, y, 'LL Spanska', 7, 'TEACHING_GROUP', now()) RETURNING id INTO tg;

  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "updatedAt") VALUES
    (s1, 'lektionslogg-admin@example.invalid', 'Logg', 'Admin', 'SCHOOL_ADMIN', 'FULL', '00000000-0000-4000-8000-000000001300', true, now()),
    (s1, 'lektionslogg-lasare@example.invalid', 'Logg', 'Läsare', 'SCHOOL_ADMIN', 'LASARE', '00000000-0000-4000-8000-000000001308', true, now());
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s1, 'lektionslogg-a@example.invalid', 'Logg', 'Ägare', 'TEACHER', '00000000-0000-4000-8000-000000001301', true, now()) RETURNING id INTO a;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s1, 'lektionslogg-b@example.invalid', 'Logg', 'Vikarie', 'TEACHER', '00000000-0000-4000-8000-000000001302', true, now()) RETURNING id INTO b;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s1, 'lektionslogg-c@example.invalid', 'Logg', 'Kollega', 'TEACHER', '00000000-0000-4000-8000-000000001303', true, now()) RETURNING id INTO c;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s1, 'lektionslogg-d@example.invalid', 'Logg', 'Frånvarande', 'TEACHER', '00000000-0000-4000-8000-000000001309', true, now()) RETURNING id INTO d;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s1, 'lektionslogg-e@example.invalid', 'Logg', 'Grundschema', 'TEACHER', '00000000-0000-4000-8000-000000001310', true, now()) RETURNING id INTO e;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s1, 'lektionslogg-f@example.invalid', 'Logg', 'Medlärare', 'TEACHER', '00000000-0000-4000-8000-000000001312', true, now()) RETURNING id INTO f;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
  VALUES (s1, 'lektionslogg-p1@example.invalid', 'Logg', 'Elev Ett', 'STUDENT', '00000000-0000-4000-8000-000000001304', true, k, now()) RETURNING id INTO p1;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
  VALUES (s1, 'lektionslogg-p2@example.invalid', 'Logg', 'Elev Två', 'STUDENT', '00000000-0000-4000-8000-000000001306', true, k2, now()) RETURNING id INTO p2;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s1, 'lektionslogg-g1@example.invalid', 'Logg', 'Vårdnadshavare Ett', 'GUARDIAN', '00000000-0000-4000-8000-000000001305', true, now()) RETURNING id INTO g1;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s1, 'lektionslogg-g2@example.invalid', 'Logg', 'Vårdnadshavare Två', 'GUARDIAN', '00000000-0000-4000-8000-000000001307', true, now()) RETURNING id INTO g2;
  INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId") VALUES (s1, g1, p1), (s1, g2, p2);
  INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES (s1, tg, p1);

  INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "dayOfWeek", "startTime", "endTime", "updatedAt")
  VALUES (s1, y, subj, k2, e, 2, '09:00', '10:00', now()) RETURNING id INTO m2;
  -- L1: 7A's, A its teacher, F its co-teacher (ASSISTANT) and B its substitute.
  INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", note, "updatedAt")
  VALUES (s1, subj, k, current_date + 1, (current_date + 1) + time '07:00', (current_date + 1) + time '08:00', 'LL-1', now()) RETURNING id INTO l1;
  -- L2: 7B's, of a master lesson the grundschema gives E; the published lesson has only B, its substitute.
  INSERT INTO "CalendarLessons" ("schoolId", "masterLessonId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", note, "updatedAt")
  VALUES (s1, m2, subj, k2, current_date + 2, (current_date + 2) + time '07:00', (current_date + 2) + time '08:00', 'LL-2', now()) RETURNING id INTO l2;
  -- L3: 7B's, covered by B for D's absence (a cover decision names D).
  INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", note, "updatedAt")
  VALUES (s1, subj, k2, current_date + 3, (current_date + 3) + time '07:00', (current_date + 3) + time '08:00', 'LL-3', now()) RETURNING id INTO l3;
  -- L4: the teaching group's (P1 is in it), A its teacher.
  INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", note, "updatedAt")
  VALUES (s1, subj, tg, current_date + 4, (current_date + 4) + time '07:00', (current_date + 4) + time '08:00', 'LL-4', now()) RETURNING id INTO l4;
  INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role) VALUES
    (s1, l1, a, 'LEAD'), (s1, l1, f, 'ASSISTANT'), (s1, l1, b, 'SUBSTITUTE'), (s1, l2, b, 'SUBSTITUTE'), (s1, l3, b, 'SUBSTITUTE'),
    (s1, l4, a, 'LEAD');
  INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt")
  VALUES (s1, d, (current_date + 3) + time '00:00', (current_date + 4) + time '00:00') RETURNING id INTO abs;
  INSERT INTO "TeacherAbsenceCovers" ("schoolId", "absenceId", "calendarLessonId", "absentTeacherId", decision, "substituteId", "removedTeachers")
  VALUES (s1, abs, l3, d, 'SUBSTITUTE', b, jsonb_build_array(jsonb_build_object('teacherId', d, 'role', 'LEAD')));

  -- Written by the owner, so the trigger keeps the writer it is given.
  INSERT INTO "LessonLogs" ("schoolId", "calendarLessonId", topic, homework, "writtenById") VALUES
    (s1, l1, 'LL ett', 'Läxa ett', a),
    (s1, l2, 'LL två', NULL, e),
    (s1, l4, NULL, 'Läxa fyra', a);
  INSERT INTO "LessonSubstituteNotes" ("schoolId", "calendarLessonId", body, "writtenById") VALUES
    (s1, l1, 'LL notis ett', a),
    (s1, l2, 'LL notis två', e),
    (s1, l3, 'LL notis tre', d);

  INSERT INTO "Schools" (name, slug, timezone, "updatedAt")
  VALUES ('RLS Lektionslogg annan', 'rls-lektionslogg-annan', 'Europe/Stockholm', now()) RETURNING id INTO s2;
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
  VALUES (s2, 'Annan i år', current_date - 30, current_date + 300, true, now()) RETURNING id INTO y2;
  INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES (s2, 'Annat ämne', 'RLSLA', now()) RETURNING id INTO subj2;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt")
  VALUES (s2, y2, 'Annan 7A', 7, now()) RETURNING id INTO k9;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "updatedAt")
  VALUES (s2, 'lektionslogg-annan-admin@example.invalid', 'Annan', 'Admin', 'SCHOOL_ADMIN', 'FULL', '00000000-0000-4000-8000-000000001311', true, now());
  INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", note, "updatedAt")
  VALUES (s2, subj2, k9, current_date + 1, (current_date + 1) + time '07:00', (current_date + 1) + time '08:00', 'LL-9', now()) RETURNING id INTO l9;
  -- And one with nothing on it: a key to it from this school is the composite key's to refuse.
  INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", note, "updatedAt")
  VALUES (s2, subj2, k9, current_date + 2, (current_date + 2) + time '07:00', (current_date + 2) + time '08:00', 'LL-9b', now());
  INSERT INTO "LessonLogs" ("schoolId", "calendarLessonId", topic) VALUES (s2, l9, 'LL annan');
  INSERT INTO "LessonSubstituteNotes" ("schoolId", "calendarLessonId", body) VALUES (s2, l9, 'LL annan notis');
END $$;

-- The matrix school's lesson log and note (Lektionslogg, 20261203090000): the log so the
-- role matrix (section 116) has a row to probe, the note so section 232 can show that no
-- administrator of any profile reads it. A block of its own: on a database that ran main's
-- fixtures, the school's block has already returned.
DO $$
DECLARE
  m uuid;
  cl uuid;
BEGIN
  SELECT id INTO m FROM "Schools" WHERE slug = 'rls-roller-school';
  IF m IS NULL OR EXISTS (SELECT 1 FROM "LessonLogs" WHERE "schoolId" = m) THEN
    RETURN;
  END IF;
  SELECT id INTO cl FROM "CalendarLessons" WHERE "schoolId" = m AND date = '2030-09-02';
  INSERT INTO "LessonLogs" ("schoolId", "calendarLessonId", topic, homework) VALUES (m, cl, 'Roller ämne', 'Roller läxa');
  INSERT INTO "LessonSubstituteNotes" ("schoolId", "calendarLessonId", body) VALUES (m, cl, 'Roller notis');
END $$;

-- Flera skolor per inloggning (20261204090000): logins with a row in more
-- than one school, for sections 240-244. A login with no school named
-- resolves to the row that took the login first ("loginSince", which the
-- trigger stamps as each row is inserted here, in this list's order), so
-- "older" below is the row inserted first. A row takes a login another row
-- holds only with app.login_join naming it (the gateway's invitation), which
-- the owner sets here row by row.
--
--   …0240  FULL at school A (older), LASARE in rls-roller-school
--   …0241  LASARE at school A (older), FULL in rls-roller-school
--   …0242  a deactivated admin at school A (older), a teacher in rls-roller-school
--   …0243  a guardian at school A (older) and in rls-roller-school, a child at each
--   …0244  a teacher at school A (older) and at school B (rls-fixture-school,
--          whose staff must sign in with the school account)
--   …0245  a deactivated teacher at school A (older), a teacher at school B
--   …0246  a teacher at school A (older) and in rls-roller-school, whose row
--          there was created before school A's but took the login after it
--   …0247  a teacher at school A (older), a deactivated teacher at school B
--   …0248  a pupil at school A (older) and in rls-roller-school, in a class
--          at each
DO $$
DECLARE
  a uuid := (SELECT id FROM "Schools" WHERE slug <> 'rls-fixture-school' ORDER BY "createdAt" LIMIT 1);
  b uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-fixture-school');
  m uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-roller-school');
  row_id uuid;
  rec record;
BEGIN
  IF EXISTS (SELECT 1 FROM "Users" WHERE "authId" = 'fe000000-0000-4000-8000-000000000240') THEN
    RETURN;
  END IF;
  IF a IS NULL OR b IS NULL OR m IS NULL THEN
    RAISE EXCEPTION 'flera skolor: schools A, B and rls-roller-school must exist first';
  END IF;

  FOR rec IN
    SELECT * FROM (VALUES
      ('fe000000-0000-4000-8000-000000000240'::uuid, a, 'SCHOOL_ADMIN'::"UserRole", 'FULL'::"AdminProfile",   true,  timestamptz '2026-01-01', 'flera-m1-a'),
      ('fe000000-0000-4000-8000-000000000240'::uuid, m, 'SCHOOL_ADMIN',             'LASARE',                 true,  timestamptz '2026-02-01', 'flera-m1-m'),
      ('fe000000-0000-4000-8000-000000000241'::uuid, a, 'SCHOOL_ADMIN',             'LASARE',                 true,  timestamptz '2026-01-01', 'flera-m2-a'),
      ('fe000000-0000-4000-8000-000000000241'::uuid, m, 'SCHOOL_ADMIN',             'FULL',                   true,  timestamptz '2026-02-01', 'flera-m2-m'),
      ('fe000000-0000-4000-8000-000000000242'::uuid, a, 'SCHOOL_ADMIN',             'FULL',                   false, timestamptz '2026-01-01', 'flera-m3-a'),
      ('fe000000-0000-4000-8000-000000000242'::uuid, m, 'TEACHER',                  NULL,                     true,  timestamptz '2026-02-01', 'flera-m3-m'),
      ('fe000000-0000-4000-8000-000000000243'::uuid, a, 'GUARDIAN',                 NULL,                     true,  timestamptz '2026-01-01', 'flera-g-a'),
      ('fe000000-0000-4000-8000-000000000243'::uuid, m, 'GUARDIAN',                 NULL,                     true,  timestamptz '2026-02-01', 'flera-g-m'),
      ('fe000000-0000-4000-8000-000000000244'::uuid, a, 'TEACHER',                  NULL,                     true,  timestamptz '2026-01-01', 'flera-t-a'),
      ('fe000000-0000-4000-8000-000000000244'::uuid, b, 'TEACHER',                  NULL,                     true,  timestamptz '2026-02-01', 'flera-t-b'),
      ('fe000000-0000-4000-8000-000000000245'::uuid, a, 'TEACHER',                  NULL,                     false, timestamptz '2026-01-01', 'flera-u-a'),
      ('fe000000-0000-4000-8000-000000000245'::uuid, b, 'TEACHER',                  NULL,                     true,  timestamptz '2026-02-01', 'flera-u-b'),
      ('fe000000-0000-4000-8000-000000000246'::uuid, a, 'TEACHER',                  NULL,                     true,  timestamptz '2026-03-01', 'flera-l-a'),
      ('fe000000-0000-4000-8000-000000000246'::uuid, m, 'TEACHER',                  NULL,                     true,  timestamptz '2025-01-01', 'flera-l-m'),
      ('fe000000-0000-4000-8000-000000000247'::uuid, a, 'TEACHER',                  NULL,                     true,  timestamptz '2026-01-01', 'flera-v-a'),
      ('fe000000-0000-4000-8000-000000000247'::uuid, b, 'TEACHER',                  NULL,                     false, timestamptz '2026-02-01', 'flera-v-b'),
      ('fe000000-0000-4000-8000-000000000248'::uuid, a, 'STUDENT',                  NULL,                     true,  timestamptz '2026-01-01', 'flera-p-a'),
      ('fe000000-0000-4000-8000-000000000248'::uuid, m, 'STUDENT',                  NULL,                     true,  timestamptz '2026-02-01', 'flera-p-m')
    ) v(auth_id, school, role, profile, active, created, label)
  LOOP
    row_id := gen_random_uuid();
    PERFORM set_config('app.login_join', row_id::text, true);
    INSERT INTO "Users" (id, "schoolId", email, "firstName", "lastName", role, "adminProfile", "authId",
                         "isActive", "invitedAt", "createdAt", "updatedAt")
    VALUES (row_id, rec.school, rec.label || '@example.invalid', 'Flera', rec.label, rec.role, rec.profile,
            rec.auth_id, true, rec.created, rec.created, now());
    IF NOT rec.active THEN
      UPDATE "Users" SET "isActive" = false WHERE id = row_id;
    END IF;
  END LOOP;
  PERFORM set_config('app.login_join', '', true);

  -- The pupil's classes: a class at A that one of A's pupils is in, and the
  -- roller school's pupil's (…0112), so that current_user_group_id has a
  -- different answer at each school.
  UPDATE "Users" SET "studentGroupId" = (
      SELECT g.id FROM "StudentGroups" g
       WHERE g."schoolId" = a AND EXISTS (SELECT 1 FROM "Users" p WHERE p."studentGroupId" = g.id)
       ORDER BY g.name, g.id LIMIT 1)
   WHERE "authId" = 'fe000000-0000-4000-8000-000000000248' AND "schoolId" = a;
  UPDATE "Users" SET "studentGroupId" = coalesce(
      (SELECT "studentGroupId" FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000112'),
      (SELECT g.id FROM "StudentGroups" g WHERE g."schoolId" = m ORDER BY g.name, g.id LIMIT 1))
   WHERE "authId" = 'fe000000-0000-4000-8000-000000000248' AND "schoolId" = m;

  -- The guardian's children: school A's first active pupil, and the
  -- roller school's pupil (…0112).
  INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId")
  SELECT a, g.id, (SELECT id FROM "Users" WHERE "schoolId" = a AND role = 'STUDENT' AND "isActive" ORDER BY "authId" LIMIT 1)
    FROM "Users" g WHERE g."authId" = 'fe000000-0000-4000-8000-000000000243' AND g."schoolId" = a;
  INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId")
  SELECT m, g.id, (SELECT id FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000112')
    FROM "Users" g WHERE g."authId" = 'fe000000-0000-4000-8000-000000000243' AND g."schoolId" = m;
END $$;

-- Delade lektioner (20261205090000), sections 205–207: a school whose
-- matematik 9A has three lessons, one of them Bo's, and every role; the
-- roller school's post (section 116's matrix) gets a share too, so the matrix
-- has a row to probe and this school's admin a foreign share to not see.
-- Blocks of their own, each asking for what it plants: on a database that ran
-- main's fixtures, the roller school's block has already returned.
DO $$
DECLARE
  m uuid;
  post uuid;
  other uuid;
BEGIN
  SELECT id INTO m FROM "Schools" WHERE slug = 'rls-roller-school';
  IF m IS NULL OR EXISTS (SELECT 1 FROM "TeachingRequirementShares" WHERE "schoolId" = m) THEN
    RETURN;
  END IF;
  -- The school's one post (section 110 counts it), given a second lesson to share.
  SELECT id INTO post FROM "TeachingRequirements" WHERE "schoolId" = m ORDER BY "createdAt" LIMIT 1;
  UPDATE "TeachingRequirements" SET "lessonsPerWeek" = 2 WHERE id = post;
  -- The full administrator teaches the share: a small school's rektor often does.
  SELECT id INTO other FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000105';
  INSERT INTO "TeachingRequirementShares" ("schoolId", "requirementId", "teacherId", lessons, minutes, "updatedAt")
  VALUES (m, post, other, 1, 60, now());
END $$;

DO $$
DECLARE
  s1 uuid;
  yr uuid;
  subj uuid;
  klass uuid;
  anna uuid;
  bo uuid;
  cilla uuid;
  pupil uuid;
  post uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM "Schools" WHERE slug = 'rls-delade-school') THEN
    RETURN;
  END IF;
  INSERT INTO "Schools" (name, slug, "updatedAt") VALUES ('RLS Delade', 'rls-delade-school', now()) RETURNING id INTO s1;
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
  VALUES (s1, 'Delade 2030/31', '2030-08-15', '2031-06-15', true, now()) RETURNING id INTO yr;
  INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES (s1, 'Delade matematik', 'DLMA', now()) RETURNING id INTO subj;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt")
  VALUES (s1, yr, 'DL9A', 9, now()) RETURNING id INTO klass;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "updatedAt")
  VALUES
    (s1, 'delade-admin@example.invalid', 'Delade', 'Admin',      'SCHOOL_ADMIN', 'FULL',       '00000000-0000-4000-8000-000000002051', true, now()),
    (s1, 'delade-exp@example.invalid',   'Delade', 'Expedition', 'SCHOOL_ADMIN', 'EXPEDITION', '00000000-0000-4000-8000-000000002052', true, now());
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s1, 'delade-anna@example.invalid', 'Anna', 'Delade', 'TEACHER', '00000000-0000-4000-8000-000000002053', true, now())
  RETURNING id INTO anna;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s1, 'delade-bo@example.invalid', 'Bo', 'Delade', 'TEACHER', '00000000-0000-4000-8000-000000002054', true, now())
  RETURNING id INTO bo;
  -- Cilla teaches nothing yet: the teacher sections 206–207 give a share to and delete.
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s1, 'delade-cilla@example.invalid', 'Cilla', 'Delade', 'TEACHER', '00000000-0000-4000-8000-000000002055', true, now())
  RETURNING id INTO cilla;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
  VALUES (s1, 'delade-pupil@example.invalid', 'Delade', 'Elev', 'STUDENT', '00000000-0000-4000-8000-000000002056', true, klass, now())
  RETURNING id INTO pupil;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s1, 'delade-guardian@example.invalid', 'Delade', 'Vårdnadshavare', 'GUARDIAN', '00000000-0000-4000-8000-000000002057', true, now());
  INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId")
  SELECT s1, id, pupil FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000002057';
  INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "minutesPerLesson", "updatedAt")
  VALUES (s1, yr, subj, klass, anna, 3, 60, now()) RETURNING id INTO post;
  INSERT INTO "TeachingRequirementShares" ("schoolId", "requirementId", "teacherId", lessons, minutes, "updatedAt")
  VALUES (s1, post, bo, 1, 60, now());
END $$;

-- Rastvaktsschema (20261207090000), sections 200–203: a school with a site,
-- two rastvaktsområden, two teachers with passes and every role; and another
-- school with an area and a pass of its own that nothing here may reach.
DO $$
DECLARE
  s1 uuid;
  s2 uuid;
  y uuid;
  y2 uuid;
  klass uuid;
  pupil uuid;
  guardian uuid;
  anna uuid;
  bo uuid;
  other uuid;
  site uuid;
  garden uuid;
  hall uuid;
  away uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM "Schools" WHERE slug = 'rls-rastvakt-school') THEN
    RETURN;
  END IF;
  INSERT INTO "Schools" (name, slug, timezone, "updatedAt")
  VALUES ('RLS Rastvakt', 'rls-rastvakt-school', 'Europe/Stockholm', now()) RETURNING id INTO s1;
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
  VALUES (s1, 'Rastvakt 2030/31', DATE '2030-08-15', DATE '2031-06-13', true, now()) RETURNING id INTO y;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt")
  VALUES (s1, y, 'RV1A', 1, now()) RETURNING id INTO klass;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "updatedAt") VALUES
    (s1, 'rastvakt-admin@example.invalid', 'Rastvakt', 'Admin', 'SCHOOL_ADMIN', 'FULL', '00000000-0000-4000-8000-000000002020', true, now()),
    (s1, 'rastvakt-exp@example.invalid', 'Rastvakt', 'Expedition', 'SCHOOL_ADMIN', 'EXPEDITION', '00000000-0000-4000-8000-000000002024', true, now());
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s1, 'rastvakt-anna@example.invalid', 'Rastvakt', 'Anna', 'TEACHER', '00000000-0000-4000-8000-000000002021', true, now())
  RETURNING id INTO anna;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s1, 'rastvakt-bo@example.invalid', 'Rastvakt', 'Bo', 'TEACHER', '00000000-0000-4000-8000-000000002026', true, now())
  RETURNING id INTO bo;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
  VALUES (s1, 'rastvakt-pupil@example.invalid', 'Rastvakt', 'Elev', 'STUDENT', '00000000-0000-4000-8000-000000002022', true, klass, now())
  RETURNING id INTO pupil;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s1, 'rastvakt-guardian@example.invalid', 'Rastvakt', 'Vårdnadshavare', 'GUARDIAN', '00000000-0000-4000-8000-000000002023', true, now())
  RETURNING id INTO guardian;
  INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId") VALUES (s1, guardian, pupil);
  INSERT INTO "Sites" ("schoolId", name) VALUES (s1, 'RV Norra') RETURNING id INTO site;
  INSERT INTO "SupervisionAreas" ("schoolId", name, "siteId", "minGradeLevel", "maxGradeLevel")
  VALUES (s1, 'RV Skolgården', site, 0, 3) RETURNING id INTO garden;
  INSERT INTO "SupervisionAreas" ("schoolId", name, "duringRasts", "duringLunch", "guardsNeeded", "countsAsTeaching")
  VALUES (s1, 'RV Matsalen', false, true, 2, true) RETURNING id INTO hall;
  -- Anna on the yard every Monday and in the autumn's Tuesdays (dated on
  -- the weekday, its first and last, as the table holds a pass's dates);
  -- Bo in the hall.
  INSERT INTO "SupervisionShifts" ("schoolId", "academicYearId", "areaId", "userId", "dayOfWeek", "startTime", "endTime", "validFrom", "validTo") VALUES
    (s1, y, garden, anna, 1, '10:00', '10:20', NULL, NULL),
    (s1, y, garden, anna, 2, '10:00', '10:20', DATE '2030-09-03', DATE '2030-12-17'),
    (s1, y, hall, bo, 1, '11:00', '11:30', NULL, NULL);

  INSERT INTO "Schools" (name, slug, timezone, "updatedAt")
  VALUES ('RLS Rastvakt annan', 'rls-rastvakt-annan', 'Europe/Stockholm', now()) RETURNING id INTO s2;
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
  VALUES (s2, 'Annan 2030/31', DATE '2030-08-15', DATE '2031-06-13', true, now()) RETURNING id INTO y2;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "updatedAt")
  VALUES (s2, 'rastvakt-annan-admin@example.invalid', 'Annan', 'Admin', 'SCHOOL_ADMIN', 'FULL', '00000000-0000-4000-8000-000000002025', true, now());
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s2, 'rastvakt-annan-teacher@example.invalid', 'Annan', 'Lärare', 'TEACHER', '00000000-0000-4000-8000-000000002027', true, now())
  RETURNING id INTO other;
  INSERT INTO "SupervisionAreas" ("schoolId", name) VALUES (s2, 'Annan gård') RETURNING id INTO away;
  INSERT INTO "SupervisionShifts" ("schoolId", "academicYearId", "areaId", "userId", "dayOfWeek", "startTime", "endTime")
  VALUES (s2, y2, away, other, 1, '10:00', '10:20');
END $$;

-- The matrix school's rastvaktsschema (Rastvaktsschema, 20261207090000): an
-- area and a pass of its teacher, so section 116 has a row of each to probe.
-- A block of its own, for the reason the skolområden's is.
DO $$
DECLARE
  m uuid;
  yr uuid;
  teacher uuid;
  area uuid;
BEGIN
  SELECT id INTO m FROM "Schools" WHERE slug = 'rls-roller-school';
  IF m IS NULL OR EXISTS (SELECT 1 FROM "SupervisionAreas" WHERE "schoolId" = m) THEN
    RETURN;
  END IF;
  SELECT id INTO yr FROM "AcademicYears" WHERE "schoolId" = m ORDER BY "createdAt" LIMIT 1;
  SELECT id INTO teacher FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000111';
  INSERT INTO "SupervisionAreas" ("schoolId", name) VALUES (m, 'Roller gården') RETURNING id INTO area;
  INSERT INTO "SupervisionShifts" ("schoolId", "academicYearId", "areaId", "userId", "dayOfWeek", "startTime", "endTime")
  VALUES (m, yr, area, teacher, 1, '10:00', '10:20');
END $$;

-- Rastvakt i vardagen (20261210090000), sections 210–213: Anna is away
-- Monday 2 September 2030 and Bo takes her Monday pass on the yard; Bo is
-- away Monday 9 September and his pass in the hall is left without a
-- vikarie; the other school's teacher is away on the 2nd and their pass is
-- left without one. And the matrix school's teacher is away on Monday the
-- 9th and their pass on Roller gården is left without one, so section 116
-- has a row to probe. A block of its own: it plants into schools the blocks above made.
DO $$
DECLARE
  s1 uuid;
  s2 uuid;
  anna uuid;
  bo uuid;
  other uuid;
  pass uuid;
  hall_pass uuid;
  other_pass uuid;
  garden uuid;
  hall uuid;
  away uuid;
  a uuid;
  b uuid;
  o uuid;
  m uuid;
  m_teacher uuid;
  m_pass uuid;
  m_area uuid;
  m_absence uuid;
BEGIN
  SELECT id INTO s1 FROM "Schools" WHERE slug = 'rls-rastvakt-school';
  IF s1 IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "SupervisionCovers" WHERE "schoolId" = s1) THEN
    SELECT id INTO s2 FROM "Schools" WHERE slug = 'rls-rastvakt-annan';
    SELECT id INTO anna FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000002021';
    SELECT id INTO bo FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000002026';
    SELECT id INTO other FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000002027';
    SELECT id, "areaId" INTO pass, garden FROM "SupervisionShifts" WHERE "userId" = anna AND "dayOfWeek" = 1;
    SELECT id, "areaId" INTO hall_pass, hall FROM "SupervisionShifts" WHERE "userId" = bo;
    SELECT id, "areaId" INTO other_pass, away FROM "SupervisionShifts" WHERE "userId" = other;
    INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt")
    VALUES (s1, anna, timestamptz '2030-09-01 22:00 UTC', timestamptz '2030-09-02 22:00 UTC') RETURNING id INTO a;
    INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt")
    VALUES (s1, bo, timestamptz '2030-09-08 22:00 UTC', timestamptz '2030-09-09 22:00 UTC') RETURNING id INTO b;
    INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt")
    VALUES (s2, other, timestamptz '2030-09-01 22:00 UTC', timestamptz '2030-09-02 22:00 UTC') RETURNING id INTO o;
    INSERT INTO "SupervisionCovers" ("schoolId", "shiftId", date, "areaId", "startsAt", "endsAt", "absenceId", "absentTeacherId", decision, "substituteId") VALUES
      (s1, pass, DATE '2030-09-02', garden, timestamptz '2030-09-02 08:00 UTC', timestamptz '2030-09-02 08:20 UTC', a, anna, 'SUBSTITUTE', bo),
      (s1, hall_pass, DATE '2030-09-09', hall, timestamptz '2030-09-09 09:00 UTC', timestamptz '2030-09-09 09:30 UTC', b, bo, 'NO_COVER', NULL),
      (s2, other_pass, DATE '2030-09-02', away, timestamptz '2030-09-02 08:00 UTC', timestamptz '2030-09-02 08:20 UTC', o, other, 'NO_COVER', NULL);
  END IF;

  SELECT id INTO m FROM "Schools" WHERE slug = 'rls-roller-school';
  IF m IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "SupervisionCovers" WHERE "schoolId" = m) THEN
    SELECT id, "userId", "areaId" INTO m_pass, m_teacher, m_area FROM "SupervisionShifts" WHERE "schoolId" = m ORDER BY "createdAt", id LIMIT 1;
    IF m_pass IS NOT NULL THEN
      -- The 9th: the matrix's own absence fixture holds the 2nd.
      INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt")
      VALUES (m, m_teacher, timestamptz '2030-09-08 22:00 UTC', timestamptz '2030-09-09 22:00 UTC') RETURNING id INTO m_absence;
      INSERT INTO "SupervisionCovers" ("schoolId", "shiftId", date, "areaId", "startsAt", "endsAt", "absenceId", "absentTeacherId", decision)
      VALUES (m, m_pass, DATE '2030-09-09', m_area, timestamptz '2030-09-09 08:00 UTC', timestamptz '2030-09-09 08:20 UTC', m_absence, m_teacher, 'NO_COVER');
    END IF;
  END IF;
END $$;
-- En elev i en tillagd undervisningsgrupp (20261208090000), sections 250–251:
-- 7B's svenska with the teaching group SvA7 joined to it (TG-1), a 7A pupil
-- in SvA7 (P1), a 7A pupil in no group (P2), a 7B pupil (P3), and each one's
-- guardian; 7B's other lessons — one with nothing joined (TG-2), one with
-- another teaching group joined that P1 is not in (TG-3); and another school
-- with its own SvA7 joined to its own lesson (TG-9) and a pupil in it (Q).
-- TG-1 and TG-9 carry a log. Each lesson carries its name in "note".
-- Neither key of StudentGroupMembers nor of CalendarLessonGroups is composite
-- with "schoolId", so the other school also holds two rows that point here
-- (20260822120000 tells how a request could write them): Q in this school's
-- SvA7, and TG-2 with Q's SvA7 joined; and this school holds one naming Q, in
-- its Spanska. And a guardian here (G4) stands in SvA7 by a catalogue error.
-- Last läsår (y0): 6B's lesson TG-0 with SvA6 joined and a log, and a 7A
-- pupil (P5) still in SvA6, as the rollover leaves a membership, with their
-- guardian (G5); a deactivated 7A pupil in SvA7 (P6); and three logins with
-- a row at each school, this school's taking the login first: a pupil here
-- and a teacher there (M1), a pupil at both (M2), a guardian here standing in
-- SvA7 and a pupil there (M3), the other school's pupil rows in its SvA7.
DO $$
DECLARE
  s1 uuid;
  s2 uuid;
  y uuid;
  y2 uuid;
  subj uuid;
  subj2 uuid;
  k7a uuid;
  k7b uuid;
  sva uuid;
  spa uuid;
  k9 uuid;
  sva9 uuid;
  t uuid;
  p1 uuid;
  p2 uuid;
  p3 uuid;
  g1 uuid;
  g2 uuid;
  g3 uuid;
  g4 uuid;
  q uuid;
  l1 uuid;
  l2 uuid;
  l3 uuid;
  l9 uuid;
  y0 uuid;
  k6b uuid;
  sva6 uuid;
  l0 uuid;
  p5 uuid;
  g5 uuid;
  p6 uuid;
  row_id uuid;
  rec record;
BEGIN
  IF EXISTS (SELECT 1 FROM "Schools" WHERE slug = 'rls-tillagd-grupp-school') THEN
    RETURN;
  END IF;
  INSERT INTO "Schools" (name, slug, timezone, "updatedAt")
  VALUES ('RLS Tillagd grupp', 'rls-tillagd-grupp-school', 'Europe/Stockholm', now()) RETURNING id INTO s1;
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
  VALUES (s1, 'Tillagd grupp i år', current_date - 30, current_date + 300, true, now()) RETURNING id INTO y;
  INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES (s1, 'Svenska', 'RLSTG', now()) RETURNING id INTO subj;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt")
  VALUES (s1, y, 'TG7A', 7, now()) RETURNING id INTO k7a;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt")
  VALUES (s1, y, 'TG7B', 7, now()) RETURNING id INTO k7b;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", kind, "updatedAt")
  VALUES (s1, y, 'TG SvA7', 7, 'TEACHING_GROUP', now()) RETURNING id INTO sva;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", kind, "updatedAt")
  VALUES (s1, y, 'TG Spanska', 7, 'TEACHING_GROUP', now()) RETURNING id INTO spa;

  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "updatedAt")
  VALUES (s1, 'tillagd-admin@example.invalid', 'Tillagd', 'Admin', 'SCHOOL_ADMIN', 'FULL', '00000000-0000-4000-8000-000000001400', true, now());
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s1, 'tillagd-larare@example.invalid', 'Tillagd', 'Lärare', 'TEACHER', '00000000-0000-4000-8000-000000001401', true, now()) RETURNING id INTO t;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
  VALUES (s1, 'tillagd-p1@example.invalid', 'Tillagd', 'Elev SvA', 'STUDENT', '00000000-0000-4000-8000-000000001402', true, k7a, now()) RETURNING id INTO p1;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
  VALUES (s1, 'tillagd-p2@example.invalid', 'Tillagd', 'Elev 7A', 'STUDENT', '00000000-0000-4000-8000-000000001403', true, k7a, now()) RETURNING id INTO p2;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
  VALUES (s1, 'tillagd-p3@example.invalid', 'Tillagd', 'Elev 7B', 'STUDENT', '00000000-0000-4000-8000-000000001404', true, k7b, now()) RETURNING id INTO p3;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s1, 'tillagd-g1@example.invalid', 'Tillagd', 'Vårdnadshavare SvA', 'GUARDIAN', '00000000-0000-4000-8000-000000001405', true, now()) RETURNING id INTO g1;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s1, 'tillagd-g2@example.invalid', 'Tillagd', 'Vårdnadshavare 7A', 'GUARDIAN', '00000000-0000-4000-8000-000000001406', true, now()) RETURNING id INTO g2;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s1, 'tillagd-g3@example.invalid', 'Tillagd', 'Vårdnadshavare 7B', 'GUARDIAN', '00000000-0000-4000-8000-000000001407', true, now()) RETURNING id INTO g3;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s1, 'tillagd-g4@example.invalid', 'Tillagd', 'Vårdnadshavare i SvA', 'GUARDIAN', '00000000-0000-4000-8000-000000001410', true, now()) RETURNING id INTO g4;
  INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId") VALUES (s1, g1, p1), (s1, g2, p2), (s1, g3, p3);
  INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES (s1, sva, p1), (s1, sva, g4);

  -- TG-1: 7B's svenska, SvA7 joined.
  INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", note, "updatedAt")
  VALUES (s1, subj, k7b, current_date + 1, (current_date + 1) + time '08:00', (current_date + 1) + time '09:00', 'TG-1', now()) RETURNING id INTO l1;
  -- TG-2: 7B's, nothing joined.
  INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", note, "updatedAt")
  VALUES (s1, subj, k7b, current_date + 2, (current_date + 2) + time '08:00', (current_date + 2) + time '09:00', 'TG-2', now()) RETURNING id INTO l2;
  -- TG-3: 7B's, Spanska joined (P1 is not in it).
  INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", note, "updatedAt")
  VALUES (s1, subj, k7b, current_date + 3, (current_date + 3) + time '08:00', (current_date + 3) + time '09:00', 'TG-3', now()) RETURNING id INTO l3;
  INSERT INTO "CalendarLessonGroups" ("schoolId", "calendarLessonId", "studentGroupId") VALUES (s1, l1, sva), (s1, l3, spa);
  INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role) VALUES
    (s1, l1, t, 'LEAD'), (s1, l2, t, 'LEAD'), (s1, l3, t, 'LEAD');
  -- Written by the owner, so the trigger keeps the writer it is given.
  INSERT INTO "LessonLogs" ("schoolId", "calendarLessonId", topic, homework, "writtenById")
  VALUES (s1, l1, 'TG ett', 'TG läxa ett', t);

  INSERT INTO "Schools" (name, slug, timezone, "updatedAt")
  VALUES ('RLS Tillagd grupp annan', 'rls-tillagd-grupp-annan', 'Europe/Stockholm', now()) RETURNING id INTO s2;
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
  VALUES (s2, 'Annan i år', current_date - 30, current_date + 300, true, now()) RETURNING id INTO y2;
  INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES (s2, 'Annan svenska', 'RLSTGA', now()) RETURNING id INTO subj2;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt")
  VALUES (s2, y2, 'Annan TG7B', 7, now()) RETURNING id INTO k9;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", kind, "updatedAt")
  VALUES (s2, y2, 'Annan TG SvA7', 7, 'TEACHING_GROUP', now()) RETURNING id INTO sva9;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "updatedAt")
  VALUES (s2, 'tillagd-annan-admin@example.invalid', 'Annan', 'Admin', 'SCHOOL_ADMIN', 'FULL', '00000000-0000-4000-8000-000000001409', true, now());
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s2, 'tillagd-annan-q@example.invalid', 'Annan', 'Elev SvA', 'STUDENT', '00000000-0000-4000-8000-000000001408', true, now()) RETURNING id INTO q;
  INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES (s2, sva9, q);
  INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", note, "updatedAt")
  VALUES (s2, subj2, k9, current_date + 1, (current_date + 1) + time '08:00', (current_date + 1) + time '09:00', 'TG-9', now()) RETURNING id INTO l9;
  INSERT INTO "CalendarLessonGroups" ("schoolId", "calendarLessonId", "studentGroupId") VALUES (s2, l9, sva9);
  INSERT INTO "LessonLogs" ("schoolId", "calendarLessonId", topic) VALUES (s2, l9, 'TG annan');
  -- The two rows that point across: the other school's, by their schoolId.
  INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES (s2, sva, q);
  INSERT INTO "CalendarLessonGroups" ("schoolId", "calendarLessonId", "studentGroupId") VALUES (s2, l2, sva9);
  INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES (s1, spa, q);

  -- Last läsår.
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
  VALUES (s1, 'Tillagd grupp i fjol', current_date - 400, current_date - 31, false, now()) RETURNING id INTO y0;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt")
  VALUES (s1, y0, 'TG6B', 6, now()) RETURNING id INTO k6b;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", kind, "updatedAt")
  VALUES (s1, y0, 'TG SvA6', 6, 'TEACHING_GROUP', now()) RETURNING id INTO sva6;
  INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", note, "updatedAt")
  VALUES (s1, subj, k6b, current_date - 100, (current_date - 100) + time '08:00', (current_date - 100) + time '09:00', 'TG-0', now()) RETURNING id INTO l0;
  INSERT INTO "CalendarLessonGroups" ("schoolId", "calendarLessonId", "studentGroupId") VALUES (s1, l0, sva6);
  INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role) VALUES (s1, l0, t, 'LEAD');
  INSERT INTO "LessonLogs" ("schoolId", "calendarLessonId", topic, "writtenById") VALUES (s1, l0, 'TG noll', t);
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
  VALUES (s1, 'tillagd-p5@example.invalid', 'Tillagd', 'Elev SvA6', 'STUDENT', '00000000-0000-4000-8000-000000001411', true, k7a, now()) RETURNING id INTO p5;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s1, 'tillagd-g5@example.invalid', 'Tillagd', 'Vårdnadshavare SvA6', 'GUARDIAN', '00000000-0000-4000-8000-000000001412', true, now()) RETURNING id INTO g5;
  INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId") VALUES (s1, g5, p5);
  INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES (s1, sva6, p5);

  -- A deactivated pupil in SvA7.
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
  VALUES (s1, 'tillagd-p6@example.invalid', 'Tillagd', 'Elev slutat', 'STUDENT', '00000000-0000-4000-8000-000000001413', true, k7a, now()) RETURNING id INTO p6;
  INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES (s1, sva, p6);
  UPDATE "Users" SET "isActive" = false WHERE id = p6;

  -- Logins with a row at each school, as the Flera skolor fixture makes them
  -- (app.login_join names each row): this school's row first.
  FOR rec IN
    SELECT * FROM (VALUES
      ('00000000-0000-4000-8000-000000001414'::uuid, s1, 'STUDENT'::"UserRole", k7a,  sva,  'tillagd-m1-a'),
      ('00000000-0000-4000-8000-000000001414'::uuid, s2, 'TEACHER',             NULL, NULL, 'tillagd-m1-b'),
      ('00000000-0000-4000-8000-000000001415'::uuid, s1, 'STUDENT',             k7a,  sva,  'tillagd-m2-a'),
      ('00000000-0000-4000-8000-000000001415'::uuid, s2, 'STUDENT',             NULL, sva9, 'tillagd-m2-b'),
      ('00000000-0000-4000-8000-000000001416'::uuid, s1, 'GUARDIAN',            NULL, sva,  'tillagd-m3-a'),
      ('00000000-0000-4000-8000-000000001416'::uuid, s2, 'STUDENT',             NULL, sva9, 'tillagd-m3-b')
    ) v(auth_id, school, role, class_id, member_of, label)
  LOOP
    row_id := gen_random_uuid();
    PERFORM set_config('app.login_join', row_id::text, true);
    INSERT INTO "Users" (id, "schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "invitedAt", "updatedAt")
    VALUES (row_id, rec.school, rec.label || '@example.invalid', 'Tillagd', rec.label, rec.role, rec.auth_id, true, rec.class_id, now(), now());
    IF rec.member_of IS NOT NULL THEN
      INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES (rec.school, rec.member_of, row_id);
    END IF;
  END LOOP;
  PERFORM set_config('app.login_join', '', true);
END $$;

-- Ersättande grupper (20261211090000), sections 270–274. SvA7 replaces
-- Svenska. 7A: P1 (in SvA7) and P2 (in no replacing group), both placed in
-- the half 7A:1; 7B: P3 (in SvA7). G1 is P1's guardian, G2 P2's, and G12
-- both twins'. The lessons, named in "note":
--   EG-1 7A's svenska            EG-2 7A's matematik
--   EG-3 SvA7's SvA              EG-4 7B's svenska, SvA7 added
--   EG-5 7A's svenska naming P1  EG-6 7B's svenska, 7A added
--   EG-7 7A:1's svenska          EG-8 7A:1's matematik
--   EG-10 7A's engelska           EG-11 SvA7's svenska (its own lesson in the subject)
--   EG-12 7B's svenska, the half 7A:1 added
-- Last läsår (ended): EG Sv6n (a nivågrupp in svenska) and EG SvA6, which
-- replaced Svenska then; P2 is still a member of both, as the rollover leaves
-- a membership, and P3 of SvA6. EG-0 is Sv6n's svenska of that year: P2 is
-- off it (SvA6 replaced it then), and SvA6 takes P2 and P3 off nothing of
-- this year's.
-- P1 is also in EnS7, which replaces Engelska: a pupil in two replacing
-- groups leaves each one's subject only (EG-4 carries SvA7, not EnS7, and
-- stays theirs). EG-1 carries a log; the teacher leads every lesson. Another school has its
-- own SvA7 replacing its svenska, and a login (M) has a pupil row at each:
-- here in 7A and in no replacing group, there in that school's SvA7.
DO $$
DECLARE
  s1 uuid;
  s2 uuid;
  y uuid;
  y2 uuid;
  sv uuid;
  sva uuid;
  ma uuid;
  en uuid;
  rens uuid;
  y0 uuid;
  r6 uuid;
  n6 uuid;
  sv2 uuid;
  k7a uuid;
  k7b uuid;
  half uuid;
  r7 uuid;
  k2 uuid;
  r2 uuid;
  rtom uuid;
  rstod uuid;
  k6a uuid;
  p5 uuid;
  rfd uuid;
  t uuid;
  p1 uuid;
  p2 uuid;
  p3 uuid;
  g1 uuid;
  g2 uuid;
  g12 uuid;
  l uuid;
  rec record;
  row_id uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM "Schools" WHERE slug = 'rls-ersattande-school') THEN
    RETURN;
  END IF;
  INSERT INTO "Schools" (name, slug, timezone, "updatedAt")
  VALUES ('RLS Ersättande', 'rls-ersattande-school', 'Europe/Stockholm', now()) RETURNING id INTO s1;
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
  VALUES (s1, 'Ersättande i år', current_date - 30, current_date + 300, true, now()) RETURNING id INTO y;
  INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES (s1, 'EG Svenska', 'RLSEGSV', now()) RETURNING id INTO sv;
  INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES (s1, 'EG SvA', 'RLSEGSVA', now()) RETURNING id INTO sva;
  INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES (s1, 'EG Matematik', 'RLSEGMA', now()) RETURNING id INTO ma;
  INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES (s1, 'EG Engelska', 'RLSEGEN', now()) RETURNING id INTO en;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt")
  VALUES (s1, y, 'EG7A', 7, now()) RETURNING id INTO k7a;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt")
  VALUES (s1, y, 'EG7B', 7, now()) RETURNING id INTO k7b;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", kind, "halfOfId", "updatedAt")
  VALUES (s1, y, 'EG7A:1', 7, 'TEACHING_GROUP', k7a, now()) RETURNING id INTO half;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", kind, "replacesSubjectId", "updatedAt")
  VALUES (s1, y, 'EG SvA7', 7, 'TEACHING_GROUP', sv, now()) RETURNING id INTO r7;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", kind, "replacesSubjectId", "updatedAt")
  VALUES (s1, y, 'EG EnS7', 7, 'TEACHING_GROUP', en, now()) RETURNING id INTO rens;
  -- A second group replacing svenska, for P3, who is also in SvA7: P3 keeps
  -- the lessons that carry either (SvA7's own EG-11, 7B's EG-4 with SvA7).
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", kind, "replacesSubjectId", "updatedAt")
  VALUES (s1, y, 'EG SvA7 stöd', 7, 'TEACHING_GROUP', sv, now()) RETURNING id INTO rstod;
  -- Svenska fördjupning, a teaching group (not a half) that P1 is placed in:
  -- P1 keeps its svenska (EG-13), SvA7 or not.
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", kind, "updatedAt")
  VALUES (s1, y, 'EG Sv7 fördjupning', 7, 'TEACHING_GROUP', now()) RETURNING id INTO rfd;

  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "updatedAt")
  VALUES (s1, 'eg-admin@example.invalid', 'EG', 'Admin', 'SCHOOL_ADMIN', 'FULL', '00000000-0000-4000-8000-000000001500', true, now());
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s1, 'eg-larare@example.invalid', 'EG', 'Lärare', 'TEACHER', '00000000-0000-4000-8000-000000001501', true, now()) RETURNING id INTO t;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
  VALUES (s1, 'eg-p1@example.invalid', 'EG', 'Elev SvA', 'STUDENT', '00000000-0000-4000-8000-000000001502', true, k7a, now()) RETURNING id INTO p1;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
  VALUES (s1, 'eg-p2@example.invalid', 'EG', 'Elev 7A', 'STUDENT', '00000000-0000-4000-8000-000000001503', true, k7a, now()) RETURNING id INTO p2;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
  VALUES (s1, 'eg-p3@example.invalid', 'EG', 'Elev 7B SvA', 'STUDENT', '00000000-0000-4000-8000-000000001504', true, k7b, now()) RETURNING id INTO p3;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s1, 'eg-g1@example.invalid', 'EG', 'Vårdnadshavare SvA', 'GUARDIAN', '00000000-0000-4000-8000-000000001505', true, now()) RETURNING id INTO g1;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s1, 'eg-g2@example.invalid', 'EG', 'Vårdnadshavare 7A', 'GUARDIAN', '00000000-0000-4000-8000-000000001506', true, now()) RETURNING id INTO g2;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
  VALUES (s1, 'eg-g12@example.invalid', 'EG', 'Vårdnadshavare tvillingar', 'GUARDIAN', '00000000-0000-4000-8000-000000001507', true, now()) RETURNING id INTO g12;
  INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId") VALUES (s1, g1, p1), (s1, g2, p2), (s1, g12, p1), (s1, g12, p2);
  INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES
    (s1, r7, p1), (s1, r7, p3), (s1, half, p1), (s1, half, p2), (s1, rens, p1), (s1, rstod, p3), (s1, rfd, p1);

  FOR rec IN SELECT * FROM (VALUES
    ('EG-1', sv,  k7a,  NULL::uuid, NULL::uuid, 1),
    ('EG-2', ma,  k7a,  NULL,       NULL,       1),
    ('EG-3', sva, r7,   NULL,       NULL,       2),
    ('EG-4', sv,  k7b,  r7,         NULL,       2),
    ('EG-5', sv,  k7a,  NULL,       p1,         3),
    ('EG-6', sv,  k7b,  k7a,        NULL,       3),
    ('EG-7', sv,  half, NULL,       NULL,       4),
    ('EG-8', ma,  half, NULL,       NULL,       4),
    ('EG-10', en, k7a,  NULL,       NULL,       5),
    ('EG-11', sv, r7,   NULL,       NULL,       5),
    ('EG-12', sv, k7b,  half,       NULL,       6),
    ('EG-13', sv, rfd,  NULL,       NULL,       6),
    ('EG-14', sv, k7a,  rens,       NULL,       6)
  ) v(note, subject, grp, extra, named, day_offset) LOOP
    INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", note, "updatedAt")
    VALUES (s1, rec.subject, rec.grp, current_date + rec.day_offset,
            (current_date + rec.day_offset) + time '08:00', (current_date + rec.day_offset) + time '09:00', rec.note, now())
    RETURNING id INTO l;
    IF rec.extra IS NOT NULL THEN
      INSERT INTO "CalendarLessonGroups" ("schoolId", "calendarLessonId", "studentGroupId") VALUES (s1, l, rec.extra);
    END IF;
    IF rec.named IS NOT NULL THEN
      INSERT INTO "CalendarLessonStudents" ("schoolId", "calendarLessonId", "studentId") VALUES (s1, l, rec.named);
    END IF;
    INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role) VALUES (s1, l, t, 'LEAD');
    IF rec.note = 'EG-1' THEN
      INSERT INTO "LessonLogs" ("schoolId", "calendarLessonId", topic, homework, "writtenById")
      VALUES (s1, l, 'EG ett', 'EG läxa ett', t);
    END IF;
  END LOOP;

  -- Last läsår.
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
  VALUES (s1, 'Ersättande i fjol', current_date - 400, current_date - 31, false, now()) RETURNING id INTO y0;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", kind, "replacesSubjectId", "updatedAt")
  VALUES (s1, y0, 'EG SvA6', 6, 'TEACHING_GROUP', sv, now()) RETURNING id INTO r6;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", kind, "updatedAt")
  VALUES (s1, y0, 'EG Sv6n', 6, 'TEACHING_GROUP', now()) RETURNING id INTO n6;
  INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES (s1, r6, p2), (s1, n6, p2), (s1, r6, p3);
  -- EG-15 is this year's 7B svenska with last year's SvA6 added: SvA6 keeps
  -- nobody on a lesson of another läsår, so P3 (in SvA6 then, SvA7 now)
  -- leaves it, and P2 (in SvA6 then, in no replacing group now) reads it.
  INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", note, "updatedAt")
  VALUES (s1, sv, k7b, current_date + 6, (current_date + 6) + time '10:00', (current_date + 6) + time '11:00', 'EG-15', now())
  RETURNING id INTO l;
  INSERT INTO "CalendarLessonGroups" ("schoolId", "calendarLessonId", "studentGroupId") VALUES (s1, l, r6);
  INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role) VALUES (s1, l, t, 'LEAD');
  -- P5's home row names EG Sv7 fördjupning, a teaching group (the API's
  -- user update allowed it before 20261211090000's release refused it), and
  -- P5 is in SvA7. Not a member of the fördjupning, P5 is not placed in it,
  -- and leaves its svenska (EG-13) as every reader says.
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
  VALUES (s1, 'eg-p5@example.invalid', 'EG', 'Elev hemma i en undervisningsgrupp', 'STUDENT', '00000000-0000-4000-8000-000000001510', true, rfd, now())
  RETURNING id INTO p5;
  INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES (s1, r7, p5);
  -- EG-0 is last year's class's svenska, with Sv6n added: P2 reaches it
  -- through Sv6n, and last year's SvA6 takes P2 off it (a teaching group
  -- added to a lesson keeps nobody on; only the lesson's own one does).
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt")
  VALUES (s1, y0, 'EG6A', 6, now()) RETURNING id INTO k6a;
  INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", note, "updatedAt")
  VALUES (s1, sv, k6a, current_date - 100, (current_date - 100) + time '08:00', (current_date - 100) + time '09:00', 'EG-0', now())
  RETURNING id INTO l;
  INSERT INTO "CalendarLessonGroups" ("schoolId", "calendarLessonId", "studentGroupId") VALUES (s1, l, n6);
  INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role) VALUES (s1, l, t, 'LEAD');

  INSERT INTO "Schools" (name, slug, timezone, "updatedAt")
  VALUES ('RLS Ersättande annan', 'rls-ersattande-annan', 'Europe/Stockholm', now()) RETURNING id INTO s2;
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
  VALUES (s2, 'Ersättande annan i år', current_date - 30, current_date + 300, true, now()) RETURNING id INTO y2;
  INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES (s2, 'EG annan svenska', 'RLSEGSV2', now()) RETURNING id INTO sv2;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt")
  VALUES (s2, y2, 'EG annan 7A', 7, now()) RETURNING id INTO k2;
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", kind, "replacesSubjectId", "updatedAt")
  VALUES (s2, y2, 'EG annan SvA7', 7, 'TEACHING_GROUP', sv2, now()) RETURNING id INTO r2;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "updatedAt")
  VALUES (s2, 'eg-annan-admin@example.invalid', 'EG annan', 'Admin', 'SCHOOL_ADMIN', 'FULL', '00000000-0000-4000-8000-000000001508', true, now());
  INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", note, "updatedAt")
  VALUES (s2, sv2, k2, current_date + 1, (current_date + 1) + time '08:00', (current_date + 1) + time '09:00', 'EG-9', now());

  -- A row the other school's administrator wrote: its insert arm checks the
  -- row's school alone, and the keys to the group and the pupil are not
  -- composite, so it may point at a group and a pupil of this school. The
  -- group replaces svenska and has no lessons, so the arms reach nothing
  -- through the row. Were the helper or the calendar feed to read it (both
  -- DEFINER, past the member arms), P2 would leave 7A's svenska.
  INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", kind, "replacesSubjectId", "updatedAt")
  VALUES (s1, y, 'EG SvA7 tom', 7, 'TEACHING_GROUP', sv, now()) RETURNING id INTO rtom;
  INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES (s2, rtom, p2);

  -- M: a pupil here in 7A, and there in 7A and that school's SvA7.
  FOR rec IN SELECT * FROM (VALUES
    (s1, k7a, NULL::uuid, 'eg-m-a'),
    (s2, k2,  r2,         'eg-m-b')
  ) v(school, class_id, member_of, label) LOOP
    row_id := gen_random_uuid();
    PERFORM set_config('app.login_join', row_id::text, true);
    INSERT INTO "Users" (id, "schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "invitedAt", "updatedAt")
    VALUES (row_id, rec.school, rec.label || '@example.invalid', 'EG', rec.label, 'STUDENT',
            '00000000-0000-4000-8000-000000001509', true, rec.class_id, now(), now());
    IF rec.member_of IS NOT NULL THEN
      INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES (rec.school, rec.member_of, row_id);
    END IF;
  END LOOP;
  PERFORM set_config('app.login_join', '', true);
END $$;

-- Huvudman (20261212090000), sections 260–268. Huvudmannen H ("RLS Kommun")
-- owns school A (the seed's), rls-roller-school and rls-huvudman-c, whose
-- staff must sign in with the school account; it has asked for school B
-- (rls-fixture-school) and rls-huvudman-d, which has a decider of its own.
-- H2 ("RLS Annan huvudman") owns nothing and has asked for the roller
-- school, which H owns: a state the functions never make (an answer deletes
-- every question, and an owned school cannot be asked for), planted so that
-- section 116's matrix reads a question in the roller school and section 265
-- has a yes to refuse. Logins, sorting last by authId:
--
--   …0260  P, planerare in H, no row anywhere
--   …0261  K, kommunadministratör in H, no row anywhere
--   …0262  X, a deactivated planerare in H
--   …0263  Q, planerare in H2
--   …0264  L, planerare in H, and a teacher with a row of their own at A
--   …0265  G, planerare in H, with a deactivated guardian row in the roller
--          school (no active row there: H's reader there)
--   …0266  rls-huvudman-d's full administrator (its decider), no member
--   …0267  rls-huvudman-d's schemaläggare, no member
--   …0268  K2, kommunadministratör in H2
--   …0269  rls-huvudman-c's full administrator (its decider), no member
--
-- Keys: H's live key (sh_ + 48 × 'a'), H's revoked key, H2's live key.
DO $$
DECLARE
  a uuid := (SELECT id FROM "Schools" WHERE slug <> 'rls-fixture-school' ORDER BY "createdAt" LIMIT 1);
  b uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-fixture-school');
  m uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-roller-school');
  c uuid;
  d uuid;
  h uuid;
  h2 uuid;
  k uuid;
  k2 uuid;
  row_id uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM "Huvudmen" WHERE "organisationNumber" = '2121000001') THEN
    RETURN;
  END IF;
  IF a IS NULL OR b IS NULL OR m IS NULL THEN
    RAISE EXCEPTION 'huvudman: schools A, B and rls-roller-school must exist first';
  END IF;

  INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ('RLS Huvudman C', 'rls-huvudman-c', 'Europe/Stockholm', now())
  RETURNING id INTO c;
  INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ('RLS Huvudman D', 'rls-huvudman-d', 'Europe/Stockholm', now())
  RETURNING id INTO d;
  INSERT INTO "SchoolSignInMethods" ("schoolId", provider, domains, "entraTenantId", "ssoOnlyForStaff", "updatedAt")
  VALUES (c, 'azure', ARRAY['rls-huvudman-c.example'], '7b0c2a9e-3c1d-4e5f-8a6b-0c1d2e3f4a5d', true, now());

  INSERT INTO "Huvudmen" (name, "organisationNumber", "municipalityCode") VALUES ('RLS Kommun', '2121000001', '0884')
  RETURNING id INTO h;
  INSERT INTO "Huvudmen" (name, "organisationNumber") VALUES ('RLS Annan huvudman', '2121000002')
  RETURNING id INTO h2;

  INSERT INTO "HuvudmanMembers" ("huvudmanId", "authId", email, "firstName", "lastName", role, "isActive", "invitedAt")
  VALUES (h,  'fe000000-0000-4000-8000-000000000260', 'hm-p@example.invalid',  'Huvudman', 'Planerare',      'PLANERARE',           true,  now()),
         (h,  'fe000000-0000-4000-8000-000000000261', 'hm-k@example.invalid',  'Huvudman', 'Kommunadmin',    'KOMMUNADMINISTRATOR', true,  now()),
         (h,  'fe000000-0000-4000-8000-000000000262', 'hm-x@example.invalid',  'Huvudman', 'Avaktiverad',    'PLANERARE',           false, now()),
         (h2, 'fe000000-0000-4000-8000-000000000263', 'hm-q@example.invalid',  'Annan',    'Planerare',      'PLANERARE',           true,  now()),
         (h,  'fe000000-0000-4000-8000-000000000264', 'hm-l@example.invalid',  'Huvudman', 'Lärare',         'PLANERARE',           true,  now()),
         (h,  'fe000000-0000-4000-8000-000000000265', 'hm-g@example.invalid',  'Huvudman', 'Vårdnadshavare', 'PLANERARE',           true,  now()),
         (h2, 'fe000000-0000-4000-8000-000000000268', 'hm-k2@example.invalid', 'Annan',    'Kommunadmin',    'KOMMUNADMINISTRATOR', true,  now()),
         (h,  NULL,                                   'hm-new@example.invalid', 'Huvudman', 'Inbjuds',       'PLANERARE',           true,  NULL);
  SELECT id INTO k FROM "HuvudmanMembers" WHERE "authId" = 'fe000000-0000-4000-8000-000000000261';
  SELECT id INTO k2 FROM "HuvudmanMembers" WHERE "authId" = 'fe000000-0000-4000-8000-000000000268';

  -- L's own teacher row at A, G's deactivated guardian row in the roller
  -- school, and D's two administrators.
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "invitedAt", "updatedAt")
  VALUES (a, 'hm-l-a@example.invalid', 'Huvudman', 'Lärare', 'TEACHER', 'fe000000-0000-4000-8000-000000000264', true, now(), now());
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "invitedAt", "updatedAt")
  VALUES (m, 'hm-g-m@example.invalid', 'Huvudman', 'Vårdnadshavare', 'GUARDIAN', 'fe000000-0000-4000-8000-000000000265', true, now(), now())
  RETURNING id INTO row_id;
  UPDATE "Users" SET "isActive" = false WHERE id = row_id;
  INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "invitedAt", "updatedAt")
  VALUES (d, 'hm-d-full@example.invalid',  'Skola D', 'Rektor',        'SCHOOL_ADMIN', 'FULL',          'fe000000-0000-4000-8000-000000000266', true, now(), now()),
         (d, 'hm-d-schema@example.invalid', 'Skola D', 'Schemaläggare', 'SCHOOL_ADMIN', 'SCHEMALAGGARE', 'fe000000-0000-4000-8000-000000000267', true, now(), now()),
         (c, 'hm-c-full@example.invalid',  'Skola C', 'Rektor',        'SCHOOL_ADMIN', 'FULL',          'fe000000-0000-4000-8000-000000000269', true, now(), now());

  INSERT INTO "HuvudmanSchools" ("schoolId", "huvudmanId", "requestedById")
  VALUES (a, h, k), (m, h, k), (c, h, k);
  INSERT INTO "HuvudmanSchoolRequests" ("huvudmanId", "schoolId", "requestedById")
  VALUES (h, b, k), (h, d, k), (h2, m, k2);
  INSERT INTO "HuvudmanSchoolEvents" ("huvudmanId", "schoolId", kind, "byMemberId")
  VALUES (h, a, 'REQUESTED', k), (h, m, 'REQUESTED', k), (h, c, 'REQUESTED', k),
         (h, b, 'REQUESTED', k), (h, d, 'REQUESTED', k), (h2, m, 'REQUESTED', k2);
  INSERT INTO "HuvudmanSchoolEvents" ("huvudmanId", "schoolId", kind, "byUserId")
  VALUES (h, a, 'JOINED', NULL), (h, m, 'JOINED', (SELECT id FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000105')),
         (h, c, 'JOINED', NULL);

  INSERT INTO "HuvudmanApiKeys" ("huvudmanId", name, "keyHash", scopes, "createdById")
  VALUES (h,  'RLS H nyckel',          encode(sha256(convert_to('sh_' || repeat('a', 48), 'UTF8')), 'hex'),
          ARRAY['organisations.read', 'persons.read', 'groups.read'], k),
         (h,  'RLS H återkallad',      encode(sha256(convert_to('sh_' || repeat('b', 48), 'UTF8')), 'hex'),
          ARRAY['persons.read'], k),
         (h2, 'RLS H2 nyckel',         encode(sha256(convert_to('sh_' || repeat('c', 48), 'UTF8')), 'hex'),
          ARRAY['persons.read'], k2);
  UPDATE "HuvudmanApiKeys" SET "revokedAt" = now() WHERE name = 'RLS H återkallad';
END $$;

-- Delade lokaler och lärare (20261217090000), sections 275–279. Huvudmannen
-- H owns school A (the seed's), rls-roller-school (M) and rls-huvudman-c (C);
-- B (rls-fixture-school) and rls-huvudman-d (D) have only H's question.
-- Logins, each row joining the login as the gateway's invitation does:
--
--   …2750 T  a teacher at A (older), at M and at C: shared at all three,
--            each school's row marked towards the other two. A plans T (a
--            timplanspost) and has a lesson of T's, Mon 08:00–09:00. M has
--            four: Tue 10:00–11:00 every week, Thu 13:00–14:00 odd weeks
--            2030-09-02..2030-12-20, a parked Wed 09:00–10:00, and Fri
--            08:00–09:00 as co-teacher beside M's teacher (…0111).
--   …2751 U  a teacher at A and at D (not H's): not shared.
--   …2752 V  a teacher at A and a guardian at M: not shared.
--   …2753 W  a teacher at A and a deactivated teacher at M: not shared.
--   …2755 Z  a guardian at A and a teacher at M: not shared.
--   …2756 Q  a deactivated teacher at A and a teacher at M: not shared.
--            U, V, W, Z and Q are marked both ways, so that each rule alone
--            keeps them apart.
--   …2757 K  a teacher at A and at M, marked by A towards M and not by M.
--   …2758 L  a teacher at A and at M, marked by M towards A and not by A.
--   …2759 N  a teacher at A, at M and at C, marked by A towards M, by M
--            towards C and by C towards A: no pair has both marks.
--            A plans U, V, W, Z, Q, K, L and N, and each has a lesson at
--            the other school (V's planted on the guardian row and Z's at A
--            on the guardian row, which no API writes), so that each rule
--            alone keeps that lesson from A.
--   …2754 Y  a teacher at A that A plans nothing for, and at M with a lesson
--            Mon 09:00–10:00: shared, and none of M's times A's to read.
--   …2760 P  a teacher at A and at M, shared, whom A plans only through a
--            teacher's share of a timplanspost of somebody else's, with a
--            lesson at M Wed 08:00–09:00.
--
-- Restid A–M 15 minutes, set by M (so section 116's matrix has M's row).
-- Salslån: M's room "Roller hall" for A, whose own room for it is "Roller
-- hall (lånad)": APPROVED Tue 10:00–11:30 and PENDING Wed 13:00–14:00, both
-- 2030-08-19..2031-06-13.
DO $$
DECLARE
  a uuid := (SELECT id FROM "Schools" WHERE slug <> 'rls-fixture-school' ORDER BY "createdAt" LIMIT 1);
  m uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-roller-school');
  c uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-huvudman-c');
  d uuid := (SELECT id FROM "Schools" WHERE slug = 'rls-huvudman-d');
  rec record;
  row_id uuid;
  a_year uuid;
  a_subj uuid;
  a_grp uuid;
  m_year uuid;
  m_subj uuid;
  m_grp uuid;
  m_teacher uuid;
  hall uuid;
  local_hall uuid;
  m_admin uuid;
  a_admin uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM "Users" WHERE "authId" = 'fe000000-0000-4000-8000-000000002750') THEN
    RETURN;
  END IF;
  IF a IS NULL OR m IS NULL OR c IS NULL OR d IS NULL
     OR NOT EXISTS (SELECT 1 FROM "HuvudmanSchools" WHERE "schoolId" = m) THEN
    RAISE EXCEPTION 'delade: the huvudman''s fixtures must exist first';
  END IF;

  FOR rec IN
    SELECT * FROM (VALUES
      ('fe000000-0000-4000-8000-000000002750'::uuid, a, 'TEACHER'::"UserRole", true,  timestamptz '2026-01-01', 'delade-t-a'),
      ('fe000000-0000-4000-8000-000000002750'::uuid, m, 'TEACHER',             true,  timestamptz '2026-02-01', 'delade-t-m'),
      ('fe000000-0000-4000-8000-000000002750'::uuid, c, 'TEACHER',             true,  timestamptz '2026-03-01', 'delade-t-c'),
      ('fe000000-0000-4000-8000-000000002751'::uuid, a, 'TEACHER',             true,  timestamptz '2026-01-01', 'delade-u-a'),
      ('fe000000-0000-4000-8000-000000002751'::uuid, d, 'TEACHER',             true,  timestamptz '2026-02-01', 'delade-u-d'),
      ('fe000000-0000-4000-8000-000000002752'::uuid, a, 'TEACHER',             true,  timestamptz '2026-01-01', 'delade-v-a'),
      ('fe000000-0000-4000-8000-000000002752'::uuid, m, 'GUARDIAN',            true,  timestamptz '2026-02-01', 'delade-v-m'),
      ('fe000000-0000-4000-8000-000000002753'::uuid, a, 'TEACHER',             true,  timestamptz '2026-01-01', 'delade-w-a'),
      ('fe000000-0000-4000-8000-000000002753'::uuid, m, 'TEACHER',             false, timestamptz '2026-02-01', 'delade-w-m'),
      ('fe000000-0000-4000-8000-000000002754'::uuid, a, 'TEACHER',             true,  timestamptz '2026-01-01', 'delade-y-a'),
      ('fe000000-0000-4000-8000-000000002754'::uuid, m, 'TEACHER',             true,  timestamptz '2026-02-01', 'delade-y-m'),
      ('fe000000-0000-4000-8000-000000002755'::uuid, a, 'GUARDIAN',            true,  timestamptz '2026-01-01', 'delade-z-a'),
      ('fe000000-0000-4000-8000-000000002755'::uuid, m, 'TEACHER',             true,  timestamptz '2026-02-01', 'delade-z-m'),
      ('fe000000-0000-4000-8000-000000002756'::uuid, a, 'TEACHER',             false, timestamptz '2026-01-01', 'delade-q-a'),
      ('fe000000-0000-4000-8000-000000002756'::uuid, m, 'TEACHER',             true,  timestamptz '2026-02-01', 'delade-q-m'),
      ('fe000000-0000-4000-8000-000000002757'::uuid, a, 'TEACHER',             true,  timestamptz '2026-01-01', 'delade-k-a'),
      ('fe000000-0000-4000-8000-000000002757'::uuid, m, 'TEACHER',             true,  timestamptz '2026-02-01', 'delade-k-m'),
      ('fe000000-0000-4000-8000-000000002758'::uuid, a, 'TEACHER',             true,  timestamptz '2026-01-01', 'delade-l-a'),
      ('fe000000-0000-4000-8000-000000002758'::uuid, m, 'TEACHER',             true,  timestamptz '2026-02-01', 'delade-l-m'),
      ('fe000000-0000-4000-8000-000000002759'::uuid, a, 'TEACHER',             true,  timestamptz '2026-01-01', 'delade-n-a'),
      ('fe000000-0000-4000-8000-000000002759'::uuid, m, 'TEACHER',             true,  timestamptz '2026-02-01', 'delade-n-m'),
      ('fe000000-0000-4000-8000-000000002759'::uuid, c, 'TEACHER',             true,  timestamptz '2026-03-01', 'delade-n-c'),
      ('fe000000-0000-4000-8000-000000002760'::uuid, a, 'TEACHER',             true,  timestamptz '2026-01-01', 'delade-p-a'),
      ('fe000000-0000-4000-8000-000000002760'::uuid, m, 'TEACHER',             true,  timestamptz '2026-02-01', 'delade-p-m')
    ) v(auth_id, school, role, active, created, label)
  LOOP
    row_id := gen_random_uuid();
    PERFORM set_config('app.login_join', row_id::text, true);
    INSERT INTO "Users" (id, "schoolId", email, "firstName", "lastName", role, "authId",
                         "isActive", "invitedAt", "createdAt", "updatedAt")
    VALUES (row_id, rec.school, rec.label || '@example.invalid', 'Delade', rec.label, rec.role,
            rec.auth_id, true, rec.created, rec.created, now());
    IF NOT rec.active THEN
      UPDATE "Users" SET "isActive" = false WHERE id = row_id;
    END IF;
  END LOOP;
  PERFORM set_config('app.login_join', '', true);

  -- The marks: each school's word about its own row towards another.
  INSERT INTO "SharedTeacherMarks" ("schoolId", "teacherId", "withSchoolId")
  SELECT u."schoolId", u.id, v.towards
    FROM (VALUES
      ('fe000000-0000-4000-8000-000000002750'::uuid, a, m), ('fe000000-0000-4000-8000-000000002750'::uuid, a, c),
      ('fe000000-0000-4000-8000-000000002750'::uuid, m, a), ('fe000000-0000-4000-8000-000000002750'::uuid, m, c),
      ('fe000000-0000-4000-8000-000000002750'::uuid, c, a), ('fe000000-0000-4000-8000-000000002750'::uuid, c, m),
      ('fe000000-0000-4000-8000-000000002751'::uuid, a, d), ('fe000000-0000-4000-8000-000000002751'::uuid, d, a),
      ('fe000000-0000-4000-8000-000000002752'::uuid, a, m), ('fe000000-0000-4000-8000-000000002752'::uuid, m, a),
      ('fe000000-0000-4000-8000-000000002753'::uuid, a, m), ('fe000000-0000-4000-8000-000000002753'::uuid, m, a),
      ('fe000000-0000-4000-8000-000000002754'::uuid, a, m), ('fe000000-0000-4000-8000-000000002754'::uuid, m, a),
      ('fe000000-0000-4000-8000-000000002755'::uuid, a, m), ('fe000000-0000-4000-8000-000000002755'::uuid, m, a),
      ('fe000000-0000-4000-8000-000000002756'::uuid, a, m), ('fe000000-0000-4000-8000-000000002756'::uuid, m, a),
      ('fe000000-0000-4000-8000-000000002757'::uuid, a, m),
      ('fe000000-0000-4000-8000-000000002758'::uuid, m, a),
      ('fe000000-0000-4000-8000-000000002759'::uuid, a, m), ('fe000000-0000-4000-8000-000000002759'::uuid, m, c),
      ('fe000000-0000-4000-8000-000000002759'::uuid, c, a),
      ('fe000000-0000-4000-8000-000000002760'::uuid, a, m), ('fe000000-0000-4000-8000-000000002760'::uuid, m, a)
    ) v(auth_id, school, towards)
    JOIN "Users" u ON u."authId" = v.auth_id AND u."schoolId" = v.school;

  SELECT id INTO a_year FROM "AcademicYears" WHERE "schoolId" = a ORDER BY "startDate" LIMIT 1;
  -- A subject of its own, so that the post below is the only one of its kind.
  INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES (a, 'Delade ämne', 'RLSD', now()) RETURNING id INTO a_subj;
  SELECT id INTO a_grp FROM "StudentGroups" WHERE "schoolId" = a AND "academicYearId" = a_year ORDER BY name LIMIT 1;
  SELECT id INTO m_year FROM "AcademicYears" WHERE "schoolId" = m AND name = 'Roller 2030/31';
  SELECT id INTO m_subj FROM "Subjects" WHERE "schoolId" = m AND code = 'RLSR';
  SELECT id INTO m_grp FROM "StudentGroups" WHERE "schoolId" = m AND name = 'Roller 7A';
  SELECT id INTO m_teacher FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000111';
  IF a_year IS NULL OR a_subj IS NULL OR a_grp IS NULL OR m_year IS NULL OR m_subj IS NULL OR m_grp IS NULL OR m_teacher IS NULL THEN
    RAISE EXCEPTION 'delade: school A''s or the roller school''s year, subject, group or teacher is missing';
  END IF;

  -- A plans T: a timplanspost and a lesson.
  INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "updatedAt")
  SELECT a, a_year, a_subj, a_grp, u.id, 1, now() FROM "Users" u WHERE u."authId" = 'fe000000-0000-4000-8000-000000002750' AND u."schoolId" = a;
  INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "dayOfWeek", "startTime", "endTime", "updatedAt")
  SELECT a, a_year, a_subj, a_grp, u.id, 1, '08:00', '09:00', now() FROM "Users" u WHERE u."authId" = 'fe000000-0000-4000-8000-000000002750' AND u."schoolId" = a;

  -- A plans U, V, W, Z (on the guardian row), Q, K, L and N too.
  INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "dayOfWeek", "startTime", "endTime", "updatedAt")
  SELECT a, a_year, a_subj, a_grp, u.id, v.dow, v.st, v.st + interval '1 hour', now()
    FROM (VALUES ('fe000000-0000-4000-8000-000000002751'::uuid, 4, time '14:00'), ('fe000000-0000-4000-8000-000000002752'::uuid, 3, time '14:00'),
                 ('fe000000-0000-4000-8000-000000002753'::uuid, 2, time '14:00'), ('fe000000-0000-4000-8000-000000002755'::uuid, 5, time '14:00'),
                 ('fe000000-0000-4000-8000-000000002756'::uuid, 1, time '14:00'), ('fe000000-0000-4000-8000-000000002757'::uuid, 1, time '15:00'),
                 ('fe000000-0000-4000-8000-000000002758'::uuid, 2, time '15:00'), ('fe000000-0000-4000-8000-000000002759'::uuid, 3, time '15:00')) v(auth_id, dow, st)
    JOIN "Users" u ON u."authId" = v.auth_id AND u."schoolId" = a;
  -- A plans P only through a teacher's share of a post nobody teaches.
  WITH post AS (
    INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "lessonsPerWeek", "updatedAt")
    SELECT a, a_year, a_subj, g.id, 2, now()
      FROM "StudentGroups" g WHERE g."schoolId" = a AND g."academicYearId" = a_year AND g.id <> a_grp ORDER BY g.name LIMIT 1
    RETURNING id, "minutesPerLesson")
  INSERT INTO "TeachingRequirementShares" ("schoolId", "requirementId", "teacherId", lessons, minutes, "updatedAt")
  SELECT a, post.id, u.id, 1, post."minutesPerLesson", now()
    FROM post JOIN "Users" u ON u."authId" = 'fe000000-0000-4000-8000-000000002760' AND u."schoolId" = a;

  -- U's lesson at D, in a year of D's own.
  INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
  VALUES (d, 'Delade D 2030/31', '2030-08-15', '2031-06-15', true, now()) RETURNING id INTO row_id;
  WITH s AS (INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES (d, 'Delade D ämne', 'RLSDD', now()) RETURNING id),
       g AS (INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt")
             VALUES (d, row_id, 'Delade D 7A', 7, now()) RETURNING id)
  INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "dayOfWeek", "startTime", "endTime", "updatedAt")
  SELECT d, row_id, s.id, g.id, u.id, 2, '12:00', '13:00', now()
    FROM s, g, "Users" u WHERE u."authId" = 'fe000000-0000-4000-8000-000000002751' AND u."schoolId" = d;

  -- M's lessons of T, of Y, of W (deactivated), on V's guardian row, and of
  -- Z, Q, K, L, N and P.
  INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "coTeacherId",
                               "dayOfWeek", "startTime", "endTime", recurrence, "startDate", "endDate", "isParked", "updatedAt")
  SELECT m, m_year, m_subj, m_grp, CASE WHEN v.co THEN m_teacher ELSE u.id END, CASE WHEN v.co THEN u.id END,
         v.dow, v.st, v.en, v.rec::"LessonRecurrence", v.sd, v.ed, v.parked, now()
    FROM (VALUES
      ('fe000000-0000-4000-8000-000000002750'::uuid, 2, time '10:00', time '11:00', 'ALL_WEEKS', NULL::date, NULL::date, false, false),
      ('fe000000-0000-4000-8000-000000002750'::uuid, 4, time '13:00', time '14:00', 'ODD_WEEKS', date '2030-09-02', date '2030-12-20', false, false),
      ('fe000000-0000-4000-8000-000000002750'::uuid, 3, time '09:00', time '10:00', 'ALL_WEEKS', NULL, NULL, true, false),
      ('fe000000-0000-4000-8000-000000002750'::uuid, 5, time '08:00', time '09:00', 'ALL_WEEKS', NULL, NULL, false, true),
      ('fe000000-0000-4000-8000-000000002754'::uuid, 1, time '09:00', time '10:00', 'ALL_WEEKS', NULL, NULL, false, false),
      ('fe000000-0000-4000-8000-000000002753'::uuid, 1, time '11:00', time '12:00', 'ALL_WEEKS', NULL, NULL, false, false),
      ('fe000000-0000-4000-8000-000000002752'::uuid, 1, time '13:00', time '14:00', 'ALL_WEEKS', NULL, NULL, false, false),
      ('fe000000-0000-4000-8000-000000002755'::uuid, 2, time '13:00', time '14:00', 'ALL_WEEKS', NULL, NULL, false, false),
      ('fe000000-0000-4000-8000-000000002756'::uuid, 2, time '14:00', time '15:00', 'ALL_WEEKS', NULL, NULL, false, false),
      ('fe000000-0000-4000-8000-000000002757'::uuid, 2, time '15:00', time '16:00', 'ALL_WEEKS', NULL, NULL, false, false),
      ('fe000000-0000-4000-8000-000000002758'::uuid, 4, time '08:00', time '09:00', 'ALL_WEEKS', NULL, NULL, false, false),
      ('fe000000-0000-4000-8000-000000002759'::uuid, 4, time '09:00', time '10:00', 'ALL_WEEKS', NULL, NULL, false, false),
      ('fe000000-0000-4000-8000-000000002760'::uuid, 3, time '08:00', time '09:00', 'ALL_WEEKS', NULL, NULL, false, false)
    ) v(auth_id, dow, st, en, rec, sd, ed, parked, co)
    JOIN "Users" u ON u."authId" = v.auth_id AND u."schoolId" = m;

  -- Restid A–M, set by M.
  INSERT INTO "SchoolTravelTimes" ("schoolAId", "schoolBId", minutes, "setBySchoolId")
  VALUES (least(a, m), greatest(a, m), 15, m);

  -- Salslån: M's hall for A.
  SELECT id INTO m_admin FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000105';
  SELECT id INTO a_admin FROM "Users" WHERE "schoolId" = a AND role = 'SCHOOL_ADMIN' AND "isActive" ORDER BY "createdAt", id LIMIT 1;
  INSERT INTO "Rooms" ("schoolId", name, capacity, "updatedAt") VALUES (m, 'Roller hall', 60, now()) RETURNING id INTO hall;
  INSERT INTO "Rooms" ("schoolId", name, capacity, "updatedAt") VALUES (a, 'Roller hall (lånad)', 60, now()) RETURNING id INTO local_hall;
  INSERT INTO "RoomLoans" ("ownerSchoolId", "roomId", "borrowerSchoolId", "localRoomId", "dayOfWeek", "startTime", "endTime",
                           "startDate", "endDate", status, note, "requestedById", "decidedById", "decidedAt")
  VALUES (m, hall, a, local_hall, 2, '10:00', '11:30', '2030-08-19', '2031-06-13', 'APPROVED', 'Idrott åk 7', a_admin, m_admin, now()),
         (m, hall, a, local_hall, 3, '13:00', '14:00', '2030-08-19', '2031-06-13', 'PENDING', NULL, a_admin, NULL, NULL);
END $$;

-- The policy tests run as the unprivileged role, which by design cannot see
-- any school until a principal is set — so it cannot discover these ids for
-- itself. The runner reads them here (as owner) and passes them in with -v.
\pset tuples_only on
\pset format unaligned
SELECT id FROM "Schools" WHERE slug <> 'rls-fixture-school' ORDER BY "createdAt" LIMIT 1;
