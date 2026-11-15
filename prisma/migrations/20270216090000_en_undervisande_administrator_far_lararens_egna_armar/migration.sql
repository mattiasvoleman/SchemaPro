-- En administratör som undervisar, del 3: databasens armar. Lärarens egna armar får markeringen.
--
-- ## Why
--
-- 20270212090000 added Users."teaches" and app.current_user_teaches() and no
-- policy asks for them yet. A marked administrator (a rektor or a
-- schemaläggare who also teaches) is still refused wherever the teacher's own
-- arm says current_user_role() = 'TEACHER', because the role is
-- SCHOOL_ADMIN. This migration gives the marked administrator the teacher's
-- OWN arms beside the administrator's, which stay exactly as they are
-- (beslut 7: the view narrows, the right stays the administrator's).
--
-- ## What is converted, and what is not
--
-- An arm that is converted gets the mark in OR with the teacher test, in the
-- arm's own style (an initplan, not a call per row):
--
--     ((select current_user_role()) = 'TEACHER' OR (select current_user_teaches()))
--
-- 16 arms, on 10 tables. Each is the teacher's own row (the person's absence,
-- post, duty, working-time rules, unavailability, the lessons they teach) or
-- the note to the substitute:
--
--   AttendanceRecords          attendance_teacher_insert / _update
--   AvailabilityConstraints    availability_teacher_modify
--   LessonSubstituteNotes      lesson_substitute_notes_teacher_select / _insert / _update / _delete
--   TeacherAbsenceCovers       teacher_absence_covers_own_select
--   TeacherAbsences            teacher_absences_own_insert / _select / _update
--   TeacherDuties              teacher_duties_teacher_own_select
--   TeacherEmploymentLogs      teacher_employment_logs_teacher_own_select
--   TeacherEmploymentPeriods   teacher_employment_periods_teacher_own_select
--   TeacherEmployments         teacher_employments_teacher_own_select
--   TeacherWorkRules           teacher_work_rules_teacher_own
--
-- They are TO "authenticated", which "app_authenticated" (the API's role) is a
-- member of: they apply to the API and to PostgREST's door alike. Where an
-- administrator arm TO "app_authenticated" already admits the marked person
-- (every markable profile writes DRIFT, and an administrator reads every row)
-- the conversion changes the API's answer for nobody; what it adds is the
-- PostgREST door, where an administrator has no arm on these tables, and the
-- web pages that read through it. The one profile that does not write
-- PLANERING, the expedition, gains the teacher's right to write their own
-- unavailability and working-time rules through the API as well, which is what
-- the teacher's arm is for (the guard below holds them to the teacher's on an
-- unavailability a duty blocks).
--
-- Five arms that name TEACHER are NOT converted, because the administrator
-- arm for the same table, the same verb and the same role ("authenticated")
-- already admits every row they admit: CancellationBatchCredits,
-- PublicationPendingRemovals, PublishedLessons and TeacherAbsenceReasons
-- (staff_select) and TeacherDutySlots (teacher_duty_slots_teacher_own_select
-- against teacher_duty_slots_admin_select). A conversion would change no
-- answer for anybody and would add an initplan to a read. RLS section 494
-- lists them as STAYS with that reason, and section 505 proves it.
--
-- ## The note to the substitute (beslut 4 and 6)
--
-- The only arm where the teacher's arm gives MORE than the administrator's:
-- an administrator has no arm on LessonSubstituteNotes at all (section 232:
-- "never an administrator"). A marked administrator who STANDS ON a lesson
-- (a CalendarLessonTeachers row that is not SUBSTITUTE, or the absent
-- teacher of a cover decision on it) may read, write, change and remove its
-- note, as a teacher does, and ONLY if they have a post (TeacherEmployments)
-- for the lesson's läsår. Risk 3 of the investigation: a schemaläggare who
-- writes CalendarLessonTeachers could otherwise put themselves on a lesson to
-- read what it says. The lesson's läsår is its student group's
-- (CalendarLessons has no year of its own; a group belongs to one year, and a
-- lesson is held by its group). PR 1 asked for a post for ANY year when the
-- mark is set; this is the question that matters for a lesson, and it is
-- asked here, where the arm is.
--
-- The rule lives in app.lesson_teacher_role(lesson), which the four arms ask
-- and which a gateway route may ask before it writes (one rule, so a 403 and
-- the database's refusal are the same): for a marked administrator it answers
-- 'REGULAR' only, never 'SUBSTITUTE' (beslut 4: no administrator is a
-- substitute), and only with the post. The teacher's own branch is unchanged
-- word for word, and no post is asked of a TEACHER. The arms also carry the
-- mark in OR, so a function asked for anybody else is no way in.
--
-- ## Three functions, read from the catalogue and changed in place
--
-- * app.lesson_teacher_role: as above.
-- * app.availability_constraints_keep_duty_blocks: a TEACHER is refused
--   (TD403) when they change or delete an unavailability that a duty blocks
--   ("the slot is the duty's, and the duty is the admin's"). A marked
--   administrator reaches their own unavailability through the teacher's arm
--   (availability_teacher_modify) and, if they do not write PLANERING (the
--   expedition), through nothing else: for them the guard must be the
--   teacher's. A marked administrator who writes PLANERING owns the duty and
--   passes, as they do today (beslut 7: nothing an administrator can do is
--   taken away).
-- * app.cover_policy_arm_is_narrow (20261012130000): the rule that no arm on
--   the absence, cover and pool tables reaches anybody but the administrator,
--   the teacher themself or the two catalogues. It refuses any arm with an OR,
--   and the converted arms on TeacherAbsences and TeacherAbsenceCovers have
--   exactly one: the mark. The function now takes that one OR, written as the
--   catalogue prints it, as the teacher's test it extends, and judges the arm
--   as before; any other OR is refused as before. The migration's own guard
--   (below) and RLS sections 28g/112 hold the rule over the real arms.
--
-- Left as they are, with the reason in RLS section 494 (STAYS):
--   app.teacher_absences_own_writes_are_narrow: it narrows a TEACHER's own
--     absence to "from today, end early or withdraw". Every markable profile
--     writes DRIFT, so a marked administrator may already do what it would
--     refuse; narrowing them is taking a right away (beslut 7).
--   app.teacher_duties_slots_stay_the_teachers, teacher_duty_slots_are_links,
--     teacher_duty_slots_are_the_teachers: 'TEACHER' there is the kind of
--     resource (ConstraintResource), not a role.
--
-- ## Text is patched from the catalogue, not copied
--
-- Cover, leave and reporting functions are changed by parallel branches, and a
-- function replaced from a copy of an old body drops their change without a git
-- conflict. So each policy's and function's text is read from the catalogue
-- when this runs and changed at named places, each with the number of
-- occurrences it expects; a text that is not as expected stops the migration
-- with nothing changed.
--
-- ## Beside the live API: every lock at once, or none
--
-- ALTER POLICY takes ACCESS EXCLUSIVE on its table (measured). The ten tables
-- are locked first, NOWAIT and together, in one fixed order, in a loop: a
-- refusal rolls the subtransaction back and with it whatever it got, and it
-- tries again 50 ms later, so the migration never waits while it holds a lock,
-- is in no cycle with a request that takes the same tables the other way
-- round, and no request queues behind it. After 30 s of refusals it stops with
-- nothing done; Prisma then marks the migration failed (P3009 on every later
-- deploy) until `prisma migrate resolve --rolled-back <name>` has been run,
-- and the message says so. lock_timeout bounds any wait nobody foresaw.
--
-- Nothing changes for a person who is not marked: the mark is false for every
-- row at the time of this migration, and every arm is the old arm OR false.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "AttendanceRecords" IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "AvailabilityConstraints" IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "LessonSubstituteNotes" IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "TeacherAbsenceCovers" IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "TeacherAbsences" IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "TeacherDuties" IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "TeacherEmploymentLogs" IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "TeacherEmploymentPeriods" IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "TeacherEmployments" IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "TeacherWorkRules" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'The ten tables of the teacher''s arms were not free at once in 30 s: nothing is changed. Run "prisma migrate resolve --rolled-back 20270216090000_en_undervisande_administrator_far_lararens_egna_armar" before the next "prisma migrate deploy", which refuses (P3009) until then';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- The two patchers
-- ---------------------------------------------------------------------------

-- p_edits is [old, new, count, old, new, count, ...]: each old text must occur
-- exactly count times in the function as it stands, or nothing is changed.
CREATE FUNCTION pg_temp.ta_patch_fn(p_fn regprocedure, p_edits text[]) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  def text := pg_get_functiondef(p_fn);
  i int;
  seen int;
  want int;
BEGIN
  FOR i IN 1..cardinality(p_edits) BY 3 LOOP
    want := p_edits[i + 2]::int;
    seen := (length(def) - length(replace(def, p_edits[i], ''))) / length(p_edits[i]);
    IF seen <> want THEN
      RAISE EXCEPTION '% is not as 20270216090000 expects: % occurrences of "%", expected %',
        p_fn, seen, left(p_edits[i], 70), want;
    END IF;
    def := replace(def, p_edits[i], p_edits[i + 1]);
  END LOOP;
  EXECUTE def;
END
$$;

-- One policy: its USING and WITH CHECK are read from the catalogue, p_find
-- must occur exactly once in each expression the policy has, and the policy is
-- altered to the text with p_replace in its place. The policy's command and
-- roles are asserted, so a policy that was renamed, retargeted or dropped by
-- somebody else stops the migration instead of being altered blind.
CREATE FUNCTION pg_temp.ta_patch_policy(p_table text, p_policy text, p_cmd "char", p_roles text, p_find text, p_replace text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  pol record;
  roles text;
  using_text text;
  check_text text;
  seen int;
  clauses text := '';
BEGIN
  SELECT p.polcmd, p.polroles, p.polpermissive,
         pg_get_expr(p.polqual, p.polrelid) AS q, pg_get_expr(p.polwithcheck, p.polrelid) AS c
    INTO pol
    FROM pg_policy p
    JOIN pg_class r ON r.oid = p.polrelid AND r.relnamespace = 'public'::regnamespace
   WHERE r.relname = p_table AND p.polname = p_policy;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'policy "%" on "%" is not where 20270216090000 expects it', p_policy, p_table;
  END IF;
  SELECT string_agg(CASE WHEN o = 0 THEN 'PUBLIC' ELSE (SELECT rolname::text FROM pg_roles WHERE oid = o) END, ',' ORDER BY o)
    INTO roles FROM unnest(pol.polroles) o;
  IF pol.polcmd <> p_cmd OR roles IS DISTINCT FROM p_roles OR NOT pol.polpermissive THEN
    RAISE EXCEPTION 'policy "%" on "%" is %/% (% permissive) and not the % arm for % that 20270216090000 expects',
      p_policy, p_table, pol.polcmd, roles, pol.polpermissive, p_cmd, p_roles;
  END IF;
  IF pol.q IS NOT NULL THEN
    seen := (length(pol.q) - length(replace(pol.q, p_find, ''))) / length(p_find);
    IF seen <> 1 THEN
      RAISE EXCEPTION 'policy "%" on "%": % occurrences of the teacher test in its USING, expected 1', p_policy, p_table, seen;
    END IF;
    clauses := clauses || format(' USING (%s)', replace(pol.q, p_find, p_replace));
  END IF;
  IF pol.c IS NOT NULL THEN
    seen := (length(pol.c) - length(replace(pol.c, p_find, ''))) / length(p_find);
    IF seen <> 1 THEN
      RAISE EXCEPTION 'policy "%" on "%": % occurrences of the teacher test in its WITH CHECK, expected 1', p_policy, p_table, seen;
    END IF;
    clauses := clauses || format(' WITH CHECK (%s)', replace(pol.c, p_find, p_replace));
  END IF;
  EXECUTE format('ALTER POLICY %I ON %I%s', p_policy, p_table, clauses);
END
$$;

-- ---------------------------------------------------------------------------
-- The 16 arms
-- ---------------------------------------------------------------------------

-- The teacher test as the catalogue prints it, and the same test with the mark
-- beside it. The OR is the arm's only one.
SELECT pg_temp.ta_patch_policy(v.tbl, v.pol, v.cmd, v.roles,
  $o$(( SELECT app.current_user_role() AS current_user_role) = 'TEACHER'::"UserRole")$o$,
  $n$((( SELECT app.current_user_role() AS current_user_role) = 'TEACHER'::"UserRole") OR ( SELECT app.current_user_teaches() AS current_user_teaches))$n$)
  FROM (VALUES
    ('AttendanceRecords',        'attendance_teacher_insert',                    'a'::"char", 'authenticated'),
    ('AttendanceRecords',        'attendance_teacher_update',                    'w'::"char", 'authenticated'),
    ('AvailabilityConstraints',  'availability_teacher_modify',                  '*'::"char", 'authenticated'),
    ('LessonSubstituteNotes',    'lesson_substitute_notes_teacher_delete',       'd'::"char", 'app_authenticated'),
    ('LessonSubstituteNotes',    'lesson_substitute_notes_teacher_insert',       'a'::"char", 'app_authenticated'),
    ('LessonSubstituteNotes',    'lesson_substitute_notes_teacher_select',       'r'::"char", 'app_authenticated'),
    ('LessonSubstituteNotes',    'lesson_substitute_notes_teacher_update',       'w'::"char", 'app_authenticated'),
    ('TeacherAbsenceCovers',     'teacher_absence_covers_own_select',            'r'::"char", 'authenticated'),
    ('TeacherAbsences',          'teacher_absences_own_insert',                  'a'::"char", 'authenticated'),
    ('TeacherAbsences',          'teacher_absences_own_select',                  'r'::"char", 'authenticated'),
    ('TeacherAbsences',          'teacher_absences_own_update',                  'w'::"char", 'authenticated'),
    ('TeacherDuties',            'teacher_duties_teacher_own_select',            'r'::"char", 'authenticated'),
    ('TeacherEmploymentLogs',    'teacher_employment_logs_teacher_own_select',   'r'::"char", 'authenticated'),
    ('TeacherEmploymentPeriods', 'teacher_employment_periods_teacher_own_select', 'r'::"char", 'authenticated'),
    ('TeacherEmployments',       'teacher_employments_teacher_own_select',       'r'::"char", 'authenticated'),
    ('TeacherWorkRules',         'teacher_work_rules_teacher_own',               '*'::"char", 'authenticated')
  ) AS v(tbl, pol, cmd, roles);

-- ---------------------------------------------------------------------------
-- app.lesson_teacher_role: a marked administrator on the lesson, with a post
-- for the lesson's läsår
-- ---------------------------------------------------------------------------

SELECT pg_temp.ta_patch_fn('app.lesson_teacher_role(uuid)'::regprocedure, ARRAY[
$o$     AND app.current_user_role() = 'TEACHER'
     AND me.id IS NOT NULL$o$,
$n$     AND (app.current_user_role() = 'TEACHER'
          -- A teaching administrator (20270216090000): the mark, and a post for the läsår of the
          -- lesson's group. A lesson has no year of its own; its student group belongs to one.
          -- The person's id is read once, as an initplan: me.id is pulled up into the filter as
          -- app.current_user_id() and then runs once for every post the school has (measured:
          -- 0.9 ms a call against 0.17 ms, and the unique key on (school, person, year) unused).
          OR (app.current_user_teaches()
              AND coalesce((SELECT true FROM "StudentGroups" g
                              JOIN "TeacherEmployments" e ON e."academicYearId" = g."academicYearId" AND e."schoolId" = g."schoolId"
                             WHERE g."id" = l."studentGroupId" AND g."schoolId" = l."schoolId"
                               AND e."userId" = (select app.current_user_id())
                             LIMIT 1), false)))
     AND me.id IS NOT NULL$n$,
'1',
$o$t."role" = 'SUBSTITUTE')
             THEN 'SUBSTITUTE'$o$,
$n$t."role" = 'SUBSTITUTE')
             -- Never a teaching administrator (beslut 4: no administrator is a substitute).
             AND app.current_user_role() = 'TEACHER'
             THEN 'SUBSTITUTE'$n$,
'1']);

