"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { createClient } from "@/utils/supabase/client";
import { api } from "@/lib/api";
import { sortByName, sortByPersonName } from "@/lib/sorting";
import type {
  LessonRecurrence,
  LunchSettings,
  RoomType,
  AbsenceReport,
  AcademicYear,
  AttendanceRecordRow,
  AvailabilityConstraint,
  BreakKind,
  CalendarLessonRow,
  MasterLesson,
  Person,
  Room,
  RoomBooking,
  RoomBookingStatus,
  LeaveRequest,
  SchoolBreak,
  StudentGroup,
  Subject,
  TeachingRequirement,
  FrameTime,
  LunchServing,
  LunchSitting,
  CalendarLunch,
  Rast,
  CalendarRast,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Reads — straight from Supabase under RLS.
// ---------------------------------------------------------------------------

/**
 * PostgREST caps a response at 1000 rows, and Supabase does not say so — the
 * body simply arrives short. A school with 5400 teaching-group memberships got
 * the first thousand and nothing else: some groups showed their students,
 * every group after the cut showed zero, and the schedule editor's clash
 * checks silently stopped covering the missing ones.
 */
const PAGE_SIZE = 1000;

/**
 * Runs a windowed query until it returns a short page.
 *
 * Every caller must order by something unique last — paging relies on a total
 * order, and rows tying on the primary sort column are free to shuffle between
 * requests, which duplicates some rows and loses others.
 *
 * The page ceiling is a runaway guard, not a limit anyone should reach: 50
 * pages is 50 000 rows, well past any single Swedish school.
 */
async function fetchAllPages<T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = [];

  for (let index = 0; index < 50; index++) {
    const from = index * PAGE_SIZE;
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);

    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }

  return rows;
}

/** Fetches an entire table, one page at a time. */
async function selectAll<T>(table: string, columns: string, orderBy: string): Promise<T[]> {
  const supabase = createClient();
  return fetchAllPages<T>((from, to) =>
    supabase.from(table).select(columns).order(orderBy).order("id").range(from, to),
  );
}

export function useSubjects() {
  return useQuery({
    queryKey: ["subjects"],
    queryFn: async () =>
      // Re-sorted in Swedish. The database orders by name too, but under its
      // own collation — which puts Övrigt in the middle of the list and
      // Ämnesval before Bild. Every consumer reads this hook, so the subject
      // page, the timplan columns and every subject dropdown agree.
      sortByName(
        await selectAll<Subject>(
          "Subjects",
          "id, name, code, color, requiredRoomTypeId",
          "name",
        ),
        (subject) => subject.name,
      ),
  });
}

/**
 * Room types the school defined. Read through the API rather than Supabase so
 * the usage counts (_count) that gate deletion come with the row.
 */
export function useRoomTypes() {
  return useQuery({
    queryKey: ["roomTypes"],
    // The API sorts these in PostgreSQL too, so they arrive with Övrigt in the
    // middle of the list — the same symptom subjects had. Re-sorted here for
    // the same reason: the collation belongs to the reader's language, not to
    // the server's locale settings.
    queryFn: async () =>
      sortByName(await api.get<RoomType[]>("/api/v1/room-types"), (type) => type.name),
  });
}

/** Room types touch both rooms and subjects, so both caches are refreshed. */
export function useRoomTypeActions() {
  return useCrudMutations<{ name: string }>("/api/v1/room-types", [
    ["roomTypes"],
    ["rooms"],
    ["subjects"],
  ]);
}

export function useRooms() {
  return useQuery({
    queryKey: ["rooms"],
    queryFn: async () =>
      // Room names are where a Swedish school actually puts its accented
      // letters: Ängen, Åsen, Örnen, Slöjdsalen.
      sortByName(
        await selectAll<Room>(
          "Rooms",
          "id, name, code, capacity, roomTypeId, minGradeLevel, maxGradeLevel, requiresApproval",
          "name",
        ),
        (room) => room.name,
      ),
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
    queryFn: async () =>
      // Swedish order, like useSubjects. The timplan puts these two lists at
      // right angles to each other — groups down the side, subjects across the
      // top — so sorting one and not the other makes a single table disagree
      // with itself about where å, ä and ö belong.
      sortByName(
        await selectAll<StudentGroup>(
          "StudentGroups",
          "id, academicYearId, name, kind, gradeLevel",
          "name",
        ),
        (group) => group.name,
      ),
  });
}

