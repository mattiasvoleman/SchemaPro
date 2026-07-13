-- =============================================================================
-- Lesson locking + schedule change audit trail
-- -----------------------------------------------------------------------------
-- 1. `MasterLessons.isLocked` — locked lessons survive regeneration untouched:
--    the gateway sends them to the optimizer as fixed placements and only the
--    remaining (unlocked) demand is re-solved.
-- 2. `ScheduleChangeLogs` — append-only audit trail of manual timetable edits
--    (create/update/delete) and regenerations. `masterLessonId` is a scalar
--    reference on purpose (no FK) so log rows outlive deleted lessons.
-- =============================================================================

-- CreateEnum
CREATE TYPE "ScheduleChangeAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'REGENERATE', 'RESTORE');

-- AlterTable
ALTER TABLE "MasterLessons" ADD COLUMN "isLocked" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ScheduleChangeLogs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "academicYearId" UUID NOT NULL,
    "masterLessonId" UUID,
    "actorId" UUID,
    "action" "ScheduleChangeAction" NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduleChangeLogs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduleChangeLogs_schoolId_academicYearId_createdAt_idx"
    ON "ScheduleChangeLogs"("schoolId", "academicYearId", "createdAt");
CREATE INDEX "ScheduleChangeLogs_masterLessonId_idx"
    ON "ScheduleChangeLogs"("masterLessonId");

-- AddForeignKey
ALTER TABLE "ScheduleChangeLogs"
    ADD CONSTRAINT "ScheduleChangeLogs_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- Row-Level Security (mirrors the project-wide pattern from the init migration)
-- -----------------------------------------------------------------------------
ALTER TABLE "ScheduleChangeLogs" ENABLE ROW LEVEL SECURITY;

-- Only school admins may read or write the audit trail, and only within their
-- own tenant. The log is append-only from the application's point of view; no
-- UPDATE/DELETE policy is created, so RLS denies both for `authenticated`.
CREATE POLICY "schedule_change_logs_admin_select" ON "ScheduleChangeLogs"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
    );

CREATE POLICY "schedule_change_logs_admin_insert" ON "ScheduleChangeLogs"
    FOR INSERT TO "authenticated"
    WITH CHECK (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
    );

-- -----------------------------------------------------------------------------
-- Named snapshots of the master timetable (save / compare / restore)
-- -----------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "ScheduleVersions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "academicYearId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdById" UUID,
    "lessons" JSONB NOT NULL,
    "lessonCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduleVersions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduleVersions_schoolId_academicYearId_createdAt_idx"
    ON "ScheduleVersions"("schoolId", "academicYearId", "createdAt");

-- AddForeignKey
ALTER TABLE "ScheduleVersions"
    ADD CONSTRAINT "ScheduleVersions_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: school admins only, scoped to their tenant.
ALTER TABLE "ScheduleVersions" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "schedule_versions_admin_all" ON "ScheduleVersions"
    FOR ALL TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
    )
    WITH CHECK (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
    );
