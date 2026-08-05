-- P2.8: self-service room bookings (Skola24 Lokal parity).

-- "Special" rooms whose bookings need admin approval.
ALTER TABLE "Rooms" ADD COLUMN "requiresApproval" BOOLEAN NOT NULL DEFAULT false;

CREATE TYPE "RoomBookingStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

CREATE TABLE "RoomBookings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "bookedById" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(6) NOT NULL,
    "endsAt" TIMESTAMPTZ(6) NOT NULL,
    "status" "RoomBookingStatus" NOT NULL DEFAULT 'APPROVED',
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ(6),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "RoomBookings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RoomBookings_schoolId_startsAt_idx" ON "RoomBookings"("schoolId", "startsAt");
CREATE INDEX "RoomBookings_roomId_startsAt_idx" ON "RoomBookings"("roomId", "startsAt");
CREATE INDEX "RoomBookings_bookedById_startsAt_idx" ON "RoomBookings"("bookedById", "startsAt");
CREATE INDEX "RoomBookings_schoolId_status_createdAt_idx" ON "RoomBookings"("schoolId", "status", "createdAt");

ALTER TABLE "RoomBookings" ADD CONSTRAINT "RoomBookings_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoomBookings" ADD CONSTRAINT "RoomBookings_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoomBookings" ADD CONSTRAINT "RoomBookings_bookedById_fkey" FOREIGN KEY ("bookedById") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoomBookings" ADD CONSTRAINT "RoomBookings_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS: teachers create/read/cancel their own bookings; teachers + admins read
-- every booking in the school (so the availability grid shows occupancy);
-- admins have full control (approve, read, cancel anything). Students: none.
ALTER TABLE "RoomBookings" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "room_bookings_teacher_insert" ON "RoomBookings"
    FOR INSERT TO "authenticated"
    WITH CHECK (
        "schoolId" = (select app.current_school_id())
        AND "bookedById" = (select app.current_user_id())
        AND (select app.current_user_role()) IN ('TEACHER', 'SCHOOL_ADMIN')
    );

CREATE POLICY "room_bookings_own_select" ON "RoomBookings"
    FOR SELECT TO "authenticated"
    USING ("bookedById" = (select app.current_user_id()));

CREATE POLICY "room_bookings_staff_select" ON "RoomBookings"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) IN ('TEACHER', 'SCHOOL_ADMIN')
    );

CREATE POLICY "room_bookings_own_update" ON "RoomBookings"
    FOR UPDATE TO "authenticated"
    USING ("bookedById" = (select app.current_user_id()))
    WITH CHECK ("bookedById" = (select app.current_user_id()));

CREATE POLICY "room_bookings_admin_all" ON "RoomBookings"
    FOR ALL TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
    )
    WITH CHECK (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
    );
