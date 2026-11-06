import { createPrismaMock, createTxMock, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import type { FamilyReadsService } from '../family/family-reads.service';
import type { JobRunner } from '../jobs/job-runner';
import type { ScheduleExchangeService } from '../schedule-exchange/exchange.service';
import { ExportWithdrawn, RequesterNotAllowed, SchoolExportJob } from './school-export.job';
import { POLL_INTERVAL_MS, SCHOOL_EXPORT_JOB } from './school-export';

const CLAIM = {
  export_id: '44444444-4444-4444-8444-444444444444', school_id: '33333333-3333-4333-8333-333333333333', user_id: '22222222-2222-4222-8222-222222222222',
  auth_id: '11111111-1111-4111-8111-111111111111', admin_profile: 'FULL' as const, hr_read: true, attempt: 1,
};

/** The statements the job sent on the service's transaction (no principal), by the function they call. */
const sent = (tx: TxMock, fn: string): unknown[][] =>
  [...(tx.$queryRaw.mock.calls as Array<[{ strings?: string[]; values: unknown[] }]>), ...(tx.$executeRaw.mock.calls as Array<[{ strings?: string[]; values: unknown[] }]>)]
    .filter(([sql]) => (sql.strings ?? []).join('?').includes(fn))
    .map(([sql]) => sql.values);

describe('SchoolExportJob', () => {
  let tx: TxMock;
  let prisma: PrismaMock;
  let jobs: { register: jest.Mock; unregister: jest.Mock; isScheduled: jest.Mock; settled: jest.Mock };
  let job: SchoolExportJob;

  /** Answers the job's statements by the function they call, as the database would. */
  const answer = (by: Record<string, unknown[] | (() => unknown[])>) => {
    tx.$queryRaw.mockImplementation(async (sql: { strings?: string[] }) => {
      const text = (sql.strings ?? []).join('?');
      for (const [fn, value] of Object.entries(by)) if (text.includes(fn)) return typeof value === 'function' ? value() : value;
      return [];
    });
  };

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    jobs = { register: jest.fn(), unregister: jest.fn(), isScheduled: jest.fn().mockReturnValue(true), settled: jest.fn() };
    job = new SchoolExportJob(
      prisma as unknown as PrismaService,
      { guardianExport: jest.fn().mockResolvedValue({ rows: [], heldOut: 0 }) } as unknown as FamilyReadsService,
      { export: jest.fn().mockResolvedValue({ body: Buffer.from('s\r\n') }) } as unknown as ScheduleExchangeService,
      { get: () => ({ background: true }) } as never,
      jobs as unknown as JobRunner,
    );
  });

  it('registers every thirty seconds only when its switch is on, and leaves on shutdown', () => {
    job.onModuleInit();
    expect(jobs.register).toHaveBeenCalledWith(expect.objectContaining({ name: SCHOOL_EXPORT_JOB, intervalMs: POLL_INTERVAL_MS }));
    expect(POLL_INTERVAL_MS).toBe(30_000);
    expect(job.scheduled).toBe(true);
    job.onModuleDestroy();
    expect(jobs.unregister).toHaveBeenCalledWith(SCHOOL_EXPORT_JOB);

    jobs.register.mockClear();
    new SchoolExportJob(prisma as never, {} as never, {} as never, { get: () => ({ background: false }) } as never, jobs as never).onModuleInit();
    new SchoolExportJob(prisma as never, {} as never, {} as never, { get: () => ({ background: true }) } as never, undefined).onModuleInit();
    expect(jobs.register).not.toHaveBeenCalled();
  });

  it('expires, finds nothing to claim, and settles a pass of zeros', async () => {
    answer({ 'app.school_export_expire': [{ expired: 2, purged: 1 }], 'app.school_export_claim': [] });
    await job.tick();
    expect(jobs.settled).toHaveBeenCalledWith(SCHOOL_EXPORT_JOB, expect.any(Date), { ok: true, counts: { claimed: 0, expired: 2, purged: 1, built: 0, failed: 0 } });
    expect(sent(tx, 'app.school_export_expire')[0]).toEqual(['13 months']);
  });

  it('builds a claimed export as the ordering administrator, and finishes it with the stored totals', async () => {
    answer({
      'app.school_export_claim': [CLAIM],
      'app.school_export_heartbeat': [{ alive: true }],
      'app.current_user_decides': [{ decides: true, name: 'Provskolan' }],
      'FROM "PersonProtections"': [],
    });
    await job.tick();
    const [finish] = sent(tx, 'app.school_export_finish');
    expect(finish).toBeDefined();
    const [id, bytes, chunks, sha256, files, heldOut, readAbout, keep] = finish as [string, number, number, string, string, string, string, string];
    expect(id).toBe(CLAIM.export_id);
    expect(bytes).toBeGreaterThan(1000);
    expect(chunks).toBe(1);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(files).map((f: { path: string }) => f.path)).toEqual(expect.arrayContaining(['README.txt', 'FORMAT.md', 'data/personer.csv', 'data/laslogg.csv']));
    expect(JSON.parse(heldOut)).toEqual({ people: 0, links: 0 });
    expect(JSON.parse(readAbout)).toEqual({});
    expect(keep).toBe('72 hours');
    // Every call names the attempt it holds the export by, so a builder taken over cannot write into the second's file.
    expect(finish![8]).toBe(1);
    expect(sent(tx, 'app.school_export_heartbeat').every((values) => values[1] === 1)).toBe(true);
    expect(sent(tx, 'app.school_export_put').every((values) => values[3] === 1)).toBe(true);
    // The piece went through the function that takes the school from the export.
    const [put] = sent(tx, 'app.school_export_put');
    expect(put!.slice(0, 2)).toEqual([CLAIM.export_id, 0]);
    expect(Buffer.isBuffer(put![2])).toBe(true);
    expect((put![2] as Buffer).length).toBe(bytes);
    // Every read was the administrator's: their login and school, under row security.
    expect(prisma.withRls).toHaveBeenCalled();
    for (const [user] of prisma.withRls.mock.calls as Array<[{ authId: string; schoolId: string; userId: string; adminProfile: string }]>) {
      expect(user).toMatchObject({ authId: CLAIM.auth_id, schoolId: CLAIM.school_id, userId: CLAIM.user_id, adminProfile: 'FULL' });
    }
    expect(jobs.settled).toHaveBeenCalledWith(SCHOOL_EXPORT_JOB, expect.any(Date), { ok: true, counts: expect.objectContaining({ claimed: 1, built: 1, failed: 0 }) });
    expect(sent(tx, 'app.school_export_fail')).toEqual([]);
  });

  it('goes on without the grundschema when Schema som fil cannot write it, and says so in the manifest', async () => {
    const exchange = { export: jest.fn().mockRejectedValue(new TypeError('Cannot read properties of undefined')) };
    job = new SchoolExportJob(prisma as never, { guardianExport: jest.fn().mockResolvedValue({ rows: [], heldOut: 0 }) } as never, exchange as never, { get: () => ({ background: true }) } as never, jobs as never);
    tx.academicYear.findFirst.mockResolvedValue({ id: 'y1' });
    answer({
      'app.school_export_claim': [CLAIM],
      'app.school_export_heartbeat': [{ alive: true }],
      'app.current_user_decides': [{ decides: true, name: 'Provskolan' }],
    });
    await job.tick();
    expect(exchange.export).toHaveBeenCalled();
    const [finish] = sent(tx, 'app.school_export_finish');
    expect(finish).toBeDefined();
    expect(JSON.parse((finish as string[])[4]!).map((f: { path: string }) => f.path)).not.toContain('schema/grundschema.csv');
    expect(sent(tx, 'app.school_export_fail')).toEqual([]);
  });

  it('fails an export whose administrator may no longer decide, by error class, and leaves nothing half-built', async () => {
    answer({
      'app.school_export_claim': [CLAIM],
      'app.school_export_heartbeat': [{ alive: true }],
      'app.current_user_decides': [{ decides: false, name: 'Provskolan' }],
    });
    await job.tick();
    expect(sent(tx, 'app.school_export_fail')).toEqual([[CLAIM.export_id, 'RequesterNotAllowed', 1]]);
    expect(sent(tx, 'app.school_export_put')).toEqual([]);
    expect(jobs.settled).toHaveBeenCalledWith(SCHOOL_EXPORT_JOB, expect.any(Date), { ok: true, counts: expect.objectContaining({ failed: 1, built: 0 }) });
    expect(new RequesterNotAllowed().name).toBe('RequesterNotAllowed');
  });

  it('stops without marking anything when the heartbeat finds the export gone', async () => {
    answer({
      'app.school_export_claim': [CLAIM],
      'app.school_export_heartbeat': [{ alive: false }],
      'app.current_user_decides': [{ decides: true, name: 'Provskolan' }],
    });
    await job.tick();
    expect(sent(tx, 'app.school_export_fail')).toEqual([]);
    expect(sent(tx, 'app.school_export_finish')).toEqual([]);
    expect(new ExportWithdrawn().name).toBe('ExportWithdrawn');
  });

  it('marks an export failed with the error\'s class, never its message, when the database fails', async () => {
    class ConnectionLost extends Error {}
    answer({
      'app.school_export_claim': [CLAIM],
      'app.school_export_heartbeat': [{ alive: true }],
      'app.current_user_decides': () => {
        throw new ConnectionLost('password=secret host=db');
      },
    });
    await job.tick();
    expect(sent(tx, 'app.school_export_fail')).toEqual([[CLAIM.export_id, 'Error', 1]]);
    expect(JSON.stringify(sent(tx, 'app.school_export_fail'))).not.toContain('secret');
  });

  it('answers a tick while the last one is running with that one, and settles a pass that threw past itself as failed', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    tx.$queryRaw.mockImplementation(() => gate.then(() => []));
    const first = job.tick();
    const second = job.tick();
    await new Promise((resolve) => setImmediate(resolve));
    open();
    await Promise.all([first, second]);
    expect(jobs.settled).toHaveBeenCalledTimes(1);

    tx.$queryRaw.mockRejectedValue(new Error('down'));
    await job.tick();
    expect(jobs.settled).toHaveBeenLastCalledWith(SCHOOL_EXPORT_JOB, expect.any(Date), { ok: false, error: 'Error' });
  });
});
