-- Skolans schema skrivs ut och bäddas in.
--
-- Schemavisaren (20261011120000, 20261011133000) shows a class's, a
-- teacher's or a room's PUBLISHED week behind a share link, one link at a
-- time, and prints that week on an A4. Schools print whole sets: every
-- class's week for the doors, every teacher's for the staff room, every
-- room's for its door, each with the week and the period it is valid for
-- (Skola24's "Giltig fr.o.m./t.o.m."). And they put the timetable on their
-- own website. This migration gives the admin the set, gives every reader
-- the validity of the week they print, and lets a school embed the viewer
-- where it chooses.
--
-- ## One whitelist: app.timetable_week_days()
--
-- What a printed week shows was decided once, in app.public_timetable: times,
-- subject, the groups' names (a teaching group only from publicMinGroupSize
-- members), the room, the teachers as the school chose (LEAD and ASSISTANT,
-- never a hidden teacher, never on a cancelled lesson), "cancelled" in a
-- class's and a room's week (never why, never in a teacher's), "busy" for a
-- lesson of named pupils in a room's week and nothing of it elsewhere, and a
-- class's meals. The week's days are now built by one internal function,
-- moved out of app.public_timetable verbatim, with the link's and the
-- settings' values as arguments. app.public_timetable calls it and answers
-- exactly what it answered; the admin's set calls it too, so a printed sheet
-- and the viewer's page cannot drift apart. It is the owner's: nobody may
-- call it, and it runs only inside the two SECURITY DEFINER doors below.
--
-- ## The admin's set: app.print_timetables()
--
-- Every class's (CLASS groups of the läsår), every teacher's or every room's
-- week, one sheet each, for the week of a date. SCHOOL_ADMIN of the school
-- only; anybody else, and a date in no läsår, gets NULL. The viewer's rules
-- hold sheet by sheet, with three differences, all the admin's own:
--
--   * no link and no opt-in: the admin reads the published calendar anyway,
--     and printing is not publishing;
--   * how teachers are named is chosen per print (NONE, SIGNATURE, NAME),
--     not the viewer's setting: a set for the staff room may name, the
--     doors may not. A teacher's own sheet needs a name or a signature, as
--     the viewer's TEACHER scope does;
--   * any week of a läsår, not only from last week: the bound keeps a link
--     holder from paging back through a year of cancellations, and the admin
--     has the calendar.
--
-- A teacher is in the set when active, staff (TEACHER or SCHOOL_ADMIN), not
-- hidden (TeacherPublicLabels), named by the chosen display (a SIGNATURE
-- set leaves out a teacher without one, as the viewer does), and with a
-- tjänst in the läsår or a lesson in the week. Each sheet carries its
-- target's id, for the admin's own selection on the page; the viewer's
-- documents carry no id.
--
-- ## The validity of a week: app.timetable_validity()
--
-- The periods one läsår's publications make valid on the days of a week:
-- for a date, the LATEST PUBLISHED, non-REFILL publication of the läsår (by
-- publishedAt, then id) whose range contains it, and the run of dates
-- around it that no later publication of the läsår takes. That is the
-- painting the admin's timeline does, a läsår at a time
-- (src/publication/publication-validity.ts, effectiveSegments), asked one
-- date at a time: a later publication that meets the winner's range without
-- containing the date lies wholly before or wholly after it, so the run
-- ends where the nearest of them begins. The adapter probe holds the two
-- together.
--
-- The läsår is the caller's to name (the admin's set names its own), or the
-- one the days reach into, preferring the one their first day lies in, then
-- the latest begun: the print set's choice. Two läsår may overlap (a summer
-- course, a year taken again); one läsår's publications never cut
-- another's periods, as they never do on the timeline.
--
-- Any member of the school may ask (TEACHER, SCHOOL_ADMIN, STUDENT,
-- GUARDIAN): everyone who may print a week. The answer is dates only. The
-- log itself, with its gates and counts, stays the admin's
-- (20261011131000).
--
-- ## Embedding: app.public_timetable_embed()
--
-- PublicationSettings gains the embedding columns, all off:
--
--   publicEmbedGroups, publicEmbedTeachers, publicEmbedRooms
--       per scope, the one the viewer already has (the audience: families
--       read the classes, substitutes the teachers, visitors the rooms);
--   publicEmbedOrigins
--       the school's websites that may frame the viewer, at most ten
--       https origins (scheme, host, an optional port from 1 to 65535; no
--       path, no wildcard), as the Content-Security-Policy frame-ancestors source
--       list takes them.
--
-- app.public_timetable_embed(token hash) answers a link's origins when the
-- link may be embedded: not revoked, the viewer and its scope on (a
-- TEACHER link also needs a display), the scope's embedding on, and at least
-- one origin, and when the viewer itself answers the link (its own page, as
-- app.public_timetable shows it with no target and no date). Anything else
-- is NULL, so the door can tell a link holder no more than the viewer's one
-- 404 does: a link whose teacher is no longer shown, whose group has grown
-- too small or whose läsår is over is not found here either. Asking the
-- viewer marks the link used, as viewing it does (at most every five
-- minutes). The web server asks it for the frame-ancestors header of
-- /v/<token>/embed, and sends frame-ancestors 'none' for every other viewer
-- page. What an embedded page shows is the viewer's
-- document, asked of app.public_timetable as before: embedding adds a frame,
-- not a field.
--
-- ## Grants
--
-- EXECUTE on the three doors is revoked from PUBLIC, anon, authenticated and
-- service_role and granted to app_authenticated only (guarded), as for
-- app.public_timetable; the builder is revoked from everyone. RLS sections
-- 140 to 143 assert the catalogue and who gets what.

