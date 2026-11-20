-- En sökning efter lärarval är ett jobb med lease: raden i "StaffingSearchRuns".
--
-- ## Vad det är
--
-- Föreslå bemanning kan be motorn söka efter det byte av lärare på skolans släppta poster som gör veckan lättare
-- (lärarval F3, src/optimization/staffing-search*.ts). Sökningen tar minuter (varje värdering är en räkning av årets
-- exakta minsta vecka, 5-9 s, och den gör hundratals), så den kan inte vara ett svar i en dialog: den körs i bakgrunden av
-- den API-process som tog emot begäran, och raden är det som består när processen inte gör det. Ingenting i skolans
-- tjänstefördelning ändras av en sökning; den skriver bara sin egen rad, och ett förslag som den ger tillämpas av
-- Föreslå bemannings egen tillämpning, med dess bas, dess policy och dess bekräftelse.
--
-- ## Samma fyra saker som en Generera-körning och ett schemaförslag har
--
--   "claimedBy"   vilken API-process som kör den, för loggen
--   "heartbeatAt" databasens klocka vid körningens senaste livstecken
--   "leaseUntil"  till när körningen håller läsårets enda plats. Processen förnyar den var halvminut; vid varje förnyelse
--                 är den längst den motoranropet den har ute kan pågå (motorns egen gräns 30 s) och marginal.
--   ett aktivt jobb per läsår, i databasen: det partiella unika indexet StaffingSearchRuns_one_active_per_year (23505,
--   som gatewayn svarar 409 STAFFING_SEARCH_ALREADY_RUNNING)
--   en SWEEP (app.staffing_search_sweep) som misslyckar en körning vars lease gått ut (SEARCH_ABANDONED) och tar bort
--   färdiga körningar som är äldre än ett dygn.
--
-- Den ligger i en egen tabell och inte i OptimizationJobs eller ScheduleCandidateRuns: de har sina egna kolumner (en
-- Generera-körnings lektioner och konflikter, ett schemaförslags kandidater), och OptimizationJobs unika index skulle göra
-- att en sökning hindrade en Generera-körning av läsåret eller tvärtom.
--
-- ## Vad raden bär, och hur länge
--
--   "staffingBasis", "weekBasis"   sha256 av tjänstefördelningen med släppningarna (staffing-proposal.service.ts basisOf)
--                                  och av den vecka sökningen läste (staffing-week.ts weekBasisOf), var för sig, så att en
--                                  vägran kan säga vilken som ändrats. Förslaget som sökningen ger bär deras sammanslagna
--                                  digest (withWeekBasis), och en tillämpning som inte hittar den är 409 STAFF_PROPOSAL_STALE.
--   "options"                      urvalet sökningen frågades med (fästa poster).
--   "figures"                      veckorna före och efter, per år: bara minuter och veckonycklar.
--   "checkpoint"                   de byten som godkänts hittills: {requirementId, fromTeacherId, toTeacherId} och
--                                  räknare. Skrivs efter varje godkänd flytt, så att en körning som tappas bort ändå har sitt
--                                  hittills bästa förslag att visa.
--
-- Bara id:n och tal: inga namn och inga löner. "createdById" har ingen nyckel (som ScheduleCandidateRuns): raden lever ett
-- dygn och ska inte hålla en person kvar. Färdiga och misslyckade rader tas bort av sweepen efter 24 timmar (förslaget är
-- värdelöst efter nästa ändring av tjänstefördelning eller vecka ändå, eftersom basen inte längre håller), aktiva rader aldrig.
--
-- ## Vem som läser och skriver
--
-- Genom gatewayn bara. API-rollen app_authenticated har SELECT, INSERT, UPDATE och DELETE; authenticated och anon har
-- ingenting; service_role har SELECT; ingen har TRUNCATE, REFERENCES, TRIGGER eller, på Postgres 17, MAINTAIN. Varje policy
-- är TO app_authenticated, och som schemaförslagens:
--
--   staffing_search_runs_admin_select   skolans SCHOOL_ADMIN: varje administratör läser.
--   staffing_search_runs_admin_insert   skolans SCHOOL_ADMIN som skriver SCHEMALAGGNING.
--   staffing_search_runs_admin_update   skolans SCHOOL_ADMIN (USING och WITH CHECK frågar inte området: en radlåsning för
--                                       en läsning ska fungera för varje administratör; vad som får ändras avgör gatewayn).
--   staffing_search_runs_admin_delete   skolans SCHOOL_ADMIN som skriver SCHEMALAGGNING.
--
-- Ingen arm för lärare, mentor, vårdnadshavare, elev, anon, authenticated eller servicen. FORCE ROW LEVEL SECURITY är av,
-- som på varje tabell i schemat.
--
-- ## Vid sidan av det levande API:t: varje lås på en gång, eller inget
--
-- Nyckeln tar Schools och AcademicYears i SHARE ROW EXCLUSIVE (skrivningar väntar, läsningar inte). De tas först, NOWAIT och
-- tillsammans: en vägran rullar tillbaka delförloppet och försöker igen 50 ms senare, så att migreringen aldrig väntar på ett
-- lås medan den håller ett annat. Efter 30 s stoppar den utan att ha ändrat något och kan köras om (prisma migrate resolve
-- --rolled-back, sedan deploy).
--
-- BAKÅTKOMPATIBEL I EN VERSION. En ny tabell och en ny funktion som det gamla API:t inte nämner.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Schools" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "AcademicYears" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Schools och AcademicYears var inte lediga på en gång inom 30 s: ingenting är ändrat. Kör prisma migrate resolve --rolled-back 20270227090000_en_sokning_efter_lararval_ar_ett_jobb_med_lease, och sedan deploy igen';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Tabellen.
-- ---------------------------------------------------------------------------

