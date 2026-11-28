import { ConflictException } from '@nestjs/common';
import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { DIRECT_REACH_UNANSWERED, mustAsk, readDirectReachFacts, requireDirectReachAnswered, type DirectReachFacts } from './direct-reach';
import { DirectReachService } from './direct-reach.service';

const YEAR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SCHOOL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** What app.direct_reach_facts answers, as the driver hands it back: dates as Date. */
const row = (over: Partial<{ answered: boolean; acknowledgedAt: Date | null }> = {}) => ({
  publishedAt: new Date('2026-08-01T10:00:00Z'),
  validFrom: new Date('2026-08-01T00:00:00Z'),
  validTo: new Date('2027-06-11T00:00:00Z'),
  acknowledgedAt: null as Date | null,
  answered: false,
  ...over,
});

const facts = (over: Partial<DirectReachFacts> = {}): DirectReachFacts => ({
  publishedAt: new Date('2026-08-01T10:00:00Z'),
  validFrom: '2026-08-01',
  validTo: '2027-06-11',
  acknowledgedAt: null,
  answered: false,
  ...over,
});

describe('mustAsk: when the question is asked', () => {
  it('asks in Direkt while a publication of the year holds and the school has not answered', () => {
    expect(mustAsk('DIRECT', facts())).toBe(true);
  });
  it.each([
    ['the school has answered', 'DIRECT' as const, facts({ answered: true, acknowledgedAt: new Date() })],
    ['no publication of the year holds', 'DIRECT' as const, null],
    ['the school is in utkast: an edit there is a draft and reaches nobody', 'DRAFT' as const, facts()],
  ])('does not ask when %s', (_why, mode, given) => {
    expect(mustAsk(mode, given)).toBe(false);
  });
});

describe('readDirectReachFacts', () => {
  it('names the dates as days and carries the answer as the database gave it', async () => {
    const tx = createTxMock();
    const answered = new Date('2026-08-02T10:00:00Z');
    tx.$queryRaw.mockResolvedValue([row({ answered: true, acknowledgedAt: answered })]);
    await expect(readDirectReachFacts(tx as never, YEAR)).resolves.toEqual({
      publishedAt: new Date('2026-08-01T10:00:00Z'),
      validFrom: '2026-08-01',
      validTo: '2027-06-11',
      acknowledgedAt: answered,
      answered: true,
    });
  });

  it('is null when no publication of the year holds', async () => {
    const tx = createTxMock();
    tx.$queryRaw.mockResolvedValue([]);
    await expect(readDirectReachFacts(tx as never, YEAR)).resolves.toBeNull();
  });
});

