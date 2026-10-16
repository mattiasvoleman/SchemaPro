-- En nyckel kan få läsa närvaron: the two scopes of SS12000-närvaro
-- (20261114090000), attendances.read and absences.read.
--
-- One table, taken NOWAIT and retried every 50 ms for 30 s as
-- 20261114090000 takes its own, so this transaction is in no cycle and no
-- request queues behind it while it waits for IntegrationApiKeys; once it
-- has the table, an integration request's key lookup waits for the moment
-- the CHECK takes (it reads a few rows).

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "IntegrationApiKeys" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'IntegrationApiKeys was not free in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

ALTER TABLE "IntegrationApiKeys" DROP CONSTRAINT "IntegrationApiKeys_scopes_are_known";
ALTER TABLE "IntegrationApiKeys"
    ADD CONSTRAINT "IntegrationApiKeys_scopes_are_known" CHECK (
        cardinality("scopes") BETWEEN 1 AND 14
        AND array_position("scopes", NULL) IS NULL
        AND "scopes" <@ ARRAY['ss12000.v1', 'ss12000.v1.import', 'organisations.read', 'persons.read', 'responsibles.read',
                              'groups.read', 'duties.read', 'activities.read', 'calendarEvents.read', 'rooms.read',
                              'syllabuses.read', 'subscriptions.write', 'attendances.read', 'absences.read']::text[]);
