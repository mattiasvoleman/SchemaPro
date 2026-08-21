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
    expect(strengthBand(10)).toBe("weak");
    expect(strengthBand(50)).toBe("normal");
    expect(strengthBand(100)).toBe("strong");
    expect(strengthBand(200)).toBe("veryStrong");
  });

  it("puts the default in the middle band", () => {
    // The default has to read as unremarkable, or every admin will fiddle.
    expect(strengthBand(STRENGTH_DEFAULT)).toBe("normal");
  });

  it("has no gaps or overlaps at the boundaries", () => {
    expect(strengthBand(29)).toBe("weak");
    expect(strengthBand(30)).toBe("normal");
    expect(strengthBand(79)).toBe("normal");
    expect(strengthBand(80)).toBe("strong");
    expect(strengthBand(149)).toBe("strong");
    expect(strengthBand(150)).toBe("veryStrong");
  });

  it("still answers for weights outside the slider's band", () => {
    expect(strengthBand(1)).toBe("weak");
    expect(strengthBand(1000)).toBe("veryStrong");
  });
});

describe("strengthBounds", () => {
  it("uses the usual band for an ordinary weight", () => {
    expect(strengthBounds(50)).toEqual({ min: STRENGTH_MIN, max: STRENGTH_MAX });
  });

  it("stretches to show a weight above the band rather than dragging it down", () => {
    // A rule saved at 500 must not become 200 just because someone opened the
    // form: the slider would silently rewrite a setting nobody touched.
    expect(strengthBounds(500)).toEqual({ min: STRENGTH_MIN, max: 500 });
  });

  it("stretches downward too", () => {
    expect(strengthBounds(1)).toEqual({ min: 1, max: STRENGTH_MAX });
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
