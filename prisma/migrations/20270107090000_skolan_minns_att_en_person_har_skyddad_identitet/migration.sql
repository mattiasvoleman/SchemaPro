-- Skolan minns att en person har skyddad identitet.
--
-- A school can now say that a person has a protected identity (skyddad
-- identitet), and the files Rastra writes about people leave that person
-- out. Until now Rastra kept no such mark. The SS12000 sync read a person's
-- securityMarking on every run, held every change for that person for the
-- administrator's review, and forgot the marking when the run ended
-- (20261014110000). That kept a protected person out of the register only
-- while every change for them stayed unticked. A person whose changes an
-- administrator ticked, who was typed in by hand, read from a CSV file or
-- registered before the source marked them was an ordinary row, and went
-- out in elever.csv, in vardnadshavare.csv and in the guardian links in bulk
-- (the review of #261). This migration is the stored half;
-- src/users/person-protections.ts and the exports are the other.
--
-- ## PersonProtections: that the protection exists, never what it is
--
--   userId    the person; one row per person, keyed by the Users row
--   schoolId  their school
--   source    SS12000 (the sync wrote it) or MANUAL (an administrator did)
--
-- Nothing else. Not which protection (Sekretessmarkering or Skyddad
-- folkbokföring), not since when, not who set it.
--
-- A column on Users was rejected. Users is read by the person's teachers
-- (users_staff_select), by a guardian for their children and by the person
-- themselves (users_self_select), and a column would go with every one of
-- those reads. A table of its own is read by the arms below and no others.
--
-- ## Why this does not undo 20261014110000's minimisation
--
-- 20261014110000 decided that a run's names and addresses, and the flag
-- saying a person is protected, exist only while the run is DIFF_READY,
-- and are nulled the moment it ends. That decision served one purpose: an
-- administrator reviews a change before it is made. Once the change was
-- made or dropped, the payload had no use left, and keeping it would have
-- kept a second copy of the register. The flag went with it, because its
-- one use was to hold the change for review.
--
-- This migration serves a purpose the earlier one did not have: keeping a
-- protected person out of the files Rastra writes. A file is written on any
-- day, about people who may never have passed a sync, so the fact has to be
-- at hand then, and it has to be kept. What is kept is weighed against the
-- minimisation principle (GDPR art. 5.1 c) on its own terms:
--
--   * It is the least that serves: one bit, that a protection exists, and
--     where Rastra learnt it. The kind is not kept. Skyddad folkbokföring
--     tells a reader that the person lives hidden from somebody;
--     Sekretessmarkering says less. Nothing Rastra does with the mark tells
--     them apart, so the stored fact is the same for both and says less
--     than either. It is a fact that the protection exists, not a fact of
--     the protection.
--   * It is read where its purpose is: by the administrators who write the
--     files, and by the sync that keeps it. Teachers, pupils, guardians and
--     PostgREST's roles read nothing, as they read nothing of a run.
--   * It lasts as long as its purpose. The sync removes a mark it wrote when
--     the register says "Ingen" for the person; it goes with the person
--     (the key cascades), and when gallring pseudonymises a departed person
--     (app.gallring_pseudonymise, below).
--   * The run stays as minimal as before. The sync's change that sets or
--     lifts a mark (entity PROTECTION, below) names its person only in its
--     after, which the minimisation nulls; a finished run says how many
--     marks it set or lifted, never whose. The minimisation itself is not
--     touched: a change's before, after and protectedIdentity are nulled as
--     they were.
--
-- The alternative, asking the register when a file is written, was
-- rejected: it reaches only the people the sync has linked, makes every
-- export wait on the register, and holds the same fact in memory anyway.
--
-- ## The sync
--
-- Ss12000ChangeEntity gains PROTECTION, with op ADD (set the mark) or END
-- (lift it), so the sync shows the mark as a change before it makes it,
-- like every other change (src/integration/ss12000-sync/diff.ts):
--
--   * A person the register marks, already linked and with no mark here:
--     PROTECTION ADD, selected and made by the nightly auto-apply too. It
--     only takes the person out of files, so it is the one change about a
--     protected person that is automatic. protectedIdentity stays false on
--     it (Ss12000SyncChanges_protected_is_never_automatic).
--   * A person the register marks and this apply creates, links or relinks:
--     the apply writes the mark with that change, which stays deselected
--     for review as before; ticked, the person never exists unmarked.
--   * A mark the sync wrote, for a linked person whom a FULL run reads as
--     "Ingen" everywhere it names them, and as nothing else: PROTECTION
--     END, selected, never automatic. An absent marking is not "Ingen", and
--     an INCREMENTAL run lifts nothing, since it may not read the record
--     (a child's) that still marks the person. A MANUAL mark is the
--     administrator's and the sync never lifts it.
--
-- ## Who reads and who writes
--
-- Through the gateway only (app_authenticated); nothing for authenticated or
-- anon, service_role keeps its SELECT and nothing more, and MAINTAIN is the
-- owner's on 17. A mark is set or removed, never changed: no arm updates
-- and the API's role holds no UPDATE.
--
--   person_protections_admin_select   the school's SCHOOL_ADMIN, every
--                                     profile (they write the files)
--   person_protections_admin_insert   and whoever writes Personal
--   person_protections_admin_delete   (app.current_user_may('PERSONAL', true))
--   person_protections_sync_select    the sync principal of the school
--   person_protections_sync_insert    the same, and only source SS12000
--
-- The sync principal lifts nothing: an END is never automatic, so only an
-- administrator's apply removes a mark.
--
-- ## Keys
--
--   * ("userId", "schoolId") -> Users ("id", "schoolId") ON DELETE CASCADE:
--     the mark goes with the person. ON UPDATE NO ACTION, as every person
--     key since 20270102091000.
--   * "schoolId" -> Schools ON DELETE CASCADE.
--
-- ## Beside the live API: every lock at once, or none
--
-- The two keys take Users and Schools in SHARE ROW EXCLUSIVE, which blocks
-- writes to them (not reads, and not the KEY SHARE a key check takes) for
-- the length of the file; the new table is empty, so the keys validate
-- nothing. A request writes both in one transaction (a pupil's row and the
-- school's), so they are taken together, NOWAIT, in a loop: a refusal rolls
-- the subtransaction back with whatever it got and tries again 50 ms later;
-- it never waits while it holds a lock, and no request queues behind it.
-- After 30 s it stops with nothing changed: prisma migrate resolve
-- --rolled-back 20270107090000_skolan_minns_att_en_person_har_skyddad_identitet,
-- then deploy again. lock_timeout bounds any wait nobody foresaw. Adding a
-- value to Ss12000ChangeEntity and replacing app.gallring_pseudonymise lock
-- no table. Run it outside an SS12000 sync window, as 20261207090000.

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
        RAISE EXCEPTION 'Schools and Users were not free at once in 30 s: nothing is changed. Run: npx prisma migrate resolve --rolled-back 20270107090000_skolan_minns_att_en_person_har_skyddad_identitet, then deploy again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

CREATE TYPE "PersonProtectionSource" AS ENUM ('SS12000', 'MANUAL');

-- ---------------------------------------------------------------------------
-- PersonProtections
-- ---------------------------------------------------------------------------

CREATE TABLE "PersonProtections" (
    "userId"   UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "source"   "PersonProtectionSource" NOT NULL,

    CONSTRAINT "PersonProtections_pkey" PRIMARY KEY ("userId")
);

-- The school's list (the exports, the person page) and the school key's cascade.
CREATE INDEX "PersonProtections_schoolId_idx" ON "PersonProtections"("schoolId");

ALTER TABLE "PersonProtections"
    ADD CONSTRAINT "PersonProtections_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "PersonProtections"
    ADD CONSTRAINT "PersonProtections_userId_schoolId_fkey" FOREIGN KEY ("userId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;

COMMENT ON TABLE "PersonProtections" IS
  'Skyddad identitet: that the person has a protected identity and whether the SS12000 sync or an administrator said so; never which protection. Admin-only; every file of people leaves these persons out (20270107090000).';

-- ---------------------------------------------------------------------------
-- Row-level security and grants. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "PersonProtections" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    CREATE POLICY "person_protections_admin_select" ON "PersonProtections"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "person_protections_admin_insert" ON "PersonProtections"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('PERSONAL', true)));
    CREATE POLICY "person_protections_admin_delete" ON "PersonProtections"
        FOR DELETE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
               AND (select app.current_user_may('PERSONAL', true)));
    CREATE POLICY "person_protections_sync_select" ON "PersonProtections"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_sync_school_id()));
    CREATE POLICY "person_protections_sync_insert" ON "PersonProtections"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_sync_school_id())
                    AND "source" = 'SS12000');

    REVOKE ALL ON "PersonProtections" FROM "app_authenticated";
    GRANT SELECT, INSERT, DELETE ON "PersonProtections" TO "app_authenticated";
  END IF;

  FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "PersonProtections" FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "PersonProtections" FROM "service_role";
  END IF;
  -- PostgreSQL 17's MAINTAIN (REINDEX, CLUSTER, VACUUM, LOCK): the owner's alone.
  IF current_setting('server_version_num')::int >= 170000 THEN
    FOREACH r IN ARRAY ARRAY['authenticated', 'app_authenticated', 'service_role', 'anon'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE MAINTAIN ON "PersonProtections" FROM %I', r);
      END IF;
    END LOOP;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- PERSON_PROTECTION_REACH: the five arms above and no other; none for a
-- PostgREST role or the service principal. Each expression an arm has
-- (USING, WITH CHECK) names the caller's school (the login's, or the sync
-- principal's), has no OR and no NOT; an administrator's arm names the
-- SCHOOL_ADMIN role, and its writes the Personal area; the sync's insert
-- names the source SS12000. A name and a command alone would let
-- `USING (true)` through.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  bad text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    RETURN;
  END IF;
  SELECT string_agg(p.policyname || ' ' || p.cmd || ' ' || p.roles::text, ', ' ORDER BY p.policyname) INTO bad
    FROM pg_policies p
   WHERE p.schemaname = 'public'
     AND p.tablename = 'PersonProtections'
     AND NOT coalesce(
           p.roles = '{app_authenticated}'::name[]
           AND p.permissive = 'PERMISSIVE'
           AND (p.policyname, p.cmd) IN (
                 ('person_protections_admin_select', 'SELECT'),
                 ('person_protections_admin_insert', 'INSERT'),
                 ('person_protections_admin_delete', 'DELETE'),
                 ('person_protections_sync_select', 'SELECT'),
                 ('person_protections_sync_insert', 'INSERT'))
           AND (SELECT bool_and(
                         e NOT LIKE '% OR %'
                         AND e NOT LIKE '%NOT %'
                         AND CASE WHEN p.policyname LIKE '%\_admin\_%' ESCAPE '\'
                                  THEN e LIKE '%"schoolId" = ( SELECT app.current_school_id() AS current_school_id)%'
                                       AND e LIKE '%current_user_role()%= ''SCHOOL_ADMIN''::"UserRole"%'
                                       AND (p.cmd = 'SELECT' OR e LIKE '%current_user_may(''PERSONAL''::"AdminArea", true)%')
                                  ELSE e LIKE '%"schoolId" = ( SELECT app.current_sync_school_id() AS current_sync_school_id)%'
                                       AND (p.cmd = 'SELECT' OR e LIKE '%(source = ''SS12000''::"PersonProtectionSource")%')
                             END)
                  FROM unnest(ARRAY[p.qual, p.with_check]) e
                 WHERE e IS NOT NULL),
         false);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'PERSON_PROTECTION_REACH: these arms reach the marks beyond the administrator''s, Personal''s writes and the sync''s own: %', bad;
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'PersonProtections') <> 5 THEN
    RAISE EXCEPTION 'PERSON_PROTECTION_REACH: PersonProtections has % arms, not the five above',
      (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'PersonProtections');
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- app.gallring_pseudonymise: 20261207090000's body, and a pseudonym loses
-- its mark. The row stays as a pseudonym, which identifies nobody, and the
-- sync can no longer reach it (ss12000Id is cleared), so the mark has no
-- purpose left. A later release that restates the function must carry the
-- line marked "skyddad identitet".
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
  UPDATE "TeacherEmployments" SET "signature" = NULL, "note" = NULL
   WHERE "schoolId" = r."schoolId" AND "userId" = ANY (due)
     AND ("signature" IS NOT NULL OR "note" IS NOT NULL);
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
  'Locks the rows of p_users in the run''s school, then pseudonymises those still due: name, e-mail, phone, SS12000 id and login replaced; their tjänster''s signature and note, and their rastvaktspass'' notes, cleared; their guardian links, push devices, notification opt-outs, all their own notices (whatever NOTIFICATIONS says) and their mark of a protected identity removed. Returns how many it pseudonymised.';

-- ---------------------------------------------------------------------------
-- The sync's change that sets or lifts a mark. Not used in this file: a
-- value added to an enum may not be used in the transaction that adds it.
-- ---------------------------------------------------------------------------

ALTER TYPE "Ss12000ChangeEntity" ADD VALUE 'PROTECTION';
