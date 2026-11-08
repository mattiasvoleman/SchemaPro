import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createPrismaMock, createTxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { JobRunner } from '../jobs/job-runner';
import { ABSENCE_STATS_HOUR_LOCAL, ABSENCE_STATS_INTERVAL_MS, ABSENCE_STATS_JOB, BACKFILL_MONTHS, SCHOOLS_PER_TICK } from './absence-stats';
import { AbsenceStatsJob } from './absence-stats.job';

type Statement = { strings: string[]; values: unknown[] };
const sql = (statement: unknown) => (statement as Statement).strings.join('?');
const config = (background: boolean) => ({ get: () => ({ background }) }) as unknown as ConfigService;

/**
 * A database stand-in for one night: which schools have lessons, which months
 * the plan asks for, what each month's count says and what the trim removes.
 */
function night(
  options: {
    schools?: string[];
    plan?: Record<string, string[]>;
    counted?: Record<string, { written: number; removed: number; classes: number }>;
    trimmed?: Record<string, number>;
    failPlan?: string;
    failMonth?: string;
    localDay?: string;
  } = {},
) {
  const localDay = options.localDay ?? '2026-11-07';
  const tx = createTxMock();
  const prisma = createPrismaMock(tx);
  const events: string[] = [];
  const calls: Array<{ text: string; values: unknown[] }> = [];
  tx.$executeRaw = jest.fn(async (statement: unknown) => {
    events.push(`exec:${(Array.isArray(statement) ? statement.join('?') : sql(statement)).trim()}`);
    return 0;
  });
  tx.$queryRaw = jest.fn(async (statement: unknown) => {
    const text = sql(statement);
    const values = (statement as Statement).values;
    calls.push({ text, values });
    const school = values[0] as string;
    if (text.includes('app.reporting_schools()')) {
      events.push('schools');
      return (options.schools ?? []).map((id) => ({ id }));
    }
    if (text.includes('app.absence_stats_plan(')) {
      events.push(`plan:${school}`);
      if (school === options.failPlan) throw Object.assign(new Error('boom'), { name: 'PrismaClientKnownRequestError' });
      return (options.plan?.[school] ?? []).map((month) => ({ month }));
    }
    if (text.includes('app.absence_stats_month(')) {
      events.push(`month:${school}:${values[1] as string}`);
      if (values[1] === options.failMonth) throw Object.assign(new Error('boom'), { name: 'PrismaClientKnownRequestError' });
      return [options.counted?.[`${school}|${values[1] as string}`] ?? { written: 0, removed: 0, classes: 0 }];
    }
    if (text.includes('app.absence_stats_trim(')) {
      events.push(`trim:${school}`);
      return [{ trimmed: options.trimmed?.[school] ?? 0 }];
    }
    return [];
  });
  (prisma.withDeliveryService as jest.Mock).mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => {
    const result = await fn(tx);
    events.push('commit');
    return result;
  });
  const runner = new JobRunner();
  const claim = jest
    .spyOn(runner, 'claimNightly')
    .mockImplementation(async (_job, _hour, ids) => ids.map((schoolId) => ({ schoolId, localDay: new Date(`${localDay}T00:00:00Z`) })));
  const finish = jest.spyOn(runner, 'finishNightly').mockResolvedValue();
  const settled = jest.spyOn(runner, 'settled');
  const job = new AbsenceStatsJob(prisma as unknown as PrismaService, config(true), runner);
  return { job, runner, calls, claim, finish, settled, prisma, tx, events };
}

