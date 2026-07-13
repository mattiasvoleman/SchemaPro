-- Guardians, absence reporting and leave requests (Skola24 Frånvaro parity).

-- CreateEnum
CREATE TYPE "AbsenceReportType" AS ENUM ('SICK', 'APPOINTMENT', 'OTHER');
CREATE TYPE "LeaveRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "GuardianStudents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "guardianId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GuardianStudents_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "AbsenceReports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "reportedById" UUID NOT NULL,
    "date" DATE NOT NULL,
    "startTime" TIME(0),
    "endTime" TIME(0),
    "type" "AbsenceReportType" NOT NULL DEFAULT 'SICK',
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AbsenceReports_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "LeaveRequests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "requestedById" UUID NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "LeaveRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ(6),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LeaveRequests_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "GuardianStudents_guardianId_studentId_key" ON "GuardianStudents"("guardianId", "studentId");
CREATE INDEX "GuardianStudents_schoolId_idx" ON "GuardianStudents"("schoolId");
CREATE INDEX "GuardianStudents_studentId_idx" ON "GuardianStudents"("studentId");
CREATE INDEX "AbsenceReports_schoolId_date_idx" ON "AbsenceReports"("schoolId", "date");
CREATE INDEX "AbsenceReports_studentId_date_idx" ON "AbsenceReports"("studentId", "date");
CREATE INDEX "LeaveRequests_schoolId_status_createdAt_idx" ON "LeaveRequests"("schoolId", "status", "createdAt");
CREATE INDEX "LeaveRequests_studentId_startDate_idx" ON "LeaveRequests"("studentId", "startDate");

-- Foreign keys
ALTER TABLE "GuardianStudents" ADD CONSTRAINT "GuardianStudents_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GuardianStudents" ADD CONSTRAINT "GuardianStudents_guardianId_fkey" FOREIGN KEY ("guardianId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GuardianStudents" ADD CONSTRAINT "GuardianStudents_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AbsenceReports" ADD CONSTRAINT "AbsenceReports_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AbsenceReports" ADD CONSTRAINT "AbsenceReports_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AbsenceReports" ADD CONSTRAINT "AbsenceReports_reportedById_fkey" FOREIGN KEY ("reportedById") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeaveRequests" ADD CONSTRAINT "LeaveRequests_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeaveRequests" ADD CONSTRAINT "LeaveRequests_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeaveRequests" ADD CONSTRAINT "LeaveRequests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeaveRequests" ADD CONSTRAINT "LeaveRequests_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- RLS. GUARDIAN comparisons use ::text so the enum value added in the previous
-- migration is never referenced as an enum literal here.
-- -----------------------------------------------------------------------------
ALTER TABLE "GuardianStudents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AbsenceReports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LeaveRequests" ENABLE ROW LEVEL SECURITY;

-- Guardians may read the profiles of their own children.
CREATE POLICY "users_guardian_children_select" ON "Users"
    FOR SELECT TO "authenticated"
    USING (
        "id" IN (
            SELECT gs."studentId" FROM "GuardianStudents" gs
            WHERE gs."guardianId" = (select app.current_user_id())
        )
    );

-- ---- GuardianStudents ----
CREATE POLICY "guardian_students_admin_all" ON "GuardianStudents"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
CREATE POLICY "guardian_students_staff_select" ON "GuardianStudents"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) IN ('TEACHER','SCHOOL_ADMIN'));
CREATE POLICY "guardian_students_own_select" ON "GuardianStudents"
    FOR SELECT TO "authenticated"
    USING ("guardianId" = (select app.current_user_id()));

-- ---- AbsenceReports ----
CREATE POLICY "absence_reports_admin_all" ON "AbsenceReports"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
CREATE POLICY "absence_reports_staff_select" ON "AbsenceReports"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) IN ('TEACHER','SCHOOL_ADMIN'));
-- Guardians: full visibility of their children's reports; may create reports
-- for their children (as themselves) and delete their own reports.
CREATE POLICY "absence_reports_guardian_select" ON "AbsenceReports"
    FOR SELECT TO "authenticated"
    USING (
        "studentId" IN (
            SELECT gs."studentId" FROM "GuardianStudents" gs
            WHERE gs."guardianId" = (select app.current_user_id())
        )
    );
CREATE POLICY "absence_reports_guardian_insert" ON "AbsenceReports"
    FOR INSERT TO "authenticated"
    WITH CHECK (
        "schoolId" = (select app.current_school_id())
        AND "reportedById" = (select app.current_user_id())
        AND "studentId" IN (
            SELECT gs."studentId" FROM "GuardianStudents" gs
            WHERE gs."guardianId" = (select app.current_user_id())
        )
    );
-- Adult students: report and see their own absences.
CREATE POLICY "absence_reports_student_select" ON "AbsenceReports"
    FOR SELECT TO "authenticated"
    USING ("studentId" = (select app.current_user_id()));
CREATE POLICY "absence_reports_student_insert" ON "AbsenceReports"
    FOR INSERT TO "authenticated"
    WITH CHECK (
        "schoolId" = (select app.current_school_id())
        AND "reportedById" = (select app.current_user_id())
        AND "studentId" = (select app.current_user_id())
    );
CREATE POLICY "absence_reports_reporter_delete" ON "AbsenceReports"
    FOR DELETE TO "authenticated"
    USING ("reportedById" = (select app.current_user_id()));

-- ---- LeaveRequests ----
CREATE POLICY "leave_requests_admin_all" ON "LeaveRequests"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
CREATE POLICY "leave_requests_staff_select" ON "LeaveRequests"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) IN ('TEACHER','SCHOOL_ADMIN'));
CREATE POLICY "leave_requests_guardian_select" ON "LeaveRequests"
    FOR SELECT TO "authenticated"
    USING (
        "studentId" IN (
            SELECT gs."studentId" FROM "GuardianStudents" gs
            WHERE gs."guardianId" = (select app.current_user_id())
        )
    );
CREATE POLICY "leave_requests_guardian_insert" ON "LeaveRequests"
    FOR INSERT TO "authenticated"
    WITH CHECK (
        "schoolId" = (select app.current_school_id())
        AND "requestedById" = (select app.current_user_id())
        AND "studentId" IN (
            SELECT gs."studentId" FROM "GuardianStudents" gs
            WHERE gs."guardianId" = (select app.current_user_id())
        )
    );
CREATE POLICY "leave_requests_student_select" ON "LeaveRequests"
    FOR SELECT TO "authenticated"
    USING ("studentId" = (select app.current_user_id()));