-- ---------------------------------------------------------------------------
-- Embedding settings
-- ---------------------------------------------------------------------------

ALTER TABLE "PublicationSettings"
    ADD COLUMN "publicEmbedGroups"   BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "publicEmbedTeachers" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "publicEmbedRooms"    BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "publicEmbedOrigins"  TEXT[] NOT NULL DEFAULT '{}'::text[],
    -- frame-ancestors sources, lowercase as the gateway writes them: https,
    -- a host of dot-separated labels, an optional port from 1 to 65535
    -- (what a browser's origin can carry). The elements are
    -- matched joined by spaces, one pattern per element, so an element may
    -- hold no space of its own (it would read as two sources), and a NULL
    -- element, which array_to_string drops, is refused on its own.
    ADD CONSTRAINT "PublicationSettings_embed_origins_are_origins" CHECK (
        cardinality("publicEmbedOrigins") <= 10
        AND array_position("publicEmbedOrigins", NULL) IS NULL
        AND strpos(array_to_string("publicEmbedOrigins", ''), ' ') = 0
        AND (cardinality("publicEmbedOrigins") = 0
             OR array_to_string("publicEmbedOrigins", ' ')
                ~ '^https://[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+(:(6553[0-5]|655[0-2][0-9]|65[0-4][0-9]{2}|6[0-4][0-9]{3}|[1-5][0-9]{4}|[1-9][0-9]{0,3}))?( https://[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+(:(6553[0-5]|655[0-2][0-9]|65[0-4][0-9]{2}|6[0-4][0-9]{3}|[1-5][0-9]{4}|[1-9][0-9]{0,3}))?)*$')
    );

-- ---------------------------------------------------------------------------
-- The whitelist, moved out of app.public_timetable (20261011133000).
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.timetable_week_days(
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
                    WHERE g."id" = l."studentGroupId"
                       OR g."id" IN (SELECT x."studentGroupId" FROM "CalendarLessonGroups" x WHERE x."calendarLessonId" = l."id")),
                 'room', (SELECT r."name" FROM "Rooms" r WHERE r."id" = l."roomId"),
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
$$;

COMMENT ON FUNCTION app.timetable_week_days(uuid, "PublicScopeKind", uuid, date, text, "TeacherDisplay", boolean, integer) IS
  'The days of a printed week of a class, a teacher or a room: what Schemavisaren and the admin''s print set show, and nothing else. The owner''s, called only by app.public_timetable and app.print_timetables.';

-- ---------------------------------------------------------------------------
-- app.public_timetable, with its days from the builder. Everything else is
-- 20261011133000's, line for line.
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- The admin's set. See the preamble.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.print_timetables(p_kind "PublicScopeKind", p_on date, p_display "TeacherDisplay", p_meals boolean)
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
  -- A teacher's sheet is titled by its teacher, as the viewer's TEACHER scope.
  IF p_kind = 'TEACHER' AND p_display = 'NONE' THEN RETURN NULL; END IF;
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
     WHERE p_kind = 'GROUP' AND g."schoolId" = school AND g."academicYearId" = year_id AND g."kind" = 'CLASS'
    UNION ALL
    SELECT r."id", r."name"
      FROM "Rooms" r
     WHERE p_kind = 'ROOM' AND r."schoolId" = school
    UNION ALL
    SELECT u."id",
           CASE p_display
             WHEN 'NAME' THEN u."firstName" || ' ' || u."lastName"
             ELSE (SELECT e."signature" FROM "TeacherEmployments" e
                    WHERE e."userId" = u."id" AND e."academicYearId" = year_id)
           END
      FROM "Users" u
     WHERE p_kind = 'TEACHER' AND u."schoolId" = school AND u."isActive"
       AND u."role" IN ('TEACHER', 'SCHOOL_ADMIN')
       AND NOT EXISTS (SELECT 1 FROM "TeacherPublicLabels" h WHERE h."userId" = u."id" AND h."hidden")
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

COMMENT ON FUNCTION app.print_timetables("PublicScopeKind", date, "TeacherDisplay", boolean) IS
  'For the school''s admin: every class''s, teacher''s or room''s published week of a date, one sheet each, by Schemavisaren''s whitelist (app.timetable_week_days).';

-- ---------------------------------------------------------------------------
-- The validity of a week. See the preamble.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.timetable_validity(p_from date, p_to date, p_year uuid)
RETURNS TABLE ("from" date, "to" date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  WITH year AS (
    SELECT y."id"
      FROM "AcademicYears" y
     WHERE y."schoolId" = app.current_school_id()
       AND app.current_user_role() IN ('TEACHER', 'SCHOOL_ADMIN', 'STUDENT', 'GUARDIAN')
       AND CASE WHEN p_year IS NULL THEN y."startDate" <= p_to AND y."endDate" >= p_from
                ELSE y."id" = p_year END
     ORDER BY (p_from BETWEEN y."startDate" AND y."endDate") DESC, y."startDate" DESC, y."id"
     LIMIT 1
  ),
  pubs AS (
    SELECT p."id", p."academicYearId", p."publishedAt", p."validFrom", p."validTo"
      FROM "TimetablePublications" p
      JOIN year ON year."id" = p."academicYearId"
     WHERE p."schoolId" = app.current_school_id()
       AND p."outcome" = 'PUBLISHED'
       AND p."kind" <> 'REFILL'
       AND p."validFrom" <= p_to AND p."validTo" >= p_from
  ),
  days AS (
    SELECT d::date AS d
      FROM generate_series(p_from, least(p_to, p_from + 13), interval '1 day') d
     WHERE p_from <= p_to
  ),
  winners AS (
    SELECT days.d, w.*
      FROM days
      CROSS JOIN LATERAL (
        SELECT p.* FROM pubs p WHERE days.d BETWEEN p."validFrom" AND p."validTo"
         ORDER BY p."publishedAt" DESC, p."id" DESC LIMIT 1
      ) w
  )
  SELECT DISTINCT
         greatest(w."validFrom", coalesce((
           SELECT max(q."validTo") + 1
             FROM "TimetablePublications" q
            WHERE q."academicYearId" = w."academicYearId" AND q."outcome" = 'PUBLISHED' AND q."kind" <> 'REFILL'
              AND (q."publishedAt", q."id") > (w."publishedAt", w."id")
              AND q."validTo" < w.d AND q."validTo" >= w."validFrom"), w."validFrom")) AS "from",
         least(w."validTo", coalesce((
           SELECT min(q."validFrom") - 1
             FROM "TimetablePublications" q
            WHERE q."academicYearId" = w."academicYearId" AND q."outcome" = 'PUBLISHED' AND q."kind" <> 'REFILL'
              AND (q."publishedAt", q."id") > (w."publishedAt", w."id")
              AND q."validFrom" > w.d AND q."validFrom" <= w."validTo"), w."validTo")) AS "to"
    FROM winners w
   ORDER BY 1
$$;

COMMENT ON FUNCTION app.timetable_validity(date, date, uuid) IS
  'The periods one läsår''s publications make valid on the days from p_from (at most fourteen): p_year, or the läsår the days reach into. Dates only, for any member of the caller''s school. The admin''s timeline paints the same segments (publication-validity.ts).';

-- ---------------------------------------------------------------------------
-- The embed policy. See the preamble.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.public_timetable_embed(token_hash text) RETURNS text[]
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  origins text[];
BEGIN
  SELECT s."publicEmbedOrigins" INTO origins
    FROM "PublicTimetableLinks" l
    JOIN "PublicationSettings" s ON s."schoolId" = l."schoolId"
   WHERE l."tokenHash" = token_hash
     AND l."revokedAt" IS NULL
     AND s."publicViewerEnabled"
     AND cardinality(s."publicEmbedOrigins") > 0
     AND CASE l."kind"
           WHEN 'GROUP' THEN s."publicGroups" AND s."publicEmbedGroups"
           WHEN 'ROOM' THEN s."publicRooms" AND s."publicEmbedRooms"
           ELSE s."publicTeachers" AND s."publicTeacherDisplay" <> 'NONE' AND s."publicEmbedTeachers"
         END;
  -- And only a link the viewer answers: whatever it does not show reads as
  -- gone here too.
  IF origins IS NULL OR app.public_timetable(token_hash, NULL, NULL) IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN origins;
END
$$;

COMMENT ON FUNCTION app.public_timetable_embed(text) IS
  'The websites that may frame a share link''s viewer page (frame-ancestors), or NULL when the link may not be embedded or the viewer does not answer it.';

-- ---------------------------------------------------------------------------
-- Grants. See the preamble.
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION app.timetable_week_days(uuid, "PublicScopeKind", uuid, date, text, "TeacherDisplay", boolean, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.public_timetable(text, uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.print_timetables("PublicScopeKind", date, "TeacherDisplay", boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.timetable_validity(date, date, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.public_timetable_embed(text) FROM PUBLIC;

DO $$
DECLARE fn text; r text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'app.timetable_week_days(uuid, "PublicScopeKind", uuid, date, text, "TeacherDisplay", boolean, integer)',
    'app.print_timetables("PublicScopeKind", date, "TeacherDisplay", boolean)',
    'app.timetable_validity(date, date, uuid)',
    'app.public_timetable_embed(text)'
  ] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', fn, r);
      END IF;
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT EXECUTE ON FUNCTION app.print_timetables("PublicScopeKind", date, "TeacherDisplay", boolean) TO "app_authenticated";
    GRANT EXECUTE ON FUNCTION app.timetable_validity(date, date, uuid) TO "app_authenticated";
    GRANT EXECUTE ON FUNCTION app.public_timetable_embed(text) TO "app_authenticated";
  END IF;
END
$$;
