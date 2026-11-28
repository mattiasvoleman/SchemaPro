-- En ledighetsansökan kan dras tillbaka: en status (K6, omgång 15).
--
-- En familj kan dra tillbaka sin ledighetsansökan före beslutet (20270315090100). Ansökan får då statusen WITHDRAWN: ett slut som varken är
-- ett beslut av skolan (ingen beslutsfattare skrivs, som för GUARDIAN_DECLINED) eller ett avslag. Egen migrering, som 20270205090000: ett
-- värde som läggs till i en enum kan inte användas i den transaktion som lägger till det, och 20270315090100 har en CHECK och en trigger som
-- nämner statusen. Inget annat står här, ingen rad skrivs och inget lås tas: ALTER TYPE ... ADD VALUE tar inget lås på någon tabell, så den
-- API-version som körs medan migreringen går märker ingenting. Den känner inte statusen och skriver aldrig den; en skola vars familjer inte
-- drar tillbaka något får aldrig en rad med den.

ALTER TYPE "LeaveRequestStatus" ADD VALUE IF NOT EXISTS 'WITHDRAWN';
