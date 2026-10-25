-- En frånvarande rastvakts pass hamnar på vikarietavlan.
--
-- Rastvaktsschema (20261207090000) gave the school its passes: an area, a
-- weekday, a time and a teacher between two dates. Nothing in the school's
-- day read them. A teacher off sick on Tuesday left the lågstadiegård empty
-- at 10:00 with nobody told, and the board offered the colleague who stood
-- there to cover a lesson at the same minute. This migration is the data of
-- Rastvakt i vardagen:
--
--   * SupervisionCovers: what the board decided about one pass on one date
--     whose teacher is away — a vikarie takes it (SUBSTITUTE), or it is left
--     without one (NO_COVER).
--   * Two notice types: SUPERVISION_COVER to the vikarie booked, and
--     SUPERVISION_COVER_WITHDRAWN when the booking is undone or handed to
--     somebody else.
--   * The guard on a teacher's own absence (app.teacher_absences_own_writes_
--     are_narrow) reads these decisions as it reads the lessons'.
--
-- What a vacancy IS — a pass on a date it runs, whose teacher has an ACTIVE
-- absence sharing a minute with it — is derived by the gateway when the board
-- is read (src/cover/supervision-board.ts), as the lessons' pairs are. Only
-- the decision is stored. Nothing here reaches the engine.
--
-- ## One row per pass and date
--
--   * ("shiftId", "date") is UNIQUE: a pass on a day is watched by its own
--     teacher or by one vikarie, whichever absence put it on the board. A
--     stale decision (its vikarie is away too) is replaced in place.
--   * ("shiftId", "schoolId") -> SupervisionShifts, ON DELETE CASCADE. The
--     service refuses to delete or change a pass that has a decision on a
--     date not yet passed (409 SUPERVISION_SHIFT_HAS_COVERS), so a cascade
--     only takes decisions already lived; the board says how to undo the
--     others first, and the vikarie is told. The pass gains the
--     ("id", "schoolId") key that target needs.
--   * ("absenceId", "absentTeacherId", "schoolId") -> TeacherAbsences
--     ("id", "userId", "schoolId"), ON DELETE CASCADE: the decision is the
--     absence's, its person is the absence's person, and an absence edited or
--     withdrawn settles its decisions as it settles the lessons'
--     (teacher-absences.service.ts settleDecisionsOutside). Gallring keeps
--     the absence row and empties its reason, so nothing cascades from it.
--   * ("substituteId", "schoolId") -> Users, ON DELETE CASCADE: the vikarie
--     is a person of the school, and a person removed watches nothing.
--   * ("areaId", "schoolId") -> SupervisionAreas, ON DELETE CASCADE, with
--     "date", "startsAt" and "endsAt": the occurrence as it was decided. The
--     vikarie cannot read another teacher's pass (its arm is the teacher's
--     own), so their week and their notice read the place and the time from
--     here; and an accepted pass never changes its time unseen, since the
--     service refuses to move a pass with decisions ahead.
--   * decision SUBSTITUTE carries a substituteId, NO_COVER none, and the
--     vikarie is never the absent teacher (CHECKs). decidedByUserId is audit,
--     as on TeacherAbsenceCovers, with its key: ("decidedByUserId",
--     "schoolId") -> Users, ON DELETE SET NULL ("decidedByUserId"), so the
--     decider is a person of the school and their removal keeps the
--     decision. No column holds free text or a reason.
--
-- Every key ON UPDATE NO ACTION, as 20261207090000's: ids are never
-- rewritten, and a cascade would carry an owner's change of a row's school
-- into the board with row security off.
--
-- ## Who reads and who writes
--
-- Through the gateway only (app_authenticated); nothing for authenticated or
-- anon, service_role keeps its SELECT and nothing more, and MAINTAIN is the
-- owner's on 17 — as on every table since 20261016130000.
--
--   supervision_covers_admin_select
--       the school's SCHOOL_ADMIN, every area: the board is theirs, as
--       TeacherAbsenceCovers' is.
--   supervision_covers_substitute_select
--       a TEACHER the decisions that name them the vikarie: their own week.
--   supervision_covers_absent_select
--       a TEACHER the decisions on their own absences, as
--       teacher_absence_covers_own_select: their week says that a vikarie
--       takes the pass (never who; the gateway does not say).
--   supervision_covers_admin_insert / _update / _delete
--       the school's SCHOOL_ADMIN who writes Drift
--       (app.current_user_may('DRIFT', true)), as the board's other
--       decisions; the update arm asks it in WITH CHECK only, so a row lock
--       for a read keeps working for every administrator (RLS section 106 c).
--       TABLE_WRITE_GATES in src/auth/admin-areas.ts says the same, and RLS
--       section 116 runs every profile against the table.
--
-- The two teacher arms are two, not one with an OR: each is an AND of the
-- school, the role and one column anchored to the caller, the shape
-- app.cover_policy_arm_is_narrow (20261012130000) holds the other cover
-- tables to. SUPERVISION_COVER_REACH below admits exactly these six.
--
-- ## A teacher's own absence, again
--
-- A teacher who may self-report ends their absence early or withdraws it
-- with their own JWT, and the trigger is the rule there (20261012130000): an
-- early end may leave no decision on a lesson still ahead outside the new
-- period, and a withdrawal no decision at all. The function below is that
-- migration's body, unchanged, plus the same two questions of the pass
-- decisions — the service's settleDecisionsOutside asks both kinds. CREATE
-- OR REPLACE keeps its owner, its trigger and its grants (none: it is a
-- trigger), and states SECURITY DEFINER and search_path again as they were.
--
-- ## Beside the live API: every lock at once, or none
--
-- Production runs this while the API before it serves requests. No existing
-- table gains a column; the new keys take Schools, Users, TeacherAbsences,
-- SupervisionAreas and SupervisionShifts in SHARE ROW EXCLUSIVE, which blocks
-- writes to them (not reads, and not the KEY SHARE a foreign-key check
-- takes) for the length of the file, and the pass key's unique index is
-- built inside that lock (the table holds a school's passes, a few hundred
-- rows; no CONCURRENTLY needed). A request writes Users and TeacherAbsences
-- in one transaction (an absence registered reads its person), so the locks
-- are taken together, NOWAIT, in a loop: a refusal rolls the subtransaction
-- back with whatever it got and tries again 50 ms later; it never waits
-- while it holds a lock, and no request queues behind it. After 30 s it
-- stops with nothing done and can be rerun (prisma migrate resolve
-- --rolled-back, then deploy). lock_timeout bounds any wait nobody foresaw.
-- Run it outside an SS12000 sync window, as 20261207090000.
--
-- The two enum values are added in the same file: nothing in this
-- transaction names them, which is the one thing ADD VALUE forbids
-- (20261018090000 and 20261023090000 split only because their functions
-- did). The API before this migration writes neither and reads its own
-- types; its Prisma client names neither table nor value, so it works
-- unchanged between this migration and the deploy.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Schools" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Users" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "TeacherAbsences" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "SupervisionAreas" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "SupervisionShifts" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Schools, Users, TeacherAbsences, SupervisionAreas and SupervisionShifts were not free at once in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SUPERVISION_COVER';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SUPERVISION_COVER_WITHDRAWN';

