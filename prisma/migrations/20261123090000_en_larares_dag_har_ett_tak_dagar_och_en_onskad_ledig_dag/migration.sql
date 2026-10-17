-- En lärares dag har ett tak, ett antal dagar och en önskad ledig dag.
--
-- Lärarens dag: three things the administrator sets per teacher, which the
-- generator, a hand edit of the grundschema and the Vikarietavla all keep.
--
--   * TeacherWorkRules."maxTeachingMinutesPerDay": the most minutes of
--     teaching the teacher has on one day. HARD, where it is set: a week that
--     cannot keep it is refused and the refusal names it; a hand edit that
--     breaks it is warned about; a cover that would break it is not proposed.
--     30..720 and a multiple of 5, the engine's grid, like the lunch.
--   * TeacherWorkRules."preferredFreeDayOfWeek": the weekday the teacher would
--     rather have free (ISO 1..7). SOFT: the generator pays for a lesson on it
--     and does not refuse a week over it, and the Vikarietavla ranks a cover on
--     it lower.
--   * TeacherEmployments."maxTeachingDaysPerWeek": deltid in days, the most
--     weekdays with teaching the post allows, 1..6. HARD where it is set, like
--     the cap.
--
-- Null is off for all three, as for every rule on TeacherWorkRules: a school
-- that has set nothing gets the week it got before, which is what lets this
-- ship into every existing database.
--
-- ## Minutes, not lessons
--
-- The cap counts minutes because every other figure about a teacher's time
-- does — the riktmärke, the load, the lunch, the rest — and because lessons
-- are not one length: two 80-minute slöjd lessons and two 40-minute ones are
-- not the same day. The minutes are the lesson's own, start to end, of every
-- lesson the teacher is on (lead or medlärare); uppdrag and rastvakt are not
-- teaching and do not count (src/common/teacher-day.ts).
--
-- ## Who reads and writes what
--
-- The cap and the wish sit on the work rule, which every member of staff
-- reads (teacher_work_rules_staff_select) and which is not HR: the riktmärke
-- in minutes is shown to every administrator by decision, and a day's cap is
-- a fact about the timetable. The days are deltid, which is HR, so they sit
-- on the post beside the tjänstgöringsgrad: the same arms (the post is read
-- through the gateway, which leaves the days out for an administrator without
-- HR-läs, src/staffing/hr-visibility.ts), the same history (the post's log
-- records the row as JSON, so the column is logged with no change here, and
-- the gateway masks it there too), not emitted by SS12000 (a change to the
-- days alone moves the v1 Duty's meta.modified, as a changed nedsättning
-- does; docs/integration-api.md lists it).
--
-- The administrator sets all three. A teacher writes their own lunch and
-- rest today, through the gateway and through teacher_work_rules_teacher_own,
-- which is FOR ALL; that stays. The trigger below keeps the cap and the wish
-- for an administrator who writes planering: a write by anybody else that
-- would change either, or remove a row holding one, is refused with AR403,
-- which the gateway answers as a 403. The gateway refuses the same first
-- (src/resources/teacher-work-rules.service.ts); this is the answer for a
-- direct write through PostgREST. The owner, the service principal and the
-- sync act with no person and pass, as at StaffingPolicies_sharing_is_decided.
--
-- No new table, so no arm, no GRANT, and nothing in TABLE_WRITE_GATES or the
-- role matrix (RLS section 116) moves: TeacherWorkRules stays planering's,
-- TeacherEmployments the decisions'.
--
-- ## Beside the live API
--
-- Additive: three nullable columns, named CHECKs, a trigger; no row changes.
-- The API before this names only the old columns: its PUT of a work rule
-- updates the four it knows and leaves these, and nothing in it reads them.
-- The API after it reads them, so this runs first.
--
-- Production migrates beside the API that is serving it. ADD COLUMN and the
-- CHECKs take each table ACCESS EXCLUSIVE (the CHECKs scan the tables' few
-- rows; nothing is rewritten), and the trigger SHARE ROW EXCLUSIVE, which the
-- first already holds. Requests take the two tables in both orders — the
-- Vikarietavla reads the work rules and then the posts, a timplan write locks
-- the posts and the generator then reads the rules — so a migration that
-- waited for one while it held the other could close a cycle, and a waiting
-- ACCESS EXCLUSIVE queues every reader behind it. Both are taken first,
-- NOWAIT and together: a refusal rolls the subtransaction back and with it
-- whatever it got, and it tries again 50 ms later. It never waits while it
-- holds a lock. After 30 s of refusals it stops with nothing done and can be
-- rerun (prisma migrate resolve --rolled-back, then deploy). lock_timeout
-- bounds any wait nobody foresaw.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "TeacherWorkRules" IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "TeacherEmployments" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'TeacherWorkRules and TeacherEmployments were not free at once in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

