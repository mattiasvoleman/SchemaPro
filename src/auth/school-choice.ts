import { BadRequestException, ForbiddenException } from '@nestjs/common';

/**
 * Flera skolor per inloggning (20261204090000): a login has one Users row per
 * school, and each request says which school it is about. The clients send
 * the school's id in this header; PostgREST hands the same header to the
 * database as request.headers, and the gateway, having resolved the row,
 * sets the transaction's app.chosen_school_id to the row's school
 * (PrismaService.withRls), so that the database and the gateway always agree
 * on which row a request is. No header: the login's active row that took the
 * login first (Users.loginSince), which for a login with one row is the row
 * it always was.
 *
 * The choice only ever picks among the login's own rows, so it is no
 * permission: a client naming a school it has no row in gets no row.
 */
export const SCHOOL_HEADER = 'x-school-id';

/** Answered for a school the login has no active row in, or may not enter now. */
export const SCHOOL_NOT_AVAILABLE = 'SCHOOL_NOT_AVAILABLE';

/** A header that names no school in a form the database could match. */
export const SCHOOL_ID_INVALID = 'SCHOOL_ID_INVALID';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The school a request names, lower case, or undefined when it names none.
 * A value that is no uuid is refused rather than ignored: ignoring it would
 * answer with the login's first school, and a write the client meant for
 * another school would land there.
 */
export function schoolChoiceOf(
  headers: Record<string, string | string[] | undefined> | undefined,
): string | undefined {
  const raw = headers?.[SCHOOL_HEADER];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase();
  if (!value) return undefined;
  if (!UUID.test(value)) {
    throw new BadRequestException({
      message: 'X-School-Id är inget skol-id.',
      code: SCHOOL_ID_INVALID,
    });
  }
  return value;
}

/**
 * The schools this session may not enter, from the access-token hook's
 * rastra_closed_schools claim ({schoolId: reason}), when the token carries
 * one. Forwarded to the database key for key, which reads the keys in the
 * resolver: a school is closed by being named, whatever the reason says, so
 * no key is dropped. The token is verified; anything but an object is no
 * such claim, as the database reads it.
 */
export function closedSchoolsOf(claim: unknown): Readonly<Record<string, string>> | undefined {
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) return undefined;
  const entries = Object.entries(claim as Record<string, unknown>).map(
    ([school, reason]): [string, string] => [school, typeof reason === 'string' ? reason : 'closed'],
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** The 403 for a school named that the login has no active row in, or may not enter. */
export function schoolNotAvailable(): ForbiddenException {
  return new ForbiddenException({
    message: 'Du har ingen aktiv roll på den skolan just nu. Välj en annan skola.',
    code: SCHOOL_NOT_AVAILABLE,
  });
}
