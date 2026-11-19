-- Ett ämne har behörighet som i ett annat ämne.
--
-- A teacher's behörighet (TeacherSubjectQualifications) is bound to the
-- school's own subject row. A school that makes "SO WS" for its work sessions
-- in SO then finds every teacher qualified in SO unqualified there: the
-- staffing report flags each post, the proposal offers nobody, the substitute
-- picker ranks nobody. National codes would have fixed that by grouping
-- everything under one ämne (SO), and were left out on purpose: a school that
-- splits SO into historia and geografi does not want a behörighet in one to
-- count for the other.
--
-- So a subject may name another whose behörighet it uses:
--
--   Subjects."qualificationSubjectId"   "SO WS" -> "SO"
--
-- A teacher who holds SO is then qualified for SO WS with the SO row's
-- årskurser, kind (LEGITIMATION, BEHORIG, TILLATEN) and validity, wherever
-- behörighet is counted. Nothing is stored twice: the gateway reads the
-- derived rows from this one column (src/staffing/qualification-inheritance.ts)
-- and every reader goes through it. NULL, which every subject is until a
-- school says otherwise, is the behörighet the subject's own rows state, so
-- nothing about an existing school moves and nothing is backfilled.
--
-- ## The shape, and what the database refuses
--
--   * The key is ("qualificationSubjectId", "schoolId") -> Subjects("id",
--     "schoolId"), as every key between two school-bound tables is
--     (20270115090000): a subject cannot take its behörighet from another
--     school's. ON UPDATE NO ACTION, as there. ON DELETE SET NULL
--     ("qualificationSubjectId"): when the source subject is deleted the subject
--     that used it goes back to its own rows, and "schoolId", which is NOT NULL
--     and belongs to the tenant, is left alone. The column list is PostgreSQL
--     15+ (the precedent is LocalTimplans."copiedFromId"); a plain SET NULL on a
--     composite key would null "schoolId" too and refuse the delete.
--   * A subject does not point at itself: CHECK.
--   * One level only. A subject that others inherit from inherits from nobody,
--     and a subject that inherits is not the source of another: there is no
--     chain to walk and no cycle to guard. That is a rule about two rows, which
--     no CHECK can state, so a BEFORE trigger asks. It is SQLSTATE QS409 with the
--     reason as the message's first word, and the gateway's service asks the
--     same questions first and answers each in Swedish with the subjects named
--     (SUBJECT_QUALIFICATION_SOURCE_INHERITS, SUBJECT_QUALIFICATION_IS_INHERITED);
--     the trigger is what holds for a writer that did not ask.
--
-- ## Two writers at once
--
-- Setting X -> Y and Y -> Z in two transactions at once would each see the
-- other's row as not there yet (READ COMMITTED) and both pass. The trigger
-- therefore takes one advisory lock per school, transaction-scoped, before it
-- reads: the writes that SET a link take turns, and the second sees the first's
-- commit. Writes that clear a link or touch no link do not fire it. The lock is
-- the trigger's own and no request holds it for longer than the write; a
-- deadlock with a key change on the same row (UPDATE ... SET "code" = ... on a
-- subject at the very moment another transaction sets a link to it) is possible
-- in principle and answers 409 WRITE_CONFLICT, nothing written.
--
-- ## Row security
--
-- No arm changes, and none is needed: the column is the table's, and the arms
-- of Subjects (staff read their school's rows, the administrator of the school
-- writes them, nobody else sees any) govern it as they govern the rest. The
-- composite key gives the one thing a policy cannot: a write that names another
-- school's subject is refused (23503) even for the owner of both. RLS section
-- 540 holds all four to the database. No table grant changes.
--
-- ## Beside the live API
--
-- Additive: one nullable column, one CHECK, one key, one index, one trigger.
-- The API that serves before this names the columns of its own schema and
-- writes none of these: its INSERT leaves the column NULL and its UPDATE never
-- lists it, so the trigger is not fired by it. Its reads select named columns
-- or whole rows, and a whole row simply carries a null more. The API after this
-- reads the column, so this runs first.
--
-- ## Locks
--
-- ADD COLUMN, the CHECK, the key, the index and the trigger take Subjects
-- ACCESS EXCLUSIVE, the one table this touches (the key's parent is the same
-- table). A waiting ACCESS EXCLUSIVE queues every reader of Subjects behind it,
-- and Subjects is read by nearly every request, so the lock is taken first,
-- NOWAIT, and tried again 50 ms later while a request holds it; it never waits
-- while it holds anything. After 30 s of refusals it stops with nothing done and
-- can be rerun (prisma migrate resolve --rolled-back, then deploy). lock_timeout
-- bounds any wait nobody foresaw. The file has a $$ body, so Prisma runs it as
-- one transaction.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Subjects" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Subjects was not free in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;

  ALTER TABLE "Subjects"
    ADD COLUMN "qualificationSubjectId" UUID,
    ADD CONSTRAINT "Subjects_qualificationSubjectId_is_not_itself" CHECK (
      "qualificationSubjectId" IS NULL OR "qualificationSubjectId" <> "id"
    ),
    ADD CONSTRAINT "Subjects_qualificationSubjectId_schoolId_fkey"
      FOREIGN KEY ("qualificationSubjectId", "schoolId") REFERENCES "Subjects"("id", "schoolId")
      ON DELETE SET NULL ("qualificationSubjectId") ON UPDATE NO ACTION;

  -- The key's leading-column index: the delete of a source subject finds the
  -- subjects that used it by ("qualificationSubjectId", "schoolId").
  CREATE INDEX "Subjects_qualificationSubjectId_schoolId_idx"
    ON "Subjects" ("qualificationSubjectId", "schoolId");
