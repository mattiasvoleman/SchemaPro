-- Jobbens övriga dörrar svarar inte en inloggning, och inloggningens egen dörr kräver en.
--
-- ## Vad som fanns
--
-- 37 SECURITY DEFINER-funktioner i app, som API-rollen får köra, är till för det som körs utan inloggning: bakgrundsjobben
-- (frånvarostatistiken, frånvarobevakningen, gallringen, rapporteringsgraden, push och utleverans, skolans export, jobbens
-- bokföring, schemakandidaternas städning) och SS12000-schemaläggaren. Jobben öppnar sin transaktion med withDeliveryService
-- och sätter inga claims; varje inloggning sätter dem. Dörrarna frågade aldrig efter det: de tar ett skol-id eller ett
-- körnings-id som argument och svarar vem som än frågar. Sex andra jobbdörrar fick sin vakt i 20270220090000 (#334, "Dörrvakten");
-- den PR:ens granskning (U-3) och #282:s (U-1) lämnade de här oprövade, och de är gjorda en och en nedan.
--
-- Mätt som app_authenticated med claims för en lärare på en annan skola (en vanlig TEACHER-rad), på riktiga rader, rullat tillbaka:
--
--   app.gallring_begin                     öppnar en gallringskörning för vilken skola som helst, och med körningen
--                                          app.gallring_departed_due listar skolans avgångna personer med Users.id,
--                                          authId och om de har ett eget login att radera. app.gallring_schools listar
--                                          skolorna på nattlistan. gallring_purge och gallring_pseudonymise tar det som
--                                          redan förfallit enligt skolans period, men för vilken skola som helst, när som helst
--                                          (lästa i kroppen, inte körda med plantade rader).
--   app.push_targets                       svarar en användares Expo-push-token, för vilken skola som helst. Den som har
--                                          en token kan skicka notiser till den enheten.
--   app.absence_watch_digest,              svarar e-postadresserna till skolans rektor, administratörer och lärare, och skriver
--   app.reporting_digest,                  de notiser som jobbet annars skriver. school_export_claim svarar den beställande
--   app.reporting_remind,                  administratörens login. De är lästa i kroppen och inte körda med plantade rader.
--   app.school_export_claim
--   övriga                                 räknar, bokför och städar (frånvarostatistik, rapporteringsgrad, jobbens JobRuns och
--                                          JobClaims, schemakandidaternas städning, SS12000-schemaläggaren) för vilken skola som
--                                          helst; deras svar är mindre, men ingen av dem skiljer ett jobb från en inloggning.
--
-- Ingen gatewayväg når någon av dem med en inloggning: alla går genom withDeliveryService (prisma.service.ts, "a transaction
-- with no principal"). Det som skyddar i dag är alltså gatewayn och inte databasen, och det var försvaret på djupet som
-- Dörrvakten tog tillbaka för sex andra dörrar. Ett fel i en route som råkar köra en av dem i en withRls-transaktion, eller en
-- SQL-injektion i en persons begäran, ger i dag tillgång till alla skolors push-tokens, avgångna personers inloggnings-id:n
-- och personalens adresser.
--
-- En dörr är inte ett jobb: app.login_is_held_elsewhere(authId, userId) är personens (en administratörs withRls i
-- users.service.ts), men svarade också en session utan inloggning ett ja eller nej om ett login-id finns hos någon skola.
--
-- ## Vad det blir
--
-- Samma vakt som Dörrvakten och app.ack_remind_request (20270202090000): inga claims (request.jwt.claims) och ingen ensam
-- subjektsinställning (request.jwt.claim.sub). En tom sträng räknas som ingenting, eftersom en poolad anslutning som någon
-- förfrågan har använt läser inställningarna som '' och inte som NULL. Varje dörr nekas en inloggning på det sätt den svarar:
--
--   plpgsql (28 st)    nekar med familjens egen kod, som första sats: AS403 (absence_stats_*), AW403 (absence_watch_*),
--                      GL403 (gallring_*), JR403 (job_claim_nightly, job_run_settled), PU403 (push_*), RR403 (reporting_*),
--                      SC403 (schedule_candidates_sweep) och SS403 (school_export_*, ss12000_*). Koderna är nya per familj,
--                      utom GL403 och AS403 som familjen redan hade (för en annan nekning) och SS403 som SS12000-modulen
--                      och skolans export delar med sina andra vakter. Jobbet ser dem aldrig: det sätter inga claims.
--   LANGUAGE sql (9)   svarar inget: vakten är ett villkor i frågan (absence_watch_digest_due, absence_watch_schools,
--                      delivery_opt_outs, gallring_schools, job_claim_finished, job_runs_latest, push_targets,
--                      reporting_digest_due, reporting_schools). De är kvar LANGUAGE sql, så planen är den samma som förut
--                      (en plpgsql-funktion planeras annorlunda efter fem anrop, och några körs var andra minut).
--   login_is_held_elsewhere
--                      svarar NULL åt en session utan inloggning, och som förut ja eller nej åt en med. Anroparen
--                      (users.service.ts, loginIsHeldElsewhere) räknar redan det som inte är false som "hålls": ett
--                      svar som inte kan ges räknas som hållet, och en inloggning lämnas hellre än att tas bort under en annan skola.
--
-- Tjänsteprincipalerna ensamma (app.service_school_id och app.sync_school_id) släpps in, som i Dörrvakten (dess beslut 5): det
-- är principalens vakt och inte en persons, och ingen gatewayväg kallar dessa dörrar med en principal. En vakt som kräver
-- "ingen principal heller" är en egen ändring.
--
-- ## Vad som inte ändras
--
-- Signaturer, returtyper, flyktighet, SECURITY DEFINER, search_path (och jit = off för app.absence_stats_month) och rättigheterna är
-- desamma: CREATE OR REPLACE behåller ägare och ACL, så GRANT EXECUTE till app_authenticated rörs inte, och det som inte sägs
-- om igen återställs, så LANGUAGE, flyktighet och inställningar är skrivna som förut. De 28 plpgsql-kropparna är de förras med
-- vakten som första sats: tar man bort den är varje kropp byte för byte den gamla (RLS-avsnitt 520 prövar vaktens text i varje
-- dörr). De nio sql-kropparna har villkoret som enda tillägg (absence_watch_schools, job_runs_latest och reporting_schools har
-- fått sin fråga på fler rader för det), och login_is_held_elsewhere blir ett CASE kring samma två EXISTS. Funktionen
-- app.schedule_candidate_runs_active() är inte ändrad: den kallas inuti en persons withRls-transaktion
-- (schedule-candidates.service.ts) och svarar ett tal, så en vakt skulle bryta anropet.
--
-- md5(prosrc) före och efter (före = det main hade när det här skrevs; produktionens bevisas av en skrivskyddad fråga före deploy):
--
--   funktion                    före                               efter
--   absence_stats_month         38e6f66e73a8b1463403a873a9b9ebb4   e3a13cf605064934b74680ace428f329
--   absence_stats_plan          fe4be3f020bc5cafa67cae4e14920904   ee8384fd524d7533932084a5807a5499
--   absence_stats_trim          7c04a5d9d6802015f590c8fd05360033   b56fcdcab451c1efc3dea6261e1e21c6
--   absence_watch_digest        33b7080fd4cbcff036546330291131aa   e2faa250036d1172ed3b46246fb0ade5
--   absence_watch_digest_due    0e2cc7e928e4968be9174bffaf5ff5db   56a3535b7028c910a2ab3cf696362f3f
--   absence_watch_evaluate      6887434156b3653391f048c10e95102e   bce39e38a461202e20e3d5c83fe2cf71
--   absence_watch_schools       ae5df619a12580140917f0eeb1e9780b   0612ff0195d813b026c6c15ab4a0ad2e
--   delivery_opt_outs           afe39140c99747f71d7fa9801389f806   0c0f24e2c8d75f55eb6eab50f7b79ec8
--   gallring_begin              a45f7e98dcc92f5521f246ecd21ca4cb   48c292e57cd0e053ef8e9c3c0745b131
--   gallring_claim_person       544d8c822bcdc0a99b51197597431895   cb6f21244daa3afa0624c01def1a1e28
--   gallring_departed_due       0c416d79e729340fda00835cd02b2248   484b71d8c84069271c45ea62abc84bcc
--   gallring_finish             dac43dd28c3f774bddd131ae0ee3ffb0   7bc85742b38238441be0ee9234857e11
--   gallring_pseudonymise       1f2b20ccf7e10b66c90664c235162a43   d852d535cb86226eb97b068fa3984014
--   gallring_purge              6b5601ad006da9fa3309664e108f4720   2f5e9af613b6dc5ef6ea9ca361c21ee2
--   gallring_schools            678de0508a29750b2b7a0ae39f239ad1   f88b5e2cbec1733626246bc7d4952080
--   job_claim_finished          c0804d8e74853e8dc7e795e2aa185fd6   9ec4e83211895c0beb1c63c77e17d46d
--   job_claim_nightly           59b6040f15120cf6530a4d0269618435   5332d1b162b9d57b3ddb58170dc52047
--   job_run_settled             1b6f7e600d490460f9c3cba19e2d8caf   4121b2299b5154f28aaad8d0095df17c
--   job_runs_latest             599f2227928c6c265b3ea0b88b234001   b67c758ec597e45636829a90c519360d
--   login_is_held_elsewhere     f05324e3800a6efa51583b9c020058e5   5c87ea949eb907503cecab6094cfcf39
--   push_due_receipts           9efa979a7c37d3b45431a54c7b3187a1   c5addc3a80a4f005f88f1e2737fd037e
--   push_receipts_settled       086ae34de0257f0fcfc2aaa33cc872e4   70229119b7e03c03c231477745e371ab
--   push_settle                 1ab3678ea869179159bc3bb1bc5fffde   0e42ecff8947a041cd48e56718376f1a
--   push_targets                65a2256aab3d0a8aba027c1f4a9096d4   b2a027b0d1583e974c08c1e4bd675c7e
--   reporting_compute           9d22e8a75121c9a4f348f4cde6bc1c67   736a4557fc1654d5accd56c340cc4c19
--   reporting_digest            a0d17f4d6d64b9d19afa544e4224887a   51289c0ffb8b3cd4410d5f375c07d7f0
--   reporting_digest_due        e3f650c7a604bd699aa47d4061303a58   9bfdb918471abf398ac35a756f47ac04
--   reporting_remind            08aa2c64014c626fbd98f70e9d82db5d   117b6e6aed8b4dae2b08602d8b915bda
--   reporting_schools           5dc7b516803cd03a04a71bebf29a17d0   bd505c0aab88a4a2db25643067bd7529
--   schedule_candidates_sweep   ea5aeeb4196a86bd5c12a5d0614bffca   3bfd9779243a25d1a6d7d00391f9fd01
--   school_export_claim         d033c18afc4ffe9854476d92ca32ea53   3c79426fd33650a5b341b8446c5797fb
--   school_export_expire        fc0178f3a5649fc4a13d43632fa45e47   15a062b3d4dc53c4454d3777e551f53a
--   school_export_fail          80b05c872c038c2c577a33c9f9cf068a   9457e2025313b0d23521fce72bd0e587
--   school_export_finish        b62862c5f2a2de574ccef7a685a5c07a   6c90611d521d3e02c75c21e7344d5cfc
--   school_export_heartbeat     355710ca6aa22169320f6f8aec9267ee   a54d44f9d7a4258cb88b64bdb8f9a444
--   school_export_put           c8bde3e2a8423f5cd5c281c867d8b90d   609642aa0572751dce7b6eed447b331f
--   ss12000_due_sources         4656df9e139c56f1470035745bb2a998   9495a294971450b17d3f76c2370b1b0c
--   ss12000_housekeeping        3444b63e1af391146fea30892c57a4fd   6ee3a36ae7c4abb8749f43ce5743f6d3
--
-- ## Vad som inte rättas här
--
-- Policyhjälparna som anon kan köra (app.school_grundschema_is_live(uuid), app.school_publish_mode(uuid), app.current_*) rörs inte:
-- policyerna anropar dem, så EXECUTE kan inte tas utan att policyerna slutar gälla, och deras svar är ett läge och ett ja eller
-- nej. De dörrar som en hemlighet i argumentet vaktar (calendar_feed, public_timetable, public_timetable_embed) är oförändrade.
--
-- ## Låsen
--
-- Ingen tabell skrivs eller ändras, så ingen tabell låses mot en läsare eller en skrivare. Varje CREATE OR REPLACE FUNCTION tar
-- ShareUpdateExclusive på funktionens egen rad i pg_proc. De nio LANGUAGE sql-funktionerna och login_is_held_elsewhere kontrolleras
-- dessutom när de skapas och tar då ACCESS SHARE på tabellerna de läser till filens slut: det hindrar bara ett ACCESS EXCLUSIVE
-- (en ALTER TABLE), och ingen begäran tar ett sådant. Lärdomen från #277:s fil (en ADD COLUMN tar ACCESS EXCLUSIVE först i
-- filen och håller det till filens slut) gäller den som lägger en ALTER TABLE här: den ska stå sist, eller ta låset med NOWAIT i
-- en slinga med tak (docs/DEPLOYMENT.md, Kvittens).

-- ---------------------------------------------------------------------------
-- Frånvarostatistik (jobbet, varje natt)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.absence_stats_month(p_school uuid, p_month date, p_as_of date)
 RETURNS TABLE(written integer, removed integer, classes integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET jit TO 'off'
AS $function$
#variable_conflict use_column
DECLARE
  tz text;
  today date;
  shortest integer;
  cut date;
  m_first date := p_month;
  m_next date := (p_month + interval '1 month')::date;
  m_last date;
  k constant integer := app.absence_stats_min_group();
  n_written integer;
  n_removed integer;
  n_classes integer;
BEGIN
  -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person.
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'ABSENCE_STATS_IS_THE_JOBS' USING ERRCODE = 'AS403';
  END IF;
  SELECT s."timezone" INTO tz FROM "Schools" s WHERE s."id" = p_school;
  IF tz IS NULL THEN
    RAISE EXCEPTION 'ABSENCE_STATS_NO_SCHOOL' USING ERRCODE = 'AS404';
  END IF;
  today := (clock_timestamp() AT TIME ZONE tz)::date;
  IF p_as_of IS NULL OR p_as_of >= today THEN
    RAISE EXCEPTION 'ABSENCE_STATS_DAY_IS_NOT_OVER: statistiken räknar till och med en dag som gått'
      USING ERRCODE = 'AS400';
  END IF;
  IF p_month IS NULL OR p_month <> date_trunc('month', p_month::timestamp)::date OR p_month > p_as_of THEN
    RAISE EXCEPTION 'ABSENCE_STATS_BAD_MONTH: en månad är dess första dag, och inte efter dagen som räknas till'
      USING ERRCODE = 'AS400';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('absence-stats:' || p_school::text, 0));

  -- Gallringsskyddet: en månad före den kortaste gallringstid skolan någonsin
  -- valt kan ha tappat markeringar, och räknad igen blir den en månad ingen rapporterade.
  SELECT min(d."months") INTO shortest FROM "RetentionDecisions" d
   WHERE d."schoolId" = p_school AND d."dataType" = 'ATTENDANCE' AND d."decision" = 'PURGE_AFTER';
  cut := app.retention_cutoff(p_school, shortest, clock_timestamp());
  IF cut IS NOT NULL AND m_first < cut THEN
    RETURN QUERY SELECT 0, 0, 0;
    RETURN;
  END IF;
  m_last := least(m_next - 1, p_as_of);

  WITH lessons AS MATERIALIZED (
    SELECT cl."id", cl."date" AS day,
           round(extract(epoch FROM (cl."endsAt" - cl."startsAt")) / 60)::integer AS mins
      FROM "CalendarLessons" cl
     WHERE cl."schoolId" = p_school AND cl."date" BETWEEN m_first AND m_last
       AND cl."status" IN ('SCHEDULED', 'COMPLETED')
  ),
  -- Per elev och dag: minuterna av varje slag, så att markeringarna (en skola
  -- med 2 000 elever har drygt 200 000 en månad) läses en gång.
  daily AS MATERIALIZED (
    SELECT a."studentId" AS student, l.day,
           sum(l.mins)::integer AS recorded,
           sum(CASE WHEN a."status" = 'EXCUSED' THEN l.mins ELSE 0 END)::integer AS valid_mins,
           sum(CASE WHEN a."status" = 'ABSENT' THEN l.mins ELSE 0 END)::integer AS absent_mins,
           sum(CASE WHEN a."status" = 'LATE' THEN least(15, l.mins) ELSE 0 END)::integer AS late_mins,
           (count(*) FILTER (WHERE a."status" = 'LATE'))::integer AS late_n
      FROM lessons l
      JOIN "AttendanceRecords" a ON a."calendarLessonId" = l."id" AND a."schoolId" = p_school
     WHERE a."status" <> 'UNKNOWN'
     GROUP BY a."studentId", l.day
  ),
  -- Klassen eleven hade den dagen: segmentet som täcker datumet, aldrig dagens klasslista.
  with_class AS MATERIALIZED (
    SELECT d.*, c.grp
      FROM daily d
      LEFT JOIN LATERAL (
            SELECT e."studentGroupId" AS grp FROM "StudentEnrollments" e
             WHERE e."studentId" = d.student AND e."schoolId" = p_school
               AND e."validFrom" <= d.day AND (e."validTo" IS NULL OR d.day < e."validTo")
             ORDER BY e."validFrom" DESC LIMIT 1) c ON true
  ),
  enrolled AS (
    SELECT e."studentGroupId" AS grp, count(DISTINCT e."studentId")::integer AS n
      FROM "StudentEnrollments" e
     WHERE e."schoolId" = p_school AND e."studentGroupId" IS NOT NULL
       AND e."validFrom" < m_next AND (e."validTo" IS NULL OR e."validTo" > m_first)
     GROUP BY e."studentGroupId"
  ),
  class_marks AS (
    SELECT w.grp, count(DISTINCT w.student)::integer AS registered,
           sum(w.recorded)::integer AS recorded, sum(w.valid_mins)::integer AS valid_mins,
           sum(w.absent_mins)::integer AS absent_mins, sum(w.late_mins)::integer AS late_mins,
           sum(w.late_n)::integer AS late_n
      FROM with_class w WHERE w.grp IS NOT NULL
     GROUP BY w.grp
  ),
  -- Lektionerna är D2:s (utom att en lärare som slutat räknas för lektionerna som hölls), en gång per lektion.
  rl AS MATERIALIZED (
    SELECT DISTINCT ON (r.lesson_id) r.lesson_id, r.reported
      FROM app.absence_stats_lessons(p_school, m_first, m_last, clock_timestamp()) r
     ORDER BY r.lesson_id
  ),
  -- Lektionens klasser: dess egen grupp och de extra grupperna, slagna upp med sin nyckel (inte en genomläsning av
  -- skolans alla grupper för varje lektion), en halvklass som sin klass, en gång per lektion och klass.
  lesson_classes AS (
    SELECT DISTINCT rl.lesson_id, rl.reported, coalesce(g."halfOfId", g."id") AS cid
      FROM rl
      JOIN "CalendarLessons" cl ON cl."id" = rl.lesson_id
     CROSS JOIN LATERAL (
           SELECT cl."studentGroupId" AS gid
           UNION
           SELECT x."studentGroupId" FROM "CalendarLessonGroups" x WHERE x."calendarLessonId" = cl."id") ids
      JOIN "StudentGroups" g ON g."id" = ids.gid AND g."schoolId" = p_school
                            AND (g."kind" = 'CLASS' OR g."halfOfId" IS NOT NULL)
  ),
  class_lessons AS (
    SELECT lc.cid, count(*)::integer AS held, (count(*) FILTER (WHERE lc.reported))::integer AS reported
      FROM lesson_classes lc GROUP BY lc.cid
  ),
  class_rows AS (
    SELECT en.grp AS class_id, en.n AS pupils,
           coalesce(cm.registered, 0) AS registered,
           CASE WHEN coalesce(cm.registered, 0) >= k THEN cm.recorded END AS recorded,
           CASE WHEN coalesce(cm.registered, 0) >= k THEN cm.valid_mins END AS valid_mins,
           CASE WHEN coalesce(cm.registered, 0) >= k THEN cm.absent_mins END AS absent_mins,
           CASE WHEN coalesce(cm.registered, 0) >= k THEN cm.late_mins END AS late_mins,
           CASE WHEN coalesce(cm.registered, 0) >= k THEN cm.late_n END AS late_n,
           coalesce(cl.held, 0) AS held, coalesce(cl.reported, 0) AS reported
      FROM enrolled en
      LEFT JOIN class_marks cm ON cm.grp = en.grp
      LEFT JOIN class_lessons cl ON cl.cid = en.grp
     WHERE en.n >= k AND (coalesce(cm.registered, 0) > 0 OR coalesce(cl.held, 0) > 0)
  ),
  school_pupils AS (
    SELECT count(*)::integer AS n FROM (
      SELECT d.student FROM daily d
      UNION
      SELECT e."studentId" FROM "StudentEnrollments" e
       WHERE e."schoolId" = p_school AND e."validFrom" < m_next AND (e."validTo" IS NULL OR e."validTo" > m_first)) u
  ),
  school_row AS (
    SELECT sp.n AS pupils,
           (SELECT count(DISTINCT d.student) FROM daily d)::integer AS registered,
           (SELECT sum(d.recorded) FROM daily d)::integer AS recorded,
           (SELECT sum(d.valid_mins) FROM daily d)::integer AS valid_mins,
           (SELECT sum(d.absent_mins) FROM daily d)::integer AS absent_mins,
           (SELECT sum(d.late_mins) FROM daily d)::integer AS late_mins,
           (SELECT sum(d.late_n) FROM daily d)::integer AS late_n,
           (SELECT count(*) FROM rl)::integer AS held,
           (SELECT count(*) FROM rl WHERE rl.reported)::integer AS reported
      FROM school_pupils sp
  ),
  up_class AS (
    INSERT INTO "AbsenceStatsMonths" ("schoolId", "studentGroupId", "month", "throughDay", "pupils", "pupilsRegistered",
                                      "recordedMinutes", "validMinutes", "absentMinutes", "lateMinutes", "lateCount",
                                      "lessonsHeld", "lessonsReported")
    SELECT p_school, c.class_id, m_first, m_last, c.pupils, c.registered,
           c.recorded, c.valid_mins, c.absent_mins, c.late_mins, c.late_n, c.held, c.reported
      FROM class_rows c
    ON CONFLICT ("schoolId", "studentGroupId", "month") WHERE "studentGroupId" IS NOT NULL DO UPDATE
       SET "throughDay" = EXCLUDED."throughDay", "pupils" = EXCLUDED."pupils", "pupilsRegistered" = EXCLUDED."pupilsRegistered",
           "recordedMinutes" = EXCLUDED."recordedMinutes", "validMinutes" = EXCLUDED."validMinutes",
           "absentMinutes" = EXCLUDED."absentMinutes", "lateMinutes" = EXCLUDED."lateMinutes", "lateCount" = EXCLUDED."lateCount",
           "lessonsHeld" = EXCLUDED."lessonsHeld", "lessonsReported" = EXCLUDED."lessonsReported", "computedAt" = clock_timestamp()
     WHERE ("AbsenceStatsMonths"."throughDay", "AbsenceStatsMonths"."pupils", "AbsenceStatsMonths"."pupilsRegistered",
            "AbsenceStatsMonths"."recordedMinutes", "AbsenceStatsMonths"."validMinutes", "AbsenceStatsMonths"."absentMinutes",
            "AbsenceStatsMonths"."lateMinutes", "AbsenceStatsMonths"."lateCount",
            "AbsenceStatsMonths"."lessonsHeld", "AbsenceStatsMonths"."lessonsReported")
           IS DISTINCT FROM
           (EXCLUDED."throughDay", EXCLUDED."pupils", EXCLUDED."pupilsRegistered",
            EXCLUDED."recordedMinutes", EXCLUDED."validMinutes", EXCLUDED."absentMinutes",
            EXCLUDED."lateMinutes", EXCLUDED."lateCount", EXCLUDED."lessonsHeld", EXCLUDED."lessonsReported")
    RETURNING 1
  ),
  up_school AS (
    INSERT INTO "AbsenceStatsMonths" ("schoolId", "studentGroupId", "month", "throughDay", "pupils", "pupilsRegistered",
                                      "recordedMinutes", "validMinutes", "absentMinutes", "lateMinutes", "lateCount",
                                      "lessonsHeld", "lessonsReported")
    SELECT p_school, NULL, m_first, m_last, s.pupils, s.registered,
           CASE WHEN s.registered >= k THEN coalesce(s.recorded, 0) END,
           CASE WHEN s.registered >= k THEN coalesce(s.valid_mins, 0) END,
           CASE WHEN s.registered >= k THEN coalesce(s.absent_mins, 0) END,
           CASE WHEN s.registered >= k THEN coalesce(s.late_mins, 0) END,
           CASE WHEN s.registered >= k THEN coalesce(s.late_n, 0) END,
           s.held, s.reported
      FROM school_row s
     WHERE s.pupils >= k
    ON CONFLICT ("schoolId", "month") WHERE "studentGroupId" IS NULL DO UPDATE
       SET "throughDay" = EXCLUDED."throughDay", "pupils" = EXCLUDED."pupils", "pupilsRegistered" = EXCLUDED."pupilsRegistered",
           "recordedMinutes" = EXCLUDED."recordedMinutes", "validMinutes" = EXCLUDED."validMinutes",
           "absentMinutes" = EXCLUDED."absentMinutes", "lateMinutes" = EXCLUDED."lateMinutes", "lateCount" = EXCLUDED."lateCount",
           "lessonsHeld" = EXCLUDED."lessonsHeld", "lessonsReported" = EXCLUDED."lessonsReported", "computedAt" = clock_timestamp()
     WHERE ("AbsenceStatsMonths"."throughDay", "AbsenceStatsMonths"."pupils", "AbsenceStatsMonths"."pupilsRegistered",
            "AbsenceStatsMonths"."recordedMinutes", "AbsenceStatsMonths"."validMinutes", "AbsenceStatsMonths"."absentMinutes",
            "AbsenceStatsMonths"."lateMinutes", "AbsenceStatsMonths"."lateCount",
            "AbsenceStatsMonths"."lessonsHeld", "AbsenceStatsMonths"."lessonsReported")
           IS DISTINCT FROM
           (EXCLUDED."throughDay", EXCLUDED."pupils", EXCLUDED."pupilsRegistered",
            EXCLUDED."recordedMinutes", EXCLUDED."validMinutes", EXCLUDED."absentMinutes",
            EXCLUDED."lateMinutes", EXCLUDED."lateCount", EXCLUDED."lessonsHeld", EXCLUDED."lessonsReported")
    RETURNING 1
  ),
  gone AS (
    DELETE FROM "AbsenceStatsMonths" s
     WHERE s."schoolId" = p_school AND s."month" = m_first
       AND ((s."studentGroupId" IS NULL AND NOT EXISTS (SELECT 1 FROM school_row r WHERE r.pupils >= k))
            OR (s."studentGroupId" IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM class_rows c WHERE c.class_id = s."studentGroupId")))
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM up_class)::integer + (SELECT count(*) FROM up_school)::integer,
         (SELECT count(*) FROM gone)::integer,
         (SELECT count(*) FROM class_rows)::integer
    INTO n_written, n_removed, n_classes;

  RETURN QUERY SELECT n_written, n_removed, n_classes;
