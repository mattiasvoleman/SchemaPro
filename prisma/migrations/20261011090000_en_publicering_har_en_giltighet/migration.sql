-- En publicering har en giltighet.
--
-- Until now "publishing" was one verb with no record: POST /calendar/publish
-- materialised the grundschema into CalendarLessons over a window, answered
-- created/cancelled/skipped, and left nothing behind but the rows. Nobody
-- could say which schedule was valid from when, who published it, or what the
-- admin was warned about before doing so. Skola24 has "Giltig fr.o.m./t.o.m."
-- and a "Får publiceras" gate; aSc keeps validity ranges per timetable; Lectio
-- keeps drafts private until "Frigiv". This migration gives SchemaPro the
-- record and the policy those three rest on. The draft layer itself is the
-- next migration (20261011100000); nothing here changes what anybody reads.
--
-- ## The calendar stays the published state
--
-- CalendarLessons already ARE the published timetable: every non-admin read,
-- web and mobile, goes through them and never through MasterLessons. A second
-- copy of the published lessons would be a second truth to keep in step with
-- the first. So a publication is a LOG ROW with a validity range, and the
-- range says which publication materialised the calendar over which dates:
-- "valid when" for a date is the latest PUBLISHED row, by (publishedAt, id),
-- whose [validFrom, validTo] contains it (src/publication/publication-validity.ts).
-- An HT and a VT publication are two rows with two ranges.
--
-- ## Three tables
--
-- PublicationSettings: at most one row per school, and NO ROW MEANS EVERY
-- DEFAULT. publishMode DIRECT is today's behaviour — every grundschema edit
-- reaches the calendar at once, as now — and a school that never opens the
-- settings never has a row, so nothing it reads can change. The gate columns
-- are the school's "Får publiceras" policy, one per named check, WARN or
-- REFUSE, every one WARN by default: a WARN asks the admin for a deliberate
-- "Publicera ändå" and refuses nothing, so nothing that works today is
-- refused until a school chooses so. The public viewer's columns arrive with
-- the viewer (20261011120000).
--
-- TimetablePublications: one row per publish attempt that reached the gates,
-- PUBLISHED or REFUSED. kind says which door: PUBLISH (POST /publications),
-- LEGACY_PUBLISH (the old POST /calendar/publish, logged, unchanged
-- otherwise), BASELINE (the snapshot a switch to DRAFT records of what is
-- already published) and REFILL (a DRAFT school re-materialising its
-- published snapshot after a lov is narrowed; 20261011100000). The counts are
-- the calendar's answer; gates is the list the admin saw, acknowledged says
-- they pressed "Publicera ändå". publishedByUserId is SET NULL on that column
-- only: the log outlives a removed admin, as TimplanStatementPublications'
-- does. APPEND-ONLY BY PRIVILEGE: app_authenticated holds SELECT and INSERT
-- and nothing else, so neither the API nor a PostgREST call can rewrite what
-- was published; cascades from the school and the year still remove it,
-- because referential actions run as the table owner.
--
-- PublishedLessons: the grundschema a DRAFT publication published — the
-- ScheduleVersion lesson shape as columns, plus the master lesson's id (no
-- FK: the master may be edited, deleted or recreated while its published row
-- must stay what was published). Only DRAFT publications write rows; DIRECT
-- needs none, because there the masters ARE what is published. Readers that
-- must not see a draft read these rows instead of MasterLessons
-- (20261011100000), and map a reference that no longer exists the way the
-- live foreign key would have acted. Append-only like its publication, with
-- ONE exception: an erasure — dropping ids from studentIds, or nulling a
-- teacher — so a removed person can be scrubbed from a snapshot. The guard
-- refuses every other UPDATE.
--
-- ## Constraints mirror the DTOs
--
-- validFrom <= validTo, both inside the publication's läsår (a constraint
-- trigger: the year's bounds live in another table). Counts are 0..1e6.
-- gates is a JSON array. The snapshot's times are ordered, dayOfWeek 1..7.
--
-- ## Row-level security
--
--   * publication_settings_admin_all: the school's SCHOOL_ADMIN, USING and
--     WITH CHECK. Nobody else reads the policy; readers that must know the
--     mode ask app.school_publish_mode() (20261011100000), which answers one
--     word and nothing else.
--   * *_admin_select / *_admin_insert: the SCHOOL_ADMIN publishes and reads
--     the timeline.
--   * *_staff_select: a TEACHER of the school reads the publications and
--     their lessons — the published grundschema IS what a teacher may see,
--     and the teacher figure endpoints read it in DRAFT. The rows name
--     lessons, teachers, groups and rooms the teacher already reads in the
--     calendar, and an admin's user id they already read in Users.
--   * *_service_select: the SS12000 service principal, its school only, for
--     /activities in DRAFT.
--
-- No STUDENT or GUARDIAN arm anywhere: families read the calendar. GRANTs to
-- app_authenticated guarded; anon holds nothing; authenticated and
-- service_role hold no write, TRUNCATE, REFERENCES or TRIGGER.

