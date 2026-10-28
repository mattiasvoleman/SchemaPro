import { describe, expect, it } from "vitest";
import { annualMinutes } from "./teaching-hours";
import { standardWeekWeight } from "./standard-week";
import {
  halvesRead,
  halvesRow,
  lengthsOf,
  periodsProblem,
  plannedRows,
  presetPeriods,
  proposedLessons,
  readsPostLine,
  termHalfway,
  type HalvesRead,
} from "./half-class-periods";

/**
 * The läsår 2026/27: the autumn is 17 August to 3 January, twenty teaching
 * weeks with no lov entered; the spring 4 January to 11 June, twenty-three.
 */
const YEAR = { startDate: "2026-08-17", endDate: "2027-06-11" };
const SPRING = "2027-01-04";
const AUTUMN = { startDate: "2026-08-17", endDate: "2027-01-03" };
/** Höstlovet (week 44) and jullovet's two weeks. */
const LOV = [
  { startDate: "2026-10-26", endDate: "2026-10-30" },
  { startDate: "2026-12-21", endDate: "2027-01-01" },
];
/**
 * A läsår as a school enters it: höstlov, jullov to Trettondagen's week,
 * sportlov and påsklov. Seventeen teaching weeks in the autumn and twenty in
 * the spring, 37 in all.
 */
const SCHOOL_LOV = [
  { startDate: "2026-10-26", endDate: "2026-10-30" },
  { startDate: "2026-12-21", endDate: "2027-01-08" },
  { startDate: "2027-02-22", endDate: "2027-02-26" },
  { startDate: "2027-03-29", endDate: "2027-04-02" },
];

describe("termHalfway", () => {
  it("splits a term's teaching weeks evenly: ten and ten in an autumn of twenty", () => {
    expect(termHalfway(AUTUMN, YEAR, [], null)).toBe("2026-10-26");
  });

  it("counts the weeks with lov off, so höstlovet and jullovet move the mark, the extra week to the second half", () => {
    // Seventeen teaching weeks: 8 before 12 October, 9 from it.
    expect(termHalfway(AUTUMN, YEAR, LOV, 7)).toBe("2026-10-12");
  });

  it("moves the mark later for lov in the first half: nine taught weeks on each side", () => {
    // Two studieveckor in September and October: 18 teaching weeks, the
    // second half starting 2 November rather than 26 October.
    const early = [
      { startDate: "2026-09-07", endDate: "2026-09-11" },
      { startDate: "2026-10-05", endDate: "2026-10-09" },
    ];
    expect(termHalfway(AUTUMN, YEAR, early, null)).toBe("2026-11-02");
  });

  it("reads a lov only for the grades it closes", () => {
    const lowerOnly = LOV.map((lov) => ({ ...lov, minGradeLevel: 1, maxGradeLevel: 3 }));
    expect(termHalfway(AUTUMN, YEAR, lowerOnly, 7)).toBe("2026-10-26");
  });

  it("has no mark for a term with no Monday after its first day", () => {
    expect(termHalfway({ startDate: "2026-08-17", endDate: "2026-08-21" }, YEAR, [], null)).toBeNull();
  });
});

describe("presetPeriods", () => {
  it("draws the two terms from the spring term's first day", () => {
    expect(presetPeriods("terms", SPRING, YEAR, [], null)).toEqual([
      { startDate: "2026-08-17", endDate: "2027-01-03" },
      { startDate: "2027-01-04", endDate: "2027-06-11" },
    ]);
  });

  it("draws the first and second half of the autumn", () => {
    expect(presetPeriods("autumnHalves", SPRING, YEAR, [], null)).toEqual([
      { startDate: "2026-08-17", endDate: "2026-10-25" },
      { startDate: "2026-10-26", endDate: "2027-01-03" },
    ]);
  });

  it("draws the first and second half of the spring, the odd week to the second", () => {
    expect(presetPeriods("springHalves", SPRING, YEAR, [], null)).toEqual([
      { startDate: "2027-01-04", endDate: "2027-03-21" },
      { startDate: "2027-03-22", endDate: "2027-06-11" },
    ]);
  });

  it("draws the first half of each term", () => {
    expect(presetPeriods("firstHalves", SPRING, YEAR, [], null)).toEqual([
      { startDate: "2026-08-17", endDate: "2026-10-25" },
      { startDate: "2027-01-04", endDate: "2027-03-21" },
    ]);
  });

  it("draws the läsår in two halves of as many teaching weeks, whatever the spring start", () => {
    // 43 weeks: 21 and 22, the odd week to the second half.
    expect(presetPeriods("yearHalves", SPRING, YEAR, [], null)).toEqual([
      { startDate: "2026-08-17", endDate: "2027-01-10" },
      { startDate: "2027-01-11", endDate: "2027-06-11" },
    ]);
    expect(presetPeriods("yearHalves", "", YEAR, [], null)).toEqual(presetPeriods("yearHalves", SPRING, YEAR, [], null));
    // With the school's lov, 18 and 19 of 37.
    expect(presetPeriods("yearHalves", SPRING, YEAR, SCHOOL_LOV, 6)).toEqual([
      { startDate: "2026-08-17", endDate: "2027-01-17" },
      { startDate: "2027-01-18", endDate: "2027-06-11" },
    ]);
  });

  it("draws nothing from a spring start outside the year", () => {
    expect(presetPeriods("terms", "2026-08-17", YEAR, [], null)).toBeNull();
    expect(presetPeriods("autumnHalves", "", YEAR, [], null)).toBeNull();
  });
});

