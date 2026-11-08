import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createPrismaMock, createTxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { JobRunner } from '../jobs/job-runner';
import type { NotificationDeliveryService } from '../notifications/notification-delivery.service';
import { MEAL_LETTER_GRACE_MINUTES, MEAL_LETTER_INTERVAL_MS, MEAL_LETTER_JOB, SCHOOLS_PER_TICK, type MealRows } from './meal-counts';
import { MealLetterJob } from './meal-letter.job';

type Statement = { strings: string[]; values: unknown[] };
const sql = (statement: unknown) => (statement as Statement).strings.join('?');
const config = (background: boolean) => ({ get: () => ({ background }) }) as unknown as ConfigService;

const rows = (day: string): MealRows => ({
  cutoff: '08:30',
  staffModelled: true,
  classes: [
    { day, groupId: 'g1', name: '7A', start: '10:30', end: '11:00', pupils: 24, absentBefore: 1, absentAfter: 0, underActivity: false },
    { day, groupId: 'g2', name: '7B', start: '10:30', end: '11:00', pupils: 25, absentBefore: 0, absentAfter: 0, underActivity: false },
  ],
  staff: [{ day, start: '10:30', end: '11:00', staff: 3 }],
});

/**
 * A database stand-in for one morning: which schools are due, and what each school's letter is made of.
 */
function morning(
  options: {
    due?: string[];
    letters?: Record<string, unknown>;
    localDay?: string;
    failFor?: string;
    sent?: boolean | ((address: string) => boolean);
  } = {},
) {
  const tx = createTxMock();
  const prisma = createPrismaMock(tx);
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const day = options.localDay ?? '2027-02-04';
  tx.$queryRaw = jest.fn(async (statement: unknown) => {
    const text = sql(statement);
    const values = (statement as Statement).values;
    calls.push({ text, values });
    if (text.includes('app.meal_letter_schools(')) return (options.due ?? []).map((id) => ({ id }));
    if (text.includes('app.meal_letter(')) {
      if (values[0] === options.failFor) throw Object.assign(new Error('boom'), { name: 'PrismaClientKnownRequestError' });
      const own = options.letters && values[0] as string in options.letters;
      return [{ doc: own ? options.letters![values[0] as string] : { school: 'Testskolan', email: 'kok@testskolan.se', ...rows(day) } }];
    }
    return [];
  });
  const runner = new JobRunner();
  const claim = jest
    .spyOn(runner, 'claimNightly')
    .mockImplementation(async (_job, _hour, ids) => ids.map((schoolId) => ({ schoolId, localDay: new Date(`${day}T00:00:00Z`) })));
  const finish = jest.spyOn(runner, 'finishNightly').mockResolvedValue();
  const settled = jest.spyOn(runner, 'settled');
  const delivery = {
    sendLetter: jest.fn(async (address: string) => (typeof options.sent === 'function' ? options.sent(address) : (options.sent ?? true))),
  };
  const job = new MealLetterJob(prisma as unknown as PrismaService, delivery as unknown as NotificationDeliveryService, config(true), runner);
  return { job, runner, calls, claim, finish, settled, delivery, prisma };
}

