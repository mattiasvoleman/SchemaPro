-- En lärare ser frånvaron men inte anteckningen.
--
-- 20260713170100 gave every TEACHER of the school a SELECT arm on whole
-- AbsenceReports rows (absence_reports_staff_select). The row carries `note`,
-- the free text a guardian or an adult pupil writes to the school when they
-- report an absence: "feber", but also a hospital visit, a funeral or
-- something at home. Its `type` says SICK, APPOINTMENT or OTHER. Web and
-- mobile read and write the table straight through PostgREST for the
-- guardian, so `authenticated` holds SELECT on it (20260806000000) and must
-- keep it. The arm was the only fence, and a teacher's own Supabase session
-- read every note of the school, about pupils the teacher never meets.
--
-- A teacher's only use of the table is attendance: which pupils of a lesson
-- were reported absent in advance, so the list opens with them marked
-- Anmäld frånvaro (/teacher/attendance/[lessonId]), and the guardian alert
-- for an ABSENT mark that no report covers (AttendanceService). Both need
-- who, which day and which wall-clock times. Neither needs the note or the
-- type, and no screen ever showed a teacher either. So:
--
--   * absence_reports_staff_select is dropped. A TEACHER reads no row of the
--     table. Its SCHOOL_ADMIN half is already absence_reports_admin_all; the
--     guardian's and the pupil's arms are unchanged.
--   * app.reported_absences(day) answers ("studentId", "startTime",
--     "endTime") of the day's reports at the caller's school, and nothing
--     else. It is SECURITY DEFINER because the table is no longer the
--     teacher's. It admits a TEACHER or a SCHOOL_ADMIN of the school; anyone
--     else gets no rows. The gateway asks it for both readers, the admin
--     included, so the rule has one place, as with
--     app.publication_snapshot_ranges (20261011131000).
--
-- EXECUTE is granted to app_authenticated (guarded) and revoked from PUBLIC,
-- anon, authenticated and service_role. The teacher's page asks the gateway
-- (GET /api/v1/attendance/lessons/:id/reported-absences), which answers only
-- for a lesson the teacher is assigned to and only with pupils on its roster.

DROP POLICY "absence_reports_staff_select" ON "AbsenceReports";

CREATE FUNCTION app.reported_absences(day date)
RETURNS TABLE ("studentId" uuid, "startTime" time, "endTime" time)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT a."studentId", a."startTime", a."endTime"
    FROM "AbsenceReports" a
   WHERE a."date" = day
     AND a."schoolId" = app.current_school_id()
     AND app.current_user_role() IN ('TEACHER', 'SCHOOL_ADMIN')
   ORDER BY a."studentId", a."startTime" NULLS FIRST, a."endTime"
$$;

REVOKE ALL ON FUNCTION app.reported_absences(date) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT EXECUTE ON FUNCTION app.reported_absences(date) TO "app_authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION app.reported_absences(date) FROM "anon";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION app.reported_absences(date) FROM "authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE ALL ON FUNCTION app.reported_absences(date) FROM "service_role";
  END IF;
END
$$;