CREATE TYPE "StaffingSearchRunStatus" AS ENUM ('PENDING', 'RUNNING', 'CANCELLING', 'SUCCEEDED', 'CANCELLED', 'FAILED');

CREATE TABLE "StaffingSearchRuns" (
    "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"       UUID NOT NULL,
    "academicYearId" UUID NOT NULL,
    "createdById"    UUID,
    "status"         "StaffingSearchRunStatus" NOT NULL DEFAULT 'PENDING',
    "stopReason"     TEXT,
    "options"        JSONB NOT NULL DEFAULT '{}',
    "staffingBasis"  TEXT NOT NULL,
    "weekBasis"      TEXT NOT NULL,
    "round"          INTEGER NOT NULL DEFAULT 0,
    "evaluations"    INTEGER NOT NULL DEFAULT 0,
    "acceptedMoves"  INTEGER NOT NULL DEFAULT 0,
    "figures"        JSONB,
    "checkpoint"     JSONB,
    "error"          TEXT,
    "errorCode"      TEXT,
    "errorParams"    JSONB,
    "claimedBy"      TEXT,
    "heartbeatAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "leaseUntil"     TIMESTAMPTZ(6) NOT NULL DEFAULT (now() + interval '5 minutes'),
    "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "startedAt"      TIMESTAMPTZ(6),
    "finishedAt"     TIMESTAMPTZ(6),

    CONSTRAINT "StaffingSearchRuns_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StaffingSearchRuns_id_schoolId_key" UNIQUE ("id", "schoolId"),
    CONSTRAINT "StaffingSearchRuns_bases_are_sha256"
        CHECK ("staffingBasis" ~ '^[0-9a-f]{64}$' AND "weekBasis" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "StaffingSearchRuns_counters_are_not_negative"
        CHECK ("round" >= 0 AND "evaluations" >= 0 AND "acceptedMoves" >= 0),
    -- Every accepted move was found in a round of its own.
    CONSTRAINT "StaffingSearchRuns_moves_are_of_the_rounds" CHECK ("acceptedMoves" <= "round"),
    -- Finished exactly when it has a finishing time: an active run is never "done", and a done run is never held.
    CONSTRAINT "StaffingSearchRuns_finished_has_a_time"
        CHECK (("status" IN ('SUCCEEDED', 'CANCELLED', 'FAILED')) = ("finishedAt" IS NOT NULL)),
    -- A failed run says why, by a code the page can word.
    CONSTRAINT "StaffingSearchRuns_failed_has_a_code" CHECK ("status" <> 'FAILED' OR "errorCode" IS NOT NULL),
    -- An open code for why a search stopped (NOT_TIGHT, LOCAL_OPTIMUM, BUDGET, ...), so a new reason needs no migration.
    CONSTRAINT "StaffingSearchRuns_stopReason_is_a_name" CHECK ("stopReason" IS NULL OR "stopReason" ~ '^[A-Z][A-Z0-9_]{0,31}$'),
    CONSTRAINT "StaffingSearchRuns_errorCode_is_a_name" CHECK ("errorCode" IS NULL OR "errorCode" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
    CONSTRAINT "StaffingSearchRuns_error_is_short" CHECK ("error" IS NULL OR char_length("error") <= 2000),
    CONSTRAINT "StaffingSearchRuns_options_is_an_object" CHECK (jsonb_typeof("options") = 'object'),
    CONSTRAINT "StaffingSearchRuns_figures_is_an_object" CHECK ("figures" IS NULL OR jsonb_typeof("figures") = 'object'),
    CONSTRAINT "StaffingSearchRuns_checkpoint_is_an_object" CHECK ("checkpoint" IS NULL OR jsonb_typeof("checkpoint") = 'object'),
    CONSTRAINT "StaffingSearchRuns_lease_follows_the_heartbeat"
        CHECK ("leaseUntil" BETWEEN "heartbeatAt" AND "heartbeatAt" + interval '1 hour'),
    CONSTRAINT "StaffingSearchRuns_claimedBy_is_short" CHECK ("claimedBy" IS NULL OR char_length("claimedBy") BETWEEN 1 AND 100)
);

-- Ett aktivt jobb per läsår.
CREATE UNIQUE INDEX "StaffingSearchRuns_one_active_per_year"
    ON "StaffingSearchRuns"("schoolId", "academicYearId")
    WHERE "status" IN ('PENDING', 'RUNNING', 'CANCELLING');
-- Sidans läsning av läsårets senaste körning, och skolans CASCADE.
CREATE INDEX "StaffingSearchRuns_schoolId_academicYearId_createdAt_idx"
    ON "StaffingSearchRuns"("schoolId", "academicYearId", "createdAt");
-- Sweepens fråga över skolor: vilka färdiga rader är äldre än ett dygn.
CREATE INDEX "StaffingSearchRuns_finishedAt_idx"
    ON "StaffingSearchRuns"("finishedAt") WHERE "finishedAt" IS NOT NULL;

ALTER TABLE "StaffingSearchRuns"
    ADD CONSTRAINT "StaffingSearchRuns_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Läsåret och skolan tillsammans (skolbundna nycklar, 20270115090000): en förälder som flyttar till en annan skola får inte
-- ta barnet med sig.
ALTER TABLE "StaffingSearchRuns"
    ADD CONSTRAINT "StaffingSearchRuns_academicYearId_schoolId_fkey"
    FOREIGN KEY ("academicYearId", "schoolId") REFERENCES "AcademicYears"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE NO ACTION;

COMMENT ON TABLE "StaffingSearchRuns" IS
  'Lärarval F3: en sökning efter det byte av lärare på skolans släppta poster som gör veckan lättare, körd i bakgrunden av en API-process med lease (claimedBy, heartbeatAt, leaseUntil), ett aktivt jobb per läsår. Skriver aldrig skolans tjänstefördelning; ett förslag den ger tillämpas av Föreslå bemannings egen tillämpning. Bara id:n och tal. Färdiga rader tas bort efter 24 timmar av app.staffing_search_sweep().';
COMMENT ON COLUMN "StaffingSearchRuns"."staffingBasis" IS
  'sha256 av tjänstefördelningen med släppningarna när sökningen läste den (basisOf).';
COMMENT ON COLUMN "StaffingSearchRuns"."weekBasis" IS
  'sha256 av den vecka sökningen läste (weekBasisOf); tillsammans med staffingBasis är den förslagets basisSha256 (withWeekBasis).';
COMMENT ON COLUMN "StaffingSearchRuns"."checkpoint" IS
  'De byten som godkänts hittills och räknare; skrivs efter varje godkänd flytt så att en körning som tappas bort har sitt hittills bästa förslag.';
COMMENT ON COLUMN "StaffingSearchRuns"."leaseUntil" IS
  'Till när körningen håller läsårets plats; förnyas av processen var halvminut. Efter den misslyckar sweepen körningen (SEARCH_ABANDONED). Högst en timme efter heartbeatAt (CHECK).';
COMMENT ON COLUMN "StaffingSearchRuns"."createdById" IS
  'Vem som bad om sökningen. Ingen nyckel: raden lever ett dygn och ska inte hålla en person kvar.';

-- ---------------------------------------------------------------------------
-- Radnivåskydd. Se inledningen.
-- ---------------------------------------------------------------------------

ALTER TABLE "StaffingSearchRuns" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    CREATE POLICY "staffing_search_runs_admin_select" ON "StaffingSearchRuns"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "staffing_search_runs_admin_insert" ON "StaffingSearchRuns"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('SCHEMALAGGNING', true)));
    -- USING frågar inte området (avsnitt 106 c): en radlåsning för en läsning ska fungera för varje administratör.
    CREATE POLICY "staffing_search_runs_admin_update" ON "StaffingSearchRuns"
        FOR UPDATE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "staffing_search_runs_admin_delete" ON "StaffingSearchRuns"
        FOR DELETE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
               AND (select app.current_user_may('SCHEMALAGGNING', true)));
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Sweepen
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.staffing_search_sweep() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  abandoned integer;
  removed integer;
