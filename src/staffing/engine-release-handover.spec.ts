import { createTxMock, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaClient } from '@prisma/client';
import { takeBackReleasesAfterHandChange } from './engine-release-handover';

const SCHOOL = '33333333-3333-4333-8333-333333333333';
const YEAR = 'a0000000-0000-4000-8000-00000000000a';
const ACTOR = 'd0000000-0000-4000-8000-0000000000ad';
const P1 = '00000000-0000-4000-8000-000000000001';
const P2 = '00000000-0000-4000-8000-000000000002';
const P3 = '00000000-0000-4000-8000-000000000003';

describe('takeBackReleasesAfterHandChange (släppt för motorn)', () => {
  let tx: TxMock;
  const call = (requirementIds: string[], actorId: string | null = ACTOR) =>
    takeBackReleasesAfterHandChange(tx as unknown as PrismaClient, { schoolId: SCHOOL, academicYearId: YEAR, actorId, requirementIds });

  beforeEach(() => {
    tx = createTxMock();
  });

  it('does nothing and asks nothing for no posts', async () => {
    await expect(call([])).resolves.toEqual([]);
    expect(tx.teachingRequirementRelease.findMany).not.toHaveBeenCalled();
  });

  it('writes nothing for posts nobody released: one read', async () => {
    tx.teachingRequirementRelease.findMany.mockResolvedValue([]);
    await expect(call([P1, P2])).resolves.toEqual([]);
    expect(tx.teachingRequirementRelease.findMany).toHaveBeenCalledTimes(1);
    expect(tx.teachingRequirementRelease.deleteMany).not.toHaveBeenCalled();
    expect(tx.scheduleChangeLog.create).not.toHaveBeenCalled();
  });

  it('deletes and logs only the posts that were released, in id order, one log row for all', async () => {
    tx.teachingRequirementRelease.findMany.mockResolvedValue([{ requirementId: P3 }, { requirementId: P1 }]);
    await expect(call([P3, P2, P1, P1])).resolves.toEqual([P1, P3]);
    expect(tx.teachingRequirementRelease.findMany).toHaveBeenCalledWith({
      where: { requirementId: { in: [P1, P2, P3] } },
      select: { requirementId: true },
    });
    expect(tx.teachingRequirementRelease.deleteMany).toHaveBeenCalledWith({ where: { requirementId: { in: [P1, P3] } } });
    expect(tx.scheduleChangeLog.create).toHaveBeenCalledTimes(1);
    expect(tx.scheduleChangeLog.create.mock.calls[0]![0]).toMatchObject({
      data: {
        schoolId: SCHOOL,
        academicYearId: YEAR,
        actorId: ACTOR,
        action: 'UPDATE',
        before: { kind: 'ENGINE_RELEASE', released: true, requirementIds: [P1, P3] },
        after: { kind: 'ENGINE_RELEASE', released: false, requirementIds: [P1, P3], because: 'TEACHER_CHANGED_BY_HAND' },
      },
    });
  });

  it('keeps the log row shape the card’s own take-back writes, with one field more', async () => {
    tx.teachingRequirementRelease.findMany.mockResolvedValue([{ requirementId: P1 }]);
    await call([P1], null);
    const { data } = tx.scheduleChangeLog.create.mock.calls[0]![0] as { data: { actorId: unknown; before: object; after: Record<string, unknown> } };
    expect(data.actorId).toBeNull();
    expect(Object.keys(data.before).sort()).toEqual(['kind', 'released', 'requirementIds']);
    expect(Object.keys(data.after).sort()).toEqual(['because', 'kind', 'released', 'requirementIds']);
  });
});
