import { COVER_REQUESTS_INTERVAL_MS, COVER_REQUESTS_JOB, CoverRequestsJob } from './cover-requests.job';
import type { CoverRequestsService } from './cover-requests.service';

/**
 * The job of vikarieförfrågningar: one pass settles the open requests (ends
 * the ones whose time is out or whose lessons went away, and tells who it
 * concerns, in CoverRequestsService.settle), is counted in JobRuns, and never
 * throws; it is registered only when COVER_REQUESTS_BACKGROUND is on.
 */
describe('CoverRequestsJob', () => {
  const setup = (settle: jest.Mock, background = true) => {
    const jobs = { register: jest.fn(), unregister: jest.fn(), settled: jest.fn() };
    const config = { get: jest.fn().mockReturnValue({ background }) };
    const job = new CoverRequestsJob(
      { settle } as unknown as CoverRequestsService,
      config as never,
      jobs as never,
    );
    return { job, jobs };
  };

  it('registers a pass every five minutes, and not when the background is off', () => {
    const on = setup(jest.fn());
    on.job.onModuleInit();
    expect(on.jobs.register).toHaveBeenCalledWith(expect.objectContaining({ name: COVER_REQUESTS_JOB, intervalMs: COVER_REQUESTS_INTERVAL_MS }));
    expect(COVER_REQUESTS_INTERVAL_MS).toBe(300_000);

    const off = setup(jest.fn(), false);
    off.job.onModuleInit();
    expect(off.jobs.register).not.toHaveBeenCalled();
  });

  it('counts a pass in JobRuns with what it ended, split by why', async () => {
    const { job, jobs } = setup(jest.fn().mockResolvedValue({ expired: 2, notNeeded: 1 }));
    await job.tick();
    expect(jobs.settled).toHaveBeenCalledWith(COVER_REQUESTS_JOB, expect.any(Date), { ok: true, counts: { expired: 2, notNeeded: 1 } });
  });

  it('records a failed pass as failed and never throws', async () => {
    const { job, jobs } = setup(jest.fn().mockRejectedValue(new Error('connection')));
    await expect(job.tick()).resolves.toBeUndefined();
    expect(jobs.settled).toHaveBeenCalledWith(COVER_REQUESTS_JOB, expect.any(Date), expect.objectContaining({ ok: false }));
  });

  it('lets a pass that is still running finish instead of starting another', async () => {
    let finish!: (counts: { expired: number; notNeeded: number }) => void;
    const settle = jest.fn().mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { job } = setup(settle);
    const first = job.tick();
    const second = job.tick();
    finish({ expired: 0, notNeeded: 0 });
    await Promise.all([first, second]);
    expect(settle).toHaveBeenCalledTimes(1);
  });
});
