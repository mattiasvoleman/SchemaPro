import { describe, expect, it } from "vitest";
import { lessonOfBlockLink } from "./placement-block-link";
import type { BoardBlock, BoardBlockRow } from "./placement-board";

/* Länkläsaren (placement-block-link.ts): lektionen väljs på block, dag OCH start (två mutanter som ignorerade blocket respektive starten överlevde kontraktsprovet). */
const lesson = (id: string, day: number, start: string, end: string): BoardBlockRow => ({
  id, dayOfWeek: day, startTime: start, endTime: end, minutes: 60, recurrence: "ALL_WEEKS", rooms: [], changedAt: "2026-11-13T08:00:00.000Z", verdicts: [],
});
const block = (id: string, rows: BoardBlockRow[]): BoardBlock => ({
  id, name: id, memberIds: ["m1"], lengths: [60, 60], recurrence: "ALL_WEEKS", followsBlockId: null, cannotPlace: null, rows, rowsKey: "k",
});

describe("the lesson a link names (block link)", () => {
  it("L1: of two lessons on the same day it is the one at the start the address says", () => {
    const b = block("b1", [lesson("morning", 2, "08:00", "09:00"), lesson("noon", 2, "13:00", "14:00")]);
    expect(lessonOfBlockLink([b], { blockId: "b1", dayOfWeek: 2, startTime: "13:00" })?.row.id).toBe("noon");
    expect(lessonOfBlockLink([b], { blockId: "b1", dayOfWeek: 2, startTime: "11:00" })).toBeNull();
  });

  it("L2: it is a lesson of the block the address says, and none of another block's that stands at the same place", () => {
    const b1 = block("b1", [lesson("one", 2, "13:00", "14:00")]);
    const b2 = block("b2", [lesson("two", 2, "13:00", "14:00")]);
    expect(lessonOfBlockLink([b1, b2], { blockId: "b2", dayOfWeek: 2, startTime: "13:00" })?.row.id).toBe("two");
    expect(lessonOfBlockLink([b1, b2], { blockId: "b3", dayOfWeek: 2, startTime: "13:00" })).toBeNull();
  });
});
