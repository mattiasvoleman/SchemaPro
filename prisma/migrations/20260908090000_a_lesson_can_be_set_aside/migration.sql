-- A lesson can be set aside.
--
-- Swapping two lessons was impossible on the grid. A at slot X and B at slot Y:
-- dragging A onto Y is refused because B is there, and dragging B onto X is
-- refused because A is. Every timetabling product solves this with a tray —
-- lift one out, move the other, drop the first into the hole.
--
-- A parked lesson OCCUPIES NOTHING. It is excluded from every clash check on
-- both sides, from publish, from the solver's fixed placements and from the
-- SS12000 activity feed, and it keeps its old day and time only as a memory of
-- where it was so "put it back" has somewhere to go. That memory is not a
-- placement, and nothing may read it as one.
--
-- A flag rather than a nullable dayOfWeek/startTime: those two columns are NOT
-- NULL in every consumer and every index, and a lesson with no time would have
-- to be handled by name in each of them. A boolean defaults false everywhere
-- and is a single predicate to add wherever a lesson is read as a placement.

ALTER TABLE "MasterLessons"
    ADD COLUMN "isParked" BOOLEAN NOT NULL DEFAULT false;
