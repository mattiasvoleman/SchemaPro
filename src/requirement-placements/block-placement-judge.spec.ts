import type { LessonRecurrence, PrismaClient } from '@prisma/client';
import { createTxMock, type TxMock } from '../../test/utils/prisma-mock';
import { MasterLessonsService } from '../calendar/master-lessons.service';
import { readOtherSchoolHolds } from '../optimization/other-school-holds';
import { readBoardFacts, type BoardFacts } from '../swaps/board-rules';
import { CURRENT } from '../year-rollover/projected-rosters';
import { blockLengthsOf as blockLengthsOfFit } from './block-placement-fit';
import {
  BLOCK_ROW_ORDER,
  besideRowsOfBlocks,
  blockLengthsOf,
  blockPlacementViewOf,
  blockRowsKeyOf,
  blockVerdictsOf,
  demandOfBlockMembers,
  judgedRowsOfBlock,
  loadBlock,
  loadBlocksOfYear,
  memberSlotOf,
  memberSlotsOfBlock,
  type BlockMemberPost,
  type BlockRowOrigin,
  type BlockSlot,
  type LoadedBlock,
  type StoredBlockRow,
} from './block-placement-judge';
import { judgePlacements, type PlacementVerdict } from './placement-judge';

jest.mock('../swaps/board-rules', () => ({ ...jest.requireActual('../swaps/board-rules'), readBoardFacts: jest.fn() }));
jest.mock('../optimization/other-school-holds', () => ({
  ...jest.requireActual('../optimization/other-school-holds'),
  readOtherSchoolHolds: jest.fn(),
}));

const YEAR = '11111111-1111-4111-8111-111111111111';
const SCHOOL = '22222222-2222-4222-8222-222222222222';
const NO_BOARD: BoardFacts = { frames: [], sittings: new Map(), gradeRules: [], spans: new Map() };
const masters = new MasterLessonsService({} as never, {} as never, {} as never);

beforeEach(() => {
  (readBoardFacts as jest.Mock).mockReset().mockResolvedValue(NO_BOARD);
  (readOtherSchoolHolds as jest.Mock).mockReset().mockResolvedValue({ holds: [] });
});

/** A member of a block: its own class, subject and teacher, two lessons of 60 every week. */
const member = (id: string, over: Partial<BlockMemberPost> = {}): BlockMemberPost => ({
  id,
  studentGroupId: `g-${id}`,
  subjectId: `sub-${id}`,
  teacherId: `t-${id}`,
  coTeacherId: null,
  startDate: null,
  endDate: null,
  shares: [],
  lessonsPerWeek: 2,
  minutesPerLesson: 60,
  lessonLengths: [],
  recurrence: 'ALL_WEEKS',
  blockId: 'block-1',
  ...over,
});

const slot = (over: Partial<BlockSlot> = {}): BlockSlot => ({
  dayOfWeek: 2,
  startMinutes: 600,
  minutes: 60,
  recurrence: 'ALL_WEEKS',
  rooms: [],
  ...over,
});

const stored = (id: string, over: Partial<StoredBlockRow> = {}): StoredBlockRow => ({
  id,
  ...slot(),
  changedAt: new Date('2026-11-16T08:00:00.000Z'),
  roomNames: [],
  ...over,
});

const loaded = (members: BlockMemberPost[], rows: StoredBlockRow[] = [], over: Partial<LoadedBlock> = {}): LoadedBlock => ({
  id: 'block-1',
  name: 'Språkval åk 7',
  sameTimesAsBlockId: null,
  members,
  rows,
  ...over,
});

