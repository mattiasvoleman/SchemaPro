import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import { recordedReads } from '../../test/utils/recorded-reads';
import type { PrismaService } from '../database/prisma.service';
import { ACCESS_LOG_LIMIT, AccessLogService } from './access-log.service';

const PUPIL = 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
const TEACHER = 'b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2';
const KEY = '9c0b4a1e-3f2d-4b8a-9e6f-0a1b2c3d4e5f';

const row = (overrides: Record<string, unknown>) => ({
  id: 'e',
  at: new Date('2026-10-13T07:15:00.000Z'),
  kind: 'ROSTER',
  channel: 'APP',
  actorId: TEACHER,
  actorRole: 'TEACHER',
  apiKeyId: null,
  readSize: 25,
  ...overrides,
});

describe('AccessLogService', () => {
  let tx: TxMock;
  let prisma: PrismaMock;
  let service: AccessLogService;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new AccessLogService(prisma as unknown as PrismaService);
    tx.school.findUnique.mockResolvedValue({ timezone: 'Europe/Stockholm' });
    tx.user.findUnique.mockResolvedValue({ id: PUPIL, firstName: 'Ada', lastName: 'Ek', role: 'STUDENT' });
  });

  const statement = () => {
    const [sql] = (tx as unknown as { $queryRaw: jest.Mock }).$queryRaw.mock.calls[0] as [{ strings: string[]; values: unknown[] }];
    return { text: sql.strings.join('?'), values: sql.values };
  };

  it('answers who read about the person, newest first, naming readers and keys, and records its own read', async () => {
    (tx as unknown as { $queryRaw: jest.Mock }).$queryRaw.mockResolvedValue([
      row({ id: 'e2' }),
      row({ id: 'e1', at: new Date('2026-10-12T12:00:00.000Z'), kind: 'PEOPLE', channel: 'INTEGRATION', actorId: null, actorRole: null, apiKeyId: KEY, readSize: 1 }),
      row({ id: 'e0', actorId: null, actorRole: 'SCHOOL_ADMIN', channel: 'WEB', kind: 'GUARDIANS', readSize: 3 }),
    ]);
    tx.user.findMany.mockResolvedValue([{ id: TEACHER, firstName: 'Bo', lastName: 'Ås' }]);
    tx.integrationApiKey.findMany.mockResolvedValue([{ id: KEY, name: 'Kommunens elevregister' }]);

    const answer = await service.forPerson({ personId: PUPIL }, testUser({ channel: 'WEB' }));

    expect(answer.person).toEqual({ id: PUPIL, firstName: 'Ada', lastName: 'Ek', role: 'STUDENT' });
    expect(answer.truncated).toBe(false);
    expect(answer.entries).toEqual([
      { id: 'e2', at: '2026-10-13T07:15:00.000Z', kind: 'ROSTER', channel: 'APP', reader: { type: 'PERSON', id: TEACHER, name: 'Bo Ås', role: 'TEACHER' }, others: 24 },
      { id: 'e1', at: '2026-10-12T12:00:00.000Z', kind: 'PEOPLE', channel: 'INTEGRATION', reader: { type: 'KEY', id: KEY, name: 'Kommunens elevregister' }, others: 0 },
      // A reader whose row is gone: the role stays, the name does not.
      { id: 'e0', at: '2026-10-13T07:15:00.000Z', kind: 'GUARDIANS', channel: 'WEB', reader: { type: 'PERSON', id: null, name: null, role: 'SCHOOL_ADMIN' }, others: 2 },
    ]);
    // By the GIN-indexed containment, newest first, one past the limit.
    expect(statement().text).toMatch(/"subjectIds" @> ARRAY\[\?\]::uuid\[\]/);
    expect(statement().text).toMatch(/ORDER BY a\."at" DESC, a\."id" DESC/);
    expect(statement().values).toEqual([PUPIL, ACCESS_LOG_LIMIT + 1]);
    expect(recordedReads(tx)).toEqual([{ kind: 'ACCESS_LOG', channel: 'WEB', ids: [PUPIL] }]);
  });

  it("names the huvudman's reader and the huvudman's key, with their huvudman (Huvudman)", async () => {
    const MEMBER = 'c3c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3';
    const HKEY = 'd4d4d4d4-d4d4-44d4-84d4-d4d4d4d4d4d4';
    const raw = (tx as unknown as { $queryRaw: jest.Mock }).$queryRaw;
    raw.mockResolvedValueOnce([
      row({ id: 'h2', actorId: null, actorRole: 'SCHOOL_ADMIN', channel: 'WEB', huvudmanMemberId: MEMBER, huvudmanApiKeyId: null }),
      row({ id: 'h1', actorId: null, actorRole: null, channel: 'INTEGRATION', apiKeyId: null, huvudmanMemberId: null, huvudmanApiKeyId: HKEY }),
    ]);
    raw.mockResolvedValueOnce([
      { id: MEMBER, kind: 'MEMBER', name: 'Pia Planerare', role: 'PLANERARE', huvudman_name: 'Vimmerby kommun' },
      { id: HKEY, kind: 'KEY', name: 'Elevregistret', role: null, huvudman_name: 'Vimmerby kommun' },
    ]);

    const answer = await service.forPerson({ personId: PUPIL }, testUser());

    expect(answer.entries.map((entry) => entry.reader)).toEqual([
      { type: 'PERSON', id: MEMBER, name: 'Pia Planerare', role: 'SCHOOL_ADMIN', huvudman: { name: 'Vimmerby kommun', role: 'PLANERARE' } },
      { type: 'KEY', id: HKEY, name: 'Elevregistret', huvudman: { name: 'Vimmerby kommun', role: null } },
    ]);
    const [names] = raw.mock.calls[1] as [{ strings: string[]; values: unknown[] }];
    expect(names.strings.join('?')).toContain('app.access_log_huvudman_names');
    expect(names.values).toEqual([[MEMBER], [HKEY]]);
  });

  it("asks for no huvudman's names when the log names none", async () => {
    (tx as unknown as { $queryRaw: jest.Mock }).$queryRaw.mockResolvedValue([row({ id: 'e' })]);
    tx.user.findMany.mockResolvedValue([]);
    await service.forPerson({ personId: PUPIL }, testUser());
    expect((tx as unknown as { $queryRaw: jest.Mock }).$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('reads school days from..to as the school\'s local midnights', async () => {
    await service.forPerson({ personId: PUPIL, from: '2026-10-01', to: '2026-10-13' }, testUser());
    // CEST: midnight is 22:00 UTC the day before; to is inclusive.
    expect(statement().values).toEqual([
      PUPIL,
      new Date('2026-09-30T22:00:00.000Z'),
      new Date('2026-10-13T22:00:00.000Z'),
      ACCESS_LOG_LIMIT + 1,
    ]);
  });

  it('says when it cut the answer at the limit', async () => {
    (tx as unknown as { $queryRaw: jest.Mock }).$queryRaw.mockResolvedValue(
      Array.from({ length: ACCESS_LOG_LIMIT + 1 }, (_, index) => row({ id: `e${index}` })),
    );
    const answer = await service.forPerson({ personId: PUPIL }, testUser());
    expect(answer.truncated).toBe(true);
    expect(answer.entries).toHaveLength(ACCESS_LOG_LIMIT);
  });

  it('answers 404 for a person row security does not show, and records nothing', async () => {
    tx.user.findUnique.mockResolvedValue(null);
    await expect(service.forPerson({ personId: PUPIL }, testUser())).rejects.toThrow(NotFoundException);
    expect(recordedReads(tx)).toEqual([]);
  });

  it('leaves the läslogg to those who decide: a planner or the expedition is refused before anything is read', async () => {
    for (const adminProfile of ['SCHEMALAGGARE', 'EXPEDITION'] as const) {
      await expect(
        service.forPerson({ personId: PUPIL }, testUser({ adminProfile, hrRead: true })),
      ).rejects.toMatchObject({ status: 403, response: { code: 'DECISION_NOT_YOURS' } });
    }
    expect(prisma.withRls).not.toHaveBeenCalled();
  });

  it('refuses a period that ends before it begins, before reading anything', async () => {
    await expect(service.forPerson({ personId: PUPIL, from: '2026-10-13', to: '2026-10-01' }, testUser())).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.withRls).not.toHaveBeenCalled();
  });
});
