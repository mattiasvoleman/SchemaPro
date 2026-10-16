-- Närvarons gravstenar visas för den som får läsa den: Ss12000Tombstones
-- take 'Attendance' and 'Absence' (20261114090000), and the service
-- principal's arm answers a row of either only to a request that may read
-- that resource (app.service_reads_attendance), so a key without the scope
-- does not learn even their ids and times.
--
-- One table, taken NOWAIT and retried every 50 ms for 30 s as
-- 20261114090000 takes its own, so this transaction is in no cycle and no
-- request queues behind it while it waits for Ss12000Tombstones. The new
-- CHECK is a superset of the old and added NOT VALID, so the lock is held
-- for no scan of the table; every row is validated by 20261114090600, under
-- a lock that blocks no one.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Ss12000Tombstones" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Ss12000Tombstones was not free in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

ALTER TABLE "Ss12000Tombstones" DROP CONSTRAINT "Ss12000Tombstones_resource_is_emitted";
ALTER TABLE "Ss12000Tombstones"
    ADD CONSTRAINT "Ss12000Tombstones_resource_is_emitted" CHECK ("resource" IN
        ('Organisation', 'Person', 'Group', 'Duty', 'Activity', 'AdhocActivity', 'CalendarEvent', 'Room', 'Syllabus',
         'Attendance', 'Absence')) NOT VALID;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'Ss12000Tombstones' AND policyname = 'ss12000_tombstones_service_select') THEN
    ALTER POLICY "ss12000_tombstones_service_select" ON "Ss12000Tombstones"
        USING (
            "schoolId" = app.current_service_school_id()
            AND ("resource" NOT IN ('Attendance', 'Absence')
                 OR ("resource" = 'Attendance' AND (select app.service_reads_attendance('attendances.read')))
                 OR ("resource" = 'Absence' AND (select app.service_reads_attendance('absences.read'))))
        );
  END IF;
END
$$;
