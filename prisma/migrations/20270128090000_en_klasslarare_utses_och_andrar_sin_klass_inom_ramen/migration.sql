-- En klasslärare utses och ändrar sin klass inom ramen.
--
-- The stored half of Klasslärarens schema (G5). A teacher is appointed
-- klasslärare for one class in one läsår, edits that class's lessons inside the
-- frame the schemaläggare keeps, and what they change waits as a draft of the
-- class's own until it is published. Four tables, one set of rules, and the
-- functions that say both what the frame is and who acts for the klasslärare.
--
--   * ClassTeacherAppointments   the appointment: this teacher, this class, this
--                                läsår. Made by an administrator who writes
--                                Schemaläggning; a mentor is not one.
--   * ClassTeacherSettings       one row per school: whether a klasslärare may
--                                publish their own class. Off until a row says
--                                otherwise.
--   * ClassTeacherOpenTimes      the weekly spans of the school day that are open
--                                to a class's klasslärare. No row, no open time.
--   * ClassTeacherChanges        the draft layer: one row per lesson a klasslärare
--                                wants changed, kept until it is published or
--                                discarded.
--
-- Nothing here changes an existing table. Nothing reaches the engine.
--
-- ## Who may edit what: the appointment and the frame
--
-- Nobody has the right until an administrator has made the appointment AND has
-- opened some time to it. The appointment is a delegation by that
-- administrator: appointedByUserId is the administrator the klasslärare's
-- checks and publication run as (the gateway places them as that person, as the
-- cover board places a vikarie as the administrator who sent the request:
-- app.class_teacher_actor says who, and only to the klasslärare of that class).
-- An appointment whose administrator has been removed, deactivated or no longer
-- writes Schemaläggning, Drift and Publicering lapses until another
-- administrator makes it again (CT422).
--
-- The frame is what the schemaläggare has locked, and app.class_teacher_frame
-- is its one statement. It is asked by row security on every write a klasslärare
-- makes and by the gateway, which asks first to name the reason:
--
--   * Times outside the open ones. A lesson is the klasslärare's to change only
--     while it lies inside one open span of its weekday, and only to another time
--     inside one (TIME_CLOSED, TARGET_CLOSED).
--   * Lessons with other teachers and shared resources: a lesson of another
--     class or of a half of the class (OTHER_CLASS, HALF_CLASS), one with another
--     teacher or a vikarie (OTHER_TEACHER, COVERED), a joint lesson (JOINT_LESSON),
--     a parallel block (BLOCK), a post shared between teachers (SHARED_POST), a
--     class with halves in the same subject (HALF_CLASS), a subject a replacing
--     group takes pupils of the class out of (REPLACING_GROUP), a teacher shared
--     with another school (SHARED_TEACHER) and a room lent to or from another
--     school (SHARED_ROOM).
--   * A läsår that has ended. The appointment is for one läsår; when the school's
--     calendar has passed its last day the class's grundschema and dated lessons
--     are history that statistics and reports read, and nothing of them is the
--     klasslärare's to change (YEAR_ENDED). A date to move a lesson to must lie
--     inside the läsår (TARGET_CLOSED).
--   * Published times behind a gate. Nothing a klasslärare writes reaches the
--     timetable except through publication: the draft is its own table, a
--     lesson already past or begun is closed (PAST), and so is one that has a
--     register (HAS_ATTENDANCE), a cover (COVERED) or is not an ordinary
--     scheduled lesson (NOT_SCHEDULED, NOT_A_REGULAR_LESSON). A lesson with a
--     change waiting is closed to a second one on the other layer
--     (PENDING_TEMPLATE_CHANGE, PENDING_OCCASION_CHANGE), so a published change of
--     the template cannot overwrite an exception made on one of its dates.
--
-- ## The draft layer
--
-- A draft is a row of ClassTeacherChanges. Five kinds: one date's lesson moved,
-- cancelled or given another room (OCCASION_*), and a lesson of the class's
-- grundschema moved or split in two (TEMPLATE_*). Several klasslärare, and the
-- schemaläggare, work at once, and nothing is overwritten silently:
--
--   * baseVersion is a hash of the lesson as the klasslärare saw it, and
--     baseSnapshot the same as data. A draft written against a lesson that has
--     changed since is refused (CT409, STALE); one that goes stale afterwards is
--     found at the check and at the publication, which say what changed
--     (snapshot against now) and publish nothing of it.
--   * rev counts up on every change of a draft; a writer states the one it read,
--     and a second writer meets 409 with the draft as it now stands.
--   * At most one draft waits per lesson (partial unique indexes), so two people
--     open the same draft instead of making two.
--
-- ## Beside the live API: every lock at once, or none
--
-- Production runs this while the API before it serves requests. The new keys
-- take Schools, AcademicYears, StudentGroups, Users, Rooms, MasterLessons and
-- CalendarLessons in SHARE ROW EXCLUSIVE, which blocks writes to them (not
-- reads, and not the KEY SHARE a foreign-key check takes) for the length of the
-- file; the new tables are empty, so no key validates anything. The locks are
-- taken together, NOWAIT, in a loop: a refusal rolls the subtransaction back and
-- tries again 50 ms later; it never waits while it holds a lock. After 30 s it
-- stops with nothing done and can be rerun (prisma migrate resolve
-- --rolled-back, then deploy). The old API knows none of the tables.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Schools" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "AcademicYears" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "StudentGroups" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Users" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Rooms" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "MasterLessons" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "CalendarLessons" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'The tables the new keys point at were not free at once in 30 s: nothing is changed. Prisma now holds this migration as failed, so run "prisma migrate resolve --rolled-back 20270128090000_en_klasslarare_utses_och_andrar_sin_klass_inom_ramen" and then "prisma migrate deploy" again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

CREATE TYPE "ClassTeacherChangeKind" AS ENUM
  ('OCCASION_MOVE', 'OCCASION_CANCEL', 'OCCASION_ROOM', 'TEMPLATE_MOVE', 'TEMPLATE_SPLIT');

CREATE TYPE "ClassTeacherChangeStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- ---------------------------------------------------------------------------
-- The appointment
-- ---------------------------------------------------------------------------

CREATE TABLE "ClassTeacherAppointments" (
    "id"                UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"          UUID NOT NULL,
    "academicYearId"    UUID NOT NULL,
    "studentGroupId"    UUID NOT NULL,
    "userId"            UUID NOT NULL,
    "appointedByUserId" UUID,
    "createdAt"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "ClassTeacherAppointments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ClassTeacherAppointments_one_per_class_and_teacher" UNIQUE ("studentGroupId", "userId")
);

CREATE INDEX "ClassTeacherAppointments_userId_schoolId_idx" ON "ClassTeacherAppointments" ("userId", "schoolId");
CREATE INDEX "ClassTeacherAppointments_schoolId_academicYearId_studentGroupId_idx"
    ON "ClassTeacherAppointments" ("schoolId", "academicYearId", "studentGroupId");
CREATE INDEX "ClassTeacherAppointments_appointedByUserId_schoolId_idx" ON "ClassTeacherAppointments" ("appointedByUserId", "schoolId");

