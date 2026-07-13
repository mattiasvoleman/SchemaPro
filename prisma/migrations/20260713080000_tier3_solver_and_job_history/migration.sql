-- =============================================================================
-- Tier 3: solver enrichment inputs + durable optimization run history
-- -----------------------------------------------------------------------------
-- 1. `Subjects.requiredRoomType` — subjects can require a room type (labs →
--    laboratories); the optimizer and the gateway both enforce it.
-- 2. `OptimizationJobs` — durable job store replacing the in-memory queue:
--    survives restarts, works multi-instance, and doubles as run history.
-- =============================================================================

-- CreateEnum
CREATE TYPE "OptimizationJobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- AlterTable
ALTER TABLE "Subjects" ADD COLUMN "requiredRoomType" "RoomType";

-- CreateTable
CREATE TABLE "OptimizationJobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "academicYearId" UUID NOT NULL,
    "actorId" UUID,
    "status" "OptimizationJobStatus" NOT NULL DEFAULT 'PENDING',
    "solverStatus" TEXT,
    "lessonsGenerated" INTEGER NOT NULL DEFAULT 0,
    "conflictSummary" TEXT,
    "conflicts" JSONB,
    "error" TEXT,
    "weights" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(6),

    CONSTRAINT "OptimizationJobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OptimizationJobs_schoolId_academicYearId_createdAt_idx"
    ON "OptimizationJobs"("schoolId", "academicYearId", "createdAt");

-- AddForeignKey
ALTER TABLE "OptimizationJobs"
    ADD CONSTRAINT "OptimizationJobs_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: school admins only, scoped to their tenant.
ALTER TABLE "OptimizationJobs" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "optimization_jobs_admin_all" ON "OptimizationJobs"
    FOR ALL TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
    )
    WITH CHECK (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
    );
