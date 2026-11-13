-- En avaktiverad person minns sina perioder.
--
-- Users."deactivatedAt" (20261021100000) is the moment "isActive" last went
-- from true to false, and the trigger that keeps it clears it when the person
-- is made active again. That is the right date for gallring, which counts a
-- departed person's period from the last time they left. It is the wrong
-- thing to read for a person's time, in two ways Analys och planering (K1,
-- #280) and Frånvarostatistik (D6) both inherited and the review of #280 named
-- (LÅG-1 and LÅG-2):
--
--   * A person who is made active again is counted as if they had never left.
--     A lesson nobody covered, and a stored uppdrag, in the weeks between the
--     two clicks is booked on them when a löneunderlag for a period in that
--     gap is made, or made again, after the return. D6 counts such a lesson as
--     one the teacher had to report.
--   * The stamp is the administrator's click. Whoever deactivates a person
--     three days after their last day has the three days booked, and nothing
--     could say otherwise: the stamp is written by a trigger, whatever the
--     statement says.
--
-- ## The table
--
-- UserDeactivations has a row for every period a person has been inactive:
--
--   "startsAt"   the instant their time stops counting. Normally the moment
--                of the click (the same instant as Users."deactivatedAt"),
--                and earlier when an administrator names the person's last
--                working day (UsersService.update, "leftOn"): a lesson that
--                was over by it still counts, as it did for the stamp.
--   "endsAt"     the instant the person was made active again; NULL while they
--                are inactive.
--   "recordedAt" when the row was written. "startsAt" is never later than it
--                (CHECK): a person's last day is not in the future.
--
-- A person is inactive in exactly one open row (endsAt NULL) and active in
-- none; the exclusion constraint holds that the periods of one person never
-- overlap, so a last day named before the person's previous return is refused
-- (23P01) and the service says so first. A lesson counts to a person if it
-- was over when they were active, that is, unless "startsAt" < its end < "endsAt"
-- (or no "endsAt"): at the instant they left it still counts, as D6's rule
-- `endsAt <= deactivatedAt` always said, and at the instant they returned it
-- counts too. An uppdrag runs by the day and is not charged for a day on
-- which the person was inactive at its start: from the school's date of
-- "startsAt" to the day before the school's date of "endsAt" (a person who
-- leaves and returns the same day loses no day).
--
-- ## Written by a trigger
--
-- app.users_deactivations_are_kept, AFTER INSERT and AFTER UPDATE OF
-- "isActive" on Users, SECURITY DEFINER: a row that is inserted inactive or
-- goes inactive opens a period at its "deactivatedAt"; a row that goes active
-- closes the open one at the moment it happens. The period is opened no
-- earlier than the previous one closed, so two administrators who flip the
-- same person at once cannot make them overlap. Every writer goes through it:
-- the administrator's edit, an SS12000 apply that ends a pupil or guardian,
-- the seed and the fixtures. A release that does not know the table writes
-- isActive alone and the table follows, so this is backward compatible.
-- Users."deactivatedAt" is unchanged and still the click: gallring counts
-- from it, and a backdated last day must not shorten a retention period.
--
-- The API role may read the table (a school's administrators, every profile)
-- and change one column of an open row, "startsAt", which is how a last day
-- is named for a person who is already inactive. No role may insert or delete.
--
-- ## What is carried over
--
-- Every person who is inactive today has an open period from their
-- "deactivatedAt". A person who was inactive and became active again before
-- this migration has none: Users forgot the date when they returned, and no
-- other table kept it (TeacherEmploymentLogs logs a post, Ss12000EntityVersions
-- is a counter), so the gap of an earlier return stays counted as it was and no
-- earlier figure changes.
--
-- ## Frånvarostatistik
--
-- app.absence_stats_lessons (D6) is replaced by its own body with the one line
-- about the teacher exchanged: the teacher counts unless the lesson ended
-- inside one of their inactive periods. The body is written by 20270122091000
-- and checked by md5 first; the migration stops if it is not as written. Months
-- D6 has already stored are not recomputed.
--
-- ## Beside the live API: every lock at once, or none
--
-- The foreign keys take SHARE ROW EXCLUSIVE on Schools and Users, and so does
-- CREATE TRIGGER on Users: writes wait, reads do not, for as long as the file
-- runs (milliseconds: the table is new and the backfill reads Users). A request
-- that writes Users and then reads a post, and one that does the reverse,
-- could close a cycle with a migration that waited for one lock while holding
-- the other. So both are taken first, NOWAIT and together, in a loop: a refusal
-- rolls the subtransaction back and with it whatever it got, and it tries again
-- 50 ms later. After 30 s of refusals it stops with nothing changed: run
-- `prisma migrate resolve --rolled-back 20270210090000_en_avaktiverad_person_minns_sina_perioder`
-- and deploy again. lock_timeout bounds any wait nobody foresaw.

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
        RAISE EXCEPTION 'Schools and Users were not free at once in 30 s: nothing is changed; run prisma migrate resolve --rolled-back 20270210090000_en_avaktiverad_person_minns_sina_perioder and deploy again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- The function that is replaced is as 20270122091000 wrote it, or nothing changes.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  body text;
BEGIN
  PERFORM set_config('search_path', 'public, pg_temp', true);
  SELECT md5(p.prosrc) INTO body FROM pg_proc p WHERE p.oid = to_regprocedure('app.absence_stats_lessons(uuid, date, date, timestamptz)');
  IF body IS DISTINCT FROM '265b9b21353ecd7e441397f99e565643' THEN
    RAISE EXCEPTION 'app.absence_stats_lessons is not as 20270122091000 wrote it (md5 of its body %, expected 265b9b21353ecd7e441397f99e565643), so it is not replaced',
      coalesce(body, '(no such function)');
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- The table
-- ---------------------------------------------------------------------------

CREATE TABLE "UserDeactivations" (
    "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"   UUID NOT NULL,
    "userId"     UUID NOT NULL,
    "startsAt"   TIMESTAMPTZ(6) NOT NULL,
    "endsAt"     TIMESTAMPTZ(6),
    "recordedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "UserDeactivations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "UserDeactivations_schoolId_fkey" FOREIGN KEY ("schoolId")
        REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "UserDeactivations_userId_schoolId_fkey" FOREIGN KEY ("userId", "schoolId")
        REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "UserDeactivations_ends_after_it_starts" CHECK ("endsAt" IS NULL OR "startsAt" < "endsAt"),
    CONSTRAINT "UserDeactivations_starts_before_it_is_recorded" CHECK ("startsAt" <= "recordedAt"),
    CONSTRAINT "UserDeactivations_one_period_at_a_time"
        EXCLUDE USING gist ("userId" WITH =, tstzrange("startsAt", "endsAt") WITH &&)
);

CREATE INDEX "UserDeactivations_schoolId_userId_idx" ON "UserDeactivations" ("schoolId", "userId");
CREATE INDEX "UserDeactivations_userId_schoolId_startsAt_idx" ON "UserDeactivations" ("userId", "schoolId", "startsAt");

COMMENT ON TABLE "UserDeactivations" IS
  'Every period a person has been inactive: from "startsAt" (the click, or the person''s last working day when an administrator named it) to "endsAt" (the person was made active again; NULL while inactive). Written by Users_deactivations_are_kept; the API role changes "startsAt" of an open row and nothing else.';

-- ---------------------------------------------------------------------------
-- The trigger
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.users_deactivations_are_kept() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  opened timestamptz;
  closed timestamptz;
BEGIN
  IF NOT NEW."isActive" AND (TG_OP = 'INSERT' OR OLD."isActive") THEN
    -- Never before the previous return: two administrators who flip the same
    -- person at once must not leave overlapping periods.
    SELECT greatest(NEW."deactivatedAt", max(d."endsAt")) INTO opened
      FROM "UserDeactivations" d WHERE d."userId" = NEW."id";
    INSERT INTO "UserDeactivations" ("schoolId", "userId", "startsAt", "recordedAt")
    VALUES (NEW."schoolId", NEW."id", opened, greatest(clock_timestamp(), opened));
  ELSIF NEW."isActive" AND TG_OP = 'UPDATE' AND NOT OLD."isActive" THEN
    closed := clock_timestamp();
    -- A period the close would leave with no length, which the CHECK would
    -- refuse (a start that is not before the moment of closing), leaves
    -- nothing behind. A flip in one transaction does leave its few
    -- milliseconds, and no lesson ends inside them.
    DELETE FROM "UserDeactivations" d WHERE d."userId" = NEW."id" AND d."endsAt" IS NULL AND d."startsAt" >= closed;
    UPDATE "UserDeactivations" d SET "endsAt" = closed WHERE d."userId" = NEW."id" AND d."endsAt" IS NULL;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "Users_deactivations_are_kept"
    AFTER INSERT OR UPDATE OF "isActive" ON "Users"
    FOR EACH ROW EXECUTE FUNCTION app.users_deactivations_are_kept();

COMMENT ON FUNCTION app.users_deactivations_are_kept() IS
  'Keeps UserDeactivations beside Users."isActive": a person who is inserted inactive or goes inactive opens a period at "deactivatedAt" (no earlier than their previous return), a person who goes active closes the open one.';

-- ---------------------------------------------------------------------------
-- What can be carried over: every person who is inactive today.
-- ---------------------------------------------------------------------------

INSERT INTO "UserDeactivations" ("schoolId", "userId", "startsAt", "recordedAt")
SELECT u."schoolId", u."id", u."deactivatedAt", greatest(clock_timestamp(), u."deactivatedAt")
  FROM "Users" u
 WHERE NOT u."isActive" AND u."deactivatedAt" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Row-level security: read by the school's administrators, every profile;
-- "startsAt" of an open row changed by personal's writers (a last working day
-- named later); written by nobody else.
-- ---------------------------------------------------------------------------

