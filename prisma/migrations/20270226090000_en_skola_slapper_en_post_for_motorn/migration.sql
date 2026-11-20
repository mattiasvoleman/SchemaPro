-- En skola släpper en post för motorn: markeringen "släppt för motorn" på en timplanspost.
--
-- ## Vad det är
--
-- Föreslå bemanning flyttar aldrig en lärare som skolan valt. En skola som vill att motorn ska få föreslå en annan
-- behörig lärare på en post släpper den, och bara då: Föreslå bemanning får ändra de poster som saknar lärare och de
-- som är släppta, och ingen annan (staffing-proposal.service.ts). Markeringen är en rad per släppt post, med vem som
-- släppte den och när. Ingenting skrivs utan godkännande, och motorns kontrakt är oförändrat: en bemannad post som inte
-- är släppt går till motorn som fast, som en post med pinnedRequirementIds alltid gjort.
--
-- ## Varför en egen tabell och inte en kolumn på TeachingRequirements
--
--   1. Läsbarhet. TeachingRequirements läses av skolans lärare (teaching_requirements_staff_select), och bara PLANERING
--      skriver. En kolumn där läses av varje lärare, och av webbens egna läsningar som tar hela raden. "Posten är släppt"
--      säger att en lärares post kan flyttas, vilket är skolledningens uppgift och inte lärarens. En tabell med bara
--      administratörens läsning gör det till databasens regel och inte till gatewayns försiktighet.
--   2. Låset. ADD COLUMN tar ACCESS EXCLUSIVE på tabellen varje timplansläsning går genom. En ny tabell tar bara
--      SHARE ROW EXCLUSIVE (skrivningar väntar, läsningar inte) på posten och personen nyckeln pekar på.
--   3. Året. En post som flyttas till ett nytt läsår (rullningen) är en ny rad med ett nytt id: markeringen följer inte
--      med, och ska inte det. Skolan avgör på nytt vad motorn får röra det året. TeachingRequirementRelease är SKIPPED i
--      rollover-registry.ts.
--
-- ## Nyckeln, och vad en borttagen person gör med den
--
--   (requirementId, schoolId)   -> TeachingRequirements(id, schoolId) ON DELETE CASCADE ON UPDATE NO ACTION
--   (releasedById, schoolId)    -> Users(id, schoolId) ON DELETE SET NULL ("releasedById") ON UPDATE NO ACTION
--   schoolId                    -> Schools(id) ON DELETE CASCADE ON UPDATE CASCADE
--
-- Båda sammansatta nycklarna håller radens skola mot postens och personens (skolbundna nycklar, 20270115090000), och
-- ON UPDATE är NO ACTION av samma skäl som där: en förälder som flyttar till en annan skola får inte ta barnet med sig.
-- Posten tar markeringen med sig när den tas bort (CASCADE). En person som tas bort lämnar markeringen kvar utan sitt
-- namn: att posten är släppt är skolans beslut, och det ska inte försvinna för att den som fattade det slutat
-- (SET NULL på kolumnen ensam; skolan i nyckeln är NOT NULL). Nyckeln är "kept" i removal-inventory.ts.
--
-- ## Vem som läser och skriver
--
-- Genom gatewayn bara, som förlagda poster (20270207090000): API-rollen app_authenticated har SELECT, INSERT och
-- DELETE (ingen UPDATE: en släppt post släpps inte om, den släpps eller tas tillbaka, och ON CONFLICT DO NOTHING
-- behåller den första släppningens person och tid); authenticated och anon har ingenting; service_role har SELECT och
-- inget mer; ingen har TRUNCATE, REFERENCES, TRIGGER eller, på Postgres 17, MAINTAIN. Varje policy är TO app_authenticated.
--
--   teaching_requirement_releases_admin_select   skolans SCHOOL_ADMIN: varje administratör läser, som tjänstefördelningen gör.
--                                                Inte skolans lärare, och ingen annan roll.
--   teaching_requirement_releases_admin_insert   skolans SCHOOL_ADMIN som skriver PLANERING, som posten.
--   teaching_requirement_releases_admin_delete   samma.
--
-- FORCE ROW LEVEL SECURITY är av, som på varje tabell i schemat.
--
-- ## Vid sidan av det levande API:t: varje lås på en gång, eller inget
--
-- Produktionen kör den här medan API:t före den serverar förfrågningar. Nyckeln tar Schools, TeachingRequirements och
-- Users i SHARE ROW EXCLUSIVE (skrivningar väntar, läsningar inte). Förfrågningar tar dem i alla ordningar, så en
-- migrering som väntade på ett lås medan den höll ett annat kunde sluta en cykel. De tre tas därför först, NOWAIT och
-- tillsammans: en vägran rullar tillbaka delförloppet och med det vad det fått, och försöker igen 50 ms senare. Den
-- väntar aldrig medan den håller ett lås, och ingen förfrågan köar bakom den. Efter 30 s av vägranden stoppar den utan
-- att ha ändrat något och kan köras om (prisma migrate resolve --rolled-back, sedan deploy). lock_timeout begränsar
-- varje väntan ingen förutsett.
--
-- BAKÅTKOMPATIBEL I EN VERSION. En ny tabell som ingen skriver än, och som det gamla API:t inte nämner.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Schools" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "TeachingRequirements" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Users" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Schools, TeachingRequirements och Users var inte lediga på en gång inom 30 s: ingenting är ändrat. Kör prisma migrate resolve --rolled-back 20270226090000_en_skola_slapper_en_post_for_motorn, och sedan deploy igen';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Tabellen.
-- ---------------------------------------------------------------------------

