-- Rapporteringsgraden har två notistyper.
--
-- Rapporteringsgrad (20270112090100) säger till en lärare när en lektion
-- stått öppen längre än skolans gräns (LESSON_REPORT_REMINDER) och till rektor
-- en gång i veckan hur stor del av förra veckans lektioner som fått sitt
-- register sparat (REPORTING_RATE_DIGEST). Båda är notiser i inkorgen, som
-- e-post och som push, genom de kanaler som redan finns. Den här migreringen
-- lägger bara till typerna.
--
-- Egen migrering: ett värde som läggs till i en enum kan inte användas i den
-- transaktion som lägger till det (som 20261018090000, 20261026090000 och
-- 20261231090000), och 20270112090100 skriver notiser av typerna. Inget annat
-- står här, ingen rad skrivs, och inget lås tas: ALTER TYPE ... ADD VALUE tar
-- inget lås på någon tabell, så den API-version som körs medan migreringen
-- går märker ingenting. Den känner inte typerna och skriver aldrig en notis av
-- dem.

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'LESSON_REPORT_REMINDER';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'REPORTING_RATE_DIGEST';
