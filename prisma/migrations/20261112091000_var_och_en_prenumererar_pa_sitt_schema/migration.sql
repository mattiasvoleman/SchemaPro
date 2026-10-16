-- Var och en prenumererar på sitt schema.
--
-- Kalenderprenumeration: a teacher, a pupil and a guardian (per child) may
-- each have a personal calendar feed of their PUBLISHED week, behind a
-- secret address a calendar app asks without signing in. The school turns
-- feeds on per audience; all three are off until it does, and turning one
-- off again revokes every feed of that audience.
--
-- ## The school's choice: PublicationSettings
--
--   calendarFeedTeachers, calendarFeedStudents, calendarFeedGuardians
--       false by default. Switching one from true to false revokes the
--       audience's live feeds in the same statement (a trigger, so no path
--       to the setting can forget it), and the feed's door asks the switch
--       again on every read: a feed of an audience that is off answers
--       nothing, revoked or not.
--
-- ## The feeds: CalendarFeeds
--
-- One row per address. Only the address's sha256 is stored (tokenHash), as
-- for Schemavisaren's links: the address is shown once, when it is made, and
-- cannot be read back. A person has at most one live feed per week (their
-- own, or each child's): making a new address revokes the old one in the
-- same transaction, so "regenerate" is "create". The owner reads their own
-- rows through the API (calendar_feeds_owner_select, the API's role only);
-- nobody writes them except the definer functions below, and PostgREST's
-- role reads and writes nothing.
--
--   audience   TEACHER (TEACHER or SCHOOL_ADMIN: the lessons they teach),
--              STUDENT (the pupil's own week, studentId = userId) or
--              GUARDIAN (a child's week, studentId the child);
--   locale     the language the feed speaks ("Inställd", "Vikarie"), the
--              one the address was made in;
--   lastUsedAt when a calendar last asked, at most every five minutes, as
--              Schemavisaren marks its links;
--   recordedOn the school day a guardian's feed was last written to the
--              read log (below).
--
-- ## What a feed shows: app.calendar_feed()
--
-- One SECURITY DEFINER door, keyed by the address's hash and asked with no
-- principal, as app.public_timetable is: the calendar app signs in as
-- nobody. It answers NULL unless the feed is live, its audience is on, its
-- owner is active and still what the feed was made for (a teacher still
-- staff, a guardian still the child's, the child still an active pupil).
-- Then the week from last week's Monday to a year ahead, as the person's own
-- pages show it and nothing more; a pupil's and a guardian's end with the
-- week of the active läsår's last day, where the family's week in the app
-- ends (FamilyScheduleService): next year's groups may be published before
-- the year is activated, and the family sees them only then.
--
--   * a TEACHER's lessons are those they are on in any role, a lesson they
--     cover marked as covered; the lesson's groups and the colleagues on it
--     (by name, never one whose identity is protected), the room. A lesson
--     of named pupils names none of them. Lov and studiedagar of the whole
--     school, as all-day entries;
--   * a STUDENT's and a GUARDIAN's are the child's, matched as the family's
--     week matches them (FamilyScheduleService): lessons the child is named
--     on, their teaching groups' lessons, and their home class's on the
--     dates the class history names that class. The teachers are named as
--     the school names them to families (app.family_lesson_labels, below);
--     a substituted lesson names nobody and is marked, a cancelled one
--     names nobody. No other pupil, no note, no cause. Lov and studiedagar
--     that cover the child's year;
--   * cancelled lessons stay, as cancelled, so a calendar marks them rather
--     than losing them; each lesson's own id is its UID (with whose week it
--     is, `scope`, so two children's shared lesson, or a teacher's own and
--     their child's, are two entries to a calendar holding both feeds), and
--     its version is the lesson row's updatedAt: what moves a lesson or
--     cancels it moves that (stamped by the API's clock as it writes, so it
--     grows as that clock does). A substitute added or taken off changes the
--     entry's text, which a calendar reads on every fetch.
--
-- The calendar is the published layer (20261011100000): a draft never
-- reaches it, and a publication writes only the days of its validity, so the
-- feed follows Publicering by reading nothing else.
--
-- ## The family's teachers, once: app.family_lesson_labels()
--
-- How a lesson's teachers are named outside the staff room was decided in
-- app.family_lesson_staff (20261013090000), keyed by the signed-in family.
-- The rule moves, line for line, into an internal function of the school and
-- the display; family_lesson_staff keeps its own reach (the caller's
-- children's lessons, or an admin's) and asks it, and so does the feed. A
-- family's week in the app and in a calendar cannot name teachers apart.
--
-- ## The read log
--
-- A guardian's feed is a read of the child's schedule, as the family's week
-- in the web and the app is (SCHEDULE): the other guardian may ask who has
-- read about the child, and a calendar that holds the child's week is an
-- answer. A calendar asks every few minutes, though, and a row per ask would
-- bury every other read of the child. So the door writes one row per feed
-- per school day it answers, channel CALENDAR (20261112090000), actor the
-- guardian: "the child's week went to this guardian's calendar on this day".
-- A teacher's feed names no pupil, and a pupil's is their own; neither is
-- written. The guardian's own reads in the web and the app are written as
-- before: app.personal_data_read's quarter-hour leaves CALENDAR rows out of
-- what it counts as already written, or a calendar's morning fetch would
-- hide the guardian opening the week in the app.
--
-- ## A feed ends with what it was made for
--
-- Revoked, not just silent, so nothing brings an old address back: an
-- audience switched off (above); an owner deactivated, or no longer of the
-- role the feed was made for; a pupil deactivated or no longer a pupil, for
-- every guardian's feed of them; a guardian's link to the child deleted.
-- Triggers on Users and GuardianStudents, so no path to the change can
-- forget it; calendar_feed_create locks the rows it decided on, so a feed
-- made in the same moment is either refused or revoked with the rest. The
-- door asks all of it again on every read, and ends a live feed it refuses,
-- for a change the triggers did not see.
--
-- ## Making and revoking: app.calendar_feed_create(), _revoke(), _counts()
--
-- The signed-in person (the API's role, by their claims) makes their own
-- feed: a teacher or an admin theirs, a pupil theirs, a guardian a child of
-- theirs, and only while the school has the audience on. The gateway draws
-- the address and passes its hash; a refusal is an answer, not an error.
-- Revoke is the owner's own live feed. The admin reads how many live feeds
-- each audience has, and nothing about whose; anyone signed in reads whether
-- their own audience is on, which PublicationSettings does not let them.
--
-- ## Grants
--
-- The door, create, revoke, counts and audience_on: the API's role only. The builders and
-- the label rule: nobody (they run inside the doors). RLS sections 144 to 147
-- assert the catalogue and who gets what.

-- ---------------------------------------------------------------------------
-- The school's choice, per audience.
-- ---------------------------------------------------------------------------

ALTER TABLE "PublicationSettings"
    ADD COLUMN "calendarFeedTeachers"  BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "calendarFeedStudents"  BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "calendarFeedGuardians" BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- The feeds.
-- ---------------------------------------------------------------------------

CREATE TYPE "CalendarFeedAudience" AS ENUM ('TEACHER', 'STUDENT', 'GUARDIAN');

CREATE TABLE "CalendarFeeds" (
    "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"   UUID NOT NULL,
    "userId"     UUID NOT NULL,
    "studentId"  UUID,
    "audience"   "CalendarFeedAudience" NOT NULL,
    "tokenHash"  TEXT NOT NULL,
    "locale"     TEXT NOT NULL DEFAULT 'sv',
    "createdAt"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "revokedAt"  TIMESTAMPTZ(6),
    "lastUsedAt" TIMESTAMPTZ(6),
    "recordedOn" DATE,

    CONSTRAINT "CalendarFeeds_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CalendarFeeds_token_is_a_sha256" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "CalendarFeeds_locale_is_known" CHECK ("locale" IN ('sv', 'en')),
    -- Whose week: a teacher's own, a pupil's own, a guardian's child's.
    CONSTRAINT "CalendarFeeds_whose_week" CHECK (
        ("audience" = 'TEACHER' AND "studentId" IS NULL)
        OR ("audience" = 'STUDENT' AND "studentId" = "userId")
        OR ("audience" = 'GUARDIAN' AND "studentId" IS NOT NULL AND "studentId" <> "userId")
    ),
    CONSTRAINT "CalendarFeeds_only_a_guardian_is_recorded" CHECK ("recordedOn" IS NULL OR "audience" = 'GUARDIAN')
);

CREATE UNIQUE INDEX "CalendarFeeds_tokenHash_key" ON "CalendarFeeds"("tokenHash");
-- One live feed per week a person may have.
CREATE UNIQUE INDEX "CalendarFeeds_one_live_feed_per_week"
    ON "CalendarFeeds"("userId", (coalesce("studentId", "userId"))) WHERE "revokedAt" IS NULL;
CREATE INDEX "CalendarFeeds_live_by_audience_idx" ON "CalendarFeeds"("schoolId", "audience") WHERE "revokedAt" IS NULL;
CREATE INDEX "CalendarFeeds_userId_schoolId_idx" ON "CalendarFeeds"("userId", "schoolId");
CREATE INDEX "CalendarFeeds_studentId_schoolId_idx" ON "CalendarFeeds"("studentId", "schoolId");

ALTER TABLE "CalendarFeeds"
    ADD CONSTRAINT "CalendarFeeds_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CalendarFeeds"
    ADD CONSTRAINT "CalendarFeeds_userId_schoolId_fkey"
    FOREIGN KEY ("userId", "schoolId") REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CalendarFeeds"
    ADD CONSTRAINT "CalendarFeeds_studentId_schoolId_fkey"
    FOREIGN KEY ("studentId", "schoolId") REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CalendarFeeds" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "calendar_feeds_owner_select" ON "CalendarFeeds"
    FOR SELECT TO "app_authenticated"
    USING ("userId" = (select app.current_user_id()) AND "schoolId" = (select app.current_school_id()));

-- ---------------------------------------------------------------------------
-- An audience switched off takes its feeds with it.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.calendar_feeds_follow_the_school() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE "CalendarFeeds" SET "revokedAt" = now()
     WHERE "schoolId" = OLD."schoolId" AND "revokedAt" IS NULL;
    RETURN NULL;
  END IF;
  UPDATE "CalendarFeeds" f SET "revokedAt" = now()
   WHERE f."schoolId" = NEW."schoolId"
     AND f."revokedAt" IS NULL
     AND ((f."audience" = 'TEACHER' AND NOT NEW."calendarFeedTeachers")
       OR (f."audience" = 'STUDENT' AND NOT NEW."calendarFeedStudents")
       OR (f."audience" = 'GUARDIAN' AND NOT NEW."calendarFeedGuardians"));
  RETURN NULL;
END
$$;

CREATE TRIGGER "PublicationSettings_calendar_feeds_follow"
    AFTER UPDATE OF "calendarFeedTeachers", "calendarFeedStudents", "calendarFeedGuardians" OR DELETE
    ON "PublicationSettings"
    FOR EACH ROW EXECUTE FUNCTION app.calendar_feeds_follow_the_school();

COMMENT ON FUNCTION app.calendar_feeds_follow_the_school() IS
  'Revokes the live calendar feeds of every audience the school''s settings have off (or all of the school''s, when its settings row goes).';

-- ---------------------------------------------------------------------------
-- A person who left, or is no longer what the feed was made for, takes it
-- with them; a guardian's link to the child, the child's feed.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.calendar_feeds_follow_the_person() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF TG_TABLE_NAME = 'GuardianStudents' THEN
    UPDATE "CalendarFeeds" SET "revokedAt" = now()
     WHERE "userId" = OLD."guardianId" AND "studentId" = OLD."studentId" AND "revokedAt" IS NULL;
    RETURN NULL;
  END IF;
  -- Their own feeds.
  UPDATE "CalendarFeeds" f SET "revokedAt" = now()
   WHERE f."userId" = NEW."id"
     AND f."revokedAt" IS NULL
     AND (NOT NEW."isActive"
       OR (f."audience" = 'TEACHER' AND NEW."role" NOT IN ('TEACHER', 'SCHOOL_ADMIN'))
       OR (f."audience" = 'STUDENT' AND NEW."role" <> 'STUDENT')
       OR (f."audience" = 'GUARDIAN' AND NEW."role" <> 'GUARDIAN'));
  -- Their week in a guardian's feed.
  IF NOT NEW."isActive" OR NEW."role" <> 'STUDENT' THEN
    UPDATE "CalendarFeeds" f SET "revokedAt" = now()
     WHERE f."studentId" = NEW."id" AND f."userId" <> NEW."id" AND f."revokedAt" IS NULL;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "Users_calendar_feeds_follow"
    AFTER UPDATE OF "isActive", "role" ON "Users"
    FOR EACH ROW
    WHEN (OLD."isActive" IS DISTINCT FROM NEW."isActive" OR OLD."role" IS DISTINCT FROM NEW."role")
    EXECUTE FUNCTION app.calendar_feeds_follow_the_person();

CREATE TRIGGER "GuardianStudents_calendar_feeds_follow"
    AFTER DELETE OR UPDATE OF "guardianId", "studentId" ON "GuardianStudents"
    FOR EACH ROW EXECUTE FUNCTION app.calendar_feeds_follow_the_person();

COMMENT ON FUNCTION app.calendar_feeds_follow_the_person() IS
  'Revokes the live calendar feeds a change to a person ends: their own when they leave or their role no longer fits the feed, every guardian''s of a pupil who leaves or stops being one, and a guardian''s of a child whose link goes.';

-- ---------------------------------------------------------------------------
-- The family's teachers, once (out of app.family_lesson_staff, 20261013090000).
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.family_lesson_labels(p_school uuid, p_display "TeacherDisplay", p_lesson_ids uuid[])
RETURNS TABLE (lesson_id uuid, substitute boolean, labels text[])
LANGUAGE sql STABLE SET search_path = "public", "pg_temp" AS $$
  WITH reach AS (
    SELECT cl."id", cl."schoolId", cl."studentGroupId", cl."status",
           EXISTS (SELECT 1 FROM "CalendarLessonTeachers" t
                    WHERE t."calendarLessonId" = cl."id" AND t."role" = 'SUBSTITUTE') AS has_substitute
      FROM "CalendarLessons" cl
     WHERE cl."id" = ANY (p_lesson_ids)
       AND cl."schoolId" = p_school
  )
  SELECT r."id",
         r."status" <> 'CANCELLED' AND r.has_substitute,
         CASE
           WHEN r."status" = 'CANCELLED' OR r.has_substitute OR p_display = 'NONE' THEN '{}'::text[]
           ELSE coalesce((
             SELECT array_agg(lbl ORDER BY lbl) FROM (
               SELECT CASE p_display
                        WHEN 'NAME' THEN u."firstName" || ' ' || u."lastName"
                        ELSE (SELECT e."signature" FROM "TeacherEmployments" e
                                JOIN "StudentGroups" gy ON gy."id" = r."studentGroupId"
                               WHERE e."userId" = u."id" AND e."academicYearId" = gy."academicYearId")
                      END AS lbl
                 FROM "CalendarLessonTeachers" t
                 JOIN "Users" u ON u."id" = t."teacherId"
                WHERE t."calendarLessonId" = r."id"
                  AND t."role" IN ('LEAD', 'ASSISTANT')
                  AND u."schoolId" = r."schoolId"
                  AND u."isActive"
                  AND u."role" IN ('TEACHER', 'SCHOOL_ADMIN')
                  AND NOT EXISTS (SELECT 1 FROM "TeacherPublicLabels" h WHERE h."userId" = u."id" AND h."hidden")
             ) l WHERE lbl IS NOT NULL), '{}'::text[])
         END
    FROM reach r
$$;

COMMENT ON FUNCTION app.family_lesson_labels(uuid, "TeacherDisplay", uuid[]) IS
  'Per lesson of the school: whether a substitute holds it, and its teachers as the school names them outside the staff room (the display). The owner''s, called by app.family_lesson_staff and the calendar feed''s builder.';

CREATE OR REPLACE FUNCTION app.family_lesson_staff(p_lesson_ids uuid[])
RETURNS TABLE (lesson_id uuid, substitute boolean, labels text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  WITH me AS (
    SELECT app.current_school_id() AS school,
           app.current_user_role() AS role,
           app.current_guardian_group_ids() AS groups,
           app.current_guardian_lesson_ids() AS lessons
  ),
  cfg AS (
    SELECT coalesce(
             (SELECT s."publicTeacherDisplay" FROM "PublicationSettings" s, me WHERE s."schoolId" = me.school),
             'NONE'::"TeacherDisplay") AS display
  ),
  reach AS (
    SELECT cl."id"
      FROM "CalendarLessons" cl, me
     WHERE cl."id" = ANY (p_lesson_ids)
       AND me.school IS NOT NULL
       AND cl."schoolId" = me.school
       AND (
             me.role = 'SCHOOL_ADMIN'
          OR (me.role = 'GUARDIAN' AND (cl."studentGroupId" = ANY (me.groups) OR cl."id" = ANY (me.lessons)))
       )
  )
  SELECT l.lesson_id, l.substitute, l.labels
    FROM me, cfg, app.family_lesson_labels(me.school, cfg.display, ARRAY(SELECT r."id" FROM reach r)) l
$$;

-- ---------------------------------------------------------------------------
-- The builders: what a feed's week holds. The owner's, inside the door.
-- ---------------------------------------------------------------------------

-- Every lesson as one entry: the times on the school's clock (the feed's
-- VTIMEZONE is Stockholm's, the clock of every school so far) and in UTC (for
-- a school on another), the version (the row's updatedAt) in UTC. A
-- teacher's lessons come from their own rows (CalendarLessonTeachers by
-- teacherId), a pupil's from their groups' and their name's, each on its own
-- index: a calendar asks every few minutes, and the school's year is never
-- scanned for one person.
CREATE FUNCTION app.calendar_feed_teacher_lessons(p_school uuid, p_teacher uuid, p_from date, p_to date, p_tz text)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = "public", "pg_temp" AS $$
  WITH mine AS (
    SELECT cl."id", cl."date", cl."startsAt", cl."endsAt", cl."status", cl."subjectId", cl."roomId",
           cl."studentGroupId", cl."updatedAt", t."role" AS my_role
      FROM "CalendarLessonTeachers" t
      JOIN "CalendarLessons" cl ON cl."id" = t."calendarLessonId"
     WHERE t."teacherId" = p_teacher
       AND cl."schoolId" = p_school
       AND cl."date" BETWEEN p_from AND p_to
       AND cl."status" IN ('SCHEDULED', 'COMPLETED', 'CANCELLED')
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', l."id",
           'date', to_char(l."date", 'YYYY-MM-DD'),
           'start', to_char(l."startsAt" AT TIME ZONE p_tz, 'YYYYMMDD"T"HH24MISS'),
           'end', to_char(l."endsAt" AT TIME ZONE p_tz, 'YYYYMMDD"T"HH24MISS'),
           'startUtc', to_char(l."startsAt" AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS"Z"'),
           'endUtc', to_char(l."endsAt" AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS"Z"'),
           'cancelled', l."status" = 'CANCELLED',
           'subject', s."name",
           'room', r."name",
           'groups', (
             SELECT coalesce(jsonb_agg(g."name" ORDER BY (g."id" <> l."studentGroupId"), g."name"), '[]'::jsonb)
               FROM "StudentGroups" g
              WHERE g."id" = ANY (ARRAY(SELECT l."studentGroupId"
                                        UNION
                                        SELECT x."studentGroupId" FROM "CalendarLessonGroups" x WHERE x."calendarLessonId" = l."id"))),
           'teachers', (
             SELECT coalesce(jsonb_agg(u."firstName" || ' ' || u."lastName" ORDER BY u."lastName", u."firstName"), '[]'::jsonb)
               FROM "CalendarLessonTeachers" o
               JOIN "Users" u ON u."id" = o."teacherId"
              WHERE o."calendarLessonId" = l."id"
                AND o."teacherId" <> p_teacher
                AND u."schoolId" = p_school
                AND u."isActive"
                AND NOT EXISTS (SELECT 1 FROM "TeacherPublicLabels" h WHERE h."userId" = u."id" AND h."hidden")),
           'substitute', l.my_role = 'SUBSTITUTE',
           'version', to_char(l."updatedAt" AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS"Z"'))
         ORDER BY l."startsAt", l."endsAt", l."id"), '[]'::jsonb)
    FROM mine l
    JOIN "Subjects" s ON s."id" = l."subjectId"
    LEFT JOIN "Rooms" r ON r."id" = l."roomId"
$$;

COMMENT ON FUNCTION app.calendar_feed_teacher_lessons(uuid, uuid, date, date, text) IS
  'A teacher''s calendar feed: the lessons they are on in [p_from, p_to], with groups, room and colleagues (never a protected one), a covered lesson marked. The owner''s, inside app.calendar_feed.';

CREATE FUNCTION app.calendar_feed_pupil_lessons(p_school uuid, p_pupil uuid, p_from date, p_to date, p_tz text, p_display "TeacherDisplay")
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = "public", "pg_temp" AS $$
  WITH pupil AS (
    SELECT u."studentGroupId" AS home FROM "Users" u WHERE u."id" = p_pupil AND u."schoolId" = p_school
  ),
  teaching AS (
    SELECT m."studentGroupId" AS g FROM "StudentGroupMembers" m WHERE m."studentId" = p_pupil
  ),
  homedays AS (
    SELECT e."validFrom", e."validTo"
      FROM "StudentEnrollments" e, pupil
     WHERE e."studentId" = p_pupil AND e."studentGroupId" = pupil.home
  ),
  -- The lessons the family's week matches: the pupil named on it, a teaching
  -- group's (its own group or an extra one), and the home class's on the
  -- days the class history names it.
  named AS (
    SELECT p."calendarLessonId" AS id FROM "CalendarLessonStudents" p WHERE p."studentId" = p_pupil
  ),
  taught AS (
    SELECT cl."id" FROM "CalendarLessons" cl
     WHERE cl."studentGroupId" IN (SELECT g FROM teaching) AND cl."date" BETWEEN p_from AND p_to
    UNION
    SELECT x."calendarLessonId" FROM "CalendarLessonGroups" x WHERE x."studentGroupId" IN (SELECT g FROM teaching)
  ),
  homed AS (
    SELECT cl."id", cl."date" FROM "CalendarLessons" cl, pupil
     WHERE cl."studentGroupId" = pupil.home AND cl."date" BETWEEN p_from AND p_to
    UNION
    SELECT cl."id", cl."date"
      FROM "CalendarLessonGroups" x JOIN "CalendarLessons" cl ON cl."id" = x."calendarLessonId", pupil
     WHERE x."studentGroupId" = pupil.home AND cl."date" BETWEEN p_from AND p_to
  ),
  candidates AS (
    SELECT id FROM named
    UNION
    SELECT id FROM taught
    UNION
    SELECT h."id" FROM homed h
     WHERE EXISTS (SELECT 1 FROM homedays d
                    WHERE d."validFrom" <= h."date" AND (d."validTo" IS NULL OR h."date" < d."validTo"))
  ),
  theirs AS (
    SELECT cl."id", cl."date", cl."startsAt", cl."endsAt", cl."status", cl."subjectId", cl."roomId", cl."updatedAt"
      FROM "CalendarLessons" cl
     WHERE cl."id" IN (SELECT c.id FROM candidates c)
       AND cl."schoolId" = p_school
       AND cl."date" BETWEEN p_from AND p_to
       AND cl."status" IN ('SCHEDULED', 'COMPLETED', 'CANCELLED')
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', l."id",
           'date', to_char(l."date", 'YYYY-MM-DD'),
           'start', to_char(l."startsAt" AT TIME ZONE p_tz, 'YYYYMMDD"T"HH24MISS'),
           'end', to_char(l."endsAt" AT TIME ZONE p_tz, 'YYYYMMDD"T"HH24MISS'),
           'startUtc', to_char(l."startsAt" AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS"Z"'),
           'endUtc', to_char(l."endsAt" AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS"Z"'),
           'cancelled', l."status" = 'CANCELLED',
           'subject', s."name",
           'room', r."name",
           'groups', '[]'::jsonb,
           'teachers', to_jsonb(coalesce(st.labels, '{}'::text[])),
           'substitute', coalesce(st.substitute, false),
           'version', to_char(l."updatedAt" AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS"Z"'))
         ORDER BY l."startsAt", l."endsAt", l."id"), '[]'::jsonb)
    FROM theirs l
    JOIN "Subjects" s ON s."id" = l."subjectId"
    LEFT JOIN "Rooms" r ON r."id" = l."roomId"
    LEFT JOIN app.family_lesson_labels(p_school, p_display, ARRAY(SELECT t."id" FROM theirs t)) st ON st.lesson_id = l."id"
$$;

COMMENT ON FUNCTION app.calendar_feed_pupil_lessons(uuid, uuid, date, date, text, "TeacherDisplay") IS
  'A pupil''s week for a calendar feed, the pupil''s own or a guardian''s: the lessons the family''s week matches, teachers as the school names them to families. The owner''s, inside app.calendar_feed.';

-- Lov and studiedagar: the whole school's for a teacher, those covering the
-- child's year for a pupil (breakCoversGroup, src/calendar/publish-days.ts).
CREATE FUNCTION app.calendar_feed_breaks(p_school uuid, p_grade integer, p_whole_school boolean, p_from date, p_to date)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = "public", "pg_temp" AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', b."id",
           'name', b."name",
           'kind', b."kind",
           'from', to_char(b."startDate", 'YYYYMMDD'),
           'until', to_char(b."endDate" + 1, 'YYYYMMDD'),
           'version', to_char(b."updatedAt" AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS"Z"'))
         ORDER BY b."startDate", b."id"), '[]'::jsonb)
    FROM "SchoolBreaks" b
   WHERE b."schoolId" = p_school
     AND b."startDate" <= p_to AND b."endDate" >= p_from
     AND (
           (b."minGradeLevel" IS NULL AND b."maxGradeLevel" IS NULL)
        OR (NOT p_whole_school AND p_grade IS NOT NULL
            AND (b."minGradeLevel" IS NULL OR p_grade >= b."minGradeLevel")
            AND (b."maxGradeLevel" IS NULL OR p_grade <= b."maxGradeLevel"))
     )
$$;

COMMENT ON FUNCTION app.calendar_feed_breaks(uuid, integer, boolean, date, date) IS
  'Lov and studiedagar for a calendar feed: the whole school''s, and for a pupil those covering their year. The owner''s, inside app.calendar_feed.';

-- ---------------------------------------------------------------------------
-- The door. See the preamble.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.calendar_feed(token_hash text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  feed record;
  cfg record;
  audience_on boolean;
  alive boolean;
  owner record;
  pupil record;
  tz text;
  school_name text;
  today date;
  week_from date;
  week_to date;
  year_end date;
  title text;
  lessons jsonb;
  breaks jsonb;
BEGIN
  SELECT f.* INTO feed FROM "CalendarFeeds" f WHERE f."tokenHash" = token_hash AND f."revokedAt" IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT s.* INTO cfg FROM "PublicationSettings" s WHERE s."schoolId" = feed."schoolId";
  audience_on := FOUND AND CASE feed."audience"
                   WHEN 'TEACHER' THEN cfg."calendarFeedTeachers"
                   WHEN 'STUDENT' THEN cfg."calendarFeedStudents"
                   ELSE cfg."calendarFeedGuardians"
                 END;
  -- The owner FOR KEY SHARE before the feed's row is written below: the read
  -- log's row needs that lock (its foreign key), and taking it after the
  -- feed's would deadlock with a writer that holds the person FOR UPDATE and
  -- then revokes their feeds (Users_calendar_feeds_follow).
  SELECT u."id", u."role", u."firstName", u."lastName" INTO owner
    FROM "Users" u WHERE u."id" = feed."userId" AND u."schoolId" = feed."schoolId" AND u."isActive"
     FOR KEY SHARE;
  alive := audience_on AND FOUND AND CASE feed."audience"
             WHEN 'TEACHER' THEN owner."role" IN ('TEACHER', 'SCHOOL_ADMIN')
             WHEN 'STUDENT' THEN owner."role" = 'STUDENT'
             ELSE owner."role" = 'GUARDIAN' AND EXISTS (
                    SELECT 1 FROM "GuardianStudents" gs
                     WHERE gs."guardianId" = owner."id" AND gs."studentId" = feed."studentId" AND gs."schoolId" = feed."schoolId")
           END;
  IF alive AND feed."audience" <> 'TEACHER' THEN
    SELECT u."id", u."firstName", u."lastName", g."gradeLevel" INTO pupil
      FROM "Users" u LEFT JOIN "StudentGroups" g ON g."id" = u."studentGroupId"
     WHERE u."id" = feed."studentId" AND u."schoolId" = feed."schoolId" AND u."isActive" AND u."role" = 'STUDENT';
    alive := FOUND;
  END IF;
  -- A live feed refused here is one the triggers should have ended (a change
  -- they did not see): it is ended now, so it stays dead whatever comes back.
  IF NOT coalesce(alive, false) THEN
    UPDATE "CalendarFeeds" SET "revokedAt" = now() WHERE "id" = feed."id" AND "revokedAt" IS NULL;
    RETURN NULL;
  END IF;

  SELECT sc."timezone", sc."name" INTO tz, school_name FROM "Schools" sc WHERE sc."id" = feed."schoolId";
  today := (now() AT TIME ZONE tz)::date;
  -- From last week's Monday, as the family's week is shown, to a year ahead;
  -- a pupil's to the Sunday of the active year's last week, where the
  -- family's week ends (FamilyScheduleService.assertWeekInRange), and with
  -- no active year a year ahead.
  week_from := (today - 7) - (extract(isodow FROM today - 7)::int - 1);
  week_to := today + 365;
  IF feed."audience" <> 'TEACHER' THEN
    SELECT max(y."endDate") INTO year_end
      FROM "AcademicYears" y WHERE y."schoolId" = feed."schoolId" AND y."isActive";
    IF year_end IS NOT NULL THEN
      week_to := least(week_to, year_end + (7 - extract(isodow FROM year_end)::int));
    END IF;
  END IF;

  IF feed."lastUsedAt" IS NULL OR feed."lastUsedAt" < now() - interval '5 minutes' THEN
    UPDATE "CalendarFeeds" SET "lastUsedAt" = now() WHERE "id" = feed."id";
  END IF;

  IF feed."audience" = 'TEACHER' THEN
    title := owner."firstName" || ' ' || owner."lastName";
    lessons := app.calendar_feed_teacher_lessons(feed."schoolId", owner."id", week_from, week_to, tz);
    breaks := app.calendar_feed_breaks(feed."schoolId", NULL, true, week_from, week_to);
  ELSE
    title := CASE WHEN feed."audience" = 'STUDENT' THEN pupil."firstName" || ' ' || pupil."lastName" ELSE pupil."firstName" END;
    lessons := app.calendar_feed_pupil_lessons(feed."schoolId", pupil."id", week_from, week_to, tz,
                                               coalesce(cfg."publicTeacherDisplay", 'NONE'));
    breaks := app.calendar_feed_breaks(feed."schoolId", pupil."gradeLevel", false, week_from, week_to);
  END IF;

  -- A guardian's feed is a read of the child's schedule: once per feed and
  -- school day, the guardian the reader, the calendar the way; and only on a
  -- day it showed a lesson (a week past the year shows none, and the
  -- family's week then records nothing either).
  IF feed."audience" = 'GUARDIAN' AND jsonb_array_length(lessons) > 0 THEN
    UPDATE "CalendarFeeds" SET "recordedOn" = today
     WHERE "id" = feed."id" AND "recordedOn" IS DISTINCT FROM today;
    IF FOUND THEN
      INSERT INTO "PersonalDataAccess" ("schoolId", "actorId", "actorRole", "apiKeyId", "channel", "kind", "subjectIds", "readSize")
      VALUES (feed."schoolId", owner."id", 'GUARDIAN', NULL, 'CALENDAR', 'SCHEDULE', ARRAY[pupil."id"], 1);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'audience', feed."audience",
    -- Whose week, for the entries' UIDs: the pupil's, or the teacher's own.
    'scope', coalesce(feed."studentId", feed."userId"),
    'locale', feed."locale",
    'title', title,
    'school', school_name,
    'timezone', tz,
    'lessons', lessons,
    'breaks', breaks
  );
END
$$;

COMMENT ON FUNCTION app.calendar_feed(text) IS
  'A personal calendar feed by its address''s hash: the owner''s published week from last week to a year ahead (a pupil''s to the active year''s last week), by the audience''s whitelist, or NULL, ending a live feed it refuses. Writes a guardian''s feed to the read log once per school day it shows a lesson.';

-- ---------------------------------------------------------------------------
-- The read log's quarter-hour leaves the calendar's rows out (20261026091000's
-- body, with the one line marked "kalendern"). A guardian's calendar fetching
-- the child's week at 07:00 is a row of the guardian; opening the week in the
-- app at 07:05 is another read, by another way, and is written as one.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.personal_data_read(
    p_kind "PersonalDataAccessKind",
    p_channel "PersonalDataAccessChannel",
    p_subjects uuid[]
) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  v_school  uuid := app.current_service_school_id();
  v_actor   uuid;
  v_role    "UserRole";
  v_key     uuid;
  v_channel "PersonalDataAccessChannel";
  v_since   timestamptz := clock_timestamp() - interval '15 minutes';
  v_recent  uuid[];
  v_read    uuid[];
  v_new     uuid[];
BEGIN
  IF p_kind IS NULL THEN
    RAISE EXCEPTION 'PERSONAL_DATA_READ_HAS_A_KIND' USING ERRCODE = 'PD400';
  END IF;
  IF app.current_sync_school_id() IS NOT NULL THEN
    RAISE EXCEPTION 'PERSONAL_DATA_READ_HAS_NO_READER: synken läser åt ingen'
      USING ERRCODE = 'PD403';
  END IF;
  IF v_school IS NOT NULL THEN
    v_key := app.current_service_key_id();
    v_channel := 'INTEGRATION';
    -- A key of another school is no key of this read.
    IF v_key IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM "IntegrationApiKeys" k WHERE k."id" = v_key AND k."schoolId" = v_school) THEN
      RAISE EXCEPTION 'PERSONAL_DATA_READ_HAS_NO_READER: nyckeln hör inte till skolan'
        USING ERRCODE = 'PD403';
    END IF;
  ELSE
    v_actor := app.current_user_id();
    v_school := app.current_school_id();
    v_role := app.current_user_role();
    IF v_actor IS NULL OR v_school IS NULL OR v_role IS NULL THEN
      RAISE EXCEPTION 'PERSONAL_DATA_READ_HAS_NO_READER: ingen inloggad läser'
        USING ERRCODE = 'PD403';
    END IF;
    v_channel := CASE WHEN p_channel IN ('WEB', 'APP') THEN p_channel ELSE 'OTHER' END;
  END IF;

  -- Who this reader (or key) already has in a row of the kind from the last
  -- quarter-hour. One branch per reader, each on its own index.
  IF v_actor IS NOT NULL THEN
    SELECT coalesce(array_agg(DISTINCT s.id), '{}'::uuid[]) INTO v_recent
      FROM "PersonalDataAccess" a, unnest(a."subjectIds") AS s(id)
     WHERE a."actorId" = v_actor AND a."kind" = p_kind AND a."at" > v_since
       AND a."channel" <> 'CALENDAR';  -- kalendern
  ELSIF v_key IS NOT NULL THEN
    SELECT coalesce(array_agg(DISTINCT s.id), '{}'::uuid[]) INTO v_recent
      FROM "PersonalDataAccess" a, unnest(a."subjectIds") AS s(id)
     WHERE a."schoolId" = v_school AND a."channel" = 'INTEGRATION' AND a."apiKeyId" = v_key
       AND a."kind" = p_kind AND a."at" > v_since;
  ELSE
    SELECT coalesce(array_agg(DISTINCT s.id), '{}'::uuid[]) INTO v_recent
      FROM "PersonalDataAccess" a, unnest(a."subjectIds") AS s(id)
     WHERE a."schoolId" = v_school AND a."channel" = 'INTEGRATION' AND a."apiKeyId" IS NULL
       AND a."kind" = p_kind AND a."at" > v_since;
  END IF;

  -- Everyone of the school the read named, the reader aside: the read's size.
  SELECT coalesce(array_agg(u."id" ORDER BY u."id"), '{}'::uuid[]) INTO v_read
    FROM "Users" u
   WHERE u."schoolId" = v_school
     AND u."id" = ANY (p_subjects)
     AND u."id" IS DISTINCT FROM v_actor;
  v_new := ARRAY(SELECT x FROM unnest(v_read) AS x WHERE NOT (x = ANY (v_recent)) ORDER BY x);

  IF cardinality(v_new) = 0 THEN
    RETURN 0;
  END IF;
  INSERT INTO "PersonalDataAccess" ("schoolId", "actorId", "actorRole", "apiKeyId", "channel", "kind", "subjectIds", "readSize")
  VALUES (v_school, v_actor, v_role, v_key, v_channel, p_kind, v_new, cardinality(v_read));
  RETURN cardinality(v_new);
END
$$;

COMMENT ON FUNCTION app.personal_data_read("PersonalDataAccessKind", "PersonalDataAccessChannel", uuid[]) IS
  'Records that the transaction''s reader (a person by their claims, or an SS12000 key) read p_kind about p_subjects; leaves out the reader, people of other schools and anyone the same reader read of that kind in the last 15 minutes (a calendar feed''s rows aside), and keeps the read''s whole size. Answers how many people it recorded.';

-- ---------------------------------------------------------------------------
-- Making, revoking and counting feeds, and whether one may be made. See the
-- preamble.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.calendar_feed_create(p_student uuid, p_token_hash text, p_locale text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  v_me uuid := app.current_user_id();
  v_school uuid := app.current_school_id();
  v_role "UserRole" := app.current_user_role();
  v_audience "CalendarFeedAudience";
  v_student uuid;
  v_on boolean;
  v_row "CalendarFeeds";
BEGIN
  IF v_me IS NULL OR v_school IS NULL OR v_role IS NULL THEN
    RETURN jsonb_build_object('refused', 'NO_PRINCIPAL');
  END IF;
  IF v_role IN ('TEACHER', 'SCHOOL_ADMIN') AND p_student IS NULL THEN
    v_audience := 'TEACHER';
  ELSIF v_role = 'STUDENT' AND (p_student IS NULL OR p_student = v_me) THEN
    v_audience := 'STUDENT';
    v_student := v_me;
  ELSIF v_role = 'GUARDIAN' AND p_student IS NOT NULL AND EXISTS (
          SELECT 1 FROM "GuardianStudents" gs JOIN "Users" c ON c."id" = gs."studentId"
           WHERE gs."guardianId" = v_me AND gs."studentId" = p_student AND gs."schoolId" = v_school
             AND c."schoolId" = v_school AND c."isActive" AND c."role" = 'STUDENT') THEN
    v_audience := 'GUARDIAN';
    v_student := p_student;
  ELSE
    RETURN jsonb_build_object('refused', 'NOT_YOURS');
  END IF;

  -- The person, and a guardian's child and link, FOR SHARE and read again
  -- from the locked rows: a deactivation, a role change or the link's
  -- deletion meanwhile waits for this feed and then revokes it (their
  -- triggers), or went first and is read here. Without the locks both could
  -- pass each other, and the feed would live on, silent, until the person
  -- came back. Users before the settings and the feeds, as every other
  -- writer of the feeds takes them.
  PERFORM 1 FROM "Users" u
   WHERE u."id" = v_me AND u."schoolId" = v_school AND u."isActive" AND u."role" = v_role
     FOR SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('refused', 'NO_PRINCIPAL');
  END IF;
  IF v_audience = 'GUARDIAN' THEN
    PERFORM 1 FROM "GuardianStudents" gs JOIN "Users" c ON c."id" = gs."studentId"
     WHERE gs."guardianId" = v_me AND gs."studentId" = v_student AND gs."schoolId" = v_school
       AND c."schoolId" = v_school AND c."isActive" AND c."role" = 'STUDENT'
       FOR SHARE OF gs, c;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('refused', 'NOT_YOURS');
    END IF;
  END IF;

  -- FOR SHARE: a switch turned off meanwhile waits for this feed and then
  -- revokes it, or went first and this reads it off. Without the lock both
  -- could pass each other, and the audience would come back on with a feed.
  SELECT CASE v_audience
           WHEN 'TEACHER' THEN s."calendarFeedTeachers"
           WHEN 'STUDENT' THEN s."calendarFeedStudents"
           ELSE s."calendarFeedGuardians"
         END INTO v_on
    FROM "PublicationSettings" s WHERE s."schoolId" = v_school
     FOR SHARE;
  IF NOT coalesce(v_on, false) THEN
    RETURN jsonb_build_object('refused', 'AUDIENCE_OFF');
  END IF;

  -- One live feed per week: the old address stops as the new one is made.
  PERFORM pg_advisory_xact_lock(hashtext('calendar_feed'), hashtext(v_me::text));
  UPDATE "CalendarFeeds" SET "revokedAt" = now()
   WHERE "userId" = v_me AND coalesce("studentId", "userId") = coalesce(v_student, v_me) AND "revokedAt" IS NULL;
  INSERT INTO "CalendarFeeds" ("schoolId", "userId", "studentId", "audience", "tokenHash", "locale")
  VALUES (v_school, v_me, v_student, v_audience, p_token_hash, CASE WHEN p_locale = 'en' THEN 'en' ELSE 'sv' END)
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('feed', jsonb_build_object(
    'id', v_row."id",
    'audience', v_row."audience",
    'studentId', v_row."studentId",
    'locale', v_row."locale",
    'createdAt', v_row."createdAt",
    'lastUsedAt', v_row."lastUsedAt"));
END
$$;

COMMENT ON FUNCTION app.calendar_feed_create(uuid, text, text) IS
  'Makes the signed-in person''s calendar feed (their own week, or a child''s for a guardian) with the address''s hash, revoking the one it replaces; or says why not (refused: NO_PRINCIPAL, NOT_YOURS, AUDIENCE_OFF).';

CREATE FUNCTION app.calendar_feed_revoke(p_feed uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  UPDATE "CalendarFeeds" SET "revokedAt" = now()
   WHERE "id" = p_feed
     AND "userId" = app.current_user_id()
     AND "schoolId" = app.current_school_id()
     AND "revokedAt" IS NULL;
  RETURN FOUND;
END
$$;

COMMENT ON FUNCTION app.calendar_feed_revoke(uuid) IS
  'Revokes one of the signed-in person''s own live calendar feeds; false for any other.';

CREATE FUNCTION app.calendar_feed_counts()
RETURNS TABLE (audience "CalendarFeedAudience", live bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT f."audience", count(*)
    FROM "CalendarFeeds" f
   WHERE f."schoolId" = app.current_school_id()
     AND app.current_user_role() = 'SCHOOL_ADMIN'
     AND f."revokedAt" IS NULL
   GROUP BY f."audience"
   ORDER BY f."audience"
$$;

COMMENT ON FUNCTION app.calendar_feed_counts() IS
  'For the school''s admin: how many live calendar feeds each audience has, and nothing about whose.';

-- Whether the signed-in person's own audience is on: what their page needs
-- to offer a feed or say why not. PublicationSettings is the admin's to read.
CREATE FUNCTION app.calendar_feed_audience_on() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT coalesce((
    SELECT CASE app.current_user_role()
             WHEN 'TEACHER' THEN s."calendarFeedTeachers"
             WHEN 'SCHOOL_ADMIN' THEN s."calendarFeedTeachers"
             WHEN 'STUDENT' THEN s."calendarFeedStudents"
             WHEN 'GUARDIAN' THEN s."calendarFeedGuardians"
           END
      FROM "PublicationSettings" s
     WHERE s."schoolId" = app.current_school_id()), false)
$$;

COMMENT ON FUNCTION app.calendar_feed_audience_on() IS
  'Whether the school has calendar feeds on for the signed-in person''s audience (a teacher''s or an admin''s, a pupil''s, a guardian''s).';

-- ---------------------------------------------------------------------------
-- Grants. See the preamble.
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION app.calendar_feeds_follow_the_school() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.calendar_feeds_follow_the_person() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.family_lesson_labels(uuid, "TeacherDisplay", uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.calendar_feed_teacher_lessons(uuid, uuid, date, date, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.calendar_feed_pupil_lessons(uuid, uuid, date, date, text, "TeacherDisplay") FROM PUBLIC;
REVOKE ALL ON FUNCTION app.calendar_feed_breaks(uuid, integer, boolean, date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.calendar_feed(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.calendar_feed_create(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.calendar_feed_revoke(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.calendar_feed_counts() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.calendar_feed_audience_on() FROM PUBLIC;

DO $$
DECLARE fn text; r text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'app.calendar_feeds_follow_the_school()',
    'app.calendar_feeds_follow_the_person()',
    'app.family_lesson_labels(uuid, "TeacherDisplay", uuid[])',
    'app.calendar_feed_teacher_lessons(uuid, uuid, date, date, text)',
    'app.calendar_feed_pupil_lessons(uuid, uuid, date, date, text, "TeacherDisplay")',
    'app.calendar_feed_breaks(uuid, integer, boolean, date, date)',
    'app.calendar_feed(text)',
    'app.calendar_feed_create(uuid, text, text)',
    'app.calendar_feed_revoke(uuid)',
    'app.calendar_feed_counts()',
    'app.calendar_feed_audience_on()'
  ] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', fn, r);
      END IF;
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT EXECUTE ON FUNCTION app.calendar_feed(text) TO "app_authenticated";
    GRANT EXECUTE ON FUNCTION app.calendar_feed_create(uuid, text, text) TO "app_authenticated";
    GRANT EXECUTE ON FUNCTION app.calendar_feed_revoke(uuid) TO "app_authenticated";
    GRANT EXECUTE ON FUNCTION app.calendar_feed_counts() TO "app_authenticated";
    GRANT EXECUTE ON FUNCTION app.calendar_feed_audience_on() TO "app_authenticated";
    GRANT SELECT ON "CalendarFeeds" TO "app_authenticated";
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "CalendarFeeds" FROM "app_authenticated";
  END IF;
  -- PostgREST's role and anon read and write nothing of it; service_role reads.
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "CalendarFeeds" FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "CalendarFeeds" FROM "service_role";
  END IF;
  -- MAINTAIN exists from Postgres 17 on, and naming it on 16 is an error.
  IF current_setting('server_version_num')::int >= 170000 THEN
    FOREACH r IN ARRAY ARRAY['app_authenticated', 'authenticated', 'anon', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE MAINTAIN ON "CalendarFeeds" FROM %I', r);
      END IF;
    END LOOP;
  END IF;
END
$$;
