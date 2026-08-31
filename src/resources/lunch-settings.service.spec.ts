import { BadRequestException, ForbiddenException } from '@nestjs/common';
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
        ['a start that is not a whole quarter', { lunchStartTime: '11:10' }],
        ['an end that is not a whole quarter', { lunchEndTime: '12:50' }],
        ['a break that is not a whole number of quarters', { lunchMinutes: 40 }],
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
  });
});