describe('judgedRowsOfBlock', () => {
  it('is one row per lesson and member, a lesson at a time and, within it, in the members\' id order', () => {
    const block = loaded([member('c'), member('a'), member('b')]);
    const { judged, origins } = judgedRowsOfBlock(block, [slot({ dayOfWeek: 1 }), slot({ dayOfWeek: 3, startMinutes: 780 })]);
    expect(judged.map((row) => [row.dayOfWeek, row.requirementId])).toEqual([
      [1, 'a'], [1, 'b'], [1, 'c'],
      [3, 'a'], [3, 'b'], [3, 'c'],
    ]);
    expect(origins).toEqual([
      { blockId: 'block-1', index: 0, requirementId: 'a' },
      { blockId: 'block-1', index: 0, requirementId: 'b' },
      { blockId: 'block-1', index: 0, requirementId: 'c' },
      { blockId: 'block-1', index: 1, requirementId: 'a' },
      { blockId: 'block-1', index: 1, requirementId: 'b' },
      { blockId: 'block-1', index: 1, requirementId: 'c' },
    ]);
  });

  it('does not reorder the caller\'s members', () => {
    const members = [member('b'), member('a')];
    judgedRowsOfBlock(loaded(members), [slot()]);
    expect(members.map((one) => one.id)).toEqual(['b', 'a']);
  });

  it('gives each row what the judge reads of a post: the member\'s class, subject, teachers and window, the lesson\'s place', () => {
    const window = { startDate: new Date('2026-08-24T00:00:00.000Z'), endDate: new Date('2026-12-18T00:00:00.000Z') };
    const block = loaded([member('a', { coTeacherId: 'co-a', ...window })]);
    const { judged } = judgedRowsOfBlock(block, [{ ...slot({ rooms: [{ requirementId: 'a', roomId: 'room-1' }] }), id: 'row-1' }]);
    expect(judged).toEqual([
      {
        id: 'row-1:a',
        requirementId: 'a',
        studentGroupId: 'g-a',
        subjectId: 'sub-a',
        teacherId: 't-a',
        coTeacherId: 'co-a',
        dayOfWeek: 2,
        startMinutes: 600,
        minutes: 60,
        roomId: 'room-1',
        recurrence: 'ALL_WEEKS',
        startDate: window.startDate,
        endDate: window.endDate,
        pairWithoutRoom: false,
        inBlock: false,
        blockFit: null,
      },
    ]);
  });

  it('takes a member\'s room from its own room row, and leaves the engine to choose it for a member not named', () => {
    const block = loaded([member('a'), member('b'), member('c')]);
    const { judged } = judgedRowsOfBlock(block, [slot({ rooms: [{ requirementId: 'b', roomId: 'room-b' }] })]);
    expect(judged.map((row) => [row.requirementId, row.roomId])).toEqual([['a', null], ['b', 'room-b'], ['c', null]]);
  });

  it('keeps a room row of a lesson with the lesson, not with the next one', () => {
    const block = loaded([member('a')]);
    const { judged } = judgedRowsOfBlock(block, [slot({ rooms: [{ requirementId: 'a', roomId: 'room-1' }] }), slot({ dayOfWeek: 4 })]);
    expect(judged.map((row) => row.roomId)).toEqual(['room-1', null]);
  });

  it('reads a member as a post that is in no block, so that the judge\'s own BLOCK rule never refuses a block\'s lesson', () => {
    const { judged } = judgedRowsOfBlock(loaded([member('a', { blockId: 'block-1' })]), [slot()]);
    expect(judged[0]!.inBlock).toBe(false);
  });

  it('gives a row of the request (no id) no id, and a stored row an id per member: the row\'s and the member\'s', () => {
    const block = loaded([member('a'), member('b')]);
    expect(judgedRowsOfBlock(block, [slot()]).judged.map((row) => row.id)).toEqual([null, null]);
    expect(judgedRowsOfBlock(block, [{ ...slot(), id: null }]).judged.map((row) => row.id)).toEqual([null, null]);
    expect(judgedRowsOfBlock(block, [{ ...slot(), id: 'r-1' }]).judged.map((row) => row.id)).toEqual(['r-1:a', 'r-1:b']);
  });

  it('does not call a lesson of an odd-weeks block with no room a half of a pair', () => {
    const odd = loaded([member('a', { recurrence: 'ODD_WEEKS' })]);
    const { judged } = judgedRowsOfBlock(odd, [slot({ recurrence: 'ODD_WEEKS' })]);
    expect(judged[0]).toMatchObject({ pairWithoutRoom: false, roomId: null, recurrence: 'ODD_WEEKS' });
  });

  it('says a member that shares its lessons has none of the row\'s teachers (the block is refused for it anyway)', () => {
    const shared = member('a', { shares: [{ teacherId: 'bo', lessons: 1, minutes: 60 }] });
    const { judged } = judgedRowsOfBlock(loaded([shared]), [slot()]);
    expect(judged[0]).toMatchObject({ teacherId: null, blockFit: 'SHARES' });
  });

  describe('blockFit: the rule the block\'s lessons break, said by name on every row', () => {
    it('is null on every row when the lessons fit the block', () => {
      const { judged } = judgedRowsOfBlock(loaded([member('a'), member('b')]), [slot(), slot({ dayOfWeek: 4 })]);
      expect(judged.map((row) => row.blockFit)).toEqual([null, null, null, null]);
    });

    it('is the rule on EVERY row of the block when one lesson does not fit (a set another writer stored is not judged as clean)', () => {
      const block = loaded([member('a'), member('b')]);
      const { judged } = judgedRowsOfBlock(block, [slot(), slot({ dayOfWeek: 4, minutes: 45 })]);
      expect(judged.map((row) => row.blockFit)).toEqual(['LENGTH', 'LENGTH', 'LENGTH', 'LENGTH']);
    });

    it.each<[string, LoadedBlock, BlockSlot[], string]>([
      ['a block that follows another', loaded([member('a')], [], { sameTimesAsBlockId: 'leader' }), [slot()], 'FOLLOWER'],
      ['a block with no member', loaded([]), [slot()], 'EMPTY'],
      ['a member that shares', loaded([member('a', { shares: [{ teacherId: 'bo', lessons: 1, minutes: 60 }] })]), [slot()], 'SHARES'],
      ['a lesson of other weeks', loaded([member('a')]), [slot({ recurrence: 'ODD_WEEKS' })], 'WEEKS'],
      ['more lessons than the block has', loaded([member('a', { lessonsPerWeek: 1 })]), [slot(), slot({ dayOfWeek: 3 })], 'COUNT'],
      ['a room of a post that is no member', loaded([member('a')]), [slot({ rooms: [{ requirementId: 'x', roomId: 'r' }] })], 'MEMBER'],
    ])('names %s', (_name, block, rows, rule) => {
      const { judged } = judgedRowsOfBlock(block, rows);
      expect(judged.length).toBe(rows.length * block.members.length);
      expect(judged.every((row) => row.blockFit === rule)).toBe(true);
    });

    it('is not asked of a block with no lesson: there is no row to carry it', () => {
      expect(judgedRowsOfBlock(loaded([member('a')], [], { sameTimesAsBlockId: 'leader' }), [])).toEqual({ judged: [], origins: [] });
      expect(judgedRowsOfBlock(loaded([]), [])).toEqual({ judged: [], origins: [] });
    });
  });

  it('gives a block with no member no row, whatever the lessons: a lesson nobody sits', () => {
    expect(judgedRowsOfBlock(loaded([]), [slot()])).toEqual({ judged: [], origins: [] });
  });

  it('keeps two members with one id in the order they came in: the sort is stable, and ids are text', () => {
    const first = member('a', { teacherId: 'first' });
    const second = member('a', { teacherId: 'second' });
    const { judged } = judgedRowsOfBlock(loaded([first, second]), [slot()]);
    expect(judged.map((row) => row.teacherId)).toEqual(['first', 'second']);
    expect(judgedRowsOfBlock(loaded([member('b'), member('10'), member('9')]), [slot()]).judged.map((row) => row.requirementId)).toEqual(['10', '9', 'b']);
  });
});

describe('blockLengthsOf, as the judge\'s file hands it on', () => {
  it('is the fit\'s own: the lengths of the block\'s lessons, longest first', () => {
    expect(blockLengthsOf).toBe(blockLengthsOfFit);
    expect(blockLengthsOf({ members: [member('a', { lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] })] })).toEqual([80, 40]);
  });
});

describe('memberSlotOf and memberSlotsOfBlock', () => {
  it('is the lesson as one member\'s slot: its own room or none, and nobody\'s teacher', () => {
    const lesson = slot({ dayOfWeek: 4, startMinutes: 780, minutes: 80, recurrence: 'ODD_WEEKS', rooms: [{ requirementId: 'b', roomId: 'room-b' }] });
    expect(memberSlotOf(lesson, 'a')).toEqual({ dayOfWeek: 4, startMinutes: 780, minutes: 80, roomId: null, recurrence: 'ODD_WEEKS', teacherId: null });
    expect(memberSlotOf(lesson, 'b')).toEqual({ dayOfWeek: 4, startMinutes: 780, minutes: 80, roomId: 'room-b', recurrence: 'ODD_WEEKS', teacherId: null });
  });

  it('is an entry per member with one slot per lesson, in the lessons\' order', () => {
    const block = loaded([member('a'), member('b')]);
    const slots = memberSlotsOfBlock(block, [slot({ dayOfWeek: 1, rooms: [{ requirementId: 'b', roomId: 'r1' }] }), slot({ dayOfWeek: 5 })]);
    expect([...slots.keys()]).toEqual(['a', 'b']);
    expect(slots.get('a')!.map((one) => [one.dayOfWeek, one.roomId])).toEqual([[1, null], [5, null]]);
    expect(slots.get('b')!.map((one) => [one.dayOfWeek, one.roomId])).toEqual([[1, 'r1'], [5, null]]);
  });

  it('is empty for a block with no lesson, so that a member of an unplaced block has no entry (and no placed lesson)', () => {
    expect(memberSlotsOfBlock(loaded([member('a')]), []).size).toBe(0);
  });
});

