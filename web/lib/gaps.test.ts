import { describe, expect, it } from "vitest";
import { buildGroupConflictMap, validatePlacement, type Placement } from "@/lib/conflicts";
import type {
  AvailabilityConstraint,
  LessonRecurrence,
  LunchSettings,
} from "@/lib/types";
import {
  DEFAULT_MINIMUM_GAP_MINUTES,
  findFreeWindows,
  findIdleGaps,
  lunchWindowOf,
  whoIsFree,
} from "./gaps";

// ---------------------------------------------------------------------------
// Factories. A lesson defaults to Monday 08:00–09:00 for a group nobody else
// shares, so any clash a test sees is one it asked for. Times are written as
// hours because every question here is read off a wall clock.
// ---------------------------------------------------------------------------

const hm = (hour: number, minute = 0) => hour * 60 + minute;

let seq = 0;

function lesson(overrides: Partial<Placement> = {}): Placement {
  seq += 1;
  return {
    id: `L${seq}`,
    dayOfWeek: 1,
    startMinutes: hm(8),
    endMinutes: hm(9),
    teacherId: null,
    roomId: null,
    studentGroupId: `unique-group-${seq}`,
    ...overrides,
  };
}

/** A lesson for one class, written as "from–to". */
function classLesson(
  studentGroupId: string,
  startMinutes: number,
  endMinutes: number,
  overrides: Partial<Placement> = {},
): Placement {
  return lesson({ studentGroupId, startMinutes, endMinutes, ...overrides });
}

function teacherLesson(
  teacherId: string,
  startMinutes: number,
  endMinutes: number,
  overrides: Partial<Placement> = {},
): Placement {
  return lesson({ teacherId, startMinutes, endMinutes, ...overrides });
}

function constraint(overrides: Partial<AvailabilityConstraint> = {}): AvailabilityConstraint {
  return {
    id: "c1",
    resourceType: "STUDENT_GROUP",
    userId: null,
    roomId: null,
    studentGroupId: null,
    minGradeLevel: null,
    maxGradeLevel: null,
    dayOfWeek: 1,
    date: null,
    startTime: "12:00",
    endTime: "13:00",
    type: "UNAVAILABLE",
    reason: null,
    ...overrides,
  };
}

function lunchSettings(overrides: Partial<LunchSettings> = {}): LunchSettings {
  return {
    id: "lunch-1",
    lunchEnabled: true,
    lunchStartTime: "11:00:00",
    lunchEndTime: "12:30:00",
    lunchMinutes: 30,
    diningSeats: null,
    maxLessonsPerDayPerGroup: null,
    ...overrides,
  };
}

/** Monday only, 08:00–16:00 — the span most expectations are written against. */
const monday = { days: [1], dayStartMinutes: hm(8), dayEndMinutes: hm(16) };

// ---------------------------------------------------------------------------
// lunchWindowOf
// ---------------------------------------------------------------------------