describe("periodsProblem", () => {
  const [first, second] = presetPeriods("autumnHalves", SPRING, YEAR, [], null)!;

  it("takes two of the year's stretches, the first ending before the second starts", () => {
    expect(periodsProblem([first, second], YEAR)).toBeNull();
    // Touching is not meeting: 25 October, then 26.
    expect(periodsProblem([first, { ...second, startDate: "2026-10-26" }], YEAR)).toBeNull();
  });

  it.each([
    ["a day not given", [first, { ...second, endDate: "" }], "MISSING"],
    ["a period that ends before it starts", [{ ...first, endDate: "2026-08-01" }, second], "BACKWARDS"],
    ["a period before the year", [{ ...first, startDate: "2026-08-10" }, second], "OUTSIDE_YEAR"],
    ["a period after the year", [first, { ...second, endDate: "2027-06-18" }], "OUTSIDE_YEAR"],
    ["periods that meet", [first, { ...second, startDate: "2026-10-25" }], "OVERLAP"],
    ["the second period first", [second, first], "OVERLAP"],
  ] as const)("refuses %s", (_, periods, problem) => {
    expect(periodsProblem(periods, YEAR)).toBe(problem);
  });
});

describe("how the halves read the post's line", () => {
  const subjects = [
    { id: "hk", nationalCode: "HKK" },
    { id: "sl", nationalCode: "SLJ" },
    { id: "tx", nationalCode: "SLJ" },
    { id: "tm", nationalCode: "SLJ" },
    { id: "own", nationalCode: null },
    { id: "own2", nationalCode: null },
  ];

  it("counts the post's subject, and a subject with its national code, as the line", () => {
    expect(readsPostLine("hk", "hk", subjects)).toBe(true);
    expect(readsPostLine("tx", "sl", subjects)).toBe(true);
    expect(readsPostLine("sl", "hk", subjects)).toBe(false);
    // A post without a code has only its own subject on its line.
    expect(readsPostLine("own", "own", subjects)).toBe(true);
    expect(readsPostLine("hk", "own", subjects)).toBe(false);
    // Nor are two without codes one line: no code says they are.
    expect(readsPostLine("own2", "own", subjects)).toBe(false);
  });

  it.each([
    ["one subject", ["hk", ""], "hk", "inTurn"],
    ["hemkunskap swapped with slöjd", ["hk", "sl"], "hk", "swapWithOther"],
    ["slöjd swapped with hemkunskap, the post's subject second", ["sl", "hk"], "hk", "swapWithOther"],
    ["textilslöjd and trä- och metallslöjd for a slöjd post", ["tx", "tm"], "sl", "swapWithinLine"],
    ["slöjd and textilslöjd for a slöjd post", ["sl", "tx"], "sl", "swapWithinLine"],
    ["two subjects neither of which is the line", ["hk", "own"], "sl", "swapWithinLine"],
    ["a post without a code swapped with another subject without one", ["own", "own2"], "own", "swapWithOther"],
  ] as const)("reads %s", (_, pair, post, read) => {
    expect(halvesRead(pair, post, subjects)).toBe(read);
  });
});

