import { describe, expect, it } from "vitest";
import { contactFields, contactProblem, hasLeaveExtras, policyAsks, EMPTY_CONTACT } from "./leave-policy";
import type { LeaveConsent, LeavePolicy } from "./types";

const FULL = { name: "Maria Ek", phone: "070-123 45 67", relation: "Mormor" };
const DEFAULT: LeavePolicy = { requireAllGuardians: false, minDaysAhead: null, shortNotice: "REFUSE", contact: "OFF" };
const NO_CONSENT: LeaveConsent = { required: false, state: "NOT_REQUIRED", mine: "NOT_ASKED", asked: null, given: null, waiting: null };

describe("the contact the form holds", () => {
  it("is no problem where the school does not ask, whatever is typed", () => {
    expect(contactProblem("OFF", EMPTY_CONTACT)).toBeNull();
    expect(contactProblem("OFF", { ...FULL, phone: "x" })).toBeNull();
  });

  it("may be left empty when optional, and must be given when required", () => {
    expect(contactProblem("OPTIONAL", EMPTY_CONTACT)).toBeNull();
    expect(contactProblem("REQUIRED", EMPTY_CONTACT)).toBe("REQUIRED");
    // Blanks are none.
    expect(contactProblem("REQUIRED", { name: "  ", phone: " ", relation: "" })).toBe("REQUIRED");
  });

  it("is all three or none, as the gateway has it", () => {
    expect(contactProblem("OPTIONAL", { ...EMPTY_CONTACT, name: "Maria Ek" })).toBe("INCOMPLETE");
    expect(contactProblem("REQUIRED", { ...FULL, relation: "" })).toBe("INCOMPLETE");
    expect(contactProblem("OPTIONAL", FULL)).toBeNull();
  });

  it("holds a phone number of digits, spaces and + ( ) -, five to thirty characters", () => {
    expect(contactProblem("OPTIONAL", { ...FULL, phone: "+46 (0)70-123 45 67" })).toBeNull();
    expect(contactProblem("OPTIONAL", { ...FULL, phone: "1234" })).toBe("PHONE");
    expect(contactProblem("OPTIONAL", { ...FULL, phone: "ring mig" })).toBe("PHONE");
    expect(contactProblem("OPTIONAL", { ...FULL, phone: "1".repeat(31) })).toBe("PHONE");
  });
});

describe("the contact in the request", () => {
  it("is sent trimmed, all three, only when the school asks and the form holds a valid one", () => {
    expect(contactFields("OPTIONAL", { name: " Maria Ek ", phone: " 070-123 45 67", relation: "Mormor " })).toEqual({
      contactName: "Maria Ek",
      contactPhone: "070-123 45 67",
      contactRelation: "Mormor",
    });
    expect(contactFields("OFF", FULL)).toEqual({});
    expect(contactFields("OPTIONAL", EMPTY_CONTACT)).toEqual({});
    expect(contactFields("OPTIONAL", { ...FULL, relation: "" })).toEqual({});
  });
});

describe("what the policy asks", () => {
  it("asks nothing as delivered, and something once any of the three is chosen", () => {
    expect(policyAsks(undefined)).toBe(false);
    expect(policyAsks(DEFAULT)).toBe(false);
    // A shortNotice of FLAG means nothing without a minimum.
    expect(policyAsks({ ...DEFAULT, shortNotice: "FLAG" })).toBe(false);
    expect(policyAsks({ ...DEFAULT, requireAllGuardians: true })).toBe(true);
    expect(policyAsks({ ...DEFAULT, minDaysAhead: 7 })).toBe(true);
    expect(policyAsks({ ...DEFAULT, contact: "OPTIONAL" })).toBe(true);
  });
});

describe("a request with more to say than its row", () => {
  const plain = { status: "PENDING" as const, contact: null, consent: NO_CONSENT };

  it("has nothing as delivered, also from a gateway that sends none of the fields", () => {
    expect(hasLeaveExtras(plain)).toBe(false);
    expect(hasLeaveExtras({ status: "PENDING" } as never)).toBe(false);
  });

  it("has something for a contact, a request for consent, a guardian's own part, and a guardian's no", () => {
    expect(hasLeaveExtras({ ...plain, contact: FULL })).toBe(true);
    expect(hasLeaveExtras({ ...plain, consent: { ...NO_CONSENT, required: true, state: "WAITING" } })).toBe(true);
    expect(hasLeaveExtras({ ...plain, consent: { ...NO_CONSENT, state: "GIVEN", mine: "GIVEN" } })).toBe(true);
    expect(hasLeaveExtras({ ...plain, status: "GUARDIAN_DECLINED" })).toBe(true);
  });
});
