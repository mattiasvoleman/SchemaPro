import type { PrismaClient } from '@prisma/client';
import { createTxMock, type TxMock } from '../../test/utils/prisma-mock';
import { MasterLessonsService } from '../calendar/master-lessons.service';
import { PRESERVED_FROM_REGENERATION } from '../optimization/preserved-lessons';
import { readOtherSchoolHolds, type OtherSchoolHold } from '../optimization/other-school-holds';
import { readBoardFacts, type BoardFacts } from '../swaps/board-rules';
import { CURRENT } from '../year-rollover/projected-rosters';
import {
  availabilityResourceOf,
  judgePlacements,
  type JudgedPlacement,
  type JudgePlacementsInput,
} from './placement-judge';

jest.mock('../swaps/board-rules', () => ({ ...jest.requireActual('../swaps/board-rules'), readBoardFacts: jest.fn() }));
jest.mock('../optimization/other-school-holds', () => ({
  ...jest.requireActual('../optimization/other-school-holds'),
  readOtherSchoolHolds: jest.fn(),
}));

const YEAR = '11111111-1111-4111-8111-111111111111';
const SCHOOL = '22222222-2222-4222-8222-222222222222';
const G7A = 'g-7a';
const G7B = 'g-7b';
const SV = 'g-sv';
const IDROTT = 'sub-idrott';
const MATTE = 'sub-matte';
const T1 = 'teacher-1';
const T2 = 'teacher-2';
const R1 = 'room-1';
const R2 = 'room-2';

const hhmm = (value: string): Date => new Date(`1970-01-01T${value}:00.000Z`);

/** A lesson the next Generera keeps, as the judge's read selects it. */
interface Kept {
  id: string;
  dayOfWeek: number;
  teacherId?: string | null;
  coTeacherId?: string | null;
  roomId?: string | null;
  studentGroupId: string;
  subjectId: string;
  start: string;
  end: string;
  recurrence?: 'ALL_WEEKS' | 'ODD_WEEKS' | 'EVEN_WEEKS';
  groupName?: string;
  subjectName?: string;
  extraGroups?: string[];
}

interface Constraint {
  resourceType: 'TEACHER' | 'ROOM' | 'STUDENT_GROUP';
  userId?: string;
  roomId?: string;
  studentGroupId?: string;
  dayOfWeek: number;
  start: string;
  end: string;
}

interface World {
  kept: Kept[];
  constraints: Constraint[];
  /** group id -> its home-class pupils */
  homeClass: Record<string, string[]>;
  /** group id -> its members */
  members: Record<string, string[]>;
}

const GROUPS: Record<string, string> = { [G7A]: '7A', [G7B]: '7B', [SV]: 'Svenska fördjupning' };
const SUBJECTS: Record<string, string> = { [IDROTT]: 'Idrott och hälsa', [MATTE]: 'Matematik' };

