import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

/**
 * The form says, before a level is saved, that a level above the edge of the teacher's own stage counts to the edge. The gateway holds a
 * level to the highest edge of ANY stage (a teacher's stage changes with the schedule), so a level above that edge is refused with 400, and
 * a sentence that says "it is saved all the same" of every level over the teacher's own edge promises a save the gateway does not give
 * for the levels between the highest edge (650) and the form's own ceiling (1 500).
 */
describe("the form's sentence about a level over the teacher's own stage edge", () => {
  it("says that a level over every stage's edge is refused", () => {
    expect(sv.staffing.scopeAssessment.levelOverStageEdge).toMatch(/vägras/);
    expect(en.staffing.scopeAssessment.levelOverStageEdge).toMatch(/refused/);
  });
});