CREATE TYPE "SupervisionCoverDecision" AS ENUM ('SUBSTITUTE', 'NO_COVER');

-- The target the cover's tenant-scoped key needs; see User.
CREATE UNIQUE INDEX "SupervisionShifts_id_schoolId_key" ON "SupervisionShifts"("id", "schoolId");

-- ---------------------------------------------------------------------------
-- SupervisionCovers
-- ---------------------------------------------------------------------------

CREATE TABLE "SupervisionCovers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "shiftId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "areaId" UUID NOT NULL,
    "startsAt" TIMESTAMPTZ(6) NOT NULL,
    "endsAt" TIMESTAMPTZ(6) NOT NULL,
    "absenceId" UUID NOT NULL,
    "absentTeacherId" UUID NOT NULL,
    "decision" "SupervisionCoverDecision" NOT NULL,
    "substituteId" UUID,
    "decidedByUserId" UUID,
    "decidedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupervisionCovers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SupervisionCovers_window_is_ordered" CHECK ("endsAt" > "startsAt"),
    -- A vikarie for SUBSTITUTE and nobody for NO_COVER, said as an equality
    -- (an OR would read a null as unknown, which a CHECK lets through).
    CONSTRAINT "SupervisionCovers_substitute_iff_substitute" CHECK (
        ("decision" = 'SUBSTITUTE') = ("substituteId" IS NOT NULL)
    ),
    CONSTRAINT "SupervisionCovers_substitute_is_not_the_absent" CHECK (
        "substituteId" IS NULL OR "substituteId" <> "absentTeacherId"
    )
);

CREATE UNIQUE INDEX "SupervisionCovers_shiftId_date_key" ON "SupervisionCovers"("shiftId", "date");
-- The board's window and the week's counter.
CREATE INDEX "SupervisionCovers_schoolId_date_idx" ON "SupervisionCovers"("schoolId", "date");
-- The vikarie's week and their day in the cover rules; the users key's cascade.
CREATE INDEX "SupervisionCovers_substituteId_date_idx" ON "SupervisionCovers"("substituteId", "date");
-- An absence's decisions (settleDecisionsOutside, the guard) and its key's cascade.
CREATE INDEX "SupervisionCovers_absenceId_absentTeacherId_schoolId_idx"
    ON "SupervisionCovers"("absenceId", "absentTeacherId", "schoolId");
