import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { seenOf } from "./lesson-expected";

/*
 * What the page says it saw (E9): the fields a write sets, as the page read them, in the forms the gateway's `expected` takes.
 */
describe("what the page saw of the fields a write sets", () => {
  const row = { dayOfWeek: 2, startTime: "08:00:00", endTime: "09:00:00", roomId: null, teacherId: "t-1", isLocked: false, recurrence: "ODD_WEEKS", startDate: "2026-09-07", endDate: null, exemptFrom: ["FRAME"], studentIds: [], extraGroupIds: ["g-2"] };

  it("takes only the fields the patch sets, and nothing of the others", () => {
    expect(seenOf(row, { roomId: "r-9", isLocked: true })).toEqual({ roomId: null, isLocked: false });
    expect(seenOf(row, {})).toEqual({});
  });

  it("says the clock as an input writes it, whether the row has it with seconds (PostgREST) or without (the gateway)", () => {
    expect(seenOf(row, { startTime: "10:00", endTime: "11:00" })).toEqual({ startTime: "08:00", endTime: "09:00" });
    expect(seenOf({ ...row, startTime: "08:00" }, { startTime: "10:00" })).toEqual({ startTime: "08:00" });
  });

  it("keeps null as an answer (no room, no last day) and leaves out a field the state does not hold", () => {
    expect(seenOf(row, { roomId: "r-9", endDate: "2026-12-18" })).toEqual({ roomId: null, endDate: null });
    expect(seenOf({ dayOfWeek: 2 }, { dayOfWeek: 3, roomId: "r-9" })).toEqual({ dayOfWeek: 2 });
  });

  it("reads the exemption from `exemptFrom` of a row or an answer, from `exempt` of a snapshot, and a lesson that has none as an empty list", () => {
    expect(seenOf(row, { exempt: [] })).toEqual({ exempt: ["FRAME"] });
    expect(seenOf({ ...row, exemptFrom: undefined, exempt: ["LUNCH"] }, { exempt: [] })).toEqual({ exempt: ["LUNCH"] });
    expect(seenOf({ ...row, exemptFrom: undefined }, { exempt: ["FRAME"] })).toEqual({ exempt: [] });
  });

  it("ignores what a write carries that is no field of the lesson", () => {
    expect(seenOf(row, { propagate: false, expected: { dayOfWeek: 9 }, id: "x" })).toEqual({});
  });
});

/**
 * The seam to the gateway, read as text (the gateway's jest does not run the web, and the compiler does not see a name that is spelled in one place
 * and not the other): every field of a lesson snapshot, which is what a write sets, is a field the gateway's `expected` can compare.
 */
describe("the fields against the gateway's", () => {
  it("name every field a write of the page sets, so that none is sent that the gateway would refuse as unknown (400)", () => {
    const gateway = readFileSync(join(__dirname, "..", "..", "src", "calendar", "lesson-expectation.ts"), "utf8");
    const named = /EXPECTED_FIELDS = \[([^\]]*)\]/.exec(gateway)![1]!.match(/'([A-Za-z]+)'/g)!.map((name) => name.slice(1, -1));
    const snapshot = readFileSync(join(__dirname, "..", "app", "[locale]", "(app)", "admin", "timetable", "timetable-helpers.ts"), "utf8");
    const fields = [...(/interface LessonSnapshot \{([^}]*)\}/.exec(snapshot)![1]!).matchAll(/^\s+([A-Za-z]+)\??:/gm)].map((match) => match[1]!);
    expect(fields.length).toBeGreaterThan(8);
    for (const field of fields) expect(named).toContain(field);
  });
});
