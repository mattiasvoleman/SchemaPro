-- En sammanställning av frånvaro är en notistyp.
--
-- Frånvarobevakning (20261231090100) skickar skolans mentorer, rektor,
-- kansli och vårdnadshavare en vecko- eller månadssammanställning över de
-- elever som passerat en av skolans gränser. Sammanställningen är ett notis
-- i inkorgen, som e-post och som push, genom de kanaler som redan finns.
-- Den här migreringen lägger bara till dess typ.
--
-- Egen migrering: ett värde som läggs till i en enum kan inte användas i den
-- transaktion som lägger till det (som 20261018090000 och 20261026090000), och
-- 20261231090100 skriver notiser av typen. Inget annat står här, ingen rad
-- skrivs, och inget lås tas: ALTER TYPE ... ADD VALUE tar inget lås på någon
-- tabell, så den API-version som körs medan migreringen går märker ingenting.
-- Den känner inte typen och skriver aldrig en notis av den.

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ABSENCE_WATCH_DIGEST';
