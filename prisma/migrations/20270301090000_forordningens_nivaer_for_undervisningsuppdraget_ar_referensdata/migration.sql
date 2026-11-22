-- Förordningens nivåer för lärarens undervisningsuppdrag är referensdata, och skolan kan välja vad en skrivning över nivån får göra.
--
-- ## Vad det är
--
-- Skollagen får från 2027-07-01 ett undervisningsuppdrag som uttryckligen omfattar planering och uppföljning (prop. 2025/26:196
-- Tid för undervisningsuppdraget), och förordningen SFS 2026:1487 (utfärdad 2026-06-25, i kraft 2027-07-01) anger hur stor
-- omfattning tiden för uppdraget ska ha. För grundskolan, den enda skolform Rastra har personal i, säger den två saker:
--
--   3 §      lärarens undervisningstid under ett läsår ska vid heltid "som mest vara inom intervallet" 550-650 timmar för
--            årskurs 1-6 (3 § p. 1) och 500-600 timmar för årskurs 7-9 (3 § p. 2). Vid deltid ska förhållandet mellan
--            undervisningstiden och arbetstiden vara det som gäller vid heltid (3 § andra stycket).
--   4 § 5 §  tiden för planering och uppföljning ska minst motsvara undervisningstiden (4 § p. 1, årskurs 1-6), och för
--            årskurs 7-9 ytterligare minst 10 procent av den (5 § p. 1).
--
-- Den här migreringen lägger siffrorna i databasen som versionerad referensdata, och en policyrad för vad en skrivning över
-- övre kanten får göra. Räkningen (undervisningstid ur timplansposterna, deltid, A/B-veckor, terminer), kontrollerna och
-- gränssnittet kommer i senare PR:er (fas R1); den här ändrar inget beteende.
--
-- Återställning: allt här är additivt och inget läser det än. DROP TABLE "AssignmentScopeBands", "AssignmentScopeVersions";
-- ALTER TABLE "StaffingPolicies" DROP COLUMN "assignmentScopeMode"; en gateway före migreringen är opåverkad.
--
-- ## Namnet: undervisningsuppdragets omfattning
--
-- Förordningens egen rubrik är "omfattning av tiden för lärares och förskollärares undervisningsuppdrag", så tabellerna heter
-- AssignmentScope*. Ordet undervisningstid ensamt hade krockat med ELEVENS garanterade undervisningstid (timplanen,
-- TimplanCredits, 20261009100000), och uppdrag ensamt med TeacherDuties (mentorskap, rastvakt).
--
-- ## Vad som är data och vad som inte är
--
-- Två tabeller, båda globala som NationalTimplanVersions (20261006090000) och av samma skäl: författningen är densamma för alla
-- skolor, den ändras av regeringen och inte av en skola, och en skolas egna inställningar (riktmärket, tjänstens omfattning)
-- ska aldrig kunna skriva över den. En ändring av förordningen läggs in som en NY version med alla band, inte som en
-- uppdatering av raderna, så att ett läsår som bedömdes mot den gamla lydelsen kan visa vilken.
--
--   "AssignmentScopeVersions"  en rad per lydelse: författningen, när den gäller (validFrom, validTo inklusive) och vilken
--                              lydelse som avlöser den. Två lydelser gäller aldrig samma dag (EXCLUDE).
--   "AssignmentScopeBands"     en rad per (lydelse, skolform, numrering, årskurser): den högsta nivåns spann i timmar vid
--                              heltid och planeringens golv i procent av undervisningstiden, med paragrafen för varje tal.
--
-- Spannet är INTE ett tak. "Som mest vara inom intervallet" betyder att lärarens egen högsta nivå ligger någonstans i spannet,
-- och att rektorn bedömer var (8 §, prop. 2025/26:196 s. 41). 650 timmar är gränsen för en lärare i årskurs 1-6; mellan 550 och
-- 650 avgör bedömningen. Därför heter kolumnerna teachingHoursLow och teachingHoursHigh och inte "max": räkningen i en senare
-- PR kräver bara att övre kanten inte överskrids, och visar resten som en bedömning.
--
-- ## Raderna (varje tal med sin paragraf, läst i SFS-texten 2026-11-21)
--
--   GRUNDSKOLA NIOARIG åk 1-6   550-650 h   golv 100 %   3 § p. 1; 4 § p. 1
--   GRUNDSKOLA NIOARIG åk 7-9   500-600 h   golv 110 %   3 § p. 2; 4 § p. 1 och 5 § p. 1
--
-- 110 procent är en TOLKNING och står så i kolumnen "note": 5 § säger "Utöver den tid som anges i 4 §" men 4 § räknar inte upp
-- årskurs 7-9. Läsningen 100 % + 10 % följer av utredningens sammanfattning (prop. 2025/26:196 bilaga 1 s. 125: tiden "ökar med
-- ytterligare minst 10 respektive 20 procent"). Är den fel är det en ny version av raden, inte en kodändring.
--
-- Vad som INTE har en rad, med flit:
--
--   * Förskoleklassen (årskurs 0). Förordningen nämner den inte, och förarbetet säger att den inte omfattas (prop. s. 43-44).
--   * Den tioåriga grundskolan (numreringen TIOARIG, läsår från 2028-07-01). Förordningen är inte ändrad för den: dess "årskurs
--     1-6" och "7-9" flyttar stadiegränsen ett steg när årskurserna numreras om (src/common/grade-numbering.ts), och en rad som
--     gissade vilket steg vore en siffra ingen har bestämt. Raderna läggs in som ny version när förordningen ändras (fas R2).
--   * Fritidshem (9 §), förskola (10 §), gymnasieskola och komvux (3 § p. 3-4, 6-7 §), anpassad grundskola, sameskola och
--     specialskola: Rastra har ingen sådan personal eller skolform i sin tjänstefördelning. SchoolForm-enumet har värdena, så
--     en rad kan läggas in utan ny typ den dag de behövs.
--
-- ## Policyraden
--
-- "StaffingPolicies"."assignmentScopeMode": vad en SKRIVNING som tar en lärare över förordningens högsta nivå får göra. OFF/WARN/
-- REFUSE som de två befintliga (qualificationMode, overAllocationMode), förvalt WARN. REFUSE är skolans eget val; ingen nivå
-- under övre kanten vägras någonsin. Kolumnen läses av ingen kod än; fältet i formuläret och kontrollen kommer i en senare PR.
-- Tillägget är en kolumn med konstant förvald: ingen omskrivning av tabellen, bara ett kort ACCESS EXCLUSIVE-lås, som tas med
-- NOWAIT i en slinga (ger upp efter 30 s och ändrar då ingenting) så att migreringen aldrig står och blockerar skolornas läsning
-- av sin policy.
--
-- ## Rättigheter
--
-- Som NationalTimplanVersions efter 20261212090000: RLS på, en SELECT-arm för en aktiv principal vid en skola (app.current_school_id(),
-- så en transaktion utan principal läser ingenting, och en huvudmans läsare som nämner en skola läser det skolans läsare läser:
-- avsnitt 262 jämför det för varje tabell med radsäkerhet), ingen skrivarm, och alla skrivrättigheter återtagna från PUBLIC, anon,
-- authenticated, service_role och app_authenticated. REVOKE ALL tar också MAINTAIN på Postgres 17. Ett REVOKE som nämner en roll som
-- saknas stoppar en driftsättning, så varje roll frågas först.

-- ---------------------------------------------------------------------------
-- Lydelserna
-- ---------------------------------------------------------------------------

CREATE TABLE "AssignmentScopeVersions" (
    "id"               UUID        NOT NULL DEFAULT gen_random_uuid(),
    -- 'SFS2026:1487': författningen. En ändring har en kod av sitt eget.
    "code"             TEXT        NOT NULL,
    "sfs"              TEXT        NOT NULL,
    "title"            TEXT        NOT NULL,
    -- Första dagen lydelsen gäller. Ett läsår bedöms mot den lydelse som gäller dess första dag.
    "validFrom"        DATE        NOT NULL,
    -- Sista dagen lydelsen gäller, inklusive; NULL så länge den inte avlösts.
    "validTo"          DATE,
    "supersededByCode" TEXT,
    "source"           TEXT        NOT NULL,
    "createdAt"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssignmentScopeVersions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AssignmentScopeVersions_code_is_not_blank" CHECK (btrim("code") <> ''),
    CONSTRAINT "AssignmentScopeVersions_title_is_not_blank" CHECK (btrim("title") <> ''),
    CONSTRAINT "AssignmentScopeVersions_validity_is_a_range" CHECK ("validTo" IS NULL OR "validTo" >= "validFrom"),
    CONSTRAINT "AssignmentScopeVersions_does_not_supersede_itself" CHECK ("supersededByCode" IS NULL OR "supersededByCode" <> "code"),
    -- Två lydelser gäller aldrig samma dag: ett läsårs första dag har högst en. btree_gist behövs inte för en ensam
    -- intervallkolumn; intervalltyper har GiST-stöd själva.
    CONSTRAINT "AssignmentScopeVersions_validity_does_not_overlap"
        EXCLUDE USING gist (daterange("validFrom", "validTo", '[]') WITH &&)
);

CREATE UNIQUE INDEX "AssignmentScopeVersions_code_key" ON "AssignmentScopeVersions"("code");

ALTER TABLE "AssignmentScopeVersions"
    ADD CONSTRAINT "AssignmentScopeVersions_supersededByCode_fkey"
    FOREIGN KEY ("supersededByCode") REFERENCES "AssignmentScopeVersions"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Bandens
-- ---------------------------------------------------------------------------

CREATE TABLE "AssignmentScopeBands" (
    "id"                   UUID        NOT NULL DEFAULT gen_random_uuid(),
    "versionId"            UUID        NOT NULL,
    "schoolForm"           "SchoolForm"      NOT NULL,
    -- I vilken numrering årskurserna är angivna. Förordningens 1-6 och 7-9 är numreringen NIOARIG; en ändring för den
    -- tioåriga grundskolan blir rader med TIOARIG.
    "gradeNumbering"       "GradeNumbering"  NOT NULL,
    "gradeFrom"            INTEGER     NOT NULL,
    "gradeTo"              INTEGER     NOT NULL,
    -- Spannet för den HÖGSTA undervisningstiden vid heltid, timmar per läsår. Låg är bottnen av spannet, inte ett golv för
    -- undervisningen: det finns ingen nedre gräns för hur lite en lärare får undervisa.
    "teachingHoursLow"     INTEGER     NOT NULL,
    "teachingHoursHigh"    INTEGER     NOT NULL,
    -- Planering och uppföljning, minst så här många procent av lärarens undervisningstid.
    "planningFloorPercent" INTEGER     NOT NULL,
    "teachingSection"      TEXT        NOT NULL,
    "planningSection"      TEXT        NOT NULL,
    -- En tolkning av texten, när bandet bygger på en: sägs i klartext i gränssnittet. NULL när bandet är författningens egen.
    "note"                 TEXT,

    CONSTRAINT "AssignmentScopeBands_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AssignmentScopeBands_versionId_fkey"
        FOREIGN KEY ("versionId") REFERENCES "AssignmentScopeVersions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AssignmentScopeBands_grades_are_a_range" CHECK ("gradeFrom" >= 0 AND "gradeFrom" <= "gradeTo" AND "gradeTo" <= 12),
    CONSTRAINT "AssignmentScopeBands_span_is_a_span" CHECK ("teachingHoursLow" > 0 AND "teachingHoursLow" <= "teachingHoursHigh" AND "teachingHoursHigh" <= 2500),
    CONSTRAINT "AssignmentScopeBands_planning_floor_is_a_share" CHECK ("planningFloorPercent" >= 0 AND "planningFloorPercent" <= 300),
    CONSTRAINT "AssignmentScopeBands_sections_are_not_blank" CHECK (btrim("teachingSection") <> '' AND btrim("planningSection") <> ''),
    CONSTRAINT "AssignmentScopeBands_note_is_not_blank" CHECK ("note" IS NULL OR btrim("note") <> '')
);

-- Namnet är kort med flit: Prisma's förvalda namn är över 63 tecken, och Postgres kapar det tyst.
CREATE UNIQUE INDEX "AssignmentScopeBands_version_form_numbering_from_key"
    ON "AssignmentScopeBands"("versionId", "schoolForm", "gradeNumbering", "gradeFrom");

-- Två band i samma lydelse, skolform och numrering delar aldrig en årskurs: slå upp en årskurs ger högst ett band.
-- btree_gist (installerad sedan 20260822131500) behövs för likhet på uuid och enum bredvid intervallet.
ALTER TABLE "AssignmentScopeBands"
    ADD CONSTRAINT "AssignmentScopeBands_grades_do_not_overlap"
    EXCLUDE USING gist (
        "versionId" WITH =,
        "schoolForm" WITH =,
        "gradeNumbering" WITH =,
        int4range("gradeFrom", "gradeTo", '[]') WITH &&
    );

COMMENT ON TABLE "AssignmentScopeVersions" IS
  'Förordningens lydelser för lärarens undervisningsuppdrag (SFS 2026:1487 från 2027-07-01), referensdata som NationalTimplanVersions: global, bara läsbar för API-rollerna, ändras av migreringar. En ändring av förordningen är en ny lydelse med alla band. Ett läsår bedöms mot den lydelse som gäller dess första dag. Inte elevens garanterade undervisningstid (timplanen).';
COMMENT ON TABLE "AssignmentScopeBands" IS
  'En rad per lydelse, skolform, numrering och årskurser: spannet för lärarens högsta undervisningstid (timmar per läsår vid heltid; 3 §) och golvet för planering och uppföljning (procent av undervisningstiden; 4-5 §). Spannet är inget tak: lärarens egen högsta nivå ligger i det och rektorn bedömer var (8 §); bara övre kanten är en gräns. Förskoleklass och den tioåriga numreringen har ingen rad med flit (migreringens huvud).';
COMMENT ON COLUMN "AssignmentScopeBands"."teachingHoursLow" IS
  'Nedre kanten av spannet för den högsta undervisningstiden, timmar per läsår vid heltid. Inget golv för undervisningen: det finns ingen nedre gräns för hur lite en lärare får undervisa.';
COMMENT ON COLUMN "AssignmentScopeBands"."teachingHoursHigh" IS
  'Övre kanten av spannet, timmar per läsår vid heltid: det högsta en lärare i bandet någonsin får undervisa (utom enligt ett undantag i 11 §). Deltid: × tjänstens omfattning (3 § andra stycket).';
COMMENT ON COLUMN "AssignmentScopeBands"."planningFloorPercent" IS
  'Minsta tid för planering och uppföljning, procent av lärarens undervisningstid: 100 (4 § p. 1), och 110 för årskurs 7-9 (4 § och 5 § p. 1, en tolkning, se "note").';

-- ---------------------------------------------------------------------------
-- Rättigheter
-- ---------------------------------------------------------------------------

ALTER TABLE "AssignmentScopeVersions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssignmentScopeBands"    ENABLE ROW LEVEL SECURITY;

-- En aktiv principal vid en skola läser; ingen transaktion utan principal läser något. Frågan är app.current_school_id() och inte
-- current_user_id(): en huvudmans läsare har en skola men ingen Users-rad, och 20261212090000 flyttade de nationella tabellernas
-- armar dit av just det skälet (avsnitt 262 fäller en tabell vars arm gör skillnad på dem). FOR SELECT enbart: utan en INSERT-,
-- UPDATE- eller DELETE-arm släpper radsäkerheten ingen rad till en skrivning även där en rättighet skulle tillåta satsen, och
-- rättigheterna tas tillbaka nedan så att en vägran är ett högt 42501 och inte noll rader i tysthet.
CREATE POLICY "assignment_scope_versions_select" ON "AssignmentScopeVersions"
    FOR SELECT TO "authenticated" USING ((select app.current_school_id()) IS NOT NULL);

CREATE POLICY "assignment_scope_bands_select" ON "AssignmentScopeBands"
    FOR SELECT TO "authenticated" USING ((select app.current_school_id()) IS NOT NULL);

-- 20260806000000:s ALTER DEFAULT PRIVILEGES ger varje tabell SELECT, INSERT, UPDATE, DELETE för "authenticated" och "service_role"
-- (och på Postgres 17 även MAINTAIN) i samma stund CREATE TABLE körs. Det är rätt för en skolas tabeller och fel för en
-- författning: skrivhalvan tas tillbaka och SELECT ges om uttryckligen, per roll som finns (en bar Postgres saknar anon och
-- service_role, och bara den lokala compose-databasen har app_authenticated). service_role går förbi radsäkerheten, vilket är
-- precis varför dess skrivrättighet ska bort: den saknade rättigheten är det enda som står mellan den och tabellen. anon behåller
-- ingenting: en förfrågan utan token har inget skäl att läsa förordningens nivåer.
DO $$
DECLARE
  tbl      text;
  api_role text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['AssignmentScopeVersions', 'AssignmentScopeBands']
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', tbl);
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated']
    LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
        EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', tbl, api_role);
        IF api_role <> 'anon' THEN
          EXECUTE format('GRANT SELECT ON TABLE %I TO %I', tbl, api_role);
        END IF;
      END IF;
    END LOOP;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Förordningens siffror
-- ---------------------------------------------------------------------------

WITH new_version AS (
  INSERT INTO "AssignmentScopeVersions" ("code", "sfs", "title", "validFrom", "validTo", "source")
  VALUES (
    'SFS2026:1487',
    'SFS 2026:1487',
    'Förordning om omfattning av tiden för lärares och förskollärares undervisningsuppdrag',
    DATE '2027-07-01',
    NULL,
    'https://svenskforfattningssamling.se/sites/default/files/sfs/2026-06/SFS2026-1487.pdf'
  )
  RETURNING "id"
)
INSERT INTO "AssignmentScopeBands"
  ("versionId", "schoolForm", "gradeNumbering", "gradeFrom", "gradeTo",
   "teachingHoursLow", "teachingHoursHigh", "planningFloorPercent", "teachingSection", "planningSection", "note")
SELECT new_version."id", b.school_form::"SchoolForm", b.numbering::"GradeNumbering", b.grade_from, b.grade_to,
       b.low, b.high, b.floor_percent, b.teaching_section, b.planning_section, b.note
  FROM new_version,
       (VALUES
          ('GRUNDSKOLA', 'NIOARIG', 1, 6, 550, 650, 100, '3 § p. 1', '4 § p. 1',
           NULL::text),
          ('GRUNDSKOLA', 'NIOARIG', 7, 9, 500, 600, 110, '3 § p. 2', '4 § p. 1 och 5 § p. 1',
           'Tolkning: 5 § säger "Utöver den tid som anges i 4 §" men 4 § räknar inte upp årskurs 7-9. Läst som 100 % (4 §) och ytterligare minst 10 % (5 §), vilket är utredningens egen sammanfattning (prop. 2025/26:196 bilaga 1 s. 125).')
       ) AS b(school_form, numbering, grade_from, grade_to, low, high, floor_percent, teaching_section, planning_section, note);

-- ---------------------------------------------------------------------------
-- Vad en skrivning över nivån får göra: skolans val
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  LOOP
    BEGIN
      LOCK TABLE "StaffingPolicies" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'StaffingPolicies was not free in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;

  ALTER TABLE "StaffingPolicies"
    ADD COLUMN "assignmentScopeMode" "StaffingCheckMode" NOT NULL DEFAULT 'WARN';
END
$$;

COMMENT ON COLUMN "StaffingPolicies"."assignmentScopeMode" IS
  'Undervisningsuppdragets omfattning (20270301090000): vad en skrivning som tar en lärare över förordningens högsta nivå för undervisningstid får göra. OFF frågar inget, WARN släpper igenom och varnar, REFUSE svarar 409. Förvalt WARN: REFUSE är skolans eget val. Ingen nivå under övre kanten vägras någonsin. Läses av kontrollen i en senare PR.';