/** A transaction that answers the reads the judge and the real clash rule make, from a small world. */
function fakeTx(world: Partial<World> = {}): TxMock {
  const w: World = { kept: [], constraints: [], homeClass: {}, members: {}, ...world };
  const tx = createTxMock();
  const inList = (clause: unknown): string[] | null => (clause as { in?: string[] } | undefined)?.in ?? null;
  tx['masterLesson']!['findMany']!.mockImplementation(async ({ where }: { where: { dayOfWeek: { in: number[] } } }) =>
    w.kept
      .filter((lesson) => where.dayOfWeek.in.includes(lesson.dayOfWeek))
      .map((lesson) => ({
        id: lesson.id,
        dayOfWeek: lesson.dayOfWeek,
        teacherId: lesson.teacherId ?? null,
        coTeacherId: lesson.coTeacherId ?? null,
        roomId: lesson.roomId ?? null,
        studentGroupId: lesson.studentGroupId,
        subjectId: lesson.subjectId,
        startTime: hhmm(lesson.start),
        endTime: hhmm(lesson.end),
        recurrence: lesson.recurrence ?? 'ALL_WEEKS',
        startDate: null,
        endDate: null,
        subject: { name: lesson.subjectName ?? SUBJECTS[lesson.subjectId] ?? '' },
        studentGroup: { name: lesson.groupName ?? GROUPS[lesson.studentGroupId] ?? '' },
        extraGroups: (lesson.extraGroups ?? []).map((studentGroupId) => ({ studentGroupId })),
        participants: [],
      })),
  );
  tx['studentGroup']!['findMany']!.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    const ids = inList(where['id']);
    return Object.entries(GROUPS)
      .filter(([id]) => ids?.includes(id) ?? false)
      .map(([id, name]) => ({
        id,
        name,
        halfOfId: null,
        replacesSubjectId: null,
        academicYearId: YEAR,
        kind: id === SV ? 'TEACHING_GROUP' : 'CLASS',
      }));
  });
  tx['subject']!['findMany']!.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
    where.id.in.map((id) => ({ id, name: SUBJECTS[id] ?? id })),
  );
  tx['user']!['findMany']!.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    const asked = where['studentGroupId'];
    const wanted = typeof asked === 'string' ? [asked] : (inList(asked) ?? []);
    return wanted.flatMap((groupId) => (w.homeClass[groupId] ?? []).map((id) => ({ id, studentGroupId: groupId })));
  });
  tx['studentGroupMember']!['findMany']!.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
    (inList(where['studentGroupId']) ?? []).flatMap((groupId) =>
      (w.members[groupId] ?? []).map((studentId) => ({ studentId, studentGroupId: groupId })),
    ),
  );
  tx['availabilityConstraint']!['findMany']!.mockImplementation(async ({ where }: { where: { dayOfWeek: number } }) =>
    w.constraints
      .filter((constraint) => constraint.dayOfWeek === where.dayOfWeek)
      .map((constraint) => ({
        resourceType: constraint.resourceType,
        startTime: hhmm(constraint.start),
        endTime: hhmm(constraint.end),
        userId: constraint.userId ?? null,
        roomId: constraint.roomId ?? null,
        studentGroupId: constraint.studentGroupId ?? null,
      })),
  );
  tx['lunchSetting']!['findFirst']!.mockResolvedValue(null);
  tx['lunchSetting']!['findUnique']!.mockResolvedValue(null);
  return tx;
}

const NO_BOARD: BoardFacts = { frames: [], sittings: new Map(), gradeRules: [], spans: new Map() };
const masters = new MasterLessonsService({} as never, {} as never, {} as never);

beforeEach(() => {
  (readBoardFacts as jest.Mock).mockReset().mockResolvedValue(NO_BOARD);
  (readOtherSchoolHolds as jest.Mock).mockReset().mockResolvedValue({ holds: [] });
});

const row = (over: Partial<JudgedPlacement> = {}): JudgedPlacement => ({
  id: null,
  requirementId: 'req-1',
  studentGroupId: G7A,
  subjectId: IDROTT,
  teacherId: T1,
  coTeacherId: null,
  dayOfWeek: 2,
  startMinutes: 600, // 10:00
  minutes: 60,
  roomId: R1,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  ...over,
});

const input = (rows: JudgedPlacement[], over: Partial<JudgePlacementsInput> = {}): JudgePlacementsInput => ({
  academicYearId: YEAR,
  schoolId: SCHOOL,
  gradeNumbering: 'NIOARIG',
  basis: CURRENT,
  rows,
  beside: [],
  ...over,
});

const judge = (tx: TxMock, rows: JudgedPlacement[], over: Partial<JudgePlacementsInput> = {}) =>
  judgePlacements(tx as unknown as PrismaClient, masters, input(rows, over));

