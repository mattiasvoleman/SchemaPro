-- En vikarie kan stå i en pool.
--
-- Most cover in a Swedish school is done by the school's own teachers in
-- their free periods; the rest by timvikarier — people who cover without a
-- teaching post, called in when nobody on the staff is free. The cover board
-- (20261012100000) must be able to suggest them, count their lessons and
-- export their hours for payroll. This migration says who they are and when
-- they can work.
--
-- ## A pool member is a TEACHER user with a membership row
--
-- Not a new kind of person: a timvikarie takes the register, reads the class
-- list and sees the lesson in the teacher app, exactly as a teacher does, and
-- assignSubstitute already takes only active TEACHERs. A separate role would
-- need its own arm on every calendar, roster and attendance table, which is a
-- much larger change than the feature and a second definition of "may stand
-- in front of a class". So a pool member is an ordinary Users row with role
-- TEACHER — invited through the existing flow, or never invited and reached
-- by e-mail (the cover notice is mirrored to e-mail) — plus a row here. The
-- consequence is deliberate and stated: a pool member reads what every
-- teacher of the school reads (the calendar, class lists, attendance) and
-- appears in SS12000 as a teacher. A school deactivates a pool member who
-- leaves, as it does a teacher.
--
-- A BEFORE INSERT OR UPDATE trigger refuses a member whose role is not
-- TEACHER (SQLSTATE SP409): an admin or a pupil in the pool would be offered
-- as a substitute assignSubstitute then refuses.
--
-- A pool member WITHOUT a TeacherEmployment in a year has no post and no
-- load target that year: they are left out of readActiveStaffIds (never
-- offered a timplanspost) and are a cover candidate only inside the windows
-- below. A teacher WITH a post who also joins the pool is ordinary staff who
-- also covers; the membership changes nothing for them but the label.
--
-- ## Availability is positive
--
-- SubstituteAvailabilities are windows a person CAN work: "tisdag 14/10
-- 08–16", or every Monday 08–12. That is the opposite of an
-- AvailabilityConstraint, which closes hours a teacher cannot be scheduled
-- in. Reusing PREFERRED_BUSY would turn a teacher's scheduling preference
-- into a statement the payroll trusts, so the windows have their own table:
-- a date or a weekday (exactly one), start before end. Composite key to the
-- membership (userId, schoolId), CASCADE: leaving the pool takes the windows
-- with it.
--
-- ## Row-level security
--
--   * *_admin_all on both, USING and WITH CHECK with the role.
--   * substitute_pool_members_own_select: a member sees that they are one.
--   * substitute_availabilities_own_all: a member writes their own windows,
--     and only while they are a member, in USING and in WITH CHECK.
--   * Nothing for STUDENT, GUARDIAN or the service principal.
--
-- The guard of 20261012090000 is repeated for these tables.

