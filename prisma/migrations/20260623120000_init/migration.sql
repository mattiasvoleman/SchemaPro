-- =============================================================================
-- SchemaPro — initial migration
--   1. Enums
--   2. Tables (all primary/foreign keys are UUIDv4)
--   3. Foreign keys
--   4. Indexes (tuned for date/time range scans)
--   5. Row-Level Security: helpers, ENABLE RLS on every table, and policies
-- =============================================================================

-- Required for gen_random_uuid() (UUIDv4 generation at the database level).
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- -----------------------------------------------------------------------------
-- 1. Enums
-- -----------------------------------------------------------------------------
CREATE TYPE "UserRole" AS ENUM ('STUDENT', 'TEACHER', 'SCHOOL_ADMIN');
CREATE TYPE "RoomType" AS ENUM ('CLASSROOM', 'LABORATORY', 'GYMNASIUM', 'AUDITORIUM', 'WORKSHOP', 'OTHER');
CREATE TYPE "LessonStatus" AS ENUM ('SCHEDULED', 'CANCELLED', 'COMPLETED', 'RESCHEDULED');
CREATE TYPE "AttendanceStatus" AS ENUM ('UNKNOWN', 'PRESENT', 'ABSENT', 'LATE', 'EXCUSED');
CREATE TYPE "TeacherAssignmentRole" AS ENUM ('LEAD', 'ASSISTANT', 'SUBSTITUTE');
CREATE TYPE "ConstraintResource" AS ENUM ('TEACHER', 'ROOM', 'STUDENT_GROUP');
CREATE TYPE "ConstraintType" AS ENUM ('UNAVAILABLE', 'PREFERRED_FREE', 'PREFERRED_BUSY');

-- -----------------------------------------------------------------------------
-- 2. Tables
-- -----------------------------------------------------------------------------
CREATE TABLE "Schools" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Stockholm',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "Schools_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "authId" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "studentGroupId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "Users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Rooms" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "capacity" INTEGER,
    "type" "RoomType" NOT NULL DEFAULT 'CLASSROOM',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "Rooms_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Subjects" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "color" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "Subjects_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AcademicYears" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "AcademicYears_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StudentGroups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "academicYearId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "gradeLevel" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "StudentGroups_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TeachingRequirements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "academicYearId" UUID NOT NULL,
    "subjectId" UUID NOT NULL,
    "studentGroupId" UUID NOT NULL,
    "teacherId" UUID,
    "lessonsPerWeek" INTEGER NOT NULL DEFAULT 1,
    "minutesPerLesson" INTEGER NOT NULL DEFAULT 60,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "TeachingRequirements_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MasterLessons" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "academicYearId" UUID NOT NULL,
    "subjectId" UUID NOT NULL,
    "studentGroupId" UUID NOT NULL,
    "teacherId" UUID,
    "roomId" UUID,
    "dayOfWeek" INTEGER NOT NULL,
    "startTime" TIME(0) NOT NULL,
    "endTime" TIME(0) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "MasterLessons_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CalendarLessons" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "masterLessonId" UUID,
    "subjectId" UUID NOT NULL,
    "studentGroupId" UUID NOT NULL,
    "roomId" UUID,
    "date" DATE NOT NULL,
    "startsAt" TIMESTAMPTZ(6) NOT NULL,
    "endsAt" TIMESTAMPTZ(6) NOT NULL,
    "status" "LessonStatus" NOT NULL DEFAULT 'SCHEDULED',
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "CalendarLessons_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CalendarLessonTeachers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "calendarLessonId" UUID NOT NULL,
    "teacherId" UUID NOT NULL,
    "role" "TeacherAssignmentRole" NOT NULL DEFAULT 'LEAD',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CalendarLessonTeachers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AttendanceRecords" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "calendarLessonId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "status" "AttendanceStatus" NOT NULL DEFAULT 'UNKNOWN',
    "recordedById" UUID,
    "recordedAt" TIMESTAMPTZ(6),
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "AttendanceRecords_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AvailabilityConstraints" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "resourceType" "ConstraintResource" NOT NULL,
    "userId" UUID,
    "roomId" UUID,
    "studentGroupId" UUID,
    "dayOfWeek" INTEGER,
    "date" DATE,
    "startTime" TIME(0) NOT NULL,
    "endTime" TIME(0) NOT NULL,
    "type" "ConstraintType" NOT NULL DEFAULT 'UNAVAILABLE',
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "AvailabilityConstraints_pkey" PRIMARY KEY ("id")
);

