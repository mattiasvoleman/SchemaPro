import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { api } from "@/lib/api";
import {
  useAbsenceReportActions,
  useAbsenceReports,
  useActiveYear,
  useCreateMasterLesson,
  useCrudMutations,
  useDeleteMasterLesson,
  useGuardianLinkActions,
  useImportCsv,
  useLeaveRequestActions,
  useLessonActions,
  useGroupMembers,
  useGroupMemberships,
  useLessonRoster,
  useMasterLessons,
  useMyChildren,
  useOptimizationHistory,
  useOptimizationJob,
  usePublishSchedule,
  useReportAttendance,
  useRequirements,
  useRoomBookingActions,
  useRoomBookingRequests,
  useRoomBookings,
  useScheduleVersionActions,
  useScheduleVersionDetail,
  useScheduleVersions,
  useSetGroupMembers,
  useStartOptimization,
  useInvitations,
  useSubjects,
  useSubstituteSuggestions,
  useTeacherLessons,
  useUpdateMasterLesson,
  type ImportReport,
  type OptimizationJob,
} from "./queries";

// ---------------------------------------------------------------------------
// Module mocks. Reads go through the Supabase browser client, mutations through
// the NestJS gateway wrapper — both are mocked at the module boundary so no
// test ever touches the network.
// ---------------------------------------------------------------------------

const supabaseMocks = vi.hoisted(() => ({ from: vi.fn() }));

vi.mock("@/utils/supabase/client", () => ({
  createClient: () => ({ from: supabaseMocks.from }),
}));

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const mockApi = api as unknown as Record<
  "get" | "post" | "put" | "patch" | "delete",
  Mock
>;

// ---------------------------------------------------------------------------
// A chainable, awaitable stand-in for the PostgREST query builder. Every
// filter/modifier call is recorded (so tests can pin the filter contract) and
// awaiting the chain resolves to the next stubbed result for that table.
// ---------------------------------------------------------------------------

interface SupabaseResult {
  data: unknown;
  error: { message: string } | null;
}

const tableResults = new Map<string, SupabaseResult[]>();
const queryLog: Array<{ table: string; method: string; args: unknown[] }> = [];

const ok = (rows: unknown): SupabaseResult => ({ data: rows, error: null });
const dbError = (message: string): SupabaseResult => ({ data: null, error: { message } });

function stubTable(table: string, ...results: SupabaseResult[]) {
  tableResults.set(table, [...(tableResults.get(table) ?? []), ...results]);
}

function makeBuilder(table: string) {
  const queue = tableResults.get(table);
  const result: SupabaseResult =
    queue && queue.length > 0 ? queue.shift()! : { data: [], error: null };
  const builder: Record<string, unknown> = {};
  for (const method of [
    "select",
    "order",
    "eq",
    "neq",
    "gte",
    "lte",
    "gt",
    "lt",
    "or",
    "in",
    "limit",
    "single",
  ]) {
    builder[method] = (...args: unknown[]) => {
      queryLog.push({ table, method, args });
      return builder;
    };
  }
  builder.then = (
    onFulfilled: (value: SupabaseResult) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(onFulfilled, onRejected);
  return builder;
}

const argsFor = (table: string, method: string) =>
  queryLog.filter((entry) => entry.table === table && entry.method === method)
    .map((entry) => entry.args);

// ---------------------------------------------------------------------------
// Per-test harness: fresh QueryClient (retry off) plus an invalidation spy so
// each mutation's invalidation contract can be asserted exactly.
// ---------------------------------------------------------------------------

function createHarness() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, invalidateSpy, wrapper };
}

type Harness = ReturnType<typeof createHarness>;

const invalidatedKeys = (harness: Harness) =>
  harness.invalidateSpy.mock.calls.map((call) => call[0]?.queryKey);

