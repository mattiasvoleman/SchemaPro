-- Ett utkast rör inte det som redan har hänt.
--
-- CalendarLessons.masterLessonId is ON DELETE SET NULL. In a DRAFT school
-- the deletion of a master lesson is a draft, but the database acts on it at
-- once: every calendar row of that template loses its key, the past rows
-- with the rest. 20261011100000's trigger recorded only rows that had not
-- begun and had no attendance (PublicationPendingRemovals), so the
-- published-key fallback, coalesce(cl."masterLessonId", ppr."masterLessonId"),
-- found nothing for the past ones. The review reproduced this on a
-- real-dated school (läsår 2026-08-17..2027-06-11, today 2026-10-10). After
-- a draft delete of M3, and before any publish, SS12000 calendarEvents
-- answered activityId null for M3's eight past lessons (2026-08-20 to
-- 2026-10-08) instead of M3. The kommun's lesson export changed because of a
-- draft. Staffing statement C, run as a TEACHER, keys past substituted rows
-- the same way, so it would drop them as well. The probe's B2 row could not
-- see it: its 2096 school has no past rows.
--
-- The trigger now records EVERY calendar row of the deleted template in a
-- DRAFT school, past and attended ones included. "reconcilable" says
-- whether a publish may still move or delete the row: SCHEDULED, not begun
-- and without attendance. A past row is only ever RELEASED, never deleted.
-- The publish that publishes the deletion releases it (it leaves the master
-- out of its snapshot; PublicationsService), because from then on DIRECT's
-- answer applies: the row is an orphan. A discard relinks it to the
-- restored master, as before. A switch back to DIRECT releases what has
-- begun, as before.
--
-- Everything else is unchanged. The function keeps its name, owner, SECURITY
-- DEFINER and search_path. The pg_trigger_depth() > 1 early return stays: a
-- cascade needs no record. The DIRECT early return stays: a DIRECT school
-- records nothing. Only the row filter and the meaning of reconcilable
-- change. The trigger itself is not recreated.

CREATE OR REPLACE FUNCTION app.master_lessons_record_pending_removals() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  -- A cascade (a läsår or a school deleted) needs no record, and could not
  -- keep one: the calendar rows go in the same cascade.
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  IF app.school_publish_mode(OLD."schoolId") <> 'DRAFT' THEN
    RETURN OLD;
  END IF;
  PERFORM set_config('app.recording_pending_removals', 'on', true);
  INSERT INTO "PublicationPendingRemovals" ("calendarLessonId", "schoolId", "academicYearId", "masterLessonId", "reconcilable")
  SELECT cl."id", cl."schoolId", OLD."academicYearId", OLD."id",
         cl."status" = 'SCHEDULED'
         AND cl."startsAt" > now()
         AND NOT EXISTS (SELECT 1 FROM "AttendanceRecords" a WHERE a."calendarLessonId" = cl."id")
    FROM "CalendarLessons" cl
   WHERE cl."masterLessonId" = OLD."id"
     AND cl."schoolId" = OLD."schoolId"
  ON CONFLICT ("calendarLessonId") DO NOTHING;
  PERFORM set_config('app.recording_pending_removals', 'off', true);
  RETURN OLD;
END
$$;

REVOKE ALL ON FUNCTION app.master_lessons_record_pending_removals() FROM PUBLIC;
