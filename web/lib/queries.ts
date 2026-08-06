"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { createClient } from "@/utils/supabase/client";
import { api } from "@/lib/api";
import type {
  AbsenceReport,
  AcademicYear,
  AttendanceRecordRow,
  AvailabilityConstraint,
  CalendarLessonRow,
  MasterLesson,
  Person,
  Room,
  LeaveRequest,
  StudentGroup,
  Subject,
  TeachingRequirement,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Reads — straight from Supabase under RLS.
// ---------------------------------------------------------------------------

async function selectAll<T>(table: string, columns: string, orderBy: string): Promise<T[]> {
  const supabase = createClient();
  const { data, error } = await supabase.from(table).select(columns).order(orderBy);
  if (error) throw new Error(error.message);
  return (data ?? []) as T[];
}

export function useSubjects() {
  return useQuery({
    queryKey: ["subjects"],
    queryFn: () =>
      selectAll<Subject>("Subjects", "id, name, code, color, requiredRoomType", "name"),
  });
}

export function useRooms() {
  return useQuery({
    queryKey: ["rooms"],
    queryFn: () => selectAll<Room>("Rooms", "id, name, code, capacity, type", "name"),
  });
}

export function useAcademicYears() {
  return useQuery({
    queryKey: ["academicYears"],
    queryFn: () =>
      selectAll<AcademicYear>(
        "AcademicYears",
        "id, name, startDate, endDate, isActive",
        "startDate",
      ),
  });
}

export function useActiveYear() {
  const years = useAcademicYears();
  return { ...years, activeYear: years.data?.find((year) => year.isActive) ?? null };
}

export function useGroups() {
  return useQuery({
    queryKey: ["groups"],
    queryFn: () =>
      selectAll<StudentGroup>(
        "StudentGroups",
        "id, academicYearId, name, gradeLevel",
        "name",
      ),
  });
}

export function usePeople() {
  return useQuery({
    queryKey: ["people"],
    queryFn: () =>
      selectAll<Person>(
        "Users",
        "id, role, firstName, lastName, email, phone, isActive, studentGroupId",
        "lastName",
      ),
  });
}

export function useRequirements(academicYearId: string | null) {
  return useQuery({
    queryKey: ["requirements", academicYearId],
    enabled: academicYearId !== null,
    queryFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("TeachingRequirements")
        .select(
          "id, academicYearId, subjectId, studentGroupId, teacherId, coTeacherId, lessonsPerWeek, minutesPerLesson",
        )
        .eq("academicYearId", academicYearId!);
      if (error) throw new Error(error.message);
      return (data ?? []) as TeachingRequirement[];
    },
  });
}

export function useConstraints() {
  return useQuery({
    queryKey: ["constraints"],
    queryFn: () =>
      selectAll<AvailabilityConstraint>(
        "AvailabilityConstraints",
        "id, resourceType, userId, roomId, studentGroupId, dayOfWeek, date, startTime, endTime, type, reason",
        "createdAt",
      ),
  });
}

export function useMasterLessons(academicYearId: string | null) {
  return useQuery({
    queryKey: ["masterLessons", academicYearId],
    enabled: academicYearId !== null,
    queryFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("MasterLessons")
        .select(
          "id, academicYearId, subjectId, studentGroupId, teacherId, coTeacherId, roomId, dayOfWeek, startTime, endTime, isLocked, extraGroups:MasterLessonGroups(studentGroupId), participants:MasterLessonStudents(studentId)",
        )
        .eq("academicYearId", academicYearId!)
        .order("dayOfWeek")
        .order("startTime");
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as unknown as Array<
        Omit<MasterLesson, "extraGroupIds" | "studentIds"> & {
          extraGroups: Array<{ studentGroupId: string }>;
          participants: Array<{ studentId: string }>;
        }
      >;
      return rows.map(({ extraGroups, participants, ...lesson }) => ({
        ...lesson,
        extraGroupIds: extraGroups.map((entry) => entry.studentGroupId),
        studentIds: participants.map((entry) => entry.studentId),
      })) as MasterLesson[];
    },
  });
}

