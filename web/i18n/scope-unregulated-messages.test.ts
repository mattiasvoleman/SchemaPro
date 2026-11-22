import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

/**
 * The sentence a teacher past the edge only with the hours outside the stages is told (T7). The card's own next line says the
 * ordinance "anger ingen nivå för dem" and the interpretation below says 2 § counts those hours as teaching time, so the
 * first sentence must not say that the ordinance "säger inget om de timmarna": it does (2 §), and what it lacks is a level for them.
 */
const sentences = [
  ["sv", sv.staffing.scope.overOnlyWithUnregulated, /anger ingen nivå för de timmarna/, /säger inget/],
  ["sv, own", sv.staffing.scope.own.overOnlyWithUnregulated, /anger ingen nivå för de timmarna/, /säger inget/],
  ["en", en.staffing.scope.overOnlyWithUnregulated, /gives no level for those hours/, /says nothing/],
  ["en, own", en.staffing.scope.own.overOnlyWithUnregulated, /gives no level for those hours/, /says nothing/],
] as const;

describe("the sentence about hours outside the stages", () => {
  it.each(sentences)("%s: says the ordinance gives no level for them, and not that it says nothing of them", (_name, text, level, nothing) => {
    expect(text).toMatch(level);
    expect(text).not.toMatch(nothing);
  });
});