export function usePeople() {
  return useQuery({
    queryKey: ["people"],
    queryFn: async () =>
      // The school's largest list, and the one an admin scrolls most. Sorted
      // in Swedish here rather than in each of its dozen consumers — the
      // register, every teacher and student dropdown, the group-member picker
      // and the people CSV export all read this array as it comes.
      sortByPersonName(
        await selectAll<Person>(
          "Users",
          "id, role, firstName, lastName, email, phone, isActive, studentGroupId, invitedAt",
          "lastName",
        ),
      ),
  });
}

export function useRequirements(academicYearId: string | null) {
  return useQuery({
    queryKey: ["requirements", academicYearId],
    enabled: academicYearId !== null,
    queryFn: async () => {
      const supabase = createClient();
      // A secondary school's timplan is one row per group per subject —
      // ninety groups and a dozen subjects already passes the page cap.
      return fetchAllPages<TeachingRequirement>((from, to) =>
        supabase
          .from("TeachingRequirements")
          .select(
            "id, academicYearId, subjectId, studentGroupId, teacherId, coTeacherId, lessonsPerWeek, minutesPerLesson, recurrence, startDate, endDate",
          )
          .eq("academicYearId", academicYearId!)
          .order("id")
          .range(from, to),
      );
    },
  });
}

export function useConstraints() {
  return useQuery({
    queryKey: ["constraints"],
    queryFn: () =>
      selectAll<AvailabilityConstraint>(
        "AvailabilityConstraints",
        "id, resourceType, userId, roomId, studentGroupId, minGradeLevel, maxGradeLevel, dayOfWeek, date, startTime, endTime, type, reason",
        "createdAt",
      ),
  });
}

/**
 * The school's ramtider — the hours each stage may be taught in.
 *
 * NOT keyed on the läsår, because the row is not: a frame describes the shape
 * of the school's day, which is the scope AvailabilityConstraints uses and for
 * the same reason. The migration argues the tradeoff.
 *
 * Not paged either. A Swedish school has three or four stages and five
 * weekdays; even one row per single year per day is under a hundred, and
 * wrapping this in fetchAllPages would suggest a volume that cannot happen.
 */
export function useFrameTimes() {
  return useQuery({
    queryKey: ["frame-times"],
    queryFn: () =>
      selectAll<FrameTime>(
        "FrameTimes",
        "id, minGradeLevel, maxGradeLevel, dayOfWeek, startTime, endTime, changeoverMinutes",
        "minGradeLevel",
      ),
  });
}

/**
 * The school's raster — when each stage is not taught.
 *
 * School-scoped and unpaged for the same reasons useFrameTimes and
 * useLunchServings are: the shape of the day describes the building and the
 * yard rather than one läsår, and three or four stages across five weekdays is
 * a table of tens.
 */
export function useRasts() {
  return useQuery({
    queryKey: ["rasts"],
    queryFn: () =>
      selectAll<Rast>(
        "Rasts",
        "id, name, minGradeLevel, maxGradeLevel, dayOfWeek, startTime, endTime",
        "minGradeLevel",
      ),
  });
}

/**
 * The school's lunchsittningar — when each stage eats.
 *
 * School-scoped and unpaged for the same reasons useFrameTimes is: the flow
 * describes the building and the kitchen rather than one läsår, and three or
 * four stages across five weekdays is a table of tens, not thousands.
 */
export function useLunchServings() {
  return useQuery({
    queryKey: ["lunch-servings"],
    queryFn: () =>
      selectAll<LunchServing>(
        "LunchServings",
        "id, minGradeLevel, maxGradeLevel, dayOfWeek, startTime, endTime, seats",
        "minGradeLevel",
      ),
  });
}

/**
 * The lunch the solver gave each group, one row per group per weekday.
 *
 * Year-scoped and disabled until one is picked, unlike the SITTINGS a school
 * declares: this is what the solver decided against ONE läsår's lessons, and it
 * is meaningless against another's.
 */
export function useLunchSittings(academicYearId: string | null) {
  return useQuery({
    queryKey: ["lunch-sittings", academicYearId],
    enabled: academicYearId !== null,
    queryFn: async () => {
      const supabase = createClient();
      return fetchAllPages<LunchSitting>((from, to) =>
        supabase
          .from("LunchSittings")
          .select("id, studentGroupId, dayOfWeek, startTime, endTime, headcount")
          .eq("academicYearId", academicYearId!)
          .order("dayOfWeek")
          .order("id")
          .range(from, to),
      );
    },
  });
}

/**
 * The dated rasts in one week — one row per class per break.
 *
 * Its own table rather than a band computed in the client, for the two reasons
 * the migration gives: a lov makes a Monday differ from the declaration, and an
 * admin editing a rast in March must not rewrite February. Scoped by RLS to the
 * reader's own class, their children's, or the whole school for staff; the
 * caller filters as well, because a guardian legitimately has more than one
 * class in reach.
 */
