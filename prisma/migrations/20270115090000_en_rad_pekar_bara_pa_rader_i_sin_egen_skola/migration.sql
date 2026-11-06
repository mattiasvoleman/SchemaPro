-- En rad pekar bara på rader i sin egen skola.
--
-- Thirty-eight foreign keys between two tables that both carry "schoolId" were
-- plain keys on "id": the database held that the row named exists, not that it
-- is the same school's. Row-level security keeps a principal from SEEING
-- another school's rows, but the WITH CHECK of an INSERT or UPDATE names the
-- row's own school, never the school of the row it points at, so an
-- administrator of one school could save a row of that school which named a
-- row of another (it took the other row's id). The row then answers to both
-- schools: removing the named row cascades into it, or is refused because of
-- it. Every other tenant key in the schema is already ("id", "schoolId") to
-- ("id", "schoolId"); these were the ones left.
--
-- The thirty-eight keys are the plain keys from a table that carries "schoolId"
-- to another table that carries it, found in the catalogue of a database at
-- origin/main (a85d026a), minus the five that something else already holds:
--
--   * Users."studentGroupId" -> StudentGroups. A pupil's class is refused when
--     it is not the pupil's school's by app.student_enrollments_follow_the_class
--     (Users_enrollment_on_insert / _on_update), in the key's own words so a
--     class of another school reads as an id that exists nowhere. The trigger
--     is the protection and the key stays as it is.
--   * CrisisPupils (callId, alarmId) and CrisisReports (callId, alarmId),
--     (callId, studentId) and (foundInCallId, alarmId). Each is held to one
--     school by the composite key beside it on the same call: the call is in
--     the row's school (callId, schoolId), the call's alarm is in the call's
--     school (CrisisCalls (alarmId, schoolId)), and a pupil row names the call
--     it is a pupil of.
--
-- ## "The same school" for a person
--
-- A person who has a login at two schools has one Users row at each
-- (Users_authId_schoolId_key, 20261204090000): the row carries the role, the
-- class and the profile at that school, and it is the row that every key in
-- these tables names. "The same school" for a key to Users is therefore the
-- Users row's own "schoolId", and ("userId", "schoolId") ->
-- Users ("id", "schoolId") (Users_id_schoolId_key) is the right key: a person
-- is never named across schools by these columns. A teacher who works at two
-- schools has a row, and a lesson, at each.
--
-- ## What this file does
--
--   1. Names every row that already points across schools, and stops (nothing
--      is changed). A row that points wrong is never corrected here: it was
--      written through the gap, and what it should name is for the school to
--      say.
--   2. Takes every lock it needs at once, NOWAIT, in a loop (below).
--   3. Four parents get the ("id", "schoolId") key the others already have:
--      MasterLessons, RoomPreferences, RoomTypes and LeaveRequests.
--   4. Each of the thirty-eight keys is dropped and added again as
--      (x, "schoolId") -> parent ("id", "schoolId"), NOT VALID. The new key is
--      judged for every write from here on; the rows that exist are judged in
--      the next file (20270115090100), whose VALIDATE blocks neither a read
--      nor a write. ON DELETE is what it was (CASCADE, RESTRICT, or SET NULL,
--      which here names its own column: the key now holds "schoolId" too, and
--      that column is not to be nulled), and so is ON UPDATE CASCADE.
--   5. Three small tables get the index their new key's lookup needs: the
--      lookup Postgres makes in the child when a parent row goes is an
--      equality on the key's columns, and these three keys had no index of any
--      kind. The fourth, CalendarLessons ("subjectId", "schoolId"), is on a
--      big table and is built CONCURRENTLY in the next file.
--
-- ## Beside the live API: every lock at once, or none
--
-- Production runs this while the API before it serves requests. Dropping a
-- foreign key takes ACCESS EXCLUSIVE on the child and on the parent (measured
-- on 17.11: adding one NOT VALID takes SHARE ROW EXCLUSIVE on both, VALIDATE
-- takes SHARE UPDATE EXCLUSIVE on the child and ROW SHARE on the parent, a
-- drop takes ACCESS EXCLUSIVE on both), so the twenty-three tables are taken
-- in ACCESS EXCLUSIVE together, NOWAIT, in a loop: a refusal rolls the
-- subtransaction back with whatever it got and tries again 50 ms later; it
-- never waits while it holds a lock, so it is in no cycle with a request that
-- takes the same tables in another order, and no request queues behind it.
-- Nothing is scanned under the locks (the rows are read before, the new keys
-- are NOT VALID), so they are held for the statements alone. After 30 s it
-- stops with nothing done and can be rerun (prisma migrate resolve
-- --rolled-back, then deploy). lock_timeout bounds any wait nobody foresaw.
-- Run it outside an SS12000 sync window, as 20261207090000.
--
-- If a row points across schools, the first block stops with the key and the
-- ids; nothing is changed, and the file is rerun after the rows are settled
-- (prisma migrate resolve --rolled-back, then deploy; the name is in the
-- message).

-- ---------------------------------------------------------------------------
-- 1. A row that already points across schools stops the migration, named.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  k record;
  n bigint;
  sample text;
  found text := '';
BEGIN
  FOR k IN SELECT * FROM (VALUES
      ('AbsenceReports', 'reportedById', 'Users'),
      ('AbsenceReports', 'studentId', 'Users'),
      ('AttendanceRecords', 'calendarLessonId', 'CalendarLessons'),
      ('AttendanceRecords', 'recordedById', 'Users'),
      ('AttendanceRecords', 'studentId', 'Users'),
      ('AvailabilityConstraints', 'roomId', 'Rooms'),
      ('AvailabilityConstraints', 'studentGroupId', 'StudentGroups'),
      ('AvailabilityConstraints', 'userId', 'Users'),
      ('CalendarLessonGroups', 'calendarLessonId', 'CalendarLessons'),
      ('CalendarLessonGroups', 'studentGroupId', 'StudentGroups'),
      ('CalendarLessonStudents', 'calendarLessonId', 'CalendarLessons'),
      ('CalendarLessonStudents', 'studentId', 'Users'),
      ('CalendarLessonTeachers', 'calendarLessonId', 'CalendarLessons'),
      ('CalendarLessonTeachers', 'teacherId', 'Users'),
      ('CalendarLessons', 'masterLessonId', 'MasterLessons'),
      ('CalendarLessons', 'roomId', 'Rooms'),
      ('CalendarLessons', 'studentGroupId', 'StudentGroups'),
      ('CalendarLessons', 'subjectId', 'Subjects'),
      ('LeaveRequestNotices', 'leaveRequestId', 'LeaveRequests'),
      ('LeaveRequests', 'decidedById', 'Users'),
      ('LeaveRequests', 'referredById', 'Users'),
      ('LeaveRequests', 'requestedById', 'Users'),
      ('LeaveRequests', 'studentId', 'Users'),
      ('MasterLessonGroups', 'masterLessonId', 'MasterLessons'),
      ('MasterLessonStudents', 'masterLessonId', 'MasterLessons'),
      ('Notifications', 'userId', 'Users'),
      ('RoomBookings', 'bookedById', 'Users'),
      ('RoomBookings', 'decidedById', 'Users'),
      ('RoomBookings', 'roomId', 'Rooms'),
      ('RoomPreferenceRooms', 'preferenceId', 'RoomPreferences'),
      ('RoomPreferenceRooms', 'roomId', 'Rooms'),
      ('RoomPreferences', 'roomTypeId', 'RoomTypes'),
      ('RoomPreferences', 'subjectId', 'Subjects'),
      ('Rooms', 'roomTypeId', 'RoomTypes'),
      ('StudentGroupMembers', 'studentGroupId', 'StudentGroups'),
      ('StudentGroupMembers', 'studentId', 'Users'),
      ('StudentGroups', 'academicYearId', 'AcademicYears'),
      ('Subjects', 'requiredRoomTypeId', 'RoomTypes')
  ) AS v(child, col, parent)
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %2$I c JOIN %3$I p ON p."id" = c.%1$I WHERE p."schoolId" <> c."schoolId"',
      k.col, k.child, k.parent) INTO n;
    IF n > 0 THEN
      EXECUTE format(
        'SELECT string_agg(x.what, ''; '') FROM (SELECT c.%1$I::text || '' named from school '' || c."schoolId" || '', belongs to school '' || p."schoolId" AS what FROM %2$I c JOIN %3$I p ON p."id" = c.%1$I WHERE p."schoolId" <> c."schoolId" LIMIT 3) x',
        k.col, k.child, k.parent) INTO sample;
      found := found || format(E'\n  %s.%s -> %s: %s row(s), e.g. %s', k.child, k.col, k.parent, n, sample);
    END IF;
  END LOOP;
  IF found <> '' THEN
    RAISE EXCEPTION E'Rows already point at a row of another school; nothing is changed.%\n\nSettle each row on purpose (they were written through the gap this migration closes), then run: prisma migrate resolve --rolled-back 20270115090000_en_rad_pekar_bara_pa_rader_i_sin_egen_skola, and deploy again.', found;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. Every lock at once, or none.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
  t text;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      FOREACH t IN ARRAY ARRAY[
        'AbsenceReports',
        'AcademicYears',
        'AttendanceRecords',
        'AvailabilityConstraints',
        'CalendarLessonGroups',
        'CalendarLessonStudents',
        'CalendarLessonTeachers',
        'CalendarLessons',
        'LeaveRequestNotices',
        'LeaveRequests',
        'MasterLessonGroups',
        'MasterLessonStudents',
        'MasterLessons',
        'Notifications',
        'RoomBookings',
        'RoomPreferenceRooms',
        'RoomPreferences',
        'RoomTypes',
        'Rooms',
        'StudentGroupMembers',
        'StudentGroups',
        'Subjects',
        'Users'
      ] LOOP
        EXECUTE format('LOCK TABLE %I IN ACCESS EXCLUSIVE MODE NOWAIT', t);
      END LOOP;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'The 23 tables were not free at once in 30 s: nothing is changed, run the migration again (prisma migrate resolve --rolled-back 20270115090000_en_rad_pekar_bara_pa_rader_i_sin_egen_skola, then deploy)';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. The parents' key. The others have it already (Users, StudentGroups, Rooms,
