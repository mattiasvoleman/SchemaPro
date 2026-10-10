-- En lärare kan vara frånvarande.
--
-- Until now SchemaPro had no record of a teacher's absence. The absence page
-- picked a teacher and a range, listed their scheduled lessons and let the
-- admin cover them one PATCH at a time; nothing said "Karin is away Tuesday
-- to Thursday", so nothing could show which lessons still need somebody, and
-- the next admin opening the page saw no trace of the first one's work. Untis
-- (Vertretungsplanung), aSc and Lectio all start cover from an absence. This
-- migration is that record; the cover decisions are the next one
-- (20261012100000) and the substitute pool the one after (20261012110000).
--
-- ## The reason is health data, and only two people read it
--
-- Why a teacher is away is, for "Sjukdom" and "Vård av barn", a fact about
-- someone's health or family (GDPR art. 9). The school needs it for its own
-- HR, and nobody else needs it to cover a lesson. So:
--
--   * TeacherAbsences is read by the SCHOOL_ADMIN and by the absent teacher
--     themself — no colleague, no pupil, no guardian, no service principal.
--     A colleague still sees what the calendar has always shown them (a
--     lesson cancelled, or with a substitute); this table adds no read path.
--   * The reason is a COARSE CATEGORY from the school's own list, never free
--     text. A text box invites "migrän, åter onsdag" and a diagnosis in a
--     table that outlives the absence. The category may be left out
--     (reasonId NULL, "ej angiven"), which is a legitimate choice.
--   * No service arm: SS12000 and the integrations never see an absence.
--     The calendar rows they already read say everything an external system
--     may know.
--
-- ## Lessons are derived, not stored
--
-- An absence names a person and a period, nothing more. The lessons it
-- affects are the published calendar rows of that person overlapping the
-- period, found when they are asked for. Storing them would need a trigger
-- to chase every publish, propagate, restore and rollover that rewrites the
-- calendar; deriving them needs nothing, and the cover decisions (the next
-- migration) are the only thing stored. No lesson is cancelled or changed
-- by registering an absence: the absent teacher stays on the lesson until
-- the school decides who covers it, so pupils and guardians see exactly what
-- they saw before.
--
-- ## Three tables
--
-- TeacherAbsenceReasons: the school's list. A row is either one of five
-- built-ins (localised by the client: sjukdom, vård av barn, tjänsteresa,
-- kompetensutveckling, annat) or a label the school wrote (1–60 characters),
-- never both. Built-ins are inserted by the service the first time an admin
-- lists the reasons (ON CONFLICT DO NOTHING on the partial unique index), so
-- no migration writes data and a school that never uses the feature has no
-- rows. archivedAt keeps an old absence's category readable after the school
-- stops offering it. Teachers read the list (labels, not people): a teacher
-- reporting their own absence needs it.
--
-- TeacherAbsences: [startsAt, endsAt) per person, timestamptz. Whole days are
-- stored as the school-local midnight of the first day to the midnight after
-- the last (wholeDays is display only). Two ACTIVE absences of one person
-- never overlap (EXCLUDE, btree_gist is installed since 20260822131500); a
-- WITHDRAWN one is history and may. At most 186 days: half a year is cover,
-- anything longer is a staffing change (a new teacher on the timplanspost),
-- not day-to-day substitution. The bound is 186 days AND ONE HOUR because
-- timestamptz subtraction counts 24-hour days, and 186 school-local days that
-- span the October change to winter time are 186 days 01:00 long. The DTO
-- counts local days.
--
-- CoverSettings: one row per school, and no row means every default:
-- teacherSelfReport off (an absence is registered by the admin, as today's
-- page is used) and poolPreference NEUTRAL (the substitute pool is ranked on
-- the same merits as own staff).
--
-- ## Self-report, when the school allows it
--
-- With teacherSelfReport on, a TEACHER may register their own absence from
-- the start of today (school-local: "sjuk i dag", reported at 07:00, is the
-- case it exists for), end it early but never before now, and withdraw it
-- before it starts. app.cover_self_report_allowed() reads the setting for the
-- caller's school (SECURITY DEFINER: a teacher reads the settings row through
-- its staff arm too, but a policy must not depend on another policy), and
-- app.school_today() is the school-local date the INSERT is held to. A guard
-- trigger enforces the rest, SQLSTATE TA403, because a policy can say WHO
-- may update a row but not WHICH columns move how:
--
--   * a teacher may move endsAt earlier, not before now();
--   * or withdraw it (status WITHDRAWN, withdrawnAt, withdrawnByUserId =
--     themself) while it has not started — the next migration widens this to
--     "within an hour of registering it, if nothing has been decided on it";
--   * nothing else: not the reason, not the person, not the start. updatedAt
--     is allowed to move, because Prisma's @updatedAt writes it on every
--     update.
--
-- userId is fixed for EVERY role (TA409): the decisions of the next migration
-- name the absence's person, and an absence that changed person would make
-- them name somebody who was never away. Admins are otherwise held only by
-- the CHECKs.
--
-- ## Row-level security
--
--   * *_admin_all on all three, USING and WITH CHECK with the role.
--   * teacher_absences_own_select / _own_insert / _own_update: TEACHER, the
--     row is their own (userId = app.current_user_id()), and the writes only
--     while the school allows self-report. No DELETE: a teacher withdraws.
--   * teacher_absence_reasons_staff_select and cover_settings_staff_select:
--     TEACHER, the school's catalogue and its two switches.
--   * Nothing for STUDENT or GUARDIAN, nothing for the service principal.
--
-- The migration ends with a guard over pg_policies: an arm on these tables
-- that is not restricted to SCHOOL_ADMIN, or to TEACHER together with
-- app.current_user_id() (the two catalogue arms excepted), or that is not a
-- permissive arm for authenticated, fails the deploy. Grants guarded as in
-- 20261011110000; service_role holds no write.