COMMENT ON FUNCTION app.lesson_teacher_role(uuid) IS
  'Who teaches a lesson, for the caller (20261203090000, 20270216090000): REGULAR when the calling TEACHER is the lesson''s own teacher (a CalendarLessonTeachers row other than SUBSTITUTE, or the absent teacher of a cover decision on it; never the master lesson''s), SUBSTITUTE when only its substitute; the same REGULAR, never SUBSTITUTE, for a SCHOOL_ADMIN who teaches (Users.teaches) and has a post for the läsår of the lesson''s group; NULL otherwise and for every other role or school.';

-- ---------------------------------------------------------------------------
-- app.availability_constraints_keep_duty_blocks: a marked administrator who
-- does not write PLANERING is held to the teacher's guard
-- ---------------------------------------------------------------------------

SELECT pg_temp.ta_patch_fn('app.availability_constraints_keep_duty_blocks()'::regprocedure, ARRAY[
$o$  -- The slot is the duty's, and the duty is the admin's.
  IF (select app.current_user_role()) = 'TEACHER' THEN$o$,
$n$  -- The slot is the duty's, and the duty is the admin's. A teaching administrator (20270216090000) who
  -- does not write PLANERING reaches their own unavailability only through the teacher's arm, and is
  -- held to the teacher's guard; one who writes PLANERING owns the duty and passes as before.
  IF (select app.current_user_role()) = 'TEACHER'
     OR ((select app.current_user_teaches()) AND NOT (select app.current_user_may('PLANERING', true))) THEN$n$,
'1']);

