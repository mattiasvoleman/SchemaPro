-- Läsloggen är ett slag av uppgifter som gallras.
--
-- The read log (PersonalDataAccess, 20261026091000) keeps who read whose
-- personal data. It is personal data itself, about the reader and the person
-- read about, so the school decides how long it is kept, like every other
-- kind on /admin/dataskydd: ACCESS_LOG starts at "ej beslutat" in every
-- school, and nothing of it is purged until the school records a period.
--
-- Its own migration: a value added to an enum cannot be used in the
-- transaction that adds it (as 20261018090000), and 20261026091000 compiles
-- app.gallring_due, a LANGUAGE sql function that names the value. Nothing
-- else here; no row is written.

ALTER TYPE "RetentionDataType" ADD VALUE IF NOT EXISTS 'ACCESS_LOG';
