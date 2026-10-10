import { describe, expect, it } from "vitest";
import type { DraftLesson, PublicationRow, PublicationTimeline } from "@/lib/publication-types";
import {
  addDays,
  changedFields,
  currentSegment,
  defaultPublishWindow,
  isoWeekday,
  isWindowValid,
  lessonLine,
  mondayOnOrAfter,
  pendingCount,
  publicViewerUrl,
  segmentViews,
  tallyGates,
} from "@/lib/publication-view";

const YEAR = { startDate: "2026-08-17", endDate: "2027-06-11" };

describe("dates", () => {
  it("counts weekdays the ISO way from the string, never from the reader's clock", () => {
    // 2026-10-10 is a Saturday, 2026-10-12 a Monday, 2027-01-03 a Sunday.
    expect([isoWeekday("2026-10-10"), isoWeekday("2026-10-12"), isoWeekday("2027-01-03")]).toEqual([6, 1, 7]);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-03-28", -1)).toBe("2027-03-27");
  });

  it("finds the Monday on or after a date, keeping a Monday as it is", () => {
    expect(mondayOnOrAfter("2026-10-12")).toBe("2026-10-12");
    expect(mondayOnOrAfter("2026-10-13")).toBe("2026-10-19");
    expect(mondayOnOrAfter("2026-10-18")).toBe("2026-10-19");
  });
});

describe("defaultPublishWindow", () => {
  it("offers DIRECT from the school's today to the year's end, never from the past", () => {
    expect(defaultPublishWindow("DIRECT", "2026-10-14", YEAR)).toEqual({ validFrom: "2026-10-14", validTo: "2027-06-11" });
  });

  it("offers DRAFT from the next Monday, so no week is split by default", () => {
    expect(defaultPublishWindow("DRAFT", "2026-10-14", YEAR)).toEqual({ validFrom: "2026-10-19", validTo: "2027-06-11" });
    expect(defaultPublishWindow("DRAFT", "2026-10-12", YEAR).validFrom).toBe("2026-10-12");
  });

  it("starts a year that has not begun on its first day, and never past its last", () => {
    // 2026-08-17 is a Monday; the year starts after today.
    expect(defaultPublishWindow("DIRECT", "2026-06-01", YEAR).validFrom).toBe("2026-08-17");
    expect(defaultPublishWindow("DRAFT", "2026-06-01", YEAR).validFrom).toBe("2026-08-17");
    // The last week of the year: next Monday is past the end, so the end it is.
    expect(defaultPublishWindow("DRAFT", "2027-06-09", YEAR).validFrom).toBe("2027-06-11");
  });

  it("calls a window valid only inside the year and in order", () => {
    expect(isWindowValid({ validFrom: "2026-10-12", validTo: "2027-06-11" }, YEAR)).toBe(true);
    expect(isWindowValid({ validFrom: "2027-06-11", validTo: "2026-10-12" }, YEAR)).toBe(false);
    expect(isWindowValid({ validFrom: "2026-08-01", validTo: "2026-10-12" }, YEAR)).toBe(false);
    expect(isWindowValid({ validFrom: "", validTo: "2026-10-12" }, YEAR)).toBe(false);
  });
});

const row = (id: string, overrides: Partial<PublicationRow> = {}): PublicationRow => ({
  id,
  kind: "PUBLISH",
  outcome: "PUBLISHED",
  publishMode: "DRAFT",
  validFrom: "2026-08-17",
  validTo: "2027-06-11",
  publishedAt: "2026-08-10T08:00:00.000Z",
  publishedByUserId: null,
  created: 0,
  cancelled: 0,
  skipped: 0,
  moved: 0,
  removed: 0,
  adopted: 0,
  lessonCount: 10,
  gates: [],
  acknowledgedWarnings: false,
  ...overrides,
});

