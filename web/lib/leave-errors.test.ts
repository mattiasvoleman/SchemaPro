import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { lastLeaveDay, leaveActionError, leaveRequestError } from "./leave-errors";

/**
 * What the leave forms say when the gateway refuses. A family's request has
 * two bounds the gateway sends with a code (LeaveService.createLeaveRequest,
 * 20261101090000), worded here in the reader's language rather than shown as
 * the gateway's English.
 */

const copy = { tooLong: (days: number) => `högst ${days} dagar`, endsBeforeStart: "slutar före", fallback: "fel" };

describe("leaveRequestError", () => {
  it("words a request of more than a year by its code, with the days the gateway counts", () => {
    expect(leaveRequestError(new ApiError(400, "A leave request covers at most 366 days.", "LEAVE_REQUEST_TOO_LONG", { days: 366 }), copy)).toBe(
      "högst 366 dagar",
    );
    expect(leaveRequestError(new ApiError(400, "x", "LEAVE_REQUEST_TOO_LONG"), copy)).toBe("högst 366 dagar");
  });

  it("words a request that ends before it starts by its code", () => {
    expect(leaveRequestError(new ApiError(400, "endDate must not be before startDate.", "LEAVE_REQUEST_ENDS_BEFORE_START"), copy)).toBe(
      "slutar före",
    );
  });

  it("leaves any other refusal as the gateway said it, and an unknown throw as the fallback", () => {
    expect(leaveRequestError(new ApiError(400, "reason must be longer", undefined), copy)).toBe("reason must be longer");
    expect(leaveRequestError(new ApiError(409, "x", "LEAVE_REQUEST_TOO_LONG"), copy)).toBe("x");
    expect(leaveRequestError("boom", copy)).toBe("fel");
  });
});

describe("lastLeaveDay", () => {
  it("is the 366th day with the first, across a leap day, and nothing for no start", () => {
    expect(lastLeaveDay("2028-01-01")).toBe("2028-12-31");
    expect(lastLeaveDay("2027-03-01")).toBe("2028-02-29");
    expect(lastLeaveDay("2026-10-15")).toBe("2027-10-15");
    expect(lastLeaveDay("")).toBeUndefined();
  });
});

describe("leaveActionError", () => {
  it("is unchanged: a lost race is the inbox's own sentence", () => {
    const words = { alreadyDecided: "redan beslutad", fallback: "fel" };
    expect(leaveActionError(new ApiError(409, "x", "LEAVE_REQUEST_DECIDED"), "admin", words)).toBe("redan beslutad");
    expect(leaveActionError(new ApiError(404, "x"), "mentor", words)).toBe("redan beslutad");
    expect(leaveActionError(new ApiError(404, "Leave request not found."), "admin", words)).toBe("Leave request not found.");
  });
});
