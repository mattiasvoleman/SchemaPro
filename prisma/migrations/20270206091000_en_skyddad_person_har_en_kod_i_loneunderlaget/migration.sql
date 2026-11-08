-- En skyddad person har en kod i löneunderlaget.
--
-- Löneunderlaget (K1) names a person with a protected identity by signature
-- and Löne-id, never by name or e-mail (#290). A marked person without a
-- Löne-id (no number on the post yet, or no post at all: a vikarie of the
-- pool) would be a row of figures that nobody can tell from another marked
-- person's. This table gives every marked person a code of their own, which
-- the file writes as SKYDDAD-<number> in the Löne-id column, and which the
-- page, for the readers of HR data it is for, resolves to the person's name
-- on the screen alone. Which code is whom stays in Rastra.
--
--   * PayrollPseudonyms   (schoolId, userId) -> number. The number is an
--     identity column: drawn once from one sequence for all schools, never
--     chosen by a writer and never reused, so a code is the same in every
--     file, whatever order the file is in, and says nothing of the name.
--
-- ## The mark writes it
--
-- A code is written by the database when a person is marked and removed when
-- the person's last mark is (the trigger PersonProtections_payroll_pseudonym,
-- SECURITY DEFINER), so the table holds exactly the school's marked persons,
-- as PersonProtections does, and keeps no history of a mark that is gone: a
-- mark lifted and set again gives a new code, and in between the person was
-- named. The marks that exist are given theirs here, in the order of school
-- and person. The API's role reads the table and writes nothing (no grant):
-- the löneunderlag only reads, and no GET writes a row.
--
-- A pseudonym's mark is removed by app.gallring_pseudonymise, and with it the
-- code: a code beside a pseudonymised row would tie the row to the person the
-- payroll office still knows by it. A person and a school removed take their
-- codes with them (the keys cascade).
--
-- ## One transaction at a time, for a person
--
-- The trigger locks the person's Users row (FOR NO KEY UPDATE, which the
-- foreign key's KEY SHARE does not wait for) before it looks at the person's
-- marks, in both branches. Without it the register's mark set while an
-- administrator removes theirs leaves the mark and no code, silently and for
-- good: the insert finds the code there and keeps it, and the delete, which
-- cannot see the insert's uncommitted mark, finds no mark left and removes the
-- code. With it the second waits for the first and then sees what it did. Not
-- an advisory lock: one held across the insert's foreign-key check deadlocks
-- against a writer that holds the Users row and waits for it.
--
-- ## A pseudonym's versions lose the number too
--
-- The versions of a post (TeacherEmploymentLogs) carry the whole row, the
-- payroll number with it (20270206090000), and they stay until the school's
-- change logs are purged. app.gallring_pseudonymise now sets the number to
-- null in a pseudonym's versions as it clears it on the post, and the log's
-- append-only guard lets gallring make that one change and no other: the
-- number set to null in before and after, every other key and column as it
-- was. Outside gallring a version is still never changed.
--
-- ## Who reads
--
-- Every administrator of the school reads, as every administrator reads the
-- marks themselves (person_protections_admin_select): a code tells nothing
-- the mark does not. What a reader is HANDED is narrower and the gateway's:
-- the löneunderlag goes to the readers of HR data only (src/analysis).
--
-- ## Beside the live API: three tables at once, or nothing
--
-- The two keys (-> Schools, -> Users) take Schools and Users in SHARE ROW
-- EXCLUSIVE, and so does the trigger on PersonProtections; that blocks
-- writes to the three (not reads, and not the KEY SHARE a foreign-key check
-- takes) for the length of the file, and keeps a mark from being set between
-- the codes given here and the trigger that gives the next. The locks are
-- taken together, NOWAIT, in a loop: a refusal rolls the subtransaction back
-- with every lock it got and tries again 50 ms later, so the migration never
-- waits while it holds a lock. After 30 s it stops with nothing done.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Schools", "Users", "PersonProtections" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Schools, Users and PersonProtections were not free in 30 s: nothing is changed (prisma migrate resolve --rolled-back 20270206091000_en_skyddad_person_har_en_kod_i_loneunderlaget, then deploy)';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

