-- Ett larm räknar eleverna utifrån schemat.
--
-- The data and the rules of Krisläge (F2). An administrator starts an alarm,
-- utrymning (EVACUATION) or inrymning (LOCKDOWN), real (LIVE) or an exercise
-- (DRILL). At that moment the gateway takes a snapshot of the timetable: for
-- every group that is in a lesson, or between two lessons of its own day, the
-- lesson that answers for it, the teachers on that lesson as the calendar says
-- they are (a vikarie D4 or the board placed has taken the absent teacher's
-- row; a replacement lesson of a schemabrytande aktivitet, D3, has its own
-- teachers) and the pupils on it, each marked if the register of the day or a
-- report already says they are absent. The teachers mark their pupils found or
-- missing, offline if they must; the administration sees the groups, the
-- pupils still missing and the teachers who have not answered; afterwards the
-- protocol is exported. This migration is the stored half;
-- src/crisis/*.ts is the other.
--
--   * CrisisSettings      who may start an alarm, and whether the guardians are
--                         told afterwards. One row per school; no row = the
--                         defaults. Decided by those who decide.
--   * CrisisAlarms        one alarm: its kind and mode, who started it and when,
--                         who ended it, and how.
--   * CrisisCalls         one group on the list: the lesson's group, subject and
--                         room as they were named, and whether the lesson was
--                         going on (LESSON) or is the group's next (NEXT_LESSON).
--   * CrisisCallTeachers  the teachers who answer for the call.
--   * CrisisPupils        the pupils on the call, with their latest mark.
--   * CrisisReports       every mark ever made, appended and never changed.
--
-- Nothing here changes an existing table's columns. Nothing reaches the
-- engine.
--
-- ## A mark is appended; the lists follow
--
-- A teacher (or the administration, for a group nobody answers for) writes one
-- row to CrisisReports per pupil: found or missing, the time the phone says
-- (held between the alarm's start and the moment the gateway got it) and a
-- primary key the phone chose, so a mark sent twice is stored once. The
-- triggers on CrisisReports keep the rest: the pupil's latest mark by time
-- (an old mark that arrives late never covers a newer one), the teacher's
-- first answer and the time the group had all its marks. No arm updates
-- CrisisPupils, CrisisCalls or CrisisCallTeachers, and the API's role holds no
-- UPDATE on them. Who marked, whether they are one of the call's teachers
-- (onBehalf) and whether the alarm had ended when the mark arrived (late) are
-- stamped by the database from the login, whatever the writer sends.
--
-- ## Nothing is added to an alarm after it has begun
--
-- The snapshot is the alarm's own transaction: the gateway writes the alarm,
-- its calls, teachers and pupils, and seals the lists (listsSealedAt, stamped
-- by the database, set once and never taken off) before it commits.
-- CrisisCalls, CrisisCallTeachers and CrisisPupils accept an insert only
-- while the alarm is open and unsealed (app.crisis_lists_are_open), and an
-- alarm nobody else can see yet is the only one that is. An administrator
-- therefore cannot add a group, a teacher or a pupil to an alarm that is
-- going, or to one that is over, and the protocol says what the lists were.
--
-- ## Who reads and who writes
--
-- Through the gateway only (app_authenticated); nothing for authenticated or
-- anon, service_role keeps its SELECT and nothing more, and MAINTAIN is the
-- owner's on 17 — as on every table since 20261016130000. No arm deletes: an
-- alarm goes only by gallring (CRISIS_DRILLS, CRISIS_ALARMS) or with the school
-- or the person it names.
--
--   crisis_settings_admin_select / _insert / _update
--       every administrator reads; those who decide write (the choice of who
--       may start an alarm, and of telling the guardians, is a decision).
--   crisis_alarms_admin_select / _insert / _update
--       every administrator reads; those who write Drift and may start an
--       alarm (app.crisis_may_start) start it and end it.
--   crisis_alarms_teacher_select
--       a TEACHER the alarm while it is open and for an hour after (they must
--       learn that it is over, and a phone without coverage sends what it
--       holds when it can).
--   crisis_calls_admin_select / _insert, crisis_call_teachers_admin_select /
--   _insert, crisis_pupils_admin_select / _insert
--       the same readers and writers; the writes only while the alarm's lists
--       are unsealed, which is the transaction that starts it.
--   crisis_calls_teacher_select, crisis_call_teachers_teacher_select,
--   crisis_pupils_teacher_select
--       a TEACHER the calls they answer for, the teachers who answer for them
--       with them (so the phone can say who else has the group), and the pupils
--       on those calls: their group and nothing else, while the alarm is open
--       and for an hour after.
--   crisis_reports_admin_select / _insert
--       the administration reads every mark, and marks for any group (those
--       who may start an alarm).
--   crisis_reports_teacher_select / _insert
--       a TEACHER the marks on the calls they answer for, and marks for the
--       pupils on those calls.
--
-- A pupil and a guardian have no arm: they read nothing of an alarm. When the
-- school has chosen to tell the guardians, they get a notice (CRISIS_GUARDIAN_AFTER)
-- after a real alarm is over, which says that it happened and ended and names
-- nobody.
--
-- ## Every key
--
-- ON UPDATE NO ACTION throughout: ids are never rewritten, and a cascade
-- would carry an owner's change of a row's school into the lists with row
-- security off.
--
--   * Everything -> Schools CASCADE; calls -> alarm, teachers, pupils and marks
--     -> call CASCADE.
--   * The person keys are ("id", "schoolId") to Users. The starter, the ender,
--     the teacher on a call, the one who marked and the one who made a pupil's
--     latest mark are SET NULL on their own column (a person removed keeps the
--     alarm's history); a pupil on a call is CASCADE (a person removed is on no
--     list).
--   * A call's lesson is SET NULL on the lesson's removal: the names the call
--     carries stay.
--
-- ## Beside the live API: every lock at once, or none
--
-- Production runs this while the API before it serves requests. No existing
-- table gains a column; the new keys take Schools, Users and CalendarLessons
-- in SHARE ROW EXCLUSIVE, which blocks writes to them (not reads, and not the
-- KEY SHARE a foreign-key check takes) for the length of the file; the new
-- tables are empty, so each key validates nothing. A request writes
-- CalendarLessons, Users and Schools in one transaction, so the locks are
-- taken together, NOWAIT, in a loop: a refusal rolls the subtransaction back
-- with whatever it got and tries again 50 ms later; it never waits while it
-- holds a lock, and no request queues behind it. After 30 s it stops with
-- nothing done and can be rerun (prisma migrate resolve --rolled-back, then
-- deploy). lock_timeout bounds any wait nobody foresaw. Run it outside an
-- SS12000 sync window, as 20261207090000.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Schools" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Users" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "CalendarLessons" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Schools, Users and CalendarLessons were not free at once in 30 s: nothing is changed, run the migration again (prisma migrate resolve --rolled-back 20270109091000_ett_larm_raknar_eleverna_utifran_schemat, then deploy)';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

CREATE TYPE "CrisisAlarmKind" AS ENUM ('EVACUATION', 'LOCKDOWN');
CREATE TYPE "CrisisAlarmMode" AS ENUM ('LIVE', 'DRILL');
CREATE TYPE "CrisisCallBasis" AS ENUM ('LESSON', 'NEXT_LESSON');
CREATE TYPE "CrisisPupilState" AS ENUM ('FOUND', 'MISSING');

-- ---------------------------------------------------------------------------
-- CrisisSettings
-- ---------------------------------------------------------------------------

CREATE TABLE "CrisisSettings" (
    "schoolId"             UUID NOT NULL,
    -- Those who decide (rektor, full) may always start an alarm; this is who
    -- else may. Every profile that writes Drift is in it until the school says
    -- otherwise.
    "startProfiles"        "AdminProfile"[] NOT NULL DEFAULT ARRAY['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION']::"AdminProfile"[],
    "notifyGuardiansAfter" BOOLEAN NOT NULL DEFAULT false,
    "createdAt"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "CrisisSettings_pkey" PRIMARY KEY ("schoolId"),
    -- The läsare writes no area, so it can start nothing: naming it would only mislead.
    CONSTRAINT "CrisisSettings_startProfiles_can_write" CHECK (NOT ('LASARE' = ANY ("startProfiles"))),
    CONSTRAINT "CrisisSettings_startProfiles_are_a_set" CHECK (cardinality("startProfiles") <= 4)
);

ALTER TABLE "CrisisSettings"
    ADD CONSTRAINT "CrisisSettings_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- CrisisAlarms
-- ---------------------------------------------------------------------------

CREATE TABLE "CrisisAlarms" (
    "id"                  UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"            UUID NOT NULL,
    "kind"                "CrisisAlarmKind" NOT NULL,
    "mode"                "CrisisAlarmMode" NOT NULL,
    -- The transaction's time (a trigger stamps it for a writer with a login).
    "startedAt"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "startedByUserId"     UUID,
    "endedAt"             TIMESTAMPTZ(6),
    "endedByUserId"       UUID,
    -- The job ended it: it had stood open longer than an alarm can.
    "autoEnded"           BOOLEAN NOT NULL DEFAULT false,
    "endNote"             TEXT,
    "guardiansNotifiedAt" TIMESTAMPTZ(6),
    -- Set once, by the transaction that wrote the lists, before it commits: the
    -- lists are final (app.crisis_lists_are_open).
    "listsSealedAt"       TIMESTAMPTZ(6),

    CONSTRAINT "CrisisAlarms_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CrisisAlarms_ends_after_it_starts" CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt"),
    CONSTRAINT "CrisisAlarms_seals_after_it_starts" CHECK ("listsSealedAt" IS NULL OR "listsSealedAt" >= "startedAt"),
    -- Said as equalities (an OR would read a null as unknown, which a CHECK lets through).
    CONSTRAINT "CrisisAlarms_auto_end_is_an_end" CHECK (NOT "autoEnded" OR "endedAt" IS NOT NULL),
    CONSTRAINT "CrisisAlarms_ender_is_an_end" CHECK ("endedByUserId" IS NULL OR "endedAt" IS NOT NULL),
    CONSTRAINT "CrisisAlarms_note_is_an_end" CHECK ("endNote" IS NULL OR "endedAt" IS NOT NULL),
    CONSTRAINT "CrisisAlarms_endNote_is_short" CHECK ("endNote" IS NULL OR (char_length("endNote") BETWEEN 1 AND 300 AND "endNote" = btrim("endNote"))),
    -- Only a real alarm is told to the guardians, and only once it is over.
    CONSTRAINT "CrisisAlarms_guardians_hear_after_a_real_one" CHECK ("guardiansNotifiedAt" IS NULL OR ("mode" = 'LIVE' AND "endedAt" IS NOT NULL))
);

CREATE UNIQUE INDEX "CrisisAlarms_id_schoolId_key" ON "CrisisAlarms"("id", "schoolId");
-- One alarm of each mode open at a time: a real one can start beside an
-- exercise (the gateway ends the exercise first), never two exercises.
CREATE UNIQUE INDEX "CrisisAlarms_one_open_per_mode" ON "CrisisAlarms"("schoolId", "mode") WHERE "endedAt" IS NULL;
-- The protocol list, newest first.
CREATE INDEX "CrisisAlarms_schoolId_startedAt_idx" ON "CrisisAlarms"("schoolId", "startedAt");
-- Gallring's predicate (CRISIS_DRILLS, CRISIS_ALARMS): the ended alarms of a school.
CREATE INDEX "CrisisAlarms_schoolId_mode_endedAt_idx" ON "CrisisAlarms"("schoolId", "mode", "endedAt") WHERE "endedAt" IS NOT NULL;
-- The person keys' SET NULL.
CREATE INDEX "CrisisAlarms_startedByUserId_schoolId_idx" ON "CrisisAlarms"("startedByUserId", "schoolId");
CREATE INDEX "CrisisAlarms_endedByUserId_schoolId_idx" ON "CrisisAlarms"("endedByUserId", "schoolId");

ALTER TABLE "CrisisAlarms"
    ADD CONSTRAINT "CrisisAlarms_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrisisAlarms"
    ADD CONSTRAINT "CrisisAlarms_startedByUserId_schoolId_fkey" FOREIGN KEY ("startedByUserId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE SET NULL ("startedByUserId") ON UPDATE NO ACTION;
ALTER TABLE "CrisisAlarms"
    ADD CONSTRAINT "CrisisAlarms_endedByUserId_schoolId_fkey" FOREIGN KEY ("endedByUserId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE SET NULL ("endedByUserId") ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- CrisisCalls
-- ---------------------------------------------------------------------------

CREATE TABLE "CrisisCalls" (
    "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"         UUID NOT NULL,
    "alarmId"          UUID NOT NULL,
    -- Null once the lesson is gone; the names below stay.
    "calendarLessonId" UUID,
    "basis"            "CrisisCallBasis" NOT NULL,
    "groupName"        TEXT NOT NULL,
    "subjectName"      TEXT NOT NULL,
    "roomName"         TEXT,
    "lessonStartsAt"   TIMESTAMPTZ(6) NOT NULL,
    "lessonEndsAt"     TIMESTAMPTZ(6) NOT NULL,
    -- When the group had a mark for every pupil who was not absent before:
    -- kept by app.crisis_report_applies, the sender's clock.
    "completedAt"      TIMESTAMPTZ(6),

    CONSTRAINT "CrisisCalls_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CrisisCalls_lesson_has_a_span" CHECK ("lessonEndsAt" > "lessonStartsAt"),
    CONSTRAINT "CrisisCalls_names_are_short" CHECK (
        char_length("groupName") BETWEEN 1 AND 200 AND char_length("subjectName") BETWEEN 1 AND 200
        AND ("roomName" IS NULL OR char_length("roomName") BETWEEN 1 AND 200))
);

CREATE UNIQUE INDEX "CrisisCalls_id_schoolId_key" ON "CrisisCalls"("id", "schoolId");
CREATE UNIQUE INDEX "CrisisCalls_id_alarmId_key" ON "CrisisCalls"("id", "alarmId");
-- One call per lesson and alarm (a lesson removed leaves a null, and nulls differ).
CREATE UNIQUE INDEX "CrisisCalls_alarmId_calendarLessonId_key" ON "CrisisCalls"("alarmId", "calendarLessonId");
-- The alarm key's cascade and the alarm's lists.
CREATE INDEX "CrisisCalls_alarmId_schoolId_idx" ON "CrisisCalls"("alarmId", "schoolId");
-- The lesson key's SET NULL.
CREATE INDEX "CrisisCalls_calendarLessonId_schoolId_idx" ON "CrisisCalls"("calendarLessonId", "schoolId");

ALTER TABLE "CrisisCalls"
    ADD CONSTRAINT "CrisisCalls_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrisisCalls"
    ADD CONSTRAINT "CrisisCalls_alarmId_schoolId_fkey" FOREIGN KEY ("alarmId", "schoolId")
    REFERENCES "CrisisAlarms"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "CrisisCalls"
    ADD CONSTRAINT "CrisisCalls_calendarLessonId_schoolId_fkey" FOREIGN KEY ("calendarLessonId", "schoolId")
    REFERENCES "CalendarLessons"("id", "schoolId") ON DELETE SET NULL ("calendarLessonId") ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- CrisisCallTeachers
-- ---------------------------------------------------------------------------

CREATE TABLE "CrisisCallTeachers" (
    "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"   UUID NOT NULL,
    "callId"     UUID NOT NULL,
    -- Null once the person is removed.
    "teacherId"  UUID,
    "role"       "TeacherAssignmentRole" NOT NULL DEFAULT 'LEAD',
    -- Their first mark on the call, by the sender's clock.
    "answeredAt" TIMESTAMPTZ(6),

    CONSTRAINT "CrisisCallTeachers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CrisisCallTeachers_callId_teacherId_key" ON "CrisisCallTeachers"("callId", "teacherId");
-- A teacher's calls; the person key's SET NULL.
CREATE INDEX "CrisisCallTeachers_teacherId_schoolId_idx" ON "CrisisCallTeachers"("teacherId", "schoolId");
-- The call key's cascade.
CREATE INDEX "CrisisCallTeachers_callId_schoolId_idx" ON "CrisisCallTeachers"("callId", "schoolId");

ALTER TABLE "CrisisCallTeachers"
    ADD CONSTRAINT "CrisisCallTeachers_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrisisCallTeachers"
    ADD CONSTRAINT "CrisisCallTeachers_callId_schoolId_fkey" FOREIGN KEY ("callId", "schoolId")
    REFERENCES "CrisisCalls"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "CrisisCallTeachers"
    ADD CONSTRAINT "CrisisCallTeachers_teacherId_schoolId_fkey" FOREIGN KEY ("teacherId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE SET NULL ("teacherId") ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- CrisisPupils
-- ---------------------------------------------------------------------------

CREATE TABLE "CrisisPupils" (
    "id"                UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"          UUID NOT NULL,
    "alarmId"           UUID NOT NULL,
    "callId"            UUID NOT NULL,
    "studentId"         UUID NOT NULL,
    -- Why the list says the pupil was absent before the alarm: the day's
    -- register (ATTENDANCE) or a report or a leave (REPORTED); null = expected.
    "priorAbsentSource" TEXT,
    -- The latest mark by time, kept by app.crisis_report_applies.
    "state"             "CrisisPupilState",
    "stateAt"           TIMESTAMPTZ(6),
    "stateByUserId"     UUID,

    CONSTRAINT "CrisisPupils_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CrisisPupils_prior_source_is_known" CHECK ("priorAbsentSource" IS NULL OR "priorAbsentSource" IN ('ATTENDANCE', 'REPORTED')),
    CONSTRAINT "CrisisPupils_marked_iff_stamped" CHECK (("state" IS NULL) = ("stateAt" IS NULL))
);

-- A pupil is on one list of an alarm.
CREATE UNIQUE INDEX "CrisisPupils_alarmId_studentId_key" ON "CrisisPupils"("alarmId", "studentId");
-- The target of a mark's key.
CREATE UNIQUE INDEX "CrisisPupils_callId_studentId_key" ON "CrisisPupils"("callId", "studentId");
-- The call key's cascade and a call's pupils.
CREATE INDEX "CrisisPupils_callId_schoolId_idx" ON "CrisisPupils"("callId", "schoolId");
-- A pupil's alarms (the person key's cascade).
CREATE INDEX "CrisisPupils_studentId_schoolId_idx" ON "CrisisPupils"("studentId", "schoolId");
CREATE INDEX "CrisisPupils_stateByUserId_schoolId_idx" ON "CrisisPupils"("stateByUserId", "schoolId");

ALTER TABLE "CrisisPupils"
    ADD CONSTRAINT "CrisisPupils_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrisisPupils"
    ADD CONSTRAINT "CrisisPupils_callId_schoolId_fkey" FOREIGN KEY ("callId", "schoolId")
    REFERENCES "CrisisCalls"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;
-- The pupil's alarm is the call's: a pupil cannot sit on one alarm's list under another's.
ALTER TABLE "CrisisPupils"
    ADD CONSTRAINT "CrisisPupils_callId_alarmId_fkey" FOREIGN KEY ("callId", "alarmId")
    REFERENCES "CrisisCalls"("id", "alarmId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "CrisisPupils"
    ADD CONSTRAINT "CrisisPupils_studentId_schoolId_fkey" FOREIGN KEY ("studentId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "CrisisPupils"
    ADD CONSTRAINT "CrisisPupils_stateByUserId_schoolId_fkey" FOREIGN KEY ("stateByUserId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE SET NULL ("stateByUserId") ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- CrisisReports
-- ---------------------------------------------------------------------------

CREATE TABLE "CrisisReports" (
    "id"         UUID NOT NULL,
    "schoolId"   UUID NOT NULL,
    "alarmId"    UUID NOT NULL,
    "callId"     UUID NOT NULL,
    "studentId"  UUID NOT NULL,
    "state"      "CrisisPupilState" NOT NULL,
    -- The sender's time, held in [alarm start, receivedAt] by the trigger.
    "at"         TIMESTAMPTZ(6) NOT NULL,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "byUserId"   UUID,
    "onBehalf"   BOOLEAN NOT NULL DEFAULT false,
    "late"       BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "CrisisReports_pkey" PRIMARY KEY ("id")
);

-- The protocol's timeline.
CREATE INDEX "CrisisReports_alarmId_schoolId_at_idx" ON "CrisisReports"("alarmId", "schoolId", "at");
-- The pupil key's cascade and a pupil's marks.
CREATE INDEX "CrisisReports_callId_studentId_idx" ON "CrisisReports"("callId", "studentId");
-- The person key's SET NULL.
CREATE INDEX "CrisisReports_byUserId_schoolId_idx" ON "CrisisReports"("byUserId", "schoolId");

ALTER TABLE "CrisisReports"
    ADD CONSTRAINT "CrisisReports_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrisisReports"
    ADD CONSTRAINT "CrisisReports_callId_schoolId_fkey" FOREIGN KEY ("callId", "schoolId")
    REFERENCES "CrisisCalls"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "CrisisReports"
    ADD CONSTRAINT "CrisisReports_callId_alarmId_fkey" FOREIGN KEY ("callId", "alarmId")
    REFERENCES "CrisisCalls"("id", "alarmId") ON DELETE CASCADE ON UPDATE NO ACTION;
-- A mark names a pupil who is on the call it is made on.
ALTER TABLE "CrisisReports"
    ADD CONSTRAINT "CrisisReports_callId_studentId_fkey" FOREIGN KEY ("callId", "studentId")
    REFERENCES "CrisisPupils"("callId", "studentId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "CrisisReports"
    ADD CONSTRAINT "CrisisReports_byUserId_schoolId_fkey" FOREIGN KEY ("byUserId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE SET NULL ("byUserId") ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- Who may start an alarm, and when a row of an alarm can be read and written
-- ---------------------------------------------------------------------------

-- The caller is an administrator who writes Drift and either decides (rektor,
-- full: always) or is of a profile the school let start an alarm. A huvudman's
-- reader has no Users row, and a läsare writes no area: neither starts anything.
CREATE FUNCTION app.crisis_may_start() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT coalesce((
    SELECT u."role" = 'SCHOOL_ADMIN'
       AND 'DRIFT' = ANY (app.admin_profile_writes(u."adminProfile"))
       AND (app.admin_profile_decides(u."adminProfile")
            OR u."adminProfile" = ANY (coalesce(
                 (SELECT s."startProfiles" FROM "CrisisSettings" s WHERE s."schoolId" = u."schoolId"),
                 ARRAY['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION']::"AdminProfile"[])))
      FROM "Users" u
     WHERE u."id" = app.current_user_id()
  ), false)
$$;

COMMENT ON FUNCTION app.crisis_may_start() IS
  'Whether the caller may start, end and mark an alarm: an administrator who writes Drift and decides, or whose profile is among CrisisSettings.startProfiles (default: every profile that writes Drift).';

-- An alarm of the caller's school that is open, or ended within the hour: the
-- time in which a teacher reads their list and a phone sends what it holds.
CREATE FUNCTION app.crisis_window_open(p_alarm uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT EXISTS (
    SELECT 1 FROM "CrisisAlarms" a
     WHERE a."id" = p_alarm AND a."schoolId" = app.current_school_id()
       AND (a."endedAt" IS NULL OR a."endedAt" > now() - interval '60 minutes'))
$$;

COMMENT ON FUNCTION app.crisis_window_open(uuid) IS
  'Whether alarm p_alarm of the caller''s school is open or ended within the last 60 minutes.';

CREATE FUNCTION app.crisis_call_window_open(p_call uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT EXISTS (
    SELECT 1 FROM "CrisisCalls" c
      JOIN "CrisisAlarms" a ON a."id" = c."alarmId" AND a."schoolId" = c."schoolId"
     WHERE c."id" = p_call AND c."schoolId" = app.current_school_id()
       AND (a."endedAt" IS NULL OR a."endedAt" > now() - interval '60 minutes'))
$$;

COMMENT ON FUNCTION app.crisis_call_window_open(uuid) IS
  'The same for the alarm of call p_call.';

-- The lists of alarm p_alarm of the caller's school can still be written: it is
-- open and not yet sealed. The transaction that starts an alarm is the only one
-- that ever sees it in that state.
CREATE FUNCTION app.crisis_lists_are_open(p_alarm uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT EXISTS (
    SELECT 1 FROM "CrisisAlarms" a
     WHERE a."id" = p_alarm AND a."schoolId" = app.current_school_id()
       AND a."endedAt" IS NULL AND a."listsSealedAt" IS NULL)
$$;

COMMENT ON FUNCTION app.crisis_lists_are_open(uuid) IS
  'Whether alarm p_alarm of the caller''s school is open and its lists not yet sealed: the state of an alarm in the transaction that starts it, and in no other.';

-- The caller answers for call p_call.
CREATE FUNCTION app.crisis_answers_for(p_call uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT EXISTS (
    SELECT 1 FROM "CrisisCallTeachers" t
     WHERE t."callId" = p_call AND t."schoolId" = app.current_school_id()
       AND t."teacherId" = app.current_user_id())
$$;

COMMENT ON FUNCTION app.crisis_answers_for(uuid) IS
  'Whether the caller is one of the teachers of call p_call.';

-- ---------------------------------------------------------------------------
-- An alarm begins in the name of its starter, ends once, and says so itself
-- ---------------------------------------------------------------------------

-- A writer with a login starts an alarm at the transaction's time, in its own
-- name, with nothing of its end filled in. A writer with no login (the owner,
-- a fixture) states what it likes.
CREATE FUNCTION app.crisis_alarm_is_born_open_and_started_by_its_writer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF app.current_user_id() IS NOT NULL THEN
    NEW."startedAt" := now();
    NEW."startedByUserId" := app.current_user_id();
    NEW."endedAt" := NULL;
    NEW."endedByUserId" := NULL;
    NEW."autoEnded" := false;
    NEW."endNote" := NULL;
    NEW."guardiansNotifiedAt" := NULL;
    NEW."listsSealedAt" := NULL;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.crisis_alarm_is_born_open_and_started_by_its_writer() FROM PUBLIC;

CREATE TRIGGER "CrisisAlarms_a_born_open" BEFORE INSERT ON "CrisisAlarms"
    FOR EACH ROW EXECUTE FUNCTION app.crisis_alarm_is_born_open_and_started_by_its_writer();

-- An alarm changes in three ways: its lists are sealed (once, by the
-- transaction that wrote them), it ends (once, with an optional note), and once
-- it has ended with the guardians told, the time they were. Everything else
-- on it is fixed. KL404 not found is the gateway's; the words here are
-- the database's own:
--   KL409  the alarm has ended already
--   KL422  something that is fixed was changed
CREATE FUNCTION app.crisis_alarm_ends_once() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."schoolId" IS DISTINCT FROM OLD."schoolId"
     OR NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."mode" IS DISTINCT FROM OLD."mode"
     OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt"
     OR NEW."startedByUserId" IS DISTINCT FROM OLD."startedByUserId" THEN
    -- SET NULL of the starter's key is the one change of these the database makes itself.
    IF NOT (NEW."startedByUserId" IS NULL AND OLD."startedByUserId" IS NOT NULL
            AND NEW."id" = OLD."id" AND NEW."schoolId" = OLD."schoolId"
            AND NEW."kind" = OLD."kind" AND NEW."mode" = OLD."mode" AND NEW."startedAt" = OLD."startedAt") THEN
      RAISE EXCEPTION 'CRISIS_ALARM_IS_FIXED: ett larms art, läge och start kan inte ändras'
        USING ERRCODE = 'KL422';
    END IF;
  END IF;

  IF OLD."listsSealedAt" IS NOT NULL AND NEW."listsSealedAt" IS DISTINCT FROM OLD."listsSealedAt" THEN
    RAISE EXCEPTION 'CRISIS_ALARM_IS_SEALED: listorna är slutgiltiga'
      USING ERRCODE = 'KL422';
  END IF;
  IF OLD."listsSealedAt" IS NULL AND NEW."listsSealedAt" IS NOT NULL AND app.current_user_id() IS NOT NULL THEN
    NEW."listsSealedAt" := clock_timestamp();
  END IF;

  IF OLD."endedAt" IS NOT NULL THEN
    -- Over: only the time the guardians were told may be added, and the
    -- person keys' SET NULL.
    IF NEW."endedAt" IS DISTINCT FROM OLD."endedAt" OR NEW."autoEnded" IS DISTINCT FROM OLD."autoEnded"
       OR NEW."endNote" IS DISTINCT FROM OLD."endNote"
       OR (NEW."endedByUserId" IS DISTINCT FROM OLD."endedByUserId" AND NEW."endedByUserId" IS NOT NULL)
       OR (OLD."guardiansNotifiedAt" IS NOT NULL AND NEW."guardiansNotifiedAt" IS DISTINCT FROM OLD."guardiansNotifiedAt") THEN
      RAISE EXCEPTION 'CRISIS_ALARM_ENDED: larmet är avslutat'
        USING ERRCODE = 'KL409';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."endedAt" IS NOT NULL THEN
    -- Ending. A writer with a login ends it now, in its own name, and not as the job.
    IF app.current_user_id() IS NOT NULL THEN
      NEW."endedAt" := clock_timestamp();
      NEW."endedByUserId" := app.current_user_id();
      NEW."autoEnded" := false;
    END IF;
  ELSIF NEW."endedByUserId" IS NOT NULL OR NEW."autoEnded" OR NEW."endNote" IS NOT NULL OR NEW."guardiansNotifiedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'CRISIS_ALARM_IS_OPEN: ett larm som pågår har inget slut att beskriva'
      USING ERRCODE = 'KL422';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.crisis_alarm_ends_once() FROM PUBLIC;

CREATE TRIGGER "CrisisAlarms_b_ends_once" BEFORE UPDATE ON "CrisisAlarms"
    FOR EACH ROW EXECUTE FUNCTION app.crisis_alarm_ends_once();

-- ---------------------------------------------------------------------------
-- A mark: stamped by the database, then applied to the lists
-- ---------------------------------------------------------------------------

-- The writer's login decides who marked, and whether they are one of the
-- call's teachers; the alarm decides whether the mark is late; the sender's
-- clock is held between the alarm's start and now. KL404 the call is not a
-- call of this alarm in this school, KL410 the hour after the end has passed.
CREATE FUNCTION app.crisis_report_is_stamped() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  al "CrisisAlarms";
BEGIN
  SELECT a.* INTO al FROM "CrisisAlarms" a
   WHERE a."id" = NEW."alarmId" AND a."schoolId" = NEW."schoolId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CRISIS_ALARM_NOT_FOUND' USING ERRCODE = 'KL404';
  END IF;
  IF al."endedAt" IS NOT NULL AND al."endedAt" <= clock_timestamp() - interval '60 minutes' THEN
    RAISE EXCEPTION 'CRISIS_ALARM_CLOSED: larmet avslutades för mer än en timme sedan'
      USING ERRCODE = 'KL410';
  END IF;
  NEW."receivedAt" := clock_timestamp();
  NEW."late" := al."endedAt" IS NOT NULL;
  IF app.current_user_id() IS NOT NULL THEN
    NEW."byUserId" := app.current_user_id();
    NEW."onBehalf" := NOT EXISTS (
      SELECT 1 FROM "CrisisCallTeachers" t
       WHERE t."callId" = NEW."callId" AND t."teacherId" = app.current_user_id());
  END IF;
  NEW."at" := least(greatest(NEW."at", al."startedAt"), NEW."receivedAt");
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.crisis_report_is_stamped() FROM PUBLIC;

CREATE TRIGGER "CrisisReports_a_stamped" BEFORE INSERT ON "CrisisReports"
    FOR EACH ROW EXECUTE FUNCTION app.crisis_report_is_stamped();

-- The lists follow the marks. The pupil's mark is the latest by time (a tie
-- goes to the one that arrived last), the teacher's answer is their first mark,
-- and the call is complete at the latest mark of the pupils who were not
-- absent before once each of them has one.
CREATE FUNCTION app.crisis_report_applies() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  UPDATE "CrisisPupils" p
     SET "state" = NEW."state", "stateAt" = NEW."at", "stateByUserId" = NEW."byUserId"
   WHERE p."callId" = NEW."callId" AND p."studentId" = NEW."studentId"
     AND (p."stateAt" IS NULL OR NEW."at" >= p."stateAt");

  IF NEW."byUserId" IS NOT NULL THEN
    UPDATE "CrisisCallTeachers" t
       SET "answeredAt" = NEW."at"
     WHERE t."callId" = NEW."callId" AND t."teacherId" = NEW."byUserId" AND t."answeredAt" IS NULL;
  END IF;

  UPDATE "CrisisCalls" c
     SET "completedAt" = (
           SELECT CASE WHEN bool_and(p."state" IS NOT NULL) THEN max(p."stateAt") END
             FROM "CrisisPupils" p
            WHERE p."callId" = c."id" AND p."priorAbsentSource" IS NULL)
   WHERE c."id" = NEW."callId";
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.crisis_report_applies() FROM PUBLIC;

CREATE TRIGGER "CrisisReports_b_applies" AFTER INSERT ON "CrisisReports"
    FOR EACH ROW EXECUTE FUNCTION app.crisis_report_applies();

-- ---------------------------------------------------------------------------
-- The job: an alarm left open
-- ---------------------------------------------------------------------------

-- Ends the alarms that have stood open longer than one can: a real alarm
-- after 12 hours, an exercise after 3. Called by the job runner with no login
-- (KL403 to anybody with one). Answers how many it ended. Nobody is told: the
-- app reads the alarm again when it is opened, and the protocol says
-- autoEnded.
CREATE FUNCTION app.crisis_settle() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  n integer;
BEGIN
  IF app.current_user_id() IS NOT NULL THEN
    RAISE EXCEPTION 'CRISIS_SETTLE_IS_THE_JOBS' USING ERRCODE = 'KL403';
  END IF;
  UPDATE "CrisisAlarms" a
     SET "endedAt" = clock_timestamp(), "autoEnded" = true
   WHERE a."endedAt" IS NULL
     AND a."startedAt" < clock_timestamp() - CASE a."mode" WHEN 'LIVE' THEN interval '12 hours' ELSE interval '3 hours' END;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

COMMENT ON FUNCTION app.crisis_settle() IS
  'Ends the open alarms older than 12 hours (a real one) or 3 hours (an exercise), marked autoEnded; answers how many. Refused (KL403) to anybody with a login.';

-- ---------------------------------------------------------------------------
-- Row-level security and grants. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "CrisisSettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CrisisAlarms" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CrisisCalls" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CrisisCallTeachers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CrisisPupils" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CrisisReports" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r text;
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    -- CrisisSettings
    CREATE POLICY "crisis_settings_admin_select" ON "CrisisSettings"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "crisis_settings_admin_insert" ON "CrisisSettings"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_decides()));
    CREATE POLICY "crisis_settings_admin_update" ON "CrisisSettings"
        FOR UPDATE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_decides()));

    -- CrisisAlarms
    CREATE POLICY "crisis_alarms_admin_select" ON "CrisisAlarms"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "crisis_alarms_teacher_select" ON "CrisisAlarms"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'TEACHER'
               AND app.crisis_window_open("id"));
    CREATE POLICY "crisis_alarms_admin_insert" ON "CrisisAlarms"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true))
                    AND (select app.crisis_may_start()));
    CREATE POLICY "crisis_alarms_admin_update" ON "CrisisAlarms"
        FOR UPDATE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true))
                    AND (select app.crisis_may_start()));

    -- CrisisCalls
    CREATE POLICY "crisis_calls_admin_select" ON "CrisisCalls"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "crisis_calls_teacher_select" ON "CrisisCalls"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'TEACHER'
               AND app.crisis_answers_for("id")
               AND app.crisis_call_window_open("id"));
    CREATE POLICY "crisis_calls_admin_insert" ON "CrisisCalls"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true))
                    AND (select app.crisis_may_start())
                    AND app.crisis_lists_are_open("alarmId"));

    -- CrisisCallTeachers
    CREATE POLICY "crisis_call_teachers_admin_select" ON "CrisisCallTeachers"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "crisis_call_teachers_teacher_select" ON "CrisisCallTeachers"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'TEACHER'
               AND app.crisis_answers_for("callId")
               AND app.crisis_call_window_open("callId"));
    CREATE POLICY "crisis_call_teachers_admin_insert" ON "CrisisCallTeachers"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true))
                    AND (select app.crisis_may_start())
                    AND EXISTS (SELECT 1 FROM "CrisisCalls" c WHERE c."id" = "callId" AND c."schoolId" = "schoolId"
                                 AND app.crisis_lists_are_open(c."alarmId")));

    -- CrisisPupils
    CREATE POLICY "crisis_pupils_admin_select" ON "CrisisPupils"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "crisis_pupils_teacher_select" ON "CrisisPupils"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'TEACHER'
               AND app.crisis_answers_for("callId")
               AND app.crisis_call_window_open("callId"));
    CREATE POLICY "crisis_pupils_admin_insert" ON "CrisisPupils"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true))
                    AND (select app.crisis_may_start())
                    AND app.crisis_lists_are_open("alarmId"));

    -- CrisisReports
    CREATE POLICY "crisis_reports_admin_select" ON "CrisisReports"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "crisis_reports_teacher_select" ON "CrisisReports"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'TEACHER'
               AND app.crisis_answers_for("callId")
               AND app.crisis_call_window_open("callId"));
    CREATE POLICY "crisis_reports_admin_insert" ON "CrisisReports"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true))
                    AND (select app.crisis_may_start())
                    AND app.crisis_call_window_open("callId"));
    CREATE POLICY "crisis_reports_teacher_insert" ON "CrisisReports"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'TEACHER'
                    AND app.crisis_answers_for("callId")
                    AND app.crisis_call_window_open("callId"));

    -- Settings and alarms are changed by an arm; the snapshot and the marks are
    -- appended, and the lists that follow them are kept by the triggers (owner):
    -- the API's role holds no UPDATE on them.
    FOREACH t IN ARRAY ARRAY['CrisisSettings', 'CrisisAlarms'] LOOP
      EXECUTE format('REVOKE ALL ON %I FROM app_authenticated', t);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO app_authenticated', t);
    END LOOP;
    FOREACH t IN ARRAY ARRAY['CrisisCalls', 'CrisisCallTeachers', 'CrisisPupils', 'CrisisReports'] LOOP
      EXECUTE format('REVOKE ALL ON %I FROM app_authenticated', t);
      EXECUTE format('GRANT SELECT, INSERT ON %I TO app_authenticated', t);
    END LOOP;

    GRANT EXECUTE ON FUNCTION app.crisis_may_start() TO "app_authenticated";
    GRANT EXECUTE ON FUNCTION app.crisis_window_open(uuid) TO "app_authenticated";
    GRANT EXECUTE ON FUNCTION app.crisis_call_window_open(uuid) TO "app_authenticated";
    GRANT EXECUTE ON FUNCTION app.crisis_lists_are_open(uuid) TO "app_authenticated";
    GRANT EXECUTE ON FUNCTION app.crisis_answers_for(uuid) TO "app_authenticated";
    GRANT EXECUTE ON FUNCTION app.crisis_settle() TO "app_authenticated";
  END IF;

  FOREACH t IN ARRAY ARRAY['CrisisSettings', 'CrisisAlarms', 'CrisisCalls', 'CrisisCallTeachers', 'CrisisPupils', 'CrisisReports'] LOOP
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

  -- The functions answer the API's role alone.
  FOREACH t IN ARRAY ARRAY['app.crisis_may_start()', 'app.crisis_window_open(uuid)', 'app.crisis_call_window_open(uuid)',
                           'app.crisis_lists_are_open(uuid)', 'app.crisis_answers_for(uuid)', 'app.crisis_settle()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- CRISIS_REACH: the arms above and no other; none for a PostgREST role, the
-- service or the sync principal. Each expression an arm has (USING, WITH
-- CHECK) names the caller's school and the arm's role, has no OR and no NOT,
-- and a teacher's arm anchors the call to the caller (app.crisis_answers_for),
-- or its own row, or the alarm's window; a name and a command alone would let
-- `USING (true)` through.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  bad text;
  tables text[] := ARRAY['CrisisSettings', 'CrisisAlarms', 'CrisisCalls', 'CrisisCallTeachers', 'CrisisPupils', 'CrisisReports'];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    RETURN;
  END IF;
  SELECT string_agg(p.tablename || '.' || p.policyname || ' ' || p.cmd || ' ' || p.roles::text, ', ' ORDER BY p.tablename, p.policyname) INTO bad
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = ANY (tables)
     AND NOT coalesce(
           p.roles = '{app_authenticated}'::name[]
           AND p.permissive = 'PERMISSIVE'
           AND (p.tablename, p.policyname, p.cmd) IN (
                 ('CrisisSettings', 'crisis_settings_admin_select', 'SELECT'),
                 ('CrisisSettings', 'crisis_settings_admin_insert', 'INSERT'),
                 ('CrisisSettings', 'crisis_settings_admin_update', 'UPDATE'),
                 ('CrisisAlarms', 'crisis_alarms_admin_select', 'SELECT'),
                 ('CrisisAlarms', 'crisis_alarms_teacher_select', 'SELECT'),
                 ('CrisisAlarms', 'crisis_alarms_admin_insert', 'INSERT'),
                 ('CrisisAlarms', 'crisis_alarms_admin_update', 'UPDATE'),
                 ('CrisisCalls', 'crisis_calls_admin_select', 'SELECT'),
                 ('CrisisCalls', 'crisis_calls_teacher_select', 'SELECT'),
                 ('CrisisCalls', 'crisis_calls_admin_insert', 'INSERT'),
                 ('CrisisCallTeachers', 'crisis_call_teachers_admin_select', 'SELECT'),
                 ('CrisisCallTeachers', 'crisis_call_teachers_teacher_select', 'SELECT'),
                 ('CrisisCallTeachers', 'crisis_call_teachers_admin_insert', 'INSERT'),
                 ('CrisisPupils', 'crisis_pupils_admin_select', 'SELECT'),
                 ('CrisisPupils', 'crisis_pupils_teacher_select', 'SELECT'),
                 ('CrisisPupils', 'crisis_pupils_admin_insert', 'INSERT'),
                 ('CrisisReports', 'crisis_reports_admin_select', 'SELECT'),
                 ('CrisisReports', 'crisis_reports_teacher_select', 'SELECT'),
                 ('CrisisReports', 'crisis_reports_admin_insert', 'INSERT'),
                 ('CrisisReports', 'crisis_reports_teacher_insert', 'INSERT'))
           AND (SELECT bool_and(
                         e LIKE '%current_school_id()%'
                         AND e NOT LIKE '% OR %'
                         AND e NOT LIKE '%NOT %'
                         AND e LIKE CASE WHEN p.policyname LIKE '%\_admin\_%' ESCAPE '\'
                                         THEN '%current_user_role()%= ''SCHOOL_ADMIN''::"UserRole"%'
                                         ELSE '%current_user_role()%= ''TEACHER''::"UserRole"%' END
                         AND e LIKE CASE
                                      WHEN p.policyname = 'crisis_alarms_teacher_select' THEN '%crisis_window_open(%'
                                      WHEN p.policyname LIKE '%\_teacher\_%' ESCAPE '\' THEN '%crisis_answers_for(%crisis_call_window_open(%'
                                      ELSE '%' END)
                  FROM unnest(ARRAY[p.qual, p.with_check]) e
                 WHERE e IS NOT NULL)
           -- Every administrator write is behind Drift's write and the start rule
           -- (settings: those who decide), and the snapshot behind the alarm's
           -- own transaction.
           AND (p.cmd = 'SELECT' OR p.policyname NOT LIKE '%\_admin\_%' ESCAPE '\'
                OR (p.tablename = 'CrisisSettings' AND coalesce(p.with_check, p.qual) LIKE '%current_user_decides()%')
                OR (p.tablename <> 'CrisisSettings'
                    AND coalesce(p.with_check, p.qual) LIKE '%current_user_may(''DRIFT''%'
                    AND coalesce(p.with_check, p.qual) LIKE '%crisis_may_start()%'
                    AND (p.tablename IN ('CrisisAlarms', 'CrisisReports')
                         OR coalesce(p.with_check, p.qual) LIKE '%crisis_lists_are_open(%'))),
         false);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'CRISIS_REACH: these arms reach the krisläge beyond the administration''s, the teacher''s own group and the start rule''s writes: %', bad;
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY (tables)) <> 20 THEN
    RAISE EXCEPTION 'CRISIS_REACH: the six tables have % arms, not the twenty above',
      (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY (tables));
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Gallring: CRISIS_DRILLS and CRISIS_ALARMS (20270109090000). Both bodies are
-- 20270107090000's (Skyddad identitet's, which carry Frånvarobevakning's
-- findings under ATTENDANCE, the vikarieförfrågningar under COVER_REQUESTS and
-- the marks' history under CHANGE_LOGS) plus the one branch marked "krisläge",
-- so none of them is lost; a later release that restates the functions again
-- must carry every branch. An alarm goes once it has ended and its end is
-- before the cutoff (the school's local midnight), with everything that hangs
-- on it (the calls, the teachers, the pupils and the marks go with it by their
-- keys). An exercise is CRISIS_DRILLS and a real alarm CRISIS_ALARMS. An alarm
-- that is still open is never due: the job ends it first.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.gallring_due(p_school uuid, p_type "RetentionDataType", p_before date, p_today date)
RETURNS TABLE (tbl text, id uuid)
LANGUAGE sql STABLE AS $$
  WITH school AS (
    SELECT s."id", (p_before::timestamp AT TIME ZONE s."timezone") AS before_at
      FROM "public"."Schools" s WHERE s."id" = p_school AND p_before IS NOT NULL
  )
  SELECT 'AttendanceRecords', a."id"
    FROM school, "public"."AttendanceRecords" a
    JOIN "public"."CalendarLessons" l ON l."id" = a."calendarLessonId"
   WHERE p_type = 'ATTENDANCE' AND a."schoolId" = school."id" AND l."date" < p_before
  UNION ALL
  -- frånvarobevakning
  SELECT 'AbsenceWatchFindings', w."id"
    FROM school, "public"."AbsenceWatchFindings" w
   WHERE p_type = 'ATTENDANCE' AND w."schoolId" = school."id" AND w."lastSeenOn" < p_before
  UNION ALL
  SELECT 'AbsenceReports', r."id"
    FROM school, "public"."AbsenceReports" r
   WHERE p_type = 'ABSENCE_REPORTS' AND r."schoolId" = school."id" AND r."date" < p_before
  UNION ALL
  SELECT 'LeaveRequests', r."id"
    FROM school, "public"."LeaveRequests" r
   WHERE p_type = 'LEAVE_REQUESTS' AND r."schoolId" = school."id" AND r."endDate" < p_before
  UNION ALL
  SELECT 'Notifications', n."id"
    FROM school, "public"."Notifications" n
   WHERE p_type = 'NOTIFICATIONS' AND n."schoolId" = school."id" AND n."createdAt" < school.before_at
  UNION ALL
  SELECT 'ScheduleChangeLogs', c."id"
    FROM school, "public"."ScheduleChangeLogs" c
   WHERE p_type = 'CHANGE_LOGS' AND c."schoolId" = school."id" AND c."createdAt" < school.before_at
  UNION ALL
  SELECT 'TeacherEmploymentLogs', g."id"
    FROM school, "public"."TeacherEmploymentLogs" g
    JOIN "public"."AcademicYears" y ON y."id" = g."academicYearId" AND y."schoolId" = g."schoolId"
   WHERE p_type = 'CHANGE_LOGS' AND g."schoolId" = school."id" AND y."endDate" < p_before
  UNION ALL
  SELECT 'GuardianStudentHistory', h."id"
    FROM school, "public"."GuardianStudentHistory" h
   WHERE p_type = 'CHANGE_LOGS' AND h."schoolId" = school."id" AND h."unlinkedAt" < school.before_at
  UNION ALL
  -- skyddad identitet
  SELECT 'PersonProtectionEvents', e."id"
    FROM school, "public"."PersonProtectionEvents" e
   WHERE p_type = 'CHANGE_LOGS' AND e."schoolId" = school."id" AND e."at" < school.before_at
  UNION ALL
  SELECT 'TeacherAbsences', t."id"
    FROM school, "public"."TeacherAbsences" t
   WHERE p_type = 'ABSENCE_REASONS' AND t."schoolId" = school."id" AND t."reasonId" IS NOT NULL
     AND t."endsAt" < school.before_at
  UNION ALL
  -- läslogg
  SELECT 'PersonalDataAccess', p."id"
    FROM school, "public"."PersonalDataAccess" p
   WHERE p_type = 'ACCESS_LOG' AND p."schoolId" = school."id" AND p."at" < school.before_at
  UNION ALL
  -- vikarieförfrågningar
  SELECT 'CoverRequests', q."id"
    FROM school, "public"."CoverRequests" q
   WHERE p_type = 'COVER_REQUESTS' AND q."schoolId" = school."id"
     AND ((q."status" <> 'OPEN' AND q."closedAt" < school.before_at)
          OR (q."status" = 'OPEN' AND q."expiresAt" < school.before_at))
  UNION ALL
  SELECT 'CoverConfirmations', c."id"
    FROM school, "public"."CoverConfirmations" c
   WHERE p_type = 'COVER_REQUESTS' AND c."schoolId" = school."id" AND c."confirmedAt" < school.before_at
  UNION ALL
  -- krisläge
  SELECT 'CrisisAlarms', k."id"
    FROM school, "public"."CrisisAlarms" k
   WHERE k."schoolId" = school."id" AND k."endedAt" < school.before_at
     AND ((p_type = 'CRISIS_DRILLS' AND k."mode" = 'DRILL')
          OR (p_type = 'CRISIS_ALARMS' AND k."mode" = 'LIVE'))
  UNION ALL
  SELECT 'Users', u."id"
    FROM school, "public"."Users" u
   WHERE p_type = 'DEPARTED_PEOPLE' AND u."schoolId" = school."id"
     AND NOT u."isActive" AND u."pseudonymisedAt" IS NULL
     AND u."deactivatedAt" < school.before_at
     AND NOT app.gallring_held_for_scb(u."id", u."schoolId", p_today);
$$;

CREATE OR REPLACE FUNCTION app.gallring_purge(p_run uuid, p_type "RetentionDataType", p_limit integer) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  r "GallringRuns";
  cutoff date;
  today date;
  budget integer := greatest(least(p_limit, 5000), 1);
  n integer := 0;
  step integer;
BEGIN
  IF p_type = 'DEPARTED_PEOPLE' THEN
    RAISE EXCEPTION 'GALLRING_PEOPLE_ARE_PSEUDONYMISED' USING ERRCODE = 'GL400';
  END IF;
  -- FOR UPDATE: one call of a run at a time.
  SELECT * INTO r FROM "GallringRuns" WHERE "id" = p_run AND "status" = 'RUNNING' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GALLRING_RUN_NOT_RUNNING' USING ERRCODE = 'GL404';
  END IF;
  -- Both NULL when nothing of the kind may go: least() of a NULL is the other.
  IF r."cutoffs" ->> p_type::text IS NULL
     OR app.retention_months_in_force(r."schoolId", p_type, clock_timestamp()) IS NULL THEN
    RETURN 0;
  END IF;
  cutoff := app.gallring_run_cutoff(r."schoolId", r."startedAt", r."cutoffs", p_type);
  today := app.gallring_today(r."schoolId", r."startedAt");

  PERFORM set_config('app.gallring', r."schoolId"::text, true);
  CASE p_type
    WHEN 'ATTENDANCE' THEN
      DELETE FROM "AttendanceRecords" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'AttendanceRecords' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
      -- frånvarobevakning
      IF n < budget THEN
        DELETE FROM "AbsenceWatchFindings" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'AbsenceWatchFindings' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
    WHEN 'ABSENCE_REPORTS' THEN
      DELETE FROM "AbsenceReports" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'AbsenceReports' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
    WHEN 'LEAVE_REQUESTS' THEN
      DELETE FROM "LeaveRequests" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'LeaveRequests' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
    WHEN 'NOTIFICATIONS' THEN
      DELETE FROM "Notifications" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'Notifications' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
    WHEN 'CHANGE_LOGS' THEN
      DELETE FROM "ScheduleChangeLogs" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'ScheduleChangeLogs' LIMIT budget);
      GET DIAGNOSTICS step = ROW_COUNT;
      n := step;
      IF n < budget THEN
        DELETE FROM "TeacherEmploymentLogs" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'TeacherEmploymentLogs' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
      IF n < budget THEN
        DELETE FROM "GuardianStudentHistory" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'GuardianStudentHistory' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
      -- skyddad identitet
      IF n < budget THEN
        DELETE FROM "PersonProtectionEvents" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'PersonProtectionEvents' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
    WHEN 'ABSENCE_REASONS' THEN
      UPDATE "TeacherAbsences" SET "reasonId" = NULL WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'TeacherAbsences' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
    -- läslogg
    WHEN 'ACCESS_LOG' THEN
      DELETE FROM "PersonalDataAccess" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'PersonalDataAccess' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
    -- vikarieförfrågningar
    WHEN 'COVER_REQUESTS' THEN
      DELETE FROM "CoverRequests" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'CoverRequests' LIMIT budget);
      GET DIAGNOSTICS step = ROW_COUNT;
      n := step;
      IF n < budget THEN
        DELETE FROM "CoverConfirmations" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'CoverConfirmations' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
    -- krisläge
    WHEN 'CRISIS_DRILLS', 'CRISIS_ALARMS' THEN
      DELETE FROM "CrisisAlarms" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'CrisisAlarms' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
  END CASE;
  PERFORM set_config('app.gallring', '', true);

  UPDATE "GallringRuns" SET
    "counts"   = "counts" || jsonb_build_object(p_type::text, COALESCE(("counts" ->> p_type::text)::bigint, 0) + n),
    "complete" = "complete" || jsonb_build_object(p_type::text, n < budget),
    "cutoffs"  = "cutoffs" || jsonb_build_object(p_type::text, cutoff::text)
   WHERE "id" = p_run;
  RETURN n;
END
$$;
