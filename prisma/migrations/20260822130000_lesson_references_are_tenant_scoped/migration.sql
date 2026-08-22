-- A lesson's school must be the school of everything the lesson names, and the
-- database must be the one that says so.
--
-- TeachingRequirementsService.create copies academicYearId, subjectId,
-- studentGroupId, teacherId and coTeacherId out of the request and checks none
-- of them; MasterLessonsService.create checks the academic year and copies the
-- other five the same way. `schoolId` comes from the principal, so the row
-- passes its own WITH CHECK — and PostgreSQL runs referential-integrity checks
-- as the referenced table's OWNER with row security off, so a foreign key
-- pointing at a row the caller cannot even SELECT still validates. RLS is no
-- defence here and cannot be made into one.
--
-- Reproduced against a real database before this migration was written, first
-- as raw SQL and then by calling the services themselves: an admin of school A
-- created a teaching requirement carrying A's schoolId and school B's user as
-- its teacher, while the same session counted zero rows for that user. After
-- this migration the same call comes back as P2003 — "references a record that
-- does not exist", which is what a foreign id is from inside a tenant — and an
-- ordinary same-school create still goes through.
--
-- Two consequences, one of them a live cross-tenant defect:
--
--   * 20260822120000 stopped a planted row from reaching another school's
--     pupils through nine group-scoped read policies. Two policies keyed on
--     the caller alone were not among them and did not need to be — a row in
--     MasterLessonStudents is readable by whoever it names, and only a key can
--     make "whoever it names" mean "someone in this row's school".
--
--   * TeachingRequirements' unique key was (academicYearId, studentGroupId,
--     subjectId) with no school in it. School A's forged row took the slot for
--     school B's real (year, group, subject) combination; B's admin then got a
--     409 Conflict creating their own legitimate requirement while seeing no
--     row anywhere in their school that could explain it. A permanent,
--     invisible cross-tenant denial of service on that slot.
--
-- Composite foreign keys rather than checks in the services, for the reason
-- 20260822090000 gives for guardian links: the clients in this product talk to
-- PostgREST directly, so a rule that lives in the gateway is not a tenancy
-- boundary. Keys hold for every writer — the table owner, the next migration,
-- the optimizer's bulk insert — and they cannot be forgotten at the eleventh
-- write site. A predicate in a policy would have been the wrong tool twice
-- over: it holds only for `authenticated`, and a policy that reads Users
-- recurses, which is what made the guardian fix a key in the first place.
--
-- Not every reference here needed pinning, so each one was worked out rather
-- than swept up. MasterLessonGroups.masterLessonId and
-- MasterLessonStudents.masterLessonId are deliberately left as plain
-- references: the row's own school is already pinned to the group's or the
-- pupil's by the key added below, and no policy and no service reads a lesson
-- through those links without asking the lesson's own schoolId first.
-- MasterLessons.academicYearId is pinned even though create() derives
-- `schoolId` from that very row under RLS — that derivation is a property of
-- three TypeScript call sites, and a direct write meets no TypeScript at all.
--
-- Requires PostgreSQL 15 or later for the per-column form of ON DELETE SET
-- NULL. Deleting a teacher must null the teacher and leave the lesson in its
-- school; a bare SET NULL on a composite key nulls `schoolId` too and fails
-- against NOT NULL, which would have turned "remove a colleague who has
-- lessons" into an unexplained error. Prisma cannot express the column list,
-- so it is written here by hand; `prisma migrate diff` reads both as SetNull
-- and reports no drift.
--
-- If this migration fails on a FOREIGN KEY violation, the database already
-- holds a row that names another school's data. That is worth stopping a
-- deploy for — look at the rows before touching them, because a row that
-- should not exist is evidence:
--
--     SELECT 'TeachingRequirements' AS "table", tr.id, tr."schoolId", 'academicYearId' AS ref
--       FROM "TeachingRequirements" tr JOIN "AcademicYears" p ON p.id = tr."academicYearId"
--      WHERE p."schoolId" <> tr."schoolId"
--     UNION ALL SELECT 'TeachingRequirements', tr.id, tr."schoolId", 'subjectId'
--       FROM "TeachingRequirements" tr JOIN "Subjects" p ON p.id = tr."subjectId"
--      WHERE p."schoolId" <> tr."schoolId"
--     UNION ALL SELECT 'TeachingRequirements', tr.id, tr."schoolId", 'studentGroupId'
--       FROM "TeachingRequirements" tr JOIN "StudentGroups" p ON p.id = tr."studentGroupId"
--      WHERE p."schoolId" <> tr."schoolId"
--     UNION ALL SELECT 'TeachingRequirements', tr.id, tr."schoolId", 'teacherId'
--       FROM "TeachingRequirements" tr JOIN "Users" p ON p.id = tr."teacherId"
--      WHERE p."schoolId" <> tr."schoolId"
--     UNION ALL SELECT 'TeachingRequirements', tr.id, tr."schoolId", 'coTeacherId'
--       FROM "TeachingRequirements" tr JOIN "Users" p ON p.id = tr."coTeacherId"
--      WHERE p."schoolId" <> tr."schoolId"
--     UNION ALL SELECT 'MasterLessons', ml.id, ml."schoolId", 'academicYearId'
--       FROM "MasterLessons" ml JOIN "AcademicYears" p ON p.id = ml."academicYearId"
--      WHERE p."schoolId" <> ml."schoolId"
--     UNION ALL SELECT 'MasterLessons', ml.id, ml."schoolId", 'subjectId'
--       FROM "MasterLessons" ml JOIN "Subjects" p ON p.id = ml."subjectId"
--      WHERE p."schoolId" <> ml."schoolId"
--     UNION ALL SELECT 'MasterLessons', ml.id, ml."schoolId", 'studentGroupId'
--       FROM "MasterLessons" ml JOIN "StudentGroups" p ON p.id = ml."studentGroupId"
--      WHERE p."schoolId" <> ml."schoolId"
--     UNION ALL SELECT 'MasterLessons', ml.id, ml."schoolId", 'teacherId'
--       FROM "MasterLessons" ml JOIN "Users" p ON p.id = ml."teacherId"
--      WHERE p."schoolId" <> ml."schoolId"
--     UNION ALL SELECT 'MasterLessons', ml.id, ml."schoolId", 'coTeacherId'
--       FROM "MasterLessons" ml JOIN "Users" p ON p.id = ml."coTeacherId"
--      WHERE p."schoolId" <> ml."schoolId"
--     UNION ALL SELECT 'MasterLessons', ml.id, ml."schoolId", 'roomId'
--       FROM "MasterLessons" ml JOIN "Rooms" p ON p.id = ml."roomId"
--      WHERE p."schoolId" <> ml."schoolId"
--     UNION ALL SELECT 'MasterLessonGroups', g.id, g."schoolId", 'studentGroupId'
--       FROM "MasterLessonGroups" g JOIN "StudentGroups" p ON p.id = g."studentGroupId"
--      WHERE p."schoolId" <> g."schoolId"
--     UNION ALL SELECT 'MasterLessonStudents', s.id, s."schoolId", 'studentId'
--       FROM "MasterLessonStudents" s JOIN "Users" p ON p.id = s."studentId"
--      WHERE p."schoolId" <> s."schoolId";
--
-- The unique-key change cannot fail: the new key is the old one with a column
-- added, so every combination that was legal before is still legal.

