import type { PrismaClient } from '@prisma/client';
import { createTxMock } from '../../test/utils/prisma-mock';
import { exemptionFinding, readGateLessons } from './publication-gates.reader';

/** PUB_EXEMPTIONS reads the column from the database (g467): the finding's own spec feeds it lessons, and cannot tell a reader that never asks for it. */
describe('readGateLessons and the exemptions', () => {
  it('selects exemptFrom, and the finding counts what it read', async () => {
    const tx = createTxMock();
    tx['masterLesson']!['findMany']!.mockResolvedValue([
      {
        id: 'l1',
        subjectId: 's',
        studentGroupId: 'g',
        teacherId: null,
        coTeacherId: null,
        roomId: null,
        dayOfWeek: 1,
        startTime: new Date('1970-01-01T14:30:00.000Z'),
        endTime: new Date('1970-01-01T15:30:00.000Z'),
        recurrence: 'ALL_WEEKS',
        startDate: null,
        endDate: null,
        isParked: false,
        exemptFrom: ['FRAME'],
        extraGroups: [],
        participants: [],
        subject: { name: 'Matematik' },
        studentGroup: { name: '7A' },
      },
    ]);
    const lessons = await readGateLessons(tx as unknown as PrismaClient, 'year');
    expect(tx['masterLesson']!['findMany']).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({ exemptFrom: true }) }));
    expect(exemptionFinding(lessons)).toMatchObject({ code: 'PUB_EXEMPTIONS', count: 1, info: true });
  });
});
