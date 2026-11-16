import { boardBlockOf } from './block-placement-board';
import {
  blockRowsKeyOf,
  judgedRowsOfBlock,
  type BlockMemberPost,
  type BlockRowOrigin,
  type LoadedBlock,
  type StoredBlockRow,
} from './block-placement-judge';
import type { PlacementVerdict } from './placement-judge';

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

const stored = (id: string, over: Partial<StoredBlockRow> = {}): StoredBlockRow => ({
  id,
  dayOfWeek: 2,
  startMinutes: 600,
  minutes: 60,
  recurrence: 'ALL_WEEKS',
  rooms: [],
  roomNames: [],
  changedAt: new Date('2026-11-16T08:00:00.000Z'),
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

/** The origins judgedRowsOfBlock gives for the block's own rows, and an all-clear verdict for each. */
const askedOf = (block: LoadedBlock): { origins: BlockRowOrigin[]; clear: PlacementVerdict[] } => {
  const { origins } = judgedRowsOfBlock(block, block.rows);
  return { origins, clear: origins.map((_, index) => ({ index, ok: true })) };
};

describe('boardBlockOf', () => {
  it('states the block: its name, its members in id order, its lengths, its weeks and what it follows', () => {
    const block = loaded([member('a'), member('b')], [], { name: 'Språkval åk 8', id: 'block-9' });
    expect(boardBlockOf(block, [], [])).toEqual({
      id: 'block-9',
      name: 'Språkval åk 8',
      memberIds: ['a', 'b'],
      lengths: [60, 60],
      recurrence: 'ALL_WEEKS',
      followsBlockId: null,
      cannotPlace: null,
      rows: [],
      rowsKey: blockRowsKeyOf([]),
    });
  });

  it('says the lengths longest first, one per lesson, and the weeks of the members', () => {
    const split = loaded([member('a', { lessonsPerWeek: 3, minutesPerLesson: 80, lessonLengths: [80, 40, 40], recurrence: 'ODD_WEEKS' })]);
    const view = boardBlockOf(split, [], []);
    expect(view.lengths).toEqual([80, 40, 40]);
    expect(view.recurrence).toBe('ODD_WEEKS');
  });

  it('reads the lengths and the weeks from the member with the lowest id', () => {
    const block = loaded([member('a', { minutesPerLesson: 45, lessonsPerWeek: 1, recurrence: 'EVEN_WEEKS' }), member('b')]);
    const view = boardBlockOf(block, [], []);
    expect(view.lengths).toEqual([45]);
    expect(view.recurrence).toBe('EVEN_WEEKS');
  });

  describe('cannotPlace', () => {
    const shared = member('a', { shares: [{ teacherId: 'bo', lessons: 1, minutes: 60 }] });

    it('is null for a block that can be placed', () => {
      expect(boardBlockOf(loaded([member('a')]), [], []).cannotPlace).toBeNull();
    });

    it('is FOLLOWER for a block that follows another, and the block it follows is named', () => {
      const view = boardBlockOf(loaded([member('a')], [], { sameTimesAsBlockId: 'leader' }), [], []);
      expect(view.cannotPlace).toBe('FOLLOWER');
      expect(view.followsBlockId).toBe('leader');
    });

    it('is EMPTY for a block with no member, which has no lengths and no weeks', () => {
      const view = boardBlockOf(loaded([]), [], []);
      expect(view).toMatchObject({ cannotPlace: 'EMPTY', memberIds: [], lengths: [], recurrence: null });
    });

    it('is SHARES when any member shares its lessons between teachers, not only the first', () => {
      expect(boardBlockOf(loaded([shared]), [], []).cannotPlace).toBe('SHARES');
      expect(boardBlockOf(loaded([member('a'), { ...shared, id: 'b' }]), [], []).cannotPlace).toBe('SHARES');
    });

    it('reads an absent, a null and an empty list of shares as none', () => {
      const bare = member('a');
      delete (bare as { shares?: unknown }).shares;
      expect(boardBlockOf(loaded([bare]), [], []).cannotPlace).toBeNull();
      expect(boardBlockOf(loaded([member('a', { shares: null })]), [], []).cannotPlace).toBeNull();
      expect(boardBlockOf(loaded([member('a', { shares: [] })]), [], []).cannotPlace).toBeNull();
    });

    it('goes FOLLOWER, then EMPTY, then SHARES, as the rules do', () => {
      expect(boardBlockOf(loaded([shared], [], { sameTimesAsBlockId: 'leader' }), [], []).cannotPlace).toBe('FOLLOWER');
      expect(boardBlockOf(loaded([], [], { sameTimesAsBlockId: 'leader' }), [], []).cannotPlace).toBe('FOLLOWER');
      expect(boardBlockOf(loaded([]), [], []).cannotPlace).toBe('EMPTY');
      expect(boardBlockOf(loaded([shared]), [], []).cannotPlace).toBe('SHARES');
    });

    it('does not stop a block from showing the lessons it already holds', () => {
      const block = loaded([member('a')], [stored('r-1')], { sameTimesAsBlockId: 'leader' });
      const { origins, clear } = askedOf(block);
      expect(boardBlockOf(block, clear, origins).rows).toHaveLength(1);
    });
  });

  describe('the lessons', () => {
    it('states each with its clock as HH:MM, its end, its weeks, the time of its last save and its rooms with their names', () => {
      const block = loaded(
        [member('a'), member('b')],
        [
          stored('r-1', {
            dayOfWeek: 3,
            startMinutes: 8 * 60 + 5,
            minutes: 55,
            recurrence: 'ALL_WEEKS',
            rooms: [{ requirementId: 'b', roomId: 'room-b' }],
            roomNames: ['Sal B'],
            changedAt: new Date('2026-11-16T10:30:00.000Z'),
          }),
        ],
      );
      const { origins, clear } = askedOf(block);
      expect(boardBlockOf(block, clear, origins).rows).toEqual([
        {
          id: 'r-1',
          dayOfWeek: 3,
          startTime: '08:05',
          endTime: '09:00',
          minutes: 55,
          recurrence: 'ALL_WEEKS',
          rooms: [{ requirementId: 'b', roomId: 'room-b', roomName: 'Sal B' }],
          changedAt: '2026-11-16T10:30:00.000Z',
          verdicts: [
            { requirementId: 'a', ok: true },
            { requirementId: 'b', ok: true },
          ],
        },
      ]);
    });

    it('names a room whose name is missing with an empty name, not undefined', () => {
      const block = loaded([member('a')], [stored('r-1', { rooms: [{ requirementId: 'a', roomId: 'room-a' }], roomNames: [] })]);
      const { origins, clear } = askedOf(block);
      expect(boardBlockOf(block, clear, origins).rows[0]!.rooms).toEqual([{ requirementId: 'a', roomId: 'room-a', roomName: '' }]);
    });

    it('keeps the lessons in the order they are given, which is the order the reader sorted them in', () => {
      const block = loaded([member('a')], [stored('r-1', { dayOfWeek: 1 }), stored('r-2', { dayOfWeek: 3 }), stored('r-3', { dayOfWeek: 5 })]);
      const { origins, clear } = askedOf(block);
      expect(boardBlockOf(block, clear, origins).rows.map((row) => row.id)).toEqual(['r-1', 'r-2', 'r-3']);
    });

    it('puts a member\'s verdict on the lesson it was asked for, in the members\' order, and the reason and the figures only where it does not hold', () => {
      const block = loaded([member('a'), member('b'), member('c')], [stored('r-1'), stored('r-2', { dayOfWeek: 4 })]);
      const { origins } = askedOf(block);
      expect(origins.map((origin) => `${origin.index}${origin.requirementId}`)).toEqual(['0a', '0b', '0c', '1a', '1b', '1c']);
      const verdicts: PlacementVerdict[] = [
        { index: 0, ok: true },
        { index: 1, ok: false, reason: 'TEACHER', params: { otherKind: 'PLACEMENT', className: 'Tyska 7', day: 2 } },
        { index: 2, ok: true },
        { index: 3, ok: false, reason: 'LUNCH' },
        { index: 4, ok: true },
        { index: 5, ok: false, reason: 'AVAILABILITY', params: { resource: 'ROOM' } },
      ];
      const rows = boardBlockOf(block, verdicts, origins).rows;
      expect(rows[0]!.verdicts).toEqual([
        { requirementId: 'a', ok: true },
        { requirementId: 'b', ok: false, reason: 'TEACHER', params: { otherKind: 'PLACEMENT', className: 'Tyska 7', day: 2 } },
        { requirementId: 'c', ok: true },
      ]);
      expect(rows[1]!.verdicts).toEqual([
        { requirementId: 'a', ok: false, reason: 'LUNCH' },
        { requirementId: 'b', ok: true },
        { requirementId: 'c', ok: false, reason: 'AVAILABILITY', params: { resource: 'ROOM' } },
      ]);
      expect(Object.keys(rows[1]!.verdicts[1]!).sort()).toEqual(['ok', 'requirementId']);
    });

    it('reads a verdict that is missing as holding, and gives a lesson with no origin no verdict', () => {
      const block = loaded([member('a'), member('b')], [stored('r-1'), stored('r-2', { dayOfWeek: 4 })]);
      const { origins } = askedOf(block);
      const view = boardBlockOf(block, [{ index: 0, ok: false, reason: 'ROOM' }], origins.slice(0, 2));
      expect(view.rows[0]!.verdicts).toEqual([
        { requirementId: 'a', ok: false, reason: 'ROOM' },
        { requirementId: 'b', ok: true },
      ]);
      expect(view.rows[1]!.verdicts).toEqual([]);
    });

    it('carries the judge\'s BLOCK_FIT and its rule to every member of every lesson when the lessons do not fit', () => {
      const block = loaded([member('a'), member('b')], [stored('r-1', { minutes: 45 })]);
      const { origins } = askedOf(block);
      const verdicts: PlacementVerdict[] = origins.map((_, index) => ({ index, ok: false, reason: 'BLOCK_FIT', params: { rule: 'LENGTH' } }));
      expect(boardBlockOf(block, verdicts, origins).rows[0]!.verdicts).toEqual([
        { requirementId: 'a', ok: false, reason: 'BLOCK_FIT', params: { rule: 'LENGTH' } },
        { requirementId: 'b', ok: false, reason: 'BLOCK_FIT', params: { rule: 'LENGTH' } },
      ]);
    });
  });

  describe('rowsKey', () => {
    it('is blockRowsKeyOf of the block\'s lessons: what a save carries as baseKey', () => {
      const rows = [stored('r-1'), stored('r-2', { dayOfWeek: 4, rooms: [{ requirementId: 'a', roomId: 'room-a' }], roomNames: ['Sal A'] })];
      const block = loaded([member('a')], rows);
      const { origins, clear } = askedOf(block);
      const key = boardBlockOf(block, clear, origins).rowsKey;
      expect(key).toBe(blockRowsKeyOf(rows));
      expect(key).toMatch(/^[0-9a-f]{32}$/);
    });

    it('changes with a lesson that moves, and not with a verdict', () => {
      const first = loaded([member('a')], [stored('r-1')]);
      const moved = loaded([member('a')], [stored('r-1', { startMinutes: 615 })]);
      const { origins, clear } = askedOf(first);
      expect(boardBlockOf(first, clear, origins).rowsKey).not.toBe(boardBlockOf(moved, clear, origins).rowsKey);
      const refused: PlacementVerdict[] = [{ index: 0, ok: false, reason: 'ROOM' }];
      expect(boardBlockOf(first, refused, origins).rowsKey).toBe(boardBlockOf(first, clear, origins).rowsKey);
    });
  });
});
