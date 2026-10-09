import type { PrismaClient } from '@prisma/client';
import {
  foldLastYearTeachers,
  lastYearKey,
  readLastYearTeachers,
  readLastYearTeachersOf,
} from './last-year-teachers';

const G6A = '6a000000-0000-4000-8000-000000000001';
const G6B = '6b000000-0000-4000-8000-000000000002';
const MA = 'aa000000-0000-4000-8000-0000000000aa';
const SV = 'bb000000-0000-4000-8000-0000000000bb';
const ANNA = 'a0000000-0000-4000-8000-00000000000a';
const BO = 'b0000000-0000-4000-8000-00000000000b';
const CY = 'c0000000-0000-4000-8000-00000000000c';

/** Last year's rows, as the table holds them (id order is the read's order). */
const ROWS = [
  { id: '01', studentGroupId: G6A, subjectId: MA, teacherId: BO, coTeacherId: null, group: '6A' },
  { id: '02', studentGroupId: G6A, subjectId: MA, teacherId: null, coTeacherId: ANNA, group: '6A' },
  { id: '03', studentGroupId: G6A, subjectId: SV, teacherId: CY, coTeacherId: null, group: '6A' },
  { id: '04', studentGroupId: G6B, subjectId: MA, teacherId: ANNA, coTeacherId: ANNA, group: '6B' },
  { id: '05', studentGroupId: G6B, subjectId: SV, teacherId: null, coTeacherId: null, group: '6B' },
].map((row) => ({ ...row, studentGroup: { name: row.group, academicYear: { name: '2025/26' } } }));

/** A tx whose findMany answers the two shapes the readers send, from ROWS. */
function txOver() {
  const findMany = jest.fn((args: { where: { studentGroupId: string | { in: string[] }; subjectId?: string } }) => {
    const groups =
      typeof args.where.studentGroupId === 'string' ? [args.where.studentGroupId] : args.where.studentGroupId.in;
    return Promise.resolve(
      ROWS.filter(
        (row) => groups.includes(row.studentGroupId) && (args.where.subjectId === undefined || row.subjectId === args.where.subjectId),
      ),
    );
  });
  return { tx: { teachingRequirement: { findMany } } as unknown as PrismaClient, findMany };
}

describe('last year’s teachers', () => {
  it('folds lead and co-teacher over every row, sorted, with the first row’s names; null for none', () => {
    expect(foldLastYearTeachers(ROWS.slice(0, 2))).toEqual({
      groupName: '6A',
      yearName: '2025/26',
      teacherIds: [ANNA, BO],
    });
    expect(foldLastYearTeachers([])).toBeNull();
    // An unstaffed row adds nobody.
    expect(foldLastYearTeachers([ROWS[4]!])).toEqual({ groupName: '6B', yearName: '2025/26', teacherIds: [] });
  });

  it('answers every key in one statement exactly as the per-row read answers it', async () => {
    const keys = [
      { predecessorId: G6A, subjectId: MA },
      { predecessorId: G6A, subjectId: SV },
      { predecessorId: G6B, subjectId: MA },
      { predecessorId: G6B, subjectId: SV },
      // A subject the group did not read last year.
      { predecessorId: G6B, subjectId: 'cc000000-0000-4000-8000-0000000000cc' },
    ];
    const batched = txOver();
    const all = await readLastYearTeachers(batched.tx, keys);
    expect(batched.findMany).toHaveBeenCalledTimes(1);
    expect(batched.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { studentGroupId: { in: [G6A, G6B] } }, orderBy: { id: 'asc' } }),
    );

    for (const key of keys) {
      const single = txOver();
      const one = await readLastYearTeachersOf(single.tx, key.predecessorId, key.subjectId);
      expect(all.get(lastYearKey(key.predecessorId, key.subjectId)) ?? null).toEqual(one);
    }
  });

  it('asks nothing when no row has a predecessor', async () => {
    const { tx, findMany } = txOver();
    await expect(readLastYearTeachers(tx, [])).resolves.toEqual(new Map());
    expect(findMany).not.toHaveBeenCalled();
  });

  it('leaves a key it was not asked about out, although the group’s rows were read', async () => {
    const { tx } = txOver();
    const answer = await readLastYearTeachers(tx, [{ predecessorId: G6A, subjectId: MA }]);
    expect([...answer.keys()]).toEqual([lastYearKey(G6A, MA)]);
  });
});