describe('requireDirectReachAnswered: the guard of a write that moved or removed published lessons', () => {
  let tx: TxMock;
  beforeEach(() => {
    tx = createTxMock();
  });

  it('refuses with a 409 and the code, and names the period, when the change reached lessons in Direkt before the school answered', async () => {
    tx.$queryRaw.mockResolvedValue([row()]);
    const attempt = requireDirectReachAnswered(tx as never, { academicYearId: YEAR, mode: 'DIRECT', reached: 2 });
    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    await expect(attempt).rejects.toMatchObject({
      response: expect.objectContaining({ code: DIRECT_REACH_UNANSWERED, params: { validFrom: '2026-08-01', validTo: '2027-06-11' } }),
    });
  });

  it('carries what the write says of its own reach on the refusal, as flat numbers beside the period', async () => {
    tx.$queryRaw.mockResolvedValue([row()]);
    await expect(
      requireDirectReachAnswered(tx as never, { academicYearId: YEAR, mode: 'DIRECT', reached: 4, detail: { removed: 4, handChanged: 1 } }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ params: { validFrom: '2026-08-01', validTo: '2027-06-11', removed: 4, handChanged: 1 } }),
    });
  });

  it('lets a change through that the school has answered for, and one in a year no publication holds', async () => {
    tx.$queryRaw.mockResolvedValue([row({ answered: true, acknowledgedAt: new Date('2026-08-02T10:00:00Z') })]);
    await expect(requireDirectReachAnswered(tx as never, { academicYearId: YEAR, mode: 'DIRECT', reached: 5 })).resolves.toBeUndefined();
    tx.$queryRaw.mockResolvedValue([]);
    await expect(requireDirectReachAnswered(tx as never, { academicYearId: YEAR, mode: 'DIRECT', reached: 5 })).resolves.toBeUndefined();
  });

  it('asks the database nothing when the change reached nobody or the school is in utkast', async () => {
    tx.$queryRaw.mockResolvedValue([row()]);
    await expect(requireDirectReachAnswered(tx as never, { academicYearId: YEAR, mode: 'DIRECT', reached: 0 })).resolves.toBeUndefined();
    await expect(requireDirectReachAnswered(tx as never, { academicYearId: YEAR, mode: 'DRAFT', reached: 9 })).resolves.toBeUndefined();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('DirectReachService', () => {
  let tx: TxMock;
  let service: DirectReachService;

  /** The two raw statements a read makes: the mode (one word) and the facts, then the guardians' count. */
  const answers = (mode: 'DIRECT' | 'DRAFT', facts: unknown[], guardians = 0) => {
    tx.$queryRaw.mockImplementation(async (query: { sql?: string }) => {
      const text = query.sql ?? '';
      if (/direct_reach_facts/.test(text)) return facts;
      if (/GuardianStudents/.test(text)) return [{ n: guardians }];
      if (/now\(\)/.test(text)) return [{ now: new Date('2026-09-01T08:00:00.123Z') }];
      return [{ mode }];
    });
  };

  beforeEach(() => {
    tx = createTxMock();
    service = new DirectReachService(createPrismaMock(tx) as unknown as PrismaService);
    tx['academicYear']!['findFirst']!.mockResolvedValue({ id: YEAR });
    tx['academicYear']!['findUnique']!.mockResolvedValue({ id: YEAR });
    tx['user']!['count']!.mockResolvedValue(412);
  });

  it('asks, names the period and counts who can get a notice, in Direkt with a publication and no answer', async () => {
    answers('DIRECT', [row()], 689);
    const view = await service.read(testUser({ schoolId: SCHOOL }));
    expect(view).toEqual({
      academicYearId: YEAR,
      mode: 'DIRECT',
      period: { from: '2026-08-01', to: '2027-06-11' },
      acknowledgedAt: null,
      ask: true,
      audience: { pupils: 412, guardians: 689 },
    });
    // Only active pupils are counted, by role: no list, no name.
    expect(tx['user']!['count']).toHaveBeenCalledWith({ where: { role: 'STUDENT', isActive: true } });
  });

  it('does not ask, and counts nobody, once the school has answered', async () => {
    const at = new Date('2026-08-02T10:00:00Z');
    answers('DIRECT', [row({ answered: true, acknowledgedAt: at })]);
    const view = await service.read(testUser({ schoolId: SCHOOL }));
    expect(view).toMatchObject({ ask: false, audience: null, acknowledgedAt: at.toISOString(), period: { from: '2026-08-01', to: '2027-06-11' } });
    expect(tx['user']!['count']).not.toHaveBeenCalled();
  });

  it('does not ask in utkast, or in a year no publication holds', async () => {
    answers('DRAFT', [row()]);
    await expect(service.read(testUser({ schoolId: SCHOOL }))).resolves.toMatchObject({ mode: 'DRAFT', ask: false, audience: null });
    answers('DIRECT', []);
    await expect(service.read(testUser({ schoolId: SCHOOL }))).resolves.toMatchObject({ mode: 'DIRECT', period: null, ask: false, audience: null });
  });

  it('asks about the year it is asked about, and about no year when the school has none active', async () => {
    answers('DIRECT', [row()]);
    await service.read(testUser({ schoolId: SCHOOL }), YEAR);
    expect(tx['academicYear']!['findUnique']).toHaveBeenCalledWith({ where: { id: YEAR }, select: { id: true } });
    tx['academicYear']!['findFirst']!.mockResolvedValue(null);
    await expect(service.read(testUser({ schoolId: SCHOOL }))).resolves.toMatchObject({ academicYearId: null, period: null, ask: false });
  });

  it('writes the answer at the database\'s own clock, creating the settings row of a school that has none, and answers with the view', async () => {
    answers('DIRECT', [row({ answered: true, acknowledgedAt: new Date('2026-09-01T08:00:00.123Z') })]);
    const view = await service.acknowledge(testUser({ schoolId: SCHOOL }));
    const now = new Date('2026-09-01T08:00:00.123Z');
    expect(tx['publicationSettings']!['upsert']).toHaveBeenCalledWith({
      where: { schoolId: SCHOOL },
      create: { schoolId: SCHOOL, directReachAcknowledgedAt: now },
      update: { directReachAcknowledgedAt: now },
    });
    expect(view).toMatchObject({ ask: false, acknowledgedAt: now.toISOString() });
  });
});
