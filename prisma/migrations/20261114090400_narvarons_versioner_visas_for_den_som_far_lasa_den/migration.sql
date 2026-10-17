-- Närvarons versioner visas för den som får läsa den: Ss12000EntityVersions
-- take 'Attendance' and 'Absence' (20261114090000), and 'AttendancePupil'
-- and 'AbsencePupil', a pupil's row that moves all their records (linked or
-- back), and the service principal's arm answers a row of either kind only
-- to a request that may read that resource (app.service_reads_attendance),
-- so a key without the scope does not learn even their ids and times.
--
-- One table, taken NOWAIT and retried every 50 ms for 30 s as
-- 20261114090000 takes its own, so this transaction is in no cycle and no
-- request queues behind it while it waits for Ss12000EntityVersions. The
-- new CHECK is a superset of the old and added NOT VALID, so the lock is
-- held for no scan of the table; every row is validated by 20261114090600,
-- under a lock that blocks no one.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Ss12000EntityVersions" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Ss12000EntityVersions was not free in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

ALTER TABLE "Ss12000EntityVersions" DROP CONSTRAINT "Ss12000EntityVersions_resource_is_emitted";
ALTER TABLE "Ss12000EntityVersions"
    ADD CONSTRAINT "Ss12000EntityVersions_resource_is_emitted" CHECK ("resource" IN
        ('Organisation', 'Person', 'Group', 'Duty', 'Activity', 'CalendarEvent', 'Room', 'Syllabus',
         'Attendance', 'Absence', 'AttendancePupil', 'AbsencePupil')) NOT VALID;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'Ss12000EntityVersions' AND policyname = 'ss12000_entity_versions_service_select') THEN
    ALTER POLICY "ss12000_entity_versions_service_select" ON "Ss12000EntityVersions"
        USING (
            "schoolId" = app.current_service_school_id()
            AND ("resource" NOT IN ('Attendance', 'Absence', 'AttendancePupil', 'AbsencePupil')
                 OR ("resource" IN ('Attendance', 'AttendancePupil') AND (select app.service_reads_attendance('attendances.read')))
                 OR ("resource" IN ('Absence', 'AbsencePupil') AND (select app.service_reads_attendance('absences.read'))))
        );
  END IF;
END
$$;
