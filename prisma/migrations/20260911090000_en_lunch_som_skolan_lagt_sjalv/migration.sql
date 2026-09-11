-- A lunch the school places by hand, and a run that leaves it where it was put.
--
-- 20260901120000 created this table with the sentence this migration has to
-- answer: "NO isLocked AND NO isGenerated on the weekly table, deliberately. A
-- preserved lunch row would be forwarded back to the engine as a fixedLesson
-- while the solver still builds its own lunch_start for that group — two
-- mandatory reservations in one window, and an INFEASIBLE whose cause is
-- invisible."
--
-- That objection was to the FORWARDING, not to the column, and it still
-- stands against the forwarding. A hand-placed row is not sent as a fixed
-- lesson. It is sent as lunchPlacements, and the engine pins the lunch
-- variable it was going to build anyway: one reservation, held where the
-- school put it, under an assumption literal of its own so a week it breaks is
-- refused by name. The column is what lets a run tell the two kinds of row
-- apart; the pin is what keeps them from colliding.
--
-- Why a school needs it at all: a generation refused because locked lessons
-- left a class no 15-minute lunch gap inside 10:30-13:00. The meal had to go
-- outside the window, the solver will not put it there, and until now there
-- was nowhere to say "here".
--
-- DEFAULT false, then every existing row set true. Every row in the table
-- today was written by replaceSittings — nothing else writes it — so they are
-- all the solver's. Without the backfill a DEFAULT false would read the whole
-- school's lunch as handmade on deploy and freeze it there for ever.
--
-- No policy change: the table's policies are row predicates on schoolId and a
-- role or a group id, none of them names a column, and PostgREST reads through
-- the same ones.

ALTER TABLE "LunchSittings" ADD COLUMN "isGenerated" BOOLEAN NOT NULL DEFAULT false;

UPDATE "LunchSittings" SET "isGenerated" = true;