END
$$;

COMMENT ON COLUMN "Subjects"."qualificationSubjectId" IS
  'Behörighet som i ett annat ämne (20270225090000): the subject whose teachers'' behörigheter this one uses, with the same årskurser, kind and validity (gateway: qualification-inheritance.ts). One level: a source inherits from nobody, none points at itself. NULL = the subject''s own TeacherSubjectQualifications. Composite key to Subjects, ON DELETE SET NULL ("qualificationSubjectId") so the source going clears the pointer and leaves schoolId.';

-- ---------------------------------------------------------------------------
-- One level: the second rule, which asks two rows
-- ---------------------------------------------------------------------------

-- BEFORE, so that nothing is written that must be taken back, and only for a
-- write that SETS a link (WHEN): a delete, a clearing UPDATE (this key's own
-- SET NULL included) and every UPDATE that does not list the column never
-- reach it. The reads are plain: the lock below, not a row lock, is what
-- makes two writers take turns, and a row lock here could wait for the row
-- of the other writer while it waited for ours.
CREATE FUNCTION app.subjects_qualification_is_one_level() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  sources_source uuid;
  heir           uuid;
BEGIN
  -- One school's links take turns. A statement after the wait takes its
  -- snapshot after it, so the second writer sees the first's commit.
  PERFORM pg_advisory_xact_lock(hashtextextended('Subjects.qualificationSubjectId:' || NEW."schoolId"::text, 0));

  -- The subject chosen as the source inherits from another: a chain.
  SELECT s."qualificationSubjectId" INTO sources_source
    FROM "Subjects" s
   WHERE s."id" = NEW."qualificationSubjectId" AND s."schoolId" = NEW."schoolId";
  IF sources_source IS NOT NULL THEN
    RAISE EXCEPTION 'SUBJECT_QUALIFICATION_SOURCE_INHERITS: ämnet har själv behörighet som i ett annat ämne, välj det ämnet i stället'
      USING ERRCODE = 'QS409',
            DETAIL  = format('subjectId=%s sourceId=%s sourceSourceId=%s', NEW."id", NEW."qualificationSubjectId", sources_source);
  END IF;

  -- The subject is itself the source of another: it would become a link in a chain.
  SELECT s."id" INTO heir
    FROM "Subjects" s
   WHERE s."qualificationSubjectId" = NEW."id" AND s."schoolId" = NEW."schoolId"
   ORDER BY s."id"
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'SUBJECT_QUALIFICATION_IS_INHERITED: ett annat ämne har behörighet som i det här, ta bort det valet först'
      USING ERRCODE = 'QS409',
            DETAIL  = format('subjectId=%s inheritorId=%s', NEW."id", heir);
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app.subjects_qualification_is_one_level() IS
  'Behörighet som i ett annat ämne (20270225090000): refuses (QS409) a subject that points at a subject which itself inherits (SUBJECT_QUALIFICATION_SOURCE_INHERITS) and a subject that others inherit from taking a pointer of its own (SUBJECT_QUALIFICATION_IS_INHERITED). Takes one advisory lock per school so two writers take turns.';

CREATE TRIGGER "Subjects_qualification_is_one_level"
    BEFORE INSERT OR UPDATE OF "qualificationSubjectId" ON "Subjects"
    FOR EACH ROW WHEN (NEW."qualificationSubjectId" IS NOT NULL)
    EXECUTE FUNCTION app.subjects_qualification_is_one_level();

-- ---------------------------------------------------------------------------
-- A trigger function is no API role's to call (the same as 20270212090000's).
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  r text;
BEGIN
  REVOKE ALL ON FUNCTION app.subjects_qualification_is_one_level() FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'app_authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION app.subjects_qualification_is_one_level() FROM %I', r);
    END IF;
  END LOOP;
END
$$;
