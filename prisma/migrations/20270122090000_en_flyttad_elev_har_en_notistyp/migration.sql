-- En flyttad elev har en notistyp.
--
-- Elevens lektion för dagen (20270122091000) låter en lärare, en mentor eller
-- en administratör flytta en elev till en parallell lektion för ett datum. De
-- som berörs får en notis i inkorgen, som e-post och som push, genom de kanaler
-- som redan finns: lärarna på de två lektionerna (en elev kommer, en elev är
-- annorstädes) och, när skolan slagit på det, elevens vårdnadshavare
-- (SchoolDaySettings.guardianNoticeOnMove, av som förval). Den här
-- migreringen lägger bara till typen.
--
-- Egen migrering: ett värde som läggs till i en enum kan inte användas i den
-- transaktion som lägger till det (som 20261018090000, 20261026090000,
-- 20270112090000 och 20270117090000). Inget annat står här, ingen rad skrivs och
-- inget lås tas: ALTER TYPE ... ADD VALUE tar inget lås på någon tabell, så den
-- API-version som körs medan migreringen går märker ingenting. Den känner inte
-- typen och skriver aldrig en notis av den.
--
-- Ingen ny gallringstyp: en notis gallras med skolans val för NOTIFICATIONS.

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'LESSON_PUPIL_MOVED';
