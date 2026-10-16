-- En prenumeration kan gälla närvaron: Ss12000Subscriptions take the two
-- resources of SS12000-närvaro (20261114090000), and the delivery's notices
-- follow the school's decision.
--
-- app.ss12000_due_notifications is replaced with the same signature and
-- grants; everything not said here is the body of 20261014130000.
--
--   * A subscription's 'Attendance' and 'Absence' count only while the
--     school shares and its key holds the scope (app.ss12000_notifies, asked
--     once per subscription), so a receiver is never told that attendance
--     changed at a school that has stopped sharing, nor by a key that lost
--     the scope.
--   * When a school starts sharing again, every subscription to them that
--     has not been told since is told once, with deletedEntities true:
--     what happened while the school did not share (no version recorded
--     it, and its tombstones were not shown) is read on that notice, with
--     everything reading as modified since the moment it started again.
--
-- One table, taken NOWAIT and retried every 50 ms for 30 s as
-- 20261114090000 takes its own, so this transaction is in no cycle and no
-- request queues behind it while it waits for Ss12000Subscriptions.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Ss12000Subscriptions" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Ss12000Subscriptions was not free in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

ALTER TABLE "Ss12000Subscriptions" DROP CONSTRAINT "Ss12000Subscriptions_resourceTypes_are_emitted";
ALTER TABLE "Ss12000Subscriptions"
    ADD CONSTRAINT "Ss12000Subscriptions_resourceTypes_are_emitted" CHECK (
        cardinality("resourceTypes") BETWEEN 1 AND 10
        AND array_position("resourceTypes", NULL) IS NULL
        AND "resourceTypes" <@ ARRAY['Organisation', 'Person', 'Group', 'Duty', 'Activity', 'CalendarEvent', 'Room', 'Syllabus',
                                     'Attendance', 'Absence']::text[]);

-- The resource types of a subscription that may be notified now: all of
-- them, except Attendance and Absence unless the school shares and the key
-- holds their scope.
CREATE FUNCTION app.ss12000_notifies(p_types text[], p_scopes text[], p_school uuid) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT coalesce(array_agg(t), ARRAY[]::text[])
    FROM unnest(p_types) t
   WHERE t NOT IN ('Attendance', 'Absence')
      OR (app.attendance_shared(p_school)
          AND (CASE t WHEN 'Attendance' THEN 'attendances.read' ELSE 'absences.read' END) = ANY (p_scopes))
$$;

-- Asked once per subscription (the lateral `nt`), never per version or
-- tombstone scanned. `resumed`: the subscription may be told of Attendance
-- or Absence, and the school's current run of sharing began after it was
-- last told (or made).
CREATE OR REPLACE FUNCTION app.ss12000_due_notifications(p_limit integer)
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
    SELECT s."id", nt.types, nt.resumed
      FROM "Ss12000Subscriptions" s
      JOIN "IntegrationApiKeys" k ON k."id" = s."keyId" AND k."schoolId" = s."schoolId"
      CROSS JOIN LATERAL (
        SELECT x.types,
               coalesce(x.types && ARRAY['Attendance', 'Absence']
                        AND app.attendance_shared_since(s."schoolId") > coalesce(s."lastNotifiedAt", s."createdAt"), false) AS resumed
          FROM (SELECT app.ss12000_notifies(s."resourceTypes", k."scopes", s."schoolId") AS types) x
        OFFSET 0) nt
     WHERE s."endedAt" IS NULL AND s."suspendedAt" IS NULL AND s."expiresAt" > now()
       AND k."revokedAt" IS NULL
       AND s."nextAttemptAt" <= now()
       AND (s."claimedAt" IS NULL OR s."claimedAt" < now() - interval '5 minutes')
       AND (nt.resumed
            OR EXISTS (SELECT 1 FROM "Ss12000EntityVersions" v
                        WHERE v."schoolId" = s."schoolId" AND v."xid" >= s."watermark" AND v."xid" < horizon
                          AND v."resource" = ANY (nt.types))
            OR EXISTS (SELECT 1 FROM "Ss12000Tombstones" t
                        WHERE t."schoolId" = s."schoolId" AND t."xid" >= s."watermark" AND t."xid" < horizon
                          AND (CASE WHEN t."resource" = 'AdhocActivity' THEN 'Activity' ELSE t."resource" END) = ANY (nt.types)))
     ORDER BY s."nextAttemptAt", s."id"
     LIMIT greatest(least(p_limit, 200), 1)
     FOR UPDATE OF s SKIP LOCKED
  ), claimed AS (
    UPDATE "Ss12000Subscriptions" s SET "claimedAt" = now()
      FROM due WHERE s."id" = due."id"
    RETURNING s."id", s."schoolId", s."keyId", s."target", due.types AS "types", due.resumed AS "resumed",
              s."watermark", s."attempts", s."failingSince"
  )
  SELECT c."id", c."schoolId", c."keyId", c."target",
         ARRAY(SELECT DISTINCT m.resource
                 FROM (SELECT v."resource" FROM "Ss12000EntityVersions" v
                        WHERE v."schoolId" = c."schoolId" AND v."xid" >= c."watermark" AND v."xid" < horizon
                          AND v."resource" = ANY (c."types")
                       UNION
                       SELECT t FROM unnest(c."types") t
                        WHERE c."resumed" AND t IN ('Attendance', 'Absence')) m(resource)
                ORDER BY 1),
         c."resumed"
           OR EXISTS (SELECT 1 FROM "Ss12000Tombstones" t
                       WHERE t."schoolId" = c."schoolId" AND t."xid" >= c."watermark" AND t."xid" < horizon
                         AND (CASE WHEN t."resource" = 'AdhocActivity' THEN 'Activity' ELSE t."resource" END) = ANY (c."types")),
         horizon::text, c."attempts", c."failingSince"
    FROM claimed c;
END
$$;

DO $$
DECLARE
  r text;
BEGIN
  REVOKE ALL ON FUNCTION app.ss12000_notifies(text[], text[], uuid) FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION app.ss12000_notifies(text[], text[], uuid) FROM %I', r);
    END IF;
  END LOOP;
END
$$;