describe('demandOfBlockMembers', () => {
  const lock = (minutes: number) => ({ minutes, teacherId: null });

  it('has an entry for each member of a block with lessons: its lessons, its covering locks, and the lengths the block places for it', () => {
    const a = member('a');
    const b = member('b');
    const asked: string[] = [];
    const demand = demandOfBlockMembers(
      [{ block: { members: [a, b] }, rows: [slot({ minutes: 60 }), slot({ dayOfWeek: 4, minutes: 60 })] }],
      (one) => {
        asked.push(one.id);
        return one.id === 'a' ? [lock(60)] : [];
      },
    );
    expect(asked.sort()).toEqual(['a', 'b']);
    expect([...demand.keys()]).toEqual(['a', 'b']);
    expect(demand.get('a')).toMatchObject({ post: a, lockedMinutes: [60], placed: [60, 60] });
    expect(demand.get('b')).toMatchObject({ post: b, lockedMinutes: [], placed: [60, 60] });
  });

  it('counts each length the block places, longest first, on a block of two lengths', () => {
    const split = member('a', { lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] });
    const demand = demandOfBlockMembers([{ block: { members: [split] }, rows: [slot({ minutes: 40 }), slot({ dayOfWeek: 3, minutes: 80 })] }], () => []);
    expect(demand.get('a')).toMatchObject({ lockedMinutes: [], placed: [80, 40] });
  });

  it('has no entry for a block with no lesson, whatever it has locked: it places nothing', () => {
    const asked = jest.fn(() => [lock(60)]);
    const demand = demandOfBlockMembers([{ block: { members: [member('a')] }, rows: [] }], asked);
    expect(demand.size).toBe(0);
    expect(asked).not.toHaveBeenCalled();
  });

  it('reads a lesson of an odd-weeks block as a lesson of the member\'s odd weeks', () => {
    const odd = member('a', { recurrence: 'ODD_WEEKS' });
    const demand = demandOfBlockMembers([{ block: { members: [odd] }, rows: [slot({ recurrence: 'ODD_WEEKS' })] }], () => []);
    expect(demand.get('a')?.placed).toEqual([60]);
  });

  it('collects several blocks into one map, each member under its own id', () => {
    const demand = demandOfBlockMembers(
      [
        { block: { members: [member('a')] }, rows: [slot()] },
        { block: { members: [member('x'), member('y')] }, rows: [slot()] },
        { block: { members: [member('z')] }, rows: [] },
      ],
      () => [],
    );
    expect([...demand.keys()].sort()).toEqual(['a', 'x', 'y']);
  });

  it('has the demand judgePlacements refuses on: a member whose locks already answer the lessons the block places', async () => {
    const a = member('a', { lessonsPerWeek: 1 });
    const b = member('b', { lessonsPerWeek: 1 });
    const block = loaded([a, b]);
    const rows = [slot()];
    const { judged, origins } = judgedRowsOfBlock(block, rows);
    // a's one lesson is already a lock; b has none.
    const demand = demandOfBlockMembers([{ block, rows }], (one) => (one.id === 'a' ? [lock(60)] : []));
    const verdicts = await judgePlacements(fakeTx() as unknown as PrismaClient, masters, {
      academicYearId: YEAR,
      schoolId: SCHOOL,
      gradeNumbering: 'NIOARIG',
      basis: CURRENT,
      rows: judged,
      beside: [],
      demand,
    });
    expect(blockVerdictsOf(verdicts, origins).map((verdict) => [verdict.requirementId, verdict.ok, verdict.reason ?? null])).toEqual([
      ['a', false, 'OVER_DEMAND'],
      ['b', true, null],
    ]);
  });
});

describe('besideRowsOfBlocks', () => {
  it('is every stored lesson of every block as one row per member, with the stored row\'s id and the member\'s', () => {
    const first = loaded([member('a'), member('b')], [stored('r-1'), stored('r-2', { dayOfWeek: 4 })]);
    const second = loaded([member('x')], [stored('r-3', { dayOfWeek: 5 })], { id: 'block-2' });
    const beside = besideRowsOfBlocks([first, second]);
    expect(beside.map((row) => [row.id, row.requirementId, row.dayOfWeek])).toEqual([
      ['r-1:a', 'a', 2],
      ['r-1:b', 'b', 2],
      ['r-2:a', 'a', 4],
      ['r-2:b', 'b', 4],
      ['r-3:x', 'x', 5],
    ]);
  });

  it('carries each member\'s own room from the lesson\'s room rows, and is nothing for no block or a block with no lesson', () => {
    const block = loaded([member('a'), member('b')], [stored('r-1', { rooms: [{ requirementId: 'b', roomId: 'room-b' }], roomNames: ['Sal B'] })]);
    expect(besideRowsOfBlocks([block]).map((row) => row.roomId)).toEqual([null, 'room-b']);
    expect(besideRowsOfBlocks([])).toEqual([]);
    expect(besideRowsOfBlocks([loaded([member('a')], [])])).toEqual([]);
  });

  it('carries the block\'s fit with it, so that a lesson that does not fit is refused by name wherever it is judged', () => {
    const wrong = loaded([member('a')], [stored('r-1', { minutes: 45 })]);
    expect(besideRowsOfBlocks([wrong])[0]).toMatchObject({ blockFit: 'LENGTH' });
  });

  it('is what a post\'s own row is judged beside: a clash with a member\'s lesson is a clash with a PLACEMENT, named by the member\'s class', async () => {
    const block = loaded([member('a')], [stored('r-1')]);
    const own = {
      id: null,
      requirementId: 'post-1',
      studentGroupId: 'g-post',
      subjectId: 'sub-post',
      teacherId: 't-a',
      coTeacherId: null,
      dayOfWeek: 2,
      startMinutes: 630,
      minutes: 60,
      roomId: null,
      recurrence: 'ALL_WEEKS' as const,
      startDate: null,
      endDate: null,
    };
    const tx = fakeTx({ groups: { 'g-a': 'Spanska 7', 'g-post': '7A' }, subjects: { 'sub-a': 'Spanska', 'sub-post': 'Matematik' } });
    const [verdict] = await judgePlacements(tx as unknown as PrismaClient, masters, {
      academicYearId: YEAR,
      schoolId: SCHOOL,
      gradeNumbering: 'NIOARIG',
      basis: CURRENT,
      rows: [own],
      beside: besideRowsOfBlocks([block]),
    });
    expect(verdict).toEqual({
      index: 0,
      ok: false,
      reason: 'TEACHER',
      params: { otherKind: 'PLACEMENT', className: 'Spanska 7', subjectName: 'Spanska', day: 2, start: '10:00', end: '11:00' },
    });
  });
});