CREATE TYPE "TeacherAbsenceStatus" AS ENUM ('ACTIVE', 'WITHDRAWN');
CREATE TYPE "AbsenceReasonBuiltin" AS ENUM ('SICK', 'CHILD_CARE', 'WORK_TRAVEL', 'PROFESSIONAL_DEVELOPMENT', 'OTHER');
CREATE TYPE "CoverPoolPreference" AS ENUM ('PREFER', 'NEUTRAL', 'LAST_RESORT');

-- ---------------------------------------------------------------------------
-- TeacherAbsenceReasons
-- ---------------------------------------------------------------------------

CREATE TABLE "TeacherAbsenceReasons" (
    "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"   UUID NOT NULL,
    "builtin"    "AbsenceReasonBuiltin",
    "label"      TEXT,
    "sortOrder"  INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMPTZ(6),
    "createdAt"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "TeacherAbsenceReasons_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TeacherAbsenceReasons_builtin_or_label" CHECK (("builtin" IS NULL) <> ("label" IS NULL)),
    CONSTRAINT "TeacherAbsenceReasons_label_is_sane" CHECK (
        "label" IS NULL OR (char_length(btrim("label")) BETWEEN 1 AND 60 AND "label" = btrim("label"))
    ),
    CONSTRAINT "TeacherAbsenceReasons_sortOrder_is_sane" CHECK ("sortOrder" BETWEEN 0 AND 999)
);

CREATE UNIQUE INDEX "TeacherAbsenceReasons_id_schoolId_key" ON "TeacherAbsenceReasons"("id", "schoolId");
CREATE UNIQUE INDEX "TeacherAbsenceReasons_schoolId_builtin_key"
    ON "TeacherAbsenceReasons"("schoolId", "builtin") WHERE "builtin" IS NOT NULL;
CREATE UNIQUE INDEX "TeacherAbsenceReasons_schoolId_label_key"
    ON "TeacherAbsenceReasons"("schoolId", lower(btrim("label"))) WHERE "label" IS NOT NULL;

