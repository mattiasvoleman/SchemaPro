-- Nya slag av notiser och gallring för vikarieförfrågningar.
--
-- Vikariefrågan (D4) lets the school ask chosen colleagues to cover a lesson
-- and gives the first who says yes the lesson. Three things are told and one
-- kind of data is kept, and each is a value added to an enum:
--
--   * COVER_REQUESTED       to each colleague asked: the lessons and the
--                           time, never the absent teacher or why.
--   * COVER_REQUEST_ACCEPTED to the administrator who asked: who took it.
--   * COVER_REQUEST_CLOSED  to each colleague asked who did not get it: it
--                           is taken (meta.reason TAKEN), withdrawn
--                           (WITHDRAWN) or no longer needed.
--   * COVER_REQUESTS        a kind of data the school sets a retention period
--                           for, like every other on /admin/dataskydd: it
--                           starts at "ej beslutat" in every school and
--                           nothing is purged until the school records a
--                           period.
--
-- Its own migration: a value added to an enum cannot be used in the
-- transaction that adds it (20261018090000, 20261026090000), and the next
-- file compiles app.gallring_due, a LANGUAGE sql function that names
-- COVER_REQUESTS. Nothing else here; no row is written, and no table is
-- locked, so it runs beside the live API without waiting for anything. The
-- API before this migration writes none of the values and reads its own
-- types; its Prisma client names none of them, so it works unchanged
-- between this migration and the deploy.

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'COVER_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'COVER_REQUEST_ACCEPTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'COVER_REQUEST_CLOSED';
ALTER TYPE "RetentionDataType" ADD VALUE IF NOT EXISTS 'COVER_REQUESTS';
