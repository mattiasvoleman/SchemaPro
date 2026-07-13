-- In-app notifications (optionally mirrored to email by the gateway).

CREATE TYPE "NotificationType" AS ENUM (
    'ABSENCE_UNREPORTED', 'LEAVE_DECIDED', 'LESSON_CANCELLED',
    'LESSON_SUBSTITUTE', 'SCHEDULE_CHANGED'
);

CREATE TABLE "Notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "meta" JSONB,
    "readAt" TIMESTAMPTZ(6),
    "emailedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Notifications_userId_createdAt_idx" ON "Notifications"("userId", "createdAt");
CREATE INDEX "Notifications_schoolId_idx" ON "Notifications"("schoolId");

ALTER TABLE "Notifications" ADD CONSTRAINT "Notifications_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Notifications" ADD CONSTRAINT "Notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: recipients read + mark-read their own rows; staff create for anyone in
-- their school (attendance/schedule triggers run as teacher or admin).
ALTER TABLE "Notifications" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "notifications_own_select" ON "Notifications"
    FOR SELECT TO "authenticated"
    USING ("userId" = (select app.current_user_id()));

CREATE POLICY "notifications_own_update" ON "Notifications"
    FOR UPDATE TO "authenticated"
    USING ("userId" = (select app.current_user_id()))
    WITH CHECK ("userId" = (select app.current_user_id()));

CREATE POLICY "notifications_staff_insert" ON "Notifications"
    FOR INSERT TO "authenticated"
    WITH CHECK (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) IN ('TEACHER', 'SCHOOL_ADMIN')
    );

CREATE POLICY "notifications_admin_select" ON "Notifications"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
    );