ALTER TABLE "ClassTeacherAppointments"
    ADD CONSTRAINT "ClassTeacherAppointments_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "ClassTeacherAppointments_academicYearId_fkey" FOREIGN KEY ("academicYearId", "schoolId")
    REFERENCES "AcademicYears"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION,
    ADD CONSTRAINT "ClassTeacherAppointments_studentGroupId_fkey" FOREIGN KEY ("studentGroupId", "academicYearId", "schoolId")
    REFERENCES "StudentGroups"("id", "academicYearId", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION,
    ADD CONSTRAINT "ClassTeacherAppointments_userId_fkey" FOREIGN KEY ("userId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION,
    ADD CONSTRAINT "ClassTeacherAppointments_appointedByUserId_fkey" FOREIGN KEY ("appointedByUserId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE SET NULL ("appointedByUserId") ON UPDATE NO ACTION;

-- A klasslärare is a teacher of the school, and the class is a home class (not a
-- teaching group and not the half of a class). The administrator who appoints is
-- the caller: a writer with a login cannot name another one. Only the
-- administrator may change on a row (a second administrator taking the
-- appointment over); the class and the teacher are fixed. A cascade or a
-- SET NULL arrives at depth > 1 and passes.
CREATE FUNCTION app.class_teacher_appointment_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."schoolId" IS DISTINCT FROM OLD."schoolId"
       OR NEW."academicYearId" IS DISTINCT FROM OLD."academicYearId"
       OR NEW."studentGroupId" IS DISTINCT FROM OLD."studentGroupId"
       OR NEW."userId" IS DISTINCT FROM OLD."userId"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
      RAISE EXCEPTION 'CLASS_TEACHER_APPOINTMENT_IS_FIXED: the class and the teacher of an appointment do not change; make a new one'
        USING ERRCODE = 'CT400';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM "Users" u
                    WHERE u."id" = NEW."userId" AND u."schoolId" = NEW."schoolId"
                      AND u."role" = 'TEACHER' AND u."isActive") THEN
      RAISE EXCEPTION 'CLASS_TEACHER_NOT_A_TEACHER: only an active teacher of the school can be klasslärare'
        USING ERRCODE = 'CT400';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "StudentGroups" g
                    WHERE g."id" = NEW."studentGroupId" AND g."schoolId" = NEW."schoolId"
                      AND g."kind" = 'CLASS' AND g."halfOfId" IS NULL) THEN
      RAISE EXCEPTION 'CLASS_TEACHER_NOT_A_CLASS: a klasslärare belongs to a home class, not a teaching group or half of a class'
        USING ERRCODE = 'CT400';
    END IF;
  END IF;
  IF app.current_user_id() IS NOT NULL THEN
    NEW."appointedByUserId" := app.current_user_id();
  END IF;
  NEW."updatedAt" := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER "ClassTeacherAppointments_guard"
    BEFORE INSERT OR UPDATE ON "ClassTeacherAppointments"
    FOR EACH ROW EXECUTE FUNCTION app.class_teacher_appointment_guard();

-- ---------------------------------------------------------------------------
-- The school's option
-- ---------------------------------------------------------------------------

CREATE TABLE "ClassTeacherSettings" (
    "schoolId"    UUID NOT NULL,
    "selfPublish" BOOLEAN NOT NULL DEFAULT false,
    "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "ClassTeacherSettings_pkey" PRIMARY KEY ("schoolId")
);

ALTER TABLE "ClassTeacherSettings"
    ADD CONSTRAINT "ClassTeacherSettings_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- The open times
-- ---------------------------------------------------------------------------

CREATE TABLE "ClassTeacherOpenTimes" (
    "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"       UUID NOT NULL,
    "academicYearId" UUID NOT NULL,
    "studentGroupId" UUID,
    "dayOfWeek"      SMALLINT NOT NULL,
    "startTime"      TIME(0) NOT NULL,
    "endTime"        TIME(0) NOT NULL,
    "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "ClassTeacherOpenTimes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ClassTeacherOpenTimes_dayOfWeek_check" CHECK ("dayOfWeek" BETWEEN 1 AND 5),
    CONSTRAINT "ClassTeacherOpenTimes_span_check" CHECK ("startTime" < "endTime")
);

CREATE INDEX "ClassTeacherOpenTimes_schoolId_academicYearId_dayOfWeek_idx"
    ON "ClassTeacherOpenTimes" ("schoolId", "academicYearId", "dayOfWeek");
CREATE INDEX "ClassTeacherOpenTimes_studentGroupId_academicYearId_schoolId_idx"
    ON "ClassTeacherOpenTimes" ("studentGroupId", "academicYearId", "schoolId");

ALTER TABLE "ClassTeacherOpenTimes"
    ADD CONSTRAINT "ClassTeacherOpenTimes_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "ClassTeacherOpenTimes_academicYearId_fkey" FOREIGN KEY ("academicYearId", "schoolId")
    REFERENCES "AcademicYears"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION,
    ADD CONSTRAINT "ClassTeacherOpenTimes_studentGroupId_fkey" FOREIGN KEY ("studentGroupId", "academicYearId", "schoolId")
    REFERENCES "StudentGroups"("id", "academicYearId", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- The draft layer
-- ---------------------------------------------------------------------------

CREATE TABLE "ClassTeacherChanges" (
    "id"                UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"          UUID NOT NULL,
    "academicYearId"    UUID NOT NULL,
    "studentGroupId"    UUID NOT NULL,
    "authorId"          UUID,
    "kind"              "ClassTeacherChangeKind" NOT NULL,
    "status"            "ClassTeacherChangeStatus" NOT NULL DEFAULT 'DRAFT',
    "masterLessonId"    UUID,
    "calendarLessonId"  UUID,
    "date"              DATE,
    "targetDate"        DATE,
    "targetDayOfWeek"   SMALLINT,
    "targetStart"       TIME(0),
    "targetEnd"         TIME(0),
    "targetRoomId"      UUID,
    "keepEnd"           TIME(0),
    "note"              TEXT,
    "baseVersion"       TEXT NOT NULL,
    "baseSnapshot"      JSONB NOT NULL,
    "rev"               INTEGER NOT NULL DEFAULT 1,
    "publishedAt"       TIMESTAMPTZ(6),
    "publishedByUserId" UUID,
    "createdAt"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "ClassTeacherChanges_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ClassTeacherChanges_note_check" CHECK ("note" IS NULL OR char_length("note") <= 200),
    CONSTRAINT "ClassTeacherChanges_target_day_check" CHECK ("targetDayOfWeek" IS NULL OR "targetDayOfWeek" BETWEEN 1 AND 5),
    CONSTRAINT "ClassTeacherChanges_target_span_check" CHECK ("targetStart" IS NULL OR "targetEnd" IS NULL OR "targetStart" < "targetEnd"),
    CONSTRAINT "ClassTeacherChanges_published_check" CHECK (("status" = 'PUBLISHED') = ("publishedAt" IS NOT NULL)),
    -- What each kind carries and nothing else. The lesson the draft names and
    -- the room it asks for are NOT in these: a keys' SET NULL (a lesson or a
    -- room deleted) must not be refused by a CHECK, so the trigger below judges
    -- them when a person writes, and the check and the publication find a draft
    -- whose lesson is gone.
    CONSTRAINT "ClassTeacherChanges_shape_check" CHECK (CASE "kind"
      WHEN 'OCCASION_MOVE' THEN "date" IS NOT NULL AND "targetDate" IS NOT NULL
                                AND "targetStart" IS NOT NULL AND "targetEnd" IS NOT NULL
                                AND "targetDayOfWeek" IS NULL AND "keepEnd" IS NULL
      WHEN 'OCCASION_CANCEL' THEN "date" IS NOT NULL AND "targetDate" IS NULL AND "targetDayOfWeek" IS NULL
                                AND "targetStart" IS NULL AND "targetEnd" IS NULL AND "keepEnd" IS NULL
      WHEN 'OCCASION_ROOM' THEN "date" IS NOT NULL AND "targetDate" IS NULL AND "targetDayOfWeek" IS NULL
                                AND "targetStart" IS NULL AND "targetEnd" IS NULL AND "keepEnd" IS NULL
      WHEN 'TEMPLATE_MOVE' THEN "date" IS NULL AND "targetDate" IS NULL AND "targetDayOfWeek" IS NOT NULL
                                AND "targetStart" IS NOT NULL AND "targetEnd" IS NOT NULL AND "keepEnd" IS NULL
      WHEN 'TEMPLATE_SPLIT' THEN "date" IS NULL AND "targetDate" IS NULL AND "targetDayOfWeek" IS NOT NULL
                                AND "targetStart" IS NOT NULL AND "targetEnd" IS NOT NULL AND "keepEnd" IS NOT NULL
      ELSE false END)
);

CREATE INDEX "ClassTeacherChanges_schoolId_studentGroupId_status_idx" ON "ClassTeacherChanges" ("schoolId", "studentGroupId", "status");
CREATE INDEX "ClassTeacherChanges_authorId_schoolId_idx" ON "ClassTeacherChanges" ("authorId", "schoolId");
CREATE INDEX "ClassTeacherChanges_publishedByUserId_schoolId_idx" ON "ClassTeacherChanges" ("publishedByUserId", "schoolId");
CREATE INDEX "ClassTeacherChanges_masterLessonId_schoolId_idx" ON "ClassTeacherChanges" ("masterLessonId", "schoolId");
CREATE INDEX "ClassTeacherChanges_calendarLessonId_schoolId_idx" ON "ClassTeacherChanges" ("calendarLessonId", "schoolId");
CREATE INDEX "ClassTeacherChanges_targetRoomId_schoolId_idx" ON "ClassTeacherChanges" ("targetRoomId", "schoolId");
CREATE INDEX "ClassTeacherChanges_academicYearId_schoolId_idx" ON "ClassTeacherChanges" ("academicYearId", "schoolId");

-- One draft waits per lesson, on each layer.
CREATE UNIQUE INDEX "ClassTeacherChanges_one_draft_per_calendar_lesson"
    ON "ClassTeacherChanges" ("calendarLessonId") WHERE "status" = 'DRAFT' AND "calendarLessonId" IS NOT NULL;
CREATE UNIQUE INDEX "ClassTeacherChanges_one_draft_per_master_lesson"
    ON "ClassTeacherChanges" ("masterLessonId") WHERE "status" = 'DRAFT' AND "masterLessonId" IS NOT NULL;

ALTER TABLE "ClassTeacherChanges"
    ADD CONSTRAINT "ClassTeacherChanges_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "ClassTeacherChanges_academicYearId_fkey" FOREIGN KEY ("academicYearId", "schoolId")
    REFERENCES "AcademicYears"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION,
    ADD CONSTRAINT "ClassTeacherChanges_studentGroupId_fkey" FOREIGN KEY ("studentGroupId", "academicYearId", "schoolId")
    REFERENCES "StudentGroups"("id", "academicYearId", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION,
    ADD CONSTRAINT "ClassTeacherChanges_authorId_fkey" FOREIGN KEY ("authorId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE SET NULL ("authorId") ON UPDATE NO ACTION,
    ADD CONSTRAINT "ClassTeacherChanges_publishedByUserId_fkey" FOREIGN KEY ("publishedByUserId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE SET NULL ("publishedByUserId") ON UPDATE NO ACTION,
    ADD CONSTRAINT "ClassTeacherChanges_masterLessonId_fkey" FOREIGN KEY ("masterLessonId", "schoolId")
    REFERENCES "MasterLessons"("id", "schoolId") ON DELETE SET NULL ("masterLessonId") ON UPDATE NO ACTION,
    ADD CONSTRAINT "ClassTeacherChanges_calendarLessonId_fkey" FOREIGN KEY ("calendarLessonId", "schoolId")
    REFERENCES "CalendarLessons"("id", "schoolId") ON DELETE SET NULL ("calendarLessonId") ON UPDATE NO ACTION,
    ADD CONSTRAINT "ClassTeacherChanges_targetRoomId_fkey" FOREIGN KEY ("targetRoomId", "schoolId")
    REFERENCES "Rooms"("id", "schoolId") ON DELETE SET NULL ("targetRoomId") ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- What the lesson looks like, as a hash and as data. One definition, used by
-- the trigger that checks a draft against the lesson it was written for and by
-- the gateway that finds a draft gone stale. Answered for a lesson of the
-- caller's school only.
--
-- TWO TIERS. The functions the API's role runs resolve the caller's school
-- once (app.current_school_id() is a lookup of the login's row, and in a filter
-- or a list it would run for every lesson) and call the "_in" functions below
-- with it. The "_in" functions take the school as an argument, so they are the
-- API role's to run NEVER (they are not granted): a school named by a caller
-- would be a school read across the boundary. A definer calling a definer is
-- judged by the owner's right, so the entry points still reach them.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.class_teacher_master_snapshot_in(p_school uuid, p_master uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT jsonb_build_object(
           'dayOfWeek', m."dayOfWeek",
           'startTime', left(m."startTime"::text, 5),
           'endTime', left(m."endTime"::text, 5),
           'roomId', m."roomId",
           'teacherId', m."teacherId",
           'coTeacherId', m."coTeacherId",
           'recurrence', m."recurrence",
           'startDate', m."startDate",
           'endDate', m."endDate",
           'isParked', m."isParked",
           'extraGroups', coalesce((SELECT jsonb_agg(g."studentGroupId" ORDER BY g."studentGroupId")
                                      FROM "MasterLessonGroups" g WHERE g."masterLessonId" = m."id"), '[]'::jsonb),
           'students', coalesce((SELECT jsonb_agg(s."studentId" ORDER BY s."studentId")
                                   FROM "MasterLessonStudents" s WHERE s."masterLessonId" = m."id"), '[]'::jsonb))
    FROM "MasterLessons" m
   WHERE m."id" = p_master AND m."schoolId" = p_school
$$;

CREATE FUNCTION app.class_teacher_calendar_snapshot_in(p_school uuid, p_calendar uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT jsonb_build_object(
           'status', c."status",
           'startsAt', to_char(c."startsAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'endsAt', to_char(c."endsAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'roomId', c."roomId",
           'note', c."note",
           'teachers', coalesce((SELECT jsonb_agg(t."teacherId"::text || ':' || t."role"::text ORDER BY t."teacherId", t."role")
                                   FROM "CalendarLessonTeachers" t WHERE t."calendarLessonId" = c."id"), '[]'::jsonb))
    FROM "CalendarLessons" c
   WHERE c."id" = p_calendar AND c."schoolId" = p_school
$$;

CREATE FUNCTION app.class_teacher_master_snapshot(p_master uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT app.class_teacher_master_snapshot_in(app.current_school_id(), p_master)
$$;

CREATE FUNCTION app.class_teacher_master_version(p_master uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT md5(app.class_teacher_master_snapshot_in(app.current_school_id(), p_master)::text)
$$;

CREATE FUNCTION app.class_teacher_calendar_snapshot(p_calendar uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT app.class_teacher_calendar_snapshot_in(app.current_school_id(), p_calendar)
$$;

CREATE FUNCTION app.class_teacher_calendar_version(p_calendar uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT md5(app.class_teacher_calendar_snapshot_in(app.current_school_id(), p_calendar)::text)
$$;

-- ---------------------------------------------------------------------------
-- The pieces of the frame.
-- ---------------------------------------------------------------------------

-- Is the signed-in person klasslärare of the class?
CREATE FUNCTION app.is_class_teacher(p_class uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT EXISTS (
    SELECT 1 FROM "ClassTeacherAppointments" a
     WHERE a."studentGroupId" = p_class
       AND a."userId" = app.current_user_id()
       AND a."schoolId" = app.current_school_id()
  )
$$;

-- Does one span of the class's weekday, its own or the whole year's, hold
-- [p_start, p_end]? A span is not stitched to the next one: the gateway merges
-- spans that touch when it saves them.
CREATE FUNCTION app.class_teacher_slot_open_in(p_school uuid, p_class uuid, p_day integer, p_start time, p_end time) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT EXISTS (
    SELECT 1
      FROM "StudentGroups" g
      JOIN "ClassTeacherOpenTimes" o
        ON o."schoolId" = g."schoolId" AND o."academicYearId" = g."academicYearId"
       AND (o."studentGroupId" IS NULL OR o."studentGroupId" = g."id")
     WHERE g."id" = p_class
       AND g."schoolId" = p_school
       AND o."dayOfWeek" = p_day
       AND o."startTime" <= p_start
       AND o."endTime" >= p_end
  )
$$;

-- Is the room lent to, or lent from, another school (asked for or approved, not
-- yet ended)?
CREATE FUNCTION app.class_teacher_room_is_lent_in(p_school uuid, p_room uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT EXISTS (
    SELECT 1 FROM "RoomLoans" l
     WHERE l."status" IN ('PENDING', 'APPROVED')
       AND l."endedAt" IS NULL
       AND l."endDate" >= current_date
       AND ((l."roomId" = p_room AND l."ownerSchoolId" = p_school)
         OR (l."localRoomId" = p_room AND l."borrowerSchoolId" = p_school))
  )
$$;

-- Has the class's läsår ended, on the school's clock? Then the appointment is
-- history: the grundschema and the dated lessons of a finished year are what
-- statistics and reports read, and the activation of the next year leaves the
-- appointments where they were. Internal (the school is an argument): the
-- pieces and the frame call it.
CREATE FUNCTION app.class_teacher_year_ended_in(p_school uuid, p_class uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT EXISTS (
    SELECT 1
      FROM "StudentGroups" g
      JOIN "AcademicYears" y ON y."id" = g."academicYearId" AND y."schoolId" = g."schoolId"
      JOIN "Schools" s ON s."id" = g."schoolId"
     WHERE g."id" = p_class
       AND g."schoolId" = p_school
       AND y."endDate" < (now() AT TIME ZONE s."timezone")::date
  )
$$;

-- A target room: the school's own, not lent, and not one that needs approval.
CREATE FUNCTION app.class_teacher_room_refusal_in(p_school uuid, p_room uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT CASE
           WHEN r."id" IS NULL THEN 'ROOM_NOT_FOUND'
           WHEN app.class_teacher_room_is_lent_in(p_school, r."id") THEN 'SHARED_ROOM'
           WHEN r."requiresApproval" THEN 'ROOM_NEEDS_APPROVAL'
         END
    FROM (SELECT 1) one
    LEFT JOIN "Rooms" r ON r."id" = p_room AND r."schoolId" = p_school
$$;

CREATE FUNCTION app.class_teacher_room_refusal(p_room uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT app.class_teacher_room_refusal_in(app.current_school_id(), p_room)
$$;

-- What keeps a lesson of the class's grundschema from being the klasslärare's,
-- apart from the clock. NULL when nothing does. The first reason found, in the
-- order the schemaläggare would explain them.
CREATE FUNCTION app.class_teacher_master_refusal_in(p_school uuid, p_teacher uuid, p_class uuid, p_master uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  m "MasterLessons";
  req "TeachingRequirements";
BEGIN
  SELECT * INTO m FROM "MasterLessons" x WHERE x."id" = p_master AND x."schoolId" = p_school;
  IF NOT FOUND THEN
    RETURN 'LESSON_GONE';
  END IF;
  IF m."studentGroupId" <> p_class THEN
    IF EXISTS (SELECT 1 FROM "StudentGroups" h
                WHERE h."id" = m."studentGroupId" AND h."halfOfId" = p_class AND h."schoolId" = p_school) THEN
      RETURN 'HALF_CLASS';
    END IF;
    RETURN 'OTHER_CLASS';
  END IF;
  IF m."isParked" THEN
    RETURN 'PARKED';
  END IF;
  IF EXISTS (SELECT 1 FROM "MasterLessonGroups" g WHERE g."masterLessonId" = m."id")
     OR EXISTS (SELECT 1 FROM "MasterLessonStudents" s WHERE s."masterLessonId" = m."id") THEN
    RETURN 'JOINT_LESSON';
  END IF;
  IF m."teacherId" IS DISTINCT FROM p_teacher
     OR (m."coTeacherId" IS NOT NULL AND m."coTeacherId" IS DISTINCT FROM p_teacher) THEN
    RETURN 'OTHER_TEACHER';
  END IF;
  SELECT * INTO req FROM "TeachingRequirements" r
   WHERE r."schoolId" = p_school AND r."academicYearId" = m."academicYearId"
     AND r."studentGroupId" = m."studentGroupId" AND r."subjectId" = m."subjectId";
  IF FOUND THEN
    IF req."blockId" IS NOT NULL THEN
      RETURN 'BLOCK';
    END IF;
    IF EXISTS (SELECT 1 FROM "TeachingRequirementShares" s WHERE s."requirementId" = req."id" AND s."schoolId" = p_school) THEN
      RETURN 'SHARED_POST';
    END IF;
  END IF;
  -- The class has halves that read this subject: the lesson is half of a pair.
  IF EXISTS (SELECT 1 FROM "StudentGroups" h
               JOIN "MasterLessons" hm ON hm."studentGroupId" = h."id" AND hm."schoolId" = h."schoolId"
              WHERE h."halfOfId" = p_class AND h."schoolId" = p_school AND hm."subjectId" = m."subjectId") THEN
    RETURN 'HALF_CLASS';
  END IF;
  -- A replacing group takes pupils of this class out of this subject.
  IF EXISTS (SELECT 1 FROM "StudentGroups" g
               JOIN "StudentGroupMembers" gm ON gm."studentGroupId" = g."id" AND gm."schoolId" = g."schoolId"
               JOIN "Users" u ON u."id" = gm."studentId" AND u."schoolId" = gm."schoolId"
              WHERE g."schoolId" = p_school AND g."academicYearId" = m."academicYearId"
                AND g."replacesSubjectId" = m."subjectId" AND u."studentGroupId" = p_class) THEN
    RETURN 'REPLACING_GROUP';
  END IF;
  IF EXISTS (SELECT 1 FROM "SharedTeacherMarks" t WHERE t."teacherId" = p_teacher AND t."schoolId" = p_school) THEN
    RETURN 'SHARED_TEACHER';
  END IF;
  IF m."roomId" IS NOT NULL AND app.class_teacher_room_is_lent_in(p_school, m."roomId") THEN
    RETURN 'SHARED_ROOM';
  END IF;
  RETURN NULL;
END
$$;

-- The same, and the lesson's own time: the template lesson as the page draws it.
-- p_creating: a NEW change is being asked for, so a change waiting on the dated
-- layer of this lesson stops it; a change already written is not stopped by its
-- neighbour (or the two would wait for each other for ever).
CREATE FUNCTION app.class_teacher_master_state_in(p_school uuid, p_teacher uuid, p_class uuid, p_master uuid, p_creating boolean) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  m "MasterLessons";
  refusal text;
BEGIN
  IF app.class_teacher_year_ended_in(p_school, p_class) THEN
    RETURN 'YEAR_ENDED';
  END IF;
  refusal := app.class_teacher_master_refusal_in(p_school, p_teacher, p_class, p_master);
  IF refusal IS NOT NULL THEN
    RETURN refusal;
  END IF;
  SELECT * INTO m FROM "MasterLessons" x WHERE x."id" = p_master AND x."schoolId" = p_school;
  IF NOT app.class_teacher_slot_open_in(p_school, p_class, m."dayOfWeek", m."startTime"::time, m."endTime"::time) THEN
    RETURN 'TIME_CLOSED';
  END IF;
  IF p_creating AND EXISTS (SELECT 1 FROM "ClassTeacherChanges" c
                             JOIN "CalendarLessons" cl ON cl."id" = c."calendarLessonId" AND cl."schoolId" = c."schoolId"
                            WHERE c."schoolId" = p_school AND c."status" = 'DRAFT' AND cl."masterLessonId" = m."id") THEN
    RETURN 'PENDING_OCCASION_CHANGE';
  END IF;
  RETURN NULL;
END
$$;

-- What keeps one dated lesson from being the klasslärare's: the lesson-level
-- rules of its template, and the day's own.
CREATE FUNCTION app.class_teacher_calendar_refusal_in(p_school uuid, p_teacher uuid, p_class uuid, p_calendar uuid, p_creating boolean) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  c "CalendarLessons";
  tz text;
  refusal text;
BEGIN
  IF app.class_teacher_year_ended_in(p_school, p_class) THEN
    RETURN 'YEAR_ENDED';
  END IF;
  SELECT * INTO c FROM "CalendarLessons" x WHERE x."id" = p_calendar AND x."schoolId" = p_school;
  IF NOT FOUND THEN
    RETURN 'LESSON_GONE';
  END IF;
  IF c."studentGroupId" <> p_class THEN
    IF EXISTS (SELECT 1 FROM "StudentGroups" h
                WHERE h."id" = c."studentGroupId" AND h."halfOfId" = p_class AND h."schoolId" = p_school) THEN
      RETURN 'HALF_CLASS';
    END IF;
    RETURN 'OTHER_CLASS';
  END IF;
  IF c."masterLessonId" IS NULL
     OR EXISTS (SELECT 1 FROM "ScheduleActivityLessons" a WHERE a."calendarLessonId" = c."id") THEN
    RETURN 'NOT_A_REGULAR_LESSON';
  END IF;
  IF c."status" <> 'SCHEDULED' THEN
    RETURN 'NOT_SCHEDULED';
  END IF;
  IF c."startsAt" <= now() THEN
    RETURN 'PAST';
  END IF;
  IF EXISTS (SELECT 1 FROM "CalendarLessonGroups" g WHERE g."calendarLessonId" = c."id")
     OR EXISTS (SELECT 1 FROM "CalendarLessonStudents" s WHERE s."calendarLessonId" = c."id") THEN
    RETURN 'JOINT_LESSON';
  END IF;
  IF EXISTS (SELECT 1 FROM "CalendarLessonTeachers" t WHERE t."calendarLessonId" = c."id" AND t."role" = 'SUBSTITUTE')
     OR EXISTS (SELECT 1 FROM "TeacherAbsenceCovers" a WHERE a."calendarLessonId" = c."id" AND a."schoolId" = p_school) THEN
    RETURN 'COVERED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "CalendarLessonTeachers" t WHERE t."calendarLessonId" = c."id" AND t."teacherId" = p_teacher)
     OR EXISTS (SELECT 1 FROM "CalendarLessonTeachers" t WHERE t."calendarLessonId" = c."id" AND t."teacherId" <> p_teacher) THEN
    RETURN 'OTHER_TEACHER';
  END IF;
  IF EXISTS (SELECT 1 FROM "AttendanceRecords" a
              WHERE a."calendarLessonId" = c."id" AND a."schoolId" = p_school AND a."status" <> 'UNKNOWN') THEN
    RETURN 'HAS_ATTENDANCE';
  END IF;
  refusal := app.class_teacher_master_refusal_in(p_school, p_teacher, p_class, c."masterLessonId");
  IF refusal IS NOT NULL THEN
    RETURN refusal;
  END IF;
  SELECT s."timezone" INTO tz FROM "Schools" s WHERE s."id" = p_school;
  IF NOT app.class_teacher_slot_open_in(
           p_school, p_class,
           extract(isodow FROM (c."startsAt" AT TIME ZONE tz))::integer,
           (c."startsAt" AT TIME ZONE tz)::time,
           (c."endsAt" AT TIME ZONE tz)::time) THEN
    RETURN 'TIME_CLOSED';
  END IF;
  IF p_creating AND EXISTS (SELECT 1 FROM "ClassTeacherChanges" t
                             WHERE t."masterLessonId" = c."masterLessonId" AND t."schoolId" = p_school AND t."status" = 'DRAFT') THEN
    RETURN 'PENDING_TEMPLATE_CHANGE';
  END IF;
  RETURN NULL;
END
$$;

-- THE FRAME. NULL when the change is the klasslärare's to make, otherwise the
-- name of what stops it. Row security asks it on every write of a klasslärare's
-- and the gateway asks it first, to say why. p_teacher is stated, not read from
-- the claims, so the gateway can ask it for a draft's author as the
-- administrator the checks run as.
CREATE FUNCTION app.class_teacher_frame(
  p_teacher uuid, p_class uuid, p_kind "ClassTeacherChangeKind",
  p_master uuid, p_calendar uuid,
  p_target_date date, p_target_day integer, p_target_start time, p_target_end time,
  p_target_room uuid, p_keep_end time, p_creating boolean
) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  school uuid := app.current_school_id();
  tz text;
  refusal text;
  m "MasterLessons";
  first_minutes numeric;
  second_minutes numeric;
  whole_minutes numeric;
BEGIN
  IF p_teacher IS NULL OR school IS NULL
     OR NOT EXISTS (SELECT 1 FROM "ClassTeacherAppointments" a
                     WHERE a."studentGroupId" = p_class AND a."userId" = p_teacher AND a."schoolId" = school) THEN
    RETURN 'NOT_APPOINTED';
  END IF;
  SELECT s."timezone" INTO tz FROM "Schools" s WHERE s."id" = school;

  IF p_kind IN ('OCCASION_MOVE', 'OCCASION_CANCEL', 'OCCASION_ROOM') THEN
    IF p_calendar IS NULL THEN
      RETURN 'LESSON_GONE';
    END IF;
    refusal := app.class_teacher_calendar_refusal_in(school, p_teacher, p_class, p_calendar, p_creating);
    IF refusal IS NOT NULL THEN
      RETURN refusal;
    END IF;
    IF p_kind = 'OCCASION_MOVE' THEN
      IF p_target_date IS NULL OR p_target_start IS NULL OR p_target_end IS NULL THEN
        RETURN 'TARGET_MISSING';
      END IF;
      -- By the instant, not the day: today at a clock that has passed is the past.
      IF ((p_target_date + p_target_start) AT TIME ZONE tz) <= now() THEN
        RETURN 'PAST';
      END IF;
      IF extract(isodow FROM p_target_date) > 5 THEN
        RETURN 'WEEKEND';
      END IF;
      -- A date outside the class's läsår is no school day of it.
      IF NOT EXISTS (SELECT 1 FROM "StudentGroups" g
                       JOIN "AcademicYears" y ON y."id" = g."academicYearId" AND y."schoolId" = g."schoolId"
                      WHERE g."id" = p_class AND g."schoolId" = school
                        AND p_target_date BETWEEN y."startDate" AND y."endDate") THEN
        RETURN 'TARGET_CLOSED';
      END IF;
      IF NOT app.class_teacher_slot_open_in(school, p_class, extract(isodow FROM p_target_date)::integer, p_target_start, p_target_end) THEN
        RETURN 'TARGET_CLOSED';
      END IF;
      IF p_target_room IS NOT NULL THEN
        RETURN app.class_teacher_room_refusal_in(school, p_target_room);
      END IF;
    ELSIF p_kind = 'OCCASION_ROOM' THEN
      IF p_target_room IS NULL THEN
        RETURN 'TARGET_MISSING';
      END IF;
      RETURN app.class_teacher_room_refusal_in(school, p_target_room);
    END IF;
    RETURN NULL;
  END IF;

  -- The template.
  IF p_master IS NULL THEN
    RETURN 'LESSON_GONE';
  END IF;
  refusal := app.class_teacher_master_state_in(school, p_teacher, p_class, p_master, p_creating);
  IF refusal IS NOT NULL THEN
    RETURN refusal;
  END IF;
  SELECT * INTO m FROM "MasterLessons" x WHERE x."id" = p_master AND x."schoolId" = school;
  IF p_target_day IS NULL OR p_target_start IS NULL OR p_target_end IS NULL THEN
    RETURN 'TARGET_MISSING';
  END IF;
  IF p_target_day NOT BETWEEN 1 AND 5 THEN
    RETURN 'WEEKEND';
  END IF;
  IF NOT app.class_teacher_slot_open_in(school, p_class, p_target_day, p_target_start, p_target_end) THEN
    RETURN 'TARGET_CLOSED';
  END IF;
  IF p_target_room IS NOT NULL AND p_target_room IS DISTINCT FROM m."roomId" THEN
    refusal := app.class_teacher_room_refusal_in(school, p_target_room);
    IF refusal IS NOT NULL THEN
      RETURN refusal;
    END IF;
  END IF;
  IF p_kind = 'TEMPLATE_SPLIT' THEN
    IF p_keep_end IS NULL THEN
      RETURN 'TARGET_MISSING';
    END IF;
    whole_minutes := extract(epoch FROM (m."endTime"::time - m."startTime"::time)) / 60;
    first_minutes := extract(epoch FROM (p_keep_end - m."startTime"::time)) / 60;
    second_minutes := extract(epoch FROM (p_target_end - p_target_start)) / 60;
    IF first_minutes < 15 OR second_minutes < 15 OR first_minutes + second_minutes <> whole_minutes THEN
      RETURN 'SPLIT_MINUTES';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

-- ---------------------------------------------------------------------------
-- A draft is written against the lesson as the klasslärare saw it.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.class_teacher_change_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  school uuid := app.current_school_id();
  c "CalendarLessons";
  version text;
BEGIN
  -- A cascade or a SET NULL (a lesson, a room or a person removed) arrives at
  -- depth > 1 and passes untouched.
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF app.current_user_id() IS NOT NULL THEN
      -- A draft is born a draft, in the writer's name, at revision 1.
      NEW."authorId" := app.current_user_id();
      NEW."status" := 'DRAFT';
      NEW."publishedAt" := NULL;
      NEW."publishedByUserId" := NULL;
      NEW."rev" := 1;
      NEW."createdAt" := now();
      NEW."updatedAt" := now();
    END IF;
    IF NEW."kind" IN ('OCCASION_MOVE', 'OCCASION_CANCEL', 'OCCASION_ROOM') THEN
      IF NEW."calendarLessonId" IS NULL OR NEW."masterLessonId" IS NOT NULL THEN
        RAISE EXCEPTION 'CLASS_TEACHER_CHANGE_SHAPE: an exception names the dated lesson and no template'
          USING ERRCODE = 'CT400';
      END IF;
      SELECT * INTO c FROM "CalendarLessons" x WHERE x."id" = NEW."calendarLessonId" AND x."schoolId" = NEW."schoolId";
      IF NOT FOUND THEN
        RAISE EXCEPTION 'CLASS_TEACHER_LESSON_GONE: the lesson is not there' USING ERRCODE = 'CT404';
      END IF;
      NEW."date" := c."date";
      IF app.current_user_id() IS NOT NULL THEN
        version := app.class_teacher_calendar_version(NEW."calendarLessonId");
        NEW."baseSnapshot" := app.class_teacher_calendar_snapshot(NEW."calendarLessonId");
      END IF;
      IF NEW."kind" = 'OCCASION_ROOM' AND NEW."targetRoomId" IS NULL THEN
        RAISE EXCEPTION 'CLASS_TEACHER_CHANGE_SHAPE: a room change names the room' USING ERRCODE = 'CT400';
      END IF;
    ELSE
      IF NEW."masterLessonId" IS NULL OR NEW."calendarLessonId" IS NOT NULL THEN
        RAISE EXCEPTION 'CLASS_TEACHER_CHANGE_SHAPE: a template change names the template lesson and no dated one'
          USING ERRCODE = 'CT400';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM "MasterLessons" x WHERE x."id" = NEW."masterLessonId" AND x."schoolId" = NEW."schoolId") THEN
        RAISE EXCEPTION 'CLASS_TEACHER_LESSON_GONE: the lesson is not there' USING ERRCODE = 'CT404';
      END IF;
      IF app.current_user_id() IS NOT NULL THEN
        version := app.class_teacher_master_version(NEW."masterLessonId");
        NEW."baseSnapshot" := app.class_teacher_master_snapshot(NEW."masterLessonId");
      END IF;
    END IF;
    -- A writer with no login (the owner, a fixture) states what it likes.
    IF app.current_user_id() IS NOT NULL AND NEW."baseVersion" IS DISTINCT FROM version THEN
      RAISE EXCEPTION 'CLASS_TEACHER_STALE: the lesson has changed since it was read' USING ERRCODE = 'CT409';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: a draft's target and note change; everything that says what it is
  -- about, and who wrote it, does not. A published draft is a record.
  IF OLD."status" = 'PUBLISHED' THEN
    RAISE EXCEPTION 'CLASS_TEACHER_CHANGE_IS_PUBLISHED: a published change is a record and does not change'
      USING ERRCODE = 'CT400';
  END IF;
  IF NEW."schoolId" IS DISTINCT FROM OLD."schoolId"
     OR NEW."academicYearId" IS DISTINCT FROM OLD."academicYearId"
     OR NEW."studentGroupId" IS DISTINCT FROM OLD."studentGroupId"
     OR NEW."authorId" IS DISTINCT FROM OLD."authorId"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."masterLessonId" IS DISTINCT FROM OLD."masterLessonId"
     OR NEW."calendarLessonId" IS DISTINCT FROM OLD."calendarLessonId"
     OR NEW."date" IS DISTINCT FROM OLD."date"
     OR NEW."baseVersion" IS DISTINCT FROM OLD."baseVersion"
     OR NEW."baseSnapshot" IS DISTINCT FROM OLD."baseSnapshot"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'CLASS_TEACHER_CHANGE_IS_FIXED: what a change is about, and who wrote it, does not change'
      USING ERRCODE = 'CT400';
  END IF;
  IF app.current_user_role() = 'SCHOOL_ADMIN'
     AND (NEW."targetDate" IS DISTINCT FROM OLD."targetDate"
          OR NEW."targetDayOfWeek" IS DISTINCT FROM OLD."targetDayOfWeek"
          OR NEW."targetStart" IS DISTINCT FROM OLD."targetStart"
          OR NEW."targetEnd" IS DISTINCT FROM OLD."targetEnd"
          OR NEW."targetRoomId" IS DISTINCT FROM OLD."targetRoomId"
          OR NEW."keepEnd" IS DISTINCT FROM OLD."keepEnd"
          OR NEW."note" IS DISTINCT FROM OLD."note") THEN
    RAISE EXCEPTION 'CLASS_TEACHER_CHANGE_IS_FIXED: an administrator publishes or discards a draft and does not edit it'
      USING ERRCODE = 'CT400';
  END IF;
  IF NEW."status" = 'PUBLISHED' THEN
    -- Publication stamps itself.
    NEW."publishedAt" := now();
    IF app.current_user_id() IS NOT NULL THEN
      NEW."publishedByUserId" := app.current_user_id();
    END IF;
  ELSE
    NEW."publishedAt" := NULL;
    NEW."publishedByUserId" := NULL;
  END IF;
  NEW."rev" := OLD."rev" + 1;
  NEW."updatedAt" := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER "ClassTeacherChanges_guard"
    BEFORE INSERT OR UPDATE ON "ClassTeacherChanges"
    FOR EACH ROW EXECUTE FUNCTION app.class_teacher_change_guard();

-- ---------------------------------------------------------------------------
-- For the gateway: the lessons the klasslärare sees, and the one who acts.
-- ---------------------------------------------------------------------------

-- The class's grundschema with each lesson's state: the frame's reason, or NULL
-- when the lesson is theirs. A DRAFT school hides its grundschema from every
-- teacher; the klasslärare reads their own class's, and nothing else of the
-- draft, through this function alone. The class's own lessons, the lessons of
-- its halves and the lessons it joins as an extra class. The caller's school and
-- person are read ONCE, not for every lesson.
CREATE FUNCTION app.class_teacher_master_lessons(p_class uuid)
RETURNS TABLE ("id" uuid, "studentGroupId" uuid, "subjectId" uuid, "dayOfWeek" integer,
               "startTime" time, "endTime" time, "roomId" uuid, "teacherId" uuid, "coTeacherId" uuid,
               "recurrence" "LessonRecurrence", "startDate" date, "endDate" date, "isParked" boolean,
               "version" text, "refusal" text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  school uuid := app.current_school_id();
  me uuid := app.current_user_id();
BEGIN
  IF school IS NULL OR me IS NULL
     OR NOT EXISTS (SELECT 1 FROM "ClassTeacherAppointments" a
                     WHERE a."studentGroupId" = p_class AND a."userId" = me AND a."schoolId" = school) THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT m."id", m."studentGroupId", m."subjectId", m."dayOfWeek", m."startTime"::time, m."endTime"::time,
           m."roomId", m."teacherId", m."coTeacherId", m."recurrence", m."startDate", m."endDate", m."isParked",
           md5(app.class_teacher_master_snapshot_in(school, m."id")::text),
           app.class_teacher_master_state_in(school, me, p_class, m."id", true)
      FROM "MasterLessons" m
      JOIN "StudentGroups" cls ON cls."id" = p_class AND cls."schoolId" = m."schoolId" AND cls."academicYearId" = m."academicYearId"
     WHERE m."schoolId" = school
       AND (m."studentGroupId" = p_class
            OR EXISTS (SELECT 1 FROM "StudentGroups" h WHERE h."id" = m."studentGroupId" AND h."halfOfId" = p_class)
            OR EXISTS (SELECT 1 FROM "MasterLessonGroups" x WHERE x."masterLessonId" = m."id" AND x."studentGroupId" = p_class));
END
$$;

-- The same for the dated lessons of [p_from, p_to].
CREATE FUNCTION app.class_teacher_calendar_states(p_class uuid, p_from date, p_to date)
RETURNS TABLE ("calendarLessonId" uuid, "version" text, "refusal" text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  school uuid := app.current_school_id();
  me uuid := app.current_user_id();
BEGIN
  IF school IS NULL OR me IS NULL
     OR NOT EXISTS (SELECT 1 FROM "ClassTeacherAppointments" a
                     WHERE a."studentGroupId" = p_class AND a."userId" = me AND a."schoolId" = school) THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT c."id",
           md5(app.class_teacher_calendar_snapshot_in(school, c."id")::text),
           app.class_teacher_calendar_refusal_in(school, me, p_class, c."id", true)
      FROM "CalendarLessons" c
     WHERE c."schoolId" = school
       AND c."date" BETWEEN p_from AND p_to
       AND (c."studentGroupId" = p_class
            OR EXISTS (SELECT 1 FROM "StudentGroups" h WHERE h."id" = c."studentGroupId" AND h."halfOfId" = p_class)
            OR EXISTS (SELECT 1 FROM "CalendarLessonGroups" x WHERE x."calendarLessonId" = c."id" AND x."studentGroupId" = p_class));
END
$$;

-- The administrator the klasslärare's checks and publication run as: the one
-- who made the appointment, while they are still an active administrator who
-- writes Schemaläggning, Drift and Publicering. Answered to the klasslärare of
-- the class and to nobody else.
--
--   CT403  the caller is not klasslärare of the class
--   CT422  the appointing administrator is gone or no longer writes all three
CREATE FUNCTION app.class_teacher_actor(p_class uuid)
RETURNS TABLE ("userId" uuid, "authId" uuid, "adminProfile" "AdminProfile", "hrRead" boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  me uuid := app.current_user_id();
  school uuid := app.current_school_id();
  appointer uuid;
BEGIN
  IF me IS NULL OR school IS NULL OR app.current_user_role() IS DISTINCT FROM 'TEACHER' THEN
    RAISE EXCEPTION 'CLASS_TEACHER_NOT_APPOINTED' USING ERRCODE = 'CT403';
  END IF;
  SELECT a."appointedByUserId" INTO appointer
    FROM "ClassTeacherAppointments" a
   WHERE a."studentGroupId" = p_class AND a."userId" = me AND a."schoolId" = school;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CLASS_TEACHER_NOT_APPOINTED' USING ERRCODE = 'CT403';
  END IF;
  RETURN QUERY
    SELECT u."id", u."authId", u."adminProfile", u."hrRead"
      FROM "Users" u
     WHERE u."id" = appointer AND u."schoolId" = school
       AND u."role" = 'SCHOOL_ADMIN' AND u."isActive"
       AND 'SCHEMALAGGNING' = ANY (app.admin_profile_writes(u."adminProfile")::text[])
       AND 'DRIFT' = ANY (app.admin_profile_writes(u."adminProfile")::text[])
       AND 'PUBLICERING' = ANY (app.admin_profile_writes(u."adminProfile")::text[]);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CLASS_TEACHER_APPOINTER_GONE' USING ERRCODE = 'CT422';
  END IF;
END
$$;

COMMENT ON FUNCTION app.class_teacher_frame(uuid, uuid, "ClassTeacherChangeKind", uuid, uuid, date, integer, time, time, uuid, time, boolean) IS
  'The frame: NULL when the change is the klasslärare''s to make, else the name of what stops it. Asked by row security on every write of a klasslärare and by the gateway, which names the reason.';
COMMENT ON FUNCTION app.class_teacher_actor(uuid) IS
  'The administrator the klasslärare''s checks and publication run as (the one who made the appointment), answered to the klasslärare of the class. CT403 not appointed; CT422 the administrator is gone or no longer writes Schemaläggning, Drift and Publicering.';
COMMENT ON FUNCTION app.class_teacher_master_lessons(uuid) IS
  'The class''s grundschema (own lessons, its halves'' and the ones it joins) with the frame''s reason per lesson, for the class''s klasslärare; a DRAFT school''s grundschema is otherwise hidden from teachers.';

-- ---------------------------------------------------------------------------
-- Row-level security and grants. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "ClassTeacherAppointments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClassTeacherSettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClassTeacherOpenTimes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClassTeacherChanges" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r text;
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    -- Appointments: administrators read all and write by Schemaläggning; a
    -- teacher reads their own. An administrator's UPDATE reaches the row and
    -- its check holds the area (an error, not an empty update), as every other
    -- administrator arm does (section 116).
    CREATE POLICY "class_teacher_appointments_admin_select" ON "ClassTeacherAppointments"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "class_teacher_appointments_teacher_select" ON "ClassTeacherAppointments"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'TEACHER'
               AND "userId" = (select app.current_user_id()));
    CREATE POLICY "class_teacher_appointments_admin_insert" ON "ClassTeacherAppointments"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('SCHEMALAGGNING', true)));
    CREATE POLICY "class_teacher_appointments_admin_update" ON "ClassTeacherAppointments"
        FOR UPDATE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('SCHEMALAGGNING', true)));
    CREATE POLICY "class_teacher_appointments_admin_delete" ON "ClassTeacherAppointments"
        FOR DELETE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
               AND (select app.current_user_may('SCHEMALAGGNING', true)));

    -- Settings: staff read (the page must know whether to offer Publicera);
    -- Publicering writes. No arm deletes: the row goes with the school.
    CREATE POLICY "class_teacher_settings_staff_select" ON "ClassTeacherSettings"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) IN ('SCHOOL_ADMIN', 'TEACHER'));
    CREATE POLICY "class_teacher_settings_admin_insert" ON "ClassTeacherSettings"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('PUBLICERING', true)));
    CREATE POLICY "class_teacher_settings_admin_update" ON "ClassTeacherSettings"
        FOR UPDATE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('PUBLICERING', true)));

    -- Open times: staff read; Schemaläggning writes.
    CREATE POLICY "class_teacher_open_times_staff_select" ON "ClassTeacherOpenTimes"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) IN ('SCHOOL_ADMIN', 'TEACHER'));
    CREATE POLICY "class_teacher_open_times_admin_insert" ON "ClassTeacherOpenTimes"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('SCHEMALAGGNING', true)));
    CREATE POLICY "class_teacher_open_times_admin_update" ON "ClassTeacherOpenTimes"
        FOR UPDATE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('SCHEMALAGGNING', true)));
    CREATE POLICY "class_teacher_open_times_admin_delete" ON "ClassTeacherOpenTimes"
        FOR DELETE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
               AND (select app.current_user_may('SCHEMALAGGNING', true)));

    -- Changes. Administrators read all; the class's klasslärare read the class's.
    -- A klasslärare writes a draft of the class they are appointed to, in their own
    -- name, and only inside the frame (app.class_teacher_frame). An administrator
    -- who writes Publicering publishes (the status) or discards a draft; no
    -- administrator writes one, since the editor they have is the real one.
    CREATE POLICY "class_teacher_changes_admin_select" ON "ClassTeacherChanges"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "class_teacher_changes_teacher_select" ON "ClassTeacherChanges"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'TEACHER'
               AND app.is_class_teacher("studentGroupId"));
    CREATE POLICY "class_teacher_changes_teacher_insert" ON "ClassTeacherChanges"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'TEACHER'
                    AND "status" = 'DRAFT'
                    AND "authorId" = (select app.current_user_id())
                    AND app.class_teacher_frame((select app.current_user_id()), "studentGroupId", "kind",
                                                "masterLessonId", "calendarLessonId", "targetDate", "targetDayOfWeek"::integer,
                                                "targetStart", "targetEnd", "targetRoomId", "keepEnd", true) IS NULL);
    CREATE POLICY "class_teacher_changes_teacher_update" ON "ClassTeacherChanges"
        FOR UPDATE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'TEACHER'
               AND "status" = 'DRAFT'
               AND app.is_class_teacher("studentGroupId"))
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'TEACHER'
                    AND "status" = 'DRAFT'
                    AND app.is_class_teacher("studentGroupId")
                    AND app.class_teacher_frame((select app.current_user_id()), "studentGroupId", "kind",
                                                "masterLessonId", "calendarLessonId", "targetDate", "targetDayOfWeek"::integer,
                                                "targetStart", "targetEnd", "targetRoomId", "keepEnd", false) IS NULL);
    CREATE POLICY "class_teacher_changes_teacher_delete" ON "ClassTeacherChanges"
        FOR DELETE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'TEACHER'
               AND "status" = 'DRAFT'
               AND app.is_class_teacher("studentGroupId"));
    CREATE POLICY "class_teacher_changes_admin_update" ON "ClassTeacherChanges"
        FOR UPDATE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
               AND "status" = 'DRAFT')
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('PUBLICERING', true)));
    CREATE POLICY "class_teacher_changes_admin_delete" ON "ClassTeacherChanges"
        FOR DELETE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
               AND "status" = 'DRAFT'
               AND (select app.current_user_may('PUBLICERING', true)));

    REVOKE ALL ON "ClassTeacherAppointments", "ClassTeacherSettings", "ClassTeacherOpenTimes", "ClassTeacherChanges" FROM app_authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "ClassTeacherAppointments" TO app_authenticated;
    GRANT SELECT, INSERT, UPDATE ON "ClassTeacherSettings" TO app_authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "ClassTeacherOpenTimes" TO app_authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "ClassTeacherChanges" TO app_authenticated;
  END IF;

  FOREACH t IN ARRAY ARRAY['ClassTeacherAppointments', 'ClassTeacherSettings', 'ClassTeacherOpenTimes', 'ClassTeacherChanges'] LOOP
    FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM service_role', t);
    END IF;
    -- PostgreSQL 17's MAINTAIN (REINDEX, CLUSTER, VACUUM, LOCK): the owner's alone.
    IF current_setting('server_version_num')::int >= 170000 THEN
      FOREACH r IN ARRAY ARRAY['authenticated', 'app_authenticated', 'service_role', 'anon'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
          EXECUTE format('REVOKE MAINTAIN ON %I FROM %I', t, r);
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  -- The functions the API calls answer its role alone. The guards are triggers
  -- run by the table's writer, and the "_in" functions (which take a school as an
  -- argument) are run by the entry points above as the owner; the API's role is
  -- granted none of them.
  FOR t IN
    SELECT p.oid::regprocedure::text
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'app'
       AND p.proname IN ('class_teacher_master_snapshot', 'class_teacher_master_version',
                         'class_teacher_calendar_snapshot', 'class_teacher_calendar_version',
                         'is_class_teacher', 'class_teacher_room_refusal', 'class_teacher_frame',
                         'class_teacher_master_lessons', 'class_teacher_calendar_states', 'class_teacher_actor')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', t, r);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO app_authenticated', t);
    END IF;
  END LOOP;
  FOR t IN
    SELECT p.oid::regprocedure::text
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'app' AND p.proname IN ('class_teacher_appointment_guard', 'class_teacher_change_guard',
                         'class_teacher_master_snapshot_in', 'class_teacher_calendar_snapshot_in', 'class_teacher_slot_open_in',
                         'class_teacher_room_is_lent_in', 'class_teacher_room_refusal_in', 'class_teacher_master_refusal_in',
                         'class_teacher_master_state_in', 'class_teacher_calendar_refusal_in', 'class_teacher_year_ended_in')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- CLASS_TEACHER_REACH: the arms above and no other. Each names the caller's
