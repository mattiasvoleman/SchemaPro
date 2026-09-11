-- En sal vet var den ligger: byggnad och våning, för salsoptimeringen.
--
-- Salsoptimeringen byter bara salar i ett satt grundschema, och den behöver
-- veta vad en förflyttning kostar: ett salsbyte, ett våningsbyte, ett
-- byggnadsbyte. Båda kolumnerna är frivilliga. En skola som inte fyller i
-- något får fortfarande sina salsbyten räknade.
--
-- Ingen ändring av RLS: policyerna och rättigheterna på "Rooms" gäller hela
-- tabellen, och de nya kolumnerna ärver dem.

ALTER TABLE "Rooms"
    ADD COLUMN "building" TEXT,
    ADD COLUMN "floor" INTEGER;

-- Samma gränser som API:t, så att en skrivning förbi TypeScript — PostgREST,
-- en import, psql — inte kan lämna en våning 900 eller ett namn av blanksteg
-- som motorn sedan läser som en egen byggnad.
ALTER TABLE "Rooms"
    ADD CONSTRAINT "Rooms_floor_range"
    CHECK ("floor" IS NULL OR "floor" BETWEEN -5 AND 50);

ALTER TABLE "Rooms"
    ADD CONSTRAINT "Rooms_building_named"
    CHECK ("building" IS NULL OR char_length(btrim("building")) BETWEEN 1 AND 60);
