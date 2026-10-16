-- Läsloggen skriver kalendern som en väg.
--
-- Kalenderprenumerationen (20261112091000) delivers a person's published
-- week to a calendar app behind a secret address. A guardian's feed of their
-- child is a read of the child's schedule (SCHEDULE), as the family's week is
-- in the web and the app; the log says which way it went, and none of WEB,
-- APP or OTHER is this one: no person's client asked, their calendar did.
--
-- Its own migration, as 20261026110000: a value added to an enum cannot be
-- used in the transaction that adds it, and app.calendar_feed writes it.
-- app.personal_data_read keeps mapping what a request says of itself onto
-- WEB, APP or OTHER; only the feed's door writes CALENDAR. No row is written.

ALTER TYPE "PersonalDataAccessChannel" ADD VALUE IF NOT EXISTS 'CALENDAR';
