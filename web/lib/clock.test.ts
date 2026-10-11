import { describe, expect, it } from "vitest";
import { clock } from "./clock";

describe("clock", () => {
  it.each([
    [0, "00:00"],
    [485, "08:05"],
    [720, "12:00"],
    // The end of a whole-day window, which lib/frame-times answers as 24 * 60.
    [1440, "24:00"],
  ])("prints %i minutes as %s", (minutes, expected) => {
    expect(clock(minutes)).toBe(expected);
  });
});
