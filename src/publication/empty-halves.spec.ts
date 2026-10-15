import { createTxMock } from '../../test/utils/prisma-mock';
import type { PrismaClient } from '@prisma/client';
import { DEFAULT_GATE_POLICY, settleGates } from './publication-gates';
import { emptyHalfFinding, type GateLesson } from './publication-gates.reader';

/**
 * PUB_EMPTY_HALF (Halvklasser): a half with lessons and no pupils, named by
 * the half and its class; the school's policy decides warn or refuse.
 */

const YEAR = '99999999-9999-4999-8999-999999999999';

const lesson = (id: string, studentGroupId: string, overrides: Partial<GateLesson> = {}): GateLesson => ({
  id,
  subjectId: 'sl',
  studentGroupId,
  teacherId: null,
  coTeacherId: null,
  roomId: null,
  dayOfWeek: 1,
  startTime: '08:00',
  endTime: '09:00',
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  isParked: false,
  extraGroupIds: [],
  studentIds: [],
  subjectName: 'Slöjd',
  groupName: studentGroupId,
  ...overrides,
});

const half = (id: string, name: string) => ({ id, name, halfOfId: '7a', halfOf: { name: '7A' } });

describe('emptyHalfFinding', () => {
  /** The year's halves, and the halves an active pupil is placed in. */
  const arrange = (rows: unknown[], held: string[] = []) => {
    const tx = createTxMock();
    tx.studentGroup.findMany.mockResolvedValue(rows);
    tx.studentGroupMember.findMany.mockResolvedValue(held.map((studentGroupId) => ({ studentGroupId })));
    return tx;
  };

  it('names a half with lessons and no active pupil, by itself and its class', async () => {
    const tx = arrange([half('h1', '7A:1'), half('h2', '7A:2'), half('h3', '7B:1')], ['h2']);

    const finding = await emptyHalfFinding(tx as unknown as PrismaClient, YEAR, [
      lesson('a', 'h1'),
      lesson('b', 'h2'),
    ]);

    expect(finding).toEqual({ code: 'PUB_EMPTY_HALF', count: 1, entries: [{ label: '7A:1 (halva av 7A)' }] });
    // The active pupils of the taught halves only: a left pupil holds no half.
    expect(tx.studentGroupMember.findMany).toHaveBeenCalledWith({
      where: { studentGroupId: { in: ['h1', 'h2'] }, student: { role: 'STUDENT', isActive: true } },
      select: { studentGroupId: true },
    });
  });

  it('asks nothing of a half whose only lesson is parked, and counts one that joins a lesson as a guest', async () => {
    const tx = arrange([half('h1', '7A:1'), half('h2', '7A:2')]);

    const finding = await emptyHalfFinding(tx as unknown as PrismaClient, YEAR, [
      lesson('a', 'h1', { isParked: true }),
      lesson('b', '7a', { extraGroupIds: ['h2'] }),
    ]);

    expect(finding.entries).toEqual([{ label: '7A:2 (halva av 7A)' }]);
  });

  it('warns by default and refuses when the school says so', () => {
    const finding = { code: 'PUB_EMPTY_HALF' as const, count: 1, entries: [{ label: '7A:1 (halva av 7A)' }] };

    expect(settleGates([finding], DEFAULT_GATE_POLICY)[0]).toMatchObject({ severity: 'WARN', count: 1 });
    expect(settleGates([finding], { ...DEFAULT_GATE_POLICY, gateEmptyHalf: 'REFUSE' })[0]).toMatchObject({
      severity: 'REFUSE',
    });
  });
});
