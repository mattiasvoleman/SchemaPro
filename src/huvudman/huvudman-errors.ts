import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * The refusals of the huvudman's functions (20261212090000), SQLSTATE class
 * HM, which PostgreSQL does not define: @prisma/adapter-pg hands them over as
 * P2039 with the driver's fields under meta.driverAdapterError.cause (as
 * TP409, prisma-errors.ts), the rendered message the fallback. The message's
 * first word is the code the API answers with.
 */
const SENTENCES: Record<string, string> = {
  HUVUDMAN_NOT_YOURS: 'Bara huvudmannens kommunadministratör gör det.',
  HUVUDMAN_DECISION_NOT_YOURS: 'Beslutet fattas av skolans rektor eller en fullständig administratör.',
  HUVUDMAN_SCHOOL_NOT_FOUND: 'Ingen skola har den adressen.',
  HUVUDMAN_SCHOOL_IS_OURS: 'Skolan hör redan till huvudmannen.',
  HUVUDMAN_SCHOOL_HAS_A_HUVUDMAN: 'Skolan har redan en huvudman.',
  HUVUDMAN_SCHOOL_HAS_NONE: 'Skolan har ingen huvudman.',
  HUVUDMAN_SCHOOL_NOT_OURS: 'Skolan hör inte till huvudmannen.',
  HUVUDMAN_REQUEST_NOT_FOUND: 'Det finns ingen sådan förfrågan.',
  HUVUDMAN_MEMBER_LOGIN_MISSING: 'Inbjudan gav ingen inloggning.',
  HUVUDMAN_KEY_STAYS_REVOKED: 'En återkallad nyckel förblir återkallad.',
};

interface DriverCause {
  originalCode?: unknown;
  originalMessage?: unknown;
}

function causeOf(error: Prisma.PrismaClientKnownRequestError): DriverCause | undefined {
  return (error.meta as { driverAdapterError?: { cause?: DriverCause } } | undefined)?.driverAdapterError?.cause;
}

/** The HM refusal an error is, as an HTTP exception; null for anything else. */
export function huvudmanRefusal(error: unknown): Error | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  const cause = causeOf(error);
  const original = typeof cause?.originalCode === 'string' ? cause.originalCode : null;
  const rendered = error.code === 'P2039' ? (/Code: `(HM\d{3})`/.exec(error.message)?.[1] ?? null) : null;
  const state = original?.startsWith('HM') ? original : rendered;
  if (!state) return null;
  const text = typeof cause?.originalMessage === 'string' ? cause.originalMessage : error.message;
  const code = /\b(HUVUDMAN_[A-Z_]+)\b/.exec(text)?.[1] ?? 'HUVUDMAN_REFUSED';
  const body = { message: SENTENCES[code] ?? 'Huvudmannen tillåter inte det.', code };
  switch (state) {
    case 'HM400':
      return new BadRequestException(body);
    case 'HM403':
      return new ForbiddenException(body);
    case 'HM404':
      return new NotFoundException(body);
    default:
      return new ConflictException(body);
  }
}

/** The SQLSTATE of a database error, when the adapter carried it. */
export function sqlStateOf(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  const original = causeOf(error)?.originalCode;
  if (typeof original === 'string') return original;
  if (error.code === 'P2002') return '23505';
  return null;
}
