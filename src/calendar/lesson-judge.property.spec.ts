import type { PrismaClient } from '@prisma/client';
import { createTxMock } from '../../test/utils/prisma-mock';
import { readOtherSchoolHolds, type OtherSchoolHold } from '../optimization/other-school-holds';
import { judgePlacements, type JudgedPlacement } from '../requirement-placements/placement-judge';
import { makeWorld } from '../swaps/__fixtures__/swap-world';
import { readBoardFacts, type BoardFacts } from '../swaps/board-rules';
import { SwapContext } from '../swaps/swap-context';
import type { SwapLesson } from '../swaps/swap-types';
import { CURRENT } from '../year-rollover/projected-rosters';
import { judgeLessons } from './lesson-judge';

/*
 * ONE DRAG, THREE JUDGES, on the rules a database is not needed to hold them to (En domare med ord, E1).
 *
 * scripts/test/probe-domaren.ts asks the hand edit's judge, a swap's and a förläggning's of every case of
 * __fixtures__/lesson-judge-cases.json over real Postgres, and requires the same verdict of all three. It cannot ask them
 * about OTHER_SCHOOL, which needs a huvudman with two schools and its loans, and it is not in the unit run. This holds the three
 * to ONE reading of the other schools' holds and of the board's three rules, over facts that are the same objects for each:
 *
 *   - the hand edit:       judgeLessons (lesson-judge.ts), the facts through the board's reader and the holds' reader;
 *   - a swap:              SwapContext.boardRefusal over a snapshot made of the same facts;
 *   - a förläggning:       judgePlacements over the same facts.
 *
 * The clash rule is the one function (findConflicts) for all three and is stubbed to say nothing here; the probe holds it.
 * Random facts, a seeded generator: a failure names the seed and the case.
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

/** An equality that says which case it failed for: this jest takes one argument to expect. */
function agree<T>(actual: T, expected: T, label: string, what: string): void {
  if (actual !== expected) throw new Error(`${label}: ${what}: ${String(actual)} where the hand edit says ${String(expected)}`);
}

