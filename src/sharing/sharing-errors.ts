import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * The refusals of the room-loan functions (Delade lokaler och lärare,
 * 20261217090000), SQLSTATE class RL, which PostgreSQL does not define:
 * @prisma/adapter-pg hands them over as P2039 with the driver's fields under
 * meta.driverAdapterError.cause (as the HM refusals, huvudman-errors.ts),
 * the rendered message the fallback. The message's first word is the code
 * the API answers with.
 *
 * And the refusals of the loans' EXCLUDE constraints (23P01), which the
 * driver's message names: an approval over another approved loan of the
 * room (RoomLoans_a_room_is_lent_once), and two requests that raced past
 * the function's check of the local room (the other two).
 */
const SENTENCES: Record<string, string> = {
  ROOM_LOAN_NOT_YOURS: 'Lån av salar mellan skolor begärs och beslutas av den som skriver planering.',
  ROOM_LOAN_ROOM_NOT_FOUND: 'Salen finns inte bland huvudmannens andra skolors salar.',
  ROOM_LOAN_LOCAL_ROOM_NOT_FOUND: 'Skolans egen sal för lånet finns inte.',
  ROOM_LOAN_LOCAL_ROOM_IS_LENT: 'Den salen lånar skolan ut, så den kan inte stå för en lånad sal.',
  ROOM_LOAN_LOCAL_ROOM_IS_ANOTHER: 'Skolan har redan en egen sal för den lånade salen, eller salen står för en annan lånad sal.',
  ROOM_LOAN_NOT_FOUND: 'Lånet finns inte.',
  ROOM_LOAN_DECISION_MISSING: 'Säg om lånet godkänns eller avböjs.',
  ROOM_LOAN_ALREADY_DECIDED: 'Lånet är redan besvarat.',
  ROOM_LOAN_ALREADY_ENDED: 'Lånet är redan avslutat eller avböjt.',
  ROOM_LOAN_NOT_APPROVED: 'Bara ett godkänt lån kan avslutas av ägarskolan.',
};

export const ROOM_LOAN_OVERLAP = 'ROOM_LOAN_OVERLAP';

interface DriverCause {
  originalCode?: unknown;
  originalMessage?: unknown;
}

function causeOf(error: Prisma.PrismaClientKnownRequestError): DriverCause | undefined {
  return (error.meta as { driverAdapterError?: { cause?: DriverCause } } | undefined)?.driverAdapterError?.cause;
}

/** The RL refusal (or the overlap) an error is, as an HTTP exception; null for anything else. */
export function roomLoanRefusal(error: unknown): Error | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  const cause = causeOf(error);
  const original = typeof cause?.originalCode === 'string' ? cause.originalCode : null;
  const text = typeof cause?.originalMessage === 'string' ? cause.originalMessage : error.message;
  // Two requests racing past the function's own check meet the EXCLUDE
  // constraints that keep one local room per room: the same refusal the
  // function would have given.
  if (/RoomLoans_(one_local_room_per_room|a_local_room_stands_for_one_room)/.test(text)) {
    return new ConflictException({ message: SENTENCES['ROOM_LOAN_LOCAL_ROOM_IS_ANOTHER'], code: 'ROOM_LOAN_LOCAL_ROOM_IS_ANOTHER' });
  }
  if (original === '23P01' || /RoomLoans_a_room_is_lent_once/.test(text)) {
    return new ConflictException({
      message: 'Salen är redan utlånad en del av den tiden. Avböj lånet, eller avsluta det andra först.',
      code: ROOM_LOAN_OVERLAP,
    });
  }
  const rendered = error.code === 'P2039' ? (/Code: `(RL\d{3})`/.exec(error.message)?.[1] ?? null) : null;
  const state = original?.startsWith('RL') ? original : rendered;
  if (!state) return null;
  const code = /\b(ROOM_LOAN_[A-Z_]+)\b/.exec(text)?.[1] ?? 'ROOM_LOAN_REFUSED';
  const body = { message: SENTENCES[code] ?? 'Lånet går inte att ändra så.', code };
  switch (state) {
    case 'RL400':
      return new BadRequestException(body);
    case 'RL403':
      return new ForbiddenException(body);
    case 'RL404':
      return new NotFoundException(body);
    default:
      return new ConflictException(body);
  }
}