CREATE TABLE "TeachingRequirementReleases" (
    "requirementId" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "releasedById" UUID,
    "releasedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Nyckeln är posten OCH skolan, inte posten ensam. Posten bestämmer skolan (nyckeln till TeachingRequirements är
    -- (id, schoolId)), så det är fortfarande en rad per post. Men med posten ensam som nyckel hoppar INSERT ... ON CONFLICT
    -- DO NOTHING över nyckelkontrollen när raden krockar: en administratör på en annan skola, som kan nämna ett post-id,
    -- fick "0 rader" om posten var släppt och en nyckelvägran om den inte var det, alltså ett svar på om en annan skolas
    -- post är släppt. Med skolan i nyckeln krockar raden bara med sin egen skolas, och den andra skolans rad vägras av
    -- nyckeln (RLS-avsnitt 546).
    CONSTRAINT "TeachingRequirementReleases_pkey" PRIMARY KEY ("requirementId", "schoolId")
);

-- Skolans rader: policyns filter och skolans CASCADE.
CREATE INDEX "TeachingRequirementReleases_schoolId_idx"
    ON "TeachingRequirementReleases"("schoolId");
-- En persons rader: SET NULL när en person tas bort, och spärrens läsning av vad personen släppt.
CREATE INDEX "TeachingRequirementReleases_releasedById_schoolId_idx"
    ON "TeachingRequirementReleases"("releasedById", "schoolId");

ALTER TABLE "TeachingRequirementReleases"
    ADD CONSTRAINT "TeachingRequirementReleases_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeachingRequirementReleases"
    ADD CONSTRAINT "TeachingRequirementReleases_requirementId_schoolId_fkey"
    FOREIGN KEY ("requirementId", "schoolId") REFERENCES "TeachingRequirements"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "TeachingRequirementReleases"
    ADD CONSTRAINT "TeachingRequirementReleases_releasedById_schoolId_fkey"
    FOREIGN KEY ("releasedById", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE SET NULL ("releasedById") ON UPDATE NO ACTION;

COMMENT ON TABLE "TeachingRequirementReleases" IS
  'Släppt för motorn: en rad per timplanspost som skolan har släppt, så att Föreslå bemanning får föreslå en annan behörig lärare för den. En bemannad post utan rad flyttas aldrig. Skolans administratörer läser, PLANERING skriver; ingen annan roll når tabellen. Följer inte med en rullning till ett nytt läsår.';
COMMENT ON COLUMN "TeachingRequirementReleases"."releasedById" IS
  'Den som släppte posten; NULL när personen har tagits bort. Posten är fortfarande släppt.';
COMMENT ON COLUMN "TeachingRequirementReleases"."releasedAt" IS
  'När posten släpptes. Behålls när samma post släpps en gång till (ON CONFLICT DO NOTHING).';

-- ---------------------------------------------------------------------------
-- Radnivåskydd och rättigheter. Se inledningen.
-- ---------------------------------------------------------------------------

ALTER TABLE "TeachingRequirementReleases" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    CREATE POLICY "teaching_requirement_releases_admin_select" ON "TeachingRequirementReleases"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "teaching_requirement_releases_admin_insert" ON "TeachingRequirementReleases"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('PLANERING', true)));
    CREATE POLICY "teaching_requirement_releases_admin_delete" ON "TeachingRequirementReleases"
        FOR DELETE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
               AND (select app.current_user_may('PLANERING', true)));
    REVOKE ALL ON "TeachingRequirementReleases" FROM "app_authenticated";
    GRANT SELECT, INSERT, DELETE ON "TeachingRequirementReleases" TO "app_authenticated";
  END IF;
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "TeachingRequirementReleases" FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "TeachingRequirementReleases" FROM "service_role";
  END IF;
  -- PostgreSQL 17:s MAINTAIN (REINDEX, CLUSTER, VACUUM, LOCK): ägarens ensam.
  IF current_setting('server_version_num')::int >= 170000 THEN
    FOREACH r IN ARRAY ARRAY['authenticated', 'app_authenticated', 'service_role', 'anon'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE MAINTAIN ON "TeachingRequirementReleases" FROM %I', r);
      END IF;
    END LOOP;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- RELEASES_REACH: de tre policyerna ovan och ingen annan; ingen för en PostgREST-roll, tjänsten eller synkens principal.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  bad text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    RETURN;
  END IF;
  SELECT string_agg(p.policyname || ' ' || p.cmd || ' ' || p.roles::text, ', ' ORDER BY p.policyname) INTO bad
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = 'TeachingRequirementReleases'
     AND NOT (p.roles = '{app_authenticated}'::name[]
              AND p.policyname = 'teaching_requirement_releases_'
                                 || CASE p.cmd WHEN 'SELECT' THEN 'admin_select'
                                               WHEN 'INSERT' THEN 'admin_insert'
                                               WHEN 'DELETE' THEN 'admin_delete'
                                               ELSE 'a policy for every command' END
              AND (p.cmd = 'SELECT' OR coalesce(p.with_check, p.qual) LIKE '%current_user_may(''PLANERING''%'));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'RELEASES_REACH: dessa policyer når TeachingRequirementReleases utöver administratörernas läsning och planerarens skrivningar: %', bad;
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'TeachingRequirementReleases') <> 3 THEN
    RAISE EXCEPTION 'RELEASES_REACH: TeachingRequirementReleases har % policyer, inte de tre ovan',
      (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'TeachingRequirementReleases');
  END IF;
END
$$;
