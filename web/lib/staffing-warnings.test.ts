import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { MessageLookup } from "@/lib/engine-message";
import sv from "@/messages/sv.json";
import { refusalText, savedToast, staffingRefusal, warningText } from "./staffing-warnings";

const toasts = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

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

describe("savedToast", () => {
  /*
   * The vikarie and the re-teachered lesson: the gateway answers 200 with the
   * policy's WARN in `warnings`, and a plain "saved" toast threw it away — the
   * "warned, never refused" rule for a vikarie showed the rektor nothing.
   */
  beforeEach(() => {
    toasts.success.mockClear();
    toasts.warning.mockClear();
  });

  it("says saved when the policy had nothing to say", () => {
    savedToast(lookup({}), "Vikarie tillsatt", []);
    savedToast(lookup({}), "Vikarie tillsatt", undefined);
    expect(toasts.success).toHaveBeenCalledTimes(2);
    expect(toasts.warning).not.toHaveBeenCalled();
  });

  it("says saved WITH the policy's sentences when it warned, and holds the toast longer", () => {
    const t = lookup(sv.engineMessages as Record<string, string>);
    savedToast(t, "Vikarie tillsatt", [
      { code: "STAFF_TEACHER_NOT_QUALIFIED", params: { role: "SUBSTITUTE", subject: "Engelska", grades: "5" } },
    ]);
    expect(toasts.success).not.toHaveBeenCalled();
    const [title, options] = toasts.warning.mock.calls[0]!;
    expect(title).toBe("Vikarie tillsatt");
    expect(options.description).toContain('"role":"SUBSTITUTE"');
    expect(options.duration).toBeGreaterThan(4000);
  });
});
