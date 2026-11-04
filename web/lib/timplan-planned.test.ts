import { describe, expect, it } from "vitest";
import { nationalTopOf } from "@/lib/timplan-planned";

/**
 * The code a subject's minutes roll up under. The gateway's copy holds it to
 * P1's nationalCellOf (timplan-planned.spec.ts); the shared fixture holds the
 * lines this mirror draws to the gateway's, but has no subject with a group and
 * no code, so the guard is held here.
 */
describe("nationalTopOf", () => {
  it("is the ämnesgrupp of a child, and the code itself for any other", () => {
    expect(nationalTopOf({ nationalCode: "BI", parentCode: "NO" })).toBe("NO");
    expect(nationalTopOf({ nationalCode: "NO", parentCode: null })).toBe("NO");
    expect(nationalTopOf({ nationalCode: "MA" })).toBe("MA");
  });

  it("is none for a subject outside the national timplan, whatever group it is given", () => {
    expect(nationalTopOf({ nationalCode: null })).toBeNull();
    expect(nationalTopOf({ nationalCode: null, parentCode: "NO" })).toBeNull();
  });
});
