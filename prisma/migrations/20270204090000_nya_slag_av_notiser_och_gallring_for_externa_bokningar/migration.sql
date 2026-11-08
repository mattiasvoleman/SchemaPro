-- Nya slag av notiser och gallring för externa bokningar.
--
-- Lokal (K3) låter expeditionen registrera en förening som hyr idrottshallen
-- varje tisdag 18-20 en termin. Två saker berättas och en sorts uppgifter
-- sparas, och var och en är ett värde som läggs till i en enum:
--
--   * EXTERNAL_BOOKING_CLASH  till de administratörer som skriver Drift,
--                             efter en publicering: att en eller flera dagar
--                             av en extern bokning nu står i en sal som har
--                             en lektion. Bara ett antal; listan står på
--                             sidan, aldrig i notisen, eftersom den som hyr
--                             inte är en användare och notisen går vidare
--                             som e-post och push.
--   * EXTERNAL_BOOKINGS       en sorts uppgifter som skolan sätter en
--                             gallringstid för som alla andra på
--                             /admin/dataskydd: en extern bokning med den
--                             hyrandes kontaktuppgifter och sina dagar.
--                             Börjar som "ej beslutat" i varje skola och
--                             ingenting gallras förrän skolan beslutat en tid.
--
-- Egen migrering: ett värde som läggs till i en enum kan inte användas i den
-- transaktion som lägger till det (20261018090000, 20261026090000,
-- 20270113090000), och nästa fil kompilerar app.gallring_due, en LANGUAGE
-- sql-funktion som nämner sorten. Inget annat står här, ingen rad skrivs och
-- inget lås tas: ALTER TYPE ... ADD VALUE tar inget lås på någon tabell, så
-- det API som körs medan migreringen går märker ingenting. Det känner inte
-- värdena och skriver aldrig en notis av typen.

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'EXTERNAL_BOOKING_CLASH';
ALTER TYPE "RetentionDataType" ADD VALUE IF NOT EXISTS 'EXTERNAL_BOOKINGS';
