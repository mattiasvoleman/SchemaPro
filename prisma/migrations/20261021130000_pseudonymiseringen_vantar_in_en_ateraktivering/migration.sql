-- Pseudonymiseringen väntar in en återaktivering, och skolans natt går klart.
--
-- Amends app.gallring_pseudonymise (20261021110000). Nothing here can matter
-- before a school records a DEPARTED_PEOPLE period: until then the job claims
-- nobody, so it never calls the function. Called anyway with a running run,
-- it locks the named rows and returns 0 without changing any.
--
-- ## A reactivation in flight failed the school's night
--
-- The nightly job claims one person (app.gallring_claim_person,
-- 20261021120000), deletes their login and pseudonymises them at once. The
-- claim locks the row, but only in its own short transaction. When an
-- administrator made the person active again in the moment after it
-- (UsersService.update locks the row FOR NO KEY UPDATE, then writes
-- isActive) and committed while app.gallring_pseudonymise was running:
--
--   * its question, app.gallring_due, read the row as last committed, still
--     inactive, and named the person due;
--   * its UPDATE waited for the administrator's row and then wrote the newer
--     version. Postgres re-checks only the UPDATE's own WHERE (school and id)
--     on that version, so it wrote a pseudonym over an active person;
--   * the CHECK "Users_a_pseudonym_stays_inactive" (20261021100000) refused
--     it, the call failed, and the job counted the whole school's night as
--     failed, to be retried two hours later.
--
-- Nobody was pseudonymised wrongly, the CHECK saw to that. But the night did
-- not finish, and the person had already lost their login.
--
-- ## Now the rows are locked first
--
-- The function locks the named people's rows of the school FOR NO KEY UPDATE,
-- in id order, before it asks anything, as app.gallring_claim_person locks
-- its one. A reactivation in flight is waited for; one that comes later
-- waits for this transaction. Every statement after the lock reads after the
-- wait (read committed: a new snapshot per statement), so the period in
-- force and app.gallring_due see the reactivation, the person is not due, and
-- nothing of theirs is touched. The count the function returns, and adds to
-- the run, is the people it pseudonymised. The job logs, by school id alone,
-- every claimed person it did not pseudonymise, and whether their login went
-- (src/gallring/gallring.job.ts).
--
-- Adding `NOT "isActive"` to the UPDATE's WHERE instead would skip the row,
-- but the statements after it remove guardian links, push devices, opt-outs
-- and notices by the same list of ids, and would still remove those of the
-- person made active again. Locking first gives one answer to all of them.
--
-- The lock is held until the call commits, one person long for the job. An
-- administrator who saves the person meanwhile waits for it, and then finds
-- a pseudonym, which UsersService answers with its 409 (no reactivation of a
-- pseudonym).
--
-- The adapter probe's (gg) holds a reactivation open across the call from a
-- second connection; RLS section 84 checks, in one connection, that every
-- named person of the school is locked whether they are due or not.

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
  UPDATE "TeacherEmployments" SET "signature" = NULL, "note" = NULL
   WHERE "schoolId" = r."schoolId" AND "userId" = ANY (due)
     AND ("signature" IS NOT NULL OR "note" IS NOT NULL);
  DELETE FROM "GuardianStudents"
   WHERE "schoolId" = r."schoolId" AND ("guardianId" = ANY (due) OR "studentId" = ANY (due));
  DELETE FROM "PushTickets" p USING "DevicePushTokens" t
   WHERE p."tokenId" = t."id" AND p."schoolId" = t."schoolId"
     AND t."schoolId" = r."schoolId" AND t."userId" = ANY (due);
  DELETE FROM "DevicePushTokens" WHERE "schoolId" = r."schoolId" AND "userId" = ANY (due);
  DELETE FROM "NotificationOptOuts" WHERE "schoolId" = r."schoolId" AND "userId" = ANY (due);
  DELETE FROM "Notifications" WHERE "schoolId" = r."schoolId" AND "userId" = ANY (due);
  PERFORM set_config('app.gallring', '', true);

  UPDATE "GallringRuns" SET
    "counts" = "counts" || jsonb_build_object('DEPARTED_PEOPLE', COALESCE(("counts" ->> 'DEPARTED_PEOPLE')::bigint, 0) + n),
    "cutoffs" = "cutoffs" || jsonb_build_object('DEPARTED_PEOPLE', cutoff::text)
   WHERE "id" = p_run;
  RETURN n;
END
$$;

COMMENT ON FUNCTION app.gallring_pseudonymise(uuid, uuid[]) IS
  'Locks the rows of p_users in the run''s school, then pseudonymises those still due: name, e-mail, phone, SS12000 id and login replaced; their tjänster''s signature and note cleared; their guardian links, push devices, notification opt-outs and all their own notices (whatever NOTIFICATIONS says) removed. Returns how many it pseudonymised.';