describe('blockRowsKeyOf', () => {
  const rows = (): (BlockSlot & { id: string })[] => [
    { id: 'r-1', ...slot({ dayOfWeek: 1, startMinutes: 540, rooms: [{ requirementId: 'a', roomId: 'room-1' }, { requirementId: 'b', roomId: 'room-2' }] }) },
    { id: 'r-2', ...slot({ dayOfWeek: 3, startMinutes: 780, minutes: 80 }) },
  ];

  it('is 32 hex digits', () => {
    expect(blockRowsKeyOf(rows())).toMatch(/^[0-9a-f]{32}$/);
    expect(blockRowsKeyOf([])).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is the same for the same lessons, in whatever order the rows and the rooms of a row come', () => {
    const base = blockRowsKeyOf(rows());
    const [one, two] = rows();
    expect(blockRowsKeyOf([two!, one!])).toBe(base);
    const reversedRooms = { ...one!, rooms: [...one!.rooms].reverse() };
    expect(blockRowsKeyOf([reversedRooms, two!])).toBe(base);
    expect(blockRowsKeyOf(rows())).toBe(base);
  });

  it('does not read what a reader may differ in without the lessons having changed: the names of the rooms and the time of the last save', () => {
    const base = blockRowsKeyOf(rows());
    const withNames = rows().map((row) => ({ ...row, changedAt: new Date(), roomNames: ['x', 'y'] }));
    expect(blockRowsKeyOf(withNames)).toBe(base);
  });

  it('is changed by every part of a lesson: its id, day, start, length, weeks, and each room (the post and the room)', () => {
    const base = blockRowsKeyOf(rows());
    const mutate = (change: (list: ReturnType<typeof rows>) => void): string => {
      const copy = rows();
      change(copy);
      return blockRowsKeyOf(copy);
    };
    const changed = [
      mutate((r) => { r[0]!.id = 'r-9'; }),
      mutate((r) => { r[0]!.dayOfWeek = 2; }),
      mutate((r) => { r[0]!.startMinutes = 545; }),
      mutate((r) => { r[0]!.minutes = 65; }),
      mutate((r) => { r[0]!.recurrence = 'ODD_WEEKS'; }),
      mutate((r) => { r[0]!.rooms = [{ requirementId: 'a', roomId: 'room-9' }, { requirementId: 'b', roomId: 'room-2' }]; }),
      mutate((r) => { r[0]!.rooms = [{ requirementId: 'c', roomId: 'room-1' }, { requirementId: 'b', roomId: 'room-2' }]; }),
      mutate((r) => { r[0]!.rooms = [{ requirementId: 'a', roomId: 'room-1' }]; }),
      mutate((r) => { r[0]!.rooms = [...r[0]!.rooms, { requirementId: 'c', roomId: 'room-3' }]; }),
      mutate((r) => { r.pop(); }),
      mutate((r) => { r.push({ id: 'r-3', ...slot() }); }),
      mutate((r) => { r[1]!.rooms = [{ requirementId: 'a', roomId: 'room-1' }]; }),
    ];
    expect(changed.every((key) => key !== base)).toBe(true);
    expect(new Set(changed).size).toBe(changed.length);
  });

  it('tells two lessons that swap their places apart: the key is of the rows with their ids, not of the set of places', () => {
    const base = blockRowsKeyOf(rows());
    const [one, two] = rows();
    const swapped = [
      { ...one!, dayOfWeek: two!.dayOfWeek, startMinutes: two!.startMinutes, minutes: two!.minutes, rooms: two!.rooms },
      { ...two!, dayOfWeek: one!.dayOfWeek, startMinutes: one!.startMinutes, minutes: one!.minutes, rooms: one!.rooms },
    ];
    expect(blockRowsKeyOf(swapped)).not.toBe(base);
  });

  it('keeps a room of one lesson from reading as a room of another', () => {
    const room = { requirementId: 'a', roomId: 'room-1' };
    const first = [{ id: 'r-1', ...slot({ rooms: [room] }) }, { id: 'r-2', ...slot({ dayOfWeek: 4 }) }];
    const second = [{ id: 'r-1', ...slot() }, { id: 'r-2', ...slot({ dayOfWeek: 4, rooms: [room] }) }];
    expect(blockRowsKeyOf(first)).not.toBe(blockRowsKeyOf(second));
  });

  it('has the same key for the same lessons as a stored row and as the rows an answer is built from', () => {
    const asStored: StoredBlockRow[] = rows().map((row) => ({ ...row, changedAt: new Date(), roomNames: [] }));
    expect(blockRowsKeyOf(asStored)).toBe(blockRowsKeyOf(rows()));
  });
});

describe('blockVerdictsOf', () => {
  const origins: BlockRowOrigin[] = [
    { blockId: 'b', index: 0, requirementId: 'a' },
    { blockId: 'b', index: 0, requirementId: 'b' },
    { blockId: 'b', index: 1, requirementId: 'a' },
  ];

  it('says each verdict by the lesson and the member it was asked for, in the order asked', () => {
    const verdicts: PlacementVerdict[] = [
      { index: 0, ok: true },
      { index: 1, ok: false, reason: 'TEACHER', params: { className: '7A', day: 2 } },
      { index: 2, ok: false, reason: 'LUNCH' },
    ];
    expect(blockVerdictsOf(verdicts, origins)).toEqual([
      { index: 0, requirementId: 'a', ok: true },
      { index: 0, requirementId: 'b', ok: false, reason: 'TEACHER', params: { className: '7A', day: 2 } },
      { index: 1, requirementId: 'a', ok: false, reason: 'LUNCH' },
    ]);
  });

  it('leaves out a reason and params that are not there, and does not invent them', () => {
    const [view] = blockVerdictsOf([{ index: 0, ok: true }], origins);
    expect(Object.keys(view!).sort()).toEqual(['index', 'ok', 'requirementId']);
  });

  it('reads a row the judge gave no verdict for as holding', () => {
    expect(blockVerdictsOf([], origins).map((view) => view.ok)).toEqual([true, true, true]);
  });

  it('is empty for no rows', () => {
    expect(blockVerdictsOf([], [])).toEqual([]);
  });
});

describe('blockPlacementViewOf', () => {
  it('states a lesson with its clock as HH:MM and its end from the start and the length', () => {
    const view = blockPlacementViewOf('block-1', stored('r-1', { startMinutes: 9 * 60 + 5, minutes: 55, recurrence: 'ODD_WEEKS', dayOfWeek: 4 }));
    expect(view).toEqual({
      id: 'r-1',
      blockId: 'block-1',
      dayOfWeek: 4,
      startTime: '09:05',
      endTime: '10:00',
      minutes: 55,
      recurrence: 'ODD_WEEKS',
      rooms: [],
    });
  });

  it('names each room from the names in the room rows\' order, and an empty name for a room it has none for', () => {
    const view = blockPlacementViewOf(
      'block-1',
      stored('r-1', { rooms: [{ requirementId: 'a', roomId: 'room-1' }, { requirementId: 'b', roomId: 'room-2' }], roomNames: ['Sal 1'] }),
    );
    expect(view.rooms).toEqual([
      { requirementId: 'a', roomId: 'room-1', roomName: 'Sal 1' },
      { requirementId: 'b', roomId: 'room-2', roomName: '' },
    ]);
  });

  it('reads a start as the clock the school says, with no zone: 08:00 and 17:45', () => {
    expect(blockPlacementViewOf('b', stored('r', { startMinutes: 480, minutes: 60 }))).toMatchObject({ startTime: '08:00', endTime: '09:00' });
    expect(blockPlacementViewOf('b', stored('r', { startMinutes: 17 * 60 + 45, minutes: 15 }))).toMatchObject({ startTime: '17:45', endTime: '18:00' });
  });
});

