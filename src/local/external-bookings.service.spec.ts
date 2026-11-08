import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import { rawSql } from '../../test/utils/locking-read';
import type { PrismaService } from '../database/prisma.service';
import { EXTERNAL_BOOKING_CONFLICTS, EXTERNAL_DAY_TITLE, ExternalBookingsService } from './external-bookings.service';

/*
 * The service against a database that answers the way the statements are worded: the raw statements
 * (the school's facts, what holds the room, the counts of a series, the clashes) are told apart by
 * their text, the models are the shared mock's. The real database's word on the same flows is the
 * adapter probe (scripts/test/probe-lokal.ts) and RLS sections 440-444.
 */

// A Wednesday. Stockholm is UTC+1 in the winter, so the school's clock is an hour ahead.
const NOW = new Date('2027-01-20T10:00:00.000Z');
const ROOM_ID = '44444444-4444-4444-8444-444444444441';
const RESOURCE_ID = '44444444-4444-4444-8444-444444444442';
const SERIES_ID = '55555555-5555-4555-8555-555555555551';
const DAY_ID = '66666666-6666-4666-8666-666666666661';
const REGISTRAR_ID = testUser().userId as string;
const OTHER_PERSON_ID = '77777777-7777-4777-8777-777777777777';
const SCHOOL_ID = testUser().schoolId as string;

const knownError = (code: string, message: string) =>
  new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: Prisma.prismaVersion.client });

/** The room's exclusion constraint refusing a second active booking, as the adapter re-wraps it. */
const roomHeldOnce = () =>
  knownError('P2039', 'Database error. Code: `23P01`. Message: `conflicting key value violates exclusion constraint "RoomBookings_room_is_held_once"`');

/** The quantity trigger refusing one booking too many. */
const quantityUsed = () => knownError('P2039', 'Database error. Code: `23P01`. Message: `ResourceBookings_quantity_is_kept: 41 of 30`');

const clockOf = (value: string) => new Date(`1970-01-01T${value}:00.000Z`);
const dateOf = (value: string) => new Date(`${value}T00:00:00.000Z`);

interface World {
  statics: Record<string, unknown>;
  facts: Array<Record<string, unknown>>;
  resourceFacts: Array<Record<string, unknown>>;
  counts: Array<Record<string, unknown>>;
  clashes: Array<Record<string, unknown>>;
  late: Array<{ startsAt: Date; endsAt: Date; lesson: string }>;
}

const freshWorld = (): World => ({
  statics: { timezone: 'Europe/Stockholm', frames: [], breaks: [], room: { id: ROOM_ID, name: 'Gymnastiksalen', min: null, max: null }, resource: null, loans: [] },
  facts: [],
  resourceFacts: [],
  counts: [],
  clashes: [],
  late: [],
});

const noFacts = { date: null, dow: null, smin: null, emin: null };

/** A series row as the service's select returns it. */
const seriesRow = (patch: Record<string, unknown> = {}) => ({
  id: SERIES_ID,
  roomId: ROOM_ID,
  resourceId: null,
  resourceQuantity: null,
  organisation: 'Idrottsföreningen',
  contactName: 'Kim Kontakt',
  contactPhone: '070-1234567',
  contactEmail: 'kim@forening.example',
  purpose: 'Träning',
  note: null,
  weekdays: [2],
  intervalWeeks: 1,
  startDate: dateOf('2027-02-02'),
  endDate: dateOf('2027-02-23'),
  startTime: clockOf('18:00'),
  endTime: clockOf('20:00'),
  skippedDates: [] as Date[],
  cancelledAt: null,
  registeredById: REGISTRAR_ID,
  createdAt: new Date('2027-01-19T12:00:00.000Z'),
  room: { name: 'Gymnastiksalen' },
  resource: null,
  ...patch,
});

