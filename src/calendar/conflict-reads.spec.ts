import { ConflictReads } from './conflict-reads';

type Row = Record<string, unknown>;

/** A transaction whose tables answer `where ... in` the way the database does, counting the statements. */
function fakeTx(tables: { groups?: Row[]; users?: Row[]; members?: Row[] }) {
  const groups = tables.groups ?? [];
  const users = tables.users ?? [];
  const members = tables.members ?? [];
  const inList = (clause: unknown): string[] | null => {
    const list = (clause as { in?: string[] } | undefined)?.in;
    return list ?? null;
  };
  const tx = {
    studentGroup: {
      findMany: jest.fn(async ({ where }: { where: Row }) =>
        groups.filter((g) => {
          if (where['id']) return inList(where['id'])!.includes(g['id'] as string);
          if (where['halfOfId']) return inList(where['halfOfId'])!.includes(g['halfOfId'] as string);
          if (where['replacesSubjectId']) return inList(where['replacesSubjectId'])!.includes(g['replacesSubjectId'] as string) && g['academicYearId'] === where['academicYearId'];
          return false;
        }),
      ),
    },
    user: { findMany: jest.fn(async ({ where }: { where: Row }) => users.filter((u) => inList(where['studentGroupId'])!.includes(u['studentGroupId'] as string))) },
    studentGroupMember: { findMany: jest.fn(async ({ where }: { where: Row }) => members.filter((m) => inList(where['studentGroupId'])!.includes(m['studentGroupId'] as string))) },
  };
  return tx;
}

const group = (id: string, over: Row = {}) => ({ id, halfOfId: null, replacesSubjectId: null, academicYearId: 'y1', kind: 'CLASS', ...over });

