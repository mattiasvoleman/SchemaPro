-- The strength of a soft room rule joins the scale it competes on.
--
-- Every objective the solver weighs is summed into one linear expression, so
-- the numbers are directly comparable per violation: spread 3, preferred_busy
-- 5, disruption 8, preferred_free 10. This column shipped with a default of
-- 50 — ten times the engine's own weight_room_preference and six times a
-- disruption — so the mildest wish a school could express outweighed every
-- other goal it had set.
--
-- The default drops to 5, matching the engine's fallback: a rule saved without
-- an explicit strength now behaves the same whether the weight travels with it
-- or not.

ALTER TABLE "RoomPreferences" ALTER COLUMN "weight" SET DEFAULT 5;

-- Existing rows are deliberately left alone.
--
-- Rewriting them would change the timetables schools already get, silently and
-- on our initiative, to make a screen look tidier. The numbers were never
-- wrong for the engine — only the words around them were, and those are what
-- this change fixes. A rule stored at 200 keeps behaving exactly as it did;
-- the form stretches to show it and now calls it what it is.