-- The area key's cascade.
CREATE INDEX "SupervisionCovers_areaId_schoolId_idx" ON "SupervisionCovers"("areaId", "schoolId");
-- The decider key's SET NULL when a person is removed.
CREATE INDEX "SupervisionCovers_decidedByUserId_schoolId_idx" ON "SupervisionCovers"("decidedByUserId", "schoolId");

ALTER TABLE "SupervisionCovers"
    ADD CONSTRAINT "SupervisionCovers_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupervisionCovers"
    ADD CONSTRAINT "SupervisionCovers_shiftId_schoolId_fkey" FOREIGN KEY ("shiftId", "schoolId")
    REFERENCES "SupervisionShifts"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "SupervisionCovers"
    ADD CONSTRAINT "SupervisionCovers_areaId_schoolId_fkey" FOREIGN KEY ("areaId", "schoolId")
    REFERENCES "SupervisionAreas"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "SupervisionCovers"
    ADD CONSTRAINT "SupervisionCovers_absence_fkey" FOREIGN KEY ("absenceId", "absentTeacherId", "schoolId")
    REFERENCES "TeacherAbsences"("id", "userId", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "SupervisionCovers"
    ADD CONSTRAINT "SupervisionCovers_substituteId_schoolId_fkey" FOREIGN KEY ("substituteId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "SupervisionCovers"
    ADD CONSTRAINT "SupervisionCovers_decidedByUserId_schoolId_fkey" FOREIGN KEY ("decidedByUserId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE SET NULL ("decidedByUserId") ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- Row-level security and grants. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "SupervisionCovers" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    CREATE POLICY "supervision_covers_admin_select" ON "SupervisionCovers"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    -- app.current_user_id() is NULL for anybody without an active Users row,
    -- and a column = NULL matches nothing.
    CREATE POLICY "supervision_covers_substitute_select" ON "SupervisionCovers"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'TEACHER'
               AND "substituteId" = (select app.current_user_id()));
    CREATE POLICY "supervision_covers_absent_select" ON "SupervisionCovers"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'TEACHER'
               AND "absentTeacherId" = (select app.current_user_id()));
    CREATE POLICY "supervision_covers_admin_insert" ON "SupervisionCovers"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true)));
    CREATE POLICY "supervision_covers_admin_update" ON "SupervisionCovers"
        FOR UPDATE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true)));
    CREATE POLICY "supervision_covers_admin_delete" ON "SupervisionCovers"
        FOR DELETE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
               AND (select app.current_user_may('DRIFT', true)));
    REVOKE ALL ON "SupervisionCovers" FROM "app_authenticated";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "SupervisionCovers" TO "app_authenticated";
  END IF;
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "SupervisionCovers" FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "SupervisionCovers" FROM "service_role";
  END IF;
  -- PostgreSQL 17's MAINTAIN (REINDEX, CLUSTER, VACUUM, LOCK): the owner's alone.
  IF current_setting('server_version_num')::int >= 170000 THEN
    FOREACH r IN ARRAY ARRAY['authenticated', 'app_authenticated', 'service_role', 'anon'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE MAINTAIN ON "SupervisionCovers" FROM %I', r);
      END IF;
    END LOOP;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- app.teacher_absences_own_writes_are_narrow: 20261012130000's body, and the
-- pass decisions asked as the lessons' are.
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
    -- The database's clock: the 60-minute window reads createdAt.
    NEW."createdAt" := now();
    NEW."updatedAt" := now();
    RETURN NEW;
  END IF;

  -- (a) End early: endsAt moves earlier, not before now; nothing else moves;
  -- and no decision on a lesson or a pass still ahead falls outside the new
  -- period.
  IF NEW."endsAt" < OLD."endsAt" AND NEW."endsAt" >= now()
     AND NEW."status" = OLD."status" AND NEW."status" = 'ACTIVE'
     AND NEW."startsAt" = OLD."startsAt"
     AND NEW."wholeDays" IS NOT DISTINCT FROM OLD."wholeDays"
     AND NEW."reasonId" IS NOT DISTINCT FROM OLD."reasonId"
     AND NEW."createdByUserId" IS NOT DISTINCT FROM OLD."createdByUserId"
     AND NEW."createdAt" = OLD."createdAt"
     AND NEW."withdrawnAt" IS NULL AND NEW."withdrawnByUserId" IS NULL
     AND NOT EXISTS (
       SELECT 1
         FROM "TeacherAbsenceCovers" c
         JOIN "CalendarLessons" l ON l."id" = c."calendarLessonId"
        WHERE c."absenceId" = OLD."id"
          AND l."endsAt" > now()
          AND NOT (l."startsAt" < NEW."endsAt" AND l."endsAt" > NEW."startsAt")
     )
     -- Rastvakt i vardagen (20261210090000): a pass's decision carries its
     -- own occurrence, so no join.
     AND NOT EXISTS (
       SELECT 1
         FROM "SupervisionCovers" s
        WHERE s."absenceId" = OLD."id"
          AND s."endsAt" > now()
          AND NOT (s."startsAt" < NEW."endsAt" AND s."endsAt" > NEW."startsAt")
     ) THEN
    NEW."updatedAt" := now();
    RETURN NEW;
  END IF;

  -- (b) Withdraw, by themself: before it starts, or within an hour of
  -- registering it — and never while a decision references it.
  IF OLD."status" = 'ACTIVE' AND NEW."status" = 'WITHDRAWN'
     AND NEW."withdrawnAt" IS NOT NULL
     AND NEW."withdrawnByUserId" IS NOT DISTINCT FROM app.current_user_id()
     AND NEW."startsAt" = OLD."startsAt" AND NEW."endsAt" = OLD."endsAt"
     AND NEW."wholeDays" IS NOT DISTINCT FROM OLD."wholeDays"
     AND NEW."reasonId" IS NOT DISTINCT FROM OLD."reasonId"
     AND NEW."createdByUserId" IS NOT DISTINCT FROM OLD."createdByUserId"
     AND NEW."createdAt" = OLD."createdAt"
     AND NOT EXISTS (SELECT 1 FROM "TeacherAbsenceCovers" c WHERE c."absenceId" = OLD."id")
     AND NOT EXISTS (SELECT 1 FROM "SupervisionCovers" s WHERE s."absenceId" = OLD."id")
     AND (OLD."startsAt" > now() OR now() - OLD."createdAt" <= interval '60 minutes') THEN
    NEW."withdrawnAt" := now();
    NEW."updatedAt" := now();
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'ABSENCE_SELF_EDIT_NARROW: en lärare kan bara avsluta sin frånvaro i förtid eller återkalla den, och aldrig förbi skolans beslut'
    USING ERRCODE = 'TA403';
END
$$;

REVOKE ALL ON FUNCTION app.teacher_absences_own_writes_are_narrow() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- SUPERVISION_COVER_REACH: the six arms above and no other; none for a
-- PostgREST role, the service or the sync principal. Each expression an arm
-- has (USING, WITH CHECK) names the caller's school and the arm's role, has
-- no OR and no NOT, and a teacher's arm anchors its own column to the
-- caller: a name and a command alone would let `USING (true)` through.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  bad text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    RETURN;
  END IF;
  SELECT string_agg(p.policyname || ' ' || p.cmd || ' ' || p.roles::text, ', ' ORDER BY p.policyname) INTO bad
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = 'SupervisionCovers'
     AND NOT coalesce(
           p.roles = '{app_authenticated}'::name[]
           AND p.permissive = 'PERMISSIVE'
           AND (p.policyname, p.cmd) IN (
                 ('supervision_covers_admin_select', 'SELECT'),
                 ('supervision_covers_substitute_select', 'SELECT'),
                 ('supervision_covers_absent_select', 'SELECT'),
                 ('supervision_covers_admin_insert', 'INSERT'),
                 ('supervision_covers_admin_update', 'UPDATE'),
                 ('supervision_covers_admin_delete', 'DELETE'))
           AND (SELECT bool_and(
                         e LIKE '%current_school_id()%'
                         AND e NOT LIKE '% OR %'
                         AND e NOT LIKE '%NOT %'
                         AND e LIKE CASE WHEN p.policyname LIKE 'supervision_covers_admin_%'
                                         THEN '%current_user_role()%= ''SCHOOL_ADMIN''::"UserRole"%'
                                         ELSE '%current_user_role()%= ''TEACHER''::"UserRole"%' END
                         AND e LIKE CASE p.policyname
                                      WHEN 'supervision_covers_substitute_select'
                                        THEN '%("substituteId" = ( SELECT app.current_user_id() AS current_user_id))%'
                                      WHEN 'supervision_covers_absent_select'
                                        THEN '%("absentTeacherId" = ( SELECT app.current_user_id() AS current_user_id))%'
                                      ELSE '%' END)
                  FROM unnest(ARRAY[p.qual, p.with_check]) e
                 WHERE e IS NOT NULL)
           AND (p.cmd = 'SELECT' OR coalesce(p.with_check, p.qual) LIKE '%current_user_may(''DRIFT''%'),
         false);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'SUPERVISION_COVER_REACH: these arms reach SupervisionCovers beyond the admin''s read, the teacher''s own and Drift''s writes: %', bad;
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'SupervisionCovers') <> 6 THEN
    RAISE EXCEPTION 'SUPERVISION_COVER_REACH: SupervisionCovers has % arms, not the six above',
      (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'SupervisionCovers');
  END IF;
END
$$;