export function useCalendarLessons(fromDate: string, toDate: string) {
  return useQuery({
    queryKey: ["calendarLessons", fromDate, toDate],
    queryFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("CalendarLessons")
        .select(
          "id, subjectId, studentGroupId, roomId, date, startsAt, endsAt, status, note",
        )
        .gte("date", fromDate)
        .lte("date", toDate)
        .order("startsAt");
      if (error) throw new Error(error.message);
      return (data ?? []) as CalendarLessonRow[];
    },
  });
}

export interface TeacherLessonRow extends CalendarLessonRow {
  assignmentRole: string;
}

export function useTeacherLessons(teacherId: string, fromDate: string, toDate: string) {
  return useQuery({
    queryKey: ["teacherLessons", teacherId, fromDate, toDate],
    queryFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("CalendarLessonTeachers")
        .select(
          "role, lesson:CalendarLessons!inner(id, subjectId, studentGroupId, roomId, date, startsAt, endsAt, status, note)",
        )
        .eq("teacherId", teacherId)
        .gte("lesson.date", fromDate)
        .lte("lesson.date", toDate);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as unknown as Array<{
        role: string;
        lesson: CalendarLessonRow;
      }>;
      return rows
        .map((row) => ({ ...row.lesson, assignmentRole: row.role }))
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    },
  });
}

export function useStudentAttendance(studentId: string) {
  return useQuery({
    queryKey: ["studentAttendance", studentId],
    queryFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("AttendanceRecords")
        .select(
          "id, calendarLessonId, studentId, status, recordedAt, note, lesson:CalendarLessons(id, date, startsAt, endsAt, subjectId)",
        )
        .eq("studentId", studentId)
        .order("recordedAt", { ascending: false })
        .limit(200);
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as Array<
        AttendanceRecordRow & {
          lesson: Pick<CalendarLessonRow, "id" | "date" | "startsAt" | "endsAt" | "subjectId"> | null;
        }
      >;
    },
  });
}

export function useLesson(lessonId: string) {
  return useQuery({
    queryKey: ["lesson", lessonId],
    queryFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("CalendarLessons")
        .select("id, subjectId, studentGroupId, roomId, date, startsAt, endsAt, status, note")
        .eq("id", lessonId)
        .single();
      if (error) throw new Error(error.message);
      return data as CalendarLessonRow;
    },
  });
}

/**
 * Full roster of a calendar lesson: students of the primary class, of every
 * extra class, and individually participating students (deduplicated).
 */
export function useLessonRoster(
  calendarLessonId: string | null,
  primaryGroupId: string | null,
) {
  return useQuery({
    queryKey: ["lessonRoster", calendarLessonId, primaryGroupId],
    enabled: calendarLessonId !== null && primaryGroupId !== null,
    queryFn: async () => {
      const supabase = createClient();
      const [extraGroupsRes, participantsRes] = await Promise.all([
        supabase
          .from("CalendarLessonGroups")
          .select("studentGroupId")
          .eq("calendarLessonId", calendarLessonId!),
        supabase
          .from("CalendarLessonStudents")
          .select("studentId")
          .eq("calendarLessonId", calendarLessonId!),
      ]);
      if (extraGroupsRes.error) throw new Error(extraGroupsRes.error.message);
      if (participantsRes.error) throw new Error(participantsRes.error.message);

      const groupIds = [
        primaryGroupId!,
        ...(extraGroupsRes.data ?? []).map(
          (row) => (row as { studentGroupId: string }).studentGroupId,
        ),
      ];
      const studentIds = (participantsRes.data ?? []).map(
        (row) => (row as { studentId: string }).studentId,
      );

      const filters = [`studentGroupId.in.(${groupIds.join(",")})`];
      if (studentIds.length > 0) filters.push(`id.in.(${studentIds.join(",")})`);

      const { data, error } = await supabase
        .from("Users")
        .select("id, role, firstName, lastName, email, phone, isActive, studentGroupId")
        .eq("role", "STUDENT")
        .eq("isActive", true)
        .or(filters.join(","))
        .order("lastName");
      if (error) throw new Error(error.message);
      return (data ?? []) as Person[];
    },
  });
}