/**
 * The dated meals in one week.
 *
 * Its own table rather than a lesson, which is what makes it safe to read here
 * at all: everything downstream of CalendarLessons assumes teaching, and a meal
 * in that table would be exported to the kommun as undervisning and would tell
 * a guardian their child was absent from "Lunch".
 *
 * This docblock used to say "a pupil's own, by RLS", and it was false for as
 * long as it stood: calendar_lunches_member_select matched the whole school.
 * It is true now — see calendar_lunches_student_select in
 * 20260904090000_en_lunch_hor_till_en_klass — and the caller filters anyway.
 * A staff account and a guardian both legitimately read more than one class
 * here, so who is asking decides what is shown, not the policy alone.
 */
export function useCalendarRasts(fromDate: string, toDate: string) {
  return useQuery({
    queryKey: ["calendar-rasts", fromDate, toDate],
    queryFn: async () => {
      const supabase = createClient();
      return fetchAllPages<CalendarRast>((from, to) =>
        supabase
          .from("CalendarRasts")
          .select("id, studentGroupId, name, date, startsAt, endsAt")
          .gte("date", fromDate)
          .lte("date", toDate)
          .order("date")
          .order("startsAt")
          .range(from, to),
      );
    },
  });
}

export function useCalendarLunches(fromDate: string, toDate: string) {
  return useQuery({
    queryKey: ["calendar-lunches", fromDate, toDate],
    queryFn: async () => {
      const supabase = createClient();
      return fetchAllPages<CalendarLunch>((from, to) =>
        supabase
          .from("CalendarLunches")
          .select("id, studentGroupId, date, startsAt, endsAt")
          .gte("date", fromDate)
          .lte("date", toDate)
          .order("date")
          .order("id")
          .range(from, to),
      );
    },
  });
}

/**
 * The läsår's lov och studiedagar, earliest first.
 *
 * Keyed on the year like ["requirements", yearId], and disabled until one is
 * picked, because a break only means anything inside its own läsår — the same
 * argument the timplan makes for its year picker. A caller that measured next
 * autumn's hours against this autumn's lov would be quietly wrong.
 *
 * NOT paged, unlike its neighbours, and that is a statement about the table
 * rather than an oversight: a Swedish läsår has höstlov, jullov, sportlov,
 * påsklov, a few röda dagar and a handful of studiedagar. Twenty rows, not a
 * thousand. `fetchAllPages` exists for the tables that really do exceed
 * PostgREST's cap (memberships, the timplan), and wrapping this one in it would
 * suggest a volume that cannot happen here.
 *
 * Ordered by startDate because a lov list is read as a calendar — the same
 * order the API's own `list` returns, so the two doors agree.
 */
export function useSchoolBreaks(academicYearId: string | null) {
  return useQuery({
    queryKey: ["schoolBreaks", academicYearId],
    enabled: academicYearId !== null,
    queryFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("SchoolBreaks")
        .select(
          "id, academicYearId, name, kind, startDate, endDate, minGradeLevel, maxGradeLevel",
        )
        .eq("academicYearId", academicYearId!)
        .order("startDate")
        // Two lov may start on the same day (a studiedag inside a longer
        // break), and rows tying on the sort column are free to shuffle between
        // requests — which makes the list jump about as it refetches.
        .order("id");
      if (error) throw new Error(error.message);
      return (data ?? []) as SchoolBreak[];
    },
  });
}

/**
 * Writes to a break, typed on what the write ANSWERS.
 *
 * `useCrudMutations` would have done the three calls, and it types its result
 * `unknown` — which is exactly the field that must not be lost here. Creating
 * or moving a lov DELETES published calendar lessons, and the endpoint answers
 * with how many; a hook that throws the number away leaves the UI unable to say
 * what it just did, which is the one thing this feature exists to do.
 *
 * The schedule caches are invalidated alongside the break list for the same
 * reason: rows were deleted, and a calendar left holding them shows lessons the
 * database no longer has.
 */
export interface SchoolBreakInput {
  academicYearId: string;
  name: string;
  kind: BreakKind;
  startDate: string;
  endDate: string;
  /** Both null is the whole school; the API refuses one without the other. */
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
}

export interface SchoolBreakWriteResult extends SchoolBreak {
  /** Published, still-scheduled, register-free lessons the break threw away. */
  removedCalendarLessons: number;
}

