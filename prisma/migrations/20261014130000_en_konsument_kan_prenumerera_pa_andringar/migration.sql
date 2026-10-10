-- En konsument kan prenumerera på ändringar.
--
-- The provider of "SS12000 both ways": what /ss12000/v2.0 needs from the
-- database to answer as SIS's SS12000 OpenAPI 2.1.0 says (S1:
-- openapi_ss12000_version2_1_0.yaml, korrigendum augusti 2022, sha256
-- aee9a95a4c5bd25cebaf357d266592f94e9388ae785ee9ac3b58e1992acccd28):
-- a Meta.modified that moves exactly when an attribute the object directly
-- carries moves, the ids /deletedEntities answers with, and the
-- subscriptions S1 defines (POST /subscriptions with a callback). Nothing
-- here changes a row of school data; every table is new, every trigger only
-- records that something the provider emits changed.
--
-- ## Ss12000EntityVersions: meta.modified
--
-- S1 Meta.modified (L8614-8638): "den senaste tidpunkt när något av de
-- attribut som direkt tillhör entiteten har ändrats. Attribut som kan tas
-- fram med parametrarna expand eller expandReferenceNames räknas inte".
-- updatedAt cannot say that: a Group's groupMemberships live in
-- StudentEnrollments and StudentGroupMembers, a Person's enrolments and
-- responsibles in two other tables, an Activity's displayName in the
-- subject's and the group's names, and an emitted id (the source's id once
-- an admin linked the row, 20261014100000) in a column whose change moves
-- every object that refers to it. So one row per (school, resource, entity),
-- PK (schoolId, resource, entityId), where entityId is SchemaPro's own id of
-- the row the object is built from (Users, StudentGroups, TeacherEmployments
-- for a Duty, MasterLessons — or a CalendarLesson for an ad-hoc lesson's own
-- Activity — CalendarLessons, Rooms, Subjects for a Syllabus, Schools for the
-- Organisation). createdAt is when the provider first saw it, modifiedAt the
-- transaction time of the last change, xid the changing transaction's
-- pg_current_xact_id(). An entity with no row yet (nothing changed since
-- this migration) is dated by its own updatedAt in the gateway; no backfill.
--
-- WRITTEN ONLY BY TRIGGERS, the P4 pattern (20261010120000): a BEFORE ROW
-- guard refuses every write at trigger depth 1 or less and a BEFORE
-- TRUNCATE guard refuses always (SQLSTATE SV403); the API holds SELECT
-- only. The one exception is app.ss12000_provider_housekeeping(), which
-- purges tombstones past their retention under a transaction-local flag it
-- sets itself.
--
-- STATEMENT-LEVEL triggers with transition tables, so a publish inserting
-- thousands of CalendarLessons costs one INSERT ... SELECT, not one per row.
-- PostgreSQL 16 refuses transition tables on a trigger with more than one
-- event ("transition tables cannot be specified for triggers with more than
-- one event") and on one with a column list, so each table has up to three
-- triggers (AFTER INSERT ... REFERENCING NEW TABLE, AFTER UPDATE ...
-- REFERENCING OLD TABLE NEW TABLE, AFTER DELETE ... REFERENCING OLD TABLE),
-- none with a column list, all calling one function that branches on TG_OP
-- and compares the emitted columns old against new by id with IS DISTINCT
-- FROM. What moves what:
--
--   Users            Person: names, email, role, isActive, ss12000Id.
--                    Deactivation and DELETE bury the emitted id;
--                    reactivation unburies it. A changed ss12000Id buries
--                    the old emitted id and moves every object that names
--                    the person: the groups listing them (enrolments,
--                    teaching memberships), the persons listing them in
--                    responsibles, the calendar events naming them in
--                    studentExceptions, their duties (person.id).
--   StudentEnrollments   the pupil (enrolments) and the class (groupMemberships).
--   StudentGroupMembers  the teaching group.
--   GuardianStudents     both persons (responsibles).
--   StudentGroups    Group: name, kind, gradeLevel (schoolType), year,
--                    ss12000Id; a rename or relink also moves the
--                    activities of the group (displayName, groups[]).
--   Rooms            Room: name, capacity.
--   Subjects         Syllabus: name, nationalCode; a rename moves the
--                    subject's activities (displayName).
--   TeacherEmployments   Duty; its arrival or removal moves the teacher's
--                    activities and calendar events (whether a Duty exists
--                    to reference).
--   TeacherDuties    the post's Duty (MENTORSKAP is Duty.assignmentRole).
--   Ss12000DutyLinks the post's Duty, the teacher's activities and calendar
--                    events (teachers[].duty.id, teacherExceptions); the
--                    duty ids no longer emitted are buried, the one emitted
--                    is unburied (A5.5's choice, app.ss12000_duty_id).
--   StaffingPolicies every Duty of the active year (the Fas 3 opt-in).
--   MasterLessons, MasterLessonGroups   Activity, ONLY in a DIRECT school and
--                    only in the active year: a DRAFT school's master is a
--                    draft (20261011100000) and an edit to it leaves no
--                    trace, moves no meta.modified and fires no notice.
--                    Parking buries, unparking unburies.
--   PublishedLessons (a DRAFT publish) every master of the new snapshot;
--                    the previous snapshot's masters absent from (or parked
--                    in) the new one are buried.
--   PublicationSettings  every activity of the school when publishMode
--                    switches, so the draft that became live is seen.
--   AcademicYearTimplans, LocalTimplans   the school types: the
--                    Organisation, every group, syllabus and activity.
--   AcademicYears    activation or new bounds: the year's groups, activities,
--                    duties and calendar events; the year that stops being
--                    active buries its activities and duties (v2 serves the
--                    active year's only, as v1 does).
--   Schools          the Organisation (displayName).
--   Ss12000Sources   organisationIds or schoolUnitCodes: the Organisation; a
--                    changed organisation id buries the old one and moves
--                    every object of the school (each carries the id).
--   CalendarLessons, CalendarLessonTeachers/Students/Groups,
--   PublicationPendingRemovals   CalendarEvent, and an ad-hoc lesson's own
--                    Activity (a lesson with no master and no pending
--                    removal: its Activity id is a UUIDv5 the gateway derives,
--                    so its tombstone is filed as 'AdhocActivity' under the
--                    lesson's id and translated when read).
--
-- A FUTURE YEAR NEVER LEAVES: a group, activity or calendar event whose
-- year is neither the active one nor a past one (startDate before the
-- active year's, or before tomorrow when none is active) records nothing;
-- app.ss12000_year_is_emitted() is the gateway's rule too
-- (src/integration/ss12000-v2/years.ts). Its rows are recorded when the
-- year is activated.
--
-- A tombstone or version for a school that no longer exists is skipped (a
-- school's deletion cascades through these triggers after its row is gone).
--
-- ## Ss12000Tombstones: /deletedEntities
--
-- One row per (school, resource, emittedId) — the id a consumer was given,
-- the source's when the row is linked — with removedAt and xid. A separate
-- table from the versions because a relink must keep both the live object
-- and the tombstone of the id it superseded. Same guard; kept 400 days
-- (app.ss12000_provider_housekeeping); an id that becomes live again is
-- unburied (its row deleted, by the trigger).
--
-- ## Notices that miss no late commit
--
-- modifiedAt is the transaction's start, so a long publish commits rows
-- dated earlier than a watermark already advanced past them. The delivery
-- therefore does not walk time: each subscription keeps an xid8 watermark,
-- and a notice covers the versions and tombstones with watermark <= xid <
-- pg_snapshot_xmin(pg_current_snapshot()) — every transaction below that
-- horizon has finished, so nothing committed is ever skipped (the outbox
-- pattern). The docs tell consumers to overlap meta.modified.after by ten
-- minutes, as our own consumer does; S1 is silent on it.
--
-- ## Ss12000Subscriptions and Ss12000SubscriptionDeliveries
--
-- S1's /subscriptions: CreateSubscription {name, target, resourceTypes:
-- [{resource: EndPointsEnum}]}, Subscription adds {id, expires}, PATCH (no
-- body) renews the expiry, DELETE ends it. The callback POSTs
-- {"modifiedEntites": [...], "deletedEntities": bool} (S1's spelling). Inert
-- until a consumer registers one: no row, no work beyond one indexed claim
-- query a minute.
--
--   * keyId: composite (keyId, schoolId) key to IntegrationApiKeys; a key
--     sees only its own (the service arms name app.current_service_key_id(),
--     the setting withServicePrincipal now takes beside the school).
--   * name 1..200; target https, at most 2048, no userinfo, query allowed
--     (a receiver's own routing), no fragment; the gateway vets its
--     addresses at creation and at every delivery and pins the connection.
--   * resourceTypes 1..8 of the EndPointsEnum values the provider emits.
--   * expiresAt (now + 30 days, PATCH renews), endedAt (DELETE: the row
--     stays as the record), suspendedAt/suspendedReason (FAILING after 72 h
--     of failed deliveries, ADMIN when the school paused it; a key's PATCH
--     clears FAILING, never ADMIN).
--   * watermark xid8, lastNotifiedAt, nextAttemptAt, attempts,
--     failingSince, claimedAt: written by the delivery functions only.
--   * A BEFORE UPDATE guard narrows what a service principal (expiry, end,
--     clearing its own FAILING suspension) and an admin (pausing and
--     resuming) may change (SS403).
--
-- Deliveries: one row per attempt (status, outcome code, duration), no body
-- and no header; kept 30 days. Written only by
-- app.ss12000_notification_settled.
--
-- Delivery functions, for the delivery context only (no claims and no
-- principal: app.ss12000_is_delivery_context(), 20261014120000), else SS403:
--   app.ss12000_due_notifications(limit)  claims due subscriptions FOR
--     UPDATE SKIP LOCKED (live, unexpired, not suspended, live key) that
--     have changes in their resource types below the horizon, with the
--     changed types, whether anything was buried, and the horizon.
--   app.ss12000_notification_settled(...)  records the attempt; success
--     moves the watermark to the horizon; failure schedules the next
--     attempt the gateway chose (with jitter) and suspends after 72 h.
--   app.ss12000_provider_housekeeping(now)  purges tombstones after 400
--     days, deliveries after 30, and releases claims older than 5 minutes.
--
-- ## The provider reads, and what it may not
--
-- app.current_service_key_id(): NULLIF(current_setting('app.service_key_id',
-- true), '')::uuid, PUBLIC's EXECUTE kept (the arms carry no TO, as
-- app.current_service_school_id() and app.current_sync_school_id()).
--
-- New SELECT arms for the service principal of the row's school:
-- StudentEnrollments (Group.groupMemberships, Person.enrolments),
-- StudentGroupMembers (teaching groups' memberships), AcademicYearTimplans
-- and LocalTimplans (schoolType), Ss12000DutyLinks (the source's Duty ids,
-- no HR figure), Ss12000EntityVersions and Ss12000Tombstones. Each is what a
-- v2 resource emits and nothing more is selected.
--
-- No service arm on Ss12000Sources: an arm cannot restrict columns, and the
-- service principal would read baseUrl, tokenUrl and clientId.
-- app.ss12000_provider_identity() (SECURITY DEFINER) hands it the two
-- columns it needs, organisationIds and schoolUnitCodes, for its own school
-- only.
--
-- ## Grants
--
-- Guarded. app_authenticated: SELECT on versions, tombstones and
-- deliveries; SELECT, INSERT, UPDATE on subscriptions; no DELETE or
-- TRUNCATE anywhere here. authenticated: no write beyond the arms; anon
-- nothing; service_role no write. Functions: EXECUTE for app_authenticated
-- only, except the trigger functions (no EXECUTE for anyone) and
-- app.current_service_key_id() (PUBLIC). The migration ends with
-- SS12000_PROVIDER_REACH.

-- ---------------------------------------------------------------------------
-- Tables.
-- ---------------------------------------------------------------------------

CREATE TABLE "Ss12000EntityVersions" (
    "schoolId"   UUID NOT NULL,
    "resource"   TEXT NOT NULL,
    "entityId"   UUID NOT NULL,
    "createdAt"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "modifiedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "xid"        XID8 NOT NULL DEFAULT pg_current_xact_id(),

    CONSTRAINT "Ss12000EntityVersions_pkey" PRIMARY KEY ("schoolId", "resource", "entityId"),
    CONSTRAINT "Ss12000EntityVersions_resource_is_emitted" CHECK ("resource" IN
        ('Organisation', 'Person', 'Group', 'Duty', 'Activity', 'CalendarEvent', 'Room', 'Syllabus'))
);

CREATE INDEX "Ss12000EntityVersions_modified_idx" ON "Ss12000EntityVersions"("schoolId", "resource", "modifiedAt");
CREATE INDEX "Ss12000EntityVersions_xid_idx" ON "Ss12000EntityVersions"("schoolId", "xid");

ALTER TABLE "Ss12000EntityVersions"
    ADD CONSTRAINT "Ss12000EntityVersions_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Ss12000Tombstones" (
    "schoolId"  UUID NOT NULL,
    "resource"  TEXT NOT NULL,
    "emittedId" UUID NOT NULL,
    "removedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "xid"       XID8 NOT NULL DEFAULT pg_current_xact_id(),

    CONSTRAINT "Ss12000Tombstones_pkey" PRIMARY KEY ("schoolId", "resource", "emittedId"),
    CONSTRAINT "Ss12000Tombstones_resource_is_emitted" CHECK ("resource" IN
        ('Organisation', 'Person', 'Group', 'Duty', 'Activity', 'AdhocActivity', 'CalendarEvent', 'Room', 'Syllabus'))
);

CREATE INDEX "Ss12000Tombstones_removedAt_idx" ON "Ss12000Tombstones"("schoolId", "removedAt");
CREATE INDEX "Ss12000Tombstones_xid_idx" ON "Ss12000Tombstones"("schoolId", "xid");

ALTER TABLE "Ss12000Tombstones"
    ADD CONSTRAINT "Ss12000Tombstones_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Ss12000Subscriptions" (
    "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"        UUID NOT NULL,
    "keyId"           UUID NOT NULL,
    "name"            TEXT NOT NULL,
    "target"          TEXT NOT NULL,
    "resourceTypes"   TEXT[] NOT NULL,
    "expiresAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT (now() + interval '30 days'),
    "endedAt"         TIMESTAMPTZ(6),
    "suspendedAt"     TIMESTAMPTZ(6),
    "suspendedReason" TEXT,
    "watermark"       XID8 NOT NULL DEFAULT pg_snapshot_xmin(pg_current_snapshot()),
    "lastNotifiedAt"  TIMESTAMPTZ(6),
    "nextAttemptAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "attempts"        INTEGER NOT NULL DEFAULT 0,
    "failingSince"    TIMESTAMPTZ(6),
    "claimedAt"       TIMESTAMPTZ(6),
    "createdAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "Ss12000Subscriptions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Ss12000Subscriptions_name_is_sane" CHECK (char_length(btrim("name")) BETWEEN 1 AND 200),
    CONSTRAINT "Ss12000Subscriptions_target_is_https" CHECK (
        char_length("target") <= 2048
        AND "target" ~ '^https://[^/?#@[:space:]]+(/[^#[:space:]]*)?$'),
    CONSTRAINT "Ss12000Subscriptions_resourceTypes_are_emitted" CHECK (
        cardinality("resourceTypes") BETWEEN 1 AND 8
        AND array_position("resourceTypes", NULL) IS NULL
        AND "resourceTypes" <@ ARRAY['Organisation', 'Person', 'Group', 'Duty', 'Activity', 'CalendarEvent', 'Room', 'Syllabus']::text[]),
    CONSTRAINT "Ss12000Subscriptions_suspension_is_whole" CHECK (
        ("suspendedAt" IS NULL) = ("suspendedReason" IS NULL)
        AND ("suspendedReason" IS NULL OR "suspendedReason" IN ('FAILING', 'ADMIN'))),
    CONSTRAINT "Ss12000Subscriptions_attempts_are_counted" CHECK ("attempts" BETWEEN 0 AND 100000)
);

CREATE UNIQUE INDEX "Ss12000Subscriptions_id_schoolId_key" ON "Ss12000Subscriptions"("id", "schoolId");
CREATE INDEX "Ss12000Subscriptions_key_idx" ON "Ss12000Subscriptions"("keyId", "schoolId");
CREATE INDEX "Ss12000Subscriptions_due_idx" ON "Ss12000Subscriptions"("nextAttemptAt")
    WHERE "endedAt" IS NULL AND "suspendedAt" IS NULL;

ALTER TABLE "Ss12000Subscriptions"
    ADD CONSTRAINT "Ss12000Subscriptions_keyId_schoolId_fkey"
    FOREIGN KEY ("keyId", "schoolId") REFERENCES "IntegrationApiKeys"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Ss12000SubscriptionDeliveries" (
    "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"       UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "attemptedAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "httpStatus"     INTEGER,
    "outcome"        TEXT NOT NULL,
    "durationMs"     INTEGER NOT NULL,

    CONSTRAINT "Ss12000SubscriptionDeliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Ss12000SubscriptionDeliveries_outcome_is_a_code" CHECK ("outcome" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
    CONSTRAINT "Ss12000SubscriptionDeliveries_httpStatus_is_http" CHECK ("httpStatus" IS NULL OR "httpStatus" BETWEEN 100 AND 599),
    CONSTRAINT "Ss12000SubscriptionDeliveries_durationMs_is_sane" CHECK ("durationMs" BETWEEN 0 AND 600000)
);

CREATE INDEX "Ss12000SubscriptionDeliveries_subscription_idx" ON "Ss12000SubscriptionDeliveries"("subscriptionId", "schoolId", "attemptedAt");
CREATE INDEX "Ss12000SubscriptionDeliveries_attemptedAt_idx" ON "Ss12000SubscriptionDeliveries"("attemptedAt");

ALTER TABLE "Ss12000SubscriptionDeliveries"
    ADD CONSTRAINT "Ss12000SubscriptionDeliveries_subscription_fkey"
    FOREIGN KEY ("subscriptionId", "schoolId") REFERENCES "Ss12000Subscriptions"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- The service key, and the provider's identity.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.current_service_key_id() RETURNS uuid
LANGUAGE sql STABLE SET search_path = "public", "pg_temp" AS $$
  SELECT NULLIF(current_setting('app.service_key_id', true), '')::uuid
$$;

COMMENT ON FUNCTION app.current_service_key_id() IS
  'The integration key an SS12000 v2.0 request authenticated with, or NULL. Set transaction-locally by PrismaService.withServicePrincipal.';

CREATE FUNCTION app.ss12000_provider_identity()
RETURNS TABLE (organisation_ids uuid[], school_unit_codes text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT s."organisationIds", s."schoolUnitCodes"
    FROM "Ss12000Sources" s
   WHERE app.current_service_school_id() IS NOT NULL
     AND s."schoolId" = app.current_service_school_id()
$$;

COMMENT ON FUNCTION app.ss12000_provider_identity() IS
  'The source''s organisation ids and skolenhetskoder of the service principal''s own school; never another column of the source.';

-- ---------------------------------------------------------------------------
-- The guard: only the triggers write versions and tombstones.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.ss12000_versions_written_by_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF TG_OP <> 'TRUNCATE'
     AND (pg_trigger_depth() > 1 OR current_setting('app.ss12000_housekeeping', true) = 'on') THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'SS12000_VERSIONS_ARE_RECORDED: integrationens versioner skrivs bara av databasen när det som lämnas ut ändras'
    USING ERRCODE = 'SV403', DETAIL = format('table=%s operation=%s', TG_TABLE_NAME, TG_OP);
END
$$;

CREATE TRIGGER "Ss12000EntityVersions_written_by_trigger"
    BEFORE INSERT OR UPDATE OR DELETE ON "Ss12000EntityVersions"
    FOR EACH ROW EXECUTE FUNCTION app.ss12000_versions_written_by_trigger();
CREATE TRIGGER "Ss12000EntityVersions_no_truncate"
    BEFORE TRUNCATE ON "Ss12000EntityVersions"
    FOR EACH STATEMENT EXECUTE FUNCTION app.ss12000_versions_written_by_trigger();
CREATE TRIGGER "Ss12000Tombstones_written_by_trigger"
    BEFORE INSERT OR UPDATE OR DELETE ON "Ss12000Tombstones"
    FOR EACH ROW EXECUTE FUNCTION app.ss12000_versions_written_by_trigger();
CREATE TRIGGER "Ss12000Tombstones_no_truncate"
    BEFORE TRUNCATE ON "Ss12000Tombstones"
    FOR EACH STATEMENT EXECUTE FUNCTION app.ss12000_versions_written_by_trigger();

-- ---------------------------------------------------------------------------
-- The recorders. Called by the trigger functions below, never by the API.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.ss12000_bump(p_school uuid, p_resource text, p_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF p_school IS NULL OR p_ids IS NULL OR cardinality(p_ids) = 0
     OR NOT EXISTS (SELECT 1 FROM "Schools" s WHERE s."id" = p_school) THEN
    RETURN;
  END IF;
  INSERT INTO "Ss12000EntityVersions" AS v ("schoolId", "resource", "entityId", "createdAt", "modifiedAt", "xid")
  SELECT p_school, p_resource, d.id, now(), now(), pg_current_xact_id()
    FROM (SELECT DISTINCT x AS id FROM unnest(p_ids) x WHERE x IS NOT NULL) d
  ON CONFLICT ("schoolId", "resource", "entityId") DO UPDATE
     SET "modifiedAt" = EXCLUDED."modifiedAt", "xid" = EXCLUDED."xid"
   WHERE v."xid" IS DISTINCT FROM EXCLUDED."xid";
END
$$;

CREATE FUNCTION app.ss12000_bury(p_school uuid, p_resource text, p_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF p_school IS NULL OR p_ids IS NULL OR cardinality(p_ids) = 0
     OR NOT EXISTS (SELECT 1 FROM "Schools" s WHERE s."id" = p_school) THEN
    RETURN;
  END IF;
  INSERT INTO "Ss12000Tombstones" AS t ("schoolId", "resource", "emittedId", "removedAt", "xid")
  SELECT p_school, p_resource, d.id, now(), pg_current_xact_id()
    FROM (SELECT DISTINCT x AS id FROM unnest(p_ids) x WHERE x IS NOT NULL) d
  ON CONFLICT ("schoolId", "resource", "emittedId") DO UPDATE
     SET "removedAt" = EXCLUDED."removedAt", "xid" = EXCLUDED."xid"
   WHERE t."xid" IS DISTINCT FROM EXCLUDED."xid";
END
$$;

CREATE FUNCTION app.ss12000_unbury(p_school uuid, p_resource text, p_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF p_school IS NULL OR p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    RETURN;
  END IF;
  DELETE FROM "Ss12000Tombstones" t
   WHERE t."schoolId" = p_school AND t."resource" = p_resource AND t."emittedId" = ANY (p_ids);
END
$$;

-- Active, or past: started before the active year (or before tomorrow when
-- the school has none). The gateway's rule too (years.ts).
CREATE FUNCTION app.ss12000_year_is_emitted(p_year uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT EXISTS (
    SELECT 1 FROM "AcademicYears" y
     WHERE y."id" = p_year
       AND (y."isActive" OR y."startDate" < coalesce(
             (SELECT a."startDate" FROM "AcademicYears" a WHERE a."schoolId" = y."schoolId" AND a."isActive"),
             current_date + 1)))
$$;

CREATE FUNCTION app.ss12000_active_year(p_school uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT a."id" FROM "AcademicYears" a WHERE a."schoolId" = p_school AND a."isActive"
$$;

-- A5.5: the earliest active teaching-role link of the year, then the
-- lowest id; else the year's post. src/integration/ss12000-v2/duty-ids.ts
-- is the same rule.
CREATE FUNCTION app.ss12000_duty_id(p_school uuid, p_user uuid, p_year uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT coalesce(
    (SELECT l."ss12000DutyId" FROM "Ss12000DutyLinks" l
      WHERE l."schoolId" = p_school AND l."userId" = p_user AND l."academicYearId" = p_year AND l."endedAt" IS NULL
        AND l."dutyRole" IN ('Lärare', 'Förstelärare', 'Speciallärare/specialpedagog', 'Lärarassistent', 'Fritidspedagog', 'Förskollärare')
      ORDER BY l."startDate", l."id" LIMIT 1),
    (SELECT e."id" FROM "TeacherEmployments" e
      WHERE e."schoolId" = p_school AND e."userId" = p_user AND e."academicYearId" = p_year))
$$;

CREATE FUNCTION app.ss12000_bump_groups(p_school uuid, p_ids uuid[]) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT app.ss12000_bump(p_school, 'Group', ARRAY(
    SELECT g."id" FROM "StudentGroups" g
     WHERE g."schoolId" = p_school AND g."id" = ANY (p_ids) AND app.ss12000_year_is_emitted(g."academicYearId")))
$$;

CREATE FUNCTION app.ss12000_bump_lessons(p_school uuid, p_ids uuid[]) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT app.ss12000_bump(p_school, 'CalendarEvent', ARRAY(
    SELECT c."id" FROM "CalendarLessons" c JOIN "StudentGroups" g ON g."id" = c."studentGroupId"
     WHERE c."schoolId" = p_school AND c."id" = ANY (p_ids) AND app.ss12000_year_is_emitted(g."academicYearId")))
$$;

-- The activities that name any of the groups, subjects or teachers (null:
-- every activity of the active year): the active year's masters in a DIRECT
-- school, the masters of the active year's snapshots, and the ad-hoc
-- lessons of the active year.
CREATE FUNCTION app.ss12000_bump_activities(p_school uuid, p_groups uuid[], p_subjects uuid[], p_teachers uuid[], p_all boolean)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  yr uuid := app.ss12000_active_year(p_school);
  direct boolean := app.school_publish_mode(p_school) = 'DIRECT';
BEGIN
  IF yr IS NULL THEN
    RETURN;
  END IF;
  PERFORM app.ss12000_bump(p_school, 'Activity', ARRAY(
    SELECT m."id" FROM "MasterLessons" m
     WHERE direct AND m."schoolId" = p_school AND m."academicYearId" = yr AND NOT m."isParked"
       AND (p_all
            OR m."studentGroupId" = ANY (p_groups) OR m."subjectId" = ANY (p_subjects)
            OR m."teacherId" = ANY (p_teachers) OR m."coTeacherId" = ANY (p_teachers)
            OR EXISTS (SELECT 1 FROM "MasterLessonGroups" mg WHERE mg."masterLessonId" = m."id" AND mg."studentGroupId" = ANY (p_groups)))
    UNION
    SELECT p."masterLessonId" FROM "PublishedLessons" p
     WHERE p."schoolId" = p_school AND p."academicYearId" = yr AND NOT p."isParked"
       AND (p_all
            OR p."studentGroupId" = ANY (p_groups) OR p."subjectId" = ANY (p_subjects)
            OR p."teacherId" = ANY (p_teachers) OR p."coTeacherId" = ANY (p_teachers)
            OR p."extraGroupIds" && p_groups)
    UNION
    SELECT c."id" FROM "CalendarLessons" c JOIN "StudentGroups" g ON g."id" = c."studentGroupId"
     WHERE c."schoolId" = p_school AND g."academicYearId" = yr AND c."masterLessonId" IS NULL
       AND (p_all OR c."studentGroupId" = ANY (p_groups) OR c."subjectId" = ANY (p_subjects)
            OR EXISTS (SELECT 1 FROM "CalendarLessonTeachers" ct WHERE ct."calendarLessonId" = c."id" AND ct."teacherId" = ANY (p_teachers))
            OR EXISTS (SELECT 1 FROM "CalendarLessonGroups" cg WHERE cg."calendarLessonId" = c."id" AND cg."studentGroupId" = ANY (p_groups)))));
END
$$;

-- Every object of the school: an organisation id changed, and every object
-- carries it.
CREATE FUNCTION app.ss12000_bump_school(p_school uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  PERFORM app.ss12000_bump(p_school, 'Organisation', ARRAY[p_school]);
  PERFORM app.ss12000_bump(p_school, 'Person', ARRAY(SELECT u."id" FROM "Users" u WHERE u."schoolId" = p_school AND u."isActive"));
  PERFORM app.ss12000_bump_groups(p_school, ARRAY(SELECT g."id" FROM "StudentGroups" g WHERE g."schoolId" = p_school));
  PERFORM app.ss12000_bump(p_school, 'Duty', ARRAY(
    SELECT e."id" FROM "TeacherEmployments" e WHERE e."schoolId" = p_school AND e."academicYearId" = app.ss12000_active_year(p_school)));
  PERFORM app.ss12000_bump(p_school, 'Room', ARRAY(SELECT r."id" FROM "Rooms" r WHERE r."schoolId" = p_school));
  PERFORM app.ss12000_bump_activities(p_school, NULL, NULL, NULL, true);
  PERFORM app.ss12000_bump_lessons(p_school, ARRAY(SELECT c."id" FROM "CalendarLessons" c WHERE c."schoolId" = p_school));
END
$$;

-- ---------------------------------------------------------------------------
-- The trigger functions, one per table. Each is attached as up to three
-- statement-level triggers (see the preamble).
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.ss12000_v_users() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR r IN SELECT n."schoolId" s, array_agg(n."id") ids FROM n WHERE n."isActive" GROUP BY 1 LOOP
      PERFORM app.ss12000_bump(r.s, 'Person', r.ids);
    END LOOP;
  ELSIF TG_OP = 'UPDATE' THEN
    FOR r IN
      SELECT n."schoolId" s, array_agg(n."id") ids FROM n JOIN o ON o."id" = n."id"
       WHERE (n."firstName", n."lastName", n."email", n."role", n."isActive", n."ss12000Id")
             IS DISTINCT FROM (o."firstName", o."lastName", o."email", o."role", o."isActive", o."ss12000Id")
       GROUP BY 1
    LOOP
      PERFORM app.ss12000_bump(r.s, 'Person', r.ids);
    END LOOP;
    -- Deactivated, or relinked: the id the consumer had is gone.
    FOR r IN
      SELECT o."schoolId" s, array_agg(coalesce(o."ss12000Id", o."id")) ids FROM n JOIN o ON o."id" = n."id"
       WHERE o."isActive" AND (NOT n."isActive" OR o."ss12000Id" IS DISTINCT FROM n."ss12000Id")
       GROUP BY 1
    LOOP
      PERFORM app.ss12000_bury(r.s, 'Person', r.ids);
    END LOOP;
    -- Live again under an id: no longer deleted.
    FOR r IN
      SELECT n."schoolId" s, array_agg(coalesce(n."ss12000Id", n."id")) ids FROM n JOIN o ON o."id" = n."id"
       WHERE n."isActive" AND (NOT o."isActive" OR o."ss12000Id" IS DISTINCT FROM n."ss12000Id")
       GROUP BY 1
    LOOP
      PERFORM app.ss12000_unbury(r.s, 'Person', r.ids);
    END LOOP;
    -- The emitted id moved: everything that names the person moves (A5.3).
    FOR r IN
      SELECT n."schoolId" s, array_agg(n."id") ids FROM n JOIN o ON o."id" = n."id"
       WHERE o."ss12000Id" IS DISTINCT FROM n."ss12000Id" AND n."isActive"
       GROUP BY 1
    LOOP
      PERFORM app.ss12000_bump_groups(r.s, ARRAY(
        SELECT e."studentGroupId" FROM "StudentEnrollments" e WHERE e."studentId" = ANY (r.ids) AND e."studentGroupId" IS NOT NULL
        UNION SELECT m."studentGroupId" FROM "StudentGroupMembers" m WHERE m."studentId" = ANY (r.ids)));
      PERFORM app.ss12000_bump(r.s, 'Person', ARRAY(
        SELECT gs."studentId" FROM "GuardianStudents" gs WHERE gs."guardianId" = ANY (r.ids)
        UNION SELECT gs."guardianId" FROM "GuardianStudents" gs WHERE gs."studentId" = ANY (r.ids)));
      PERFORM app.ss12000_bump_lessons(r.s, ARRAY(
        SELECT cs."calendarLessonId" FROM "CalendarLessonStudents" cs WHERE cs."studentId" = ANY (r.ids)));
      PERFORM app.ss12000_bump(r.s, 'Duty', ARRAY(
        SELECT e."id" FROM "TeacherEmployments" e WHERE e."userId" = ANY (r.ids)));
    END LOOP;
  ELSE
    FOR r IN SELECT o."schoolId" s, array_agg(coalesce(o."ss12000Id", o."id")) ids FROM o WHERE o."isActive" GROUP BY 1 LOOP
      PERFORM app.ss12000_bury(r.s, 'Person', r.ids);
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION app.ss12000_v_enrollments() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record;
BEGIN
  IF TG_OP <> 'DELETE' THEN
    FOR r IN SELECT x."schoolId" s, array_agg(DISTINCT x."studentId") pupils, array_agg(DISTINCT x."studentGroupId") groups FROM n x GROUP BY 1 LOOP
      PERFORM app.ss12000_bump(r.s, 'Person', r.pupils);
      PERFORM app.ss12000_bump_groups(r.s, r.groups);
    END LOOP;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    FOR r IN SELECT x."schoolId" s, array_agg(DISTINCT x."studentId") pupils, array_agg(DISTINCT x."studentGroupId") groups FROM o x GROUP BY 1 LOOP
      PERFORM app.ss12000_bump(r.s, 'Person', r.pupils);
      PERFORM app.ss12000_bump_groups(r.s, r.groups);
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION app.ss12000_v_group_members() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record;
BEGIN
  IF TG_OP <> 'DELETE' THEN
    FOR r IN SELECT x."schoolId" s, array_agg(DISTINCT x."studentGroupId") groups FROM n x GROUP BY 1 LOOP
      PERFORM app.ss12000_bump_groups(r.s, r.groups);
    END LOOP;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    FOR r IN SELECT x."schoolId" s, array_agg(DISTINCT x."studentGroupId") groups FROM o x GROUP BY 1 LOOP
      PERFORM app.ss12000_bump_groups(r.s, r.groups);
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION app.ss12000_v_guardians() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record;
BEGIN
  IF TG_OP <> 'DELETE' THEN
    FOR r IN SELECT x."schoolId" s, array_agg(x."guardianId") || array_agg(x."studentId") ids FROM n x GROUP BY 1 LOOP
      PERFORM app.ss12000_bump(r.s, 'Person', r.ids);
    END LOOP;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    FOR r IN SELECT x."schoolId" s, array_agg(x."guardianId") || array_agg(x."studentId") ids FROM o x GROUP BY 1 LOOP
      PERFORM app.ss12000_bump(r.s, 'Person', r.ids);
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION app.ss12000_v_groups() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR r IN SELECT n."schoolId" s, array_agg(n."id") ids FROM n GROUP BY 1 LOOP
      PERFORM app.ss12000_bump_groups(r.s, r.ids);
    END LOOP;
  ELSIF TG_OP = 'UPDATE' THEN
    FOR r IN
      SELECT n."schoolId" s, array_agg(n."id") ids FROM n JOIN o ON o."id" = n."id"
       WHERE (n."name", n."kind", n."gradeLevel", n."academicYearId", n."ss12000Id")
             IS DISTINCT FROM (o."name", o."kind", o."gradeLevel", o."academicYearId", o."ss12000Id")
       GROUP BY 1
    LOOP
      PERFORM app.ss12000_bump_groups(r.s, r.ids);
    END LOOP;
    FOR r IN
      SELECT n."schoolId" s, array_agg(n."id") ids FROM n JOIN o ON o."id" = n."id"
       WHERE (n."name", n."ss12000Id") IS DISTINCT FROM (o."name", o."ss12000Id")
       GROUP BY 1
    LOOP
      PERFORM app.ss12000_bump_activities(r.s, r.ids, NULL, NULL, false);
    END LOOP;
    FOR r IN
      SELECT n."schoolId" s, array_agg(coalesce(o."ss12000Id", o."id")) old_ids, array_agg(coalesce(n."ss12000Id", n."id")) new_ids
        FROM n JOIN o ON o."id" = n."id"
       WHERE o."ss12000Id" IS DISTINCT FROM n."ss12000Id" AND app.ss12000_year_is_emitted(n."academicYearId")
       GROUP BY 1
    LOOP
      PERFORM app.ss12000_bury(r.s, 'Group', r.old_ids);
      PERFORM app.ss12000_unbury(r.s, 'Group', r.new_ids);
    END LOOP;
  ELSE
    FOR r IN
      SELECT o."schoolId" s, array_agg(coalesce(o."ss12000Id", o."id")) ids FROM o
       WHERE app.ss12000_year_is_emitted(o."academicYearId") GROUP BY 1
    LOOP
      PERFORM app.ss12000_bury(r.s, 'Group', r.ids);
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION app.ss12000_v_rooms() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR r IN SELECT n."schoolId" s, array_agg(n."id") ids FROM n GROUP BY 1 LOOP
      PERFORM app.ss12000_bump(r.s, 'Room', r.ids);
    END LOOP;
  ELSIF TG_OP = 'UPDATE' THEN
    FOR r IN
      SELECT n."schoolId" s, array_agg(n."id") ids FROM n JOIN o ON o."id" = n."id"
       WHERE (n."name", n."capacity") IS DISTINCT FROM (o."name", o."capacity") GROUP BY 1
    LOOP
      PERFORM app.ss12000_bump(r.s, 'Room', r.ids);
    END LOOP;
  ELSE
    FOR r IN SELECT o."schoolId" s, array_agg(o."id") ids FROM o GROUP BY 1 LOOP
      PERFORM app.ss12000_bury(r.s, 'Room', r.ids);
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION app.ss12000_v_subjects() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR r IN SELECT n."schoolId" s, array_agg(n."id") ids FROM n GROUP BY 1 LOOP
      PERFORM app.ss12000_bump(r.s, 'Syllabus', r.ids);
    END LOOP;
  ELSIF TG_OP = 'UPDATE' THEN
    FOR r IN
      SELECT n."schoolId" s, array_agg(n."id") ids FROM n JOIN o ON o."id" = n."id"
       WHERE (n."name", n."nationalCode") IS DISTINCT FROM (o."name", o."nationalCode") GROUP BY 1
    LOOP
      PERFORM app.ss12000_bump(r.s, 'Syllabus', r.ids);
    END LOOP;
    FOR r IN
      SELECT n."schoolId" s, array_agg(n."id") ids FROM n JOIN o ON o."id" = n."id"
       WHERE n."name" IS DISTINCT FROM o."name" GROUP BY 1
    LOOP
      PERFORM app.ss12000_bump_activities(r.s, NULL, r.ids, NULL, false);
    END LOOP;
  ELSE
    FOR r IN SELECT o."schoolId" s, array_agg(o."id") ids FROM o GROUP BY 1 LOOP
      PERFORM app.ss12000_bury(r.s, 'Syllabus', r.ids);
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION app.ss12000_v_employments() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    FOR r IN
      SELECT n."schoolId" s, array_agg(n."id") ids FROM n JOIN o ON o."id" = n."id"
       WHERE (n."employmentPercent", n."signature", n."contractKind", n."userId", n."academicYearId")
             IS DISTINCT FROM (o."employmentPercent", o."signature", o."contractKind", o."userId", o."academicYearId")
       GROUP BY 1
    LOOP
      PERFORM app.ss12000_bump(r.s, 'Duty', r.ids);
    END LOOP;
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    FOR r IN SELECT n."schoolId" s, array_agg(n."id") ids, array_agg(DISTINCT n."userId") users FROM n GROUP BY 1 LOOP
      PERFORM app.ss12000_bump(r.s, 'Duty', r.ids);
      PERFORM app.ss12000_unbury(r.s, 'Duty', r.ids);
      PERFORM app.ss12000_bump_activities(r.s, NULL, NULL, r.users, false);
      PERFORM app.ss12000_bump_lessons(r.s, ARRAY(SELECT ct."calendarLessonId" FROM "CalendarLessonTeachers" ct WHERE ct."teacherId" = ANY (r.users)));
    END LOOP;
  ELSE
    FOR r IN SELECT o."schoolId" s, array_agg(o."id") ids, array_agg(DISTINCT o."userId") users FROM o GROUP BY 1 LOOP
      PERFORM app.ss12000_bury(r.s, 'Duty', r.ids);
      PERFORM app.ss12000_bump_activities(r.s, NULL, NULL, r.users, false);
      PERFORM app.ss12000_bump_lessons(r.s, ARRAY(SELECT ct."calendarLessonId" FROM "CalendarLessonTeachers" ct WHERE ct."teacherId" = ANY (r.users)));
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION app.ss12000_v_teacher_duties() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record;
BEGIN
  IF TG_OP <> 'DELETE' THEN
    FOR r IN
      SELECT x."schoolId" s, array_agg(DISTINCT e."id") ids FROM n x
        JOIN "TeacherEmployments" e ON e."schoolId" = x."schoolId" AND e."userId" = x."userId" AND e."academicYearId" = x."academicYearId"
       WHERE x."kind" = 'MENTORSKAP' GROUP BY 1
    LOOP
      PERFORM app.ss12000_bump(r.s, 'Duty', r.ids);
    END LOOP;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    FOR r IN
      SELECT x."schoolId" s, array_agg(DISTINCT e."id") ids FROM o x
        JOIN "TeacherEmployments" e ON e."schoolId" = x."schoolId" AND e."userId" = x."userId" AND e."academicYearId" = x."academicYearId"
       WHERE x."kind" = 'MENTORSKAP' GROUP BY 1
    LOOP
      PERFORM app.ss12000_bump(r.s, 'Duty', r.ids);
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION app.ss12000_duty_links_moved(p_school uuid, p_user uuid, p_year uuid, p_duty_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE current_id uuid := app.ss12000_duty_id(p_school, p_user, p_year);
BEGIN
  PERFORM app.ss12000_bump(p_school, 'Duty', ARRAY(
    SELECT e."id" FROM "TeacherEmployments" e WHERE e."schoolId" = p_school AND e."userId" = p_user AND e."academicYearId" = p_year));
  PERFORM app.ss12000_bury(p_school, 'Duty', ARRAY(
    SELECT d FROM unnest(p_duty_ids || ARRAY(
      SELECT e."id" FROM "TeacherEmployments" e WHERE e."schoolId" = p_school AND e."userId" = p_user AND e."academicYearId" = p_year)) d
     WHERE d IS DISTINCT FROM current_id));
  IF current_id IS NOT NULL THEN
    PERFORM app.ss12000_unbury(p_school, 'Duty', ARRAY[current_id]);
  END IF;
  PERFORM app.ss12000_bump_activities(p_school, NULL, NULL, ARRAY[p_user], false);
  PERFORM app.ss12000_bump_lessons(p_school, ARRAY(SELECT ct."calendarLessonId" FROM "CalendarLessonTeachers" ct WHERE ct."teacherId" = p_user));
END
$$;

CREATE FUNCTION app.ss12000_v_duty_links() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record;
BEGIN
  IF TG_OP <> 'DELETE' THEN
    FOR r IN SELECT x."schoolId" s, x."userId" u, x."academicYearId" y, array_agg(DISTINCT x."ss12000DutyId") ids FROM n x GROUP BY 1, 2, 3 LOOP
      PERFORM app.ss12000_duty_links_moved(r.s, r.u, r.y, r.ids);
    END LOOP;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    FOR r IN SELECT x."schoolId" s, x."userId" u, x."academicYearId" y, array_agg(DISTINCT x."ss12000DutyId") ids FROM o x GROUP BY 1, 2, 3 LOOP
      PERFORM app.ss12000_duty_links_moved(r.s, r.u, r.y, r.ids);
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION app.ss12000_v_staffing_policies() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR r IN SELECT DISTINCT x."schoolId" s FROM n x LOOP
      PERFORM app.ss12000_bump(r.s, 'Duty', ARRAY(
        SELECT e."id" FROM "TeacherEmployments" e WHERE e."schoolId" = r.s AND e."academicYearId" = app.ss12000_active_year(r.s)));
    END LOOP;
  ELSE
    FOR r IN
      SELECT DISTINCT x."schoolId" s FROM n x JOIN o y ON y."id" = x."id"
       WHERE (x."shareEmploymentWithIntegrations", x."fullTimeAnnualHours") IS DISTINCT FROM (y."shareEmploymentWithIntegrations", y."fullTimeAnnualHours")
    LOOP
      PERFORM app.ss12000_bump(r.s, 'Duty', ARRAY(
        SELECT e."id" FROM "TeacherEmployments" e WHERE e."schoolId" = r.s AND e."academicYearId" = app.ss12000_active_year(r.s)));
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION app.ss12000_v_masters() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR r IN
      SELECT n."schoolId" s, array_agg(n."id") ids FROM n
       WHERE NOT n."isParked" AND n."academicYearId" = app.ss12000_active_year(n."schoolId")
         AND app.school_publish_mode(n."schoolId") = 'DIRECT'
       GROUP BY 1
    LOOP
      PERFORM app.ss12000_bump(r.s, 'Activity', r.ids);
      PERFORM app.ss12000_unbury(r.s, 'Activity', r.ids);
    END LOOP;
  ELSIF TG_OP = 'UPDATE' THEN
    FOR r IN
      SELECT n."schoolId" s,
             array_agg(n."id") FILTER (WHERE NOT n."isParked") live,
             array_agg(n."id") FILTER (WHERE n."isParked") parked
        FROM n JOIN o ON o."id" = n."id"
       WHERE (n."subjectId", n."studentGroupId", n."teacherId", n."coTeacherId", n."startDate", n."endDate", n."isParked", n."academicYearId")
             IS DISTINCT FROM (o."subjectId", o."studentGroupId", o."teacherId", o."coTeacherId", o."startDate", o."endDate", o."isParked", o."academicYearId")
         AND n."academicYearId" = app.ss12000_active_year(n."schoolId")
         AND app.school_publish_mode(n."schoolId") = 'DIRECT'
       GROUP BY 1
    LOOP
      PERFORM app.ss12000_bump(r.s, 'Activity', r.live);
      PERFORM app.ss12000_unbury(r.s, 'Activity', r.live);
      PERFORM app.ss12000_bury(r.s, 'Activity', r.parked);
    END LOOP;
  ELSE
    FOR r IN
      SELECT o."schoolId" s, array_agg(o."id") ids FROM o
       WHERE NOT o."isParked" AND o."academicYearId" = app.ss12000_active_year(o."schoolId")
         AND app.school_publish_mode(o."schoolId") = 'DIRECT'
       GROUP BY 1
    LOOP
      PERFORM app.ss12000_bury(r.s, 'Activity', r.ids);
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION app.ss12000_v_master_groups() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record; ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF TG_OP <> 'DELETE' THEN
    ids := ids || ARRAY(SELECT x."masterLessonId" FROM n x);
  END IF;
  IF TG_OP <> 'INSERT' THEN
    ids := ids || ARRAY(SELECT x."masterLessonId" FROM o x);
  END IF;
  FOR r IN
    SELECT m."schoolId" s, array_agg(m."id") ids FROM "MasterLessons" m
     WHERE m."id" = ANY (ids) AND NOT m."isParked" AND m."academicYearId" = app.ss12000_active_year(m."schoolId")
       AND app.school_publish_mode(m."schoolId") = 'DIRECT'
     GROUP BY 1
  LOOP
    PERFORM app.ss12000_bump(r.s, 'Activity', r.ids);
  END LOOP;
  RETURN NULL;
END
$$;

CREATE FUNCTION app.ss12000_v_published() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record; previous uuid;
BEGIN
  FOR r IN
    SELECT n."schoolId" s, n."publicationId" pub, n."academicYearId" y,
           array_agg(n."masterLessonId") FILTER (WHERE NOT n."isParked") live
      FROM n
     WHERE n."academicYearId" = app.ss12000_active_year(n."schoolId")
     GROUP BY 1, 2, 3
  LOOP
    PERFORM app.ss12000_bump(r.s, 'Activity', r.live);
    PERFORM app.ss12000_unbury(r.s, 'Activity', r.live);
    SELECT p."id" INTO previous FROM "TimetablePublications" p
     WHERE p."schoolId" = r.s AND p."academicYearId" = r.y AND p."id" <> r.pub
       AND EXISTS (SELECT 1 FROM "PublishedLessons" q WHERE q."publicationId" = p."id")
     ORDER BY p."publishedAt" DESC LIMIT 1;
    IF previous IS NOT NULL THEN
      PERFORM app.ss12000_bury(r.s, 'Activity', ARRAY(
        SELECT q."masterLessonId" FROM "PublishedLessons" q
         WHERE q."publicationId" = previous AND NOT q."isParked"
           AND NOT (q."masterLessonId" = ANY (coalesce(r.live, ARRAY[]::uuid[])))));
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

CREATE FUNCTION app.ss12000_v_publication_settings() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR r IN SELECT DISTINCT x."schoolId" s FROM n x WHERE x."publishMode" <> 'DIRECT' LOOP
      PERFORM app.ss12000_publish_mode_switched(r.s);
    END LOOP;
  ELSE
    FOR r IN SELECT DISTINCT x."schoolId" s FROM n x JOIN o y ON y."id" = x."id" WHERE x."publishMode" IS DISTINCT FROM y."publishMode" LOOP
      PERFORM app.ss12000_publish_mode_switched(r.s);
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;

-- Every activity the school served or now serves moves: the active year's
-- masters (DIRECT's activities, and the draft that may now be live) and the
-- snapshots' masters.
CREATE FUNCTION app.ss12000_publish_mode_switched(p_school uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  PERFORM app.ss12000_bump_activities(p_school, NULL, NULL, NULL, true);
  PERFORM app.ss12000_bump(p_school, 'Activity', ARRAY(
    SELECT m."id" FROM "MasterLessons" m
     WHERE m."schoolId" = p_school AND m."academicYearId" = app.ss12000_active_year(p_school) AND NOT m."isParked"));
END
$$;

CREATE FUNCTION app.ss12000_school_types_moved(p_school uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  PERFORM app.ss12000_bump(p_school, 'Organisation', ARRAY[p_school]);
  PERFORM app.ss12000_bump_groups(p_school, ARRAY(SELECT g."id" FROM "StudentGroups" g WHERE g."schoolId" = p_school));
  PERFORM app.ss12000_bump(p_school, 'Syllabus', ARRAY(SELECT sj."id" FROM "Subjects" sj WHERE sj."schoolId" = p_school));
  PERFORM app.ss12000_bump_activities(p_school, NULL, NULL, NULL, true);
  PERFORM app.ss12000_bump(p_school, 'Person', ARRAY(
    SELECT u."id" FROM "Users" u WHERE u."schoolId" = p_school AND u."role" = 'STUDENT' AND u."isActive"));
END
$$;

CREATE FUNCTION app.ss12000_v_school_types() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record;
BEGIN
  IF TG_TABLE_NAME = 'LocalTimplans' THEN
    FOR r IN SELECT DISTINCT x."schoolId" s FROM n x JOIN o y ON y."id" = x."id" WHERE x."schoolForm" IS DISTINCT FROM y."schoolForm" LOOP
      PERFORM app.ss12000_school_types_moved(r.s);
    END LOOP;
    RETURN NULL;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    FOR r IN SELECT DISTINCT x."schoolId" s FROM n x LOOP
      PERFORM app.ss12000_school_types_moved(r.s);
    END LOOP;
  ELSE
    FOR r IN SELECT DISTINCT x."schoolId" s FROM o x LOOP
      PERFORM app.ss12000_school_types_moved(r.s);
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION app.ss12000_v_years() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT n."schoolId" s, n."id" y, o."isActive" was_active, n."isActive" is_active
      FROM n JOIN o ON o."id" = n."id"
     WHERE (n."isActive", n."startDate", n."endDate") IS DISTINCT FROM (o."isActive", o."startDate", o."endDate")
  LOOP
    IF app.ss12000_year_is_emitted(r.y) THEN
      PERFORM app.ss12000_bump_groups(r.s, ARRAY(SELECT g."id" FROM "StudentGroups" g WHERE g."academicYearId" = r.y));
      PERFORM app.ss12000_bump_lessons(r.s, ARRAY(
        SELECT c."id" FROM "CalendarLessons" c JOIN "StudentGroups" g ON g."id" = c."studentGroupId" WHERE g."academicYearId" = r.y));
    END IF;
    IF r.is_active THEN
      PERFORM app.ss12000_bump_activities(r.s, NULL, NULL, NULL, true);
      PERFORM app.ss12000_bump(r.s, 'Duty', ARRAY(SELECT e."id" FROM "TeacherEmployments" e WHERE e."academicYearId" = r.y));
      PERFORM app.ss12000_unbury(r.s, 'Duty', ARRAY(SELECT e."id" FROM "TeacherEmployments" e WHERE e."academicYearId" = r.y));
    ELSIF r.was_active THEN
      -- v2 serves the active year's activities and duties; this year's go.
      PERFORM app.ss12000_bury(r.s, 'Activity', ARRAY(
        SELECT m."id" FROM "MasterLessons" m WHERE m."academicYearId" = r.y
        UNION SELECT p."masterLessonId" FROM "PublishedLessons" p WHERE p."academicYearId" = r.y));
      PERFORM app.ss12000_bury(r.s, 'Duty', ARRAY(
        SELECT app.ss12000_duty_id(r.s, e."userId", r.y) FROM "TeacherEmployments" e WHERE e."academicYearId" = r.y
        UNION SELECT e."id" FROM "TeacherEmployments" e WHERE e."academicYearId" = r.y));
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

CREATE FUNCTION app.ss12000_v_schools() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT n."id" s FROM n JOIN o ON o."id" = n."id" WHERE n."name" IS DISTINCT FROM o."name" LOOP
    PERFORM app.ss12000_bump(r.s, 'Organisation', ARRAY[r.s]);
  END LOOP;
  RETURN NULL;
END
$$;

CREATE FUNCTION app.ss12000_v_sources() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR r IN SELECT x."schoolId" s, x."organisationIds" orgs FROM n x LOOP
      IF cardinality(r.orgs) > 0 THEN
        PERFORM app.ss12000_organisation_moved(r.s, ARRAY[]::uuid[], r.orgs);
      END IF;
    END LOOP;
  ELSE
    FOR r IN
      SELECT x."schoolId" s, y."organisationIds" old_orgs, x."organisationIds" new_orgs,
             y."schoolUnitCodes" IS DISTINCT FROM x."schoolUnitCodes" codes_moved
        FROM n x JOIN o y ON y."id" = x."id"
    LOOP
      IF r.old_orgs IS DISTINCT FROM r.new_orgs THEN
        PERFORM app.ss12000_organisation_moved(r.s, r.old_orgs, r.new_orgs);
      ELSIF r.codes_moved THEN
        PERFORM app.ss12000_bump(r.s, 'Organisation', ARRAY[r.s]);
      END IF;
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;

-- The emitted organisation id is the source's when exactly one is chosen,
-- else the school's own (ids.ts); every object carries it.
CREATE FUNCTION app.ss12000_organisation_moved(p_school uuid, p_old uuid[], p_new uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  was uuid := CASE WHEN cardinality(p_old) = 1 THEN p_old[1] ELSE p_school END;
  now_id uuid := CASE WHEN cardinality(p_new) = 1 THEN p_new[1] ELSE p_school END;
BEGIN
  IF was IS DISTINCT FROM now_id THEN
    PERFORM app.ss12000_bury(p_school, 'Organisation', ARRAY[was]);
    PERFORM app.ss12000_unbury(p_school, 'Organisation', ARRAY[now_id]);
  END IF;
  PERFORM app.ss12000_bump_school(p_school);
END
$$;

CREATE FUNCTION app.ss12000_v_lessons() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR r IN
      SELECT n."schoolId" s, array_agg(n."id") ids, array_agg(n."id") FILTER (WHERE n."masterLessonId" IS NULL) adhoc
        FROM n GROUP BY 1
    LOOP
      PERFORM app.ss12000_bump_lessons(r.s, r.ids);
      PERFORM app.ss12000_bump(r.s, 'Activity', ARRAY(
        SELECT c."id" FROM "CalendarLessons" c JOIN "StudentGroups" g ON g."id" = c."studentGroupId"
         WHERE c."id" = ANY (coalesce(r.adhoc, ARRAY[]::uuid[])) AND g."academicYearId" = app.ss12000_active_year(r.s)));
    END LOOP;
  ELSIF TG_OP = 'UPDATE' THEN
    FOR r IN
      SELECT n."schoolId" s, array_agg(n."id") ids,
             array_agg(n."id") FILTER (WHERE n."masterLessonId" IS NULL) adhoc,
             array_agg(n."id") FILTER (WHERE n."masterLessonId" IS NOT NULL AND o."masterLessonId" IS NULL) keyed
        FROM n JOIN o ON o."id" = n."id"
       WHERE (n."masterLessonId", n."startsAt", n."endsAt", n."status", n."roomId", n."subjectId", n."studentGroupId")
             IS DISTINCT FROM (o."masterLessonId", o."startsAt", o."endsAt", o."status", o."roomId", o."subjectId", o."studentGroupId")
       GROUP BY 1
    LOOP
      PERFORM app.ss12000_bump_lessons(r.s, r.ids);
      PERFORM app.ss12000_bump(r.s, 'Activity', ARRAY(
        SELECT c."id" FROM "CalendarLessons" c JOIN "StudentGroups" g ON g."id" = c."studentGroupId"
         WHERE c."id" = ANY (coalesce(r.adhoc, ARRAY[]::uuid[])) AND g."academicYearId" = app.ss12000_active_year(r.s)
           AND NOT EXISTS (SELECT 1 FROM "PublicationPendingRemovals" pr WHERE pr."calendarLessonId" = c."id")));
      PERFORM app.ss12000_unbury(r.s, 'AdhocActivity', r.adhoc);
      PERFORM app.ss12000_bury(r.s, 'AdhocActivity', r.keyed);
    END LOOP;
  ELSE
    FOR r IN
      SELECT o."schoolId" s, array_agg(o."id") ids, array_agg(o."id") FILTER (WHERE o."masterLessonId" IS NULL) adhoc
        FROM o
        LEFT JOIN "StudentGroups" g ON g."id" = o."studentGroupId"
       WHERE g."id" IS NULL OR app.ss12000_year_is_emitted(g."academicYearId")
       GROUP BY 1
    LOOP
      PERFORM app.ss12000_bury(r.s, 'CalendarEvent', r.ids);
      PERFORM app.ss12000_bury(r.s, 'AdhocActivity', r.adhoc);
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;

-- CalendarLessonTeachers, CalendarLessonStudents, CalendarLessonGroups and
-- PublicationPendingRemovals: the lesson they belong to.
CREATE FUNCTION app.ss12000_v_lesson_parts() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE r record; ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF TG_OP <> 'DELETE' THEN
    ids := ids || ARRAY(SELECT x."calendarLessonId" FROM n x);
  END IF;
  IF TG_OP <> 'INSERT' THEN
    ids := ids || ARRAY(SELECT x."calendarLessonId" FROM o x);
  END IF;
  FOR r IN SELECT c."schoolId" s, array_agg(c."id") ids FROM "CalendarLessons" c WHERE c."id" = ANY (ids) GROUP BY 1 LOOP
    PERFORM app.ss12000_bump_lessons(r.s, r.ids);
    -- An ad-hoc lesson's own Activity carries its groups; a pending removal
    -- decides whether the lesson is ad-hoc at all.
    IF TG_TABLE_NAME IN ('CalendarLessonGroups', 'PublicationPendingRemovals') THEN
      PERFORM app.ss12000_bump(r.s, 'Activity', ARRAY(
        SELECT c."id" FROM "CalendarLessons" c JOIN "StudentGroups" g ON g."id" = c."studentGroupId"
         WHERE c."id" = ANY (r.ids) AND c."masterLessonId" IS NULL AND g."academicYearId" = app.ss12000_active_year(r.s)
           AND NOT EXISTS (SELECT 1 FROM "PublicationPendingRemovals" pr WHERE pr."calendarLessonId" = c."id")));
    END IF;
    IF TG_TABLE_NAME = 'PublicationPendingRemovals' THEN
      IF TG_OP = 'INSERT' THEN
        PERFORM app.ss12000_bury(r.s, 'AdhocActivity', r.ids);
      ELSIF TG_OP = 'DELETE' THEN
        PERFORM app.ss12000_unbury(r.s, 'AdhocActivity', ARRAY(
          SELECT c."id" FROM "CalendarLessons" c WHERE c."id" = ANY (r.ids) AND c."masterLessonId" IS NULL));
      END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

-- ---------------------------------------------------------------------------
-- The triggers: up to three per table, no column lists.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  spec record;
BEGIN
  FOR spec IN SELECT * FROM (VALUES
      ('Users', 'app.ss12000_v_users()', true, true, true),
      ('StudentEnrollments', 'app.ss12000_v_enrollments()', true, true, true),
      ('StudentGroupMembers', 'app.ss12000_v_group_members()', true, true, true),
      ('GuardianStudents', 'app.ss12000_v_guardians()', true, true, true),
      ('StudentGroups', 'app.ss12000_v_groups()', true, true, true),
      ('Rooms', 'app.ss12000_v_rooms()', true, true, true),
      ('Subjects', 'app.ss12000_v_subjects()', true, true, true),
      ('TeacherEmployments', 'app.ss12000_v_employments()', true, true, true),
      ('TeacherDuties', 'app.ss12000_v_teacher_duties()', true, true, true),
      ('Ss12000DutyLinks', 'app.ss12000_v_duty_links()', true, true, true),
      ('StaffingPolicies', 'app.ss12000_v_staffing_policies()', true, true, false),
      ('MasterLessons', 'app.ss12000_v_masters()', true, true, true),
      ('MasterLessonGroups', 'app.ss12000_v_master_groups()', true, true, true),
      ('PublishedLessons', 'app.ss12000_v_published()', true, false, false),
      ('PublicationSettings', 'app.ss12000_v_publication_settings()', true, true, false),
      ('AcademicYearTimplans', 'app.ss12000_v_school_types()', true, true, true),
      ('LocalTimplans', 'app.ss12000_v_school_types()', false, true, false),
      ('AcademicYears', 'app.ss12000_v_years()', false, true, false),
      ('Schools', 'app.ss12000_v_schools()', false, true, false),
      ('Ss12000Sources', 'app.ss12000_v_sources()', true, true, false),
      ('CalendarLessons', 'app.ss12000_v_lessons()', true, true, true),
      ('CalendarLessonTeachers', 'app.ss12000_v_lesson_parts()', true, true, true),
      ('CalendarLessonStudents', 'app.ss12000_v_lesson_parts()', true, true, true),
      ('CalendarLessonGroups', 'app.ss12000_v_lesson_parts()', true, true, true),
      ('PublicationPendingRemovals', 'app.ss12000_v_lesson_parts()', true, true, true)
    ) AS t(tbl, fn, on_insert, on_update, on_delete)
  LOOP
    IF spec.on_insert THEN
      EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON %I REFERENCING NEW TABLE AS n FOR EACH STATEMENT EXECUTE FUNCTION %s',
                     spec.tbl || '_ss12000_versions_ins', spec.tbl, spec.fn);
    END IF;
    IF spec.on_update THEN
      EXECUTE format('CREATE TRIGGER %I AFTER UPDATE ON %I REFERENCING OLD TABLE AS o NEW TABLE AS n FOR EACH STATEMENT EXECUTE FUNCTION %s',
                     spec.tbl || '_ss12000_versions_upd', spec.tbl, spec.fn);
    END IF;
    IF spec.on_delete THEN
      EXECUTE format('CREATE TRIGGER %I AFTER DELETE ON %I REFERENCING OLD TABLE AS o FOR EACH STATEMENT EXECUTE FUNCTION %s',
                     spec.tbl || '_ss12000_versions_del', spec.tbl, spec.fn);
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Subscriptions: who writes what.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.ss12000_subscription_writes_are_narrow() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  service_free text[] := ARRAY['expiresAt', 'endedAt', 'suspendedAt', 'suspendedReason', 'failingSince', 'attempts', 'nextAttemptAt', 'updatedAt'];
  admin_free text[] := ARRAY['suspendedAt', 'suspendedReason', 'failingSince', 'attempts', 'nextAttemptAt', 'updatedAt'];
BEGIN
  IF app.current_service_school_id() IS NOT NULL THEN
    IF (to_jsonb(NEW) - service_free) IS DISTINCT FROM (to_jsonb(OLD) - service_free)
       OR (OLD."endedAt" IS NOT NULL AND NEW."endedAt" IS DISTINCT FROM OLD."endedAt")
       OR (OLD."suspendedReason" = 'ADMIN' AND NEW."suspendedReason" IS DISTINCT FROM 'ADMIN')
       OR (NEW."suspendedReason" IS NOT NULL AND NEW."suspendedReason" IS DISTINCT FROM OLD."suspendedReason") THEN
      RAISE EXCEPTION 'SS12000_SUBSCRIPTION_WRITES_ARE_NARROW: en nyckel förlänger, avslutar och återupptar sin prenumeration, inget annat'
        USING ERRCODE = 'SS403';
    END IF;
  ELSIF app.current_user_id() IS NOT NULL THEN
    IF (to_jsonb(NEW) - admin_free) IS DISTINCT FROM (to_jsonb(OLD) - admin_free)
       OR (NEW."suspendedReason" IS NOT NULL AND NEW."suspendedReason" <> 'ADMIN' AND NEW."suspendedReason" IS DISTINCT FROM OLD."suspendedReason") THEN
      RAISE EXCEPTION 'SS12000_SUBSCRIPTION_WRITES_ARE_NARROW: skolan pausar och återupptar en prenumeration, inget annat'
        USING ERRCODE = 'SS403';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Ss12000Subscriptions_writes_are_narrow"
    BEFORE UPDATE ON "Ss12000Subscriptions"
    FOR EACH ROW EXECUTE FUNCTION app.ss12000_subscription_writes_are_narrow();

-- ---------------------------------------------------------------------------
-- The delivery. See the preamble.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.ss12000_due_notifications(p_limit integer)
RETURNS TABLE (subscription_id uuid, school_id uuid, key_id uuid, target text, modified text[], deleted boolean,
               watermark_to text, attempts integer, failing_since timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  horizon xid8 := pg_snapshot_xmin(pg_current_snapshot());
BEGIN
  IF NOT app.ss12000_is_delivery_context() THEN
    RAISE EXCEPTION 'SS12000_DELIVERY_ONLY: bara utskicket hämtar prenumerationer att avisera' USING ERRCODE = 'SS403';
  END IF;
  RETURN QUERY
  WITH due AS (
    SELECT s."id"
      FROM "Ss12000Subscriptions" s
      JOIN "IntegrationApiKeys" k ON k."id" = s."keyId" AND k."schoolId" = s."schoolId"
     WHERE s."endedAt" IS NULL AND s."suspendedAt" IS NULL AND s."expiresAt" > now()
       AND k."revokedAt" IS NULL
       AND s."nextAttemptAt" <= now()
       AND (s."claimedAt" IS NULL OR s."claimedAt" < now() - interval '5 minutes')
       AND (EXISTS (SELECT 1 FROM "Ss12000EntityVersions" v
                     WHERE v."schoolId" = s."schoolId" AND v."xid" >= s."watermark" AND v."xid" < horizon
                       AND v."resource" = ANY (s."resourceTypes"))
            OR EXISTS (SELECT 1 FROM "Ss12000Tombstones" t
                        WHERE t."schoolId" = s."schoolId" AND t."xid" >= s."watermark" AND t."xid" < horizon
                          AND (CASE WHEN t."resource" = 'AdhocActivity' THEN 'Activity' ELSE t."resource" END) = ANY (s."resourceTypes")))
     ORDER BY s."nextAttemptAt", s."id"
     LIMIT greatest(least(p_limit, 200), 1)
     FOR UPDATE OF s SKIP LOCKED
  ), claimed AS (
    UPDATE "Ss12000Subscriptions" s SET "claimedAt" = now()
      FROM due WHERE s."id" = due."id"
    RETURNING s."id", s."schoolId", s."keyId", s."target", s."resourceTypes", s."watermark", s."attempts", s."failingSince"
  )
  SELECT c."id", c."schoolId", c."keyId", c."target",
         ARRAY(SELECT DISTINCT v."resource" FROM "Ss12000EntityVersions" v
                WHERE v."schoolId" = c."schoolId" AND v."xid" >= c."watermark" AND v."xid" < horizon
                  AND v."resource" = ANY (c."resourceTypes")
                ORDER BY 1),
         EXISTS (SELECT 1 FROM "Ss12000Tombstones" t
                  WHERE t."schoolId" = c."schoolId" AND t."xid" >= c."watermark" AND t."xid" < horizon
                    AND (CASE WHEN t."resource" = 'AdhocActivity' THEN 'Activity' ELSE t."resource" END) = ANY (c."resourceTypes")),
         horizon::text, c."attempts", c."failingSince"
    FROM claimed c;
END
$$;

CREATE FUNCTION app.ss12000_notification_settled(
    p_subscription uuid, p_ok boolean, p_status integer, p_outcome text, p_watermark text, p_duration_ms integer, p_next_attempt timestamptz)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  sub record;
  verdict text;
BEGIN
  IF NOT app.ss12000_is_delivery_context() THEN
    RAISE EXCEPTION 'SS12000_DELIVERY_ONLY: bara utskicket redovisar ett utskick' USING ERRCODE = 'SS403';
  END IF;
  SELECT s."id", s."schoolId", s."failingSince", s."watermark" INTO sub
    FROM "Ss12000Subscriptions" s WHERE s."id" = p_subscription FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'GONE';
  END IF;
  INSERT INTO "Ss12000SubscriptionDeliveries" ("schoolId", "subscriptionId", "httpStatus", "outcome", "durationMs")
  VALUES (sub."schoolId", sub."id", p_status, p_outcome, greatest(least(p_duration_ms, 600000), 0));
  IF p_ok THEN
    UPDATE "Ss12000Subscriptions"
       SET "watermark" = greatest("watermark", p_watermark::xid8), "lastNotifiedAt" = now(), "attempts" = 0,
           "failingSince" = NULL, "nextAttemptAt" = now(), "claimedAt" = NULL, "updatedAt" = now()
     WHERE "id" = sub."id";
    verdict := 'DELIVERED';
  ELSIF coalesce(sub."failingSince", now()) < now() - interval '72 hours' THEN
    UPDATE "Ss12000Subscriptions"
       SET "attempts" = "attempts" + 1, "suspendedAt" = now(), "suspendedReason" = 'FAILING', "claimedAt" = NULL, "updatedAt" = now()
     WHERE "id" = sub."id";
    verdict := 'SUSPENDED';
  ELSE
    UPDATE "Ss12000Subscriptions"
       SET "attempts" = "attempts" + 1, "failingSince" = coalesce("failingSince", now()),
           "nextAttemptAt" = greatest(p_next_attempt, now()), "claimedAt" = NULL, "updatedAt" = now()
     WHERE "id" = sub."id";
    verdict := 'RETRY';
  END IF;
  RETURN verdict;
END
$$;

CREATE FUNCTION app.ss12000_provider_housekeeping(p_now timestamptz DEFAULT now())
RETURNS TABLE (tombstones integer, deliveries integer, released integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE t integer; d integer; r integer;
BEGIN
  IF NOT app.ss12000_is_delivery_context() THEN
    RAISE EXCEPTION 'SS12000_DELIVERY_ONLY: bara utskicket städar' USING ERRCODE = 'SS403';
  END IF;
  PERFORM set_config('app.ss12000_housekeeping', 'on', true);
  DELETE FROM "Ss12000Tombstones" WHERE "removedAt" < p_now - interval '400 days';
  GET DIAGNOSTICS t = ROW_COUNT;
  PERFORM set_config('app.ss12000_housekeeping', '', true);
  DELETE FROM "Ss12000SubscriptionDeliveries" WHERE "attemptedAt" < p_now - interval '30 days';
  GET DIAGNOSTICS d = ROW_COUNT;
  UPDATE "Ss12000Subscriptions" SET "claimedAt" = NULL WHERE "claimedAt" < p_now - interval '5 minutes';
  GET DIAGNOSTICS r = ROW_COUNT;
  RETURN QUERY SELECT t, d, r;
END
$$;

COMMENT ON FUNCTION app.ss12000_due_notifications(integer) IS
  'Claims subscriptions with changes below the xid horizon, for the webhook delivery only (SS403).';
COMMENT ON FUNCTION app.ss12000_notification_settled(uuid, boolean, integer, text, text, integer, timestamptz) IS
  'Records a delivery attempt and moves the watermark, schedules the retry or suspends; delivery only (SS403).';
COMMENT ON FUNCTION app.ss12000_provider_housekeeping(timestamptz) IS
  'Purges tombstones after 400 days and delivery rows after 30, and releases stale claims; delivery only (SS403).';

-- ---------------------------------------------------------------------------
-- Row-level security. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "Ss12000EntityVersions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Ss12000Tombstones" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Ss12000Subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Ss12000SubscriptionDeliveries" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ss12000_entity_versions_service_select" ON "Ss12000EntityVersions"
    FOR SELECT USING ("schoolId" = app.current_service_school_id());
CREATE POLICY "ss12000_tombstones_service_select" ON "Ss12000Tombstones"
    FOR SELECT USING ("schoolId" = app.current_service_school_id());

CREATE POLICY "ss12000_subscriptions_service_select" ON "Ss12000Subscriptions"
    FOR SELECT
    USING ("schoolId" = app.current_service_school_id() AND "keyId" = app.current_service_key_id());
CREATE POLICY "ss12000_subscriptions_service_insert" ON "Ss12000Subscriptions"
    FOR INSERT
    WITH CHECK ("schoolId" = app.current_service_school_id() AND "keyId" = app.current_service_key_id());
CREATE POLICY "ss12000_subscriptions_service_update" ON "Ss12000Subscriptions"
    FOR UPDATE
    USING ("schoolId" = app.current_service_school_id() AND "keyId" = app.current_service_key_id())
    WITH CHECK ("schoolId" = app.current_service_school_id() AND "keyId" = app.current_service_key_id());
CREATE POLICY "ss12000_subscriptions_admin_select" ON "Ss12000Subscriptions"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
CREATE POLICY "ss12000_subscriptions_admin_update" ON "Ss12000Subscriptions"
    FOR UPDATE TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

CREATE POLICY "ss12000_subscription_deliveries_admin_select" ON "Ss12000SubscriptionDeliveries"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

-- The reads v2 adds to the service principal's (20260806010000, 20260914150000).
CREATE POLICY "student_enrollments_service_select" ON "StudentEnrollments"
    FOR SELECT USING ("schoolId" = app.current_service_school_id());
CREATE POLICY "student_group_members_service_select" ON "StudentGroupMembers"
    FOR SELECT USING ("schoolId" = app.current_service_school_id());
CREATE POLICY "academic_year_timplans_service_select" ON "AcademicYearTimplans"
    FOR SELECT USING ("schoolId" = app.current_service_school_id());
CREATE POLICY "local_timplans_service_select" ON "LocalTimplans"
    FOR SELECT USING ("schoolId" = app.current_service_school_id());
CREATE POLICY "ss12000_duty_links_service_select" ON "Ss12000DutyLinks"
    FOR SELECT USING ("schoolId" = app.current_service_school_id());

-- ---------------------------------------------------------------------------
-- Grants, guarded.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  fn text;
  r text;
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT SELECT ON "Ss12000EntityVersions", "Ss12000Tombstones", "Ss12000SubscriptionDeliveries" TO "app_authenticated";
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
        ON "Ss12000EntityVersions", "Ss12000Tombstones", "Ss12000SubscriptionDeliveries" FROM "app_authenticated";
    GRANT SELECT, INSERT, UPDATE ON "Ss12000Subscriptions" TO "app_authenticated";
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON "Ss12000Subscriptions" FROM "app_authenticated";
    GRANT SELECT ON "StudentEnrollments", "StudentGroupMembers", "AcademicYearTimplans", "LocalTimplans", "Ss12000DutyLinks" TO "app_authenticated";
  END IF;
  FOREACH t IN ARRAY ARRAY['Ss12000EntityVersions', 'Ss12000Tombstones', 'Ss12000SubscriptionDeliveries', 'Ss12000Subscriptions'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      IF t = 'Ss12000Subscriptions' THEN
        EXECUTE format('REVOKE INSERT, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM "authenticated"', t);
      ELSE
        EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM "authenticated"', t);
      END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON %I FROM "anon"', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM "service_role"', t);
    END IF;
  END LOOP;

  -- The trigger functions and recorders: nobody calls them but the triggers.
  FOREACH fn IN ARRAY ARRAY[
    'app.ss12000_versions_written_by_trigger()',
    'app.ss12000_bump(uuid, text, uuid[])',
    'app.ss12000_bury(uuid, text, uuid[])',
    'app.ss12000_unbury(uuid, text, uuid[])',
    'app.ss12000_bump_groups(uuid, uuid[])',
    'app.ss12000_bump_lessons(uuid, uuid[])',
    'app.ss12000_bump_activities(uuid, uuid[], uuid[], uuid[], boolean)',
    'app.ss12000_bump_school(uuid)',
    'app.ss12000_v_users()', 'app.ss12000_v_enrollments()', 'app.ss12000_v_group_members()',
    'app.ss12000_v_guardians()', 'app.ss12000_v_groups()', 'app.ss12000_v_rooms()', 'app.ss12000_v_subjects()',
    'app.ss12000_v_employments()', 'app.ss12000_v_teacher_duties()', 'app.ss12000_v_duty_links()',
    'app.ss12000_v_staffing_policies()', 'app.ss12000_v_masters()', 'app.ss12000_v_master_groups()',
    'app.ss12000_v_published()', 'app.ss12000_v_publication_settings()', 'app.ss12000_v_school_types()',
    'app.ss12000_v_years()', 'app.ss12000_v_schools()', 'app.ss12000_v_sources()', 'app.ss12000_v_lessons()',
    'app.ss12000_v_lesson_parts()', 'app.ss12000_subscription_writes_are_narrow()',
    'app.ss12000_duty_links_moved(uuid, uuid, uuid, uuid[])', 'app.ss12000_publish_mode_switched(uuid)',
    'app.ss12000_school_types_moved(uuid)', 'app.ss12000_organisation_moved(uuid, uuid[], uuid[])'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', fn, r);
      END IF;
    END LOOP;
  END LOOP;

  -- The functions the gateway calls: the API alone.
  FOREACH fn IN ARRAY ARRAY[
    'app.ss12000_provider_identity()',
    'app.ss12000_year_is_emitted(uuid)',
    'app.ss12000_active_year(uuid)',
    'app.ss12000_duty_id(uuid, uuid, uuid)',
    'app.ss12000_due_notifications(integer)',
    'app.ss12000_notification_settled(uuid, boolean, integer, text, text, integer, timestamptz)',
    'app.ss12000_provider_housekeeping(timestamptz)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', fn, r);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO "app_authenticated"', fn);
    END IF;
  END LOOP;
  -- app.current_service_key_id() keeps PUBLIC's EXECUTE: the arms naming it
  -- carry no TO (see the preamble).
END
$$;

-- ---------------------------------------------------------------------------
-- SS12000_PROVIDER_REACH: versions and tombstones have only the service's
-- SELECT arm; subscriptions the service's three (naming its key) and the
-- admin's SELECT and UPDATE; deliveries the admin's SELECT; no DELETE or ALL
-- arm anywhere here; and still no arm of the service on Ss12000Sources.
-- ---------------------------------------------------------------------------

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(p.tablename || '.' || p.policyname, ', ' ORDER BY p.tablename, p.policyname) INTO bad
    FROM pg_policies p
   WHERE p.schemaname = 'public'
     AND (
          (p.tablename IN ('Ss12000EntityVersions', 'Ss12000Tombstones')
           AND NOT (p.cmd = 'SELECT' AND p.qual LIKE '%current_service_school_id()%' AND p.policyname LIKE '%_service_select'))
       OR (p.tablename = 'Ss12000Subscriptions'
           AND NOT ((p.policyname LIKE 'ss12000_subscriptions_service_%' AND p.cmd IN ('SELECT', 'INSERT', 'UPDATE')
                     AND coalesce(p.qual, p.with_check) LIKE '%current_service_key_id()%')
                 OR (p.policyname LIKE 'ss12000_subscriptions_admin_%' AND p.cmd IN ('SELECT', 'UPDATE')
                     AND p.roles = '{authenticated}'::name[] AND coalesce(p.qual, p.with_check) LIKE '%SCHOOL_ADMIN%')))
       OR (p.tablename = 'Ss12000SubscriptionDeliveries'
           AND NOT (p.cmd = 'SELECT' AND p.roles = '{authenticated}'::name[] AND p.qual LIKE '%SCHOOL_ADMIN%'))
       OR (p.tablename = 'Ss12000Sources' AND coalesce(p.qual, '') || coalesce(p.with_check, '') LIKE '%current_service_school_id()%')
       OR (p.tablename IN ('Ss12000EntityVersions', 'Ss12000Tombstones', 'Ss12000Subscriptions', 'Ss12000SubscriptionDeliveries')
           AND (p.cmd IN ('DELETE', 'ALL') OR coalesce(p.qual, '') || coalesce(p.with_check, '') ~* '\mOR\M'))
     );
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'SS12000_PROVIDER_REACH: these arms reach the provider''s tables beyond the service and the admin: %', bad;
  END IF;
END
$$;