BEGIN
  -- Ett jobbens dörr: gatewayns körare och en start anropar den utan någon inloggning alls. Varje inloggning (en person, en
  -- läsare, nyckelslagningen) vägras (vakten i 20270220090000).
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'Sweepen av lärarvalssökningar tar ingen inloggning' USING ERRCODE = 'VO403';
  END IF;

  -- En sökning förnyar sin lease var halvminut och vid varje förnyelse är den längst motoranropet den har ute kan pågå.
  -- Efter den, eller en timme efter att den började, är processen borta, och körningen håller läsårets plats tills den
  -- markeras. Dess hittills bästa förslag (checkpoint) står kvar. En rad som en puls håller just nu hoppas över: den lever.
  WITH stale AS (
    SELECT "id", "leaseUntil" FROM "StaffingSearchRuns"
     WHERE "status" IN ('PENDING', 'RUNNING', 'CANCELLING')
       AND ("leaseUntil" < now() OR "createdAt" < now() - interval '1 hour')
     FOR UPDATE SKIP LOCKED
  )
  UPDATE "StaffingSearchRuns" r
     SET "status" = 'FAILED',
         "error" = 'The search stopped before it finished: the service that ran it was restarted or lost.',
         "errorCode" = 'SEARCH_ABANDONED',
         "errorParams" = NULL,
         "finishedAt" = least(stale."leaseUntil", now())
    FROM stale
   WHERE r."id" = stale."id";
  GET DIAGNOSTICS abandoned = ROW_COUNT;

  -- Färdiga rader efter ett dygn. En aktiv rad (och med den läsårets plats) rörs aldrig här.
  WITH old AS (
    SELECT "id" FROM "StaffingSearchRuns"
     WHERE "finishedAt" IS NOT NULL AND "finishedAt" < now() - interval '24 hours'
     FOR UPDATE SKIP LOCKED
  )
  DELETE FROM "StaffingSearchRuns" r
   USING old
   WHERE r."id" = old."id";
  GET DIAGNOSTICS removed = ROW_COUNT;

  RETURN abandoned + removed;
