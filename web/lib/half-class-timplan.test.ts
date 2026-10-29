import { describe, expect, it } from "vitest";
import { halvesRow, plannedRows, presetPeriods, proposedLessons, type HalvesRead } from "./half-class-periods";
import {
  classPostReduction,
  halvesTimplan,
  type HalvesSplit,
  type HalvesTimplanSources,
  type StoredPost,
} from "./half-class-timplan";
import { computePlannedCoverage } from "./timplan-planned";

/**
 * 6A in åk 6, 2026/27 as a school enters it: höstlov, jullov to
 * Trettondagen's week, sportlov and påsklov. Seventeen teaching weeks in the
 * autumn and twenty in the spring, 37 in all. The plan gives åk 6 hemkunskap
 * 30 and slöjd 80 a week; 6A has hemkunskap 1 × 30 and slöjd 2 × 40.
 */
const YEAR = { startDate: "2026-08-17", endDate: "2027-06-11" };
const SPRING = "2027-01-04";
const LOV = [
  { startDate: "2026-10-26", endDate: "2026-10-30" },
  { startDate: "2026-12-21", endDate: "2027-01-08" },
  { startDate: "2027-02-22", endDate: "2027-02-26" },
  { startDate: "2027-03-29", endDate: "2027-04-02" },
];
const SUBJECTS = [
  { id: "hk", name: "Hemkunskap", nationalCode: "HKK" },
  { id: "sl", name: "Slöjd", nationalCode: "SLJ" },
  { id: "tx", name: "Textilslöjd", nationalCode: "SLJ" },
  { id: "tm", name: "Trä- och metallslöjd", nationalCode: "SLJ" },
  { id: "ma", name: "Matematik", nationalCode: "MA" },
];
const sources = (entries: { subjectId: string; minutesPerWeek: number }[] = [
  { subjectId: "hk", minutesPerWeek: 30 },
  { subjectId: "sl", minutesPerWeek: 80 },
]): HalvesTimplanSources => ({
  year: YEAR,
  closures: LOV,
  plans: [{ id: "plan", name: "Lokal timplan", status: "DECIDED", entries: entries.map((entry) => ({ ...entry, gradeLevel: 6 })) }],
  attachments: [{ gradeLevel: 6, localTimplanId: "plan" }],
  subjects: SUBJECTS,
});
const post = (id: string, subjectId: string, lessonsPerWeek: number, minutesPerLesson: number, extra: Partial<StoredPost> = {}): StoredPost => ({
  id,
  studentGroupId: "6A",
  subjectId,
  lessonsPerWeek,
  minutesPerLesson,
  lessonLengths: [],
  recurrence: "ALL_WEEKS",
  startDate: null,
  endDate: null,
  ...extra,
});
const HEMKUNSKAP = post("r-hk", "hk", 1, 30);
const SLOJD = post("r-sl", "sl", 2, 40);
const MATEMATIK = post("r-ma", "ma", 4, 60);

/** The split as the dialog draws it: the proposal's week, the posts it writes. */
function swap(
  periods: readonly [{ startDate: string; endDate: string }, { startDate: string; endDate: string }],
  pair: readonly [string, string] = ["hk", "sl"],
  read: HalvesRead = "swapWithOther",
  posts: readonly StoredPost[] = [HEMKUNSKAP, SLOJD, MATEMATIK],
  source: StoredPost = HEMKUNSKAP,
  calendar: { year: typeof YEAR; closures: typeof LOV } = { year: YEAR, closures: LOV },
): HalvesSplit {
  const lessons = proposedLessons(source, periods, read, calendar.year, calendar.closures, 6);
  return {
    theClass: { id: "6A", name: "6A", gradeLevel: 6 },
    halves: [
      { id: "new-half-1", name: "6A:1" },
      { id: "new-half-2", name: "6A:2" },
    ],
    posts,
    sourceId: source.id,
    rows: plannedRows(halvesRow(source, lessons), "ALL_WEEKS", periods, pair[1] ? 2 : 1),
    subjectIds: pair[1] ? pair : [pair[0]],
  };
}

const TERMS = presetPeriods("terms", SPRING, YEAR, LOV, 6)!;
/** One half's lines as [subject, planned, target]. */
const linesOf = (result: ReturnType<typeof halvesTimplan>) => {
  if (result.kind !== "lines") throw new Error(result.kind);
  return result.halves.map((lines) => lines.map((line) => [line.subjectIds.join("/"), line.planned, line.target]));
};