export function useSchoolBreakActions() {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["schoolBreaks"] });
    void queryClient.invalidateQueries({ queryKey: ["calendarLessons"] });
    void queryClient.invalidateQueries({ queryKey: ["dayLessons"] });
    void queryClient.invalidateQueries({ queryKey: ["teacherLessons"] });
  };

  return {
    create: useMutation({
      mutationFn: (input: SchoolBreakInput) =>
        api.post<SchoolBreakWriteResult>("/api/v1/school-breaks", input),
      onSuccess: invalidate,
    }),
    update: useMutation({
      // No academicYearId: moving a lov to another läsår is not an edit, it is
      // a different lov, and the DTO leaves the field out for that reason.
      mutationFn: ({ id, ...input }: Omit<SchoolBreakInput, "academicYearId"> & { id: string }) =>
        api.patch<SchoolBreakWriteResult>(`/api/v1/school-breaks/${id}`, input),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api.delete(`/api/v1/school-breaks/${id}`),
      onSuccess: invalidate,
    }),
  };
}

/**
 * The school's lunch rules. One row, so one value — null until somebody defines
 * it, which is a different fact from "defined and switched off" and the reason
 * the publish warning can tell them apart.
 *
 * Read through the API rather than Supabase: the row is admin-only, and the
 * validation that keeps a window on the solver's quarter-hour grid lives on the
 * same endpoint that writes it.
 */
export function useLunchSettings() {
  return useQuery({
    queryKey: ["lunchSettings"],
    queryFn: async () =>
      (await api.get<LunchSettings | null>("/api/v1/lunch-settings")) ?? null,
  });
}

export interface LunchSettingsInput {
  lunchEnabled: boolean;
  /** HH:MM as the form holds it; the API accepts both HH:MM and HH:MM:SS. */
  lunchStartTime: string;
  lunchEndTime: string;
  lunchMinutes: number;
  diningSeats: number | null;
  maxLessonsPerDayPerGroup: number | null;
}

export function useSaveLunchSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: LunchSettingsInput) =>
      api.put<LunchSettings>("/api/v1/lunch-settings", input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["lunchSettings"] });
    },
  });
}