ALTER TABLE "TeacherAbsenceReasons"
    ADD CONSTRAINT "TeacherAbsenceReasons_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- TeacherAbsences
-- ---------------------------------------------------------------------------

CREATE TABLE "TeacherAbsences" (
    "id"                UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"          UUID NOT NULL,
    "userId"            UUID NOT NULL,
    "startsAt"          TIMESTAMPTZ(6) NOT NULL,
    "endsAt"            TIMESTAMPTZ(6) NOT NULL,
    "wholeDays"         BOOLEAN NOT NULL DEFAULT true,
    "reasonId"          UUID,
    "status"            "TeacherAbsenceStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdByUserId"   UUID,
    "withdrawnAt"       TIMESTAMPTZ(6),
    "withdrawnByUserId" UUID,
    "createdAt"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "TeacherAbsences_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TeacherAbsences_period_is_half_a_year_at_most" CHECK (
        "endsAt" > "startsAt" AND "endsAt" - "startsAt" <= interval '186 days 1 hour'
    ),
    CONSTRAINT "TeacherAbsences_withdrawal_is_recorded" CHECK (
        ("status" = 'WITHDRAWN') = ("withdrawnAt" IS NOT NULL)
        AND ("withdrawnByUserId" IS NULL OR "status" = 'WITHDRAWN')
    ),
    CONSTRAINT "TeacherAbsences_one_person_away_once" EXCLUDE USING gist (
        "schoolId" WITH =, "userId" WITH =, tstzrange("startsAt", "endsAt") WITH &&
    ) WHERE ("status" = 'ACTIVE')
);

CREATE UNIQUE INDEX "TeacherAbsences_id_schoolId_key" ON "TeacherAbsences"("id", "schoolId");
-- The target of the decisions' key, which names the absence's own person.
CREATE UNIQUE INDEX "TeacherAbsences_id_userId_schoolId_key" ON "TeacherAbsences"("id", "userId", "schoolId");
CREATE INDEX "TeacherAbsences_schoolId_userId_startsAt_idx" ON "TeacherAbsences"("schoolId", "userId", "startsAt");
CREATE INDEX "TeacherAbsences_reasonId_schoolId_idx" ON "TeacherAbsences"("reasonId", "schoolId");
CREATE INDEX "TeacherAbsences_createdByUserId_schoolId_idx" ON "TeacherAbsences"("createdByUserId", "schoolId");
CREATE INDEX "TeacherAbsences_withdrawnByUserId_schoolId_idx" ON "TeacherAbsences"("withdrawnByUserId", "schoolId");

