-- Personer utan e-postadress (P3, Första veckan utan operatören, beslut 7)
--
-- En elev eller en vårdnadshavare kan läggas upp utan e-postadress. Personen syns i listor, i närvaron och i schemat, men har ingen
-- inloggning förrän en adress finns och personen är inbjuden. Yngre elever har sällan en skoladress, och en skola ska inte behöva hitta
-- på en för att få in dem.
--
-- VAD DEN GÖR
--   * "Users"."email" blir valfri. NULL är ingen adress. Nyckeln ("schoolId", "email") är densamma, och Postgres läser NULL i en unik
--     nyckel som olika: många personer utan adress i en skola, ingen krock.
--   * Users_a_person_with_no_address_has_no_login: en rad utan adress har inget "invitedAt". "invitedAt" säger att personen har en
--     inloggning (docs/DEPLOYMENT.md §7), och en inloggning föds ur en adress. Allt som ger en rad en inloggning (inbjudan, en
--     omlänkning, operatörsskriptet) sätter "invitedAt", så ingen väg ger en person utan adress en inloggning, och ingen väg tar
--     adressen från en person som har en. Bakstopp till tjänstens egen vägran: kontrollen är databasens, så en skriven rad, ett skript
--     eller PostgREST hamnar i den.
--   * Users_only_a_pupil_or_guardian_has_no_address: lärare och administratörer har alltid en adress. Beslutet gäller elever och
--     vårdnadshavare, och en lärare vars inloggning inte kan skapas är ingen lärare skolan kan bjuda in. Vilken roll en person utan
--     adress får byta till avgörs av tjänsten, som säger det med ord (ADDRESS_REQUIRED); kontrollen är det som står kvar om den glöms.
--
-- LÅS. "Users" läses av inloggningskroken vid varje inloggning och förnyelse, så migreringen tar tabellens lås med NOWAIT och försöker
-- om i högst 30 s (policy-migration-lock-order): den väntar aldrig i kön bakom en lång läsning och blockerar därmed aldrig alla som loggar
-- in. Allt i ett DO-block, alltså en transaktion: lås, ändring och kontroller hör ihop, och en fil med $$ körs som en enda. Tabellen har
-- hundratals rader i produktion, så kontrollernas genomsökning (ADD CONSTRAINT utan NOT VALID) tar millisekunder.
--
-- ÄLDRE KLIENTER. Raderna som finns har alla en adress och svarar som förut. En ny webb eller app visar en person utan adress; en äldre
-- webb som läser en sådan rad får `email: null` där den väntade en sträng, vilket är ett skäl att driftsätta API och webb tillsammans,
-- inte ett skäl att hindra funktionen.
--
-- RULLA TILLBAKA. Det finns ingen automatisk väg tillbaka förrän inga personer utan adress finns: `ALTER COLUMN "email" SET NOT NULL` är
-- det som kräver det, och det misslyckas på en rad som saknar adress. Läs dem först: SELECT count(*) FROM "Users" WHERE "email" IS NULL.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Users" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Users was not free in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;

  ALTER TABLE "Users" ALTER COLUMN "email" DROP NOT NULL;

  ALTER TABLE "Users"
    ADD CONSTRAINT "Users_a_person_with_no_address_has_no_login"
    CHECK ("email" IS NOT NULL OR "invitedAt" IS NULL);

  ALTER TABLE "Users"
    ADD CONSTRAINT "Users_only_a_pupil_or_guardian_has_no_address"
    CHECK ("email" IS NOT NULL OR "role" IN ('STUDENT', 'GUARDIAN'));
END
$$;

COMMENT ON COLUMN "Users"."email" IS
  'The person''s address, or NULL for a pupil or a guardian the school added without one (20270310090000): in lists, attendance and the timetable, with no login until an address is added and the person is invited. Users_a_person_with_no_address_has_no_login: no row has an invitedAt without an address. Unique per school where set.';

COMMENT ON CONSTRAINT "Users_a_person_with_no_address_has_no_login" ON "Users" IS
  'Personer utan e-postadress (20270310090000): "invitedAt" says the person has a login, and a login is born of an address. No road gives a person with no address a login, and none takes the address from a person who has one.';

COMMENT ON CONSTRAINT "Users_only_a_pupil_or_guardian_has_no_address" ON "Users" IS
  'Personer utan e-postadress (20270310090000): only a pupil or a guardian may have no address. A teacher or an administrator is somebody the school invites.';