describe('judgePlacements', () => {
  it('judges nothing and reads nothing when there is no row', async () => {
    const tx = fakeTx();
    await expect(judge(tx, [])).resolves.toEqual([]);
    expect(tx['masterLesson']!['findMany']).not.toHaveBeenCalled();
    expect(readBoardFacts).not.toHaveBeenCalled();
    expect(readOtherSchoolHolds).not.toHaveBeenCalled();
  });

  it('passes a row nothing stands in the way of, one verdict per row in order', async () => {
    const verdicts = await judge(fakeTx(), [row(), row({ dayOfWeek: 3, requirementId: 'req-2', studentGroupId: G7B })]);
    expect(verdicts).toEqual([
      { index: 0, ok: true },
      { index: 1, ok: true },
    ]);
  });

  describe('SCHOOL_DAY', () => {
    it.each([
      ['a Saturday', { dayOfWeek: 6 }],
      ['before 08:00', { startMinutes: 420 }],
      ['past 18:00', { startMinutes: 1020, minutes: 65 }],
      ['off the five-minute grid', { startMinutes: 603 }],
    ])('refuses a lesson %s, and asks nothing more of the week for it', async (_name, over) => {
      const tx = fakeTx();
      const verdicts = await judge(tx, [row(over)]);
      expect(verdicts).toEqual([{ index: 0, ok: false, reason: 'SCHOOL_DAY' }]);
      expect(tx['masterLesson']!['findMany']).not.toHaveBeenCalled();
    });

    it('is the first reason: a row off the day that also clashes is told the day', async () => {
      const tx = fakeTx({ kept: [{ id: 'k1', dayOfWeek: 2, teacherId: T1, studentGroupId: G7B, subjectId: MATTE, start: '07:00', end: '08:00' }] });
      const [verdict] = await judge(tx, [row({ startMinutes: 420 })]);
      expect(verdict?.reason).toBe('SCHOOL_DAY');
    });
  });

  describe('OVER_DEMAND', () => {
    const post = { lessonsPerWeek: 3, minutesPerLesson: 60 };

    it('refuses the rows of a post whose locks already answer what they place', async () => {
      const demand = new Map([['req-1', { post, lockedMinutes: [60, 60, 60], placed: [60] }]]);
      const verdicts = await judge(fakeTx(), [row(), row({ requirementId: 'req-2', dayOfWeek: 4 })], { demand });
      expect(verdicts.map((verdict) => verdict.reason)).toEqual(['OVER_DEMAND', undefined]);
    });

    it('lets a post through when the locks leave room, and skips the question without the map', async () => {
      const room = new Map([['req-1', { post, lockedMinutes: [60], placed: [60, 60] }]]);
      expect((await judge(fakeTx(), [row()], { demand: room }))[0]?.ok).toBe(true);
      const full = new Map([['req-1', { post, lockedMinutes: [60, 60, 60], placed: [60] }]]);
      expect((await judge(fakeTx(), [row()]))[0]?.ok).toBe(true);
      expect((await judge(fakeTx(), [row()], { demand: full }))[0]?.reason).toBe('OVER_DEMAND');
    });
  });

  describe('the clash rule (findConflicts), against the lessons Generera keeps', () => {
    const kept = (over: Partial<Kept> = {}): Kept => ({
      id: 'k1',
      dayOfWeek: 2,
      teacherId: T2,
      roomId: R2,
      studentGroupId: G7B,
      subjectId: MATTE,
      start: '10:30',
      end: '11:30',
      ...over,
    });
    const named = { otherKind: 'LESSON', className: '7B', subjectName: 'Matematik', day: 2, start: '10:30', end: '11:30' };

    it('TEACHER: names the other lesson by class, subject, day and time', async () => {
      const [verdict] = await judge(fakeTx({ kept: [kept({ teacherId: T1 })] }), [row()]);
      expect(verdict).toEqual({ index: 0, ok: false, reason: 'TEACHER', params: named });
    });

    it('TEACHER: the medlärare counts as the teacher', async () => {
      const [verdict] = await judge(fakeTx({ kept: [kept({ coTeacherId: T1 })] }), [row()]);
      expect(verdict?.reason).toBe('TEACHER');
      const [other] = await judge(fakeTx({ kept: [kept({ teacherId: T1 })] }), [row({ teacherId: null, coTeacherId: T1 })]);
      expect(other?.reason).toBe('TEACHER');
    });

    it('ROOM: the same room at the same time', async () => {
      const [verdict] = await judge(fakeTx({ kept: [kept({ roomId: R1 })] }), [row()]);
      expect(verdict).toEqual({ index: 0, ok: false, reason: 'ROOM', params: named });
    });

    it('GROUP: the class has another lesson then, also as an extra class on it', async () => {
      const [own] = await judge(fakeTx({ kept: [kept({ studentGroupId: G7A })] }), [row()]);
      expect(own?.reason).toBe('GROUP');
      const [extra] = await judge(fakeTx({ kept: [kept({ extraGroups: [G7A] })] }), [row()]);
      expect(extra?.reason).toBe('GROUP');
      expect(extra?.params).toMatchObject({ className: '7B' });
    });

    it('PUPILS: another group that shares a pupil with the class, which is no group of the row', async () => {
      const world = {
        homeClass: { [G7A]: ['p1', 'p2'] },
        members: { [SV]: ['p1'] },
        kept: [kept({ studentGroupId: SV, subjectId: MATTE })],
      };
      const [verdict] = await judge(fakeTx(world), [row()]);
      expect(verdict).toEqual({
        index: 0,
        ok: false,
        reason: 'PUPILS',
        params: { ...named, className: 'Svenska fördjupning' },
      });
    });

    it('lets a lesson of another weekday, an even-week lesson against an odd one, and a free quarter-hour through', async () => {
      const world = {
        kept: [
          kept({ id: 'other-day', dayOfWeek: 3, teacherId: T1, roomId: R1, studentGroupId: G7A }),
          kept({ id: 'even', teacherId: T1, roomId: R1, studentGroupId: G7A, recurrence: 'EVEN_WEEKS' as const, start: '10:00', end: '11:00' }),
          kept({ id: 'after', teacherId: T1, roomId: R1, studentGroupId: G7A, start: '11:00', end: '12:00' }),
        ],
      };
      const [verdict] = await judge(fakeTx(world), [row({ recurrence: 'ODD_WEEKS' })]);
      expect(verdict).toEqual({ index: 0, ok: true });
    });

    it.each([
      ['TEACHER', { resourceType: 'TEACHER' as const, userId: T1 }, 'TEACHER'],
      ['ROOM', { resourceType: 'ROOM' as const, roomId: R1 }, 'ROOM'],
      ['GROUP', { resourceType: 'STUDENT_GROUP' as const, studentGroupId: G7A }, 'GROUP'],
    ])('AVAILABILITY of the %s: the resource is named in params', async (_name, who, resource) => {
      const world = { constraints: [{ ...who, dayOfWeek: 2, start: '09:30', end: '10:30' }] };
      const [verdict] = await judge(fakeTx(world), [row()]);
      expect(verdict).toEqual({ index: 0, ok: false, reason: 'AVAILABILITY', params: { resource } });
    });

    it('AVAILABILITY: reads the resource out of the three sentences the real rule gives (the pin)', async () => {
      const messages = new Map<string, string>();
      for (const [kind, who] of [
        ['TEACHER', { resourceType: 'TEACHER' as const, userId: T1 }],
        ['ROOM', { resourceType: 'ROOM' as const, roomId: R1 }],
        ['GROUP', { resourceType: 'STUDENT_GROUP' as const, studentGroupId: G7A }],
      ] as const) {
        const hits = await masters.findConflicts(
          fakeTx({ constraints: [{ ...who, dayOfWeek: 2, start: '09:30', end: '10:30' }] }) as unknown as PrismaClient,
          CURRENT,
          { id: null, academicYearId: YEAR, studentGroupId: G7A, subjectId: IDROTT },
          { dayOfWeek: 2, startMinutes: 600, endMinutes: 660, teacherId: T1, roomId: R1 },
          { against: [] },
        );
        expect(hits).toHaveLength(1);
        messages.set(kind, hits[0]!.message);
        expect(availabilityResourceOf(hits[0]!.message)).toBe(kind);
      }
      expect([...messages.values()]).toEqual([
        'The teacher is unavailable in this slot.',
        'The room is unavailable in this slot.',
        'The student group is unavailable in this slot.',
      ]);
    });

    it('tells the teacher before the room before the class when a row breaks several', async () => {
      const world = {
        kept: [
          kept({ id: 'a', studentGroupId: G7A, start: '10:00', end: '11:00' }),
          kept({ id: 'b', roomId: R1, start: '10:00', end: '11:00' }),
          kept({ id: 'c', teacherId: T1, start: '10:00', end: '11:00' }),
        ],
      };
      const [verdict] = await judge(fakeTx(world), [row()]);
      expect(verdict?.reason).toBe('TEACHER');
    });

    it('reads the kept lessons once for the year and the weekdays of the rows, by the rule Generera keeps by', async () => {
      const tx = fakeTx();
      await judge(tx, [row(), row({ dayOfWeek: 4 }), row({ dayOfWeek: 4, startMinutes: 780 })]);
      expect(tx['masterLesson']!['findMany']).toHaveBeenCalledTimes(1);
      const args = tx['masterLesson']!['findMany']!.mock.calls[0]![0] as { where: Record<string, unknown> };
      expect(args.where).toEqual({
        academicYearId: YEAR,
        isParked: false,
        dayOfWeek: { in: [2, 4] },
        OR: PRESERVED_FROM_REGENERATION,
      });
    });

    it('holds a row against a kept lesson Generera once wrote from a förläggning too, as any kept lesson', async () => {
      // Kept only because somebody gave it a second class: the PRESERVED filter let it through, so it is a lesson like any other.
      const written = kept({ id: 'written', teacherId: T1, studentGroupId: G7A, subjectId: IDROTT, roomId: R1, extraGroups: [G7B] });
      const [verdict] = await judge(fakeTx({ kept: [written] }), [row()]);
      expect(verdict?.reason).toBe('TEACHER');
    });

    it('asks the rule\'s own reads once for all the rows, not once per row', async () => {
      const tx = fakeTx({ kept: [kept({ id: 'x', start: '13:00', end: '14:00' })] });
      await judge(tx, [row(), row({ startMinutes: 780 }), row({ startMinutes: 840, requirementId: 'req-2' })]);
      // The pupil buffers of the year and the day's weekly rows: one statement each, whatever the number of rows.
      expect(tx['teachingRequirement']!['findMany']).toHaveBeenCalledTimes(1);
      expect(tx['availabilityConstraint']!['findMany']).toHaveBeenCalledTimes(1);
    });
  });

  describe('the other förläggningar', () => {
    it('names a row that stands where another row of the judged set does, both ways', async () => {
      const a = row({ id: 'p-a', requirementId: 'req-a', studentGroupId: G7A, roomId: R1 });
      const b = row({ id: 'p-b', requirementId: 'req-b', studentGroupId: G7B, subjectId: MATTE, roomId: R2, startMinutes: 630 });
      const verdicts = await judge(fakeTx(), [a, b]);
      expect(verdicts[0]).toEqual({
        index: 0,
        ok: false,
        reason: 'TEACHER',
        params: { otherKind: 'PLACEMENT', className: '7B', subjectName: 'Matematik', day: 2, start: '10:30', end: '11:30' },
      });
      expect(verdicts[1]).toEqual({
        index: 1,
        ok: false,
        reason: 'TEACHER',
        params: { otherKind: 'PLACEMENT', className: '7A', subjectName: 'Idrott och hälsa', day: 2, start: '10:00', end: '11:00' },
      });
    });

    it('holds a row against the year\'s other posts\' rows, which are not themselves judged', async () => {
      const mine = row({ id: null, requirementId: 'req-1' });
      const theirs = row({ id: 'p-theirs', requirementId: 'req-9', studentGroupId: G7B, subjectId: MATTE, teacherId: T2, roomId: R1 });
      const verdicts = await judge(fakeTx(), [mine], { beside: [theirs] });
      expect(verdicts).toHaveLength(1);
      expect(verdicts[0]).toMatchObject({ reason: 'ROOM', params: { otherKind: 'PLACEMENT', className: '7B' } });
    });

    it('does not hold a row against itself, and an odd and an even row of one pair stand in one slot without a clash', async () => {
      const odd = row({ id: 'p-odd', recurrence: 'ODD_WEEKS' });
      const even = row({ id: 'p-even', recurrence: 'EVEN_WEEKS' });
      expect(await judge(fakeTx(), [odd, even])).toEqual([
        { index: 0, ok: true },
        { index: 1, ok: true },
      ]);
      expect(await judge(fakeTx(), [row({ id: 'p-one' })])).toEqual([{ index: 0, ok: true }]);
    });

    it('does hold an every-week row against an odd-week row of another post in the same slot', async () => {
      const verdicts = await judge(fakeTx(), [row({ id: 'p-all' })], {
        beside: [row({ id: 'p-odd', requirementId: 'req-9', recurrence: 'ODD_WEEKS', studentGroupId: G7B, subjectId: MATTE })],
      });
      expect(verdicts[0]?.reason).toBe('TEACHER');
    });

    it('lets two posts with windows that never meet share a slot', async () => {
      const autumn = row({ id: 'p-a', startDate: new Date('2026-08-17'), endDate: new Date('2026-12-18') });
      const spring = row({ id: 'p-b', requirementId: 'req-b', startDate: new Date('2027-01-11'), endDate: new Date('2027-06-10') });
      const verdicts = await judge(fakeTx(), [autumn, spring]);
      expect(verdicts.every((verdict) => verdict.ok)).toBe(true);
    });

    it('judges a row once even when the caller passes it in both lists', async () => {
      const a = row({ id: 'p-a' });
      const verdicts = await judge(fakeTx(), [a], { beside: [a] });
      expect(verdicts).toEqual([{ index: 0, ok: true }]);
    });
  });

  describe('the board (ramtid, lunch, rules on årskurser)', () => {
    const frame = { min: 1, max: 9, day: null, start: 8 * 60 + 30, end: 15 * 60 };
    const facts = (over: Partial<BoardFacts> = {}): BoardFacts => ({
      ...NO_BOARD,
      spans: new Map([[G7A, [7, 7] as [number, number]], [G7B, [7, 7] as [number, number]]]),
      ...over,
    });

    it('FRAME: a lesson outside the stage\'s day', async () => {
      (readBoardFacts as jest.Mock).mockResolvedValue(facts({ frames: [frame] }));
      const verdicts = await judge(fakeTx(), [row({ startMinutes: 480 })]);
      expect(verdicts).toEqual([{ index: 0, ok: false, reason: 'FRAME' }]);
    });

    it('LUNCH: a lesson on the class\'s sitting', async () => {
      (readBoardFacts as jest.Mock).mockResolvedValue(
        facts({ sittings: new Map([[`${G7A}|2`, [{ studentGroupId: G7A, dayOfWeek: 2, startMinutes: 630, endMinutes: 660 }]]]) }),
      );
      expect((await judge(fakeTx(), [row()]))[0]?.reason).toBe('LUNCH');
    });

    it('LUNCH: a post of some weeks is held to the placed meal of its own weeks (20270209090000)', async () => {
      // Tuesday: 10:30–11:00 in the autumn (to Sunday 2026-12-20), 11:00–11:30 from Monday 2027-01-11; the post is 11:00–12:00.
      (readBoardFacts as jest.Mock).mockResolvedValue(
        facts({
          sittings: new Map([[
            `${G7A}|2`,
            [
              { studentGroupId: G7A, dayOfWeek: 2, startMinutes: 630, endMinutes: 660, startDate: null, endDate: '2026-12-20' },
              { studentGroupId: G7A, dayOfWeek: 2, startMinutes: 660, endMinutes: 690, startDate: '2027-01-11', endDate: null },
            ],
          ]]),
        }),
      );
      const at = (startDate: Date | null, endDate: Date | null) => judge(fakeTx(), [row({ startMinutes: 660, minutes: 60, startDate, endDate })]);
      // A post of the autumn is clear of the spring's meal, which is on top of 11:00–12:00; a post of the spring and one of every week are not.
      expect((await at(new Date('2026-08-17T00:00:00.000Z'), new Date('2026-12-18T00:00:00.000Z')))[0]).toMatchObject({ ok: true });
      expect((await at(new Date('2027-01-11T00:00:00.000Z'), new Date('2027-06-11T00:00:00.000Z')))[0]).toMatchObject({ ok: false, reason: 'LUNCH' });
      expect((await at(null, null))[0]).toMatchObject({ ok: false, reason: 'LUNCH' });
    });

    it('LUNCH is the school’s placed meals only: Generera’s own sittings, which it lays again, are not read (MEDEL-1 of #293)', async () => {
      (readBoardFacts as jest.Mock).mockResolvedValue(facts());
      await judge(fakeTx(), [row()]);
      expect((readBoardFacts as jest.Mock).mock.calls.at(-1)![1]).toMatchObject({ handPlacedSittingsOnly: true });
    });

    it('GRADE_RULE: a weekly row that closes the hour to the årskurs', async () => {
      (readBoardFacts as jest.Mock).mockResolvedValue(
        facts({
          gradeRules: [
            { resourceType: 'GRADE_LEVEL', userId: null, roomId: null, studentGroupId: null, minGradeLevel: 7, maxGradeLevel: 9, dayOfWeek: 2, startMinutes: 600, endMinutes: 720 },
          ],
        }),
      );
      expect((await judge(fakeTx(), [row()]))[0]?.reason).toBe('GRADE_RULE');
    });

    it('reads the facts once per weekday for the groups of the rows that got this far, and asks only them', async () => {
      const clashing = row({ id: 'p-clash', teacherId: T2, startMinutes: 780, dayOfWeek: 4, studentGroupId: G7B, requirementId: 'req-b' });
      const verdicts = await judge(
        fakeTx({ kept: [{ id: 'k1', dayOfWeek: 4, teacherId: T2, studentGroupId: SV, subjectId: MATTE, start: '13:00', end: '14:00' }] }),
        [row({ id: 'p-1' }), row({ id: 'p-2', startMinutes: 700, studentGroupId: G7B, requirementId: 'req-c', teacherId: T2, roomId: R2 }), clashing],
      );
      expect(verdicts[2]?.reason).toBe('TEACHER');
      const calls = (readBoardFacts as jest.Mock).mock.calls.map(([, args]) => args as { weekday: number; groupIds: string[] });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ weekday: 2, academicYearId: YEAR, schoolId: SCHOOL, gradeNumbering: 'NIOARIG' });
      expect([...calls[0]!.groupIds].sort()).toEqual([G7A, G7B]);
    });

    it('comes after the clash rule: a row that clashes is not asked the board', async () => {
      (readBoardFacts as jest.Mock).mockResolvedValue(facts({ frames: [frame] }));
      const tx = fakeTx({ kept: [{ id: 'k1', dayOfWeek: 2, teacherId: T1, studentGroupId: G7B, subjectId: MATTE, start: '07:30', end: '08:30' }] });
      const [verdict] = await judge(tx, [row({ startMinutes: 480 })]);
      expect(verdict?.reason).toBe('TEACHER');
    });
  });

  describe('OTHER_SCHOOL', () => {
    const hold = (over: Partial<OtherSchoolHold> = {}): OtherSchoolHold => ({
      holdId: 'h1',
      kind: 'TEACHER_BUSY',
      resourceKind: 'TEACHER',
      resourceId: T1,
      dayOfWeek: 2,
      startTime: '10:30:00',
      endTime: '12:00:00',
      schools: ['Södra skolan', 'Norra skolan'],
      ...over,
    });

    it('names the schools holding the teacher, in name order', async () => {
      (readOtherSchoolHolds as jest.Mock).mockResolvedValue({ holds: [hold(), hold({ holdId: 'h2', schools: ['Norra skolan'] })] });
      const verdicts = await judge(fakeTx(), [row()]);
      expect(verdicts).toEqual([{ index: 0, ok: false, reason: 'OTHER_SCHOOL', params: { schools: 'Norra skolan, Södra skolan' } }]);
    });

    it('holds the medlärare and the room too, and every week (a hold has no weeks)', async () => {
      (readOtherSchoolHolds as jest.Mock).mockResolvedValue({
        holds: [hold({ resourceId: T2 }), hold({ holdId: 'h3', kind: 'ROOM_LENT', resourceKind: 'ROOM', resourceId: R1, schools: ['Östra skolan'] })],
      });
      expect((await judge(fakeTx(), [row({ coTeacherId: T2, roomId: R2 })]))[0]?.reason).toBe('OTHER_SCHOOL');
      const [room] = await judge(fakeTx(), [row({ recurrence: 'EVEN_WEEKS' })]);
      expect(room).toEqual({ index: 0, ok: false, reason: 'OTHER_SCHOOL', params: { schools: 'Östra skolan' } });
    });

    it('lets through a hold on another day, a time that only touches, and somebody else\'s teacher', async () => {
      (readOtherSchoolHolds as jest.Mock).mockResolvedValue({
        holds: [hold({ dayOfWeek: 3 }), hold({ holdId: 'h2', startTime: '11:00:00', endTime: '12:00:00' }), hold({ holdId: 'h3', resourceId: T2 })],
      });
      expect((await judge(fakeTx(), [row()]))[0]?.ok).toBe(true);
    });

    it('is read once, with the year and the school, and only for rows that got this far', async () => {
      await judge(fakeTx(), [row(), row({ startMinutes: 720 })]);
      expect(readOtherSchoolHolds).toHaveBeenCalledTimes(1);
      expect(readOtherSchoolHolds).toHaveBeenCalledWith(expect.anything(), YEAR, SCHOOL);
      (readOtherSchoolHolds as jest.Mock).mockClear();
      await judge(fakeTx(), [row({ dayOfWeek: 6 })]);
      expect(readOtherSchoolHolds).not.toHaveBeenCalled();
    });
  });

  describe('what a refusal says', () => {
    it('names no person: only the class and the subject of the other lesson', async () => {
      const world = {
        kept: [{ id: 'k1', dayOfWeek: 2, teacherId: T1, studentGroupId: G7B, subjectId: MATTE, start: '10:00', end: '11:00' }],
      };
      const verdicts = await judge(fakeTx(world), [row()]);
      const text = JSON.stringify(verdicts);
      expect(text).not.toContain(T1);
      expect(Object.keys(verdicts[0]!.params!).sort()).toEqual(['className', 'day', 'end', 'otherKind', 'start', 'subjectName']);
    });

    it('keeps every param a short flat value, a name cut at 120 characters (the filter drops longer ones whole)', async () => {
      const long = 'K'.repeat(300);
      const world = {
        kept: [{ id: 'k1', dayOfWeek: 2, teacherId: T1, studentGroupId: G7B, subjectId: MATTE, start: '10:00', end: '11:00', groupName: long, subjectName: long }],
      };
      const [verdict] = await judge(fakeTx(world), [row()]);
      for (const value of Object.values(verdict!.params!)) {
        expect(typeof value === 'number' || value.length <= 200).toBe(true);
      }
      expect((verdict!.params!['className'] as string).length).toBe(120);
    });
  });
});

describe('availabilityResourceOf', () => {
  it('reads teacher, room and, otherwise, the group', () => {
    expect(availabilityResourceOf('The teacher is unavailable in this slot.')).toBe('TEACHER');
    expect(availabilityResourceOf('The room is unavailable in this slot.')).toBe('ROOM');
    expect(availabilityResourceOf('The student group is unavailable in this slot.')).toBe('GROUP');
    expect(availabilityResourceOf('Something else')).toBe('GROUP');
  });
});
