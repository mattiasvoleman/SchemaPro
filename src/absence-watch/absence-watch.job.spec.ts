import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createPrismaMock, createTxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { JobRunner } from '../jobs/job-runner';
import type { NotificationsService } from '../notifications/notifications.service';
import { ABSENCE_WATCH_HOUR_LOCAL, ABSENCE_WATCH_INTERVAL_MS, ABSENCE_WATCH_JOB, SCHOOLS_PER_TICK } from './absence-watch';
import { AbsenceWatchJob } from './absence-watch.job';

type Statement = { strings: string[]; values: unknown[] };
const sql = (statement: unknown) => (statement as Statement).strings.join('?');
const config = (background: boolean) => ({ get: () => ({ background }) }) as unknown as ConfigService;

/**
 * A database stand-in for one night: which schools have the switch on, what
 * the count and the due periods are, and what a digest writes.
 */
function night(
  options: {
    schools?: string[];
    evaluated?: Record<string, { opened: number; kept: number; closed: number; pupils: number }>;
    due?: Record<string, Array<{ recipient_group: string; period_start: string; period_end: string }>>;
    written?: Record<string, Array<{ notification_id: string; user_id: string; email: string | null; meta: Record<string, unknown> }>>;
    failEvaluate?: string;
    localDay?: string;
  } = {},
) {
  const tx = createTxMock();
  const prisma = createPrismaMock(tx);
  const calls: Array<{ text: string; values: unknown[] }> = [];
  tx.$queryRaw = jest.fn(async (statement: unknown) => {
    const text = sql(statement);
    const values = (statement as Statement).values;
    calls.push({ text, values });
    if (text.includes('app.absence_watch_schools()')) return (options.schools ?? []).map((id) => ({ id }));
    if (text.includes('app.absence_watch_evaluate(')) {
      if (values[0] === options.failEvaluate) throw Object.assign(new Error('boom'), { name: 'PrismaClientKnownRequestError' });
      return [options.evaluated?.[values[0] as string] ?? { opened: 0, kept: 0, closed: 0, pupils: 0 }];
    }
    if (text.includes('app.absence_watch_digest_due(')) {
      return (options.due?.[values[0] as string] ?? []).map((row) => ({
        recipient_group: row.recipient_group,
        period_start: new Date(`${row.period_start}T00:00:00Z`),
        period_end: new Date(`${row.period_end}T00:00:00Z`),
      }));
    }
    if (text.includes('app.absence_watch_digest(')) return options.written?.[`${values[0] as string}|${values[1] as string}`] ?? [];
    return [];
  });
  const runner = new JobRunner();
  const claim = jest
    .spyOn(runner, 'claimNightly')
    .mockImplementation(async (_job, _hour, ids) => ids.map((schoolId) => ({ schoolId, localDay: new Date(`${options.localDay ?? '2026-10-21'}T00:00:00Z`) })));
  const finish = jest.spyOn(runner, 'finishNightly').mockResolvedValue();
  const settled = jest.spyOn(runner, 'settled');
  const notifications = { deliverCommitted: jest.fn() };
  const job = new AbsenceWatchJob(prisma as unknown as PrismaService, notifications as unknown as NotificationsService, config(true), runner);
  return { job, runner, calls, claim, finish, settled, notifications, prisma };
}

