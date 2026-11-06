import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createPrismaMock, createTxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { JobRunner } from '../jobs/job-runner';
import type { NotificationsService } from '../notifications/notifications.service';
import { REPORTING_RATE_HOUR_LOCAL, REPORTING_RATE_INTERVAL_MS, REPORTING_RATE_JOB, SCHOOLS_PER_TICK } from './reporting-rate';
import { ReportingRateJob } from './reporting-rate.job';

type Statement = { strings: string[]; values: unknown[] };
const sql = (statement: unknown) => (statement as Statement).strings.join('?');
const config = (background: boolean) => ({ get: () => ({ background }) }) as unknown as ConfigService;

type NoticeRow = { notification_id: string; user_id: string; email: string | null; meta: Record<string, unknown> };
const reminder = (n: number, count = 2, email: string | null = `teacher${n}@example.invalid`): NoticeRow => ({
  notification_id: `reminder-${n}`,
  user_id: `teacher-${n}`,
  email,
  meta: { count, limitDays: 2 },
});
const digest = (n: number, email: string | null = `rektor${n}@example.invalid`): NoticeRow => ({
  notification_id: `digest-${n}`,
  user_id: `rektor-${n}`,
  email,
  meta: { periodStart: '2026-10-12', periodEnd: '2026-10-18', held: 120, reported: 90, teachers: 8 },
});

const isoDow = (day: string) => ((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

/**
 * A database stand-in for one night: which schools have lessons, what the
 * count says, which notices the reminders and the week write, and which weeks
 * are due. Like the database it answers no reminder on a Saturday or a Sunday.
 */
function night(
  options: {
    schools?: string[];
    computed?: Record<string, { written: number; removed: number; teachers: number; held: number; reported: number }>;
    reminders?: Record<string, NoticeRow[]>;
    due?: Record<string, Array<{ period_start: string; period_end: string }>>;
    digests?: Record<string, NoticeRow[]>;
    failCompute?: string;
    failDigest?: string;
    localDay?: string;
  } = {},
) {
  const localDay = options.localDay ?? '2026-10-21';
  const tx = createTxMock();
  const prisma = createPrismaMock(tx);
  const events: string[] = [];
  const calls: Array<{ text: string; values: unknown[] }> = [];
  // A tagged template (SET LOCAL ...) arrives as its strings, a Prisma.sql as a statement.
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
    if (text.includes('app.reporting_compute(')) {
      events.push(`compute:${school}`);
      if (school === options.failCompute) throw Object.assign(new Error('boom'), { name: 'PrismaClientKnownRequestError' });
      return [options.computed?.[school] ?? { written: 0, removed: 0, teachers: 0, held: 0, reported: 0 }];
    }
    if (text.includes('app.reporting_remind(')) {
      events.push(`remind:${school}`);
      return isoDow(values[1] as string) >= 6 ? [] : (options.reminders?.[school] ?? []);
    }
    if (text.includes('app.reporting_digest_due(')) {
      events.push(`due:${school}`);
      return (options.due?.[school] ?? []).map((week) => ({
        period_start: new Date(`${week.period_start}T00:00:00Z`),
        period_end: new Date(`${week.period_end}T00:00:00Z`),
      }));
    }
    if (text.includes('app.reporting_digest(')) {
      events.push(`digest:${school}:${values[1] as string}`);
      if (school === options.failDigest) throw Object.assign(new Error('boom'), { name: 'PrismaClientKnownRequestError' });
      return options.digests?.[`${school}|${values[1] as string}`] ?? [];
    }
    return [];
  });
  // A door that records when its transaction has committed: what a notice may be handed over after.
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
  const notifications = { deliverCommitted: jest.fn((_entries: unknown) => void events.push('deliver')) };
  const job = new ReportingRateJob(prisma as unknown as PrismaService, notifications as unknown as NotificationsService, config(true), runner);
  return { job, runner, calls, claim, finish, settled, notifications, prisma, tx, events };
}

