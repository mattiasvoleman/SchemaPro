import { describe, expect, it } from "vitest";
import { acceptedDeviationsOf, deviationsOf, deviationsToAccept, ranBestEffort } from "./deviations";

describe("Bästa möjliga schema, read off a candidate", () => {
  const deviation = { category: "DEVIATION", code: "DEVIATION_ROOM_LOCK", message: "x", params: { lessons: 1, of: 2 } };

  it("tells a candidate from the mode with nothing given way from one that is not from the mode", () => {
    // NULL: not from the mode (or an older gateway sent no field). EMPTY: the
    // mode ran and nothing gave way. Neither is an avsteg to mark.
    expect(ranBestEffort({ deviations: null })).toBe(false);
    expect(ranBestEffort({})).toBe(false);
    expect(ranBestEffort({ deviations: [] })).toBe(true);
    expect(ranBestEffort({ deviations: [deviation] })).toBe(true);
    expect(deviationsOf({ deviations: null })).toEqual([]);
    expect(deviationsOf({})).toEqual([]);
    expect(deviationsOf({ deviations: [] })).toEqual([]);
    expect(deviationsOf({ deviations: [deviation] })).toEqual([deviation]);
  });

  it("accepts a candidate's own list first, and the check's when the candidate came without one", () => {
    expect(deviationsToAccept({ deviations: [deviation] }, { deviations: [] })).toEqual([deviation]);
    expect(deviationsToAccept({ deviations: undefined }, { deviations: [deviation] })).toEqual([deviation]);
    expect(deviationsToAccept({ deviations: null }, null)).toEqual([]);
    // An empty list of its own is the candidate's answer: the check does not overrule it.
    expect(deviationsToAccept({ deviations: [] }, { deviations: [deviation] })).toEqual([]);
  });

  it("hands back the candidate's own digest, and none at all for a candidate with nothing to accept", () => {
    expect(acceptedDeviationsOf({ deviations: [deviation], deviationsDigest: "abc" }, { deviationsDigest: "other" })).toBe("abc");
    // The check's digest is the fallback, not the first choice.
    expect(acceptedDeviationsOf({ deviations: [deviation], deviationsDigest: null }, { deviationsDigest: "from-check" })).toBe(
      "from-check",
    );
    expect(acceptedDeviationsOf({ deviations: [deviation], deviationsDigest: undefined }, null)).toBeNull();
    // Nothing given way: no digest, whatever either side carries.
    expect(acceptedDeviationsOf({ deviations: [], deviationsDigest: "stale" }, { deviationsDigest: "stale" })).toBeNull();
    expect(acceptedDeviationsOf({ deviations: null, deviationsDigest: "stale" }, null)).toBeNull();
  });
});
