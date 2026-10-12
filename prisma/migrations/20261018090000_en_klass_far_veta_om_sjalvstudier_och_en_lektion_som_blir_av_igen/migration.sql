-- En klass får veta om självstudier och om en lektion som blir av igen.
--
-- Three notification types (Notiser som når fram):
--
--   * LESSON_REINSTATED: a lesson goes ahead as its timetable says after
--     all — a cancelled lesson reinstated ("Återinsätt"), or a cover
--     decision the class was told about undone on the cover board (a
--     cancellation, a substitute, självstudier). Meta: subject and start, as
--     LESSON_CANCELLED.
--   * LESSON_SUPERVISED_STUDY: the cover board decided självstudier under
--     tillsyn for a lesson whose teacher is away. Meta: subject and start.
--     Until now the class read it only in the lesson's note.
--   * CANCELLATION_DIGEST: one notice per person for a bulk avbokning
--     (20261011110000) when the admin ticks it in the preview, and another
--     when the avbokning is taken back. Meta: the avbokning's name, the
--     person's own count of lessons and their first and last day, and
--     whether it is the reversal. A type of its own rather than a
--     LESSON_CANCELLED with other meta: an app that predates it shows its
--     generic line for an unknown type, where a reused type would print
--     "Inställd lektion" with an empty subject and time.
--
-- All three go to the people on the lesson's roster and their guardians
-- (and, as the other lesson notices, to the teachers concerned). None is a
-- notice the school must deliver, so each is an opt-out a person may choose
-- (NotificationOptOuts' CHECKs name only ABSENCE_UNREPORTED and
-- TEACHER_ABSENCE_REPORTED).
--
-- Its own migration: a value added to an enum cannot be used in the
-- transaction that adds it (as 20261012120000). Nothing else here; no data
-- is written, and the gateway that writes these types ships after it.

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'LESSON_REINSTATED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'LESSON_SUPERVISED_STUDY';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CANCELLATION_DIGEST';
