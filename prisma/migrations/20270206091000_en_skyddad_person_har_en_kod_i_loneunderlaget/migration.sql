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
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A second mark of the same person (the sync's beside an administrator's) keeps the first code.
    INSERT INTO "PayrollPseudonyms" ("schoolId", "userId")
    VALUES (NEW."schoolId", NEW."userId")
    ON CONFLICT ("schoolId", "userId") DO NOTHING;
    RETURN NULL;
  END IF;
  -- The person's last mark in the school takes the code with it.
  IF NOT EXISTS (SELECT 1 FROM "PersonProtections" p
                  WHERE p."schoolId" = OLD."schoolId" AND p."userId" = OLD."userId") THEN
    DELETE FROM "PayrollPseudonyms" WHERE "schoolId" = OLD."schoolId" AND "userId" = OLD."userId";
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
