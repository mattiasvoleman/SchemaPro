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
  AcademicYear,
  AttendanceRecordRow,
  AvailabilityConstraint,
  CalendarLessonRow,
  MasterLesson,
  Person,
  Room,
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
    queryFn: () => selectAll<Subject>("Subjects", "id, name, code, color", "name"),
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
          "id, academicYearId, subjectId, studentGroupId, teacherId, lessonsPerWeek, minutesPerLesson",
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
          "id, academicYearId, subjectId, studentGroupId, teacherId, roomId, dayOfWeek, startTime, endTime",
        )
        .eq("academicYearId", academicYearId!)
        .order("dayOfWeek")
        .order("startTime");
      if (error) throw new Error(error.message);
      return (data ?? []) as MasterLesson[];
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
  solverStatus: "OPTIMAL" | "FEASIBLE" | "INFEASIBLE" | null;
  lessonsGenerated: number;
  conflictSummary: string | null;
  conflicts: ConflictDetail[];
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export function useStartOptimization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (academicYearId: string) =>
      api.post<{ jobId: string }>("/api/v1/optimization/jobs", { academicYearId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["masterLessons"] });
    },
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
