-- The soft room rules were readable by everyone in the school, not by staff.
--
-- Both SELECT policies were named `_staff_select` but carried only the tenant
-- predicate — no role check — so every authenticated principal of the school
-- passed them, students and guardians included. The name said staff; the
-- predicate said everyone. Sixteen of the eighteen `_staff_select` policies in
-- this schema spell the check out (see `users_staff_select` and
-- `teaching_requirements_staff_select`), and these two were meant to be the
-- seventeenth and eighteenth.
--
-- What leaked is not a timetable a student may already see, but the planning
-- layer behind it: which subjects a school wants in which rooms and how hard
-- it is willing to fight for them. That belongs with TeachingRequirements —
-- staff-only — not with Rooms, which every member reads to render a schedule.
--
-- Read access does not narrow for anyone who was supposed to have it: the
-- admin screens run as SCHOOL_ADMIN, and the optimizer reads the rules under
-- the RLS session of the user who started the generation, who is staff.

DROP POLICY IF EXISTS "room_preferences_staff_select" ON "RoomPreferences";
CREATE POLICY "room_preferences_staff_select" ON "RoomPreferences"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) IN ('TEACHER', 'SCHOOL_ADMIN')
    );

DROP POLICY IF EXISTS "room_preference_rooms_staff_select" ON "RoomPreferenceRooms";
CREATE POLICY "room_preference_rooms_staff_select" ON "RoomPreferenceRooms"
    FOR SELECT TO "authenticated"
    USING (
        "schoolId" = (select app.current_school_id())
        AND (select app.current_user_role()) IN ('TEACHER', 'SCHOOL_ADMIN')
    );
