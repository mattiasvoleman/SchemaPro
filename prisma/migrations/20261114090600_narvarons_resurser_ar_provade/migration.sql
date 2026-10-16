-- Närvarons resurser är prövade: the two CHECKs that 20261114090400 and
-- 20261114090500 added NOT VALID are validated against every row.
--
-- VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE, which blocks neither a
-- read nor a write (only DDL, VACUUM and another validation), so the scans
-- of the two tables, however long, stop no request. The new CHECKs are
-- supersets of the old, so every row passes.

DO $$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
END
$$;

ALTER TABLE "Ss12000EntityVersions" VALIDATE CONSTRAINT "Ss12000EntityVersions_resource_is_emitted";
ALTER TABLE "Ss12000Tombstones" VALIDATE CONSTRAINT "Ss12000Tombstones_resource_is_emitted";
