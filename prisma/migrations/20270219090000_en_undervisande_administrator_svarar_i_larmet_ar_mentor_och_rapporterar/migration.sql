-- En administratör som undervisar, del 4: krisläge, mentor och rapporteringsgrad.
--
-- ## Why
--
-- 20270212090000 added Users."teaches" and app.current_user_teaches(); 20270216090000 gave a marked
-- administrator the teacher's own arms (the person's absence, post, duty, unavailability and the
-- note to the substitute). Three things the investigation put "in" are still the teacher's alone
-- in the database, and this migration is what makes them the marked administrator's too (beslut 4):
--
--   * Krisläge. A teacher marks their own group in an alarm through three insert arms on
--     "CrisisReports". The administrator's insert arm for the same table asks
--     app.crisis_may_start(), that is, that the profile is on the school's start list
--     (CrisisSettings.startProfiles), which rektor can narrow. A marked schemaläggare or expedition
--     in a school that narrowed the list could therefore not mark their OWN group. The three
--     teacher arms get the mark, in OR, and nothing else of them changes: still only the groups the
--     person answers for (app.crisis_answers_for), still only inside the alarm's window.
--   * Mentor. "The mentor of a pupil" is asked by app.leave_mentors (who is told of a leave request,
--     who is a deciding mentor), by app.absence_watch_mentees (the mentor's pupils in
--     Frånvarobevakningen and in the digest), and by five definer functions that ask the same of the
--     signed-in person. A marked administrator with a MENTORSKAP duty is a mentor everywhere.
--   * Rapporteringsgrad. app.reporting_lessons (the lessons a teacher is to report, the reminder, the
--     weekly sums) and app.absence_stats_lessons (the same, for the history) count a person's lessons
--     if the person is a TEACHER. A marked administrator who stands on a lesson is counted too.
--
-- The right is still the administrator's (beslut 7: the view narrows, the right does not): no
-- administrator arm is touched, and nobody who is not marked gets anything.
--
-- ## One new function: app.teaches_like(role, teaches)
--
-- "Teaches like a teacher", asked of a ROW: a TEACHER, or a SCHOOL_ADMIN whose mark is set. Five
-- functions ask it of another person than the caller (a mentor of a pupil, the owner of a lesson), so
-- they cannot ask app.current_user_teaches(), which is the caller's. It is the SQL twin of the gateway's
-- teachesLike. One definition, a LANGUAGE sql IMMUTABLE function the planner inlines (no call is left in
-- the plan: measured), with no grant at all: every function that asks it runs as the owner.
--
-- ## What is converted
--
-- Three arms (TO "app_authenticated", on "CrisisReports"), as PR 3 did it: the mark in OR with the
-- teacher test, at one place, in the arm's own style (an initplan):
--
--   crisis_reports_teacher_insert        (a mark on a group the person answers for)
--   crisis_reports_teacher_found_insert  ("found with me" for a group the person answers for)
--   crisis_reports_teacher_free_insert   ("found" by a person with no group in the alarm, inside the window)
--
-- Ten functions (the numbers are the investigation's):
--
--   1 app.reporting_lessons         the teacher line becomes app.teaches_like (replaced with its whole body)
--   2 app.absence_stats_lessons     the same line (replaced with its whole body, so are the two one definition)
--   3 app.leave_mentors             the mentor of a pupil
--   4 app.absence_watch_mentees     the mentor's pupils
--   5 app.absence_watch_digest_plan the MENTOR group's recipients (the other three groups as before)
--   6 app.leave_mine_to_decide      "a leave request is mine to decide" (and so "refer")
--   7 app.leave_request_taken       a request somebody else decides
--   8 app.absence_watch_is_mentor_of
--   9 app.ack_mentee_ids
--  10 app.lesson_move_is_mentor
--
-- 1 and 2 are replaced with a whole body behind an md5 guard, as 20270210090000 replaced
-- absence_stats_lessons: two tests hold their text (absence-stats-definition.spec.ts reads the files,
-- section 392o reads the catalogue) and a catalogue-patched body is invisible to the first. They are
-- the same text, byte for byte, but for the one line (D2: u."isActive"; the history: the periods
-- of UserDeactivations). 3 to 10 are read from the catalogue when this runs and changed at named
-- places, each with the number of occurrences it expects: parallel branches rewrite cover, leave and
-- reporting functions, and a body copied from an old file drops their change without a git conflict.
-- A text that is not as expected stops the migration with nothing changed. A replacement that already
-- stands in the text stops it too (a second run would otherwise wrap an arm or a function twice).
--
-- 3 to 6 change an answer for a marked administrator today. 7 to 10 do not (their consumers are arms that
-- still ask role = 'TEACHER' first, or gateway branches an administrator does not take): they follow,
-- so that "mentor" means one thing everywhere in the database and a later "my mentees" read does not
-- meet a function that still says otherwise.
--
-- ## What is NOT converted, and why (RLS section 494 holds the list)
--
-- 25 arms and one function name TEACHER and stay: the administrator's arm for the same table and verb
-- already admits every row theirs admits (every markable profile writes DRIFT), so a conversion would
-- change no answer. The seven read arms of Krisläge are the case that matters: an administrator reads
-- every alarm, every group and every pupil's list of the school, for good. That is why the gateway,
-- and not the database, narrows what a marked administrator is shown of the alarm on their phone
-- (CrisisService.mine asks app.crisis_window_open and app.crisis_answers_for): the view narrows, the
-- right does not. The rest of the list: the mentor's arms on LeaveRequests, AbsenceReports,
-- AbsenceWatchFindings, AckReceipts, AckRequests, LessonPupilMoves, consent (ConsentAsks, ConsentEntries,
-- ConsentLists) and the checklist proofs; the two reporting-rate reads; app.checklist_taught_ids.
--
-- Not touched at all: app.crisis_may_start() and every administrator arm of Krisläge (starting, ending
-- and marking for other people's groups stay the administrator's, by the school's start list),
-- app.cover_policy_arm_is_narrow and every cover and pool arm (SP409), the class teacher (CT400),
-- app.class_teacher_actor and app.cover_request_sender (their TEACHER test is the class teacher's and the
-- cover request's colleague side).
--
-- ## Retroactive, by design
--
-- A person who is marked today has their lessons of the last 90 days counted as held by
-- app.reporting_compute the first night (it recomputes 90 days and rewrites rows whose figures changed),
-- those without a saved register as not reported, and app.reporting_remind looks back 30 days. The
-- history (absence_stats_*) stores months it does not recompute, so only an open month is affected.
-- Nobody is marked at the time of this migration (production: one administrator, none marked), so
-- nothing changes for anybody when it is run; RLS section 513 shows what happens when somebody is.
--
-- ## Beside the live API: one table, every lock at once, or none
--
-- ALTER POLICY takes ACCESS EXCLUSIVE on its table (measured on PG17 in the PR 3 work); CREATE OR REPLACE
-- FUNCTION takes no table lock. So one table is locked: "CrisisReports", which the live view of the
-- management reads and the phones write to DURING an alarm. It is taken NOWAIT in a loop (a waiting
-- ACCESS EXCLUSIVE queues every reader behind it): a refusal rolls the subtransaction back and tries again
-- 50 ms later, the migration never waits while it holds anything, and after 30 s of refusals it stops with
-- nothing changed. Prisma then marks the migration failed (P3009 on every later deploy) until
-- `prisma migrate resolve --rolled-back <name>` has been run, and the message says so. lock_timeout
-- bounds any wait nobody foresaw. Do not run this migration while an alarm is open (docs/DEPLOYMENT.md 20.6).

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "CrisisReports" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'CrisisReports was not free in 30 s: nothing is changed. Run "prisma migrate resolve --rolled-back 20270219090000_en_undervisande_administrator_svarar_i_larmet_ar_mentor_och_rapporterar" before the next "prisma migrate deploy", which refuses (P3009) until then';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- The two lesson functions are as 20270122091000 / 20270210090000 left them, or nothing changes.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  d2 text;
  history text;
BEGIN
  PERFORM set_config('search_path', 'public, pg_temp', true);
  SELECT md5(p.prosrc) INTO d2 FROM pg_proc p WHERE p.oid = to_regprocedure('app.reporting_lessons(uuid, date, date, timestamptz)');
  IF d2 IS DISTINCT FROM 'a263885deea0dd2f172362d0ed374167' THEN
    RAISE EXCEPTION 'app.reporting_lessons is not as 20270122091000 wrote it (md5 of its body %, expected a263885deea0dd2f172362d0ed374167), so it is not replaced',
      coalesce(d2, '(no such function)');
  END IF;
  SELECT md5(p.prosrc) INTO history FROM pg_proc p WHERE p.oid = to_regprocedure('app.absence_stats_lessons(uuid, date, date, timestamptz)');
  IF history IS DISTINCT FROM '2b07676420b7d8bc1ddd9cfafa5046a6' THEN
    RAISE EXCEPTION 'app.absence_stats_lessons is not as 20270210090000 wrote it (md5 of its body %, expected 2b07676420b7d8bc1ddd9cfafa5046a6), so it is not replaced',
      coalesce(history, '(no such function)');
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- app.teaches_like: the one new function
-- ---------------------------------------------------------------------------

-- Does a person with this role and this mark teach like a teacher? A TEACHER does, a SCHOOL_ADMIN who teaches does, nobody else
-- (a LASARE cannot be marked: a CHECK on Users says so). It is asked of a row, not of the caller (that is app.current_user_teaches());
-- IMMUTABLE and a plain SELECT so that the planner inlines it into the functions that ask it and no call is left in a plan.
-- A NULL role or mark is no (coalesce). No grant: every function that asks it runs as the owner.
CREATE FUNCTION app.teaches_like(p_role "UserRole", p_teaches boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(p_role = 'TEACHER' OR (p_role = 'SCHOOL_ADMIN' AND p_teaches), false)
$$;

COMMENT ON FUNCTION app.teaches_like("UserRole", boolean) IS
  'Does a person with this role and this mark teach like a teacher: a TEACHER, or a SCHOOL_ADMIN whose Users.teaches is set (20270219090000). Asked of a row; app.current_user_teaches() is the caller''s. The SQL twin of the gateway''s teachesLike.';

DO $$
DECLARE
  r text;
BEGIN
  REVOKE ALL ON FUNCTION app.teaches_like("UserRole", boolean) FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'app_authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION app.teaches_like("UserRole", boolean) FROM %I', r);
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- The two patchers (read the text from the catalogue, change it at named places)
-- ---------------------------------------------------------------------------

-- p_edits is [old, new, count, old, new, count, ...]: each old text must occur exactly count times in the function as it stands,
-- and no new text may already occur in it (a function that is run twice, or that somebody else already converted, is not wrapped
-- twice), or nothing is changed.
CREATE FUNCTION pg_temp.tk_patch_fn(p_fn regprocedure, p_edits text[]) RETURNS void
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
      RAISE EXCEPTION '% is not as 20270219090000 expects: % occurrences of "%", expected %',
        p_fn, seen, left(p_edits[i], 70), want;
    END IF;
    IF position(p_edits[i + 1] in def) > 0 THEN
      RAISE EXCEPTION '% already says "%": 20270219090000 does not convert it twice', p_fn, left(p_edits[i + 1], 70);
    END IF;
    def := replace(def, p_edits[i], p_edits[i + 1]);
  END LOOP;
  EXECUTE def;
END
$$;

-- One policy: its USING and WITH CHECK are read from the catalogue, p_find must occur exactly once in each expression the policy has,
-- p_replace must not already stand in it, and the policy is altered to the text with p_replace in its place. The policy's command and
-- roles are asserted, so a policy that was renamed, retargeted or dropped by somebody else stops the migration instead of being
-- altered blind.
CREATE FUNCTION pg_temp.tk_patch_policy(p_table text, p_policy text, p_cmd "char", p_roles text, p_find text, p_replace text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  pol record;
  roles text;
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
    RAISE EXCEPTION 'policy "%" on "%" is not where 20270219090000 expects it', p_policy, p_table;
  END IF;
  SELECT string_agg(CASE WHEN o = 0 THEN 'PUBLIC' ELSE (SELECT rolname::text FROM pg_roles WHERE oid = o) END, ',' ORDER BY o)
    INTO roles FROM unnest(pol.polroles) o;
  IF pol.polcmd <> p_cmd OR roles IS DISTINCT FROM p_roles OR NOT pol.polpermissive THEN
    RAISE EXCEPTION 'policy "%" on "%" is %/% (% permissive) and not the % arm for % that 20270219090000 expects',
      p_policy, p_table, pol.polcmd, roles, pol.polpermissive, p_cmd, p_roles;
  END IF;
  IF pol.q IS NOT NULL THEN
    IF position(p_replace in pol.q) > 0 THEN
      RAISE EXCEPTION 'policy "%" on "%" already carries the mark in its USING: 20270219090000 does not convert it twice', p_policy, p_table;
    END IF;
    seen := (length(pol.q) - length(replace(pol.q, p_find, ''))) / length(p_find);
    IF seen <> 1 THEN
      RAISE EXCEPTION 'policy "%" on "%": % occurrences of the teacher test in its USING, expected 1', p_policy, p_table, seen;
    END IF;
    clauses := clauses || format(' USING (%s)', replace(pol.q, p_find, p_replace));
  END IF;
  IF pol.c IS NOT NULL THEN
    IF position(p_replace in pol.c) > 0 THEN
      RAISE EXCEPTION 'policy "%" on "%" already carries the mark in its WITH CHECK: 20270219090000 does not convert it twice', p_policy, p_table;
    END IF;
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
-- The three arms of Krisläge
-- ---------------------------------------------------------------------------

-- The teacher test as the catalogue prints it, and the same test with the mark beside it. The OR is the arm's only one.
SELECT pg_temp.tk_patch_policy(v.tbl, v.pol, v.cmd, v.roles,
  $o$(( SELECT app.current_user_role() AS current_user_role) = 'TEACHER'::"UserRole")$o$,
  $n$((( SELECT app.current_user_role() AS current_user_role) = 'TEACHER'::"UserRole") OR ( SELECT app.current_user_teaches() AS current_user_teaches))$n$)
  FROM (VALUES
    ('CrisisReports', 'crisis_reports_teacher_found_insert', 'a'::"char", 'app_authenticated'),
    ('CrisisReports', 'crisis_reports_teacher_free_insert',  'a'::"char", 'app_authenticated'),
    ('CrisisReports', 'crisis_reports_teacher_insert',       'a'::"char", 'app_authenticated')
  ) AS v(tbl, pol, cmd, roles);

-- ---------------------------------------------------------------------------
-- 1 and 2: the lessons of the reporting rate and of its history. Whole bodies, byte for byte the live ones but for the
-- line about the teacher (the guard above holds that they were).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.reporting_lessons(p_school uuid, p_from date, p_to date, p_now timestamptz)
RETURNS TABLE (lesson_id uuid, teacher_id uuid, day date,
               starts_at timestamptz, ends_at timestamptz, reported boolean)
LANGUAGE sql STABLE AS $$
  SELECT cl."id", t."teacherId", cl."date", cl."startsAt", cl."endsAt", r."saved"
    FROM "public"."CalendarLessons" cl
    JOIN "public"."CalendarLessonTeachers" t
      ON t."calendarLessonId" = cl."id" AND t."schoolId" = cl."schoolId"
    JOIN "public"."Users" u
      ON u."id" = t."teacherId" AND u."schoolId" = cl."schoolId"
     AND app.teaches_like(u."role", u."teaches") AND u."isActive"
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
     AND app.teaches_like(u."role", u."teaches") AND NOT EXISTS (SELECT 1 FROM "public"."UserDeactivations" d WHERE d."userId" = u."id" AND d."startsAt" < cl."endsAt" AND (d."endsAt" IS NULL OR cl."endsAt" < d."endsAt"))
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

-- ---------------------------------------------------------------------------
-- 3 to 10: the mentor, read from the catalogue and changed at named places
-- ---------------------------------------------------------------------------

-- 3 and 4: the mentor of a pupil, and the mentor's pupils. A person who teaches like a teacher, and is active.
SELECT pg_temp.tk_patch_fn(v.fn::regprocedure, ARRAY[
  $o$u."isActive" AND u."role" = 'TEACHER'$o$,
  $n$u."isActive" AND app.teaches_like(u."role", u."teaches")$n$,
  '1'])
  FROM (VALUES ('app.leave_mentors(uuid, uuid, date, date)'), ('app.absence_watch_mentees(uuid, date)')) AS v(fn);

-- 5: the digest. The MENTOR group's recipients are the ones who teach like a teacher; the other three groups are as before.
SELECT pg_temp.tk_patch_fn('app.absence_watch_digest_plan(uuid, "AbsenceWatchGroup", date, date, date)'::regprocedure, ARRAY[
$o$AND u."role" = CASE p_group WHEN 'MENTOR' THEN 'TEACHER' WHEN 'GUARDIAN' THEN 'GUARDIAN' ELSE 'SCHOOL_ADMIN' END::"UserRole"$o$,
$n$AND CASE p_group
                       WHEN 'MENTOR' THEN app.teaches_like(u."role", u."teaches")
                       ELSE u."role" = CASE p_group WHEN 'GUARDIAN' THEN 'GUARDIAN' ELSE 'SCHOOL_ADMIN' END::"UserRole"
                  END$n$,
'1']);

-- 6: "a leave request is mine to decide" (and so "refer"): the caller teaches like a teacher.
SELECT pg_temp.tk_patch_fn('app.leave_mine_to_decide(uuid, uuid, date, date)'::regprocedure, ARRAY[
$o$IF app.current_user_role() IS DISTINCT FROM 'TEACHER' OR p_school IS DISTINCT FROM app.current_school_id() THEN$o$,
$n$IF (app.current_user_role() IS DISTINCT FROM 'TEACHER' AND NOT app.current_user_teaches())
     OR p_school IS DISTINCT FROM app.current_school_id() THEN$n$,
'1']);

-- 7 to 10: the same question of the caller.
SELECT pg_temp.tk_patch_fn('app.leave_request_taken(uuid)'::regprocedure, ARRAY[
$o$SELECT app.current_user_role() = 'TEACHER'
       AND app.current_user_id() IN$o$,
$n$SELECT (app.current_user_role() = 'TEACHER' OR app.current_user_teaches())
       AND app.current_user_id() IN$n$,
'1']);

SELECT pg_temp.tk_patch_fn('app.absence_watch_is_mentor_of(uuid)'::regprocedure, ARRAY[
$o$SELECT app.current_user_role() = 'TEACHER'
     AND EXISTS ($o$,
$n$SELECT (app.current_user_role() = 'TEACHER' OR app.current_user_teaches())
     AND EXISTS ($n$,
'1']);

SELECT pg_temp.tk_patch_fn('app.ack_mentee_ids()'::regprocedure, ARRAY[
$o$WHERE app.current_user_role() = 'TEACHER' AND m.mentor_id$o$,
$n$WHERE (app.current_user_role() = 'TEACHER' OR app.current_user_teaches()) AND m.mentor_id$n$,
'1']);

SELECT pg_temp.tk_patch_fn('app.lesson_move_is_mentor(uuid, date)'::regprocedure, ARRAY[
$o$SELECT app.current_user_role()::text = 'TEACHER'
     AND EXISTS ($o$,
$n$SELECT (app.current_user_role()::text = 'TEACHER' OR app.current_user_teaches())
     AND EXISTS ($n$,
'1']);

DROP FUNCTION pg_temp.tk_patch_policy(text, text, "char", text, text, text);
DROP FUNCTION pg_temp.tk_patch_fn(regprocedure, text[]);

-- ---------------------------------------------------------------------------
-- The leak guard, over the arms and functions as they stand now: the migration refuses to commit if the three arms lost
-- the rule that makes them the teacher's own (the group the person answers for, inside the window), if any other arm of
-- CrisisReports asks for the mark, or if a function does not ask the way it was changed to.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  bad text;
  three constant text[] := ARRAY['crisis_reports_teacher_found_insert', 'crisis_reports_teacher_free_insert', 'crisis_reports_teacher_insert'];
BEGIN
  -- Exactly the three asks for the mark, and each once.
  SELECT string_agg(p.polname, ', ' ORDER BY p.polname) INTO bad
    FROM pg_policy p
   WHERE p.polrelid = '"CrisisReports"'::regclass
     AND (p.polname = ANY (three)) IS DISTINCT FROM
         ((coalesce(pg_get_expr(p.polqual, p.polrelid), '') || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) LIKE '%current_user_teaches%');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'CRISIS_LEAK: the mark stands on the three insert arms of the teacher and on no other arm of CrisisReports: wrong at %', bad;
  END IF;
  SELECT string_agg(p.polname, ', ' ORDER BY p.polname) INTO bad
    FROM pg_policy p
   WHERE p.polrelid = '"CrisisReports"'::regclass AND p.polname = ANY (three)
     AND (length(pg_get_expr(p.polwithcheck, p.polrelid)) - length(replace(pg_get_expr(p.polwithcheck, p.polrelid), 'app.current_user_teaches()', ''))) / length('app.current_user_teaches()') <> 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'CRISIS_LEAK: these arms do not carry the mark exactly once: %', bad;
  END IF;
  -- Still the person's own group, inside the window (the rule that makes the arm the teacher's).
  SELECT string_agg(a.polname, ', ' ORDER BY a.polname) INTO bad
    FROM (SELECT p.polname, pg_get_expr(p.polwithcheck, p.polrelid) AS c FROM pg_policy p
           WHERE p.polrelid = '"CrisisReports"'::regclass AND p.polname = ANY (three)) a
   WHERE NOT (CASE a.polname
          WHEN 'crisis_reports_teacher_insert' THEN strpos(a.c, 'app.crisis_answers_for("callId")') > 0 AND strpos(a.c, 'app.crisis_call_window_open("callId")') > 0
          WHEN 'crisis_reports_teacher_found_insert' THEN strpos(a.c, 'app.crisis_answers_for("foundInCallId")') > 0 AND strpos(a.c, 'app.crisis_call_window_open("foundInCallId")') > 0
          ELSE strpos(a.c, 'app.crisis_has_no_call_in("alarmId")') > 0 AND strpos(a.c, 'app.crisis_window_open("alarmId")') > 0
        END);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'CRISIS_LEAK: these arms no longer ask for the group the person answers for and the window: %', bad;
  END IF;

  -- Every function that was to ask does, once: app.teaches_like for the five that ask it of a row, the mark for the five that ask it of the caller.
  SELECT string_agg(f.name, ', ' ORDER BY f.name) INTO bad
    FROM (VALUES
      ('app.reporting_lessons(uuid, date, date, timestamptz)', 'teaches_like'),
      ('app.absence_stats_lessons(uuid, date, date, timestamptz)', 'teaches_like'),
      ('app.leave_mentors(uuid, uuid, date, date)', 'teaches_like'),
      ('app.absence_watch_mentees(uuid, date)', 'teaches_like'),
      ('app.absence_watch_digest_plan(uuid, "AbsenceWatchGroup", date, date, date)', 'teaches_like'),
      ('app.leave_mine_to_decide(uuid, uuid, date, date)', 'current_user_teaches'),
      ('app.leave_request_taken(uuid)', 'current_user_teaches'),
      ('app.absence_watch_is_mentor_of(uuid)', 'current_user_teaches'),
      ('app.ack_mentee_ids()', 'current_user_teaches'),
      ('app.lesson_move_is_mentor(uuid, date)', 'current_user_teaches')) AS f(name, asks)
    JOIN LATERAL (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure(f.name)) s ON true
   WHERE (length(s.prosrc) - length(replace(s.prosrc, f.asks, ''))) / length(f.asks) <> 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'TEACHES_GUARD: these functions do not ask for the mark exactly once: %', bad;
  END IF;
END
$$;