describe('AbsenceStatsJob', () => {
  let spies: jest.SpyInstance[];
  beforeEach(() => {
    spies = (['log', 'warn'] as const).map((level) => jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined));
  });
  afterEach(() => spies.forEach((spy) => spy.mockRestore()));

  it('registers every five minutes only when ABSENCE_STATS_BACKGROUND is on, and leaves on shutdown', () => {
    const runner = new JobRunner();
    const register = jest.spyOn(runner, 'register');
    const prisma = createPrismaMock(createTxMock()) as unknown as PrismaService;
    const off = new AbsenceStatsJob(prisma, config(false), runner);
    off.onModuleInit();
    expect(off.scheduled).toBe(false);
    const on = new AbsenceStatsJob(prisma, config(true), runner);
    on.onModuleInit();
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ name: ABSENCE_STATS_JOB, intervalMs: ABSENCE_STATS_INTERVAL_MS }));
    expect(ABSENCE_STATS_JOB).toBe('absence-stats');
    expect(ABSENCE_STATS_INTERVAL_MS).toBe(5 * 60 * 1000);
    expect(on.scheduled).toBe(true);
    on.onModuleDestroy();
    expect(on.scheduled).toBe(false);
  });

  it('registers nothing without a configuration or without a runner, as the test graph has it', () => {
    const runner = new JobRunner();
    const register = jest.spyOn(runner, 'register');
    const prisma = createPrismaMock(createTxMock()) as unknown as PrismaService;
    new AbsenceStatsJob(prisma, undefined, runner).onModuleInit();
    const bare = new AbsenceStatsJob(prisma, config(true), undefined);
    bare.onModuleInit();
    bare.onModuleDestroy();
    expect(register).not.toHaveBeenCalled();
    expect(bare.scheduled).toBe(false);
  });

  it('claims nothing, and counts a school of none, when no school has a lesson in the last 90 days', async () => {
    const { job, claim, settled } = night({ schools: [] });
    await job.tick();
    expect(claim).not.toHaveBeenCalled();
    expect(settled).toHaveBeenCalledWith(ABSENCE_STATS_JOB, expect.any(Date), { ok: true, counts: { schools: 0 } });
  });

  it('does a pass without a runner, which has nobody to claim from: nothing happens', async () => {
    const tx = createTxMock();
    tx.$queryRaw = jest.fn().mockResolvedValue([{ id: 's1' }]);
    const prisma = createPrismaMock(tx);
    const job = new AbsenceStatsJob(prisma as unknown as PrismaService);
    await expect(job.tick()).resolves.toBeUndefined();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('claims the schools with a lesson, at seven in the morning their time, five at a time', async () => {
    const { job, claim } = night({ schools: ['s1', 's2'] });
    const at = new Date('2026-11-07T05:00:00Z');
    await job.tick(at);
    expect(claim).toHaveBeenCalledWith(ABSENCE_STATS_JOB, ABSENCE_STATS_HOUR_LOCAL, ['s1', 's2'], SCHOOLS_PER_TICK, at);
    expect(ABSENCE_STATS_HOUR_LOCAL).toBe(7);
    expect(SCHOOLS_PER_TICK).toBe(5);
    expect(BACKFILL_MONTHS).toBe(3);
  });

  it('counts the months of the plan up to and including yesterday in the school’s dates, each in a transaction of its own that asks for 9 s', async () => {
    const { job, calls, events, finish } = night({
      schools: ['s1'],
      plan: { s1: ['2026-11-01', '2026-10-01'] },
      counted: { 's1|2026-11-01': { written: 2, removed: 0, classes: 1 }, 's1|2026-10-01': { written: 1, removed: 1, classes: 3 } },
      trimmed: { s1: 4 },
    });
    await job.tick();
    expect(calls.find((call) => call.text.includes('app.absence_stats_plan('))?.values).toEqual(['s1', '2026-11-06', BACKFILL_MONTHS]);
    expect(calls.filter((call) => call.text.includes('app.absence_stats_month(')).map((call) => call.values)).toEqual([
      ['s1', '2026-11-01', '2026-11-06'],
      ['s1', '2026-10-01', '2026-11-06'],
    ]);
    expect(calls.find((call) => call.text.includes('app.absence_stats_trim('))?.values).toEqual(['s1', '2026-11-06']);
    // plan, then each month with its own timeout in its own transaction, then the trim.
    expect(events.slice(events.indexOf('schools') + 2)).toEqual([
      'plan:s1',
      'commit',
      `exec:SET LOCAL statement_timeout = '9s'`,
      'month:s1:2026-11-01',
      'commit',
      `exec:SET LOCAL statement_timeout = '9s'`,
      'month:s1:2026-10-01',
      'commit',
      'trim:s1',
      'commit',
    ]);
    expect(finish).toHaveBeenCalledWith(ABSENCE_STATS_JOB, 's1', new Date('2026-11-07T00:00:00Z'), expect.any(Date));
  });

  it('reads the month the plan answers as a date as well as a string', async () => {
    const tx = createTxMock();
    const prisma = createPrismaMock(tx);
    tx.$queryRaw = jest.fn(async (statement: unknown) => {
      const text = sql(statement);
      if (text.includes('app.absence_stats_plan(')) return [{ month: new Date('2026-10-01T00:00:00Z') }];
      if (text.includes('app.absence_stats_month(')) return [{ written: 1, removed: 0, classes: 1 }];
      if (text.includes('app.absence_stats_trim(')) return [{ trimmed: 0 }];
      return [];
    });
    const job = new AbsenceStatsJob(prisma as unknown as PrismaService);
    await expect(job.runSchool('s1', new Date('2026-11-07T00:00:00Z'))).resolves.toEqual({ months: 1, written: 1, removed: 0, trimmed: 0, failedMonths: 0 });
  });

  it.each([
    ['the Monday after the spring switch', '2026-03-30', '2026-03-29'],
    ['the day of the spring switch', '2026-03-29', '2026-03-28'],
    ['the Monday after the fall switch', '2026-10-26', '2026-10-25'],
    ['the first of a month', '2026-11-01', '2026-10-31'],
    ['the first of a year', '2027-01-01', '2026-12-31'],
    ['the day after a leap day', '2028-03-01', '2028-02-29'],
  ])('the day before %s is %s', async (_label, localDay, expected) => {
    const { job, calls } = night({ schools: ['s1'], localDay, plan: { s1: ['2026-02-01'] } });
    await job.tick();
    expect(calls.find((call) => call.text.includes('app.absence_stats_plan('))?.values).toEqual(['s1', expected, BACKFILL_MONTHS]);
    expect(calls.find((call) => call.text.includes('app.absence_stats_trim('))?.values).toEqual(['s1', expected]);
  });

  it('sums a night over the schools it ran, and settles with the counts', async () => {
    const { job, settled } = night({
      schools: ['s1', 's2'],
      plan: { s1: ['2026-11-01'], s2: ['2026-11-01', '2026-10-01'] },
      counted: {
        's1|2026-11-01': { written: 2, removed: 0, classes: 1 },
        's2|2026-11-01': { written: 3, removed: 1, classes: 2 },
        's2|2026-10-01': { written: 1, removed: 0, classes: 2 },
      },
      trimmed: { s2: 5 },
    });
    await job.tick();
    expect(settled).toHaveBeenCalledWith(ABSENCE_STATS_JOB, expect.any(Date), {
      ok: true,
      counts: { schools: 2, failed: 0, months: 3, written: 6, removed: 1, trimmed: 5, failedMonths: 0 },
    });
  });

  it('leaves a school whose month failed for the claim to retry, runs its other months and the next school', async () => {
    const { job, finish, events, settled } = night({
      schools: ['s1', 's2'],
      plan: { s1: ['2026-11-01', '2026-10-01'], s2: ['2026-11-01'] },
      failMonth: '2026-11-01',
      counted: { 's1|2026-10-01': { written: 1, removed: 0, classes: 1 } },
    });
    await job.tick();
    // s1: November fails, October runs, the trim runs; s2's November fails too (same stand-in), so neither is finished.
    expect(events).toContain('month:s1:2026-10-01');
    expect(events).toContain('trim:s1');
    expect(events).toContain('plan:s2');
    expect(finish).not.toHaveBeenCalled();
    expect(settled).toHaveBeenCalledWith(ABSENCE_STATS_JOB, expect.any(Date), {
      ok: true,
      counts: expect.objectContaining({ schools: 2, failed: 2, months: 1, failedMonths: 2 }),
    });
  });

  it('leaves a school whose plan failed for the claim to retry, and runs the next school', async () => {
    const { job, finish, events, settled } = night({ schools: ['s1', 's2'], plan: { s2: ['2026-11-01'] }, failPlan: 's1' });
    await job.tick();
    expect(events).not.toContain('trim:s1');
    expect(events).toContain('month:s2:2026-11-01');
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith(ABSENCE_STATS_JOB, 's2', expect.any(Date), expect.any(Date));
    expect(settled).toHaveBeenCalledWith(ABSENCE_STATS_JOB, expect.any(Date), { ok: true, counts: expect.objectContaining({ schools: 2, failed: 1 }) });
  });

  it('logs a school’s id and counts and never a name', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const log = jest.spyOn(Logger.prototype, 'log');
    const { job } = night({ schools: ['s1'], plan: { s1: ['2026-11-01'] }, counted: { 's1|2026-11-01': { written: 2, removed: 0, classes: 1 } }, trimmed: { s1: 1 } });
    await job.tick();
    expect(log).toHaveBeenCalledWith('Absence stats [school=s1, months=1, written=2, removed=0, trimmed=1, failedMonths=0]');
    const failing = night({ schools: ['s9'], plan: { s9: ['2026-11-01'] }, failMonth: '2026-11-01' });
    await failing.job.tick();
    expect(warn).toHaveBeenCalledWith('Absence stats month failed [school=s9, month=2026-11-01, PrismaClientKnownRequestError]');
  });

  it('writes nothing to the log on a night with nothing to say', async () => {
    const log = jest.spyOn(Logger.prototype, 'log');
    const { job } = night({ schools: ['s1'], plan: { s1: [] } });
    await job.tick();
    expect(log).not.toHaveBeenCalled();
  });

  it('a tick while the last one runs waits for it instead of starting another', async () => {
    const { job, calls } = night({ schools: ['s1'], plan: { s1: ['2026-11-01'] } });
    const first = job.tick();
    const second = job.tick();
    await Promise.all([first, second]);
    expect(calls.filter((call) => call.text.includes('app.reporting_schools()'))).toHaveLength(1);
  });

  it('settles a pass that throws as failed, by the error’s name, and never throws', async () => {
    const { job, settled, prisma } = night({ schools: ['s1'] });
    (prisma.withDeliveryService as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('down'), { name: 'DatabaseDown' }));
    await expect(job.tick()).resolves.toBeUndefined();
    expect(settled).toHaveBeenCalledWith(ABSENCE_STATS_JOB, expect.any(Date), { ok: false, error: 'DatabaseDown' });
  });
});
