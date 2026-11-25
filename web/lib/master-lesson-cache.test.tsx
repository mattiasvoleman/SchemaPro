import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ApiError, api } from "@/lib/api";
import type { MasterLesson } from "@/lib/types";
import { useCreateMasterLesson, useDeleteMasterLesson, useUpdateMasterLesson } from "./queries";
import {
  addLesson,
  lessonFieldsOf,
  lessonOfRow,
  MASTER_LESSON_SELECT,
  patchLesson,
  putBack,
  putLesson,
  removeLesson,
} from "./master-lesson-cache";

vi.mock("@/utils/supabase/client", () => ({ createClient: () => ({ from: vi.fn() }) }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const mockApi = api as unknown as Record<"patch" | "post" | "delete", Mock>;

const YEAR = ["masterLessons", "year-1"] as const;

function lesson(id: string, overrides: Partial<MasterLesson> = {}): MasterLesson {
  return {
    id,
    academicYearId: "year-1",
    subjectId: "sv",
    studentGroupId: "7a",
    teacherId: "anna",
    coTeacherId: null,
    roomId: "r1",
    dayOfWeek: 1,
    // What PostgREST gives: the clock with seconds.
    startTime: "08:00:00",
    endTime: "09:00:00",
    isLocked: false,
    isParked: false,
    recurrence: "EVERY",
    startDate: null,
    endDate: null,
    extraGroupIds: [],
    studentIds: [],
    ...overrides,
  } as MasterLesson;
}

function harness(lessons: MasterLesson[] = [lesson("a"), lesson("b", { dayOfWeek: 3 })]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  queryClient.setQueryData([...YEAR], lessons);
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const held = () => queryClient.getQueryData<MasterLesson[]>([...YEAR])!;
  return { queryClient, invalidate, wrapper, held };
}

/** A request the test answers when it chooses to. */
function slow<T>() {
  let answer!: (value: T) => void;
  let refuse!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    answer = resolve;
    refuse = reject;
  });
  return { promise, answer, refuse };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("the year's lesson lists in the cache", () => {
  it("puts a patch on the lesson in the year's list and nowhere else", () => {
    const { queryClient, held } = harness();
    // The map of where each lesson came from lives under the same root and is not a list.
    queryClient.setQueryData(["masterLessons", "year-1", "origin"], { a: "GENERATED" });
    queryClient.setQueryData(["masterLessons", "year-2"], [lesson("a", { academicYearId: "year-2" })]);

    patchLesson(queryClient, "a", { dayOfWeek: 4, startTime: "10:15", endTime: "11:15" });

    expect(held()[0]).toMatchObject({ id: "a", dayOfWeek: 4, startTime: "10:15:00", endTime: "11:15:00" });
    expect(held()[1]).toEqual(lesson("b", { dayOfWeek: 3 }));
    expect(queryClient.getQueryData(["masterLessons", "year-1", "origin"])).toEqual({ a: "GENERATED" });
  });

  it("writes a time the way the list writes it, so that two lessons at one hour are the same string", () => {
    const { queryClient, held } = harness([lesson("a"), lesson("b", { startTime: "09:00", endTime: "10:00" })]);
    patchLesson(queryClient, "a", { startTime: "09:00", endTime: "10:00" });
    patchLesson(queryClient, "b", { startTime: "10:00", endTime: "11:00" });
    expect(held()[0]!.startTime).toBe("09:00:00");
    expect(held()[1]!.startTime).toBe("10:00");
  });

  it("keeps the other lessons' objects, which is what lets their cards stand", () => {
    const { queryClient, held } = harness();
    const before = held();
    patchLesson(queryClient, "a", { isLocked: true });
    expect(held()[1]).toBe(before[1]);
    expect(held()[0]).not.toBe(before[0]);
  });

  it("gives back only the lesson a refused write changed, and not what another write did since", () => {
    const { queryClient, held } = harness();
    const remembered = patchLesson(queryClient, "a", { dayOfWeek: 5 });
    patchLesson(queryClient, "b", { isLocked: true });
    putBack(queryClient, remembered);
    expect(held()[0]!.dayOfWeek).toBe(1);
    expect(held()[1]!.isLocked).toBe(true);
  });

  it("puts a removed lesson back, and a lesson the gateway made in its year", () => {
    const { queryClient, held } = harness();
    const remembered = removeLesson(queryClient, "a");
    expect(held().map((l) => l.id)).toEqual(["b"]);
    putBack(queryClient, remembered);
    expect(held().map((l) => l.id).sort()).toEqual(["a", "b"]);

    addLesson(queryClient, lesson("c"));
    addLesson(queryClient, lesson("c"));
    expect(held().filter((l) => l.id === "c")).toHaveLength(1);
    addLesson(queryClient, lesson("d", { academicYearId: "year-9" }));
    expect(held().map((l) => l.id)).not.toContain("d");
  });

  it("takes from a body or an answer only what a lesson holds", () => {
    expect(lessonFieldsOf({ id: "a", propagate: true, warnings: [], dayOfWeek: 2, roomId: null, teacherId: undefined })).toEqual({
      dayOfWeek: 2,
      roomId: null,
    });
    expect(lessonFieldsOf(undefined)).toEqual({});
  });
});

describe("a lesson moved, made or removed stands in the grid before the year is read", () => {
  it("moves the card when the write is asked for, and not when it is answered", async () => {
    const { wrapper, held } = harness();
    const request = slow<unknown>();
    mockApi.patch.mockReturnValue(request.promise);
    const { result } = renderHook(() => useUpdateMasterLesson(), { wrapper });

    let done!: Promise<unknown>;
    act(() => {
      done = result.current.mutateAsync({ id: "a", dayOfWeek: 2, startTime: "10:00", endTime: "11:00" });
    });
    await vi.waitFor(() => expect(held()[0]).toMatchObject({ dayOfWeek: 2, startTime: "10:00:00", endTime: "11:00:00" }));

    // The gateway has not answered, and the card is where the person put it.
    expect(mockApi.patch).toHaveBeenCalledTimes(1);
    await act(async () => {
      request.answer({ ...lesson("a"), dayOfWeek: 2, startTime: "10:00", endTime: "11:00" });
      await done;
    });
    expect(held()[0]).toMatchObject({ dayOfWeek: 2, startTime: "10:00:00" });
  });

  it("takes what the gateway answers over what was asked for", async () => {
    const { wrapper, held } = harness();
    mockApi.patch.mockResolvedValue({ ...lesson("a"), dayOfWeek: 2, roomId: "r9", startTime: "10:05", endTime: "11:05" });
    const { result } = renderHook(() => useUpdateMasterLesson(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: "a", dayOfWeek: 2, startTime: "10:00", endTime: "11:00" });
    });
    expect(held()[0]).toMatchObject({ roomId: "r9", startTime: "10:05:00" });
  });

  it("does not read the year again when it has patched the answer in: it marks it old and no more", async () => {
    const { wrapper, invalidate } = harness();
    mockApi.patch.mockResolvedValue(lesson("a", { isLocked: true }));
    const { result } = renderHook(() => useUpdateMasterLesson(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: "a", isLocked: true });
    });
    const forYear = invalidate.mock.calls.find((call) => call[0]?.queryKey?.[0] === "masterLessons");
    expect(forYear?.[0]).toMatchObject({ queryKey: ["masterLessons"], refetchType: "none" });
    // The calendar's lists are another matter.
    expect(invalidate.mock.calls.some((call) => call[0]?.queryKey?.[0] === "calendarLessons")).toBe(true);
  });

  it("puts the card back when the gateway refuses, and leaves a lesson another write moved where it is", async () => {
    const { queryClient, wrapper, held } = harness();
    const request = slow<unknown>();
    mockApi.patch.mockReturnValue(request.promise);
    const { result } = renderHook(() => useUpdateMasterLesson(), { wrapper });

    let done!: Promise<unknown>;
    act(() => {
      done = result.current.mutateAsync({ id: "a", dayOfWeek: 5 });
      done.catch(() => undefined);
    });
    await vi.waitFor(() => expect(held()[0]!.dayOfWeek).toBe(5));
    patchLesson(queryClient, "b", { isLocked: true });

    await act(async () => {
      request.refuse(new ApiError(409, "Teacher already teaches Matematik in this slot."));
      await done.catch(() => undefined);
    });
    expect(held()[0]!.dayOfWeek).toBe(1);
    expect(held()[1]!.isLocked).toBe(true);
  });

  it("stops a read of the year that began before the write, and reads again once the write is answered", async () => {
    const { queryClient, wrapper, invalidate } = harness();
    const seen = slow<MasterLesson[]>();
    // A read on its way: the lesson as it was before the write.
    void queryClient.fetchQuery({ queryKey: [...YEAR], queryFn: () => seen.promise, staleTime: 0 });
    await vi.waitFor(() => expect(queryClient.isFetching({ queryKey: ["masterLessons"] })).toBe(1));

    mockApi.patch.mockResolvedValue(lesson("a", { dayOfWeek: 2 }));
    const { result } = renderHook(() => useUpdateMasterLesson(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: "a", dayOfWeek: 2 });
    });

    expect(queryClient.isFetching({ queryKey: ["masterLessons"] })).toBe(0);
    const forYear = invalidate.mock.calls.find((call) => call[0]?.queryKey?.[0] === "masterLessons");
    // No refetchType: none, so an active read is made.
    expect(forYear?.[0]).toEqual({ queryKey: ["masterLessons"] });
  });

  it("puts a lesson the gateway made in the list when it answers", async () => {
    const { wrapper, held } = harness();
    mockApi.post.mockResolvedValue(lesson("new", { dayOfWeek: 4 }));
    const { result } = renderHook(() => useCreateMasterLesson(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({
        academicYearId: "year-1",
        subjectId: "sv",
        studentGroupId: "7a",
        dayOfWeek: 4,
        startTime: "08:00",
        endTime: "09:00",
      });
    });
    expect(held().map((l) => l.id)).toContain("new");
    expect(held().find((l) => l.id === "new")!.fromPlacement).toBe(false);
  });

  it("takes a lesson out when it is deleted, and gives it back when that is refused", async () => {
    const { wrapper, held } = harness();
    const request = slow<unknown>();
    mockApi.delete.mockReturnValue(request.promise);
    const { result } = renderHook(() => useDeleteMasterLesson(), { wrapper });

    let done!: Promise<unknown>;
    act(() => {
      done = result.current.mutateAsync("a");
      done.catch(() => undefined);
    });
    await vi.waitFor(() => expect(held().map((l) => l.id)).toEqual(["b"]));
    await act(async () => {
      request.refuse(new ApiError(403, "no"));
      await done.catch(() => undefined);
    });
    expect(held().map((l) => l.id).sort()).toEqual(["a", "b"]);
  });
});

