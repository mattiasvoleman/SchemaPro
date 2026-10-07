import { ConflictException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { ROLLOVER_NOT_ACTIVATED, refuseRostersNotActivated } from './rosters-current';

/** A (active) → B (rolled, not activated) → C (rolled from B), and a year of its own. */
function txWith(pupilsInChain: (yearIds: string[]) => number) {
  const years = [
    { id: 'A', name: '2026/27', isActive: true, predecessorId: null },
    { id: 'B', name: '2027/28', isActive: false, predecessorId: 'A' },
    { id: 'C', name: '2028/29', isActive: false, predecessorId: 'B' },
    { id: 'S', name: 'Sommarskola', isActive: false, predecessorId: null },
  ];
  const count = jest.fn(({ where }: { where: { role: string; isActive: boolean; studentGroup: { academicYearId: { in: string[] } } } }) => {
    expect(where).toMatchObject({ role: 'STUDENT', isActive: true });
    return Promise.resolve(pupilsInChain(where.studentGroup.academicYearId.in));
  });
  const tx = {
    academicYear: { findMany: jest.fn(() => Promise.resolve(years)) },
    user: { count },
  } as unknown as PrismaClient;
  return { tx, count };
}

describe('refuseRostersNotActivated', () => {
  it('refuses a rolled year whose pupils are still in the chain before it, naming it', async () => {
    const { tx } = txWith((ids) => (ids.includes('A') ? 27 : 0));
    const refusal = await refuseRostersNotActivated(tx, 'B').catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ConflictException);
    expect((refusal as ConflictException).getResponse()).toMatchObject({
      code: ROLLOVER_NOT_ACTIVATED,
      params: { year: '2027/28', pupils: 27 },
    });
    // Two links back too: C's chain is B and A.
    await expect(refuseRostersNotActivated(tx, 'C')).rejects.toBeInstanceOf(ConflictException);
  });

  it('lets the active year, a year outside every chain and a year whose chain is empty of pupils through, without counting for the first two', async () => {
    const { tx, count } = txWith(() => 0);
    await expect(refuseRostersNotActivated(tx, 'A')).resolves.toBeUndefined();
    await expect(refuseRostersNotActivated(tx, 'S')).resolves.toBeUndefined();
    await expect(refuseRostersNotActivated(tx, 'unknown')).resolves.toBeUndefined();
    expect(count).not.toHaveBeenCalled();
    await expect(refuseRostersNotActivated(tx, 'B')).resolves.toBeUndefined();
    expect(count).toHaveBeenCalledTimes(1);
  });
});