-- ---------------------------------------------------------------------------
-- app.cover_policy_arm_is_narrow: the one OR of a converted arm is the
-- teacher's test it extends
-- ---------------------------------------------------------------------------

SELECT pg_temp.ta_patch_fn('app.cover_policy_arm_is_narrow(text, text, text)'::regprocedure, ARRAY[
$o$p_arm LIKE$o$, $n$a.arm LIKE$n$, '6',
$o$p_arm NOT LIKE$o$, $n$a.arm NOT LIKE$n$, '2',
$o$
     )
$function$$o$,
$n$
     )
  -- A converted arm (20270216090000) carries the mark beside the teacher's test, in the one OR that
  -- the arm has. It is judged as the teacher's arm it extends; every other OR is refused as before.
  FROM (SELECT replace(p_arm,
          '((( SELECT app.current_user_role() AS current_user_role) = ''TEACHER''::"UserRole") OR ( SELECT app.current_user_teaches() AS current_user_teaches))',
          '(( SELECT app.current_user_role() AS current_user_role) = ''TEACHER''::"UserRole")') AS arm) a
$function$$n$,
'1']);

COMMENT ON FUNCTION app.cover_policy_arm_is_narrow(text, text, text) IS
  'Whether a policy arm on the absence and pool tables reaches only the admin, the teacher''s own rows or the two catalogues (20261012130000); the teacher''s test may carry the one OR of the mark beside it (Users.teaches, 20270216090000), and nothing else may carry an OR.';

DROP FUNCTION pg_temp.ta_patch_policy(text, text, "char", text, text, text);
DROP FUNCTION pg_temp.ta_patch_fn(regprocedure, text[]);

-- ---------------------------------------------------------------------------
-- The leak guard of 20261012130000, over the arms as they stand now: the
-- migration refuses to commit if the rule does not accept every arm on the
-- absence, cover and pool tables. (RLS sections 28g and 112 hold it too.)
-- ---------------------------------------------------------------------------

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(tablename || '.' || policyname, ', ' ORDER BY tablename, policyname) INTO bad
    FROM (
      SELECT p.tablename, p.policyname,
             (p.roles IN ('{authenticated}'::name[], '{app_authenticated}'::name[]) AND p.permissive = 'PERMISSIVE') AS shaped,
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
      OR EXISTS (SELECT 1 FROM unnest(x.arms) e WHERE NOT app.cover_policy_arm_is_narrow(x.tablename, x.policyname, e));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'ABSENCE_LEAK: these arms reach an absence, a decision or the pool for somebody other than the admin or the person themself: %', bad;
  END IF;
END
$$;
