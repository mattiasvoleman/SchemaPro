import { Prisma } from '@prisma/client';
import { isPoolBusy, NEVER_STARTED } from './pool-wait';

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
