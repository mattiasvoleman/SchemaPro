import type { PrismaClient } from '@prisma/client';
import { createTxMock, type TxMock } from '../../test/utils/prisma-mock';
import { rawSql } from '../../test/utils/locking-read';
import { readResourceFacts, readRoomFacts, readStatics } from './external-facts';

const ROOM_ID = '44444444-4444-4444-8444-444444444441';
const RESOURCE_ID = '55555555-5555-4555-8555-555555555551';

describe('the facts a series is checked against', () => {
  let tx: TxMock;
  const client = () => tx as unknown as PrismaClient;

  beforeEach(() => {
    tx = createTxMock();
  });

  describe('readStatics', () => {
    const row = {
      timezone: 'Europe/Stockholm',
      frames: [
        { min: 0, max: 3, day: null, start: '08:00', end: '14:30' },
        { min: 0, max: 3, day: 5, start: '08:00', end: '12:00' },
      ],
      breaks: [
        { kind: 'HOLIDAY', from: '2027-02-15', to: '2027-02-19', min: null, max: null },
        { kind: 'STAFF_DAY', from: '2027-03-01', to: '2027-03-01', min: 4, max: 6 },
      ],
      room: { id: ROOM_ID, name: 'Gymnastiksalen', min: 1, max: 6 },
      resource: null,
      loans: [
        { status: 'APPROVED', roomId: ROOM_ID, localRoomId: null, dayOfWeek: 2, startTime: '16:00', endTime: '18:00', startDate: '2027-01-01', endDate: '2027-06-01' },
      ],
    };

    it('reads the school, the room and the loans in one statement and shapes them as the rules read them', async () => {
      tx.$queryRaw.mockResolvedValue([row]);

      const statics = await readStatics(client(), { roomId: ROOM_ID, resourceId: null }, '2027-02-01', '2027-06-30');

      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
      expect(statics).toEqual({
        timeZone: 'Europe/Stockholm',
        frames: [
          { minGradeLevel: 0, maxGradeLevel: 3, dayOfWeek: null, start: 480, end: 870 },
          { minGradeLevel: 0, maxGradeLevel: 3, dayOfWeek: 5, start: 480, end: 720 },
        ],
        breaks: [
          { kind: 'HOLIDAY', startDate: '2027-02-15', endDate: '2027-02-19', minGradeLevel: null, maxGradeLevel: null },
          { kind: 'STAFF_DAY', startDate: '2027-03-01', endDate: '2027-03-01', minGradeLevel: 4, maxGradeLevel: 6 },
        ],
        room: { id: ROOM_ID, name: 'Gymnastiksalen', years: { min: 1, max: 6 } },
        resource: null,
        loans: row.loans,
      });
    });

    it('binds the period to the lov, and the room and the resource where they are asked', async () => {
      tx.$queryRaw.mockResolvedValue([row]);

      await readStatics(client(), { roomId: ROOM_ID, resourceId: RESOURCE_ID }, '2027-02-01', '2027-06-30');

      const call = tx.$queryRaw.mock.calls[0]!;
      expect(call.slice(1)).toEqual(['2027-06-30', '2027-02-01', ROOM_ID, RESOURCE_ID, ROOM_ID, ROOM_ID]);
      const sql = rawSql(call);
      expect(sql).toContain('"SchoolBreaks"');
      expect(sql).toContain('"RoomLoans"');
    });

    it('answers a resource for a series of a resource, with no room and no loans', async () => {
      tx.$queryRaw.mockResolvedValue([{ ...row, room: null, loans: [], resource: { id: RESOURCE_ID, name: 'Surfplattor', quantity: 30 } }]);

      const statics = await readStatics(client(), { roomId: null, resourceId: RESOURCE_ID }, '2027-02-01', '2027-06-30');

      expect(statics.room).toBeNull();
      expect(statics.resource).toEqual({ id: RESOURCE_ID, name: 'Surfplattor', quantity: 30 });
      expect(statics.loans).toEqual([]);
    });

    it('keeps a room that names no years as one that takes any', async () => {
      tx.$queryRaw.mockResolvedValue([{ ...row, room: { id: ROOM_ID, name: 'Aulan', min: null, max: null } }]);

      const statics = await readStatics(client(), { roomId: ROOM_ID, resourceId: null }, '2027-02-01', '2027-06-30');

      expect(statics.room?.years).toEqual({ min: null, max: null });
    });

    it('falls back to Stockholm when the school names no zone', async () => {
      tx.$queryRaw.mockResolvedValue([{ ...row, timezone: null }]);

      await expect(readStatics(client(), { roomId: ROOM_ID, resourceId: null }, '2027-02-01', '2027-06-30')).resolves.toMatchObject({
        timeZone: 'Europe/Stockholm',
      });
    });

    it('answers an empty school when the statement returns no row at all', async () => {
      tx.$queryRaw.mockResolvedValue([]);

      await expect(readStatics(client(), { roomId: ROOM_ID, resourceId: null }, '2027-02-01', '2027-06-30')).resolves.toEqual({
        timeZone: 'Europe/Stockholm',
        frames: [],
        breaks: [],
        room: null,
        resource: null,
        loans: [],
      });
    });

    it('answers empty lists when the row has none of them', async () => {
      tx.$queryRaw.mockResolvedValue([{ timezone: 'Europe/Stockholm', frames: null, breaks: null, room: null, resource: null, loans: null }]);

      await expect(readStatics(client(), { roomId: ROOM_ID, resourceId: null }, '2027-02-01', '2027-06-30')).resolves.toMatchObject({
        frames: [],
        breaks: [],
        loans: [],
      });
    });
  });

  describe('readRoomFacts', () => {
    const spans = [
      { startsAt: new Date('2027-02-02T17:00:00.000Z'), endsAt: new Date('2027-02-02T19:00:00.000Z') },
      { startsAt: new Date('2027-02-09T17:00:00.000Z'), endsAt: new Date('2027-02-09T19:00:00.000Z') },
    ];
    const none = { date: null, dow: null, smin: null, emin: null };

    it('sorts the rows of one statement into what holds the room, as the spans the rules compare', async () => {
      tx.$queryRaw.mockResolvedValue([
        { kind: 'LESSON', startsAt: new Date('2027-02-02T16:00:00.000Z'), endsAt: new Date('2027-02-02T17:30:00.000Z'), label: 'Idrott 7A', ...none },
        { kind: 'BOOKING', startsAt: new Date('2027-02-02T18:00:00.000Z'), endsAt: new Date('2027-02-02T20:00:00.000Z'), label: 'Extern bokning', ...none },
        { kind: 'ACTIVITY', startsAt: new Date('2027-02-09T17:00:00.000Z'), endsAt: new Date('2027-02-09T18:00:00.000Z'), label: 'Friluftsdag', ...none },
        { kind: 'CLOSED', startsAt: null, endsAt: null, label: 'Golvet slipas', date: '2027-02-09', dow: null, smin: 960, emin: 1200 },
        { kind: 'CLOSED', startsAt: null, endsAt: null, label: 'Städning', date: null, dow: 2, smin: 1080, emin: 1140 },
      ]);

      const facts = await readRoomFacts(client(), ROOM_ID, spans, '2027-02-01', '2027-06-30');

      expect(facts).toEqual({
        lessons: [{ start: Date.parse('2027-02-02T16:00:00.000Z'), end: Date.parse('2027-02-02T17:30:00.000Z'), label: 'Idrott 7A' }],
        bookings: [{ start: Date.parse('2027-02-02T18:00:00.000Z'), end: Date.parse('2027-02-02T20:00:00.000Z'), label: 'Extern bokning' }],
        activities: [{ start: Date.parse('2027-02-09T17:00:00.000Z'), end: Date.parse('2027-02-09T18:00:00.000Z'), label: 'Friluftsdag' }],
        closures: [
          { date: '2027-02-09', dayOfWeek: null, start: 960, end: 1200, reason: 'Golvet slipas' },
          { date: null, dayOfWeek: 2, start: 1080, end: 1140, reason: 'Städning' },
        ],
      });
    });

    it('hands the spans as arrays of instants, and the room and the period where they are asked', async () => {
      await readRoomFacts(client(), ROOM_ID, spans, '2027-02-01', '2027-06-30');

      const call = tx.$queryRaw.mock.calls[0]!;
      expect(call.slice(1)).toEqual([
        ['2027-02-02T17:00:00.000Z', '2027-02-09T17:00:00.000Z'],
        ['2027-02-02T19:00:00.000Z', '2027-02-09T19:00:00.000Z'],
        ROOM_ID,
        ROOM_ID,
        ROOM_ID,
        '2027-02-01',
        '2027-06-30',
      ]);
      const sql = rawSql(call);
      for (const table of ['"CalendarLessons"', '"RoomBookings"', '"ScheduleActivityLessons"', '"AvailabilityConstraints"']) expect(sql).toContain(table);
    });

    it('names a label that is missing as empty and a closure with no minutes as the whole of nothing', async () => {
      tx.$queryRaw.mockResolvedValue([
        { kind: 'LESSON', startsAt: new Date('2027-02-02T16:00:00.000Z'), endsAt: new Date('2027-02-02T17:30:00.000Z'), label: null, ...none },
        { kind: 'CLOSED', startsAt: null, endsAt: null, label: null, date: '2027-02-09', dow: null, smin: null, emin: null },
      ]);

      const facts = await readRoomFacts(client(), ROOM_ID, spans, '2027-02-01', '2027-06-30');

      expect(facts.lessons[0]!.label).toBe('');
      expect(facts.closures).toEqual([{ date: '2027-02-09', dayOfWeek: null, start: 0, end: 0, reason: '' }]);
    });

    it('answers nothing held for a room nothing holds', async () => {
      tx.$queryRaw.mockResolvedValue([]);

      await expect(readRoomFacts(client(), ROOM_ID, spans, '2027-02-01', '2027-06-30')).resolves.toEqual({
        lessons: [],
        bookings: [],
        activities: [],
        closures: [],
      });
    });
  });

  describe('readResourceFacts', () => {
    it('answers the bookings that hold the resource as spans with their quantity', async () => {
      tx.$queryRaw.mockResolvedValue([
        { startsAt: new Date('2027-02-02T17:00:00.000Z'), endsAt: new Date('2027-02-02T19:00:00.000Z'), quantity: 12 },
        { startsAt: new Date('2027-02-09T17:00:00.000Z'), endsAt: new Date('2027-02-09T19:00:00.000Z'), quantity: 1 },
      ]);

      const facts = await readResourceFacts(client(), RESOURCE_ID, [
        { startsAt: new Date('2027-02-02T17:00:00.000Z'), endsAt: new Date('2027-02-02T19:00:00.000Z') },
      ]);

      expect(facts).toEqual([
        { start: Date.parse('2027-02-02T17:00:00.000Z'), end: Date.parse('2027-02-02T19:00:00.000Z'), quantity: 12 },
        { start: Date.parse('2027-02-09T17:00:00.000Z'), end: Date.parse('2027-02-09T19:00:00.000Z'), quantity: 1 },
      ]);
      const call = tx.$queryRaw.mock.calls[0]!;
      expect(call.slice(1)).toEqual([['2027-02-02T17:00:00.000Z'], ['2027-02-02T19:00:00.000Z'], RESOURCE_ID]);
      expect(rawSql(call)).toContain('"ResourceBookings"');
    });

    it('answers nothing for a resource nothing holds', async () => {
      await expect(readResourceFacts(client(), RESOURCE_ID, [])).resolves.toEqual([]);
    });
  });
});
