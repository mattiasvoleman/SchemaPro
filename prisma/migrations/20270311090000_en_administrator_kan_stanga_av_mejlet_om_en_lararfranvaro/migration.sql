-- En administratör kan stänga av mejlet om en lärares frånvaroanmälan (K6, omgång 15).
--
-- ## Vad som fanns
--
-- TEACHER_ABSENCE_REPORTED, notisen till skolans administratörer när en lärare själv anmäler frånvaro (TeacherAbsencesService.tellAdmins),
-- lämnade aldrig inkorgen: 20261013100000 skrev det i en CHECK på NotificationOptOuts (NotificationOptOuts_absence_report_is_never_a_type),
-- och gatewayen höll typen utanför varje roll lista och utanför leveransen (NEVER_EXTERNAL). En frånvaro som anmäls en söndagskväll syntes
-- för rektorn först när hon loggade in.
--
-- ## Vad det blir
--
-- Notisen kan gå som mejl till skolans administratörer, och aldrig som push (en låsskärm läser den): mejlet säger bara att en lärare har
-- anmält frånvaro, aldrig vem, vilken dag eller varför. Namnen och dagarna står i inkorgsnotisen bakom inloggningen, som förut. En
-- administratör kan stänga av mejlet som vilken annan typ som helst, genom NotificationOptOuts, som delivery_opt_outs läser. Det kräver att
-- databasen inte längre nekar raden. CHECK:en tas bort här; vilka roller som erbjuds omkopplaren är gatewayens lista (TYPES_BY_ROLE), där
-- bara SCHOOL_ADMIN har typen, och en rad en annan roll skrev själv för sin egen räkning (RLS: bara den egna raden) skulle inte ge något:
-- ingen annan får typen. Push: app.push_targets nekar typen vid sidan av gatewayen (PU-vakten), som förut.
--
-- ## Det som inte ändras
--
-- CHECK:en NotificationOptOuts_absence_notice_is_kept (ABSENCE_UNREPORTED, som skollagen kräver att vårdnadshavarna får samma dag) står kvar.
-- Ingen rad finns som CHECK:en skulle ha hindrat (den hindrade just den raden), så ingen rad rörs. Produktionen har ingen Resend-nyckel:
-- ingenting skickas förrän den slås på (docs/DEPLOYMENT.md, avsnittet om kön).
--
-- ## Låset
--
-- DROP CONSTRAINT tar ACCESS EXCLUSIVE på NotificationOptOuts, en liten tabell som en begäran skriver (en persons val) och leveransen läser
-- (en transaktion i dörren). Låset tas NOWAIT i en slinga på 30 s med lock_timeout 5 s (policy-migration-lock-order): filen väntar aldrig
-- med ett lås i handen, och stannar efter 30 s utan att ha ändrat något.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "NotificationOptOuts" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'NotificationOptOuts was not free in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;

  ALTER TABLE "NotificationOptOuts" DROP CONSTRAINT "NotificationOptOuts_absence_report_is_never_a_type";
END
$$;
