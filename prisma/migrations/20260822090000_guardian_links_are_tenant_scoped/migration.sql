-- Guardian links must stay inside one school, and the database must be the one
-- that says so.
--
-- A GuardianStudents row carries its own `schoolId`, and that was the only thing
-- the write policy checked. Nothing tied `studentId` to that school. A school
-- admin who knew another school's student id could therefore insert a row with
-- their own schoolId, themselves as guardian, and that student — and the seven
-- policies derived from GuardianStudents honoured it verbatim, because not one
-- of them carries a school predicate either. The forged link returned the
-- child's full Users row, their absence reports including health notes, their
-- leave reasons, their group memberships and their timetable, across tenants.
--
-- Reproduced end to end against a real database before this migration was
-- written: the INSERT succeeded and all three reads returned another school's
-- data where the same reads had returned nothing a moment earlier.
--
-- FamilyService.createLink already refuses all of this (src/family/family.service.ts:42-64:
-- the guardian must be a GUARDIAN, the student a STUDENT, and the two must share
-- a school). The invariant simply lived only in the gateway, and the clients in
-- this product talk to PostgREST directly — so the gateway is not where a
-- tenancy boundary can live. This migration moves the same three rules into the
-- policy, where a direct write meets them too. No legitimate call changes shape.
--
-- Two layers, on purpose. The WITH CHECK stops a new forged row. The school
-- predicates added to the read policies mean that a row forged BEFORE this
-- migration grants nothing either — existing rows are deliberately left in
-- place rather than deleted, because a link that should not exist is evidence,
-- and silently destroying it would hide whether it was ever used.

-- ---------------------------------------------------------------------------
-- 1. The structural fix: a link cannot name a user from another school.
-- ---------------------------------------------------------------------------
--
-- Composite foreign keys rather than a policy predicate, and that was not the
-- first attempt. Testing an EXISTS check inside the write policy produced
-- "infinite recursion detected in policy for relation GuardianStudents": the
-- policy read Users, whose own guardian policy reads GuardianStudents. It would
-- have made every legitimate guardian link impossible to create.
--
-- Keys carry no such cycle, and they are stronger in two ways. They hold for
-- EVERY writer, the table owner and a future migration included, where a policy
-- holds only for `authenticated`. And they cannot be forgotten by the next
-- policy somebody writes against this table.
--
-- If this migration fails on a UNIQUE or FOREIGN KEY violation, the database
-- already contains a link whose guardian or pupil belongs to another school.
-- That is worth stopping a deploy for: look at the rows before removing them.
--     SELECT gs.* FROM "GuardianStudents" gs
--     JOIN "Users" g ON g.id = gs."guardianId"
--     JOIN "Users" s ON s.id = gs."studentId"
--     WHERE g."schoolId" <> gs."schoolId" OR s."schoolId" <> gs."schoolId";

ALTER TABLE "Users" ADD CONSTRAINT "Users_id_schoolId_key" UNIQUE ("id", "schoolId");

ALTER TABLE "GuardianStudents" DROP CONSTRAINT "GuardianStudents_guardianId_fkey";
ALTER TABLE "GuardianStudents" DROP CONSTRAINT "GuardianStudents_studentId_fkey";

ALTER TABLE "GuardianStudents"
    ADD CONSTRAINT "GuardianStudents_guardianId_schoolId_fkey"
    FOREIGN KEY ("guardianId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "GuardianStudents"
    ADD CONSTRAINT "GuardianStudents_studentId_schoolId_fkey"
    FOREIGN KEY ("studentId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON UPDATE CASCADE ON DELETE CASCADE;

DROP POLICY IF EXISTS "users_guardian_children_select" ON "Users";
CREATE POLICY "users_guardian_children_select" ON "Users"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND "id" IN (
            SELECT gs."studentId" FROM "GuardianStudents" gs
            WHERE gs."guardianId" = (select app.current_user_id())
              AND gs."schoolId" = (select app.current_school_id())
        )
    );

DROP POLICY IF EXISTS "absence_reports_guardian_select" ON "AbsenceReports";
CREATE POLICY "absence_reports_guardian_select" ON "AbsenceReports"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND "studentId" IN (
            SELECT gs."studentId" FROM "GuardianStudents" gs
            WHERE gs."guardianId" = (select app.current_user_id())
              AND gs."schoolId" = (select app.current_school_id())
        )
    );

DROP POLICY IF EXISTS "leave_requests_guardian_select" ON "LeaveRequests";
CREATE POLICY "leave_requests_guardian_select" ON "LeaveRequests"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND "studentId" IN (
            SELECT gs."studentId" FROM "GuardianStudents" gs
            WHERE gs."guardianId" = (select app.current_user_id())
              AND gs."schoolId" = (select app.current_school_id())
        )
    );

DROP POLICY IF EXISTS "student_group_members_guardian_select" ON "StudentGroupMembers";
CREATE POLICY "student_group_members_guardian_select" ON "StudentGroupMembers"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND "studentId" IN (
            SELECT gs."studentId" FROM "GuardianStudents" gs
            WHERE gs."guardianId" = (select app.current_user_id())
              AND gs."schoolId" = (select app.current_school_id())
        )
    );

DROP POLICY IF EXISTS "calendar_lessons_guardian_teaching_group_select" ON "CalendarLessons";
CREATE POLICY "calendar_lessons_guardian_teaching_group_select" ON "CalendarLessons"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND "studentGroupId" IN (
            SELECT sgm."studentGroupId"
            FROM "StudentGroupMembers" sgm
            JOIN "GuardianStudents" gs ON gs."studentId" = sgm."studentId"
            WHERE gs."guardianId" = (select app.current_user_id())
              AND gs."schoolId" = (select app.current_school_id())
        )
    );

-- The two INSERT policies use the same subquery to decide whose child a report
-- may be filed for. A forged link would have let a guardian file an absence or
-- a leave request against another school's pupil — writing into that school's
-- records, not merely reading them.

DROP POLICY IF EXISTS "absence_reports_guardian_insert" ON "AbsenceReports";
CREATE POLICY "absence_reports_guardian_insert" ON "AbsenceReports"
    FOR INSERT TO "authenticated"
    WITH CHECK (
        "schoolId" = (select app.current_school_id())
        AND "reportedById" = (select app.current_user_id())
        AND "studentId" IN (
            SELECT gs."studentId" FROM "GuardianStudents" gs
            WHERE gs."guardianId" = (select app.current_user_id())
              AND gs."schoolId" = (select app.current_school_id())
        )
    );

DROP POLICY IF EXISTS "leave_requests_guardian_insert" ON "LeaveRequests";
CREATE POLICY "leave_requests_guardian_insert" ON "LeaveRequests"
    FOR INSERT TO "authenticated"
    WITH CHECK (
        "schoolId" = (select app.current_school_id())
        AND "requestedById" = (select app.current_user_id())
        AND "studentId" IN (
            SELECT gs."studentId" FROM "GuardianStudents" gs
            WHERE gs."guardianId" = (select app.current_user_id())
              AND gs."schoolId" = (select app.current_school_id())
        )
    );
