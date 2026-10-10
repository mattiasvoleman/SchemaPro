-- Schemavisaren visar ingen frånvaro.
--
-- 20261011120000 kept a teacher's absence off the TEACHER scope (B16): that
-- page shows only lessons held as scheduled and never says who stands in.
-- The GROUP and ROOM scopes still gave it away. The review reproduced this
-- with app.public_timetable run as app_authenticated. Erik's Svenska lesson
-- for 7A on Tue 2026-10-13 was CANCELLED with cause TEACHER_UNAVAILABLE:
--
--   * the class page answered {"subject":"Svenska","teachers":["ERJO"],
--     "cancelled":true}. A cancelled lesson kept its teacher's label, because
--     the labels were read from CalendarLessonTeachers whatever the status;
--   * on Wednesday Anna was SUBSTITUTE, and the class page answered
--     teachers:["ANLI"]. assignSubstitute replaces the lesson's teacher rows,
--     so the vikarie's label stood in for the regular teacher's;
--   * a ROOM index link lists every room. One link therefore opened every
--     room's week, which showed per teacher which lessons were cancelled and
--     which went to someone else. That is sick leave: health and HR data;
--   * the date had no bound. A ROOM link of the 2026/27 year answered for
--     the week of 2019-10-14, so a holder could page back through every week
--     and rebuild an absence history.
--
-- The function is replaced; nothing else changes:
--
--   * a CANCELLED lesson carries no teacher, in every scope. GROUP and ROOM
--     still say it is cancelled, never why, as before;
--   * a teacher is labelled only for the roles LEAD and ASSISTANT, never
--     SUBSTITUTE. A lesson held by a vikarie shows no teacher, not the
--     vikarie;
--   * the week asked for must overlap the link's läsår and end no earlier
--     than seven days before the school's today. Anything else is NULL, the
--     same single 404 as every other link that does not resolve. Without a
--     date the week is today's, or the year's first week before the year has
--     begun (it was today's, which lay outside a year not yet begun).
--
-- Teacher labels on GROUP and ROOM pages follow publicTeacherDisplay, not
-- publicTeachers. That is deliberate and was already so: publicTeachers
-- opens the TEACHER scope, a page per teacher, while a printed class
-- timetable names its teachers as the school chooses. A school that wants
-- no teacher on any page keeps the display at NONE, which is the default.
--
-- Owner, SECURITY DEFINER, search_path and the grants are unchanged.
-- CREATE OR REPLACE keeps the EXECUTE grant to app_authenticated and the
-- revokes. The REVOKE from PUBLIC is repeated, harmlessly.

CREATE OR REPLACE FUNCTION app.public_timetable(token_hash text, target uuid, on_date date) RETURNS jsonb
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
  year_start date;
  year_end date;
  today date;
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
                 'teachers', CASE WHEN cfg."publicTeacherDisplay" = 'NONE' OR l."status" = 'CANCELLED' THEN '[]'::jsonb ELSE (
                   SELECT coalesce(jsonb_agg(lbl ORDER BY lbl), '[]'::jsonb) FROM (
                     SELECT CASE cfg."publicTeacherDisplay"
                              WHEN 'NAME' THEN u."firstName" || ' ' || u."lastName"
                              ELSE (SELECT e."signature" FROM "TeacherEmployments" e
                                     JOIN "StudentGroups" gy ON gy."id" = l."studentGroupId"
                                    WHERE e."userId" = u."id" AND e."academicYearId" = gy."academicYearId")
                            END AS lbl
                       FROM "CalendarLessonTeachers" t JOIN "Users" u ON u."id" = t."teacherId"
                      WHERE t."calendarLessonId" = l."id"
                        AND t."role" IN ('LEAD', 'ASSISTANT')
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

REVOKE ALL ON FUNCTION app.public_timetable(text, uuid, date) FROM PUBLIC;
