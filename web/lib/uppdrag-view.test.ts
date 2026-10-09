import { describe, expect, it } from "vitest";
import { boxOf, periodOf, tickedBoxes } from "./uppdrag-view";

describe("periodOf", () => {
  it("reads an undated row as the whole year or its weeks, and a dated one by its dates", () => {
    expect(periodOf({ recurrence: "ALL_WEEKS", startDate: null, endDate: null })).toEqual({ kind: "year" });
    expect(periodOf({ recurrence: null, startDate: null, endDate: null })).toEqual({ kind: "year" });
    expect(periodOf({ recurrence: "ODD_WEEKS", startDate: null, endDate: null })).toEqual({ kind: "odd" });
    expect(periodOf({ recurrence: "EVEN_WEEKS", startDate: null, endDate: null })).toEqual({ kind: "even" });
    expect(periodOf({ recurrence: "ODD_WEEKS", startDate: "2026-08-17", endDate: null })).toEqual({
      kind: "dated",
      from: "2026-08-17",
      to: null,
      recurrence: "ODD",
    });
  });
});

describe("the template's boxes", () => {
  it("puts every uppdrag kind in exactly one box, the unnamed ones under Övrigt", () => {
    expect(boxOf("MENTORSKAP")).toBe("MENTOR");
    expect(boxOf("VFU_HANDLEDNING")).toBe("VFU");
    expect(boxOf("APT_KONFERENS")).toBe("APT");
    expect(boxOf("RASTVAKT")).toBe("OVRIGT");
    expect(boxOf("PEDAGOGISK_LUNCH")).toBe("OVRIGT");
    expect(boxOf("ANNAT")).toBe("OVRIGT");
    expect([...tickedBoxes([{ kind: "MENTORSKAP" }, { kind: "RASTVAKT" }, { kind: "MENTORSKAP" }])]).toEqual([
      "MENTOR",
      "OVRIGT",
    ]);
  });
});