describe('ReportingRateJob', () => {
  let spies: jest.SpyInstance[];
  beforeEach(() => {
    spies = (['log', 'warn'] as const).map((level) => jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined));
  });
  afterEach(() => spies.forEach((spy) => spy.mockRestore()));

  it('registers every five minutes only when REPORTING_RATE_BACKGROUND is on, and leaves on shutdown', () => {
    const runner = new JobRunner();
    const register = jest.spyOn(runner, 'register');
    const prisma = createPrismaMock(createTxMock()) as unknown as PrismaService;
    const notifications = {} as NotificationsService;
    const off = new ReportingRateJob(prisma, notifications, config(false), runner);
    off.onModuleInit();
    expect(off.scheduled).toBe(false);
    const on = new ReportingRateJob(prisma, notifications, config(true), runner);
    on.onModuleInit();
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ name: REPORTING_RATE_JOB, intervalMs: REPORTING_RATE_INTERVAL_MS }));
    expect(REPORTING_RATE_JOB).toBe('reporting-rate');
    expect(REPORTING_RATE_INTERVAL_MS).toBe(5 * 60 * 1000);
    expect(on.scheduled).toBe(true);
    on.onModuleDestroy();
    expect(on.scheduled).toBe(false);
  });

  it('registers nothing without a configuration or without a runner, as the test graph has it', () => {
    const runner = new JobRunner();
    const register = jest.spyOn(runner, 'register');
    const prisma = createPrismaMock(createTxMock()) as unknown as PrismaService;
    const notifications = {} as NotificationsService;
    new ReportingRateJob(prisma, notifications, undefined, runner).onModuleInit();
    const bare = new ReportingRateJob(prisma, notifications, config(true), undefined);
    bare.onModuleInit();
    bare.onModuleDestroy();
    expect(register).not.toHaveBeenCalled();
    expect(bare.scheduled).toBe(false);
  });

  it('claims nothing, and counts a school of none, when no school has a lesson in the last 90 days', async () => {
    const { job, claim, settled } = night({ schools: [] });
    await job.tick();
    expect(claim).not.toHaveBeenCalled();
    expect(settled).toHaveBeenCalledWith(REPORTING_RATE_JOB, expect.any(Date), { ok: true, counts: { schools: 0 } });
  });

  it('does a pass without a runner, which has nobody to claim from: nothing happens', async () => {
    const tx = createTxMock();
    tx.$queryRaw = jest.fn().mockResolvedValue([{ id: 's1' }]);
    const prisma = createPrismaMock(tx);
    const notifications = { deliverCommitted: jest.fn() };
    const job = new ReportingRateJob(prisma as unknown as PrismaService, notifications as unknown as NotificationsService);
    await expect(job.tick()).resolves.toBeUndefined();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(notifications.deliverCommitted).not.toHaveBeenCalled();
  });

  it('claims the schools with a lesson, at six in the morning their time, ten at a time', async () => {
    const { job, claim } = night({ schools: ['s1', 's2'] });
    const at = new Date('2026-10-21T04:00:00Z');
    await job.tick(at);
    expect(claim).toHaveBeenCalledWith(REPORTING_RATE_JOB, REPORTING_RATE_HOUR_LOCAL, ['s1', 's2'], SCHOOLS_PER_TICK, at);
    expect(REPORTING_RATE_HOUR_LOCAL).toBe(6);
    expect(SCHOOLS_PER_TICK).toBe(10);
  });

  it('counts up to and including yesterday in the dates of the school, and asks for the reminders and the due week of today', async () => {
    const { job, calls, tx } = night({ schools: ['s1'], localDay: '2026-10-21' });
    await job.tick();
    const compute = calls.find((call) => call.text.includes('app.reporting_compute('))!;
    expect(compute.values).toEqual(['s1', '2026-10-20']);
    expect(calls.find((call) => call.text.includes('app.reporting_remind('))!.values).toEqual(['s1', '2026-10-21']);
    expect(calls.find((call) => call.text.includes('app.reporting_digest_due('))!.values).toEqual(['s1', '2026-10-21']);
    // The count gets the most the door's transaction leaves, in that transaction.
    expect((tx.$executeRaw.mock.calls[0]![0] as string[]).join('')).toContain(`statement_timeout = '9s'`);
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
    expect(calls.find((call) => call.text.includes('app.reporting_compute('))!.values).toEqual(['s1', expected]);
    expect(calls.find((call) => call.text.includes('app.reporting_remind('))!.values).toEqual(['s1', localDay]);
  });

  it('goes through a school in order: the count, the reminders, their delivery, the due week, its notice, its delivery', async () => {
    const { job, events } = night({
      schools: ['s1'],
      reminders: { s1: [reminder(1)] },
      due: { s1: [{ period_start: '2026-10-12', period_end: '2026-10-18' }] },
      digests: { 's1|2026-10-12': [digest(1)] },
      localDay: '2026-10-19',
    });
    await job.tick();
    const school = events.slice(events.indexOf('compute:s1'));
    expect(school.filter((event) => !event.startsWith('exec:'))).toEqual([
      'compute:s1',
      'commit',
      'remind:s1',
      'commit',
      'deliver',
      'due:s1',
      'commit',
      'digest:s1:2026-10-12',
      'commit',
      'deliver',
    ]);
  });

  it('hands the reminders to the delivery after the commit that wrote them, as entries of the school', async () => {
    const { job, notifications, settled } = night({
      schools: ['s1'],
      computed: { s1: { written: 30, removed: 1, teachers: 12, held: 480, reported: 400 } },
      reminders: { s1: [reminder(1, 2), reminder(2, 2), reminder(3, 5)] },
    });
    await job.tick();
    expect(notifications.deliverCommitted).toHaveBeenCalledTimes(1);
    const [entries] = notifications.deliverCommitted.mock.calls[0]! as unknown as [Array<{ type: string; schoolId: string; recipients: unknown[] }>];
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.type)).toEqual(['LESSON_REPORT_REMINDER', 'LESSON_REPORT_REMINDER']);
    expect(entries.every((entry) => entry.schoolId === 's1')).toBe(true);
    expect(entries[0]!.recipients).toHaveLength(2);
    expect(settled).toHaveBeenCalledWith(REPORTING_RATE_JOB, expect.any(Date), {
      ok: true,
      counts: { schools: 1, failed: 0, written: 30, removed: 1, held: 480, reported: 400, reminders: 3, digests: 0, notices: 0 },
    });
  });

  it('writes the due week and hands its notice to the delivery after the commit', async () => {
    const { job, calls, notifications, settled } = night({
      schools: ['s1'],
      due: { s1: [{ period_start: '2026-10-12', period_end: '2026-10-18' }] },
      digests: { 's1|2026-10-12': [digest(1), digest(2)] },
      localDay: '2026-10-19',
    });
    await job.tick();
    const written = calls.find((call) => call.text.includes('app.reporting_digest('))!;
    expect(written.values).toEqual(['s1', '2026-10-12', '2026-10-18']);
    expect(notifications.deliverCommitted).toHaveBeenCalledTimes(1);
    const [entries] = notifications.deliverCommitted.mock.calls[0]! as unknown as [Array<{ type: string; recipients: unknown[] }>];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: 'REPORTING_RATE_DIGEST', schoolId: 's1' });
    expect(entries[0]!.recipients).toHaveLength(2);
    expect(settled).toHaveBeenCalledWith(REPORTING_RATE_JOB, expect.any(Date), {
      ok: true,
      counts: expect.objectContaining({ schools: 1, digests: 1, notices: 2, reminders: 0 }),
    });
  });

  it('writes a notice for each week that is due, one after another', async () => {
    const { job, calls } = night({
      schools: ['s1'],
      due: {
        s1: [
          { period_start: '2026-10-05', period_end: '2026-10-11' },
          { period_start: '2026-10-12', period_end: '2026-10-18' },
        ],
      },
      localDay: '2026-10-19',
    });
    await job.tick();
    const weeks = calls.filter((call) => call.text.includes('app.reporting_digest(')).map((call) => call.values.slice(1, 3));
    expect(weeks).toEqual([
      ['2026-10-05', '2026-10-11'],
      ['2026-10-12', '2026-10-18'],
    ]);
  });

  it('hands nothing to the delivery when the database answers no notice', async () => {
    // Nothing due and no reminder written: the switches are off, or there is nothing to say.
    const quiet = night({ schools: ['s1'], computed: { s1: { written: 5, removed: 0, teachers: 3, held: 30, reported: 30 } } });
    await quiet.job.tick();
    expect(quiet.notifications.deliverCommitted).not.toHaveBeenCalled();
    // A week that is due with no held lesson is entered in the ledger and told to nobody: counted, not delivered.
    const empty = night({
      schools: ['s1'],
      due: { s1: [{ period_start: '2026-10-12', period_end: '2026-10-18' }] },
      digests: { 's1|2026-10-12': [] },
      localDay: '2026-10-19',
    });
    await empty.job.tick();
    expect(empty.notifications.deliverCommitted).not.toHaveBeenCalled();
    expect(empty.settled).toHaveBeenCalledWith(REPORTING_RATE_JOB, expect.any(Date), {
      ok: true,
      counts: expect.objectContaining({ digests: 1, notices: 0 }),
    });
  });

  it.each([
    ['a Saturday', '2026-10-24'],
    ['a Sunday', '2026-10-25'],
  ])('counts the day but tells no teacher on %s, when the database answers no reminder', async (_label, localDay) => {
    const { job, calls, notifications, finish } = night({ schools: ['s1'], reminders: { s1: [reminder(1)] }, localDay });
    await job.tick();
    expect(calls.some((call) => call.text.includes('app.reporting_compute('))).toBe(true);
    expect(calls.some((call) => call.text.includes('app.reporting_remind('))).toBe(true);
    expect(notifications.deliverCommitted).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledTimes(1);
    // The next weekday it tells.
    const monday = night({ schools: ['s1'], reminders: { s1: [reminder(1)] }, localDay: '2026-10-26' });
    await monday.job.tick();
    expect(monday.notifications.deliverCommitted).toHaveBeenCalledTimes(1);
  });

  it('marks the night done only for a school that went through, and goes on to the next after one that failed', async () => {
    const { job, finish, settled, calls } = night({ schools: ['s1', 's2'], failCompute: 's1' });
    await job.tick();
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith(REPORTING_RATE_JOB, 's2', expect.any(Date), expect.any(Date));
    expect(calls.some((call) => call.text.includes('app.reporting_remind(') && call.values[0] === 's2')).toBe(true);
    // A school whose count failed is not told anything that night.
    expect(calls.some((call) => call.text.includes('app.reporting_remind(') && call.values[0] === 's1')).toBe(false);
    expect(settled).toHaveBeenCalledWith(REPORTING_RATE_JOB, expect.any(Date), {
      ok: true,
      counts: expect.objectContaining({ schools: 2, failed: 1 }),
    });
  });

  it('leaves the night open for a school whose week failed after its reminders were committed, which were handed over by then', async () => {
    const { job, finish, notifications } = night({
      schools: ['s1'],
      reminders: { s1: [reminder(1)] },
      due: { s1: [{ period_start: '2026-10-12', period_end: '2026-10-18' }] },
      failDigest: 's1',
      localDay: '2026-10-19',
    });
    await job.tick();
    expect(finish).not.toHaveBeenCalled();
    // The reminders were written and committed before the week failed, so they were handed over then:
    // the claim's retry finds them in the ledger and writes none again.
    expect(notifications.deliverCommitted).toHaveBeenCalledTimes(1);
  });

  it('logs only ids and counts, never a name or an address', async () => {
    const log = jest.spyOn(Logger.prototype, 'log');
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const { job } = night({
      schools: ['s1', 's2'],
      computed: { s1: { written: 4, removed: 0, teachers: 2, held: 20, reported: 15 } },
      reminders: { s1: [reminder(1, 2, 'secret@example.invalid')] },
      failCompute: 's2',
    });
    await job.tick();
    const lines = [...log.mock.calls, ...warn.mock.calls].map((call) => String(call[0])).join('\n');
    expect(lines).toContain('school=s1');
    expect(lines).toContain('school=s2');
    expect(lines).toContain('PrismaClientKnownRequestError');
    expect(lines).not.toContain('secret@example.invalid');
    expect(lines).not.toContain('boom');
  });

  it('logs nothing for a school where nothing was written, changed or told', async () => {
    const log = jest.spyOn(Logger.prototype, 'log');
    const { job } = night({ schools: ['s1'] });
    await job.tick();
    expect(log).not.toHaveBeenCalled();
  });

  it('reads a database that answers nothing at all as a night with nothing in it', async () => {
    const { job, tx, notifications, finish } = night({ schools: ['s1'] });
    tx.$queryRaw = jest.fn(async (statement: unknown) =>
      sql(statement).includes('app.reporting_schools()') ? [{ id: 's1' }] : undefined,
    );
    await job.tick();
    expect(notifications.deliverCommitted).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledTimes(1);
    const one = await job.runSchool('s1', new Date('2026-10-21T00:00:00Z'));
    expect(one).toEqual({ written: 0, removed: 0, held: 0, reported: 0, reminders: 0, digests: 0, notices: 0 });
  });

  it('leaves a second tick to the pass that is running', async () => {
    const { job, claim } = night({ schools: ['s1'] });
    const first = job.tick();
    const second = job.tick();
    await Promise.all([first, second]);
    expect(claim).toHaveBeenCalledTimes(1);
    await job.tick();
    expect(claim).toHaveBeenCalledTimes(2);
  });

  it('never throws, whatever the database does', async () => {
    const { job, prisma, settled } = night({ schools: ['s1'] });
    (prisma.withDeliveryService as jest.Mock).mockRejectedValueOnce(new Error('down'));
    await expect(job.tick()).resolves.toBeUndefined();
    expect(settled).toHaveBeenCalledWith(REPORTING_RATE_JOB, expect.any(Date), { ok: false, error: 'Error' });
  });
});
