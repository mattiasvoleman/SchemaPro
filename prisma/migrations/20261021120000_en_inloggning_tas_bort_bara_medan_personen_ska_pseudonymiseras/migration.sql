-- En slutad persons inloggning tas bort bara medan personen fortfarande ska
-- pseudonymiseras.
--
-- Amends 20261021110000 after a review. Nothing here can matter before a
-- school records a DEPARTED_PEOPLE period: until then no person is due, no
-- login is deleted and no row changes.
--
-- ## The login went before the last check
--
-- The nightly job read who was due (app.gallring_departed_due), deleted each
-- invited person's login at the auth provider, and only then asked again who
-- was due (app.gallring_pseudonymise). Somebody reactivated, or spared by a
-- decision, between the list and that last check kept their row and lost
-- their login.
--
-- app.gallring_claim_person(run, user) is asked for one person right before
-- their login is deleted. In its own short transaction it locks the person's
-- Users row FOR NO KEY UPDATE (the lock any UPDATE of the row takes), so a
-- reactivation in flight is waited for and then seen, and only then asks
-- app.gallring_due: still inactive, not yet a pseudonym, deactivated before
-- the run's cutoff (or the earlier cutoff of a period lengthened since), not
-- held for SCB, under a period still in force at clock_timestamp(). It
-- answers the person's authId and whether they were invited, or no row. The
-- job pseudonymises that person at once after the login goes
-- (src/gallring/gallring.job.ts), so what is left between the last check and
-- the pseudonym is one call to the provider for one person, not the night's
-- list. A reactivation inside that call still finds the person's login gone:
-- the provider is outside the transaction, and holding a row lock across its
-- call would let a slow provider stall the administrator instead. The job
-- logs it (school id only).
--
-- ## What pseudonymising removes
--
-- No change in what it does, only in what is said. Beyond name, e-mail,
-- phone, SS12000 id and login it clears the signature and note of the
-- person's tjänster and removes their guardian links (either side), push
-- devices, notification opt-outs and their own notices, all of them, whatever
-- the school decided for NOTIFICATIONS: a notice's meta names people, so a
-- notice kept under a pseudonym would still say whose it was. Notices to
-- others that name the person (a guardian's about a pupil) follow
-- NOTIFICATIONS. The page (/admin/dataskydd) and the manual (7.4) now list
-- all of it, and the function comments below say the same.
--
-- ## SCB's hold, one rule
--
-- app.gallring_held_for_scb holds a person with a tjänst in a läsår until
-- 1 December after that läsår's first 15 October, that is through
-- 30 November. 20261021110000 and the page also called it "less than seven
-- weeks" after 15 October, which reaches 2 December. The code's rule stands;
-- its comment now says it, and the page and the manual say "till och med
-- 30 november".
--
-- ## Links into LeaveRequests
--
-- 20261021110000 asked every foreign key into LeaveRequests to cascade, so
-- that a purged request takes nothing along and is never refused. That holds
-- for a row that is part of the request (an attachment, a decision step). A
-- row of ANOTHER kind of data that links to a request (an AbsenceReport for
-- a granted leave's day, say) must not cascade: a LEAVE_REQUESTS purge would
-- take it before its own period. Such a link is ON DELETE SET NULL, and the
-- row stays with the link gone. RLS section 81d accepts CASCADE and SET NULL
-- and refuses the rest.

CREATE FUNCTION app.gallring_claim_person(p_run uuid, p_user uuid)
RETURNS TABLE (auth_id uuid, invited boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  r "GallringRuns";
  cutoff date;
  today date;
BEGIN
  SELECT * INTO r FROM "GallringRuns" WHERE "id" = p_run AND "status" = 'RUNNING' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GALLRING_RUN_NOT_RUNNING' USING ERRCODE = 'GL404';
  END IF;
  -- The lock comes first: a reactivation in flight is waited for, one that
  -- comes later waits for this transaction, and every statement below reads
  -- after the wait (read committed: a new snapshot per statement).
  PERFORM 1 FROM "Users" u WHERE u."id" = p_user AND u."schoolId" = r."schoolId" FOR NO KEY UPDATE;
  IF NOT FOUND
     OR r."cutoffs" ->> 'DEPARTED_PEOPLE' IS NULL
     OR app.retention_months_in_force(r."schoolId", 'DEPARTED_PEOPLE', clock_timestamp()) IS NULL THEN
    RETURN;
  END IF;
  -- In variables, as in the run's other functions, so app.gallring_due is
  -- inlined and looks the one person up by id.
  cutoff := app.gallring_run_cutoff(r."schoolId", r."startedAt", r."cutoffs", 'DEPARTED_PEOPLE');
  today := app.gallring_today(r."schoolId", r."startedAt");
  RETURN QUERY
  SELECT u."authId", u."invitedAt" IS NOT NULL
    FROM app.gallring_due(r."schoolId", 'DEPARTED_PEOPLE', cutoff, today) d
    JOIN "Users" u ON u."id" = d."id"
   WHERE d."id" = p_user;
END
$$;

COMMENT ON FUNCTION app.gallring_claim_person(uuid, uuid) IS
  'For the nightly job, right before a departed person''s login is deleted: locks their Users row and answers their authId and whether they were invited only while they are still due under the period in force now; no row otherwise.';
COMMENT ON FUNCTION app.gallring_departed_due(uuid, integer) IS
  'The departed people a run may pseudonymise, oldest departure first; each is claimed (app.gallring_claim_person) before their login is deleted. Counts those held for SCB.';
COMMENT ON FUNCTION app.gallring_pseudonymise(uuid, uuid[]) IS
  'Pseudonymises those of p_users still due: name, e-mail, phone, SS12000 id and login replaced; their tjänster''s signature and note cleared; their guardian links, push devices, notification opt-outs and all their own notices (whatever NOTIFICATIONS says) removed.';
COMMENT ON FUNCTION app.gallring_held_for_scb(uuid, uuid, date) IS
  'Whether SCB''s underlag may still name the person: they have a tjänst in a läsår, and p_today is before 1 December after that läsår''s first 15 October (held through 30 November).';

DO $$
DECLARE
  r text;
BEGIN
  REVOKE ALL ON FUNCTION app.gallring_claim_person(uuid, uuid) FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION app.gallring_claim_person(uuid, uuid) FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT EXECUTE ON FUNCTION app.gallring_claim_person(uuid, uuid) TO "app_authenticated";
  END IF;
END
$$;