END
$$;

COMMENT ON FUNCTION app.staffing_search_sweep() IS
  'Lärarval F3 (20270227090000): marks an active search whose lease has run out, or that began more than an hour ago, FAILED (SEARCH_ABANDONED, its checkpoint kept) and deletes finished searches older than 24 hours, skipping rows another transaction holds; returns how many rows it changed. Takes no argument, reads nothing back, and refuses (VO403) a call that carries a login.';

-- ---------------------------------------------------------------------------
-- Rättigheter, vaktade
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  r text;
BEGIN
  -- ALL, så att MAINTAIN på Postgres 17 också går.
  FOREACH r IN ARRAY ARRAY['app_authenticated', 'authenticated', 'anon', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "StaffingSearchRuns" FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION app.staffing_search_sweep() FROM %I', r);
    END IF;
  END LOOP;
  REVOKE ALL ON FUNCTION app.staffing_search_sweep() FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "StaffingSearchRuns" TO "app_authenticated";
    GRANT EXECUTE ON FUNCTION app.staffing_search_sweep() TO "app_authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT ON "StaffingSearchRuns" TO "service_role";
  END IF;
  -- PostgreSQL 17:s MAINTAIN (REINDEX, CLUSTER, VACUUM, LOCK): ägarens ensam.
  IF current_setting('server_version_num')::int >= 170000 THEN
    FOREACH r IN ARRAY ARRAY['authenticated', 'app_authenticated', 'service_role', 'anon'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE MAINTAIN ON "StaffingSearchRuns" FROM %I', r);
      END IF;
    END LOOP;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- SEARCH_RUNS_REACH: de fyra policyerna ovan och ingen annan; ingen för en PostgREST-roll, tjänsten eller synkens principal.
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
   WHERE p.schemaname = 'public' AND p.tablename = 'StaffingSearchRuns'
     AND NOT (p.roles = '{app_authenticated}'::name[]
              AND p.policyname = 'staffing_search_runs_'
                                 || CASE p.cmd WHEN 'SELECT' THEN 'admin_select'
                                               WHEN 'INSERT' THEN 'admin_insert'
                                               WHEN 'UPDATE' THEN 'admin_update'
                                               WHEN 'DELETE' THEN 'admin_delete'
                                               ELSE 'a policy for every command' END);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'SEARCH_RUNS_REACH: dessa policyer når StaffingSearchRuns utöver administratörernas: %', bad;
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'StaffingSearchRuns') <> 4 THEN
    RAISE EXCEPTION 'SEARCH_RUNS_REACH: StaffingSearchRuns har % policyer, inte de fyra ovan',
      (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'StaffingSearchRuns');
  END IF;
END
$$;
