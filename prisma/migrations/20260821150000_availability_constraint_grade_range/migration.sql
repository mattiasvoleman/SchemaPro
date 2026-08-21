-- The year a GRADE_LEVEL lock applies to, and the first integrity this table
-- has ever had.
--
-- `minGradeLevel`/`maxGradeLevel` are a closed range, both bounds inclusive,
-- both on the house 0-12 scale used by Rooms and StudentGroups. A single
-- column would have forced "åk 4-6" to be three rows again, which is the very
-- thing the new resource kind exists to avoid.
--
-- No index. The solver payload is assembled by reading every constraint the
-- school owns in one query (there is no per-year filter and never was), so an
-- index on the range would be built and never used.
--
-- ## Why these CHECKs, and only these
--
-- This table shipped with no integrity constraints whatsoever: nothing forces
-- `resourceType` to agree with which id column is populated, nothing bounds
-- `dayOfWeek`, nothing requires `startTime` < `endTime`. Those are real gaps,
-- but they cannot be closed here — the API's PATCH path has never validated
-- the resource shape, so rows already in production may well violate them and
-- an ADD CONSTRAINT would fail the deploy on the customer databases we cannot
-- inspect. Fixing them needs a survey first, then a repair migration.
--
-- The four below are safe for exactly one reason: every one of them is
-- trivially true for every row that can exist right now. Both new columns are
-- NULL on every existing row, and no existing row can carry 'GRADE_LEVEL' —
-- the value did not exist until the previous migration.

ALTER TABLE "AvailabilityConstraints"
    ADD COLUMN "minGradeLevel" INTEGER,
    ADD COLUMN "maxGradeLevel" INTEGER,
    ADD CONSTRAINT "AvailabilityConstraints_gradeRange_bounded" CHECK (
        ("minGradeLevel" IS NULL OR "minGradeLevel" BETWEEN 0 AND 12)
        AND ("maxGradeLevel" IS NULL OR "maxGradeLevel" BETWEEN 0 AND 12)
    ),
    ADD CONSTRAINT "AvailabilityConstraints_gradeRange_ordered" CHECK (
        "minGradeLevel" IS NULL
        OR "maxGradeLevel" IS NULL
        OR "minGradeLevel" <= "maxGradeLevel"
    ),
    -- Populated for a GRADE_LEVEL row and for no other kind. The equality is
    -- deliberate in both directions: a grade range on a TEACHER row is a lock
    -- nobody can read the intent of, and a GRADE_LEVEL row with neither bound
    -- targets either everyone or no one depending on who reads it.
    ADD CONSTRAINT "AvailabilityConstraints_gradeRange_matches_resourceType" CHECK (
        ("resourceType" = 'GRADE_LEVEL')
        = ("minGradeLevel" IS NOT NULL OR "maxGradeLevel" IS NOT NULL)
    ),
    -- A year has no row to point at, so a GRADE_LEVEL constraint must carry
    -- none of the three resource ids. This is also what closes the escalation
    -- below; see the policy note.
    ADD CONSTRAINT "AvailabilityConstraints_gradeLevel_targets_no_row" CHECK (
        "resourceType" <> 'GRADE_LEVEL'
        OR ("userId" IS NULL AND "roomId" IS NULL AND "studentGroupId" IS NULL)
    );

-- ## Teachers must not be able to author a school-wide lock
--
-- `availability_teacher_modify` lets a TEACHER insert, update and delete rows
-- where `userId` is their own id, which is right for "jag är ledig på
-- fredagar". It has never checked `resourceType`, and the table has never
-- enforced that the two agree — so as soon as GRADE_LEVEL exists, a teacher
-- can insert a row that says "block year 7 all Tuesday morning" and stamp
-- their own `userId` on it to satisfy the policy. That is an admin-only
-- decision reached from a teacher's session.
--
-- The CHECK above already closes it structurally: a GRADE_LEVEL row must have
-- `userId` NULL, and `NULL = app.current_user_id()` is NULL, never true, so
-- WITH CHECK rejects the insert. The policy is narrowed anyway, because a rule
-- that depends on a constraint three screens away for its security is one
-- refactor from being wrong, and because the same hole let a teacher stamp
-- their id on a ROOM or STUDENT_GROUP row for no legitimate reason.
--
-- Reads are untouched: `availability_teacher_select` still shows a teacher
-- every constraint in their school, which is what the timetable views need.

DROP POLICY "availability_teacher_modify" ON "AvailabilityConstraints";

CREATE POLICY "availability_teacher_modify" ON "AvailabilityConstraints"
    FOR ALL TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) = 'TEACHER'
        AND "resourceType" = 'TEACHER'
        AND "userId" = (select app.current_user_id())
    )
    WITH CHECK (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) = 'TEACHER'
        AND "resourceType" = 'TEACHER'
        AND "userId" = (select app.current_user_id())
    );
