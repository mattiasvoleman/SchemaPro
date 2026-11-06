-- Nya slag av notiser och gallring för krisläget.
--
-- Krisläge (F2) lets an administrator start an alarm (utrymning or
-- inrymning, a real one or an exercise) and gives every teacher the group
-- the timetable says is theirs, to be counted and reported. Three things
-- are told and two kinds of data are kept, and each is a value added to an
-- enum:
--
--   * CRISIS_ALARM           to the school's staff: that an alarm is going.
--                            Never a pupil, a group, a place or a name.
--   * CRISIS_ENDED           to the school's staff: that it is over.
--   * CRISIS_GUARDIAN_AFTER  to the guardians of the pupils on the lists,
--                            once the alarm is over and only when the school
--                            has chosen to tell them: that it happened and
--                            ended. Nothing of any pupil.
--   * CRISIS_DRILLS          a kind of data the school sets a retention
--                            period for, like every other on
--                            /admin/dataskydd: the exercises. They are kept
--                            apart from the real alarms and may be purged
--                            sooner.
--   * CRISIS_ALARMS          the real alarms, kept as the school decides.
--                            Both start at "ej beslutat" in every school and
--                            nothing is purged until the school records a
--                            period.
--
-- Its own migration: a value added to an enum cannot be used in the
-- transaction that adds it (20261018090000, 20261026090000, 20270102090000),
-- and the next file compiles app.gallring_due, a LANGUAGE sql function that
-- names both kinds of data. Nothing else here; no row is written and no
-- table is locked, so it runs beside the live API without waiting for
-- anything. The API before this migration writes none of the values and
-- reads its own types; its Prisma client names none of them, so it works
-- unchanged between this migration and the deploy.

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CRISIS_ALARM';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CRISIS_ENDED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CRISIS_GUARDIAN_AFTER';
ALTER TYPE "RetentionDataType" ADD VALUE IF NOT EXISTS 'CRISIS_DRILLS';
ALTER TYPE "RetentionDataType" ADD VALUE IF NOT EXISTS 'CRISIS_ALARMS';