ALTER TABLE "TeacherWorkRules"
    ADD COLUMN "maxTeachingMinutesPerDay" INTEGER,
    ADD COLUMN "preferredFreeDayOfWeek"   INTEGER,
    ADD CONSTRAINT "TeacherWorkRules_maxTeachingMinutesPerDay_check"
        CHECK ("maxTeachingMinutesPerDay" BETWEEN 30 AND 720 AND "maxTeachingMinutesPerDay" % 5 = 0),
    ADD CONSTRAINT "TeacherWorkRules_preferredFreeDayOfWeek_check"
        CHECK ("preferredFreeDayOfWeek" BETWEEN 1 AND 7);

ALTER TABLE "TeacherEmployments"
    ADD COLUMN "maxTeachingDaysPerWeek" INTEGER,
    ADD CONSTRAINT "TeacherEmployments_maxTeachingDaysPerWeek_check"
        CHECK ("maxTeachingDaysPerWeek" BETWEEN 1 AND 6);

COMMENT ON COLUMN "TeacherWorkRules"."maxTeachingMinutesPerDay" IS
  'Most minutes of teaching on one day, hard where set; null = no cap. Set by an administrator who writes planering.';
COMMENT ON COLUMN "TeacherWorkRules"."preferredFreeDayOfWeek" IS
  'ISO weekday the teacher would rather have free, soft; null = no wish. Set by an administrator who writes planering.';
COMMENT ON COLUMN "TeacherEmployments"."maxTeachingDaysPerWeek" IS
  'Deltid in days: most weekdays with teaching, hard where set; null = no limit. HR data, like the tjänstgöringsgrad.';

-- ---------------------------------------------------------------------------
-- The cap and the wish are the administrator's.
--
-- Judged for a signed-in person's own writes only, like
-- app.staffing_policies_sharing_is_decided: the owner (a migration, the
-- seed), the service principal and the sync act with no person. Row
-- security already admits a person's write only through an administrator's
-- arm (planering) or the teacher's own; this asks the second kind to leave
-- the two columns as they are. A DELETE is a write of both to null, so a
-- teacher cannot remove a row that holds either; the gateway turns such a
-- teacher's DELETE into clearing their own lunch and rest.
--
-- THE TEACHER'S OWN ROW, and only that. The one other write that reaches a
-- row without planering is the foreign key's cascade: personal removes a
-- teacher, and the teacher's work rule goes with them. That delete runs as
-- the person removing, who is not the row's teacher, and must not be
-- refused for a cap they never touched.
--
-- AN UPSERT IS JUDGED AS THE UPDATE IT BECOMES. The gateway writes a rule
-- with INSERT … ON CONFLICT ("userId") DO UPDATE, and Postgres fires BEFORE
-- INSERT on the proposed row before it finds the conflict. The proposed row
-- carries whatever the statement named and NULL for the rest, so judged as
-- an insert it would refuse a teacher restating the cap the administrator
-- set, and judged against the stored row it would refuse every write that
-- leaves the cap out. So an INSERT for a teacher who already has a row
-- passes here, and the BEFORE UPDATE that ON CONFLICT then fires judges the
-- change actually made. The stored row is locked FOR KEY SHARE while this
-- decides, so it cannot be deleted in between and turn the insert into a
-- fresh row nobody judged.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.teacher_work_rules_day_is_planned() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  cap_before integer;
  wish_before integer;
  cap_after integer;
  wish_after integer;
  teacher uuid;
BEGIN
  IF app.current_user_id() IS NULL
     OR app.current_service_school_id() IS NOT NULL
     OR app.current_sync_school_id() IS NOT NULL THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    cap_before := OLD."maxTeachingMinutesPerDay";
    wish_before := OLD."preferredFreeDayOfWeek";
    teacher := OLD."userId";
  END IF;
  IF TG_OP <> 'DELETE' THEN
    cap_after := NEW."maxTeachingMinutesPerDay";
    wish_after := NEW."preferredFreeDayOfWeek";
    teacher := NEW."userId";
  END IF;
  IF TG_OP = 'INSERT' AND EXISTS (
    SELECT 1 FROM "TeacherWorkRules" r WHERE r."userId" = NEW."userId" FOR KEY SHARE
  ) THEN
    RETURN NEW;
  END IF;
  IF (cap_after IS DISTINCT FROM cap_before OR wish_after IS DISTINCT FROM wish_before)
     AND teacher = app.current_user_id()
     AND NOT app.current_user_may('PLANERING', true) THEN
    RAISE EXCEPTION 'WORK_RULE_DAY_IS_PLANNED: dagstaket och den önskade lediga dagen sätts av en administratör som planerar'
      USING ERRCODE = 'AR403',
            DETAIL  = 'area=PLANERING';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "TeacherWorkRules_day_is_planned"
    BEFORE INSERT OR UPDATE OR DELETE ON "TeacherWorkRules"
    FOR EACH ROW EXECUTE FUNCTION app.teacher_work_rules_day_is_planned();

-- A trigger function, called by the trigger and by nobody: no role executes
-- it directly, as for every app.* trigger function since 20261110100000.
DO $$
DECLARE
  r text;
BEGIN
  REVOKE ALL ON FUNCTION app.teacher_work_rules_day_is_planned() FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'app_authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION app.teacher_work_rules_day_is_planned() FROM %I', r);
    END IF;
  END LOOP;
END
$$;