describe('the three judges hold a lesson to the other schools’ holds, and to the board’s rules, alike', () => {
  const base = makeWorld({ seed: 7 });
  const CASES = 400;

  it.each([20261125, 7, 99])('seed %i: the same drag gets the same verdict from all three', async (seed) => {
    const next = random(seed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
    const between = (low: number, high: number): number => low + Math.floor(next() * (high - low + 1));
    const teachers = ['t1', 't2', 't3'];
    const rooms = ['r1', 'r2'];
    let refused = 0;
    let stood = 0;
    const seen = new Set<string>();

    for (let at = 0; at < CASES; at++) {
      // The other schools' holds on this school's teachers and rooms, and the board's three rules as facts.
      const holds: OtherSchoolHold[] = Array.from({ length: between(0, 4) }, (_, index) => {
        const start = 8 * 60 + 15 * between(0, 28);
        const teacher = next() < 0.6;
        return {
          holdId: `hold-${index}`,
          kind: teacher ? 'TEACHER_BUSY' : 'ROOM_LENT',
          resourceKind: teacher ? 'TEACHER' : 'ROOM',
          resourceId: teacher ? pick(teachers) : pick(rooms),
          dayOfWeek: between(1, 5),
          startTime: clock(start),
          endTime: clock(start + 15 * between(1, 6)),
          schools: [pick(['Norra skolan', 'Södra skolan', 'Östra skolan'])],
        };
      });
      const frameEnd = pick([14 * 60 + 30, 15 * 60, 16 * 60]);
      const lunchStart = 11 * 60 + 15 * between(0, 3);
      const closed = next() < 0.4 ? { day: between(1, 5), start: 13 * 60 + 15 * between(0, 4) } : null;
      const facts: BoardFacts = {
        frames: next() < 0.8 ? [{ min: 7, max: 9, day: null, start: 8 * 60, end: frameEnd }] : [],
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

      const minutes = pick([40, 45, 60]);
      const day = between(1, 5);
      const start = 8 * 60 + 5 * between(0, 100);
      const teacherId = pick(teachers);
      const coTeacherId = next() < 0.2 ? pick(teachers.filter((id) => id !== teacherId)) : null;
      const roomId = next() < 0.6 ? pick(rooms) : null;
      const label = `seed ${seed}, case ${at}: day ${day} at ${clock(start)} for ${minutes} min, teacher ${teacherId}${coTeacherId ? `+${coTeacherId}` : ''}, room ${roomId}`;

      // The hand edit.
      const [mine] = await judgeLessons(
        {} as PrismaClient,
        nothing,
        { academicYearId: YEAR, schoolId: SCHOOL, basis: CURRENT, gradeNumbering: 'NIOARIG' },
        [{ lesson: { id: 'moving', studentGroupId: CLASS, subjectId: SUBJECT }, candidate: { dayOfWeek: day, startMinutes: start, endMinutes: start + minutes, teacherId, coTeacherId, roomId } }],
      );

      // A swap's.
      const lesson: SwapLesson = {
        id: 'moving',
        subjectId: SUBJECT,
        subjectName: 'Matematik',
        studentGroupId: CLASS,
        groupName: '7A',
        teacherId,
        coTeacherId,
        roomId,
        dayOfWeek: 1,
        startMinutes: 8 * 60,
        endMinutes: 8 * 60 + minutes,
        recurrence: 'ALL_WEEKS',
        startDate: null,
        endDate: null,
        isLocked: false,
        isGenerated: false,
        extraGroupIds: [],
        studentIds: [],
      };
      const constraints = facts.gradeRules.map((rule) => ({ ...rule }));
      const context = new SwapContext({
        ...base.data,
        lessons: [lesson],
        posts: [],
        frames: [...facts.frames],
        sittings: [...facts.sittings.values()].flat(),
        constraints,
        holds,
        groups: [{ id: CLASS, name: '7A', kind: 'CLASS', halfOfId: null, replacesSubjectId: null, academicYearId: YEAR, gradeLevel: 7 } as never],
        rosters: { ...base.data.rosters, membersByGroup: new Map(), groupsByStudent: new Map(), homeMembers: [], homeClassOf: new Map(), gradeOfGroup: new Map([[CLASS, 7]]) },
      });
      const swapped = context.boardRefusal({ lesson, to: { dayOfWeek: day, startMinutes: start, endMinutes: start + minutes } });

      // A förläggning's.
      const tx = createTxMock();
      tx['studentGroup']!['findMany']!.mockResolvedValue([{ id: CLASS, name: '7A' }]);
      tx['subject']!['findMany']!.mockResolvedValue([{ id: SUBJECT, name: 'Matematik' }]);
      tx['masterLesson']!['findMany']!.mockResolvedValue([]);
      const row: JudgedPlacement = {
        id: null,
        requirementId: 'post',
        studentGroupId: CLASS,
        subjectId: SUBJECT,
        teacherId,
        coTeacherId,
        dayOfWeek: day,
        startMinutes: start,
        minutes,
        roomId,
        recurrence: 'ALL_WEEKS',
        startDate: null,
        endDate: null,
      };
      const [placed] = await judgePlacements(tx as unknown as PrismaClient, nothing as never, {
        academicYearId: YEAR,
        schoolId: SCHOOL,
        gradeNumbering: 'NIOARIG',
        basis: CURRENT,
        rows: [row],
        beside: [],
      });

      // The three agree: ok or not, and which of the board's rules is the first (FRAME, LUNCH, GRADE_RULE, then OTHER_SCHOOL).
      agree(swapped === null, mine!.ok, label, 'a swap’s judge says ok');
      agree(placed!.ok, mine!.ok, label, 'the förläggning’s judge says ok');
      if (mine!.ok) {
        stood += 1;
        continue;
      }
      refused += 1;
      const first = mine!.refusals[0]!.reason;
      agree(swapped, first, label, 'a swap’s judge says');
      agree(placed!.reason, first, label, 'the förläggning’s judge says');
      seen.add(first);
      if (first === 'OTHER_SCHOOL') {
        // The schools named are the same, in the same order.
        agree(String(placed!.params?.['schools']), String(mine!.refusals[0]!.params['schools']), label, 'the schools named');
      }
    }
    // Not vacuous: every rule is the first one found in some case, and many drags stand.
    expect([...seen].sort()).toEqual(['FRAME', 'GRADE_RULE', 'LUNCH', 'OTHER_SCHOOL']);
    expect(stood).toBeGreaterThan(20);
    expect(refused).toBeGreaterThan(20);
  });
});