-- -----------------------------------------------------------------------------
-- 3. Foreign keys
-- -----------------------------------------------------------------------------
ALTER TABLE "Users"
    ADD CONSTRAINT "Users_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "Users_studentGroupId_fkey" FOREIGN KEY ("studentGroupId") REFERENCES "StudentGroups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Rooms"
    ADD CONSTRAINT "Rooms_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Subjects"
    ADD CONSTRAINT "Subjects_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AcademicYears"
    ADD CONSTRAINT "AcademicYears_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StudentGroups"
    ADD CONSTRAINT "StudentGroups_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "StudentGroups_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYears"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TeachingRequirements"
    ADD CONSTRAINT "TeachingRequirements_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "TeachingRequirements_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYears"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "TeachingRequirements_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "TeachingRequirements_studentGroupId_fkey" FOREIGN KEY ("studentGroupId") REFERENCES "StudentGroups"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "TeachingRequirements_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MasterLessons"
    ADD CONSTRAINT "MasterLessons_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "MasterLessons_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYears"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "MasterLessons_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "MasterLessons_studentGroupId_fkey" FOREIGN KEY ("studentGroupId") REFERENCES "StudentGroups"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "MasterLessons_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "MasterLessons_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CalendarLessons"
    ADD CONSTRAINT "CalendarLessons_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "CalendarLessons_masterLessonId_fkey" FOREIGN KEY ("masterLessonId") REFERENCES "MasterLessons"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "CalendarLessons_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "CalendarLessons_studentGroupId_fkey" FOREIGN KEY ("studentGroupId") REFERENCES "StudentGroups"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "CalendarLessons_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CalendarLessonTeachers"
    ADD CONSTRAINT "CalendarLessonTeachers_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "CalendarLessonTeachers_calendarLessonId_fkey" FOREIGN KEY ("calendarLessonId") REFERENCES "CalendarLessons"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "CalendarLessonTeachers_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AttendanceRecords"
    ADD CONSTRAINT "AttendanceRecords_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "AttendanceRecords_calendarLessonId_fkey" FOREIGN KEY ("calendarLessonId") REFERENCES "CalendarLessons"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "AttendanceRecords_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "AttendanceRecords_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AvailabilityConstraints"
    ADD CONSTRAINT "AvailabilityConstraints_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "AvailabilityConstraints_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "AvailabilityConstraints_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "AvailabilityConstraints_studentGroupId_fkey" FOREIGN KEY ("studentGroupId") REFERENCES "StudentGroups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- 4. Indexes & unique constraints
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX "Schools_slug_key" ON "Schools"("slug");

CREATE UNIQUE INDEX "Users_authId_key" ON "Users"("authId");
CREATE UNIQUE INDEX "Users_schoolId_email_key" ON "Users"("schoolId", "email");
CREATE INDEX "Users_schoolId_idx" ON "Users"("schoolId");
CREATE INDEX "Users_schoolId_role_idx" ON "Users"("schoolId", "role");
CREATE INDEX "Users_studentGroupId_idx" ON "Users"("studentGroupId");

CREATE UNIQUE INDEX "Rooms_schoolId_name_key" ON "Rooms"("schoolId", "name");
CREATE INDEX "Rooms_schoolId_idx" ON "Rooms"("schoolId");

