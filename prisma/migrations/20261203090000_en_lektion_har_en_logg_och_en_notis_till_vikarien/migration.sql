-- En lektion har en logg, och en notis till vikarien.
--
-- Lektionslogg (Skoldagen): a teacher who wants to may write what a lesson is
-- about and what is to be done before the next one, and the pupils on it and
-- their guardians see it beside the lesson; the school prints a klassbok of
-- a class over a period from the same rows; and the lesson's own teacher
-- may leave a note for whoever covers it. Messages between school and home
-- stay in the school's lärplattform: nobody answers a log or a note here,
-- nobody is told one was written, and nothing records who read it.
--
-- ## Two tables, because two audiences
--
-- "LessonLogs" is what families see: the topic (ämne, moment) and the
-- homework (läxa) of one calendar lesson. "LessonSubstituteNotes" is what the
-- substitute sees: "Planeringen ligger i lärplattformen, Kalle och Lisa går
-- ut 10.15 till specialpedagogen". A note may name pupils and may say why;
-- it is staff's, and families never read it. Kept in one table, the two
-- would have to be told apart by the gateway alone, since a guardian's
-- session and a teacher's are the same database role (app_authenticated)
-- and a column grant cannot tell them apart. Two tables let row security say
-- it: no arm on LessonSubstituteNotes reaches a STUDENT or a GUARDIAN.
--
-- Both are keyed by the calendar lesson, one row per lesson at most
-- (UNIQUE "calendarLessonId"), and go with it: ("calendarLessonId",
-- "schoolId") -> CalendarLessons ("id", "schoolId") ON DELETE CASCADE, ON
-- UPDATE NO ACTION. A lesson the calendar removes takes its log with it, as
-- it takes a substitute assignment or a note: a publish names it among the
-- day operations it loses (PUB_DAY_OPS_LOST); the other writers that remove a
-- coming, unrecorded lesson (a lov added, a template edited or deleted in a
-- school that publishes directly, a regeneration, an avbokning undone) say
-- nothing more than they say of its substitute, which the manual states. Composite, for the reason
-- every tenant reference is (20260822130000): the referential check runs as
-- the referenced table's owner with row security off, so a plain id key
-- would accept another school's lesson under a row stamped with this
-- school's id.
--
--   "topic"     TEXT NULL: one line, trimmed, 1..200 characters.
--   "homework"  TEXT NULL: may run over lines, trimmed, 1..1000 characters.
--   A log says something: topic or homework (LessonLogs_says_something).
--   A log that says nothing is deleted, never kept empty.
--   "body"      TEXT NOT NULL on a note: trimmed, 1..2000 characters.
--   "writtenById" UUID NULL on both: who wrote it last, ("writtenById",
--   "schoolId") -> Users ("id", "schoolId") ON DELETE SET NULL
--   ("writtenById"). A BEFORE INSERT OR UPDATE trigger writes it from the
--   claims (app.lesson_text_written_by), so the row says who wrote it
--   whatever the writer sends. A trigger and not a WITH CHECK: a check would
--   refuse a teacher's update of a co-teacher's log unless the gateway
--   remembered to send itself, and it would refuse the RLS matrix's copy of
--   a row (section 116), which is how every administrator's write to every
--   table is proved. Only a write with no user at all — the owner's, which
--   row security does not reach — keeps what it sends.
--
-- "Trimmed" is btrim over space, tab, CR and LF: the gateway trims, and the
-- CHECK refuses what it did not. Lengths are in characters.
--
-- ## Who teaches a lesson: app.lesson_teacher_role(lesson)
--
-- 'REGULAR', 'SUBSTITUTE' or NULL, for the calling TEACHER and a lesson of
-- their school. REGULAR is the lesson's own teacher: a CalendarLessonTeachers
-- row other than SUBSTITUTE, or the absent teacher a cover decision on it was
-- made for (TeacherAbsenceCovers). The second is what keeps the teacher who
-- is away the author of the lesson they handed over: booking a substitute
-- removes the absent teacher's CalendarLessonTeachers row, and the note to
-- the substitute is the absent teacher's to write and correct. SUBSTITUTE is
-- a teacher on the lesson only as its SUBSTITUTE.
--
-- Not the master lesson's teacher. In a school that publishes through a
-- draft, MasterLessons IS the draft (20261011100000): a teacher put on a
-- master and not yet published would become the own teacher of every dated
-- lesson of it, read its notes and rewrite what families read, before
-- anyone was told. And in a school that publishes directly, a teacher who
-- takes over a master mid-year would become the author of the lessons before
-- the change, which the calendar still gives the teacher who held them. The
-- dated lesson's own rows are the published truth of who teaches it; a
-- substitute booked with no absence registered takes the teacher's place
-- there, and with it the note. SECURITY DEFINER: a teacher
-- does not read TeacherAbsenceCovers of another teacher's absence (RLS
-- section 128 holds that), and the function answers only a yes for the
-- caller, never whose absence it was. STABLE, search_path pinned; EXECUTE to
-- app_authenticated alone. The gateway asks the same function before it
-- writes, so its 403 and the database's refusal are one rule.
--
-- ## Who reads and who writes
--
-- Through the gateway only (the API role, app_authenticated): nothing for
-- authenticated or anon, and service_role keeps its SELECT and nothing more,
-- as on every table (20261016130000).
--
--   lesson_logs_staff_select
--       the school's SCHOOL_ADMIN and TEACHER: the klassbok is every
--       teacher's and administrator's, and a log is written for the class to
--       read; colleagues reading each other's homework is how a week's load
--       is kept even.
--   lesson_logs_family_select
--       the school's STUDENT and GUARDIAN, for a lesson they can read
--       (EXISTS on CalendarLessons, under the caller's own row security):
--       the pupil's own lessons and a guardian's children's, by exactly the
--       arms that decide which lessons they see. One definition: a phase
--       that changes who attends a lesson changes those arms, and the log
--       follows. The gateway narrows it further by the one roster reader
--       (src/calendar/lesson-roster.ts) and the family's week.
--   lesson_logs_teacher_insert / _update / _delete
--       a TEACHER for whom app.lesson_teacher_role is not NULL: the lesson's
--       own teacher and its substitute, who taught it and says what was done.
--   lesson_substitute_notes_teacher_select
--       the same teachers: the substitute reads the note, the lesson's own
--       teacher reads what they wrote.
--   lesson_substitute_notes_teacher_insert / _update / _delete
--       REGULAR only. The substitute reads the note and does not answer it:
--       an answer is a message, and messages stay in the lärplattform.
--   lesson_logs_admin_insert / _update / _delete
--       the school's SCHOOL_ADMIN who writes DRIFT
--       (app.current_user_may('DRIFT', true)), as CalendarLessons: rektor
--       removes a log that should not stand. The update arm asks it in WITH
--       CHECK only, so a row lock for a read keeps working for every
--       administrator (RLS section 106 c). TABLE_WRITE_GATES in
--       src/auth/admin-areas.ts says the same, and RLS section 116 runs
--       every profile against the table.
--
-- No administrator reads a note, nor writes one. A note may name a pupil and
-- why ("Kalle går ut 10.15 till specialpedagogen"); it is no gallring kind,
-- and a read of it has no subject the läslogg could record. So it is read by
-- the people it was written to and by, the lesson's teachers, and nobody
-- else: not rektor, not a läsare. What the school's administrators need of
-- it is that it exists — the cover board marks a lesson whose teacher left
-- one, the booking's e-mail says there is one, a publish names a lesson that
-- would take one with it — and app.substitute_noted_lessons(lessons) answers
-- exactly that and no more: which of the given lessons of the caller's
-- school have a note, to a SCHOOL_ADMIN alone. SECURITY DEFINER, STABLE,
-- search_path pinned, EXECUTE to app_authenticated alone. A lesson removed
-- by a publish still takes its note with it (the key's cascade, which row
-- security does not stop).
--
-- ## Beside the live API: every lock at once, or none
--
-- Production runs this while the API before it serves requests. The new
-- keys reference Schools, CalendarLessons and Users, and adding a foreign
-- key takes SHARE ROW EXCLUSIVE on the referenced table: it blocks writes to
-- it, not reads. Requests write those tables in both orders — a register
-- save locks a lesson's attendance and then reads the pupil; an e-mail
-- change locks a Users row and then reads lessons — so a migration that
-- waited for one while it held another could close a cycle with either. So
-- all three are taken first, NOWAIT and together: a refusal rolls the
-- subtransaction back and with it whatever it got, and it tries again 50 ms
-- later (policy-migration-lock-order). It never waits while it holds a lock,
-- and no request queues behind it. After 30 s of refusals it stops with
-- nothing done and can be rerun (prisma migrate resolve --rolled-back, then
-- deploy). lock_timeout bounds any wait nobody foresaw. Nothing live is
-- otherwise changed, and the API before this one reads neither table, so it
-- works unchanged between this migration and the deploy.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Schools", "CalendarLessons", "Users" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Schools, CalendarLessons and Users were not free at once in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- LessonLogs
-- ---------------------------------------------------------------------------

CREATE TABLE "LessonLogs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "calendarLessonId" UUID NOT NULL,
    "topic" TEXT,
    "homework" TEXT,
    "writtenById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LessonLogs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LessonLogs_topic_is_one_line" CHECK (
        "topic" IS NULL OR (
            "topic" = btrim("topic", E' \t\r\n')
            AND char_length("topic") BETWEEN 1 AND 200
            AND "topic" !~ E'[\\r\\n]'
        )
    ),
    CONSTRAINT "LessonLogs_homework_written" CHECK (
        "homework" IS NULL OR (
            "homework" = btrim("homework", E' \t\r\n')
            AND char_length("homework") BETWEEN 1 AND 1000
        )
    ),
    CONSTRAINT "LessonLogs_says_something" CHECK ("topic" IS NOT NULL OR "homework" IS NOT NULL)
);