-- ---------------------------------------------------------------------------
-- 1. What the composite keys reference. Redundant as indexes — `id` is already
--    the primary key of each — and load-bearing as constraints, because
--    without them nothing can reference (id, schoolId) at all. Users got its
--    own in 20260822090000.
-- ---------------------------------------------------------------------------

ALTER TABLE "AcademicYears" ADD CONSTRAINT "AcademicYears_id_schoolId_key" UNIQUE ("id", "schoolId");
ALTER TABLE "Subjects"      ADD CONSTRAINT "Subjects_id_schoolId_key"      UNIQUE ("id", "schoolId");
ALTER TABLE "StudentGroups" ADD CONSTRAINT "StudentGroups_id_schoolId_key" UNIQUE ("id", "schoolId");
ALTER TABLE "Rooms"         ADD CONSTRAINT "Rooms_id_schoolId_key"         UNIQUE ("id", "schoolId");

-- ---------------------------------------------------------------------------
-- 2. TeachingRequirements: all five references, none of which create() checks.
-- ---------------------------------------------------------------------------

ALTER TABLE "TeachingRequirements" DROP CONSTRAINT "TeachingRequirements_academicYearId_fkey";
ALTER TABLE "TeachingRequirements" DROP CONSTRAINT "TeachingRequirements_subjectId_fkey";
ALTER TABLE "TeachingRequirements" DROP CONSTRAINT "TeachingRequirements_studentGroupId_fkey";
ALTER TABLE "TeachingRequirements" DROP CONSTRAINT "TeachingRequirements_teacherId_fkey";
ALTER TABLE "TeachingRequirements" DROP CONSTRAINT "TeachingRequirements_coTeacherId_fkey";

ALTER TABLE "TeachingRequirements"
    ADD CONSTRAINT "TeachingRequirements_academicYearId_schoolId_fkey"
    FOREIGN KEY ("academicYearId", "schoolId") REFERENCES "AcademicYears"("id", "schoolId")
    ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "TeachingRequirements"
    ADD CONSTRAINT "TeachingRequirements_subjectId_schoolId_fkey"
    FOREIGN KEY ("subjectId", "schoolId") REFERENCES "Subjects"("id", "schoolId")
    ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "TeachingRequirements"
    ADD CONSTRAINT "TeachingRequirements_studentGroupId_schoolId_fkey"
    FOREIGN KEY ("studentGroupId", "schoolId") REFERENCES "StudentGroups"("id", "schoolId")
    ON UPDATE CASCADE ON DELETE CASCADE;