describe('loadBlocksOfYear and loadBlock', () => {
  const time = (value: string): Date => new Date(`1970-01-01T${value}:00.000Z`);

  /** A block as the select reads it. */
  const selected = (over: Record<string, unknown> = {}) => ({
    id: 'block-1',
    name: 'Språkval åk 7',
    academicYearId: YEAR,
    schoolId: SCHOOL,
    sameTimesAsBlockId: null,
    requirements: [member('a'), member('b')],
    placements: [
      {
        id: 'r-1',
        dayOfWeek: 2,
        startTime: time('10:15'),
        minutes: 60,
        recurrence: 'ALL_WEEKS',
        updatedAt: new Date('2026-11-16T08:00:00.000Z'),
        rooms: [
          { requirementId: 'a', roomId: 'room-1', room: { name: 'Sal 1' } },
          { requirementId: 'b', roomId: 'room-2', room: { name: 'Sal 2' } },
        ],
      },
    ],
    ...over,
  });

  describe('loadBlocksOfYear', () => {
    it('reads the year\'s blocks with their members and lessons, one read, in id order', async () => {
      const tx = createTxMock();
      tx['teachingBlock']!['findMany']!.mockResolvedValue([selected()]);
      await loadBlocksOfYear(tx as unknown as PrismaClient, YEAR);
      expect(tx['teachingBlock']!['findMany']).toHaveBeenCalledTimes(1);
      const args = tx['teachingBlock']!['findMany']!.mock.calls[0]![0] as Record<string, any>;
      expect(args.where).toEqual({ academicYearId: YEAR });
      expect(args.orderBy).toEqual({ id: 'asc' });
      expect(args.select.requirements.orderBy).toEqual({ id: 'asc' });
      expect(args.select.placements.orderBy).toEqual([...BLOCK_ROW_ORDER]);
      expect(args.select.placements.orderBy).toEqual([{ dayOfWeek: 'asc' }, { startTime: 'asc' }, { id: 'asc' }]);
      expect(args.select.placements.select.rooms.orderBy).toEqual({ requirementId: 'asc' });
    });

    it('selects everything the judge reads of a member, and the room\'s name', async () => {
      const tx = createTxMock();
      await loadBlocksOfYear(tx as unknown as PrismaClient, YEAR);
      const args = tx['teachingBlock']!['findMany']!.mock.calls[0]![0] as Record<string, any>;
      expect(Object.keys(args.select.requirements.select).sort()).toEqual(
        [
          'blockId', 'coTeacherId', 'endDate', 'id', 'lessonLengths', 'lessonsPerWeek', 'minutesPerLesson',
          'recurrence', 'shares', 'startDate', 'studentGroupId', 'subjectId', 'teacherId',
        ].sort(),
      );
      expect(args.select.requirements.select.shares).toEqual({ select: { teacherId: true, lessons: true, minutes: true } });
      expect(args.select.placements.select.rooms.select).toEqual({ requirementId: true, roomId: true, room: { select: { name: true } } });
      expect(Object.keys(args.select).sort()).toEqual(['id', 'name', 'placements', 'requirements', 'sameTimesAsBlockId']);
    });

    it('asks only for blocks with a lesson when `onlyPlaced`, and leaves the block being written out with `except`', async () => {
      const tx = createTxMock();
      await loadBlocksOfYear(tx as unknown as PrismaClient, YEAR, { onlyPlaced: true });
      expect((tx['teachingBlock']!['findMany']!.mock.calls[0]![0] as { where: unknown }).where).toEqual({ academicYearId: YEAR, placements: { some: {} } });
      await loadBlocksOfYear(tx as unknown as PrismaClient, YEAR, { except: 'block-9' });
      expect((tx['teachingBlock']!['findMany']!.mock.calls[1]![0] as { where: unknown }).where).toEqual({ academicYearId: YEAR, id: { not: 'block-9' } });
      await loadBlocksOfYear(tx as unknown as PrismaClient, YEAR, { onlyPlaced: true, except: 'block-9' });
      expect((tx['teachingBlock']!['findMany']!.mock.calls[2]![0] as { where: unknown }).where).toEqual({
        academicYearId: YEAR,
        placements: { some: {} },
        id: { not: 'block-9' },
      });
      await loadBlocksOfYear(tx as unknown as PrismaClient, YEAR, { onlyPlaced: false });
      expect((tx['teachingBlock']!['findMany']!.mock.calls[3]![0] as { where: unknown }).where).toEqual({ academicYearId: YEAR });
    });

    it('reads a lesson as the school says it: the start as minutes of the clock, the rooms with their names, the last save as changedAt', async () => {
      const tx = createTxMock();
      tx['teachingBlock']!['findMany']!.mockResolvedValue([selected(), selected({ id: 'block-2', name: 'Andra', sameTimesAsBlockId: 'block-1', placements: [] })]);
      const blocks = await loadBlocksOfYear(tx as unknown as PrismaClient, YEAR);
      expect(blocks).toHaveLength(2);
      expect(blocks[0]).toEqual({
        id: 'block-1',
        name: 'Språkval åk 7',
        sameTimesAsBlockId: null,
        members: [expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'b' })],
        rows: [
          {
            id: 'r-1',
            dayOfWeek: 2,
            startMinutes: 10 * 60 + 15,
            minutes: 60,
            recurrence: 'ALL_WEEKS',
            rooms: [
              { requirementId: 'a', roomId: 'room-1' },
              { requirementId: 'b', roomId: 'room-2' },
            ],
            roomNames: ['Sal 1', 'Sal 2'],
            changedAt: new Date('2026-11-16T08:00:00.000Z'),
          },
        ],
      });
      expect(blocks[1]).toMatchObject({ id: 'block-2', sameTimesAsBlockId: 'block-1', rows: [] });
    });

    it('answers no blocks for a year with none', async () => {
      const tx = createTxMock();
      await expect(loadBlocksOfYear(tx as unknown as PrismaClient, YEAR)).resolves.toEqual([]);
    });
  });

  describe('loadBlock', () => {
    it('is null for a block that is not there (row-level security hides another school\'s)', async () => {
      const tx = createTxMock();
      tx['teachingBlock']!['findUnique']!.mockResolvedValue(null);
      await expect(loadBlock(tx as unknown as PrismaClient, 'block-1')).resolves.toBeNull();
      expect(tx['teachingBlock']!['findUnique']).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'block-1' } }));
    });

    it('reads the block with its year and school beside the members and lessons, as loadBlocksOfYear does the rest', async () => {
      const tx = createTxMock();
      tx['teachingBlock']!['findUnique']!.mockResolvedValue(selected());
      const block = await loadBlock(tx as unknown as PrismaClient, 'block-1');
      expect(block).toMatchObject({ id: 'block-1', name: 'Språkval åk 7', academicYearId: YEAR, schoolId: SCHOOL, sameTimesAsBlockId: null });
      expect(block!.rows[0]).toMatchObject({ id: 'r-1', startMinutes: 615, roomNames: ['Sal 1', 'Sal 2'], changedAt: new Date('2026-11-16T08:00:00.000Z') });
      const args = tx['teachingBlock']!['findUnique']!.mock.calls[0]![0] as Record<string, any>;
      expect(args.select.academicYearId).toBe(true);
      expect(args.select.schoolId).toBe(true);
      expect(args.select.placements.orderBy).toEqual([...BLOCK_ROW_ORDER]);
      expect(args.select.requirements.orderBy).toEqual({ id: 'asc' });
    });

    it('reads the rooms of the block\u2019s members only: a room row for a post that has left is no member\u2019s and is read by nobody', async () => {
      const stranger = { requirementId: 'left', roomId: 'room-9', room: { name: 'Sal 9' } };
      const placements = selected().placements.map((row) => ({ ...row, rooms: [stranger, ...row.rooms] }));
      const tx = createTxMock();
      tx['teachingBlock']!['findUnique']!.mockResolvedValue(selected({ placements }));
      tx['teachingBlock']!['findMany']!.mockResolvedValue([selected({ placements })]);

      const one = await loadBlock(tx as unknown as PrismaClient, 'block-1');
      const many = await loadBlocksOfYear(tx as unknown as PrismaClient, YEAR);

      for (const block of [one!, many[0]!]) {
        expect(block.rows[0]!.rooms.map((room) => room.requirementId)).toEqual(['a', 'b']);
        expect(block.rows[0]!.roomNames).toEqual(['Sal 1', 'Sal 2']);
      }
    });

    it('selects the same members and lessons as the year\'s read, so that a verdict is the same wherever it is asked', async () => {
      const tx = createTxMock();
      tx['teachingBlock']!['findUnique']!.mockResolvedValue(null);
      await loadBlock(tx as unknown as PrismaClient, 'block-1');
      await loadBlocksOfYear(tx as unknown as PrismaClient, YEAR);
      const one = tx['teachingBlock']!['findUnique']!.mock.calls[0]![0] as { select: Record<string, unknown> };
      const many = tx['teachingBlock']!['findMany']!.mock.calls[0]![0] as { select: Record<string, unknown> };
      expect(one.select['requirements']).toEqual(many.select['requirements']);
      expect(one.select['placements']).toEqual(many.select['placements']);
    });
  });
});

