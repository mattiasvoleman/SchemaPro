import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ConflictHit } from "@/lib/conflicts";
import type { MasterLesson } from "@/lib/types";

// The module that makes the words is a chunk of its own, and a chunk can fail to come (a lost connection, a proxy).
vi.mock("@/lib/conflict-rows", () => {
  throw new Error("Failed to load chunk");
});

import { useConflictNotes } from "./use-conflict-notes";

describe("useConflictNotes when the module that makes the words does not come", () => {
  it("says nothing, as before the words, and leaves no rejection that nobody handles", async () => {
    const unhandled: unknown[] = [];
    const listen = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listen);
    try {
      const a = { id: "a", subjectId: "ma", studentGroupId: "7a", dayOfWeek: 1, startTime: "08:00:00", endTime: "09:00:00", extraGroupIds: [] } as unknown as MasterLesson;
      const clash: ConflictHit[] = [{ kind: "TEACHER", otherLessonId: "b" } as ConflictHit];
      const { result } = renderHook(() =>
        useConflictNotes({
          conflictMap: new Map([["a", clash]]),
          lessonById: new Map([["a", a]]),
          groupById: new Map(),
          subjectById: new Map(),
          constraints: [],
          gradeSpanOf: undefined,
          roomLock: "x",
          tCommon: ((key: string) => key) as never,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(result.current).toBeUndefined();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listen);
    }
  });
});
