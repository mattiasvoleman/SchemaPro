import { ACK_INTERVAL_MS, ACK_JOB } from './ack';
import { AckJob } from './ack.job';
import type { AckService } from './ack.service';

/**
 * The reminder pass: one look every quarter of an hour at the requests whose time
 * has come (AckService.remind: the due requests one at a time), counted in JobRuns,
 * never throwing; registered only when ACK_BACKGROUND is on.
 */
describe('AckJob', () => {
  const setup = (remind: jest.Mock, background = true) => {
    const jobs = { register: jest.fn(), unregister: jest.fn(), settled: jest.fn() };
    const config = { get: jest.fn().mockReturnValue({ background }) };
    const job = new AckJob({ remind } as unknown as AckService, config as never, jobs as never);
    return { job, jobs };
  };

  it('registers a pass every quarter of an hour, and not when the background is off', () => {
    const on = setup(jest.fn());
    on.job.onModuleInit();
    expect(on.jobs.register).toHaveBeenCalledWith(expect.objectContaining({ name: ACK_JOB, intervalMs: ACK_INTERVAL_MS }));
    expect(ACK_INTERVAL_MS).toBe(900_000);

    const off = setup(jest.fn(), false);
    off.job.onModuleInit();
    expect(off.jobs.register).not.toHaveBeenCalled();
  });

  it('registers nothing without a runner or a config, and unregisters on shutdown', () => {
    const bare = new AckJob({ remind: jest.fn() } as unknown as AckService);
    expect(() => bare.onModuleInit()).not.toThrow();
    expect(() => bare.onModuleDestroy()).not.toThrow();
    const { job, jobs } = setup(jest.fn());
    job.onModuleDestroy();
    expect(jobs.unregister).toHaveBeenCalledWith(ACK_JOB);
  });

  it('counts a pass in JobRuns with how many guardians were reminded, in how many requests, and how many were left', async () => {
    const counts = { reminded: 3, requests: 2, failed: 0, left: 0 };
    const { job, jobs } = setup(jest.fn().mockResolvedValue(counts));
    await job.tick();
    expect(jobs.settled).toHaveBeenCalledWith(ACK_JOB, expect.any(Date), { ok: true, counts });
  });

  it('records a pass in which a request failed as failed, with the others counted, and a pass that ran out of time as ok', async () => {
    const failing = { reminded: 1, requests: 1, failed: 1, left: 0 };
    const { job, jobs } = setup(jest.fn().mockResolvedValue(failing));
    await job.tick();
    expect(jobs.settled).toHaveBeenCalledWith(ACK_JOB, expect.any(Date), { ok: false, error: 'RequestFailed', counts: failing });
    const slow = { reminded: 5, requests: 5, failed: 0, left: 40 };
    const second = setup(jest.fn().mockResolvedValue(slow));
    await second.job.tick();
    expect(second.jobs.settled).toHaveBeenCalledWith(ACK_JOB, expect.any(Date), { ok: true, counts: slow });
  });

  it('records a failed pass as failed and never throws', async () => {
    const { job, jobs } = setup(jest.fn().mockRejectedValue(new Error('connection')));
    await expect(job.tick()).resolves.toBeUndefined();
    expect(jobs.settled).toHaveBeenCalledWith(ACK_JOB, expect.any(Date), expect.objectContaining({ ok: false }));
  });

  it('lets a pass that is still running finish instead of starting another', async () => {
    let finish!: (counts: { reminded: number; requests: number; failed: number; left: number }) => void;
    const remind = jest.fn().mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { job } = setup(remind);
    const first = job.tick();
    const second = job.tick();
    finish({ reminded: 0, requests: 0, failed: 0, left: 0 });
    await Promise.all([first, second]);
    expect(remind).toHaveBeenCalledTimes(1);
  });
});
