-- P1.7: room-change notices for the substitute & cancellation workflow.
-- Adds a new value to the notification enum. `ADD VALUE` cannot run inside a
-- transaction block, so this migration contains only this statement.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'LESSON_ROOM_CHANGED';
