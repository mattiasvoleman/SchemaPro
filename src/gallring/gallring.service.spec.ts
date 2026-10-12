import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createPrismaMock, createTxMock, type TxMock } from '../../test/utils/prisma-mock';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import type { PrismaService } from '../database/prisma.service';
import { GallringService, RETENTION_INVALID, RETENTION_MONTHS_ONLY_FOR_A_PERIOD, RETENTION_PREVIEW_IS_THE_ADMINS } from './gallring.service';
import { firstNightFor, RETENTION_DATA_TYPES } from './retention';

type Statement = { strings: string[]; values: unknown[] };
const sql = (statement: unknown) => (statement as Statement).strings.join('?');
const SCHOOL = '11111111-1111-4111-8111-111111111111';
const admin = { userId: 'admin-1', schoolId: SCHOOL, role: 'SCHOOL_ADMIN' } as unknown as AuthenticatedUser;

const refusal = (state: string) =>
  new Prisma.PrismaClientKnownRequestError('Raw query failed.', {
    code: 'P2010',
    clientVersion: '7.10.0',
    meta: { driverAdapterError: { cause: { originalCode: state, originalMessage: 'refused' } } },
  });

function decision(dataType: string, decision: string, months: number | null, decidedAt: Date, decidedById: string | null = 'admin-1') {
  return { id: `${dataType}-${decidedAt.toISOString()}`, schoolId: SCHOOL, dataType, decision, months, reference: null, decidedById, decidedAt };
}