describe('ExternalBookingsService', () => {
  let service: ExternalBookingsService;
  let tx: TxMock;
  let prisma: PrismaMock;
  let world: World;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new ExternalBookingsService(prisma as unknown as PrismaService);
    world = freshWorld();
    tx.$queryRaw.mockImplementation((...call: unknown[]) => {
      const sql = rawSql(call);
      if (sql.includes('AS "timezone"')) return Promise.resolve([world.statics]);
      if (sql.includes('late lessons')) return Promise.resolve(world.late);
      if (sql.includes(`'LESSON' AS "kind"`)) return Promise.resolve(world.facts);
      if (sql.includes('SELECT DISTINCT b."id"')) return Promise.resolve(world.resourceFacts);
      if (sql.includes('count(*)::int AS "total"')) return Promise.resolve(world.counts);
      if (sql.includes('JOIN "ExternalBookings" x')) return Promise.resolve(world.clashes);
      throw new Error(`Unexpected statement: ${sql}`);
    });
    tx.school.findFirst.mockResolvedValue({ timezone: 'Europe/Stockholm' });
    tx.externalBooking.create.mockResolvedValue({ id: SERIES_ID });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /** Every Tuesday 18-20 for four weeks: the 2nd, 9th, 16th and 23rd of February. */
  const roomRule = (patch: Record<string, unknown> = {}) => ({
    target: 'ROOM' as const,
    roomId: ROOM_ID,
    weekdays: [2],
    startDate: '2027-02-02',
    endDate: '2027-02-23',
    startTime: '18:00',
    endTime: '20:00',
    ...patch,
  });

  const resourceRule = (patch: Record<string, unknown> = {}) =>
    roomRule({ target: 'RESOURCE', roomId: undefined, resourceId: RESOURCE_ID, resourceQuantity: 10, ...patch });

  const giveResource = (quantity = 30) => {
    world.statics = { ...world.statics, room: null, resource: { id: RESOURCE_ID, name: 'Surfplattor', quantity } };
  };

  const lesson = (date: string, from: string, to: string, label = 'Idrott 7A') => ({
    kind: 'LESSON',
    startsAt: new Date(`${date}T${from}:00.000Z`),
    endsAt: new Date(`${date}T${to}:00.000Z`),
    label,
    ...noFacts,
  });

  const create = (patch: Record<string, unknown> = {}, user = testUser()) =>
    service.create(
      { ...roomRule(), organisation: ' Idrottsföreningen ', contactName: ' Kim Kontakt ', contactPhone: '070-1234567', ...patch } as never,
      user,
    );

  // -----------------------------------------------------------------------
  // preview
  // -----------------------------------------------------------------------

  describe('preview', () => {
    it('names the days of the rule on the school’s clock, each with what stands in its way', async () => {
      world.facts = [lesson('2027-02-09', '17:30', '18:30')];

      const result = await service.preview(roomRule() as never, testUser());

      expect(result).toEqual({
        occurrences: [
          { date: '2027-02-02', startsAt: '2027-02-02T17:00:00.000Z', endsAt: '2027-02-02T19:00:00.000Z', conflicts: [] },
          { date: '2027-02-09', startsAt: '2027-02-09T17:00:00.000Z', endsAt: '2027-02-09T19:00:00.000Z', conflicts: [{ kind: 'LESSON', severity: 'BLOCK', label: 'Idrott 7A' }] },
          { date: '2027-02-16', startsAt: '2027-02-16T17:00:00.000Z', endsAt: '2027-02-16T19:00:00.000Z', conflicts: [] },
          { date: '2027-02-23', startsAt: '2027-02-23T17:00:00.000Z', endsAt: '2027-02-23T19:00:00.000Z', conflicts: [] },
        ],
        count: 4,
        blocked: 1,
        warned: 0,
        framesMissing: true,
      });
      expect(tx.externalBooking.create).not.toHaveBeenCalled();
      expect(tx.roomBooking.createMany).not.toHaveBeenCalled();
    });

    it('counts a day that is only warned about apart from a day that is refused', async () => {
      world.facts = [
        { kind: 'ACTIVITY', startsAt: new Date('2027-02-16T17:00:00.000Z'), endsAt: new Date('2027-02-16T18:00:00.000Z'), label: 'Friluftsdag', ...noFacts },
        { kind: 'BOOKING', startsAt: new Date('2027-02-23T17:30:00.000Z'), endsAt: new Date('2027-02-23T18:30:00.000Z'), label: 'Vaktmästarens bokning', ...noFacts },
        { kind: 'CLOSED', startsAt: null, endsAt: null, label: 'Golvet slipas', date: '2027-02-09', dow: null, smin: 1080, emin: 1200 },
      ];

      const result = await service.preview(roomRule() as never, testUser());

      expect(result.blocked).toBe(2);
      expect(result.warned).toBe(1);
      expect(result.occurrences[1]!.conflicts).toEqual([{ kind: 'CLOSED', severity: 'BLOCK', label: 'Golvet slipas' }]);
      expect(result.occurrences[2]!.conflicts).toEqual([{ kind: 'ACTIVITY', severity: 'WARN', label: 'Friluftsdag' }]);
      expect(result.occurrences[3]!.conflicts).toEqual([{ kind: 'BOOKING', severity: 'BLOCK', label: 'Vaktmästarens bokning' }]);
    });

    it('asks the ramtid only of a school that has declared one, and lets a lov take the frames off its day', async () => {
      world.statics = {
        ...world.statics,
        frames: [{ min: 0, max: 12, day: null, start: '08:00', end: '16:00' }],
        breaks: [{ kind: 'HOLIDAY', from: '2027-02-16', to: '2027-02-16', min: null, max: null }],
      };

      // 15:00-17:00 runs into the ramtid until 16:00, except on the day of the lov.
      const result = await service.preview(roomRule({ startTime: '15:00', endTime: '17:00' }) as never, testUser());

      expect(result.framesMissing).toBe(false);
      expect(result.blocked).toBe(3);
      expect(result.occurrences[0]!.conflicts).toEqual([{ kind: 'FRAME', severity: 'BLOCK', label: '08:00-16:00' }]);
      expect(result.occurrences[2]!.conflicts).toEqual([]);
    });

    it('takes the years the room may host into the ramtid', async () => {
      world.statics = {
        ...world.statics,
        room: { id: ROOM_ID, name: 'Lågstadiesalen', min: 1, max: 3 },
        frames: [
          { min: 1, max: 3, day: null, start: '08:00', end: '12:00' },
          { min: 7, max: 9, day: null, start: '08:00', end: '16:00' },
        ],
      };

      const result = await service.preview(roomRule({ startTime: '13:00', endTime: '15:00' }) as never, testUser());

      expect(result.blocked).toBe(0);
    });

    it('refuses what a loan of the room gives another school, and only when the room has loans', async () => {
      world.statics = {
        ...world.statics,
        loans: [
          { status: 'APPROVED', roomId: ROOM_ID, localRoomId: '88888888-8888-4888-8888-888888888888', dayOfWeek: 2, startTime: '17:00', endTime: '21:00', startDate: '2027-02-09', endDate: '2027-02-16' },
        ],
      };

      const result = await service.preview(roomRule() as never, testUser());

      expect(result.occurrences.map((day) => day.conflicts)).toEqual([
        [],
        [{ kind: 'LOAN', severity: 'BLOCK', label: 'ROOM_LENT' }],
        [{ kind: 'LOAN', severity: 'BLOCK', label: 'ROOM_LENT' }],
        [],
      ]);
    });

    it('keeps every other week from the week of the first date, the weekdays in order', async () => {
      const result = await service.preview(roomRule({ weekdays: [4, 2], intervalWeeks: 2 }) as never, testUser());

      expect(result.occurrences.map((day) => day.date)).toEqual(['2027-02-02', '2027-02-04', '2027-02-16', '2027-02-18']);
    });

    it('checks a resource against what its bookings hold and the quantity there is', async () => {
      giveResource(30);
      world.resourceFacts = [{ startsAt: new Date('2027-02-09T17:00:00.000Z'), endsAt: new Date('2027-02-09T19:00:00.000Z'), quantity: 25 }];

      const result = await service.preview(resourceRule() as never, testUser());

      expect(result.blocked).toBe(1);
      expect(result.occurrences[1]!.conflicts).toEqual([{ kind: 'BOOKING', severity: 'BLOCK', label: '25 av 30' }]);
      // A resource has no lessons, loans or closures to ask about.
      const sql = tx.$queryRaw.mock.calls.map((call) => rawSql(call));
      expect(sql.some((text) => text.includes(`'LESSON' AS "kind"`))).toBe(false);
    });

    it('asks for one of a resource when the series says no quantity', async () => {
      giveResource(30);
      world.resourceFacts = [{ startsAt: new Date('2027-02-09T17:00:00.000Z'), endsAt: new Date('2027-02-09T19:00:00.000Z'), quantity: 30 }];

      const result = await service.preview(resourceRule({ resourceQuantity: undefined }) as never, testUser());

      expect(result.blocked).toBe(1);
    });

    it('starts today, and a series that begins today is not in the past', async () => {
      const result = await service.preview(roomRule({ startDate: '2027-01-20', endDate: '2027-01-20', weekdays: [3] }) as never, testUser());

      expect(result.count).toBe(1);
    });

    it('reckons today on the school’s zone, which is already tomorrow at 00:30', async () => {
      // 23:30 UTC on the 20th is 00:30 on the 21st in Stockholm.
      jest.setSystemTime(new Date('2027-01-20T23:30:00.000Z'));

      await expect(service.preview(roomRule({ startDate: '2027-01-20', endDate: '2027-01-20', weekdays: [3] }) as never, testUser())).rejects.toThrow(
        new BadRequestException('A series cannot start in the past.'),
      );
    });

    describe('what it refuses', () => {
      it.each([
        ['an end date before the start', roomRule({ endDate: '2027-02-01' }), 'endDate must not be before startDate.'],
        ['a series of more than 400 days', roomRule({ endDate: '2028-03-09' }), 'A series is at most 400 days.'],
        ['an end time that is not after the start', roomRule({ endTime: '18:00' }), 'endTime must be after startTime.'],
        ['a room series that names no room', roomRule({ roomId: undefined }), 'A room series names a room and no resource.'],
        ['a room series that also names a resource', roomRule({ resourceId: RESOURCE_ID }), 'A room series names a room and no resource.'],
        ['a resource series that names no resource', resourceRule({ resourceId: undefined }), 'A resource series names a resource and no room.'],
        ['a resource series that also names a room', resourceRule({ roomId: ROOM_ID }), 'A resource series names a resource and no room.'],
      ])('refuses %s with a 400, before it reads the school', async (_label, rule, message) => {
        await expect(service.preview(rule as never, testUser())).rejects.toThrow(new BadRequestException(message));
        expect(tx.$queryRaw).not.toHaveBeenCalled();
      });

      it('takes a series of exactly 400 days', async () => {
        // 2027-02-02 + 400 days = 2028-03-08.
        await expect(service.preview(roomRule({ endDate: '2028-03-08' }) as never, testUser())).resolves.toMatchObject({ count: 58 });
      });

      it('refuses a series that starts in the past', async () => {
        await expect(service.preview(roomRule({ startDate: '2027-01-19', endDate: '2027-02-23' }) as never, testUser())).rejects.toThrow(
          new BadRequestException('A series cannot start in the past.'),
        );
      });

      it('refuses a room that is not the school’s', async () => {
        world.statics = { ...world.statics, room: null };

        await expect(service.preview(roomRule() as never, testUser())).rejects.toThrow(new BadRequestException('Room not found.'));
      });

      it('refuses a resource that is not the school’s', async () => {
        world.statics = { ...world.statics, resource: null };

        await expect(service.preview(resourceRule() as never, testUser())).rejects.toThrow(new BadRequestException('Resource not found.'));
      });

      it('refuses more of a resource than there are, saying how many there are', async () => {
        giveResource(30);

        await expect(service.preview(resourceRule({ resourceQuantity: 31 }) as never, testUser())).rejects.toThrow(
          new BadRequestException('Det finns bara 30 av resursen.'),
        );
      });

      it('refuses a rule that gives no day', async () => {
        // Only Tuesday the 2nd is in the range, and the rule asks for Mondays.
        await expect(service.preview(roomRule({ startDate: '2027-02-02', endDate: '2027-02-02', weekdays: [1] }) as never, testUser())).rejects.toThrow(
          new BadRequestException('Regeln ger inga dagar.'),
        );
      });

      it('refuses a principal with no school', async () => {
        await expect(service.preview(roomRule() as never, { ...testUser(), schoolId: undefined })).rejects.toBeInstanceOf(ForbiddenException);
      });
    });

    it('binds the room and the period to the statements, and nothing the caller typed into the text of one', async () => {
      await service.preview(roomRule() as never, testUser());

      const statics = tx.$queryRaw.mock.calls.find((call) => rawSql(call).includes('AS "timezone"'))!;
      expect(statics.slice(1)).toEqual(['2027-02-23', '2027-02-02', ROOM_ID, null, ROOM_ID, ROOM_ID]);
    });
  });

  // -----------------------------------------------------------------------
  // create
  // -----------------------------------------------------------------------

  describe('create', () => {
    it('registers the series and writes its days as ordinary approved bookings that carry its id', async () => {
      await expect(create({ purpose: ' Träning ', note: '  ', contactEmail: ' kim@forening.example ' })).resolves.toEqual({ id: SERIES_ID, created: 4, skipped: [] });

      expect(tx.externalBooking.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          roomId: ROOM_ID,
          organisation: 'Idrottsföreningen',
          contactName: 'Kim Kontakt',
          contactPhone: '070-1234567',
          contactEmail: 'kim@forening.example',
          purpose: 'Träning',
          note: null,
          weekdays: [2],
          intervalWeeks: 1,
          startDate: dateOf('2027-02-02'),
          endDate: dateOf('2027-02-23'),
          startTime: clockOf('18:00'),
          endTime: clockOf('20:00'),
          skippedDates: [],
          registeredById: REGISTRAR_ID,
        },
        select: { id: true },
      });
      const rows = tx.roomBooking.createMany.mock.calls[0]![0].data as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(4);
      expect(rows[0]).toEqual({
        schoolId: SCHOOL_ID,
        bookedById: REGISTRAR_ID,
        title: EXTERNAL_DAY_TITLE,
        startsAt: new Date('2027-02-02T17:00:00.000Z'),
        endsAt: new Date('2027-02-02T19:00:00.000Z'),
        status: 'APPROVED',
        externalBookingId: SERIES_ID,
        roomId: ROOM_ID,
      });
      expect(tx.resourceBooking.createMany).not.toHaveBeenCalled();
    });

    it('writes the days of a resource with the quantity the hirer holds', async () => {
      giveResource(30);

      await expect(create(resourceRule({ roomId: undefined }))).resolves.toEqual({ id: SERIES_ID, created: 4, skipped: [] });

      expect(tx.externalBooking.create.mock.calls[0]![0].data).toMatchObject({ resourceId: RESOURCE_ID, resourceQuantity: 10 });
      expect(tx.externalBooking.create.mock.calls[0]![0].data).not.toHaveProperty('roomId');
      const rows = tx.resourceBooking.createMany.mock.calls[0]![0].data as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(4);
      expect(rows[0]).toMatchObject({ resourceId: RESOURCE_ID, quantity: 10, status: 'APPROVED', externalBookingId: SERIES_ID });
      expect(tx.roomBooking.createMany).not.toHaveBeenCalled();
    });

    it('takes the contact with a telephone number alone, or an address alone', async () => {
      await create({ contactPhone: undefined, contactEmail: 'kim@forening.example' });
      expect(tx.externalBooking.create.mock.calls[0]![0].data).toMatchObject({ contactPhone: null, contactEmail: 'kim@forening.example' });

      await create({ contactPhone: ' 070-1234567 ', contactEmail: null });
      expect(tx.externalBooking.create.mock.calls[1]![0].data).toMatchObject({ contactPhone: '070-1234567', contactEmail: null });
    });

    it.each([
      ['neither', {}],
      ['two blanks', { contactPhone: '   ', contactEmail: '' }],
      ['two nulls', { contactPhone: null, contactEmail: null }],
    ])('refuses a contact with %s a telephone number or an address, before the database is asked', async (_label, patch) => {
      await expect(create({ contactPhone: undefined, ...patch })).rejects.toThrow(
        new BadRequestException('Ange telefonnummer eller e-postadress till kontaktpersonen.'),
      );
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('refuses a principal with no school or no user row before anything else', async () => {
      await expect(create({}, { ...testUser(), schoolId: undefined })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(create({}, { ...testUser(), userId: undefined })).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    describe('when days are refused', () => {
      beforeEach(() => {
        world.facts = [lesson('2027-02-09', '17:30', '18:30', 'Idrott 7A'), lesson('2027-02-23', '17:00', '19:00', 'Idrott 8B')];
      });

      it('refuses the whole series with a 409 that names the days and what holds them, and writes nothing', async () => {
        const error = await create().catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toEqual({
          message: 'Några dagar går inte att boka.',
          code: EXTERNAL_BOOKING_CONFLICTS,
          // Problem JSON forwards `code` and flat `params` only: the number of days is what reaches the web.
          params: { blocked: 2 },
          conflicts: [
            { date: '2027-02-09', conflicts: [{ kind: 'LESSON', severity: 'BLOCK', label: 'Idrott 7A' }] },
            { date: '2027-02-23', conflicts: [{ kind: 'LESSON', severity: 'BLOCK', label: 'Idrott 8B' }] },
          ],
        });
        expect(tx.externalBooking.create).not.toHaveBeenCalled();
        expect(tx.roomBooking.createMany).not.toHaveBeenCalled();
      });

      it('books the days that are free when the expedition says to skip the others, and names the ones left out', async () => {
        await expect(create({ skipConflicts: true })).resolves.toEqual({
          id: SERIES_ID,
          created: 2,
          skipped: [
            { date: '2027-02-09', conflicts: [{ kind: 'LESSON', severity: 'BLOCK', label: 'Idrott 7A' }] },
            { date: '2027-02-23', conflicts: [{ kind: 'LESSON', severity: 'BLOCK', label: 'Idrott 8B' }] },
          ],
        });

        expect(tx.externalBooking.create.mock.calls[0]![0].data.skippedDates).toEqual([dateOf('2027-02-09'), dateOf('2027-02-23')]);
        const rows = tx.roomBooking.createMany.mock.calls[0]![0].data as Array<{ startsAt: Date }>;
        expect(rows.map((row) => row.startsAt.toISOString())).toEqual(['2027-02-02T17:00:00.000Z', '2027-02-16T17:00:00.000Z']);
      });

      it('still refuses when skipping would leave no day at all', async () => {
        world.facts = ['02', '09', '16', '23'].map((day) => lesson(`2027-02-${day}`, '17:00', '19:00'));

        const error = await create({ skipConflicts: true }).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toMatchObject({ message: 'Ingen dag går att boka.', code: EXTERNAL_BOOKING_CONFLICTS, params: { blocked: 4 } });
        expect(((error as ConflictException).getResponse() as { conflicts: unknown[] }).conflicts).toHaveLength(4);
        expect(tx.externalBooking.create).not.toHaveBeenCalled();
      });

      it('does not skip anything when skipConflicts is false', async () => {
        await expect(create({ skipConflicts: false })).rejects.toBeInstanceOf(ConflictException);
      });
    });

    it('books a day that is only warned about, and leaves it out of the skipped', async () => {
      world.facts = [{ kind: 'ACTIVITY', startsAt: new Date('2027-02-16T17:00:00.000Z'), endsAt: new Date('2027-02-16T18:00:00.000Z'), label: 'Friluftsdag', ...noFacts }];

      await expect(create()).resolves.toEqual({ id: SERIES_ID, created: 4, skipped: [] });
    });

    it('refuses a series whose rule is wrong as the plan does', async () => {
      await expect(create({ endTime: '17:00' })).rejects.toThrow(new BadRequestException('endTime must be after startTime.'));
      expect(tx.externalBooking.create).not.toHaveBeenCalled();
    });

    describe('a lesson that landed while the days were written', () => {
      const lateLesson = { startsAt: new Date('2027-02-09T17:00:00.000Z'), endsAt: new Date('2027-02-09T19:00:00.000Z'), lesson: 'Idrott 7A' };

      it('is found after the writes and refuses the series, naming the day and the lesson', async () => {
        world.late = [lateLesson];

        const error = await create().catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toEqual({
          message: 'En lektion lades in medan bokningen registrerades.',
          code: EXTERNAL_BOOKING_CONFLICTS,
          params: { blocked: 1 },
          conflicts: [{ date: '2027-02-09', conflicts: [{ kind: 'LESSON', severity: 'BLOCK', label: 'Idrott 7A' }] }],
        });
        // Asked for after the days were written, and no more than a handful.
        const at = tx.$queryRaw.mock.calls.findIndex((call) => rawSql(call).includes('late lessons'));
        expect(tx.roomBooking.createMany.mock.invocationCallOrder[0]!).toBeLessThan(tx.$queryRaw.mock.invocationCallOrder[at]!);
        expect(tx.$queryRaw.mock.calls[at]!.slice(1)).toEqual([expect.any(Array), expect.any(Array), ROOM_ID, 5]);
      });

      it('is asked for with the room and the days that were written, and no others', async () => {
        await create();

        const asked = tx.$queryRaw.mock.calls.find((call) => rawSql(call).includes('late lessons'))!;
        const [starts, , room] = asked.slice(1) as [string[], string[], string];
        const written = (tx.roomBooking.createMany.mock.calls[0]![0] as { data: Array<{ startsAt: Date }> }).data.map((row) => row.startsAt.toISOString());
        expect(room).toBe(ROOM_ID);
        expect(starts).toEqual(written);
      });

      it('is not asked for when the days are a resource’s: lessons hold rooms', async () => {
        giveResource(30);

        await create(resourceRule({ roomId: undefined }));

        expect(tx.$queryRaw.mock.calls.some((call) => rawSql(call).includes('late lessons'))).toBe(false);
      });
    });

    describe('a race the preview could not see', () => {
      const raced = 'Något annat bokade samma tid medan serien registrerades. Förhandsgranska igen.';

      it('answers 409 with the conflicts code when the room’s constraint refuses a day', async () => {
        tx.roomBooking.createMany.mockRejectedValue(roomHeldOnce());

        const error = await create().catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toEqual({ message: raced, code: EXTERNAL_BOOKING_CONFLICTS, params: { blocked: 0 }, conflicts: [] });
      });

      it('answers the same when the quantity of a resource is used up', async () => {
        giveResource(30);
        tx.resourceBooking.createMany.mockRejectedValue(quantityUsed());

        const error = await create(resourceRule({ roomId: undefined })).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toEqual({ message: raced, code: EXTERNAL_BOOKING_CONFLICTS, params: { blocked: 0 }, conflicts: [] });
      });

      it('does not take another database refusal for it, but gives that one its own answer', async () => {
        tx.roomBooking.createMany.mockRejectedValue(knownError('P2003', 'Foreign key constraint violated'));

        const error = await create().catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).message).toBe('The operation references a record that does not exist.');
      });

      it('lets an error that nothing maps through unchanged, a P2039 of another constraint among them', async () => {
        const other = knownError('P2039', 'Database error. Code: `23P01`. Message: `some_other_constraint`');
        tx.roomBooking.createMany.mockRejectedValue(other);
        await expect(create()).rejects.toBe(other);

        const plain = new Error('connection reset');
        tx.roomBooking.createMany.mockRejectedValue(plain);
        await expect(create()).rejects.toBe(plain);
      });

      it('maps a vanished row (P2025) to 404', async () => {
        tx.externalBooking.create.mockRejectedValue(knownError('P2025', 'Record not found'));

        await expect(create()).rejects.toBeInstanceOf(NotFoundException);
      });
    });
  });

  // -----------------------------------------------------------------------
  // reading
  // -----------------------------------------------------------------------

  describe('list', () => {
    beforeEach(() => {
      tx.externalBooking.findMany.mockResolvedValue([seriesRow()]);
      tx.user.findMany.mockResolvedValue([{ id: REGISTRAR_ID, firstName: 'Eva', lastName: 'Expedition' }]);
    });

    it.each([
      ['active', { cancelledAt: null, endDate: { gte: dateOf('2027-01-20') } }],
      ['ended', { cancelledAt: null, endDate: { lt: dateOf('2027-01-20') } }],
      ['cancelled', { cancelledAt: { not: null } }],
      ['all', {}],
    ] as const)('asks for the %s series by the school’s today', async (state, where) => {
      await service.list(state, testUser());

      expect(tx.externalBooking.findMany).toHaveBeenCalledWith({
        where,
        orderBy: [{ startDate: 'desc' }, { id: 'asc' }],
        take: 500,
        select: expect.objectContaining({ id: true, skippedDates: true, room: { select: { name: true } }, resource: { select: { name: true } } }),
      });
    });

    it('reckons today on the school’s zone', async () => {
      jest.setSystemTime(new Date('2027-01-20T23:30:00.000Z'));

      await service.list('active', testUser());

      expect(tx.externalBooking.findMany.mock.calls[0]![0].where.endDate).toEqual({ gte: dateOf('2027-01-21') });
    });

    it('reckons today on Stockholm’s clock when the school names no zone', async () => {
      tx.school.findFirst.mockResolvedValue(null);
      jest.setSystemTime(new Date('2027-01-20T23:30:00.000Z'));

      await service.list('active', testUser());

      expect(tx.externalBooking.findMany.mock.calls[0]![0].where.endDate).toEqual({ gte: dateOf('2027-01-21') });
    });

    it('answers a series of a room as the web reads it, with its days counted and its registrar named', async () => {
      world.counts = [{ id: SERIES_ID, total: 4, upcoming: 3, cancelled: 1 }];
      world.clashes = [
        { seriesId: SERIES_ID, dayId: DAY_ID, organisation: 'x', targetName: 'y', startsAt: NOW, endsAt: NOW, lesson: 'Idrott 7A' },
        { seriesId: SERIES_ID, dayId: DAY_ID, organisation: 'x', targetName: 'y', startsAt: NOW, endsAt: NOW, lesson: 'Idrott 7B' },
        { seriesId: SERIES_ID, dayId: '66666666-6666-4666-8666-666666666662', organisation: 'x', targetName: 'y', startsAt: NOW, endsAt: NOW, lesson: 'Idrott 8A' },
      ];
      tx.externalBooking.findMany.mockResolvedValue([seriesRow({ skippedDates: [dateOf('2027-02-16')], cancelledAt: new Date('2027-01-19T12:00:00.000Z') })]);

      await expect(service.list('all', testUser())).resolves.toEqual([
        {
          id: SERIES_ID,
          target: { kind: 'ROOM', id: ROOM_ID, name: 'Gymnastiksalen' },
          resourceQuantity: null,
          organisation: 'Idrottsföreningen',
          contactName: 'Kim Kontakt',
          contactPhone: '070-1234567',
          contactEmail: 'kim@forening.example',
          purpose: 'Träning',
          note: null,
          weekdays: [2],
          intervalWeeks: 1,
          startDate: '2027-02-02',
          endDate: '2027-02-23',
          startTime: '18:00',
          endTime: '20:00',
          cancelledAt: '2027-01-19T12:00:00.000Z',
          createdAt: '2027-01-19T12:00:00.000Z',
          registeredByName: 'Eva Expedition',
          days: { total: 4, upcoming: 3, cancelled: 1, skipped: ['2027-02-16'] },
          // Two lessons on one day, and a second day: two days that clash.
          clashes: 2,
        },
      ]);
    });

    it('asks the counts and the clashes of the series it lists, and no others', async () => {
      await service.list('all', testUser());

      const counts = tx.$queryRaw.mock.calls.find((call) => rawSql(call).includes('count(*)::int AS "total"'))!;
      expect(counts.slice(1)).toEqual([[SERIES_ID], [SERIES_ID]]);
      const clashes = tx.$queryRaw.mock.calls.find((call) => rawSql(call).includes('JOIN "ExternalBookings" x'))!;
      expect((clashes[1] as Prisma.Sql).values).toEqual([[SERIES_ID]]);
      expect(clashes[2]).toBe(5000);
    });

    it('answers a series of a resource with its quantity, and zeros where nothing was counted', async () => {
      tx.externalBooking.findMany.mockResolvedValue([
        seriesRow({ roomId: null, room: null, resourceId: RESOURCE_ID, resourceQuantity: 10, resource: { name: 'Surfplattor' }, registeredById: null }),
      ]);

      const [only] = await service.list('all', testUser());

      expect(only).toMatchObject({
        target: { kind: 'RESOURCE', id: RESOURCE_ID, name: 'Surfplattor' },
        resourceQuantity: 10,
        registeredByName: null,
        days: { total: 0, upcoming: 0, cancelled: 0, skipped: [] },
        clashes: 0,
      });
    });

    it('names a target as empty when the row no longer joins one', async () => {
      tx.externalBooking.findMany.mockResolvedValue([
        seriesRow({ room: null }),
        seriesRow({ id: 'b', roomId: null, resourceId: RESOURCE_ID, resource: null }),
      ]);

      const rows = await service.list('all', testUser());

      expect(rows.map((row) => row.target.name)).toEqual(['', '']);
    });

    it('names nobody who has a protected identity, and anyone gone from the school', async () => {
      tx.externalBooking.findMany.mockResolvedValue([
        seriesRow(),
        seriesRow({ id: 'b', registeredById: OTHER_PERSON_ID }),
        seriesRow({ id: 'c', registeredById: '99999999-9999-4999-8999-999999999999' }),
      ]);
      tx.personProtection.findMany.mockResolvedValue([{ userId: OTHER_PERSON_ID }]);
      tx.user.findMany.mockResolvedValue([
        { id: REGISTRAR_ID, firstName: 'Eva', lastName: 'Expedition' },
        { id: OTHER_PERSON_ID, firstName: 'Skydd', lastName: 'Ad' },
      ]);

      const rows = await service.list('all', testUser());

      expect(rows.map((row) => row.registeredByName)).toEqual(['Eva Expedition', null, null]);
      expect(tx.user.findMany.mock.calls[0]![0].where).toEqual({ id: { in: [REGISTRAR_ID, OTHER_PERSON_ID, '99999999-9999-4999-8999-999999999999'] } });
    });

    it('asks nothing of the days or the people when the school has no series', async () => {
      tx.externalBooking.findMany.mockResolvedValue([]);

      await expect(service.list('active', testUser())).resolves.toEqual([]);

      expect(tx.$queryRaw.mock.calls.some((call) => rawSql(call).includes('count(*)'))).toBe(false);
    });

    it('asks no one’s name when nobody registered the series', async () => {
      tx.externalBooking.findMany.mockResolvedValue([seriesRow({ registeredById: null })]);

      await service.list('active', testUser());

      expect(tx.user.findMany).not.toHaveBeenCalled();
      expect(tx.personProtection.findMany).not.toHaveBeenCalled();
    });

    it('refuses a principal with no school', async () => {
      await expect(service.list('active', { ...testUser(), schoolId: undefined })).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('detail', () => {
    const days = [
      { id: DAY_ID, startsAt: new Date('2027-02-02T17:00:00.000Z'), endsAt: new Date('2027-02-02T19:00:00.000Z'), status: 'APPROVED' },
      { id: '66666666-6666-4666-8666-666666666662', startsAt: new Date('2027-02-09T17:00:00.000Z'), endsAt: new Date('2027-02-09T19:00:00.000Z'), status: 'CANCELLED' },
    ];

    beforeEach(() => {
      tx.externalBooking.findUnique.mockResolvedValue(seriesRow());
      tx.roomBooking.findMany.mockResolvedValue(days);
      tx.user.findMany.mockResolvedValue([{ id: REGISTRAR_ID, firstName: 'Eva', lastName: 'Expedition' }]);
    });

    it('answers the series with each of its days, and the lesson that now stands on a day', async () => {
      world.counts = [{ id: SERIES_ID, total: 2, upcoming: 1, cancelled: 1 }];
      world.clashes = [{ seriesId: SERIES_ID, dayId: DAY_ID, organisation: 'x', targetName: 'y', startsAt: days[0]!.startsAt, endsAt: days[0]!.endsAt, lesson: 'Idrott 7A' }];

      const detail = await service.detail(SERIES_ID, testUser());

      expect(detail).toMatchObject({ id: SERIES_ID, organisation: 'Idrottsföreningen', clashes: 1, days: { total: 2, upcoming: 1, cancelled: 1 } });
      expect(detail.occurrences).toEqual([
        { id: DAY_ID, date: '2027-02-02', startsAt: '2027-02-02T17:00:00.000Z', endsAt: '2027-02-02T19:00:00.000Z', status: 'APPROVED', conflicts: [{ kind: 'LESSON', severity: 'BLOCK', label: 'Idrott 7A' }] },
        { id: days[1]!.id, date: '2027-02-09', startsAt: '2027-02-09T17:00:00.000Z', endsAt: '2027-02-09T19:00:00.000Z', status: 'CANCELLED', conflicts: [] },
      ]);
      expect(tx.roomBooking.findMany).toHaveBeenCalledWith({
        where: { externalBookingId: SERIES_ID },
        orderBy: { startsAt: 'asc' },
        select: { id: true, startsAt: true, endsAt: true, status: true },
      });
      expect(tx.resourceBooking.findMany).not.toHaveBeenCalled();
    });

    it('collects every lesson that stands on one day under that day', async () => {
      world.clashes = [
        { seriesId: SERIES_ID, dayId: DAY_ID, organisation: 'x', targetName: 'y', startsAt: days[0]!.startsAt, endsAt: days[0]!.endsAt, lesson: 'Idrott 7A' },
        { seriesId: SERIES_ID, dayId: DAY_ID, organisation: 'x', targetName: 'y', startsAt: days[0]!.startsAt, endsAt: days[0]!.endsAt, lesson: 'Idrott 7B' },
      ];

      const detail = await service.detail(SERIES_ID, testUser());

      expect(detail.occurrences[0]!.conflicts.map((conflict) => conflict.label)).toEqual(['Idrott 7A', 'Idrott 7B']);
    });

    it('reads the days of a series of a resource from the resource bookings, on the zone the school has', async () => {
      tx.school.findFirst.mockResolvedValue({ timezone: 'UTC' });
      tx.externalBooking.findUnique.mockResolvedValue(seriesRow({ roomId: null, room: null, resourceId: RESOURCE_ID, resource: { name: 'Surfplattor' } }));
      tx.resourceBooking.findMany.mockResolvedValue([{ id: DAY_ID, startsAt: new Date('2027-02-02T23:30:00.000Z'), endsAt: new Date('2027-02-03T00:30:00.000Z'), status: 'APPROVED' }]);

      const detail = await service.detail(SERIES_ID, testUser());

      expect(tx.roomBooking.findMany).not.toHaveBeenCalled();
      expect(detail.target.kind).toBe('RESOURCE');
      expect(detail.occurrences[0]!.date).toBe('2027-02-02');
    });

    it('falls back to Stockholm when the school names no zone', async () => {
      tx.school.findFirst.mockResolvedValue(null);
      tx.roomBooking.findMany.mockResolvedValue([{ id: DAY_ID, startsAt: new Date('2027-02-02T23:30:00.000Z'), endsAt: new Date('2027-02-03T00:30:00.000Z'), status: 'APPROVED' }]);

      const detail = await service.detail(SERIES_ID, testUser());

      expect(detail.occurrences[0]!.date).toBe('2027-02-03');
    });

    it('answers 404 for a series the caller cannot see', async () => {
      tx.externalBooking.findUnique.mockResolvedValue(null);

      await expect(service.detail(SERIES_ID, testUser())).rejects.toThrow(new NotFoundException('External booking not found.'));
    });
  });

  describe('clashes', () => {
    it('lists the days that stand in a room with a lesson, on the school’s clock', async () => {
      world.clashes = [
        {
          seriesId: SERIES_ID,
          dayId: DAY_ID,
          organisation: 'Idrottsföreningen',
          targetName: 'Gymnastiksalen',
          startsAt: new Date('2027-02-02T23:30:00.000Z'),
          endsAt: new Date('2027-02-03T00:30:00.000Z'),
          lesson: 'Idrott 7A',
        },
      ];

      await expect(service.clashes(testUser())).resolves.toEqual([
        {
          seriesId: SERIES_ID,
          dayId: DAY_ID,
          organisation: 'Idrottsföreningen',
          targetName: 'Gymnastiksalen',
          date: '2027-02-03',
          startsAt: '2027-02-02T23:30:00.000Z',
          endsAt: '2027-02-03T00:30:00.000Z',
          lesson: 'Idrott 7A',
        },
      ]);
      const asked = tx.$queryRaw.mock.calls.find((call) => rawSql(call).includes('JOIN "ExternalBookings" x'))!;
      expect(asked[1]).toBe(Prisma.empty);
      expect(asked[2]).toBe(500);
    });

    it('answers none when nothing clashes, on Stockholm’s clock when the school names no zone', async () => {
      tx.school.findFirst.mockResolvedValue(null);

      await expect(service.clashes(testUser())).resolves.toEqual([]);
    });

    it('refuses a principal with no school', async () => {
      await expect(service.clashes({ ...testUser(), schoolId: undefined })).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // -----------------------------------------------------------------------
  // changing and cancelling
  // -----------------------------------------------------------------------

  describe('update', () => {
    beforeEach(() => {
      tx.externalBooking.findUnique.mockResolvedValue({ contactPhone: '070-1234567', contactEmail: null });
      tx.externalBooking.update.mockResolvedValue(seriesRow({ organisation: 'Nya Föreningen' }));
      tx.user.findMany.mockResolvedValue([{ id: REGISTRAR_ID, firstName: 'Eva', lastName: 'Expedition' }]);
    });

    it('changes the fields it is given, trimmed, and answers the series as the list does', async () => {
      const result = await service.update(
        SERIES_ID,
        { organisation: ' Nya Föreningen ', contactName: ' Lo ', contactPhone: ' 08-123456 ', contactEmail: ' lo@forening.example ', purpose: ' Match ', note: ' Nyckel i dörren ' },
        testUser(),
      );

      expect(result.organisation).toBe('Nya Föreningen');
      expect(tx.externalBooking.update.mock.calls[0]![0]).toMatchObject({
        where: { id: SERIES_ID },
        data: {
          organisation: 'Nya Föreningen',
          contactName: 'Lo',
          contactPhone: '08-123456',
          contactEmail: 'lo@forening.example',
          purpose: 'Match',
          note: 'Nyckel i dörren',
        },
      });
    });

    it('leaves alone what it is not given', async () => {
      await service.update(SERIES_ID, {}, testUser());

      expect(tx.externalBooking.update.mock.calls[0]![0].data).toEqual({});
    });

    it('clears the purpose and the note with a blank or a null', async () => {
      await service.update(SERIES_ID, { purpose: '  ', note: null }, testUser());

      expect(tx.externalBooking.update.mock.calls[0]![0].data).toEqual({ purpose: null, note: null });
    });

    it('clears the telephone number when the address stays', async () => {
      tx.externalBooking.findUnique.mockResolvedValue({ contactPhone: '070-1234567', contactEmail: 'kim@forening.example' });

      await service.update(SERIES_ID, { contactPhone: null }, testUser());

      expect(tx.externalBooking.update.mock.calls[0]![0].data).toEqual({ contactPhone: null });
    });

    it('clears the address when the telephone number stays, and changes a number the address stays beside', async () => {
      await service.update(SERIES_ID, { contactEmail: '' }, testUser());
      expect(tx.externalBooking.update.mock.calls[0]![0].data).toEqual({ contactEmail: null });
    });

    it('will not empty the contact: neither the number nor the address left is a 400', async () => {
      await expect(service.update(SERIES_ID, { contactPhone: '   ' }, testUser())).rejects.toThrow(
        new BadRequestException('Ange telefonnummer eller e-postadress till kontaktpersonen.'),
      );
      expect(tx.externalBooking.update).not.toHaveBeenCalled();
    });

    it('takes a new address for a series that had only a number, then a cleared number', async () => {
      await service.update(SERIES_ID, { contactEmail: 'lo@forening.example', contactPhone: null }, testUser());

      expect(tx.externalBooking.update.mock.calls[0]![0].data).toEqual({ contactEmail: 'lo@forening.example', contactPhone: null });
    });

    it('answers 404 for a series the caller cannot see, and for one that went before the update (P2025)', async () => {
      tx.externalBooking.findUnique.mockResolvedValueOnce(null);
      await expect(service.update(SERIES_ID, {}, testUser())).rejects.toThrow(new NotFoundException('External booking not found.'));

      tx.externalBooking.update.mockRejectedValueOnce(knownError('P2025', 'Record not found'));
      await expect(service.update(SERIES_ID, {}, testUser())).rejects.toBeInstanceOf(NotFoundException);
    });

    it('lets an error that nothing maps through', async () => {
      const plain = new Error('connection reset');
      tx.externalBooking.update.mockRejectedValue(plain);

      await expect(service.update(SERIES_ID, {}, testUser())).rejects.toBe(plain);
    });
  });

  describe('cancel', () => {
    beforeEach(() => {
      tx.externalBooking.findUnique.mockResolvedValue({ cancelledAt: null });
      tx.externalBooking.update.mockResolvedValue(seriesRow({ cancelledAt: NOW }));
      tx.roomBooking.updateMany.mockResolvedValue({ count: 3 });
      tx.resourceBooking.updateMany.mockResolvedValue({ count: 0 });
      tx.user.findMany.mockResolvedValue([{ id: REGISTRAR_ID, firstName: 'Eva', lastName: 'Expedition' }]);
    });

    it('cancels the series and every day of it that has not started, and those alone', async () => {
      const result = await service.cancel(SERIES_ID, testUser());

      expect(result.cancelledAt).toBe(NOW.toISOString());
      expect(tx.externalBooking.update).toHaveBeenCalledWith({ where: { id: SERIES_ID }, data: { cancelledAt: NOW }, select: expect.any(Object) });
      const open = { externalBookingId: SERIES_ID, status: { in: ['PENDING', 'APPROVED'] }, startsAt: { gt: NOW } };
      expect(tx.roomBooking.updateMany).toHaveBeenCalledWith({ where: open, data: { status: 'CANCELLED' } });
      expect(tx.resourceBooking.updateMany).toHaveBeenCalledWith({ where: open, data: { status: 'CANCELLED' } });
    });

    it('refuses a series that is already cancelled, and changes nothing', async () => {
      tx.externalBooking.findUnique.mockResolvedValue({ cancelledAt: new Date('2027-01-19T00:00:00.000Z') });

      await expect(service.cancel(SERIES_ID, testUser())).rejects.toThrow(new BadRequestException('Serien är redan avbokad.'));
      expect(tx.externalBooking.update).not.toHaveBeenCalled();
      expect(tx.roomBooking.updateMany).not.toHaveBeenCalled();
    });

    it('answers 404 for a series the caller cannot see', async () => {
      tx.externalBooking.findUnique.mockResolvedValue(null);

      await expect(service.cancel(SERIES_ID, testUser())).rejects.toThrow(new NotFoundException('External booking not found.'));
    });

    it('maps a vanished row (P2025) to 404 and lets an error nothing maps through', async () => {
      tx.externalBooking.update.mockRejectedValueOnce(knownError('P2025', 'Record not found'));
      await expect(service.cancel(SERIES_ID, testUser())).rejects.toBeInstanceOf(NotFoundException);

      const plain = new Error('connection reset');
      tx.externalBooking.update.mockRejectedValueOnce(plain);
      await expect(service.cancel(SERIES_ID, testUser())).rejects.toBe(plain);
    });
  });

  describe('remove', () => {
    const series = (patch: Record<string, unknown>) => tx.externalBooking.findUnique.mockResolvedValue({ cancelledAt: null, endDate: dateOf('2027-01-10'), ...patch });

    it('deletes a series that is over', async () => {
      series({ endDate: dateOf('2027-01-19') });

      await expect(service.remove(SERIES_ID, testUser())).resolves.toBeUndefined();

      expect(tx.externalBooking.delete).toHaveBeenCalledWith({ where: { id: SERIES_ID } });
    });

    it('deletes a series that was cancelled, whatever its end date', async () => {
      series({ cancelledAt: new Date('2027-01-19T00:00:00.000Z'), endDate: dateOf('2027-06-01') });

      await expect(service.remove(SERIES_ID, testUser())).resolves.toBeUndefined();

      expect(tx.externalBooking.delete).toHaveBeenCalled();
    });

    it.each([
      ['one that ends later', '2027-02-23'],
      ['one that ends today', '2027-01-20'],
    ])('refuses %s that was not cancelled: it is cancelled first', async (_label, endDate) => {
      series({ endDate: dateOf(endDate) });

      const error = await service.remove(SERIES_ID, testUser()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toEqual({ message: 'Serien pågår. Avboka den först.', code: 'EXTERNAL_BOOKING_IS_RUNNING' });
      expect(tx.externalBooking.delete).not.toHaveBeenCalled();
    });

    it('answers 404 for a series the caller cannot see', async () => {
      tx.externalBooking.findUnique.mockResolvedValue(null);

      await expect(service.remove(SERIES_ID, testUser())).rejects.toThrow(new NotFoundException('External booking not found.'));
    });

    it('maps a vanished row (P2025) to 404 and a key that refuses (P2003) to 409', async () => {
      series({ endDate: dateOf('2027-01-19') });
      tx.externalBooking.delete.mockRejectedValueOnce(knownError('P2025', 'Record not found'));
      await expect(service.remove(SERIES_ID, testUser())).rejects.toBeInstanceOf(NotFoundException);

      tx.externalBooking.delete.mockRejectedValueOnce(knownError('P2003', 'Foreign key constraint violated'));
      await expect(service.remove(SERIES_ID, testUser())).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('cancelDay', () => {
    const day = (patch: Record<string, unknown> = {}) => ({
      id: DAY_ID,
      startsAt: new Date('2027-02-09T17:00:00.000Z'),
      endsAt: new Date('2027-02-09T19:00:00.000Z'),
      status: 'APPROVED',
      ...patch,
    });

    beforeEach(() => {
      tx.externalBooking.findUnique.mockResolvedValue({ roomId: ROOM_ID });
      tx.roomBooking.findFirst.mockResolvedValue(day());
      tx.resourceBooking.findFirst.mockResolvedValue(day());
    });

    it('cancels one day of a room series and answers it as the series’ days are answered', async () => {
      await expect(service.cancelDay(SERIES_ID, DAY_ID, testUser())).resolves.toEqual({
        id: DAY_ID,
        date: '2027-02-09',
        startsAt: '2027-02-09T17:00:00.000Z',
        endsAt: '2027-02-09T19:00:00.000Z',
        status: 'CANCELLED',
        conflicts: [],
      });

      expect(tx.roomBooking.findFirst).toHaveBeenCalledWith({
        where: { id: DAY_ID, externalBookingId: SERIES_ID },
        select: { id: true, startsAt: true, endsAt: true, status: true },
      });
      expect(tx.roomBooking.update).toHaveBeenCalledWith({ where: { id: DAY_ID }, data: { status: 'CANCELLED' } });
      expect(tx.resourceBooking.update).not.toHaveBeenCalled();
    });

    it('cancels one day of a resource series in the resource bookings', async () => {
      tx.externalBooking.findUnique.mockResolvedValue({ roomId: null });

      await service.cancelDay(SERIES_ID, DAY_ID, testUser());

      expect(tx.resourceBooking.update).toHaveBeenCalledWith({ where: { id: DAY_ID }, data: { status: 'CANCELLED' } });
      expect(tx.roomBooking.update).not.toHaveBeenCalled();
    });

    it('names the day on the school’s clock', async () => {
      tx.school.findFirst.mockResolvedValue(null);
      tx.roomBooking.findFirst.mockResolvedValue(day({ startsAt: new Date('2027-02-09T23:30:00.000Z'), endsAt: new Date('2027-02-10T00:30:00.000Z') }));

      const result = await service.cancelDay(SERIES_ID, DAY_ID, testUser());

      expect(result.date).toBe('2027-02-10');
    });

    it('refuses a day that is already cancelled', async () => {
      tx.roomBooking.findFirst.mockResolvedValue(day({ status: 'CANCELLED' }));

      await expect(service.cancelDay(SERIES_ID, DAY_ID, testUser())).rejects.toThrow(new BadRequestException('Dagen är redan avbokad.'));
      expect(tx.roomBooking.update).not.toHaveBeenCalled();
    });

    it('answers 404 for a series the caller cannot see, and for a day that is not the series’', async () => {
      tx.externalBooking.findUnique.mockResolvedValueOnce(null);
      await expect(service.cancelDay(SERIES_ID, DAY_ID, testUser())).rejects.toThrow(new NotFoundException('External booking not found.'));

      tx.roomBooking.findFirst.mockResolvedValueOnce(null);
      await expect(service.cancelDay(SERIES_ID, DAY_ID, testUser())).rejects.toThrow(new NotFoundException('Day not found.'));
    });

    it('maps a vanished row (P2025) to 404 and lets an error nothing maps through', async () => {
      tx.roomBooking.update.mockRejectedValueOnce(knownError('P2025', 'Record not found'));
      await expect(service.cancelDay(SERIES_ID, DAY_ID, testUser())).rejects.toBeInstanceOf(NotFoundException);

      const plain = new Error('connection reset');
      tx.roomBooking.update.mockRejectedValueOnce(plain);
      await expect(service.cancelDay(SERIES_ID, DAY_ID, testUser())).rejects.toBe(plain);
    });
  });
});