describe("segmentViews", () => {
  const timeline: PublicationTimeline = {
    academicYearId: "y",
    today: "2027-01-12",
    publications: [row("ht"), row("vt", { validFrom: "2027-01-11" }), row("next", { validFrom: "2027-03-01" })],
    segments: [
      { publicationId: "ht", from: "2026-08-17", to: "2027-01-10" },
      { publicationId: "vt", from: "2027-01-11", to: "2027-02-28" },
      { publicationId: "next", from: "2027-03-01", to: "2027-06-11" },
    ],
    validNow: "vt",
  };

  it("marks which publication was, is and will be valid on the school's today", () => {
    expect(segmentViews(timeline).map((segment) => [segment.publicationId, segment.when])).toEqual([
      ["ht", "past"],
      ["vt", "current"],
      ["next", "ahead"],
    ]);
    expect(currentSegment(timeline)?.publication?.id).toBe("vt");
    expect(currentSegment({ ...timeline, today: "2026-07-01" })).toBeNull();
  });

  it("counts a segment's first and last day as inside it", () => {
    expect(segmentViews({ ...timeline, today: "2027-01-11" })[1]!.when).toBe("current");
    expect(segmentViews({ ...timeline, today: "2027-02-28" })[1]!.when).toBe("current");
  });
});

const lesson = (overrides: Partial<DraftLesson> = {}): DraftLesson => ({
  id: "l",
  subjectId: "s-ma",
  studentGroupId: "g-7a",
  teacherId: "t-anna",
  coTeacherId: null,
  roomId: "r-12",
  dayOfWeek: 1,
  startTime: "08:00",
  endTime: "08:50",
  isParked: false,
  ...overrides,
});
const names = {
  subject: (id: string) => ({ "s-ma": "Matematik" })[id] ?? "?",
  group: (id: string) => ({ "g-7a": "7A" })[id] ?? "?",
  teacher: (id: string) => ({ "t-anna": "Anna Berg", "t-bo": "Bo Ek" })[id] ?? "?",
  room: (id: string) => ({ "r-12": "Sal 12" })[id] ?? "?",
  day: (day: number) => ["", "mån", "tis"][day] ?? "?",
};

describe("lessonLine and changedFields", () => {
  it("reads a lesson as the admin knows it, and a parked one without its time", () => {
    expect(lessonLine(lesson(), names, "parkerad")).toBe("Matematik · 7A · mån 08:00–08:50 · Anna Berg · Sal 12");
    expect(lessonLine(lesson({ isParked: true, roomId: null, teacherId: null }), names, "parkerad")).toBe(
      "Matematik · 7A · parkerad",
    );
  });

  it("says what a changed lesson changed, and nothing for weeks or dates the line does not show", () => {
    expect(changedFields(lesson(), lesson({ dayOfWeek: 2, teacherId: "t-bo" }))).toEqual(["time", "teacher"]);
    expect(changedFields(lesson(), lesson({ roomId: null, coTeacherId: "t-bo", isParked: true }))).toEqual([
      "coTeacher",
      "room",
      "parked",
    ]);
    expect(changedFields(lesson(), lesson())).toEqual([]);
  });

  it("counts the draft's pending changes", () => {
    expect(
      pendingCount({
        academicYearId: "y",
        publishMode: "DRAFT",
        publicationId: null,
        added: [lesson()],
        changed: [{ before: lesson(), after: lesson({ dayOfWeek: 2 }) }],
        removed: [],
        pendingRemovals: 4,
      }),
    ).toBe(2);
  });
});

describe("tallyGates and publicViewerUrl", () => {
  it("counts the checks by severity", () => {
    expect(
      tallyGates([
        { code: "PUB_CLASHES", severity: "REFUSE", count: 3, items: [], params: {} },
        { code: "PUB_NO_ROOM", severity: "WARN", count: 1, items: [], params: {} },
        { code: "PUB_PARKED", severity: "WARN", count: 2, items: [], params: {} },
        { code: "PUB_NOTHING_TO_PUBLISH", severity: "INFO", count: 1, items: [], params: {} },
      ]),
    ).toEqual({ refuse: 1, warn: 2, info: 1 });
  });

  it("builds the viewer's address from the origin, with no locale and no doubled slash", () => {
    expect(publicViewerUrl("https://schema.example.se/", "abc")).toBe("https://schema.example.se/v/abc");
  });
});
