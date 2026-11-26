import type { PrismaClient } from '@prisma/client';
import { readOtherSchoolHolds, type OtherSchoolHold } from '../optimization/other-school-holds';
import { readBoardFacts, type BoardFacts } from '../swaps/board-rules';
import { CURRENT } from '../year-rollover/projected-rosters';
import { EXEMPTABLE_RULES, type ExemptableRule } from './lesson-exemption';
import { judgeLessons, type JudgedCandidate } from './lesson-judge';

/*
 * UNDANTAG MED FLIT, as a property (E1b, Klart a): the same drag, asked with and without an exemption, gets the same verdict on every rule
 * except the one exempted.
 *
 * Random facts from a seeded generator (as lesson-judge.property.spec.ts); a failure names the seed and the case. For each drag the judge is asked
 * four things of the same facts: nothing named, each rule named alone, both named, and a name the time does not break. Held to:
 *
 *   - the refusals with a rule named are the refusals without it, MINUS that rule, in the same order and with the same figures;
 *   - `exempted` is the names that are in the refusals without them, and nothing else;
 *   - the drag is let through exactly when what is left is nothing, and a drag refused for anything but FRAME and LUNCH is refused whatever is named;
 *   - `exemptable` says "the refusals are FRAME and LUNCH and nothing else" and is false for a drag that is let through;
 *   - a lesson that stands where it stands is asked nothing and told which of the named rules it stands against (låt stå).
 */

jest.mock('../swaps/board-rules', () => ({ ...jest.requireActual('../swaps/board-rules'), readBoardFacts: jest.fn() }));
jest.mock('../optimization/other-school-holds', () => ({
  ...jest.requireActual('../optimization/other-school-holds'),
  readOtherSchoolHolds: jest.fn(),
}));

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

const clock = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`;
const YEAR = '00000000-0000-4000-8000-000000000001';
const SCHOOL = '00000000-0000-4000-8000-0000000000aa';
const CLASS = 'c1';
const SUBJECT = 's1';
const nothing = { findConflicts: async () => [] };
const world = { academicYearId: YEAR, schoolId: SCHOOL, basis: CURRENT, gradeNumbering: 'NIOARIG' as const };

/** An equality that says which case it failed for: this jest takes one argument to expect. */
function agree<T>(actual: T, expected: T, label: string, what: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label}: ${what}: ${JSON.stringify(actual)} where ${JSON.stringify(expected)} was expected`);
}