CREATE TABLE "PayrollPseudonyms" (
    "schoolId"  UUID NOT NULL,
    "userId"    UUID NOT NULL,
    "number"    INTEGER GENERATED ALWAYS AS IDENTITY,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "PayrollPseudonyms_pkey" PRIMARY KEY ("schoolId", "userId"),
    CONSTRAINT "PayrollPseudonyms_number_key" UNIQUE ("number")
);

-- The key leads with the school: it serves the school's key and, as (schoolId,
-- userId), the person's lookup on a removal.
ALTER TABLE "PayrollPseudonyms"
    ADD CONSTRAINT "PayrollPseudonyms_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "PayrollPseudonyms"
    ADD CONSTRAINT "PayrollPseudonyms_userId_schoolId_fkey" FOREIGN KEY ("userId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;

COMMENT ON TABLE "PayrollPseudonyms" IS
  'Skyddad identitet i löneunderlaget: a marked person''s code, SKYDDAD-<number>, which the payroll file writes where the person has no Löne-id. Written and removed by the mark (app.payroll_pseudonym_follows_the_mark), read by the school''s administrators (20270206091000).';
COMMENT ON COLUMN "PayrollPseudonyms"."number" IS
  'Drawn once from the identity, never chosen and never reused: the same code in every file.';

CREATE FUNCTION app.payroll_pseudonym_follows_the_mark() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  mark "PersonProtections";
BEGIN
  IF TG_OP = 'INSERT' THEN
    mark := NEW;
  ELSE
    mark := OLD;
  END IF;
  -- One transaction at a time changes a person's marks and code (see the preamble). A row a cascade has
  -- already removed is not found, and there is nothing to wait for.
  PERFORM 1 FROM "Users" u
   WHERE u."id" = mark."userId" AND u."schoolId" = mark."schoolId"
     FOR NO KEY UPDATE;
  IF TG_OP = 'INSERT' THEN
    -- A second mark of the same person (the sync's beside an administrator's) keeps the first code.
    INSERT INTO "PayrollPseudonyms" ("schoolId", "userId")
    VALUES (mark."schoolId", mark."userId")
    ON CONFLICT ("schoolId", "userId") DO NOTHING;
    RETURN NULL;
  END IF;
  -- The person's last mark in the school takes the code with it.
  IF NOT EXISTS (SELECT 1 FROM "PersonProtections" p
                  WHERE p."schoolId" = mark."schoolId" AND p."userId" = mark."userId") THEN
    DELETE FROM "PayrollPseudonyms" WHERE "schoolId" = mark."schoolId" AND "userId" = mark."userId";
  END IF;
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION app.payroll_pseudonym_follows_the_mark() FROM PUBLIC;

CREATE TRIGGER "PersonProtections_payroll_pseudonym"
    AFTER INSERT OR DELETE ON "PersonProtections"
    FOR EACH ROW EXECUTE FUNCTION app.payroll_pseudonym_follows_the_mark();

-- The marks that exist, in the order of school and person.
INSERT INTO "PayrollPseudonyms" ("schoolId", "userId")
SELECT p."schoolId", p."userId"
  FROM "PersonProtections" p
 GROUP BY p."schoolId", p."userId"
 ORDER BY p."schoolId", p."userId";

-- ---------------------------------------------------------------------------
-- Row-level security and grants: the school's administrators read; nobody
-- but the trigger writes. Nothing for a PostgREST role, and nothing of PG 17's
-- MAINTAIN.
-- ---------------------------------------------------------------------------

ALTER TABLE "PayrollPseudonyms" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r text;
  seq text := pg_get_serial_sequence('"PayrollPseudonyms"', 'number');
BEGIN
  -- The identity's sequence is the trigger's (the owner's) alone: a role that could move it could make
  -- the next mark collide with a code, and the mark would fail.
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon', 'service_role', 'app_authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM %I', seq, r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    CREATE POLICY "payroll_pseudonyms_admin_select" ON "PayrollPseudonyms"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    REVOKE ALL ON "PayrollPseudonyms" FROM "app_authenticated";
    GRANT SELECT ON "PayrollPseudonyms" TO "app_authenticated";
  END IF;

  FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "PayrollPseudonyms" FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "PayrollPseudonyms" FROM service_role;
  END IF;
  IF current_setting('server_version_num')::int >= 170000 THEN
    FOREACH r IN ARRAY ARRAY['authenticated', 'app_authenticated', 'service_role', 'anon'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE MAINTAIN ON "PayrollPseudonyms" FROM %I', r);
      END IF;
    END LOOP;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- app.teacher_employment_logs_append_only: 20261021110000's body, and the one
-- change gallring may make to a version (see the preamble). A later release
-- that restates it must carry the lines marked "Löne-id".
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.teacher_employment_logs_append_only() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  -- TRUNCATE (a statement trigger): never, at any depth.
  IF TG_OP <> 'TRUNCATE' AND pg_trigger_depth() > 1 THEN
    -- INSERT: the logging trigger's own write. UPDATE/DELETE: a parent's
    -- referential action (an id renamed, a person, year or school deleted).
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  -- gallring: the school's own purge of a läsår past its period.
  IF TG_OP = 'DELETE' AND app.gallring_in_progress(OLD."schoolId") THEN
    RETURN OLD;
  END IF;
  -- Löne-id (20270206091000): gallring sets a pseudonym's payroll number to null in a version, and changes
  -- nothing else of it: every column but before and after as it was, and before and after as they were but
  -- for the number, which is null (or absent) after.
  IF TG_OP = 'UPDATE' AND app.gallring_in_progress(OLD."schoolId")
     AND (to_jsonb(NEW) - 'before' - 'after') = (to_jsonb(OLD) - 'before' - 'after')
     AND (NEW."before" - 'payrollNumber') IS NOT DISTINCT FROM (OLD."before" - 'payrollNumber')
     AND (NEW."after" - 'payrollNumber') IS NOT DISTINCT FROM (OLD."after" - 'payrollNumber')
     AND coalesce(NEW."before" -> 'payrollNumber', 'null'::jsonb) = 'null'::jsonb
     AND coalesce(NEW."after" -> 'payrollNumber', 'null'::jsonb) = 'null'::jsonb THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'TEACHER_EMPLOYMENT_LOG_IS_APPEND_ONLY: en tjänsts historik skrivs bara av databasen och ändras aldrig'
    USING ERRCODE = 'TL403',
          DETAIL  = format('operation=%s', TG_OP);
END
$$;

-- ---------------------------------------------------------------------------
-- app.gallring_pseudonymise: 20270206090000's body, and a pseudonym's versions
-- lose the payroll number. A later release that restates the function must
-- carry the lines marked "skyddad identitet" and "Löne-id".
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.gallring_pseudonymise(p_run uuid, p_users uuid[]) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  r "GallringRuns";
  cutoff date;
  today date;
  due uuid[];
  n integer;
BEGIN
  SELECT * INTO r FROM "GallringRuns" WHERE "id" = p_run AND "status" = 'RUNNING' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GALLRING_RUN_NOT_RUNNING' USING ERRCODE = 'GL404';
  END IF;
  -- The rows before the question: a reactivation in flight is waited for,
  -- one that comes later waits for this transaction, and every statement
  -- below reads after the wait. Id order, so two callers cannot deadlock.
  PERFORM 1 FROM "Users" u
   WHERE u."schoolId" = r."schoolId" AND u."id" = ANY (p_users)
   ORDER BY u."id"
     FOR NO KEY UPDATE;
  IF r."cutoffs" ->> 'DEPARTED_PEOPLE' IS NULL
     OR app.retention_months_in_force(r."schoolId", 'DEPARTED_PEOPLE', clock_timestamp()) IS NULL THEN
    RETURN 0;
  END IF;
  cutoff := app.gallring_run_cutoff(r."schoolId", r."startedAt", r."cutoffs", 'DEPARTED_PEOPLE');
  today := app.gallring_today(r."schoolId", r."startedAt");
  -- Asked again: somebody reactivated since the list was read is not due.
  due := ARRAY(
    SELECT d."id" FROM app.gallring_due(r."schoolId", 'DEPARTED_PEOPLE', cutoff, today) d
     WHERE d."id" = ANY (p_users)
     ORDER BY d."id"
     LIMIT 500);

  PERFORM set_config('app.gallring', r."schoolId"::text, true);
  UPDATE "Users" u SET
      "firstName"       = 'Pseudonym',
      "lastName"        = upper(left(replace(u."id"::text, '-', ''), 6)),
      "email"           = 'pseudonym-' || u."id"::text || '@pseudonym.invalid',
      "phone"           = NULL,
      "ss12000Id"       = NULL,
      "authId"          = gen_random_uuid(),
      "invitedAt"       = NULL,
      "pseudonymisedAt" = now(),
      "updatedAt"       = now()
   WHERE u."schoolId" = r."schoolId" AND u."id" = ANY (due);
  GET DIAGNOSTICS n = ROW_COUNT;
  -- Löne-id (20270206090000): the payroll system's number, as the signature.
  UPDATE "TeacherEmployments" SET "signature" = NULL, "note" = NULL, "payrollNumber" = NULL
   WHERE "schoolId" = r."schoolId" AND "userId" = ANY (due)
     AND ("signature" IS NOT NULL OR "note" IS NOT NULL OR "payrollNumber" IS NOT NULL);
  -- Löne-id (20270206091000): the versions of a pseudonym's posts lose the number too (the log's guard
  -- lets gallring make this one change).
  UPDATE "TeacherEmploymentLogs" SET
      "before" = CASE WHEN "before" ? 'payrollNumber' THEN jsonb_set("before", '{payrollNumber}', 'null'::jsonb) ELSE "before" END,
      "after"  = CASE WHEN "after" ? 'payrollNumber' THEN jsonb_set("after", '{payrollNumber}', 'null'::jsonb) ELSE "after" END
   WHERE "schoolId" = r."schoolId" AND "userId" = ANY (due) AND "entity" = 'EMPLOYMENT'
     AND (coalesce("before" -> 'payrollNumber', 'null'::jsonb) <> 'null'::jsonb
          OR coalesce("after" -> 'payrollNumber', 'null'::jsonb) <> 'null'::jsonb);
  -- Rastvaktsschema (20261207090000): a pass's note, as the tjänst's.
  UPDATE "SupervisionShifts" SET "note" = NULL, "updatedAt" = now()
   WHERE "schoolId" = r."schoolId" AND "userId" = ANY (due) AND "note" IS NOT NULL;
  DELETE FROM "GuardianStudents"
   WHERE "schoolId" = r."schoolId" AND ("guardianId" = ANY (due) OR "studentId" = ANY (due));
  DELETE FROM "PushTickets" p USING "DevicePushTokens" t
   WHERE p."tokenId" = t."id" AND p."schoolId" = t."schoolId"
     AND t."schoolId" = r."schoolId" AND t."userId" = ANY (due);
  DELETE FROM "DevicePushTokens" WHERE "schoolId" = r."schoolId" AND "userId" = ANY (due);
  DELETE FROM "NotificationOptOuts" WHERE "schoolId" = r."schoolId" AND "userId" = ANY (due);
  DELETE FROM "Notifications" WHERE "schoolId" = r."schoolId" AND "userId" = ANY (due);
  -- skyddad identitet (20270107090000): a pseudonym's mark.
  DELETE FROM "PersonProtections" WHERE "schoolId" = r."schoolId" AND "userId" = ANY (due);
  PERFORM set_config('app.gallring', '', true);

  UPDATE "GallringRuns" SET
    "counts" = "counts" || jsonb_build_object('DEPARTED_PEOPLE', COALESCE(("counts" ->> 'DEPARTED_PEOPLE')::bigint, 0) + n),
    "cutoffs" = "cutoffs" || jsonb_build_object('DEPARTED_PEOPLE', cutoff::text)
   WHERE "id" = p_run;
  RETURN n;
END
$$;

COMMENT ON FUNCTION app.gallring_pseudonymise(uuid, uuid[]) IS
  'Locks the rows of p_users in the run''s school, then pseudonymises those still due: name, e-mail, phone, SS12000 id and login replaced; their tjänster''s signature, note and payroll number, the payroll number in those tjänster''s versions, and their rastvaktspass'' notes, cleared; their guardian links, push devices, notification opt-outs, all their own notices (whatever NOTIFICATIONS says) and their mark of a protected identity removed. Returns how many it pseudonymised.';
