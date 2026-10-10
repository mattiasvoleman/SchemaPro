import { Role } from '../auth/enums/role.enum';
import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { CoverSettingsService } from './cover-settings.service';

const ME = '66666666-6666-4666-8666-666666666666';
const OTHER = '77777777-7777-4777-8777-777777777777';
const teacher = testUser({ role: Role.TEACHER, userId: ME });

describe('CoverSettingsService', () => {
  let tx: TxMock;
  let prisma: PrismaMock;
  let service: CoverSettingsService;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new CoverSettingsService(prisma as unknown as PrismaService);
  });

  const code = async (promise: Promise<unknown>) => {
    const error = await promise.then(() => null, (e: unknown) => e);
    return (error as { getResponse?: () => { code?: string } } | null)?.getResponse?.().code ?? String(error);
  };

  describe('reasons', () => {
    const row = { id: 'r1', builtin: 'SICK', label: null, sortOrder: 0, archivedAt: null };

    it('an admin listing them ensures the built-ins first; a teacher only reads', async () => {
      tx.teacherAbsenceReason.findMany.mockResolvedValue([row]);
      expect(await service.reasons(testUser())).toEqual([{ id: 'r1', builtin: 'SICK', label: null, sortOrder: 0, archived: false }]);
      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
      await service.reasons(teacher);
      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('a built-in is archived, never renamed; a label of the school’s own is', async () => {
      tx.teacherAbsenceReason.findUnique.mockResolvedValue(row);
      expect(await code(service.updateReason('r1', { label: 'Sjuk' }, testUser()))).toBe('REASON_BUILTIN_LABEL');
      tx.teacherAbsenceReason.update.mockResolvedValue({ ...row, archivedAt: new Date() });
      expect(await service.updateReason('r1', { archived: true }, testUser())).toMatchObject({ archived: true });
      expect(tx.teacherAbsenceReason.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { archivedAt: expect.any(Date) } }),
      );
      tx.teacherAbsenceReason.findUnique.mockResolvedValue(null);
      await expect(service.updateReason('r1', { sortOrder: 1 }, testUser())).rejects.toThrow('Orsaken finns inte.');
    });

    it('creates the school’s own label; a duplicate is a 409', async () => {
      tx.teacherAbsenceReason.create.mockResolvedValue({ id: 'r2', builtin: null, label: 'Föräldramöte', sortOrder: 500, archivedAt: null });
      expect(await service.createReason({ label: 'Föräldramöte' }, testUser())).toMatchObject({ label: 'Föräldramöte' });
      const { Prisma } = jest.requireActual('@prisma/client');
      tx.teacherAbsenceReason.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }));
      expect(await code(service.createReason({ label: 'Föräldramöte' }, testUser()))).toBe('COVER_DUPLICATE');
    });
  });

  it('settings: no row is every default; turning self-report on ensures the categories', async () => {
    tx.coverSettings.findUnique.mockResolvedValue(null);
    expect(await service.settings(teacher)).toEqual({ poolPreference: 'NEUTRAL', teacherSelfReport: false });
    tx.coverSettings.upsert.mockResolvedValue({ poolPreference: 'LAST_RESORT', teacherSelfReport: true });
    await service.putSettings({ poolPreference: 'LAST_RESORT', teacherSelfReport: true }, testUser());
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  describe('the pool', () => {
    it('adds and removes members; a non-teacher is refused by the trigger as a 409', async () => {
      await service.addToPool(OTHER, testUser());
      expect(tx.substitutePoolMember.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: { schoolId: '33333333-3333-4333-8333-333333333333', userId: OTHER, createdByUserId: expect.any(String) } }),
      );
      const { Prisma } = jest.requireActual('@prisma/client');
      tx.substitutePoolMember.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('x', { code: 'P2039', clientVersion: 'x', meta: { driverAdapterError: { cause: { originalCode: 'SP409' } } } }),
      );
      expect(await code(service.addToPool(OTHER, testUser()))).toBe('POOL_MEMBER_MUST_BE_TEACHER');
      tx.substitutePoolMember.deleteMany.mockResolvedValue({ count: 0 });
      await expect(service.removeFromPool(OTHER, testUser())).rejects.toThrow('står inte i vikariepoolen');
      tx.substitutePoolMember.findMany.mockResolvedValue([{ userId: OTHER, createdAt: new Date('2026-10-01T00:00:00Z') }]);
      expect(await service.pool(testUser())).toEqual([{ userId: OTHER, createdAt: '2026-10-01T00:00:00.000Z' }]);
    });

    it('availability: a member writes their own windows only; a date or a weekday, start before end', async () => {
      expect(await code(service.addAvailability({ userId: OTHER, dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }, teacher))).toBe(
        'AVAILABILITY_NOT_YOURS',
      );
      expect(await code(service.addAvailability({ startTime: '08:00', endTime: '12:00' }, teacher))).toBe('AVAILABILITY_SHAPE');
      expect(await code(service.addAvailability({ dayOfWeek: 1, startTime: '12:00', endTime: '08:00' }, teacher))).toBe(
        'AVAILABILITY_SHAPE',
      );
      expect(await code(service.addAvailability({ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }, testUser()))).toBe(
        'AVAILABILITY_SHAPE',
      );
      tx.substituteAvailability.create.mockResolvedValue({
        id: 'w1',
        userId: ME,
        date: null,
        dayOfWeek: 1,
        startTime: new Date('1970-01-01T08:00:00Z'),
        endTime: new Date('1970-01-01T12:00:00Z'),
      });
      expect(await service.addAvailability({ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }, teacher)).toEqual({
        id: 'w1',
        userId: ME,
        date: null,
        dayOfWeek: 1,
        startTime: '08:00',
        endTime: '12:00',
      });
      tx.substituteAvailability.findMany.mockResolvedValue([]);
      await service.availability(OTHER, teacher);
      expect(tx.substituteAvailability.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: ME } }));
      tx.substituteAvailability.deleteMany.mockResolvedValue({ count: 0 });
      await expect(service.removeAvailability('w1', teacher)).rejects.toThrow('Tillgängligheten finns inte.');
    });
  });
});