-- school and its role, none has an OR or a NOT, a write by a klasslärare is
-- held by the frame, and an administrator's by the area it needs.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  bad text;
  n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    RETURN;
  END IF;
  SELECT string_agg(p.tablename || '.' || p.policyname || ' ' || p.cmd || ' ' || p.roles::text, ', ' ORDER BY p.tablename, p.policyname) INTO bad
    FROM pg_policies p
   WHERE p.schemaname = 'public'
     AND p.tablename IN ('ClassTeacherAppointments', 'ClassTeacherSettings', 'ClassTeacherOpenTimes', 'ClassTeacherChanges')
     AND NOT coalesce(
           p.roles = '{app_authenticated}'::name[]
           AND p.permissive = 'PERMISSIVE'
           AND (p.tablename, p.policyname, p.cmd) IN (
                 ('ClassTeacherAppointments', 'class_teacher_appointments_admin_select', 'SELECT'),
                 ('ClassTeacherAppointments', 'class_teacher_appointments_teacher_select', 'SELECT'),
                 ('ClassTeacherAppointments', 'class_teacher_appointments_admin_insert', 'INSERT'),
                 ('ClassTeacherAppointments', 'class_teacher_appointments_admin_update', 'UPDATE'),
                 ('ClassTeacherAppointments', 'class_teacher_appointments_admin_delete', 'DELETE'),
                 ('ClassTeacherSettings', 'class_teacher_settings_staff_select', 'SELECT'),
                 ('ClassTeacherSettings', 'class_teacher_settings_admin_insert', 'INSERT'),
                 ('ClassTeacherSettings', 'class_teacher_settings_admin_update', 'UPDATE'),
                 ('ClassTeacherOpenTimes', 'class_teacher_open_times_staff_select', 'SELECT'),
                 ('ClassTeacherOpenTimes', 'class_teacher_open_times_admin_insert', 'INSERT'),
                 ('ClassTeacherOpenTimes', 'class_teacher_open_times_admin_update', 'UPDATE'),
                 ('ClassTeacherOpenTimes', 'class_teacher_open_times_admin_delete', 'DELETE'),
                 ('ClassTeacherChanges', 'class_teacher_changes_admin_select', 'SELECT'),
                 ('ClassTeacherChanges', 'class_teacher_changes_teacher_select', 'SELECT'),
                 ('ClassTeacherChanges', 'class_teacher_changes_teacher_insert', 'INSERT'),
                 ('ClassTeacherChanges', 'class_teacher_changes_teacher_update', 'UPDATE'),
                 ('ClassTeacherChanges', 'class_teacher_changes_teacher_delete', 'DELETE'),
                 ('ClassTeacherChanges', 'class_teacher_changes_admin_update', 'UPDATE'),
                 ('ClassTeacherChanges', 'class_teacher_changes_admin_delete', 'DELETE'))
           AND (SELECT bool_and(
                         e LIKE '%current_school_id()%'
                         AND e LIKE '%current_user_role()%'
                         AND e NOT LIKE '% OR %'
                         AND e NOT LIKE '%NOT %')
                  FROM unnest(ARRAY[p.qual, p.with_check]) e
                 WHERE e IS NOT NULL)
           AND (p.policyname NOT LIKE '%_changes_teacher_%' OR p.tablename <> 'ClassTeacherChanges' OR p.cmd = 'SELECT'
                OR p.cmd = 'DELETE'
                OR coalesce(p.with_check, p.qual) LIKE '%class_teacher_frame(%')
           AND (p.policyname NOT LIKE '%admin_%' OR p.cmd = 'SELECT' OR coalesce(p.with_check, p.qual) LIKE '%current_user_may(%'),
         false);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'CLASS_TEACHER_REACH: these arms reach the klasslärare tables beyond what the preamble says: %', bad;
  END IF;
  SELECT count(*) INTO n FROM pg_policies WHERE schemaname = 'public'
     AND tablename IN ('ClassTeacherAppointments', 'ClassTeacherSettings', 'ClassTeacherOpenTimes', 'ClassTeacherChanges');
  IF n <> 19 THEN
    RAISE EXCEPTION 'CLASS_TEACHER_REACH: the four tables have % arms, not the nineteen above', n;
  END IF;
END
$$;