describe("what a collaborator's change is read as", () => {
  it("is read with the columns the year is read with (queries.ts cannot import this module, so the two are held equal here)", () => {
    const source = readFileSync(resolve(process.cwd(), "lib/queries.ts"), "utf8");
    const yearRead = /\.from\("MasterLessons"\)\s*\.select\(\s*"([^"]+)"/.exec(source);
    expect(yearRead).not.toBeNull();
    expect(MASTER_LESSON_SELECT).toBe(yearRead![1]);
  });

  it("lays a row as the list holds it: the groups and the pupils as ids", () => {
    const { extraGroupIds: _g, studentIds: _s, ...rest } = lesson("a");
    expect(
      lessonOfRow({ ...rest, extraGroups: [{ studentGroupId: "7b" }, { studentGroupId: "7c" }], participants: [{ studentId: "p1" }] }),
    ).toEqual({ ...lesson("a"), extraGroupIds: ["7b", "7c"], studentIds: ["p1"] });
  });

  it("puts a lesson in the place it had, or at the end, in its own year's list only", () => {
    const { queryClient, held } = harness();
    queryClient.setQueryData(["masterLessons", "year-2"], [lesson("a", { academicYearId: "year-2" })]);
    putLesson(queryClient, lesson("a", { dayOfWeek: 4 }));
    putLesson(queryClient, lesson("c"));
    expect(held().map((l) => [l.id, l.dayOfWeek])).toEqual([["a", 4], ["b", 3], ["c", 1]]);
    expect(queryClient.getQueryData<MasterLesson[]>(["masterLessons", "year-2"])![0]!.dayOfWeek).toBe(1);
  });
});
