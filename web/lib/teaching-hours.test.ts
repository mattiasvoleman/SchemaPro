import { describe, expect, it } from "vitest";
import type {
  ClosedRange,
  Recurrence,
  RequirementLoad,
  YearBounds,
} from "./teaching-hours";
import {
  annualMinutes,
  formatHours,
  peakLessonsPerWeek,
  peakLessonsPerWeekByKey,
  teachingWeeks,
  weeksInPeriod,
} from "./teaching-hours";

// ---------------------------------------------------------------------------
// The year under test is 2026-08-17 (Mon, ISO week 34) to 2027-06-11 (Fri, ISO
// week 23) — a real Swedish läsår shape, chosen because ISO 2026 has 53 weeks.
// Week 53 runs 2026-12-28 to 2027-01-03 and is followed by week 1, so the year
// contains two ODD weeks back to back. Any implementation that counts weeks
// from term start instead of reading the ISO number gets everything after that
// seam exactly backwards, which is the failure these tests exist to catch.
//
// Counted out by hand across the year: it touches 43 ISO weeks, 22 of them odd
// and 21 even. The odd surplus IS the seam. (The year opens on a Monday and
// closes on a Friday, so it touched the same 43 weeks back when a week meant
// Mon-Fri — these three numbers did not move when DAYS_IN_WEEK became 7. The
// counts at the EDGES of shorter periods did; see the straddling tests.)
// ---------------------------------------------------------------------------

const YEAR: YearBounds = { startDate: "2026-08-17", endDate: "2027-06-11" };

const ALL_WEEKS_IN_YEAR = 43;
const ODD_WEEKS_IN_YEAR = 22;
const EVEN_WEEKS_IN_YEAR = 21;

function req(overrides: Partial<RequirementLoad> = {}): RequirementLoad {
  return { lessonsPerWeek: 1, minutesPerLesson: 60, ...overrides };
}

// ---------------------------------------------------------------------------
// The oracle: src/calendar/lesson-recurrence.ts's runsOn, ported day by day.
//
// This is a deliberate second implementation of that module — isoWeekNumber's
// Thursday-anchored algorithm and runsOn's date-bounds-then-parity branch,
// written out rather than imported, because the web copy (isoWeek in
// lib/utils.ts) uses the shorter Jan-1 formulation. If the two ever drifted the
// calendar a parent subscribes to would show a different week than the schedule
// the school publishes, so the equivalence is worth asserting rather than
// assuming. Counting days here and weeks in the module is the point: the module
// must agree with "which days does this actually run on", not merely with
// itself.
//
// IT BORROWS NOTHING FROM THE IMPLEMENTATION, ON PURPOSE.
//
// It used to open by copying clampToYear line for line — same string
// comparisons, same "period narrows the year" reading. That made the two agree
// about clipping by construction: get the clip backwards in teaching-hours.ts,
// paste the same mistake here, and every comparison below still passes. So the
// clip is not reproduced at all now. Instead the walk is bounded by the YEAR,
// which is the year's actual meaning, and the PERIOD's own bounds are enforced
// where runsOn enforces them — inside the per-day predicate, by date. Nothing
// here decides which of two dates wins; the day either falls in both ranges or
// it does not.
//
// Weeks are identified by their Thursday, not by a Monday computed the way
// startOfIsoWeek computes one, for the same independence reason: Thursday is
// what ISO says owns the week, so a week's identity here comes from the
// standard rather than from the helper under test. Two ISO years can each hold
// a "week 34", so the NUMBER alone would fuse them.
// ---------------------------------------------------------------------------

const asDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-` +
  `${String(date.getDate()).padStart(2, "0")}`;

/** The Thursday of `date`'s ISO week, as yyyy-mm-dd — a unique week identity. */
function isoWeekThursday(date: Date): string {
  const target = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
  const dayOfWeek = target.getUTCDay() === 0 ? 7 : target.getUTCDay();
  target.setUTCDate(target.getUTCDate() + 4 - dayOfWeek);
  return target.toISOString().slice(0, 10);
}

function isoWeekNumberServerSide(date: Date): number {
  const target = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
  const dayOfWeek = target.getUTCDay() === 0 ? 7 : target.getUTCDay();
  target.setUTCDate(target.getUTCDate() + 4 - dayOfWeek);

  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayOfWeek =
    firstThursday.getUTCDay() === 0 ? 7 : firstThursday.getUTCDay();
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 4 - firstDayOfWeek);

  return (
    Math.round(
      (target.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000),
    ) + 1
  );
}

interface OraclePeriod {
  recurrence?: Recurrence | null;
  startDate?: string | null;
  endDate?: string | null;
}

/**
 * runsOn, transcribed: outside the period's own dates, no; otherwise parity.
 *
 * No weekday branch, because the real runsOn has none — Lesson.dayOfWeek runs
 * 1-7 and a Sunday lesson is a lesson. An oracle that skipped weekends would be
 * asserting the old Mon-Fri assumption instead of testing it.
 */
function runsOnDay(period: OraclePeriod, date: Date): boolean {
  const day = asDay(date);
  if (period.startDate && day < period.startDate) return false;
  if (period.endDate && day > period.endDate) return false;

  const recurrence = period.recurrence ?? "ALL_WEEKS";
  if (recurrence === "ALL_WEEKS") return true;
  const odd = isoWeekNumberServerSide(date) % 2 === 1;
  return recurrence === "ODD_WEEKS" ? odd : !odd;
}

/** Distinct ISO weeks holding at least one day of the year runsOn is true for. */
function weeksByCountingDays(period: OraclePeriod, year: YearBounds): number {
  const weeks = new Set<string>();
  for (
    const day = new Date(`${year.startDate}T00:00:00`);
    asDay(day) <= year.endDate;
    day.setDate(day.getDate() + 1)
  ) {
    if (runsOnDay(period, day)) weeks.add(isoWeekThursday(day));
  }
  return weeks.size;
}

describe("weeksInPeriod", () => {
  it("reads an empty period as the whole academic year", () => {
    expect(weeksInPeriod({}, YEAR)).toBe(ALL_WEEKS_IN_YEAR);
  });

  it("reads a null recurrence as ALL_WEEKS rather than dropping the period", () => {
    expect(weeksInPeriod({ recurrence: null }, YEAR)).toBe(ALL_WEEKS_IN_YEAR);
    expect(weeksInPeriod({ recurrence: "ALL_WEEKS" }, YEAR)).toBe(ALL_WEEKS_IN_YEAR);
  });

  it("splits the year between the two parities", () => {
    expect(weeksInPeriod({ recurrence: "ODD_WEEKS" }, YEAR)).toBe(ODD_WEEKS_IN_YEAR);
    expect(weeksInPeriod({ recurrence: "EVEN_WEEKS" }, YEAR)).toBe(EVEN_WEEKS_IN_YEAR);
  });

  it("loses no week and double-counts none when the parities are added up", () => {
    // Asks the library three times and compares its own answers. It used to
    // add two local constants and compare them with a third — 22 + 21 === 43,
    // arithmetic that holds whatever weeksInPeriod returns, including 0 for
    // everything. The constants are still here, but as the pinned expectation
    // in the tests above; this one is about the partition, so it must be the
    // implementation's numbers that get added.
    const odd = weeksInPeriod({ recurrence: "ODD_WEEKS" }, YEAR);
    const even = weeksInPeriod({ recurrence: "EVEN_WEEKS" }, YEAR);
    const all = weeksInPeriod({}, YEAR);

    expect(odd + even).toBe(all);
    // Guards the degenerate partition: 0 + 0 === 0 would satisfy the line
    // above and mean the walk never runs.
    expect(all).toBeGreaterThan(0);
    expect(odd).toBeGreaterThan(0);
    expect(even).toBeGreaterThan(0);
  });

  it("takes only a startDate, running to the year's own end", () => {
    // 2027-01-11 is the Monday of week 2; weeks 2..23 remain.
    expect(weeksInPeriod({ startDate: "2027-01-11" }, YEAR)).toBe(22);
  });

  it("takes only an endDate, running from the year's own start", () => {
    // Week 34 through week 51, the autumn term.
    expect(weeksInPeriod({ endDate: "2026-12-18" }, YEAR)).toBe(18);
  });

  it("returns 0 for a period that ends before the year begins", () => {
    expect(
      weeksInPeriod({ startDate: "2026-01-01", endDate: "2026-06-30" }, YEAR),
    ).toBe(0);
  });

  it("returns 0 for a period that starts after the year ends", () => {
    expect(
      weeksInPeriod({ startDate: "2027-07-01", endDate: "2027-08-31" }, YEAR),
    ).toBe(0);
  });

  it("returns 0 for a period whose dates are the wrong way round", () => {
    expect(
      weeksInPeriod({ startDate: "2027-01-01", endDate: "2026-09-01" }, YEAR),
    ).toBe(0);
  });

  it("clamps a period that starts before the year to the year's start", () => {
    const straddling = { startDate: "2026-06-01", endDate: "2026-09-30" };
    const clamped = { startDate: "2026-08-17", endDate: "2026-09-30" };
    expect(weeksInPeriod(straddling, YEAR)).toBe(weeksInPeriod(clamped, YEAR));
    expect(weeksInPeriod(straddling, YEAR)).toBe(7);
  });

  it("clamps a period that runs past the year to the year's end", () => {
    const straddling = { startDate: "2027-05-01", endDate: "2027-12-31" };
    const clamped = { startDate: "2027-05-01", endDate: "2027-06-11" };
    expect(weeksInPeriod(straddling, YEAR)).toBe(weeksInPeriod(clamped, YEAR));
    // 7, not 6. 2027-05-01 is a SATURDAY, so the period opens inside week 17
    // and week 17 counts. Under the old Mon-Fri week it opened after week 17's
    // Friday and that week was thrown away — the same lost-edge-week bug as the
    // Sunday start below, in the shape it took at a period's front edge.
    expect(weeksInPeriod(straddling, YEAR)).toBe(7);
  });

  it("counts a single day as one week, on any of the seven", () => {
    expect(
      weeksInPeriod({ startDate: "2026-08-17", endDate: "2026-08-17" }, YEAR),
    ).toBe(1);
    // A Friday, mid-week.
    expect(
      weeksInPeriod({ startDate: "2026-09-04", endDate: "2026-09-04" }, YEAR),
    ).toBe(1);
    // A Sunday, the far edge of the same ISO week.
    expect(
      weeksInPeriod({ startDate: "2026-09-06", endDate: "2026-09-06" }, YEAR),
    ).toBe(1);
  });

  it("counts the week of a period that is one Saturday", () => {
    // 2026-09-05 is a Saturday in week 36. This asserted 0 while a week meant
    // Mon-Fri, on the reasoning that no teaching happens at a weekend. The app
    // does not agree: Lesson.dayOfWeek is 1-7, and runsOn — the rule that
    // decides what actually gets published — never looks at the weekday. A
    // Saturday course was being taught and charged for nothing.
    expect(
      weeksInPeriod({ startDate: "2026-09-05", endDate: "2026-09-05" }, YEAR),
    ).toBe(1);
  });

  it("counts one week, not two, for a Saturday-to-Sunday period", () => {
    // Both days sit in week 36; a period covering them is one week, and the
    // week must not be counted once per day.
    expect(
      weeksInPeriod({ startDate: "2026-09-05", endDate: "2026-09-06" }, YEAR),
    ).toBe(1);
  });

  it("keeps the week of a period that opens on a Sunday", () => {
    // The reported bug, pinned. 2027-01-10 is the Sunday of week 1, so weeks
    // 1..23 remain: 23. The Mon-Fri week ended on the 8th, dropped week 1 and
    // answered 22 — one week of teaching lost from every figure downstream.
    expect(weeksInPeriod({ startDate: "2027-01-10" }, YEAR)).toBe(23);
    // The Monday after it is one week fewer, which is the check that 23 is a
    // real count and not an off-by-one in the other direction.
    expect(weeksInPeriod({ startDate: "2027-01-11" }, YEAR)).toBe(22);
  });

  it("counts a partly covered edge week as a whole one", () => {
    // Documented overestimate: starting on Wednesday 2026-09-02 charges all of
    // week 36, so it matches starting on that week's Monday.
    const wednesday = weeksInPeriod({ startDate: "2026-09-02" }, YEAR);
    const monday = weeksInPeriod({ startDate: "2026-08-31" }, YEAR);
    expect(wednesday).toBe(monday);
    expect(wednesday).toBe(41);
  });

  it("keeps ODD weeks running across the 53-to-1 seam", () => {
    // 2026-12-28 opens week 53 and 2027-01-08 closes week 1 — both odd, and
    // adjacent. A fortnightly count from term start would find one, not two.
    expect(
      weeksInPeriod(
        { startDate: "2026-12-28", endDate: "2027-01-08", recurrence: "ODD_WEEKS" },
        YEAR,
      ),
    ).toBe(2);
  });

  it("finds no EVEN week in the same 53-to-1 seam", () => {
    expect(
      weeksInPeriod(
        { startDate: "2026-12-28", endDate: "2027-01-08", recurrence: "EVEN_WEEKS" },
        YEAR,
      ),
    ).toBe(0);
  });

  it("counts both parities across a window spanning new year", () => {
    // Weeks 52, 53, 1, 2 — odd: 53 and 1; even: 52 and 2.
    const window = { startDate: "2026-12-21", endDate: "2027-01-15" };
    expect(weeksInPeriod({ ...window, recurrence: "ODD_WEEKS" }, YEAR)).toBe(2);
    expect(weeksInPeriod({ ...window, recurrence: "EVEN_WEEKS" }, YEAR)).toBe(2);
    expect(weeksInPeriod(window, YEAR)).toBe(4);
  });

  it("reads parity off the ISO week number, not off the period's own start", () => {
    // One week each, back to back. Week 34 (2026-08-17) is even and week 35
    // (2026-08-24) is odd, so an ODD_WEEKS course confined to week 34 runs
    // never and the same course confined to week 35 runs once.
    //
    // Counting parity from the start of the period instead makes the first
    // week of every period "week 1", i.e. odd, and both ODD counts come back
    // as 1. Comparing two equal-length windows would NOT catch that — the two
    // readings pick different weeks but the same number of them — which is why
    // this asks about a single named week rather than about a span.
    const week34 = { startDate: "2026-08-17", endDate: "2026-08-21" };
    const week35 = { startDate: "2026-08-24", endDate: "2026-08-28" };

    expect(weeksInPeriod({ ...week34, recurrence: "ODD_WEEKS" }, YEAR)).toBe(0);
    expect(weeksInPeriod({ ...week34, recurrence: "EVEN_WEEKS" }, YEAR)).toBe(1);
    expect(weeksInPeriod({ ...week35, recurrence: "ODD_WEEKS" }, YEAR)).toBe(1);
    expect(weeksInPeriod({ ...week35, recurrence: "EVEN_WEEKS" }, YEAR)).toBe(0);
  });

  it("agrees with counting the days the API's runsOn is true for", () => {
    const recurrences: Recurrence[] = ["ALL_WEEKS", "ODD_WEEKS", "EVEN_WEEKS"];
    for (const recurrence of recurrences) {
      expect(weeksInPeriod({ recurrence }, YEAR)).toBe(
        weeksByCountingDays({ recurrence }, YEAR),
      );
    }
  });

  it("agrees with the day-by-day oracle over every window in a sampled sweep", () => {
    // Deterministic sweep rather than random dates: every 11th day of the year
    // paired with every window length from 1 to 40 days, across all three
    // recurrences. 3600 windows, hitting both year edges and the new-year seam
    // from every offset.
    //
    // `span` steps by 1, not by 7. Stepping by 7 from 1 made every window end
    // on its start weekday + 1, so of the 49 possible (start weekday, end
    // weekday) pairs the sweep visited 7 — the diagonal — and the whole family
    // of edge cases where a period opens or closes at a weekend was invisible
    // to it. That is precisely how a Mon-Fri week survived this sweep for as
    // long as it did. The offsets already cover all 7 start weekdays (11 mod 7
    // = 4, which is coprime to 7, so 0,11,22,... walks every residue); varying
    // the span mod 7 as well is what closes the grid.
    const recurrences: Recurrence[] = ["ALL_WEEKS", "ODD_WEEKS", "EVEN_WEEKS"];
    const pairsSeen = new Set<string>();
    let checked = 0;
    for (let offset = 0; offset < 330; offset += 11) {
      const start = new Date("2026-08-10T00:00:00");
      start.setDate(start.getDate() + offset);
      for (let span = 1; span <= 40; span += 1) {
        const end = new Date(start);
        end.setDate(end.getDate() + span);
        pairsSeen.add(`${start.getDay()}-${end.getDay()}`);
        for (const recurrence of recurrences) {
          const period = {
            recurrence,
            startDate: asDay(start),
            endDate: asDay(end),
          };
          expect(weeksInPeriod(period, YEAR)).toBe(weeksByCountingDays(period, YEAR));
          checked += 1;
        }
      }
    }
    expect(checked).toBe(3600);
    // The point of the span change, asserted rather than reasoned about: every
    // combination of opening and closing weekday really is exercised.
    expect(pairsSeen.size).toBe(49);
  });

  it("agrees with the day-by-day oracle over a few hundred pseudo-random periods", () => {
    // The sweep above is a grid, and grids have blind spots by construction —
    // its spans stop at 40 days and its starts are 11 apart, so it never asks
    // about a term-length window, a window that ends before it starts, or one
    // that misses the year on one side. This walks a fixed seed instead: same
    // 400 periods on every machine and every run (a failing case can be read
    // straight out of the diff), but their shapes are not chosen by a human who
    // already knows how the implementation works.
    //
    // The oracle is the whole point of the exercise: it iterates every day of
    // the läsår and counts distinct ISO weeks in which runsOn says yes,
    // borrowing nothing from teaching-hours.ts. Agreement here is the claim
    // that the week count and the published lessons cannot disagree.

    // mulberry32. Small, well-known, and its state is one uint32, so "the same
    // sequence everywhere" needs no trust in Math.random's implementation —
    // which V8 seeds per process and does not let a test pin.
    let state = 0x5c47_1a91;
    const random = () => {
      state = (state + 0x6d2b_79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    const between = (low: number, high: number) =>
      low + Math.floor(random() * (high - low + 1));

    const recurrences: Recurrence[] = ["ALL_WEEKS", "ODD_WEEKS", "EVEN_WEEKS"];
    // Anchored a month before the year and running a month past it, so roughly
    // a tenth of the draws fall wholly or partly outside — the clamp is under
    // test as much as the walk is.
    const anchor = new Date("2026-07-17T00:00:00");
    const dayFrom = (offset: number) => {
      const date = new Date(anchor);
      date.setDate(date.getDate() + offset);
      return asDay(date);
    };

    let disagreements = 0;
    let nonZero = 0;
    for (let draw = 0; draw < 400; draw += 1) {
      const startOffset = between(0, 360);
      // Deliberately allowed to go negative: a period the wrong way round is a
      // real thing a half-edited form produces, and both sides must say 0.
      const endOffset = startOffset + between(-20, 300);
      const period = {
        recurrence: recurrences[between(0, 2)] as Recurrence,
        startDate: dayFrom(startOffset),
        endDate: dayFrom(endOffset),
      };

      const actual = weeksInPeriod(period, YEAR);
      const expected = weeksByCountingDays(period, YEAR);
      if (actual !== expected) {
        disagreements += 1;
        // Reported through expect so the failure message names the period
        // rather than just a count.
        expect({ period, actual, expected }).toEqual({ period, actual: expected, expected });
      }
      if (actual > 0) nonZero += 1;
    }

    expect(disagreements).toBe(0);
    // Without this the test would pass on a weeksInPeriod that returned 0 for
    // everything, as long as the oracle agreed — and it would, if the oracle
    // were broken the same way. It is not, but the assertion costs a line.
    expect(nonZero).toBeGreaterThan(300);
  });

  it("returns 0 when the year itself has no days in it", () => {
    expect(weeksInPeriod({}, { startDate: "2027-06-11", endDate: "2026-08-17" })).toBe(
      0,
    );
  });

  it("counts a one-day year that falls on a school day", () => {
    expect(
      weeksInPeriod({}, { startDate: "2026-09-02", endDate: "2026-09-02" }),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Lov fixtures, dated against the same läsår and checked by hand against a
// calendar. Every one is written out as literal dates rather than derived from
// the year — a fixture computed with the module's own week arithmetic would
// agree with a broken implementation by construction.
//
//   STUDIEDAG  Fri 2026-09-18            week 38, EVEN
//   HOSTLOV    Mon 2026-10-26 - Fri 30   week 44, EVEN
//   JULLOV     Mon 2026-12-21 - Fri 2027-01-08
//                                        weeks 52 (even), 53 (odd), 1 (odd)
//   SPORTLOV   Mon 2027-03-01 - Fri 05   week 9,  ODD
//
// The parities matter: an alternating requirement must lose a lov week only
// when the lov lands in a week it was taught in, and 53-next-to-1 puts jullov
// across the seam this file exists to police.
//
// The year holds 43 weeks, so 215 Mon-Fri days. Every expected number below is
// (215 - closed days) / 5, and is written as the decimal rather than the
// division so a wrong answer has to be wrong about the days, not about the
// arithmetic.
// ---------------------------------------------------------------------------

const STUDIEDAG: ClosedRange = { startDate: "2026-09-18", endDate: "2026-09-18" };
const HOSTLOV: ClosedRange = { startDate: "2026-10-26", endDate: "2026-10-30" };
const JULLOV: ClosedRange = { startDate: "2026-12-21", endDate: "2027-01-08" };
const SPORTLOV: ClosedRange = { startDate: "2027-03-01", endDate: "2027-03-05" };

describe("teachingWeeks", () => {
  it("is weeksInPeriod exactly when no closures are given", () => {
    // The compatibility promise, and the reason every existing caller can stay
    // as it is. `toBe` rather than toBeCloseTo on purpose: a weighted walk that
    // summed 1/5 forty-three times would land a few ulps off 43 and pass a
    // near-enough assertion while writing 42.99999999999999 into a page.
    const recurrences: Recurrence[] = ["ALL_WEEKS", "ODD_WEEKS", "EVEN_WEEKS"];
    for (const recurrence of recurrences) {
      expect(teachingWeeks({ recurrence }, YEAR)).toBe(
        weeksInPeriod({ recurrence }, YEAR),
      );
    }
    expect(teachingWeeks({}, YEAR)).toBe(ALL_WEEKS_IN_YEAR);
  });

  it("is weeksInPeriod exactly for an empty list of closures", () => {
    // A school that has entered no lov yet is the common case in the first week
    // of use, and it must not read differently from a caller that passes none.
    expect(teachingWeeks({}, YEAR, [])).toBe(ALL_WEEKS_IN_YEAR);
    expect(teachingWeeks({ recurrence: "ODD_WEEKS" }, YEAR, [])).toBe(
      ODD_WEEKS_IN_YEAR,
    );
  });

  it("takes a fifth of a week off for a single studiedag", () => {
    expect(teachingWeeks({}, YEAR, [STUDIEDAG])).toBe(42.8);
  });

  it("takes a whole week off for a full lov week", () => {
    expect(teachingWeeks({}, YEAR, [HOSTLOV])).toBe(42);
  });

  it("ignores the weekend a lov is padded out with", () => {
    // Höstlov as a parent would write it — from the Saturday it starts feeling
    // like a lov to the Sunday before school resumes. The two weekend days are
    // not teaching days, so the week is worth exactly what the Mon-Fri lov
    // alone made it worth. A denominator of seven would answer 42.28… here.
    const padded: ClosedRange = { startDate: "2026-10-24", endDate: "2026-11-01" };
    expect(teachingWeeks({}, YEAR, [padded])).toBe(42);
    expect(teachingWeeks({}, YEAR, [padded])).toBe(teachingWeeks({}, YEAR, [HOSTLOV]));
  });

  it("deducts nothing for a closure that falls only at a weekend", () => {
    // 2026-10-31 is a Saturday and 2026-11-01 the Sunday after it, both inside
    // ISO week 44. Nothing is scheduled against them in a Mon-Fri timplan, so
    // the week is untouched.
    expect(
      teachingWeeks({}, YEAR, [{ startDate: "2026-10-31", endDate: "2026-11-01" }]),
    ).toBe(ALL_WEEKS_IN_YEAR);
  });

  it("counts a day covered by two overlapping lov only once", () => {
    // The shape a real register produces: a studiedag entered on its own, then
    // swallowed by a höstlov someone extended afterwards. Seven closed days are
    // named across the two ranges and only five of them exist.
    const overlapping: ClosedRange[] = [
      { startDate: "2026-10-26", endDate: "2026-10-28" },
      { startDate: "2026-10-27", endDate: "2026-10-30" },
    ];
    expect(teachingWeeks({}, YEAR, overlapping)).toBe(42);
  });

  it("cannot drive a week below zero however many lov pile onto it", () => {
    // Five copies of the same week, which a duplicated import produces. Summing
    // range lengths instead of asking each day once would answer 38.
    const duplicated = [HOSTLOV, HOSTLOV, HOSTLOV, HOSTLOV, HOSTLOV];
    expect(teachingWeeks({}, YEAR, duplicated)).toBe(42);
  });

  it("adds up two lov that share a week without sharing a day", () => {
    // Mon-Tue and Thu-Fri of week 44: four days closed, one taught.
    const split: ClosedRange[] = [
      { startDate: "2026-10-26", endDate: "2026-10-27" },
      { startDate: "2026-10-29", endDate: "2026-10-30" },
    ];
    expect(teachingWeeks({}, YEAR, split)).toBe(42.2);
  });

  it("ignores a lov that falls entirely outside the academic year", () => {
    const summer: ClosedRange[] = [
      { startDate: "2026-07-01", endDate: "2026-07-31" },
      { startDate: "2027-07-01", endDate: "2027-08-31" },
    ];
    expect(teachingWeeks({}, YEAR, summer)).toBe(ALL_WEEKS_IN_YEAR);
  });

  it("counts only the days a lov shares with the year when it straddles the start", () => {
    // 2026-08-10 to 2026-08-18: the first week of it is week 33, which the year
    // does not contain, and the year's opening week 34 loses its Monday and
    // Tuesday. Two days, not nine, and not five.
    expect(
      teachingWeeks({}, YEAR, [{ startDate: "2026-08-10", endDate: "2026-08-18" }]),
    ).toBe(42.6);
  });

  it("counts only the days a lov shares with the year when it straddles the end", () => {
    // The year closes on Friday 2027-06-11, mid-June. A lov running into the
    // week after takes week 23's five days and nothing more.
    expect(
      teachingWeeks({}, YEAR, [{ startDate: "2027-06-07", endDate: "2027-06-20" }]),
    ).toBe(42);
  });

  it("ignores a lov that falls outside the requirement's own period", () => {
    // An autumn-term course: 18 weeks (pinned by the weeksInPeriod tests
    // above). Höstlov is inside it and costs a week; jullov starts three days
    // after the course ends and costs nothing.
    const autumn = { startDate: "2026-08-17", endDate: "2026-12-18" };
    expect(teachingWeeks(autumn, YEAR, [JULLOV])).toBe(18);
    expect(teachingWeeks(autumn, YEAR, [HOSTLOV])).toBe(17);
    expect(teachingWeeks(autumn, YEAR, [HOSTLOV, JULLOV])).toBe(17);
  });

  it("takes three weeks off for a jullov that runs across the new year", () => {
    // Weeks 52, 53 and 1 — the seam. A lov measured in whole weeks from its
    // own start would find two.
    expect(teachingWeeks({}, YEAR, [JULLOV])).toBe(40);
  });

  it("charges an ODD_WEEKS requirement for jullov's two odd weeks only", () => {
    // Weeks 53 and 1 are both odd and adjacent; week 52 is even and is not this
    // requirement's to lose.
    expect(teachingWeeks({ recurrence: "ODD_WEEKS" }, YEAR, [JULLOV])).toBe(
      ODD_WEEKS_IN_YEAR - 2,
    );
    expect(teachingWeeks({ recurrence: "EVEN_WEEKS" }, YEAR, [JULLOV])).toBe(
      EVEN_WEEKS_IN_YEAR - 1,
    );
  });

  it("leaves an alternating requirement alone when the lov misses its weeks", () => {
    // Höstlov is week 44, even. The odd-week course was never taught that week,
    // so it loses nothing — the aggregate deduction must follow the parity, not
    // be spread across the year.
    expect(teachingWeeks({ recurrence: "ODD_WEEKS" }, YEAR, [HOSTLOV])).toBe(
      ODD_WEEKS_IN_YEAR,
    );
    expect(teachingWeeks({ recurrence: "EVEN_WEEKS" }, YEAR, [HOSTLOV])).toBe(
      EVEN_WEEKS_IN_YEAR - 1,
    );
    // Sportlov is week 9, odd — the same test with the parities swapped, so a
    // fix that hardcodes one of them fails here.
    expect(teachingWeeks({ recurrence: "ODD_WEEKS" }, YEAR, [SPORTLOV])).toBe(
      ODD_WEEKS_IN_YEAR - 1,
    );
    expect(teachingWeeks({ recurrence: "EVEN_WEEKS" }, YEAR, [SPORTLOV])).toBe(
      EVEN_WEEKS_IN_YEAR,
    );
  });

  it("applies a lov with a grade span to a grade inside it", () => {
    const hogstadiet: ClosedRange = { ...HOSTLOV, minGradeLevel: 7, maxGradeLevel: 9 };
    expect(teachingWeeks({}, YEAR, [hogstadiet], 8)).toBe(42);
  });

  it("does not apply a grade span to a grade outside it", () => {
    const hogstadiet: ClosedRange = { ...HOSTLOV, minGradeLevel: 7, maxGradeLevel: 9 };
    expect(teachingWeeks({}, YEAR, [hogstadiet], 3)).toBe(ALL_WEEKS_IN_YEAR);
  });

  it("treats both ends of a grade span as inclusive", () => {
    const span: ClosedRange = { ...HOSTLOV, minGradeLevel: 7, maxGradeLevel: 9 };
    expect(teachingWeeks({}, YEAR, [span], 7)).toBe(42);
    expect(teachingWeeks({}, YEAR, [span], 9)).toBe(42);
    expect(teachingWeeks({}, YEAR, [span], 6)).toBe(ALL_WEEKS_IN_YEAR);
    expect(teachingWeeks({}, YEAR, [span], 10)).toBe(ALL_WEEKS_IN_YEAR);
  });

  it("applies a span covering årskurs 0 to förskoleklass", () => {
    // 0 is a real grade and a falsy number, so it is where a lazy guard shows.
    const fritids: ClosedRange = { ...HOSTLOV, minGradeLevel: 0, maxGradeLevel: 3 };
    expect(teachingWeeks({}, YEAR, [fritids], 0)).toBe(42);
    expect(teachingWeeks({}, YEAR, [fritids], 4)).toBe(ALL_WEEKS_IN_YEAR);

    // The 0-to-0 span is the case that actually catches it, and the two lines
    // above do not: a `!min && !max` school-wide test reads årskurs 0-0 as "no
    // span at all" and closes the week for the whole school. Written after a
    // mutant with exactly that guard survived every other assertion here.
    const forskoleklass: ClosedRange = { ...HOSTLOV, minGradeLevel: 0, maxGradeLevel: 0 };
    expect(teachingWeeks({}, YEAR, [forskoleklass], 0)).toBe(42);
    expect(teachingWeeks({}, YEAR, [forskoleklass], 5)).toBe(ALL_WEEKS_IN_YEAR);
    expect(teachingWeeks({}, YEAR, [forskoleklass], null)).toBe(ALL_WEEKS_IN_YEAR);
  });

  it("leaves a grade-spanned lov out when the caller names no grade", () => {
    // Null and omitted both mean "no particular grade", which is a school-wide
    // question — and a lågstadiet studiedag is not a school-wide fact. Counting
    // it would understate teaching for the grades it never touched.
    const lagstadiet: ClosedRange = { ...HOSTLOV, minGradeLevel: 1, maxGradeLevel: 3 };
    expect(teachingWeeks({}, YEAR, [lagstadiet], null)).toBe(ALL_WEEKS_IN_YEAR);
    expect(teachingWeeks({}, YEAR, [lagstadiet])).toBe(ALL_WEEKS_IN_YEAR);
  });

  it("applies a lov with no grade span whatever grade is asked about", () => {
    // The other half of the rule above: school-wide closures are true for every
    // grade, including the caller that cannot name one.
    expect(teachingWeeks({}, YEAR, [HOSTLOV], null)).toBe(42);
    expect(teachingWeeks({}, YEAR, [HOSTLOV], undefined)).toBe(42);
    expect(teachingWeeks({}, YEAR, [HOSTLOV], 5)).toBe(42);
    // Explicit nulls, which is what a row straight out of SchoolBreaks carries.
    const fromDb: ClosedRange = { ...HOSTLOV, minGradeLevel: null, maxGradeLevel: null };
    expect(teachingWeeks({}, YEAR, [fromDb], 5)).toBe(42);
  });

  it("reads a half-filled grade span as open-ended on the missing side", () => {
    // The database cannot produce one — the check constraint on SchoolBreaks
    // makes the pair all-or-nothing — but the interface can, and dropping the
    // range silently is worse than honouring the bound that is there.
    const fromSeven: ClosedRange = { ...HOSTLOV, minGradeLevel: 7, maxGradeLevel: null };
    expect(teachingWeeks({}, YEAR, [fromSeven], 9)).toBe(42);
    expect(teachingWeeks({}, YEAR, [fromSeven], 3)).toBe(ALL_WEEKS_IN_YEAR);

    const uptoThree: ClosedRange = { ...HOSTLOV, minGradeLevel: null, maxGradeLevel: 3 };
    expect(teachingWeeks({}, YEAR, [uptoThree], 2)).toBe(42);
    expect(teachingWeeks({}, YEAR, [uptoThree], 8)).toBe(ALL_WEEKS_IN_YEAR);
  });

  it("mixes a school-wide lov with a grade-spanned one for the same grade", () => {
    // Year 8 loses höstlov because everyone does, and keeps the lågstadiet
    // studiedag. Reading only the first entry, or filtering the list away
    // wholesale, gets a different number for each of these.
    const lagstadiet: ClosedRange = { ...STUDIEDAG, minGradeLevel: 1, maxGradeLevel: 3 };
    expect(teachingWeeks({}, YEAR, [HOSTLOV, lagstadiet], 8)).toBe(42);
    expect(teachingWeeks({}, YEAR, [HOSTLOV, lagstadiet], 2)).toBe(41.8);
  });

  it("sums whole days and divides once, rather than adding fifths as it goes", () => {
    // Three consecutive weeks, one studiedag in each: 12 taught days out of 15,
    // which is 2.4 weeks. Adding 0.8 three times gives 2.4000000000000004 —
    // binary floating point, not a counting mistake — and that value reaches a
    // page as "2.4000000000000004 veckor" the moment anything renders it
    // unformatted. Dividing 12 by 5 once lands on the double a human writes.
    //
    // The smallest pattern where the two spellings disagree at all, found by
    // enumeration; the fixtures elsewhere in this file happen to agree under
    // both, so without this test the arithmetic in teachingWeeks is unpinned.
    const threeWeeks = { startDate: "2026-09-14", endDate: "2026-10-02" };
    const studiedagar: ClosedRange[] = [
      { startDate: "2026-09-18", endDate: "2026-09-18" }, // Fri, week 38
      { startDate: "2026-09-22", endDate: "2026-09-22" }, // Tue, week 39
      { startDate: "2026-10-01", endDate: "2026-10-01" }, // Thu, week 40
    ];
    expect(weeksInPeriod(threeWeeks, YEAR)).toBe(3);
    expect(teachingWeeks(threeWeeks, YEAR, studiedagar)).toBe(2.4);
  });

  it("ignores a lov whose dates are the wrong way round", () => {
    // The same reading clampToYear gives an inverted period: it covers nothing.
    // The DB check makes it unreachable from a row, an import preview can hold
    // one.
    expect(
      teachingWeeks({}, YEAR, [{ startDate: "2026-11-30", endDate: "2026-11-02" }]),
    ).toBe(ALL_WEEKS_IN_YEAR);
  });

  /*
   * A lov only subtracts days the period actually contains.
   *
   * The week is generous and the lov is exact, and the two are different
   * decisions — see the file header. An edge week the period joins on the
   * Wednesday still counts as a whole week, but a lov on that week's Monday is
   * outside the period and must weigh nothing. Without the window test it
   * weighed 3/5, which points DOWN in a function whose contract is that it errs
   * upward, and a lov sitting entirely before a spring term subtracted from it.
   *
   * 2027-01-11 is a Monday, so the week Mon 11 - Fri 15 is the one to aim at.
   */
  it("ignores a lov on days the period has not started on yet", () => {
    const springFromWednesday = { startDate: "2027-01-13", endDate: "2027-06-11" };
    const lovOnTheMonday: ClosedRange[] = [
      { startDate: "2027-01-11", endDate: "2027-01-12" },
    ];

    expect(teachingWeeks(springFromWednesday, YEAR, lovOnTheMonday)).toBe(
      weeksInPeriod(springFromWednesday, YEAR),
    );
  });

  it("ignores a lov that falls entirely before the period", () => {
    const spring = { startDate: "2027-01-13", endDate: "2027-06-11" };
    const jullov: ClosedRange[] = [
      { startDate: "2026-12-21", endDate: "2027-01-08" },
    ];

    expect(teachingWeeks(spring, YEAR, jullov)).toBe(weeksInPeriod(spring, YEAR));
  });

  it("ignores a lov that falls entirely after the period", () => {
    const autumn = { startDate: "2026-08-17", endDate: "2026-12-18" };
    const sportlov: ClosedRange[] = [
      { startDate: "2027-02-22", endDate: "2027-02-26" },
    ];

    expect(teachingWeeks(autumn, YEAR, sportlov)).toBe(weeksInPeriod(autumn, YEAR));
  });

  it("still subtracts the part of a lov the period does contain", () => {
    // The other direction, so the three above cannot be satisfied by a
    // weighting that ignores closures altogether. The lov straddles the start:
    // Mon-Tue are outside the period, Wed-Thu are inside, so two of the week's
    // five days go.
    const springFromWednesday = { startDate: "2027-01-13", endDate: "2027-06-11" };
    const straddling: ClosedRange[] = [
      { startDate: "2027-01-11", endDate: "2027-01-14" },
    ];

    const whole = weeksInPeriod(springFromWednesday, YEAR);
    expect(teachingWeeks(springFromWednesday, YEAR, straddling)).toBeCloseTo(
      whole - 2 / 5,
      10,
    );
  });

  it("is 0 for a period outside the year, closures or not", () => {
    const outside = { startDate: "2028-01-01", endDate: "2028-06-30" };
    expect(teachingWeeks(outside, YEAR, [HOSTLOV, JULLOV])).toBe(0);
    expect(teachingWeeks({}, { startDate: "2027-06-11", endDate: "2026-08-17" }, [
      HOSTLOV,
    ])).toBe(0);
  });

  it("takes a whole Swedish läsår's lov off the top", () => {
    // All four fixtures at once, which is roughly what a real register holds:
    // 1 + 5 + 15 + 5 = 26 closed days, so 189/5.
    expect(teachingWeeks({}, YEAR, [STUDIEDAG, HOSTLOV, JULLOV, SPORTLOV])).toBe(37.8);
  });

  it("never exceeds weeksInPeriod, over a sweep of periods and lov", () => {
    // The property the whole design rests on: closures only ever remove
    // teaching. If this can be broken, some figure in the app reports more
    // hours because a school entered a lov.
    //
    // Same mulberry32 as the sweep above — fixed seed, so a failure is
    // reproducible from the diff alone.
    let state = 0x1f3a_77c5;
    const random = () => {
      state = (state + 0x6d2b_79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    const between = (low: number, high: number) =>
      low + Math.floor(random() * (high - low + 1));

    const anchor = new Date("2026-07-17T00:00:00");
    const dayFrom = (offset: number) => {
      const date = new Date(anchor);
      date.setDate(date.getDate() + offset);
      return asDay(date);
    };
    const recurrences: Recurrence[] = ["ALL_WEEKS", "ODD_WEEKS", "EVEN_WEEKS"];

    let strictlyFewer = 0;
    let equal = 0;
    for (let draw = 0; draw < 400; draw += 1) {
      const startOffset = between(0, 360);
      const period = {
        recurrence: recurrences[between(0, 2)] as Recurrence,
        startDate: dayFrom(startOffset),
        endDate: dayFrom(startOffset + between(-20, 300)),
      };

      // Between none and four lov, each 1-16 days, anywhere in or around the
      // year — overlaps, weekend-only ranges and out-of-year ranges all arise
      // on their own at these numbers.
      const closures: ClosedRange[] = [];
      for (let i = between(0, 4); i > 0; i -= 1) {
        const from = between(0, 360);
        const spanned = between(0, 15);
        const grade = between(0, 3); // 3 of 4 draws are school-wide
        closures.push({
          startDate: dayFrom(from),
          endDate: dayFrom(from + spanned),
          minGradeLevel: grade === 0 ? between(0, 6) : null,
          maxGradeLevel: grade === 0 ? between(6, 12) : null,
        });
      }

      const gradeLevel = between(0, 12);
      const weighted = teachingWeeks(period, YEAR, closures, gradeLevel);
      const calendar = weeksInPeriod(period, YEAR);

      if (weighted > calendar || weighted < 0) {
        // Through expect so the failure names the period and the lov rather
        // than just the two numbers.
        expect({ period, closures, gradeLevel, weighted, calendar }).toEqual({
          period,
          closures,
          gradeLevel,
          weighted: calendar,
          calendar,
        });
      }
      if (weighted < calendar) strictlyFewer += 1;
      else equal += 1;
    }

    // Without these the property would hold trivially on a teachingWeeks that
    // returned 0 for everything, or on one that ignored closures entirely.
    expect(strictlyFewer).toBeGreaterThan(100);
    expect(equal).toBeGreaterThan(20);
  });
});

describe("annualMinutes", () => {
  it("multiplies weeks by lessons by minutes", () => {
    // 43 weeks x 2 lessons x 45 min.
    expect(annualMinutes(req({ lessonsPerWeek: 2, minutesPerLesson: 45 }), YEAR)).toBe(
      ALL_WEEKS_IN_YEAR * 2 * 45,
    );
  });

  it("charges an alternating requirement for its own weeks only", () => {
    const odd = annualMinutes(
      req({ lessonsPerWeek: 2, minutesPerLesson: 60, recurrence: "ODD_WEEKS" }),
      YEAR,
    );
    expect(odd).toBe(ODD_WEEKS_IN_YEAR * 2 * 60);
    expect(odd).toBeLessThan(
      annualMinutes(req({ lessonsPerWeek: 2, minutesPerLesson: 60 }), YEAR),
    );
  });

  it("charges a term-limited requirement for the term", () => {
    expect(
      annualMinutes(
        req({
          lessonsPerWeek: 3,
          minutesPerLesson: 40,
          startDate: "2026-08-17",
          endDate: "2026-12-18",
        }),
        YEAR,
      ),
    ).toBe(18 * 3 * 40);
  });

  it("is 0 for a requirement whose period falls outside the year", () => {
    expect(
      annualMinutes(
        req({ lessonsPerWeek: 5, startDate: "2025-01-01", endDate: "2025-06-30" }),
        YEAR,
      ),
    ).toBe(0);
  });

  it("is 0 when either factor is zero", () => {
    expect(annualMinutes(req({ lessonsPerWeek: 0 }), YEAR)).toBe(0);
    expect(annualMinutes(req({ minutesPerLesson: 0 }), YEAR)).toBe(0);
  });

  it("reads a half-filled form as 0 rather than letting NaN reach the page", () => {
    expect(annualMinutes(req({ lessonsPerWeek: Number.NaN }), YEAR)).toBe(0);
    expect(annualMinutes(req({ minutesPerLesson: Number.NaN }), YEAR)).toBe(0);
    expect(annualMinutes(req({ lessonsPerWeek: -3 }), YEAR)).toBe(0);
  });

  it("is unchanged to the minute when no closures are passed", () => {
    // The four assertions above this describe already pin the old numbers; this
    // one says so about the new argument being absent, which is what every
    // caller written before the lov model does.
    const load = req({ lessonsPerWeek: 2, minutesPerLesson: 45 });
    expect(annualMinutes(load, YEAR)).toBe(ALL_WEEKS_IN_YEAR * 2 * 45);
    expect(annualMinutes(load, YEAR, [])).toBe(ALL_WEEKS_IN_YEAR * 2 * 45);
  });

  it("stops charging for the weeks a lov takes away", () => {
    // 42 weeks after höstlov, not 43.
    expect(
      annualMinutes(req({ lessonsPerWeek: 2, minutesPerLesson: 45 }), YEAR, [HOSTLOV]),
    ).toBe(42 * 2 * 45);
    // And a fifth of a week for a studiedag: 42.8 x 2 x 45 = 3852.
    //
    // toBeCloseTo, and only here. teachingWeeks itself returns 42.8 exactly —
    // it divides once, at the end, so the value is the nearest double to 42.8
    // and `toBe(42.8)` above holds. Multiplying that double by 2 and by 45
    // lands on 3851.9999999999995, because 42.8 has no exact binary form for
    // the products to be exact about. Rounding inside annualMinutes was the
    // alternative and was rejected: minutes are genuinely fractional once weeks
    // are, and a round there would be this module inventing precision to make a
    // test pretty. What a user sees is the formatted figure, asserted below.
    expect(
      annualMinutes(req({ lessonsPerWeek: 2, minutesPerLesson: 45 }), YEAR, [STUDIEDAG]),
    ).toBeCloseTo(3852, 9);
  });

  it("charges different grades differently for a lov that is not school-wide", () => {
    const lagstadiet: ClosedRange = { ...HOSTLOV, minGradeLevel: 1, maxGradeLevel: 3 };
    const load = req({ lessonsPerWeek: 3, minutesPerLesson: 60 });
    expect(annualMinutes(load, YEAR, [lagstadiet], 2)).toBe(42 * 3 * 60);
    expect(annualMinutes(load, YEAR, [lagstadiet], 8)).toBe(ALL_WEEKS_IN_YEAR * 3 * 60);
  });

  it("still reads a half-filled form as 0 with lov in play", () => {
    expect(
      annualMinutes(req({ lessonsPerWeek: Number.NaN }), YEAR, [HOSTLOV]),
    ).toBe(0);
    expect(
      annualMinutes(req({ minutesPerLesson: Number.NaN }), YEAR, [JULLOV], 5),
    ).toBe(0);
  });

  it("prints a lov-adjusted year as hours a rektor can read", () => {
    // The end-to-end shape: 42.8 weeks of two 45-minute lessons is 64,2 h, down
    // from the 64,5 h the same requirement reads without the studiedag.
    const load = req({ lessonsPerWeek: 2, minutesPerLesson: 45 });
    expect(formatHours(annualMinutes(load, YEAR, [STUDIEDAG]))).toBe("64,2 h");
    expect(formatHours(annualMinutes(load, YEAR))).toBe("64,5 h");
  });
});

describe("peakLessonsPerWeek", () => {
  it("is 0 with no requirements", () => {
    expect(peakLessonsPerWeek([], YEAR)).toBe(0);
  });

  it("adds up requirements that share a week", () => {
    expect(
      peakLessonsPerWeek([req({ lessonsPerWeek: 3 }), req({ lessonsPerWeek: 2 })], YEAR),
    ).toBe(5);
  });

  it("never adds opposite parities together", () => {
    expect(
      peakLessonsPerWeek(
        [
          req({ lessonsPerWeek: 3, recurrence: "ODD_WEEKS" }),
          req({ lessonsPerWeek: 2, recurrence: "EVEN_WEEKS" }),
        ],
        YEAR,
      ),
    ).toBe(3);
  });

  it("does add the same parity together", () => {
    expect(
      peakLessonsPerWeek(
        [
          req({ lessonsPerWeek: 3, recurrence: "ODD_WEEKS" }),
          req({ lessonsPerWeek: 2, recurrence: "ODD_WEEKS" }),
        ],
        YEAR,
      ),
    ).toBe(5);
  });

  it("never adds terms that do not overlap", () => {
    expect(
      peakLessonsPerWeek(
        [
          req({ lessonsPerWeek: 4, startDate: "2026-08-17", endDate: "2026-12-18" }),
          req({ lessonsPerWeek: 6, startDate: "2027-01-11", endDate: "2027-06-11" }),
        ],
        YEAR,
      ),
    ).toBe(6);
  });

  it("finds a peak in a middle week that neither requirement's own dates announce", () => {
    // One course ends in late November, the other opens in early November.
    // Their overlap is four weeks in the middle of the autumn term — the sum
    // appears nowhere in either requirement's start or end date.
    expect(
      peakLessonsPerWeek(
        [
          req({ lessonsPerWeek: 3, startDate: "2026-08-17", endDate: "2026-11-27" }),
          req({ lessonsPerWeek: 2, startDate: "2026-11-02", endDate: "2027-06-11" }),
        ],
        YEAR,
      ),
    ).toBe(5);
  });

  it("counts the seam week where two odd requirements meet twice running", () => {
    // Both live only across the new year, both ODD. Weeks 53 and 1 are the
    // only weeks either runs in, and they run in both.
    expect(
      peakLessonsPerWeek(
        [
          req({
            lessonsPerWeek: 2,
            recurrence: "ODD_WEEKS",
            startDate: "2026-12-28",
            endDate: "2027-01-08",
          }),
          req({
            lessonsPerWeek: 1,
            recurrence: "ODD_WEEKS",
            startDate: "2026-12-28",
            endDate: "2027-01-08",
          }),
        ],
        YEAR,
      ),
    ).toBe(3);
  });

  it("ignores a requirement whose period misses the year entirely", () => {
    expect(
      peakLessonsPerWeek(
        [
          req({ lessonsPerWeek: 2 }),
          req({ lessonsPerWeek: 99, startDate: "2028-01-01", endDate: "2028-06-30" }),
        ],
        YEAR,
      ),
    ).toBe(2);
  });

  it("ignores a half-filled requirement instead of returning NaN", () => {
    expect(
      peakLessonsPerWeek(
        [req({ lessonsPerWeek: 2 }), req({ lessonsPerWeek: Number.NaN })],
        YEAR,
      ),
    ).toBe(2);
  });
});

describe("peakLessonsPerWeekByKey", () => {
  // A requirement as the page has it: the load fields the library needs plus
  // the grouping column it does not know about.
  const grouped = (group: string, overrides: Partial<RequirementLoad> = {}) => ({
    studentGroupId: group,
    ...req(overrides),
  });
  const byGroup = (
    reqs: ReturnType<typeof grouped>[],
    year: YearBounds = YEAR,
  ) => peakLessonsPerWeekByKey(reqs, year, (entry) => entry.studentGroupId);

  it("is an empty map with no requirements", () => {
    expect(byGroup([]).size).toBe(0);
  });

  it("keeps groups apart instead of summing the school", () => {
    const peaks = byGroup([
      grouped("7a", { lessonsPerWeek: 3 }),
      grouped("7a", { lessonsPerWeek: 2 }),
      grouped("7b", { lessonsPerWeek: 4 }),
    ]);
    expect(peaks.get("7a")).toBe(5);
    expect(peaks.get("7b")).toBe(4);
    // The school-wide figure is a different question with a different answer,
    // which is the whole reason this export exists.
    expect(
      peakLessonsPerWeek(
        [
          req({ lessonsPerWeek: 3 }),
          req({ lessonsPerWeek: 2 }),
          req({ lessonsPerWeek: 4 }),
        ],
        YEAR,
      ),
    ).toBe(9);
  });

  it("gives each group its own busiest week", () => {
    // 7a is heaviest in the autumn, 7b in the spring. Neither peak is in the
    // week the other peaks in, so the parts sum to more than the whole — the
    // documented behaviour, pinned so nobody 'fixes' it into a total.
    const peaks = byGroup([
      grouped("7a", { lessonsPerWeek: 5, startDate: "2026-08-17", endDate: "2026-12-18" }),
      grouped("7b", { lessonsPerWeek: 4, startDate: "2027-01-11", endDate: "2027-06-11" }),
    ]);
    expect(peaks.get("7a")).toBe(5);
    expect(peaks.get("7b")).toBe(4);
    expect((peaks.get("7a") ?? 0) + (peaks.get("7b") ?? 0)).toBe(9);
    expect(
      peakLessonsPerWeek(
        [
          req({ lessonsPerWeek: 5, startDate: "2026-08-17", endDate: "2026-12-18" }),
          req({ lessonsPerWeek: 4, startDate: "2027-01-11", endDate: "2027-06-11" }),
        ],
        YEAR,
      ),
    ).toBe(5);
  });

  it("never adds opposite parities inside a group", () => {
    const peaks = byGroup([
      grouped("7a", { lessonsPerWeek: 3, recurrence: "ODD_WEEKS" }),
      grouped("7a", { lessonsPerWeek: 2, recurrence: "EVEN_WEEKS" }),
    ]);
    expect(peaks.get("7a")).toBe(3);
  });

  it("reports 0 for a group whose requirements all miss the year", () => {
    // A row, not a hole: the page renders per group, and an absent key would
    // read as "no data" where the truth is "no teaching this year".
    const peaks = byGroup([
      grouped("7a", { lessonsPerWeek: 2 }),
      grouped("7b", { lessonsPerWeek: 9, startDate: "2028-01-01", endDate: "2028-06-30" }),
    ]);
    expect(peaks.get("7a")).toBe(2);
    expect(peaks.has("7b")).toBe(true);
    expect(peaks.get("7b")).toBe(0);
  });

  it("ignores a half-filled requirement instead of returning NaN", () => {
    const peaks = byGroup([
      grouped("7a", { lessonsPerWeek: 2 }),
      grouped("7a", { lessonsPerWeek: Number.NaN }),
    ]);
    expect(peaks.get("7a")).toBe(2);
  });

  it("matches the school-wide peak when everything is one group", () => {
    const reqs = [
      req({ lessonsPerWeek: 3, recurrence: "ODD_WEEKS" }),
      req({ lessonsPerWeek: 2, startDate: "2026-11-02", endDate: "2027-06-11" }),
      req({ lessonsPerWeek: 4, endDate: "2026-11-27" }),
    ];
    const peaks = peakLessonsPerWeekByKey(reqs, YEAR, () => "hela skolan");
    expect(peaks.get("hela skolan")).toBe(peakLessonsPerWeek(reqs, YEAR));
  });

  it("is 0 for every key when the year has no weeks in it", () => {
    const peaks = byGroup([grouped("7a", { lessonsPerWeek: 3 })], {
      startDate: "2027-06-11",
      endDate: "2026-08-17",
    });
    expect(peaks.get("7a")).toBe(0);
  });
});

describe("formatHours", () => {
  it("drops the decimal on a whole number of hours", () => {
    expect(formatHours(3480)).toBe("58 h");
    expect(formatHours(60)).toBe("1 h");
    expect(formatHours(0)).toBe("0 h");
  });

  it("writes a half hour with a decimal comma", () => {
    expect(formatHours(3510)).toBe("58,5 h");
    expect(formatHours(30)).toBe("0,5 h");
  });

  it("rounds to at most one decimal", () => {
    // 100 minutes is 1.666… h.
    expect(formatHours(100)).toBe("1,7 h");
    // 45 minutes is 0.75 h.
    expect(formatHours(45)).toBe("0,8 h");
  });

  it("rounds a near-whole figure back to a whole number", () => {
    // 2 minutes over an hour is 1.0333… h, which is 1 h at this precision.
    expect(formatHours(62)).toBe("1 h");
  });

  it("emits no thousands separator, so the value stays one token", () => {
    const formatted = formatHours(72000); // 1200 h
    expect(formatted).toBe("1200 h");
    expect(formatted).not.toMatch(/\s\d/);
  });

  it("prints 0 h rather than NaN h for a non-finite input", () => {
    expect(formatHours(Number.NaN)).toBe("0 h");
    expect(formatHours(Number.POSITIVE_INFINITY)).toBe("0 h");
  });

  it("formats a whole year's worth of a requirement", () => {
    // 43 weeks x 2 x 45 min = 3870 min = 64.5 h.
    expect(
      formatHours(annualMinutes(req({ lessonsPerWeek: 2, minutesPerLesson: 45 }), YEAR)),
    ).toBe("64,5 h");
  });
});