describe("proposedLessons", () => {
  const slojd = { lessonsPerWeek: 2, minutesPerLesson: 60, lessonLengths: [], recurrence: "ALL_WEEKS" as const };
  const hemkunskap = { lessonsPerWeek: 1, minutesPerLesson: 30, lessonLengths: [], recurrence: "ALL_WEEKS" as const };
  const terms = presetPeriods("terms", SPRING, YEAR, [], null)!;
  const autumnHalves = presetPeriods("autumnHalves", SPRING, YEAR, [], null)!;

  it("keeps the class's week for two subjects of the line over the terms: each pupil reads it all year", () => {
    expect(proposedLessons(slojd, terms, "swapWithinLine", YEAR, [], null)).toBeNull();
  });

  it("asks more than twice the pace for one subject over the terms, over the shorter one, rounded up", () => {
    // 2 × 60 over 43 weeks is 5 160 minutes; over the autumn's 20, 258 a
    // week: 4,3 lessons, so five. Four would leave each pupil 7 % short.
    expect(proposedLessons(slojd, terms, "inTurn", YEAR, [], null)).toEqual({ count: 5, minutes: 60 });
  });

  it("asks over four times the pace of hemkunskap read in half the autumn, in the class's lesson length", () => {
    // 1 × 30 over 43 weeks is 1 290 minutes; over ten weeks, 129 a week:
    // 4,3 lessons of 30, so five (150), never four (120, 27,9 a standard week).
    expect(proposedLessons(hemkunskap, autumnHalves, "inTurn", YEAR, [], null)).toEqual({ count: 5, minutes: 30 });
  });

  it("rounds a need that is no whole number of lessons up: 2 × 45 over half the autumn is 8,6 lessons", () => {
    const twoBy45 = { lessonsPerWeek: 2, minutesPerLesson: 45, lessonLengths: [], recurrence: "ALL_WEEKS" as const };
    // 90 × 43 / 10 = 387 a week, 8,6 lessons of 45.
    expect(proposedLessons(twoBy45, autumnHalves, "inTurn", YEAR, [], null)).toEqual({ count: 9, minutes: 45 });
  });

  it("does not round up a need that is a whole number of lessons", () => {
    // A läsår of 40 weeks, two terms of 20: half the autumn is ten weeks,
    // and 1 × 30 over 40 weeks is exactly 4 × 30 over ten.
    const forty = { startDate: "2026-08-17", endDate: "2027-05-21" };
    const halves = presetPeriods("autumnHalves", SPRING, forty, [], null)!;
    expect(proposedLessons(hemkunskap, halves, "inTurn", forty, [], null)).toEqual({ count: 4, minutes: 30 });
  });

  it("asks a lesson more when the periods miss a week of the year: a week short is still short", () => {
    // Two subjects of the line over the terms with Christmas week in
    // neither: 19 + 23 of 43 weeks, 2 × 60 × 43 / 42 = 122,9 a week. The
    // class's own week would leave each pupil 2 % under; the proposal is
    // 3 × 60, as #215 proposed it, and the dialog shows the hours beside it.
    const gap = [
      { startDate: "2026-08-17", endDate: "2026-12-27" },
      { startDate: "2027-01-04", endDate: "2027-06-11" },
    ] as const;
    expect(proposedLessons(slojd, gap, "swapWithinLine", YEAR, [], null)).toEqual({ count: 3, minutes: 60 });
  });

  it("asks over twice the pace for two subjects of the line swapped within the autumn, in the class's lesson length", () => {
    // 120 × 43 / 20 = 258 a week: 5 × 60, as #215 proposed it, and not the
    // class's two lessons made longer (2 × 130), which only a swap with
    // another line takes.
    expect(proposedLessons(slojd, autumnHalves, "swapWithinLine", YEAR, [], null)).toEqual({ count: 5, minutes: 60 });
  });

  describe("hemkunskap swapped with slöjd over the terms, 17 and 20 of 37 teaching weeks", () => {
    const year = presetPeriods("terms", SPRING, YEAR, SCHOOL_LOV, 6)!;
    /** What a pupil of each half gets of hemkunskap a standard week, as the timplan weighs a post. */
    const perHalf = (lessons: { count: number; minutes: number } | null) =>
      year.map((period) => {
        const week = lessons ? lessons.count * lessons.minutes : 30;
        return week * standardWeekWeight({ ...period, gradeSpan: { min: 6, max: 6 } }, YEAR, SCHOOL_LOV);
      });

    it("gives each half the class's 30 minutes over the shorter term: 1 × 70, not the class's pace", () => {
      // 30 × 37 / 17 = 65,3 a week: 3 × 30 would be 90, 1 × 70 is the closer.
      const lessons = proposedLessons(hemkunskap, year, "swapWithOther", YEAR, SCHOOL_LOV, 6);
      expect(lessons).toEqual({ count: 1, minutes: 70 });
      const [autumn, spring] = perHalf(lessons);
      expect(autumn).toBeCloseTo((70 * 17) / 37, 9);
      expect(spring).toBeCloseTo((70 * 20) / 37, 9);
      expect(Math.min(autumn!, spring!)).toBeGreaterThanOrEqual(30);
    });

    it("is not the line read over both terms: that keeps the class's pace and leaves both halves under", () => {
      // The mutant this rules out: the year's weeks over first + second, as
      // the two subjects of one line read them. 14 and 16 a standard week.
      expect(proposedLessons(hemkunskap, year, "swapWithinLine", YEAR, SCHOOL_LOV, 6)).toBeNull();
      const [autumn, spring] = perHalf(null);
      expect(Math.round(autumn!)).toBe(14);
      expect(Math.round(spring!)).toBe(16);
    });

    it("needs exactly twice the pace over the läsår halved, when its teaching weeks are even", () => {
      // 2026-08-17 to 2027-06-04 without lov is 42 weeks: 21 and 21.
      const even = { startDate: "2026-08-17", endDate: "2027-06-04" };
      const halves = presetPeriods("yearHalves", SPRING, even, [], 6)!;
      const lessons = proposedLessons(hemkunskap, halves, "swapWithOther", even, [], 6);
      expect(lessons).toEqual({ count: 2, minutes: 30 });
      for (const period of halves) {
        expect(60 * standardWeekWeight({ ...period, gradeSpan: { min: 6, max: 6 } }, even, [])).toBe(30);
      }
    });

    it("rounds up over the läsår halved when its weeks are odd: 18 and 19 of 37 take 1 × 65", () => {
      const halves = presetPeriods("yearHalves", SPRING, YEAR, SCHOOL_LOV, 6)!;
      // 30 × 37 / 18 = 61,7: twice the pace would leave the shorter half at 29,2.
      expect(proposedLessons(hemkunskap, halves, "swapWithOther", YEAR, SCHOOL_LOV, 6)).toEqual({ count: 1, minutes: 65 });
    });
  });

  it("never leaves a half under the class's minutes, whatever the preset, the lov, the week or how the halves read", () => {
    const weeks = [
      { lessonsPerWeek: 1, minutesPerLesson: 30, lessonLengths: [] },
      { lessonsPerWeek: 2, minutesPerLesson: 45, lessonLengths: [] },
      { lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] },
      { lessonsPerWeek: 3, minutesPerLesson: 60, lessonLengths: [] },
    ];
    const presets = ["terms", "yearHalves", "autumnHalves", "springHalves", "firstHalves"] as const;
    const reads: HalvesRead[] = ["inTurn", "swapWithOther", "swapWithinLine"];
    for (const closures of [[], LOV, SCHOOL_LOV]) {
      for (const week of weeks) {
        for (const recurrence of ["ALL_WEEKS", "ODD_WEEKS"] as const) {
          const post = { ...week, recurrence };
          // As the timplan counts the class's post and a half's: standardvecka minutes.
          const classMinutes = (post.lessonLengths.length > 0 ? 120 : post.lessonsPerWeek * post.minutesPerLesson) *
            standardWeekWeight({ ...post, gradeSpan: { min: 7, max: 7 } }, YEAR, closures);
          for (const preset of presets) {
            const periods = presetPeriods(preset, SPRING, YEAR, closures, 7)!;
            for (const read of reads) {
              const row = halvesRow(post, proposedLessons(post, periods, read, YEAR, closures, 7));
              const minutes = row.lessonLengths && row.lessonLengths.length > 0 ? 120 : row.lessonsPerWeek * row.minutesPerLesson;
              const got = periods.map(
                (period) => minutes * standardWeekWeight({ ...period, recurrence, gradeSpan: { min: 7, max: 7 } }, YEAR, closures),
              );
              // In turn and in a swap with another line each half reads the
              // line in one period; within the line, in both.
              const perPupil = read === "swapWithinLine" ? got[0]! + got[1]! : Math.min(...got);
              expect(perPupil, `${preset}, ${read}, ${recurrence}, ${week.lessonsPerWeek} lessons`).toBeGreaterThanOrEqual(
                classMinutes - 1e-6,
              );
            }
          }
        }
      }
    }
  });

  it("keeps each pupil's hours over the year as well, in turn and in a swap with another line", () => {
    for (const closures of [[], LOV, SCHOOL_LOV]) {
      const post = { ...hemkunskap };
      const classHours = annualMinutes(post, YEAR, closures, 7);
      for (const preset of ["terms", "yearHalves", "autumnHalves", "firstHalves"] as const) {
        const periods = presetPeriods(preset, SPRING, YEAR, closures, 7)!;
        for (const read of ["inTurn", "swapWithOther"] as const) {
          const row = halvesRow(post, proposedLessons(post, periods, read, YEAR, closures, 7));
          const hours = periods.map((period) =>
            annualMinutes({ ...row, lessonLengths: row.lessonLengths ?? [], ...period }, YEAR, closures, 7),
          );
          expect(Math.min(...hours), `${preset}, ${read}`).toBeGreaterThanOrEqual(classHours - 1e-6);
        }
      }
    }
  });

  it("counts odd weeks as the timplan counts the class's post: half its lessons, over the period's own odd weeks", () => {
    const odd = { ...hemkunskap, recurrence: "ODD_WEEKS" as const };
    // The class's 1 × 30 odd weeks is 15 a standard week; half the autumn
    // has five odd weeks of 43: 15 × 43 / 5 = 129, 4,3 lessons, so five.
    expect(proposedLessons(odd, autumnHalves, "inTurn", YEAR, [], null)).toEqual({ count: 5, minutes: 30 });
  });

  it("does not leave a varannan-vecka half a lesson's rounding under, as counting the year's even weeks did", () => {
    // 2 × 40 even weeks is 40 a standard week. Four weeks each, two of them
    // even, of 43: 40 × 43 / 2 = 860 a week, 21,5 lessons, so 22. Counting the
    // year's 21 even weeks instead (21 × 80 / 2 = 840) asked for 21, which the
    // timplan reads as 21 × 40 × 2 / 43 = 39,07 for each half: under.
    const even = { lessonsPerWeek: 2, minutesPerLesson: 40, lessonLengths: [], recurrence: "EVEN_WEEKS" as const };
    const periods = [
      { startDate: "2026-08-17", endDate: "2026-09-13" },
      { startDate: "2026-09-14", endDate: "2026-10-11" },
    ] as const;
    const lessons = proposedLessons(even, periods, "inTurn", YEAR, [], null);
    expect(lessons).toEqual({ count: 22, minutes: 40 });
    for (const period of periods) {
      expect(22 * 40 * standardWeekWeight({ ...period, recurrence: "EVEN_WEEKS" }, YEAR, [])).toBeGreaterThanOrEqual(40);
    }
  });

  it("proposes nothing for a period without a teaching week", () => {
    const allLov = [{ startDate: "2026-08-17", endDate: "2026-10-25" }];
    expect(proposedLessons(hemkunskap, autumnHalves, "inTurn", YEAR, allLov, null)).toBeNull();
  });
});