ALTER TABLE "UserDeactivations" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_deactivations_admin_select" ON "UserDeactivations"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

-- The gate is Users': personal's writers deactivate a member of staff, so
-- they are the ones who may name the person's last day (Roller i skolan,
-- 20261110100000; TABLE_WRITE_GATES in src/auth/admin-areas.ts). As on every
-- table, an UPDATE asks the area in WITH CHECK only: USING also serves a
-- locking read, which no profile's area should turn into an empty answer.
CREATE POLICY "user_deactivations_admin_update" ON "UserDeactivations"
    FOR UPDATE TO "authenticated"
    USING ("schoolId" = (select app.current_school_id())
           AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
           AND "endsAt" IS NULL)
    WITH CHECK ("schoolId" = (select app.current_school_id())
                AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                AND (select app.current_user_may('PERSONAL', true))
                AND "endsAt" IS NULL);

-- ---------------------------------------------------------------------------
-- Grants, guarded: REVOKE ALL first, so MAINTAIN goes too on Postgres 17
-- (20261016120000); the gateway reads and changes one column; PostgREST's role
-- and anon hold nothing; service_role reads (20261016130000). The trigger
-- function is no API role's to call.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['app_authenticated', 'authenticated', 'anon', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "UserDeactivations" FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT SELECT ON "UserDeactivations" TO "app_authenticated";
    GRANT UPDATE ("startsAt") ON "UserDeactivations" TO "app_authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT ON "UserDeactivations" TO "service_role";
  END IF;

  EXECUTE 'REVOKE ALL ON FUNCTION app.users_deactivations_are_kept() FROM PUBLIC';
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'app_authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION app.users_deactivations_are_kept() FROM %I', r);
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Frånvarostatistik (D6): 20270122091000's body with the one line about the
-- teacher exchanged. Not SECURITY DEFINER and without SET, as before: it is
-- read by app.absence_stats_month and its siblings, which are.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.absence_stats_lessons(p_school uuid, p_from date, p_to date, p_now timestamptz)
RETURNS TABLE (lesson_id uuid, teacher_id uuid, day date,
               starts_at timestamptz, ends_at timestamptz, reported boolean)
