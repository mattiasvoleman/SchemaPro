-- En lärare ser bara publiceringens giltighet.
--
-- 20261011090000 gave every TEACHER of the school a SELECT arm on whole
-- TimetablePublications rows (timetable_publications_staff_select). The
-- preamble's reason was that the rows "name lessons, teachers, groups and
-- rooms the teacher already reads in the calendar". The gates column breaks
-- that. It holds the list the admin was shown before a publish, computed
-- from the DRAFT, and the log keeps REFUSED attempts too. The review
-- reproduced it on a DRAFT school with gateWeekSplit = REFUSE: a refused
-- publish logged PUB_WEEK_SPLIT "Ma · 7A: tors → mån". A second teacher then
-- read that row through Prisma, with the draft change named, while the same
-- teacher saw 0 master lessons. The column also stores PUB_STAFFING_REFUSE
-- labels when a staffing check is set to REFUSE: a colleague's name with "över
-- mål" or "saknar behörighet", which is HR data. The draft predicate exists
-- to keep such drafts from a teacher.
--
-- A teacher's only use of the log is the validity of the snapshot
-- publications (published-grundschema.ts snapshotRanges): which published
-- grundschema is valid when, to read the right PublishedLessons. That is
-- four columns of PUBLISHED, snapshotted, non-REFILL rows. So:
--
--   * timetable_publications_staff_select is dropped. A TEACHER reads no
--     row of the log: no gates, no counts, no refusals and no admin id.
--   * app.publication_snapshot_ranges(year) answers (id, publishedAt,
--     validFrom, validTo) of the year's snapshot publications, earliest
--     first, and nothing else. It is SECURITY DEFINER because the table is
--     the admin's. It admits the caller's own school only: a TEACHER or a
--     SCHOOL_ADMIN of the school, or the SS12000 service principal for the
--     school it acts for. Anyone else gets no rows. Every reader of
--     snapshotRanges asks it, the admin included, so the rule has one
--     place.
--
-- The PublishedLessons staff arm is unchanged. A snapshot is the published
-- grundschema, which is what a teacher may see.
--
-- EXECUTE is granted to app_authenticated (guarded) and revoked from PUBLIC,
-- anon, authenticated and service_role, as for the lock functions.

DROP POLICY "timetable_publications_staff_select" ON "TimetablePublications";

CREATE FUNCTION app.publication_snapshot_ranges(year uuid)
RETURNS TABLE ("id" uuid, "publishedAt" timestamptz, "validFrom" date, "validTo" date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT p."id", p."publishedAt", p."validFrom", p."validTo"
    FROM "TimetablePublications" p
   WHERE p."academicYearId" = year
     AND p."outcome" = 'PUBLISHED'
     AND p."lessonCount" IS NOT NULL
     AND p."kind" <> 'REFILL'
     AND (
           (p."schoolId" = app.current_school_id() AND app.current_user_role() IN ('TEACHER', 'SCHOOL_ADMIN'))
        OR p."schoolId" = app.current_service_school_id()
     )
   ORDER BY p."publishedAt", p."id"
$$;

REVOKE ALL ON FUNCTION app.publication_snapshot_ranges(uuid) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT EXECUTE ON FUNCTION app.publication_snapshot_ranges(uuid) TO "app_authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION app.publication_snapshot_ranges(uuid) FROM "anon";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION app.publication_snapshot_ranges(uuid) FROM "authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE ALL ON FUNCTION app.publication_snapshot_ranges(uuid) FROM "service_role";
  END IF;
END
$$;