-- Only the teacher column is nulled when a teacher is deleted; see the note on
-- PostgreSQL 15 above. `teacherId` is nullable and `schoolId` is not, so the
-- default MATCH SIMPLE leaves a requirement with no teacher unconstrained,
-- which is exactly right.
ALTER TABLE "TeachingRequirements"
    ADD CONSTRAINT "TeachingRequirements_teacherId_schoolId_fkey"
    FOREIGN KEY ("teacherId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON UPDATE CASCADE ON DELETE SET NULL ("teacherId");
ALTER TABLE "TeachingRequirements"
    ADD CONSTRAINT "TeachingRequirements_coTeacherId_schoolId_fkey"
    FOREIGN KEY ("coTeacherId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON UPDATE CASCADE ON DELETE SET NULL ("coTeacherId");

-- The squatting fix. A school can only take a slot in its own key space now.
DROP INDEX "TeachingRequirements_academicYearId_studentGroupId_subjectI_key";
CREATE UNIQUE INDEX "TeachingRequirements_schoolId_academicYearId_studentGroupId_key"
    ON "TeachingRequirements"("schoolId", "academicYearId", "studentGroupId", "subjectId");

-- ---------------------------------------------------------------------------
-- 3. MasterLessons: the same six references, one of which create() does check.
-- ---------------------------------------------------------------------------

ALTER TABLE "MasterLessons" DROP CONSTRAINT "MasterLessons_academicYearId_fkey";
ALTER TABLE "MasterLessons" DROP CONSTRAINT "MasterLessons_subjectId_fkey";
ALTER TABLE "MasterLessons" DROP CONSTRAINT "MasterLessons_studentGroupId_fkey";
ALTER TABLE "MasterLessons" DROP CONSTRAINT "MasterLessons_teacherId_fkey";
ALTER TABLE "MasterLessons" DROP CONSTRAINT "MasterLessons_coTeacherId_fkey";
ALTER TABLE "MasterLessons" DROP CONSTRAINT "MasterLessons_roomId_fkey";

ALTER TABLE "MasterLessons"
    ADD CONSTRAINT "MasterLessons_academicYearId_schoolId_fkey"
    FOREIGN KEY ("academicYearId", "schoolId") REFERENCES "AcademicYears"("id", "schoolId")
    ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "MasterLessons"
    ADD CONSTRAINT "MasterLessons_subjectId_schoolId_fkey"
    FOREIGN KEY ("subjectId", "schoolId") REFERENCES "Subjects"("id", "schoolId")
    ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "MasterLessons"
    ADD CONSTRAINT "MasterLessons_studentGroupId_schoolId_fkey"
    FOREIGN KEY ("studentGroupId", "schoolId") REFERENCES "StudentGroups"("id", "schoolId")
    ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "MasterLessons"
    ADD CONSTRAINT "MasterLessons_teacherId_schoolId_fkey"
    FOREIGN KEY ("teacherId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON UPDATE CASCADE ON DELETE SET NULL ("teacherId");
ALTER TABLE "MasterLessons"
    ADD CONSTRAINT "MasterLessons_coTeacherId_schoolId_fkey"
    FOREIGN KEY ("coTeacherId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON UPDATE CASCADE ON DELETE SET NULL ("coTeacherId");
ALTER TABLE "MasterLessons"
    ADD CONSTRAINT "MasterLessons_roomId_schoolId_fkey"
    FOREIGN KEY ("roomId", "schoolId") REFERENCES "Rooms"("id", "schoolId")
    ON UPDATE CASCADE ON DELETE SET NULL ("roomId");

-- ---------------------------------------------------------------------------
-- 4. The lesson's extra classes and individual participants, both of which
--    create() and update() take verbatim from `extraGroupIds` / `studentIds`.
-- ---------------------------------------------------------------------------

ALTER TABLE "MasterLessonGroups" DROP CONSTRAINT "MasterLessonGroups_studentGroupId_fkey";
ALTER TABLE "MasterLessonGroups"
    ADD CONSTRAINT "MasterLessonGroups_studentGroupId_schoolId_fkey"
    FOREIGN KEY ("studentGroupId", "schoolId") REFERENCES "StudentGroups"("id", "schoolId")
    ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "MasterLessonStudents" DROP CONSTRAINT "MasterLessonStudents_studentId_fkey";
ALTER TABLE "MasterLessonStudents"
    ADD CONSTRAINT "MasterLessonStudents_studentId_schoolId_fkey"
    FOREIGN KEY ("studentId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON UPDATE CASCADE ON DELETE CASCADE;