LANGUAGE sql STABLE AS $$
  SELECT cl."id", t."teacherId", cl."date", cl."startsAt", cl."endsAt", r."saved"
    FROM "public"."CalendarLessons" cl
    JOIN "public"."CalendarLessonTeachers" t
      ON t."calendarLessonId" = cl."id" AND t."schoolId" = cl."schoolId"
    JOIN "public"."Users" u
      ON u."id" = t."teacherId" AND u."schoolId" = cl."schoolId"
     AND u."role" = 'TEACHER' AND NOT EXISTS (SELECT 1 FROM "public"."UserDeactivations" d WHERE d."userId" = u."id" AND d."startsAt" < cl."endsAt" AND (d."endsAt" IS NULL OR cl."endsAt" < d."endsAt"))
   CROSS JOIN LATERAL (
           SELECT EXISTS (SELECT 1 FROM "public"."AttendanceRecords" a
                           WHERE a."calendarLessonId" = t."calendarLessonId" AND a."status" <> 'UNKNOWN') AS "saved") r
   WHERE cl."schoolId" = p_school
     AND cl."date" BETWEEN p_from AND p_to
     AND cl."status" IN ('SCHEDULED', 'COMPLETED')
     AND cl."endsAt" <= p_now
     AND (
           r."saved"
        OR EXISTS (SELECT 1 FROM "public"."Users" p
                    WHERE p."studentGroupId" = cl."studentGroupId" AND p."role" = 'STUDENT' AND p."isActive")
        OR EXISTS (SELECT 1 FROM "public"."StudentEnrollments" e
                    WHERE e."studentGroupId" = cl."studentGroupId"
                      AND e."validFrom" <= cl."date" AND (e."validTo" IS NULL OR cl."date" < e."validTo"))
        OR EXISTS (SELECT 1 FROM "public"."StudentGroupMembers" m
                    JOIN "public"."Users" p ON p."id" = m."studentId"
                   WHERE m."studentGroupId" = cl."studentGroupId" AND p."role" = 'STUDENT')
        OR EXISTS (SELECT 1 FROM "public"."CalendarLessonGroups" x
                    JOIN "public"."Users" p ON p."studentGroupId" = x."studentGroupId"
                   WHERE x."calendarLessonId" = cl."id" AND p."role" = 'STUDENT' AND p."isActive")
        OR EXISTS (SELECT 1 FROM "public"."CalendarLessonGroups" x
                    JOIN "public"."StudentEnrollments" e ON e."studentGroupId" = x."studentGroupId"
                   WHERE x."calendarLessonId" = cl."id"
                     AND e."validFrom" <= cl."date" AND (e."validTo" IS NULL OR cl."date" < e."validTo"))
        OR EXISTS (SELECT 1 FROM "public"."CalendarLessonGroups" x
                    JOIN "public"."StudentGroupMembers" m ON m."studentGroupId" = x."studentGroupId"
                    JOIN "public"."Users" p ON p."id" = m."studentId"
                   WHERE x."calendarLessonId" = cl."id" AND p."role" = 'STUDENT')
        OR EXISTS (SELECT 1 FROM "public"."CalendarLessonStudents" n
                    JOIN "public"."Users" p ON p."id" = n."studentId"
                   WHERE n."calendarLessonId" = cl."id" AND p."role" = 'STUDENT'
                     -- Elevens lektion för dagen: a named pupil moved off the lesson is not on its list.
                     AND NOT EXISTS (SELECT 1 FROM "public"."LessonPupilMoves" mv
                                      WHERE mv."fromLessonId" = cl."id" AND mv."studentId" = n."studentId"))
         )
     AND NOT EXISTS (
           SELECT 1 FROM "public"."TeacherAbsences" ab
            WHERE ab."schoolId" = cl."schoolId" AND ab."userId" = t."teacherId"
              AND ab."status" = 'ACTIVE'
              AND ab."startsAt" < cl."endsAt" AND cl."startsAt" < ab."endsAt")
$$;
