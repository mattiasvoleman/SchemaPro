import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { DIRECT_REACH_UNANSWERED, DirectReachDeclined, isDirectReachRefusal } from "@/lib/direct-reach";

describe("the gateway's refusal of a change that reached families unasked", () => {
  it("is a 409 with its own code, and nothing else is", () => {
    expect(isDirectReachRefusal(new ApiError(409, "x", DIRECT_REACH_UNANSWERED))).toBe(true);
    expect(isDirectReachRefusal(new ApiError(409, "x", "MASTER_LESSON_REFUSED"))).toBe(false);
    expect(isDirectReachRefusal(new ApiError(403, "x", DIRECT_REACH_UNANSWERED))).toBe(false);
    expect(isDirectReachRefusal(new Error(DIRECT_REACH_UNANSWERED))).toBe(false);
    expect(isDirectReachRefusal(new DirectReachDeclined())).toBe(false);
  });

  it("is the code src/publication/direct-reach.ts sends", () => {
    expect(DIRECT_REACH_UNANSWERED).toBe("DIRECT_REACH_UNANSWERED");
  });
});