beforeEach(() => {
  vi.resetAllMocks();
  supabaseMocks.from.mockImplementation((table: string) => makeBuilder(table));
  mockApi.get.mockResolvedValue({});
  mockApi.post.mockResolvedValue({});
  mockApi.patch.mockResolvedValue({});
  mockApi.delete.mockResolvedValue({});
  tableResults.clear();
  queryLog.length = 0;
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe("useSubjects", () => {
  const rows = [
    { id: "sub-1", name: "Biology", code: "BI", color: null, requiredRoomTypeId: "rt-lab" },
    { id: "sub-2", name: "Maths", code: "MA", color: "#123456", requiredRoomTypeId: null },
  ];

  it("stores the rows under the ['subjects'] key with the documented column set", async () => {
    stubTable("Subjects", ok(rows));
    const { queryClient, wrapper } = createHarness();
    const { result } = renderHook(() => useSubjects(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(rows);
    expect(queryClient.getQueryData(["subjects"])).toEqual(rows);
    expect(supabaseMocks.from).toHaveBeenCalledWith("Subjects");
    expect(argsFor("Subjects", "select")).toEqual([
      ["id, name, code, color, requiredRoomTypeId"],
    ]);
    expect(argsFor("Subjects", "order")).toEqual([["name"]]);
  });

  it("surfaces a Supabase error as the query error", async () => {
    stubTable("Subjects", dbError("permission denied for table Subjects"));
    const { wrapper } = createHarness();
    const { result } = renderHook(() => useSubjects(), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("permission denied for table Subjects");
    expect(result.current.data).toBeUndefined();
  });
});

describe("useActiveYear", () => {
  const years = [
    { id: "y-old", name: "24/25", startDate: "2024-08-15", endDate: "2025-06-12", isActive: false },
    { id: "y-new", name: "25/26", startDate: "2025-08-15", endDate: "2026-06-12", isActive: true },
  ];

  it("exposes the active year from the academicYears query", async () => {
    stubTable("AcademicYears", ok(years));
    const { wrapper } = createHarness();
    const { result } = renderHook(() => useActiveYear(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.activeYear).toEqual(years[1]);
  });

  it("is null when no year is flagged active", async () => {
    stubTable("AcademicYears", ok([years[0]]));
    const { wrapper } = createHarness();
    const { result } = renderHook(() => useActiveYear(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.activeYear).toBeNull();
  });
});

describe("useRequirements", () => {
  const rows = [
    {
      id: "req-1",
      academicYearId: "y-1",
      subjectId: "sub-1",
      studentGroupId: "g-1",
      teacherId: "t-1",
      coTeacherId: null,
      lessonsPerWeek: 3,
      minutesPerLesson: 45,
    },
  ];

  it("stays idle while the academic year is unknown, then fetches on rerender", async () => {
    stubTable("TeachingRequirements", ok(rows));
    const { queryClient, wrapper } = createHarness();
    const { result, rerender } = renderHook(
      ({ yearId }: { yearId: string | null }) => useRequirements(yearId),
      { wrapper, initialProps: { yearId: null as string | null } },
    );

    expect(result.current.fetchStatus).toBe("idle");
    expect(supabaseMocks.from).not.toHaveBeenCalled();

    rerender({ yearId: "y-1" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(argsFor("TeachingRequirements", "eq")).toEqual([["academicYearId", "y-1"]]);
    expect(queryClient.getQueryData(["requirements", "y-1"])).toEqual(rows);
  });
});

describe("useMasterLessons", () => {
  it("flattens joined extraGroups/participants into id arrays", async () => {
    stubTable(
      "MasterLessons",
      ok([
        {
          id: "ml-1",
          academicYearId: "y-1",
          subjectId: "sub-1",
          studentGroupId: "g-1",
          teacherId: "t-1",
          coTeacherId: null,
          roomId: "r-1",
          dayOfWeek: 1,
          startTime: "08:00:00",
          endTime: "08:45:00",
          isLocked: false,
          extraGroups: [{ studentGroupId: "g-2" }, { studentGroupId: "g-3" }],
          participants: [{ studentId: "st-9" }],
        },
      ]),
    );
    const { queryClient, wrapper } = createHarness();
    const { result } = renderHook(() => useMasterLessons("y-1"), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const lesson = result.current.data![0];
    expect(lesson.extraGroupIds).toEqual(["g-2", "g-3"]);
    expect(lesson.studentIds).toEqual(["st-9"]);
    expect(lesson).not.toHaveProperty("extraGroups");
    expect(lesson).not.toHaveProperty("participants");
    expect(queryClient.getQueryData(["masterLessons", "y-1"])).toEqual(result.current.data);
  });

  it("does not query until an academic year is selected", () => {
    const { wrapper } = createHarness();
    const { result } = renderHook(() => useMasterLessons(null), { wrapper });
    expect(result.current.fetchStatus).toBe("idle");
    expect(supabaseMocks.from).not.toHaveBeenCalled();
  });
});

describe("useTeacherLessons", () => {
  it("flattens assignment rows and sorts them by start time", async () => {
    const early = {
      id: "cl-1",
      subjectId: "sub-1",
      studentGroupId: "g-1",
      roomId: "r-1",
      date: "2026-08-10",
      startsAt: "2026-08-10T08:00:00.000Z",
      endsAt: "2026-08-10T08:45:00.000Z",
      status: "SCHEDULED",
      note: null,
    };
    const late = { ...early, id: "cl-2", startsAt: "2026-08-10T10:00:00.000Z" };
    stubTable(
      "CalendarLessonTeachers",
      ok([
        { role: "PRIMARY", lesson: late },
        { role: "SUBSTITUTE", lesson: early },
      ]),
    );
    const { queryClient, wrapper } = createHarness();
    const { result } = renderHook(
      () => useTeacherLessons("t-1", "2026-08-10", "2026-08-14"),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([
      { ...early, assignmentRole: "SUBSTITUTE" },
      { ...late, assignmentRole: "PRIMARY" },
    ]);
    // The date window filters the joined lesson, not the assignment row.
    expect(argsFor("CalendarLessonTeachers", "gte")).toEqual([["lesson.date", "2026-08-10"]]);
    expect(argsFor("CalendarLessonTeachers", "lte")).toEqual([["lesson.date", "2026-08-14"]]);
    expect(
      queryClient.getQueryData(["teacherLessons", "t-1", "2026-08-10", "2026-08-14"]),
    ).toEqual(result.current.data);
  });
});

describe("useLessonRoster", () => {
  const students = [
    {
      id: "st-1",
      role: "STUDENT",
      firstName: "Alma",
      lastName: "Berg",
      email: "alma@example.com",
      phone: null,
      isActive: true,
      studentGroupId: "g-1",
    },
  ];

  it("queries students of the primary class, extra classes, teaching-group members and named participants", async () => {
    stubTable("CalendarLessonGroups", ok([{ studentGroupId: "g-2" }]));
    stubTable("CalendarLessonStudents", ok([{ studentId: "st-5" }]));
    // Teaching-group roster: Ma71-style lessons have their students HERE, not
    // in Users.studentGroupId — the fix this test pins.
    stubTable("StudentGroupMembers", ok([{ studentId: "st-9" }]));
    stubTable("Users", ok(students));
    const { wrapper } = createHarness();
    const { result } = renderHook(() => useLessonRoster("cl-1", "g-1"), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(students);
    expect(argsFor("Users", "or")).toEqual([
      ["studentGroupId.in.(g-1,g-2),id.in.(st-5,st-9)"],
    ]);
    expect(argsFor("StudentGroupMembers", "in")).toEqual([
      ["studentGroupId", ["g-1", "g-2"]],
    ]);
    expect(argsFor("Users", "eq")).toEqual([
      ["role", "STUDENT"],
      ["isActive", true],
    ]);
  });

  it("deduplicates a student who is both a participant and a group member", async () => {
    stubTable("CalendarLessonGroups", ok([]));
    stubTable("CalendarLessonStudents", ok([{ studentId: "st-5" }]));
    stubTable("StudentGroupMembers", ok([{ studentId: "st-5" }]));
    stubTable("Users", ok(students));
    const { wrapper } = createHarness();
    const { result } = renderHook(() => useLessonRoster("cl-1", "g-1"), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(argsFor("Users", "or")).toEqual([
      ["studentGroupId.in.(g-1),id.in.(st-5)"],
    ]);
  });

  it("omits the participant filter when no individual students are attached", async () => {
    stubTable("CalendarLessonGroups", ok([]));
    stubTable("CalendarLessonStudents", ok([]));
    stubTable("StudentGroupMembers", ok([]));
    stubTable("Users", ok(students));
    const { wrapper } = createHarness();
    const { result } = renderHook(() => useLessonRoster("cl-1", "g-1"), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(argsFor("Users", "or")).toEqual([["studentGroupId.in.(g-1)"]]);
  });

  it("requires both the lesson and its primary class before fetching", () => {
    const { wrapper } = createHarness();
    const { result } = renderHook(() => useLessonRoster("cl-1", null), { wrapper });
    expect(result.current.fetchStatus).toBe("idle");
    expect(supabaseMocks.from).not.toHaveBeenCalled();
  });
});

describe("useMyChildren", () => {
  it("flattens the guardian link into linkId + person fields", async () => {
    const student = {
      id: "st-1",
      role: "STUDENT",
      firstName: "Alma",
      lastName: "Berg",
      email: "alma@example.com",
      phone: null,
      isActive: true,
      studentGroupId: "g-1",
    };
    stubTable("GuardianStudents", ok([{ id: "link-1", studentId: "st-1", student }]));
    const { wrapper } = createHarness();
    const { result } = renderHook(() => useMyChildren("guard-1"), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([{ linkId: "link-1", ...student }]);
    expect(argsFor("GuardianStudents", "eq")).toEqual([["guardianId", "guard-1"]]);
  });

  it("does not fetch before the guardian id is known", () => {
    const { wrapper } = createHarness();
    const { result } = renderHook(() => useMyChildren(null), { wrapper });
    expect(result.current.fetchStatus).toBe("idle");
    expect(supabaseMocks.from).not.toHaveBeenCalled();
  });
});

describe("useAbsenceReports", () => {
  it("uses null placeholders in the key and no filters when called without options", async () => {
    stubTable("AbsenceReports", ok([]));
    const { queryClient, wrapper } = createHarness();
    const { result } = renderHook(() => useAbsenceReports(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData(["absenceReports", null, null])).toEqual([]);
    expect(argsFor("AbsenceReports", "eq")).toEqual([]);
  });

  it("applies date and student filters and keys the cache on them", async () => {
    const rows = [
      {
        id: "ar-1",
        studentId: "st-1",
        reportedById: "guard-1",
        date: "2026-08-10",
        startTime: null,
        endTime: null,
        type: "SICK",
        note: null,
        createdAt: "2026-08-10T06:00:00.000Z",
      },
    ];
    stubTable("AbsenceReports", ok(rows));
    const { queryClient, wrapper } = createHarness();
    const { result } = renderHook(
      () => useAbsenceReports({ date: "2026-08-10", studentId: "st-1" }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(argsFor("AbsenceReports", "eq")).toEqual([
      ["date", "2026-08-10"],
      ["studentId", "st-1"],
    ]);
    expect(queryClient.getQueryData(["absenceReports", "2026-08-10", "st-1"])).toEqual(rows);
  });
});

describe("useRoomBookings", () => {
  it("selects bookings overlapping the window and keys on range + null status", async () => {
    stubTable("RoomBookings", ok([]));
    const { queryClient, wrapper } = createHarness();
    const { result } = renderHook(
      () => useRoomBookings("2026-08-10", "2026-08-14"),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // Overlap filter: starts before the window end, ends after the window start.
    expect(argsFor("RoomBookings", "lt")).toEqual([
      ["startsAt", "2026-08-14T23:59:59.999Z"],
    ]);
    expect(argsFor("RoomBookings", "gt")).toEqual([
      ["endsAt", "2026-08-10T00:00:00.000Z"],
    ]);
    expect(argsFor("RoomBookings", "eq")).toEqual([]);
    expect(
      queryClient.getQueryData(["roomBookings", "2026-08-10", "2026-08-14", null]),
    ).toEqual([]);
  });

  it("narrows to a status when one is given", async () => {
    stubTable("RoomBookings", ok([]));
    const { queryClient, wrapper } = createHarness();
    const { result } = renderHook(
      () => useRoomBookings("2026-08-10", "2026-08-14", "PENDING"),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(argsFor("RoomBookings", "eq")).toEqual([["status", "PENDING"]]);
    expect(
      queryClient.getQueryData(["roomBookings", "2026-08-10", "2026-08-14", "PENDING"]),
    ).toEqual([]);
  });
});

describe("useRoomBookingRequests", () => {
  it("lives under the roomBookings key family so booking mutations refresh the inbox", async () => {
    stubTable("RoomBookings", ok([]));
    const { queryClient, wrapper } = createHarness();
    const { result } = renderHook(() => useRoomBookingRequests(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData(["roomBookings", "inbox", null])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Gateway-backed queries (enabled-gating + URL construction)
// ---------------------------------------------------------------------------

describe("gateway queries", () => {
  it("useOptimizationHistory is gated on the year and builds the query string", async () => {
    mockApi.get.mockResolvedValue([]);
    const { queryClient, wrapper } = createHarness();
    const gated = renderHook(() => useOptimizationHistory(null), { wrapper });
    expect(gated.result.current.fetchStatus).toBe("idle");
    expect(mockApi.get).not.toHaveBeenCalled();

    const { result } = renderHook(() => useOptimizationHistory("y-1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApi.get).toHaveBeenCalledWith("/api/v1/optimization/jobs?academicYearId=y-1");
    expect(queryClient.getQueryData(["optimizationHistory", "y-1"])).toEqual([]);
  });

  it("useSubstituteSuggestions is gated on the lesson id", async () => {
    mockApi.get.mockResolvedValue([{ teacherId: "t-2", isPrimary: true }]);
    const { wrapper } = createHarness();
    const gated = renderHook(() => useSubstituteSuggestions(null), { wrapper });
    expect(gated.result.current.fetchStatus).toBe("idle");
    expect(mockApi.get).not.toHaveBeenCalled();

    const { result } = renderHook(() => useSubstituteSuggestions("cl-1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApi.get).toHaveBeenCalledWith(
      "/api/v1/calendar-lessons/cl-1/substitute-suggestions",
    );
    expect(result.current.data).toEqual([{ teacherId: "t-2", isPrimary: true }]);
  });

  it("useScheduleVersions and useScheduleVersionDetail gate on their ids", async () => {
    mockApi.get.mockResolvedValue({ id: "v-1", lessons: [] });
    const { wrapper } = createHarness();
    const gatedList = renderHook(() => useScheduleVersions(null), { wrapper });
    const gatedDetail = renderHook(() => useScheduleVersionDetail(null), { wrapper });
    expect(gatedList.result.current.fetchStatus).toBe("idle");
    expect(gatedDetail.result.current.fetchStatus).toBe("idle");
    expect(mockApi.get).not.toHaveBeenCalled();

    const { result } = renderHook(() => useScheduleVersionDetail("v-1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApi.get).toHaveBeenCalledWith("/api/v1/schedule-versions/v-1");
  });
});

// ---------------------------------------------------------------------------
// Optimization job polling
// ---------------------------------------------------------------------------

describe("useOptimizationJob", () => {
  const job = (status: OptimizationJob["status"]): OptimizationJob => ({
    id: "job-1",
    status,
    solverStatus: status === "SUCCEEDED" ? "OPTIMAL" : null,
    lessonsGenerated: 0,
    conflictSummary: null,
    conflicts: [],
    error: null,
    createdAt: "2026-08-08T10:00:00.000Z",
    finishedAt: null,
  });

  it("does not fetch until a job id exists", () => {
    const { wrapper } = createHarness();
    const { result } = renderHook(() => useOptimizationJob(null), { wrapper });
    expect(result.current.fetchStatus).toBe("idle");
    expect(mockApi.get).not.toHaveBeenCalled();
  });

  it("polls every 2s while the job runs and stops once it finishes", async () => {
    vi.useFakeTimers();
    // react-query defers observer notifications through a setTimeout(0). Under
    // vitest's fake timers a 0ms timer scheduled from a promise continuation
    // inside an interval tick is dropped, so the rendered result would never
    // see the refetched data. notifyManager.setScheduler is the public escape
    // hatch for tests: make the flush synchronous, restore the default after.
    notifyManager.setScheduler((cb) => cb());
    try {
      mockApi.get
        .mockResolvedValueOnce(job("RUNNING"))
        .mockResolvedValueOnce(job("SUCCEEDED"));
      const { wrapper } = createHarness();
      const { result } = renderHook(() => useOptimizationJob("job-1"), { wrapper });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(mockApi.get).toHaveBeenCalledTimes(1);
      expect(mockApi.get).toHaveBeenCalledWith("/api/v1/optimization/jobs/job-1");
      expect(result.current.data?.status).toBe("RUNNING");

      // RUNNING → refetchInterval 2000: one more fetch after 2s.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(mockApi.get).toHaveBeenCalledTimes(2);
      expect(result.current.data?.status).toBe("SUCCEEDED");

      // SUCCEEDED → refetchInterval false: silence from here on.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(mockApi.get).toHaveBeenCalledTimes(2);
    } finally {
      notifyManager.setScheduler((cb) => setTimeout(cb, 0));
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Mutations — invalidation contracts
// ---------------------------------------------------------------------------

describe("useCrudMutations", () => {
  const keys = [["subjects"], ["requirements"]];

  it("create posts the body and invalidates every configured key", async () => {
    const harness = createHarness();
    const { result } = renderHook(
      () => useCrudMutations<{ name: string }>("/api/v1/subjects", keys),
      { wrapper: harness.wrapper },
    );

    await act(async () => {
      await result.current.create.mutateAsync({ name: "Physics" });
    });
    expect(mockApi.post).toHaveBeenCalledWith("/api/v1/subjects", { name: "Physics" });
    expect(invalidatedKeys(harness)).toEqual([["subjects"], ["requirements"]]);
  });

  it("update patches /:id with the id stripped from the body", async () => {
    const harness = createHarness();
    const { result } = renderHook(
      () => useCrudMutations<{ name: string }>("/api/v1/subjects", keys),
      { wrapper: harness.wrapper },
    );

    await act(async () => {
      await result.current.update.mutateAsync({ id: "sub-1", name: "Chemistry" });
    });
    expect(mockApi.patch).toHaveBeenCalledWith("/api/v1/subjects/sub-1", {
      name: "Chemistry",
    });
    expect(invalidatedKeys(harness)).toEqual([["subjects"], ["requirements"]]);
  });

  it("remove deletes /:id and invalidates", async () => {
    const harness = createHarness();
    const { result } = renderHook(
      () => useCrudMutations<{ name: string }>("/api/v1/subjects", keys),
      { wrapper: harness.wrapper },
    );

    await act(async () => {
      await result.current.remove.mutateAsync("sub-1");
    });
    expect(mockApi.delete).toHaveBeenCalledWith("/api/v1/subjects/sub-1");
    expect(invalidatedKeys(harness)).toEqual([["subjects"], ["requirements"]]);
  });

  it("does not invalidate anything when the mutation fails", async () => {
    mockApi.post.mockRejectedValueOnce(new Error("HTTP 422"));
    const harness = createHarness();
    const { result } = renderHook(
      () => useCrudMutations<{ name: string }>("/api/v1/subjects", keys),
      { wrapper: harness.wrapper },
    );

    await act(async () => {
      await expect(result.current.create.mutateAsync({ name: "x" })).rejects.toThrow(
        "HTTP 422",
      );
    });
    expect(harness.invalidateSpy).not.toHaveBeenCalled();
  });
});

describe("optimization + publish mutations", () => {
  it("useStartOptimization posts the job and refreshes lessons + history", async () => {
    mockApi.post.mockResolvedValue({ jobId: "job-1" });
    const harness = createHarness();
    const { result } = renderHook(() => useStartOptimization(), {
      wrapper: harness.wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync({
        academicYearId: "y-1",
        weights: { spread: 2 },
      });
    });
    expect(mockApi.post).toHaveBeenCalledWith("/api/v1/optimization/jobs", {
      academicYearId: "y-1",
      weights: { spread: 2 },
    });
    expect(invalidatedKeys(harness)).toEqual([["masterLessons"], ["optimizationHistory"]]);
  });

  it("usePublishSchedule refreshes only the calendar", async () => {
    mockApi.post.mockResolvedValue({ created: 42 });
    const harness = createHarness();
    const { result } = renderHook(() => usePublishSchedule(), {
      wrapper: harness.wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync({ academicYearId: "y-1" });
    });
    expect(mockApi.post).toHaveBeenCalledWith("/api/v1/calendar/publish", {
      academicYearId: "y-1",
    });
    expect(invalidatedKeys(harness)).toEqual([["calendarLessons"]]);
  });
});

describe("master lesson mutations", () => {
  const scheduleKeys = [["masterLessons"], ["calendarLessons"], ["teacherLessons"]];

  it("update patches /:id without the id in the body and refreshes the schedule", async () => {
    const harness = createHarness();
    const { result } = renderHook(() => useUpdateMasterLesson(), {
      wrapper: harness.wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync({
        id: "ml-1",
        dayOfWeek: 2,
        startTime: "09:00:00",
        propagate: true,
      });
    });
    expect(mockApi.patch).toHaveBeenCalledWith("/api/v1/master-lessons/ml-1", {
      dayOfWeek: 2,
      startTime: "09:00:00",
      propagate: true,
    });
    expect(invalidatedKeys(harness)).toEqual(scheduleKeys);
  });

  it("create posts the lesson and refreshes the schedule", async () => {
    const harness = createHarness();
    const { result } = renderHook(() => useCreateMasterLesson(), {
      wrapper: harness.wrapper,
    });
    const body = {
      academicYearId: "y-1",
      subjectId: "sub-1",
      studentGroupId: "g-1",
      dayOfWeek: 1,
      startTime: "08:00:00",
      endTime: "08:45:00",
    };

    await act(async () => {
      await result.current.mutateAsync(body);
    });
    expect(mockApi.post).toHaveBeenCalledWith("/api/v1/master-lessons", body);
    expect(invalidatedKeys(harness)).toEqual(scheduleKeys);
  });

  it("delete removes /:id and refreshes the schedule", async () => {
    const harness = createHarness();
    const { result } = renderHook(() => useDeleteMasterLesson(), {
      wrapper: harness.wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync("ml-1");
    });
    expect(mockApi.delete).toHaveBeenCalledWith("/api/v1/master-lessons/ml-1");
    expect(invalidatedKeys(harness)).toEqual(scheduleKeys);
  });
});

describe("useLessonActions", () => {
  const dayViewKeys = [
    ["dayLessons"],
    ["calendarLessons"],
    ["teacherLessons"],
    ["teacherAbsenceLessons"],
  ];

  it("cancel sends an empty body when no reason is given", async () => {
    const harness = createHarness();
    const { result } = renderHook(() => useLessonActions(), { wrapper: harness.wrapper });

    await act(async () => {
      await result.current.cancel.mutateAsync({ id: "cl-1" });
    });
    expect(mockApi.patch).toHaveBeenCalledWith("/api/v1/calendar-lessons/cl-1/cancel", {});
    expect(invalidatedKeys(harness)).toEqual(dayViewKeys);
  });

  it("cancel forwards the reason when present", async () => {
    const harness = createHarness();
    const { result } = renderHook(() => useLessonActions(), { wrapper: harness.wrapper });

    await act(async () => {
      await result.current.cancel.mutateAsync({ id: "cl-1", reason: "teacher ill" });
    });
    expect(mockApi.patch).toHaveBeenCalledWith("/api/v1/calendar-lessons/cl-1/cancel", {
      reason: "teacher ill",
    });
  });

  it("reinstate patches the reinstate endpoint and refreshes the day views", async () => {
    const harness = createHarness();
    const { result } = renderHook(() => useLessonActions(), { wrapper: harness.wrapper });

    await act(async () => {
      await result.current.reinstate.mutateAsync("cl-1");
    });
    expect(mockApi.patch).toHaveBeenCalledWith(
      "/api/v1/calendar-lessons/cl-1/reinstate",
      {},
    );
    expect(invalidatedKeys(harness)).toEqual(dayViewKeys);
  });

  it("substitute sends the teacher and only includes note when given", async () => {
    const harness = createHarness();
    const { result } = renderHook(() => useLessonActions(), { wrapper: harness.wrapper });

    await act(async () => {
      await result.current.substitute.mutateAsync({ id: "cl-1", teacherId: "t-2" });
    });
    expect(mockApi.patch).toHaveBeenCalledWith(
      "/api/v1/calendar-lessons/cl-1/substitute",
      { teacherId: "t-2" },
    );

    await act(async () => {
      await result.current.substitute.mutateAsync({
        id: "cl-1",
        teacherId: "t-2",
        note: "covers period 3",
      });
    });
    expect(mockApi.patch).toHaveBeenLastCalledWith(
      "/api/v1/calendar-lessons/cl-1/substitute",
      { teacherId: "t-2", note: "covers period 3" },
    );
  });

  it("changeRoom can clear the room with null and refreshes the day views", async () => {
    const harness = createHarness();
    const { result } = renderHook(() => useLessonActions(), { wrapper: harness.wrapper });

    await act(async () => {
      await result.current.changeRoom.mutateAsync({ id: "cl-1", roomId: null });
    });
    expect(mockApi.patch).toHaveBeenCalledWith(
      "/api/v1/calendar-lessons/cl-1/room-change",
      { roomId: null },
    );
    expect(invalidatedKeys(harness)).toEqual(dayViewKeys);
  });
});

describe("useScheduleVersionActions", () => {
  it("save invalidates only the version list", async () => {
    const harness = createHarness();
    const { result } = renderHook(() => useScheduleVersionActions(), {
      wrapper: harness.wrapper,
    });

    await act(async () => {
      await result.current.save.mutateAsync({ academicYearId: "y-1", name: "Before HT" });
    });
    expect(mockApi.post).toHaveBeenCalledWith("/api/v1/schedule-versions", {
      academicYearId: "y-1",
      name: "Before HT",
    });
    expect(invalidatedKeys(harness)).toEqual([["scheduleVersions"]]);
  });

  it("restore additionally invalidates the whole schedule", async () => {
    mockApi.post.mockResolvedValue({ restoredLessons: 12, safetyVersionId: "v-9" });
    const harness = createHarness();
    const { result } = renderHook(() => useScheduleVersionActions(), {
      wrapper: harness.wrapper,
    });

    await act(async () => {
      await result.current.restore.mutateAsync("v-1");
    });
    expect(mockApi.post).toHaveBeenCalledWith("/api/v1/schedule-versions/v-1/restore", {});
    expect(invalidatedKeys(harness)).toEqual([
      ["scheduleVersions"],
      ["masterLessons"],
      ["calendarLessons"],
      ["teacherLessons"],
    ]);
  });

  it("remove invalidates only the version list", async () => {
    const harness = createHarness();
    const { result } = renderHook(() => useScheduleVersionActions(), {
      wrapper: harness.wrapper,
    });

    await act(async () => {
      await result.current.remove.mutateAsync("v-1");
    });
    expect(mockApi.delete).toHaveBeenCalledWith("/api/v1/schedule-versions/v-1");
    expect(invalidatedKeys(harness)).toEqual([["scheduleVersions"]]);
  });
});

describe("useReportAttendance", () => {
  it("invalidates exactly the reported lesson's attendance", async () => {
    mockApi.post.mockResolvedValue({ created: 2, updated: 1 });
    const harness = createHarness();
    const { result } = renderHook(() => useReportAttendance(), {
      wrapper: harness.wrapper,
    });
    const body = {
      calendarLessonId: "cl-7",
      records: [{ studentId: "st-1", status: "PRESENT" as const }],
    };

    await act(async () => {
      await result.current.mutateAsync(body);
    });
    expect(mockApi.post).toHaveBeenCalledWith("/api/v1/attendance/report", body);
    // Targeted invalidation: keyed on the lesson from the mutation variables,
    // so other lessons' attendance caches stay warm.
    expect(invalidatedKeys(harness)).toEqual([["lessonAttendance", "cl-7"]]);
  });
});

describe("useGuardianLinkActions", () => {
  it("link posts the pair and refreshes both directions of the relationship", async () => {
    const harness = createHarness();
    const { result } = renderHook(() => useGuardianLinkActions(), {
      wrapper: harness.wrapper,
    });

    await act(async () => {
      await result.current.link.mutateAsync({ guardianId: "guard-1", studentId: "st-1" });
    });
    expect(mockApi.post).toHaveBeenCalledWith("/api/v1/guardian-links", {
      guardianId: "guard-1",
      studentId: "st-1",
    });
    expect(invalidatedKeys(harness)).toEqual([["studentGuardians"], ["myChildren"]]);
  });

  it("unlink deletes the link and refreshes both directions", async () => {
    const harness = createHarness();
    const { result } = renderHook(() => useGuardianLinkActions(), {
      wrapper: harness.wrapper,
    });

    await act(async () => {
      await result.current.unlink.mutateAsync("link-1");
    });
    expect(mockApi.delete).toHaveBeenCalledWith("/api/v1/guardian-links/link-1");
    expect(invalidatedKeys(harness)).toEqual([["studentGuardians"], ["myChildren"]]);
  });
});

describe("useAbsenceReportActions", () => {
  it("report posts the absence and refreshes the report list", async () => {
    const harness = createHarness();
    const { result } = renderHook(() => useAbsenceReportActions(), {
      wrapper: harness.wrapper,
    });
    const body = {
      studentId: "st-1",
      date: "2026-08-10",
      type: "SICK" as const,
    };

    await act(async () => {
      await result.current.report.mutateAsync(body);
    });
    expect(mockApi.post).toHaveBeenCalledWith("/api/v1/absence-reports", body);
    expect(invalidatedKeys(harness)).toEqual([["absenceReports"]]);
  });

  it("remove deletes the report and refreshes the list", async () => {
    const harness = createHarness();
    const { result } = renderHook(() => useAbsenceReportActions(), {
      wrapper: harness.wrapper,
    });

    await act(async () => {
      await result.current.remove.mutateAsync("ar-1");
    });
    expect(mockApi.delete).toHaveBeenCalledWith("/api/v1/absence-reports/ar-1");
    expect(invalidatedKeys(harness)).toEqual([["absenceReports"]]);
  });
});

describe("useLeaveRequestActions", () => {
  it("request posts the leave and refreshes leave + absence views", async () => {
    const harness = createHarness();
    const { result } = renderHook(() => useLeaveRequestActions(), {
      wrapper: harness.wrapper,
    });
    const body = {
      studentId: "st-1",
      startDate: "2026-09-01",
      endDate: "2026-09-05",
      reason: "family trip",
    };

    await act(async () => {
      await result.current.request.mutateAsync(body);
    });
    expect(mockApi.post).toHaveBeenCalledWith("/api/v1/leave-requests", body);
    expect(invalidatedKeys(harness)).toEqual([["leaveRequests"], ["absenceReports"]]);
  });

  it("decide patches /decide and omits the note when not provided", async () => {
    const harness = createHarness();
    const { result } = renderHook(() => useLeaveRequestActions(), {
      wrapper: harness.wrapper,
    });

    await act(async () => {
      await result.current.decide.mutateAsync({ id: "lr-1", status: "REJECTED" });
    });
    expect(mockApi.patch).toHaveBeenCalledWith("/api/v1/leave-requests/lr-1/decide", {
      status: "REJECTED",
    });

    await act(async () => {
      await result.current.decide.mutateAsync({
        id: "lr-1",
        status: "APPROVED",
        note: "ok",
      });
    });
    expect(mockApi.patch).toHaveBeenLastCalledWith("/api/v1/leave-requests/lr-1/decide", {
      status: "APPROVED",
      note: "ok",
    });
    expect(invalidatedKeys(harness)).toEqual([
      ["leaveRequests"],
      ["absenceReports"],
      ["leaveRequests"],
      ["absenceReports"],
    ]);
  });
});

describe("useRoomBookingActions", () => {
  it("book posts the booking and refreshes both booking views", async () => {
    const harness = createHarness();
    const { result } = renderHook(() => useRoomBookingActions(), {
      wrapper: harness.wrapper,
    });
    const body = {
      roomId: "r-1",
      title: "Parent meeting",
      startsAt: "2026-08-12T15:00:00.000Z",
      endsAt: "2026-08-12T16:00:00.000Z",
    };

    await act(async () => {
      await result.current.book.mutateAsync(body);
    });
    expect(mockApi.post).toHaveBeenCalledWith("/api/v1/room-bookings", body);
    expect(invalidatedKeys(harness)).toEqual([["roomBookings"], ["myRoomBookings"]]);
  });

  it("cancel patches /cancel with an empty body", async () => {
    const harness = createHarness();
    const { result } = renderHook(() => useRoomBookingActions(), {
      wrapper: harness.wrapper,
    });

    await act(async () => {
      await result.current.cancel.mutateAsync("rb-1");
    });
    expect(mockApi.patch).toHaveBeenCalledWith("/api/v1/room-bookings/rb-1/cancel", {});
    expect(invalidatedKeys(harness)).toEqual([["roomBookings"], ["myRoomBookings"]]);
  });

  it("decide sends the status, optional note, and refreshes both views", async () => {
    const harness = createHarness();
    const { result } = renderHook(() => useRoomBookingActions(), {
      wrapper: harness.wrapper,
    });

    await act(async () => {
      await result.current.decide.mutateAsync({ id: "rb-1", status: "APPROVED" });
    });
    expect(mockApi.patch).toHaveBeenCalledWith("/api/v1/room-bookings/rb-1/decide", {
      status: "APPROVED",
    });

    await act(async () => {
      await result.current.decide.mutateAsync({
        id: "rb-1",
        status: "REJECTED",
        note: "double booked",
      });
    });
    expect(mockApi.patch).toHaveBeenLastCalledWith("/api/v1/room-bookings/rb-1/decide", {
      status: "REJECTED",
      note: "double booked",
    });
    expect(invalidatedKeys(harness)).toEqual([
      ["roomBookings"],
      ["myRoomBookings"],
      ["roomBookings"],
      ["myRoomBookings"],
    ]);
  });
});

describe("teaching-group membership hooks", () => {
  it("useGroupMembers fetches the member list through the admin API", async () => {
    const members = [
      { id: "st-1", firstName: "Alma", lastName: "Berg", homeGroupId: "g-7a" },
    ];
    mockApi.get.mockResolvedValue(members);
    const { wrapper } = createHarness();
    const { result } = renderHook(() => useGroupMembers("g-ma71"), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(members);
    expect(mockApi.get).toHaveBeenCalledWith("/api/v1/student-groups/g-ma71/members");
  });

  it("useGroupMembers stays idle without a group id", () => {
    const { wrapper } = createHarness();
    const { result } = renderHook(() => useGroupMembers(null), { wrapper });
    expect(result.current.fetchStatus).toBe("idle");
    expect(mockApi.get).not.toHaveBeenCalled();
  });

  it("useGroupMemberships reads the whole school's membership rows", async () => {
    stubTable("StudentGroupMembers", ok([{ studentId: "st-1", studentGroupId: "g-ma71" }]));
    const { wrapper } = createHarness();
    const { result } = renderHook(() => useGroupMemberships(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([
      { studentId: "st-1", studentGroupId: "g-ma71" },
    ]);
    expect(argsFor("StudentGroupMembers", "select")).toEqual([
      ["studentId, studentGroupId"],
    ]);
  });

  it("useSetGroupMembers PUTs the replacement list and invalidates every reader", async () => {
    mockApi.put.mockResolvedValue({ count: 2 });
    const { wrapper, invalidateSpy } = createHarness();
    const { result } = renderHook(() => useSetGroupMembers(), { wrapper });

    await result.current.mutateAsync({
      groupId: "g-ma71",
      studentIds: ["st-1", "st-2"],
    });

    expect(mockApi.put).toHaveBeenCalledWith("/api/v1/student-groups/g-ma71/members", {
      studentIds: ["st-1", "st-2"],
    });
    const invalidated = invalidateSpy.mock.calls.map((call) => call[0]?.queryKey);
    expect(invalidated).toContainEqual(["groupMembers", "g-ma71"]);
    expect(invalidated).toContainEqual(["groupMemberships"]);
    expect(invalidated).toContainEqual(["groups"]);
    expect(invalidated).toContainEqual(["lessonRoster"]);
  });

  it("useSetGroupMembers invalidates nothing when the save fails", async () => {
    mockApi.put.mockRejectedValue(new Error("boom"));
    const { wrapper, invalidateSpy } = createHarness();
    const { result } = renderHook(() => useSetGroupMembers(), { wrapper });

    await expect(
      result.current.mutateAsync({ groupId: "g-ma71", studentIds: [] }),
    ).rejects.toThrow("boom");
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------

describe("useImportCsv", () => {
  // Every reader an import can touch: people (students/teachers), groups
  // (classes + teaching groups created on the fly), and both membership views.
  const importKeys = [["people"], ["groups"], ["groupMemberships"], ["groupMembers"]];

  it("students POST /import/students with the academic year in the body", async () => {
    const report: ImportReport = { created: 2, skipped: 0, errors: [] };
    mockApi.post.mockResolvedValue(report);
    const harness = createHarness();
    const { result } = renderHook(() => useImportCsv(), { wrapper: harness.wrapper });
    const rows = [
      { firstName: "Alma", lastName: "Berg", email: "alma@example.com", className: "7A" },
    ];

    let outcome: ImportReport | undefined;
    await act(async () => {
      outcome = await result.current.mutateAsync({
        kind: "students",
        academicYearId: "y-1",
        rows,
      });
    });
    expect(mockApi.post).toHaveBeenCalledWith("/api/v1/import/students", {
      academicYearId: "y-1",
      rows,
    });
    expect(outcome).toEqual(report);
    expect(invalidatedKeys(harness)).toEqual(importKeys);
  });

  it("teachers POST /import/teachers with rows only — a passed year is stripped", async () => {
    const harness = createHarness();
    const { result } = renderHook(() => useImportCsv(), { wrapper: harness.wrapper });
    const rows = [{ firstName: "Karin", lastName: "Ek", email: "karin.ek@example.com" }];

    await act(async () => {
      await result.current.mutateAsync({ kind: "teachers", academicYearId: "y-1", rows });
    });
    // The teachers endpoint takes no academicYearId; the hook owns that shape.
    expect(mockApi.post).toHaveBeenCalledWith("/api/v1/import/teachers", { rows });
    expect(invalidatedKeys(harness)).toEqual(importKeys);
  });

  it("classes POST /import/groups with the academic year", async () => {
    const harness = createHarness();
    const { result } = renderHook(() => useImportCsv(), { wrapper: harness.wrapper });
    const rows = [{ name: "7A", gradeLevel: 7 }, { name: "8B" }];

    await act(async () => {
      await result.current.mutateAsync({ kind: "classes", academicYearId: "y-1", rows });
    });
    expect(mockApi.post).toHaveBeenCalledWith("/api/v1/import/groups", {
      academicYearId: "y-1",
      rows,
    });
    expect(invalidatedKeys(harness)).toEqual(importKeys);
  });

  it("teachingGroups POST /import/group-members with the academic year", async () => {
    const harness = createHarness();
    const { result } = renderHook(() => useImportCsv(), { wrapper: harness.wrapper });
    const rows = [{ groupName: "Ma71", email: "alma@example.com" }];

    await act(async () => {
      await result.current.mutateAsync({
        kind: "teachingGroups",
        academicYearId: "y-1",
        rows,
      });
    });
    expect(mockApi.post).toHaveBeenCalledWith("/api/v1/import/group-members", {
      academicYearId: "y-1",
      rows,
    });
    expect(invalidatedKeys(harness)).toEqual(importKeys);
  });

  it("invalidates nothing when the import fails", async () => {
    mockApi.post.mockRejectedValueOnce(new Error("HTTP 429"));
    const harness = createHarness();
    const { result } = renderHook(() => useImportCsv(), { wrapper: harness.wrapper });

    await act(async () => {
      await expect(
        result.current.mutateAsync({ kind: "teachers", rows: [{}] }),
      ).rejects.toThrow("HTTP 429");
    });
    expect(harness.invalidateSpy).not.toHaveBeenCalled();
  });
});

describe("useInvitations", () => {
  it("posts to the invite route for one person and reports what happened", async () => {
    mockApi.post.mockResolvedValue({ id: "u-1", emailSent: true });
    const { wrapper } = createHarness();
    const { result } = renderHook(() => useInvitations(), { wrapper });

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.inviteOne.mutateAsync("u-1");
    });

    expect(mockApi.post).toHaveBeenCalledWith("/api/v1/users/u-1/invite", {});
    // emailSent is the honest bit: false means the address already had an
    // account and no mail was sent at all.
    expect(outcome).toEqual({ id: "u-1", emailSent: true });
  });

  it("refreshes the people list so the invitation status stops being stale", async () => {
    mockApi.post.mockResolvedValue({ id: "u-1", emailSent: true });
    const harness = createHarness();
    const { result } = renderHook(() => useInvitations(), {
      wrapper: harness.wrapper,
    });

    await act(async () => {
      await result.current.inviteOne.mutateAsync("u-1");
    });

    await waitFor(() => {
      expect(invalidatedKeys(harness)).toContainEqual(["people"]);
    });
  });

  it("sends a whole selection in a single request", async () => {
    mockApi.post.mockResolvedValue({ sent: 3, alreadyRegistered: 0, errors: [] });
    const { wrapper } = createHarness();
    const { result } = renderHook(() => useInvitations(), { wrapper });

    await act(async () => {
      await result.current.inviteMany.mutateAsync(["u-1", "u-2", "u-3"]);
    });

    expect(mockApi.post).toHaveBeenCalledWith("/api/v1/users/invitations", {
      userIds: ["u-1", "u-2", "u-3"],
    });
  });
});

describe("useCrudMutations for people", () => {
  it("carries sendInvitation only when it is set", async () => {
    // The whole point of the feature: creating a person is silent unless the
    // admin says otherwise, so the flag must reach the API verbatim.
    mockApi.post.mockResolvedValue({ id: "u-1" });
    const { wrapper } = createHarness();
    const { result } = renderHook(
      () => useCrudMutations<Record<string, unknown>>("/api/v1/users", [["people"]]),
      { wrapper },
    );

    await act(async () => {
      await result.current.create.mutateAsync({
        firstName: "Alma",
        lastName: "Berg",
        email: "alma@example.com",
        role: "STUDENT",
      });
    });
    expect(mockApi.post.mock.calls[0]?.[1]).not.toHaveProperty("sendInvitation");

    await act(async () => {
      await result.current.create.mutateAsync({
        firstName: "Nils",
        lastName: "Ek",
        email: "nils@example.com",
        role: "STUDENT",
        sendInvitation: true,
      });
    });
    expect(mockApi.post.mock.calls[1]?.[1]).toMatchObject({ sendInvitation: true });
  });
});
