-- Rooms limited to a stage.
--
-- A school keeps lågstadiets rooms for lågstadiet: the room is the wrong size,
-- in the wrong building, or simply spoken for. Expressed as an inclusive year
-- range rather than a named stage, because the stages a school actually runs
-- vary — F–3/4–6/7–9 is common but F–6 and 7–9 is just as real, and a range
-- covers both without the app deciding which one a school has.
--
-- Both null means no limit, which is what every existing room gets: no school
-- has expressed a limit yet, and inventing one would silently make rooms
-- unschedulable.

ALTER TABLE "Rooms"
    ADD COLUMN "minGradeLevel" INTEGER,
    ADD COLUMN "maxGradeLevel" INTEGER;

-- A range that excludes everything is a data-entry slip, not a rule anyone
-- means: it makes the room unusable while looking configured.
ALTER TABLE "Rooms"
    ADD CONSTRAINT "Rooms_gradeRange_ordered"
    CHECK (
      "minGradeLevel" IS NULL
      OR "maxGradeLevel" IS NULL
      OR "minGradeLevel" <= "maxGradeLevel"
    );
