import { describe, expect, it } from "vitest";
import { cn, formatTime, subjectColor, timeToMinutes } from "./utils";

describe("cn", () => {
  it("merges conflicting tailwind classes with the later one winning", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });

  it("drops falsy segments", () => {
    expect(cn("a", false && "b", undefined, "c")).toBe("a c");
  });
});

describe("formatTime", () => {
  it("truncates HH:MM:SS to HH:MM without parsing", () => {
    expect(formatTime("09:15:00")).toBe("09:15");
  });

  it("renders an ISO timestamp as a 24h wall-clock time", () => {
    // jsdom runs in UTC in this harness, so the instant renders as its
    // UTC wall-clock reading.
    expect(formatTime("2026-08-07T13:05:00.000Z")).toMatch(/^13:05$/);
  });
});

describe("timeToMinutes", () => {
  it("converts HH:MM to minutes since midnight", () => {
    expect(timeToMinutes("08:30")).toBe(510);
  });

  it("ignores a seconds component", () => {
    expect(timeToMinutes("08:30:45")).toBe(510);
  });
});

describe("subjectColor", () => {
  it("prefers the configured color", () => {
    expect(subjectColor("anything", "#123456")).toBe("#123456");
  });

  it("is deterministic per id when unconfigured", () => {
    expect(subjectColor("math-101")).toBe(subjectColor("math-101"));
  });

  it("returns a palette hex color", () => {
    expect(subjectColor("math-101")).toMatch(/^#[0-9a-f]{6}$/);
  });
});