CREATE UNIQUE INDEX "Subjects_schoolId_code_key" ON "Subjects"("schoolId", "code");
CREATE INDEX "Subjects_schoolId_idx" ON "Subjects"("schoolId");

CREATE UNIQUE INDEX "AcademicYears_schoolId_name_key" ON "AcademicYears"("schoolId", "name");
CREATE INDEX "AcademicYears_schoolId_idx" ON "AcademicYears"("schoolId");
CREATE INDEX "AcademicYears_schoolId_startDate_endDate_idx" ON "AcademicYears"("schoolId", "startDate", "endDate");

CREATE UNIQUE INDEX "StudentGroups_schoolId_academicYearId_name_key" ON "StudentGroups"("schoolId", "academicYearId", "name");
CREATE INDEX "StudentGroups_schoolId_idx" ON "StudentGroups"("schoolId");
CREATE INDEX "StudentGroups_academicYearId_idx" ON "StudentGroups"("academicYearId");

CREATE UNIQUE INDEX "TeachingRequirements_academicYearId_studentGroupId_subjectI_key" ON "TeachingRequirements"("academicYearId", "studentGroupId", "subjectId");
CREATE INDEX "TeachingRequirements_schoolId_idx" ON "TeachingRequirements"("schoolId");
CREATE INDEX "TeachingRequirements_teacherId_idx" ON "TeachingRequirements"("teacherId");

CREATE INDEX "MasterLessons_schoolId_dayOfWeek_startTime_idx" ON "MasterLessons"("schoolId", "dayOfWeek", "startTime");
CREATE INDEX "MasterLessons_studentGroupId_dayOfWeek_idx" ON "MasterLessons"("studentGroupId", "dayOfWeek");
CREATE INDEX "MasterLessons_teacherId_dayOfWeek_idx" ON "MasterLessons"("teacherId", "dayOfWeek");
CREATE INDEX "MasterLessons_roomId_dayOfWeek_idx" ON "MasterLessons"("roomId", "dayOfWeek");

CREATE INDEX "CalendarLessons_schoolId_date_idx" ON "CalendarLessons"("schoolId", "date");
CREATE INDEX "CalendarLessons_schoolId_startsAt_endsAt_idx" ON "CalendarLessons"("schoolId", "startsAt", "endsAt");
CREATE INDEX "CalendarLessons_studentGroupId_date_idx" ON "CalendarLessons"("studentGroupId", "date");
CREATE INDEX "CalendarLessons_studentGroupId_startsAt_idx" ON "CalendarLessons"("studentGroupId", "startsAt");
CREATE INDEX "CalendarLessons_roomId_startsAt_idx" ON "CalendarLessons"("roomId", "startsAt");
CREATE INDEX "CalendarLessons_masterLessonId_idx" ON "CalendarLessons"("masterLessonId");
CREATE INDEX "CalendarLessons_date_idx" ON "CalendarLessons"("date");
CREATE INDEX "CalendarLessons_startsAt_idx" ON "CalendarLessons"("startsAt");

CREATE UNIQUE INDEX "CalendarLessonTeachers_calendarLessonId_teacherId_key" ON "CalendarLessonTeachers"("calendarLessonId", "teacherId");
CREATE INDEX "CalendarLessonTeachers_schoolId_idx" ON "CalendarLessonTeachers"("schoolId");
CREATE INDEX "CalendarLessonTeachers_teacherId_idx" ON "CalendarLessonTeachers"("teacherId");

CREATE UNIQUE INDEX "AttendanceRecords_calendarLessonId_studentId_key" ON "AttendanceRecords"("calendarLessonId", "studentId");
CREATE INDEX "AttendanceRecords_schoolId_recordedAt_idx" ON "AttendanceRecords"("schoolId", "recordedAt");
CREATE INDEX "AttendanceRecords_studentId_recordedAt_idx" ON "AttendanceRecords"("studentId", "recordedAt");
CREATE INDEX "AttendanceRecords_calendarLessonId_idx" ON "AttendanceRecords"("calendarLessonId");

