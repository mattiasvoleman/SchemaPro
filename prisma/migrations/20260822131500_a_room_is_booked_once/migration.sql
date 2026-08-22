-- Two active bookings may not hold the same room at the same time.
--
-- The check was check-then-write under READ COMMITTED with nothing to make it
-- atomic: two teachers pressing "boka" at the same moment both saw the room
-- free and both got it. A range and an EXCLUDE constraint state the rule where
-- it can actually be enforced, and the times here are already timestamptz, so
-- tstzrange says it directly.
--
-- SCOPED TO ROOM BOOKINGS ON PURPOSE, and the reasoning is worth keeping.
--
-- The same constraint on CalendarLessons was written and then removed. Publish
-- materialises a whole year inside one transaction, so a single overlapping
-- pair — which a school can already create by hand in the master timetable —
-- would abort the entire publish with a 500 rather than skipping one lesson.
-- Trading "a room is occasionally double-booked" for "the year cannot be
-- published at all" is not a trade worth making, and doing it per-lesson needs
-- savepoints that publish is not built around.
--
-- Advisory-lock triggers on rooms and teachers were written and removed too.
-- They took a transaction-scoped lock per room, and publish holds its
-- transaction for up to two minutes: every publish would have queued behind
-- every other writer touching any of its rooms, and two writers touching the
-- same two rooms in opposite order would deadlock outright. That is a heavier
-- failure than the medium-severity race it closed.
--
-- What remains open, stated rather than discovered: two admins can still
-- double-book a room or a teacher in the MASTER timetable. That path is
-- admin-only and the generator's own output is conflict-free, so the exposure
-- is two people editing the same slot in the same second. Closing it properly
-- means making publish resilient to a per-row constraint violation first.

CREATE EXTENSION IF NOT EXISTS "btree_gist";

ALTER TABLE "RoomBookings"
    ADD CONSTRAINT "RoomBookings_room_is_held_once" EXCLUDE USING gist (
        "roomId" WITH =,
        tstzrange("startsAt", "endsAt") WITH &&
    ) WHERE (status IN ('PENDING', 'APPROVED'));
