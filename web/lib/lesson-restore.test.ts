import { describe, expect, it } from "vitest";
import { restorableInput } from "@/lib/lesson-restore";
import type { MasterLesson } from "@/lib/types";

const lesson = (overrides: Partial<MasterLesson> = {}): MasterLesson => ({
  id: "L1",
  academicYearId: "y1",
  subjectId: "s1",
  studentGroupId: "g1",
  teacherId: "t1",
  coTeacherId: null,
  roomId: "r1",
  dayOfWeek: 2,
  startTime: "09:00:00",
  endTime: "10:00:00",
  isLocked: false,
  recurrence: "ALL_WEEKS",
  startDate: null,
  endDate: null,
  extraGroupIds: [],
  studentIds: [],
  ...overrides,
});

describe("restorableInput", () => {
  it("keeps an odd-week lesson odd", () => {
    // The bug the single-delete path already had a comment about, and which the
    // bulk path reintroduced by carrying a shorter list of fields.
    const input = restorableInput(lesson({ recurrence: "ODD_WEEKS" }));
    expect(input.recurrence).toBe("ODD_WEEKS");
  });

  it("keeps a half-term course a half-term course", () => {
    const input = restorableInput(
      lesson({ startDate: "2026-08-17", endDate: "2026-12-19" }),
    );
    expect([input.startDate, input.endDate]).toEqual(["2026-08-17", "2026-12-19"]);
  });

  it("keeps the other classes that attend", () => {
    // Dropped by the bulk path, on exactly the lessons most likely to have them.
    const input = restorableInput(lesson({ extraGroupIds: ["g2", "g3"] }));
    expect(input.extraGroupIds).toEqual(["g2", "g3"]);
  });

  it("keeps the individually named pupils", () => {
    const input = restorableInput(lesson({ studentIds: ["p1", "p2"] }));
    expect(input.studentIds).toEqual(["p1", "p2"]);
  });

  it("keeps the second teacher of a co-taught lesson", () => {
    // Lost on BOTH paths until the field existed in the client type and in the
    // server's create DTO — the solver wrote the column directly and never went
    // through either.
    const input = restorableInput(lesson({ coTeacherId: "t2" }));
    expect(input.coTeacherId).toBe("t2");
  });

  it("keeps the lock, so an undone delete does not free a pinned lesson", () => {
    const input = restorableInput(lesson({ isLocked: true }));
    expect(input.isLocked).toBe(true);
  });

  it("sends the clock as HH:MM, which is what the API accepts", () => {
    const input = restorableInput(lesson());
    expect([input.startTime, input.endTime]).toEqual(["09:00", "10:00"]);
  });

  it("carries every field the row has, so nothing new is silently dropped", () => {
    /*
     * The defect this function exists to end was a SHORTER LIST, not a wrong
     * value — so the test that matters counts fields rather than checking them
     * one by one. A column added to MasterLesson and forgotten here fails this.
     */
    const ignored = new Set(["id"]);
    const row = lesson();
    const input = restorableInput(row) as unknown as Record<string, unknown>;
    const missing = Object.keys(row).filter(
      (key) => !ignored.has(key) && !(key in input),
    );
    expect(missing).toEqual([]);
  });
});