describe("lunchWindowOf", () => {
  it("reads the school's window and duration as minutes", () => {
    expect(lunchWindowOf(lunchSettings())).toEqual({
      startMinutes: hm(11),
      endMinutes: hm(12, 30),
      minutes: 30,
    });
  });

  it("gives no lunch credit when the school has switched lunch off", () => {
    expect(lunchWindowOf(lunchSettings({ lunchEnabled: false }))).toBeNull();
    expect(lunchWindowOf(null)).toBeNull();
    expect(lunchWindowOf(undefined)).toBeNull();
  });

  it("ignores a window that ends before it starts", () => {
    expect(
      lunchWindowOf(lunchSettings({ lunchStartTime: "12:30:00", lunchEndTime: "11:00:00" })),
    ).toBeNull();
  });

  it("never credits more lunch than the window can hold", () => {
    // 90-minute window, a saved duration of 120: the extra half hour is not
    // lunch and must not excuse half an hour of håltimme.
    expect(lunchWindowOf(lunchSettings({ lunchMinutes: 120 }))?.minutes).toBe(90);
  });

  it("credits nothing when the duration is missing or nonsense", () => {
    expect(lunchWindowOf(lunchSettings({ lunchMinutes: Number.NaN }))?.minutes).toBe(0);
    expect(lunchWindowOf(lunchSettings({ lunchMinutes: -30 }))?.minutes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// findFreeWindows
// ---------------------------------------------------------------------------

describe("findFreeWindows", () => {
  it("returns the maximal windows around a class's lessons", () => {
    const placements = [
      classLesson("7A", hm(8), hm(9)),
      classLesson("7A", hm(12), hm(13)),
    ];

    expect(
      findFreeWindows({
        studentGroupIds: ["7A"],
        minimumMinutes: 30,
        placements,
        constraints: [],
        ...monday,
      }),
    ).toEqual([
      { dayOfWeek: 1, startMinutes: hm(9), endMinutes: hm(12), weeks: "ALL_WEEKS" },
      { dayOfWeek: 1, startMinutes: hm(13), endMinutes: hm(16), weeks: "ALL_WEEKS" },
    ]);
  });

  it("reads back-to-back and overlapping lessons as one busy stretch, in any order", () => {
    // Lessons arrive in the order the API sent them, which is not chronological.
    const placements = [
      classLesson("7A", hm(9, 30), hm(11)), // overlaps the 09:00 lesson
      classLesson("7A", hm(8), hm(9)),
      classLesson("7A", hm(9), hm(10)), // starts as 08:00–09:00 ends
    ];
    // What this pins is the sort: fed in this order without one, the 09:30
    // lesson would open the day and the two before it would be read as holes.

    expect(
      findFreeWindows({
        studentGroupIds: ["7A"],
        minimumMinutes: 30,
        placements,
        constraints: [],
        ...monday,
      }),
    ).toEqual([
      { dayOfWeek: 1, startMinutes: hm(11), endMinutes: hm(16), weeks: "ALL_WEEKS" },
    ]);
  });

  it("ignores busy time outside the searched span", () => {
    const placements = [
      classLesson("7A", hm(5), hm(5, 30)), // over before the search begins
      classLesson("7A", hm(6), hm(8)), // ends exactly when the search starts
      classLesson("7A", hm(16), hm(17)), // starts exactly when it ends
      classLesson("7A", hm(7), hm(9)), // straddles the opening bound
    ];

    expect(
      findFreeWindows({
        studentGroupIds: ["7A"],
        minimumMinutes: 30,
        placements,
        constraints: [],
        ...monday,
      }),
    ).toEqual([
      { dayOfWeek: 1, startMinutes: hm(9), endMinutes: hm(16), weeks: "ALL_WEEKS" },
    ]);
  });

  it("keeps a window exactly the minimum length and drops one a minute shorter", () => {
    const placements = [
      classLesson("7A", hm(8), hm(9)),
      classLesson("7A", hm(10), hm(16)),
    ];
    const query = {
      studentGroupIds: ["7A"],
      placements,
      constraints: [],
      ...monday,
    };

    expect(findFreeWindows({ ...query, minimumMinutes: 60 })).toEqual([
      { dayOfWeek: 1, startMinutes: hm(9), endMinutes: hm(10), weeks: "ALL_WEEKS" },
    ]);
    expect(findFreeWindows({ ...query, minimumMinutes: 61 })).toEqual([]);
  });

  it("answers for a class, a teacher and a room at once — all must be free", () => {
    const placements = [
      classLesson("7A", hm(8), hm(9)),
      teacherLesson("t1", hm(10), hm(11)),
      lesson({ roomId: "r1", startMinutes: hm(12), endMinutes: hm(13) }),
    ];

    expect(
      findFreeWindows({
        studentGroupIds: ["7A"],
        teacherIds: ["t1"],
        roomIds: ["r1"],
        minimumMinutes: 30,
        placements,
        constraints: [],
        ...monday,
      }),
    ).toEqual([
      { dayOfWeek: 1, startMinutes: hm(9), endMinutes: hm(10), weeks: "ALL_WEEKS" },
      { dayOfWeek: 1, startMinutes: hm(11), endMinutes: hm(12), weeks: "ALL_WEEKS" },
      { dayOfWeek: 1, startMinutes: hm(13), endMinutes: hm(16), weeks: "ALL_WEEKS" },
    ]);
  });

  it("counts a lesson of a teaching group that shares pupils with the class", () => {
    const groupConflicts = buildGroupConflictMap(
      new Map([["s-1", "g-7a"]]),
      [{ studentId: "s-1", studentGroupId: "g-ma71" }],
    );
    const placements = [classLesson("g-ma71", hm(10), hm(11))];
    const query = {
      studentGroupIds: ["g-7a"],
      minimumMinutes: 30,
      placements,
      constraints: [],
      ...monday,
    };

    expect(findFreeWindows({ ...query, groupConflicts }).map((w) => w.startMinutes)).toEqual([
      hm(8),
      hm(11),
    ]);
    // The non-vacuity twin: without a shared pupil the two groups are strangers
    // and Ma71's lesson takes nothing away from 7A.
    expect(findFreeWindows(query).map((w) => w.startMinutes)).toEqual([hm(8)]);
  });

  it("counts an elective booked on individual pupils as busying their class", () => {
    const studentGroupOf = new Map([["s-1", "7A"]]);
    const placements = [
      lesson({ studentGroupId: "elective", studentIds: ["s-1"], startMinutes: hm(10), endMinutes: hm(11) }),
    ];
    const query = {
      studentGroupIds: ["7A"],
      minimumMinutes: 30,
      placements,
      constraints: [],
      ...monday,
    };

    expect(findFreeWindows({ ...query, studentGroupOf }).map((w) => w.endMinutes)).toEqual([
      hm(10),
      hm(16),
    ]);
    // Without the home-class lookup the elective belongs to nobody in 7A.
    expect(findFreeWindows(query).map((w) => w.endMinutes)).toEqual([hm(16)]);
  });

  it("treats a weekly UNAVAILABLE rule as busy time", () => {
    const closed = constraint({ studentGroupId: "7A", startTime: "12:00", endTime: "13:00" });
    const query = {
      studentGroupIds: ["7A"],
      minimumMinutes: 30,
      placements: [],
      ...monday,
    };

    expect(findFreeWindows({ ...query, constraints: [closed] })).toEqual([
      { dayOfWeek: 1, startMinutes: hm(8), endMinutes: hm(12), weeks: "ALL_WEEKS" },
      { dayOfWeek: 1, startMinutes: hm(13), endMinutes: hm(16), weeks: "ALL_WEEKS" },
    ]);
    // Same day, same class, no rule: one uninterrupted window.
    expect(findFreeWindows({ ...query, constraints: [] })).toEqual([
      { dayOfWeek: 1, startMinutes: hm(8), endMinutes: hm(16), weeks: "ALL_WEEKS" },
    ]);
  });

  it("ignores rules aimed at somebody else, at a date, or at no weekday", () => {
    const query = {
      studentGroupIds: ["7A"],
      minimumMinutes: 30,
      placements: [],
      ...monday,
    };
    const whole = [
      { dayOfWeek: 1, startMinutes: hm(8), endMinutes: hm(16), weeks: "ALL_WEEKS" as const },
    ];

    expect(
      findFreeWindows({ ...query, constraints: [constraint({ studentGroupId: "7B" })] }),
    ).toEqual(whole);
    expect(
      findFreeWindows({
        ...query,
        constraints: [constraint({ studentGroupId: "7A", date: "2026-09-01" })],
      }),
    ).toEqual(whole);
    expect(
      findFreeWindows({
        ...query,
        constraints: [constraint({ studentGroupId: "7A", dayOfWeek: null })],
      }),
    ).toEqual(whole);
    // A wish is not an occupation.
    expect(
      findFreeWindows({
        ...query,
        constraints: [constraint({ studentGroupId: "7A", type: "PREFERRED_FREE" })],
      }),
    ).toEqual(whole);
  });

  it("offers an every-other-week window as one, without hiding the weekly ones", () => {
    const placements = [
      classLesson("7A", hm(10), hm(11), { recurrence: "ODD_WEEKS" }),
    ];
    const query = {
      studentGroupIds: ["7A"],
      minimumMinutes: 30,
      placements,
      constraints: [],
      days: [1],
      dayStartMinutes: hm(8),
      dayEndMinutes: hm(12),
    };

    expect(findFreeWindows(query)).toEqual([
      { dayOfWeek: 1, startMinutes: hm(8), endMinutes: hm(10), weeks: "ALL_WEEKS" },
      { dayOfWeek: 1, startMinutes: hm(8), endMinutes: hm(12), weeks: "EVEN_WEEKS" },
      { dayOfWeek: 1, startMinutes: hm(11), endMinutes: hm(12), weeks: "ALL_WEEKS" },
    ]);
    // The same lesson every week: no parity-only window exists to report.
    expect(
      findFreeWindows({
        ...query,
        placements: [classLesson("7A", hm(10), hm(11))],
      }),
    ).toEqual([
      { dayOfWeek: 1, startMinutes: hm(8), endMinutes: hm(10), weeks: "ALL_WEEKS" },
      { dayOfWeek: 1, startMinutes: hm(11), endMinutes: hm(12), weeks: "ALL_WEEKS" },
    ]);
  });

  it("reports a slot shared by two alternating lessons as free in neither week", () => {
    const placements = [
      classLesson("7A", hm(10), hm(11), { recurrence: "ODD_WEEKS" }),
      classLesson("7A", hm(10), hm(11), { recurrence: "EVEN_WEEKS" }),
    ];

    expect(
      findFreeWindows({
        studentGroupIds: ["7A"],
        minimumMinutes: 30,
        placements,
        constraints: [],
        days: [1],
        dayStartMinutes: hm(8),
        dayEndMinutes: hm(12),
      }),
    ).toEqual([
      { dayOfWeek: 1, startMinutes: hm(8), endMinutes: hm(10), weeks: "ALL_WEEKS" },
      { dayOfWeek: 1, startMinutes: hm(11), endMinutes: hm(12), weeks: "ALL_WEEKS" },
    ]);
  });

  it("offers the every-week window two alternating lessons leave between them", () => {
    // The ordinary slöjd/hemkunskap arrangement. 11:00–12:00 is free in every
    // week of the year, but it is nobody's maximal window: odd weeks are free
    // 11:00–16:00 and even weeks 08:00–12:00. Offering only those two would
    // hand a schedule-maker looking for a weekly hour two half-answers to
    // intersect in their head.
    const placements = [
      classLesson("7A", hm(10), hm(11), { recurrence: "ODD_WEEKS" }),
      classLesson("7A", hm(12), hm(13), { recurrence: "EVEN_WEEKS" }),
    ];
    const query = {
      studentGroupIds: ["7A"],
      minimumMinutes: 60,
      placements,
      constraints: [],
      ...monday,
    };

    expect(findFreeWindows(query)).toEqual([
      { dayOfWeek: 1, startMinutes: hm(8), endMinutes: hm(10), weeks: "ALL_WEEKS" },
      { dayOfWeek: 1, startMinutes: hm(8), endMinutes: hm(12), weeks: "EVEN_WEEKS" },
      { dayOfWeek: 1, startMinutes: hm(11), endMinutes: hm(12), weeks: "ALL_WEEKS" },
      { dayOfWeek: 1, startMinutes: hm(11), endMinutes: hm(16), weeks: "ODD_WEEKS" },
      { dayOfWeek: 1, startMinutes: hm(13), endMinutes: hm(16), weeks: "ALL_WEEKS" },
    ]);
    // The control: the same two lessons every week leave the same three
    // every-week windows and no parity-only ones at all.
    expect(
      findFreeWindows({
        ...query,
        placements: [classLesson("7A", hm(10), hm(11)), classLesson("7A", hm(12), hm(13))],
      }),
    ).toEqual([
      { dayOfWeek: 1, startMinutes: hm(8), endMinutes: hm(10), weeks: "ALL_WEEKS" },
      { dayOfWeek: 1, startMinutes: hm(11), endMinutes: hm(12), weeks: "ALL_WEEKS" },
      { dayOfWeek: 1, startMinutes: hm(13), endMinutes: hm(16), weeks: "ALL_WEEKS" },
    ]);
  });

  it("answers for two classes at once — either one's lesson takes the slot", () => {
    // The headline query: when are 7A and 8B both free?
    const placements = [classLesson("7A", hm(9), hm(10)), classLesson("8B", hm(12), hm(13))];
    const query = {
      minimumMinutes: 30,
      placements,
      constraints: [],
      ...monday,
    };

    expect(
      findFreeWindows({ ...query, studentGroupIds: ["7A", "8B"] }).map((w) => [
        w.startMinutes,
        w.endMinutes,
      ]),
    ).toEqual([
      [hm(8), hm(9)],
      [hm(10), hm(12)],
      [hm(13), hm(16)],
    ]);
    // Asked about 7A alone, 8B's lesson is somebody else's business and the
    // afternoon is one uninterrupted window — so the split above is 8B's.
    expect(
      findFreeWindows({ ...query, studentGroupIds: ["7A"] }).map((w) => [
        w.startMinutes,
        w.endMinutes,
      ]),
    ).toEqual([
      [hm(8), hm(9)],
      [hm(10), hm(16)],
    ]);
  });

  it("counts a term-limited lesson only in the week the caller names", () => {
    // A course that ran until the Christmas break. Asked of the year as a
    // whole it occupies its slot, which is the conservative reading; asked of
    // a week in February it does not exist.
    const placements = [
      classLesson("7A", hm(10), hm(11), { startDate: "2025-08-11", endDate: "2025-12-19" }),
    ];
    const query = {
      studentGroupIds: ["7A"],
      minimumMinutes: 30,
      placements,
      constraints: [],
      ...monday,
    };
    const spans = (windows: ReturnType<typeof findFreeWindows>) =>
      windows.map((w) => [w.startMinutes, w.endMinutes]);

    expect(spans(findFreeWindows(query))).toEqual([
      [hm(8), hm(10)],
      [hm(11), hm(16)],
    ]);
    expect(spans(findFreeWindows({ ...query, onDate: "2025-09-15" }))).toEqual([
      [hm(8), hm(10)],
      [hm(11), hm(16)],
    ]);
    expect(spans(findFreeWindows({ ...query, onDate: "2026-02-16" }))).toEqual([
      [hm(8), hm(16)],
    ]);
    expect(spans(findFreeWindows({ ...query, onDate: "2025-08-04" }))).toEqual([
      [hm(8), hm(16)],
    ]);
  });

  it("searches Monday to Friday, 08:00–17:00, when the caller says nothing", () => {
    const windows = findFreeWindows({
      teacherIds: ["t1"],
      minimumMinutes: 30,
      placements: [],
      constraints: [],
    });

    expect(windows.map((w) => w.dayOfWeek)).toEqual([1, 2, 3, 4, 5]);
    expect(windows.every((w) => w.startMinutes === hm(8) && w.endMinutes === hm(17))).toBe(true);
  });

  it("answers a question about nobody with nothing", () => {
    const query = { minimumMinutes: 30, placements: [], constraints: [], ...monday };

    expect(findFreeWindows(query)).toEqual([]);
    // …while the same question about one class answers with the whole day, so
    // the empty result above is the empty selection and not a broken search.
    expect(findFreeWindows({ ...query, studentGroupIds: ["7A"] })).toEqual([
      { dayOfWeek: 1, startMinutes: hm(8), endMinutes: hm(16), weeks: "ALL_WEEKS" },
    ]);
  });

  it("ignores a lesson that ends when it starts", () => {
    expect(
      findFreeWindows({
        studentGroupIds: ["7A"],
        minimumMinutes: 30,
        placements: [classLesson("7A", hm(10), hm(10))],
        constraints: [],
        ...monday,
      }),
    ).toEqual([
      { dayOfWeek: 1, startMinutes: hm(8), endMinutes: hm(16), weeks: "ALL_WEEKS" },
    ]);
  });

  it("ignores a rule that ends when it starts", () => {
    expect(
      findFreeWindows({
        studentGroupIds: ["7A"],
        minimumMinutes: 30,
        placements: [],
        constraints: [
          constraint({ studentGroupId: "7A", startTime: "12:00", endTime: "12:00" }),
        ],
        ...monday,
      }),
    ).toEqual([
      { dayOfWeek: 1, startMinutes: hm(8), endMinutes: hm(16), weeks: "ALL_WEEKS" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// findIdleGaps
// ---------------------------------------------------------------------------

describe("findIdleGaps", () => {
  it("reports the hole between two lessons and nothing outside them", () => {
    // The class is at school 09:00–13:00. The hours before and after are not
    // idle time — they are not at school — and must not appear.
    const placements = [
      classLesson("7A", hm(9), hm(10)),
      classLesson("7A", hm(12), hm(13)),
    ];

    expect(
      findIdleGaps({ studentGroupIds: ["7A"], placements, constraints: [], days: [1] }),
    ).toEqual([
      {
        subjectId: "7A",
        kind: "STUDENT_GROUP",
        gaps: [
          {
            dayOfWeek: 1,
            startMinutes: hm(10),
            endMinutes: hm(12),
            weeks: "ALL_WEEKS",
            minutes: 120,
            lunchMinutes: 0,
            idleMinutes: 120,
            idleStudents: 0,
          },
        ],
        totalMinutes: 120,
        worstMinutes: 120,
        studentCount: 0,
      },
    ]);
  });

  it("has nothing to say about a day with one lesson, or with none", () => {
    const oneLesson = [classLesson("7A", hm(9), hm(10))];

    expect(
      findIdleGaps({
        studentGroupIds: ["7A"],
        placements: oneLesson,
        constraints: [],
        days: [1, 2],
      }),
    ).toEqual([]);
    expect(
      findIdleGaps({ studentGroupIds: ["7A"], placements: [], constraints: [], days: [1] }),
    ).toEqual([]);
    // The control: one more lesson that day and the hole between them appears.
    expect(
      findIdleGaps({
        studentGroupIds: ["7A"],
        placements: [...oneLesson, classLesson("7A", hm(11), hm(12))],
        constraints: [],
        days: [1, 2],
      }).map((report) => report.totalMinutes),
    ).toEqual([60]);
  });

  it("reads a short lesson nested inside a long one as one busy stretch", () => {
    // The case a sort alone gets wrong: the last lesson of the morning to
    // start is not the last to end, so the hole after it starts at 11:00.
    const placements = [
      classLesson("7A", hm(9), hm(11)),
      classLesson("7A", hm(9, 30), hm(10)),
      classLesson("7A", hm(12), hm(13)),
    ];

    expect(
      findIdleGaps({ studentGroupIds: ["7A"], placements, constraints: [], days: [1] })[0],
    ).toMatchObject({
      gaps: [expect.objectContaining({ startMinutes: hm(11), endMinutes: hm(12) })],
      totalMinutes: 60,
    });
  });

  it("looks at every day that carries a lesson when the caller says nothing", () => {
    // Including Saturday, which a Monday-to-Friday default would quietly drop
    // — some schools do teach on one.
    const placements = [
      classLesson("7A", hm(9), hm(10), { dayOfWeek: 6 }),
      classLesson("7A", hm(11), hm(12), { dayOfWeek: 6 }),
      classLesson("7A", hm(9), hm(10), { dayOfWeek: 5 }),
      classLesson("7A", hm(11), hm(12), { dayOfWeek: 5 }),
    ];

    expect(
      findIdleGaps({ studentGroupIds: ["7A"], placements, constraints: [] })[0]?.gaps.map(
        (gap) => [gap.dayOfWeek, gap.startMinutes, gap.endMinutes, gap.idleMinutes],
      ),
    ).toEqual([
      [5, hm(10), hm(11), 60],
      [6, hm(10), hm(11), 60],
    ]);
  });

  it("does not report a hole the school's lunch break explains", () => {
    // 11:00–11:30 sits inside the lunch window and is exactly one lunch long.
    const placements = [
      classLesson("7A", hm(10), hm(11)),
      classLesson("7A", hm(11, 30), hm(12, 30)),
    ];
    const query = { studentGroupIds: ["7A"], placements, constraints: [], days: [1] };

    expect(findIdleGaps({ ...query, lunch: lunchSettings() })).toEqual([]);
    // Without lunch rules the same half hour is an ordinary håltimme, so the
    // silence above is the lunch credit and not a lost gap.
    expect(findIdleGaps(query).map((report) => report.totalMinutes)).toEqual([30]);
  });

  it("reports what is left of a hole that merely contains lunch", () => {
    const placements = [
      classLesson("7A", hm(10), hm(11)),
      classLesson("7A", hm(12, 30), hm(13, 30)),
    ];

    expect(
      findIdleGaps({
        studentGroupIds: ["7A"],
        placements,
        constraints: [],
        days: [1],
        lunch: lunchSettings(),
      }),
    ).toEqual([
      {
        subjectId: "7A",
        kind: "STUDENT_GROUP",
        gaps: [
          {
            dayOfWeek: 1,
            startMinutes: hm(11),
            endMinutes: hm(12, 30),
            weeks: "ALL_WEEKS",
            minutes: 90,
            lunchMinutes: 30,
            idleMinutes: 60,
            idleStudents: 0,
          },
        ],
        totalMinutes: 60,
        worstMinutes: 60,
        studentCount: 0,
      },
    ]);
  });

  it("credits lunch only for the minutes a hole and the window share", () => {
    // 10:30–11:15 reaches 15 minutes into the window, so 15 minutes of it are
    // lunch and 30 are not.
    const placements = [
      classLesson("7A", hm(9), hm(10, 30)),
      classLesson("7A", hm(11, 15), hm(12)),
    ];

    expect(
      findIdleGaps({
        studentGroupIds: ["7A"],
        placements,
        constraints: [],
        days: [1],
        lunch: lunchSettings(),
      })[0]?.gaps[0],
    ).toMatchObject({ minutes: 45, lunchMinutes: 15, idleMinutes: 30 });
  });

  it("keeps a gap whose idle part is exactly the minimum and drops one a minute shorter", () => {
    const placements = [
      classLesson("7A", hm(9), hm(10)),
      classLesson("7A", hm(11), hm(12)),
    ];
    const query = { studentGroupIds: ["7A"], placements, constraints: [], days: [1] };

    expect(findIdleGaps({ ...query, minimumMinutes: 60 })).toHaveLength(1);
    expect(findIdleGaps({ ...query, minimumMinutes: 61 })).toEqual([]);
  });

  it("treats a changeover shorter than the default minimum as a break, not a håltimme", () => {
    const short = [
      classLesson("7A", hm(9), hm(10)),
      classLesson("7A", hm(10, 10), hm(11)),
    ];
    const long = [
      classLesson("7A", hm(9), hm(10)),
      classLesson("7A", hm(10, 0 + DEFAULT_MINIMUM_GAP_MINUTES), hm(11)),
    ];

    expect(
      findIdleGaps({ studentGroupIds: ["7A"], placements: short, constraints: [], days: [1] }),
    ).toEqual([]);
    expect(
      findIdleGaps({ studentGroupIds: ["7A"], placements: long, constraints: [], days: [1] }),
    ).toHaveLength(1);
  });

  it("counts a standing commitment as occupied, but never lets one bound the day", () => {
    const placements = [
      teacherLesson("t1", hm(9), hm(10)),
      teacherLesson("t1", hm(13), hm(14)),
    ];
    const meeting = constraint({
      resourceType: "TEACHER",
      userId: "t1",
      startTime: "11:00",
      endTime: "12:00",
    });
    const afterSchool = constraint({
      resourceType: "TEACHER",
      userId: "t1",
      startTime: "15:00",
      endTime: "16:00",
    });

    expect(
      findIdleGaps({
        teacherIds: ["t1"],
        placements,
        constraints: [meeting, afterSchool],
        days: [1],
      })[0],
    ).toMatchObject({
      gaps: [
        expect.objectContaining({ startMinutes: hm(10), endMinutes: hm(11) }),
        expect.objectContaining({ startMinutes: hm(12), endMinutes: hm(13) }),
      ],
      totalMinutes: 120,
      worstMinutes: 60,
    });
    // Without the meeting it is one long hole — and the 15:00 rule, an hour
    // after the last lesson, adds nothing either way.
    expect(
      findIdleGaps({
        teacherIds: ["t1"],
        placements,
        constraints: [afterSchool],
        days: [1],
      })[0],
    ).toMatchObject({ totalMinutes: 180, worstMinutes: 180 });
  });

  it("makes no report from standing commitments alone, however many", () => {
    // Two meetings with three idle hours between them are not a håltimme: the
    // teacher has no lesson that day and is not at school between them.
    const meetings = [
      constraint({ resourceType: "TEACHER", userId: "t1", startTime: "10:00", endTime: "11:00" }),
      constraint({ resourceType: "TEACHER", userId: "t1", startTime: "14:00", endTime: "15:00" }),
    ];

    expect(
      findIdleGaps({ teacherIds: ["t1"], placements: [], constraints: meetings, days: [1] }),
    ).toEqual([]);
    // The control: one lesson either side and the same two meetings now sit
    // inside a working day, so the hour between them is idle.
    expect(
      findIdleGaps({
        teacherIds: ["t1"],
        placements: [teacherLesson("t1", hm(9), hm(10)), teacherLesson("t1", hm(15), hm(16))],
        constraints: meetings,
        days: [1],
      })[0],
    ).toMatchObject({
      gaps: [expect.objectContaining({ startMinutes: hm(11), endMinutes: hm(14) })],
      totalMinutes: 180,
    });
  });

  it("separates the weeks when a lesson runs only every other one", () => {
    const placements = [
      classLesson("7A", hm(8), hm(9)),
      classLesson("7A", hm(10), hm(11), { recurrence: "ODD_WEEKS" }),
      classLesson("7A", hm(12), hm(13)),
    ];
    const query = { studentGroupIds: ["7A"], placements, constraints: [], days: [1] };

    expect(findIdleGaps(query)[0]).toMatchObject({
      gaps: [
        expect.objectContaining({ startMinutes: hm(9), endMinutes: hm(10), weeks: "ODD_WEEKS" }),
        expect.objectContaining({ startMinutes: hm(9), endMinutes: hm(12), weeks: "EVEN_WEEKS" }),
        expect.objectContaining({ startMinutes: hm(11), endMinutes: hm(12), weeks: "ODD_WEEKS" }),
      ],
      // Odd weeks cost 60 + 60, even weeks 180. No week costs 300, so the
      // total is the worse week's, not the sum of the list.
      totalMinutes: 180,
      worstMinutes: 180,
    });

    // The control: the same lesson every week leaves two ordinary holes.
    expect(
      findIdleGaps({ ...query, placements: [...placements.slice(0, 1), classLesson("7A", hm(10), hm(11)), ...placements.slice(2)] })[0],
    ).toMatchObject({
      gaps: [
        expect.objectContaining({ startMinutes: hm(9), endMinutes: hm(10), weeks: "ALL_WEEKS" }),
        expect.objectContaining({ startMinutes: hm(11), endMinutes: hm(12), weeks: "ALL_WEEKS" }),
      ],
      totalMinutes: 120,
      worstMinutes: 60,
    });
  });

  it("counts the lessons of a teaching group that shares pupils with the class", () => {
    const groupConflicts = buildGroupConflictMap(
      new Map([["s-1", "g-7a"]]),
      [{ studentId: "s-1", studentGroupId: "g-ma71" }],
    );
    const placements = [
      classLesson("g-7a", hm(8), hm(9)),
      classLesson("g-ma71", hm(10), hm(11)),
      classLesson("g-7a", hm(12), hm(13)),
    ];
    const query = { studentGroupIds: ["g-7a"], placements, constraints: [], days: [1] };

    expect(findIdleGaps({ ...query, groupConflicts })[0]).toMatchObject({
      totalMinutes: 120,
      worstMinutes: 60,
    });
    // Without the shared pupil, Ma71's lesson is somebody else's business and
    // 7A's morning reads as one three-hour hole.
    expect(findIdleGaps(query)[0]).toMatchObject({ totalMinutes: 180, worstMinutes: 180 });
  });

  it("keeps to the whole-group reading until the memberships arrive too", () => {
    // Home classes alone are half a roster. A class that splits into teaching
    // groups would read as free through every one of their lessons, so the
    // pupil count waits for the half that says who is in what.
    const placements = [classLesson("7A", hm(9), hm(10)), classLesson("7A", hm(12), hm(13))];
    const query = {
      studentGroupIds: ["7A"],
      placements,
      constraints: [],
      days: [1],
      studentGroupOf: new Map([
        ["s1", "7A"],
        ["s2", "7A"],
      ]),
    };

    expect(findIdleGaps(query)[0]).toMatchObject({
      gaps: [expect.objectContaining({ startMinutes: hm(10), idleStudents: 0 })],
      studentCount: 0,
    });
    // An empty membership list is a roster too — this school simply has no
    // teaching groups — and the same hole is now counted in pupils.
    expect(findIdleGaps({ ...query, memberships: [] })[0]).toMatchObject({
      gaps: [expect.objectContaining({ startMinutes: hm(10), idleStudents: 2 })],
      studentCount: 2,
    });
    // A class nobody is enrolled in yet still has the hole its timetable has,
    // so it is read as a body rather than dropped for having no pupils.
    expect(
      findIdleGaps({
        ...query,
        memberships: [],
        studentGroupIds: ["8B"],
        placements: [classLesson("8B", hm(9), hm(10)), classLesson("8B", hm(12), hm(13))],
      })[0],
    ).toMatchObject({
      gaps: [expect.objectContaining({ startMinutes: hm(10), idleStudents: 0 })],
      studentCount: 0,
    });
  });

  it("finds the hole the half of a class outside the teaching group sits in", () => {
    // Four pupils of 7A, split between two maths groups. Nothing here is a
    // clash — the class is never double-booked — and yet every pupil has three
    // idle hours on Monday: a Ma71 pupil is free 09:00–10:00 and 11:00–13:00, a
    // Ma72 pupil 09:00–11:00 and 12:00–13:00. Asked of the class's name instead
    // of its pupils, half of that disappears.
    const roster = new Map([
      ["s1", "7A"],
      ["s2", "7A"],
      ["s3", "7A"],
      ["s4", "7A"],
    ]);
    const memberships = [
      { studentId: "s1", studentGroupId: "Ma71" },
      { studentId: "s2", studentGroupId: "Ma71" },
      { studentId: "s3", studentGroupId: "Ma72" },
      { studentId: "s4", studentGroupId: "Ma72" },
    ];
    const groupConflicts = buildGroupConflictMap(roster, memberships);
    const placements = [
      classLesson("7A", hm(8), hm(9)),
      classLesson("Ma71", hm(10), hm(11)),
      classLesson("Ma72", hm(11), hm(12)),
      classLesson("7A", hm(13), hm(14)),
    ];
    const query = { studentGroupIds: ["7A"], placements, constraints: [], days: [1] };

    expect(
      findIdleGaps({ ...query, studentGroupOf: roster, memberships, groupConflicts })[0],
    ).toMatchObject({
      // Each row is one continuous stretch for the pupils it counts, so two
      // may overlap: at 09:30 both halves are idle, and both rows say so.
      gaps: [
        expect.objectContaining({ startMinutes: hm(9), endMinutes: hm(10), idleStudents: 2 }),
        expect.objectContaining({ startMinutes: hm(9), endMinutes: hm(11), idleStudents: 2 }),
        expect.objectContaining({ startMinutes: hm(11), endMinutes: hm(13), idleStudents: 2 }),
        expect.objectContaining({ startMinutes: hm(12), endMinutes: hm(13), idleStudents: 2 }),
      ],
      totalMinutes: 180,
      worstMinutes: 120,
      studentCount: 4,
    });

    // The same schedule read off the class's name alone — no roster to count,
    // only the conflict map. Ma71 and Ma72 both busy 7A, so 10:00–12:00 reads
    // as taught and two of the four holes are never named.
    expect(findIdleGaps({ ...query, groupConflicts })[0]).toMatchObject({
      gaps: [
        expect.objectContaining({ startMinutes: hm(9), endMinutes: hm(10), idleStudents: 0 }),
        expect.objectContaining({ startMinutes: hm(12), endMinutes: hm(13), idleStudents: 0 }),
      ],
      totalMinutes: 120,
      worstMinutes: 60,
      studentCount: 0,
    });
  });

  it("adds up every set of pupils that shares a hole", () => {
    const roster = new Map([
      ["s1", "7A"],
      ["s2", "7A"],
      ["s3", "7A"],
      ["s4", "7A"],
    ]);
    const memberships = [
      { studentId: "s1", studentGroupId: "Ma71" },
      { studentId: "s2", studentGroupId: "Ma71" },
      { studentId: "s3", studentGroupId: "Ma72" },
      { studentId: "s4", studentGroupId: "Ma72" },
    ];
    const query = {
      studentGroupIds: ["7A"],
      constraints: [],
      days: [1],
      studentGroupOf: roster,
      memberships,
    };
    const bookends = [classLesson("7A", hm(8), hm(9)), classLesson("7A", hm(12), hm(13))];

    // Both maths groups meet in the same half hour, so both halves of the
    // class sit through the same two holes and the whole class is in each.
    expect(
      findIdleGaps({
        ...query,
        placements: [
          ...bookends,
          classLesson("Ma71", hm(10), hm(10, 30)),
          classLesson("Ma72", hm(10), hm(10, 30)),
        ],
      })[0],
    ).toMatchObject({
      gaps: [
        expect.objectContaining({ startMinutes: hm(9), endMinutes: hm(10), idleStudents: 4 }),
        expect.objectContaining({
          startMinutes: hm(10, 30),
          endMinutes: hm(12),
          idleStudents: 4,
        }),
      ],
      studentCount: 4,
    });

    // Move Ma72 an hour later and the two halves stop sharing: four holes, two
    // pupils in each, so the counts above are the sets and not a constant.
    expect(
      findIdleGaps({
        ...query,
        placements: [
          ...bookends,
          classLesson("Ma71", hm(10), hm(10, 30)),
          classLesson("Ma72", hm(11), hm(11, 30)),
        ],
      })[0]?.gaps.map((gap) => [gap.startMinutes, gap.endMinutes, gap.idleStudents]),
    ).toEqual([
      [hm(9), hm(10), 2],
      [hm(9), hm(11), 2],
      [hm(10, 30), hm(12), 2],
      [hm(11, 30), hm(12), 2],
    ]);
  });

  it("tells two pupils of one class apart by the electives only one of them takes", () => {
    const roster = new Map([
      ["s1", "7A"],
      ["s2", "7A"],
    ]);
    const bookends = [classLesson("7A", hm(8), hm(9)), classLesson("7A", hm(12), hm(13))];
    const query = {
      studentGroupIds: ["7A"],
      constraints: [],
      days: [1],
      studentGroupOf: roster,
      // No teaching groups in this school, which is a roster all the same.
      memberships: [],
    };
    const electives = (studentIds: string[]) => [
      lesson({
        studentGroupId: "elective",
        studentIds,
        startMinutes: hm(10),
        endMinutes: hm(11),
      }),
      lesson({
        studentGroupId: "choir",
        studentIds,
        startMinutes: hm(11, 30),
        endMinutes: hm(12),
      }),
    ];

    expect(
      findIdleGaps({
        ...query,
        placements: [...bookends, ...electives(["s1"])],
      })[0]?.gaps.map((gap) => [gap.startMinutes, gap.endMinutes, gap.idleStudents]),
    ).toEqual([
      // s1's morning is broken into an hour and a half hour; s2, who is in
      // neither elective, sits out the whole three hours in one stretch.
      [hm(9), hm(10), 1],
      [hm(9), hm(12), 1],
      [hm(11), hm(11, 30), 1],
    ]);
    // With both of them in both, the class is one body again and the two sit
    // out the same two holes.
    expect(
      findIdleGaps({
        ...query,
        placements: [...bookends, ...electives(["s1", "s2"])],
      })[0]?.gaps.map((gap) => [gap.startMinutes, gap.endMinutes, gap.idleStudents]),
    ).toEqual([
      [hm(9), hm(10), 2],
      [hm(11), hm(11, 30), 2],
    ]);
  });

  it("counts a pupil with no class yet by the groups they do sit in", () => {
    const roster = new Map([
      ["s1", "7A"],
      ["s2", null],
    ]);
    const memberships = [
      { studentId: "s1", studentGroupId: "Ma71" },
      { studentId: "s2", studentGroupId: "Ma71" },
    ];
    const placements = [
      classLesson("Ma71", hm(9), hm(10)),
      classLesson("7A", hm(10, 30), hm(11)),
      classLesson("Ma71", hm(12), hm(13)),
    ];
    const query = { placements, constraints: [], days: [1], studentGroupOf: roster, memberships };

    // s1 has 7A's hour in the middle of the Ma71 morning; s2, who is in no
    // class, sits through the whole of it.
    expect(
      findIdleGaps({ ...query, studentGroupIds: ["Ma71"] })[0]?.gaps.map((gap) => [
        gap.startMinutes,
        gap.endMinutes,
        gap.idleStudents,
      ]),
    ).toEqual([
      [hm(10), hm(10, 30), 1],
      [hm(10), hm(12), 1],
      [hm(11), hm(12), 1],
    ]);
    // …and 7A's own roster is s1 alone: a pupil with no class is on nobody's.
    expect(findIdleGaps({ ...query, studentGroupIds: ["7A"] })[0]).toMatchObject({
      gaps: [
        expect.objectContaining({ startMinutes: hm(10), endMinutes: hm(10, 30) }),
        expect.objectContaining({ startMinutes: hm(11), endMinutes: hm(12) }),
      ],
      studentCount: 1,
      totalMinutes: 90,
    });
  });

  it("eats one lunch a day, however many holes the lunch window holds", () => {
    // Two holes inside the 11:00–12:30 window. One meal is eaten; crediting
    // both erases forty minutes of real håltimme and reads as a clean day.
    const placements = [
      classLesson("7A", hm(10), hm(11)),
      classLesson("7A", hm(11, 30), hm(12)),
      classLesson("7A", hm(12, 40), hm(13, 30)),
    ];
    const query = { studentGroupIds: ["7A"], placements, constraints: [], days: [1] };

    expect(findIdleGaps({ ...query, lunch: lunchSettings() })[0]).toMatchObject({
      gaps: [
        expect.objectContaining({
          startMinutes: hm(12),
          endMinutes: hm(12, 40),
          lunchMinutes: 0,
          idleMinutes: 40,
        }),
      ],
      totalMinutes: 40,
    });
    // Without lunch rules both holes are ordinary håltimmar — 30 + 40 — so
    // exactly one meal went missing above, not two.
    expect(findIdleGaps(query).map((report) => report.totalMinutes)).toEqual([70]);
  });

  it("does not call a hole weekly when only one week has lunch left to pay for it", () => {
    // 11:30–12:00 is the same half hour in both weeks, but not the same thing.
    // In even weeks it is lunch. In odd weeks the class already ate at ten,
    // while the even-week lesson kept its other half at their desks — so odd
    // weeks pay for it out of nothing, and calling it an every-week hole would
    // report a meal as idle time.
    const placements = [
      classLesson("7A", hm(9), hm(10)),
      classLesson("7A", hm(10), hm(10, 30), { recurrence: "EVEN_WEEKS" }),
      classLesson("7A", hm(10, 30), hm(11, 30)),
      classLesson("7A", hm(12), hm(13)),
    ];
    const lunch = lunchSettings({ lunchStartTime: "10:00:00", lunchEndTime: "12:00:00" });
    const query = { studentGroupIds: ["7A"], placements, constraints: [], days: [1] };

    expect(findIdleGaps({ ...query, lunch })[0]).toMatchObject({
      gaps: [
        expect.objectContaining({
          startMinutes: hm(11, 30),
          endMinutes: hm(12),
          weeks: "ODD_WEEKS",
          lunchMinutes: 0,
          idleMinutes: 30,
        }),
      ],
      totalMinutes: 30,
    });
    // With lunch switched off nothing distinguishes the two weeks over that
    // half hour, and it is reported once, as the every-week hole it then is.
    expect(findIdleGaps(query)[0]).toMatchObject({
      gaps: [
        expect.objectContaining({
          startMinutes: hm(10),
          endMinutes: hm(10, 30),
          weeks: "ODD_WEEKS",
        }),
        expect.objectContaining({
          startMinutes: hm(11, 30),
          endMinutes: hm(12),
          weeks: "ALL_WEEKS",
        }),
      ],
      totalMinutes: 60,
    });
  });

  it("leaves a term-limited lesson out of the weeks it does not run in", () => {
    const placements = [
      classLesson("7A", hm(8), hm(9)),
      classLesson("7A", hm(10), hm(11), { startDate: "2025-08-11", endDate: "2025-12-19" }),
      classLesson("7A", hm(12), hm(13)),
    ];
    const query = { studentGroupIds: ["7A"], placements, constraints: [], days: [1] };

    // Asked of the academic year as a whole, the autumn course still splits
    // the morning into two hours — the conservative reading.
    expect(findIdleGaps(query)[0]).toMatchObject({ totalMinutes: 120, worstMinutes: 60 });
    expect(findIdleGaps({ ...query, onDate: "2025-09-15" })[0]).toMatchObject({
      totalMinutes: 120,
      worstMinutes: 60,
    });
    // Asked of a week in February, the class sits through the whole morning.
    expect(findIdleGaps({ ...query, onDate: "2026-02-16" })[0]).toMatchObject({
      gaps: [expect.objectContaining({ startMinutes: hm(9), endMinutes: hm(12) })],
      totalMinutes: 180,
      worstMinutes: 180,
    });
  });

  it("reports groups and teachers together, worst timetable first", () => {
    const placements = [
      classLesson("7A", hm(8), hm(9)),
      classLesson("7A", hm(10), hm(11)),
      teacherLesson("t1", hm(8), hm(9)),
      teacherLesson("t1", hm(12), hm(13)),
    ];

    expect(
      findIdleGaps({
        studentGroupIds: ["7A"],
        teacherIds: ["t1"],
        placements,
        constraints: [],
        days: [1],
      }).map((report) => [
        report.subjectId,
        report.kind,
        report.totalMinutes,
        // A teacher is one person, not a roster, so there is no pupil count to
        // print beside their holes.
        report.studentCount,
      ]),
    ).toEqual([
      ["t1", "TEACHER", 180, 0],
      ["7A", "STUDENT_GROUP", 60, 0],
    ]);
  });

  it("orders two equally bad timetables by id, so the list does not shuffle", () => {
    const placements = [
      classLesson("7B", hm(8), hm(9)),
      classLesson("7B", hm(10), hm(11)),
      classLesson("7A", hm(8), hm(9)),
      classLesson("7A", hm(10), hm(11)),
    ];

    expect(
      findIdleGaps({
        studentGroupIds: ["7B", "7A"],
        placements,
        constraints: [],
        days: [1],
      }).map((report) => report.subjectId),
    ).toEqual(["7A", "7B"]);
  });
});

// ---------------------------------------------------------------------------
// whoIsFree
// ---------------------------------------------------------------------------

describe("whoIsFree", () => {
  const at = { dayOfWeek: 1, startMinutes: hm(10), endMinutes: hm(11) };

  it("splits the candidates into those free across the interval and those not", () => {
    const placements = [
      classLesson("7A", hm(10, 30), hm(11, 30)),
      teacherLesson("t1", hm(9), hm(12)),
      lesson({ roomId: "r1", startMinutes: hm(10), endMinutes: hm(11) }),
    ];

    expect(
      whoIsFree({
        ...at,
        studentGroupIds: ["7A", "7B"],
        teacherIds: ["t1", "t2"],
        roomIds: ["r1", "r2"],
        placements,
        constraints: [],
      }),
    ).toEqual({ studentGroupIds: ["7B"], teacherIds: ["t2"], roomIds: ["r2"] });
  });

  it("treats a lesson that ends when the interval starts as no obstacle", () => {
    expect(
      whoIsFree({
        ...at,
        teacherIds: ["t1"],
        placements: [teacherLesson("t1", hm(9), hm(10))],
        constraints: [],
      }).teacherIds,
    ).toEqual(["t1"]);
  });

  it("asks about every week by default, and about one parity on request", () => {
    const placements = [teacherLesson("t1", hm(10), hm(11), { recurrence: "ODD_WEEKS" })];
    const query = { ...at, teacherIds: ["t1"], placements, constraints: [] };

    // The strict reading, which is what placing a weekly lesson needs.
    expect(whoIsFree(query).teacherIds).toEqual([]);
    expect(whoIsFree({ ...query, weeks: "ODD_WEEKS" }).teacherIds).toEqual([]);
    // Free every other week, because the slot's occupant runs on the other one.
    expect(whoIsFree({ ...query, weeks: "EVEN_WEEKS" }).teacherIds).toEqual(["t1"]);
  });

  it("counts a weekly UNAVAILABLE rule against the candidate", () => {
    const closed = constraint({
      resourceType: "ROOM",
      roomId: "r1",
      startTime: "10:00",
      endTime: "11:00",
    });
    const query = { ...at, roomIds: ["r1"], placements: [], constraints: [] };

    expect(whoIsFree({ ...query, constraints: [closed] }).roomIds).toEqual([]);
    expect(whoIsFree(query).roomIds).toEqual(["r1"]);
  });

  it("counts a lesson of a group sharing pupils with the candidate class", () => {
    const groupConflicts = buildGroupConflictMap(
      new Map([["s-1", "g-7a"]]),
      [{ studentId: "s-1", studentGroupId: "g-ma71" }],
    );
    const query = {
      ...at,
      studentGroupIds: ["g-7a"],
      placements: [classLesson("g-ma71", hm(10), hm(11))],
      constraints: [],
    };

    expect(whoIsFree({ ...query, groupConflicts }).studentGroupIds).toEqual([]);
    expect(whoIsFree(query).studentGroupIds).toEqual(["g-7a"]);
  });

  it("forgets a lesson whose term is over, when the caller names a date", () => {
    const placements = [
      teacherLesson("t1", hm(10), hm(11), {
        startDate: "2025-08-11",
        endDate: "2025-12-19",
      }),
    ];
    const query = { ...at, teacherIds: ["t1"], placements, constraints: [] };

    // No date at all is the question about the year, where the course counts.
    expect(whoIsFree(query).teacherIds).toEqual([]);
    expect(whoIsFree({ ...query, onDate: "2025-09-15" }).teacherIds).toEqual([]);
    expect(whoIsFree({ ...query, onDate: "2026-02-16" }).teacherIds).toEqual(["t1"]);
  });

  it("returns empty lists for the kinds the caller did not ask about", () => {
    expect(
      whoIsFree({ ...at, teacherIds: ["t1"], placements: [], constraints: [] }),
    ).toEqual({ studentGroupIds: [], teacherIds: ["t1"], roomIds: [] });
  });
});

// ---------------------------------------------------------------------------
// The correspondence with conflicts.ts
//
// The safety argument of this module is that it has no opinion of its own: a
// window it calls free must be one validatePlacement lets a lesson into, or
// the page offers slots the grid then refuses. Every expectation above is a
// hand-written literal, which cannot see the two drifting apart — so these ask
// the engine itself, over schedules nobody wrote by hand.
// ---------------------------------------------------------------------------

/** A group id belonging to no world, so a probe carrying it clashes with none. */
const OUTSIDER = "__outsider__";

/** Deterministic: the same worlds on every machine and every run. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const WORLD_GROUPS = ["7A", "7B", "Ma71"];
const WORLD_TEACHERS = ["t1", "t2"];
const WORLD_ROOMS = ["r1", "r2"];
const WORLD_WEEKS = ["ALL_WEEKS", "ODD_WEEKS", "EVEN_WEEKS"] as const;
const WORLD_DAYS = [1, 2];
const WORLD_SPAN = { days: WORLD_DAYS, dayStartMinutes: hm(8), dayEndMinutes: hm(16) };

/** s1 and s2 sit in Ma71 as well as their own class; s3 only in 7A. */
const WORLD_ROSTER = new Map([
  ["s1", "7A"],
  ["s2", "7B"],
  ["s3", "7A"],
]);
const WORLD_MEMBERSHIPS = [
  { studentId: "s1", studentGroupId: "Ma71" },
  { studentId: "s2", studentGroupId: "Ma71" },
];

interface World {
  placements: Placement[];
  constraints: AvailabilityConstraint[];
  studentGroupOf: Map<string, string | null>;
  groupConflicts: ReturnType<typeof buildGroupConflictMap>;
  memberships: typeof WORLD_MEMBERSHIPS;
  studentGroupIds: string[];
  teacherIds: string[];
  roomIds: string[];
}

function randomWorld(random: () => number, index: number): World {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const some = <T>(items: readonly T[]): T[] => items.filter(() => random() < 0.5);

  const placements: Placement[] = [];
  for (let i = 0; i < 3 + Math.floor(random() * 7); i += 1) {
    const start = hm(8) + Math.floor(random() * 15) * 30;
    placements.push({
      id: `w${index}-${i}`,
      dayOfWeek: pick(WORLD_DAYS),
      startMinutes: start,
      endMinutes: start + (random() < 0.5 ? 45 : 60),
      teacherId: random() < 0.6 ? pick(WORLD_TEACHERS) : null,
      roomId: random() < 0.6 ? pick(WORLD_ROOMS) : null,
      studentGroupId: pick(WORLD_GROUPS),
      studentIds: random() < 0.25 ? ["s3"] : [],
      recurrence: pick(WORLD_WEEKS),
      startDate: random() < 0.2 ? "2025-08-11" : null,
      endDate: random() < 0.2 ? "2025-12-19" : null,
    });
  }

  const constraints: AvailabilityConstraint[] = [];
  for (let i = 0; i < Math.floor(random() * 3); i += 1) {
    const start = hm(8) + Math.floor(random() * 14) * 30;
    constraints.push(
      constraint({
        id: `c${index}-${i}`,
        resourceType: pick(["STUDENT_GROUP", "TEACHER", "ROOM"] as const),
        studentGroupId: pick(WORLD_GROUPS),
        userId: pick(WORLD_TEACHERS),
        roomId: pick(WORLD_ROOMS),
        dayOfWeek: random() < 0.15 ? null : pick(WORLD_DAYS),
        date: random() < 0.15 ? "2026-02-16" : null,
        type: random() < 0.15 ? "PREFERRED_FREE" : "UNAVAILABLE",
        startTime: `${String(Math.floor(start / 60)).padStart(2, "0")}:${start % 60 === 0 ? "00" : "30"}`,
        endTime: `${String(Math.floor((start + 60) / 60)).padStart(2, "0")}:${(start + 60) % 60 === 0 ? "00" : "30"}`,
      }),
    );
  }

  // Never an empty selection: that question has its own answer, tested above.
  const studentGroupIds = some(WORLD_GROUPS);
  const teacherIds = some(WORLD_TEACHERS);
  const roomIds = some(WORLD_ROOMS);
  if (studentGroupIds.length + teacherIds.length + roomIds.length === 0) {
    studentGroupIds.push(pick(WORLD_GROUPS));
  }

  return {
    placements,
    constraints,
    studentGroupOf: WORLD_ROSTER,
    groupConflicts: buildGroupConflictMap(WORLD_ROSTER, WORLD_MEMBERSHIPS),
    memberships: WORLD_MEMBERSHIPS,
    studentGroupIds,
    teacherIds,
    roomIds,
  };
}

/** One lesson per selected body, laid across the interval under one parity. */
function candidatesFor(
  world: World,
  dayOfWeek: number,
  startMinutes: number,
  endMinutes: number,
  weeks: LessonRecurrence,
): Placement[] {
  const base: Placement = {
    id: null,
    dayOfWeek,
    startMinutes,
    endMinutes,
    teacherId: null,
    roomId: null,
    studentGroupId: OUTSIDER,
    recurrence: weeks,
  };
  return [
    ...world.studentGroupIds.map((id) => ({ ...base, studentGroupId: id })),
    ...world.teacherIds.map((id) => ({ ...base, teacherId: id })),
    ...world.roomIds.map((id) => ({ ...base, roomId: id })),
  ];
}

function clashes(world: World, candidate: Placement): boolean {
  return (
    validatePlacement(
      candidate,
      world.placements,
      world.constraints,
      world.studentGroupOf,
      world.groupConflicts,
    ).length > 0
  );
}

describe("the windows findFreeWindows reports", () => {
  const worlds = Array.from({ length: 200 }, (_, index) =>
    randomWorld(makeRandom(index + 1), index),
  );

  it("are ones validatePlacement accepts a lesson into, and none of them wider", () => {
    const offered: string[] = [];
    const rejected: string[] = [];
    const notMaximal: string[] = [];
    let stretched = 0;
    const byWeeks = new Map<string, number>();

    for (const [index, world] of worlds.entries()) {
      const windows = findFreeWindows({ ...world, minimumMinutes: 30, ...WORLD_SPAN });
      for (const window of windows) {
        const where = `world ${index} ${window.weeks} day ${window.dayOfWeek} ${window.startMinutes}–${window.endMinutes}`;
        offered.push(where);
        byWeeks.set(window.weeks, (byWeeks.get(window.weeks) ?? 0) + 1);

        for (const candidate of candidatesFor(
          world,
          window.dayOfWeek,
          window.startMinutes,
          window.endMinutes,
          window.weeks,
        )) {
          if (clashes(world, candidate)) rejected.push(`${where} — ${describeBody(candidate)}`);
        }

        // Maximal, not merely free: a minute earlier or later must clash for
        // somebody, or the window was cut short and a caller is offered less
        // room than they have.
        for (const [start, end] of [
          [window.startMinutes - 1, window.endMinutes],
          [window.startMinutes, window.endMinutes + 1],
        ]) {
          if (start < WORLD_SPAN.dayStartMinutes || end > WORLD_SPAN.dayEndMinutes) continue;
          stretched += 1;
          const stretch = candidatesFor(world, window.dayOfWeek, start, end, window.weeks);
          if (!stretch.some((candidate) => clashes(world, candidate))) {
            notMaximal.push(`${where} — free through ${start}–${end}`);
          }
        }
      }
    }

    expect(rejected).toEqual([]);
    expect(notMaximal).toEqual([]);
    // Non-vacuity: the loop above must have had something to check, under
    // every reading of the week.
    expect(offered.length).toBeGreaterThan(500);
    expect(stretched).toBeGreaterThan(500);
    expect(byWeeks.get("ALL_WEEKS")).toBeGreaterThan(100);
    expect(byWeeks.get("ODD_WEEKS")).toBeGreaterThan(50);
    expect(byWeeks.get("EVEN_WEEKS")).toBeGreaterThan(50);
  });
});

describe("the bodies whoIsFree reports", () => {
  const worlds = Array.from({ length: 200 }, (_, index) =>
    randomWorld(makeRandom(index + 5000), index),
  );

  it("are free, and the ones it leaves out are not", () => {
    const wronglyFree: string[] = [];
    const wronglyBusy: string[] = [];
    let free = 0;
    let busy = 0;

    for (const [index, world] of worlds.entries()) {
      const dayOfWeek = WORLD_DAYS[index % WORLD_DAYS.length];
      const startMinutes = hm(9) + (index % 12) * 30;
      const at = { dayOfWeek, startMinutes, endMinutes: startMinutes + 60 };
      const answer = whoIsFree({
        ...world,
        ...at,
        studentGroupIds: WORLD_GROUPS,
        teacherIds: WORLD_TEACHERS,
        roomIds: WORLD_ROOMS,
      });
      const said = new Set([
        ...answer.studentGroupIds,
        ...answer.teacherIds,
        ...answer.roomIds,
      ]);

      const everyone = { ...world, studentGroupIds: WORLD_GROUPS, teacherIds: WORLD_TEACHERS, roomIds: WORLD_ROOMS };
      for (const candidate of candidatesFor(
        everyone,
        at.dayOfWeek,
        at.startMinutes,
        at.endMinutes,
        "ALL_WEEKS",
      )) {
        const body = describeBody(candidate);
        if (said.has(body)) {
          free += 1;
          if (clashes(world, candidate)) wronglyFree.push(`world ${index} — ${body}`);
        } else {
          busy += 1;
          if (!clashes(world, candidate)) wronglyBusy.push(`world ${index} — ${body}`);
        }
      }
    }

    expect(wronglyFree).toEqual([]);
    expect(wronglyBusy).toEqual([]);
    // Both halves of the answer are exercised, so neither list is empty for
    // want of a case rather than for want of a fault.
    expect(free).toBeGreaterThan(200);
    expect(busy).toBeGreaterThan(200);
  });
});

/** Which single body a one-body candidate stands for. */
function describeBody(candidate: Placement): string {
  if (candidate.teacherId) return candidate.teacherId;
  if (candidate.roomId) return candidate.roomId;
  return candidate.studentGroupId;
}
