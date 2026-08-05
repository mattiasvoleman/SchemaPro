-- P2.8: notify the requester when an admin decides a room-booking request.
-- ADD VALUE cannot run inside a transaction block, so this migration contains
-- only this statement.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ROOM_BOOKING_DECIDED';
