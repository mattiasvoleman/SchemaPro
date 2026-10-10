-- Skolans schema kan visas utan inloggning.
--
-- Schools print their timetables and hang them on doors: per class, per
-- teacher, per room (Skola24's Schemavisaren). Families without an account,
-- substitutes on their first day, a QR code outside the gym — all read a
-- timetable they cannot log in for. This migration lets a school share the
-- PUBLISHED timetable (the calendar) behind links nobody can guess, opted in
-- per school and per scope, showing exactly what a printed schedule shows.
--
-- ## Links, not a school slug
--
-- PublicTimetableLinks holds one row per shared link: a scope kind (GROUP,
-- TEACHER, ROOM) and either one target (a class or group, a teacher, a room)
-- or — for GROUP and ROOM only — no target, an index of the year's eligible
-- classes or the school's rooms. The token is 32 random bytes the API shows
-- once; only its sha256 is stored (tokenHash, unique), so the table leaks no
-- usable link and a revoked one (revokedAt) is dead the moment the next
-- request reaches the database. A school slug plus a token would make every
-- link of a school share one secret, revocable only all together, and the
-- slug itself says which school a printed QR code belongs to.
--
-- A TEACHER link always names its teacher: an index of every teacher's
-- signature or name is a staff list, and that is not a timetable. A GROUP
-- link to a teaching group needs at least publicMinGroupSize active members
-- (default 5): "Svenska som andraspråk — Ahmed" with one pupil identifies
-- him (refused here with PB400 PUBLIC_GROUP_TOO_SMALL, and read as gone
-- whenever the group has since shrunk).
--
-- ## What the school opts into
--
-- PublicationSettings (20261011090000) gains the viewer's columns, all off:
-- publicViewerEnabled, and one flag per scope. publicTeacherDisplay says how
-- a teacher is named on any public timetable — NONE (default), SIGNATURE
-- (the post's signature, TeacherEmployments.signature of the lesson's year;
-- nothing for a teacher without one) or NAME (first and last). NONE is the
-- default because a signature is only shown once the school has entered
-- them, and a name is the school's call; the TEACHER scope requires a
-- display other than NONE (CHECK), or its page would name nobody.
-- publicShowMeals adds a class's lunch to its own week. publicMinGroupSize
-- 3..30 is the smallest teaching group shown by name.
--
-- TeacherPublicLabels: per teacher, hidden — never a target, never named on
-- any public timetable (a protected identity, skyddad identitet). The
-- signature is not repeated here: it is the post's, already unique per
-- school and year.
--
-- ## One door: app.public_timetable()
--
-- The API reaches the viewer through one SECURITY DEFINER function, with no
-- principal at all (RLS answers nothing without one). It takes the token's
-- hash, an optional target (for an index link) and a date in the week, and
-- answers a JSON document built from a whitelist — or NULL for every reason
-- a link does not resolve (unknown, revoked, viewer or scope switched off,
-- target gone, hidden or too small), so the API answers one identical 404.
--
-- The whitelist, per lesson: start, end (school time), subject, the groups'
-- names (a class always; a teaching group only from publicMinGroupSize
-- members, else null), the room's name, the teachers' labels as the school
-- chose (never a hidden teacher's), and in GROUP and ROOM scope whether it
-- is cancelled — never why. Never a note, a cause, an id of a lesson, a
-- pupil, a count, attendance or an email. A lesson with named participants
-- (CalendarLessonStudents) is a few named pupils' lesson: left out of a
-- group's week, shown in a room's week as busy (the time only). In TEACHER
-- scope only lessons that are held as scheduled are shown, and nothing says
-- who stands in for whom: a cancelled lesson or a vikarie on a teacher's
-- page would publish their absence, which is HR and health data.
--
-- lastUsedAt is touched at most every five minutes.
--
-- ## Row-level security
--
--   * public_timetable_links_admin_all, teacher_public_labels_admin_all:
--     the SCHOOL_ADMIN, USING and WITH CHECK.
--
-- No other arm: the public reads through the function, staff and families
-- have no page for the links. EXECUTE on the function is revoked from
-- PUBLIC, anon, authenticated and service_role and granted to
-- app_authenticated only (guarded): PostgREST, which serves `authenticated`
-- and `anon`, cannot reach it.

CREATE TYPE "PublicScopeKind" AS ENUM ('GROUP', 'TEACHER', 'ROOM');
CREATE TYPE "TeacherDisplay" AS ENUM ('NONE', 'SIGNATURE', 'NAME');

ALTER TABLE "PublicationSettings"
    ADD COLUMN "publicViewerEnabled"  BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "publicGroups"         BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "publicTeachers"       BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "publicRooms"          BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "publicTeacherDisplay" "TeacherDisplay" NOT NULL DEFAULT 'NONE',
    ADD COLUMN "publicShowMeals"      BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "publicMinGroupSize"   INTEGER NOT NULL DEFAULT 5,
    ADD CONSTRAINT "PublicationSettings_min_group_size_is_sane" CHECK ("publicMinGroupSize" BETWEEN 3 AND 30),
    ADD CONSTRAINT "PublicationSettings_teachers_are_named" CHECK (NOT "publicTeachers" OR "publicTeacherDisplay" <> 'NONE');

CREATE TABLE "TeacherPublicLabels" (
    "userId"    UUID NOT NULL,
    "schoolId"  UUID NOT NULL,
    "hidden"    BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "TeacherPublicLabels_pkey" PRIMARY KEY ("userId")
);

CREATE INDEX "TeacherPublicLabels_schoolId_idx" ON "TeacherPublicLabels"("schoolId");

ALTER TABLE "TeacherPublicLabels"
    ADD CONSTRAINT "TeacherPublicLabels_userId_schoolId_fkey"
    FOREIGN KEY ("userId", "schoolId") REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PublicTimetableLinks" (
    "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"        UUID NOT NULL,
    "academicYearId"  UUID NOT NULL,
    "kind"            "PublicScopeKind" NOT NULL,
    "targetGroupId"   UUID,
    "targetTeacherId" UUID,
    "targetRoomId"    UUID,
    "tokenHash"       TEXT NOT NULL,
    "label"           TEXT,
    "createdAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "createdByUserId" UUID,
    "revokedAt"       TIMESTAMPTZ(6),
    "lastUsedAt"      TIMESTAMPTZ(6),

    CONSTRAINT "PublicTimetableLinks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PublicTimetableLinks_token_is_a_sha256" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "PublicTimetableLinks_label_is_sane" CHECK ("label" IS NULL OR char_length(btrim("label")) BETWEEN 1 AND 80),
    -- The target column of the kind, or none (an index) — never another's.
    -- A TEACHER link always names its teacher, and its label is the display's.
    CONSTRAINT "PublicTimetableLinks_target_is_the_kinds" CHECK (
        ("kind" = 'GROUP' AND "targetTeacherId" IS NULL AND "targetRoomId" IS NULL)
        OR ("kind" = 'ROOM' AND "targetGroupId" IS NULL AND "targetTeacherId" IS NULL)
        OR ("kind" = 'TEACHER' AND "targetTeacherId" IS NOT NULL AND "targetGroupId" IS NULL
            AND "targetRoomId" IS NULL AND "label" IS NULL)
    )
);

CREATE UNIQUE INDEX "PublicTimetableLinks_tokenHash_key" ON "PublicTimetableLinks"("tokenHash");
CREATE INDEX "PublicTimetableLinks_schoolId_academicYearId_idx" ON "PublicTimetableLinks"("schoolId", "academicYearId");
CREATE INDEX "PublicTimetableLinks_targetGroupId_schoolId_idx" ON "PublicTimetableLinks"("targetGroupId", "schoolId");
CREATE INDEX "PublicTimetableLinks_targetTeacherId_schoolId_idx" ON "PublicTimetableLinks"("targetTeacherId", "schoolId");
CREATE INDEX "PublicTimetableLinks_targetRoomId_schoolId_idx" ON "PublicTimetableLinks"("targetRoomId", "schoolId");
CREATE INDEX "PublicTimetableLinks_createdByUserId_schoolId_idx" ON "PublicTimetableLinks"("createdByUserId", "schoolId");

ALTER TABLE "PublicTimetableLinks"
    ADD CONSTRAINT "PublicTimetableLinks_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PublicTimetableLinks"
    ADD CONSTRAINT "PublicTimetableLinks_academicYearId_schoolId_fkey"
    FOREIGN KEY ("academicYearId", "schoolId") REFERENCES "AcademicYears"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PublicTimetableLinks"
    ADD CONSTRAINT "PublicTimetableLinks_targetGroupId_schoolId_fkey"
    FOREIGN KEY ("targetGroupId", "schoolId") REFERENCES "StudentGroups"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PublicTimetableLinks"
    ADD CONSTRAINT "PublicTimetableLinks_targetTeacherId_schoolId_fkey"
    FOREIGN KEY ("targetTeacherId", "schoolId") REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PublicTimetableLinks"
    ADD CONSTRAINT "PublicTimetableLinks_targetRoomId_schoolId_fkey"
    FOREIGN KEY ("targetRoomId", "schoolId") REFERENCES "Rooms"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PublicTimetableLinks"
    ADD CONSTRAINT "PublicTimetableLinks_createdByUserId_schoolId_fkey"
    FOREIGN KEY ("createdByUserId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE SET NULL ("createdByUserId") ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- Guards and the viewer's one door. See the preamble.
-- ---------------------------------------------------------------------------

-- Active members of a teaching group; a class is named whatever its size.
CREATE FUNCTION app.public_group_size(grp uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT count(*)::int FROM "StudentGroupMembers" m JOIN "Users" u ON u."id" = m."studentId"
   WHERE m."studentGroupId" = grp AND u."isActive"
$$;

-- A link's target is one the viewer may show: a teaching group from the
-- school's minimum size, a teacher who is staff and not hidden.
CREATE FUNCTION app.public_timetable_links_target_is_showable() RETURNS trigger
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
       OR EXISTS (SELECT 1 FROM "TeacherPublicLabels" l WHERE l."userId" = NEW."targetTeacherId" AND l."hidden") THEN
      RAISE EXCEPTION 'PUBLIC_TEACHER_NOT_SHOWABLE: läraren kan inte visas offentligt'
        USING ERRCODE = 'PB400';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PublicTimetableLinks_target_is_showable"
    BEFORE INSERT OR UPDATE OF "targetGroupId", "targetTeacherId" ON "PublicTimetableLinks"
    FOR EACH ROW EXECUTE FUNCTION app.public_timetable_links_target_is_showable();

/*
 * The viewer. NULL for every link that does not resolve; otherwise the week
 * of the date given (the school's today when null), or for an index link
 * without a target, the targets it lists.
 */
CREATE FUNCTION app.public_timetable(token_hash text, target uuid, on_date date) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  link record;
  cfg record;
  tz text;
  school_name text;
  tgt uuid;
  title text;
  week_from date;
  week_to date;
  days jsonb;
BEGIN
  SELECT l.* INTO link FROM "PublicTimetableLinks" l WHERE l."tokenHash" = token_hash AND l."revokedAt" IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT s.* INTO cfg FROM "PublicationSettings" s WHERE s."schoolId" = link."schoolId";
  IF NOT FOUND OR NOT cfg."publicViewerEnabled"
     OR (link."kind" = 'GROUP' AND NOT cfg."publicGroups")
     OR (link."kind" = 'TEACHER' AND (NOT cfg."publicTeachers" OR cfg."publicTeacherDisplay" = 'NONE'))
     OR (link."kind" = 'ROOM' AND NOT cfg."publicRooms") THEN
    RETURN NULL;
  END IF;
  SELECT sc."timezone", sc."name" INTO tz, school_name FROM "Schools" sc WHERE sc."id" = link."schoolId";

  -- At most every five minutes, so a busy link writes almost nothing.
  IF link."lastUsedAt" IS NULL OR link."lastUsedAt" < now() - interval '5 minutes' THEN
    UPDATE "PublicTimetableLinks" SET "lastUsedAt" = now() WHERE "id" = link."id";
  END IF;

  tgt := coalesce(link."targetGroupId", link."targetTeacherId", link."targetRoomId");
  IF tgt IS NULL THEN
    IF target IS NULL THEN
      -- An index: the year's showable classes and groups, or the school's rooms.
      IF link."kind" = 'GROUP' THEN
        RETURN jsonb_build_object(
          'kind', 'GROUP', 'school', school_name,
          'targets', coalesce((
            SELECT jsonb_agg(jsonb_build_object('id', g."id", 'label', g."name") ORDER BY g."name", g."id")
              FROM "StudentGroups" g
             WHERE g."schoolId" = link."schoolId" AND g."academicYearId" = link."academicYearId"
               AND (g."kind" = 'CLASS' OR app.public_group_size(g."id") >= cfg."publicMinGroupSize")
          ), '[]'::jsonb));
      END IF;
      RETURN jsonb_build_object(
        'kind', 'ROOM', 'school', school_name,
        'targets', coalesce((
          SELECT jsonb_agg(jsonb_build_object('id', r."id", 'label', r."name") ORDER BY r."name", r."id")
            FROM "Rooms" r WHERE r."schoolId" = link."schoolId"
        ), '[]'::jsonb));
    END IF;
    tgt := target;
  ELSIF target IS NOT NULL AND target <> tgt THEN
    RETURN NULL;
  END IF;

  -- The target, as the viewer may show it; anything else reads as gone.
  IF link."kind" = 'GROUP' THEN
    SELECT g."name" INTO title FROM "StudentGroups" g
     WHERE g."id" = tgt AND g."schoolId" = link."schoolId" AND g."academicYearId" = link."academicYearId"
       AND (g."kind" = 'CLASS' OR app.public_group_size(g."id") >= cfg."publicMinGroupSize");
  ELSIF link."kind" = 'ROOM' THEN
    SELECT r."name" INTO title FROM "Rooms" r WHERE r."id" = tgt AND r."schoolId" = link."schoolId";
  ELSE
    SELECT CASE cfg."publicTeacherDisplay"
             WHEN 'NAME' THEN u."firstName" || ' ' || u."lastName"
             ELSE (SELECT e."signature" FROM "TeacherEmployments" e
                    WHERE e."userId" = u."id" AND e."academicYearId" = link."academicYearId")
           END
      INTO title
      FROM "Users" u
     WHERE u."id" = tgt AND u."schoolId" = link."schoolId" AND u."isActive"
       AND u."role" IN ('TEACHER', 'SCHOOL_ADMIN')
       AND NOT EXISTS (SELECT 1 FROM "TeacherPublicLabels" l WHERE l."userId" = u."id" AND l."hidden");
  END IF;
  IF title IS NULL THEN RETURN NULL; END IF;

  week_from := coalesce(on_date, (now() AT TIME ZONE tz)::date);
  week_from := week_from - (extract(isodow FROM week_from)::int - 1);
  week_to := week_from + 6;

  WITH lessons AS (
    SELECT cl."id", cl."date", cl."startsAt", cl."endsAt", cl."status", cl."roomId", cl."subjectId", cl."studentGroupId",
           EXISTS (SELECT 1 FROM "CalendarLessonStudents" p WHERE p."calendarLessonId" = cl."id") AS "named"
      FROM "CalendarLessons" cl
     WHERE cl."schoolId" = link."schoolId"
       AND cl."date" BETWEEN week_from AND week_to
       AND CASE link."kind"
             WHEN 'GROUP' THEN (cl."studentGroupId" = tgt
                                OR EXISTS (SELECT 1 FROM "CalendarLessonGroups" x
                                            WHERE x."calendarLessonId" = cl."id" AND x."studentGroupId" = tgt))
             WHEN 'ROOM' THEN cl."roomId" = tgt
             ELSE EXISTS (SELECT 1 FROM "CalendarLessonTeachers" t WHERE t."calendarLessonId" = cl."id" AND t."teacherId" = tgt)
           END
       AND CASE link."kind"
             WHEN 'TEACHER' THEN cl."status" IN ('SCHEDULED', 'COMPLETED')
             ELSE cl."status" IN ('SCHEDULED', 'COMPLETED', 'CANCELLED')
           END
  ),
  shown AS (
    SELECT l."date", l."startsAt",
           CASE
             WHEN l."named" AND link."kind" = 'ROOM' THEN
               jsonb_build_object('start', to_char(l."startsAt" AT TIME ZONE tz, 'HH24:MI'),
                                  'end', to_char(l."endsAt" AT TIME ZONE tz, 'HH24:MI'),
                                  'busy', true)
             ELSE
               jsonb_build_object(
                 'start', to_char(l."startsAt" AT TIME ZONE tz, 'HH24:MI'),
                 'end', to_char(l."endsAt" AT TIME ZONE tz, 'HH24:MI'),
                 'subject', (SELECT s."name" FROM "Subjects" s WHERE s."id" = l."subjectId"),
                 'groups', (
                   SELECT coalesce(jsonb_agg(
                            CASE WHEN g."kind" = 'CLASS' OR app.public_group_size(g."id") >= cfg."publicMinGroupSize"
                                 THEN to_jsonb(g."name") ELSE 'null'::jsonb END
                            ORDER BY (g."id" <> l."studentGroupId"), g."name"), '[]'::jsonb)
                     FROM "StudentGroups" g
                    WHERE g."id" = l."studentGroupId"
                       OR g."id" IN (SELECT x."studentGroupId" FROM "CalendarLessonGroups" x WHERE x."calendarLessonId" = l."id")),
                 'room', (SELECT r."name" FROM "Rooms" r WHERE r."id" = l."roomId"),
                 'teachers', CASE WHEN cfg."publicTeacherDisplay" = 'NONE' THEN '[]'::jsonb ELSE (
                   SELECT coalesce(jsonb_agg(lbl ORDER BY lbl), '[]'::jsonb) FROM (
                     SELECT CASE cfg."publicTeacherDisplay"
                              WHEN 'NAME' THEN u."firstName" || ' ' || u."lastName"
                              ELSE (SELECT e."signature" FROM "TeacherEmployments" e
                                     JOIN "StudentGroups" gy ON gy."id" = l."studentGroupId"
                                    WHERE e."userId" = u."id" AND e."academicYearId" = gy."academicYearId")
                            END AS lbl
                       FROM "CalendarLessonTeachers" t JOIN "Users" u ON u."id" = t."teacherId"
                      WHERE t."calendarLessonId" = l."id"
                        AND NOT EXISTS (SELECT 1 FROM "TeacherPublicLabels" h WHERE h."userId" = u."id" AND h."hidden")
                   ) labels WHERE lbl IS NOT NULL) END
               )
               || CASE WHEN link."kind" = 'TEACHER' THEN '{}'::jsonb
                       ELSE jsonb_build_object('cancelled', l."status" = 'CANCELLED') END
           END AS "lesson"
      FROM lessons l
     -- A few named pupils' lesson is theirs: not on a group's or a teacher's week.
     WHERE NOT (l."named" AND link."kind" <> 'ROOM')
  )
  SELECT coalesce(jsonb_agg(day_json ORDER BY d), '[]'::jsonb) INTO days
    FROM (
      SELECT d::date AS d,
             jsonb_build_object(
               'date', to_char(d, 'YYYY-MM-DD'),
               'lessons', coalesce((SELECT jsonb_agg(s."lesson" ORDER BY s."startsAt", s."lesson"->>'end')
                                      FROM shown s WHERE s."date" = d::date), '[]'::jsonb)
             )
             || CASE WHEN link."kind" = 'GROUP' AND cfg."publicShowMeals"
                          AND EXISTS (SELECT 1 FROM "StudentGroups" g WHERE g."id" = tgt AND g."kind" = 'CLASS')
                     THEN jsonb_build_object('meals', coalesce((
                            SELECT jsonb_agg(jsonb_build_object(
                                     'start', to_char(m."startsAt" AT TIME ZONE tz, 'HH24:MI'),
                                     'end', to_char(m."endsAt" AT TIME ZONE tz, 'HH24:MI')) ORDER BY m."startsAt")
                              FROM "CalendarLunches" m WHERE m."studentGroupId" = tgt AND m."date" = d::date), '[]'::jsonb))
                     ELSE '{}'::jsonb END AS day_json
        FROM generate_series(week_from, week_to, interval '1 day') d
    ) w;

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

REVOKE ALL ON FUNCTION app.public_group_size(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.public_timetable_links_target_is_showable() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.public_timetable(text, uuid, date) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Row-level security and grants. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "PublicTimetableLinks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TeacherPublicLabels" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public_timetable_links_admin_all" ON "PublicTimetableLinks"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
CREATE POLICY "teacher_public_labels_admin_all" ON "TeacherPublicLabels"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

DO $$
DECLARE tbl text; fn text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['PublicTimetableLinks', 'TeacherPublicLabels'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO "app_authenticated"', tbl);
      EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON %I FROM "app_authenticated"', tbl);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON %I FROM "authenticated"', tbl);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON %I FROM "anon"', tbl);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM "service_role"', tbl);
    END IF;
  END LOOP;
  FOREACH fn IN ARRAY ARRAY['app.public_timetable(text, uuid, date)', 'app.public_group_size(uuid)'] LOOP
    FOR tbl IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', fn, tbl);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT EXECUTE ON FUNCTION app.public_timetable(text, uuid, date) TO "app_authenticated";
  END IF;
END
$$;
