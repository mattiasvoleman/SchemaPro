-- En avbokning gäller många lektioner.
--
-- Prao for åk 9 for a week, a friluftsdag for the whole school, a studiedag
-- for åk 4–6: a school cancels dozens or hundreds of published lessons for
-- one reason, and today that is one PATCH per lesson, each telling the class
-- separately, with nothing that says the hundred rows belong together or how
-- to take them back. A cancellation batch is that record: the selection the
-- admin made, the rows it cancelled, and how to reverse it.
--
-- ## Three tables
--
-- CancellationBatches: the selection and its outcome. The range is at most
-- 31 days inclusive (toDate − fromDate <= 30), optionally narrowed to a time
-- of day (both bounds or neither, start before end); the scope is the whole
-- school, a span of years, or named groups — groupIds non-empty exactly for
-- GROUPS (an id list, not a key: the scope is a selection made once, as a
-- snapshot's extra groups are, and the service checks every id is a group of
-- the year before it writes). cause is EVENT or MANUAL — never a teacher's or
-- a room's, which are the absence page's and publish's to say. name is what
-- pupils read in the note, "Inställd: {name}". cancelled counts the rows;
-- reversedAt, reinstated and skippedRoomTaken record the reversal, once.
-- createdByUserId and reversedByUserId are SET NULL on their own column: the
-- record outlives an admin removed later.
--
-- CancellationBatchLessons: which calendar rows a batch cancelled, with the
-- note each carried before (restored on reversal). Composite keys to the
-- batch and to the lesson (CalendarLessons(id, schoolId), 20261011100000),
-- both CASCADE: a lesson deleted later leaves the batch, a batch deleted
-- takes its rows with it.
--
-- CancellationBatchCredits: the TimplanCredits a batch handed off when the
-- school counted the day as teaching (P3's tillgodoräknad tid). A link table
-- with composite keys, CASCADE on both sides, rather than an id list: a
-- credit deleted by hand leaves the batch, and a reversal deletes exactly
-- the credits still linked. P3 reads the link to keep these credits out of
-- its schedule gap (a credited friluftsdag is not a schedule shorter than
-- planned).
--
-- ## Row-level security
--
-- *_admin_all on all three, USING and WITH CHECK with the role: a batch is
-- the admin's decision and its rows the admin's record. No STUDENT or
-- GUARDIAN arm anywhere: they read the cancelled lessons in the calendar,
-- with the note, as they read any cancellation.
--
-- One TEACHER arm, on CancellationBatchCredits only (two ids, no name, no
-- figure): a teacher reads the timplan's delivered layer with the credits of
-- their school (TimplanCredits' staff arm), and P3 must know which of them a
-- batch handed off to keep them out of the schedule gap — without the arm a
-- teacher's schedule gap would differ from the admin's for the same line. Grants guarded; anon holds nothing;
-- authenticated and service_role hold no TRUNCATE, REFERENCES or TRIGGER, and
-- service_role no write.

CREATE TABLE "CancellationBatches" (
    "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"         UUID NOT NULL,
    "academicYearId"   UUID NOT NULL,
    "name"             TEXT NOT NULL,
    "cause"            "LessonCancelCause" NOT NULL,
    "fromDate"         DATE NOT NULL,
    "toDate"           DATE NOT NULL,
    "startTime"        TIME(6),
    "endTime"          TIME(6),
    "scope"            TEXT NOT NULL,
    "minGradeLevel"    INTEGER,
    "maxGradeLevel"    INTEGER,
    "groupIds"         UUID[] NOT NULL DEFAULT '{}',
    "cancelled"        INTEGER NOT NULL DEFAULT 0,
    "createdAt"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "createdByUserId"  UUID,
    "reversedAt"       TIMESTAMPTZ(6),
    "reversedByUserId" UUID,
    "reinstated"       INTEGER NOT NULL DEFAULT 0,
    "skippedRoomTaken" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CancellationBatches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CancellationBatches_name_is_sane" CHECK (char_length(btrim("name")) BETWEEN 1 AND 120),
    CONSTRAINT "CancellationBatches_cause_is_the_schools" CHECK ("cause" IN ('EVENT', 'MANUAL')),
    CONSTRAINT "CancellationBatches_range_is_a_month_at_most" CHECK ("toDate" >= "fromDate" AND "toDate" - "fromDate" <= 30),
    CONSTRAINT "CancellationBatches_times_are_a_window" CHECK (
        ("startTime" IS NULL AND "endTime" IS NULL)
        OR ("startTime" IS NOT NULL AND "endTime" IS NOT NULL AND "startTime" < "endTime")
    ),
    CONSTRAINT "CancellationBatches_scope_is_known" CHECK (
        ("scope" = 'SCHOOL' AND "minGradeLevel" IS NULL AND "maxGradeLevel" IS NULL AND cardinality("groupIds") = 0)
        OR ("scope" = 'GRADES' AND "minGradeLevel" IS NOT NULL AND "maxGradeLevel" IS NOT NULL
            AND "minGradeLevel" BETWEEN 0 AND 10 AND "maxGradeLevel" BETWEEN 0 AND 10
            AND "minGradeLevel" <= "maxGradeLevel" AND cardinality("groupIds") = 0)
        OR ("scope" = 'GROUPS' AND "minGradeLevel" IS NULL AND "maxGradeLevel" IS NULL
            AND cardinality("groupIds") BETWEEN 1 AND 200)
    ),
    CONSTRAINT "CancellationBatches_counts_are_sane" CHECK (
        "cancelled" BETWEEN 0 AND 100000 AND "reinstated" BETWEEN 0 AND 100000 AND "skippedRoomTaken" BETWEEN 0 AND 100000
    ),
    -- A batch not reversed has reinstated nothing and nobody reversed it.
    CONSTRAINT "CancellationBatches_reversal_is_recorded" CHECK (
        "reversedAt" IS NOT NULL OR ("reinstated" = 0 AND "skippedRoomTaken" = 0 AND "reversedByUserId" IS NULL)
    )
);

CREATE UNIQUE INDEX "CancellationBatches_id_schoolId_key" ON "CancellationBatches"("id", "schoolId");
CREATE INDEX "CancellationBatches_academicYearId_schoolId_fromDate_idx" ON "CancellationBatches"("academicYearId", "schoolId", "fromDate");
CREATE INDEX "CancellationBatches_createdByUserId_schoolId_idx" ON "CancellationBatches"("createdByUserId", "schoolId");
CREATE INDEX "CancellationBatches_reversedByUserId_schoolId_idx" ON "CancellationBatches"("reversedByUserId", "schoolId");

ALTER TABLE "CancellationBatches"
    ADD CONSTRAINT "CancellationBatches_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CancellationBatches"
    ADD CONSTRAINT "CancellationBatches_academicYearId_schoolId_fkey"
    FOREIGN KEY ("academicYearId", "schoolId") REFERENCES "AcademicYears"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CancellationBatches"
    ADD CONSTRAINT "CancellationBatches_createdByUserId_schoolId_fkey"
    FOREIGN KEY ("createdByUserId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE SET NULL ("createdByUserId") ON UPDATE NO ACTION;
ALTER TABLE "CancellationBatches"
    ADD CONSTRAINT "CancellationBatches_reversedByUserId_schoolId_fkey"
    FOREIGN KEY ("reversedByUserId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE SET NULL ("reversedByUserId") ON UPDATE NO ACTION;

CREATE TABLE "CancellationBatchLessons" (
    "batchId"          UUID NOT NULL,
    "calendarLessonId" UUID NOT NULL,
    "schoolId"         UUID NOT NULL,
    "previousNote"     TEXT,

    CONSTRAINT "CancellationBatchLessons_pkey" PRIMARY KEY ("batchId", "calendarLessonId")
);

CREATE INDEX "CancellationBatchLessons_calendarLessonId_schoolId_idx" ON "CancellationBatchLessons"("calendarLessonId", "schoolId");
CREATE INDEX "CancellationBatchLessons_schoolId_idx" ON "CancellationBatchLessons"("schoolId");

ALTER TABLE "CancellationBatchLessons"
    ADD CONSTRAINT "CancellationBatchLessons_batchId_schoolId_fkey"
    FOREIGN KEY ("batchId", "schoolId") REFERENCES "CancellationBatches"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CancellationBatchLessons"
    ADD CONSTRAINT "CancellationBatchLessons_calendarLessonId_schoolId_fkey"
    FOREIGN KEY ("calendarLessonId", "schoolId") REFERENCES "CalendarLessons"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CancellationBatchCredits" (
    "batchId"  UUID NOT NULL,
    "creditId" UUID NOT NULL,
    "schoolId" UUID NOT NULL,

    CONSTRAINT "CancellationBatchCredits_pkey" PRIMARY KEY ("batchId", "creditId")
);

CREATE UNIQUE INDEX "CancellationBatchCredits_creditId_key" ON "CancellationBatchCredits"("creditId");
CREATE INDEX "CancellationBatchCredits_schoolId_idx" ON "CancellationBatchCredits"("schoolId");

-- TimplanCredits' own (id, schoolId) target.
CREATE UNIQUE INDEX "TimplanCredits_id_schoolId_key" ON "TimplanCredits"("id", "schoolId");

ALTER TABLE "CancellationBatchCredits"
    ADD CONSTRAINT "CancellationBatchCredits_batchId_schoolId_fkey"
    FOREIGN KEY ("batchId", "schoolId") REFERENCES "CancellationBatches"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CancellationBatchCredits"
    ADD CONSTRAINT "CancellationBatchCredits_creditId_schoolId_fkey"
    FOREIGN KEY ("creditId", "schoolId") REFERENCES "TimplanCredits"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "CancellationBatches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CancellationBatchLessons" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CancellationBatchCredits" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cancellation_batches_admin_all" ON "CancellationBatches"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
CREATE POLICY "cancellation_batch_lessons_admin_all" ON "CancellationBatchLessons"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
CREATE POLICY "cancellation_batch_credits_admin_all" ON "CancellationBatchCredits"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
CREATE POLICY "cancellation_batch_credits_staff_select" ON "CancellationBatchCredits"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'TEACHER');

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['CancellationBatches', 'CancellationBatchLessons', 'CancellationBatchCredits'] LOOP
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
END
$$;
