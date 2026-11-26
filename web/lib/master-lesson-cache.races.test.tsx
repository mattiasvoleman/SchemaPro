import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ApiError, api } from "@/lib/api";
import type { MasterLesson } from "@/lib/types";
import { useCreateMasterLesson, useUpdateMasterLesson } from "./queries";

vi.mock("@/utils/supabase/client", () => ({ createClient: () => ({ from: vi.fn() }) }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

/*
 * What the year's list does when a read of it and a write of a lesson cross: the socket's "master_timetable_updated"
 * (lib/use-timetable-realtime.ts) tells the page the week is old, and that is also what the gateway says to the person who
 * made the change (it announces to the whole school, the writer's own socket included, and before the change is committed).
 */

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

function harness() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  queryClient.setQueryData([...YEAR], [lesson("a"), lesson("b", { dayOfWeek: 3 })]);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const held = () => queryClient.getQueryData<MasterLesson[]>([...YEAR])!;
  return { queryClient, wrapper, held };
}

function slow<T>() {
  let answer!: (value: T) => void;
  let refuse!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    answer = resolve;
    refuse = reject;
  });
  return { promise, answer, refuse };
}

/** The page's own read of the year, as an observer: only an active query is read again when it is told it is old. */
function pageReads(queryClient: QueryClient, reads: Array<() => Promise<MasterLesson[]>>) {
  let next = 0;
  const queryFn = vi.fn(() => reads[Math.min(next++, reads.length - 1)]!());
  const observer = new QueryObserver(queryClient, { queryKey: [...YEAR], queryFn, staleTime: Infinity });
  const stop = observer.subscribe(() => undefined);
  return { queryFn, stop };
}
const socketSaysChanged = (queryClient: QueryClient) => void queryClient.invalidateQueries({ queryKey: ["masterLessons"] });
const settled = (queryClient: QueryClient) => vi.waitFor(() => expect(queryClient.isFetching({ queryKey: ["masterLessons"] })).toBe(0));

beforeEach(() => {
  vi.resetAllMocks();
});

describe("a read of the year that begins while a write is on its way", () => {
  it("does not leave the card on its old square when the read began before the change was committed", async () => {
    const { queryClient, wrapper, held } = harness();
    const request = slow<unknown>();
    mockApi.patch.mockReturnValue(request.promise);
    const early = slow<MasterLesson[]>();
    // The first read begins while the change is not yet committed and sees the week as it was; the next one sees it moved.
    const { queryFn } = pageReads(queryClient, [
      () => early.promise,
      () => Promise.resolve([lesson("a", { dayOfWeek: 2 }), lesson("b", { dayOfWeek: 3 })]),
    ]);
    const { result } = renderHook(() => useUpdateMasterLesson(), { wrapper });

    let done!: Promise<unknown>;
    act(() => {
      done = result.current.mutateAsync({ id: "a", dayOfWeek: 2 });
    });
    await vi.waitFor(() => expect(held()[0]!.dayOfWeek).toBe(2));
    socketSaysChanged(queryClient);
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));

    await act(async () => {
      request.answer(lesson("a", { dayOfWeek: 2 }));
      await done;
    });
    // The read that began before the commit lands after the answer, with the week as it was.
    await act(async () => {
      early.answer([lesson("a"), lesson("b", { dayOfWeek: 3 })]);
      await settled(queryClient);
    });
    expect(held()[0]!.dayOfWeek).toBe(2);
  });

  it("does not lose a lesson that was made while such a read was on its way", async () => {
    const { queryClient, wrapper, held } = harness();
    const request = slow<unknown>();
    mockApi.post.mockReturnValue(request.promise);
    const early = slow<MasterLesson[]>();
    pageReads(queryClient, [
      () => early.promise,
      () => Promise.resolve([lesson("a"), lesson("b", { dayOfWeek: 3 }), lesson("new", { dayOfWeek: 4 })]),
    ]);
    const { result } = renderHook(() => useCreateMasterLesson(), { wrapper });

    let done!: Promise<unknown>;
    act(() => {
      done = result.current.mutateAsync({
        academicYearId: "year-1",
        subjectId: "sv",
        studentGroupId: "7a",
        dayOfWeek: 4,
        startTime: "08:00",
        endTime: "09:00",
      });
    });
    socketSaysChanged(queryClient);
    await vi.waitFor(() => expect(queryClient.isFetching({ queryKey: ["masterLessons"] })).toBe(1));
    await act(async () => {
      request.answer(lesson("new", { dayOfWeek: 4 }));
      await done;
    });
    await act(async () => {
      early.answer([lesson("a"), lesson("b", { dayOfWeek: 3 })]);
      await settled(queryClient);
    });
    expect(held().map((l) => l.id)).toContain("new");
  });

  it("reads the year again after a refusal when the write had stopped a read", async () => {
    const { queryClient, wrapper } = harness();
    const early = slow<MasterLesson[]>();
    const { queryFn } = pageReads(queryClient, [() => early.promise, () => Promise.resolve([lesson("a"), lesson("b", { dayOfWeek: 3 })])]);
    // A colleague's change has made the week old, and the read of it is on its way when this write is asked for.
    socketSaysChanged(queryClient);
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));

    mockApi.patch.mockRejectedValue(new ApiError(409, "no"));
    const { result } = renderHook(() => useUpdateMasterLesson(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: "a", dayOfWeek: 2 }).catch(() => undefined);
    });
    // What the stopped read would have brought is brought by nothing else.
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
  });
});

