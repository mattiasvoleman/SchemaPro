-- Ett läsårs lektioner tas bort först, på varje väg.
--
-- Removing an academic year removes its classes, its master lessons and
-- everything else that hangs on it, in one statement, by the year's foreign
-- keys. The lessons are reached by two of those routes: the classes' key
-- (StudentGroups -> CalendarLessons, CASCADE) and the master lessons' (a lesson
-- is SET NULL on its master lesson, and stays). Which route runs first is the
-- order of the keys' triggers on AcademicYears, by name
-- (RI_ConstraintTrigger_a_<oid>), and a key that is dropped and added again
-- gets a new, higher oid and moves to the end. 20270115090000 did that to
-- StudentGroups_academicYearId_schoolId_fkey, so since then the master lessons'
-- key runs first: it sets "masterLessonId" to NULL on the year's lessons, and
-- app.ss12000_v_lessons() then reads each lesson that is deleted as an ad-hoc
-- activity and files an AdhocActivity tombstone for an id no consumer was given
-- (a year with one keyed lesson and one ad-hoc lesson: AdhocActivity 3, it was
-- 1). Nothing is lost, and nothing is missing; the consumers are sent ids they
-- never had. Reported in the review of #272 (M1, R1, R2).
--
-- The service for removing a year (AcademicYearsService.remove) took the
-- lessons first by its own DELETE since #272. That is one way in. The year can
-- be removed by a DELETE in SQL, and by PostgREST with an administrator's token
-- (authenticated has DELETE on AcademicYears, and academic_years_admin_delete
-- lets a PLANERING administrator through); those followed the keys' order. And
-- the service's own DELETE of the lessons is judged by calendar_lessons_admin_delete
-- (DRIFT), a different policy from the year's (PLANERING): for a profile that
-- wrote the one and not the other it deleted nothing, without an error, and the
-- keys' order decided again. No profile is like that today (every one that
-- writes PLANERING writes DRIFT); the next one to be would not be seen.
--
-- A BEFORE DELETE trigger on AcademicYears removes the year's lessons first,
-- whoever deletes the year, through whichever door, as whichever role. The
-- service no longer does it itself: one place.
--
-- ## SECURITY DEFINER, and what that does to row-level security
--
-- The function runs as its owner, the owner of the tables. That is deliberate,
-- and it takes nothing from RLS:
--
--   * Invoker's rights would be the very fault. The lessons would then be
--     deleted by the caller, under calendar_lessons_admin_delete, and a caller
--     who may delete the year (PLANERING) but not lessons (DRIFT) would delete
--     none, without an error; the year's cascade would then remove them as the
--     owner, in the keys' order. The point is that the order does not depend on
--     who asks.
--   * It removes nothing the year's removal does not remove anyway. The rows a
--     year's DELETE cascades into are deleted by the referential action, which
--     runs as the owner of the table whose rows it deletes and passes row
--     security (FORCE ROW LEVEL SECURITY is off). A DEFINER trigger deletes the
--     same lessons earlier, by the same condition (the lesson's class belongs to
--     the year), in the same statement and transaction: if the year is not
--     deleted, they are not either.
--   * It fires only for a year the caller's DELETE reached. Row security is a
--     qualifier on the statement's scan: a year the caller's policy does not
--     show (another school's, or the caller's own as a teacher) never reaches
--     a BEFORE trigger. So the authority is academic_years_admin_delete, as it
--     was, and not the function. Sections 386-387 prove it from the other
--     school's administrator and from a teacher, and that the other school's
--     lessons stay.
--   * It takes no argument from the caller. It reads OLD (the year and its
--     school), restricts the lessons by that school as well, qualifies every
--     name and fixes search_path. A trigger needs no EXECUTE for it to fire;
--     EXECUTE is revoked from PUBLIC and every named role, so nobody can call
--     it as a function.
--
-- The tombstones come out of the lessons' own statement triggers
-- (app.ss12000_v_lessons), which see the classes and the year still in place
-- and apply the flow's rule: a lesson of a year that was never sent (a future
-- year) files none, a sent year files a CalendarEvent for each lesson and an
-- AdhocActivity only for one that had no master lesson.
--
-- BEFORE, not AFTER: the rule asks app.ss12000_year_is_emitted() whether the
-- year was sent, and the year has to be in its table to be asked. Tried as an
-- AFTER trigger, the lessons go after the year row and none of them is filed.
--
-- ## Beside the live API
--
-- Production runs this while the API before it serves requests. CREATE TRIGGER
-- takes SHARE ROW EXCLUSIVE on AcademicYears, which blocks writes to it (not
-- reads) for the length of the file. The lock is taken NOWAIT, in a loop: a
-- refusal tries again 50 ms later; it never waits while it holds a lock and no
-- request queues behind it. After 30 s it stops with nothing done and can be
-- rerun (prisma migrate resolve --rolled-back, then deploy). lock_timeout
-- bounds any wait nobody foresaw. The API before this file removes the lessons
-- itself and the trigger finds none; the API after it leaves them to the
-- trigger, so the file is applied before the API that depends on it.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "AcademicYears" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'AcademicYears was not free in 30 s: nothing is changed, run the migration again (prisma migrate resolve --rolled-back 20270120090000_ett_lasars_lektioner_tas_bort_forst_pa_varje_vag, then deploy)';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

CREATE FUNCTION app.academic_year_lessons_go_first() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  DELETE FROM "CalendarLessons" l
   USING "StudentGroups" g
   WHERE g."id" = l."studentGroupId"
     AND g."schoolId" = l."schoolId"
     AND g."academicYearId" = OLD."id"
     AND g."schoolId" = OLD."schoolId";
  RETURN OLD;
END
$$;

COMMENT ON FUNCTION app.academic_year_lessons_go_first() IS
  'BEFORE DELETE on AcademicYears: deletes the year''s lessons (those of its classes) before the year goes, so the order of the year''s cascade does not decide which SS12000 tombstones are filed. Runs as the owner, like the cascade it comes before; it is reached only for a year the caller''s DELETE policy let through, and takes nothing from the caller.';

CREATE TRIGGER "AcademicYears_a_lessons_go_first"
    BEFORE DELETE ON "AcademicYears"
    FOR EACH ROW EXECUTE FUNCTION app.academic_year_lessons_go_first();

DO $$
DECLARE
  r text;
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION app.academic_year_lessons_go_first() FROM PUBLIC';
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION app.academic_year_lessons_go_first() FROM %I', r);
    END IF;
  END LOOP;
END
$$;