END
$function$;

CREATE OR REPLACE FUNCTION app.absence_stats_plan(p_school uuid, p_as_of date, p_backfill integer DEFAULT 3)
 RETURNS TABLE(month date)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  tz text;
  today date;
  shortest integer;
  cut date;
  first_month date;
  recent_first date;
BEGIN
  -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person.
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'ABSENCE_STATS_IS_THE_JOBS' USING ERRCODE = 'AS403';
  END IF;
  SELECT s."timezone" INTO tz FROM "Schools" s WHERE s."id" = p_school;
  IF tz IS NULL THEN
    RAISE EXCEPTION 'ABSENCE_STATS_NO_SCHOOL' USING ERRCODE = 'AS404';
  END IF;
  today := (clock_timestamp() AT TIME ZONE tz)::date;
  IF p_as_of IS NULL OR p_as_of >= today THEN
    RAISE EXCEPTION 'ABSENCE_STATS_DAY_IS_NOT_OVER: statistiken räknar till och med en dag som gått'
      USING ERRCODE = 'AS400';
  END IF;
  SELECT min(d."months") INTO shortest FROM "RetentionDecisions" d
   WHERE d."schoolId" = p_school AND d."dataType" = 'ATTENDANCE' AND d."decision" = 'PURGE_AFTER';
  cut := app.retention_cutoff(p_school, shortest, clock_timestamp());
  first_month := coalesce(app.absence_stats_window_first(p_school, p_as_of),
                          date_trunc('month', p_as_of - interval '36 months')::date);
  recent_first := greatest(first_month, date_trunc('month', (p_as_of - 61)::timestamp)::date);
  RETURN QUERY
  WITH months AS (
    SELECT g.m::date AS m
      FROM generate_series(first_month::timestamp, date_trunc('month', p_as_of::timestamp), interval '1 month') g(m)
     WHERE cut IS NULL OR g.m::date >= cut
  ),
  missing AS (
    SELECT x.m FROM months x
     WHERE x.m < recent_first
       AND NOT EXISTS (SELECT 1 FROM "AbsenceStatsMonths" s
                        WHERE s."schoolId" = p_school AND s."studentGroupId" IS NULL AND s."month" = x.m)
       AND EXISTS (SELECT 1 FROM "CalendarLessons" cl
                    WHERE cl."schoolId" = p_school AND cl."date" >= x.m AND cl."date" < (x.m + interval '1 month')::date
                      AND cl."status" IN ('SCHEDULED', 'COMPLETED'))
       AND (SELECT count(*) FROM (SELECT DISTINCT e."studentId" FROM "StudentEnrollments" e
                                   WHERE e."schoolId" = p_school AND e."validFrom" < (x.m + interval '1 month')::date
                                     AND (e."validTo" IS NULL OR e."validTo" > x.m)
                                   LIMIT app.absence_stats_min_group()) q) >= app.absence_stats_min_group()
     ORDER BY x.m DESC
     LIMIT greatest(p_backfill, 0)
  ),
  chosen AS (
    SELECT x.m, 0 AS pass FROM months x WHERE x.m >= recent_first
    UNION ALL
    SELECT y.m, 1 FROM missing y
  )
  SELECT c.m FROM chosen c ORDER BY c.pass, c.m DESC;