export function useGroupStudents(groupId: string | null) {
  return useQuery({
    queryKey: ["groupStudents", groupId],
    enabled: groupId !== null,
    queryFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("Users")
        .select("id, role, firstName, lastName, email, phone, isActive, studentGroupId")
        .eq("studentGroupId", groupId!)
        .eq("role", "STUDENT")
        .eq("isActive", true)
        .order("lastName");
      if (error) throw new Error(error.message);
      return (data ?? []) as Person[];
    },
  });
}

export function useLessonAttendance(calendarLessonId: string) {
  return useQuery({
    queryKey: ["lessonAttendance", calendarLessonId],
    queryFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("AttendanceRecords")
        .select("id, calendarLessonId, studentId, status, recordedAt, note")
        .eq("calendarLessonId", calendarLessonId);
      if (error) throw new Error(error.message);
      return (data ?? []) as AttendanceRecordRow[];
    },
  });
}

// ---------------------------------------------------------------------------
// Mutations — through the NestJS gateway.
// ---------------------------------------------------------------------------

export interface CrudMutations<TBody> {
  create: UseMutationResult<unknown, Error, TBody>;
  update: UseMutationResult<unknown, Error, { id: string } & Partial<TBody>>;
  remove: UseMutationResult<unknown, Error, string>;
}

export function useCrudMutations<TBody>(
  apiPath: string,
  invalidateKeys: string[][],
): CrudMutations<TBody> {
  const queryClient = useQueryClient();
  const invalidate = () => {
    for (const key of invalidateKeys) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  };

  const create = useMutation({
    mutationFn: (body: TBody) => api.post(apiPath, body),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Partial<TBody>) =>
      api.patch(`${apiPath}/${id}`, body),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`${apiPath}/${id}`),
    onSuccess: invalidate,
  });

  return { create, update, remove };
}

// ---------------------------------------------------------------------------
// Optimization job polling
// ---------------------------------------------------------------------------

export interface ConflictDetail {
  category: string;
  message: string;
}

export interface OptimizationJob {
  id: string;
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";
  solverStatus: "OPTIMAL" | "FEASIBLE" | "INFEASIBLE" | "TIMEOUT" | null;
  lessonsGenerated: number;
  conflictSummary: string | null;
  conflicts: ConflictDetail[];
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface ObjectiveWeights {
  preferredFree?: number;
  preferredBusy?: number;
  disruption?: number;
  spread?: number;
  teacherGap?: number;
}

export interface ScheduleRules {
  /** HH:MM:SS */
  lunchStartTime?: string;
  lunchEndTime?: string;
  lunchMinutes?: number;
  maxLessonsPerDayPerGroup?: number;
}

export function useStartOptimization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      academicYearId: string;
      weights?: ObjectiveWeights;
      rules?: ScheduleRules;
    }) => api.post<{ jobId: string }>("/api/v1/optimization/jobs", body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["masterLessons"] });
      void queryClient.invalidateQueries({ queryKey: ["optimizationHistory"] });
    },
  });
}

/** Latest optimization runs for an academic year (durable job history). */
export function useOptimizationHistory(academicYearId: string | null) {
  return useQuery({
    queryKey: ["optimizationHistory", academicYearId],
    enabled: academicYearId !== null,
    queryFn: () =>
      api.get<OptimizationJob[]>(
        `/api/v1/optimization/jobs?academicYearId=${academicYearId}`,
      ),
  });
}

export function useOptimizationJob(jobId: string | null) {
  return useQuery({
    queryKey: ["optimizationJob", jobId],
    enabled: jobId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "PENDING" || status === "RUNNING" ? 2000 : false;
    },
    queryFn: () => api.get<OptimizationJob>(`/api/v1/optimization/jobs/${jobId}`),
  });
}

