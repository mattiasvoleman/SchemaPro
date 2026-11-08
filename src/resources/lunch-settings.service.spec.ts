import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { LunchSettingsService } from './lunch-settings.service';
import type { UpsertLunchSettingsDto } from './dto/lunch-settings.dto';

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';

describe('LunchSettingsService', () => {
  let service: LunchSettingsService;
  let tx: TxMock;
  let prisma: PrismaMock;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new LunchSettingsService(prisma as unknown as PrismaService);
  });

  const dto = (
    overrides: Partial<UpsertLunchSettingsDto> = {},
  ): UpsertLunchSettingsDto => ({
    lunchEnabled: true,
    lunchStartTime: '11:00',
    lunchEndTime: '13:00',
    lunchMinutes: 30,
    diningSeats: 180,
    ...overrides,
  });

  describe('get', () => {
    it('returns null when nobody has defined lunch yet', async () => {
      // Null, not a fabricated default: "not decided" and "decided to be 11:00"
      // are different facts, and the publish warning turns on the difference.
      tx.lunchSetting.findUnique.mockResolvedValue(null);
      const user = testUser();

      await expect(service.get(user)).resolves.toBeNull();

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.lunchSetting.findUnique).toHaveBeenCalledWith({
        where: { schoolId: SCHOOL_ID },
      });
    });

    it('answers with the wall clock, never with a timestamp', async () => {
      /*
       * `@db.Time` comes out of Prisma as a `Date` at 1970-01-01, so returning
       * the row unchanged sent "1970-01-01T11:00:00.000Z" to a client that
       * wanted "11:00". The lunch card took the first five characters, as its
       * comment said PostgreSQL's own format allowed, and put "1970-" into an
       * `<input type="time">` — which refuses it and renders empty. The form
       * showed no start and no end on every load.
       */
      tx.lunchSetting.findUnique.mockResolvedValue(storedRow());

      const answer = await service.get(testUser());

      expect(answer).toMatchObject({ lunchStartTime: '11:00', lunchEndTime: '13:00' });
      // Belt and braces, because the failure mode is a value that still LOOKS
      // like a time until something tries to parse it.
      expect(JSON.stringify(answer)).not.toContain('1970');
    });

    it('reads the clock in UTC, so 11:00 stays 11:00', async () => {
      // The stored value is a wall clock with no day and no zone. Reading it in
      // local time turns 11:00 into 12:00 for half the year in Stockholm — the
      // trap `formatTime` on the web still falls into for this shape.
      process.env['TZ'] = 'UTC';
      tx.lunchSetting.findUnique.mockResolvedValue(
        storedRow({ lunchStartTime: new Date('1970-01-01T07:30:00.000Z') }),
      );

      await expect(service.get(testUser())).resolves.toMatchObject({
        lunchStartTime: '07:30',
      });
    });

    it('refuses a principal carrying no school', async () => {
      await expect(
        service.get(testUser({ schoolId: undefined })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  /** What Prisma hands back for this table: @db.Time columns are `Date`s. */
  const storedRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'ls-1',
    schoolId: SCHOOL_ID,
    lunchEnabled: true,
    lunchStartTime: new Date('1970-01-01T11:00:00.000Z'),
    lunchEndTime: new Date('1970-01-01T13:00:00.000Z'),
    lunchMinutes: 30,
    diningSeats: 180,
    maxLessonsPerDayPerGroup: null,
    generatorKeepsTravelTime: false,
    generatorKeepsPupilGapsDown: false,
    generatorKeepsConsecutiveTeaching: false,
    generatorBestEffort: false,
    placementEdgeMode: 'OFF',
    placementEdgeWeight: 250,
    placementPlacesMode: 'OFF',
    placementPlacesWeight: 250,
    maxClassRoomsPerDay: null,
    maxTeacherRoomsPerDay: null,
    maxClassBuildingsPerDay: null,
    maxTeacherBuildingsPerDay: null,
    placementSharedMode: 'OFF',
    placementSharedWeight: 250,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  });

  describe('upsert', () => {
    it('writes the row for the caller’s school, times parsed for @db.Time', async () => {
      // A row shaped as the database returns one: the two time columns are
      // `Date`s anchored at 1970-01-01, not strings. `{ id: 'ls-1' }` could
      // never come back from Prisma, and a fixture that cannot occur was what
      // let the endpoint ship a timestamp where a clock was expected.
      tx.lunchSetting.upsert.mockResolvedValue(storedRow());

      await expect(service.upsert(dto(), testUser())).resolves.toMatchObject({
        id: 'ls-1',
        lunchStartTime: '11:00',
        lunchEndTime: '13:00',
      });

      const data = {
        lunchEnabled: true,
        lunchStartTime: new Date('1970-01-01T11:00:00.000Z'),
        lunchEndTime: new Date('1970-01-01T13:00:00.000Z'),
        lunchMinutes: 30,
        diningSeats: 180,
        maxLessonsPerDayPerGroup: null,
      };
      expect(tx.lunchSetting.upsert).toHaveBeenCalledWith({
        where: { schoolId: SCHOOL_ID },
        create: { schoolId: SCHOOL_ID, ...data },
        update: data,
      });
    });

    it('writes the walk switch when the form sends it, on both arms of the upsert', async () => {
      tx.lunchSetting.upsert.mockResolvedValue(storedRow({ generatorKeepsTravelTime: true }));

      await service.upsert(dto({ generatorKeepsTravelTime: true }), testUser());

      const call = tx.lunchSetting.upsert.mock.calls[0]?.[0] as {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      };
      expect(call.create['generatorKeepsTravelTime']).toBe(true);
      expect(call.update['generatorKeepsTravelTime']).toBe(true);
    });

    it('leaves the walk switch alone when a tab from before it PUTs the row', async () => {
      // A Skolregler tab loaded before the switch existed saves lunch and the
      // daily maximum and names no switch. Writing `false` for it would turn
      // the rule off that a colleague turned on, without a word to either.
      tx.lunchSetting.upsert.mockResolvedValue(storedRow());

      await service.upsert(dto(), testUser());

      const call = tx.lunchSetting.upsert.mock.calls[0]?.[0] as {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      };
      expect(call.update).not.toHaveProperty('generatorKeepsTravelTime');
      // A first row starts with the column's own default: off.
      expect(call.create).not.toHaveProperty('generatorKeepsTravelTime');
    });

    it('writes the pupil-gap switch when the form sends it, and leaves it alone when a tab from before it does not', async () => {
      tx.lunchSetting.upsert.mockResolvedValue(storedRow({ generatorKeepsPupilGapsDown: true }));
      await service.upsert(dto({ generatorKeepsPupilGapsDown: true }), testUser());
      const sent = tx.lunchSetting.upsert.mock.calls[0]?.[0] as {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      };
      expect(sent.create['generatorKeepsPupilGapsDown']).toBe(true);
      expect(sent.update['generatorKeepsPupilGapsDown']).toBe(true);

      // A Skolregler tab from before the switch names it not, and changes it not:
      // writing `false` would turn the rule off that a colleague turned on.
      tx.lunchSetting.upsert.mockClear();
      tx.lunchSetting.upsert.mockResolvedValue(storedRow());
      await service.upsert(dto({ generatorKeepsTravelTime: true }), testUser());
      const older = tx.lunchSetting.upsert.mock.calls[0]?.[0] as {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      };
      expect(older.update).not.toHaveProperty('generatorKeepsPupilGapsDown');
      expect(older.create).not.toHaveProperty('generatorKeepsPupilGapsDown');
    });

    it('writes the consecutive-teaching switch when the form sends it, and leaves it alone when a tab from before it does not', async () => {
      tx.lunchSetting.upsert.mockResolvedValue(storedRow({ generatorKeepsConsecutiveTeaching: true }));
      await service.upsert(dto({ generatorKeepsConsecutiveTeaching: true }), testUser());
      const sent = tx.lunchSetting.upsert.mock.calls[0]?.[0] as {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      };
      expect(sent.create['generatorKeepsConsecutiveTeaching']).toBe(true);
      expect(sent.update['generatorKeepsConsecutiveTeaching']).toBe(true);

      // A tab from before the switch names it not and changes it not: writing
      // `false` would turn off the effort a colleague turned on.
      tx.lunchSetting.upsert.mockClear();
      tx.lunchSetting.upsert.mockResolvedValue(storedRow());
      await service.upsert(dto({ generatorKeepsPupilGapsDown: true }), testUser());
      const older = tx.lunchSetting.upsert.mock.calls[0]?.[0] as {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      };
      expect(older.update).not.toHaveProperty('generatorKeepsConsecutiveTeaching');
      expect(older.create).not.toHaveProperty('generatorKeepsConsecutiveTeaching');
    });

    it('writes the best-effort switch when the form sends it, on both halves of the upsert, true and false alike', async () => {
      for (const value of [true, false]) {
        tx.lunchSetting.upsert.mockClear();
        tx.lunchSetting.upsert.mockResolvedValue(storedRow({ generatorBestEffort: value }));
        await expect(service.upsert(dto({ generatorBestEffort: value }), testUser())).resolves.toMatchObject({
          generatorBestEffort: value,
        });
        const sent = tx.lunchSetting.upsert.mock.calls[0]?.[0] as {
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        };
        // false is a decision too: dropped as falsy it could never be turned off again.
        expect(sent.create['generatorBestEffort']).toBe(value);
        expect(sent.update['generatorBestEffort']).toBe(value);
      }
    });

    it('leaves the best-effort switch alone when a tab from before it does not send one', async () => {
      // Writing `false` here would withdraw the consent a colleague gave, and
      // with it every candidate with deviations still on the page.
      tx.lunchSetting.upsert.mockResolvedValue(storedRow());
      await service.upsert(dto({ generatorKeepsConsecutiveTeaching: true }), testUser());
      const older = tx.lunchSetting.upsert.mock.calls[0]?.[0] as {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      };
      expect(older.update).not.toHaveProperty('generatorBestEffort');
      expect(older.create).not.toHaveProperty('generatorBestEffort');
    });

    it('stores an absent seat count as null rather than dropping the field', async () => {
      // Null means "no limit worth modelling", and the solver reads it as
      // permission to place lunch exactly as it did before seats existed.
      tx.lunchSetting.upsert.mockResolvedValue(storedRow());

      await service.upsert(dto({ diningSeats: undefined }), testUser());

      const call = tx.lunchSetting.upsert.mock.calls[0]?.[0] as {
        update: { diningSeats: number | null };
      };
      expect(call.update.diningSeats).toBeNull();
    });

    describe('rejects what the solver’s time grid cannot place', () => {
      // Each of these would otherwise be saved, then fail inside the engine on
      // every generation from then on — and the proxy throws the engine's
      // explanation away, so the school would only ever see "the AI engine
      // returned an error".
      it.each([
        ['a window starting before the school day', { lunchStartTime: '07:45' }],
        ['a window ending after it', { lunchEndTime: '18:15' }],
        // The grid is five minutes now, not fifteen — 11:10 and a 40-minute
        // break are legal on it, and a school with 40-minute lessons is exactly
        // why it moved. What is still refused is a time off the grid entirely.
        ['a start that is not on the grid', { lunchStartTime: '11:07' }],
        ['an end that is not on the grid', { lunchEndTime: '12:52' }],
        ['a break that is not a whole number of slots', { lunchMinutes: 37 }],
        [
          'a window too short for the break it must hold',
          { lunchStartTime: '11:00', lunchEndTime: '11:15', lunchMinutes: 30 },
        ],
      ])('%s', async (_label, overrides) => {
        await expect(
          service.upsert(dto(overrides as Partial<UpsertLunchSettingsDto>), testUser()),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(tx.lunchSetting.upsert).not.toHaveBeenCalled();
      });
    });

    it.each([
      ['a second on the start', { lunchStartTime: '11:00:30', lunchEndTime: '11:30' }],
      ['a second on the end', { lunchStartTime: '11:00', lunchEndTime: '11:30:30' }],
    ])('refuses %s, which the width arithmetic cannot see', async (_label, overrides) => {
      /*
       * The 500 this exists to stop, and the one sibling of
       * TeacherWorkRules_lunch_window_fits_break that counts seconds the same
       * way. `minutesOf` splits on ':' and reads two fields, so 11:00:30
       * measures as 11:00: the width came out as a whole thirty minutes and
       * both edges passed `% 5`. LunchSettings_window_fits_break measures the
       * same window with EXTRACT(EPOCH …) and sees 1770 seconds against 1800,
       * and a CHECK violation is none of the codes rethrowPrismaError maps — so
       * the admin met a bare 500 instead of a sentence naming the field.
       *
       * The end row is the smaller claim: a second there widens the window, so
       * it passes the CHECK and is merely stored off the five-minute grid. It
       * is refused for the grid's sake, not the CHECK's.
       */
      await expect(
        service.upsert(
          dto({ ...overrides, lunchMinutes: 30 }),
          testUser(),
        ),
      ).rejects.toThrow(/hela minuter/);

      expect(tx.lunchSetting.upsert).not.toHaveBeenCalled();
    });

    it('still takes the zero seconds PostgREST sends, so a row round-trips', async () => {
      // The reason the DTO admits HH:MM:SS at all: the web reads this row back
      // from PostgREST, which writes the seconds out, and PUTs it again. This
      // endpoint's own answer is HH:MM — `toWallClock` drops them — so :00 is
      // the only seconds a client has any way to send.
      tx.lunchSetting.upsert.mockResolvedValue(storedRow());

      await service.upsert(
        dto({ lunchStartTime: '11:00:00', lunchEndTime: '13:00:00' }),
        testUser(),
      );

      expect(tx.lunchSetting.upsert).toHaveBeenCalled();
    });

    it('accepts a window exactly as long as the break', async () => {
      tx.lunchSetting.upsert.mockResolvedValue(storedRow());

      await service.upsert(
        dto({ lunchStartTime: '11:00', lunchEndTime: '11:30', lunchMinutes: 30 }),
        testUser(),
      );

      expect(tx.lunchSetting.upsert).toHaveBeenCalled();
    });

    it('names the numbers when the window is too short', async () => {
      // The admin has to be able to fix it without guessing which of the two
      // fields the rule is about.
      await expect(
        service.upsert(
          dto({ lunchStartTime: '11:00', lunchEndTime: '11:15', lunchMinutes: 30 }),
          testUser(),
        ),
      ).rejects.toThrow(/15 minuter.*30 minuter/);
    });

    it.each([
      ['starts the moment the school day does', { lunchStartTime: '08:00', lunchEndTime: '09:00' }],
      ['ends the moment the school day does', { lunchStartTime: '17:00', lunchEndTime: '18:00' }],
    ])('accepts a window that %s', async (_label, overrides) => {
      // Both edges of the day are inside it. A window the engine can place
      // refused here is a lunch the school cannot save at all.
      tx.lunchSetting.upsert.mockResolvedValue(storedRow());

      await service.upsert(dto(overrides), testUser());

      expect(tx.lunchSetting.upsert).toHaveBeenCalled();
    });

    describe('says what to fix, in the words the lunch form shows', () => {
      // The service's own comment: these messages are Swedish because an admin
      // reads them in the form. An empty or half-built sentence there is the
      // "the AI engine returned an error" this validation exists to replace.
      it.each([
        [
          { lunchStartTime: '07:45' },
          'Starttiden måste ligga mellan 08:00 och 18:00.',
        ],
        [
          { lunchEndTime: '18:15' },
          'Sluttiden måste ligga mellan 08:00 och 18:00.',
        ],
        [
          { lunchStartTime: '11:07' },
          'Starttiden måste vara ett jämnt intervall om 5 minuter, till exempel 11:00 eller 11:05.',
        ],
        [
          { lunchMinutes: 37 },
          'Lunchens längd måste vara ett helt antal 5-minutersintervall.',
        ],
      ])('%j', async (overrides, message) => {
        await expect(
          service.upsert(dto(overrides as Partial<UpsertLunchSettingsDto>), testUser()),
        ).rejects.toThrow(new BadRequestException(message));
      });
    });

    it('answers a refusal from the database with its HTTP meaning, not a raw Prisma error', async () => {
      tx.lunchSetting.upsert.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Simulated P2003', {
          code: 'P2003',
          clientVersion: Prisma.prismaVersion.client,
        }),
      );

      await expect(service.upsert(dto(), testUser())).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('Placeringsregler', () => {
    type Sent = { create: Record<string, unknown>; update: Record<string, unknown> };
    // The last call: a test that PUTs twice reads the second.
    const sentOf = () => tx.lunchSetting.upsert.mock.calls.at(-1)?.[0] as Sent;
    const refusal = async (promise: Promise<unknown>) => {
      try {
        await promise;
      } catch (error) {
        return error as BadRequestException;
      }
      return null;
    };

    it('answers with the ten columns under exactly their names, from the stored row', async () => {
      tx.lunchSetting.findUnique.mockResolvedValue(
        storedRow({ placementEdgeMode: 'SOFT', placementPlacesMode: 'SOFT', maxClassRoomsPerDay: 2, placementSharedMode: 'HARD', placementSharedWeight: 60 }),
      );

      const answer = await service.get(testUser());

      expect(answer).toMatchObject({
        placementEdgeMode: 'SOFT',
        placementEdgeWeight: 250,
        placementPlacesMode: 'SOFT',
        placementPlacesWeight: 250,
        maxClassRoomsPerDay: 2,
        maxTeacherRoomsPerDay: null,
        maxClassBuildingsPerDay: null,
        maxTeacherBuildingsPerDay: null,
        placementSharedMode: 'HARD',
        placementSharedWeight: 60,
      });
    });

    it('writes the columns a request names, on both arms of the upsert, and only those', async () => {
      tx.lunchSetting.upsert.mockResolvedValue(storedRow());

      await service.upsert(dto({ placementEdgeMode: 'SOFT', placementEdgeWeight: 400, placementSharedMode: 'SOFT', placementSharedWeight: 60 }), testUser());

      for (const arm of [sentOf().create, sentOf().update]) {
        expect(arm).toMatchObject({ placementEdgeMode: 'SOFT', placementEdgeWeight: 400, placementSharedMode: 'SOFT', placementSharedWeight: 60 });
        expect(arm).not.toHaveProperty('placementPlacesMode');
        expect(arm).not.toHaveProperty('maxClassRoomsPerDay');
      }
      // Nothing of rule 2 was said, so the stored row is not even read.
      expect(tx.lunchSetting.findUnique).not.toHaveBeenCalled();
    });

    it('leaves all ten alone when a tab from before them PUTs the row, so a rule a colleague turned on stays on', async () => {
      tx.lunchSetting.upsert.mockResolvedValue(storedRow());

      await service.upsert(dto(), testUser());

      for (const column of Object.keys(storedRow()).filter((key) => /^(placement|max.*PerDay$)/.test(key) && !key.startsWith('maxLessons'))) {
        expect(sentOf().update).not.toHaveProperty(column);
        expect(sentOf().create).not.toHaveProperty(column);
      }
      expect(tx.lunchSetting.findUnique).not.toHaveBeenCalled();
    });

    it('clears a limit with null, the key written, and keeps one the request leaves out', async () => {
      tx.lunchSetting.findUnique.mockResolvedValue({ ...rule2({}), placementPlacesMode: 'SOFT', maxTeacherRoomsPerDay: 4, maxClassRoomsPerDay: 2 });
      tx.lunchSetting.upsert.mockResolvedValue(storedRow());

      await service.upsert(dto({ maxClassRoomsPerDay: null }), testUser());

      expect(sentOf().update).toHaveProperty('maxClassRoomsPerDay', null);
      expect(sentOf().update).not.toHaveProperty('maxTeacherRoomsPerDay');
    });

    /** What the stored row holds of rule 2 (the only columns the service reads for the check). */
    const rule2 = (overrides: Record<string, unknown>) => ({
      placementPlacesMode: 'OFF',
      maxClassRoomsPerDay: null,
      maxTeacherRoomsPerDay: null,
      maxClassBuildingsPerDay: null,
      maxTeacherBuildingsPerDay: null,
      ...overrides,
    });

    it('refuses turning rule 2 SOFT on with no limit anywhere: a 400 with a code, and nothing written', async () => {
      tx.lunchSetting.findUnique.mockResolvedValue(rule2({}));

      const error = await refusal(service.upsert(dto({ placementPlacesMode: 'SOFT' }), testUser()));

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error!.getResponse()).toMatchObject({ code: 'PLACEMENT_PLACES_NEEDS_A_LIMIT', message: expect.stringContaining('placementPlacesMode') });
      expect(tx.lunchSetting.upsert).not.toHaveBeenCalled();
    });

    it('reads the stored row, in the same transaction, for the limits the request leaves out', async () => {
      tx.lunchSetting.findUnique.mockResolvedValue(rule2({ maxClassBuildingsPerDay: 1 }));
      tx.lunchSetting.upsert.mockResolvedValue(storedRow());
      const user = testUser();

      await service.upsert(dto({ placementPlacesMode: 'SOFT' }), user);

      expect(prisma.withRls).toHaveBeenCalledTimes(1);
      expect(tx.lunchSetting.findUnique).toHaveBeenCalledWith({
        where: { schoolId: SCHOOL_ID },
        select: {
          placementPlacesMode: true,
          maxClassRoomsPerDay: true,
          maxTeacherRoomsPerDay: true,
          maxClassBuildingsPerDay: true,
          maxTeacherBuildingsPerDay: true,
        },
      });
      expect(sentOf().update).toMatchObject({ placementPlacesMode: 'SOFT' });
    });

    it('turns rule 2 on with a limit set in the same request, on a school with no row yet', async () => {
      tx.lunchSetting.findUnique.mockResolvedValue(null);
      tx.lunchSetting.upsert.mockResolvedValue(storedRow());

      await service.upsert(dto({ placementPlacesMode: 'SOFT', placementPlacesWeight: 100, maxTeacherBuildingsPerDay: 1 }), testUser());

      expect(sentOf().create).toMatchObject({ placementPlacesMode: 'SOFT', maxTeacherBuildingsPerDay: 1 });
    });

    it('refuses clearing the last limit of a rule that is on, and admits turning it off in the same request', async () => {
      tx.lunchSetting.findUnique.mockResolvedValue(rule2({ placementPlacesMode: 'SOFT', maxClassRoomsPerDay: 2 }));
      tx.lunchSetting.upsert.mockResolvedValue(storedRow());

      expect(await refusal(service.upsert(dto({ maxClassRoomsPerDay: null }), testUser()))).toBeInstanceOf(BadRequestException);
      expect(tx.lunchSetting.upsert).not.toHaveBeenCalled();

      await service.upsert(dto({ placementPlacesMode: 'OFF', maxClassRoomsPerDay: null }), testUser());
      expect(tx.lunchSetting.upsert).toHaveBeenCalledTimes(1);
    });

    it('lets rule 1 and rule 3 be turned on with nothing marked: they do nothing until a subject or a room is', async () => {
      tx.lunchSetting.upsert.mockResolvedValue(storedRow());

      await service.upsert(dto({ placementEdgeMode: 'SOFT', placementSharedMode: 'HARD' }), testUser());

      expect(sentOf().update).toMatchObject({ placementEdgeMode: 'SOFT', placementSharedMode: 'HARD' });
    });

    it('does not take rule 1 as HARD until it is measured: a 400 with its own code, before anything is read or written', async () => {
      const error = await refusal(service.upsert(dto({ placementEdgeMode: 'HARD' }), testUser()));

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error!.getResponse()).toMatchObject({ code: 'PLACEMENT_EDGE_HARD_NOT_OFFERED', message: expect.stringContaining('placementEdgeMode') });
      expect(prisma.withRls).not.toHaveBeenCalled();
      expect(tx.lunchSetting.upsert).not.toHaveBeenCalled();
    });

    it('does not take rule 2 as HARD either, on the same terms: its own code, before anything is read or written, with or without a limit', async () => {
      for (const body of [dto({ placementPlacesMode: 'HARD' }), dto({ placementPlacesMode: 'HARD', maxClassRoomsPerDay: 2 })]) {
        const error = await refusal(service.upsert(body, testUser()));

        expect(error).toBeInstanceOf(BadRequestException);
        expect(error!.getResponse()).toMatchObject({ code: 'PLACEMENT_PLACES_HARD_NOT_OFFERED', message: expect.stringContaining('placementPlacesMode') });
      }
      expect(prisma.withRls).not.toHaveBeenCalled();
      expect(tx.lunchSetting.findUnique).not.toHaveBeenCalled();
      expect(tx.lunchSetting.upsert).not.toHaveBeenCalled();
    });

    it('takes rules 1 and 2 as OFF and SOFT and rule 3 as HARD: rule 3 is the one that is offered hard', async () => {
      tx.lunchSetting.upsert.mockResolvedValue(storedRow());

      for (const mode of ['OFF', 'SOFT'] as const) {
        await service.upsert(dto({ placementEdgeMode: mode }), testUser());
        await service.upsert(dto({ placementPlacesMode: mode, maxClassRoomsPerDay: 2 }), testUser());
      }
      await service.upsert(dto({ placementSharedMode: 'HARD' }), testUser());

      expect(tx.lunchSetting.upsert).toHaveBeenCalledTimes(5);
      expect(sentOf().update).toMatchObject({ placementSharedMode: 'HARD' });
    });

    it('answers a stored HARD of rule 1 or rule 2 as the SOFT it is held at, and rule 3 as stored (the CHECK keeps the first two out; this is the last line)', async () => {
      tx.lunchSetting.findUnique.mockResolvedValue(
        storedRow({ placementEdgeMode: 'HARD', placementPlacesMode: 'HARD', maxClassRoomsPerDay: 2, placementSharedMode: 'HARD' }),
      );

      const answer = await service.get(testUser());

      expect(answer).toMatchObject({ placementEdgeMode: 'SOFT', placementPlacesMode: 'SOFT', placementSharedMode: 'HARD' });
    });

    describe('the create half of the upsert, which Postgres judges before it finds the row', () => {
      it('carries the rule 2 that is stored under what the request names, so the mode alone does not propose a rule with no limit', async () => {
        tx.lunchSetting.findUnique.mockResolvedValue(rule2({ placementPlacesMode: 'OFF', maxClassRoomsPerDay: 2, maxTeacherBuildingsPerDay: 1 }));
        tx.lunchSetting.upsert.mockResolvedValue(storedRow());

        await service.upsert(dto({ placementPlacesMode: 'SOFT' }), testUser());

        expect(sentOf().create).toMatchObject({
          placementPlacesMode: 'SOFT',
          maxClassRoomsPerDay: 2,
          maxTeacherBuildingsPerDay: 1,
          maxTeacherRoomsPerDay: null,
        });
        // The update half is what it was: only what the request names.
        expect(sentOf().update).toMatchObject({ placementPlacesMode: 'SOFT' });
        expect(sentOf().update).not.toHaveProperty('maxClassRoomsPerDay');
      });

      it('lets what the request names win over what is stored, a null clearing the limit', async () => {
        tx.lunchSetting.findUnique.mockResolvedValue(rule2({ placementPlacesMode: 'SOFT', maxClassRoomsPerDay: 2, maxTeacherRoomsPerDay: 3 }));
        tx.lunchSetting.upsert.mockResolvedValue(storedRow());

        await service.upsert(dto({ maxClassRoomsPerDay: null, maxTeacherRoomsPerDay: 5 }), testUser());

        expect(sentOf().create).toMatchObject({ placementPlacesMode: 'SOFT', maxClassRoomsPerDay: null, maxTeacherRoomsPerDay: 5 });
      });

      it('keeps Bästa möjliga schema’s switch (G2) beside the stored rule 2: each side’s fields are in both halves only when named', async () => {
        tx.lunchSetting.findUnique.mockResolvedValue(rule2({ placementPlacesMode: 'OFF', maxClassRoomsPerDay: 2 }));
        tx.lunchSetting.upsert.mockResolvedValue(storedRow());

        await service.upsert(dto({ generatorBestEffort: true, placementPlacesMode: 'SOFT' }), testUser());

        expect(sentOf().create).toMatchObject({ generatorBestEffort: true, placementPlacesMode: 'SOFT', maxClassRoomsPerDay: 2 });
        expect(sentOf().update).toMatchObject({ generatorBestEffort: true, placementPlacesMode: 'SOFT' });
        expect(sentOf().update).not.toHaveProperty('maxClassRoomsPerDay');

        // A tab from before either: neither field is written, in either half.
        await service.upsert(dto(), testUser());
        for (const arm of [sentOf().create, sentOf().update]) {
          expect(arm).not.toHaveProperty('generatorBestEffort');
          expect(arm).not.toHaveProperty('placementPlacesMode');
        }
        // The stored rule 2 is not read for a request that does not touch it, and the switch alone does not touch it.
        tx.lunchSetting.findUnique.mockClear();
        await service.upsert(dto({ generatorBestEffort: false }), testUser());
        expect(tx.lunchSetting.findUnique).not.toHaveBeenCalled();
        expect(sentOf().create).toMatchObject({ generatorBestEffort: false });
      });

      it('adds nothing of the stored row to a request that says nothing about rule 2, or to a school with no row', async () => {
        tx.lunchSetting.upsert.mockResolvedValue(storedRow());
        await service.upsert(dto({ placementEdgeMode: 'SOFT' }), testUser());
        expect(sentOf().create).not.toHaveProperty('placementPlacesMode');
        expect(sentOf().create).not.toHaveProperty('maxClassRoomsPerDay');

        tx.lunchSetting.findUnique.mockResolvedValue(null);
        await service.upsert(dto({ placementPlacesMode: 'SOFT', maxTeacherBuildingsPerDay: 1 }), testUser());
        expect(Object.keys(sentOf().create).filter((key) => key.startsWith('max') && key !== 'maxLessonsPerDayPerGroup')).toEqual(['maxTeacherBuildingsPerDay']);
      });
    });

    it('answers the database’s own CHECK, met by a request that raced another, with the same 400', async () => {
      tx.lunchSetting.findUnique.mockResolvedValue(rule2({ maxClassRoomsPerDay: 2 }));
      tx.lunchSetting.upsert.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Invalid `upsert()` invocation', {
          code: 'P2039',
          clientVersion: Prisma.prismaVersion.client,
          meta: { driverAdapterError: { cause: { originalCode: '23514', originalMessage: 'new row for relation "LunchSettings" violates check constraint "LunchSettings_placementPlaces_needs_a_limit_check"' } } },
        }),
      );

      const error = await refusal(service.upsert(dto({ placementPlacesMode: 'SOFT' }), testUser()));

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error!.getResponse()).toMatchObject({ code: 'PLACEMENT_PLACES_NEEDS_A_LIMIT' });
    });

    it('lets any other refusal take the route it always did', async () => {
      tx.lunchSetting.upsert.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Simulated P2003', { code: 'P2003', clientVersion: Prisma.prismaVersion.client }),
      );

      await expect(service.upsert(dto({ placementEdgeMode: 'SOFT' }), testUser())).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