describe("the posts the split writes", () => {
  const periods = presetPeriods("autumnHalves", SPRING, YEAR, [], null)!;
  const week = halvesRow({ lessonsPerWeek: 1, minutesPerLesson: 30 }, { count: 4, minutes: 30 });

  it("writes one subject as a post per half in its own period", () => {
    expect(plannedRows(week, "ALL_WEEKS", periods, 1).map((row) => [row.half, row.subject, row.startDate, row.endDate])).toEqual([
      [0, 0, "2026-08-17", "2026-10-25"],
      [1, 0, "2026-10-26", "2027-01-03"],
    ]);
  });

  it("writes two subjects as four posts, the halves swapping them", () => {
    expect(plannedRows(week, "ALL_WEEKS", periods, 2).map((row) => [row.half, row.subject, row.startDate])).toEqual([
      [0, 0, "2026-08-17"],
      [0, 1, "2026-10-26"],
      [1, 1, "2026-08-17"],
      [1, 0, "2026-10-26"],
    ]);
  });

  it("sends a week of one length as one length per lesson, and keeps the class's when there is none", () => {
    expect(lengthsOf({ count: 4, minutes: 30 })).toEqual([30, 30, 30, 30]);
    expect(week).toEqual({ lessonsPerWeek: 4, minutesPerLesson: 30, lessonLengths: [] });
    const mixed = { lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] };
    expect(halvesRow(mixed, null)).toBe(mixed);
  });
});