describe('AbsenceWatchJob', () => {
  let spies: jest.SpyInstance[];
  beforeEach(() => {
    spies = (['log', 'warn'] as const).map((level) => jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined));
  });
  afterEach(() => spies.forEach((spy) => spy.mockRestore()));

  it('registers every five minutes only when ABSENCE_WATCH_BACKGROUND is on, and leaves on shutdown', () => {
    const runner = new JobRunner();
    const register = jest.spyOn(runner, 'register');
    const prisma = createPrismaMock(createTxMock()) as unknown as PrismaService;
    const notifications = {} as NotificationsService;
    const off = new AbsenceWatchJob(prisma, notifications, config(false), runner);
    off.onModuleInit();
    expect(off.scheduled).toBe(false);
    const on = new AbsenceWatchJob(prisma, notifications, config(true), runner);
    on.onModuleInit();
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ name: ABSENCE_WATCH_JOB, intervalMs: ABSENCE_WATCH_INTERVAL_MS }));
    expect(on.scheduled).toBe(true);
    on.onModuleDestroy();
    expect(on.scheduled).toBe(false);
  });

  it('claims nothing, and counts a school of none, when no school has the switch on', async () => {
    const { job, claim, settled } = night({ schools: [] });
    await job.tick();
    expect(claim).not.toHaveBeenCalled();
    expect(settled).toHaveBeenCalledWith(ABSENCE_WATCH_JOB, expect.any(Date), { ok: true, counts: { schools: 0 } });
  });

  it('claims the schools with the switch on, at five in the morning their time, five at a time', async () => {
    const { job, claim } = night({ schools: ['s1', 's2'] });
    const at = new Date('2026-10-21T04:00:00Z');
    await job.tick(at);
    expect(claim).toHaveBeenCalledWith(ABSENCE_WATCH_JOB, ABSENCE_WATCH_HOUR_LOCAL, ['s1', 's2'], SCHOOLS_PER_TICK, at);
    expect(ABSENCE_WATCH_HOUR_LOCAL).toBe(5);
  });

  it('counts up to and including yesterday in the dates of the school, and asks which digests are due today', async () => {
    const { job, calls } = night({ schools: ['s1'], localDay: '2026-10-21' });
    await job.tick();
    const evaluate = calls.find((call) => call.text.includes('absence_watch_evaluate('))!;
    expect(evaluate.values).toEqual(['s1', '2026-10-20']);
    const due = calls.find((call) => call.text.includes('absence_watch_digest_due('))!;
    expect(due.values).toEqual(['s1', '2026-10-21']);
  });

  it.each([
    ['the Monday after the spring switch', '2026-03-30', '2026-03-29'],
    ['the day of the spring switch', '2026-03-29', '2026-03-28'],
    ['the Monday after the fall switch', '2026-10-26', '2026-10-25'],
    ['the first of a month', '2026-11-01', '2026-10-31'],
    ['the first of a year', '2027-01-01', '2026-12-31'],
    ['the day after a leap day', '2028-03-01', '2028-02-29'],
  ])('the day before %s is %s', async (_label, localDay, expected) => {
    const { job, calls } = night({ schools: ['s1'], localDay });
    await job.tick();
    expect(calls.find((call) => call.text.includes('absence_watch_evaluate('))!.values).toEqual(['s1', expected]);
  });

  it('writes each due digest and hands its notices to the delivery after the commit', async () => {
    const written = [
      { notification_id: 'n1', user_id: 'u1', email: 'u1@example.invalid', meta: { group: 'MENTOR', periodStart: '2026-10-12', periodEnd: '2026-10-18', open: 2, crossed: 1 } },
      { notification_id: 'n2', user_id: 'u2', email: null, meta: { group: 'MENTOR', periodStart: '2026-10-12', periodEnd: '2026-10-18', open: 2, crossed: 1 } },
    ];
    const { job, calls, notifications, settled } = night({
      schools: ['s1'],
      evaluated: { s1: { opened: 3, kept: 1, closed: 1, pupils: 480 } },
      due: { s1: [{ recipient_group: 'MENTOR', period_start: '2026-10-12', period_end: '2026-10-18' }] },
      written: { 's1|MENTOR': written },
    });
    await job.tick();
    const digest = calls.find((call) => call.text.includes('app.absence_watch_digest('))!;
    expect(digest.values).toEqual(['s1', 'MENTOR', '2026-10-12', '2026-10-18', '2026-10-21']);
    expect(notifications.deliverCommitted).toHaveBeenCalledTimes(1);
    const [entries] = notifications.deliverCommitted.mock.calls[0]! as [Array<{ type: string; recipients: unknown[] }>];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: 'ABSENCE_WATCH_DIGEST', schoolId: 's1' });
    expect(entries[0]!.recipients).toHaveLength(2);
    expect(settled).toHaveBeenCalledWith(ABSENCE_WATCH_JOB, expect.any(Date), {
      ok: true,
      counts: { schools: 1, failed: 0, pupils: 480, opened: 3, closed: 1, digests: 1, notices: 2 },
    });
  });

  it('writes a digest for each group that is due, one after another', async () => {
    const { job, calls } = night({
      schools: ['s1'],
      due: {
        s1: [
          { recipient_group: 'MENTOR', period_start: '2026-10-12', period_end: '2026-10-18' },
          { recipient_group: 'GUARDIAN', period_start: '2026-09-01', period_end: '2026-09-30' },
        ],
      },
    });
    await job.tick();
    const digests = calls.filter((call) => call.text.includes('app.absence_watch_digest(')).map((call) => call.values.slice(1, 4));
    expect(digests).toEqual([
      ['MENTOR', '2026-10-12', '2026-10-18'],
      ['GUARDIAN', '2026-09-01', '2026-09-30'],
    ]);
  });

  it('marks the night done only for a school that went through, and goes on to the next after one that failed', async () => {
    const { job, finish, settled, calls } = night({ schools: ['s1', 's2'], failEvaluate: 's1' });
    await job.tick();
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith(ABSENCE_WATCH_JOB, 's2', expect.any(Date), expect.any(Date));
    expect(calls.some((call) => call.text.includes('absence_watch_digest_due(') && call.values[0] === 's2')).toBe(true);
    expect(settled).toHaveBeenCalledWith(ABSENCE_WATCH_JOB, expect.any(Date), {
      ok: true,
      counts: expect.objectContaining({ schools: 2, failed: 1 }),
    });
  });

  it('logs only ids and counts, never a name or an address', async () => {
    const log = jest.spyOn(Logger.prototype, 'log');
    const { job } = night({
      schools: ['s1'],
      evaluated: { s1: { opened: 1, kept: 0, closed: 0, pupils: 10 } },
      due: { s1: [{ recipient_group: 'MENTOR', period_start: '2026-10-12', period_end: '2026-10-18' }] },
      written: { 's1|MENTOR': [{ notification_id: 'n1', user_id: 'u1', email: 'secret@example.invalid', meta: { group: 'MENTOR', open: 1, crossed: 1, periodStart: '2026-10-12', periodEnd: '2026-10-18' } }] },
    });
    await job.tick();
    const lines = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(lines).toContain('school=s1');
    expect(lines).not.toContain('secret@example.invalid');
  });

  it('never throws, whatever the database does', async () => {
    const { job, prisma } = night({ schools: ['s1'] });
    (prisma.withDeliveryService as jest.Mock).mockRejectedValueOnce(new Error('down'));
    await expect(job.tick()).resolves.toBeUndefined();
  });
});
