import { BadRequestException } from '@nestjs/common';
import { createPrismaMock, createTxMock, testUser } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { MEAL_COUNTS_BAD_ANSWER, MEAL_COUNTS_PAST, MEAL_COUNTS_RANGE, MEAL_LETTER_NEEDS_ADDRESS_AND_HOUR, type MealRows } from './meal-counts';
import { MealCountsService } from './meal-counts.service';

const admin = testUser({ schoolId: 'school-1' });
type Statement = { strings: string[]; values: unknown[] };
const sql = (statement: unknown) => (statement as Statement).strings.join('?');
const time = (value: string) => new Date(`1970-01-01T${value}:00.000Z`);

const doc: MealRows = {
  cutoff: '08:30',
  staffModelled: true,
  classes: [
    { day: '2027-02-04', groupId: 'g1', name: '7A', start: '10:30', end: '11:00', pupils: 24, absentBefore: 1, absentAfter: 0, underActivity: false },
  ],
  staff: [{ day: '2027-02-04', start: '10:30', end: '11:00', staff: 2 }],
};

/** The school is on `today`; the database answers `answer` for the counts and `last` for the last letter. */
function setup(options: { today?: string; answer?: unknown; last?: string | null } = {}) {
  const tx = createTxMock();
  const prisma = createPrismaMock(tx);
  const calls: Array<{ text: string; values: unknown[] }> = [];
  tx.$queryRaw = jest.fn(async (statement: unknown) => {
    const text = sql(statement);
    calls.push({ text, values: (statement as Statement).values });
    if (text.includes('app.school_today()')) return [{ today: new Date(`${options.today ?? '2027-02-04'}T00:00:00Z`) }];
    if (text.includes('app.meal_counts_for_me(')) return [{ doc: 'answer' in options ? options.answer : doc }];
    if (text.includes('app.meal_letter_last_for_me()')) return [{ day: options.last ? new Date(`${options.last}T00:00:00Z`) : null }];
    return [];
  });
  const service = new MealCountsService(prisma as unknown as PrismaService);
  return { tx, calls, service };
}

