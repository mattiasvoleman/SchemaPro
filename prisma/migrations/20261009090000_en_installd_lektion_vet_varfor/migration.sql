-- En inställd lektion vet varför.
--
-- The timplan's third layer (P3, "genomfört mot schemalagt") splits the time a
-- pupil lost by cause: cancelled because the teacher could not, because the
-- room could not, by the school, or held by nobody. Skolinspektionen asks for
-- exactly that split, and teacher absence is the commonest cause. Nothing in a
-- CalendarLesson said it. Publish writes CANCELLED with one of two fixed
-- notes; cancel() writes CANCELLED with the admin's free text or the old note;
-- a substitute assigned later may overwrite the note. The free text is the
-- pupils' and guardians' to read ("Brandövning"), never a category, and a
-- category read out of it stops being true the first time somebody edits it.
--
-- ## One column, one enum
--
-- "cancelCause" "LessonCancelCause" NULL, with no default:
--
--   * TEACHER_UNAVAILABLE — publish found a dated teacher closure for the day,
--     or the teacher-absence page cancelled the lesson because the teacher is
--     away (PATCH /calendar-lessons/:id/cancel with `cause`, from P3 on);
--   * ROOM_UNAVAILABLE — publish found a dated room closure;
--   * MANUAL — cancelled by the school through cancel() with no cause given.
--
-- NULL means "no cause recorded", and the timplan layer reads it so
-- (CANCELLED_UNKNOWN). The column is only ever asked about under status
-- CANCELLED; reinstate() writes NULL back. No CHECK couples it to the status:
-- a PostgREST writer flipping the status back and forth does no harm, because
-- no reader asks a scheduled row for its cause, and a CHECK would refuse a
-- harmless write. The free text stays in "note".
--
-- A nullable column without a default is a catalog-only change: the table is
-- not rewritten and is locked for a moment only, however many calendar rows a
-- school has.
--
-- ## Backfill: only what is certain
--
-- Rows that are CANCELLED with exactly one of publish's two fixed notes get
-- their cause. Nobody else writes that text, so such a row is certainly
-- publish's. Every other old cancelled row stays NULL — not MANUAL, because a
-- publish-cancelled row whose note a substitute later rewrote cannot be told
-- from one the school cancelled, and calling it "inställd av skolan" would be
-- making it up.
--
-- The UPDATEs leave "updatedAt" alone: Prisma sets it in the client, not the
-- database, and no trigger sits on the table (20260822131500 removed the last
-- ones). The rows look untouched, which in substance they are.
--
-- ## Nothing else changes
--
-- No new policy: the column follows the row's existing RLS. No realtime or
-- SS12000 change — the export still says only cancelled: true. No index: the
-- reader asks for the cause of rows it has already found.

CREATE TYPE "LessonCancelCause" AS ENUM ('TEACHER_UNAVAILABLE', 'ROOM_UNAVAILABLE', 'MANUAL');

ALTER TABLE "CalendarLessons" ADD COLUMN "cancelCause" "LessonCancelCause";

UPDATE "CalendarLessons"
   SET "cancelCause" = 'TEACHER_UNAVAILABLE'
 WHERE "status" = 'CANCELLED'
   AND "note" = 'Inställd: läraren är inte tillgänglig detta datum.';

UPDATE "CalendarLessons"
   SET "cancelCause" = 'ROOM_UNAVAILABLE'
 WHERE "status" = 'CANCELLED'
   AND "note" = 'Inställd: salen är inte tillgänglig detta datum.';