CREATE UNIQUE INDEX "LessonLogs_calendarLessonId_key" ON "LessonLogs"("calendarLessonId");
CREATE INDEX "LessonLogs_schoolId_idx" ON "LessonLogs"("schoolId");
CREATE INDEX "LessonLogs_writtenById_idx" ON "LessonLogs"("writtenById");

ALTER TABLE "LessonLogs"
    ADD CONSTRAINT "LessonLogs_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LessonLogs"
    ADD CONSTRAINT "LessonLogs_calendarLessonId_schoolId_fkey" FOREIGN KEY ("calendarLessonId", "schoolId")
    REFERENCES "CalendarLessons"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "LessonLogs"
    ADD CONSTRAINT "LessonLogs_writtenById_schoolId_fkey" FOREIGN KEY ("writtenById", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON UPDATE NO ACTION ON DELETE SET NULL ("writtenById");

-- ---------------------------------------------------------------------------
-- LessonSubstituteNotes
-- ---------------------------------------------------------------------------

CREATE TABLE "LessonSubstituteNotes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "calendarLessonId" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "writtenById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LessonSubstituteNotes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LessonSubstituteNotes_body_written" CHECK (
        "body" = btrim("body", E' \t\r\n')
        AND char_length("body") BETWEEN 1 AND 2000
    )
);