export function useMasterLessons(academicYearId: string | null) {
  return useQuery({
    queryKey: ["masterLessons", academicYearId],
    enabled: academicYearId !== null,
    queryFn: async () => {
      const supabase = createClient();
      // The base timetable itself. A partial answer here is the worst kind:
      // the grid renders, looks complete, and quietly omits lessons — which
      // then get "rescheduled" on top of slots that were never free.
      const rows = await fetchAllPages<
        Omit<MasterLesson, "extraGroupIds" | "studentIds"> & {
          extraGroups: Array<{ studentGroupId: string }>;
          participants: Array<{ studentId: string }>;
        }
      >((from, to) =>
        supabase
          .from("MasterLessons")
          .select(
            "id, academicYearId, subjectId, studentGroupId, teacherId, coTeacherId, roomId, dayOfWeek, startTime, endTime, isLocked, isParked, recurrence, startDate, endDate, extraGroups:MasterLessonGroups(studentGroupId), participants:MasterLessonStudents(studentId)",
          )
          .eq("academicYearId", academicYearId!)
          .order("dayOfWeek")
          .order("startTime")
          .order("id")
          .range(from, to),
      );
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

      // A teaching group (Ma71) has no home-class members at all — its roster
      // lives in StudentGroupMembers. Fetch those for every involved group so
      // the id-filter below picks them up alongside individual participants.
      const membershipRes = await supabase
        .from("StudentGroupMembers")
        .select("studentId")
        .in("studentGroupId", groupIds);
      if (membershipRes.error) throw new Error(membershipRes.error.message);

      const studentIds = [
        ...new Set([
          ...(participantsRes.data ?? []).map(
            (row) => (row as { studentId: string }).studentId,
          ),
          ...(membershipRes.data ?? []).map(
            (row) => (row as { studentId: string }).studentId,
          ),
        ]),
      ];

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
      // The list a teacher ticks down, lesson by lesson. Out of Swedish order
      // it is worse than unsorted: the teacher scans for Åkesson where the
      // A-names are and does not find her.
      return sortByPersonName((data ?? []) as Person[]);
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
  /**
   * The second teacher of a co-taught lesson.
   *
   * Missing here and from the server's create DTO until now, so a co-taught
   * lesson lost its second teacher the moment a delete was undone — on both the
   * single and the bulk path. The solver writes the column directly and never
   * went through this type, which is why nothing noticed.
   */
  coTeacherId?: string | null;
  roomId?: string | null;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  isLocked?: boolean;
  /** Which weeks the lesson runs; omitted means every week. */
  recurrence?: LessonRecurrence;
  startDate?: string | null;
  endDate?: string | null;
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
      // removedCalendarLessons: narrowing a lesson's weeks or its date window
      // takes the future calendar rows the new window no longer covers. The
      // admin has to be told — it is the one part of an edit that a widening
      // edit does not put back on its own.
      api.patch<
        MasterLessonResponse & {
          propagatedLessons: number;
          removedCalendarLessons: number;
        }
      >(
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
    void queryClient.invalidateQueries({ queryKey: ["teacherAbsenceLessons"] });
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
  const changeRoom = useMutation({
    mutationFn: ({ id, roomId, note }: { id: string; roomId: string | null; note?: string }) =>
      api.patch(`/api/v1/calendar-lessons/${id}/room-change`, {
        roomId,
        ...(note ? { note } : {}),
      }),
    onSuccess: invalidate,
  });

  return { cancel, reinstate, substitute, changeRoom };
}

export interface SubstituteSuggestion {
  teacherId: string;
  isPrimary: boolean;
}

/** Qualified, currently-free teachers who can cover a lesson (server-ranked). */
export function useSubstituteSuggestions(lessonId: string | null) {
  return useQuery({
    queryKey: ["substituteSuggestions", lessonId],
    enabled: lessonId !== null,
    queryFn: () =>
      api.get<SubstituteSuggestion[]>(
        `/api/v1/calendar-lessons/${lessonId}/substitute-suggestions`,
      ),
  });
}

/**
 * Scheduled lessons taught by one teacher over a date range — the affected
 * lessons a school admin needs to cover when a teacher is out. Direct Supabase
 * read under RLS (admins see all school lessons); the inner join restricts to
 * lessons where this teacher is assigned.
 */
export function useTeacherAbsenceLessons(
  teacherId: string | null,
  from: string,
  to: string,
) {
  return useQuery({
    queryKey: ["teacherAbsenceLessons", teacherId, from, to],
    enabled: teacherId !== null,
    queryFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("CalendarLessons")
        .select(
          "id, subjectId, studentGroupId, roomId, date, startsAt, endsAt, status, note, teachers:CalendarLessonTeachers!inner(role, teacherId)",
        )
        .gte("date", from)
        .lte("date", to)
        .eq("status", "SCHEDULED")
        .eq("teachers.teacherId", teacherId!)
        .order("startsAt");
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as DayLessonRow[];
    },
  });
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

// ---------------------------------------------------------------------------
// Room bookings (Skola24 Lokal parity)
// ---------------------------------------------------------------------------

/**
 * Room bookings overlapping a date range. Direct Supabase read under RLS:
 * teachers see their own + all school bookings; admins see everything.
 * `status` filters the set (e.g. the admin approval inbox).
 */
export function useRoomBookings(
  fromDate: string,
  toDate: string,
  status?: RoomBookingStatus,
) {
  return useQuery({
    queryKey: ["roomBookings", fromDate, toDate, status ?? null],
    queryFn: async () => {
      const supabase = createClient();
      let query = supabase
        .from("RoomBookings")
        .select(
          "id, roomId, bookedById, title, startsAt, endsAt, status, decidedById, decidedAt, decisionNote, createdAt",
        )
        // Bookings that overlap [from, to): start before the range end AND end
        // after the range start (dates are day-granular here).
        .lt("startsAt", `${toDate}T23:59:59.999Z`)
        .gt("endsAt", `${fromDate}T00:00:00.000Z`)
        .order("startsAt");
      if (status) query = query.eq("status", status);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return (data ?? []) as RoomBooking[];
    },
  });
}

/** Admin approval inbox: all school bookings by status (most recent first). */
export function useRoomBookingRequests(status?: RoomBookingStatus) {
  return useQuery({
    queryKey: ["roomBookings", "inbox", status ?? null],
    queryFn: async () => {
      const supabase = createClient();
      let query = supabase
        .from("RoomBookings")
        .select(
          "id, roomId, bookedById, title, startsAt, endsAt, status, decidedById, decidedAt, decisionNote, createdAt",
        )
        .order("createdAt", { ascending: false })
        .limit(200);
      if (status) query = query.eq("status", status);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return (data ?? []) as RoomBooking[];
    },
  });
}

/** The signed-in user's own room bookings (upcoming first). */
export function useMyRoomBookings(userId: string) {
  return useQuery({
    queryKey: ["myRoomBookings", userId],
    queryFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("RoomBookings")
        .select(
          "id, roomId, bookedById, title, startsAt, endsAt, status, decidedById, decidedAt, decisionNote, createdAt",
        )
        .eq("bookedById", userId)
        .order("startsAt", { ascending: false })
        .limit(100);
      if (error) throw new Error(error.message);
      return (data ?? []) as RoomBooking[];
    },
  });
}

export function useRoomBookingActions() {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["roomBookings"] });
    void queryClient.invalidateQueries({ queryKey: ["myRoomBookings"] });
  };

  const book = useMutation({
    mutationFn: (body: {
      roomId: string;
      title: string;
      startsAt: string;
      endsAt: string;
    }) => api.post("/api/v1/room-bookings", body),
    onSuccess: invalidate,
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api.patch(`/api/v1/room-bookings/${id}/cancel`, {}),
    onSuccess: invalidate,
  });
  const decide = useMutation({
    mutationFn: ({
      id,
      status,
      note,
    }: {
      id: string;
      status: "APPROVED" | "REJECTED";
      note?: string;
    }) =>
      api.patch(`/api/v1/room-bookings/${id}/decide`, {
        status,
        ...(note ? { note } : {}),
      }),
    onSuccess: invalidate,
  });

  return { book, cancel, decide };
}