CREATE TYPE "PublishMode" AS ENUM ('DIRECT', 'DRAFT');
CREATE TYPE "PublishGateMode" AS ENUM ('WARN', 'REFUSE');
CREATE TYPE "PublicationKind" AS ENUM ('PUBLISH', 'LEGACY_PUBLISH', 'BASELINE', 'REFILL');
CREATE TYPE "PublicationOutcome" AS ENUM ('PUBLISHED', 'REFUSED');

CREATE TABLE "PublicationSettings" (
    "id"                 UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"           UUID NOT NULL,
    "publishMode"        "PublishMode" NOT NULL DEFAULT 'DIRECT',
    "gateClashes"        "PublishGateMode" NOT NULL DEFAULT 'WARN',
    "gateParked"         "PublishGateMode" NOT NULL DEFAULT 'WARN',
    "gateUnplaced"       "PublishGateMode" NOT NULL DEFAULT 'WARN',
    "gateUnstaffed"      "PublishGateMode" NOT NULL DEFAULT 'WARN',
    "gateMissingTeacher" "PublishGateMode" NOT NULL DEFAULT 'WARN',
    "gateMissingRoom"    "PublishGateMode" NOT NULL DEFAULT 'WARN',
    "gateStaffing"       "PublishGateMode" NOT NULL DEFAULT 'WARN',
    "gateTimplan"        "PublishGateMode" NOT NULL DEFAULT 'WARN',
    "gateOverlap"        "PublishGateMode" NOT NULL DEFAULT 'WARN',
    "gatePast"           "PublishGateMode" NOT NULL DEFAULT 'WARN',
    "gateLunch"          "PublishGateMode" NOT NULL DEFAULT 'WARN',
    "gateWeekSplit"      "PublishGateMode" NOT NULL DEFAULT 'WARN',
    "gateGap"            "PublishGateMode" NOT NULL DEFAULT 'WARN',
    "gateDayOpsLost"     "PublishGateMode" NOT NULL DEFAULT 'WARN',
    "createdAt"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "PublicationSettings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PublicationSettings_schoolId_key" ON "PublicationSettings"("schoolId");

ALTER TABLE "PublicationSettings"
    ADD CONSTRAINT "PublicationSettings_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TimetablePublications" (
    "id"                   UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"             UUID NOT NULL,
    "academicYearId"       UUID NOT NULL,
    "kind"                 "PublicationKind" NOT NULL,
    "outcome"              "PublicationOutcome" NOT NULL,
    "publishMode"          "PublishMode" NOT NULL,
    "validFrom"            DATE NOT NULL,
    "validTo"              DATE NOT NULL,
    "publishedAt"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "publishedByUserId"    UUID,
    "created"              INTEGER NOT NULL DEFAULT 0,
    "cancelled"            INTEGER NOT NULL DEFAULT 0,
    "skipped"              INTEGER NOT NULL DEFAULT 0,
    "moved"                INTEGER NOT NULL DEFAULT 0,
    "removed"              INTEGER NOT NULL DEFAULT 0,
    "adopted"              INTEGER NOT NULL DEFAULT 0,
    "lessonCount"          INTEGER,
    "gates"                JSONB NOT NULL DEFAULT '[]',
    "acknowledgedWarnings" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "TimetablePublications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TimetablePublications_range_is_ordered" CHECK ("validFrom" <= "validTo"),
    CONSTRAINT "TimetablePublications_counts_are_sane" CHECK (
        "created" BETWEEN 0 AND 1000000 AND "cancelled" BETWEEN 0 AND 1000000
        AND "skipped" BETWEEN 0 AND 1000000 AND "moved" BETWEEN 0 AND 1000000
        AND "removed" BETWEEN 0 AND 1000000 AND "adopted" BETWEEN 0 AND 1000000
        AND ("lessonCount" IS NULL OR "lessonCount" BETWEEN 0 AND 1000000)
    ),
    CONSTRAINT "TimetablePublications_gates_is_a_list" CHECK (jsonb_typeof("gates") = 'array'),
    -- A refused attempt materialised nothing.
    CONSTRAINT "TimetablePublications_refused_wrote_nothing" CHECK (
        "outcome" = 'PUBLISHED'
        OR ("created" = 0 AND "cancelled" = 0 AND "moved" = 0 AND "removed" = 0 AND "adopted" = 0 AND "lessonCount" IS NULL)
    )
);

CREATE UNIQUE INDEX "TimetablePublications_id_schoolId_key" ON "TimetablePublications"("id", "schoolId");
-- The target of PublishedLessons' key: a snapshot row's year is its publication's.
CREATE UNIQUE INDEX "TimetablePublications_id_academicYearId_schoolId_key"
    ON "TimetablePublications"("id", "academicYearId", "schoolId");
CREATE INDEX "TimetablePublications_academicYearId_schoolId_publishedAt_idx"
    ON "TimetablePublications"("academicYearId", "schoolId", "publishedAt");
CREATE INDEX "TimetablePublications_publishedByUserId_schoolId_idx"
    ON "TimetablePublications"("publishedByUserId", "schoolId");

ALTER TABLE "TimetablePublications"
    ADD CONSTRAINT "TimetablePublications_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TimetablePublications"
    ADD CONSTRAINT "TimetablePublications_academicYearId_schoolId_fkey"
    FOREIGN KEY ("academicYearId", "schoolId") REFERENCES "AcademicYears"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TimetablePublications"
    ADD CONSTRAINT "TimetablePublications_publishedByUserId_schoolId_fkey"
    FOREIGN KEY ("publishedByUserId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE SET NULL ("publishedByUserId") ON UPDATE NO ACTION;

CREATE TABLE "PublishedLessons" (
    "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"       UUID NOT NULL,
    "publicationId"  UUID NOT NULL,
    "academicYearId" UUID NOT NULL,
    "masterLessonId" UUID NOT NULL,
    "subjectId"      UUID NOT NULL,
    "studentGroupId" UUID NOT NULL,
    "teacherId"      UUID,
    "coTeacherId"    UUID,
    "roomId"         UUID,
    "dayOfWeek"      INTEGER NOT NULL,
    "startTime"      TIME(6) NOT NULL,
    "endTime"        TIME(6) NOT NULL,
    "isLocked"       BOOLEAN NOT NULL,
    "isGenerated"    BOOLEAN NOT NULL,
    "isParked"       BOOLEAN NOT NULL,
    "recurrence"     "LessonRecurrence" NOT NULL,
    "startDate"      DATE,
    "endDate"        DATE,
    "extraGroupIds"  UUID[] NOT NULL DEFAULT '{}',
    "studentIds"     UUID[] NOT NULL DEFAULT '{}',

    CONSTRAINT "PublishedLessons_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PublishedLessons_day_is_a_weekday" CHECK ("dayOfWeek" BETWEEN 1 AND 7),
    CONSTRAINT "PublishedLessons_times_are_ordered" CHECK ("startTime" < "endTime"),
    CONSTRAINT "PublishedLessons_window_is_ordered" CHECK ("startDate" IS NULL OR "endDate" IS NULL OR "startDate" <= "endDate")
);

CREATE UNIQUE INDEX "PublishedLessons_publicationId_masterLessonId_key"
    ON "PublishedLessons"("publicationId", "masterLessonId");
CREATE INDEX "PublishedLessons_schoolId_idx" ON "PublishedLessons"("schoolId");

ALTER TABLE "PublishedLessons"
    ADD CONSTRAINT "PublishedLessons_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PublishedLessons"
    ADD CONSTRAINT "PublishedLessons_publicationId_academicYearId_schoolId_fkey"
    FOREIGN KEY ("publicationId", "academicYearId", "schoolId")
    REFERENCES "TimetablePublications"("id", "academicYearId", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Guards. See the preamble.
-- ---------------------------------------------------------------------------

-- The range lies inside its läsår, judged once, when the row is written: a
-- year whose bounds move later does not unpublish what was published.
CREATE FUNCTION app.timetable_publications_range_in_year() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  bounds record;
BEGIN
  SELECT y."startDate", y."endDate" INTO bounds
    FROM "AcademicYears" y
   WHERE y."id" = NEW."academicYearId" AND y."schoolId" = NEW."schoolId";
  IF NOT FOUND THEN
    RETURN NULL; -- the foreign key's to refuse
  END IF;
  IF NEW."validFrom" < bounds."startDate" OR NEW."validTo" > bounds."endDate" THEN
    RAISE EXCEPTION 'PUBLICATION_RANGE_OUTSIDE_YEAR: en publicerings giltighet ligger inom läsåret'
      USING ERRCODE = 'PB409',
            DETAIL  = format('timetablePublicationId=%s', NEW."id");
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "TimetablePublications_range_in_year"
    AFTER INSERT ON "TimetablePublications"
    FOR EACH ROW EXECUTE FUNCTION app.timetable_publications_range_in_year();

-- A snapshot is what was published. The one UPDATE allowed is an erasure:
-- studentIds may only lose ids, a teacher may only become null, and nothing
-- else may move.
CREATE FUNCTION app.published_lessons_only_erase() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF NOT (NEW."studentIds" <@ OLD."studentIds")
     OR (NEW."teacherId" IS DISTINCT FROM OLD."teacherId" AND NEW."teacherId" IS NOT NULL)
     OR (NEW."coTeacherId" IS DISTINCT FROM OLD."coTeacherId" AND NEW."coTeacherId" IS NOT NULL)
     OR (ROW(NEW."id", NEW."schoolId", NEW."publicationId", NEW."academicYearId", NEW."masterLessonId",
             NEW."subjectId", NEW."studentGroupId", NEW."roomId", NEW."dayOfWeek", NEW."startTime",
             NEW."endTime", NEW."isLocked", NEW."isGenerated", NEW."isParked", NEW."recurrence",
             NEW."startDate", NEW."endDate", NEW."extraGroupIds")
         IS DISTINCT FROM
         ROW(OLD."id", OLD."schoolId", OLD."publicationId", OLD."academicYearId", OLD."masterLessonId",
             OLD."subjectId", OLD."studentGroupId", OLD."roomId", OLD."dayOfWeek", OLD."startTime",
             OLD."endTime", OLD."isLocked", OLD."isGenerated", OLD."isParked", OLD."recurrence",
             OLD."startDate", OLD."endDate", OLD."extraGroupIds")) THEN
    RAISE EXCEPTION 'PUBLISHED_LESSON_IS_FIXED: en publicerad lektion ändras inte, den kan bara rensas på en person'
      USING ERRCODE = 'PB409',
            DETAIL  = format('publishedLessonId=%s', OLD."id");
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PublishedLessons_only_erase"
    BEFORE UPDATE ON "PublishedLessons"
    FOR EACH ROW EXECUTE FUNCTION app.published_lessons_only_erase();

REVOKE ALL ON FUNCTION app.timetable_publications_range_in_year() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.published_lessons_only_erase() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Row-level security. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "PublicationSettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TimetablePublications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PublishedLessons" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "publication_settings_admin_all" ON "PublicationSettings"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

CREATE POLICY "timetable_publications_admin_select" ON "TimetablePublications"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
CREATE POLICY "timetable_publications_admin_insert" ON "TimetablePublications"
    FOR INSERT TO "authenticated"
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
CREATE POLICY "timetable_publications_staff_select" ON "TimetablePublications"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'TEACHER');
CREATE POLICY "timetable_publications_service_select" ON "TimetablePublications"
    FOR SELECT
    USING ("schoolId" = app.current_service_school_id());

CREATE POLICY "published_lessons_admin_select" ON "PublishedLessons"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
CREATE POLICY "published_lessons_admin_insert" ON "PublishedLessons"
    FOR INSERT TO "authenticated"
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
CREATE POLICY "published_lessons_admin_erase" ON "PublishedLessons"
    FOR UPDATE TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
CREATE POLICY "published_lessons_staff_select" ON "PublishedLessons"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'TEACHER');
CREATE POLICY "published_lessons_service_select" ON "PublishedLessons"
    FOR SELECT
    USING ("schoolId" = app.current_service_school_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "PublicationSettings" TO "app_authenticated";
    -- Append-only: see the preamble.
    GRANT SELECT, INSERT ON "TimetablePublications" TO "app_authenticated";
    REVOKE UPDATE, DELETE ON "TimetablePublications" FROM "app_authenticated";
    GRANT SELECT, INSERT, UPDATE ON "PublishedLessons" TO "app_authenticated";
    REVOKE DELETE ON "PublishedLessons" FROM "app_authenticated";
    REVOKE TRUNCATE, REFERENCES, TRIGGER ON "PublicationSettings", "TimetablePublications", "PublishedLessons" FROM "app_authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "TimetablePublications" FROM "authenticated";
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON "PublishedLessons" FROM "authenticated";
    REVOKE TRUNCATE, REFERENCES, TRIGGER ON "PublicationSettings" FROM "authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "PublicationSettings", "TimetablePublications", "PublishedLessons" FROM "anon";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
        ON "PublicationSettings", "TimetablePublications", "PublishedLessons" FROM "service_role";
  END IF;
END
$$;
