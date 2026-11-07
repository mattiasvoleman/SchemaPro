import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ABSENCE_STATS_BAD_PERIOD,
  ABSENCE_STATS_NO_PUPILS_FOR_THE_READER,
  ABSENCE_STATS_NO_SUCH_CLASS,
  ABSENCE_STATS_NO_SUCH_PUPIL,
  ABSENCE_STATS_NOT_YOURS,
} from './absence-stats';

/**
 * The refusals of the statistics' functions (20270121090000), SQLSTATE class AS,
 * which PostgreSQL does not define: @prisma/adapter-pg hands them over with the
 * driver's fields under meta.driverAdapterError.cause (P2010 for the raw calls
 * these are; P2039 through the model API, whose rendered message is the
 * fallback). The message's first word is the code the API answers with.
 */
const SENTENCES: Record<string, string> = {
  [ABSENCE_STATS_NOT_YOURS]: 'Frånvarostatistiken är administratörens, och mentorns för sina egna elever och klasser.',
  [ABSENCE_STATS_NO_PUPILS_FOR_THE_READER]: 'Huvudmannens läsare ser skolans och klassernas summor, aldrig en enskild elev.',
  [ABSENCE_STATS_NO_SUCH_PUPIL]: 'Eleven finns inte på skolan.',
  [ABSENCE_STATS_NO_SUCH_CLASS]: 'Klassen finns inte på skolan.',
  [ABSENCE_STATS_BAD_PERIOD]: 'Perioden är fel: från före till, högst 1 200 dagar.',
};

interface DriverCause {
  originalCode?: unknown;
  originalMessage?: unknown;
}

function causeOf(error: Prisma.PrismaClientKnownRequestError): DriverCause | undefined {
  return (error.meta as { driverAdapterError?: { cause?: DriverCause } } | undefined)?.driverAdapterError?.cause;
}

/** The AS refusal an error is, as an HTTP exception; null for anything else. */
export function absenceStatsRefusal(error: unknown): Error | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  const cause = causeOf(error);
  const original = typeof cause?.originalCode === 'string' ? cause.originalCode : null;
  const text = typeof cause?.originalMessage === 'string' ? cause.originalMessage : error.message;
  const rendered = error.code === 'P2039' ? (/Code: `(AS\d{3})`/.exec(error.message)?.[1] ?? null) : null;
  const state = original?.startsWith('AS') ? original : rendered;
  if (!state) return null;
  const code = /\b(ABSENCE_STATS_[A-Z_]+)\b/.exec(text)?.[1] ?? ABSENCE_STATS_NOT_YOURS;
  const body = { message: SENTENCES[code] ?? 'Statistiken går inte att läsa så.', code };
  switch (state) {
    case 'AS400':
      return new BadRequestException(body);
    case 'AS404':
      return new NotFoundException(body);
    default:
      return new ForbiddenException(body);
  }
}

/** Runs a read and turns the database's AS refusals into the API's answers. */
export async function refusing<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw absenceStatsRefusal(error) ?? error;
  }
}

/** The huvudman's reader, asked for a pupil before the database is: the same refusal the database gives. */
export function noPupilsForTheReader(): ForbiddenException {
  return new ForbiddenException({ message: SENTENCES[ABSENCE_STATS_NO_PUPILS_FOR_THE_READER], code: ABSENCE_STATS_NO_PUPILS_FOR_THE_READER });
}

/** A pupil the database could not name after it let the caller in: the same answer as a pupil who is not there. */
export function noSuchPupil(): NotFoundException {
  return new NotFoundException({ message: SENTENCES[ABSENCE_STATS_NO_SUCH_PUPIL], code: ABSENCE_STATS_NO_SUCH_PUPIL });
}