ALTER TABLE "TeacherAbsences"
    ADD CONSTRAINT "TeacherAbsences_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeacherAbsences"
    ADD CONSTRAINT "TeacherAbsences_userId_schoolId_fkey"
    FOREIGN KEY ("userId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeacherAbsences"
    ADD CONSTRAINT "TeacherAbsences_reasonId_schoolId_fkey"
    FOREIGN KEY ("reasonId", "schoolId") REFERENCES "TeacherAbsenceReasons"("id", "schoolId")
    ON DELETE SET NULL ("reasonId") ON UPDATE NO ACTION;
ALTER TABLE "TeacherAbsences"
    ADD CONSTRAINT "TeacherAbsences_createdByUserId_schoolId_fkey"
    FOREIGN KEY ("createdByUserId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE SET NULL ("createdByUserId") ON UPDATE NO ACTION;
ALTER TABLE "TeacherAbsences"
    ADD CONSTRAINT "TeacherAbsences_withdrawnByUserId_schoolId_fkey"
    FOREIGN KEY ("withdrawnByUserId", "schoolId") REFERENCES "Users"("id", "schoolId")
    ON DELETE SET NULL ("withdrawnByUserId") ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- CoverSettings
-- ---------------------------------------------------------------------------

CREATE TABLE "CoverSettings" (
    "schoolId"          UUID NOT NULL,
    "poolPreference"    "CoverPoolPreference" NOT NULL DEFAULT 'NEUTRAL',
    "teacherSelfReport" BOOLEAN NOT NULL DEFAULT false,
    "createdAt"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "CoverSettings_pkey" PRIMARY KEY ("schoolId")
);

ALTER TABLE "CoverSettings"
    ADD CONSTRAINT "CoverSettings_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- The two helpers a policy and the guard read.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.cover_self_report_allowed() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT coalesce(
    (SELECT s."teacherSelfReport" FROM "CoverSettings" s WHERE s."schoolId" = app.current_school_id()),
    false)
$$;

CREATE FUNCTION app.school_today() RETURNS date
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT (now() AT TIME ZONE coalesce(
    (SELECT s."timezone" FROM "Schools" s WHERE s."id" = app.current_school_id()),
    'Europe/Stockholm'))::date
$$;

COMMENT ON FUNCTION app.cover_self_report_allowed() IS
  'Whether the caller''s school lets a teacher register their own absence (CoverSettings.teacherSelfReport; no row = false).';
COMMENT ON FUNCTION app.school_today() IS
  'Today in the caller''s school''s timezone.';

-- ---------------------------------------------------------------------------
-- The guard: what a teacher may change on their own absence, and that the
-- person of an absence is fixed for everybody.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.teacher_absences_own_writes_are_narrow() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  tz text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."schoolId" IS DISTINCT FROM OLD."schoolId") THEN
    RAISE EXCEPTION 'ABSENCE_PERSON_IS_FIXED: en frånvaro byter inte person'
      USING ERRCODE = 'TA409';
  END IF;
  IF app.current_user_role() IS DISTINCT FROM 'TEACHER' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT s."timezone" INTO tz FROM "Schools" s WHERE s."id" = NEW."schoolId";
    IF (NEW."startsAt" AT TIME ZONE coalesce(tz, 'Europe/Stockholm'))::date < app.school_today() THEN
      RAISE EXCEPTION 'ABSENCE_SELF_EDIT_NARROW: en lärare anmäler frånvaro från i dag'
        USING ERRCODE = 'TA403';
    END IF;
    RETURN NEW;
  END IF;

  -- (a) End early: endsAt moves earlier, not before now; nothing else moves.
  IF NEW."endsAt" < OLD."endsAt" AND NEW."endsAt" >= now()
     AND NEW."status" = OLD."status" AND NEW."status" = 'ACTIVE'
     AND NEW."startsAt" = OLD."startsAt"
     AND NEW."wholeDays" IS NOT DISTINCT FROM OLD."wholeDays"
     AND NEW."reasonId" IS NOT DISTINCT FROM OLD."reasonId"
     AND NEW."createdByUserId" IS NOT DISTINCT FROM OLD."createdByUserId"
     AND NEW."createdAt" = OLD."createdAt"
     AND NEW."withdrawnAt" IS NULL AND NEW."withdrawnByUserId" IS NULL THEN
    RETURN NEW;
  END IF;

  -- (b) Withdraw, by themself, before it starts.
  IF OLD."status" = 'ACTIVE' AND NEW."status" = 'WITHDRAWN'
     AND NEW."withdrawnAt" IS NOT NULL
     AND NEW."withdrawnByUserId" IS NOT DISTINCT FROM app.current_user_id()
     AND NEW."startsAt" = OLD."startsAt" AND NEW."endsAt" = OLD."endsAt"
     AND NEW."wholeDays" IS NOT DISTINCT FROM OLD."wholeDays"
     AND NEW."reasonId" IS NOT DISTINCT FROM OLD."reasonId"
     AND NEW."createdByUserId" IS NOT DISTINCT FROM OLD."createdByUserId"
     AND NEW."createdAt" = OLD."createdAt"
     AND OLD."startsAt" > now() THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'ABSENCE_SELF_EDIT_NARROW: en lärare kan bara avsluta sin frånvaro i förtid eller återkalla den innan den börjar'
    USING ERRCODE = 'TA403';
