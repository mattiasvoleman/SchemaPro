-- Ett block läggs på samma tider.
--
-- A högstadium reads språkval in teaching groups cut across its classes:
-- Spanska, Tyska and Franska for åk 7, each with pupils from 7A, 7B and 7C.
-- Each group shares pupils with every class it draws from, so the generator
-- kept 7A out of whatever slot each language took — one slot of 7A's week per
-- language, where the school means one slot for the whole språkval. A school
-- says that by putting the rows in a block: their lessons are placed at the
-- same times (Parallella block, the second phase of the Generator lane).
--
-- ## The change
--
--   * "TeachingBlocks": a school's named block in one läsår, "Språkval åk 7"
--     or "Elevens val åk 8". Unique by name in its year, so the timplan page
--     and a refusal can name it without ambiguity.
--   * TeachingRequirements."blockId", nullable: the block the row runs in.
--     Null, the default, is a row in no block, which is every row of every
--     school until one writes a block. Nothing else changes for them.
--
-- ## A block is in its row's own year and school
--
-- The key is composite, (blockId, academicYearId, schoolId) onto the block's
-- (id, academicYearId, schoolId), for the reason every reference from
-- TeachingRequirements carries schoolId (20260822130000): a foreign-key check
-- runs as the referenced table's owner with row security off, so a key on the
-- id alone would accept another school's block, or last year's. With the year
-- in the key a block of 2026/27 cannot hold a row of 2027/28, and a row cannot
-- be moved to another year while it is in a block.
--
-- ON DELETE SET NULL ("blockId"), the column list Postgres 15 added: deleting
-- a block lets its rows go, and keeps them. The plain SET NULL would null all
-- three columns of the key, and two of them are NOT NULL. Prisma cannot say
-- the column list, so schema.prisma says SetNull and this migration says the
-- rest, as 20261007150000 did for the predecessor keys.
--
-- ## The members have the same lessons: SQLSTATE TB409, BLOCK_MEMBERS_DIFFER
--
-- The k-th lesson of each member starts with the k-th of the others, so the
-- members have to agree on what is placed: lessonsPerWeek, minutesPerLesson
-- and lessonLengths (the lessons), and recurrence, startDate and endDate (the
-- weeks). A row whose lessons differ from its block's is refused with
-- SQLSTATE TB409, a class Postgres does not define, and the gateway maps it to
-- the 409 BLOCK_MEMBERS_DIFFER whatever service the write went through: the
-- requirements PATCH, a block's members, the rollover, "Skapa
-- timplansposter".
--
-- AN AFTER ROW TRIGGER, NOT DEFERRED. It fires at the end of its statement,
-- after every row the statement wrote, so one UPDATE of every member — how the
-- block changes its lessons — is judged as a whole, and a member written alone
-- is judged against the others as they are. It is not deferred to COMMIT,
-- where its refusal would reach the gateway as a failed commit rather than as
-- the statement that caused it.
--
-- ONE WRITER OF A BLOCK AT A TIME. Two transactions can each change one member
-- and each find the other member as it was, both pass, and both commit a block
-- that disagrees. So the trigger first takes the block's row FOR UPDATE, held
-- until COMMIT, and only then reads the members: in READ COMMITTED that read
-- is a new snapshot, taken after the lock, and sees whatever the transaction
-- it waited for committed. SECURITY DEFINER, owned by the migration owner, so
-- the lock and the read are the block's whatever the caller may see or update,
-- and the function reads only the block named and its members, in the row's
-- own school.
--
-- ## Who may read and write
--
-- As TeachingRequirements, whose rows a block groups: staff read their
-- school's blocks, the administrator writes them. The web reads through
-- PostgREST and writes through the gateway, so after the grant pattern of
-- 20261016090000 onward: app_authenticated holds SELECT, INSERT, UPDATE and
-- DELETE; authenticated holds SELECT only; anon nothing; service_role SELECT
-- only; nobody TRUNCATE, REFERENCES, TRIGGER or, on Postgres 17, MAINTAIN.
--
-- BACKWARD COMPATIBLE FOR ONE RELEASE. A table nobody writes yet and a
-- nullable column. An API that does not know them writes rows in no block,
-- which the trigger never looks at.

-- ---------------------------------------------------------------------------
-- The table.
-- ---------------------------------------------------------------------------

CREATE TABLE "TeachingBlocks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "academicYearId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "TeachingBlocks_pkey" PRIMARY KEY ("id"),
    -- The DTO's bound: trimmed, 1..80 characters. PostgREST meets no DTO.
    CONSTRAINT "TeachingBlocks_name_is_sane"
        CHECK ("name" = btrim("name") AND char_length("name") BETWEEN 1 AND 80)
);

CREATE UNIQUE INDEX "TeachingBlocks_schoolId_academicYearId_name_key"
    ON "TeachingBlocks"("schoolId", "academicYearId", "name");
