import { describe, expect, it } from "vitest";
import { formatLoadFactor, parseLoadFactor } from "./load-factor";

describe("parseLoadFactor", () => {
  it("takes a decimal comma or point inside 0,5..3 with at most three decimals", () => {
    expect(parseLoadFactor("1")).toBe(1);
    expect(parseLoadFactor("0,8")).toBe(0.8);
    expect(parseLoadFactor(" 1.125 ")).toBe(1.125);
    expect(parseLoadFactor("0,5")).toBe(0.5);
    expect(parseLoadFactor("3")).toBe(3);
  });

  it("refuses what Subjects_loadFactor_is_sane and the DTO refuse", () => {
    for (const value of ["", "0,49", "3,001", "1,1234", "-1", "abc", "1,2,3", "Infinity"]) {
      expect(parseLoadFactor(value)).toBeNull();
    }
  });
});

describe("formatLoadFactor", () => {
  it("writes the stored factor with a decimal comma, and 1 for none", () => {
    expect(formatLoadFactor(1)).toBe("1");
    expect(formatLoadFactor(0.8)).toBe("0,8");
    expect(formatLoadFactor(1.125)).toBe("1,125");
    expect(formatLoadFactor(undefined)).toBe("1");
  });
});
