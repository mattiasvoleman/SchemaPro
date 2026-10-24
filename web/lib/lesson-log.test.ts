import { describe, expect, it } from "vitest";
import {
  byDate,
  classBookPeriod,
  cleanText,
  daysBetween,
  defaultPeriod,
  entriesByLesson,
  isDay,
  logChanged,
  noteChanged,
  shiftDay,
  textLength,
  type ClassBookLesson,
} from "./lesson-log";

describe("lesson-log helpers", () => {
  it("cleans text as the gateway stores it: trimmed, CRLF as LF, nothing as null", () => {
    expect(cleanText("  Bråk \r\n")).toBe("Bråk");
    expect(cleanText("Rad ett\r\nrad två")).toBe("Rad ett\nrad två");
    expect(cleanText(" \n\t ")).toBeNull();
    expect(cleanText(null)).toBeNull();
    expect(cleanText(undefined)).toBeNull();
  });

  it("counts characters as the database does, a code point each", () => {
    expect(textLength("📐".repeat(3))).toBe(3);
    expect(textLength("åäö")).toBe(3);
  });

  it("knows whether a form says something other than what is saved", () => {
    const saved = { topic: "Bråk", homework: null, writtenBy: null, updatedAt: "x" };
    expect(logChanged(saved, " Bråk ", "")).toBe(false);
    expect(logChanged(saved, "Bråk", "Läs")).toBe(true);
    expect(logChanged(null, "", "  ")).toBe(false);
    expect(noteChanged(null, "")).toBe(false);
    expect(noteChanged({ body: "Hej", writtenBy: null, updatedAt: "x" }, "Hej\n")).toBe(false);
    expect(noteChanged({ body: "Hej", writtenBy: null, updatedAt: "x" }, "")).toBe(true);
  });

  it("walks days by their components and counts a period inclusively", () => {
    expect(shiftDay("2026-10-30", 3)).toBe("2026-11-02");
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysBetween("2026-10-19", "2026-10-19")).toBe(1);
    expect(daysBetween("2026-08-01", "2027-02-16")).toBe(200);
    expect(daysBetween("2026-10-20", "2026-10-19")).toBe(0);
    expect(daysBetween("nej", "2026-10-19")).toBe(0);
  });

  it("knows a real day", () => {
    expect(isDay("2026-02-28")).toBe(true);
    expect(isDay("2026-02-30")).toBe(false);
    expect(isDay("2026-2-3")).toBe(false);
    expect(isDay(null)).toBe(false);
  });

  it("opens the klassbok on the school days of the week holding today, a Sunday included", () => {
    expect(defaultPeriod("2026-10-21")).toEqual({ from: "2026-10-19", to: "2026-10-23" });
    expect(defaultPeriod("2026-10-25")).toEqual({ from: "2026-10-19", to: "2026-10-23" });
    expect(defaultPeriod("2026-10-19")).toEqual({ from: "2026-10-19", to: "2026-10-23" });
  });

  it("opens the klassbok on the URL's days, or the school's week as Stockholm counts it, whatever the clock's zone", () => {
    expect(classBookPeriod("2026-09-01", "2026-09-30")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    // Sunday 23:30 UTC is Monday 01:30 in Stockholm: the new week.
    expect(classBookPeriod(null, null, new Date("2026-10-25T23:30:00Z"))).toEqual({ from: "2026-10-26", to: "2026-10-30" });
    expect(classBookPeriod("2026-02-30", "nej", new Date("2026-10-21T12:00:00Z"))).toEqual({ from: "2026-10-19", to: "2026-10-23" });
  });

  it("groups the klassbok's lessons by date in the gateway's order, and indexes entries by lesson", () => {
    const lesson = (id: string, date: string) => ({ id, date }) as ClassBookLesson;
    expect(byDate([lesson("a", "2026-10-19"), lesson("b", "2026-10-19"), lesson("c", "2026-10-20")]).map((day) => [day.date, day.lessons.map((l) => l.id)])).toEqual([
      ["2026-10-19", ["a", "b"]],
      ["2026-10-20", ["c"]],
    ]);
    expect(entriesByLesson([{ lessonId: "a", topic: "x", homework: null }]).get("a")?.topic).toBe("x");
    expect(entriesByLesson(undefined).size).toBe(0);
  });
});
