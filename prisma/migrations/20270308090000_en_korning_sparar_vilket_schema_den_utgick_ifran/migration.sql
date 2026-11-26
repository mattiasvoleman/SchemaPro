-- Omgång 15, M9 Ett schema som start: en Generera-körning som utgick från ett schema sparar vilket och vad som blev av dess lektioner.
--
-- ## Vad
--
-- En kolumn, OptimizationJobs."startedFrom" (jsonb, nullbar, utan standardvärde), och en CHECK: ett JSON-objekt på högst 2 KiB.
-- Generera kan nu be motorn utgå från ett schema som redan finns (årets grundschema, förra årets, en sparad version) i stället
-- för att lägga veckan från noll. Körningen skriver vilket schema, hur många av dess lektioner motorn fick som start och hur många
-- som hölls, flyttades och lades nya: {source, versionName, engine, offered, used, held, moved, laid, dropped}. Gatewayen skriver
-- den som den vitlistat den (src/optimization/start-schedule.ts, startedFromOf), och sidan läser den. Ingen annan kolumn, ingen
-- funktion, ingen trigger, inget index.
--
-- ## Varför en kolumn
--
-- Svaret "hur många lektioner hölls och hur många flyttades" är det skolan frågar efter dagen efter, och Generera-sidans historik
-- läser körningarna ur den här tabellen. Utan en kolumn finns det bara medan sidan pollar körningen. Kolumnen är nullbar och har
-- inget standardvärde: varje körning före den och varje körning som utgick från inget schema har NULL, och sidan visar då det den
-- alltid visat. Inget skrivs om.
--
-- ## Radsäkerhet
--
-- Inga armar ändras. Kolumnen är tabellens, och de fyra administratörsarmarna från 20261123090100 (TO app_authenticated, API:ts roll
-- ensam) styr den som resten: PostgREST:s roll och en administratör vid en annan skola läser den inte. Ingen tabellrättighet ändras
-- (de är tabellvisa, inte kolumnvisa). Inga lektioner och inga personer står i den: bara antal, ett av tre källnamn och det namn
-- skolan gav den sparade versionen.
--
-- ## Vid sidan av det levande API:t
--
-- API:t före den här namnger sina kolumner och läser ingen "startedFrom", så det påverkas inte. En körning som API:t efter den
-- skriver medan migreringen ännu inte körts är inte möjlig: migreringen körs före merge (DEPLOYMENT §2).
--
-- ADD COLUMN och ADD CONSTRAINT tar tabellens ACCESS EXCLUSIVE, och en körning som skrivs håller den: en migrering som väntar på den
-- ställer varje Generera-poll bakom sig. Därför tas låset NOWAIT, om igen 50 ms senare medan en begäran håller det, och efter 30 s
-- stannar den utan att ha gjort något och kan köras om (som 20270228090000). lock_timeout begränsar varje väntan ingen förutsett.
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
    ADD COLUMN "startedFrom" JSONB;

  -- Ett objekt och inte mer än 2 KiB som text: en rad har tio fält och högst sju skäl, under 400 byte. Taket finns för att en
  -- kolumn som sidan läser aldrig ska bli ett sätt att lägga text i en rad.
  ALTER TABLE "OptimizationJobs"
    ADD CONSTRAINT "OptimizationJobs_startedFrom_is_a_small_object"
        CHECK ("startedFrom" IS NULL OR (jsonb_typeof("startedFrom") = 'object' AND octet_length("startedFrom"::text) <= 2048));
END
$$;

COMMENT ON COLUMN "OptimizationJobs"."startedFrom" IS
  'M9 (20270308090000): the schedule a run was asked to start from (CURRENT, PREVIOUS_YEAR or VERSION) and what became of its lessons: how many the engine was given, and how many of the answer were held, moved and laid. Null for a run that started from nothing.';
