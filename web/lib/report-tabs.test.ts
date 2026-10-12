import { describe, expect, it } from "vitest";
import { reportTabOf } from "./report-tabs";

describe("reportTabOf", () => {
  it("reads the two named tabs and falls back to Närvaro", () => {
    expect(reportTabOf("staffing")).toBe("staffing");
    expect(reportTabOf("cover")).toBe("cover");
    expect(reportTabOf("attendance")).toBe("attendance");
    expect(reportTabOf("vikarie")).toBe("attendance");
    expect(reportTabOf(null)).toBe("attendance");
    expect(reportTabOf(undefined)).toBe("attendance");
  });
});

describe("report-tabs module", () => {
  it("is not a client module, so the server page can call it", async () => {
    // The 500 on /admin/reports was this function arriving on the server as
    // a client reference. The directive must never come back to this file.
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await readFile(path.resolve(__dirname, "report-tabs.ts"), "utf8");
    expect(source).not.toMatch(/^\s*["']use client["']/m);
  });
});
