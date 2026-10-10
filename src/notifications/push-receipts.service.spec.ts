import type { Logger } from '@nestjs/common';
import { createPrismaMock, createTxMock, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { PushReceiptsService, RECEIPT_INTERVAL_MS } from './push-receipts.service';

describe('PushReceiptsService', () => {
  let tx: TxMock;
  let prisma: ReturnType<typeof createPrismaMock>;
  let expo: { receipts: jest.Mock };
  let enabled: boolean;
  const config = { get: (key: string) => (key === 'push' ? { enabled } : undefined) };

  beforeEach(() => {
    enabled = true;
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    expo = { receipts: jest.fn().mockResolvedValue({}) };
  });

  const service = () => new PushReceiptsService(prisma as unknown as PrismaService, config as never, expo as never);

  it('sets no interval while push is off, or without a client', () => {
    const spy = jest.spyOn(global, 'setInterval');
    enabled = false;
    const off = service();
    off.onModuleInit();
    expect(off.scheduled).toBe(false);
    enabled = true;
    const noClient = new PushReceiptsService(prisma as unknown as PrismaService, config as never);
    noClient.onModuleInit();
    expect(noClient.scheduled).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('checks every five minutes on an unref’d interval once push is on, and stops on shutdown', () => {
    jest.useFakeTimers();
    try {
      const on = service();
      const tick = jest.spyOn(on, 'tick').mockResolvedValue();
      on.onModuleInit();
      expect(on.scheduled).toBe(true);
      jest.advanceTimersByTime(RECEIPT_INTERVAL_MS);
      expect(tick).toHaveBeenCalledTimes(1);
      on.onModuleDestroy();
      expect(on.scheduled).toBe(false);
      jest.advanceTimersByTime(RECEIPT_INTERVAL_MS);
      expect(tick).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('claims due tickets, asks Expo, revokes the gone devices and deletes the checked tickets', async () => {
    tx.$queryRaw.mockResolvedValue([{ ticket_id: 'r-1' }, { ticket_id: 'r-2' }, { ticket_id: 'r-3' }]);
    expo.receipts.mockResolvedValue({
      'r-1': { status: 'ok' },
      'r-2': { status: 'error', details: { error: 'DeviceNotRegistered' } },
    });
    const s = service();
    const warn = jest.spyOn((s as unknown as { logger: Logger }).logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn((s as unknown as { logger: Logger }).logger, 'log').mockImplementation(() => undefined);
    await s.tick();
    const claim = tx.$queryRaw.mock.calls[0][0] as { strings: string[]; values: unknown[] };
    expect(claim.strings.join('?')).toContain('app.push_due_receipts(');
    expect(claim.values).toEqual([1000]);
    expect(expo.receipts).toHaveBeenCalledWith(['r-1', 'r-2', 'r-3']);
    const settle = tx.$executeRaw.mock.calls[0][0] as { strings: string[]; values: unknown[] };
    expect(settle.strings.join('?')).toContain('app.push_receipts_settled(');
    expect(settle.values).toEqual([['r-1', 'r-2'], ['r-2']]);
    expect(warn).toHaveBeenCalledWith('Push receipts with errors [DeviceNotRegistered=1]');
  });

  it('asks Expo nothing when no ticket is due, and settles nothing when no receipt is ready', async () => {
    const s = service();
    await s.tick();
    expect(expo.receipts).not.toHaveBeenCalled();
    tx.$queryRaw.mockResolvedValue([{ ticket_id: 'r-1' }]);
    await s.tick();
    expect(expo.receipts).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('runs one pass at a time and swallows a failure by name', async () => {
    let release: () => void = () => undefined;
    tx.$queryRaw.mockImplementation(() => new Promise((resolve) => (release = () => resolve([]))));
    const s = service();
    const first = s.tick();
    const second = s.tick();
    release();
    await Promise.all([first, second]);
    expect(prisma.withDeliveryService).toHaveBeenCalledTimes(1);

    const warn = jest.spyOn((s as unknown as { logger: Logger }).logger, 'warn').mockImplementation(() => undefined);
    prisma.withDeliveryService.mockRejectedValueOnce(new RangeError('statement timeout'));
    await expect(s.tick()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('Receipt check failed [RangeError]');
  });
});