END
$$;

CREATE TRIGGER "TeacherAbsences_own_writes_are_narrow"
    BEFORE INSERT OR UPDATE ON "TeacherAbsences"
    FOR EACH ROW EXECUTE FUNCTION app.teacher_absences_own_writes_are_narrow();

REVOKE ALL ON FUNCTION app.teacher_absences_own_writes_are_narrow() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.cover_self_report_allowed() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.school_today() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Row-level security. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "TeacherAbsenceReasons" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TeacherAbsences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoverSettings" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "teacher_absence_reasons_admin_all" ON "TeacherAbsenceReasons"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
CREATE POLICY "teacher_absence_reasons_staff_select" ON "TeacherAbsenceReasons"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'TEACHER');

CREATE POLICY "teacher_absences_admin_all" ON "TeacherAbsences"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
CREATE POLICY "teacher_absences_own_select" ON "TeacherAbsences"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) = 'TEACHER'
        AND "userId" = (select app.current_user_id())
    );
CREATE POLICY "teacher_absences_own_insert" ON "TeacherAbsences"
    FOR INSERT TO "authenticated"
    WITH CHECK (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) = 'TEACHER'
        AND "userId" = (select app.current_user_id())
        AND "createdByUserId" = (select app.current_user_id())
        AND "status" = 'ACTIVE'
        AND (select app.cover_self_report_allowed())
    );
CREATE POLICY "teacher_absences_own_update" ON "TeacherAbsences"
    FOR UPDATE TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) = 'TEACHER'
        AND "userId" = (select app.current_user_id())
    )
    WITH CHECK (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) = 'TEACHER'
        AND "userId" = (select app.current_user_id())
        AND (select app.cover_self_report_allowed())
    );

CREATE POLICY "cover_settings_admin_all" ON "CoverSettings"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
CREATE POLICY "cover_settings_staff_select" ON "CoverSettings"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'TEACHER');

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['TeacherAbsenceReasons', 'TeacherAbsences', 'CoverSettings'] LOOP
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
  -- The policy helpers run as whoever the policy is evaluated for.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT EXECUTE ON FUNCTION app.cover_self_report_allowed() TO "authenticated";
    GRANT EXECUTE ON FUNCTION app.school_today() TO "authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT EXECUTE ON FUNCTION app.cover_self_report_allowed() TO "app_authenticated";
    GRANT EXECUTE ON FUNCTION app.school_today() TO "app_authenticated";
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- The guard: every arm on these three tables is the admin's, or a TEACHER's
-- own (current_user_id), or one of the two catalogue arms — a permissive arm
-- for authenticated, in USING and in WITH CHECK alike. Anything else, now or
-- added later and re-checked by the RLS suite, fails here.
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
       WHERE p.schemaname = 'public'
         AND p.tablename IN ('TeacherAbsenceReasons', 'TeacherAbsences', 'CoverSettings')
    ) x
   WHERE NOT x.shaped
      OR EXISTS (
        SELECT 1 FROM unnest(x.arms) e
         WHERE e NOT LIKE '%current_school_id()%'
            OR NOT (
                 e LIKE '%current_user_role()%= ''SCHOOL_ADMIN''::"UserRole"%'
              OR (e LIKE '%current_user_role()%= ''TEACHER''::"UserRole"%' AND e LIKE '%current_user_id()%')
              OR (x.policyname IN ('teacher_absence_reasons_staff_select', 'cover_settings_staff_select')
                  AND e LIKE '%current_user_role()%= ''TEACHER''::"UserRole"%')
            )
      );
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'ABSENCE_LEAK: these arms reach an absence for somebody other than the admin or the absent teacher: %', bad;
  END IF;
END
$$;
