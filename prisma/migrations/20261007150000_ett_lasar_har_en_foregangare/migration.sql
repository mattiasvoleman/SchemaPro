-- Ett läsår har en föregångare.
--
-- Every school does the same thing each June: next year's classes are this
-- year's classes one årskurs up (7A becomes 8A), with the same teaching groups,
-- mostly the same timplansposter and mostly the same teachers, and in August
-- the pupils sit in their new class. Today SchemaPro knows none of that. An
-- AcademicYear is a name and two dates; a new one starts empty, and an admin
-- re-keys every group and every requirement by hand. Worse, nothing records
-- that next year's 8A IS this year's 7A, so there is nothing a later step could
-- follow to move the pupils, carry a mentorskap (staffing Fas 5) or say which
-- bilaga a cohort started under (timplan P4).
--
-- Läsårsrullning is the feature that does it, and this migration is its data:
-- a predecessor link on AcademicYears and on StudentGroups, and the guards that
-- keep the two links true. Nothing here copies or moves anything. The rollover
-- service (R-3) inserts the successor year with its link and the promoted
-- groups with theirs, in one transaction; activation (R-4) follows the group
-- links to move pupils' home classes. Both read only what is declared here.
-- Nothing reaches the solver: the payload is built from groups and lessons of
-- one year and has no notion of another.
--
-- ## AcademicYears.predecessorId: one successor per year, set once
--
--   * predecessorId UUID NULL, FK (predecessorId, schoolId) -> AcademicYears
--     (id, schoolId). Composite, for the reason every tenant reference here is
--     (20260822130000): the referential check runs as the referenced table's
--     owner with row security off, so a plain id key would accept another
--     school's year under a row honestly stamped with this school's id.
--   * ON DELETE SET NULL ("predecessorId"): deleting the old year — which the
--     school will do one day, or does at once to undo a rollover by deleting
--     the NEW one — must not take the new year with it, and must not fail. The
--     column-list form (PostgreSQL 15+; 20260822130000's teacherId and
--     20261006120000's copiedFromId are the precedents) clears the pointer and
--     leaves schoolId, which is NOT NULL, alone. ON UPDATE NO ACTION: ids are
--     never rewritten, and a cascade rewriting a link is a write the guard
--     below would have to tell from a writer's.
--   * UNIQUE (predecessorId, schoolId): a year has at most one successor. Two
--     "2027/28" rolled from one "2026/27" would each claim the same pupils at
--     activation, and the second activation would find them already moved and
--     leave the first's classes empty. A rollover that loses this race answers
--     23505, which the service turns into 409 YEAR_HAS_SUCCESSOR naming the
--     successor that won. The key's columns are the foreign key's, in its
--     order, so it is also the index the ON DELETE SET NULL scan needs; NULLs
--     are distinct, so every year without a predecessor passes.
--   * CHECK predecessorId <> id: a year is not its own predecessor. Longer
--     cycles cannot form either, and not by a check: a link is only ever
--     written at INSERT (the trigger below refuses every later change but the
--     foreign key's clearing), and an INSERT can only point at a row that
--     already exists, which therefore cannot point back at it.
--
-- graduatingGradeLevel INTEGER NULL, CHECK 0..12: the årskurs that left school
-- at the hand-over INTO this year. A class of the predecessor at or above it got
-- no successor at rollover, and activation reads the same number to tell a
-- graduate (no class, on purpose) from an unplaced pupil (no class, by
-- omission). Stored on the new year rather than recomputed, because the default
-- the wizard proposes (the newest decided timplan's top årskurs) can change
-- after the fact, and activation must judge by what the rollover decided. 0..12
-- is StudentGroup.gradeLevel's DTO bound. No CHECK ties it to predecessorId:
-- the foreign key's SET NULL clears the link and leaves this, and a CHECK
-- requiring both or neither would turn deleting an old year into a failure. A
-- PostgREST admin who rewrites it changes what activation calls a pupil
-- (graduated or unplaced), never where anyone is moved: the moves follow the
-- group links alone.
--
-- ## StudentGroups.predecessorId: the same link, one level down
--
-- The same composite key with the same SET NULL, the same UNIQUE (one successor
-- per group: two successors of 7A would split nothing and claim everything), the
-- same CHECK. Deleting 7A (or its whole year) leaves 8A standing with no
-- predecessor; deleting 8A leaves 7A as it was.
--
-- ## Why a trigger, and what it guards
--
-- The rollover service writes correct links. That is no guarantee to a writer
-- who never meets the service: both tables are FOR ALL to a SCHOOL_ADMIN
-- through PostgREST (academic_years_admin_all, student_groups_admin_all), and
-- StudentGroups also takes INSERTs from the SS12000 service principal
-- (student_groups_service_insert). A link that is wrong is not a cosmetic
-- error. Activation moves every pupil along it: a group linked to a group in
-- the wrong year — or relinked after the fact — moves a whole class into a
-- class of another cohort, or out of the running year, and the old class is
-- emptied in the same transaction. A CHECK sees one row and these are facts
-- about two, so it is two triggers, both raising SQLSTATE 'LR409' — a class
-- PostgreSQL does not define and nothing else here raises — with a MESSAGE that
-- starts with one of three reason tokens and names nothing:
--
--   ROLLOVER_LINK_IS_FIXED    a link was set, re-pointed or cleared by a writer
--   ROLLOVER_LINK_MISMATCH    a group's predecessor is not in its year's predecessor year
--   ROLLOVER_GROUP_IS_LINKED  a group with a predecessor, or that is one, changed year
--
-- rethrowPrismaError maps each to the 409 of the same name. No 403 is needed:
-- whoever can write either table at all is allowed to; it is HOW the row is
-- written that is guarded, for every writer alike.
--
-- 1. app.academic_years_predecessor_is_fixed, AFTER UPDATE OF "predecessorId"
--    ON "AcademicYears". When the value actually changes, the only change
--    allowed is to NULL, and only when the old predecessor row no longer
--    exists — which is exactly the foreign key's SET NULL, and nothing a writer
--    can do while the old year stands. Anything else is ROLLOVER_LINK_IS_FIXED.
--    INSERT is not guarded: the foreign key, the UNIQUE and the CHECK say all
--    there is to say about a year and the year before it (date order between
--    linked years is the services' to check — a CHECK cannot read the other
--    row, and an admin who must correct an end date in June should not meet a
--    trigger for it).
--
-- 2. app.student_groups_predecessor_is_last_years, AFTER INSERT OR UPDATE OF
--    "predecessorId", "academicYearId" ON "StudentGroups".
--    * INSERT with a link: the group's year is read by (academicYearId,
--      schoolId). StudentGroups.academicYearId is still a plain id key (its
--      composite hardening is out of scope here), so an admin can file a group
--      under another school's year; such a row finds no year here and is
--      ROLLOVER_LINK_MISMATCH, rather than having its link judged against a
--      year the trigger — running as the owner — should never have read. The
--      predecessor group is then read by (predecessorId, schoolId) FOR SHARE
--      and must lie in that year's predecessor year; otherwise
--      ROLLOVER_LINK_MISMATCH. A predecessor not found by that pair is left to
--      the composite foreign key, whose 23503 says nothing about the other
--      school. FOR SHARE conflicts with the UPDATE that would move the
--      predecessor to another year at the same moment, so one of the two waits
--      and then sees the other: the mover meets the successor that now exists
--      (below), the linker re-reads the moved row and refuses it.
--    * UPDATE: predecessorId may change only to NULL and only when the old
--      predecessor is gone (the foreign key's SET NULL, from deleting the
--      predecessor group or its year); anything else is
--      ROLLOVER_LINK_IS_FIXED. And a group that has a predecessor, or IS one (a
--      successor row points at it), may not change academicYearId:
--      ROLLOVER_GROUP_IS_LINKED. Moving 8A to another year would leave 7A's
--      successor outside the year after 7A's, and moving 7A would do the same
--      from the other end. A group with neither link moves as before (the
--      groups PATCH takes academicYearId).
--    * kind and gradeLevel are not guarded. A successor turned into a
--      TEACHING_GROUP is not a home class, and activation refuses to use it as
--      one by itself (SUCCESSOR_NOT_A_CLASS); a renamed or regraded successor
--      is the admin's correction to make.
--
-- Both triggers are AFTER, for 20261006120000's reason: an AFTER ROW trigger
-- only ever sees rows that passed every RLS WITH CHECK, where a BEFORE ROW
-- trigger runs ahead of it and would answer a row stamped with another school.
-- Both are SECURITY DEFINER, owned by the migration owner, so that "the old
-- predecessor no longer exists" and "a successor points at this group" are
-- facts and not "the writer cannot see it"; and so both look rows up by the
-- (id, schoolId) the written row carries, never by id alone, wherever the
-- answer is about anything but bare existence. They live in schema "app"
-- beside the identity helpers, with SET search_path, and EXECUTE is taken from
-- PUBLIC: a trigger function is fired, never called. DETAIL carries only the
-- written row's own id (academicYearId=… or studentGroupId=…), never a name
-- and never another row's id — the cross-school case above would otherwise
-- echo another school's year id back from the database.
--
-- The foreign keys' own actions pass both triggers by the NOT EXISTS clause,
-- and that is the only thing that clause admits. A cascade fires its AFTER
-- triggers when its own query ends, with the deleted parent already invisible
-- (20261006120000 proved this for its entries trigger), so deleting a
-- predecessor year — its groups cascade, their successors' links and the
-- successor year's link go to NULL — runs without an LR409; with the clause
-- taken out, section 19 of the RLS suite fails on exactly that delete. And
-- deleting a whole school with a three-year chain in it removes every year and
-- group in one command, whose SET NULL actions only ever reach rows the same
-- command has already deleted: measured with both triggers replaced by ones
-- that refuse every link change, the school delete still passed, so it does
-- not even lean on the clause (P1's entries trigger needed a Schools clause of
-- its own; these do not). Both are proven against a database, not assumed:
-- the RLS suite's section 19 for the first, the adapter probe's (v) for the
-- school (the RLS suite runs as app_authenticated, which has no DELETE on
-- Schools).
--
-- ## Row-level security and grants
--
-- No new table, so no new policy and no GRANT. Both tables' policies are row
-- predicates on schoolId and a role, and none names a column; the new columns
-- are read and written under the arms that already exist (admin FOR ALL,
-- members and staff SELECT, the SS12000 principal SELECT and, on groups,
-- INSERT). The role check already sits in USING as well as WITH CHECK on both
-- admin arms (20260623120000).

-- ---------------------------------------------------------------------------
-- AcademicYears
-- ---------------------------------------------------------------------------

ALTER TABLE "AcademicYears"
    ADD COLUMN "predecessorId"        UUID,
    ADD COLUMN "graduatingGradeLevel" INTEGER;

ALTER TABLE "AcademicYears"
    ADD CONSTRAINT "AcademicYears_is_not_its_own_predecessor" CHECK (
        "predecessorId" IS NULL OR "predecessorId" <> "id"
    ),
    ADD CONSTRAINT "AcademicYears_graduatingGradeLevel_is_sane" CHECK (
        "graduatingGradeLevel" IS NULL OR "graduatingGradeLevel" BETWEEN 0 AND 12
    );

CREATE UNIQUE INDEX "AcademicYears_predecessorId_schoolId_key"
    ON "AcademicYears"("predecessorId", "schoolId");

ALTER TABLE "AcademicYears"
    ADD CONSTRAINT "AcademicYears_predecessorId_schoolId_fkey"
    FOREIGN KEY ("predecessorId", "schoolId") REFERENCES "AcademicYears"("id", "schoolId")
    ON DELETE SET NULL ("predecessorId") ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- StudentGroups
-- ---------------------------------------------------------------------------

ALTER TABLE "StudentGroups"
    ADD COLUMN "predecessorId" UUID;

ALTER TABLE "StudentGroups"
    ADD CONSTRAINT "StudentGroups_is_not_its_own_predecessor" CHECK (
        "predecessorId" IS NULL OR "predecessorId" <> "id"
    );

CREATE UNIQUE INDEX "StudentGroups_predecessorId_schoolId_key"
    ON "StudentGroups"("predecessorId", "schoolId");

ALTER TABLE "StudentGroups"
    ADD CONSTRAINT "StudentGroups_predecessorId_schoolId_fkey"
    FOREIGN KEY ("predecessorId", "schoolId") REFERENCES "StudentGroups"("id", "schoolId")
    ON DELETE SET NULL ("predecessorId") ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- The links are written once: the two triggers. See the preamble.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.academic_years_predecessor_is_fixed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF OLD."predecessorId" IS NOT DISTINCT FROM NEW."predecessorId" THEN
    RETURN NULL;
  END IF;
  -- The foreign key's ON DELETE SET NULL ("predecessorId"): the old year is
  -- gone, and its successor keeps standing without it.
  IF NEW."predecessorId" IS NULL
     AND NOT EXISTS (SELECT 1 FROM "AcademicYears" WHERE "id" = OLD."predecessorId") THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'ROLLOVER_LINK_IS_FIXED: ett läsårs föregångare sätts när läsåret rullas vidare och ändras inte i efterhand'
    USING ERRCODE = 'LR409',
          DETAIL  = format('academicYearId=%s', NEW."id");
END
$$;

CREATE FUNCTION app.student_groups_predecessor_is_last_years() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  year_predecessor uuid;
  predecessor_year uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."predecessorId" IS NULL THEN
      RETURN NULL;
    END IF;
    -- The group's own year, in the group's own school. Not found: the group
    -- is filed under another school's year (the plain academicYearId key lets
    -- that through), and its link is judged against nothing of that school's.
    SELECT y."predecessorId" INTO year_predecessor
      FROM "AcademicYears" y
     WHERE y."id" = NEW."academicYearId" AND y."schoolId" = NEW."schoolId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ROLLOVER_LINK_MISMATCH: gruppens läsår finns inte i gruppens skola'
        USING ERRCODE = 'LR409',
              DETAIL  = format('studentGroupId=%s', NEW."id");
    END IF;
    SELECT g."academicYearId" INTO predecessor_year
      FROM "StudentGroups" g
     WHERE g."id" = NEW."predecessorId" AND g."schoolId" = NEW."schoolId"
       FOR SHARE;
    -- Not found by (id, schoolId): the composite foreign key's to refuse.
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    IF year_predecessor IS NULL OR predecessor_year IS DISTINCT FROM year_predecessor THEN
      RAISE EXCEPTION 'ROLLOVER_LINK_MISMATCH: en grupps föregångare ligger i läsåret före gruppens eget läsår'
        USING ERRCODE = 'LR409',
              DETAIL  = format('studentGroupId=%s', NEW."id");
    END IF;
    RETURN NULL;
  END IF;

  -- UPDATE. The link itself: only the foreign key may clear it.
  IF OLD."predecessorId" IS DISTINCT FROM NEW."predecessorId" THEN
    IF NOT (NEW."predecessorId" IS NULL
            AND NOT EXISTS (SELECT 1 FROM "StudentGroups" WHERE "id" = OLD."predecessorId")) THEN
      RAISE EXCEPTION 'ROLLOVER_LINK_IS_FIXED: en grupps föregångare sätts när läsåret rullas vidare och ändras inte i efterhand'
        USING ERRCODE = 'LR409',
              DETAIL  = format('studentGroupId=%s', NEW."id");
    END IF;
  END IF;

  -- The year: a group linked either way stays in its year.
  IF OLD."academicYearId" IS DISTINCT FROM NEW."academicYearId"
     AND (NEW."predecessorId" IS NOT NULL
          OR EXISTS (SELECT 1 FROM "StudentGroups" s
                      WHERE s."predecessorId" = OLD."id" AND s."schoolId" = OLD."schoolId")) THEN
    RAISE EXCEPTION 'ROLLOVER_GROUP_IS_LINKED: en grupp som är kopplad till förra eller nästa läsårs grupp flyttas inte till ett annat läsår'
      USING ERRCODE = 'LR409',
            DETAIL  = format('studentGroupId=%s', NEW."id");
  END IF;

  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION app.academic_years_predecessor_is_fixed() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.student_groups_predecessor_is_last_years() FROM PUBLIC;

CREATE TRIGGER "AcademicYears_predecessor_is_fixed"
    AFTER UPDATE OF "predecessorId" ON "AcademicYears"
    FOR EACH ROW EXECUTE FUNCTION app.academic_years_predecessor_is_fixed();

CREATE TRIGGER "StudentGroups_predecessor_is_last_years"
    AFTER INSERT OR UPDATE OF "predecessorId", "academicYearId" ON "StudentGroups"
    FOR EACH ROW EXECUTE FUNCTION app.student_groups_predecessor_is_last_years();
