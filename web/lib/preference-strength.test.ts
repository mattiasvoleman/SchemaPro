import { describe, expect, it } from "vitest";
import {
  clampStrength,
  STRENGTH_DEFAULT,
  STRENGTH_MAX,
  STRENGTH_MIN,
  strengthBand,
  strengthBounds,
} from "@/lib/preference-strength";

describe("strengthBand", () => {
  it("names the band a weight falls in", () => {
    expect(strengthBand(1)).toBe("weak");
    expect(strengthBand(5)).toBe("normal");
    expect(strengthBand(15)).toBe("strong");
    expect(strengthBand(50)).toBe("veryStrong");
  });

  it("is anchored to the objectives it competes with, not to the slider span", () => {
    // The engine sums every objective into one expression, so these numbers
    // are directly comparable: spread 3, preferred_busy 5, disruption 8,
    // preferred_free 10. A band that ignored them would describe a weight as
    // "weak" while it outweighed the entire rest of the objective.
    expect(strengthBand(2)).toBe("weak"); // under spread (3)
    expect(strengthBand(8)).toBe("normal"); // level with disruption
    expect(strengthBand(10)).toBe("strong"); // level with preferred_free
    expect(strengthBand(25)).toBe("veryStrong"); // multiples of everything
  });

  it("puts the default in the middle band", () => {
    // The default has to read as unremarkable, or every admin will fiddle.
    expect(strengthBand(STRENGTH_DEFAULT)).toBe("normal");
  });

  it("has no gaps or overlaps at the boundaries", () => {
    expect(strengthBand(2)).toBe("weak");
    expect(strengthBand(3)).toBe("normal");
    expect(strengthBand(9)).toBe("normal");
    expect(strengthBand(10)).toBe("strong");
    expect(strengthBand(24)).toBe("strong");
    expect(strengthBand(25)).toBe("veryStrong");
  });

  it("still answers for weights outside the slider's band", () => {
    expect(strengthBand(1)).toBe("weak");
    expect(strengthBand(1000)).toBe("veryStrong");
  });
});

describe("strengthBounds", () => {
  it("uses the usual band for an ordinary weight", () => {
    expect(strengthBounds(5)).toEqual({ min: STRENGTH_MIN, max: STRENGTH_MAX });
  });

  it("stretches to show a weight above the band rather than dragging it down", () => {
    // Rules created on the earlier 10-200 scale all sit above this maximum;
    // opening one must not silently rewrite a setting nobody touched.
    expect(strengthBounds(200)).toEqual({ min: STRENGTH_MIN, max: 200 });
    expect(strengthBounds(500)).toEqual({ min: STRENGTH_MIN, max: 500 });
  });

  it("stretches downward too", () => {
    expect(strengthBounds(0)).toEqual({ min: 0, max: STRENGTH_MAX });
  });
});

describe("clampStrength", () => {
  it("keeps a value the API accepts", () => {
    expect(clampStrength(50)).toBe(50);
  });

  it("holds the value inside the API's own range", () => {
    expect(clampStrength(0)).toBe(1);
    expect(clampStrength(5000)).toBe(1000);
  });

  it("rounds, because the field is an integer", () => {
    expect(clampStrength(49.6)).toBe(50);
  });

  it("falls back to the default rather than sending NaN", () => {
    expect(clampStrength(Number.NaN)).toBe(STRENGTH_DEFAULT);
  });
});
