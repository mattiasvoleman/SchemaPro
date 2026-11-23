-- Rektorn sätter lärarens egen nivå inom förordningens spann och registrerar undantag enligt 11 § (R1, del G).
--
-- ## Vad det är
--
-- Förordningen SFS 2026:1487 anger inte en nivå för varje lärare utan ett SPANN: 550-650 timmar för årskurs 1-6 och 500-600 för
-- årskurs 7-9 (3 §), och den som avgör var i spannet en lärare ligger är rektorn (8 §: hänsyn till gruppernas storlek, antalet
-- elever läraren möter, elever i behov av särskilt stöd och andra omständigheter; en lärare med goda förutsättningar får den
-- största omfattningen, en med mindre goda "ska ges mindre undervisningstid"). 11 § tillåter dessutom "vissa undantag" från
-- omfattningen, restriktivt: på lärarens eget initiativ (p. 1), för enstaka vikarietimmar (p. 2, som aldrig ligger i den
-- planerade tiden och därför inte behöver någon rad) och när läraren undervisar en enskild elev eller en mindre grupp (p. 3).
--
-- Rastra bedömer inte "goda" eller "mindre goda förutsättningar": det vore en poängmodell som liknade en bedömning enligt 8 §
-- och var en gissning. Rektorn lägger i stället lärarens nivå, och produkten visar nivån, de faktorer den har data för och vad
-- den saknar. Den här tabellen är rektorns registrering, och inget mer: en rad per lärare och läsår.
--
-- Återställning: tabellen är ny och inget läser den än. DROP TABLE "AssignmentScopeAssessments"; DROP TYPE
-- "AssignmentScopeException"; DROP FUNCTION app.assignment_scope_assessments_decided(); en gateway före migreringen är opåverkad.
--
-- ## Vad en rad är
--
--   teachingLevelHours   lärarens högsta nivå vid HELTID, i timmar per läsår (heltal). NULL = rektorn har inte satt någon, och då
--                        gäller förordningens övre kant för lärarens stadium. Nivån får ligga var som helst i spannet och under det:
--                        det finns ingen nedre gräns för hur lite en lärare får undervisa. Deltid skalas som förordningen säger
--                        (3 § andra stycket), så siffran är densamma för en lärare med 80 % som för en med 100 %.
--   exceptionKind        NULL = inget undantag. OWN_INITIATIVE = 11 § p. 1, SMALL_GROUP = 11 § p. 3. Slaget p. 2 finns inte:
--                        enstaka vikarietimmar ligger aldrig i den planerade undervisningstiden.
--   ownInitiativeOn      dagen läraren tog initiativet. OBLIGATORISK för OWN_INITIATIVE och förbjuden annars (CHECK), eftersom 11 §
--                        sista stycket säger att p. 1 "endast får ske på lärarens eget initiativ" och tillsynen kan vilja se när.
--   note                 kort fritext, högst 500 tecken. Aldrig hälsa eller andra känsliga uppgifter: fältet är för skälet till
--                        nivån eller undantaget, i den detalj en tillsyn behöver.
--   decidedById/At       vem som satte raden och när. Sätts av en TRIGGER och aldrig av den som skriver, så att uppgiften är
--                        sann för varje skrivväg och inte bara den som går genom gatewayen. En person som tas bort lämnar
--                        raden kvar utan namn (SET NULL): bedömningen gäller läraren, inte rektorn som gjorde den.
--
-- En rad måste säga något: utan både nivå och undantag finns ingen rad (CHECK). Att ta bort bedömningen är att ta bort raden.
--
-- Ett undantag TYSTAR INTE utlåtandet. Läraren är fortfarande över förordningens kant om hen är det, och rapporten och
-- lärarlådan säger det, med "undantag enligt 11 § registrerat" bredvid. Vad ett undantag ändrar är bara att en skrivning inte
-- VÄGRAS för läraren (assignmentScopeMode = REFUSE) och att Föreslå bemanning inte lägger kanten som hård gräns för hen.
--
-- ## Radsäkerhet, i samma hållning som TeacherEmployments
--
-- Nivån och undantagen är personuppgifter om en anställd, så raden behandlas som tjänsten den hör ihop med:
--
--   assignment_scope_assessments_admin_select   skolans SCHOOL_ADMIN: varje administratör läser raden (gatewayen är vägen till någon
--                                               annans rad och döljer den för den utan HR-läs, som tjänstens procent).
--   assignment_scope_assessments_admin_insert   skolans SCHOOL_ADMIN som BESLUTAR (app.current_user_decides: rektor eller full
--   assignment_scope_assessments_admin_update   administratör), som tjänstens procent. Samma för update och delete.
--   assignment_scope_assessments_admin_delete
--   assignment_scope_assessments_teacher_own_select   läraren läser sin EGEN rad och ingen kollegas: Min tjänst och lärarens egen siffra i
--                                               rapporten bygger på den. En administratör som undervisar läser sin rad genom administratörens arm, som
--                                               släpper alla skolans rader.
--
-- ALLA ARMAR ÄR TO app_authenticated: bedömningen av en anställd har ingen direkt väg för PostgREST-rollerna (authenticated, anon),
-- som TeacherEmployments har av äldre skäl. Skolans lärare når den bara genom gatewayen, som skär den per läsare. Ingen arm för
-- tjänsten eller synken (service_role går förbi radsäkerheten och har bara SELECT), och inga för anon. TRUNCATE, REFERENCES, TRIGGER
-- och, på Postgres 17, MAINTAIN har ingen utom ägaren. FORCE ROW LEVEL SECURITY är av, som på varje tabell i schemat.
--
-- ## Vid sidan av det levande API:t: varje lås på en gång, eller inget
--
-- Nycklarna tar Schools, AcademicYears och Users i SHARE ROW EXCLUSIVE (skrivningar väntar, läsningar inte). Förfrågningar tar dem
-- i alla ordningar, så en migrering som väntade på ett lås medan den höll ett annat kunde sluta en cykel. De tre tas därför först,
-- NOWAIT och tillsammans: en vägran rullar tillbaka delförloppet och med det vad det fått, och försöker igen 50 ms senare. Den
-- väntar aldrig medan den håller ett lås. Efter 30 s av vägranden stoppar den utan att ha ändrat något och kan köras om (prisma
-- migrate resolve --rolled-back, sedan deploy).
--
-- BAKÅTKOMPATIBEL I EN VERSION. En ny tabell som ingen skriver än, och som det gamla API:t inte nämner.
--
-- ## En rättelse av referensdatan i samma migrering (granskningen av #372, L-4)
--
-- Bandet för årskurs 7-9 (migreringen 20270301090000) citerar planeringens paragraf som "4 § p. 1 och 5 § p. 1". 4 § p. 1 gäller årskurs 1-6 och
-- räknar inte upp årskurs 7-9, så hänvisningen säger mer än texten gör: att golvet för 7-9 vilar på 4 § är just tolkningen som bandets anteckning
-- redan säger. Citatet blir "4 § (tolkat) och 5 § p. 1". En UPDATE och inte en ny lydelse: ingen siffra och ingen dag ändras, bara texten som pekar ut
-- var siffran står, så en ny version av förordningen vore fel (den ger en ny rad och en ny tolkning av vad som gällde när). UPDATE:n träffar bara raden
-- med den gamla texten, så den är ofarlig att köra om, och migreringen 20270301090000 rörs inte (dess checksumma står i produktionen).

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Schools" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "AcademicYears" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Users" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Schools, AcademicYears och Users var inte lediga på en gång inom 30 s: ingenting är ändrat. Kör prisma migrate resolve --rolled-back 20270306090000_rektorn_satter_lararens_niva_och_registrerar_undantag_enligt_11 och sedan prisma migrate deploy igen: utan det första svarar deploy P3009 (en misslyckad migrering) och kör ingenting.';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Tabellen.
-- ---------------------------------------------------------------------------

