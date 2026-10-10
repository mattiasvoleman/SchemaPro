import { describe, expect, it } from "vitest";
import {
  createInputOf,
  EMPTY_CANCELLATION_FORM,
  formProblems,
  inclusiveDays,
  sameSelection,
  selectionOf,
  type CancellationForm,
} from "@/lib/cancellation-form";

const YEAR = { startDate: "2026-08-17", endDate: "2027-06-11" };
const form = (overrides: Partial<CancellationForm> = {}): CancellationForm => ({
  ...EMPTY_CANCELLATION_FORM,
  name: "Prao åk 9",
  fromDate: "2026-11-02",
  toDate: "2026-11-06",
  ...overrides,
});

describe("the bulk avbokning form", () => {
  it("counts both ends of the range, as the gateway's 31 days do", () => {
    expect(inclusiveDays("2026-11-02", "2026-11-02")).toBe(1);
    expect(inclusiveDays("2026-11-02", "2026-12-02")).toBe(31);
    expect(formProblems(form({ toDate: "2026-12-02" }), YEAR)).toEqual([]);
    expect(formProblems(form({ toDate: "2026-12-03" }), YEAR)).toEqual(["tooLong"]);
  });

  it("names what the gateway would refuse, beside the fields", () => {
    expect(formProblems(form({ name: "  " }), YEAR)).toEqual(["name"]);
    expect(formProblems(form({ toDate: "" }), YEAR)).toEqual(["dates"]);
    expect(formProblems(form({ fromDate: "2026-11-06", toDate: "2026-11-02" }), YEAR)).toEqual(["order"]);
    expect(formProblems(form({ fromDate: "2026-08-10", toDate: "2026-08-20" }), YEAR)).toEqual(["outsideYear"]);
    expect(formProblems(form({ startTime: "08:00" }), YEAR)).toEqual(["time"]);
    expect(formProblems(form({ startTime: "12:00", endTime: "08:00" }), YEAR)).toEqual(["time"]);
    expect(formProblems(form({ minGradeLevel: 9, maxGradeLevel: 7 }), YEAR)).toEqual(["grades"]);
    expect(formProblems(form({ scope: "GROUPS" }), YEAR)).toEqual(["groups"]);
  });

  it("credits whole days only, with 1–600 minutes", () => {
    expect(formProblems(form({ credit: true, creditMinutes: "300" }), YEAR)).toEqual([]);
    expect(formProblems(form({ credit: true, creditMinutes: "0" }), YEAR)).toEqual(["creditMinutes"]);
    expect(formProblems(form({ credit: true, creditMinutes: "300", startTime: "08:00", endTime: "12:00" }), YEAR)).toEqual([
      "creditPartialDay",
    ]);
  });

  it("sends only the scope's own fields, the groups in a stable order", () => {
    expect(selectionOf(form(), "y26")).toEqual({
      academicYearId: "y26",
      name: "Prao åk 9",
      cause: "EVENT",
      fromDate: "2026-11-02",
      toDate: "2026-11-06",
      scope: "GRADES",
      minGradeLevel: 9,
      maxGradeLevel: 9,
    });
    expect(selectionOf(form({ scope: "GROUPS", groupIds: ["g-b", "g-a"], startTime: "08:00", endTime: "12:00" }), "y26")).toEqual({
      academicYearId: "y26",
      name: "Prao åk 9",
      cause: "EVENT",
      fromDate: "2026-11-02",
      toDate: "2026-11-06",
      startTime: "08:00",
      endTime: "12:00",
      scope: "GROUPS",
      groupIds: ["g-a", "g-b"],
    });
    expect(selectionOf(form({ scope: "SCHOOL", groupIds: ["g-a"] }), "y26")).not.toHaveProperty("groupIds");
  });

  it("creates with the preview's digest and the credit only when asked", () => {
    expect(createInputOf(form(), "y26", "d")).not.toHaveProperty("credit");
    expect(createInputOf(form({ credit: true, creditMinutes: "300", creditSubjectId: "s-idh" }), "y26", "d")).toMatchObject({
      expectedDigest: "d",
      credit: { minutes: 300, subjectId: "s-idh" },
    });
    expect(createInputOf(form({ credit: true, creditMinutes: "300" }), "y26", "d").credit).toEqual({ minutes: 300 });
  });

  it("knows when the preview no longer describes the form", () => {
    const previewed = selectionOf(form(), "y26");
    expect(sameSelection(previewed, selectionOf(form(), "y26"))).toBe(true);
    expect(sameSelection(previewed, selectionOf(form({ toDate: "2026-11-05" }), "y26"))).toBe(false);
    expect(sameSelection(null, previewed)).toBe(false);
  });
});
