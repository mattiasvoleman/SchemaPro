import type { ConfigService } from '@nestjs/config';
import { createPrismaMock, createTxMock } from '../../../test/utils/prisma-mock';
import type { PrismaService } from '../../database/prisma.service';
import { Ss12000SchedulerService } from './ss12000-scheduler.service';
import type { Ss12000SyncService } from './ss12000-sync.service';

const config = (background: boolean) => ({ get: () => ({ background }) }) as unknown as ConfigService;

describe('Ss12000SchedulerService', () => {
  it('sets no interval when SS12000_BACKGROUND is off, an unref\'d one when on, and clears it on shutdown', () => {
    const prisma = createPrismaMock(createTxMock()) as unknown as PrismaService;
    const sync = { startScheduledRun: jest.fn() } as unknown as Ss12000SyncService;
    const off = new Ss12000SchedulerService(prisma, sync, config(false));
    off.onModuleInit();
    expect(off.scheduled).toBe(false);
    const on = new Ss12000SchedulerService(prisma, sync, config(true));
    on.onModuleInit();
    expect(on.scheduled).toBe(true);
    on.onModuleDestroy();
    expect(on.scheduled).toBe(false);
  });

  it('keeps house first, then runs each claimed source under its own school', async () => {
    const tx = createTxMock();
    const prisma = createPrismaMock(tx);
    tx.$queryRaw
      .mockResolvedValueOnce([{ stale: 1, expired: 0 }])
      .mockResolvedValueOnce([
        { source_id: 's1', school_id: 'school-1', full_due: true },
        { source_id: 's2', school_id: 'school-2', full_due: false },
      ]);
    const sync = { startScheduledRun: jest.fn().mockResolvedValueOnce('run-1').mockRejectedValueOnce(new Error('boom')) };
    const at = new Date('2027-03-28T01:30:00Z');
    await new Ss12000SchedulerService(prisma as unknown as PrismaService, sync as unknown as Ss12000SyncService, config(true)).tick(at);

    const statements = tx.$queryRaw.mock.calls.map(([sql]) => (sql as { strings: string[]; values: unknown[] }));
    expect(statements[0]!.strings.join('?')).toContain('app.ss12000_housekeeping(');
    expect(statements[1]!.strings.join('?')).toContain('app.ss12000_due_sources(');
    expect(statements[1]!.values).toEqual([5, at]);
    expect(prisma.withDeliveryService).toHaveBeenCalledTimes(2);
    // One school's failure does not stop the next.
    expect(sync.startScheduledRun.mock.calls).toEqual([
      ['s1', 'school-1', true],
      ['s2', 'school-2', false],
    ]);
  });

  it('never overlaps itself, and a failing tick does not throw', async () => {
    const tx = createTxMock();
    const prisma = createPrismaMock(tx);
    let release!: () => void;
    tx.$queryRaw.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve([]))));
    const scheduler = new Ss12000SchedulerService(prisma as unknown as PrismaService, { startScheduledRun: jest.fn() } as unknown as Ss12000SyncService, config(true));
    const first = scheduler.tick();
    const second = scheduler.tick();
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await Promise.all([first, second]);
    expect(prisma.withDeliveryService).toHaveBeenCalledTimes(2);

    tx.$queryRaw.mockRejectedValueOnce(new Error('db down'));
    await expect(scheduler.tick()).resolves.toBeUndefined();
  });
});
