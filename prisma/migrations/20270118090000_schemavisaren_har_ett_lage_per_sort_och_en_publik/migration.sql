-- Schemavisaren har ett läge per sort och en publik.
--
-- K2, Schemavisarens lägen. Until now the school chose whether the viewer was
-- on and which of three scopes (classes and groups, teachers, rooms) its
-- share links could point at. A dataskyddsombud asks more before a contract,
-- because a pupil's timetable says where the pupil is: which kinds of
-- schedule can be seen at all, by whom, how a person is found, and that a
-- person with a protected identity is never in it. This migration gives the
-- school those answers as settings, and the viewer's doors the rules.
--
-- ## A mode per kind of schedule
--
-- PublicationSettings gains one column per kind (viewerClassMode,
-- viewerGroupMode, viewerTeacherMode, viewerStudentMode, viewerRoomMode),
-- each OFF (not shown), LIST (a list the viewer can pick from) or CODE
-- (Fritext-ID: shown only to the one who holds the exact code). The link is
-- still the viewer's address; the mode says which links resolve:
--
--   OFF   no link of the kind resolves;
--   LIST  an index link of the kind (a list of its targets) resolves, and so
--         does a link to one target;
--   CODE  a link to one target resolves, and an index link does not: the
--         list a CODE kind would give away is never answered.
--
-- A pupil's schedule can be CODE or OFF and never LIST (CHECK): a list of
-- pupils is a register of where they are. Teachers can be LIST only when the
-- school names them (publicTeacherDisplay), as the page of a teacher always
-- needed.
--
-- ## The code is drawn, not chosen
--
-- A CODE kind is safe only if the code cannot be guessed and cannot be
-- worked out from anything else the viewer shows. Skola24 lets a viewer type
-- a signature or a class name; here a code is 100 random bits (a link's
-- token), issued by the school per target and kept as its sha256, so nothing
-- a page prints (a signature on a lesson, a class name, a room) is anyone's
-- code. The API limits how many wrong codes an address may try.
--
-- ## Who may look: viewerAudience
--
-- EVERYONE (anyone with a link or a code) or STAFF (a signed-in teacher or
-- administrator of the link's school, and nobody else). A link that STAFF
-- cannot answer for the caller is the same NULL as a link that does not
-- exist. STAFF is also the default and the setting a new school gets; a
-- school that had the viewer on keeps EVERYONE.
--
-- ## What the schools had, and what it becomes
--
-- Every school's old switches stay in their columns (additive: the API that
-- runs while this migration is deployed still reads and writes them) and are
-- no longer read by the viewer; a trigger carries a write of them to the
-- modes, so that they still switch the viewer off (below), and a later
-- migration drops them. A school with
-- publicViewerEnabled gets: audience EVERYONE (its links were public);
-- classes and groups LIST when it has a live index link of the kind
-- (the old index listed both) and CODE otherwise; rooms likewise; teachers
-- CODE (there was never a list of teachers); pupils OFF. That keeps every
-- link that resolves today resolving and every list that was open open, and
-- opens nothing that was shut: a school with the viewer off, or a scope
-- off, gets OFF.
--
-- ## Pupils
--
-- PublicScopeKind gains STUDENT, and PublicTimetableLinks a target column
-- for it (targetStudentId). A pupil's page shows the lessons the family's
-- week shows (the pupil named, the pupil's teaching groups, the home class on
-- the dates the class history names it) with times, subject, room and the
-- teachers as the school names them, cancelled marked; no group names, no
-- notes, no other pupil, never embedded. The page is titled by the link's
-- label, which the school may leave empty: the pupil's name is not printed
-- unless the school writes it.
--
-- ## Hidden schedules: PublicTimetableHidden
--
-- A teacher is hidden by TeacherPublicLabels as before. A class, a group, a
-- room or a pupil is hidden by a row here, and then it is not listed, not
-- found by link or code and not named, whatever the mode: the viewer answers
-- NULL for it as for a target that does not exist.
--
-- ## A list names nothing by the database's id
--
-- An index link's entries are named by a handle (app.viewer_handle): a
-- uuid-shaped hash of the link and the entry, different in every list link,
-- that cannot be turned back into an id. A page carries no id at all. So the
-- only ids a visitor ever holds are the codes the school drew, and nothing a
-- page or a list prints is one, or leads to one. A list still takes the id
-- an older bookmark holds (/v/<list>?target=<id>), for an entry it shows and
-- no other: that keeps every link that resolved before resolving, and tells
-- nobody what the list does not.
--
-- ## A person with a protected identity is never in the viewer
--
-- PersonProtections (20270107090000), whatever its source and whatever the
-- modes: a teacher is not named on a lesson (their label is left out as a
-- hidden teacher's is), has no page and is not listed; a pupil has no page
-- and is no code's target; and neither has a pupil whose guardian is marked,
-- because a child's schedule says where the guardian's child is. Guardians
-- are in no document. The week's builder is shared with the print set, so
-- the admin's printed sheets leave a marked teacher out too.
--
-- ## The doors
--
--   app.schemavisaren_read(token_hash, target, on_date, staff_school)
--       the rules, once. The owner's: nobody may call it.
--   app.public_timetable(token_hash, target, on_date)
--       asked with no principal (the anonymous viewer): staff_school NULL.
--   app.public_timetable_staff(token_hash, target, on_date)
--       asked as the signed-in teacher or administrator: the caller's school
--       is the staff_school. Another role, or no principal, reads as anonymous.
--   app.public_timetable_embed(token_hash)
--       the websites that may frame the viewer, now also NULL for a STAFF
--       viewer and for a pupil's link.
--
-- EXECUTE on the doors is for app_authenticated alone, as before.
--
-- ## Beside the live API
--
-- Nothing is dropped and no column is rewritten but the new ones. The new
-- keys take Users, StudentGroups, Rooms and Schools in SHARE ROW EXCLUSIVE
-- (writes wait, reads and the KEY SHARE of a key check do not), the two
-- settings tables ACCESS EXCLUSIVE, for the length of the file; every one is
-- held NOWAIT, all at once, in a loop with a 30 s ceiling, so no request
-- queues behind this file and the file never waits with a lock in hand.
-- If it gives up nothing is changed: prisma migrate resolve --rolled-back
-- 20270118090000_schemavisaren_har_ett_lage_per_sort_och_en_publik, then
-- deploy again.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Schools" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Users" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "StudentGroups" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Rooms" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "PublicationSettings" IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "PublicTimetableLinks" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Schools, Users, StudentGroups, Rooms, PublicationSettings and PublicTimetableLinks were not free at once in 30 s: nothing is changed. Run: npx prisma migrate resolve --rolled-back 20270118090000_schemavisaren_har_ett_lage_per_sort_och_en_publik, then deploy again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Types and settings
-- ---------------------------------------------------------------------------

CREATE TYPE "ViewerMode" AS ENUM ('OFF', 'LIST', 'CODE');
CREATE TYPE "ViewerAudience" AS ENUM ('STAFF', 'EVERYONE');

-- A value added here cannot be used by name before this file commits, so
-- nothing below spells 'STUDENT' as an enum literal: the checks and the
-- builder compare "kind"::text.
ALTER TYPE "PublicScopeKind" ADD VALUE 'STUDENT';

ALTER TABLE "PublicationSettings"
    ADD COLUMN "viewerAudience"    "ViewerAudience" NOT NULL DEFAULT 'STAFF',
    ADD COLUMN "viewerClassMode"   "ViewerMode" NOT NULL DEFAULT 'OFF',
    ADD COLUMN "viewerGroupMode"   "ViewerMode" NOT NULL DEFAULT 'OFF',
    ADD COLUMN "viewerTeacherMode" "ViewerMode" NOT NULL DEFAULT 'OFF',
    ADD COLUMN "viewerStudentMode" "ViewerMode" NOT NULL DEFAULT 'OFF',
    ADD COLUMN "viewerRoomMode"    "ViewerMode" NOT NULL DEFAULT 'OFF',
    ADD CONSTRAINT "PublicationSettings_pupils_are_never_listed" CHECK ("viewerStudentMode" <> 'LIST'),
    ADD CONSTRAINT "PublicationSettings_shown_teachers_are_named" CHECK ("viewerTeacherMode" = 'OFF' OR "publicTeacherDisplay" <> 'NONE');

-- What the schools had. See the preamble.
UPDATE "PublicationSettings" s
   SET "viewerAudience" = 'EVERYONE',
       "viewerClassMode" = CASE WHEN NOT s."publicGroups" THEN 'OFF'::"ViewerMode"
                                WHEN EXISTS (SELECT 1 FROM "PublicTimetableLinks" l
                                              WHERE l."schoolId" = s."schoolId" AND l."kind"::text = 'GROUP'
                                                AND l."targetGroupId" IS NULL AND l."revokedAt" IS NULL)
                                THEN 'LIST'::"ViewerMode" ELSE 'CODE'::"ViewerMode" END,
       "viewerGroupMode" = CASE WHEN NOT s."publicGroups" THEN 'OFF'::"ViewerMode"
                                WHEN EXISTS (SELECT 1 FROM "PublicTimetableLinks" l
                                              WHERE l."schoolId" = s."schoolId" AND l."kind"::text = 'GROUP'
                                                AND l."targetGroupId" IS NULL AND l."revokedAt" IS NULL)
                                THEN 'LIST'::"ViewerMode" ELSE 'CODE'::"ViewerMode" END,
       "viewerRoomMode" = CASE WHEN NOT s."publicRooms" THEN 'OFF'::"ViewerMode"
                               WHEN EXISTS (SELECT 1 FROM "PublicTimetableLinks" l
                                             WHERE l."schoolId" = s."schoolId" AND l."kind"::text = 'ROOM'
                                               AND l."targetRoomId" IS NULL AND l."revokedAt" IS NULL)
                               THEN 'LIST'::"ViewerMode" ELSE 'CODE'::"ViewerMode" END,
       "viewerTeacherMode" = CASE WHEN s."publicTeachers" AND s."publicTeacherDisplay" <> 'NONE'
                                  THEN 'CODE'::"ViewerMode" ELSE 'OFF'::"ViewerMode" END
 WHERE s."publicViewerEnabled";

-- ---------------------------------------------------------------------------
-- The old switches still switch the viewer off. The API that runs while this
-- migration is deployed, and one that is rolled back to, writes the four
-- switches and knows no mode; the viewer reads the modes. So a write of a
-- switch that names no mode is carried to the modes here:
--
--   publicViewerEnabled -> false   every kind OFF
--   publicGroups / publicRooms / publicTeachers -> false   that kind OFF
--   a switch -> true (or the viewer -> true)   a kind that is OFF becomes
--       what the switch meant before the lägen: classes, groups and rooms
--       LIST, teachers CODE; and a viewer that was off becomes open to
--       everyone, as it was
--
-- A write that names a mode or the audience owns them and is left as it is:
-- the new API writes the modes and the switches together. "Stäng av
-- visaren" in the old admin page is the button for an incident, and it must
-- not stop working because the viewer learnt a new way to be set.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.publication_settings_legacy_switches() RETURNS trigger
LANGUAGE plpgsql SET search_path = "public", "pg_temp" AS $$
DECLARE
  was_viewer boolean := false;
  was_groups boolean := false;
  was_teachers boolean := false;
  was_rooms boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."viewerAudience" IS DISTINCT FROM OLD."viewerAudience"
       OR NEW."viewerClassMode" IS DISTINCT FROM OLD."viewerClassMode"
       OR NEW."viewerGroupMode" IS DISTINCT FROM OLD."viewerGroupMode"
       OR NEW."viewerTeacherMode" IS DISTINCT FROM OLD."viewerTeacherMode"
       OR NEW."viewerStudentMode" IS DISTINCT FROM OLD."viewerStudentMode"
       OR NEW."viewerRoomMode" IS DISTINCT FROM OLD."viewerRoomMode" THEN
      RETURN NEW;
    END IF;
    was_viewer := OLD."publicViewerEnabled";
    was_groups := OLD."publicGroups";
    was_teachers := OLD."publicTeachers";
    was_rooms := OLD."publicRooms";
  ELSIF NEW."viewerAudience" <> 'STAFF' OR NEW."viewerClassMode" <> 'OFF' OR NEW."viewerGroupMode" <> 'OFF'
        OR NEW."viewerTeacherMode" <> 'OFF' OR NEW."viewerStudentMode" <> 'OFF' OR NEW."viewerRoomMode" <> 'OFF' THEN
    RETURN NEW;
  END IF;

  IF NEW."publicViewerEnabled" = was_viewer AND NEW."publicGroups" = was_groups
     AND NEW."publicTeachers" = was_teachers AND NEW."publicRooms" = was_rooms THEN
    RETURN NEW;
  END IF;

  IF NOT NEW."publicViewerEnabled" THEN
    NEW."viewerClassMode" := 'OFF';
    NEW."viewerGroupMode" := 'OFF';
    NEW."viewerTeacherMode" := 'OFF';
    NEW."viewerStudentMode" := 'OFF';
    NEW."viewerRoomMode" := 'OFF';
    RETURN NEW;
  END IF;

  IF NOT was_viewer THEN NEW."viewerAudience" := 'EVERYONE'; END IF;
  IF NEW."publicGroups" THEN
    IF NEW."viewerClassMode" = 'OFF' THEN NEW."viewerClassMode" := 'LIST'; END IF;
    IF NEW."viewerGroupMode" = 'OFF' THEN NEW."viewerGroupMode" := 'LIST'; END IF;
  ELSE
    NEW."viewerClassMode" := 'OFF';
    NEW."viewerGroupMode" := 'OFF';
  END IF;
  IF NEW."publicRooms" THEN
    IF NEW."viewerRoomMode" = 'OFF' THEN NEW."viewerRoomMode" := 'LIST'; END IF;
  ELSE
    NEW."viewerRoomMode" := 'OFF';
  END IF;
  IF NEW."publicTeachers" THEN
    -- publicTeachers has always required a name (PublicationSettings_teachers_are_named), so CODE satisfies the new CHECK too.
    IF NEW."viewerTeacherMode" = 'OFF' THEN NEW."viewerTeacherMode" := 'CODE'; END IF;
  ELSE
    NEW."viewerTeacherMode" := 'OFF';
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app.publication_settings_legacy_switches() IS
  'Carries a write of the four old viewer switches that names no mode to the modes, so that the old admin page and an API rolled back to still switch the viewer off. A write that names a mode owns the modes.';

CREATE TRIGGER "PublicationSettings_legacy_switches"
    BEFORE INSERT OR UPDATE ON "PublicationSettings"
    FOR EACH ROW EXECUTE FUNCTION app.publication_settings_legacy_switches();

COMMENT ON COLUMN "PublicationSettings"."viewerAudience" IS
  'Who may read the viewer: EVERYONE (anyone with a link or code) or STAFF (a signed-in teacher or administrator of the school). STAFF until the school chooses.';

-- ---------------------------------------------------------------------------
-- Links to a pupil
-- ---------------------------------------------------------------------------

ALTER TABLE "PublicTimetableLinks" ADD COLUMN "targetStudentId" UUID;

ALTER TABLE "PublicTimetableLinks" DROP CONSTRAINT "PublicTimetableLinks_target_is_the_kinds";
-- The target column of the kind, or none for an index (a class list, a room
-- list, now a teacher list) — never another's. A pupil's link always names
-- the pupil and, as a teacher's, never an index.
ALTER TABLE "PublicTimetableLinks" ADD CONSTRAINT "PublicTimetableLinks_target_is_the_kinds" CHECK (
    ("kind"::text = 'GROUP' AND "targetTeacherId" IS NULL AND "targetRoomId" IS NULL AND "targetStudentId" IS NULL)
    OR ("kind"::text = 'ROOM' AND "targetGroupId" IS NULL AND "targetTeacherId" IS NULL AND "targetStudentId" IS NULL)
    OR ("kind"::text = 'TEACHER' AND "targetGroupId" IS NULL AND "targetRoomId" IS NULL AND "targetStudentId" IS NULL
        AND "label" IS NULL)
    OR ("kind"::text = 'STUDENT' AND "targetStudentId" IS NOT NULL AND "targetGroupId" IS NULL
        AND "targetTeacherId" IS NULL AND "targetRoomId" IS NULL)
);

CREATE INDEX "PublicTimetableLinks_targetStudentId_schoolId_idx" ON "PublicTimetableLinks"("targetStudentId", "schoolId");
ALTER TABLE "PublicTimetableLinks"
    ADD CONSTRAINT "PublicTimetableLinks_targetStudentId_schoolId_fkey"
    FOREIGN KEY ("targetStudentId", "schoolId") REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- PublicTimetableHidden: the schedules the school hides one by one
-- ---------------------------------------------------------------------------

CREATE TABLE "PublicTimetableHidden" (
    "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"        UUID NOT NULL,
    "targetGroupId"   UUID,
    "targetRoomId"    UUID,
    "targetStudentId" UUID,
    "createdAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "PublicTimetableHidden_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PublicTimetableHidden_one_target" CHECK (num_nonnulls("targetGroupId", "targetRoomId", "targetStudentId") = 1)
);

-- One row per hidden target (a NULL is never equal to another).
CREATE UNIQUE INDEX "PublicTimetableHidden_targetGroupId_key" ON "PublicTimetableHidden"("targetGroupId");
CREATE UNIQUE INDEX "PublicTimetableHidden_targetRoomId_key" ON "PublicTimetableHidden"("targetRoomId");
CREATE UNIQUE INDEX "PublicTimetableHidden_targetStudentId_key" ON "PublicTimetableHidden"("targetStudentId");
CREATE INDEX "PublicTimetableHidden_schoolId_idx" ON "PublicTimetableHidden"("schoolId");

ALTER TABLE "PublicTimetableHidden"
    ADD CONSTRAINT "PublicTimetableHidden_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "PublicTimetableHidden"
    ADD CONSTRAINT "PublicTimetableHidden_targetGroupId_schoolId_fkey" FOREIGN KEY ("targetGroupId", "schoolId")
    REFERENCES "StudentGroups"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PublicTimetableHidden"
    ADD CONSTRAINT "PublicTimetableHidden_targetRoomId_schoolId_fkey" FOREIGN KEY ("targetRoomId", "schoolId")
    REFERENCES "Rooms"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PublicTimetableHidden"
    ADD CONSTRAINT "PublicTimetableHidden_targetStudentId_schoolId_fkey" FOREIGN KEY ("targetStudentId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE;

COMMENT ON TABLE "PublicTimetableHidden" IS
  'A class, group, room or pupil the school hides from Schemavisaren one by one: never listed, never found by link or code, whatever the mode. A teacher is hidden by TeacherPublicLabels (20261011120000).';

-- ---------------------------------------------------------------------------
-- Who is a protected identity, and which pupils the viewer may show. Internal:
-- the doors below run as the owner and nobody else may call these.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.viewer_person_is_protected(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = "public", "pg_temp" AS $$
  SELECT EXISTS (SELECT 1 FROM "PersonProtections" p WHERE p."userId" = p_user)
$$;

COMMENT ON FUNCTION app.viewer_person_is_protected(uuid) IS
  'Whether a person has a protected identity (a PersonProtections row of any source). The viewer''s doors and the week builder ask it; nobody else may call it.';

-- A pupil the viewer may make a page for: active, a pupil, neither marked nor
-- hidden, and with no marked guardian (a child's schedule says where the
-- guardian's child is).
CREATE FUNCTION app.viewer_student_showable(p_school uuid, p_student uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = "public", "pg_temp" AS $$
  SELECT EXISTS (SELECT 1 FROM "Users" u
                  WHERE u."id" = p_student AND u."schoolId" = p_school AND u."isActive" AND u."role" = 'STUDENT')
     AND NOT app.viewer_person_is_protected(p_student)
     AND NOT EXISTS (SELECT 1 FROM "GuardianStudents" gs
                      WHERE gs."studentId" = p_student AND app.viewer_person_is_protected(gs."guardianId"))
     AND NOT EXISTS (SELECT 1 FROM "PublicTimetableHidden" h WHERE h."targetStudentId" = p_student)
$$;

COMMENT ON FUNCTION app.viewer_student_showable(uuid, uuid) IS
  'Whether the viewer may make a page for a pupil: active, not marked, no marked guardian, not hidden. The owner''s; nobody else may call it.';

-- A link's target is one the viewer may show: a teaching group from the
-- school's minimum size, a teacher who is staff, not hidden and not marked,
-- a pupil the viewer may show.
CREATE OR REPLACE FUNCTION app.public_timetable_links_target_is_showable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  minimum integer;
  group_kind text;
  role_of text;
BEGIN
  SELECT coalesce((SELECT s."publicMinGroupSize" FROM "PublicationSettings" s WHERE s."schoolId" = NEW."schoolId"), 5)
    INTO minimum;
  IF NEW."targetGroupId" IS NOT NULL THEN
    SELECT g."kind"::text INTO group_kind FROM "StudentGroups" g WHERE g."id" = NEW."targetGroupId";
    IF group_kind = 'TEACHING_GROUP' AND app.public_group_size(NEW."targetGroupId") < minimum THEN
      RAISE EXCEPTION 'PUBLIC_GROUP_TOO_SMALL: en undervisningsgrupp visas offentligt från % elever', minimum
        USING ERRCODE = 'PB400', DETAIL = format('minimum=%s', minimum);
    END IF;
  END IF;
  IF NEW."targetTeacherId" IS NOT NULL THEN
    SELECT u."role"::text INTO role_of FROM "Users" u WHERE u."id" = NEW."targetTeacherId";
    IF role_of NOT IN ('TEACHER', 'SCHOOL_ADMIN')
       OR EXISTS (SELECT 1 FROM "TeacherPublicLabels" l WHERE l."userId" = NEW."targetTeacherId" AND l."hidden")
       OR app.viewer_person_is_protected(NEW."targetTeacherId") THEN
      RAISE EXCEPTION 'PUBLIC_TEACHER_NOT_SHOWABLE: läraren kan inte visas offentligt'
        USING ERRCODE = 'PB400';
    END IF;
  END IF;
  IF NEW."targetStudentId" IS NOT NULL AND NOT app.viewer_student_showable(NEW."schoolId", NEW."targetStudentId") THEN
    RAISE EXCEPTION 'PUBLIC_STUDENT_NOT_SHOWABLE: eleven kan inte visas offentligt'
      USING ERRCODE = 'PB400';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER "PublicTimetableLinks_target_is_showable" ON "PublicTimetableLinks";
CREATE TRIGGER "PublicTimetableLinks_target_is_showable"
    BEFORE INSERT OR UPDATE OF "targetGroupId", "targetTeacherId", "targetStudentId" ON "PublicTimetableLinks"
    FOR EACH ROW EXECUTE FUNCTION app.public_timetable_links_target_is_showable();

-- ---------------------------------------------------------------------------
-- The week's builder, with a pupil's week and without a protected teacher.
-- Everything else is 20261102090000's, line for line.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.timetable_pupil_days(p_school uuid, p_pupil uuid, p_from date, p_tz text, p_display "TeacherDisplay")
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = "public", "pg_temp" AS $$
  WITH shown AS (
    -- The lessons the family's week matches, once: the calendar feed's pupil
    -- builder says which, and names their teachers as the school names them
    -- to families, without a hidden teacher or one with a protected identity.
    -- The viewer's page keeps its times, subject, room, teachers and
    -- cancelled, and no group: which teaching groups a pupil is in is not for
    -- a page held by a code. A lesson for a few named pupils is on the page of
    -- one of them and on no other's.
    SELECT (l ->> 'date')::date AS "date", l ->> 'start' AS "starts",
           jsonb_build_object(
             'start', substr(l ->> 'start', 10, 2) || ':' || substr(l ->> 'start', 12, 2),
             'end', substr(l ->> 'end', 10, 2) || ':' || substr(l ->> 'end', 12, 2),
             'subject', l -> 'subject',
             'groups', '[]'::jsonb,
             -- A room the school hides is named on no page, a pupil's own too.
             'room', CASE WHEN EXISTS (SELECT 1 FROM "CalendarLessons" cl
                                         JOIN "PublicTimetableHidden" h ON h."targetRoomId" = cl."roomId"
                                        WHERE cl."id" = (l ->> 'id')::uuid)
                          THEN 'null'::jsonb ELSE l -> 'room' END,
             'teachers', l -> 'teachers',
             'cancelled', (l ->> 'cancelled')::boolean) AS "lesson"
      FROM jsonb_array_elements(app.calendar_feed_pupil_lessons(p_school, p_pupil, p_from, p_from + 6, p_tz, p_display)) l
     WHERE NOT EXISTS (SELECT 1 FROM "CalendarLessonStudents" n WHERE n."calendarLessonId" = (l ->> 'id')::uuid)
        OR EXISTS (SELECT 1 FROM "CalendarLessonStudents" n WHERE n."calendarLessonId" = (l ->> 'id')::uuid AND n."studentId" = p_pupil)
  )
  SELECT coalesce(jsonb_agg(day_json ORDER BY d), '[]'::jsonb)
    FROM (
      SELECT d::date AS d,
             jsonb_build_object(
               'date', to_char(d, 'YYYY-MM-DD'),
               'lessons', coalesce((SELECT jsonb_agg(s."lesson" ORDER BY s."starts", s."lesson" ->> 'end')
                                      FROM shown s WHERE s."date" = d::date), '[]'::jsonb)
             ) AS day_json
        FROM generate_series(p_from, p_from + 6, interval '1 day') d
    ) w
$$;

COMMENT ON FUNCTION app.timetable_pupil_days(uuid, uuid, date, text, "TeacherDisplay") IS
  'The days of a pupil''s week for Schemavisaren: the lessons the family''s week matches (app.calendar_feed_pupil_lessons) with times, subject, room, teachers and cancelled, and no group. The owner''s, called only by app.timetable_week_days.';

CREATE OR REPLACE FUNCTION app.timetable_week_days(
    p_school   uuid,
    p_kind     "PublicScopeKind",
    p_target   uuid,
    p_from     date,
    p_tz       text,
    p_display  "TeacherDisplay",
    p_meals    boolean,
    p_min_size integer
) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = "public", "pg_temp" AS $$
  SELECT CASE WHEN p_kind::text = 'STUDENT'
         THEN app.timetable_pupil_days(p_school, p_target, p_from, p_tz, p_display)
         ELSE (
  WITH lessons AS (
    SELECT cl."id", cl."date", cl."startsAt", cl."endsAt", cl."status", cl."roomId", cl."subjectId", cl."studentGroupId",
           EXISTS (SELECT 1 FROM "CalendarLessonStudents" p WHERE p."calendarLessonId" = cl."id") AS "named"
      FROM "CalendarLessons" cl
     WHERE cl."schoolId" = p_school
       AND cl."date" BETWEEN p_from AND p_from + 6
       AND CASE p_kind
             WHEN 'GROUP' THEN (cl."studentGroupId" = p_target
                                OR EXISTS (SELECT 1 FROM "CalendarLessonGroups" x
                                            WHERE x."calendarLessonId" = cl."id" AND x."studentGroupId" = p_target))
             WHEN 'ROOM' THEN cl."roomId" = p_target
             ELSE EXISTS (SELECT 1 FROM "CalendarLessonTeachers" t WHERE t."calendarLessonId" = cl."id" AND t."teacherId" = p_target)
           END
       AND CASE p_kind
             WHEN 'TEACHER' THEN cl."status" IN ('SCHEDULED', 'COMPLETED')
             ELSE cl."status" IN ('SCHEDULED', 'COMPLETED', 'CANCELLED')
           END
  ),
  shown AS (
    SELECT l."date", l."startsAt",
           CASE
             WHEN l."named" AND p_kind = 'ROOM' THEN
               jsonb_build_object('start', to_char(l."startsAt" AT TIME ZONE p_tz, 'HH24:MI'),
                                  'end', to_char(l."endsAt" AT TIME ZONE p_tz, 'HH24:MI'),
                                  'busy', true)
             ELSE
               jsonb_build_object(
                 'start', to_char(l."startsAt" AT TIME ZONE p_tz, 'HH24:MI'),
                 'end', to_char(l."endsAt" AT TIME ZONE p_tz, 'HH24:MI'),
                 'subject', (SELECT s."name" FROM "Subjects" s WHERE s."id" = l."subjectId"),
                 'groups', (
                   SELECT coalesce(jsonb_agg(
                            CASE WHEN g."kind" = 'CLASS' OR app.public_group_size(g."id") >= p_min_size
                                 THEN to_jsonb(g."name") ELSE 'null'::jsonb END
                            ORDER BY (g."id" <> l."studentGroupId"), g."name"), '[]'::jsonb)
                     FROM "StudentGroups" g
                    WHERE (g."id" = l."studentGroupId"
                           OR g."id" IN (SELECT x."studentGroupId" FROM "CalendarLessonGroups" x WHERE x."calendarLessonId" = l."id"))
                      -- A class or group the school hides is named on no page.
                      AND NOT EXISTS (SELECT 1 FROM "PublicTimetableHidden" hg WHERE hg."targetGroupId" = g."id")),
                 -- Nor a room.
                 'room', (SELECT r."name" FROM "Rooms" r WHERE r."id" = l."roomId"
                             AND NOT EXISTS (SELECT 1 FROM "PublicTimetableHidden" hr WHERE hr."targetRoomId" = r."id")),
                 'teachers', CASE WHEN p_display = 'NONE' OR l."status" = 'CANCELLED' THEN '[]'::jsonb ELSE (
                   SELECT coalesce(jsonb_agg(lbl ORDER BY lbl), '[]'::jsonb) FROM (
                     SELECT CASE p_display
                              WHEN 'NAME' THEN u."firstName" || ' ' || u."lastName"
                              ELSE (SELECT e."signature" FROM "TeacherEmployments" e
                                     JOIN "StudentGroups" gy ON gy."id" = l."studentGroupId"
                                    WHERE e."userId" = u."id" AND e."academicYearId" = gy."academicYearId")
                            END AS lbl
                       FROM "CalendarLessonTeachers" t JOIN "Users" u ON u."id" = t."teacherId"
                      WHERE t."calendarLessonId" = l."id"
                        AND t."role" IN ('LEAD', 'ASSISTANT')
                        AND NOT EXISTS (SELECT 1 FROM "TeacherPublicLabels" h WHERE h."userId" = u."id" AND h."hidden")
                        AND NOT app.viewer_person_is_protected(u."id")
                   ) labels WHERE lbl IS NOT NULL) END
               )
               || CASE WHEN p_kind = 'TEACHER' THEN '{}'::jsonb
                       ELSE jsonb_build_object('cancelled', l."status" = 'CANCELLED') END
           END AS "lesson"
      FROM lessons l
     -- A few named pupils' lesson is theirs: not on a group's or a teacher's week.
     WHERE NOT (l."named" AND p_kind <> 'ROOM')
  )
  SELECT coalesce(jsonb_agg(day_json ORDER BY d), '[]'::jsonb)
    FROM (
      SELECT d::date AS d,
             jsonb_build_object(
               'date', to_char(d, 'YYYY-MM-DD'),
               'lessons', coalesce((SELECT jsonb_agg(s."lesson" ORDER BY s."startsAt", s."lesson"->>'end')
                                      FROM shown s WHERE s."date" = d::date), '[]'::jsonb)
             )
             || CASE WHEN p_kind = 'GROUP' AND p_meals
                          AND EXISTS (SELECT 1 FROM "StudentGroups" g WHERE g."id" = p_target AND g."kind" = 'CLASS')
                     THEN jsonb_build_object('meals', coalesce((
                            SELECT jsonb_agg(jsonb_build_object(
                                     'start', to_char(m."startsAt" AT TIME ZONE p_tz, 'HH24:MI'),
                                     'end', to_char(m."endsAt" AT TIME ZONE p_tz, 'HH24:MI')) ORDER BY m."startsAt")
                              FROM "CalendarLunches" m WHERE m."studentGroupId" = p_target AND m."date" = d::date), '[]'::jsonb))
                     ELSE '{}'::jsonb END AS day_json
        FROM generate_series(p_from, p_from + 6, interval '1 day') d
    ) w
         ) END
$$;

-- ---------------------------------------------------------------------------
-- A list names its entries by a handle that is the link's own, never by the
-- id the database gives them: a class, a room or a teacher has a different
-- handle in every list link, no handle can be turned back into an id, and a
-- visitor holding an id from anywhere else cannot ask a list for it.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.viewer_handle(p_link_hash text, p_target uuid) RETURNS uuid
LANGUAGE sql IMMUTABLE SET search_path = "public", "pg_temp" AS $$
  SELECT (substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-8' || substr(h, 18, 3) || '-' || substr(h, 21, 12))::uuid
    FROM (SELECT encode(sha256(convert_to(p_link_hash || ':' || p_target::text, 'UTF8')), 'hex') AS h) x
$$;

COMMENT ON FUNCTION app.viewer_handle(text, uuid) IS
  'The name a list link gives one of its entries: a uuid-shaped hash of the link and the entry, never the entry''s id. The owner''s; app.schemavisaren_read lists with it and finds an entry by it.';

-- ---------------------------------------------------------------------------
-- The rules, once: app.schemavisaren_read. See the preamble.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.schemavisaren_read(token_hash text, target uuid, on_date date, staff_school uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  link record;
  cfg record;
  tz text;
  school_name text;
  tgt uuid;
  via_index boolean := false;
  title text;
  group_kind text;
  kind_mode "ViewerMode";
  week_from date;
  week_to date;
  year_start date;
  year_end date;
  today date;
  days jsonb;
BEGIN
  SELECT l.* INTO link FROM "PublicTimetableLinks" l WHERE l."tokenHash" = token_hash AND l."revokedAt" IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT s.* INTO cfg FROM "PublicationSettings" s WHERE s."schoolId" = link."schoolId";
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- Who may look. A viewer for staff answers a stranger as it answers an
  -- unknown link, and staff of another school likewise.
  IF cfg."viewerAudience" = 'STAFF' AND staff_school IS DISTINCT FROM link."schoolId" THEN RETURN NULL; END IF;
  SELECT sc."timezone", sc."name" INTO tz, school_name FROM "Schools" sc WHERE sc."id" = link."schoolId";

  tgt := coalesce(link."targetGroupId", link."targetTeacherId", link."targetRoomId", link."targetStudentId");
  IF tgt IS NULL THEN
    -- An index link: only a kind in LIST mode has one that answers.
    IF target IS NULL THEN
      IF link."kind"::text = 'GROUP' THEN
        IF cfg."viewerClassMode" <> 'LIST' AND cfg."viewerGroupMode" <> 'LIST' THEN RETURN NULL; END IF;
      ELSIF link."kind"::text = 'ROOM' THEN
        IF cfg."viewerRoomMode" <> 'LIST' THEN RETURN NULL; END IF;
      ELSIF link."kind"::text = 'TEACHER' THEN
        IF cfg."viewerTeacherMode" <> 'LIST' OR cfg."publicTeacherDisplay" = 'NONE' THEN RETURN NULL; END IF;
      ELSE
        RETURN NULL;
      END IF;
      PERFORM app.schemavisaren_touch(link."id", link."lastUsedAt");
      IF link."kind"::text = 'GROUP' THEN
        RETURN jsonb_build_object(
          'kind', 'GROUP', 'school', school_name,
          'targets', coalesce((
            SELECT jsonb_agg(jsonb_build_object('id', app.viewer_handle(link."tokenHash", g."id"), 'label', g."name") ORDER BY g."name", g."id")
              FROM "StudentGroups" g
             WHERE g."schoolId" = link."schoolId" AND g."academicYearId" = link."academicYearId"
               AND ((g."kind" = 'CLASS' AND cfg."viewerClassMode" = 'LIST')
                    OR (g."kind" <> 'CLASS' AND cfg."viewerGroupMode" = 'LIST'
                        AND app.public_group_size(g."id") >= cfg."publicMinGroupSize"))
               AND NOT EXISTS (SELECT 1 FROM "PublicTimetableHidden" h WHERE h."targetGroupId" = g."id")
          ), '[]'::jsonb));
      ELSIF link."kind"::text = 'ROOM' THEN
        RETURN jsonb_build_object(
          'kind', 'ROOM', 'school', school_name,
          'targets', coalesce((
            SELECT jsonb_agg(jsonb_build_object('id', app.viewer_handle(link."tokenHash", r."id"), 'label', r."name") ORDER BY r."name", r."id")
              FROM "Rooms" r
             WHERE r."schoolId" = link."schoolId"
               AND NOT EXISTS (SELECT 1 FROM "PublicTimetableHidden" h WHERE h."targetRoomId" = r."id")
          ), '[]'::jsonb));
      END IF;
      -- Teachers: those the school names, active staff with a tjänst in the
      -- link's läsår, neither hidden nor marked.
      RETURN jsonb_build_object(
        'kind', 'TEACHER', 'school', school_name,
        'targets', coalesce((
          SELECT jsonb_agg(jsonb_build_object('id', app.viewer_handle(link."tokenHash", t."id"), 'label', t."label") ORDER BY t."label", t."id")
            FROM (
              SELECT u."id",
                     CASE cfg."publicTeacherDisplay"
                       WHEN 'NAME' THEN u."firstName" || ' ' || u."lastName"
                       ELSE (SELECT e."signature" FROM "TeacherEmployments" e
                              WHERE e."userId" = u."id" AND e."academicYearId" = link."academicYearId")
                     END AS "label"
                FROM "Users" u
               WHERE u."schoolId" = link."schoolId" AND u."isActive" AND u."role" IN ('TEACHER', 'SCHOOL_ADMIN')
                 AND EXISTS (SELECT 1 FROM "TeacherEmployments" e WHERE e."userId" = u."id" AND e."academicYearId" = link."academicYearId")
                 AND NOT EXISTS (SELECT 1 FROM "TeacherPublicLabels" l WHERE l."userId" = u."id" AND l."hidden")
                 AND NOT app.viewer_person_is_protected(u."id")
            ) t WHERE t."label" IS NOT NULL
        ), '[]'::jsonb));
    END IF;
    -- An entry asked for by its handle in this list, the list's own name for it. An older bookmark or
    -- embed holds the entry's id instead (/v/<list>?target=<id>, from before the lägen): that is taken
    -- too, and only for an entry the list itself shows, as the checks below decide. It gives away
    -- nothing the list does not, and the pages the list links to now carry the handle.
    IF link."kind"::text = 'GROUP' THEN
      SELECT g."id" INTO tgt FROM "StudentGroups" g
       WHERE g."schoolId" = link."schoolId" AND g."academicYearId" = link."academicYearId"
         AND (app.viewer_handle(link."tokenHash", g."id") = target OR g."id" = target);
    ELSIF link."kind"::text = 'ROOM' THEN
      SELECT r."id" INTO tgt FROM "Rooms" r
       WHERE r."schoolId" = link."schoolId" AND (app.viewer_handle(link."tokenHash", r."id") = target OR r."id" = target);
    ELSE
      SELECT u."id" INTO tgt FROM "Users" u
       WHERE u."schoolId" = link."schoolId" AND u."role" IN ('TEACHER', 'SCHOOL_ADMIN')
         AND (app.viewer_handle(link."tokenHash", u."id") = target OR u."id" = target);
    END IF;
    IF tgt IS NULL THEN RETURN NULL; END IF;
    via_index := true;
  ELSIF target IS NOT NULL AND target <> tgt THEN
    RETURN NULL;
  END IF;

  -- The target, as the viewer may show it; anything else reads as gone. A
  -- target reached through a list needs its kind in LIST mode; one reached by
  -- its own link or code, in any mode but OFF.
  IF link."kind"::text = 'GROUP' THEN
    SELECT g."name", g."kind"::text INTO title, group_kind FROM "StudentGroups" g
     WHERE g."id" = tgt AND g."schoolId" = link."schoolId" AND g."academicYearId" = link."academicYearId"
       AND (g."kind" = 'CLASS' OR app.public_group_size(g."id") >= cfg."publicMinGroupSize")
       AND NOT EXISTS (SELECT 1 FROM "PublicTimetableHidden" h WHERE h."targetGroupId" = g."id");
    kind_mode := CASE WHEN group_kind = 'CLASS' THEN cfg."viewerClassMode" ELSE cfg."viewerGroupMode" END;
  ELSIF link."kind"::text = 'ROOM' THEN
    SELECT r."name" INTO title FROM "Rooms" r
     WHERE r."id" = tgt AND r."schoolId" = link."schoolId"
       AND NOT EXISTS (SELECT 1 FROM "PublicTimetableHidden" h WHERE h."targetRoomId" = r."id");
    kind_mode := cfg."viewerRoomMode";
  ELSIF link."kind"::text = 'TEACHER' THEN
    IF cfg."publicTeacherDisplay" = 'NONE' THEN RETURN NULL; END IF;
    SELECT CASE cfg."publicTeacherDisplay"
             WHEN 'NAME' THEN u."firstName" || ' ' || u."lastName"
             ELSE (SELECT e."signature" FROM "TeacherEmployments" e
                    WHERE e."userId" = u."id" AND e."academicYearId" = link."academicYearId")
           END
      INTO title
      FROM "Users" u
     WHERE u."id" = tgt AND u."schoolId" = link."schoolId" AND u."isActive"
       AND u."role" IN ('TEACHER', 'SCHOOL_ADMIN')
       AND (NOT via_index OR EXISTS (SELECT 1 FROM "TeacherEmployments" e
                                      WHERE e."userId" = u."id" AND e."academicYearId" = link."academicYearId"))
       AND NOT EXISTS (SELECT 1 FROM "TeacherPublicLabels" l WHERE l."userId" = u."id" AND l."hidden")
       AND NOT app.viewer_person_is_protected(u."id");
    kind_mode := cfg."viewerTeacherMode";
  ELSE
    -- A pupil: by a code alone, never through a list.
    IF via_index OR NOT app.viewer_student_showable(link."schoolId", tgt) THEN RETURN NULL; END IF;
    title := coalesce(link."label", '');
    kind_mode := cfg."viewerStudentMode";
  END IF;
  IF title IS NULL OR kind_mode = 'OFF' OR (via_index AND kind_mode <> 'LIST') THEN RETURN NULL; END IF;

  -- The week asked for, inside the link's läsår and no further back than
  -- last week: a link is for reading the timetable, not for paging through
  -- a year of cancellations. Without a date: today, or the year's first week
  -- before it has begun.
  SELECT y."startDate", y."endDate" INTO year_start, year_end
    FROM "AcademicYears" y WHERE y."id" = link."academicYearId";
  today := (now() AT TIME ZONE tz)::date;
  week_from := coalesce(on_date, greatest(today, year_start));
  week_from := week_from - (extract(isodow FROM week_from)::int - 1);
  week_to := week_from + 6;
  IF year_start IS NULL OR week_to < year_start OR week_from > year_end OR week_to < today - 7 THEN
    RETURN NULL;
  END IF;

  PERFORM app.schemavisaren_touch(link."id", link."lastUsedAt");

  days := app.timetable_week_days(link."schoolId", link."kind", tgt, week_from, tz,
                                  cfg."publicTeacherDisplay", cfg."publicShowMeals", cfg."publicMinGroupSize");

  RETURN jsonb_build_object(
    'kind', link."kind",
    'title', title,
    'school', school_name,
    'week', jsonb_build_object(
      'from', to_char(week_from, 'YYYY-MM-DD'),
      'to', to_char(week_to, 'YYYY-MM-DD'),
      'isoWeek', to_char(week_from, 'IYYY-"W"IW')),
    'days', days
  );
END
$$;

COMMENT ON FUNCTION app.schemavisaren_read(text, uuid, date, uuid) IS
  'The viewer''s rules, once: which links answer (mode, audience), which targets are hidden or protected, and the page or list that results; NULL for everything else. staff_school is the signed-in staff member''s school, or NULL for a visitor. The owner''s; the two doors below call it and nobody else may.';

-- At most every five minutes, so a busy link writes almost nothing.
CREATE FUNCTION app.schemavisaren_touch(p_link uuid, p_last_used timestamptz) RETURNS void
LANGUAGE sql VOLATILE SET search_path = "public", "pg_temp" AS $$
  UPDATE "PublicTimetableLinks" SET "lastUsedAt" = now()
   WHERE "id" = p_link AND (p_last_used IS NULL OR p_last_used < now() - interval '5 minutes')
$$;

COMMENT ON FUNCTION app.schemavisaren_touch(uuid, timestamptz) IS
  'Marks a link used, at most every five minutes. The owner''s; app.schemavisaren_read calls it.';

-- The anonymous door, as before: no principal at all (RLS answers nothing
-- without one), the visitor's NULL staff_school.
CREATE OR REPLACE FUNCTION app.public_timetable(token_hash text, target uuid, on_date date) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT app.schemavisaren_read(token_hash, target, on_date, NULL::uuid)
$$;

-- The staff door: asked as the signed-in person. A teacher or an
-- administrator reads as staff of their school; a pupil, a guardian, a
-- member without a school, or nobody, reads as a visitor.
CREATE FUNCTION app.public_timetable_staff(token_hash text, target uuid, on_date date) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT app.schemavisaren_read(token_hash, target, on_date,
           CASE WHEN app.current_user_role() IN ('TEACHER', 'SCHOOL_ADMIN') THEN app.current_school_id() END)
$$;

COMMENT ON FUNCTION app.public_timetable_staff(text, uuid, date) IS
  'The viewer asked as a signed-in teacher or administrator: a STAFF viewer answers them for their own school''s links, and everything else as the anonymous door does.';

-- ---------------------------------------------------------------------------
-- The embed policy: a viewer for staff, and a pupil's page, are never framed.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.public_timetable_embed(token_hash text) RETURNS text[]
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  origins text[];
BEGIN
  SELECT s."publicEmbedOrigins" INTO origins
    FROM "PublicTimetableLinks" l
    JOIN "PublicationSettings" s ON s."schoolId" = l."schoolId"
   WHERE l."tokenHash" = token_hash
     AND l."revokedAt" IS NULL
     AND s."viewerAudience" = 'EVERYONE'
     AND cardinality(s."publicEmbedOrigins") > 0
     AND CASE l."kind"::text
           WHEN 'GROUP' THEN s."publicEmbedGroups"
           WHEN 'ROOM' THEN s."publicEmbedRooms"
           WHEN 'TEACHER' THEN s."publicEmbedTeachers"
           ELSE false
         END;
  -- And only a link the viewer answers: whatever it does not show reads as
  -- gone here too.
  IF origins IS NULL OR app.public_timetable(token_hash, NULL, NULL) IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN origins;
END
$$;

-- ---------------------------------------------------------------------------
-- The print set leaves a protected teacher out, as it leaves a hidden one.
-- Everything else is 20261102090000's, line for line.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.print_timetables(p_kind "PublicScopeKind", p_on date, p_display "TeacherDisplay", p_meals boolean)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  school uuid := app.current_school_id();
  tz text;
  school_name text;
  year_id uuid;
  min_size integer;
  week_from date;
  sheets jsonb;
BEGIN
  IF school IS NULL OR app.current_user_role() IS DISTINCT FROM 'SCHOOL_ADMIN'
     OR p_kind IS NULL OR p_on IS NULL OR p_display IS NULL OR p_meals IS NULL THEN
    RETURN NULL;
  END IF;
  -- The set is of classes, rooms or teachers: a pupil's page is never printed in bulk.
  IF p_kind::text NOT IN ('GROUP', 'TEACHER', 'ROOM') THEN RETURN NULL; END IF;
  -- A teacher's sheet is titled by its teacher, as the viewer's TEACHER scope.
  IF p_kind::text = 'TEACHER' AND p_display = 'NONE' THEN RETURN NULL; END IF;
  SELECT sc."timezone", sc."name" INTO tz, school_name FROM "Schools" sc WHERE sc."id" = school;
  week_from := p_on - (extract(isodow FROM p_on)::int - 1);
  -- The läsår of the date, or one the week reaches into.
  SELECT y."id" INTO year_id FROM "AcademicYears" y
   WHERE y."schoolId" = school AND y."startDate" <= week_from + 6 AND y."endDate" >= week_from
   ORDER BY (p_on BETWEEN y."startDate" AND y."endDate") DESC, y."startDate" DESC, y."id"
   LIMIT 1;
  IF year_id IS NULL THEN RETURN NULL; END IF;
  min_size := coalesce((SELECT s."publicMinGroupSize" FROM "PublicationSettings" s WHERE s."schoolId" = school), 5);

  WITH targets AS (
    SELECT g."id", g."name" AS title
      FROM "StudentGroups" g
     WHERE p_kind::text = 'GROUP' AND g."schoolId" = school AND g."academicYearId" = year_id AND g."kind" = 'CLASS'
       AND NOT EXISTS (SELECT 1 FROM "PublicTimetableHidden" h WHERE h."targetGroupId" = g."id")
    UNION ALL
    SELECT r."id", r."name"
      FROM "Rooms" r
     WHERE p_kind::text = 'ROOM' AND r."schoolId" = school
       AND NOT EXISTS (SELECT 1 FROM "PublicTimetableHidden" h WHERE h."targetRoomId" = r."id")
    UNION ALL
    SELECT u."id",
           CASE p_display
             WHEN 'NAME' THEN u."firstName" || ' ' || u."lastName"
             ELSE (SELECT e."signature" FROM "TeacherEmployments" e
                    WHERE e."userId" = u."id" AND e."academicYearId" = year_id)
           END
      FROM "Users" u
     WHERE p_kind::text = 'TEACHER' AND u."schoolId" = school AND u."isActive"
       AND u."role" IN ('TEACHER', 'SCHOOL_ADMIN')
       AND NOT EXISTS (SELECT 1 FROM "TeacherPublicLabels" h WHERE h."userId" = u."id" AND h."hidden")
       AND NOT app.viewer_person_is_protected(u."id")
       AND (EXISTS (SELECT 1 FROM "TeacherEmployments" e WHERE e."userId" = u."id" AND e."academicYearId" = year_id)
            OR EXISTS (SELECT 1 FROM "CalendarLessonTeachers" t JOIN "CalendarLessons" cl ON cl."id" = t."calendarLessonId"
                        WHERE t."teacherId" = u."id" AND cl."schoolId" = school
                          AND cl."date" BETWEEN week_from AND week_from + 6))
  )
  SELECT coalesce(jsonb_agg(
           jsonb_build_object(
             'id', t."id",
             'title', t.title,
             'days', app.timetable_week_days(school, p_kind, t."id", week_from, tz, p_display, p_meals, min_size))
           ORDER BY t.title, t."id"), '[]'::jsonb)
    INTO sheets
    FROM targets t
   WHERE t.title IS NOT NULL;

  RETURN jsonb_build_object(
    'kind', p_kind,
    'school', school_name,
    'academicYearId', year_id,
    'week', jsonb_build_object(
      'from', to_char(week_from, 'YYYY-MM-DD'),
      'to', to_char(week_from + 6, 'YYYY-MM-DD'),
      'isoWeek', to_char(week_from, 'IYYY-"W"IW')),
    'sheets', sheets
  );
END
$$;

-- ---------------------------------------------------------------------------
-- The calendar feeds name no protected teacher. A feed is a person's own
-- week behind an address they made, with its own authority (it follows no
-- viewer mode), but it leaves the school's systems for a calendar app, and
-- the people it names besides its owner follow the viewer's rule. The family's
-- own week in the app is not a feed and names its teachers as before, so the
-- labels get a fourth argument and the old three-argument form stays what
-- family_lesson_staff asks. Everything else is the last one's, line for line: 20261112091000's, and for the pupil's builder
-- 20261211090000's (a replacing group takes its pupils from the class's lesson).
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.family_lesson_labels(p_school uuid, p_display "TeacherDisplay", p_lesson_ids uuid[], p_without_protected boolean)
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
                  AND NOT (p_without_protected AND app.viewer_person_is_protected(u."id"))
             ) l WHERE lbl IS NOT NULL), '{}'::text[])
         END
    FROM reach r
$$;

CREATE OR REPLACE FUNCTION app.family_lesson_labels(p_school uuid, p_display "TeacherDisplay", p_lesson_ids uuid[])
RETURNS TABLE (lesson_id uuid, substitute boolean, labels text[])
LANGUAGE sql STABLE SET search_path = "public", "pg_temp" AS $$
  SELECT * FROM app.family_lesson_labels(p_school, p_display, p_lesson_ids, false)
$$;

COMMENT ON FUNCTION app.family_lesson_labels(uuid, "TeacherDisplay", uuid[], boolean) IS
  'Per lesson of the school: whether a substitute holds it, and its teachers as the school names them outside the staff room (the display), a teacher with a protected identity left out when asked. The owner''s, called by the three-argument form and the calendar feed''s pupil builder.';

CREATE OR REPLACE FUNCTION app.calendar_feed_teacher_lessons(p_school uuid, p_teacher uuid, p_from date, p_to date, p_tz text)
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
                AND NOT EXISTS (SELECT 1 FROM "TeacherPublicLabels" h WHERE h."userId" = u."id" AND h."hidden")
                AND NOT app.viewer_person_is_protected(u."id")),
           'substitute', l.my_role = 'SUBSTITUTE',
           'version', to_char(l."updatedAt" AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS"Z"'))
         ORDER BY l."startsAt", l."endsAt", l."id"), '[]'::jsonb)
    FROM mine l
    JOIN "Subjects" s ON s."id" = l."subjectId"
    LEFT JOIN "Rooms" r ON r."id" = l."roomId"
$$;

CREATE OR REPLACE FUNCTION app.calendar_feed_pupil_lessons(p_school uuid, p_pupil uuid, p_from date, p_to date, p_tz text, p_display "TeacherDisplay")
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
  -- Ersättande grupper (20261211090000): the pupil's replacing groups, the
  -- subject each replaces and its läsår; the membership and the group both
  -- of the school.
  replacing AS (
    SELECT g."id", g."replacesSubjectId" AS subject, g."academicYearId" AS year
      FROM "StudentGroupMembers" m JOIN "StudentGroups" g ON g."id" = m."studentGroupId"
     WHERE m."studentId" = p_pupil AND m."schoolId" = p_school AND g."schoolId" = p_school
       AND g."replacesSubjectId" IS NOT NULL
  ),
  theirs AS (
    SELECT cl."id", cl."date", cl."startsAt", cl."endsAt", cl."status", cl."subjectId", cl."roomId", cl."updatedAt"
      FROM "CalendarLessons" cl
     WHERE cl."id" IN (SELECT c.id FROM candidates c)
       AND cl."schoolId" = p_school
       AND cl."date" BETWEEN p_from AND p_to
       AND cl."status" IN ('SCHEDULED', 'COMPLETED', 'CANCELLED')
       -- A replacing group takes the pupil off the class's lessons in its
       -- subject, of its läsår. The pupil keeps one that names them, one with
       -- no replacing group of theirs for its subject, one any of them is
       -- added to, and one whose own group is a teaching group (not a half)
       -- they are placed in.
       AND (
             cl."id" IN (SELECT id FROM named)
          OR NOT EXISTS (SELECT 1 FROM replacing g
                          WHERE g.subject = cl."subjectId"
                            AND g.year = (SELECT og."academicYearId" FROM "StudentGroups" og WHERE og."id" = cl."studentGroupId"))
          OR EXISTS (SELECT 1 FROM replacing g
                      WHERE g.subject = cl."subjectId"
                        AND g.year = (SELECT og."academicYearId" FROM "StudentGroups" og WHERE og."id" = cl."studentGroupId")
                        AND EXISTS (SELECT 1 FROM "CalendarLessonGroups" x
                                     WHERE x."calendarLessonId" = cl."id" AND x."studentGroupId" = g."id"))
          -- (a replacing group of theirs as the lesson's own group is a
          -- teaching group they are placed in: the next branch keeps them.)
          OR EXISTS (SELECT 1 FROM "StudentGroups" og
                      WHERE og."id" = cl."studentGroupId"
                        AND og."kind" = 'TEACHING_GROUP' AND og."halfOfId" IS NULL
                        AND og."id" IN (SELECT t.g FROM teaching t))
       )
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
    LEFT JOIN app.family_lesson_labels(p_school, p_display, ARRAY(SELECT t."id" FROM theirs t), true) st ON st.lesson_id = l."id"
$$;

REVOKE ALL ON FUNCTION app.family_lesson_labels(uuid, "TeacherDisplay", uuid[], boolean) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Row-level security and grants. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "PublicTimetableHidden" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public_timetable_hidden_admin_select" ON "PublicTimetableHidden"
    FOR SELECT TO "app_authenticated"
    USING ("schoolId" = (select app.current_school_id())
           AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
CREATE POLICY "public_timetable_hidden_admin_insert" ON "PublicTimetableHidden"
    FOR INSERT TO "app_authenticated"
    WITH CHECK ("schoolId" = (select app.current_school_id())
                AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                AND (select app.current_user_may('PUBLICERING', true)));
CREATE POLICY "public_timetable_hidden_admin_delete" ON "PublicTimetableHidden"
    FOR DELETE TO "app_authenticated"
    USING ("schoolId" = (select app.current_school_id())
           AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
           AND (select app.current_user_may('PUBLICERING', true)));

REVOKE ALL ON FUNCTION app.timetable_pupil_days(uuid, uuid, date, text, "TeacherDisplay") FROM PUBLIC;
REVOKE ALL ON FUNCTION app.publication_settings_legacy_switches() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.viewer_handle(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.viewer_person_is_protected(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.viewer_student_showable(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.schemavisaren_read(text, uuid, date, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.schemavisaren_touch(uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.public_timetable_staff(text, uuid, date) FROM PUBLIC;

DO $$
DECLARE
  fn text;
  r text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'app.timetable_pupil_days(uuid, uuid, date, text, "TeacherDisplay")',
    'app.publication_settings_legacy_switches()',
    'app.viewer_handle(text, uuid)',
    'app.viewer_person_is_protected(uuid)',
    'app.viewer_student_showable(uuid, uuid)',
    'app.schemavisaren_read(text, uuid, date, uuid)',
    'app.schemavisaren_touch(uuid, timestamptz)',
    'app.public_timetable_staff(text, uuid, date)',
    'app.family_lesson_labels(uuid, "TeacherDisplay", uuid[], boolean)'
  ] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', fn, r);
      END IF;
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT EXECUTE ON FUNCTION app.public_timetable_staff(text, uuid, date) TO "app_authenticated";
    REVOKE ALL ON "PublicTimetableHidden" FROM "app_authenticated";
    GRANT SELECT, INSERT, DELETE ON "PublicTimetableHidden" TO "app_authenticated";
  END IF;

  FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "PublicTimetableHidden" FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "PublicTimetableHidden" FROM service_role;
  END IF;
  -- PostgreSQL 17's MAINTAIN (REINDEX, CLUSTER, VACUUM, LOCK): the owner's alone.
  IF current_setting('server_version_num')::int >= 170000 THEN
    FOREACH r IN ARRAY ARRAY['authenticated', 'app_authenticated', 'service_role', 'anon'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE MAINTAIN ON "PublicTimetableHidden" FROM %I', r);
      END IF;
    END LOOP;
  END IF;
END
$$;
