-- En lokal timplan gäller ett årskurspann.
--
-- A lokal timplan was checked against a WHOLE school form: bilaga 1 prints
-- 6 890 h for årskurs 1–9, and a school that is a 4–9 school was told that the
-- 1 882 h of lågstadiet it does not teach were taken from skolans val (a pool
-- of 600), that three protected subjects were reduced there, that seven cells
-- were cut past the cap and that its total was 1 863 h short of the guarantee:
-- twelve warnings for a correct plan, and none it could silence. An F–5 school
-- got 25 and a 6–9 school 23.
--
-- So the plan states which årskurser it is for:
--
--   * LocalTimplans."gradeFrom" and "gradeTo", two nullable integers, in the
--     numbering of the plan's lydelse (the numbering of its national version:
--     the tioårig grundskola of SFS 2025:729 counts 1–10, every older lydelse
--     0–9, specialskolan to 10 and, from 2028, 11). Both or neither, 0..11 and
--     from <= to; NULL is the whole school form, which is what every plan was
--     until now and what every existing row keeps: nothing is backfilled and
--     nothing about an existing plan's check moves.
--
-- A SPAN, not a tick per stadium, because stadium ticks cannot say F–5 or 6–9:
-- those schools hold part of a stadium. What the check then does with a stadium
-- the span lacks, holds whole and holds in part is src/common/timplan-coverage.ts'
-- argument (and the user's decision of 2026-11-03); the database holds the
-- facts only. The verdict depends on the plan and the statute and on nothing
-- else, so a teacher, who cannot read SchoolUnits, gets the admin's verdict.
--
-- ## A decided plan gets its span ONCE
--
-- Every plan that exists is NULL, and the plans that are DECIDED are records:
-- LocalTimplans_keep_the_record (20261006120000) refuses every change to one
-- but the foreign key clearing "copiedFromId". A school with a decided 4–9 plan
-- would then have to reopen it, copy it and have the huvudman decide the same
-- minutes again, to say which årskurser they were for. So the trigger admits
-- exactly one more UPDATE of a decided plan, in the manner of the
-- "copiedFromId" exception:
--
--   * OLD has no span (both NULL) and NEW has one (both set);
--   * every other column is exactly as it was, but for "updatedAt" (Prisma sets
--     it on every update; it is the plan's modification time, not content) and
--     the two stamps below;
--   * the minutes cannot move: they are LocalTimplanEntries, whose own trigger
--     refuses every write under a decided plan, and this migration does not
--     touch it.
--
-- A second change is refused as any change to a decided plan is (TP409,
-- TIMPLAN_IS_DECIDED): a span that has been set on a decided plan, or that
-- the plan was decided with, changes only by "Öppna igen". NEW with no span, or
-- a NULL set again, is a change like any other.
--
-- ## Who and when
--
-- A record that says "decided by X on D" is only a record if X and D are facts,
-- and a span set afterwards is a change to the record that must be as
-- attributable. LocalTimplans has no log of its own, and the decision fields
-- are whole and belong to the decision (all null on a draft, all set on a
-- decided plan, by CHECK), so they cannot say who set the span or when. Two
-- columns do:
--
--   * "gradeSpanSetAt" and "gradeSpanSetByUserId", both NULL or both set, and
--     set only on a DECIDED plan that has a span (CHECK). They are written by
--     the trigger, not by a writer: whenever the transaction carries a JWT
--     subject (the gateway's withRls, or PostgREST) the trigger overwrites
--     them with now() and app.current_user_id(), as it does "decidedAt", and
--     a writer with a subject and no user is refused (TP403,
--     TIMPLAN_DECISION_IS_THE_CALLERS). The owner with no subject (migrations,
--     the seed, the RLS fixtures) is not a person; it must state both stamps.
--     A DRAFT never carries them, and a subject-bearing writer cannot forge
--     them on an INSERT or at the DRAFT -> DECIDED transition: the trigger
--     clears them there, so a span chosen before the decision is covered by the
--     decision's own stamps and one chosen after it is covered by these.
--   * The user key is the decider's: (id, schoolId) with ON DELETE RESTRICT, so
--     the record keeps the name and the gateway's user deletion asks first
--     (users.service, which names the plans and the way out).
--
-- Reopening or copying a plan copies the span and nothing of the stamps: the
-- new draft is a new proposal, and the span is part of what it proposes.
--
-- ## Beside the live API
--
-- Additive: four nullable columns, four named CHECKs and one foreign key on
-- one table, and a trigger function replaced with its old behaviour intact.
-- Checked against the API that serves before this (origin/main,
-- src/timplan/local-timplans.service.ts, src/year-rollover, src/import):
--
--   * Its create names neither span column, so its INSERT leaves both NULL;
--     its update names name, weeks and version only; its copy and reopen write
--     a plan without a span, so a plan copied by the API before this loses its
--     source's span (there are none yet). Its reads select the columns of its
--     own schema and never read these.
--   * The trigger changes nothing for a statement that does not touch the
--     span: an UPDATE of a decided plan that leaves both NULL is refused as
--     before, and the "copiedFromId" exception is the same code.
--
-- The API after this reads and writes them, so this runs first.
--
-- ## Locks
--
-- ADD COLUMN takes LocalTimplans ACCESS EXCLUSIVE for a moment, and the foreign
-- key takes the referenced Users SHARE ROW EXCLUSIVE (the CHECKs and the key
-- scan LocalTimplans' few rows; nothing is rewritten). A waiting ACCESS
-- EXCLUSIVE queues every reader of the plans behind it, and a request that
-- holds a Users row (an e-mail change locks it FOR UPDATE) and then touches the
-- plans closes a cycle with a migration that took one and waited for the other.
-- No order of the two LOCKs avoids both directions, so both are taken first,
-- NOWAIT and together: a refusal rolls the subtransaction back and with it
-- whatever it got, and it tries again 50 ms later. It never waits while it holds
-- a lock. After 30 s of refusals it stops with nothing done and can be rerun
-- (prisma migrate resolve --rolled-back, then deploy). lock_timeout bounds any
-- wait nobody foresaw.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "LocalTimplans" IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Users" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'LocalTimplans and Users were not free at once in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

ALTER TABLE "LocalTimplans"
    ADD COLUMN "gradeFrom"            INTEGER,
    ADD COLUMN "gradeTo"              INTEGER,
    ADD COLUMN "gradeSpanSetAt"       TIMESTAMPTZ(6),
    ADD COLUMN "gradeSpanSetByUserId" UUID,
    ADD CONSTRAINT "LocalTimplans_gradeSpan_is_a_pair" CHECK (
        ("gradeFrom" IS NULL) = ("gradeTo" IS NULL)
    ),
    ADD CONSTRAINT "LocalTimplans_gradeSpan_is_sane" CHECK (
        "gradeFrom" IS NULL
        OR ("gradeFrom" BETWEEN 0 AND 11 AND "gradeTo" BETWEEN 0 AND 11 AND "gradeFrom" <= "gradeTo")
    ),
    ADD CONSTRAINT "LocalTimplans_gradeSpanSet_is_whole" CHECK (
        ("gradeSpanSetAt" IS NULL) = ("gradeSpanSetByUserId" IS NULL)
    ),
    ADD CONSTRAINT "LocalTimplans_gradeSpanSet_follows_a_decision" CHECK (
        "gradeSpanSetAt" IS NULL OR ("status" = 'DECIDED' AND "gradeFrom" IS NOT NULL)
    ),
    ADD CONSTRAINT "LocalTimplans_gradeSpanSetByUserId_schoolId_fkey"
        FOREIGN KEY ("gradeSpanSetByUserId", "schoolId") REFERENCES "Users"("id", "schoolId")
        ON DELETE RESTRICT ON UPDATE RESTRICT;

COMMENT ON COLUMN "LocalTimplans"."gradeFrom" IS
  'The first årskurs the plan is for, in the numbering of its lydelse (0 = förskoleklass; the tioårig grundskola counts 1–10). Both gradeFrom and gradeTo or neither; NULL = the whole school form. A decided plan gets it once (the keep_the_record trigger), stamped in gradeSpanSetAt/gradeSpanSetByUserId.';
COMMENT ON COLUMN "LocalTimplans"."gradeTo" IS
  'The last årskurs the plan is for (0..11, >= gradeFrom). See gradeFrom.';
COMMENT ON COLUMN "LocalTimplans"."gradeSpanSetAt" IS
  'When the span was set on a plan that was already DECIDED; null for a span chosen with the draft. Written by the keep_the_record trigger, never by a writer with a JWT subject.';
COMMENT ON COLUMN "LocalTimplans"."gradeSpanSetByUserId" IS
  'Who set the span on a plan that was already DECIDED; null for a span chosen with the draft. ON DELETE RESTRICT, as decidedByUserId.';

-- ---------------------------------------------------------------------------
-- The record, and its one exception more. This is 20261006120000's function
-- with two additions: a draft and an insert carry no span stamp (the lines that
-- clear them), and the span exception below "copiedFromId"'s. Nothing else is
-- different from it.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.local_timplans_keep_the_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  unpointed "LocalTimplans";
  spanned   "LocalTimplans";
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
      -- The span stamps are the once-only setter's, never an insert's.
      NEW."gradeSpanSetAt" := NULL;
      NEW."gradeSpanSetByUserId" := NULL;
      RETURN NEW;
    END IF;
    NEW."createdAt" := OLD."createdAt";
    IF OLD."status" = 'DRAFT' THEN
      -- A draft, and the transition that decides it, carries no stamp of a span
      -- set afterwards: the decision's own stamps cover the span it was decided
      -- with.
      NEW."gradeSpanSetAt" := NULL;
      NEW."gradeSpanSetByUserId" := NULL;
    END IF;
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

  -- The span. A decided plan that has none gets one, once: both columns set,
  -- stamped with who and when, and nothing else different (the plan's
  -- "updatedAt" aside). A plan that already has a span, or that is changed in
  -- any other way, falls through to the refusal below.
  IF OLD."gradeFrom" IS NULL AND OLD."gradeTo" IS NULL
     AND NEW."gradeFrom" IS NOT NULL AND NEW."gradeTo" IS NOT NULL THEN
    IF (select auth.uid()) IS NOT NULL THEN
      IF principal IS NULL THEN
        RAISE EXCEPTION 'TIMPLAN_DECISION_IS_THE_CALLERS: årskurspannet för lokal timplan "%" registreras i den inloggades namn', OLD."name"
          USING ERRCODE = 'TP403',
                DETAIL  = format('localTimplanId=%s', OLD."id");
      END IF;
      NEW."gradeSpanSetAt" := now();
      NEW."gradeSpanSetByUserId" := principal;
    END IF;
    spanned := OLD;
    spanned."gradeFrom" := NEW."gradeFrom";
    spanned."gradeTo" := NEW."gradeTo";
    spanned."gradeSpanSetAt" := NEW."gradeSpanSetAt";
    spanned."gradeSpanSetByUserId" := NEW."gradeSpanSetByUserId";
    spanned."updatedAt" := NEW."updatedAt";
    IF spanned IS NOT DISTINCT FROM NEW
       AND NEW."gradeSpanSetAt" IS NOT NULL
       AND NEW."gradeSpanSetByUserId" IS NOT NULL THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'TIMPLAN_IS_DECIDED: lokal timplan "%" är beslutad och kan inte ändras; öppna den igen som ett nytt utkast', OLD."name"
    USING ERRCODE = 'TP409',
          DETAIL  = format('localTimplanId=%s', OLD."id");
END
$$;
