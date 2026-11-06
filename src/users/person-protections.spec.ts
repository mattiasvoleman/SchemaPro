import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import type { PrismaService } from '../database/prisma.service';
import { createPrismaMock, createTxMock, type TxMock } from '../../test/utils/prisma-mock';
import { PersonProtectionsService, markedIds, unmarked } from './person-protections';

const SCHOOL = '33333333-3333-4333-8333-333333333333';
const PUPIL = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const admin = { authId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', schoolId: SCHOOL, role: 'SCHOOL_ADMIN', channel: 'WEB' } as AuthenticatedUser;

const readsRecorded = (tx: TxMock) =>
  tx.$executeRaw.mock.calls
    .map(([statement]) => statement as { strings: string[]; values: unknown[] })
    .filter((sql) => sql.strings.join('?').includes('app.personal_data_read'))
    .map((sql) => sql.values);

describe('PersonProtectionsService', () => {
  let tx: TxMock;
  let service: PersonProtectionsService;
  beforeEach(() => {
    tx = createTxMock();
    service = new PersonProtectionsService(createPrismaMock(tx) as unknown as PrismaService);
  });
  const ACTOR = '66666666-6666-4666-8666-666666666666';
  const at = new Date('2026-11-05T10:00:00.000Z');

  it('lists the school\'s marks, a row per source, and records the read of each marked person (PEOPLE)', async () => {
    tx.personProtection.findMany.mockResolvedValue([
      { userId: PUPIL, source: 'MANUAL' },
      { userId: PUPIL, source: 'SS12000' },
      { userId: OTHER, source: 'MANUAL' },
    ]);
    await expect(service.list(admin)).resolves.toHaveLength(3);
    expect(tx.personProtection.findMany).toHaveBeenCalledWith({
      where: { schoolId: SCHOOL },
      select: { userId: true, source: true },
      orderBy: [{ userId: 'asc' }, { source: 'asc' }],
    });
    expect(readsRecorded(tx)).toEqual([['PEOPLE', 'WEB', [PUPIL, OTHER]]]);
  });

  it('records nothing when nobody is marked', async () => {
    await expect(service.list(admin)).resolves.toEqual([]);
    expect(readsRecorded(tx)).toEqual([]);
  });

  it('answers one person\'s marks and who set or removed them, newest first, and records the person and those it names', async () => {
    tx.user.findFirst.mockResolvedValue({ id: PUPIL, ss12000Id: null });
    tx.personProtection.findMany.mockResolvedValue([{ source: 'MANUAL' }]);
    tx.personProtectionEvent.findMany.mockResolvedValue([
      { action: 'ADDED', source: 'MANUAL', actorId: ACTOR, at },
      { action: 'REMOVED', source: 'SS12000', actorId: null, at },
    ]);
    tx.user.findMany.mockResolvedValue([{ id: ACTOR, firstName: 'Rita', lastName: 'Rektor' }]);
    await expect(service.one(PUPIL, admin)).resolves.toEqual({
      userId: PUPIL,
      sources: ['MANUAL'],
      linked: false,
      events: [
        { action: 'ADDED', source: 'MANUAL', actorName: 'Rita Rektor', at: at.toISOString() },
        { action: 'REMOVED', source: 'SS12000', actorName: null, at: at.toISOString() },
      ],
    });
    expect(tx.personProtectionEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: PUPIL, schoolId: SCHOOL }, orderBy: [{ at: 'desc' }, { id: 'desc' }] }),
    );
    expect(readsRecorded(tx)).toEqual([['PEOPLE', 'WEB', [PUPIL, ACTOR]]]);
  });

  it('marks a person by hand with a row of the administrator\'s own, beside any the sync wrote', async () => {
    tx.user.findFirst.mockResolvedValue({ id: PUPIL, ss12000Id: '77777777-7777-4777-8777-777777777777' });
    tx.personProtection.findMany.mockResolvedValue([{ source: 'MANUAL' }, { source: 'SS12000' }]);
    await expect(service.set(PUPIL, admin)).resolves.toMatchObject({ userId: PUPIL, sources: ['MANUAL', 'SS12000'], linked: true });
    expect(tx.user.findFirst).toHaveBeenCalledWith({ where: { id: PUPIL, schoolId: SCHOOL }, select: { id: true, ss12000Id: true } });
    expect(tx.personProtection.createMany).toHaveBeenCalledWith({
      data: [{ userId: PUPIL, schoolId: SCHOOL, source: 'MANUAL' }],
      skipDuplicates: true,
    });
  });

  it('takes the school\'s people lock before the person\'s row, to set or remove a mark (20270111090000)', async () => {
    tx.user.findFirst.mockResolvedValue({ id: PUPIL, ss12000Id: null });
    const firstStatement = () => (tx.$executeRaw.mock.calls[0]![0] as { strings: string[] }).strings.join('?');
    await service.set(PUPIL, admin);
    expect(firstStatement()).toContain('pg_advisory_xact_lock_shared(hashtextextended(');
    expect(tx.$executeRaw.mock.calls[0]![0].values).toEqual([`Users:${SCHOOL}`]);
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.user.findFirst.mock.invocationCallOrder[0]!);
    tx.$executeRaw.mockClear();
    tx.user.findFirst.mockClear();
    await service.remove(PUPIL, admin);
    expect(firstStatement()).toContain('pg_advisory_xact_lock_shared(hashtextextended(');
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.user.findFirst.mock.invocationCallOrder[0]!);
  });

  it('answers 404 for a person the school does not have, and writes and records nothing', async () => {
    await expect(service.set(OTHER, admin)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.remove(OTHER, admin)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.one(OTHER, admin)).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.personProtection.createMany).not.toHaveBeenCalled();
    expect(tx.personProtection.deleteMany).not.toHaveBeenCalled();
    expect(readsRecorded(tx)).toEqual([]);
  });

  it('removes the person\'s marks, the sync\'s and an administrator\'s, within the school', async () => {
    tx.user.findFirst.mockResolvedValue({ id: PUPIL, ss12000Id: null });
    await expect(service.remove(PUPIL, admin)).resolves.toMatchObject({ userId: PUPIL, sources: [] });
    expect(tx.personProtection.deleteMany).toHaveBeenCalledWith({ where: { userId: PUPIL, schoolId: SCHOOL } });
  });
});

describe('the exports\' helpers', () => {
  it('markedIds reads the school\'s marks', async () => {
    const tx = createTxMock();
    tx.personProtection.findMany.mockResolvedValue([{ userId: PUPIL }]);
    await expect(markedIds(tx as never, SCHOOL)).resolves.toEqual(new Set([PUPIL]));
    expect(tx.personProtection.findMany).toHaveBeenCalledWith({ where: { schoolId: SCHOOL }, select: { userId: true } });
  });

  it('unmarked is NOT EXISTS over the marks, on the column it is given', () => {
    const sql = unmarked(Prisma.sql`u."id"`);
    expect(sql.sql.replace(/\s+/g, ' ')).toBe('NOT EXISTS (SELECT 1 FROM "PersonProtections" pp WHERE pp."userId" = u."id")');
  });
});
