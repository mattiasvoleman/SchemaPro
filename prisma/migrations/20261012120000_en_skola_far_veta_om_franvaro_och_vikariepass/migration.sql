-- En skola får veta om frånvaro och vikariepass.
--
-- Two notification types for the cover board (20261012100000):
--
--   * TEACHER_ABSENCE_REPORTED: a teacher registered their own absence
--     (self-report, when the school allows it), and the school's active
--     admins are told. The notice carries the absence's id and its period
--     — the admins read the absence itself under their own arm — and NEVER
--     its reason: notifications are read by the admin arm of the whole
--     school, and a reason in a notice would be a reason outside the one
--     table that restricts it.
--   * LESSON_COVER_WITHDRAWN: a substitute who was booked is no longer
--     needed — the decision was undone, the absence shortened or withdrawn,
--     or another substitute put in. Without it a timvikarie who only reads
--     e-mail turns up for a lesson somebody else is teaching. Meta: subject,
--     start, group and room, as the booking notice; no absence, no reason.
--
-- Its own migration: a value added to an enum cannot be used in the
-- transaction that adds it (as LessonCancelCause's EVENT, 20261011103000).
-- Nothing else here; no data is written.

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TEACHER_ABSENCE_REPORTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'LESSON_COVER_WITHDRAWN';