describe('GallringService', () => {
  let tx: TxMock;
  let service: GallringService;
  let previews: Array<{ kind: unknown; months: unknown }>;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-21T12:00:00Z'));
    tx = createTxMock();
    previews = [];
    tx['school']!['findUnique']!.mockResolvedValue({ timezone: 'Europe/Stockholm' });
    tx['user']!['findMany']!.mockResolvedValue([{ id: 'admin-1', firstName: 'Ada', lastName: 'Rektor' }]);
    tx.$queryRaw = jest.fn(async (statement: unknown) => {
      const text = sql(statement);
      if (text.includes('app.gallring_preview(')) {
        const [kind, months] = (statement as Statement).values;
        previews.push({ kind, months });
        return [{ cutoff: new Date('2025-10-21T00:00:00Z'), due: BigInt(12), held: BigInt(kind === 'DEPARTED_PEOPLE' ? 1 : 0) }];
      }
      if (text.includes('app.retention_purged_before()')) {
        return [
          { data_type: 'NOTIFICATIONS', purged_before: new Date('2026-04-21T00:00:00Z') },
          { data_type: 'ATTENDANCE', purged_before: new Date('2025-10-21T00:00:00Z') },
        ];
      }
      return [];
    }) as unknown as jest.Mock;
    service = new GallringService(createPrismaMock(tx) as unknown as PrismaService);
  });
  afterEach(() => jest.useRealTimers());

  it('lists every kind, ej beslutat when the school decided nothing, and previews only the periods', async () => {
    tx['retentionDecision']!['findMany']!.mockResolvedValue([
      decision('ATTENDANCE', 'PURGE_AFTER', 12, new Date('2026-10-01T10:00:00Z')),
      decision('LEAVE_REQUESTS', 'KEEP', null, new Date('2026-10-01T10:00:00Z')),
    ]);
    const overview = await service.overview(admin);
    expect(overview.kinds.map((k) => k.dataType)).toEqual([...RETENTION_DATA_TYPES]);
    const byKind = Object.fromEntries(overview.kinds.map((k) => [k.dataType, k]));
    expect(byKind['ATTENDANCE']).toMatchObject({
      current: { decision: 'PURGE_AFTER', months: 12, decidedBy: 'Ada Rektor' },
      waitsUntil: null,
      preview: { cutoff: '2025-10-21', due: 12, held: 0 },
      purgedBefore: '2025-10-21',
    });
    expect(byKind['LEAVE_REQUESTS']).toMatchObject({ current: { decision: 'KEEP' }, preview: null });
    expect(byKind['NOTIFICATIONS']).toMatchObject({ current: null, preview: null, purgedBefore: '2026-04-21' });
    expect(previews).toEqual([{ kind: 'ATTENDANCE', months: 12 }]);
    expect(overview).toMatchObject({ timezone: 'Europe/Stockholm', nightlyHour: 3 });
  });

  it('says when a period that takes more starts, and that one that takes less applies now', async () => {
    tx['retentionDecision']!['findMany']!.mockResolvedValue([
      // Newest first, as the query orders them.
      decision('ATTENDANCE', 'PURGE_AFTER', 6, new Date('2026-10-21T09:00:00Z')),
      decision('ATTENDANCE', 'PURGE_AFTER', 12, new Date('2026-09-01T09:00:00Z')),
      decision('ABSENCE_REPORTS', 'PURGE_AFTER', 24, new Date('2026-10-21T09:00:00Z')),
      decision('ABSENCE_REPORTS', 'PURGE_AFTER', 12, new Date('2026-09-01T09:00:00Z')),
      decision('NOTIFICATIONS', 'PURGE_AFTER', 3, new Date('2026-10-21T09:00:00Z')),
    ]);
    const byKind = Object.fromEntries((await service.overview(admin)).kinds.map((k) => [k.dataType, k]));
    // 11:00 Stockholm on the 21st: a day later is the 22nd at 11:00, so the night of the 23rd.
    expect(byKind['ATTENDANCE']!.waitsUntil).toBe('2026-10-23');
    expect(byKind['NOTIFICATIONS']!.waitsUntil).toBe('2026-10-23');
    expect(byKind['ABSENCE_REPORTS']!.waitsUntil).toBeNull();
  });

  it('records one decision for the caller\'s school, never the body\'s, and refuses months beside KEEP', async () => {
    tx['retentionDecision']!['create']!.mockResolvedValue({ id: 'd-1' });
    await service.decide({ dataType: 'ATTENDANCE', decision: 'PURGE_AFTER', months: 12, reference: 'DHP 4.1' }, admin);
    expect(tx['retentionDecision']!['create']).toHaveBeenCalledWith({
      data: { schoolId: SCHOOL, dataType: 'ATTENDANCE', decision: 'PURGE_AFTER', months: 12, reference: 'DHP 4.1' },
      select: { id: true },
    });
    await expect(service.decide({ dataType: 'ATTENDANCE', decision: 'KEEP', months: 12 }, admin)).rejects.toMatchObject({
      response: { code: RETENTION_MONTHS_ONLY_FOR_A_PERIOD },
    });
    await service.decide({ dataType: 'NOTIFICATIONS', decision: 'UNDECIDED' }, admin);
    expect(tx['retentionDecision']!['create']).toHaveBeenLastCalledWith({
      data: { schoolId: SCHOOL, dataType: 'NOTIFICATIONS', decision: 'UNDECIDED', months: null, reference: null },
      select: { id: true },
    });
  });

  it('answers the database\'s refusals as coded 403 and 400', async () => {
    tx.$queryRaw = jest.fn().mockRejectedValueOnce(refusal('GL403')).mockRejectedValueOnce(refusal('GL400')) as unknown as jest.Mock;
    const forbidden = service.preview({ dataType: 'ATTENDANCE', months: 12 }, admin);
    await expect(forbidden).rejects.toBeInstanceOf(ForbiddenException);
    await expect(forbidden).rejects.toMatchObject({ response: { code: RETENTION_PREVIEW_IS_THE_ADMINS } });
    const invalid = service.preview({ dataType: 'ATTENDANCE', months: 12 }, admin);
    await expect(invalid).rejects.toBeInstanceOf(BadRequestException);
    await expect(invalid).rejects.toMatchObject({ response: { code: RETENTION_INVALID } });
  });

  it('gives any role the "gallrat före" dates of its school, in the page\'s order', async () => {
    const pupil = { userId: 'p-1', schoolId: SCHOOL, role: 'STUDENT' } as unknown as AuthenticatedUser;
    await expect(service.purgedBefore(pupil)).resolves.toEqual([
      { dataType: 'ATTENDANCE', purgedBefore: '2025-10-21' },
      { dataType: 'NOTIFICATIONS', purgedBefore: '2026-04-21' },
    ]);
  });
});

describe('firstNightFor', () => {
  it('is the first 03:00 in the school\'s zone at least 24 hours after the decision', () => {
    // 14:00 on the 12th: a day later is 14:00 on the 13th, so 03:00 on the 14th.
    expect(firstNightFor(new Date('2026-10-12T12:00:00Z'), 'Europe/Stockholm')).toBe('2026-10-14');
    // 02:30 on the 12th: a day later is 02:30 on the 13th, so 03:00 that same morning.
    expect(firstNightFor(new Date('2026-10-12T00:30:00Z'), 'Europe/Stockholm')).toBe('2026-10-13');
    // Exactly 03:00 a day later counts.
    expect(firstNightFor(new Date('2026-10-12T01:00:00Z'), 'Europe/Stockholm')).toBe('2026-10-13');
    // Over the autumn shift (25 October 2026, 03:00 CEST -> 02:00 CET).
    expect(firstNightFor(new Date('2026-10-24T01:30:00Z'), 'Europe/Stockholm')).toBe('2026-10-25');
  });
});
