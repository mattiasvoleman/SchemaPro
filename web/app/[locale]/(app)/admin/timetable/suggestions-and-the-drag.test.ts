import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { toPlacement } from "@/lib/conflicts";
import { cases, constraintsOf, framesOf, groupsOf, lessonsOf, membershipsOf, peopleOf, sittingsOf, worlds, type World } from "@/lib/lesson-judge-world";
import { minutesOfClock } from "@/lib/requirement-placement-text";
import { suggestPlacements } from "@/lib/placement-search";
import { letsStartAt, type PossibleTimes } from "@/lib/possible-times";
import type { MasterLesson } from "@/lib/types";
import { useScheduleEngine } from "./use-schedule-engine";

/**
 * WHAT THE PAGE OFFERS AFTER A REFUSED DROP IS WHAT THE DRAG LETS THROUGH (post mr-3).
 *
 * The suggestion dialog searches the week for the nearest free time, and the page asks the search with the drag control's own predicate
 * (`validateChange` of use-schedule-engine.ts, handleInvalidDrop in page.tsx). Before it did, the search was given the clash rule and the
 * weekly rows and none of the board's: a time a class eats in, a time outside its stage's ramtid or closed to its year was "free", and the
 * time that was offered was refused when it was picked.
 *
 * This asks the real engine of every world of the judge's fallfil (src/calendar/__fixtures__/lesson-judge-cases.json), for every lesson of
 * it, to refuse a drop (seeded random places) and to say what it would offer instead; every time offered must pass `validateChange`. The
 * control is the call the page used to make: it offers refused times in these very worlds, so the property is not met by a world with
 * nothing to refuse.
 *
 * What the drag lets through is not all the judge refuses: the page holds no room lent to another school (OTHER_SCHOOL), so the dialog
 * offered an hour the lesson's own room is lent out (granskaren g503 #503 L-3). The page asks the gateway as well, and offers only the
 * starts it calls free (lib/possible-times.ts, startsTheGatewayLets): below, with an answer a judge that read the loans would give.
 */

function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const year = { id: "y1", startDate: "2026-08-17", endDate: "2027-06-11", gradeNumbering: "NIOARIG" };

function engineOf(world: World) {
  return renderHook(() =>
    useScheduleEngine({
      groups: groupsOf(world) as never,
      shownYear: year as never,
      schoolBreaks: [] as never,
      people: peopleOf(world) as never,
      memberships: membershipsOf(world) as never,
      lunchSettings: undefined,
      rooms: [] as never,
      subjects: [] as never,
      lessons: lessonsOf(world) as never,
      lunchSittings: sittingsOf(world) as never,
      requirements: undefined,
      roomRules: undefined,
      constraints: constraintsOf(world) as never,
      frameTimes: framesOf(world) as never,
      peers: [],
      editing: null,
    }),
  ).result.current;
}

const DAYS = [1, 2, 3, 4, 5];
const DROPS_PER_LESSON = 8;

/** Whether the lesson, started at `start` on `day`, has an hour its room is lent out to another school in it. */
function inALentHour(world: World, lesson: MasterLesson, day: number, start: number, length: number): boolean {
  return (world.loans ?? []).some(
    (loan) => loan.room === lesson.roomId && loan.day === day && start < minutesOfClock(loan.end) && minutesOfClock(loan.start) < start + length,
  );
}

/**
 * The gateway's answer for a lesson in a world where rooms are lent, as its judge gives it: every start that has an hour the lesson's room
 * is lent in is shut (OTHER_SCHOOL), every other is free. Only the part the dialog reads; the rest is the gateway's own business, held to
 * the judge by the possible-times probe (scripts/test/probe-mojliga-tider.ts) over these same worlds.
 */
function gatewayOf(world: World, lesson: MasterLesson, length: number): PossibleTimes {
  const runs = DAYS.flatMap((day) => {
    const shut = (world.loans ?? []).filter((loan) => loan.room === lesson.roomId && loan.day === day);
    const edges = shut.flatMap((loan) => [[minutesOfClock(loan.start) - length + 5, minutesOfClock(loan.end) - 5] as const]).sort((a, b) => a[0] - b[0]);
    const out: PossibleTimes["days"][number]["runs"] = [];
    let from = 420;
    for (const [first, last] of edges) {
      if (first > from) out.push({ dayOfWeek: day, fromMinutes: from, toMinutes: first - 5, kind: "FREE" });
      out.push({ dayOfWeek: day, fromMinutes: first, toMinutes: last, kind: "CLOSED", code: "OTHER_SCHOOL", params: { schools: "Andra skolan" } });
      from = last + 5;
    }
    if (from <= 1080) out.push({ dayOfWeek: day, fromMinutes: from, toMinutes: 1080, kind: "FREE" });
    return [{ dayOfWeek: day, runs: out }];
  });
  return {
    academicYearId: "y1",
    subject: { lessonId: lesson.id, className: "", subjectName: "", minutes: length, lessonIds: [lesson.id], isLocked: false, unplaced: false, current: null },
    stepMinutes: 5,
    options: [],
    days: runs,
    blockers: {},
  };
}

