-- A room rule is read by the school's staff, not by everyone in the school.
--
-- ## Why
--
-- RoomPreferences and RoomPreferenceRooms each got a SELECT policy named
-- `_staff_select` in 20260821110000 that carried the tenant predicate and
-- nothing else. The init migration grants SELECT on every table to
-- "authenticated", and web and mobile talk to Supabase with the user's own
-- token, so every pupil and every guardian of a school could read its room
-- rules straight through PostgREST. Guardians have no policy of their own on
-- either table; this one was their way in.
--
-- The name said staff and the predicate said everyone. Every other
-- `_staff_select` policy in the schema — twenty of them, read off pg_policies
-- — spells the role out as `IN ('TEACHER', 'SCHOOL_ADMIN')`, and these two were
-- written to be the same.
--
-- What leaked is not a timetable a pupil already sees but the planning behind
-- it: which subject a school wants in which rooms, for which years, and since
-- 20260901150000 which of those are locks. That is staff business the way
-- TeachingRequirements is, not a school-wide read like Rooms.
--
-- ## Who keeps read access
--
-- TEACHER and SCHOOL_ADMIN, which is everyone who reads these tables for a
-- reason. Every reader in the gateway sits behind @Roles(SCHOOL_ADMIN) and
-- reads under withRls as that caller: the rule endpoints
-- (RoomPreferencesController), the lock check before a room is deleted
-- (RoomsService.remove), generation (OptimizationProxyService, including a
-- queued job, which re-enters as the admin who started it) and the room
-- optimisation (RoomOptimizationService). The web reaches the rules only
-- through /api/v1/room-preferences on admin pages; mobile and the engine never
-- read them, and UserRole has no fifth value to account for.
--
-- TEACHER stays although nothing a teacher runs reads the rules today:
-- scripts/test/rls-policies.sql section 7d asserts a teacher can, because a
-- lock is the reason a lesson cannot be moved, and a teacher who cannot see it
-- meets a refusal with no visible cause.
--
-- Narrowing only. The `_admin_all` policies already required SCHOOL_ADMIN, so
-- nothing about who may write changes.

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
