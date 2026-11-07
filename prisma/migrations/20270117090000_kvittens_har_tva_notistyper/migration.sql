-- Kvittens har två notistyper.
--
-- Kvittens (20270117091000) låter personal be en vårdnadshavare bekräfta ett
-- meddelande om barnet (ACK_REQUESTED) och påminner en vårdnadshavare som inte
-- bekräftat när tiden skolan valt gått (ACK_REMINDER). Båda är notiser i
-- inkorgen, som e-post och som push, genom de kanaler som redan finns. Den här
-- migreringen lägger bara till typerna.
--
-- Egen migrering: ett värde som läggs till i en enum kan inte användas i den
-- transaktion som lägger till det (som 20261018090000, 20261026090000 och
-- 20270112090000), och 20270117091000 skriver notiser av typerna. Inget annat
-- står här, ingen rad skrivs, och inget lås tas: ALTER TYPE ... ADD VALUE tar
-- inget lås på någon tabell, så den API-version som körs medan migreringen
-- går märker ingenting. Den känner inte typerna och skriver aldrig en notis av
-- dem.
--
-- Ingen ny gallringstyp: en förfrågan och dess kvittenser gallras med skolans
-- val för NOTIFICATIONS (se 20270117091000).

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ACK_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ACK_REMINDER';
