import { Logger } from '@nestjs/common';
import { createPrismaMock, createTxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { RECEIPT_INTERVAL_MS } from '../notifications/push-receipts.service';
import { SCHEDULER_INTERVAL_MS } from '../integration/ss12000-sync/ss12000-scheduler.service';
import { WEBHOOK_INTERVAL_MS } from '../integration/ss12000-v2/webhook-delivery.service';
import { errorName, JobRunner, OVERDUE_INTERVALS, READINESS_CACHE_MS } from './job-runner';

type Statement = { strings: string[]; values: unknown[] };
const text = (statement: unknown) => (statement as Statement).strings.join('?');
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('JobRunner', () => {
  let spies: jest.SpyInstance[];
  beforeEach(() => {
    spies = (['log', 'warn'] as const).map((level) => jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined));
  });
  afterEach(() => spies.forEach((spy) => spy.mockRestore()));

  it('keeps the three moved jobs at the intervals they had', () => {
    // The move must not change timing: 5 minutes, 1 minute, 5 minutes.
    expect(SCHEDULER_INTERVAL_MS).toBe(5 * 60 * 1000);
    expect(WEBHOOK_INTERVAL_MS).toBe(60 * 1000);
    expect(RECEIPT_INTERVAL_MS).toBe(5 * 60 * 1000);
  });

  it('ticks a job one interval after registration, on an unref\'d timer, until it leaves', () => {
    jest.useFakeTimers();
    try {
      const unref = jest.fn();
      const realSetInterval = global.setInterval;
      const set = jest.spyOn(global, 'setInterval').mockImplementation(((fn: () => void, ms: number) => {
        const timer = realSetInterval(fn, ms);
        timer.unref = unref.mockReturnValue(timer);
        return timer;
      }) as typeof setInterval);
      const runner = new JobRunner();
      const tick = jest.fn().mockResolvedValue(undefined);
      runner.register({ name: 'probe', intervalMs: 1000, tick });
      expect(set).toHaveBeenCalledWith(expect.any(Function), 1000);
      expect(unref).toHaveBeenCalled();
      expect(runner.isScheduled('probe')).toBe(true);
      expect(tick).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1000);
      expect(tick).toHaveBeenCalledTimes(1);
      runner.unregister('probe');
      expect(runner.isScheduled('probe')).toBe(false);
      jest.advanceTimersByTime(5000);
      expect(tick).toHaveBeenCalledTimes(1);
      set.mockRestore();
    } finally {
      jest.useRealTimers();
    }
  });

  it('never starts a pass while the last one runs, and stops every job on shutdown', async () => {
    jest.useFakeTimers();
    try {
      const runner = new JobRunner();
      let release!: () => void;
      const tick = jest.fn(() => new Promise<void>((resolve) => (release = resolve)));
      runner.register({ name: 'slow', intervalMs: 100, tick });
      runner.register({ name: 'other', intervalMs: 100, tick: jest.fn().mockResolvedValue(undefined) });
      jest.advanceTimersByTime(100);
      jest.advanceTimersByTime(100);
      jest.advanceTimersByTime(100);
      expect(tick).toHaveBeenCalledTimes(1);
      release();
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(100);
      expect(tick).toHaveBeenCalledTimes(2);
      runner.onModuleDestroy();
      expect(runner.isScheduled('slow') || runner.isScheduled('other')).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('counts a pass in JobRuns with counts only, and never throws or waits', async () => {
    const tx = createTxMock();
    tx.$executeRaw = jest.fn().mockResolvedValue(1);
    const prisma = createPrismaMock(tx);
    const runner = new JobRunner(prisma as unknown as PrismaService);
    const started = new Date('2026-10-21T01:00:00Z');
    expect(runner.settled('gallring', started, { ok: true, counts: { rows: 12, schoolId: 3, 'bad key': 1, negative: -1, half: 0.5 } })).toBeUndefined();
    await flush();
    const [statement] = tx.$executeRaw.mock.calls[0]!;
    expect(text(statement)).toContain('app.job_run_settled(');
    const values = (statement as Statement).values;
    expect(values[0]).toBe('gallring');
    expect(values[1]).toBe(started);
    expect(values[3]).toBe(true);
    expect(values[4]).toBeNull();
    // A key that is no name, a negative and a fraction never reach the table.
    expect(JSON.parse(values[5] as string)).toEqual({ rows: 12, schoolId: 3 });

    runner.settled('gallring', started, { ok: false, error: 'PrismaClientKnownRequestError' });
    await flush();
    const failed = (tx.$executeRaw.mock.calls[1]![0] as Statement).values;
    expect(failed[3]).toBe(false);
    expect(failed[4]).toBe('PrismaClientKnownRequestError');
  });

  it('logs a broken ledger once, not every minute, and again after it recovered', async () => {
    const tx = createTxMock();
    tx.$executeRaw = jest.fn().mockRejectedValue(Object.assign(new Error('function app.job_run_settled does not exist'), { name: 'PrismaClientKnownRequestError' }));
    const runner = new JobRunner(createPrismaMock(tx) as unknown as PrismaService);
    const warn = spies[1]!;
    for (let i = 0; i < 3; i += 1) {
      runner.settled('ss12000-webhooks', new Date(), { ok: true });
      await flush();
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toBe('Job ledger write failed [job=ss12000-webhooks, PrismaClientKnownRequestError]');
    tx.$executeRaw.mockResolvedValueOnce(1);
    runner.settled('ss12000-webhooks', new Date(), { ok: true });
    await flush();
    runner.settled('ss12000-webhooks', new Date(), { ok: true });
    await flush();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('claims a school\'s night through app.job_claim_nightly and marks it finished', async () => {
    const tx = createTxMock();
    const day = new Date('2026-10-21T00:00:00Z');
    tx.$queryRaw = jest.fn().mockResolvedValue([{ school_id: 's1', local_day: day }]);
    tx.$executeRaw = jest.fn().mockResolvedValue(1);
    const runner = new JobRunner(createPrismaMock(tx) as unknown as PrismaService);
    const at = new Date('2026-10-21T01:05:00Z');
    await expect(runner.claimNightly('gallring', 3, ['s1', 's2'], 5, at)).resolves.toEqual([{ schoolId: 's1', localDay: day }]);
    const claim = tx.$queryRaw.mock.calls[0]![0] as Statement;
    expect(text(claim)).toContain('app.job_claim_nightly(');
    expect(claim.values).toEqual(['gallring', 3, ['s1', 's2'], 5, at]);
    await runner.finishNightly('gallring', 's1', day, at);
    expect(text(tx.$executeRaw.mock.calls[0]![0])).toContain('app.job_claim_finished(');
    // Nothing to claim, nothing asked.
    await expect(runner.claimNightly('gallring', 3, [], 5, at)).resolves.toEqual([]);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('counts for /health/ready the jobs that failed their last pass or went quiet for three intervals', async () => {
    jest.useFakeTimers();
    try {
      const now = new Date('2026-10-21T12:00:00Z');
      jest.setSystemTime(now);
      const tx = createTxMock();
      const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
      tx.$queryRaw = jest.fn().mockResolvedValue([
        { job: 'fresh', last_finished: minutesAgo(1), last_failed: null },
        { job: 'failed', last_finished: minutesAgo(1), last_failed: minutesAgo(1) },
        { job: 'recovered', last_finished: minutesAgo(1), last_failed: minutesAgo(3) },
        { job: 'quiet', last_finished: minutesAgo(16), last_failed: null },
      ]);
      const runner = new JobRunner(createPrismaMock(tx) as unknown as PrismaService);
      const tick = () => Promise.resolve();
      for (const name of ['fresh', 'failed', 'recovered', 'quiet', 'new']) runner.register({ name, intervalMs: 5 * 60_000, tick });
      // 'new' has no row yet and was registered just now: not overdue.
      await expect(runner.readiness(now)).resolves.toEqual({ scheduled: 5, failing: 1, overdue: 1 });
      // Within a minute the reading is reused: one ledger read, not one per probe.
      await runner.readiness(new Date(now.getTime() + READINESS_CACHE_MS - 1));
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
      const later = new Date(now.getTime() + (OVERDUE_INTERVALS * 5 + 1) * 60_000);
      await expect(runner.readiness(later)).resolves.toMatchObject({ overdue: 5 });
      expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
      runner.onModuleDestroy();
      await expect(runner.readiness(now)).resolves.toEqual({ scheduled: 0, failing: 0, overdue: 0 });
    } finally {
      jest.useRealTimers();
    }
  });

  it('answers null rather than failing readiness when the ledger cannot be read', async () => {
    const tx = createTxMock();
    tx.$queryRaw = jest.fn().mockRejectedValue(new Error('relation does not exist'));
    const runner = new JobRunner(createPrismaMock(tx) as unknown as PrismaService);
    runner.register({ name: 'probe', intervalMs: 1000, tick: () => Promise.resolve() });
    await expect(runner.readiness()).resolves.toBeNull();
    runner.onModuleDestroy();
  });

  it('names an error by its class, never its message', () => {
    expect(errorName(new TypeError('postgresql://u:p@db'))).toBe('TypeError');
    expect(errorName('boom')).toBe('unknown');
    expect(errorName(Object.assign(new Error('x'), { name: 'not a name: postgresql://u:p@db' }))).toBe('Error');
  });
});