CREATE INDEX "AvailabilityConstraints_schoolId_dayOfWeek_idx" ON "AvailabilityConstraints"("schoolId", "dayOfWeek");
CREATE INDEX "AvailabilityConstraints_userId_dayOfWeek_idx" ON "AvailabilityConstraints"("userId", "dayOfWeek");
CREATE INDEX "AvailabilityConstraints_roomId_dayOfWeek_idx" ON "AvailabilityConstraints"("roomId", "dayOfWeek");
CREATE INDEX "AvailabilityConstraints_studentGroupId_dayOfWeek_idx" ON "AvailabilityConstraints"("studentGroupId", "dayOfWeek");
CREATE INDEX "AvailabilityConstraints_date_idx" ON "AvailabilityConstraints"("date");

-- =============================================================================
-- 5. ROW-LEVEL SECURITY
-- =============================================================================
-- SECURITY MODEL
--   * The NestJS gateway opens a transaction per request and runs
--       SET LOCAL "request.jwt.claims" = '<verified JWT payload as JSON>';
--     so the helper functions below can read auth.uid()/auth.role().
--   * The application MUST connect as the non-owning, non-superuser role
--     `app_authenticated` (created below). RLS is NOT forced on the table
--     owner, which lets the SECURITY DEFINER helper functions resolve the
--     current user without recursive policy evaluation, while every
--     application query is still fully constrained by RLS.
-- -----------------------------------------------------------------------------

-- 5.1 Least-privilege application role -----------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
        CREATE ROLE "app_authenticated" NOLOGIN;
    END IF;
END
$$;

GRANT USAGE ON SCHEMA "public" TO "app_authenticated";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "public" TO "app_authenticated";
ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "app_authenticated";

-- 5.2 JWT + identity helper functions ------------------------------------------
CREATE SCHEMA IF NOT EXISTS "auth";
CREATE SCHEMA IF NOT EXISTS "app";

GRANT USAGE ON SCHEMA "auth" TO "app_authenticated";
GRANT USAGE ON SCHEMA "app" TO "app_authenticated";