/*
 * ---------------------------------------------------------------------------------------------------------------------
 * THE CLASH RULE ON A BLOCK'S ROWS
 *
 * The members of a block are different teaching groups, so nothing in one stands in the way of another in the same lesson;
 * a teacher, a room or a pupil two of them share is a real clash, and so is a lesson of the block against another lesson of
 * the same block. judgedRowsOfBlock puts the rows together and judgePlacements judges them in ONE call, with the real clash
 * rule (MasterLessonsService.findConflicts) over a small fake database.
 * ---------------------------------------------------------------------------------------------------------------------
 */

interface FakeWorld {
  /** group id -> name */
  groups: Record<string, string>;
  /** subject id -> name */
  subjects: Record<string, string>;
  /** group id -> its pupils (a teaching group's members) */
  members: Record<string, string[]>;
}

const hhmm = (value: string): Date => new Date(`1970-01-01T${value}:00.000Z`);

/** A transaction that answers the reads the judge and the real clash rule make: no lesson is kept, the groups and pupils are the world's. */
function fakeTx(world: Partial<FakeWorld> = {}): TxMock {
  const w: FakeWorld = { groups: {}, subjects: {}, members: {}, ...world };
  const tx = createTxMock();
  const inList = (clause: unknown): string[] | null => (clause as { in?: string[] } | undefined)?.in ?? null;
  tx['masterLesson']!['findMany']!.mockResolvedValue([]);
  tx['studentGroup']!['findMany']!.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    const ids = inList(where['id']);
    return Object.entries(w.groups)
      .filter(([id]) => ids?.includes(id) ?? false)
      .map(([id, name]) => ({ id, name, halfOfId: null, replacesSubjectId: null, academicYearId: YEAR, kind: 'TEACHING_GROUP' }));
  });
  tx['subject']!['findMany']!.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
    where.id.in.map((id) => ({ id, name: w.subjects[id] ?? id })),
  );
  tx['user']!['findMany']!.mockResolvedValue([]);
  tx['studentGroupMember']!['findMany']!.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
    (inList(where['studentGroupId']) ?? []).flatMap((groupId) => (w.members[groupId] ?? []).map((studentId) => ({ studentId, studentGroupId: groupId }))),
  );
  tx['availabilityConstraint']!['findMany']!.mockResolvedValue([]);
  tx['lunchSetting']!['findFirst']!.mockResolvedValue(null);
  tx['lunchSetting']!['findUnique']!.mockResolvedValue(null);
  return tx;
}

const clock = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** Judges a block's lessons as the service does: the rows of every member in one call, nothing kept, nothing beside. */
async function judgeBlock(tx: TxMock, block: LoadedBlock, rows: readonly BlockSlot[]) {
  const { judged, origins } = judgedRowsOfBlock(block, rows);
  const verdicts = await judgePlacements(tx as unknown as PrismaClient, masters, {
    academicYearId: YEAR,
    schoolId: SCHOOL,
    gradeNumbering: 'NIOARIG',
    basis: CURRENT,
    rows: judged,
    beside: [],
    demand: demandOfBlockMembers([{ block, rows }], () => []),
  });
  return blockVerdictsOf(verdicts, origins);
}

