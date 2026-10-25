-- Läsloggens villkor för huvudmannens läsare och nyckel valideras.
--
-- 20261212090100 added them NOT VALID, so that it took ACCESS EXCLUSIVE on
-- the read log for a catalogue change only. VALIDATE takes SHARE UPDATE
-- EXCLUSIVE on "PersonalDataAccess", which blocks no read and no write (and
-- ROW SHARE on the referenced tables), while it reads the log once. Every row
-- already holds: the two columns are NULL on every row the migration found,
-- and app.personal_data_read writes them only in the shape the CHECK names.
--
-- lock_timeout, as 20261114090600: a validation that waits behind an
-- anti-wraparound vacuum stops after 5 s with nothing changed, rather than
-- waiting without end (run the migration again).

DO $$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
END
$$;

ALTER TABLE "PersonalDataAccess" VALIDATE CONSTRAINT "PersonalDataAccess_huvudmanMemberId_fkey";
ALTER TABLE "PersonalDataAccess" VALIDATE CONSTRAINT "PersonalDataAccess_huvudmanApiKeyId_fkey";
ALTER TABLE "PersonalDataAccess" VALIDATE CONSTRAINT "PersonalDataAccess_a_huvudman_reader_or_key";
