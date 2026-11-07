import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { absenceStatsRefusal, noPupilsForTheReader, noSuchPupil, refusing } from './absence-stats-errors';

/** What the driver adapter hands over for a raw call the database refused with a SQLSTATE of its own. */
const refusal = (originalCode: string, originalMessage: string) =>
  new Prisma.PrismaClientKnownRequestError('Raw query failed.', {
    code: 'P2010',
    clientVersion: Prisma.prismaVersion.client,
    meta: { driverAdapterError: { cause: { originalCode, originalMessage } } },
  });

const body = (error: Error | null) => (error as ForbiddenException).getResponse() as { code: string; message: string };

describe('absenceStatsRefusal', () => {
  it('turns AS403 into a 403 that names what the database named', () => {
    const error = absenceStatsRefusal(refusal('AS403', 'ABSENCE_STATS_NO_PUPILS_FOR_THE_READER: huvudmannens läsare ser summor'));
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(body(error).code).toBe('ABSENCE_STATS_NO_PUPILS_FOR_THE_READER');
    expect(body(error).message).toMatch(/Huvudmannens läsare/);
  });

  it('answers a refusal that names nothing we know as the plain 403', () => {
    const error = absenceStatsRefusal(refusal('AS403', 'something else'));
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(body(error).code).toBe('ABSENCE_STATS_NOT_YOURS');
  });

  it('turns AS404 into a 404 and AS400 into a 400, each with the database’s code', () => {
    const missing = absenceStatsRefusal(refusal('AS404', 'ABSENCE_STATS_NO_SUCH_CLASS'));
    expect(missing).toBeInstanceOf(NotFoundException);
    expect(body(missing).code).toBe('ABSENCE_STATS_NO_SUCH_CLASS');
    const bad = absenceStatsRefusal(refusal('AS400', 'ABSENCE_STATS_BAD_PERIOD: från före till'));
    expect(bad).toBeInstanceOf(BadRequestException);
    expect(body(bad).code).toBe('ABSENCE_STATS_BAD_PERIOD');
    expect(body(bad).message).toMatch(/1 200 dagar/);
  });

  it('says something even for a code with no sentence of its own', () => {
    expect(body(absenceStatsRefusal(refusal('AS400', 'ABSENCE_STATS_BAD_MONTH: en månad är dess första dag'))).message).toBe('Statistiken går inte att läsa så.');
  });

  it('reads the code from the message the adapter renders for the model API (P2039)', () => {
    const error = new Prisma.PrismaClientKnownRequestError('Transaction failed. Code: `AS404`. Message: ABSENCE_STATS_NO_SUCH_PUPIL', {
      code: 'P2039',
      clientVersion: Prisma.prismaVersion.client,
    });
    expect(absenceStatsRefusal(error)).toBeInstanceOf(NotFoundException);
  });

  it('leaves every other error alone: another SQLSTATE, another code, a plain error', () => {
    expect(absenceStatsRefusal(refusal('RL403', 'ROOM_LOAN_NOT_YOURS'))).toBeNull();
    expect(absenceStatsRefusal(refusal('23505', 'duplicate key'))).toBeNull();
    expect(absenceStatsRefusal(new Prisma.PrismaClientKnownRequestError('x', { code: 'P2002', clientVersion: Prisma.prismaVersion.client }))).toBeNull();
    expect(absenceStatsRefusal(new Error('boom'))).toBeNull();
    expect(absenceStatsRefusal('AS403')).toBeNull();
  });
});

describe('refusing', () => {
  it('returns what the read returns', async () => {
    await expect(refusing(async () => 7)).resolves.toBe(7);
  });

  it('rethrows a refusal as the API’s answer, and anything else as it was', async () => {
    await expect(refusing(async () => Promise.reject(refusal('AS403', 'ABSENCE_STATS_NOT_YOURS')))).rejects.toBeInstanceOf(ForbiddenException);
    const boom = new Error('boom');
    await expect(refusing(async () => Promise.reject(boom))).rejects.toBe(boom);
  });
});

describe('the answers the gateway gives itself', () => {
  it('asks the huvudman’s reader no further than the door', () => {
    expect(noPupilsForTheReader()).toBeInstanceOf(ForbiddenException);
    expect(body(noPupilsForTheReader()).code).toBe('ABSENCE_STATS_NO_PUPILS_FOR_THE_READER');
  });

  it('answers a pupil the database could not name as a pupil who is not there', () => {
    expect(noSuchPupil()).toBeInstanceOf(NotFoundException);
    expect(body(noSuchPupil()).code).toBe('ABSENCE_STATS_NO_SUCH_PUPIL');
  });
});
