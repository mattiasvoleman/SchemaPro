import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isWriteConflict, writeConflict } from '../common/utils/prisma-errors';
import { isLockTimeout, publishInProgress } from '../publication/publish-mode';

/**
 * Database refusals on the cover tables, as coded 4xx answers — BEFORE they
 * reach the global filter.
 *
 * WHY HERE AND NOT THERE. The filter logs a 5xx with its stack, and a
 * Postgres CHECK or EXCLUDE error carries "Failing row contains (...)" — the
 * whole row, reasonId included. An absence's reason must not reach a log
 * line, so every refusal these tables can raise is mapped to a 4xx whose
 * body names a code and a constraint at most, never a value, and the
 * services log ids of lessons and absences only.
 */

interface DriverCause {
  originalCode?: unknown;
  originalMessage?: unknown;
}

/** The SQLSTATE under a Prisma error, from the adapter's cause or the rendered message. */
export function sqlStateOf(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  const cause = (error.meta as { driverAdapterError?: { cause?: DriverCause } } | undefined)?.driverAdapterError?.cause;
  if (typeof cause?.originalCode === 'string') return cause.originalCode;
  return /Code: `([0-9A-Z]{5})`/.exec(error.message)?.[1] ?? null;
}

/** The constraint a CHECK or EXCLUDE refusal names; a name, never a row. */
function constraintOf(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  const cause = (error.meta as { driverAdapterError?: { cause?: DriverCause } } | undefined)?.driverAdapterError?.cause;
  const text = typeof cause?.originalMessage === 'string' ? cause.originalMessage : error.message;
  return /constraint "([A-Za-z_]+)"/.exec(text)?.[1] ?? null;
}

export const ABSENCE_OVERLAPS = 'ABSENCE_OVERLAPS';
export const ABSENCE_SELF_EDIT_NARROW = 'ABSENCE_SELF_EDIT_NARROW';
export const ABSENCE_SELF_REPORT_OFF = 'ABSENCE_SELF_REPORT_OFF';
export const ABSENCE_PERSON_IS_FIXED = 'ABSENCE_PERSON_IS_FIXED';
export const POOL_MEMBER_MUST_BE_TEACHER = 'POOL_MEMBER_MUST_BE_TEACHER';
export const COVER_INVALID = 'COVER_INVALID';
export const COVER_DUPLICATE = 'COVER_DUPLICATE';

/** Throws the coded answer for a database refusal, or the error as it was. */
export function rethrowCoverError(error: unknown): never {
  if (error instanceof HttpException) throw error;
  if (isLockTimeout(error)) throw publishInProgress();
  if (isWriteConflict(error)) throw writeConflict();
  const state = sqlStateOf(error);
  switch (state) {
    case '23P01':
      throw new ConflictException({
        message: 'Läraren är redan registrerad som frånvarande under en del av perioden.',
        code: ABSENCE_OVERLAPS,
      });
    case 'TA403':
      throw new ForbiddenException({
        message: 'En lärare kan bara avsluta sin frånvaro i förtid eller återkalla den.',
        code: ABSENCE_SELF_EDIT_NARROW,
      });
    case 'TA409':
      throw new ConflictException({ message: 'En frånvaro byter inte person.', code: ABSENCE_PERSON_IS_FIXED });
    case 'SP409':
      throw new ConflictException({ message: 'Bara en lärare kan stå i vikariepoolen.', code: POOL_MEMBER_MUST_BE_TEACHER });
    case '42501':
      throw new ForbiddenException({
        message: 'Skolan låter inte lärare registrera sin egen frånvaro.',
        code: ABSENCE_SELF_REPORT_OFF,
      });
    case '23514':
      throw new BadRequestException({
        message: `Värdet bryter mot regeln ${constraintOf(error) ?? 'för tabellen'}.`,
        code: COVER_INVALID,
      });
    case '23505':
      throw new ConflictException({ message: 'Det finns redan en sådan rad.', code: COVER_DUPLICATE });
    default:
      break;
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2025') throw new NotFoundException('The requested record does not exist.');
    if (error.code === 'P2002') throw new ConflictException({ message: 'Det finns redan en sådan rad.', code: COVER_DUPLICATE });
    if (error.code === 'P2003') {
      throw new BadRequestException({ message: 'Raden hänvisar till något som inte finns i skolan.', code: COVER_INVALID });
    }
  }
  throw error;
}

/** Runs a body and answers its database refusals with codes (rethrowCoverError). */
export async function mapCoverErrors<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    rethrowCoverError(error);
  }
}