describe('ConflictReads', () => {
  describe('once', () => {
    it('answers a read once for its key, however many ask', async () => {
      const reads = new ConflictReads();
      const load = jest.fn(async () => ['a']);
      expect(await Promise.all([reads.once('k', load), reads.once('k', load), reads.once('k', load)])).toEqual([['a'], ['a'], ['a']]);
      expect(load).toHaveBeenCalledTimes(1);
      await reads.once('other', load);
      expect(load).toHaveBeenCalledTimes(2);
    });

    it('does not keep a read that failed: the next ask reads again', async () => {
      const reads = new ConflictReads();
      const load = jest.fn().mockRejectedValueOnce(new Error('gone')).mockResolvedValueOnce('ok');
      await expect(reads.once('k', load)).rejects.toThrow('gone');
      // The forgetting is a microtask behind the rejection.
      await Promise.resolve();
      await expect(reads.once('k', load)).resolves.toBe('ok');
      expect(load).toHaveBeenCalledTimes(2);
    });
  });

  describe('groupsInPlay', () => {
    const groups = [
      group('c1'),
      group('c2'),
      group('h1', { halfOfId: 'c1', kind: 'TEACHING_GROUP' }),
      group('h2', { halfOfId: 'c1', kind: 'TEACHING_GROUP' }),
      group('sva', { replacesSubjectId: 's-sv', kind: 'TEACHING_GROUP' }),
      group('old-sva', { replacesSubjectId: 's-sv', academicYearId: 'y0', kind: 'TEACHING_GROUP' }),
    ];
    const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();

    it('returns what the first statement of the roster read returns: the asked, their halves, the year’s replacing groups', async () => {
      const tx = fakeTx({ groups });
      const reads = new ConflictReads();
      const got = await reads.groupsInPlay(tx as never, ['c1', 'c2'], { subjectIds: ['s-sv'], academicYearId: 'y1' });
      expect(ids(got)).toEqual(['c1', 'c2', 'h1', 'h2', 'sva']);
    });

    it('asks the database only for what it has not been asked before, and gives the union', async () => {
      const tx = fakeTx({ groups });
      const reads = new ConflictReads();
      await reads.groupsInPlay(tx as never, ['c1'], null);
      const statementsAfterFirst = tx.studentGroup.findMany.mock.calls.length;
      const again = await reads.groupsInPlay(tx as never, ['c1'], null);
      expect(tx.studentGroup.findMany.mock.calls.length).toBe(statementsAfterFirst);
      expect(ids(again)).toEqual(['c1', 'h1', 'h2']);
      const more = await reads.groupsInPlay(tx as never, ['c1', 'c2'], null);
      expect(ids(more)).toEqual(['c1', 'c2', 'h1', 'h2']);
      // c2 was new: one statement for the groups, one for its halves.
      expect(tx.studentGroup.findMany.mock.calls.length).toBe(statementsAfterFirst + 2);
    });

    it('does not find a group that is not there, and does not ask for it twice', async () => {
      const tx = fakeTx({ groups });
      const reads = new ConflictReads();
      expect(ids(await reads.groupsInPlay(tx as never, ['nope'], null))).toEqual([]);
      const after = tx.studentGroup.findMany.mock.calls.length;
      expect(ids(await reads.groupsInPlay(tx as never, ['nope'], null))).toEqual([]);
      expect(tx.studentGroup.findMany.mock.calls.length).toBe(after);
    });

    it('keeps the replacing groups of a year apart from another year’s, and a subject asked about once', async () => {
      const tx = fakeTx({ groups });
      const reads = new ConflictReads();
      const y1 = await reads.groupsInPlay(tx as never, [], { subjectIds: ['s-sv'], academicYearId: 'y1' });
      expect(ids(y1)).toEqual(['sva']);
      const y0 = await reads.groupsInPlay(tx as never, [], { subjectIds: ['s-sv'], academicYearId: 'y0' });
      expect(ids(y0)).toEqual(['old-sva']);
      const calls = tx.studentGroup.findMany.mock.calls.length;
      await reads.groupsInPlay(tx as never, [], { subjectIds: ['s-sv'], academicYearId: 'y1' });
      expect(tx.studentGroup.findMany.mock.calls.length).toBe(calls);
    });

    it('asks nothing of the replacing arm when no subject is named', async () => {
      const tx = fakeTx({ groups });
      const reads = new ConflictReads();
      expect(ids(await reads.groupsInPlay(tx as never, [], { subjectIds: [], academicYearId: 'y1' }))).toEqual([]);
      expect(tx.studentGroup.findMany).not.toHaveBeenCalled();
    });
  });

  describe('halvesOfClasses', () => {
    it('gives the halves of each class asked about, from one statement for the classes not yet seen', async () => {
      const tx = fakeTx({ groups: [group('c1'), group('h1', { halfOfId: 'c1' }), group('c2'), group('h2', { halfOfId: 'c2' })] });
      const reads = new ConflictReads();
      expect((await reads.halvesOfClasses(tx as never, ['c1', 'c2'])).map((g) => g.id).sort()).toEqual(['h1', 'h2']);
      expect(tx.studentGroup.findMany).toHaveBeenCalledTimes(1);
      expect((await reads.halvesOfClasses(tx as never, ['c2'])).map((g) => g.id)).toEqual(['h2']);
      expect(tx.studentGroup.findMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('pupilsOf', () => {
    const users = [
      { id: 'p1', studentGroupId: 'c1' },
      { id: 'p2', studentGroupId: 'c1' },
      { id: 'p3', studentGroupId: 'c2' },
    ];
    const members = [
      { studentId: 'p1', studentGroupId: 'g1' },
      { studentId: 'p3', studentGroupId: 'g1' },
    ];
    const current = { kind: 'CURRENT' } as never;

    it('gives both sides of the roster of the groups asked, and reads each group once', async () => {
      const tx = fakeTx({ users, members });
      const reads = new ConflictReads();
      const first = await reads.pupilsOf(tx as never, current, ['c1', 'g1']);
      expect(first.home.map((r) => [r.id, r.studentGroupId])).toEqual([['p1', 'c1'], ['p2', 'c1']]);
      expect(first.teaching.map((r) => [r.studentId, r.studentGroupId])).toEqual([['p1', 'g1'], ['p3', 'g1']]);
      const second = await reads.pupilsOf(tx as never, current, ['c1', 'c2']);
      expect(second.home.map((r) => r.id)).toEqual(['p1', 'p2', 'p3']);
      // c2 is the only new group: one more pair of statements, and none for c1.
      expect(tx.user.findMany).toHaveBeenCalledTimes(2);
      expect((tx.user.findMany.mock.calls[1]![0] as { where: { studentGroupId: { in: string[] } } }).where.studentGroupId.in).toEqual(['c2']);
      await reads.pupilsOf(tx as never, current, ['c1']);
      expect(tx.user.findMany).toHaveBeenCalledTimes(2);
    });

    it('reads a projected basis class by class, and what it leaves in each class is what is kept', async () => {
      const tx = fakeTx({ users, members: [] });
      const reads = new ConflictReads();
      // p2 moves to c3 next year; p9, who is in no class now, joins c1.
      const projected = { kind: 'PROJECTED', homeOf: new Map([['p2', 'c3'], ['p9', 'c1']]) } as never;
      const next = await reads.pupilsOf(tx as never, projected, ['c1', 'c3']);
      expect(next.home.map((r) => [r.id, r.studentGroupId])).toEqual([['p1', 'c1'], ['p9', 'c1'], ['p2', 'c3']]);
      // The classes read one at a time add up to the classes read together.
      const one = new ConflictReads();
      const parts = [...(await one.pupilsOf(tx as never, projected, ['c1'])).home, ...(await one.pupilsOf(tx as never, projected, ['c3'])).home];
      expect(parts.map((r) => [r.id, r.studentGroupId])).toEqual(next.home.map((r) => [r.id, r.studentGroupId]));
      // A class asked again is not asked of the database again.
      const statements = tx.user.findMany.mock.calls.length;
      await reads.pupilsOf(tx as never, projected, ['c1']);
      expect(tx.user.findMany.mock.calls.length).toBe(statements);
    });

    it('gives nothing for a group nobody is in', async () => {
      const tx = fakeTx({});
      expect(await new ConflictReads().pupilsOf(tx as never, current, ['empty'])).toEqual({ home: [], teaching: [] });
    });
  });
});
