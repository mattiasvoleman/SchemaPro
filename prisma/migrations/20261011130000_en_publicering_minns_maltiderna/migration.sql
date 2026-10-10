-- En publicering minns måltiderna.
--
-- In DRAFT the lunch sittings are part of the draft, the same as the master
-- lessons. 20261011100000 recreated every LunchSittings arm that admits a
-- non-admin with the publish predicate, because a regenerated grundschema
-- comes with regenerated sittings that fit the draft's lessons and not the
-- published ones. The published meals are the calendar's (CalendarLunches),
-- just as the published lessons are CalendarLessons.
--
-- Two writers broke that. The review reproduced both on a real-dated
-- school:
--
--   * A regeneration in DRAFT purged every future CalendarLunch of the year
--     (OptimizationProxyService.replaceSittings) while correctly leaving the
--     calendar lessons alone. Pupils, guardians, teachers, the mobile app and
--     the public viewer's meal band lost every meal at once, and got them back
--     only on the next publish. 175 future meals became 0 for each role. The
--     API now skips that purge in DRAFT; no migration is needed for that.
--   * A refill re-materialises the PUBLISHED lesson snapshot of each segment.
--     The meals, however, were still read from LunchSittings, the draft. A
--     hand-placed draft sitting reached the published calendar through an
--     operation documented as "never the draft", while the same pupil could
--     read no sitting at all.
--
-- A refill can only restore the published meals if a publication remembers
-- them. PublishedLunchSittings is that memory, written beside PublishedLessons
-- by every publication that writes a snapshot (a BASELINE, a DRAFT publish).
-- A refill hands each segment's rows to the materialiser in place of the
-- year's sittings, the way it already hands it the lesson snapshot.
--
-- The rows have the LunchSittings shape the materialiser reads: a group, a
-- weekday, a start and an end. There is no FK to the group, for the reason
-- PublishedLessons has none: a snapshot must stay what was published while
-- the group is edited or deleted. A reader drops a row whose group no longer
-- exists, as the live CASCADE would have. Each row belongs to its
-- publication through the (id, academicYearId, schoolId) key, ON DELETE
-- CASCADE, so a deleted year or school takes its snapshot with it.
--
-- The table is append-only by privilege: app_authenticated holds SELECT and
-- INSERT only. Unlike PublishedLessons there is no erasure UPDATE, because a
-- meal names no person.
--
-- Row-level security: the school's SCHOOL_ADMIN reads and inserts, in USING
-- and in WITH CHECK. The only reader is the refill, which is the admin's.
-- There is no TEACHER, STUDENT, GUARDIAN or service arm. Families read their
-- meals from CalendarLunches, as before. Grants are guarded; anon holds
-- nothing; authenticated and service_role hold no write.
--
-- A DRAFT publish written before this migration has no rows here, and a
-- refill over such a segment writes no meal; it never writes the draft's.
-- No school publishes in DRAFT before this deploy, because the draft layer
-- arrives in the same release.

CREATE TABLE "PublishedLunchSittings" (
    "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"       UUID NOT NULL,
    "publicationId"  UUID NOT NULL,
    "academicYearId" UUID NOT NULL,
    "studentGroupId" UUID NOT NULL,
    "dayOfWeek"      INTEGER NOT NULL,
    "startTime"      TIME(6) NOT NULL,
    "endTime"        TIME(6) NOT NULL,

    CONSTRAINT "PublishedLunchSittings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PublishedLunchSittings_day_is_a_weekday" CHECK ("dayOfWeek" BETWEEN 1 AND 7),
    CONSTRAINT "PublishedLunchSittings_times_are_ordered" CHECK ("startTime" < "endTime")
);

-- One meal per class and weekday, as LunchSittings_group_day_key says of the live table.
CREATE UNIQUE INDEX "PublishedLunchSittings_publicationId_studentGroupId_dayOfWeek_key"
    ON "PublishedLunchSittings"("publicationId", "studentGroupId", "dayOfWeek");
CREATE INDEX "PublishedLunchSittings_schoolId_idx" ON "PublishedLunchSittings"("schoolId");

ALTER TABLE "PublishedLunchSittings"
    ADD CONSTRAINT "PublishedLunchSittings_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PublishedLunchSittings"
    ADD CONSTRAINT "PublishedLunchSittings_publicationId_academicYearId_schoolId_fkey"
    FOREIGN KEY ("publicationId", "academicYearId", "schoolId")
    REFERENCES "TimetablePublications"("id", "academicYearId", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PublishedLunchSittings" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "published_lunch_sittings_admin_select" ON "PublishedLunchSittings"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
CREATE POLICY "published_lunch_sittings_admin_insert" ON "PublishedLunchSittings"
    FOR INSERT TO "authenticated"
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT SELECT, INSERT ON "PublishedLunchSittings" TO "app_authenticated";
    REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "PublishedLunchSittings" FROM "app_authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "PublishedLunchSittings" FROM "authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "PublishedLunchSittings" FROM "anon";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "PublishedLunchSittings" FROM "service_role";
  END IF;
END
$$;