CREATE TYPE "AssignmentScopeException" AS ENUM ('OWN_INITIATIVE', 'SMALL_GROUP');

CREATE TABLE "AssignmentScopeAssessments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "academicYearId" UUID NOT NULL,
    "teachingLevelHours" INTEGER,
    "exceptionKind" "AssignmentScopeException",
    "ownInitiativeOn" DATE,
    "note" TEXT,
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AssignmentScopeAssessments_pkey" PRIMARY KEY ("id"),
    -- Förordningens spann når 650 timmar. Taket här är en rimlighetsspärr mot ett skrivfel, inte förordningens kant: den kontrollerar
    -- gatewayen mot den lydelse som gäller läsåret, så att en ny lydelse (en rad i referensdatan) flyttar den utan en migrering.
    CONSTRAINT "AssignmentScopeAssessments_level_is_sane" CHECK ("teachingLevelHours" IS NULL OR ("teachingLevelHours" >= 1 AND "teachingLevelHours" <= 1500)),
    CONSTRAINT "AssignmentScopeAssessments_says_something" CHECK ("teachingLevelHours" IS NOT NULL OR "exceptionKind" IS NOT NULL),
    -- 11 § p. 1 får "endast ske på lärarens eget initiativ": dagen är obligatorisk för det undantaget och meningslös för det andra.
    CONSTRAINT "AssignmentScopeAssessments_own_initiative_has_a_day" CHECK (("exceptionKind" IS NOT DISTINCT FROM 'OWN_INITIATIVE') = ("ownInitiativeOn" IS NOT NULL)),
    CONSTRAINT "AssignmentScopeAssessments_note_is_sane" CHECK ("note" IS NULL OR char_length("note") <= 500)
);

