-- Elevens arm på lärarraderna frågar bara en elev.
--
-- calendar_lesson_teachers_student_select (20260822120000) lets a pupil read
-- the teacher rows of their own class's lessons: an EXISTS on CalendarLessons
-- for the row's lesson with the pupil's group. PostgreSQL ORs a table's
-- permissive policies per row, and in the plans measured here the pupil arm is
-- evaluated FIRST — so every staff read of CalendarLessonTeachers runs that
-- EXISTS, a CalendarLessons index probe under CalendarLessons' own seven
-- arms, for every teacher row it touches, before the staff arm says yes. For
-- a staff reader the answer is always no: app.current_user_group_id() is
-- NULL for everyone but a pupil (only a pupil has a class, section 13).
--
-- The timplan's genomförd tid (src/timplan/timplan-delivered.sql.ts) asks
-- "has this lesson a teacher row?" of every calendar lesson of a läsår. On a
-- seeded school of 2 000 pupils and 114 200 calendar lessons
-- (scripts/bench/timplan-delivered.ts, EXPLAIN ANALYZE as app_authenticated)
-- that statement took 985 ms as a SCHOOL_ADMIN and the layer's three
-- statements 1 104 ms, over their 1 s budget; with the guard below, 755 and
-- 866 ms (a TEACHER alike), and the whole endpoint 2 196 → 1 917 ms. The
-- vikarie pages and the day planner read the same rows the same way.
--
-- The arm is recreated with the pupil's group asked first, as an InitPlan the
-- statement evaluates once: NULL — a teacher, an admin, a guardian — and the
-- AND stops before the EXISTS. Same rows for every principal: for a pupil the
-- added test is true, for anyone else the EXISTS could never have matched a
-- NULL group. Nothing else of the table changes, and section 22 of the RLS
-- suite holds it to that: a pupil reads the teacher row of their own class's
-- lesson and not another class's, a teacher reads both.

DROP POLICY IF EXISTS "calendar_lesson_teachers_student_select" ON "CalendarLessonTeachers";
CREATE POLICY "calendar_lesson_teachers_student_select" ON "CalendarLessonTeachers"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_group_id()) IS NOT NULL
        AND EXISTS (
            SELECT 1 FROM "CalendarLessons" cl
             WHERE cl.id = "CalendarLessonTeachers"."calendarLessonId"
               AND cl."studentGroupId" = (select app.current_user_group_id())
        )
    );
