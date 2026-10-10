-- En lektion kan täckas för en frånvaro.
--
-- The absence (20261012090000) says who is away and when; the lessons it
-- touches are derived from the calendar. What is STORED is the school's
-- decision for each of them, one row per (absence, lesson): put in a
-- substitute, cancel the lesson, let the class work on its own under
-- supervision ("självstudier under tillsyn"), or let the co-teacher take it.
--
-- ## Why the decision is a row of its own
--
-- A decision moves the calendar: the absent teacher's CalendarLessonTeachers
-- row is removed (a substitute or a co-teacher takes the lesson) or the
-- lesson is cancelled. Once the absent row is gone the calendar no longer
-- says the lesson was ever theirs, so without this row the lesson would drop
-- off the cover board the moment it was covered, and nothing could undo it.
-- The row is that memory:
--
--   * removedTeachers: EXACTLY the CalendarLessonTeachers rows this decision
--     deleted, as [{teacherId, role}], so "Ångra" puts back what was there —
--     including a co-teacher an old-style assignment wiped together with the
--     absent teacher. A CANCELLED decision removes nobody; every other kind
--     removes at least the absent person. At most ten (a lesson has one or
--     two teachers; ten is a typo's bound, not a policy).
--   * previousNote: the note SUPERVISED_STUDY replaced, put back on undo.
--   * substituteId: who was put in, for the audit. The truth is the calendar
--     row; SET NULL when the person is removed, so no CHECK ties it to the
--     decision (a CHECK would make that SET NULL abort the user's deletion).
--
-- (absenceId, absentTeacherId, schoolId) is ONE composite key to
-- TeacherAbsences(id, userId, schoolId): a decision always names the
-- absence's own person, and the absence's person is fixed (TA409). The key
-- to the lesson is CalendarLessons(id, schoolId) (20261011100000), CASCADE:
-- a lesson regenerated away takes its decision with it and the rematerialised
-- lesson comes back as needing cover. UNIQUE (absenceId, calendarLessonId);
-- a co-taught lesson whose two teachers are both away carries two rows.
--
-- ## Row-level security
--
--   * teacher_absence_covers_admin_all, USING and WITH CHECK with the role.
--   * teacher_absence_covers_own_select: the absent TEACHER reads the
--     decisions on their own absences (absentTeacherId is the absence's
--     person by the key above), to see what became of their lessons.
--   * No write arm for a teacher; nothing for STUDENT, GUARDIAN or the
--     service principal. Colleagues get no read: what they may know, the
--     calendar already shows them.
--
-- The guard of 20261012090000 is repeated for this table.
--
-- ## The teacher's withdrawal, widened
--
-- With the decisions in place the teacher's own withdrawal can be what the
-- review asked for: before the absence starts, OR within an hour of
-- registering it as long as no decision references it — "I pressed the
-- wrong day" at 07:10 should not need the admin. The guard function is
-- replaced with that rule and nothing else changed; the trigger can read
-- the decisions because it runs as its owner.

CREATE TYPE "CoverDecisionKind" AS ENUM ('SUBSTITUTE', 'CANCELLED', 'SUPERVISED_STUDY', 'CO_TEACHER');

CREATE TABLE "TeacherAbsenceCovers" (
    "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"         UUID NOT NULL,
    "absenceId"        UUID NOT NULL,
    "calendarLessonId" UUID NOT NULL,
    "absentTeacherId"  UUID NOT NULL,
    "removedTeachers"  JSONB NOT NULL DEFAULT '[]'::jsonb,
    "decision"         "CoverDecisionKind" NOT NULL,
    "substituteId"     UUID,
    "previousNote"     TEXT,
    "decidedByUserId"  UUID,
    "decidedAt"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "TeacherAbsenceCovers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TeacherAbsenceCovers_removed_is_a_short_list" CHECK (
        jsonb_typeof("removedTeachers") = 'array'
        AND jsonb_array_length("removedTeachers") BETWEEN 0 AND 10
        AND ("decision" = 'CANCELLED' OR jsonb_array_length("removedTeachers") >= 1)
    ),
    CONSTRAINT "TeacherAbsenceCovers_previous_note_is_supervised_studys" CHECK (
        "previousNote" IS NULL OR "decision" = 'SUPERVISED_STUDY'
    )
);

CREATE UNIQUE INDEX "TeacherAbsenceCovers_absenceId_calendarLessonId_key"
    ON "TeacherAbsenceCovers"("absenceId", "calendarLessonId");
CREATE INDEX "TeacherAbsenceCovers_calendarLessonId_schoolId_idx" ON "TeacherAbsenceCovers"("calendarLessonId", "schoolId");
CREATE INDEX "TeacherAbsenceCovers_schoolId_decidedAt_idx" ON "TeacherAbsenceCovers"("schoolId", "decidedAt");
CREATE INDEX "TeacherAbsenceCovers_absenceId_absentTeacherId_schoolId_idx"
    ON "TeacherAbsenceCovers"("absenceId", "absentTeacherId", "schoolId");
CREATE INDEX "TeacherAbsenceCovers_substituteId_schoolId_idx" ON "TeacherAbsenceCovers"("substituteId", "schoolId");
CREATE INDEX "TeacherAbsenceCovers_decidedByUserId_schoolId_idx" ON "TeacherAbsenceCovers"("decidedByUserId", "schoolId");

ALTER TABLE "TeacherAbsenceCovers"
    ADD CONSTRAINT "TeacherAbsenceCovers_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeacherAbsenceCovers"
    ADD CONSTRAINT "TeacherAbsenceCovers_absence_person_fkey"
    FOREIGN KEY ("absenceId", "absentTeacherId", "schoolId") REFERENCES "TeacherAbsences"("id", "userId", "schoolId")
    ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "TeacherAbsenceCovers"
    ADD CONSTRAINT "TeacherAbsenceCovers_calendarLessonId_schoolId_fkey"
    FOREIGN KEY ("calendarLessonId", "schoolId") REFERENCES "CalendarLessons"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeacherAbsenceCovers"
    ADD CONSTRAINT "TeacherAbsenceCovers_substituteId_schoolId_fkey"
    FOREIGN KEY ("substituteId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE SET NULL ("substituteId") ON UPDATE NO ACTION;
ALTER TABLE "TeacherAbsenceCovers"
    ADD CONSTRAINT "TeacherAbsenceCovers_decidedByUserId_schoolId_fkey"
    FOREIGN KEY ("decidedByUserId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE SET NULL ("decidedByUserId") ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- Row-level security. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "TeacherAbsenceCovers" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "teacher_absence_covers_admin_all" ON "TeacherAbsenceCovers"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
CREATE POLICY "teacher_absence_covers_own_select" ON "TeacherAbsenceCovers"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) = 'TEACHER'
        AND "absentTeacherId" = (select app.current_user_id())
    );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "TeacherAbsenceCovers" TO "app_authenticated";
    REVOKE TRUNCATE, REFERENCES, TRIGGER ON "TeacherAbsenceCovers" FROM "app_authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE TRUNCATE, REFERENCES, TRIGGER ON "TeacherAbsenceCovers" FROM "authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "TeacherAbsenceCovers" FROM "anon";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "TeacherAbsenceCovers" FROM "service_role";
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- The teacher's withdrawal: before the start, or within an hour of
-- registering it while no decision references it. Otherwise as before.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.teacher_absences_own_writes_are_narrow() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  tz text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."schoolId" IS DISTINCT FROM OLD."schoolId") THEN
    RAISE EXCEPTION 'ABSENCE_PERSON_IS_FIXED: en frånvaro byter inte person'
      USING ERRCODE = 'TA409';
  END IF;
  IF app.current_user_role() IS DISTINCT FROM 'TEACHER' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT s."timezone" INTO tz FROM "Schools" s WHERE s."id" = NEW."schoolId";
    IF (NEW."startsAt" AT TIME ZONE coalesce(tz, 'Europe/Stockholm'))::date < app.school_today() THEN
      RAISE EXCEPTION 'ABSENCE_SELF_EDIT_NARROW: en lärare anmäler frånvaro från i dag'
        USING ERRCODE = 'TA403';
    END IF;
    RETURN NEW;
  END IF;

  -- (a) End early: endsAt moves earlier, not before now; nothing else moves.
  IF NEW."endsAt" < OLD."endsAt" AND NEW."endsAt" >= now()
     AND NEW."status" = OLD."status" AND NEW."status" = 'ACTIVE'
     AND NEW."startsAt" = OLD."startsAt"
     AND NEW."wholeDays" IS NOT DISTINCT FROM OLD."wholeDays"
     AND NEW."reasonId" IS NOT DISTINCT FROM OLD."reasonId"
     AND NEW."createdByUserId" IS NOT DISTINCT FROM OLD."createdByUserId"
     AND NEW."createdAt" = OLD."createdAt"
     AND NEW."withdrawnAt" IS NULL AND NEW."withdrawnByUserId" IS NULL THEN
    RETURN NEW;
  END IF;

  -- (b) Withdraw, by themself: before it starts, or within an hour of
  -- registering it while nothing has been decided on it.
  IF OLD."status" = 'ACTIVE' AND NEW."status" = 'WITHDRAWN'
     AND NEW."withdrawnAt" IS NOT NULL
     AND NEW."withdrawnByUserId" IS NOT DISTINCT FROM app.current_user_id()
     AND NEW."startsAt" = OLD."startsAt" AND NEW."endsAt" = OLD."endsAt"
     AND NEW."wholeDays" IS NOT DISTINCT FROM OLD."wholeDays"
     AND NEW."reasonId" IS NOT DISTINCT FROM OLD."reasonId"
     AND NEW."createdByUserId" IS NOT DISTINCT FROM OLD."createdByUserId"
     AND NEW."createdAt" = OLD."createdAt"
     AND (
       OLD."startsAt" > now()
       OR (now() - OLD."createdAt" <= interval '60 minutes'
           AND NOT EXISTS (SELECT 1 FROM "TeacherAbsenceCovers" c WHERE c."absenceId" = OLD."id"))
     ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'ABSENCE_SELF_EDIT_NARROW: en lärare kan bara avsluta sin frånvaro i förtid eller återkalla den'
    USING ERRCODE = 'TA403';
END
$$;

REVOKE ALL ON FUNCTION app.teacher_absences_own_writes_are_narrow() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- The guard of 20261012090000, for this table.
-- ---------------------------------------------------------------------------

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(tablename || '.' || policyname, ', ' ORDER BY tablename, policyname) INTO bad
    FROM (
      SELECT p.tablename, p.policyname,
             (p.roles = '{authenticated}'::name[] AND p.permissive = 'PERMISSIVE') AS shaped,
             ARRAY_REMOVE(ARRAY[
               CASE WHEN p.cmd <> 'INSERT' THEN coalesce(p.qual, '') END,
               CASE WHEN p.cmd IN ('INSERT', 'UPDATE', 'ALL') THEN coalesce(p.with_check, p.qual, '') END
             ], NULL) AS arms
        FROM pg_policies p
       WHERE p.schemaname = 'public' AND p.tablename = 'TeacherAbsenceCovers'
    ) x
   WHERE NOT x.shaped
      OR EXISTS (
        SELECT 1 FROM unnest(x.arms) e
         WHERE e NOT LIKE '%current_school_id()%'
            OR NOT (
                 e LIKE '%current_user_role()%= ''SCHOOL_ADMIN''::"UserRole"%'
              OR (e LIKE '%current_user_role()%= ''TEACHER''::"UserRole"%' AND e LIKE '%current_user_id()%')
            )
      );
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'ABSENCE_LEAK: these arms reach a cover decision for somebody other than the admin or the absent teacher: %', bad;
  END IF;
END
$$;