CREATE TABLE "SubstitutePoolMembers" (
    "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"        UUID NOT NULL,
    "userId"          UUID NOT NULL,
    "createdAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "createdByUserId" UUID,

    CONSTRAINT "SubstitutePoolMembers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SubstitutePoolMembers_userId_key" ON "SubstitutePoolMembers"("userId");
CREATE UNIQUE INDEX "SubstitutePoolMembers_userId_schoolId_key" ON "SubstitutePoolMembers"("userId", "schoolId");
CREATE INDEX "SubstitutePoolMembers_schoolId_idx" ON "SubstitutePoolMembers"("schoolId");
CREATE INDEX "SubstitutePoolMembers_createdByUserId_schoolId_idx" ON "SubstitutePoolMembers"("createdByUserId", "schoolId");

ALTER TABLE "SubstitutePoolMembers"
    ADD CONSTRAINT "SubstitutePoolMembers_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubstitutePoolMembers"
    ADD CONSTRAINT "SubstitutePoolMembers_userId_schoolId_fkey"
    FOREIGN KEY ("userId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubstitutePoolMembers"
    ADD CONSTRAINT "SubstitutePoolMembers_createdByUserId_schoolId_fkey"
    FOREIGN KEY ("createdByUserId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE SET NULL ("createdByUserId") ON UPDATE NO ACTION;

CREATE TABLE "SubstituteAvailabilities" (
    "id"        UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"  UUID NOT NULL,
    "userId"    UUID NOT NULL,
    "date"      DATE,
    "dayOfWeek" INTEGER,
    "startTime" TIME(0) NOT NULL,
    "endTime"   TIME(0) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "SubstituteAvailabilities_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SubstituteAvailabilities_date_or_weekday" CHECK (("date" IS NULL) <> ("dayOfWeek" IS NULL)),
    CONSTRAINT "SubstituteAvailabilities_weekday_is_sane" CHECK ("dayOfWeek" IS NULL OR "dayOfWeek" BETWEEN 1 AND 7),
    CONSTRAINT "SubstituteAvailabilities_window_is_ordered" CHECK ("startTime" < "endTime")
);

CREATE INDEX "SubstituteAvailabilities_schoolId_userId_date_idx" ON "SubstituteAvailabilities"("schoolId", "userId", "date");
CREATE INDEX "SubstituteAvailabilities_userId_schoolId_idx" ON "SubstituteAvailabilities"("userId", "schoolId");

ALTER TABLE "SubstituteAvailabilities"
    ADD CONSTRAINT "SubstituteAvailabilities_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubstituteAvailabilities"
    ADD CONSTRAINT "SubstituteAvailabilities_member_fkey"
    FOREIGN KEY ("userId", "schoolId") REFERENCES "SubstitutePoolMembers"("userId", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- A pool member is a TEACHER.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.substitute_pool_member_is_a_teacher() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "Users" u WHERE u."id" = NEW."userId" AND u."schoolId" = NEW."schoolId" AND u."role" = 'TEACHER'
  ) THEN
    RAISE EXCEPTION 'POOL_MEMBER_MUST_BE_TEACHER: bara en lärare kan stå i vikariepoolen'
      USING ERRCODE = 'SP409';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SubstitutePoolMembers_member_is_a_teacher"
    BEFORE INSERT OR UPDATE ON "SubstitutePoolMembers"
    FOR EACH ROW EXECUTE FUNCTION app.substitute_pool_member_is_a_teacher();

REVOKE ALL ON FUNCTION app.substitute_pool_member_is_a_teacher() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Row-level security. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "SubstitutePoolMembers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SubstituteAvailabilities" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "substitute_pool_members_admin_all" ON "SubstitutePoolMembers"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
CREATE POLICY "substitute_pool_members_own_select" ON "SubstitutePoolMembers"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) = 'TEACHER'
        AND "userId" = (select app.current_user_id())
    );

CREATE POLICY "substitute_availabilities_admin_all" ON "SubstituteAvailabilities"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
CREATE POLICY "substitute_availabilities_own_all" ON "SubstituteAvailabilities"
    FOR ALL TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) = 'TEACHER'
        AND "userId" = (select app.current_user_id())
        AND EXISTS (SELECT 1 FROM "SubstitutePoolMembers" m
                     WHERE m."userId" = (select app.current_user_id()) AND m."schoolId" = (select app.current_school_id()))
    )
    WITH CHECK (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) = 'TEACHER'
        AND "userId" = (select app.current_user_id())
        AND EXISTS (SELECT 1 FROM "SubstitutePoolMembers" m
                     WHERE m."userId" = (select app.current_user_id()) AND m."schoolId" = (select app.current_school_id()))
    );

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['SubstitutePoolMembers', 'SubstituteAvailabilities'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO "app_authenticated"', tbl);
      EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON %I FROM "app_authenticated"', tbl);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON %I FROM "authenticated"', tbl);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON %I FROM "anon"', tbl);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM "service_role"', tbl);
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- The guard of 20261012090000, for these tables.
-- ---------------------------------------------------------------------------

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(tablename || '.' || policyname, ', ' ORDER BY tablename, policyname) INTO bad
    FROM (
      SELECT p.tablename, p.policyname,
             (p.roles = '{authenticated}'::name[] AND p.permissive = 'PERMISSIVE') AS shaped,
             ARRAY_REMOVE(ARRAY[
               CASE WHEN p.cmd <> 'INSERT' THEN coalesce(p.qual, '') END,
               CASE WHEN p.cmd IN ('INSERT', 'UPDATE', 'ALL') THEN coalesce(p.with_check, p.qual, '') END
             ], NULL) AS arms
        FROM pg_policies p
       WHERE p.schemaname = 'public' AND p.tablename IN ('SubstitutePoolMembers', 'SubstituteAvailabilities')
    ) x
   WHERE NOT x.shaped
      OR EXISTS (
        SELECT 1 FROM unnest(x.arms) e
         WHERE e NOT LIKE '%current_school_id()%'
            OR NOT (
                 e LIKE '%current_user_role()%= ''SCHOOL_ADMIN''::"UserRole"%'
              OR (e LIKE '%current_user_role()%= ''TEACHER''::"UserRole"%' AND e LIKE '%current_user_id()%')
            )
      );
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'POOL_LEAK: these arms reach the substitute pool for somebody other than the admin or the member: %', bad;
  END IF;
END
$$;