END
$function$;

CREATE OR REPLACE FUNCTION app.absence_stats_trim(p_school uuid, p_as_of date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  tz text;
  today date;
  first_month date;
  n integer;
BEGIN
  -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person.
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'ABSENCE_STATS_IS_THE_JOBS' USING ERRCODE = 'AS403';
  END IF;
  SELECT s."timezone" INTO tz FROM "Schools" s WHERE s."id" = p_school;
  IF tz IS NULL THEN
    RAISE EXCEPTION 'ABSENCE_STATS_NO_SCHOOL' USING ERRCODE = 'AS404';
  END IF;
  today := (clock_timestamp() AT TIME ZONE tz)::date;
  IF p_as_of IS NULL OR p_as_of >= today THEN
    RAISE EXCEPTION 'ABSENCE_STATS_DAY_IS_NOT_OVER: statistiken räknar till och med en dag som gått'
      USING ERRCODE = 'AS400';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('absence-stats:' || p_school::text, 0));
  first_month := coalesce(app.absence_stats_window_first(p_school, p_as_of),
                          date_trunc('month', p_as_of - interval '36 months')::date);
  DELETE FROM "AbsenceStatsMonths" s WHERE s."schoolId" = p_school AND s."month" < first_month;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$function$;

-- ---------------------------------------------------------------------------
-- Frånvarobevakning (jobbet, varje natt)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.absence_watch_digest(p_school uuid, p_group "AbsenceWatchGroup", p_start date, p_end date, p_on date)
 RETURNS TABLE(notification_id uuid, user_id uuid, email text, meta jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
BEGIN
  -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person.
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'ABSENCE_WATCH_IS_THE_JOBS' USING ERRCODE = 'AW403';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('absence-watch:' || p_school::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('absence-watch-digest:' || p_school::text || ':' || p_group::text, 0));
  PERFORM 1 FROM "AbsenceWatchSettings" s WHERE s."schoolId" = p_school AND s."enabled" FOR SHARE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  RETURN QUERY
  WITH plan AS MATERIALIZED (
    SELECT * FROM app.absence_watch_digest_plan(p_school, p_group, p_start, p_end, p_on)
  ),
  ledger AS (
    INSERT INTO "AbsenceWatchDigests" ("schoolId", "recipientGroup", "periodStart", "periodEnd", "recipients", "pupils")
    SELECT p_school, p_group, p_start, p_end,
           (SELECT count(*) FROM plan)::integer,
           (SELECT count(DISTINCT pupil) FROM plan p, LATERAL unnest(p.student_ids) AS pupil)::integer
    ON CONFLICT ("schoolId", "recipientGroup", "periodEnd") DO NOTHING
    RETURNING 1
  ),
  -- As personal_data_read does, it leaves out the reader and whoever the reader has of the
  -- kind from the last quarter-hour, and keeps the read's whole size.
  logged AS (
    INSERT INTO "PersonalDataAccess" ("schoolId", "actorId", "actorRole", "channel", "kind", "subjectIds", "readSize")
    SELECT p_school, p.user_id, u."role", 'OTHER', 'ATTENDANCE', fresh.ids, cardinality(p.student_ids)
      FROM plan p
      JOIN "Users" u ON u."id" = p.user_id AND u."schoolId" = p_school
     CROSS JOIN LATERAL (
           SELECT coalesce(array_agg(pupil ORDER BY pupil), '{}'::uuid[]) AS ids
             FROM unnest(p.student_ids) AS pupil
            WHERE pupil <> p.user_id
              AND NOT EXISTS (
                    SELECT 1 FROM "PersonalDataAccess" a
                     WHERE a."actorId" = p.user_id AND a."kind" = 'ATTENDANCE'
                       AND a."at" > clock_timestamp() - interval '15 minutes'
                       AND a."channel" <> 'CALENDAR' AND pupil = ANY (a."subjectIds"))
           ) fresh
     WHERE EXISTS (SELECT 1 FROM ledger) AND cardinality(fresh.ids) > 0
    RETURNING 1
  ),
  written AS (
    INSERT INTO "Notifications" ("schoolId", "userId", "type", "meta")
    SELECT p_school, p.user_id, 'ABSENCE_WATCH_DIGEST',
           jsonb_build_object('group', p_group::text, 'periodStart', p_start, 'periodEnd', p_end,
                              'open', p.open_n, 'crossed', p.crossed_n)
      FROM plan p
     WHERE EXISTS (SELECT 1 FROM ledger)
    RETURNING "id", "userId", "meta"
  )
  SELECT w."id", w."userId", pl.email, w."meta"
    FROM written w JOIN plan pl ON pl.user_id = w."userId";
END
$function$;

CREATE OR REPLACE FUNCTION app.absence_watch_digest_due(p_school uuid, p_today date)
 RETURNS TABLE(recipient_group "AbsenceWatchGroup", period_start date, period_end date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT g.grp, per.start_day, e.end_day
    FROM "AbsenceWatchSettings" s
   CROSS JOIN LATERAL (VALUES ('MENTOR'::"AbsenceWatchGroup", s."mentorCadence"),
                              ('REKTOR'::"AbsenceWatchGroup", s."rektorCadence"),
                              ('KANSLI'::"AbsenceWatchGroup", s."kansliCadence"),
                              ('GUARDIAN'::"AbsenceWatchGroup", s."guardianCadence")) AS g(grp, cadence)
   CROSS JOIN LATERAL (SELECT CASE g.cadence
                                WHEN 'WEEKLY' THEN p_today - extract(isodow FROM p_today)::integer
                                ELSE (date_trunc('month', p_today)::date - 1)
                              END AS end_day) AS e
   CROSS JOIN LATERAL (SELECT CASE g.cadence
                                WHEN 'WEEKLY' THEN e.end_day - 6
                                ELSE date_trunc('month', e.end_day)::date
                              END AS start_day) AS per
   WHERE s."schoolId" = p_school AND s."enabled" AND s."enabledOn" IS NOT NULL
     -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person: den får inga perioder.
     AND nullif(current_setting('request.jwt.claims', true), '') IS NULL
     AND nullif(current_setting('request.jwt.claim.sub', true), '') IS NULL
     AND e.end_day >= s."enabledOn"
     AND EXISTS (SELECT 1 FROM "AbsenceWatchLimits" l WHERE l."schoolId" = p_school AND l."recipientGroup" = g.grp)
     AND NOT EXISTS (SELECT 1 FROM "AbsenceWatchDigests" d
                      WHERE d."schoolId" = p_school AND d."recipientGroup" = g.grp AND d."periodEnd" = e.end_day)
   ORDER BY g.grp
$function$;

CREATE OR REPLACE FUNCTION app.absence_watch_evaluate(p_school uuid, p_as_of date)
 RETURNS TABLE(opened integer, kept integer, closed integer, pupils integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  tz text;
  today date;
  lookback integer;
  first_day date;
  n_opened integer;
  n_kept integer;
  n_closed integer;
  n_pupils integer;
BEGIN
  -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person.
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'ABSENCE_WATCH_IS_THE_JOBS' USING ERRCODE = 'AW403';
  END IF;
  SELECT s."timezone" INTO tz FROM "Schools" s WHERE s."id" = p_school;
  IF tz IS NULL THEN
    RAISE EXCEPTION 'ABSENCE_WATCH_NO_SCHOOL' USING ERRCODE = 'AW404';
  END IF;
  today := (clock_timestamp() AT TIME ZONE tz)::date;
  IF p_as_of IS NULL OR p_as_of >= today THEN
    RAISE EXCEPTION 'ABSENCE_WATCH_DAY_IS_NOT_OVER: bevakningen räknar till och med en dag som gått'
      USING ERRCODE = 'AW400';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('absence-watch:' || p_school::text, 0));

  -- FOR SHARE: turning the switch off waits for a count in progress, and its trigger then
  -- closes what the count wrote; a count that starts after it finds it off.
  PERFORM 1 FROM "AbsenceWatchSettings" s WHERE s."schoolId" = p_school AND s."enabled" FOR SHARE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 0, 0, 0, 0;
    RETURN;
  END IF;

  SELECT greatest(
           coalesce(max(l."windowDays") FILTER (WHERE l."kind" = 'SHARE'), 0),
           CASE WHEN bool_or(l."kind" = 'CONSECUTIVE') THEN 90 ELSE 0 END)
    INTO lookback
    FROM "AbsenceWatchLimits" l WHERE l."schoolId" = p_school;
  first_day := p_as_of - (lookback - 1);

  WITH cfg AS (
    SELECT l.* FROM "AbsenceWatchLimits" l WHERE l."schoolId" = p_school
  ),
  -- The registered lessons that were held, per active pupil: the one scan.
  marks AS (
    SELECT a."studentId" AS student, cl."date" AS day, a."status" AS status,
           round(extract(epoch FROM (cl."endsAt" - cl."startsAt")) / 60)::integer AS mins
      FROM "CalendarLessons" cl
      JOIN "AttendanceRecords" a ON a."calendarLessonId" = cl."id"
      JOIN "Users" u ON u."id" = a."studentId" AND u."schoolId" = p_school
                    AND u."isActive" AND u."role" = 'STUDENT'
     WHERE cl."schoolId" = p_school
       AND cl."date" BETWEEN first_day AND p_as_of
       AND cl."status" IN ('SCHEDULED', 'COMPLETED')
       AND a."status" <> 'UNKNOWN'
  ),
  -- One row per pupil and day with the minutes of each kind and whether every
  -- registered lesson that day was of one kind: what both kinds of limit are
  -- counted from, so the marks (170 000 in a school of 500 over 90 days) are
  -- read once and the limits work on 30 times fewer rows.
  daily AS (
    SELECT m.student, m.day,
           sum(m.mins)::integer AS recorded,
           sum(CASE WHEN m.status = 'EXCUSED' THEN m.mins ELSE 0 END)::integer AS valid_mins,
           sum(CASE m.status WHEN 'ABSENT' THEN m.mins WHEN 'LATE' THEN least(15, m.mins) ELSE 0 END)::integer AS invalid_mins,
           bool_and(m.status = 'EXCUSED') AS all_excused,
           bool_and(m.status = 'ABSENT') AS all_absent,
           bool_and(m.status IN ('EXCUSED', 'ABSENT')) AS all_away
      FROM marks m
     GROUP BY m.student, m.day
  ),
  share AS (
    SELECT t.limit_id, t.student, t.recorded, t.absent
      FROM (SELECT c."id" AS limit_id, c."percent", d.student,
                   max(d.day) AS last_day,
                   sum(d.recorded)::integer AS recorded,
                   sum(CASE c."basis" WHEN 'VALID' THEN d.valid_mins WHEN 'INVALID' THEN d.invalid_mins
                                      ELSE d.valid_mins + d.invalid_mins END)::integer AS absent
              FROM cfg c
              JOIN daily d ON c."kind" = 'SHARE' AND d.day > p_as_of - c."windowDays"
             GROUP BY c."id", c."percent", d.student) t
     -- Absence that is going on: the pupil's latest registered day is at most a week old, as a
     -- run's is, so a pupil who was over a limit when term ended is not still over it in July.
     WHERE t.recorded > 0 AND t.absent * 100 >= t."percent" * t.recorded AND t.last_day >= p_as_of - 7
  ),
  -- A day is absence when every registered lesson that day is.
  days AS (
    SELECT c."id" AS limit_id, d.student, d.day,
           CASE c."basis" WHEN 'VALID' THEN d.all_excused WHEN 'INVALID' THEN d.all_absent ELSE d.all_away END AS absent_day
      FROM cfg c
      JOIN daily d ON c."kind" = 'CONSECUTIVE'
  ),
  ranked AS (
    SELECT d.limit_id, d.student, d.day, d.absent_day,
           row_number() OVER (PARTITION BY d.limit_id, d.student ORDER BY d.day DESC) AS rn,
           max(d.day) OVER (PARTITION BY d.limit_id, d.student) AS last_day
      FROM days d
  ),
  -- The run of absence days at the end of the pupil's registered days.
  streaks AS (
    SELECT r.limit_id, r.student,
           coalesce(min(r.rn) FILTER (WHERE NOT r.absent_day) - 1, count(*))::integer AS len,
           max(r.last_day) AS last_day
      FROM ranked r
     GROUP BY r.limit_id, r.student
  ),
  -- The day the run reached the limit is a row of ranked: a join, because a subquery
  -- per pupil over a limit reads all of ranked each time (an influenza wave, with
  -- hundreds of hits and a hundred thousand rows, took the count past its 9 s).
  consecutive AS (
    SELECT s.limit_id, s.student, s.len, r2.day AS reached_on
      FROM streaks s
      JOIN cfg c ON c."id" = s.limit_id
      JOIN ranked r2 ON r2.limit_id = s.limit_id AND r2.student = s.student AND r2.rn = s.len - c."consecutiveDays" + 1
     WHERE s.len >= c."consecutiveDays" AND s.last_day >= p_as_of - 7
  ),
  hits AS (
    SELECT sh.limit_id, sh.student, sh.recorded, sh.absent, NULL::integer AS streak, p_as_of AS crossed_on
      FROM share sh
    UNION ALL
    SELECT co.limit_id, co.student, NULL::integer, NULL::integer, co.len, co.reached_on
      FROM consecutive co
  ),
  upd AS (
    UPDATE "AbsenceWatchFindings" f
       SET "lastSeenOn" = greatest(f."lastSeenOn", p_as_of),
           "recipientGroup" = c."recipientGroup", "kind" = c."kind", "basis" = c."basis",
           "percent" = c."percent", "windowDays" = c."windowDays", "consecutiveDays" = c."consecutiveDays",
           "absentMinutes" = h.absent, "recordedMinutes" = h.recorded, "streakDays" = h.streak
      FROM hits h JOIN cfg c ON c."id" = h.limit_id
     WHERE f."schoolId" = p_school AND f."clearedOn" IS NULL
       AND f."limitId" = h.limit_id AND f."studentId" = h.student
    RETURNING f."limitId", f."studentId"
  ),
  clr AS (
    UPDATE "AbsenceWatchFindings" f
       SET "clearedOn" = greatest(p_as_of, f."lastSeenOn")
     WHERE f."schoolId" = p_school AND f."clearedOn" IS NULL
       AND NOT EXISTS (SELECT 1 FROM hits h WHERE h.limit_id = f."limitId" AND h.student = f."studentId")
    RETURNING 1
  ),
  ins AS (
    INSERT INTO "AbsenceWatchFindings" ("schoolId", "studentId", "limitId", "recipientGroup", "kind", "basis",
                                        "percent", "windowDays", "consecutiveDays",
                                        "firstCrossedOn", "lastSeenOn", "absentMinutes", "recordedMinutes", "streakDays")
    SELECT p_school, h.student, h.limit_id, c."recipientGroup", c."kind", c."basis",
           c."percent", c."windowDays", c."consecutiveDays",
           h.crossed_on, p_as_of, h.absent, h.recorded, h.streak
      FROM hits h JOIN cfg c ON c."id" = h.limit_id
     WHERE NOT EXISTS (SELECT 1 FROM upd u WHERE u."limitId" = h.limit_id AND u."studentId" = h.student)
    ON CONFLICT ("limitId", "studentId") WHERE "clearedOn" IS NULL DO NOTHING
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM ins)::integer,
         (SELECT count(*) FROM upd)::integer,
         (SELECT count(*) FROM clr)::integer,
         (SELECT count(DISTINCT student) FROM daily)::integer
    INTO n_opened, n_kept, n_closed, n_pupils;

  RETURN QUERY SELECT n_opened, n_kept, n_closed, n_pupils;
END
$function$;

CREATE OR REPLACE FUNCTION app.absence_watch_schools()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT s."schoolId" FROM "AbsenceWatchSettings" s
   WHERE s."enabled"
     -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person: den får ingen skola.
     AND nullif(current_setting('request.jwt.claims', true), '') IS NULL
     AND nullif(current_setting('request.jwt.claim.sub', true), '') IS NULL
   ORDER BY s."schoolId"
$function$;

-- ---------------------------------------------------------------------------
-- Gallring (jobbet, varje natt)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.gallring_begin(p_school uuid, p_at timestamp with time zone)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_kind "RetentionDataType";
  v_months integer;
  v_periods jsonb := '{}';
  v_cutoffs jsonb := '{}';
  v_run uuid;
BEGIN
  -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person.
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'GALLRING_IS_THE_JOBS' USING ERRCODE = 'GL403';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Schools" s WHERE s."id" = p_school) THEN
    RAISE EXCEPTION 'GALLRING_NO_SCHOOL' USING ERRCODE = 'GL404';
  END IF;
  -- A run is tonight's: a time far from now would read another day's
  -- decisions, and a later one would step past the 24-hour wait.
  IF p_at NOT BETWEEN clock_timestamp() - interval '10 minutes' AND clock_timestamp() + interval '10 minutes' THEN
    RAISE EXCEPTION 'GALLRING_RUN_IS_NOW' USING ERRCODE = 'GL400';
  END IF;
  UPDATE "GallringRuns" SET "status" = 'INTERRUPTED', "finishedAt" = p_at
   WHERE "schoolId" = p_school AND "status" = 'RUNNING';
  FOREACH v_kind IN ARRAY enum_range(NULL::"RetentionDataType") LOOP
    v_months := app.retention_months_in_force(p_school, v_kind, p_at);
    IF v_months IS NOT NULL THEN
      v_periods := v_periods || jsonb_build_object(v_kind::text, v_months);
      v_cutoffs := v_cutoffs || jsonb_build_object(v_kind::text, app.retention_cutoff(p_school, v_months, p_at)::text);
    END IF;
  END LOOP;
  INSERT INTO "GallringRuns" ("schoolId", "localDay", "startedAt", "periods", "cutoffs")
  VALUES (p_school, app.gallring_today(p_school, p_at), p_at, v_periods, v_cutoffs)
  RETURNING "id" INTO v_run;
  RETURN v_run;
END
$function$;

CREATE OR REPLACE FUNCTION app.gallring_claim_person(p_run uuid, p_user uuid)
 RETURNS TABLE(auth_id uuid, invited boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r "GallringRuns";
  cutoff date;
  today date;
BEGIN
  -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person.
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'GALLRING_IS_THE_JOBS' USING ERRCODE = 'GL403';
  END IF;
  SELECT * INTO r FROM "GallringRuns" WHERE "id" = p_run AND "status" = 'RUNNING' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GALLRING_RUN_NOT_RUNNING' USING ERRCODE = 'GL404';
  END IF;
  -- The lock comes first: a reactivation in flight is waited for, one that
  -- comes later waits for this transaction, and every statement below reads
  -- after the wait (read committed: a new snapshot per statement).
  PERFORM 1 FROM "Users" u WHERE u."id" = p_user AND u."schoolId" = r."schoolId" FOR NO KEY UPDATE;
  IF NOT FOUND
     OR r."cutoffs" ->> 'DEPARTED_PEOPLE' IS NULL
     OR app.retention_months_in_force(r."schoolId", 'DEPARTED_PEOPLE', clock_timestamp()) IS NULL THEN
    RETURN;
  END IF;
  -- In variables, as in the run's other functions, so app.gallring_due is
  -- inlined and looks the one person up by id.
  cutoff := app.gallring_run_cutoff(r."schoolId", r."startedAt", r."cutoffs", 'DEPARTED_PEOPLE');
  today := app.gallring_today(r."schoolId", r."startedAt");
  RETURN QUERY
  SELECT u."authId",
         u."invitedAt" IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM "Users" o WHERE o."authId" = u."authId" AND o."id" <> u."id")
         AND NOT EXISTS (SELECT 1 FROM "HuvudmanMembers" hm WHERE hm."authId" = u."authId")
    FROM app.gallring_due(r."schoolId", 'DEPARTED_PEOPLE', cutoff, today) d
    JOIN "Users" u ON u."id" = d."id"
   WHERE d."id" = p_user;
END
$function$;

CREATE OR REPLACE FUNCTION app.gallring_departed_due(p_run uuid, p_limit integer)
 RETURNS TABLE(user_id uuid, auth_id uuid, invited boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r "GallringRuns";
  cutoff date;
  today date;
BEGIN
  -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person.
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'GALLRING_IS_THE_JOBS' USING ERRCODE = 'GL403';
  END IF;
  SELECT * INTO r FROM "GallringRuns" WHERE "id" = p_run AND "status" = 'RUNNING' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GALLRING_RUN_NOT_RUNNING' USING ERRCODE = 'GL404';
  END IF;
  IF r."cutoffs" ->> 'DEPARTED_PEOPLE' IS NULL
     OR app.retention_months_in_force(r."schoolId", 'DEPARTED_PEOPLE', clock_timestamp()) IS NULL THEN
    RETURN;
  END IF;
  cutoff := app.gallring_run_cutoff(r."schoolId", r."startedAt", r."cutoffs", 'DEPARTED_PEOPLE');
  today := app.gallring_today(r."schoolId", r."startedAt");
  UPDATE "GallringRuns" SET
    "waiting" = "waiting" || jsonb_build_object('DEPARTED_PEOPLE_SCB', app.gallring_held(r."schoolId", cutoff, today))
   WHERE "id" = p_run;
  RETURN QUERY
  SELECT u."id", u."authId", u."invitedAt" IS NOT NULL
    FROM app.gallring_due(r."schoolId", 'DEPARTED_PEOPLE', cutoff, today) d
    JOIN "Users" u ON u."id" = d."id"
   ORDER BY u."deactivatedAt", u."id"
   LIMIT greatest(least(p_limit, 500), 0);
END
$function$;

CREATE OR REPLACE FUNCTION app.gallring_finish(p_run uuid, p_waiting jsonb, p_at timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r "GallringRuns";
  left_people bigint;
BEGIN
  -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person.
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'GALLRING_IS_THE_JOBS' USING ERRCODE = 'GL403';
  END IF;
  SELECT * INTO r FROM "GallringRuns" WHERE "id" = p_run AND "status" = 'RUNNING' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GALLRING_RUN_NOT_RUNNING' USING ERRCODE = 'GL404';
  END IF;
  -- People: complete when nobody past the cutoff is left but those held.
  IF r."cutoffs" ? 'DEPARTED_PEOPLE' THEN
    SELECT count(*) INTO left_people
      FROM app.gallring_due(r."schoolId", 'DEPARTED_PEOPLE', (r."cutoffs" ->> 'DEPARTED_PEOPLE')::date,
                            app.gallring_today(r."schoolId", r."startedAt"));
    r."complete" := r."complete" || jsonb_build_object('DEPARTED_PEOPLE', left_people = 0);
  END IF;
  UPDATE "GallringRuns" SET
    "status" = 'DONE', "finishedAt" = p_at,
    "complete" = r."complete",
    "waiting" = "waiting" || COALESCE(p_waiting, '{}'::jsonb)
   WHERE "id" = p_run;
END
$function$;

CREATE OR REPLACE FUNCTION app.gallring_pseudonymise(p_run uuid, p_users uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r "GallringRuns";
  cutoff date;
  today date;
  due uuid[];
  n integer;
BEGIN
  -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person.
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'GALLRING_IS_THE_JOBS' USING ERRCODE = 'GL403';
  END IF;
  SELECT * INTO r FROM "GallringRuns" WHERE "id" = p_run AND "status" = 'RUNNING' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GALLRING_RUN_NOT_RUNNING' USING ERRCODE = 'GL404';
  END IF;
  -- The rows before the question: a reactivation in flight is waited for,
  -- one that comes later waits for this transaction, and every statement
  -- below reads after the wait. Id order, so two callers cannot deadlock.
  PERFORM 1 FROM "Users" u
   WHERE u."schoolId" = r."schoolId" AND u."id" = ANY (p_users)
   ORDER BY u."id"
     FOR NO KEY UPDATE;
  IF r."cutoffs" ->> 'DEPARTED_PEOPLE' IS NULL
     OR app.retention_months_in_force(r."schoolId", 'DEPARTED_PEOPLE', clock_timestamp()) IS NULL THEN
    RETURN 0;
  END IF;
  cutoff := app.gallring_run_cutoff(r."schoolId", r."startedAt", r."cutoffs", 'DEPARTED_PEOPLE');
  today := app.gallring_today(r."schoolId", r."startedAt");
  -- Asked again: somebody reactivated since the list was read is not due.
  due := ARRAY(
    SELECT d."id" FROM app.gallring_due(r."schoolId", 'DEPARTED_PEOPLE', cutoff, today) d
     WHERE d."id" = ANY (p_users)
     ORDER BY d."id"
     LIMIT 500);

  PERFORM set_config('app.gallring', r."schoolId"::text, true);
  UPDATE "Users" u SET
      "firstName"       = 'Pseudonym',
      "lastName"        = upper(left(replace(u."id"::text, '-', ''), 6)),
      "email"           = 'pseudonym-' || u."id"::text || '@pseudonym.invalid',
      "phone"           = NULL,
      "ss12000Id"       = NULL,
      "authId"          = gen_random_uuid(),
      "invitedAt"       = NULL,
      "pseudonymisedAt" = now(),
      "updatedAt"       = now()
   WHERE u."schoolId" = r."schoolId" AND u."id" = ANY (due);
  GET DIAGNOSTICS n = ROW_COUNT;
  -- Löne-id (20270206090000): the payroll system's number, as the signature.
  UPDATE "TeacherEmployments" SET "signature" = NULL, "note" = NULL, "payrollNumber" = NULL
   WHERE "schoolId" = r."schoolId" AND "userId" = ANY (due)
     AND ("signature" IS NOT NULL OR "note" IS NOT NULL OR "payrollNumber" IS NOT NULL);
  -- Löne-id (20270206091000): the versions of a pseudonym's posts lose the number too (the log's guard
  -- lets gallring make this one change).
  UPDATE "TeacherEmploymentLogs" SET
      "before" = CASE WHEN "before" ? 'payrollNumber' THEN jsonb_set("before", '{payrollNumber}', 'null'::jsonb) ELSE "before" END,
      "after"  = CASE WHEN "after" ? 'payrollNumber' THEN jsonb_set("after", '{payrollNumber}', 'null'::jsonb) ELSE "after" END
   WHERE "schoolId" = r."schoolId" AND "userId" = ANY (due) AND "entity" = 'EMPLOYMENT'
     AND (coalesce("before" -> 'payrollNumber', 'null'::jsonb) <> 'null'::jsonb
          OR coalesce("after" -> 'payrollNumber', 'null'::jsonb) <> 'null'::jsonb);
  -- Rastvaktsschema (20261207090000): a pass's note, as the tjänst's.
  UPDATE "SupervisionShifts" SET "note" = NULL, "updatedAt" = now()
   WHERE "schoolId" = r."schoolId" AND "userId" = ANY (due) AND "note" IS NOT NULL;
  DELETE FROM "GuardianStudents"
   WHERE "schoolId" = r."schoolId" AND ("guardianId" = ANY (due) OR "studentId" = ANY (due));
  DELETE FROM "PushTickets" p USING "DevicePushTokens" t
   WHERE p."tokenId" = t."id" AND p."schoolId" = t."schoolId"
     AND t."schoolId" = r."schoolId" AND t."userId" = ANY (due);
  DELETE FROM "DevicePushTokens" WHERE "schoolId" = r."schoolId" AND "userId" = ANY (due);
  DELETE FROM "NotificationOptOuts" WHERE "schoolId" = r."schoolId" AND "userId" = ANY (due);
  DELETE FROM "Notifications" WHERE "schoolId" = r."schoolId" AND "userId" = ANY (due);
  -- skyddad identitet (20270107090000): a pseudonym's mark.
  DELETE FROM "PersonProtections" WHERE "schoolId" = r."schoolId" AND "userId" = ANY (due);
  PERFORM set_config('app.gallring', '', true);

  UPDATE "GallringRuns" SET
    "counts" = "counts" || jsonb_build_object('DEPARTED_PEOPLE', COALESCE(("counts" ->> 'DEPARTED_PEOPLE')::bigint, 0) + n),
    "cutoffs" = "cutoffs" || jsonb_build_object('DEPARTED_PEOPLE', cutoff::text)
   WHERE "id" = p_run;
  RETURN n;
END
$function$;

CREATE OR REPLACE FUNCTION app.gallring_purge(p_run uuid, p_type "RetentionDataType", p_limit integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r "GallringRuns";
  cutoff date;
  today date;
  budget integer := greatest(least(p_limit, 5000), 1);
  n integer := 0;
  step integer;
BEGIN
  -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person.
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'GALLRING_IS_THE_JOBS' USING ERRCODE = 'GL403';
  END IF;
  IF p_type = 'DEPARTED_PEOPLE' THEN
    RAISE EXCEPTION 'GALLRING_PEOPLE_ARE_PSEUDONYMISED' USING ERRCODE = 'GL400';
  END IF;
  -- FOR UPDATE: one call of a run at a time.
  SELECT * INTO r FROM "GallringRuns" WHERE "id" = p_run AND "status" = 'RUNNING' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GALLRING_RUN_NOT_RUNNING' USING ERRCODE = 'GL404';
  END IF;
  -- Both NULL when nothing of the kind may go: least() of a NULL is the other.
  IF r."cutoffs" ->> p_type::text IS NULL
     OR app.retention_months_in_force(r."schoolId", p_type, clock_timestamp()) IS NULL THEN
    RETURN 0;
  END IF;
  cutoff := app.gallring_run_cutoff(r."schoolId", r."startedAt", r."cutoffs", p_type);
  today := app.gallring_today(r."schoolId", r."startedAt");

  PERFORM set_config('app.gallring', r."schoolId"::text, true);
  CASE p_type
    WHEN 'ATTENDANCE' THEN
      DELETE FROM "AttendanceRecords" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'AttendanceRecords' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
      -- frånvarobevakning
      IF n < budget THEN
        DELETE FROM "AbsenceWatchFindings" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'AbsenceWatchFindings' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
      -- rapporteringsgrad
      IF n < budget THEN
        DELETE FROM "TeacherReportingDays" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'TeacherReportingDays' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
      IF n < budget THEN
        DELETE FROM "ReportingReminders" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'ReportingReminders' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
      -- elevens lektion
      IF n < budget THEN
        DELETE FROM "LessonPupilMoves" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'LessonPupilMoves' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
    WHEN 'ABSENCE_REPORTS' THEN
      DELETE FROM "AbsenceReports" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'AbsenceReports' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
    WHEN 'LEAVE_REQUESTS' THEN
      DELETE FROM "LeaveRequests" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'LeaveRequests' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
    WHEN 'NOTIFICATIONS' THEN
      DELETE FROM "Notifications" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'Notifications' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
      -- kvittens: a request goes with the rows under it, by their key
      IF n < budget THEN
        DELETE FROM "AckRequests" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'AckRequests' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
    -- checklistor: the proofs and the answers of a pupil who has left, then the lists that are left empty
    WHEN 'CHECKLISTS' THEN
      DELETE FROM "InstructionProofs" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'InstructionProofs' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n < budget THEN
        DELETE FROM "ConsentEntries" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'ConsentEntries' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
      IF n < budget THEN
        DELETE FROM "ConsentLists" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'ConsentLists' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
    WHEN 'CHANGE_LOGS' THEN
      DELETE FROM "ScheduleChangeLogs" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'ScheduleChangeLogs' LIMIT budget);
      GET DIAGNOSTICS step = ROW_COUNT;
      n := step;
      IF n < budget THEN
        DELETE FROM "TeacherEmploymentLogs" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'TeacherEmploymentLogs' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
      IF n < budget THEN
        DELETE FROM "GuardianStudentHistory" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'GuardianStudentHistory' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
      -- skyddad identitet
      IF n < budget THEN
        DELETE FROM "PersonProtectionEvents" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'PersonProtectionEvents' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
    WHEN 'ABSENCE_REASONS' THEN
      UPDATE "TeacherAbsences" SET "reasonId" = NULL WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'TeacherAbsences' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
    -- läslogg
    WHEN 'ACCESS_LOG' THEN
      DELETE FROM "PersonalDataAccess" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'PersonalDataAccess' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
    -- vikarieförfrågningar
    WHEN 'COVER_REQUESTS' THEN
      DELETE FROM "CoverRequests" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'CoverRequests' LIMIT budget);
      GET DIAGNOSTICS step = ROW_COUNT;
      n := step;
      IF n < budget THEN
        DELETE FROM "CoverConfirmations" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'CoverConfirmations' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
    -- extern bokning: a series goes with its days, by the key
    WHEN 'EXTERNAL_BOOKINGS' THEN
      DELETE FROM "ExternalBookings" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'ExternalBookings' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
    -- krisläge
    WHEN 'CRISIS_DRILLS', 'CRISIS_ALARMS' THEN
      DELETE FROM "CrisisAlarms" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'CrisisAlarms' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
  END CASE;
  PERFORM set_config('app.gallring', '', true);

  UPDATE "GallringRuns" SET
    "counts"   = "counts" || jsonb_build_object(p_type::text, COALESCE(("counts" ->> p_type::text)::bigint, 0) + n),
    "complete" = "complete" || jsonb_build_object(p_type::text, n < budget),
    "cutoffs"  = "cutoffs" || jsonb_build_object(p_type::text, cutoff::text)
   WHERE "id" = p_run;
  RETURN n;
END
$function$;

CREATE OR REPLACE FUNCTION app.gallring_schools()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT DISTINCT latest."schoolId"
    FROM (SELECT DISTINCT ON (d."schoolId", d."dataType") d."schoolId", d."decision"
            FROM "RetentionDecisions" d
           ORDER BY d."schoolId", d."dataType", d."decidedAt" DESC, d."id" DESC) latest
   WHERE latest."decision" = 'PURGE_AFTER'
     -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person: den får ingen skola.
     AND nullif(current_setting('request.jwt.claims', true), '') IS NULL
     AND nullif(current_setting('request.jwt.claim.sub', true), '') IS NULL;
$function$;

-- ---------------------------------------------------------------------------
-- Jobbens bokföring (jobbrunnaren)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.job_claim_finished(p_job text, p_school uuid, p_day date, p_at timestamp with time zone)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  UPDATE "JobClaims" SET "finishedAt" = p_at
   WHERE "job" = p_job AND "schoolId" = p_school AND "day" = p_day AND "finishedAt" IS NULL
     -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person: den får ingen rad ändrad.
     AND nullif(current_setting('request.jwt.claims', true), '') IS NULL
     AND nullif(current_setting('request.jwt.claim.sub', true), '') IS NULL;
$function$;

CREATE OR REPLACE FUNCTION app.job_claim_nightly(p_job text, p_hour integer, p_schools uuid[], p_limit integer, p_at timestamp with time zone)
 RETURNS TABLE(school_id uuid, local_day date)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person.
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'JOB_BOOKKEEPING_IS_THE_JOBS' USING ERRCODE = 'JR403';
  END IF;
  DELETE FROM "JobClaims" WHERE "claimedAt" < p_at - interval '35 days';
  RETURN QUERY
  WITH due AS (
    SELECT s."id", (p_at AT TIME ZONE s."timezone")::date AS d
      FROM "Schools" s
     WHERE s."id" = ANY (p_schools)
       AND extract(hour FROM p_at AT TIME ZONE s."timezone") >= p_hour
       AND NOT EXISTS (
             SELECT 1 FROM "JobClaims" c
              WHERE c."job" = p_job AND c."schoolId" = s."id"
                AND c."day" = (p_at AT TIME ZONE s."timezone")::date
                AND (c."finishedAt" IS NOT NULL OR c."claimedAt" > p_at - interval '2 hours'))
     ORDER BY s."id"
     LIMIT greatest(least(p_limit, 50), 0)
  )
  INSERT INTO "JobClaims" AS c ("job", "schoolId", "day", "claimedAt")
  SELECT p_job, due."id", due.d, p_at FROM due
  ON CONFLICT ("job", "schoolId", "day") DO UPDATE SET "claimedAt" = EXCLUDED."claimedAt"
     WHERE c."finishedAt" IS NULL AND c."claimedAt" <= p_at - interval '2 hours'
  RETURNING c."schoolId", c."day";
END
$function$;

CREATE OR REPLACE FUNCTION app.job_run_settled(p_job text, p_started timestamp with time zone, p_finished timestamp with time zone, p_ok boolean, p_error text, p_counts jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  d date := (p_finished AT TIME ZONE 'UTC')::date;
BEGIN
  -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person.
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'JOB_BOOKKEEPING_IS_THE_JOBS' USING ERRCODE = 'JR403';
  END IF;
  DELETE FROM "JobRuns" WHERE "day" < d - 90;
  INSERT INTO "JobRuns" AS r ("job", "day", "runs", "failures", "counts",
                              "lastStartedAt", "lastFinishedAt", "lastFailedAt", "lastError")
  VALUES (p_job, d, 1, CASE WHEN p_ok THEN 0 ELSE 1 END, COALESCE(p_counts, '{}'::jsonb),
          p_started, p_finished, CASE WHEN p_ok THEN NULL ELSE p_finished END,
          CASE WHEN p_ok THEN NULL ELSE p_error END)
  ON CONFLICT ("job", "day") DO UPDATE SET
    "runs"           = r."runs" + 1,
    "failures"       = r."failures" + CASE WHEN p_ok THEN 0 ELSE 1 END,
    -- Key by key: a key either side lacks counts as 0.
    "counts"         = (SELECT COALESCE(jsonb_object_agg(k, COALESCE((r."counts" ->> k)::bigint, 0)
                                                           + COALESCE((EXCLUDED."counts" ->> k)::bigint, 0)), '{}'::jsonb)
                          FROM (SELECT jsonb_object_keys(r."counts") UNION SELECT jsonb_object_keys(EXCLUDED."counts")) AS keys(k)),
    "lastStartedAt"  = greatest(r."lastStartedAt", EXCLUDED."lastStartedAt"),
    "lastFinishedAt" = greatest(r."lastFinishedAt", EXCLUDED."lastFinishedAt"),
    "lastFailedAt"   = COALESCE(EXCLUDED."lastFailedAt", r."lastFailedAt"),
    "lastError"      = CASE WHEN p_ok THEN r."lastError" ELSE EXCLUDED."lastError" END;
END
$function$;

CREATE OR REPLACE FUNCTION app.job_runs_latest()
 RETURNS TABLE(job text, last_finished timestamp with time zone, last_failed timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT DISTINCT ON (r."job") r."job", r."lastFinishedAt", r."lastFailedAt"
    FROM "JobRuns" r
   -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person: den får inga rader.
   WHERE nullif(current_setting('request.jwt.claims', true), '') IS NULL
     AND nullif(current_setting('request.jwt.claim.sub', true), '') IS NULL
   ORDER BY r."job", r."day" DESC;
$function$;

-- ---------------------------------------------------------------------------
-- Inloggningen som en annan skola redan har (personens dörr)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.login_is_held_elsewhere(p_auth_id uuid, p_user uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE WHEN nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL
              THEN EXISTS (SELECT 1 FROM "Users" WHERE "authId" = p_auth_id AND "id" IS DISTINCT FROM p_user)
                OR EXISTS (SELECT 1 FROM "HuvudmanMembers" WHERE "authId" = p_auth_id)
         END
$function$;

-- ---------------------------------------------------------------------------
-- Push och utleverans (notisjobben)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.delivery_opt_outs(p_school uuid, p_users uuid[], p_type "NotificationType")
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT o."userId"
    FROM "NotificationOptOuts" o
   WHERE o."schoolId" = p_school
     -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person: den får ingen avanmälan.
     AND nullif(current_setting('request.jwt.claims', true), '') IS NULL
     AND nullif(current_setting('request.jwt.claim.sub', true), '') IS NULL
     AND o."userId" = ANY (p_users)
     AND o."type" = p_type
$function$;

CREATE OR REPLACE FUNCTION app.push_due_receipts(p_limit integer)
 RETURNS TABLE(ticket_id text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person.
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'PUSH_DELIVERY_IS_THE_JOBS' USING ERRCODE = 'PU403';
  END IF;
  DELETE FROM "PushTickets" WHERE "createdAt" < now() - interval '24 hours';
  DELETE FROM "DevicePushTokens" WHERE "revokedAt" < now() - interval '30 days';
  DELETE FROM "DevicePushTokens" WHERE "lastSeenAt" < now() - interval '180 days';
  RETURN QUERY
  WITH due AS (
    SELECT p."id" FROM "PushTickets" p
     WHERE p."createdAt" <= now() - interval '15 minutes'
       AND (p."claimedAt" IS NULL OR p."claimedAt" < now() - interval '1 hour')
     ORDER BY p."createdAt"
     LIMIT greatest(least(p_limit, 1000), 0)
       FOR UPDATE SKIP LOCKED
  )
  UPDATE "PushTickets" p SET "claimedAt" = now() FROM due WHERE p."id" = due."id"
  RETURNING p."id";
END
$function$;

CREATE OR REPLACE FUNCTION app.push_receipts_settled(p_checked text[], p_dead text[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person.
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'PUSH_DELIVERY_IS_THE_JOBS' USING ERRCODE = 'PU403';
  END IF;
  UPDATE "DevicePushTokens" t
     SET "revokedAt" = now(), "revokedReason" = 'DEVICE_NOT_REGISTERED'
    FROM "PushTickets" p
   WHERE p."id" = ANY (p_dead) AND p."tokenId" = t."id" AND p."schoolId" = t."schoolId" AND t."revokedAt" IS NULL;
  DELETE FROM "PushTickets" WHERE "id" = ANY (p_checked) OR "id" = ANY (p_dead);
END
$function$;

CREATE OR REPLACE FUNCTION app.push_settle(p_school uuid, p_dead uuid[], p_tickets jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person.
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'PUSH_DELIVERY_IS_THE_JOBS' USING ERRCODE = 'PU403';
  END IF;
  UPDATE "DevicePushTokens"
     SET "revokedAt" = now(), "revokedReason" = 'DEVICE_NOT_REGISTERED'
   WHERE "schoolId" = p_school AND "id" = ANY (p_dead) AND "revokedAt" IS NULL;
  INSERT INTO "PushTickets" ("id", "schoolId", "tokenId")
  SELECT x."id", p_school, x."tokenId"
    FROM jsonb_to_recordset(coalesce(p_tickets, '[]'::jsonb)) AS x("id" text, "tokenId" uuid)
    JOIN "DevicePushTokens" t ON t."id" = x."tokenId" AND t."schoolId" = p_school
  ON CONFLICT ("id") DO NOTHING;
END
$function$;

CREATE OR REPLACE FUNCTION app.push_targets(p_school uuid, p_users uuid[], p_type "NotificationType", p_required boolean)
 RETURNS TABLE(token_id uuid, user_id uuid, token text, locale text, timezone text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT t."id", t."userId", t."token", t."locale", coalesce(s."timezone", 'Europe/Stockholm')
    FROM "DevicePushTokens" t
    JOIN "Users" u ON u."id" = t."userId" AND u."schoolId" = t."schoolId" AND u."isActive"
    JOIN "Schools" s ON s."id" = t."schoolId"
   WHERE t."schoolId" = p_school
     -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person: den får inga enheter.
     AND nullif(current_setting('request.jwt.claims', true), '') IS NULL
     AND nullif(current_setting('request.jwt.claim.sub', true), '') IS NULL
     AND t."userId" = ANY (p_users)
     AND t."revokedAt" IS NULL
     AND p_type <> 'TEACHER_ABSENCE_REPORTED'
     AND (p_required OR NOT EXISTS (
           SELECT 1 FROM "NotificationOptOuts" o
            WHERE o."userId" = t."userId" AND o."schoolId" = t."schoolId" AND o."type" = p_type))
   ORDER BY t."userId", t."id"
$function$;

-- ---------------------------------------------------------------------------
-- Rapporteringsgrad (jobbet, varje natt)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.reporting_compute(p_school uuid, p_as_of date)
 RETURNS TABLE(written integer, removed integer, teachers integer, held integer, reported integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  tz text;
  today date;
  first_day date;
  cutoff date;
  shortest integer;
  n_written integer;
  n_removed integer;
  n_teachers integer;
  n_held integer;
  n_reported integer;
BEGIN
  -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person.
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'REPORTING_RATE_IS_THE_JOBS' USING ERRCODE = 'RR403';
  END IF;
  SELECT s."timezone" INTO tz FROM "Schools" s WHERE s."id" = p_school;
  IF tz IS NULL THEN
    RAISE EXCEPTION 'REPORTING_NO_SCHOOL' USING ERRCODE = 'RR404';
  END IF;
  today := (clock_timestamp() AT TIME ZONE tz)::date;
  IF p_as_of IS NULL OR p_as_of >= today THEN
    RAISE EXCEPTION 'REPORTING_DAY_IS_NOT_OVER: graden räknas till och med en dag som gått'
      USING ERRCODE = 'RR400';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('reporting-rate:' || p_school::text, 0));

  first_day := p_as_of - 89;
  -- A school that has chosen to purge attendance: a day before the cutoff of the
  -- shortest period it has chosen (a decision to keep afterwards does not give
  -- the marks back) may have lost its marks, and counted again it would read as
  -- a day nobody reported. A decision that is not in force yet counts: it is a
  -- day's notice, and the days it will reach are final already.
  SELECT min(d."months") INTO shortest FROM "RetentionDecisions" d
   WHERE d."schoolId" = p_school AND d."dataType" = 'ATTENDANCE' AND d."decision" = 'PURGE_AFTER';
  cutoff := app.retention_cutoff(p_school, shortest, clock_timestamp());
  IF cutoff IS NOT NULL THEN
    first_day := greatest(first_day, cutoff);
  END IF;

  -- What the lessons say, what is stored, and the two side by side in one FULL JOIN: a join that cannot be
  -- a nested loop, so that the night costs the same whatever the planner thinks the lessons come to (a NOT
  -- EXISTS against the counted days was planned as one, and took a second more than the count itself).
  WITH counted AS MATERIALIZED (
    SELECT l.teacher_id, l.day,
           count(*)::integer AS held,
           (count(*) FILTER (WHERE l.reported))::integer AS reported
      FROM app.reporting_lessons(p_school, first_day, p_as_of, clock_timestamp()) l
     GROUP BY l.teacher_id, l.day
  ),
  diff AS MATERIALIZED (
    SELECT d."id" AS old_id, d."held" AS old_held, d."reported" AS old_reported,
           c.teacher_id, c.day, c.held, c.reported
      FROM (SELECT x."id", x."teacherId", x."day", x."held", x."reported" FROM "TeacherReportingDays" x
             WHERE x."schoolId" = p_school AND x."day" BETWEEN first_day AND p_as_of) d
      FULL JOIN counted c ON c.teacher_id = d."teacherId" AND c.day = d."day"
  ),
  up AS (
    INSERT INTO "TeacherReportingDays" ("schoolId", "teacherId", "day", "held", "reported")
    SELECT p_school, f.teacher_id, f.day, f.held, f.reported FROM diff f
     WHERE f.teacher_id IS NOT NULL
       AND (f.old_id IS NULL OR (f.old_held, f.old_reported) IS DISTINCT FROM (f.held, f.reported))
    ON CONFLICT ("teacherId", "schoolId", "day") DO UPDATE
       SET "held" = EXCLUDED."held", "reported" = EXCLUDED."reported", "changedAt" = clock_timestamp()
    RETURNING 1
  ),
  gone AS (
    DELETE FROM "TeacherReportingDays" d
     WHERE d."id" IN (SELECT f.old_id FROM diff f WHERE f.teacher_id IS NULL)
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM up)::integer,
         (SELECT count(*) FROM gone)::integer,
         (SELECT count(DISTINCT c.teacher_id) FROM counted c)::integer,
         (SELECT coalesce(sum(c.held), 0) FROM counted c)::integer,
         (SELECT coalesce(sum(c.reported), 0) FROM counted c)::integer
    INTO n_written, n_removed, n_teachers, n_held, n_reported;

  RETURN QUERY SELECT n_written, n_removed, n_teachers, n_held, n_reported;
END
$function$;

CREATE OR REPLACE FUNCTION app.reporting_digest(p_school uuid, p_start date, p_end date)
 RETURNS TABLE(notification_id uuid, user_id uuid, email text, meta jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  tz text;
BEGIN
  -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person.
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'REPORTING_RATE_IS_THE_JOBS' USING ERRCODE = 'RR403';
  END IF;
  SELECT s."timezone" INTO tz FROM "Schools" s WHERE s."id" = p_school;
  IF tz IS NULL THEN
    RAISE EXCEPTION 'REPORTING_NO_SCHOOL' USING ERRCODE = 'RR404';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR extract(isodow FROM p_start) <> 1 OR p_end <> p_start + 6
     OR p_end >= (clock_timestamp() AT TIME ZONE tz)::date THEN
    RAISE EXCEPTION 'REPORTING_WEEK_IS_NOT_OVER: veckobeskedet gäller en hel vecka, måndag till söndag, som gått'
      USING ERRCODE = 'RR400';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('reporting-digest:' || p_school::text, 0));
  PERFORM 1 FROM "ReportingSettings" s WHERE s."schoolId" = p_school AND s."rektorDigest" FOR SHARE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  RETURN QUERY
  WITH totals AS MATERIALIZED (
    SELECT coalesce(sum(d."held"), 0)::integer AS held,
           coalesce(sum(d."reported"), 0)::integer AS reported,
           count(DISTINCT d."teacherId")::integer AS teachers
      FROM "TeacherReportingDays" d
     WHERE d."schoolId" = p_school AND d."day" BETWEEN p_start AND p_end
  ),
  recipients AS MATERIALIZED (
    SELECT u."id", u."email"
      FROM "Users" u
     WHERE u."schoolId" = p_school AND u."role" = 'SCHOOL_ADMIN' AND u."isActive"
       AND u."adminProfile" IN ('REKTOR', 'FULL')
       AND (SELECT t.held FROM totals t) > 0
  ),
  ledger AS (
    INSERT INTO "ReportingDigests" ("schoolId", "periodStart", "periodEnd", "recipients", "teachers", "held", "reported")
    SELECT p_school, p_start, p_end, (SELECT count(*) FROM recipients)::integer, t.teachers, t.held, t.reported
      FROM totals t
    ON CONFLICT ("schoolId", "periodEnd") DO NOTHING
    RETURNING 1
  ),
  written AS (
    INSERT INTO "Notifications" ("schoolId", "userId", "type", "meta")
    SELECT p_school, r."id", 'REPORTING_RATE_DIGEST',
           jsonb_build_object('periodStart', p_start, 'periodEnd', p_end,
                              'held', t.held, 'reported', t.reported, 'teachers', t.teachers)
      FROM recipients r, totals t
     WHERE EXISTS (SELECT 1 FROM ledger)
    RETURNING "id", "userId", "meta"
  )
  SELECT w."id", w."userId", rc."email", w."meta"
    FROM written w JOIN recipients rc ON rc."id" = w."userId";
END
$function$;

CREATE OR REPLACE FUNCTION app.reporting_digest_due(p_school uuid, p_today date)
 RETURNS TABLE(period_start date, period_end date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT e.end_day - 6, e.end_day
    FROM "ReportingSettings" s
   CROSS JOIN LATERAL (SELECT p_today - extract(isodow FROM p_today)::integer AS end_day) AS e
   WHERE s."schoolId" = p_school AND s."rektorDigest" AND s."rektorDigestOn" IS NOT NULL
     -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person: den får ingen period.
     AND nullif(current_setting('request.jwt.claims', true), '') IS NULL
     AND nullif(current_setting('request.jwt.claim.sub', true), '') IS NULL
     AND e.end_day >= s."rektorDigestOn"
     AND NOT EXISTS (SELECT 1 FROM "ReportingDigests" d
                      WHERE d."schoolId" = p_school AND d."periodEnd" = e.end_day)
$function$;

CREATE OR REPLACE FUNCTION app.reporting_remind(p_school uuid, p_today date)
 RETURNS TABLE(notification_id uuid, user_id uuid, email text, meta jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  st "ReportingSettings";
BEGIN
  -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person.
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'REPORTING_RATE_IS_THE_JOBS' USING ERRCODE = 'RR403';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('reporting-remind:' || p_school::text, 0));
  SELECT * INTO st FROM "ReportingSettings" s WHERE s."schoolId" = p_school AND s."teacherReminders" FOR SHARE;
  IF NOT FOUND OR extract(isodow FROM p_today) >= 6 THEN
    RETURN;
  END IF;
  DELETE FROM "ReportingReminders" r WHERE r."schoolId" = p_school AND r."lessonDate" < p_today - 60;
  RETURN QUERY
  WITH due AS MATERIALIZED (
    SELECT l.lesson_id, l.teacher_id, l.day
      FROM app.reporting_lessons(
             p_school, greatest(p_today - 30, st."teacherRemindersOn"), p_today - st."openAfterDays", clock_timestamp()) l
     WHERE NOT l.reported
  ),
  -- Once per lesson and teacher: the ledger's key says so, and a lesson already in it adds no row here.
  ledger AS (
    INSERT INTO "ReportingReminders" ("schoolId", "teacherId", "calendarLessonId", "lessonDate")
    SELECT p_school, d.teacher_id, d.lesson_id, d.day FROM due d
    ON CONFLICT ("calendarLessonId", "teacherId") DO NOTHING
    RETURNING "teacherId"
  ),
  per_teacher AS (
    SELECT g."teacherId" AS user_id, count(*)::integer AS n FROM ledger g GROUP BY g."teacherId"
  ),
  written AS (
    INSERT INTO "Notifications" ("schoolId", "userId", "type", "meta")
    SELECT p_school, pt.user_id, 'LESSON_REPORT_REMINDER',
           jsonb_build_object('count', pt.n, 'limitDays', st."openAfterDays")
      FROM per_teacher pt
    RETURNING "id", "userId", "meta"
  )
  SELECT w."id", w."userId", u."email", w."meta"
    FROM written w JOIN "Users" u ON u."id" = w."userId" AND u."schoolId" = p_school;
END
$function$;

CREATE OR REPLACE FUNCTION app.reporting_schools()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT s."id" FROM "Schools" s
   -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person: den får ingen skola.
   WHERE nullif(current_setting('request.jwt.claims', true), '') IS NULL
     AND nullif(current_setting('request.jwt.claim.sub', true), '') IS NULL
     AND EXISTS (SELECT 1 FROM "CalendarLessons" cl
                  WHERE cl."schoolId" = s."id"
                    AND cl."date" >= (clock_timestamp() AT TIME ZONE s."timezone")::date - 90)
   ORDER BY s."id"
$function$;

-- ---------------------------------------------------------------------------
-- Schemakandidaternas städning (kvartsvis)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.schedule_candidates_sweep()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  abandoned integer;
  removed integer;
BEGIN
  -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person.
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'SCHEDULE_CANDIDATES_SWEEP_IS_THE_JOBS' USING ERRCODE = 'SC403';
  END IF;
  -- A run's task bumps heartbeatAt before every candidate; its lease is twice
  -- the longest call it makes. Past that, or half an hour after it began, the
  -- instance that ran it is gone, and the run holds the year's one active
  -- place until it is marked.
  WITH stale AS (
    SELECT "id" FROM "ScheduleCandidateRuns"
     WHERE "status" IN ('PENDING', 'RUNNING', 'CANCELLING')
       AND ("heartbeatAt" + make_interval(secs => "leaseSeconds") < now()
            OR "createdAt" < now() - interval '30 minutes')
     FOR UPDATE SKIP LOCKED
  )
  UPDATE "ScheduleCandidateRuns" r
     SET "status" = 'FAILED',
         "error" = 'The run stopped before it finished.',
         "errorCode" = 'CANDIDATE_RUN_ABANDONED',
         "errorParams" = NULL,
         "finishedAt" = now()
    FROM stale
   WHERE r."id" = stale."id";
  GET DIAGNOSTICS abandoned = ROW_COUNT;

  -- Older than seven days, or removed by a discard or a newer batch while
  -- its engine call could still be solving and that call's time now past.
  WITH old AS (
    SELECT "id" FROM "ScheduleCandidateRuns"
     WHERE "createdAt" < now() - interval '7 days'
        OR ("discardedAt" IS NOT NULL AND ("engineBusyUntil" IS NULL OR "engineBusyUntil" <= now()))
     FOR UPDATE SKIP LOCKED
  )
  DELETE FROM "ScheduleCandidateRuns" r
   USING old
   WHERE r."id" = old."id";
  GET DIAGNOSTICS removed = ROW_COUNT;

  RETURN abandoned + removed;
END
$function$;

-- ---------------------------------------------------------------------------
-- Skolans export (jobbet)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.school_export_claim(p_lease interval)
 RETURNS TABLE(export_id uuid, school_id uuid, user_id uuid, auth_id uuid, admin_profile "AdminProfile", hr_read boolean, attempt integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  picked  "SchoolExports"%ROWTYPE;
  login   uuid;
  profile "AdminProfile";
  hr      boolean;
BEGIN
  -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person.
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'SCHOOL_EXPORT_IS_THE_JOBS' USING ERRCODE = 'SS403';
  END IF;
  IF p_lease IS NULL OR p_lease < interval '10 seconds' OR p_lease > interval '1 hour' THEN
    RAISE EXCEPTION 'school_export_claim: the lease is between 10 seconds and 1 hour' USING ERRCODE = 'SS409';
  END IF;
  LOOP
    SELECT e.* INTO picked
      FROM "SchoolExports" e
     WHERE e."status" = 'QUEUED'
        OR (e."status" = 'RUNNING' AND e."heartbeatAt" < clock_timestamp() - p_lease)
     ORDER BY e."requestedAt", e."id"
     LIMIT 1
       FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      RETURN;
    END IF;

    SELECT u."authId", u."adminProfile", u."hrRead" INTO login, profile, hr
      FROM "Users" u
     WHERE u."id" = picked."requestedById" AND u."schoolId" = picked."schoolId"
       AND u."isActive" AND u."role" = 'SCHOOL_ADMIN' AND app.admin_profile_decides(u."adminProfile");

    IF login IS NULL OR picked."attempts" >= 3 THEN
      DELETE FROM "SchoolExportChunks" WHERE "exportId" = picked."id";
      UPDATE "SchoolExports"
         SET "status" = 'FAILED', "finishedAt" = clock_timestamp(),
             "errorClass" = CASE WHEN login IS NULL THEN 'RequesterGone' ELSE 'TooManyAttempts' END
       WHERE "id" = picked."id";
      CONTINUE;
    END IF;

    DELETE FROM "SchoolExportChunks" WHERE "exportId" = picked."id";
    UPDATE "SchoolExports"
       SET "status" = 'RUNNING',
           "startedAt" = clock_timestamp(),
           "heartbeatAt" = clock_timestamp(),
           "attempts" = "attempts" + 1
     WHERE "id" = picked."id";
    RETURN QUERY SELECT picked."id", picked."schoolId", picked."requestedById", login, profile, hr, picked."attempts" + 1;
    RETURN;
  END LOOP;
END
$function$;

CREATE OR REPLACE FUNCTION app.school_export_expire(p_ledger interval)
 RETURNS TABLE(expired integer, purged integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  n_expired integer;
  n_purged  integer;
BEGIN
  -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person.
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'SCHOOL_EXPORT_IS_THE_JOBS' USING ERRCODE = 'SS403';
  END IF;
  IF p_ledger IS NULL OR p_ledger < interval '30 days' THEN
    RAISE EXCEPTION 'school_export_expire: the ledger is kept for at least 30 days' USING ERRCODE = 'SS409';
  END IF;
  DELETE FROM "SchoolExportChunks" c
   USING "SchoolExports" e
   WHERE e."id" = c."exportId" AND e."status" = 'READY' AND e."expiresAt" <= clock_timestamp();
  WITH gone AS (
    UPDATE "SchoolExports" SET "status" = 'EXPIRED', "readAbout" = NULL
     WHERE "status" = 'READY' AND "expiresAt" <= clock_timestamp()
    RETURNING 1)
  SELECT count(*)::integer INTO n_expired FROM gone;
  WITH gone AS (
    DELETE FROM "SchoolExports"
     WHERE "status" IN ('EXPIRED', 'FAILED') AND "finishedAt" < clock_timestamp() - p_ledger
    RETURNING 1)
  SELECT count(*)::integer INTO n_purged FROM gone;
  RETURN QUERY SELECT n_expired, n_purged;
END
$function$;

CREATE OR REPLACE FUNCTION app.school_export_fail(p_id uuid, p_error text, p_attempt integer DEFAULT NULL::integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person.
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'SCHOOL_EXPORT_IS_THE_JOBS' USING ERRCODE = 'SS403';
  END IF;
  UPDATE "SchoolExports"
     SET "status" = 'FAILED', "finishedAt" = clock_timestamp(),
         "errorClass" = CASE WHEN p_error ~ '^[A-Za-z][A-Za-z0-9_]{0,79}$' THEN p_error ELSE 'Error' END
   WHERE "id" = p_id AND "status" = 'RUNNING' AND (p_attempt IS NULL OR "attempts" = p_attempt);
  IF FOUND THEN
    DELETE FROM "SchoolExportChunks" WHERE "exportId" = p_id;
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION app.school_export_finish(p_id uuid, p_bytes bigint, p_chunks integer, p_sha256 text, p_files jsonb, p_held_out jsonb, p_read_about jsonb, p_keep interval, p_attempt integer DEFAULT NULL::integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  have_chunks integer;
  have_bytes  bigint;
BEGIN
  -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person.
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'SCHOOL_EXPORT_IS_THE_JOBS' USING ERRCODE = 'SS403';
  END IF;
  IF p_keep IS NULL OR p_keep <= interval '0' OR p_keep > interval '14 days' THEN
    RAISE EXCEPTION 'school_export_finish: a file is kept for between nothing and 14 days' USING ERRCODE = 'SS409';
  END IF;
  SELECT count(*)::integer, coalesce(sum(octet_length(c."bytes")), 0)
    INTO have_chunks, have_bytes
    FROM "SchoolExportChunks" c WHERE c."exportId" = p_id;
  IF have_chunks <> p_chunks OR have_bytes <> p_bytes THEN
    RAISE EXCEPTION 'SCHOOL_EXPORT_FILE_INCOMPLETE: % pieces and % bytes stored, % and % said', have_chunks, have_bytes, p_chunks, p_bytes
      USING ERRCODE = 'SS409';
  END IF;
  UPDATE "SchoolExports"
     SET "status" = 'READY', "finishedAt" = clock_timestamp(),
         "expiresAt" = clock_timestamp() + p_keep,
         "byteSize" = p_bytes, "chunkCount" = p_chunks, "sha256" = p_sha256,
         "files" = p_files, "heldOut" = p_held_out, "readAbout" = p_read_about
   WHERE "id" = p_id AND "status" = 'RUNNING' AND (p_attempt IS NULL OR "attempts" = p_attempt);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SCHOOL_EXPORT_NOT_RUNNING: the export is not being built' USING ERRCODE = 'SS409';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION app.school_export_heartbeat(p_id uuid, p_attempt integer DEFAULT NULL::integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person.
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'SCHOOL_EXPORT_IS_THE_JOBS' USING ERRCODE = 'SS403';
  END IF;
  UPDATE "SchoolExports" SET "heartbeatAt" = clock_timestamp()
   WHERE "id" = p_id AND "status" = 'RUNNING' AND (p_attempt IS NULL OR "attempts" = p_attempt);
  RETURN FOUND;
END
$function$;

CREATE OR REPLACE FUNCTION app.school_export_put(p_id uuid, p_seq integer, p_bytes bytea, p_attempt integer DEFAULT NULL::integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person.
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'SCHOOL_EXPORT_IS_THE_JOBS' USING ERRCODE = 'SS403';
  END IF;
  INSERT INTO "SchoolExportChunks" ("exportId", "seq", "schoolId", "bytes")
  SELECT e."id", p_seq, e."schoolId", p_bytes
    FROM "SchoolExports" e
   WHERE e."id" = p_id AND e."status" = 'RUNNING' AND (p_attempt IS NULL OR e."attempts" = p_attempt);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SCHOOL_EXPORT_NOT_RUNNING: the export is not being built' USING ERRCODE = 'SS409';
  END IF;
END
$function$;

-- ---------------------------------------------------------------------------
-- SS12000-schemaläggaren (var minut)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.ss12000_due_sources(p_limit integer, p_now timestamp with time zone DEFAULT now())
 RETURNS TABLE(source_id uuid, school_id uuid, full_due boolean, local_date date)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person.
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'SS12000_SCHEDULER_IS_THE_JOBS' USING ERRCODE = 'SS403';
  END IF;
  RETURN QUERY
  WITH due AS (
    SELECT s."id", (p_now AT TIME ZONE coalesce(sc."timezone", 'Europe/Stockholm'))::date AS today
      FROM "Ss12000Sources" s
      JOIN "Schools" sc ON sc."id" = s."schoolId"
     WHERE s."enabled" AND s."scheduleEnabled"
       AND cardinality(s."organisationIds") > 0
       AND extract(hour FROM (p_now AT TIME ZONE coalesce(sc."timezone", 'Europe/Stockholm'))) >= s."scheduleHourLocal"
       AND (s."lastScheduledLocalDate" IS NULL
            OR s."lastScheduledLocalDate" < (p_now AT TIME ZONE coalesce(sc."timezone", 'Europe/Stockholm'))::date)
     ORDER BY s."lastScheduledLocalDate" NULLS FIRST, s."id"
     LIMIT greatest(least(p_limit, 50), 0)
       FOR UPDATE OF s SKIP LOCKED
  )
  UPDATE "Ss12000Sources" s
     SET "schedulerClaimedAt" = p_now, "lastScheduledLocalDate" = due.today
    FROM due
   WHERE s."id" = due."id"
  RETURNING s."id", s."schoolId",
            (s."lastFullAt" IS NULL OR s."modifiedCursor" IS NULL OR s."incrementalUnsupported"
             OR s."lastFullAt" < p_now - make_interval(days => s."fullEveryDays")),
            due.today;
END
$function$;

CREATE OR REPLACE FUNCTION app.ss12000_housekeeping(p_now timestamp with time zone DEFAULT now())
 RETURNS TABLE(stale integer, expired integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  n_stale integer;
  n_expired integer;
BEGIN
  -- Jobbets dörr sätter inga claims; varje inloggning gör det, också en som inte är en person.
  IF nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'SS12000_SCHEDULER_IS_THE_JOBS' USING ERRCODE = 'SS403';
  END IF;
  UPDATE "Ss12000SyncRuns"
     SET "status" = 'FETCH_FAILED', "statusCode" = 'STALE', "finishedAt" = p_now
   WHERE "status" = 'RUNNING' AND "startedAt" < p_now - interval '15 minutes';
  GET DIAGNOSTICS n_stale = ROW_COUNT;
  UPDATE "Ss12000SyncRuns"
     SET "status" = 'DISCARDED', "statusCode" = 'EXPIRED', "finishedAt" = p_now
   WHERE "status" = 'DIFF_READY' AND coalesce("fetchedAt", "startedAt") < p_now - interval '30 days';
  GET DIAGNOSTICS n_expired = ROW_COUNT;
  RETURN QUERY SELECT n_stale, n_expired;
END
$function$;

-- Kommentarerna säger nu det vakten gör: ingen inloggning alls, en person eller inte.
COMMENT ON FUNCTION app.absence_stats_month(uuid, date, date) IS
  'Frånvarostatistik: räknar om en månad för skolan och varje klass med minst fem elever (klassen vid lektionens dag, lektionerna ur app.absence_stats_lessons), och tar bort rader månaden inte längre har skäl till. Jobbets dörr: refused (AS403) to a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.absence_stats_plan(uuid, date, integer) IS
  'Frånvarostatistik: månaderna jobbet räknar denna natt, i skolans datum: de senaste 62 dagarna och högst p_backfill äldre som saknar en rad, har en hållen lektion och minst fem elever på klasslistorna, bara de vars markeringar kan finnas kvar. Jobbets dörr: refused (AS403) to a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.absence_stats_trim(uuid, date) IS
  'Frånvarostatistik: tar bort månader före de tre senaste läsårens början. Jobbets dörr: refused (AS403) to a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.absence_watch_digest(uuid, "AbsenceWatchGroup", date, date, date) IS
  'Frånvarobevakning: writes a group''s digest once per period, with a read-log row for each recipient, and answers the notices with the addresses, for the delivery after the commit. Jobbets dörr: refused (AW403) to a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.absence_watch_digest_due(uuid, date) IS
  'Frånvarobevakning: the groups whose last completed week or month has no digest yet. Jobbets dörr: empty for a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.absence_watch_evaluate(uuid, date) IS
  'Frånvarobevakning: who is over which limit as of the end of p_as_of (a day that has passed, in the school''s dates); opens, refreshes and closes findings; answers how many. Jobbets dörr: refused (AW403) to a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.absence_watch_schools() IS
  ' Jobbets dörr: empty for a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.delivery_opt_outs(uuid, uuid[], "NotificationType") IS
  'Which of p_users in p_school opted out of e-mail and push for p_type. The API''s delivery alone calls it, after the commit. Jobbets dörr: empty for a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.gallring_begin(uuid, timestamp with time zone) IS
  'Opens the night''s gallring run of a school with the periods in force and their cutoffs; an unfinished earlier run is INTERRUPTED. Jobbets dörr: refused (GL403) to a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.gallring_claim_person(uuid, uuid) IS
  'For the nightly job, right before a departed person''s login is deleted: locks their Users row and answers their authId and whether they have a login of their own to delete (invited, and held by no other row: a login another school''s row holds stays, 20261204090000, and so does one a huvudman''s membership holds, 20261212090000), only while they are still due under the period in force now; no row otherwise. Jobbets dörr: refused (GL403) to a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.gallring_departed_due(uuid, integer) IS
  'The departed people a run may pseudonymise, oldest departure first; each is claimed (app.gallring_claim_person) before their login is deleted. Counts those held for SCB. Jobbets dörr: refused (GL403) to a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.gallring_finish(uuid, jsonb, timestamp with time zone) IS
  ' Jobbets dörr: refused (GL403) to a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.gallring_pseudonymise(uuid, uuid[]) IS
  'Locks the rows of p_users in the run''s school, then pseudonymises those still due: name, e-mail, phone, SS12000 id and login replaced; their tjänster''s signature, note and payroll number, the payroll number in those tjänster''s versions, and their rastvaktspass'' notes, cleared; their guardian links, push devices, notification opt-outs, all their own notices (whatever NOTIFICATIONS says) and their mark of a protected identity removed. Returns how many it pseudonymised. Jobbets dörr: refused (GL403) to a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.gallring_purge(uuid, "RetentionDataType", integer) IS
  'Purges at most p_limit rows of one kind for a run and counts them on it; never more than the period in force now allows. Jobbets dörr: refused (GL403) to a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.gallring_schools() IS
  ' Jobbets dörr: empty for a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.job_claim_finished(text, uuid, date, timestamp with time zone) IS
  'Marks a school''s nightly claim finished, so it is not taken again that day. Jobbets dörr: empty for a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.job_claim_nightly(text, integer, uuid[], integer, timestamp with time zone) IS
  'Claims the nightly job for those of p_schools at or past p_hour local time with no claim that local day; returns the claims this call made. Jobbets dörr: refused (JR403) to a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.job_run_settled(text, timestamp with time zone, timestamp with time zone, boolean, text, jsonb) IS
  'Counts one tick of a job in its row for the UTC day: runs, failures and the pass''s counts, summed key by key. Jobbets dörr: refused (JR403) to a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.job_runs_latest() IS
  'The newest JobRuns row of each job: when it last finished and last failed. Jobbets dörr: empty for a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.login_is_held_elsewhere(uuid, uuid) IS
  'Flera skolor (20261204090000): whether a Users row other than p_user, or (Huvudman, 20261212090000) a huvudman''s membership, holds the login p_auth_id. A shared login is the person''s: no one school deletes or moves it. Refused without a login: NULL (not true, not false) to a session with no claims, so the caller''s fail-safe counts the login as held.';
COMMENT ON FUNCTION app.push_due_receipts(integer) IS
  'Housekeeping, then claims up to p_limit tickets due for a receipt check (SKIP LOCKED). Jobbets dörr: refused (PU403) to a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.push_receipts_settled(text[], text[]) IS
  'Revokes the tokens of DeviceNotRegistered receipts and deletes the checked tickets. Jobbets dörr: refused (PU403) to a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.push_settle(uuid, uuid[], jsonb) IS
  'Revokes tokens Expo refused and stores ok tickets, for tokens of p_school only. Jobbets dörr: refused (PU403) to a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.push_targets(uuid, uuid[], "NotificationType", boolean) IS
  'Live push tokens of active users of p_school among p_users, minus opt-outs unless p_required; never for TEACHER_ABSENCE_REPORTED. Jobbets dörr: empty for a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.reporting_compute(uuid, date) IS
  'Rapporteringsgrad: the school''s last 90 days up to p_as_of (a day that has passed), one row per teacher and day with a held lesson; rewrites what changed, removes what lost its lessons; from the cutoff of the shortest period the school has ever chosen to purge attendance after, when it has. Answers what it wrote. Jobbets dörr: refused (RR403) to a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.reporting_digest(uuid, date, date) IS
  'Rapporteringsgrad: writes the week''s notice once, for a whole week (Monday to Sunday) that is over, to the active rektor and full administrators, with the school''s totals and never a name; answers the notices with the addresses. Jobbets dörr: refused (RR403) to a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.reporting_digest_due(uuid, date) IS
  'Rapporteringsgrad: the last completed week, if the school has the weekly notice on and it has no entry yet. Jobbets dörr: empty for a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.reporting_remind(uuid, date) IS
  'Rapporteringsgrad: tells each teacher of lessons that stood open longer than the school''s limit, once per lesson, in one statement with the ledger; nothing at the weekend or with the switch off. Answers the notices with the addresses, for the delivery after the commit. Jobbets dörr: refused (RR403) to a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.reporting_schools() IS
  ' Jobbets dörr: empty for a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.schedule_candidates_sweep() IS
  'Schemaförslag (20261125090000): marks an active run past its lease or 30 minutes old FAILED (CANDIDATE_RUN_ABANDONED) and deletes, with their candidates, runs older than 7 days and discarded runs whose engine call can no longer be solving, skipping rows another transaction holds; returns how many rows it changed. Takes no argument and reads nothing back. Jobbets dörr: refused (SC403) to a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.school_export_claim(interval) IS
  'K5: the oldest QUEUED export, or a RUNNING one whose heartbeat is older than the lease, FOR UPDATE SKIP LOCKED, with the login of the deciding administrator who ordered it. A taken-over export restarts with no pieces; one whose person is gone or on its third attempt FAILS. Jobbets dörr: refused (SS403) to a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.school_export_expire(interval) IS
  'K5: READY files past their expiry lose their pieces and their list of persons (EXPIRED); finished orders past the ledger''s period are deleted. Jobbets dörr: refused (SS403) to a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.school_export_fail(uuid, text, integer) IS
  ' Jobbets dörr: refused (SS403) to a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.school_export_finish(uuid, bigint, integer, text, jsonb, jsonb, jsonb, interval, integer) IS
  'K5: READY, after counting and summing the stored pieces against what the job says it wrote; kept for at most 14 days. Jobbets dörr: refused (SS403) to a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.school_export_heartbeat(uuid, integer) IS
  ' Jobbets dörr: refused (SS403) to a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.school_export_put(uuid, integer, bytea, integer) IS
  'K5: one piece of a RUNNING export''s file, in the export''s own school. Jobbets dörr: refused (SS403) to a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.ss12000_due_sources(integer, timestamp with time zone) IS
  'Claims scheduled sources whose school-local hour is at or past scheduleHourLocal and that have not run this local day (SKIP LOCKED). Jobbets dörr: refused (SS403) to a session with any login (claims), a person or not.';
COMMENT ON FUNCTION app.ss12000_housekeeping(timestamp with time zone) IS
  'Marks RUNNING runs older than 15 minutes FETCH_FAILED (STALE) and DIFF_READY runs older than 30 days DISCARDED (EXPIRED). Jobbets dörr: refused (SS403) to a session with any login (claims), a person or not.';
