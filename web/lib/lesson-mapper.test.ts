import { describe, expect, it } from "vitest";
import { calendarLessonToGrid, calendarLunchToBand, isoWeekdayOf } from "./lesson-mapper";
import type {
  CalendarLessonRow,
  CalendarLunch,
  Room,
  StudentGroup,
  Subject,
} from "@/lib/types";

describe("isoWeekdayOf", () => {
  it("maps Monday to 1", () => {
    expect(isoWeekdayOf("2026-08-03")).toBe(1);
  });

  it("maps Saturday to 6", () => {
    expect(isoWeekdayOf("2026-08-08")).toBe(6);
  });

  it("maps Sunday to 7, not 0", () => {
    expect(isoWeekdayOf("2026-08-09")).toBe(7);
  });
});

const subject: Subject = {
  id: "sub-1",
  name: "Mathematics",
  code: "MA",
  color: "#123456",
  requiredRoomTypeId: null,
  nationalCode: null,
  countsTowardTimplan: true,
};
const group: StudentGroup = {
  id: "grp-1",
  academicYearId: "year-1",
  name: "9A",
  kind: "CLASS",
  gradeLevel: 9,
};
const room: Room = {
  id: "room-1",
  name: "R12",
  code: null,
  capacity: 30,
  roomTypeId: null,
  minGradeLevel: null,
  maxGradeLevel: null,
  requiresApproval: false,
  building: null,
  floor: null,
};

const row = (overrides: Partial<CalendarLessonRow> = {}): CalendarLessonRow => ({
  id: "les-1",
  subjectId: "sub-1",
  studentGroupId: "grp-1",
  roomId: "room-1",
  date: "2026-08-03",
  startsAt: "2026-08-03T08:30:00.000Z",
  endsAt: "2026-08-03T09:15:00.000Z",
  status: "SCHEDULED",
  note: null,
  ...overrides,
});

const maps = () => ({
  subjects: new Map([[subject.id, subject]]),
  groups: new Map([[group.id, group]]),
  rooms: new Map([[room.id, room]]),
});

describe("calendarLessonToGrid", () => {
  it("maps a fully-resolved row onto grid coordinates", () => {
    const { subjects, groups, rooms } = maps();
    const mapped = calendarLessonToGrid(row(), subjects, groups, rooms);
    expect(mapped).toEqual({
      id: "les-1",
      dayOfWeek: 1,
      startMinutes: 8 * 60 + 30,
      endMinutes: 9 * 60 + 15,
      title: "Mathematics",
      subtitle: "9A",
      room: "R12",
      color: "#123456",
      cancelled: false,
    });
  });

  it("marks CANCELLED rows as cancelled", () => {
    const { subjects, groups, rooms } = maps();
    const mapped = calendarLessonToGrid(row({ status: "CANCELLED" }), subjects, groups, rooms);
    expect(mapped.cancelled).toBe(true);
  });

  it("leaves the room unset when the row has no roomId", () => {
    const { subjects, groups, rooms } = maps();
    const mapped = calendarLessonToGrid(row({ roomId: null }), subjects, groups, rooms);
    expect(mapped.room).toBeUndefined();
  });

  it("leaves the room unset when the roomId is unknown to the map", () => {
    const { subjects, groups, rooms } = maps();
    const mapped = calendarLessonToGrid(row({ roomId: "missing" }), subjects, groups, rooms);
    expect(mapped.room).toBeUndefined();
  });

  it("falls back to an empty title and a deterministic palette color for an unknown subject", () => {
    const { groups, rooms } = maps();
    const mapped = calendarLessonToGrid(
      row({ subjectId: "unknown-subject" }),
      new Map(),
      groups,
      rooms,
    );
    expect(mapped.title).toBe("");
    expect(mapped.subtitle).toBe("9A");
    // Unconfigured color: deterministic hash into the palette.
    expect(mapped.color).toMatch(/^#[0-9a-f]{6}$/);
    const again = calendarLessonToGrid(
      row({ subjectId: "unknown-subject" }),
      new Map(),
      groups,
      rooms,
    );
    expect(again.color).toBe(mapped.color);
  });

  it("uses the palette fallback when the subject exists but has no configured color", () => {
    const { groups, rooms } = maps();
    const colorless = new Map([["sub-1", { ...subject, color: null }]]);
    const mapped = calendarLessonToGrid(row(), colorless, groups, rooms);
    expect(mapped.title).toBe("Mathematics");
    expect(mapped.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(mapped.color).not.toBe("#123456");
  });

  it("leaves the subtitle unset for an unknown group", () => {
    const { subjects, rooms } = maps();
    const mapped = calendarLessonToGrid(row(), subjects, new Map(), rooms);
    expect(mapped.subtitle).toBeUndefined();
  });

  it("derives minutes from the timestamps in the harness timezone (UTC)", () => {
    const { subjects, groups, rooms } = maps();
    const mapped = calendarLessonToGrid(
      row({
        startsAt: "2026-08-03T00:00:00.000Z",
        endsAt: "2026-08-03T23:59:00.000Z",
      }),
      subjects,
      groups,
      rooms,
    );
    expect(mapped.startMinutes).toBe(0);
    expect(mapped.endMinutes).toBe(23 * 60 + 59);
  });
});

describe("calendarLunchToBand", () => {
  const lunch = (overrides: Partial<CalendarLunch> = {}): CalendarLunch => ({
    id: "cl-1",
    studentGroupId: "g-7a",
    date: "2026-08-10", // a Monday
    startsAt: "2026-08-10T11:30:00.000Z",
    endsAt: "2026-08-10T12:00:00.000Z",
    ...overrides,
  });

  it("places the meal on the weekday of its own date", () => {
    expect(calendarLunchToBand(lunch(), "Lunch").dayOfWeek).toBe(1);
  });

  it("carries the label it is given rather than inventing one", () => {
    // The word is translated by the page; a hard-coded "Lunch" here would be
    // Swedish in an English portal.
    expect(calendarLunchToBand(lunch(), "Skollunch").label).toBe("Skollunch");
  });

  it("positions the meal the same way a lesson beside it is positioned", () => {
    /*
     * The shared `minutesOf` reads the instant in the READER's local time,
     * which is a limitation the whole calendar has. What must not happen is the
     * meal using a DIFFERENT rule: an hour's offset shared by everything is
     * invisible, while a lunch sitting between the wrong two lessons reads as a
     * bug. Asserting the two agree, not what the number is.
     */
    const band = calendarLunchToBand(lunch(), "Lunch");
    const lesson = calendarLessonToGrid(
      {
        id: "l-1",
        subjectId: "s-1",
        studentGroupId: "g-7a",
        roomId: null,
        date: "2026-08-10",
        startsAt: "2026-08-10T11:30:00.000Z",
        endsAt: "2026-08-10T12:00:00.000Z",
        status: "SCHEDULED",
        note: null,
      } as never,
      new Map(),
      new Map(),
      new Map(),
    );

    expect(band.startMinutes).toBe(lesson.startMinutes);
    expect(band.endMinutes).toBe(lesson.endMinutes);
    expect(band.dayOfWeek).toBe(lesson.dayOfWeek);
  });
});
