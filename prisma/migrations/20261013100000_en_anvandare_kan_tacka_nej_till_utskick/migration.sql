-- En användare kan tacka nej till utskick.
--
-- SchemaPro has no notification preferences: every notice that is mirrored
-- to e-mail goes to every recipient with an address, and push (the next
-- migration, 20261013110000) would go to every device. This is the minimal
-- choice the house lacked: per person and per notice type, "do not send me
-- this outside the app", shared by e-mail and push.
--
-- ## What a row means
--
-- A row (userId, type) says "do not e-mail or push me notices of this type".
-- No row means send, so nothing changes for anybody until they choose, and
-- the table starts empty. The in-app row is ALWAYS written: the inbox is the
-- record of what the school said, and an opt-out only silences the channels
-- that leave SchemaPro. A choice is a row or no row, so there is no UPDATE.
--
-- Two types can never be a row (CHECKs mirroring the DTO):
--
--   * ABSENCE_UNREPORTED. Skollagen 7 kap. 19 a § makes the head teacher see
--     to it that a pupil's guardians are told the SAME DAY when the pupil is
--     absent without a valid reason. That notice is the school's duty, not
--     the guardian's preference, and is not switched off;
--   * TEACHER_ABSENCE_REPORTED. It is never e-mailed or pushed (a colleague's
--     absence is HR data, kept in the admins' inbox), so a switch for it
--     would do nothing.
--
-- A teacher's own cover bookings (LESSON_SUBSTITUTE with cover:true, and
-- LESSON_COVER_WITHDRAWN) are delivered whatever the rows say: the delivery
-- ignores the opt-out for them, and the API refuses LESSON_COVER_WITHDRAWN
-- for teachers and admins. That rule is per role and per notice, so it lives
-- in the DTO and the delivery, not in a CHECK.
--
-- ## Whose rows
--
-- Each person's own: notification_opt_outs_own_select, _own_insert and
-- _own_delete, all "schoolId" = app.current_school_id() AND "userId" =
-- app.current_user_id(), for every role. No admin arm: a person's choice is
-- theirs, and the school has no need to see it. The delivery reads the rows
-- after the commit through app.delivery_opt_outs(school, users, type), a
-- SECURITY DEFINER function only the API role may call, in a transaction
-- with no principal (PrismaService.withDeliveryService).
--
-- The key is (userId, type); (userId, schoolId) references Users, so a row is
-- always its own person's school's, and goes with the person.
--
-- Grants guarded as in 20261012090000: app_authenticated SELECT, INSERT and
-- DELETE; UPDATE, TRUNCATE, REFERENCES and TRIGGER revoked from authenticated
-- (which app_authenticated is a member of); anon nothing; service_role no
-- write. The migration ends with OPT_OUT_REACH over pg_policies.

CREATE TABLE "NotificationOptOuts" (
    "userId"    UUID NOT NULL,
    "schoolId"  UUID NOT NULL,
    "type"      "NotificationType" NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "NotificationOptOuts_pkey" PRIMARY KEY ("userId", "type"),
    CONSTRAINT "NotificationOptOuts_absence_notice_is_kept" CHECK ("type" <> 'ABSENCE_UNREPORTED'),
    CONSTRAINT "NotificationOptOuts_absence_report_is_never_a_type" CHECK ("type" <> 'TEACHER_ABSENCE_REPORTED')
);

CREATE INDEX "NotificationOptOuts_schoolId_type_idx" ON "NotificationOptOuts"("schoolId", "type");

ALTER TABLE "NotificationOptOuts"
    ADD CONSTRAINT "NotificationOptOuts_userId_schoolId_fkey"
    FOREIGN KEY ("userId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NotificationOptOuts" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "notification_opt_outs_own_select" ON "NotificationOptOuts"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND "userId" = (select app.current_user_id()));
CREATE POLICY "notification_opt_outs_own_insert" ON "NotificationOptOuts"
    FOR INSERT TO "authenticated"
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND "userId" = (select app.current_user_id()));
CREATE POLICY "notification_opt_outs_own_delete" ON "NotificationOptOuts"
    FOR DELETE TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND "userId" = (select app.current_user_id()));

-- ---------------------------------------------------------------------------
-- The delivery's read: who of these people said no to this type.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.delivery_opt_outs(p_school uuid, p_users uuid[], p_type "NotificationType")
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT o."userId"
    FROM "NotificationOptOuts" o
   WHERE o."schoolId" = p_school
     AND o."userId" = ANY (p_users)
     AND o."type" = p_type
$$;

COMMENT ON FUNCTION app.delivery_opt_outs(uuid, uuid[], "NotificationType") IS
  'Which of p_users in p_school opted out of e-mail and push for p_type. The API''s delivery alone calls it, after the commit.';

REVOKE ALL ON FUNCTION app.delivery_opt_outs(uuid, uuid[], "NotificationType") FROM PUBLIC;

DO $$
DECLARE r text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT SELECT, INSERT, DELETE ON "NotificationOptOuts" TO "app_authenticated";
    REVOKE UPDATE, TRUNCATE, REFERENCES, TRIGGER ON "NotificationOptOuts" FROM "app_authenticated";
    GRANT EXECUTE ON FUNCTION app.delivery_opt_outs(uuid, uuid[], "NotificationType") TO "app_authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE UPDATE, TRUNCATE, REFERENCES, TRIGGER ON "NotificationOptOuts" FROM "authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "NotificationOptOuts" FROM "anon";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "NotificationOptOuts" FROM "service_role";
  END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION app.delivery_opt_outs(uuid, uuid[], "NotificationType") FROM %I', r);
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- OPT_OUT_REACH: every arm is a permissive arm for authenticated that names
-- the person's own id and school, in USING and in WITH CHECK alike, and none
-- is an UPDATE or ALL arm.
-- ---------------------------------------------------------------------------

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(p.policyname, ', ' ORDER BY p.policyname) INTO bad
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = 'NotificationOptOuts'
     AND (
           p.permissive <> 'PERMISSIVE'
        OR p.roles <> '{authenticated}'::name[]
        OR p.cmd NOT IN ('SELECT', 'INSERT', 'DELETE')
        OR coalesce(p.qual, p.with_check, '') NOT LIKE '%current_user_id()%'
        OR coalesce(p.qual, p.with_check, '') NOT LIKE '%current_school_id()%'
        OR (p.with_check IS NOT NULL AND (p.with_check NOT LIKE '%current_user_id()%' OR p.with_check NOT LIKE '%current_school_id()%'))
        OR coalesce(p.qual, '') || coalesce(p.with_check, '') ~* '\mOR\M'
     );
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'OPT_OUT_REACH: these arms reach somebody else''s choices: %', bad;
  END IF;
END
$$;