-- En bedömning per lärare och läsår. schoolId leder så att en skola inte kan fylla en annans plats; nyckeln är också per-läsårs-listans index.
CREATE UNIQUE INDEX "AssignmentScopeAssessments_schoolId_userId_academicYearId_key"
    ON "AssignmentScopeAssessments"("schoolId", "userId", "academicYearId");
-- Läsårets rader: rapportens läsning och policyns filter.
CREATE INDEX "AssignmentScopeAssessments_schoolId_academicYearId_idx"
    ON "AssignmentScopeAssessments"("schoolId", "academicYearId");
-- Den som beslutade: SET NULL när en person tas bort.
CREATE INDEX "AssignmentScopeAssessments_decidedById_schoolId_idx"
    ON "AssignmentScopeAssessments"("decidedById", "schoolId");

ALTER TABLE "AssignmentScopeAssessments"
    ADD CONSTRAINT "AssignmentScopeAssessments_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssignmentScopeAssessments"
    ADD CONSTRAINT "AssignmentScopeAssessments_academicYearId_schoolId_fkey"
    FOREIGN KEY ("academicYearId", "schoolId") REFERENCES "AcademicYears"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "AssignmentScopeAssessments"
    ADD CONSTRAINT "AssignmentScopeAssessments_userId_schoolId_fkey"
    FOREIGN KEY ("userId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "AssignmentScopeAssessments"
    ADD CONSTRAINT "AssignmentScopeAssessments_decidedById_schoolId_fkey"
    FOREIGN KEY ("decidedById", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE SET NULL ("decidedById") ON UPDATE NO ACTION;

COMMENT ON TABLE "AssignmentScopeAssessments" IS
  'Rektorns bedömning enligt 8 § SFS 2026:1487 av en lärares högsta undervisningstid inom förordningens spann (teachingLevelHours, vid heltid), och registrerade undantag enligt 11 §. En rad per lärare och läsår; ingen rad = förordningens övre kant gäller. Ett undantag tystar inte utlåtandet. Skolans administratörer läser, rektor eller full administratör skriver, läraren läser sin egen. Inte elevens garanterade undervisningstid.';
COMMENT ON COLUMN "AssignmentScopeAssessments"."teachingLevelHours" IS
  'Lärarens högsta undervisningstid vid heltid, timmar per läsår. NULL = ingen satt (förordningens kant gäller). Deltid skalas som 3 § andra stycket.';
COMMENT ON COLUMN "AssignmentScopeAssessments"."exceptionKind" IS
  'Undantag enligt 11 §: OWN_INITIATIVE = p. 1 (på lärarens eget initiativ), SMALL_GROUP = p. 3 (en enskild elev eller en mindre grupp). NULL = inget. Enstaka vikarietimmar (p. 2) ligger aldrig i den planerade tiden och har ingen rad.';
COMMENT ON COLUMN "AssignmentScopeAssessments"."ownInitiativeOn" IS
  'Dagen läraren tog initiativet till ett undantag enligt 11 § p. 1. Obligatorisk för OWN_INITIATIVE, förbjuden annars.';
COMMENT ON COLUMN "AssignmentScopeAssessments"."decidedById" IS
  'Den som satte raden senast, ur sessionen och aldrig ur anropet (triggern). NULL när personen har tagits bort eller när ingen princip skrev.';
COMMENT ON COLUMN "AssignmentScopeAssessments"."decidedAt" IS
  'När raden senast skrevs, satt av triggern.';

-- ---------------------------------------------------------------------------
-- Vem och när: aldrig den som skriver.
-- ---------------------------------------------------------------------------

-- En kolumn som säger "beslutad av" men kan skrivas av vem som helst bevisar ingenting för en tillsyn. Triggern sätter båda kolumnerna ur
-- sessionen vid varje INSERT och UPDATE, så ett anrop som skickar någon annans id eller ett annat datum får dem överskrivna. Utan
-- princip (ett jobb, en migrering) blir personen NULL. SECURITY INVOKER: den läser bara sessionens egen identitet.
--
-- En UPDATE inifrån en annan trigger är ingen skrivning av en person: nyckelns ON DELETE SET NULL ("decidedById") uppdaterar raden
-- inifrån den refererande triggern (pg_trigger_depth() > 1) när beslutaren tas bort, och då ska raden stå kvar utan namn och inte få
-- NAMNET PÅ DEN SOM TOG BORT BESLUTAREN. En första version utan det skrev över NULL med borttagarens id (RLS-avsnitt 568 fångade det).
-- Ett anrop som skickar en UPDATE har djup 1 och får sina kolumner överskrivna som förut.
CREATE FUNCTION app.assignment_scope_assessments_decided() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;
  NEW."decidedById" := app.current_user_id();
  NEW."decidedAt" := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER "AssignmentScopeAssessments_decided"
    BEFORE INSERT OR UPDATE ON "AssignmentScopeAssessments"
    FOR EACH ROW EXECUTE FUNCTION app.assignment_scope_assessments_decided();

-- ---------------------------------------------------------------------------
-- Radnivåskydd och rättigheter. Se inledningen.
-- ---------------------------------------------------------------------------

ALTER TABLE "AssignmentScopeAssessments" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    CREATE POLICY "assignment_scope_assessments_admin_select" ON "AssignmentScopeAssessments"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "assignment_scope_assessments_admin_insert" ON "AssignmentScopeAssessments"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_decides()));
    CREATE POLICY "assignment_scope_assessments_admin_update" ON "AssignmentScopeAssessments"
        FOR UPDATE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_decides()));
    CREATE POLICY "assignment_scope_assessments_admin_delete" ON "AssignmentScopeAssessments"
        FOR DELETE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
               AND (select app.current_user_decides()));
    CREATE POLICY "assignment_scope_assessments_teacher_own_select" ON "AssignmentScopeAssessments"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'TEACHER'
               AND "userId" = (select app.current_user_id()));
    REVOKE ALL ON "AssignmentScopeAssessments" FROM "app_authenticated";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "AssignmentScopeAssessments" TO "app_authenticated";
  END IF;
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "AssignmentScopeAssessments" FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "AssignmentScopeAssessments" FROM "service_role";
  END IF;
  -- PostgreSQL 17:s MAINTAIN (REINDEX, CLUSTER, VACUUM, LOCK): ägarens ensam.
  IF current_setting('server_version_num')::int >= 170000 THEN
    FOREACH r IN ARRAY ARRAY['authenticated', 'app_authenticated', 'service_role', 'anon'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE MAINTAIN ON "AssignmentScopeAssessments" FROM %I', r);
      END IF;
    END LOOP;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Planeringens paragraf för årskurs 7-9 (L-4). Se inledningen.
-- ---------------------------------------------------------------------------

UPDATE "AssignmentScopeBands"
   SET "planningSection" = '4 § (tolkat) och 5 § p. 1'
 WHERE "schoolForm" = 'GRUNDSKOLA'
   AND "gradeNumbering" = 'NIOARIG'
   AND "gradeFrom" = 7
   AND "gradeTo" = 9
   AND "planningSection" = '4 § p. 1 och 5 § p. 1';