export function usePublishSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { academicYearId: string; fromDate?: string; toDate?: string }) =>
      api.post<{ created: number }>("/api/v1/calendar/publish", body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["calendarLessons"] });
    },
  });
}

// ---------------------------------------------------------------------------
// Timetable adjustments & lesson operations
// ---------------------------------------------------------------------------

export interface UpdateMasterLessonInput {
  id: string;
  dayOfWeek?: number;
  startTime?: string;
  endTime?: string;
  roomId?: string | null;
  teacherId?: string | null;
  isLocked?: boolean;
  propagate?: boolean;
  extraGroupIds?: string[];
  studentIds?: string[];
}

export interface CreateMasterLessonInput {
  academicYearId: string;
  subjectId: string;
  studentGroupId: string;
  teacherId?: string | null;
  roomId?: string | null;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  isLocked?: boolean;
  extraGroupIds?: string[];
  studentIds?: string[];
}

export interface MasterLessonResponse {
  id: string;
  academicYearId: string;
  subjectId: string;
  studentGroupId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  roomId: string | null;
  teacherId: string | null;
  isLocked: boolean;
}

function useInvalidateSchedule() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["masterLessons"] });
    void queryClient.invalidateQueries({ queryKey: ["calendarLessons"] });
    void queryClient.invalidateQueries({ queryKey: ["teacherLessons"] });
  };
}

export function useUpdateMasterLesson() {
  const invalidate = useInvalidateSchedule();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateMasterLessonInput) =>
      api.patch<MasterLessonResponse & { propagatedLessons: number }>(
        `/api/v1/master-lessons/${id}`,
        body,
      ),
    onSuccess: invalidate,
  });
}

export function useCreateMasterLesson() {
  const invalidate = useInvalidateSchedule();
  return useMutation({
    mutationFn: (body: CreateMasterLessonInput) =>
      api.post<MasterLessonResponse>("/api/v1/master-lessons", body),
    onSuccess: invalidate,
  });
}

export function useDeleteMasterLesson() {
  const invalidate = useInvalidateSchedule();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete<{ id: string; removedCalendarLessons: number }>(
        `/api/v1/master-lessons/${id}`,
      ),
    onSuccess: invalidate,
  });
}

export interface DayLessonRow extends CalendarLessonRow {
  teachers: Array<{ role: string; teacherId: string }>;
}

/** Calendar lessons for one date, including teacher assignments (admin day view). */
export function useDayLessons(date: string) {
  return useQuery({
    queryKey: ["dayLessons", date],
    queryFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("CalendarLessons")
        .select(
          "id, subjectId, studentGroupId, roomId, date, startsAt, endsAt, status, note, teachers:CalendarLessonTeachers(role, teacherId)",
        )
        .eq("date", date)
        .order("startsAt");
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as DayLessonRow[];
    },
  });
}

export function useLessonActions() {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["dayLessons"] });
    void queryClient.invalidateQueries({ queryKey: ["calendarLessons"] });
    void queryClient.invalidateQueries({ queryKey: ["teacherLessons"] });
  };

  const cancel = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      api.patch(`/api/v1/calendar-lessons/${id}/cancel`, reason ? { reason } : {}),
    onSuccess: invalidate,
  });
  const reinstate = useMutation({
    mutationFn: (id: string) => api.patch(`/api/v1/calendar-lessons/${id}/reinstate`, {}),
    onSuccess: invalidate,
  });
  const substitute = useMutation({
    mutationFn: ({ id, teacherId, note }: { id: string; teacherId: string; note?: string }) =>
      api.patch(`/api/v1/calendar-lessons/${id}/substitute`, {
        teacherId,
        ...(note ? { note } : {}),
      }),
    onSuccess: invalidate,
  });

  return { cancel, reinstate, substitute };
}

// ---------------------------------------------------------------------------
// Schedule versions (snapshots / restore)
// ---------------------------------------------------------------------------

export interface ScheduleVersion {
  id: string;
  academicYearId: string;
  name: string;
  lessonCount: number;
  createdAt: string;
}