export interface GroupMembershipRow {
  studentId: string;
  studentGroupId: string;
}

/** Every teaching-group membership in the school (RLS-scoped). */
/**
 * Every teaching-group membership in the school.
 *
 * Paged, because this is the table that actually exceeds a thousand rows: it
 * holds one row per student per group, so an ordinary secondary school passes
 * the cap several times over.
 */
export function useGroupMemberships() {
  return useQuery({
    queryKey: ["groupMemberships"],
    queryFn: () =>
      selectAll<GroupMembershipRow>(
        "StudentGroupMembers",
        "studentId, studentGroupId",
        "studentGroupId",
      ),
  });
}

export interface GroupMember {
  id: string;
  firstName: string;
  lastName: string;
  homeGroupId: string | null;
}

export function useGroupMembers(groupId: string | null) {
  return useQuery({
    queryKey: ["groupMembers", groupId],
    enabled: groupId !== null,
    queryFn: () => api.get<GroupMember[]>(`/api/v1/student-groups/${groupId}/members`),
  });
}

export function useSetGroupMembers() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, studentIds }: { groupId: string; studentIds: string[] }) =>
      api.put<{ count: number }>(`/api/v1/student-groups/${groupId}/members`, {
        studentIds,
      }),
    onSuccess: (_data, { groupId }) => {
      void queryClient.invalidateQueries({ queryKey: ["groupMembers", groupId] });
      void queryClient.invalidateQueries({ queryKey: ["groupMemberships"] });
      void queryClient.invalidateQueries({ queryKey: ["groups"] });
      void queryClient.invalidateQueries({ queryKey: ["lessonRoster"] });
    },
  });
}

// ---------------------------------------------------------------------------
// CSV import — browser-parsed rows (web/lib/csv.ts) posted to the typed
// import endpoints (src/import). ESM hoists this import; it lives down here
// so the section stays a pure append.
// ---------------------------------------------------------------------------

import type { ImportKind } from "@/lib/csv";

/** Mirror of the API's ImportReport (src/import/dto/import.dto.ts). */
export interface ImportReport {
  created: number;
  skipped: number;
  /**
   * Rows that matched something already there and were WRITTEN OVER.
   *
   * Optional, and deliberately so: the six older kinds are create-or-skip and
   * never touch an existing row, so they answer without this field and the
   * result view they render must stay exactly what it was. Only the timplan
   * import updates, because a timplan is a document a school iterates on —
   * see IMPORT_UPDATES_ROWS below.
   */
  updated?: number;
  /** 1-based DATA row numbers (the header row is not counted). */
  errors: { row: number; message: string }[];
}

const IMPORT_ENDPOINTS: Record<ImportKind, string> = {
  subjects: "/api/v1/import/subjects",
  students: "/api/v1/import/students",
  teachers: "/api/v1/import/teachers",
  classes: "/api/v1/import/groups",
  teachingGroups: "/api/v1/import/group-members",
  roomTypes: "/api/v1/import/room-types",
  requirements: "/api/v1/import/requirements",
};

/** Kinds whose payload carries the academic year the rows belong to. */
export const IMPORT_NEEDS_YEAR: Record<ImportKind, boolean> = {
  // Subjects belong to the school, like room types — not to a läsår.
  subjects: false,
  students: true,
  teachers: false,
  classes: true,
  teachingGroups: true,
  // Room types belong to the school, not to a läsår — the same slöjdsal
  // exists across every year.
  roomTypes: false,
  // A timplan is written for one läsår and only means anything inside it: the
  // same 7A reads three NO one year and two the next. The year comes from the
  // dialog, like teachingGroups — never from a column in the file, where it
  // would let one upload scatter rows across several years.
  requirements: true,
};

/** Result of inviting one person. */
export interface InvitationResult {
  id: string;
  /** False when the address already had an account — no mail was sent. */
  emailSent: boolean;
}