describe('an exemption lets one rule through and changes nothing else of the verdict', () => {
  const CASES = 500;

  it.each([20261125, 11, 4242])('seed %i: with and without a name, the verdict differs by that rule only', async (seed) => {
    const next = random(seed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
    const between = (low: number, high: number): number => low + Math.floor(next() * (high - low + 1));
    const teachers = ['t1', 't2'];
    const seen = new Set<string>();
    const exemptedSeen = new Set<string>();
    let letThrough = 0;
    let stillRefused = 0;

    for (let at = 0; at < CASES; at++) {
      const holds: OtherSchoolHold[] = Array.from({ length: between(0, 2) }, (_, index) => {
        const start = 8 * 60 + 15 * between(0, 28);
        return {
          holdId: `hold-${index}`,
          kind: 'TEACHER_BUSY',
          resourceKind: 'TEACHER',
          resourceId: pick(teachers),
          dayOfWeek: between(1, 5),
          startTime: clock(start),
          endTime: clock(start + 15 * between(1, 6)),
          schools: ['Norra skolan'],
        };
      });
      const frameEnd = pick([14 * 60 + 30, 15 * 60, 16 * 60]);
      const lunchStart = 11 * 60 + 15 * between(0, 8);
      const closed = next() < 0.35 ? { day: between(1, 5), start: 13 * 60 + 15 * between(0, 4) } : null;
      const facts: BoardFacts = {
        frames: next() < 0.9 ? [{ min: 7, max: 9, day: null, start: 8 * 60, end: frameEnd }] : [],
        sittings: new Map(
          [1, 2, 3, 4, 5].map((day) => [`${CLASS}|${day}`, [{ studentGroupId: CLASS, dayOfWeek: day, startMinutes: lunchStart, endMinutes: lunchStart + 45 }]] as const),
        ),
        gradeRules: closed
          ? [{ resourceType: 'GRADE_LEVEL', userId: null, roomId: null, studentGroupId: null, minGradeLevel: 7, maxGradeLevel: 7, dayOfWeek: closed.day, startMinutes: closed.start, endMinutes: closed.start + 90 }]
          : [],
        spans: new Map([[CLASS, [7, 7] as [number, number]]]),
      };
      (readBoardFacts as jest.Mock).mockResolvedValue(facts);
      (readOtherSchoolHolds as jest.Mock).mockResolvedValue({ holds });

      const minutes = pick([40, 60, 90]);
      const day = next() < 0.08 ? between(6, 7) : between(1, 5);
      const start = 8 * 60 + 5 * between(0, 100);
      const candidate: JudgedCandidate = { dayOfWeek: day, startMinutes: start, endMinutes: start + minutes, teacherId: pick(teachers), coTeacherId: null, roomId: null };
      const label = `seed ${seed}, case ${at}: day ${day} at ${clock(start)} for ${minutes} min`;
      const ask = async (exempt?: readonly ExemptableRule[], stands?: JudgedCandidate | null) =>
        (await judgeLessons({} as PrismaClient, nothing, world, [{ lesson: { id: 'moving', studentGroupId: CLASS, subjectId: SUBJECT }, candidate, exempt, ...(stands !== undefined ? { stands } : {}) }]))[0]!;

      const bare = await ask();
      const reasons = bare.refusals.map((refusal) => refusal.reason);
      for (const reason of reasons) seen.add(reason);
      agree(bare.exempted, [], label, 'a drag asked nothing is exempted from nothing');
      agree(bare.exemptable, reasons.length > 0 && reasons.every((reason) => (EXEMPTABLE_RULES as readonly string[]).includes(reason)), label, 'exemptable');

      const named: ExemptableRule[][] = [['FRAME'], ['LUNCH'], ['FRAME', 'LUNCH'], ['LUNCH', 'FRAME']];
      for (const names of named) {
        const asked = await ask(names);
        const want = bare.refusals.filter((refusal) => !(names as readonly string[]).includes(refusal.reason));
        agree(asked.refusals, want, label, `named ${names.join('+')}: the refusals are the bare ones minus the names`);
        agree(asked.exempted, EXEMPTABLE_RULES.filter((rule) => names.includes(rule) && reasons.includes(rule)), label, `named ${names.join('+')}: what is exempted`);
        agree(asked.ok, want.length === 0, label, `named ${names.join('+')}: ok`);
        agree(asked.exemptable, want.length > 0 && want.every((refusal) => (EXEMPTABLE_RULES as readonly string[]).includes(refusal.reason)), label, `named ${names.join('+')}: exemptable`);
        for (const rule of asked.exempted) exemptedSeen.add(rule);
        if (reasons.length > 0 && asked.ok) letThrough += 1;
        if (asked.refusals.length > 0 && reasons.some((reason) => (names as readonly string[]).includes(reason))) stillRefused += 1;
      }

      // Låt stå: the lesson stands where it is asked about, nothing is asked of it, and it is told which of the named rules it stands against.
      const standing = await ask(['FRAME', 'LUNCH'], candidate);
      agree(standing.ok, true, label, 'a lesson that stands is asked nothing, an exemption named or not');
      agree(standing.exempted, EXEMPTABLE_RULES.filter((rule) => reasons.includes(rule)), label, 'it is told which of the named rules it stands against');
    }
    // Not vacuous: both rules and a refusal that no exemption lifts are met, and many drags are let through by a name.
    expect([...seen].sort()).toEqual(expect.arrayContaining(['FRAME', 'GRADE_RULE', 'LUNCH', 'OTHER_SCHOOL']));
    expect([...exemptedSeen].sort()).toEqual(['FRAME', 'LUNCH']);
    expect(letThrough).toBeGreaterThan(20);
    expect(stillRefused).toBeGreaterThan(5);
  });
});
