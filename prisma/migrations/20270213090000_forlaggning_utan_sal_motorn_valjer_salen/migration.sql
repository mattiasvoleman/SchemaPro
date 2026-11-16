-- Förläggning utan sal: a förläggning can leave its room to the engine.
--
-- Förlagda poster (20270207090000) made the room the point of a förläggning:
-- "a förläggning without one is a lock the engine would leave roomless". Since
-- #317 the engine can hold a lesson of a post at a given time and choose the
-- room as for any lesson it places (fästa lektioner, DEPLOYMENT.md 21), and on
-- 2026-11-13 the user decided (grafisk förläggning, beslut 3) that a school
-- may leave the room empty: the engine then chooses a room at every Generera.
--
-- ## The change, on one line
--
--   "TeachingRequirementPlacements"."roomId" becomes nullable.
--
-- Nothing else moves. The key ("roomId", "schoolId") -> "Rooms" ("id",
-- "schoolId") stays as it is, ON DELETE NO ACTION ON UPDATE NO ACTION: a row
-- with no room has nothing to check (the key is MATCH SIMPLE and "roomId" is
-- one of its two columns), and a room a row names is still the post's place,
-- which a removal of the room is refused for by name before the key is asked
-- (rooms.service.ts). The index on ("roomId", "schoolId") serves the same two
-- readers as before. The CHECK constraints (school day, grid, length), the two
-- fit functions and their five triggers (app.teaching_requirement_
-- placements_fit, app.teaching_requirement_placement_teachers_fit: none of
-- them reads the room), the policies and the grants are not touched, which
-- the pull request shows by md5 of the catalogue before and after.
--
-- ## What a row with no room means, and where it is held
--
-- Generera sends it to the engine as a pinned lesson on its post
-- (pinnedLessons, src/optimization/placed-lessons.ts) and does not take it off
-- the post's demand; the engine places it at that weekday and time, in a room
-- it chooses, and the run writes the lesson that comes back with the room the
-- engine chose, locked and marked fromPlacement. A row WITH a room is sent as
-- a locked lesson, as before.
--
-- THE RULE THAT A PAIR NEEDS ITS ROOMS IS THE GATEWAY'S, NOT THIS TABLE'S. An
-- odd and an even row of one length on an every-week post are one lesson in
-- two places, and the engine cannot hold half a lesson of an every-week post,
-- so both halves must name a room (src/requirement-placements/
-- placement-fit.ts, PAIR_ROOM, refused at the save with 409
-- REQUIREMENT_PLACEMENTS_DO_NOT_FIT and judged again at every Generera). The
-- fit trigger is the database's copy of the post's own rules and is left as
-- it is, so a writer that does not go through the gateway can store a pair
-- with an empty half; Generera then refuses the week with that row named
-- rather than send it.
--
-- ## Beside the live API: the lock, and the rollback
--
-- ALTER COLUMN ... DROP NOT NULL takes the table in ACCESS EXCLUSIVE for the
-- time it takes to write the catalogue, but waits for every transaction that
-- has read the table, and Generera reads it inside its long transaction. The
-- lock is therefore taken first, NOWAIT, in a loop with a 30 s deadline: a
-- refusal tries again 50 ms later, so the migration never waits while it holds
-- a lock and no request queues behind it. After 30 s it stops with nothing
-- changed (prisma migrate resolve --rolled-back, then deploy again).
--
-- THE API BEFORE THIS ONE reads the room's name on every row it returns
-- (room: { select: { name: true } }) and stops on a row with none. The column
-- itself does not disturb it: it never writes a NULL, and every row there is
-- has a room. Once a row with no room exists the previous API cannot be
-- brought back until that row has been given a room (DEPLOYMENT.md 22.2).

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "TeachingRequirementPlacements" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'TeachingRequirementPlacements was not free in 30 s: nothing is changed. Run prisma migrate resolve --rolled-back 20270213090000_forlaggning_utan_sal_motorn_valjer_salen, then deploy again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

ALTER TABLE "TeachingRequirementPlacements" ALTER COLUMN "roomId" DROP NOT NULL;

COMMENT ON COLUMN "TeachingRequirementPlacements"."roomId" IS
  'The room the school chose for the lesson, or NULL to leave it to the engine: Generera then sends the förläggning as a pinned lesson and the run writes the room the engine chose. A pair (odd and even rows of one length on an every-week post) must name a room on both rows, which the gateway holds.';

COMMENT ON TABLE "TeachingRequirementPlacements" IS
  'Förlagda poster: one of a timplanspost''s lessons that the school placed (day, start, length, room or none, weeks) before Generera. With a room Generera sends it as a locked lesson; without one (roomId NULL) as a pinned lesson the engine chooses the room for. Either way it writes the lesson into the grundschema marked MasterLessons.fromPlacement. The class, subject and co-teacher are the post''s; the teacher is the post''s, or on a post with delade lektioner the row''s own (teacherId).';
