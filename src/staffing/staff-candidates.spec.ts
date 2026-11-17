import type { PrismaClient } from '@prisma/client';
import { readActiveStaff } from './staff-candidates';

/*
 * Who the staffing proposal and the per-row picker may OFFER a post: the school's active staff
 * (staffIds, who can lead one) less the administrators without Users.teaches (candidateIds).
 * The fake answers only the columns the query selects, as the database does, so a select that
 * leaves the mark out shows here as a marked administrator who is no candidate.
 */
interface UserRow {
  id: string;
  role: 'TEACHER' | 'SCHOOL_ADMIN';
  teaches: boolean;
}

const YEAR = 'year-1';

const ROWS: UserRow[] = [
  { id: 'a-teacher', role: 'TEACHER', teaches: false },
  { id: 'b-marked-admin', role: 'SCHOOL_ADMIN', teaches: true },
  { id: 'c-plain-admin', role: 'SCHOOL_ADMIN', teaches: false },
  { id: 'd-other-teacher', role: 'TEACHER', teaches: false },
];

function fakeDatabase(rows: UserRow[]) {
  const findMany = jest.fn(async ({ select }: { select: Record<string, true> }) =>
    rows.map((row) => Object.fromEntries(Object.keys(select).map((column) => [column, row[column as keyof UserRow]]))),
  );
  return { findMany, tx: { user: { findMany } } as unknown as PrismaClient };
}

describe('readActiveStaff', () => {
  it('keeps every administrator in staffIds, so a post she leads is not vacated, and offers posts to teachers and the marked', async () => {
    const { tx } = fakeDatabase(ROWS);
    expect(await readActiveStaff(tx, YEAR)).toEqual({
      staffIds: ['a-teacher', 'b-marked-admin', 'c-plain-admin', 'd-other-teacher'],
      candidateIds: ['a-teacher', 'b-marked-admin', 'd-other-teacher'],
    });
  });

  it('asks the database for the mark, in id order, of the active staff less a timvikarie', async () => {
    const { tx, findMany } = fakeDatabase(ROWS);
    await readActiveStaff(tx, YEAR);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        role: { in: ['TEACHER', 'SCHOOL_ADMIN'] },
        isActive: true,
        NOT: { substitutePoolMemberships: { some: {} }, employments: { none: { academicYearId: YEAR } } },
      },
      select: { id: true, role: true, teaches: true },
      orderBy: { id: 'asc' },
    });
  });

  it('offers nobody a post at a school whose only staff are administrators who do not teach, and still lists them as staff', async () => {
    const { tx } = fakeDatabase([ROWS[2]!]);
    expect(await readActiveStaff(tx, YEAR)).toEqual({ staffIds: ['c-plain-admin'], candidateIds: [] });
  });
});