CREATE UNIQUE INDEX "LessonSubstituteNotes_calendarLessonId_key" ON "LessonSubstituteNotes"("calendarLessonId");
CREATE INDEX "LessonSubstituteNotes_schoolId_idx" ON "LessonSubstituteNotes"("schoolId");
CREATE INDEX "LessonSubstituteNotes_writtenById_idx" ON "LessonSubstituteNotes"("writtenById");

ALTER TABLE "LessonSubstituteNotes"
    ADD CONSTRAINT "LessonSubstituteNotes_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LessonSubstituteNotes"
    ADD CONSTRAINT "LessonSubstituteNotes_calendarLessonId_schoolId_fkey" FOREIGN KEY ("calendarLessonId", "schoolId")
    REFERENCES "CalendarLessons"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "LessonSubstituteNotes"
    ADD CONSTRAINT "LessonSubstituteNotes_writtenById_schoolId_fkey" FOREIGN KEY ("writtenById", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON UPDATE NO ACTION ON DELETE SET NULL ("writtenById");

-- ---------------------------------------------------------------------------
-- app.lesson_teacher_role
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.lesson_teacher_role(p_lesson uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT CASE
           WHEN EXISTS (SELECT 1 FROM "CalendarLessonTeachers" t
                         WHERE t."calendarLessonId" = l."id" AND t."schoolId" = l."schoolId"
                           AND t."teacherId" = me.id AND t."role" <> 'SUBSTITUTE')
             OR EXISTS (SELECT 1 FROM "TeacherAbsenceCovers" c
                         WHERE c."calendarLessonId" = l."id" AND c."schoolId" = l."schoolId"
                           AND c."absentTeacherId" = me.id)
             THEN 'REGULAR'
           WHEN EXISTS (SELECT 1 FROM "CalendarLessonTeachers" t
                         WHERE t."calendarLessonId" = l."id" AND t."schoolId" = l."schoolId"
                           AND t."teacherId" = me.id AND t."role" = 'SUBSTITUTE')
             THEN 'SUBSTITUTE'
         END
    FROM "CalendarLessons" l
   CROSS JOIN (SELECT app.current_user_id() AS id) me
   WHERE l."id" = p_lesson
     AND l."schoolId" = app.current_school_id()
     AND app.current_user_role() = 'TEACHER'
     AND me.id IS NOT NULL
$$;

COMMENT ON FUNCTION app.lesson_teacher_role(uuid) IS
  'Lektionslogg (20261203090000): REGULAR when the calling TEACHER is the lesson''s own teacher (a CalendarLessonTeachers row other than SUBSTITUTE, or the absent teacher of a cover decision on it; never the master lesson''s, which in a DRAFT school is the unpublished draft), SUBSTITUTE when only its substitute, NULL otherwise and for every other role or school.';

-- ---------------------------------------------------------------------------
-- app.substitute_noted_lessons: that a note exists, to the school's
-- administrators, never what it says. See the preamble.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.substitute_noted_lessons(p_lessons uuid[]) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT n."calendarLessonId"
    FROM "LessonSubstituteNotes" n
   WHERE n."calendarLessonId" = ANY (p_lessons)
     AND n."schoolId" = app.current_school_id()
     AND app.current_user_role() = 'SCHOOL_ADMIN'
$$;

COMMENT ON FUNCTION app.substitute_noted_lessons(uuid[]) IS
  'Lektionslogg (20261203090000): which of the given calendar lessons of the caller''s school have a note to the substitute, to a SCHOOL_ADMIN alone and nobody else; never the note, which no administrator reads.';

-- ---------------------------------------------------------------------------
-- Who wrote it: the claims' user, whatever the writer sends. See the preamble.
-- ---------------------------------------------------------------------------

-- One exception: an update made by another trigger. Deleting the writer's
-- Users row empties "writtenById" through the key's ON DELETE SET NULL, an
-- UPDATE the key's own trigger makes; stamped here, it would name whoever
-- deleted the person as the author.
CREATE FUNCTION app.lesson_text_written_by() RETURNS trigger
LANGUAGE plpgsql SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;
  NEW."writtenById" := coalesce(app.current_user_id(), NEW."writtenById");
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app.lesson_text_written_by() IS
  'Lektionslogg (20261203090000): a lesson log''s or note''s writtenById is the claims'' user (app.current_user_id()), whatever the writer sends; only a write with no user keeps what it sent.';

CREATE TRIGGER "LessonLogs_written_by_the_writer"
    BEFORE INSERT OR UPDATE ON "LessonLogs"
    FOR EACH ROW EXECUTE FUNCTION app.lesson_text_written_by();
CREATE TRIGGER "LessonSubstituteNotes_written_by_the_writer"
    BEFORE INSERT OR UPDATE ON "LessonSubstituteNotes"
    FOR EACH ROW EXECUTE FUNCTION app.lesson_text_written_by();

-- ---------------------------------------------------------------------------
-- Row-level security, grants. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "LessonLogs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LessonSubstituteNotes" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    RETURN;
  END IF;

  -- LessonLogs: staff read, families read their lessons', the lesson's
  -- teachers and DRIFT write.
  CREATE POLICY "lesson_logs_staff_select" ON "LessonLogs"
      FOR SELECT TO "app_authenticated"
      USING ("schoolId" = (select app.current_school_id())
             AND (select app.current_user_role()) IN ('SCHOOL_ADMIN', 'TEACHER'));
  CREATE POLICY "lesson_logs_family_select" ON "LessonLogs"
      FOR SELECT TO "app_authenticated"
      USING ("schoolId" = (select app.current_school_id())
             AND (select app.current_user_role()) IN ('STUDENT', 'GUARDIAN')
             AND EXISTS (SELECT 1 FROM "CalendarLessons" l WHERE l."id" = "LessonLogs"."calendarLessonId"));
  CREATE POLICY "lesson_logs_teacher_insert" ON "LessonLogs"
      FOR INSERT TO "app_authenticated"
      WITH CHECK ("schoolId" = (select app.current_school_id())
                  AND (select app.current_user_role()) = 'TEACHER'
                  AND app.lesson_teacher_role("calendarLessonId") IS NOT NULL);
  CREATE POLICY "lesson_logs_teacher_update" ON "LessonLogs"
      FOR UPDATE TO "app_authenticated"
      USING ("schoolId" = (select app.current_school_id())
             AND (select app.current_user_role()) = 'TEACHER'
             AND app.lesson_teacher_role("calendarLessonId") IS NOT NULL)
      WITH CHECK ("schoolId" = (select app.current_school_id())
                  AND (select app.current_user_role()) = 'TEACHER'
                  AND app.lesson_teacher_role("calendarLessonId") IS NOT NULL);
  CREATE POLICY "lesson_logs_teacher_delete" ON "LessonLogs"
      FOR DELETE TO "app_authenticated"
      USING ("schoolId" = (select app.current_school_id())
             AND (select app.current_user_role()) = 'TEACHER'
             AND app.lesson_teacher_role("calendarLessonId") IS NOT NULL);
  CREATE POLICY "lesson_logs_admin_insert" ON "LessonLogs"
      FOR INSERT TO "app_authenticated"
      WITH CHECK ("schoolId" = (select app.current_school_id())
                  AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                  AND (select app.current_user_may('DRIFT', true)));
  -- USING does not ask the area (section 106 c).
  CREATE POLICY "lesson_logs_admin_update" ON "LessonLogs"
      FOR UPDATE TO "app_authenticated"
      USING ("schoolId" = (select app.current_school_id())
             AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
      WITH CHECK ("schoolId" = (select app.current_school_id())
                  AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                  AND (select app.current_user_may('DRIFT', true)));
  CREATE POLICY "lesson_logs_admin_delete" ON "LessonLogs"
      FOR DELETE TO "app_authenticated"
      USING ("schoolId" = (select app.current_school_id())
             AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
             AND (select app.current_user_may('DRIFT', true)));

  -- LessonSubstituteNotes: the lesson's teachers read; the lesson's own
  -- teacher writes. No arm for an administrator, a STUDENT or a GUARDIAN.
  CREATE POLICY "lesson_substitute_notes_teacher_select" ON "LessonSubstituteNotes"
      FOR SELECT TO "app_authenticated"
      USING ("schoolId" = (select app.current_school_id())
             AND (select app.current_user_role()) = 'TEACHER'
             AND app.lesson_teacher_role("calendarLessonId") IS NOT NULL);
  CREATE POLICY "lesson_substitute_notes_teacher_insert" ON "LessonSubstituteNotes"
      FOR INSERT TO "app_authenticated"
      WITH CHECK ("schoolId" = (select app.current_school_id())
                  AND (select app.current_user_role()) = 'TEACHER'
                  AND app.lesson_teacher_role("calendarLessonId") = 'REGULAR');
  CREATE POLICY "lesson_substitute_notes_teacher_update" ON "LessonSubstituteNotes"
      FOR UPDATE TO "app_authenticated"
      USING ("schoolId" = (select app.current_school_id())
             AND (select app.current_user_role()) = 'TEACHER'
             AND app.lesson_teacher_role("calendarLessonId") = 'REGULAR')
      WITH CHECK ("schoolId" = (select app.current_school_id())
                  AND (select app.current_user_role()) = 'TEACHER'
                  AND app.lesson_teacher_role("calendarLessonId") = 'REGULAR');
  CREATE POLICY "lesson_substitute_notes_teacher_delete" ON "LessonSubstituteNotes"
      FOR DELETE TO "app_authenticated"
      USING ("schoolId" = (select app.current_school_id())
             AND (select app.current_user_role()) = 'TEACHER'
             AND app.lesson_teacher_role("calendarLessonId") = 'REGULAR');
END
$$;

DO $$
DECLARE
  r text;
BEGIN
  -- ALL, so that on Postgres 17 MAINTAIN goes too.
  FOREACH r IN ARRAY ARRAY['app_authenticated', 'authenticated', 'anon', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "LessonLogs" FROM %I', r);
      EXECUTE format('REVOKE ALL ON "LessonSubstituteNotes" FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION app.lesson_teacher_role(uuid) FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION app.substitute_noted_lessons(uuid[]) FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION app.lesson_text_written_by() FROM %I', r);
    END IF;
  END LOOP;
  REVOKE ALL ON FUNCTION app.lesson_teacher_role(uuid) FROM PUBLIC;
  REVOKE ALL ON FUNCTION app.substitute_noted_lessons(uuid[]) FROM PUBLIC;
  -- A trigger function is called by its trigger, which asks no EXECUTE; nobody calls it.
  REVOKE ALL ON FUNCTION app.lesson_text_written_by() FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "LessonLogs" TO "app_authenticated";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "LessonSubstituteNotes" TO "app_authenticated";
    GRANT EXECUTE ON FUNCTION app.lesson_teacher_role(uuid) TO "app_authenticated";
    GRANT EXECUTE ON FUNCTION app.substitute_noted_lessons(uuid[]) TO "app_authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT ON "LessonLogs" TO "service_role";
    GRANT SELECT ON "LessonSubstituteNotes" TO "service_role";
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- LESSON_LOG_REACH: the twelve arms above and no other, every one for the
-- API's role; none for a PostgREST role, the service or the sync principal;
-- and no arm on the notes names a pupil or a guardian.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  bad text;
  arms int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    RETURN;
  END IF;
  SELECT string_agg(p.tablename || '.' || p.policyname || ' ' || p.cmd || ' ' || p.roles::text, ', '
                    ORDER BY p.tablename, p.policyname) INTO bad
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename IN ('LessonLogs', 'LessonSubstituteNotes')
     AND NOT (p.roles = '{app_authenticated}'::name[]
              AND p.permissive = 'PERMISSIVE'
              AND (p.tablename, p.policyname, p.cmd) IN (
                    ('LessonLogs', 'lesson_logs_staff_select', 'SELECT'),
                    ('LessonLogs', 'lesson_logs_family_select', 'SELECT'),
                    ('LessonLogs', 'lesson_logs_teacher_insert', 'INSERT'),
                    ('LessonLogs', 'lesson_logs_teacher_update', 'UPDATE'),
                    ('LessonLogs', 'lesson_logs_teacher_delete', 'DELETE'),
                    ('LessonLogs', 'lesson_logs_admin_insert', 'INSERT'),
                    ('LessonLogs', 'lesson_logs_admin_update', 'UPDATE'),
                    ('LessonLogs', 'lesson_logs_admin_delete', 'DELETE'),
                    ('LessonSubstituteNotes', 'lesson_substitute_notes_teacher_select', 'SELECT'),
                    ('LessonSubstituteNotes', 'lesson_substitute_notes_teacher_insert', 'INSERT'),
                    ('LessonSubstituteNotes', 'lesson_substitute_notes_teacher_update', 'UPDATE'),
                    ('LessonSubstituteNotes', 'lesson_substitute_notes_teacher_delete', 'DELETE')));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'LESSON_LOG_REACH: these arms reach LessonLogs or LessonSubstituteNotes beyond the twelve of 20261203090000: %', bad;
  END IF;
  SELECT count(*) INTO arms FROM pg_policies
   WHERE schemaname = 'public' AND tablename IN ('LessonLogs', 'LessonSubstituteNotes');
  IF arms <> 12 THEN
    RAISE EXCEPTION 'LESSON_LOG_REACH: LessonLogs and LessonSubstituteNotes have % arms, not the twelve above', arms;
  END IF;
  SELECT string_agg(p.policyname, ', ') INTO bad
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = 'LessonSubstituteNotes'
     AND (coalesce(p.qual, '') || coalesce(p.with_check, '')) ~ '(STUDENT|GUARDIAN|guardian)';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'LESSON_LOG_REACH: a note to the substitute is staff''s, and these arms name a pupil or a guardian: %', bad;
  END IF;
END
$$;