export interface VersionLesson {
  subjectId: string;
  studentGroupId: string;
  teacherId: string | null;
  coTeacherId?: string | null;
  roomId: string | null;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  isLocked: boolean;
  extraGroupIds?: string[];
  studentIds?: string[];
}

/** Snapshot content, used for diffing a version against the live timetable. */
export function useScheduleVersionDetail(versionId: string | null) {
  return useQuery({
    queryKey: ["scheduleVersionDetail", versionId],
    enabled: versionId !== null,
    queryFn: () =>
      api.get<ScheduleVersion & { lessons: VersionLesson[] }>(
        `/api/v1/schedule-versions/${versionId}`,
      ),
  });
}

export function useScheduleVersions(academicYearId: string | null) {
  return useQuery({
    queryKey: ["scheduleVersions", academicYearId],
    enabled: academicYearId !== null,
    queryFn: () =>
      api.get<ScheduleVersion[]>(
        `/api/v1/schedule-versions?academicYearId=${academicYearId}`,
      ),
  });
}

export function useScheduleVersionActions() {
  const queryClient = useQueryClient();
  const invalidateVersions = () => {
    void queryClient.invalidateQueries({ queryKey: ["scheduleVersions"] });
  };
  const invalidateSchedule = () => {
    invalidateVersions();
    void queryClient.invalidateQueries({ queryKey: ["masterLessons"] });
    void queryClient.invalidateQueries({ queryKey: ["calendarLessons"] });
    void queryClient.invalidateQueries({ queryKey: ["teacherLessons"] });
  };

  const save = useMutation({
    mutationFn: (body: { academicYearId: string; name: string }) =>
      api.post<ScheduleVersion>("/api/v1/schedule-versions", body),
    onSuccess: invalidateVersions,
  });
  const restore = useMutation({
    mutationFn: (id: string) =>
      api.post<{ restoredLessons: number; safetyVersionId: string }>(
        `/api/v1/schedule-versions/${id}/restore`,
        {},
      ),
    onSuccess: invalidateSchedule,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/schedule-versions/${id}`),
    onSuccess: invalidateVersions,
  });

  return { save, restore, remove };
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export interface GroupAttendanceRow {
  studentId: string;
  status: "UNKNOWN" | "PRESENT" | "ABSENT" | "LATE" | "EXCUSED";
  lesson: { startsAt: string; endsAt: string } | null;
}

/** All attendance records for a class within a date window (admin reports). */
export function useGroupAttendance(
  groupId: string | null,
  fromDate: string,
  toDate: string,
) {
  return useQuery({
    queryKey: ["groupAttendance", groupId, fromDate, toDate],
    enabled: groupId !== null,
    queryFn: async () => {
      const supabase = createClient();
      // Filter by the STUDENT's class (not the lesson's primary class) so
      // electives and multi-class lessons count toward the right class.
      const { data, error } = await supabase
        .from("AttendanceRecords")
        .select(
          "studentId, status, lesson:CalendarLessons!inner(id, date, startsAt, endsAt), student:Users!AttendanceRecords_studentId_fkey!inner(studentGroupId)",
        )
        .eq("student.studentGroupId", groupId!)
        .gte("lesson.date", fromDate)
        .lte("lesson.date", toDate)
        .limit(20000);
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as GroupAttendanceRow[];
    },
  });
}

export interface AttendanceEntryInput {
  studentId: string;
  status: "PRESENT" | "ABSENT" | "LATE" | "EXCUSED" | "UNKNOWN";
  note?: string;
}

export function useReportAttendance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { calendarLessonId: string; records: AttendanceEntryInput[] }) =>
      api.post<{ created: number; updated: number }>("/api/v1/attendance/report", body),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ["lessonAttendance", variables.calendarLessonId],
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Guardians, absence reporting, leave requests
// ---------------------------------------------------------------------------

/** The signed-in guardian's children (via GuardianStudents, RLS-scoped). */
export function useMyChildren(guardianUserId: string | null) {
  return useQuery({
    queryKey: ["myChildren", guardianUserId],
    enabled: guardianUserId !== null,
    queryFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("GuardianStudents")
        .select(
          "id, studentId, student:Users!GuardianStudents_studentId_fkey(id, role, firstName, lastName, email, phone, isActive, studentGroupId)",
        )
        .eq("guardianId", guardianUserId!);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as unknown as Array<{
        id: string;
        studentId: string;
        student: Person;
      }>;
      return rows.map((row) => ({ linkId: row.id, ...row.student }));
    },
  });
}

/** Guardians linked to one student (admin management view). */
export function useStudentGuardians(studentId: string | null) {
  return useQuery({
    queryKey: ["studentGuardians", studentId],
    enabled: studentId !== null,
    queryFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("GuardianStudents")
        .select(
          "id, guardianId, guardian:Users!GuardianStudents_guardianId_fkey(id, firstName, lastName, email)",
        )
        .eq("studentId", studentId!);
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as Array<{
        id: string;
        guardianId: string;
        guardian: Pick<Person, "id" | "firstName" | "lastName" | "email">;
      }>;
    },
  });
}

export function useGuardianLinkActions() {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["studentGuardians"] });
    void queryClient.invalidateQueries({ queryKey: ["myChildren"] });
  };
  const link = useMutation({
    mutationFn: (body: { guardianId: string; studentId: string }) =>
      api.post("/api/v1/guardian-links", body),
    onSuccess: invalidate,
  });
  const unlink = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/guardian-links/${id}`),
    onSuccess: invalidate,
  });
  return { link, unlink };
}

