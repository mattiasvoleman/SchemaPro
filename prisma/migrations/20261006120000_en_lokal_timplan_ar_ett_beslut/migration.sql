-- En lokal timplan är ett beslut.
--
-- 20261006090000 put the statute in the database: so many hours of matematik
-- in mellanstadiet, so much skolans val, so large a reduction at most. What it
-- cannot say is what THIS school does with that — the statute never states
-- minutes per week. "Fördelning mellan årskurserna" is the huvudman's decision
-- on rektor's proposal (skolförordningen 9 kap. 4 §), and today a school keys
-- the result of that decision straight into TeachingRequirements, group by
-- group, and the decision itself — 180 min/vecka matematik in åk 4, decided by
-- whom, on what date — exists nowhere.
--
-- Two tables, which are the decision and its content: LocalTimplans (a named
-- plan of one school form, checked against one national version, DRAFT until
-- somebody records that it was decided) and LocalTimplanEntries (minutes per
-- week per school subject per årskurs). Nothing here is sent to the solver,
-- and nothing here refuses a timetable: a timplan is a TARGET, and every
-- comparison against it (P1's coverage module) is a warning — the law itself
-- lets a pupil's anpassade studiegång or prioriterade timplan deviate.
--
-- ## Per school, not per läsår
--
-- For the reason FrameTimes and TeacherWorkRules give: the plan has to exist in
-- August, before the year's groups do, and a school keeps one plan for years
-- (and sometimes runs two — grundskola and anpassad grundskola side by side).
-- Which plan a given läsår and årskurs follow is P2's AcademicYearTimplan, not a
-- column here.
--
-- ## A decided plan is a record, and the database keeps it one
--
-- `status` is DRAFT or DECIDED, and a DECIDED plan carries who recorded the
-- decision, when, and the note that identifies it ("Beslutat av huvudman
-- 2026-05-12, dnr …"). The three are whole: all null on a DRAFT, all set on a
-- DECIDED plan, by CHECK with the count idiom TeacherWorkRules_lunch_is_whole
-- uses. A decision with no date is not a decision anyone can cite, and a note
-- on a draft is a decision that was never taken.
--
-- What makes it a RECORD is that it does not change afterwards. The service
-- refuses with 409 TIMPLAN_IS_DECIDED; the database refuses a second time,
-- because an admin's own Supabase key reaches both tables through PostgREST
-- without meeting the service. A CHECK cannot do it — a CHECK sees one row,
-- and "this entry's plan is decided" is a fact about another table — so it is
-- two triggers, the first in this schema:
--
--   * BEFORE INSERT OR UPDATE ON "LocalTimplans": raises when OLD.status =
--     'DECIDED' (an UPDATE).
--     The DRAFT -> DECIDED transition is an UPDATE of a DRAFT row and passes;
--     DECIDED -> DRAFT does not, because "reopen" is a COPY (copiedFromId) and
--     the decided plan stays what it was. One exception, and it is the foreign
--     key's, not a writer's: when the plan a decided plan was copied FROM is
--     deleted, ON DELETE SET NULL ("copiedFromId") must be able to clear that
--     pointer, or deleting an old decided plan that was reopened and decided
--     again would be impossible. The exception is exact — the new row equals
--     the old one in every column except copiedFromId, which goes to NULL, AND
--     the plan it pointed at no longer exists. A PostgREST UPDATE clearing the
--     pointer while its target still exists is refused like any other.
--   * AFTER INSERT OR UPDATE OR DELETE ON "LocalTimplanEntries" (row level):
--     raises when the parent plan EXISTS and is DECIDED (for an UPDATE, either
--     the old or the new parent). "Exists" is the clause that lets a decided plan be
--     deleted at all: the entries go by ON DELETE CASCADE, which PostgreSQL
--     runs after the parent row is gone, so the trigger finds no parent and
--     lets the cascade through. The same clause is what REFUSES deleting a
--     Subject that a decided plan contains: that cascade reaches the entries
--     while their plan still stands, decided, and raises — so a subject cannot
--     vanish out of a decided record. Subjects only in DRAFT plans cascade as
--     before. Both directions are proven on a database, not assumed; see the
--     RLS suite's section 16 and the commit message.
--
-- The same trigger guards how a decision is MADE, not only that it stays put.
-- A record that says "decided by X on D" is only a record if X and D are
-- facts, and the service's stamping (the caller, now()) is no guarantee to a
-- PostgREST writer who never meets the service: before this, an admin could
-- INSERT a plan straight into DECIDED naming a pupil as the decider and a date
-- in 2019, or delete a decided plan and re-insert it with the same id, other
-- minutes and the old stamps. So, whenever the transaction carries a JWT
-- subject (auth.uid() is set — the gateway's withRls and PostgREST alike):
--
--   * an INSERT must be a DRAFT, and its createdAt is the database's now()
--     (an UPDATE keeps the createdAt it had);
--   * DRAFT -> DECIDED must name the signed-in user, app.current_user_id(), as
--     decidedByUserId, and decidedAt is overwritten with now() — not
--     compared with a tolerance, because the gateway's clock and the
--     database's are two clocks, and the database's is the one a record
--     should carry.
--
-- Both refusals raise SQLSTATE 'TP403' with a message starting
-- TIMPLAN_DECISION_IS_THE_CALLERS. The gateway never meets them — it creates
-- drafts and stamps the caller — so they are the PostgREST writer's answer.
-- The owner with no subject (migrations, prisma/seed.ts, the RLS fixtures)
-- is not asked: it is not a person who could be named by mistake, and the
-- fixtures plant decided plans as it. The house precedent for binding an
-- actor column to the caller is room bookings' WITH CHECK ("bookedById" =
-- app.current_user_id()); a trigger is used here because the rule holds for
-- one transition only, which a policy cannot see. A re-inserted copy of a
-- deleted decision is still possible, but it now carries today's date and
-- the name of whoever re-inserted it, which is what an audit asks for.
--
-- Deleting the plan ITSELF is allowed for a SCHOOL_ADMIN even when it is
-- decided. That is an explicit act (the web asks, naming it a decided plan),
-- not an edit of the record, and refusing it would leave a school with a
-- wrongly entered decision it could never remove.
--
-- And when the whole SCHOOL is deleted (prisma/seed.ts --reset, a tenant
-- leaving), the subject cascade reaches the entries while the plans still
-- stand. The entries trigger therefore asks a third question — does the
-- plan's school still exist — and lets the teardown through when it does not.
-- No API path deletes a school, so this admits nothing a writer can reach.
--
-- The entries trigger is AFTER, not BEFORE, and looks the parent up by the
-- (id, schoolId) the entry row carries, never by id alone — because a trigger
-- that runs as the owner can see every school, and must only ever speak about
-- the writer's own. The first draft looked up by id in a BEFORE trigger, and
-- the RLS suite caught it naming school B's decided plan, by name, to school
-- A's admin who had typed that plan's id into an entry of their own school.
-- The (id, schoolId) match closes that: such a row finds no parent here and is
-- left to the composite foreign key, whose 23503 says nothing about school B.
-- AFTER closes the other door: a BEFORE ROW trigger fires ahead of the RLS
-- WITH CHECK, so a row STAMPED with school B's id and plan would still reach
-- it and be answered TP409 with B's plan name, where AFTER ROW only ever sees
-- rows that passed every policy and the writer gets 42501. The refusal is the
-- same either way — an AFTER trigger that raises rolls the statement back —
-- and a cascade fires its AFTER triggers when its own query ends, with the
-- deleted parent already invisible. The plan trigger stays BEFORE UPDATE: an
-- UPDATE reaches only rows the caller's USING admits, so OLD is always the
-- caller's own plan, and BEFORE is what lets it refuse before anything moves.
--
-- The trigger functions are SECURITY DEFINER, owned by the migration owner,
-- for one reason: "the parent plan does not exist" must mean that, not "the
-- writer cannot see it". Under SECURITY INVOKER the existence test would run
-- through the caller's RLS, and a future role with a write arm on entries and a
-- narrower read on plans would find no parent and pass. As the owner, row
-- security does not apply and the answer is the fact. They live in the "app"
-- schema beside the identity helpers, not in "public", where PostgREST lists
-- functions; and EXECUTE is taken from PUBLIC — a trigger function is fired,
-- never called, and firing needs no EXECUTE grant.
--
-- The entries trigger reads the parent FOR SHARE. Without it, an entry
-- written in one transaction and the plan decided in another could both see
-- DRAFT and both commit, and the record would hold a row added after (or
-- during) its decision. FOR SHARE conflicts with the UPDATE that decides, so
-- one of the two waits, and the one that waits re-reads the committed status
-- under READ COMMITTED.
--
-- Errors carry SQLSTATE 'TP409' — class TP is not one PostgreSQL defines, and
-- nothing else in this schema raises it — and a message that starts with the code the
-- gateway speaks, TIMPLAN_IS_DECIDED, and names the plan. DETAIL carries
-- localTimplanId=<uuid>, so the subjects service can turn a refused subject
-- delete into the same 409 naming the plan instead of a 500.
--
-- ## The plan's school form is the version's school form
--
-- A plan for anpassade grundskolan checked against bilaga 1 would report every
-- cell as wrong by a statute that does not apply to it. The rule is "the
-- plan's schoolForm equals its version's", and the database can state it
-- without a trigger: NationalTimplanVersions gains UNIQUE (id, schoolForm) —
-- redundant as an index, since id is the key, and load-bearing as a target —
-- and the plan references (nationalTimplanVersionId, schoolForm) as a
-- composite foreign key. Changing either column alone on a draft is then a
-- foreign_key_violation, not a mismatch stored. RESTRICT both ways: the
-- statute rows are written only by migrations and never under a plan.
--
-- ## Grade -> stage, which the coverage module depends on
--
-- An entry is keyed on the årskurs; the statute speaks of stadier; and which
-- årskurser make a stadium depends on the school form AND on the lydelse. The
-- mapping, for the five bilagor P0 seeded (skollagen in the lydelse before lag
-- 2025:729):
--
--   GRUNDSKOLA (B1), nio årskurser ........ LAG 1-3, MELLAN 4-6, HOG 7-9
--   ANPASSAD_GRUNDSKOLA_AMNEN / _AMNESOMRADEN (B2A, B2B), nio årskurser
--                                           LAG 1-3, MELLAN 4-6, HOG 7-9
--   SPECIALSKOLA (B3), tio årskurser ...... LAG 1-4, MELLAN 5-7, HOG 8-10
--   SAMESKOLA (B4), sex årskurser .......... LAG 1-3, MELLAN 4-6, no HOG
--
--   LAG_MELLAN (the merged hem- och konsumentkunskap cell) is the union of
--   that form's LAG and MELLAN årskurser: 1-6, or 1-7 in specialskolan.
--
--   Årskurs 0 is förskoleklassen, its own skolform and in no bilaga: an entry
--   for it is stored (a school plans its F-klass minutes too) and belongs to no
--   stadium. The same is true of any årskurs a form does not have — 10 in a
--   nine-year plan, 7-9 in sameskolan.
--
--   The 2028 law (SFS2025:729) re-cuts all of this: förskoleklassen becomes
--   årskurs 1 and grundskolan runs 1-4 / 5-7 / 8-10 (and the other forms
--   shift likewise). Its version row has no cells, so no stage sum is computed
--   against it — the coverage module says "fördelning ej publicerad" — but
--   the mapping is therefore a function of the VERSION (its school form and
--   its lydelse), never of schoolForm alone.
--
-- That is also why the database bounds gradeLevel by 0..10 only and does not
-- refuse an årskurs outside the form: a DRAFT may change its version, and an
-- entry valid under one lydelse would become invalid under the next. 10 is
-- reserved for specialskolan today and for the tioårig grundskola in 2028.
--
-- ## Keys
--
-- Every tenant reference is a composite (id, schoolId) key, for the reason
-- every child table here has one: referential checks run as the referenced
-- table's OWNER with row security off, so a plain id key would accept another
-- school's subject or user under a row honestly stamped with this school's id.
--
--   * entries -> plan (localTimplanId, schoolId), ON DELETE CASCADE.
--   * entries -> subject (subjectId, schoolId), ON DELETE CASCADE — and the
--     entries trigger is what turns that cascade into a refusal when the plan
--     is decided.
--   * plan -> decidedByUserId (decidedByUserId, schoolId) -> Users, ON DELETE
--     RESTRICT. Not SET NULL: that would break the whole-decision CHECK, so it
--     would be a refusal anyway, only a more confusing one. A person who
--     recorded a decision is deactivated, not deleted; deleting them answers
--     23503, which the gateway's mapper already turns into a 409. It does not
--     block a school teardown: the checks a cascade provokes are queued to the
--     end of the outer statement, by which time the plans are gone too (proven
--     by deleting the seeded school with decided plans in it; see the commit).
--   * plan -> copiedFromId (copiedFromId, schoolId) -> LocalTimplans, ON
--     DELETE SET NULL ("copiedFromId"). The column list matters: a plain SET
--     NULL on a composite key nulls EVERY referencing column, schoolId
--     included, which is NOT NULL — the delete of the source plan would fail.
--     The column-list form (PostgreSQL 15+, the precedent is 20260822130000's
--     teacherId) clears the pointer and leaves the tenant alone.
--
-- UNIQUE (schoolId, name) — schoolId leads, so one school's name cannot take
-- another's slot, and the key is the per-school listing's index. UNIQUE
-- (localTimplanId, subjectId, gradeLevel) on entries needs no schoolId: the
-- plan id is already confined to its school by the composite key, so the slot
-- cannot be squatted, and the key is the per-plan read's index.
--
-- ## The CHECKs mirror the DTO bounds
--
-- For 20261006100000's reason: PostgREST writers meet no DTO, and a stored row
-- is replayed by every coverage read from then on.
--
--   * planningWeeks NUMERIC(4,1) 20.0..40.0, default 35.6 (178 skoldagar / 5,
--     the standardvecka count stage hours are computed with before a läsår
--     exists). NUMERIC, not a float, so 35.6 is 35.6: the coverage module
--     multiplies in tenths of a week and never meets binary drift.
--   * name non-blank, at most 100 characters; decisionNote non-blank, at most
--     500; entry note at most 500. "Non-blank" is the DTO's /\S/ written out:
--     the regex class lists exactly the characters JavaScript's \s matches
--     (tab, newline, VT, FF, CR, space, NBSP, U+1680, U+2000-U+200A, U+2028,
--     U+2029, U+202F, U+205F, U+3000, U+FEFF), not btrim(), which strips
--     spaces only and let a name or decision note of one tab or one NBSP
--     through. A decision note blank to every reader identifies nothing.
--     Lengths are char_length, code points; the DTO counts code points too.
--   * gradeLevel 0..10; minutesPerWeek 0..1200. 0 is legal (the subject is not
--     taught that year, said out loud); 1200 is twenty hours a week of one
--     subject, a typo guard. Integer minutes and NOT on the 5-minute grid: a
--     target is not a lesson.
--   * a plan is not copied from itself.
--
-- Entries carry no timestamps: they are replaced wholesale (PUT
-- /local-timplans/:id/entries, like a group's members), so a createdAt would
-- be the time of the last save, which is the plan's updatedAt.
--
-- ## Row-level security: three arms on both tables
--
--   * *_admin_all — the school's SCHOOL_ADMIN, FOR ALL. The only writer.
--   * *_staff_select — TEACHER (and admin) of the school read every plan,
--     drafts included: a teacher is who a draft is discussed with.
--   * *_family_select — STUDENT and GUARDIAN of the school read DECIDED plans
--     and their entries, and never a draft. A decided timplan is public
--     information a parent may ask for; a draft is the school's working paper.
--     The entries arm asks for the parent's status through LocalTimplans, which
--     answers under the caller's own RLS — the plan arm admits a family member
--     to decided plans only, so the two cannot disagree.
--
-- The role check sits in USING as well as WITH CHECK, for section 7's reason:
-- WITH CHECK alone stops a writer authoring a row and leaves them able to
-- DELETE one. No service-principal arm: SS12000 exposure of decided plans is
-- P4, and an arm nobody reads is an arm nobody tests.

CREATE TYPE "LocalTimplanStatus" AS ENUM ('DRAFT', 'DECIDED');

-- ---------------------------------------------------------------------------
-- The composite target the school-form rule needs on the reference table.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX "NationalTimplanVersions_id_schoolForm_key"
    ON "NationalTimplanVersions"("id", "schoolForm");

-- ---------------------------------------------------------------------------
-- LocalTimplans
-- ---------------------------------------------------------------------------

CREATE TABLE "LocalTimplans" (
    "id"                       UUID                 NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"                 UUID                 NOT NULL,
    "name"                     TEXT                 NOT NULL,
    "schoolForm"               "SchoolForm"         NOT NULL,
    "nationalTimplanVersionId" UUID                 NOT NULL,
    "planningWeeks"            NUMERIC(4,1)         NOT NULL DEFAULT 35.6,
    "status"                   "LocalTimplanStatus" NOT NULL DEFAULT 'DRAFT',
    "decidedAt"                TIMESTAMPTZ(6),
    "decidedByUserId"          UUID,
    "decisionNote"             TEXT,
    "copiedFromId"             UUID,
    "createdAt"                TIMESTAMPTZ(6)       NOT NULL DEFAULT now(),
    "updatedAt"                TIMESTAMPTZ(6)       NOT NULL,

    CONSTRAINT "LocalTimplans_pkey" PRIMARY KEY ("id"),

    CONSTRAINT "LocalTimplans_name_is_sane" CHECK (
        "name" ~ '[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]' AND char_length("name") <= 100
    ),
    CONSTRAINT "LocalTimplans_planningWeeks_is_sane" CHECK (
        "planningWeeks" >= 20.0 AND "planningWeeks" <= 40.0
    ),
    -- All three null on a draft, all three set on a decided plan.
    CONSTRAINT "LocalTimplans_decision_is_whole" CHECK (
        ("decidedAt" IS NOT NULL)::int
        + ("decidedByUserId" IS NOT NULL)::int
        + ("decisionNote" IS NOT NULL)::int
        = CASE "status" WHEN 'DECIDED' THEN 3 ELSE 0 END
    ),
    CONSTRAINT "LocalTimplans_decisionNote_is_sane" CHECK (
        "decisionNote" IS NULL
        OR ("decisionNote" ~ '[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]' AND char_length("decisionNote") <= 500)
    ),
    CONSTRAINT "LocalTimplans_is_not_copied_from_itself" CHECK (
        "copiedFromId" IS NULL OR "copiedFromId" <> "id"
    )
);

CREATE UNIQUE INDEX "LocalTimplans_schoolId_name_key" ON "LocalTimplans"("schoolId", "name");
-- The target of every composite key below, entries' and the plan's own.
CREATE UNIQUE INDEX "LocalTimplans_id_schoolId_key" ON "LocalTimplans"("id", "schoolId");

ALTER TABLE "LocalTimplans"
    ADD CONSTRAINT "LocalTimplans_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LocalTimplans"
    ADD CONSTRAINT "LocalTimplans_nationalTimplanVersionId_schoolForm_fkey"
    FOREIGN KEY ("nationalTimplanVersionId", "schoolForm")
    REFERENCES "NationalTimplanVersions"("id", "schoolForm")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "LocalTimplans"
    ADD CONSTRAINT "LocalTimplans_decidedByUserId_schoolId_fkey"
    FOREIGN KEY ("decidedByUserId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "LocalTimplans"
    ADD CONSTRAINT "LocalTimplans_copiedFromId_schoolId_fkey"
    FOREIGN KEY ("copiedFromId", "schoolId") REFERENCES "LocalTimplans"("id", "schoolId")
    ON DELETE SET NULL ("copiedFromId") ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- LocalTimplanEntries
-- ---------------------------------------------------------------------------

CREATE TABLE "LocalTimplanEntries" (
    "id"             UUID    NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"       UUID    NOT NULL,
    "localTimplanId" UUID    NOT NULL,
    "subjectId"      UUID    NOT NULL,
    "gradeLevel"     INTEGER NOT NULL,
    "minutesPerWeek" INTEGER NOT NULL,
    -- "skolans val: +20 min från bild"
    "note"           TEXT,

    CONSTRAINT "LocalTimplanEntries_pkey" PRIMARY KEY ("id"),

    CONSTRAINT "LocalTimplanEntries_gradeLevel_is_sane" CHECK (
        "gradeLevel" BETWEEN 0 AND 10
    ),
    CONSTRAINT "LocalTimplanEntries_minutesPerWeek_is_sane" CHECK (
        "minutesPerWeek" BETWEEN 0 AND 1200
    ),
    CONSTRAINT "LocalTimplanEntries_note_is_sane" CHECK (
        "note" IS NULL OR char_length("note") <= 500
    )
);

CREATE UNIQUE INDEX "LocalTimplanEntries_localTimplanId_subjectId_gradeLevel_key"
    ON "LocalTimplanEntries"("localTimplanId", "subjectId", "gradeLevel");
-- The subject's side: the cascade from a deleted subject, and the subjects
-- service asking which plans contain a subject before it deletes one.
CREATE INDEX "LocalTimplanEntries_schoolId_subjectId_idx"
    ON "LocalTimplanEntries"("schoolId", "subjectId");

ALTER TABLE "LocalTimplanEntries"
    ADD CONSTRAINT "LocalTimplanEntries_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LocalTimplanEntries"
    ADD CONSTRAINT "LocalTimplanEntries_localTimplanId_schoolId_fkey"
    FOREIGN KEY ("localTimplanId", "schoolId") REFERENCES "LocalTimplans"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LocalTimplanEntries"
    ADD CONSTRAINT "LocalTimplanEntries_subjectId_schoolId_fkey"
    FOREIGN KEY ("subjectId", "schoolId") REFERENCES "Subjects"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- A decided plan is a record: the two triggers. See the preamble.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.local_timplans_keep_the_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  unpointed "LocalTimplans";
  principal uuid;
BEGIN
  -- How a decision is MADE. A signed-in writer (a JWT subject on the
  -- transaction: the gateway's withRls, or PostgREST) records a decision only
  -- as the DRAFT -> DECIDED transition, only in their own name, and at the
  -- database's now(). The owner with no subject (migrations, seed, the RLS
  -- fixtures) is not asked: it is not a person, and it writes no decision a
  -- person could be named in by mistake.
  IF (select auth.uid()) IS NOT NULL THEN
    principal := (select app.current_user_id());
    IF TG_OP = 'INSERT' THEN
      -- A plan is born a draft; createdAt is the database's.
      NEW."createdAt" := now();
      IF NEW."status" <> 'DRAFT' THEN
        RAISE EXCEPTION 'TIMPLAN_DECISION_IS_THE_CALLERS: lokal timplan "%" skapas som utkast och beslutas sedan', NEW."name"
          USING ERRCODE = 'TP403';
      END IF;
      RETURN NEW;
    END IF;
    NEW."createdAt" := OLD."createdAt";
    IF OLD."status" = 'DRAFT' AND NEW."status" = 'DECIDED' THEN
      IF principal IS NULL OR NEW."decidedByUserId" IS DISTINCT FROM principal THEN
        RAISE EXCEPTION 'TIMPLAN_DECISION_IS_THE_CALLERS: beslutet om lokal timplan "%" registreras i den inloggades namn', OLD."name"
          USING ERRCODE = 'TP403',
                DETAIL  = format('localTimplanId=%s', OLD."id");
      END IF;
      NEW."decidedAt" := now();
    END IF;
  END IF;

  IF TG_OP = 'INSERT' OR OLD."status" <> 'DECIDED' THEN
    RETURN NEW;
  END IF;

  -- The one UPDATE a decided plan admits: ON DELETE SET NULL ("copiedFromId")
  -- clearing the pointer to a source plan that is gone. Every other column
  -- must be exactly as it was.
  IF OLD."copiedFromId" IS NOT NULL AND NEW."copiedFromId" IS NULL THEN
    unpointed := OLD;
    unpointed."copiedFromId" := NULL;
    IF unpointed IS NOT DISTINCT FROM NEW
       AND NOT EXISTS (SELECT 1 FROM "LocalTimplans" WHERE "id" = OLD."copiedFromId") THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'TIMPLAN_IS_DECIDED: lokal timplan "%" är beslutad och kan inte ändras; öppna den igen som ett nytt utkast', OLD."name"
    USING ERRCODE = 'TP409',
          DETAIL  = format('localTimplanId=%s', OLD."id");
END
$$;

CREATE FUNCTION app.local_timplan_entries_refuse_decided() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  plan_ids   uuid[];
  school_ids uuid[];
  i          int;
  plan       record;
BEGIN
  -- An UPDATE has two parents to ask about when it moves an entry: the one it
  -- leaves and the one it joins. Either being decided refuses it. Each is
  -- looked up by the (id, schoolId) the entry row carries, as its composite
  -- key does, so a row naming another school's plan finds nothing here.
  IF TG_OP = 'INSERT' THEN
    plan_ids := ARRAY[NEW."localTimplanId"];
    school_ids := ARRAY[NEW."schoolId"];
  ELSIF TG_OP = 'DELETE' THEN
    plan_ids := ARRAY[OLD."localTimplanId"];
    school_ids := ARRAY[OLD."schoolId"];
  ELSE
    plan_ids := ARRAY[OLD."localTimplanId", NEW."localTimplanId"];
    school_ids := ARRAY[OLD."schoolId", NEW."schoolId"];
  END IF;

  FOR i IN 1 .. array_length(plan_ids, 1) LOOP
    SELECT p."id", p."name", p."status", p."schoolId"
      INTO plan
      FROM "LocalTimplans" p
     WHERE p."id" = plan_ids[i] AND p."schoolId" = school_ids[i]
       FOR SHARE;
    -- No parent: it is being deleted, and this is its cascade. Let it through.
    CONTINUE WHEN NOT FOUND;
    CONTINUE WHEN plan."status" <> 'DECIDED';
    -- A decided parent whose school is gone: the school is being torn down,
    -- and its subjects' cascade has reached the entries before its plans'.
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM "Schools" s WHERE s."id" = plan."schoolId");

    RAISE EXCEPTION 'TIMPLAN_IS_DECIDED: lokal timplan "%" är beslutad och dess poster kan inte ändras', plan."name"
      USING ERRCODE = 'TP409',
            DETAIL  = format('localTimplanId=%s', plan."id");
  END LOOP;

  -- An AFTER trigger's return value is ignored.
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION app.local_timplans_keep_the_record() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.local_timplan_entries_refuse_decided() FROM PUBLIC;

CREATE TRIGGER "LocalTimplans_keep_the_record"
    BEFORE INSERT OR UPDATE ON "LocalTimplans"
    FOR EACH ROW EXECUTE FUNCTION app.local_timplans_keep_the_record();

CREATE TRIGGER "LocalTimplanEntries_refuse_decided"
    AFTER INSERT OR UPDATE OR DELETE ON "LocalTimplanEntries"
    FOR EACH ROW EXECUTE FUNCTION app.local_timplan_entries_refuse_decided();

-- ---------------------------------------------------------------------------
-- Row-level security. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "LocalTimplans" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "local_timplans_admin_all" ON "LocalTimplans"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

CREATE POLICY "local_timplans_staff_select" ON "LocalTimplans"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) IN ('TEACHER', 'SCHOOL_ADMIN')
    );

CREATE POLICY "local_timplans_family_select" ON "LocalTimplans"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) IN ('STUDENT', 'GUARDIAN')
        AND "status" = 'DECIDED'
    );

ALTER TABLE "LocalTimplanEntries" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "local_timplan_entries_admin_all" ON "LocalTimplanEntries"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

CREATE POLICY "local_timplan_entries_staff_select" ON "LocalTimplanEntries"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) IN ('TEACHER', 'SCHOOL_ADMIN')
    );

CREATE POLICY "local_timplan_entries_family_select" ON "LocalTimplanEntries"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) IN ('STUDENT', 'GUARDIAN')
        AND EXISTS (
            SELECT 1 FROM "LocalTimplans" p
             WHERE p."id" = "LocalTimplanEntries"."localTimplanId"
               AND p."schoolId" = "LocalTimplanEntries"."schoolId"
               AND p."status" = 'DECIDED'
        )
    );

-- Guarded, as 20260930120000 explains: `app_authenticated` exists only in the
-- local compose database, and a bare GRANT would abort the deploy everywhere
-- else. Where the role is missing, "authenticated" is already covered by
-- 20260806000000's ALTER DEFAULT PRIVILEGES.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "LocalTimplans"       TO "app_authenticated";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "LocalTimplanEntries" TO "app_authenticated";
  END IF;
END
$$;