describe("hemkunskap swapped with slöjd over the terms", () => {
  it("gives a pupil of each half at least the 30 minutes of hemkunskap, and the slöjd over 80 on top of the class's", () => {
    // 1 × 70: 70 × 17 / 37 = 32,2 for the autumn half and 37,8 for the
    // spring one; each reads 1 × 70 slöjd in its other term, on top of 6A's 80.
    expect(linesOf(halvesTimplan(sources(), swap(TERMS), "hk"))).toEqual([
      [
        ["hk", 32, 30],
        ["sl", 118, 80],
      ],
      [
        ["hk", 38, 30],
        ["sl", 112, 80],
      ],
    ]);
  });

  it("is what the class's pace on main left each pupil: 14 and 16 of hemkunskap, under", () => {
    const main = { ...swap(TERMS), rows: plannedRows(HEMKUNSKAP, "ALL_WEEKS", TERMS, 2) };
    expect(linesOf(halvesTimplan(sources(), main, "hk"))).toEqual([
      [
        ["hk", 14, 30],
        ["sl", 96, 80],
      ],
      [
        ["hk", 16, 30],
        ["sl", 94, 80],
      ],
    ]);
  });

  it("brings the class's slöjd down to 2 × 25, the least that keeps both halves at 80", () => {
    const split = swap(TERMS);
    const reduction = classPostReduction(sources(), split, "sl");
    expect(reduction).toEqual({
      requirementId: "r-sl",
      from: { count: 2, minutes: 40 },
      to: { count: 2, minutes: 25 },
      target: 80,
      planned: [88, 82],
      // 6A's own line until the pupils are in the halves: 2 × 25, under 80.
      classPlanned: 50,
      inBlock: false,
    });
    // With it, no half is under in either line.
    const after = halvesTimplan(sources(), { ...split, adjusted: { requirementId: "r-sl", week: reduction!.to } }, "hk");
    expect(linesOf(after)).toEqual([
      [
        ["hk", 32, 30],
        ["sl", 88, 80],
      ],
      [
        ["hk", 38, 30],
        ["sl", 82, 80],
      ],
    ]);
    // A step further puts the autumn half under: 2 × 20 is 40 + 37,8, or one 40 is 40 + 32,2.
    for (const week of [
      { count: 2, minutes: 20 },
      { count: 1, minutes: 40 },
    ]) {
      const lower = linesOf(halvesTimplan(sources(), { ...split, adjusted: { requirementId: "r-sl", week } }, "hk"));
      expect(lower.some((half) => (half[1]![1] as number) < 80), `${week.count} × ${week.minutes}`).toBe(true);
    }
  });

  it("is the timplan's own answer: the class's line is read in its halves, no pupil is under, and none is double planned", () => {
    // The whole year's coverage as the gateway computes it, with real pupils
    // in the two halves and the class's slöjd brought down.
    const split = swap(TERMS);
    const rows = split.rows.map((row, index) => ({
      id: `split-${index}`,
      studentGroupId: row.half === 0 ? "h1" : "h2",
      subjectId: split.subjectIds[row.subject]!,
      lessonsPerWeek: row.lessonsPerWeek,
      minutesPerLesson: row.minutesPerLesson,
      recurrence: "ALL_WEEKS" as const,
      startDate: row.startDate ?? null,
      endDate: row.endDate ?? null,
    }));
    const coverage = computePlannedCoverage({
      year: YEAR,
      closures: LOV,
      plans: sources().plans,
      attachments: sources().attachments,
      subjects: SUBJECTS.map((subject) => ({ ...subject, countsTowardTimplan: true })),
      groups: [
        { id: "6A", name: "6A", kind: "CLASS", gradeLevel: 6 },
        { id: "h1", name: "6A:1", kind: "TEACHING_GROUP", gradeLevel: 6, halfOfId: "6A" },
        { id: "h2", name: "6A:2", kind: "TEACHING_GROUP", gradeLevel: 6, halfOfId: "6A" },
      ],
      requirements: [
        { ...SLOJD, minutesPerLesson: 25, lessonLengths: [] },
        { ...MATEMATIK, lessonLengths: [] },
        ...rows,
      ],
      pupils: ["a", "b", "c", "d"].map((id, index) => ({ id, homeGroupId: "6A", groupIds: [index < 2 ? "h1" : "h2"] })),
      includePupils: true,
    });
    expect(coverage.pupilsBelowTarget).toBe(0);
    // Slöjd reaches each pupil from 6A and from their half's dated post: one
    // planning, summed on the line, so nothing for Täckning to list.
    expect(coverage.verdicts).toEqual([]);
    const lines = coverage.groups[0]!.lines.filter((line) => line.key !== "subject:ma");
    expect(lines.map((line) => [line.key, line.status, line.pupils])).toEqual([
      ["subject:hk", "PUPILS", { min: 32, median: 35, max: 38, below: 0 }],
      ["subject:sl", "PUPILS", { min: 82, median: 85, max: 88, below: 0 }],
    ]);
  });

  it("keeps every half at its targets in both lines, whatever the preset, with the proposal and the reduction", () => {
    for (const preset of ["terms", "yearHalves", "autumnHalves", "springHalves", "firstHalves"] as const) {
      const periods = presetPeriods(preset, SPRING, YEAR, LOV, 6)!;
      for (const pair of [["hk", "sl"], ["sl", "hk"]] as const) {
        const split = swap(periods, pair);
        const reduction = classPostReduction(sources(), split, "sl");
        const adjusted = reduction ? { requirementId: reduction.requirementId, week: reduction.to } : null;
        for (const half of linesOf(halvesTimplan(sources(), { ...split, adjusted }, "hk"))) {
          for (const [subject, planned, target] of half) {
            expect(planned as number, `${preset} ${pair.join("/")} ${subject}`).toBeGreaterThanOrEqual(target as number);
          }
        }
      }
    }
  });

  it("gives both halves alike over the läsår halved, and needs exactly twice the pace when its weeks are even", () => {
    const even = { startDate: "2026-08-17", endDate: "2027-06-04" };
    const halves = presetPeriods("yearHalves", SPRING, even, [], 6)!;
    const split = swap(halves, ["hk", "sl"], "swapWithOther", [HEMKUNSKAP, SLOJD, MATEMATIK], HEMKUNSKAP, { year: even, closures: [] });
    expect(split.rows[0]).toMatchObject({ lessonsPerWeek: 2, minutesPerLesson: 30 });
    const result = halvesTimplan({ ...sources(), year: even, closures: [] }, split, "hk");
    expect(linesOf(result)).toEqual([
      [
        ["hk", 30, 30],
        ["sl", 110, 80],
      ],
      [
        ["hk", 30, 30],
        ["sl", 110, 80],
      ],
    ]);
    expect(classPostReduction({ ...sources(), year: even, closures: [] }, split, "sl")?.to).toEqual({ count: 2, minutes: 25 });
  });
});