describe('a block\'s lessons judged with the real clash rule', () => {
  const world = (over: Partial<FakeWorld> = {}): FakeWorld => ({
    groups: { 'g-a': 'Spanska 7', 'g-b': 'Tyska 7', 'g-c': 'Franska 7' },
    subjects: { 'sub-a': 'Spanska', 'sub-b': 'Tyska', 'sub-c': 'Franska' },
    members: {},
    ...over,
  });
  const three = (over: Record<string, Partial<BlockMemberPost>> = {}) =>
    loaded([member('a', over['a']), member('b', over['b']), member('c', over['c'])]);
  const verdictsOf = (views: { requirementId: string; ok: boolean; reason?: string }[]) => views.map((view) => [view.requirementId, view.reason ?? 'ok']);

  it('lets the members of a block stand at one time: different groups, teachers and rooms are no clash', async () => {
    const views = await judgeBlock(fakeTx(world()), three(), [slot({ rooms: [{ requirementId: 'a', roomId: 'r1' }, { requirementId: 'b', roomId: 'r2' }] })]);
    expect(verdictsOf(views)).toEqual([['a', 'ok'], ['b', 'ok'], ['c', 'ok']]);
  });

  it('refuses both members that share a teacher, and names the other member\'s class', async () => {
    const views = await judgeBlock(fakeTx(world()), three({ b: { teacherId: 't-a' } }), [slot()]);
    expect(verdictsOf(views)).toEqual([['a', 'TEACHER'], ['b', 'TEACHER'], ['c', 'ok']]);
    expect(views[0]!.params).toEqual({ otherKind: 'PLACEMENT', className: 'Tyska 7', subjectName: 'Tyska', day: 2, start: '10:00', end: '11:00' });
    expect(views[1]!.params).toMatchObject({ className: 'Spanska 7' });
  });

  it('refuses members that share a room in one lesson, and only those', async () => {
    const views = await judgeBlock(fakeTx(world()), three(), [
      slot({ rooms: [{ requirementId: 'a', roomId: 'r1' }, { requirementId: 'b', roomId: 'r1' }, { requirementId: 'c', roomId: 'r2' }] }),
    ]);
    expect(verdictsOf(views)).toEqual([['a', 'ROOM'], ['b', 'ROOM'], ['c', 'ok']]);
  });

  it('does not take two members with no room for sharing one: the engine chooses a room for each', async () => {
    const views = await judgeBlock(fakeTx(world()), three(), [slot()]);
    expect(views.every((view) => view.ok)).toBe(true);
  });

  it('refuses members that share a pupil, as PUPILS', async () => {
    const tx = fakeTx(world({ members: { 'g-a': ['p1', 'p2'], 'g-b': ['p2', 'p3'], 'g-c': ['p4'] } }));
    const views = await judgeBlock(tx, three(), [slot()]);
    expect(verdictsOf(views)).toEqual([['a', 'PUPILS'], ['b', 'PUPILS'], ['c', 'ok']]);
  });

  it('does not let a lesson clash with another lesson of the same block on ANOTHER day, or one that only touches it', async () => {
    const otherDay = await judgeBlock(fakeTx(world()), three(), [slot({ dayOfWeek: 2 }), slot({ dayOfWeek: 3 })]);
    expect(otherDay.every((view) => view.ok)).toBe(true);
    const touching = await judgeBlock(fakeTx(world()), three(), [slot({ startMinutes: 600, minutes: 60 }), slot({ startMinutes: 660, minutes: 60 })]);
    expect(touching.every((view) => view.ok)).toBe(true);
  });

  it('holds a shared teacher to the lesson it is shared in and no other: two members that share one clash at their lesson, not at the block\'s other day', async () => {
    const block = three({ b: { teacherId: 't-a' } });
    const views = await judgeBlock(fakeTx(world()), block, [slot({ dayOfWeek: 2 }), slot({ dayOfWeek: 4 })]);
    // Both lessons put a and b at one time, so both are refused in each lesson, and c in neither.
    expect(views.map((view) => [view.index, view.requirementId, view.ok])).toEqual([
      [0, 'a', false], [0, 'b', false], [0, 'c', true],
      [1, 'a', false], [1, 'b', false], [1, 'c', true],
    ]);
    // And the clash named is the other member's lesson of the same day, never the other day's.
    expect(views.filter((view) => !view.ok).map((view) => view.params?.['day'])).toEqual([2, 2, 4, 4]);
  });

  it('refuses two lessons of the block that overlap on one day: each member is in both', async () => {
    const views = await judgeBlock(fakeTx(world()), three(), [slot({ startMinutes: 600 }), slot({ startMinutes: 630 })]);
    expect(views.filter((view) => !view.ok)).toHaveLength(6);
    expect(views.every((view) => view.ok || view.reason === 'TEACHER')).toBe(true);
    // The index is the lesson's place in the list, and each member has a verdict in each.
    expect(views.map((view) => [view.index, view.requirementId])).toEqual([
      [0, 'a'], [0, 'b'], [0, 'c'], [1, 'a'], [1, 'b'], [1, 'c'],
    ]);
  });

  it('refuses a block with lessons that do not fit it by name on every row, before the week is asked', async () => {
    const tx = fakeTx(world());
    const views = await judgeBlock(tx, three(), [slot({ minutes: 45 })]);
    expect(views.map((view) => [view.requirementId, view.reason, view.params])).toEqual([
      ['a', 'BLOCK_FIT', { rule: 'LENGTH' }],
      ['b', 'BLOCK_FIT', { rule: 'LENGTH' }],
      ['c', 'BLOCK_FIT', { rule: 'LENGTH' }],
    ]);
    expect(tx['studentGroup']!['findMany']).not.toHaveBeenCalled();
  });
});

/*
 * THE PROPERTY: for random blocks of 2 to 4 members with 1 to 3 lessons on different days and times, where some members share
 * a teacher, a room or a pupil, the (lesson, member) pairs the judge refuses are exactly the pairs a naive overlap check on a
 * half-hour grid refuses, with the same first reason (teacher before room before pupils) and a clash named by one of the
 * lessons that give that reason. A lesson on another day never clashes with anything on this one, a shared teacher included
 * (the alongside lesson of the swaps was once read as one day: memory swaps-alongside-is-one-day).
 */

