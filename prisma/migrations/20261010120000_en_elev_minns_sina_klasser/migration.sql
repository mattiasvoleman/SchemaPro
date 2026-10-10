-- En elev minns sina klasser.
--
-- A pupil's home class is Users."studentGroupId", and it is overwritten: by an
-- admin moving the pupil, by the CSV and SS12000 imports, and by the year
-- rollover's activation, which moves every pupil of a school into next year's
-- classes in one transaction. After that nobody can say which class a pupil
-- sat in in åk 7, so the timplan's stage totals — lågstadiet, mellanstadiet,
-- högstadiet, summed over the stage's years per pupil — cannot be computed at
-- all, and P3's delivered layer reads a past year with today's rosters
-- (TIMPLAN_DELIVERED_PAST_YEAR_ROSTERS). Timplan P4 gives the home class a
-- history: StudentEnrollments.
--
-- ## One row per SEGMENT
--
-- A segment is an unbroken period during which a pupil had one home class in
-- one läsår: validFrom (inclusive) to validTo (exclusive), both the school's
-- local dates. A mid-year move closes one segment and opens the next; the open
-- row (validTo NULL) is the class the pupil has now. Chosen over "one row per
-- (pupil, year) plus a move log" because the delivered layer needs date ranges
-- — a 7A lesson in September belongs to the pupil, a 7A lesson in November,
-- after the move, does not — and a move log would be replayed into ranges by
-- every reader anyway.
--
--   * gradeLevel is the class's årskurs, copied when the segment is written and
--     kept in step by a trigger on StudentGroups."gradeLevel": correcting a
--     class's grade is a correction, not history. NULL where the class has none
--     (SS12000 creates classes without one; a teaching group can be a home
--     class); the stage view says "årskurs okänd" rather than guessing.
--   * source RECORDED (written by the trigger below) or BACKFILL (this
--     migration, see "What the backfill can honestly say").
--
-- ## The invariant, and the constraints that make a bug loud
--
-- Exactly one open row exists for a pupil iff the pupil is a STUDENT, is
-- ACTIVE, and has a class. isActive is part of it because every roster reader
-- of the product already says so (timplan-coverage.service.ts, room
-- eligibility, the activation plan all filter isActive): a pupil deactivated
-- in October has left the roster in October, and a pupil who returns in March
-- is not credited with the months away.
--
--   * StudentEnrollments_range_is_ordered: validTo IS NULL OR validTo >
--     validFrom. No zero-length segment is ever stored; a segment that never
--     held a day is deleted instead.
--   * StudentEnrollments_one_class_at_a_time: EXCLUDE USING gist over
--     (studentId =, academicYearId =, daterange(validFrom, validTo) &&). Two
--     segments of one pupil in one year never overlap. btree_gist is installed
--     (20260822131500).
--   * StudentEnrollments_one_open_per_pupil: partial UNIQUE (studentId) WHERE
--     validTo IS NULL.
--
-- Neither the EXCLUDE constraint nor the partial index can be stated in
-- schema.prisma; the model says so in a comment, as AcademicYears does for its
-- one-active index.
--
-- ## Keys
--
--   * (studentId, schoolId) -> Users, ON DELETE CASCADE. The history goes with
--     the person, which is also the erasure semantics: a pupil deleted under
--     GDPR leaves no class history behind.
--   * (academicYearId, schoolId) -> AcademicYears, ON DELETE CASCADE. A year
--     deleted takes its history with it, as it takes its classes and lessons.
--   * (studentGroupId, academicYearId, schoolId) -> StudentGroups(id,
--     academicYearId, schoolId), ON UPDATE NO ACTION, ON DELETE SET NULL
--     ("studentGroupId") — the column list, as 20261007150000 uses it. The key
--     ties a segment to a class OF ITS OWN YEAR for every writer. It needs the
--     additive unique StudentGroups_id_academicYearId_schoolId_key.
--   * Users."studentGroupId" references StudentGroups(id) alone, the one
--     tenant reference without a composite key, so a class of another school
--     could be written there through PostgREST (users_admin_all). The trigger
--     below closes that for every pupil, active or not: a class that is not
--     the pupil's school's is refused with 23503 in Users_studentGroupId_fkey's
--     own words — message, the redacted detail, the constraint name — so a
--     tenant cannot tell another school's class id from one that exists
--     nowhere. (Left to the segment's composite key, the refusal came from
--     inside a SECURITY DEFINER function, unredacted, and named the other
--     school's academicYearId; and an inactive pupil, who opens no segment,
--     was not refused at all. Measured in review, closed here.) The gateway
--     answers both with the same 400 "studentGroupId: klassen finns inte i
--     skolan".
--     ON UPDATE NO ACTION, not CASCADE: StudentGroupsService.update accepts
--     academicYearId, and the rollover link trigger only fixes LINKED groups.
--     A cascade would move a class's history into another year while its dates
--     stayed in the old one — false history, and an EXCLUDE clash surfacing as
--     a 500. The service refuses a year change for a class with history with
--     409 STUDENT_GROUP_HAS_ENROLMENT_HISTORY; a class created in the wrong year
--     a minute ago can still be moved, because a same-day move deletes the
--     open rows (below), so emptying the class first frees it.
--     ON DELETE SET NULL, not CASCADE: a deleted class leaves its pupils'
--     segments, grade and dates intact with no class. Deleting a class cascades
--     away its lessons and timplansposter, so the stage view reads that period
--     as UNRECORDED (CLASS_DELETED), never as zero minutes.
--
-- ## Written by a trigger, on every writer
--
-- A pupil's class is changed by six writers, and two of them run no gateway
-- code:
--
--   1. UsersService.create (POST /users), which ImportService.importStudents
--      also goes through for the CSV import;
--   2. UsersService.update (PATCH /users/:id): a move, a removal, a role
--      change (which must clear the class), deactivation and reactivation;
--   3. Ss12000Service.importPersons (updateMany … role: 'STUDENT');
--   4. YearRolloverService.executeActivation (updateMany by id; null for
--      graduates and unplaced pupils);
--   5. the foreign key's ON DELETE SET NULL, when a class is deleted
--      (StudentGroupsService.remove) or a year with its classes;
--   6. direct PostgREST writes: users_admin_all lets an admin's token UPDATE
--      "Users".
--
-- Projected rosters write nothing (projected-rosters.ts), the rollover writes
-- no pupil (registry: User AT_ACTIVATION), and the seed, bench and probe write
-- as the owner. Writers 5 and 6 cannot be covered by service code, and four
-- call sites kept in step forever would be a fifth bug waiting. So the history
-- is written by an AFTER trigger on Users — Fas 3's argument for
-- TeacherEmploymentLogs — in the same transaction and statement as the class
-- change: a rolled-back move leaves no history.
--
-- app.student_enrollments_follow_the_class() fires AFTER INSERT (a pupil
-- created with a class) and AFTER UPDATE OF studentGroupId, isActive, role
-- when one of them changed. It is SECURITY DEFINER, owned by the migration
-- owner, in "app" with a pinned search_path and EXECUTE taken from PUBLIC,
-- like app.teacher_staffing_log. "Today" is the school's local date,
-- (now() AT TIME ZONE Schools.timezone)::date; now() is the transaction's
-- start, so one activation uses one day for every pupil.
--
--   wantOpen := role = STUDENT ∧ isActive ∧ studentGroupId IS NOT NULL
--   from     := y.endDate + 1                 when today is after the class's year,
--               GREATEST(today, y.startDate)  otherwise
--     A class of a year that has ended claims no day inside it; a class of a
--     year that has not begun is entered on its first day.
--   open     := the pupil's open row, FOR UPDATE
--   * same year, and the open row has held no day yet (validFrom >= from): a
--     CORRECTION — the open row takes the new class. An admin who puts Anna in
--     7A and corrects it to 7B within the hour leaves one 7B segment.
--   * otherwise the open row is closed at `from` (same year) or at
--     LEAST(GREATEST(today, validFrom), its year's endDate + 1) (another year,
--     or no class any more); a row that would close at or before its own
--     validFrom never held a day and is DELETED.
--   * then, if wantOpen, a closed row of the same pupil, year and class that
--     ends exactly at `from` is re-opened (a move back the same day: 7A → 7B →
--     7A, or 7A → next year's 8A → 7A) and otherwise a row is inserted. The
--     open row is always closed or deleted BEFORE a row is re-opened or
--     inserted: the partial unique index and the EXCLUDE constraint are not
--     deferrable.
--   * `from` is never earlier than the end of the pupil's latest segment in
--     the year, so no path can overlap a segment it did not just close.
--
-- Deactivation closes the segment at today, reactivation opens one from
-- today. A role change clears the class (Users_only_a_student_has_a_class)
-- and closes it; former pupils keep their history, and the STUDENT arm stops
-- showing it because it checks the role. A deleted class: its pupils' class
-- is SET NULL and the trigger closes their segments (the segments' own SET
-- NULL empties their class). A deleted year cascades its segments away; the
-- trigger finds nothing and does nothing. A deleted school removes the Users
-- rows, and a pupil whose school is already gone inside a cascade is skipped
-- (Fas 3's existence lesson: AFTER triggers queued by a referential action
-- report depth 1, so the school's existence is asked, not inferred).
--
-- ## The activation's backdate hint
--
-- A first activation that runs AFTER the new year's startDate is legal
-- (YEAR_ACTIVATION_TOO_EARLY only refuses before the old year's end). Until
-- then every roster reader treated the moved pupils as members of their new
-- classes (projected rosters), and lessons were published that way; recording
-- them "from the day of activation" would make the year's first week
-- unrecorded for exactly the pupils who sat it. So executeActivation sets the
-- transaction-local setting app.enrolment_from to '<yearId>:<startDate>' on a
-- FIRST activation only, and the trigger honours it only for a move out of an
-- EARLIER year's class into a class of that year, with the date inside [the
-- year's start, today]. Read through NULLIF(current_setting(…, true), ''): a
-- pooled connection reads '' after a reset, and a malformed hint is ignored,
-- never raised. PostgREST exposes no set_config, and only an admin can move a
-- pupil anyway — the author of that history.
--
-- ## Nobody else writes the history
--
-- A history the service key can rewrite is no history, and service_role is
-- BYPASSRLS. So, as Fas 3 did for TeacherEmploymentLogs:
--
--   * app.student_enrollments_written_by_trigger(), BEFORE INSERT / UPDATE /
--     DELETE FOR EACH ROW and BEFORE TRUNCATE FOR EACH STATEMENT, raises
--     SQLSTATE 'SE403' unless pg_trigger_depth() > 1: the Users and
--     StudentGroups triggers' own writes and every referential action (a
--     cascade, a SET NULL) pass at depth 2; a statement typed by any role,
--     the owner included, does not. TRUNCATE is refused always.
--   * REVOKE ALL from anon; REVOKE INSERT, UPDATE, DELETE, TRUNCATE,
--     REFERENCES, TRIGGER from authenticated, app_authenticated and
--     service_role; GRANT SELECT to app_authenticated. Guarded, so a role
--     missing in one environment does not abort the deploy there.
--
-- The backfill INSERT below runs BEFORE the guard is created.
--
-- ## What the backfill can honestly say
--
-- The database states one fact about classes: each pupil's CURRENT home class.
-- It says nothing about past years — a predecessor link says where a class
-- went, not who was in it, and a newcomer placed straight into 8A looks the
-- same as a pupil carried from 7A. So the backfill writes one segment per
-- ACTIVE STUDENT with a class, source BACKFILL, from GREATEST(the class's
-- year's startDate, the pupil's own creation in SchemaPro as a local date), or
-- the year's endDate + 1 when that falls after the year has ended (a straggler
-- still sitting in last year's class). It can still claim too much — a pupil
-- moved within the year before today is shown in today's class from the
-- start — and that is why `source` exists: the stage view and the families'
-- statement say "klass enligt läget när historiken började föras". Nothing is
-- inferred from attendance, lesson rosters or teaching-group memberships of
-- past years: years before today are UNRECORDED, never zero.
--
-- A pupil whose class belongs to another school (possible only through a
-- PostgREST write before this migration) is counted in a NOTICE and gets no
-- row; any later write that keeps or sets that class while the pupil is
-- active aborts with 23503 (deactivating them, or clearing the class, does
-- not).
--
-- ## Row-level security
--
-- No write arm for any role. Read:
--
--   * student_enrollments_admin_select: the school's SCHOOL_ADMIN.
--   * student_enrollments_staff_select: a TEACHER of the school, every row.
--     Argued: a teacher already reads every pupil's current class
--     (users_staff_select), every teaching-group membership of every year
--     (student_group_members_staff_select) and every attendance mark of the
--     school, past years included (attendance_staff_select) — a mark at a past
--     7A lesson already says the pupil was in 7A — so the history is no new
--     category of information for a teacher; and a teacher's group coverage of
--     a past year, read from this table, must equal the admin's.
--   * student_enrollments_student_select: a STUDENT, their own rows.
--   * student_enrollments_guardian_select: a GUARDIAN, their children's rows,
--     through 20260822090000's tenant-scoped GuardianStudents subquery plus
--     the role check that subquery lacks. A guardian account belongs to one
--     school (Users.authId is unique and GuardianStudents holds both composite
--     keys), so a guardian with children in two schools has two accounts and
--     each sees that school's child only.
--
-- No service-principal arm: SS12000 exports the current class and nobody
-- reads history there. Every USING carries the role, so an unresolved
-- principal reads nothing.

-- ---------------------------------------------------------------------------
-- The table
-- ---------------------------------------------------------------------------

CREATE TYPE "EnrollmentSource" AS ENUM ('RECORDED', 'BACKFILL');

-- The target the segment's class key needs: a class OF ITS OWN YEAR.
CREATE UNIQUE INDEX "StudentGroups_id_academicYearId_schoolId_key"
    ON "StudentGroups"("id", "academicYearId", "schoolId");

CREATE TABLE "StudentEnrollments" (
    "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"       UUID NOT NULL,
    "studentId"      UUID NOT NULL,
    "academicYearId" UUID NOT NULL,
    "studentGroupId" UUID,
    "gradeLevel"     INTEGER,
    "validFrom"      DATE NOT NULL,
    "validTo"        DATE,
    "source"         "EnrollmentSource" NOT NULL DEFAULT 'RECORDED',
    "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "StudentEnrollments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StudentEnrollments_range_is_ordered" CHECK ("validTo" IS NULL OR "validTo" > "validFrom"),
    -- StudentGroups' own bound.
    CONSTRAINT "StudentEnrollments_gradeLevel_is_sane" CHECK ("gradeLevel" IS NULL OR "gradeLevel" BETWEEN 0 AND 12),
    CONSTRAINT "StudentEnrollments_one_class_at_a_time" EXCLUDE USING gist (
        "studentId" WITH =,
        "academicYearId" WITH =,
        daterange("validFrom", "validTo", '[)') WITH &&
    )
);

CREATE UNIQUE INDEX "StudentEnrollments_one_open_per_pupil"
    ON "StudentEnrollments"("studentId") WHERE "validTo" IS NULL;
-- The year's read (the stage view, past-year coverage).
CREATE INDEX "StudentEnrollments_schoolId_academicYearId_idx"
    ON "StudentEnrollments"("schoolId", "academicYearId");
-- The class key's SET NULL scan.
CREATE INDEX "StudentEnrollments_studentGroupId_schoolId_idx"
    ON "StudentEnrollments"("studentGroupId", "schoolId");
-- A pupil's history in order, and the trigger's look-ups by pupil and year.
CREATE INDEX "StudentEnrollments_studentId_academicYearId_validFrom_idx"
    ON "StudentEnrollments"("studentId", "academicYearId", "validFrom");

ALTER TABLE "StudentEnrollments"
    ADD CONSTRAINT "StudentEnrollments_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StudentEnrollments"
    ADD CONSTRAINT "StudentEnrollments_studentId_schoolId_fkey"
    FOREIGN KEY ("studentId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StudentEnrollments"
    ADD CONSTRAINT "StudentEnrollments_academicYearId_schoolId_fkey"
    FOREIGN KEY ("academicYearId", "schoolId") REFERENCES "AcademicYears"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StudentEnrollments"
    ADD CONSTRAINT "StudentEnrollments_studentGroupId_academicYearId_schoolId_fkey"
    FOREIGN KEY ("studentGroupId", "academicYearId", "schoolId")
    REFERENCES "StudentGroups"("id", "academicYearId", "schoolId")
    ON DELETE SET NULL ("studentGroupId") ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- The backfill. See the preamble. Before the guard exists.
-- ---------------------------------------------------------------------------

DO $$
DECLARE crossed bigint;
BEGIN
  SELECT count(*) INTO crossed
    FROM "Users" u JOIN "StudentGroups" g ON g."id" = u."studentGroupId"
   WHERE u."role" = 'STUDENT' AND u."isActive" AND g."schoolId" <> u."schoolId";
  IF crossed > 0 THEN
    RAISE NOTICE 'StudentEnrollments backfill: % pupil(s) whose class belongs to another school get no segment', crossed;
  END IF;
END
$$;

INSERT INTO "StudentEnrollments"
    ("schoolId", "studentId", "academicYearId", "studentGroupId", "gradeLevel", "validFrom", "validTo", "source")
SELECT u."schoolId", u."id", g."academicYearId", g."id", g."gradeLevel",
       CASE WHEN GREATEST(y."startDate", (u."createdAt" AT TIME ZONE s."timezone")::date) > y."endDate"
            THEN y."endDate" + 1
            ELSE GREATEST(y."startDate", (u."createdAt" AT TIME ZONE s."timezone")::date) END,
       NULL, 'BACKFILL'
  FROM "Users" u
  JOIN "StudentGroups" g ON g."id" = u."studentGroupId" AND g."schoolId" = u."schoolId"
  JOIN "AcademicYears" y ON y."id" = g."academicYearId"
  JOIN "Schools" s ON s."id" = u."schoolId"
 WHERE u."role" = 'STUDENT' AND u."isActive";

-- ---------------------------------------------------------------------------
-- The writers. See the preamble.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.student_enrollments_follow_the_class() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  tz text;
  today date;
  want_open boolean := NEW."role" = 'STUDENT' AND NEW."isActive" AND NEW."studentGroupId" IS NOT NULL;
  -- The class asked for and its year.
  g_id uuid;
  g_grade integer;
  y_id uuid;
  y_start date;
  y_end date;
  -- The open row, if any. Flags, not "record IS NULL": a row with one NULL
  -- column (a deleted class) is neither NULL nor NOT NULL.
  has_open boolean;
  o_id uuid;
  o_year uuid;
  o_group uuid;
  o_grade integer;
  o_from date;
  o_year_end date;
  prev uuid;
  last_end date;
  from_day date;
  to_day date;
  hint text;
  hint_match text[];
  hint_day date;
  check_class boolean;
BEGIN
  -- Inside a school's cascade the school is already gone: nothing to record.
  SELECT s."timezone" INTO tz FROM "Schools" s WHERE s."id" = NEW."schoolId";
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  today := (now() AT TIME ZONE tz)::date;

  -- A class written to the pupil must be a class of the pupil's school,
  -- whether or not a segment opens (an inactive pupil, too). Refused in
  -- Users' own key's words, so the refusal of another school's class id
  -- reads exactly like the refusal of an id that exists nowhere: an existence
  -- oracle for other tenants' classes otherwise (this function runs as the
  -- owner, so a key error raised inside it would name another school's year).
  IF NEW."studentGroupId" IS NOT NULL THEN
    IF TG_OP = 'INSERT' THEN
      check_class := true;
    ELSE
      check_class := want_open OR OLD."studentGroupId" IS DISTINCT FROM NEW."studentGroupId";
    END IF;
    IF check_class AND NOT EXISTS (
         SELECT 1 FROM "StudentGroups" g
          WHERE g."id" = NEW."studentGroupId" AND g."schoolId" = NEW."schoolId") THEN
      RAISE EXCEPTION 'insert or update on table "Users" violates foreign key constraint "Users_studentGroupId_fkey"'
        USING ERRCODE = 'foreign_key_violation',
              DETAIL = 'Key is not present in table "StudentGroups".',
              SCHEMA = 'public',
              TABLE = 'Users',
              CONSTRAINT = 'Users_studentGroupId_fkey';
    END IF;
  END IF;

  IF want_open THEN
    SELECT g."id", g."gradeLevel", y."id", y."startDate", y."endDate"
      INTO g_id, g_grade, y_id, y_start, y_end
      FROM "StudentGroups" g JOIN "AcademicYears" y ON y."id" = g."academicYearId"
     WHERE g."id" = NEW."studentGroupId" AND g."schoolId" = NEW."schoolId";
    IF NOT FOUND THEN
      want_open := false;
    ELSE
      from_day := CASE WHEN today > y_end THEN y_end + 1 ELSE GREATEST(today, y_start) END;
    END IF;
  END IF;

  SELECT e."id", e."academicYearId", e."studentGroupId", e."gradeLevel", e."validFrom"
    INTO o_id, o_year, o_group, o_grade, o_from
    FROM "StudentEnrollments" e
   WHERE e."studentId" = NEW."id" AND e."validTo" IS NULL
     FOR UPDATE;
  has_open := FOUND;

  IF want_open AND has_open AND o_year <> y_id THEN
    -- The activation's hint: only for a move out of an EARLIER year's class.
    hint := NULLIF(current_setting('app.enrolment_from', true), '');
    IF hint IS NOT NULL THEN
      hint_match := regexp_match(hint, '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9]{4}-[0-9]{2}-[0-9]{2})$');
      IF hint_match IS NOT NULL AND hint_match[1] = y_id::text THEN
        BEGIN
          hint_day := hint_match[2]::date;
        EXCEPTION WHEN others THEN
          hint_day := NULL;
        END;
        IF hint_day IS NOT NULL
           AND hint_day BETWEEN y_start AND LEAST(today, y_end)
           AND EXISTS (SELECT 1 FROM "AcademicYears" oy
                        WHERE oy."id" = o_year AND oy."startDate" < y_start) THEN
          from_day := hint_day;
        END IF;
      END IF;
    END IF;
  END IF;

  IF has_open THEN
    IF want_open AND o_year = y_id AND o_from >= from_day THEN
      -- A correction: the open row has held no day yet.
      IF o_group IS NOT DISTINCT FROM g_id AND o_grade IS NOT DISTINCT FROM g_grade THEN
        RETURN NULL;
      END IF;
      SELECT e."id" INTO prev FROM "StudentEnrollments" e
       WHERE e."studentId" = NEW."id" AND e."academicYearId" = y_id
         AND e."validTo" = o_from AND e."studentGroupId" = g_id;
      IF prev IS NOT NULL THEN
        -- Back to the class it left the same day: one segment, as if never moved.
        DELETE FROM "StudentEnrollments" WHERE "id" = o_id;
        UPDATE "StudentEnrollments"
           SET "validTo" = NULL, "gradeLevel" = g_grade, "updatedAt" = now()
         WHERE "id" = prev;
      ELSE
        UPDATE "StudentEnrollments"
           SET "studentGroupId" = g_id, "gradeLevel" = g_grade,
               "source" = 'RECORDED', "updatedAt" = now()
         WHERE "id" = o_id;
      END IF;
      RETURN NULL;
    END IF;

    IF want_open AND o_year = y_id THEN
      to_day := from_day;
    ELSE
      SELECT y."endDate" INTO o_year_end FROM "AcademicYears" y WHERE y."id" = o_year;
      to_day := LEAST(GREATEST(today, o_from), o_year_end + 1);
    END IF;
    IF to_day IS NULL OR to_day <= o_from THEN
      -- It never held a day.
      DELETE FROM "StudentEnrollments" WHERE "id" = o_id;
    ELSE
      UPDATE "StudentEnrollments" SET "validTo" = to_day, "updatedAt" = now() WHERE "id" = o_id;
    END IF;
  END IF;

  IF NOT want_open THEN
    RETURN NULL;
  END IF;

  -- Never earlier than the end of a segment this pupil already has in the year.
  SELECT max(e."validTo") INTO last_end FROM "StudentEnrollments" e
   WHERE e."studentId" = NEW."id" AND e."academicYearId" = y_id;
  IF last_end IS NOT NULL AND last_end > from_day THEN
    from_day := last_end;
  END IF;

  prev := NULL;
  SELECT e."id" INTO prev FROM "StudentEnrollments" e
   WHERE e."studentId" = NEW."id" AND e."academicYearId" = y_id
     AND e."validTo" = from_day AND e."studentGroupId" = g_id;
  IF prev IS NOT NULL THEN
    UPDATE "StudentEnrollments"
       SET "validTo" = NULL, "gradeLevel" = g_grade, "updatedAt" = now()
     WHERE "id" = prev;
  ELSE
    INSERT INTO "StudentEnrollments"
        ("schoolId", "studentId", "academicYearId", "studentGroupId", "gradeLevel", "validFrom", "validTo", "source")
    VALUES (NEW."schoolId", NEW."id", y_id, g_id, g_grade, from_day, NULL, 'RECORDED');
  END IF;
  -- An AFTER trigger's return value is ignored.
  RETURN NULL;
END
$$;

-- A corrected class grade is a correction of every segment in that class.
CREATE FUNCTION app.student_enrollments_follow_the_grade() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  UPDATE "StudentEnrollments"
     SET "gradeLevel" = NEW."gradeLevel", "updatedAt" = now()
   WHERE "studentGroupId" = NEW."id" AND "schoolId" = NEW."schoolId"
     AND "gradeLevel" IS DISTINCT FROM NEW."gradeLevel";
  RETURN NULL;
END
$$;

-- The guard. Inside a trigger function pg_trigger_depth() is 1 when a
-- statement fired it directly, and more when another trigger or a referential
-- action did (measured for BEFORE row triggers in 20261010090000).
CREATE FUNCTION app.student_enrollments_written_by_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF TG_OP <> 'TRUNCATE' AND pg_trigger_depth() > 1 THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'STUDENT_ENROLLMENTS_ARE_RECORDED: en elevs klasshistorik skrivs bara av databasen när klassen ändras'
    USING ERRCODE = 'SE403',
          DETAIL  = format('operation=%s', TG_OP);
END
$$;

REVOKE ALL ON FUNCTION app.student_enrollments_follow_the_class() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.student_enrollments_follow_the_grade() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.student_enrollments_written_by_trigger() FROM PUBLIC;

-- Every pupil created with a class, active or not: an inactive one opens no
-- segment, but its class must still be the school's (see the function).
CREATE TRIGGER "Users_enrollment_on_insert"
    AFTER INSERT ON "Users"
    FOR EACH ROW
    WHEN (NEW."studentGroupId" IS NOT NULL)
    EXECUTE FUNCTION app.student_enrollments_follow_the_class();

CREATE TRIGGER "Users_enrollment_on_update"
    AFTER UPDATE OF "studentGroupId", "isActive", "role" ON "Users"
    FOR EACH ROW
    WHEN (OLD."studentGroupId" IS DISTINCT FROM NEW."studentGroupId"
          OR OLD."isActive" IS DISTINCT FROM NEW."isActive"
          OR OLD."role" IS DISTINCT FROM NEW."role")
    EXECUTE FUNCTION app.student_enrollments_follow_the_class();

CREATE TRIGGER "StudentGroups_enrollment_grade"
    AFTER UPDATE OF "gradeLevel" ON "StudentGroups"
    FOR EACH ROW
    WHEN (OLD."gradeLevel" IS DISTINCT FROM NEW."gradeLevel")
    EXECUTE FUNCTION app.student_enrollments_follow_the_grade();

CREATE TRIGGER "StudentEnrollments_written_by_trigger"
    BEFORE INSERT OR UPDATE OR DELETE ON "StudentEnrollments"
    FOR EACH ROW EXECUTE FUNCTION app.student_enrollments_written_by_trigger();

CREATE TRIGGER "StudentEnrollments_no_truncate"
    BEFORE TRUNCATE ON "StudentEnrollments"
    FOR EACH STATEMENT EXECUTE FUNCTION app.student_enrollments_written_by_trigger();

-- ---------------------------------------------------------------------------
-- Row-level security. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "StudentEnrollments" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "student_enrollments_admin_select" ON "StudentEnrollments"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

CREATE POLICY "student_enrollments_staff_select" ON "StudentEnrollments"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'TEACHER');

CREATE POLICY "student_enrollments_student_select" ON "StudentEnrollments"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) = 'STUDENT'
        AND "studentId" = (select app.current_user_id())
    );

CREATE POLICY "student_enrollments_guardian_select" ON "StudentEnrollments"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) = 'GUARDIAN'
        AND "studentId" IN (
            SELECT gs."studentId" FROM "GuardianStudents" gs
            WHERE gs."guardianId" = (select app.current_user_id())
              AND gs."schoolId" = (select app.current_school_id())
        )
    );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT SELECT ON "StudentEnrollments" TO "app_authenticated";
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "StudentEnrollments" FROM "app_authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "StudentEnrollments" FROM "authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "StudentEnrollments" FROM "anon";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "StudentEnrollments" FROM "service_role";
  END IF;
END
$$;

COMMENT ON TABLE "StudentEnrollments" IS
  'A pupil''s home-class history: one row per segment [validFrom, validTo) in one läsår, written only by the Users trigger. See 20261010120000.';