/** Result of inviting a selection. */
export interface BulkInvitationReport {
  sent: number;
  alreadyRegistered: number;
  errors: { userId: string; message: string }[];
}

/**
 * Sending invitations is deliberately separate from creating people: a school
 * builds its roster long before term starts, and adding somebody to the
 * catalog must not put mail in their inbox.
 */
export function useInvitations() {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["people"] });
  };

  return {
    inviteOne: useMutation({
      mutationFn: (userId: string) =>
        api.post<InvitationResult>(`/api/v1/users/${userId}/invite`, {}),
      onSuccess: invalidate,
    }),
    inviteMany: useMutation({
      mutationFn: (userIds: string[]) =>
        api.post<BulkInvitationReport>("/api/v1/users/invitations", { userIds }),
      onSuccess: invalidate,
    }),
  };
}

/**
 * WISH pays a price per lesson placed elsewhere; LOCK forbids everywhere else.
 *
 * One table, two kinds, because they differ in one field — and two lists on
 * screen, because they compose differently and a school must not state a wish
 * believing it is a promise.
 */
export type RoomRuleKind = "WISH" | "LOCK";

export interface RoomPreference {
  id: string;
  subjectId: string;
  kind: RoomRuleKind;
  /** Both null means every year. Matched by containment, not overlap. */
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
  roomTypeId: string | null;
  weight: number;
  rooms: { roomId: string }[];
}

export interface RoomPreferenceInput {
  subjectId: string;
  kind?: RoomRuleKind;
  minGradeLevel?: number | null;
  maxGradeLevel?: number | null;
  roomTypeId?: string | null;
  roomIds?: string[];
  weight?: number;
}

/**
 * Soft room wishes — "NO helst i labbet".
 *
 * Read through the API rather than straight from Supabase like the other
 * lists: the rule spans two tables, and the join belongs on the server rather
 * than in every page that wants to show it.
 */
export function useRoomPreferences() {
  return useQuery({
    queryKey: ["roomPreferences"],
    queryFn: () => api.get<RoomPreference[]>("/api/v1/room-preferences"),
  });
}

export function useRoomPreferenceActions() {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["roomPreferences"] });
  };

  return {
    create: useMutation({
      mutationFn: (input: RoomPreferenceInput) =>
        api.post<RoomPreference>("/api/v1/room-preferences", input),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: ({ id, ...input }: RoomPreferenceInput & { id: string }) =>
        api.patch<RoomPreference>(`/api/v1/room-preferences/${id}`, input),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api.delete(`/api/v1/room-preferences/${id}`),
      onSuccess: invalidate,
    }),
  };
}

export interface ImportCsvInput {
  kind: ImportKind;
  /** Required where IMPORT_NEEDS_YEAR says so; stripped everywhere else. */
  academicYearId?: string;
  /** Typed rows from the map*Rows helpers in web/lib/csv.ts. */
  rows: Array<Record<string, unknown>>;
  /**
   * Which columns the FILE had, for a kind that updates rather than skips.
   *
   * The rows themselves cannot carry it. They omit a key whose column was
   * absent, but the API's ValidationPipe runs class-transformer, which
   * materialises every declared property — so the omission is gone by the time
   * the service reads the row, and an absent column looks exactly like a cell
   * the school cleared on purpose. For an import that overwrites, those two
   * mean opposite things, and getting it wrong empties a field across a whole
   * läsår without a single error in the report.
   *
   * Travels with every batch, because each batch is validated on its own.
   */
  columns?: string[];
}

/**
 * One mutation for every import kind: the kind picks the endpoint and the body
 * shape (IMPORT_NEEDS_YEAR decides whether the läsår travels with it). Every
 * reader an import can affect is refreshed — people (students/teachers),
 * groups (classes and on-the-fly teaching groups), both membership views, and
 * the timplan.
 */
/**
 * Rows the API accepts in one request, per kind — the @ArrayMaxSize on each
 * import DTO. A school's real file routinely exceeds these (5400 teaching-group
 * memberships is an ordinary secondary school), so uploads are split here
 * rather than refused: the caps exist to bound one request, not to cap what a
 * school may import.
 */