describe('MealCountsService.view', () => {
  it('asks the database for the days and builds the view from the answer', async () => {
    const { service, calls } = setup();
    const view = await service.view({ from: '2027-02-04', to: '2027-02-05' }, admin);
    const ask = calls.find((call) => call.text.includes('meal_counts_for_me'))!;
    expect(ask.values).toEqual(['2027-02-04', '2027-02-05']);
    expect(view.days.map((day) => [day.date, day.totals.portions])).toEqual([['2027-02-04', 25], ['2027-02-05', 0]]);
    expect(view).toMatchObject({ from: '2027-02-04', to: '2027-02-05', cutoff: '08:30', staffModelled: true });
  });

  it('answers today when it is not asked for a day, and one day when it is not asked for an end', async () => {
    const { service, calls } = setup({ today: '2027-02-04' });
    await service.view({}, admin);
    expect(calls.find((call) => call.text.includes('meal_counts_for_me'))!.values).toEqual(['2027-02-04', '2027-02-04']);
    await service.view({ from: '2027-02-08' }, admin);
    expect(calls.filter((call) => call.text.includes('meal_counts_for_me')).at(-1)!.values).toEqual(['2027-02-08', '2027-02-08']);
  });

  it('counts `days` from the first day, from today when there is none, and takes it for the end', async () => {
    const { service, calls } = setup({ today: '2027-02-04' });
    const week = await service.view({ days: 7 }, admin);
    expect(calls.find((call) => call.text.includes('meal_counts_for_me'))!.values).toEqual(['2027-02-04', '2027-02-10']);
    expect(week.days.map((day) => day.date)).toEqual(['2027-02-04', '2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09', '2027-02-10']);
    const month = await service.view({ from: '2027-02-26', days: 4 }, admin);
    expect(month.to).toBe('2027-03-01');
    expect((await service.view({ days: 1 }, admin)).to).toBe('2027-02-04');
    await expect(service.view({ days: 14 }, admin)).resolves.toBeDefined();
    await expect(service.view({ days: 15 }, admin)).rejects.toMatchObject({ response: expect.objectContaining({ code: MEAL_COUNTS_RANGE }) });
    await expect(service.view({ to: '2027-02-05', days: 2 }, admin)).rejects.toMatchObject({ response: expect.objectContaining({ code: MEAL_COUNTS_RANGE }) });
  });

  it('takes a period of 14 days and refuses 15, and one that ends before it starts', async () => {
    const { service } = setup();
    await expect(service.view({ from: '2027-02-04', to: '2027-02-17' }, admin)).resolves.toBeDefined();
    await expect(service.view({ from: '2027-02-04', to: '2027-02-18' }, admin)).rejects.toMatchObject({
      response: expect.objectContaining({ code: MEAL_COUNTS_RANGE }),
    });
    await expect(service.view({ from: '2027-02-05', to: '2027-02-04' }, admin)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.view({ from: '2027-02-05', to: '2027-02-04' }, admin)).rejects.toMatchObject({
      response: expect.objectContaining({ code: MEAL_COUNTS_RANGE }),
    });
  });

  it("refuses a day before today, by the school's own date, and never asks the database", async () => {
    const { service, calls } = setup({ today: '2027-02-04' });
    await expect(service.view({ from: '2027-02-03', to: '2027-02-04' }, admin)).rejects.toMatchObject({
      response: expect.objectContaining({ code: MEAL_COUNTS_PAST }),
    });
    expect(calls.some((call) => call.text.includes('meal_counts_for_me'))).toBe(false);
    await expect(service.view({ from: '2027-02-04' }, admin)).resolves.toBeDefined();
  });

  it('refuses an answer that is not the contract', async () => {
    const { service } = setup({ answer: { classes: 'many' } });
    await expect(service.view({ from: '2027-02-04' }, admin)).rejects.toThrow(MEAL_COUNTS_BAD_ANSWER);
    const none = setup({ answer: undefined });
    await expect(none.service.view({ from: '2027-02-04' }, admin)).rejects.toThrow(MEAL_COUNTS_BAD_ANSWER);
  });

  it('is refused a caller with no school', async () => {
    const { service } = setup();
    await expect(service.view({}, testUser({ schoolId: undefined }))).rejects.toThrow();
  });
});

describe('MealCountsService.csv', () => {
  it('is the view as windows-1252 bytes, named for the period', async () => {
    const { service } = setup();
    const file = await service.csv({ from: '2027-02-04', to: '2027-02-05' }, admin);
    expect(file.filename).toBe('portioner-2027-02-04-2027-02-05.csv');
    const text = new TextDecoder('windows-1252').decode(file.body);
    expect(text.split('\r\n')[1]).toBe('2027-02-04;torsdag;10:30;11:00;7A 23;24;1;2;25;0;0');
  });
});

