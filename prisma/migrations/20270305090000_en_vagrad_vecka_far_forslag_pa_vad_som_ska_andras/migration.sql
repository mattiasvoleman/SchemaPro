-- Omgång 13, G6 Åtgärdsförslag vid vägran (del 2, gatewayen): en vägrad eller utlupen Generera-körning sparar förslagen på vad som ska ändras.
--
-- ## Vad
--
-- En kolumn, OptimizationJobs."suggestions" (jsonb, nullbar, utan standardvärde), och en CHECK: ett JSON-objekt på högst 8 KiB. Motorn
-- (POST /api/v1/suggest-changes) räknar fram upp till en lista med ändringar som skulle låta veckan läggas, och hur väl motorn har visat
-- var och en; gatewayen skriver listan som den vitlistat den på körningen den gäller, och sidan läser den. Ingen annan kolumn, ingen
-- funktion, ingen trigger, inget index.
--
-- ## Varför en kolumn
--
-- Analysen tar upp till ett par minuter motortid och startas av en administratör med en knapp. Utan en kolumn finns svaret bara medan
-- sidan pollar, och en omladdning kastar bort det som kostade motorn en och en halv minut. Kolumnen är nullbar och har inget
-- standardvärde: varje körning före den, varje körning där ingen bett om förslag, har NULL, och sidan visar då det den alltid visat.
-- Inget skrivs om.
--
-- ## Vad kolumnen aldrig håller
--
-- Inget namn på en person, inget tal ur en tjänst. En lärares dagstak bär lärarens Users-id i ett fält ingen vy skickar vidare (sidan
-- namnger läraren när den läser), och en ändring av en deltidstjänsts dagar sparas i sin dolda form för varje läsare: regeln, priset och
-- bevisnivån, och varken tjänsten, läraren eller siffran (work-days.ts). Taket på 8 KiB finns för att en kolumn sidan läser aldrig ska
-- bli ett sätt att lägga text i en rad.
--
-- ## Radsäkerhet
--
-- Inga armar ändras. Kolumnen är tabellens, och de fyra administratörsarmarna från 20261123090100 (TO app_authenticated, API:ts roll
-- ensam) styr den som resten: PostgREST:s roll och en administratör vid en annan skola läser den inte. Ingen tabellrättighet ändras
-- (de är tabellvisa, inte kolumnvisa).
--
-- ## Vid sidan av det levande API:t
--
-- API:t före den här namnger sina kolumner och läser ingen "suggestions", så det påverkas inte. En körning som API:t efter den skriver
-- medan migreringen ännu inte körts är inte möjlig: migreringen körs före merge (DEPLOYMENT §2).
--
-- ADD COLUMN och ADD CONSTRAINT tar tabellens ACCESS EXCLUSIVE, och en körning som skrivs håller den: en migrering som väntar på den
-- ställer varje Generera-poll bakom sig. Därför tas låset NOWAIT, om igen 50 ms senare medan en begäran håller det, och efter 30 s
-- stannar den utan att ha gjort något och kan köras om (som 20270222090000 och 20270228090000). lock_timeout begränsar varje väntan
-- ingen förutsett. Filen har en $$-kropp, så Prisma kör den som en transaktion: ett avslag nedan lämnar inget ändrat. Sitter en körning
-- fast i Prismas migreringstabell efter ett avbrott (P3009) rättas det med `prisma migrate resolve --rolled-back <namn>` innan den körs om.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "OptimizationJobs" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'OptimizationJobs was not free in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;

  ALTER TABLE "OptimizationJobs"
    ADD COLUMN "suggestions" JSONB;

  -- Ett objekt och inte mer än 8 KiB som text: en lista har högst ett dussin ändringar med namn på poster och salar, långt under 8 KiB.
  ALTER TABLE "OptimizationJobs"
    ADD CONSTRAINT "OptimizationJobs_suggestions_is_a_small_object"
        CHECK ("suggestions" IS NULL OR (jsonb_typeof("suggestions") = 'object' AND octet_length("suggestions"::text) <= 8192));
END
$$;

COMMENT ON COLUMN "OptimizationJobs"."suggestions" IS
  'G6 (20270305090000): the changes the engine found that would let this refused or timed-out run''s week be laid, and how well it showed each (SOLVED, SOLVED_TOGETHER, MAY_HELP), as the gateway whitelisted them; or the state of the analysis that makes them (RUNNING, FAILED). No person''s name and no figure of a post. Null when nobody asked.';
