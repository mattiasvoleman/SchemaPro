import { describe, expect, it } from "vitest";
import {
  canStep,
  familyDays,
  lessonState,
  mondayOf,
  shiftDate,
  weekdayOf,
  weekNumber,
  type FamilyLesson,
  type FamilySchedule,
} from "./family-schedule";

/**
 * The family schedule's pure steps: the days of a week in the order they are
 * lived, a lesson's state, and the week bounds. Dates are strings throughout,
 * so nothing here depends on the reader's time zone — the suite runs under
 * the CI's zone and would pass under any other.
 */

const lesson = (id: string, date: string, start: string, over: Partial<FamilyLesson> = {}): FamilyLesson => ({
  id,
  date,
  start,
  end: "23:59",
  startsAt: `${date}T00:00:00.000Z`,
  endsAt: `${date}T00:00:00.000Z`,
  subjectId: "s",
  subject: "Matematik",
  subjectColor: null,
  room: "B204",
  teachers: [],
  status: "SCHEDULED",
  substitute: false,
  ...over,
});

const schedule = (over: Partial<FamilySchedule> = {}): FamilySchedule => ({
  student: { id: "c-1", firstName: "Alva" },
  week: { from: "2026-10-19", to: "2026-10-25", isoWeek: "2026-W43" },
  today: "2026-10-21",
  bounds: { earliest: "2026-10-12", latest: "2027-06-07" },
  timezone: "Europe/Stockholm",
  lessons: [],
  lunches: [],
  rasts: [],
  ...over,
});

describe("dates by their components", () => {
  it("shifts across a month, a year and the October clock change", () => {
    expect(shiftDate("2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftDate("2026-12-28", 7)).toBe("2027-01-04");
    expect(shiftDate("2026-10-24", 1)).toBe("2026-10-25");
    expect(shiftDate("2026-10-26", -1)).toBe("2026-10-25");
  });

  it("names the ISO weekday and the week's Monday", () => {
    expect(weekdayOf("2026-10-19")).toBe(1);
    expect(weekdayOf("2026-10-25")).toBe(7);
    expect(mondayOf("2026-10-25")).toBe("2026-10-19");
    expect(mondayOf("2027-01-01")).toBe("2026-12-28");
  });

  it("reads the week number out of the gateway's label", () => {
    expect(weekNumber("2026-W43")).toBe(43);
    expect(weekNumber("2027-W01")).toBe(1);
  });
});

describe("familyDays", () => {
  it("always has Monday to Friday, and a weekend day only when something is on it", () => {
    expect(familyDays(schedule()).map((day) => day.date)).toEqual([
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
    ]);
    const withSunday = familyDays(schedule({ lessons: [lesson("l", "2026-10-25", "10:00")] }));
    expect(withSunday.map((day) => day.weekday)).toEqual([1, 2, 3, 4, 5, 7]);
  });

  it("orders a day by start, a lesson before a rast before a lunch at the same minute", () => {
    const days = familyDays(
      schedule({
        lessons: [lesson("late", "2026-10-20", "13:00"), lesson("tie", "2026-10-20", "11:20"), lesson("early", "2026-10-20", "08:00")],
        rasts: [{ id: "r", date: "2026-10-20", start: "11:20", end: "11:40", name: "Lunchrast" }],
        lunches: [{ id: "m", date: "2026-10-20", start: "11:20", end: "11:50" }],
      }),
    );
    const tuesday = days.find((day) => day.date === "2026-10-20")!;
    expect(tuesday.entries.map((entry) => entry.key)).toEqual(["L:early", "L:tie", "R:r", "M:m", "L:late"]);
  });

  it("draws the school's HH:MM as they come, never through the reader's clock", () => {
    const [monday] = familyDays(schedule({ lessons: [lesson("l", "2026-10-19", "08:05", { end: "08:50" })] }));
    expect(monday!.entries[0]).toMatchObject({ start: "08:05", end: "08:50" });
  });
});

describe("lessonState", () => {
  it("says cancelled before substitute, and scheduled otherwise", () => {
    expect(lessonState(lesson("a", "2026-10-19", "08:00", { status: "CANCELLED", substitute: true }))).toBe("cancelled");
    expect(lessonState(lesson("b", "2026-10-19", "08:00", { substitute: true }))).toBe("substitute");
    expect(lessonState(lesson("c", "2026-10-19", "08:00", { status: "COMPLETED" }))).toBe("scheduled");
  });
});

describe("canStep", () => {
  it("stops at the first and the last week the gateway answers", () => {
    expect(canStep(schedule(), -1)).toBe(true);
    expect(canStep(schedule({ week: { from: "2026-10-12", to: "2026-10-18", isoWeek: "2026-W42" } }), -1)).toBe(false);
    expect(canStep(schedule({ week: { from: "2027-05-31", to: "2027-06-06", isoWeek: "2027-W22" } }), 1)).toBe(true);
    expect(canStep(schedule({ week: { from: "2027-06-07", to: "2027-06-13", isoWeek: "2027-W23" } }), 1)).toBe(false);
  });

  it("has no last week without an active year", () => {
    expect(canStep(schedule({ bounds: { earliest: "2026-10-12", latest: null } }), 1)).toBe(true);
  });
});
