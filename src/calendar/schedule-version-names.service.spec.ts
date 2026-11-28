import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { ScheduleVersionNamesService } from './schedule-version-names.service';

const VERSION = '55555555-5555-4555-8555-555555555555';
const YEAR = '44444444-4444-4444-8444-444444444444';
const SAVED = new Date('2026-08-06T12:00:00.000Z');

/*
 * Döp om en version (E9): bara namnet ändras, trimmat; en version som inte är skolans finns inte (404) och en som bara har blanksteg till namn är 400, och
 * i båda fallen skrivs ingenting.
 */
describe('ScheduleVersionNamesService', () => {
  let tx: TxMock;
  let prisma: PrismaMock;
  let service: ScheduleVersionNamesService;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new ScheduleVersionNamesService(prisma as unknown as PrismaService);
    tx['scheduleVersion']!['findUnique']!.mockResolvedValue({ id: VERSION });
    tx['scheduleVersion']!['update']!.mockImplementation(async (args: { data: { name: string } }) => ({
      id: VERSION,
      academicYearId: YEAR,
      name: args.data.name,
      lessonCount: 12,
      createdAt: SAVED,
    }));
  });

  it('writes the trimmed name and nothing else, and answers the version as the list does', async () => {
    const renamed = await service.rename(VERSION, '  Före vårjusteringar  ', testUser());
    expect(tx['scheduleVersion']!['update']).toHaveBeenCalledWith(expect.objectContaining({ where: { id: VERSION }, data: { name: 'Före vårjusteringar' } }));
    expect(renamed).toEqual({ id: VERSION, academicYearId: YEAR, name: 'Före vårjusteringar', lessonCount: 12, createdAt: '2026-08-06T12:00:00.000Z' });
  });

  it('answers 404 for a version the caller cannot see, and writes nothing', async () => {
    tx['scheduleVersion']!['findUnique']!.mockResolvedValue(null);
    await expect(service.rename(VERSION, 'Nytt namn', testUser())).rejects.toBeInstanceOf(NotFoundException);
    expect(tx['scheduleVersion']!['update']).not.toHaveBeenCalled();
  });

  it('answers 400 for a name with a NUL character in it, which Postgres cannot store, before the database is asked', async () => {
    await expect(service.rename(VERSION, 'Före\u0000lovet', testUser())).rejects.toBeInstanceOf(BadRequestException);
    expect(tx['scheduleVersion']!['findUnique']).not.toHaveBeenCalled();
    expect(tx['scheduleVersion']!['update']).not.toHaveBeenCalled();
  });

  it('answers 400 for a name that is only blanks, before the database is asked', async () => {
    await expect(service.rename(VERSION, '   ', testUser())).rejects.toBeInstanceOf(BadRequestException);
    expect(tx['scheduleVersion']!['findUnique']).not.toHaveBeenCalled();
    expect(tx['scheduleVersion']!['update']).not.toHaveBeenCalled();
  });
});
