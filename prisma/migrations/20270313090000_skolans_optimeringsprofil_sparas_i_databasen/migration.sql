-- Omgång 15, P5 Förvalen en ny skola möter: optimeringsprofilen sparas per skola och inte i webbläsaren.
--
-- ## Vad
--
-- En tabell, OptimizationProfiles: en rad per skola med de fem vikter Generera-sidans reglage sätter (preferredFree, preferredBusy,
-- disruption, spread, teacherGap), var och en ett heltal 0–1000 som motorns begäran tar dem. Ingen funktion, ingen trigger, inget annat index än
-- nyckeln.
--
-- ## Varför
--
-- Vikterna låg i webbläsarens localStorage (`schemapro.optimizationWeights`): en schemaläggare som bytte dator, eller en kollega på en annan,
-- körde Generera med en annan profil än skolans utan att något sa det, och en profil som någon hade ställt in gick förlorad när webbläsaren
-- rensades. En ny skola möter profilen som sitt första reglage, och den ska vara skolans. Raden är skolans, och sidan läser och skriver den.
-- Ingen rad är förvalen (10, 5, 8, 3, 2), som sidan alltid har börjat med.
--
-- ## Radsäkerhet
--
-- Läsning: skolans administratörer (en lärare frågar aldrig). Skrivning: området Schemaläggning (app.current_user_may('SCHEMALAGGNING', true)),
-- som Generera-körningarna (OptimizationJobs). Ingen radering (raden följer skolan, ON DELETE CASCADE). API-rollen får SELECT, INSERT och UPDATE;
-- PostgREST-rollerna och service_role inget, och PostgreSQL 17:s MAINTAIN är ägarens ensam (som 20270117091000).
--
-- ## Låsen
--
-- Tabellen är ny och ingen begäran rör den förrän API:t som skriver den har driftsatts. Främmande nyckeln till Schools tar SHARE ROW EXCLUSIVE på
-- Schools (en läsare blockeras inte, en skrivare väntar): låset tas NOWAIT i en slinga med tak på 30 s och lock_timeout 5 s
-- (policy-migration-lock-order), så att filen aldrig väntar med ett lås i handen. Filen har en $$-kropp, så Prisma kör den som en transaktion.
--
-- ## Under en driftsättning
--
-- API:t före den här läser ingen profil och skriver ingen: webben före den håller vikterna i webbläsaren, och webben efter den läser
-- skolans. Migreringen körs före merge (DEPLOYMENT §2).

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Schools" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Schools was not free in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

CREATE TABLE "OptimizationProfiles" (
    "schoolId"      UUID NOT NULL,
    "preferredFree" SMALLINT NOT NULL DEFAULT 10,
    "preferredBusy" SMALLINT NOT NULL DEFAULT 5,
    "disruption"    SMALLINT NOT NULL DEFAULT 8,
    "spread"        SMALLINT NOT NULL DEFAULT 3,
    "teacherGap"    SMALLINT NOT NULL DEFAULT 2,
    "updatedAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OptimizationProfiles_pkey" PRIMARY KEY ("schoolId"),
    CONSTRAINT "OptimizationProfiles_weights_are_zero_to_a_thousand" CHECK (
        "preferredFree" BETWEEN 0 AND 1000 AND "preferredBusy" BETWEEN 0 AND 1000 AND "disruption" BETWEEN 0 AND 1000
        AND "spread" BETWEEN 0 AND 1000 AND "teacherGap" BETWEEN 0 AND 1000)
);

ALTER TABLE "OptimizationProfiles"
    ADD CONSTRAINT "OptimizationProfiles_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMENT ON TABLE "OptimizationProfiles" IS
  'P5 (20270313090000): the school''s Generera profile, the five objective weights its sliders set (0..1000, relative). No row is the defaults (10, 5, 8, 3, 2).';

ALTER TABLE "OptimizationProfiles" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    CREATE POLICY "optimization_profiles_admin_select" ON "OptimizationProfiles"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "optimization_profiles_admin_insert" ON "OptimizationProfiles"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('SCHEMALAGGNING', true)));
    CREATE POLICY "optimization_profiles_admin_update" ON "OptimizationProfiles"
        FOR UPDATE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('SCHEMALAGGNING', true)));

    REVOKE ALL ON "OptimizationProfiles" FROM "app_authenticated";
    GRANT SELECT, INSERT, UPDATE ON "OptimizationProfiles" TO "app_authenticated";
  END IF;

  FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "OptimizationProfiles" FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "OptimizationProfiles" FROM "service_role";
  END IF;
  -- PostgreSQL 17's MAINTAIN (REINDEX, CLUSTER, VACUUM, LOCK): the owner's alone.
  IF current_setting('server_version_num')::int >= 170000 THEN
    FOREACH r IN ARRAY ARRAY['authenticated', 'app_authenticated', 'service_role', 'anon'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE MAINTAIN ON "OptimizationProfiles" FROM %I', r);
      END IF;
    END LOOP;
  END IF;
END
$$;