describe('MealLetterJob', () => {
  let spies: jest.SpyInstance[];
  beforeEach(() => {
    spies = (['log', 'warn'] as const).map((level) => jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined));
  });
  afterEach(() => spies.forEach((spy) => spy.mockRestore()));

  it('registers every two minutes only when MEAL_LETTER_BACKGROUND is on, and leaves on shutdown', () => {
    const runner = new JobRunner();
    const register = jest.spyOn(runner, 'register');
    const prisma = createPrismaMock(createTxMock()) as unknown as PrismaService;
    const delivery = {} as NotificationDeliveryService;
    const off = new MealLetterJob(prisma, delivery, config(false), runner);
    off.onModuleInit();
    expect(off.scheduled).toBe(false);
    const none = new MealLetterJob(prisma, delivery);
    none.onModuleInit();
    expect(none.scheduled).toBe(false);
    const on = new MealLetterJob(prisma, delivery, config(true), runner);
    on.onModuleInit();
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ name: MEAL_LETTER_JOB, intervalMs: MEAL_LETTER_INTERVAL_MS }));
    expect(MEAL_LETTER_INTERVAL_MS).toBe(120_000);
    expect(on.scheduled).toBe(true);
    on.onModuleDestroy();
    expect(on.scheduled).toBe(false);
  });

  it('claims nothing, and counts a school of none, when no school is due', async () => {
    const { job, claim, settled, delivery } = morning({ due: [] });
    await job.tick();
    expect(claim).not.toHaveBeenCalled();
    expect(delivery.sendLetter).not.toHaveBeenCalled();
    expect(settled).toHaveBeenCalledWith(MEAL_LETTER_JOB, expect.any(Date), { ok: true, counts: { schools: 0 } });
  });

  it('asks which schools are due at the time of the pass, with the grace, and claims them at hour 0 five at a time', async () => {
    const { job, claim, calls } = morning({ due: ['s1', 's2'] });
    const at = new Date('2027-02-04T07:45:00Z');
    await job.tick(at);
    const ask = calls.find((call) => call.text.includes('meal_letter_schools('))!;
    expect(ask.values).toEqual([at, MEAL_LETTER_GRACE_MINUTES]);
    expect(MEAL_LETTER_GRACE_MINUTES).toBe(180);
    // The database has already asked each school's own hour: the claim only keeps one letter a day.
    expect(claim).toHaveBeenCalledWith(MEAL_LETTER_JOB, 0, ['s1', 's2'], SCHOOLS_PER_TICK, at);
  });

  it('sends the day\'s letter to the school\'s address, from the school\'s counts, and marks the claim done', async () => {
    const { job, delivery, finish, settled, calls } = morning({ due: ['s1'] });
    await job.tick();
    const ask = calls.find((call) => call.text.includes('app.meal_letter('))!;
    expect(ask.values).toEqual(['s1', '2027-02-04']);
    expect(delivery.sendLetter).toHaveBeenCalledTimes(1);
    const [address, subject, body] = delivery.sendLetter.mock.calls[0]! as unknown as [string, string, string];
    expect(address).toBe('kok@testskolan.se');
    expect(subject).toBe('Portioner torsdag 4 februari 2027');
    expect(body).toContain('Portioner torsdag 4 februari 2027 – Testskolan');
    expect(body).toContain('Läget klockan 08:30.');
    expect(body).toContain('Sittning 10:30–11:00: 51 portioner');
    expect(body).toContain('7A 23, 7B 25');
    expect(finish).toHaveBeenCalledWith(MEAL_LETTER_JOB, 's1', new Date('2027-02-04T00:00:00Z'), expect.any(Date));
    expect(settled).toHaveBeenCalledWith(MEAL_LETTER_JOB, expect.any(Date), { ok: true, counts: { schools: 1, failed: 0, letters: 1, unsent: 0 } });
  });

  it('writes no address, name or figure in the log', async () => {
    const { job } = morning({ due: ['s1'] });
    await job.tick();
    const lines = spies.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])));
    expect(lines.some((line) => line.includes('Meal letter [school=s1'))).toBe(true);
    expect(lines.join('\n')).not.toMatch(/kok@|Testskolan|7A/);
  });

  it('leaves the claim open when the mail was not taken, so the claim is taken again two hours on', async () => {
    const { job, finish, delivery, settled } = morning({ due: ['s1'], sent: false });
    await job.tick();
    expect(delivery.sendLetter).toHaveBeenCalledTimes(1);
    expect(finish).not.toHaveBeenCalled();
    expect(settled).toHaveBeenCalledWith(MEAL_LETTER_JOB, expect.any(Date), { ok: true, counts: { schools: 1, failed: 0, letters: 0, unsent: 1 } });
  });

  it.each([
    ['the school turned the letter off after it was named', null],
    ['an answer without an address', { school: 'Testskolan', ...rows('2027-02-04') }],
    ['an answer without a school', { email: 'kok@testskolan.se', ...rows('2027-02-04') }],
    ['a day with no sitting any more', { school: 'Testskolan', email: 'kok@testskolan.se', cutoff: '08:30', staffModelled: false, classes: [], staff: [] }],
    ['a school with no cut-off', { school: 'Testskolan', email: 'kok@testskolan.se', ...rows('2027-02-04'), cutoff: null }],
  ])('sends nothing and finishes nothing for %s', async (_label, doc) => {
    const { job, delivery, finish } = morning({ due: ['s1'], letters: { s1: doc } });
    await job.tick();
    expect(delivery.sendLetter).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it('reads the answer when it comes as text', async () => {
    const { job, delivery } = morning({ due: ['s1'], letters: { s1: JSON.stringify({ school: 'Testskolan', email: 'kok@testskolan.se', ...rows('2027-02-04') }) } });
    await job.tick();
    expect(delivery.sendLetter).toHaveBeenCalledTimes(1);
  });

  it('goes on to the next school when one fails, and counts it', async () => {
    const { job, delivery, finish, settled } = morning({ due: ['s1', 's2'], failFor: 's1' });
    await job.tick();
    expect(delivery.sendLetter).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith(MEAL_LETTER_JOB, 's2', expect.any(Date), expect.any(Date));
    expect(settled).toHaveBeenCalledWith(MEAL_LETTER_JOB, expect.any(Date), { ok: true, counts: { schools: 2, failed: 1, letters: 1, unsent: 0 } });
    expect(spies.flatMap((spy) => spy.mock.calls.map((call) => String(call[0]))).some((line) => line.includes('Meal letter failed [school=s1, PrismaClientKnownRequestError]'))).toBe(true);
  });

  it('counts the pass as failed, and says by class name only, when the questions to the database fail', async () => {
    const { job, prisma, settled } = morning({ due: ['s1'] });
    prisma.withDeliveryService.mockRejectedValueOnce(Object.assign(new Error('down'), { name: 'PrismaClientInitializationError' }));
    await job.tick();
    expect(settled).toHaveBeenCalledWith(MEAL_LETTER_JOB, expect.any(Date), { ok: false, error: 'PrismaClientInitializationError' });
  });

  it('waits for the pass that is running instead of starting another', async () => {
    const { job, claim } = morning({ due: ['s1'] });
    await Promise.all([job.tick(), job.tick()]);
    expect(claim).toHaveBeenCalledTimes(1);
  });
});
