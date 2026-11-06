-- Hela skolans data hämtas som en fil, och filen försvinner efter tre dygn.
--
-- A school that ends its agreement, or answers a data subject's request under
-- GDPR art. 15, has had no way to take its data out in one piece: each page
-- exports its own CSV, and attendance, absence reports, leave, notices and
-- the läslogg could not be taken out at all. This migration is the stored
-- half of the whole-school export (K5, round 9): the order, the job's lease
-- on it and the file the job builds. src/school-export/ is the other half.
--
-- ## What is stored
--
--   SchoolExports       one row per order: who asked, when, the job's state,
--                       and once built the file's size, its SHA-256, what
--                       each part of it holds (names and row counts) and how
--                       many protected persons it left out
--   SchoolExportChunks  the file itself, a zip, in pieces of at most 4 MiB
--                       (the job writes 1 MiB), so neither the job nor the
--                       download ever holds the whole file; a piece is
--                       written once and never changed
--
-- The file is stored in the database and not on the API's disk because the
-- API runs two instances during a deploy and has no disk that outlives one:
-- a download that lands on the other instance must find the file. It is a
-- copy of the school's data and lives like one: three days
-- (src/school-export/school-export.ts EXPORT_KEEP_HOURS; the database holds a
-- ceiling of fourteen), after which app.school_export_expire() deletes the
-- pieces. Past its expiry it cannot be read even before that runs: the
-- pieces' read arm asks for a READY export that has not expired.
--
-- ## Who may order and read it
--
-- The administrators who decide: rektor and a full administrator, the two
-- profiles that own gallring and the läslogg (app.current_user_decides()), and
-- nobody else. Not a schemaläggare, not the expedition, not a läsare, and not
-- the huvudman's reader, who reads every school it owns as a läsare and
-- decides nothing; a copy of every pupil's record is the school's to take.
-- The rule is the arms' and holds for every route to the table. Nothing of it
-- reaches a PostgREST role.
--
--   school_exports_select          SCHOOL_ADMIN who decides, own school
--   school_exports_insert          the same, naming themselves, QUEUED
--   school_exports_delete          the same: end an order, or withdraw a file
--   school_export_chunks_select    the same, of a READY export not yet expired
--
-- No arm updates: the job moves an export through its states with the
-- functions below (SECURITY DEFINER, the API's role), each of which names the
-- row it moves and checks its state, so an administrator cannot make an
-- export READY, change what it says it holds or write a piece. INSERT is
-- granted on two columns, the school and the person; everything else is the
-- default or the job's.
--
-- ## The job's lease
--
-- JobRunner ticks app.school_export_claim() every 30 s. It takes the oldest
-- QUEUED export, or a RUNNING one whose heartbeat is older than the lease
-- (the instance that held it was stopped), FOR UPDATE SKIP LOCKED, so two
-- instances never take the same order. A taken-over export loses its pieces
-- and starts again; the third attempt that dies is FAILED. The job reads the
-- school's data AS the administrator who ordered it (their login and school
-- as claims), never as a service: row-level security is what keeps another
-- school's rows out of the file, and an administrator who is demoted, made
-- inactive or removed between the order and the read gets nothing from it
-- (the export fails with an error class and no row). The pieces are written
-- through app.school_export_put, which takes the school from the export, not
-- from the caller.
--
-- One export per school at a time (the partial unique index on QUEUED and
-- RUNNING): an order is refused with 23505 while one is in hand.
--
-- ## The läslogg
--
-- Each download is recorded by the gateway in the transaction that begins
-- it (recordRead, one row per kind, naming the persons the file holds rows
-- about), so a file that cannot be logged is not delivered. The persons per
-- kind are kept on the export (readAbout) for that, and cleared when the file
-- expires: a list of ids that outlived their file is a list of persons.
--
-- ## Retention
--
-- Not a gallring kind. The file's life is fixed at three days and the order's
-- row (who asked, when, how big, what it held, never a person's data) is
-- deleted by app.school_export_expire() thirteen months after it ended: an
-- accountability record of who took a copy, as long as the läslogg's default
-- year plus a quarter. Letting a school choose how long a copy of everything
-- may live has no good answer but "as short as it can". The row's person is
-- kept with SET NULL when that person is removed.
--
-- ## Beside the live API: every lock at once, or none
--
-- The two keys take Schools and Users in SHARE ROW EXCLUSIVE, which blocks
-- writes to them (not reads, not the KEY SHARE a key check takes) for the
-- length of the file; the tables are new and empty, so the keys validate
-- nothing. A request writes both in one transaction, so they are taken
-- together, NOWAIT, in a loop: a refusal rolls the subtransaction back with
-- whatever it got and tries again 50 ms later; it never waits while it holds
-- a lock, and no request queues behind it. After 30 s it stops with nothing
-- changed: prisma migrate resolve --rolled-back
-- 20270114090000_hela_skolans_data_hamtas_som_en_tidsbegransad_fil, then
-- deploy again. Nothing else here locks an existing table. Additive: no
-- column, constraint or function of a live table changes.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Schools" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Users" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Schools and Users were not free at once in 30 s: nothing is changed. Run: npx prisma migrate resolve --rolled-back 20270114090000_hela_skolans_data_hamtas_som_en_tidsbegransad_fil, then deploy again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

CREATE TYPE "SchoolExportStatus" AS ENUM ('QUEUED', 'RUNNING', 'READY', 'FAILED', 'EXPIRED');

-- ---------------------------------------------------------------------------
-- SchoolExports
-- ---------------------------------------------------------------------------

CREATE TABLE "SchoolExports" (
    "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"      UUID NOT NULL,
    "requestedById" UUID,
    "status"        "SchoolExportStatus" NOT NULL DEFAULT 'QUEUED',
    "requestedAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "startedAt"     TIMESTAMPTZ(6),
    "heartbeatAt"   TIMESTAMPTZ(6),
    "finishedAt"    TIMESTAMPTZ(6),
    "expiresAt"     TIMESTAMPTZ(6),
    "attempts"      INTEGER NOT NULL DEFAULT 0,
    "byteSize"      BIGINT,
    "chunkCount"    INTEGER,
    "sha256"        TEXT,
    "files"         JSONB,
    "heldOut"       JSONB,
    "readAbout"     JSONB,
    "errorClass"    TEXT,

    CONSTRAINT "SchoolExports_pkey" PRIMARY KEY ("id"),
    -- The pieces' key names the school too, as every person key does.
    CONSTRAINT "SchoolExports_id_schoolId_key" UNIQUE ("id", "schoolId"),
    CONSTRAINT "SchoolExports_attempts_are_few" CHECK ("attempts" BETWEEN 0 AND 3),
    -- A finished file says what it is; an unfinished or failed one says nothing of a file.
    CONSTRAINT "SchoolExports_ready_has_its_file" CHECK (
        ("status" = 'READY') = ("byteSize" IS NOT NULL AND "chunkCount" IS NOT NULL AND "sha256" IS NOT NULL AND "expiresAt" IS NOT NULL)
        OR "status" = 'EXPIRED'
    ),
    CONSTRAINT "SchoolExports_sha256_is_hex" CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$'),
    -- An error class as the logs have it, never a message (JobRuns_counts_are_counts' rule).
    CONSTRAINT "SchoolExports_error_is_a_class" CHECK ("errorClass" IS NULL OR "errorClass" ~ '^[A-Za-z][A-Za-z0-9_]{0,79}$'),
    CONSTRAINT "SchoolExports_failed_names_its_class" CHECK (("status" = 'FAILED') = ("errorClass" IS NOT NULL)),
    -- A copy of everything does not live long: two weeks is the ceiling the job's three days sit under.
    CONSTRAINT "SchoolExports_keeps_for_at_most_fourteen_days" CHECK ("expiresAt" IS NULL OR "finishedAt" IS NOT NULL AND "expiresAt" <= "finishedAt" + interval '14 days')
);

-- One export in hand per school.
CREATE UNIQUE INDEX "SchoolExports_one_in_hand_per_school" ON "SchoolExports"("schoolId") WHERE "status" IN ('QUEUED', 'RUNNING');
-- The claim's oldest first, and the school's list.
CREATE INDEX "SchoolExports_status_requestedAt_idx" ON "SchoolExports"("status", "requestedAt");
CREATE INDEX "SchoolExports_schoolId_requestedAt_idx" ON "SchoolExports"("schoolId", "requestedAt");
-- A removed person finds the orders they made (the key's SET NULL), as every person key since 20261220090000.
CREATE INDEX "SchoolExports_requestedById_idx" ON "SchoolExports"("requestedById") WHERE "requestedById" IS NOT NULL;

ALTER TABLE "SchoolExports"
    ADD CONSTRAINT "SchoolExports_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
-- SET NULL on the person alone: the school column is part of the row's key and stays.
ALTER TABLE "SchoolExports"
    ADD CONSTRAINT "SchoolExports_requestedById_schoolId_fkey" FOREIGN KEY ("requestedById", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE SET NULL ("requestedById") ON UPDATE NO ACTION;

COMMENT ON TABLE "SchoolExports" IS
  'Whole-school export (K5): one order for a zip of the school''s data, the job''s lease on it and, once built, the file''s size, SHA-256, parts and held-out count. Deciding administrators only; the file lives three days (20270114090000).';

-- ---------------------------------------------------------------------------
-- SchoolExportChunks
-- ---------------------------------------------------------------------------

CREATE TABLE "SchoolExportChunks" (
    "exportId" UUID NOT NULL,
    "seq"      INTEGER NOT NULL,
    "schoolId" UUID NOT NULL,
    "bytes"    BYTEA NOT NULL,

    CONSTRAINT "SchoolExportChunks_pkey" PRIMARY KEY ("exportId", "seq"),
    CONSTRAINT "SchoolExportChunks_seq_is_counted_from_zero" CHECK ("seq" >= 0),
    CONSTRAINT "SchoolExportChunks_a_piece_is_small" CHECK (octet_length("bytes") BETWEEN 1 AND 4194304)
);

-- A zip is deflate-compressed already: do not have TOAST try again for every piece.
ALTER TABLE "SchoolExportChunks" ALTER COLUMN "bytes" SET STORAGE EXTERNAL;

CREATE INDEX "SchoolExportChunks_schoolId_idx" ON "SchoolExportChunks"("schoolId");

ALTER TABLE "SchoolExportChunks"
    ADD CONSTRAINT "SchoolExportChunks_exportId_schoolId_fkey" FOREIGN KEY ("exportId", "schoolId")
    REFERENCES "SchoolExports"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;

COMMENT ON TABLE "SchoolExportChunks" IS
  'The whole-school export''s zip in pieces of at most 4 MiB, written once by app.school_export_put while the export is RUNNING and deleted when it expires or is withdrawn (20270114090000).';

-- Whoever orders is the person the row names: the caller's own row, whatever
-- the insert said. The arm still asks for it ("requestedById" = the caller),
-- so an order cannot be placed in another administrator's name; the trigger
-- makes the arm's question a fact for a statement that copies another row.
-- The owner and a service, who have no person, name whom they like.
CREATE FUNCTION app.school_exports_name_the_orderer() RETURNS trigger
LANGUAGE plpgsql SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF app.current_user_id() IS NOT NULL THEN
    NEW."requestedById" := app.current_user_id();
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SchoolExports_name_the_orderer"
    BEFORE INSERT ON "SchoolExports"
    FOR EACH ROW EXECUTE FUNCTION app.school_exports_name_the_orderer();

-- ---------------------------------------------------------------------------
-- The job's functions. SECURITY DEFINER with a fixed search_path, executable
-- by the API's role alone; each names the row it moves and checks its state.
-- ---------------------------------------------------------------------------

-- Takes the oldest export in need of a job: QUEUED, or RUNNING with a heartbeat
-- older than the lease. A taken-over export starts again with no pieces. One
-- whose person has gone, or whose third attempt this would be, fails at once.
CREATE FUNCTION app.school_export_claim(p_lease interval)
RETURNS TABLE (export_id uuid, school_id uuid, user_id uuid, auth_id uuid, admin_profile "AdminProfile", hr_read boolean, attempt integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  picked  "SchoolExports"%ROWTYPE;
  login   uuid;
  profile "AdminProfile";
  hr      boolean;
BEGIN
  IF p_lease IS NULL OR p_lease < interval '10 seconds' OR p_lease > interval '1 hour' THEN
    RAISE EXCEPTION 'school_export_claim: the lease is between 10 seconds and 1 hour' USING ERRCODE = 'SS409';
  END IF;
  LOOP
    SELECT e.* INTO picked
      FROM "SchoolExports" e
     WHERE e."status" = 'QUEUED'
        OR (e."status" = 'RUNNING' AND e."heartbeatAt" < clock_timestamp() - p_lease)
     ORDER BY e."requestedAt", e."id"
     LIMIT 1
       FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      RETURN;
    END IF;

    SELECT u."authId", u."adminProfile", u."hrRead" INTO login, profile, hr
      FROM "Users" u
     WHERE u."id" = picked."requestedById" AND u."schoolId" = picked."schoolId"
       AND u."isActive" AND u."role" = 'SCHOOL_ADMIN' AND app.admin_profile_decides(u."adminProfile");

    IF login IS NULL OR picked."attempts" >= 3 THEN
      DELETE FROM "SchoolExportChunks" WHERE "exportId" = picked."id";
      UPDATE "SchoolExports"
         SET "status" = 'FAILED', "finishedAt" = clock_timestamp(),
             "errorClass" = CASE WHEN login IS NULL THEN 'RequesterGone' ELSE 'TooManyAttempts' END
       WHERE "id" = picked."id";
      CONTINUE;
    END IF;

    DELETE FROM "SchoolExportChunks" WHERE "exportId" = picked."id";
    UPDATE "SchoolExports"
       SET "status" = 'RUNNING',
           "startedAt" = clock_timestamp(),
           "heartbeatAt" = clock_timestamp(),
           "attempts" = "attempts" + 1
     WHERE "id" = picked."id";
    RETURN QUERY SELECT picked."id", picked."schoolId", picked."requestedById", login, profile, hr, picked."attempts" + 1;
    RETURN;
  END LOOP;
END
$$;

-- A builder holds its export by the attempt the claim gave it, and every
-- function below takes that number (`p_attempt`) and refuses a builder whose
-- attempt is not the export's current one: a builder that stalled past the
-- lease, was taken over and then woke up must not write a piece into the
-- second builder's file or finish or fail it. NULL asks for no check (the
-- suite's own calls); the job always names its attempt.

-- The job is alive. False when the export is no longer RUNNING (withdrawn,
-- taken over): the job stops and writes nothing more.
CREATE FUNCTION app.school_export_heartbeat(p_id uuid, p_attempt integer DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  UPDATE "SchoolExports" SET "heartbeatAt" = clock_timestamp()
   WHERE "id" = p_id AND "status" = 'RUNNING' AND (p_attempt IS NULL OR "attempts" = p_attempt);
  RETURN FOUND;
END
$$;

-- One piece of the file. The school is the export's, never the caller's.
CREATE FUNCTION app.school_export_put(p_id uuid, p_seq integer, p_bytes bytea, p_attempt integer DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  INSERT INTO "SchoolExportChunks" ("exportId", "seq", "schoolId", "bytes")
  SELECT e."id", p_seq, e."schoolId", p_bytes
    FROM "SchoolExports" e
   WHERE e."id" = p_id AND e."status" = 'RUNNING' AND (p_attempt IS NULL OR e."attempts" = p_attempt);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SCHOOL_EXPORT_NOT_RUNNING: the export is not being built' USING ERRCODE = 'SS409';
  END IF;
END
$$;

-- The file is whole: the pieces counted and summed against what the job says
-- it wrote, then READY for `p_keep`.
CREATE FUNCTION app.school_export_finish(
  p_id uuid, p_bytes bigint, p_chunks integer, p_sha256 text,
  p_files jsonb, p_held_out jsonb, p_read_about jsonb, p_keep interval, p_attempt integer DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  have_chunks integer;
  have_bytes  bigint;
BEGIN
  IF p_keep IS NULL OR p_keep <= interval '0' OR p_keep > interval '14 days' THEN
    RAISE EXCEPTION 'school_export_finish: a file is kept for between nothing and 14 days' USING ERRCODE = 'SS409';
  END IF;
  SELECT count(*)::integer, coalesce(sum(octet_length(c."bytes")), 0)
    INTO have_chunks, have_bytes
    FROM "SchoolExportChunks" c WHERE c."exportId" = p_id;
  IF have_chunks <> p_chunks OR have_bytes <> p_bytes THEN
    RAISE EXCEPTION 'SCHOOL_EXPORT_FILE_INCOMPLETE: % pieces and % bytes stored, % and % said', have_chunks, have_bytes, p_chunks, p_bytes
      USING ERRCODE = 'SS409';
  END IF;
  UPDATE "SchoolExports"
     SET "status" = 'READY', "finishedAt" = clock_timestamp(),
         "expiresAt" = clock_timestamp() + p_keep,
         "byteSize" = p_bytes, "chunkCount" = p_chunks, "sha256" = p_sha256,
         "files" = p_files, "heldOut" = p_held_out, "readAbout" = p_read_about
   WHERE "id" = p_id AND "status" = 'RUNNING' AND (p_attempt IS NULL OR "attempts" = p_attempt);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SCHOOL_EXPORT_NOT_RUNNING: the export is not being built' USING ERRCODE = 'SS409';
  END IF;
END
$$;

-- The build failed: its error class, and no piece of it left. Only a RUNNING
-- export, and only by its current attempt: a finished file keeps its pieces.
CREATE FUNCTION app.school_export_fail(p_id uuid, p_error text, p_attempt integer DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  UPDATE "SchoolExports"
     SET "status" = 'FAILED', "finishedAt" = clock_timestamp(),
         "errorClass" = CASE WHEN p_error ~ '^[A-Za-z][A-Za-z0-9_]{0,79}$' THEN p_error ELSE 'Error' END
   WHERE "id" = p_id AND "status" = 'RUNNING' AND (p_attempt IS NULL OR "attempts" = p_attempt);
  IF FOUND THEN
    DELETE FROM "SchoolExportChunks" WHERE "exportId" = p_id;
  END IF;
END
$$;

-- What is past its time: a READY file past its expiry loses its pieces and
-- its list of persons and becomes EXPIRED; a finished order older than the
-- ledger's period is deleted. Counts, for the job's ledger.
CREATE FUNCTION app.school_export_expire(p_ledger interval)
RETURNS TABLE (expired integer, purged integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  n_expired integer;
  n_purged  integer;
BEGIN
  IF p_ledger IS NULL OR p_ledger < interval '30 days' THEN
    RAISE EXCEPTION 'school_export_expire: the ledger is kept for at least 30 days' USING ERRCODE = 'SS409';
  END IF;
  DELETE FROM "SchoolExportChunks" c
   USING "SchoolExports" e
   WHERE e."id" = c."exportId" AND e."status" = 'READY' AND e."expiresAt" <= clock_timestamp();
  WITH gone AS (
    UPDATE "SchoolExports" SET "status" = 'EXPIRED', "readAbout" = NULL
     WHERE "status" = 'READY' AND "expiresAt" <= clock_timestamp()
    RETURNING 1)
  SELECT count(*)::integer INTO n_expired FROM gone;
  WITH gone AS (
    DELETE FROM "SchoolExports"
     WHERE "status" IN ('EXPIRED', 'FAILED') AND "finishedAt" < clock_timestamp() - p_ledger
    RETURNING 1)
  SELECT count(*)::integer INTO n_purged FROM gone;
  RETURN QUERY SELECT n_expired, n_purged;
END
$$;

COMMENT ON FUNCTION app.school_export_claim(interval) IS
  'K5: the oldest QUEUED export, or a RUNNING one whose heartbeat is older than the lease, FOR UPDATE SKIP LOCKED, with the login of the deciding administrator who ordered it. A taken-over export restarts with no pieces; one whose person is gone or on its third attempt FAILS.';
COMMENT ON FUNCTION app.school_export_put(uuid, integer, bytea, integer) IS
  'K5: one piece of a RUNNING export''s file, in the export''s own school.';
COMMENT ON FUNCTION app.school_export_finish(uuid, bigint, integer, text, jsonb, jsonb, jsonb, interval, integer) IS
  'K5: READY, after counting and summing the stored pieces against what the job says it wrote; kept for at most 14 days.';
COMMENT ON FUNCTION app.school_export_expire(interval) IS
  'K5: READY files past their expiry lose their pieces and their list of persons (EXPIRED); finished orders past the ledger''s period are deleted.';

-- ---------------------------------------------------------------------------
-- Row-level security and grants. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "SchoolExports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SchoolExportChunks" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r text;
  t text;
  f text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    CREATE POLICY "school_exports_select" ON "SchoolExports"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
               AND (select app.current_user_decides()));
    CREATE POLICY "school_exports_insert" ON "SchoolExports"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_decides())
                    AND "requestedById" = (select app.current_user_id())
                    AND "status" = 'QUEUED');
    CREATE POLICY "school_exports_delete" ON "SchoolExports"
        FOR DELETE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
               AND (select app.current_user_decides()));
    CREATE POLICY "school_export_chunks_select" ON "SchoolExportChunks"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
               AND (select app.current_user_decides())
               AND EXISTS (SELECT 1 FROM "SchoolExports" e
                            WHERE e."id" = "SchoolExportChunks"."exportId"
                              AND e."status" = 'READY' AND e."expiresAt" > clock_timestamp()));

    REVOKE ALL ON "SchoolExports" FROM "app_authenticated";
    GRANT SELECT, DELETE ON "SchoolExports" TO "app_authenticated";
    GRANT INSERT ("schoolId", "requestedById") ON "SchoolExports" TO "app_authenticated";
    REVOKE ALL ON "SchoolExportChunks" FROM "app_authenticated";
    GRANT SELECT ON "SchoolExportChunks" TO "app_authenticated";

    FOREACH f IN ARRAY ARRAY[
      'app.school_export_claim(interval)',
      'app.school_export_heartbeat(uuid, integer)',
      'app.school_export_put(uuid, integer, bytea, integer)',
      'app.school_export_finish(uuid, bigint, integer, text, jsonb, jsonb, jsonb, interval, integer)',
      'app.school_export_fail(uuid, text, integer)',
      'app.school_export_expire(interval)'
    ] LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO "app_authenticated"', f);
    END LOOP;
  END IF;

  FOREACH t IN ARRAY ARRAY['SchoolExports', 'SchoolExportChunks'] LOOP
    FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM service_role', t);
    END IF;
    -- PostgreSQL 17's MAINTAIN (REINDEX, CLUSTER, VACUUM, LOCK): the owner's alone.
    IF current_setting('server_version_num')::int >= 170000 THEN
      FOREACH r IN ARRAY ARRAY['authenticated', 'app_authenticated', 'service_role', 'anon'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
          EXECUTE format('REVOKE MAINTAIN ON %I FROM %I', t, r);
        END IF;
      END LOOP;
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- SCHOOL_EXPORT_REACH: the four arms above and no other, none for a
-- PostgREST role or the service principal. Each expression names the caller's
-- school, the SCHOOL_ADMIN role and the decisions, has no OR and no NOT; the
-- insert names the caller as the person and the state QUEUED; the pieces'
-- read asks for a READY export not yet expired. A name and a command alone
-- would let `USING (true)` through.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  bad text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    RETURN;
  END IF;
  SELECT string_agg(p.tablename || '.' || p.policyname || ' ' || p.cmd || ' ' || p.roles::text, ', ' ORDER BY p.tablename, p.policyname) INTO bad
    FROM pg_policies p
   WHERE p.schemaname = 'public'
     AND p.tablename IN ('SchoolExports', 'SchoolExportChunks')
     AND NOT coalesce(
           p.roles = '{app_authenticated}'::name[]
           AND p.permissive = 'PERMISSIVE'
           AND (p.tablename, p.policyname, p.cmd) IN (
                 ('SchoolExports', 'school_exports_select', 'SELECT'),
                 ('SchoolExports', 'school_exports_insert', 'INSERT'),
                 ('SchoolExports', 'school_exports_delete', 'DELETE'),
                 ('SchoolExportChunks', 'school_export_chunks_select', 'SELECT'))
           AND (SELECT bool_and(
                         e NOT LIKE '% OR %'
                         AND e NOT LIKE '%NOT %'
                         AND e LIKE '%"schoolId" = ( SELECT app.current_school_id() AS current_school_id)%'
                         AND e LIKE '%current_user_role()%= ''SCHOOL_ADMIN''::"UserRole"%'
                         AND e LIKE '%current_user_decides()%'
                         AND (p.cmd <> 'INSERT' OR (e LIKE '%"requestedById" = ( SELECT app.current_user_id() AS current_user_id)%'
                                                    AND e LIKE '%(status = ''QUEUED''::"SchoolExportStatus")%'))
                         AND (p.policyname <> 'school_export_chunks_select'
                              OR (e LIKE '%(e.status = ''READY''::"SchoolExportStatus")%'
                                  AND e LIKE '%(e."expiresAt" > clock_timestamp())%')))
                  FROM unnest(ARRAY[p.qual, p.with_check]) e
                 WHERE e IS NOT NULL),
         false);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'SCHOOL_EXPORT_REACH: these arms reach the exports beyond the deciding administrator''s order, withdrawal and read of an unexpired file: %', bad;
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('SchoolExports', 'SchoolExportChunks')) <> 4 THEN
    RAISE EXCEPTION 'SCHOOL_EXPORT_REACH: the exports have % arms, not the four above',
      (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('SchoolExports', 'SchoolExportChunks'));
  END IF;
END
$$;
