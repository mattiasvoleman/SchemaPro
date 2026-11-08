-- En tjänst har lönesystemets anställningsnummer.
--
-- Löneunderlaget (K1, 20270130090000; #290) names a person with a protected
-- identity by signature alone, never by name or e-mail: the file travels by
-- e-mail and shared folders. The payroll office then has nothing to book the
-- row on but what the school tells it. This column is what it books on: the
-- number the payroll system itself gives the anställning, which the school
-- writes on the teacher's post (tjänsten) and the file's column Löne-id
-- carries for everyone who has one, the marked and the unmarked alike.
--
--   * TeacherEmployments."payrollNumber"   text, NULL where the school has
--     written none. 1..30 characters, no leading or trailing space and no
--     control character (CHECK TeacherEmployments_payrollNumber_check): the
--     gateway trims and turns an empty value into NULL, so the CHECK only
--     ever refuses a writer that went around it.
--
-- ## On the post, not on the person
--
-- An anställningsnummer is the employment's, and an employment is a post: a
-- person who works at two schools of a huvudman has two posts and, as a rule,
-- two numbers. So it sits beside the tjänstgöringsgrad on the post of a läsår,
-- and the year's roll-forward copies it like the signature. A vikarie of the
-- pool has no post and so no number; the löneunderlag names a marked one by a
-- code of its own (20270206091000).
--
-- ## HR data, written by those who decide
--
-- Every administrator reads the post's row (row security cannot hide a
-- column), and the gateway hands this column to a reader without HR-läs as
-- NULL with hrHidden, like the tjänst % (src/staffing/hr-visibility.ts).
-- It is written as the rest of the post is: by rektor and a full
-- administrator (the post's arms, current_user_decides()), so no arm, grant
-- or policy changes. The post's versions (app.teacher_staffing_log) take the
-- column as they take every column; Historik shows it to a reader of HR data
-- and leaves a version that moved only it out for anybody else. No SS12000
-- feed selects it (src/integration/ss12000-duties.ts names its columns), and
-- the SS12000 version trigger does not watch it, so writing it moves no Duty.
--
-- ## Gallring
--
-- A pseudonym's posts lose their signature and note (20261021110000): the
-- number is as much the person's as the signature, so app.gallring_pseudonymise
-- clears it with them. The function is 20270107090000's body with that one
-- statement widened; no other line moves.
--
-- ## Beside the live API: TeacherEmployments at once, or nothing
--
-- ADD COLUMN and ADD CONSTRAINT take ACCESS EXCLUSIVE on TeacherEmployments,
-- which blocks every read of it for the length of the file. The column has
-- no default (no rewrite) and is NULL on every row, so the CHECK validates in
-- one pass over a table of one row per teacher and year. The lock is taken
-- NOWAIT, in a loop: a refusal rolls the subtransaction back and tries again
-- 50 ms later, so the migration never waits while it holds a lock and no
-- request queues behind it. After 30 s it stops with nothing done. The API
-- before this release never names the column and is unaffected; its PUT of a
-- post leaves the column as it is, since an absent payrollNumber is kept.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "TeacherEmployments" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'TeacherEmployments was not free in 30 s: nothing is changed (prisma migrate resolve --rolled-back 20270206090000_en_tjanst_har_lonesystemets_anstallningsnummer, then deploy)';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

ALTER TABLE "TeacherEmployments" ADD COLUMN "payrollNumber" TEXT;

ALTER TABLE "TeacherEmployments"
    ADD CONSTRAINT "TeacherEmployments_payrollNumber_check"
    CHECK ("payrollNumber" IS NULL
           OR (char_length("payrollNumber") BETWEEN 1 AND 30
               AND "payrollNumber" = btrim("payrollNumber")
               AND "payrollNumber" !~ '[[:cntrl:]]'));

COMMENT ON COLUMN "TeacherEmployments"."payrollNumber" IS
  'Löne-id: the payroll system''s own number for the anställning, written by the school on the post (1..30 characters, trimmed, no control character). HR data: the gateway hands it to an administrator without HR-läs as NULL. The löneunderlag''s Löne-id column (20270206090000).';

-- ---------------------------------------------------------------------------
-- app.gallring_pseudonymise: 20270107090000's body, and a pseudonym's posts
-- lose their payroll number with their signature and note. A later release
-- that restates the function must carry the lines marked "skyddad identitet"
-- and "Löne-id".
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
  'Locks the rows of p_users in the run''s school, then pseudonymises those still due: name, e-mail, phone, SS12000 id and login replaced; their tjänster''s signature, note and payroll number, and their rastvaktspass'' notes, cleared; their guardian links, push devices, notification opt-outs, all their own notices (whatever NOTIFICATIONS says) and their mark of a protected identity removed. Returns how many it pseudonymised.';