/** Absence reports visible to the caller (RLS: own children / own / staff). */
export function useAbsenceReports(options?: { date?: string; studentId?: string }) {
  return useQuery({
    queryKey: ["absenceReports", options?.date ?? null, options?.studentId ?? null],
    queryFn: async () => {
      const supabase = createClient();
      let query = supabase
        .from("AbsenceReports")
        .select(
          "id, studentId, reportedById, date, startTime, endTime, type, note, createdAt",
        )
        .order("date", { ascending: false })
        .limit(200);
      if (options?.date) query = query.eq("date", options.date);
      if (options?.studentId) query = query.eq("studentId", options.studentId);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return (data ?? []) as AbsenceReport[];
    },
  });
}

export function useAbsenceReportActions() {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["absenceReports"] });
  };
  const report = useMutation({
    mutationFn: (body: {
      studentId: string;
      date: string;
      startTime?: string;
      endTime?: string;
      type: "SICK" | "APPOINTMENT" | "OTHER";
      note?: string;
    }) => api.post("/api/v1/absence-reports", body),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/absence-reports/${id}`),
    onSuccess: invalidate,
  });
  return { report, remove };
}

/** Leave requests visible to the caller (guardian: children; admin: all). */
export function useLeaveRequests(status?: "PENDING" | "APPROVED" | "REJECTED") {
  return useQuery({
    queryKey: ["leaveRequests", status ?? null],
    queryFn: async () => {
      const supabase = createClient();
      let query = supabase
        .from("LeaveRequests")
        .select(
          "id, studentId, requestedById, startDate, endDate, reason, status, decidedById, decidedAt, decisionNote, createdAt",
        )
        .order("createdAt", { ascending: false })
        .limit(200);
      if (status) query = query.eq("status", status);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return (data ?? []) as LeaveRequest[];
    },
  });
}

export function useLeaveRequestActions() {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["leaveRequests"] });
    void queryClient.invalidateQueries({ queryKey: ["absenceReports"] });
  };
  const request = useMutation({
    mutationFn: (body: {
      studentId: string;
      startDate: string;
      endDate: string;
      reason: string;
    }) => api.post("/api/v1/leave-requests", body),
    onSuccess: invalidate,
  });
  const decide = useMutation({
    mutationFn: ({ id, status, note }: { id: string; status: "APPROVED" | "REJECTED"; note?: string }) =>
      api.patch(`/api/v1/leave-requests/${id}/decide`, { status, ...(note ? { note } : {}) }),
    onSuccess: invalidate,
  });
  return { request, decide };
}
