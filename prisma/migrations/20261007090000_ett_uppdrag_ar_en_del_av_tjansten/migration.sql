-- Ett uppdrag är en del av tjänsten.
--
-- 20261006100000 gave a teacher a post and a list of what they may teach, and
-- the load report it feeds can say "Anna har 720 min undervisning mot ett mål
-- på 864". It cannot say why Anna's target is not her whole week: mentorskap
-- (the national median is 90 min/vecka), ämnesansvar, rastvakt, APT, VFU — the
-- work beside teaching that every leader models (Untis' Anrechnungen, Lectio's
-- tillæg, Göteborg's uppdragsbeskrivning) and that today exists nowhere. Nor
-- can it say that a row two teachers alternate on is half of each one's week,
-- because every requirement counts in full for whoever is named on it.
--
-- Fas 2 turns the read-only report into the place the fördelning is made, and
-- this is its data: two columns on TeachingRequirements, one on
-- StaffingPolicies, and the TeacherDuties table. Nothing here reaches the
-- solver except, through an existing row and an existing hard rule, a duty's
-- fixed slot (below). The migration is behaviour-neutral: every new column has
-- the default that reproduces today's arithmetic and today's generation.
--
-- ## TeachingRequirements: how much of a row counts, per teacher
--
-- Skola24's "Justera längd för lärare (%)", one per teacher column:
-- teacherLoadPercent for teacherId, coTeacherLoadPercent for coTeacherId. A row
-- counts lessonsPerWeek × minutesPerLesson × percent / 100 toward that teacher.
-- INTEGER NOT NULL DEFAULT 100, so every existing row counts exactly what it
-- counted before, and ADD COLUMN with a constant default rewrites no table
-- (PostgreSQL 11+ stores it in the catalog). CHECK 0..200 mirrors the DTO:
--
--   * 0 is legal and means something: a row a teacher is in the room for but
--     that the school does not count toward the post (an elevassistent's slot
--     a teacher shadows, a co-teacher who is there to learn).
--   * 200 is the ceiling the design names: an APL-split or a heavy
--     förberedelse row Skola24 counts at 196 %. Above it is a typo — a row
--     that counts for more than two of itself.
--
-- Columns rather than a join table, so the (school, year, group, subject) slot
-- and the solver's payload stay untouched: the proxy never sends these two, and
-- ai-engine-contract.spec.ts asserts it. Both columns are kept even when their
-- teacher column is NULL, so that naming a teacher later inherits the
-- percentage the row was planned at rather than resetting it.
--
-- No RLS work on this table: its policies are row predicates on schoolId and a
-- role, none names a column (20260930090000's reasoning, unchanged).
--
-- ## StaffingPolicies.unstaffedGeneration
--
-- ALLOW | REFUSE, NOT NULL DEFAULT 'ALLOW'. REFUSE makes starting a timetable
-- run with any teacherless requirement in the year a named refusal
-- (STAFF_UNSTAFFED_REQUIREMENTS) instead of today's silent placement of a
-- lesson nobody teaches. Its own two-valued enum, not StaffingCheckMode: there
-- is no WARN that means anything here — the generate page shows the count
-- either way — and a third value nobody can explain is a value somebody sets.
-- Default ALLOW for the reason 20261006100000 defaults its two modes to WARN:
-- a deploy that turned REFUSE on would stop every school's next run at once.
--
-- ## TeacherDuties: per läsår, per teacher, HR data
--
-- Per year, like TeacherEmployments and for its reason: the uppdrag are
-- negotiated with the post, every spring, for the year. Columns:
--
--   * kind: the Göteborg checkboxes plus what every school has — MENTORSKAP,
--     AMNESANSVAR, FORSTELARARE, RASTVAKT, PEDAGOGISK_LUNCH, APT_KONFERENS,
--     VFU_HANDLEDNING, APL, ANNAT. An enum and not free text, because the
--     report groups by it and Fas 3's SS12000 export maps it.
--   * label: what the school calls it, "Mentor 7B". Non-blank and at most 80
--     characters, by the CHECK P1's review settled on: "non-blank" is the
--     DTO's /\S/ written out as the character class JavaScript's \s matches,
--     not btrim(), which strips spaces only and let one tab or one NBSP
--     through as a name.
--   * minutesPerWeek 1..2400: 0 minutes is not an uppdrag, and 2400 is the
--     ceiling every per-week column in 20261006100000 shares (40 hours of it).
--   * countsAsTeaching, default false: whether the minutes consume the teaching
--     target (pedagogisk lunch or resurstid a school chooses to count) or are
--     reported beside it. Default false because the agreement's undervisningstid
--     is teaching, and counting an uppdrag as teaching is the school's choice.
--   * subjectId? (ämnesansvar) and studentGroupId? (mentorskap): optional
--     links, ON DELETE SET NULL of that column only. A mentor's class deleted
--     at the end of the year, or a subject removed, must not delete the duty:
--     the minutes are still worked and still in the year's report, and the
--     label still says what it was. CASCADE would change a teacher's load as a
--     side effect of tidying the subject list.
--   * note? at most 500, as every note here.
--
-- No unique key on (teacher, year, kind): a teacher can be mentor for two
-- groups and rastvakt twice a week. The index is the per-year, per-teacher
-- listing's: (schoolId, academicYearId, userId).
--
-- ## A duty's fixed slot is an existing constraint, and the DB guards the link
--
-- APT on Tuesdays 15:00-17:00 must keep the solver out of that slot. It does
-- not get a new rule for it: the gateway creates an ordinary UNAVAILABLE
-- TEACHER AvailabilityConstraint in the same transaction as the duty, and
-- stores its id in blockedConstraintId. The engine already refuses that by
-- name, receives it anonymised as every other constraint, and learns nothing
-- about duties. The client never supplies the id.
--
-- But "the service creates it" is no guarantee to a writer who never meets the
-- service. An admin's own Supabase key reaches both tables through PostgREST,
-- and without a guard could point a duty at a ROOM's constraint, at a
-- colleague's, at a PREFERRED_FREE wish, or at a one-off date — and the load
-- report and the drawer would then present somebody else's time as this
-- teacher's blocked uppdrag. A CHECK sees one row and this is a fact about
-- another table, so it is two triggers, both raising SQLSTATE 'TD409' with a
-- message that starts TEACHER_DUTY_BLOCK_MISMATCH:
--
--   * AFTER INSERT OR UPDATE ON "TeacherDuties": when blockedConstraintId is
--     set, the constraint found by (blockedConstraintId, schoolId) must be
--     resourceType TEACHER, type UNAVAILABLE, for the duty's own userId, and
--     weekly (dayOfWeek set, date NULL) — the shape blockedSlot {dayOfWeek,
--     startTime, endTime} reads back from. A row that finds no constraint by
--     that pair is left to the composite foreign key, whose 23503 says nothing
--     about the other school; AFTER, not BEFORE, so that the trigger only ever
--     sees rows that passed RLS WITH CHECK (20261006120000's lesson: a BEFORE
--     ROW trigger runs ahead of WITH CHECK and answers rows stamped with
--     another school). It reads the constraint FOR SHARE, so a concurrent
--     UPDATE moving that constraint to another teacher either commits first
--     and is seen, or waits for this transaction and meets the second trigger.
--   * BEFORE UPDATE ON "AvailabilityConstraints": a constraint a duty links to
--     must keep that shape — the same four facts against the linking duty's
--     userId. Without this the first trigger is one PATCH away from
--     meaningless: link a valid constraint, then move it. BEFORE is safe here
--     for the reason the plan trigger in 20261006120000 gives: an UPDATE only
--     reaches rows the caller's USING admits, so OLD is the caller's own row,
--     and the linking duty is looked up by (OLD.id, OLD.schoolId).
--
-- And one refusal of its own, SQLSTATE 'TD403', TEACHER_DUTY_BLOCK_IS_THE_ADMINS:
-- a TEACHER may not UPDATE or DELETE a constraint a duty links to.
-- availability_teacher_modify (20260821150000) lets a teacher write their own
-- TEACHER rows, which is right for "jag är ledig på fredagar" and wrong for
-- the APT slot the employer placed: that slot is part of the duty, the duty is
-- the admin's (a teacher has no write arm on TeacherDuties), and a teacher who
-- deleted it would free Tuesday afternoon for the solver while the drawer still
-- reported the block. Their other constraints are untouched by this. An admin
-- may delete a linked constraint; the foreign key's ON DELETE SET NULL
-- ("blockedConstraintId") then clears the pointer and nothing else — the
-- column-list form (PostgreSQL 15+; 20260822130000's teacherId is the
-- precedent), because a plain SET NULL on a composite key would null schoolId
-- too, which is NOT NULL, and the delete would fail.
--
-- And a slot goes with its uppdrag, by a third trigger rather than by the
-- service alone: AFTER DELETE ON "TeacherDuties" deletes the constraint the
-- deleted row linked to, by (blockedConstraintId, schoolId). The service
-- deletes both in one transaction, but a duty also leaves through the year's
-- cascade — DELETE /academic-years/:id is a plain tx.academicYear.delete, and
-- (academicYearId, schoolId) is ON DELETE CASCADE — through the person's, and
-- through PostgREST. Each of those used to leave a weekly UNAVAILABLE TEACHER
-- row that no uppdrag showed any more and that TD403 no longer guarded: the
-- teacher stayed blocked in every later generation for a duty nobody could
-- see. AFTER, so the trigger only runs for a row the caller's DELETE was
-- allowed to remove; the constraint's own BEFORE DELETE trigger then finds no
-- duty linking it (the statement's own delete is visible to it) and lets it
-- go, and the foreign key's SET NULL has no duty left to touch. When the
-- person's cascade reaches the constraint first, the delete here finds
-- nothing, which is no error.
--
-- The gateway never meets TD409 on its own paths (it creates the constraint
-- itself), but its generic constraint PATCH can: an admin changing a linked
-- constraint's teacher or kind through /availability-constraints. So
-- rethrowPrismaError maps TD409 to a 409 and TD403 to a 403, the same way it
-- maps TP409, and the adapter probe proves both through the real adapter.
--
-- The three triggers are SECURITY DEFINER, owned by the migration owner, for
-- 20261006120000's reason: "the linked row is a TEACHER/UNAVAILABLE row for
-- this user" must be the fact, not what the writer's RLS lets them see. They
-- live in "app", beside the identity helpers and out of PostgREST's function
-- listing, with EXECUTE taken from PUBLIC; a trigger function is fired, never
-- called. Their messages name no person and no label — ids in DETAIL only —
-- because a refusal is logged.
--
-- A constraint is linked from at most one duty: UNIQUE (blockedConstraintId,
-- schoolId) — the pair Prisma needs to call the relation one-to-one, and as
-- strict as UNIQUE (blockedConstraintId), since an id has one school. It is
-- also the index the SET NULL and the constraint trigger look duties up by.
-- The composite target needs AvailabilityConstraints UNIQUE (id, schoolId),
-- redundant as an index and load-bearing as a key, as NationalTimplanVersions'
-- (id, schoolForm) is in 20261006120000.
--
-- ## Keys
--
-- Every tenant reference is composite, (x, schoolId) -> (id, schoolId), for the
-- reason every child table here has one: referential checks run as the
-- referenced table's owner with row security off, so a plain id would accept
-- another school's teacher, year, subject, class or constraint under a row
-- honestly stamped with this school's id.
--
--   * (userId, schoolId) -> Users, ON DELETE CASCADE: a person deleted takes
--     their uppdrag with them, as their post goes.
--   * (academicYearId, schoolId) -> AcademicYears, ON DELETE CASCADE.
--   * (subjectId, schoolId) -> Subjects, (studentGroupId, schoolId) ->
--     StudentGroups, (blockedConstraintId, schoolId) -> AvailabilityConstraints:
--     ON DELETE SET NULL of that column alone, as above.
--
-- ## Row-level security: three arms, and the second is narrow
--
--   * teacher_duties_admin_all: the school's SCHOOL_ADMIN, FOR ALL. The only
--     writer.
--   * teacher_duties_teacher_own_select: a TEACHER reads their OWN duties and no
--     colleague's. An uppdrag carries minutes that explain a post's reduction —
--     förstelärare, a mentorship that was negotiated — and is HR data in the
--     same sense as the post itself; this is TeacherEmployments' arm, not
--     TeacherWorkRules' staff_select, and the RLS suite asserts the count.
--     FOR SELECT only: an uppdrag is assigned, not claimed.
--   * teacher_duties_service_select: the service principal, by its school, for
--     Fas 3's SS12000 /duties feed — 20260914150000's one-liner, no TO clause.
--
-- The role check sits in USING as well as WITH CHECK (section 7's reason:
-- WITH CHECK alone stops a writer authoring a row and leaves them able to
-- DELETE one). Pupils and guardians have no arm.

-- ---------------------------------------------------------------------------
-- TeachingRequirements: the two load percentages
-- ---------------------------------------------------------------------------

ALTER TABLE "TeachingRequirements"
    ADD COLUMN "teacherLoadPercent" INTEGER NOT NULL DEFAULT 100;

ALTER TABLE "TeachingRequirements"
    ADD COLUMN "coTeacherLoadPercent" INTEGER NOT NULL DEFAULT 100;

ALTER TABLE "TeachingRequirements"
    ADD CONSTRAINT "TeachingRequirements_teacher_load_percent_is_sane"
    CHECK ("teacherLoadPercent" BETWEEN 0 AND 200);

ALTER TABLE "TeachingRequirements"
    ADD CONSTRAINT "TeachingRequirements_co_teacher_load_percent_is_sane"
    CHECK ("coTeacherLoadPercent" BETWEEN 0 AND 200);

-- ---------------------------------------------------------------------------
-- StaffingPolicies.unstaffedGeneration
-- ---------------------------------------------------------------------------

CREATE TYPE "UnstaffedGenerationMode" AS ENUM ('ALLOW', 'REFUSE');

ALTER TABLE "StaffingPolicies"
    ADD COLUMN "unstaffedGeneration" "UnstaffedGenerationMode" NOT NULL DEFAULT 'ALLOW';

-- ---------------------------------------------------------------------------
-- The composite target the duty's slot link needs.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX "AvailabilityConstraints_id_schoolId_key"
    ON "AvailabilityConstraints"("id", "schoolId");

-- ---------------------------------------------------------------------------
-- TeacherDuties
-- ---------------------------------------------------------------------------

CREATE TYPE "TeacherDutyKind" AS ENUM (
    'MENTORSKAP',
    'AMNESANSVAR',
    'FORSTELARARE',
    'RASTVAKT',
    'PEDAGOGISK_LUNCH',
    'APT_KONFERENS',
    'VFU_HANDLEDNING',
    'APL',
    'ANNAT'
);

CREATE TABLE "TeacherDuties" (
    "id"                  UUID              NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"            UUID              NOT NULL,
    "userId"              UUID              NOT NULL,
    "academicYearId"      UUID              NOT NULL,
    "kind"                "TeacherDutyKind" NOT NULL,
    "label"               TEXT              NOT NULL,
    "minutesPerWeek"      INTEGER           NOT NULL,
    "countsAsTeaching"    BOOLEAN           NOT NULL DEFAULT false,
    "subjectId"           UUID,
    "studentGroupId"      UUID,
    "blockedConstraintId" UUID,
    "note"                TEXT,
    "createdAt"           TIMESTAMPTZ(6)    NOT NULL DEFAULT now(),
    "updatedAt"           TIMESTAMPTZ(6)    NOT NULL,

    CONSTRAINT "TeacherDuties_pkey" PRIMARY KEY ("id"),

    CONSTRAINT "TeacherDuties_label_is_sane" CHECK (
        "label" ~ '[^\t\n\v\f\r    -     　﻿]'
        AND char_length("label") <= 80
    ),
    CONSTRAINT "TeacherDuties_minutesPerWeek_is_sane" CHECK (
        "minutesPerWeek" BETWEEN 1 AND 2400
    ),
    CONSTRAINT "TeacherDuties_note_is_sane" CHECK (
        "note" IS NULL OR char_length("note") <= 500
    )
);

CREATE INDEX "TeacherDuties_schoolId_academicYearId_userId_idx"
    ON "TeacherDuties"("schoolId", "academicYearId", "userId");
-- One duty per constraint; see the preamble.
CREATE UNIQUE INDEX "TeacherDuties_blockedConstraintId_schoolId_key"
    ON "TeacherDuties"("blockedConstraintId", "schoolId");

ALTER TABLE "TeacherDuties"
    ADD CONSTRAINT "TeacherDuties_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TeacherDuties"
    ADD CONSTRAINT "TeacherDuties_userId_schoolId_fkey"
    FOREIGN KEY ("userId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TeacherDuties"
    ADD CONSTRAINT "TeacherDuties_academicYearId_schoolId_fkey"
    FOREIGN KEY ("academicYearId", "schoolId") REFERENCES "AcademicYears"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TeacherDuties"
    ADD CONSTRAINT "TeacherDuties_subjectId_schoolId_fkey"
    FOREIGN KEY ("subjectId", "schoolId") REFERENCES "Subjects"("id", "schoolId")
    ON DELETE SET NULL ("subjectId") ON UPDATE NO ACTION;

ALTER TABLE "TeacherDuties"
    ADD CONSTRAINT "TeacherDuties_studentGroupId_schoolId_fkey"
    FOREIGN KEY ("studentGroupId", "schoolId") REFERENCES "StudentGroups"("id", "schoolId")
    ON DELETE SET NULL ("studentGroupId") ON UPDATE NO ACTION;

ALTER TABLE "TeacherDuties"
    ADD CONSTRAINT "TeacherDuties_blockedConstraintId_schoolId_fkey"
    FOREIGN KEY ("blockedConstraintId", "schoolId") REFERENCES "AvailabilityConstraints"("id", "schoolId")
    ON DELETE SET NULL ("blockedConstraintId") ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- The link guard: the two triggers, and the third that clears up. See the preamble.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.teacher_duties_block_is_the_teachers() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  blocked record;
BEGIN
  IF NEW."blockedConstraintId" IS NULL THEN
    RETURN NULL;
  END IF;

  -- By the pair the composite key matches on: a row naming another school's
  -- constraint finds nothing here and is the foreign key's to refuse.
  SELECT c."resourceType", c."type", c."userId", c."dayOfWeek", c."date"
    INTO blocked
    FROM "AvailabilityConstraints" c
   WHERE c."id" = NEW."blockedConstraintId" AND c."schoolId" = NEW."schoolId"
     FOR SHARE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF blocked."resourceType" <> 'TEACHER'
     OR blocked."type" <> 'UNAVAILABLE'
     OR blocked."userId" IS DISTINCT FROM NEW."userId"
     OR blocked."dayOfWeek" IS NULL
     OR blocked."date" IS NOT NULL THEN
    RAISE EXCEPTION 'TEACHER_DUTY_BLOCK_MISMATCH: ett uppdrags blockerade tid är en återkommande otillgänglighet för uppdragets egen lärare'
      USING ERRCODE = 'TD409',
            DETAIL  = format('teacherDutyId=%s availabilityConstraintId=%s', NEW."id", NEW."blockedConstraintId");
  END IF;

  -- An AFTER trigger's return value is ignored.
  RETURN NULL;
END
$$;

CREATE FUNCTION app.availability_constraints_keep_duty_blocks() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  duty record;
BEGIN
  SELECT d."id", d."userId"
    INTO duty
    FROM "TeacherDuties" d
   WHERE d."blockedConstraintId" = OLD."id" AND d."schoolId" = OLD."schoolId";
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  -- The slot is the duty's, and the duty is the admin's.
  IF (select app.current_user_role()) = 'TEACHER' THEN
    RAISE EXCEPTION 'TEACHER_DUTY_BLOCK_IS_THE_ADMINS: tiden är blockerad av ett uppdrag och ändras genom uppdraget'
      USING ERRCODE = 'TD403',
            DETAIL  = format('teacherDutyId=%s availabilityConstraintId=%s', duty."id", OLD."id");
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- An admin's delete; ON DELETE SET NULL ("blockedConstraintId") clears
    -- the duty's pointer and nothing else.
    RETURN OLD;
  END IF;

  IF NEW."resourceType" <> 'TEACHER'
     OR NEW."type" <> 'UNAVAILABLE'
     OR NEW."userId" IS DISTINCT FROM duty."userId"
     OR NEW."dayOfWeek" IS NULL
     OR NEW."date" IS NOT NULL THEN
    RAISE EXCEPTION 'TEACHER_DUTY_BLOCK_MISMATCH: tiden är blockerad av ett uppdrag och förblir en återkommande otillgänglighet för uppdragets lärare'
      USING ERRCODE = 'TD409',
            DETAIL  = format('teacherDutyId=%s availabilityConstraintId=%s', duty."id", OLD."id");
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION app.teacher_duties_take_their_block() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF OLD."blockedConstraintId" IS NOT NULL THEN
    DELETE FROM "AvailabilityConstraints"
     WHERE "id" = OLD."blockedConstraintId" AND "schoolId" = OLD."schoolId";
  END IF;
  -- An AFTER trigger's return value is ignored.
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION app.teacher_duties_block_is_the_teachers() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.availability_constraints_keep_duty_blocks() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.teacher_duties_take_their_block() FROM PUBLIC;

CREATE TRIGGER "TeacherDuties_block_is_the_teachers"
    AFTER INSERT OR UPDATE ON "TeacherDuties"
    FOR EACH ROW EXECUTE FUNCTION app.teacher_duties_block_is_the_teachers();

CREATE TRIGGER "TeacherDuties_take_their_block"
    AFTER DELETE ON "TeacherDuties"
    FOR EACH ROW EXECUTE FUNCTION app.teacher_duties_take_their_block();

CREATE TRIGGER "AvailabilityConstraints_keep_duty_blocks"
    BEFORE UPDATE OR DELETE ON "AvailabilityConstraints"
    FOR EACH ROW EXECUTE FUNCTION app.availability_constraints_keep_duty_blocks();

-- ---------------------------------------------------------------------------
-- Row-level security. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "TeacherDuties" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "teacher_duties_admin_all" ON "TeacherDuties"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

-- Their own duties, read only. app.current_user_id() is NULL for anybody
-- without an active Users row, and "userId" = NULL matches nothing.
CREATE POLICY "teacher_duties_teacher_own_select" ON "TeacherDuties"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) = 'TEACHER'
        AND "userId" = (select app.current_user_id())
    );

CREATE POLICY "teacher_duties_service_select" ON "TeacherDuties"
    FOR SELECT
    USING ("schoolId" = app.current_service_school_id());

-- Guarded, as 20260930120000 explains: `app_authenticated` exists only in the
-- local compose database, and a bare GRANT would abort the deploy everywhere
-- else. Where the role is missing, "authenticated" is already covered by
-- 20260806000000's ALTER DEFAULT PRIVILEGES.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "TeacherDuties" TO "app_authenticated";
  END IF;
END
$$;
