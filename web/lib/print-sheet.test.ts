import { describe, expect, it } from "vitest";
import type { FamilySchedule } from "@/lib/family-schedule";
import { clockOf, isoWeekOf, plusDays, sheetFromFamily, sheetFromGrid } from "./print-sheet";

/**
 * A person's own printed week is the page on paper: built from what the page
 * drew, never read again.
 */

describe("the week arithmetic", () => {
  it("names ISO weeks across the year's turn, as the gateway does", () => {
    expect(isoWeekOf("2026-10-12")).toBe("2026-W42");
    expect(isoWeekOf("2026-12-28")).toBe("2026-W53");
    expect(isoWeekOf("2027-01-04")).toBe("2027-W01");
    expect(isoWeekOf("2024-12-30")).toBe("2025-W01");
  });

  it("writes clocks and shifts days without the reader's zone", () => {
    expect(clockOf(8 * 60 + 5)).toBe("08:05");
    expect(clockOf(13 * 60 + 40)).toBe("13:40");
    expect(plusDays("2026-10-31", 1)).toBe("2026-11-01");
  });
});

describe("sheetFromGrid", () => {
  it("carries a rastvaktspass as a duty, and one somebody else has as relieved (Rastvakt i vardagen)", () => {
    const sheet = sheetFromGrid({
      kind: "TEACHER",
      title: "Anna Lind",
      school: "Skolan",
      weekStart: new Date(2026, 9, 12),
      lessons: [
        { dayOfWeek: 1, startMinutes: 550, endMinutes: 565, title: "Rastvakt", subtitle: "Vikarie tar passet · Skolgården", room: "Norra", duty: true, relieved: true },
        { dayOfWeek: 2, startMinutes: 550, endMinutes: 565, title: "Rastvakt", subtitle: "Matsalen · Vikarie", duty: true },
      ],
    });
    expect(sheet.days[0]!.lessons[0]).toMatchObject({
      start: "09:10",
      end: "09:25",
      subject: "Rastvakt",
      groups: ["Vikarie tar passet · Skolgården"],
      room: "Norra",
      duty: true,
      relieved: true,
    });
    expect(sheet.days[1]!.lessons[0]).toMatchObject({ duty: true });
    expect(sheet.days[1]!.lessons[0]).not.toHaveProperty("relieved");
  });

  it("lays a page's lessons and meals into the week's seven days, sorted, with the line the page draws", () => {
    const sheet = sheetFromGrid({
      kind: "TEACHER",
      title: "Anna Lind",
      school: "Skolan",
      weekStart: new Date(2026, 9, 12),
      lessons: [
        { dayOfWeek: 3, startMinutes: 600, endMinutes: 650, title: "Matematik", subtitle: "7A · Vikarie", room: "Sal 12" },
        { dayOfWeek: 1, startMinutes: 540, endMinutes: 590, title: "Svenska", subtitle: "8B", cancelled: true },
        { dayOfWeek: 1, startMinutes: 480, endMinutes: 530, title: "Engelska" },
      ],
      meals: [{ dayOfWeek: 1, startMinutes: 690, endMinutes: 720 }],
    });
    expect(sheet.week).toEqual({ from: "2026-10-12", to: "2026-10-18", isoWeek: "2026-W42" });
    expect(sheet.days.map((day) => day.date)).toEqual([
      "2026-10-12",
      "2026-10-13",
      "2026-10-14",
      "2026-10-15",
      "2026-10-16",
      "2026-10-17",
      "2026-10-18",
    ]);
    expect(sheet.days[0]!.lessons.map((lesson) => [lesson.start, lesson.subject, lesson.cancelled])).toEqual([
      ["08:00", "Engelska", false],
      ["09:00", "Svenska", true],
    ]);
    expect(sheet.days[0]!.meals).toEqual([{ start: "11:30", end: "12:00" }]);
    expect(sheet.days[2]!.lessons[0]).toEqual({
      start: "10:00",
      end: "10:50",
      subject: "Matematik",
      groups: ["7A · Vikarie"],
      room: "Sal 12",
      teachers: [],
      cancelled: false,
    });
  });
});

describe("sheetFromFamily", () => {
  const schedule: FamilySchedule = {
    student: { id: "c-1", firstName: "Alva" },
    week: { from: "2026-10-12", to: "2026-10-18", isoWeek: "2026-W42" },
    today: "2026-10-14",
    bounds: { earliest: "2026-10-05", latest: "2027-06-07" },
    timezone: "Europe/Stockholm",
    lessons: [
      {
        id: "l-2", date: "2026-10-13", start: "10:00", end: "10:40", startsAt: "", endsAt: "", subjectId: "s",
        subject: "Idrott", subjectColor: null, room: "Hallen", teachers: ["ANLI"], status: "SCHEDULED", substitute: true,
      },
      {
        id: "l-1", date: "2026-10-13", start: "08:15", end: "09:00", startsAt: "", endsAt: "", subjectId: "s",
        subject: "Svenska", subjectColor: null, room: null, teachers: [], status: "CANCELLED", substitute: true,
      },
    ],
    lunches: [{ id: "m", date: "2026-10-13", start: "11:20", end: "11:45" }],
    rasts: [{ id: "r", date: "2026-10-13", start: "09:40", end: "10:00", name: "Rast" }],
  };

  it("keeps the school's clock, names teachers as the family's page does, says Vikarie, and leaves the rasts off paper", () => {
    const sheet = sheetFromFamily(schedule, "Skolan i Exempelby", "Vikarie");
    expect(sheet).toMatchObject({ kind: "PUPIL", title: "Alva", school: "Skolan i Exempelby", week: schedule.week });
    const tuesday = sheet.days[1]!;
    expect(tuesday.lessons).toEqual([
      { start: "08:15", end: "09:00", subject: "Svenska", groups: [], room: null, teachers: [], cancelled: true, note: null },
      { start: "10:00", end: "10:40", subject: "Idrott", groups: [], room: "Hallen", teachers: ["ANLI"], cancelled: false, note: "Vikarie" },
    ]);
    expect(tuesday.meals).toEqual([{ start: "11:20", end: "11:45" }]);
    expect(JSON.stringify(sheet)).not.toContain("Rast");
  });
});
