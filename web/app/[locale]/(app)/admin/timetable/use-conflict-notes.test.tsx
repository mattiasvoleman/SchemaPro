import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ConflictHit } from "@/lib/conflicts";
import type { MasterLesson } from "@/lib/types";

const loaded = vi.hoisted(() => vi.fn());
vi.mock("@/lib/conflict-rows", async (importOriginal) => {
  loaded();
  return importOriginal();
});

import { useConflictNotes } from "./use-conflict-notes";

const lesson = (id: string, dayOfWeek: number, startTime: string, groupId: string, subjectId: string): MasterLesson =>
  ({
    id,
    academicYearId: "y",
    subjectId,
    studentGroupId: groupId,
    teacherId: "anna",
    coTeacherId: null,
    roomId: null,
    dayOfWeek,
    startTime,
    endTime: `${String(Number(startTime.slice(0, 2)) + 1).padStart(2, "0")}:00:00`,
    isLocked: false,
    isParked: false,
    recurrence: "ALL_WEEKS",
    startDate: null,
    endDate: null,
    extraGroupIds: [],
    studentIds: [],
  }) as MasterLesson;

// The echo of the catalogue's sentence, as the page tests have it: the reason and what the sentence is written from.
const tCommon = ((key: string, values?: Record<string, unknown>) => `${key}(${values ? Object.values(values).join("|") : ""})`) as never;

const A = lesson("a", 1, "08:00:00", "7a", "ma");
const B = lesson("b", 1, "08:00:00", "8b", "kemi");
const lessonById = new Map([A, B].map((l) => [l.id, l]));
const groupById = new Map([["7a", { name: "7A" }], ["8b", { name: "8B" }]]);
const subjectById = new Map([["ma", { name: "Matematik" }], ["kemi", { name: "Kemi" }]]);
const clash = (other: string): ConflictHit[] => [{ kind: "TEACHER", otherLessonId: other, message: "x" } as ConflictHit];

const inputs = (conflictMap: Map<string, ConflictHit[]>) => ({
  conflictMap,
  lessonById,
  groupById,
  subjectById,
  constraints: [],
  gradeSpanOf: undefined,
  roomLock: "ROOM-LOCK",
  tCommon,
});

describe("useConflictNotes", () => {
  it("fetches nothing and says nothing while nothing clashes", async () => {
    loaded.mockClear();
    const { result } = renderHook(() => useConflictNotes(inputs(new Map())));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current).toBeUndefined();
    expect(loaded).not.toHaveBeenCalled();
  });

  it("says each clashing lesson in the sentence of a refused save, with the other lesson by class, subject, day and time", async () => {
    const map = new Map([["a", clash("b")], ["b", clash("a")]]);
    const { result } = renderHook(() => useConflictNotes(inputs(map)));
    await waitFor(() => expect(result.current).toBeDefined());
    // Reason, then what the sentence is written from: the other lesson, 8B's Kemi, Monday 08:00–09:00.
    expect(result.current!.get("a")).toMatch(/^codes\.MASTER_LESSON_REFUSED\(TEACHER\|.*\|8B\|Kemi\|1\|08:00\|09:00\)$/);
    expect(result.current!.get("b")).toMatch(/^codes\.MASTER_LESSON_REFUSED\(TEACHER\|.*\|7A\|Matematik\|1\|08:00\|09:00\)$/);
  });

  it("words a clash with a room's lock, which the gateway has no refusal for, in the page's own sentence", async () => {
    const map = new Map<string, ConflictHit[]>([["a", [{ kind: "ROOM_LOCK", message: "x" } as ConflictHit]]]);
    const { result } = renderHook(() => useConflictNotes(inputs(map)));
    await waitFor(() => expect(result.current).toBeDefined());
    expect(result.current!.get("a")).toBe("ROOM-LOCK");
  });
});