--    Subjects, AcademicYears, CalendarLessons); these four tables are small.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "MasterLessons_id_schoolId_key" ON "MasterLessons"("id", "schoolId");
CREATE UNIQUE INDEX "RoomPreferences_id_schoolId_key" ON "RoomPreferences"("id", "schoolId");
CREATE UNIQUE INDEX "RoomTypes_id_schoolId_key" ON "RoomTypes"("id", "schoolId");
CREATE UNIQUE INDEX "LeaveRequests_id_schoolId_key" ON "LeaveRequests"("id", "schoolId");

-- ---------------------------------------------------------------------------
-- 4. The keys.
-- ---------------------------------------------------------------------------

-- AbsenceReports
ALTER TABLE "AbsenceReports" DROP CONSTRAINT "AbsenceReports_reportedById_fkey";
ALTER TABLE "AbsenceReports" ADD CONSTRAINT "AbsenceReports_reportedById_schoolId_fkey" FOREIGN KEY ("reportedById", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "AbsenceReports" DROP CONSTRAINT "AbsenceReports_studentId_fkey";
ALTER TABLE "AbsenceReports" ADD CONSTRAINT "AbsenceReports_studentId_schoolId_fkey" FOREIGN KEY ("studentId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

-- AttendanceRecords
ALTER TABLE "AttendanceRecords" DROP CONSTRAINT "AttendanceRecords_calendarLessonId_fkey";
ALTER TABLE "AttendanceRecords" ADD CONSTRAINT "AttendanceRecords_calendarLessonId_schoolId_fkey" FOREIGN KEY ("calendarLessonId", "schoolId")
    REFERENCES "CalendarLessons"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "AttendanceRecords" DROP CONSTRAINT "AttendanceRecords_recordedById_fkey";
ALTER TABLE "AttendanceRecords" ADD CONSTRAINT "AttendanceRecords_recordedById_schoolId_fkey" FOREIGN KEY ("recordedById", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE SET NULL ("recordedById") ON UPDATE CASCADE NOT VALID;
ALTER TABLE "AttendanceRecords" DROP CONSTRAINT "AttendanceRecords_studentId_fkey";
ALTER TABLE "AttendanceRecords" ADD CONSTRAINT "AttendanceRecords_studentId_schoolId_fkey" FOREIGN KEY ("studentId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

-- AvailabilityConstraints
ALTER TABLE "AvailabilityConstraints" DROP CONSTRAINT "AvailabilityConstraints_roomId_fkey";
ALTER TABLE "AvailabilityConstraints" ADD CONSTRAINT "AvailabilityConstraints_roomId_schoolId_fkey" FOREIGN KEY ("roomId", "schoolId")
    REFERENCES "Rooms"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "AvailabilityConstraints" DROP CONSTRAINT "AvailabilityConstraints_studentGroupId_fkey";
ALTER TABLE "AvailabilityConstraints" ADD CONSTRAINT "AvailabilityConstraints_studentGroupId_schoolId_fkey" FOREIGN KEY ("studentGroupId", "schoolId")
    REFERENCES "StudentGroups"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "AvailabilityConstraints" DROP CONSTRAINT "AvailabilityConstraints_userId_fkey";
ALTER TABLE "AvailabilityConstraints" ADD CONSTRAINT "AvailabilityConstraints_userId_schoolId_fkey" FOREIGN KEY ("userId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

-- CalendarLessonGroups
ALTER TABLE "CalendarLessonGroups" DROP CONSTRAINT "CalendarLessonGroups_calendarLessonId_fkey";
ALTER TABLE "CalendarLessonGroups" ADD CONSTRAINT "CalendarLessonGroups_calendarLessonId_schoolId_fkey" FOREIGN KEY ("calendarLessonId", "schoolId")
    REFERENCES "CalendarLessons"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "CalendarLessonGroups" DROP CONSTRAINT "CalendarLessonGroups_studentGroupId_fkey";
ALTER TABLE "CalendarLessonGroups" ADD CONSTRAINT "CalendarLessonGroups_studentGroupId_schoolId_fkey" FOREIGN KEY ("studentGroupId", "schoolId")
    REFERENCES "StudentGroups"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

-- CalendarLessonStudents
ALTER TABLE "CalendarLessonStudents" DROP CONSTRAINT "CalendarLessonStudents_calendarLessonId_fkey";
ALTER TABLE "CalendarLessonStudents" ADD CONSTRAINT "CalendarLessonStudents_calendarLessonId_schoolId_fkey" FOREIGN KEY ("calendarLessonId", "schoolId")
    REFERENCES "CalendarLessons"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "CalendarLessonStudents" DROP CONSTRAINT "CalendarLessonStudents_studentId_fkey";
ALTER TABLE "CalendarLessonStudents" ADD CONSTRAINT "CalendarLessonStudents_studentId_schoolId_fkey" FOREIGN KEY ("studentId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

-- CalendarLessonTeachers
ALTER TABLE "CalendarLessonTeachers" DROP CONSTRAINT "CalendarLessonTeachers_calendarLessonId_fkey";
ALTER TABLE "CalendarLessonTeachers" ADD CONSTRAINT "CalendarLessonTeachers_calendarLessonId_schoolId_fkey" FOREIGN KEY ("calendarLessonId", "schoolId")
    REFERENCES "CalendarLessons"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "CalendarLessonTeachers" DROP CONSTRAINT "CalendarLessonTeachers_teacherId_fkey";
ALTER TABLE "CalendarLessonTeachers" ADD CONSTRAINT "CalendarLessonTeachers_teacherId_schoolId_fkey" FOREIGN KEY ("teacherId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

-- CalendarLessons
ALTER TABLE "CalendarLessons" DROP CONSTRAINT "CalendarLessons_masterLessonId_fkey";
ALTER TABLE "CalendarLessons" ADD CONSTRAINT "CalendarLessons_masterLessonId_schoolId_fkey" FOREIGN KEY ("masterLessonId", "schoolId")
    REFERENCES "MasterLessons"("id", "schoolId") ON DELETE SET NULL ("masterLessonId") ON UPDATE CASCADE NOT VALID;
ALTER TABLE "CalendarLessons" DROP CONSTRAINT "CalendarLessons_roomId_fkey";
ALTER TABLE "CalendarLessons" ADD CONSTRAINT "CalendarLessons_roomId_schoolId_fkey" FOREIGN KEY ("roomId", "schoolId")
    REFERENCES "Rooms"("id", "schoolId") ON DELETE SET NULL ("roomId") ON UPDATE CASCADE NOT VALID;
ALTER TABLE "CalendarLessons" DROP CONSTRAINT "CalendarLessons_studentGroupId_fkey";
ALTER TABLE "CalendarLessons" ADD CONSTRAINT "CalendarLessons_studentGroupId_schoolId_fkey" FOREIGN KEY ("studentGroupId", "schoolId")
    REFERENCES "StudentGroups"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "CalendarLessons" DROP CONSTRAINT "CalendarLessons_subjectId_fkey";
ALTER TABLE "CalendarLessons" ADD CONSTRAINT "CalendarLessons_subjectId_schoolId_fkey" FOREIGN KEY ("subjectId", "schoolId")
    REFERENCES "Subjects"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

-- LeaveRequestNotices
ALTER TABLE "LeaveRequestNotices" DROP CONSTRAINT "LeaveRequestNotices_leaveRequestId_fkey";
ALTER TABLE "LeaveRequestNotices" ADD CONSTRAINT "LeaveRequestNotices_leaveRequestId_schoolId_fkey" FOREIGN KEY ("leaveRequestId", "schoolId")
    REFERENCES "LeaveRequests"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

-- LeaveRequests
ALTER TABLE "LeaveRequests" DROP CONSTRAINT "LeaveRequests_decidedById_fkey";
ALTER TABLE "LeaveRequests" ADD CONSTRAINT "LeaveRequests_decidedById_schoolId_fkey" FOREIGN KEY ("decidedById", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE SET NULL ("decidedById") ON UPDATE CASCADE NOT VALID;
ALTER TABLE "LeaveRequests" DROP CONSTRAINT "LeaveRequests_referredById_fkey";
ALTER TABLE "LeaveRequests" ADD CONSTRAINT "LeaveRequests_referredById_schoolId_fkey" FOREIGN KEY ("referredById", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE SET NULL ("referredById") ON UPDATE CASCADE NOT VALID;
ALTER TABLE "LeaveRequests" DROP CONSTRAINT "LeaveRequests_requestedById_fkey";
ALTER TABLE "LeaveRequests" ADD CONSTRAINT "LeaveRequests_requestedById_schoolId_fkey" FOREIGN KEY ("requestedById", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "LeaveRequests" DROP CONSTRAINT "LeaveRequests_studentId_fkey";
ALTER TABLE "LeaveRequests" ADD CONSTRAINT "LeaveRequests_studentId_schoolId_fkey" FOREIGN KEY ("studentId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

-- MasterLessonGroups
ALTER TABLE "MasterLessonGroups" DROP CONSTRAINT "MasterLessonGroups_masterLessonId_fkey";
ALTER TABLE "MasterLessonGroups" ADD CONSTRAINT "MasterLessonGroups_masterLessonId_schoolId_fkey" FOREIGN KEY ("masterLessonId", "schoolId")
    REFERENCES "MasterLessons"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

-- MasterLessonStudents
ALTER TABLE "MasterLessonStudents" DROP CONSTRAINT "MasterLessonStudents_masterLessonId_fkey";
ALTER TABLE "MasterLessonStudents" ADD CONSTRAINT "MasterLessonStudents_masterLessonId_schoolId_fkey" FOREIGN KEY ("masterLessonId", "schoolId")
    REFERENCES "MasterLessons"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

-- Notifications
ALTER TABLE "Notifications" DROP CONSTRAINT "Notifications_userId_fkey";
ALTER TABLE "Notifications" ADD CONSTRAINT "Notifications_userId_schoolId_fkey" FOREIGN KEY ("userId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

-- RoomBookings
ALTER TABLE "RoomBookings" DROP CONSTRAINT "RoomBookings_bookedById_fkey";
ALTER TABLE "RoomBookings" ADD CONSTRAINT "RoomBookings_bookedById_schoolId_fkey" FOREIGN KEY ("bookedById", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "RoomBookings" DROP CONSTRAINT "RoomBookings_decidedById_fkey";
ALTER TABLE "RoomBookings" ADD CONSTRAINT "RoomBookings_decidedById_schoolId_fkey" FOREIGN KEY ("decidedById", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE SET NULL ("decidedById") ON UPDATE CASCADE NOT VALID;
ALTER TABLE "RoomBookings" DROP CONSTRAINT "RoomBookings_roomId_fkey";
ALTER TABLE "RoomBookings" ADD CONSTRAINT "RoomBookings_roomId_schoolId_fkey" FOREIGN KEY ("roomId", "schoolId")
    REFERENCES "Rooms"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

-- RoomPreferenceRooms
ALTER TABLE "RoomPreferenceRooms" DROP CONSTRAINT "RoomPreferenceRooms_preferenceId_fkey";
ALTER TABLE "RoomPreferenceRooms" ADD CONSTRAINT "RoomPreferenceRooms_preferenceId_schoolId_fkey" FOREIGN KEY ("preferenceId", "schoolId")
    REFERENCES "RoomPreferences"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "RoomPreferenceRooms" DROP CONSTRAINT "RoomPreferenceRooms_roomId_fkey";
ALTER TABLE "RoomPreferenceRooms" ADD CONSTRAINT "RoomPreferenceRooms_roomId_schoolId_fkey" FOREIGN KEY ("roomId", "schoolId")
    REFERENCES "Rooms"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

-- RoomPreferences
ALTER TABLE "RoomPreferences" DROP CONSTRAINT "RoomPreferences_roomTypeId_fkey";
ALTER TABLE "RoomPreferences" ADD CONSTRAINT "RoomPreferences_roomTypeId_schoolId_fkey" FOREIGN KEY ("roomTypeId", "schoolId")
    REFERENCES "RoomTypes"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "RoomPreferences" DROP CONSTRAINT "RoomPreferences_subjectId_fkey";
ALTER TABLE "RoomPreferences" ADD CONSTRAINT "RoomPreferences_subjectId_schoolId_fkey" FOREIGN KEY ("subjectId", "schoolId")
    REFERENCES "Subjects"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

-- Rooms
ALTER TABLE "Rooms" DROP CONSTRAINT "Rooms_roomTypeId_fkey";
ALTER TABLE "Rooms" ADD CONSTRAINT "Rooms_roomTypeId_schoolId_fkey" FOREIGN KEY ("roomTypeId", "schoolId")
    REFERENCES "RoomTypes"("id", "schoolId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

-- StudentGroupMembers
ALTER TABLE "StudentGroupMembers" DROP CONSTRAINT "StudentGroupMembers_studentGroupId_fkey";
ALTER TABLE "StudentGroupMembers" ADD CONSTRAINT "StudentGroupMembers_studentGroupId_schoolId_fkey" FOREIGN KEY ("studentGroupId", "schoolId")
    REFERENCES "StudentGroups"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "StudentGroupMembers" DROP CONSTRAINT "StudentGroupMembers_studentId_fkey";
ALTER TABLE "StudentGroupMembers" ADD CONSTRAINT "StudentGroupMembers_studentId_schoolId_fkey" FOREIGN KEY ("studentId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

-- StudentGroups
ALTER TABLE "StudentGroups" DROP CONSTRAINT "StudentGroups_academicYearId_fkey";
ALTER TABLE "StudentGroups" ADD CONSTRAINT "StudentGroups_academicYearId_schoolId_fkey" FOREIGN KEY ("academicYearId", "schoolId")
    REFERENCES "AcademicYears"("id", "schoolId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

-- Subjects
ALTER TABLE "Subjects" DROP CONSTRAINT "Subjects_requiredRoomTypeId_fkey";
ALTER TABLE "Subjects" ADD CONSTRAINT "Subjects_requiredRoomTypeId_schoolId_fkey" FOREIGN KEY ("requiredRoomTypeId", "schoolId")
    REFERENCES "RoomTypes"("id", "schoolId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

-- ---------------------------------------------------------------------------
-- 5. The lookup of a removed parent, on the three small tables that had none.
-- ---------------------------------------------------------------------------

CREATE INDEX "RoomPreferences_subjectId_schoolId_idx" ON "RoomPreferences"("subjectId", "schoolId");
CREATE INDEX "RoomPreferences_roomTypeId_schoolId_idx" ON "RoomPreferences"("roomTypeId", "schoolId");
CREATE INDEX "RoomPreferenceRooms_roomId_schoolId_idx" ON "RoomPreferenceRooms"("roomId", "schoolId");

-- ---------------------------------------------------------------------------
-- The file's own check of what it did: all thirty-eight keys are there (and
-- not yet validated), none of the plain ones is left.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  made int;
  left_over int;
BEGIN
  SELECT count(*) INTO made FROM pg_constraint
   WHERE contype = 'f' AND NOT convalidated AND conname = ANY (ARRAY[
        'AbsenceReports_reportedById_schoolId_fkey',
        'AbsenceReports_studentId_schoolId_fkey',
        'AttendanceRecords_calendarLessonId_schoolId_fkey',
        'AttendanceRecords_recordedById_schoolId_fkey',
        'AttendanceRecords_studentId_schoolId_fkey',
        'AvailabilityConstraints_roomId_schoolId_fkey',
        'AvailabilityConstraints_studentGroupId_schoolId_fkey',
        'AvailabilityConstraints_userId_schoolId_fkey',
        'CalendarLessonGroups_calendarLessonId_schoolId_fkey',
        'CalendarLessonGroups_studentGroupId_schoolId_fkey',
        'CalendarLessonStudents_calendarLessonId_schoolId_fkey',
        'CalendarLessonStudents_studentId_schoolId_fkey',
        'CalendarLessonTeachers_calendarLessonId_schoolId_fkey',
        'CalendarLessonTeachers_teacherId_schoolId_fkey',
        'CalendarLessons_masterLessonId_schoolId_fkey',
        'CalendarLessons_roomId_schoolId_fkey',
        'CalendarLessons_studentGroupId_schoolId_fkey',
        'CalendarLessons_subjectId_schoolId_fkey',
        'LeaveRequestNotices_leaveRequestId_schoolId_fkey',
        'LeaveRequests_decidedById_schoolId_fkey',
        'LeaveRequests_referredById_schoolId_fkey',
        'LeaveRequests_requestedById_schoolId_fkey',
        'LeaveRequests_studentId_schoolId_fkey',
        'MasterLessonGroups_masterLessonId_schoolId_fkey',
        'MasterLessonStudents_masterLessonId_schoolId_fkey',
        'Notifications_userId_schoolId_fkey',
        'RoomBookings_bookedById_schoolId_fkey',
        'RoomBookings_decidedById_schoolId_fkey',
        'RoomBookings_roomId_schoolId_fkey',
        'RoomPreferenceRooms_preferenceId_schoolId_fkey',
        'RoomPreferenceRooms_roomId_schoolId_fkey',
        'RoomPreferences_roomTypeId_schoolId_fkey',
        'RoomPreferences_subjectId_schoolId_fkey',
        'Rooms_roomTypeId_schoolId_fkey',
        'StudentGroupMembers_studentGroupId_schoolId_fkey',
        'StudentGroupMembers_studentId_schoolId_fkey',
        'StudentGroups_academicYearId_schoolId_fkey',
        'Subjects_requiredRoomTypeId_schoolId_fkey'
   ]);
  IF made <> 38 THEN
    RAISE EXCEPTION 'Expected 38 new keys, found %', made;
  END IF;
  SELECT count(*) INTO left_over FROM pg_constraint
   WHERE contype = 'f' AND conname = ANY (ARRAY[
        'AbsenceReports_reportedById_fkey',
        'AbsenceReports_studentId_fkey',
        'AttendanceRecords_calendarLessonId_fkey',
        'AttendanceRecords_recordedById_fkey',
        'AttendanceRecords_studentId_fkey',
        'AvailabilityConstraints_roomId_fkey',
        'AvailabilityConstraints_studentGroupId_fkey',
        'AvailabilityConstraints_userId_fkey',
        'CalendarLessonGroups_calendarLessonId_fkey',
        'CalendarLessonGroups_studentGroupId_fkey',
        'CalendarLessonStudents_calendarLessonId_fkey',
        'CalendarLessonStudents_studentId_fkey',
        'CalendarLessonTeachers_calendarLessonId_fkey',
        'CalendarLessonTeachers_teacherId_fkey',
        'CalendarLessons_masterLessonId_fkey',
        'CalendarLessons_roomId_fkey',
        'CalendarLessons_studentGroupId_fkey',
        'CalendarLessons_subjectId_fkey',
        'LeaveRequestNotices_leaveRequestId_fkey',
        'LeaveRequests_decidedById_fkey',
        'LeaveRequests_referredById_fkey',
        'LeaveRequests_requestedById_fkey',
        'LeaveRequests_studentId_fkey',
        'MasterLessonGroups_masterLessonId_fkey',
        'MasterLessonStudents_masterLessonId_fkey',
        'Notifications_userId_fkey',
        'RoomBookings_bookedById_fkey',
        'RoomBookings_decidedById_fkey',
        'RoomBookings_roomId_fkey',
        'RoomPreferenceRooms_preferenceId_fkey',
        'RoomPreferenceRooms_roomId_fkey',
        'RoomPreferences_roomTypeId_fkey',
        'RoomPreferences_subjectId_fkey',
        'Rooms_roomTypeId_fkey',
        'StudentGroupMembers_studentGroupId_fkey',
        'StudentGroupMembers_studentId_fkey',
        'StudentGroups_academicYearId_fkey',
        'Subjects_requiredRoomTypeId_fkey'
   ]);
  IF left_over <> 0 THEN
    RAISE EXCEPTION '% of the 38 plain keys are left', left_over;
  END IF;
END
$$;
