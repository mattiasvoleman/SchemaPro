-- Läsloggen skriver också en elevs veckoschema och undervisningstid.
--
-- The read log (20261026091000) names what was read by kind. Two reads the
-- gateway now records carry data none of the ten kinds describes:
--
--   SCHEDULE        one pupil's week as the family sees it (GET
--                   /api/v1/family/schedule): which lessons, when and where,
--                   the ones the pupil is named on alone included. A
--                   guardian reads it only through the gateway; ROSTER
--                   ("who is in a group") is the other way round and would
--                   read as a class list to the person asking;
--   TEACHING_TIME   undervisningstid per pupil: the timplan coverage's
--                   pupil level, the stage overview's drill-down and the
--                   pupil's own statement (timplan-coverage, timplan-stages,
--                   timplan-stages/card), which name the subject lines a
--                   pupil reads (SvA, språkval, modersmål) and how far each
--                   is from the guaranteed time.
--
-- Its own migration, as 20261026090000: a value added to an enum cannot be
-- used in the transaction that adds it. app.personal_data_read takes the
-- kind as its argument and names none, so nothing else changes; the
-- ACCESS_LOG retention purges every kind alike. No row is written.

ALTER TYPE "PersonalDataAccessKind" ADD VALUE IF NOT EXISTS 'SCHEDULE';
ALTER TYPE "PersonalDataAccessKind" ADD VALUE IF NOT EXISTS 'TEACHING_TIME';
