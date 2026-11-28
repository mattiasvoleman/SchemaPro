import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MasterLesson } from "@/lib/types";
import { MASTER_LESSON_SELECT, readOne } from "./master-lesson-cache";

/*
 * One lesson as the database holds it now (E9): what a write refused for somebody else's change reads again, and lays in the lists that hold it.
 */
const answer = vi.hoisted(() => ({ value: { data: null, error: null } as { data: unknown; error: unknown } }));
const calls = vi.hoisted(() => ({ select: vi.fn(), eq: vi.fn() }));
vi.mock("@/utils/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      select: (columns: string) => {
        calls.select(columns);
        return { eq: (column: string, value: string) => (calls.eq(column, value), { maybeSingle: async () => answer.value }) };
      },
    }),
  }),
}));

const row = (over: Record<string, unknown> = {}) => ({
  id: "a",
  academicYearId: "year-1",
  subjectId: "sv",
  studentGroupId: "7a",
  teacherId: "anna",
  coTeacherId: null,
  roomId: "r2",
  dayOfWeek: 3,
  startTime: "10:00:00",
  endTime: "11:00:00",
  isLocked: true,
  isParked: false,
  recurrence: "ALL_WEEKS",
  startDate: null,
  endDate: null,
  extraGroups: [{ studentGroupId: "8b" }],
  participants: [],
  ...over,
});

function held() {
  const queryClient = new QueryClient();
  const old = { id: "a", academicYearId: "year-1", dayOfWeek: 1, roomId: "r1", extraGroupIds: [], studentIds: [] } as unknown as MasterLesson;
  queryClient.setQueryData(["masterLessons", "year-1"], [old, { ...old, id: "b" } as MasterLesson]);
  return queryClient;
}

beforeEach(() => {
  calls.select.mockClear();
  calls.eq.mockClear();
});

describe("reading one lesson again", () => {
  it("reads it with the columns of the year's list, lays it where the lists hold it, and answers with it", async () => {
    answer.value = { data: row(), error: null };
    const queryClient = held();
    const lesson = await readOne(queryClient, "a");
    expect(calls.select).toHaveBeenCalledWith(MASTER_LESSON_SELECT);
    expect(calls.eq).toHaveBeenCalledWith("id", "a");
    expect(lesson).toMatchObject({ id: "a", dayOfWeek: 3, roomId: "r2", isLocked: true, extraGroupIds: ["8b"], studentIds: [] });
    const list = queryClient.getQueryData<MasterLesson[]>(["masterLessons", "year-1"])!;
    expect(list.map((entry) => [entry.id, entry.dayOfWeek])).toEqual([["a", 3], ["b", 1]]);
  });

  it("answers null for a lesson that is gone, and takes it out of the lists", async () => {
    answer.value = { data: null, error: null };
    const queryClient = held();
    await expect(readOne(queryClient, "a")).resolves.toBeNull();
    expect(queryClient.getQueryData<MasterLesson[]>(["masterLessons", "year-1"])!.map((entry) => entry.id)).toEqual(["b"]);
  });

  it("answers undefined for a read that did not come, and leaves the lists as they were", async () => {
    answer.value = { data: null, error: { message: "network" } };
    const queryClient = held();
    await expect(readOne(queryClient, "a")).resolves.toBeUndefined();
    expect(queryClient.getQueryData<MasterLesson[]>(["masterLessons", "year-1"])!.map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});
