-- Teaching-group membership: a student belongs to ONE home class
-- (Users.studentGroupId) and additionally to any number of teaching groups
-- (nivågrupper, språkval — Ma71, Sv73, En74 …) that cut across classes.
-- The scheduling engine receives group-conflict pairs derived from this table
-- so lessons for groups that SHARE STUDENTS can never overlap.

-- CreateTable
CREATE TABLE "StudentGroupMembers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "studentGroupId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentGroupMembers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StudentGroupMembers_studentGroupId_studentId_key"
    ON "StudentGroupMembers"("studentGroupId", "studentId");
CREATE INDEX "StudentGroupMembers_schoolId_idx" ON "StudentGroupMembers"("schoolId");
CREATE INDEX "StudentGroupMembers_studentId_idx" ON "StudentGroupMembers"("studentId");

-- AddForeignKey
ALTER TABLE "StudentGroupMembers"
    ADD CONSTRAINT "StudentGroupMembers_studentGroupId_fkey"
    FOREIGN KEY ("studentGroupId") REFERENCES "StudentGroups"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StudentGroupMembers"
    ADD CONSTRAINT "StudentGroupMembers_studentId_fkey"
    FOREIGN KEY ("studentId") REFERENCES "Users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security. Table privileges (SELECT/INSERT/UPDATE/DELETE for
-- "authenticated") arrive via the ALTER DEFAULT PRIVILEGES set up in
-- 20260806000000_grant_privileges_on_all_tables — new tables are covered
-- automatically, so no explicit GRANT here.
ALTER TABLE "StudentGroupMembers" ENABLE ROW LEVEL SECURITY;

-- Admins manage memberships for their own school.
CREATE POLICY "student_group_members_admin_all" ON "StudentGroupMembers"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

-- Teachers read memberships (lesson rosters for teaching-group lessons).
CREATE POLICY "student_group_members_staff_select" ON "StudentGroupMembers"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) IN ('TEACHER','SCHOOL_ADMIN'));

-- A student sees their own memberships (their schedule includes group lessons).
CREATE POLICY "student_group_members_own_select" ON "StudentGroupMembers"
    FOR SELECT TO "authenticated"
    USING ("studentId" = (select app.current_user_id()));

-- Guardians see their children's memberships.
CREATE POLICY "student_group_members_guardian_select" ON "StudentGroupMembers"
    FOR SELECT TO "authenticated"
    USING (
        "studentId" IN (
            SELECT gs."studentId" FROM "GuardianStudents" gs
            WHERE gs."guardianId" = (select app.current_user_id())
        )
    );