function survey(offer: "page" | "before" | "gateway") {
  const next = random(20261125);
  let refusedDrops = 0;
  let offered = 0;
  const refusedOffers: string[] = [];
  const lentOffers: string[] = [];
  for (const [index, world] of worlds.entries()) {
    const engine = engineOf(world);
    for (const lesson of lessonsOf(world)) {
      const length = toPlacement(lesson).endMinutes - toPlacement(lesson).startMinutes;
      const lets = offer === "gateway" ? letsStartAt(gatewayOf(world, lesson, length)) : () => true;
      for (let drop = 0; drop < DROPS_PER_LESSON; drop++) {
        const dayOfWeek = DAYS[Math.floor(next() * DAYS.length)]!;
        const startMinutes = 8 * 60 + 5 * Math.floor(next() * ((16 * 60 - 8 * 60) / 5));
        const change = { dayOfWeek, startMinutes, endMinutes: startMinutes + length };
        // Only a drop the drag refuses opens the dialog.
        if (engine.validateChange(lesson.id, change)) continue;
        refusedDrops++;
        const candidate = { ...toPlacement(lesson), ...change };
        const options = {
          days: DAYS,
          studentGroupOf: engine.studentGroupOf,
          // What the page passes (handleInvalidDrop); the control is what it passed before.
          ...(offer !== "before"
            ? { allows: (attempt: typeof candidate) => engine.validateChange(lesson.id, attempt) && lets(attempt.dayOfWeek, attempt.startMinutes) }
            : {}),
        };
        for (const suggestion of suggestPlacements(candidate, engine.placements, constraintsOf(world), options)) {
          offered++;
          if (!engine.validateChange(lesson.id, suggestion)) {
            refusedOffers.push(`world ${index} ${lesson.id} dropped on day ${dayOfWeek} ${startMinutes}: offered day ${suggestion.dayOfWeek} ${suggestion.startMinutes}`);
          }
          if (inALentHour(world, lesson, suggestion.dayOfWeek, suggestion.startMinutes, length)) {
            lentOffers.push(`world ${index} ${lesson.id} dropped on day ${dayOfWeek} ${startMinutes}: offered day ${suggestion.dayOfWeek} ${suggestion.startMinutes}`);
          }
        }
      }
    }
  }
  return { refusedDrops, offered, refusedOffers, lentOffers };
}

describe("the times offered after a refused drop, in the worlds of the judge's fallfil", () => {
  it("are never a time the drag refuses", () => {
    const { refusedDrops, offered, refusedOffers } = survey("page");
    // The survey measures something: drops that were refused, and times offered for them.
    expect(refusedDrops).toBeGreaterThan(300);
    expect(offered).toBeGreaterThan(300);
    expect(refusedOffers).toEqual([]);
  });

  it("(control) are refused times when the search is asked as the page used to ask it: the worlds do reach the gap", () => {
    const { refusedOffers } = survey("before");
    expect(refusedOffers.length).toBeGreaterThan(20);
  });

  it("are never an hour the lesson's own room is lent out, when the gateway is asked as well (OTHER_SCHOOL)", () => {
    const { offered, refusedOffers, lentOffers } = survey("gateway");
    expect(offered).toBeGreaterThan(300);
    // Narrower than the drag, never wider.
    expect(refusedOffers).toEqual([]);
    expect(lentOffers).toEqual([]);
  });

  it("(control) are such an hour when only the page's own check is asked: it holds no loan, and the worlds with a lent room do reach it", () => {
    const { lentOffers } = survey("page");
    expect(lentOffers.length).toBeGreaterThan(10);
  });
});

describe("the page's own drag control (validateChange of useScheduleEngine), against the judge's verdicts (E1, Klart (d))", () => {
  /*
   * lib/lesson-judge-mirror.contract.test.ts holds validatePlacement to the fallfil with the arguments validateChange gives it, written out
   * there by hand. A validateChange that stopped handing validatePlacement the ramtid, the year's spans, the class's meals or the weekly
   * rows left that test green, and the drag the milder for it. This asks the control the page calls itself, for every case of the file:
   * where the judge refuses it refuses, and where the judge lets through it lets through.
   */
  const engines = worlds.map((world) => engineOf(world));

  it.each(cases.map((entry) => [entry.name, entry] as const))("%s", (_name, testCase) => {
    const engine = engines[testCase.world]!;
    const lesson = engine.lessonById.get(testCase.drag.lesson)!;
    const length = minutesOfClock(lesson.endTime) - minutesOfClock(lesson.startTime);
    const startMinutes = minutesOfClock(testCase.drag.start);
    const lets = engine.validateChange(lesson.id, { dayOfWeek: testCase.drag.day, startMinutes, endMinutes: startMinutes + length });
    // The page holds no other school's lessons and no loan of a room (lib/lesson-judge-mirror.contract.test.ts): what only another school
    // refuses it lets through, and the save says it.
    const refusedHere = testCase.verdict.reasons.some((reason) => reason !== "OTHER_SCHOOL");
    expect(lets, testCase.verdict.reasons.join(",")).toBe(!refusedHere);
  });
});
