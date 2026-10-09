import { ForbiddenException } from '@nestjs/common';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { NationalTimplansService } from './national-timplans.service';

const VERSION_ID = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';

describe('NationalTimplansService', () => {
  let service: NationalTimplansService;
  let tx: TxMock;
  let prisma: PrismaMock;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new NationalTimplansService(prisma as unknown as PrismaService);
  });

  it('reads versions with their cells and the subject list under the caller’s RLS context', async () => {
    const version = {
      id: VERSION_ID,
      code: 'SFS2023:945/B1',
      sfs: 'SFS 2023:945',
      title: 'Timplan för grundskolan',
      schoolForm: 'GRUNDSKOLA',
      totalHours: 6890,
      skolansValHours: 600,
      reductionCapPercent: 20,
      appliesFromCohortTerm: 'HT2024',
      appliesBy: 'STAGES_NOT_COMPLETED',
      supersededByCode: 'SFS2025:729',
      entries: [
        {
          subjectCode: 'MA',
          stage: 'LAG',
          hours: 420,
          minimumHoursPerChild: null,
          protectedFromReduction: true,
        },
      ],
    };
    const subject = { code: 'MA', name: 'Matematik', parentCode: null, isGroup: false };
    tx.nationalTimplanVersion.findMany.mockResolvedValue([version]);
    tx.nationalSubject.findMany.mockResolvedValue([subject]);
    const user = testUser({ role: 'TEACHER' as never });

    await expect(service.get(user)).resolves.toEqual({
      versions: [version],
      subjects: [subject],
    });

    expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
  });

  it('orders everything by key, so the same data serialises to the same ETag', async () => {
    // Without an ORDER BY PostgreSQL may hand rows back in any order, and a
    // client's If-None-Match would miss on a body that changed in nothing but
    // row order.
    await service.get(testUser());

    expect(tx.nationalTimplanVersion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { code: 'asc' },
        select: expect.objectContaining({
          entries: expect.objectContaining({
            orderBy: [{ subjectCode: 'asc' }, { stage: 'asc' }],
          }),
        }),
      }),
    );
    expect(tx.nationalSubject.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { code: 'asc' } }),
    );
  });

  it('leaves createdAt out of a version — a deploy timestamp is not part of the statute', async () => {
    await service.get(testUser());

    const { select } = tx.nationalTimplanVersion.findMany.mock.calls[0]?.[0] as {
      select: Record<string, unknown>;
    };
    expect(select).not.toHaveProperty('createdAt');
    expect(Object.keys(select).sort()).toEqual([
      'appliesBy',
      'appliesFromCohortTerm',
      'code',
      'entries',
      'id',
      'reductionCapPercent',
      'schoolForm',
      'sfs',
      'skolansValHours',
      'supersededByCode',
      'title',
      'totalHours',
    ]);
  });

  it('answers a version without cells as an empty list, not as missing', async () => {
    // SFS 2025:729 is seeded with its total and no fördelning; the UI renders
    // "fördelning ej publicerad" from an empty `entries`, never 0 h.
    tx.nationalTimplanVersion.findMany.mockResolvedValue([
      { id: VERSION_ID, code: 'SFS2025:729', totalHours: 7424, entries: [] },
    ]);

    const response = await service.get(testUser());

    expect(response.versions[0]).toMatchObject({ code: 'SFS2025:729', entries: [] });
  });

  it('403s a principal with no school before opening a transaction', async () => {
    // No Users row means no app.current_user_id(), and the SELECT policy would
    // answer with six empty tables. A refusal is the honest answer.
    await expect(service.get(testUser({ schoolId: undefined }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.withRls).not.toHaveBeenCalled();
  });
});