/** mulberry32: a small seeded generator, so a failure names its case and replays. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface PropCase {
  members: BlockMemberPost[];
  rows: BlockSlot[];
  world: FakeWorld;
}

function propCase(random: () => number): PropCase {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const chance = (p: number): boolean => random() < p;
  const count = 2 + Math.floor(random() * 3);
  const ids = ['m1', 'm2', 'm3', 'm4'].slice(0, count);

  const lessonCount = 1 + Math.floor(random() * 3);
  const lessons = Array.from({ length: lessonCount }, () => ({
    dayOfWeek: pick([1, 2, 3]),
    startMinutes: pick([480, 510, 540, 570, 600, 630]),
    minutes: pick([30, 60, 90]),
  }));
  const lengths = lessons.map((lesson) => lesson.minutes).sort((a, b) => b - a);
  const mixed = lengths.some((minutes) => minutes !== lengths[0]);

  const teachers = Object.fromEntries(ids.map((id, at) => [id, chance(0.3) ? `t-${Math.floor(random() * ids.length)}` : `t-${at}`]));
  const pupils: Record<string, string[]> = Object.fromEntries(ids.map((id) => [id, [`p-${id}`]]));
  for (const id of ids) if (chance(0.2)) pupils[id]!.push(`p-${pick(ids.filter((other) => other !== id))}`);

  const members = ids.map((id) =>
    member(id, {
      teacherId: teachers[id]!,
      lessonsPerWeek: lengths.length,
      minutesPerLesson: lengths[0]!,
      lessonLengths: mixed ? lengths : [],
    }),
  );
  const rows: BlockSlot[] = lessons.map((lesson) => ({
    ...lesson,
    recurrence: 'ALL_WEEKS' as const,
    rooms: ids.flatMap((id) => (chance(0.55) ? [{ requirementId: id, roomId: pick(['r1', 'r2', 'r3']) }] : [])),
  }));
  const world: FakeWorld = {
    groups: Object.fromEntries(ids.map((id) => [`g-${id}`, `Grupp ${id}`])),
    subjects: Object.fromEntries(ids.map((id) => [`sub-${id}`, `Ämne ${id}`])),
    members: Object.fromEntries(ids.map((id) => [`g-${id}`, pupils[id]!])),
  };
  // Members in any order: the judge reads them by id.
  for (let at = members.length - 1; at > 0; at--) {
    const swap = Math.floor(random() * (at + 1));
    [members[at], members[swap]] = [members[swap]!, members[at]!];
  }
  return { members, rows, world };
}

/** The naive answer: (lesson, member) -> the best reason and the lessons it can be named by. Absent when nothing clashes. */
function naive(one: PropCase): Map<string, { reason: 'TEACHER' | 'ROOM' | 'PUPILS'; others: { index: number; requirementId: string }[] }> {
  const rank = { TEACHER: 0, ROOM: 1, PUPILS: 2 } as const;
  const roomOf = (lesson: BlockSlot, id: string): string | null => lesson.rooms.find((room) => room.requirementId === id)?.roomId ?? null;
  const memberById = new Map(one.members.map((one2) => [one2.id, one2]));
  const pupilsOf = (id: string): string[] => one.world.members[`g-${id}`] ?? [];
  const answer = new Map<string, { reason: 'TEACHER' | 'ROOM' | 'PUPILS'; others: { index: number; requirementId: string }[] }>();
  for (const [i, mine] of one.rows.entries()) {
    for (const m of one.members) {
      const found: { reason: 'TEACHER' | 'ROOM' | 'PUPILS'; index: number; requirementId: string }[] = [];
      for (const [j, theirs] of one.rows.entries()) {
        // Two lessons clash only on one day, where their minutes overlap.
        if (theirs.dayOfWeek !== mine.dayOfWeek) continue;
        if (!(mine.startMinutes < theirs.startMinutes + theirs.minutes && theirs.startMinutes < mine.startMinutes + mine.minutes)) continue;
        for (const n of one.members) {
          if (i === j && m.id === n.id) continue;
          if (memberById.get(m.id)!.teacherId === memberById.get(n.id)!.teacherId) found.push({ reason: 'TEACHER', index: j, requirementId: n.id });
          const room = roomOf(mine, m.id);
          if (room !== null && room === roomOf(theirs, n.id)) found.push({ reason: 'ROOM', index: j, requirementId: n.id });
          // The same group is the same pupils too, but the group's own clash is the teacher's here (one member, one teacher).
          if (m.id !== n.id && pupilsOf(m.id).some((pupil) => pupilsOf(n.id).includes(pupil))) {
            found.push({ reason: 'PUPILS', index: j, requirementId: n.id });
          }
        }
      }
      if (found.length === 0) continue;
      const best = found.reduce((low, hit) => (rank[hit.reason] < rank[low] ? hit.reason : low), found[0]!.reason);
      answer.set(`${i}|${m.id}`, {
        reason: best,
        others: found.filter((hit) => hit.reason === best).map(({ index, requirementId }) => ({ index, requirementId })),
      });
    }
  }
  return answer;
}

describe('a block\'s lessons against a naive overlap check (property)', () => {
  const CASES = 250;
  const cases = (() => {
    const random = seeded(20261117);
    return Array.from({ length: CASES }, () => propCase(random));
  })();

  it('refuses exactly the (lesson, member) pairs that share a teacher, a room or a pupil with another pair on the same day and time', async () => {
    const failures: string[] = [];
    let refused = 0;
    let held = 0;
    for (const [at, one] of cases.entries()) {
      const block = loaded(one.members);
      const views = await judgeBlock(fakeTx(one.world), block, one.rows);
      const expected = naive(one);
      const sorted = [...one.members].sort((a, b) => (a.id < b.id ? -1 : 1));
      const asked = one.rows.flatMap((_, index) => sorted.map((m) => ({ index, requirementId: m.id })));
      if (views.length !== asked.length) {
        failures.push(`case ${at}: ${views.length} verdicts for ${asked.length} rows`);
        continue;
      }
      views.forEach((view, place) => {
        const key = `${view.index}|${view.requirementId}`;
        if (view.index !== asked[place]!.index || view.requirementId !== asked[place]!.requirementId) {
          failures.push(`case ${at}: verdict ${place} is for ${key}`);
          return;
        }
        const want = expected.get(key);
        if (want === undefined) {
          held++;
          if (!view.ok) failures.push(`case ${at}: ${key} was refused (${view.reason}) with no clash`);
          return;
        }
        refused++;
        if (view.ok || view.reason !== want.reason) {
          failures.push(`case ${at}: ${key} should be ${want.reason}, was ${view.ok ? 'ok' : view.reason}`);
          return;
        }
        const named = want.others.map((other) => {
          const lesson = one.rows[other.index]!;
          const group = one.world.groups[`g-${other.requirementId}`];
          return JSON.stringify({ className: group, subjectName: one.world.subjects[`sub-${other.requirementId}`], day: lesson.dayOfWeek, start: clock(lesson.startMinutes), end: clock(lesson.startMinutes + lesson.minutes) });
        });
        const got = view.params === undefined ? '' : JSON.stringify({ className: view.params['className'], subjectName: view.params['subjectName'], day: view.params['day'], start: view.params['start'], end: view.params['end'] });
        if (view.params?.['otherKind'] !== 'PLACEMENT' || !named.includes(got)) {
          failures.push(`case ${at}: ${key} names ${got}, which none of ${named.join(' ')} is`);
        }
      });
    }
    expect(failures).toEqual([]);
    // Not vacuous: a good many pairs held and a good many refused.
    expect(refused).toBeGreaterThan(300);
    expect(held).toBeGreaterThan(300);
  });

  it('never lets a lesson on another day clash: moving every lesson to its own day leaves nothing refused', async () => {
    for (const one of cases.slice(0, 120)) {
      const apart = one.rows.map((row, at) => ({ ...row, dayOfWeek: (at % 5) + 1 }));
      if (apart.length > 5) continue;
      const views = await judgeBlock(fakeTx(one.world), loaded(one.members), apart);
      // Within a lesson the members may still clash with each other; across lessons they never do.
      const failures = views.filter((view) => !view.ok);
      const expected = naive({ ...one, rows: apart });
      expect(failures.map((view) => `${view.index}|${view.requirementId}`).sort()).toEqual([...expected.keys()].sort());
      for (const view of failures) {
        const want = expected.get(`${view.index}|${view.requirementId}`)!;
        expect(want.others.every((other) => other.index === view.index)).toBe(true);
      }
    }
  });
});
