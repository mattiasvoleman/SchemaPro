-- De nya nycklarna provas mot raderna som finns.
--
-- The thirty-eight keys of
-- 20270115090000_en_rad_pekar_bara_pa_rader_i_sin_egen_skola judge every write
-- from the moment they were added; here the rows that were already there are
-- judged. VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE on the child and ROW
-- SHARE on the parent, which blocks neither a read nor a write, so this runs
-- while the API serves, a table at a time, and a long one (AttendanceRecords,
-- CalendarLessons, the lessons' parts) holds nothing but its own table against
-- other schema changes. Each statement is its own transaction (a file of plain
-- statements is applied one at a time), and a key already valid is a no-op, so a
-- stop part of the way is finished by running the file again.
--
-- Rows that point across schools were named and refused before the keys were
-- made. One written between that look and the new key could only have been
-- written through the gap, and this stops on it with the key's name and the
-- row's.
--
-- The last statement builds the index of the fourth key whose lookup had none,
-- CalendarLessons ("subjectId", "schoolId"): before this, removing a subject
-- read every lesson of every school, and the new key would do the same.
-- CONCURRENTLY, so writing lessons goes on while it is built. A failed
-- concurrent build leaves an invalid index of that name behind: drop it
-- (DROP INDEX "CalendarLessons_subjectId_schoolId_idx") before running the
-- file again, which is why this statement has no IF NOT EXISTS.

ALTER TABLE "AbsenceReports" VALIDATE CONSTRAINT "AbsenceReports_reportedById_schoolId_fkey";
ALTER TABLE "AbsenceReports" VALIDATE CONSTRAINT "AbsenceReports_studentId_schoolId_fkey";
ALTER TABLE "AttendanceRecords" VALIDATE CONSTRAINT "AttendanceRecords_calendarLessonId_schoolId_fkey";
ALTER TABLE "AttendanceRecords" VALIDATE CONSTRAINT "AttendanceRecords_recordedById_schoolId_fkey";
ALTER TABLE "AttendanceRecords" VALIDATE CONSTRAINT "AttendanceRecords_studentId_schoolId_fkey";
ALTER TABLE "AvailabilityConstraints" VALIDATE CONSTRAINT "AvailabilityConstraints_roomId_schoolId_fkey";
ALTER TABLE "AvailabilityConstraints" VALIDATE CONSTRAINT "AvailabilityConstraints_studentGroupId_schoolId_fkey";
ALTER TABLE "AvailabilityConstraints" VALIDATE CONSTRAINT "AvailabilityConstraints_userId_schoolId_fkey";
ALTER TABLE "CalendarLessonGroups" VALIDATE CONSTRAINT "CalendarLessonGroups_calendarLessonId_schoolId_fkey";
ALTER TABLE "CalendarLessonGroups" VALIDATE CONSTRAINT "CalendarLessonGroups_studentGroupId_schoolId_fkey";
ALTER TABLE "CalendarLessonStudents" VALIDATE CONSTRAINT "CalendarLessonStudents_calendarLessonId_schoolId_fkey";
ALTER TABLE "CalendarLessonStudents" VALIDATE CONSTRAINT "CalendarLessonStudents_studentId_schoolId_fkey";
ALTER TABLE "CalendarLessonTeachers" VALIDATE CONSTRAINT "CalendarLessonTeachers_calendarLessonId_schoolId_fkey";
ALTER TABLE "CalendarLessonTeachers" VALIDATE CONSTRAINT "CalendarLessonTeachers_teacherId_schoolId_fkey";
ALTER TABLE "CalendarLessons" VALIDATE CONSTRAINT "CalendarLessons_masterLessonId_schoolId_fkey";
ALTER TABLE "CalendarLessons" VALIDATE CONSTRAINT "CalendarLessons_roomId_schoolId_fkey";
ALTER TABLE "CalendarLessons" VALIDATE CONSTRAINT "CalendarLessons_studentGroupId_schoolId_fkey";
ALTER TABLE "CalendarLessons" VALIDATE CONSTRAINT "CalendarLessons_subjectId_schoolId_fkey";
ALTER TABLE "LeaveRequestNotices" VALIDATE CONSTRAINT "LeaveRequestNotices_leaveRequestId_schoolId_fkey";
ALTER TABLE "LeaveRequests" VALIDATE CONSTRAINT "LeaveRequests_decidedById_schoolId_fkey";
ALTER TABLE "LeaveRequests" VALIDATE CONSTRAINT "LeaveRequests_referredById_schoolId_fkey";
ALTER TABLE "LeaveRequests" VALIDATE CONSTRAINT "LeaveRequests_requestedById_schoolId_fkey";
ALTER TABLE "LeaveRequests" VALIDATE CONSTRAINT "LeaveRequests_studentId_schoolId_fkey";
ALTER TABLE "MasterLessonGroups" VALIDATE CONSTRAINT "MasterLessonGroups_masterLessonId_schoolId_fkey";
ALTER TABLE "MasterLessonStudents" VALIDATE CONSTRAINT "MasterLessonStudents_masterLessonId_schoolId_fkey";
ALTER TABLE "Notifications" VALIDATE CONSTRAINT "Notifications_userId_schoolId_fkey";
ALTER TABLE "RoomBookings" VALIDATE CONSTRAINT "RoomBookings_bookedById_schoolId_fkey";
ALTER TABLE "RoomBookings" VALIDATE CONSTRAINT "RoomBookings_decidedById_schoolId_fkey";
ALTER TABLE "RoomBookings" VALIDATE CONSTRAINT "RoomBookings_roomId_schoolId_fkey";
ALTER TABLE "RoomPreferenceRooms" VALIDATE CONSTRAINT "RoomPreferenceRooms_preferenceId_schoolId_fkey";
ALTER TABLE "RoomPreferenceRooms" VALIDATE CONSTRAINT "RoomPreferenceRooms_roomId_schoolId_fkey";
ALTER TABLE "RoomPreferences" VALIDATE CONSTRAINT "RoomPreferences_roomTypeId_schoolId_fkey";
ALTER TABLE "RoomPreferences" VALIDATE CONSTRAINT "RoomPreferences_subjectId_schoolId_fkey";
ALTER TABLE "Rooms" VALIDATE CONSTRAINT "Rooms_roomTypeId_schoolId_fkey";
ALTER TABLE "StudentGroupMembers" VALIDATE CONSTRAINT "StudentGroupMembers_studentGroupId_schoolId_fkey";
ALTER TABLE "StudentGroupMembers" VALIDATE CONSTRAINT "StudentGroupMembers_studentId_schoolId_fkey";
ALTER TABLE "StudentGroups" VALIDATE CONSTRAINT "StudentGroups_academicYearId_schoolId_fkey";
ALTER TABLE "Subjects" VALIDATE CONSTRAINT "Subjects_requiredRoomTypeId_schoolId_fkey";

CREATE INDEX CONCURRENTLY "CalendarLessons_subjectId_schoolId_idx" ON "CalendarLessons"("subjectId", "schoolId");
