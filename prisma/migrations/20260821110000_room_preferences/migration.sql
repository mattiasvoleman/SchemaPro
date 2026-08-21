-- Soft room wishes.
--
-- Subjects already carry a HARD room-type requirement. This is the other half
-- a school actually needs: "NO helst i labbet eller A14" — a preference the
-- optimizer pays to break, not a rule that makes a week unschedulable when the
-- lab is busy. Two mechanisms because the two answers differ: a hard rule that
-- cannot be met is an error to fix, a soft one that cannot be met is a
-- timetable with one lesson in the wrong room.
--
-- A preference points at either a room type or a set of named rooms, never
-- both and never neither — a preference pointing at nothing could be neither
-- satisfied nor violated.

CREATE TABLE "RoomPreferences" (
    "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"   UUID NOT NULL,
    "subjectId"  UUID NOT NULL,
    "roomTypeId" UUID,
    "weight"     INTEGER NOT NULL DEFAULT 50,
    "createdAt"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"  TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "RoomPreferences_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RoomPreferences_weight_sane" CHECK ("weight" BETWEEN 1 AND 1000)
);

CREATE TABLE "RoomPreferenceRooms" (
    "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"     UUID NOT NULL,
    "preferenceId" UUID NOT NULL,
    "roomId"       UUID NOT NULL,
    CONSTRAINT "RoomPreferenceRooms_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RoomPreferences_schoolId_idx" ON "RoomPreferences"("schoolId");
CREATE INDEX "RoomPreferenceRooms_schoolId_idx" ON "RoomPreferenceRooms"("schoolId");
CREATE UNIQUE INDEX "RoomPreferenceRooms_preferenceId_roomId_key"
    ON "RoomPreferenceRooms"("preferenceId", "roomId");

ALTER TABLE "RoomPreferences"
    ADD CONSTRAINT "RoomPreferences_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "RoomPreferences_subjectId_fkey"
    FOREIGN KEY ("subjectId") REFERENCES "Subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "RoomPreferences_roomTypeId_fkey"
    FOREIGN KEY ("roomTypeId") REFERENCES "RoomTypes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RoomPreferenceRooms"
    ADD CONSTRAINT "RoomPreferenceRooms_preferenceId_fkey"
    FOREIGN KEY ("preferenceId") REFERENCES "RoomPreferences"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "RoomPreferenceRooms_roomId_fkey"
    FOREIGN KEY ("roomId") REFERENCES "Rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security, same shape as every other school-owned table: admins
-- manage their school's rules, staff may read them.
ALTER TABLE "RoomPreferences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RoomPreferenceRooms" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "room_preferences_admin_all" ON "RoomPreferences"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

CREATE POLICY "room_preferences_staff_select" ON "RoomPreferences"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()));

CREATE POLICY "room_preference_rooms_admin_all" ON "RoomPreferenceRooms"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

CREATE POLICY "room_preference_rooms_staff_select" ON "RoomPreferenceRooms"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()));

GRANT SELECT, INSERT, UPDATE, DELETE ON "RoomPreferences" TO "app_authenticated";
GRANT SELECT, INSERT, UPDATE, DELETE ON "RoomPreferenceRooms" TO "app_authenticated";
