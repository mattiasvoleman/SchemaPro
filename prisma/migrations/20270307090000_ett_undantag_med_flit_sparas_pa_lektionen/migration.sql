-- E1b Undantag med flit: en administratör kan bryta ramtiden eller klassens lunch med flit på en enskild lektion, och lektionen bär det.
--
-- ## Vad
--
-- En kolumn på lektionen, "MasterLessons"."exemptFrom" (text[], NOT NULL, förval tom lista), med namnen på de regler som lektionen med flit
-- bryter: 'FRAME' (stadiets ramtid) och 'LUNCH' (klassens måltid). Samma kolumn, utan standardvärde att tänka på, på "PublishedLessons", så att
-- en publicering som tas i bruk eller ett utkast som kastas ger tillbaka undantaget (som "fromPlacement" 20270207090000). En CHECK: bara de
-- två namnen. En BEFORE UPDATE-trigger som avslutar undantaget när något av det det gavs för ändras.
--
-- ## Varför ett namn och inte ett märke
--
-- Domaren (src/calendar/lesson-judge.ts) frågar varje regel för sig och säger vilka en tid bryter. Ett undantag är ett svar på en av dem, så
-- lektionen sparar namnet på regeln. En tredje regel som kan brytas (en annan sorts undantag) kräver då en ändring av CHECK:en och ingen ny
-- kolumn. Lärare, sal, klass och elever, otillgänglighet, årskursregler och andra skolors tider kan inte undantas (beslut 5: ingen tvingad
-- krock) och står inte här.
--
-- ## Vad ingen rad får
--
-- Inga befintliga rader ändras: förvalet är en tom lista, och en lektion utan undantag är byte för byte den den var. Kolumnen skrivs bara av
-- en begäran som namnger regeln (PATCH och POST på lektionen med fältet `exempt`, och en fil som namnger den i kolumnen Undantag), och av en
-- återställning eller ett kastat utkast som lägger tillbaka en rad som redan hade den. Ingen automat (Generera, byten, Optimera salar) skriver den.
--
-- ## "Undantaget gäller den tid det gavs för"
--
-- Triggern "MasterLessons_exemption_ends" lägger tillbaka en tom lista när en rad med undantag byter dag, start, slut, datumfönster, lämnar
-- låsningen eller läggs på parkeringen, och undantaget inte samtidigt skrivs om i samma sats. Det är den enda vakten som fångar en skrivare
-- som inte vet om kolumnen: en lektion som ett byte flyttar bär inte ett undantag för en tid den lämnat. Raderna som sätter ett undantag på en ny
-- tid (en PATCH som svarar ja på frågan igen, en återställning, ett kastat utkast) säger det genom `app.keep_exemptions` = on i sin transaktion.
-- Triggern har ett WHEN-villkor på den gamla raden, så en lektion utan undantag, alltså nästan alla, kostar den ingenting.
--
-- ## Radsäkerhet
--
-- Inga armar ändras. Kolumnen är tabellens, och dess arm styr den som resten. Ingen tabellrättighet ändras (de är tabellvisa, inte kolumnvisa).
--
-- ## Vid sidan av det levande API:t
--
-- API:t före den här namnger sina kolumner och läser ingen "exemptFrom", så det påverkas inte: en lektion som det skriver har förvalet. En
-- begäran som API:t efter den skriver medan migreringen ännu inte körts är inte möjlig: migreringen körs före merge (DEPLOYMENT §2).
--
-- ADD COLUMN och ADD CONSTRAINT tar tabellens ACCESS EXCLUSIVE, och en lektionsskrivning som håller den ställer varje läsare bakom en
-- migrering som väntar. Därför tas låset på båda tabellerna NOWAIT, allt eller inget, om igen 50 ms senare medan en begäran håller det, och
-- efter 30 s stannar den utan att ha gjort något och kan köras om (som 20270222090000 och 20270305090000). lock_timeout begränsar varje
-- väntan ingen förutsett. Filen har en $$-kropp, så Prisma kör den som en transaktion: ett avslag nedan lämnar inget ändrat. Sitter en körning
-- fast i Prismas migreringstabell efter ett avbrott (P3009) rättas det med `prisma migrate resolve --rolled-back <namn>` innan den körs om.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "MasterLessons", "PublishedLessons" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'MasterLessons and PublishedLessons were not free in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;

  ALTER TABLE "MasterLessons" ADD COLUMN "exemptFrom" TEXT[] NOT NULL DEFAULT '{}';
  ALTER TABLE "MasterLessons"
    ADD CONSTRAINT "MasterLessons_exemptFrom_names_a_rule_that_can_be_broken"
        CHECK ("exemptFrom" <@ ARRAY['FRAME', 'LUNCH']::text[]);
  ALTER TABLE "PublishedLessons" ADD COLUMN "exemptFrom" TEXT[] NOT NULL DEFAULT '{}';

  CREATE FUNCTION app.master_lesson_exemption_ends() RETURNS trigger
  LANGUAGE plpgsql SET search_path = "public", "pg_temp" AS $fn$
  BEGIN
    -- Skrivaren har själv sagt vad undantaget är efter den här satsen: en ny gång (en PATCH som svarar ja igen), en återställd rad.
    IF coalesce(current_setting('app.keep_exemptions', true), '') = 'on' THEN
      RETURN NEW;
    END IF;
    -- Undantaget skrevs om i satsen: det är skrivarens, vad det än blev.
    IF NEW."exemptFrom" IS DISTINCT FROM OLD."exemptFrom" THEN
      RETURN NEW;
    END IF;
    IF NEW."dayOfWeek" <> OLD."dayOfWeek"
       OR NEW."startTime" <> OLD."startTime"
       OR NEW."endTime" <> OLD."endTime"
       OR NEW."startDate" IS DISTINCT FROM OLD."startDate"
       OR NEW."endDate" IS DISTINCT FROM OLD."endDate"
       OR (OLD."isLocked" AND NOT NEW."isLocked")
       OR (NEW."isParked" AND NOT OLD."isParked")
    THEN
      NEW."exemptFrom" := '{}';
    END IF;
    RETURN NEW;
  END
  $fn$;

  CREATE TRIGGER "MasterLessons_exemption_ends"
      BEFORE UPDATE ON "MasterLessons"
      FOR EACH ROW WHEN (cardinality(OLD."exemptFrom") > 0)
      EXECUTE FUNCTION app.master_lesson_exemption_ends();
END
$$;

COMMENT ON COLUMN "MasterLessons"."exemptFrom" IS
  'E1b (20270307090000): the rules the lesson breaks on purpose, by name (FRAME: the stage''s ramtid; LUNCH: the class''s meal), given by an administrator who answered the question "Lägg ändå" for the time the lesson stands at. The lesson is locked in the same moment. Ended by MasterLessons_exemption_ends when its day, clock, dates or lock change. Empty on every other lesson.';
COMMENT ON COLUMN "PublishedLessons"."exemptFrom" IS
  'The published lesson''s MasterLessons.exemptFrom, written back when a draft is discarded (E1b, 20270307090000).';
