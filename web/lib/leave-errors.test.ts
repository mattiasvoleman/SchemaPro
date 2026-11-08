import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { lastLeaveDay, leaveActionError, leaveConsentError, leaveRequestError } from "./leave-errors";

/**
 * What the leave forms say when the gateway refuses. A family's request has
 * two bounds the gateway sends with a code (LeaveService.createLeaveRequest,
 * 20261101090000), worded here in the reader's language rather than shown as
 * the gateway's English.
 */

const copy = {
  tooLong: (days: number) => `högst ${days} dagar`,
  endsBeforeStart: "slutar före",
  fallback: "fel",
  tooLate: (days: number) => `minst ${days} dagar före`,
  contactRequired: "kontakt krävs",
  contactIncomplete: "kontakt ofullständig",
};

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

  it("words a request filed too late by the school's minimum, as the gateway counts it (Ledighetspolicy)", () => {
    expect(leaveRequestError(new ApiError(400, "x", "LEAVE_REQUEST_TOO_LATE", { days: 14 }), copy)).toBe("minst 14 dagar före");
    // No minimum in the answer is a sentence that names none, never "NaN".
    expect(leaveRequestError(new ApiError(400, "x", "LEAVE_REQUEST_TOO_LATE"), copy)).toBe("minst 0 dagar före");
    expect(leaveRequestError(new ApiError(400, "x", "LEAVE_REQUEST_TOO_LATE", { days: "många" }), copy)).toBe("minst 0 dagar före");
  });

  it("words a contact the school requires, and one given in part, by their codes", () => {
    expect(leaveRequestError(new ApiError(400, "x", "LEAVE_CONTACT_REQUIRED"), copy)).toBe("kontakt krävs");
    expect(leaveRequestError(new ApiError(400, "x", "LEAVE_CONTACT_INCOMPLETE"), copy)).toBe("kontakt ofullständig");
  });

  it("leaves any other refusal as the gateway said it, and an unknown throw as the fallback", () => {
    expect(leaveRequestError(new ApiError(400, "reason must be longer", undefined), copy)).toBe("reason must be longer");
    expect(leaveRequestError(new ApiError(409, "x", "LEAVE_REQUEST_TOO_LONG"), copy)).toBe("x");
    // The code alone decides, but only on a 400: the same words from another status are the gateway's own.
    expect(leaveRequestError(new ApiError(403, "Forbidden.", "LEAVE_CONTACT_REQUIRED"), copy)).toBe("Forbidden.");
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

  it("says a request that still waits for a guardian's consent cannot be decided yet (Ledighetspolicy)", () => {
    const words = { alreadyDecided: "redan beslutad", fallback: "fel", awaitingConsent: "väntar på samtycke" };
    const waiting = new ApiError(409, "The leave request waits for every guardian's consent.", "LEAVE_AWAITING_CONSENT");
    expect(leaveActionError(waiting, "admin", words)).toBe("väntar på samtycke");
    // A page that gives no words for it shows the gateway's own, as before.
    expect(leaveActionError(waiting, "mentor", { alreadyDecided: "redan beslutad", fallback: "fel" })).toBe(waiting.message);
  });
});

describe("leaveConsentError", () => {
  const words = {
    notAGuardian: "inte vårdnadshavare",
    notFound: "ingen fråga",
    requestEnded: "avslutad",
    custodyEnded: "vårdnaden har upphört",
    answered: "redan besvarad",
    fallback: "fel",
  };

  it("words each refusal of a guardian's answer by its code, so a reader is told why nothing changed", () => {
    expect(leaveConsentError(new ApiError(403, "x", "LEAVE_CONSENT_NOT_A_GUARDIAN"), words)).toBe("inte vårdnadshavare");
    expect(leaveConsentError(new ApiError(404, "x", "LEAVE_CONSENT_NOT_FOUND"), words)).toBe("ingen fråga");
    expect(leaveConsentError(new ApiError(409, "x", "LEAVE_CONSENT_REQUEST_ENDED"), words)).toBe("avslutad");
    expect(leaveConsentError(new ApiError(409, "x", "LEAVE_CONSENT_CUSTODY_ENDED"), words)).toBe("vårdnaden har upphört");
    expect(leaveConsentError(new ApiError(409, "x", "LEAVE_CONSENT_ANSWERED"), words)).toBe("redan besvarad");
  });

  it("leaves any other refusal as the gateway said it, and an unknown throw as the fallback", () => {
    expect(leaveConsentError(new ApiError(409, "Something else.", "SOMETHING_ELSE"), words)).toBe("Something else.");
    // A known code on another status is not that refusal.
    expect(leaveConsentError(new ApiError(500, "Boom.", "LEAVE_CONSENT_ANSWERED"), words)).toBe("Boom.");
    expect(leaveConsentError("boom", words)).toBe("fel");
  });
});