describe("two writes of one lesson, both refused", () => {
  it("leaves the card where the database has it, and not where the first drag asked for", async () => {
    const { queryClient, wrapper, held } = harness();
    pageReads(queryClient, [() => Promise.resolve([lesson("a"), lesson("b", { dayOfWeek: 3 })])]);
    const first = slow<unknown>();
    const second = slow<unknown>();
    mockApi.patch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useUpdateMasterLesson(), { wrapper });

    let one!: Promise<unknown>;
    let two!: Promise<unknown>;
    act(() => {
      one = result.current.mutateAsync({ id: "a", dayOfWeek: 2 });
      one.catch(() => undefined);
    });
    await vi.waitFor(() => expect(held()[0]!.dayOfWeek).toBe(2));
    // The second drag is made from the card where the first one put it.
    act(() => {
      two = result.current.mutateAsync({ id: "a", dayOfWeek: 4 });
      two.catch(() => undefined);
    });
    await vi.waitFor(() => expect(held()[0]!.dayOfWeek).toBe(4));

    await act(async () => {
      first.refuse(new ApiError(409, "no"));
      await one.catch(() => undefined);
    });
    await act(async () => {
      second.refuse(new ApiError(409, "no"));
      await two.catch(() => undefined);
    });
    await settled(queryClient);
    // The database never moved it.
    expect(held()[0]!.dayOfWeek).toBe(1);
  });
});

describe("two writes of one lesson, the first answered while the second is on its way", () => {
  it("keeps the card where the second drag put it, and not on the square the first answer names", async () => {
    const { wrapper, held } = harness();
    const first = slow<unknown>();
    const second = slow<unknown>();
    mockApi.patch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useUpdateMasterLesson(), { wrapper });

    let one!: Promise<unknown>;
    let two!: Promise<unknown>;
    act(() => {
      one = result.current.mutateAsync({ id: "a", dayOfWeek: 2 });
    });
    await vi.waitFor(() => expect(held()[0]!.dayOfWeek).toBe(2));
    act(() => {
      two = result.current.mutateAsync({ id: "a", dayOfWeek: 4 });
    });
    await vi.waitFor(() => expect(held()[0]!.dayOfWeek).toBe(4));

    await act(async () => {
      first.answer(lesson("a", { dayOfWeek: 2 }));
      await one;
    });
    expect(held()[0]!.dayOfWeek).toBe(4);
    await act(async () => {
      second.answer(lesson("a", { dayOfWeek: 4 }));
      await two;
    });
    expect(held()[0]!.dayOfWeek).toBe(4);
  });
});
