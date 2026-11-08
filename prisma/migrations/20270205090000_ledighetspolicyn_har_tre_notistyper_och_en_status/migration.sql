-- Ledighetspolicyn har tre notistyper och en status.
--
-- Ledighetspolicyn (20270205091000) låter skolan be om varje vårdnadshavares
-- samtycke till en ledighetsansökan. Den andra vårdnadshavaren får en notis
-- (LEAVE_CONSENT_REQUESTED), en enda påminnelse om hen inte svarat
-- (LEAVE_CONSENT_REMINDER), och den som ansökte får veta när en vårdnadshavare
-- sagt nej (LEAVE_CONSENT_REFUSED). Ett nej avslutar ansökan: den får statusen
-- GUARDIAN_DECLINED, som inte är ett beslut av skolan (ingen beslutsfattare
-- skrivs) och som inget kan lämna.
--
-- Egen migrering: ett värde som läggs till i en enum kan inte användas i den
-- transaktion som lägger till det (som 20270117090000, 20270112090000 och
-- 20261018090000), och 20270205091000 skriver notiser av typerna och har en
-- CHECK som nämner statusen. Inget annat står här, ingen rad skrivs och inget
-- lås tas: ALTER TYPE ... ADD VALUE tar inget lås på någon tabell, så den
-- API-version som körs medan migreringen går märker ingenting. Den känner
-- varken typerna eller statusen och skriver aldrig något av dem; en skola som
-- inte väljer något i ledighetspolicyn får aldrig en rad med den nya statusen.
--
-- Ingen ny gallringstyp: en ansökan gallras som förut (LEAVE_REQUESTS), med
-- samtycken och kontakt under sig, och notiserna med skolans val för
-- NOTIFICATIONS.

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'LEAVE_CONSENT_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'LEAVE_CONSENT_REMINDER';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'LEAVE_CONSENT_REFUSED';
ALTER TYPE "LeaveRequestStatus" ADD VALUE IF NOT EXISTS 'GUARDIAN_DECLINED';
