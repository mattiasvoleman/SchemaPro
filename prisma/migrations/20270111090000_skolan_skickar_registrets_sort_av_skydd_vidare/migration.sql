-- Skolan skickar registrets sort av skydd vidare.
--
-- The systems a school connects over SS12000 (v2.0) now learn that a person
-- is protected, and how, when the register says so. Until now Rastra kept
-- only that a protection exists (20270107090000) and passed nothing on: a
-- connected system got the protected pupil with name, address, groups and
-- guardians and no marking, and could not protect them. The school chose to
-- pass the register's marking on (the review of #263, M1, path 2). S1's
-- securityMarking has no value for "protected, kind unknown", and sending
-- one kind for the other states a legal status the person does not have, so
-- passing it on needs the kind. This migration keeps it;
-- src/integration/ss12000-v2 sends it.
--
-- ## PersonProtections.kind: the register's kind, on the register's row
--
--   kind  SEKRETESSMARKERING or SKYDDAD_FOLKBOKFORING, or NULL
--
-- Only on the sync's row (source SS12000): a CHECK
-- (PersonProtections_a_kind_is_the_registers) holds a mark by hand to NULL.
-- An administrator's mark is the school's own judgement, often with no
-- marking at Skatteverket at all, and passing it on as one of the two would
-- state a status nobody gave. And only for a person linked to the register
-- (Users.ss12000Id): the sync marks a row it matched by address alone, so
-- that a pupil typed in by hand stays out of the files, but the address may
-- be another pupil's, and a legal status about the wrong person must not
-- leave (the review of #265, N3). Such a mark holds no kind until its link
-- is made, when the apply writes it; and the provider's read below sends a
-- kind for a linked person alone, whatever a row holds. NULL also on a row
-- the sync wrote before this file, until the next run that reads the person
-- writes the kind, and for a marking the sync did not recognise (the person
-- is protected all the same; nothing is passed on).
--
-- ## Why this keeps what 20270107090000 chose not to keep
--
-- 20270107090000 kept one bit, that a protection exists, and argued that
-- nothing Rastra did told the two kinds apart, so the kind was not kept.
-- Passing the marking on is now something Rastra does, and it needs the
-- kind. Weighed against the minimisation principle (GDPR art. 5.1 c):
--
--   * The purpose is the connected systems' own protection of the person.
--     They get the person anyway (the school decided which systems, and
--     what they read: the key's scopes); without the marking they treat a
--     protected pupil like any other. The marking is what S1 defines for
--     exactly that, and what the register itself sends.
--   * It is the least that serves: the register's current value and nothing
--     else, on the register's row alone. No date, no source document, no
--     history of kinds. A change at the register overwrites it (the sync's
--     PROTECTION UPDATE); a lift deletes the row, so the old kind is never
--     sent again, and nothing is sent in its place.
--   * Not in the history. PersonProtectionEvents records who set or removed
--     a mark: decisions at the school. A kind is the register's fact, not a
--     decision here, and a kind kept there would outlive the mark it came
--     with, which is what "never the old kind" rules out. A change of kind
--     writes no event (the events trigger is AFTER INSERT OR DELETE).
--   * Read by the same people as before, and by the provider for what it
--     sends. The column goes with the row: the school's administrators and
--     the sync principal read it, nobody else; no new arm reads the table.
--     The provider (the service principal of an integration key) reads it
--     through app.ss12000_security_markings() alone: the person and the kind
--     of the sync's marks of its own school, for linked persons, never a
--     mark by hand and never which persons carry one. It sends it where it sends the person
--     (scope persons.read), and on a reference to the person only with the
--     person's name (expandReferenceNames): a key that may not read persons
--     learns nothing of who is protected.
--   * Rastra itself still does nothing with the kind. No page shows it; the
--     files leave every marked person out as before, whatever the kind.
--   * The run stays as minimal as before: the kind rides in a change's
--     after, which the minimisation nulls with the person.
--
-- ## The sync
--
-- The sync reads the kind wherever the register names the person, and keeps
-- the stronger (Skyddad folkbokföring over Sekretessmarkering) when two
-- places differ: the register is never understated. A mark the sync sets on
-- a linked person carries the kind (PROTECTION ADD, and a person a CREATE,
-- LINK or RELINK makes or links, also over a mark set before on the address);
-- a mark the sync holds whose kind is not the one it should hold gets a
-- PROTECTION UPDATE, selected and made at night like an ADD, since it only
-- changes what the connected systems are told, to what the register itself
-- says. An INCREMENTAL run may not read every place that names the person,
-- so it only raises a kind; lowering one waits for a FULL run, as a lift
-- does (the review of #265, L1). Ss12000SyncChanges_a_mark_names_its_person_in_after_alone
-- therefore admits UPDATE beside ADD and END, still with no externalId and
-- no localId.
--
-- ## Who writes the kind
--
-- An UPDATE of the column kind alone, of the sync's rows alone:
--
--   person_protections_sync_update    the sync principal of the school, and
--                                     only source SS12000 (the nightly
--                                     auto-apply)
--   person_protections_admin_update   the school's SCHOOL_ADMIN who writes
--                                     Personal (asked in WITH CHECK, as
--                                     every update arm asks its area), and
--                                     only source SS12000 (an
--                                     administrator's apply of a run, as the
--                                     admin insert arm writes its marks)
--
-- The API's role gains UPDATE on the column kind and on nothing else; no
-- page and no endpoint writes it, only the apply. authenticated and anon
-- hold nothing, service_role keeps its SELECT alone.
--
-- ## meta.modified
--
-- A Person's meta.modified moves when what is sent about it moves: a mark of
-- the sync's with a kind set, its kind changed, or removed
-- (PersonProtections_ss12000_versions, app.ss12000_bump 'Person'). A mark by
-- hand moves nothing: nothing is sent for it. A reference to the person
-- carries the marking only with the person's name, which S1's Meta.modified
-- leaves out ("Attribut som kan tas fram med parametrarna expand eller
-- expandReferenceNames räknas inte"), so no group, duty, event or
-- attendance moves for it, as none moves for a new name. A person deleted
-- moves nothing here: the Users trigger buries them.
--
-- ## Locks: every lock at once, or none
--
-- The column, its CHECK, the arms and the trigger take PersonProtections in
-- ACCESS EXCLUSIVE; the replaced CHECK takes Ss12000SyncChanges in ACCESS
-- EXCLUSIVE, added NOT VALID (no PROTECTION UPDATE exists yet, and every row
-- written from now on is judged). An apply writes both in one transaction,
-- so the two are taken together, NOWAIT, in a loop: a refusal rolls the
-- subtransaction back with whatever it got and tries again 50 ms later; it
-- never waits while it holds a lock, and no request queues behind it. After
-- 30 s it stops with nothing changed: prisma migrate resolve --rolled-back
-- 20270111090000_skolan_skickar_registrets_sort_av_skydd_vidare, then
-- deploy again. The new CHECK on PersonProtections scans the table, which
-- holds a few rows per school, all with no kind. Run it outside an SS12000
-- sync window. No gallring function changes: a mark goes with the person,
-- kind and all.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "PersonProtections" IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Ss12000SyncChanges" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'PersonProtections and Ss12000SyncChanges were not free at once in 30 s: nothing is changed. Run: npx prisma migrate resolve --rolled-back 20270111090000_skolan_skickar_registrets_sort_av_skydd_vidare, then deploy again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- The kind
-- ---------------------------------------------------------------------------

CREATE TYPE "PersonProtectionKind" AS ENUM ('SEKRETESSMARKERING', 'SKYDDAD_FOLKBOKFORING');

ALTER TABLE "PersonProtections" ADD COLUMN "kind" "PersonProtectionKind";

ALTER TABLE "PersonProtections"
    ADD CONSTRAINT "PersonProtections_a_kind_is_the_registers"
    CHECK ("source" = 'SS12000' OR "kind" IS NULL);

COMMENT ON COLUMN "PersonProtections"."kind" IS
  'Which protection the register gives (SS12000 securityMarking), on the sync''s row alone; NULL on a mark by hand, on a row written before 20270111090000 until the next run, and for a marking not recognised. What the SS12000 v2.0 provider passes on; no page shows it.';

COMMENT ON TABLE "PersonProtections" IS
  'Skyddad identitet: that the person has a protected identity and whether the SS12000 sync or an administrator said so, a row each; on the sync''s row, which protection the register gives (kind, 20270111090000), passed on over SS12000 v2.0 and nothing else. Admin-only; every file of people leaves these persons out (20270107090000).';

-- ---------------------------------------------------------------------------
-- What the provider reads: the sync's kinds of its own school, nothing else
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.ss12000_security_markings()
RETURNS TABLE ("userId" uuid, "kind" "PersonProtectionKind")
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT p."userId", p."kind"
    FROM "PersonProtections" p
    JOIN "Users" u ON u."id" = p."userId" AND u."schoolId" = p."schoolId"
   WHERE app.current_service_school_id() IS NOT NULL
     AND p."schoolId" = app.current_service_school_id()
     AND p."source" = 'SS12000'
     AND p."kind" IS NOT NULL
     AND u."ss12000Id" IS NOT NULL
$$;

COMMENT ON FUNCTION app.ss12000_security_markings() IS
  'The SS12000 v2.0 provider''s securityMarking: the person and the register''s kind of the sync''s marks of the service principal''s own school, for a person linked to the register (20270111090000). Never a mark by hand, never a row matched by address alone, never another school.';

-- ---------------------------------------------------------------------------
-- meta.modified: a Person moves when what is sent about it moves
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.ss12000_v_protections() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" IS NOT NULL THEN
      PERFORM app.ss12000_bump(NEW."schoolId", 'Person', ARRAY[NEW."userId"]);
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW."kind" IS DISTINCT FROM OLD."kind" THEN
      PERFORM app.ss12000_bump(NEW."schoolId", 'Person', ARRAY[NEW."userId"]);
    END IF;
  ELSIF OLD."kind" IS NOT NULL
        AND EXISTS (SELECT 1 FROM "Users" u WHERE u."id" = OLD."userId" AND u."schoolId" = OLD."schoolId") THEN
    -- A lifted mark: the person is sent without it from now on. Not for a
    -- person being deleted (the key cascades): the Users trigger buries them.
    PERFORM app.ss12000_bump(OLD."schoolId", 'Person', ARRAY[OLD."userId"]);
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "PersonProtections_ss12000_versions"
    AFTER INSERT OR UPDATE OF "kind" OR DELETE ON "PersonProtections"
    FOR EACH ROW EXECUTE FUNCTION app.ss12000_v_protections();

REVOKE ALL ON FUNCTION app.ss12000_v_protections() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Who writes the kind
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  r text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    CREATE POLICY "person_protections_sync_update" ON "PersonProtections"
        FOR UPDATE TO "app_authenticated"
        USING ("schoolId" = (select app.current_sync_school_id())
               AND "source" = 'SS12000')
        WITH CHECK ("schoolId" = (select app.current_sync_school_id())
                    AND "source" = 'SS12000');
    -- The area in WITH CHECK alone, as every update arm asks it: in USING
    -- it would hand a row lock (FOR UPDATE) zero rows for a profile that
    -- reads the marks.
    CREATE POLICY "person_protections_admin_update" ON "PersonProtections"
        FOR UPDATE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
               AND "source" = 'SS12000')
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('PERSONAL', true))
                    AND "source" = 'SS12000');

    GRANT UPDATE ("kind") ON "PersonProtections" TO "app_authenticated";
  END IF;

  -- The provider's read: the API alone.
  REVOKE ALL ON FUNCTION app.ss12000_security_markings() FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION app.ss12000_security_markings() FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT EXECUTE ON FUNCTION app.ss12000_security_markings() TO "app_authenticated";
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- PERSON_PROTECTION_REACH, again: the six arms of 20270107090000 and the two
-- above, and no other; none for a PostgREST role or the service principal.
-- Each expression an arm has (USING, WITH CHECK) names the caller's school
-- (the login's, or the sync principal's), has no OR and no NOT; an
-- administrator's arm names the SCHOOL_ADMIN role, its insert and update the
-- Personal area (an update in its WITH CHECK, where every update arm asks
-- it), its delete the decisions; an update, the sync's or an
-- administrator's, names the source SS12000 in both expressions, as the
-- sync's insert does; the history is read and never written by an arm.
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
     AND p.tablename IN ('PersonProtections', 'PersonProtectionEvents')
     AND NOT coalesce(
           p.roles = '{app_authenticated}'::name[]
           AND p.permissive = 'PERMISSIVE'
           AND (p.tablename, p.policyname, p.cmd) IN (
                 ('PersonProtections', 'person_protections_admin_select', 'SELECT'),
                 ('PersonProtections', 'person_protections_admin_insert', 'INSERT'),
                 ('PersonProtections', 'person_protections_admin_update', 'UPDATE'),
                 ('PersonProtections', 'person_protections_admin_delete', 'DELETE'),
                 ('PersonProtections', 'person_protections_sync_select', 'SELECT'),
                 ('PersonProtections', 'person_protections_sync_insert', 'INSERT'),
                 ('PersonProtections', 'person_protections_sync_update', 'UPDATE'),
                 ('PersonProtectionEvents', 'person_protection_events_admin_select', 'SELECT'))
           AND (p.cmd <> 'UPDATE' OR (p.qual IS NOT NULL AND p.with_check IS NOT NULL))
           AND (SELECT bool_and(
                         e NOT LIKE '% OR %'
                         AND e NOT LIKE '%NOT %'
                         AND CASE WHEN p.policyname LIKE '%\_admin\_%' ESCAPE '\'
                                  THEN e LIKE '%"schoolId" = ( SELECT app.current_school_id() AS current_school_id)%'
                                       AND e LIKE '%current_user_role()%= ''SCHOOL_ADMIN''::"UserRole"%'
                                       AND (p.cmd <> 'INSERT' OR e LIKE '%current_user_may(''PERSONAL''::"AdminArea", true)%')
                                       AND (p.cmd <> 'UPDATE' OR u.i = 1 OR e LIKE '%current_user_may(''PERSONAL''::"AdminArea", true)%')
                                       AND (p.cmd <> 'UPDATE' OR e LIKE '%(source = ''SS12000''::"PersonProtectionSource")%')
                                       AND (p.cmd <> 'DELETE' OR e LIKE '%current_user_decides()%')
                                  ELSE e LIKE '%"schoolId" = ( SELECT app.current_sync_school_id() AS current_sync_school_id)%'
                                       AND (p.cmd = 'SELECT' OR e LIKE '%(source = ''SS12000''::"PersonProtectionSource")%')
                             END)
                  FROM unnest(ARRAY[p.qual, p.with_check]) WITH ORDINALITY AS u(e, i)
                 WHERE e IS NOT NULL),
         false);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'PERSON_PROTECTION_REACH: these arms reach the marks beyond the administrator''s, Personal''s and the decisions'' writes and the sync''s own: %', bad;
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('PersonProtections', 'PersonProtectionEvents')) <> 8 THEN
    RAISE EXCEPTION 'PERSON_PROTECTION_REACH: the marks and their history have % arms, not the eight above',
      (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('PersonProtections', 'PersonProtectionEvents'));
  END IF;
  -- The API's role updates the kind and no other column.
  IF EXISTS (
    SELECT 1 FROM information_schema.column_privileges c
     WHERE c.table_schema = 'public' AND c.table_name = 'PersonProtections'
       AND c.grantee = 'app_authenticated' AND c.privilege_type = 'UPDATE' AND c.column_name <> 'kind'
  ) THEN
    RAISE EXCEPTION 'PERSON_PROTECTION_REACH: the API''s role updates a column of the marks other than kind';
  END IF;
END
$$;
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The sync's change of kind: the person in its after alone, as before
-- ---------------------------------------------------------------------------

ALTER TABLE "Ss12000SyncChanges"
    DROP CONSTRAINT "Ss12000SyncChanges_a_mark_names_its_person_in_after_alone";
ALTER TABLE "Ss12000SyncChanges"
    ADD CONSTRAINT "Ss12000SyncChanges_a_mark_names_its_person_in_after_alone"
    CHECK ("entity"::text <> 'PROTECTION' OR ("op" IN ('ADD', 'UPDATE', 'END') AND "externalId" IS NULL AND "localId" IS NULL))
    NOT VALID;
