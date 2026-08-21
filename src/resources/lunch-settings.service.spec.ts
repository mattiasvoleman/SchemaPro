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

    it('refuses a principal carrying no school', async () => {
      await expect(
        service.get(testUser({ schoolId: undefined })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('upsert', () => {
    it('writes the row for the caller’s school, times parsed for @db.Time', async () => {
      const row = { id: 'ls-1' };
      tx.lunchSetting.upsert.mockResolvedValue(row);

      await expect(service.upsert(dto(), testUser())).resolves.toBe(row);

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
      tx.lunchSetting.upsert.mockResolvedValue({ id: 'ls-1' });

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
      tx.lunchSetting.upsert.mockResolvedValue({ id: 'ls-1' });

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
