import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { UtilisationService } from './utilisation.service';

const ROOM_ID = '44444444-4444-4444-8444-444444444441';
const OTHER_ROOM_ID = '44444444-4444-4444-8444-444444444442';
const TABLETS = '55555555-5555-4555-8555-555555555551';

// Stockholm in February is UTC+1; 2027-02-01 is a Monday.
const at = (date: string, clock: string) => new Date(`${date}T${clock}:00+01:00`);
const clock = (value: string) => new Date(`1970-01-01T${value}:00.000Z`);

const frame = (patch: Record<string, unknown> = {}) => ({
  minGradeLevel: 0,
  maxGradeLevel: 12,
  dayOfWeek: null,
  startTime: clock('08:00'),
  endTime: clock('16:00'),
  ...patch,
});

describe('UtilisationService', () => {
  let service: UtilisationService;
  let tx: TxMock;
  let prisma: PrismaMock;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new UtilisationService(prisma as unknown as PrismaService);
    tx.school.findFirst.mockResolvedValue({ timezone: 'Europe/Stockholm' });
    tx.frameTime.findMany.mockResolvedValue([frame()]);
    tx.room.findMany.mockResolvedValue([
      { id: ROOM_ID, name: 'Gymnastiksalen', minGradeLevel: null, maxGradeLevel: null },
      { id: OTHER_ROOM_ID, name: 'Aulan', minGradeLevel: null, maxGradeLevel: null },
    ]);
    tx.resource.findMany.mockResolvedValue([{ id: TABLETS, name: 'Surfplattor', quantity: 30 }]);
  });

  const week = { from: '2027-02-01', to: '2027-02-07' };

  describe('the question', () => {
    it.each([
      ['a from that is not a date', { from: '1 feb', to: '2027-02-07' }, 'from and to must be YYYY-MM-DD.'],
      ['a to that is not a date', { from: '2027-02-01', to: '' }, 'from and to must be YYYY-MM-DD.'],
      ['a to before the from', { from: '2027-02-07', to: '2027-02-01' }, 'to must not be before from.'],
      ['a period of 401 days', { from: '2026-01-01', to: '2027-02-05' }, 'A report covers at most 400 days.'],
      ['an openFrom that is not a clock', { ...week, openFrom: '7' }, 'openFrom and openTo must be HH:MM with openTo after openFrom.'],
      ['an openTo that is not a clock', { ...week, openTo: '24:00' }, 'openFrom and openTo must be HH:MM with openTo after openFrom.'],
      ['an openTo equal to openFrom', { ...week, openFrom: '08:00', openTo: '08:00' }, 'openFrom and openTo must be HH:MM with openTo after openFrom.'],
      ['an openTo before openFrom', { ...week, openFrom: '18:00', openTo: '08:00' }, 'openFrom and openTo must be HH:MM with openTo after openFrom.'],
    ])('refuses %s with a 400 before reading anything', async (_label, query, message) => {
      await expect(service.report(query, testUser())).rejects.toThrow(new BadRequestException(message));
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('takes a period of exactly 400 days, and one of a single day', async () => {
      await expect(service.report({ from: '2026-01-01', to: '2027-02-04' }, testUser())).resolves.toMatchObject({ from: '2026-01-01', to: '2027-02-04' });
      const one = await service.report({ from: '2027-02-02', to: '2027-02-02' }, testUser());
      expect(one.weekStarts).toEqual(['2027-02-01']);
    });

    it('refuses a principal with no school', async () => {
      await expect(service.report(week, { ...testUser(), schoolId: undefined })).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('the answer', () => {
    it('is the period, the school’s zone, the open hours it was measured against, and a row per room and resource', async () => {
      const report = await service.report(week, testUser());

      expect(report).toMatchObject({
        from: '2027-02-01',
        to: '2027-02-07',
        timezone: 'Europe/Stockholm',
        openFrom: '07:00',
        openTo: '22:00',
        framesMissing: false,
        weekStarts: ['2027-02-01'],
      });
      expect(report.rows.map((row) => [row.kind, row.name, row.unit])).toEqual([
        ['ROOM', 'Gymnastiksalen', 'MINUTES'],
        ['ROOM', 'Aulan', 'MINUTES'],
        ['RESOURCE', 'Surfplattor', 'UNIT_MINUTES'],
      ]);
      // Five teaching days of eight hours, a room or thirty tablets.
      expect(report.rows[0]!.total.schoolMinutes).toBe(5 * 8 * 60);
      expect(report.rows[2]!.total.schoolMinutes).toBe(5 * 8 * 60 * 30);
    });

    it('measures against the open hours it is asked for', async () => {
      const report = await service.report({ ...week, openFrom: '06:30', openTo: '23:15' }, testUser());

      expect(report).toMatchObject({ openFrom: '06:30', openTo: '23:15' });
    });

    it('counts what holds a room: a lesson that holds its time and an approved booking, each in its own room', async () => {
      tx.calendarLesson.findMany.mockResolvedValue([
        { roomId: ROOM_ID, startsAt: at('2027-02-02', '09:00'), endsAt: at('2027-02-02', '11:00') },
        // A lesson in a room the school no longer lists holds nothing of the listed ones.
        { roomId: '44444444-4444-4444-8444-4444444444ff', startsAt: at('2027-02-02', '09:00'), endsAt: at('2027-02-02', '11:00') },
      ]);
      tx.roomBooking.findMany.mockResolvedValue([
        { roomId: ROOM_ID, startsAt: at('2027-02-02', '18:00'), endsAt: at('2027-02-02', '20:00') },
        { roomId: '44444444-4444-4444-8444-4444444444ff', startsAt: at('2027-02-02', '18:00'), endsAt: at('2027-02-02', '20:00') },
      ]);

      const report = await service.report(week, testUser());

      const [gym, aula] = report.rows;
      expect(gym!.total.bookedSchoolMinutes).toBe(120);
      expect(gym!.total.bookedOutsideMinutes).toBe(120);
      expect(aula!.total.bookedSchoolMinutes).toBe(0);
      expect(aula!.total.bookedOutsideMinutes).toBe(0);
    });

    it('asks for lessons that hold their time and bookings that are approved, inside the period on the school’s clock', async () => {
      await service.report(week, testUser());

      const overlap = {
        startsAt: { lt: new Date('2027-02-07T23:00:00.000Z') },
        endsAt: { gt: new Date('2027-01-31T23:00:00.000Z') },
      };
      expect(tx.calendarLesson.findMany.mock.calls[0]![0].where).toEqual({
        roomId: { not: null },
        status: { in: ['SCHEDULED', 'COMPLETED'] },
        ...overlap,
      });
      expect(tx.roomBooking.findMany.mock.calls[0]![0].where).toEqual({ status: 'APPROVED', ...overlap });
      expect(tx.resourceBooking.findMany.mock.calls[0]![0].where).toEqual({ status: 'APPROVED', ...overlap });
    });

    it('counts the units a booking holds of a resource', async () => {
      tx.resourceBooking.findMany.mockResolvedValue([
        { resourceId: TABLETS, quantity: 10, startsAt: at('2027-02-03', '09:00'), endsAt: at('2027-02-03', '10:00') },
        { resourceId: '55555555-5555-4555-8555-5555555555ff', quantity: 10, startsAt: at('2027-02-03', '09:00'), endsAt: at('2027-02-03', '10:00') },
      ]);

      const report = await service.report(week, testUser());

      expect(report.rows[2]!.total.bookedSchoolMinutes).toBe(10 * 60);
    });

    it('reads the room’s years, so a room for the youngest has the youngest’s school time', async () => {
      tx.room.findMany.mockResolvedValue([{ id: ROOM_ID, name: 'Lågstadiesalen', minGradeLevel: 1, maxGradeLevel: 3 }]);
      tx.frameTime.findMany.mockResolvedValue([
        frame({ minGradeLevel: 1, maxGradeLevel: 3, startTime: clock('08:00'), endTime: clock('12:00') }),
        frame({ minGradeLevel: 7, maxGradeLevel: 9 }),
      ]);

      const report = await service.report({ ...week, kind: 'ROOM' }, testUser());

      expect(report.rows[0]!.total.schoolMinutes).toBe(5 * 4 * 60);
    });

    it('takes the frames off a lov for the whole school, and off nothing for a studiedag or a lov for some years', async () => {
      tx.school.findFirst.mockResolvedValue(null);
      tx.schoolBreak.findMany.mockResolvedValue([
        { kind: 'HOLIDAY', startDate: new Date('2027-02-02T00:00:00.000Z'), endDate: new Date('2027-02-02T00:00:00.000Z'), minGradeLevel: null, maxGradeLevel: null },
        { kind: 'STAFF_DAY', startDate: new Date('2027-02-03T00:00:00.000Z'), endDate: new Date('2027-02-03T00:00:00.000Z'), minGradeLevel: null, maxGradeLevel: null },
        { kind: 'HOLIDAY', startDate: new Date('2027-02-04T00:00:00.000Z'), endDate: new Date('2027-02-04T00:00:00.000Z'), minGradeLevel: 4, maxGradeLevel: 6 },
      ]);

      const report = await service.report({ ...week, kind: 'ROOM' }, testUser());

      expect(report.timezone).toBe('Europe/Stockholm');
      expect(report.rows[0]!.total.schoolMinutes).toBe(4 * 8 * 60);
      expect(tx.schoolBreak.findMany.mock.calls[0]![0].where).toEqual({
        startDate: { lte: new Date('2027-02-07T00:00:00.000Z') },
        endDate: { gte: new Date('2027-02-01T00:00:00.000Z') },
      });
    });

    it('says that the school has declared no ramtider, and has no school share to give', async () => {
      tx.frameTime.findMany.mockResolvedValue([]);

      const report = await service.report({ ...week, kind: 'ROOM' }, testUser());

      expect(report.framesMissing).toBe(true);
      expect(report.rows[0]!.total).toMatchObject({ schoolMinutes: 0, schoolShare: null });
    });

    it('uses the school’s own zone for the day', async () => {
      tx.school.findFirst.mockResolvedValue({ timezone: 'America/New_York' });
      tx.room.findMany.mockResolvedValue([{ id: ROOM_ID, name: 'Gymnastiksalen', minGradeLevel: null, maxGradeLevel: null }]);

      await service.report({ ...week, kind: 'ROOM' }, testUser());

      // Midnight in New York (UTC-5) on the first day, and the day after the last.
      expect(tx.roomBooking.findMany.mock.calls[0]![0].where.endsAt).toEqual({ gt: new Date('2027-02-01T05:00:00.000Z') });
      expect(tx.roomBooking.findMany.mock.calls[0]![0].where.startsAt).toEqual({ lt: new Date('2027-02-08T05:00:00.000Z') });
    });
  });

  describe('kind', () => {
    it('reads rooms alone for ROOM', async () => {
      const report = await service.report({ ...week, kind: 'ROOM' }, testUser());

      expect(report.rows.map((row) => row.kind)).toEqual(['ROOM', 'ROOM']);
      expect(tx.resource.findMany).not.toHaveBeenCalled();
      expect(tx.resourceBooking.findMany).not.toHaveBeenCalled();
    });

    it('reads resources alone for RESOURCE', async () => {
      const report = await service.report({ ...week, kind: 'RESOURCE' }, testUser());

      expect(report.rows.map((row) => row.kind)).toEqual(['RESOURCE']);
      expect(tx.room.findMany).not.toHaveBeenCalled();
      expect(tx.calendarLesson.findMany).not.toHaveBeenCalled();
      expect(tx.roomBooking.findMany).not.toHaveBeenCalled();
    });

    it('reads both for ALL, and for none given', async () => {
      const all = await service.report({ ...week, kind: 'ALL' }, testUser());
      const none = await service.report(week, testUser());

      expect(all.rows).toHaveLength(3);
      expect(none.rows).toHaveLength(3);
    });
  });
});