describe('MealCountsService settings', () => {
  it('says none when the school has set nothing', async () => {
    const { service, tx } = setup();
    tx['kitchenSetting']!['findUnique']!.mockResolvedValue(null);
    await expect(service.settings(admin)).resolves.toEqual({ cutoffTime: null, letterEnabled: false, kitchenEmail: null, lastLetterOn: null });
    expect(tx['kitchenSetting']!['findUnique']).toHaveBeenCalledWith({ where: { schoolId: 'school-1' } });
  });

  it('reads the cut-off as HH:MM and the day of the last letter as a date', async () => {
    const { service, tx } = setup({ last: '2027-02-03' });
    tx['kitchenSetting']!['findUnique']!.mockResolvedValue({ cutoffTime: time('08:30'), letterEnabled: true, kitchenEmail: 'kok@skolan.se' });
    await expect(service.settings(admin)).resolves.toEqual({ cutoffTime: '08:30', letterEnabled: true, kitchenEmail: 'kok@skolan.se', lastLetterOn: '2027-02-03' });
  });

  describe('updateSettings', () => {
    it('creates the row for a school without one, with the letter off', async () => {
      const { service, tx } = setup();
      tx['kitchenSetting']!['findUnique']!.mockResolvedValue(null);
      await service.updateSettings({ cutoffTime: '08:30' }, admin);
      expect(tx['kitchenSetting']!['upsert']).toHaveBeenCalledWith({
        where: { schoolId: 'school-1' },
        create: { schoolId: 'school-1', cutoffTime: time('08:30'), letterEnabled: false, kitchenEmail: null },
        update: { cutoffTime: time('08:30'), letterEnabled: false, kitchenEmail: null },
      });
    });

    it('keeps what the save does not name', async () => {
      const { service, tx } = setup();
      tx['kitchenSetting']!['findUnique']!.mockResolvedValue({ cutoffTime: time('08:30'), letterEnabled: true, kitchenEmail: 'kok@skolan.se' });
      await service.updateSettings({ kitchenEmail: 'ny@skolan.se' }, admin);
      expect(tx['kitchenSetting']!['upsert']).toHaveBeenCalledWith(
        expect.objectContaining({ update: { cutoffTime: time('08:30'), letterEnabled: true, kitchenEmail: 'ny@skolan.se' } }),
      );
    });

    it('turns the letter on only when the merged settings have an hour and an address', async () => {
      const { service, tx } = setup();
      tx['kitchenSetting']!['findUnique']!.mockResolvedValue({ cutoffTime: time('08:30'), letterEnabled: false, kitchenEmail: null });
      await expect(service.updateSettings({ letterEnabled: true }, admin)).rejects.toMatchObject({
        response: expect.objectContaining({ code: MEAL_LETTER_NEEDS_ADDRESS_AND_HOUR }),
      });
      await service.updateSettings({ letterEnabled: true, kitchenEmail: 'kok@skolan.se' }, admin);
      expect(tx['kitchenSetting']!['upsert']).toHaveBeenCalledTimes(1);
      tx['kitchenSetting']!['findUnique']!.mockResolvedValue({ cutoffTime: null, letterEnabled: false, kitchenEmail: 'kok@skolan.se' });
      await expect(service.updateSettings({ letterEnabled: true }, admin)).rejects.toBeInstanceOf(BadRequestException);
      expect(tx['kitchenSetting']!['upsert']).toHaveBeenCalledTimes(1);
    });

    it('refuses to clear the address or the hour of a letter that stays on, and clears them once it is off', async () => {
      const { service, tx } = setup();
      tx['kitchenSetting']!['findUnique']!.mockResolvedValue({ cutoffTime: time('08:30'), letterEnabled: true, kitchenEmail: 'kok@skolan.se' });
      await expect(service.updateSettings({ kitchenEmail: null }, admin)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.updateSettings({ cutoffTime: null }, admin)).rejects.toBeInstanceOf(BadRequestException);
      await service.updateSettings({ letterEnabled: false, cutoffTime: null, kitchenEmail: null }, admin);
      expect(tx['kitchenSetting']!['upsert']).toHaveBeenCalledWith(
        expect.objectContaining({ update: { cutoffTime: null, letterEnabled: false, kitchenEmail: null } }),
      );
    });

    it('answers the settings as they now are', async () => {
      const { service, tx } = setup({ last: '2027-02-02' });
      tx['kitchenSetting']!['findUnique']!.mockResolvedValue({ cutoffTime: time('09:15'), letterEnabled: false, kitchenEmail: null });
      await expect(service.updateSettings({}, admin)).resolves.toEqual({ cutoffTime: '09:15', letterEnabled: false, kitchenEmail: null, lastLetterOn: '2027-02-02' });
    });
  });
});
