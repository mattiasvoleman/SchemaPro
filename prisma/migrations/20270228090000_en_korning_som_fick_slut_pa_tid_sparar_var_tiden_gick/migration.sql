-- Omgång 13, M2 Förklaringen när tiden tar slut: en Generera-körning som fick slut på tid sparar var tiden gick.
--
-- ## Vad
--
-- En kolumn, OptimizationJobs."report" (jsonb, nullbar, utan standardvärde), och en CHECK: ett JSON-objekt på högst 8 KiB. Motorn
-- svarar nu ett TIMEOUT med en rapport (stegen i sekunder, vad sökningen fick och hur långt den kom, om veckolastens räkning klipptes);
-- gatewayen skriver den som den vitlistat den, och sidan läser den. Ingen annan kolumn, ingen funktion, ingen trigger, inget index.
--
-- ## Varför en kolumn
--
-- Förklaringen är det skolan frågar efter dagen efter, och Generera-sidans historik läser körningarna ur den här tabellen. Utan
-- en kolumn finns rapporten bara medan sidan pollar körningen. Kolumnen är nullbar och har inget standardvärde: varje körning före
-- den, varje körning som inte slutade i TIMEOUT och varje TIMEOUT från en motor som är äldre än fältet har NULL, och sidan visar då
-- det den alltid visat. Inget skrivs om.
--
-- ## Radsäkerhet
--
-- Inga armar ändras. Kolumnen är tabellens, och de fyra administratörsarmarna från 20261123090100 (TO app_authenticated, API:ts roll
-- ensam) styr den som resten: PostgREST:s roll och en administratör vid en annan skola läser den inte. Ingen tabellrättighet ändras
-- (de är tabellvisa, inte kolumnvisa).
--
-- ## Vid sidan av det levande API:t
--
-- API:t före den här namnger sina kolumner och läser ingen "report", så det påverkas inte. En körning som API:t efter den skriver
-- medan migreringen ännu inte körts är inte möjlig: migreringen körs före merge (DEPLOYMENT §2).
--
-- ADD COLUMN och ADD CONSTRAINT tar tabellens ACCESS EXCLUSIVE, och en körning som skrivs håller den: en migrering som väntar på den
-- ställer varje Generera-poll bakom sig. Därför tas låset NOWAIT, om igen 50 ms senare medan en begäran håller det, och efter 30 s
-- stannar den utan att ha gjort något och kan köras om (som 20270222090000). lock_timeout begränsar varje väntan ingen förutsett.
-- Filen har en $$-kropp, så Prisma kör den som en transaktion: ett avslag nedan lämnar inget ändrat.

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
    ADD COLUMN "report" JSONB;

  -- Ett objekt och inte mer än 8 KiB som text: en rapport har cirka tio steg och tre sökningar, under 1 KiB. Taket finns för att en
  -- kolumn som sidan läser aldrig ska bli ett sätt att lägga text i en rad.
  ALTER TABLE "OptimizationJobs"
    ADD CONSTRAINT "OptimizationJobs_report_is_a_small_object"
        CHECK ("report" IS NULL OR (jsonb_typeof("report") = 'object' AND octet_length("report"::text) <= 8192));
END
$$;

COMMENT ON COLUMN "OptimizationJobs"."report" IS
  'M2 (20270228090000): the engine''s TimeoutReport of a run that ended in TIMEOUT, as the gateway whitelisted it: the seconds of each step, what the search was given and had done, and whether the week load was cut short. Null otherwise.';
