import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import type { MessageLookup } from "@/lib/engine-message";
import sv from "@/messages/sv.json";
import { refusalText, staffingRefusal, warningText } from "./staffing-warnings";

/** A next-intl-shaped lookup over the real Swedish catalogue, without ICU. */
const lookup = (catalogue: Record<string, string>): MessageLookup => {
  const t = ((key: string, values?: Record<string, string | number>) =>
    `${catalogue[key]}|${JSON.stringify(values)}`) as MessageLookup;
  t.has = (key: string) => key in catalogue;
  return t;
};

describe("staffing warnings", () => {
  it("renders a WARN finding from the engine catalogue, with its params", () => {
    const t = lookup(sv.engineMessages as Record<string, string>);
    const text = warningText(t, {
      code: "STAFF_TEACHER_NOT_QUALIFIED",
      params: { role: "TEACHER", subject: "Matematik", grades: "7–9" },
    });
    expect(text).toContain("saknar behörighet");
    expect(text).toContain('"subject":"Matematik"');
  });

  it("falls back to the code for a sentence the web does not know yet", () => {
    const t = lookup({});
    expect(warningText(t, { code: "STAFF_SOMETHING_NEW", params: {} })).toBe("STAFF_SOMETHING_NEW");
  });

  it("every code the policy writes has a Swedish sentence", () => {
    for (const code of [
      "STAFF_TEACHER_NOT_QUALIFIED",
      "STAFF_TEACHER_OVER_TARGET",
      "STAFF_UNSTAFFED_REQUIREMENTS",
    ]) {
      expect(sv.engineMessages).toHaveProperty(code);
    }
  });
});

describe("staffingRefusal", () => {
  it("reads a 409 with a STAFF_* code as the policy's refusal", () => {
    const error = new ApiError(409, "Läraren skulle få 1200 min/v…", "STAFF_TEACHER_OVER_TARGET", {
      role: "TEACHER",
      minutes: 1200,
      target: 1080,
      limit: 1188,
      tolerance: 10,
    });
    const refusal = staffingRefusal(error);
    expect(refusal).toEqual({
      code: "STAFF_TEACHER_OVER_TARGET",
      params: { role: "TEACHER", minutes: 1200, target: 1080, limit: 1188, tolerance: 10 },
      message: "Läraren skulle få 1200 min/v…",
    });
    // Without the key the gateway's own Swedish is what is shown.
    expect(refusalText(lookup({}), refusal!)).toBe("Läraren skulle få 1200 min/v…");
  });

  it("is null for every other failure", () => {
    expect(staffingRefusal(new ApiError(409, "Krock", "LESSON_CLASH"))).toBeNull();
    expect(staffingRefusal(new ApiError(403, "Nej", "STAFF_TEACHER_NOT_QUALIFIED"))).toBeNull();
    expect(staffingRefusal(new Error("network"))).toBeNull();
  });
});