export const IMPORT_MAX_ROWS: Record<ImportKind, number> = {
  subjects: 500,
  students: 500,
  teachers: 500,
  classes: 500,
  teachingGroups: 2000,
  roomTypes: 200,
  // A full timplan is groups × subjects: forty groups and fifteen subjects is
  // 600 rows before anyone has done anything unusual, so this cap is reached by
  // an ordinary school and the batching above is what carries it. 1000 rather
  // than the 500 people get, because a requirement row is nine short fields and
  // an ordinary school's whole timplan then fits in one request instead of two.
  //
  // The number is ImportRequirementsDto's `@ArrayMaxSize`, and every entry in
  // this map is its DTO's. import-batching.test.ts asserts the whole map
  // against a literal, which catches a cap CHANGED here without a thought — it
  // does not read the DTO, so it cannot catch the two drifting apart if the
  // server side moves. Keeping them equal is a discipline, not something the
  // suite enforces: a client value below the DTO's still works, which is
  // exactly why the drift is easy to miss.
  requirements: 1000,
};

/**
 * Kinds whose import WRITES OVER a row that is already there.
 *
 * The timplan is the only one, and it is not an oversight in the other six: a
 * timplan is a document a school iterates on — export it, change two numbers
 * in Excel, upload it again — and a create-only import would have made that
 * round trip do nothing at all, every row skipped as "already exists".
 *
 * What it does NOT do is delete. A row removed from the file stays in the
 * timplan, because the file is an addendum and not the truth: an admin who
 * uploads a spreadsheet holding only årskurs 7 has not said the rest of the
 * school teaches nothing. That is a surprise if you assume otherwise, so the
 * dialog says it in words before the upload rather than leaving it here.
 */
export const IMPORT_UPDATES_ROWS: Record<ImportKind, boolean> = {
  subjects: false,
  students: false,
  teachers: false,
  classes: false,
  teachingGroups: false,
  roomTypes: false,
  requirements: true,
};

/**
 * Uploads `rows` in sequential batches and merges the reports into one.
 *
 * Sequential, not parallel: people imports send one invitation per created row
 * and the endpoint is rate-limited, so overlapping batches would trade a
 * working import for a 429.
 *
 * A failing batch does not discard the ones before it. Every import is
 * row-wise idempotent — re-uploading the same file skips what already
 * exists — so reporting the partial result and what stopped it lets the admin
 * simply upload the file again, rather than wondering which half landed.
 *
 * If the FIRST batch fails there is no partial result to preserve, and the
 * error is rethrown: a small file that failed outright is a failure, not a
 * report saying nothing was imported.
 */
export async function importCsvInBatches({
  kind,
  academicYearId,
  rows,
  columns,
}: ImportCsvInput): Promise<ImportReport> {
  const size = IMPORT_MAX_ROWS[kind];
  const merged: ImportReport = { created: 0, skipped: 0, errors: [] };

  for (let offset = 0; offset < rows.length; offset += size) {
    const batch = rows.slice(offset, offset + size);
    try {
      const report = await api.post<ImportReport>(
        IMPORT_ENDPOINTS[kind],
        {
          ...(IMPORT_NEEDS_YEAR[kind] ? { academicYearId } : {}),
          ...(columns ? { columns } : {}),
          rows: batch,
        },
      );
      // Tolerant of a sparse body: a proxy or an older API build may answer
      // without every field, and losing the whole import over a missing
      // counter would be a worse failure than an under-reported one.
      merged.created += report?.created ?? 0;
      merged.skipped += report?.skipped ?? 0;
      // Only summed when the answer actually carried it, so the field stays
      // absent for the six create-only kinds and their result view is
      // untouched. `(merged.updated ?? 0) + …` unconditionally would have put
      // a 0 on every import there is, and "0 uppdaterade" on a student upload
      // is a sentence about a thing that cannot happen.
      if (typeof report?.updated === "number") {
        merged.updated = (merged.updated ?? 0) + report.updated;
      }
      // Row numbers come back 1-based within the batch; shift them so they
      // point at the line the admin actually has to fix in their file.
      for (const error of report?.errors ?? []) {
        merged.errors.push({ ...error, row: error.row + offset });
      }
    } catch (error) {
      if (offset === 0) throw error;
      merged.errors.push({
        row: offset + 1,
        message:
          error instanceof Error
            ? error.message
            : "Importen avbröts. Ladda upp filen igen — rader som redan lagts in hoppas över.",
      });
      break;
    }
  }

  return merged;
}

export function useImportCsv() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: importCsvInBatches,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["people"] });
      void queryClient.invalidateQueries({ queryKey: ["groups"] });
      void queryClient.invalidateQueries({ queryKey: ["groupMemberships"] });
      void queryClient.invalidateQueries({ queryKey: ["groupMembers"] });
      // Prefix match, so every year's timplan is refetched and not just the
      // one the dialog was opened from — ["requirements", yearId] is the key,
      // and an import that landed on the active year while the matrix showed
      // next autumn would otherwise leave the stale one on screen.
      void queryClient.invalidateQueries({ queryKey: ["requirements"] });
    },
  });
}