describe("what there is to judge", () => {
  it("says the årskurs follows no plan", () => {
    expect(halvesTimplan({ ...sources(), attachments: [] }, swap(TERMS), "hk")).toEqual({ kind: "noPlan", gradeLevel: 6 });
  });

  it("says the class has no årskurs", () => {
    const split = { ...swap(TERMS), theClass: { id: "6A", name: "6A", gradeLevel: null } };
    expect(halvesTimplan(sources(), split, "hk")).toEqual({ kind: "noGrade" });
    expect(classPostReduction(sources(), split, "sl")).toBeNull();
  });

  it("names a line with no target without minutes, and proposes nothing for it", () => {
    const result = halvesTimplan(sources([{ subjectId: "hk", minutesPerWeek: 30 }]), swap(TERMS), "hk");
    if (result.kind !== "lines") throw new Error(result.kind);
    // Slöjd has 6A's post, so the line is there, with no target to read.
    expect(result.halves[0].map((line) => [line.key, line.target, line.planned])).toEqual([
      ["subject:hk", 30, 32],
      ["subject:sl", null, null],
    ]);
    expect(classPostReduction(sources([{ subjectId: "hk", minutesPerWeek: 30 }]), swap(TERMS), "sl")).toBeNull();
  });

  it("proposes nothing without a class post in the other subject, or with one of two lengths", () => {
    expect(classPostReduction(sources(), swap(TERMS, ["hk", "sl"], "swapWithOther", [HEMKUNSKAP, MATEMATIK]), "sl")).toBeNull();
    const mixed = post("r-sl", "sl", 2, 50, { lessonLengths: [50, 30] });
    expect(classPostReduction(sources(), swap(TERMS, ["hk", "sl"], "swapWithOther", [HEMKUNSKAP, mixed]), "sl")).toBeNull();
  });

  it("stops at the target, not a minute under it: one 50 for a slöjd target of 78, since one 45 leaves 6A:2 at 77", () => {
    // 6A's slöjd 1 × 80; the swap gives 37,8 and 32,2. 50 + 32,2 is 82 and
    // 45 + 32,2 is 77,2, which the timplan reads as 77: under 78.
    const one = post("r-sl", "sl", 1, 80);
    const target78 = sources([
      { subjectId: "hk", minutesPerWeek: 30 },
      { subjectId: "sl", minutesPerWeek: 78 },
    ]);
    const split = swap(TERMS, ["hk", "sl"], "swapWithOther", [HEMKUNSKAP, one]);
    expect(classPostReduction(target78, split, "sl")).toMatchObject({ to: { count: 1, minutes: 50 }, target: 78, planned: [88, 82] });
    const below = halvesTimplan(target78, { ...split, adjusted: { requirementId: "r-sl", week: { count: 1, minutes: 45 } } }, "hk");
    expect(linesOf(below).map((half) => half[1])).toEqual([
      ["sl", 83, 78],
      ["sl", 77, 78],
    ]);
  });

  it("judges the class's post in its own weeks: odd weeks count half, so 4 × 40 comes down only to 4 × 25", () => {
    // 4 × 40 odd weeks is 80 a standard week. 6A:2 needs 48 of it besides
    // the swap's 32,2, so 96 a week on odd weeks: 4 × 25 is 100 (50 a
    // standard week). Read as every week it would come down to 4 × 15 and
    // leave 6A:2 at 30 + 32,2 = 62 of 80.
    const odd = post("r-sl", "sl", 4, 40, { recurrence: "ODD_WEEKS" });
    const split = swap(TERMS, ["hk", "sl"], "swapWithOther", [HEMKUNSKAP, odd]);
    const reduction = classPostReduction(sources(), split, "sl");
    expect(reduction).toMatchObject({ from: { count: 4, minutes: 40 }, to: { count: 4, minutes: 25 }, planned: [88, 82] });
    const after = halvesTimplan(sources(), { ...split, adjusted: { requirementId: "r-sl", week: reduction!.to } }, "hk");
    expect(linesOf(after).map((half) => half[1])).toEqual([
      ["sl", 88, 80],
      ["sl", 82, 80],
    ]);
  });

  it("takes fewer lessons when that leaves fewer minutes: 4 × 25 comes down to 2 × 25, not 4 × 15", () => {
    const many = post("r-sl", "sl", 4, 25);
    const reduction = classPostReduction(sources(), swap(TERMS, ["hk", "sl"], "swapWithOther", [HEMKUNSKAP, many]), "sl");
    // 50 + 32,2 and 50 + 37,8; one lesson of 25 would leave 57 and 63.
    expect(reduction).toMatchObject({ from: { count: 4, minutes: 25 }, to: { count: 2, minutes: 25 }, planned: [88, 82] });
  });

  it("proposes nothing when no half is over, and says when the post is in a block", () => {
    // Slöjd 2 × 25 already: 50 + 32,2 and 50 + 37,8 are 82 and 88, and one step down is under.
    const low = post("r-sl", "sl", 2, 25);
    expect(classPostReduction(sources(), swap(TERMS, ["hk", "sl"], "swapWithOther", [HEMKUNSKAP, low]), "sl")).toBeNull();
    const inBlock = { ...SLOJD, blockId: "b-sl" };
    expect(classPostReduction(sources(), swap(TERMS, ["hk", "sl"], "swapWithOther", [HEMKUNSKAP, inBlock]), "sl")).toMatchObject({
      to: { count: 2, minutes: 25 },
      inBlock: true,
    });
  });

  it("keeps the slöjd swap of #215 as it was: each pupil reads its two subjects of the line in a term each", () => {
    // 7A's slöjd 2 × 60 into textilslöjd and trä- och metallslöjd, the plan
    // naming the two. The class's pace stays, and each line is its term.
    const slojd = post("r-sl", "sl", 2, 60);
    const split = swap(TERMS, ["tx", "tm"], "swapWithinLine", [slojd], slojd);
    expect(split.rows[0]).toMatchObject({ lessonsPerWeek: 2, minutesPerLesson: 60 });
    const result = halvesTimplan(
      sources([
        { subjectId: "tx", minutesPerWeek: 60 },
        { subjectId: "tm", minutesPerWeek: 60 },
      ]),
      split,
      "sl",
    );
    expect(linesOf(result)).toEqual([
      [
        ["sl", null, null],
        ["tx", 55, 60],
        ["tm", 65, 60],
      ],
      [
        ["sl", null, null],
        ["tx", 65, 60],
        ["tm", 55, 60],
      ],
    ]);
  });

  it("reads the halves the class has by their own ids", () => {
    const halves = [
      { id: "h1", name: "6A:1" },
      { id: "h2", name: "6A:2" },
    ] as const;
    // The split's rows on the halves' ids and the pupil in them: a pupil
    // missing their half's rows would read 0 hemkunskap and 80 slöjd.
    const result = halvesTimplan(sources(), { ...swap(TERMS), halves }, "hk");
    expect(linesOf(result)).toEqual([
      [
        ["hk", 32, 30],
        ["sl", 118, 80],
      ],
      [
        ["hk", 38, 30],
        ["sl", 112, 80],
      ],
    ]);
  });
});
