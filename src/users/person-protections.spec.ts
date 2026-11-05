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

  it('lists the school\'s marks with their source, and records the read of each marked person (PEOPLE)', async () => {
    tx.personProtection.findMany.mockResolvedValue([
      { userId: PUPIL, source: 'SS12000' },
      { userId: OTHER, source: 'MANUAL' },
    ]);
    await expect(service.list(admin)).resolves.toEqual([
      { userId: PUPIL, source: 'SS12000' },
      { userId: OTHER, source: 'MANUAL' },
    ]);
    expect(tx.personProtection.findMany).toHaveBeenCalledWith({
      where: { schoolId: SCHOOL },
      select: { userId: true, source: true },
      orderBy: { userId: 'asc' },
    });
    expect(readsRecorded(tx)).toEqual([['PEOPLE', 'WEB', [PUPIL, OTHER]]]);
  });

  it('records nothing when nobody is marked', async () => {
    await expect(service.list(admin)).resolves.toEqual([]);
    expect(readsRecorded(tx)).toEqual([]);
  });

  it('marks a person of the school by hand, and a person already marked keeps the mark they have', async () => {
    tx.user.findFirst.mockResolvedValue({ id: PUPIL });
    tx.personProtection.findFirst.mockResolvedValue({ userId: PUPIL, source: 'SS12000' });
    await expect(service.set(PUPIL, admin)).resolves.toEqual({ userId: PUPIL, source: 'SS12000' });
    expect(tx.user.findFirst).toHaveBeenCalledWith({ where: { id: PUPIL, schoolId: SCHOOL }, select: { id: true } });
    expect(tx.personProtection.createMany).toHaveBeenCalledWith({
      data: [{ userId: PUPIL, schoolId: SCHOOL, source: 'MANUAL' }],
      skipDuplicates: true,
    });
  });

  it('answers 404 for a person the school does not have, and writes nothing', async () => {
    await expect(service.set(OTHER, admin)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.remove(OTHER, admin)).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.personProtection.createMany).not.toHaveBeenCalled();
    expect(tx.personProtection.deleteMany).not.toHaveBeenCalled();
  });

  it('removes a mark whichever wrote it, within the school', async () => {
    tx.user.findFirst.mockResolvedValue({ id: PUPIL });
    await expect(service.remove(PUPIL, admin)).resolves.toEqual({ userId: PUPIL, source: null });
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