-- The target the requirements' composite key needs.
CREATE UNIQUE INDEX "TeachingBlocks_id_academicYearId_schoolId_key"
    ON "TeachingBlocks"("id", "academicYearId", "schoolId");
CREATE INDEX "TeachingBlocks_academicYearId_idx" ON "TeachingBlocks"("academicYearId");

ALTER TABLE "TeachingBlocks"
    ADD CONSTRAINT "TeachingBlocks_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeachingBlocks"
    ADD CONSTRAINT "TeachingBlocks_academicYearId_schoolId_fkey"
    FOREIGN KEY ("academicYearId", "schoolId") REFERENCES "AcademicYears"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- The rows' block.
-- ---------------------------------------------------------------------------

ALTER TABLE "TeachingRequirements" ADD COLUMN "blockId" UUID;

-- Also the index the key's SET NULL and the trigger's read of the members scan.
CREATE INDEX "TeachingRequirements_blockId_idx" ON "TeachingRequirements"("blockId");

ALTER TABLE "TeachingRequirements"
    ADD CONSTRAINT "TeachingRequirements_blockId_academicYearId_schoolId_fkey"
    FOREIGN KEY ("blockId", "academicYearId", "schoolId")
    REFERENCES "TeachingBlocks"("id", "academicYearId", "schoolId")
    ON DELETE SET NULL ("blockId") ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- The members have the same lessons and weeks.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.teaching_block_members_agree()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  block_name text;
  other uuid;
BEGIN
  SELECT b."name" INTO block_name
    FROM "TeachingBlocks" b
   WHERE b."id" = NEW."blockId" AND b."schoolId" = NEW."schoolId"
     FOR UPDATE;

  SELECT r."id" INTO other
    FROM "TeachingRequirements" r
   WHERE r."blockId" = NEW."blockId"
     AND r."schoolId" = NEW."schoolId"
     AND r."id" <> NEW."id"
     AND (r."lessonsPerWeek", r."minutesPerLesson", r."lessonLengths",
          r."recurrence", r."startDate", r."endDate")
         IS DISTINCT FROM
         (NEW."lessonsPerWeek", NEW."minutesPerLesson", NEW."lessonLengths",
          NEW."recurrence", NEW."startDate", NEW."endDate")
   ORDER BY r."id"
   LIMIT 1;

  IF other IS NOT NULL THEN
    RAISE EXCEPTION 'BLOCK_MEMBERS_DIFFER: timplansposterna i blocket "%" har inte samma lektioner och veckor', block_name
      USING ERRCODE = 'TB409',
            DETAIL = format('teachingBlockId=%s requirementId=%s otherRequirementId=%s',
                            NEW."blockId", NEW."id", other);
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION app.teaching_block_members_agree() IS
  'TB409 BLOCK_MEMBERS_DIFFER: a timplanspost in a block has the lessons and weeks of every other member. Locks the block row first.';

CREATE TRIGGER "TeachingRequirements_block_members_agree"
    AFTER INSERT OR UPDATE OF "blockId", "lessonsPerWeek", "minutesPerLesson", "lessonLengths",
                              "recurrence", "startDate", "endDate"
    ON "TeachingRequirements"
    FOR EACH ROW
    WHEN (NEW."blockId" IS NOT NULL)
    EXECUTE FUNCTION app.teaching_block_members_agree();

-- ---------------------------------------------------------------------------
-- Row-level security.
-- ---------------------------------------------------------------------------

ALTER TABLE "TeachingBlocks" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "teaching_blocks_staff_select" ON "TeachingBlocks"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) IN ('TEACHER', 'SCHOOL_ADMIN')
    );

CREATE POLICY "teaching_blocks_admin_all" ON "TeachingBlocks"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

-- ---------------------------------------------------------------------------
-- Grants, guarded.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  r text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "TeachingBlocks" TO "app_authenticated";
    REVOKE TRUNCATE, REFERENCES, TRIGGER ON "TeachingBlocks" FROM "app_authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT ON "TeachingBlocks" TO "authenticated";
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "TeachingBlocks" FROM "authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "TeachingBlocks" FROM "anon";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "TeachingBlocks" FROM "service_role";
  END IF;
  -- MAINTAIN exists from Postgres 17 on, and naming it on 16 is an error.
  IF current_setting('server_version_num')::int >= 170000 THEN
    FOREACH r IN ARRAY ARRAY['app_authenticated', 'authenticated', 'anon', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE MAINTAIN ON "TeachingBlocks" FROM %I', r);
      END IF;
    END LOOP;
  END IF;

  REVOKE ALL ON FUNCTION app.teaching_block_members_agree() FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION app.teaching_block_members_agree() FROM %I', r);
    END IF;
  END LOOP;
END
$$;
