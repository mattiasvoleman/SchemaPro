-- En lärares egen ändring går inte förbi skolans beslut.
--
-- The guard of 20261012090000 (widened by 20261012100000) decides what a
-- TEACHER may do with their own absence when the school allows self-report:
-- end it early, never before now, or withdraw it. The API asks more of them
-- than the guard did. A teacher's withdrawal or early end that would leave a
-- cover decision behind is refused by the service (ABSENCE_HAS_DECISIONS:
-- only the admin may undo a decision), but the teacher holds the same
-- UPDATE through Supabase with their own JWT, and there the guard was the
-- only rule. A review reproduced it as app_authenticated:
--
--   * the admin covers the teacher's lesson tomorrow (her LEAD row removed,
--     a SUBSTITUTE row added, a SUBSTITUTE decision written); she then
--     withdraws the absence straight against the database. Path (b) let it
--     through because the absence had not started, and it read the
--     decisions only in its "within the hour" branch. The board reads
--     decisions of ACTIVE absences only, so nobody could undo it any more:
--     the absent teacher was off her lesson for good and the substitute
--     stayed booked.
--   * path (a), ending early, read no decision at all, so she could shorten
--     the absence past decisions on lessons still ahead.
--   * createdAt was hers to write on INSERT, and the 60-minute withdrawal
--     window reads it: a createdAt ten years ahead made "now − createdAt"
--     negative, so a started absence could be withdrawn for ever. Path (b)
--     took any withdrawnAt, so the withdrawal could be backdated too.
--
-- The guard function is replaced, and nothing else about it changes:
--
--   * withdraw (b): never while ANY decision references the absence — in
--     both branches, before the start and within the hour — which is what
--     the API says to a teacher (a held decision refuses even an admin's
--     withdrawal; one still ahead needs the admin's undo);
--   * end early (a): never past a decision on a lesson that has not ended
--     and lies outside the new period [startsAt, endsAt) — the service's
--     settleDecisionsOutside, against the same lessons. A teacher's end is
--     never before now, so every such lesson is still ahead;
--   * a teacher's INSERT gets createdAt and updatedAt = now(), and every
--     teacher UPDATE gets updatedAt = now(), withdrawnAt = now() on a
--     withdrawal: the clock is the database's, not the caller's. Prisma's
--     own @updatedAt and @default(now()) write the same instant, so the
--     API's writes are unchanged.
--
-- The trigger reads the decisions and their lessons as its owner (SECURITY
-- DEFINER, search_path pinned), as before: the teacher's own_select on the
-- decisions is not what it relies on.
--
-- ## The leak guard, anchored
--
-- The pg_policies guard of each earlier migration accepted an arm that
-- named the TEACHER role and mentioned current_user_id() ANYWHERE in it. An
-- arm `role = 'TEACHER' AND current_user_id() IS NOT NULL`, or an own arm
-- widened with `OR true`, passed it and would have let every colleague read
-- every reason. The rule now lives in one function,
-- app.cover_policy_arm_is_narrow(table, policy, arm), which this migration's
-- guard and the RLS suite (28g) both call — the suite also feeds it arms
-- that must fail. An arm passes only when it:
--
--   * names the caller's school (current_school_id()),
--   * has no OR and no NOT anywhere (an AND of conditions can only narrow),
--   * and is either the admin's (role = SCHOOL_ADMIN), or a TEACHER's own
--     with the table's own column anchored to the caller —
--       TeacherAbsences, SubstitutePoolMembers, SubstituteAvailabilities:
--         ("userId" = ( SELECT app.current_user_id() …
--       TeacherAbsenceCovers:
--         ("absentTeacherId" = ( SELECT app.current_user_id() …
--     — or one of the two catalogue arms (the school's reason list and its
--     cover switches, which every teacher reads by design).
--
-- The function reads no table and is IMMUTABLE; EXECUTE for the API role
-- only (the suite runs as it), none for anon or PUBLIC. No data is written,
-- no policy changes: every arm in place passes the stricter rule, and the
-- deploy fails here if one does not.

CREATE OR REPLACE FUNCTION app.teacher_absences_own_writes_are_narrow() RETURNS trigger
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
    -- The database's clock: the 60-minute window reads createdAt.
    NEW."createdAt" := now();
    NEW."updatedAt" := now();
    RETURN NEW;
  END IF;

  -- (a) End early: endsAt moves earlier, not before now; nothing else moves;
  -- and no decision on a lesson still ahead falls outside the new period.
  IF NEW."endsAt" < OLD."endsAt" AND NEW."endsAt" >= now()
     AND NEW."status" = OLD."status" AND NEW."status" = 'ACTIVE'
     AND NEW."startsAt" = OLD."startsAt"
     AND NEW."wholeDays" IS NOT DISTINCT FROM OLD."wholeDays"
     AND NEW."reasonId" IS NOT DISTINCT FROM OLD."reasonId"
     AND NEW."createdByUserId" IS NOT DISTINCT FROM OLD."createdByUserId"
     AND NEW."createdAt" = OLD."createdAt"
     AND NEW."withdrawnAt" IS NULL AND NEW."withdrawnByUserId" IS NULL
     AND NOT EXISTS (
       SELECT 1
         FROM "TeacherAbsenceCovers" c
         JOIN "CalendarLessons" l ON l."id" = c."calendarLessonId"
        WHERE c."absenceId" = OLD."id"
          AND l."endsAt" > now()
          AND NOT (l."startsAt" < NEW."endsAt" AND l."endsAt" > NEW."startsAt")
     ) THEN
    NEW."updatedAt" := now();
    RETURN NEW;
  END IF;

  -- (b) Withdraw, by themself: before it starts, or within an hour of
  -- registering it — and never while a decision references it.
  IF OLD."status" = 'ACTIVE' AND NEW."status" = 'WITHDRAWN'
     AND NEW."withdrawnAt" IS NOT NULL
     AND NEW."withdrawnByUserId" IS NOT DISTINCT FROM app.current_user_id()
     AND NEW."startsAt" = OLD."startsAt" AND NEW."endsAt" = OLD."endsAt"
     AND NEW."wholeDays" IS NOT DISTINCT FROM OLD."wholeDays"
     AND NEW."reasonId" IS NOT DISTINCT FROM OLD."reasonId"
     AND NEW."createdByUserId" IS NOT DISTINCT FROM OLD."createdByUserId"
     AND NEW."createdAt" = OLD."createdAt"
     AND NOT EXISTS (SELECT 1 FROM "TeacherAbsenceCovers" c WHERE c."absenceId" = OLD."id")
     AND (OLD."startsAt" > now() OR now() - OLD."createdAt" <= interval '60 minutes') THEN
    NEW."withdrawnAt" := now();
    NEW."updatedAt" := now();
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'ABSENCE_SELF_EDIT_NARROW: en lärare kan bara avsluta sin frånvaro i förtid eller återkalla den, och aldrig förbi skolans beslut'
    USING ERRCODE = 'TA403';
END
$$;

REVOKE ALL ON FUNCTION app.teacher_absences_own_writes_are_narrow() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- The leak rule, once. See the preamble.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.cover_policy_arm_is_narrow(p_table text, p_policy text, p_arm text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = "pg_catalog" AS $$
  SELECT p_arm LIKE '%current_school_id()%'
     AND p_arm NOT LIKE '% OR %'
     AND p_arm NOT LIKE '%NOT %'
     AND (
          p_arm LIKE '%current_user_role()%= ''SCHOOL_ADMIN''::"UserRole"%'
       OR (p_arm LIKE '%current_user_role()%= ''TEACHER''::"UserRole"%'
           AND CASE
                 WHEN p_table IN ('TeacherAbsences', 'SubstitutePoolMembers', 'SubstituteAvailabilities')
                   THEN p_arm LIKE '%("userId" = ( SELECT app.current_user_id() AS current_user_id))%'
                 WHEN p_table = 'TeacherAbsenceCovers'
                   THEN p_arm LIKE '%("absentTeacherId" = ( SELECT app.current_user_id() AS current_user_id))%'
                 ELSE false
               END)
       OR (p_table || '.' || p_policy IN ('TeacherAbsenceReasons.teacher_absence_reasons_staff_select',
                                         'CoverSettings.cover_settings_staff_select')
           AND p_arm LIKE '%current_user_role()%= ''TEACHER''::"UserRole"%')
     )
$$;

COMMENT ON FUNCTION app.cover_policy_arm_is_narrow(text, text, text) IS
  'Whether a policy arm on the absence and pool tables reaches only the admin, the teacher''s own rows or the two catalogues (20261012130000).';

REVOKE ALL ON FUNCTION app.cover_policy_arm_is_narrow(text, text, text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT EXECUTE ON FUNCTION app.cover_policy_arm_is_narrow(text, text, text) TO "app_authenticated";
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- The guard, over all six tables, with the rule above.
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
         AND p.tablename IN ('TeacherAbsenceReasons', 'TeacherAbsences', 'CoverSettings', 'TeacherAbsenceCovers',
                             'SubstitutePoolMembers', 'SubstituteAvailabilities')
    ) x
   WHERE NOT x.shaped
      OR EXISTS (
        SELECT 1 FROM unnest(x.arms) e WHERE NOT app.cover_policy_arm_is_narrow(x.tablename, x.policyname, e)
      );
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'ABSENCE_LEAK: these arms reach an absence, a decision or the pool for somebody other than the admin or the person themself: %', bad;
  END IF;
END
$$;