-- Raw JWT subject claim (matches Users.authId).
CREATE OR REPLACE FUNCTION auth.uid() RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT NULLIF(
        coalesce(
            current_setting('request.jwt.claim.sub', true),
            (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')
        ),
        ''
    )
$$;

-- Raw JWT role claim.
CREATE OR REPLACE FUNCTION auth.role() RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT coalesce(
        current_setting('request.jwt.claim.role', true),
        (current_setting('request.jwt.claims', true)::jsonb ->> 'role')
    )
$$;

-- The internal user id of the caller. SECURITY DEFINER so it can read Users
-- without being blocked (or recursing) through RLS.
CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
    SELECT "id" FROM "Users" WHERE "authId" = auth.uid()
$$;

-- The caller's school (tenant) id.
CREATE OR REPLACE FUNCTION app.current_school_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
    SELECT "schoolId" FROM "Users" WHERE "authId" = auth.uid()
$$;

-- The caller's application role (authoritative, read from the DB).
CREATE OR REPLACE FUNCTION app.current_user_role() RETURNS "UserRole"
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
    SELECT "role" FROM "Users" WHERE "authId" = auth.uid()
$$;

-- The student's own group (NULL for staff). Used to scope a student's schedule.
CREATE OR REPLACE FUNCTION app.current_user_group_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
    SELECT "studentGroupId" FROM "Users" WHERE "authId" = auth.uid()
$$;

GRANT EXECUTE ON FUNCTION
    auth.uid(), auth.role(),
    app.current_user_id(), app.current_school_id(),
    app.current_user_role(), app.current_user_group_id()
TO "app_authenticated";

-- 5.3 Enable RLS on every table ------------------------------------------------
ALTER TABLE "Schools" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Rooms" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Subjects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AcademicYears" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StudentGroups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TeachingRequirements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MasterLessons" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CalendarLessons" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CalendarLessonTeachers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AttendanceRecords" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AvailabilityConstraints" ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- 5.4 Policies
--   Permissive policies are OR-combined: a row is accessible if ANY policy of
--   the matching command passes. Each table therefore gets one policy per role.
-- =============================================================================

-- ---- Schools ----------------------------------------------------------------
-- Any member of the school can read their own school record.
CREATE POLICY "schools_member_select" ON "Schools"
    FOR SELECT TO "app_authenticated"
    USING ("id" = app.current_school_id());

-- Admins may update their own school.
CREATE POLICY "schools_admin_update" ON "Schools"
    FOR UPDATE TO "app_authenticated"
    USING ("id" = app.current_school_id() AND app.current_user_role() = 'SCHOOL_ADMIN')
    WITH CHECK ("id" = app.current_school_id() AND app.current_user_role() = 'SCHOOL_ADMIN');

-- ---- Users ------------------------------------------------------------------
-- Students can read only their own record.
CREATE POLICY "users_self_select" ON "Users"
    FOR SELECT TO "app_authenticated"
    USING ("id" = app.current_user_id());

-- Teachers (and admins) can read every user in their school.
CREATE POLICY "users_staff_select" ON "Users"
    FOR SELECT TO "app_authenticated"
    USING (
        "schoolId" = app.current_school_id()
        AND app.current_user_role() IN ('TEACHER', 'SCHOOL_ADMIN')
    );

-- Admins have full write access to users within their school.
CREATE POLICY "users_admin_all" ON "Users"
    FOR ALL TO "app_authenticated"
    USING ("schoolId" = app.current_school_id() AND app.current_user_role() = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = app.current_school_id() AND app.current_user_role() = 'SCHOOL_ADMIN');

-- ---- Rooms ------------------------------------------------------------------
-- All members can read rooms of their school (needed to render schedules).
CREATE POLICY "rooms_member_select" ON "Rooms"
    FOR SELECT TO "app_authenticated"
    USING ("schoolId" = app.current_school_id());

CREATE POLICY "rooms_admin_all" ON "Rooms"
    FOR ALL TO "app_authenticated"
    USING ("schoolId" = app.current_school_id() AND app.current_user_role() = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = app.current_school_id() AND app.current_user_role() = 'SCHOOL_ADMIN');

-- ---- Subjects ---------------------------------------------------------------
CREATE POLICY "subjects_member_select" ON "Subjects"
    FOR SELECT TO "app_authenticated"
    USING ("schoolId" = app.current_school_id());

CREATE POLICY "subjects_admin_all" ON "Subjects"
    FOR ALL TO "app_authenticated"
    USING ("schoolId" = app.current_school_id() AND app.current_user_role() = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = app.current_school_id() AND app.current_user_role() = 'SCHOOL_ADMIN');

-- ---- AcademicYears ----------------------------------------------------------
CREATE POLICY "academic_years_member_select" ON "AcademicYears"
    FOR SELECT TO "app_authenticated"
    USING ("schoolId" = app.current_school_id());

CREATE POLICY "academic_years_admin_all" ON "AcademicYears"
    FOR ALL TO "app_authenticated"
    USING ("schoolId" = app.current_school_id() AND app.current_user_role() = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = app.current_school_id() AND app.current_user_role() = 'SCHOOL_ADMIN');

-- ---- StudentGroups ----------------------------------------------------------
-- A student sees only their own group; staff see all groups in the school.
CREATE POLICY "student_groups_student_select" ON "StudentGroups"
    FOR SELECT TO "app_authenticated"
    USING ("id" = app.current_user_group_id());

CREATE POLICY "student_groups_staff_select" ON "StudentGroups"
    FOR SELECT TO "app_authenticated"
    USING (
        "schoolId" = app.current_school_id()
        AND app.current_user_role() IN ('TEACHER', 'SCHOOL_ADMIN')
    );

CREATE POLICY "student_groups_admin_all" ON "StudentGroups"
    FOR ALL TO "app_authenticated"
    USING ("schoolId" = app.current_school_id() AND app.current_user_role() = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = app.current_school_id() AND app.current_user_role() = 'SCHOOL_ADMIN');

-- ---- TeachingRequirements (curriculum planning: staff only) -----------------
CREATE POLICY "teaching_requirements_staff_select" ON "TeachingRequirements"
    FOR SELECT TO "app_authenticated"
    USING (
        "schoolId" = app.current_school_id()
        AND app.current_user_role() IN ('TEACHER', 'SCHOOL_ADMIN')
    );

CREATE POLICY "teaching_requirements_admin_all" ON "TeachingRequirements"
    FOR ALL TO "app_authenticated"
    USING ("schoolId" = app.current_school_id() AND app.current_user_role() = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = app.current_school_id() AND app.current_user_role() = 'SCHOOL_ADMIN');

-- ---- MasterLessons ----------------------------------------------------------
-- Students may read the recurring template for their own group.
CREATE POLICY "master_lessons_student_select" ON "MasterLessons"
    FOR SELECT TO "app_authenticated"
    USING ("studentGroupId" = app.current_user_group_id());

CREATE POLICY "master_lessons_staff_select" ON "MasterLessons"
    FOR SELECT TO "app_authenticated"
    USING (
        "schoolId" = app.current_school_id()
        AND app.current_user_role() IN ('TEACHER', 'SCHOOL_ADMIN')
    );

CREATE POLICY "master_lessons_admin_all" ON "MasterLessons"
    FOR ALL TO "app_authenticated"
    USING ("schoolId" = app.current_school_id() AND app.current_user_role() = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = app.current_school_id() AND app.current_user_role() = 'SCHOOL_ADMIN');

-- ---- CalendarLessons --------------------------------------------------------
-- Students see only their own group's lessons (their personal schedule).
CREATE POLICY "calendar_lessons_student_select" ON "CalendarLessons"
    FOR SELECT TO "app_authenticated"
    USING ("studentGroupId" = app.current_user_group_id());

-- Teachers and admins see every lesson in their school.
CREATE POLICY "calendar_lessons_staff_select" ON "CalendarLessons"
    FOR SELECT TO "app_authenticated"
    USING (
        "schoolId" = app.current_school_id()
        AND app.current_user_role() IN ('TEACHER', 'SCHOOL_ADMIN')
    );

CREATE POLICY "calendar_lessons_admin_all" ON "CalendarLessons"
    FOR ALL TO "app_authenticated"
    USING ("schoolId" = app.current_school_id() AND app.current_user_role() = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = app.current_school_id() AND app.current_user_role() = 'SCHOOL_ADMIN');

-- ---- CalendarLessonTeachers -------------------------------------------------
-- Students can see the teacher assignment(s) for their own group's lessons.
CREATE POLICY "calendar_lesson_teachers_student_select" ON "CalendarLessonTeachers"
    FOR SELECT TO "app_authenticated"
    USING (
        EXISTS (
            SELECT 1 FROM "CalendarLessons" cl
            WHERE cl."id" = "CalendarLessonTeachers"."calendarLessonId"
              AND cl."studentGroupId" = app.current_user_group_id()
        )
    );

CREATE POLICY "calendar_lesson_teachers_staff_select" ON "CalendarLessonTeachers"
    FOR SELECT TO "app_authenticated"
    USING (
        "schoolId" = app.current_school_id()
        AND app.current_user_role() IN ('TEACHER', 'SCHOOL_ADMIN')
    );

CREATE POLICY "calendar_lesson_teachers_admin_all" ON "CalendarLessonTeachers"
    FOR ALL TO "app_authenticated"
    USING ("schoolId" = app.current_school_id() AND app.current_user_role() = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = app.current_school_id() AND app.current_user_role() = 'SCHOOL_ADMIN');

-- ---- AttendanceRecords ------------------------------------------------------
-- Students can read only their own attendance.
CREATE POLICY "attendance_student_select" ON "AttendanceRecords"
    FOR SELECT TO "app_authenticated"
    USING ("studentId" = app.current_user_id());

-- Teachers (and admins) can read all attendance in their school.
CREATE POLICY "attendance_staff_select" ON "AttendanceRecords"
    FOR SELECT TO "app_authenticated"
    USING (
        "schoolId" = app.current_school_id()
        AND app.current_user_role() IN ('TEACHER', 'SCHOOL_ADMIN')
    );

-- Teachers may insert attendance only for lessons they are assigned to.
CREATE POLICY "attendance_teacher_insert" ON "AttendanceRecords"
    FOR INSERT TO "app_authenticated"
    WITH CHECK (
        "schoolId" = app.current_school_id()
        AND app.current_user_role() = 'TEACHER'
        AND EXISTS (
            SELECT 1 FROM "CalendarLessonTeachers" clt
            WHERE clt."calendarLessonId" = "AttendanceRecords"."calendarLessonId"
              AND clt."teacherId" = app.current_user_id()
        )
    );

-- Teachers may update attendance only for lessons they are assigned to.
CREATE POLICY "attendance_teacher_update" ON "AttendanceRecords"
    FOR UPDATE TO "app_authenticated"
    USING (
        "schoolId" = app.current_school_id()
        AND app.current_user_role() = 'TEACHER'
        AND EXISTS (
            SELECT 1 FROM "CalendarLessonTeachers" clt
            WHERE clt."calendarLessonId" = "AttendanceRecords"."calendarLessonId"
              AND clt."teacherId" = app.current_user_id()
        )
    )
    WITH CHECK (
        "schoolId" = app.current_school_id()
        AND app.current_user_role() = 'TEACHER'
        AND EXISTS (
            SELECT 1 FROM "CalendarLessonTeachers" clt
            WHERE clt."calendarLessonId" = "AttendanceRecords"."calendarLessonId"
              AND clt."teacherId" = app.current_user_id()
        )
    );

-- Admins have full control over attendance in their school.
CREATE POLICY "attendance_admin_all" ON "AttendanceRecords"
    FOR ALL TO "app_authenticated"
    USING ("schoolId" = app.current_school_id() AND app.current_user_role() = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = app.current_school_id() AND app.current_user_role() = 'SCHOOL_ADMIN');

-- ---- AvailabilityConstraints ------------------------------------------------
-- Teachers can read and manage their own availability constraints.
CREATE POLICY "availability_teacher_select" ON "AvailabilityConstraints"
    FOR SELECT TO "app_authenticated"
    USING (
        "schoolId" = app.current_school_id()
        AND app.current_user_role() IN ('TEACHER', 'SCHOOL_ADMIN')
    );

CREATE POLICY "availability_teacher_modify" ON "AvailabilityConstraints"
    FOR ALL TO "app_authenticated"
    USING (
        "schoolId" = app.current_school_id()
        AND app.current_user_role() = 'TEACHER'
        AND "userId" = app.current_user_id()
    )
    WITH CHECK (
        "schoolId" = app.current_school_id()
        AND app.current_user_role() = 'TEACHER'
        AND "userId" = app.current_user_id()
    );

CREATE POLICY "availability_admin_all" ON "AvailabilityConstraints"
    FOR ALL TO "app_authenticated"
    USING ("schoolId" = app.current_school_id() AND app.current_user_role() = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = app.current_school_id() AND app.current_user_role() = 'SCHOOL_ADMIN');
