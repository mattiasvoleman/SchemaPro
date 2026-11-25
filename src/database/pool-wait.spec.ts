import { Prisma } from '@prisma/client';
import { DATABASE_BUSY_RETRY_AFTER_SECONDS, isPoolBusy, NEVER_STARTED, retryOnceIfPoolBusy } from './pool-wait';

const prismaError = (code: string, message: string): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: Prisma.prismaVersion.client });

describe('isPoolBusy', () => {
  it('is true for Prisma\'s refusal of a transaction that found no connection in its maxWait', () => {
    expect(isPoolBusy(prismaError('P2028', `Transaction API error: ${NEVER_STARTED}.`))).toBe(true);
  });

  it('is true for pg\'s own wait for a connection, a plain Error', () => {
    expect(isPoolBusy(new Error('timeout exceeded when trying to connect'))).toBe(true);
  });

  it('is false for a transaction that started and then expired, for every other code, and for anything else', () => {
    expect(isPoolBusy(prismaError('P2028', 'Transaction API error: Transaction already closed.'))).toBe(false);
    expect(isPoolBusy(prismaError('P2002', NEVER_STARTED))).toBe(false);
    expect(isPoolBusy(new Error('connection terminated unexpectedly'))).toBe(false);
    expect(isPoolBusy(new Error(`wrapped: timeout exceeded when trying to connect`))).toBe(false);
    expect(isPoolBusy(null)).toBe(false);
    expect(isPoolBusy('timeout exceeded when trying to connect')).toBe(false);
  });
});

describe('retryOnceIfPoolBusy', () => {
  const busy = () => prismaError('P2028', `Transaction API error: ${NEVER_STARTED}.`);

  it('runs a call that goes through once, and says nothing', async () => {
    const attempt = jest.fn().mockResolvedValue('written');
    const onRetry = jest.fn();

    await expect(retryOnceIfPoolBusy(attempt, onRetry)).resolves.toBe('written');

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('runs a call the pool had no connection for a second time, tells the caller, and returns what the second gives', async () => {
    const refusal = busy();
    const attempt = jest.fn().mockRejectedValueOnce(refusal).mockResolvedValueOnce('written');
    const onRetry = jest.fn();

    await expect(retryOnceIfPoolBusy(attempt, onRetry)).resolves.toBe('written');

    expect(attempt).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(refusal);
  });

  it('retries pg\'s own wait too, and needs no listener', async () => {
    const attempt = jest.fn().mockRejectedValueOnce(new Error('timeout exceeded when trying to connect')).mockResolvedValueOnce(1);

    await expect(retryOnceIfPoolBusy(attempt)).resolves.toBe(1);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('is two tries and no more: a second refusal is the caller\'s', async () => {
    const second = busy();
    const attempt = jest.fn().mockRejectedValueOnce(busy()).mockRejectedValueOnce(second).mockResolvedValue('never');

    await expect(retryOnceIfPoolBusy(attempt)).rejects.toBe(second);

    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('does not run a call again for a failure that is not the pool\'s, whose transaction may have started', async () => {
    const failure = prismaError('P2034', 'Transaction failed due to a write conflict or a deadlock.');
    const attempt = jest.fn().mockRejectedValue(failure);
    const onRetry = jest.fn();

    await expect(retryOnceIfPoolBusy(attempt, onRetry)).rejects.toBe(failure);

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });
});

describe('DATABASE_BUSY_RETRY_AFTER_SECONDS', () => {
  it('is a whole, positive number of seconds: a Retry-After carries no fraction', () => {
    expect(Number.isInteger(DATABASE_BUSY_RETRY_AFTER_SECONDS)).toBe(true);
    expect(DATABASE_BUSY_RETRY_AFTER_SECONDS).toBeGreaterThan(0);
  });
});
